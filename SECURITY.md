# Security

This tool holds credentials that administer GitHub runners and it executes CI
workloads. Read this before you point it at anything you care about.

## Reporting a vulnerability

Open a private security advisory on the repository. Do not open a public issue
for a vulnerability.

This is a reference implementation rather than a maintained product, so treat
the response time as best effort.

## The trust boundary

`GITHUB_REPOSITORY_ALLOWLIST` is the boundary. The Worker refuses any
repository that is not an exact `OWNER/REPO` entry in that list. There are no
wildcards, no owner-only entries and no prefixes, deliberately. A job from any
other repository cannot obtain a runner.

Keep the list as short as the work requires. Every repository on it can run
arbitrary code inside your Cloudflare account.

## Credentials

| Credential | Blast radius if it leaks |
| --- | --- |
| `GITHUB_TOKEN` | Administers runner registrations on the configured scope. Scope it to that scope and nothing wider. |
| `CONTROL_TOKEN` | Every operator route, including sandbox destruction. Rotate it if a job could ever have read it. |
| `CAPACITY_APPROVAL_PUBLIC_KEY`, `OUTAGE_GATE_PUBLIC_KEY` | Public keys. They verify signatures; they grant nothing. |

The Worker never passes `CONTROL_TOKEN` or `GITHUB_TOKEN` into a container.
The container receives a just-in-time runner registration that is valid for
one job.

## Public repositories and self-hosted runners

GitHub's own guidance applies and it matters more here than usual: **do not
let a public repository reach self-hosted runners.** A pull request from a
fork can propose workflow changes, and a runner that survives a job can carry
state into the next one.

This design reduces that risk because every runner is ephemeral and serves
exactly one job, but it does not remove it. If you enable this for a public
repository, require approval for fork pull requests.

Check the same thing for the repository holding this code. A public repository
inside a runner group that grants self-hosted access lets a fork's pull
request execute on your hardware.

## Cost as a safety property

An orphaned container bills until something deletes it. The audit and cleanup
workflows exist for that, and `docs/ORPHAN-RUNBOOK.md` explains the failure
modes. Read the decommissioning section of the README before switching the
fleet off: deleting the Worker does not delete its containers.
