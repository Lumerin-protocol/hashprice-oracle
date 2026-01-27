#!/bin/bash
#
# Local Graph Seed Script for Hashprice Oracle Subgraph
# 
# This script deploys the subgraph to The Graph Studio from your local machine.
# Use this to bypass GitHub Actions shared IP rate limiting.
#
# Usage:
#   ./deploy.sh dev              # Deploy to dev environment (auto version)
#   ./deploy.sh stg              # Deploy to staging environment
#   ./deploy.sh lmn              # Deploy to production environment
#   ./deploy.sh dev v1.0.0       # Deploy with specific version
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR/../.."
INDEXER_DIR="$REPO_DIR/indexer"

# Load environment variables
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)
else
    echo "❌ Error: .env file not found"
    echo "   Copy .env.example to .env and fill in the values"
    exit 1
fi

# Get environment from argument or .env
ENV="${1:-$DEPLOY_ENV}"
VERSION_OVERRIDE="${2:-}"

if [ -z "$ENV" ]; then
    echo "❌ Error: No environment specified"
    echo "   Usage: ./deploy.sh [dev|stg|lmn] [version]"
    exit 1
fi

# Generate version from git tags (same logic as CI/CD) or use override
generate_version() {
    local env=$1
    
    cd "$REPO_DIR"
    
    LAST_TAG=$(git tag -l "subgraph-v*" 2>/dev/null | sort -V | tail -n 1)
    
    if [ -z "$LAST_TAG" ]; then
        BASE_VERSION="2.0.0"
    else
        LAST_VERSION=$(echo $LAST_TAG | sed 's/subgraph-v//' | sed 's/-.*$//')
        IFS='.' read -r MAJOR MINOR PATCH <<< "$LAST_VERSION"
        PATCH=$((PATCH + 1))
        BASE_VERSION="${MAJOR}.${MINOR}.${PATCH}"
    fi
    
    echo "v${BASE_VERSION}-${env}"
}

# Use override or generate
if [ -n "$VERSION_OVERRIDE" ]; then
    VERSION_LABEL="$VERSION_OVERRIDE"
else
    VERSION_LABEL=$(generate_version "$ENV")
fi

echo "=============================================="
echo "🚀 Graph Seed Script - Hashprice Oracle"
echo "=============================================="
echo "   Environment: $ENV"
echo "   Version:     $VERSION_LABEL"
echo "   Indexer Dir: $INDEXER_DIR"
echo ""

# Set environment-specific variables
case $ENV in
    dev)
        DEPLOY_KEY="$DEV_GRAPH_DEPLOY_KEY"
        SUBGRAPH_NAME="$DEV_SUBGRAPH_NAME"
        NETWORK="$DEV_NETWORK"
        HASHRATE_ORACLE_ADDRESS="$DEV_HASHRATE_ORACLE_ADDRESS"
        START_BLOCK_HASHRATE_ORACLE="$DEV_START_BLOCK_HASHRATE_ORACLE"
        HASHRATE_ORACLE_POLLING_BLOCK_INTERVAL="$DEV_HASHRATE_ORACLE_POLLING_BLOCK_INTERVAL"
        BTC_TOKEN_ORACLE_ADDRESS="$DEV_BTC_TOKEN_ORACLE_ADDRESS"
        START_BLOCK_BTC_TOKEN_ORACLE="$DEV_START_BLOCK_BTC_TOKEN_ORACLE"
        BTC_TOKEN_ORACLE_POLLING_BLOCK_INTERVAL="$DEV_BTC_TOKEN_ORACLE_POLLING_BLOCK_INTERVAL"
        ;;
    stg)
        DEPLOY_KEY="$STG_GRAPH_DEPLOY_KEY"
        SUBGRAPH_NAME="$STG_SUBGRAPH_NAME"
        NETWORK="$STG_NETWORK"
        HASHRATE_ORACLE_ADDRESS="$STG_HASHRATE_ORACLE_ADDRESS"
        START_BLOCK_HASHRATE_ORACLE="$STG_START_BLOCK_HASHRATE_ORACLE"
        HASHRATE_ORACLE_POLLING_BLOCK_INTERVAL="$STG_HASHRATE_ORACLE_POLLING_BLOCK_INTERVAL"
        BTC_TOKEN_ORACLE_ADDRESS="$STG_BTC_TOKEN_ORACLE_ADDRESS"
        START_BLOCK_BTC_TOKEN_ORACLE="$STG_START_BLOCK_BTC_TOKEN_ORACLE"
        BTC_TOKEN_ORACLE_POLLING_BLOCK_INTERVAL="$STG_BTC_TOKEN_ORACLE_POLLING_BLOCK_INTERVAL"
        ;;
    lmn)
        DEPLOY_KEY="$LMN_GRAPH_DEPLOY_KEY"
        SUBGRAPH_NAME="$LMN_SUBGRAPH_NAME"
        NETWORK="$LMN_NETWORK"
        HASHRATE_ORACLE_ADDRESS="$LMN_HASHRATE_ORACLE_ADDRESS"
        START_BLOCK_HASHRATE_ORACLE="$LMN_START_BLOCK_HASHRATE_ORACLE"
        HASHRATE_ORACLE_POLLING_BLOCK_INTERVAL="$LMN_HASHRATE_ORACLE_POLLING_BLOCK_INTERVAL"
        BTC_TOKEN_ORACLE_ADDRESS="$LMN_BTC_TOKEN_ORACLE_ADDRESS"
        START_BLOCK_BTC_TOKEN_ORACLE="$LMN_START_BLOCK_BTC_TOKEN_ORACLE"
        BTC_TOKEN_ORACLE_POLLING_BLOCK_INTERVAL="$LMN_BTC_TOKEN_ORACLE_POLLING_BLOCK_INTERVAL"
        ;;
    *)
        echo "❌ Error: Invalid environment '$ENV'"
        echo "   Valid options: dev, stg, lmn"
        exit 1
        ;;
