# Hashprice Oracle Infrastructure

Terraform/Terragrunt infrastructure for deploying Lumerin Hashprice Oracle and Indexer services to AWS across multiple environments.

## Overview

This `.bedrock` directory contains the infrastructure code for the Lumerin Oracle and Indexer platform. The infrastructure is co-located with the application code in the [hashprice-oracle](https://github.com/lumerin-protocol/hashprice-oracle) repository.

This provides:
- Infrastructure as Code alongside application code and CI/CD pipeline in a single repository
- Visibility into infrastructure configuration for developers
- Slack notifications when infrastructure changes (see `.github/workflows/infra-update.yml`)

## Architecture

The deployment architecture consists of:

- **Source Code & Infrastructure**: GitHub repository (`lumerin-protocol/hashprice-oracle`)
- **Container Registry**: GitHub Container Registry (GHCR)
- **Infrastructure**: Terraform/Terragrunt (this `.bedrock/` directory)
- **Deployment**: GitHub Actions with AWS OIDC authentication
- **Secrets**: AWS Secrets Manager
- **Compute**: AWS ECS Fargate, AWS Lambda
- **Database**: AWS RDS PostgreSQL (with C collation for Graph Node)
- **Networking**: Application Load Balancers (ALB), Route53 DNS, WAF
- **Monitoring**: CloudWatch Alarms, Dashboards, Metric Filters, Custom Lambda Monitors

## Environments

| Environment | Directory | AWS Account | Purpose |
|-------------|-----------|-------------|---------|
| Development | `02-dev/` | titanio-dev | Development testing |
| Staging | `03-stg/` | titanio-stg | Pre-production validation |
| Production | `04-lmn/` | titanio-lmn | Production deployment |

## Services

The Hashprice Oracle platform consists of four main services:

### 1. Graph Indexer (Self-hosted Graph Node)
- The Graph Protocol node for subgraph indexing
- Indexes Futures and Hashrate contract events
- PostgreSQL RDS with C collation (Graph Node requirement)
- Lambda function for automated database creation
- External ALB exposing multiple ports:
  - `:443` - GraphQL queries (HTTPS)
  - `:8020` - Admin API (subgraph deployment)
  - `:8030` - Metrics API (Prometheus format)
- Uses The Graph's public IPFS gateway
- DNS: `graph.{env}.lumerin.io`

### 2. Spot Indexer (ECS Fargate)
- Contract event indexer for Spot Marketplace
- REST API for querying indexed data
- External ALB with WAF protection
- DNS: `spotidx.{env}.lumerin.io` (or `indexer.{env}.lumerin.io`)

### 3. Oracle Update Lambda
- BTC-USDC hashprice oracle updates
- Scheduled execution (default: every 5 minutes)
- SSM Parameter Store for Bitcoin block data cache (last 144 blocks)
- Queries Bitcoin RPC and updates on-chain oracle

### 4. Monitoring Lambdas
- **Subgraph Health Monitor**: Checks Graph Node indexing status via GraphQL
- **Oracle Staleness Check**: Verifies on-chain oracle data freshness

## Deployment Flow

### ECS Services
```
Code Change → GitHub Push (dev/stg/main)
    ↓
GitHub Actions: Build & Push Container → GHCR
    ↓
GitHub Actions: Update ECS Task Definition
    ↓
AWS ECS: Rolling Deployment with Circuit Breaker
```

### Lambda Functions
```
Code Change → GitHub Push (dev/stg/main)
    ↓
GitHub Actions: Build & Package Lambda
    ↓
GitHub Actions: Deploy to Lambda
    ↓
EventBridge: Scheduled Execution
```

### Subgraph Deployment
```
Subgraph Code Change → GitHub Push
    ↓
GitHub Actions: Build Subgraph
    ↓
GitHub Actions: Deploy via graph-cli
    ↓
Graph Node: Index from Chain
```

## Quick Start

### Prerequisites

- Terraform >= 1.5
- Terragrunt >= 0.48
- AWS CLI configured with appropriate profiles
- Access to AWS accounts (dev/stg/lmn)

### Initial Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/lumerin-protocol/hashprice-oracle.git
   cd hashprice-oracle/.bedrock
   ```

2. **Configure AWS profiles**
   Ensure you have AWS profiles configured for:
   - `titanio-dev`
   - `titanio-stg` 
   - `titanio-lmn` (production)

3. **Initialize secrets**
   Create `secret.auto.tfvars` in each environment directory with sensitive values:
   ```hcl
   ethereum_rpc_url          = "https://arb-sepolia.g.alchemy.com/v2/..."
   graph_eth_rpc_url         = "https://arb-sepolia.g.alchemy.com/v2/..."
   graph_indexer_db_password = "secure-password-here"
   spot_eth_rpc_url          = "https://arb-sepolia.g.alchemy.com/v2/..."
   admin_api_key             = "secure-api-key-here"
   
   oracle_lambda_secrets = {
     eth_rpc_url     = "https://arb-sepolia.g.alchemy.com/v2/..."
     bitcoin_rpc_url = "https://..."
     private_key     = "0x..."
   }
   ```

4. **Deploy infrastructure**
   ```bash
   cd 02-dev
   terragrunt init
   terragrunt plan
   terragrunt apply
   ```

5. **Create Graph Node database** (first-time setup)
   After RDS is created, invoke the database creator Lambda:
   ```bash
   aws lambda invoke \
     --profile titanio-dev \
     --function-name graph-indexer-db-creator-dev \
     --region us-east-1 \
     /tmp/response.json && cat /tmp/response.json
   ```

### Deploying Application Updates

Application deployments are **automated** via GitHub Actions:

1. **Development**: Push to `dev` branch
2. **Staging**: Push to `stg` branch
3. **Production**: Push to `main` branch

GitHub Actions will automatically:
- Build and test the application
- Create versioned Docker images (for ECS services)
- Deploy Lambda functions
- Deploy subgraphs to Graph Node
- Validate deployment success

### Manual Infrastructure Updates

To update infrastructure (not application code):

```bash
cd .bedrock/02-dev  # or 03-stg, 04-lmn
terragrunt plan
terragrunt apply
```

## Infrastructure Components

### ECS Cluster

Shared Fargate cluster for indexer services:
- Container Insights enabled for enhanced monitoring
- KMS encryption for execute command
- CloudWatch Log Group for cluster-level logging

### Graph Indexer (Graph Node)

**ECS Service**:
- Official Graph Protocol image (`graphprotocol/graph-node`)
- Singleton deployment (stop old before starting new)
- Health check grace period for startup

**RDS PostgreSQL**:
- PostgreSQL 17 with C collation (Graph Node requirement)
- Lambda-based database creation for correct collation
- Parameter group optimized for Graph Node (`pg_stat_statements`)
- Encrypted storage with automated backups

**Application Load Balancer**:
- External ALB (internet-facing)
- Multiple listeners:
  - Port 443: GraphQL queries
  - Port 8020: Admin API (for `graph deploy`)
  - Port 8030: Metrics (Prometheus format)
- TLS 1.2 minimum with modern cipher suites

**Security Groups**:
- ALB: HTTP/HTTPS/Admin/Metrics from internet
- ECS: All Graph Node ports from ALB and VPC
- RDS: PostgreSQL from ECS, VPN, and Lambda

### Spot Indexer

**ECS Service**:
- Contract event indexer from GHCR
- REST API on port 8081

**Application Load Balancer**:
- External ALB with WAF association
- HTTP redirect to HTTPS
- Health check on `/api/healthcheck`

### Oracle Update Lambda

- **Runtime**: Node.js 22.x
- **Schedule**: EventBridge rule (default: 5 minutes)
- **State**: SSM Parameter Store for Bitcoin block cache
- **Environment**: Chain ID, contract addresses, RPC URLs

### Secrets Management

Three service-specific secrets stored in AWS Secrets Manager:

```
graph-indexer-secrets-v3-{env}
  └── username, ethereum_rpc_url, graph_indexer_db_password, graph_eth_rpc_url

spot-indexer-secrets-v3-{env}
  └── ADMIN_API_KEY, ETH_NODE_URL

oracle-lambda-secrets-v3-{env}
  └── eth_rpc_url, bitcoin_rpc_url, private_key
```

### IAM & Security

- **OIDC Provider**: Enables GitHub Actions to authenticate without long-lived credentials
- **Deployment Role**: `github-actions-hashprice-oracle-{env}` assumed by GitHub Actions
- **Service IAM Role**: Shared bedrock foundation role with Secrets Manager access
- **Monitoring Lambda Role**: CloudWatch metrics and logs access

### Monitoring

Comprehensive monitoring with custom Lambda-based health checks:

#### Subgraph Health Monitor
- Queries Graph Node status endpoint via GraphQL
- Checks subgraph sync status and indexing health
- Pushes custom metrics to CloudWatch
- Configurable check interval (default: 5 minutes)

#### Oracle Staleness Check
- Queries on-chain oracle contract
- Reports oracle data age to CloudWatch
- Alerts when data exceeds staleness threshold (default: 30 minutes)
- Configurable check interval (default: 5 minutes)

#### Component Alarms
- **Graph Indexer ECS**: CPU, Memory, Running Tasks
- **Spot Indexer ECS**: CPU, Memory, Running Tasks
- **Oracle Lambda**: Errors, Duration, Throttles
- **Graph Indexer RDS**: CPU, Storage, Connections
- **Graph Indexer ALB**: 5xx errors, Unhealthy hosts
- **Spot Indexer ALB**: 5xx errors, Unhealthy hosts
- **Custom Metrics**: Subgraph sync lag, Oracle staleness

#### Composite Alarms
- Aggregated health status per service
- Only composite alarms send SNS notifications
- Prevents double-alerting from component alarms

#### CloudWatch Dashboards
- Service overview with alarm status
- ECS metrics (CPU, Memory, Task Count)
- Lambda metrics (Invocations, Errors, Duration)
- RDS metrics (CPU, Storage, Connections)
- ALB metrics (Requests, Errors, Latency)
- Custom metrics (Subgraph sync, Oracle age)

## Configuration

### Main Variables

Key variables in `terraform.tfvars`:

```hcl
# Environment
account_shortname = "titanio-dev"
account_lifecycle = "dev"
default_region    = "us-east-1"

# Contract Addresses
wallets = {
  clone_factory_address   = "0x..."
  hashrate_oracle_address = "0x..."
  futures_address         = "0x..."
  multicall_address       = "0xcA11bde05977b3631167028862bE2a173976CA11"
}

# Feature Toggles
core_resources = { create = true }
ecs_cluster    = { create = true, protect = false }

# Graph Indexer
graph_indexer = {
  create                   = true
  imagetag                 = "graphprotocol/graph-node:v0.41.1"
  task_cpu                 = 1024  # 1 vCPU
  task_ram                 = 2048  # 2 GB
  db_instance_class        = "db.t3.small"
  db_allocated_storage     = 50
  db_max_allocated_storage = 200
  db_max_connections       = "200"
}

# Spot Indexer
spot_indexer = {
  create          = true
  ghcr_imagetag   = "latest-dev"
  task_cpu        = 256
  task_ram        = 512
  task_worker_qty = 1
}

# Oracle Lambda
oracle_lambda = {
  create       = true
  chain_id     = "421614"  # Arbitrum Sepolia
  log_level    = "info"
  job_interval = "5"       # Minutes
}

# Monitoring
monitoring = {
  create                         = true
  create_alarms                  = true
  create_dashboards              = true
  create_metric_filters          = true
  create_subgraph_health_monitor = true
  create_oracle_staleness_check  = true
  notifications_enabled          = false  # true for production
  dev_alerts_topic_name          = "titanio-dev-dev-alerts"
  devops_alerts_topic_name       = "titanio-dev-dev-alerts"
  dashboard_period               = 300
}

# Monitoring Schedule
monitoring_schedule = {
  subgraph_health_rate_minutes   = 5   # How often to check subgraph health
  oracle_staleness_rate_minutes  = 5   # How often to check oracle staleness
  unhealthy_alarm_period_minutes = 60  # Alarm tolerance period
}

# Alarm Thresholds
alarm_thresholds = {
  ecs_cpu_threshold              = 90
  ecs_memory_threshold           = 90
  ecs_min_running_tasks          = 1
  lambda_error_threshold         = 5
  lambda_duration_threshold      = 55000
  rds_cpu_threshold              = 90
  rds_storage_threshold          = 5
  rds_connections_threshold      = 190
  graph_sync_lag_threshold       = 200
  oracle_stale_threshold_minutes = 30  # Max acceptable oracle age
}
```

## GitHub Actions Setup

### Required Secrets

Configure these in the hashprice-oracle GitHub repository settings:

**Development Environment:**
- `AWS_ROLE_ARN_DEV` - IAM role ARN (output from Terraform)

**Staging Environment:**
- `AWS_ROLE_ARN_STG` - IAM role ARN (output from Terraform)

**Production Environment:**
- `AWS_ROLE_ARN_LMN` - IAM role ARN (output from Terraform)

**Shared:**
- `SLACK_WEBHOOK_URL` - For deployment notifications

### Terraform Outputs

After applying Terraform, get the role ARN:

```bash
terragrunt output github_actions_role_arn
```

## Versioning

The project uses semantic versioning for ECS services and Lambda deployments.

## Troubleshooting

### Graph Node Won't Start

1. Check ECS task stopped reason in AWS Console
2. Verify database exists with C collation
3. Review CloudWatch Logs for Graph Node errors
4. Check RDS connectivity from ECS security group

### Subgraph Deployment Fails

1. Verify Graph Node Admin API is accessible on port 8020
2. Check IPFS connectivity (using The Graph's public IPFS)
3. Review deployment logs in GitHub Actions
4. Verify subgraph manifest is valid

### Oracle Lambda Failures

1. Check CloudWatch Logs for function errors
2. Verify RPC URLs are accessible
3. Check SSM Parameter Store for Bitcoin block cache
4. Review IAM permissions for Secrets Manager access

### Database Connection Issues

1. Verify RDS security group allows traffic from ECS
2. Check RDS instance status
3. Review PostgreSQL connection parameters in task definition
4. Verify database was created with C collation

### Terraform State Locked

```bash
terragrunt force-unlock <lock-id>
```

## Maintenance

### Scaling Services

Update `task_worker_qty` in `terraform.tfvars`:

```hcl
spot_indexer = {
  task_worker_qty = 2  # Scale to 2 tasks
}
```

Note: Graph Node is designed as a singleton. Scaling requires additional configuration.

### RDS Maintenance

RDS maintenance windows are configurable:

```hcl
graph_indexer = {
  db_backup_window      = "03:00-04:00"
  db_maintenance_window = "sun:04:00-sun:05:00"
}
```

### Updating Graph Node Version

Update the image tag in `terraform.tfvars`:

```hcl
graph_indexer = {
  imagetag = "graphprotocol/graph-node:v0.42.0"
}
```

Then apply and the ECS service will deploy the new version.

### Updating Secrets

1. Update value in AWS Secrets Manager console, or
2. Update `secret.auto.tfvars` and run `terragrunt apply`

### Destroying Environment

**⚠️ CAUTION: This will destroy all resources including RDS data!**

```bash
cd 02-dev  # Choose appropriate environment
terragrunt destroy
```

## Directory Structure

```
.bedrock/
├── .terragrunt/                          # Terraform modules
│   ├── 00_*.tf                           # Variables, providers, data sources, backend
│   ├── 01_github_actions_iam.tf          # IAM roles for CI/CD
│   ├── 01_secrets_manager.tf             # AWS Secrets Manager secrets
│   ├── 02_cloudwatch.tf                  # CloudWatch log groups
│   ├── 03_ecs_cluster.tf                 # ECS Cluster with Container Insights
│   ├── 04_spot_indexer_svc.tf            # Spot Indexer ECS + ALB
│   ├── 04_subgraph_svc.tf                # Graph Node ECS + RDS + ALB + Lambda DB creator
│   ├── 05_oracle_lambda.tf               # Oracle Update Lambda + SSM Parameter
│   ├── 70_monitoring_common.tf           # Monitoring locals, IAM, data sources
│   ├── 71_metric_filters.tf              # CloudWatch metric filters
│   ├── 72_subgraph_health_monitor.py     # Subgraph health check Lambda code
│   ├── 72_subgraph_health_monitor.tf     # Subgraph health check Lambda infra
│   ├── 73_oracle_staleness.py            # Oracle staleness check Lambda code
│   ├── 73_oracle_staleness.tf            # Oracle staleness check Lambda infra
│   ├── 80_alarms.tf                      # Component CloudWatch alarms
│   ├── 81_composite_alarms.tf            # Composite CloudWatch alarms
│   ├── 89_dashboards.tf                  # CloudWatch dashboards
│   ├── 99_outputs.tf                     # Terraform outputs
│   ├── lambda_create_db.py               # Database creator Lambda code
│   └── package_lambda.sh                 # Lambda packaging script
├── 02-dev/                               # Development environment
│   ├── terraform.tfvars                  # Environment config
│   ├── secret.auto.tfvars                # Sensitive values (gitignored)
│   └── terragrunt.hcl                    # Terragrunt config
├── 03-stg/                               # Staging environment
├── 04-lmn/                               # Production environment
├── root.hcl                              # Terragrunt root config
└── README.md                             # This documentation
```

## Environment URLs

| Environment | Graph Indexer | Spot Indexer |
|-------------|---------------|--------------|
| DEV | `https://graph.dev.lumerin.io` | `https://spotidx.dev.lumerin.io` |
| STG | `https://graph.stg.lumerin.io` | `https://spotidx.stg.lumerin.io` |
| PRD | `https://graph.lumerin.io` | `https://spotidx.lumerin.io` |

### Graph Node Ports

| Port | Purpose | Example URL |
|------|---------|-------------|
| 443 | GraphQL Queries | `https://graph.dev.lumerin.io/subgraphs/name/futures` |
| 8020 | Admin API | `https://graph.dev.lumerin.io:8020/` |
| 8030 | Metrics | `https://graph.dev.lumerin.io:8030/metrics` |

## Support

For issues related to:
- **Infrastructure or Application Code**: Create issue in [hashprice-oracle](https://github.com/lumerin-protocol/hashprice-oracle)
- **Deployment Issues**: Check GitHub Actions logs and ECS service events

## Contributing

1. Create feature branch from `dev`
2. Make changes (application code and/or infrastructure)
3. Test in development environment
4. Submit pull request
5. Deploy to staging for validation
6. Deploy to production after approval

## License

See LICENSE file in the repository root.
