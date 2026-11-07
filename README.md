# Hashprice Oracle

Trustless on-chain Bitcoin hashprice oracle powered by Bitcoin SPV (Simplified Payment Verification) proofs. No trusted intermediary — anyone can permissionlessly submit Bitcoin block headers and coinbase merkle proofs directly to the contract.

## Overview

This repository contains:

- **Smart Contracts** (`/contracts`) — `HashpriceBTC` (BTC-denominated hashprice via SPV) and `HashpriceUSD` (USD-denominated, combines `HashpriceBTC` with a Chainlink BTC/USD feed). Both implement `AggregatorV3Interface`.
- **Keeper** (`/keeper`) — Automated bot that relays Bitcoin block headers and coinbase merkle proofs to the on-chain oracle, keeping the hashprice feed current.
- **Subgraph Indexer** (`/indexer`) — A Graph Protocol subgraph that indexes oracle updates and provides historical hashprice data with hourly/daily aggregations.

## Architecture

```
Bitcoin network
      │  block headers + coinbase merkle proofs
      ▼
  [ keeper ]  ──────────────────────────────────►  [ HashpriceBTC ]
                                                        │
                                          latestRoundData() → hashprice in BTC
                                                        │
                                                        ▼
                                                  [ HashpriceUSD ]
                                                        │  ▲
                                          latestRoundData() │
                                                        │  └─── [ Chainlink BTC/USD ]
                                                        │         (any AggregatorV3Interface)
                                                        ▼
                                          latestRoundData() → hashprice in USD
```

### HashpriceBTC

`HashpriceBTC` is a Bitcoin SPV contract — it stores Bitcoin block headers on-chain and verifies coinbase transactions via merkle proofs, without trusting any off-chain data source.

Each submitted block provides:

- An **80-byte block header**, from which the contract extracts difficulty target, timestamp, and previous block hash, and verifies proof-of-work
- A **coinbase merkle proof**, which proves the coinbase transaction is the first transaction in that block

