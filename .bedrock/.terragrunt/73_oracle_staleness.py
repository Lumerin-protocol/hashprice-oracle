"""
Oracle Staleness Check Lambda
Queries the on-chain hashrate oracle contract to check data freshness.
Pushes the age of the oracle data to CloudWatch for alarming.

The HashrateOracle contract has getHashesForBTC() which returns (value, updatedAt, ttl).
"""

import json
import boto3
import os
import time
from datetime import datetime
import urllib.request

# Environment variables
HASHRATE_ORACLE_ADDRESS = os.environ.get("HASHRATE_ORACLE_ADDRESS", "")
ETH_RPC_URL = os.environ.get("ETH_RPC_URL", "")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "HashpriceOracle")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")
MAX_AGE_MINUTES = int(os.environ.get("MAX_AGE_MINUTES", "30"))

# CloudWatch client
cloudwatch = boto3.client("cloudwatch")

# HashrateOracle ABI function selectors
# getHashesForBTC() returns (uint256 value, uint256 updatedAt, uint256 ttl)
GET_HASHES_FOR_BTC_SELECTOR = "0x19e26291"  # keccak256("getHashesForBTC()")[:4]


def eth_call(to_address, data):
    """Make an eth_call to the RPC endpoint."""
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_call",
        "params": [
            {
                "to": to_address,
                "data": data
            },
            "latest"
        ],
        "id": 1
    }
    
    headers = {
        "Content-Type": "application/json"
    }
    
    req = urllib.request.Request(
        ETH_RPC_URL,
        data=json.dumps(payload).encode('utf-8'),
        headers=headers,
        method='POST'
    )
    
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode('utf-8'))
            if "error" in result:
                print(f"RPC Error: {result['error']}")
                return None
            return result.get("result")
    except Exception as e:
        print(f"Error calling RPC: {e}")
        return None


def get_hashes_for_btc():
    """
    Call getHashesForBTC() on the HashrateOracle contract.
    Returns struct: { value, updatedAt, ttl }
    """
    result = eth_call(HASHRATE_ORACLE_ADDRESS, GET_HASHES_FOR_BTC_SELECTOR)
    
    if not result or result == "0x":
        print("Empty result from getHashesForBTC()")
        return None
    
    # Remove 0x prefix
    result = result[2:]
    
    # getHashesForBTC returns a tuple of 3 uint256 values (each 32 bytes = 64 hex chars)
    if len(result) < 192:  # 3 * 64 = 192
        print(f"Unexpected result length: {len(result)}, expected at least 192")
        return None
    
    try:
        value = int(result[0:64], 16)
        updated_at = int(result[64:128], 16)
        ttl = int(result[128:192], 16)
        
        return {
            "value": value,
            "updated_at": updated_at,
            "ttl": ttl
        }
    except Exception as e:
        print(f"Error parsing result: {e}")
        return None


def push_to_cloudwatch(metric_data):
    """Push metrics to CloudWatch."""
    try:
        cloudwatch.put_metric_data(
            Namespace=CW_NAMESPACE,
            MetricData=metric_data
        )
        print(f"Pushed {len(metric_data)} metrics to CloudWatch")
    except Exception as e:
        print(f"Error pushing metrics to CloudWatch: {e}")


def lambda_handler(event, context):
    """Lambda handler - check oracle staleness."""
    print(f"Starting Oracle staleness check at {datetime.now().isoformat()}")
    print(f"Oracle address: {HASHRATE_ORACLE_ADDRESS}")
    print(f"RPC URL: {ETH_RPC_URL[:50]}..." if ETH_RPC_URL else "RPC URL: NOT SET")
    print(f"Max age threshold: {MAX_AGE_MINUTES} minutes")
    
    if not HASHRATE_ORACLE_ADDRESS or not ETH_RPC_URL:
        print("Missing required environment variables")
        return {"statusCode": 500, "body": "Missing configuration"}
    
    # Get hashrate data from oracle using getHashesForBTC()
    data = get_hashes_for_btc()
    
    if not data:
        print("Failed to get oracle data from getHashesForBTC()")
        # Push error metric
        push_to_cloudwatch([{
            "MetricName": "oracle_staleness_check_failed",
            "Value": 1,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        }])
        return {"statusCode": 500, "body": "Failed to get oracle data"}
    
    # Calculate age in minutes
    current_time = int(time.time())
    updated_at = data["updated_at"]
    age_seconds = current_time - updated_at
    age_minutes = age_seconds / 60
    
    # TTL of max uint256 means "infinite" / no expiry set
    MAX_UINT256 = 2**256 - 1
    ttl_is_infinite = data["ttl"] >= MAX_UINT256 - 1000  # Account for rounding
    ttl_seconds = data["ttl"] if not ttl_is_infinite else 0
    ttl_minutes = ttl_seconds / 60 if not ttl_is_infinite else 0
    
    print(f"Oracle data (getHashesForBTC):")
    print(f"  Value (hashes/BTC): {data['value']:,}")
    print(f"  Updated At: {datetime.fromtimestamp(updated_at).isoformat()}")
    print(f"  TTL: {'infinite (max uint256)' if ttl_is_infinite else f'{ttl_minutes:.1f} minutes ({ttl_seconds} seconds)'}")
    print(f"  Age: {age_minutes:.2f} minutes ({age_seconds} seconds)")
    
    # Check staleness - exceeds our threshold (ignore TTL if infinite)
    is_stale = age_minutes > MAX_AGE_MINUTES
    if not ttl_is_infinite and age_seconds > ttl_seconds:
        is_stale = True
    if is_stale:
        print(f"WARNING: Oracle data is STALE (age > {MAX_AGE_MINUTES} min or > TTL)")
    else:
        print(f"Oracle data is fresh (age < {MAX_AGE_MINUTES} min and within TTL)")
    
    # Push metrics to CloudWatch
    metric_data = [
        {
            "MetricName": "oracle_data_age_minutes",
            "Value": age_minutes,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        },
        {
            "MetricName": "oracle_data_age_seconds",
            "Value": age_seconds,
            "Unit": "Seconds",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        },
        {
            "MetricName": "oracle_is_stale",
            "Value": 1 if is_stale else 0,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        },
        {
            "MetricName": "oracle_hashes_for_btc",
            "Value": float(data["value"]),
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        },
        {
            "MetricName": "oracle_ttl_seconds",
            "Value": float(ttl_seconds),  # 0 if infinite
            "Unit": "Seconds",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        },
        {
            "MetricName": "oracle_staleness_check_success",
            "Value": 1,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        }
    ]
    
    push_to_cloudwatch(metric_data)
    
    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "Oracle staleness check completed",
            "age_minutes": age_minutes,
            "ttl_minutes": ttl_minutes,
            "is_stale": is_stale,
            "hashes_for_btc": data["value"]
        })
    }
