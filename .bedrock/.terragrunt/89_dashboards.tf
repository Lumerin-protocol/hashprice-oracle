################################################################################
# CLOUDWATCH DASHBOARD
# Hashprice Oracle monitoring dashboard
################################################################################

locals {
  # Build dashboard widgets dynamically based on what's enabled
  dashboard_widgets = [
    # Row 1: Overview - always present
    # Title/KPIs
    {
      type   = "text"
      x      = 0
      y      = 0
      width  = 8
      height = 4
      properties = {
        markdown = "# Hashprice Oracle - ${upper(local.env_short)}\n## Key Indicators\n* **Spot Indexer**: Contract indexing API\n* **Oracle Lambda**: On-chain price updates\n* **TheGraph**: External subgraph data\n\n## Thresholds\n* CPU/Memory: ${var.alarm_thresholds.ecs_cpu_threshold}%/${var.alarm_thresholds.ecs_memory_threshold}%\n* Oracle Max Age: ${var.alarm_thresholds.oracle_stale_threshold_minutes} min"
      }
    },
    # Service Status - Task Counts
    {
      type   = "metric"
      x      = 8
      y      = 0
      width  = 8
      height = 4
      properties = {
        title     = "Service Status - Running Tasks"
        view      = "singleValue"
        stacked   = false
        region    = var.default_region
        stat      = "Average"
        period    = var.monitoring.dashboard_period
        sparkline = true
        metrics = [
          ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-spot-indexer-${local.env_short}", { "label" : "Spot Indexer", "color" : "#1f77b4" }],
        ]
      }
    },
    # Lambda Status
    {
      type   = "metric"
      x      = 16
      y      = 0
      width  = 8
      height = 4
      properties = {
        title     = "Oracle Lambda - Executions"
        view      = "singleValue"
        stacked   = false
        region    = var.default_region
        stat      = "Sum"
        period    = var.monitoring.dashboard_period
        sparkline = true
        metrics = [
          ["AWS/Lambda", "Invocations", "FunctionName", "futures-oracle-update-v2", { "label" : "Invocations", "color" : "#2ca02c" }],
          ["AWS/Lambda", "Errors", "FunctionName", "futures-oracle-update-v2", { "label" : "Errors", "color" : "#d62728" }],
        ]
      }
    },

    # Row 2: Spot Indexer CPU/Memory
    {
      type   = "metric"
      x      = 0
      y      = 4
      width  = 8
      height = 5
      properties = {
        title   = "Spot Indexer - CPU & Memory"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Average"
        period  = var.monitoring.dashboard_period
        yAxis = {
          left = { min = 0, max = 100, label = "%" }
        }
        metrics = [
          [{ "expression" : "(m1/m2)*100", "label" : "CPU %", "id" : "cpu", "color" : "#9467bd" }],
          ["ECS/ContainerInsights", "CpuUtilized", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-spot-indexer-${local.env_short}", { "id" : "m1", "visible" : false }],
          ["ECS/ContainerInsights", "CpuReserved", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-spot-indexer-${local.env_short}", { "id" : "m2", "visible" : false }],
          [{ "expression" : "(m3/m4)*100", "label" : "Memory %", "id" : "mem", "color" : "#98df8a" }],
          ["ECS/ContainerInsights", "MemoryUtilized", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-spot-indexer-${local.env_short}", { "id" : "m3", "visible" : false }],
          ["ECS/ContainerInsights", "MemoryReserved", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-spot-indexer-${local.env_short}", { "id" : "m4", "visible" : false }],
        ]
        annotations = {
          horizontal = [
            { color = "#d62728", value = var.alarm_thresholds.ecs_cpu_threshold, label = "Threshold" }
          ]
        }
      }
    },

    # Spot Indexer Log Metrics
    {
      type   = "metric"
      x      = 8
      y      = 4
      width  = 8
      height = 5
      properties = {
        title   = "Spot Indexer - Log Metrics"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Sum"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0 } }
        metrics = [
          [local.monitoring_namespace, "spot_indexer_errors", { "label" : "Errors", "color" : "#d62728" }],
          [local.monitoring_namespace, "spot_contract_updates", { "label" : "Contract Updates", "color" : "#2ca02c" }],
          [local.monitoring_namespace, "spot_server_starts", { "label" : "Server Restarts", "color" : "#ff7f0e" }],
        ]
      }
    },
    # ALB Spot Indexer
    {
      type   = "metric"
      x      = 16
      y      = 4
      width  = 8
      height = 5
      properties = {
        title   = "ALB - Spot Indexer"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Sum"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0 } }
        metrics = [
          ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", data.aws_lb.spot_indexer[0].arn_suffix, { "label" : "Requests", "color" : "#1f77b4" }],
          ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", data.aws_lb.spot_indexer[0].arn_suffix, { "label" : "5xx Errors", "color" : "#d62728" }],
        ]
      }
    },

    # Row 3: Oracle Data Age
    {
      type   = "metric"
      x      = 0
      y      = 9
      width  = 8
      height = 5
      properties = {
        title   = "Oracle - Data Freshness"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Maximum"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0, label = "Minutes" } }
        metrics = [
          [local.monitoring_namespace, "oracle_data_age_minutes", "Environment", local.env_short, { "label" : "Data Age", "color" : "#1f77b4" }],
        ]
        annotations = {
          horizontal = [
            { color = "#d62728", value = var.alarm_thresholds.oracle_stale_threshold_minutes, label = "Stale Threshold", fill = "above" }
          ]
        }
      }
    },
    # Oracle Lambda Duration
    {
      type   = "metric"
      x      = 8
      y      = 9
      width  = 8
      height = 5
      properties = {
        title   = "Oracle Lambda - Duration"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Average"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0, label = "Milliseconds" } }
        metrics = [
          ["AWS/Lambda", "Duration", "FunctionName", "futures-oracle-update-v2", { "label" : "Duration", "color" : "#1f77b4" }],
        ]
        annotations = {
          horizontal = [
            { color = "#d62728", value = var.alarm_thresholds.lambda_duration_threshold, label = "Warning Threshold" },
            { color = "#ff0000", value = 60000, label = "Timeout (60s)" }
          ]
        }
      }
    },
    # Oracle Lambda Log Metrics
    {
      type   = "metric"
      x      = 16
      y      = 9
      width  = 8
      height = 5
      properties = {
        title   = "Oracle Lambda - Log Metrics"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Sum"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0 } }
        metrics = [
          [local.monitoring_namespace, "oracle_lambda_errors", { "label" : "Errors", "color" : "#d62728" }],
          [local.monitoring_namespace, "oracle_job_completions", { "label" : "Jobs Completed", "color" : "#2ca02c" }],
          [local.monitoring_namespace, "oracle_tx_success", { "label" : "TX Success", "color" : "#1f77b4" }],
        ]
      }
    },

    # Row 4: TheGraph Monitoring
    # TheGraph Status - Availability
    {
      type   = "metric"
      x      = 0
      y      = 14
      width  = 8
      height = 5
      properties = {
        title     = "TheGraph - Subgraph Status"
        view      = "singleValue"
        stacked   = false
        region    = var.default_region
        stat      = "Average"
        period    = var.monitoring.dashboard_period
        sparkline = true
        metrics = [
          [local.monitoring_namespace, "thegraph_subgraphs_available", "Environment", local.env_short, { "label" : "Available", "color" : "#2ca02c" }],
          [local.monitoring_namespace, "thegraph_subgraphs_with_errors", "Environment", local.env_short, { "label" : "With Errors", "color" : "#d62728" }],
        ]
      }
    },
    # TheGraph Response Time
    {
      type   = "metric"
      x      = 8
      y      = 14
      width  = 8
      height = 5
      properties = {
        title   = "TheGraph - Response Time"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Average"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0, label = "ms" } }
        metrics = [
          [local.monitoring_namespace, "thegraph_response_time_ms", "Environment", local.env_short, "Subgraph", "futures", { "label" : "Futures", "color" : "#1f77b4" }],
          [local.monitoring_namespace, "thegraph_response_time_ms", "Environment", local.env_short, "Subgraph", "oracles", { "label" : "Oracles", "color" : "#ff7f0e" }],
        ]
        annotations = {
          horizontal = [
            { color = "#d62728", value = 5000, label = "Slow (5s)" }
          ]
        }
      }
    },
    # TheGraph Data Age
    {
      type   = "metric"
      x      = 16
      y      = 14
      width  = 8
      height = 5
      properties = {
        title   = "TheGraph - Data Age"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Maximum"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0, label = "Seconds" } }
        metrics = [
          [local.monitoring_namespace, "thegraph_data_age_seconds", "Environment", local.env_short, "Subgraph", "futures", { "label" : "Futures", "color" : "#1f77b4" }],
          [local.monitoring_namespace, "thegraph_data_age_seconds", "Environment", local.env_short, "Subgraph", "oracles", { "label" : "Oracles", "color" : "#ff7f0e" }],
        ]
        annotations = {
          horizontal = [
            { color = "#d62728", value = var.alarm_thresholds.oracle_stale_threshold_minutes * 60, label = "Stale Threshold" }
          ]
        }
      }
    },

    # Row 5: Entity Counts (Futures subgraph business data)
    # Futures Entity Counts - track business activity
    {
      type   = "metric"
      x      = 0
      y      = 19
      width  = 24
      height = 5
      properties = {
        title   = "TheGraph - Futures Entity Counts"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Average"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0, label = "Count" } }
        metrics = [
          [local.monitoring_namespace, "thegraph_entity_count", "Environment", local.env_short, "Subgraph", "futures", "Entity", "futures", { "label" : "Futures Contracts", "color" : "#1f77b4" }],
          [local.monitoring_namespace, "thegraph_entity_count", "Environment", local.env_short, "Subgraph", "futures", "Entity", "participants", { "label" : "Participants", "color" : "#ff7f0e" }],
          [local.monitoring_namespace, "thegraph_entity_count", "Environment", local.env_short, "Subgraph", "futures", "Entity", "positions", { "label" : "Positions", "color" : "#2ca02c" }],
        ]
      }
    },
  ]
}

resource "aws_cloudwatch_dashboard" "hashprice_oracle" {
  count          = (var.monitoring.create && var.monitoring.create_dashboards) ? 1 : 0
  provider       = aws.use1
  dashboard_name = "00-HashpriceOracle-${local.env_short}"

  dashboard_body = jsonencode({
    start          = "-PT12H"
    periodOverride = "inherit"
    widgets        = local.dashboard_widgets
  })
}
