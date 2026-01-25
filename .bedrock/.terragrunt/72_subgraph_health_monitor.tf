################################################################################
# SUBGRAPH HEALTH MONITOR - Lambda to query Graph Node indexing status
# Queries the GraphQL API to check subgraph sync status and health
################################################################################

locals {
  subgraph_health_monitor_name = "hpo-subgraph-health-${local.env_short}"
  
  # Graph Node status endpoint (GraphQL)
  graph_node_status_url = "https://${aws_route53_record.graph_indexer[0].name}:8030/graphql"
}

################################################################################
# ARCHIVE FILE - Create zip from Python source
################################################################################

data "archive_file" "subgraph_health_monitor" {
  count       = (var.monitoring.create && var.monitoring.create_subgraph_health_monitor && var.graph_indexer.create) ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/72_subgraph_health_monitor.py"
  output_path = "${path.module}/72_subgraph_health_monitor.zip"
}

################################################################################
# LAMBDA FUNCTION
################################################################################

resource "aws_lambda_function" "subgraph_health_monitor" {
  count         = (var.monitoring.create && var.monitoring.create_subgraph_health_monitor && var.graph_indexer.create) ? 1 : 0
  provider      = aws.use1
  function_name = local.subgraph_health_monitor_name
  description   = "Monitors Graph Node subgraph indexing health via GraphQL API"
  role          = aws_iam_role.monitoring_lambda[0].arn
  handler       = "72_subgraph_health_monitor.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 256
  
  filename         = data.archive_file.subgraph_health_monitor[0].output_path
  source_code_hash = data.archive_file.subgraph_health_monitor[0].output_base64sha256

  environment {
    variables = {
      GRAPH_NODE_URL = local.graph_node_status_url
      CW_NAMESPACE   = local.monitoring_namespace
      ENVIRONMENT    = local.env_short
    }
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Subgraph Health Monitor"
      Capability = "Monitoring"
    }
  )

  depends_on = [aws_iam_role.monitoring_lambda]
}

################################################################################
# EVENTBRIDGE SCHEDULE (Every 5 minutes)
################################################################################

resource "aws_cloudwatch_event_rule" "subgraph_health_monitor" {
  count               = (var.monitoring.create && var.monitoring.create_subgraph_health_monitor && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  name                = "${local.subgraph_health_monitor_name}-schedule"
  description         = "Trigger Subgraph Health Monitor every 5 minutes"
  schedule_expression = "rate(5 minutes)"

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Subgraph Health Monitor Schedule"
      Capability = "Monitoring"
    }
  )
}

resource "aws_cloudwatch_event_target" "subgraph_health_monitor" {
  count     = (var.monitoring.create && var.monitoring.create_subgraph_health_monitor && var.graph_indexer.create) ? 1 : 0
  provider  = aws.use1
  rule      = aws_cloudwatch_event_rule.subgraph_health_monitor[0].name
  target_id = "${local.subgraph_health_monitor_name}-target"
  arn       = aws_lambda_function.subgraph_health_monitor[0].arn
}

resource "aws_lambda_permission" "subgraph_health_monitor" {
  count         = (var.monitoring.create && var.monitoring.create_subgraph_health_monitor && var.graph_indexer.create) ? 1 : 0
  provider      = aws.use1
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.subgraph_health_monitor[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.subgraph_health_monitor[0].arn
}
