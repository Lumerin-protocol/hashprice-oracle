# Subgraph Indexer - Self-hosted Graph Node with PostgreSQL (no IPFS)
locals {
  graph_indexer = {
    alb_sgs = ["outb-all", "webu-all", "webs-all", "weba-all"]
    rds_name = "graph-indexer"
    rds_admin = "graphadmin"
    rds_db_name = "graphnode"
    svc_name = "graph-indexer"
    cnt_name = "graph-indexer"
    friendly_name = "graph"
    cnt_port_http = 8000
    cnt_port_ws = 8001
    cnt_port_admin = 8020
    cnt_port_metrics = 8030
  }
}

################################
# SECURITY GROUPS
################################
# Get Security Group IDs for Standard Bedrock SGs 
data "aws_security_group" "alb_graph_indexer" {
  provider = aws.use1
  for_each = toset(local.graph_indexer.alb_sgs)
  vpc_id   = data.aws_vpc.use1_1.id
  name     = "bedrock-${each.key}"
  # to use, define local list of strings with sec group suffixes 
  # in code for sgs, use the following: vpc_security_group_ids = [for s in data.aws_security_group.alb_sg_use1_1 : s.id]
}

# Security group for RDS
resource "aws_security_group" "subgraph_rds" {
  count       = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider    = aws.use1
  name        = "${local.graph_indexer.rds_name}-${var.region_shortname}"
  description = "Security group for Subgraph RDS PostgreSQL"
  vpc_id      = data.aws_vpc.use1_1.id
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.rds_name} RDS Security Group",
      Capability = null,
    },
  )
}

# RDS Ingress: PostgreSQL from Local VPC
resource "aws_security_group_rule" "rds_from_local_vpc" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  type              = "ingress"
  description       = "PostgreSQL from Local VPC"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  security_group_id = aws_security_group.subgraph_rds[count.index].id
  cidr_blocks       = [data.aws_vpc.use1_1.cidr_block]
}

# RDS Ingress: PostgreSQL from VPN
resource "aws_security_group_rule" "rds_from_vpn" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  type              = "ingress"
  description       = "PostgreSQL from VPN"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  security_group_id = aws_security_group.subgraph_rds[count.index].id
  cidr_blocks       = ["172.18.0.0/19", "172.30.0.0/22"]
}

# RDS Ingress: PostgreSQL from Graph Node
resource "aws_security_group_rule" "rds_from_graph_node" {
  count                    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                 = aws.use1
  type                     = "ingress"
  description              = "PostgreSQL from Graph Node"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.subgraph_rds[count.index].id
  source_security_group_id = aws_security_group.graph_node_use1[count.index].id
}

# RDS Egress: Allow all outbound
resource "aws_security_group_rule" "rds_egress_all" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  type              = "egress"
  description       = "Allow all outbound"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.subgraph_rds[count.index].id
  cidr_blocks       = ["0.0.0.0/0"]
}

# Security group for Graph Node ALB
resource "aws_security_group" "graph_node_alb_use1" {
  count       = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider    = aws.use1
  name        = "${local.graph_indexer.svc_name}-alb-${var.region_shortname}"
  description = "Security group for ${local.graph_indexer.svc_name} ALB - allows HTTP, HTTPS, and Admin API"
  vpc_id      = data.aws_vpc.use1_1.id

  # Allow HTTP from anywhere (will redirect to HTTPS)
  ingress {
    description = "HTTP from anywhere"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow HTTPS from anywhere (GraphQL queries)
  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow Admin API port from anywhere (for GitHub Actions and graph CLI)
  ingress {
    description = "Admin API from anywhere"
    from_port   = 8020
    to_port     = 8020
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Allow Admin API port from VPN and Local VPC (for GitHub Actions and graph CLI)
  ingress {
    description = "Admin API from VPN and Local VPC"
    from_port   = 8030
    to_port     = 8030
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    # cidr_blocks = ["172.18.0.0/19", data.aws_vpc.use1_1.cidr_block]
  }

  # Allow all outbound
  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} ALB Security Group",
      Capability = null,
    },
  )
}

