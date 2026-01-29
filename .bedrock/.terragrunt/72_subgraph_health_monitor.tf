################################################################################
# THEGRAPH SUBGRAPH HEALTH MONITOR
# Lambda to query TheGraph Gateway endpoints for health and data freshness
# Uses production Gateway with API key from Secrets Manager
################################################################################

locals {
  subgraph_health_monitor_name = "hpo-subgraph-health-${local.env_short}"

  # TheGraph Gateway base URL
  thegraph_gateway_base = "https://gateway.thegraph.com/api"
}

################################################################################
# ARCHIVE FILE - Create zip from Python source
################################################################################

data "archive_file" "subgraph_health_monitor" {
  count       = local.should_create_subgraph_monitor ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/72_subgraph_health_monitor.py"
  output_path = "${path.module}/72_subgraph_health_monitor.zip"
}

################################################################################
# LAMBDA FUNCTION
################################################################################

resource "aws_lambda_function" "subgraph_health_monitor" {
  count         = local.should_create_subgraph_monitor ? 1 : 0
  provider      = aws.use1
  function_name = local.subgraph_health_monitor_name
  description   = "Monitors TheGraph Gateway subgraph health via _meta queries"
  role          = aws_iam_role.monitoring_lambda[0].arn
  handler       = "72_subgraph_health_monitor.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 256

  filename         = data.archive_file.subgraph_health_monitor[0].output_path
  source_code_hash = data.archive_file.subgraph_health_monitor[0].output_base64sha256

  environment {
    variables = {
      THEGRAPH_GATEWAY_BASE = local.thegraph_gateway_base
      THEGRAPH_SECRET_ARN   = aws_secretsmanager_secret.thegraph_monitor[0].arn
      CW_NAMESPACE          = local.monitoring_namespace
      ENVIRONMENT           = local.env_short
    }
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO TheGraph Subgraph Health Monitor"
      Capability = "Monitoring"
    }
  )

  depends_on = [aws_iam_role.monitoring_lambda]
}

################################################################################
# EVENTBRIDGE SCHEDULE (configurable rate)
################################################################################

resource "aws_cloudwatch_event_rule" "subgraph_health_monitor" {
  count               = local.should_create_subgraph_monitor ? 1 : 0
  provider            = aws.use1
  name                = "${local.subgraph_health_monitor_name}-schedule"
  description         = "Trigger TheGraph Subgraph Health Monitor every ${var.monitoring_schedule.subgraph_health_rate_minutes} minutes"
  schedule_expression = "rate(${var.monitoring_schedule.subgraph_health_rate_minutes} minutes)"

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO TheGraph Subgraph Health Monitor Schedule"
      Capability = "Monitoring"
    }
  )
}

resource "aws_cloudwatch_event_target" "subgraph_health_monitor" {
  count     = local.should_create_subgraph_monitor ? 1 : 0
  provider  = aws.use1
  rule      = aws_cloudwatch_event_rule.subgraph_health_monitor[0].name
  target_id = "${local.subgraph_health_monitor_name}-target"
  arn       = aws_lambda_function.subgraph_health_monitor[0].arn
}

resource "aws_lambda_permission" "subgraph_health_monitor" {
  count         = local.should_create_subgraph_monitor ? 1 : 0
  provider      = aws.use1
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.subgraph_health_monitor[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.subgraph_health_monitor[0].arn
}
