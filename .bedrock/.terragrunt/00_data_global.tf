################################################################################
# APP-SPECIFIC GLOBAL LOOKUPS (data files, dns, iam, etc...)
################################################################################

# locals {
#     domain_zone_name = var.account_lifecycle == "prd" ? data.aws_route53_zone.public_lumerin_root.name : data.aws_route53_zone.public_lumerin.name
# }

################################
# DNS Lookups (legacy lumerin.io — spot indexer + ACM in 00_data_use1_1.tf)
################################
# Spot indexer and its certificates stay on lumerin.io until that stack is migrated.
# Hashpower public zones and ACM for hashpower.exchange / hpow.io are below (hp_dns / hp_acm).

# Find the Route53 Zone for root lumerin.io 
data "aws_route53_zone" "public_lumerin_root" {
  provider     = aws.titanio-prd
  name         = "lumerin.io"
  private_zone = false
}

data "aws_route53_zone" "public_lumerin" {
  provider     = aws.use1
  name         = "${substr(var.account_shortname, 8, 3)}.lumerin.io"
  private_zone = false
}
################################
# WAF Protection - for Cloudfront (Global Scope)
################################
data "aws_wafv2_web_acl" "bedrock_waf_cloudfront" {
  provider = aws.use1
  name     = "waf-bedrock-cloudfront"
  scope    = "CLOUDFRONT"
}

################################
# Hashpower DNS & ACM Lookups
#
# Conditional: lmn resolves root domains, dev/stg resolve env subdomains.
# Dependent code uses the same local reference regardless of account.
#
# Usage:
#   DNS zone:
#     local.hp_dns["exc"].zone_id
#     local.hp_dns["exc"].name   # "hashpower.exchange" (lmn) or "dev.hashpower.exchange" (dev)
#     local.hp_dns["tok"].zone_id
#
#   ACM cert:
#     local.hp_acm["exc"].arn
#     local.hp_acm["tok"].arn
#
#   Keys: exc = hashpower.exchange, tok = hpow.io, com = hashpower.io (when acquired)
################################
locals {
  env_prefix = substr(var.account_shortname, 8, 3)
  is_lmn     = local.env_prefix == "lmn"

  hashpower_domains = {
    exc = "hashpower.exchange"
    tok = "hpow.io"
    # com = "hashpower.io"  # uncomment when domain is acquired
  }
}

# DNS: root zones in titanio-net (lmn only)
data "aws_route53_zone" "hp_root" {
  for_each     = local.is_lmn ? local.hashpower_domains : {}
  provider     = aws.titanio-net
  name         = each.value
  private_zone = false
}

# DNS: env subdomain zones in local account (dev, stg)
data "aws_route53_zone" "hp_env" {
  for_each     = local.is_lmn ? {} : local.hashpower_domains
  provider     = aws.use1
  name         = "${local.env_prefix}.${each.value}"
  private_zone = false
}

# ACM: always in local account, domain conditional on env
data "aws_acm_certificate" "hp" {
  for_each = local.hashpower_domains
  provider = aws.use1
  domain   = local.is_lmn ? each.value : "${local.env_prefix}.${each.value}"
  statuses = ["ISSUED"]
}

locals {
  hp_dns = local.is_lmn ? data.aws_route53_zone.hp_root : data.aws_route53_zone.hp_env
  hp_acm = data.aws_acm_certificate.hp
}

output "hp_dns" {
  value = { for k, v in local.hp_dns : k => { zone_id = v.zone_id, name = v.name } }
}

output "hp_acm" {
  value = { for k, v in local.hp_acm : k => {
    arn    = v.arn
    domain = local.is_lmn ? local.hashpower_domains[k] : "${local.env_prefix}.${local.hashpower_domains[k]}"
  } }
}

