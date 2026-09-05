#!/usr/bin/env bash
set -euo pipefail

daemon_pid=

# shellcheck disable=SC2317,SC2329 # The signal and EXIT traps call this function.
stop_docker() {
  if [[ -n "$daemon_pid" ]]; then
    kill -TERM "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
}
trap stop_docker EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# /run is a fresh 64 MB tmpfs at runtime, so the build-time /run/user/1001
# directory is masked. Recreate XDG_RUNTIME_DIR before dockerd-rootless.sh
# checks that it exists and is writable.
install -d -m 0700 -o runner -g runner /run/user/1001

# Rootless Docker runs as uid 1001 but /dev/fuse and /dev/net/tun ship mode
# 0600 owned by root. Without /dev/net/tun, slirp4netns cannot create tap0;
# without /dev/fuse, fuse-overlayfs cannot mount. Hand both nodes to the
# runner user. The sandbox is a single-tenant firecracker microVM running as
# root with the full capability set, so this does not cross a tenant boundary.
for device_node in /dev/fuse /dev/net/tun; do
  if [[ ! -c "$device_node" ]]; then
    echo "CF_RUNNER_BOOT_FAILED reason=missing-device node=$device_node"
    exit 1
  fi
  chown runner:runner "$device_node"
done

runuser --user runner -- \
  env \
    DOCKER_HOST="$DOCKER_HOST" \
    HOME=/home/runner \
    LOGNAME=runner \
    USER=runner \
    XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  /usr/local/bin/dockerd-rootless.sh \
    --host="$DOCKER_HOST" \
    --storage-driver=fuse-overlayfs &
daemon_pid=$!

for _ in {1..150}; do
  if runuser --user runner -- \
    env DOCKER_HOST="$DOCKER_HOST" /usr/local/bin/docker version \
      >/dev/null 2>&1; then
    echo "Rootless Docker is ready"
    wait "$daemon_pid"
    exit $?
  fi

  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    status=0
    wait "$daemon_pid" || status=$?
    if [[ $status -eq 0 ]]; then
      status=1
    fi
    echo "CF_RUNNER_BOOT_FAILED reason=dockerd-exited-during-startup"
    exit "$status"
  fi
  sleep 0.2
done

echo "Rootless Docker did not become ready within 30 seconds" >&2
echo "CF_RUNNER_BOOT_FAILED reason=readiness-timeout"
exit 1
