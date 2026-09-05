# Autopilot listener operations

The listener control plane ships disabled. `AUTOPILOT_ENABLED` is unset in
`wrangler.jsonc`.

Create the required runner scale set in GitHub before you configure the Worker.
The listener never creates a runner scale set.

Set `AUTOPILOT_ENABLED=1` only after you create and configure the required
scale set. The disabled listener creates no session and starts no runner.

Set `outageGateUrl` in each `AUTOPILOT_SCALE_SETS` entry. The listener sends
one `POST` request for each runner request. The request contains the scale set,
runner request, repository, wave, and job deadline. The response must contain
the signed outage permit. The listener refuses the reservation when this URL
is unavailable or returns a non-success status.

Set `OUTAGE_GATE_TOKEN` as a runner Worker secret. Use the same listener token
on the separate outage-gate Worker. The listener authenticates each permit
request with this token.

Set `outageGateCloseUrl` to the outage-gate Worker's authenticated close route.
Recovery exhaustion and a routing-semantics quarantine each make the listener
send a `POST` close command.
The command contains the scale set identity, the close time, and the reason.
The listener uses `OUTAGE_GATE_TOKEN` for this request.
The listener records and throws an error when the close command fails.

## Create the runner scale set

A runner scale set is a group of homogeneous runners. GitHub assigns jobs to
the group through GitHub Actions. See [Runner scale sets][runner-scale-sets].

A scale set belongs to only one runner group. A workflow must reference the
scale set name. GitHub permits only one label on a scale set. See
[Runner scale sets][runner-scale-sets].

The Actions Runner Controller creates that label from the scale set name. See
[the scale set lifetime decision][scale-set-lifetime]. Therefore, the scale
set name is the `runs-on` value.

Name this project's scale set exactly `cloudflare-sandbox`.
`src/worker.js` rejects every other `RUNNER_LABELS` value. Every workflow
that targets this fleet uses `runs-on: cloudflare-sandbox`. The name is not an
operator choice.

Create the runner group before you create the scale set. A scale set name must
be unique inside its runner group. See
[Deploying runner scale sets][deploy-runner-scale-sets].

### Authorize the creating principal

Give the creating principal the permissions in this table. GitHub documents
these permissions for Actions Runner Controller. See
[Authenticating to the GitHub API][authenticate-arc].

| Level | GitHub App | Classic PAT | Fine-grained PAT |
| --- | --- | --- | --- |
| Repository | `Administration: Read and write`; `Metadata: Read-only` | `repo` | `Administration: Read and write` |
| Organization | `Metadata: Read-only`; `Self-hosted runners: Read and write` | `admin:org` | `Administration: Read`; `Self-hosted runners: Read and write` |

A GitHub App cannot authenticate runners at the enterprise level. See
[Authenticating to the GitHub API][authenticate-arc].

### Create the scale set with Actions Runner Controller

GitHub documents exactly one supported creation path. Deploy an
`AutoScalingRunnerSet` with Actions Runner Controller. See
[Deploying runner scale sets][deploy-runner-scale-sets].

Set the installation name to `cloudflare-sandbox`. Set `runnerGroup` to the
existing runner group. The installation name becomes the workflow `runs-on`
value. See [Deploying runner scale sets][deploy-runner-scale-sets].

The controller calls `POST _apis/runtime/runnerscalesets` on the Actions
Service. It uses a runner registration token with admin access. See
[the scale set lifetime decision][scale-set-lifetime].

### Find the runner group ID

GitHub documents a public REST endpoint for organization runner groups. Use
`GET /orgs/{org}/actions/runner-groups` at the organization level. Give the
token the `admin:org` scope. The response includes each group's `id` and
`name`. This endpoint is the supported organization-level option. See
[REST API endpoints for self-hosted runner groups][runner-group-rest-api].

WARNING: The Actions Service lookup uses an undocumented endpoint. GitHub can
change or remove it without notice.

The observed endpoint is
`GET <actionsServiceUrl>/_apis/runtime/runnergroups?api-version=6.0-preview`.
It uses the same handshake as the Worker and
`scripts/preflight-scale-set.sh`. The handshake exchanges a registration token
for the Actions Service URL and an admin token. The lookup uses the admin token
as a bearer token.

Set `REGISTRATION_TOKEN` to a repository registration token. Set `CONFIG_URL`
to the matching repository URL. Run this lookup:

```sh
(
  set -eu

  export REGISTRATION_TOKEN='REPLACE_WITH_REGISTRATION_TOKEN'
  export CONFIG_URL='https://github.com/OWNER/REPOSITORY'

  umask 077
  runner_group_file=$(mktemp)
  trap 'rm -f -- "$runner_group_file"' EXIT

  jq -cn --arg url "$CONFIG_URL" \
    '{url: $url, runner_event: "register"}' |
    curl --fail --silent --show-error \
      --request POST \
      --header "Authorization: RemoteAuth $REGISTRATION_TOKEN" \
      --header 'Content-Type: application/json' \
      --data-binary @- \
      --output "$runner_group_file" \
      'https://api.github.com/actions/runner-registration'

  actions_service_url=$(
    jq -er '
      .url | select(type == "string" and length > 0)
    ' "$runner_group_file"
  )
  admin_token=$(
    jq -er '
      .token | select(type == "string" and length > 0)
    ' "$runner_group_file"
  )

  http_status=$(
    curl --silent --show-error \
      --request GET \
      --header "Authorization: Bearer $admin_token" \
      --output "$runner_group_file" \
      --write-out '%{http_code}' \
      "${actions_service_url%/}/_apis/runtime/runnergroups?api-version=6.0-preview"
  )
  if [ "$http_status" != 200 ]; then
    printf 'Runner group lookup returned HTTP %s.\n' "$http_status" >&2
    exit 1
  fi

  jq -er '.value[] | [.id, .name] | @tsv' "$runner_group_file"
)
```

