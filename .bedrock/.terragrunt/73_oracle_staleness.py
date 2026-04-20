"""
Oracle Staleness Check Lambda

Queries the on-chain HashpriceBTC trustless oracle to check data freshness.
HashpriceBTC implements the Chainlink AggregatorV3 interface:

    function latestRoundData() external view
        returns (uint80 roundId, int256 answer, uint256 startedAt,
                 uint256 updatedAt, uint80 answeredInRound);

`updatedAt` is the EVM block.timestamp when the keeper last submitted a block.
This Lambda pushes its age (seconds / minutes) to CloudWatch so alarms can
fire if the keeper stalls.
"""

import json
import os
import time
from datetime import datetime
import urllib.request

import boto3

# --- Environment configuration ---------------------------------------------
HASHPRICE_BTC_ADDRESS = os.environ.get("HASHPRICE_BTC_ADDRESS", "")
ETH_RPC_URL = os.environ.get("ETH_RPC_URL", "")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "HashpriceOracle")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")
MAX_AGE_MINUTES = int(os.environ.get("MAX_AGE_MINUTES", "30"))

# --- ABI function selectors (Chainlink AggregatorV3) -----------------------
# keccak256("latestRoundData()")[:4]
LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c"
# keccak256("decimals()")[:4]
DECIMALS_SELECTOR = "0x313ce567"

cloudwatch = boto3.client("cloudwatch")


def eth_call(to_address: str, data: str):
    """Minimal JSON-RPC eth_call at the 'latest' block."""
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_call",
        "params": [{"to": to_address, "data": data}, "latest"],
        "id": 1,
    }
    req = urllib.request.Request(
        ETH_RPC_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            if "error" in result:
                print(f"RPC Error: {result['error']}")
                return None
            return result.get("result")
    except Exception as e:
        print(f"Error calling RPC: {e}")
        return None


def _parse_int256(hex_chunk: str) -> int:
    """Parse a 32-byte hex chunk as a signed int256."""
    val = int(hex_chunk, 16)
    if val >= 2**255:
        val -= 2**256
    return val


def get_latest_round_data():
    """
    Call latestRoundData() on the HashpriceBTC contract.
    Returns the decoded tuple or None on failure.
    """
    result = eth_call(HASHPRICE_BTC_ADDRESS, LATEST_ROUND_DATA_SELECTOR)

    if not result or result == "0x":
        print("Empty result from latestRoundData()")
        return None

    result = result[2:]  # drop 0x

    # 5 × 32-byte words = 320 hex chars: roundId, answer, startedAt, updatedAt, answeredInRound
    if len(result) < 320:
        print(f"Unexpected result length: {len(result)}, expected at least 320")
        return None

    try:
        round_id = int(result[0:64], 16)
        answer = _parse_int256(result[64:128])
        started_at = int(result[128:192], 16)
        updated_at = int(result[192:256], 16)
        answered_in_round = int(result[256:320], 16)
        return {
            "round_id": round_id,
            "answer": answer,
            "started_at": started_at,
            "updated_at": updated_at,
            "answered_in_round": answered_in_round,
        }
    except Exception as e:
        print(f"Error parsing latestRoundData result: {e}")
        return None


def get_decimals():
    """Read decimals() off the contract; default to 8 (Chainlink default) on failure."""
    result = eth_call(HASHPRICE_BTC_ADDRESS, DECIMALS_SELECTOR)
    if not result or result == "0x":
        return 8
    try:
        return int(result[2:], 16)
    except Exception:
        return 8


def push_to_cloudwatch(metric_data):
    try:
        cloudwatch.put_metric_data(Namespace=CW_NAMESPACE, MetricData=metric_data)
        print(f"Pushed {len(metric_data)} metrics to CloudWatch")
    except Exception as e:
        print(f"Error pushing metrics to CloudWatch: {e}")


def lambda_handler(event, context):
    print(f"Starting HashpriceBTC staleness check at {datetime.now().isoformat()}")
    print(f"Oracle address: {HASHPRICE_BTC_ADDRESS}")
    print(f"RPC URL: {ETH_RPC_URL[:50]}..." if ETH_RPC_URL else "RPC URL: NOT SET")
    print(f"Max age threshold: {MAX_AGE_MINUTES} minutes")

    if not HASHPRICE_BTC_ADDRESS or not ETH_RPC_URL:
        print("Missing required environment variables")
        return {"statusCode": 500, "body": "Missing configuration"}

    data = get_latest_round_data()

    if not data:
        print("Failed to get oracle data from latestRoundData()")
        push_to_cloudwatch(
            [
                {
                    "MetricName": "oracle_staleness_check_failed",
                    "Value": 1,
                    "Unit": "Count",
                    "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}],
                }
            ]
        )
        return {"statusCode": 500, "body": "Failed to get oracle data"}

    decimals = get_decimals()

    current_time = int(time.time())
    updated_at = data["updated_at"]
    age_seconds = current_time - updated_at
    age_minutes = age_seconds / 60

    # Normalized answer in USD (e.g. 8-decimal Chainlink value → float)
    answer_normalized = data["answer"] / (10**decimals) if decimals else float(data["answer"])

    print("HashpriceBTC latestRoundData:")
    print(f"  Round: {data['round_id']} (answered in {data['answered_in_round']})")
    print(f"  Answer: {data['answer']} (normalized: {answer_normalized})")
    print(f"  Started At: {datetime.fromtimestamp(data['started_at']).isoformat()}")
    print(f"  Updated At: {datetime.fromtimestamp(updated_at).isoformat()}")
    print(f"  Age: {age_minutes:.2f} minutes ({age_seconds} seconds)")

    is_stale = age_minutes > MAX_AGE_MINUTES
    if is_stale:
        print(f"WARNING: Oracle data is STALE (age > {MAX_AGE_MINUTES} min)")
    else:
        print(f"Oracle data is fresh (age < {MAX_AGE_MINUTES} min)")

    metric_data = [
        {
            "MetricName": "oracle_data_age_minutes",
            "Value": age_minutes,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}],
        },
        {
            "MetricName": "oracle_data_age_seconds",
            "Value": age_seconds,
            "Unit": "Seconds",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}],
        },
        {
            "MetricName": "oracle_is_stale",
            "Value": 1 if is_stale else 0,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}],
        },
        {
            "MetricName": "oracle_latest_answer",
            "Value": float(answer_normalized),
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}],
        },
        {
            "MetricName": "oracle_latest_round",
            "Value": float(data["round_id"]),
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}],
        },
        {
            "MetricName": "oracle_staleness_check_success",
            "Value": 1,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}],
        },
    ]

    push_to_cloudwatch(metric_data)

    return {
        "statusCode": 200,
        "body": json.dumps(
            {
                "message": "Oracle staleness check completed",
                "age_minutes": age_minutes,
                "is_stale": is_stale,
                "answer": answer_normalized,
                "round_id": data["round_id"],
            }
        ),
    }
