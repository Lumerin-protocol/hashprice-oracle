################################################################################
# Secret Variables (seeded in secrets.auto.tfvars and stored in AWS secrets manager)
################################################################################
# These variables are now only for documentation and input validation; values are always pulled from AWS Secrets Manager
variable "ethereum_rpc_url" {
  description = "Ethereum RPC URL (used by oracle lambda, indexer, and margin call)"
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

variable "graph_indexer_db_password" {
  description = "Graph Indexer database password"
  type        = string
  sensitive   = true
  default     = ""
}

################################################################################
# VARIABLES 
################################################################################
# All variables set in ./terraform.tfvars must be initialized here
# Any of these variables can be used in any of this environment's .tf files

################################################################################
# SHARED CONTRACT ADDRESSES (used across multiple services)
################################################################################
variable "wallets" {
  description = "Shared contract / wallet addresses"
  type = map (string)
  default = {
    clone_factory_address = ""
    hashrate_oracle_address = ""
    futures_address = ""
    multicall_address = ""
  }
}

################################################################################
# Detailed Resource variabeles
################################################################################
variable "core_resources" {
  description = "Core Resources to create"
  type = map (any)
}

variable "ecs_cluster" {
  description = "ECS Cluster to create"
  type = map (any)
}

variable "graph_indexer" {
  description = "Graph Indexer to create"
  type = map (any)
}

variable "spot_indexer" {
  description = "Spot Indexer to create"
  type = map (any)
}

variable "oracle_lambda" {
  description = "Oracle Lambda to create"
  type = map (any)
}

########################################
########################################
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