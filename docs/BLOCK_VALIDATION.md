# Block Validation in HashpriceBTC

How the oracle ensures every submitted Bitcoin block is authentic, and what checks are worth their gas cost.

## Validation layers

### 1. Proof-of-Work — ~200 gas — INCLUDED

The block header is double-SHA256 hashed and the result must be below the difficulty target encoded in `nBits`.

This is the oracle's strongest guarantee. A valid PoW proves that an enormous amount of energy was spent producing the header. At current difficulty, fabricating a single block costs billions of dollars. No other check provides comparable security per gas spent.

### 2. Chain continuity — ~2,100 gas — INCLUDED

Each block's `prevBlockHash` must reference the oracle's current chain tip. This prevents submitting disconnected or orphan blocks.

Without this check, an attacker could submit any valid-PoW block from any point in Bitcoin's history and the oracle would accept it, corrupting the chain state.

### 3. Difficulty retarget verification — ~500 gas (amortized) — INCLUDED

At every 2016-block boundary, the oracle verifies the new difficulty target matches the expected value given the previous epoch's elapsed time. Clamped to [1/4, 4x] of the expected 2-week timespan, matching Bitcoin's rule.

Only triggers once per ~2016 blocks, so amortized cost is negligible. Prevents an attacker from submitting a fork with artificially low difficulty (which would make PoW cheap to fabricate).

### 4. Coinbase Merkle proof — ~1,000–3,000 gas — INCLUDED

The coinbase transaction hash is walked up through the Merkle tree and compared against the header's `merkleRoot`. This proves the coinbase transaction is actually part of the block.

The oracle extracts fee data from the coinbase. Without this proof, an attacker could submit any arbitrary transaction data alongside a valid header and inflate or deflate the reported fees.

### 5. Future timestamp cap — ~3 gas — INCLUDED

Block timestamps cannot exceed the current EVM block time by more than 2 hours.

<!-- double check if 2 hours in future is reasonable -->

Nearly free (a single comparison, no storage). Prevents submitting blocks with timestamps far in the future, which could manipulate the difficulty retarget timespan calculation.

### 6. Median Time Past (MTP) — ~23,100 gas — EXCLUDED

Bitcoin requires each block's timestamp to exceed the median of the previous 11 blocks. This costs 11 cold SLOADs × 2,100 gas = 23,100 gas per block (~15% of total cost).

**Excluded because:**

- Every block submitted to the oracle already passed Bitcoin's own MTP-11 rule. The oracle would be re-verifying what Bitcoin consensus already enforced.
- The attack it prevents (past-dating timestamps to manipulate retarget) requires mining a private fork with valid PoW — a multi-billion dollar attack — and `_verifyRetarget` independently catches the resulting difficulty anomaly.
- 23,100 gas is disproportionate to the marginal security it adds on top of PoW + retarget verification.

### 7. Duplicate block rejection — ~2,100 gas — EXCLUDED

V2's BTCRelay checked that each block hash hadn't been submitted before (mapping lookup). V3 uses a ring buffer where old entries are naturally overwritten.

**Excluded because:**

- Submitting the same block twice would fail the chain continuity check (`prevHash != chainTip`) unless the oracle is at the exact same height — in which case overwriting the ring buffer slot with identical data is harmless.
- Saves one cold SLOAD per block.

### 8. Cumulative work tracking — ~5,000 gas — EXCLUDED

V2 tracked cumulative work (sum of per-block work) in storage to compare fork heaviness. V3 computes work on-the-fly from headers during `submitBlocks` reorg comparison.

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
| 6   | Median Time Past        | ~23,100        | **Excluded** | Low — redundant with Bitcoin consensus  |
| 7   | Duplicate rejection     | ~2,100         | **Excluded** | Low — covered by chain continuity       |
| 8   | Cumulative work storage | ~5,000         | **Excluded** | Low — computed on demand during reorgs  |
