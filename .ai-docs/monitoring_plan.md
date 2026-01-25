# Hashprice Oracle - Monitoring & Alerting Guide

## Overview

The Hashprice Oracle (HPO) system monitors blockchain hashrate data and provides it to smart contracts. This guide explains how we ensure the HPO environment stays healthy through CloudWatch monitoring, alarms, and dashboards.

### System Components

| Component | Purpose | Critical? |
|-----------|---------|-----------|
| **Graph Indexer** | Self-hosted Graph Node indexing futures/oracles subgraphs | Yes - UI depends on it |
| **Spot Indexer** | Contract indexing API for spot marketplace | Yes - API consumers depend on it |
| **Oracle Lambda** | Updates on-chain hashrate data every 5 minutes | Yes - DeFi contracts depend on it |
| **RDS PostgreSQL** | Graph Node database storage | Yes - Graph Indexer depends on it |

---

## Dashboard Quick Reference

**Dashboard Name:** `00-HashpriceOracle-{env}`

Open in CloudWatch Console → Dashboards → `00-HashpriceOracle-lmn` (or dev/stg)

### Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Row 1: Service Status                                                        │
│ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                 │
│ │ ECS Tasks       │ │ Lambda Metrics  │ │ Oracle Staleness│                 │
│ │ (Running count) │ │ (Invokes/Errors)│ │ (Data age mins) │                 │
│ └─────────────────┘ └─────────────────┘ └─────────────────┘                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Row 2: ECS Resource Usage                                                    │
│ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                 │
│ │ Graph Indexer   │ │ Spot Indexer    │ │ Oracle Lambda   │                 │
│ │ CPU/Memory      │ │ CPU/Memory      │ │ Duration        │                 │
│ └─────────────────┘ └─────────────────┘ └─────────────────┘                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Row 3: Log-Based Metrics                                                     │
│ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                 │
│ │ Graph Indexer   │ │ Spot Indexer    │ │ Oracle Lambda   │                 │
│ │ Errors/Blocks   │ │ Errors/Updates  │ │ Errors/Jobs     │                 │
│ └─────────────────┘ └─────────────────┘ └─────────────────┘                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Row 4: Infrastructure                                                        │
│ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                 │
│ │ ALB Graph       │ │ ALB Spot        │ │ RDS PostgreSQL  │                 │
│ │ Requests/5xx    │ │ Requests/5xx    │ │ CPU/Connections │                 │
│ └─────────────────┘ └─────────────────┘ └─────────────────┘                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ Row 5: Application Health                                                    │
│ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                 │
│ │ RDS Storage     │ │ Subgraph Health │ │ Subgraph Entity │                 │
│ │ Free Space (GB) │ │ Healthy/Synced  │ │ Count by ID     │                 │
│ └─────────────────┘ └─────────────────┘ └─────────────────┘                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Metrics to Watch

| Widget | Healthy State | Warning Signs |
|--------|---------------|---------------|
| **ECS Tasks** | All services showing 1+ | Any service at 0 |
| **Subgraph Health** | 2 healthy, 2 synced | Either < 2 |
| **Oracle Data Age** | < 10 minutes | > 10 minutes (stale) |
| **RDS Storage** | > 10 GB free | < 5 GB free |
| **Lambda Errors** | 0 | Any errors |

---

## Alarm Architecture

### Two-Tier System

We use a **two-tier alarm system** to prevent alert flooding:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      COMPOSITE ALARMS (Alert Layer)                          │
│                  ↓ Only these send SNS notifications ↓                       │
│                                                                              │
│    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│    │hpo-graph-    │  │hpo-spot-     │  │hpo-oracle    │  │hpo-rds       │   │
│    │indexer       │  │indexer       │  │              │  │              │   │
│    └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│           │                 │                 │                 │            │
└───────────┼─────────────────┼─────────────────┼─────────────────┼────────────┘
            │                 │                 │                 │
            ▼                 ▼                 ▼                 ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                     COMPONENT ALARMS (State Layer)                            │
│                 ↓ NO notifications - state tracking only ↓                    │
│                                                                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│  │svc_down │ │cpu_high │ │mem_high │ │errors   │ │stale    │ │storage  │    │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘    │
│                                                                               │
│  Visible in CloudWatch Alarms console for debugging                           │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Why This Design?

**Without composites:** If CPU goes high, you'd get:
- Alert: "CPU High" 
- Alert: "Graph Indexer Unhealthy" (because CPU triggered composite)
- That's noise!

**With composites:** You get ONE alert: "Graph Indexer Unhealthy"
- Go to dashboard
- See which component triggered it
- Take action