GitHub does not document this Actions Service endpoint. On 2026-08-23, it
returned HTTP 200 for `example-org/example-repo`. The response
contained exactly `Default` with ID `1` and `GitHub Actions` with ID `2`. This
observation shows the default runner group as `Default` with ID `1`. GitHub
does not document that ID as a guarantee.

### Understand the unsupported manual path

WARNING: The manual path uses an undocumented endpoint. GitHub can change or
remove it without notice.

GitHub publishes no public REST API endpoint that creates a runner scale set.
GitHub also documents no web UI action that creates one. The documented
creation page provides neither option. See
[Deploying runner scale sets][deploy-runner-scale-sets]. Do not treat the
manual path as a recommendation.

An operator who does not run Actions Runner Controller must reproduce the
controller call by hand:

1. Obtain a repository or organization runner registration token.
2. Send `POST https://api.github.com/actions/runner-registration`.
3. Set `Authorization: RemoteAuth <registrationToken>` on that request.
4. Send `{"url": "<configUrl>", "runner_event": "register"}` as its body.
5. Read the Actions Service URL and admin token from the response.
6. Set `Authorization: Bearer <adminToken>` on the creation request.
7. Send `POST <actionsServiceUrl>/_apis/runtime/runnerscalesets?api-version=6.0-preview`.

The Worker uses the same handshake for its read-only lookup. The creation
request body contains these fields. ARC sends a JSON `User-Agent` with its
build metadata; this tool sends `gha-cloudflare-runner-create-scale-set`;
the endpoint requirement is Unknown.

The source line numbers below are read at the commits in the pinned reference
links.

#### Request and response

| Item | Value | Source |
| --- | --- | --- |
| Path | `_apis/runtime/runnerscalesets`, from the `scaleSetEndpoint` constant | [scale-set-client] line 25 |
| Method | `POST` | [scale-set-client] lines 499-531 |
| Query | `api-version=6.0-preview`, defaulted when the caller sets no value | [scale-set-client] lines 314-321 |
| `Content-Type` | `application/json` | [scale-set-client] line 288 |
| `Authorization` | `Bearer <adminToken>`, using the token from the runner-registration handshake | [scale-set-client] lines 289 and 1078-1083 |
| `User-Agent` | ARC sends its own JSON build metadata. This tool sends its own identifier. Requirement Unknown. | [scale-set-client] lines 243-254 and 290 |
| Success status | `200`. ARC treats every other status as an error. | [scale-set-client] lines 521-523 |
| Response body | The created `RunnerScaleSet`. Its `id` is the scale set ID. Use it as `scaleSetId`. | [scale-set-client] lines 525-530; [arc-scale-set-controller] lines 586-589 |

#### Request body

Actions Runner Controller sends these fields in this order.

| JSON field | Value | Source |
| --- | --- | --- |
| `name` | The selected scale set name. | [actions/scaleset/types.go][scale-set-types] line 83; [autoscalingrunnerset_controller.go][arc-scale-set-controller] lines 517-519 and 575 |
| `runnerGroupId` | The selected runner group ID. | [actions/scaleset/types.go][scale-set-types] line 84; [autoscalingrunnerset_controller.go][arc-scale-set-controller] lines 525-535 and 576 |
| `labels[].type` | `System` for each label. | [actions/scaleset/types.go][scale-set-types] lines 64-67; [actions/scaleset/client.go][scale-set-client] lines 475-497 |
| `labels[].name` | The scale set name first, followed by unique extra labels. | [autoscalingrunnerset_controller.go][arc-scale-set-controller] lines 549-568 and 577 |
| `RunnerSetting.disableUpdate` | `true`. The capitalized parent key matches the Go JSON tag. | [actions/scaleset/types.go][scale-set-types] lines 87 and 143-145; [autoscalingrunnerset_controller.go][arc-scale-set-controller] lines 578-580 |
| `createdOn` | `0001-01-01T00:00:00Z`, which is the Go zero time. | [actions/scaleset/types.go][scale-set-types] line 88; [autoscalingrunnerset_controller.go][arc-scale-set-controller] lines 573-581 |

The ARC request omits `id`, `runnerGroupName`, `runnerJitConfigUrl`,
`statistics`, and other zero-value fields with `omitempty` tags.

Unknown: GitHub publishes no server-side requiredness for these fields. This
table records only the fields that Actions Runner Controller always sends.

### Create the scale set with the Worker secret

Use this endpoint when `GITHUB_TOKEN` exists only as a Worker secret.
The Worker uses that token to get an organization or repository registration
token.

Set `CONTROL_TOKEN` to the Worker control token.
Set `WORKER_URL` to the Worker HTTPS origin.
Set `runnerGroupId` to the existing runner group ID.
Run this organization-scope request:

```sh
export CONTROL_TOKEN='REPLACE_WITH_CONTROL_TOKEN'
export WORKER_URL='https://REPLACE_WITH_WORKER_HOST'

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $CONTROL_TOKEN" \
  --header 'Content-Type: application/json' \
  --data-binary '{"scaleSetName":"cloudflare-sandbox","runnerGroupId":1,"scope":{"type":"organization","organization":"example-org"}}' \
  "${WORKER_URL%/}/operator/scale-set/create"
```

The request body accepts only these fields:

| Field | Requirement |
| --- | --- |
| `scaleSetName` | Set the required string to `cloudflare-sandbox`. |
| `runnerGroupId` | Set a positive safe integer. |
| `scope` | Set an organization or repository scope object. |
| `configUrl` | Optionally set an HTTPS configuration URL. |

Use this organization scope shape:

```json
{"type":"organization","organization":"example-org"}
```

Use this repository scope shape:

```json
{"type":"repository","owner":"example-org","repository":"example-repo"}
```

The Worker derives `configUrl` when the request omits it.
An organization scope produces `https://github.com/<organization>`.
A repository scope produces `https://github.com/<owner>/<repository>`.
The Worker rejects an unknown field or an invalid value with HTTP 400.

The Worker returns HTTP 201 after creation:

