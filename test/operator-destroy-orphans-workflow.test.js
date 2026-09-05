import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
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
  new URL("../.github/workflows/operator-destroy-orphans.yml", import.meta.url),
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
      assert.ok(
        indentation(line) >= contentIndent,
        `Invalid run block indentation at line ${nextIndex + 1}`,
      );
      content.push(line.slice(contentIndent));
    }
    blocks.push({ line: index + 1, text: content.join("\n") });
    index = nextIndex - 1;
  }
  return blocks;
}

function runBlockForStep(stepName) {
  const marker = `- name: ${stepName}`;
  const stepIndex = workflowSource.indexOf(marker);
  assert.notEqual(stepIndex, -1, `Workflow step not found: ${stepName}`);
  const stepLine = workflowSource.slice(0, stepIndex).split(/\r?\n/u).length;
  const block = extractRunBlocks(workflowSource).find(
    ({ line }) => line > stepLine,
  );
  assert.notEqual(block, undefined, `Run block not found: ${stepName}`);
  return block.text;
}

function operatorResult(outcome, index, overrides = {}) {
  return {
    type: "operator-orphan-result",
    sandboxId: `runner-result-${index}`,
    reason: "terminal-registry-row",
    outcome,
    terminalResolution: outcome === "destroyed",
    request: {},
    requestSent: outcome !== "dry-run",
    ...overrides,
  };
}

function operatorSummary(overrides = {}) {
  return {
    type: "operator-orphan-summary",
    destroy: true,
    evidenceSource: "test",
    findingCount: 0,
    requestCount: 0,
    sentCount: 0,
    destroyedCount: 0,
    dryRunCount: 0,
    insideGraceCount: 0,
    actionRequiredCount: 0,
    terminalResolutionCount: 0,
    unresolvedCount: 0,
    operationalFailureCount: 0,
    exitCode: 0,
    ...overrides,
  };
}

function jsonLines(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function executeOperatorStep(records, options) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "operator-destroy-workflow-test-"),
  );
  try {
    const scriptsDirectory = join(temporaryDirectory, "scripts");
    const fixturePath = join(temporaryDirectory, "fixture.jsonl");
    const outputPath = join(temporaryDirectory, "github-output");
    const toolPath = join(scriptsDirectory, "operator-destroy-orphans.mjs");
    mkdirSync(scriptsDirectory);
    writeFileSync(fixturePath, jsonLines(records));
    writeFileSync(
      toolPath,
      "#!/usr/bin/env bash\nset -euo pipefail\ncat \"$OPERATOR_FIXTURE\"\nexit \"$OPERATOR_FIXTURE_EXIT\"\n",
    );
    chmodSync(toolPath, 0o755);

    const result = spawnSync(
      "bash",
      ["-c", runBlockForStep("Run the operator orphan destroy")],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          DESTROY_INPUT: String(options.destroy),
          GITHUB_OUTPUT: outputPath,
          OPERATOR_FIXTURE: fixturePath,
          OPERATOR_FIXTURE_EXIT: String(options.exitCode),
        },
      },
    );
    return {
      result,
      output: readFileSync(outputPath, "utf8"),
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function executeSummaryStep(records, exitCode) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "operator-destroy-summary-test-"),
  );
  try {
    const summaryPath = join(temporaryDirectory, "step-summary.md");
    writeFileSync(
      join(temporaryDirectory, "operator-orphan-destroy.jsonl"),
      jsonLines(records),
    );
    const result = spawnSync(
      "bash",
      ["-c", runBlockForStep("Write the operator summary")],
      {
        cwd: temporaryDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          OPERATOR_EXIT_CODE: String(exitCode),
          DESTROY_MODE: "true",
          SUMMARY_ASSERTION: "passed",
          MODE_ASSERTION: "passed",
          COUNT_ASSERTION: "passed",
          EXIT_CODE_ASSERTION: "passed",
          RESULT_COUNT: String(records.length - 1),
          RUNBOOK_URL: "https://example.test/runbook",
          GITHUB_STEP_SUMMARY: summaryPath,
        },
      },
    );
    return {
      result,
      summary: readFileSync(summaryPath, "utf8"),
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("the workflow destroys on its schedule and defaults a dispatch to dry-run mode", () => {
  assert.match(workflowSource, /on:\n {2}schedule:\n/u);
  // Two passes per hour, both after the :17 audit and more than 60 seconds
  // apart, so the second pass lands outside the operator route's grace window.
  assert.match(workflowSource, /- cron: '37,47 \* \* \* \*'/u);
  assert.match(workflowSource, /\n {2}workflow_dispatch:\n/u);
  assert.match(
    workflowSource,
    /destroy:\n {8}description:[\s\S]*?type: boolean\n {8}default: false/u,
  );
  assert.match(workflowSource, /DESTROY_INPUT: \$\{\{ inputs\.destroy \}\}/u);
  assert.match(workflowSource, /EVENT_NAME: \$\{\{ github\.event_name \}\}/u);
  assert.match(
    workflowSource,
    /if \[\[ "\$DESTROY_INPUT" == 'true' \|\| "\$\{EVENT_NAME:-\}" == 'schedule' \]\]; then\n {12}operator_args\+=\(--destroy\)/u,
  );
});

test("the workflow supplies every required credential and scope", () => {
  for (const expression of [
    "${{ secrets.CONTROL_TOKEN }}",
    "${{ secrets.CLOUDFLARE_API_TOKEN }}",
    "${{ secrets.AUDIT_GITHUB_TOKEN }}",
    "${{ vars.WORKER_URL }}",
    "${{ vars.AUDIT_RUNNER_SCOPE }}",
  ]) {
    assert.ok(workflowSource.includes(expression), expression);
  }
  assert.match(
    workflowSource,
    /ORPHAN_GRACE_SECONDS: '60' # 60 is the policy value and must not be changed\./u,
  );
});

test("the workflow runs the tool after the audit repository override is removed", () => {
  const block = runBlockForStep("Run the operator orphan destroy");
  assert.match(block, /unset GITHUB_REPOSITORY/u);
  assert.match(block, /scripts\/operator-destroy-orphans\.mjs/u);
  assert.match(block, /--audit-report operator-orphan-audit\.jsonl/u);
  assert.match(block, /--audit-stderr operator-orphan-audit\.stderr\.log/u);
  assert.match(block, />operator-orphan-destroy\.jsonl/u);
});

test("the workflow archives the evidence, result, and stderr records", () => {
  assert.match(workflowSource, /if: always\(\) && steps\.operator\.outcome != 'skipped'/u);
  for (const path of [
    "operator-orphan-audit.jsonl",
    "operator-orphan-audit.stderr.log",
    "operator-orphan-destroy.jsonl",
    "operator-orphan-destroy.stderr.log",
  ]) {
    assert.ok(workflowSource.includes(path), path);
  }
  assert.match(workflowSource, /retention-days: 90/u);
  assert.match(workflowSource, /if-no-files-found: error/u);
});

test("the workflow keeps the audit alert and final-result structure", () => {
  assert.match(
    workflowSource,
    /- name: Alert on the operator result\n {8}if: always\(\)/u,
  );
  assert.match(
    workflowSource,
    /SLACK_WEBHOOK_URL: \$\{\{ secrets\.ORPHAN_AUDIT_SLACK_WEBHOOK_URL \}\}/u,
  );
  assert.match(workflowSource, /- name: Set the operator result/u);
  assert.match(workflowSource, /0 \| 1 \| 2\) exit "\$exit_code"/u);
});

