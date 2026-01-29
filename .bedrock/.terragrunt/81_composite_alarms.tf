################################################################################
# COMPOSITE ALARMS
# Combine multiple alarm states into higher-level health indicators
################################################################################

# TheGraph Subgraph Overall Health
# ALARM if: subgraphs unavailable OR any subgraph has stale data OR indexing errors OR slow response
resource "aws_cloudwatch_composite_alarm" "thegraph_unhealthy" {
  count             = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? 1 : 0
  provider          = aws.use1
  alarm_name        = "hpo-thegraph-${local.env_short}"
  alarm_description = "COMPOSITE: TheGraph subgraphs unhealthy - check component alarms"

  # Combine: unavailable OR any per-subgraph alarm (stale, errors, slow)
  alarm_rule = join(" OR ", concat(
    # Aggregate unavailable alarm
    ["ALARM(${aws_cloudwatch_metric_alarm.thegraph_unavailable[0].alarm_name})"],
    # Per-subgraph data stale alarms
    [for name in local.thegraph_subgraphs : "ALARM(${aws_cloudwatch_metric_alarm.thegraph_data_stale[name].alarm_name})"],
    # Per-subgraph indexing errors alarms
    [for name in local.thegraph_subgraphs : "ALARM(${aws_cloudwatch_metric_alarm.thegraph_indexing_errors[name].alarm_name})"],
    # Per-subgraph slow response alarms
    [for name in local.thegraph_subgraphs : "ALARM(${aws_cloudwatch_metric_alarm.thegraph_response_time[name].alarm_name})"]
  ))

  alarm_actions = local.composite_alarm_actions
  ok_actions    = local.composite_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO TheGraph Unhealthy Composite"
    Severity = "Critical"
  })

  depends_on = [
    aws_cloudwatch_metric_alarm.thegraph_unavailable,
    aws_cloudwatch_metric_alarm.thegraph_data_stale,
    aws_cloudwatch_metric_alarm.thegraph_indexing_errors,
    aws_cloudwatch_metric_alarm.thegraph_response_time,
  ]
}

# Spot Indexer Overall Health
# ALARM if: service down OR high CPU/memory
resource "aws_cloudwatch_composite_alarm" "spot_indexer_unhealthy" {
  count             = (var.monitoring.create && var.monitoring.create_alarms && var.spot_indexer.create) ? 1 : 0
  provider          = aws.use1
  alarm_name        = "hpo-spot-indexer-${local.env_short}"
  alarm_description = "COMPOSITE: Spot Indexer is unhealthy - check component alarms"

  alarm_rule = join(" OR ", [
    "ALARM(${aws_cloudwatch_metric_alarm.spot_indexer_down[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.spot_cpu_high[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.spot_memory_high[0].alarm_name})",
  ])

  alarm_actions = local.composite_alarm_actions
  ok_actions    = local.composite_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Spot Indexer Unhealthy Composite"
    Severity = "Critical"
  })

  depends_on = [
    aws_cloudwatch_metric_alarm.spot_indexer_down,
    aws_cloudwatch_metric_alarm.spot_cpu_high,
    aws_cloudwatch_metric_alarm.spot_memory_high,
  ]
}

# Oracle Overall Health
# ALARM if: lambda errors OR stale data OR throttled
resource "aws_cloudwatch_composite_alarm" "oracle_unhealthy" {
  count             = (var.monitoring.create && var.monitoring.create_alarms && var.oracle_lambda.create) ? 1 : 0
  provider          = aws.use1
  alarm_name        = "hpo-oracle-${local.env_short}"
  alarm_description = "COMPOSITE: Oracle is unhealthy - check component alarms"

  alarm_rule = join(" OR ", compact([
    "ALARM(${aws_cloudwatch_metric_alarm.oracle_lambda_errors[0].alarm_name})",
    var.monitoring.create_oracle_staleness_check ? "ALARM(${aws_cloudwatch_metric_alarm.oracle_stale[0].alarm_name})" : "",
    "ALARM(${aws_cloudwatch_metric_alarm.oracle_duration_high[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.oracle_throttled[0].alarm_name})",
  ]))

  alarm_actions = local.composite_alarm_actions
  ok_actions    = local.composite_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Unhealthy Composite"
    Severity = "Critical"
  })

  depends_on = [
    aws_cloudwatch_metric_alarm.oracle_lambda_errors,
    aws_cloudwatch_metric_alarm.oracle_stale,
    aws_cloudwatch_metric_alarm.oracle_duration_high,
    aws_cloudwatch_metric_alarm.oracle_throttled,
  ]
}

