# Hashprice Oracle

On-chain oracle for Bitcoin hashprice data, providing real-time hashrate-to-token conversion rates for the Lumerin protocol.

## Overview

This repository contains:

- **Smart Contracts** (`/contracts`) - Solidity contracts for the HashrateOracle, which calculates the number of hashes required to mine BTC equivalent to a given token amount
- **Subgraph Indexer** (`/indexer`) - A Graph Protocol subgraph that indexes oracle updates and provides historical hashprice data with hourly/daily aggregations

## Contracts

The `HashrateOracle` contract:

- Integrates with Chainlink price feeds for BTC/token pricing
- Stores and updates `hashesForBTC` (hashes required to mine 1 satoshi)
- Calculates `hashesForToken` based on current BTC price
- Uses UUPS upgradeable proxy pattern
- Supports authorized updater addresses for oracle data

### Key Functions

| Function                   | Description                              |
| -------------------------- | ---------------------------------------- |
| `setHashesForBTC(uint256)` | Update the hashes-per-satoshi value      |
| `getHashesForBTCV2()`      | Get current hashesForBTC with timestamp  |
| `getHashesForTokenV2()`    | Get hashes per token unit with timestamp |

## Quick Start

### Contracts

```bash
cd contracts
yarn install
yarn test
yarn compile
```

### Indexer

```bash
cd indexer
yarn install
# Configure .env from .env.example
yarn codegen
yarn build
```

## License

MIT
