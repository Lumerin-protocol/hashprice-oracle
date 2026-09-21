#!/bin/bash
#
# Local Graph Seed Script for Hashprice Oracle Subgraph
# 
# Multi-phase deployment to avoid The Graph's IPFS rate limiting:
#   0. IPFS Setup - ensure local IPFS daemon is running
#   1. Build - compile subgraph locally
#   2. Upload - push to local IPFS (propagates to global network)
#   3. Verify - wait for IPFS propagation to The Graph's nodes
#   4. Deploy - trigger The Graph using IPFS hash
#   5. Cleanup - stop local IPFS daemon
#
# Usage:
#   ./deploy.sh dev              # Deploy to dev environment
#   ./deploy.sh stg              # Deploy to staging environment
#   ./deploy.sh lmn              # Deploy to production environment
#   ./deploy.sh dev v1.0.0       # Deploy with specific version
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR/../.."
INDEXER_DIR="$REPO_DIR/indexer"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Track if we started IPFS (so we know to stop it later)
IPFS_STARTED_BY_SCRIPT=false

#############################################
# Cleanup function - runs on exit
#############################################
cleanup() {
    if [ "$IPFS_STARTED_BY_SCRIPT" = true ]; then
        echo ""
        echo -e "${YELLOW}🧹 Cleaning up: Stopping IPFS daemon...${NC}"
        ipfs shutdown 2>/dev/null || pkill -f "ipfs daemon" 2>/dev/null || true
        echo -e "${GREEN}✅ IPFS daemon stopped${NC}"
    fi
}

# Register cleanup function to run on exit (success or failure)
trap cleanup EXIT

#############################################
# PHASE 0: IPFS Setup
#############################################
setup_ipfs() {
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}🔧 PHASE 0: IPFS Setup${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    
    # Check if running on macOS
    if [[ "$(uname)" != "Darwin" ]]; then
        echo -e "${YELLOW}⚠️  Not on macOS - skipping Homebrew IPFS setup${NC}"
        echo "   Please ensure IPFS is installed and running manually"
        echo "   Or set IPFS_URL in .env to point to your IPFS node"
        return 0
    fi
    
    # Check if Homebrew is installed
    if ! command -v brew &> /dev/null; then
        echo -e "${RED}❌ Homebrew not found${NC}"
        echo "   Install Homebrew: https://brew.sh"
        echo "   Or install IPFS manually: https://docs.ipfs.tech/install/"
        exit 1
    fi
    echo "✅ Homebrew found"
    
    # Check if IPFS (kubo) is installed
    if ! command -v ipfs &> /dev/null; then
        echo ""
        echo -e "${YELLOW}📦 IPFS not found - installing via Homebrew...${NC}"
        brew install ipfs
        echo -e "${GREEN}✅ IPFS installed${NC}"
    else
        echo "✅ IPFS already installed ($(ipfs --version))"
    fi
    
    # Check if IPFS is initialized
    if [ ! -d "$HOME/.ipfs" ]; then
        echo ""
        echo -e "${YELLOW}🔧 Initializing IPFS repository...${NC}"
        ipfs init
        echo -e "${GREEN}✅ IPFS initialized${NC}"
    fi
    
    # Check if IPFS daemon is already running
    if curl -s --max-time 2 http://localhost:5001/api/v0/id > /dev/null 2>&1; then
        echo "✅ IPFS daemon already running"
        IPFS_STARTED_BY_SCRIPT=false
    else
        echo ""
        echo -e "${YELLOW}🚀 Starting IPFS daemon...${NC}"
        
        # Start daemon in background
        ipfs daemon --enable-gc > /dev/null 2>&1 &
        IPFS_PID=$!
        IPFS_STARTED_BY_SCRIPT=true
        
        # Wait for daemon to be ready (up to 30 seconds)
        echo "   Waiting for daemon to start..."
        for i in {1..30}; do
            if curl -s --max-time 2 http://localhost:5001/api/v0/id > /dev/null 2>&1; then
                echo -e "${GREEN}✅ IPFS daemon started (PID: $IPFS_PID)${NC}"
                break
            fi
            if [ $i -eq 30 ]; then
                echo -e "${RED}❌ IPFS daemon failed to start${NC}"
                exit 1
            fi
            sleep 1
        done
    fi
    
    # Set IPFS URL for the rest of the script
    export IPFS_URL="http://localhost:5001"
    echo ""
    echo "📡 Using local IPFS: $IPFS_URL"
}

