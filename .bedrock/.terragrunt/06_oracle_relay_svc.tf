################################################################################
# ORACLE RELAY - ECS SERVICE (N64)
################################################################################
# Relays Bitcoin blocks to HashpriceBTC: runs keeper/src/adapters/node.ts, woken
# by Alchemy's Bitcoin block subscription with a 60 s fallback poll. No load
# balancer; /health backs the container health check that deploy-keeper.yml sets.
#
# Ownership split, as for svc-col-mar-keeper:
#   * Terraform: security group, log group, service shell, stub task definition.
#   * deploy-keeper.yml: image, public env (config/<env>.env), health check and
#     desired_count (vars.ORACLE_RELAY_DESIRED_COUNT, default 1).
################################################################################

locals {
  oracle_relay = {
    svc_name = "svc-oracle-relay-${local.env_short}"
    family   = "tsk-oracle-relay"
    cnt_name = "oracle-relay-container"
  }
  create_oracle_relay = var.ecs_cluster.create && var.oracle_relay.create
}

resource "aws_security_group" "oracle_relay_use1" {
  count       = local.create_oracle_relay ? 1 : 0
  provider    = aws.use1
  name        = "hpo-oracle-relay-ecs-${local.env_short}"
  description = "Oracle relay ECS tasks: outbound only (Bitcoin and Base RPC)"
  vpc_id      = data.aws_vpc.use1_1.id

  egress {
    description = "Allow all outbound (RPC access)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Oracle Relay ECS Security Group",
      Capability = null,
    },
  )
}

resource "aws_cloudwatch_log_group" "oracle_relay_use1" {
  count             = local.create_oracle_relay ? 1 : 0
  provider          = aws.use1
  name              = local.oracle_relay_log_group
  retention_in_days = local.cloudwatch_event_retention

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Oracle Relay ECS Log Group",
      Capability = null,
    },
  )
}

resource "aws_ecs_service" "oracle_relay_use1" {
  lifecycle { ignore_changes = [task_definition, desired_count] }
  count                  = local.create_oracle_relay ? 1 : 0
  provider               = aws.use1
  name                   = local.oracle_relay.svc_name
  cluster                = aws_ecs_cluster.hashprice_oracle[0].id
  task_definition        = aws_ecs_task_definition.oracle_relay_use1[0].arn
  desired_count          = 0
  launch_type            = "FARGATE"
  propagate_tags         = "SERVICE"
  enable_execute_command = true

  # One sender per key: deploys stop the old task before starting the new one.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [for m in data.aws_subnet.middle_use1_1 : m.id]
    assign_public_ip = false
    security_groups  = [aws_security_group.oracle_relay_use1[0].id]
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Oracle Relay Service",
      Capability = "Oracle",
    },
  )
}

resource "aws_ecs_task_definition" "oracle_relay_use1" {
  lifecycle { ignore_changes = [container_definitions] }
  count                    = local.create_oracle_relay ? 1 : 0
  provider                 = aws.use1
  family                   = local.oracle_relay.family
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.oracle_relay.task_cpu
  memory                   = var.oracle_relay.task_ram
  task_role_arn            = local.titanio_role_arn
  execution_role_arn       = local.titanio_role_arn

  container_definitions = jsonencode([
    {
      name      = local.oracle_relay.cnt_name
      image     = "public.ecr.aws/docker/library/busybox:latest"
      command   = ["sh", "-c", "echo 'oracle relay stub - awaiting CI/CD deploy'; sleep infinity"]
      cpu       = 0
      essential = true

      # Named for the Lambda the service replaced (hpo_secret_access lets
      # bedrock-foundation-role read it).
      secrets = [
        {
          name      = "PRIVATE_KEY"
          valueFrom = "${aws_secretsmanager_secret.oracle_lambda.arn}:private_key::"
        },
        {
          name      = "ETHEREUM_RPC_URL"
          valueFrom = "${aws_secretsmanager_secret.oracle_lambda.arn}:eth_rpc_url::"
        },
        {
          name      = "BITCOIN_RPC_URL"
          valueFrom = "${aws_secretsmanager_secret.oracle_lambda.arn}:bitcoin_rpc_url::"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-create-group"  = "true"
          "awslogs-group"         = local.oracle_relay_log_group
          "awslogs-region"        = var.default_region
          "awslogs-stream-prefix" = "oracle-relay-tsk"
        }
      }
    }
  ])

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "HPO Oracle Relay ECS Task Definition",
      Capability = "Oracle",
    },
  )
}
