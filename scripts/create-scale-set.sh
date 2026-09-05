#!/usr/bin/env bash
set -euo pipefail

operations_doc='docs/AUTOPILOT-OPERATIONS.md'
user_agent='gha-cloudflare-runner-create-scale-set'

usage() {
  cat <<'EOF'
Usage: scripts/create-scale-set.sh --scale-set <name> [options]

Print the runner scale set creation request. Send it only with --apply.

Options:
  --config <json>              Read configuration from JSON.
  --config @<path>             Read configuration from a file.
  --scale-set <name>           Select the runner scale set entry.
  --runner-group-id <id>       Override the configured runner group ID.
  --label <name>               Add one extra runner label. Repeat for more.
  --live                       Resolve the Actions Service and check for a duplicate.
  --apply                      Send the creation request. Implies --live.
  --registration-token <token> Use an existing runner registration token.
  -h, --help                   Show this help.

AUTOPILOT_SCALE_SETS supplies the configuration when --config is absent.
REGISTRATION_TOKEN supplies a registration token when the option is absent.
GITHUB_TOKEN authorizes the registration-token request for --live and --apply.
EOF
}

fail() {
  printf 'Scale set creation failed: %s Read %s.\n' \
    "$1" "$operations_doc" >&2
  exit "${2:-1}"
}

is_https_url() {
  [[ "$1" =~ ^https://[^/?#[:space:]]+([/?#][^[:space:]]*)?$ ]]
}

config_input=
scale_set=
runner_group_id_override=
live=false
apply=false
registration_token=${REGISTRATION_TOKEN:-}
extra_labels=()

while (($# > 0)); do
  case "$1" in
    --config | --scale-set | --runner-group-id | --label | --registration-token)
      if (($# < 2)) || [[ -z "$2" ]]; then
        fail "$1 requires a non-empty value." 2
      fi
      case "$1" in
        --config)
          config_input=$2
          ;;
        --scale-set)
          scale_set=$2
          ;;
        --runner-group-id)
          runner_group_id_override=$2
          ;;
        --label)
          extra_labels+=("$2")
          ;;
        --registration-token)
          registration_token=$2
          ;;
      esac
      shift 2
      ;;
    --live)
      live=true
      shift
      ;;
    --apply)
      apply=true
      live=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "Remove the unknown option and use --help." 2
      ;;
  esac
done

if [[ -z "$scale_set" ]]; then
  fail "Set --scale-set to the configured runner scale set name." 2
fi

if ! command -v jq >/dev/null 2>&1; then
  fail "Install jq before you run this tool." 2
fi
if [[ "$live" == true ]] && ! command -v curl >/dev/null 2>&1; then
  fail "Install curl before you run --live or --apply." 2
fi

