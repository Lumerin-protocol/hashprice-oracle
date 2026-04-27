"""
Oracle Staleness Check Lambda

Queries the on-chain HashpriceBTC oracle (Chainlink AggregatorV3 interface)
to check data freshness. Pushes the age of the latest round to CloudWatch
for alarming.

ABI (relevant subset):
  function latestRoundData() view returns (
      uint80  roundId,
      int256  answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80  answeredInRound
  );
  function decimals() view returns (uint8);
"""

import json
import os
import time
from datetime import datetime, timezone
import urllib.request

import boto3

HASHPRICE_BTC_ADDRESS = os.environ.get("HASHPRICE_BTC_ADDRESS", "").lower()
ETH_RPC_URL = os.environ.get("ETH_RPC_URL", "")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "HashpriceOracle")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")
MAX_AGE_MINUTES = int(os.environ.get("MAX_AGE_MINUTES", "30"))

cloudwatch = boto3.client("cloudwatch")

# 4-byte function selectors (keccak256(signature)[:4])
LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c"  # latestRoundData()
DECIMALS_SELECTOR = "0x313ce567"           # decimals()

# Lower 80 bits mask for uint80 fields returned by latestRoundData
UINT80_MASK = (1 << 80) - 1


def eth_call(to_address: str, data: str):
    """Make an eth_call to the configured RPC endpoint. Returns the raw
    hex string ('0x...') on success, None on RPC error or transport failure."""
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
            print(f"RPC error: {result['error']}")
            return None
        return result.get("result")
    except Exception as e:
        print(f"Transport error calling RPC: {e}")
        return None


def parse_int256(hex64: str) -> int:
    """Parse a 64-char hex string as a signed int256."""
    n = int(hex64, 16)
    if n >= (1 << 255):
        n -= 1 << 256
    return n


def get_latest_round():
    """
    Call latestRoundData() on HashpriceBTC.
    Returns dict { round_id, answer, started_at, updated_at, answered_in_round }
    or None on failure.
    """
    raw = eth_call(HASHPRICE_BTC_ADDRESS, LATEST_ROUND_DATA_SELECTOR)
    if not raw or raw == "0x":
        print("Empty result from latestRoundData()")
        return None
    body = raw[2:]
    # Five 32-byte ABI-encoded slots = 5 * 64 = 320 hex chars
    if len(body) < 320:
        print(f"Unexpected latestRoundData length: {len(body)} (expected >= 320)")
        return None
    try:
        return {
            # round_id and answered_in_round are uint80 right-padded into uint256 slots
            "round_id": int(body[0:64], 16) & UINT80_MASK,
            "answer": parse_int256(body[64:128]),
            "started_at": int(body[128:192], 16),
            "updated_at": int(body[192:256], 16),
            "answered_in_round": int(body[256:320], 16) & UINT80_MASK,
        }
    except Exception as e:
        print(f"Error parsing latestRoundData: {e}")
        return None


def get_decimals() -> int:
    """Call decimals() on HashpriceBTC. Returns the uint8 value, or 0 on failure
    (caller should treat 0 as "unknown" and skip normalization)."""
    raw = eth_call(HASHPRICE_BTC_ADDRESS, DECIMALS_SELECTOR)
    if not raw or raw == "0x":
        return 0
    try:
        return int(raw[2:], 16) & 0xFF
    except Exception as e:
        print(f"Error parsing decimals: {e}")
        return 0


def push_to_cloudwatch(metric_data):
    try:
        cloudwatch.put_metric_data(Namespace=CW_NAMESPACE, MetricData=metric_data)
        print(f"Pushed {len(metric_data)} metrics to CloudWatch")
    except Exception as e:
        print(f"Error pushing metrics to CloudWatch: {e}")


def lambda_handler(event, context):
    print(f"Starting oracle staleness check at {datetime.now(timezone.utc).isoformat()}")
    print(f"Oracle address: {HASHPRICE_BTC_ADDRESS}")
    print(f"RPC URL: {ETH_RPC_URL[:50]}..." if ETH_RPC_URL else "RPC URL: NOT SET")
    print(f"Max age threshold: {MAX_AGE_MINUTES} minutes")

    if not HASHPRICE_BTC_ADDRESS or not ETH_RPC_URL:
        print("Missing required environment variables")
        return {"statusCode": 500, "body": "Missing configuration"}

    round_data = get_latest_round()
    if not round_data:
        push_to_cloudwatch([{
            "MetricName": "oracle_staleness_check_failed",
            "Value": 1,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}],
        }])
        return {"statusCode": 500, "body": "Failed to read latestRoundData"}

    decimals = get_decimals()
    raw_answer = round_data["answer"]
    answer_normalized = (raw_answer / (10 ** decimals)) if decimals > 0 else float(raw_answer)

    current_time = int(time.time())
    updated_at = round_data["updated_at"]
    age_seconds = current_time - updated_at
    age_minutes = age_seconds / 60
    is_stale = age_minutes > MAX_AGE_MINUTES

    print("Oracle data (latestRoundData):")
    print(f"  Round ID:           {round_data['round_id']}")
    print(f"  Answered in round:  {round_data['answered_in_round']}")
    print(f"  Answer (raw):       {raw_answer}")
    print(f"  Decimals:           {decimals if decimals > 0 else 'unknown'}")
    if decimals > 0:
        print(f"  Answer (normalized): {answer_normalized}")
    print(f"  Updated at:         {datetime.fromtimestamp(updated_at, tz=timezone.utc).isoformat()}")
    print(f"  Age:                {age_minutes:.2f} minutes ({age_seconds} seconds)")
    if is_stale:
        print(f"WARNING: Oracle data is STALE (age > {MAX_AGE_MINUTES} min)")
    else:
        print(f"Oracle data is fresh (age <= {MAX_AGE_MINUTES} min)")

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
            "Unit": "None",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}],
        },
        {
            "MetricName": "oracle_latest_round",
            "Value": float(round_data["round_id"]),
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
        "body": json.dumps({
            "message": "Oracle staleness check completed",
            "round_id": round_data["round_id"],
            "answer_normalized": answer_normalized,
            "decimals": decimals,
            "updated_at": updated_at,
            "age_minutes": age_minutes,
            "is_stale": is_stale,
        }),
    }
