# Hashprice Oracle - Monitoring Plan

## Summary of Request

Create monitoring infrastructure for the Hashprice Oracle system including:
- **70-series files** - Metric collection (filters, lambdas, IAM roles, etc.)
- **80-series files** - Metric actions (alarms, dashboards)

### Alerting Targets
- `titanio-[env]-dev-alerts` - Slack webhook via Lambda (`devops-alerts` Lambda formats for Slack)
- `titanio-[env]-devops-alerts` - Direct SMS/email (urgent, primarily for production/LMN)

### Confirmed SNS Topics (titanio-dev)
```
arn:aws:sns:us-east-1:434960487817:titanio-dev-dev-alerts  (exists, subscribed to devops-alerts Lambda)
```
**Note**: `titanio-dev-devops-alerts` does NOT exist in dev - may need to create for critical alerts or use existing for all in non-prod.

### Requirements
- Variable-controlled creation per environment
- Environment-tunable thresholds (relaxed for dev/stg)
- Critical alerts to cell phone for LMN only, Slack for dev/stg
- Composite alarms where appropriate
- Pull Prometheus metrics from Graph Node into CloudWatch
- Oracle staleness detection (check on-chain state)

---

## Notification Strategy (IMPORTANT)

### Two-Tier Alarm Architecture

The monitoring system uses a **two-tier alarm architecture** to prevent alert flooding:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         COMPOSITE ALARMS                             │
│                    (Human-Alertable Level)                           │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐        │
│  │ graph_indexer   │ │ spot_indexer    │ │ oracle          │        │
│  │ _unhealthy      │ │ _unhealthy      │ │ _unhealthy      │  ...   │
│  └────────┬────────┘ └────────┬────────┘ └────────┬────────┘        │
│           │                   │                   │                  │
│           ▼                   ▼                   ▼                  │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    SNS NOTIFICATIONS                         │    │
│  │         (Only when notifications_enabled = true)             │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
                              │ Composite triggers when ANY component is in ALARM
                              │
┌─────────────────────────────────────────────────────────────────────┐
│                       COMPONENT ALARMS                               │
│                   (State Tracking Only)                              │
│                                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ cpu_high │ │ mem_high │ │ svc_down │ │ errors   │ │ storage  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                                      │
│  NO SNS NOTIFICATIONS - Visible in CloudWatch Console only           │
└─────────────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

1. **Prevents Double-Alerting**: Without this, when CPU goes high you'd get:
   - Alert: "CPU High"
   - Alert: "Graph Indexer Unhealthy" (because CPU triggered composite)
   - That's noise!

2. **Single Actionable Alert**: DevOps receives ONE alert: "Graph Indexer Unhealthy"
   - Go to CloudWatch Dashboard
   - See which component alarm triggered it
   - Take appropriate action

3. **Clean Console View**: All component alarms are still visible in CloudWatch Alarms console for debugging

### Notification Control

```hcl
# In terraform.tfvars
monitoring = {
  ...
  notifications_enabled = false  # Set true to enable SNS alerts
}
```

| Environment | `notifications_enabled` | Reason |
|-------------|------------------------|--------|
| DEV | `false` | Reduce noise during active development |
| STG | `false` | Reduce noise, enable when testing alerts |
| LMN/Prod | `true` | Always notify for production issues |

### Implementation in Terraform

```hcl
# 70_monitoring_common.tf
locals {
  # Component alarms - NEVER send notifications (just state tracking)
  component_alarm_actions = []
  
  # Composite alarms - send notifications only when enabled
  composite_alarm_actions = var.monitoring.notifications_enabled ? [local.critical_sns_arn] : []
}
```

```hcl
# 80_alarms.tf (component alarms)
resource "aws_cloudwatch_metric_alarm" "graph_cpu_high" {
  ...
  alarm_actions = local.component_alarm_actions  # Always empty
  ok_actions    = local.component_alarm_actions
}

# 81_composite_alarms.tf
resource "aws_cloudwatch_composite_alarm" "graph_indexer_unhealthy" {
  ...
  alarm_actions = local.composite_alarm_actions  # Only when enabled
  ok_actions    = local.composite_alarm_actions
}
```

