locals {
  log_group_name             = "bedrock-hashprice-oracle-${substr(var.account_shortname, 8, 3)}"
  cloudwatch_event_retention = 90
}

# Create the IAM Role
resource "aws_iam_role" "hashprice_oracle" {
  count              = var.core_resources.create ? 1 : 0
  provider           = aws.use1
  name               = "${local.log_group_name}-cw-role"
  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "ecs.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Capability = "Bedrock IAM Role",
    },
  )
}

# Create the Inline Policy for the IAM Role
resource "aws_iam_role_policy" "hashprice_oracle" {
  count    = var.core_resources.create ? 1 : 0
  provider = aws.use1
  name     = "${local.log_group_name}-cw-policy"
  role     = aws_iam_role.hashprice_oracle[0].id
  policy   = data.aws_iam_policy_document.hashprice_oracle_cloudwatch_log_stream.json
}

# Create the Log Stream Policy JSON data for the CloudWatch Logs Role
data "aws_iam_policy_document" "hashprice_oracle_cloudwatch_log_stream" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      var.ecs_cluster.create ? "arn:aws:logs:${var.default_region}:${var.account_number}:bedrock-hpo-ecs-cluster-${substr(var.account_shortname, 8, 3)}:log-stream:*" : "",
      var.spot_indexer.create ? "arn:aws:logs:${var.default_region}:${var.account_number}:bedrock-hpo-${local.spot_indexer.svc_name}-${substr(var.account_shortname, 8, 3)}:log-stream:*" : ""
    ]
  }
}

###############################
# Create the default CloudWatch Log Group resource for Lumerin Marketplace Service 
resource "aws_cloudwatch_log_group" "hashprice_oracle" {
  count             = var.ecs_cluster.create ? 1 : 0
  provider          = aws.use1
  name              = "bedrock-hpo-${local.ecs_svc_name}-${substr(var.account_shortname, 8, 3)}"
  retention_in_days = local.cloudwatch_event_retention
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Capability = "Bedrock Cloudwatch Log Group",
    },
  )
}

# Create the default CloudWatch Log Group resource for Lumerin_Indexer Services 
resource "aws_cloudwatch_log_group" "spot_indexer" {
  count             = var.spot_indexer.create ? 1 : 0
  provider          = aws.use1
  name              = "bedrock-hpo-${local.spot_indexer.svc_name}-${substr(var.account_shortname, 8, 3)}"
  retention_in_days = local.cloudwatch_event_retention
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Capability = "Bedrock Cloudwatch Log Group",
    },
  )
}

# Create the default CloudWatch Log Group resource for Oracle Lambda Services 
resource "aws_cloudwatch_log_group" "oracle_lambda" {
  count             = var.oracle_lambda.create ? 1 : 0
  provider          = aws.use1
  name              = "bedrock-hpo-${var.oracle_lambda.svc_name}-${substr(var.account_shortname, 8, 3)}"
  retention_in_days = local.cloudwatch_event_retention
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Capability = "Bedrock Cloudwatch Log Group",
    },
  )
}