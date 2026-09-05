import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflowSource = await readFile(
  new URL("../.github/workflows/listener-watchdog.yml", import.meta.url),
  "utf8",
);

function indentation(line) {
  return /^ */u.exec(line)[0].length;
}

function extractRunBlocks(source) {
  const lines = source.split(/\r?\n/u);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const runStart = /^( *)run: *\| *$/u.exec(lines[index]);
    if (runStart === null) {
      continue;
    }
    const runIndent = runStart[1].length;
    const contentIndent = runIndent + 2;
    const content = [];
    let nextIndex = index + 1;
    for (; nextIndex < lines.length; nextIndex += 1) {
      const line = lines[nextIndex];
      if (line.trim().length === 0) {
        content.push("");
        continue;
      }
      if (indentation(line) <= runIndent) {
        break;
      }
      if (indentation(line) < contentIndent) {
        throw new Error(`Invalid run block indentation at line ${nextIndex + 1}`);
      }
      content.push(line.slice(contentIndent));
    }
    blocks.push({ line: index + 1, text: content.join("\n") });
    index = nextIndex - 1;
  }

  return blocks;
}

const runBlocks = extractRunBlocks(workflowSource);

function runBlockForStep(stepName) {
  const stepMarker = `- name: ${stepName}`;
  const stepIndex = workflowSource.indexOf(stepMarker);
  assert.notEqual(stepIndex, -1, `workflow step not found: ${stepName}`);
  const stepLine = workflowSource.slice(0, stepIndex).split(/\r?\n/u).length;
  const block = runBlocks.find(({ line }) => line > stepLine);
  assert.notEqual(block, undefined, `run block not found: ${stepName}`);
  return block.text;
}

const alertBlock = runBlockForStep("Alert on the watchdog result");
const preflightBlock = runBlockForStep(
  "Preflight the watchdog configuration",
);
const watchdogBlock = runBlockForStep("Poll the listener and control status");

const runUrl =
  "https://github.com/example-org/gha-cloudflare-runner/actions/runs/123";
const runbookUrl =
  "https://github.com/example-org/gha-cloudflare-runner/blob/abc/docs/ALERTING.md";

function curlStubSource() {
  return `#!/usr/bin/env bash
set -euo pipefail
payload=''
while (($# > 0)); do
  if [[ "$1" == '--data' ]]; then
    payload=$2
    shift 2
    continue
  fi
  shift
done
printf '%s' "$payload" > "$SLACK_PAYLOAD_FILE"
`;
}

function watchdogFinding({
  code = "admission-floor",
  severity = "warning",
  summary = "The learned admission limit is binding at its floor.",
  action = "Inspect recent start refusals.",
  fields = { admissionLimit: 1, admissionFloor: 1 },
} = {}) {
  return {
    code,
    severity,
    summary,
    detail: `${code} detail`,
    action,
    fields,
  };
}

