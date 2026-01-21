################################################################################
# SECRETS MANAGER
################################################################################
# AWS Secrets Manager resources for sensitive variables

################################################################################
# GRAPH INDEXER SECRETS
################################################################################
resource "aws_secretsmanager_secret" "graph_indexer" {
  count       = var.graph_indexer.create ? 1 : 0
  name        = "graph-indexer-secrets"
  description = "Graph Indexer Service Secrets"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "graph-indexer-secrets"
  })
}

resource "aws_secretsmanager_secret_version" "graph_indexer" {
  count = var.graph_indexer.create ? 1 : 0
  # lifecycle {
  #   ignore_changes = [secret_string]
  # }
  secret_id = aws_secretsmanager_secret.graph_indexer[count.index].id
  secret_string = jsonencode({
    ethereum_rpc_url = var.ethereum_rpc_url # From secret.auto.tfvars (contains API key)
    graph_indexer_db_password = var.graph_indexer_db_password
  })
}

################################################################################
# SPOT INDEXER SECRETS
################################################################################
resource "aws_secretsmanager_secret" "spot_indexer" {
  count       = var.spot_indexer.create ? 1 : 0
  name        = "spot-indexer-secrets"
  description = "Spot Indexer Service Secrets"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "spot-indexer-secrets"
  })
}

resource "aws_secretsmanager_secret_version" "spot_indexer" {
  count = var.spot_indexer.create ? 1 : 0
  # lifecycle {
  #   ignore_changes = [secret_string]
  # }
  secret_id = aws_secretsmanager_secret.spot_indexer[count.index].id
  secret_string = jsonencode({
          ADMIN_API_KEY = var.admin_api_key
          ETH_NODE_URL = var.ethereum_rpc_url
      })
  }

################################################################################
# ORACLE LAMBDA SECRETS
################################################################################
resource "aws_secretsmanager_secret" "oracle_lambda" {
  count       = var.oracle_lambda.create ? 1 : 0
  name        = "oracle-lambda-secrets"
  description = "Oracle Lambda Service Secrets"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "oracle-lambda-secrets"
  })
}

resource "aws_secretsmanager_secret_version" "oracle_lambda" {
  count = var.oracle_lambda.create ? 1 : 0
  # lifecycle {
  #   ignore_changes = [secret_string]
  # }
  secret_id = aws_secretsmanager_secret.oracle_lambda[count.index].id
  secret_string = jsonencode({
    ethereum_rpc_url = var.ethereum_rpc_url # From secret.auto.tfvars (contains API key)
  })
}