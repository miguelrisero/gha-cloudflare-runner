#!/usr/bin/env bash
set -euo pipefail

if [[ -n "$(git status --porcelain)" ]]; then
  echo "The working tree is dirty; refusing to deploy" >&2
  exit 1
fi

if [[ -z "$(git branch -r --contains HEAD)" ]]; then
  echo "HEAD is not present on any remote branch; refusing to deploy" >&2
  exit 1
fi

node scripts/lib/deploy-vars.mjs assert-keep-vars wrangler.jsonc

sha=$(git rev-parse HEAD)
ref=$(git rev-parse --abbrev-ref HEAD)
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

for argument in "$@"; do
  if [[ "$argument" == "--dry-run" ]]; then
    npx wrangler deploy \
      --var "BUILD_SHA:$sha" \
      --var "BUILD_REF:$ref" \
      --var "BUILD_TIME:$built_at" \
      "$@"
    exit 0
  fi
done

scratch_directory=$(mktemp -d)
trap 'rm -rf -- "$scratch_directory"' EXIT

before_versions_path="$scratch_directory/before-versions.json"
before_version_path="$scratch_directory/before-version.json"
before_bindings_path="$scratch_directory/before.tsv"

if ! npx wrangler versions list --json >"$before_versions_path"; then
  printf '%s\n' \
    'The deployed binding set could not be read.' \
    'The deploy is refused.' >&2
  exit 1
fi

if ! before_version_id=$(
  node scripts/lib/deploy-vars.mjs \
    latest-version-id "$before_versions_path"
); then
  printf '%s\n' \
    'The deployed version list could not be parsed.' \
    'The deploy is refused.' >&2
  exit 1
fi

first_deploy=false
if [[ -z "$before_version_id" ]]; then
  first_deploy=true
  : >"$before_bindings_path"
  printf '%s\n' \
    'The Worker has no deployed version. This is the first deploy.' >&2
else
  if ! npx wrangler versions view "$before_version_id" --json \
    >"$before_version_path"; then
    printf '%s\n' \
      'The deployed binding set could not be read.' \
      'The deploy is refused.' >&2
    exit 1
  fi

  if ! node scripts/lib/deploy-vars.mjs bindings "$before_version_path" \
    >"$before_bindings_path"; then
    printf '%s\n' \
      'The deployed binding set could not be parsed.' \
      'The deploy is refused.' >&2
    exit 1
  fi
fi

deploy_status=0
npx wrangler deploy \
  --var "BUILD_SHA:$sha" \
  --var "BUILD_REF:$ref" \
  --var "BUILD_TIME:$built_at" \
  "$@" || deploy_status=$?

if ((deploy_status != 0)); then
  exit "$deploy_status"
fi

after_versions_path="$scratch_directory/after-versions.json"
after_version_path="$scratch_directory/after-version.json"
after_bindings_path="$scratch_directory/after.tsv"

if ! npx wrangler versions list --json >"$after_versions_path"; then
  printf '%s\n' \
    'The deployed binding set could not be read after the deploy.' \
    'The deploy result cannot be verified.' >&2
  exit 1
fi

if ! after_version_id=$(
  node scripts/lib/deploy-vars.mjs \
    latest-version-id "$after_versions_path"
); then
  printf '%s\n' \
    'The deployed version list could not be parsed after the deploy.' \
    'The deploy result cannot be verified.' >&2
  exit 1
fi

if [[ -z "$after_version_id" ]]; then
  printf '%s\n' \
    'The Worker has no version after the deploy.' \
    'The deploy result cannot be verified.' >&2
  exit 1
fi

if ! npx wrangler versions view "$after_version_id" --json \
  >"$after_version_path"; then
  printf '%s\n' \
    'The deployed binding set could not be read after the deploy.' \
    'The deploy result cannot be verified.' >&2
  exit 1
fi

if ! node scripts/lib/deploy-vars.mjs bindings "$after_version_path" \
  >"$after_bindings_path"; then
  printf '%s\n' \
    'The deployed binding set could not be parsed after the deploy.' \
    'The deploy result cannot be verified.' >&2
  exit 1
fi

if [[ "$first_deploy" == "false" ]]; then
  if ! node scripts/lib/deploy-vars.mjs diff-bindings \
    "$before_bindings_path" "$after_bindings_path"; then
    printf 'The before version ID is %s.\n' "$before_version_id" >&2
    printf 'Restore values with: npx wrangler versions view %s --json\n' \
      "$before_version_id" >&2
    exit 1
  fi
fi

before_binding_count=$(awk 'END { print NR }' "$before_bindings_path")
after_binding_count=$(awk 'END { print NR }' "$after_bindings_path")

if [[ "$first_deploy" == "true" ]]; then
  binding_summary="The Worker had 0 bindings before and $after_binding_count bindings after. No bindings were dropped."
  snapshot_summary='The before snapshot was skipped because the Worker had no version.'
else
  binding_summary="The Worker had $before_binding_count bindings before and $after_binding_count bindings after. No bindings were dropped."
  snapshot_summary='The before and after binding snapshots matched.'
fi

printf '%s\n' \
  'Deploy succeeded. The Durable Objects restarted. A fresh Durable Object is inert.' \
  "$binding_summary" \
  "$snapshot_summary" \
  'keep_vars is on, so a variable or secret that exists only in the dashboard survives a deploy.' \
  'A variable deleted from wrangler.jsonc no longer disappears on deploy.' \
  'Remove it with a deliberate dashboard or API action.' \
  'Apply the signed capacity approval and resume the listener.' \
  'Verify the listener and control status.' \
  'Read docs/AUTOPILOT-OPERATIONS.md.' \
  'Use .github/workflows/bootstrap-fleet.yml for the authenticated bootstrap.' \
  >&2 || :

exit "$deploy_status"
