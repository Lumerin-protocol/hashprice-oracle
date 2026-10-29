# Gas Benchmark — HashpriceBTC

_Last updated: 2026-10-29_

## `submitBlock` — one-by-one over 155 real mainnet blocks

| Metric | Gas |
|--------|----:|
| Average (all 155 blocks) | 131,449 |
| Average cold (first 144 blocks, writing fee window) | 132,935 |
| Average warm (last 11 blocks, steady state) | 111,999 |

## `submitBlocks` — same 155 blocks, swept over batch size

The keeper uses `submitBlock` for a single plain extension and `submitBlocks` for
backlogs and reorgs. The `size = 1` row isolates the batch path's floor; larger batches
amortise the 21,000 intrinsic fee and the single hashprice cache write across more blocks.

| Batch size | Transactions | Total gas | Gas per block |
|-----------:|-------------:|----------:|--------------:|
| 1 | 155 | 21,082,022 | 136,013 |
| 5 | 31 | 13,879,322 | 89,544 |
| 10 | 16 | 13,024,937 | 84,032 |
| 25 | 7 | 12,495,306 | 80,615 |
| 50 | 4 | 12,335,793 | 79,586 |

## `latestRoundData` — read-only call

| Metric | Gas |
|--------|----:|
| Estimate | 26,003 |

## Hashprice at benchmark tip

| Value |
|-------|
| 4547355170565 sats / 45473.55170565 BTC per 1 PH/s/day |