---

## Composite Alarms Reference

### hpo-graph-indexer-{env}
**Triggers when:** Graph Indexer service is unhealthy

| Component Alarm | Condition | Severity |
|-----------------|-----------|----------|
| `hpo-graph-indexer-down` | Running tasks = 0 | Critical |
| `hpo-graph-cpu-high` | CPU > threshold | Warning |
| `hpo-graph-memory-high` | Memory > threshold | Warning |
| `hpo-graph-errors-high` | Log errors > threshold | Warning |
| `hpo-subgraph-unhealthy` | Any subgraph health != "healthy" | Critical |
| `hpo-subgraph-not-synced` | Any subgraph not synced with chain | Warning |

**Response:**
1. Check dashboard "Subgraph Health Status" widget
2. If subgraph unhealthy: Check Graph Node logs for errors
3. If service down: Check ECS console for task failures
4. If CPU/Memory high: Consider scaling or investigating resource leak

---

### hpo-spot-indexer-{env}
**Triggers when:** Spot Indexer service is unhealthy

| Component Alarm | Condition | Severity |
|-----------------|-----------|----------|
| `hpo-spot-indexer-down` | Running tasks = 0 | Critical |
| `hpo-spot-cpu-high` | CPU > threshold | Warning |
| `hpo-spot-memory-high` | Memory > threshold | Warning |

**Response:**
1. Check ECS console for task status
2. Review Spot Indexer logs for errors
3. Verify ALB health checks

---

### hpo-oracle-{env}
**Triggers when:** Oracle Lambda is unhealthy

| Component Alarm | Condition | Severity |
|-----------------|-----------|----------|
| `hpo-oracle-lambda-failing` | Lambda errors > 0 | Critical |
| `hpo-oracle-stale` | On-chain data age > threshold | Critical |
| `hpo-oracle-duration-high` | Execution time too long | Warning |
| `hpo-oracle-throttled` | Lambda throttled | Warning |

**Response:**
1. Check Oracle Lambda logs for error details
2. If stale: Verify Lambda is executing, check wallet balance for gas
3. If duration high: Check RPC endpoint latency
4. If throttled: Check Lambda concurrency limits

---

### hpo-rds-{env}
**Triggers when:** RDS database is unhealthy

| Component Alarm | Condition | Severity |
|-----------------|-----------|----------|
| `hpo-rds-storage-critical` | Free storage < 5GB | Critical |
| `hpo-rds-cpu-high` | CPU > threshold | Warning |
| `hpo-rds-connections-high` | Connections > threshold | Warning |

**Response:**
1. If storage critical: Increase allocated storage immediately
2. If CPU high: Check for expensive queries, consider scaling
3. If connections high: Check for connection leaks, restart services if needed

---

## Subgraph Health Monitoring

The Subgraph Health Monitor Lambda queries the Graph Node's GraphQL API to check indexing status every 5 minutes (configurable via `monitoring_schedule.subgraph_health_rate_minutes`).

### How It Works

```
Lambda (every 5 min)
    │
    ▼
GraphQL Query: POST https://graph.{env}.lumerin.io:8030/graphql
{
  indexingStatuses {
    subgraph    # IPFS CID (unique per deployment)
    synced      # true = caught up with chain
    health      # "healthy" | "unhealthy" | "failed"
    entityCount # number of indexed entities
  }
}
    │
    ▼
CloudWatch Metrics (per subgraph):
  - subgraph_synced (1/0)
  - subgraph_health (1=healthy, 0=unhealthy)
  - subgraph_entity_count

CloudWatch Metrics (aggregate):
  - subgraphs_total
  - subgraphs_healthy
  - subgraphs_synced
  - subgraphs_total_entities
```

### Subgraph Deployment Visibility

When a subgraph is updated, it gets a **new IPFS CID**. The dashboard will show:
- Old subgraph (e.g., `QmaRZwdL...`) - entity count stays flat
- New subgraph (e.g., `QmNewXYZ...`) - entity count grows as it syncs

This provides visibility into:
- Deployment progress (watch new subgraph sync)
- Cutover timing (when new is synced)
- Rollback detection (if old version reappears)

---

## Oracle Staleness Monitoring

The Oracle Staleness Lambda checks on-chain data freshness every 5 minutes (configurable via `monitoring_schedule.oracle_staleness_rate_minutes`).

### How It Works

