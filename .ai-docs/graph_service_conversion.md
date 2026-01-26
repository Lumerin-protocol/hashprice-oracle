# Graph Service Conversion: Self-Hosted to The Graph Network

> **Status**: Planning  
> **Created**: January 2026  
> **Estimated Savings**: ~$4,150/year (~$346/month)

## Executive Summary

This document outlines the migration from self-hosted Graph Node infrastructure to The Graph Network's managed service. The migration eliminates dependency management (ECS, RDS, Alchemy RPC, IPFS) while reducing costs by ~92%.

### Current vs Future State

| Aspect | Self-Hosted (Current) | The Graph Network (Future) |
|--------|----------------------|---------------------------|
| Monthly Cost | ~$374 | ~$28 (at current volume) |
| Infrastructure | ECS + RDS + ALB + Alchemy | None (API endpoint only) |
| Dependencies | 4+ services to manage | Single API key |
| Scaling | Manual infrastructure upgrades | Automatic, pay-per-query |
| Uptime SLA | Self-managed | 99.9%+ |

---

## Current Architecture

### Self-Hosted Components (to be decommissioned)

```
┌─────────────────────────────────────────────────────────────┐
│                    Per Environment (×3)                      │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │ ECS Fargate  │   │     RDS      │   │     ALB      │    │
│  │ Graph Node   │◄──│  PostgreSQL  │   │  (external)  │    │
│  │ 1 vCPU/2GB   │   │  t3.medium   │   │              │    │
│  └──────┬───────┘   └──────────────┘   └──────────────┘    │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────┐                                           │
│  │   Alchemy    │  ~766K RPC calls/day                      │
│  │  (shared)    │                                           │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

### Current Endpoints

| Environment | Futures Endpoint | Oracles Endpoint |
|-------------|------------------|------------------|
| DEV | `https://graph.dev.lumerin.io/subgraphs/name/futures` | `https://graph.dev.lumerin.io/subgraphs/name/oracles` |
| STG | `https://graph.stg.lumerin.io/subgraphs/name/futures` | `https://graph.stg.lumerin.io/subgraphs/name/oracles` |
| LMN | `https://graph.lmn.lumerin.io/subgraphs/name/futures` | `https://graph.lmn.lumerin.io/subgraphs/name/oracles` |

### Current Monthly Costs

| Component | DEV | STG | LMN | Total |
|-----------|-----|-----|-----|-------|
| ECS Fargate | $35 | $35 | $35 | $105 |
| RDS PostgreSQL | $40 | $40 | $80 | $160 |
| ALB | $20 | $20 | $20 | $60 |
| Alchemy RPC | - | - | - | ~$49 |
| **Total** | | | | **~$374/mo** |

---

## Future Architecture

### The Graph Network

```
┌─────────────────────────────────────────────────────────────┐
│                    The Graph Network                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    │
│   │  Indexers   │    │  Indexers   │    │  Indexers   │    │
│   │  (Global)   │    │  (Global)   │    │  (Global)   │    │
│   └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    │
│          │                  │                  │            │
│          └──────────────────┼──────────────────┘            │
│                             ▼                                │
│                    ┌─────────────────┐                      │
│                    │  Graph Gateway  │                      │
│                    │   (managed)     │                      │
│                    └────────┬────────┘                      │
│                             │                                │
└─────────────────────────────┼────────────────────────────────┘
                              ▼
                    Your API Key + Query
```

### New Endpoint Format

```
https://gateway.thegraph.com/api/{API_KEY}/subgraphs/id/{SUBGRAPH_ID}
```

**Key Change**: Endpoints now require an API key (similar to Alchemy RPC URLs).

---

## Subgraph Structure

### 6 Subgraphs Required

Each environment has **different smart contract addresses**, requiring separate subgraphs:

| Subgraph Name | Network | Environment | Contracts |
|---------------|---------|-------------|-----------|
| `lumerin-futures-dev` | arbitrum-sepolia | DEV | `0xec76...` |
| `lumerin-futures-stg` | arbitrum-one | STG | `0xe115...` |
| `lumerin-futures-lmn` | arbitrum-one | LMN | `0x8464...` |
| `lumerin-oracles-dev` | arbitrum-sepolia | DEV | `0x6f73...` |
| `lumerin-oracles-stg` | arbitrum-one | STG | `0x2c1d...` |
| `lumerin-oracles-lmn` | arbitrum-one | LMN | `0x6599...` |

### Contract Addresses by Environment

