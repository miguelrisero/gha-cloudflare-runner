#!/usr/bin/env bash

# Exit codes:
#   0: The audit found no findings.
#   1: The audit found findings, with no destroy failure.
#   2: The audit had an operational failure.
#   3: The audit found findings, and at least one destroy failed.
set -Eeuo pipefail

# shellcheck disable=SC2317,SC2329 # The ERR trap calls this function.
unexpected_failure() {
  local status=$?
  trap - ERR
  printf 'Orphan audit command failed unexpectedly with status %d.\n' \
    "$status" >&2
  exit 2
}
trap unexpected_failure ERR

usage() {
  echo "Usage: scripts/orphan-audit.sh [--json] [--destroy] [--destroy-unknown-age]" >&2
}

invalid_registry_page() {
  echo "Worker returned an invalid runner registry page" >&2
  exit 2
}

json_output=false
destroy=false
destroy_unknown_age=false
while (($# > 0)); do
  case "$1" in
    --json)
      json_output=true
      ;;
    --destroy)
      destroy=true
      ;;
    --destroy-unknown-age)
      destroy_unknown_age=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# The degraded measured spawn took 31 seconds. A 60-second grace period adds
# 29 seconds of margin before the audit can classify a live sandbox as orphaned.
grace_seconds=${ORPHAN_GRACE_SECONDS:-60}
if [[ ! "$grace_seconds" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "ORPHAN_GRACE_SECONDS must be 0 or a decimal integer without leading zeros" >&2
  exit 2
fi

required_commands=(node npx jq gh date curl base64 mktemp)
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required" >&2
    exit 2
  fi
done

if [[ -z "${WORKER_URL:-}" ]]; then
  echo "WORKER_URL must be set" >&2
  exit 2
fi
if [[ -z "${CONTROL_TOKEN:-}" ]]; then
  echo "CONTROL_TOKEN must be set" >&2
  exit 2
fi
if ((${#CONTROL_TOKEN} < 32)); then
  echo "CONTROL_TOKEN must contain at least 32 characters" >&2
  exit 2
fi
worker_url=${WORKER_URL%/}

instance_page_size=25
# Mirrors RUNNER_LIST_PAGE_SIZE in src/worker.js. GET /runners has no request-side
# page-size parameter, so the audit requires a reported size equal to this pin.
# Equality is the only sound client assertion. Never raise this value to accept
# a larger server page.
registry_page_size=100
# Registry rows remain for 262,800 seconds, and each alarm prunes five old rows.
# At the fastest measured successful throughput, five new rows per 9.222 seconds,
# the retained window can hold 142,486 rows and need 28,498 five-row pages.
# A delayed five-row alarm drain can increase this measured planning estimate.
# Keep the owner-set cap until an operator approves a derived replacement.
max_page_count=1000

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_dir=$(dirname -- "$script_dir")
cd -- "$repository_dir"

temporary_files=()
# shellcheck disable=SC2317,SC2329 # The EXIT trap calls this function.
cleanup_temp_files() {
  local temporary_file
  for temporary_file in "${temporary_files[@]}"; do
    rm -f -- "$temporary_file" || true
  done
}
trap cleanup_temp_files EXIT

if ! instance_pages_file=$(mktemp); then
  echo "A temporary Cloudflare instance page file could not be created" >&2
  exit 2
fi
temporary_files+=("$instance_pages_file")
if ! instances_file=$(mktemp); then
  echo "A temporary Cloudflare instance list file could not be created" >&2
  exit 2
fi
temporary_files+=("$instances_file")
if ! ambiguous_instances_file=$(mktemp); then
  echo "A temporary ambiguous instance list file could not be created" >&2
  exit 2
fi
temporary_files+=("$ambiguous_instances_file")
if ! registry_pages_file=$(mktemp); then
  echo "A temporary Worker registry page file could not be created" >&2
  exit 2
fi
temporary_files+=("$registry_pages_file")
if ! registry_rows_file=$(mktemp); then
  echo "A temporary Worker registry list file could not be created" >&2
  exit 2
fi
temporary_files+=("$registry_rows_file")
if ! registered_uuids_file=$(mktemp); then
  echo "A temporary GitHub runner list file could not be created" >&2
  exit 2
fi
temporary_files+=("$registered_uuids_file")
if ! reported_orphans_file=$(mktemp); then
  echo "A temporary orphan result file could not be created" >&2
  exit 2
fi
temporary_files+=("$reported_orphans_file")

wrangler_config=${WRANGLER_CONFIG:-wrangler.jsonc}
if [[ ! -f "$wrangler_config" ]]; then
  echo "Wrangler configuration not found: $wrangler_config" >&2
  exit 2
fi
wrangler_config_args=(--config "$wrangler_config")

if ! config_metadata=$(
  WRANGLER_CONFIG_PATH="$wrangler_config" node --input-type=module --eval '
    import { unstable_readConfig } from "wrangler";

    const config = await unstable_readConfig({
      config: process.env.WRANGLER_CONFIG_PATH,
    });
    const containerNames = (config.containers ?? [])
      .map((container) => container.name)
      .filter((name) => typeof name === "string" && name.length > 0);
    const configuredRepository = config.vars?.GITHUB_REPOSITORY;
    const configuredRunnerScope = config.vars?.GITHUB_RUNNER_SCOPE;
    process.stdout.write(JSON.stringify({
      containerNames,
      configuredRepository:
        typeof configuredRepository === "string"
          ? configuredRepository
          : null,
      configuredRunnerScope:
        typeof configuredRunnerScope === "string"
          ? configuredRunnerScope
          : null,
    }));
  '
); then
  echo "Wrangler configuration could not be read" >&2
  exit 2
fi

if [[ -n "${CONTAINER_NAME:-}" ]]; then
  container_name=$CONTAINER_NAME
  if ! jq -e --arg name "$container_name" \
    '.containerNames | index($name) != null' \
    >/dev/null <<<"$config_metadata"; then
    echo "CONTAINER_NAME does not match wrangler.jsonc" >&2
    exit 2
  fi
else
  container_count=$(jq -er '.containerNames | length' <<<"$config_metadata")
  if ((container_count != 1)); then
    echo "CONTAINER_NAME must select one configured container" >&2
    exit 2
  fi
  container_name=$(jq -er '.containerNames[0]' <<<"$config_metadata")
fi

github_repository=${GITHUB_REPOSITORY:-}
if [[ -z "$github_repository" ]]; then
  github_repository=$(
    jq -er '.configuredRepository | select(type == "string" and length > 0)' \
      <<<"$config_metadata"
  ) || {
    echo "GITHUB_REPOSITORY must be set or configured in wrangler.jsonc" >&2
    exit 2
  }
fi
if [[ ! "$github_repository" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
  echo "GITHUB_REPOSITORY must have the owner/repository form" >&2
  exit 2
fi

resolve_github_runner_scope() {
  local configured_runner_scope=$1
  local organization

  if [[ -z "${configured_runner_scope//[[:space:]]/}" || \
    "$configured_runner_scope" == repository ]]; then
    github_runner_scope_path="repos/$github_repository/actions/runners"
    github_runner_scope_label="repository:$github_repository"
    github_runner_scope_permission="Repository \`Administration: Read-only\`"
    return
  fi

  if [[ "$configured_runner_scope" == organization ]]; then
    organization=${github_repository%%/*}
  elif [[ "$configured_runner_scope" == organization:* ]]; then
    organization=${configured_runner_scope#organization:}
  else
    echo "GITHUB_RUNNER_SCOPE must be repository, organization, or organization:<org>" >&2
    exit 2
  fi

  if [[ -z "${organization//[[:space:]]/}" || "$organization" == */* || \
    "$organization" == *'*'* || "$organization" == *..* ]]; then
    echo 'GITHUB_RUNNER_SCOPE organization must be non-empty and contain no "/", "*", or ".."' >&2
    exit 2
  fi

  github_runner_scope_path="orgs/$organization/actions/runners"
  github_runner_scope_label="organization:$organization"
  github_runner_scope_permission="Organization \`Self-hosted runners: Read-only\`"
}

github_runner_scope=${GITHUB_RUNNER_SCOPE:-}
if [[ -z "$github_runner_scope" ]]; then
  if ! github_runner_scope=$(jq -er '
    if .configuredRunnerScope == null then
      ""
    else
      .configuredRunnerScope | select(type == "string")
    end
  ' <<<"$config_metadata"); then
    echo "GITHUB_RUNNER_SCOPE could not be read from wrangler.jsonc" >&2
    exit 2
  fi
fi
resolve_github_runner_scope "$github_runner_scope"

if ! github_probe_stderr_file=$(mktemp); then
  echo "A temporary GitHub runner scope probe file could not be created" >&2
  exit 2
fi
temporary_files+=("$github_probe_stderr_file")

# A 200 response with an empty list under the wrong scope is indistinguishable
# from a genuine orphan. Prove the scope is readable before classifying anything.
github_probe_status=0
github_probe_response=$(gh api "$github_runner_scope_path" --method GET \
  2>"$github_probe_stderr_file") || github_probe_status=$?
if ((github_probe_status != 0)); then
  github_probe_stderr=$(<"$github_probe_stderr_file")
  if [[ -n "$github_probe_stderr" ]]; then
    printf '%s\n' "$github_probe_stderr" >&2
  fi
  if [[ "$github_probe_stderr" == *"HTTP 403"* ]]; then
    printf 'GitHub runner scope probe failed for %s at %s with HTTP 403.\n' \
      "$github_runner_scope_label" "$github_runner_scope_path" >&2
    printf 'AUDIT_GITHUB_TOKEN requires %s for this scope.\n' \
      "$github_runner_scope_permission" >&2
    echo "A token holding only repository \`Administration: Read-only\` gets HTTP 403 on an organization endpoint." >&2
  elif [[ "$github_probe_stderr" == *"HTTP 404"* ]]; then
    printf 'GitHub runner scope probe failed for %s at %s with HTTP 404. The scope target is absent or invisible to AUDIT_GITHUB_TOKEN.\n' \
      "$github_runner_scope_label" "$github_runner_scope_path" >&2
  else
    printf 'GitHub runner scope probe failed for %s at %s.\n' \
      "$github_runner_scope_label" "$github_runner_scope_path" >&2
  fi
  exit 2
fi
if ! jq -e '
  type == "object" and
  (.total_count | type == "number" and floor == . and . >= 0) and
  (.runners | type) == "array"
' >/dev/null <<<"$github_probe_response"; then
  printf 'GitHub runner scope probe returned invalid data for %s at %s.\n' \
    "$github_runner_scope_label" "$github_runner_scope_path" >&2
  exit 2
fi

application_id=${APPLICATION_ID:-}
if [[ -z "$application_id" ]]; then
  # Discover the application ID at run time from `wrangler containers list`.
  # Match the container name from the Wrangler config. Never replace this lookup
  # with a hardcoded ID because Cloudflare has already changed the ID once.
  # The `instances` column from this command, shown as LIVE INSTANCES, is capacity.
  # It equals the configured max_instances. A freshly redeployed application with
  # zero running sandboxes still reports 5. Never use this column as a leak signal.
  if ! applications_json=$(
    npx wrangler containers list "${wrangler_config_args[@]}" --json
  ); then
    echo "Cloudflare container applications could not be listed" >&2
    exit 2
  fi
  if ! jq -e 'type == "array"' >/dev/null <<<"$applications_json"; then
    echo "Wrangler returned an invalid container application list" >&2
    exit 2
  fi
  application_matches=$(
    jq -c --arg name "$container_name" \
      '[.[] | select(.name == $name)]' <<<"$applications_json"
  )
  application_match_count=$(jq -r 'length' <<<"$application_matches")
  if ((application_match_count != 1)); then
    echo "Wrangler did not return exactly one application named $container_name" >&2
    exit 2
  fi
  application_id=$(jq -er '.[0].id' <<<"$application_matches")
fi
if [[ ! "$application_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "APPLICATION_ID must be a UUID" >&2
  exit 2
fi

if ! audit_start_epoch=$(date -u +%s); then
  echo "The orphan audit time could not be read" >&2
  exit 2
fi

page_token=''
instance_page_count=0
instance_request_page_size=$instance_page_size
instance_confirming_boundary=false
instance_boundary_page_length=0
instance_boundary_confirmation_count=0
instance_row_count=0
instance_pagination_outcome=''
instance_traversal_start_id=''
instance_wrap_observed=false
instance_lap_rule_enabled=true
declare -A seen_page_tokens=()
declare -A seen_instance_pages=()
# Only rows from `wrangler containers instances <application-id>` are authoritative
# for running sandboxes. Assert leak conditions on those rows and their `state`.
# Snapshot invariant: complete this Cloudflare read before the Worker registry
# read. Reversing the reads can make a newly spawned sandbox appear rowless.
while true; do
  if ((instance_page_count >= max_page_count)); then
    echo "Cloudflare container instance pagination exceeded the page limit" >&2
    exit 2
  fi
  instance_page_count=$((instance_page_count + 1))
  # Cloudflare emits next_page_token only when rows remain after the returned page.
  # A full page without a token needs a reduced-size confirmation read.
  instance_command=(
    npx wrangler containers instances "$application_id"
    "${wrangler_config_args[@]}" --json --per-page "$instance_request_page_size"
  )
  if [[ -n "$page_token" ]]; then
    seen_page_tokens["$page_token"]=1
    instance_command+=(--page-token "$page_token")
  fi
  if ! instance_page_json=$("${instance_command[@]}"); then
    echo "Cloudflare container instances could not be listed" >&2
    exit 2
  fi
  if ! instance_page_values=$(jq -er \
    --argjson requestedPageSize "$instance_request_page_size" '
      if (
        type == "object" and
        (.instances | type) == "array" and
        (.result_info | type) == "object" and
        (
          .result_info as $resultInfo
          | ($resultInfo | has("per_page")) as $hasReportedPageSize
          | (
              if $hasReportedPageSize then
                $resultInfo.per_page
              else
                $requestedPageSize
              end
            ) as $appliedPageSize
          | ($appliedPageSize | type) == "number" and
            ($appliedPageSize | floor) == $appliedPageSize and
            $appliedPageSize > 0 and
            $appliedPageSize <= $requestedPageSize and
            (.instances | length) <= $appliedPageSize and
            (
              (($resultInfo | has("next_page_token")) | not) or
              $resultInfo.next_page_token == null or
              (
                ($resultInfo.next_page_token | type) == "string" and
                ($resultInfo.next_page_token | length) > 0
              )
            )
        )
      ) then
        .result_info as $resultInfo
        | (
            if $resultInfo | has("per_page") then
              $resultInfo.per_page
            else
              $requestedPageSize
            end
          ) as $appliedPageSize
        | [
            (.instances | tojson),
            (.instances | map(.id) | sort | tojson),
            (.instances | length | tostring),
            ($appliedPageSize | tostring),
            (($resultInfo.next_page_token // "") | @base64)
          ]
        | join("\u001e")
      else
        error("invalid container instance page")
      end
    ' <<<"$instance_page_json"); then
    echo "Wrangler returned an invalid container instance page" >&2
    exit 2
  fi
  if ! IFS=$'\x1e' read -r page_instances instance_page_fingerprint \
    instance_page_length instance_applied_page_size next_page_token_base64 \
    <<<"$instance_page_values"; then
    echo "Wrangler returned an invalid container instance page" >&2
    exit 2
  fi
  if ! next_page_token=$(base64 --decode <<<"$next_page_token_base64"); then
    echo "Wrangler returned an invalid container instance page" >&2
    exit 2
  fi
  if ! instance_ordering_values=$(jq -er \
    --arg traversalStartId "$instance_traversal_start_id" '
      map(.id) as $ids
      | (all($ids[]; type == "string")) as $hasStringIds
      | (
          if $traversalStartId != "" then
            $traversalStartId
          elif $hasStringIds and ($ids | length) > 0 then
            $ids[0]
          else
            ""
          end
        ) as $traversalStartId
      | [
          ($hasStringIds | tostring),
          (
            if $hasStringIds then
              [
                range(1; $ids | length) as $index
                | select($ids[$index] <= $ids[$index - 1])
              ]
              | length
              | tostring
            else
              "0"
            end
          ),
          (
            (
              $hasStringIds and
              $traversalStartId != "" and
              any($ids[]; . < $traversalStartId)
            )
            | tostring
          ),
          (
            (
              $hasStringIds and
              $traversalStartId != "" and
              ($ids | length) > 0 and
              $ids[-1] >= $traversalStartId
            )
            | tostring
          ),
          (
            if $hasStringIds and ($ids | length) > 0 then
              $ids[0] | @base64
            else
              ""
            end
          )
        ]
      | join("\u001e")
    ' <<<"$page_instances"); then
    echo "Cloudflare container instance page ordering could not be checked" >&2
    exit 2
  fi
  if ! IFS=$'\x1e' read -r instance_page_ids_are_strings \
    instance_page_descent_count instance_page_contains_id_below_start \
    instance_page_last_at_or_after_start instance_page_first_id_base64 \
    <<<"$instance_ordering_values"; then
    echo "Cloudflare container instance page ordering could not be read" >&2
    exit 2
  fi
  if [[ -z "$instance_traversal_start_id" && \
    "$instance_page_ids_are_strings" == true && \
    -n "$instance_page_first_id_base64" ]]; then
    if ! instance_traversal_start_id=$(base64 --decode \
      <<<"$instance_page_first_id_base64"); then
      echo "Cloudflare container instance page ordering could not be read" >&2
      exit 2
    fi
  fi
  if [[ "$instance_lap_rule_enabled" == true ]]; then
    if [[ "$instance_page_ids_are_strings" != true ]] ||
      ((instance_page_descent_count >= 2)); then
      instance_lap_rule_enabled=false
    elif [[ "$instance_page_contains_id_below_start" == true ]]; then
      instance_wrap_observed=true
    fi
  fi
  instance_cursor_cycle_closed=false
  if [[ -n "$next_page_token" && \
    -n "${seen_page_tokens[$next_page_token]:-}" ]]; then
    instance_cursor_cycle_closed=true
  elif [[ -n "${seen_instance_pages[$instance_page_fingerprint]:-}" ]]; then
    echo "Wrangler repeated a container instance page" >&2
    exit 2
  else
    seen_instance_pages["$instance_page_fingerprint"]=1
  fi
  if ! printf '%s\n' "$page_instances" >>"$instance_pages_file"; then
    echo "Cloudflare container instance pages could not be stored" >&2
    exit 2
  fi
  instance_row_count=$((instance_row_count + instance_page_length))
  if [[ -n "$next_page_token" ]]; then
    instance_request_page_size=$instance_page_size
    instance_confirming_boundary=false
    instance_boundary_page_length=0
  fi
  if [[ "$instance_cursor_cycle_closed" == true ]]; then
    instance_pagination_outcome=cycle-closed
    printf 'Cloudflare container instance pagination closed a cursor cycle after %d page(s); the enumeration is complete.\n' \
      "$instance_page_count" >&2
    break
  fi
  if [[ -z "$next_page_token" ]]; then
    if ((instance_page_length == instance_applied_page_size)); then
      if [[ "$instance_confirming_boundary" == true ]]; then
        printf 'Cloudflare container instance list is unsound: a %d-row page and a %d-row page from the same cursor both ended without a next page token\n' \
          "$instance_boundary_page_length" "$instance_page_length" >&2
        exit 2
      fi
      if ((instance_applied_page_size <= 1)); then
        printf 'Cloudflare container instance list may be truncated: a full page of %d row(s) had no next page token and no smaller page size exists to confirm it\n' \
          "$instance_page_length" >&2
        exit 2
      fi
      instance_boundary_page_length=$instance_page_length
      instance_request_page_size=$((instance_applied_page_size - 1))
      instance_confirming_boundary=true
      instance_boundary_confirmation_count=$((
        instance_boundary_confirmation_count + 1
      ))
      printf 'Cloudflare returned a full page of %d instance(s) with no next page token; Cloudflare emits a token only when rows remain, so the same cursor is re-read at %d row(s) per page to confirm the end of the list.\n' \
        "$instance_page_length" "$instance_request_page_size" >&2
      continue
    fi
    instance_pagination_outcome=exhausted
    break
  fi
  if [[ "$instance_lap_rule_enabled" == true && \
    "$instance_wrap_observed" == true && \
    "$instance_page_last_at_or_after_start" == true ]]; then
    instance_pagination_outcome=lap-closed
    break
  fi
  page_token=$next_page_token
done
unset seen_instance_pages

if ! partitioned_instances_json=$(jq -L "$script_dir/lib" -cn '
  include "orphan-select";
  reduce inputs as $page ([]; . + $page)
  | partition_cloudflare_instances
' "$instance_pages_file"); then
  echo "Cloudflare container instance pages could not be merged" >&2
  exit 2
fi
if ! jq -ce '.instances | select(type == "array")' \
  <<<"$partitioned_instances_json" >"$instances_file" ||
  ! jq -ce '.ambiguous | select(type == "array")' \
    <<<"$partitioned_instances_json" >"$ambiguous_instances_file"; then
  echo "Cloudflare container instance pages could not be merged" >&2
  exit 2
fi
if ! instance_counter_values=$(jq -er '
  [
    length,
    (map(select((.state | ascii_downcase) != "inactive")) | length)
  ]
  | map(tostring)
  | join("\u001e")
' "$instances_file"); then
  echo "Cloudflare container instance counters could not be calculated" >&2
  exit 2
fi
if ! IFS=$'\x1e' read -r instance_count live_instance_count \
  <<<"$instance_counter_values"; then
  echo "Cloudflare container instance counters could not be read" >&2
  exit 2
fi
if ! ambiguous_instance_count=$(jq -er 'length' \
  "$ambiguous_instances_file"); then
  echo "Cloudflare ambiguous instance counter could not be calculated" >&2
  exit 2
fi

registry_cursor=''
registry_page_count=0
declare -A seen_registry_cursors=()
declare -A seen_registry_pages=()
# Snapshot invariant: start this Worker registry read only after the Cloudflare
# instance snapshot completes. Reversing the reads can classify a new spawn.
# The Worker reports its applied size once this change is deployed. Until then,
# use the pinned size when the deployed Worker omits it or reports null.
# GET /runners has no request-side page-size parameter, so equality with the pin
# is the only assertion the client can soundly make. A page shortened below the
# applied size with a dropped cursor remains undetectable because neither API
# reports a total count.
while true; do
  if ((registry_page_count >= max_page_count)); then
    echo "Worker runner registry page cap reached; review retention and throughput, then get owner approval before changing max_page_count" >&2
    exit 2
  fi
  registry_page_count=$((registry_page_count + 1))
  registry_request=(
    curl --fail-with-body --silent --show-error
    --connect-timeout 10
    --max-time 60
    --retry 3
    --retry-all-errors
    --retry-delay 2
    --header "Authorization: Bearer $CONTROL_TOKEN"
  )
  if [[ -n "$registry_cursor" ]]; then
    registry_request+=(--get --data-urlencode "cursor=$registry_cursor")
  fi
  registry_request+=("$worker_url/runners")
  if ! registry_page_json=$("${registry_request[@]}"); then
    echo "Worker runner registry could not be listed" >&2
    exit 2
  fi
  # These framing guards compensate for the \x1e + @base64 transport shared
  # with the Cloudflare instance loop, which has the same exposure and fewer
  # guards. Convert both loops to NUL-delimited fields with mapfile -d '' to
  # remove these guards; change both loops together.
  if ! registry_page_values=$(jq -er \
    --argjson registryPageSize "$registry_page_size" '
      if (
        type == "object" and
        (.runners | type) == "array" and
        (
          (
            if ((has("pageSize")) and .pageSize != null) then
              .pageSize
            else
              $registryPageSize
            end
          ) as $appliedPageSize
          | ($appliedPageSize | type) == "number" and
            ($appliedPageSize | floor) == $appliedPageSize and
            $appliedPageSize > 0 and
            $appliedPageSize == $registryPageSize and
            (.runners | length) <= $appliedPageSize and
            (
              ((has("nextCursor")) | not) or
              .nextCursor == null or
              (
                (.nextCursor | type) == "string" and
                (.nextCursor | length) > 0 and
                # Pin the cursor character set so it survives an @base64 /
                # base64 --decode round trip through command substitution.
                (.nextCursor | test("^[A-Za-z0-9_=-]+$"))
              )
            )
        )
      ) then
        (
          if ((has("pageSize")) and .pageSize != null) then
            .pageSize
          else
            $registryPageSize
          end
        ) as $appliedPageSize
        # A state change can move a row between cursor partitions during an
        # audit. Fingerprint the whole row instead of only its identity, so a
        # new revision during healthy churn does not look like a repeated page.
        # jq preserves numeric literal spellings in the row fingerprint. A
        # hostile server can still evade this check with equivalent spellings.
        | [
            (.runners | tojson),
            (.runners | map(tojson) | sort | tojson),
            (.runners | length | tostring),
            ((.nextCursor // "") | @base64)
          ]
        | join("\u001e")
      else
        error("invalid runner registry page")
      end
    ' <<<"$registry_page_json"); then
    invalid_registry_page
  fi
  if [[ "$registry_page_values" == *$'\n'* ]]; then
    invalid_registry_page
  fi
  if ! IFS=$'\x1e' read -r page_registry_rows registry_page_fingerprint \
    registry_page_length next_registry_cursor_base64 \
    <<<"$registry_page_values"; then
    invalid_registry_page
  fi
  if [[ ! "$registry_page_length" =~ ^[0-9]+$ ]]; then
    invalid_registry_page
  fi
  if ! next_registry_cursor=$(base64 --decode \
    <<<"$next_registry_cursor_base64"); then
    invalid_registry_page
  fi
  if [[ -n "$next_registry_cursor" && \
    -n "${seen_registry_cursors[$next_registry_cursor]:-}" ]]; then
    echo "Worker repeated a runner registry cursor" >&2
    exit 2
  fi
  if [[ -n "${seen_registry_pages[$registry_page_fingerprint]:-}" ]]; then
    echo "Worker repeated a runner registry page" >&2
    exit 2
  fi
  seen_registry_pages["$registry_page_fingerprint"]=1
  if ! printf '%s\n' "$page_registry_rows" >>"$registry_pages_file"; then
    echo "Worker runner registry pages could not be stored" >&2
    exit 2
  fi
  if [[ -z "$next_registry_cursor" ]]; then
    if ((registry_page_length == registry_page_size)); then
      echo "Worker runner registry list may be truncated: a full final page had no next cursor" >&2
      exit 2
    fi
    break
  fi
  seen_registry_cursors[$next_registry_cursor]=1
  registry_cursor=$next_registry_cursor
done
unset seen_registry_pages

if ! jq -cn 'reduce inputs as $page ([]; . + $page)' \
  "$registry_pages_file" >"$registry_rows_file"; then
  echo "Worker runner registry pages could not be merged" >&2
  exit 2
fi

query_github_runner_registration() {
  local expected_runner_name=$1
  local github_response

  if ! github_response=$(
    gh api \
      "$github_runner_scope_path" \
      --method GET \
      --raw-field "name=$expected_runner_name"
  ); then
    echo "GitHub runner $expected_runner_name could not be queried" >&2
    return 1
  fi
  if ! jq -er --arg expectedName "$expected_runner_name" '
    def non_negative_integer:
      type == "number" and floor == . and . >= 0;
    def valid_runner:
      type == "object" and
      (.id | non_negative_integer) and
      (.name | type) == "string" and
      (.status | type) == "string" and
      (.busy | type) == "boolean";

    if (
      type == "object" and
      (.total_count | non_negative_integer) and
      (.runners | type) == "array" and
      all(.runners[]; valid_runner)
    ) then
      if .total_count == 0 and (.runners | length) == 0 then
        "unregistered"
      elif (
        .total_count == 1 and
        (.runners | length) == 1 and
        .runners[0].name == $expectedName
      ) then
        "registered"
      else
        error("ambiguous targeted GitHub runner response")
      end
    else
      error("invalid targeted GitHub runner response")
    end
  ' <<<"$github_response"; then
    echo "GitHub returned invalid or ambiguous data for runner $expected_runner_name" >&2
    return 1
  fi
}

if ! github_runner_candidate_output=$(jq -L "$script_dir/lib" -nc \
  --slurpfile instanceDocuments "$instances_file" \
  --slurpfile ambiguousDocuments "$ambiguous_instances_file" \
  --slurpfile registryDocuments "$registry_rows_file" \
  --argjson auditStart "$audit_start_epoch" \
  --argjson grace "$grace_seconds" '
    include "orphan-select";
    ($instanceDocuments[0] | map(validate_cloudflare_instance)) as $instances
    | (
        $ambiguousDocuments[0]
        | map(.sandboxId)
        | INDEX(.)
      ) as $ambiguousBySandbox
    | (
        $registryDocuments[0]
        | map(validate_registry_row)
        | registry_entries_by_sandbox(.)
      ) as $registryBySandbox
    | [
        (
          $instances[]
          | select($ambiguousBySandbox[.name] == null)
          | select((.state | ascii_downcase) != "inactive")
          | . as $instance
          | ($instance.name | sandbox_uuid) as $uuid
          | select($uuid != null)
          | {
              uuid: $uuid,
              runnerName: authoritative_runner_name(
                ($registryBySandbox[$instance.name].row // null);
                $uuid
              )
            }
        ),
        (
          $registryBySandbox[]
          | select($ambiguousBySandbox[.row.sandboxId] == null)
          | select(.row.state | is_non_terminal_registry_state)
          | select(($auditStart - .createdEpoch) >= $grace)
          | . as $registryEntry
          | ($registryEntry.row.sandboxId | sandbox_uuid) as $uuid
          | select($uuid != null)
          | {
              uuid: $uuid,
              runnerName: authoritative_runner_name(
                $registryEntry.row;
                $uuid
              )
            }
        )
      ]
    # Reverse-pass rows have no live Cloudflare instance to supply their UUID.
    # Query their exact GitHub names to distinguish missing registrations from
    # registrations without a live instance.
    | unique
    | group_by(.uuid)
    | map(
        . as $matches
        | if ($matches | length) == 1 then
            $matches[0]
          else
            error(
              "conflicting resolved GitHub runner names for UUID " +
              "\($matches[0].uuid | tojson): \($matches | tojson)"
            )
          end
      )
    | sort_by(.uuid)
    | .[]
  '); then
  echo "Cloudflare or the Worker returned invalid GitHub runner candidate data" >&2
  exit 2
fi
github_runner_candidate_documents=()
if [[ -n "$github_runner_candidate_output" ]]; then
  mapfile -t github_runner_candidate_documents <<<"$github_runner_candidate_output"
fi
for github_runner_candidate_document in "${github_runner_candidate_documents[@]}"; do
  if ! github_runner_uuid=$(jq -er \
    '.uuid | select(type == "string")' \
    <<<"$github_runner_candidate_document"); then
    echo "A Cloudflare runner UUID could not be read" >&2
    exit 2
  fi
  if ! expected_runner_name=$(jq -er \
    '.runnerName | select(type == "string" and length > 0)' \
    <<<"$github_runner_candidate_document"); then
    echo "A GitHub runner name could not be read" >&2
    exit 2
  fi
  if ! github_registration=$(
    query_github_runner_registration "$expected_runner_name"
  ); then
    exit 2
  fi
  case "$github_registration" in
    registered)
      if ! jq -cn --arg uuid "$github_runner_uuid" '$uuid' \
        >>"$registered_uuids_file"; then
        echo "GitHub runner registrations could not be stored" >&2
        exit 2
      fi
      ;;
    unregistered)
      ;;
    *)
      echo "GitHub runner registration output could not be read" >&2
      exit 2
      ;;
  esac
done

if ! now_epoch=$(date -u +%s); then
  echo "The orphan audit time could not be read" >&2
  exit 2
fi
if ! orphans_json=$(
  jq -L "$script_dir/lib" -nce \
    --slurpfile instanceDocuments "$instances_file" \
    --slurpfile ambiguousDocuments "$ambiguous_instances_file" \
    --slurpfile registryDocuments "$registry_rows_file" \
    --slurpfile registeredDocuments "$registered_uuids_file" \
    --argjson now "$now_epoch" \
    --argjson auditStart "$audit_start_epoch" \
    --argjson grace "$grace_seconds" '
      include "orphan-select";
      select_orphans(
        $instanceDocuments[0];
        $ambiguousDocuments[0];
        $registryDocuments[0];
        $registeredDocuments;
        $now;
        $auditStart;
        $grace
      )
    '
); then
  echo "Cloudflare or the Worker returned invalid orphan audit data" >&2
  exit 2
fi

if ! orphan_rows_output=$(jq -rc '.[]' <<<"$orphans_json"); then
  echo "Orphan selection output could not be read" >&2
  exit 2
fi
orphan_rows=()
if [[ -n "$orphan_rows_output" ]]; then
  mapfile -t orphan_rows <<<"$orphan_rows_output"
fi
orphan_count=${#orphan_rows[@]}
if ! ambiguous_rows_output=$(jq -rc '.[]' "$ambiguous_instances_file"); then
  echo "Ambiguous instance output could not be read" >&2
  exit 2
fi
ambiguous_rows=()
if [[ -n "$ambiguous_rows_output" ]]; then
  mapfile -t ambiguous_rows <<<"$ambiguous_rows_output"
fi
finding_count=$((orphan_count + ambiguous_instance_count))
ghost_registration_count=0

for ambiguous_instance in "${ambiguous_rows[@]}"; do
  if ! sandbox_id=$(jq -er '.sandboxId | select(type == "string")' \
    <<<"$ambiguous_instance"); then
    echo "Ambiguous instance sandbox ID could not be read" >&2
    exit 2
  fi
  if [[ "$json_output" == true ]]; then
    if ! jq -c '. + {type: "ambiguous-instance"}' \
      <<<"$ambiguous_instance"; then
      echo "$sandbox_id: ambiguous instance result could not be printed" >&2
      exit 2
    fi
  elif ! printf 'ambiguous_instance\t%s\n' "$ambiguous_instance"; then
    echo "$sandbox_id: ambiguous instance result could not be printed" >&2
    exit 2
  fi
done

attempt_destroy() {
  local sandbox_id=$1
  local uuid=$2
  local runner_name=$3
  local instance_id=$4
  local inactive_instance_id=$5
  local age_source=$6
  local reason=$7
  local registry_revision=$8
  local cleanup_token
  local encoded_sandbox_id
  local latest_registration_state
  local curl_status
  local destroy_response
  local destroy_body
  local cleanup_status
  local cleanup_attempts
  local reclaim_request_body
  local reclaim_status
  local print_destroy_body
  local -a cleanup_request

  destroy_result="not-requested"
  destroy_http_status=null
  if [[ "$destroy" != true ]]; then
    return
  fi

  # Never let this class reach the absent-from-cloudflare reclaim branch.
  # That branch posts observedRegistration: {outcome: "registration-not-found"},
  # which would be a false assertion for a runner that is registered.
  if [[ "$reason" == "registered-without-instance" ]]; then
    if [[ -z "$runner_name" ]]; then
      echo "$sandbox_id: a registered runner cannot be reported without a GitHub runner name" >&2
      exit 2
    fi
    destroy_result="operator-route-required"
    echo "$sandbox_id: --destroy will not remove registered runner $runner_name; review the GitHub registration manually" >&2
    return
  fi

  if [[ "$reason" != "absent-from-cloudflare" && -z "$instance_id" ]]; then
    echo "$sandbox_id: orphan instance ID is required for $reason" >&2
    exit 2
  fi

  if [[ "$reason" == "absent-from-registry" || \
    "$reason" == "terminal-registry-row" ]]; then
    destroy_result="operator-route-required"
    echo "$sandbox_id: --destroy cannot remediate this class through DELETE /runners/<sandboxId>; call POST /operator/orphans/<sandboxId>/destroy manually with observedSandboxInstanceId=$instance_id" >&2
    return
  fi
  if [[ "$reason" == "absent-from-cloudflare" ]]; then
    case "$instance_pagination_outcome" in
      cycle-closed | exhausted | lap-closed)
        ;;
      *)
        destroy_result="operator-route-required"
        echo "$sandbox_id: absent-from-cloudflare cannot be reclaimed because this run did not complete the Cloudflare instance enumeration" >&2
        return
        ;;
    esac
  fi
  if [[ "$age_source" == "unknown" && "$destroy_unknown_age" != true ]]; then
    destroy_result="skipped-unknown-age"
    return
  fi
  if [[ "$reason" != "absent-from-cloudflare" ]]; then
    if ! cleanup_token=$(
      SANDBOX_ID="$sandbox_id" node --input-type=module --eval '
        import { createHmac } from "node:crypto";

        process.stdout.write(
          createHmac("sha256", process.env.CONTROL_TOKEN)
            .update(process.env.SANDBOX_ID)
            .digest("hex"),
        );
      '
    ); then
      destroy_result="cleanup-token-preparation-failed"
      echo "$sandbox_id: cleanup token preparation failed" >&2
      return
    fi
  fi
  if ! encoded_sandbox_id=$(jq -ern \
    --arg value "$sandbox_id" '$value | @uri'); then
    destroy_result="sandbox-id-encoding-failed"
    echo "$sandbox_id: sandbox ID encoding failed" >&2
    return
  fi
  if [[ -z "$uuid" ]]; then
    echo "$sandbox_id: GitHub registration cannot be rechecked without a runner UUID" >&2
    exit 2
  fi
  if [[ -z "$runner_name" ]]; then
    echo "$sandbox_id: GitHub registration cannot be rechecked without a runner name" >&2
    exit 2
  fi

  # Narrow the registration race by checking this runner immediately before
  # the destroy request. A Worker-side precondition is still required to close it.
  if ! latest_registration_state=$(
    query_github_runner_registration "$runner_name"
  ); then
    echo "$sandbox_id: GitHub registration could not be rechecked" >&2
    exit 2
  fi
  if [[ "$latest_registration_state" == "registered" ]]; then
    destroy_result="skipped-now-registered"
    echo "$sandbox_id: the runner registered after selection; cleanup was skipped" >&2
    return
  fi
  if [[ "$latest_registration_state" != "unregistered" ]]; then
    echo "$sandbox_id: GitHub registration recheck output could not be read" >&2
    exit 2
  fi

  cleanup_request=(
    curl --silent --show-error
    --connect-timeout 10
    --max-time 60
    --retry 3
    --retry-all-errors
    --retry-delay 2
    --write-out $'\n%{http_code}'
  )
  if [[ "$reason" == "absent-from-cloudflare" ]]; then
    if ! reclaim_request_body=$(jq -cn \
      --argjson expectedRevision "$registry_revision" \
      --arg enumerationOutcome "$instance_pagination_outcome" \
      --argjson instanceCount "$instance_count" \
      --argjson liveInstanceCount "$live_instance_count" \
      --argjson pageCount "$instance_page_count" \
      --arg applicationId "$application_id" \
      --arg runnerName "$runner_name" '
        {
          observedRegistryCondition: "live",
          expectedRevision: $expectedRevision,
          cloudflareAbsence: {
            enumerationOutcome: $enumerationOutcome,
            instanceCount: $instanceCount,
            liveInstanceCount: $liveInstanceCount,
            pageCount: $pageCount,
            applicationId: $applicationId
          },
          observedRegistration: {
            outcome: "registration-not-found",
            runnerName: $runnerName
          }
        }
      '); then
      destroy_result="reclaim-request-preparation-failed"
      echo "$sandbox_id: reclaim request preparation failed" >&2
      return
    fi
    cleanup_request+=(
      --request POST
      --header "Authorization: Bearer $CONTROL_TOKEN"
      --header "Content-Type: application/json"
      --data "$reclaim_request_body"
      "$worker_url/operator/orphans/$encoded_sandbox_id/reclaim"
    )
  else
    cleanup_request+=(
      --request DELETE
      --header "Authorization: Bearer $cleanup_token"
      "$worker_url/runners/$encoded_sandbox_id"
    )
  fi

  curl_status=0
  destroy_response=$("${cleanup_request[@]}") || curl_status=$?
  if ((curl_status != 0)); then
    destroy_result="request-failed"
    echo "$sandbox_id: the supported cleanup request failed" >&2
    return
  fi

  destroy_http_status=${destroy_response##*$'\n'}
  destroy_body=${destroy_response%$'\n'*}
  print_destroy_body=true
  if [[ "$reason" == "absent-from-cloudflare" ]]; then
    case "$destroy_http_status" in
      200)
        if ! reclaim_status=$(jq -er \
          --arg sandboxId "$sandbox_id" \
          --arg runnerName "$runner_name" '
            select(
              type == "object" and
              .outcome == "reclaimed" and
              .sandboxId == $sandboxId and
              .runnerName == $runnerName
            )
            | .outcome
          ' <<<"$destroy_body"); then
          destroy_result="invalid-reclaim-response"
          echo "$sandbox_id: reclaim returned an invalid HTTP 200 response" >&2
        else
          destroy_result="$reclaim_status"
          print_destroy_body=false
        fi
        ;;
      202)
        if ! reclaim_status=$(jq -er \
          --arg sandboxId "$sandbox_id" \
          --argjson revision "$registry_revision" '
            select(
              .outcome == "absence-recorded" and
              .sandboxId == $sandboxId and
              .revision == $revision and
              (.reclaimableAtMs | type) == "number"
            )
            | .outcome
          ' <<<"$destroy_body"); then
          destroy_result="invalid-reclaim-response"
          echo "$sandbox_id: reclaim returned an invalid HTTP 202 response" >&2
        else
          destroy_result="$reclaim_status"
          print_destroy_body=false
        fi
        ;;
      409)
        destroy_result="cleanup-unschedulable"
        echo "$sandbox_id: reclaim could not proceed for the current registry or GitHub state" >&2
        ;;
      *)
        destroy_result="unexpected-http-status"
        echo "$sandbox_id: reclaim returned HTTP $destroy_http_status" >&2
        ;;
    esac
    if [[ "$print_destroy_body" == true && -n "$destroy_body" ]]; then
      printf '%s\n' "$destroy_body" >&2
    fi
    return
  fi

  case "$destroy_http_status" in
    202)
      if ! cleanup_status=$(jq -er '
        .cleanupStatus
        | select(
            . == "scheduled" or
            . == "rearmed" or
            . == "already-scheduled"
          )
      ' <<<"$destroy_body"); then
        destroy_result="invalid-cleanup-response"
        echo "$sandbox_id: cleanup returned an invalid HTTP 202 response" >&2
      else
        case "$cleanup_status" in
          scheduled)
            destroy_result="cleanup-scheduled"
            print_destroy_body=false
            ;;
          rearmed)
            destroy_result="cleanup-rearmed"
            print_destroy_body=false
            ;;
          already-scheduled)
            if ! cleanup_attempts=$(jq -er '
              .cleanupAttempts
              | select(
                  type == "number" and
                  floor == . and
                  . >= 0 and
                  . <= 9007199254740991
                )
            ' <<<"$destroy_body"); then
              destroy_result="invalid-cleanup-response"
              echo "$sandbox_id: cleanup returned an invalid HTTP 202 response" >&2
            elif ((cleanup_attempts == 0)); then
              destroy_result="cleanup-already-scheduled"
              print_destroy_body=false
            else
              destroy_result="cleanup-retrying"
              print_destroy_body=false
            fi
            ;;
        esac
      fi
      ;;
    204)
      destroy_result="already-destroyed-inconsistent"
      echo "$sandbox_id: cleanup reported an already-destroyed row for a live instance" >&2
      ;;
    404)
      destroy_result="callback-row-not-found"
      echo "$sandbox_id: the callback route found no registry row" >&2
      ;;
    409)
      destroy_result="cleanup-unschedulable"
      echo "$sandbox_id: cleanup could not be scheduled for the current registry state" >&2
      ;;
    *)
      destroy_result="unexpected-http-status"
      echo "$sandbox_id: cleanup returned HTTP $destroy_http_status" >&2
      ;;
  esac
  if [[ "$print_destroy_body" == true && -n "$destroy_body" ]]; then
    printf '%s\n' "$destroy_body" >&2
  fi
}

for orphan in "${orphan_rows[@]}"; do
  if ! sandbox_id=$(jq -er '.sandboxId | select(type == "string")' \
    <<<"$orphan"); then
    echo "Orphan sandbox ID could not be read" >&2
    exit 2
  fi
  if ! uuid=$(jq -er '
    .uuid
    | if type == "string" then . elif . == null then "" else error("invalid UUID") end
  ' <<<"$orphan"); then
    echo "$sandbox_id: orphan UUID could not be read" >&2
    exit 2
  fi
  if ! runner_name=$(jq -er '
    .runnerName
    | if type == "string" then . elif . == null then "" else error("invalid runner name") end
  ' <<<"$orphan"); then
    echo "$sandbox_id: orphan runner name could not be read" >&2
    exit 2
  fi
  if ! instance_id=$(jq -er '
    .instanceId
    | if type == "string" then . elif . == null then "" else error("invalid instance ID") end
  ' <<<"$orphan"); then
    echo "$sandbox_id: orphan instance ID could not be read" >&2
    exit 2
  fi
  if ! inactive_instance_id=$(jq -er '
    .inactiveInstance.id
    | if type == "string" then . elif . == null then "" else error("invalid inactive instance ID") end
  ' <<<"$orphan"); then
    echo "$sandbox_id: inactive instance ID could not be read" >&2
    exit 2
  fi
  if ! age_source=$(jq -er \
    '.ageSource | select(. == "worker-registry" or . == "unknown")' \
    <<<"$orphan"); then
    echo "$sandbox_id: orphan age source could not be read" >&2
    exit 2
  fi
  if ! reason=$(jq -er '
    .reason
    | select(
        . == "unregistered" or
        . == "terminal-registry-row" or
        . == "absent-from-registry" or
        . == "absent-from-cloudflare" or
        . == "registered-without-instance"
      )
  ' <<<"$orphan"); then
    echo "$sandbox_id: orphan reason could not be read" >&2
    exit 2
  fi
  if ! registry_revision=$(jq -er '
    if (
      .reason == "absent-from-cloudflare" or
      .reason == "registered-without-instance"
    ) then
      .registryRevision
      | select(
          type == "number" and
          floor == . and
          . >= 0 and
          . <= 9007199254740991
        )
    else
      ""
    end
  ' <<<"$orphan"); then
    echo "$sandbox_id: orphan registry revision could not be read" >&2
    exit 2
  fi
  if [[ "$reason" == "registered-without-instance" ]]; then
    ghost_registration_count=$((ghost_registration_count + 1))
  fi

  attempt_destroy \
    "$sandbox_id" \
    "$uuid" \
    "$runner_name" \
    "$instance_id" \
    "$inactive_instance_id" \
    "$age_source" \
    "$reason" \
    "$registry_revision"
  if ! reported_orphan=$(jq -c \
    --arg destroyResult "$destroy_result" \
    --argjson destroyHttpStatus "$destroy_http_status" '
      . + {
        destroyResult: $destroyResult,
        destroyHttpStatus: $destroyHttpStatus
      }
    ' <<<"$orphan"); then
    echo "$sandbox_id: orphan result could not be prepared" >&2
    exit 2
  fi
  if ! printf '%s\n' "$reported_orphan" >>"$reported_orphans_file"; then
    echo "$sandbox_id: orphan result could not be stored" >&2
    exit 2
  fi
  if [[ "$json_output" == true ]]; then
    if ! jq -c '. + {type: "orphan"}' <<<"$reported_orphan"; then
      echo "$sandbox_id: orphan result could not be printed" >&2
      exit 2
    fi
  elif ! printf 'orphan\t%s\n' "$reported_orphan"; then
    echo "$sandbox_id: orphan result could not be printed" >&2
    exit 2
  fi
done

if ! destroy_counter_values=$(jq -jrn '
  reduce inputs as $orphan
    ({
      scheduled: 0,
      alreadyScheduled: 0,
      reclaimed: 0,
      absenceRecorded: 0,
      failure: 0,
      skipped: 0,
      operatorRequired: 0,
      registered: 0
    };
      $orphan.destroyResult as $result
      | if (
          $result == "cleanup-scheduled" or
          $result == "cleanup-rearmed"
        ) then
          .scheduled += 1
        elif $result == "cleanup-already-scheduled" then
          .alreadyScheduled += 1
        elif $result == "reclaimed" then
          .reclaimed += 1
        elif $result == "absence-recorded" then
          .absenceRecorded += 1
        elif $result == "skipped-unknown-age" then
          .skipped += 1
        elif $result == "operator-route-required" then
          .operatorRequired += 1
        elif $result == "skipped-now-registered" then
          .registered += 1
        elif $result == "not-requested" then
          .
        elif $result == "cleanup-retrying" then
          .failure += 1
        elif ([
          "cleanup-token-preparation-failed",
          "reclaim-request-preparation-failed",
          "sandbox-id-encoding-failed",
          "invalid-cleanup-response",
          "invalid-reclaim-response",
          "request-failed",
          "already-destroyed-inconsistent",
          "callback-row-not-found",
          "cleanup-unschedulable",
          "unexpected-http-status"
        ] | index($result)) != null then
          .failure += 1
        else
          error("unclassified destroy result: \($result | tojson)")
        end
    )
  | [
      .scheduled,
      .alreadyScheduled,
      .reclaimed,
      .absenceRecorded,
      .failure,
      .skipped,
      .operatorRequired,
      .registered
    ]
  | map(tostring)
  | join("\u001e")
' "$reported_orphans_file"); then
  echo "Orphan destroy counters could not be calculated" >&2
  exit 2
fi
if ! IFS=$'\x1e' read -r destroy_scheduled_count \
  destroy_already_scheduled_count \
  destroy_reclaimed_count destroy_absence_recorded_count \
  destroy_failure_count destroy_skipped_count \
  destroy_operator_required_count destroy_registered_skip_count \
  <<<"$destroy_counter_values"; then
  echo "Orphan destroy counters could not be read" >&2
  exit 2
fi

if [[ "$json_output" == true ]]; then
  if ! jq -cn \
    --arg applicationId "$application_id" \
    --arg containerName "$container_name" \
    --arg repository "$github_repository" \
    --arg runnerScope "$github_runner_scope_label" \
    --argjson graceSeconds "$grace_seconds" \
    --argjson instancePageCount "$instance_page_count" \
    --argjson instanceBoundaryConfirmationCount \
      "$instance_boundary_confirmation_count" \
    --argjson instanceRowCount "$instance_row_count" \
    --argjson instanceCount "$instance_count" \
    --argjson liveInstanceCount "$live_instance_count" \
    --argjson ambiguousInstanceCount "$ambiguous_instance_count" \
    --arg instancePagination "$instance_pagination_outcome" \
    --argjson orphanCount "$orphan_count" \
    --argjson ghostRegistrationCount "$ghost_registration_count" \
    --argjson findingCount "$finding_count" \
    --argjson destroyScheduledCount "$destroy_scheduled_count" \
    --argjson destroyAlreadyScheduledCount \
      "$destroy_already_scheduled_count" \
    --argjson destroyReclaimedCount "$destroy_reclaimed_count" \
    --argjson destroyAbsenceRecordedCount \
      "$destroy_absence_recorded_count" \
    --argjson destroyFailureCount "$destroy_failure_count" \
    --argjson destroySkippedCount "$destroy_skipped_count" \
    --argjson destroyOperatorRequiredCount \
      "$destroy_operator_required_count" \
    --argjson destroyRegisteredSkipCount "$destroy_registered_skip_count" '
      {
        type: "summary",
        applicationId: $applicationId,
        containerName: $containerName,
        repository: $repository,
        runnerScope: $runnerScope,
        graceSeconds: $graceSeconds,
        instancePageCount: $instancePageCount,
        instanceBoundaryConfirmationCount: $instanceBoundaryConfirmationCount,
        instanceRowCount: $instanceRowCount,
        instanceCount: $instanceCount,
        liveInstanceCount: $liveInstanceCount,
        ambiguousInstanceCount: $ambiguousInstanceCount,
        instancePagination: $instancePagination,
        orphanCount: $orphanCount,
        ghostRegistrationCount: $ghostRegistrationCount,
        findingCount: $findingCount,
        destroyScheduledCount: $destroyScheduledCount,
        destroyAlreadyScheduledCount: $destroyAlreadyScheduledCount,
        destroyReclaimedCount: $destroyReclaimedCount,
        destroyAbsenceRecordedCount: $destroyAbsenceRecordedCount,
        destroyFailureCount: $destroyFailureCount,
        destroySkippedCount: $destroySkippedCount,
        destroyOperatorRequiredCount: $destroyOperatorRequiredCount,
        destroyRegisteredSkipCount: $destroyRegisteredSkipCount
      }
    '; then
    echo "The orphan audit summary could not be printed" >&2
    exit 2
  fi
else
  if ! printf 'runner_scope\t%s\n' "$github_runner_scope_label" ||
    ! printf 'instance_page_count\t%d\n' "$instance_page_count" ||
    ! printf 'instance_boundary_confirmation_count\t%d\n' \
      "$instance_boundary_confirmation_count" ||
    ! printf 'instance_row_count\t%d\n' "$instance_row_count" ||
    ! printf 'instance_count\t%d\n' "$instance_count" ||
    ! printf 'live_instance_count\t%d\n' "$live_instance_count" ||
    ! printf 'ambiguous_instance_count\t%d\n' "$ambiguous_instance_count" ||
    ! printf 'instance_pagination\t%s\n' "$instance_pagination_outcome" ||
    ! printf 'orphan_count\t%d\n' "$orphan_count" ||
    ! printf 'ghost_registration_count\t%d\n' \
      "$ghost_registration_count" ||
    ! printf 'finding_count\t%d\n' "$finding_count" ||
    ! printf 'destroy_scheduled_count\t%d\n' "$destroy_scheduled_count" ||
    ! printf 'destroy_already_scheduled_count\t%d\n' \
      "$destroy_already_scheduled_count" ||
    ! printf 'destroy_reclaimed_count\t%d\n' "$destroy_reclaimed_count" ||
    ! printf 'destroy_absence_recorded_count\t%d\n' \
      "$destroy_absence_recorded_count" ||
    ! printf 'destroy_failure_count\t%d\n' "$destroy_failure_count" ||
    ! printf 'destroy_skipped_count\t%d\n' "$destroy_skipped_count" ||
    ! printf 'destroy_operator_required_count\t%d\n' \
      "$destroy_operator_required_count" ||
    ! printf 'destroy_registered_skip_count\t%d\n' \
      "$destroy_registered_skip_count"; then
    echo "The orphan audit summary could not be printed" >&2
    exit 2
  fi
fi
if ! printf 'Orphan audit for runner scope %s completed instance pagination as %s after %d page(s) and %d row(s), with %d distinct instance(s) and %d live instance(s); it found %d ambiguous instance record(s) and %d orphan record(s), including %d ghost GitHub registration(s); it scheduled %d destroy request(s), found %d already-scheduled cleanup request(s), reclaimed %d registry row(s), recorded %d reclaim observation(s), skipped %d unknown-age request(s), required %d manual operator-route request(s), skipped %d newly registered runner(s), and had %d destroy failure(s).\n' \
  "$github_runner_scope_label" "$instance_pagination_outcome" "$instance_page_count" \
  "$instance_row_count" "$instance_count" "$live_instance_count" \
  "$ambiguous_instance_count" "$orphan_count" "$ghost_registration_count" \
  "$destroy_scheduled_count" \
  "$destroy_already_scheduled_count" "$destroy_reclaimed_count" \
  "$destroy_absence_recorded_count" "$destroy_skipped_count" \
  "$destroy_operator_required_count" "$destroy_registered_skip_count" \
  "$destroy_failure_count" >&2; then
  echo "The orphan audit summary could not be printed" >&2
  exit 2
fi

if ((finding_count > 0 && destroy_failure_count > 0)); then
  exit 3
fi
if ((finding_count > 0)); then
  exit 1
fi
exit 0
