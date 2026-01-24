################################################################################
# ORACLE STALENESS CHECK - Lambda to check on-chain oracle freshness
# Queries the hashrate oracle contract and reports data age to CloudWatch
################################################################################

locals {
  oracle_staleness_name = "hpo-oracle-staleness-${local.env_short}"
}

################################################################################
# ARCHIVE FILE - Create zip from Python source
################################################################################

data "archive_file" "oracle_staleness" {
  count       = (var.monitoring.create && var.monitoring.create_oracle_staleness_check && var.oracle_lambda.create) ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/73_oracle_staleness.py"
  output_path = "${path.module}/73_oracle_staleness.zip"
}

################################################################################
# LAMBDA FUNCTION
################################################################################

resource "aws_lambda_function" "oracle_staleness" {
  count         = (var.monitoring.create && var.monitoring.create_oracle_staleness_check && var.oracle_lambda.create) ? 1 : 0
  provider      = aws.use1
  function_name = local.oracle_staleness_name
  description   = "Checks on-chain oracle data freshness and pushes age to CloudWatch"
  role          = aws_iam_role.monitoring_lambda[0].arn
  handler       = "73_oracle_staleness.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 256
  
  filename         = data.archive_file.oracle_staleness[0].output_path
  source_code_hash = data.archive_file.oracle_staleness[0].output_base64sha256

  environment {
    variables = {
      HASHRATE_ORACLE_ADDRESS = var.wallets.hashrate_oracle_address
      ETH_RPC_URL             = var.oracle_lambda_secrets.eth_rpc_url
      CW_NAMESPACE            = local.monitoring_namespace
      ENVIRONMENT             = local.env_short
      MAX_AGE_MINUTES         = tostring(var.alarm_thresholds.oracle_max_age_minutes)
    }
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Oracle Staleness Check"
      Capability = "Monitoring"
    }
  )

  depends_on = [aws_iam_role.monitoring_lambda]
}

################################################################################
# EVENTBRIDGE SCHEDULE (Every 5 minutes)
################################################################################

resource "aws_cloudwatch_event_rule" "oracle_staleness" {
  count               = (var.monitoring.create && var.monitoring.create_oracle_staleness_check && var.oracle_lambda.create) ? 1 : 0
  provider            = aws.use1
  name                = "${local.oracle_staleness_name}-schedule"
  description         = "Trigger Oracle staleness check every 5 minutes"
  schedule_expression = "rate(5 minutes)"

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Oracle Staleness Schedule"
      Capability = "Monitoring"
    }
  )
}

resource "aws_cloudwatch_event_target" "oracle_staleness" {
  count     = (var.monitoring.create && var.monitoring.create_oracle_staleness_check && var.oracle_lambda.create) ? 1 : 0
  provider  = aws.use1
  rule      = aws_cloudwatch_event_rule.oracle_staleness[0].name
  target_id = "${local.oracle_staleness_name}-target"
  arn       = aws_lambda_function.oracle_staleness[0].arn
}

resource "aws_lambda_permission" "oracle_staleness" {
  count         = (var.monitoring.create && var.monitoring.create_oracle_staleness_check && var.oracle_lambda.create) ? 1 : 0
  provider      = aws.use1
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.oracle_staleness[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.oracle_staleness[0].arn
}

