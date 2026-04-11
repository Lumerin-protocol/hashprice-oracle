// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { BTCUtils } from "./libraries/BTCUtils.sol";

/// @title HashpriceBTC
/// @notice Gas-optimized trustless hashprice oracle (relay + verifier + oracle in one).
///         Single `submitBlock()` entry point per block. Supports on-chain reorg handling via `submitBlocks()`.
/// @dev Implements AggregatorV3Interface. Returns the price of 100 TH/s per day in BTC.
///      Average fees use a simple moving average over 144 blocks so the on-chain
///      hashprice is comparable to the Luxor hashprice index.
contract HashpriceBTC is AggregatorV3Interface {
    // ─── Constants ────────────────────────────────────────────────────

    /// @dev How many recent block headers we keep
    ///      in storage to handle reorgs.
    uint32 private constant BLOCK_BUFFER_SIZE = 32;

    /// @dev Number of blocks in the fee SMA,
    ///      matches Luxor index window.
    uint32 private constant FEE_WINDOW = 144;

    /// @dev Blocks behind tip used as “confirmed”
    ///      for `latestRoundData`.
    uint32 public constant CONFIRMATION_DEPTH = 6;

    /// @dev Number of blocks per difficulty epoch;
    uint256 private constant RETARGET_INTERVAL = 2016;

    /// @dev Target seconds per difficulty epoch:
    ///      2016 blocks × 10 min (Bitcoin retarget timespan).
    uint256 private constant EXPECTED_TIMESPAN = RETARGET_INTERVAL * 10 * 60;

    /// @dev Max seconds header time may be ahead of
    ///      `block.timestamp` (Bitcoin's 2h rule)
    uint32 private constant MAX_FUTURE_BLOCK_TIME = 2 * 3600;

    /// @dev Hashes in 100 TH/s over one day (100 × 1e12 × 86_400);
    uint256 private constant HASHES_PER_100THS_PER_DAY = 100 * 1e12 * 24 * 3600;

    /// @dev Size of a raw Bitcoin block header
    uint256 private constant HEADER_SIZE = 80;

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

    /// @dev Cached output of latestRoundData(), refreshed on every block submission.
    ///      Packs into a single 32-byte storage slot (10+4+4+8 = 26 bytes), so reads cost
    ///      one SLOAD instead of recomputing difficulty/subsidy/fees each time.
    struct CachedRoundData {
        uint80 roundId;
        uint32 startedAt;
        uint32 updatedAt;
        int256 answer;
    }

    // ─── Storage ───────────────────────────────────────────────────────

    /// @dev Ring buffer of recent blocks to handle reorgs.
    BlockEntry[BLOCK_BUFFER_SIZE] internal _blocks;

    /// @dev Ring buffer of recent fees to calculate SMA.
    uint64[FEE_WINDOW] internal _fees;

    /// @dev dSHA256 of the current header; next `submitBlock` must extend this.
    bytes32 public chainTipHash;

    /// @dev Packed chain/oracle state
    PackedState public state;

    /// @dev Running sum of fees over the last `FEE_WINDOW` blocks.
    uint256 private feeRunningSum;

    /// @dev Cache for latestRoundData().
    CachedRoundData private latestRoundDataCache;

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

    // ─── Block submission ─────────────────────────────────────────────

    /// @notice Submit a single block (header + coinbase proof). Steady-state path.
    /// @param header Raw 80-byte Bitcoin block header
    /// @param coinbaseTx Non-witness serialized coinbase transaction
    /// @param merkleProof Merkle sibling hashes from coinbase leaf to root
    function submitBlock(bytes calldata header, bytes calldata coinbaseTx, bytes32[] calldata merkleProof) external {
        _validateHeaderLength(header);
        PackedState memory s = state;

        BlockEntry memory cur = BlockEntry({
            blockHash: chainTipHash,
            timestamp: 0,
            nBits: _blockAt(s.chainHeight).nBits,
            height: s.chainHeight
        });

        _processHeader(header, coinbaseTx, merkleProof, cur, s);
        chainTipHash = cur.blockHash;

        s.chainHeight = cur.height;
        s.blockCount++;
        s.lastSubmittedAt = uint32(block.timestamp);
        state = s;

        _updateLatestRoundData(s);
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
        _validateHeadersLength(headers);
        uint256 count = headers.length / HEADER_SIZE;
        if (coinbaseTxs.length != count || merkleProofs.length != count) {
            revert ArrayLengthMismatch();
        }

        BlockEntry storage ancestor = _blockAt(ancestorHeight);
        if (ancestor.height != ancestorHeight) revert AncestorNotInBuffer();

        PackedState memory s = state;
        BlockEntry memory cur = ancestor;

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
            emit ChainReorg(cur.blockHash, cur.height);
        } else {
            revert NotHeaviestChain();
        }

        chainTipHash = cur.blockHash;
        s.lastSubmittedAt = uint32(block.timestamp);
        state = s;

        if (s.chainHeight >= CONFIRMATION_DEPTH) {
            _updateLatestRoundData(s);
        }
    }

    function _sliceHeaders(bytes calldata headers, uint256 index) internal pure returns (bytes calldata) {
        return headers[index * HEADER_SIZE:(index + 1) * HEADER_SIZE];
    }

    /// @dev Process a single header inside submitBlocks. Mutates `cur` in place.
    function _processHeader(
        bytes calldata header,
        bytes calldata coinbaseTx,
        bytes32[] calldata merkleProof,
        BlockEntry memory cur,
        PackedState memory s
    ) internal {
        BTCUtils.HeaderInfo memory info = BTCUtils.parseHeader(header);
        _validateChainLinkage(info.prevBlockHash, cur.blockHash);

        uint256 target = BTCUtils.nBitsToTarget(info.nBits);
        bytes32 blockHash = BTCUtils.hash256View(header);

        cur.height++;

        _validateWork(blockHash, target);
        _validateTimestamp(cur.height, info.timestamp);
        _validateDifficulty(cur.height, info.nBits, cur.nBits, s);

        uint64 fees = _verifyCoinbaseAndExtractFees(cur.height, info.merkleRoot, coinbaseTx, merkleProof);

        _updateFees(fees, cur.height, s.blockCount);
        _setBlockAt(cur.height, blockHash, info.timestamp, info.nBits);

        cur.blockHash = blockHash;
        cur.nBits = info.nBits;

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
    /// @dev Reads the single-slot cache written by every block submission — one SLOAD.
    /// @return roundId Confirmed Bitcoin block height
    /// @return answer Hashprice in satoshis (8 decimals = BTC)
    /// @return startedAt Bitcoin block timestamp at confirmed height
    /// @return updatedAt EVM block.timestamp when tip was last submitted
    /// @return answeredInRound Same as roundId
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        CachedRoundData memory c = latestRoundDataCache;
        if (c.roundId == 0) revert InsufficientData();
        return (c.roundId, c.answer, uint256(c.startedAt), uint256(c.updatedAt), c.roundId);
    }

    /// @notice Returns the height of the latest confirmed block
    function confirmedHeight() public view returns (uint32) {
        PackedState memory s = state;
        if (s.chainHeight < CONFIRMATION_DEPTH) return 0;
        return s.chainHeight - CONFIRMATION_DEPTH;
    }

    // ─── Internal helpers ─────────────────────────────────────────────

    /// @dev Recompute the hashprice for `confirmed` and write the result to `latestRoundDataCache`.
    ///      Skips silently if the confirmed block is not yet in the ring buffer.
    ///      Must be called after state, _blocks, and feeRunningSum have been written to storage.
    function _updateLatestRoundData(PackedState memory s) internal {
        if (s.chainHeight < CONFIRMATION_DEPTH) return;

        uint32 confirmed = s.chainHeight - CONFIRMATION_DEPTH;
        BlockEntry storage entry = _blockAt(confirmed);
        if (entry.height != confirmed) return;

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

        latestRoundDataCache = CachedRoundData({
            roundId: uint80(confirmed),
            startedAt: entry.timestamp,
            updatedAt: s.lastSubmittedAt,
            answer: int256(hashpriceSats)
        });
    }

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
    ) internal view returns (uint64) {
        bytes32 current = BTCUtils.hash256View(coinbaseTx);

        // Coinbase is always at index 0, so it is the left node at every level of the tree.
        for (uint256 i = 0; i < merkleProof.length; i++) {
            current = BTCUtils.hash256Pair(current, merkleProof[i]);
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
            uint32 newNBits = BTCUtils.readUint32LE(headers, i * HEADER_SIZE + 72);
            newWork += BTCUtils.targetToWork(BTCUtils.nBitsToTarget(newNBits));

            uint32 oldNBits = _blockAt(ancestorHeight + 1 + uint32(i)).nBits;
            oldWork += BTCUtils.targetToWork(BTCUtils.nBitsToTarget(oldNBits));
        }
        return newWork > oldWork;
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

    function _validateWork(bytes32 blockHash, uint256 target) internal pure {
        if (uint256(BTCUtils.reverseBytes32(blockHash)) > target) {
            revert InsufficientPoW();
        }
    }

    function _validateChainLinkage(bytes32 prevBlockHash, bytes32 _chainTipHash) internal pure {
        if (prevBlockHash != _chainTipHash) revert BrokenChain();
    }

    /// @dev Bitcoin's Median Time Past (nTime > median of prior 11) is omitted — too many
    ///      storage reads per block for this ring-buffer design. We only enforce the 2h future cap
    function _validateTimestamp(uint32, uint32 timestamp) internal view {
        if (timestamp > uint32(block.timestamp) + MAX_FUTURE_BLOCK_TIME) revert InvalidTimestamp();
    }

    function _validateHeaderLength(bytes calldata header) internal pure {
        if (header.length != HEADER_SIZE) revert InvalidHeaderLength();
    }

    function _validateHeadersLength(bytes calldata headers) internal pure {
        if (headers.length % HEADER_SIZE != 0 || headers.length == 0) {
            revert InvalidHeaderLength();
        }
    }
}
