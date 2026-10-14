"""
Goldsky Subgraph Health Monitor Lambda
Queries Goldsky public GraphQL endpoints for health and data freshness.

Monitors the hashprice oracle subgraph on Goldsky:
- Availability: Did the endpoint respond?
- Response time: How long did the query take?
- hasIndexingErrors: Has the subgraph encountered errors?
- Data freshness: How old is the latest indexed block (seconds)?
- Drift: chain head minus the block Goldsky is serving. A null timestamp is filled from that block so a catch-up is not recorded as fresh.

Uses deployment hash as tracking key (first4...last3) to detect subgraph updates.
Subgraph URLs are passed as environment variables from Terraform (var.gs_subgraphs).
"""

import urllib.request
import json
import boto3
import os
import time
from datetime import datetime

# Oracle subgraph URL from the environment (public Goldsky endpoint).
GS_ORACLES_URL = os.environ.get("GS_ORACLES_URL", "")

CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "HashpriceOracle")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")
CHAIN_ID = int(os.environ.get("CHAIN_ID", "0") or "0")

# Public endpoints. The monitor must not carry an Alchemy key.
PUBLIC_RPC = {
    8453: (
        "https://mainnet.base.org",
        "https://base-rpc.publicnode.com",
    ),
    84532: (
        "https://sepolia.base.org",
        "https://base-sepolia-rpc.publicnode.com",
    ),
}

cloudwatch = boto3.client("cloudwatch")

META_QUERY = """
{
  _meta {
    block {
      number
      timestamp
    }
    deployment
    hasIndexingErrors
  }
}
"""

def shorten_deployment(deployment):
    """Create shortened deployment key: first4...last3"""
    if not deployment or len(deployment) < 8:
        return deployment or "unknown"
    return f"{deployment[:4]}...{deployment[-3:]}"


