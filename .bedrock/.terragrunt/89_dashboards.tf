################################################################################
# CLOUDWATCH DASHBOARD
# Hashprice Oracle monitoring dashboard
################################################################################

locals {
  # Build dashboard widgets dynamically based on what's enabled
  dashboard_widgets = concat(
    # Row 1: Overview - always present
    [
      # Title/KPIs
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 8
        height = 4
        properties = {
          markdown = "# Hashprice Oracle - ${upper(local.env_short)}\n## Key Indicators\n* **Graph Indexer**: Subgraph indexing service\n* **Spot Indexer**: Contract indexing API\n* **Oracle Lambda**: On-chain price updates\n\n## Thresholds\n* CPU/Memory: ${var.alarm_thresholds.ecs_cpu_threshold}%/${var.alarm_thresholds.ecs_memory_threshold}%\n* Oracle Max Age: ${var.alarm_thresholds.oracle_max_age_minutes} min"
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
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-graph-indexer-${local.env_short}", { "label" : "Graph Indexer", "color" : "#2ca02c" }],
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
      # Graph Indexer CPU/Memory
      {
        type   = "metric"
        x      = 0
        y      = 4
        width  = 12
        height = 5
        properties = {
          title   = "Graph Indexer - CPU & Memory"
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
            ["ECS/ContainerInsights", "CpuUtilized", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-graph-indexer-${local.env_short}", { "id" : "m1", "visible" : false }],
            ["ECS/ContainerInsights", "CpuReserved", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-graph-indexer-${local.env_short}", { "id" : "m2", "visible" : false }],
            [{ "expression" : "(m3/m4)*100", "label" : "Memory %", "id" : "mem", "color" : "#98df8a" }],
            ["ECS/ContainerInsights", "MemoryUtilized", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-graph-indexer-${local.env_short}", { "id" : "m3", "visible" : false }],
            ["ECS/ContainerInsights", "MemoryReserved", "ClusterName", "ecs-hashprice-oracle-${local.env_short}", "ServiceName", "svc-graph-indexer-${local.env_short}", { "id" : "m4", "visible" : false }],
          ]
          annotations = {
            horizontal = [
              { color = "#d62728", value = var.alarm_thresholds.ecs_cpu_threshold, label = "Threshold" }
            ]
          }
        }
      },
      # Spot Indexer CPU/Memory
      {
        type   = "metric"
        x      = 12
        y      = 4
        width  = 12
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
      # Graph Indexer Log Metrics
      {
        type   = "metric"
        x      = 0
        y      = 9
        width  = 8
        height = 5
        properties = {
          title   = "Graph Indexer - Log Metrics"
          view    = "timeSeries"
          stacked = true
          region  = var.default_region
          stat    = "Sum"
          period  = var.monitoring.dashboard_period
          yAxis   = { left = { min = 0 } }
          metrics = [
            [local.monitoring_namespace, "graph_indexer_errors", { "label" : "Errors", "color" : "#d62728" }],
            [local.monitoring_namespace, "graph_indexer_critical", { "label" : "Critical", "color" : "#ff0000" }],
            [local.monitoring_namespace, "graph_blocks_committed", { "label" : "Blocks Committed", "color" : "#2ca02c", "yAxis" : "right" }],
          ]
        }
      },
      # Spot Indexer Log Metrics
      {
        type   = "metric"
        x      = 8
        y      = 9
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
      # ALB Graph Indexer
      {
        type   = "metric"
        x      = 0
        y      = 14
        width  = 8
        height = 5
        properties = {
          title   = "ALB - Graph Indexer"
          view    = "timeSeries"
          stacked = false
          region  = var.default_region
          stat    = "Sum"
          period  = var.monitoring.dashboard_period
          yAxis   = { left = { min = 0 } }
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", data.aws_lb.graph_indexer[0].arn_suffix, { "label" : "Requests", "color" : "#1f77b4" }],
            ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", data.aws_lb.graph_indexer[0].arn_suffix, { "label" : "5xx Errors", "color" : "#d62728" }],
          ]
        }
      },
      # ALB Spot Indexer
      {
        type   = "metric"
        x      = 8
        y      = 14
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
      # RDS PostgreSQL
      {
        type   = "metric"
        x      = 16
        y      = 14
        width  = 8
        height = 5
        properties = {
          title   = "RDS - PostgreSQL"
          view    = "timeSeries"
          stacked = false
          region  = var.default_region
          stat    = "Average"
          period  = var.monitoring.dashboard_period
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", "graph-indexer-${local.env_short}-${var.region_shortname}-v2", { "label" : "CPU %", "color" : "#9467bd" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", "graph-indexer-${local.env_short}-${var.region_shortname}-v2", { "label" : "Connections", "color" : "#1f77b4", "yAxis" : "right" }],
          ]
          yAxis = {
            left  = { min = 0, max = 100, label = "CPU %" }
            right = { min = 0, label = "Connections" }
          }
          annotations = {
            horizontal = [
              { color = "#d62728", value = var.alarm_thresholds.rds_cpu_threshold, label = "CPU Threshold" }
            ]
          }
        }
      },
      # Oracle Data Age
      {
        type   = "metric"
        x      = 0
        y      = 19
        width  = 12
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
              { color = "#d62728", value = var.alarm_thresholds.oracle_max_age_minutes, label = "Stale Threshold", fill = "above" }
            ]
          }
        }
      },
      # Oracle Lambda Duration
      {
        type   = "metric"
        x      = 12
        y      = 19
        width  = 12
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
      # RDS Storage
      {
        type   = "metric"
        x      = 0
        y      = 24
        width  = 12
        height = 5
        properties = {
          title   = "RDS - Storage"
          view    = "timeSeries"
          stacked = false
          region  = var.default_region
          stat    = "Minimum"
          period  = var.monitoring.dashboard_period
          yAxis   = { left = { min = 0, label = "GB" } }
          metrics = [
            [{ "expression" : "m1/1073741824", "label" : "Free Storage (GB)", "id" : "e1", "color" : "#2ca02c" }],
            ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", "graph-indexer-${local.env_short}-${var.region_shortname}-v2", { "id" : "m1", "visible" : false }],
          ]
          annotations = {
            horizontal = [
              { color = "#ff7f0e", value = var.alarm_thresholds.rds_storage_threshold * 2, label = "Warning" },
              { color = "#d62728", value = var.alarm_thresholds.rds_storage_threshold, label = "Critical", fill = "below" }
            ]
          }
        }
      },
      # Subgraph Health (from health monitor Lambda)
      {
        type   = "metric"
        x      = 12
        y      = 24
        width  = 6
        height = 5
        properties = {
          title   = "Subgraph Health Status"
          view    = "timeSeries"
          stacked = false
          region  = var.default_region
          stat    = "Minimum"
          period  = var.monitoring.dashboard_period
          metrics = [
            [local.monitoring_namespace, "subgraphs_healthy", "Environment", local.env_short, { "label" : "Healthy", "color" : "#2ca02c" }],
            [local.monitoring_namespace, "subgraphs_synced", "Environment", local.env_short, { "label" : "Synced", "color" : "#1f77b4" }],
            [local.monitoring_namespace, "subgraphs_total", "Environment", local.env_short, { "label" : "Total", "color" : "#7f7f7f" }],
          ]
          yAxis = {
            left = { min = 0, label = "Count" }
          }
          annotations = {
            horizontal = [
              { value = 2, label = "Expected", color = "#2ca02c", fill = "none" }
            ]
          }
        }
      },
      # Subgraph Entity Count by Subgraph (growth indicator)
      {
        type   = "metric"
        x      = 18
        y      = 24
        width  = 6
        height = 5
        properties = {
          title   = "Subgraph Entity Count (by Subgraph)"
          view    = "timeSeries"
          stacked = false
          region  = var.default_region
          stat    = "Average"
          period  = var.monitoring.dashboard_period
          metrics = [
            # Use SEARCH to find all subgraphs by SubgraphId dimension
            [{ "expression" : "SEARCH('{${local.monitoring_namespace},Environment,SubgraphId,Network} MetricName=\"subgraph_entity_count\" Environment=\"${local.env_short}\"', 'Average', ${var.monitoring.dashboard_period})", "label" : "$${PROP('Dim.SubgraphId')}", "id" : "e1" }],
          ]
          yAxis = {
            left = { min = 0, label = "Entities" }
          }
        }
      },
    ]
  )
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
