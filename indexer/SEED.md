# Seed data generation

`pnpm seed:generate` rebuilds historical hashprice / BTC-USD JSON under `contracts/seed/` (and optionally syncs the UI seed dir). It orchestrates everything in one process — you do not start Hardhat or graph-node yourself.

## What it does

1. Starts a local Hardhat node (`0.0.0.0:8545`, Cancun hardfork)
2. Starts postgres + IPFS + graph-node via **Testcontainers**
3. Runs `seed-history` for the last `SEED_DAYS` of Bitcoin blocks + Base mainnet Chainlink BTC/USD rounds
4. Builds and deploys the hashprice subgraph to that graph-node
5. Waits until the subgraph catches the Hardhat tip
6. Dumps GraphQL collections to JSON (including hour/day candle aggregations)
7. Tears down containers and Hardhat

```text
SEED_DAYS → Bitcoin headers + Chainlink rounds
         → local contracts (Hardhat)
         → graph-node (Testcontainers)
         → contracts/seed/*.json
         → futures-marketplace/ui/src/seed/*.json  (if that path exists)
```

## Prerequisites

- Docker running (Testcontainers)
- Node 24.x / pnpm in `indexer/` and `contracts/`
- Repo-root `.env` with at least:
  - `BITCOIN_RPC_URL` — Bitcoin Core / Alchemy Bitcoin RPC

Chainlink history is **always** fetched from Base mainnet feed  
`0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` (`CHAIN_ID=8453`), regardless of your Sepolia deploy settings.

For the Base RPC, either:

- set `BASE_RPC_URL` or `CHAINLINK_RPC_URL` to a Base mainnet endpoint, or
- leave `ETHEREUM_RPC_URL` as an Alchemy `base-sepolia` URL — the script rewrites it to `base-mainnet`

## Usage

```bash
cd indexer
pnpm install   # once (includes testcontainers)

# Smoke test (~1 day of history)
SEED_DAYS=1 pnpm seed:generate

# Full window (default is 30 if SEED_DAYS unset)
SEED_DAYS=30 pnpm seed:generate
```

### Useful env overrides

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEED_DAYS` | `30` | Bitcoin/Chainlink lookback window |
| `BTC_FETCH_CONCURRENCY` | `24` | Parallel Bitcoin RPC fetches in `seed-history` |
| `BASE_RPC_URL` / `CHAINLINK_RPC_URL` | (derived) | Base mainnet RPC for Chainlink logs |
| `UI_SEED_DIR` | `../futures-marketplace/ui/src/seed` | Where to copy the 6 UI seed files; skipped if missing |
| `BTC_SEED_START` / `BTC_SEED_END` | cleared by the script | Do not set when using `SEED_DAYS` via `seed:generate` |

`SEED_DAYS` wins over a stale `BTC_SEED_START` in `.env` when set.

## Outputs

Written under [`contracts/seed/`](../contracts/seed/):

- `btcUsds.json`, `hashpriceBtcs.json`, `hashpriceUsds.json`
- `*-Candles-hour.json`, `*-Candles-day.json` (from graph-node `@aggregation`)

If `UI_SEED_DIR` exists, these six files are also copied there:

`btcUsds`, `btcUsdCandles-{hour,day}`, `hashpriceUsds`, `hashpriceUsdCandles-{hour,day}`

For the UI bundle, follow [`futures-marketplace/ui/src/seed/README.md`](../../futures-marketplace/ui/src/seed/README.md) (strip unused candle fields, minify).

## Caches (speed up reruns)

| Path | Contents |
| --- | --- |
| `contracts/.cache/btc-blocks/` | Per-height Bitcoin headers + coinbase proofs |
| `contracts/.cache/chainlink-rounds/` | Chunked Base mainnet `AnswerUpdated` logs |

First run for a new window is RPC-heavy; later runs reuse cache.

## Manual pieces (optional)

You normally do **not** need these; `seed:generate` wraps them.

```bash
# Hardhat only
cd contracts && pnpm exec hardhat node --hostname 0.0.0.0

# Replay history onto a running localhost node
cd contracts && SEED_DAYS=1 pnpm seed-history

# Dump from an already-running local subgraph
cd contracts && SUBGRAPH_URL=http://localhost:8000/subgraphs/name/hashprice pnpm dump-subgraph
```

Compose file used by Testcontainers: [`docker-compose.seed.yml`](./docker-compose.seed.yml).

## Troubleshooting

**Port 8545 in use** — stop any leftover `hardhat node`, then rerun.

**`phaseId` / no contract code** — Chainlink fetch is not on Base mainnet. Set `BASE_RPC_URL` to Base mainnet (or use an Alchemy URL the script can rewrite).

**Subgraph stuck at a low block / `gas limit … greater than the cap (16777216)`** — Hardhat must use `hardfork: "cancun"` (already set in `contracts/hardhat.config.ts` for the `node` network) so graph-node’s 50M `eth_call` is allowed. Restart Hardhat after config changes.

**Bitcoin fetch feels slow** — no artificial delay; raise `BTC_FETCH_CONCURRENCY` (e.g. `48`) if your Bitcoin RPC allows it.

**Docker / Testcontainers failures** — ensure Docker Desktop (or daemon) is running; the script tears down the compose project in `finally`.