---

## Infrastructure Inventory

### 1. ECS Cluster
| Resource | Name Pattern | Notes |
|----------|-------------|-------|
| ECS Cluster | `ecs-hashprice-oracle-${env}` | Fargate, Container Insights enabled |

### 2. ECS Services (Running 24/7)

#### Graph Indexer (Subgraph)
| Resource | Name Pattern | Notes |
|----------|-------------|-------|
| ECS Service | `svc-graph-indexer-${env}` | Self-hosted Graph Node |
| Log Group | `/ecs/graph-indexer-${env}` | 253MB data, active |
| ALB | `alb-graph-indexer-ext-${env}` | External, ports 443/8020/8030 |
| RDS | `graph-indexer-${env}-use1-v2` | PostgreSQL 17 |
| DNS | `graph.${env}.lumerin.io` | GraphQL endpoint |

#### Spot Indexer
| Resource | Name Pattern | Notes |
|----------|-------------|-------|
| ECS Service | `svc-spot-indexer-${env}` | Contract indexing API |
| Log Group | `bedrock-hpo-spot-indexer-${env}` | 9KB data (newer deployment) |
| ALB | `alb-spot-indexer-ext-${env}` | External, port 443 |
| DNS | `indexer.${env}.lumerin.io` | REST API endpoint |

### 3. Lambda Functions

#### Oracle Update Lambda
| Resource | Name Pattern | Notes |
|----------|-------------|-------|
| Lambda | `marketplace-oracle-update` | BTC-USDC hashrate oracle updates |
| Log Group | `/aws/lambda/marketplace-oracle-update` | 80MB data, active |
| Schedule | Every 5 minutes | EventBridge |

---

## Log Pattern Research (from titanio-dev)

### Graph Indexer Logs (`/ecs/graph-indexer-dev`)

**Log Format**: Text with timestamp and level
```
Jan 23 18:16:52.296 INFO Syncing 3 blocks from Ethereum, code: BlockIngestionStatus...
Jan 20 23:49:52.748 ERRO Failed to connect notification listener: db error...
Jan 20 23:49:57.750 CRIT database setup failed, error: database unavailable
```

| Pattern | Filter | Metric Name | Purpose |
|---------|--------|-------------|---------|
| `ERRO` | `" ERRO "` | `graph_indexer_errors` | Error count |
| `CRIT` | `" CRIT "` | `graph_indexer_critical` | Critical failures |
| Database Error | `"Postgres connection error"` OR `"database unavailable"` | `graph_db_errors` | DB connectivity |
| Block Sync | `"Committed write batch"` | `graph_blocks_committed` | Positive: indexing working |
| Sync Lagging | `"BlockIngestionLagging"` | `graph_sync_lagging` | Sync falling behind |

### Spot Indexer Logs (`bedrock-hpo-spot-indexer-dev`)

**Log Format**: JSON (pino)
```json
{"level":30,"time":1768946177175,"pid":1,"hostname":"...","msg":"Connecting to blockchain..."}
{"level":30,"time":1768946178567,"pid":1,"hostname":"...","module":"server","msg":"Server listening at http://0.0.0.0:8081"}
```

| Pattern | Filter | Metric Name | Purpose |
|---------|--------|-------------|---------|
| Error Level | `"level":50` | `spot_indexer_errors` | Error count |
| Server Start | `"Server listening"` | `spot_server_starts` | Service restarts (high = problem) |
| Contract Update | `"updated in cache"` | `spot_contract_updates` | Positive: indexer working |

### Oracle Lambda Logs (`/aws/lambda/marketplace-oracle-update`)

