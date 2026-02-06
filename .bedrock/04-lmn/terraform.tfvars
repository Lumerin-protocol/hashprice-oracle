########################################
# Shared Contract Addresses
########################################
# Note: ethereum_rpc_url is defined in secret.auto.tfvars (contains API key)
# Contract addresses for the environment
# DEV uses Arbitrum Sepolia testnet, STG/LMN use Arbitrum mainnet
wallets = {
  clone_factory_address   = "0x6b690383c0391b0cf7d20b9eb7a783030b1f3f96"
  hashrate_oracle_address = "0x6599ef8e2b4a548a86eb82e2dfbc6ceadfceacbd"
  futures_address         = "0x8464dc5ab80e76e497fad318fe6d444408e5ccda"
  multicall_address       = "0xcA11bde05977b3631167028862bE2a173976CA11"
  btcusd_oracle_address   = "0x07895fc9995850112e31e4853e63f1283be65f60" # update 2/6/2026 "0x8d71cD231c2C9b1C85cfa8Cc2b5d0e89974480ea" # DEV ONLY 
}

core_resources = {
  create = true
}

ecs_cluster = {
  create  = true
  protect = false
}

spot_indexer = {
  create          = true
  protect         = false
  task_worker_qty = 1
  task_cpu        = 256
  task_ram        = 512
  ghcr_imagetag   = "latest"
  friendly_name   = "indexer"
}

oracle_lambda = {
  create       = true
  protect      = false
  svc_name     = "oracle-lambda"
  chain_id     = "42161" # arbitrum mainnet
  log_level    = "info"
  job_interval = "5"
}

########################################
# Monitoring Configuration
########################################
monitoring = {
  create                         = true
  create_alarms                  = true
  create_dashboards              = true
  create_metric_filters          = true
  create_subgraph_health_monitor = true
  create_oracle_staleness_check  = true
  notifications_enabled          = true                        # ENABLED for production - alerts go to humans
  dev_alerts_topic_name          = "titanio-lmn-dev-alerts"    # Slack (info/warning)
  devops_alerts_topic_name       = "titanio-lmn-devops-alerts" # Cell phone (critical)
  dashboard_period               = 300
}

# LMN/PROD environment
monitoring_schedule = {
  subgraph_health_rate_minutes   = 5  # how often to run the lambda to check subgraph health
  oracle_staleness_rate_minutes  = 5  # how often to run the lambda to check oracle staleness
  unhealthy_alarm_period_minutes = 15 # how long to wait before triggering an unhealthy alarm
}

# LMN/PROD environment - strict thresholds (account for 15 min check frequency)
alarm_thresholds = {
  ecs_cpu_threshold              = 80
  ecs_memory_threshold           = 85
  ecs_min_running_tasks          = 1
  lambda_error_threshold         = 1
  lambda_duration_threshold      = 45000
  lambda_throttle_threshold      = 1
  alb_5xx_threshold              = 5
  alb_unhealthy_threshold        = 1
  alb_latency_threshold          = 5
  rds_cpu_threshold              = 80
  rds_storage_threshold          = 10
  rds_connections_threshold      = 150
  graph_sync_lag_threshold       = 50
  graph_error_threshold          = 5
  oracle_stale_threshold_minutes = 30 # Business rule: how old should oracle data be before it is considered stale
}

########################################
# Account metadata
########################################
provider_profile  = "titanio-lmn"  # Local account profile ... should match account_shortname..kept separate for future ci/cd
account_shortname = "titanio-lmn"  # shortname account code 7 digit + 3 digit eg: titanio-mst, titanio-inf, or rhodium-prd
account_number    = "330280307271" # 12 digit account number 
account_lifecycle = "prd"          # [sbx, dev, stg, prd] -used for NACL and other reference
default_region    = "us-east-1"
region_shortname  = "use1"

########################################
# Environment Specific Variables
#######################################
vpc_index            = 1
devops_keypair       = "bedrock-titanio-lmn-use1"
titanio_net_edge_vpn = "172.18.16.0/20"
protect_environment  = false
ecs_task_role_arn    = "arn:aws:iam::330280307271:role/ecsTaskExecutionRole" # "arn:aws:iam::330280307271:role/services/bedrock-cicd-lmntkndstui" #

# Default tag values common across all resources in this account.
# Values can be overridden when configuring a resource or module.
default_tags = {
  ServiceOffering = "Cloud Foundation"
  Department      = "DevOps"
  Environment     = "lmn"
  Owner           = "aws-titanio-lmn@titan.io" #AWS Account Email Address 092029861612 | aws-sandbox@titan.io | OrganizationAccountAccessRole 
  Scope           = "Global"
  CostCenter      = null
  Compliance      = null
  Classification  = null
  Repository      = "https://github.com/Lumerin-protocol/futures-marketplace.git//.bedrock/04-lmn"
  ManagedBy       = "Terraform"
}

# Default Tags for Cloud Foundation resources
foundation_tags = {
  Name          = null
  Capability    = null
  Application   = "Lumerin Futures Marketplace - LMN"
  LifecycleDate = null
}