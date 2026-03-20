# DEV environment: Arbitrum → Base (planning)

This document inventories **`.bedrock`** and **`.github`** touchpoints across **hashprice-oracle**, **futures-marketplace**, and **derivatives-marketplace** for cutting DEV over from Arbitrum testnet (today: **Arbitrum Sepolia**, chain id **421614**) to **Base** (typically **Base Sepolia** for DEV, chain id **84532**—confirm with smart contracts). It is a checklist for sequencing work once addresses, start blocks, and RPC endpoints exist.

**Assumption:** For most services, the change is **configuration** (Terraform vars, GitHub Actions variables/secrets, Secrets Manager values) plus **redeploy / task restart** so new env propagates. The main exception is **subgraph hosting**: moving to **GoldSky** may require **URL shape and auth** changes, not only new IDs.

---

## Inputs to collect before cutover

From smart contracts / protocol:

- All contract addresses used in DEV (clone factory, futures, perps, oracles, tokens, multicall if not universal).
- **Deployment block** (or start block) per indexed contract for subgraph manifests.
- Target **chain id** and canonical **network name** (for subgraph `network`, Hardhat/network config, and any app `NETWORK` / `REACT_APP_CHAIN_ID`).
- Whether **spot** / shared **hashprice-oracle** `wallets` contracts are also deployed on Base or remain on another chain (see hashprice-oracle `.bedrock/02-dev/terraform.tfvars`—everything in `wallets` and `oracle_lambda.chain_id` must be consistent with the chain the services actually use).

From infrastructure:

- **Alchemy** (or other) HTTPS/WebSocket URLs for the Base network used in DEV, plus any separate keys for CI vs AWS.
- **GoldSky** (or other) **GraphQL HTTP endpoints** (and auth scheme) for: oracles subgraph, futures subgraph, derivatives subgraph—or a decision to stay on The Graph Studio / Gateway with new deployment IDs only.

---

## Sequencing (dependency order)

1. **RPC and keys** — Create Base app(s) in Alchemy; store URLs in the places listed under “Secrets” (GitHub org/repo secrets and `secret.auto.tfvars` / AWS Secrets Manager). Until this exists, nothing can talk to Base.
2. **Contracts on Base** — Deploy and freeze addresses + start blocks.
3. **Subgraphs** — Stand up indexing on GoldSky (or redeploy to The Graph against Base). Obtain **stable query URLs** and/or **subgraph identifiers** compatible with how apps and Terraform build URLs today.
4. **GitHub variables & secrets** — Update per-repo and per-environment (`dev`) values: chain, addresses, blocks, RPC secret contents, subgraph-related vars, block explorer URLs, Chainlink (or other) price feed for keeper if applicable.
5. **`.bedrock` git changes** — Commit updates to `02-dev/terraform.tfvars` (and any code/Terraform if GoldSky URLs are not Gateway-shaped).
6. **Terraform / Terragrunt apply** — Apply in each AWS account for `02-dev` so Lambda env, ECS task secrets, and constructed secret JSON (e.g. subgraph URLs) match Base.
7. **Application redeploys** — Lambdas (new code only if needed; often **update function** or **force ECS deployment** picks up new secrets). Rebuild and deploy **futures UI** so `REACT_APP_*` embeds Base config.
8. **Verification** — On-chain reads/writes, subgraph `_meta` / entity queries, health monitor Lambdas, and end-to-end UI flows.

Parallel track: GoldSky project creation and subgraph sync can run **before** contract finality if you use placeholder manifests; final **start blocks** and **addresses** must match production deployment.

---

## hashprice-oracle

### `.bedrock/02-dev/terraform.tfvars` (version-controlled)

- **`wallets`**: every address that points at Arbitrum Sepolia today must be updated to Base Sepolia (or confirmed unchanged if shared across chains—unlikely for deployment-specific contracts).
- **`oracle_lambda.chain_id`**: currently `"421614"` → Base Sepolia **`84532`** (or chosen DEV chain).
- Comments referencing Arbitrum should be updated to avoid operational confusion.

### Sensitive / local Terraform inputs (`secret.auto.tfvars` — not in repo; see README)

Typically includes:

- **`ethereum_rpc_url`**, **`spot_eth_rpc_url`**, **`oracle_lambda_secrets`** (includes `eth_rpc_url`), **`admin_api_key`**, **`graph_api_key`**, **`futures_subgraph_id`**, **`oracles_subgraph_id`**, Bitcoin RPC URLs for oracle lambda, etc.

All **EVM RPC URLs** used here should switch to **Base** endpoints. **Subgraph IDs / API keys** change if subgraphs are redeployed or if GoldSky replaces Gateway auth.

### Subgraph health monitor (The Graph Gateway today)

- **`.bedrock/.terragrunt/72_subgraph_health_monitor.tf`** sets `THEGRAPH_GATEWAY_BASE` to `https://gateway.thegraph.com/api` and passes the monitor secret ARN.
- **`.bedrock/.terragrunt/72_subgraph_health_monitor.py`** builds URLs as `{THEGRAPH_GATEWAY_BASE}/{api_key}/subgraphs/id/{subgraph_id}`.