**Log Format**: JSON (pino)
```json
{"level":30,"time":1769192259133,"pid":2,"hostname":"...","msg":"Starting job"}
{"level":30,"time":1769192265343,"pid":2,"hostname":"...","msg":"Transaction hash: 0x1bab4a04..."}
{"level":30,"time":1769192265622,"pid":2,"hostname":"...","msg":"Job completed"}
```

| Pattern | Filter | Metric Name | Purpose |
|---------|--------|-------------|---------|
| Error Level | `"level":50` | `oracle_lambda_errors` | Error count |
| Job Completed | `"Job completed"` | `oracle_job_completions` | Successful executions |
| TX Success | `"Transaction hash:"` | `oracle_tx_success` | On-chain updates |

---

## File Structure (Implemented)

```
.bedrock/.terragrunt/
├── 70_monitoring_common.tf        # IAM roles, data sources, alarm action locals
├── 71_metric_filters.tf           # 11 CloudWatch Log metric filters
├── 72_prometheus_scraper.tf       # Lambda to scrape Graph Node metrics (port 8030)
├── 72_prometheus_scraper.py       # Python Lambda code
├── 73_oracle_staleness.tf         # Lambda to check on-chain oracle freshness
├── 73_oracle_staleness.py         # Python Lambda code (uses getHashesForBTC())
├── 80_alarms.tf                   # 19 CloudWatch component alarms
├── 81_composite_alarms.tf         # 5 composite alarms
└── 89_dashboards.tf               # CloudWatch dashboard
```

---

## Variables Structure (Implemented)

### monitoring object
```hcl
variable "monitoring" {
  type = object({
    create                        = bool   # Master switch
    create_alarms                 = bool   # Create CloudWatch alarms
    create_dashboards             = bool   # Create CloudWatch dashboard
    create_metric_filters         = bool   # Create log metric filters
    create_prometheus_scraper     = bool   # Create Graph Node metrics scraper Lambda
    create_oracle_staleness_check = bool   # Create oracle staleness check Lambda
    notifications_enabled         = bool   # Enable SNS notifications (composites only)
    dev_alerts_topic_name         = string # SNS topic for Slack alerts
    devops_alerts_topic_name      = string # SNS topic for critical/cell alerts
    dashboard_period              = number # Dashboard refresh period (seconds)
  })
}
```

### alarm_thresholds object
```hcl
variable "alarm_thresholds" {
  type = object({
    ecs_cpu_threshold           = number  # ECS CPU % threshold
    ecs_memory_threshold        = number  # ECS Memory % threshold
    ecs_min_running_tasks       = number  # Minimum running tasks
    lambda_error_threshold      = number  # Lambda error count
    lambda_duration_threshold   = number  # Lambda duration (ms)
    lambda_throttle_threshold   = number  # Lambda throttle count
    alb_5xx_threshold           = number  # ALB 5xx error count
    alb_unhealthy_threshold     = number  # ALB unhealthy host count
    alb_latency_threshold       = number  # ALB latency (seconds)
    rds_cpu_threshold           = number  # RDS CPU % threshold
    rds_storage_threshold       = number  # RDS free storage (GB)
    rds_connections_threshold   = number  # RDS connection count
    graph_sync_lag_threshold    = number  # Graph sync lag events
    graph_error_threshold       = number  # Graph error count
    oracle_max_age_minutes      = number  # Max oracle data age (minutes)
  })
}
```

---

## terraform.tfvars Examples

### DEV Environment (relaxed, notifications disabled)
```hcl
monitoring = {
  create                        = true
  create_alarms                 = true
  create_dashboards             = true
  create_metric_filters         = true
  create_prometheus_scraper     = true
  create_oracle_staleness_check = true
  notifications_enabled         = false  # Disabled to reduce noise
  dev_alerts_topic_name         = "titanio-dev-dev-alerts"
  devops_alerts_topic_name      = "titanio-dev-dev-alerts"
  dashboard_period              = 300
}

alarm_thresholds = {
  ecs_cpu_threshold           = 90
  ecs_memory_threshold        = 90
  ecs_min_running_tasks       = 1
  lambda_error_threshold      = 5
  lambda_duration_threshold   = 55000
  lambda_throttle_threshold   = 10
  alb_5xx_threshold           = 20
  alb_unhealthy_threshold     = 1
  alb_latency_threshold       = 15
  rds_cpu_threshold           = 90
  rds_storage_threshold       = 5
  rds_connections_threshold   = 190
  graph_sync_lag_threshold    = 200
  graph_error_threshold       = 20
  oracle_max_age_minutes      = 30
}
```

