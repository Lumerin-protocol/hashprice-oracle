locals {
  spot_indexer = {
    sgs = ["outb-all", "webu-all", "webs-all", "weba-all"]
    svc_name = "spot-indexer"
    friendly_name = "spotidx"
    alb_name = "spotidx." #needs to inlude trailing "." for non prods
    cnt_name = "spot-indexer"
    ghcr_repo = "ghcr.io/lumerin-protocol/proxy-indexer"
    cnt_port = 8081
  }
}

# Get Security Group IDs for Standard Bedrock SGs 
data "aws_security_group" "alb_spot_indexer" {
  provider = aws.use1
  for_each = toset(local.spot_indexer.sgs)
  vpc_id   = data.aws_vpc.use1_1.id
  name     = "bedrock-${each.key}"
  # to use, define local list of strings with sec group suffixes 
  # in code for sgs, use the following: vpc_security_group_ids = [for s in data.aws_security_group.alb_sg_use1_1 : s.id]
}

################################
# ECS SERVICE & TASK 
################################

# Define Service (watch for conflict with Gitlab CI/CD)
resource "aws_ecs_service" "spot_indexer" {
  lifecycle {
    ignore_changes = [task_definition] # May want to change this to kick update to prod when new task is replicated 
  }
  count                  = (var.ecs_cluster.create && var.spot_indexer.create) ? 1 : 0
  provider               = aws.use1
  name                   = "svc-${local.spot_indexer.svc_name}-${substr(var.account_shortname, 8, 3)}"
  cluster                = aws_ecs_cluster.hashprice_oracle[count.index].id
  task_definition        = aws_ecs_task_definition.spot_indexer[count.index].arn
  desired_count          = var.spot_indexer.task_worker_qty
  launch_type            = "FARGATE"
  propagate_tags         = "SERVICE"
  enable_execute_command = true
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = [for m in data.aws_subnet.middle_use1_1 : m.id]
    assign_public_ip = false
    security_groups  = [for s in data.aws_security_group.alb_spot_indexer : s.id]
  }
  load_balancer {
    target_group_arn = aws_alb_target_group.spot_indexer_ext[count.index].arn
    container_name   = "${local.spot_indexer.cnt_name}-container"
    container_port   = local.spot_indexer.cnt_port
  }

  depends_on = [aws_ecs_task_definition.spot_indexer[0]]

  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Spot Indexer Service ",
      Capability = null,
    },
  )
}

# Define Task  
resource "aws_ecs_task_definition" "spot_indexer" {
  lifecycle {
    ignore_changes = [container_definitions] # May want to change this to kick update to prod when new task is replicated 
  }
  count                    = (var.ecs_cluster.create && var.spot_indexer.create) ? 1 : 0
  provider                 = aws.use1
  family                   = "tsk-${local.spot_indexer.svc_name}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.spot_indexer.task_cpu
  memory                   = var.spot_indexer.task_ram
  task_role_arn            = "arn:aws:iam::${var.account_number}:role/system/bedrock-foundation-role"
  execution_role_arn       = "arn:aws:iam::${var.account_number}:role/system/bedrock-foundation-role"
  container_definitions = jsonencode([
    {
      name        = "${local.spot_indexer.cnt_name}-container"
      # Use auto-lookup tag if idx_imagetag is "auto", otherwise use pinned version
      image       = "${local.spot_indexer.ghcr_repo}:${var.spot_indexer.ghcr_imagetag}"
      cpu         = 0
      launch_type = "FARGATE"
      essential   = true
      portMappings = [
        {
          containerPort = local.spot_indexer.cnt_port
          hostPort      = local.spot_indexer.cnt_port
          protocol      = "tcp"
        }
      ]
      environment = [
        {
          name  = "PORT"
          value = tostring(local.spot_indexer.cnt_port)
        },
        {
          name  = "CLONE_FACTORY_ADDRESS"
          value = var.wallets.clone_factory_address
        },

        {
          name  = "HASHRATE_ORACLE_ADDRESS"
          value = var.wallets.hashrate_oracle_address
        }
      ]
      secrets = [
        {
          name  = "ADMIN_API_KEY"
          valueFrom = "${aws_secretsmanager_secret.spot_indexer.arn}:ADMIN_API_KEY::"
        },
        {
          name  = "ETH_NODE_URL"
          valueFrom = "${aws_secretsmanager_secret.spot_indexer.arn}:ETH_NODE_URL::"
        }
      ]
      logConfiguration = {
        logDriver : "awslogs",
        options : {
          awslogs-create-group : "true",
          awslogs-group : aws_cloudwatch_log_group.spot_indexer[count.index].name,
          awslogs-region : var.default_region,
          awslogs-stream-prefix : "${local.spot_indexer.svc_name}-tsk"
        }
      }
    },
  ])
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Spot Indexer ECS Task Definition ",
      Capability = null,
    },
  )
}


