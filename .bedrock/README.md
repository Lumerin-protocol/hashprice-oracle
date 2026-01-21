# Hashprice Oracle Infrastructure

Terraform/Terragrunt configuration for the Oracle and Indexer platform.

## Components

**ECS Cluster** (Fargate)
- Shared cluster hosting all indexer services

**Graph Indexer** (Self-hosted Graph Node)
- Graph Protocol node for subgraph indexing (Futures + Hashrate)
- PostgreSQL RDS with C collation (required by Graph Node)
- Lambda for automated DB creation
- ALB exposing GraphQL (:443), Admin API (:8020), Metrics (:8030)
- DNS: `graph.<env>.lumerin.io`

**Spot Indexer**
- Contract event indexer for spot marketplace
- ALB with WAF protection
- DNS: `spotidx.<env>.lumerin.io`

**Supporting Infrastructure**
- Secrets Manager (RPC URLs, API keys, DB credentials)
- CloudWatch log groups (90-day retention)
- GitHub Actions OIDC role for CI/CD deployments
