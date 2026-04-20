################################################################################
# HASHPRICE KEEPER LAMBDA (trustless oracle)
################################################################################
# This Lambda is the off-chain counterpart to the on-chain HashpriceBTC SPV
# contract. It relays Bitcoin block headers + coinbase merkle proofs and
# (in dev) refreshes the BTC/USD mock feed. See keeper/README.md.
#
# Ownership split:
#   * Terraform  — function resource, runtime, IAM, schedule, ENVIRONMENT MAP
#   * GitHub Actions (deploy-keeper.yml) — code bytes only (update-function-code)
#
# The GH Actions IAM role intentionally does NOT have UpdateFunctionConfiguration;
# env vars are managed exclusively here to avoid TF↔Actions drift.
################################################################################

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

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  count      = var.oracle_lambda.create ? 1 : 0
  role       = aws_iam_role.lambda_exec[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# NOTE: The old keeper cached 144 blocks of Bitcoin data in SSM to compute
# average hashrate off-chain. The new trustless keeper reads oracle state from
# the HashpriceBTC contract (getBlockFromTip) and fresh headers from Bitcoin
# RPC each tick. The SSM parameter and its IAM policy have been retired.

# NOTE: The Lambda does not call Secrets Manager at runtime. Runtime secrets
# live in environment.variables below (TF-managed, sourced from tfvars).
# Follow-up hardening path: add a Secrets Manager fetch in adapters/lambda.ts
# so PRIVATE_KEY never appears in the Lambda env map — at which point this
# role would need secretsmanager:GetSecretValue re-attached.

resource "aws_lambda_function" "oracle_update" {
  count            = var.oracle_lambda.create ? 1 : 0
  filename         = "placeholder-lambda.zip"
  function_name    = "futures-oracle-update-v2"
  description      = "HashpriceBTC keeper — relays BTC headers to the trustless on-chain oracle"
  role             = aws_iam_role.lambda_exec[0].arn
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  timeout          = 60
  source_code_hash = filebase64sha256("placeholder-lambda.zip")

  environment {
    variables = merge(
      {
        # Runtime endpoints & creds (from oracle_lambda_secrets tfvars)
        BITCOIN_RPC_URL  = var.oracle_lambda_secrets.bitcoin_rpc_url
        ETHEREUM_RPC_URL = var.oracle_lambda_secrets.eth_rpc_url
        PRIVATE_KEY      = var.oracle_lambda_secrets.private_key

        # Chain + contract targets
        CHAIN_ID              = var.oracle_lambda.chain_id
        HASHPRICE_BTC_ADDRESS = var.wallets.hashprice_btc_address

        # Keeper tuning knobs (names match keeper/src/config.ts)
        LOG_LEVEL             = var.oracle_lambda.log_level
        KEEPER_MAX_BATCH_SIZE = var.oracle_lambda.keeper_max_batch_size
        KEEPER_CONFIRMATIONS  = var.oracle_lambda.keeper_confirmations
      },
      # Non-prod convenience: let the keeper also drive the BTCUSDMock feed.
      # In prod, leave btc_usd_address empty and point HashpriceUSD at the
      # real Chainlink BTC/USD aggregator via deploy-subgraph.yml vars.
      var.wallets.btc_usd_address != "" ? {
        BTC_USD_ADDRESS = var.wallets.btc_usd_address
      } : {}
    )
  }

  # Terraform owns infra and env vars. GitHub Actions only updates code bytes.
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
      Name       = "Hashprice Keeper Lambda",
      Capability = "Oracle",
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