# Security group for Graph Node ECS tasks
resource "aws_security_group" "graph_node_use1" {
  count       = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider    = aws.use1
  name        = "${local.graph_indexer.svc_name}-svc-${var.region_shortname}"
  description = "Security group for ${local.graph_indexer.svc_name} ECS tasks"
  vpc_id      = data.aws_vpc.use1_1.id

  # No inline rules - all managed via separate aws_security_group_rule resources

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} ECS Security Group",
      Capability = null,
    },
  )
}

# Graph Node Ingress: GraphQL HTTP from ALB
resource "aws_security_group_rule" "graph_node_from_alb_8000" {
  count                    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                 = aws.use1
  type                     = "ingress"
  description              = "GraphQL HTTP from ALB"
  from_port                = 8000
  to_port                  = 8000
  protocol                 = "tcp"
  security_group_id        = aws_security_group.graph_node_use1[count.index].id
  source_security_group_id = aws_security_group.graph_node_alb_use1[count.index].id
}

# Graph Node Ingress: GraphQL WebSocket from ALB
resource "aws_security_group_rule" "graph_node_from_alb_8001" {
  count                    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                 = aws.use1
  type                     = "ingress"
  description              = "GraphQL WebSocket from ALB"
  from_port                = 8001
  to_port                  = 8001
  protocol                 = "tcp"
  security_group_id        = aws_security_group.graph_node_use1[count.index].id
  source_security_group_id = aws_security_group.graph_node_alb_use1[count.index].id
}

# Graph Node Ingress: Admin API from ALB
resource "aws_security_group_rule" "graph_node_from_alb_8020" {
  count                    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                 = aws.use1
  type                     = "ingress"
  description              = "Admin API from ALB"
  from_port                = 8020
  to_port                  = 8020
  protocol                 = "tcp"
  security_group_id        = aws_security_group.graph_node_use1[count.index].id
  source_security_group_id = aws_security_group.graph_node_alb_use1[count.index].id
}

# Graph Node Ingress: Metrics from ALB
resource "aws_security_group_rule" "graph_node_from_alb_8040" {
  count                    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                 = aws.use1
  type                     = "ingress"
  description              = "Metrics from ALB"
  from_port                = 8040
  to_port                  = 8040
  protocol                 = "tcp"
  security_group_id        = aws_security_group.graph_node_use1[count.index].id
  source_security_group_id = aws_security_group.graph_node_alb_use1[count.index].id
}

# Graph Node Ingress: Metrics from ALB
resource "aws_security_group_rule" "graph_node_from_alb_8030" {
  count                    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                 = aws.use1
  type                     = "ingress"
  description              = "Metrics from ALB"
  from_port                = 8030
  to_port                  = 8030
  protocol                 = "tcp"
  security_group_id        = aws_security_group.graph_node_use1[count.index].id
  source_security_group_id = aws_security_group.graph_node_alb_use1[count.index].id
}

# Graph Node Ingress: All ports from Local VPC
resource "aws_security_group_rule" "graph_node_from_local_vpc" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  type              = "ingress"
  description       = "All Graph Node ports from Local VPC"
  from_port         = 8000
  to_port           = 8040
  protocol          = "tcp"
  security_group_id = aws_security_group.graph_node_use1[count.index].id
  cidr_blocks       = [data.aws_vpc.use1_1.cidr_block]
}

# Graph Node Ingress: All ports from VPN
resource "aws_security_group_rule" "graph_node_from_vpn" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  type              = "ingress"
  description       = "All Graph Node ports from VPN"
  from_port         = 8000
  to_port           = 8040
  protocol          = "tcp"
  security_group_id = aws_security_group.graph_node_use1[count.index].id
  cidr_blocks       = ["172.18.0.0/19"]
}