```json
{"created":true,"scaleSet":{"id":72,"name":"cloudflare-sandbox","runnerGroupId":1}}
```

The Worker returns HTTP 200 when the scale set already exists:

```json
{"created":false,"scaleSet":{"id":71,"name":"cloudflare-sandbox","runnerGroupId":1}}
```

The lookup uses the `runnerGroupId` and `scaleSetName` pair.
The Worker does not create, update, or delete an existing scale set.
This behavior makes repeated requests idempotent.

The route returns HTTP 401 when the control token is invalid.
The route returns HTTP 405 for a method other than `POST`.
The route returns HTTP 500 when `GITHUB_TOKEN` is not configured.
An upstream failure returns HTTP 502 with this shape:

```json
{"error":"Failed to create the runner scale set","phase":"registration-token","detail":{"name":"ScaleSetRequestError","message":"The scale set request returned an unexpected status","status":403}}
```

The `phase` value identifies `registration-token`, `handshake`, `lookup`, or
`create`.
The response and the logs exclude the GitHub, registration, and admin tokens.

Creation uses four subrequests.
They get a registration token, perform the handshake, look up the scale set,
and create it.
An existing scale set uses three subrequests because the Worker omits creation.
Both costs are far below `RECONCILE_SUBREQUEST_BUDGET`, which is 900.
This route does not consume that budget.

Only an authenticated operator can start this route.
An alarm, recovery, reconcile, listener, or webhook cannot start this route.

### Create the scale set with this repository's tool

Run the tool without a mode flag to print the request:

```sh
scripts/create-scale-set.sh --scale-set cloudflare-sandbox
```

The default mode is an offline dry run. It validates the configuration and
makes no network request.

Use these modes only after you inspect the printed request:

| Mode | Result |
| --- | --- |
| No mode flag | Print the request without a network request. |
| `--live` | Resolve the Actions Service and check for an existing scale set. Do not create a scale set. |
| `--apply` | Perform the live checks, then send the creation request. |

The tool refuses creation when the selected runner group already contains the
scale set name. Use `--runner-group-id` to override the configured group ID.

After creation, the tool prints the new ID and an `AUTOPILOT_SCALE_SETS`
entry. The printed entry excludes `adminToken` and `privateKeyPkcs8`.

### Prevent dormant cleanup

GitHub deletes a dormant scale set after seven days without a connection. The
`DormantRunnerScaleSetCleanupJob` performs this cleanup. See
[the scale set lifetime decision][scale-set-lifetime].

An unset `AUTOPILOT_ENABLED` value prevents this listener from connecting.
Create the scale set close to the time when you set `AUTOPILOT_ENABLED=1`.
Otherwise, the scale set disappears and the fleet returns to
`scale-set-not-found`.

### Configure one scale set entry

`AUTOPILOT_SCALE_SETS` accepts three JSON shapes. Use an object keyed by scale
set name, one flat object, or an array of objects.

Choose one identity path:

- Set `scaleSetId` to use the known identity directly. The listener skips the
  live lookup.
- Set `runnerGroupId` and omit `scaleSetId` to look up the name in GitHub.

Add `runnerGroupId` to either path when you use the live preflight. The Actions
Service lookup cannot query by `scaleSetId` alone.

The listener selects an admin connection in this order:

1. It uses a complete static `actionsServiceUrl`, `adminToken`, and
   `adminTokenExpiresAtMs` trio while the token remains outside its refresh
   window.
2. It uses complete GitHub App credentials from the scale-set entry or the
   `GITHUB_APP_*` environment fallbacks.
3. It uses `githubToken` from the supplied configuration or the
   `GITHUB_TOKEN` Worker secret.

The usable static trio costs no API calls. The GitHub App is long-lived and
least-privilege, so it takes precedence over a broad PAT. An expired or
expiring static token does not take precedence.

The static trio is optional when `GITHUB_TOKEN` is set. Omit all three static
keys from `AUTOPILOT_SCALE_SETS` in this configuration.

WARNING: `AUTOPILOT_SCALE_SETS` is a `plain_text` binding. An operator can read
it through the Workers API or the Cloudflare dashboard. Do not put an admin
JWT or a `GITHUB_TOKEN` in this binding. Omitting the static trio removes the
admin JWT from this exposure.

For a repository-scoped runner, give `GITHUB_TOKEN` the classic PAT/OAuth
`repo` scope. Alternatively, give a fine-grained PAT **Administration: write**
on the repository. For an organization-scoped runner, give a classic PAT the
`admin:org` scope. Also give it `repo` when the repository is private.

### Configure the runner cleanup scope

Set the optional `GITHUB_RUNNER_SCOPE` Worker variable to match the scope of
the singular, deployment-wide `GITHUB_TOKEN`. The Worker uses this scope when
it lists and deletes registrations during registry cleanup.

| Value | Cleanup scope | Required fine-grained token permission |
| --- | --- | --- |
| Absent, empty, or `repository` | Each runner row's job repository | Repository `Administration: read and write` |
| `organization` | The owner in `GITHUB_REPOSITORY` | Organization `Self-hosted runners: read and write` |
| `organization:<org>` | The explicit organization | Organization `Self-hosted runners: read and write` |

The repository mode preserves the existing repository API paths. The
organization mode uses the organization runner API paths.

Do not derive this value from `AUTOPILOT_SCALE_SETS`. Autopilot is optional,
and a configuration with multiple scale sets has no singular configured scale
set. Cleanup must also work while autopilot is off.

Do not derive this value from a registry row. The row's `repository` value is
the job repository. The Worker keeps using it for the allowlist and logs. It
is not the runner registration scope, so the registry needs no new column.

Do not derive this value from `GITHUB_REPOSITORY_ALLOWLIST`. An organization-
scoped token still uses a repository allowlist for job attribution.

