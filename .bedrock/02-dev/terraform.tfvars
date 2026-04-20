########################################
# Shared Contract Addresses
########################################
# Note: ethereum_rpc_url is defined in secret.auto.tfvars (contains API key)
# Oracle Lambda / subgraph monitoring: DEV targets Base Sepolia.
# Spot indexer stays on Arbitrum Sepolia — use spot_indexer_contracts + spot_eth_rpc_url (secret).
wallets = {
  clone_factory_address   = "0x998135c509b64083cd27ed976c1bcda35ab7a40b"
  hashrate_oracle_address = "0xf97a1bbfb5e061ef73dad8ebf25939d93639fb7f" # legacy — still used by spot_indexer
  futures_address         = "0x56d8d4a03a0f34b93b86e0b7941aff29178d0479"
  multicall_address       = "0xcA11bde05977b3631167028862bE2a173976CA11"
  btcusd_oracle_address   = "0x614dcafa33af0705c7b4a37667ef511f400f36d0" # legacy BTCUSDMock (old keeper)

  # Trustless oracle (Base Sepolia). Values mirror GitHub env `dev` vars as of 2026-04-16.
  hashprice_btc_address = "0x6f501d6ea22c910e657ad3650f45a76dc525e387" # HashpriceBTC SPV contract
  hashprice_usd_address = "0x865c4fb61b85cda3d39a94d4e8de6962f7626c4d" # HashpriceUSD aggregator
  btc_usd_address       = "0x37b5e07c59238ad3bb11ac27129387a67f3340b6" # BTCUSDMock (dev only — keeper refreshes from CoinGecko)
}

# Spot marketplace / proxy-indexer (Arbitrum Sepolia) — must match spot-marketplace .bedrock/02-dev
spot_indexer_contracts = {
  clone_factory_address   = "0x998135c509b64083cd27ed976c1bcda35ab7a40b"
  hashrate_oracle_address = "0x6f736186d2c93913721e2570c283dff2a08575e9"
}

gs_subgraphs = {
  futures     = "https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/hpow-futures/dev-latest/gn"
  oracles     = "https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/hpow-oracles/dev-latest/gn"
  derivatives = "https://api.goldsky.com/api/public/project_cmmz59uoa7b5201wthnkxbuqy/subgraphs/hpow-derivatives/dev-latest/gn"
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
  ghcr_imagetag   = "latest-dev"
  friendly_name   = "indexer"
}

oracle_lambda = {
  create         = true
  protect        = false
  svc_name       = "hashprice-keeper"
  chain_id       = "84532" # Base Sepolia
  log_level      = "info"
  job_interval   = "5" # minutes — EventBridge schedule
  keeper_max_batch_size = 10  # blocks per submitBlocks tx
  keeper_confirmations  = 4   # L2 confirmations to wait after each tx
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
  notifications_enabled          = true # Set true to enable SNS alerts (disabled to reduce noise in dev)
  dev_alerts_topic_name          = "titanio-dev-dev-alerts"
  devops_alerts_topic_name       = "titanio-dev-dev-alerts" # Same as dev-alerts in non-prod (all to Slack)
  dashboard_period               = 300
}

# DEV environment 
monitoring_schedule = {
  subgraph_health_rate_minutes   = 5  # how often to run the lambda to check subgraph health
  oracle_staleness_rate_minutes  = 5  # how often to run the lambda to check oracle staleness
  unhealthy_alarm_period_minutes = 60 # how long to wait before triggering an unhealthy alarm
}

# DEV environment - relaxed thresholds (account for lower check frequency)
alarm_thresholds = {
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
  oracle_stale_threshold_minutes = 30 # Business rule: how old should oracle data be before it is considered stale
}

########################################
# Account metadata
########################################
provider_profile     = "titanio-dev"  # Local account profile ... should match account_shortname..kept separate for future ci/cd
account_shortname    = "titanio-dev"  # shortname account code 7 digit + 3 digit eg: titanio-mst, titanio-inf, or rhodium-prd
account_number       = "434960487817" # 12 digit account number 
account_lifecycle    = "dev"          # [sbx, dev, stg, prd] -used for NACL and other reference
default_region       = "us-east-1"
region_shortname     = "use1"
vpc_index            = 1
devops_keypair       = "bedrock-titanio-dev-use1"
titanio_net_edge_vpn = "172.18.16.0/20"
protect_environment  = false
ecs_task_role_arn    = "arn:aws:iam::434960487817:role/ecsTaskExecutionRole" # "arn:aws:iam::330280307271:role/services/bedrock-cicd-lmntkndstui" #

# Default tag values common across all resources in this account.
# Values can be overridden when configuring a resource or module.
default_tags = {
  ServiceOffering = "Cloud Foundation"
  Department      = "DevOps"
  Environment     = "dev"
  Owner           = "aws-titanio-dev@titan.io" #AWS Account Email Address 092029861612 | aws-sandbox@titan.io | OrganizationAccountAccessRole 
  Scope           = "Global"
  CostCenter      = null
  Compliance      = null
  Classification  = null
  Repository      = "https://github.com/Lumerin-protocol/hashprice-oracle.git//.bedrock/02-dev"
  ManagedBy       = "Terraform"
}

# Default Tags for Cloud Foundation resources
foundation_tags = {
  Name          = null
  Capability    = null
  Application   = "Lumerin Hashprice Oracle - DEV"
  LifecycleDate = null
}