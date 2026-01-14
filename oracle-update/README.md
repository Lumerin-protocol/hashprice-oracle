Need to write a program that will grab the latest bitcoin block, update blockreward, fees and difficulty then update the smart contract oracle. 
This job should run every 5 minutes. 
If it finds no change to the current value, don't update, but if it is newer (new block height) then update the contract with that information.
This folder should hold the code for the script. 
.terragrunt will contain the terraform code for the AWS lambda framework, monitoring and deployment. 
2025-06-26 - Added code to gitlab-ci.yml to build the lambda function and deploy it to AWS. 
    * kick by updating files in the /oracle_update folder. 
    * the lambda function is built by yarn, and the zip file is built by terragrunt. 
    * the zip file is then uploaded to gitlab.
    * the lambda function is then deployed to AWS by running the terragrunt plan and apply commands.
    Added secrets manager to terraform foundation for key indexer variables: 
        * admin_api_key
        * oracle_private_key
        * clone_factory_address
        * eth_node_url
        * hashrate_oracle_address
    * these values are now pulled from the secrets manager instead of the local secret.auto.tfvars file
2025-07-15 - Cleaned up GitLab CI/CD pipeline documentation.