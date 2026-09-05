#!/usr/bin/env bash
set -euo pipefail

operations_doc='docs/AUTOPILOT-OPERATIONS.md'

usage() {
  cat <<'EOF'
Usage: scripts/preflight-scale-set.sh --scale-set <name> [options]

Validate one AUTOPILOT_SCALE_SETS entry without changing GitHub.

Options:
  --config <json>              Read configuration from JSON.
  --config @<path>             Read configuration from a file.
  --scale-set <name>           Select the runner scale set entry.
  --live                       Query GitHub for the runner scale set.
  --registration-token <token> Use an existing runner registration token.
  -h, --help                   Show this help.

AUTOPILOT_SCALE_SETS supplies the configuration when --config is absent.
REGISTRATION_TOKEN supplies a registration token when the option is absent.
GITHUB_TOKEN authorizes the registration-token request for --live.
EOF
}

fail() {
  printf 'Scale set preflight failed: %s Read %s.\n' \
    "$1" "$operations_doc" >&2
  exit "${2:-1}"
}

is_http_url() {
  [[ "$1" =~ ^https?://[^/?#[:space:]]+([/?#][^[:space:]]*)?$ ]]
}

is_https_url() {
  [[ "$1" =~ ^https://[^/?#[:space:]]+([/?#][^[:space:]]*)?$ ]]
}

config_input=
scale_set=
live=false
registration_token=${REGISTRATION_TOKEN:-}

while (($# > 0)); do
  case "$1" in
    --config | --scale-set | --registration-token)
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
  fail "Install jq before you run this check." 2
fi
if [[ "$live" == true ]] && ! command -v curl >/dev/null 2>&1; then
  fail "Install curl before you run --live." 2
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
if ! preflight_temp=$(mktemp -d); then
  fail "Provide a writable temporary directory." 2
fi
trap 'rm -rf -- "$preflight_temp"' EXIT

config_file="$preflight_temp/config.json"
candidates_file="$preflight_temp/candidates.json"
entry_file="$preflight_temp/entry.json"
printf '%s' "$config_json" >"$config_file"
unset config_json config_input

problems=()
add_problem() {
  problems+=("$1 Read $operations_doc.")
}

scale_set_pattern='^[A-Za-z0-9][A-Za-z0-9_.-]*$'
if [[ ! "$scale_set" =~ $scale_set_pattern ]]; then
  add_problem "Set --scale-set to a name that matches $scale_set_pattern."
fi

if ! jq -e . >/dev/null 2>&1 <"$config_file"; then
  add_problem "Fix the configuration JSON syntax."
  printf 'Scale set preflight failed. Fix every item below.\n' >&2
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

if ((candidate_count > 0)); then
  jq -c '.[0].value' <"$candidates_file" >"$entry_file"
  resolved_name_type=$(jq -r '.[0].resolvedName | type' <"$candidates_file")
  if [[ "$resolved_name_type" == string ]]; then
    resolved_name=$(jq -r '.[0].resolvedName' <"$candidates_file")
  else
    resolved_name=
  fi

  if [[ ! "$resolved_name" =~ $scale_set_pattern ]]; then
    add_problem "Set scaleSetName, name, or the object key to a value that matches $scale_set_pattern."
  elif [[ "$resolved_name" != "$scale_set" ]]; then
    add_problem "Make the resolved scaleSetName equal the --scale-set value."
  fi

  outage_gate_url=
  if jq -e '
    has("outageGateUrl")
    and (.outageGateUrl | type) == "string"
    and (.outageGateUrl | length) > 0
  ' >/dev/null <"$entry_file"; then
    outage_gate_url=$(jq -r '.outageGateUrl' <"$entry_file")
  fi
  if [[ -z "$outage_gate_url" ]]; then
    add_problem "Set outageGateUrl to an HTTP or HTTPS URL."
  elif ! is_http_url "$outage_gate_url"; then
    add_problem "Change outageGateUrl to a valid HTTP or HTTPS URL."
  fi

  positive_integer_filter='
    type == "number"
    and . > 0
    and . == floor
    and . <= 9007199254740991
  '
  scale_set_id_valid=false
  runner_group_id_valid=false
  if jq -e ".scaleSetId | $positive_integer_filter" \
    >/dev/null <"$entry_file"; then
    scale_set_id_valid=true
  fi
  if jq -e ".runnerGroupId | $positive_integer_filter" \
    >/dev/null <"$entry_file"; then
    runner_group_id_valid=true
  fi
  if [[ "$scale_set_id_valid" == false && "$runner_group_id_valid" == false ]]; then
    add_problem "Set scaleSetId or runnerGroupId to a positive safe integer."
  fi

  static_actions_service_url=
  if jq -e '
    has("actionsServiceUrl")
    and (.actionsServiceUrl | type) == "string"
    and (.actionsServiceUrl | length) > 0
  ' >/dev/null <"$entry_file"; then
    static_actions_service_url=$(jq -r '.actionsServiceUrl' <"$entry_file")
  fi
  static_admin_token_valid=false
  if jq -e '
    has("adminToken")
    and (.adminToken | type) == "string"
    and (.adminToken | length) > 0
  ' >/dev/null <"$entry_file"; then
    static_admin_token_valid=true
  fi
  static_admin_expiry_valid=false
  if jq -e ".adminTokenExpiresAtMs | $positive_integer_filter" \
    >/dev/null <"$entry_file"; then
    static_admin_expiry_valid=true
  fi
  static_connection_valid=false
  if [[ -n "$static_actions_service_url" ]] \
    && is_https_url "$static_actions_service_url" \
    && [[ "$static_admin_token_valid" == true ]] \
    && [[ "$static_admin_expiry_valid" == true ]]; then
    static_connection_valid=true
  fi

  if jq -e 'has("appId") and .appId != null' \
    >/dev/null <"$entry_file"; then
    app_id=$(jq -r '.appId | tostring' <"$entry_file")
  else
    app_id=${GITHUB_APP_ID:-}
  fi
  if jq -e 'has("installationId") and .installationId != null' \
    >/dev/null <"$entry_file"; then
    installation_id=$(jq -r '.installationId | tostring' <"$entry_file")
  else
    installation_id=${GITHUB_APP_INSTALLATION_ID:-}
  fi
  if jq -e 'has("privateKeyPkcs8") and .privateKeyPkcs8 != null' \
    >/dev/null <"$entry_file"; then
    private_key=$(jq -r '
      if (.privateKeyPkcs8 | type) == "string"
      then .privateKeyPkcs8
      else empty
      end
    ' <"$entry_file")
  else
    private_key=${GITHUB_APP_PRIVATE_KEY:-}
  fi
  private_key_present=false
  if [[ -n "$private_key" ]]; then
    private_key_present=true
  fi
  unset private_key

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

  scope_valid=false
  if jq -e 'has("scope") and .scope != null' \
    >/dev/null <"$entry_file"; then
    if jq -e '
      def first_not_null($values):
        first($values[] | select(. != null));
      .scope as $scope
      | (first_not_null([$scope.type, $scope.level, $scope.kind])) as $type
      | if $type == "repository" then
          (first_not_null([$scope.owner, $scope.organization, null])) as $owner
          | (first_not_null([$scope.repository, $scope.repo, null])) as $repo
          | (
              ($owner | type) == "string"
              and ($owner | length) > 0
              and ($repo | type) == "string"
              and ($repo | length) > 0
            ) or (
              $owner == null
              and ($repo | type) == "string"
              and ($repo | test("^[^/]+/[^/]+$"))
            )
        elif $type == "organization" then
          first_not_null([
            $scope.organization,
            $scope.org,
            $scope.owner,
            null
          ])
          | type == "string" and length > 0
        else false
        end
    ' >/dev/null <"$entry_file"; then
      scope_valid=true
    fi
  elif [[ -n "$repository" ]]; then
    if [[ "$repository" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
      scope_valid=true
    fi
  elif [[ -n "$owner" ]]; then
    scope_valid=true
  fi

  config_url_valid=false
  if jq -e 'has("configUrl") and .configUrl != null' \
    >/dev/null <"$entry_file"; then
    if jq -e '
      (.configUrl | type) == "string" and (.configUrl | length) > 0
    ' >/dev/null <"$entry_file"; then
      config_url_valid=true
    fi
  elif jq -e '.scope.type == "repository"' \
    >/dev/null <"$entry_file"; then
    if [[ -n "$repository" ]]; then
      config_url_valid=true
    fi
  elif [[ -n "$owner" ]]; then
    config_url_valid=true
  elif ! jq -e 'has("scope") and .scope != null' \
    >/dev/null <"$entry_file" && [[ -n "$repository" ]]; then
    config_url_valid=true
  fi

  app_connection_valid=false
  if [[ -n "$app_id" && -n "$installation_id" ]] \
    && [[ "$private_key_present" == true ]] \
    && [[ -n "$repository" || -n "$owner" ]] \
    && [[ "$scope_valid" == true && "$config_url_valid" == true ]]; then
    app_connection_valid=true
  fi
  github_token_connection_valid=false
  if [[ -n "${GITHUB_TOKEN:-}" ]] \
    && [[ "$scope_valid" == true && "$config_url_valid" == true ]]; then
    github_token_connection_valid=true
  fi
  if [[ "$static_connection_valid" == false ]] \
    && [[ "$app_connection_valid" == false ]] \
    && [[ "$github_token_connection_valid" == false ]]; then
    add_problem "Complete one admin connection path. Set the static trio; set the GitHub App inputs with repository or owner; or set GITHUB_TOKEN with a valid repository, owner, or explicit scope and configUrl. For a repository-scoped runner, GITHUB_TOKEN needs the classic PAT/OAuth \`repo\` scope or the fine-grained PAT \`Administration: write\` permission on the repository. For an organization-scoped runner, GITHUB_TOKEN needs the classic PAT/OAuth \`admin:org\` scope, plus \`repo\` when the repository is private."
  fi

  if [[ "$live" == true ]]; then
    if [[ "$runner_group_id_valid" == false ]]; then
      if [[ "$scale_set_id_valid" == true ]]; then
        add_problem "The --live check cannot query by scaleSetId alone. Add a positive runnerGroupId."
      else
        add_problem "Add a positive runnerGroupId for the --live lookup."
      fi
    else
      runner_group_id=$(jq -r '.runnerGroupId' <"$entry_file")
    fi

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
        add_problem "Set GITHUB_TOKEN or supply --registration-token for --live."
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
          add_problem "Set repository to the owner/repository form for --live."
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
  printf 'Scale set preflight failed. Fix every item below.\n' >&2
  printf -- '- %s\n' "${problems[@]}" >&2
  exit 1
fi

printf 'offline scale set configuration is valid: %s\n' "$resolved_name"
if [[ "$live" == false ]]; then
  exit 0
fi

registration_response="$preflight_temp/registration-response.json"
connection_request="$preflight_temp/connection-request.json"
connection_response="$preflight_temp/connection-response.json"
scale_set_response="$preflight_temp/scale-set-response.json"

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
unset admin_token
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
if ((scale_set_count == 0)); then
  fail "The runner scale set does not exist. Create $resolved_name in the configured runner group."
fi
if ! live_scale_set_id=$(jq -er '
  .value[0].id
  | select(
      type == "number"
      and . > 0
      and . == floor
      and . <= 9007199254740991
    )
' "$scale_set_response" 2>/dev/null); then
  fail "The runner scale set response has no positive integer id. Retry the lookup."
fi

printf 'scale set exists: id=%s runnerGroupId=%s\n' \
  "$live_scale_set_id" "$runner_group_id"
