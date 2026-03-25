"""
Goldsky Subgraph Health Monitor Lambda
Queries Goldsky public GraphQL endpoints for health and data freshness.

Monitors subgraphs hosted on Goldsky:
- Availability: Did the endpoint respond?
- Response time: How long did the query take?
- hasIndexingErrors: Has the subgraph encountered errors?
- Data freshness: How old is the latest indexed block (seconds)?

Uses deployment hash as tracking key (first4...last3) to detect subgraph updates.
Subgraph URLs are passed as environment variables from Terraform (var.gs_subgraphs).
"""

import urllib.request
import json
import boto3
import os
import time
from datetime import datetime

# Subgraph URLs from environment (public Goldsky endpoints — no auth required)
GS_FUTURES_URL = os.environ.get("GS_FUTURES_URL", "")
GS_ORACLES_URL = os.environ.get("GS_ORACLES_URL", "")
GS_DERIVATIVES_URL = os.environ.get("GS_DERIVATIVES_URL", "")

CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "HashpriceOracle")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")

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

# Entity count queries for futures subgraph
FUTURES_ENTITY_QUERY_V1 = """
{
  futures_collection(first: 1000) { id }
  participants(first: 1000) { id }
  positions(first: 1000) { id }
}
"""

FUTURES_ENTITY_QUERY_V2 = """
{
  futures(first: 1000) { id }
  participants(first: 1000) { id }
  positions(first: 1000) { id }
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


def query_futures_entity_counts(url):
    """Query entity counts from futures subgraph.

    Tries both schema variants (futures_collection for prod, futures for dev).
    Returns dict with entity counts or None on error.
    """
    result, _ = query_subgraph(url, FUTURES_ENTITY_QUERY_V1)
    if result and "data" in result and result["data"]:
        data = result["data"]
        if "futures_collection" in data:
            return {
                "futures": len(data.get("futures_collection") or []),
                "participants": len(data.get("participants") or []),
                "positions": len(data.get("positions") or []),
            }

    result, _ = query_subgraph(url, FUTURES_ENTITY_QUERY_V2)
    if result and "data" in result and result["data"]:
        data = result["data"]
        if "futures" in data:
            return {
                "futures": len(data.get("futures") or []),
                "participants": len(data.get("participants") or []),
                "positions": len(data.get("positions") or []),
            }

    return None


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
        name: Subgraph name (e.g., "futures", "oracles", "derivatives")
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
    block = meta.get("block", {})
    block_timestamp = block.get("timestamp", 0)
    deployment = meta.get("deployment", "unknown")
    has_indexing_errors = meta.get("hasIndexingErrors", False)

    deployment_key = shorten_deployment(deployment)

    current_timestamp = int(time.time())
    data_age_seconds = current_timestamp - block_timestamp if block_timestamp > 0 else 0

    print(f"    OK: deployment={deployment_key}, age={data_age_seconds}s, errors={has_indexing_errors}, took {response_time_ms}ms")

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

    metric_data.append({
        "MetricName": "subgraph_data_age_seconds",
        "Value": data_age_seconds,
        "Unit": "Seconds",
        "Dimensions": subgraph_dimensions
    })

    # Entity counts (futures subgraph only)
    entity_counts = None
    if name == "futures":
        entity_counts = query_futures_entity_counts(url)
        if entity_counts:
            print(f"    Entities: futures={entity_counts['futures']}, participants={entity_counts['participants']}, positions={entity_counts['positions']}")
            for entity_name, count in entity_counts.items():
                metric_data.append({
                    "MetricName": "subgraph_entity_count",
                    "Value": count,
                    "Unit": "Count",
                    "Dimensions": [
                        {"Name": "Environment", "Value": ENVIRONMENT},
                        {"Name": "Subgraph", "Value": name},
                        {"Name": "Entity", "Value": entity_name},
                    ]
                })

    return {
        "name": name,
        "available": True,
        "deployment_key": deployment_key,
        "deployment_full": deployment,
        "response_time_ms": response_time_ms,
        "data_age_seconds": data_age_seconds,
        "has_indexing_errors": has_indexing_errors,
        "entity_counts": entity_counts
    }


def lambda_handler(event, context):
    """Lambda handler - query Goldsky subgraphs and push health metrics."""
    print(f"Starting Goldsky Subgraph Health Monitor at {datetime.now().isoformat()}")
    print(f"Environment: {ENVIRONMENT}")

    metric_data = []
    results = []

    subgraphs = [
        ("futures", GS_FUTURES_URL),
        ("oracles", GS_ORACLES_URL),
        ("derivatives", GS_DERIVATIVES_URL),
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
        max_data_age = max((r.get("data_age_seconds", 0) for r in results if r.get("available")), default=0)

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
