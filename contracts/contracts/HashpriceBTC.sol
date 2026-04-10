// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { BTCUtils } from "./libraries/BTCUtils.sol";

/// @title HashpriceBTC
/// @notice Gas-optimized trustless hashprice oracle (relay + verifier + oracle in one).
///         Uses ring buffers instead of unbounded mappings. Single `submitBlock()` entry
///         point per block. Supports on-chain reorg handling via `submitBlocks()`.
/// @dev Implements AggregatorV3Interface. Returns the price of 100 TH/s per day in BTC.
///      Future optimization: replace SMA with an exponential moving average (EMA) to
///      eliminate the fee ring buffer entirely.
contract HashpriceBTC is AggregatorV3Interface {
    // ─── Constants ────────────────────────────────────────────────────

    uint32 public constant BLOCK_BUFFER_SIZE = 32;
    uint32 public constant FEE_WINDOW = 144;
    uint32 public constant CONFIRMATION_DEPTH = 6;
    uint256 public constant EXPECTED_TIMESPAN = 2016 * 600;
    uint256 public constant RETARGET_INTERVAL = 2016;
    uint256 private constant HASHES_PER_100THS_PER_DAY = 8_640_000_000_000_000_000;

    // ─── Storage: block ring buffer (32 entries × 2 slots = 64 slots) ─

    struct BlockEntry {
        bytes32 blockHashLE;
        uint32 timestamp;
        uint32 nBits;
        uint32 height;
    }

    BlockEntry[BLOCK_BUFFER_SIZE] internal _blocks;

    // ─── Storage: fee ring buffer (144 entries, packed) ───────────────

    uint64[FEE_WINDOW] internal _fees;

    // ─── Storage: global state (packed into 1 slot) ──────────────────

    struct PackedState {
        uint32 chainHeight;
        uint32 blockCount;
        uint32 epochStartTimestamp;
        uint32 epochStartNBits;
        uint32 lastSubmittedAt;
    }

    bytes32 public chainTip;
    PackedState public state; // 1 slot (20 bytes)
    uint256 public feeRunningSum;

    /// @dev Mutable chain state passed through submitBlocks loop to avoid stack-too-deep
    struct ChainCursor {
        bytes32 prevHash;
        uint32 height;
        uint32 prevNBits;
    }

    // ─── Errors ───────────────────────────────────────────────────────

    error InvalidHeaderLength();
    error BrokenChain();
    error InsufficientPoW();
    error InvalidTimestamp();
    error UnexpectedDifficultyChange();
    error InvalidRetarget();
    error InvalidMerkleProof();
    error NotHeaviestChain();
    error AncestorTooOld();
    error InsufficientData();
    error ArrayLengthMismatch();
    error NotImplemented();

    // ─── Events ───────────────────────────────────────────────────────

    event BlockSubmitted(bytes32 indexed blockHash, uint32 indexed height, uint64 fees);
    event ChainReorg(bytes32 indexed newTip, uint32 indexed newHeight);

    // ─── Constructor ──────────────────────────────────────────────────

    /// @notice Deploy with a trusted checkpoint block (precomputed off-chain)
    /// @param blockHashLE Little-endian block hash
    /// @param height Block height
    /// @param timestamp Block timestamp
    /// @param nBits Encoded difficulty target
    /// @param _epochStartTimestamp Timestamp of the first block in the current difficulty epoch
    /// @param _epochStartNBits nBits of the first block in the current difficulty epoch
    constructor(
        bytes32 blockHashLE,
        uint32 height,
        uint32 timestamp,
        uint32 nBits,
        uint32 _epochStartTimestamp,
        uint32 _epochStartNBits
    ) {
        _blocks[height & 31] =
            BlockEntry({ blockHashLE: blockHashLE, timestamp: timestamp, nBits: nBits, height: height });

        chainTip = blockHashLE;
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
        if (header.length != 80) revert InvalidHeaderLength();

        BTCUtils.HeaderInfo memory info = BTCUtils.parseHeader(header);
        bytes32 blockHashLE = BTCUtils.reverseBytes32(BTCUtils.dsha256(header));

        if (info.prevBlockHashLE != chainTip) revert BrokenChain();

        uint256 target = BTCUtils.nBitsToTarget(info.nBits);
        if (uint256(blockHashLE) > target) revert InsufficientPoW();

        PackedState memory s = state;
        uint32 height = s.chainHeight + 1;

        _validateTimestamp(height, info.timestamp);
        _validateDifficulty(height, info.nBits, _blocks[s.chainHeight & 31].nBits, s);

        uint64 fees = _verifyCoinbaseAndExtractFees(height, info.merkleRoot, coinbaseTx, merkleProof);

        _writeBlock(height, blockHashLE, info.timestamp, info.nBits, fees, s);

        chainTip = blockHashLE;
        s.chainHeight = height;
        s.blockCount++;
        s.lastSubmittedAt = uint32(block.timestamp);
        state = s;

        emit BlockSubmitted(blockHashLE, height, fees);
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
        if (headers.length % 80 != 0 || headers.length == 0) revert InvalidHeaderLength();
        uint256 count = headers.length / 80;
        if (coinbaseTxs.length != count || merkleProofs.length != count) revert ArrayLengthMismatch();

        BlockEntry storage ancestor = _blocks[ancestorHeight & 31];
        if (ancestor.height != ancestorHeight) revert AncestorTooOld();

        PackedState memory s = state;

        ChainCursor memory cur =
            ChainCursor({ prevHash: ancestor.blockHashLE, height: ancestorHeight, prevNBits: ancestor.nBits });

        for (uint256 i = 0; i < count; i++) {
            _processHeader(headers[i * 80:(i + 1) * 80], coinbaseTxs[i], merkleProofs[i], cur, s);
        }

        if (cur.height > s.chainHeight) {
            chainTip = cur.prevHash;
            s.chainHeight = cur.height;
            s.blockCount += uint32(count);
        } else if (cur.height == s.chainHeight) {
            if (!_isHeavierChain(headers, ancestorHeight, count)) revert NotHeaviestChain();
            chainTip = cur.prevHash;
            s.chainHeight = cur.height;
            emit ChainReorg(cur.prevHash, cur.height);
        } else {
            revert NotHeaviestChain();
        }
        s.lastSubmittedAt = uint32(block.timestamp);
        state = s;
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

        if (info.prevBlockHashLE != cur.prevHash) revert BrokenChain();
        bytes32 blockHashLE = BTCUtils.reverseBytes32(BTCUtils.dsha256(header));

        uint256 target = BTCUtils.nBitsToTarget(info.nBits);
        if (uint256(blockHashLE) > target) revert InsufficientPoW();

        cur.height++;

        _validateTimestamp(cur.height, info.timestamp);
        _validateDifficulty(cur.height, info.nBits, cur.prevNBits, s);

        uint64 fees = _verifyCoinbaseAndExtractFees(cur.height, info.merkleRoot, coinbaseTx, merkleProof);

        _writeBlock(cur.height, blockHashLE, info.timestamp, info.nBits, fees, s);

        cur.prevHash = blockHashLE;
        cur.prevNBits = info.nBits;

        emit BlockSubmitted(blockHashLE, cur.height, fees);
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

        BlockEntry storage entry = _blocks[confirmed & 31];
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

    function _writeBlock(
        uint32 height,
        bytes32 blockHashLE,
        uint32 timestamp,
        uint32 nBits,
        uint64 fees,
        PackedState memory s
    ) internal {
        _blocks[height & 31] =
            BlockEntry({ blockHashLE: blockHashLE, timestamp: timestamp, nBits: nBits, height: height });

        uint256 idx = height % FEE_WINDOW;
        uint64 oldFee = _fees[idx];
        _fees[idx] = fees;

        feeRunningSum += uint256(fees);
        if (s.blockCount >= FEE_WINDOW) {
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
            uint32 oldNBits = _blocks[(ancestorHeight + 1 + uint32(i)) & 31].nBits;
            oldWork += BTCUtils.targetToWork(BTCUtils.nBitsToTarget(oldNBits));
        }
        return newWork > oldWork;
    }

    function _validateTimestamp(uint32, uint32 timestamp) internal view {
        if (timestamp > uint32(block.timestamp) + 7200) revert InvalidTimestamp();
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
        BlockEntry storage lastBlock = _blocks[(height - 1) & 31];
        uint256 endTime = uint256(lastBlock.timestamp);

        uint256 actualTimespan = endTime - startTime;

        if (actualTimespan < EXPECTED_TIMESPAN / 4) actualTimespan = EXPECTED_TIMESPAN / 4;
        if (actualTimespan > EXPECTED_TIMESPAN * 4) actualTimespan = EXPECTED_TIMESPAN * 4;

        uint256 oldTarget = BTCUtils.nBitsToTarget(s.epochStartNBits);
        uint256 expectedTarget = (oldTarget * actualTimespan) / EXPECTED_TIMESPAN;
        uint256 newTarget = BTCUtils.nBitsToTarget(newNBits);

        uint256 tolerance = expectedTarget / 1000;
        if (tolerance == 0) tolerance = 1;
        if (newTarget < expectedTarget - tolerance || newTarget > expectedTarget + tolerance) {
            revert InvalidRetarget();
        }

        s.epochStartTimestamp = lastBlock.timestamp;
        s.epochStartNBits = newNBits;
    }
}
