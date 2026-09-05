# Outage gate

This Worker is the external start gate for the autonomous runner path. A fresh
gate starts closed. An operator must open it before the Worker issues permits.

## Why this service uses a Durable Object

Cloudflare KV is eventually consistent. A write can take approximately 60
seconds to propagate globally. A KV read could therefore report an open gate
for the first minute of an incident.

The `OutageGate` Durable Object provides one authoritative instance. Its
transactional SQLite state survives eviction, restart, and redeploy. The Worker
uses `idFromName("singleton")` for every request.

## Deploy

Use the [outage-gate deploy workflow](../.github/workflows/deploy-outage-gate.yml)
to deploy only this Worker.

Generate an Ed25519 key on the operator machine:

```sh
openssl genpkey -algorithm ed25519 -out outage-gate.key
```

Create the runner listener token and the operator admin token. Each token must
contain at least 32 characters. Do not reuse the runner Worker's
`CONTROL_TOKEN`.

Store these required secrets on the outage-gate Worker:

- `OUTAGE_GATE_PRIVATE_KEY` contains unpadded base64url PKCS#8 DER.
- `OUTAGE_GATE_TOKEN` authorizes permit and close requests from the listener.
- `OUTAGE_GATE_ADMIN_TOKEN` authorizes operator open, close, and status requests.

Use the operator tool to create the signing secret:

```sh
scripts/outage-gate.sh secret \
  --key outage-gate.key \
  --i-understand-this-prints-a-private-key | \
npx wrangler secret put OUTAGE_GATE_PRIVATE_KEY \
  --config outage-gate/wrangler.jsonc
```

Store both tokens without putting them in command arguments:

```sh
printf '%s' "$OUTAGE_GATE_TOKEN" | \
  npx wrangler secret put OUTAGE_GATE_TOKEN \
    --config outage-gate/wrangler.jsonc
printf '%s' "$OUTAGE_GATE_ADMIN_TOKEN" | \
  npx wrangler secret put OUTAGE_GATE_ADMIN_TOKEN \
    --config outage-gate/wrangler.jsonc
```

Deploy the separate Worker:

```sh
npx wrangler deploy --config outage-gate/wrangler.jsonc
```

Set the runner Worker's `OUTAGE_GATE_TOKEN` to the same listener token. Set its
`OUTAGE_GATE_PUBLIC_KEY` from this command:

```sh
scripts/outage-gate.sh public-key --key outage-gate.key
```

The production repository allow-list is in `outage-gate/wrangler.jsonc`.

## Operate the gate

Set the base Worker URL and the admin token in the operator shell:

```sh
export OUTAGE_GATE_URL='https://gha-outage-gate.REPLACE.workers.dev'
export OUTAGE_GATE_ADMIN_TOKEN='REPLACE_WITH_ADMIN_TOKEN'
```

Open the gate:

```sh
scripts/outage-gate.sh open \
  --reason 'incident ended' \
  --actor 'operator-name'
```

Close the gate:

```sh
scripts/outage-gate.sh close --reason 'incident started'
```

Read the gate status:

```sh
scripts/outage-gate.sh status
```

Use `--url URL` to override `OUTAGE_GATE_URL` for these commands. The tool reads
the token only from `OUTAGE_GATE_ADMIN_TOKEN`. It never accepts a token as an
argument.

## HTTP contract

Unknown paths return `404`. A known path with the wrong method returns `405`.
Missing or malformed bearer authorization returns `401`.

The listener token can request and close. It cannot open. The admin token can
open, close, and read status.

### Request a permit

Send `POST /permit` with `Authorization: Bearer $OUTAGE_GATE_TOKEN` and this
exact JSON body:

```json
{
  "expiresAtMs": 1800000060000,
  "repository": "OWNER/REPO",
  "runnerRequestId": 501,
  "scaleSetId": 101,
  "wave": "wave-1"
}
```

The repository must appear in `OUTAGE_GATE_REPOSITORY_ALLOWLIST`. The success
body contains exactly these fields:

```json
{
  "permitId": "84d17c4c-dc26-4e13-bc6e-76e231dbbea5",
  "expiresAtMs": 1800000045000,
  "signature": "UNPADDED_BASE64URL_ED25519_SIGNATURE"
}
```

The Worker signs this canonical value:

```text
permitId.scaleSetId.runnerRequestId.repository.expiresAtMs
```

The permit expires at the earlier request deadline or 45 seconds after issue.
An unexpired request replay returns the same permit object.

A closed gate returns `503`:

```json
{
  "refused": true,
  "reason": "gate-closed",
  "generation": 2,
  "closedAtMs": 1800000000000
}
```

A passed start deadline returns `409`:

```json
{"refused":true,"reason":"start-deadline-passed"}
```

Request validation and allow-list failures return `400` with `refused: true`.
A missing signing secret or listener token returns `503` and issues no permit.

### Close the gate

Send `POST /close` with either token. The listener sends this body:

```json
{
  "action": "close",
  "closedAtMs": 1800000000000,
  "reason": "session-reclaim-exhausted",
  "scaleSetId": 101,
  "scaleSetName": "cloudflare-sandbox"
}
```

`scaleSetId` and `scaleSetName` are optional. The Worker records them when they
are present and valid. A successful close returns:

```json
{
  "state": "closed",
  "generation": 2,
  "closedAtMs": 1800000000000,
  "reason": "session-reclaim-exhausted"
}
```

Close is idempotent. A repeated close does not increment the generation.

### Open the gate

Send `POST /open` with `Authorization: Bearer $OUTAGE_GATE_ADMIN_TOKEN`:

```json
{
  "action": "open",
  "openedAtMs": 1800000001000,
  "reason": "incident ended",
  "actor": "operator-name"
}
```

A successful open increments the generation and returns:

```json
{"state":"open","generation":3,"openedAtMs":1800000001000}
```

### Read status

Send `GET /status` with either token. A successful response contains:

```json
{
  "state": "open",
  "generation": 3,
  "changedAtMs": 1800000001000,
  "reason": "incident ended",
  "actor": "operator-name",
  "livePermits": 0
}
```

Admin route configuration failures return `500`. The service never returns or
logs a token or the private key.
