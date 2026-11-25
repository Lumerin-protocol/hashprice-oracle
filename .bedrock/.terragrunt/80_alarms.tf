################################################################################
# CLOUDWATCH ALARMS
# Component alarms stay silent. Composites notify via foundation-core topics:
#   LMN critical → titanio-lmn-hpdx-page (SMS/email)
#   non-prod / warning path → titanio-{env}-hpdx-alerts (Slack #hpdx-alerts)
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

# Oracle price age. The oracle can only update when Bitcoin produces a block, so a
# long gap between blocks ages it with nothing broken, but nothing liquidates once
# the venues and margin engine reject the price (MAX_ORACLE_STALENESS). Three steps:
# warn (hpo-oracle-warning), then page ahead of the freeze and at it
# (hpo-oracle-freeze). A stuck relay pages through oracle_behind_bitcoin instead.
# Missing data counts as old; the pages need two missed checks in a row.
resource "aws_cloudwatch_metric_alarm" "oracle_age_warn" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_oracle_staleness_check) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-age-warn-${local.env_short}"
  alarm_description   = "The hashprice oracle's last update is over ${var.alarm_thresholds.oracle_warn_age_minutes} minutes old. Usually Bitcoin taking long between blocks; the venues reject the price at ${var.alarm_thresholds.oracle_max_age_minutes} minutes."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "oracle_data_age_minutes"
  namespace           = local.monitoring_namespace
  period              = local.oracle_staleness_check_period_seconds # Match Lambda check rate
  statistic           = "Maximum"
  threshold           = var.alarm_thresholds.oracle_warn_age_minutes
  treat_missing_data  = "breaching"

  dimensions = {
    Environment = local.env_short
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Age Warning Alarm"
    Severity = "Warning"
  })
}

resource "aws_cloudwatch_metric_alarm" "oracle_age_page" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_oracle_staleness_check) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-age-page-${local.env_short}"
  alarm_description   = "The hashprice oracle's last update is over ${var.alarm_thresholds.oracle_page_age_minutes} minutes old; the venues and the margin engine reject the price at ${var.alarm_thresholds.oracle_max_age_minutes} minutes and nothing liquidates until the next update."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = "oracle_data_age_minutes"
  namespace           = local.monitoring_namespace
  period              = local.oracle_staleness_check_period_seconds
  statistic           = "Maximum"
  threshold           = var.alarm_thresholds.oracle_page_age_minutes
  treat_missing_data  = "breaching"

  dimensions = {
    Environment = local.env_short
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Age Page Alarm"
    Severity = "Critical"
  })
}

resource "aws_cloudwatch_metric_alarm" "oracle_stale" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_oracle_staleness_check) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-stale-${local.env_short}"
  alarm_description   = "The hashprice oracle's last update is over ${var.alarm_thresholds.oracle_max_age_minutes} minutes old, so the venues and the margin engine reject the price (MAX_ORACLE_STALENESS) and nothing liquidates."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  metric_name         = "oracle_data_age_minutes"
  namespace           = local.monitoring_namespace
  period              = local.oracle_staleness_check_period_seconds
  statistic           = "Maximum"
  threshold           = var.alarm_thresholds.oracle_max_age_minutes
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

# Relay behind Bitcoin: blocks exist that the keeper has not submitted. Missing data
# (the staleness Lambda could not read the Bitcoin tip or the oracle) counts as behind.
resource "aws_cloudwatch_metric_alarm" "oracle_behind_bitcoin" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_oracle_staleness_check) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-behind-bitcoin-${local.env_short}"
  alarm_description   = "The hashprice oracle trails the Bitcoin tip by ${var.alarm_thresholds.oracle_blocks_behind_threshold} or more blocks for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} minutes: the keeper is not submitting blocks that exist, and after ${var.alarm_thresholds.oracle_max_age_minutes} minutes the venues reject the price."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = local.oracle_alarm_evaluation_periods
  metric_name         = "oracle_blocks_behind"
  namespace           = local.monitoring_namespace
  period              = local.oracle_staleness_check_period_seconds
  statistic           = "Maximum"
  threshold           = var.alarm_thresholds.oracle_blocks_behind_threshold
  treat_missing_data  = "breaching"

  dimensions = {
    Environment = local.env_short
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Behind Bitcoin Alarm"
    Severity = "Critical"
  })
}

