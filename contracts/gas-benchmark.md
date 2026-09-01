# Gas Benchmark — HashpriceBTC

_Last updated: 2026-08-27_

## `submitBlock` — one-by-one over 155 real mainnet blocks

| Metric | Gas |
|--------|----:|
| Average (all 155 blocks) | 129,911 |
| Average cold (first 144 blocks, writing fee window) | 131,394 |
| Average warm (last 11 blocks, steady state) | 110,506 |

## `submitBlocks` — same 155 blocks, swept over batch size

The keeper uses `submitBlock` for a single plain extension and `submitBlocks` for
backlogs and reorgs. The `size = 1` row isolates the batch path's floor; larger batches
amortise the 21,000 intrinsic fee and the single hashprice cache write across more blocks.

| Batch size | Transactions | Total gas | Gas per block |
|-----------:|-------------:|----------:|--------------:|
| 1 | 155 | 20,836,614 | 134,430 |
| 5 | 31 | 13,633,914 | 87,961 |
| 10 | 16 | 12,779,529 | 82,449 |
| 25 | 7 | 12,249,898 | 79,032 |
| 50 | 4 | 12,090,385 | 78,002 |

## `latestRoundData` — read-only call

| Metric | Gas |
|--------|----:|
| Estimate | 26,003 |

## Hashprice at benchmark tip

| Value |
|-------|
| 4547355170565 sats / 45473.55170565 BTC per 1 PH/s/day |
