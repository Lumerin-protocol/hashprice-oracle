################################################################################
# CLOUDWATCH ALARMS
# Critical Priority -> devops_alerts_sns (cell phone in prod)
# Warning Priority -> dev_alerts_sns (Slack)
################################################################################

################################################################################
# CRITICAL PRIORITY ALARMS - Service Down / Data Loss
################################################################################

# Spot Indexer - No Running Tasks
resource "aws_cloudwatch_metric_alarm" "spot_indexer_down" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.spot_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-spot-indexer-down-${local.env_short}"
  alarm_description   = "CRITICAL: Spot Indexer down for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} min"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = local.standard_alarm_evaluation_periods
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 300
  statistic           = "Average"
  threshold           = var.alarm_thresholds.ecs_min_running_tasks
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = "ecs-hashprice-oracle-${local.env_short}"
    ServiceName = "svc-spot-indexer-${local.env_short}"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Spot Indexer Down Alarm"
    Severity = "Critical"
  })
}

# Oracle Lambda - Errors
resource "aws_cloudwatch_metric_alarm" "oracle_lambda_errors" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.oracle_lambda.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-lambda-failing-${local.env_short}"
  alarm_description   = "CRITICAL: Oracle Lambda errors for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} min"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.standard_alarm_evaluation_periods
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = var.alarm_thresholds.lambda_error_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = "futures-oracle-update-v2"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Lambda Errors Alarm"
    Severity = "Critical"
  })
}

# Oracle Staleness - Data is Stale
# Alarms when oracle_data_age_minutes > stale_threshold for unhealthy_alarm_period_minutes
resource "aws_cloudwatch_metric_alarm" "oracle_stale" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_oracle_staleness_check) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-stale-${local.env_short}"
  alarm_description   = "CRITICAL: Oracle on-chain data is STALE - exceeds ${var.alarm_thresholds.oracle_stale_threshold_minutes} minutes for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} minutes"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.oracle_alarm_evaluation_periods # unhealthy_alarm_period / check_rate
  metric_name         = "oracle_data_age_minutes"
  namespace           = local.monitoring_namespace
  period              = local.oracle_staleness_check_period_seconds # Match Lambda check rate
  statistic           = "Maximum"
  threshold           = var.alarm_thresholds.oracle_stale_threshold_minutes
  treat_missing_data  = "breaching"

  dimensions = {
    Environment = local.env_short
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Stale Alarm"
    Severity = "Critical"
  })
}

################################################################################
# WARNING PRIORITY ALARMS - Performance / Capacity
################################################################################

# Spot Indexer - High CPU (using metric math for percentage)
resource "aws_cloudwatch_metric_alarm" "spot_cpu_high" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.spot_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-spot-cpu-high-${local.env_short}"
  alarm_description   = "WARNING: Spot CPU >${var.alarm_thresholds.ecs_cpu_threshold}% for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} min"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.standard_alarm_evaluation_periods
  threshold           = var.alarm_thresholds.ecs_cpu_threshold
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "cpu_percent"
    expression  = "(cpu_used / cpu_reserved) * 100"
    label       = "CPU Utilization %"
    return_data = true
  }

  metric_query {
    id = "cpu_used"
    metric {
      metric_name = "CpuUtilized"
      namespace   = "ECS/ContainerInsights"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = "ecs-hashprice-oracle-${local.env_short}"
        ServiceName = "svc-spot-indexer-${local.env_short}"
      }
    }
  }

  metric_query {
    id = "cpu_reserved"
    metric {
      metric_name = "CpuReserved"
      namespace   = "ECS/ContainerInsights"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = "ecs-hashprice-oracle-${local.env_short}"
        ServiceName = "svc-spot-indexer-${local.env_short}"
      }
    }
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Spot CPU High Alarm"
    Severity = "Warning"
  })
}

# Spot Indexer - High Memory (using metric math for percentage)
resource "aws_cloudwatch_metric_alarm" "spot_memory_high" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.spot_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-spot-memory-high-${local.env_short}"
  alarm_description   = "WARNING: Spot Memory >${var.alarm_thresholds.ecs_memory_threshold}% for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} min"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.standard_alarm_evaluation_periods
  threshold           = var.alarm_thresholds.ecs_memory_threshold
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "mem_percent"
    expression  = "(mem_used / mem_reserved) * 100"
    label       = "Memory Utilization %"
    return_data = true
  }

  metric_query {
    id = "mem_used"
    metric {
      metric_name = "MemoryUtilized"
      namespace   = "ECS/ContainerInsights"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = "ecs-hashprice-oracle-${local.env_short}"
        ServiceName = "svc-spot-indexer-${local.env_short}"
      }
    }
  }

  metric_query {
    id = "mem_reserved"
    metric {
      metric_name = "MemoryReserved"
      namespace   = "ECS/ContainerInsights"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = "ecs-hashprice-oracle-${local.env_short}"
        ServiceName = "svc-spot-indexer-${local.env_short}"
      }
    }
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Spot Memory High Alarm"
    Severity = "Warning"
  })
}