| Key | Requirement | Purpose | Result when absent |
| --- | --- | --- | --- |
| `scaleSetName` | Required identity | Sets the scale set name. `name` or the object key can supply it. | An array entry cannot resolve. A keyed entry uses its key. |
| `scaleSetId` | Conditional | Selects the scale set directly. | The listener uses `runnerGroupId` for a live lookup. |
| `runnerGroupId` | Conditional | Selects the runner group for a name lookup. | The listener requires a valid `scaleSetId`. The live preflight cannot query by ID alone. |
| `owner` | Required for a new session | Sets the listener owner. It also supplies an organization scope. | New session creation fails unless stored state already has an owner. |
| `repository` | Optional | Supplies a repository scope and its GitHub configuration URL. Use `owner/repository`. | The App and `GITHUB_TOKEN` paths use `owner` for an organization scope. |
| `wave` | Required before dispatch | Records the migration wave on an acquired job. | Acquisition fails with `The migration wave is missing`. |
| `workerUrl` | Conditional | Selects the Worker URL for runner starts. | The listener uses `AUTOPILOT_WORKER_URL`. A start fails when both values are absent. |
| `outageGateUrl` | Required before reservation | Requests a signed outage permit with `OUTAGE_GATE_TOKEN`. Use an HTTP or HTTPS URL. | The listener refuses the reservation when the URL or token is absent. |
| `outageGateCloseUrl` | Required for bounded recovery | Sends the close command with `OUTAGE_GATE_TOKEN`. | Recovery closure records an error and fails. |
| `actionsServiceUrl` | Conditional static input | Sets the HTTPS Actions Service base URL. | The listener tries the GitHub App path, then `GITHUB_TOKEN`. |
| `adminToken` | Conditional static input | Authorizes Actions Service requests. | The listener tries the GitHub App path, then `GITHUB_TOKEN`. |
| `adminTokenExpiresAtMs` | Conditional static input | Sets the admin token expiry as a positive safe integer. | The listener tries the GitHub App path, then `GITHUB_TOKEN`. |
| `appId` | Conditional GitHub App input | Identifies the GitHub App. | The listener uses `GITHUB_APP_ID`, then tries `GITHUB_TOKEN` when the App trio is incomplete. |
| `privateKeyPkcs8` | Conditional GitHub App input | Signs the GitHub App JWT. | The listener uses `GITHUB_APP_PRIVATE_KEY`, then tries `GITHUB_TOKEN` when the App trio is incomplete. |
| `installationId` | Conditional GitHub App input | Selects the GitHub App installation. | The listener uses `GITHUB_APP_INSTALLATION_ID`, then tries `GITHUB_TOKEN` when the App trio is incomplete. |
| `githubToken` | Conditional secret input | Mints a runner registration token without a GitHub App. | The listener uses `GITHUB_TOKEN`. Do not put this key in `AUTOPILOT_SCALE_SETS`. |
| `scope` | Optional override | Overrides the repository or organization registration scope. | The listener derives a repository scope from `repository`, or an organization scope from `owner`. |
| `configUrl` | Optional override | Sets the URL for the runner-registration handshake. | The listener derives a GitHub URL from `repository` or `owner`. |

### Confirm the scale set

Export `GITHUB_TOKEN`, or supply an existing registration token. Run this
read-only preflight before you enable the listener:

```sh
scripts/preflight-scale-set.sh \
  --scale-set cloudflare-sandbox \
  --live
```

The command reads `AUTOPILOT_SCALE_SETS`. It prints `scale set exists` with
the scale set ID and runner group ID after a successful lookup.

A missing scale set causes `ScaleSetNotFoundError` in the listener. The
recovery condition becomes `scale-set-not-found`. Exhausted recovery adds
`scale-set-not-found-exhausted` to `exhaustionMarkers` in
`GET /autopilot/listener/<name>`.

[runner-scale-sets]: https://docs.github.com/en/actions/concepts/runners/runner-scale-sets
[deploy-runner-scale-sets]: https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets
[authenticate-arc]: https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api
[runner-group-rest-api]: https://docs.github.com/en/rest/actions/self-hosted-runner-groups
[scale-set-lifetime]: https://github.com/actions/actions-runner-controller/blob/master/docs/adrs/2022-10-27-runnerscaleset-lifetime.md
[scale-set-client]: https://github.com/actions/scaleset/blob/cb0405b2d874500e75ae34eff8d582ab75956b45/client.go
[scale-set-types]: https://github.com/actions/scaleset/blob/cb0405b2d874500e75ae34eff8d582ab75956b45/types.go
[arc-scale-set-controller]: https://github.com/actions/actions-runner-controller/blob/a035c5a393bdefd226ff324531f74be55a912cbb/controllers/actions.github.com/autoscalingrunnerset_controller.go

## Bring up the fleet after a deploy

A deploy restarts every Durable Object. It discards in-memory state. It does
not delete stored state.

A Durable Object that has never run is different. A first deploy, a new scale
set name, or a migration that recreates the class produces a fresh
ScaleSetListener. A fresh listener seeds `mode = 'running'`. It schedules no
alarm. It polls nothing.

A fresh AutopilotControl seeds `approved_capacity = NULL`. The Worker reads
`NULL` as `UNAPPROVED_CAPACITY = 0`. It admits no runner.

Run the bootstrap after every deploy. The bootstrap is idempotent. It arms the
fleet on a fresh Durable Object. It confirms the armed state on a surviving
Durable Object. It changes nothing there.

Read the listener status after every deploy. A `heartbeatAgeMs` value of
`null` means no alarm has completed. An `armed: true` value in the resume
response means that request scheduled the first alarm.

### Configure the Worker

Keep the capacity approval private key on the owner's machine.

Set the deployment values in the operator shell:

