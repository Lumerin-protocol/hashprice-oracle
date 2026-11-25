# hashprice-keeper

Keeper bot that relays Bitcoin block headers and coinbase merkle proofs to the on-chain `HashpriceBTC` oracle, keeping the trustless hashprice feed up to date.

The keeper is the off-chain counterpart to the `HashpriceBTC` SPV contract: it fetches raw block data from Bitcoin and submits it on-chain, where the contract independently verifies everything via Bitcoin SPV (Simplified Payment Verification). No trust in the keeper is required — a malicious or buggy keeper cannot corrupt the oracle because the contract rejects any submission that fails header PoW or merkle proof verification.

## Architecture

```
src/
├── abi.ts              # HashpriceBTC contract ABI (read/write subset)
├── config.ts           # Environment-based configuration
├── core/
│   ├── bitcoin.ts      # Bitcoin data providers (Blockstream API / Bitcoin Core RPC)
│   ├── keeper.ts       # Relay: plans the next submission, tracks it until mined
│   ├── oracle.ts       # On-chain oracle reads and tx building via viem
│   └── txSend.ts       # Fees, gas, replacement and error handling for relay txs
└── adapters/
    ├── btcBlocks.ts    # Alchemy Bitcoin WebSocket new-block subscription
    ├── node.ts         # Always-on service: block-triggered ticks, /health
    └── lambda.ts       # AWS Lambda handler (single invocation)
```

All business logic lives in `src/core/` and depends only on `fetch()`, `viem`, and an injected SHA-256 function. The adapters wire up runtime-specific concerns (crypto, logging transport, entry point).

### Service mode

`node.ts` runs the relay as the ECS service `svc-oracle-relay-<env>`, which replaces the `futures-oracle-update-v2` Lambda:

- A tick runs at startup, on every new Bitcoin block from the WebSocket subscription, and on a fallback poll (`KEEPER_POLL_INTERVAL_MS`). Ticks never overlap. Without `BITCOIN_WS_URL` (or an Alchemy `BITCOIN_RPC_URL` to derive it from), the service only polls. The subscription reconnects with backoff and warns after 2 minutes down.
- While a tx is pending, the relay checks it on every Base block. After 10 unmined Base blocks it rebuilds to the current Bitcoin tip and replaces the tx at the same nonce with higher fees, up to a 1 gwei tip and 0.002 ETH per tx.
- `GET /health` on `HEALTH_PORT` returns 503 when no tick has completed for 3 minutes; the ECS health check then replaces the task.
- Logs are pino JSON with an `event` field (`tick`, `tick_error`, `relayed`, `tx_unmined`, `fee_bump`) that the CloudWatch metric filters in `.bedrock/.terragrunt/71_metric_filters.tf` read.

`deploy-keeper.yml` builds `ghcr.io/lumerin-protocol/hashprice-oracle-keeper` and deploys it with the env from `config/<env>.env`. `PRIVATE_KEY`, `ETHEREUM_RPC_URL` and `BITCOIN_RPC_URL` come from the Lambda's secret `oracle-lambda-secrets-v3-<env>`.

## Setup

```bash
cd keeper
pnpm install
cp .env.example .env
# fill in .env
```

## Running

### Node.js (development)

```bash
pnpm dev          # --watch mode with pino-pretty
pnpm start        # production
```

### Docker

```bash
docker build -t hashprice-keeper .
docker run -d --name keeper --env-file .env -p 8080:8080 hashprice-keeper
curl localhost:8080/health
```

### AWS Lambda

```bash
pnpm build:lambda
# deploy dist/lambda/handler.zip
# configure env vars in Lambda console
# trigger via EventBridge Scheduler (every 1 min)
```

## Configuration

| Variable                | Required | Default | Description                                          |
| ----------------------- | -------- | ------- | ---------------------------------------------------- |
| `BITCOIN_RPC_URL`       | yes      | —       | Blockstream API URL or Bitcoin Core RPC endpoint     |
| `ETHEREUM_RPC_URL`      | yes      | —       | RPC URL for the chain where HashpriceBTC is deployed |
| `CHAIN_ID`              | yes      | —       | EVM chain ID                                         |
| `HASHPRICE_BTC_ADDRESS` | yes      | —       | Deployed HashpriceBTC contract address               |
| `PRIVATE_KEY`           | yes      | —       | Submitter wallet private key (0x-prefixed)           |
| `LOG_LEVEL`             | no       | `info`  | `trace\|debug\|info\|warn\|error\|fatal`             |
| `BITCOIN_WS_URL`        | no       | derived | Bitcoin new-block WebSocket; derived from an Alchemy `BITCOIN_RPC_URL` |
| `KEEPER_POLL_INTERVAL_MS` | no     | `60000` | Fallback poll interval for the service (ms)          |
| `HEALTH_PORT`           | no       | `8080`  | Port for the service's `/health` endpoint            |
| `KEEPER_MAX_BATCH_SIZE` | no       | `10`    | Max blocks per submission tx                         |