test("the workflow accepts only the exact quiet outcome sets", () => {
  const dryRunRecords = [
    operatorResult("dry-run", 1),
    operatorSummary({
      destroy: false,
      findingCount: 1,
      requestCount: 1,
      dryRunCount: 1,
      unresolvedCount: 1,
    }),
  ];
  const insideGraceRecords = [
    operatorResult("inside-grace", 1),
    operatorResult("inside-grace", 2),
    operatorSummary({
      findingCount: 2,
      requestCount: 2,
      sentCount: 2,
      insideGraceCount: 2,
      unresolvedCount: 2,
    }),
  ];
  const mixedRecords = [
    operatorResult("inside-grace", 1),
    operatorResult("revision-conflict", 2),
    operatorSummary({
      findingCount: 2,
      requestCount: 2,
      sentCount: 2,
      insideGraceCount: 1,
      actionRequiredCount: 1,
      unresolvedCount: 2,
      exitCode: 1,
    }),
  ];

  for (const testCase of [
    { records: dryRunRecords, destroy: false, exitCode: 0 },
    { records: insideGraceRecords, destroy: true, exitCode: 0 },
    { records: mixedRecords, destroy: true, exitCode: 1 },
  ]) {
    const execution = executeOperatorStep(testCase.records, testCase);
    assert.equal(execution.result.status, 0, execution.result.stderr);
    assert.match(
      execution.output,
      new RegExp(`^exit_code=${testCase.exitCode}$`, "mu"),
    );
    assert.match(execution.output, /^count_assertion=passed$/mu);
    assert.match(execution.output, /^exit_code_assertion=passed$/mu);
  }
});

test("the step summary explains every inside-grace sandbox", () => {
  const records = [
    operatorResult("inside-grace", 1),
    operatorResult("inside-grace", 2),
    operatorSummary({
      findingCount: 2,
      requestCount: 2,
      sentCount: 2,
      insideGraceCount: 2,
      unresolvedCount: 2,
    }),
  ];
  const execution = executeSummaryStep(records, 0);

  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.match(
    execution.summary,
    /The orphan observation is recorded for `2` sandboxes\./u,
  );
  assert.match(
    execution.summary,
    /A second destroy run after the 60-second grace window will destroy these sandboxes\./u,
  );
});

test("every workflow run block has valid Bash syntax", () => {
  for (const block of extractRunBlocks(workflowSource)) {
    const result = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: block.text,
    });
    assert.equal(
      result.status,
      0,
      `Run block at line ${block.line}: ${result.stderr}`,
    );
  }
});
