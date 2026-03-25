# DEV environment: Arbitrum → Base (planning)

This document inventories **`.bedrock`** and **`.github`** touchpoints across **hashprice-oracle**, **futures-marketplace**, and **derivatives-marketplace** for cutting DEV over from Arbitrum testnet (today: **Arbitrum Sepolia**, chain id **421614**) to **Base** (typically **Base Sepolia** for DEV, chain id **84532**—confirm with smart contracts). It is a checklist for sequencing work once addresses, start blocks, and RPC endpoints exist.

**Assumption:** For most services, the change is **configuration** (Terraform vars, GitHub Actions variables/secrets, Secrets Manager values) plus **redeploy / task restart** so new env propagates. The main exception is **subgraph hosting**: moving to **GoldSky** may require **URL shape and auth** changes, not only new IDs.

### Goldsky project: DEV-Exchange (DEV subgraph host)

| | |
|--|--|
| **Dashboard name** | DEV-Exchange |
| **Project ID** | `project_cmmz59uoa7b5201wthnkxbuqy` |

**URL pattern** (after subgraphs exist; replace `<name>` / `<tag>` per deploy):

- Public: `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/<name>/<tag>/gn`
- Private: `https://api.goldsky.com/api/private/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/<name>/<tag>/gn` (requires `Authorization: Bearer <token>` per [GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints))

