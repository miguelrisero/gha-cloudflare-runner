# gha-cloudflare-runner

On-demand, self-hosted GitHub Actions runners that live inside Cloudflare
Sandbox containers.

A Cloudflare Worker implements the GitHub Actions **runner scale set**
protocol. When a job is queued, the Worker registers a just-in-time runner,
starts one container to serve it, and destroys that container when the job
ends. No runner outlives its job, and nothing sits idle between jobs.

Jobs reach it through an ordinary label. No other workflow change is needed:

```yaml
jobs:
  build:
    runs-on: cloudflare-sandbox
    steps:
      - run: echo "hello from a Cloudflare container"
```

## How it works

1. A job asks for the runner label.
2. GitHub offers the job to the scale set. A Durable Object holds the long
   poll that receives that offer.
3. The Worker takes a just-in-time registration token from GitHub, records the
   runner in a SQLite Durable Object, and starts one Sandbox container.
4. The container runs the job. A shell trap calls back to the Worker when it
   exits.
5. The Worker destroys the container and deletes the registration.
6. A durable alarm re-checks anything that never called back.
7. An hourly audit reconciles the Worker's registry against Cloudflare and
   GitHub, and a cleanup job destroys whatever the audit can prove is leaked.

Steps 6 and 7 are not optional extras. A container that survives its own
destroy keeps running and keeps billing, and only an external audit can see
it. Read [`docs/ORPHAN-RUNBOOK.md`](docs/ORPHAN-RUNBOOK.md) before you run this
for anything that matters.

## Trade-offs

Worth knowing before you adopt this:

- **Acquisition is slower than a warm runner.** A container has to start.
  Expect seconds, against near-instant for an always-on machine.
- **Compute is slower than dedicated hardware** for the same work, and I/O
  bound work feels it most.
- **Container starts can be refused under load.** The design retries, so jobs
  still run, but capacity is not guaranteed.
- **You pay only for what runs.** Nothing idles, which is the whole point.

It is a good trade for burst capacity you do not want to own, and a poor one
as a replacement for warm dedicated hardware on latency-sensitive work.

## Requirements

- A Cloudflare account with Workers, Durable Objects and Containers enabled.
  Containers are a paid feature.
- A GitHub organisation or repository where you can create a runner scale set.
- Node.js 22+, npm, Bash, curl, Python 3.
- Docker. Wrangler builds `container/Dockerfile` during deployment.
- Wrangler, authenticated: `npx wrangler login`.
- GitHub CLI, authenticated, for the setup scripts.

## Quickstart

```bash
git clone https://github.com/<you>/gha-cloudflare-runner
cd gha-cloudflare-runner
npm ci

export CLOUDFLARE_ACCOUNT_ID=<your Cloudflare account id>
export GITHUB_TOKEN=<a token that can administer runners on the target scope>
```

Point the Worker at your repository, in `wrangler.jsonc`:

```json
"vars": {
  "GITHUB_REPOSITORY": "your-org/your-repo",
  "GITHUB_REPOSITORY_ALLOWLIST": ["your-org/your-repo"],
  "RUNNER_LABELS": "cloudflare-sandbox"
}
```

Set the secrets, create the scale set, and deploy:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put CONTROL_TOKEN            # any 32+ character random string
npx wrangler secret put CAPACITY_APPROVAL_PUBLIC_KEY
npx wrangler secret put OUTAGE_GATE_PUBLIC_KEY

