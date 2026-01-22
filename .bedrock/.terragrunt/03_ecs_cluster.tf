locals {
ecs_svc_name = "hashprice-oracle"
ecs_task_worker_qty = 1
}

################################
# ECS CLUSTER 
################################
# Define ECS Cluster with Fargate as default provider 
resource "aws_ecs_cluster" "hashprice_oracle" {
  count    = var.ecs_cluster.create ? 1 : 0
  provider = aws.use1
  name     = "ecs-${local.ecs_svc_name}-${substr(var.account_shortname, 8, 3)}"
  configuration {
    execute_command_configuration {
      kms_key_id = "arn:aws:kms:${var.default_region}:${var.account_number}:alias/foundation-cmk-eks"
      logging    = "OVERRIDE"
      log_configuration {
        cloud_watch_encryption_enabled = false
        cloud_watch_log_group_name     = "bedrock-hpo-ecs-cluster-${substr(var.account_shortname, 8, 3)}"
      }
    }
  }
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Lumerin Hashprice Oracle ECS Cluster",
      Capability = null,
    },
  )
}

resource "aws_ecs_cluster_capacity_providers" "hashprice_oracle" {
  count              = var.ecs_cluster.create ? 1 : 0
  provider           = aws.use1
  cluster_name       = aws_ecs_cluster.hashprice_oracle[count.index].name
  capacity_providers = ["FARGATE"]
  default_capacity_provider_strategy {
    base              = local.ecs_task_worker_qty
    weight            = 100
    capacity_provider = "FARGATE"
  }
}