```
Lambda (every 5 min)
    │
    ▼
RPC Call to HashrateOracle Contract
  getHashesForBTC() → (value, updatedAt, ttl)
    │
    ▼
Calculate age: now - updatedAt
    │
    ▼
CloudWatch Metrics:
  - oracle_data_age_minutes   ← Dashboard shows this as high-water mark
  - oracle_is_stale (1/0)     ← Based on stale_threshold
  - oracle_hashes_for_btc (current value)
```

### Three Independent Variables

| Variable | Purpose | All Environments |
|----------|---------|------------------|
| `oracle_staleness_rate_minutes` | How often Lambda checks | 5 min |
| `oracle_stale_threshold_minutes` | Business rule: data older than this is "stale" | 10 min |
| `unhealthy_alarm_period_minutes` | How long to tolerate "bad" before alarm triggers | Varies by env |

**How the alarm works:**
- Lambda runs every 5 minutes (all environments)
- Each run reports `oracle_data_age_minutes` to CloudWatch
- If age > 10 min (`stale_threshold`), that reading is "bad"
- Alarm triggers after `unhealthy_alarm_period_minutes` of consecutive bad readings
- Evaluation periods = `unhealthy_alarm_period / check_rate` (auto-calculated)

### Environment Configuration

| Environment | Check Rate | Stale Threshold | Unhealthy Period | Time to Alarm |
|-------------|------------|-----------------|------------------|---------------|
| DEV | 5 min | 10 min | 60 min | 60 min (12 periods) |
| STG | 5 min | 10 min | 30 min | 30 min (6 periods) |
| LMN/Prod | 5 min | 10 min | 15 min | 15 min (3 periods) |

- **Stale threshold** is a business rule - when is data considered "stale"
- **Unhealthy period** controls alarm sensitivity - production alerts faster
- **Check rate** is the same everywhere for consistent data granularity

---

## Environment Configuration

### Notification Settings

| Environment | notifications_enabled | Alert Target |
|-------------|----------------------|--------------|
| DEV | `false` | None (console only) |
| STG | `false` | None (console only) |
| LMN/Prod | `true` | SNS → DevOps phones |

### Threshold Examples

| Threshold | DEV | LMN/Prod | Notes |
|-----------|-----|----------|-------|
| `ecs_cpu_threshold` | 90% | 80% | Lower in prod for earlier warning |
| `ecs_memory_threshold` | 90% | 85% | Lower in prod |
| `lambda_error_threshold` | 5 | 1 | Strict in prod |
| `oracle_stale_threshold_minutes` | 10 | 10 | Business rule (same all envs) |
| `rds_storage_threshold` | 5 GB | 10 GB | More headroom in prod |

### Monitoring Schedule

| Setting | DEV | STG | LMN/Prod | Notes |
|---------|-----|-----|----------|-------|
| `subgraph_health_rate_minutes` | 5 | 5 | 5 | How often to check |
| `oracle_staleness_rate_minutes` | 5 | 5 | 5 | How often to check |
| `unhealthy_alarm_period_minutes` | 60 | 30 | 15 | How long before alarm triggers |

**Note:** Check rates are the same across environments (5 min) for consistent data. The `unhealthy_alarm_period_minutes` controls alarm sensitivity - production alerts faster while dev/stg tolerate longer periods of "bad" before alerting.

---

## File Structure

```
.bedrock/.terragrunt/
├── 70_monitoring_common.tf          # IAM, data sources, alarm action locals
├── 71_metric_filters.tf             # CloudWatch Log metric filters
├── 72_subgraph_health_monitor.tf    # Lambda to query subgraph health
├── 72_subgraph_health_monitor.py    # Python Lambda code
├── 73_oracle_staleness.tf           # Lambda to check on-chain freshness
├── 73_oracle_staleness.py           # Python Lambda code
├── 80_alarms.tf                     # Component alarms (no notifications)
├── 81_composite_alarms.tf           # Composite alarms (notifications)
└── 89_dashboards.tf                 # CloudWatch dashboard
```

---

## Runbook: Responding to Alerts

### Alert: "hpo-graph-indexer-{env}"

1. **Open Dashboard:** CloudWatch → Dashboards → `00-HashpriceOracle-{env}`
2. **Check "Subgraph Health Status" widget:**
   - If healthy < 2: A subgraph has failed
   - If synced < 2: A subgraph is behind
3. **Check Graph Indexer logs:**
   - CloudWatch → Log groups → `/ecs/graph-indexer-{env}`
   - Look for `ERRO` or `CRIT` level messages
4. **Check ECS service:**
   - ECS Console → Cluster → Services → graph-indexer
   - Verify task is running, check events for failures
5. **Check RDS:**
   - Is the database accessible? Check `hpo-rds-*` composite

