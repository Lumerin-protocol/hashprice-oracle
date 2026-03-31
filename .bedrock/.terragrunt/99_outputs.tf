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

output "oracle_lambda_name" {
  description = "Name of the oracle lambda"
  value       = (var.oracle_lambda.create) ? aws_lambda_function.oracle_update[0].function_name : null
}