# Graph Node Egress: Ethereum RPC (HTTPS)
resource "aws_security_group_rule" "graph_node_to_internet_https" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  type              = "egress"
  description       = "Ethereum RPC and internet access"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  security_group_id = aws_security_group.graph_node_use1[count.index].id
  cidr_blocks       = ["0.0.0.0/0"]
}

# Graph Node Egress: IPFS gateway (HTTP)
resource "aws_security_group_rule" "graph_node_to_internet_http" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  type              = "egress"
  description       = "HTTP for IPFS gateway"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  security_group_id = aws_security_group.graph_node_use1[count.index].id
  cidr_blocks       = ["0.0.0.0/0"]
}

# Graph Node Egress: PostgreSQL to RDS
resource "aws_security_group_rule" "graph_node_to_rds" {
  count                    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                 = aws.use1
  type                     = "egress"
  description              = "PostgreSQL to RDS"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.graph_node_use1[count.index].id
  source_security_group_id = aws_security_group.subgraph_rds[count.index].id
}

################################
# RDS POSTGRESQL FOR GRAPH NODE
################################

# DB Subnet Group
resource "aws_db_subnet_group" "subgraph_use1" {
  count      = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider   = aws.use1
  name       = "${local.graph_indexer.rds_name}-db-subnet-${var.region_shortname}"
  subnet_ids = [for m in data.aws_subnet.middle_use1_1 : m.id]

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.rds_name} DB Subnet Group",
      Capability = null,
    },
  )
}

# RDS PostgreSQL Instance for Graph Node
resource "aws_db_instance" "subgraph_use1" {
  lifecycle { ignore_changes = [engine_version] }
  count                 = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider              = aws.use1
  identifier            = "${local.graph_indexer.rds_name}-${substr(var.account_shortname, 8, 3)}-${var.region_shortname}-v2"
  engine                = "postgres"
  engine_version        = "17.4"
  instance_class        = var.graph_indexer.db_instance_class
  allocated_storage     = var.graph_indexer.db_allocated_storage
  max_allocated_storage = var.graph_indexer.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  # Don't create initial database - we'll create it with correct collation using postgresql provider
  # db_name                = "graphnode"
  username = local.graph_indexer.rds_admin
  password = var.graph_indexer_db_password # Manually controlled - no auto-rotation

  db_subnet_group_name   = aws_db_subnet_group.subgraph_use1[count.index].name
  vpc_security_group_ids = [aws_security_group.subgraph_rds[count.index].id]

  parameter_group_name = aws_db_parameter_group.subgraph_use1[count.index].name

  backup_retention_period = var.graph_indexer.db_backup_retention_period
  backup_window           = var.graph_indexer.db_backup_window
  maintenance_window      = var.graph_indexer.db_maintenance_window

  skip_final_snapshot       = var.graph_indexer.protect ? false : true
  final_snapshot_identifier = var.graph_indexer.protect ? "${local.graph_indexer.rds_name}-final-${substr(var.account_shortname, 8, 3)}-${formatdate("YYYY-MM-DD-hhmm", timestamp())}-v2" : null

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.rds_name} RDS PostgreSQL",
      Capability = null,
    },
  )
}

################################
# DATABASE WITH C COLLATION (via null_resource + psql)
################################

# Create database with C collation using psql (required by Graph Node)
# This runs after RDS is created to ensure correct collation
# IAM Role for Lambda to create database
resource "aws_iam_role" "lambda_db_creator" {
  count    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider = aws.use1

  name = "${local.graph_indexer.rds_name}-db-creator-${substr(var.account_shortname, 8, 3)}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.rds_name} DB Creator Lambda Role"
      Capability = null
    }
  )
}

# IAM Policy for Lambda VPC execution
resource "aws_iam_role_policy_attachment" "lambda_vpc_execution" {
  count      = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  role       = aws_iam_role.lambda_db_creator[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Security Group for Lambda to access RDS
resource "aws_security_group" "lambda_db_creator" {
  count       = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider    = aws.use1
  name        = "${local.graph_indexer.rds_name}-db-creator-${var.region_shortname}"
  description = "Allow Lambda to connect to RDS for database creation"
  vpc_id      = data.aws_vpc.use1_1.id

  egress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.use1_1.cidr_block]
    description = "PostgreSQL access to RDS"
  }

  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
    description = "HTTPS for AWS API calls"
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.rds_name} DB Creator Lambda SG"
      Capability = null
    }
  )
}

