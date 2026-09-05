# syntax=docker/dockerfile:1

FROM docker.io/cloudflare/sandbox:0.12.7@sha256:6d741713aef266e8ae0831a5709c6f2d7b77b4952ac79b549f4f4e380af86fbe

ARG RUNNER_VERSION=2.336.0
ARG RUNNER_SHA256=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d
ARG DOCKER_VERSION=29.7.2
ARG DOCKER_SHA256=803d433f226db4776e1768fd319fc6c6e4935a456acf84fcc0080818b854bc8f
ARG DOCKER_ROOTLESS_SHA256=15a5cb81f2c5cf15ea21427f2e8241eac0deb2221175f993b5e76926e705ec6a
ARG BUILDX_VERSION=0.36.1
ARG BUILDX_SHA256=48af8a397ebd60178778bf63611dbcebe5f5e7a9be90eb9147b24b9587455778

USER root

RUN set -eux; \
    apt-get update; \
    apt-get install --yes --no-install-recommends \
      dbus-user-session \
      fuse-overlayfs \
      iproute2 \
      iptables \
      slirp4netns \
      uidmap; \
    useradd --create-home --uid 1001 --user-group --shell /bin/bash runner; \
    sed -i '/^runner:/d' /etc/subuid /etc/subgid; \
    echo 'runner:100000:65536' >> /etc/subuid; \
    echo 'runner:100000:65536' >> /etc/subgid; \
    mkdir -p /opt/actions-runner /run/user/1001 /workspace/_work; \
    chmod 0700 /run/user/1001; \
    curl --fail --location --show-error \
      --proto '=https' --proto-redir '=https' \
      --output /tmp/docker.tgz \
      "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz"; \
    curl --fail --location --show-error \
      --proto '=https' --proto-redir '=https' \
      --output /tmp/docker-rootless.tgz \
      "https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-${DOCKER_VERSION}.tgz"; \
    echo "${DOCKER_SHA256}  /tmp/docker.tgz" | sha256sum --check --strict; \
    echo "${DOCKER_ROOTLESS_SHA256}  /tmp/docker-rootless.tgz" | sha256sum --check --strict; \
    tar --extract --gzip --file /tmp/docker.tgz --strip-components 1 --directory /usr/local/bin; \
    tar --extract --gzip --file /tmp/docker-rootless.tgz --strip-components 1 --directory /usr/local/bin; \
    mkdir -p /usr/local/libexec/docker/cli-plugins; \
    curl --fail --location --show-error \
      --proto '=https' --proto-redir '=https' \
      --output /usr/local/libexec/docker/cli-plugins/docker-buildx \
      "https://github.com/docker/buildx/releases/download/v${BUILDX_VERSION}/buildx-v${BUILDX_VERSION}.linux-amd64"; \
    echo "${BUILDX_SHA256}  /usr/local/libexec/docker/cli-plugins/docker-buildx" | sha256sum --check --strict; \
    chmod 0755 /usr/local/libexec/docker/cli-plugins/docker-buildx; \
    /usr/local/bin/docker buildx version; \
    curl --fail --location --show-error \
      --proto '=https' --proto-redir '=https' \
      --output /tmp/actions-runner.tar.gz \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"; \
    echo "${RUNNER_SHA256}  /tmp/actions-runner.tar.gz" | sha256sum --check --strict; \
    tar --extract --gzip --file /tmp/actions-runner.tar.gz --directory /opt/actions-runner; \
    /opt/actions-runner/bin/installdependencies.sh; \
    rm -f /tmp/actions-runner.tar.gz /tmp/docker.tgz /tmp/docker-rootless.tgz; \
    rm -rf /var/lib/apt/lists/*; \
    chown -R runner:runner /home/runner /opt/actions-runner /run/user/1001 /workspace/_work

COPY --chmod=0755 boot-docker.sh /usr/local/bin/boot-docker
COPY --chmod=0755 run-actions-runner.sh /usr/local/bin/run-actions-runner

ENV DOCKER_HOST=unix:///run/user/1001/docker.sock \
    XDG_RUNTIME_DIR=/run/user/1001

# Keep the Sandbox entrypoint. It starts this command as a managed child.
CMD ["/usr/local/bin/boot-docker"]

