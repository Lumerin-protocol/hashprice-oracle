"""
TheGraph Subgraph Health Monitor Lambda
Queries TheGraph Gateway production endpoints for health and data freshness.

Monitors external TheGraph hosted subgraphs via the Gateway API:
- Availability: Did the endpoint respond?
- Response time: How long did the query take?
- hasIndexingErrors: Has the subgraph encountered errors?
- Data freshness: How old is the latest indexed block (seconds)?

Uses deployment hash as tracking key (first4...last3) to detect subgraph updates.
Uses API key from AWS Secrets Manager for authenticated Gateway access.
"""

import urllib.request
import json
import boto3
import os
import time
from datetime import datetime

# Environment variables
THEGRAPH_GATEWAY_BASE = os.environ.get("THEGRAPH_GATEWAY_BASE", "https://gateway.thegraph.com/api")
THEGRAPH_SECRET_ARN = os.environ.get("THEGRAPH_SECRET_ARN", "")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "HashpriceOracle")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")

# AWS clients
cloudwatch = boto3.client("cloudwatch")
secrets_client = boto3.client("secretsmanager")

# Cache for secrets (avoid fetching on every invocation within same Lambda container)
_secrets_cache = {"data": None, "expires": 0}

# GraphQL query to get subgraph metadata
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
# Try both schema variants (dev uses 'futures', prod uses 'futures_collection')
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


def get_thegraph_secrets():
    """Fetch TheGraph secrets from Secrets Manager (with caching).
    
    Returns dict with: api_key, futures_subgraph_id, oracles_subgraph_id
    """
    now = time.time()
    
    # Return cached secrets if still valid (cache for 5 minutes)
    if _secrets_cache["data"] and now < _secrets_cache["expires"]:
        return _secrets_cache["data"]
    
    if not THEGRAPH_SECRET_ARN:
        print("WARNING: No THEGRAPH_SECRET_ARN configured")
        return None
    
    try:
        response = secrets_client.get_secret_value(SecretId=THEGRAPH_SECRET_ARN)
        secrets = json.loads(response["SecretString"])
        
        # Cache for 5 minutes
        _secrets_cache["data"] = secrets
        _secrets_cache["expires"] = now + 300
        
        return secrets
    except Exception as e:
        print(f"Error fetching secrets from Secrets Manager: {e}")
        return None


def shorten_deployment(deployment):
    """Create shortened deployment key: first4...last3"""
    if not deployment or len(deployment) < 8:
        return deployment or "unknown"
    return f"{deployment[:4]}...{deployment[-3:]}"


def build_gateway_url(api_key, subgraph_id):
    """Build TheGraph Gateway URL for a subgraph."""
    return f"{THEGRAPH_GATEWAY_BASE}/{api_key}/subgraphs/id/{subgraph_id}"


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
                "User-Agent": "HPO-SubgraphMonitor/1.0",
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
    # Try prod schema first (futures_collection)
    result, _ = query_subgraph(url, FUTURES_ENTITY_QUERY_V1)
    if result and "data" in result and result["data"]:
        data = result["data"]
        # Check if we got futures_collection (prod schema)
        if "futures_collection" in data:
            return {
                "futures": len(data.get("futures_collection") or []),
                "participants": len(data.get("participants") or []),
                "positions": len(data.get("positions") or []),
            }
    
    # Try dev schema (futures instead of futures_collection)
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
    """Push metrics to CloudWatch."""
    if not metric_data:
        return
    
    # CloudWatch accepts max 1000 metrics per call, batch in groups of 20
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


