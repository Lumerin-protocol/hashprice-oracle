
resource "aws_iam_role" "lambda_exec" {
  count = var.oracle_lambda.create ? 1 : 0
  name  = "oracle-update-lambda-v3-${substr(var.account_shortname, 8, 3)}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

## SSM Parameter Store for Bitcoin Block Data Cache
## Stores the last 144 blocks of Bitcoin data for hashrate calculations
## The Lambda function will read and update this parameter with the latest block data
resource "aws_ssm_parameter" "bitcoin_block_data" {
  count       = var.oracle_lambda.create ? 1 : 0
  name        = "/lumerin/oracle/bitcoin-block-data-v2-${substr(var.account_shortname, 8, 3)}"
  description = "Cache of last 144 Bitcoin blocks for hashrate oracle calculations"
  type        = "String"
  tier        = "Advanced" # Advanced tier supports up to 8KB (needed for 144 blocks of data)

  # Initialize with empty JSON array - Lambda will populate on first run
  value = jsonencode([])

  # Prevent Terraform from reverting changes made by Lambda
  lifecycle {
    ignore_changes = [
      value,
    ]
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Bitcoin Block Data Cache"
      Capability = "Oracle Update"
      Component  = "Lambda"
    },
  )
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  count      = var.oracle_lambda.create ? 1 : 0
  role       = aws_iam_role.lambda_exec[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# IAM policy for Lambda to access SSM Parameter Store
resource "aws_iam_role_policy" "lambda_ssm_access" {
  count = var.oracle_lambda.create ? 1 : 0
  name  = "oracle-lambda-ssm-access-v2-${substr(var.account_shortname, 8, 3)}"
  role  = aws_iam_role.lambda_exec[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:PutParameter"
        ]
        Resource = aws_ssm_parameter.bitcoin_block_data[0].arn
      }
    ]
  })
}

# IAM policy for Lambda to access Secrets Manager
# Allows the Lambda to retrieve the oracle private key at runtime
resource "aws_iam_role_policy" "lambda_secrets_access" {
  count = var.oracle_lambda.create ? 1 : 0
  name  = "oracle-lambda-secrets-access-v2-${substr(var.account_shortname, 8, 3)}"
  role  = aws_iam_role.lambda_exec[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Resource = [
          aws_secretsmanager_secret.oracle_lambda.arn
        ]
      }
    ]
  })
}


resource "aws_lambda_function" "oracle_update" {
  count            = var.oracle_lambda.create ? 1 : 0
  filename         = "placeholder-lambda.zip"
  function_name    = "futures-oracle-update-v2"
  description      = "BTC-USDC Oracle Update Lambda Function"
  role             = aws_iam_role.lambda_exec[0].arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  timeout          = 60
  source_code_hash = filebase64sha256("placeholder-lambda.zip")

  environment {
    variables = merge(
      {
        HASHRATE_ORACLE_ADDRESS = var.wallets.hashrate_oracle_address # Shared variable
        CHAIN_ID                = var.oracle_lambda.chain_id
        LOG_LEVEL               = var.oracle_lambda.log_level
        BITCOIN_RPC_URL         = var.oracle_lambda_secrets.bitcoin_rpc_url
        ETHEREUM_RPC_URL        = var.oracle_lambda_secrets.eth_rpc_url
        PRIVATE_KEY             = var.oracle_lambda_secrets.private_key
        CACHE_PARAMETER_NAME    = aws_ssm_parameter.bitcoin_block_data[0].name       # SSM parameter store name for Bitcoin block cache
      },
      var.account_lifecycle == "dev" ? {
        BTCUSD_ORACLE_ADDRESS = var.wallets.btcusd_oracle_address # Only included in DEV environment
      } : {}
    )
  }

  # Prevent Terraform from reverting code deployed by GitHub Actions
  # Terraform only manages infrastructure (schedule, env vars, IAM, runtime)
  # GitHub Actions manages the actual Lambda code
  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash
    ]
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Lumerin Marketplace Service ",
      Capability = null,
    },
  )
}

resource "aws_cloudwatch_event_rule" "every_5_minutes" {
  count               = var.oracle_lambda.create ? 1 : 0
  name                = "oracle-update-schedule-v2-${substr(var.account_shortname, 8, 3)}"
  schedule_expression = "rate(${var.oracle_lambda.job_interval} minutes)"
}

resource "aws_cloudwatch_event_target" "lambda" {
  count     = var.oracle_lambda.create ? 1 : 0
  rule      = aws_cloudwatch_event_rule.every_5_minutes[0].name
  target_id = "oracle-update-v2-${substr(var.account_shortname, 8, 3)}"
  arn       = aws_lambda_function.oracle_update[0].arn
}

resource "aws_lambda_permission" "allow_cloudwatch" {
  count         = var.oracle_lambda.create ? 1 : 0
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.oracle_update[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.every_5_minutes[0].arn
} 