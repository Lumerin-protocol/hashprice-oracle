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
/// @dev Implements AggregatorV3Interface. Returns the price of 1 PH/s per day in BTC.
///      Average fees use a simple moving average over 144 blocks so the on-chain
///      hashprice is comparable to the Luxor hashprice index.
contract HashpriceBTC is AggregatorV3Interface {
    // ─── Constants ────────────────────────────────────────────────────

    /// @dev How many recent block headers we keep in storage to handle reorgs. Also the
    ///      deepest reorg the chain can recover from: past this the buffer holds nothing on
    ///      the canonical chain, so no ancestor can be found and the oracle is stuck for good.
    ///      Public so the keeper and indexer read it instead of hardcoding a copy.
    ///      MUST be a power of two — `_blockAt` derives the ring slot with a bitwise AND.
    uint32 public constant BLOCK_BUFFER_SIZE = 64;

    /// @dev Ring slot mask. Valid only while BLOCK_BUFFER_SIZE is a power of two.
    uint32 private constant BLOCK_BUFFER_MASK = BLOCK_BUFFER_SIZE - 1;

    /// @dev Number of blocks in the fee SMA,
    ///      matches Luxor index window.
    uint32 public constant FEE_WINDOW = 144;

    /// @dev Blocks behind tip reported by `latestRoundData`.
    ///      Depth=1 protects against the rare natural 1-block orphan without
    ///      adding meaningful lag. Mid-epoch shallow reorgs do not change nBits;
    ///      a heavier fork that re-crosses a retarget boundary can, but fees are
    ///      smoothed over a 144-block SMA so even a 2-block reorg moves the
    ///      reported hashprice by at most ~1.4%.
    uint32 public constant CONFIRMATION_DEPTH = 1;

    /// @dev Hashes in 1 PH/s over one day
    uint256 private constant HASHES_PER_1PHS_PER_DAY = 1e15 * 24 * 3600;

    /// @dev Decimals for the result of latestRoundData()
    uint8 private constant DECIMALS = 16;

    struct BlockEntry {
        bytes32 blockHash;
        uint32 timestamp;
        uint32 nBits;
        uint32 height;
        /// @dev Fee that left the 144-block window when this block was appended. A reorg uses
        ///      it to advance the restored ancestor window along the replacement fork.
        uint64 evictedFee;
        /// @dev Running fee sum immediately after this block. The maximum is
        ///      FEE_WINDOW * type(uint64).max < 2^72, so uint96 is ample.
        uint96 feeRunningSum;
    }

    /// @dev Exactly 8×uint32 = 32 bytes (one storage slot). Do not add fields without
    ///      accepting a second SLOAD/SSTORE on every submission.
    struct PackedState {
        uint32 chainHeight;
        uint32 blockCount;
        uint32 epochStartTimestamp;
        uint32 epochStartNBits;
        uint32 lastSubmittedAt;
        /// @dev Height of the first block of the current difficulty epoch (last retarget height).
        uint32 epochStartHeight;
        /// @dev Epoch-start values from before the last on-chain retarget; restored when a
        ///      reorg forks below `epochStartHeight`. Until the first on-chain retarget these
        ///      equal the constructor's current-epoch values — safe because the ring buffer
        ///      never holds heights below the checkpoint, so restore cannot fire earlier.
        ///      One prior snapshot is enough: BLOCK_BUFFER_SIZE is far below RETARGET_INTERVAL,
        ///      so a fork can rewind across at most one retarget boundary.
        uint32 prevEpochStartTimestamp;
        uint32 prevEpochStartNBits;
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
    /// @dev Fires once per header inside `_processHeader`, so a batch of N headers produces N events
    ///      in ascending height order. Carries every per-block field an indexer needs, so the
    ///      mapping never has to read the ring buffer back through `getBlockFromTip` — which would
    ///      cap it at BLOCK_BUFFER_SIZE blocks behind the tip and tie it to an archive node.
    /// @param blockHash     dSHA-256 of the 80-byte header in internal byte order
    /// @param height        Bitcoin block height
    /// @param coinbaseValue Total coinbase output value in satoshis. Fees are
    ///        `coinbaseValue - getBlockSubsidy(height)` saturated at zero; the total is emitted
    ///        rather than the difference so a block that burns part of its subsidy — where the
    ///        fee figure saturates and loses information — stays fully readable off-chain.
    /// @param timestamp     Header nTime, for median time past and elapsed-time estimates
    /// @param nBits         Compact difficulty target, for difficulty and per-block work
    event BlockSubmitted(
        bytes32 indexed blockHash, uint32 indexed height, uint64 coinbaseValue, uint32 timestamp, uint32 nBits
    );

    /// @notice Emitted whenever an incoming fork replaces one or more blocks on the canonical chain.
    /// @dev Fires whenever the fork diverges below the current tip (`ancestorHeight < chainHeight`),
    ///      whether it ends higher or at the same height with strictly greater cumulative work.
    ///      A plain chain extension (`ancestorHeight == chainHeight`) never emits this event.
    ///
    ///      Emitted BEFORE any `BlockSubmitted` of the incoming chain. That ordering is load
    ///      bearing: it lets an indexer snapshot the blocks it is about to lose while its rows
    ///      for them are still intact. Emitted after the loop it would name blocks whose data
    ///      the indexer had already overwritten.
    /// @param newTip         Block hash of the incoming chain's tip
    /// @param newHeight      Bitcoin height of the new tip
    /// @param ancestorHeight Height of the common ancestor — the fork point
    /// @param oldTip         Block hash of the tip being replaced
    /// @param oldHeight      Bitcoin height of the tip being replaced; depth is `oldHeight - ancestorHeight`
    event ChainReorg(
        bytes32 indexed newTip, uint32 indexed newHeight, uint32 ancestorHeight, bytes32 oldTip, uint32 oldHeight
    );

    /// @notice Emitted whenever the confirmed hashprice is recomputed — once per accepted block.
    /// @dev A batch of N headers emits N of these, interleaved with `BlockSubmitted`, so its log
    ///      stream matches N sequential `submitBlock` calls. Reorg batches restore the ancestor's
    ///      fee-window snapshot before processing, so every replacement also emits a canonical
    ///      correction. Every event in a batch shares the transaction's `block.timestamp`, and
    ///      therefore the same `updatedAt`.
    /// @param confirmedHeight Bitcoin block height the hashprice is derived from
    /// @param hashprice       Price of 1 PH/s per day in satoshis (8 decimals = BTC)
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
    /// @dev `prevEpochStart*` are seeded to the current epoch (not the true previous one).
    ///      That is intentional: restore cannot run until after the first on-chain retarget
    ///      overwrites them, because no ancestor below `epochStartHeight` can appear in the
    ///      buffer before then (checkpoint height ≥ epochStartHeight).
    constructor(
        bytes32 blockHash,
        uint32 height,
        uint32 timestamp,
        uint32 nBits,
        uint32 _epochStartTimestamp,
        uint32 _epochStartNBits
    ) {
        BTCUtils.requireSha256Precompile();
        _setBlockAt(height, blockHash, timestamp, nBits, 0);
        chainTipHash = blockHash;
        uint32 epochStartHeight = height - (height % uint32(BTCUtils.RETARGET_INTERVAL));
        state = PackedState({
            chainHeight: height,
            blockCount: 0,
            epochStartTimestamp: _epochStartTimestamp,
            epochStartNBits: _epochStartNBits,
            lastSubmittedAt: 0,
            epochStartHeight: epochStartHeight,
            prevEpochStartTimestamp: _epochStartTimestamp,
            prevEpochStartNBits: _epochStartNBits
        });
    }

    /// @notice Returns a block entry relative to the current chain tip.
    /// @dev Useful for reorg handling: iterate from index 0 upward until you find
    ///      the last confirmed block that matches chain.
    /// @param index Offset from the tip (0 = tip, 1 = tip-1, etc.)
    function getBlockFromTip(uint8 index) external view returns (BlockEntry memory) {
        uint32 chainHeight = state.chainHeight;
        if (index >= BLOCK_BUFFER_SIZE || index >= chainHeight) revert InsufficientData();
        uint32 height = chainHeight - index;
        BlockEntry storage entry = _blockAt(height);
        // The index bound above is necessary but not sufficient: a slot within range can still
        // hold a stale entry if that height was never written. Fail loudly rather than return it.
        if (entry.height != height) revert AncestorNotInBuffer();
        return entry;
    }

    // ─── Block submission ─────────────────────────────────────────────

    /// @notice Submit a single block (header + coinbase proof). Steady-state path.
    /// @param header Raw 80-byte Bitcoin block header
    /// @param coinbaseTx Non-witness serialized coinbase transaction
    /// @param merkleProof Merkle sibling hashes from coinbase leaf to root
    function submitBlock(bytes calldata header, bytes calldata coinbaseTx, bytes32[] calldata merkleProof) external {
        _validateHeaderLength(header);
        PackedState memory s = state;

        BlockEntry memory tip = BlockEntry({
            blockHash: chainTipHash,
            timestamp: 0,
            nBits: _blockAt(s.chainHeight).nBits,
            height: s.chainHeight,
            evictedFee: 0,
            feeRunningSum: 0
        });

        s.lastSubmittedAt = uint32(block.timestamp);
        _processHeader(header, coinbaseTx, merkleProof, tip, s, false);
        s.blockCount++;
        s.chainHeight = tip.height;

        chainTipHash = tip.blockHash;
        state = s;

        CachedRoundData memory round = _computeAndEmitHashprice(s);
        if (round.roundId != 0) latestRoundDataCache = round;
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
        uint256 count = headers.length / BTCUtils.HEADER_SIZE;
        if (coinbaseTxs.length != count || merkleProofs.length != count) {
            revert ArrayLengthMismatch();
        }
        BlockEntry memory tip = _blockAt(ancestorHeight);
        if (tip.height != ancestorHeight) revert AncestorNotInBuffer();

        PackedState memory s = state;
        uint32 oldHeight = s.chainHeight;
        bool isReorg = ancestorHeight < oldHeight;

        _authorizeFork(headers, ancestorHeight, count, oldHeight);

        if (isReorg) {
            // Restore the exact canonical fee window at the fork point. blockCount tracks the
            // number of post-checkpoint canonical blocks, so rewinding it by the displaced depth
            // makes every replacement advance the denominator exactly like a normal append.
            feeRunningSum = uint256(tip.feeRunningSum);
            s.blockCount -= oldHeight - ancestorHeight;
        }

        // A reorg that forks below the last retarget must re-verify that retarget against
        // the previous epoch's start clock, not the tip's already-updated values.
        // epochStartHeight is always ≥ RETARGET_INTERVAL once a retarget has occurred (or 0
        // from the constructor, in which case this branch is unreachable).
        if (ancestorHeight < s.epochStartHeight) {
            s.epochStartTimestamp = s.prevEpochStartTimestamp;
            s.epochStartNBits = s.prevEpochStartNBits;
            s.epochStartHeight -= uint32(BTCUtils.RETARGET_INTERVAL);
        }

        s.lastSubmittedAt = uint32(block.timestamp);

        // Advance blockCount and hashprice per header. Only the cache write is hoisted out —
        // intermediate rounds are emitted, not stored.
        CachedRoundData memory round;
        for (uint256 i = 0; i < count; i++) {
            bool replacing = tip.height < oldHeight;
            _processHeader(BTCUtils.sliceHeaders(headers, i), coinbaseTxs[i], merkleProofs[i], tip, s, replacing);
            s.blockCount++;
            s.chainHeight = tip.height;

            CachedRoundData memory c = _computeAndEmitHashprice(s);
            if (c.roundId != 0) round = c;
        }

        chainTipHash = tip.blockHash;
        state = s;

        if (round.roundId != 0) latestRoundDataCache = round;
    }

    /// @dev Decide whether an incoming chain may replace the canonical one, and announce it.
    ///      Runs BEFORE any header is validated: every input is known up front — the final
    ///      height is `ancestorHeight + count`, and fork work comes from the headers' own nBits
    ///      — so a fork that cannot win reverts without paying for PoW, retarget and merkle
    ///      verification of `count` headers.
    ///
    ///      A plain extension replaces nothing and returns immediately; a slot only ever holds
    ///      a height that was accepted onto the chain, so the caller's buffer check guarantees
    ///      `ancestorHeight <= oldHeight` and the remainder of this function is exactly the
    ///      reorg path.
    ///
    ///      Comparing work rather than length is Bitcoin's actual rule. Length alone is
    ///      equivalent within an epoch, where nBits is constant, but two forks crossing the same
    ///      retarget height are each validated against their own time(H-1) and can legitimately
    ///      carry different targets — so a longer fork can be lighter. Trusting unvalidated
    ///      calldata nBits here is safe: a header claiming the wrong difficulty is rejected by
    ///      _validateDifficulty and one that does not meet its claimed target by _validateWork,
    ///      so any header that survives the loop earned the weight counted for it. If the loop
    ///      does revert, the ChainReorg log is discarded with it.
    function _authorizeFork(bytes calldata headers, uint32 ancestorHeight, uint256 count, uint32 oldHeight) internal {
        if (ancestorHeight == oldHeight) return;

        uint32 newHeight = ancestorHeight + uint32(count);
        if (newHeight < oldHeight) revert NotHeaviestChain();

        // Must read the ring buffer before _processHeader overwrites it: reading afterwards
        // returns the incoming fork's own nBits and makes oldWork == newWork (the H-1 regression).
        (uint256 oldWork, uint256 newWork) = _snapshotForkWork(headers, ancestorHeight, count, oldHeight);
        if (newWork <= oldWork) revert NotHeaviestChain();

        emit ChainReorg(
            BTCUtils.hash256View(BTCUtils.sliceHeaders(headers, count - 1)),
            newHeight,
            ancestorHeight,
            chainTipHash,
            oldHeight
        );
    }

    /// @dev Validate and append one header onto `tip`. Mutates `tip` to the accepted block.
    function _processHeader(
        bytes calldata header,
        bytes calldata coinbaseTx,
        bytes32[] calldata merkleProof,
        BlockEntry memory tip,
        PackedState memory s,
        bool replacing
    ) internal {
        BTCUtils.HeaderInfo memory incoming = BTCUtils.parseHeader(header);
        _validateChainLinkage(incoming.prevBlockHash, tip.blockHash);

        uint256 target = BTCUtils.nBitsToTarget(incoming.nBits);
        bytes32 blockHash = BTCUtils.hash256View(header);
        uint32 newHeight = tip.height + 1;

        _validateWork(blockHash, target);
        _validateTimestamp(incoming.timestamp);
        _validateDifficulty(tip, incoming, newHeight, s);

        (uint64 fees, uint64 coinbaseValue) =
            _verifyCoinbaseAndExtractFees(newHeight, incoming.merkleRoot, coinbaseTx, merkleProof);

        uint64 evictedFee = _updateFees(fees, newHeight, s.blockCount, replacing);
        _setBlockAt(newHeight, blockHash, incoming.timestamp, incoming.nBits, evictedFee);

        tip.blockHash = blockHash;
        tip.nBits = incoming.nBits;
        tip.height = newHeight;
        tip.timestamp = incoming.timestamp;

        emit BlockSubmitted(blockHash, newHeight, coinbaseValue, incoming.timestamp, incoming.nBits);
    }

    // ─── AggregatorV3Interface ────────────────────────────────────────

    function decimals() public pure returns (uint8) {
        return DECIMALS;
    }

    function description() external pure returns (string memory) {
        return "The price of 1 PH/s per day in BTC";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NotImplemented();
    }

    /// @notice Returns the latest hashprice of 1 PH/s per day in satoshis
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
        return _averageFees(s);
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

    /// @dev Recompute the hashprice for the height confirmed by `s`, emit `HashpriceUpdated`,
    ///      and return the round data WITHOUT writing it. Callers persist the last round once,
    ///      so a batch pays a single cache SSTORE while still emitting one event per block.
    ///      Must be called after _blocks and feeRunningSum have been written to storage, and
    ///      after `s.chainHeight`, `s.blockCount` and `s.lastSubmittedAt` reflect this block.
    /// @return c Round data, or a zeroed struct when there is nothing to report. `roundId == 0`
    ///         is the same "no data" sentinel `latestRoundData` already uses; a real Bitcoin
    ///         height is never zero.
    function _computeAndEmitHashprice(PackedState memory s) internal virtual returns (CachedRoundData memory c) {
        if (s.chainHeight < CONFIRMATION_DEPTH) return c;

        uint32 confirmed = s.chainHeight - CONFIRMATION_DEPTH;
        BlockEntry storage entry = _blockAt(confirmed);
        if (entry.height != confirmed) return c;

        uint256 diff = BTCUtils.nBitsToDifficulty(entry.nBits);
        if (diff == 0) return c;

        uint64 sub = BTCUtils.getBlockSubsidy(confirmed);

        uint256 fees = _averageFees(s);

        uint256 rewardPerBlock = uint256(sub) + fees;
        uint256 hashpriceSats =
            (HASHES_PER_1PHS_PER_DAY * rewardPerBlock * (10 ** (DECIMALS - 8))) / (diff * (1 << 32));

        c = CachedRoundData({
            roundId: uint80(confirmed),
            startedAt: entry.timestamp,
            updatedAt: s.lastSubmittedAt,
            answer: int256(hashpriceSats)
        });

        emit HashpriceUpdated(confirmed, int256(hashpriceSats), fees);
    }

    /// @dev Read a block entry by height. The slot for a given height is
    ///      `height % BLOCK_BUFFER_SIZE`, derived cheaply via bitwise AND since the buffer size
    ///      is a power of two. Callers must check `entry.height == height` before trusting the
    ///      result — a slot may contain a stale entry from BLOCK_BUFFER_SIZE blocks ago.
    function _blockAt(uint32 height) internal view returns (BlockEntry storage) {
        return _blocks[height & BLOCK_BUFFER_MASK];
    }

    /// @dev Write a block entry at the slot for `height`, evicting whatever was there before.
    ///      Because the buffer wraps, entries older than BLOCK_BUFFER_SIZE blocks are silently
    ///      overwritten — intentional, and what bounds storage to a fixed number of slots.
    function _setBlockAt(uint32 height, bytes32 blockHash, uint32 timestamp, uint32 nBits, uint64 evictedFee)
        internal
    {
        _blocks[height & BLOCK_BUFFER_MASK] = BlockEntry({
            blockHash: blockHash,
            timestamp: timestamp,
            nBits: nBits,
            height: height,
            evictedFee: evictedFee,
            feeRunningSum: uint96(feeRunningSum)
        });
    }

    /// @dev Append one fee to the restored/current canonical window and return the fee evicted
    ///      from its 144-block tail. For a replacement, the fee ring's destination still holds
    ///      the losing fork's fee, so the displaced block's snapshot supplies the true outgoing
    ///      canonical fee instead.
    function _updateFees(uint64 fees, uint32 height, uint32 blockCount, bool replacing)
        internal
        returns (uint64 evictedFee)
    {
        uint256 idx = height % FEE_WINDOW;
        if (blockCount >= FEE_WINDOW) {
            evictedFee = replacing ? _blockAt(height).evictedFee : _fees[idx];
        }
        _fees[idx] = fees;
        feeRunningSum = feeRunningSum + uint256(fees) - uint256(evictedFee);
    }

    function _averageFees(PackedState memory s) internal view returns (uint256) {
        if (s.blockCount >= FEE_WINDOW) return feeRunningSum / FEE_WINDOW;
        if (s.blockCount > 0) return feeRunningSum / s.blockCount;
        return 0;
    }

    /// @return fees Coinbase total minus subsidy, saturated at zero — what feeds the SMA.
    /// @return coinbaseValue The unsaturated total, which `BlockSubmitted` carries so the
    ///         subsidy-burn case stays recoverable off-chain.
    function _verifyCoinbaseAndExtractFees(
        uint32 height,
        bytes32 expectedRoot,
        bytes calldata coinbaseTx,
        bytes32[] calldata merkleProof
    ) internal view returns (uint64 fees, uint64 coinbaseValue) {
        bytes32 current = BTCUtils.hash256View(coinbaseTx);

        // Coinbase is always at index 0, so it is the left node at every level of the tree.
        for (uint256 i = 0; i < merkleProof.length; i++) {
            current = BTCUtils.hash256Pair(current, merkleProof[i]);
        }
        if (current != expectedRoot) revert InvalidMerkleProof();

        coinbaseValue = BTCUtils.parseCoinbaseOutputValue(coinbaseTx);
        uint64 sub = BTCUtils.getBlockSubsidy(height);
        // Saturating: a miner may burn part of the subsidy (valid per Bitcoin consensus).
        // In that case fees are unknowable from the coinbase alone; treat as 0 rather than reverting.
        fees = coinbaseValue > sub ? coinbaseValue - sub : 0;
    }

    /// @dev Compute cumulative work for the incoming headers and the existing canonical chain
    ///      from the fork point. Must be called BEFORE _processHeader overwrites the ring buffer.
    ///      Only reads existing nBits for heights within the current canonical chain; slots
    ///      beyond chainHeight are uninitialized (nBits=0) and targetToWork(0)=type(uint256).max,
    ///      which would overflow the accumulator.
    ///
    ///      Called only on the reorg path. A plain extension replaces nothing, so `existingCount`
    ///      would be 0 and the whole `newWork` accumulation discarded — pure waste on the only
    ///      path the keeper takes in steady state.
    ///
    ///      The stored reads are safe: `ancestorHeight` is known to be in the buffer, which
    ///      bounds `existingCount` to BLOCK_BUFFER_SIZE - 1, all of them valid recent slots.
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
            uint32 incomingNBits = BTCUtils.readUint32LE(headers, i * BTCUtils.HEADER_SIZE + 72);
            newWork += BTCUtils.targetToWork(BTCUtils.nBitsToTarget(incomingNBits));
        }
    }

    /// @param tip Parent tip before accepting the new block (provides previous nBits).
    /// @param incoming Parsed fields of the new header being validated.
    /// @param newHeight Height of the incoming block (`tip.height + 1`).
    function _validateDifficulty(
        BlockEntry memory tip,
        BTCUtils.HeaderInfo memory incoming,
        uint32 newHeight,
        PackedState memory s
    ) internal {
        if (newHeight % BTCUtils.RETARGET_INTERVAL == 0) {
            _verifyRetarget(newHeight, incoming, s);
            emit DifficultyChanged(newHeight, incoming.nBits, BTCUtils.nBitsToDifficulty(incoming.nBits));
        } else {
            if (incoming.nBits != tip.nBits) revert UnexpectedDifficultyChange();
        }
    }

    /// @dev At retarget height H: timespan is time(H-1) − time(epochStart), matching Bitcoin
    ///      Core (`GetNextWorkRequired`). The new epoch then starts at incoming block H, so
    ///      we store its timestamp/nBits (not H-1) for the next boundary.
    /// @param newHeight Retarget height H (multiple of RETARGET_INTERVAL).
    /// @param incoming Header of block H (first block of the new difficulty epoch).
    function _verifyRetarget(uint32 newHeight, BTCUtils.HeaderInfo memory incoming, PackedState memory s) internal view {
        uint256 epochStartTime = uint256(s.epochStartTimestamp);
        // Last block of the epoch that just ended (height H-1).
        BlockEntry storage prevEpochEnd = _blockAt(newHeight - 1);
        if (prevEpochEnd.height != newHeight - 1) revert AncestorNotInBuffer();
        uint256 epochEndTime = uint256(prevEpochEnd.timestamp);
        uint256 epochTimespan = BTCUtils.clampRetargetTimespan(epochStartTime, epochEndTime);

        uint256 oldTarget = BTCUtils.nBitsToTarget(s.epochStartNBits);
        uint256 newTarget = BTCUtils.nBitsToTarget(incoming.nBits);
        uint256 expectedTarget = BTCUtils.expectedRetargetTarget(oldTarget, epochTimespan);

        uint256 tolerance = expectedTarget / 1000;
        if (tolerance == 0) tolerance = 1;
        if (newTarget < expectedTarget - tolerance || newTarget > expectedTarget + tolerance) {
            revert InvalidRetarget();
        }

        // Incoming block H is the first block of the new epoch.
        s.prevEpochStartTimestamp = s.epochStartTimestamp;
        s.prevEpochStartNBits = s.epochStartNBits;
        s.epochStartTimestamp = incoming.timestamp;
        s.epochStartNBits = incoming.nBits;
        s.epochStartHeight = newHeight;
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
        if (timestamp > uint32(block.timestamp) + BTCUtils.MAX_FUTURE_BLOCK_TIME) revert InvalidTimestamp();
    }

    function _validateHeaderLength(bytes calldata header) internal pure {
        if (header.length != BTCUtils.HEADER_SIZE) revert InvalidHeaderLength();
    }

    function _validateHeadersLength(bytes calldata headers) internal pure {
        if (headers.length % BTCUtils.HEADER_SIZE != 0 || headers.length == 0) {
            revert InvalidHeaderLength();
        }
    }
}