# Load environment variables
if [ -f "$SCRIPT_DIR/.env" ]; then
    export $(grep -v '^#' "$SCRIPT_DIR/.env" | xargs)
else
    echo -e "${RED}❌ Error: .env file not found${NC}"
    echo "   Copy .env.example to .env and fill in the values"
    exit 1
fi

# Get environment from argument or .env
ENV="${1:-$DEPLOY_ENV}"
VERSION_OVERRIDE="${2:-}"

if [ -z "$ENV" ]; then
    echo -e "${RED}❌ Error: No environment specified${NC}"
    echo "   Usage: ./deploy.sh [dev|stg|lmn] [version]"
    exit 1
fi

# Generate version from git tags (same logic as CI/CD) or use override
# Uses component-based versioning: indexer-v<semver>[-env]
generate_version() {
    local env=$1
    local component="indexer"
    cd "$REPO_DIR"
    LAST_TAG=$(git tag -l "${component}-v*" 2>/dev/null | sort -V | tail -n 1)
    if [ -z "$LAST_TAG" ]; then
        BASE_VERSION="3.1.0"
    else
        LAST_VERSION=$(echo $LAST_TAG | sed "s/${component}-v//" | sed 's/-.*$//')
        IFS='.' read -r MAJOR MINOR PATCH <<< "$LAST_VERSION"
        PATCH=$((PATCH + 1))
        BASE_VERSION="${MAJOR}.${MINOR}.${PATCH}"
    fi
    echo "v${BASE_VERSION}-${env}"
}

if [ -n "$VERSION_OVERRIDE" ]; then
    VERSION_LABEL="$VERSION_OVERRIDE"
else
    VERSION_LABEL=$(generate_version "$ENV")
fi

echo ""
echo -e "${BLUE}===============================================${NC}"
echo -e "${BLUE}🚀 Graph Seed Script - Hashprice Oracle${NC}"
echo -e "${BLUE}===============================================${NC}"
echo "   Environment: $ENV"
echo "   Version:     $VERSION_LABEL"
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
        echo -e "${RED}❌ Error: Invalid environment '$ENV'${NC}"
        exit 1
        ;;
esac

# Validate required variables
if [ -z "$DEPLOY_KEY" ]; then
    echo -e "${RED}❌ Error: Deploy key not set for $ENV environment${NC}"
    exit 1
fi

echo "📋 Configuration:"
echo "   Subgraph:  $SUBGRAPH_NAME"
echo "   Network:   $NETWORK"

# Setup local IPFS (install if needed, start daemon)
setup_ipfs

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

