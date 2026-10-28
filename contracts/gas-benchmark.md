# Gas Benchmark — HashpriceBTC

_Last updated: 2026-10-28_

## `submitBlock` — one-by-one over 155 real mainnet blocks

| Metric | Gas |
|--------|----:|
| Average (all 155 blocks) | 122,436 |
| Average cold (first 144 blocks, writing fee window) | 123,398 |
| Average warm (last 11 blocks, steady state) | 109,838 |

## `latestRoundData` — read-only call

| Metric | Gas |
|--------|----:|
| Estimate | 25,957 |

## Hashprice at benchmark tip

| Value |
|-------|
| 4547355170565 sats / 45473.55170565 BTC per 1 PH/s/day |
