#!/usr/bin/env bash
# Credentials must stay private when a caller enables xtrace.
set +x
set -euo pipefail

# The base image sets this build-only value. Do not pass it to job steps.
unset DEBIAN_FRONTEND

cleanup_url=$RUNNER_CLEANUP_URL
cleanup_token=$RUNNER_CLEANUP_TOKEN
# shellcheck disable=SC2153 # The Worker supplies RUNNER_NAME.
runner_name=$RUNNER_NAME
unset RUNNER_CLEANUP_TOKEN RUNNER_CLEANUP_URL
runner_pid=
termination_status=

# shellcheck disable=SC2317,SC2329 # The EXIT trap calls this function.
cleanup() {
  status=$?
  trap - EXIT

  cleanup_callback_status=0
  curl --fail --silent --show-error \
    --connect-timeout 10 \
    --max-time 60 \
    --output /dev/null \
    --retry 5 \
    --retry-all-errors \
    --request DELETE \
    --header "Authorization: Bearer $cleanup_token" \
    "$cleanup_url" || cleanup_callback_status=$?

  if ((cleanup_callback_status != 0)); then
    printf 'CF_RUNNER_CLEANUP_FAILED runnerName=%s curlExitStatus=%d\n' \
      "$runner_name" "$cleanup_callback_status" >&2
  fi

  printf 'CF_RUNNER_SUMMARY {"runnerName":"%s","runnerProcess":"exited","cleanupCallbackExitStatus":%d}\n' \
    "$runner_name" "$cleanup_callback_status"

  exit "$status"
}
trap cleanup EXIT

# shellcheck disable=SC2317,SC2329 # The signal traps call this function.
forward_signal() {
  local signal_name=$1
  local signal_status=$2

  termination_status=$signal_status
  if [[ -z "$runner_pid" ]]; then
    exit "$termination_status"
  fi
  kill -s "$signal_name" -- "-$runner_pid" 2>/dev/null || true
}
trap 'forward_signal INT 130' INT
trap 'forward_signal TERM 143' TERM

for _ in {1..150}; do
  if runuser --user runner --preserve-environment -- \
    /usr/local/bin/docker version >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! runuser --user runner --preserve-environment -- \
  /usr/local/bin/docker version >/dev/null 2>&1; then
  echo "Rootless Docker is unavailable" >&2
  exit 1
fi

# The job container uid and gid both map to host IDs 100000 or greater in the
# runner's subordinate range, so neither matches a runner-side owner or group.
# Docker takes the gid for a numeric --user from the image's passwd entry, so
# --user <uid> does not generally use gid 0. The workspace tree must therefore
# be writable by any ID. This single-job ephemeral runner container has only
# root, runner, and that job's mapped container IDs, so this grants the job
# nothing that it does not already own.
chmod 0777 /workspace/_work

# shellcheck disable=SC2016 # The runner shell expands these variables.
setsid runuser --user runner --preserve-environment -- /bin/bash -c '
  set +x
  set -euo pipefail
  umask 0000
  cd /opt/actions-runner
  if [[ -n "${RUNNER_JITCONFIG:-}" ]]; then
    exec ./run.sh --jitconfig "$RUNNER_JITCONFIG"
  fi
  ./config.sh --unattended --ephemeral --disableupdate --no-default-labels \
    --url "$RUNNER_URL" --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" \
    --work /workspace/_work
  unset RUNNER_TOKEN
  exec ./run.sh
' &
runner_pid=$!
unset RUNNER_JITCONFIG

runner_status=0
while true; do
  if wait "$runner_pid"; then
    runner_status=0
    break
  else
    runner_status=$?
  fi
  if [[ -z "$termination_status" ]] || ! kill -0 "$runner_pid" 2>/dev/null; then
    break
  fi
done
runner_pid=

if [[ -n "$termination_status" ]]; then
  exit "$termination_status"
fi
exit "$runner_status"