def check_subgraph(name, subgraph_id, api_key, metric_data):
    """Check a single subgraph and add metrics.
    
    Args:
        name: Subgraph name (e.g., "futures", "oracles")
        subgraph_id: TheGraph subgraph ID
        api_key: TheGraph Gateway API key
        metric_data: List to append metrics to
        
    Returns:
        dict: Status summary for this subgraph
    """
    if not subgraph_id:
        print(f"  {name}: No subgraph ID configured, skipping")
        return None
    
    if not api_key:
        print(f"  {name}: No API key available, skipping")
        return None
    
    url = build_gateway_url(api_key, subgraph_id)
    # Mask API key in logs
    masked_url = url.replace(api_key, api_key[:8] + "..." + api_key[-4:])
    print(f"  Checking {name}: {masked_url}")
    
    # Query the subgraph
    result, response_time_ms = query_subgraph(url, META_QUERY)
    
    # Standard dimensions for per-subgraph metrics (no Deployment - keeps metrics consistent across updates)
    subgraph_dimensions = [
        {"Name": "Environment", "Value": ENVIRONMENT},
        {"Name": "Subgraph", "Value": name},
    ]
    
    # Check if query succeeded
    if result is None:
        print(f"    FAILED: No response (took {response_time_ms}ms)")
        metric_data.append({
            "MetricName": "thegraph_available",
            "Value": 0,
            "Unit": "Count",
            "Dimensions": subgraph_dimensions
        })
        metric_data.append({
            "MetricName": "thegraph_response_time_ms",
            "Value": response_time_ms,
            "Unit": "Milliseconds",
            "Dimensions": subgraph_dimensions
        })
        return {"name": name, "available": False, "response_time_ms": response_time_ms, "deployment_key": "unknown"}
    
    if "errors" in result:
        print(f"    ERROR: GraphQL errors: {result['errors']}")
        metric_data.append({
            "MetricName": "thegraph_available",
            "Value": 0,
            "Unit": "Count",
            "Dimensions": subgraph_dimensions
        })
        metric_data.append({
            "MetricName": "thegraph_response_time_ms",
            "Value": response_time_ms,
            "Unit": "Milliseconds",
            "Dimensions": subgraph_dimensions
        })
        return {"name": name, "available": False, "response_time_ms": response_time_ms, "deployment_key": "error", "errors": result["errors"]}
    
    # Extract metadata
    meta = result.get("data", {}).get("_meta", {})
    block = meta.get("block", {})
    block_timestamp = block.get("timestamp", 0)
    deployment = meta.get("deployment", "unknown")
    has_indexing_errors = meta.get("hasIndexingErrors", False)
    
    # Create shortened deployment key for logging/tracking
    deployment_key = shorten_deployment(deployment)
    
    # Calculate data age in seconds
    current_timestamp = int(time.time())
    data_age_seconds = current_timestamp - block_timestamp if block_timestamp > 0 else 0
    
    print(f"    OK: deployment={deployment_key}, age={data_age_seconds}s, errors={has_indexing_errors}, took {response_time_ms}ms")
    
    # Metric 1: Available (1 = yes)
    metric_data.append({
        "MetricName": "thegraph_available",
        "Value": 1,
        "Unit": "Count",
        "Dimensions": subgraph_dimensions
    })
    
    # Metric 2: Response time in milliseconds
    metric_data.append({
        "MetricName": "thegraph_response_time_ms",
        "Value": response_time_ms,
        "Unit": "Milliseconds",
        "Dimensions": subgraph_dimensions
    })
    
    # Metric 3: Indexing errors (1 = has errors, 0 = no errors)
    metric_data.append({
        "MetricName": "thegraph_indexing_errors",
        "Value": 1 if has_indexing_errors else 0,
        "Unit": "Count",
        "Dimensions": subgraph_dimensions
    })
    
    # Metric 4: Data age in seconds
    metric_data.append({
        "MetricName": "thegraph_data_age_seconds",
        "Value": data_age_seconds,
        "Unit": "Seconds",
        "Dimensions": subgraph_dimensions
    })
    
    # Entity counts (futures subgraph only - has futures, participants, positions)
    entity_counts = None
    if name == "futures":
        entity_counts = query_futures_entity_counts(url)
        if entity_counts:
            print(f"    Entities: futures={entity_counts['futures']}, participants={entity_counts['participants']}, positions={entity_counts['positions']}")
            for entity_name, count in entity_counts.items():
                metric_data.append({
                    "MetricName": "thegraph_entity_count",
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
    """Lambda handler - query TheGraph Gateway subgraphs and push health metrics."""
    print(f"Starting TheGraph Subgraph Health Monitor at {datetime.now().isoformat()}")
    print(f"Environment: {ENVIRONMENT}")
    print(f"Gateway Base: {THEGRAPH_GATEWAY_BASE}")
    
    # Fetch secrets from Secrets Manager (api_key + subgraph IDs)
    secrets = get_thegraph_secrets()
    if not secrets:
        print("ERROR: Failed to get TheGraph secrets - cannot proceed")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": "Failed to get TheGraph secrets"})
        }
    
    api_key = secrets.get("api_key", "")
    futures_subgraph_id = secrets.get("futures_subgraph_id", "")
    oracles_subgraph_id = secrets.get("oracles_subgraph_id", "")
    
    if not api_key:
        print("ERROR: No API key in secrets - cannot proceed")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": "No API key configured"})
        }
    
    print(f"API Key: {api_key[:8]}...{api_key[-4:]} (masked)")
    print(f"Futures ID: {futures_subgraph_id[:8]}... (masked)" if futures_subgraph_id else "Futures ID: not configured")
    print(f"Oracles ID: {oracles_subgraph_id[:8]}... (masked)" if oracles_subgraph_id else "Oracles ID: not configured")
    
    metric_data = []
    results = []
    
    # Check each configured subgraph
    subgraphs = [
        ("futures", futures_subgraph_id),
        ("oracles", oracles_subgraph_id),
    ]
    
    for name, subgraph_id in subgraphs:
        result = check_subgraph(name, subgraph_id, api_key, metric_data)
        if result:
            results.append(result)
    
    # Aggregate metrics (across all subgraphs) - simple counts without deployment dimension
    if results:
        aggregate_dimensions = [{"Name": "Environment", "Value": ENVIRONMENT}]
        
        total_checked = len(results)
        available_count = sum(1 for r in results if r.get("available"))
        error_count = sum(1 for r in results if r.get("has_indexing_errors"))
        avg_response_time = sum(r.get("response_time_ms", 0) for r in results) / total_checked
        max_data_age = max((r.get("data_age_seconds", 0) for r in results if r.get("available")), default=0)
        
        metric_data.append({
            "MetricName": "thegraph_subgraphs_available",
            "Value": available_count,
            "Unit": "Count",
            "Dimensions": aggregate_dimensions
        })
        
        metric_data.append({
            "MetricName": "thegraph_subgraphs_with_errors",
            "Value": error_count,
            "Unit": "Count",
            "Dimensions": aggregate_dimensions
        })
        
        metric_data.append({
            "MetricName": "thegraph_avg_response_time_ms",
            "Value": round(avg_response_time, 2),
            "Unit": "Milliseconds",
            "Dimensions": aggregate_dimensions
        })
        
        metric_data.append({
            "MetricName": "thegraph_max_data_age_seconds",
            "Value": max_data_age,
            "Unit": "Seconds",
            "Dimensions": aggregate_dimensions
        })
    
    # Push to CloudWatch
    push_to_cloudwatch(metric_data)
    
    print(f"Completed - pushed {len(metric_data)} metrics")
    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "TheGraph health check completed",
            "subgraphs_checked": len(results),
            "results": results,
            "metrics_pushed": len(metric_data)
        })
    }
