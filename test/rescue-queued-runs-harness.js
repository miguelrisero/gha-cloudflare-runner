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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const repository = "owner/repository";
export const rescueWorkflow = "queued-run-rescue.yml";
export const rescueCommit = "a".repeat(40);
export const rescueRunName =
  "Queued run rescue [${{ inputs.source_repository_id }}/" +
  "${{ inputs.source_workflow_id }}/${{ inputs.source_run_id }}/" +
  "${{ inputs.source_run_attempt }}]";
export const sourceRunId = 300;
export const dispatchCommand =
  `POST repos/${repository}/actions/workflows/${rescueWorkflow}/dispatches`;
export const cancelCommand =
  `POST repos/${repository}/actions/runs/${sourceRunId}/cancel`;

const rescueScript = join(repositoryRoot, "scripts/rescue-queued-runs.sh");
const rescueRef = "rescue-ref";
const repositoryId = 100;
const workflowId = 200;
const sourceJobId = 400;
const replacementRunId = 500;

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

function writeExecutable(directory, name, source) {
  const path = join(directory, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function githubCall(method, path, response) {
  return { method, path, response, exitCode: 0 };
}

function workflowContent(runsOn, runName) {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(
      `run-name: ${runName}\n\njobs:\n  rescue:\n    runs-on: ${runsOn}\n`,
    ).toString("base64"),
  };
}

export function sourceRun({
  runId = sourceRunId,
  workflow = workflowId,
  runAttempt = 1,
  status = "queued",
  jobId = sourceJobId,
  replacementId = replacementRunId,
} = {}) {
  return {
    repository,
    repositoryId,
    workflowId: workflow,
    runId,
    runAttempt,
    status,
    jobId,
    replacementId,
  };
}

export function sourceJobLedgerRow(run) {
  return {
    record_type: "source_job",
    recorded_at: "2026-08-21T00:00:00Z",
    repository: run.repository,
    repository_id: run.repositoryId,
    workflow_id: run.workflowId,
    run_id: run.runId,
    run_attempt: run.runAttempt,
    run_status: run.status,
    job_id: run.jobId,
    job_name: `affected job ${run.runId}`,
    job_status: run.status,
    labels: ["self-hosted", "cloudflare-sandbox"],
  };
}

export function replacementLedgerRow(run) {
  return {
    record_type: "replacement",
    recorded_at: "2026-08-21T00:01:00Z",
    repository: run.repository,
    repository_id: run.repositoryId,
    workflow_id: run.workflowId,
    run_id: run.runId,
    run_attempt: run.runAttempt,
    replacement_workflow: rescueWorkflow,
    replacement_ref: rescueRef,
    replacement_commit: rescueCommit,
    replacement_run_id: run.replacementId,
    replacement_run_url:
      `https://github.test/${repository}/actions/runs/${run.replacementId}`,
  };
}

function sameSourceIdentity(row, run) {
  return row.repository_id === run.repositoryId &&
    row.workflow_id === run.workflowId &&
    row.run_id === run.runId &&
    row.run_attempt === run.runAttempt;
}

function buildGithubCalls({
  runsOn,
  runName,
  dryRun,
  sourceRuns,
  initialLedgerRows,
  failedDispatchRunIds,
}) {
  const activeRuns = sourceRuns.filter((run) =>
    run.status === "queued" || run.status === "in_progress"
  );
  const calls = [
    githubCall(
      "GET",
      `repos/${repository}/actions/runs?status=queued&per_page=100`,
      [{
        workflow_runs: sourceRuns
          .filter((run) => run.status === "queued")
          .map((run) => ({
            id: run.runId,
            workflow_id: run.workflowId,
            run_attempt: run.runAttempt,
            status: run.status,
          })),
      }],
    ),
    githubCall(
      "GET",
      `repos/${repository}/actions/runs?status=in_progress&per_page=100`,
      [{
        workflow_runs: sourceRuns
          .filter((run) => run.status === "in_progress")
          .map((run) => ({
            id: run.runId,
            workflow_id: run.workflowId,
            run_attempt: run.runAttempt,
            status: run.status,
          })),
      }],
    ),
    githubCall("GET", `repos/${repository}`, { id: repositoryId }),
    ...activeRuns.map((run) => githubCall(
      "GET",
      `repos/${repository}/actions/runs/${run.runId}` +
        `/attempts/${run.runAttempt}/jobs?filter=all&per_page=100`,
      [{
        jobs: [{
          id: run.jobId,
          name: `affected job ${run.runId}`,
          status: "queued",
          labels: ["self-hosted", "cloudflare-sandbox"],
        }],
      }],
    )),
  ];
  const prepareCalls = [
    githubCall("GET", `repos/${repository}/commits`, [{ sha: rescueCommit }]),
    githubCall(
      "GET",
      `repos/${repository}/contents/.github/workflows/${rescueWorkflow}`,
      workflowContent(runsOn, runName),
    ),
  ];

  if (dryRun) {
    return activeRuns.length === 0 ? calls : [...calls, ...prepareCalls];
  }

  const cancellationCalls = activeRuns.flatMap((run) => [
    githubCall(
      "POST",
      `repos/${repository}/actions/runs/${run.runId}/cancel`,
      {},
    ),
    githubCall(
      "GET",
      `repos/${repository}/actions/runs/${run.runId}`,
      { status: "completed", conclusion: "cancelled" },
    ),
  ]);
  const dispatchRuns = sourceRuns.filter((run) => {
    const sourceExists = activeRuns.includes(run) || initialLedgerRows.some((row) =>
      row.record_type === "source_job" && sameSourceIdentity(row, run)
    );
    const replacementExists = initialLedgerRows.some((row) =>
      row.record_type === "replacement" && sameSourceIdentity(row, run)
    );
    return sourceExists && !replacementExists;
  });
  const dispatchCalls = dispatchRuns.flatMap((run) => {
    const runIdentity =
      `${run.repositoryId}/${run.workflowId}/${run.runId}/${run.runAttempt}`;
    const dispatchCall = githubCall(
      "POST",
      dispatchCommand.slice("POST ".length),
      {},
    );
    if (failedDispatchRunIds.includes(run.runId)) {
      dispatchCall.exitCode = 1;
    }
    return [
      githubCall(
        "GET",
        `repos/${repository}/actions/workflows/${rescueWorkflow}` +
          "/runs?event=workflow_dispatch&per_page=100",
        [{ workflow_runs: [] }],
      ),
      githubCall("GET", `repos/${repository}/commits`, [{ sha: rescueCommit }]),
      dispatchCall,
      ...(dispatchCall.exitCode === 0
        ? [githubCall(
          "GET",
          `repos/${repository}/actions/workflows/${rescueWorkflow}` +
            "/runs?event=workflow_dispatch&per_page=100",
          {
            workflow_runs: [{
              display_title: `Queued run rescue [${runIdentity}]`,
              head_sha: rescueCommit,
              id: run.replacementId,
              html_url: `https://github.test/${repository}/actions/runs/` +
                run.replacementId,
            }],
          },
        )]
        : []),
    ];
  });

  if (activeRuns.length === 0 && dispatchRuns.length === 0) {
    return calls;
  }
  if (runsOn !== "ubuntu-latest" || runName !== rescueRunName) {
    return [...calls, ...prepareCalls];
  }
  return [...calls, ...prepareCalls, ...cancellationCalls, ...dispatchCalls];
}

function installStubs(stubDirectory) {
  writeExecutable(stubDirectory, "gh", `#!/usr/bin/env bash
set -euo pipefail
if (($# < 1)) || [[ "$1" != api ]]; then
  echo "unexpected gh arguments: $*" >&2
  exit 64
fi
shift
method=
path=
input=
while (($# > 0)); do
  case "$1" in
    --header | --raw-field)
      if (($# < 2)); then
        echo "missing gh option value: $1" >&2
        exit 64
      fi
      shift 2
      ;;
    --method)
      if (($# < 2)) || [[ -n "$method" ]]; then
        echo "invalid gh --method arguments" >&2
        exit 64
      fi
      method=$2
      shift 2
      ;;
    --paginate | --slurp)
      shift
      ;;
    --input)
      if (($# < 2)) || [[ -n "$input" ]]; then
        echo "invalid gh --input arguments" >&2
        exit 64
      fi
      input=$2
      shift 2
      ;;
    repos/*)
      if [[ -n "$path" ]]; then
        echo "duplicate gh path" >&2
        exit 64
      fi
      path=$1
      shift
      ;;
    *)
      echo "unexpected gh option: $1" >&2
      exit 64
      ;;
  esac
done
if [[ -z "$method" || -z "$path" ]]; then
  echo "missing gh method or path" >&2
  exit 64
fi
printf '%s %s\n' "$method" "$path" >>"$STUB_COMMAND_LOG"
if [[ "$input" == - ]]; then
  request_body=$(cat)
  printf 'INPUT %s\n' "$request_body" >>"$STUB_COMMAND_LOG"
elif [[ -n "$input" ]]; then
  echo "unexpected gh input: $input" >&2
  exit 64
fi
call_index=$(<"$STUB_GITHUB_CALL_COUNT")
call_count=$("$REAL_JQ_PATH" -r 'length' "$STUB_GITHUB_CALLS")
if ((call_index >= call_count)); then
  echo "unexpected extra GitHub call: $method $path" >&2
  exit 64
fi
expected_method=$("$REAL_JQ_PATH" -er --argjson index "$call_index" \
  '.[$index].method | select(type == "string")' "$STUB_GITHUB_CALLS")
expected_path=$("$REAL_JQ_PATH" -er --argjson index "$call_index" \
  '.[$index].path | select(type == "string")' "$STUB_GITHUB_CALLS")
if [[ "$method" != "$expected_method" || "$path" != "$expected_path" ]]; then
  echo "expected GitHub call $expected_method $expected_path" >&2
  echo "received GitHub call $method $path" >&2
  exit 64
fi
printf '%d\n' "$((call_index + 1))" >"$STUB_GITHUB_CALL_COUNT"
expected_exit_code=$("$REAL_JQ_PATH" -er --argjson index "$call_index" \
  '.[$index].exitCode | select(type == "number")' "$STUB_GITHUB_CALLS")
if ((expected_exit_code != 0)); then
  exit "$expected_exit_code"
fi
"$REAL_JQ_PATH" -c --argjson index "$call_index" \
  '.[$index].response' "$STUB_GITHUB_CALLS"
`);

  writeExecutable(stubDirectory, "date", `#!/usr/bin/env bash
set -euo pipefail
printf 'date %s\n' "$*" >>"$STUB_COMMAND_LOG"
if (($# != 2)) || [[ "$1" != -u || "$2" != +%Y-%m-%dT%H:%M:%SZ ]]; then
  echo "unexpected date arguments: $*" >&2
  exit 64
fi
printf '%s\n' '2026-08-22T00:00:00Z'
`);

  writeExecutable(stubDirectory, "sleep", `#!/usr/bin/env bash
set -euo pipefail
printf 'sleep %s\n' "$*" >>"$STUB_COMMAND_LOG"
if (($# != 1)); then
  echo "unexpected sleep arguments: $*" >&2
  exit 64
fi
`);

  writeExecutable(stubDirectory, "jq", `#!/usr/bin/env bash
set -euo pipefail
printf 'jq\n' >>"$STUB_COMMAND_LOG"
exec "$REAL_JQ_PATH" "$@"
`);
}

export function runRescue({
  runsOn,
  runName = rescueRunName,
  dryRun = false,
  sourceRuns = [sourceRun()],
  initialLedgerRows = [],
  failedDispatchRunIds = [],
}) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "rescue-queued-runs-test-"),
  );
  const scriptTemporaryDirectory = join(temporaryDirectory, "script-tmp");
  const stubDirectory = join(temporaryDirectory, "bin");
  const githubCallsPath = join(temporaryDirectory, "github-calls.json");
  const githubCallCountPath = join(temporaryDirectory, "github-call-count");
  const commandLogPath = join(temporaryDirectory, "commands.log");
  const ledgerPath = join(temporaryDirectory, "rescue-ledger.jsonl");
  mkdirSync(scriptTemporaryDirectory);
  mkdirSync(stubDirectory);
  writeFileSync(
    githubCallsPath,
    JSON.stringify(buildGithubCalls({
      runsOn,
      runName,
      dryRun,
      sourceRuns,
      initialLedgerRows,
      failedDispatchRunIds,
    })),
  );
  writeFileSync(githubCallCountPath, "0\n");
  writeFileSync(commandLogPath, "");
  if (initialLedgerRows.length > 0) {
    writeFileSync(
      ledgerPath,
      `${initialLedgerRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
  }
  installStubs(stubDirectory);

  let result;
  let commandLog;
  let ledger = "";
  try {
    const args = [
      rescueScript,
      "--repo",
      repository,
      "--label",
      "cloudflare-sandbox",
      "--rescue-workflow",
      rescueWorkflow,
      "--rescue-ref",
      rescueRef,
      "--ledger",
      ledgerPath,
      ...(dryRun ? ["--dry-run"] : []),
    ];
    result = spawnSync("bash", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubDirectory}:${process.env.PATH}`,
        REAL_JQ_PATH: realJqPath,
        STUB_COMMAND_LOG: commandLogPath,
        STUB_GITHUB_CALL_COUNT: githubCallCountPath,
        STUB_GITHUB_CALLS: githubCallsPath,
        TMPDIR: scriptTemporaryDirectory,
      },
    });
    commandLog = readFileSync(commandLogPath, "utf8");
    try {
      ledger = readFileSync(ledgerPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    if (result.status === null) {
      throw result.error ?? new Error("The rescue script did not return a status");
    }
    if (readdirSync(scriptTemporaryDirectory).length !== 0) {
      throw new Error(`temporary files remained after exit ${result.status}`);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  return { ...result, commandLog, ledger };
}

export function commandCount(commandLog, command) {
  return commandLog
    .split("\n")
    .filter((line) => line === command)
    .length;
}

export function ledgerRows(ledger) {
  return ledger
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}
