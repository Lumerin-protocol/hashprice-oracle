################################
# LOCAL VARIABLES 
################################
locals {
  titanio_role_arn           = "arn:aws:iam::${var.account_number}:role/system/bedrock-foundation-role"
}