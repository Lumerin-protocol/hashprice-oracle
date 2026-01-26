"""
Subgraph Health Monitor Lambda
Queries Graph Node's GraphQL API to check indexing status and pushes metrics to CloudWatch.

This provides application-level health monitoring:
- synced: Is the subgraph caught up with the blockchain?
- health: Is the subgraph healthy, unhealthy, or failed?
- entityCount: Number of entities indexed (growth indicator)
"""

import urllib.request
import json
import boto3
import os
from datetime import datetime

# Environment variables
GRAPH_NODE_URL = os.environ.get("GRAPH_NODE_URL", "")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "HashpriceOracle")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")

# CloudWatch client
cloudwatch = boto3.client("cloudwatch")

# GraphQL query to get indexing status for all subgraphs
INDEXING_STATUS_QUERY = """
{
  indexingStatuses {
    subgraph
    synced
    health
    entityCount
    chains {
      network
    }
  }
}
"""


def query_graph_node(query):
    """Execute a GraphQL query against Graph Node."""
    try:
        data = json.dumps({"query": query}).encode("utf-8")
        req = urllib.request.Request(
            GRAPH_NODE_URL,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as e:
        print(f"Error querying Graph Node: {e}")
        return None


def health_to_numeric(health_status):
    """Convert health status string to numeric value.
    
    Returns:
        1 = healthy
        0 = unhealthy or failed
    """
    return 1 if health_status == "healthy" else 0


def synced_to_numeric(synced_status):
    """Convert synced boolean to numeric value.
    
    Returns:
        1 = synced (caught up with chain)
        0 = not synced (still catching up)
    """
    return 1 if synced_status else 0


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


def lambda_handler(event, context):
    """Lambda handler - query Graph Node and push health metrics."""
    print(f"Starting Subgraph Health Monitor at {datetime.now().isoformat()}")
    print(f"Querying Graph Node: {GRAPH_NODE_URL}")
    
    # Query indexing status
    result = query_graph_node(INDEXING_STATUS_QUERY)
    if not result:
        print("Failed to query Graph Node")
        return {"statusCode": 500, "body": "Failed to query Graph Node"}
    
    if "errors" in result:
        print(f"GraphQL errors: {result['errors']}")
        return {"statusCode": 500, "body": f"GraphQL errors: {result['errors']}"}
    
    indexing_statuses = result.get("data", {}).get("indexingStatuses", [])
    print(f"Found {len(indexing_statuses)} subgraph(s)")
    
    metric_data = []
    
    for status in indexing_statuses:
        subgraph_id = status.get("subgraph", "unknown")
        # Use short ID for dimension (first 8 chars of IPFS hash)
        subgraph_short = subgraph_id[:8] if len(subgraph_id) > 8 else subgraph_id
        
        synced = status.get("synced", False)
        health = status.get("health", "unknown")
        entity_count = int(status.get("entityCount", 0))
        network = status.get("chains", [{}])[0].get("network", "unknown")
        
        print(f"  Subgraph {subgraph_short}: synced={synced}, health={health}, entities={entity_count}, network={network}")
        
        # Common dimensions for this subgraph
        dimensions = [
            {"Name": "Environment", "Value": ENVIRONMENT},
            {"Name": "SubgraphId", "Value": subgraph_short},
            {"Name": "Network", "Value": network}
        ]
        
        # Synced metric (1=synced, 0=not synced)
        metric_data.append({
            "MetricName": "subgraph_synced",
            "Value": synced_to_numeric(synced),
            "Unit": "Count",
            "Dimensions": dimensions
        })
        
        # Health metric (1=healthy, 0=unhealthy/failed)
        metric_data.append({
            "MetricName": "subgraph_health",
            "Value": health_to_numeric(health),
            "Unit": "Count",
            "Dimensions": dimensions
        })
        
        # Entity count (absolute number - useful to track growth)
        metric_data.append({
            "MetricName": "subgraph_entity_count",
            "Value": entity_count,
            "Unit": "Count",
            "Dimensions": dimensions
        })
    
    # Also push aggregate metrics (without SubgraphId dimension)
    # This gives a quick overview across all subgraphs
    total_subgraphs = len(indexing_statuses)
    healthy_count = sum(1 for s in indexing_statuses if s.get("health") == "healthy")
    synced_count = sum(1 for s in indexing_statuses if s.get("synced"))
    total_entities = sum(int(s.get("entityCount", 0)) for s in indexing_statuses)
    
    aggregate_dimensions = [{"Name": "Environment", "Value": ENVIRONMENT}]
    
    metric_data.append({
        "MetricName": "subgraphs_total",
        "Value": total_subgraphs,
        "Unit": "Count",
        "Dimensions": aggregate_dimensions
    })
    
    metric_data.append({
        "MetricName": "subgraphs_healthy",
        "Value": healthy_count,
        "Unit": "Count",
        "Dimensions": aggregate_dimensions
    })
    
    metric_data.append({
        "MetricName": "subgraphs_synced",
        "Value": synced_count,
        "Unit": "Count",
        "Dimensions": aggregate_dimensions
    })
    
    metric_data.append({
        "MetricName": "subgraphs_total_entities",
        "Value": total_entities,
        "Unit": "Count",
        "Dimensions": aggregate_dimensions
    })
    
    # Push to CloudWatch
    push_to_cloudwatch(metric_data)
    
    print(f"Completed - pushed {len(metric_data)} metrics")
    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "Subgraph health check completed",
            "subgraphs": total_subgraphs,
            "healthy": healthy_count,
            "synced": synced_count,
            "metrics_pushed": len(metric_data)
        })
    }