### LMN/PROD Environment (strict, notifications enabled)
```hcl
monitoring = {
  create                        = true
  create_alarms                 = true
  create_dashboards             = true
  create_metric_filters         = true
  create_prometheus_scraper     = true
  create_oracle_staleness_check = true
  notifications_enabled         = true   # ENABLED for production
  dev_alerts_topic_name         = "titanio-lmn-dev-alerts"     # Slack (warning)
  devops_alerts_topic_name      = "titanio-lmn-devops-alerts"  # Cell phone (critical)
  dashboard_period              = 300
}

alarm_thresholds = {
  ecs_cpu_threshold           = 80
  ecs_memory_threshold        = 85
  ecs_min_running_tasks       = 1
  lambda_error_threshold      = 1
  lambda_duration_threshold   = 45000
  lambda_throttle_threshold   = 1
  alb_5xx_threshold           = 5
  alb_unhealthy_threshold     = 1
  alb_latency_threshold       = 5
  rds_cpu_threshold           = 80
  rds_storage_threshold       = 10
  rds_connections_threshold   = 150
  graph_sync_lag_threshold    = 50
  graph_error_threshold       = 5
  oracle_max_age_minutes      = 10
}
```

---

## Alarm Inventory

### Component Alarms (19) - NO Notifications
These alarms track state only. They feed into composite alarms.

| Alarm Name | Resource | Metric | Severity |
|------------|----------|--------|----------|
| `hpo-graph-indexer-down` | ECS | RunningTaskCount | Critical |
| `hpo-graph-cpu-high` | ECS | CpuUtilized | Warning |
| `hpo-graph-memory-high` | ECS | MemoryUtilized | Warning |
| `hpo-graph-errors-high` | Custom | graph_indexer_errors | Warning |
| `hpo-graph-sync-lagging` | Custom | graph_sync_lagging | Warning |
| `hpo-graph-alb-5xx` | ALB | HTTPCode_ELB_5XX | Warning |
| `hpo-graph-alb-latency` | ALB | TargetResponseTime | Warning |
| `hpo-graph-alb-unhealthy` | ALB | UnHealthyHostCount | Critical |
| `hpo-spot-indexer-down` | ECS | RunningTaskCount | Critical |
| `hpo-spot-cpu-high` | ECS | CpuUtilized | Warning |
| `hpo-spot-memory-high` | ECS | MemoryUtilized | Warning |
| `hpo-oracle-lambda-failing` | Lambda | Errors | Critical |
| `hpo-oracle-stale` | Custom | oracle_data_age_minutes | Critical |
| `hpo-oracle-duration-high` | Lambda | Duration | Warning |
| `hpo-oracle-throttled` | Lambda | Throttles | Warning |
| `hpo-rds-storage-critical` | RDS | FreeStorageSpace | Critical |
| `hpo-rds-storage-warning` | RDS | FreeStorageSpace | Warning |
| `hpo-rds-cpu-high` | RDS | CPUUtilization | Warning |
| `hpo-rds-connections-high` | RDS | DatabaseConnections | Warning |

### Composite Alarms (5) - Notifications Enabled
These are the human-alertable alarms that aggregate component states.