### Alert: "hpo-oracle-{env}"

1. **Open Dashboard:** Check "Oracle Data Age" widget
2. **If data is stale (> threshold):**
   - Check Lambda logs: CloudWatch → `/aws/lambda/marketplace-oracle-update`
   - Look for errors in recent invocations
   - Check wallet balance for gas (may need ETH/ARB)
3. **If Lambda is erroring:**
   - Check RPC endpoint availability
   - Check contract address is correct
   - Verify Lambda has necessary permissions
4. **Manual test:** Invoke Lambda manually from AWS Console

### Alert: "hpo-rds-{env}"

1. **If storage critical:**
   - RDS Console → Modify → Increase allocated storage
   - This is non-disruptive but takes time
2. **If CPU high:**
   - Check Performance Insights for slow queries
   - Consider RDS instance size upgrade
3. **If connections high:**
   - Restart Graph Indexer to release connections
   - Check for connection pool leaks

---

## Maintenance Tasks

### Weekly Review
- Check dashboard for trends (storage growth, memory creep)
- Review any alarms that fired
- Verify Lambda schedules are executing

### Monthly Review
- Review and adjust thresholds based on observed patterns
- Check CloudWatch costs
- Verify SNS subscriptions are active

### After Deployments
- Watch Subgraph Entity Count for new subgraph sync progress
- Monitor Graph Indexer logs for indexing errors
- Verify Oracle Lambda continues executing successfully

---

## Terraform Variables Reference

### monitoring object
```hcl
monitoring = {
  create                         = bool   # Master switch for all monitoring
  create_alarms                  = bool   # Create CloudWatch alarms
  create_dashboards              = bool   # Create CloudWatch dashboard
  create_metric_filters          = bool   # Create log metric filters
  create_subgraph_health_monitor = bool   # Create subgraph health Lambda
  create_oracle_staleness_check  = bool   # Create oracle staleness Lambda
  notifications_enabled          = bool   # Enable SNS notifications
  dev_alerts_topic_name          = string # SNS topic for Slack
  devops_alerts_topic_name       = string # SNS topic for critical alerts
  dashboard_period               = number # Dashboard refresh (seconds)
}
```

### monitoring_schedule object
```hcl
monitoring_schedule = {
  subgraph_health_rate_minutes   = number  # How often to check subgraph health (minutes)
  oracle_staleness_rate_minutes  = number  # How often to check oracle freshness (minutes)
  unhealthy_alarm_period_minutes = number  # How long to tolerate "bad" before alarm triggers
}
```

**How it works:**
- Check rates (5 min recommended) determine data granularity
- `unhealthy_alarm_period_minutes` controls alarm sensitivity
- Evaluation periods are auto-calculated: `unhealthy_alarm_period / check_rate`

**Example (LMN with 5 min check rate, 15 min unhealthy period):**
- Lambda runs every 5 min
- If unhealthy, alarm fires after 15 min (3 consecutive bad readings)
- Recovery also takes 15 min (3 consecutive good readings)

**Cost note:** At 5-min intervals, each Lambda costs ~$0.009/month (~1 cent). Cost is negligible.

### alarm_thresholds object
```hcl
alarm_thresholds = {
  ecs_cpu_threshold              = number  # ECS CPU % (0-100)
  ecs_memory_threshold           = number  # ECS Memory % (0-100)
  ecs_min_running_tasks          = number  # Minimum running tasks
  lambda_error_threshold         = number  # Lambda error count
  lambda_duration_threshold      = number  # Lambda duration (ms)
  lambda_throttle_threshold      = number  # Lambda throttle count
  alb_5xx_threshold              = number  # ALB 5xx error count
  alb_unhealthy_threshold        = number  # ALB unhealthy hosts
  alb_latency_threshold          = number  # ALB latency (seconds)
  rds_cpu_threshold              = number  # RDS CPU %
  rds_storage_threshold          = number  # RDS free storage (GB)
  rds_connections_threshold      = number  # RDS connection count
  graph_sync_lag_threshold       = number  # Graph sync lag events
  graph_error_threshold          = number  # Graph error count
  oracle_stale_threshold_minutes = number  # Max oracle data age (business rule)
}
```

**Key variable relationships:**
- `oracle_stale_threshold_minutes` - Business rule: when is data "stale" (10 min)
- `oracle_staleness_rate_minutes` - How often we check (5 min)
- `unhealthy_alarm_period_minutes` - How long to wait before alerting (varies by env)

These are intentionally independent. The stale threshold defines the business rule, the check rate determines data granularity, and the unhealthy period controls alarm sensitivity.
