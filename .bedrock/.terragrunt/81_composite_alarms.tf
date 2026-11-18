################################################################################
# COMPOSITE ALARMS
# Combine multiple alarm states into higher-level health indicators
################################################################################

# Subgraph Overall Health (Goldsky)
# ALARM if: subgraphs unavailable OR any subgraph has stale data OR indexing errors OR slow response
resource "aws_cloudwatch_composite_alarm" "subgraph_unhealthy" {
  count             = (var.monitoring.create && var.monitoring.create_alarms && local.should_create_subgraph_monitor) ? 1 : 0
  provider          = aws.use1
  alarm_name        = "hpo-subgraph-${local.env_short}"
  alarm_description = "COMPOSITE: Oracle subgraph unhealthy - check component alarms"

  # Combine: unavailable OR any per-subgraph alarm (stale, behind, errors, slow)
  alarm_rule = join(" OR ", concat(
    # Aggregate unavailable alarm
    ["ALARM(${aws_cloudwatch_metric_alarm.subgraph_unavailable[0].alarm_name})"],
    # Per-subgraph data stale alarms
    [for name in local.goldsky_subgraphs : "ALARM(${aws_cloudwatch_metric_alarm.subgraph_data_stale[name].alarm_name})"],
    # Per-subgraph block drift alarms
    [for name in local.goldsky_subgraphs : "ALARM(${aws_cloudwatch_metric_alarm.subgraph_blocks_behind[name].alarm_name})"],
    # Per-subgraph indexing errors alarms
    [for name in local.goldsky_subgraphs : "ALARM(${aws_cloudwatch_metric_alarm.subgraph_indexing_errors[name].alarm_name})"],
    # Per-subgraph slow response alarms
    [for name in local.goldsky_subgraphs : "ALARM(${aws_cloudwatch_metric_alarm.subgraph_response_time[name].alarm_name})"]
  ))

  alarm_actions = local.composite_alarm_actions
  ok_actions    = local.composite_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Subgraph Unhealthy Composite"
    Severity = "Critical"
  })

  depends_on = [
    aws_cloudwatch_metric_alarm.subgraph_unavailable,
    aws_cloudwatch_metric_alarm.subgraph_data_stale,
    aws_cloudwatch_metric_alarm.subgraph_blocks_behind,
    aws_cloudwatch_metric_alarm.subgraph_indexing_errors,
    aws_cloudwatch_metric_alarm.subgraph_response_time,
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
# ALARM if the keeper is failing or silent, or the relay is behind the Bitcoin tip.
# AWS's email carries this description and the triggering child's ARN, never the
# child's own description, so this text has to say what each child means.
resource "aws_cloudwatch_composite_alarm" "oracle_unhealthy" {
  count             = (var.monitoring.create && var.monitoring.create_alarms && var.oracle_lambda.create) ? 1 : 0
  provider          = aws.use1
  alarm_name        = "hpo-oracle-${local.env_short}"
  alarm_description = "Hashprice oracle needs attention. The alarm under 'Triggering children' says what: behind-bitcoin = the relay trails the Bitcoin tip, so the keeper is not submitting blocks that exist (prices go stale and the venues reject them after ${var.alarm_thresholds.oracle_max_age_minutes} min). lambda-failing or lambda-log-errors = the keeper Lambda futures-oracle-update-v2 is failing. lambda-silent = it has not finished a run for 15 min. duration-high or throttled = it is slow or throttled. Check the /aws/lambda/futures-oracle-update-v2 logs and the 00-HashpriceOracle-${local.env_short} dashboard. Bitcoin taking long between blocks does not trigger this page (see hpo-oracle-warning-${local.env_short})."

  alarm_rule = join(" OR ", compact([
    "ALARM(${aws_cloudwatch_metric_alarm.oracle_lambda_errors[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.oracle_lambda_log_errors[0].alarm_name})",
    "ALARM(${aws_cloudwatch_metric_alarm.oracle_lambda_silent[0].alarm_name})",
    var.monitoring.create_oracle_staleness_check ? "ALARM(${aws_cloudwatch_metric_alarm.oracle_behind_bitcoin[0].alarm_name})" : "",
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
    aws_cloudwatch_metric_alarm.oracle_lambda_log_errors,
    aws_cloudwatch_metric_alarm.oracle_lambda_silent,
    aws_cloudwatch_metric_alarm.oracle_behind_bitcoin,
    aws_cloudwatch_metric_alarm.oracle_duration_high,
    aws_cloudwatch_metric_alarm.oracle_throttled,
  ]
}

# Oracle price too old for the venues (warning half of the oracle's warn/crit split).
# Slack only: a long gap between Bitcoin blocks causes it and nobody can fix that.
resource "aws_cloudwatch_composite_alarm" "oracle_price_too_old" {
  count             = (var.monitoring.create && var.monitoring.create_alarms && var.monitoring.create_oracle_staleness_check) ? 1 : 0
  provider          = aws.use1
  alarm_name        = "hpo-oracle-warning-${local.env_short}"
  alarm_description = "The hashprice oracle price is over ${var.alarm_thresholds.oracle_max_age_minutes} minutes old, so both venues and the margin engine reject it (OracleStale) and trading and liquidations stop until its next update. If hpo-oracle-${local.env_short} and col-mar-spv-behind-bitcoin-${local.env_short} are OK, Bitcoin is just between blocks (a gap this long comes about once every three years) and this clears with the next block: nothing to fix. If either is in ALARM, follow that page."

  alarm_rule = "ALARM(${aws_cloudwatch_metric_alarm.oracle_stale[0].alarm_name})"

  alarm_actions = local.warning_composite_alarm_actions
  ok_actions    = local.warning_composite_alarm_actions

  tags = merge(var.default_tags, var.foundation_tags, {
    Name     = "HPO Oracle Price Too Old Composite"
    Severity = "Warning"
  })

  depends_on = [aws_cloudwatch_metric_alarm.oracle_stale]
}

