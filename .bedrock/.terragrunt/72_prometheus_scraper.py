"""
Prometheus Scraper Lambda
Scrapes Prometheus metrics from Graph Node and pushes key metrics to CloudWatch.

Graph Node Prometheus metrics are available at :8030/metrics
"""

import urllib.request
import json
import boto3
import os
import re
from datetime import datetime

# Environment variables
GRAPH_NODE_METRICS_URL = os.environ.get("GRAPH_NODE_METRICS_URL", "")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "HashpriceOracle")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")

# CloudWatch client
cloudwatch = boto3.client("cloudwatch")


def parse_prometheus_metrics(text):
    """
    Parse Prometheus text format into a dictionary of metrics.
    Returns dict: {metric_name: [(labels_dict, value), ...]}
    """
    metrics = {}
    
    for line in text.split('\n'):
        line = line.strip()
        
        # Skip comments and empty lines
        if not line or line.startswith('#'):
            continue
        
        # Parse metric line: metric_name{label="value",...} value
        # Or simple: metric_name value
        match = re.match(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?([^}]*)\}?\s+([0-9eE.+-]+|NaN|Inf|-Inf)$', line)
        if match:
            metric_name = match.group(1)
            labels_str = match.group(2)
            value_str = match.group(3)
            
            # Parse labels
            labels = {}
            if labels_str:
                label_matches = re.findall(r'([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"', labels_str)
                labels = dict(label_matches)
            
            # Parse value
            try:
                if value_str in ('NaN', 'Inf', '-Inf'):
                    continue  # Skip non-numeric values
                value = float(value_str)
            except ValueError:
                continue
            
            if metric_name not in metrics:
                metrics[metric_name] = []
            metrics[metric_name].append((labels, value))
    
    return metrics


def get_metric_value(metrics, name, labels_filter=None):
    """Get a metric value, optionally filtering by labels."""
    if name not in metrics:
        return None
    
    for labels, value in metrics[name]:
        if labels_filter is None:
            return value
        if all(labels.get(k) == v for k, v in labels_filter.items()):
            return value
    
    return None


def sum_metric_values(metrics, name, labels_filter=None):
    """Sum all values for a metric, optionally filtering by labels."""
    if name not in metrics:
        return 0
    
    total = 0
    for labels, value in metrics[name]:
        if labels_filter is None:
            total += value
        elif all(labels.get(k) == v for k, v in labels_filter.items()):
            total += value
    
    return total


def fetch_metrics():
    """Fetch metrics from Graph Node."""
    try:
        req = urllib.request.Request(GRAPH_NODE_METRICS_URL)
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read().decode('utf-8')
    except Exception as e:
        print(f"Error fetching metrics: {e}")
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


def lambda_handler(event, context):
    """Lambda handler - scrape and push metrics."""
    print(f"Starting Prometheus scraper at {datetime.now().isoformat()}")
    print(f"Fetching metrics from: {GRAPH_NODE_METRICS_URL}")
    
    # Fetch metrics
    raw_metrics = fetch_metrics()
    if not raw_metrics:
        print("No metrics fetched")
        return {"statusCode": 500, "body": "Failed to fetch metrics"}
    
    # Parse metrics
    metrics = parse_prometheus_metrics(raw_metrics)
    print(f"Parsed {len(metrics)} unique metric names")
    
    # Key metrics to push to CloudWatch
    metric_data = []
    
    # 1. Query latency (deployment_query_execution_time histogram)
    query_latency_sum = sum_metric_values(metrics, "deployment_query_execution_time_sum")
    query_latency_count = sum_metric_values(metrics, "deployment_query_execution_time_count")
    if query_latency_count > 0:
        avg_query_latency = query_latency_sum / query_latency_count
        metric_data.append({
            "MetricName": "graph_query_latency_avg",
            "Value": avg_query_latency,
            "Unit": "Seconds",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        })
    
    # 2. Query count
    query_count = sum_metric_values(metrics, "deployment_query_execution_time_count")
    metric_data.append({
        "MetricName": "graph_query_count",
        "Value": query_count,
        "Unit": "Count",
        "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
    })
    
    # 3. Subgraph deployment count
    deployment_count = get_metric_value(metrics, "deployment_count")
    if deployment_count is not None:
        metric_data.append({
            "MetricName": "graph_deployment_count",
            "Value": deployment_count,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        })
    
    # 4. Entity cache hits/misses
    cache_hits = get_metric_value(metrics, "deployment_entity_cache_hit")
    cache_misses = get_metric_value(metrics, "deployment_entity_cache_miss")
    if cache_hits is not None:
        metric_data.append({
            "MetricName": "graph_cache_hits",
            "Value": cache_hits,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        })
    if cache_misses is not None:
        metric_data.append({
            "MetricName": "graph_cache_misses",
            "Value": cache_misses,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        })
    
    # 5. Block ingestor head (latest block number)
    block_head = get_metric_value(metrics, "ethereum_chain_head_number")
    if block_head is not None:
        metric_data.append({
            "MetricName": "graph_chain_head_block",
            "Value": block_head,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        })
    
    # 6. Store connection pool
    pool_size = get_metric_value(metrics, "store_connection_pool_size")
    pool_available = get_metric_value(metrics, "store_connection_pool_available")
    if pool_size is not None:
        metric_data.append({
            "MetricName": "graph_db_pool_size",
            "Value": pool_size,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        })
    if pool_available is not None:
        metric_data.append({
            "MetricName": "graph_db_pool_available",
            "Value": pool_available,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        })
    
    # 7. Indexing status (blocks processed)
    blocks_processed = sum_metric_values(metrics, "deployment_blocks_processed")
    if blocks_processed > 0:
        metric_data.append({
            "MetricName": "graph_blocks_processed_total",
            "Value": blocks_processed,
            "Unit": "Count",
            "Dimensions": [{"Name": "Environment", "Value": ENVIRONMENT}]
        })
    
    # Push to CloudWatch
    push_to_cloudwatch(metric_data)
    
    print(f"Completed - pushed {len(metric_data)} metrics")
    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "Metrics scraped and pushed",
            "metrics_count": len(metric_data)
        })
    }