function executeAlert({
  watchdogExitCode = "1",
  preflightOutcome = "success",
  watchdogOutcome = "success",
  jobStatus = "failure",
  preflightFailureReason = "",
  preflightFailureAction = "",
  watchdogFailureReason = "",
  watchdogFailureAction = "",
  positiveControl = "false",
  slackWebhookUrl = "https://hooks.slack.test/services/test",
  findings = [watchdogFinding()],
} = {}) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "listener-watchdog-workflow-test-"),
  );
  const curlPath = join(temporaryDirectory, "curl");
  const payloadFile = join(temporaryDirectory, "slack-payload.json");
  const stepSummaryFile = join(temporaryDirectory, "step-summary.md");
  const outputFile = join(temporaryDirectory, "github-output.txt");
  writeFileSync(curlPath, curlStubSource());
  chmodSync(curlPath, 0o755);
  writeFileSync(stepSummaryFile, "");
  writeFileSync(outputFile, "");
  if (findings !== null) {
    writeFileSync(
      join(temporaryDirectory, "listener-watchdog.json"),
      `${JSON.stringify({ findings, exitCode: Number(watchdogExitCode) })}\n`,
    );
  }

  const result = spawnSync("bash", ["-c", alertBlock], {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${temporaryDirectory}:${process.env.PATH}`,
      WATCHDOG_EXIT_CODE: watchdogExitCode,
      PREFLIGHT_OUTCOME: preflightOutcome,
      WATCHDOG_OUTCOME: watchdogOutcome,
      JOB_STATUS: jobStatus,
      PREFLIGHT_FAILURE_REASON: preflightFailureReason,
      PREFLIGHT_FAILURE_ACTION: preflightFailureAction,
      WATCHDOG_FAILURE_REASON: watchdogFailureReason,
      WATCHDOG_FAILURE_ACTION: watchdogFailureAction,
      POSITIVE_CONTROL: positiveControl,
      SLACK_WEBHOOK_URL: slackWebhookUrl,
      RUN_URL: runUrl,
      RUNBOOK_URL: runbookUrl,
      GITHUB_STEP_SUMMARY: stepSummaryFile,
      GITHUB_OUTPUT: outputFile,
      SLACK_PAYLOAD_FILE: payloadFile,
    },
  });
  const payloadSource = existsSync(payloadFile)
    ? readFileSync(payloadFile, "utf8")
    : null;
  return {
    result,
    payloadFile,
    payloadSource,
    stepSummary: readFileSync(stepSummaryFile, "utf8"),
    temporaryDirectory,
  };
}

function withAlert(options, inspect) {
  const execution = executeAlert(options);
  try {
    const payload = execution.payloadSource === null
      ? null
      : JSON.parse(execution.payloadSource);
    inspect({ ...execution, payload });
  } finally {
    rmSync(execution.temporaryDirectory, { recursive: true, force: true });
  }
}

function assertJq(payloadFile, filter, variables = {}) {
  const argumentsList = ["-e"];
  for (const [name, value] of Object.entries(variables)) {
    argumentsList.push("--arg", name, value);
  }
  argumentsList.push(filter, payloadFile);
  execFileSync("jq", argumentsList, { encoding: "utf8" });
}

test("a finding alert names every finding and the run URL", () => {
  const findings = [
    watchdogFinding(),
    watchdogFinding({
      code: "control-status-unreadable",
      summary: "The listener could not read AutopilotControl.",
      action: "Inspect AutopilotControl.",
      fields: {
        controlStatusReadFailed: "true",
        advertisedMaxCapacity: 0,
      },
    }),
  ];
  withAlert({ findings }, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `
        ([
          .attachments[0].blocks[]
          | ..
          | objects
          | select(has("text"))
          | .text
          | select(type == "string")
        ] | join("\\n")) as $text
        | ($text | contains($firstCode))
          and ($text | contains($secondCode))
          and ($text | contains($runUrl))
          and ($text | contains("admissionLimit"))
      `,
      {
        firstCode: "admission-floor",
        secondCode: "control-status-unreadable",
        runUrl,
      },
    );
  });
});

test("a critical finding uses the critical colour", () => {
  withAlert({
    findings: [watchdogFinding({
      code: "listener-unconfigured",
      severity: "critical",
      fields: { enabled: "false", configured: "false" },
    })],
  }, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `
        .attachments[0].color == "#d13212"
        and .attachments[0].blocks[0].text.text
          == "Runner pool: listener watchdog finding"
      `,
    );
  });
});

test("a warning-only finding uses the warning colour", () => {
  withAlert({}, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `.attachments[0].color == "#e8912d"`,
    );
  });
});

test("an operational alert names the preflight failure", () => {
  const reason = "Repository variable WORKER_URL is missing.";
  const action = "Create WORKER_URL and run the watchdog again.";
  withAlert({
    watchdogExitCode: "",
    preflightOutcome: "failure",
    watchdogOutcome: "skipped",
    preflightFailureReason: reason,
    preflightFailureAction: action,
    findings: null,
  }, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `
        .attachments[0].color == "#d13212"
        and .attachments[0].blocks[0].text.text
          == "Runner pool: listener watchdog did not run"
        and (
          [
            .attachments[0].blocks[]
            | ..
            | objects
            | .text? // empty
            | select(type == "string")
          ]
          | join("\\n")
          | contains($reason)
        )
      `,
      { reason },
    );
  });
});

test("exit code zero posts nothing", () => {
  withAlert({
    watchdogExitCode: "0",
    jobStatus: "failure",
    findings: [],
  }, ({ result, payloadSource }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(payloadSource, null);
  });
});

test("positive control posts its code through Slack and exits zero", () => {
  withAlert({
    watchdogExitCode: "0",
    positiveControl: "true",
    jobStatus: "success",
    findings: [watchdogFinding({
      code: "positive-control",
      summary: "This is a delivery test. The runner pool is not affected.",
      action: "Confirm that this message reached Slack.",
      fields: { positiveControl: "true" },
    })],
  }, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `
        .attachments[0].color == "#e8912d"
        and .attachments[0].blocks[0].text.text
          == "Runner pool: listener watchdog delivery test"
        and (
          [
            .attachments[0].blocks[]
            | ..
            | objects
            | .text? // empty
            | select(type == "string")
          ]
          | join("\\n")
          | contains("positive-control")
        )
      `,
    );
  });
});

test("a missing webhook records a degraded warning and exits zero", () => {
  withAlert({
    slackWebhookUrl: "",
  }, ({ result, payloadSource, stepSummary }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(payloadSource, null);
    assert.match(
      result.stdout,
      /::warning title=Listener watchdog alert degraded/u,
    );
    assert.match(stepSummary, /Slack delivery is not configured/u);
  });
});

function executePositiveControlPoll() {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "listener-watchdog-positive-control-test-"),
  );
  const nodePath = join(temporaryDirectory, "node");
  const curlPath = join(temporaryDirectory, "curl");
  const outputFile = join(temporaryDirectory, "github-output.txt");
  const nodeArgumentsFile = join(temporaryDirectory, "node-arguments.txt");
  const curlCalledFile = join(temporaryDirectory, "curl-called.txt");
  writeFileSync(nodePath, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$NODE_ARGUMENTS_FILE"
printf '%s\n' '{"findings":[{"code":"positive-control","severity":"warning","summary":"This is a delivery test. The runner pool is not affected.","detail":"Synthetic finding.","action":"Confirm delivery.","fields":{"positiveControl":"true"}}],"exitCode":0}'
`);
  writeFileSync(curlPath, `#!/usr/bin/env bash
set -euo pipefail
printf 'called\n' > "$CURL_CALLED_FILE"
exit 99
`);
  chmodSync(nodePath, 0o755);
  chmodSync(curlPath, 0o755);
  writeFileSync(outputFile, "");

  const result = spawnSync("bash", ["-c", watchdogBlock], {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${temporaryDirectory}:${process.env.PATH}`,
      WORKER_URL: "",
      CONTROL_TOKEN: "",
      SCALE_SET: "",
      POSITIVE_CONTROL: "true",
      LISTENER_WATCHDOG_STRANDED_COUNT: "",
      LISTENER_WATCHDOG_STRANDED_AGE_MS: "",
      LISTENER_WATCHDOG_DARK_MS: "",
      RUNNER_TEMP: temporaryDirectory,
      GITHUB_OUTPUT: outputFile,
      NODE_ARGUMENTS_FILE: nodeArgumentsFile,
      CURL_CALLED_FILE: curlCalledFile,
    },
  });
  return {
    result,
    output: readFileSync(outputFile, "utf8"),
    nodeArguments: readFileSync(nodeArgumentsFile, "utf8"),
    curlWasCalled: existsSync(curlCalledFile),
    watchdogResult: JSON.parse(readFileSync(
      join(temporaryDirectory, "listener-watchdog.json"),
      "utf8",
    )),
    temporaryDirectory,
  };
}

test("positive control skips every status poll and evaluates synthetic data", () => {
  const execution = executePositiveControlPoll();
  try {
    assert.equal(execution.result.status, 0, execution.result.stderr);
    assert.equal(execution.curlWasCalled, false);
    assert.match(
      execution.nodeArguments,
      /scripts\/lib\/listener-health\.mjs evaluate --positive-control/u,
    );
    assert.match(execution.output, /^exit_code=0$/mu);
    assert.equal(execution.watchdogResult.exitCode, 0);
    assert.deepEqual(
      execution.watchdogResult.findings.map(({ code }) => code),
      ["positive-control"],
    );
  } finally {
    rmSync(execution.temporaryDirectory, { recursive: true, force: true });
  }
});

function executePreflight(environment) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "listener-watchdog-preflight-test-"),
  );
  const outputFile = join(temporaryDirectory, "github-output.txt");
  writeFileSync(outputFile, "");
  const result = spawnSync("bash", ["-c", preflightBlock], {
    encoding: "utf8",
    env: {
      ...process.env,
      WORKER_URL: "https://worker.example.com",
      CONTROL_TOKEN: "control-token-value-must-stay-secret",
      SCALE_SET: "cloudflare-sandbox",
      GITHUB_OUTPUT: outputFile,
      ...environment,
    },
  });
  return {
    result,
    output: readFileSync(outputFile, "utf8"),
    temporaryDirectory,
  };
}

test("positive control skips the status preflight", () => {
  const execution = executePreflight({
    WORKER_URL: "",
    CONTROL_TOKEN: "",
    SCALE_SET: "",
    POSITIVE_CONTROL: "true",
  });
  try {
    assert.equal(execution.result.status, 0, execution.result.stderr);
    assert.equal(execution.output, "");
  } finally {
    rmSync(execution.temporaryDirectory, { recursive: true, force: true });
  }
});

test("the preflight records each missing input", () => {
  const cases = [
    {
      environment: { WORKER_URL: "" },
      message: "Repository variable WORKER_URL is missing.",
    },
    {
      environment: { CONTROL_TOKEN: "" },
      message: "Repository secret CONTROL_TOKEN is missing.",
    },
    {
      environment: { SCALE_SET: "" },
      message: "Repository variable WATCHDOG_SCALE_SET is missing or invalid.",
    },
  ];
  for (const testCase of cases) {
    const execution = executePreflight(testCase.environment);
    try {
      assert.equal(execution.result.status, 1);
      assert.match(
        execution.result.stdout,
        /::error title=Listener watchdog preflight/u,
      );
      assert.equal(execution.result.stderr.includes(testCase.message), true);
      assert.match(
        execution.output,
        /failure_reason<<LISTENER_WATCHDOG_EOF/u,
      );
      assert.match(
        execution.output,
        /failure_action<<LISTENER_WATCHDOG_EOF/u,
      );
      assert.equal(execution.output.includes(testCase.message), true);
    } finally {
      rmSync(execution.temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
});

test("the preflight rejects an insecure URL and an invalid scale set", () => {
  const cases = [
    {
      environment: { WORKER_URL: "http://worker.example.com" },
      message: "WORKER_URL must begin with https://",
    },
    {
      environment: { SCALE_SET: "invalid/name" },
      message: "WATCHDOG_SCALE_SET is missing or invalid",
    },
  ];
  for (const testCase of cases) {
    const execution = executePreflight(testCase.environment);
    try {
      assert.equal(execution.result.status, 1);
      assert.equal(execution.output.includes(testCase.message), true);
    } finally {
      rmSync(execution.temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
});

test("the alert block contains no GitHub expression", () => {
  assert.equal(alertBlock.includes("${{ secrets."), false);
  assert.equal(alertBlock.includes("${{ vars."), false);
});
