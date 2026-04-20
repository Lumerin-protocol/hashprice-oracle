################################################################################
# SHARED CONTRACT ADDRESSES (used across multiple services)
################################################################################
variable "wallets" {
  description = "Shared contract / wallet addresses (oracle Lambda, staleness checks — target the hashpower/oracle chain, e.g. Base Sepolia in dev)"
  type        = map(string)
  default = {
    clone_factory_address   = ""
    hashrate_oracle_address = "" # legacy (pre-trustless oracle) — still consumed by spot_indexer
    futures_address         = ""
    multicall_address       = ""
    btcusd_oracle_address   = "" # legacy — superseded by btc_usd_address for the new keeper
    # New trustless-oracle addresses (HashpriceBTC SPV + HashpriceUSD aggregator + BTC/USD feed)
    hashprice_btc_address = ""
    hashprice_usd_address = ""
    btc_usd_address       = ""
  }
}

# Spot marketplace stays on Arbitrum while oracle infra may use another chain in the same account.
variable "spot_indexer_contracts" {
  description = "Clone factory and hashrate oracle addresses for the spot indexer (Arbitrum Sepolia / Arbitrum One). Must match var.spot_eth_rpc_url chain."
  type = object({
    clone_factory_address   = string
    hashrate_oracle_address = string
  })
}

variable "gs_subgraphs" {
  description = "Goldsky subgraphs"
  type        = map(string)
}

################################################################################
# Detailed Resource variabeles
################################################################################
variable "core_resources" {
  description = "Core Resources to create"
  type        = map(any)
}
# General Ethereum RPC URL
variable "ethereum_rpc_url" {
  description = "Ethereum RPC URL (Futures Marketplace sub-components)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "ecs_cluster" {
  description = "ECS Cluster to create"
  type        = map(any)
}

########################################
# Spot Indexer Variables
########################################
variable "spot_indexer" {
  description = "Spot Indexer to create"
  type        = map(any)
}
### Spot Indexer Secrets Variables
variable "spot_eth_rpc_url" {
  description = "Spot Ethereum RPC URL (used by spot indexer)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "admin_api_key" {
  description = "Admin API key (used by spot indexer)"
  type        = string
  sensitive   = true
  default     = ""
}

################################################################################
# Oracle Lambda Variables
################################################################################
# Expected keys:
#   create        (bool)   — create the Lambda and its schedule
#   protect       (bool)   — prevent accidental destroy
#   svc_name      (string) — friendly name / log tag
#   chain_id      (string) — EVM chain id the keeper writes to
#   log_level     (string) — trace|debug|info|warn|error|fatal
#   job_interval  (string) — EventBridge rate, in minutes
#   max_batch_size (number, optional, default 10) — blocks per submitBlocks tx
#   confirmations  (number, optional, default 4)  — L2 confirmations to wait
#   poll_interval_ms (number, optional, default 60000) — node daemon only
variable "oracle_lambda" {
  description = "Oracle Lambda (HashpriceBTC keeper) configuration"
  type        = map(any)
}
variable "oracle_lambda_secrets" {
  description = "Oracle Lambda secrets to create"
  type        = map(any)
  sensitive   = true
}

################################################################################
# LEGACY THEGRAPH VARIABLES (retained for backward compatibility)
# Health monitor now uses var.gs_subgraphs directly.
# These can be removed once no other Terraform consumers reference them.
################################################################################
variable "graph_api_key" {
  description = "Legacy — TheGraph Gateway API key (no longer used by health monitor)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "futures_subgraph_id" {
  description = "Legacy — futures subgraph URL (superseded by var.gs_subgraphs.futures)"
  type        = string
  default     = ""
}

variable "oracles_subgraph_id" {
  description = "Legacy — oracles subgraph URL (superseded by var.gs_subgraphs.oracles)"
  type        = string
  default     = ""
}

