# Alerting

How this fleet tells you something is wrong, and why it stays quiet the rest
of the time.

## The principle

A healthy pool is silent. Every scheduled check that finds nothing exits
without sending anything. Repeated healthy messages train a channel to ignore
the one message that matters, so they are not sent.

An alert fires only when a human has to act.

## Inventory

| Check | Schedule | Watches | Delivery |
| --- | --- | --- | --- |
| Listener watchdog | every 5 minutes | Listener, control and reservation status | Failed Actions run, plus a Slack webhook if configured |
| Orphan audit | hourly | Sandboxes running with no live registry row | Failed Actions run; Slack only for an operational or destroy failure |
| Operator destroy | twice hourly | Destroys the orphans the audit proved | Failed Actions run, plus Slack when a sandbox stays unresolved |
| Registration cleanup | manual | GitHub registrations with no sandbox | Failed Actions run |

All of them run on GitHub-hosted runners, deliberately. A watchdog that runs
on the pool it watches cannot report that the pool is jammed, because it
would be queued behind the jam.

## What each exit code means

The audit and the watchdog both use the same convention:

| Code | Meaning | Action |
| --- | --- | --- |
| 0 | Clean | None. Nothing is sent. |
| 1 | Findings, nothing failed | Read the records. The scheduled cleanup usually resolves these on its own. |
| 2 | Operational failure | The check could not complete. Repair the credential or the query and run it again. |
| 3 | Findings, and a destroy failed | Act. Read `docs/ORPHAN-RUNBOOK.md`. |

Exit code 1 does not page. Findings alone are not an emergency: the cleanup
job destroys what it can prove, and an ambiguous instance record is a listing
artifact rather than a leak. The job status, the step summary and the archived
record still carry every finding.

## Slack delivery

Slack is the secondary path and it is optional. The primary alert is the
failed Actions run, which costs nothing and cannot be broken by a missing
secret.

Set these repository secrets to enable Slack:

| Secret | Used by |
| --- | --- |
| `ORPHAN_AUDIT_SLACK_WEBHOOK_URL` | Orphan audit, operator destroy |
| `LISTENER_WATCHDOG_SLACK_WEBHOOK_URL` | Listener watchdog |

With no webhook set, each workflow adds a warning annotation and a step-summary
warning saying alerting is degraded, then continues. It never fails a run
because Slack is missing.

## Prove delivery before you trust silence

Silence means either "healthy" or "the alert path is broken", and the two look
identical. The listener watchdog accepts a `positive_control` dispatch input
that sends a synthetic finding through the real Slack path.

Run it after any change to the webhook, the secret, or the channel:

```bash
gh workflow run listener-watchdog.yml -f positive_control=true
```

If the message does not arrive, the path is broken and every quiet hour since
the last real alert proves nothing.

## Retuning

The watchdog reads its thresholds from repository variables, so you can change
them without editing a workflow:

| Variable | Controls |
| --- | --- |
| `LISTENER_WATCHDOG_STRANDED_COUNT` | How many stranded reservations are tolerated |
| `LISTENER_WATCHDOG_STRANDED_AGE_MS` | How old a reservation may get |
| `LISTENER_WATCHDOG_DARK_MS` | How long the listener may go silent |
| `WATCHDOG_SCALE_SET` | Which scale set to poll |
| `WORKER_URL` | Where the Worker lives |

Widen a threshold only with a measurement that shows the current one is wrong.
A threshold loosened to stop a noisy alert is an alert deleted.

## What this does not cover

- **No independent health endpoint.** The watchdog asks the Worker how it is.
  A Worker that is wrong about itself reports wrongly.
- **No billing alarm.** Nothing watches live instance count against spend.
  The orphan audit bounds the leak, not the bill. Set a spend alert in the
  Cloudflare dashboard.
- **No demand controller.** Nothing alerts on jobs queuing while the pool sits
  idle. Queue latency is a symptom of many causes and would alert on all of
  them.