# Add Lambda security group to RDS security group ingress
resource "aws_security_group_rule" "rds_from_lambda" {
  count                    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                 = aws.use1
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.subgraph_rds[0].id
  source_security_group_id = aws_security_group.lambda_db_creator[0].id
  description              = "PostgreSQL from Lambda DB creator"
}

# Lambda function to create database
resource "aws_lambda_function" "create_graphnode_db" {
  count    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider = aws.use1
  function_name = "${local.graph_indexer.rds_name}-db-creator-${substr(var.account_shortname, 8, 3)}"
  role          = aws_iam_role.lambda_db_creator[0].arn
  handler       = "lambda_create_db.handler"
  runtime       = "python3.11"
  timeout       = 60
  memory_size   = 256

  vpc_config {
    subnet_ids         = [for m in data.aws_subnet.middle_use1_1 : m.id]
    security_group_ids = [aws_security_group.lambda_db_creator[0].id]
  }

  environment {
    variables = {
      DB_HOST     = aws_db_instance.subgraph_use1[0].address
      DB_PORT     = tostring(aws_db_instance.subgraph_use1[0].port)
      DB_USER     = aws_db_instance.subgraph_use1[0].username
      DB_PASSWORD = var.graph_indexer_db_password
      DB_NAME     = local.graph_indexer.rds_db_name
    }
  }

  filename         = "${path.module}/lambda_create_db.zip"
  source_code_hash = filebase64sha256("${path.module}/lambda_create_db.zip")

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.rds_name} DB Creator Lambda"
      Capability = null
    }
  )

  depends_on = [
    aws_iam_role_policy_attachment.lambda_vpc_execution,
    aws_db_instance.subgraph_use1
  ]
}

# NOTE: Lambda invocation for database creation
# The Lambda function 'create_graphnode_db' is idempotent and should be invoked manually
# via AWS Console, CloudShell, or from an EC2 instance after RDS is created.
#
# Invocation command (from AWS environment with credentials):
  # aws lambda invoke \
  #   --profile titanio-dev \
  #   --function-name graph-indexer-db-creator-dev \
  #   --region us-east-1 \
  #   --log-type Tail \
  #   /tmp/response.json && cat /tmp/response.json
#
# The Lambda will check if the database exists and only create it if missing.
# Safe to run multiple times - will return success if database already exists.

# DB Parameter Group - optimized for Graph Node
resource "aws_db_parameter_group" "subgraph_use1" {
  count    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider = aws.use1
  name     = "${local.graph_indexer.rds_name}-pg17-${var.region_shortname}"
  family   = "postgres17"

  parameter {
    name         = "max_connections"
    value        = var.graph_indexer.db_max_connections
    apply_method = "pending-reboot"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.rds_name} DB Parameter Group",
      Capability = null,
    },
  )
}

################################
# CLOUDWATCH LOGS
################################

resource "aws_cloudwatch_log_group" "graph_node_use1" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  name              = "/ecs/${local.graph_indexer.svc_name}-${substr(var.account_shortname, 8, 3)}"
  retention_in_days = 7

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} ECS Log Group",
      Capability = null,
    },
  )
}

################################
# ECS SERVICE & TASK - GRAPH NODE
################################

