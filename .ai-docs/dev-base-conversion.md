# DEV Environment — Base Sepolia Migration Summary

**Date:** March 25, 2026
**Chain:** Base Sepolia (Chain ID `84532`)
**Explorer:** [https://base-sepolia.blockscout.com](https://base-sepolia.blockscout.com)
**Previous chain:** Arbitrum Sepolia (421614)

## MetaMask Setup

### Add Base Sepolia Network

Settings → Networks → Add Network → Add manually:


| Field              | Value                                 |
| ------------------ | ------------------------------------- |
| Network Name       | `Base Sepolia`                        |
| RPC URL            | `https://sepolia.base.org`            |
| Chain ID           | `84532`                               |
| Currency Symbol    | `ETH`                                 |
| Block Explorer URL | `https://base-sepolia.blockscout.com` |


Or visit [https://chainlist.org/chain/84532](https://chainlist.org/chain/84532) and click "Add to MetaMask".

### Import Mock USDC Token

Once on Base Sepolia, go to MetaMask → Import Tokens → Custom Token:


| Field                  | Value                                        |
| ---------------------- | -------------------------------------------- |
| Token Contract Address | `0xdd15eed84065a58c9e9ff9e95fb996be0fff22aa` |
| Token Symbol           | `USDC`                                       |
| Token Decimal          | `6`                                          |


> **Note:** This is a mock USDC deployed for DEV only — it is not real USDC.

## Contracts


| Contract           | Address                                      | Purpose                                |
| ------------------ | -------------------------------------------- | -------------------------------------- |
| HashrateOracle     | `0xf97a1bbfb5e061ef73dad8ebf25939d93639fb7f` | On-chain hashrate price feed           |
| BTCPriceOracleMock | `0x614dcafa33af0705c7b4a37667ef511f400f36d0` | Mock BTC/USD price feed                |
| Futures            | `0x56d8d4a03a0f34b93b86e0b7941aff29178d0479` | Hashprice futures CLOB                 |
| PerpsSimple        | `0x0d412BC34a48e434144687Aac03b9C593F5237B6` | Perpetuals CLOB                        |
| USDCMock           | `0xdd15eed84065a58c9e9ff9e95fb996be0fff22aa` | Mock USDC token (6 decimals)           |
| CloneFactory       | `0x998135c509b64083cd27ed976c1bcda35ab7a40b` | Spot marketplace factory (placeholder) |
| Multicall3         | `0xcA11bde05977b3631167028862bE2a173976CA11` | Standard multicall                     |


## Wallets


| Wallet                | Address                                      | Purpose                                                    | Funding Notes                                                                                                                                               |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oracle Updater        | `0x0eB467381abbC5B71f275DF0c8a4E0ED8561F46f` | Calls `setHashesForBTC` on HashrateOracle                  | Needs Base Sepolia ETH for gas                                                                                                                              |
| Market Maker (shared) | `0x4040eEEfc184c1382d708E6fA53685Bc22992B44` | Futures MM Lambda + Perps MM + Perps Keeper                | Needs ETH for gas. Futures margin must be deposited directly into the Futures contract. Perps MM auto-sweeps any free USDC in wallet into perps collateral. |


> **Important:** The Perps Market Maker auto-deposits ALL free USDC in the shared wallet into the perps contract as collateral (`NODE_ENV=production` in Docker image). To fund the Futures contract, either stop the Perps MM first or deposit directly into the Futures contract via the UI.

### Getting Base Sepolia ETH

Use the Base Sepolia faucet: [https://www.alchemy.com/faucets/base-sepolia](https://www.alchemy.com/faucets/base-sepolia)

## Subgraphs (Goldsky)

All subgraphs are hosted on Goldsky with public GraphQL endpoints (no API key needed for reads).


| Subgraph            | Endpoint                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| hpow-oracles     | `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/hpow-oracles/dev-latest/gn`     |
| hpow-futures     | `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/hpow-futures/dev-latest/gn`     |
| hpow-derivatives | `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/hpow-derivatives/dev-latest/gn` |


## Services


| Service                  | Type          | Schedule             | Status                                                        |
| ------------------------ | ------------- | -------------------- | ------------------------------------------------------------- |
| Oracle Updater           | Lambda        | Every 5 min          | Writing hashrate + BTC prices to HashrateOracle               |
| Futures Market Maker     | Lambda        | Every 5 min          | Quoting 5-level grid on Futures CLOB (FLOAT_AMOUNT: 800 USDC) |
| Perps Market Maker       | ECS (Fargate) | Continuous (3s tick) | Quoting 5-level grid on Perps CLOB                            |
| Perps Keeper             | ECS (Fargate) | Continuous (5s poll) | Liquidation bot watching perps positions                      |
| Subgraph Health Monitor  | Lambda        | Scheduled            | Monitors all 3 Goldsky subgraphs, emits CloudWatch metrics    |
| Oracle Staleness Checker | Lambda        | Scheduled            | Monitors HashrateOracle data freshness                        |
| Margin Call              | Lambda        | Scheduled            | Futures margin call processing                                |


## Key Config Changes from Arbitrum

- Block polling intervals reduced to **150 blocks** (~5 min on Base Sepolia's 2s blocks) vs 10,000 on Arbitrum
- Subgraph hosting moved from **The Graph → Goldsky**
- CI/CD pipelines updated to use `goldsky subgraph deploy` with conflict handling
- CloudWatch metrics renamed from `thegraph_`* → `subgraph_*`
- Alchemy RPC must have **Base Sepolia** network enabled

