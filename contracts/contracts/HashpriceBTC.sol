// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { BTCUtils } from "./libraries/BTCUtils.sol";

/// @title HashpriceBTC
/// @notice Gas-optimized trustless hashprice oracle (relay + verifier + oracle in one).
///         Single `submitBlock()` entry point per block. Supports on-chain reorg handling via `submitBlocks()`.
/// @dev Implements AggregatorV3Interface. Returns the price of 100 TH/s per day in BTC.
///      Average fees use a simple moving average over 144 blocks so the on-chain
///      hashprice is comparable to the Luxor hashprice index. Future optimization: EMA instead of
///      SMA to shrink the fee ring buffer.
///
///      Timestamps: Bitcoin's Median Time Past (nTime > median of prior 11) is omitted — too many
///      storage reads per block for this ring-buffer design. We only enforce the 2h future cap
///      (`MAX_FUTURE_BLOCK_TIME` vs `block.timestamp`) plus retarget checks; MTP's lower bound on
///      `nTime` is not replicated on-chain.
contract HashpriceBTC is AggregatorV3Interface {
    // ─── Constants ────────────────────────────────────────────────────

    /// @dev How many recent block headers we keep
    /// in storage to handle reorgs. Must cover `CONFIRMATION_DEPTH`
    ///      lookups and any `submitBlocks` ancestor still on-chain.
    uint32 private constant BLOCK_BUFFER_SIZE = 32;
    /// @dev Number of blocks in the fee SMA (~one day at 10 min/block); matches Luxor index window.
    uint32 private constant FEE_WINDOW = 144;
    /// @dev Blocks behind tip used as “confirmed” for `latestRoundData` (Bitcoin-like ~6 confs).
    uint32 public constant CONFIRMATION_DEPTH = 6;
    /// @dev Target seconds per difficulty epoch: 2016 blocks × 10 min (Bitcoin retarget timespan).
    uint256 private constant EXPECTED_TIMESPAN = 2016 * 600;
    /// @dev Blocks per difficulty epoch; retarget validation runs when `height` is a multiple of this.
    uint256 private constant RETARGET_INTERVAL = 2016;
    /// @dev Max seconds header `nTime` may be ahead of `block.timestamp` (Bitcoin's 2h rule; nodes
    ///      use network-adjusted time, we use the EVM block time).
    uint32 private constant MAX_FUTURE_BLOCK_TIME = 7200;
    /// @dev Hashes in 100 TH/s over one day (100 × 1e12 × 86_400); numerator in hashprice satoshi formula.
    uint256 private constant HASHES_PER_100THS_PER_DAY = 8_640_000_000_000_000_000;
    uint256 private constant HEADER_SIZE = 80;

    // ─── Storage: block ring buffer (32 entries × 2 slots = 64 slots) ─

    struct BlockEntry {
        bytes32 blockHash;
        uint32 timestamp;
        uint32 nBits;
        uint32 height;
    }

    struct PackedState {
        uint32 chainHeight;
        uint32 blockCount;
        uint32 epochStartTimestamp;
        uint32 epochStartNBits;
        uint32 lastSubmittedAt;
    }

    /// @dev Mutable chain state passed through submitBlocks loop to avoid stack-too-deep
    struct ChainCursor {
        bytes32 prevHash;
        uint32 height;
        uint32 prevNBits;
    }

    /// @dev Ring buffer of recent blocks to handle reorgs.
    BlockEntry[BLOCK_BUFFER_SIZE] internal _blocks;
    /// @dev Ring buffer of recent fees to calculate SMA.
    uint64[FEE_WINDOW] internal _fees;
    /// @dev dSHA256 of the current header; next `submitBlock` must extend this.
    bytes32 public chainTipHash;
    /// @dev Packed chain/oracle state
    PackedState public state;
    /// @dev Running sum of fees over the last `FEE_WINDOW` blocks.
    uint256 public feeRunningSum;

    // ─── Errors ───────────────────────────────────────────────────────

    error InvalidHeaderLength();
    error BrokenChain();
    error InsufficientPoW();
    error InvalidTimestamp();
    error UnexpectedDifficultyChange();
    error InvalidRetarget();
    error InvalidMerkleProof();
    error NotHeaviestChain();
    /// @dev `_blockAt(ancestorHeight)` does not contain that height (ring slot stale or never written).
    error AncestorNotInBuffer();
    error InsufficientData();
    error ArrayLengthMismatch();
    error NotImplemented();

    // ─── Events ───────────────────────────────────────────────────────

    event BlockSubmitted(bytes32 indexed blockHash, uint32 indexed height, uint64 fees);
    event ChainReorg(bytes32 indexed newTip, uint32 indexed newHeight);

    // ─── Constructor ──────────────────────────────────────────────────

    /// @notice Deploy with a trusted checkpoint block (precomputed off-chain)
    /// @param blockHash Raw dsha256 block hash
    /// @param height Block height
    /// @param timestamp Block timestamp
    /// @param nBits Encoded difficulty target
    /// @param _epochStartTimestamp Timestamp of the first block in the current difficulty epoch
    /// @param _epochStartNBits nBits of the first block in the current difficulty epoch
    constructor(
        bytes32 blockHash,
        uint32 height,
        uint32 timestamp,
        uint32 nBits,
        uint32 _epochStartTimestamp,
        uint32 _epochStartNBits
    ) {
        _setBlockAt(height, blockHash, timestamp, nBits);

        chainTipHash = blockHash;
        state = PackedState({
            chainHeight: height,
            blockCount: 0,
            epochStartTimestamp: _epochStartTimestamp,
            epochStartNBits: _epochStartNBits,
            lastSubmittedAt: 0
        });
    }

    function _validateWork(bytes32 blockHash, uint256 target) internal pure {
        if (uint256(BTCUtils.reverseBytes32(blockHash)) > target) {
            revert InsufficientPoW();
        }
    }

    function _validateChainLinkage(bytes32 prevBlockHash, bytes32 _chainTipHash) internal pure {
        if (prevBlockHash != _chainTipHash) revert BrokenChain();
    }

    // ─── Block submission ─────────────────────────────────────────────

    /// @notice Submit a single block (header + coinbase proof). Steady-state path.
    /// @param header Raw 80-byte Bitcoin block header
    /// @param coinbaseTx Non-witness serialized coinbase transaction
    /// @param merkleProof Merkle sibling hashes from coinbase leaf to root
    function submitBlock(bytes calldata header, bytes calldata coinbaseTx, bytes32[] calldata merkleProof) external {
        _validateHeaderLength(header);
        BTCUtils.HeaderInfo memory info = BTCUtils.parseHeader(header);
        bytes32 blockHash = BTCUtils.dsha256(header);

        PackedState memory s = state;
        uint32 newHeight = s.chainHeight + 1;
        uint256 newTarget = BTCUtils.nBitsToTarget(info.nBits);

        _validateChainLinkage(info.prevBlockHash, chainTipHash);
        _validateWork(blockHash, newTarget);
        _validateTimestamp(newHeight, info.timestamp);
        _validateDifficulty(newHeight, info.nBits, _blockAt(s.chainHeight).nBits, s);

        uint64 fees = _verifyCoinbaseAndExtractFees(newHeight, info.merkleRoot, coinbaseTx, merkleProof);
        _updateFees(fees, newHeight, s.blockCount);

        _setBlockAt(newHeight, blockHash, info.timestamp, info.nBits);

        chainTipHash = blockHash;
        s.chainHeight = newHeight;
        s.blockCount++;
        s.lastSubmittedAt = uint32(block.timestamp);
        state = s;

        emit BlockSubmitted(blockHash, newHeight, fees);
    }

    /// @notice Submit multiple blocks from an ancestor. Used for bootstrap and reorgs.
    /// @param ancestorHeight Height of the common ancestor (must be in the block buffer)
    /// @param headers Concatenated 80-byte raw headers
    /// @param coinbaseTxs Array of non-witness serialized coinbase transactions
    /// @param merkleProofs Array of merkle proofs (one per block)
    function submitBlocks(
        uint32 ancestorHeight,
        bytes calldata headers,
        bytes[] calldata coinbaseTxs,
        bytes32[][] calldata merkleProofs
    ) external {
        _validateConcatenatedHeadersLength(headers);
        uint256 count = headers.length / HEADER_SIZE;
        if (coinbaseTxs.length != count || merkleProofs.length != count) revert ArrayLengthMismatch();

        BlockEntry storage ancestor = _blockAt(ancestorHeight);
        if (ancestor.height != ancestorHeight) revert AncestorNotInBuffer();

        PackedState memory s = state;
        ChainCursor memory cur =
            ChainCursor({ prevHash: ancestor.blockHash, height: ancestorHeight, prevNBits: ancestor.nBits });

        for (uint256 i = 0; i < count; i++) {
            _processHeader(_sliceHeaders(headers, i), coinbaseTxs[i], merkleProofs[i], cur, s);
        }

        if (cur.height < s.chainHeight) {
            revert NotHeaviestChain();
        }

        if (cur.height > s.chainHeight) {
            s.chainHeight = cur.height;
            s.blockCount += uint32(count);
        } else if (_isHeavierChain(headers, ancestorHeight, count)) {
            emit ChainReorg(cur.prevHash, cur.height);
        } else {
            revert NotHeaviestChain();
        }

        chainTipHash = cur.prevHash;
        s.lastSubmittedAt = uint32(block.timestamp);
        state = s;
    }

    function _sliceHeaders(bytes calldata headers, uint256 index) internal pure returns (bytes calldata) {
        return headers[index * HEADER_SIZE:(index + 1) * HEADER_SIZE];
    }

    function _validateHeaderLength(bytes calldata header) internal pure {
        if (header.length != HEADER_SIZE) revert InvalidHeaderLength();
    }

    function _validateConcatenatedHeadersLength(bytes calldata headers) internal pure {
        if (headers.length % HEADER_SIZE != 0 || headers.length == 0) {
            revert InvalidHeaderLength();
        }
    }

    /// @dev Process a single header inside submitBlocks. Mutates `cur` in place.
    function _processHeader(
        bytes calldata header,
        bytes calldata coinbaseTx,
        bytes32[] calldata merkleProof,
        ChainCursor memory cur,
        PackedState memory s
    ) internal {
        BTCUtils.HeaderInfo memory info = BTCUtils.parseHeader(header);
        _validateChainLinkage(info.prevBlockHash, cur.prevHash);

        uint256 target = BTCUtils.nBitsToTarget(info.nBits);
        bytes32 blockHash = BTCUtils.dsha256(header);

        cur.height++;

        _validateWork(blockHash, target);
        _validateTimestamp(cur.height, info.timestamp);
        _validateDifficulty(cur.height, info.nBits, cur.prevNBits, s);

        uint64 fees = _verifyCoinbaseAndExtractFees(cur.height, info.merkleRoot, coinbaseTx, merkleProof);

        // TODO: maybe pass block count in context struct to avoid reading state
        _updateFees(fees, cur.height, s.blockCount);
        _setBlockAt(cur.height, blockHash, info.timestamp, info.nBits);

        cur.prevHash = blockHash;
        cur.prevNBits = info.nBits;

        emit BlockSubmitted(blockHash, cur.height, fees);
    }

    // ─── AggregatorV3Interface ────────────────────────────────────────

    function decimals() public pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "The price of 100 TH/s per day in BTC";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NotImplemented();
    }

    /// @notice Returns the latest hashprice of 100 TH/s per day in satoshis
    /// @dev Reward uses subsidy plus SMA of fees over `FEE_WINDOW` blocks (Luxor hashprice index).
    /// @return roundId Confirmed Bitcoin block height
    /// @return answer Hashprice in satoshis (8 decimals = BTC)
    /// @return startedAt Bitcoin block timestamp at confirmed height
    /// @return updatedAt Bitcoin block timestamp at confirmed height
    /// @return answeredInRound Same as roundId
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        PackedState memory s = state;
        if (s.chainHeight < CONFIRMATION_DEPTH) revert InsufficientData();
        uint32 confirmed = s.chainHeight - CONFIRMATION_DEPTH;

        BlockEntry storage entry = _blockAt(confirmed);
        if (entry.height != confirmed) revert InsufficientData();

        uint256 difficulty = BTCUtils.nBitsToDifficulty(entry.nBits);
        uint64 subsidy = BTCUtils.getBlockSubsidy(confirmed);

        uint256 avgFees;
        if (s.blockCount >= FEE_WINDOW) {
            avgFees = feeRunningSum / FEE_WINDOW;
        } else {
            avgFees = feeRunningSum / s.blockCount;
        }

        uint256 rewardPerBlock = uint256(subsidy) + avgFees;
        uint256 hashpriceSats = (HASHES_PER_100THS_PER_DAY * rewardPerBlock) / (difficulty * (1 << 32));

        uint80 _roundId = uint80(confirmed);
        return (_roundId, int256(hashpriceSats), uint256(entry.timestamp), uint256(s.lastSubmittedAt), _roundId);
    }

    /// @notice Returns the height of the latest confirmed block
    function confirmedHeight() public view returns (uint32) {
        PackedState memory s = state;
        if (s.chainHeight < CONFIRMATION_DEPTH) return 0;
        return s.chainHeight - CONFIRMATION_DEPTH;
    }

    // ─── Internal helpers ─────────────────────────────────────────────

    /// @dev Read a block entry by height. The ring buffer holds BLOCK_BUFFER_SIZE (32) entries;
    ///      the slot for a given height is `height % 32`, derived cheaply via bitwise AND since
    ///      the buffer size is a power of two. Callers must check `entry.height == height` before
    ///      trusting the result — a slot may contain a stale entry from 32 blocks ago.
    function _blockAt(uint32 height) internal view returns (BlockEntry storage) {
        return _blocks[height & 31];
    }

    /// @dev Write a block entry at the slot for `height`, evicting whatever was there before.
    ///      Because the buffer wraps every 32 blocks, entries older than BLOCK_BUFFER_SIZE blocks
    ///      are silently overwritten — this is intentional and bounds storage to a fixed 32 slots.
    function _setBlockAt(uint32 height, bytes32 blockHash, uint32 timestamp, uint32 nBits) internal {
        _blocks[height & 31] = BlockEntry({ blockHash: blockHash, timestamp: timestamp, nBits: nBits, height: height });
    }

    function _updateFees(uint64 fees, uint32 height, uint32 blockCount) internal {
        uint256 idx = height % FEE_WINDOW;
        uint64 oldFee = _fees[idx];
        _fees[idx] = fees;

        feeRunningSum += uint256(fees);
        if (blockCount >= FEE_WINDOW) {
            feeRunningSum -= uint256(oldFee);
        }
    }

    function _verifyCoinbaseAndExtractFees(
        uint32 height,
        bytes32 expectedRoot,
        bytes calldata coinbaseTx,
        bytes32[] calldata merkleProof
    ) internal pure returns (uint64) {
        bytes32 current = BTCUtils.dsha256(coinbaseTx);
        for (uint256 i = 0; i < merkleProof.length; i++) {
            current = BTCUtils.dsha256(abi.encodePacked(current, merkleProof[i]));
        }
        if (current != expectedRoot) revert InvalidMerkleProof();

        uint64 totalOutput = BTCUtils.parseCoinbaseOutputValue(coinbaseTx);
        uint64 subsidy = BTCUtils.getBlockSubsidy(height);
        return totalOutput - subsidy;
    }

    /// @dev Compare cumulative work of submitted headers vs existing chain from the fork point.
    function _isHeavierChain(bytes calldata headers, uint32 ancestorHeight, uint256 count)
        internal
        view
        returns (bool)
    {
        uint256 newWork;
        uint256 oldWork;
        for (uint256 i = 0; i < count; i++) {
            uint32 newNBits = BTCUtils.readUint32LE(headers, i * 80 + 72);
            newWork += BTCUtils.targetToWork(BTCUtils.nBitsToTarget(newNBits));
            uint32 oldNBits = _blockAt(ancestorHeight + 1 + uint32(i)).nBits;
            oldWork += BTCUtils.targetToWork(BTCUtils.nBitsToTarget(oldNBits));
        }
        return newWork > oldWork;
    }

    /// @dev `nTime` must be <= `block.timestamp + MAX_FUTURE_BLOCK_TIME`. No MTP (prior-11 median).
    function _validateTimestamp(uint32, uint32 timestamp) internal view {
        if (timestamp > uint32(block.timestamp) + MAX_FUTURE_BLOCK_TIME) revert InvalidTimestamp();
    }

    function _validateDifficulty(uint32 height, uint32 newNBits, uint32 prevNBits, PackedState memory s)
        internal
        view
    {
        if (height % RETARGET_INTERVAL == 0) {
            _verifyRetarget(height, newNBits, s);
        } else {
            if (newNBits != prevNBits) revert UnexpectedDifficultyChange();
        }
    }

    function _verifyRetarget(uint32 height, uint32 newNBits, PackedState memory s) internal view {
        uint256 startTime = uint256(s.epochStartTimestamp);
        BlockEntry storage lastBlock = _blockAt(height - 1);
        uint256 endTime = uint256(lastBlock.timestamp);

        uint256 actualTimespan = endTime - startTime;

        if (actualTimespan < EXPECTED_TIMESPAN / 4) actualTimespan = EXPECTED_TIMESPAN / 4;
        if (actualTimespan > EXPECTED_TIMESPAN * 4) actualTimespan = EXPECTED_TIMESPAN * 4;

        uint256 oldTarget = BTCUtils.nBitsToTarget(s.epochStartNBits);
        uint256 newTarget = BTCUtils.nBitsToTarget(newNBits);
        uint256 expectedTarget = (oldTarget * actualTimespan) / EXPECTED_TIMESPAN;

        uint256 tolerance = expectedTarget / 1000;
        if (tolerance == 0) tolerance = 1;
        if (newTarget < expectedTarget - tolerance || newTarget > expectedTarget + tolerance) {
            revert InvalidRetarget();
        }

        s.epochStartTimestamp = lastBlock.timestamp;
        s.epochStartNBits = newNBits;
    }
}