resource "aws_ecs_service" "graph_node_use1" {
  # lifecycle {ignore_changes = [task_definition]}
  count                  = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider               = aws.use1
  name                   = "svc-${local.graph_indexer.svc_name}-${substr(var.account_shortname, 8, 3)}"
  cluster                = aws_ecs_cluster.hashprice_oracle[0].id
  task_definition        = aws_ecs_task_definition.graph_node_use1[count.index].arn
  desired_count          = 1 #var.graph_indexer.task_worker_qty
  launch_type            = "FARGATE"
  propagate_tags         = "SERVICE"
  enable_execute_command = true

  # ✅ Prevent overlapping old/new tasks during deployment (stop old first, then start new)
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  
  # Give Graph Node time to wait for IPFS and database to be ready
  health_check_grace_period_seconds = 180

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [for m in data.aws_subnet.middle_use1_1 : m.id]
    assign_public_ip = false
    security_groups  = [aws_security_group.graph_node_use1[count.index].id]
  }

  load_balancer {
    target_group_arn = aws_alb_target_group.graph_node_http_use1[count.index].arn
    container_name   = "${local.graph_indexer.cnt_name}-container"
    container_port   = local.graph_indexer.cnt_port_http
  }

  load_balancer {
    target_group_arn = aws_alb_target_group.graph_node_admin_use1[count.index].arn
    container_name   = "${local.graph_indexer.cnt_name}-container"
    container_port   = local.graph_indexer.cnt_port_admin
  }

  load_balancer {
    target_group_arn = aws_alb_target_group.graph_node_metrics_use1[count.index].arn
    container_name   = "${local.graph_indexer.cnt_name}-container"
    container_port   = local.graph_indexer.cnt_port_metrics
  }

  depends_on = [
    aws_ecs_task_definition.graph_node_use1,
    aws_db_instance.subgraph_use1,
    # aws_ecs_service.ipfs_use1,  # Disabled - using The Graph's public IPFS
    aws_security_group.graph_node_use1,
    aws_alb_listener.graph_node_ext_443_use1,
    aws_alb_listener.graph_node_ext_8020_use1
  ]

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} Service",
      Capability = null,
    },
  )
}

