#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage:' \
    '  scripts/outage-gate.sh open --reason TEXT --actor NAME [--url URL]' \
    '  scripts/outage-gate.sh close --reason TEXT [--url URL]' \
    '  scripts/outage-gate.sh status [--url URL]' \
    '  scripts/outage-gate.sh public-key --key PATH' \
    '  scripts/outage-gate.sh secret --key PATH' \
    '      --i-understand-this-prints-a-private-key' >&2
}

usage_error() {
  usage
  printf '%s\n' "$1" >&2
  exit 2
}

duplicate_option() {
  usage_error "Option can be used only once: $1"
}

if (($# == 0)); then
  usage_error 'A subcommand is required'
fi

case "$1" in
  -h | --help)
    usage
    exit 0
    ;;
  open | close | status | public-key | secret)
    subcommand=$1
    shift
    ;;
  *)
    usage_error "Unknown subcommand: $1"
    ;;
esac

reason=''
actor=''
url=''
key_path=''
reason_set=false
actor_set=false
url_set=false
key_set=false
private_key_acknowledged=false

while (($# > 0)); do
  case "$1" in
    --reason)
      if (($# < 2)); then
        usage_error '--reason requires a value'
      fi
      if [[ "$reason_set" == true ]]; then
        duplicate_option '--reason'
      fi
      reason=$2
      reason_set=true
      shift
      ;;
    --actor)
      if (($# < 2)); then
        usage_error '--actor requires a value'
      fi
      if [[ "$actor_set" == true ]]; then
        duplicate_option '--actor'
      fi
      actor=$2
      actor_set=true
      shift
      ;;
    --url)
      if (($# < 2)); then
        usage_error '--url requires a value'
      fi
      if [[ "$url_set" == true ]]; then
        duplicate_option '--url'
      fi
      url=$2
      url_set=true
      shift
      ;;
    --key)
      if (($# < 2)); then
        usage_error '--key requires a value'
      fi
      if [[ "$key_set" == true ]]; then
        duplicate_option '--key'
      fi
      key_path=$2
      key_set=true
      shift
      ;;
    --i-understand-this-prints-a-private-key)
      if [[ "$private_key_acknowledged" == true ]]; then
        duplicate_option '--i-understand-this-prints-a-private-key'
      fi
      private_key_acknowledged=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage_error "Unknown option: $1"
      ;;
  esac
  shift
done

case "$subcommand" in
  open)
    if [[ "$reason_set" != true || -z "$reason" ]]; then
      usage_error 'open requires --reason TEXT'
    fi
    if [[ "$actor_set" != true || -z "$actor" ]]; then
      usage_error 'open requires --actor NAME'
    fi
    if [[ "$key_set" == true || "$private_key_acknowledged" == true ]]; then
      usage_error 'open does not accept key options'
    fi
    ;;
  close)
    if [[ "$reason_set" != true || -z "$reason" ]]; then
      usage_error 'close requires --reason TEXT'
    fi
    if [[ "$actor_set" == true || "$key_set" == true ||
      "$private_key_acknowledged" == true ]]; then
      usage_error 'close accepts only --reason and --url'
    fi
    ;;
  status)
    if [[ "$reason_set" == true || "$actor_set" == true ||
      "$key_set" == true || "$private_key_acknowledged" == true ]]; then
      usage_error 'status accepts only --url'
    fi
    ;;
  public-key)
    if [[ "$key_set" != true || -z "$key_path" ]]; then
      usage_error 'public-key requires --key PATH'
    fi
    if [[ "$reason_set" == true || "$actor_set" == true ||
      "$url_set" == true || "$private_key_acknowledged" == true ]]; then
      usage_error 'public-key accepts only --key'
    fi
    ;;
  secret)
    if [[ "$key_set" != true || -z "$key_path" ]]; then
      usage_error 'secret requires --key PATH'
    fi
    if [[ "$private_key_acknowledged" != true ]]; then
      usage_error \
        'secret requires --i-understand-this-prints-a-private-key'
    fi
    if [[ "$reason_set" == true || "$actor_set" == true ||
      "$url_set" == true ]]; then
      usage_error 'secret accepts only --key and the acknowledgement flag'
    fi
    ;;
esac

require_commands() {
  local command_name
  for command_name in "$@"; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      printf '%s is required\n' "$command_name" >&2
      exit 2
    fi
  done
}

