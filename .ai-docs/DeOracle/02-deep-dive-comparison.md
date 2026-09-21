# OCMRO vs Chainlink Flux Aggregator vs Chainlink Functions vs Chainlink CRE — Deep Dive Comparison

> **Status**: Draft — for team review
> **Parent**: [Oracle Decentralization Options](01-architecture-options.md)
> **Purpose**: Four-way comparison of **OCMRO** (custom-built), **Chainlink Flux Aggregator** (community node operators), **Chainlink Functions** (serverless DON compute), and **Chainlink CRE** (full workflow orchestration): infrastructure, dependencies, costs, and contributor requirements.

---

## TL;DR

| | OCMRO (custom-built) | Chainlink Flux Aggregator (community operators) | Chainlink Functions (serverless DON compute) | Chainlink CRE (full workflow orchestration) |
|---|---|---|---|---|
| **What it is** | Custom Solidity contract + independent Docker reporters. Ground-up, not a Chainlink product. Reads the public BTC/USD feed; implements `AggregatorV3Interface`. | Chainlink's `FluxAggregator` contract + independent community node operators running full Chainlink node software. Each operator submits individually on-chain. Legacy protocol (superseded by OCR). | Consumer contract sends JavaScript source to Chainlink's DON. Each node executes independently in a Deno sandbox, DON reaches OCR consensus, result is written back via callback. GA on Base. | HPDX-authored workflow compiled to WASM and executed by Chainlink's DON. Full protocol dependency: LINK, Workflow Registry, DON consensus. Deployment is Early Access. |
| **What HPDX runs** | Smart contract (one-time deploy) + Docker reporter image | FluxAggregator contract (Chainlink's standard) + coordination with community node operators | Consumer contract on Base + JavaScript source code + Chainlink Automation (for scheduling) | CRE workflow (TypeScript → WASM, deployed to Workflow Registry on Ethereum mainnet) |
| **Community participation** | **Yes.** Anyone can pull the Docker image, run a reporter, and submit on-chain. Each submission is a distinct, auditable public transaction. | **Limited.** Professional Chainlink node operators only (found via CL Discord). Not your HPDX community. Each runs full CL node infra (Go binary + PostgreSQL + Ethereum client). | **No.** The DON is a closed set of Chainlink-operated nodes. Same limitation as CRE — no community reporter path. | **No.** The DON is a closed set of Chainlink-operated nodes. External contributors cannot participate in CRE consensus. There is no community reporter path. |
| **Per-reporter infra cost** | ~$5-100/mo (Bitcoin RPC + compute + Base gas) | ~$200-500/mo per operator (full CL node + PostgreSQL + Ethereum client + Bitcoin RPC) + LINK to fund the aggregator | N/A — no reporters; HPDX pays **$0.03/request** (~$259/mo at 5-min intervals) + Alchemy costs (DON hits your endpoints) | N/A — no reporters; HPDX pays LINK for DON execution (per-execution cost undocumented) |
| **Gas cost** | ~$0.002-0.01 per submission on Base (per reporter) | ~$0.002-0.01 per submission on Base (per operator) — same as OCMRO + LINK payment to operators | Callback gas included in per-request pricing | ~$0.002-0.01 per DON write on Base + LINK premium (unknown) |
| **Data source control** | Each reporter controls their own Bitcoin RPC (Alchemy, QuickNode, own node) | Each operator controls their own Bitcoin RPC (same as OCMRO) | **You control** — your JavaScript specifies the URLs; but each DON node hits your endpoints independently (multiplied API calls) | DON nodes use **Chainlink's own infrastructure** — HPDX does not control or know which data sources DON nodes use |
| **Brand value** | Neutral — own contract, own brand | Chainlink (using their standard FluxAggregator contract and node operator ecosystem) | "Chainlink Functions-powered" — recognized Chainlink product, GA | "Chainlink CRE-powered" (self-managed feeds don't appear in official catalog; deployment is Early Access) |
| **Time to production** | Contract dev + audit + reporter image | Aggregator deployment + operator recruitment via CL Discord + SLA negotiation + LINK funding | Consumer contract + JavaScript source + Automation upkeep — fastest Chainlink path (GA, no Early Access) | CRE workflow dev + testing + registration + LINK funding — requires Early Access approval |
| **HPOW incentive path** | Yes — reward reporters with HPOW tokens for contributing | No — operators are compensated in LINK, not HPOW | No — no external reporters to incentivize | No — no external reporters to incentivize |

---

## 1. OCMRO — Custom-Built Oracle

OCMRO (**On-Chain Multi-Reporter Oracle**) is **not** a Chainlink offering. It is a custom architecture: a Solidity contract plus independent reporters. This section describes that path on its own terms.

### 1.1 What It Is

A custom Solidity smart contract deployed on Base that:
- Accepts `submit(uint256 hashesForBTC)` from whitelisted reporters
- Stores each reporter's latest value and timestamp
- Computes the median of all fresh submissions when quorum is met
- Composes with the Chainlink BTC/USD feed (read-only, as today) to derive hashprice
- Exposes `AggregatorV3Interface` + HashrateOracle-compatible functions

### 1.2 How OCMRO Relates to Chainlink (Clarification)

| Aspect | What this means |
|--------|-----------------|
| **Implementation** | OCMRO is a **ground-up custom Solidity contract** — not a fork of, template from, or product sold by Chainlink. |
| **Consuming Chainlink** | It **reads** the public Chainlink BTC/USD feed as **one data input**, the same way any DeFi contract reads a price feed. That is a normal on-chain read; it does not make the aggregator "a Chainlink option." |
| **Consumer compatibility** | It **implements** `AggregatorV3Interface` so downstream contracts keep a familiar, industry-standard surface — again, an interface pattern, not Chainlink infrastructure. |
| **What you do not need** | **Zero** Chainlink-specific operations: no Chainlink nodes, no LINK tokens, no DON participation, no Workflow Registry, no CRE. |

**Summary**: OCMRO is **Chainlink-compatible** (interface + optional feed read) and **Chainlink-consuming** (BTC/USD), but it is **not** a Chainlink product or deployment model.

### 1.3 Dependencies

The `HashrateAggregator` is a **ground-up custom Solidity contract**. It is not forked from, based on, or linked to any existing Chainlink contract or template. It *implements* `AggregatorV3Interface` — a standard Solidity interface (a set of function signatures) — the same way any contract can implement any interface. The contract code, aggregation logic, and storage layout are entirely custom.

| Dependency | What | Required? | Notes |
|-----------|------|-----------|-------|
| Solidity compiler | Compile the contract | Yes (build-time only) | Standard Hardhat/Foundry toolchain |
| OpenZeppelin | UUPS, Ownable, etc. | Yes (build-time only) | Standard upgradeable contract libs |
| `AggregatorV3Interface` | Interface definition | Yes (build-time only) | Just a `.sol` interface file — no runtime dependency on Chainlink ops |
| Chainlink BTC/USD feed | Live price data | Yes (read-only at runtime) | Same pattern as current HashrateOracle; same trust model for that leg |
| Base chain RPC | Deploy and interact | Yes | Alchemy, QuickNode, etc. |
| Bitcoin RPC | Compute hashesForBTC | Yes (per reporter) | Alchemy, QuickNode, own full node, or pruned node |

**No Chainlink runtime dependencies**: No Chainlink node software, no LINK tokens, no Chainlink CLI/SDK, no Workflow Registry registration, no PostgreSQL, no DON participation.

### 1.4 What HPDX Develops and Operates

| Component | Technology | One-Time or Ongoing |
|-----------|-----------|-------------------|
| `HashrateAggregator.sol` | Solidity 0.8.x, UUPS proxy | One-time (upgradeable) |
| Reporter Docker image | Node.js/TypeScript (based on existing `oracle-update`) | Maintained, published to GHCR |
| Reporter instances | Docker containers on AWS (or any cloud) | Ongoing per reporter |
| Contract owner wallet | EOA, later multisig | Ongoing |

### 1.5 What a Contributor Runs

```
docker run -e BITCOIN_RPC_URL=https://... \
           -e BASE_RPC_URL=https://... \
           -e AGGREGATOR_ADDRESS=0x... \
           -e REPORTER_PRIVATE_KEY=0x... \
           ghcr.io/hpdx/hashprice-reporter:latest
```

**That's it.** No oracle node software, no SDK, no compilation step.

| Requirement | Detail | Cost |
|-------------|--------|------|
| Docker runtime | Any cloud VM, bare metal, or local machine | $5-50/mo (t3.small is sufficient) |
| Bitcoin RPC access | Alchemy free tier, QuickNode, or own full node | $0 (free tier) to $100/mo (full node hosting) |
| Base RPC access | Alchemy free tier or paid | $0-29/mo |
| ETH on Base | Gas for `submit()` transactions | ~$1-5/mo |
| **Total per contributor** | | **$5-100/mo** |

### 1.6 Gas Costs: Pattern 1 vs Pattern 2

**Base chain gas pricing** (researched April 2026):
- Minimum base fee: 0.005 Gwei
- Typical `submit()` call: ~100,000-200,000 gas
- Cost per submission: **~$0.002-0.01** at current Base gas prices

| | Pattern 1 (Simple Median) | Pattern 2 (Deviation-Triggered) |
|---|---|---|
| Submissions per reporter per day | 288 (every 5 min) | 50-100 (only on deviation or heartbeat) |
| Gas per reporter per day | ~$0.60-2.90 | ~$0.10-1.00 |
| Gas per reporter per month | ~$18-87 | ~$3-30 |

Pattern 2 is 3-5x more gas-efficient during stable periods. The hashprice typically doesn't swing wildly every 5 minutes, so most intervals will be heartbeat-only. Costs scale linearly as reporters are added.

---

## 2. Chainlink Flux Aggregator — Community Node Operators

The Flux Aggregator is Chainlink's legacy on-chain aggregation protocol. It sits between OCMRO (fully custom) and CRE (fully managed by Chainlink's DON). This section covers what it actually takes to stand up and operate a custom Flux Aggregator feed.

### 2.1 What It Is

Chainlink's Flux Aggregator is their legacy on-chain aggregation protocol. Multiple independent community node operators each run full Chainlink node software with a "Flux Monitor" job. When deviation threshold is exceeded or heartbeat fires, each node submits individually on-chain. The `FluxAggregator` contract computes the median. Consumers read via `AggregatorV3Interface`.

This was the standard before OCR replaced it for official feeds. OCR aggregates off-chain (single report on-chain); Flux Monitor aggregates on-chain (individual submissions per operator). Architecturally, Flux Aggregator is much closer to OCMRO than to CRE.

### 2.2 How Flux Monitor Works

- Each node operator runs the Chainlink node (Go binary) with a `fluxmonitor` job type
- The job specifies: `contractAddress`, `threshold` (deviation %), `pollTimerPeriod`, `idleTimerPeriod` (heartbeat), and `observationSource` (the data pipeline)
- Each node independently polls the data source at the configured frequency
- When any node detects deviation exceeding threshold, it initiates a new round
- Other nodes are notified and submit their observations
- Each submission is an individual on-chain transaction to the FluxAggregator contract
- The contract computes the median when enough responses arrive
- This is architecturally identical to OCMRO Pattern 2 (deviation-triggered with heartbeat)

### 2.3 Dependencies

| Dependency | What | Required? | Notes |
|-----------|------|-----------|-------|
| Chainlink node software | Go binary | Yes | Full Chainlink oracle runtime |
| PostgreSQL 12+ | Node database | Yes | Stores job state, pipeline data |
| Ethereum client | Blockchain connectivity | Yes | Can use Alchemy/Infura or own client |
| FluxAggregator contract | On-chain aggregation | Yes | Chainlink's standard contract |
| LINK tokens | Pay node operators | Yes | Fund the aggregator contract |
| Bitcoin RPC | Compute hashesForBTC | Yes (per operator) | External adapter or HTTP pipeline |
| Base chain RPC | Submit transactions | Yes | Each operator needs this |
| External Adapter (optional) | Custom data fetch logic | Depends | For complex data sources like Bitcoin RPC calls |

### 2.4 What HPDX Develops and Operates

| Component | One-Time or Ongoing |
|-----------|-------------------|
| FluxAggregator contract deployment (Chainlink's standard, not custom) | One-time |
| External Adapter (if needed for Bitcoin RPC logic) | Maintained |
| LINK token funding | Ongoing |
| Operator coordination and SLA management | Ongoing |
| Contract owner wallet | Ongoing |

### 2.5 What a Node Operator Runs (NOT a Docker One-Liner)

Each Flux Aggregator participant runs full Chainlink node infrastructure:

- **Chainlink node** (Go binary via Docker) — the full oracle runtime
- **PostgreSQL 12+ database** — stores job state, pipeline runs, key material
- **Ethereum client or RPC endpoint** for Base chain connectivity
- **Bitcoin RPC access** — for hashesForBTC computation (via external adapter or HTTP pipeline)
- **fluxmonitor job specification** — TOML config defining contract address, thresholds, data pipeline
- **24/7 monitoring, alerting, maintenance** — operators are expected to maintain uptime SLAs

| Requirement | Detail | Cost |
|-------------|--------|------|
| Cloud server (minimum) | 4+ CPU cores, 8+ GB RAM, SSD | $50-200/mo |
| PostgreSQL hosting | Managed or self-hosted | $0-50/mo |
| Bitcoin RPC | Alchemy, QuickNode, or own node | $0-100/mo |
| Base chain RPC | Alchemy or similar | $0-29/mo |
| ETH on Base | Gas for submissions | ~$1-5/mo |
| Chainlink node maintenance | 24/7 ops commitment | (team time) |
| **Total per operator** | | **$50-350/mo + team commitment** |

### 2.6 Operator Recruitment

- No centralized marketplace (deprecated market.link)
- Primary channel: `#operator-requests` on Chainlink Official Discord
- Providers like LinkWell Nodes, Matrixed.Link, NorthWest Nodes
- You explain requirements, negotiate SLAs, coordinate setup
- Each operator needs to configure the fluxmonitor job with your contract address, data source pipeline, thresholds
- Finding multiple willing operators for a custom niche feed (hashprice) on a legacy protocol is not guaranteed

### 2.7 Community Participation — Professional Operators Only

- The "community" here is Chainlink's professional node operator network
- These are teams that specialize in running Chainlink infrastructure
- Your HPDX users, partners, or community members cannot participate unless they commit to running full Chainlink node infrastructure (Go binary + PostgreSQL + Ethereum client)
- There is no Docker one-liner for a Flux Aggregator participant
- Operators are compensated in LINK — no path for HPOW token incentives
- This is a contracted service relationship, not community contribution

### 2.8 Cost Estimates

- Gas costs same as OCMRO (individual on-chain submissions per operator)
- PLUS: LINK token funding in the FluxAggregator to pay operators
- LINK cost per operator per round varies — typically negotiated with operators
- Operator infrastructure costs: $50-350/mo each (see §2.5 above)
- Contract deployment and maintenance: similar to OCMRO

### 2.9 Protocol Status: Legacy

- Flux Monitor was superseded by OCR for all official Chainlink feeds
- OCR aggregates off-chain (cheaper, more efficient) — Flux Monitor aggregates on-chain
- Chainlink's current direction is CRE/OCR, not Flux Monitor
- Documentation still exists but is not actively promoted
- Finding community operators willing to maintain custom Flux Monitor jobs on a non-standard chain (Base) for a niche feed is increasingly difficult
- Risk of decreased support and community knowledge over time

---

## 3. Chainlink Functions — Serverless DON Compute

Chainlink Functions is a serverless compute platform where your smart contract sends JavaScript source code to a DON for execution. Each node runs the code independently in a sandboxed Deno environment, the DON reaches OCR consensus on the return value, and the aggregated result is written back to your contract via callback. Functions is **GA on Base mainnet** with transparent, published pricing.

### 3.1 What It Is

Your consumer contract on Base calls `sendRequest()` on the Chainlink Functions Router, passing JavaScript source code and optional encrypted secrets (API keys). Each DON node:
1. Decrypts secrets via threshold decryption
2. Executes the JavaScript in an isolated Deno sandbox
3. Returns a value (max 256 bytes)

The DON then runs OCR consensus on all node return values, and a single node submits the aggregated result back to your contract via `handleOracleFulfillment()` callback.

**Key distinction from CRE**: Functions is request/response (your contract triggers each execution) while CRE is workflow-based (triggers are built into the workflow — cron, EVM log, etc.). Functions needs an external trigger (Chainlink Automation) to run on a schedule. Functions uses JavaScript (not TypeScript→WASM). Functions is GA; CRE deployment is Early Access.

### 3.2 How It Works for Hashprice

1. **Chainlink Automation** fires every 5 minutes (or on a deviation schedule) and calls your consumer contract
2. Consumer contract calls `FunctionsRouter.sendRequest()` with JavaScript source that:
   - Fetches `getblockchaininfo` from Bitcoin RPC (1 HTTP call)
   - Fetches `getblockstats` for recent blocks (1-3 HTTP calls)
   - Computes `hashesForBTC` from difficulty, fees, subsidy
   - Returns the uint256 result
3. Each DON node independently executes this JavaScript, hitting **your** specified endpoints
4. DON reaches OCR consensus on the return values
5. Result is delivered to your consumer contract's callback
6. Consumer contract writes the value to the HashrateAggregator (or acts as the aggregator itself)

### 3.3 Dependencies

| Dependency | What | Required? | Notes |
|-----------|------|-----------|-------|
| Functions Router contract | On Base mainnet | Yes | Chainlink-deployed; your contract calls it |
| LINK tokens | Pay per request ($0.03 on Base) | Yes | Fund a subscription account |
| Chainlink Automation | Trigger periodic requests | Yes | Decentralized cron; also paid in LINK |
| Bitcoin RPC (Alchemy, QuickNode, etc.) | Data source for hashesForBTC | Yes | **Each DON node hits your endpoints** — multiplied API calls |
| Base chain RPC | Contract interaction | Yes | Standard |
| Encrypted secrets (optional) | API keys for authenticated endpoints | Optional | Threshold-encrypted; DON nodes decrypt cooperatively |

**Important — DON nodes hit YOUR endpoints**: Unlike CRE (where DON nodes use Chainlink's own infrastructure), Functions executes your JavaScript code which specifies the URLs to call. Each DON node independently hits your Alchemy/QuickNode endpoints. This means:

- **You control the data source** — your JavaScript specifies exactly which URLs to call
- **Your API bill is multiplied** — if the DON has ~31 nodes, each request results in ~31 calls to your endpoint
- **You can verify the data path** — since you wrote the code and control the endpoints

### 3.4 Service Limits (from docs.chain.link)

| Limit | Value |
|-------|-------|
| Max source code execution time | **10 seconds** |
| Max HTTP queries per execution | **5** |
| Max returned value size | **256 bytes** |
| Max callback gas | 300,000 |
| HTTP query timeout | 9 seconds |
| Max request size (source + args + secrets) | 30 KB |
| Max HTTP response size | 2 MB |
| Request fulfillment timeout | 5 minutes |

The hashprice computation fits within these limits: 2-4 HTTP calls to Bitcoin RPC, simple arithmetic, one uint256 return value. The 10-second execution limit is comfortable for this workload.

### 3.5 What HPDX Develops and Operates

| Component | Technology | One-Time or Ongoing |
|-----------|-----------|-------------------|
| Consumer/aggregator contract on Base | Solidity — inherits `FunctionsClient`, implements oracle interface | One-time (upgradeable) |
| JavaScript source code | Deno-compatible JS (hashesForBTC computation) | Maintained |
| Chainlink Automation upkeep | Trigger contract for periodic execution | One-time setup, ongoing LINK funding |
| LINK subscription balance | Fund Functions requests + Automation | Ongoing |
| Bitcoin RPC endpoint | Alchemy or similar (API key encrypted as secret) | Ongoing |

### 3.6 Community Participation — There Is None

Same as CRE: the DON is a closed set of Chainlink-operated nodes. Your JavaScript runs on their infrastructure. No community members, partners, or third parties can participate in the execution or contribute their own observations. No path for HPOW token incentives.

### 3.7 Cost Estimates (researched from docs.chain.link)

**Functions pricing on Base** (published):
- Premium fee: **$0.03 per request** (converted to LINK at request time)
- Callback gas: included (up to 300,000 gas limit)

**Automation pricing** (separate):
- Chainlink Automation also charges per upkeep execution in LINK
- Typical cost: ~$0.01-0.05 per trigger on L2s

**Monthly cost at 5-minute intervals (288 requests/day):**

| Component | Cost |
|-----------|------|
| Functions requests (288/day × 30 days × $0.03) | **~$259/mo** |
| Automation triggers (288/day × 30 days × ~$0.02) | **~$173/mo** |
| Bitcoin RPC (Alchemy — multiplied by DON node count) | **$29-99/mo** (paid tier recommended) |
| **Total estimated** | **~$460-530/mo** |

This is the most expensive option with transparent pricing. By comparison, OCMRO with a single reporter costs ~$5-30/month total.

**Cost optimization**: Using deviation-triggered scheduling (Automation only fires when needed) could reduce costs by 60-70%, bringing it to ~$140-180/mo. But this adds complexity — the Automation upkeep needs to know the current on-chain value to decide whether to trigger.

---

## 4. Chainlink CRE — Full Workflow Orchestration

Chainlink **CRE** (Chainlink Runtime Environment) is the most fully managed, protocol-dependent path: Chainlink product surface, DON execution, LINK economics. This section is **only** about CRE.

### 4.1 What It Is

The Chainlink Runtime Environment (CRE) is an orchestration layer that allows developers to write custom workflows in TypeScript (or Go), compile them to WebAssembly (WASM), and deploy them to be executed by Chainlink's existing Decentralized Oracle Networks (DONs).

**You never run a DON node.** CRE workflows execute on Chainlink's existing DON infrastructure — the same nodes that power Chainlink's BTC/USD price feeds. You write the logic, deploy it to the Workflow Registry, and Chainlink's network runs it with Byzantine Fault Tolerant (BFT) consensus. This is the same trust model as consuming any Chainlink price feed: you trust their DON to execute honestly. There is no need (or option) to operate your own DON node.

### 4.2 OCR: How DON Consensus Works Under the Hood

CRE workflows execute on DONs that run the **Off-Chain Reporting (OCR)** protocol ([docs](https://docs.chain.link/architecture-overview/off-chain-reporting), [OCR3 paper](https://research.chain.link/ocr3.pdf)). OCR is the battle-tested consensus mechanism that powers all existing Chainlink price feeds (including the BTC/USD feed the hashprice oracle already consumes). Understanding OCR matters because it's the execution model for any CRE-based solution.

**How OCR works:**
1. Nodes communicate via a **peer-to-peer network** (no individual on-chain submissions)
2. A **leader node** is elected per round and requests signed observations from followers
3. The leader aggregates observations into a **single report**
4. A **quorum of nodes** signs the report (Byzantine fault tolerant — survives dishonest nodes)
5. One node submits the **single aggregate transaction** on-chain
6. The on-chain contract verifies quorum signatures and exposes the median

**Key transparency detail**: The on-chain report *contains* all individual node observations (signed), not just the median. So individual inputs are visible on-chain, but bundled into one transaction rather than submitted as separate transactions.

**OCR's track record**: This protocol secures billions in DeFi TVL through Chainlink's existing feeds. It is arguably the most battle-tested oracle consensus mechanism in production.

### 4.3 How CRE Uses OCR (researched from docs.chain.link)

1. **Write workflow**: TypeScript code defining triggers (cron, EVM log, HTTP) and actions (fetch data, compute, write on-chain)
2. **Compile to WASM**: `cre workflow deploy` compiles TypeScript → WASM binary
3. **Upload**: WASM binary + config uploaded to CRE Storage Service
4. **Register**: Transaction submitted to the **Workflow Registry contract on Ethereum mainnet** (`0x4Ac54353FA4Fa961AfcC5ec4B118596d3305E7e5`)
5. **Execute**: DON nodes run the workflow using OCR consensus:
   - **Workflow DON**: Monitors triggers, coordinates execution
   - **Capability DONs**: Execute specific tasks (data fetch, compute, chain write)
   - Each execution round follows the OCR protocol above
6. **Write to Base**: DON writes the quorum-signed result to your consumer contract

### 4.4 Dependencies

| Dependency | What | Required? | Notes |
|-----------|------|-----------|-------|
| CRE CLI | `cre` command-line tool | Yes | For workflow development, simulation, deployment |
| CRE TypeScript SDK | `@chainlink/cre-sdk` | Yes | For writing workflow logic |
| Ethereum mainnet wallet | Register workflow on-chain | Yes | Workflow Registry is on Ethereum mainnet |
| LINK tokens | Pay for DON execution | Yes | Payment Abstraction allows stablecoin payment (converted to LINK) |
| Base chain RPC | For on-chain writes | Yes | Configured in workflow |
| CRE API key | Authentication | Yes | `cre login` or `CRE_API_KEY` env var |

**Important — Bitcoin RPC and data sources**: DON nodes use **Chainlink's own infrastructure** for HTTP and RPC calls, not yours. When the CRE workflow fetches Bitcoin blockchain data, each DON node in the Capability DON executes the request independently using its own data sources, then reaches BFT consensus on the result. You configure RPC URLs during local simulation (for testing), but once deployed to a DON, Chainlink's infrastructure handles all external calls. This means:

- **Your Alchemy/QuickNode bill is unaffected** — DON nodes don't hit your endpoints
- **You don't control which Bitcoin data source DON nodes use** — you trust Chainlink's infrastructure to fetch accurate data
- **You can't verify the specific source** a DON node used for a given observation — you verify the consensus output, not the input path

### 4.5 What HPDX Develops and Operates

| Component | Technology | One-Time or Ongoing |
|-----------|-----------|-------------------|
| CRE workflow (TypeScript) | TypeScript → WASM, deployed to Workflow Registry | Maintained |
| Consumer contract on Base | Solidity — receives data from DON | One-time (upgradeable) |
| LINK token balance | Fund workflow execution | Ongoing |
| Ethereum mainnet wallet | Workflow lifecycle management | Ongoing |
| CRE API key | Authentication with CRE platform | Ongoing |

### 4.6 Community Participation — There Is None

CRE's architecture is fundamentally incompatible with community contribution:

- HPDX writes a workflow and Chainlink's DON executes it
- The DON is a **closed set of Chainlink-operated nodes** — external contributors cannot join or participate in DON consensus
- The WASM code can be audited (it's your open-source TypeScript), but the execution is entirely within Chainlink's network
- There is no mechanism for partners, community members, or third parties to contribute their own observations or run their own reporter infrastructure
- There is no path for HPOW token incentivization of external reporters — there are no external reporters

**CRE's decentralization model is delegation, not participation.** You delegate execution to Chainlink's trusted infrastructure. That infrastructure is decentralized (BFT across DON nodes), but the decentralization is Chainlink's — not yours or your community's.

### 4.7 Cost Estimates

**CRE execution costs** (researched):
- CRE uses a payment model where execution costs are denominated in LINK
- "Payment Abstraction" (launched March 2025) allows payment in stablecoins or gas tokens, programmatically converted to LINK
- Per-execution cost is not publicly documented with specific numbers as of April 2026
- The cost includes: DON compute resources + BFT consensus overhead + gas for on-chain write

**Infrastructure costs** (CRE doesn't require you to run servers, but you need):

| Component | Cost |
|-----------|------|
| CRE workflow development | Engineering time (TypeScript/WASM) |
| Ethereum mainnet gas (workflow registration) | ~$5-20 per registration/update |
| LINK tokens (execution) | **Unknown** — Chainlink has not published per-execution pricing for CRE |
| Bitcoin RPC (for local simulation only) | $0-29/mo |
| Base RPC (for local simulation only) | $0-29/mo |

**Two material unknowns**:

1. **LINK cost per execution**: Not publicly documented. Chainlink's documentation mentions costs depend on "computational and operational resources" but provides no per-call or per-workflow pricing tables. For a feed updating every 5 minutes (288 executions/day), even a small per-execution fee compounds.
2. **DON data source quality**: Since DON nodes use their own infrastructure for Bitcoin RPC calls (not yours), you cannot control or verify which specific data sources they use. For deterministic data like `hashesForBTC`, where the algorithm requires specific Bitcoin RPC calls (`getblockchaininfo`, `getblockstats`), you are trusting that Chainlink's nodes have access to reliable, non-stale Bitcoin blockchain data. This is likely fine given their track record, but it is a trust assumption that doesn't exist with OCMRO (where each reporter controls their own source).

---

## 5. Side-by-Side Comparison

### 5.1 Infrastructure and Dependencies

| Aspect | OCMRO (custom-built) | Flux Aggregator (community operators) | Functions (serverless DON) | CRE (full workflow orchestration) |
|--------|----------------------|---------------------------------------|---------------------------|-----------------------------------|
| Smart contract | Custom `HashrateAggregator` on Base | FluxAggregator on Base | Consumer contract on Base (inherits `FunctionsClient`) | Consumer contract on Base + Workflow Registry on Ethereum mainnet |
| Off-chain compute | Docker container (self-hosted) | Full CL node (self-hosted per operator) | Chainlink DON (managed); your JavaScript | Chainlink DON (managed); your TypeScript→WASM |
| Programming language | TypeScript (Node.js) | TOML job config | JavaScript (Deno sandbox) | TypeScript → WASM (CRE SDK) |
| Build toolchain | Standard npm/Docker | Standard Chainlink toolchain | Standard Solidity + JS | CRE CLI, WASM compiler |
| Deployment target | Base chain only | Base chain only | Base chain only | Ethereum mainnet (registry) + Base (consumer) |
| Token requirement | None | LINK | LINK (subscription) | LINK (for DON payment) |
| Node software | None | Full CL node software | None (DON runs your JS) | None (DON runs your WASM) |
| Database | None | PostgreSQL 12+ | None | None |
| Scheduling | Reporter-driven (heartbeat/deviation) | Node-driven (fluxmonitor) | Chainlink Automation (separate) | Built-in triggers (cron, EVM log) |
| Availability | N/A | N/A | **GA** on Base | **Early Access** for deployment |

### 5.2 Control and Decentralization

| Aspect | OCMRO | Flux Aggregator | Functions | CRE |
|--------|-------|-----------------|-----------|-----|
| Who runs the computation? | Each reporter independently | Each operator independently (like OCMRO) | Chainlink DON (multiple nodes, BFT) | Chainlink DON (multiple nodes, BFT) |
| Who controls the aggregation? | Smart contract (immutable, auditable logic) | FluxAggregator contract (Chainlink's standard) | DON OCR consensus | DON OCR consensus |
| Can HPDX be accused of manipulation? | No — all submissions are public on-chain transactions | No — individual public submissions | No — DON consensus is independent | No — DON consensus is independent |
| Can anyone externally verify? | Yes — run the Docker image, compare your output to on-chain submissions | Yes — run own node and compare | Partially — compare DON output vs your own calc; your JS source is public | Partially — compare DON output vs your own calc; your TS source is public |
| Transparency of individual inputs | Full — each `submit()` is a separate, visible on-chain transaction | Full — same as OCMRO | Bundled — OCR report only | Bundled — OCR report only |
| Community reporters | **Yes** — anyone with Docker can contribute | Professional CL operators only | **No** — DON is closed | **No** — DON is closed |
| HPOW incentive path | **Yes** — reward community reporters | No (LINK only) | **No** | **No** |
| Data source control | Each reporter chooses their own Bitcoin RPC | Each operator controls their own | **You control** (your JS specifies URLs) but DON nodes hit your endpoints | Chainlink's infrastructure; HPDX doesn't control the source |
| Upgradeability | UUPS proxy (HPDX controls upgrades) | Contract upgrades by HPDX | Update JS source code | Workflow updates via CRE CLI |

### 5.3 Contributor Experience

| Aspect | OCMRO | Flux Aggregator | Functions | CRE |
|--------|-------|-----------------|-----------|-----|
| Can external contributors participate? | **Yes** | Professional CL operators only | **No** | **No** |
| Onboarding | Pull Docker image, set env vars, run | Find on CL Discord + negotiate + configure fluxmonitor job | N/A | N/A |
| Prerequisite knowledge | Docker, basic crypto wallet | Chainlink node ops + PostgreSQL + blockchain infra | N/A | N/A |
| Wallet requirements | Base wallet with ETH | Base wallet + LINK funding in aggregator | N/A | N/A |
| Ongoing costs per contributor | $5-100/mo | $50-350/mo per operator + LINK | N/A | N/A |
| Can inspect the code? | Yes — fully open-source Docker image | Yes (open source CL node + job spec) | Yes — JS source is public | Workflow TS is open-source; DON execution is opaque |
| Can run independently? | Yes — fully self-contained | Yes but requires full CL infra | N/A | N/A |

**OCMRO is the only option that enables lightweight community participation via Docker.** Flux Aggregator requires professional Chainlink node operators with heavy infrastructure. Both Functions and CRE delegate to Chainlink's DON — there are no external reporters to onboard, reward, or build community around.

### 5.4 Gas Cost Comparison and Aggregation Model

**Pattern 1 (Simple On-Chain Median) and Pattern 2 (Deviation-Triggered) apply to OCMRO.** They describe how multiple reporters submit individual transactions to the aggregator contract, which then computes the on-chain median.

**Flux Aggregator works the same way as OCMRO** — individual on-chain submissions per operator, contract computes the median. Same gas profile. The difference is LINK payment overhead on top of gas.

**Functions and CRE both use the OCR protocol.** The DON reaches consensus internally via off-chain P2P communication and submits a single result on-chain. The difference: Functions delivers the result via callback to your consumer contract; CRE writes directly to a target contract. Both produce one on-chain write per round.

**OCMRO on-chain gas costs (per reporter):**

| | Pattern 1 (Simple Median) | Pattern 2 (Deviation-Triggered) |
|---|---|---|
| Submissions per reporter per day | 288 (every 5 min) | 50-100 (only on deviation or heartbeat) |
| Gas per reporter per day | ~$0.60-2.90 | ~$0.10-1.00 |
| Gas per reporter per month | ~$18-87 | ~$3-30 |

**Flux Aggregator on-chain gas costs (per operator):**

| | Flux Aggregator (deviation-triggered) |
|---|---|
| Submissions per operator per day | 50-100 (same as OCMRO Pattern 2 — threshold + heartbeat) |
| Gas per operator per day | ~$0.10-1.00 |
| Gas per operator per month | ~$3-30 + LINK payment per round |

On Base, Flux Aggregator has the same gas cost as OCMRO but with added LINK overhead to compensate operators.

**Functions on-chain gas costs:**

| | Functions (DON callback) |
|---|---|
| On-chain writes per day | 288 (every 5 min via Automation trigger) |
| Chainlink fee per day | 288 × $0.03 = ~$8.64 |
| Chainlink fee per month | **~$259 + ~$173 Automation = ~$432** |
| Gas per month | Included in per-request fee |

**CRE on-chain gas costs:**

| | CRE (single DON write) |
|---|---|
| On-chain writes per day | 288 (every 5 min, or deviation-triggered within workflow) |
| Gas per day | ~$0.60-2.90 |
| Gas per month | ~$18-87 + LINK premium (unknown) |

**Monthly cost comparison (single entity, 5-min intervals):**

| | OCMRO (1 reporter) | Flux (1 operator) | Functions | CRE |
|---|---|---|---|---|
| Gas / Chainlink fees | ~$3-30 | ~$3-30 + LINK | ~$432 (published) | ~$18-87 + LINK (unknown) |
| Infrastructure | ~$5-50 | ~$50-350 | ~$29-99 (Alchemy) | ~$0-29 (simulation only) |
| **Total** | **~$8-80** | **~$53-380+** | **~$460-530** | **Unknown (LINK cost unpublished)** |

**Does OCR's efficiency tip the scales toward Functions or CRE?** No. On Base (~$0.002-0.01 per transaction), even 10 OCMRO reporters submitting individually costs ~$0.02-0.10 per round — negligible. The premium Chainlink charges for DON execution far exceeds the gas savings.

---

## 6. Risk Assessment

### 6.1 OCMRO Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Contract vulnerability | Low-Medium | High | AI audit + third-party audit; UUPS allows patching |
| Low reporter count | Medium | Medium | Start 1-of-1, grow via Docker + partner outreach |
| Reporter collusion | Low | High | Median resists outliers; circuit breaker; grow reporter set |
| Brand credibility concern | Medium | Medium | Transparency dashboard; open-source everything |
| Base chain outage | Very Low | High | Shared with all options; inherent to chain choice |

### 6.2 Flux Aggregator Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Legacy protocol decline | Medium | Medium | Could migrate to CRE if needed |
| Operator availability | Medium | Medium-High | Niche feed on non-standard chain; limited pool |
| LINK cost management | Medium | Low-Medium | Ongoing token funding required |
| Operator SLA reliability | Low-Medium | Medium | Vet operators carefully; diversify |
| No HPDX community participation | High | Medium | Fundamental to architecture |
| Brand value vs CRE | Medium | Low | Flux is "Chainlink" but not modern CRE |
| Base chain outage | Very Low | High | Shared with all options |

### 6.3 Functions Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| High monthly cost ($460-530/mo) | High | Medium | Deviation-triggered scheduling reduces to ~$140-180/mo; still 3-10x more than OCMRO |
| API bill amplification | Medium | Low-Medium | Each DON node hits your endpoints independently; paid Alchemy tier recommended |
| Execution limit constraints | Low | Medium | 10s timeout, 5 HTTP calls — hashprice fits, but future algorithm changes could hit limits |
| No community participation | High | Medium | Fundamental to architecture — same limitation as CRE |
| Automation dependency | Low | Low-Medium | Scheduling requires a second Chainlink service (Automation); adds complexity and cost |
| Functions service changes | Low | Medium | Chainlink controls the platform; pricing or limits could change |

### 6.4 CRE Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CRE platform immaturity | Medium | Medium | CRE is v1.x; Base support since v1.0.0 but ecosystem is young |
| LINK cost uncertainty | Medium | Medium | Payment Abstraction helps; but no published per-execution pricing |
| DON availability | Low | High | Chainlink has high uptime track record |
| Workflow Registry on Ethereum mainnet | Low | Low-Medium | Adds operational complexity; Ethereum gas for registration |
| No community participation path | High | Medium | Fundamental to CRE architecture — cannot be mitigated |
| Chainlink dependency | Low | Medium | Single vendor lock-in for execution layer |
| Data source opacity | Low | Low-Medium | Cannot verify which Bitcoin RPC sources DON nodes use |

---

## 7. Recommendation

**Start with OCMRO** (custom-built oracle) for the following reasons:

1. **OCMRO is the only option that enables community reporters** — Docker image, open contribution, HPOW incentive path
2. **No Chainlink infrastructure dependency** — fastest path to production; you only read the public BTC/USD feed like today
3. **Full on-chain transparency** — every reporter submission is a distinct, auditable public transaction; strongest trust claim for a derivatives index
4. **Data source control** — each reporter controls their own Bitcoin RPC; no trust assumption about which data source is used
5. **Cost certainty** — no unknown LINK premium; Base gas costs are predictable and negligible
6. **You own the debuggability** — when something breaks, you can read the code, inspect the logs, and fix it without waiting on anyone

**Flux Aggregator does what OCMRO does** — individual on-chain submissions, median aggregation — but with heavier per-operator infrastructure, LINK costs, a legacy protocol, and no path for HPDX community participation.

**When would Functions make sense?**
- You want Chainlink DON consensus with transparent, published pricing (unlike CRE)
- You want to control which Bitcoin RPC endpoints are used (unlike CRE)
- Community participation is not a priority
- You accept ~$460-530/mo in Chainlink fees (or ~$140-180/mo with deviation-triggered scheduling)
- Honestly: Functions is the best Chainlink option if you want DON consensus, GA availability, and transparent costs — but it's still 5-10x more expensive than OCMRO for a single-reporter setup with fewer capabilities

**When would CRE make sense?**
- A material business deal explicitly requires "Chainlink-powered" branding
- HPDX migrates to an expensive L1 where OCR's single-transaction efficiency matters
- CRE per-execution pricing is publicly documented and competitive
- Community participation is no longer a priority

**When would Flux Aggregator make sense?**
- When Chainlink brand matters AND a community of professional CL operators is preferred over HPDX Docker community
- When you want individual on-chain submissions (like OCMRO) but with third-party operators (not your own Docker runners)
- Honestly, in almost no scenario — Functions or CRE are better Chainlink options if brand matters, and OCMRO is better if community matters

---

## 8. Pressure Test: Hard Questions Before We Commit

### Q1: What about Chainlink's community node operators (Flux Aggregator)? Isn't that a middle ground?

This is the question that surfaces when people hear "Chainlink" and assume there's a community-driven option. Section 2 covers this in full detail. The short version:

Chainlink has **two tiers** of node operators:
- **Official DON operators** — vetted institutional entities (Deutsche Telekom T-Systems, Swisscom, LexisNexis, etc.) selected by the Chainlink Foundation. No public application process. These are the nodes that execute CRE workflows and power official price feeds.
- **Community node operators** — independent teams (LinkWell Nodes, Matrixed.Link, etc.) who run full Chainlink node software and offer custom data feed services. Found via Chainlink Discord, not a marketplace.

Community operators can run a custom hashprice feed using Chainlink's **Flux Aggregator** (`FluxAggregator.sol`) — a legacy on-chain aggregation contract. This is architecturally similar to OCMRO: multiple operators submit individually on-chain, the contract computes the median, consumers read via `AggregatorV3Interface`.

**Why it's not a better option than OCMRO:**

| | OCMRO | Flux Aggregator |
|---|---|---|
| Per-operator infrastructure | Docker + Bitcoin RPC | Full Chainlink node (Go binary) + PostgreSQL + Ethereum client |
| Token requirement | None | LINK (fund the aggregator to pay operators) |
| Community participation | Anyone with Docker | Professional CL node operators only |
| Protocol status | New (custom) | Legacy — superseded by OCR, Chainlink's direction is CRE |
| Operator recruitment | Whitelist address, share Docker image | Find operators on CL Discord, negotiate SLAs |
| HPOW incentive path | Yes — reward reporters with HPOW | No — operators are paid in LINK |
| Data source control | Each reporter controls their own | Each operator controls their own (same as OCMRO) |
| Brand | Neutral | Chainlink (using their contract + operators) |

**The Flux Aggregator gives you Chainlink brand at the cost of heavier infrastructure, LINK dependency, a legacy protocol, and no path for your own community to participate.** OCMRO does the same thing — individual on-chain submissions, median aggregation, deviation-triggered — with Docker, zero LINK, and your community can join.

If the only argument for Flux Aggregator is brand, CRE delivers more brand value (DON consensus, modern platform) with less operational overhead than coordinating community node operators on a legacy protocol.

See [section 2](#2-chainlink-flux-aggregator--community-node-operators) for the full breakdown and [section 4.2 of the Architecture Options](01-architecture-options.md) for the evaluation in context.

### Q2: Under what conditions would CRE be the better choice?

Two scenarios:

- **Brand as a prerequisite for a deal.** If a major institutional partner or exchange listing explicitly requires "Chainlink-secured oracle" as a checkbox, OCMRO's technical merits don't matter — the brand is the product. This is real in TradFi-adjacent DeFi.
- **Migration to Ethereum L1.** If HPDX ever deploys on mainnet where gas is $5-50/tx, OCMRO's model (N individual transactions per round) becomes expensive. OCR's "N observations compressed into 1 tx" is genuinely valuable there. On Base at $0.002/tx, this advantage is negligible.

Neither condition exists today. HPDX is staying on Base, and no current deal requires the Chainlink badge.

### Q3: What are the unknown pitfalls with OCMRO?

- **You are the security team.** There's no battle-tested framework underneath — the aggregator contract is greenfield Solidity. A subtle bug in the median calculation, staleness check, or circuit breaker could go undetected. Chainlink's contracts have years of adversarial exposure. Mitigation: thorough audit (AI-assisted first, professional firm second), plus a burn-in period running the new aggregator in parallel with the existing oracle before cutover.
- **Reporter coordination at scale.** With 1-3 reporters, this is trivial. At 10+, you'll deal with: monitoring who's online, handling disputes if someone claims the median is wrong, and defining what happens when a reporter consistently deviates. There's no protocol handling this for you — you build the tooling or it stays manual.
- **Perceived legitimacy.** "We built our own oracle" can sound like "we graded our own homework" to a skeptic, even when the math is deterministic and every submission is on-chain. The transparency dashboard helps, but it's a narrative you'll need to actively manage.
- **Owner key centralization.** The contract owner can add/remove reporters and change config. Until that moves to a multisig or governance, it's a centralization vector that a critic could point to. (CRE has the same issue — someone deploys the workflow — but people don't ask about it because "it's Chainlink.")

### Q4: What's the community/trader sentiment?

Depends on the audience:

- **Crypto-native DeFi traders** will respect OCMRO *more* if explained well. On-chain verifiable, every submission is a public tx, no black-box DON consensus. "Don't trust, verify" is the ethos. The transparency dashboard makes this tangible.
- **Institutional/TradFi-adjacent** will ask "is it Chainlink?" and if the answer is no, there'll be follow-up questions. Not a dealbreaker, but more explaining.
- **Partners asked to run reporters** — OCMRO wins unambiguously. `docker run` + env vars is approachable. CRE offers no equivalent path. Flux Aggregator requires full Chainlink node ops — not an ask you'd make of a business partner.

**Bottom line**: You won't lose a deal over this. The hashprice is deterministic — anyone can independently verify it regardless of which oracle delivers it. The oracle choice affects *operational trust*, not *mathematical truth*.

### Q5: If cost is negligible, is this just build vs buy? And does OCMRO make us "more about the community"?

Yes, this is exactly the framing — and it's heavily tilted toward build for this use case:

- **CRE is not really "buy."** There's no turnkey product. You're still writing custom code (CRE workflows in their SDK), still managing deployment, still paying for execution. You're just doing it inside Chainlink's framework. The "buy" savings are minimal.
- **Flux Aggregator is not really "buy" either.** You deploy Chainlink's standard contract, but you still recruit operators, negotiate SLAs, fund LINK, and manage the feed. The operational overhead is comparable to OCMRO but with more coordination friction.
- **Community participation only exists in OCMRO.** The DON is a closed set of Chainlink-operated nodes. Flux Aggregator operators are professional Chainlink node runners, not your community. External contributors cannot join DON consensus. If community participation, partner onboarding, or HPOW incentives matter — OCMRO is the only path.
- **OCMRO is genuinely "more about the community."** Open-source Docker image, anyone can inspect the code, pull it, run it, and their submissions are individually visible on-chain. That's a real community oracle story. CRE's story is "trust Chainlink's nodes" — fine for credibility, but it's not *your* community contributing.

### Q6: As the DevSecOps person — more or less headaches with OCMRO?

**OCMRO gives you more work upfront, less pain ongoing. CRE gives you less work upfront, more pain when something breaks.**

OCMRO operational burden:
- You own the contract — deploy, upgrade, and audit cycles are on you
- Reporter Docker image CI/CD — straightforward, same pattern as the existing Lambda pipeline
- Monitoring/alerting — you build it (see [05-monitoring-design.md](05-monitoring-design.md)), but it's standard infra
- **You do not manage other reporters' wallets or infrastructure.** Each contributor funds their own Base wallet and runs their own Docker instance. Your responsibility is your own reporter instances and the contract itself.
- The upside: when something breaks at 2am, you can read the code, diagnose it, and fix it. No support tickets, no waiting on anyone's timeline.

CRE operational burden:
- Less contract code to own (DON handles aggregation)
- But: CRE SDK versioning, WASM compilation, Workflow Registry interactions — all things that can break in ways you can't debug because the DON is a black box
- When CRE has an issue, you're filing GitHub issues or Discord messages and waiting
- LINK token management — funding, monitoring balance, topping up
- Ethereum mainnet wallet management for Workflow Registry (separate from Base)
- CRE is still v1.x — expect breaking changes, sparse docs, and "works on testnet, different on mainnet" moments

Flux Aggregator operational burden:
- Operator recruitment and SLA management — ongoing relationship management
- LINK funding — monitor aggregator balance, top up regularly
- When an operator goes offline, you need to find a replacement via Discord
- Legacy protocol — decreasing community knowledge and tooling support over time

**As the person who'll be paged at 2am**: OCMRO is code you wrote, running in infrastructure you control, with logs you can read. CRE is someone else's distributed system that you can observe but not inspect. Flux Aggregator is third-party operators you're coordinating on a legacy protocol.

### Q7: If I don't care about community reporting — why NOT just use CRE?

Fair question. If community participation and HPOW incentives are off the table, CRE's pitch becomes stronger: battle-tested DON consensus, Chainlink brand, no custom aggregation contract to audit. Here's what still argues against it:

- **Unknown cost.** LINK per-execution pricing for CRE is not published. For a feed updating every 5 minutes (288 executions/day, ~8,640/month), even $0.01/execution is $86/month in LINK *before* gas. You're signing up for an open-ended bill with no published rate card. OCMRO's costs are fully predictable.
- **Data source opacity.** With OCMRO, every reporter controls their own Bitcoin RPC and you can verify the source. With CRE, DON nodes use Chainlink's infrastructure — you cannot verify which Bitcoin data source they use for a given observation. For deterministic data where the whole point is "anyone can independently compute this," giving up control of the data source is a meaningful concession.
- **You still write custom code.** CRE isn't plug-and-play. You write TypeScript workflows, compile to WASM, manage the Workflow Registry on Ethereum mainnet, and maintain a LINK balance. The development effort is comparable to OCMRO — you're just doing it in Chainlink's SDK instead of a Docker image.
- **Debugging is harder.** When a CRE workflow produces an unexpected result, you can't inspect the DON's execution. You see the output. With OCMRO, you have full logs, full on-chain history of every individual submission, and you can reproduce any reporter's calculation locally.
- **No flexibility to add community later.** If you start with CRE and later decide community participation matters, you'd need to build OCMRO anyway. Starting with OCMRO doesn't preclude CRE — it can always be evaluated later if a business need arises.
- **CRE is v1.x.** The platform is new. Base support launched with v1.0.0. Documentation is incomplete (no pricing tables, limited examples for custom data feeds). Early adopters absorb the pain of breaking changes and sparse support.

**The honest bottom line**: CRE is a reasonable choice if you genuinely don't care about community participation, are comfortable with unknown LINK costs, and value "Chainlink-powered" branding. But even in that scenario, OCMRO is faster to production, cheaper to operate, more transparent, and keeps the door open for community and CRE alike.

---

## 9. References

### OCMRO (custom-built)

| Source | URL | Accessed |
|--------|-----|----------|
| AggregatorV3Interface API Reference | https://docs.chain.link/data-feeds/api-reference | April 2026 |
| AggregatorV3Interface.sol Source Code | https://github.com/smartcontractkit/chainlink/blob/contracts-v1.3.0/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol | April 2026 |
| OpenZeppelin UUPS Proxy Pattern | https://docs.openzeppelin.com/contracts/5.x/api/proxy#UUPSUpgradeable | April 2026 |
| Hardhat Documentation | https://hardhat.org/docs | April 2026 |
| Base Network Fees | https://docs.base.org/base-chain/network-information/network-fees | April 2026 |
| Base Gas Tracker | https://basescan.org/gastracker | April 2026 |
| Alchemy Bitcoin API Reference | https://docs.alchemy.com/reference/bitcoin-api-quickstart | April 2026 |

### Chainlink Flux Aggregator

| Source | URL | Accessed |
|--------|-----|----------|
| Chainlink Flux Monitor Job Spec (within Job Types docs) | https://docs.chain.link/chainlink-nodes/oracle-jobs/all-jobs | April 2026 |
| FluxAggregator.sol Source Code (v0.6) | https://github.com/smartcontractkit/chainlink/blob/develop/contracts/src/v0.6/FluxAggregator.sol | April 2026 |
| Chainlink Node Requirements | https://docs.chain.link/chainlink-nodes/resources/requirements | April 2026 |
| Chainlink: 3 Levels of Data Aggregation in Price Feeds | https://blog.chain.link/levels-of-data-aggregation-in-chainlink-price-feeds/ | April 2026 |
| Deep Dive: Decentralized Data Model with FluxAggregator (Medium) | https://medium.com/@AlexAlekhinEth/chainlink-part-3-decentralized-data-model-with-fluxaggregator-511582e665dc | April 2026 |
| LinkWell Nodes: Building Custom Flux Monitor DON | https://docs.linkwellnodes.io/blog/Build-A-Chainlink-Price-Feed-With-Flux-Aggregator | April 2026 |
| LinkWell Nodes: How to Find a Chainlink Oracle | https://docs.linkwellnodes.io/blog/How-To-Find-A-Chainlink-Oracle | April 2026 |

### Chainlink Functions

| Source | URL | Accessed |
|--------|-----|----------|
| Chainlink Functions Documentation | https://docs.chain.link/chainlink-functions | April 2026 |
| Functions Architecture | https://docs.chain.link/chainlink-functions/resources/architecture | April 2026 |
| Functions Service Limits | https://docs.chain.link/chainlink-functions/resources/service-limits | April 2026 |
| Functions Supported Networks (includes Base) | https://docs.chain.link/chainlink-functions/supported-networks | April 2026 |
| Functions Billing | https://docs.chain.link/chainlink-functions/resources/billing | April 2026 |
| Functions Secrets Management | https://docs.chain.link/chainlink-functions/resources/secrets | April 2026 |
| Functions Tutorials | https://docs.chain.link/chainlink-functions/tutorials | April 2026 |
| Chainlink Automation Documentation | https://docs.chain.link/chainlink-automation | April 2026 |

### Chainlink CRE

| Source | URL | Accessed |
|--------|-----|----------|
| CRE Documentation | https://docs.chain.link/cre | April 2026 |
| CRE Custom Data Feed Template | https://docs.chain.link/cre-templates/custom-data-feed | April 2026 |
| CRE Supported Networks | https://docs.chain.link/cre/supported-networks-ts | April 2026 |
| CRE Deploying Workflows | https://docs.chain.link/cre/guides/operations/deploying-workflows | April 2026 |
| CRE TypeScript WASM Runtime | https://docs.chain.link/cre/concepts/typescript-wasm-runtime | April 2026 |
| CRE Introducing Blog Post | https://blog.chain.link/introducing-chainlink-runtime-environment/ | April 2026 |
| CRE HTTP Capability | https://docs.chain.link/cre/capabilities/http | April 2026 |
| CRE Confidential HTTP Client | https://docs.chain.link/cre/guides/workflow/using-confidential-http-client | April 2026 |
| Chainlink Payment Abstraction | https://blog.chain.link/introducing-chainlink-runtime-environment/ | April 2026 |

### Shared / Cross-Cutting

| Source | URL | Accessed |
|--------|-----|----------|
| OCR Architecture Overview | https://docs.chain.link/architecture-overview/off-chain-reporting | April 2026 |
| OCR3 Protocol Paper | https://research.chain.link/ocr3.pdf | April 2026 |
| AggregatorV3Interface API Reference | https://docs.chain.link/data-feeds/api-reference | April 2026 |
