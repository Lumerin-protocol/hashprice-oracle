########################################
# Shared Contract Addresses
########################################
# Note: ethereum_rpc_url is defined in secret.auto.tfvars (contains API key)
# Contract addresses for the environment
# DEV uses Arbitrum Sepolia testnet, STG/LMN use Arbitrum mainnet
wallets = {
  clone_factory_address   = "0x998135c509b64083cd27ed976c1bcda35ab7a40b"
  hashrate_oracle_address = "0x6f736186d2c93913721e2570c283dff2a08575e9"
  futures_address         = "0xec76867e96d942282fc7aafe3f778de34d41a311"
  multicall_address       = "0xcA11bde05977b3631167028862bE2a173976CA11"
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

graph_indexer = {
  create                     = true
  protect                    = false
  imagetag                   = "graphprotocol/graph-node:v0.41.1" # Latest stable (Sept 2025)
  task_cpu                   = 1024                               # 1 vCPU - increased for subgraph indexing
  task_ram                   = 2048                               # 2 GB - minimum recommended by Graph Protocol
  task_worker_qty            = 1
  db_instance_class          = "db.t3.small"
  db_allocated_storage       = 50
  db_max_allocated_storage   = 200
  db_backup_retention_period = 7
  db_backup_window           = "03:00-04:00"
  db_maintenance_window      = "sun:04:00-sun:05:00"
  db_max_connections         = "200"
}

oracle_lambda = {
  create   = false
  protect  = false
  svc_name = "oracle-lambda"
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