ARG PGDG_SIGNING_SHA256=0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76
ARG REDIS_SIGNING_SHA256=817b5a78358d00ed6b71884d70ad5d2eab9934badca1a34299fdc6a2e4a8ad20
ARG DEBIAN_FRONTEND=noninteractive

# The base image is Ubuntu 22.04, so both external repositories use jammy.
# Prefer the newest Redis 7 package without pinning an exact removable version.
RUN set -eux; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl --fail --location --show-error \
      --proto '=https' --proto-redir '=https' \
      --output /tmp/pgdg.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    echo "${PGDG_SIGNING_SHA256}  /tmp/pgdg.asc" | sha256sum --check --strict; \
    install -m 0644 /tmp/pgdg.asc /etc/apt/keyrings/pgdg.asc; \
    curl --fail --location --show-error \
      --proto '=https' --proto-redir '=https' \
      --output /tmp/redis.asc \
      https://packages.redis.io/gpg; \
    echo "${REDIS_SIGNING_SHA256}  /tmp/redis.asc" | sha256sum --check --strict; \
    install -m 0644 /tmp/redis.asc /etc/apt/keyrings/redis.asc; \
    printf '%s\n' \
      'deb [signed-by=/etc/apt/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main' \
      > /etc/apt/sources.list.d/pgdg.list; \
    printf '%s\n' \
      'deb [signed-by=/etc/apt/keyrings/redis.asc] https://packages.redis.io/deb jammy main' \
      > /etc/apt/sources.list.d/redis.list; \
    printf '%s\n' \
      'Package: redis-server redis-tools' \
      'Pin: origin packages.redis.io' \
      'Pin-Priority: 1001' \
      > /etc/apt/preferences.d/redis; \
    apt-get update; \
    redis_server_version="$( \
      apt-cache madison redis-server \
        | awk -F '|' '{ \
            version = $2; \
            repository = $3; \
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", version); \
            if (version ~ /(^|:)7\./ \
                && repository ~ /packages\.redis\.io/) { \
              print version; \
              exit; \
            } \
          }' \
    )"; \
    redis_tools_version="$( \
      apt-cache madison redis-tools \
        | awk -F '|' '{ \
            version = $2; \
            repository = $3; \
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", version); \
            if (version ~ /(^|:)7\./ \
                && repository ~ /packages\.redis\.io/) { \
              print version; \
              exit; \
            } \
          }' \
    )"; \
    test -n "$redis_server_version"; \
    test -n "$redis_tools_version"; \
    apt-get install --yes --no-install-recommends \
      postgresql-18 \
      postgresql-client-18 \
      postgresql-18-pgvector \
      "redis-server=$redis_server_version" \
      "redis-tools=$redis_tools_version"; \
    rm -f /etc/apt/preferences.d/redis; \
    test "$(redis-server --version | sed -n 's/.* v=\([0-9]*\).*/\1/p')" = 7; \
    dpkg-query --show --showformat='${binary:Package}\t${Version}\n' \
      postgresql-18 \
      postgresql-client-18 \
      postgresql-18-pgvector \
      redis-server \
      redis-tools; \
    rm -f /tmp/pgdg.asc /tmp/redis.asc; \
    rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_VERSION=1.58.0

# Install all Playwright browsers and their jammy system dependencies once.
# Keep the exact library in a shared path so jobs launch without egress.
# The browser path remains writable by jobs that need another revision.
# Both shared paths remain readable by the unprivileged runner user.
RUN set -eux; \
    mkdir -p /ms-playwright /opt/playwright; \
    npm install --prefix /opt/playwright \
      --ignore-scripts --no-audit --no-fund --no-save \
      playwright@1.58.0; \
    cd /opt/playwright; \
    npx --yes playwright@1.58.0 install --with-deps; \
    chown -R runner:runner /ms-playwright; \
    chmod -R a+rX /ms-playwright /opt/playwright; \
    rm -rf /var/lib/apt/lists/*

ARG ACTIONS_CHECKOUT_V4_SHA=11bd71901bbe5b1630ceea73d27597364c9af683
ARG ACTIONS_CHECKOUT_V7_SHA=9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
ARG ACTIONS_SETUP_NODE_SHA=49933ea5288caeca8642d1e84afbd3f7d6820020
ARG ACTIONS_SETUP_PYTHON_SHA=a26af69be951a213d495a4c3e4e4022e16d87065
ARG ACTIONS_CACHE_SHA=5a3ec84eff668545956fd18022155c47e93e2684
ARG ACTIONS_UPLOAD_ARTIFACT_SHA=ea165f8d65b6e75b540449e92b4886f43607fa02
ARG ACTIONS_DOWNLOAD_ARTIFACT_SHA=d3f86a106a0bac45b974a628896c90dbdf5c8093
ARG ASTRAL_SETUP_UV_SHA=d0cc045d04ccac9d8b7881df0226f9e82c39688e
ARG DOCKER_SETUP_BUILDX_SHA=8d2750c68a42422c14e847fe6c8ac0403b4cbd6f

ENV ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=/opt/actions-cache \
    RUNNER_IMAGE_TOOLCHAIN_CONTRACT=1

# A full commit SHA identifies the repository content and pins each action.
# GitHub tarball gzip bytes are unstable, so they cannot use a stable SHA-256.
# This validation proves archive structure and commit naming, not content integrity.
RUN <<'SHELL'
set -eux

validate_action_archive() {
  archive=$1
  expected_top=$2
  perl -MArchive::Tar - "$archive" "$expected_top" <<'PERL'
use strict;
use warnings;

my ($archive, $expected_top) = @ARGV;
my $tar = Archive::Tar->new();
$tar->read($archive, 1) or die "cannot read $archive\n";
my @members = $tar->get_files();
@members or die "archive is empty: $archive\n";

my $root_directory_seen = 0;
for my $member (@members) {
  my $name = $member->full_path();
  $name !~ m{\A/} or die "absolute archive path: $name\n";

  my $normalized_name = $name;
  $normalized_name =~ s{/+\z}{};
  length($normalized_name) or die "empty archive path\n";
  my @parts = split m{/}, $normalized_name, -1;
  !grep({ $_ eq '..' } @parts) or die "parent path component: $name\n";
  $parts[0] eq $expected_top
    or die "unexpected top-level directory: $name\n";

  ($member->is_file() || $member->is_dir() || $member->is_symlink())
    or die "unsupported archive entry type: $name\n";

  if ($normalized_name eq $expected_top) {
    $member->is_dir() or die "top-level entry is not a directory: $name\n";
    $root_directory_seen = 1;
  }

  next unless $member->is_symlink();
  my $target = $member->linkname();
  defined($target) && length($target)
    or die "empty symlink target: $name\n";
  $target !~ m{\A/} or die "absolute symlink target: $name -> $target\n";

  my @resolved = @parts;
  pop @resolved;
  for my $target_part (split m{/}, $target, -1) {
    next if $target_part eq '' || $target_part eq '.';
    if ($target_part eq '..') {
      @resolved > 1
        or die "symlink escapes top-level directory: $name -> $target\n";
      pop @resolved;
      next;
    }
    push @resolved, $target_part;
  }
  @resolved && $resolved[0] eq $expected_top
    or die "symlink escapes top-level directory: $name -> $target\n";
}

$root_directory_seen
  or die "missing top-level directory entry: $expected_top/\n";
PERL
}

fetch_action() {
  action_owner=$1
  action_repo=$2
  action_sha=$3
  action_dir="/opt/actions-cache/${action_owner}_${action_repo}"
  action_archive="${action_dir}/${action_sha}.tar.gz"
  expected_top="${action_repo}-${action_sha}"
  mkdir -p "$action_dir"
  curl --retry 5 --retry-all-errors \
    --connect-timeout 10 --max-time 120 --fail \
    --location --show-error \
    --proto '=https' --proto-redir '=https' \
    --output "$action_archive" \
    "https://codeload.github.com/${action_owner}/${action_repo}/tar.gz/${action_sha}"
  validate_action_archive "$action_archive" "$expected_top"
}

fetch_action actions checkout "$ACTIONS_CHECKOUT_V4_SHA"
fetch_action actions checkout "$ACTIONS_CHECKOUT_V7_SHA"
fetch_action actions setup-node "$ACTIONS_SETUP_NODE_SHA"
fetch_action actions setup-python "$ACTIONS_SETUP_PYTHON_SHA"
fetch_action actions cache "$ACTIONS_CACHE_SHA"
fetch_action actions upload-artifact "$ACTIONS_UPLOAD_ARTIFACT_SHA"
fetch_action actions download-artifact "$ACTIONS_DOWNLOAD_ARTIFACT_SHA"
fetch_action astral-sh setup-uv "$ASTRAL_SETUP_UV_SHA"
fetch_action docker setup-buildx-action "$DOCKER_SETUP_BUILDX_SHA"
chmod -R a+rX /opt/actions-cache
SHELL

COPY --chmod=0755 svc/ci-pg-start svc/ci-redis-start /usr/local/bin/

ARG DOCKER_COMPOSE_VERSION=5.5.0
ARG DOCKER_COMPOSE_SHA256=c57ab918abd5b05ca7e7d0f275875dd1330a695074f309dc9eab1b49efafcd4b

RUN <<'SHELL'
set -eux

apt-get update
apt-get install --yes --no-install-recommends \
  binutils \
  gcc \
  libc6-dev \
  python3
dpkg-query --show --showformat='${binary:Package}\t${Version}\n' \
  binutils \
  gcc \
  libc6-dev \
  python3
cc --version
gcc --version
ld --version
python3 --version
curl --fail --location --show-error \
  --proto '=https' --proto-redir '=https' \
  --output /usr/local/libexec/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64"
echo "${DOCKER_COMPOSE_SHA256}  /usr/local/libexec/docker/cli-plugins/docker-compose" | sha256sum --check --strict
chmod 0755 /usr/local/libexec/docker/cli-plugins/docker-compose
/usr/local/bin/docker compose version
cat > /tmp/toolchain-smoke.c <<'C_SOURCE'
#include <stdio.h>

int main(void)
{
    puts("toolchain-ok");
    return 0;
}
C_SOURCE
cc -std=c17 -Wall -Wextra -Werror -O2 -fPIE -pie \
  -Wl,-z,relro,-z,now,-z,noexecstack \
  -o /tmp/toolchain-smoke /tmp/toolchain-smoke.c
test "$(/tmp/toolchain-smoke)" = 'toolchain-ok'
rm -f /tmp/toolchain-smoke /tmp/toolchain-smoke.c
rm -rf /var/lib/apt/lists/*
SHELL

RUN set -eux; \
    action_archive_count="$( \
      find /opt/actions-cache -type f -name '*.tar.gz' -print | wc -l \
    )"; \
    test "$action_archive_count" -eq 9; \
    manifest=/tmp/runner-image-manifest.txt; \
    { \
      printf 'toolchain_contract=1\n'; \
      printf 'postgresql_version=%s\n' \
        "$(dpkg-query --show --showformat='${Version}' postgresql-18)"; \
      printf 'postgresql_client_version=%s\n' \
        "$(dpkg-query --show --showformat='${Version}' postgresql-client-18)"; \
      printf 'pgvector_version=%s\n' \
        "$(dpkg-query --show --showformat='${Version}' postgresql-18-pgvector)"; \
      printf 'redis_server_version=%s\n' \
        "$(dpkg-query --show --showformat='${Version}' redis-server)"; \
      printf 'redis_tools_version=%s\n' \
        "$(dpkg-query --show --showformat='${Version}' redis-tools)"; \
      printf 'gcc_version=%s\n' \
        "$(dpkg-query --show --showformat='${Version}' gcc)"; \
      printf 'binutils_version=%s\n' \
        "$(dpkg-query --show --showformat='${Version}' binutils)"; \
      printf 'libc6_dev_version=%s\n' \
        "$(dpkg-query --show --showformat='${Version}' libc6-dev)"; \
      printf 'python3_version=%s\n' \
        "$(dpkg-query --show --showformat='${Version}' python3)"; \
      printf 'docker_compose_version=%s\n' "$DOCKER_COMPOSE_VERSION"; \
      printf 'playwright_version=%s\n' "$PLAYWRIGHT_VERSION"; \
      printf 'warmed_action_archive_count=%s\n' "$action_archive_count"; \
    } > "$manifest"; \
    grep --fixed-strings --line-regexp 'toolchain_contract=1' "$manifest"; \
    install -o root -g root -m 0644 \
      "$manifest" /opt/runner-image-manifest.txt; \
    rm -f "$manifest"