If GoldSky endpoints **do not** follow that path pattern, this is **not** a variables-only change: you need either **configurable full base URL + auth**, or a **separate health check** implementation. If GoldSky exposes a Gateway-compatible URL, you may only update secrets/vars.

### `.github` — `deploy-hr-btc-oracles.yml`

**Repository / org variables (examples):**

- `NETWORK`
- `HASHRATE_ORACLE_ADDRESS`, `START_BLOCK_HASHRATE_ORACLE`, `HASHRATE_ORACLE_POLLING_BLOCK_INTERVAL`
- `BTC_TOKEN_ORACLE_ADDRESS`, `START_BLOCK_BTC_TOKEN_ORACLE`, `BTC_TOKEN_ORACLE_POLLING_BLOCK_INTERVAL`
- `DEV_GRAPH_USERID` (and stg/lmn if you keep parity)
- `GNS_SUBGRAPH_ID`

**Secrets (examples):**

- `ARBITRUM_RPC_URL_MAIN` — used by workflow steps for on-chain reads despite the name; **point value at Base RPC** or introduce a **chain-neutral** secret name in a follow-up refactor.
- `PINATA_JWT`, `{DEV,STG,LMN}_GRAPH_DPKY`, `{DEV,STG,LMN}_GNS_PUBLISHER_KEY`, `SLACK_WEBHOOK_URL`, `AWS_ROLE_ARN_*` (unchanged unless account/OIDC changes).

If subgraph deploy moves from **The Graph Studio** to **GoldSky**, this workflow may need **different CLI/auth steps**—treat as a **workflow product change**, not only vars.

Other workflows: **`deploy-oracle-update.yml`** uses `AWS_ROLE_ARN_*` only for Lambda deploy (no chain vars in workflow; chain comes from AWS-side config populated by Terraform).

---

## futures-marketplace

### `.bedrock/02-dev/terraform.tfvars` (version-controlled)

- **`market_maker.chain_id`**: `421614` → Base DEV chain id.
- **Contract addresses**: `clone_factory_address`, `hashrate_oracle_address`, `futures_address`, `multicall_address` — update to Base deployment (**verify Multicall3 on Base**; many chains use `0xcA11bde05977b3631167028862bE2a173976CA11` but confirm).
- **`market_maker` comment** referencing Arbitrum Sepolia / Graph lag — update for accuracy if still relevant.

### `secret.auto.tfvars` / Terraform variables

- **`ethereum_rpc_url`**, **`market_maker_private_key`**, **`graph_api_key`**, **`futures_subgraph_id`**, **`oracles_subgraph_id`**, **`telegram_bot_token`**, etc.

### `.bedrock/.terragrunt/01_secrets_manager.tf` (structural note)

`market_maker` and `margin_call` secret JSON embed:

`https://gateway.thegraph.com/api/${var.graph_api_key}/subgraphs/id/${var.futures_subgraph_id}`

(and oracles where applicable). **GoldSky** may require **different URL composition** → possible Terraform change to use **full URL variables** or provider-specific templates.

### `.github`

**`deploy-futures-ui.yml`** (environment `dev`):

- **Secrets:** `DEV_GRAPH_APIKEY`, `REACT_APP_READ_ONLY_ETH_NODE_URL`, `REACT_APP_WALLET_CONNECT_ID`
- **Variables:** `DEV_FUTURES_SUBGRAPH_ID`, `DEV_ORACLES_SUBGRAPH_ID`, `DEV_DERIVATIVES_SUBGRAPH_ID`, plus all `REACT_APP_*` used in the generated `ui/.env` (chain id, clone factory, multicall, futures token, perps token, indexer URL, etherscan → **basescan** URL, etc.)

Subgraph URLs in the workflow are built as **The Graph Gateway** URLs today; if using GoldSky, either **change the build logic** or store **full URLs** in vars and stop concatenating.

**`update-futures-oracle.yml`:** same subgraph + `NETWORK`, `REACT_APP_FUTURES_TOKEN_ADDRESS`, `START_BLOCK_FUTURES`, Graph Studio mapping, and **`ARBITRUM_RPC_URL_MAIN`** for GNS/publisher steps.

**`update-futures-contracts.yml`:** `ETH_NODE_ADDRESS`, `FUTURES_ADDRESS`, Etherscan/API keys, owner keys — must target **Base** RPC and **Basescan**-compatible API if used.

**`deploy-market-maker.yml` / `deploy-margin-call.yml` / `deploy-notifications.yml`:** primarily AWS OIDC and artifact deploy; **runtime chain** comes from Terraform + Secrets Manager, not usually from workflow env.

---

## derivatives-marketplace

### `.bedrock/02-dev/terraform.tfvars` (version-controlled)

- **`perpskeeper_service.network`** and **`marketmaker_service.network`**: currently `"arbitrum-sepolia"` → whatever string the **keeper** and **market maker** images expect for Base (e.g. `base-sepolia` or project-specific alias—**must match application code**).
- **Contract addresses:** `clone_factory_address`, `hashrate_oracle_address`, `perps_address`, `multicall_address`.