resource "aws_ecs_task_definition" "graph_node_use1" {
  # lifecycle {ignore_changes = [container_definitions]}
  count                    = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                 = aws.use1
  family                   = "tsk-${local.graph_indexer.svc_name}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.graph_indexer.task_cpu
  memory                   = var.graph_indexer.task_ram
  task_role_arn            = "arn:aws:iam::${var.account_number}:role/system/bedrock-foundation-role"
  execution_role_arn       = "arn:aws:iam::${var.account_number}:role/system/bedrock-foundation-role"

  container_definitions = jsonencode([
    {
      name      = "${local.graph_indexer.cnt_name}-container"
      image     = var.graph_indexer.imagetag
      cpu       = 0
      essential = true

      portMappings = [
        {
          containerPort = local.graph_indexer.cnt_port_http
          hostPort      = local.graph_indexer.cnt_port_http
          protocol      = "tcp"
        },
        {
          containerPort = local.graph_indexer.cnt_port_ws
          hostPort      = local.graph_indexer.cnt_port_ws
          protocol      = "tcp"
        },
        {
          containerPort = local.graph_indexer.cnt_port_admin
          hostPort      = local.graph_indexer.cnt_port_admin
          protocol      = "tcp"
        },
        {
          containerPort = local.graph_indexer.cnt_port_metrics
          hostPort      = local.graph_indexer.cnt_port_metrics
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "postgres_host"
          value = split(":", aws_db_instance.subgraph_use1[count.index].endpoint)[0]
        },
        {
          name  = "postgres_port"
          value = "5432"
        },
        {
          name  = "postgres_user"
          value = aws_db_instance.subgraph_use1[count.index].username
        },
        {
          name  = "postgres_db"
          value = local.graph_indexer.rds_db_name # Created by null_resource with C collation
        },
        {
          name  = "ipfs"
          # Using The Graph's public IPFS - content uploaded via graph deploy is immediately available
          # To use local IPFS instead: value = "ipfs.subgraph.local:5001"
          value = "https://api.thegraph.com/ipfs"
        },
        # PostgreSQL SSL/TLS configuration
        {
          name  = "PGSSLMODE"
          value = "require" # Require TLS encryption for all connections
        },
        # PostgreSQL connection stability parameters
        {
          name  = "PGCONNECT_TIMEOUT"
          value = "10" # Connection timeout in seconds
        },
        {
          name  = "PGTCP_KEEPALIVES"
          value = "1" # Enable TCP keepalives
        },
        {
          name  = "PGTCP_KEEPALIVES_IDLE"
          value = "60" # Seconds before first keepalive probe
        },
        {
          name  = "PGTCP_KEEPALIVES_INTERVAL"
          value = "10" # Seconds between keepalive probes
        },
        {
          name  = "PGTCP_KEEPALIVES_COUNT"
          value = "5" # Number of probes before declaring connection dead
        },
        # Graph Node connection pool tuning
        {
          name  = "STORE_CONNECTION_MIN_IDLE"
          value = "5" # Minimum idle connections to maintain
        },
        {
          name  = "STORE_CONNECTION_TIMEOUT"
          value = "30" # Seconds to wait for connection from pool
        },
        {
          name  = "GRAPH_LOG"
          value = var.account_lifecycle == "dev" ? "debug" : "info"
        },
        {
          name  = "GRAPH_LOG_QUERY_TIMING"
          value = var.account_lifecycle == "dev" ? "gql" : "none"
        },
        # IPFS reliability settings - helps prevent deployment timeouts
        {
          name  = "GRAPH_IPFS_TIMEOUT"
          value = "300" # 5 minutes timeout for IPFS requests (default is 60s)
        },
        {
          name  = "IPFS_TIMEOUT"
          value = "300" # Alternative env var for IPFS timeout
        },
        {
          name  = "GRAPH_MAX_IPFS_FILE_BYTES"
          value = "52428800" # 50MB max file size from IPFS
        },
        {
          name  = "GRAPH_SUBGRAPH_MAX_DATA_SOURCES"
          value = "100" # Allow more data sources if needed
        }
      ]
      # Pull postgres password from manually-managed Secrets Manager secret
      secrets = [
        {
          name      = "postgres_pass"
          valueFrom = "${aws_secretsmanager_secret.graph_indexer.arn}:graph_indexer_db_password::"
        }, 
        {
          name  = "ethereum"
          valueFrom = "${aws_secretsmanager_secret.graph_indexer.arn}:graph_eth_rpc_url::"
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-create-group"  = "true"
          "awslogs-group"         = aws_cloudwatch_log_group.graph_node_use1[0].name
          "awslogs-region"        = var.default_region
          "awslogs-stream-prefix" = "${local.graph_indexer.svc_name}-tsk"
        }
      }
    }
  ])

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} ECS Task Definition",
      Capability = null,
    },
  )
}

################################
# APPLICATION LOAD BALANCER
################################

# EXTERNAL ALB (for GraphQL queries)
resource "aws_alb" "graph_node_ext_use1" {
  count                      = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                   = aws.use1
  name                       = "alb-${local.graph_indexer.svc_name}-ext-${substr(var.account_shortname, 8, 3)}"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.graph_node_alb_use1[count.index].id]
  subnets                    = [for e in data.aws_subnet.edge_use1_1 : e.id]
  enable_deletion_protection = var.graph_indexer.protect ? false : true
  idle_timeout               = 300 # 5 minutes for subgraph deployments

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} External ALB",
      Capability = null,
    },
  )
}

# ALB Target group for HTTP (GraphQL)
resource "aws_alb_target_group" "graph_node_http_use1" {
  count                         = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                      = aws.use1
  name                          = "tg-${local.graph_indexer.svc_name}-http-${local.graph_indexer.cnt_port_http}"
  port                          = local.graph_indexer.cnt_port_http
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.use1_1.id
  target_type                   = "ip"
  load_balancing_algorithm_type = "round_robin"
  deregistration_delay          = "10"

  health_check {
    enabled             = true
    interval            = 30
    path                = "/"
    port                = local.graph_indexer.cnt_port_http
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200,404" # Graph node returns 404 for root path
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} HTTP Target Group",
      Capability = null,
    },
  )
}

