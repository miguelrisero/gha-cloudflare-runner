# Runner registration cleanup

This tool deletes idle GitHub runner registrations with a loop-spawned name.
The name must have the exact `cloudflare-<scaleSetId>-<runnerRequestId>` format.
The request identifier must be in the reserved loop-spawn band.

The tool refuses to delete these registrations:

- A registration with another name format.
- A registration with a request identifier below the reserved band.
- A busy registration.
- A registration from another scale set when you set `--scale-set-id`.
- Any registration from an incomplete census or a growing filtered population.

Use a fine-grained token for the `example-org` organization.
Grant the token Organization "Self-hosted runners: Read and write" permission.
A classic PAT must have the `admin:org` scope.

## Census contract

The census invariants apply to the filtered cleanup population.
Changes to the organization `total_count` from unrelated runners do not block cleanup.
The count also includes an unrelated ephemeral fleet that creates a registration after each respawn.
The filtered population includes matching reserved-band registrations and uses the scale set filter when configured.
Busy matching registrations belong to this population, but cleanup does not delete them.
Cleanup refuses when the filtered population exceeds the `expectedTargets` baseline.
This growth means that the registration leak produces records again.
An absent baseline skips only the filtered growth check.
The census also refuses failed pages, malformed data, duplicate filtered runner identifiers, invalid counts, and truncated listings.
A short census can omit a safe delete, but it cannot cause a wrong delete.
A refused run reports the delete capability and the provisional selected count from the records it read.

## Run the workflow

Open the **Registration cleanup** workflow and select **Run workflow**.
Keep `apply` false for a dry run.
Review the step summary and the uploaded JSON report.

Set `apply` to true to delete registrations.
Enter `DELETE` in the `confirm` input.
Set `scale_set_id` when the run must target one scale set.

The cleanup is resumable.
The limit can require several apply runs.
Run another dry run after the final apply run.

## Run it from the Worker

The Worker route exists because its `GITHUB_TOKEN` has organization self-hosted-runners write access.
The available CI tokens have read-only access and cannot delete registrations.

Open the **Worker registration cleanup** workflow.
Keep `apply` false for the first call.
Review each round summary and the uploaded JSON report.
CAUTION: An apply run deletes eligible GitHub registrations.
Set `apply` to true to delete eligible registrations.
Enter `DELETE` in the `confirm` input.

The workflow sends `POST /operator/registrations/cleanup` to the Worker.
The route requires `Authorization: Bearer <CONTROL_TOKEN>`.
The Worker requires a control token with at least 32 characters.
The route gets the registration scope from the Worker environment.

An apply run first sends one dry-run baseline call without `expectedTargets`.
The workflow reads `filteredRegistrations` and sends it as `expectedTargets` in apply round 1.
Each later apply round uses the prior round's `remaining` value as `expectedTargets`.
A workflow dry run sends one call without `expectedTargets`.

One call reads at most 40 census pages and plans at most 50 deletes.
Each delete after the first waits at least 1,000 milliseconds.
The workflow can run at most 40 bounded apply rounds.
It stops when `remaining` reaches zero or the cleanup refuses.
Each apply round reads a new census and resumes the cleanup.

The exact `RUNNER_REGISTRATION_DELETE=off` value blocks an apply call with HTTP 409.
The value does not block a dry run.
Remove the variable before an approved apply run.

### Blast radius

An apply call deletes only idle registrations with the exact loop-spawn name and reserved request band.
Repeated rounds can delete the complete eligible backlog in the environment scope.
The route does not delete a sandbox or a Worker registry row.

These controls stop misuse:

- The route requires the `CONTROL_TOKEN`.
- An apply call requires the literal `DELETE` confirmation.
- The request cannot supply a runner identifier, a runner name, or a scope.
- An incomplete, duplicate, truncated, or growing filtered census stops all deletes.
- The per-call delete cap and the request spacing bound each call.
- The `RUNNER_REGISTRATION_DELETE=off` value stops apply calls.

## Run locally

Run this command for a dry run:

```sh
GH_TOKEN='<token>' node scripts/registration-cleanup.mjs --scope organization --organization example-org --limit 250 --report registration-cleanup-report.json
```

Run this command to apply the cleanup:

```sh
GH_TOKEN='<token>' node scripts/registration-cleanup.mjs --scope organization --organization example-org --apply --limit 250 --report registration-cleanup-report.json
```
