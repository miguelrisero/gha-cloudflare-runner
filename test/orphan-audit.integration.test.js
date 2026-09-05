import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditNowEpoch as nowEpoch,
  cloudflareCreatedAt,
  cloudflareInstance,
  githubRunner,
  registryCreatedAt,
  registryRow,
  repositoryRoot,
  runnerUuid,
} from "./orphan-audit-harness.js";

const auditScript = join(repositoryRoot, "scripts/orphan-audit.sh");
const applicationId = "11111111-1111-4111-8111-111111111111";
const registryPageSize = 100;

function findExecutable(name) {
  for (const directory of process.env.PATH.split(":")) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the current PATH.
    }
  }
  throw new Error(`${name} is required for the integration test`);
}

const realJqPath = findExecutable("jq");

function instancePage(instances, {
  nextPageToken = null,
  perPage = 25,
  reportPageSize = true,
} = {}) {
  return {
    instances,
    result_info: {
      ...(reportPageSize ? { per_page: perPage } : {}),
      next_page_token: nextPageToken,
    },
  };
}

function registryPage(runners, nextCursor = null, pageSize) {
  return {
    runners,
    ...(pageSize === undefined ? {} : { pageSize }),
    nextCursor,
  };
}

function fullRegistryRows(uuid, prefix) {
  return [
    registryRow({ uuid }),
    ...Array.from(
      { length: registryPageSize - 1 },
      (_, index) => registryRow({
        sandbox: `runner-${prefix}-${index}`,
        state: "destroyed",
      }),
    ),
  ];
}

function githubResponse(runners, totalCount = runners.length) {
  return { total_count: totalCount, runners };
}

function githubCall(
  uuid,
  response = githubResponse([]),
  exitCode = null,
  name = `cloudflare-${uuid}`,
) {
  return {
    name,
    response,
    ...(exitCode === null ? {} : { exitCode }),
  };
}