# ALB Target group for Admin API
resource "aws_alb_target_group" "graph_node_admin_use1" {
  count                         = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                      = aws.use1
  name                          = "tg-${local.graph_indexer.svc_name}-admin-${local.graph_indexer.cnt_port_admin}"
  port                          = local.graph_indexer.cnt_port_admin
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.use1_1.id
  target_type                   = "ip"
  load_balancing_algorithm_type = "round_robin"
  deregistration_delay          = "10"

  health_check {
    enabled             = true
    interval            = 30
    path                = "/"
    port                = local.graph_indexer.cnt_port_admin
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200,404,405" # Admin API may return 405 for GET on root
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} Admin API Target Group",
      Capability = null,
    },
  )
}

# ALB Target group for Metrics API
resource "aws_alb_target_group" "graph_node_metrics_use1" {
  count                         = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider                      = aws.use1
  name                          = "tg-${local.graph_indexer.svc_name}-metrics-${local.graph_indexer.cnt_port_metrics}"
  port                          = local.graph_indexer.cnt_port_metrics
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.use1_1.id
  target_type                   = "ip"
  load_balancing_algorithm_type = "round_robin"
  deregistration_delay          = "10"

  health_check {
    enabled             = true
    interval            = 30
    path                = "/"
    port                = local.graph_indexer.cnt_port_metrics
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200,404" # Metrics API may return 404 for root
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} Metrics API Target Group",
      Capability = null,
    },
  )
}

# Create listeners on the ALB 
resource "aws_alb_listener" "graph_node_ext_80_use1" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.graph_node_ext_use1[count.index].arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    order = 1
    type  = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
      host        = "#{host}"
      path        = "/#{path}"
      query       = "#{query}"
    }
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} External ALB Listener 80",
      Capability = null,
    },
  )
}

resource "aws_alb_listener" "graph_node_ext_443_use1" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.graph_node_ext_use1[count.index].arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-FS-1-2-Res-2020-10"
  certificate_arn = data.aws_acm_certificate.lumerin_ext.id

  default_action {
    type             = "forward"
    target_group_arn = aws_alb_target_group.graph_node_http_use1[count.index].arn
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} External ALB Listener 443",
      Capability = null,
    },
  )
}

# Listener for Admin API (port 8020) - for graph deploy from GitHub Actions
resource "aws_alb_listener" "graph_node_ext_8020_use1" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.graph_node_ext_use1[count.index].arn
  port              = "8020"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-FS-1-2-Res-2020-10"
  certificate_arn = data.aws_acm_certificate.lumerin_ext.id

  default_action {
    type             = "forward"
    target_group_arn = aws_alb_target_group.graph_node_admin_use1[count.index].arn
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} External ALB Listener 8020 - Admin API",
      Capability = null,
    },
  )
}

# Listener for Metrics API (port 8030) - for graph deploy from GitHub Actions
resource "aws_alb_listener" "graph_node_ext_8030_use1" {
  count             = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.graph_node_ext_use1[count.index].arn
  port              = "8030"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-FS-1-2-Res-2020-10"
  certificate_arn = data.aws_acm_certificate.lumerin_ext.id

  default_action {
    type             = "forward"
    target_group_arn = aws_alb_target_group.graph_node_metrics_use1[count.index].arn
  }

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "${local.graph_indexer.svc_name} External ALB Listener 8030 - Metrics API",
      Capability = null,
    },
  )
}


################################
# GLOBAL DNS FRIENDLY NAME
################################

resource "aws_route53_record" "graph_indexer" {
  count = (var.ecs_cluster.create && var.graph_indexer.create) ? 1 : 0
  provider = aws.use1
  zone_id  = data.aws_route53_zone.public_lumerin.zone_id
  name     = "${local.graph_indexer.friendly_name}.${data.aws_route53_zone.public_lumerin.name}"
  type    = "A"
  alias {
    name                   = aws_alb.graph_node_ext_use1[count.index].dns_name
    zone_id                = aws_alb.graph_node_ext_use1[count.index].zone_id
    evaluate_target_health = true
  }
}
