# Monitoring & Observability Design

> **Status**: Draft — initial scope
> **Parent**: [Oracle Decentralization Options](01-architecture-options.md)

---

## Contract Events

The HashrateAggregator should emit events on every meaningful state change. These are the foundation for all off-chain monitoring — the subgraph indexes them, the dashboard displays them, and alerting watches for anomalies.

### Submission Events

```solidity
event Submitted(address indexed reporter, uint256 hashesForBTC, uint256 timestamp);
event ConsensusUpdated(uint80 indexed roundId, uint256 medianValue, uint256 timestamp, uint8 reporterCount);
event SubmissionRejected(address indexed reporter, uint256 value, uint256 consensusValue, string reason);
```

- `Submitted` — emitted on every valid `submit()` call, even if quorum isn't yet met. Enables per-reporter transparency.
- `ConsensusUpdated` — emitted when a new median is computed after quorum is reached. This is what consumers care about.
- `SubmissionRejected` — emitted when a submission fails the circuit breaker (deviation too large). Critical for detecting misbehaving or compromised reporters.

### Administrative Events

```solidity
event ReporterAdded(address indexed reporter);
event ReporterRemoved(address indexed reporter);
event ConfigUpdated(uint8 minSubmissions, uint16 deviationThresholdBps, uint256 maxStaleness);
event BtcOracleUpdated(address indexed newOracle);
```

---

## Subgraph Extension

The current subgraph indexes `getHashesForBTC()` and `getHashesforToken()` via block handlers. Extend it to also index the new events:

| Entity | Source Event | Purpose |
|--------|------------|---------|
| `Submission` | `Submitted` | Per-reporter submission history |
| `Consensus` | `ConsensusUpdated` | Consensus history (replaces block handler for new data) |
| `RejectedSubmission` | `SubmissionRejected` | Anomaly tracking |
| `ReporterStatus` | `ReporterAdded` / `ReporterRemoved` | Active reporter set |

This gives the UI and dashboard queryable history of every individual reporter submission alongside the aggregated consensus.

---

## Dashboard (status.hashpower.exchange)

A public transparency dashboard showing:

### Real-Time View

- **Current consensus value** — latest median hashprice
- **Individual reporter values** — each reporter's most recent submission and when it was submitted
- **Reporter status** — online (submitted within heartbeat), stale, offline
- **Deviation** — spread between individual reporters and the consensus

### Historical View

- **Consensus over time** — chart of hashprice from `ConsensusUpdated` events
- **Per-reporter submission history** — overlay individual reporter values to show convergence
- **Rejected submissions** — flagged anomalies

### Data Source

All dashboard data comes from the subgraph — no direct RPC calls to the contract needed for historical data. Current consensus can be read directly from the contract for real-time display.

---

## Alerting

Off-chain monitoring service (could be a simple cron or Lambda) watching for:

| Alert | Condition | Severity |
|-------|-----------|----------|
| Stale consensus | No `ConsensusUpdated` event in > `heartbeat × 2` | Critical |
| Reporter offline | No `Submitted` event from a reporter in > `heartbeat × 3` | Warning |
| Submission rejected | `SubmissionRejected` event emitted | Warning |
| All reporters agree but value diverges from expected | Consensus differs from independently computed value by > threshold | Critical |
| Quorum degraded | Active reporters < `minSubmissions + 1` (no redundancy) | Warning |

Alerting infrastructure is out of scope for the oracle build itself — it can use existing monitoring (CloudWatch, PagerDuty, etc.) or a dedicated lightweight watcher.

---

## Companion Documents

| Document | Purpose |
|----------|---------|
| [Oracle Decentralization Options](01-architecture-options.md) | Architecture and direction |
| [Contract & Consumer Reference](04-contract-reference.md) | Contract interfaces, events, parameters |