################################################################################
# ORACLE RELAY SERVICE (N64)
################################################################################

resource "aws_cloudwatch_metric_alarm" "oracle_relay_down" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && local.create_oracle_relay) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-relay-down-${local.env_short}"
  alarm_description   = "CRITICAL: Oracle relay service has no running task for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} min"
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
    ServiceName = local.oracle_relay.svc_name
  }

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Relay Down Alarm"
    Severity = "Critical"
  })
}

resource "aws_cloudwatch_metric_alarm" "oracle_relay_errors" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && local.create_oracle_relay) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-relay-errors-${local.env_short}"
  alarm_description   = "CRITICAL: Oracle relay logged errors in two consecutive 5-minute periods"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "oracle_relay_errors"
  namespace           = local.monitoring_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Relay Errors Alarm"
    Severity = "Critical"
  })
}

# Heartbeat. The fallback poll ticks every minute even when nothing is due.
resource "aws_cloudwatch_metric_alarm" "oracle_relay_silent" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && local.create_oracle_relay) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-relay-silent-${local.env_short}"
  alarm_description   = "CRITICAL: Oracle relay has not completed a tick for 15 minutes"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "oracle_relay_ticks"
  namespace           = local.monitoring_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "breaching"

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Relay Silent Alarm"
    Severity = "Critical"
  })
}

resource "aws_cloudwatch_metric_alarm" "oracle_relay_slow" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && local.create_oracle_relay) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-relay-slow-${local.env_short}"
  alarm_description   = "CRITICAL: A Bitcoin block took over ${local.oracle_relay_max_seconds / 60} minutes from the relay seeing it to its inclusion on Base"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "oracle_relay_seconds"
  namespace           = local.monitoring_namespace
  period              = 300
  statistic           = "Maximum"
  threshold           = local.oracle_relay_max_seconds
  treat_missing_data  = "notBreaching"

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Relay Slow Alarm"
    Severity = "Critical"
  })
}

resource "aws_cloudwatch_metric_alarm" "oracle_relay_unmined" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && local.create_oracle_relay) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-oracle-relay-unmined-${local.env_short}"
  alarm_description   = "CRITICAL: A relay transaction has been unmined on Base for ${local.oracle_relay_max_unmined_seconds / 60} minutes or more"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "oracle_relay_unmined_seconds"
  namespace           = local.monitoring_namespace
  period              = 300
  statistic           = "Maximum"
  threshold           = local.oracle_relay_max_unmined_seconds
  treat_missing_data  = "notBreaching"

  alarm_actions = local.component_alarm_actions
  ok_actions    = local.component_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Relay Unmined Alarm"
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

################################################################################
# SUBGRAPH HEALTH ALARMS (from Goldsky health monitor Lambda)
# Per-subgraph alarms for: indexing errors, response time, data age
################################################################################

locals {
  # Subgraph names for per-subgraph alarms
  goldsky_subgraphs = ["oracles"]

  # Data age threshold in seconds (convert from minutes threshold)
  subgraph_data_age_threshold_seconds = var.alarm_thresholds.oracle_stale_threshold_minutes * 60

  # Same window in Base blocks (2 seconds each).
  subgraph_behind_blocks = var.alarm_thresholds.oracle_stale_threshold_minutes * 30

  # Response time threshold in milliseconds (5 seconds = concerning)
  subgraph_response_time_threshold_ms = 5000
}