# Oracle Lambda - Duration High
resource "aws_cloudwatch_metric_alarm" "oracle_duration_high" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.oracle_lambda.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-duration-high-${local.env_short}"
  alarm_description   = "WARNING: Oracle duration high for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} min"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.standard_alarm_evaluation_periods
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Average"
  threshold           = var.alarm_thresholds.lambda_duration_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = "futures-oracle-update-v2"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Duration High Alarm"
    Severity = "Warning"
  })
}

# Oracle Lambda - Throttled
resource "aws_cloudwatch_metric_alarm" "oracle_throttled" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.oracle_lambda.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-throttled-${local.env_short}"
  alarm_description   = "WARNING: Oracle throttled for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} min"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.standard_alarm_evaluation_periods
  metric_name         = "Throttles"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = var.alarm_thresholds.lambda_throttle_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = "futures-oracle-update-v2"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Throttled Alarm"
    Severity = "Warning"
  })
}

################################################################################
# THEGRAPH SUBGRAPH HEALTH ALARMS (from health monitor Lambda)
# Per-subgraph alarms for: indexing errors, response time, data age
################################################################################

locals {
  # Subgraph names for per-subgraph alarms
  thegraph_subgraphs = ["futures", "oracles"]

  # Data age threshold in seconds (convert from minutes threshold)
  thegraph_data_age_threshold_seconds = var.alarm_thresholds.oracle_stale_threshold_minutes * 60

  # Response time threshold in milliseconds (5 seconds = concerning)
  thegraph_response_time_threshold_ms = 5000
}

# TheGraph Unavailable - aggregate check that both subgraphs respond
resource "aws_cloudwatch_metric_alarm" "thegraph_unavailable" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-thegraph-unavailable-${local.env_short}"
  alarm_description   = "CRITICAL: TheGraph subgraphs unavailable for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} minutes"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods
  threshold           = 2 # Expected: both futures + oracles available
  treat_missing_data  = "breaching"

  metric_query {
    id          = "available"
    return_data = true
    metric {
      metric_name = "thegraph_subgraphs_available"
      namespace   = local.monitoring_namespace
      period      = local.subgraph_alarm_period_seconds
      stat        = "Minimum"
      dimensions = {
        Environment = local.env_short
      }
    }
  }

  alarm_actions = []
  ok_actions    = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO TheGraph Unavailable Alarm"
    Severity = "Critical"
  })
}

#------------------------------------------------------------------------------
# Per-Subgraph Indexing Errors Alarms
#------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "thegraph_indexing_errors" {
  for_each = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? toset(local.thegraph_subgraphs) : toset([])
  provider = aws.use1

  alarm_name          = "hpo-thegraph-${each.key}-indexing-errors-${local.env_short}"
  alarm_description   = "WARNING: TheGraph ${each.key} subgraph reporting indexing errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods
  threshold           = 0 # Any errors = alarm
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "errors"
    return_data = true
    metric {
      metric_name = "thegraph_indexing_errors"
      namespace   = local.monitoring_namespace
      period      = local.subgraph_alarm_period_seconds
      stat        = "Maximum"
      dimensions = {
        Environment = local.env_short
        Subgraph    = each.key
      }
    }
  }

  alarm_actions = []
  ok_actions    = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO TheGraph ${title(each.key)} Indexing Errors Alarm"
    Severity = "Warning"
  })
}

#------------------------------------------------------------------------------
# Per-Subgraph Response Time Alarms
#------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "thegraph_response_time" {
  for_each = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? toset(local.thegraph_subgraphs) : toset([])
  provider = aws.use1

  alarm_name          = "hpo-thegraph-${each.key}-slow-${local.env_short}"
  alarm_description   = "WARNING: TheGraph ${each.key} subgraph response time > ${local.thegraph_response_time_threshold_ms}ms"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods
  threshold           = local.thegraph_response_time_threshold_ms
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "response_time"
    return_data = true
    metric {
      metric_name = "thegraph_response_time_ms"
      namespace   = local.monitoring_namespace
      period      = local.subgraph_alarm_period_seconds
      stat        = "Average"
      dimensions = {
        Environment = local.env_short
        Subgraph    = each.key
      }
    }
  }

  alarm_actions = []
  ok_actions    = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO TheGraph ${title(each.key)} Slow Response Alarm"
    Severity = "Warning"
  })
}

#------------------------------------------------------------------------------
# Per-Subgraph Data Age Alarms (staleness in seconds)
#------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "thegraph_data_stale" {
  for_each = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? toset(local.thegraph_subgraphs) : toset([])
  provider = aws.use1

  alarm_name          = "hpo-thegraph-${each.key}-stale-${local.env_short}"
  alarm_description   = "CRITICAL: TheGraph ${each.key} subgraph data older than ${var.alarm_thresholds.oracle_stale_threshold_minutes} minutes"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods
  threshold           = local.thegraph_data_age_threshold_seconds
  treat_missing_data  = "breaching"

  metric_query {
    id          = "data_age"
    return_data = true
    metric {
      metric_name = "thegraph_data_age_seconds"
      namespace   = local.monitoring_namespace
      period      = local.subgraph_alarm_period_seconds
      stat        = "Maximum"
      dimensions = {
        Environment = local.env_short
        Subgraph    = each.key
      }
    }
  }

  alarm_actions = []
  ok_actions    = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO TheGraph ${title(each.key)} Data Stale Alarm"
    Severity = "Critical"
  })
}
