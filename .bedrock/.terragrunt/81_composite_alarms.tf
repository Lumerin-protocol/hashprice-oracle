################################################################################
# COMPOSITE ALARMS
# Combine multiple alarm states into higher-level health indicators
################################################################################

# Graph Indexer Overall Health
# ALARM if: service down OR critical errors OR DB errors
resource "aws_cloudwatch_composite_alarm" "graph_indexer_unhealthy" {
  count         = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider      = aws.use1
  alarm_name    = "hpo-graph-indexer-unhealthy-${local.env_short}"
  alarm_description = "COMPOSITE: Graph Indexer is unhealthy - check component alarms"

  alarm_rule = join(" OR ", compact([
    "ALARM(${aws_cloudwatch_metric_alarm.graph_indexer_down[0].alarm_name})",
    var.monitoring.create_metric_filters ? "ALARM(${aws_cloudwatch_metric_alarm.graph_errors_high[0].alarm_name})" : "",
    "ALARM(${aws_cloudwatch_metric_alarm.graph_cpu_high[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.graph_memory_high[0].alarm_name})",
  ]))

  alarm_actions = local.composite_alarm_actions
  ok_actions    = local.composite_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Graph Indexer Unhealthy Composite"
    Severity = "Critical"
  })

  depends_on = [
    aws_cloudwatch_metric_alarm.graph_indexer_down,
    aws_cloudwatch_metric_alarm.graph_errors_high,
    aws_cloudwatch_metric_alarm.graph_cpu_high,
    aws_cloudwatch_metric_alarm.graph_memory_high,
  ]
}

# Spot Indexer Overall Health
# ALARM if: service down OR high CPU/memory
resource "aws_cloudwatch_composite_alarm" "spot_indexer_unhealthy" {
  count         = (var.monitoring.create && var.monitoring.create_alarms && var.spot_indexer.create) ? 1 : 0
  provider      = aws.use1
  alarm_name    = "hpo-spot-indexer-unhealthy-${local.env_short}"
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
  count         = (var.monitoring.create && var.monitoring.create_alarms && var.oracle_lambda.create) ? 1 : 0
  provider      = aws.use1
  alarm_name    = "hpo-oracle-unhealthy-${local.env_short}"
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

# RDS Overall Health
# ALARM if: storage critical OR high CPU OR high connections
resource "aws_cloudwatch_composite_alarm" "rds_unhealthy" {
  count         = (var.monitoring.create && var.monitoring.create_alarms && var.graph_indexer.create) ? 1 : 0
  provider      = aws.use1
  alarm_name    = "hpo-rds-unhealthy-${local.env_short}"
  alarm_description = "COMPOSITE: RDS is unhealthy - check component alarms"

  alarm_rule = join(" OR ", [
    "ALARM(${aws_cloudwatch_metric_alarm.rds_storage_critical[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.rds_cpu_high[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.rds_connections_high[0].alarm_name})",
  ])

  alarm_actions = local.composite_alarm_actions
  ok_actions    = local.composite_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO RDS Unhealthy Composite"
    Severity = "Critical"
  })

  depends_on = [
    aws_cloudwatch_metric_alarm.rds_storage_critical,
    aws_cloudwatch_metric_alarm.rds_cpu_high,
    aws_cloudwatch_metric_alarm.rds_connections_high,
  ]
}

# Overall System Health
# ALARM if any major component is unhealthy
resource "aws_cloudwatch_composite_alarm" "system_unhealthy" {
  count         = (var.monitoring.create && var.monitoring.create_alarms) ? 1 : 0
  provider      = aws.use1
  alarm_name    = "hpo-system-unhealthy-${local.env_short}"
  alarm_description = "COMPOSITE: Hashprice Oracle system has unhealthy components"

  alarm_rule = join(" OR ", compact([
    var.graph_indexer.create ? "ALARM(${aws_cloudwatch_composite_alarm.graph_indexer_unhealthy[0].alarm_name})" : "",
    var.spot_indexer.create ? "ALARM(${aws_cloudwatch_composite_alarm.spot_indexer_unhealthy[0].alarm_name})" : "",
    var.oracle_lambda.create ? "ALARM(${aws_cloudwatch_composite_alarm.oracle_unhealthy[0].alarm_name})" : "",
    var.graph_indexer.create ? "ALARM(${aws_cloudwatch_composite_alarm.rds_unhealthy[0].alarm_name})" : "",
  ]))

  alarm_actions = local.composite_alarm_actions
  ok_actions    = local.composite_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO System Unhealthy Composite"
    Severity = "Critical"
  })

  depends_on = [
    aws_cloudwatch_composite_alarm.graph_indexer_unhealthy,
    aws_cloudwatch_composite_alarm.spot_indexer_unhealthy,
    aws_cloudwatch_composite_alarm.oracle_unhealthy,
    aws_cloudwatch_composite_alarm.rds_unhealthy,
  ]
}
