# Incident: Oracle keeper stuck nonce / underpriced replacements

| Field | Value |
| --- | --- |
| Date | 2026-11-02 |
| Environment | Production (LMN / Base mainnet) |
| Severity | High — oracle stalled; markets and UI degraded as symptoms |
| Duration | ~07:35–09:22 America/New_York (~1h 47m) |
| Status | Resolved (manual recovery); self-heal shipped in follow-up PR |

## Summary

The HashpriceBTC keeper Lambda submitted a `submitBlocks` transaction that did not confirm before the function timed out. Later invocations reused the same nonce with the same (low) fees, so the RPC rejected replacements as underpriced (or re-accepted a ghost hash that never mined). Oracle height froze. After the on-chain staleness window, portfolio margin and market-maker paths failed, and the trading UI appeared stuck loading contract specifications.

## Timeline (America/New_York)

| Time | Event |
| --- | --- |
| ~07:10 | Last successful `submitBlocks` |
| ~07:35 | First replacement-underpriced / stuck-nonce failures |
| 07:35–08:45 | Keeper runs every ~5 minutes fail the same way; oracle height frozen |
| ~08:35+ | Consumers hit oracle-staleness errors; MM / vault checks / UI degrade |
| ~08:46 | Manual high-fee cancel clears the first stuck nonce |
| 08:50–09:21 | New submits at the next nonce still use default low fees; txs drop or never confirm; Lambda rebroadcasts the same hash and times out again |
| ~09:22 | Manual high-fee `submitBlocks` catch-up lands; oracle reaches Bitcoin tip |
| ~09:23–09:37 | Clean keeper completions; HPDX CloudWatch alarms return to OK |

## True root cause

The keeper sent contract writes with viem’s default fee estimation and **no replace-by-fee / cancel path**:

1. A `submitBlocks` tx remains unconfirmed past the Lambda timeout.
2. The next invoke resigns the **same nonce + fees + calldata** → same tx hash → underpriced or ghost-pending → wait loops until timeout again.
3. Canceling once is not enough if the *next* submit is also underpriced for inclusion.
4. Downstream failures (`OracleStale`, market-maker pause, vault market-check, UI spinner) were **symptoms**, not the primary fault.

Not an RPC quota exhaustion issue, and not a market-maker gas-wallet balance issue.

## Impact

- On-chain hashprice feed stopped updating for the outage window.
- After max oracle staleness, trading and quoting paths that require a fresh oracle failed.
- Operators had to manually cancel and fee-bump from the updater key to restore service.
- CloudWatch oracle / MM / vault alarms stayed in ALARM until catch-up completed and evaluation periods cleared.

## Immediate recovery (manual)

1. High-fee zero-value self-transaction (cancel) at the stuck nonce.
2. High-fee `submitBlocks` batches until oracle height matched the Bitcoin tip.
3. Forced staleness / vault monitor runs; waited for alarm evaluation windows.

## Fix plan (self-heal — no new fee env knobs)

Implement intelligence in the keeper write path with **hardcoded constants**:

1. **Pending-aware write** — if a pending nonce exists, replace-by-fee (≥20% EIP-1559 bump) instead of blind resend.
2. **Escalating bumps** on confirmation timeout or underpriced errors, capped per invoke.
3. **Bounded receipt wait** (~45s) so the invoke exits cleanly; the next cycle continues bumping.
4. **Last resort cancel-tx** (0-value self-send at the stuck nonce) after max replacements, then resume on the following cycle.
5. **Hard fee ceilings** — max tip, max `maxFeePerGas`, and max `gasLimit × maxFeePerGas` so escalation cannot approach large ETH spend.
6. **Confirmations default fix** — `Number(undefined) ?? N` yields `NaN`; default must be `Number(env ?? "1")`.
7. **Lambda timeout** raised (Terraform) so a healthy confirmation + one bump fit in a single invoke.

## Prevention / detection

- Structured logs for `pending_replace`, `fee_bump`, and `cancel-tx` (already part of the self-heal path).
- Existing oracle silent / stale composite alarms remain the page/Slack signal if self-heal fails within caps.
- Follow-up: consider the same fee-bump pattern anywhere else that shares “default fees + wait forever” behavior.

## References

- Keeper write path: `keeper/src/core/oracle.ts`, `keeper/src/core/txSend.ts`
- Lambda timeout: `.bedrock/.terragrunt/05_oracle_lambda.tf`
