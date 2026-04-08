# LMN (Production) Promotion Checklist

Lessons learned from DEV → Base Sepolia and STG → Base Mainnet migrations.
Each item bit us at least once — don't skip any.

---

## Contract Authorization

- [ ] **HashrateOracle `setHashesForBTC` delegation**: After the HashrateOracle contract is deployed, the contract owner must grant the Oracle Updater Lambda wallet the right to call `setHashesForBTC`. Without this, the Lambda connects fine, calculates the hashrate, writes BTC/USD price successfully, but reverts on the hashrate update with `Unauthorized()`.
  - Lambda wallet (STG): `0x67C1A7737e0C47E53FD4a828c9c7d81401ce912b`
  - Confirm the LMN wallet address before promotion.
  - This was missed in both DEV and STG — caught only after observing stale hashrate data while BTC price kept updating.

- [ ] **Verify all contract roles on the new chain**: Any contract with access control (owner, updater, keeper, market-maker roles) needs its ACL re-established after deployment. Walk through every contract and confirm authorized callers.

## GitHub Secrets & Variables

- [ ] **`AWS_ROLE_ARN_LMN` must be set AFTER Terraform creates the role**: Terraform creates the GitHub Actions IAM role (e.g., `github-actions-derivatives-v3-lmn`), so the full ARN isn't available when you first set up the repo. The STG secret was a placeholder that never got updated. **After `tgapply` for LMN, immediately update `AWS_ROLE_ARN_LMN`** in all three repos with the full ARN from the Terraform output. Format: `arn:aws:iam::<account>:role/github-actions-<service>-v3-lmn`.

- [ ] **Environment-level secrets for `derivatives-marketplace`**: The `stg` environment was missing `ETH_NODE_ADDRESS` and `ETHERSCAN_API_KEY` as environment-level secrets (they existed in `dev` but not `stg`). These are needed for ECS services and subgraph deploys. Ensure both are set in the `main` (LMN) environment.

- [ ] **Environment-level variables for `derivatives-marketplace`**: The subgraph deploy workflow reads many parameters from GitHub environment variables (`PERPS_ADDRESS`, `PERPS_START_BLOCK`, `PRICE_ORACLE_ADDRESS`, `COLLATERAL_TOKEN_ADDRESS`, `LIQUIDATION_FEE`, `MAINTENANCE_MARGIN_PERCENT`, `MARGIN_PERCENT`, `MINIMUM_PRICE_INCREMENT`, `ORDER_FEE`, `NETWORK`, `ETH_NODE_ADDRESS`). These must all be set in the `main` (LMN) environment before triggering deploys.

- [ ] **Environment-level variables for `futures-marketplace`**: Similarly needs `NETWORK`, `REACT_APP_CHAIN_ID`, `REACT_APP_ETHERSCAN_URL`, `REACT_APP_FUTURES_TOKEN_ADDRESS`, `REACT_APP_USDC_TOKEN_ADDRESS`, `REACT_APP_PERPS_TOKEN_ADDRESS`, `START_BLOCK_FUTURES` in the `main` environment.

- [ ] **Goldsky API key secrets**: Each environment uses its own Goldsky project. Verify `LMN_GOLDSKY_API_KEY` and the `LMN_GS_*` endpoint variables are set at the org/repo level.

## Terraform & Lambda Deploy Ordering

- [ ] **Apply Terraform before triggering CI deploys**: Terraform manages Lambda environment variables (`CHAIN_ID`, `ETHEREUM_RPC_URL`, `HASHRATE_ORACLE_ADDRESS`, etc.) while CI manages Lambda code. If CI deploys new code before Terraform updates env vars, the Lambda runs with mismatched config. Always `tgapply` first, then merge to trigger CI.

- [ ] **Verify `chain_id` in all `terraform.tfvars`**: In STG, `futures-marketplace` initially had `chain_id = 42161` (Arbitrum) instead of `8453` (Base). Triple-check every tfvars file for the target chain ID.

## Wallet Funding

- [ ] **Fund market maker wallets with USDC**: Both MMs need USDC on the target chain.
  - **Futures MM**: Needs at least 500 USDC (float is 450 USDC + buffer). Gracefully stops at 10 USDC.
  - **Derivatives MM**: Needs at least 200 USDC (hard-halts at 100 USDC min collateral). Comfortable at 500 USDC.
  - **IMPORTANT**: The Derivatives MM deposits the **entire wallet USDC balance** into the perps contract as collateral on startup (`topUpCollateral`). Stop the derivatives MM service before funding the wallet if you need to control how much goes in, otherwise it will consume everything available. Fund each wallet separately to the exact amount intended.

- [ ] **Fund the Oracle Updater wallet with ETH**: The Lambda wallet needs ETH for gas to write oracle updates on-chain.

## Branch & Environment Setup

- [ ] **Ensure `main` branch exists on all repos**: The `derivatives-marketplace` repo didn't have a `stg` branch when we promoted — it had to be created from `dev`. Verify `main` exists and is in a clean state on all three repos.

- [ ] **GitHub environment protection rules**: If the `main` environment has required reviewers or deployment gates, factor that into the deploy timeline.

## Subgraph / Goldsky

- [ ] **Goldsky duplicate content conflicts**: If a subgraph version with identical content already exists (e.g., from a failed earlier deploy), Goldsky will reject the deploy. The CI has retry logic that deletes the conflicting version and retries, but be aware this can happen.

- [ ] **Verify subgraph `network` parameter**: The subgraph must be built with `network: base` (not `base-sepolia` or `arbitrum`). This comes from the `NETWORK` GitHub variable.

- [ ] **Verify subgraph start blocks**: Start blocks must correspond to the contract deployment block on the target chain. Using wrong start blocks means missing events or indexing errors.

## Post-Deploy Verification

- [ ] **Check CloudWatch logs** for `/aws/lambda/futures-oracle-update-v2` — confirm no `Unauthorized()` or chain errors
- [ ] **Query Goldsky subgraphs** — confirm `_meta.block.number` is advancing and `hasIndexingErrors` is false
- [ ] **Query oracle data** — confirm `hashrateIndexes` and `btcPriceIndexes` have recent timestamps
- [ ] **Query order books** — confirm futures and derivatives `orders` are populating after market makers are funded
- [ ] **Check ECS service health** — confirm perps-keeper and perps-market-maker tasks are running