################################
# APPLICATION LOAD BALANCER, LISTENER, TARGET GROUP AND WAF 
################################

# EXTERNAL ALB (Internet facing, all Edge Subnets, security group)
resource "aws_alb" "spot_indexer_ext" {
  count                      = (var.ecs_cluster.create && var.spot_indexer.create) ? 1 : 0
  provider                   = aws.use1
  name                       = "alb-${local.spot_indexer.svc_name}-ext-${substr(var.account_shortname, 8, 3)}"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [for s in data.aws_security_group.alb_spot_indexer : s.id]
  subnets                    = [for e in data.aws_subnet.edge_use1_1 : e.id]
  enable_deletion_protection = var.spot_indexer.protect ? false : true
  # access_logs {
  #   bucket  = module.devops_s3_bucket.bucket_name
  #   prefix  = "alb"
  #   enabled = true
  # }
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Lumerin indexer External ALB ",
      Capability = null,
    },
  )
}

# ALB Internal Target group  (HTTP/80, IP, RoundRobin 
resource "aws_alb_target_group" "spot_indexer_ext" {
  count                         = (var.ecs_cluster.create && var.spot_indexer.create)  ? 1 : 0
  provider                      = aws.use1
  name                          = "tg-${local.spot_indexer.svc_name}-${local.spot_indexer.cnt_port}-${substr(var.account_shortname, 8, 3)}"
  port                          = local.spot_indexer.cnt_port
  protocol                      = "HTTP"
  vpc_id                        = data.aws_vpc.use1_1.id
  target_type                   = "ip"
  load_balancing_algorithm_type = "round_robin"
  deregistration_delay          = "10"
  health_check {
    enabled             = true
    interval            = 30
    path                = "/api/healthcheck"
    port                = local.spot_indexer.cnt_port
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Spot Indexer External ALB Target Group ",
      Capability = null,
    },
  )
}

# Create a listeners on the ALB 
resource "aws_alb_listener" "spot_indexer_ext_80" {
  count             = (var.ecs_cluster.create && var.spot_indexer.create) ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.spot_indexer_ext[count.index].arn
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
      Name       = "Spot Indexer External ALB Listener ",
      Capability = null,
    },
  )
}

resource "aws_alb_listener" "spot_indexer_ext_443" {
  count             = (var.ecs_cluster.create && var.spot_indexer.create) ? 1 : 0
  provider          = aws.use1
  load_balancer_arn = aws_alb.spot_indexer_ext[count.index].arn
  port              = "443"
  protocol          = "HTTPS"
  # SSL Policy Compatibility differences: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html#describe-ssl-policies
  # ssl_policy        = "ELBSecurityPolicy-2016-08" # Default ...highest compatibility 
  ssl_policy      = "ELBSecurityPolicy-FS-1-2-Res-2020-10" # Most recent, strictest security 
  certificate_arn = data.aws_acm_certificate.lumerin_general.id
  default_action {
    type             = "forward"
    target_group_arn = aws_alb_target_group.spot_indexer_ext[count.index].arn
  }
  tags = merge(
    var.default_tags,
    var.foundation_tags,
    {
      Name       = "Spot Indexer External ALB Listener ",
      Capability = null,
    },
  )
}

# Associate WAF And ALB Target 
resource "aws_wafv2_web_acl_association" "spot_indexer" {
  count        = (var.ecs_cluster.create && var.spot_indexer.create) ? 1 : 0
  provider     = aws.use1
  resource_arn = aws_alb.spot_indexer_ext[count.index].arn
  web_acl_arn  = data.aws_wafv2_web_acl.bedrock_waf_use1_1.arn
}

################################
# GLOBAL DNS 
################################
# Define Route53 Friendly Name to ALB 
resource "aws_route53_record" "spot_indexer" {
  count    = (var.ecs_cluster.create && var.spot_indexer.create) ? 1 : 0
  provider = aws.special-dns
  zone_id  = var.account_lifecycle == "prd" ? data.aws_route53_zone.public_lumerin_root.zone_id : data.aws_route53_zone.public_lumerin.zone_id
  name     = var.account_lifecycle == "prd" ? "${var.spot_indexer.friendly_name}.${data.aws_route53_zone.public_lumerin_root.name}" : "${var.spot_indexer.friendly_name}.${data.aws_route53_zone.public_lumerin.name}"
  type     = "A"
  alias {
    name                   = aws_alb.spot_indexer_ext[count.index].dns_name
    zone_id                = aws_alb.spot_indexer_ext[count.index].zone_id
    evaluate_target_health = true
  }
}