| Composite Alarm | Triggers When | Components |
|-----------------|---------------|------------|
| `hpo-graph-indexer-unhealthy` | ANY in ALARM | graph_indexer_down, graph_errors_high, graph_cpu_high, graph_memory_high |
| `hpo-spot-indexer-unhealthy` | ANY in ALARM | spot_indexer_down, spot_cpu_high, spot_memory_high |
| `hpo-oracle-unhealthy` | ANY in ALARM | oracle_lambda_errors, oracle_stale, oracle_duration_high, oracle_throttled |
| `hpo-rds-unhealthy` | ANY in ALARM | rds_storage_critical, rds_cpu_high, rds_connections_high |
| `hpo-system-unhealthy` | ANY in ALARM | All 4 composite alarms above |

---

## Oracle Staleness Check

### Implementation Details

The oracle staleness Lambda uses the HashrateOracle contract's `getHashesForBTC()` function:

```python
# Function selector
GET_HASHES_FOR_BTC_SELECTOR = "0x19e26291"  # keccak256("getHashesForBTC()")[:4]

# Returns: (uint256 value, uint256 updatedAt, uint256 ttl)
```

**Staleness Logic:**
```python
is_stale = age_minutes > MAX_AGE_MINUTES
# Also check contract TTL if not infinite (max uint256)
if not ttl_is_infinite and age_seconds > ttl_seconds:
    is_stale = True
```

**Metrics Pushed:**
- `oracle_data_age_minutes` - Age of on-chain data
- `oracle_data_age_seconds` - Age in seconds
- `oracle_is_stale` - 1 if stale, 0 if fresh
- `oracle_hashes_for_btc` - Current hashrate value
- `oracle_ttl_seconds` - Contract TTL (0 if infinite)
- `oracle_staleness_check_success` - Successful check count
- `oracle_staleness_check_failed` - Failed check count (RPC errors)

---

## Dashboard Layout

Dashboard name: `Hashprice-Oracle-${ENV}-Monitor`

| Row | Widgets |
|-----|---------|
| 1 | Title/KPIs, Service Status (task counts), Lambda Executions |
| 2 | Graph Indexer CPU/Memory, Spot Indexer CPU/Memory |
| 3 | Graph Log Metrics, Spot Log Metrics, Oracle Log Metrics |
| 4 | ALB Graph Indexer, ALB Spot Indexer, RDS PostgreSQL |
| 5 | Oracle Data Freshness, Graph Node Query Performance |
| 6 | Oracle Lambda Duration, RDS Storage |

---

## Replication Guide for Other Repos

### Step 1: Copy File Structure
```bash
# Copy from hashprice-oracle as template
cp .bedrock/.terragrunt/70_monitoring_common.tf <new-repo>/.bedrock/.terragrunt/
cp .bedrock/.terragrunt/71_metric_filters.tf <new-repo>/.bedrock/.terragrunt/
cp .bedrock/.terragrunt/80_alarms.tf <new-repo>/.bedrock/.terragrunt/
cp .bedrock/.terragrunt/81_composite_alarms.tf <new-repo>/.bedrock/.terragrunt/
cp .bedrock/.terragrunt/89_dashboards.tf <new-repo>/.bedrock/.terragrunt/
```

### Step 2: Customize for Repo
1. **Update service names** in all files (search/replace `hpo-` with new prefix)
2. **Update log group names** in `71_metric_filters.tf`
3. **Update metric namespace** in `70_monitoring_common.tf`
4. **Update dashboard widgets** in `89_dashboards.tf`
5. **Adjust alarm thresholds** in `terraform.tfvars` for service characteristics

### Step 3: Add Variables
Copy the `monitoring` and `alarm_thresholds` variable blocks to `00_variables.tf`

### Step 4: Configure terraform.tfvars
Add monitoring configuration per environment

### Step 5: Optional Lambdas
- Prometheus scraper: Only if service exposes `/metrics` endpoint
- Staleness checker: Only if service has on-chain state to monitor

---

## Critical Instructions

- **DO NOT APPLY without review** - Always `tgplan` first, user applies
- **DO NOT COMMIT without review** - User commits after verification
- **notifications_enabled = false** for dev/stg to reduce noise
- **Component alarms NEVER notify** - Only composites send alerts
- **Test Lambdas manually** after deployment before relying on scheduled runs
