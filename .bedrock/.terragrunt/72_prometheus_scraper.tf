################################################################################
# PROMETHEUS SCRAPER - Lambda to scrape Graph Node metrics and push to CloudWatch
# Graph Node exposes Prometheus metrics on port 8030
################################################################################

locals {
  prometheus_scraper_name = "hpo-prometheus-scraper-${local.env_short}"
}

################################################################################
# ARCHIVE FILE - Create zip from Python source
################################################################################

data "archive_file" "prometheus_scraper" {
  count       = (var.monitoring.create && var.monitoring.create_prometheus_scraper && var.graph_indexer.create) ? 1 : 0
  type        = "zip"
  source_file = "${path.module}/72_prometheus_scraper.py"
  output_path = "${path.module}/72_prometheus_scraper.zip"
}

################################################################################
# LAMBDA FUNCTION
################################################################################

resource "aws_lambda_function" "prometheus_scraper" {
  count         = (var.monitoring.create && var.monitoring.create_prometheus_scraper && var.graph_indexer.create) ? 1 : 0
  provider      = aws.use1
  function_name = local.prometheus_scraper_name
  description   = "Scrapes Prometheus metrics from Graph Node and pushes to CloudWatch"
  role          = aws_iam_role.monitoring_lambda[0].arn
  handler       = "72_prometheus_scraper.lambda_handler"
  runtime       = "python3.12"
  timeout       = 60
  memory_size   = 256
  
  filename         = data.archive_file.prometheus_scraper[0].output_path
  source_code_hash = data.archive_file.prometheus_scraper[0].output_base64sha256

  vpc_config {
    subnet_ids         = [for m in data.aws_subnet.middle_use1_1 : m.id]
    security_group_ids = [aws_security_group.prometheus_scraper[0].id]
  }

  environment {
    variables = {
      GRAPH_NODE_METRICS_URL = "http://${aws_route53_record.graph_indexer[0].name}:8030/metrics"
      CW_NAMESPACE           = local.monitoring_namespace
      ENVIRONMENT            = local.env_short
    }
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Prometheus Scraper"
      Capability = "Monitoring"
    }
  )

  depends_on = [aws_iam_role.monitoring_lambda]
}

################################################################################
# SECURITY GROUP FOR LAMBDA (VPC ACCESS)
################################################################################

resource "aws_security_group" "prometheus_scraper" {
  count       = (var.monitoring.create && var.monitoring.create_prometheus_scraper && var.graph_indexer.create) ? 1 : 0
  provider    = aws.use1
  name        = "${local.prometheus_scraper_name}-sg"
  description = "Security group for Prometheus scraper Lambda"
  vpc_id      = data.aws_vpc.use1_1.id

  # Egress to Graph Node metrics port
  egress {
    description = "HTTPS to Graph Node metrics"
    from_port   = 8030
    to_port     = 8030
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.use1_1.cidr_block]
  }

  # Egress for CloudWatch API
  egress {
    description = "HTTPS for AWS API calls"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Prometheus Scraper SG"
      Capability = "Monitoring"
    }
  )
}

################################################################################
# EVENTBRIDGE SCHEDULE (Every 5 minutes)
################################################################################

resource "aws_cloudwatch_event_rule" "prometheus_scraper" {
  count               = (var.monitoring.create && var.monitoring.create_prometheus_scraper && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  name                = "${local.prometheus_scraper_name}-schedule"
  description         = "Trigger Prometheus scraper every 5 minutes"
  schedule_expression = "rate(5 minutes)"

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Prometheus Scraper Schedule"
      Capability = "Monitoring"
    }
  )
}

resource "aws_cloudwatch_event_target" "prometheus_scraper" {
  count     = (var.monitoring.create && var.monitoring.create_prometheus_scraper && var.graph_indexer.create) ? 1 : 0
  provider  = aws.use1
  rule      = aws_cloudwatch_event_rule.prometheus_scraper[0].name
  target_id = "${local.prometheus_scraper_name}-target"
  arn       = aws_lambda_function.prometheus_scraper[0].arn
}

resource "aws_lambda_permission" "prometheus_scraper" {
  count         = (var.monitoring.create && var.monitoring.create_prometheus_scraper && var.graph_indexer.create) ? 1 : 0
  provider      = aws.use1
  statement_id  = "AllowExecutionFromCloudWatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.prometheus_scraper[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.prometheus_scraper[0].arn
}

