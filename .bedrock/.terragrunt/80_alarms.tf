################################################################################
# CLOUDWATCH ALARMS
# Critical Priority -> devops_alerts_sns (cell phone in prod)
# Warning Priority -> dev_alerts_sns (Slack)
################################################################################

################################################################################
# CRITICAL PRIORITY ALARMS - Service Down / Data Loss
################################################################################

# Graph Indexer - No Running Tasks
resource "aws_cloudwatch_metric_alarm" "graph_indexer_down" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-graph-indexer-down-${local.env_short}"
  alarm_description   = "CRITICAL: Graph Indexer has no running tasks - service is DOWN"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 300
  statistic           = "Average"
  threshold           = var.alarm_thresholds.ecs_min_running_tasks
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = "ecs-hashprice-oracle-${local.env_short}"
    ServiceName = "svc-graph-indexer-${local.env_short}"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Graph Indexer Down Alarm"
    Severity = "Critical"
  })
}

# Spot Indexer - No Running Tasks
resource "aws_cloudwatch_metric_alarm" "spot_indexer_down" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.spot_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-spot-indexer-down-${local.env_short}"
  alarm_description   = "CRITICAL: Spot Indexer has no running tasks - service is DOWN"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
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
  alarm_description   = "CRITICAL: Oracle Lambda is failing - on-chain data may not be updating"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
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
  evaluation_periods  = local.oracle_alarm_evaluation_periods  # unhealthy_alarm_period / check_rate
  metric_name         = "oracle_data_age_minutes"
  namespace           = local.monitoring_namespace
  period              = local.oracle_staleness_check_period_seconds  # Match Lambda check rate
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

# RDS - Storage Critical
resource "aws_cloudwatch_metric_alarm" "rds_storage_critical" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-rds-storage-critical-${local.env_short}"
  alarm_description   = "CRITICAL: RDS storage below ${var.alarm_thresholds.rds_storage_threshold}GB - database will fill up"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Minimum"
  threshold           = var.alarm_thresholds.rds_storage_threshold * 1073741824  # Convert GB to bytes
  treat_missing_data  = "breaching"

  dimensions = {
    DBInstanceIdentifier = "graph-indexer-${local.env_short}-${var.region_shortname}-v2"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO RDS Storage Critical Alarm"
    Severity = "Critical"
  })
}

# ALB - All Targets Unhealthy (Graph Indexer)
resource "aws_cloudwatch_metric_alarm" "graph_alb_unhealthy" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-graph-alb-unhealthy-${local.env_short}"
  alarm_description   = "CRITICAL: Graph Indexer ALB has unhealthy targets"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Maximum"
  threshold           = var.alarm_thresholds.alb_unhealthy_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = data.aws_lb.graph_indexer[0].arn_suffix
    TargetGroup  = "targetgroup/tg-graph-indexer-http-8000"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Graph ALB Unhealthy Alarm"
    Severity = "Critical"
  })
}

################################################################################
# WARNING PRIORITY ALARMS - Performance / Capacity
################################################################################

# Graph Indexer - High CPU (using metric math for percentage)
resource "aws_cloudwatch_metric_alarm" "graph_cpu_high" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-graph-cpu-high-${local.env_short}"
  alarm_description   = "WARNING: Graph Indexer CPU > ${var.alarm_thresholds.ecs_cpu_threshold}%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
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
        ServiceName = "svc-graph-indexer-${local.env_short}"
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
        ServiceName = "svc-graph-indexer-${local.env_short}"
      }
    }
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Graph CPU High Alarm"
    Severity = "Warning"
  })
}

# Graph Indexer - High Memory (using metric math for percentage)
resource "aws_cloudwatch_metric_alarm" "graph_memory_high" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-graph-memory-high-${local.env_short}"
  alarm_description   = "WARNING: Graph Indexer Memory > ${var.alarm_thresholds.ecs_memory_threshold}%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
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
        ServiceName = "svc-graph-indexer-${local.env_short}"
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
        ServiceName = "svc-graph-indexer-${local.env_short}"
      }
    }
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Graph Memory High Alarm"
    Severity = "Warning"
  })
}

# Spot Indexer - High CPU (using metric math for percentage)
resource "aws_cloudwatch_metric_alarm" "spot_cpu_high" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.spot_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-spot-cpu-high-${local.env_short}"
  alarm_description   = "WARNING: Spot Indexer CPU > ${var.alarm_thresholds.ecs_cpu_threshold}%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
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
  alarm_description   = "WARNING: Spot Indexer Memory > ${var.alarm_thresholds.ecs_memory_threshold}%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
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
  alarm_description   = "WARNING: Oracle Lambda duration > ${var.alarm_thresholds.lambda_duration_threshold}ms - approaching timeout"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
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
  alarm_description   = "WARNING: Oracle Lambda is being throttled"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
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

# RDS - High CPU
resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-rds-cpu-high-${local.env_short}"
  alarm_description   = "WARNING: RDS CPU > ${var.alarm_thresholds.rds_cpu_threshold}%"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.alarm_thresholds.rds_cpu_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = "graph-indexer-${local.env_short}-${var.region_shortname}-v2"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO RDS CPU High Alarm"
    Severity = "Warning"
  })
}

