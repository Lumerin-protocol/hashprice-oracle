################################################################################
# SECRETS MANAGER
################################################################################
# AWS Secrets Manager resources for sensitive variables

# IAM policy to allow ECS task execution role to read secrets
resource "aws_iam_policy" "hpo_secret_access" {
  count       = (var.spot_indexer.create || var.oracle_lambda.create || local.should_create_subgraph_monitor) ? 1 : 0
  provider    = aws.use1
  name        = "hpo-secret-access-${substr(var.account_shortname, 8, 3)}"
  description = "Allow ECS tasks and Lambdas to read Hashprice Oracle secrets from Secrets Manager"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = compact([
          var.spot_indexer.create ? aws_secretsmanager_secret.spot_indexer.arn : "",
          var.oracle_lambda.create ? aws_secretsmanager_secret.oracle_lambda.arn : "",
          local.should_create_subgraph_monitor ? aws_secretsmanager_secret.thegraph_monitor[0].arn : ""
        ])
      }
    ]
  })

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Hashprice Oracle Secret Access Policy",
      Capability = null,
    },
  )
}

# Attach the policy to the bedrock foundation role
resource "aws_iam_role_policy_attachment" "hpo_secret_access" {
  count      = (var.spot_indexer.create || var.oracle_lambda.create || local.should_create_subgraph_monitor) ? 1 : 0
  provider   = aws.use1
  role       = "bedrock-foundation-role"
  policy_arn = aws_iam_policy.hpo_secret_access[0].arn
}

################################################################################
# SPOT INDEXER SECRETS
################################################################################
resource "aws_secretsmanager_secret" "spot_indexer" {
  name        = "spot-indexer-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  description = "Spot Indexer Service Secrets"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "spot-indexer-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  })
}

resource "aws_secretsmanager_secret_version" "spot_indexer" {
  count = var.spot_indexer.create ? 1 : 0
  # lifecycle {
  #   ignore_changes = [secret_string]
  # }
  secret_id = aws_secretsmanager_secret.spot_indexer.id
  secret_string = jsonencode({
    ADMIN_API_KEY = var.admin_api_key
    ETH_NODE_URL  = var.spot_eth_rpc_url
  })
}

################################################################################
# ORACLE LAMBDA SECRETS
################################################################################
resource "aws_secretsmanager_secret" "oracle_lambda" {
  name        = "oracle-lambda-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  description = "Oracle Lambda Service Secrets"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "oracle-lambda-secrets-v3-${substr(var.account_shortname, 8, 3)}"
  })
}

resource "aws_secretsmanager_secret_version" "oracle_lambda" {
  count = var.oracle_lambda.create ? 1 : 0
  # lifecycle {
  #   ignore_changes = [secret_string]
  # }
  secret_id = aws_secretsmanager_secret.oracle_lambda.id
  secret_string = jsonencode({
    eth_rpc_url     = var.oracle_lambda_secrets.eth_rpc_url
    bitcoin_rpc_url = var.oracle_lambda_secrets.bitcoin_rpc_url
    private_key     = var.oracle_lambda_secrets.private_key
  })
}

################################################################################
# THEGRAPH MONITORING SECRETS
# API key for querying production TheGraph Gateway endpoints
################################################################################
resource "aws_secretsmanager_secret" "thegraph_monitor" {
  count       = local.should_create_subgraph_monitor ? 1 : 0
  provider    = aws.use1
  name        = "thegraph-monitor-secrets-${substr(var.account_shortname, 8, 3)}"
  description = "TheGraph Gateway API key for subgraph health monitoring"
  tags = merge(var.default_tags, var.foundation_tags, {
    Name = "thegraph-monitor-secrets-${substr(var.account_shortname, 8, 3)}"
  })
}

resource "aws_secretsmanager_secret_version" "thegraph_monitor" {
  count     = (local.should_create_subgraph_monitor && var.graph_api_key != "") ? 1 : 0
  provider  = aws.use1
  secret_id = aws_secretsmanager_secret.thegraph_monitor[0].id
  secret_string = jsonencode({
    api_key             = var.graph_api_key
    futures_subgraph_id = var.futures_subgraph_id
    oracles_subgraph_id = var.oracles_subgraph_id
  })
}
