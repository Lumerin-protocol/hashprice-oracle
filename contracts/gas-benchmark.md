# Gas Benchmark — HashpriceBTC

_Last updated: 2026-07-27_

## `submitBlock` — one-by-one over 155 real mainnet blocks

| Metric | Gas |
|--------|----:|
| Average (all 155 blocks) | 121,380 |
| Average cold (first 144 blocks, writing fee window) | 122,342 |
| Average warm (last 11 blocks, steady state) | 108,782 |

## `latestRoundData` — read-only call

| Metric | Gas |
|--------|----:|
| Estimate | 25,957 |

## Hashprice at benchmark tip

| Value |
|-------|
| 4547355170565 sats / 45473.55170565 BTC per 1 PH/s/day |
