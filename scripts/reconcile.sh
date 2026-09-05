#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${WORKER_URL:-}" ]]; then
  echo "WORKER_URL must be set" >&2
  exit 2
fi
if [[ -z "${CONTROL_TOKEN:-}" ]]; then
  echo "CONTROL_TOKEN must be set" >&2
  exit 2
fi
if (($# > 1)); then
  echo "Usage: scripts/reconcile.sh [max-age-seconds]" >&2
  exit 2
fi

body='{}'
if (($# == 1)); then
  if [[ ! "$1" =~ ^[0-9]+$ ]]; then
    echo "max-age-seconds must be a non-negative integer" >&2
    exit 2
  fi
  body=$(printf '{"maxAgeSeconds":%s}' "$1")
fi

worker_url=${WORKER_URL%/}
curl_status=0
# Reuse the cleanup callback's connection bound and the reconciliation window.
response=$(curl --fail-with-body --silent --show-error \
  --connect-timeout 10 \
  --max-time 3600 \
  --request POST \
  --header "Authorization: Bearer $CONTROL_TOKEN" \
  --header "Content-Type: application/json" \
  --data "$body" \
  "$worker_url/reconcile") || curl_status=$?

validation_status=0
printf '%s\n' "$response" | python3 -c '
import json
import sys

body = json.load(sys.stdin)
json.dump(body, sys.stdout, indent=4)
sys.stdout.write("\n")
errors = body.get("errors")
if errors is None:
    if "error" in body:
        message = body["error"]
        raise SystemExit(f"Reconciliation failed: {message}")
    raise SystemExit("The reconciliation response has no errors list")
if not isinstance(errors, list):
    raise SystemExit("The reconciliation response has an invalid errors value")
if errors:
    raise SystemExit(f"Reconciliation reported {len(errors)} cleanup error(s)")
changed = body.get("changedCandidates")
if not isinstance(changed, list):
    raise SystemExit("The reconciliation response has no changedCandidates list")
if changed:
    raise SystemExit(
        f"Reconciliation could not claim {len(changed)} cleanup candidate(s)"
    )
has_more = body.get("hasMoreCandidates")
if not isinstance(has_more, bool):
    raise SystemExit("The reconciliation response has no hasMoreCandidates value")
if has_more:
    raise SystemExit("Reconciliation requires another bounded cleanup request")
' || validation_status=$?

if ((curl_status != 0)); then
  exit "$curl_status"
fi
exit "$validation_status"