### `secret.auto.tfvars`

- **`ethereum_rpc_url`**, **`perpskeeper_private_key`**, **`marketmaker_private_key`**, **`graph_api_key`**, **`derivatives_subgraph_id`**, **`oracles_subgraph_id`**.

### `.bedrock/.terragrunt/01_secrets_manager.tf`

Perps keeper secret includes **`futures_subgraph_url`** / **`oracles_subgraph_url`** built from **The Graph Gateway** pattern—same GoldSky caveat as futures.

### `.github`

**`update-derivatives-oracle.yml`:**

- **Variables:** `NETWORK`, `PERPS_ADDRESS`, `PERPS_START_BLOCK`, `PRICE_ORACLE_ADDRESS`, collateral / fee / margin vars, etc.
- **Secrets:** `ETH_NODE_ADDRESS`, `ARBITRUM_RPC_URL_MAIN` (again: value → Base RPC or rename), `PINATA_JWT`, Graph deploy keys, GNS publisher keys, `SLACK_WEBHOOK_URL`.

**`deploy-perps-keeper.yml`:** injects **`KEEPER_ETH_PRICE_FEED_ADDRESS`** (and other keeper vars) from GitHub **environment** variables—on Base, the **Chainlink (or other) feed address** differs from Arbitrum; update `dev` environment var accordingly. RPC and subgraph data still come from AWS secrets on the task.

**`deploy-market-maker.yml`:** similar pattern; confirm any chain-specific env is updated in task definition / secrets.

---

## GitHub: inventory by name (DEV-focused)

Names below appear in workflows; **values** move to Base. STG/LMN are listed where the same name pattern applies for later phases.

| Kind | Name(s) |
|------|---------|
| Org/repo **variables** | `NETWORK`, contract addresses, `START_BLOCK_*`, `REACT_APP_*` (chain, explorer, tokens, factory, multicall, indexer URL, …), `DEV_FUTURES_SUBGRAPH_ID`, `DEV_ORACLES_SUBGRAPH_ID`, `DEV_DERIVATIVES_SUBGRAPH_ID`, `DEV_GRAPH_USERID`, `GNS_SUBGRAPH_ID`, keeper tuning vars (`KEEPER_*`, `PERPS_ADDRESS`, `KEEPER_ETH_PRICE_FEED_ADDRESS`, …) |
| Org/repo **secrets** | `ARBITRUM_RPC_URL_MAIN` (Base URL in practice today), `ETH_NODE_ADDRESS`, `REACT_APP_READ_ONLY_ETH_NODE_URL`, `{DEV,STG,LMN}_GRAPH_APIKEY`, `{DEV,STG,LMN}_GRAPH_DPKY`, `{DEV,STG,LMN}_GNS_PUBLISHER_KEY`, `PINATA_JWT`, contract ops keys (`OWNER_PRIVATEKEY`, …), `ETHERSCAN_API_KEY` / Basescan equivalent if used, `AWS_ROLE_ARN_*`, `SLACK_WEBHOOK_URL` |

Exact set depends on which workflows you run for DEV; grep each repo’s `.github/workflows` for `vars.` and `secrets.` when implementing.

---

## Alchemy

- Create a **Base Sepolia** app (and mainnet app when STG/LMN migrate).
- Replace RPC URLs everywhere **DEV** reads them: GitHub secrets, each repo’s `secret.auto.tfvars`, and any manual copies in 1Password/runbooks.
- If you use **websocket** URLs for any service, provision those explicitly.

---

## GoldSky vs “variables only”

| Area | Variables / secrets only | Likely code or Terraform change |
|------|---------------------------|----------------------------------|
| `.bedrock` contract addresses, `chain_id`, `network` string | Yes | — |
| Alchemy RPC URLs | Yes | — |
| Subgraph **deployment** via The Graph Studio with Gateway query URLs | Yes (new IDs + keys) | — |
| Subgraph hosting on GoldSky with **different URL or auth** | Partial | Terraform secret JSON URL builder; futures UI `.env` URL builder; hashprice health monitor Lambda |
| `deploy-*-oracle.yml` **publish** steps (Studio vs GoldSky) | Maybe | Workflow steps and secrets |

---

## After merge of `.bedrock` changes

- **`infra-update.yml`** (all three repos) notifies on `.bedrock` pushes to `dev`; no chain-specific edits required.
- Run **Terragrunt/Terraform** for `02-dev` in each repo’s `.bedrock` layout so AWS resources and Secrets Manager versions update.
- **ECS:** `force-new-deployment` where task defs reference secrets that changed.
- **Lambda:** update code if needed; otherwise configuration/secret changes may still require **publish version** / alias updates depending on how functions resolve env (check current patterns per service).

---

## Suggested doc maintenance

As decisions land (exact GoldSky URL format, final network slug for keeper, whether RPC secret gets renamed), update this file so it stays the single **DEV Base** checklist for the three repos.
