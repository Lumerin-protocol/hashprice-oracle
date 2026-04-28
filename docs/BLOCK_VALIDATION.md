# Block Validation in HashpriceBTC

How the oracle ensures every submitted Bitcoin block is authentic, and what checks are worth their gas cost.

## Confirmation depth

`latestRoundData()` does not report the tip block — it reports the block at `chainHeight - CONFIRMATION_DEPTH` (currently 6). This means hashprice is always derived from a block with at least 6 confirmations, reducing exposure to shallow reorgs affecting the reported value.

## Validation layers

### 1. Proof-of-Work — ~200 gas — INCLUDED

The block header is double-SHA256 hashed and the result must be below the difficulty target encoded in `nBits`.

This is the oracle's strongest guarantee. A valid PoW proves that an enormous amount of energy was spent producing the header. At current difficulty, fabricating a single block costs billions of dollars. No other check provides comparable security per gas spent.

### 2. Chain continuity — ~2,100 gas — INCLUDED

Each block's `prevBlockHash` must reference the oracle's current chain tip. This prevents submitting disconnected or orphan blocks.

Without this check, an attacker could submit any valid-PoW block from any point in Bitcoin's history and the oracle would accept it, corrupting the chain state.

### 3. Difficulty retarget verification — ~500 gas (amortized) — INCLUDED

At every 2016-block boundary, the oracle verifies the new difficulty target matches the expected value given the previous epoch's elapsed time. The elapsed timespan is clamped to [1/4, 4x] of the expected 2-week window, matching Bitcoin's rule.

A 0.1% tolerance (`expectedTarget / 1000`) is applied to the expected target to absorb integer rounding that occurs when Bitcoin nodes truncate the target to the `nBits` compact encoding. Submissions outside that tolerance revert with `InvalidRetarget`.

Only triggers once per ~2016 blocks, so amortized cost is negligible. Prevents an attacker from submitting a fork with artificially low difficulty (which would make PoW cheap to fabricate).

### 4. Coinbase Merkle proof — ~1,000–3,000 gas — INCLUDED

The coinbase transaction hash is walked up through the Merkle tree and compared against the header's `merkleRoot`. This proves the coinbase transaction is actually part of the block.

The oracle extracts fee data from the coinbase. Without this proof, an attacker could submit any arbitrary transaction data alongside a valid header and inflate or deflate the reported fees.

Fees are computed as `totalCoinbaseOutput - blockSubsidy`. A miner can technically burn part of the subsidy (valid per Bitcoin consensus), in which case `totalCoinbaseOutput < subsidy` and fees are reported as 0 rather than reverting. This is an intentional conservative choice: the hashprice is slightly underestimated for that block rather than the submission failing.

### 5. Future timestamp cap — ~3 gas — INCLUDED

Block timestamps cannot exceed the current EVM block time by more than 2 hours (`MAX_FUTURE_BLOCK_TIME` in `HashpriceBTC.sol`, matching Bitcoin's forward-looking limit).

Nearly free (a single comparison, no storage). Prevents submitting blocks with timestamps far in the future, which could manipulate the difficulty retarget timespan calculation.

### 6. Median Time Past (MTP) — ~23,100 gas — EXCLUDED

Bitcoin requires each block's `nTime` to be **strictly greater than** the median of the **previous 11 blocks'** timestamps (not "greater than the parent"). That rule stops miners from pushing the median backward to stretch or compress measured time across difficulty epochs.

**Why we skip re-implementing MTP on-chain**

1. **Gas vs marginal gain** — A faithful MTP check needs the timestamps of heights `h-1 … h-11`, each loaded from storage and checked for **height correctness** (otherwise a ring-buffer slot could hold a stale block from 32+ heights ago). That is on the order of **11 SLOADs per header** (~23,100 gas cold) plus arithmetic, on **every** submission. For this oracle, that is a large recurring cost for a rule that mainly reinforces ordering of **past** times relative to recent history.

2. **Different trust boundary** — Bitcoin nodes enforce MTP against the **longest valid chain they track**. This contract only sees **what relayers submit**. We already bind headers with **PoW**, **chain linkage**, **retarget math** at 2016 boundaries, and the **2-hour future cap**. MTP would not add a comparable guarantee unless we also stored a much longer, fully ordered history (beyond the 32-block ring buffer's intent).

3. **What we still protect** — **Retarget verification** uses the epoch's first and last block timestamps from **stored** entries; bogus timestamps that would break Bitcoin's difficulty rules still fail `_verifyRetarget` when they disagree with `nBits`. The **future cap** mirrors Bitcoin's "not too far in the future" rule (using `block.timestamp` instead of network-adjusted time). We **do not** replicate MTP's **lower bound** on `nTime`; that is an explicit trade-off to keep steady-state gas low.

4. **Operational assumption** — In the intended deployment, headers come from real Bitcoin blocks that **already satisfied MTP** on the main chain. On-chain MTP would largely **re-check** that history at high cost; the gas estimate treats it as redundant for that model.

**Summary:** MTP is excluded because it is **expensive on-chain**, **awkward to pair with a small ring buffer** without extra storage, and **largely redundant** with PoW + retarget + future cap under the usual "honest Bitcoin headers" relay assumption—at the cost of **not** enforcing Bitcoin's past-timestamp floor inside the contract.

### 7. Duplicate block rejection — ~2,100 gas — EXCLUDED

The contract uses a 32-slot ring buffer where old entries are naturally overwritten rather than tracking seen hashes in a mapping.

**Excluded because:**

- Submitting the same block twice would fail the chain continuity check (`prevHash != chainTip`) unless the oracle is at the exact same height — in which case overwriting the ring buffer slot with identical data is harmless.
- Saves one cold SLOAD per block.

### 8. Cumulative work tracking — ~5,000 gas — EXCLUDED

Cumulative work is computed on-the-fly from the submitted headers during `submitBlocks` reorg comparison, snapshotting both chains' work before any ring-buffer slots are overwritten.

**Excluded because:**

- Cumulative work is only needed during reorgs, which are rare. Computing it from the submitted headers at reorg time avoids paying the storage cost on every single block.

### 9. Full transaction validation — N/A — EXCLUDED

The oracle does not validate any transactions beyond the coinbase.

**Excluded because:**

- The oracle's purpose is to extract fee and difficulty data for hashprice computation. It has no use for non-coinbase transaction data.

### 10. Block size / weight limits — N/A — EXCLUDED

Not checked.

**Excluded because:**

- The oracle only processes the 80-byte header and coinbase transaction. Block size is irrelevant to hashprice computation.

## Cost summary

| #   | Check                   | Gas            | Status       | Security value                          |
| --- | ----------------------- | -------------- | ------------ | --------------------------------------- |
| 1   | Proof-of-Work           | ~200           | Included     | Critical — primary defense              |
| 2   | Chain continuity        | ~2,100         | Included     | Critical — prevents orphan blocks       |
| 3   | Retarget verification   | ~500 amortized | Included     | High — prevents difficulty manipulation |
| 4   | Coinbase Merkle proof   | ~1,000–3,000   | Included     | High — authenticates fee data           |
| 5   | Future timestamp cap    | ~3             | Included     | Moderate — nearly free                  |
| 6   | Median Time Past        | ~23,100        | **Excluded** | Low — costly; ring-buffer awkward; PoW + retarget + future cap suffice for intended relay model |
| 7   | Duplicate rejection     | ~2,100         | **Excluded** | Low — covered by chain continuity       |
| 8   | Cumulative work storage | ~5,000         | **Excluded** | Low — computed on demand during reorgs  |
