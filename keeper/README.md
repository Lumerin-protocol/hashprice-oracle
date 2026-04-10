# hashprice-keeper

Keeper bot that submits Bitcoin block headers + coinbase merkle proofs to the on-chain `HashpriceBTC` oracle, keeping the trustless hashprice feed up to date.

## Architecture

```
src/
├── abi.ts              # HashpriceBTC contract ABI (read/write subset)
├── config.ts           # Environment-based configuration
├── core/
│   ├── bitcoin.ts      # Bitcoin data providers (Blockstream API / Bitcoin Core RPC)
│   ├── keeper.ts       # Core keeper loop logic (runtime-agnostic)
│   └── oracle.ts       # On-chain oracle interaction via viem
└── adapters/
    ├── node.ts         # Long-running Node.js daemon with poll loop
    ├── lambda.ts       # AWS Lambda handler (single invocation)
    └── worker.ts       # Cloudflare Workers (scheduled / fetch)
```

All business logic lives in `src/core/` and depends only on `fetch()`, `viem`, and an injected SHA-256 function. The adapters wire up runtime-specific concerns (crypto, logging transport, entry point).

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
docker run -d --name keeper --env-file .env hashprice-keeper
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
| `POLL_INTERVAL_MS`      | no       | `60000` | Poll interval for Node.js daemon (ms)                |
| `MAX_BATCH_SIZE`        | no       | `10`    | Max blocks per submission tx                         |