```sh
export WORKER_URL='https://REPLACE_WITH_WORKER_HOST'
export SCALE_SET='cloudflare-sandbox'
export SCALE_SET_ID='REPLACE_WITH_SCALE_SET_ID'
export RUNNER_GROUP_ID='REPLACE_WITH_RUNNER_GROUP_ID'
export SCALE_SET_OWNER='REPLACE_WITH_SCALE_SET_OWNER'
export GITHUB_REPOSITORY='REPLACE_WITH_OWNER_AND_REPOSITORY'
export AUTOPILOT_WAVE='REPLACE_WITH_WAVE_NAME'
export OUTAGE_GATE_URL='https://REPLACE_WITH_OUTAGE_GATE/permit'
export OUTAGE_GATE_CLOSE_URL='https://REPLACE_WITH_OUTAGE_GATE/close'
export CONTROL_TOKEN='REPLACE_WITH_CONTROL_TOKEN'
export GITHUB_TOKEN='REPLACE_WITH_GITHUB_TOKEN'
export OUTAGE_GATE_PUBLIC_KEY='REPLACE_WITH_OUTAGE_GATE_PUBLIC_KEY'
export OUTAGE_GATE_TOKEN='REPLACE_WITH_OUTAGE_GATE_LISTENER_TOKEN'
export CAPACITY_APPROVAL_KEY='REPLACE_WITH_LOCAL_PRIVATE_KEY_PATH'
export AUTOPILOT_ENABLED='1'
export AUTOPILOT_SCALE_SETS="$(
  jq -cn \
    --arg scaleSet "$SCALE_SET" \
    --argjson scaleSetId "$SCALE_SET_ID" \
    --argjson runnerGroupId "$RUNNER_GROUP_ID" \
    --arg owner "$SCALE_SET_OWNER" \
    --arg repository "$GITHUB_REPOSITORY" \
    --arg wave "$AUTOPILOT_WAVE" \
    --arg workerUrl "$WORKER_URL" \
    --arg outageGateUrl "$OUTAGE_GATE_URL" \
    --arg outageGateCloseUrl "$OUTAGE_GATE_CLOSE_URL" \
    '{($scaleSet): {
      scaleSetName: $scaleSet,
      scaleSetId: $scaleSetId,
      runnerGroupId: $runnerGroupId,
      owner: $owner,
      repository: $repository,
      wave: $wave,
      workerUrl: $workerUrl,
      outageGateUrl: $outageGateUrl,
      outageGateCloseUrl: $outageGateCloseUrl
    }}'
)"
```

Create the capacity approval public value from the local owner key:

```sh
export CAPACITY_APPROVAL_PUBLIC_KEY="$(
  scripts/sign-capacity-approval.sh \
    --key "$CAPACITY_APPROVAL_KEY" \
    --public-key
)"
```

Store the five required Worker secrets:

```sh
printf '%s' "$CAPACITY_APPROVAL_PUBLIC_KEY" | \
  npx wrangler secret put CAPACITY_APPROVAL_PUBLIC_KEY
printf '%s' "$CONTROL_TOKEN" | npx wrangler secret put CONTROL_TOKEN
printf '%s' "$GITHUB_TOKEN" | npx wrangler secret put GITHUB_TOKEN
printf '%s' "$OUTAGE_GATE_PUBLIC_KEY" | \
  npx wrangler secret put OUTAGE_GATE_PUBLIC_KEY
printf '%s' "$OUTAGE_GATE_TOKEN" | npx wrangler secret put OUTAGE_GATE_TOKEN
```

Deploy with the two required autopilot variables:

```sh
npm run deploy -- \
  --var "AUTOPILOT_ENABLED:$AUTOPILOT_ENABLED" \
  --var "AUTOPILOT_SCALE_SETS:$AUTOPILOT_SCALE_SETS"
```

`AUTOPILOT_ENABLED` and `AUTOPILOT_SCALE_SETS` are not in `wrangler.jsonc`.
A deployment without these arguments leaves the fleet disabled.

For organization-scoped cleanup, also deploy the cleanup scope variable:

```sh
npm run deploy -- \
  --var "AUTOPILOT_ENABLED:$AUTOPILOT_ENABLED" \
  --var "AUTOPILOT_SCALE_SETS:$AUTOPILOT_SCALE_SETS" \
  --var "GITHUB_RUNNER_SCOPE:organization"
```

Omit `GITHUB_RUNNER_SCOPE` for repository-scoped cleanup.

### Sign the capacity approval locally

Select the capacity. The repository does not select a default capacity.

Create a restrictive temporary file for the signed approval:

```sh
export APPROVED_CAPACITY='REPLACE_WITH_OWNER_SELECTED_CAPACITY'
export APPROVED_BY='REPLACE_WITH_OWNER_NAME'
approval_file=$(mktemp)
chmod 600 "$approval_file"
trap 'rm -f -- "$approval_file"' EXIT
scripts/sign-capacity-approval.sh \
  --key "$CAPACITY_APPROVAL_KEY" \
  --approved-by "$APPROVED_BY" \
  --capacity "$APPROVED_CAPACITY" \
  --effective-at-now > "$approval_file"
```

The private key does not leave the owner's machine. Never put it in a
workflow input or a repository secret.

### Use the bootstrap workflow

Set the repository configuration for the workflow:

```sh
gh variable set WORKER_URL --body "$WORKER_URL"
printf '%s' "$CONTROL_TOKEN" | gh secret set CONTROL_TOKEN
```

Dispatch the workflow without putting the approval on the command line:

```sh
jq -n \
  --arg scale_set "$SCALE_SET" \
  --rawfile capacity_approval "$approval_file" \
  '{scale_set: $scale_set, capacity_approval: $capacity_approval}' | \
gh workflow run bootstrap-fleet.yml --json
```

Open the run URL that `gh` prints. Check the status table in the job log and
the job summary.

### Use raw control requests

Apply the same signed approval without the workflow:

```sh
worker_url=${WORKER_URL%/}
encoded_scale_set=$(jq -nr --arg value "$SCALE_SET" '$value | @uri')

curl --fail-with-body --silent --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --request POST \
  --header "Authorization: Bearer $CONTROL_TOKEN" \
  --header 'Content-Type: application/json' \
  --data-binary "@$approval_file" \
  --write-out '\nHTTP %{http_code}\n' \
  "$worker_url/autopilot/control/capacity"

# Resume is idempotent, so transport retries are safe.
curl --fail-with-body --silent --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 3 \
  --retry-all-errors \
  --request POST \
  --header "Authorization: Bearer $CONTROL_TOKEN" \
  --write-out '\nHTTP %{http_code}\n' \
  "$worker_url/autopilot/listener/$encoded_scale_set/resume"
```

Verify the listener status without printing its session identifier:

```sh
curl --fail-with-body --silent --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 3 \
  --retry-all-errors \
  --header "Authorization: Bearer $CONTROL_TOKEN" \
  "$worker_url/autopilot/listener/$encoded_scale_set" | \
jq '{
  mode,
  enabled,
  configured,
  advertisedMaxCapacity,
  alarmGeneration,
  heartbeatAgeMs,
  sessionIdPresent
}'
```

Verify the capacity control status:

```sh
curl --fail-with-body --silent --show-error \
  --connect-timeout 10 \
  --max-time 30 \
  --retry 3 \
  --retry-all-errors \
  --header "Authorization: Bearer $CONTROL_TOKEN" \
  "$worker_url/autopilot/control" | \
jq '{localGate, approvedCapacity, maxCapacity, liveReservationCount}'
```

### The fleet is inert

Check these status values:

| Status value | Cause | Fix |
| --- | --- | --- |
| `enabled: false` | `AUTOPILOT_ENABLED` is not `1`. | Deploy again with `AUTOPILOT_ENABLED=1`. |
| `configured: false` | `AUTOPILOT_SCALE_SETS` does not describe this scale set. | Correct the scale set JSON and deploy again. |
| `mode: stopped` or `mode: drained` | An operator action or a listener failure stopped polling. | Diagnose `stoppedReason`, then resume the listener. |
| `advertisedMaxCapacity: 0` with `mode: running` | The approval is absent or zero, or the local gate is closed. | Apply an owner-signed positive approval. Resume the control gate if it is closed. |
| `heartbeatAgeMs: null` | No listener alarm has completed. | Resume the listener, then read status again. |
| `heartbeatAgeMs` greater than `60000` | The alarm chain is stale. | Diagnose the listener, then rearm the observed `alarmGeneration`. |

## Approve a capacity

Create an Ed25519 owner key, configure the Worker, sign an approval, and send
it to the capacity control route.

### Create the owner key

Generate the owner key and print its standard base64 public value:

```sh
openssl genpkey -algorithm ed25519 -out capacity-approval.key
openssl pkey -in capacity-approval.key -pubout -outform DER | tail -c 32 | base64 -w0
```

`tail -c 32` strips the 12-byte DER SPKI header and leaves the raw 32-byte key.
The decoded value must contain exactly 32 bytes.

WARNING: The `base64 -w0` output is standard base64. The Worker accepts only
unpadded base64url.

Replace `+` with `-`.
Replace `/` with `_`.
Remove the trailing `=`.

This command prints exactly the value to use:

```sh
scripts/sign-capacity-approval.sh --key capacity-approval.key --public-key
```

The operator does not have to convert the value by hand.

### Set the public key

`wrangler.jsonc` declares `CAPACITY_APPROVAL_PUBLIC_KEY` as a required secret.
Set the secret from the tool output:

```sh
scripts/sign-capacity-approval.sh --key capacity-approval.key --public-key | npx wrangler secret put CAPACITY_APPROVAL_PUBLIC_KEY
```

### Sign an approval

Sign a capacity approval:

```sh
scripts/sign-capacity-approval.sh \
  --key capacity-approval.key \
  --approved-by OWNER_NAME \
  --capacity 1 \
  --effective-at-now
```

Standard output contains the request payload. Standard error contains the
summary.

The canonical JSON carries `approvedBy`, `capacity`, and `effectiveAtMs` in
that exact key order. The signature is base64url.

### Send the approval

Set `CONTROL_TOKEN` to the deployed Worker control token.
Set `WORKER_URL` to the deployed Worker URL.
Send the signed payload:

```sh
scripts/sign-capacity-approval.sh \
  --key capacity-approval.key \
  --approved-by OWNER_NAME \
  --capacity 1 \
  --effective-at-now | \
curl -X POST \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "$WORKER_URL/autopilot/control/capacity"
```

A successful response contains `"recorded":true` and the approved capacity.

Use `--curl` as an alternative that prints the sendable command:

```sh
scripts/sign-capacity-approval.sh \
  --key capacity-approval.key \
  --approved-by OWNER_NAME \
  --capacity 1 \
  --effective-at-now \
  --curl \
  --worker-url "$WORKER_URL"
```

The Worker refuses the approval when the key or the signature is invalid.
The approved capacity cannot exceed `MAX_ACTIVE_RUNNERS`.
The script refuses a larger capacity locally too.

### Protect the private key

Keep `capacity-approval.key` on the owner's machine.
Never commit the private key.
The tooling never prints the private key.

## Recover from capacity zero

First, record a signed positive capacity approval.
Then, call `/autopilot/listener/SCALE_SET/resume` for each stopped scale set.
Call `/autopilot/control/resume` too when the local gate is closed.
The control resume request does not rearm a stopped listener.

## Read listener status

Send an authenticated request:

```sh
curl \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  "https://WORKER/autopilot/listener/SCALE_SET"
```

Check these fields:

- `mode` shows `running`, `drained`, or `stopped`.
- `alarmGeneration` identifies the current alarm chain.
- `heartbeatAgeMs` shows the time since the last poll iteration.
- `cursor` shows the last acknowledged message identifier.
- `sessionIdPresent` shows whether the listener owns a session.
- `latestStatistics` shows the last GitHub queue statistics.
- `scaleUp` shows active dispatch work and the last allocated sequence.
- `startGate` shows the last refusal and the last successful gate closure.
- `liveIntents` shows unresolved acquisition work.
- `outboxDepth` shows dispatch work for each state.
- `recoveries` shows cumulative attempts and the next attempt time.
- `quarantinedMessages` shows messages that stopped starts.
- `exhaustionMarkers` shows recovery conditions that need operator action.
- `exportRecords` shows the durable structured records for this phase.