if [[ "$subcommand" == public-key || "$subcommand" == secret ]]; then
  require_commands awk base64 openssl tail tr wc
  export LC_ALL=C
  if [[ ! -f "$key_path" || ! -r "$key_path" ]]; then
    printf 'The key file is not a readable file: %s\n' "$key_path" >&2
    exit 2
  fi
  if ! openssl pkey -in "$key_path" -noout -text 2>/dev/null |
    awk '
      NR == 1 { valid = ($0 == "ED25519 Private-Key:") }
      END { exit valid ? 0 : 1 }
    '
  then
    printf 'The key file must contain an Ed25519 private key: %s\n' \
      "$key_path" >&2
    exit 2
  fi
fi

if [[ "$subcommand" == public-key ]]; then
  if ! public_key_base64=$(
    openssl pkey -in "$key_path" -pubout -outform DER 2>/dev/null |
      tail -c 32 | base64 -w0
  ); then
    printf '%s\n' 'The Ed25519 public key could not be derived' >&2
    exit 2
  fi
  public_key_length=$(
    printf '%s' "$public_key_base64" | base64 --decode | wc -c
  )
  if ((public_key_length != 32)); then
    printf '%s\n' 'The derived Ed25519 public key must contain 32 bytes' >&2
    exit 2
  fi
  public_key_base64url=${public_key_base64//+/-}
  public_key_base64url=${public_key_base64url//\//_}
  public_key_base64url=${public_key_base64url//=}
  printf '%s\n' "$public_key_base64url"
  exit 0
fi

if [[ "$subcommand" == secret ]]; then
  if ! private_key_base64=$(
    openssl pkey -in "$key_path" -outform DER 2>/dev/null | base64 -w0
  ); then
    printf '%s\n' 'The Ed25519 private key could not be encoded' >&2
    exit 2
  fi
  if [[ -z "$private_key_base64" ]]; then
    printf '%s\n' 'The encoded Ed25519 private key is empty' >&2
    exit 2
  fi
  private_key_base64url=${private_key_base64//+/-}
  private_key_base64url=${private_key_base64url//\//_}
  private_key_base64url=${private_key_base64url//=}
  printf '%s\n' "$private_key_base64url"
  exit 0
fi

require_commands curl date jq

selected_url=$url
if [[ "$url_set" != true ]]; then
  selected_url=${OUTAGE_GATE_URL:-}
fi
if [[ -z "$selected_url" ]]; then
  usage_error '--url URL or OUTAGE_GATE_URL is required'
fi
while [[ "$selected_url" == */ ]]; do
  selected_url=${selected_url%/}
done
if [[ -z "$selected_url" ]]; then
  usage_error 'The outage-gate URL must not contain only slashes'
fi

admin_token=${OUTAGE_GATE_ADMIN_TOKEN:-}
if [[ -z "$admin_token" ]]; then
  printf '%s\n' 'OUTAGE_GATE_ADMIN_TOKEN is required' >&2
  exit 2
fi
if ((${#admin_token} < 32)); then
  printf '%s\n' \
    'OUTAGE_GATE_ADMIN_TOKEN must contain at least 32 characters' >&2
  exit 2
fi

endpoint="$selected_url/$subcommand"
if [[ "$subcommand" == status ]]; then
  curl --fail-with-body --silent --show-error \
    --request GET \
    --header "Authorization: Bearer $admin_token" \
    --write-out '\n' \
    "$endpoint"
  exit 0
fi

if ! changed_at_ms=$(date -u +%s%3N); then
  printf '%s\n' 'The current UTC time could not be read' >&2
  exit 2
fi
if [[ ! "$changed_at_ms" =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'date -u +%s%3N did not return milliseconds' >&2
  exit 2
fi

if [[ "$subcommand" == open ]]; then
  if ! payload=$(
    jq -cn \
      --arg actor "$actor" \
      --argjson openedAtMs "$changed_at_ms" \
      --arg reason "$reason" \
      '{action: "open", openedAtMs: $openedAtMs,
        reason: $reason, actor: $actor}'
  ); then
    printf '%s\n' 'The open request could not be built' >&2
    exit 2
  fi
else
  if ! payload=$(
    jq -cn \
      --argjson closedAtMs "$changed_at_ms" \
      --arg reason "$reason" \
      '{action: "close", closedAtMs: $closedAtMs, reason: $reason}'
  ); then
    printf '%s\n' 'The close request could not be built' >&2
    exit 2
  fi
fi

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $admin_token" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  --write-out '\n' \
  "$endpoint"
