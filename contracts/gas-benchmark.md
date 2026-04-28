# Gas Benchmark — HashpriceBTC

_Last updated: 2026-04-15_

## `submitBlock` — one-by-one over 155 real mainnet blocks

| Metric | Gas |
|--------|----:|
| Average (all 155 blocks) | 121,020 |
| Average cold (first 144 blocks, writing fee window) | 121,983 |
| Average warm (last 11 blocks, steady state) | 108,423 |

## `latestRoundData` — read-only call

| Metric | Gas |
|--------|----:|
| Estimate | 25,957 |

## Hashprice at benchmark tip

| Value |
|-------|
| 454735517056 sats / 4547.35517056 BTC per 100 TH/s/day |
