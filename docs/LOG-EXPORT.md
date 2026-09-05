# Exporting Worker logs and traces

The Worker writes structured logs for every scale-up, every start and every
destroy. This document explains where those logs go by default, why the
default is not enough for an audit trail, and how to export them.

## The retention gap

[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#limits)
retains a log for at most 7 days, and a single log has a 256 KB ceiling.

`wrangler.jsonc` ships with:

- `observability.logs.enabled = true`
- `observability.logs.head_sampling_rate = 1`
- `observability.traces.enabled = true`
- `observability.traces.head_sampling_rate = 0.01`

So every log line is kept, and discarded after a week. Traces sample 1% of
requests, which cannot give you one terminal trace per sandbox.

If you need a record that outlives the week, export it.

## Exporting with OpenTelemetry

Cloudflare recommends OpenTelemetry export over Workers Trace Events Logpush
for new integrations. It carries both logs and traces, and it supports
`persist: false`, so Cloudflare does not have to store the data twice.

- [Exporting OpenTelemetry Data](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
- [Export to Grafana Cloud](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/grafana-cloud/)

Send the data straight from Cloudflare to your OTLP endpoint. Do not route it
through a host collector such as Grafana Alloy: a host collector reads the
machines it runs on and has no path to Worker telemetry.

### Procedure

> **CAUTION**
>
> Create both destinations before you edit `wrangler.jsonc`. The configuration
> references them by exact name, and a name that does not exist fails the
> deployment.

1. Open the Cloudflare dashboard.
2. Open **Workers Observability → Destinations**.
3. Create a destination of type `Logs`.
4. Give it a unique name, your OTLP logs endpoint, and the `Authorization`
   header your provider issues. Save it.
5. Create a second destination of type `Traces`, the same way.

[Cloudflare does not accept the OTLP binary protobuf encoding.](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/#creating-a-destination)
Use the encoding your provider's Cloudflare guide specifies.

Then replace the `observability` object in `wrangler.jsonc`:

```jsonc
"observability": {
  "enabled": true,
  "logs": {
    "enabled": true,
    "head_sampling_rate": 1,
    "destinations": ["<logs-destination-name>"]
  },
  "traces": {
    "enabled": true,
    "head_sampling_rate": 0.01,
    "destinations": ["<traces-destination-name>"]
  }
}
```

Run `npm run check`, redeploy, and allow a few minutes for delivery.

## Cost

The
[limits and pricing table](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/#limits-and-pricing)
gives the current allowance. Workers Paid includes 10 million exported log
events and 10 million exported trace events each month, then charges per
additional million. These allowances are separate from the Workers Logs event
rate.

Cloudflare does not support metrics export yet.

## Sampling

`head_sampling_rate` for traces stays at `0.01`. A 1% sample cannot give you a
terminal trace for every sandbox. Raise it if you need a complete trail, and
accept the cost and volume that follows.

## What this does not cover

Runner-process output lives inside the sandbox and dies with it. It reaches
the GitHub Actions job log, which has its own retention. OpenTelemetry export
does not carry it.

## The audit record

The orphan audit archives its JSON Lines record as a 90-day build artifact,
independently of any of the above. Open **Actions → Orphan audit → the run →
Artifacts**.

`orphan-audit.jsonl` holds every record the audit wrote before it stopped.
Each orphan record carries the sandbox evidence, `reason`, `destroyResult` and
`destroyHttpStatus`. The summary carries the audited fleet fields and all six
counters. Exit code 2 can leave the file empty or partial with no summary.

The artifact also holds `orphan-audit.stderr.log`. Read it when an audit is
incomplete: it carries each audit failure body, and the human summary sentence
when the audit got that far.
