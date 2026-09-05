import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
  new URL("../.github/workflows/registration-cleanup.yml", import.meta.url),
  "utf8",
);
const orphanAuditSource = await readFile(
  new URL("../.github/workflows/orphan-audit.yml", import.meta.url),
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
        `invalid run block indentation at line ${nextIndex + 1}`,
      );
      content.push(line.slice(contentIndent));
    }
    blocks.push({ line: index + 1, text: content.join("\n") });
    index = nextIndex - 1;
  }
  return blocks;
}

const runBlocks = extractRunBlocks(workflowSource);

function runBlockForStep(stepName) {
  const marker = `- name: ${stepName}`;
  const stepIndex = workflowSource.indexOf(marker);
  assert.notEqual(stepIndex, -1, `workflow step not found: ${stepName}`);
  const stepLine = workflowSource.slice(0, stepIndex).split(/\r?\n/u).length;
  const block = runBlocks.find(({ line }) => line > stepLine);
  assert.notEqual(block, undefined, `run block not found: ${stepName}`);
  return block.text;
}

function inputBlock(inputName) {
  const marker = `      ${inputName}:`;
  const start = workflowSource.indexOf(marker);
  assert.notEqual(start, -1, `workflow input not found: ${inputName}`);
  const following = workflowSource.slice(start + marker.length);
  const nextInput = following.search(/^ {6}[a-z_]+:/mu);
  return nextInput === -1 ? following : following.slice(0, nextInput);
}

function permissionBlocks() {
  const lines = workflowSource.split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^( *)permissions: *$/u.exec(lines[index]);
    if (match === null) {
      continue;
    }
    const blockIndent = match[1].length;
    const entries = [];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const line = lines[nextIndex];
      if (line.trim().length === 0) {
        continue;
      }
      if (indentation(line) <= blockIndent) {
        break;
      }
      entries.push(line.trim());
    }
    blocks.push(entries);
  }
  return blocks;
}

function actionPins(source) {
  return new Map(
    [...source.matchAll(/^\s*uses: ([^@\s]+)@([0-9a-f]{40})(?:\s+#.*)?$/gmu)]
      .map((match) => [match[1], match[2]]),
  );
}

test("the workflow has a workflow_dispatch trigger and no schedule trigger", () => {
  const triggerEnd = workflowSource.indexOf("\npermissions:");
  assert.notEqual(triggerEnd, -1);
  const triggerBlock = workflowSource.slice(0, triggerEnd);

  assert.match(triggerBlock, /^on:\n {2}workflow_dispatch:/mu);
  assert.doesNotMatch(triggerBlock, /^\s*schedule:/mu);
  assert.doesNotMatch(triggerBlock, /^\s*push:/mu);
});

test("the apply input declares default: false", () => {
  const block = inputBlock("apply");
  assert.match(block, /^ {8}type: boolean$/mu);
  assert.match(block, /^ {8}default: false$/mu);
  assert.match(block, /False reports only\./u);
});

test("the confirm gate exists and the workflow fails an apply run without DELETE", () => {
  const preflightBlock = runBlockForStep("Preflight the cleanup configuration");
  const cleanupBlock = runBlockForStep("Run the registration cleanup");

  assert.match(
    inputBlock("confirm"),
    /description: Type DELETE to authorise an apply run\./u,
  );
  assert.match(
    preflightBlock,
    /\[\[ "\$APPLY_INPUT" == 'true' && "\$CONFIRM_INPUT" != 'DELETE' \]\]/u,
  );
  assert.match(preflightBlock, /exit 1/u);
  assert.match(
    cleanupBlock,
    /\[\[ "\$APPLY_INPUT" == 'true' && "\$CONFIRM_INPUT" == 'DELETE' \]\]/u,
  );
  assert.match(cleanupBlock, /arguments\+=\(--apply\)/u);
  assert.equal(
    cleanupBlock.match(/arguments\+=\(--apply\)/gu)?.length,
    1,
  );

  const rejected = spawnSync("bash", ["-c", preflightBlock], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLEANUP_GITHUB_TOKEN: "test-token",
      APPLY_INPUT: "true",
      CONFIRM_INPUT: "",
    },
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /requires the exact confirmation DELETE/u);

  const accepted = spawnSync("bash", ["-c", preflightBlock], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLEANUP_GITHUB_TOKEN: "test-token",
      APPLY_INPUT: "true",
      CONFIRM_INPUT: "DELETE",
    },
  });
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("permissions grants only contents: read", () => {
  assert.deepEqual(permissionBlocks(), [
    ["contents: read"],
    ["contents: read"],
  ]);
});

test("every uses: is pinned to a 40-character commit SHA", () => {
  const usesLines = workflowSource
    .split(/\r?\n/u)
    .filter((line) => /^\s*uses:/u.test(line));

  assert.ok(usesLines.length > 0);
  for (const line of usesLines) {
    assert.match(
      line,
      /^\s*uses: [^@\s]+@[0-9a-f]{40}(?:\s+#.*)?$/u,
    );
  }
});

test("the workflow uses the required token, runtime, and manual limits", () => {
  assert.match(
    workflowSource,
    /secrets\.RUNNER_CLEANUP_GITHUB_TOKEN \|\| secrets\.AUDIT_GITHUB_TOKEN/u,
  );
  assert.match(workflowSource, /timeout-minutes: 60/u);
  assert.match(
    workflowSource,
    /concurrency: \{ group: registration-cleanup, cancel-in-progress: false \}/u,
  );
  assert.match(workflowSource, /persist-credentials: false/u);
  assert.match(workflowSource, /node-version: '22'/u);
  assert.match(inputBlock("limit"), /default: '250'/u);
  assert.match(inputBlock("scale_set_id"), /default: ''/u);
});

test("the workflow uses the orphan audit action pins and uploads the report", () => {
  const cleanupPins = actionPins(workflowSource);
  const orphanPins = actionPins(orphanAuditSource);
  for (const action of [
    "actions/checkout",
    "actions/setup-node",
    "actions/upload-artifact",
  ]) {
    assert.equal(cleanupPins.get(action), orphanPins.get(action));
  }
  assert.match(
    runBlockForStep("Write the cleanup summary"),
    /registration-cleanup-report\.json/u,
  );
  assert.match(
    workflowSource,
    /path: registration-cleanup-report\.json/u,
  );
});

test("the summary step writes a table from the JSON report", (t) => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "registration-cleanup-workflow-test-"),
  );
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const reportPath = join(
    temporaryDirectory,
    "registration-cleanup-report.json",
  );
  const summaryPath = join(temporaryDirectory, "summary.md");
  writeFileSync(reportPath, JSON.stringify({
    scope: "organization:example-org",
    apply: true,
    totalRegistrations: 12,
    counts: { delete: 7 },
    attempted: 4,
    deleted: 3,
    alreadyAbsent: 1,
    busySkipped: 0,
    remaining: 3,
  }));
  writeFileSync(summaryPath, "");

  const result = spawnSync(
    "bash",
    ["-c", runBlockForStep("Write the cleanup summary")],
    {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const summary = readFileSync(summaryPath, "utf8");
  assert.match(summary, /\| Scope \| organization:example-org \|/u);
  assert.match(summary, /\| Delete targets \| 7 \|/u);
  assert.match(summary, /\| Remaining \| 3 \|/u);
});