function comparableJson(value) {
  if (value === undefined || value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(comparableJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${comparableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function quarantinedSandboxIds(instancePages) {
  const instancesById = new Map();
  const knownStates = new Set([
    "inactive",
    "unknown",
    "stopped",
    "failed",
    "unhealthy",
    "stopping",
    "provisioning",
    "running",
  ]);
  for (const instance of Object.values(instancePages)
    .flatMap((page) => page.instances)) {
    const group = instancesById.get(instance?.id) ?? [];
    group.push(instance);
    instancesById.set(instance?.id, group);
  }

  const quarantined = new Set();
  for (const instances of instancesById.values()) {
    if (instances.length === 1) {
      continue;
    }
    const fields = new Set(instances.flatMap((instance) =>
      Object.keys(instance ?? {})));
    fields.delete("created");
    fields.delete("name");
    fields.delete("state");
    const placementConflict = [...fields].some((field) =>
      new Set(instances.map((instance) =>
        comparableJson(instance?.[field] ?? null))).size > 1);
    const states = [...new Set(instances.map((instance) => instance?.state))];
    const stateSpellings = new Map();
    for (const state of states) {
      if (typeof state !== "string") {
        continue;
      }
      const spellings = stateSpellings.get(state.toLowerCase()) ?? new Set();
      spellings.add(state);
      stateSpellings.set(state.toLowerCase(), spellings);
    }
    const stateCaseConflict = [...stateSpellings.values()]
      .some((spellings) => spellings.size > 1);
    const unrankedState = instances.some((instance) =>
      typeof instance?.state === "string" &&
      !knownStates.has(instance.state.toLowerCase()));
    if (placementConflict || stateCaseConflict || unrankedState) {
      for (const instance of instances) {
        if (typeof instance?.name === "string") {
          quarantined.add(instance.name);
        }
      }
    }
  }
  return quarantined;
}

function auditGithubCandidates(instancePages, registryPages) {
  const quarantined = quarantinedSandboxIds(instancePages);
  const uuids = new Set(
    Object.values(instancePages)
      .flatMap((page) => page.instances)
      .filter((instance) =>
        typeof instance?.name === "string" &&
        typeof instance?.state === "string" &&
        !quarantined.has(instance.name) &&
        instance.state.toLowerCase() !== "inactive" &&
        instance.name.startsWith("runner-"))
      .map((instance) => instance.name.slice("runner-".length)),
  );
  const registryBySandbox = new Map();
  for (const row of Object.values(registryPages)
    .flatMap((page) => typeof page === "string" ? [] : page.runners)) {
    const existing = registryBySandbox.get(row?.sandboxId);
    if (
      existing === undefined ||
      (Number.isInteger(row?.revision) && row.revision > existing.revision)
    ) {
      registryBySandbox.set(row?.sandboxId, row);
    }
  }
  for (const row of registryBySandbox.values()) {
    if (
      ["starting", "online", "destroying"].includes(row?.state) &&
      typeof row?.sandboxId === "string" &&
      !quarantined.has(row.sandboxId) &&
      row.sandboxId.startsWith("runner-")
    ) {
      uuids.add(row.sandboxId.slice("runner-".length));
    }
  }
  return [...uuids]
    .sort()
    .map((uuid) => {
      const row = registryBySandbox.get(`runner-${uuid}`);
      const name = typeof row?.githubRunnerName === "string" &&
        row.githubRunnerName.length > 0
        ? row.githubRunnerName
        : `cloudflare-${uuid}`;
      return { uuid, name };
    });
}

function writeExecutable(directory, name, source) {
  const path = join(directory, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function writePages(directory, pages) {
  mkdirSync(directory);
  for (const [token, page] of Object.entries(pages)) {
    writeFileSync(
      join(directory, `${token}.json`),
      typeof page === "string" ? page : JSON.stringify(page),
    );
  }
}

function writeGithubCalls(path, calls) {
  writeFileSync(path, JSON.stringify(calls));
}

function installStubs(stubDirectory) {
  writeExecutable(stubDirectory, "node", `#!/usr/bin/env bash
set -euo pipefail
if (($# != 3)) || [[ "$1" != --input-type=module || "$2" != --eval ]]; then
  echo "unexpected node arguments: $*" >&2
  exit 64
fi
if [[ "$3" == *createHmac* ]]; then
  if [[ "\${STUB_NODE_TOKEN_FAILURE:-false}" == true ]]; then
    echo "stub node token failure" >&2
    exit 9
  fi
  printf '%s' 'stub-cleanup-token'
elif [[ "$3" == *unstable_readConfig* ]]; then
  if [[ -n "\${STUB_CONFIGURED_RUNNER_SCOPE+x}" ]]; then
    "$REAL_JQ_PATH" -cn --arg runnerScope "$STUB_CONFIGURED_RUNNER_SCOPE" '
      {
        containerNames: ["test-container"],
        configuredRepository: "owner/repository",
        configuredRunnerScope: $runnerScope
      }
    '
  else
    printf '%s' '{"containerNames":["test-container"],"configuredRepository":"owner/repository","configuredRunnerScope":null}'
  fi
else
  echo "unexpected node eval source" >&2
  exit 64
fi
`);

  writeExecutable(stubDirectory, "npx", `#!/usr/bin/env bash
set -euo pipefail
if (($# < 4)) || [[ "$1" != wrangler || "$2" != containers ||
  "$3" != instances || "$4" != "$STUB_APPLICATION_ID" ]]; then
  echo "unexpected npx arguments: $*" >&2
  exit 64
fi
shift 4
config=
json=false
page_size=
page_token=
while (($# > 0)); do
  case "$1" in
    --config)
      if (($# < 2)) || [[ -n "$config" ]]; then
        echo "invalid npx --config arguments" >&2
        exit 64
      fi
      config=$2
      shift 2
      ;;
    --json)
      if [[ "$json" == true ]]; then
        echo "duplicate npx --json argument" >&2
        exit 64
      fi
      json=true
      shift
      ;;
    --per-page)
      if (($# < 2)) || [[ -n "$page_size" ]]; then
        echo "invalid npx --per-page arguments" >&2
        exit 64
      fi
      page_size=$2
      shift 2
      ;;
    --page-token)
      if (($# < 2)) || [[ -n "$page_token" || -z "$2" ]]; then
        echo "invalid npx --page-token arguments" >&2
        exit 64
      fi
      page_token=$2
      shift 2
      ;;
    *)
      echo "unexpected npx option: $1" >&2
      exit 64
      ;;
  esac
done
if [[ "$config" != "$STUB_WRANGLER_CONFIG" || "$json" != true ||
  ! "$page_size" =~ ^([1-9]|1[0-9]|2[0-5])$ ]]; then
  echo "missing or invalid npx options" >&2
  exit 64
fi
printf 'npx per-page=%s page-token=%s\n' \
  "$page_size" "$page_token" >>"$STUB_COMMAND_LOG"
page=initial
if [[ -n "$page_token" ]]; then
  page=$page_token
fi
if [[ "$page_size" != 25 ]]; then
  page="$page@$page_size"
fi
page_file="$STUB_INSTANCE_PAGE_DIR/$page.json"
if [[ ! -f "$page_file" ]]; then
  printf 'missing npx instance page fixture for token "%s" at %s row(s) per page: %s\n' \
    "$page_token" "$page_size" "$page_file" >&2
  exit 64
fi
cat "$page_file"
`);

  writeExecutable(stubDirectory, "gh", `#!/usr/bin/env bash
set -euo pipefail
if (($# < 1)) || [[ "$1" != api ]]; then
  echo "unexpected gh arguments: $*" >&2
  exit 64
fi
shift
endpoint=
method=
query_name=
while (($# > 0)); do
  case "$1" in
    --method)
      if (($# < 2)) || [[ -n "$method" ]]; then
        echo "invalid gh --method arguments" >&2
        exit 64
      fi
      method=$2
      shift 2
      ;;
    --raw-field)
      if (($# < 2)) || [[ -n "$query_name" || "$2" != name=* ]]; then
        echo "invalid gh --raw-field arguments" >&2
        exit 64
      fi
      query_name=\${2#name=}
      shift 2
      ;;
    *)
      if [[ -n "$endpoint" ]]; then
        echo "unexpected gh option: $1" >&2
        exit 64
      fi
      endpoint=$1
      shift
      ;;
  esac
done
if [[ "$endpoint" != "$STUB_GITHUB_ENDPOINT" || "$method" != GET ]]; then
  echo "missing or invalid gh endpoint options" >&2
  exit 64
fi
if [[ -z "$query_name" ]]; then
  printf 'gh-probe %s\n' "$endpoint" >>"$STUB_COMMAND_LOG"
  if [[ -n "$STUB_GITHUB_PROBE_STDERR" ]]; then
    printf '%s\n' "$STUB_GITHUB_PROBE_STDERR" >&2
  fi
  if ((STUB_GITHUB_PROBE_EXIT != 0)); then
    exit "$STUB_GITHUB_PROBE_EXIT"
  fi
  printf '%s\n' "$STUB_GITHUB_PROBE_RESPONSE"
  exit 0
fi
call_index=$(<"$STUB_GITHUB_CALL_COUNT")
call_count=$("$REAL_JQ_PATH" -r 'length' "$STUB_GITHUB_CALLS")
if ((call_index >= call_count)); then
  echo "unexpected extra GitHub query for $query_name" >&2
  exit 64
fi
expected_name=$("$REAL_JQ_PATH" -er --argjson index "$call_index" \
  '.[$index].name | select(type == "string")' "$STUB_GITHUB_CALLS")
if [[ "$query_name" != "$expected_name" ]]; then
  echo "expected GitHub query for $expected_name, got $query_name" >&2
  exit 64
fi
printf 'gh-query %s\n' "$query_name" >>"$STUB_COMMAND_LOG"
printf '%d\n' "$((call_index + 1))" >"$STUB_GITHUB_CALL_COUNT"
exit_code=$("$REAL_JQ_PATH" -r --argjson index "$call_index" \
  '.[$index].exitCode // empty' "$STUB_GITHUB_CALLS")
if [[ -n "$exit_code" ]]; then
  exit "$exit_code"
fi
"$REAL_JQ_PATH" -c --argjson index "$call_index" \
  '.[$index].response' "$STUB_GITHUB_CALLS"
`);

  writeExecutable(stubDirectory, "date", `#!/usr/bin/env bash
set -euo pipefail
if (($# != 2)) || [[ "$1" != -u || "$2" != +%s ]]; then
  echo "unexpected date arguments: $*" >&2
  exit 64
fi
if [[ -n "\${STUB_DATE_EXIT:-}" ]]; then
  exit "$STUB_DATE_EXIT"
fi
call_index=$(<"$STUB_DATE_CALL_COUNT")
printf '%d\n' "$((call_index + 1))" >"$STUB_DATE_CALL_COUNT"
case "$call_index" in
  0) printf '%s\n' "$STUB_AUDIT_START_EPOCH" ;;
  1) printf '%s\n' "$STUB_NOW_EPOCH" ;;
  *)
    echo "unexpected extra date call" >&2
    exit 64
    ;;
esac
`);

  writeExecutable(stubDirectory, "curl", `#!/usr/bin/env bash
set -euo pipefail
fail_with_body=false
silent=false
show_error=false
retry_all_errors=false
get_request=false
connect_timeout=
max_time=
retry_count=
retry_delay=
request_method=
authorization_header=
content_type_header=
write_out=
data_urlencode=
request_body=
url=
while (($# > 0)); do
  case "$1" in
    --fail-with-body)
      fail_with_body=true
      shift
      ;;
    --silent)
      silent=true
      shift
      ;;
    --show-error)
      show_error=true
      shift
      ;;
    --retry-all-errors)
      retry_all_errors=true
      shift
      ;;
    --get)
      get_request=true
      shift
      ;;
    --connect-timeout|--max-time|--retry|--retry-delay|--request|--write-out|--data-urlencode)
      if (($# < 2)); then
        echo "missing curl option value: $1" >&2
        exit 64
      fi
      option=$1
      value=$2
      case "$option" in
        --connect-timeout) connect_timeout=$value ;;
        --max-time) max_time=$value ;;
        --retry) retry_count=$value ;;
        --retry-delay) retry_delay=$value ;;
        --request) request_method=$value ;;
        --write-out) write_out=$value ;;
        --data-urlencode) data_urlencode=$value ;;
      esac
      shift 2
      ;;
    --header)
      if (($# < 2)); then
        echo "missing curl header value" >&2
        exit 64
      fi
      case "$2" in
        Authorization:*)
          if [[ -n "$authorization_header" ]]; then
            echo "duplicate authorization header" >&2
            exit 64
          fi
          authorization_header=$2
          ;;
        'Content-Type: application/json')
          if [[ -n "$content_type_header" ]]; then
            echo "duplicate content type header" >&2
            exit 64
          fi
          content_type_header=$2
          ;;
        *)
          echo "unexpected curl header: $2" >&2
          exit 64
          ;;
      esac
      shift 2
      ;;
    --data)
      if (($# < 2)) || [[ -n "$request_body" ]]; then
        echo "invalid curl request body" >&2
        exit 64
      fi
      request_body=$2
      shift 2
      ;;
    https://*)
      if [[ -n "$url" ]]; then
        echo "multiple curl URLs" >&2
        exit 64
      fi
      url=$1
      shift
      ;;
    *)
      echo "unexpected curl option: $1" >&2
      exit 64
      ;;
  esac
done
if [[ "$silent" != true || "$show_error" != true ||
  "$connect_timeout" != 10 || "$max_time" != 60 ||
  "$retry_count" != 3 || "$retry_all_errors" != true ||
  "$retry_delay" != 2 || -z "$url" ]]; then
  echo "missing or invalid common curl options" >&2
  exit 64
fi
if [[ "$request_method" == DELETE ]]; then
  if [[ "$fail_with_body" != false || "$get_request" != false ||
    -n "$data_urlencode" || -n "$request_body" ||
    "$authorization_header" != 'Authorization: Bearer stub-cleanup-token' ||
    -n "$content_type_header" ||
    "$write_out" != $'\n%{http_code}' ||
    -z "$STUB_EXPECTED_DELETE_URL" || "$url" != "$STUB_EXPECTED_DELETE_URL" ]]; then
    echo "unexpected destroy curl behavior" >&2
    exit 64
  fi
  printf 'curl-delete %s\n' "$url" >>"$STUB_COMMAND_LOG"
  if [[ -n "\${STUB_DESTROY_CURL_EXIT:-}" ]]; then
    exit "$STUB_DESTROY_CURL_EXIT"
  fi
  printf '%s\n%s' "$STUB_DESTROY_BODY" "$STUB_DESTROY_STATUS"
elif [[ "$request_method" == POST ]]; then
  if [[ "$fail_with_body" != false || "$get_request" != false ||
    -n "$data_urlencode" || -z "$request_body" ||
    "$authorization_header" != "Authorization: Bearer $STUB_CONTROL_TOKEN" ||
    "$content_type_header" != 'Content-Type: application/json' ||
    "$write_out" != $'\n%{http_code}' ||
    -z "$STUB_EXPECTED_RECLAIM_URL" || "$url" != "$STUB_EXPECTED_RECLAIM_URL" ]]; then
    echo "unexpected reclaim curl behavior" >&2
    exit 64
  fi
  printf 'curl-reclaim %s\n' "$url" >>"$STUB_COMMAND_LOG"
  printf '%s\n' "$request_body" >>"$STUB_RECLAIM_REQUESTS"
  if [[ -n "\${STUB_DESTROY_CURL_EXIT:-}" ]]; then
    exit "$STUB_DESTROY_CURL_EXIT"
  fi
  printf '%s\n%s' "$STUB_DESTROY_BODY" "$STUB_DESTROY_STATUS"
else
  if [[ -n "$request_method" || "$fail_with_body" != true ||
    "$authorization_header" != "Authorization: Bearer $STUB_CONTROL_TOKEN" ||
    -n "$content_type_header" || -n "$request_body" ||
    -n "$write_out" || "$url" != https://worker.test/runners ]]; then
    echo "unexpected registry curl behavior" >&2
    exit 64
  fi
  cursor=initial
  if [[ -n "$data_urlencode" ]]; then
    if [[ "$get_request" != true || "$data_urlencode" != cursor=* ]]; then
      echo "unexpected registry pagination behavior" >&2
      exit 64
    fi
    cursor=\${data_urlencode#cursor=}
  elif [[ "$get_request" != false ]]; then
    echo "unexpected registry GET behavior" >&2
    exit 64
  fi
  printf 'curl-registry %s\n' "$cursor" >>"$STUB_COMMAND_LOG"
  cat "$STUB_REGISTRY_PAGE_DIR/$cursor.json"
fi
`);

  writeExecutable(stubDirectory, "jq", `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${STUB_JQ_URI_FAILURE:-false}" == true && "$*" == *'@uri'* ]]; then
  echo "stub jq URI failure" >&2
  exit 9
fi
exec "$REAL_JQ_PATH" "$@"
`);
}

function runAudit({
  args = ["--json"],
  instancePages = { initial: instancePage([]) },
  registryPages = { initial: registryPage([]) },
  githubCalls,
  githubEndpoint = "repos/owner/repository/actions/runners",
  githubProbeResponse = githubResponse([]),
  githubProbeExit = 0,
  githubProbeStderr = "",
  configuredRunnerScope,
  expectedDeleteUrl = "",
  expectedReclaimUrl = "",
  environment = {},
} = {}) {
  const controlToken = "x".repeat(32);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "orphan-audit-test-"));
  const auditTemporaryDirectory = join(temporaryDirectory, "audit-tmp");
  const stubDirectory = join(temporaryDirectory, "bin");
  const instancePageDirectory = join(temporaryDirectory, "instances");
  const registryPageDirectory = join(temporaryDirectory, "registry");
  const githubCallsPath = join(temporaryDirectory, "github-calls.json");
  const githubCallCountPath = join(temporaryDirectory, "github-call-count");
  const dateCallCountPath = join(temporaryDirectory, "date-call-count");
  const commandLogPath = join(temporaryDirectory, "commands.log");
  const reclaimRequestsPath = join(
    temporaryDirectory,
    "reclaim-requests.jsonl",
  );
  const initialGithubCalls = auditGithubCandidates(
    instancePages,
    registryPages,
  ).map(({ uuid, name }) => githubCall(uuid, undefined, null, name));
  const configuredGithubCalls = githubCalls ?? [
    ...initialGithubCalls,
    ...(args.includes("--destroy") ? initialGithubCalls : []),
  ];
  mkdirSync(auditTemporaryDirectory);
  mkdirSync(stubDirectory);
  writePages(instancePageDirectory, instancePages);
  writePages(registryPageDirectory, registryPages);
  writeGithubCalls(githubCallsPath, configuredGithubCalls);
  writeFileSync(githubCallCountPath, "0\n");
  writeFileSync(dateCallCountPath, "0\n");
  writeFileSync(commandLogPath, "");
  writeFileSync(reclaimRequestsPath, "");
  installStubs(stubDirectory);

  let result;
  let commandLog;
  let reclaimRequests;
  try {
    const auditEnvironment = {
      ...process.env,
      PATH: `${stubDirectory}:${process.env.PATH}`,
      TMPDIR: auditTemporaryDirectory,
      WORKER_URL: "https://worker.test",
      CONTROL_TOKEN: controlToken,
      WRANGLER_CONFIG: "test/wrangler.jsonc",
      CONTAINER_NAME: "test-container",
      GITHUB_REPOSITORY: "owner/repository",
      APPLICATION_ID: applicationId,
      REAL_JQ_PATH: realJqPath,
      STUB_APPLICATION_ID: applicationId,
      STUB_AUDIT_START_EPOCH: String(nowEpoch),
      STUB_COMMAND_LOG: commandLogPath,
      STUB_CONTROL_TOKEN: controlToken,
      STUB_DATE_CALL_COUNT: dateCallCountPath,
      STUB_DESTROY_BODY: '{"cleanupStatus":"scheduled"}',
      STUB_DESTROY_STATUS: "202",
      STUB_EXPECTED_DELETE_URL: expectedDeleteUrl,
      STUB_EXPECTED_RECLAIM_URL: expectedReclaimUrl,
      STUB_GITHUB_CALL_COUNT: githubCallCountPath,
      STUB_GITHUB_CALLS: githubCallsPath,
      STUB_GITHUB_ENDPOINT: githubEndpoint,
      STUB_GITHUB_PROBE_EXIT: String(githubProbeExit),
      STUB_GITHUB_PROBE_RESPONSE: typeof githubProbeResponse === "string"
        ? githubProbeResponse
        : JSON.stringify(githubProbeResponse),
      STUB_GITHUB_PROBE_STDERR: githubProbeStderr,
      STUB_INSTANCE_PAGE_DIR: instancePageDirectory,
      STUB_REGISTRY_PAGE_DIR: registryPageDirectory,
      STUB_RECLAIM_REQUESTS: reclaimRequestsPath,
      STUB_NOW_EPOCH: String(nowEpoch),
      STUB_WRANGLER_CONFIG: "test/wrangler.jsonc",
      ...environment,
    };
    if (!Object.hasOwn(environment, "GITHUB_RUNNER_SCOPE")) {
      delete auditEnvironment.GITHUB_RUNNER_SCOPE;
    }
    if (configuredRunnerScope === undefined) {
      delete auditEnvironment.STUB_CONFIGURED_RUNNER_SCOPE;
    } else {
      auditEnvironment.STUB_CONFIGURED_RUNNER_SCOPE = configuredRunnerScope;
    }
    result = spawnSync("bash", [auditScript, ...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: auditEnvironment,
    });
    commandLog = readFileSync(commandLogPath, "utf8");
    reclaimRequests = readFileSync(reclaimRequestsPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      readdirSync(auditTemporaryDirectory),
      [],
      `temporary files remained after exit ${result.status}`,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  if (result.status === null) {
    throw result.error ?? new Error("The orphan audit did not return a status");
  }
  return { ...result, commandLog, reclaimRequests };
}

function jsonLines(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function outputByType(result, type) {
  return jsonLines(result.stdout).filter((record) => record.type === type);
}

function assertSummary(result, expected) {
  const summaries = outputByType(result, "summary");
  const orphanCount = expected.orphanCount ?? 0;
  const ambiguousInstanceCount = expected.ambiguousInstanceCount ?? 0;
  const expectedValues = {
    orphanCount,
    ambiguousInstanceCount,
    findingCount: orphanCount + ambiguousInstanceCount,
    ghostRegistrationCount: 0,
    destroyScheduledCount: 0,
    destroyAlreadyScheduledCount: 0,
    destroyReclaimedCount: 0,
    destroyAbsenceRecordedCount: 0,
    destroyFailureCount: 0,
    destroySkippedCount: 0,
    destroyOperatorRequiredCount: 0,
    destroyRegisteredSkipCount: 0,
    ...expected,
  };
  assert.equal(summaries.length, 1);
  const actualValues = Object.fromEntries(
    Object.keys(expectedValues).map((key) => [key, summaries[0][key]]),
  );
  assert.deepEqual(
    actualValues,
    expectedValues,
  );
}

function npxCallCount(commandLog) {
  return npxCalls(commandLog).length;
}

function npxCalls(commandLog) {
  return commandLog
    .split("\n")
    .filter((line) => line.startsWith("npx "));
}

function deleteRequestCount(commandLog) {
  return commandLog
    .split("\n")
    .filter((line) => line.startsWith("curl-delete "))
    .length;
}

function reclaimRequestCount(commandLog) {
  return commandLog
    .split("\n")
    .filter((line) => line.startsWith("curl-reclaim "))
    .length;
}

function deleteUrl(uuid) {
  return `https://worker.test/runners/runner-${uuid}`;
}

function reclaimUrl(uuid) {
  return `https://worker.test/operator/orphans/runner-${uuid}/reclaim`;
}

function attemptDestroyFunctionSource() {
  const source = readFileSync(auditScript, "utf8");
  const start = source.indexOf("attempt_destroy() {");
  const end = source.indexOf("\nfor orphan in", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test("queries the organization runner scope [mutation: query the repository endpoint under organization scope]", () => {
  const uuid = runnerUuid(130);
  const endpoint = "orgs/owner/actions/runners";
  const result = runAudit({
    githubEndpoint: endpoint,
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    environment: { GITHUB_RUNNER_SCOPE: "organization" },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    result.commandLog
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("gh-")),
    [
      `gh-probe ${endpoint}`,
      `gh-query cloudflare-${uuid}`,
    ],
  );
  assert.equal(outputByType(result, "orphan").length, 1);
  assert.equal(outputByType(result, "summary")[0].runnerScope, "organization:owner");
});

test("uses an explicit runner organization [mutation: derive the explicit organization from the repository owner]", () => {
  const uuid = runnerUuid(131);
  const endpoint = "orgs/acme/actions/runners";
  const result = runAudit({
    githubEndpoint: endpoint,
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    environment: { GITHUB_RUNNER_SCOPE: "organization:acme" },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.commandLog, new RegExp(`^gh-probe ${endpoint}$`, "m"));
  assert.match(
    result.commandLog,
    new RegExp(`^gh-query cloudflare-${uuid}$`, "m"),
  );
  assert.equal(outputByType(result, "summary")[0].runnerScope, "organization:acme");
});

test("keeps repository-scope orphan cleanup by default [mutation: query the organization endpoint under repository scope]", () => {
  const uuid = runnerUuid(132);
  const endpoint = "repos/owner/repository/actions/runners";
  const result = runAudit({
    args: ["--json", "--destroy"],
    expectedDeleteUrl: deleteUrl(uuid),
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(outputByType(result, "orphan")[0].destroyResult, "cleanup-scheduled");
  assert.equal(deleteRequestCount(result.commandLog), 1);
  assert.equal(
    result.commandLog.match(new RegExp(`^gh-query cloudflare-${uuid}$`, "gm"))?.length,
    2,
  );
  assert.match(result.commandLog, new RegExp(`^gh-probe ${endpoint}$`, "m"));
  assert.equal(
    outputByType(result, "summary")[0].runnerScope,
    "repository:owner/repository",
  );
});

test("accepts the explicit repository runner scope [mutation: reject the repository scope keyword]", () => {
  const result = runAudit({
    environment: { GITHUB_RUNNER_SCOPE: "repository" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.commandLog,
    /^gh-probe repos\/owner\/repository\/actions\/runners$/m,
  );
  assert.equal(
    outputByType(result, "summary")[0].runnerScope,
    "repository:owner/repository",
  );
});

test("uses the environment scope before the Wrangler scope [mutation: invert runner scope precedence]", () => {
  const environmentResult = runAudit({
    configuredRunnerScope: "organization:acme",
    environment: { GITHUB_RUNNER_SCOPE: "repository" },
  });
  const configResult = runAudit({
    configuredRunnerScope: "organization:acme",
    githubEndpoint: "orgs/acme/actions/runners",
    environment: { GITHUB_RUNNER_SCOPE: "" },
  });

  assert.equal(environmentResult.status, 0, environmentResult.stderr);
  assert.equal(
    outputByType(environmentResult, "summary")[0].runnerScope,
    "repository:owner/repository",
  );
  assert.equal(configResult.status, 0, configResult.stderr);
  assert.equal(
    outputByType(configResult, "summary")[0].runnerScope,
    "organization:acme",
  );
});

test("aborts after a forbidden organization scope probe [mutation: continue the audit after a forbidden runner scope]", () => {
  const endpoint = "orgs/owner/actions/runners";
  const probeError = "gh: Resource not accessible by personal access token (HTTP 403)";
  const result = runAudit({
    githubEndpoint: endpoint,
    githubProbeExit: 1,
    githubProbeStderr: probeError,
    environment: { GITHUB_RUNNER_SCOPE: "organization" },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, new RegExp(probeError.replace(/[()]/g, "\\$&")));
  assert.match(result.stderr, /organization:owner/);
  assert.match(result.stderr, /orgs\/owner\/actions\/runners/);
  assert.match(result.stderr, /Organization `Self-hosted runners: Read-only`/);
  assert.match(
    result.stderr,
    /only repository `Administration: Read-only` gets HTTP 403 on an organization endpoint/,
  );
  assert.equal(result.stdout, "");
  assert.equal(outputByType(result, "summary").length, 0);
  assert.equal(outputByType(result, "orphan").length, 0);
  assert.equal(result.commandLog, `gh-probe ${endpoint}\n`);
  assert.doesNotMatch(result.commandLog, /^gh-query /m);
  assert.doesNotMatch(result.commandLog, /^npx /m);
});

test("aborts after an invisible runner scope probe [mutation: continue the audit after a missing runner scope]", () => {
  const endpoint = "orgs/owner/actions/runners";
  const result = runAudit({
    githubEndpoint: endpoint,
    githubProbeExit: 1,
    githubProbeStderr: "gh: Not Found (HTTP 404)",
    environment: { GITHUB_RUNNER_SCOPE: "organization" },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /organization:owner/);
  assert.match(result.stderr, /orgs\/owner\/actions\/runners/);
  assert.match(result.stderr, /scope target is absent or invisible to AUDIT_GITHUB_TOKEN/);
  assert.doesNotMatch(result.commandLog, /^npx /m);
});

test("aborts after another runner scope probe failure [mutation: ignore a generic runner scope failure]", () => {
  const endpoint = "repos/owner/repository/actions/runners";
  const result = runAudit({
    githubProbeExit: 7,
    githubProbeStderr: "stub transport failure",
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /stub transport failure/);
  assert.match(result.stderr, /repository:owner\/repository/);
  assert.match(result.stderr, new RegExp(endpoint.replaceAll("/", "\\/")));
  assert.doesNotMatch(result.commandLog, /^npx /m);
});

test("aborts after a malformed runner scope payload [mutation: accept malformed runner scope data]", () => {
  const result = runAudit({
    githubProbeResponse: '{"total_count":0,"runners":{}}',
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /runner scope probe returned invalid data/);
  assert.match(result.stderr, /repository:owner\/repository/);
  assert.equal(outputByType(result, "summary").length, 0);
  assert.doesNotMatch(result.commandLog, /^npx /m);
});

test("rejects invalid runner scopes before the probe [mutation: accept an invalid runner scope]", () => {
  const cases = [
    [
      "org",
      "GITHUB_RUNNER_SCOPE must be repository, organization, or organization:<org>",
    ],
    [
      "organization:",
      'GITHUB_RUNNER_SCOPE organization must be non-empty and contain no "/", "*", or ".."',
    ],
    [
      "organization:a/b",
      'GITHUB_RUNNER_SCOPE organization must be non-empty and contain no "/", "*", or ".."',
    ],
    [
      "organization:*",
      'GITHUB_RUNNER_SCOPE organization must be non-empty and contain no "/", "*", or ".."',
    ],
    [
      "organization:..",
      'GITHUB_RUNNER_SCOPE organization must be non-empty and contain no "/", "*", or ".."',
    ],
  ];

  for (const [scope, message] of cases) {
    const result = runAudit({
      environment: { GITHUB_RUNNER_SCOPE: scope },
    });

    assert.equal(result.status, 2, `${scope}: ${result.stderr}`);
    assert.equal(result.stderr, `${message}\n`, scope);
    assert.equal(result.commandLog, "", scope);
  }
});

test("probes an empty fleet before Cloudflare [mutation: skip the probe for an empty fleet]", () => {
  const result = runAudit({
    instancePages: {
      initial: instancePage([], { reportPageSize: false }),
    },
    registryPages: {
      initial: registryPage([]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.commandLog.split("\n")[0],
    "gh-probe repos/owner/repository/actions/runners",
  );
  assertSummary(result, {
    orphanCount: 0,
    destroyScheduledCount: 0,
    destroyFailureCount: 0,
    destroySkippedCount: 0,
  });
});

test("rechecks destroy candidates in the organization scope [mutation: recheck destroy candidates in the repository scope]", () => {
  const uuid = runnerUuid(133);
  const endpoint = "orgs/owner/actions/runners";
  const result = runAudit({
    args: ["--json", "--destroy"],
    expectedDeleteUrl: deleteUrl(uuid),
    githubEndpoint: endpoint,
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    environment: { GITHUB_RUNNER_SCOPE: "organization" },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    result.commandLog.match(new RegExp(`^gh-query cloudflare-${uuid}$`, "gm"))?.length,
    2,
  );
  assert.match(result.commandLog, new RegExp(`^gh-probe ${endpoint}$`, "m"));
  assert.equal(deleteRequestCount(result.commandLog), 1);
  assert.equal(outputByType(result, "summary")[0].runnerScope, "organization:owner");
});

test("ignores an unmatched destroyed row with a future timestamp", () => {
  const uuid = runnerUuid(82);
  const result = runAudit({
    registryPages: {
      initial: registryPage([registryRow({
        uuid,
        state: "destroyed",
        createdAt: new Date((nowEpoch + 1) * 1000).toISOString(),
      })]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputByType(result, "orphan").length, 0);
});

test("exits 2 for an empty Cloudflare read with an old online row", () => {
  const uuid = runnerUuid(76);
  const result = runAudit({
    instancePages: {
      initial: instancePage([]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(
    result.stderr,
    /Cloudflare reported no container instances while the Worker registry holds 1 starting or online row\(s\) older than the grace period/,
  );
});

test("posts complete empty-enumeration evidence to the reclaim route", () => {
  const uuid = runnerUuid(78);
  const revision = 5;
  const sandbox = `runner-${uuid}`;
  const result = runAudit({
    args: ["--json", "--destroy"],
    expectedReclaimUrl: reclaimUrl(uuid),
    instancePages: {
      initial: instancePage([]),
    },
    registryPages: {
      initial: registryPage([
        registryRow({ uuid, state: "destroying", revision }),
      ]),
    },
    environment: {
      STUB_DESTROY_BODY: JSON.stringify({
        outcome: "absence-recorded",
        sandboxId: sandbox,
        revision,
        reclaimableAtMs: 1_800_000_000_000,
      }),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].reason, "absent-from-cloudflare");
  assert.equal(orphans[0].registryState, "destroying");
  assert.equal(orphans[0].registryRevision, revision);
  assert.equal(orphans[0].instanceId, null);
  assert.equal(orphans[0].state, null);
  assert.equal(orphans[0].cloudflareCreated, null);
  assert.equal(orphans[0].inactiveInstance, null);
  assert.equal(orphans[0].destroyResult, "absence-recorded");
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assert.equal(reclaimRequestCount(result.commandLog), 1);
  assert.deepEqual(result.reclaimRequests, [{
    observedRegistryCondition: "live",
    expectedRevision: revision,
    cloudflareAbsence: {
      enumerationOutcome: "exhausted",
      instanceCount: 0,
      liveInstanceCount: 0,
      pageCount: 1,
      applicationId,
    },
    observedRegistration: {
      outcome: "registration-not-found",
      runnerName: `cloudflare-${uuid}`,
    },
  }]);
  assertSummary(result, {
    orphanCount: 1,
    destroyAbsenceRecordedCount: 1,
  });
  assert.match(
    result.stderr,
    /it found 0 ambiguous instance record\(s\) and 1 orphan record\(s\)/,
  );
  assert.doesNotMatch(result.stderr, /unaccounted live sandbox/);
});

test("does not report a row that crosses the grace after audit start", () => {
  const uuid = runnerUuid(79);
  const result = runAudit({
    instancePages: {
      initial: instancePage([]),
    },
    registryPages: {
      initial: registryPage([registryRow({
        uuid,
        createdAt: new Date((nowEpoch - 61) * 1000).toISOString(),
      })]),
    },
    environment: {
      STUB_AUDIT_START_EPOCH: String(nowEpoch - 2),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputByType(result, "orphan").length, 0);
});

test("reports a registered GitHub runner without a live instance", () => {
  const uuid = runnerUuid(80);
  const unrelatedUuid = runnerUuid(81);
  const result = runAudit({
    instancePages: {
      initial: instancePage([
        cloudflareInstance({ uuid: unrelatedUuid, state: "inactive" }),
      ]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    githubCalls: [
      githubCall(
        uuid,
        githubResponse([githubRunner({ id: 80, uuid })]),
      ),
    ],
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].reason, "registered-without-instance");
  assert.equal(orphans[0].runnerName, `cloudflare-${uuid}`);
  assert.match(
    result.commandLog,
    new RegExp(`^gh-query cloudflare-${uuid}$`, "m"),
  );
  assertSummary(result, {
    orphanCount: 1,
    ghostRegistrationCount: 1,
  });
});

test("routes a ghost registration to manual review without cleanup", () => {
  const uuid = runnerUuid(134);
  const unrelatedUuid = runnerUuid(135);
  const runnerName = `cloudflare-${uuid}`;
  const result = runAudit({
    args: ["--json", "--destroy"],
    instancePages: {
      initial: instancePage([
        cloudflareInstance({ uuid: unrelatedUuid, state: "inactive" }),
      ]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid, revision: 9 })]),
    },
    githubCalls: [
      githubCall(
        uuid,
        githubResponse([githubRunner({ id: 134, uuid, status: "offline" })]),
      ),
    ],
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].reason, "registered-without-instance");
  assert.equal(orphans[0].runnerName, runnerName);
  assert.equal(orphans[0].destroyResult, "operator-route-required");
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assert.equal(reclaimRequestCount(result.commandLog), 0);
  assert.deepEqual(result.reclaimRequests, []);
  assert.match(result.stderr, new RegExp(runnerName));
  assert.match(result.stderr, /review the GitHub registration manually/);
  assertSummary(result, {
    orphanCount: 1,
    ghostRegistrationCount: 1,
    destroyOperatorRequiredCount: 1,
  });
});

test("classifies a successful absent-from-cloudflare reclaim", () => {
  const uuid = runnerUuid(77);
  const revision = 6;
  const sandbox = `runner-${uuid}`;
  const instance = cloudflareInstance({ uuid, state: "inactive" });
  const result = runAudit({
    args: ["--json", "--destroy"],
    expectedReclaimUrl: reclaimUrl(uuid),
    instancePages: {
      initial: instancePage([instance]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid, revision })]),
    },
    environment: {
      STUB_DESTROY_STATUS: "200",
      STUB_DESTROY_BODY: JSON.stringify({
        outcome: "reclaimed",
        sandboxId: sandbox,
        runnerName: `cloudflare-${uuid}`,
        registrationLookupOutcome: "registration-not-found",
      }),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].reason, "absent-from-cloudflare");
  assert.equal(orphans[0].instanceId, null);
  assert.equal(orphans[0].state, null);
  assert.equal(orphans[0].cloudflareCreated, null);
  assert.deepEqual(orphans[0].inactiveInstance, {
    id: instance.id,
    state: instance.state,
    created: instance.created,
  });
  assert.equal(orphans[0].registryRevision, revision);
  assert.equal(orphans[0].destroyResult, "reclaimed");
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assert.equal(reclaimRequestCount(result.commandLog), 1);
  assertSummary(result, {
    orphanCount: 1,
    destroyReclaimedCount: 1,
  });
});

test("keeps operator-route-required without HTTP for incomplete enumeration", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "orphan-reclaim-guard-"));
  const callLog = join(temporaryDirectory, "curl.log");
  writeFileSync(callLog, "");
  const harness = [
    "set -euo pipefail",
    attemptDestroyFunctionSource(),
    "destroy=true",
    "destroy_unknown_age=false",
    "worker_url=https://worker.test",
    `CONTROL_TOKEN=${"x".repeat(32)}`,
    "instance_count=0",
    "live_instance_count=0",
    "instance_page_count=1",
    `application_id=${applicationId}`,
    "query_github_runner_registration() { printf '%s\\n' unregistered; }",
    "curl() { printf '%s\\n' called >>\"$CALL_LOG\"; return 99; }",
    "for outcome in \"$@\"; do",
    "  instance_pagination_outcome=$outcome",
    `  attempt_destroy runner-${runnerUuid(120)} ${runnerUuid(120)} cloudflare-${runnerUuid(120)} '' '' worker-registry absent-from-cloudflare 7`,
    "  printf '%s\\t%s\\n' \"$destroy_result\" \"$destroy_http_status\"",
    "done",
  ].join("\n");

  let result;
  try {
    result = spawnSync(
      "bash",
      ["-c", harness, "orphan-reclaim-guard", "", "truncated-page-limit"],
      {
        encoding: "utf8",
        env: { ...process.env, CALL_LOG: callLog },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "operator-route-required\tnull",
      "operator-route-required\tnull",
    ], result.stderr);
    assert.equal(readFileSync(callLog, "utf8"), "");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("parses a fractional Cloudflare timestamp through the real script", () => {
  const uuid = runnerUuid(1);
  const result = runAudit({
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].cloudflareCreated, cloudflareCreatedAt);
  assert.equal(orphans[0].reason, "unregistered");
  assertSummary(result, {
    orphanCount: 1,
    destroyScheduledCount: 0,
    destroyFailureCount: 0,
    destroySkippedCount: 0,
  });
});

test("completes when a reduced page size confirms a full final Cloudflare page", () => {
  const instances = Array.from({ length: 25 }, (_, index) =>
    cloudflareInstance({
      uuid: runnerUuid(200 + index),
      state: "inactive",
    }));
  const result = runAudit({
    instancePages: {
      initial: instancePage(instances),
      "initial@24": instancePage(
        instances.slice(0, 24),
        { nextPageToken: "tail", perPage: 24 },
      ),
      tail: instancePage([instances[24]]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assertSummary(result, {
    instancePageCount: 3,
    instanceBoundaryConfirmationCount: 1,
    instancePagination: "exhausted",
  });
  assert.deepEqual(npxCalls(result.commandLog), [
    "npx per-page=25 page-token=",
    "npx per-page=24 page-token=",
    "npx per-page=25 page-token=tail",
  ]);
});

test("resets Cloudflare boundary confirmation state for a later cursor", () => {
  const initialInstances = Array.from({ length: 25 }, (_, index) =>
    cloudflareInstance({
      uuid: runnerUuid(600 + index),
      state: "inactive",
    }));
  const secondInstances = Array.from({ length: 25 }, (_, index) =>
    cloudflareInstance({
      uuid: runnerUuid(700 + index),
      state: "inactive",
    }));
  const result = runAudit({
    instancePages: {
      initial: instancePage(initialInstances),
      "initial@24": instancePage(
        initialInstances.slice(0, 24),
        { nextPageToken: "second", perPage: 24 },
      ),
      second: instancePage(secondInstances),
      "second@24": instancePage(
        secondInstances.slice(0, 24),
        { nextPageToken: "tail", perPage: 24 },
      ),
      tail: instancePage([secondInstances[24]]),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assertSummary(result, {
    instancePagination: "exhausted",
    instancePageCount: 5,
    instanceBoundaryConfirmationCount: 2,
  });
  assert.deepEqual(npxCalls(result.commandLog), [
    "npx per-page=25 page-token=",
    "npx per-page=24 page-token=",
    "npx per-page=25 page-token=second",
    "npx per-page=24 page-token=second",
    "npx per-page=25 page-token=tail",
  ]);
});

test("reports a busy fleet through a full final Cloudflare page", () => {
  const uuids = Array.from({ length: 25 }, (_, index) => runnerUuid(300 + index));
  const instances = uuids.map((uuid) => cloudflareInstance({ uuid }));
  const orphan = instances[24];
  const result = runAudit({
    instancePages: {
      initial: instancePage(instances),
      "initial@24": instancePage(
        instances.slice(0, 24),
        { nextPageToken: "tail", perPage: 24 },
      ),
      tail: instancePage([orphan]),
    },
    registryPages: {
      initial: registryPage(uuids.map((uuid) => registryRow({ uuid }))),
    },
    githubCalls: uuids.map((uuid, index) => githubCall(
      uuid,
      index === 24
        ? githubResponse([])
        : githubResponse([githubRunner({ id: 300 + index, uuid })]),
    )),
  });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    outputByType(result, "orphan").map(({ instanceId, reason }) => ({
      instanceId,
      reason,
    })),
    [{ instanceId: orphan.id, reason: "unregistered" }],
  );
  assertSummary(result, {
    orphanCount: 1,
    instancePageCount: 3,
    instanceBoundaryConfirmationCount: 1,
    instanceCount: 25,
    liveInstanceCount: 25,
    instancePagination: "exhausted",
  });
  assert.deepEqual(npxCalls(result.commandLog), [
    "npx per-page=25 page-token=",
    "npx per-page=24 page-token=",
    "npx per-page=25 page-token=tail",
  ]);
});

test("reports the rows that an ambiguous full Cloudflare page hid", () => {
  const visibleInstances = Array.from({ length: 25 }, (_, index) =>
    cloudflareInstance({
      uuid: runnerUuid(400 + index),
      state: "inactive",
    }));
  const hiddenOrphan = cloudflareInstance({ uuid: runnerUuid(425) });
  const result = runAudit({
    instancePages: {
      initial: instancePage(visibleInstances),
      "initial@24": instancePage(
        visibleInstances.slice(0, 24),
        { nextPageToken: "tail", perPage: 24 },
      ),
      tail: instancePage([visibleInstances[24], hiddenOrphan]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    outputByType(result, "orphan").map(({ instanceId, reason }) => ({
      instanceId,
      reason,
    })),
    [{ instanceId: hiddenOrphan.id, reason: "absent-from-registry" }],
  );
  assertSummary(result, {
    orphanCount: 1,
    instancePageCount: 3,
    instanceBoundaryConfirmationCount: 1,
    instanceCount: 26,
    liveInstanceCount: 1,
    instancePagination: "exhausted",
  });
});

test("rejects a Cloudflare list that two page sizes both claim to end", () => {
  const instances = [
    cloudflareInstance({ uuid: runnerUuid(500), state: "inactive" }),
    cloudflareInstance({ uuid: runnerUuid(501), state: "inactive" }),
  ];
  const result = runAudit({
    instancePages: {
      initial: instancePage(instances, { perPage: 2 }),
      "initial@1": instancePage([instances[0]], { perPage: 1 }),
    },
  });

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /a 2-row page and a 1-row page from the same cursor both ended without a next page token/,
  );
});

test("rejects a full one-row Cloudflare page that cannot be confirmed", () => {
  const result = runAudit({
    instancePages: {
      initial: instancePage([
        cloudflareInstance({ uuid: runnerUuid(510), state: "inactive" }),
      ], { perPage: 1 }),
    },
  });

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /a full page of 1 row\(s\) had no next page token and no smaller page size exists to confirm it/,
  );
});

test("validates the server-reported Cloudflare page size", () => {
  for (const perPage of [0, 1.5, "2", 26]) {
    const result = runAudit({
      instancePages: {
        initial: instancePage([], { perPage }),
      },
    });

    assert.equal(result.status, 2, `per_page=${JSON.stringify(perPage)}`);
    assert.match(result.stderr, /invalid container instance page/);
  }
});

test("rejects a Cloudflare confirmation larger than its requested page size", () => {
  const instances = Array.from({ length: 25 }, (_, index) =>
    cloudflareInstance({
      uuid: runnerUuid(520 + index),
      state: "inactive",
    }));
  const result = runAudit({
    instancePages: {
      initial: instancePage(instances),
      "initial@24": instancePage([], { perPage: 25 }),
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid container instance page/);
});

test("completes when the Cloudflare cursor closes a cycle", () => {
  const result = runAudit({
    instancePages: {
      initial: instancePage([
        cloudflareInstance({
          uuid: runnerUuid(94),
          id: "1".repeat(64),
          state: "inactive",
        }),
      ], { nextPageToken: "second" }),
      second: instancePage([
        cloudflareInstance({
          uuid: runnerUuid(95),
          id: "2".repeat(64),
          state: "inactive",
        }),
      ], { nextPageToken: "third" }),
      third: instancePage([
        cloudflareInstance({
          uuid: runnerUuid(96),
          id: "3".repeat(64),
          state: "inactive",
        }),
      ], { nextPageToken: "second" }),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assertSummary(result, {
    instancePageCount: 3,
    instancePagination: "cycle-closed",
  });
  assert.match(
    result.stderr,
    /closed a cursor cycle after 3 page\(s\); the enumeration is complete/,
  );
});

test("completes when a repeated Cloudflare page closes the cursor cycle", () => {
  const initialRows = [
    cloudflareInstance({
      uuid: runnerUuid(113),
      id: "1".repeat(64),
      state: "inactive",
    }),
    cloudflareInstance({
      uuid: runnerUuid(114),
      id: "2".repeat(64),
      state: "inactive",
    }),
  ];
  const result = runAudit({
    instancePages: {
      initial: instancePage(initialRows, { nextPageToken: "second" }),
      second: instancePage([
        cloudflareInstance({
          uuid: runnerUuid(115),
          id: "3".repeat(64),
          state: "inactive",
        }),
        cloudflareInstance({
          uuid: runnerUuid(116),
          id: "4".repeat(64),
          state: "inactive",
        }),
      ], { nextPageToken: "third" }),
      third: instancePage(initialRows, { nextPageToken: "second" }),
    },
  });

  assert.ok([0, 1].includes(result.status), result.stderr);
  assertSummary(result, {
    instancePageCount: 3,
    instancePagination: "cycle-closed",
  });
  assert.doesNotMatch(result.stderr, /repeated a container instance page/);
});

test("stops after one lap when the Cloudflare cursor wraps", () => {
  const wrappedOrphan = cloudflareInstance({
    uuid: runnerUuid(97),
    id: "1".repeat(64),
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage([
        cloudflareInstance({
          uuid: runnerUuid(98),
          id: "2".repeat(64),
          state: "inactive",
        }),
        cloudflareInstance({
          uuid: runnerUuid(99),
          id: "4".repeat(64),
          state: "inactive",
        }),
      ], { nextPageToken: "second" }),
      second: instancePage([
        cloudflareInstance({
          uuid: runnerUuid(100),
          id: "6".repeat(64),
          state: "inactive",
        }),
        wrappedOrphan,
        cloudflareInstance({
          uuid: runnerUuid(101),
          id: "3".repeat(64),
          state: "inactive",
        }),
      ], { nextPageToken: "unused" }),
      unused: instancePage([]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(npxCallCount(result.commandLog), 2);
  assert.ok(
    outputByType(result, "orphan")
      .some(({ instanceId }) => instanceId === wrappedOrphan.id),
  );
  assertSummary(result, {
    orphanCount: 1,
    instancePageCount: 2,
    instancePagination: "lap-closed",
  });
});

test("falls back to the cursor cycle when Cloudflare pages are not id-ordered", () => {
  const inactiveInstance = (uuid, idDigit) => cloudflareInstance({
    uuid,
    id: idDigit.repeat(64),
    state: "inactive",
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage([
        inactiveInstance(runnerUuid(102), "4"),
        inactiveInstance(runnerUuid(103), "5"),
      ], { nextPageToken: "second" }),
      second: instancePage([
        inactiveInstance(runnerUuid(104), "8"),
        inactiveInstance(runnerUuid(105), "1"),
        inactiveInstance(runnerUuid(106), "7"),
        inactiveInstance(runnerUuid(107), "2"),
        inactiveInstance(runnerUuid(108), "6"),
      ], { nextPageToken: "third" }),
      third: instancePage([
        inactiveInstance(runnerUuid(109), "3"),
        inactiveInstance(runnerUuid(117), "9"),
      ], { nextPageToken: "fourth" }),
      fourth: instancePage([
        inactiveInstance(runnerUuid(118), "a"),
      ], { nextPageToken: "second" }),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(npxCallCount(result.commandLog), 4);
  assertSummary(result, {
    instancePageCount: 4,
    instancePagination: "cycle-closed",
  });
});

test("rejects repeated empty Cloudflare pages with distinct tokens", () => {
  const result = runAudit({
    instancePages: {
      initial: instancePage([], { nextPageToken: "second" }),
      second: instancePage([], { nextPageToken: "third" }),
      third: instancePage([]),
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /repeated a container instance page$/m);
});

test("rejects a repeated non-empty Cloudflare page", () => {
  const repeatedRows = [
    cloudflareInstance({ uuid: runnerUuid(41), state: "inactive" }),
    cloudflareInstance({ uuid: runnerUuid(42), state: "inactive" }),
  ];
  const interveningRows = [
    cloudflareInstance({ uuid: runnerUuid(43), state: "inactive" }),
  ];
  const result = runAudit({
    instancePages: {
      initial: instancePage(repeatedRows, { nextPageToken: "second" }),
      second: instancePage(interveningRows, { nextPageToken: "third" }),
      third: instancePage(repeatedRows),
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /repeated a container instance page$/m);
});

test("rejects a reordered repeated Cloudflare page", () => {
  const first = cloudflareInstance({
    uuid: runnerUuid(44),
    state: "inactive",
  });
  const second = cloudflareInstance({
    uuid: runnerUuid(45),
    state: "inactive",
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage([first, second], { nextPageToken: "second" }),
      second: instancePage([second, first]),
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /repeated a container instance page$/m);
});

test("collapses one Cloudflare instance repeated across distinct pages", () => {
  const uuid = runnerUuid(4);
  const instance = cloudflareInstance({ uuid });
  const inactive = cloudflareInstance({
    uuid: runnerUuid(40),
    state: "inactive",
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage(
        [instance, inactive],
        { nextPageToken: "second" },
      ),
      second: instancePage([instance]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].instanceId, instance.id);
  assertSummary(result, { orphanCount: 1 });
});

test("reports the instance enumeration counters", () => {
  const liveInstance = cloudflareInstance({
    uuid: runnerUuid(110),
    id: "1".repeat(64),
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage([
        liveInstance,
        cloudflareInstance({
          uuid: runnerUuid(111),
          id: "2".repeat(64),
          state: "inactive",
        }),
      ], { nextPageToken: "second" }),
      second: instancePage([
        liveInstance,
        cloudflareInstance({
          uuid: runnerUuid(112),
          id: "3".repeat(64),
          state: "inactive",
        }),
      ]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assertSummary(result, {
    orphanCount: 1,
    instancePageCount: 2,
    instanceRowCount: 4,
    instanceCount: 3,
    liveInstanceCount: 1,
    instancePagination: "exhausted",
  });
});

test("collapses partial Cloudflare overlap across three distinct pages", () => {
  const uuids = Array.from({ length: 4 }, (_, index) => runnerUuid(50 + index));
  const instances = uuids.map((uuid, index) => cloudflareInstance({
    uuid,
    id: String(index + 1).repeat(64),
    state: index === 3 ? "running" : "inactive",
  }));
  const result = runAudit({
    instancePages: {
      initial: instancePage(
        [instances[0], instances[1]],
        { nextPageToken: "second" },
      ),
      second: instancePage(
        [instances[1], instances[2]],
        { nextPageToken: "third" },
      ),
      third: instancePage([instances[0], instances[2], instances[3]]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid: uuids[3] })]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    outputByType(result, "orphan").map((orphan) => ({
      instanceId: orphan.instanceId,
      reason: orphan.reason,
    })),
    [{ instanceId: instances[3].id, reason: "unregistered" }],
  );
  assertSummary(result, { orphanCount: 1 });
});

test("reports a running orphan across a running-to-inactive transition", () => {
  const uuid = runnerUuid(5);
  const instance = cloudflareInstance({ uuid });
  const inactive = cloudflareInstance({
    uuid: runnerUuid(46),
    state: "inactive",
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage(
        [instance, inactive],
        { nextPageToken: "second" },
      ),
      second: instancePage([{ ...instance, state: "inactive" }]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].instanceId, instance.id);
  assert.equal(orphans[0].reason, "unregistered");
  assert.equal(orphans[0].state, "running");
  assertSummary(result, { orphanCount: 1 });
});

test("a location conflict across pages does not abort the audit", () => {
  const ambiguousUuid = runnerUuid(140);
  const orphanUuid = runnerUuid(141);
  const firstVariant = cloudflareInstance({
    uuid: ambiguousUuid,
    id: "1".repeat(64),
    location: "wnam01",
  });
  const secondVariant = { ...firstVariant, location: "weur02" };
  const orphanInstance = cloudflareInstance({
    uuid: orphanUuid,
    id: "2".repeat(64),
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage(
        [firstVariant, orphanInstance],
        { nextPageToken: "second" },
      ),
      second: instancePage([secondVariant]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid: orphanUuid })]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const ambiguous = outputByType(result, "ambiguous-instance");
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].sandboxId, firstVariant.name);
  assert.equal(ambiguous[0].instanceId, firstVariant.id);
  assert.equal(ambiguous[0].reason, "conflicting-instance-records");
  assert.deepEqual(ambiguous[0].conflictingFields, ["location"]);
  assert.deepEqual(
    new Set(ambiguous[0].variants.map((variant) => JSON.stringify(variant))),
    new Set([firstVariant, secondVariant].map((variant) => JSON.stringify(variant))),
  );
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].sandboxId, orphanInstance.name);
  assert.deepEqual(
    jsonLines(result.stdout).map((record) => record.type),
    ["ambiguous-instance", "orphan", "summary"],
  );
  assertSummary(result, {
    orphanCount: 1,
    ambiguousInstanceCount: 1,
    findingCount: 2,
  });
});

test("an ambiguous-only report exits with a finding status", () => {
  const uuid = runnerUuid(149);
  const firstVariant = cloudflareInstance({
    uuid,
    id: "b".repeat(64),
    location: "wnam01",
  });
  const inactiveInstance = cloudflareInstance({
    uuid: runnerUuid(150),
    id: "c".repeat(64),
    state: "inactive",
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage(
        [firstVariant, inactiveInstance],
        { nextPageToken: "second" },
      ),
      second: instancePage([{ ...firstVariant, location: "weur02" }]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(outputByType(result, "ambiguous-instance").length, 1);
  assert.equal(outputByType(result, "orphan").length, 0);
  assertSummary(result, {
    orphanCount: 0,
    ambiguousInstanceCount: 1,
    findingCount: 1,
  });
  assert.match(
    result.stderr,
    /1 ambiguous instance record\(s\) and 0 orphan record\(s\)/u,
  );
});

test("a quarantined instance is never destroyed", () => {
  const ambiguousUuid = runnerUuid(142);
  const orphanUuid = runnerUuid(143);
  const firstVariant = cloudflareInstance({
    uuid: ambiguousUuid,
    id: "3".repeat(64),
    location: "wnam01",
  });
  const orphanInstance = cloudflareInstance({
    uuid: orphanUuid,
    id: "4".repeat(64),
  });
  const result = runAudit({
    args: ["--json", "--destroy"],
    expectedDeleteUrl: deleteUrl(orphanUuid),
    instancePages: {
      initial: instancePage(
        [firstVariant, orphanInstance],
        { nextPageToken: "second" },
      ),
      second: instancePage([{ ...firstVariant, location: "weur02" }]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid: orphanUuid })]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(deleteRequestCount(result.commandLog), 1);
  assert.equal(reclaimRequestCount(result.commandLog), 0);
  const cleanupLines = result.commandLog
    .split("\n")
    .filter((line) => line.startsWith("curl-delete ") ||
      line.startsWith("curl-reclaim "));
  assert.equal(cleanupLines.some((line) => line.includes(firstVariant.name)), false);
  assertSummary(result, {
    orphanCount: 1,
    ambiguousInstanceCount: 1,
    findingCount: 2,
    destroyScheduledCount: 1,
  });
});

test("a quarantined sandbox never enters the reverse reclaim pass", () => {
  const uuid = runnerUuid(144);
  const firstVariant = cloudflareInstance({
    uuid,
    id: "5".repeat(64),
    location: "wnam01",
  });
  const inactiveInstance = cloudflareInstance({
    uuid: runnerUuid(148),
    id: "6".repeat(64),
    state: "inactive",
  });
  const result = runAudit({
    args: ["--json", "--destroy"],
    instancePages: {
      initial: instancePage(
        [firstVariant, inactiveInstance],
        { nextPageToken: "second" },
      ),
      second: instancePage([{ ...firstVariant, location: "weur02" }]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(outputByType(result, "ambiguous-instance").length, 1);
  assert.equal(outputByType(result, "orphan").length, 0);
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assert.equal(reclaimRequestCount(result.commandLog), 0);
  assertSummary(result, {
    orphanCount: 0,
    ambiguousInstanceCount: 1,
    findingCount: 1,
  });
});

test("replays live run 32992299549 and PR 57 conflicts deterministically", () => {
  const locationUuid = runnerUuid(145);
  const stateUuid = runnerUuid(146);
  const unrelatedUuid = runnerUuid(147);
  const locationConflictId =
    "13669d1643d50d022d9e28e1ab13670f3a4294958f2da0d5a607d2f6b519b9f8";
  const stateConflictId =
    "7072a050fa3dc3dc2fe5d02f8ffb5f0e91a250f28208db938982ef215edf41dd";
  const locationInstance = cloudflareInstance({
    uuid: locationUuid,
    id: locationConflictId,
    location: "wnam01",
  });
  const stateInstance = cloudflareInstance({
    uuid: stateUuid,
    id: stateConflictId,
    state: "running",
  });
  const unrelatedInstance = cloudflareInstance({
    uuid: unrelatedUuid,
    id: "f".repeat(64),
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage(
        [locationInstance, stateInstance, unrelatedInstance],
        { nextPageToken: "second" },
      ),
      second: instancePage([
        { ...locationInstance, location: "weur02" },
        { ...stateInstance, state: "inactive" },
      ]),
    },
    registryPages: {
      initial: registryPage([
        registryRow({ uuid: stateUuid }),
        registryRow({ uuid: unrelatedUuid }),
      ]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const ambiguous = outputByType(result, "ambiguous-instance");
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].instanceId, locationConflictId);
  assert.deepEqual(ambiguous[0].conflictingFields, ["location"]);
  const orphans = outputByType(result, "orphan");
  assert.deepEqual(
    orphans.map((orphan) => [orphan.instanceId, orphan.state]),
    [
      [stateConflictId, "running"],
      [unrelatedInstance.id, "running"],
    ],
  );
  assertSummary(result, {
    orphanCount: 2,
    ambiguousInstanceCount: 1,
    findingCount: 3,
  });
});

test("rejects conflicting names for one Cloudflare id across pages", () => {
  const uuid = runnerUuid(47);
  const instance = cloudflareInstance({ uuid });
  const inactive = cloudflareInstance({
    uuid: runnerUuid(48),
    state: "inactive",
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage(
        [instance, inactive],
        { nextPageToken: "second" },
      ),
      second: instancePage([
        { ...instance, name: `runner-${runnerUuid(49)}` },
      ]),
    },
  });

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    new RegExp(`id "${instance.id}".*field "name"`),
  );
});

test("keeps the earliest created value across Cloudflare pages", () => {
  const uuid = runnerUuid(6);
  const earlierCreated = "2026-08-20T23:24:30Z";
  const instance = cloudflareInstance({ uuid });
  const earlierInstance = { ...instance, created: earlierCreated };
  const inactive = cloudflareInstance({
    uuid: runnerUuid(60),
    state: "inactive",
  });
  const result = runAudit({
    instancePages: {
      initial: instancePage(
        [earlierInstance, inactive],
        { nextPageToken: "second" },
      ),
      second: instancePage([instance]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].cloudflareCreated, earlierCreated);
  assertSummary(result, { orphanCount: 1 });
});

test("rejects different Cloudflare ids that share one name", () => {
  const uuid = runnerUuid(7);
  const first = cloudflareInstance({ uuid, id: "1".repeat(64) });
  const second = cloudflareInstance({ uuid, id: "2".repeat(64) });
  const result = runAudit({
    instancePages: {
      initial: instancePage([second, first]),
    },
  });

  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    new RegExp(
      `duplicate Cloudflare instance name "runner-${uuid}" has conflicting ids ` +
      `\\["${first.id}","${second.id}"\\]`,
    ),
  );
});

test("streams large paginated data without losing observable rows", () => {
  const sentinelUuids = Array.from({ length: 5 }, (_, index) =>
    runnerUuid(1_000 + index));
  const sentinelInstanceOffsets = [24, 49, 74, 99, 120];
  const instanceRows = Array.from({ length: 121 }, (_, index) => {
    const sentinelIndex = sentinelInstanceOffsets.indexOf(index);
    return cloudflareInstance({
      uuid: sentinelIndex === -1
        ? runnerUuid(2_000 + index)
        : sentinelUuids[sentinelIndex],
      state: sentinelIndex === -1 ? "inactive" : "running",
      payload: "i".repeat(1_100),
    });
  });
  const registryRows = Array.from({ length: 25 }, (_, index) =>
    registryRow({
      sandbox: `runner-retained-${index}`,
      state: "destroyed",
      payload: "r".repeat(6_000),
    }));
  for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
    const sentinelIndex = (pageIndex + 1) % 5;
    registryRows[(pageIndex * 5) + 4] = registryRow({
      uuid: sentinelUuids[sentinelIndex],
      state: sentinelIndex === 3 ? "destroyed" : "online",
      revision: sentinelIndex === 3 ? 2 : 0,
      payload: "r".repeat(6_000),
    });
  }
  assert.ok(Buffer.byteLength(JSON.stringify(instanceRows)) > 131_072);
  assert.ok(Buffer.byteLength(JSON.stringify(registryRows)) > 131_072);

  const instancePages = {};
  for (let offset = 0; offset < instanceRows.length; offset += 25) {
    const pageIndex = offset / 25;
    const token = pageIndex === 0 ? "initial" : `instance-${pageIndex}`;
    const nextPageToken = offset + 25 < instanceRows.length
      ? `instance-${pageIndex + 1}`
      : null;
    instancePages[token] = instancePage(
      instanceRows.slice(offset, offset + 25),
      { nextPageToken },
    );
  }
  const registryPages = {};
  for (let offset = 0; offset < registryRows.length; offset += 5) {
    const pageIndex = offset / 5;
    const cursor = pageIndex === 0 ? "initial" : `registry-${pageIndex}`;
    const nextCursor = offset + 5 < registryRows.length
      ? `registry-${pageIndex + 1}`
      : null;
    registryPages[cursor] = registryPage(
      registryRows.slice(offset, offset + 5),
      nextCursor,
    );
  }

  const result = runAudit({ instancePages, registryPages });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    outputByType(result, "orphan"),
    sentinelUuids.map((uuid, index) => ({
      sandboxId: `runner-${uuid}`,
      instanceId: instanceRows[sentinelInstanceOffsets[index]].id,
      uuid,
      state: "running",
      ageSeconds: 130,
      ageSource: "worker-registry",
      registryState: index === 3 ? "destroyed" : "online",
      registryCreatedAt,
      runnerName: `cloudflare-${uuid}`,
      cloudflareCreated: cloudflareCreatedAt,
      inactiveInstance: null,
      reason: index === 3 ? "terminal-registry-row" : "unregistered",
      destroyResult: "not-requested",
      destroyHttpStatus: null,
      type: "orphan",
    })),
  );
  assertSummary(result, { orphanCount: 5 });
});

test("de-duplicates a row that becomes terminal during registry pagination", () => {
  const uuid = runnerUuid(5);
  const historyRows = Array.from({ length: 5 }, (_, index) => ({
    sandboxId: `runner-history-${index}`,
    state: "destroyed",
    createdAt: registryCreatedAt,
    revision: 1,
  }));
  const result = runAudit({
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage(
        [registryRow({ uuid }), ...historyRows],
        "terminal",
      ),
      terminal: registryPage([
        registryRow({ uuid, state: "destroyed", revision: 2 }),
      ]),
    },
    githubCalls: [
      githubCall(uuid, githubResponse([githubRunner({ id: 5, uuid })])),
    ],
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].reason, "terminal-registry-row");
});

test("rejects a repeated Worker registry cursor", () => {
  const result = runAudit({
    registryPages: {
      initial: registryPage([], "repeat"),
      repeat: registryPage([], "repeat"),
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /repeated a runner registry cursor/);
});

test("rejects registry cursors outside the Worker base64url alphabet", () => {
  for (const nextCursor of ["\n", "ab\ncd"]) {
    const result = runAudit({
      registryPages: {
        initial: registryPage([], nextCursor, 100),
      },
    });

    assert.equal(result.status, 2, JSON.stringify(nextCursor));
    assert.match(result.stderr, /invalid runner registry page/);
  }
});

test("accepts a normal base64url Worker registry cursor", () => {
  const nextCursor = "YWJjLWRlZl8xMjM";
  const result = runAudit({
    registryPages: {
      initial: registryPage([
        registryRow({
          sandbox: "runner-base64url-cursor",
          state: "destroyed",
        }),
      ], nextCursor, 100),
      [nextCursor]: registryPage([], null, 100),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.commandLog, new RegExp(`^curl-registry ${nextCursor}$`, "m"));
  assertSummary(result, { orphanCount: 0 });
});

test("accepts a full Worker registry page with a next cursor", () => {
  const uuid = runnerUuid(89);
  const firstPageRows = fullRegistryRows(uuid, "full-page-history");
  const result = runAudit({
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage(firstPageRows, "short-final", registryPageSize),
      "short-final": registryPage([
        registryRow({
          sandbox: "runner-short-final-history",
          state: "destroyed",
        }),
      ], null, 100),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    outputByType(result, "orphan").map(({ uuid: foundUuid, reason }) => ({
      uuid: foundUuid,
      reason,
    })),
    [{ uuid, reason: "unregistered" }],
  );
});

test("rejects a full Worker registry page without a next cursor", () => {
  const uuid = runnerUuid(83);
  const truncatedRows = fullRegistryRows(uuid, "truncated-history");
  const result = runAudit({
    instancePages: {
      initial: instancePage([
        cloudflareInstance({ uuid: runnerUuid(84), state: "inactive" }),
      ]),
    },
    registryPages: {
      initial: registryPage(truncatedRows, null, registryPageSize),
    },
  });

  assert.equal(outputByType(result, "orphan").length, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /absent-from-cloudflare/);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /full final page had no next cursor/);
});

test("rejects a full Worker registry page without a next cursor or a page size", () => {
  const uuid = runnerUuid(87);
  const truncatedRows = fullRegistryRows(uuid, "pinned-fallback-history");
  const page = registryPage(truncatedRows, null);
  assert.equal(Object.hasOwn(page, "pageSize"), false);

  const result = runAudit({
    instancePages: {
      initial: instancePage([
        cloudflareInstance({ uuid: runnerUuid(88), state: "inactive" }),
      ]),
    },
    registryPages: {
      initial: page,
    },
  });

  assert.equal(outputByType(result, "orphan").length, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /absent-from-cloudflare/);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /full final page had no next cursor/);
});

test("rejects a fractional full Worker registry page without a cursor", () => {
  const uuid = runnerUuid(90);
  const truncatedRows = fullRegistryRows(uuid, "fractional-page-history");
  const pageBody = JSON.stringify(
    registryPage(truncatedRows, null, registryPageSize),
  ).replace(
    `"pageSize":${registryPageSize}`,
    `"pageSize":${registryPageSize}.0`,
  );
  assert.match(pageBody, /"pageSize":100\.0/);

  const result = runAudit({
    instancePages: {
      initial: instancePage([
        cloudflareInstance({ uuid: runnerUuid(91), state: "inactive" }),
      ]),
    },
    registryPages: { initial: pageBody },
  });

  assert.equal(outputByType(result, "orphan").length, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /absent-from-cloudflare/);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /full final page had no next cursor/);
});

test("rejects a repeated Worker registry page with a new cursor", () => {
  const repeatedRows = [registryRow({
    sandbox: "runner-repeated-registry-page",
    state: "destroyed",
  })];
  const result = runAudit({
    registryPages: {
      initial: registryPage(repeatedRows, "second"),
      second: registryPage(repeatedRows, "third"),
      third: registryPage([]),
    },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /repeated a runner registry page/);
});

test("rejects a reordered repeated Worker registry page", () => {
  const first = registryRow({
    sandbox: "runner-reordered-registry-page-1",
    state: "destroyed",
  });
  const second = registryRow({
    sandbox: "runner-reordered-registry-page-2",
    state: "destroyed",
  });
  const result = runAudit({
    registryPages: {
      initial: registryPage([first, second], "reordered", 100),
      reordered: registryPage([second, first], null, 100),
    },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /repeated a runner registry page/);
});

test("rejects a Worker registry page size below the pinned size", () => {
  const uuid = runnerUuid(92);
  const result = runAudit({
    instancePages: {
      initial: instancePage([
        cloudflareInstance({ uuid: runnerUuid(93), state: "inactive" }),
      ]),
    },
    registryPages: {
      initial: registryPage([
        registryRow({ uuid }),
        ...Array.from({ length: 3 }, (_, index) => registryRow({
          sandbox: `runner-below-pin-history-${index}`,
          state: "destroyed",
        })),
      ], null, 5),
    },
  });

  assert.equal(outputByType(result, "orphan").length, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /absent-from-cloudflare/);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /invalid runner registry page/);
});

test("rejects a Worker registry page size above the pinned size", () => {
  const result = runAudit({
    registryPages: {
      initial: registryPage([], null, 101),
    },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /invalid runner registry page/);
});

test("rejects an invalid Worker registry page size", () => {
  for (const pageSize of [10.5, 0, "100", true]) {
    const result = runAudit({
      registryPages: {
        initial: registryPage([], null, pageSize),
      },
    });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /invalid runner registry page/);
  }
});

test("rejects more Worker registry rows than the applied page size", () => {
  const result = runAudit({
    registryPages: {
      initial: registryPage(
        Array.from({ length: 101 }, (_, index) => registryRow({
          sandbox: `runner-registry-page-overflow-${index}`,
          state: "destroyed",
        })),
        null,
        100,
      ),
    },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /invalid runner registry page/);
});

test("accepts an explicit null Worker registry page size", () => {
  const page = registryPage([], null, null);
  assert.equal(Object.hasOwn(page, "pageSize"), true);
  assert.equal(page.pageSize, null);

  const result = runAudit({
    registryPages: { initial: page },
  });

  assert.equal(result.status, 0, result.stderr);
  assertSummary(result, { orphanCount: 0 });
});

test("rejects a multi-document Worker registry response", () => {
  const registryBody = [
    registryPage([], null, 100),
    registryPage([
      registryRow({
        sandbox: "runner-second-json-document",
        state: "destroyed",
      }),
    ], null, 100),
  ].map((page) => JSON.stringify(page)).join("");
  const result = runAudit({
    registryPages: { initial: registryBody },
  });

  assert.equal(outputByType(result, "orphan").length, 0, result.stdout);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /invalid runner registry page/);
});

test("accepts multi-page deployed Worker responses without pageSize", () => {
  const firstUuid = runnerUuid(85);
  const secondUuid = runnerUuid(86);
  const registryPages = {
    initial: registryPage([registryRow({ uuid: firstUuid })], "second"),
    second: registryPage([
      registryRow({ uuid: secondUuid, state: "destroyed" }),
    ]),
  };
  assert.equal(Object.hasOwn(registryPages.initial, "pageSize"), false);
  assert.equal(Object.hasOwn(registryPages.second, "pageSize"), false);

  const result = runAudit({
    instancePages: {
      initial: instancePage([
        cloudflareInstance({ uuid: firstUuid }),
        cloudflareInstance({ uuid: secondUuid }),
      ]),
    },
    registryPages,
  });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    outputByType(result, "orphan").map(({ uuid, reason }) => ({
      uuid,
      reason,
    })),
    [
      { uuid: firstUuid, reason: "unregistered" },
      { uuid: secondUuid, reason: "terminal-registry-row" },
    ],
  );
});

test("pins the audit registry page size to the Worker page size", () => {
  const auditSource = readFileSync(auditScript, "utf8");
  const runnerPolicySource = readFileSync(
    join(repositoryRoot, "src/runner-policy.js"),
    "utf8",
  );
  const auditPageSizes = [
    ...auditSource.matchAll(/^registry_page_size=(\d+)$/gm),
  ];
  const workerPageSize = runnerPolicySource.match(
    /^export const RUNNER_LIST_PAGE_SIZE = (\d+);$/m,
  );

  assert.equal(
    auditPageSizes.length,
    1,
    "orphan-audit.sh must assign registry_page_size exactly once",
  );
  assert.ok(
    workerPageSize,
    "src/runner-policy.js must define RUNNER_LIST_PAGE_SIZE",
  );
  assert.equal(auditPageSizes[0][1], workerPageSize[1]);
});

test("keeps runner endpoint literals inside scope resolution [mutation: hardcode a runner endpoint]", () => {
  const source = readFileSync(auditScript, "utf8");
  const functionStart = source.indexOf("resolve_github_runner_scope() {");
  const functionEnd = source.indexOf("\n}\n\ngithub_runner_scope=", functionStart);

  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);
  const sourceOutsideResolver = source.slice(0, functionStart)
    + source.slice(functionEnd + 3);
  assert.doesNotMatch(
    sourceOutsideResolver,
    /\b(?:repos|orgs)\/[^\s"'\\]*\/actions\/runners\b/,
  );
});

test("queries an authoritative registry name and recognizes its registration", () => {
  const uuid = runnerUuid(136);
  const authoritativeName = "cloudflare-1-4503599627370518";
  const result = runAudit({
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({
        uuid,
        githubRunnerName: authoritativeName,
      })]),
    },
    githubCalls: [
      githubCall(
        uuid,
        githubResponse([githubRunner({
          id: 136,
          uuid,
          githubRunnerName: authoritativeName,
        })]),
        null,
        authoritativeName,
      ),
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputByType(result, "orphan").length, 0);
  assert.match(
    result.commandLog,
    new RegExp(`^gh-query ${authoritativeName}$`, "m"),
  );
  assert.doesNotMatch(result.stdout, /"reason":"unregistered"/);
});

test("queries the UUID-derived name for a sandbox without a registry row", () => {
  const uuid = runnerUuid(137);
  const derivedName = `cloudflare-${uuid}`;
  const result = runAudit({
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    githubCalls: [githubCall(uuid)],
  });

  assert.equal(result.status, 1, result.stderr);
  const orphans = outputByType(result, "orphan");
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].reason, "absent-from-registry");
  assert.equal(orphans[0].runnerName, derivedName);
  assert.match(
    result.commandLog,
    new RegExp(`^gh-query ${derivedName}$`, "m"),
  );
});

test("posts the authoritative name in an absent-from-cloudflare reclaim", () => {
  const uuid = runnerUuid(138);
  const revision = 11;
  const authoritativeName = "cloudflare-2-4503599627370520";
  const result = runAudit({
    args: ["--json", "--destroy"],
    expectedReclaimUrl: reclaimUrl(uuid),
    registryPages: {
      initial: registryPage([registryRow({
        uuid,
        state: "destroying",
        revision,
        githubRunnerName: authoritativeName,
      })]),
    },
    githubCalls: [
      githubCall(uuid, undefined, null, authoritativeName),
      githubCall(uuid, undefined, null, authoritativeName),
    ],
    environment: {
      STUB_DESTROY_BODY: JSON.stringify({
        outcome: "absence-recorded",
        sandboxId: `runner-${uuid}`,
        revision,
        reclaimableAtMs: 1_800_000_000_000,
      }),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(outputByType(result, "orphan")[0].runnerName, authoritativeName);
  assert.equal(result.reclaimRequests.length, 1);
  assert.equal(
    result.reclaimRequests[0].observedRegistration.runnerName,
    authoritativeName,
  );
  assert.equal(
    result.commandLog.match(new RegExp(`^gh-query ${authoritativeName}$`, "gm"))
      ?.length,
    2,
  );
});

test("rechecks the authoritative name immediately before destroy", () => {
  const uuid = runnerUuid(139);
  const authoritativeName = "cloudflare-1-4503599627370518";
  const result = runAudit({
    args: ["--json", "--destroy"],
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({
        uuid,
        githubRunnerName: authoritativeName,
      })]),
    },
    githubCalls: [
      githubCall(uuid, undefined, null, authoritativeName),
      githubCall(
        uuid,
        githubResponse([githubRunner({
          id: 139,
          uuid,
          githubRunnerName: authoritativeName,
        })]),
        null,
        authoritativeName,
      ),
    ],
  });

  assert.equal(result.status, 1, result.stderr);
  const orphan = outputByType(result, "orphan")[0];
  assert.equal(orphan.reason, "unregistered");
  assert.equal(orphan.runnerName, authoritativeName);
  assert.equal(orphan.destroyResult, "skipped-now-registered");
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assert.equal(
    result.commandLog.match(new RegExp(`^gh-query ${authoritativeName}$`, "gm"))
      ?.length,
    2,
  );
});

test("finds a healthy runner through an exact-name GitHub query", () => {
  const uuid = runnerUuid(72);
  const result = runAudit({
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    githubCalls: [
      githubCall(
        uuid,
        githubResponse([githubRunner({ id: 101, uuid })]),
      ),
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(outputByType(result, "orphan").length, 0);
  assert.match(result.commandLog, new RegExp(`^gh-query cloudflare-${uuid}$`, "m"));
  assert.doesNotMatch(result.commandLog, /--paginate|--slurp/);
});

test("rejects malformed, ambiguous, and non-exact GitHub query results", () => {
  const uuid = runnerUuid(73);
  const first = githubRunner({ id: 1, uuid });
  const second = githubRunner({ id: 2, uuid });
  const cases = [
    githubResponse([], 1),
    githubResponse([{ ...first, name: 42 }]),
    githubResponse([first, second], 2),
    githubResponse([
      githubRunner({ id: 3, name: `other-cloudflare-${uuid}` }),
    ]),
  ];

  for (const response of cases) {
    const result = runAudit({
      instancePages: {
        initial: instancePage([cloudflareInstance({ uuid })]),
      },
      registryPages: {
        initial: registryPage([registryRow({ uuid })]),
      },
      githubCalls: [githubCall(uuid, response)],
    });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /invalid or ambiguous data/);
  }
});

test("maps a failed exact-name GitHub query to operational exit code 2", () => {
  const uuid = runnerUuid(75);
  const result = runAudit({
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    githubCalls: [githubCall(uuid, githubResponse([]), 9)],
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /could not be queried/);
});

test("requires the operator route for absent rows without sending a request", () => {
  for (const [index, args] of [
    [6, ["--json", "--destroy"]],
    [7, ["--json", "--destroy", "--destroy-unknown-age"]],
  ]) {
    const uuid = runnerUuid(index);
    const instance = cloudflareInstance({ uuid });
    const result = runAudit({
      args,
      instancePages: {
        initial: instancePage([instance]),
      },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      outputByType(result, "orphan")[0].destroyResult,
      "operator-route-required",
    );
    assert.equal(deleteRequestCount(result.commandLog), 0);
    assert.equal(reclaimRequestCount(result.commandLog), 0);
    assert.match(
      result.stderr,
      /POST \/operator\/orphans\/<sandboxId>\/destroy/,
    );
    assert.match(result.stderr, /observedSandboxInstanceId=/);
    assert.ok(result.stderr.includes(instance.id));
    assertSummary(result, {
      orphanCount: 1,
      destroyOperatorRequiredCount: 1,
    });
  }
});

test("requires the operator route for a terminal row without sending a request", () => {
  const uuid = runnerUuid(71);
  const instance = cloudflareInstance({ uuid });
  const result = runAudit({
    args: ["--json", "--destroy"],
    instancePages: {
      initial: instancePage([instance]),
    },
    registryPages: {
      initial: registryPage([
        registryRow({ uuid, state: "destroyed", revision: 2 }),
      ]),
    },
    githubCalls: [
      githubCall(uuid, githubResponse([githubRunner({ id: 71, uuid })])),
    ],
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    outputByType(result, "orphan")[0].destroyResult,
    "operator-route-required",
  );
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assert.equal(reclaimRequestCount(result.commandLog), 0);
  assert.match(
    result.stderr,
    /POST \/operator\/orphans\/<sandboxId>\/destroy/,
  );
  assert.match(result.stderr, /observedSandboxInstanceId=/);
  assert.ok(result.stderr.includes(instance.id));
  assertSummary(result, {
    orphanCount: 1,
    destroyOperatorRequiredCount: 1,
  });
});

test("reports the operator-route requirement in the non-JSON summary", () => {
  const uuid = runnerUuid(72);
  const result = runAudit({
    args: ["--destroy"],
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assert.match(
    result.stdout,
    /^runner_scope\trepository:owner\/repository$/m,
  );
  assert.match(result.stdout, /^instance_page_count\t1$/m);
  assert.match(
    result.stdout,
    /^instance_boundary_confirmation_count\t0$/m,
  );
  assert.match(result.stdout, /^instance_row_count\t1$/m);
  assert.match(result.stdout, /^instance_count\t1$/m);
  assert.match(result.stdout, /^live_instance_count\t1$/m);
  assert.match(result.stdout, /^instance_pagination\texhausted$/m);
  assert.match(
    result.stdout,
    /^destroy_operator_required_count\t1$/m,
  );
  assert.match(result.stderr, /required 1 manual operator-route request/);
  assert.match(result.stderr, /runner scope repository:owner\/repository/);
});

test("continues after cleanup-token preparation fails", () => {
  const uuid = runnerUuid(8);
  const result = runAudit({
    args: ["--json", "--destroy"],
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    environment: { STUB_NODE_TOKEN_FAILURE: "true" },
  });

  assert.equal(result.status, 3, result.stderr);
  assert.equal(
    outputByType(result, "orphan")[0].destroyResult,
    "cleanup-token-preparation-failed",
  );
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assertSummary(result, {
    orphanCount: 1,
    destroyScheduledCount: 0,
    destroyFailureCount: 1,
    destroySkippedCount: 0,
  });
});

test("continues after sandbox ID encoding fails", () => {
  const uuid = runnerUuid(9);
  const result = runAudit({
    args: ["--json", "--destroy"],
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    environment: { STUB_JQ_URI_FAILURE: "true" },
  });

  assert.equal(result.status, 3, result.stderr);
  assert.equal(
    outputByType(result, "orphan")[0].destroyResult,
    "sandbox-id-encoding-failed",
  );
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assertSummary(result, {
    orphanCount: 1,
    destroyScheduledCount: 0,
    destroyFailureCount: 1,
    destroySkippedCount: 0,
  });
});

test("names HTTP 204, 404, and 409 cleanup failures", () => {
  const cases = [
    {
      status: "204",
      result: "already-destroyed-inconsistent",
      message: /already-destroyed row for a live instance/,
    },
    {
      status: "404",
      result: "callback-row-not-found",
      message: /callback route found no registry row/,
    },
    {
      status: "409",
      result: "cleanup-unschedulable",
      message: /could not be scheduled for the current registry state/,
    },
  ];

  for (const testCase of cases) {
    const uuid = runnerUuid(Number(testCase.status));
    const result = runAudit({
      args: ["--json", "--destroy"],
      expectedDeleteUrl: deleteUrl(uuid),
      instancePages: {
        initial: instancePage([cloudflareInstance({ uuid })]),
      },
      registryPages: {
        initial: registryPage([registryRow({ uuid })]),
      },
      environment: {
        STUB_DESTROY_STATUS: testCase.status,
        STUB_DESTROY_BODY: '{"error":"stub cleanup conflict"}',
      },
    });

    assert.equal(result.status, 3, result.stderr);
    assert.equal(outputByType(result, "orphan")[0].destroyResult, testCase.result);
    assert.match(result.stderr, testCase.message);
    assert.equal(
      result.stderr.match(/stub cleanup conflict/g)?.length,
      1,
    );
    assertSummary(result, {
      orphanCount: 1,
      destroyScheduledCount: 0,
      destroyFailureCount: 1,
      destroySkippedCount: 0,
    });
  }
});

test("classifies accepted cleanup states without printing success bodies", () => {
  const cases = [
    {
      response: { cleanupStatus: "scheduled" },
      destroyResult: "cleanup-scheduled",
      summary: { destroyScheduledCount: 1 },
    },
    {
      response: {
        cleanupStatus: "already-scheduled",
        cleanupAttempts: 0,
      },
      destroyResult: "cleanup-already-scheduled",
      summary: { destroyAlreadyScheduledCount: 1 },
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const uuid = runnerUuid(index === 0 ? 76 : 79);
    const responseBody = JSON.stringify(testCase.response);
    const result = runAudit({
      args: ["--json", "--destroy"],
      expectedDeleteUrl: deleteUrl(uuid),
      instancePages: {
        initial: instancePage([cloudflareInstance({ uuid })]),
      },
      registryPages: {
        initial: registryPage([registryRow({ uuid })]),
      },
      environment: {
        STUB_DESTROY_BODY: responseBody,
      },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      outputByType(result, "orphan")[0].destroyResult,
      testCase.destroyResult,
    );
    assert.equal(deleteRequestCount(result.commandLog), 1);
    assert.ok(!result.stderr.includes(responseBody));
    assertSummary(result, {
      orphanCount: 1,
      ...testCase.summary,
    });
  }
});

test("maps all accepted cleanup states to honest counters [mutation: merge accepted counters]", () => {
  const cases = [
    {
      response: { cleanupStatus: "scheduled" },
      destroyResult: "cleanup-scheduled",
      status: 1,
      summary: { destroyScheduledCount: 1 },
    },
    {
      response: { cleanupStatus: "rearmed", cleanupAttempts: 10 },
      destroyResult: "cleanup-rearmed",
      status: 1,
      summary: { destroyScheduledCount: 1 },
    },
    {
      response: {
        cleanupStatus: "already-scheduled",
        cleanupAttempts: 0,
      },
      destroyResult: "cleanup-already-scheduled",
      status: 1,
      summary: { destroyAlreadyScheduledCount: 1 },
    },
    {
      response: {
        cleanupStatus: "already-scheduled",
        cleanupAttempts: 3,
      },
      destroyResult: "cleanup-retrying",
      status: 3,
      summary: { destroyFailureCount: 1 },
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const uuid = runnerUuid(90 + index);
    const responseBody = JSON.stringify(testCase.response);
    const result = runAudit({
      args: ["--json", "--destroy"],
      expectedDeleteUrl: deleteUrl(uuid),
      instancePages: {
        initial: instancePage([cloudflareInstance({ uuid })]),
      },
      registryPages: {
        initial: registryPage([registryRow({ uuid })]),
      },
      environment: { STUB_DESTROY_BODY: responseBody },
    });

    assert.equal(result.status, testCase.status, result.stderr);
    assert.equal(
      outputByType(result, "orphan")[0].destroyResult,
      testCase.destroyResult,
    );
    assert.equal(deleteRequestCount(result.commandLog), 1);
    assert.ok(!result.stderr.includes(responseBody));
    assertSummary(result, {
      orphanCount: 1,
      ...testCase.summary,
    });
  }
});

test("rejects and prints an invalid HTTP 202 cleanup response", () => {
  const uuid = runnerUuid(80);
  const responseBody = '{"unexpected":true}';
  const result = runAudit({
    args: ["--json", "--destroy"],
    expectedDeleteUrl: deleteUrl(uuid),
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    environment: { STUB_DESTROY_BODY: responseBody },
  });

  assert.equal(result.status, 3, result.stderr);
  assert.equal(
    outputByType(result, "orphan")[0].destroyResult,
    "invalid-cleanup-response",
  );
  assert.equal(result.stderr.match(/"unexpected":true/g)?.length, 1);
  assertSummary(result, {
    orphanCount: 1,
    destroyFailureCount: 1,
  });
});

test("skips cleanup when the runner registers after selection", () => {
  const uuid = runnerUuid(77);
  const result = runAudit({
    args: ["--json", "--destroy"],
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    githubCalls: [
      githubCall(uuid),
      githubCall(uuid, githubResponse([githubRunner({ id: 77, uuid })])),
    ],
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    outputByType(result, "orphan")[0].destroyResult,
    "skipped-now-registered",
  );
  assert.equal(deleteRequestCount(result.commandLog), 0);
  assert.match(result.stderr, /registered after selection/);
  assertSummary(result, {
    orphanCount: 1,
    destroyRegisteredSkipCount: 1,
  });
});

test("fails closed when the pre-destroy GitHub recheck fails", () => {
  const uuid = runnerUuid(78);
  const cases = [
    {
      name: "command failure",
      recheck: githubCall(uuid, githubResponse([]), 9),
      message: /could not be queried/,
    },
    {
      name: "malformed response",
      recheck: githubCall(uuid, { total_count: 0, runners: "invalid" }),
      message: /invalid or ambiguous data/,
    },
  ];

  for (const testCase of cases) {
    const result = runAudit({
      args: ["--json", "--destroy"],
      instancePages: {
        initial: instancePage([cloudflareInstance({ uuid })]),
      },
      registryPages: {
        initial: registryPage([registryRow({ uuid })]),
      },
      githubCalls: [githubCall(uuid), testCase.recheck],
    });

    assert.equal(result.status, 2, `${testCase.name}: ${result.stderr}`);
    assert.equal(deleteRequestCount(result.commandLog), 0, testCase.name);
    assert.match(result.stderr, testCase.message, testCase.name);
  }
});

test("reports a failed destroy request with exit 3 and final counters", () => {
  const uuid = runnerUuid(10);
  const result = runAudit({
    args: ["--json", "--destroy"],
    expectedDeleteUrl: deleteUrl(uuid),
    instancePages: {
      initial: instancePage([cloudflareInstance({ uuid })]),
    },
    registryPages: {
      initial: registryPage([registryRow({ uuid })]),
    },
    environment: { STUB_DESTROY_CURL_EXIT: "7" },
  });

  assert.equal(result.status, 3, result.stderr);
  assert.equal(outputByType(result, "orphan")[0].destroyResult, "request-failed");
  assertSummary(result, {
    orphanCount: 1,
    destroyScheduledCount: 0,
    destroyFailureCount: 1,
    destroySkippedCount: 0,
  });
});

test("rejects a grace value with a JSON-invalid leading zero", () => {
  const result = runAudit({
    environment: { ORPHAN_GRACE_SECONDS: "060" },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /without leading zeros/);
  assert.doesNotMatch(result.stderr, /invalid orphan audit data/);
});

test("maps a native date failure to operational exit code 2", () => {
  const result = runAudit({
    environment: { STUB_DATE_EXIT: "9" },
  });

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /audit time could not be read/);
});
