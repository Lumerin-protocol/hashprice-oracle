################################################################################
# HPDX HEALTH DASHBOARD
# One dashboard per account. Metrics are published by other stacks in this account.
################################################################################

locals {
  hpdx_on = var.monitoring.create && var.monitoring.create_dashboards

  hpdx_futures_ns = "FuturesMarketplace/${local.env_short}"
  hpdx_perps_ns   = "DerivativesMarketplace/${local.env_short}"
  hpdx_site_ns    = "HashpowerIo/${local.env_short}"
  hpdx_mcp_ns     = "HashpowerMcp/${local.env_short}"

  hpdx_mm_cluster     = "ecs-derivatives-marketplace-${local.env_short}"
  hpdx_mm_service     = "svc-col-mar-futures-mm-${local.env_short}"
  hpdx_keeper_service = "svc-col-mar-keeper-${local.env_short}"
  hpdx_mcp_cluster    = "ecs-hashpower-mcp-${local.env_short}"
  hpdx_mcp_service    = "svc-hashpower-mcp-${local.env_short}"

  hpdx_futures_lb = try(data.aws_lb.hpdx_futures_mm[0].arn_suffix, "")
  hpdx_keeper_lb  = try(data.aws_lb.hpdx_keeper[0].arn_suffix, "")
  hpdx_mcp_lb     = try(data.aws_lb.hpdx_mcp[0].arn_suffix, "")
  hpdx_futures_tg = try(data.aws_lb_target_group.hpdx_futures_mm[0].arn_suffix, "")
  hpdx_keeper_tg  = try(data.aws_lb_target_group.hpdx_keeper[0].arn_suffix, "")
  hpdx_mcp_tg     = try(data.aws_lb_target_group.hpdx_mcp[0].arn_suffix, "")
}

data "aws_lb" "hpdx_futures_mm" {
  count = local.hpdx_on ? 1 : 0
  name  = "alb-col-mar-futures-mm-${local.env_short}"
}

data "aws_lb" "hpdx_keeper" {
  count = local.hpdx_on ? 1 : 0
  name  = "alb-col-mar-keeper-${local.env_short}"
}

data "aws_lb" "hpdx_mcp" {
  count = local.hpdx_on ? 1 : 0
  name  = "alb-hashpower-mcp-ext-${local.env_short}"
}

data "aws_lb_target_group" "hpdx_futures_mm" {
  count = local.hpdx_on ? 1 : 0
  name  = "tg-col-mar-futures-mm-${local.env_short}"
}

data "aws_lb_target_group" "hpdx_keeper" {
  count = local.hpdx_on ? 1 : 0
  name  = "tg-col-mar-keeper-${local.env_short}"
}

data "aws_lb_target_group" "hpdx_mcp" {
  count = local.hpdx_on ? 1 : 0
  name  = "tg-hashpower-mcp-${local.env_short}"
}

