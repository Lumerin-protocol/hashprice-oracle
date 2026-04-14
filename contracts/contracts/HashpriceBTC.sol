// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import { BTCUtils } from "./libraries/BTCUtils.sol";

/// @title HashpriceBTC
/// @notice Trustless hashprice oracle powered by Bitcoin SPV (Simplified Payment Verification).
///         Anyone can permissionlessly submit Bitcoin block headers and coinbase merkle proofs;
///         the contract verifies header proof-of-work and merkle inclusion on-chain, then derives
///         hashprice from the verified subsidy + fees and the current difficulty target.
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

    /// @dev Blocks behind tip reported by `latestRoundData`.
    ///      Depth=1 protects against the rare natural 1-block orphan without
    ///      adding meaningful lag. Deeper confirmation is unnecessary: difficulty
    ///      only changes at 2016-block boundaries so reorgs never affect it, and
    ///      fees are smoothed over a 144-block SMA so even a 2-block reorg moves
    ///      the reported hashprice by at most ~1.4%.
    uint32 public constant CONFIRMATION_DEPTH = 1;

    /// @dev Number of blocks per difficulty epoch;
    uint256 private constant RETARGET_INTERVAL = 2016;

    /// @dev Target seconds per difficulty epoch:
    ///      2016 blocks × 10 min (Bitcoin retarget timespan).
    uint256 private constant EXPECTED_TIMESPAN = RETARGET_INTERVAL * 10 * 60;

    /// @dev Max seconds header time may be ahead of
    ///      `block.timestamp` (Bitcoin's 2h rule)
    uint32 private constant MAX_FUTURE_BLOCK_TIME = 2 * 3600;

    /// @dev Hashes in 100 TH/s over one day
    uint256 private constant HASHES_PER_100THS_PER_DAY = 100 * 1e12 * 24 * 3600;

    /// @dev Size of a raw Bitcoin block header
    uint256 private constant HEADER_SIZE = 80;

    /// @dev Decimals for the result of latestRoundData()
    uint8 private constant DECIMALS = 16;

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

    /// @notice Emitted for each Bitcoin block header successfully validated and written to the ring buffer.
    /// @dev Fires once per header inside `_processHeader`, so a batch of N headers produces N events.
    ///      Useful for off-chain indexers that need per-block fee data; `HashpriceUpdated` only
    ///      exposes the 144-block SMA and does not carry individual block fees.
    /// @param blockHash dSHA-256 of the 80-byte header in internal byte order
    /// @param height    Bitcoin block height
    /// @param fees      Total coinbase output value minus block subsidy, in satoshis
    event BlockSubmitted(bytes32 indexed blockHash, uint32 indexed height, uint64 fees);

    /// @notice Emitted whenever an incoming fork replaces one or more blocks on the canonical chain.
    /// @dev Fires in two cases:
    ///      1. Longer fork: the fork diverges below the current tip (`ancestorHeight < chainHeight`)
    ///         and ends higher — replaced blocks are implicitly discarded from the ring buffer.
    ///      2. Same-height fork: the fork ends at the same height but carries strictly greater
    ///         cumulative proof-of-work.
    ///      A plain chain extension (`ancestorHeight == chainHeight`) never emits this event.
    /// @param newTip    Block hash of the incoming chain's tip
    /// @param newHeight Bitcoin height of the new tip
    event ChainReorg(bytes32 indexed newTip, uint32 indexed newHeight);

    /// @notice Emitted whenever the confirmed hashprice is recomputed (once per block submission).
    /// @param confirmedHeight Bitcoin block height the hashprice is derived from
    /// @param hashprice       Price of 100 TH/s per day in satoshis (8 decimals = BTC)
    /// @param avgFees         144-block SMA of transaction fees in satoshis
    event HashpriceUpdated(uint32 indexed confirmedHeight, int256 hashprice, uint256 avgFees);

    /// @notice Emitted once per difficulty epoch (~every 2016 blocks) when the target adjusts.
    /// @param height      First block of the new epoch
    /// @param nBits       Compact difficulty target
    /// @param difficulty  Expanded difficulty value
    event DifficultyChanged(uint32 indexed height, uint32 nBits, uint256 difficulty);

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
        BTCUtils.requireSha256Precompile();
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

        // Snapshot cumulative work of both chains BEFORE the processing loop.
        // _processHeader calls _setBlockAt which overwrites the ring buffer slot for each
        // height. Reading _blockAt(ancestorHeight + 1 + i) after the loop returns the new
        // fork's own nBits, making oldWork == newWork and the heavier-chain check always
        // false (H-1). Snapshotting here captures the existing canonical chain's nBits.
        (uint256 snapshotOldWork, uint256 snapshotNewWork) =
            _snapshotForkWork(headers, ancestorHeight, count, s.chainHeight);

        for (uint256 i = 0; i < count; i++) {
            _processHeader(_sliceHeaders(headers, i), coinbaseTxs[i], merkleProofs[i], cur, s);
        }

        if (cur.height < s.chainHeight) {
            revert NotHeaviestChain();
        }

        if (cur.height > s.chainHeight) {
            // Emit ChainReorg when the fork diverges below the current tip (some canonical
            // blocks are being replaced). A plain extension (ancestorHeight == chainHeight)
            // is not a reorg and does not emit the event.
            if (ancestorHeight < s.chainHeight) {
                emit ChainReorg(cur.blockHash, cur.height);
            }
            s.chainHeight = cur.height;
            s.blockCount += uint32(count);
        } else if (snapshotNewWork > snapshotOldWork) {
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
        _validateTimestamp(info.timestamp);
        _validateDifficulty(cur.height, info.nBits, cur.nBits, s);

        uint64 fees = _verifyCoinbaseAndExtractFees(cur.height, info.merkleRoot, coinbaseTx, merkleProof);

        _updateFees(fees, cur.height);
        _setBlockAt(cur.height, blockHash, info.timestamp, info.nBits);

        cur.blockHash = blockHash;
        cur.nBits = info.nBits;

        emit BlockSubmitted(blockHash, cur.height, fees);
    }

    // ─── AggregatorV3Interface ────────────────────────────────────────

    function decimals() public pure returns (uint8) {
        return DECIMALS;
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

    /// @notice Returns the height of the latest confirmed block (tip − CONFIRMATION_DEPTH)
    function confirmedHeight() public view returns (uint32) {
        PackedState memory s = state;
        if (s.chainHeight < CONFIRMATION_DEPTH) return 0;
        return s.chainHeight - CONFIRMATION_DEPTH;
    }

    /// @notice Returns the current 144-block simple moving average of transaction fees in satoshis
    function avgFees() external view returns (uint256) {
        PackedState memory s = state;
        if (s.blockCount == 0) revert InsufficientData();
        return s.blockCount >= FEE_WINDOW ? feeRunningSum / FEE_WINDOW : feeRunningSum / s.blockCount;
    }

    /// @notice Returns the network difficulty at the current confirmed block
    function difficulty() external view returns (uint256) {
        uint32 height = confirmedHeight();
        BlockEntry storage entry = _blockAt(height);
        if (entry.height != height) revert InsufficientData();
        return BTCUtils.nBitsToDifficulty(entry.nBits);
    }

    /// @notice Returns the block subsidy at the current confirmed block height in satoshis
    function subsidy() external view returns (uint64) {
        return BTCUtils.getBlockSubsidy(confirmedHeight());
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

        uint64 sub = BTCUtils.getBlockSubsidy(confirmed);

        uint256 fees;
        if (s.blockCount >= FEE_WINDOW) {
            fees = feeRunningSum / FEE_WINDOW;
        } else if (s.blockCount > 0) {
            fees = feeRunningSum / s.blockCount;
        }

        uint256 diff = BTCUtils.nBitsToDifficulty(entry.nBits);
        if (diff == 0) return;

        uint256 rewardPerBlock = uint256(sub) + fees;
        uint256 hashpriceSats =
            (HASHES_PER_100THS_PER_DAY * rewardPerBlock * (10 ** (DECIMALS - 8))) / (diff * (1 << 32));

        latestRoundDataCache = CachedRoundData({
            roundId: uint80(confirmed),
            startedAt: entry.timestamp,
            updatedAt: s.lastSubmittedAt,
            answer: int256(hashpriceSats)
        });

        emit HashpriceUpdated(confirmed, int256(hashpriceSats), fees);
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

    function _updateFees(uint64 fees, uint32 height) internal {
        uint256 idx = height % FEE_WINDOW;
        uint64 oldFee = _fees[idx];
        _fees[idx] = fees;
        // Uninitialized slots contain 0, so this is a no-op on first write.
        // Always subtracting eliminates the blockCount >= FEE_WINDOW guard that
        // caused reorgs to inflate feeRunningSum when the window wasn't yet full.
        feeRunningSum = feeRunningSum + uint256(fees) - uint256(oldFee);
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
        uint64 sub = BTCUtils.getBlockSubsidy(height);
        // Saturating: a miner may burn part of the subsidy (valid per Bitcoin consensus).
        // In that case fees are unknowable from the coinbase alone; treat as 0 rather than reverting.
        return totalOutput > sub ? totalOutput - sub : 0;
    }

    /// @dev Compute cumulative work for the incoming headers and the existing canonical chain
    ///      from the fork point. Must be called BEFORE _processHeader overwrites the ring buffer.
    ///      Only reads existing nBits for heights within the current canonical chain; slots
    ///      beyond chainHeight are uninitialized (nBits=0) and targetToWork(0)=type(uint256).max,
    ///      which would overflow the accumulator.
    function _snapshotForkWork(bytes calldata headers, uint32 ancestorHeight, uint256 count, uint32 chainHeight)
        internal
        view
        returns (uint256 oldWork, uint256 newWork)
    {
        uint256 existingCount = chainHeight > ancestorHeight ? uint256(chainHeight - ancestorHeight) : 0;
        for (uint256 i = 0; i < count; i++) {
            if (i < existingCount) {
                uint32 existingNBits = _blockAt(ancestorHeight + 1 + uint32(i)).nBits;
                oldWork += BTCUtils.targetToWork(BTCUtils.nBitsToTarget(existingNBits));
            }
            uint32 incomingNBits = BTCUtils.readUint32LE(headers, i * HEADER_SIZE + 72);
            newWork += BTCUtils.targetToWork(BTCUtils.nBitsToTarget(incomingNBits));
        }
    }

    function _validateDifficulty(uint32 height, uint32 newNBits, uint32 prevNBits, PackedState memory s) internal {
        if (height % RETARGET_INTERVAL == 0) {
            _verifyRetarget(height, newNBits, s);
            emit DifficultyChanged(height, newNBits, BTCUtils.nBitsToDifficulty(newNBits));
        } else {
            if (newNBits != prevNBits) revert UnexpectedDifficultyChange();
        }
    }

    function _verifyRetarget(uint32 height, uint32 newNBits, PackedState memory s) internal view {
        uint256 startTime = uint256(s.epochStartTimestamp);
        BlockEntry storage lastBlock = _blockAt(height - 1);
        if (lastBlock.height != height - 1) revert AncestorNotInBuffer();
        uint256 endTime = uint256(lastBlock.timestamp);

        uint256 actualTimespan = endTime - startTime;

        if (actualTimespan < EXPECTED_TIMESPAN / 4) actualTimespan = EXPECTED_TIMESPAN / 4;
        if (actualTimespan > EXPECTED_TIMESPAN * 4) actualTimespan = EXPECTED_TIMESPAN * 4;

        uint256 oldTarget = BTCUtils.nBitsToTarget(s.epochStartNBits);
        uint256 newTarget = BTCUtils.nBitsToTarget(newNBits);
        uint256 expectedTarget = oldTarget / EXPECTED_TIMESPAN * actualTimespan;

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
    function _validateTimestamp(uint32 timestamp) internal view {
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
