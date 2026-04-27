################################################################################
# HASHPRICE KEEPER LAMBDA (trustless oracle)
################################################################################
# Off-chain counterpart to the on-chain HashpriceBTC SPV contract. Relays
# Bitcoin block headers + coinbase merkle proofs so HashpriceBTC can advance
# its tip. See keeper/README.md.
#
# Ownership split (the "no-fight" zone):
#   * Terraform   — function "shell": IAM, runtime, schedule, log group.
#                   Sets a single MANAGED_BY placeholder env var at create-time.
#                   Ignores environment changes after that.
#   * GitHub Actions (deploy-keeper.yml) — code zip + the entire env var map
#                   via update-function-code / update-function-configuration.
#
# Adding a new env var? Update deploy-keeper.yml and the GH-side variables
# (vars/secrets at the appropriate scope). Do not template values into the
# environment block below — TF ignores changes to it.
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

# IAM policy for Lambda to access Secrets Manager.
# Currently unused at runtime (the keeper reads PRIVATE_KEY from its env map,
# which GitHub Actions populates from secrets.PRIVATE_KEY). Retained as the
# hardening path: when the keeper switches to runtime GetSecretValue, this
# policy and the aws_secretsmanager_secret.oracle_lambda resource are ready.
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
  description      = "HashpriceBTC keeper — relays BTC headers to the trustless on-chain oracle"
  role             = aws_iam_role.lambda_exec[0].arn
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  timeout          = 60
  memory_size      = 256 # bumped from default 128MB — observed 111MB peak with batch submissions
  source_code_hash = filebase64sha256("placeholder-lambda.zip")

  # Placeholder so the environment block exists at create-time. GitHub Actions
  # (deploy-keeper.yml) overwrites the entire Variables map on the first deploy
  # and owns it forever after. TF ignores environment via the lifecycle block.
  environment {
    variables = {
      MANAGED_BY = "github-actions"
    }
  }

  # All three of these are owned by GitHub Actions:
  #   - filename / source_code_hash: code zip uploaded by update-function-code
  #   - environment: env var map written by update-function-configuration
  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
      environment,
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