def query_subgraph(url, query):
    """Execute a GraphQL query against a subgraph endpoint.

    Returns:
        tuple: (result_dict, response_time_ms) or (None, response_time_ms) on error
    """
    start_time = time.time()
    try:
        data = json.dumps({"query": query}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "HPO-SubgraphMonitor/2.0",
                "Accept": "application/json",
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            result = json.loads(response.read().decode("utf-8"))
            response_time_ms = int((time.time() - start_time) * 1000)
            return result, response_time_ms
    except Exception as e:
        response_time_ms = int((time.time() - start_time) * 1000)
        print(f"Error querying subgraph: {e}")
        return None, response_time_ms


def rpc(method, params):
    """JSON-RPC against a public Base endpoint. Returns the result or None."""
    urls = PUBLIC_RPC.get(CHAIN_ID, ())
    if not urls:
        print(f"    no public RPC for chain {CHAIN_ID}")
        return None
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode("utf-8")
    last = None
    for url in urls:
        try:
            req = urllib.request.Request(
                url,
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "HPO-SubgraphMonitor/2.0",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=20) as response:
                body = json.loads(response.read().decode("utf-8"))
            if body.get("error"):
                last = body["error"]
                continue
            return body.get("result")
        except Exception as exc:
            last = exc
            print(f"    rpc {method} failed: {exc}")
    print(f"    rpc {method} unavailable: {last}")
    return None


def chain_head():
    result = rpc("eth_blockNumber", [])
    if not result:
        return 0
    try:
        return int(result, 16)
    except (TypeError, ValueError):
        return 0


def block_timestamp(number):
    result = rpc("eth_getBlockByNumber", [hex(number), False])
    if not isinstance(result, dict):
        return 0
    raw = result.get("timestamp")
    if not raw:
        return 0
    try:
        return int(raw, 16)
    except (TypeError, ValueError):
        return 0


def push_to_cloudwatch(metric_data):
    """Push metrics to CloudWatch in batches of 20."""
    if not metric_data:
        return

    for i in range(0, len(metric_data), 20):
        batch = metric_data[i:i+20]
        try:
            cloudwatch.put_metric_data(
                Namespace=CW_NAMESPACE,
                MetricData=batch
            )
            print(f"Pushed {len(batch)} metrics to CloudWatch")
        except Exception as e:
            print(f"Error pushing metrics to CloudWatch: {e}")


def check_subgraph(name, url, metric_data):
    """Check a single subgraph and add metrics.

    Args:
        name: Subgraph name ("oracles")
        url: Full Goldsky public GraphQL URL
        metric_data: List to append metrics to

    Returns:
        dict: Status summary for this subgraph
    """
    if not url:
        print(f"  {name}: No URL configured, skipping")
        return None

    print(f"  Checking {name}: {url}")

    result, response_time_ms = query_subgraph(url, META_QUERY)

    subgraph_dimensions = [
        {"Name": "Environment", "Value": ENVIRONMENT},
        {"Name": "Subgraph", "Value": name},
    ]

    if result is None:
        print(f"    FAILED: No response (took {response_time_ms}ms)")
        metric_data.append({
            "MetricName": "subgraph_available",
            "Value": 0,
            "Unit": "Count",
            "Dimensions": subgraph_dimensions
        })
        metric_data.append({
            "MetricName": "subgraph_response_time_ms",
            "Value": response_time_ms,
            "Unit": "Milliseconds",
            "Dimensions": subgraph_dimensions
        })
        return {"name": name, "available": False, "response_time_ms": response_time_ms, "deployment_key": "unknown"}

    if "errors" in result:
        print(f"    ERROR: GraphQL errors: {result['errors']}")
        metric_data.append({
            "MetricName": "subgraph_available",
            "Value": 0,
            "Unit": "Count",
            "Dimensions": subgraph_dimensions
        })
        metric_data.append({
            "MetricName": "subgraph_response_time_ms",
            "Value": response_time_ms,
            "Unit": "Milliseconds",
            "Dimensions": subgraph_dimensions
        })
        return {"name": name, "available": False, "response_time_ms": response_time_ms, "deployment_key": "error", "errors": result["errors"]}

    meta = result.get("data", {}).get("_meta", {})
    block = meta.get("block") or {}
    try:
        indexed_block = int(block.get("number")) if block.get("number") is not None else 0
    except (TypeError, ValueError):
        indexed_block = 0
    # Goldsky may return JSON null for block.timestamp while a deployment is catching up.
    raw_ts = block.get("timestamp")
    try:
        indexed_timestamp = int(raw_ts) if raw_ts is not None else 0
    except (TypeError, ValueError):
        indexed_timestamp = 0
    deployment = meta.get("deployment", "unknown")
    has_indexing_errors = meta.get("hasIndexingErrors", False)

    deployment_key = shorten_deployment(deployment)

    head = chain_head()
    blocks_behind = max(0, head - indexed_block) if head > 0 and indexed_block > 0 else None
    if indexed_timestamp <= 0 and indexed_block > 0:
        indexed_timestamp = block_timestamp(indexed_block)
    data_age_seconds = (
        max(0, int(time.time()) - indexed_timestamp) if indexed_timestamp > 0 else None
    )

    print(
        f"    OK: deployment={deployment_key}, indexed={indexed_block}, head={head}, "
        f"behind={blocks_behind}, age={data_age_seconds}s, errors={has_indexing_errors}, "
        f"took {response_time_ms}ms"
    )

    metric_data.append({
        "MetricName": "subgraph_available",
        "Value": 1,
        "Unit": "Count",
        "Dimensions": subgraph_dimensions
    })

    metric_data.append({
        "MetricName": "subgraph_response_time_ms",
        "Value": response_time_ms,
        "Unit": "Milliseconds",
        "Dimensions": subgraph_dimensions
    })

    metric_data.append({
        "MetricName": "subgraph_indexing_errors",
        "Value": 1 if has_indexing_errors else 0,
        "Unit": "Count",
        "Dimensions": subgraph_dimensions
    })

    if data_age_seconds is not None:
        metric_data.append({
            "MetricName": "subgraph_data_age_seconds",
            "Value": data_age_seconds,
            "Unit": "Seconds",
            "Dimensions": subgraph_dimensions
        })

    if blocks_behind is not None:
        metric_data.append({
            "MetricName": "subgraph_blocks_behind",
            "Value": blocks_behind,
            "Unit": "Count",
            "Dimensions": subgraph_dimensions
        })

    return {
        "name": name,
        "available": True,
        "deployment_key": deployment_key,
        "deployment_full": deployment,
        "response_time_ms": response_time_ms,
        "data_age_seconds": data_age_seconds,
        "blocks_behind": blocks_behind,
        "has_indexing_errors": has_indexing_errors,
    }


def lambda_handler(event, context):
    """Lambda handler - query Goldsky subgraphs and push health metrics."""
    print(f"Starting Goldsky Subgraph Health Monitor at {datetime.now().isoformat()}")
    print(f"Environment: {ENVIRONMENT}")

    metric_data = []
    results = []

    subgraphs = [
        ("oracles", GS_ORACLES_URL),
    ]

    for name, url in subgraphs:
        result = check_subgraph(name, url, metric_data)
        if result:
            results.append(result)

    # Aggregate metrics across all subgraphs
    if results:
        aggregate_dimensions = [{"Name": "Environment", "Value": ENVIRONMENT}]

        total_checked = len(results)
        available_count = sum(1 for r in results if r.get("available"))
        error_count = sum(1 for r in results if r.get("has_indexing_errors"))
        avg_response_time = sum(r.get("response_time_ms", 0) for r in results) / total_checked
        max_data_age = max(
            (r["data_age_seconds"] for r in results if r.get("available") and r.get("data_age_seconds") is not None),
            default=0,
        )

        metric_data.append({
            "MetricName": "subgraphs_available",
            "Value": available_count,
            "Unit": "Count",
            "Dimensions": aggregate_dimensions
        })

        metric_data.append({
            "MetricName": "subgraphs_with_errors",
            "Value": error_count,
            "Unit": "Count",
            "Dimensions": aggregate_dimensions
        })

        metric_data.append({
            "MetricName": "subgraph_avg_response_time_ms",
            "Value": round(avg_response_time, 2),
            "Unit": "Milliseconds",
            "Dimensions": aggregate_dimensions
        })

        metric_data.append({
            "MetricName": "subgraph_max_data_age_seconds",
            "Value": max_data_age,
            "Unit": "Seconds",
            "Dimensions": aggregate_dimensions
        })

    push_to_cloudwatch(metric_data)

    print(f"Completed - pushed {len(metric_data)} metrics")
    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "Goldsky subgraph health check completed",
            "subgraphs_checked": len(results),
            "results": results,
            "metrics_pushed": len(metric_data)
        })
    }
