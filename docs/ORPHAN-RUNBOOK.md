# Orphan audit runbook

This runbook covers the orphan audit and its supported cleanup routes.

## Schedule and placement

`.github/workflows/orphan-audit.yml` runs every hour at minute `:17`.
It also supports a manual `workflow_dispatch` run.
The workflow runs on GitHub-hosted `ubuntu-latest`, not on Cloudflare and not on your own runners.

The placement has these reasons:

- The guard must not depend on the service that it watches.
- A guard on Cloudflare Containers cannot report a Cloudflare outage or a Cloudflare leak.
- GitHub-hosted `ubuntu-latest` shares no failure domain with Cloudflare.
- The audit already requires GitHub.
- The preflight calls `GET /repos/{owner}/{repo}/actions/runners` once on every run.
- The audit calls that endpoint again for every live sandbox.
- It exits 2 when that GitHub query fails.
- GitHub hosting adds no new failure domain that the audit did not already have.
- Running the audit on your own runners would pair it with the fleet it watches.
- Its unattended failure is silent.
- The audit needs a schedule that exists today and can prove that it runs.

The residual gap is a GitHub Actions outage.
Such an outage stops the audit.
The audit could not run elsewhere during that outage because its GitHub query is a hard dependency.

### Cadence decision

A leaked idle `standard-4` sandbox was measured at `$0.00003140` per second.
The configured ceiling is 300 leaked sandboxes.
At this rate, the full ceiling costs about `$33.91` per hour.
The hourly audit bounds undetected full-ceiling leak spend to about `$33.91` per cycle.
The audit uses around two GitHub-hosted runner-minutes each hour.
A 15-minute cadence would increase the audit cost about fourfold.
It would save at most a few cents for each leaked sandbox event.