**Secrets:** Keep **API keys only** in GitHub Actions secrets, `secret.auto.tfvars`, or AWS Secrets Manager—**never** in this repo. If a key was pasted into chat, docs, or screenshots, **rotate it** in [Project settings](https://app.goldsky.com/dashboard/settings#general) and update consumers.

### Live DEV endpoints (Base Sepolia)

| Subgraph | Tag | Chain | Public GraphQL URL |
|---|---|---|---|
| `lumerin-oracles` | `dev-latest` | base-sepolia | `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/lumerin-oracles/dev-latest/gn` |
| `lumerin-futures` | `dev-latest` | base-sepolia | `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/lumerin-futures/dev-latest/gn` |
| `lumerin-derivatives` | `dev-latest` | base-sepolia | `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/lumerin-derivatives/dev-latest/gn` |

### Base Sepolia contract addresses (DEV)

| Name | Address | Start block |
|---|---|---|
| `HASHRATE_ORACLE_ADDRESS` | `0xf97a1bbfb5e061ef73dad8ebf25939d93639fb7f` | `39295132` |
| `BTCUSDC_ORACLE_ADDRESS` | `0x614dcafa33af0705c7b4a37667ef511f400f36d0` | `39294964` |
| `USDC_TOKEN_ADDRESS` | `0xdd15eed84065a58c9e9ff9e95fb996be0fff22aa` | — |
| `FUTURES_ADDRESS` | `0x56d8d4a03a0f34b93b86e0b7941aff29178d0479` | `39295843` |
| `PERPS_ADDRESS` | `0x0d412BC34a48e434144687Aac03b9C593F5237B6` | `39298170` |

---

## Goldsky: deploy from source — worked example (oracles / DEV-Exchange)

Procedure validated for **hashprice-oracle** oracles subgraph on **Arbitrum Sepolia** into Goldsky project **DEV-Exchange**. The same shape applies to **futures** and **derivatives** (each repo has its own `indexer/` template and env vars).

### Why build from source

Matches existing CI (`graph codegen` / `graph build`), keeps **ABI + mappings** in-repo, and avoids the **IPFS hash** migration path unless you want it ([Deploy a subgraph](https://docs.goldsky.com/subgraphs/deploying-subgraphs)).

### Steps

1. **Working directory** — `hashprice-oracle/indexer/` (contains `subgraph.template.yaml`, `package.json`, generated `subgraph.yaml`, and `build/` after compile).

2. **Local env file** — `cp .env.example .env` and fill values (`NETWORK`, oracle addresses, `START_BLOCK_*`, polling intervals). `.env.example` documents **Arbitrum Sepolia DEV**-style defaults; update when changing chain.

3. **Generate `subgraph.yaml`** — run **`yarn prepare-local`** (`source .env` + `envsubst` on `subgraph.template.yaml`).  
   - **Important:** **`yarn prepare:env`** only runs `envsubst` and does **not** load `.env`. If variables are not already **exported** in the shell, substitutions are **empty** and `graph codegen` fails (e.g. invalid `filter.every`, blank `network`).  
   - Requires **`envsubst`** (on macOS, often via `brew install gettext`).

4. **Compile** — `yarn codegen` then `yarn build`.

5. **Goldsky CLI auth** — `goldsky login` and paste the **API key for the Goldsky project** you are deploying into (e.g. DEV-Exchange for dev). Keys are **project-scoped**—use the key that belongs to that project.

6. **Deploy bundle** — from `indexer/`:
   ```bash
   goldsky subgraph deploy <subgraph-name>/<semver> --path . --token "$GOLDSKY_API_KEY"
   ```
   **Example:** `goldsky subgraph deploy lumerin-oracles/1.0.1 --path . --token "$GOLDSKY_API_KEY"`  
   CLI returns a **public** GraphQL URL for the version.

7. **Tag for stable URL (separate step)** — `--tag` on `deploy` fails if the deployment takes longer than expected (Goldsky creates the version asynchronously). Run **`tag create`** as a second command after deploy completes ([Subgraph tags](https://docs.goldsky.com/subgraphs/tags)):
   ```bash
   goldsky subgraph tag create <subgraph-name>/<semver> --tag <rolling-tag> --token "$GOLDSKY_API_KEY"
   ```
   **Example:** `goldsky subgraph tag create lumerin-oracles/1.0.1 --tag dev-latest --token "$GOLDSKY_API_KEY"`  
   Consumers use the **tag** URL, e.g.  
   `https://api.goldsky.com/api/public/project_<id>/subgraphs/lumerin-oracles/dev-latest/gn`.

   **Repointing a tag** after a newer semver deploy (without changing the consumer URL):  
   `goldsky subgraph tag create lumerin-oracles/1.0.2 --tag dev-latest` — moves `dev-latest` to the new build.

8. **Public by default** — New subgraphs enable **public** GraphQL and leave **private** off until you toggle (dashboard or `goldsky subgraph update`) ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)). Fine for early DEV; tighten for STG/LMN as needed.

### Naming template (adjust for project layout)

If you use **one Goldsky project per environment** (e.g. DEV-Exchange), keep subgraph **names** short and use **tags** for the logical environment (`dev` / `stg` / `prod`), or adopt env-specific Goldsky projects and a tag like `stable`.

| Repo | Subgraph `<name>` (example) | `<semver>` | Consumer **tag** (example) |
|------|-----------------------------|------------|----------------------------|
| hashprice-oracle | `lumerin-oracles` | `1.0.0`, `1.0.1`, … | `dev`, `stg`, `prod` |
| futures-marketplace | `lumerin-futures` | semver | same |
| derivatives-marketplace | `lumerin-derivatives` | semver | same |

**Command pattern:**

```bash
goldsky subgraph deploy lumerin-<product>/<semver> --path . --token "$GOLDSKY_API_KEY"
goldsky subgraph tag create lumerin-<product>/<semver> --tag <rolling-tag> --token "$GOLDSKY_API_KEY"
```

### Compared to The Graph Studio (practical)

Same **manifest + AssemblyScript/WASM** indexing model. Operational differences that matter here: **CLI deploy** straight into a Goldsky project (less Studio + IPFS ceremony for this workflow), **dashboard** indexing visibility, **tags** for stable query URLs, and optional **private** endpoints plus **Scale**-tier rate-limit adjustments ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)). Plan CI and Terraform/UI around **full Goldsky URLs** (or project id + name + tag), not only The Graph Gateway `subgraphs/id/...` URL assembly.

### CI/CD template (reference for workflow refactor)

Use this when replacing The Graph Studio / IPFS steps (see current `deploy-hr-btc-oracles.yml`) with Goldsky. Adjust job boundaries to match how you already **prepare** `subgraph.yaml` in CI.

**Convention:** Apps and Terraform point at the **rolling tag** URL so they always hit the latest deploy from this pipeline, while Goldsky still records each build under **`${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}`** for audit and rollback.

| Variable | Example source | Purpose |
|----------|----------------|---------|
| `GOLDSKY_API_KEY` | GitHub Actions **secret** (per Goldsky project / env) | Non-interactive auth — **never** log or echo |
| `GOLDSKY_SUBGRAPH_NAME` | Repo or env **variable** (e.g. `lumerin-oracles`) | First segment of `name/version` |
| `SUBGRAPH_SEMVER` | Pipeline output (e.g. existing **gen-tag** / release semver) | Second segment; must be a **new** version string for each deploy Goldsky should treat as distinct |
| `GOLDSKY_ROLLING_TAG` | Constant, e.g. `dev-latest` | Tag updated every run → stable URL `.../subgraphs/<name>/dev-latest/gn` |
**Semver in the pipeline:** Reuse whatever you already compute for releases (hashprice-oracle `.github/actions/gen-tag` or equivalent). Goldsky identifies a deployment as `<name>/<semver>`; if you **re-deploy the same semver**, confirm Goldsky’s behavior for your account (overwrite vs error). Safer patterns if duplicates bite: bump patch per CI run, append prerelease (e.g. `1.2.3-ci.4821`), or use build metadata.

**Auth in CI:** Use **`--token "$GOLDSKY_API_KEY"`** on every command ([CLI](https://docs.goldsky.com/reference/cli)) instead of `goldsky login`. The org secret **`DEV_GOLDSKY_API_KEY`** (set at the GitHub organization level) provides this for all repos.

**Two-step deploy + tag** — deploy and tag must be **separate commands**. Goldsky creates versions asynchronously; `--tag` on `deploy` races against version creation and fails if the version isn’t ready yet:

```bash
goldsky subgraph deploy "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" \
  --path . \
  --token "${GOLDSKY_API_KEY}"

goldsky subgraph tag create "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" \
  --tag "${GOLDSKY_ROLLING_TAG}" \
  --token "${GOLDSKY_API_KEY}"
```

**GitHub Actions sketch** (drop into a deploy job after build artifacts exist; install CLI once per job):

```yaml
- name: Install Goldsky CLI
  run: npm install -g @goldskycom/cli

- name: Deploy subgraph to Goldsky
  working-directory: indexer
  env:
    GOLDSKY_API_KEY: ${{ secrets.DEV_GOLDSKY_API_KEY }}
    GOLDSKY_SUBGRAPH_NAME: ${{ vars.GOLDSKY_SUBGRAPH_NAME }}
    SUBGRAPH_SEMVER: ${{ needs.version.outputs.semver }}
    GOLDSKY_ROLLING_TAG: dev-latest
  run: |
    goldsky subgraph deploy "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" \
      --path . \
      --token "${GOLDSKY_API_KEY}"

    goldsky subgraph tag create "${GOLDSKY_SUBGRAPH_NAME}/${SUBGRAPH_SEMVER}" \
      --tag "${GOLDSKY_ROLLING_TAG}" \
      --token "${GOLDSKY_API_KEY}"
```

**Prepare step reminder:** In CI, either **export** all template variables before `yarn prepare:env`, or **generate `.env`** and run the same prepare pattern as local (`prepare-local` is interactive-file-oriented; many pipelines already inject env and call `prepare:env` — see [step 3](#steps) above).

### CI/CD refactor: Goldsky workflows (completed)

All three subgraph deploy workflows have been rewritten to use Goldsky, completely replacing The Graph Studio, IPFS/Kubo, Pinata, and GNS on-chain publishing:

| Repo | Workflow | Goldsky subgraph name |
|------|----------|-----------------------|
| hashprice-oracle | `deploy-hr-btc-oracles.yml` | `lumerin-oracles` |
| futures-marketplace | `update-futures-oracle.yml` | `lumerin-futures` |
| derivatives-marketplace | `update-derivatives-oracle.yml` | `lumerin-derivatives` |

**Pipeline flow:** `setup` → `build` → `deploy` → `verify` → `cleanup` → `notify`

The deploy job:
1. Installs the Goldsky CLI (`curl https://goldsky.com | sh`)
2. Queries the current deployment (pre-flight check via the tagged public endpoint)
3. Deploys with semver from `gen-tag` — handles "already exists" gracefully (pipeline re-runs)
4. Rolls the rolling tag to the new version (moves tag from old version if needed)
5. Verify job polls the tagged endpoint for `_meta` health for up to 60s

**Removed dependencies** (no longer needed for subgraph deploy):
- `ipfs/kubo` Docker service container
- `PINATA_JWT` secret
- `{DEV,STG,LMN}_GRAPH_DPKY` secrets (The Graph deploy keys)
- `{DEV,STG,LMN}_GNS_PUBLISHER_KEY` secrets
- `ARBITRUM_RPC_URL_MAIN` secret (was for GNS on-chain publish only)
- `DEV_GRAPH_USERID` / `STG_GRAPH_USERID` / `LMN_GRAPH_USERID` vars
- `GNS_SUBGRAPH_ID` var
- Foundry (`cast`) — was only for GNS contract calls
- Python3 base58 decode — was only for CID→bytes32 conversion

**New org-level secrets (already set):**

| Secret | Scope | Purpose |
|--------|-------|---------|
| `DEV_GOLDSKY_API_KEY` | Org | Goldsky project auth for DEV deploys |
| `STG_GOLDSKY_API_KEY` | Org | (future) Goldsky project auth for STG |
| `LMN_GOLDSKY_API_KEY` | Org | (future) Goldsky project auth for PROD |

**New org-level variables (to set):**

| Variable | Value | Purpose |
|----------|-------|---------|
| `DEV_GS_ORACLES` | `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/lumerin-oracles/dev-latest/gn` | Oracles endpoint for verify step + app config |
| `DEV_GS_FUTURES` | `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/lumerin-futures/dev-latest/gn` | Futures endpoint for verify step + app config |
| `DEV_GS_DERIVATIVES` | `https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/lumerin-derivatives/dev-latest/gn` | Derivatives endpoint for verify step + app config |

**Optional per-repo environment variable:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `GOLDSKY_SUBGRAPH_NAME` | Falls back to hardcoded default per repo | Override Goldsky subgraph name if naming convention changes |

**Rolling tag convention per environment:**

| Environment | Rolling tag | API key secret |
|-------------|-------------|----------------|
| `dev` | `dev-latest` | `DEV_GOLDSKY_API_KEY` |
| `stg` | `stg-latest` | `STG_GOLDSKY_API_KEY` |
| `main` | `lmn-latest` | `LMN_GOLDSKY_API_KEY` |

---

## Inputs to collect before cutover

From smart contracts / protocol:

- All contract addresses used in DEV (clone factory, futures, perps, oracles, tokens, multicall if not universal).
- **Deployment block** (or start block) per indexed contract for subgraph manifests.
- Target **chain id** and canonical **network name** (for subgraph `network`, Hardhat/network config, and any app `NETWORK` / `REACT_APP_CHAIN_ID`).
- Whether **spot** / shared **hashprice-oracle** `wallets` contracts are also deployed on Base or remain on another chain (see hashprice-oracle `.bedrock/02-dev/terraform.tfvars`—everything in `wallets` and `oracle_lambda.chain_id` must be consistent with the chain the services actually use).

From infrastructure:

- **Alchemy** (or other) HTTPS/WebSocket URLs for the Base network used in DEV, plus any separate keys for CI vs AWS.
- **Goldsky** (or other) **GraphQL HTTP endpoints** (and auth scheme)—see [Goldsky: bootstrap, CI, project layout, API keys](#goldsky-bootstrap-ci-project-layout-api-keys) below—or a decision to stay on The Graph Studio / Gateway with new deployment IDs only.

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

## Goldsky: bootstrap, CI, project layout, API keys

Official docs index: [docs.goldsky.com](https://docs.goldsky.com/) (full page list: [llms.txt](https://docs.goldsky.com/llms.txt)). Subgraph product overview: [Index onchain data with Subgraphs](https://docs.goldsky.com/subgraphs/introduction).

### Vocabulary (how Goldsky names things)

| Concept | Meaning |
|--------|---------|
| **Team** | Billing and member management ([Teams and projects](https://docs.goldsky.com/teams-and-projects)) |
| **Project** | Container for subgraphs, pipelines, hosted DBs, Compose apps, and collaborators. **API keys are scoped to a project**—a token for project A cannot access **private** endpoints in project B ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)) |
| **Subgraph name + version** | Deploy identity, e.g. `my-subgraph/1.0.0` ([Deploy a subgraph](https://docs.goldsky.com/subgraphs/deploying-subgraphs)) |
| **Tag** | Stable label (e.g. `prod`) attached to a version so the **GraphQL URL stays fixed** when you ship a new version ([Subgraph tags](https://docs.goldsky.com/subgraphs/tags)) |

Goldsky subgraphs are **The Graph–compatible** at the indexing layer; deploy and consume paths are Goldsky-specific ([introduction](https://docs.goldsky.com/subgraphs/introduction)).

### Bootstrap checklist

1. Under your **Team**, create or choose **Project(s)** (see [project layout](#goldsky-project-layout-9-graphs) below).
2. **Project Settings** → create an **API key** → CLI: `goldsky login` ([Deploy a subgraph](https://docs.goldsky.com/subgraphs/deploying-subgraphs)).
3. Per subgraph, either:
   - **From source** (typical for our repos): build with existing `graph` / `yarn` pipeline, then  
     `goldsky subgraph deploy <name>/<version> --path .`  
   - **From The Graph**:  
     `goldsky subgraph deploy <name>/<version> --from-ipfs-hash <hash>`  
     (hash from Studio explorer or `_meta { deployment }`) ([Migrate from The Graph](https://docs.goldsky.com/subgraphs/migrate-from-the-graph)).
4. Create **tags** for stable URLs per environment (e.g. `goldsky subgraph tag create oracles/1.0.0 --tag dev`) ([Subgraph tags](https://docs.goldsky.com/subgraphs/tags)).
5. Choose **public vs private** GraphQL endpoints and wire URLs + auth into Terraform / GitHub / apps ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)).
6. Monitor indexing: `goldsky subgraph list` or dashboard ([Migrate from The Graph](https://docs.goldsky.com/subgraphs/migrate-from-the-graph)).

### Local and CI (auto-publish)

- **CLI install:** `curl https://goldsky.com | sh` (macOS/Linux) or `npm install -g @goldskycom/cli` (Windows) ([Deploy a subgraph](https://docs.goldsky.com/subgraphs/deploying-subgraphs)).
- **CI:** same pattern as today (Node, `graph codegen` / `graph build`), then **`goldsky subgraph deploy`** instead of Studio/network publish. Authenticate with a **project API key** stored in GitHub Actions secrets (per environment/project).
- **Multiple projects:** each project needs its **own** key; switching projects in automation follows [Teams and projects](https://docs.goldsky.com/teams-and-projects) / CLI project commands (`goldsky project list`, `goldsky project create`, etc.).
- **Optional:** keep IPFS pin steps if builds still require it; deploy can remain `--path .` after local build.

### GraphQL URL shape (impacts Terraform & health monitor)

- **Public:**  
  `https://api.goldsky.com/api/public/project_<id>/subgraphs/<name>/<version-or-tag>/gn`  
- **Private:** same path with **`/api/private/`** instead of `/api/public/`; requests need **`Authorization: Bearer <token>`** ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)).

Default for new subgraphs: **public endpoint on**, **private off**; toggle via dashboard or  
`goldsky subgraph update <name>/<tag> --public-endpoint disabled --private-endpoint enabled` ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)).

This does **not** match `https://gateway.thegraph.com/api/<key>/subgraphs/id/<id>`—our **Terraform secret builders**, **futures UI `.env` construction**, and **hashprice subgraph health Lambda** need explicit updates unless we store **full URLs** in secrets/vars.

### Parity with nine graphs (3 products × 3 environments)

We need **nine indexers** (oracles, futures, derivatives × dev, stg, main), equivalent to today’s Studio naming.

- Use **tags** so consumers keep a **stable URL** when versions bump ([Subgraph tags](https://docs.goldsky.com/subgraphs/tags)).
- **Rate limits:** see [Private endpoints, terminology, and rate limits](#private-endpoints-terminology-and-rate-limits) below ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)).
- **Optional later:** [subgraph-driven webhooks](https://docs.goldsky.com/subgraphs/guides/send-subgraph-driven-webhooks) for ops—not required for GraphQL parity.

### Goldsky project layout (9 graphs)

**API keys are project-scoped** ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints))—the strongest isolation lever is **multiple projects**.

| Option | Shape | Notes |
|--------|--------|--------|
| **A. One project, nine subgraphs** | Names like `oracles-dev`, `futures-stg`, … *or* one name + tags `dev`/`stg`/`main` | Simplest billing; single deploy key can touch all subgraphs in that project (large blast radius). |
| **B. One project per environment (recommended)** | **Three** Goldsky projects (dev / stg / main), each with **three** subgraphs: oracles, futures, derivatives | Aligns with **titanio-dev / stg / lmn** and GitHub **environments**; CI secrets for dev never authenticate to prod. |
| **C. One project per product** | Three projects (oracle / futures / derivatives), each holding three env subgraphs or tags | Splits ownership by repo; still need clear env naming or tags. |

**Recommendation:** **B**—one Goldsky **project per environment**, three subgraphs per project, consistent names across projects (e.g. `lumerin-oracles`, `lumerin-futures`, `lumerin-derivatives`) plus a **stable tag** per consumer (or use tag name = env if you prefer).

Confirm with Goldsky whether Scale billing constraints affect number of projects.

### API keys and least privilege

- **Project boundary:** tokens do not cross projects for **private** endpoints ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)).
- **RBAC:** roles `Owner` / `Admin` / `Editor` / `Viewer` ([RBAC](https://docs.goldsky.com/rbac)). **`Editor`** can create/delete subgraphs and API keys. **`Viewer`** can still **view and reveal** API keys—do not treat Viewer as safe around secrets; limit membership and use **separate Goldsky users** where needed.
- **Docs do not describe per-subgraph API keys** within one project; segmentation is primarily **project separation + public/private toggles**.
- **Practical split:**  
  - **CI deploy:** one API key per Goldsky project (GitHub secret per `dev` / `stg` / `main`).  
  - **Private GraphQL in AWS:** Bearer token in Secrets Manager (server-side only).  
  - **Browser:** avoid embedding private tokens; use **public** endpoints only if data and rate limits are acceptable, or proxy via backend.

If the dashboard allows **multiple keys per project**, consider **deploy key** vs **query key** so rotating CI does not force app secret rotation (confirm behavior when revoking).

### Private endpoints, terminology, and rate limits

**Can subgraphs stay private and use an “API key”?**  
Yes, in Goldsky’s model. You can **disable the public URL** and **enable the private URL** per subgraph (and per **tag**) via CLI or dashboard ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)):

```bash
goldsky subgraph update <subgraph>/<tag> --public-endpoint disabled --private-endpoint enabled
```

**Terms to use:**

| Term | What it means |
|------|----------------|
| **Private endpoint** | GraphQL is served at `https://api.goldsky.com/api/private/project_<id>/subgraphs/.../gn` instead of `/api/public/...`. Unauthenticated requests should not succeed. |
| **API token / API key** | A **project** token from [Project general settings](https://app.goldsky.com/dashboard/settings#general). Sent as **`Authorization: Bearer <token>`** on each GraphQL HTTP request ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)). Same *class* of credential as you use for `goldsky login`; scope is **the whole project**, not a single subgraph. |
| **“Not public”** | Correct expectation: **random internet users** cannot query without the token. **Not** the same as “secret from your own users”: anyone who **has** the Bearer token can query the private endpoint (same as any shared API key). |

**Where to put the token for our stack:**

- **Server-side only (ECS tasks, Lambdas, margin bot, health checks):** store the private base URL + token in **AWS Secrets Manager** (or inject header in code). Matches “private + noisy” well.
- **Browser (futures UI):** anything in `REACT_APP_*` or bundled config is **visible to clients**. So **true** private GraphQL from the browser either **leaks** the token or requires a **backend/BFF proxy** that holds the token. If the subgraph data is already considered public on-chain, some teams use **public** Goldsky endpoints for the UI and keep **private** only for server jobs—or negotiate higher limits with Goldsky (see below).

**Rate limits (documented today):**

| Endpoint type | Documented default | Notes |
|---------------|--------------------|--------|
| **Public** | **50 requests per 10 seconds** | Stated explicitly for public GraphQL ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)). |
| **Private** | *Not given a separate number in the same doc* | Private endpoints are authenticated; Goldsky does **not** publish a distinct private-tier quota on that page. **429** responses are attributed to rate limiting; docs say limits can be adjusted on **Scale and above** by contacting [support@goldsky.com](mailto:support@goldsky.com?subject=Rate%20limits%20or%20errors) ([GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints)). |

**If you are “pretty noisy”:** treat **public 50/10s** as a hard default to plan around until support confirms a higher allowance. For **private**, ask Goldsky explicitly for **expected limits and burst behavior** for Scale (and whether limits are per token, per project, or per subgraph). Also consider **batching GraphQL**, fewer polling loops, and **caching** on your side regardless of host.

### Reference volume: The Graph DEV (Growth plan, pre-migration)

Snapshot from **The Graph** billing UI for **DEV** (all three subgraphs—oracles, futures, derivatives—behind **one** API key), captured during planning:

| Field | Order of magnitude (update when you re-check) |
|-------|-----------------------------------------------|
| Queries (partial billing period) | **~1.6×10⁵** |
| Period cost (USD) | **~$1** |
| API keys in use | **1** |

**How to use this:** Spread over most of a monthly cycle, that implies a **low average query rate** (on the order of **~0.1 QPS** across the whole stack)—well below Goldsky’s **documented** public ceiling of **50 requests / 10 seconds** *if* that limit is evaluated **per client or per subgraph URL**. It does **not** measure **burst** traffic (many queries in a few seconds on page load) or **concurrent users**. **Billing query counts on The Graph are not the same thing** as Goldsky’s throttle rules or how **private** endpoints are metered.

After cutover, compare **Goldsky dashboard metrics** (if available) or **your own 429 counts** against this baseline to spot regressions.

### Watch list: subgraph usage, limits, and product follow-ups

- [ ] **Goldsky — limit scope:** Confirm in writing whether **50/10s** (public) applies **per subgraph URL**, **per project**, **per API token**, and/or **per client IP**; same for **private** endpoints on Scale.
- [ ] **Goldsky — quota uplift:** If using **public** URLs from the browser, request a **raised limit** or documented **private** quota appropriate for DEV (and STG/LMN later); keep support thread linked in runbooks.
- [ ] **Post-migrate — 429 monitoring:** Alert or log **HTTP 429** on GraphQL clients (futures UI, market maker, margin call, health Lambda) for a few weeks after switch.
- [ ] **Volume sanity check:** Revisit **query volume / cost** after Goldsky migration vs the **The Graph DEV** snapshot above.
- [ ] **UI polling (futures-marketplace):** Review **`usePerpsOrderBook`** — with `undefined` props it still defaults to **10s** `refetchInterval`; **`OrderBookTable`** passes options only in perpetual mode. Decide whether to **`enabled: false`** when not in perps mode to avoid extra **derivatives** subgraph load (product/eng decision).
- [ ] **Pagination bursts:** Chart and historical hooks that **page** the oracles/futures subgraphs can emit **many sequential requests** on load; if 429s appear, consider **larger `first`**, **fewer pages**, or **server-side aggregation**.
- [ ] **Health monitor:** After Goldsky URL/auth change, confirm **hashprice** subgraph health Lambda still runs within any new rate rules (low frequency today; watch **queries per invocation** if entity-count logic stays).

### Repo → subgraph ownership

| Repository | Subgraph |
|------------|----------|
| **hashprice-oracle** | Oracles |
| **futures-marketplace** | Futures |
| **derivatives-marketplace** | Derivatives |

Each repo’s deploy workflow should target the Goldsky **project** that matches the GitHub **environment** (dev → dev Goldsky project, etc.).

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

As decisions land (Goldsky project IDs, exact subgraph names/tags, public vs private endpoints, final network slug for keeper, whether RPC secret gets renamed), update this file so it stays the single **DEV Base** + **subgraph hosting** checklist for the three repos. Refresh the **Reference volume** table after each billing cycle if you use it for comparisons.
