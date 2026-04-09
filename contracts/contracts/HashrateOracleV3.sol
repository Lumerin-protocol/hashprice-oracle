// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { Versionable } from "./Versionable.sol";
import { BTCUtils } from "./libraries/BTCUtils.sol";

/// @title HashrateOracleV3
/// @notice Gas-optimized trustless hashprice oracle (relay + verifier + oracle in one).
///         Uses ring buffers instead of unbounded mappings. Single `submitBlock()` entry
///         point per block. Supports on-chain reorg handling via `submitBlocks()`.
/// @dev Implements AggregatorV3Interface. Returns the price of 100 TH/s per day in BTC.
///      Future optimization: replace SMA with an exponential moving average (EMA) to
///      eliminate the fee ring buffer entirely.
contract HashrateOracleV3 is Versionable, AggregatorV3Interface {
    // ─── Constants ────────────────────────────────────────────────────

    uint32 public constant BLOCK_BUFFER_SIZE = 32;
    uint32 public constant FEE_WINDOW = 144;
    uint32 public constant CONFIRMATION_DEPTH = 6;
    uint256 public constant EXPECTED_TIMESPAN = 2016 * 600;
    uint256 public constant RETARGET_INTERVAL = 2016;
    uint256 private constant HASHES_PER_100THS_PER_DAY = 8_640_000_000_000_000_000;

    string public constant VERSION = "1.0.0";

    // ─── Storage: block ring buffer (32 entries × 3 slots = 96 slots) ─

    struct BlockEntry {
        bytes32 blockHashLE;
        uint256 cumulativeWork;
        uint32 timestamp;
        uint32 nBits;
        uint32 height;
    }

    BlockEntry[BLOCK_BUFFER_SIZE] internal _blocks;

    // ─── Storage: fee ring buffer (144 entries, packed) ───────────────

    uint64[FEE_WINDOW] internal _fees;

    // ─── Storage: global state ────────────────────────────────────────

    bytes32 public chainTip;
    uint32 public chainHeight;
    uint32 public blockCount;
    uint256 public feeRunningSum;

    /// @dev Retarget epoch start data (stored separately since the epoch
    ///      start block at height-2016 is outside the ring buffer).
    uint32 public epochStartTimestamp;
    uint32 public epochStartNBits;
    uint32 public lastSubmittedAt;

    /// @dev Mutable chain state passed through submitBlocks loop to avoid stack-too-deep
    struct ChainCursor {
        bytes32 prevHash;
        uint32 height;
        uint256 cumWork;
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
    event ChainReorg(bytes32 indexed newTip, uint32 indexed newHeight, uint256 cumulativeWork);

    // ─── Constructor ──────────────────────────────────────────────────

    /// @notice Deploy with a trusted checkpoint block (precomputed off-chain)
    /// @param blockHashLE Little-endian block hash
    /// @param height Block height
    /// @param timestamp Block timestamp
    /// @param nBits Encoded difficulty target
    constructor(bytes32 blockHashLE, uint32 height, uint32 timestamp, uint32 nBits) {
        uint256 target = BTCUtils.nBitsToTarget(nBits);
        uint256 work = BTCUtils.targetToWork(target);

        // Ring buffer index: `height & 31` is equivalent to `height % 32` but cheaper.
        // Newer blocks overwrite older ones; the stored `height` field lets readers
        // detect whether a slot still holds the block they expect.
        _blocks[height & 31] = BlockEntry({
            blockHashLE: blockHashLE,
            cumulativeWork: work,
            timestamp: timestamp,
            nBits: nBits,
            height: height
        });

        chainTip = blockHashLE;
        chainHeight = height;
        epochStartTimestamp = timestamp;
        epochStartNBits = nBits;
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

        uint32 height = chainHeight + 1;

        _validateTimestamp(height, info.timestamp);

        BlockEntry storage parent = _blocks[chainHeight & 31];
        _validateDifficulty(height, info.nBits, parent.nBits);

        uint256 cumWork = parent.cumulativeWork + BTCUtils.targetToWork(target);

        uint64 fees = _verifyCoinbaseAndExtractFees(height, info.merkleRoot, coinbaseTx, merkleProof);

        _writeBlock(height, blockHashLE, cumWork, info.timestamp, info.nBits, fees);

        chainTip = blockHashLE;
        chainHeight = height;
        blockCount++;
        lastSubmittedAt = uint32(block.timestamp);

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

        ChainCursor memory cur = ChainCursor({
            prevHash: ancestor.blockHashLE,
            height: ancestorHeight,
            cumWork: ancestor.cumulativeWork,
            prevNBits: ancestor.nBits
        });

        for (uint256 i = 0; i < count; i++) {
            _processHeader(headers[i * 80:(i + 1) * 80], coinbaseTxs[i], merkleProofs[i], cur);
        }

        if (cur.height > chainHeight) {
            chainTip = cur.prevHash;
            chainHeight = cur.height;
            blockCount += uint32(count);
        } else if (cur.cumWork > _blocks[chainHeight & 31].cumulativeWork) {
            chainTip = cur.prevHash;
            chainHeight = cur.height;
            emit ChainReorg(cur.prevHash, cur.height, cur.cumWork);
        } else {
            revert NotHeaviestChain();
        }
        lastSubmittedAt = uint32(block.timestamp);
    }

    /// @dev Process a single header inside submitBlocks. Mutates `cur` in place.
    function _processHeader(
        bytes calldata header,
        bytes calldata coinbaseTx,
        bytes32[] calldata merkleProof,
        ChainCursor memory cur
    ) internal {
        BTCUtils.HeaderInfo memory info = BTCUtils.parseHeader(header);

        if (info.prevBlockHashLE != cur.prevHash) revert BrokenChain();
        bytes32 blockHashLE = BTCUtils.reverseBytes32(BTCUtils.dsha256(header));

        uint256 target = BTCUtils.nBitsToTarget(info.nBits);
        if (uint256(blockHashLE) > target) revert InsufficientPoW();

        cur.height++;

        _validateTimestamp(cur.height, info.timestamp);
        _validateDifficulty(cur.height, info.nBits, cur.prevNBits);

        cur.cumWork += BTCUtils.targetToWork(target);

        uint64 fees = _verifyCoinbaseAndExtractFees(cur.height, info.merkleRoot, coinbaseTx, merkleProof);

        _writeBlock(cur.height, blockHashLE, cur.cumWork, info.timestamp, info.nBits, fees);

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
        if (chainHeight < CONFIRMATION_DEPTH) revert InsufficientData();
        uint32 confirmed = chainHeight - CONFIRMATION_DEPTH;

        BlockEntry storage entry = _blocks[confirmed & 31];
        if (entry.height != confirmed) revert InsufficientData();

        uint256 difficulty = BTCUtils.nBitsToDifficulty(entry.nBits);
        uint64 subsidy = BTCUtils.getBlockSubsidy(confirmed);

        uint256 avgFees;
        if (blockCount >= FEE_WINDOW) {
            avgFees = feeRunningSum / FEE_WINDOW;
        } else {
            avgFees = feeRunningSum / blockCount;
        }

        uint256 rewardPerBlock = uint256(subsidy) + avgFees;
        uint256 hashpriceSats = (HASHES_PER_100THS_PER_DAY * rewardPerBlock) / (difficulty * (1 << 32));

        uint80 _roundId = uint80(confirmed);
        return (_roundId, int256(hashpriceSats), uint256(entry.timestamp), uint256(lastSubmittedAt), _roundId);
    }

    /// @notice Returns the height of the latest confirmed block
    function confirmedHeight() public view returns (uint32) {
        if (chainHeight < CONFIRMATION_DEPTH) return 0;
        return chainHeight - CONFIRMATION_DEPTH;
    }

    // ─── Internal helpers ─────────────────────────────────────────────

    function _writeBlock(
        uint32 height,
        bytes32 blockHashLE,
        uint256 cumWork,
        uint32 timestamp,
        uint32 nBits,
        uint64 fees
    ) internal {
        _blocks[height & 31] = BlockEntry({
            blockHashLE: blockHashLE,
            cumulativeWork: cumWork,
            timestamp: timestamp,
            nBits: nBits,
            height: height
        });

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

    function _validateTimestamp(uint32 height, uint32 timestamp) internal view {
        if (height > 11) {
            uint32[11] memory times;
            for (uint32 i = 0; i < 11; i++) {
                uint32 h = height - 1 - i;
                BlockEntry storage blk = _blocks[h & 31];
                if (blk.height != h) break;
                times[i] = blk.timestamp;
            }
            uint32 median = _median11(times);
            if (timestamp <= median) revert InvalidTimestamp();
        }

        if (timestamp > uint32(block.timestamp) + 7200) revert InvalidTimestamp();
    }

    function _validateDifficulty(uint32 height, uint32 newNBits, uint32 prevNBits) internal {
        if (height % RETARGET_INTERVAL == 0) {
            _verifyRetarget(height, newNBits);
        } else {
            if (newNBits != prevNBits) revert UnexpectedDifficultyChange();
        }
    }

    function _verifyRetarget(uint32 height, uint32 newNBits) internal {
        uint256 startTime = uint256(epochStartTimestamp);
        BlockEntry storage lastBlock = _blocks[(height - 1) & 31];
        uint256 endTime = uint256(lastBlock.timestamp);

        uint256 actualTimespan = endTime - startTime;

        if (actualTimespan < EXPECTED_TIMESPAN / 4) actualTimespan = EXPECTED_TIMESPAN / 4;
        if (actualTimespan > EXPECTED_TIMESPAN * 4) actualTimespan = EXPECTED_TIMESPAN * 4;

        uint256 oldTarget = BTCUtils.nBitsToTarget(epochStartNBits);
        uint256 expectedTarget = (oldTarget * actualTimespan) / EXPECTED_TIMESPAN;
        uint256 newTarget = BTCUtils.nBitsToTarget(newNBits);

        uint256 tolerance = expectedTarget / 1000;
        if (tolerance == 0) tolerance = 1;
        if (newTarget < expectedTarget - tolerance || newTarget > expectedTarget + tolerance) {
            revert InvalidRetarget();
        }

        epochStartTimestamp = lastBlock.timestamp;
        epochStartNBits = newNBits;
    }

    function _median11(uint32[11] memory arr) internal pure returns (uint32) {
        for (uint256 i = 1; i < 11; i++) {
            uint32 key = arr[i];
            uint256 j = i;
            while (j > 0 && arr[j - 1] > key) {
                arr[j] = arr[j - 1];
                j--;
            }
            arr[j] = key;
        }
        return arr[5];
    }
}
