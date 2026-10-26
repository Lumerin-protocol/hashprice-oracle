# HPDX Monitoring & Alerting

Canonical guide for CloudWatch monitors and alarms in this repo. Agents and humans
must follow this when adding or changing monitoring.

## SNS topics (foundation-core owns these)

Do **not** create SNS topics in this repo. Look them up by name:

| Env | Slack (`#hpdx-alerts`) | Page (SMS + email) |
| --- | --- | --- |
| DEV | `titanio-dev-hpdx-alerts` | same as Slack (no separate page) |
| LMN | `titanio-lmn-hpdx-alerts` | `titanio-lmn-hpdx-page` |

```hcl
data "aws_sns_topic" "hpdx_alerts" {
  count = /* gated */ 1
  name  = var.monitoring.dev_alerts_topic_name  # or literal titanio-{env}-hpdx-alerts
}

data "aws_sns_topic" "hpdx_page" {
  count = /* gated */ 1
  name  = var.monitoring.devops_alerts_topic_name  # titanio-{env}-hpdx-page in LMN
}
```

- Never hardcode ARNs.
- Never use `terraform_remote_state` for SNS.
- Never create orphan topics like `*-mm-alerts-*` or repo-local alert topics.
- Wire tfvars topic **names** only (`dev_alerts_topic_name` / `devops_alerts_topic_name`).

## Severity routing

| Severity | Non-prod (DEV) | Prod/LMN (`account_lifecycle == "prd"`) |
| --- | --- | --- |
| Warning | `hpdx-alerts` (Slack) | `hpdx-alerts` (Slack) |
| Critical | `hpdx-alerts` (Slack) | `hpdx-page` (SMS/email) |

Respect `notifications_enabled`. When false, keep alarms but set actions to `[]`.

## Alarm pattern (required)

1. **Component metric alarms** — state tracking only: `alarm_actions = []`, `ok_actions = []`.
2. **One composite per service/subsystem** — the only notifier. OR the component alarms; attach SNS there.
3. Gate resources with the same `create` flag as the service they monitor.
4. Prefer existing locals (`component_alarm_actions`, `composite_alarm_actions`, `critical_sns_arn`, `warning_sns_arn`) in `70_monitoring_common.tf`.

Do **not** attach SNS to every metric alarm (noise / double-page). Exception: vault-style monitors that intentionally split warn vs crit on individual alarms (see collateral-margin). This repo uses composites for critical paths.

## Checklist for a new monitor

1. Metrics/filters under a clear CloudWatch namespace.
2. Component alarms silent; composite (or warn/crit split) notifies.
3. `data.aws_sns_topic` lookup by foundation topic name.
4. tfvars names for DEV and LMN updated if introducing new topic vars.
5. `notifications_enabled` honored.
6. Plan shows SNS action swaps / composite only — no new SNS topics.

## This repo

- Shared lookups/locals: `.bedrock/.terragrunt/70_monitoring_common.tf`
- Component alarms: `80_alarms.tf` (and related)
- Composites: `81_composite_alarms.tf`
- Topic names: `.bedrock/02-dev/terraform.tfvars`, `.bedrock/04-lmn/terraform.tfvars` → `monitoring {}`
