################################################################################
# METRIC FILTERS - CloudWatch Log Metric Filters
# 6 Critical Metric Filters for key indicators
################################################################################

################################################################################
# SPOT INDEXER METRIC FILTERS (3)
# JSON/Pino format: {"level":30,...} where 30=INFO, 40=WARN, 50=ERROR
################################################################################

# 6. Spot Indexer Errors - Pattern: "level":50 (ERROR level in pino)
resource "aws_cloudwatch_log_metric_filter" "spot_indexer_errors" {
  count          = (var.monitoring.create && var.monitoring.create_metric_filters && var.spot_indexer.create) ? 1 : 0
  provider       = aws.use1
  name           = "hpo-spot-indexer-errors"
  pattern        = "{ $.level = 50 }"
  log_group_name = local.spot_indexer_log_group

  metric_transformation {
    name      = "spot_indexer_errors"
    namespace = local.monitoring_namespace
    value     = "1"
    unit      = "Count"
  }
}

# 7. Spot Contract Updates (Positive Indicator) - Pattern: "updated in cache"
resource "aws_cloudwatch_log_metric_filter" "spot_contract_updates" {
  count          = (var.monitoring.create && var.monitoring.create_metric_filters && var.spot_indexer.create) ? 1 : 0
  provider       = aws.use1
  name           = "hpo-spot-contract-updates"
  pattern        = "\"updated in cache\""
  log_group_name = local.spot_indexer_log_group

  metric_transformation {
    name      = "spot_contract_updates"
    namespace = local.monitoring_namespace
    value     = "1"
    unit      = "Count"
  }
}

# 8. Spot Server Starts (Track Restarts) - Pattern: "Server listening"
resource "aws_cloudwatch_log_metric_filter" "spot_server_starts" {
  count          = (var.monitoring.create && var.monitoring.create_metric_filters && var.spot_indexer.create) ? 1 : 0
  provider       = aws.use1
  name           = "hpo-spot-server-starts"
  pattern        = "\"Server listening\""
  log_group_name = local.spot_indexer_log_group

  metric_transformation {
    name      = "spot_server_starts"
    namespace = local.monitoring_namespace
    value     = "1"
    unit      = "Count"
  }
}

################################################################################
# ORACLE RELAY SERVICE METRIC FILTERS (N64)
# keeper/src/adapters/node.ts and core/{keeper,txSend}.ts log an `event` field.
################################################################################

locals {
  oracle_relay_metric_filters = {
    # Any pino error: failed ticks ("tick_error") and errors inside one.
    oracle_relay_errors = { pattern = "{ $.level >= 50 }", value = "1", unit = "Count" }
    # Heartbeat: every tick, including those with nothing to submit (startup, each
    # Bitcoin block, the 60 s fallback poll).
    oracle_relay_ticks = { pattern = "{ $.event = \"tick\" }", value = "1", unit = "Count" }
    # First sight of a Bitcoin block by the relay to its inclusion on Base.
    oracle_relay_seconds = { pattern = "{ $.event = \"relayed\" }", value = "$.relaySec", unit = "Seconds" }
    # Bitcoin header time to Base inclusion. Header times are miner-set (minutes off
    # either way), so this one is for the dashboard, not an alarm.
    oracle_relay_header_latency_seconds = { pattern = "{ $.event = \"relayed\" }", value = "$.latencySec", unit = "Seconds" }
    # Logged every minute while a relay tx stays unmined.
    oracle_relay_unmined_seconds = { pattern = "{ $.event = \"tx_unmined\" }", value = "$.unminedSec", unit = "Seconds" }
    oracle_relay_fee_bumps       = { pattern = "{ $.event = \"fee_bump\" }", value = "1", unit = "Count" }
  }
}

resource "aws_cloudwatch_log_metric_filter" "oracle_relay" {
  for_each       = (var.monitoring.create && var.monitoring.create_metric_filters && local.create_oracle_relay) ? local.oracle_relay_metric_filters : {}
  provider       = aws.use1
  name           = "hpo-${replace(each.key, "_", "-")}"
  pattern        = each.value.pattern
  log_group_name = aws_cloudwatch_log_group.oracle_relay_use1[0].name

  metric_transformation {
    name      = each.key
    namespace = local.monitoring_namespace
    value     = each.value.value
    unit      = each.value.unit
  }
}
