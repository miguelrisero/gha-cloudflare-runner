#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: scripts/rescue-queued-runs.sh --repo <owner/name> --label cloudflare-sandbox --rescue-workflow queued-run-rescue.yml --rescue-ref <ref> --ledger <path> [--dry-run]" >&2
}

repository=
runner_label=
rescue_workflow=
rescue_ref=
ledger_path=
dry_run=false

while (($# > 0)); do
  case "$1" in
    --repo | --label | --rescue-workflow | --rescue-ref | --ledger)
      if (($# < 2)) || [[ -z "$2" ]]; then
        printf '%s requires a non-empty value\n' "$1" >&2
        usage
        exit 2
      fi
      case "$1" in
        --repo)
          repository=$2
          ;;
        --label)
          runner_label=$2
          ;;
        --rescue-workflow)
          rescue_workflow=$2
          ;;
        --rescue-ref)
          rescue_ref=$2
          ;;
        --ledger)
          ledger_path=$2
          ;;
      esac
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$repository" || -z "$runner_label" || -z "$rescue_workflow" \
  || -z "$rescue_ref" || -z "$ledger_path" ]]; then
  usage
  exit 2
fi
if [[ ! "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "--repo must use the owner/name form" >&2
  exit 2
fi
if [[ ! "$rescue_workflow" =~ ^[A-Za-z0-9_.-]+\.ya?ml$ ]]; then
  echo "--rescue-workflow must be a workflow file name" >&2
  exit 2
fi
if [[ -e "$ledger_path" && ! -f "$ledger_path" ]]; then
  printf 'The ledger path is not a regular file: %s\n' "$ledger_path" >&2
  exit 2
fi

required_commands=(awk base64 date dirname gh jq mktemp rm sleep)
if [[ "$dry_run" == false ]]; then
  required_commands+=(flock mkdir touch)
fi
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s must be installed\n' "$command_name" >&2
    exit 2
  fi
done

api_version_header='X-GitHub-Api-Version: 2026-03-10'
# Requirement 5 gives each job a 60-second deadline.
terminal_wait_seconds=60
# The measurement driver already polls GitHub every two seconds.
poll_interval_seconds=2
rescue_reason="Rollback rescue for unavailable runner label ${runner_label}"
rescue_workflow_path=".github/workflows/${rescue_workflow}"
rescue_run_title_prefix='Queued run rescue'

rescue_temp=$(mktemp -d)
# shellcheck disable=SC2317,SC2329 # The EXIT trap calls this function.
cleanup_temp() {
  rm -rf -- "$rescue_temp"
}
trap cleanup_temp EXIT

github_api() {
  gh api --header "$api_version_header" "$@"
}

now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

list_runs_for_status() {
  local status=$1
  github_api \
    --method GET \
    --paginate \
    --slurp \
    "repos/$repository/actions/runs?status=$status&per_page=100" \
    | jq -c '
      [ .[] | .workflow_runs[]? ] as $runs
      | if all($runs[];
          (.id | type) == "number" and
          (.workflow_id | type) == "number" and
          (.run_attempt | type) == "number" and
          (.status | type) == "string")
        then [ $runs[] | {
          id,
          workflow_id,
          run_attempt,
          status
        } ]
        else error("GitHub returned an invalid workflow run record")
        end
    '
}

list_matching_jobs() {
  local run_id=$1
  local run_attempt=$2
  github_api \
    --method GET \
    --paginate \
    --slurp \
    "repos/$repository/actions/runs/$run_id/attempts/$run_attempt/jobs?filter=all&per_page=100" \
    | jq -c --arg label "$runner_label" '
      [ .[] | .jobs[]? ] as $jobs
      | if all($jobs[];
          (.id | type) == "number" and
          (.name | type) == "string" and
          (.status | type) == "string" and
          (.labels | type) == "array" and
          all(.labels[]; type == "string"))
        then [
          $jobs[]
          | select(
              (.status == "queued" or .status == "in_progress") and
              ((.labels | index($label)) != null)
            )
          | {
              job_id: .id,
              job_name: .name,
              job_status: .status,
              labels: .labels
            }
        ]
        else error("GitHub returned an invalid workflow job record")
        end
    '
}

queued_runs_path="$rescue_temp/queued-runs.json"
active_runs_path="$rescue_temp/in-progress-runs.json"
candidate_runs_path="$rescue_temp/candidate-runs.json"
candidate_run_lines_path="$rescue_temp/candidate-runs.jsonl"
affected_jobs_path="$rescue_temp/affected-jobs.jsonl"
affected_runs_path="$rescue_temp/affected-runs.json"
affected_run_lines_path="$rescue_temp/affected-runs.jsonl"
cancelled_runs_path="$rescue_temp/cancelled-runs.jsonl"
dispatch_runs_path="$rescue_temp/dispatch-runs.jsonl"
: > "$affected_jobs_path"
: > "$cancelled_runs_path"

list_runs_for_status queued > "$queued_runs_path"
list_runs_for_status in_progress > "$active_runs_path"
jq -s 'add | unique_by([.id, .run_attempt])' \
  "$queued_runs_path" "$active_runs_path" > "$candidate_runs_path"
jq -c '.[]' "$candidate_runs_path" > "$candidate_run_lines_path"

repository_json=$(github_api --method GET "repos/$repository")
repository_id=$(jq -er '
  if (.id | type) == "number" then .id
  else error("GitHub returned an invalid repository ID")
  end
' <<< "$repository_json")

while IFS= read -r run_record; do
  run_id=$(jq -er '.id' <<< "$run_record")
  run_attempt=$(jq -er '.run_attempt' <<< "$run_record")
  workflow_id=$(jq -er '.workflow_id' <<< "$run_record")
  run_status=$(jq -er '.status' <<< "$run_record")
  matching_jobs=$(list_matching_jobs "$run_id" "$run_attempt")
  jq -cn \
    --arg repository "$repository" \
    --argjson repository_id "$repository_id" \
    --argjson workflow_id "$workflow_id" \
    --argjson run_id "$run_id" \
    --argjson run_attempt "$run_attempt" \
    --arg run_status "$run_status" \
    --argjson jobs "$matching_jobs" '
      $jobs[]
      | {
          repository: $repository,
          repository_id: $repository_id,
          workflow_id: $workflow_id,
          run_id: $run_id,
          run_attempt: $run_attempt,
          run_status: $run_status,
          job_id,
          job_name,
          job_status,
          labels
        }
    ' >> "$affected_jobs_path"
done < "$candidate_run_lines_path"

jq -s '
  unique_by([.repository_id, .workflow_id, .run_id, .run_attempt])
  | map({
      repository,
      repository_id,
      workflow_id,
      run_id,
      run_attempt,
      run_status
    })
' "$affected_jobs_path" > "$affected_runs_path"
jq -c '.[]' "$affected_runs_path" > "$affected_run_lines_path"

affected_job_count=$(jq -s 'length' "$affected_jobs_path")
affected_run_count=$(jq 'length' "$affected_runs_path")
printf 'AFFECTED | run_count=%s | job_count=%s | label=%s\n' \
  "$affected_run_count" "$affected_job_count" "$runner_label"
jq -r '
  "AFFECTED | source=\(.repository_id)/\(.workflow_id)/\(.run_id)/\(.run_attempt)" +
  " | job_id=\(.job_id) | job_status=\(.job_status) | job_name=\(.job_name | @json)"
' "$affected_jobs_path"

cancelled_count=0
replacement_count=0
operation_failed=0
outstanding_count=0

print_summary() {
  local summary_status=success
  if ((operation_failed != 0 || outstanding_count != 0)); then
    summary_status=failed
  fi
  printf 'SUMMARY | status=%s | cancelled_count=%s | replacement_count=%s | outstanding_count=%s | ledger_path=%s\n' \
    "$summary_status" "$cancelled_count" "$replacement_count" \
    "$outstanding_count" "$ledger_path"
}

if ((affected_run_count == 0)) && [[ "$dry_run" == true ]]; then
  print_summary
  exit 0
fi

ledger_has_source_job() {
  local source_record=$1
  jq -s -e --argjson source "$source_record" '
    any(.[];
      .record_type == "source_job" and
      .repository_id == $source.repository_id and
      .workflow_id == $source.workflow_id and
      .run_id == $source.run_id and
      .run_attempt == $source.run_attempt and
      .job_id == $source.job_id)
  ' "$ledger_path" >/dev/null
}

existing_replacement_id() {
  local source_run=$1
  jq -rs --argjson source "$source_run" '
    [ .[]
      | select(
          .record_type == "replacement" and
          .repository_id == $source.repository_id and
          .workflow_id == $source.workflow_id and
          .run_id == $source.run_id and
          .run_attempt == $source.run_attempt
        )
    ] as $matches
    | if ($matches | length) == 0 then ""
      elif ($matches | length) == 1 and
        ($matches[0].replacement_run_id | type) == "number"
      then ($matches[0].replacement_run_id | tostring)
      else error("The ledger violates replacement identity uniqueness")
      end
  ' "$ledger_path"
}

resolve_rescue_commit() {
  local commit_json
  if ! commit_json=$(github_api \
    --method GET \
    --raw-field "sha=$rescue_ref" \
    --raw-field per_page=1 \
    "repos/$repository/commits"); then
    printf 'Cannot resolve rescue ref %s\n' "$rescue_ref" >&2
    return 1
  fi
  jq -er '
    if length == 1 and
      (.[0].sha | type) == "string" and
      (.[0].sha | test("^[0-9a-f]{40}$"))
    then .[0].sha
    else error("GitHub returned an invalid rescue commit")
    end
  ' <<< "$commit_json"
}

validate_rescue_workflow_file() {
  local workflow_path=$1
  awk '
    /^[[:space:]]*#/ { next }
    /runs-on/ {
      count++
      if ($0 !~ /^[[:space:]]*runs-on:[[:space:]]*ubuntu-latest[[:space:]]*$/) {
        print "Unsafe rescue workflow runs-on line: " $0 > "/dev/stderr"
        invalid=1
      }
    }
    END {
      if (count == 0) {
        print "The rescue workflow has no runs-on declarations" > "/dev/stderr"
        exit 1
      }
      if (invalid) {
        exit 1
      }
    }
  ' "$workflow_path"
}

validate_rescue_run_name_contract() {
  local workflow_path=$1
  local expected="Queued run rescue [\${{ inputs.source_repository_id }}/\${{ inputs.source_workflow_id }}/\${{ inputs.source_run_id }}/\${{ inputs.source_run_attempt }}]"
  local actual

  if ! actual=$(awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*run-name[[:space:]]*:/ {
      count++
      value=$0
      sub(/^[[:space:]]*run-name[[:space:]]*:[[:space:]]*/, "", value)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      first=substr(value, 1, 1)
      last=substr(value, length(value), 1)
      if (length(value) >= 2 &&
          ((first == "\"" && last == "\"") ||
           (first == "\047" && last == "\047"))) {
        value=substr(value, 2, length(value) - 2)
      }
      gsub(/[[:space:]]+/, " ", value)
      sub(/^ /, "", value)
      sub(/ $/, "", value)
      run_name=value
    }
    END {
      if (count != 1) {
        exit 1
      }
      print run_name
    }
  ' "$workflow_path"); then
    printf 'The rescue workflow run-name must equal: %s\n' "$expected" >&2
    return 1
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'The rescue workflow run-name must equal: %s\n' "$expected" >&2
    return 1
  fi
}

prepare_rescue_workflow() {
  local rescue_commit
  local workflow_json
  local encoded_content
  local workflow_copy="$rescue_temp/rescue-workflow.yml"

  if ! rescue_commit=$(resolve_rescue_commit); then
    return 1
  fi
  if ! workflow_json=$(github_api \
    --method GET \
    --raw-field "ref=$rescue_commit" \
    "repos/$repository/contents/$rescue_workflow_path"); then
    printf 'Cannot read %s at %s\n' "$rescue_workflow_path" "$rescue_commit" >&2
    return 1
  fi
  if ! encoded_content=$(jq -er '
    if .type == "file" and .encoding == "base64" and (.content | type) == "string"
    then (.content | gsub("\\n"; ""))
    else error("GitHub returned invalid rescue workflow content")
    end
  ' <<< "$workflow_json"); then
    return 1
  fi
  if ! printf '%s' "$encoded_content" | base64 --decode > "$workflow_copy"; then
    echo "Cannot decode the rescue workflow" >&2
    return 1
  fi
  if [[ ! -s "$workflow_copy" ]]; then
    echo "The rescue workflow is empty" >&2
    return 1
  fi
  if ! validate_rescue_workflow_file "$workflow_copy"; then
    echo "Refusing to dispatch an unsafe rescue workflow" >&2
    return 1
  fi
  if ! validate_rescue_run_name_contract "$workflow_copy"; then
    return 1
  fi
  printf 'RESCUE-WORKFLOW | ref=%s | commit=%s | runs_on=ubuntu-latest\n' \
    "$rescue_ref" "$rescue_commit" >&2
  printf '%s\n' "$rescue_commit"
}

rescue_ready=false
rescue_commit=
if [[ "$dry_run" == true ]]; then
  jq -r '
    "DRY-RUN | would_record_source_job=\(.repository_id)/\(.workflow_id)/\(.run_id)/\(.run_attempt)/\(.job_id)"
  ' "$affected_jobs_path"
  jq -r '
    "DRY-RUN | would_cancel_source=\(.repository_id)/\(.workflow_id)/\(.run_id)/\(.run_attempt)"
  ' "$affected_run_lines_path"
  if rescue_commit=$(prepare_rescue_workflow); then
    rescue_ready=true
    jq -r --arg workflow "$rescue_workflow" --arg ref "$rescue_ref" '
      "DRY-RUN | would_dispatch=\($workflow) | ref=\($ref)" +
      " | source=\(.repository_id)/\(.workflow_id)/\(.run_id)/\(.run_attempt)"
    ' "$affected_run_lines_path"
  else
    rescue_commit=
    operation_failed=1
  fi
  print_summary
  exit "$operation_failed"
fi

ledger_parent=$(dirname -- "$ledger_path")
mkdir -p -- "$ledger_parent"
touch -- "$ledger_path"
ledger_lock_path="${ledger_path}.lock"
exec {ledger_lock_fd}>> "$ledger_lock_path"
flock --exclusive "$ledger_lock_fd"

if ! jq -s -e 'all(.[]; type == "object")' "$ledger_path" >/dev/null; then
  printf 'The ledger contains invalid JSON Lines: %s\n' "$ledger_path" >&2
  exit 1
fi
if ! jq -s -e '
  [ .[]
    | select(.record_type == "replacement")
    | [ .repository_id, .workflow_id, .run_id, .run_attempt ]
  ] as $identities
  | ($identities | length) == ($identities | unique | length)
' "$ledger_path" >/dev/null; then
  printf 'The ledger contains duplicate replacement identities: %s\n' "$ledger_path" >&2
  exit 1
fi

while IFS= read -r source_job; do
  if ledger_has_source_job "$source_job"; then
    source_job_id=$(jq -er '.job_id' <<< "$source_job")
    printf 'LEDGER | source job %s already recorded\n' "$source_job_id"
    continue
  fi
  recorded_at=$(now_iso)
  jq -c --arg recorded_at "$recorded_at" '
    . + {
      record_type: "source_job",
      recorded_at: $recorded_at
    }
  ' <<< "$source_job" >> "$ledger_path"
done < "$affected_jobs_path"

jq -sc '
  . as $records
  | [
      $records[]
      | select(.record_type == "source_job")
      | {
          repository,
          repository_id,
          workflow_id,
          run_id,
          run_attempt
        }
    ]
  | unique_by([
      .repository,
      .repository_id,
      .workflow_id,
      .run_id,
      .run_attempt
    ])
  | map(
      . as $source
      | select(
          any($records[];
            .record_type == "replacement" and
            .repository_id == $source.repository_id and
            .workflow_id == $source.workflow_id and
            .run_id == $source.run_id and
            .run_attempt == $source.run_attempt
          )
          | not
        )
    )
  | sort_by([.repository_id, .workflow_id, .run_id, .run_attempt])
  | .[]
' "$ledger_path" > "$dispatch_runs_path"
dispatch_run_count=$(jq -s 'length' "$dispatch_runs_path")
outstanding_count=$dispatch_run_count

if ((affected_run_count == 0 && dispatch_run_count == 0)); then
  print_summary
  exit 0
fi

if rescue_commit=$(prepare_rescue_workflow); then
  rescue_ready=true
else
  rescue_commit=
  operation_failed=1
  print_summary
  exit "$operation_failed"
fi

wait_for_terminal_conclusion() {
  local run_id=$1
  local deadline=$((SECONDS + terminal_wait_seconds))
  local run_json
  local run_status
  local conclusion

  while ((SECONDS < deadline)); do
    if ! run_json=$(github_api \
      --method GET \
      "repos/$repository/actions/runs/$run_id"); then
      printf 'Cannot poll source run %s\n' "$run_id" >&2
      return 1
    fi
    if ! run_status=$(jq -er '
      if (.status | type) == "string" then .status
      else error("GitHub returned an invalid run status")
      end
    ' <<< "$run_json"); then
      return 1
    fi
    if [[ "$run_status" == completed ]]; then
      if ! conclusion=$(jq -er '
        if (.conclusion | type) == "string" then .conclusion
        else error("A completed run has no conclusion")
        end
      ' <<< "$run_json"); then
        return 1
      fi
      printf '%s\n' "$conclusion"
      return 0
    fi
    printf 'WAIT | run_id=%s | status=%s\n' "$run_id" "$run_status" >&2
    sleep "$poll_interval_seconds"
  done
  printf 'Source run %s did not become terminal within %s seconds\n' \
    "$run_id" "$terminal_wait_seconds" >&2
  return 1
}

while IFS= read -r source_run; do
  run_id=$(jq -er '.run_id' <<< "$source_run")
  source_identity=$(jq -r '
    "\(.repository_id)/\(.workflow_id)/\(.run_id)/\(.run_attempt)"
  ' <<< "$source_run")
  if ! github_api \
    --method POST \
    "repos/$repository/actions/runs/$run_id/cancel" >/dev/null; then
    printf 'CANCEL | source=%s | FAIL | cancel request failed\n' \
      "$source_identity" >&2
    operation_failed=1
    continue
  fi
  if ! conclusion=$(wait_for_terminal_conclusion "$run_id"); then
    printf 'CANCEL | source=%s | FAIL | terminal conclusion was not observed\n' \
      "$source_identity" >&2
    operation_failed=1
    continue
  fi
  printf 'CANCEL | source=%s | conclusion=%s\n' "$source_identity" "$conclusion"
  if [[ "$conclusion" != cancelled ]]; then
    printf 'CANCEL | source=%s | FAIL | expected conclusion=cancelled\n' \
      "$source_identity" >&2
    operation_failed=1
    continue
  fi
  printf '%s\n' "$source_run" >> "$cancelled_runs_path"
  cancelled_count=$((cancelled_count + 1))
done < "$affected_run_lines_path"

find_existing_replacement() {
  local expected_title=$1
  local paginate=$2
  local -a pagination_args=()
  if [[ "$paginate" == true ]]; then
    pagination_args=(--paginate --slurp)
  fi
  github_api \
    --method GET \
    "${pagination_args[@]}" \
    "repos/$repository/actions/workflows/$rescue_workflow/runs?event=workflow_dispatch&per_page=100" \
    | jq -c --arg title "$expected_title" --arg commit "$rescue_commit" '
      (if type == "array" then [ .[] | .workflow_runs[]? ]
       elif type == "object" and has("workflow_runs") then [ .workflow_runs[]? ]
       else error("GitHub returned an invalid replacement run list")
       end) as $runs
      | [ $runs[] | select(.display_title == $title) ] as $matches
      | if ($matches | length) == 0 then null
        elif ($matches | length) > 1 then
          error("Multiple replacement runs use the same source identity")
        elif ($matches[0].head_sha | type) != "string" then
          error("The replacement run has no head SHA")
        elif $matches[0].head_sha != $commit then
          error("The replacement run does not use the tested rescue commit")
        elif ($matches[0].id | type) != "number" then
          error("The replacement run has an invalid ID")
        else {
          replacement_run_id: $matches[0].id,
          replacement_run_url: $matches[0].html_url,
          replacement_head_sha: $matches[0].head_sha
        }
        end
    '
}

record_replacement() {
  local source_run=$1
  local replacement=$2
  local recorded_at
  recorded_at=$(now_iso)
  jq -cn \
    --argjson source "$source_run" \
    --argjson replacement "$replacement" \
    --arg recorded_at "$recorded_at" \
    --arg rescue_workflow "$rescue_workflow" \
    --arg rescue_ref "$rescue_ref" \
    --arg rescue_commit "$rescue_commit" '
      {
        record_type: "replacement",
        recorded_at: $recorded_at,
        repository: $source.repository,
        repository_id: $source.repository_id,
        workflow_id: $source.workflow_id,
        run_id: $source.run_id,
        run_attempt: $source.run_attempt,
        replacement_workflow: $rescue_workflow,
        replacement_ref: $rescue_ref,
        replacement_commit: $rescue_commit,
        replacement_run_id: $replacement.replacement_run_id,
        replacement_run_url: $replacement.replacement_run_url
      }
    ' >> "$ledger_path"
}

if [[ "$rescue_ready" == true ]]; then
  while IFS= read -r source_run; do
    run_failed=0
    source_identity=$(jq -r '
      "\(.repository_id)/\(.workflow_id)/\(.run_id)/\(.run_attempt)"
    ' <<< "$source_run")
    if ! replacement_run_id=$(existing_replacement_id "$source_run"); then
      printf 'DISPATCH | source=%s | FAIL | invalid replacement ledger state\n' \
        "$source_identity" >&2
      operation_failed=1
      run_failed=1
      continue
    fi
    if [[ -n "$replacement_run_id" ]]; then
      printf 'DISPATCH | source=%s | SKIP | replacement_run_id=%s already recorded\n' \
        "$source_identity" "$replacement_run_id"
      outstanding_count=$((outstanding_count - 1))
      continue
    fi

    expected_title=$(jq -r --arg prefix "$rescue_run_title_prefix" '
      $prefix + " [" +
      (.repository_id | tostring) + "/" +
      (.workflow_id | tostring) + "/" +
      (.run_id | tostring) + "/" +
      (.run_attempt | tostring) + "]"
    ' <<< "$source_run")
    if ! replacement=$(find_existing_replacement "$expected_title" true); then
      printf 'DISPATCH | source=%s | FAIL | cannot check existing replacements\n' \
        "$source_identity" >&2
      operation_failed=1
      run_failed=1
      continue
    fi
    if [[ "$replacement" != null ]]; then
      record_replacement "$source_run" "$replacement"
      replacement_run_id=$(jq -er '.replacement_run_id' <<< "$replacement")
      outstanding_count=$((outstanding_count - 1))
      printf 'DISPATCH | source=%s | RECOVERED | replacement_run_id=%s\n' \
        "$source_identity" "$replacement_run_id"
      continue
    fi

    if ! current_rescue_commit=$(resolve_rescue_commit); then
      operation_failed=1
      run_failed=1
      continue
    fi
    if [[ "$current_rescue_commit" != "$rescue_commit" ]]; then
      printf 'DISPATCH | source=%s | FAIL | rescue ref moved from %s to %s\n' \
        "$source_identity" "$rescue_commit" "$current_rescue_commit" >&2
      operation_failed=1
      run_failed=1
      continue
    fi

    dispatch_payload=$(jq -cn \
      --arg ref "$rescue_ref" \
      --arg source_run_id "$(jq -r '.run_id | tostring' <<< "$source_run")" \
      --arg source_run_attempt "$(jq -r '.run_attempt | tostring' <<< "$source_run")" \
      --arg source_workflow_id "$(jq -r '.workflow_id | tostring' <<< "$source_run")" \
      --arg source_repository_id "$(jq -r '.repository_id | tostring' <<< "$source_run")" \
      --arg rescue_reason "$rescue_reason" '
        {
          ref: $ref,
          inputs: {
            source_run_id: $source_run_id,
            source_run_attempt: $source_run_attempt,
            source_workflow_id: $source_workflow_id,
            source_repository_id: $source_repository_id,
            rescue_reason: $rescue_reason
          }
        }
      ')
    if ! printf '%s\n' "$dispatch_payload" \
      | github_api \
        --method POST \
        --input - \
        "repos/$repository/actions/workflows/$rescue_workflow/dispatches" >/dev/null; then
      printf 'DISPATCH | source=%s | FAIL | workflow dispatch failed\n' \
        "$source_identity" >&2
      operation_failed=1
      run_failed=1
      continue
    fi

    replacement_deadline=$((SECONDS + terminal_wait_seconds))
    replacement=null
    while ((SECONDS < replacement_deadline)); do
      if ! replacement=$(find_existing_replacement "$expected_title" false); then
        operation_failed=1
        run_failed=1
        break
      fi
      if [[ "$replacement" != null ]]; then
        break
      fi
      sleep "$poll_interval_seconds"
    done
    if ((run_failed != 0)); then
      continue
    fi
    if [[ "$replacement" == null ]]; then
      printf 'DISPATCH | source=%s | FAIL | replacement run was not observed within %s seconds\n' \
        "$source_identity" "$terminal_wait_seconds" >&2
      operation_failed=1
      run_failed=1
      continue
    fi

    record_replacement "$source_run" "$replacement"
    replacement_run_id=$(jq -er '.replacement_run_id' <<< "$replacement")
    replacement_count=$((replacement_count + 1))
    outstanding_count=$((outstanding_count - 1))
    printf 'DISPATCH | source=%s | replacement_run_id=%s | commit=%s\n' \
      "$source_identity" "$replacement_run_id" "$rescue_commit"
  done < "$dispatch_runs_path"
fi

if ((outstanding_count > 0)); then
  printf 'DISPATCH | FAIL | outstanding_count=%s\n' "$outstanding_count" >&2
  operation_failed=1
fi

print_summary
exit "$operation_failed"
