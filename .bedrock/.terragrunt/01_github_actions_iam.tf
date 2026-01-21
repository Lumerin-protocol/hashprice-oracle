################################################################################
# GITHUB ACTIONS IAM ROLE AND POLICIES
################################################################################

################################################################################
# OIDC PROVIDER FOR GITHUB
################################################################################
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

################################################################################
# Local Variables for GitHub Actions CI/CD
################################################################################
locals {
  github_org_repo = "Lumerin-protocol/hashprice-oracle"
  github_branch_filter = var.account_lifecycle == "dev" ? [
    "ref:refs/heads/dev",
    "ref:refs/heads/cicd/*"
  ] : (
    var.account_lifecycle == "stg" ? ["ref:refs/heads/stg"] : ["ref:refs/heads/main"]
  )
}

################################################################################
# IAM ROLE FOR GITHUB ACTIONS
################################################################################
resource "aws_iam_role" "github_actions_hashprice_oracle" {
  count = var.core_resources.create ? 1 : 0
  name  = "github-actions-hashprice-oracle-v3-${substr(var.account_shortname, 8, 3)}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = data.aws_iam_openid_connect_provider.github.arn
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          StringLike = {
            # Branch filters are auto-derived based on environment lifecycle
            "token.actions.githubusercontent.com:sub" = concat(
              [for branch_filter in local.github_branch_filter :
              "repo:${local.github_org_repo}:${branch_filter}"],)              
          }
        }
      }
    ]
  })
  tags = merge(var.default_tags, var.foundation_tags, {
    Name       = "GitHub Actions - Hashprice Oracle"
    Capability = "CI/CD"
  })
}

################################################################################
# SECRETS ACCESS POLICY (for reading deployment secrets and configuration)
################################################################################

# resource "aws_iam_role_policy" "github_secrets_read" {
#   count = var.core_resources.create ? 1 : 0
#   name  = "secrets-read-hashprice-oracle"
#   role  = aws_iam_role.github_actions_hashprice_oracle[0].id

#   policy = jsonencode({
#     Version = "2012-10-17"
#     Statement = [
#       {
#         Sid    = "ReadHashpriceOracleSecrets"
#         Effect = "Allow"
#         Action = [
#           "secretsmanager:GetSecretValue",
#           "secretsmanager:DescribeSecret"
#         ]
#         Resource = [
#           var.switch.graph_indexer ? aws_secretsmanager_secret.graph_indexer[0].arn : null,
#           var.switch.spot_indexer ? aws_secretsmanager_secret.spot_indexer[0].arn : null,
#           var.switch.oracle_lambda ? aws_secretsmanager_secret.oracle_lambda[0].arn : null,
#         ]
#       }
#     ]
#   })
# }


# If the OIDC provider doesn't exist, create it
# Run this once manually if needed:
# aws iam create-open-id-connect-provider \
#   --url https://token.actions.githubusercontent.com \
#   --client-id-list sts.amazonaws.com \
#   --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1b511abead59c6ce207077c0bf0e0043b1382612 \
#   --profile titanio-stg
#
# Note: Two thumbprints are recommended by GitHub for compatibility:
# - 6938fd4d98bab03faadb97b34396831e3780aea1 (legacy)
# - 1b511abead59c6ce207077c0bf0e0043b1382612 (current as of 2023)