Minute `:17` avoids GitHub's top-of-hour scheduling congestion.
[GitHub documents this congestion](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
GitHub disables scheduled workflows in a public repository after 60 days with no repository activity.

The scheduled audit uses report mode.
It never sends a destroy request itself.
`.github/workflows/operator-destroy-orphans.yml` runs the cleanup on its own
schedule at minutes `:37` and `:47`, after the audit.
A scheduled operator run always sends destroy requests.
The Worker's operator route validates each request against live evidence.
It destroys a sandbox only when the registry row is terminal or absent, the
observed instance ID matches the current sandbox generation, and the 60-second
grace window has elapsed since the first observation.
The `:37` pass records the observation.
The `:47` pass destroys the sandbox.
A manual `workflow_dispatch` of that workflow is a dry run unless `destroy` is
`true`.

> **CAUTION**
>
> The audit's own `--destroy` mode must stay manual.
> It handles the `unregistered` and `absent-from-cloudflare` classes through
> the registry, where a false positive can delete a live runner.
> Use a deliberate `workflow_dispatch` with `destroy: true` for those classes.

Each scheduled or manual report run executes the audit once.
The workflow never passes `--destroy-unknown-age` and does not expose it as an input.
The workflow passes the `ORPHAN_GRACE_SECONDS` policy value of 60 to the audit.

The owner can optionally create a protected GitHub environment first and attach this job to it; this control is not enabled.

## Repository configuration

Create these items under `Settings → Secrets and variables → Actions`.

| Kind | Name | Required | Purpose |
| --- | --- | --- | --- |
| Repository variable | `WORKER_URL` | Yes | The deployed Worker origin, such as `https://<wrangler-name>.<account-subdomain>.workers.dev`. |
| Repository variable | `AUDIT_RUNNER_SCOPE` | Yes for this deployment | Selects the audit runner scope. The workflow maps it to the `GITHUB_RUNNER_SCOPE` environment variable. It must match the Worker variable `GITHUB_RUNNER_SCOPE`. |
| Repository secret | `CLOUDFLARE_API_TOKEN` | Yes | Lets Wrangler read the container application and its live instances. |
| Repository secret | `CONTROL_TOKEN` | Yes | Authenticates `GET /runners` and derives each cleanup HMAC. |
| Repository secret | `AUDIT_GITHUB_TOKEN` | Yes | Reads self-hosted runner registrations in the selected runner scope. |
| Repository secret | `ORPHAN_AUDIT_SLACK_WEBHOOK_URL` | No | Sends non-zero audit results to a Slack channel. |

GitHub forbids the `GITHUB_` prefix on an Actions configuration variable.
The Actions variable therefore uses `AUDIT_RUNNER_SCOPE`.
The workflow maps it to the `GITHUB_RUNNER_SCOPE` environment variable.
The audit script reads this variable and shares that contract with `src/worker.js`.

Set `WORKER_URL` to an HTTPS origin without a path.
The workflow preflight rejects an empty value or a value without `https://`.
The preflight reads the Worker `name` from `wrangler.jsonc`.
It requires the first DNS label of the `WORKER_URL` host to equal that name.
This check prevents an audit from reading another authenticated Worker registry.
A Worker behind a custom domain cannot pass this check as written.
Update the check and this runbook together before you use a custom domain.
The preflight reports all missing required items in one failure message.
It never prints a secret, a secret fragment, or a secret length.

### `CLOUDFLARE_API_TOKEN`

Create an account-scoped Cloudflare API token for your Cloudflare account.
Give the token read-only access.
The audit calls only these Cloudflare endpoints:

- `/accounts/{account_id}/containers/dash/applications`
- `/accounts/{account_id}/containers/dash/applications/{id}/instances`

`WRANGLER_LOG=debug` captured these two endpoint paths.
Do not trust only a dashboard permission label.

Run this authoritative acceptance test:

```bash
CLOUDFLARE_API_TOKEN=… npx wrangler containers list --config wrangler.jsonc --json
```

Confirm that the command prints the application row.
The token needs no write permission of any kind.
The audit sends its only destructive action through the Worker, not through the Cloudflare API.

### `CONTROL_TOKEN`

Set `CONTROL_TOKEN` to the same value as the Worker's `CONTROL_TOKEN` secret.
Use at least 32 characters, as enforced by the audit.

Rotate the Worker secret and this repository secret together.
A rotation invalidates the cleanup HMAC held by each already-running sandbox.

### `AUDIT_GITHUB_TOKEN`

Create a fine-grained personal access token with the permission for the selected
audit scope:

| `AUDIT_RUNNER_SCOPE` | Audit endpoint | Required `AUDIT_GITHUB_TOKEN` permission |
| --- | --- | --- |
| Absent, empty, or `repository` | `/repos/{owner}/{repo}/actions/runners` | Repository `Administration: Read-only` |
| `organization` | `/orgs/{GITHUB_REPOSITORY owner}/actions/runners` | Organization `Self-hosted runners: Read-only` |
| `organization:<org>` | `/orgs/{org}/actions/runners` | Organization `Self-hosted runners: Read-only` |

The audit token and the Worker token are separate credentials. Both tokens must
point at the same scope. Set the Actions repository variable
`AUDIT_RUNNER_SCOPE` to the same value as the Worker variable
`GITHUB_RUNNER_SCOPE`. GitHub forbids the `GITHUB_` prefix on an Actions
configuration variable, which is why these names differ.

A token with only repository `Administration: Read-only` returns HTTP 403 on an
organization endpoint. The audit aborts with exit 2 instead of reporting
orphans.

A repository-scoped audit against an organization-registered fleet returns
HTTP 200 with an empty list. That is why the audit probes the selected scope
before it classifies anything.

The current deployment uses `AUDIT_RUNNER_SCOPE=organization` for Actions and
`GITHUB_RUNNER_SCOPE=organization` for the Worker. The audit token therefore
needs organization `Self-hosted runners: Read-only`.

[GitHub documents the repository runner permission](https://docs.github.com/en/rest/actions/self-hosted-runners#list-self-hosted-runners-for-a-repository).

The Worker uses its separate `GITHUB_TOKEN` for registry cleanup. Its token
needs these write permissions:

| Value | Cleanup endpoint | Required fine-grained token permission |
| --- | --- | --- |
| Absent, empty, or `repository` | `/repos/{owner}/{repo}/actions/runners` | Repository `Administration: read and write` |
| `organization` | `/orgs/{GITHUB_REPOSITORY owner}/actions/runners` | Organization `Self-hosted runners: read and write` |
| `organization:<org>` | `/orgs/{org}/actions/runners` | Organization `Self-hosted runners: read and write` |

`GITHUB_TOKEN` is singular and deployment-wide, so its permission scope sets
the cleanup scope. Do not derive this value from `AUTOPILOT_SCALE_SETS`.
Autopilot can be off, and multiple configured scale sets have no singular
scope.

The registry `repository` value records the job repository. It remains the
allowlist and logging value. It is not the runner registration scope. The
registry needs no new scope column. `GITHUB_REPOSITORY_ALLOWLIST` also cannot
select the scope because an organization token still uses the allowlist.

GitHub registration deletion is enabled when
`RUNNER_REGISTRATION_DELETE` is unset. Set the Worker variable to the exact
string `off` to stop registration deletion during an incident. This switch
does not stop GitHub lookups, safety guards, sandbox destruction, or registry
settlement. Each skipped deletion has the `delete-disabled` result in the
cleanup response and Worker log. Remove the variable to enable deletion again.
Do not add this variable to `wrangler.jsonc` during normal operation.

The built-in `GITHUB_TOKEN` cannot replace `AUDIT_GITHUB_TOKEN`.
`administration` is not a workflow permission.
The built-in token also has scope for this repository, not `example-org/example-repo`.

After `npm ci`, the preflight reads `vars.GITHUB_REPOSITORY` from `wrangler.jsonc`.
It uses Wrangler's `unstable_readConfig` reader.
The audit script uses the same reader.
The preflight requires a non-empty `owner/repository` string.
The workflow maps the Actions repository variable `AUDIT_RUNNER_SCOPE` to the
environment variable `GITHUB_RUNNER_SCOPE`.
The preflight reads this environment variable first.
It uses the Wrangler variable `vars.GITHUB_RUNNER_SCOPE` from `wrangler.jsonc`
when the environment variable is absent or empty.
It exports the repository as `audit_repository` and the scope as `runner_scope`.
The workflow asserts the audit's reported `runnerScope` against the preflight's
resolved scope, so a mismatch fails the run instead of producing a blind report.

The preflight then runs this probe:

```bash
gh api "$runner_scope_path" --jq '.total_count'
```

The probe must return a non-negative integer.
It proves that `AUDIT_GITHUB_TOKEN` can list runners in the selected scope.
It runs even when the Cloudflare fleet has no live sandbox.
The presence check alone did not prove that the token worked.
An expired, revoked, or incorrectly scoped token can still be present.

The preflight prints this exact message when the probe fails:

```text
Orphan audit GitHub probe failed for runner scope organization:example-org at endpoint orgs/example-org/actions/runners.
AUDIT_GITHUB_TOKEN requires Organization `Self-hosted runners: Read-only` for this scope.
A token holding only repository `Administration: Read-only` gets HTTP 403 on an organization endpoint.
```

This message gives the minimum token scope.
The workflow never prints the token or a token fragment.

### `ORPHAN_AUDIT_SLACK_WEBHOOK_URL`

Set this optional secret to a Slack incoming webhook URL.
Leave it absent to use only GitHub's workflow-failure notification.

## Observe the fleet

### Read the Cloudflare application

Run this command:

```bash
npx wrangler containers list --config wrangler.jsonc --json
```

> **WARNING**
>
> The `instances` column appears as LIVE INSTANCES.
> It is capacity equal to `max_instances`.
> It is never a leak signal.

Read the application ID from the matching application row.

### Read the running sandboxes

Replace `<application-id>`, then run this Bash loop:

```bash
set -euo pipefail
application_id='<application-id>'
page_token=''
page_count=0
declare -A seen_page_tokens=()

while true; do
  if ((page_count >= 1000)); then
    printf 'Cloudflare container instance pagination exceeded the page limit\n' >&2
    exit 2
  fi
  page_count=$((page_count + 1))
  instance_args=(
    npx wrangler containers instances "$application_id"
    --config wrangler.jsonc --json --per-page 25
  )
  if [[ -n "$page_token" ]]; then
    seen_page_tokens["$page_token"]=1
    instance_args+=(--page-token "$page_token")
  fi
  instance_page=$("${instance_args[@]}")
  jq -c '.instances[]' <<<"$instance_page"
  next_page_token=$(jq -r '.result_info.next_page_token // empty' \
    <<<"$instance_page")
  if [[ -z "$next_page_token" ]]; then
    break
  fi
  if [[ -n "${seen_page_tokens[$next_page_token]:-}" ]]; then
    printf 'Cloudflare container instance pagination closed a cursor cycle after %d page(s); the enumeration is complete.\n' \
      "$page_count" >&2
    break
  fi
  page_token=$next_page_token
done
```

Cloudflare encodes the last row `id` in `next_page_token` and seeks from that
`id`. Rows use ascending `id` order, but the seek wraps from the highest `id`
to the lowest `id`. Therefore, the token chain can be circular and never return
an empty token. A repeated requested token closes the deterministic cursor chain.
The current page is already printed, so this condition completes the enumeration.
Cloudflare emits `next_page_token` if and only if rows remain, so a boundary confirmation notice does not identify a fault.

The audit also stops after one complete key-circle lap. It remembers the first
row `id` as the origin. A lower `id` proves that the traversal wrapped. The audit
stops when the page then reaches or passes the origin. For each page, the audit
counts positions whose `id` is less than or equal to its predecessor. Two or more
such positions disable the lap rule for that run. The audit then waits for an
empty token or a repeated requested token.

Cloudflare's paginated read can return duplicate rows for one instance `id`.
These duplicate rows are expected.
Collect the complete output before you read the rows.
Partition the collected rows with `partition_cloudflare_instances` from
`scripts/lib/orphan-select.jq`.
The function returns `{instances, ambiguous}`.
The `instances` array contains the collapsed records.
The `ambiguous` array contains the quarantined records.

Treat this command as the only authoritative source for running sandboxes and their `state`.

### Read the Worker registry

Run this command:

```bash
curl --fail-with-body --silent --show-error \
  --header "Authorization: Bearer $CONTROL_TOKEN" \
  "$WORKER_URL/runners"
```

After this Worker change is deployed, each response contains a `runners` array,
a numeric `pageSize`, and `nextCursor`. The deployed Worker can omit `pageSize`
until that deployment completes. The audit uses its pinned size of 100 when
`pageSize` is absent or `null`. It requires every reported `pageSize` to equal
100. The audit depends on this response field to detect a dropped final cursor.

Read `pageSize` and `nextCursor` from every response.
Require each reported `pageSize` to equal 100.
Use the pinned size of 100 when `pageSize` is absent or `null` during deployment.
Request another page when `nextCursor` is a non-empty string:

```bash
curl --fail-with-body --silent --show-error \
  --get \
  --data-urlencode "cursor=<nextCursor>" \
  --header "Authorization: Bearer $CONTROL_TOKEN" \
  "$WORKER_URL/runners"
```

Continue while `nextCursor` is a non-empty string.
Stop only when the final `runners` array is shorter than the applied `pageSize`.

> **CAUTION**
>
> A full final page without a cursor is an incomplete registry read.
> Do not use an incomplete registry read for a destroy decision.

### Read GitHub runner registrations

Run this command with `AUDIT_GITHUB_TOKEN` available to `gh`:

```bash
GH_TOKEN="$AUDIT_GITHUB_TOKEN" \
  gh api orgs/example-org/actions/runners \
  --method GET \
  --raw-field "name=<runnerName>"
```

Use the `runnerName` value from the orphan record. That is the exact runner
name the audit script queries: the Worker registry `githubRunnerName`, which
GitHub issued, or the derived `cloudflare-<uuid>` spelling when the sandbox has
no registry row.
GitHub returns 30 runners by default when a request lists all runners.
Use this command to list every page with the policy page size of 100:

```bash
GH_TOKEN="$AUDIT_GITHUB_TOKEN" \
  gh api --paginate --slurp \
  orgs/example-org/actions/runners \
  --method GET \
  --raw-field 'per_page=100' \
  --jq 'map(.runners) | add'
```

### Preserve the snapshot order

Read Cloudflare before the Worker registry.
Reversing these reads can classify a newly spawned sandbox as `absent-from-registry`.
The audit script enforces the correct order.

## Find an orphan

Run the audit locally in report mode:

```bash
unset GITHUB_REPOSITORY
WORKER_URL="$WORKER_URL" \
CONTROL_TOKEN="$CONTROL_TOKEN" \
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
GH_TOKEN="$AUDIT_GITHUB_TOKEN" \
GITHUB_RUNNER_SCOPE=organization \
WRANGLER_SEND_METRICS=false \
  scripts/orphan-audit.sh --json
```

Do not set `ORPHAN_GRACE_SECONDS`.

Dispatch a report-only workflow from GitHub Actions when local access is unavailable:

```bash
gh workflow run orphan-audit.yml
```

The audit reports these five classes:

| `reason` | Meaning |
| --- | --- |
| `unregistered` | A live sandbox has an old enough non-terminal registry row, but its expected GitHub runner is absent. |
| `terminal-registry-row` | A live sandbox has a `destroyed` Worker row. This state is inconsistent with the live Cloudflare instance. |
| `absent-from-registry` | A live sandbox has no Worker row and no matching GitHub runner registration. |
| `absent-from-cloudflare` | A non-terminal Worker row has no matching live Cloudflare instance. The record retains a matching inactive instance as evidence. |
| `registered-without-instance` | A GitHub runner registration and a non-terminal Worker row have no matching live Cloudflare instance. |

An `absent-from-registry` result has two indistinguishable causes.
The sandbox can lack an original row.
A leaked sandbox can also outlive the retention window after its terminal row was pruned.

### Review a `registered-without-instance` row

A `registered-without-instance` result identifies a possible ghost GitHub registration.
GitHub has the registration, but Cloudflare has no matching live instance.
The Worker row is non-terminal and old enough to pass the grace gate.

The `--destroy` option reports `operator-route-required` and sends no cleanup request.
Removing a live GitHub registration is destructive, so the audit never automates this action.

1. Copy `runnerName` from the orphan record.
2. Replace `<owner>`, `<repo>`, and `<runnerName>` in this command.
3. Run the query:

   ```bash
   gh api repos/<owner>/<repo>/actions/runners --raw-field name=<runnerName>
   ```

4. Find the runner with the exact `runnerName` value.
5. Record its `id` value.
6. Confirm that `status` is `offline`.
7. Confirm that `busy` is `false`.
8. Remove the confirmed ghost registration:

   > **WARNING**
   >
   > Never remove a runner that reports `online` or `busy: true`.
   > A registration can come online between the audit and this step.

   ```bash
   gh api -X DELETE repos/<owner>/<repo>/actions/runners/<id>
   ```

### JSON Lines records

Each `type: "orphan"` record contains these fields:

| Field | Meaning |
| --- | --- |
| `sandboxId` | The Cloudflare instance name or unmatched Worker sandbox identifier. |
| `instanceId` | The live Cloudflare instance identifier, or `null` when Cloudflare has no matching live instance. |
| `uuid` | The UUID after `runner-`, or `null` for another name. |
| `state` | The live Cloudflare instance state, or `null` when Cloudflare has no matching live instance. |
| `ageSeconds` | The registry age, or `null` when the row is absent. |
| `ageSource` | `worker-registry` or `unknown`. |
| `registryState` | The Worker state, or `null` when the row is absent. |
| `registryRevision` | The Worker revision for `absent-from-cloudflare` or `registered-without-instance`. This field is absent for other classes. |
| `registryCreatedAt` | The Worker creation time, or `null` when the row is absent. |
| `cloudflareCreated` | The validated raw live Cloudflare timestamp, or `null` when Cloudflare has no matching live instance. |
| `inactiveInstance` | A matching inactive Cloudflare instance as `{ id, state, created }`, or `null`. |
| `runnerName` | The exact GitHub runner name the audit queried, or `null` when no name could be resolved. This field is present for every class. |
| `reason` | `unregistered`, `terminal-registry-row`, `absent-from-registry`, `absent-from-cloudflare`, or `registered-without-instance`. |
| `destroyResult` | The cleanup result, skip result, operator requirement, or preparation failure. |
| `destroyHttpStatus` | The cleanup HTTP status, or `null` when no response exists. |

Each `type: "ambiguous-instance"` record contains these fields:

| Field | Meaning |
| --- | --- |
| `instanceId` | The shared Durable Object identifier. |
| `sandboxId` | The shared Durable Object name. |
| `uuid` | The UUID after `runner-`, or `null` for another name. |
| `reason` | The ambiguity classification. |
| `conflictingFields` | The sorted fields that caused quarantine. |
| `variants` | The complete Cloudflare input records, sorted by compact JSON. |

When available, the `type: "summary"` record identifies the audited fleet with these fields:

- `repository`
- `containerName`
- `applicationId`
- `graceSeconds`

The workflow step summary also shows these values and the destroy mode.
Exit code 2 can leave the JSON Lines output empty or partial.
Read `orphan-audit.stderr.log` when the summary record is unavailable.

The summary record contains this instance enumeration evidence:

| Field | Meaning |
| --- | --- |
| `instancePageCount` | The number of Cloudflare instance pages fetched. |
| `instanceBoundaryConfirmationCount` | The number of full Cloudflare boundaries that used a reduced-size confirmation read. |
| `instanceRowCount` | The number of Cloudflare rows returned before duplicate IDs collapse. |
| `instanceCount` | The number of collapsed, non-quarantined instances. |
| `liveInstanceCount` | The number of non-quarantined instances whose lowercase state is not `inactive`. |
| `instancePagination` | `exhausted`, `lap-closed`, or `cycle-closed`. Each value proves a complete enumeration. |

> **WARNING**
>
> Compare `liveInstanceCount` with the Cloudflare dashboard `active` gauge.
> Never compare it with the `instances` field or the LIVE INSTANCES column.
> Treat the comparison as incomplete when `ambiguousInstanceCount` is positive.

The tab-separated output uses snake-case field names.
It includes `instance_boundary_confirmation_count`, `ambiguous_instance_count`,
`ghost_registration_count`, and `finding_count`.

## Read the counters

Read the counters only when the `type: "summary"` record is available.
That record contains all sixteen counters:

| Field | Meaning |
| --- | --- |
| `instancePageCount` | The number of Cloudflare instance pages fetched. |
| `instanceRowCount` | The number of Cloudflare rows returned before duplicate IDs collapse. |
| `instanceCount` | The number of collapsed, non-quarantined instances. |
| `liveInstanceCount` | The number of non-quarantined instances whose lowercase state is not `inactive`. |
| `ambiguousInstanceCount` | The number of reported ambiguous instance records. |
| `orphanCount` | The number of reported orphan records. |
| `ghostRegistrationCount` | The number of `registered-without-instance` orphan records. |
| `findingCount` | The sum of `orphanCount` and `ambiguousInstanceCount`. |
| `destroyScheduledCount` | The number of cleanup requests newly scheduled or re-armed with HTTP 202. Mere acceptance never increments it. |
| `destroyAlreadyScheduledCount` | The number of accepted cleanup requests that were already scheduled and had no failed attempt. |
| `destroyReclaimedCount` | The number of absent Cloudflare instances reclaimed with HTTP 200. |
| `destroyAbsenceRecordedCount` | The number of first absence observations accepted with HTTP 202. |
| `destroyFailureCount` | The number of failed destroy requests or requests that left a failed cleanup unchanged. |
| `destroySkippedCount` | The number of unknown-age requests blocked by the age gate. |
| `destroyOperatorRequiredCount` | The number of orphans for which the audit sent no automated request and requires operator action. |
| `destroyRegisteredSkipCount` | The number of runners that registered before the final cleanup check. |

Only `destroyFailureCount` counts destroy failures.
The scheduled, already-scheduled, recorded, reclaimed, skipped,
operator-required, and registered-skip counters do not count destroy failures.

The non-request output policy is:

| Condition | `destroyResult` | Counter | Destroy failure |
| --- | --- | --- | --- |
| Destroy was not requested. | `not-requested` | None | No |
| The unknown-age gate blocked the request. | `skipped-unknown-age` | `destroySkippedCount` | No |
| The audit has no automated request for the class or lacks complete enumeration evidence. | `operator-route-required` | `destroyOperatorRequiredCount` | No |
| The runner registered before cleanup. | `skipped-now-registered` | `destroyRegisteredSkipCount` | No |

The callback destroy response policy is:

| HTTP response | `destroyResult` | Counter | Destroy failure |
| --- | --- | --- | --- |
| 202 with `cleanupStatus: scheduled` | `cleanup-scheduled` | `destroyScheduledCount` | No |
| 202 with `cleanupStatus: rearmed` | `cleanup-rearmed` | `destroyScheduledCount` | No |
| 202 with `cleanupStatus: already-scheduled` and `cleanupAttempts: 0` | `cleanup-already-scheduled` | `destroyAlreadyScheduledCount` | No |
| 202 with `cleanupStatus: already-scheduled` and `cleanupAttempts` above 0 | `cleanup-retrying` | `destroyFailureCount` | Yes |
| 204 | `already-destroyed-inconsistent` | `destroyFailureCount` | Yes |
| 404 | `callback-row-not-found` | `destroyFailureCount` | Yes |
| 409 | `cleanup-unschedulable` | `destroyFailureCount` | Yes |

HTTP 204 conflicts with Cloudflare's live state.
HTTP 409 means that the Worker cannot schedule cleanup for the current registry state.
The audit suppresses valid HTTP 202 bodies and prints every failure body.
An armed cleanup with failed attempts is stalled until its next alarm.
A no-op audit request reports `cleanup-retrying` and a destroy failure.

The absent-from-Cloudflare reclaim response policy is:

| HTTP response | `destroyResult` | Counter | Destroy failure |
| --- | --- | --- | --- |
| 200 with `outcome: reclaimed` | `reclaimed` | `destroyReclaimedCount` | No |
| 202 with `outcome: absence-recorded` | `absence-recorded` | `destroyAbsenceRecordedCount` | No |
| 409 | `cleanup-unschedulable` | `destroyFailureCount` | Yes |

These additional `destroyResult` values also increment `destroyFailureCount`:

- `cleanup-token-preparation-failed`
- `reclaim-request-preparation-failed`
- `sandbox-id-encoding-failed`
- `invalid-cleanup-response`
- `invalid-reclaim-response`
- `request-failed`
- `unexpected-http-status`

## Read the exit code

| Code | Meaning | Operator action |
| ---: | --- | --- |
| 0 | The audit found no findings. | Confirm the audited fleet fields. No cleanup is required. |
| 1 | The audit found findings and no destroy failed. Findings include orphans and ambiguous instances. | Read each record. Select the supported action below. |
| 2 | The audit had an operational failure. | Read the stderr record. Use the matching action below. |
| 3 | The audit found findings and at least one destroy failed. | Read every failure body. Escalate the failed cleanup before another destroy request. |

Do not destroy from an incomplete exit-code 2 snapshot.
Exit code 2 occurs when Cloudflare reports no instances while the Worker
registry has a `starting` or `online` row at least 60 seconds old.
Cloudflare pagination can return duplicate rows for one instance `id`.
The `id` and `name` fields identify the Durable Object.
These fields do not change.
The `state`, `location`, `version`, and `created` fields describe its current container deployment.
A restart, reschedule, or reboot loop can bind the Durable Object to another deployment.
That new binding can change all four deployment fields.

The audit reconciles changes in `state` and `created`.
For a lifecycle state change, the audit selects the most-alive value.
The audit uses this rank from least alive to most alive:

| State | Rank |
| --- | ---: |
| `inactive` | 0 |
| `unknown` | 1 |
| `stopped` | 2 |
| `failed` | 3 |
| `unhealthy` | 4 |
| `stopping` | 5 |
| `provisioning` | 6 |
| `running` | 7 |

After state selection, the audit keeps the earliest `created` value in the selected rows.
It pads timestamp fractions before it compares equal-second values.

The `location` field reports the placement of the current deployment.
The `version` field reports the application version of the current deployment.
The audit quarantines an ID when another field differs.
It also quarantines state case drift and an unranked state across duplicate rows.
A quarantined instance causes exit code 1 when no destroy fails.
The audit never destroys a quarantined instance.
The audit never reclaims its Worker registry row.
An operator must review the evidence.

### Read an ambiguous instance

| `reason` | Meaning | Operator action |
| --- | --- | --- |
| `conflicting-instance-records` | One or more non-reconcilable fields differ. | Read `conflictingFields` and every `variants` record. |
| `conflicting-instance-state-case` | One state has two case spellings. | Confirm the actual Cloudflare state. Escalate incorrect listing data. |
| `unknown-instance-state` | A duplicate group contains a state without a rank. | Confirm the state. Update the rank only after Cloudflare documents it. |

The `conflictingFields` array excludes `state` and `created`.
The audit reconciles those fields when no other ambiguity exists.
The `variants` array preserves the complete operator evidence.

### Read an exit-code 2 integrity failure

The audit uses exit code 2 when one ID has two names.
It also uses exit code 2 when two IDs share one name.

| Stderr text | Operator action |
| --- | --- |
| `conflicting Cloudflare instance records for id "<id>": field "name"` | Capture the reported ID and names. Escalate the broken ID-to-name mapping. Do not destroy from this snapshot. |
| `duplicate Cloudflare instance name "<sandbox-name>" has conflicting ids ["<id-1>","<id-2>"]` | Capture the sandbox name and all reported IDs. Escalate the Cloudflare disagreement. Do not re-run blindly. Do not destroy from this snapshot. |
| `Wrangler repeated a container instance page` | Treat this result as a transient pagination fault. Run the audit again. Escalate if the fault repeats. |
| `Cloudflare container instance list is unsound: a <full-size>-row page and a <reduced-size>-row page from the same cursor both ended without a next page token` | Capture the stderr record. Escalate the contradictory Cloudflare result. Do not re-run the audit. Do not destroy from this snapshot. |
| `Cloudflare container instance list may be truncated: a full page of <page-size> row(s) had no next page token and no smaller page size exists to confirm it` | Treat this result as a transient pagination fault. Run the audit again. Escalate if the fault repeats. Do not destroy from this snapshot. |
| `Worker repeated a runner registry page` | Treat this result as a transient pagination fault. Run the audit again. Escalate if the fault repeats. |
| `Worker runner registry list may be truncated: a full final page had no next cursor` | Treat this result as a transient pagination fault. Run the audit again. Escalate if the fault repeats. |
| `Worker repeated a runner registry cursor` | Treat this result as a transient pagination fault. Run the audit again. Escalate if the fault repeats. |

`operator-route-required` uses code 1 unless another destroy attempt fails.
`skipped-now-registered` also uses code 1 unless another destroy attempt fails.

## Triage an ambiguous instance

1. Read `sandboxId`, `instanceId`, `reason`, `conflictingFields`, and every `variants` record.
2. Confirm that all variants describe the same Durable Object.
3. Decide whether a deployment rebind explains the changed placement fields.
4. Treat an explained rebind as benign evidence.
5. Escalate the listing when a rebind does not explain the records.
6. Confirm the current Cloudflare, Worker, and GitHub state before cleanup.
7. Use the operator route only when current evidence proves a leak.

## Confirm the audited repository

GitHub Actions sets `GITHUB_REPOSITORY` to `example-org/gha-cloudflare-runner`.
The runner registrations belong to `example-org/example-repo`.

The script uses `GITHUB_REPOSITORY` when it is non-empty.
It reads `vars.GITHUB_REPOSITORY` only when that variable is empty.
[A real runner measurement](https://github.com/example-org/gha-cf-orphan-audit-proof/actions/runs/32550464346) proved the Actions behavior.
The Actions runner ignores an `env:` override of its `GITHUB_REPOSITORY` variable.
This behavior was measured, not assumed.
The workflow runs `unset GITHUB_REPOSITORY` in the audit shell.
Unsetting the variable in the shell is the only route that removes the runner value.
The audit must then resolve the repository from `wrangler.jsonc`.

GitHub Actions does not define `GITHUB_RUNNER_SCOPE`.
The workflow `env:` value therefore applies to that variable.
The workflow does not unset `GITHUB_RUNNER_SCOPE`.

Without that `unset`, a repository-scoped audit queries the wrong repository.
It can then classify every healthy repository runner as `unregistered`.
A destroy run could then stop live jobs.

The workflow requires a `type: "summary"` record for audit exit codes 0, 1, and 3.
Exit code 2 can occur before the audit writes that record.
When a summary exists, the workflow checks that `repository` equals the preflight `audit_repository` output.
A mismatch means that the audit inspected the wrong fleet.
It checks that `graceSeconds` equals the policy value of `60`.
A mismatch means that the run did not use the required grace policy.
It checks that `orphanCount` equals the number of `type: "orphan"` records.
It checks `ambiguousInstanceCount` against the `type: "ambiguous-instance"` records.
It checks `findingCount` against both finding record types.
Exit code 0 requires zero findings.
A positive finding count requires exit code 1 or 3.
Any mismatch changes the reported result to exit code 2.
A missing required summary also changes the reported result to exit code 2.
The step summary shows each assertion result as `passed`, `failed`, or `not-run`.

A destroy dispatch runs a separate report-only pass before it invokes `--destroy`.
The report pass writes `orphan-audit-report.jsonl` and `orphan-audit-report.stderr.log`.
The workflow requires a summary from that pass.
It checks the summary `repository` against the preflight `audit_repository`.
It also checks that the summary `graceSeconds` value is 60.
The workflow reports exit code 2 and never invokes `--destroy` when a check fails.
After all checks pass, the workflow runs the audit again with `--destroy`.
The destroy pass writes the reported result to `orphan-audit.jsonl` and `orphan-audit.stderr.log`.
The artifact preserves both passes.

> **CAUTION**
>
> Confirm `repository` before every destroy request.
> Stop when it does not equal `example-org/example-repo`.

Read `repository` in the workflow step summary.

## Check the sandbox identifier

All supported Worker cleanup routes require a `runner-<uuid>` sandbox identifier.
The UUID must be a lowercase UUIDv4.
The complete identifier must match this pattern:

```text
^runner-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
```

The audit can report a Cloudflare instance whose name starts with `runner-` but does not match this pattern.
It can also report a foreign name.
Do not dispatch a destroy run or call an operator route for either name.
Escalate the malformed or foreign instance for investigation.

## Destroy one `unregistered` orphan safely

> **CAUTION**
>
> `wrangler containers delete <ID>` deletes the container application, not one instance.
> Cloudflare provides no per-instance delete.
> Never run it as a cleanup step.

> **CAUTION**
>
> The audit schedule never destroys.
> Use a deliberate `workflow_dispatch` with `destroy: true`.
> Automatic destruction through the registry can turn a false positive into deleted production.

Run a report first.
Confirm that `repository` equals `example-org/example-repo`.
Confirm that the orphan has `reason: "unregistered"`.
Review `sandboxId`, `state`, `ageSeconds`, `ageSource`, and `registryState`.

Dispatch the destroy run:

```bash
gh workflow run orphan-audit.yml --field destroy=true
```

The workflow first runs the report-only checks described above.
It passes `--destroy` only after those checks pass for this deliberate input.
The audit remediates only `unregistered` through `DELETE /runners/<sandboxId>`.
It checks the matching GitHub registration again before the request.

A parked cleanup returns `cleanup-rearmed`. The request preserves
`cleanup_attempts` and re-arms the registry alarm. The alarm makes one further
cleanup attempt. If that attempt fails, the row re-parks and logs
`runner registry cleanup stalled` again. Fix the underlying cause, such as a
GitHub token that returns 403, before re-running the destroy pass. This
transition still increments `destroyScheduledCount`.

The audit never issues a Cloudflare destroy directly. The registry cleanup
path owns the `busy` and `online` checks that protect a runner during a job.

The callback route returns HTTP 404 when the registry row is absent.
It returns HTTP 204 when the row is terminal.
These responses follow from the callback route's registry claim rules.
The audit never sends this route for `absent-from-cloudflare`,
`absent-from-registry`, `registered-without-instance`, or
`terminal-registry-row`.

## Reclaim an `absent-from-cloudflare` row

The audit calls `POST /operator/orphans/<sandboxId>/reclaim` for this class.
It calls the route only when `--destroy` is set.
It also requires a complete Cloudflare instance enumeration from the same run.

The accepted enumeration outcomes are `cycle-closed`, `exhausted`, and
`lap-closed`.
The audit never invents this outcome.
It sends no reclaim request for another value.
It reports `operator-route-required` in that case.

The first request records the observation and returns HTTP 202.
The audit reports `destroyResult: "absence-recorded"`.
Wait at least 60 seconds before the next audit destroy run.
The second request must carry the same registry revision.
It returns HTTP 200 with `outcome: "reclaimed"` after successful cleanup.

The Worker rejects a row that is less than 60 seconds old.
It resets an observation after the existing observation retention period.
A revision change starts a new observation pair.
The Worker checks GitHub again after it claims the row.
It does not destroy a busy or online runner.
It still calls sandbox destroy when Cloudflare reported the sandbox as absent.
It then deletes a remaining registration and marks the row as destroyed.
The terminal update releases the matching capacity reservation.

The audit sends this body from the current run:

```json
{
  "observedRegistryCondition": "live",
  "expectedRevision": 7,
  "cloudflareAbsence": {
    "enumerationOutcome": "exhausted",
    "instanceCount": 3,
    "liveInstanceCount": 2,
    "pageCount": 1,
    "applicationId": "11111111-1111-4111-8111-111111111111"
  },
  "observedRegistration": {
    "outcome": "registration-not-found",
    "runnerName": "cloudflare-2-4503599627370520"
  }
}
```

The first accepted response has `outcome: "absence-recorded"` and a
`reclaimableAtMs` value.
The final accepted response has `outcome: "reclaimed"`.

Do not call `POST /operator/orphans/<sandboxId>/destroy` for this class.

## Use the operator route

The audit reports `operator-route-required` for `absent-from-registry` and
`terminal-registry-row`.
It also increments `destroyOperatorRequiredCount`.
This result is not a destroy failure.

Use `POST /operator/orphans/<sandboxId>/destroy` for these two classes.
Authenticate the request with `CONTROL_TOKEN`.

> **CAUTION**
>
> Read `observedSandboxInstanceId` from the audit record's `instanceId` for the same sandbox.
> The value must contain exactly 64 lowercase hexadecimal characters.
> Do not invent the value or reuse a value from an earlier sandbox generation.

### Use the supported operator tool

Use `scripts/operator-destroy-orphans.mjs` for the supported path.
The tool does not accept a sandbox identifier or instance identifier as an
argument.

The tool runs a report-only audit when `--audit-file` is absent.
It selects only the `absent-from-registry` and `terminal-registry-row` classes
for the operator route.
It then observes the complete current Worker registry and the matching GitHub
runner registration.

Run a local dry run with the audit environment from this runbook:

```bash
unset GITHUB_REPOSITORY
WORKER_URL="$WORKER_URL" \
CONTROL_TOKEN="$CONTROL_TOKEN" \
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
GH_TOKEN="$AUDIT_GITHUB_TOKEN" \
GITHUB_RUNNER_SCOPE="$AUDIT_RUNNER_SCOPE" \
WRANGLER_SEND_METRICS=false \
  scripts/operator-destroy-orphans.mjs
```

The default mode sends no destroy request.
Each result prints the exact route and JSON body that destroy mode would send.
A dry run returns code 0 when no result needs operator action and no operation
fails.

Add `--destroy` only after you review every printed request:

```bash
unset GITHUB_REPOSITORY
WORKER_URL="$WORKER_URL" \
CONTROL_TOKEN="$CONTROL_TOKEN" \
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
GH_TOKEN="$AUDIT_GITHUB_TOKEN" \
GITHUB_RUNNER_SCOPE="$AUDIT_RUNNER_SCOPE" \
WRANGLER_SEND_METRICS=false \
  scripts/operator-destroy-orphans.mjs --destroy
```

The operator route uses two calls for a newly observed sandbox generation.
The first operator destroy call records the orphan observation and returns
`inside-grace`.
Wait until the 60-second grace window ends.
Run the destroy command a second time with new live observations.
The second call after the grace window claims and destroys the sandbox.

A destroy run returns code 0 when all unresolved results are `inside-grace`.
The stderr message and the workflow step summary show the affected sandbox
count.
They also state that the observation is recorded and that a second run after
the grace window will destroy the sandboxes.

Use an existing destroy-mode audit record only when you must preserve that
Cloudflare evidence:

```bash
scripts/operator-destroy-orphans.mjs \
  --audit-file orphan-audit.jsonl
```

The file path must identify an orphan-audit JSONL record.
The tool acts only on records with `destroyResult: "operator-route-required"`.
The tool refuses an operator result whose class does not use this route.
Add `--destroy` after you review the dry-run output.

Dispatch the workflow in dry-run mode when local access is unavailable:

```bash
gh workflow run operator-destroy-orphans.yml
```

Set the explicit Boolean input to send the requests:

```bash
gh workflow run operator-destroy-orphans.yml -f destroy=true
```

The workflow archives the audit evidence, the operator results, and both stderr
logs.
The tool returns code 0 for a successful dry run.
It returns code 0 when all selected sandboxes reach `destroyed`.
It also returns code 0 when all unresolved results are `inside-grace`.
It returns code 0 when the audit selects no operator-route findings.
It returns code 1 for an action-required route outcome or a refused finding.
One action-required outcome makes a mixed result set return code 1.
It returns code 2 for an operational failure.
The tool sends one request for each selected sandbox.
It never retries `observation-mismatch` or `sandbox-generation-mismatch`.
Run the tool again to collect new observations for either outcome.

### Use manual curl as a fallback

Use this fallback only when the supported tool cannot run.
Keep the audit record open while you prepare each value.

1. Run the audit to identify the sandbox.
2. Observe the current Worker row and its `revision`.
3. Observe the matching GitHub runner registration.
4. Read `instanceId` from the audit record for that sandbox.
5. Prepare one of the following request bodies.

An absent-row request with no GitHub registration has this shape:

```json
{
  "observedRegistryCondition": "absent",
  "expectedRevision": null,
  "observedSandboxInstanceId": "<64 lowercase hexadecimal characters from instanceId>",
  "observedRegistration": {
    "outcome": "registration-not-found",
    "runnerName": "cloudflare-<uuid>"
  }
}
```

An `absent` condition has no registry row, so the Worker validates this name
against the sandbox identifier. Keep the derived `cloudflare-<uuid>` spelling
here. Every other condition uses the `runnerName` from the orphan record.

A terminal-row request with an offline, idle registration has this shape:

```json
{
  "observedRegistryCondition": "terminal",
  "expectedRevision": 7,
  "observedSandboxInstanceId": "<64 lowercase hexadecimal characters from instanceId>",
  "observedRegistration": {
    "outcome": "registration-found",
    "runnerId": 123456,
    "runnerName": "<runnerName from the orphan record>",
    "status": "offline",
    "busy": false
  }
}
```

Either `observedRegistration` outcome can accompany either registry condition.
Use the outcome that matches the live observation.
`runnerId` must be a non-negative safe integer.
`status` must be `online` or `offline`.
`busy` must be a Boolean.
The route compares the supplied observation with two live GitHub checks.

Save the selected body as `request.json`.
Call the route:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $CONTROL_TOKEN" \
  --header 'Content-Type: application/json' \
  --data @request.json \
  "$WORKER_URL/operator/orphans/<sandboxId>/destroy"
```

Read the returned outcome:

| Outcome | Meaning | Terminal resolution |
| --- | --- | --- |
| `destroyed` | The Worker validated the observations and destroyed the live sandbox. | Yes |
| `invalid-request` | The body, sandbox identifier, or instance-identifier observation is invalid. | No |
| `live-row` | The registry now has a live row. Use the callback or reconciliation route. | No |
| `observation-mismatch` | The current registry condition differs from `observedRegistryCondition`. | No |
| `revision-conflict` | The current terminal revision differs from `expectedRevision`. | No |
| `inside-grace` | The first call recorded the orphan observation. Call again after the 60-second grace window to destroy the sandbox. | No |
| `sandbox-generation-mismatch` | The observed instance identifier differs from the claimed sandbox generation. | No |
| `terminal-generation-unverified` | The terminal row has no instance identifier for its destroyed generation. | No |
| `claim-conflict` | The Worker could not create the cleanup claim for the current registry state. | No |
| `runner-busy` | The matching live GitHub runner is busy. | No |
| `runner-online` | An online GitHub runner has no terminal registry row. | No |
| `registration-observation-mismatch` | A live GitHub check differs from `observedRegistration`. | No |

### Creation-time blocker

Cloudflare's instance `created` field cannot identify the current sandbox generation.
It records the container application version's creation time, not the instance start time.

Two sandboxes spawned 48 seconds apart reported `2026-08-20T23:24:56.656999936Z`.
They reported the same stale value, which preceded both spawns by about 14.3 hours.
A creation-time contract could not distinguish those generations.
The stale value could also make a new sandbox appear older than the destruction grace.

The registry `createdAt` value is not a substitute.
A terminal row's `createdAt` always precedes its `destroyedAt`.
An absent row has no registry timestamp.

The route resolves this blocker with `observedSandboxInstanceId`.
Cloudflare supplies a live instance `id`, and the audit emits it as `instanceId`.
The identifier changes for each sandbox generation, so the audit can now supply it.

## Alerting and audit records

The primary alert is the job status.
Exit codes 1, 2, and 3 fail the job.
A red scheduled run is visible in the Actions tab.
It also triggers GitHub's scheduled-workflow failure notification.
A red hourly run means the audit found findings or had an operational failure.
A destroy failure also makes the run red.

This path is free and needs no secret.
It cannot be misconfigured by a missing alert secret.
It reaches only people who watch Actions or receive GitHub's notification.

The optional Slack webhook is the secondary path.
It sends exit codes 2 and 3 to a channel immediately.
It stays silent for exit code 1.
Findings alone need no page: the scheduled operator destroy workflow removes
the provable orphan classes, and an ambiguous instance record is a Cloudflare
listing artifact that the audit quarantines.
The job status, the step summary and the archived audit record still carry
every finding.
It also sends an alert when the job fails after a clean audit.
The alert identifies this case as `the workflow failed after a clean audit`.
It adds a secret and a second dependency that can fail.
The alert leads with the cause and the operator action.
It uses Slack Block Kit with a header, a colour, and a run link.
It reports counters only when the audit measured them.
It never prints a counter that the audit did not measure.
The workflow reports a Slack delivery failure as an error annotation and in the job log.
It prints the failed response body only in the job log.
The delivery failure never changes the audit's own result.

When the Slack secret is absent, the workflow creates a warning annotation.
It also adds a warning to the step summary.
The warning says that alerting uses only GitHub's workflow-failure notification.

Every audit invocation writes a JSON Lines file and a stderr file.
The workflow stores the available audit files for 90 days as a build artifact.
Find the artifact on the workflow run page under **Artifacts**.
Its name includes `github.run_id` and `github.run_attempt`.

The workflow skips the artifact upload when the audit step did not run.
Thus, a preflight failure does not produce a second missing-file failure.
The alert step still reports the preflight failure.

## Triage a red hourly run

1. Open the failed `Orphan audit` run in the Actions tab.
2. Read `Preflight the audit configuration` when that step failed.
3. Stop this procedure when the preflight failed.
4. Read the exit-code headline and destroy mode in the step summary.
5. Download the audit artifact.
6. Check whether `orphan-audit.jsonl` contains a `type: "summary"` record.
7. Read `orphan-audit.stderr.log` first when the summary is unavailable.
8. Confirm `repository` only when the summary is available.
9. Read all sixteen counters only when the summary is available.
10. Read every available finding record and `orphan-audit.stderr.log`.

Then follow the exit-code branch:

- For code 0 with a red job, inspect the other failed workflow step.
- For code 0 with a red job, escalate the workflow mechanism failure.
- For code 1, read each `reason` and `destroyResult`.
- For an ambiguous instance, use the ambiguity procedure above.
- For `cleanup-rearmed`, confirm that the registry alarm completes the cleanup.
- For `unregistered`, run another report and use the deliberate destroy procedure.
- For `absence-recorded`, wait until `reclaimableAtMs` and run another destroy audit.
- For `reclaimed`, confirm that the registry row is terminal.
- For an incomplete `absent-from-cloudflare` observation, run another complete audit.
- For `registered-without-instance`, follow the manual GitHub registration procedure above.
- For the other `operator-route-required` classes, collect live evidence and use the operator route.
- For `skipped-now-registered`, run another report before any cleanup.
- For code 2, repair the failed credential, Cloudflare query, Worker query, or GitHub query.
- For code 2, run another report after the repair.
- For code 2, escalate an external outage or a repeated operational failure.
- For code 3, read each failure body and `destroyResult`.
- For `cleanup-retrying`, escalate the unchanged failed cleanup.
- For code 3, escalate the failed cleanup before another destroy request.

A successful branch ends with a callback destroy, a reclaim, or a validated operator destroy.
An unprovable observation or an external failure ends with an escalation.