esac

# Validate required variables
if [ -z "$DEPLOY_KEY" ]; then
    echo "❌ Error: Deploy key not set for $ENV environment"
    exit 1
fi

if [ -z "$SUBGRAPH_NAME" ]; then
    echo "❌ Error: Subgraph name not set for $ENV environment"
    exit 1
fi

echo "📋 Configuration:"
echo "   Subgraph:  $SUBGRAPH_NAME"
echo "   Network:   $NETWORK"
echo "   Version:   $VERSION_LABEL"
echo "   Hashrate Oracle: $HASHRATE_ORACLE_ADDRESS"
echo "   BTC Token Oracle: $BTC_TOKEN_ORACLE_ADDRESS"
echo ""

# Change to indexer directory
cd "$INDEXER_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    yarn install
fi

# Export environment variables for subgraph.yaml generation
export NETWORK
export HASHRATE_ORACLE_ADDRESS
export START_BLOCK_HASHRATE_ORACLE
export HASHRATE_ORACLE_POLLING_BLOCK_INTERVAL
export BTC_TOKEN_ORACLE_ADDRESS
export START_BLOCK_BTC_TOKEN_ORACLE
export BTC_TOKEN_ORACLE_POLLING_BLOCK_INTERVAL

# Generate subgraph.yaml from template
echo "⚙️  Preparing subgraph configuration..."
yarn prepare:env

echo ""
echo "📄 Generated subgraph.yaml:"
head -30 subgraph.yaml
echo "   ... (truncated)"
echo ""

# Generate code
echo "🔨 Generating AssemblyScript types..."
yarn codegen

# Authenticate with The Graph
echo ""
echo "🔐 Authenticating with The Graph Studio..."
npx graph auth "$DEPLOY_KEY"

# Deploy
echo ""
echo "🚀 Deploying subgraph to The Graph Studio..."
echo "   This may take a few minutes..."
echo ""

npx graph deploy "$SUBGRAPH_NAME" \
    --node https://api.studio.thegraph.com/deploy/ \
    --version-label "$VERSION_LABEL"

echo ""
echo "=============================================="
echo "✅ Deployment complete!"
echo "=============================================="
echo ""
echo "📊 View your subgraph:"
echo "   Studio: https://thegraph.com/studio/subgraph/$SUBGRAPH_NAME/"
echo ""
echo "🔍 Once synced, query at:"
echo "   https://api.studio.thegraph.com/query/YOUR_USER_ID/$SUBGRAPH_NAME/version/latest"
echo ""
