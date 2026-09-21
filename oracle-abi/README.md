# @hashpower/oracle-abi

ABIs and deployment addresses for the Hashpower hashprice oracle contracts on Base.

Both oracles implement Chainlink's `AggregatorV3Interface` — read the live price with `latestRoundData()`:

| Contract | `answer` meaning | Decimals |
| --- | --- | --- |
| `HashpriceUSD` | 100 TH/s/day in USD | 8 |
| `HashpriceBTC` | 100 TH/s/day in satoshis | 8 |

## Usage

```ts
import { HashpriceUSDAbi } from "@hashpower/oracle-abi";
import deployments from "@hashpower/oracle-abi/deployments.json" with { type: "json" };

// "testnet" (Base Sepolia) or "mainnet" (Base)
const env = process.env.HASHPOWER_ENV ?? "testnet";
const { contracts } = deployments.environments[env];

const [, answer] = await client.readContract({
  address: contracts.HashpriceUSD,
  abi: HashpriceUSDAbi,
  functionName: "latestRoundData",
});
```

Raw JSON ABIs (for subgraphs and non-TypeScript consumers) are available under `@hashpower/oracle-abi/json/<Contract>.json`.

## Historical data

Query the oracles subgraph (URLs in `deployments.json` under `environments.<env>.subgraphs.oracles`) for hashprice history and candles.

## How this package is built

Contents are generated — do not edit by hand:

- `src/` is copied from `../contracts/abi` (the Hardhat codegen output, drift-checked in CI) by `scripts/build.mjs`, then compiled to `dist/`.
- `deployments.json` is the canonical address manifest for this repo; it is updated when contracts are (re)deployed.

Publishing happens automatically from CI when ABIs or the manifest change on `main` (see `.github/workflows/publish-oracle-abi.yml`).
