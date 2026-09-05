#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage:' \
    '  scripts/sign-capacity-approval.sh --key PATH --approved-by NAME --capacity N' \
    '      (--effective-at MS | --effective-at-now) [--curl] [--worker-url URL]' \
    '  scripts/sign-capacity-approval.sh --key PATH --public-key' >&2
}

usage_error() {
  usage
  printf '%s\n' "$1" >&2
  exit 2
}

duplicate_option() {
  usage_error "Option can be used only once: $1"
}

key_path=''
approved_by=''
capacity=''
effective_at_ms=''
worker_url=''
key_set=false
approved_by_set=false
capacity_set=false
effective_at_set=false
effective_at_now=false
worker_url_set=false
public_key_mode=false
curl_output=false

while (($# > 0)); do
  case "$1" in
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
    --approved-by)
      if (($# < 2)); then
        usage_error '--approved-by requires a value'
      fi
      if [[ "$approved_by_set" == true ]]; then
        duplicate_option '--approved-by'
      fi
      approved_by=$2
      approved_by_set=true
      shift
      ;;
    --capacity)
      if (($# < 2)); then
        usage_error '--capacity requires a value'
      fi
      if [[ "$capacity_set" == true ]]; then
        duplicate_option '--capacity'
      fi
      capacity=$2
      capacity_set=true
      shift
      ;;
    --effective-at)
      if (($# < 2)); then
        usage_error '--effective-at requires a value'
      fi
      if [[ "$effective_at_set" == true ]]; then
        duplicate_option '--effective-at'
      fi
      effective_at_ms=$2
      effective_at_set=true
      shift
      ;;
    --effective-at-now)
      if [[ "$effective_at_now" == true ]]; then
        duplicate_option '--effective-at-now'
      fi
      effective_at_now=true
      ;;
    --worker-url)
      if (($# < 2)); then
        usage_error '--worker-url requires a value'
      fi
      if [[ "$worker_url_set" == true ]]; then
        duplicate_option '--worker-url'
      fi
      worker_url=$2
      worker_url_set=true
      shift
      ;;
    --public-key)
      if [[ "$public_key_mode" == true ]]; then
        duplicate_option '--public-key'
      fi
      public_key_mode=true
      ;;
    --curl)
      if [[ "$curl_output" == true ]]; then
        duplicate_option '--curl'
      fi
      curl_output=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$key_set" != true || -z "$key_path" ]]; then
  usage_error '--key PATH is required'
fi

if [[ "$public_key_mode" == true ]]; then
  if [[ "$approved_by_set" == true || "$capacity_set" == true ||
    "$effective_at_set" == true || "$effective_at_now" == true ||
    "$curl_output" == true || "$worker_url_set" == true ]]; then
    usage_error '--public-key cannot be combined with signing options'
  fi
else
  if [[ "$approved_by_set" != true || -z "$approved_by" ]]; then
    usage_error '--approved-by NAME is required for signing'
  fi
  if [[ "$capacity_set" != true ]]; then
    usage_error '--capacity N is required for signing'
  fi
  if [[ "$effective_at_set" == "$effective_at_now" ]]; then
    usage_error 'Use exactly one of --effective-at and --effective-at-now'
  fi
  if [[ "$worker_url_set" == true && "$curl_output" != true ]]; then
    usage_error '--worker-url requires --curl'
  fi
fi

required_commands=(awk base64 date dirname grep mktemp node openssl rm tail tr wc)
for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s is required\n' "$command_name" >&2
    exit 2
  fi
done

export LC_ALL=C

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository_dir=$(cd -- "$script_dir/.." && pwd)

selected_worker_url=''
if [[ "$public_key_mode" != true ]]; then
  if [[ ! "$capacity" =~ ^(0|[1-9][0-9]*)$ ]]; then
    printf '%s\n' \
      '--capacity must be 0 or a decimal integer without leading zeros' >&2
    exit 2
  fi

  max_active_runners_source="$repository_dir/src/autopilot-control.js"
  max_active_runners_pattern='^export const MAX_ACTIVE_RUNNERS = (0|[1-9][0-9]*);$'
  if ! max_active_runners_line=$(
    grep -E "$max_active_runners_pattern" "$max_active_runners_source" \
      2>/dev/null
  ); then
    printf '%s\n' \
      'Could not parse MAX_ACTIVE_RUNNERS from src/autopilot-control.js' >&2
    exit 2
  fi
  if [[ "$max_active_runners_line" == *$'\n'* ||
    ! "$max_active_runners_line" =~ $max_active_runners_pattern ]]; then
    printf '%s\n' \
      'Could not parse MAX_ACTIVE_RUNNERS from src/autopilot-control.js' >&2
    exit 2
  fi
  max_active_runners=${BASH_REMATCH[1]}

  if ! capacity_comparison=$(
    CAPACITY_VALUE="$capacity" MAX_ACTIVE_RUNNERS_VALUE="$max_active_runners" \
      node --input-type=module --eval '
        const capacity = BigInt(process.env.CAPACITY_VALUE);
        const maximum = BigInt(process.env.MAX_ACTIVE_RUNNERS_VALUE);
        process.stdout.write(capacity > maximum ? "greater" : "allowed");
      '
  ); then
    printf '%s\n' 'The capacity could not be compared with MAX_ACTIVE_RUNNERS' >&2
    exit 2
  fi
  if [[ "$capacity_comparison" == greater ]]; then
    printf 'The capacity cannot exceed MAX_ACTIVE_RUNNERS (%s)\n' \
      "$max_active_runners" >&2
    exit 2
  fi

  if [[ "$effective_at_set" == true ]]; then
    if [[ ! "$effective_at_ms" =~ ^(0|[1-9][0-9]*)$ ]]; then
      printf '%s\n' \
        '--effective-at must be 0 or a decimal integer without leading zeros' >&2
      exit 2
    fi
  else
    if ! effective_at_ms=$(date -u +%s%3N); then
      printf '%s\n' 'The current UTC time could not be read' >&2
      exit 2
    fi
    if [[ ! "$effective_at_ms" =~ ^[0-9]+$ ]]; then
      printf '%s\n' 'date -u +%s%3N did not return milliseconds' >&2
      exit 2
    fi
  fi

  if [[ "$curl_output" == true ]]; then
    if [[ "$worker_url_set" == true ]]; then
      selected_worker_url=$worker_url
    else
      selected_worker_url=${WORKER_URL:-}
    fi
    if [[ -z "$selected_worker_url" ]]; then
      printf '%s\n' \
        '--curl requires --worker-url URL or the WORKER_URL environment variable' >&2
      exit 2
    fi
    while [[ "$selected_worker_url" == */ ]]; do
      selected_worker_url=${selected_worker_url%/}
    done
    if [[ -z "$selected_worker_url" ]]; then
      printf '%s\n' 'The Worker URL must not contain only slashes' >&2
      exit 2
    fi
  fi
fi

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

umask 077
temporary_files=()
# shellcheck disable=SC2317,SC2329 # The EXIT trap calls this function.
cleanup_temp_files() {
  local temporary_file
  for temporary_file in "${temporary_files[@]}"; do
    rm -f -- "$temporary_file" || true
  done
}
trap cleanup_temp_files EXIT

if ! raw_public_key_file=$(mktemp); then
  printf '%s\n' 'A temporary public key file could not be created' >&2
  exit 2
fi
temporary_files+=("$raw_public_key_file")
if ! decoded_public_key_file=$(mktemp); then
  printf '%s\n' 'A temporary decoded public key file could not be created' >&2
  exit 2
fi
temporary_files+=("$decoded_public_key_file")
if ! canonical_file=$(mktemp); then
  printf '%s\n' 'A temporary canonical approval file could not be created' >&2
  exit 2
fi
temporary_files+=("$canonical_file")
if ! signature_file=$(mktemp); then
  printf '%s\n' 'A temporary signature file could not be created' >&2
  exit 2
fi
temporary_files+=("$signature_file")
if ! payload_file=$(mktemp); then
  printf '%s\n' 'A temporary request payload file could not be created' >&2
  exit 2
fi
temporary_files+=("$payload_file")

if ! openssl pkey -in "$key_path" -pubout -outform DER 2>/dev/null |
  tail -c 32 >"$raw_public_key_file"
then
  printf '%s\n' 'The Ed25519 public key could not be derived' >&2
  exit 2
fi
raw_public_key_length=$(wc -c <"$raw_public_key_file")
if ((raw_public_key_length != 32)); then
  printf '%s\n' 'The derived Ed25519 public key must contain 32 bytes' >&2
  exit 2
fi

if ! public_key_base64url=$(
  base64 -w0 "$raw_public_key_file" | tr '+/' '-_' | tr -d '='
); then
  printf '%s\n' 'The Ed25519 public key could not be base64url encoded' >&2
  exit 2
fi
public_key_base64=${public_key_base64url//-/+}
public_key_base64=${public_key_base64//_/\/}
case $((${#public_key_base64} % 4)) in
  0) ;;
  2) public_key_base64+='==' ;;
  3) public_key_base64+='=' ;;
  *)
    printf '%s\n' 'The base64url public key has an invalid length' >&2
    exit 2
    ;;
esac
if ! printf '%s' "$public_key_base64" |
  base64 --decode >"$decoded_public_key_file"
then
  printf '%s\n' 'The base64url public key could not be decoded' >&2
  exit 2
fi
decoded_public_key_length=$(wc -c <"$decoded_public_key_file")
if ((decoded_public_key_length != 32)); then
  printf '%s\n' 'The decoded Ed25519 public key must contain 32 bytes' >&2
  exit 2
fi

if [[ "$public_key_mode" == true ]]; then
  printf '%s\n' "$public_key_base64url"
  exit 0
fi

if ! NODE_APPROVED_BY="$approved_by" NODE_CAPACITY="$capacity" \
  NODE_EFFECTIVE_AT_MS="$effective_at_ms" \
  node --input-type=module --eval '
    const capacity = Number(process.env.NODE_CAPACITY);
    const effectiveAtMs = Number(process.env.NODE_EFFECTIVE_AT_MS);
    if (
      !Number.isSafeInteger(capacity) ||
      !Number.isSafeInteger(effectiveAtMs)
    ) {
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({
      approvedBy: process.env.NODE_APPROVED_BY,
      capacity,
      effectiveAtMs,
    }));
  ' >"$canonical_file"
then
  printf '%s\n' \
    'The capacity and effective time must be JavaScript safe integers' >&2
  exit 2
fi

if ! openssl pkeyutl -sign -rawin -inkey "$key_path" \
  -in "$canonical_file" -out "$signature_file" 2>/dev/null; then
  printf '%s\n' 'The capacity approval could not be signed' >&2
  exit 2
fi
signature_length=$(wc -c <"$signature_file")
if ((signature_length != 64)); then
  printf '%s\n' 'The Ed25519 signature must contain 64 bytes' >&2
  exit 2
fi
if ! signature=$(
  base64 -w0 "$signature_file" | tr '+/' '-_' | tr -d '='
); then
  printf '%s\n' 'The Ed25519 signature could not be base64url encoded' >&2
  exit 2
fi

if ! NODE_APPROVED_BY="$approved_by" NODE_CAPACITY="$capacity" \
  NODE_EFFECTIVE_AT_MS="$effective_at_ms" NODE_SIGNATURE="$signature" \
  node --input-type=module --eval '
    process.stdout.write(JSON.stringify({
      approvedBy: process.env.NODE_APPROVED_BY,
      capacity: Number(process.env.NODE_CAPACITY),
      effectiveAtMs: Number(process.env.NODE_EFFECTIVE_AT_MS),
      signature: process.env.NODE_SIGNATURE,
    }));
  ' >"$payload_file"
then
  printf '%s\n' 'The capacity approval payload could not be built' >&2
  exit 2
fi

canonical=$(<"$canonical_file")
payload=$(<"$payload_file")
printf 'Canonical approval: %s\n' "$canonical" >&2
printf 'Signature: %s\n' "$signature" >&2
printf 'Public key: %s\n' "$public_key_base64url" >&2

if [[ "$curl_output" != true ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

shell_single_quote() {
  local value=$1
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

endpoint="$selected_worker_url/autopilot/control/capacity"
printf 'curl -X POST -H "Authorization: Bearer %s" -H "Content-Type: application/json" -d %s %s\n' \
  "\$CONTROL_TOKEN" "$(shell_single_quote "$payload")" \
  "$(shell_single_quote "$endpoint")"
