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
        markdown = "# Hashprice Oracle - ${upper(local.env_short)}\n## Key Indicators\n* **Oracle relay** (ECS): Bitcoin header submissions\n* **On-chain index**: lastSubmittedAt age\n* **Oracle subgraph**: Goldsky hpow-oracles\n\n## Thresholds\n* Pages when the relay trails the Bitcoin tip by ${var.alarm_thresholds.oracle_blocks_behind_threshold}+ blocks for ${var.monitoring_schedule.unhealthy_alarm_period_minutes} min\n* Slack warning past ${var.alarm_thresholds.oracle_warn_age_minutes} min without an update (usually a slow Bitcoin block)\n* Pages past ${var.alarm_thresholds.oracle_page_age_minutes} min and at ${var.alarm_thresholds.oracle_max_age_minutes} min, when the venues reject the price"
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
          ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", local.oracle_relay.svc_name, { "label" : "Oracle Relay", "color" : "#2ca02c" }],
        ]
      }
    },
    # Oracle relay status
    {
      type   = "metric"
      x      = 16
      y      = 0
      width  = 8
      height = 4
      properties = {
        title     = "Oracle Relay - Blocks Relayed"
        view      = "singleValue"
        stacked   = false
        region    = var.default_region
        period    = var.monitoring.dashboard_period
        sparkline = true
        metrics = [
          [local.monitoring_namespace, "oracle_relay_seconds", { "label" : "Blocks relayed", "stat" : "SampleCount", "color" : "#2ca02c" }],
          [local.monitoring_namespace, "oracle_relay_errors", { "label" : "Errors", "stat" : "Sum", "color" : "#d62728" }],
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
          [local.monitoring_namespace, "oracle_data_age_minutes", "Environment", local.env_short, { "label" : "Answer Age", "color" : "#1f77b4" }],
          [local.monitoring_namespace, "oracle_index_age_minutes", "Environment", local.env_short, { "label" : "Header Index Age", "color" : "#ff7f0e" }],
        ]
        annotations = {
          horizontal = [
            { color = "#ff7f0e", value = var.alarm_thresholds.oracle_warn_age_minutes, label = "Warning" },
            { color = "#d62728", value = var.alarm_thresholds.oracle_page_age_minutes, label = "Page" },
            { color = "#d62728", value = var.alarm_thresholds.oracle_max_age_minutes, label = "Venues reject the price", fill = "above" }
          ]
        }
      }
    },
    # Oracle relay latency and activity
    {
      type   = "metric"
      x      = 8
      y      = 9
      width  = 8
      height = 5
      properties = {
        title   = "Oracle Relay - Latency"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { label = "Seconds" } }
        metrics = [
          [local.monitoring_namespace, "oracle_relay_seconds", { "label" : "Seen to Base inclusion (max)", "stat" : "Maximum", "color" : "#1f77b4" }],
          [local.monitoring_namespace, "oracle_relay_header_latency_seconds", { "label" : "Header time to Base inclusion (avg)", "stat" : "Average", "color" : "#7f7f7f" }],
        ]
        annotations = {
          horizontal = [
            { color = "#d62728", value = local.oracle_relay_max_seconds, label = "Slow" }
          ]
        }
      }
    },
    {
      type   = "metric"
      x      = 16
      y      = 9
      width  = 8
      height = 5
      properties = {
        title   = "Oracle Relay - Ticks, Errors, Fee Bumps"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Sum"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0 } }
        metrics = [
          [local.monitoring_namespace, "oracle_relay_ticks", { "label" : "Ticks", "color" : "#2ca02c" }],
          [local.monitoring_namespace, "oracle_relay_errors", { "label" : "Errors", "color" : "#d62728" }],
          [local.monitoring_namespace, "oracle_relay_fee_bumps", { "label" : "Fee bumps", "color" : "#ff7f0e" }],
        ]
      }
    },

    # Row 4: Subgraph Monitoring (Goldsky)
    # Subgraph Status - Availability
    {
      type   = "metric"
      x      = 0
      y      = 14
      width  = 8
      height = 5
      properties = {
        title     = "Oracle Subgraph - Status"
        view      = "singleValue"
        stacked   = false
        region    = var.default_region
        stat      = "Average"
        period    = var.monitoring.dashboard_period
        sparkline = true
        metrics = [
          [local.monitoring_namespace, "subgraphs_available", "Environment", local.env_short, { "label" : "Available", "color" : "#2ca02c" }],
          [local.monitoring_namespace, "subgraphs_with_errors", "Environment", local.env_short, { "label" : "With Errors", "color" : "#d62728" }],
        ]
      }
    },
    # Subgraph Response Time
    {
      type   = "metric"
      x      = 8
      y      = 14
      width  = 8
      height = 5
      properties = {
        title   = "Oracle Subgraph - Response Time"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Average"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0, label = "ms" } }
        metrics = [
          [local.monitoring_namespace, "subgraph_response_time_ms", "Environment", local.env_short, "Subgraph", "oracles", { "label" : "Oracles", "color" : "#ff7f0e" }],
        ]
        annotations = {
          horizontal = [
            { color = "#d62728", value = 5000, label = "Slow (5s)" }
          ]
        }
      }
    },
    # Subgraph Data Age
    {
      type   = "metric"
      x      = 16
      y      = 14
      width  = 8
      height = 5
      properties = {
        title   = "Oracle Subgraph - Data Age"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Maximum"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0, label = "Seconds" } }
        metrics = [
          [local.monitoring_namespace, "subgraph_data_age_seconds", "Environment", local.env_short, "Subgraph", "oracles", { "label" : "Oracles", "color" : "#ff7f0e" }],
        ]
        annotations = {
          horizontal = [
            { color = "#d62728", value = var.alarm_thresholds.oracle_stale_threshold_minutes * 60, label = "Stale Threshold" }
          ]
        }
      }
    },

    {
      type   = "metric"
      x      = 0
      y      = 19
      width  = 24
      height = 5
      properties = {
        title   = "Oracle - Header Index Height"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Maximum"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0, label = "Bitcoin height" }, right = { min = 0, label = "Blocks behind" } }
        metrics = [
          [local.monitoring_namespace, "oracle_chain_height", "Environment", local.env_short, { "label" : "Chain Height", "color" : "#1f77b4" }],
          [local.monitoring_namespace, "oracle_blocks_behind", "Environment", local.env_short, { "label" : "Blocks behind the Bitcoin tip", "color" : "#d62728", "yAxis" : "right" }],
        ]
      }
    },

    # Row 6: Oracle relay - unmined tx age
    {
      type   = "metric"
      x      = 0
      y      = 24
      width  = 24
      height = 5
      properties = {
        title   = "Oracle Relay - Unmined Tx Age"
        view    = "timeSeries"
        stacked = false
        region  = var.default_region
        stat    = "Maximum"
        period  = var.monitoring.dashboard_period
        yAxis   = { left = { min = 0, label = "Seconds" } }
        metrics = [
          [local.monitoring_namespace, "oracle_relay_unmined_seconds", { "label" : "Oldest unmined", "color" : "#d62728" }],
        ]
        annotations = {
          horizontal = [
            { color = "#d62728", value = local.oracle_relay_max_unmined_seconds, label = "Pages" }
          ]
        }
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
