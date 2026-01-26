################################################################################
# MONITORING COMMON - IAM Roles, Data Sources, Locals
################################################################################

locals {
  # Environment short name for resource naming
  env_short = substr(var.account_shortname, 8, 3)
  
  # Monitoring namespace for custom metrics
  monitoring_namespace = "HashpriceOracle-${upper(local.env_short)}"
  
  # Log group names (must match actual log group names)
  graph_indexer_log_group = "/ecs/graph-indexer-${local.env_short}"
  spot_indexer_log_group  = "bedrock-hpo-spot-indexer-${local.env_short}"
  oracle_lambda_log_group = "/aws/lambda/futures-oracle-update-v2"
  
  # SNS Topic ARNs
  dev_alerts_sns_arn    = "arn:aws:sns:${var.default_region}:${var.account_number}:${var.monitoring.dev_alerts_topic_name}"
  devops_alerts_sns_arn = "arn:aws:sns:${var.default_region}:${var.account_number}:${var.monitoring.devops_alerts_topic_name}"
  
  # For dev/stg, route all to Slack (dev-alerts)
  # For prod/lmn, critical goes to devops-alerts (cell), warning to dev-alerts (Slack)
  critical_sns_arn = var.account_lifecycle == "prd" ? local.devops_alerts_sns_arn : local.dev_alerts_sns_arn
  warning_sns_arn  = local.dev_alerts_sns_arn
  
  # Alarm action strategy:
  # - Component alarms: NO notifications (just state tracking for composites)
  # - Composite alarms: YES notifications when notifications_enabled = true
  # This prevents double-alerting when a component triggers its parent composite
  
  # Component alarms - never send notifications (empty actions)
  component_alarm_actions = []
  
  # Composite alarms - send notifications only when enabled
  composite_alarm_actions = var.monitoring.notifications_enabled ? [local.critical_sns_arn] : []
  
  # Alarm periods - match check rates (in seconds)
  oracle_staleness_check_period_seconds = var.monitoring_schedule.oracle_staleness_rate_minutes * 60
  subgraph_alarm_period_seconds         = var.monitoring_schedule.subgraph_health_rate_minutes * 60
  
  # Evaluation periods - how many check periods before alarm triggers
  # Standard CloudWatch metrics (ECS, Lambda, RDS, ALB) use 300-second (5 min) periods
  # Custom Lambdas use their own check rate
  standard_alarm_evaluation_periods     = ceil(var.monitoring_schedule.unhealthy_alarm_period_minutes / 5)
  oracle_alarm_evaluation_periods       = ceil(var.monitoring_schedule.unhealthy_alarm_period_minutes / var.monitoring_schedule.oracle_staleness_rate_minutes)
  subgraph_alarm_evaluation_periods     = ceil(var.monitoring_schedule.unhealthy_alarm_period_minutes / var.monitoring_schedule.subgraph_health_rate_minutes)
  
  # oracle_stale_threshold_minutes is in alarm_thresholds - independent business rule (not tied to check rate)
}

################################################################################
# DATA SOURCES
################################################################################

# Reference existing ECS cluster
data "aws_ecs_cluster" "hashprice_oracle" {
  count        = var.monitoring.create ? 1 : 0
  cluster_name = "ecs-hashprice-oracle-${local.env_short}"
}

# Reference existing ALBs
data "aws_lb" "graph_indexer" {
  count = (var.monitoring.create && var.graph_indexer.create) ? 1 : 0
  name  = "alb-graph-indexer-ext-${local.env_short}"
}

data "aws_lb" "spot_indexer" {
  count = (var.monitoring.create && var.spot_indexer.create) ? 1 : 0
  name  = "alb-spot-indexer-ext-${local.env_short}"
}

# Reference existing RDS instance
data "aws_db_instance" "graph_indexer" {
  count                  = (var.monitoring.create && var.graph_indexer.create) ? 1 : 0
  db_instance_identifier = "graph-indexer-${local.env_short}-${var.region_shortname}-v2"
}

################################################################################
# IAM ROLE FOR MONITORING LAMBDAS
################################################################################

resource "aws_iam_role" "monitoring_lambda" {
  count    = var.monitoring.create ? 1 : 0
  provider = aws.use1
  name     = "hpo-monitoring-lambda-${local.env_short}"

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

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Monitoring Lambda Role"
      Capability = "Monitoring"
    }
  )
}

resource "aws_iam_role_policy" "monitoring_lambda" {
  count    = var.monitoring.create ? 1 : 0
  provider = aws.use1
  name     = "hpo-monitoring-lambda-policy"
  role     = aws_iam_role.monitoring_lambda[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:${var.default_region}:${var.account_number}:*"
      },
      {
        Sid    = "CloudWatchMetrics"
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData"
        ]
        Resource = "*"
      },
      {
        Sid    = "VPCAccess"
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface"
        ]
        Resource = "*"
      }
    ]
  })
}

# Attach basic Lambda execution policy
resource "aws_iam_role_policy_attachment" "monitoring_lambda_basic" {
  count      = var.monitoring.create ? 1 : 0
  role       = aws_iam_role.monitoring_lambda[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}
