################################################################################
# OUTPUTS - # Usage: terragrunt output github_actions_role_arn
################################################################################
output "github_actions_role_arn" {
  description = "ARN of the IAM role for GitHub Actions (used by all services)"
  value       = (var.core_resources.create) ? "echo ${aws_iam_role.github_actions_hashprice_oracle[0].arn} | gh secret set AWS_ROLE_ARN_${upper(substr(var.account_shortname, 8, 3))} -R Lumerin-protocol/hashprice-oracle" : null
}


output "spot_indexer_url" {
  description = "URL of the spot indexer"
  value       = (var.ecs_cluster.create && var.spot_indexer.create) ? "https://${aws_route53_record.spot_indexer[0].name}" : null
}

output "hpdx_dashboard_name" {
  description = "Name of the cross-stack HPDX health dashboard"
  value       = (var.monitoring.create && var.monitoring.create_dashboards) ? aws_cloudwatch_dashboard.hpdx[0].dashboard_name : null
}

output "oracle_relay_service_name" {
  description = "Name of the oracle relay ECS service"
  value       = local.create_oracle_relay ? aws_ecs_service.oracle_relay_use1[0].name : null
}