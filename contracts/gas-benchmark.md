# Gas Benchmark — HashpriceBTC

_Last updated: 2026-04-13_

## `submitBlock` — one-by-one over 155 real mainnet blocks

| Metric | Gas |
|--------|----:|
| Average (all 155 blocks) | 118,741 |
| Average cold (first 144 blocks, writing fee window) | 119,665 |
| Average warm (last 11 blocks, steady state) | 106,641 |

## `latestRoundData` — read-only call

| Metric | Gas |
|--------|----:|
| Estimate | 25,957 |

## Hashprice at benchmark tip

| Value |
|-------|
| 4547 sats / 0.00004547 BTC per 100 TH/s/day |