# Subgraphs Unavailable - aggregate check that all subgraphs respond
resource "aws_cloudwatch_metric_alarm" "subgraph_unavailable" {
  count               = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? 1 : 0
  provider            = aws.use1
  alarm_name          = "hpo-subgraph-unavailable-${local.env_short}"
  alarm_description   = "CRITICAL: Goldsky subgraphs unavailable for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} minutes"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods
  threshold           = 1 # The oracles subgraph is the only one this repo monitors
  treat_missing_data  = "breaching"

  metric_query {
    id          = "available"
    return_data = true
    metric {
      metric_name = "subgraphs_available"
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
    Name     = "HPO Subgraph Unavailable Alarm"
    Severity = "Critical"
  })
}

#------------------------------------------------------------------------------
# Per-Subgraph Indexing Errors Alarms
#------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "subgraph_indexing_errors" {
  for_each = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? toset(local.goldsky_subgraphs) : toset([])
  provider = aws.use1

  alarm_name          = "hpo-subgraph-${each.key}-indexing-errors-${local.env_short}"
  alarm_description   = "WARNING: ${each.key} subgraph reporting indexing errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods
  threshold           = 0 # Any errors = alarm
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "errors"
    return_data = true
    metric {
      metric_name = "subgraph_indexing_errors"
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
    Name     = "HPO ${title(each.key)} Subgraph Indexing Errors Alarm"
    Severity = "Warning"
  })
}

#------------------------------------------------------------------------------
# Per-Subgraph Response Time Alarms
#------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "subgraph_response_time" {
  for_each = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? toset(local.goldsky_subgraphs) : toset([])
  provider = aws.use1

  alarm_name          = "hpo-subgraph-${each.key}-slow-${local.env_short}"
  alarm_description   = "WARNING: ${each.key} subgraph response time > ${local.subgraph_response_time_threshold_ms}ms"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods
  threshold           = local.subgraph_response_time_threshold_ms
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "response_time"
    return_data = true
    metric {
      metric_name = "subgraph_response_time_ms"
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
    Name     = "HPO ${title(each.key)} Subgraph Slow Response Alarm"
    Severity = "Warning"
  })
}

#------------------------------------------------------------------------------
# Per-Subgraph Data Age Alarms (staleness in seconds)
#------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "subgraph_data_stale" {
  for_each = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? toset(local.goldsky_subgraphs) : toset([])
  provider = aws.use1

  alarm_name          = "hpo-subgraph-${each.key}-stale-${local.env_short}"
  alarm_description   = "CRITICAL: ${each.key} subgraph data older than ${var.alarm_thresholds.oracle_stale_threshold_minutes} minutes"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods
  threshold           = local.subgraph_data_age_threshold_seconds
  treat_missing_data  = "breaching"

  metric_query {
    id          = "data_age"
    return_data = true
    metric {
      metric_name = "subgraph_data_age_seconds"
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
    Name     = "HPO ${title(each.key)} Subgraph Data Stale Alarm"
    Severity = "Critical"
  })
}

#------------------------------------------------------------------------------
# Per-Subgraph block drift (chain head minus the block Goldsky is serving)
#------------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "subgraph_blocks_behind" {
  for_each = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? toset(local.goldsky_subgraphs) : toset([])
  provider = aws.use1

  alarm_name          = "hpo-subgraph-${each.key}-behind-${local.env_short}"
  alarm_description   = "CRITICAL: ${each.key} subgraph is more than ${var.alarm_thresholds.oracle_stale_threshold_minutes} minutes of blocks behind the chain head. The tag is still indexing or stalled."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = local.subgraph_alarm_evaluation_periods
  threshold           = local.subgraph_behind_blocks
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "blocks_behind"
    return_data = true
    metric {
      metric_name = "subgraph_blocks_behind"
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
    Name     = "HPO ${title(each.key)} Subgraph Behind Alarm"
    Severity = "Critical"
  })
}