#############################################
# PHASE 1: Prepare and Build
#############################################
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}📦 PHASE 1: Build Subgraph${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo "⚙️  Preparing subgraph configuration..."
yarn prepare:env

echo ""
echo "🔨 Generating AssemblyScript types..."
yarn codegen

echo ""
echo "🏗️  Building subgraph..."
npx graph build

echo -e "${GREEN}✅ Build complete${NC}"

#############################################
# PHASE 2: Build and Get IPFS Hash
#############################################
# Per The Graph Discord recommendation:
# 1. graph build --ipfs ... (upload to IPFS, get Qm hash)
# 2. graph deploy SLUG --ipfs-hash <hash> (uses hash, skips re-upload)
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}📤 PHASE 2: Upload to IPFS${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Use IPFS_URL from .env, default to The Graph's (rate limited)
IPFS_UPLOAD_URL="${IPFS_URL:-https://api.thegraph.com/ipfs/api/v0}"
IPFS_HASH=""
UPLOAD_SUCCESS=false

echo "📤 Uploading to IPFS..."
echo "   URL: $IPFS_UPLOAD_URL"
if [[ "$IPFS_UPLOAD_URL" == *"localhost"* ]] || [[ "$IPFS_UPLOAD_URL" == *"127.0.0.1"* ]]; then
    echo "   Mode: Local IPFS daemon (will propagate to global network)"
fi
echo ""

# Try to upload to IPFS - capture hash even if it fails partway
# The hash is generated during upload and can be reused with --ipfs-hash
UPLOAD_MAX_ATTEMPTS=3
UPLOAD_ATTEMPT=1

while [ $UPLOAD_ATTEMPT -le $UPLOAD_MAX_ATTEMPTS ]; do
    TIMESTAMP=$(date +%H:%M:%S)
    echo "[$TIMESTAMP] 📤 Attempt $UPLOAD_ATTEMPT of $UPLOAD_MAX_ATTEMPTS..."
    
    set +e
    BUILD_OUTPUT=$(npx graph build --ipfs "$IPFS_UPLOAD_URL" 2>&1)
    BUILD_EXIT=$?
    set -e
    
    echo "$BUILD_OUTPUT"
    
    # Extract IPFS hash from output (looks like: Build completed: QmXXX...)
    # Capture any Qm hash - even from failed uploads (partial success)
    FOUND_HASH=$(echo "$BUILD_OUTPUT" | grep -oE 'Qm[a-zA-Z0-9]{44}' | tail -1)
    
    if [ -n "$FOUND_HASH" ]; then
        IPFS_HASH="$FOUND_HASH"
        echo ""
        echo -e "${GREEN}📦 Got IPFS hash: $IPFS_HASH${NC}"
    fi
    
    if [ $BUILD_EXIT -eq 0 ] && [ -n "$IPFS_HASH" ]; then
        echo -e "${GREEN}✅ Full upload successful!${NC}"
        UPLOAD_SUCCESS=true
        break
    fi
    
    # Check for rate limiting - but we might have gotten a hash!
    if echo "$BUILD_OUTPUT" | grep -q "Too Many Requests"; then
        echo -e "${YELLOW}   ⚠️  Rate limited (HTTP 429)${NC}"
        
        # If we got a hash, we can try deploying with it
        if [ -n "$IPFS_HASH" ]; then
            echo -e "${GREEN}   ✅ But we captured the hash! Will try --ipfs-hash method${NC}"
            UPLOAD_SUCCESS=true
            break
        fi
        
        if [ $UPLOAD_ATTEMPT -lt $UPLOAD_MAX_ATTEMPTS ]; then
            WAIT_TIME=$((60 * UPLOAD_ATTEMPT))
            echo "   ⏳ Waiting ${WAIT_TIME}s before retry..."
            sleep $WAIT_TIME
        fi
    else
        # Other error
        if [ $UPLOAD_ATTEMPT -lt $UPLOAD_MAX_ATTEMPTS ]; then
            sleep 15
        fi
    fi
    
    UPLOAD_ATTEMPT=$((UPLOAD_ATTEMPT + 1))
done

# If we have a hash (even from partial upload), we can proceed
if [ -z "$IPFS_HASH" ]; then
    echo ""
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${RED}❌ Failed to get IPFS hash after $UPLOAD_MAX_ATTEMPTS attempts${NC}"
    echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo "Could not upload to local IPFS."
    echo ""
    echo "🔧 Troubleshooting:"
    echo "   - Check if IPFS daemon is responding: curl http://localhost:5001/api/v0/id"
    echo "   - Try restarting: ipfs shutdown && ipfs daemon"
    echo "   - Check IPFS logs for errors"
    echo ""
    exit 1
fi

echo ""
echo -e "${GREEN}✅ IPFS hash ready: $IPFS_HASH${NC}"

# If using local IPFS, wait for content to propagate to global network
if [[ "$IPFS_UPLOAD_URL" == *"localhost"* ]] || [[ "$IPFS_UPLOAD_URL" == *"127.0.0.1"* ]]; then
    echo ""
    echo -e "${YELLOW}⏳ Waiting for IPFS content to propagate to global network...${NC}"
    echo "   This typically takes 2-5 minutes."
    echo "   Hash: $IPFS_HASH"
    echo ""
    
    # Wait 2 minutes for DHT propagation
    for i in {1..4}; do
        echo "   Waiting... ($((i * 30))s / 120s)"
        sleep 30
    done
    echo -e "${GREEN}✅ Propagation wait complete${NC}"
fi

#############################################
# PHASE 3: Deploy to The Graph Studio
#############################################
# Using --ipfs-hash as recommended by The Graph Discord
# This skips re-uploading and uses the hash directly
echo ""
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${YELLOW}🚀 PHASE 3: Deploy to The Graph Studio${NC}"
echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo "🔐 Authenticating..."
npx graph auth "$DEPLOY_KEY"

echo ""
echo "🚀 Deploying subgraph using --ipfs-hash (skips IPFS upload)..."
echo "   Subgraph: $SUBGRAPH_NAME"
echo "   Version:  $VERSION_LABEL"
echo "   IPFS:     $IPFS_HASH"
echo ""

DEPLOY_MAX_ATTEMPTS=3
DEPLOY_ATTEMPT=1
DEPLOYED=false

while [ $DEPLOY_ATTEMPT -le $DEPLOY_MAX_ATTEMPTS ]; do
    echo "📤 Deploy attempt $DEPLOY_ATTEMPT of $DEPLOY_MAX_ATTEMPTS..."
    
    set +e
    DEPLOY_OUTPUT=$(npx graph deploy "$SUBGRAPH_NAME" \
        --node https://api.studio.thegraph.com/deploy/ \
        --ipfs-hash "$IPFS_HASH" \
        --version-label "$VERSION_LABEL" 2>&1)
    DEPLOY_EXIT=$?
    set -e
    
    echo "$DEPLOY_OUTPUT"
    
    # Check for success
    if [ $DEPLOY_EXIT -eq 0 ]; then
        DEPLOYED=true
        break
    fi
    
    # Check for "version already exists" - treat as success
    if echo "$DEPLOY_OUTPUT" | grep -q "Version label already exists"; then
        echo ""
        echo -e "${GREEN}✅ Version $VERSION_LABEL already deployed - no update needed${NC}"
        DEPLOYED=true
        break
    fi
    
    # Check for rate limiting
    if echo "$DEPLOY_OUTPUT" | grep -q "Too Many Requests"; then
        WAIT_TIME=$((60 * DEPLOY_ATTEMPT))
        echo ""
        echo -e "${YELLOW}⚠️  Rate limited. Waiting ${WAIT_TIME}s...${NC}"
        sleep $WAIT_TIME
    else
        echo -e "${RED}❌ Deploy failed${NC}"
    fi
    
    DEPLOY_ATTEMPT=$((DEPLOY_ATTEMPT + 1))
done

if [ "$DEPLOYED" = false ]; then
    echo ""
    echo -e "${RED}❌ All deployment attempts failed${NC}"
    echo ""
    echo "🔧 Troubleshooting:"
    echo "   - IPFS hash: $IPFS_HASH"
    echo "   - Try again in a few minutes"
    echo "   - Check The Graph Studio for status"
    exit 1
fi

#############################################
# SUCCESS
#############################################
echo ""
echo -e "${GREEN}===============================================${NC}"
echo -e "${GREEN}✅ Deployment Successful!${NC}"
echo -e "${GREEN}===============================================${NC}"
echo ""
echo "📊 View your subgraph:"
echo "   Studio: https://thegraph.com/studio/subgraph/$SUBGRAPH_NAME/"
echo ""
echo "🔍 Once synced, the query URL will be visible in Studio"
echo "   (Look for the User ID in the query URL to update GitHub vars)"
echo ""
echo "📝 IPFS Hash: $IPFS_HASH"
echo ""
