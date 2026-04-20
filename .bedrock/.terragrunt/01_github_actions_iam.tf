################################################################################
# GITHUB ACTIONS IAM ROLE AND POLICIES
################################################################################

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
# LAMBDA UPDATE POLICY (for deploying Hashprice Keeper Lambda via GitHub Actions)
################################################################################
# Scope: code-only deploys. GitHub Actions can upload a new zip and publish
# a version, but NOT mutate the function's configuration (env vars, runtime,
# memory, etc.). Configuration is Terraform-owned — see 05_oracle_lambda.tf.
#
# Do NOT add lambda:UpdateFunctionConfiguration here. If a new env var is
# needed, add it to the TF environment map and apply, then push code.
resource "aws_iam_role_policy" "github_lambda_update_oracle" {
  count = var.oracle_lambda.create ? 1 : 0
  name  = "lambda-update-futures-oracle"
  role  = aws_iam_role.github_actions_hashprice_oracle[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "UpdateFuturesOracleLambdaFunction"
        Effect = "Allow"
        Action = [
          "lambda:UpdateFunctionCode",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:PublishVersion",
          "lambda:InvokeFunction" # Allow testing the Lambda function
        ]
        Resource = aws_lambda_function.oracle_update[count.index].arn
      }
    ]
  })
}