The status response never includes a session token, an admin token, or a JIT
configuration.

### Diagnose statistics-driven scale-up

Read these structured events:

| Event | Meaning |
| --- | --- |
| `scale-up-evaluated` | The listener evaluated a positive shortfall. The record includes `desired`, `shortfall`, `admitted`, and the census fields. |
| `scale-up-start-admitted` | The listener persisted one admitted start. The record identifies the runner request, correlation, repository, and wave. |
| `scale-up-refused` | The listener refused scale-up for one guard reason. |

`scale-up-evaluated` and `scale-up-refused` use in-memory deduplication.
A steady condition reports once. `scale-up-start-admitted` is never suppressed.

Use these `scale-up-refused` reasons:

| Reason | Meaning |
| --- | --- |
| `statistics-unavailable` | The stored statistics do not contain valid assigned-job and registered-runner counts. |
| `repository-unconfigured` | Neither `config.repository` nor `env.GITHUB_REPOSITORY` supplies a valid repository. |
| `repository-attribution-ambiguous` | `GITHUB_REPOSITORY_ALLOWLIST` does not hold exactly the attributed repository. |
| `request-id-space-exhausted` | `listener_state.scale_up_sequence` cannot allocate another positive safe identifier in the reserved band. |

Read these fields in `status().scaleUp`:

| Field | Meaning |
| --- | --- |
| `activeDispatches` | The count of active dispatch rows. |
| `unreservedDispatches` | The count of active dispatch rows that hold no reservation. |
| `lastSequence` | The last monotonic offset allocated for a listener runner request identifier. |

Treat a runner request identifier at or above `2 ** 52` in listener state as
listener-owned. The same value from GitHub stops the listener with
`routing-semantics:reserved-runner-request-id`.

The Worker releases a reservation when it destroys its runner. The
`AutopilotControl` match uses the exact `sandbox_id`. A `JobCompleted` message
releases an acquired start by its runner request identifier.
`ACTIVE_RUNNER_CLEANUP_DELAY_MS` is the backstop for a reservation whose runner
is never destroyed.

Read `nextReclaimAtMs` from `/autopilot/control` to find the next scheduled
capacity release. Read `/autopilot/control/reservations` for row details and
table-wide state counts. Follow `nextCursor` until it is null. Each page has at
most 100 rows, and `hasMore` is true exactly when `nextCursor` is not null.

Read `reclaimAtMs` and `live` on each reservation. Interpret automatic
compensation with these reasons:

| Reason | Meaning |
| --- | --- |
| `reclaim-time-missing` | The state needs a reclaim timestamp, but its operand is null. |
| `timestamps-inconsistent` | The row's timestamps cannot come from the reservation writer sequence. |
| `expired` | A requested, reserved, or start-created row reached its expiry. |
| `runner-horizon-exceeded` | A consumed row reached the runner cleanup horizon. |

If `desired > 0` and `shortfall` is `0`, read
`liveReservationCount` from `/autopilot/control`.

### Diagnose outage-gate refusals

Read these fields in `status().startGate`:

| Field | Meaning |
| --- | --- |
| `lastRefusal` | The last refused start. It can contain the reason, upstream status, gate metadata, repository, and runner request identifier. |
| `lastRefusalAtMs` | The time of the last refused start. |
| `lastClosedReason` | The reason for the last successful close command from this listener. |
| `lastClosedAtMs` | The time of the last successful close command from this listener. |

Use these `runner-spawn-failed` reasons for the external outage gate:

| Reason | Meaning |
| --- | --- |
| `outage-gate-url-unconfigured` | The scale set has no permit URL. |
| `outage-gate-url-invalid` | The permit URL is not a valid HTTP or HTTPS URL. |
| `outage-gate-token-unconfigured` | The listener has no `OUTAGE_GATE_TOKEN`. |
| `outage-gate-unreachable` | The permit request did not receive an HTTP response. |
| `outage-gate-invalid-response` | A successful response did not contain JSON permit data. |
| `outage-gate-closed` | The gate returned `gate-closed`. The listener does not reserve or start a runner. |
| `outage-gate-refused` | Another non-success response refused the permit request. |

A non-success HTTP response adds `upstreamStatus` to the failure record.
A valid JSON body can add `gateReason`, `gateGeneration`, and `gateClosedAtMs`.
The listener omits invalid or absent gate metadata.

#### Diagnose lost-start reconciliation

Use `runner-start-reconcile-attempted` to count every lost-start
reconciliation. The record appears before the reconciliation changes the
outbox state.

Read these `reason` values:

| Reason | Trigger |
| --- | --- |
| `jit-config-missing` | `#issueStart` finds no JIT configuration before a start. |
| `start-response-ambiguous` | A start request throws and its result needs reconciliation. |
| `deadline-exceeded-after-start` | Drain finds a `start-requested` row past its start deadline. |

Read these `outcome` values:

| Outcome | Meaning |
| --- | --- |
| `start-recovered` | The registry contains the correlated start. |
| `start-absent` | The registry does not contain the correlated start. |

Read these `startErrorClass` values for a thrown start request:

| Class | Meaning |
| --- | --- |
| `budget-exhausted` | The request budget ended before the start request left the Worker. |
| `aborted` | The Worker sent the request and then aborted it at its deadline. |
| `request-failed` | Another request error caused the reconciliation. |

The field is `null` when no thrown start request caused the reconciliation.
`last_error` is cleared on a reconciled success by design. This record is the
durable path marker.

### Recover the external start gate

Recovery exhaustion closes the outage gate. A routing-semantics quarantine
also closes the outage gate. No listener operation opens the gate
automatically.

`resume` rearms the listener but does not open the outage gate. A resumed
listener fails every admitted start with `outage-gate-closed` while the gate
stays closed.

