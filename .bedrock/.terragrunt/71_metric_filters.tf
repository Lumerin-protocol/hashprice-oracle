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
# ORACLE LAMBDA METRIC FILTERS (3)
# JSON/Pino format
################################################################################

# 9. Oracle Lambda Errors - Pattern: "level":50 (ERROR level in pino)
resource "aws_cloudwatch_log_metric_filter" "oracle_lambda_errors" {
  count          = (var.monitoring.create && var.monitoring.create_metric_filters && var.oracle_lambda.create) ? 1 : 0
  provider       = aws.use1
  name           = "hpo-oracle-lambda-errors"
  pattern        = "{ $.level = 50 }"
  log_group_name = local.oracle_lambda_log_group

  metric_transformation {
    name      = "oracle_lambda_errors"
    namespace = local.monitoring_namespace
    value     = "1"
    unit      = "Count"
  }
}

# 10. Oracle Job Completions (Positive Indicator) - Pattern: "Job completed"
resource "aws_cloudwatch_log_metric_filter" "oracle_job_completions" {
  count          = (var.monitoring.create && var.monitoring.create_metric_filters && var.oracle_lambda.create) ? 1 : 0
  provider       = aws.use1
  name           = "hpo-oracle-job-completions"
  pattern        = "\"Job completed\""
  log_group_name = local.oracle_lambda_log_group

  metric_transformation {
    name      = "oracle_job_completions"
    namespace = local.monitoring_namespace
    value     = "1"
    unit      = "Count"
  }
}

# 11. Oracle TX Success (Positive Indicator) - Pattern: "Transaction hash:"
resource "aws_cloudwatch_log_metric_filter" "oracle_tx_success" {
  count          = (var.monitoring.create && var.monitoring.create_metric_filters && var.oracle_lambda.create) ? 1 : 0
  provider       = aws.use1
  name           = "hpo-oracle-tx-success"
  pattern        = "\"Transaction hash:\""
  log_group_name = local.oracle_lambda_log_group

  metric_transformation {
    name      = "oracle_tx_success"
    namespace = local.monitoring_namespace
    value     = "1"
    unit      = "Count"
  }
}