if [[ -n "$config_input" ]]; then
  if [[ "$config_input" == @* ]]; then
    config_path=${config_input#@}
    if [[ ! -f "$config_path" ]]; then
      fail "Create the --config file at the specified path." 2
    fi
    config_json=$(<"$config_path")
  else
    config_json=$config_input
  fi
else
  config_json=${AUTOPILOT_SCALE_SETS:-}
fi
if [[ -z "$config_json" ]]; then
  fail "Set --config or AUTOPILOT_SCALE_SETS to the scale set JSON." 2
fi

umask 077
if ! tmp=$(mktemp -d); then
  fail "Provide a writable temporary directory." 2
fi
trap 'rm -rf -- "$tmp"' EXIT

config_file="$tmp/config.json"
candidates_file="$tmp/candidates.json"
entry_file="$tmp/entry.json"
printf '%s' "$config_json" >"$config_file"
unset config_json config_input

problems=()
add_problem() {
  problems+=("$1 Read $operations_doc.")
}

scale_set_pattern='^[A-Za-z0-9][A-Za-z0-9_.-]*$'
positive_integer_filter='
  type == "number"
  and . > 0
  and . == floor
  and . <= 9007199254740991
'
if [[ ! "$scale_set" =~ $scale_set_pattern ]]; then
  add_problem "Set --scale-set to a name that matches $scale_set_pattern."
fi

if ! jq -e . >/dev/null 2>&1 <"$config_file"; then
  add_problem "Fix the configuration JSON syntax."
  printf 'Scale set creation failed. Fix every item below.\n' >&2
  printf -- '- %s\n' "${problems[@]}" >&2
  exit 1
fi

config_type=$(jq -r 'type' <"$config_file")
if [[ "$config_type" != object && "$config_type" != array ]]; then
  add_problem "Use an object or an array for AUTOPILOT_SCALE_SETS."
fi

jq -c --arg requested "$scale_set" '
  def resolved_name($entry; $fallback):
    if (($entry | has("scaleSetName")) and $entry.scaleSetName != null)
    then $entry.scaleSetName
    elif (($entry | has("name")) and $entry.name != null)
    then $entry.name
    else $fallback
    end;

  if type == "array" then
    [
      .[]
      | select(type == "object")
      | . as $entry
      | {
          value: $entry,
          resolvedName: resolved_name($entry; null)
        }
      | select(.resolvedName == $requested)
    ]
  elif type == "object" then
    if has($requested) then
      .[$requested] as $entry
      | if ($entry | type) == "object" then
          [{
            value: $entry,
            resolvedName: resolved_name($entry; $requested)
          }]
        else []
        end
    elif has("scaleSetName") or has("name") then
      . as $entry
      | [{
          value: $entry,
          resolvedName: resolved_name($entry; null)
        }]
      | map(select(.resolvedName == $requested))
    else []
    end
  else []
  end
' <"$config_file" >"$candidates_file"

candidate_count=$(jq -r 'length' <"$candidates_file")
if ((candidate_count != 1)); then
  add_problem "Make AUTOPILOT_SCALE_SETS resolve to exactly one object for --scale-set."
fi

resolved_name=
runner_group_id=
actions_service_url='<actionsServiceUrl>'
repository=
owner=
config_url=
registration_level=
registration_owner=
registration_repository=

if ((candidate_count > 0)); then
  jq -c '.[0].value' <"$candidates_file" >"$entry_file"
  resolved_name_type=$(jq -r '.[0].resolvedName | type' <"$candidates_file")
  if [[ "$resolved_name_type" == string ]]; then
    resolved_name=$(jq -r '.[0].resolvedName' <"$candidates_file")
  fi

  if [[ ! "$resolved_name" =~ $scale_set_pattern ]]; then
    add_problem "Set scaleSetName, name, or the object key to a value that matches $scale_set_pattern."
  elif [[ "$resolved_name" != "$scale_set" ]]; then
    add_problem "Make the resolved scaleSetName equal the --scale-set value."
  fi

  runner_group_id_valid=false
  if [[ -n "$runner_group_id_override" ]]; then
    runner_group_override_file="$tmp/runner-group-override.json"
    jq -cn --arg value "$runner_group_id_override" \
      '$value | tonumber?' >"$runner_group_override_file"
    if [[ -s "$runner_group_override_file" ]] \
      && jq -e "$positive_integer_filter" \
        >/dev/null 2>&1 <"$runner_group_override_file"; then
      runner_group_id_valid=true
      runner_group_id=$(jq -r . <"$runner_group_override_file")
    fi
  elif jq -e ".runnerGroupId | $positive_integer_filter" \
    >/dev/null 2>&1 <"$entry_file"; then
    runner_group_id_valid=true
    runner_group_id=$(jq -r '.runnerGroupId' <"$entry_file")
  fi
  if [[ "$runner_group_id_valid" == false ]]; then
    add_problem "Set runnerGroupId or --runner-group-id to a positive safe integer."
  fi

  if jq -e 'has("actionsServiceUrl") and .actionsServiceUrl != null' \
    >/dev/null <"$entry_file"; then
    if jq -e '
      (.actionsServiceUrl | type) == "string"
      and (.actionsServiceUrl | length) > 0
    ' >/dev/null <"$entry_file"; then
      configured_actions_service_url=$(jq -r '.actionsServiceUrl' \
        <"$entry_file")
      if is_https_url "$configured_actions_service_url"; then
        actions_service_url=$configured_actions_service_url
      else
        add_problem "Change actionsServiceUrl to a valid HTTPS URL."
      fi
    else
      add_problem "Set actionsServiceUrl to a non-empty HTTPS URL."
    fi
  fi

  repository=$(jq -r '
    if has("repository") and (.repository | type) == "string"
    then .repository
    else empty
    end
  ' <"$entry_file")
  owner=$(jq -r '
    if has("owner") and (.owner | type) == "string"
    then .owner
    else empty
    end
  ' <"$entry_file")

  if [[ "$live" == true ]]; then
    config_url=$(jq -r '
      if has("configUrl") and (.configUrl | type) == "string"
      then .configUrl
      else empty
      end
    ' <"$entry_file")
    if [[ -z "$config_url" ]]; then
      if [[ -n "$repository" ]]; then
        config_url="https://github.com/$repository"
      elif [[ -n "$owner" ]]; then
        config_url="https://github.com/$owner"
      else
        add_problem "Set configUrl, repository, or owner for the runner-registration handshake."
      fi
    fi

    if [[ -z "$registration_token" ]]; then
      if [[ -z "${GITHUB_TOKEN:-}" ]]; then
        add_problem "Set GITHUB_TOKEN or supply --registration-token for --live or --apply."
      fi

      scope_type=$(jq -r '
        if (.scope | type) == "object" then
          if .scope.type != null then .scope.type
          elif .scope.level != null then .scope.level
          elif .scope.kind != null then .scope.kind
          else empty
          end
        else empty
        end
      ' <"$entry_file")
      if [[ -n "$scope_type" ]]; then
        case "$scope_type" in
          repository)
            scope_repository=$(jq -r '
              if (.scope.repository | type) == "string"
              then .scope.repository
              elif (.scope.repo | type) == "string"
              then .scope.repo
              else empty
              end
            ' <"$entry_file")
            scope_owner=$(jq -r '
              if (.scope.owner | type) == "string" then .scope.owner
              elif (.scope.organization | type) == "string"
              then .scope.organization
              else empty
              end
            ' <"$entry_file")
            if [[ -z "$scope_owner" && "$scope_repository" == */* ]]; then
              scope_owner=${scope_repository%%/*}
              scope_repository=${scope_repository#*/}
            fi
            if [[ -z "$scope_owner" || -z "$scope_repository" \
              || "$scope_repository" == */* ]]; then
              add_problem "Fix scope so its repository level has one owner and one repository."
            else
              registration_level=repository
              registration_owner=$scope_owner
              registration_repository=$scope_repository
            fi
            ;;
          organization)
            scope_owner=$(jq -r '
              if (.scope.organization | type) == "string"
              then .scope.organization
              elif (.scope.org | type) == "string" then .scope.org
              elif (.scope.owner | type) == "string" then .scope.owner
              else empty
              end
            ' <"$entry_file")
            if [[ -z "$scope_owner" ]]; then
              add_problem "Fix scope so its organization level has an organization."
            else
              registration_level=organization
              registration_owner=$scope_owner
            fi
            ;;
          *)
            add_problem "Set scope to a repository or organization runner scope."
            ;;
        esac
      elif [[ -n "$repository" ]]; then
        if [[ ! "$repository" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
          add_problem "Set repository to the owner/repository form for --live or --apply."
        else
          registration_level=repository
          registration_owner=${repository%%/*}
          registration_repository=${repository#*/}
        fi
      elif [[ -n "$owner" ]]; then
        registration_level=organization
        registration_owner=$owner
      else
        add_problem "Set repository, owner, or scope for the registration-token request."
      fi
    fi
  fi
fi

if ((${#problems[@]} > 0)); then
  printf 'Scale set creation failed. Fix every item below.\n' >&2
  printf -- '- %s\n' "${problems[@]}" >&2
  exit 1
fi

request_file="$tmp/create-request.json"
request_body=$(jq -cn \
  --arg name "$resolved_name" \
  --argjson runner_group_id "$runner_group_id" \
  --args '
    {
      name: $name,
      runnerGroupId: $runner_group_id,
      labels: (
        reduce $ARGS.positional[] as $label
          ([];
            if any(.[]; .name == $label)
            then .
            else . + [{type: "System", name: $label}]
            end
          )
      ),
      RunnerSetting: {disableUpdate: true},
      createdOn: "0001-01-01T00:00:00Z"
    }
  ' "$resolved_name" "${extra_labels[@]}")
printf '%s' "$request_body" >"$request_file"
unset request_body

registration_response="$tmp/registration-response.json"
connection_request="$tmp/connection-request.json"
connection_response="$tmp/connection-response.json"
scale_set_response="$tmp/scale-set-response.json"

if [[ "$live" == true ]]; then
  if [[ -z "$registration_token" ]]; then
    encoded_owner=$(jq -nr --arg value "$registration_owner" '$value | @uri')
    if [[ "$registration_level" == repository ]]; then
      encoded_repository=$(jq -nr \
        --arg value "$registration_repository" '$value | @uri')
      registration_url="https://api.github.com/repos/$encoded_owner/$encoded_repository/actions/runners/registration-token"
    else
      registration_url="https://api.github.com/orgs/$encoded_owner/actions/runners/registration-token"
    fi

    curl_status=0
    http_status=$(
      curl --silent --show-error \
        --request POST \
        --header "Authorization: Bearer $GITHUB_TOKEN" \
        --output "$registration_response" \
        --write-out '%{http_code}' \
        "$registration_url"
    ) || curl_status=$?
    if ((curl_status != 0)); then
      fail "The registration-token request failed. Check GITHUB_TOKEN and the selected scope."
    fi
    if [[ "$http_status" != 201 ]]; then
      fail "The registration-token request did not return HTTP 201. Check the principal permissions."
    fi
    if ! registration_token=$(jq -er '
      if (.token | type) == "string" and (.token | length) > 0
      then .token
      else error("missing token")
      end
    ' "$registration_response" 2>/dev/null); then
      fail "GitHub returned no registration token. Check the principal permissions."
    fi
  fi

  jq -cn --arg url "$config_url" \
    '{url: $url, runner_event: "register"}' >"$connection_request"
  curl_status=0
  http_status=$(
    curl --silent --show-error \
      --request POST \
      --header "Authorization: RemoteAuth $registration_token" \
      --header 'Content-Type: application/json' \
      --data-binary "@$connection_request" \
      --output "$connection_response" \
      --write-out '%{http_code}' \
      'https://api.github.com/actions/runner-registration'
  ) || curl_status=$?
  unset registration_token
  if ((curl_status != 0)); then
    fail "The runner-registration handshake failed. Check the registration token and configUrl."
  fi
  if [[ ! "$http_status" =~ ^2[0-9][0-9]$ ]]; then
    fail "The runner-registration handshake returned a non-success status. Check configUrl and the registration token."
  fi
  if ! actions_service_url=$(jq -er '
    if (.url | type) == "string" and (.url | length) > 0
    then .url
    else error("missing url")
    end
  ' "$connection_response" 2>/dev/null); then
    fail "The runner-registration response has no Actions Service URL. Retry the handshake."
  fi
  if ! is_https_url "$actions_service_url"; then
    fail "The runner-registration response has a non-HTTPS Actions Service URL. Retry the handshake."
  fi
  if ! admin_token=$(jq -er '
    if (.token | type) == "string" and (.token | length) > 0
    then .token
    else error("missing token")
    end
  ' "$connection_response" 2>/dev/null); then
    fail "The runner-registration response has no admin token. Retry the handshake."
  fi

  encoded_scale_set=$(jq -nr --arg value "$resolved_name" '$value | @uri')
  lookup_url="${actions_service_url%/}/_apis/runtime/runnerscalesets?runnerGroupId=$runner_group_id&name=$encoded_scale_set&api-version=6.0-preview"
  curl_status=0
  http_status=$(
    curl --silent --show-error \
      --request GET \
      --header "Authorization: Bearer $admin_token" \
      --output "$scale_set_response" \
      --write-out '%{http_code}' \
      "$lookup_url"
  ) || curl_status=$?
  if ((curl_status != 0)); then
    fail "The runner scale set lookup failed. Check runnerGroupId and the Actions Service connection."
  fi
  if [[ "$http_status" != 200 ]]; then
    fail "The runner scale set lookup did not return HTTP 200. Check runnerGroupId and the admin connection."
  fi
  if ! jq -e '.value | type == "array"' >/dev/null 2>&1 \
    <"$scale_set_response"; then
    fail "The runner scale set lookup returned no value array. Retry the lookup."
  fi
  scale_set_count=$(jq -r '.value | length' <"$scale_set_response")
  if ((scale_set_count > 0)); then
    existing_scale_set_id=$(jq -r '
      .value[0].id
      | if (
          type == "number"
          and . > 0
          and . == floor
          and . <= 9007199254740991
        )
        then tostring
        else "unknown"
        end
    ' <"$scale_set_response")
    fail "The runner scale set already exists: id=$existing_scale_set_id runnerGroupId=$runner_group_id. Do not create it twice."
  fi
fi

printf 'POST %s/_apis/runtime/runnerscalesets?api-version=6.0-preview\n' \
  "${actions_service_url%/}"
printf 'Content-Type: application/json\n'
printf 'Authorization: Bearer <adminToken>\n'
printf 'User-Agent: %s\n' "$user_agent"
printf '%s\n' "$(<"$request_file")"

if [[ "$apply" == false ]]; then
  unset admin_token 2>/dev/null || true
  exit 0
fi

creation_response="$tmp/creation-response.json"
creation_url="${actions_service_url%/}/_apis/runtime/runnerscalesets?api-version=6.0-preview"
curl_status=0
http_status=$(
  curl --silent --show-error \
    --request POST \
    --header 'Content-Type: application/json' \
    --header "Authorization: Bearer $admin_token" \
    --header "User-Agent: $user_agent" \
    --data-binary "@$request_file" \
    --output "$creation_response" \
    --write-out '%{http_code}' \
    "$creation_url"
) || curl_status=$?
unset admin_token
if ((curl_status != 0)); then
  fail "The runner scale set creation request failed. Check the Actions Service connection."
fi
if [[ "$http_status" != 200 ]]; then
  fail "The runner scale set creation request did not return HTTP 200. Do not assume that GitHub created it."
fi
if ! created_scale_set_id=$(jq -er ".id | select($positive_integer_filter)" \
  "$creation_response" 2>/dev/null); then
  fail "The runner scale set creation response has no positive integer id. Do not use the response."
fi

autopilot_entry="$tmp/autopilot-scale-sets-entry.json"
jq -cS \
  --arg name "$resolved_name" \
  --argjson scale_set_id "$created_scale_set_id" \
  --argjson runner_group_id "$runner_group_id" '
    . as $entry
    | {
        ($name): (
          $entry
          | .scaleSetId = $scale_set_id
          | .runnerGroupId = $runner_group_id
          | del(.adminToken, .privateKeyPkcs8)
        )
      }
  ' <"$entry_file" >"$autopilot_entry"

printf 'created scale set: id=%s runnerGroupId=%s\n' \
  "$created_scale_set_id" "$runner_group_id"
printf 'AUTOPILOT_SCALE_SETS entry:\n'
printf '%s\n' "$(<"$autopilot_entry")"
