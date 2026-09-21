########################################
# Shared Contract Addresses
########################################
# Note: ethereum_rpc_url is defined in secret.auto.tfvars (contains API key)
# Contract addresses for the environment
# Base mainnet from config/prd.env (this repo + sibling futures/derivatives prd.env).
# clone_factory has no prd.env counterpart — leave as the Base factory used in 03-stg / sibling 04-lmn.
wallets = {
  clone_factory_address   = "0xb5838586b43b50f9a739d1256a067859fe5b3234"
  hashrate_oracle_address = "0x614dCAfa33AF0705C7b4A37667eF511F400F36d0" # derivatives PRICE_ORACLE_ADDRESS (legacy HashrateOracle)
  futures_address         = "0xf97a1bbfb5e061ef73dad8ebf25939d93639fb7f" # futures FUTURES_ADDRESS
  multicall_address       = "0xcA11bde05977b3631167028862bE2a173976CA11" # futures REACT_APP_MULTICALL_ADDRESS
  btcusd_oracle_address   = "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F" # HASHPRICE / collateral BTC_USD_ADDRESS
  hashprice_btc_address   = "0x70027c6f1b40e7461172af1241330b499c8c2e22" # HASHPRICE_BTC_ADDRESS
}

spot_indexer_contracts = {
  clone_factory_address   = "0x6b690383c0391b0cf7d20b9eb7a783030b1f3f96"
  hashrate_oracle_address = "0x6599ef8e2b4a548a86eb82e2dfbc6ceadfceacbd"
}

# Goldsky project STG-Exchange renamed LMN-Exchange. ID does not change.
# Tag lmn-latest onto the current live versions before the first main CI deploy.
gs_subgraphs = {
  oracles     = "https://api.goldsky.com/api/public/project_cmmz5dm4l7ocp01xng61y5nwr/subgraphs/hpow-oracles/lmn-latest/gn"
  futures     = "https://api.goldsky.com/api/public/project_cmmz5dm4l7ocp01xng61y5nwr/subgraphs/hpow-futures/lmn-latest/gn"
  derivatives = "https://api.goldsky.com/api/public/project_cmmz5dm4l7ocp01xng61y5nwr/subgraphs/hpow-derivatives/lmn-latest/gn"
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
  chain_id     = "8453" # prd.env CHAIN_ID
  log_level    = "debug" # prd.env LOG_LEVEL
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