From the verified coinbase (block subsidy + fees) and the on-chain difficulty, the contract computes the hashprice — the expected revenue per petahash per day — using a 144-block Simple Moving Average over fees, like the [Luxor hashprice index](https://luxor.tech/hashprice). Each block's fee enters that average capped at 4× the current average (see below).

#### Differences from the Luxor hashprice index

Luxor computes its index from a full Bitcoin node and averages the 144-block fees after dropping those at or below the 5th and at or above the 95th percentile. `HashpriceBTC` differs in how it keeps outliers out:

- **Fee cap instead of a trimmed mean.** The contract only sees the header and the coinbase, so it cannot tell a real fee from a consensus-invalid coinbase (one Bitcoin nodes reject, which Luxor never sees) or a fee a miner pays to itself. Each block's fee therefore counts at most `FEE_CAP_MULTIPLIER` (4) × the window's current average, with a floor of `MIN_FEE_CAP` (0.1 BTC). This keeps the average a constant-cost running sum; a trimmed mean would need the window re-sorted on every block.
- **Effect on the value.** In normal conditions the two agree closely: on April 2026 mainnet blocks the cap clips nothing, while the trim lowers hashprice by about 0.04%. A single 1,000 BTC fake fee moves the capped value by about 0.02%. A sudden, sustained fee surge enters the capped average more slowly: a 20× jump that stays is under-counted by up to about 2.2% of hashprice and catches up within about 200 blocks.
- **Repeated outliers.** The trim drops only 8 blocks per window, so a miner with more than that many blocks a day counts in full. The cap bounds every block: a miner with 10% of the blocks paying itself 50 BTC in each lifts hashprice by about 0.26%. It can only ratchet the average up without limit with more than a quarter of the blocks.

Key properties:

- **Permissionless** — any address can submit headers and proofs; no owner, no admin key
- **Trustless** — the contract rejects any submission that fails PoW or merkle verification; a malicious keeper cannot corrupt the feed
- **Reorg-aware** — `submitBlocks()` handles chain reorganizations by accepting a new chain of headers that replaces the current tip
- **Chainlink-compatible** — implements `AggregatorV3Interface`; output is 1 PH/s per day priced in BTC (16 decimals)

**Why SPV?** SPV verification requires only 80-byte block headers and a merkle path — no full node, no trusted oracle, no multisig. The same primitive underpins Bitcoin light clients and cross-chain bridges like BTC Relay.

For a detailed breakdown of every validation check — what is included, what is deliberately excluded, and why — see [docs/BLOCK_VALIDATION.md](docs/BLOCK_VALIDATION.md).

### HashpriceUSD

`HashpriceUSD` is a thin aggregator contract that combines two `AggregatorV3Interface` feeds to produce a USD-denominated hashprice:

```
hashprice (USD) = hashprice (BTC)  ×  BTC/USD price
```

It accepts any `AggregatorV3Interface`-compatible BTC/USD feed at deploy time (e.g. Chainlink on mainnet, a custom feed on other networks), making it chain-agnostic. Staleness semantics are conservative: `updatedAt` reflects the older of the two upstream feeds, so consumers checking staleness always see the bottleneck.

Both contracts implement `AggregatorV3Interface`, so they are drop-in compatible with any protocol that reads Chainlink price feeds.

### HashpriceGlideUSD

The index drops about half in the block that halves the subsidy, a step known years ahead.
`HashpriceGlideUSD` reads `HashpriceUSD` (and `HashpriceBTC` through it) and gives venues prices
with that scheduled step taken out, leaving the index itself unchanged:

- `postHalvingPrice()`: the index × (subsidy after the next halving + fees) / (subsidy + fees),
  using the live 144-block fee average. At the halving block the new index equals it up to one
  block's change in that average.
- `glidePrice()`: the perps reference. The index until `GLIDE_BLOCKS + GLIDE_END_BLOCKS` blocks
  (1,008 + 144, about 8 days) before the halving, then linear by block down to
  `postHalvingPrice()`, reached 144 blocks before it; the index again once the halving block is
  relayed. The contract's own `latestRoundData()` answers it, with `HashpriceUSD`'s round id and
  timestamps, so perps reads it as its oracle.
- `markRangeAt(expiry)` / `markRangesAt(expiries)`: the futures marks `(low, high, updatedAt)`.
  Dates settling before `halvingEta()` − w are at the index, after `halvingEta()` + w at
  `postHalvingPrice()`, and within the window at both (`low` post-halving, `high` the index);
  w = max(4 days, 10% of the time to the estimate). Venues value longs at `low`, shorts at `high`.

Only the subsidy schedule is applied; fees, difficulty and BTC/USD move every price in the same
block. The next halving is recomputed from the oracle height, so later halvings need no redeploy.
Deploy with `scripts/deploy-hashprice-glide-usd.ts` (`HASHPRICE_USD_ADDRESS`).

## Keeper

The keeper monitors the on-chain oracle height against the Bitcoin tip and submits missing blocks as a batch. It is runtime-agnostic and ships adapters for Node.js, AWS Lambda, and Cloudflare Workers. See [`keeper/README.md`](keeper/README.md) for setup and configuration.

## Quick Start

### Contracts

```bash
cd contracts
pnpm install
pnpm test
pnpm compile
```

### Keeper

```bash
cd keeper
pnpm install
cp .env.example .env
# fill in .env
pnpm dev
```

### Indexer

```bash
cd indexer
yarn install
# Configure .env from .env.example
yarn codegen
yarn build
```

### Seed JSON (local history dump)

Regenerate `contracts/seed/` with one command — see [`indexer/SEED.md`](indexer/SEED.md):

```bash
cd indexer
SEED_DAYS=30 pnpm seed:generate
```

## Gas Costs

Current gas numbers are tracked in [`gas-benchmark.md`](./contracts/gas-benchmark.md) and regenerated by running the gas benchmark test:

```bash
cd contracts
npx hardhat test tests/HashpriceBTC/gas-benchmark.test.ts
```

## License

MIT