################################################################################
# MONITORING CONFIGURATION
################################################################################
variable "monitoring" {
  description = "Monitoring configuration for alarms, dashboards, and metric filters"
  type = object({
    create                         = bool
    create_alarms                  = bool
    create_dashboards              = bool
    create_metric_filters          = bool
    create_subgraph_health_monitor = bool
    create_oracle_staleness_check  = bool
    notifications_enabled          = bool # Set false to disable SNS notifications (alarms still visible in console)
    dev_alerts_topic_name          = string
    devops_alerts_topic_name       = string
    dashboard_period               = number
  })
  default = {
    create                         = false
    create_alarms                  = false
    create_dashboards              = false
    create_metric_filters          = false
    create_subgraph_health_monitor = false
    create_oracle_staleness_check  = false
    notifications_enabled          = false
    dev_alerts_topic_name          = ""
    devops_alerts_topic_name       = ""
    dashboard_period               = 300
  }
}

variable "monitoring_schedule" {
  description = "Schedule rates for monitoring Lambdas and alarm timing"
  type = object({
    subgraph_health_rate_minutes   = number # How often to check subgraph health (minutes)
    oracle_staleness_rate_minutes  = number # How often to check oracle staleness (minutes)
    unhealthy_alarm_period_minutes = number # How long to tolerate "bad" before triggering alarm
  })
  default = {
    subgraph_health_rate_minutes   = 5
    oracle_staleness_rate_minutes  = 5
    unhealthy_alarm_period_minutes = 15
  }
}

variable "alarm_thresholds" {
  description = "Environment-specific alarm thresholds (relaxed for dev/stg, strict for prod)"
  type = object({
    ecs_cpu_threshold              = number
    ecs_memory_threshold           = number
    ecs_min_running_tasks          = number
    lambda_error_threshold         = number
    lambda_duration_threshold      = number
    lambda_throttle_threshold      = number
    alb_5xx_threshold              = number
    alb_unhealthy_threshold        = number
    alb_latency_threshold          = number
    rds_cpu_threshold              = number
    rds_storage_threshold          = number
    rds_connections_threshold      = number
    graph_sync_lag_threshold       = number
    graph_error_threshold          = number
    oracle_stale_threshold_minutes = number # Max acceptable oracle age (business rule, not tied to check rate)
  })
  default = {
    ecs_cpu_threshold              = 90
    ecs_memory_threshold           = 90
    ecs_min_running_tasks          = 1
    lambda_error_threshold         = 5
    lambda_duration_threshold      = 55000
    lambda_throttle_threshold      = 10
    alb_5xx_threshold              = 20
    alb_unhealthy_threshold        = 1
    alb_latency_threshold          = 15
    rds_cpu_threshold              = 90
    rds_storage_threshold          = 5
    rds_connections_threshold      = 190
    graph_sync_lag_threshold       = 200
    graph_error_threshold          = 20
    oracle_stale_threshold_minutes = 30 # Max acceptable oracle data age
  }
}

################################################################################
# ACCOUNT METADATA
################################################################################
# ACCOUNT METADATA
########################################
variable "account_shortname" { description = "Code describing customer  and lifecycle. E.g., mst, sbx, dev, stg, prd" }
variable "account_lifecycle" {
  description = "environment lifecycle, can be 'prod', 'nonprod', 'sandbox'...dev and stg are considered nonprod"
  type        = string
}
variable "account_number" {}
variable "default_region" {}
variable "region_shortname" {
  description = "Region 4 character shortname"
  default     = "use1"
}
variable "vpc_index" {}
variable "devops_keypair" {}
variable "titanio_net_edge_vpn" {}
variable "protect_environment" {}
variable "ecs_task_role_arn" {}
variable "default_tags" {
  description = "Default tag values common across all resources in this account. Values can be overridden when configuring a resource or module."
  type        = map(string)
}
variable "foundation_tags" {
  description = "Default Tags for Bedrock Foundation resources"
  type        = map(string)
}
variable "provider_profile" {
  description = "Provider config added for use in aws_config.tf"
}