resource "aws_cloudwatch_dashboard" "hpdx" {
  count          = local.hpdx_on ? 1 : 0
  provider       = aws.use1
  dashboard_name = "hpdx-${local.env_short}"

  dashboard_body = jsonencode({
    start          = "-PT12H"
    periodOverride = "inherit"
    widgets = [
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 3
        properties = {
          markdown = "# HPDX ${upper(local.env_short)}\nGas wallets, oracle, futures and perps indexers, futures market maker, vault, hashpower.io, the exchange, and the MCP. Seller, validator, spot, and the retired Arbitrum query metrics are not on this board."
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 3
        width  = 24
        height = 4
        properties = {
          title     = "Pulse"
          view      = "singleValue"
          region    = var.default_region
          period    = 900
          sparkline = true
          metrics = [
            ["wallet-monitor", "eth_balance", "WalletName", "MarketMaker", { label = "Maker ETH", stat = "Average", color = "#1f77b4" }],
            ["wallet-monitor", "eth_balance", "WalletName", "OracleUpdater", { label = "Updater ETH", stat = "Average", color = "#17becf" }],
            [local.monitoring_namespace, "oracle_job_completions", { label = "Oracle runs", stat = "Sum", color = "#2ca02c" }],
            ["ColMarFuturesMM", "TickCount", { label = "MM ticks", stat = "Sum", color = "#98df8a" }],
            [local.hpdx_futures_ns, "subgraph_entity_present", "Subgraph", "futures", "Environment", local.env_short, { label = "Futures book", stat = "Minimum" }],
            [local.hpdx_perps_ns, "subgraph_entity_present", "Subgraph", "perps", "Environment", local.env_short, { label = "Perps book", stat = "Minimum" }],
            [local.hpdx_site_ns, "site_up", "Environment", local.env_short, { label = "hashpower.io", stat = "Minimum" }],
            [local.hpdx_mcp_ns, "health_up", "Environment", local.env_short, { label = "MCP", stat = "Minimum" }],
            ["ColMarVault", "Halted", { label = "Vault halted", stat = "Maximum", color = "#d62728" }],
            ["ColMarVault", "UncoveredLoss", { label = "Uncovered loss", stat = "Maximum", color = "#ff7f0e" }],
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_mm_service, { label = "MM tasks", stat = "Minimum" }],
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_keeper_service, { label = "Keeper tasks", stat = "Minimum" }],
            ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", local.hpdx_mcp_cluster, "ServiceName", local.hpdx_mcp_service, { label = "MCP tasks", stat = "Minimum" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 7
        width  = 12
        height = 6
        properties = {
          title  = "Gas wallets (ETH)"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          stat   = "Average"
          yAxis  = { left = { min = 0, label = "ETH" } }
          metrics = [
            ["wallet-monitor", "eth_balance", "WalletName", "MarketMaker", { label = "Market maker", color = "#1f77b4" }],
            ["wallet-monitor", "eth_balance", "WalletName", "OracleUpdater", { label = "Oracle updater", color = "#17becf" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 7
        width  = 12
        height = 6
        properties = {
          title  = "Oracle answer and age"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "Answer" }, right = { min = 0, label = "Age (s)" } }
          metrics = [
            [local.monitoring_namespace, "oracle_latest_answer", "Environment", local.env_short, { label = "Latest answer", stat = "Average", color = "#1f77b4", yAxis = "left" }],
            [local.monitoring_namespace, "oracle_data_age_seconds", "Environment", local.env_short, { label = "Data age", stat = "Maximum", color = "#ff7f0e", yAxis = "right" }],
            [local.monitoring_namespace, "subgraph_data_age_seconds", "Subgraph", "oracles", "Environment", local.env_short, { label = "Oracle index age", stat = "Maximum", color = "#9467bd", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 13
        width  = 12
        height = 6
        properties = {
          title  = "Oracle runs and errors"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          stat   = "Sum"
          yAxis  = { left = { min = 0, label = "Count" } }
          metrics = [
            [local.monitoring_namespace, "oracle_job_completions", { label = "Completions", color = "#2ca02c" }],
            [local.monitoring_namespace, "oracle_lambda_errors", { label = "Log errors", color = "#d62728" }],
            ["AWS/Lambda", "Errors", "FunctionName", "futures-oracle-update-v2", { label = "Lambda errors", color = "#ff7f0e" }],
            ["AWS/Lambda", "Throttles", "FunctionName", "futures-oracle-update-v2", { label = "Throttles", color = "#9467bd" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 13
        width  = 12
        height = 6
        properties = {
          title  = "Oracle lambda duration"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          stat   = "Average"
          yAxis  = { left = { min = 0, label = "ms" } }
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", "futures-oracle-update-v2", { label = "Duration", color = "#1f77b4" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 19
        width  = 12
        height = 6
        properties = {
          title  = "Futures indexer"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "0 or 1" } }
          metrics = [
            [local.hpdx_futures_ns, "subgraph_available", "Subgraph", "futures", "Environment", local.env_short, { label = "Available", stat = "Minimum", color = "#2ca02c" }],
            [local.hpdx_futures_ns, "subgraph_entity_present", "Subgraph", "futures", "Environment", local.env_short, { label = "Orders present", stat = "Minimum", color = "#1f77b4" }],
            [local.hpdx_futures_ns, "subgraph_indexing_errors", "Subgraph", "futures", "Environment", local.env_short, { label = "Indexing errors", stat = "Maximum", color = "#d62728" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 19
        width  = 12
        height = 6
        properties = {
          title  = "Futures indexer age"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "Seconds" }, right = { min = 0, label = "ms" } }
          metrics = [
            [local.hpdx_futures_ns, "subgraph_data_age_seconds", "Subgraph", "futures", "Environment", local.env_short, { label = "Data age", stat = "Maximum", color = "#ff7f0e", yAxis = "left" }],
            [local.hpdx_futures_ns, "subgraph_latest_activity_age_seconds", "Subgraph", "futures", "Environment", local.env_short, { label = "Activity age", stat = "Maximum", color = "#9467bd", yAxis = "left" }],
            [local.hpdx_futures_ns, "subgraph_response_time_ms", "Subgraph", "futures", "Environment", local.env_short, { label = "Response", stat = "Average", color = "#1f77b4", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 25
        width  = 12
        height = 6
        properties = {
          title  = "Perps indexer"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "0 or 1" } }
          metrics = [
            [local.hpdx_perps_ns, "subgraph_available", "Subgraph", "perps", "Environment", local.env_short, { label = "Available", stat = "Minimum", color = "#2ca02c" }],
            [local.hpdx_perps_ns, "subgraph_entity_present", "Subgraph", "perps", "Environment", local.env_short, { label = "Entities present", stat = "Minimum", color = "#1f77b4" }],
            [local.hpdx_perps_ns, "subgraph_indexing_errors", "Subgraph", "perps", "Environment", local.env_short, { label = "Indexing errors", stat = "Maximum", color = "#d62728" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 25
        width  = 12
        height = 6
        properties = {
          title  = "Perps indexer age"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "Seconds" }, right = { min = 0, label = "ms" } }
          metrics = [
            [local.hpdx_perps_ns, "subgraph_data_age_seconds", "Subgraph", "perps", "Environment", local.env_short, { label = "Data age", stat = "Maximum", color = "#ff7f0e", yAxis = "left" }],
            [local.hpdx_perps_ns, "subgraph_latest_activity_age_seconds", "Subgraph", "perps", "Environment", local.env_short, { label = "Activity age", stat = "Maximum", color = "#9467bd", yAxis = "left" }],
            [local.hpdx_perps_ns, "subgraph_response_time_ms", "Subgraph", "perps", "Environment", local.env_short, { label = "Response", stat = "Average", color = "#1f77b4", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 31
        width  = 12
        height = 6
        properties = {
          title  = "Futures market maker"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          stat   = "Sum"
          yAxis  = { left = { min = 0, label = "Count / 5 min" } }
          metrics = [
            ["ColMarFuturesMM", "TickCount", { label = "Ticks", color = "#2ca02c" }],
            ["ColMarFuturesMM", "ErrorCount", { label = "Errors", color = "#d62728" }],
            ["ColMarFuturesMM", "WarnCount", { label = "Warnings", color = "#ff7f0e" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 31
        width  = 12
        height = 6
        properties = {
          title  = "Futures market maker CPU and memory"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, max = 100, label = "%" } }
          metrics = [
            [{ expression = "(m1/m2)*100", label = "CPU %", id = "cpu", color = "#9467bd" }],
            ["ECS/ContainerInsights", "CpuUtilized", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_mm_service, { id = "m1", visible = false }],
            ["ECS/ContainerInsights", "CpuReserved", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_mm_service, { id = "m2", visible = false }],
            [{ expression = "(m3/m4)*100", label = "Memory %", id = "mem", color = "#98df8a" }],
            ["ECS/ContainerInsights", "MemoryUtilized", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_mm_service, { id = "m3", visible = false }],
            ["ECS/ContainerInsights", "MemoryReserved", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_mm_service, { id = "m4", visible = false }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 37
        width  = 12
        height = 6
        properties = {
          title  = "Futures market maker load balancer"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "Count" } }
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", local.hpdx_futures_lb, { label = "Requests", stat = "Sum", color = "#1f77b4" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", local.hpdx_futures_lb, { label = "Target 5xx", stat = "Sum", color = "#d62728" }],
            ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", local.hpdx_futures_lb, { label = "ELB 5xx", stat = "Sum", color = "#ff7f0e" }],
            ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", local.hpdx_futures_tg, "LoadBalancer", local.hpdx_futures_lb, { label = "Healthy hosts", stat = "Minimum", color = "#2ca02c" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 37
        width  = 12
        height = 6
        properties = {
          title  = "Keeper CPU and memory"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, max = 100, label = "%" } }
          metrics = [
            [{ expression = "(m1/m2)*100", label = "CPU %", id = "cpu", color = "#9467bd" }],
            ["ECS/ContainerInsights", "CpuUtilized", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_keeper_service, { id = "m1", visible = false }],
            ["ECS/ContainerInsights", "CpuReserved", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_keeper_service, { id = "m2", visible = false }],
            [{ expression = "(m3/m4)*100", label = "Memory %", id = "mem", color = "#98df8a" }],
            ["ECS/ContainerInsights", "MemoryUtilized", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_keeper_service, { id = "m3", visible = false }],
            ["ECS/ContainerInsights", "MemoryReserved", "ClusterName", local.hpdx_mm_cluster, "ServiceName", local.hpdx_keeper_service, { id = "m4", visible = false }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 43
        width  = 12
        height = 6
        properties = {
          title  = "Vault balances (USDC)"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          stat   = "Average"
          yAxis  = { left = { min = 0, label = "USDC" } }
          metrics = [
            ["ColMarVault", "InsuranceDebt", { label = "Debt", color = "#ff7f0e" }],
            ["ColMarVault", "TimingDebt", { label = "Timing debt", color = "#9467bd" }],
            ["ColMarVault", "InsuranceDebtCap", { label = "Cap", color = "#1f77b4" }],
            ["ColMarVault", "InsuranceCapital", { label = "Capital", color = "#2ca02c" }],
            ["ColMarVault", "UncoveredLoss", { label = "Uncovered loss", color = "#d62728" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 43
        width  = 12
        height = 6
        properties = {
          title  = "Vault state"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "0 or 1" }, right = { min = 0, label = "Utilization %" } }
          metrics = [
            ["ColMarVault", "Halted", { label = "Halted", stat = "Maximum", color = "#d62728", yAxis = "left" }],
            ["ColMarVault", "CheckSuccess", { label = "Check success", stat = "Minimum", color = "#2ca02c", yAxis = "left" }],
            ["ColMarVault", "InsuranceDebtUtilizationPct", { label = "Utilization", stat = "Maximum", color = "#ff7f0e", yAxis = "right" }],
            ["ColMarVault", "KeeperErrorCount", { label = "Keeper errors", stat = "Sum", color = "#9467bd", yAxis = "left" }],
            ["ColMarVault", "KeeperSweepCount", { label = "Keeper sweeps", stat = "Sum", color = "#1f77b4", yAxis = "left" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 49
        width  = 12
        height = 6
        properties = {
          title  = "Keeper load balancer"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "Count" } }
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", local.hpdx_keeper_lb, { label = "Requests", stat = "Sum", color = "#1f77b4" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", local.hpdx_keeper_lb, { label = "Target 5xx", stat = "Sum", color = "#d62728" }],
            ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", local.hpdx_keeper_tg, "LoadBalancer", local.hpdx_keeper_lb, { label = "Healthy hosts", stat = "Minimum", color = "#2ca02c" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 49
        width  = 12
        height = 6
        properties = {
          title  = "Site and MCP probes"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, max = 1, label = "0 or 1" } }
          metrics = [
            [local.hpdx_site_ns, "site_up", "Environment", local.env_short, { label = "Site up", stat = "Minimum", color = "#2ca02c" }],
            [local.hpdx_site_ns, "deployments_ok", "Environment", local.env_short, { label = "Deployments", stat = "Minimum", color = "#1f77b4" }],
            [local.hpdx_site_ns, "llms_ok", "Environment", local.env_short, { label = "llms.txt", stat = "Minimum", color = "#17becf" }],
            [local.hpdx_mcp_ns, "health_up", "Environment", local.env_short, { label = "MCP up", stat = "Minimum", color = "#98df8a" }],
            [local.hpdx_mcp_ns, "health_payload_ok", "Environment", local.env_short, { label = "MCP payload", stat = "Minimum", color = "#9467bd" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 55
        width  = 12
        height = 6
        properties = {
          title  = "hashpower.io CloudFront"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "Requests" }, right = { min = 0, label = "5xx %" } }
          metrics = [
            ["AWS/CloudFront", "Requests", "DistributionId", var.hpdx_dashboard.site_distribution_id, "Region", "Global", { label = "Requests", stat = "Sum", color = "#1f77b4", yAxis = "left" }],
            ["AWS/CloudFront", "5xxErrorRate", "DistributionId", var.hpdx_dashboard.site_distribution_id, "Region", "Global", { label = "5xx %", stat = "Average", color = "#d62728", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 55
        width  = 12
        height = 6
        properties = {
          title  = "Exchange CloudFront and canary"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "Requests" }, right = { min = 0, max = 100, label = "%" } }
          metrics = [
            ["AWS/CloudFront", "Requests", "DistributionId", var.hpdx_dashboard.exchange_distribution_id, "Region", "Global", { label = "Requests", stat = "Sum", color = "#1f77b4", yAxis = "left" }],
            ["AWS/CloudFront", "4xxErrorRate", "DistributionId", var.hpdx_dashboard.exchange_distribution_id, "Region", "Global", { label = "4xx %", stat = "Average", color = "#ff7f0e", yAxis = "right" }],
            ["AWS/CloudFront", "5xxErrorRate", "DistributionId", var.hpdx_dashboard.exchange_distribution_id, "Region", "Global", { label = "5xx %", stat = "Average", color = "#d62728", yAxis = "right" }],
            ["CloudWatchSynthetics", "SuccessPercent", "CanaryName", "futures-ui-${local.env_short}", { label = "Canary success", stat = "Average", color = "#2ca02c", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 61
        width  = 12
        height = 6
        properties = {
          title  = "MCP CPU and memory"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, max = 100, label = "%" } }
          metrics = [
            [{ expression = "(m1/m2)*100", label = "CPU %", id = "cpu", color = "#9467bd" }],
            ["ECS/ContainerInsights", "CpuUtilized", "ClusterName", local.hpdx_mcp_cluster, "ServiceName", local.hpdx_mcp_service, { id = "m1", visible = false }],
            ["ECS/ContainerInsights", "CpuReserved", "ClusterName", local.hpdx_mcp_cluster, "ServiceName", local.hpdx_mcp_service, { id = "m2", visible = false }],
            [{ expression = "(m3/m4)*100", label = "Memory %", id = "mem", color = "#98df8a" }],
            ["ECS/ContainerInsights", "MemoryUtilized", "ClusterName", local.hpdx_mcp_cluster, "ServiceName", local.hpdx_mcp_service, { id = "m3", visible = false }],
            ["ECS/ContainerInsights", "MemoryReserved", "ClusterName", local.hpdx_mcp_cluster, "ServiceName", local.hpdx_mcp_service, { id = "m4", visible = false }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 61
        width  = 12
        height = 6
        properties = {
          title  = "MCP load balancer"
          view   = "timeSeries"
          region = var.default_region
          period = var.monitoring.dashboard_period
          yAxis  = { left = { min = 0, label = "Count" } }
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", local.hpdx_mcp_lb, { label = "Requests", stat = "Sum", color = "#1f77b4" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", local.hpdx_mcp_lb, { label = "Target 5xx", stat = "Sum", color = "#d62728" }],
            ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", local.hpdx_mcp_tg, "LoadBalancer", local.hpdx_mcp_lb, { label = "Healthy hosts", stat = "Minimum", color = "#2ca02c" }],
          ]
        }
      },
    ]
  })
}