| Environment | Network | Futures | Hashrate Oracle |
|-------------|---------|---------|-----------------|
| **DEV** | Arbitrum Sepolia | `0xec76867e96d942282fc7aafe3f778de34d41a311` | `0x6f736186d2c93913721e2570c283dff2a08575e9` |
| **STG** | Arbitrum Mainnet | `0xe11594879beb6c28c67bc251aa5e26ce126b82ba` | `0x2c1db79d2f3df568275c940dac81ad251871faf4` |
| **LMN** | Arbitrum Mainnet | `0x8464dc5ab80e76e497fad318fe6d444408e5ccda` | `0x6599ef8e2b4a548a86eb82e2dfbc6ceadfceacbd` |

---

## Secrets & Configuration

### New Secrets Required

Unlike self-hosted Graph Node (open endpoints), The Graph Network requires API keys:

| Secret Name | Scope | Purpose | Where to Store |
|-------------|-------|---------|----------------|
| `GRAPH_DEPLOY_KEY` | Organization | Deploy subgraphs via CI/CD | GitHub Org Secret |
| `GRAPH_API_KEY` | Organization | Query subgraphs at runtime | GitHub Org Secret + AWS Secrets Manager |

### GitHub Secrets (Organization Level)

```yaml
# For CI/CD deployment
GRAPH_DEPLOY_KEY: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# For runtime queries (shared across all repos/environments)
GRAPH_API_KEY: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### GitHub Variables (Per Repository × Environment)

**hashprice-oracle repo:**

| Variable | dev | stg | main |
|----------|-----|-----|------|
| `GRAPH_SUBGRAPH_ORACLES` | `lumerin-oracles-dev` | `lumerin-oracles-stg` | `lumerin-oracles-lmn` |
| `GRAPH_SUBGRAPH_ORACLES_ID` | `Qm...` (after deploy) | `Qm...` | `Qm...` |

**futures-marketplace repo:**

| Variable | dev | stg | main |
|----------|-----|-----|------|
| `GRAPH_SUBGRAPH_FUTURES` | `lumerin-futures-dev` | `lumerin-futures-stg` | `lumerin-futures-lmn` |
| `GRAPH_SUBGRAPH_FUTURES_ID` | `Qm...` (after deploy) | `Qm...` | `Qm...` |
| `REACT_APP_SUBGRAPH_FUTURES_URL` | (new URL with API key) | (new URL) | (new URL) |
| `REACT_APP_SUBGRAPH_ORACLES_URL` | (new URL with API key) | (new URL) | (new URL) |

**spot-marketplace repo:**

| Variable | dev | stg | main |
|----------|-----|-----|------|
| `REACT_APP_SUBGRAPH_FUTURES_URL` | (new URL with API key) | (new URL) | (new URL) |

**proxy-router repo:**

| Variable | dev | stg | main |
|----------|-----|-----|------|
| `FUTURES_SUBGRAPH_URL` | (new URL with API key) | (new URL) | (new URL) |

### AWS Secrets Manager

Add to existing secrets or create new:

```json
{
  "graph_api_key": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

Reference in Terraform for services that need runtime access:
- market-maker
- margin-call lambda
- proxy-router

---

## Endpoint Migration Matrix

### Affected Repositories

| Repository | Role | Changes Needed |
|------------|------|----------------|
| **hashprice-oracle** | Deploys `oracles` subgraph | Update deploy workflow, decommission self-hosted infra |
| **futures-marketplace** | Deploys `futures` subgraph, UI + services | Update deploy workflow, UI vars, terraform for services |
| **proxy-router** | Consumes `futures` subgraph | Update terraform + GitHub vars |
| **spot-marketplace** | UI consumes `futures` subgraph | Update GitHub vars |

### Consumers to Update

| Service | Repo | Current Config | New Config |
|---------|------|----------------|------------|
| **futures-marketplace UI** | futures-marketplace | GitHub var: `REACT_APP_SUBGRAPH_FUTURES_URL` | Same var, new URL with API key |
| **futures-marketplace UI** | futures-marketplace | GitHub var: `REACT_APP_SUBGRAPH_ORACLES_URL` | Same var, new URL with API key |
| **spot-marketplace UI** | spot-marketplace | GitHub var: `REACT_APP_SUBGRAPH_FUTURES_URL` | Same var, new URL with API key |
| **market-maker** | futures-marketplace | tfvars: `market_maker.subgraph_url_*` | Update tfvars + add secret reference |
| **margin-call lambda** | futures-marketplace | tfvars: `margin_call_lambda.futures_subgraph_url` | Update tfvars + add secret reference |
| **proxy-router** | proxy-router | tfvars: hardcoded in `02_proxy_n_router_svc.tf` | Add variable + Secrets Manager reference |
| **proxy-validator** | proxy-router | tfvars: hardcoded in `02_proxy_n_validator_svc.tf` | Add variable + Secrets Manager reference |

### URL Format Change

```
# OLD (open endpoint)
https://graph.{env}.lumerin.io/subgraphs/name/{subgraph}

# NEW (authenticated endpoint)
https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${SUBGRAPH_ID}
```

### Terraform Change Example (proxy-router)

**Current** (`02_proxy_n_router_svc.tf` line 90):
```hcl
{ "name" : "FUTURES_SUBGRAPH_URL", "value" : var.account_lifecycle == "prd" 
  ? "https://graph.lmn.lumerin.io/subgraphs/name/futures" 
  : "https://graph.${var.account_lifecycle}.lumerin.io/subgraphs/name/futures" },
```

**New** (using Secrets Manager):
```hcl
# In secrets block, add:
secrets = [
  {
    name      = "FUTURES_SUBGRAPH_URL"
    valueFrom = "${aws_secretsmanager_secret.proxy_router.arn}:futures_subgraph_url::"
  }
]
```

**Or** using variable (simpler, API key in URL):
```hcl
{ "name" : "FUTURES_SUBGRAPH_URL", "value" : var.futures_subgraph_url },
```

With tfvars:
```hcl
# 04-lmn/terraform.tfvars
futures_subgraph_url = "https://gateway.thegraph.com/api/XXXXXX/subgraphs/id/QmYYYYYY"
```

---

## CI/CD Changes

### Deployment Workflow Changes

**Old workflow (self-hosted):**
```bash
# Create subgraph (admin port required)
npx graph create --node https://graph.dev.lumerin.io:8020 oracles

# Deploy
npx graph deploy \
  --node https://graph.dev.lumerin.io:8020 \
  --ipfs https://api.thegraph.com/ipfs/ \
  oracles
```

**New workflow (The Graph Network):**
```bash
# Authenticate (once per workflow)
npx graph auth --studio $GRAPH_DEPLOY_KEY

# Deploy (no create needed, no admin port)
npx graph deploy --studio lumerin-oracles-dev
```

### Files to Update

**Subgraph Deployment Workflows:**

| File | Repo | Changes |
|------|------|---------|
| `.github/workflows/deploy-hr-btc-oracles.yml` | hashprice-oracle | Remove admin port, use `--studio` flag |
| `.github/workflows/update-futures-oracle.yml` | futures-marketplace | Remove admin port, use `--studio` flag |

**Terraform (Backend Services):**

| File | Repo | Changes |
|------|------|---------|
| `.bedrock/.terragrunt/02_proxy_n_router_svc.tf` | proxy-router | Replace hardcoded URL with variable + secret |
| `.bedrock/.terragrunt/02_proxy_n_validator_svc.tf` | proxy-router | Replace hardcoded URL with variable + secret |
| `.bedrock/.terragrunt/10_market_maker_svc.tf` | futures-marketplace | Update URL construction to use secret |
| `.bedrock/.terragrunt/07_margin_call_lambda.tf` | futures-marketplace | Update URL construction to use secret |
| `.bedrock/0X-{env}/terraform.tfvars` | futures-marketplace | Update subgraph URL values |
| `.bedrock/0X-{env}/terraform.tfvars` | proxy-router | Add new subgraph URL variable |

**UI Deployments (GitHub Variables):**

| File | Repo | Changes |
|------|------|---------|
| `.github/workflows/deploy-futures-ui.yml` | futures-marketplace | Uses vars, just update var values |
| `.github/workflows/deploy-spot-ui.yml` | spot-marketplace | Uses vars, just update var values |

---

## Migration Phases

### Phase 1: Setup (Day 1-2)

- [ ] Create Subgraph Studio account at https://thegraph.com/studio/
- [ ] Create 6 subgraphs in Studio
- [ ] Generate deploy key and API key
- [ ] Add `GRAPH_DEPLOY_KEY` to GitHub org secrets
- [ ] Add `GRAPH_API_KEY` to GitHub org secrets

### Phase 2: Deploy Subgraphs (Day 3-5)

- [ ] Update `deploy-hr-btc-oracles.yml` workflow
- [ ] Update `update-futures-oracle.yml` workflow
- [ ] Deploy all 6 subgraphs to Studio
- [ ] Wait for indexing to complete
- [ ] Verify data matches current self-hosted

### Phase 3: Update Consumers - DEV (Day 6-7)

**GitHub Variables (per repo):**
- [ ] futures-marketplace: Update `REACT_APP_SUBGRAPH_FUTURES_URL`, `REACT_APP_SUBGRAPH_ORACLES_URL`
- [ ] spot-marketplace: Update `REACT_APP_SUBGRAPH_FUTURES_URL`
- [ ] proxy-router: Add `FUTURES_SUBGRAPH_URL` var (if using workflow)

**AWS Secrets Manager:**
- [ ] Add `graph_api_key` to titanio-dev secrets

**Terraform Updates:**
- [ ] futures-marketplace: Update `02-dev/terraform.tfvars` (market-maker, margin-call URLs)
- [ ] proxy-router: Update `02-dev/terraform.tfvars` and terraform to use secret

**Redeploy & Verify:**
- [ ] Redeploy futures-marketplace UI
- [ ] Redeploy spot-marketplace UI
- [ ] Redeploy market-maker service
- [ ] Redeploy margin-call lambda
- [ ] Redeploy proxy-router services
- [ ] Verify all consumers working against new endpoints

### Phase 4: Update Consumers - STG (Day 8-9)

- [ ] Repeat Phase 3 for STG environment (titanio-stg account)

### Phase 5: Update Consumers - LMN/PROD (Day 10-11)

- [ ] Repeat Phase 3 for LMN environment (titanio-lmn account)
- [ ] Monitor closely for any issues
- [ ] Verify query billing appearing in Subgraph Studio

### Phase 6: Decommission (Day 12-14)

- [ ] Update hashprice-oracle tfvars: `graph_indexer.create = false`
- [ ] Run `terragrunt apply` for each environment
- [ ] Verify self-hosted infrastructure removed
- [ ] Review/downgrade Alchemy subscription if applicable
- [ ] Update documentation

---

## Cost Analysis

### Query Volume (Measured January 2026)

| Environment | Queries/24h | Projected Monthly |
|-------------|-------------|-------------------|
| DEV | 14,254 | ~428K |
| STG | 13,255 | ~398K |
| LMN | 21,894 | ~657K |
| **Total** | **49,403** | **~1.48M** |

### The Graph Network Pricing

| Monthly Queries | Cost |
|-----------------|------|
| First 100K | Free |
| Additional | $2 per 100K |

**Current usage cost**: (1.48M - 100K) / 100K × $2 = **~$28/month**

### Cost Comparison

| Metric | Self-Hosted | Graph Network | Savings |
|--------|-------------|---------------|---------|
| Monthly | ~$374 | ~$28 | $346 (92%) |
| Annual | ~$4,488 | ~$336 | $4,152 |

### Scaling Costs

| Volume (monthly) | Graph Network | Self-Hosted (est.) |
|------------------|---------------|-------------------|
| 1.5M (current) | $28 | $374 |
| 5M | $98 | ~$500 |
| 10M | $198 | ~$700 |
| 50M | $998 | ~$1,500 |
| 100M | $1,998 | ~$2,500 |

Break-even point: ~300-400M queries/month (not a realistic concern).

---

## Rollback Plan

If issues arise after migration:

1. **Quick rollback**: Update GitHub vars/secrets to point back to self-hosted endpoints
2. **Infrastructure**: Self-hosted terraform is still in repo (just `create = false`)
3. **To restore**: Set `graph_indexer.create = true` and `terragrunt apply`

**Keep self-hosted terraform code** for at least 30 days after successful migration.

---

## Open Questions

1. **API Key Security**: Should we use one API key for all environments or separate keys?
   - Recommendation: One key is simpler; The Graph doesn't charge differently per key

2. **Rate Limits**: What are The Graph Network's rate limits?
   - Free tier: 1000 queries/minute
   - Paid tier: Higher limits, contact support if needed

3. **Monitoring**: How to monitor query usage and costs?
   - Subgraph Studio dashboard provides usage metrics
   - Set up billing alerts at thegraph.com

---

## References

- [The Graph Studio](https://thegraph.com/studio/)
- [The Graph Pricing](https://thegraph.com/studio-pricing/)
- [Graph CLI Documentation](https://thegraph.com/docs/en/deploying/deploying-a-subgraph-to-studio/)
- [Self-Hosted vs Graph Network](https://thegraph.com/docs/en/resources/benefits/)
