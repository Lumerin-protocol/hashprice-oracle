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

  # Branch-scoped OIDC subjects — used when the workflow runs WITHOUT an
  # `environment:` declaration (e.g. cicd/** branches, ad-hoc pushes).
  github_branch_filter = var.account_lifecycle == "dev" ? [
    "ref:refs/heads/dev",
    "ref:refs/heads/cicd/*"
    ] : (
    var.account_lifecycle == "stg" ? ["ref:refs/heads/stg"] : ["ref:refs/heads/main"]
  )

  # Environment-scoped OIDC subjects — used when the workflow declares
  # `environment: <name>` so per-env GH variables/secrets resolve correctly.
  # Lifecycle "prd" maps to GitHub environment name "main" (gated on the
  # main branch on the GitHub side).
  github_environment_filter = var.account_lifecycle == "dev" ? ["environment:dev"] : (
    var.account_lifecycle == "stg" ? ["environment:stg"] : ["environment:main"]
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
            # Allow BOTH branch-scoped and environment-scoped OIDC subjects.
            # Branch subs keep cicd/** + ad-hoc branch pushes working; env
            # subs are required for the workflow's `environment:` declaration
            # to resolve per-env GH vars/secrets (e.g. env-scoped PRIVATE_KEY).
            # Filters are auto-derived from var.account_lifecycle.
            "token.actions.githubusercontent.com:sub" = concat(
              [for f in local.github_branch_filter : "repo:${local.github_org_repo}:${f}"],
              [for f in local.github_environment_filter : "repo:${local.github_org_repo}:${f}"],
            )
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
# LAMBDA UPDATE POLICY (for deploying Oracle Update Lambda via GitHub Actions)
################################################################################
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
      },
      {
        Sid    = "UpdateFuturesOracleLambdaEnvironment"
        Effect = "Allow"
        Action = [
          "lambda:UpdateFunctionConfiguration"
        ]
        Resource = aws_lambda_function.oracle_update[count.index].arn
      }
    ]
  })
}