Diagnose the closure reason before you open the gate. Set
`OUTAGE_GATE_ADMIN_TOKEN` and `OUTAGE_GATE_URL`. Open the gate with an operator
reason and identity:

```sh
scripts/outage-gate.sh open --reason 'REMEDIATION_REASON' --actor 'OPERATOR_NAME'
```

Re-check the authoritative gate state:

```sh
scripts/outage-gate.sh status
```

Confirm that the response contains `"state":"open"`. Resume the listener if
it remains stopped.

## Recover a routing-semantics stop

A `stoppedReason` of `routing-semantics:<reasons>` means that the listener
refused to guess at a message that it did not recognise. It stops, closes the
outage start gate, and deletes its session. This stop is deliberate and is
never retried automatically.

Read `quarantinedMessages` in the listener status. Each entry contains `reason`
and the truncated `messageType` of the offending batch entry.

`unassigned-job-completion` is not a quarantine. It is a `JobCompleted` entry
that GitHub sends with `runnerRequestId: 0` for a job that reached a terminal
state without ever being assigned a runner request on this scale set. The
listener ignores these entries and keeps running. The `message-polled` record
counts them in `ignoredCount` and `ignoredReasons`.

`stale-job-assignment` is not a quarantine. It is a `JobAssigned` entry with
`runnerRequestId: 0`. It means GitHub retracted an assignment from a previous
session. The entry has no acquirable runner request. The listener ignores these
entries and keeps running. The affected workflow runs do not resume
automatically. The operator redispatches them with
`scripts/rescue-queued-runs.sh`.

Fix a genuine quarantine with a code change, not a rearm. Confirm the message
shape against the reference client at `github.com/actions/scaleset`. Read
`types.go` and `parseRunnerScaleSetMessageResponse` in `client.go` before
changing any validator.

After the fix is deployed, apply the signed capacity approval. Reopen the
outage gate. Rearm the listener. Then redispatch the affected workflow runs.
GitHub retracts the jobs assigned to the stopped session as `JobCompleted`
entries with `result: "canceled"`. These jobs do not resume automatically.

## Stop the listener

Send a reason with the stop request:

```sh
curl \
  -X POST \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"operator maintenance"}' \
  "https://WORKER/autopilot/listener/SCALE_SET/stop"
```

A successful response sets the advertised capacity to `0` and removes the next
alarm. GitHub message session deletion is best effort. The `sessionDeleted`
field reports the deletion result.

The stop request is idempotent. An external rearm request cannot undo this
deliberate stop.

## Drain the listener

Send an authenticated drain request before a control-plane deployment:

```sh
curl \
  -X POST \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  "https://WORKER/autopilot/listener/SCALE_SET/drain"
```

The listener refuses new acquisition and starts no runner. It cancels
undispatched requests and settles starts that were already issued.

A drain abandons every request that the listener acquired from GitHub but had
not started. Those jobs return to GitHub's queue only after GitHub's own
assignment timeout. The listener emits `runner-start-cancelled` for each
cancelled dispatch. It emits one `runner-acquisitions-cancelled` event for the
cancelled acquisition intents. That event contains the count and request IDs.

An ambiguous acquisition cannot resolve while the listener is drained. The
drained alarm does not poll GitHub or call `AcquireJobs`. The drain cancels the
ambiguous intent and includes it in `runner-acquisitions-cancelled`.

This delay is deliberate. Starting a runner instead can let the deployment
kill it during a job and also consumes paid capacity.

A completed drain has an empty outbox and no poll, acknowledgement,
acquisition, or dispatch operation in progress. The runner registry also has
no runner in `starting`, `online`, or `destroying` state. The listener deletes
the session only after all of these conditions hold.

A `drained: true` response is a point-in-time snapshot. The deployment gate
must keep capacity closed after this response.

## Resume the listener

Send an authenticated resume request:

```sh
curl \
  -X POST \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  "https://WORKER/autopilot/listener/SCALE_SET/resume"
```

Resume clears recovery records and a deliberate stop. It rearms the listener.
Resume is the only request that can undo a deliberate stop.
Resume does not open the external outage gate.

GitHub message session reclamation is best effort. If GitHub rejects the
deletion, resume completes and returns `sessionDeleted: false`. The alarm loop
reconciles the persisted session.
The `sessionDeleted` field appears on the response that changes the mode.

The resume request is idempotent.

## Rearm a stale alarm

The heartbeat is stale when `heartbeatAgeMs` exceeds `60000`.

Close the external start gate before an external rearm. Send the observed
generation to the listener:

```sh
curl \
  -X POST \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requestedGeneration":OBSERVED_GENERATION}' \
  "https://WORKER/autopilot/listener/SCALE_SET/rearm"
```

Confirm that the returned `alarmGeneration` is later than the observed
generation. Then confirm a heartbeat from the later generation.

Rearm can recover a listener that a failure stopped. It does not clear a
recovery exhaustion marker. Rearm refuses a deliberate stop by design. A timer
cannot undo an operator's decision.

## Recovery exhaustion markers

`session-reclaim-exhausted` means that six session-conflict attempts failed,
or the cumulative failure time reached 15 minutes.

`github-rate-recovery-exhausted` means that GitHub rate-limit recovery reached
the same bound.

`scale-set-not-found-exhausted` means that GitHub did not find the configured
scale set within the same bound.

Diagnose the condition before you clear a marker. Open the required start
gates after the diagnosis.

Use the listener resume request for the explicit operator reset. A successful
retry also clears its condition automatically.

## Session and alarm survival

SQLite stores the session identifier, queue URL, queue token, acknowledged
cursor, and latest statistics.

A Durable Object eviction does not remove this state. A replacement instance
resumes the same session and cursor.

Each alarm records a later generation and rearms before it does other work.
The alarm stops polling before its 15-minute wall limit.

The next alarm continues the persisted session. An alarm handoff does not
delete or replace the session.