scripts/preflight-scale-set.sh --scale-set cloudflare-sandbox
scripts/create-scale-set.sh   --scale-set cloudflare-sandbox --apply
npm run check                                    # wrangler dry run
npm run deploy
```

Then send it a job with `runs-on: cloudflare-sandbox`.

Run `npm run check` after every configuration edit. It validates without
deploying.

## Configuration

Variables live in `vars` in `wrangler.jsonc`. Secrets are set with
`wrangler secret put` and are never committed.

| Name | Kind | Meaning |
| --- | --- | --- |
| `GITHUB_REPOSITORY` | var | Default repository for registry rows, and the fallback when no allow-list binding is present. |
| `GITHUB_REPOSITORY_ALLOWLIST` | var | Exact `OWNER/REPO` entries the Worker will serve. No wildcards, no owner-only entries. This is the trust boundary. |
| `RUNNER_LABELS` | var | The runner label, and the scale set name. They must match. |
| `GITHUB_TOKEN` | secret | Administers runner registrations on the target scope. |
| `CONTROL_TOKEN` | secret | Bearer token for every operator route. 32 characters minimum. |
| `CAPACITY_APPROVAL_PUBLIC_KEY` | secret | Verifies signed capacity approvals. See `scripts/sign-capacity-approval.sh`. |
| `OUTAGE_GATE_PUBLIC_KEY` | secret | Verifies the outage gate, which can stop all scale-up. |
| `CLOUDFLARE_ACCOUNT_ID` | environment | Target Cloudflare account. Set it in the environment, or as a repository variable for the deploy workflows. |

`RUNNER_LABELS` and the scale set name are the same string, fixed to
`cloudflare-sandbox` in `src/worker.js`. Change both together if you rename it.

## Operating it

| Document | Use it for |
| --- | --- |
| [`docs/ORPHAN-RUNBOOK.md`](docs/ORPHAN-RUNBOOK.md) | Leaked containers. Read this first; it is the failure that costs money. |
| [`docs/AUTOPILOT-OPERATIONS.md`](docs/AUTOPILOT-OPERATIONS.md) | Pausing, resuming and re-arming the listener. |
| [`docs/ALERTING.md`](docs/ALERTING.md) | What alerts, what stays silent, and how to prove delivery works. |
| [`docs/REGISTRATION-CLEANUP.md`](docs/REGISTRATION-CLEANUP.md) | Clearing stranded GitHub registrations. |
| [`docs/LOG-EXPORT.md`](docs/LOG-EXPORT.md) | Getting logs out of the Worker. |

The scheduled workflows in `.github/workflows/` cover the same ground: an
hourly orphan audit, a twice-hourly cleanup that destroys what the audit
proves, and a listener watchdog. Leave them disabled until you actually run
the fleet, then enable them.

## Decommissioning

Deleting the Worker does **not** delete its container application. The
orphaned application keeps its instances provisioned and billing, with nothing
left to manage them.

Tear down in this order:

```bash
# 1. Stop new work first, or the audit and cleanup jobs will race the teardown
#    and alert on their own failure.
gh workflow disable orphan-audit.yml
gh workflow disable operator-destroy-orphans.yml
gh workflow disable listener-watchdog.yml

# 2. Confirm nothing is mid-flight.
npx wrangler containers list

# 3. Delete the Workers.
npx wrangler delete --name gha-cloudflare-runner
npx wrangler delete --name gha-outage-gate

# 4. Delete the container applications BY ID. This is the step that stops the
#    billing, and nothing else does it for you.
npx wrangler containers list
npx wrangler containers delete <ID>
```

Verify with `npx wrangler containers list` until it reports no containers.
Also remove the runner scale set from GitHub, or a job that still names the
label will queue against a listener that no longer exists.

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | The Worker: registry, scale-set listener, autopilot control. |
| `container/` | The runner image Wrangler builds and deploys. |
| `scripts/` | Setup, audit and operator tooling. |
| `test/` | The suite. `npm test`. |
| `outage-gate/` | A second, tiny Worker that can refuse all scale-up. |
| `docs/` | Runbooks. |

## Development

```bash
npm ci
npm run lint
npm test          # offline: no network and no Cloudflare account needed
npm run check     # wrangler dry run
```

## Security

The repository allow-list is the trust boundary, and this tool holds a token
that administers GitHub runners. Read [`SECURITY.md`](SECURITY.md) before
pointing it at anything you care about.

## Licence

MIT. See [`LICENSE`](LICENSE).