# RDS - High Connections
resource "aws_cloudwatch_metric_alarm" "rds_connections_high" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-rds-connections-high-${local.env_short}"
  alarm_description   = "WARNING: RDS connections > ${var.alarm_thresholds.rds_connections_threshold}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.alarm_thresholds.rds_connections_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = "graph-indexer-${local.env_short}-${var.region_shortname}-v2"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO RDS Connections High Alarm"
    Severity = "Warning"
  })
}

# RDS - Storage Warning (2x threshold)
resource "aws_cloudwatch_metric_alarm" "rds_storage_warning" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-rds-storage-warning-${local.env_short}"
  alarm_description   = "WARNING: RDS storage below ${var.alarm_thresholds.rds_storage_threshold * 2}GB"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Minimum"
  threshold           = var.alarm_thresholds.rds_storage_threshold * 2 * 1073741824  # 2x threshold in bytes
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = "graph-indexer-${local.env_short}-${var.region_shortname}-v2"
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO RDS Storage Warning Alarm"
    Severity = "Warning"
  })
}

# Graph Indexer - Errors from metric filter
resource "aws_cloudwatch_metric_alarm" "graph_errors_high" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_metric_filters && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-graph-errors-high-${local.env_short}"
  alarm_description   = "WARNING: Graph Indexer log errors > ${var.alarm_thresholds.graph_error_threshold}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "graph_indexer_errors"
  namespace           = local.monitoring_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = var.alarm_thresholds.graph_error_threshold
  treat_missing_data  = "notBreaching"

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Graph Errors High Alarm"
    Severity = "Warning"
  })
}

# Graph Indexer - Sync Lagging
resource "aws_cloudwatch_metric_alarm" "graph_sync_lagging" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_metric_filters && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-graph-sync-lagging-${local.env_short}"
  alarm_description   = "WARNING: Graph Indexer sync is lagging behind chain"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "graph_sync_lagging"
  namespace           = local.monitoring_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = var.alarm_thresholds.graph_sync_lag_threshold
  treat_missing_data  = "notBreaching"

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Graph Sync Lagging Alarm"
    Severity = "Warning"
  })
}

# ALB - 5xx Errors (Graph Indexer)
resource "aws_cloudwatch_metric_alarm" "graph_alb_5xx" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-graph-alb-5xx-${local.env_short}"
  alarm_description   = "WARNING: Graph Indexer ALB 5xx errors > ${var.alarm_thresholds.alb_5xx_threshold}"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = var.alarm_thresholds.alb_5xx_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = data.aws_lb.graph_indexer[0].arn_suffix
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Graph ALB 5xx Alarm"
    Severity = "Warning"
  })
}

# ALB - High Latency (Graph Indexer)
resource "aws_cloudwatch_metric_alarm" "graph_alb_latency" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-graph-alb-latency-${local.env_short}"
  alarm_description   = "WARNING: Graph Indexer ALB latency > ${var.alarm_thresholds.alb_latency_threshold}s"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  extended_statistic  = "p95"
  threshold           = var.alarm_thresholds.alb_latency_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = data.aws_lb.graph_indexer[0].arn_suffix
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Graph ALB Latency Alarm"
    Severity = "Warning"
  })
}

################################################################################
# SUBGRAPH HEALTH ALARMS (from health monitor Lambda)
################################################################################

# Subgraph Unhealthy - any subgraph reports unhealthy status
resource "aws_cloudwatch_metric_alarm" "subgraph_unhealthy" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_subgraph_health_monitor && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-subgraph-unhealthy-${local.env_short}"
  alarm_description   = "CRITICAL: One or more subgraphs unhealthy for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} minutes"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods  # unhealthy_alarm_period / check_rate
  threshold           = 2  # Expected number of healthy subgraphs (futures + oracles)
  treat_missing_data  = "breaching"

  metric_query {
    id          = "healthy"
    return_data = true
    metric {
      metric_name = "subgraphs_healthy"
      namespace   = local.monitoring_namespace
      period      = local.subgraph_alarm_period_seconds  # Match check rate
      stat        = "Minimum"
      dimensions = {
        Environment = local.env_short
      }
    }
  }

  # No direct notifications - rolls up to graph_indexer composite alarm
  alarm_actions = []
  ok_actions    = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Subgraph Unhealthy Alarm"
    Severity = "Critical"
  })
}

# Subgraph Not Synced - any subgraph fell behind the chain
resource "aws_cloudwatch_metric_alarm" "subgraph_not_synced" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_subgraph_health_monitor && var.graph_indexer.create) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-subgraph-not-synced-${local.env_short}"
  alarm_description   = "WARNING: One or more subgraphs not synced for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} minutes"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods  # unhealthy_alarm_period / check_rate
  threshold           = 2  # Expected number of synced subgraphs
  treat_missing_data  = "breaching"

  metric_query {
    id          = "synced"
    return_data = true
    metric {
      metric_name = "subgraphs_synced"
      namespace   = local.monitoring_namespace
      period      = local.subgraph_alarm_period_seconds  # Match check rate
      stat        = "Minimum"
      dimensions = {
        Environment = local.env_short
      }
    }
  }

  # No direct notifications - rolls up to graph_indexer composite alarm
  alarm_actions = []
  ok_actions    = []

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Subgraph Not Synced Alarm"
    Severity = "Warning"
  })
}
