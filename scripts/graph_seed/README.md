# Graph Seed Script

This script deploys the Hashprice Oracle subgraph to The Graph Studio from your local machine.

## Why Use This?

The Graph Studio's IPFS service has rate limits that appear to be IP-based. GitHub Actions uses shared runners with shared IPs, which can hit rate limits due to other users' activity. Deploying from your local machine uses your own IP, avoiding this issue.

## Setup

1. Copy the environment file:
   ```bash
   cp .env.example .env
   ```

2. Fill in the values in `.env`:
   - Deploy keys from The Graph Studio (Settings → Deploy Key)
   - Contract addresses from your Terraform/GitHub vars
   - Network and block settings

3. Make sure you have dependencies installed:
   ```bash
   cd ../../indexer
   yarn install
   ```

## Usage

```bash
# Deploy to dev environment
./deploy.sh dev

# Deploy to staging environment
./deploy.sh stg

# Deploy to production environment
./deploy.sh lmn
```

## What It Does

1. Loads environment-specific configuration
2. Generates `subgraph.yaml` from template
3. Runs `yarn codegen` to generate AssemblyScript types
4. Authenticates with The Graph Studio
5. Deploys the subgraph

## After Deployment

1. Check the Studio dashboard for sync progress
2. Note the User ID from the query URL (for CI/CD configuration)
3. Update GitHub org variables with the User ID

## Troubleshooting

### Rate Limiting
If you still hit rate limits from your local machine, wait a few minutes and try again.

### Authentication Failed
Make sure your deploy key is correct and the subgraph exists in Studio.

### Build Errors
Check that contract ABIs are in the correct location (`../contracts/abi/`).
