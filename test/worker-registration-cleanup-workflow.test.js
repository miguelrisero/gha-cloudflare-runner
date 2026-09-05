import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL,
} from "../src/runner-policy.js";

const MAX_ROUNDS = 40;
const workflowSource = await readFile(
  new URL(
    "../.github/workflows/worker-registration-cleanup.yml",
    import.meta.url,
  ),
  "utf8",
);
const registrationCleanupSource = await readFile(
  new URL("../.github/workflows/registration-cleanup.yml", import.meta.url),
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
    [...source.matchAll(
      /^\s*uses: ([^@\s]+)@([0-9a-f]{40})(?:\s+#.*)?$/gmu,
    )].map((match) => [match[1], match[2]]),
  );
}

function preflight(overrides = {}) {
  return spawnSync(
    "bash",
    ["-c", runBlockForStep("Preflight the cleanup configuration")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        APPLY_INPUT: "false",
        CONFIRM_INPUT: "",
        CONTROL_TOKEN,
        LIMIT_INPUT: String(REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL),
        ROUNDS_INPUT: "1",
        WORKER_URL: "https://worker.example",
        ...overrides,
      },
    },
  );
}

const CONTROL_TOKEN = "control-token-with-at-least-32-characters";

test("the workflow parses as a workflow_dispatch with the expected inputs", () => {
  const triggerEnd = workflowSource.indexOf("\npermissions:");
  assert.notEqual(triggerEnd, -1);
  const triggerBlock = workflowSource.slice(0, triggerEnd);
  const inputNames = [...triggerBlock.matchAll(/^ {6}([a-z_]+):$/gmu)]
    .map((match) => match[1]);

  assert.match(workflowSource, /^name: Worker registration cleanup$/mu);
  assert.match(triggerBlock, /^on:\n {2}workflow_dispatch:/mu);
  assert.deepEqual(inputNames, ["apply", "confirm", "limit", "rounds"]);
  assert.doesNotMatch(triggerBlock, /^\s*(?:push|schedule):/mu);
});

test("the workflow defaults apply to false and confirm to an empty string", () => {
  assert.match(inputBlock("apply"), /^ {8}type: boolean$/mu);
  assert.match(inputBlock("apply"), /^ {8}default: false$/mu);
  assert.match(inputBlock("confirm"), /^ {8}type: string$/mu);
  assert.match(inputBlock("confirm"), /^ {8}default: ''$/mu);
});

test("the workflow requires the literal DELETE confirmation for apply", () => {
  const rejected = preflight({ APPLY_INPUT: "true", CONFIRM_INPUT: "delete" });
  const accepted = preflight({ APPLY_INPUT: "true", CONFIRM_INPUT: "DELETE" });

  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /literal DELETE confirmation/u);
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("the workflow requires an HTTPS Worker URL and a control token", () => {
  const emptyUrl = preflight({ WORKER_URL: "" });
  const insecureUrl = preflight({ WORKER_URL: "http://worker.example" });
  const emptyToken = preflight({ CONTROL_TOKEN: "" });

  assert.equal(emptyUrl.status, 1);
  assert.match(emptyUrl.stdout, /Invalid Worker URL/u);
  assert.equal(insecureUrl.status, 1);
  assert.match(insecureUrl.stdout, /Invalid Worker URL/u);
  assert.equal(emptyToken.status, 1);
  assert.match(emptyToken.stdout, /Missing control token/u);
});

test("the workflow defaults limit to the per-call cap and refuses a larger limit", () => {
  assert.match(
    inputBlock("limit"),
    new RegExp(
      `^ {8}default: '${REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL}'$`,
      "mu",
    ),
  );
  const rejected = preflight({
    LIMIT_INPUT: String(REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL + 1),
  });
  const accepted = preflight({
    LIMIT_INPUT: String(REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL),
  });

  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /must not exceed 50/u);
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("the workflow defaults rounds to one and refuses more than 40 rounds", () => {
  assert.match(inputBlock("rounds"), /^ {8}default: '1'$/mu);
  const rejected = preflight({ ROUNDS_INPUT: String(MAX_ROUNDS + 1) });
  const accepted = preflight({ ROUNDS_INPUT: String(MAX_ROUNDS) });

  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /must not exceed 40/u);
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("the workflow grants only contents read and serializes cleanup runs", () => {
  assert.deepEqual(permissionBlocks(), [
    ["contents: read"],
    ["contents: read"],
  ]);
  assert.match(
    workflowSource,
    /concurrency: \{ group: worker-registration-cleanup, cancel-in-progress: false \}/u,
  );
  assert.match(workflowSource, /WORKER_URL: \$\{\{ vars\.WORKER_URL \}\}/u);
  assert.match(
    workflowSource,
    /CONTROL_TOKEN: \$\{\{ secrets\.CONTROL_TOKEN \}\}/u,
  );
});

test("the workflow never echoes the control token", () => {
  assert.doesNotMatch(workflowSource, /set -x/u);
  assert.doesNotMatch(
    workflowSource,
    /(?:echo|printf)[^\n]*\$\{?CONTROL_TOKEN/u,
  );
  assert.match(
    workflowSource,
    /--header "Authorization: Bearer \$CONTROL_TOKEN"/u,
  );
});

test("every workflow run block starts in strict shell mode", () => {
  assert.ok(runBlocks.length > 0);
  for (const block of runBlocks) {
    assert.match(block.text, /^set -euo pipefail(?:\n|$)/u);
    const syntax = spawnSync("bash", ["-n"], {
      encoding: "utf8",
      input: block.text,
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("the workflow runs bounded resumable calls and writes every round summary", () => {
  const cleanupBlock = runBlockForStep("Run the Worker registration cleanup");

  assert.match(
    cleanupBlock,
    /for \(\( round=1; round<=ROUNDS_INPUT; round\+=1 \)\)/u,
  );
  assert.match(cleanupBlock, /mktemp "\$RUNNER_TEMP\//u);
  assert.match(cleanupBlock, /trap 'rm -f -- "\$file"' EXIT/u);
  assert.match(cleanupBlock, /--fail-with-body --silent --show-error/u);
  assert.match(cleanupBlock, /--connect-timeout 10/u);
  assert.match(cleanupBlock, /--max-time 180/u);
  assert.match(cleanupBlock, /\.refused == true/u);
  assert.match(cleanupBlock, /\.remaining == 0/u);
  const summaryCallIndex = cleanupBlock.lastIndexOf(
    'write_round_summary "$file" "$round"',
  );
  const failureIndex = cleanupBlock.indexOf("if (( curl_status != 0 ))");
  assert.notEqual(summaryCallIndex, -1);
  assert.notEqual(failureIndex, -1);
  assert.ok(
    summaryCallIndex < failureIndex,
    "the refusal report summary must precede the non-success exit",
  );
  for (const label of [
    "Scope",
    "Apply",
    "Refused",
    "Refusal reason",
    "Total registrations",
    "Delete targets",
    "Attempted",
    "Deleted",
    "Already absent",
    "Busy skipped",
    "Remaining",
  ]) {
    assert.match(cleanupBlock, new RegExp(`\\| ${label} \\|`, "u"));
  }
});

test("the workflow bounds its own run time", () => {
  // Forty rounds at the 180-second per-call ceiling need 120 minutes.
  assert.match(workflowSource, /^ {4}timeout-minutes: 150$/mu);
});

test("a dry run makes exactly one Worker call", () => {
  const cleanupBlock = runBlockForStep("Run the Worker registration cleanup");
  const dryRunBreakIndex = cleanupBlock.indexOf(
    `if [[ "$APPLY_INPUT" != 'true' ]]; then`,
  );
  const roundLoopIndex = cleanupBlock.indexOf("for (( round=1;");
  assert.notEqual(dryRunBreakIndex, -1);
  assert.notEqual(roundLoopIndex, -1);
  assert.ok(
    roundLoopIndex < dryRunBreakIndex,
    "the dry-run break must sit inside the round loop",
  );
});

test("an apply run performs a baseline dry-run round before the first apply round", () => {
  const cleanupBlock = runBlockForStep("Run the Worker registration cleanup");
  const applyConditionIndex = cleanupBlock.indexOf(
    `if [[ "$APPLY_INPUT" == 'true' ]]; then`,
  );
  const baselineDryRunIndex = cleanupBlock.indexOf(
    "--argjson apply false",
    applyConditionIndex,
  );
  const baselineCallIndex = cleanupBlock.indexOf(
    `run_cleanup_call "$request_body" 'baseline'`,
  );
  const applyLoopIndex = cleanupBlock.indexOf("for (( round=1;");
  const applyRequestIndex = cleanupBlock.indexOf(
    "--argjson apply true",
    applyLoopIndex,
  );

  assert.ok(applyConditionIndex < baselineDryRunIndex);
  assert.ok(baselineDryRunIndex < baselineCallIndex);
  assert.ok(baselineCallIndex < applyLoopIndex);
  assert.ok(applyLoopIndex < applyRequestIndex);
  assert.doesNotMatch(
    cleanupBlock.slice(baselineDryRunIndex, baselineCallIndex),
    /expectedTargets/u,
  );
});

test("the next round's expectedTargets predicts the next round's population", () => {
  const cleanupBlock = runBlockForStep("Run the Worker registration cleanup");

  assert.match(
    cleanupBlock,
    /--argjson expectedTargets "\$expected_targets"/u,
  );
  assert.match(
    cleanupBlock,
    /expectedTargets: \$expectedTargets/u,
  );
  assert.match(
    cleanupBlock,
    /\.filteredRegistrations - \.deleted - \.alreadyAbsent/u,
  );
  assert.match(
    cleanupBlock,
    /if ! expected_targets=\$\(jq -er/u,
  );
});

test("a dry run sends no expectedTargets", () => {
  const cleanupBlock = runBlockForStep("Run the Worker registration cleanup");

  assert.match(
    cleanupBlock,
    /else\n\s+request_body=\$\(jq -n[\s\S]*?'\{ apply: \$apply, confirm: \$confirm, limit: \$limit \}'\)\n\s+fi\n\s+run_cleanup_call "\$request_body" "\$round"/u,
  );
});

test("the summary table carries Filtered registrations and Expected targets", () => {
  const cleanupBlock = runBlockForStep("Run the Worker registration cleanup");

  assert.match(cleanupBlock, /\| Filtered registrations \|/u);
  assert.match(cleanupBlock, /\| Expected targets \|/u);
});

test("the workflow uses the registration cleanup upload-artifact pin", () => {
  const workerPins = actionPins(workflowSource);
  const registrationPins = actionPins(registrationCleanupSource);

  assert.equal(
    workerPins.get("actions/upload-artifact"),
    registrationPins.get("actions/upload-artifact"),
  );
  assert.match(
    workflowSource,
    /path: worker-registration-cleanup-report\.json/u,
  );
});

test("the population hand-off subtracts deletes from the population, not remaining", () => {
  const cleanupBlock = runBlockForStep("Run the Worker registration cleanup");
  // `remaining` excludes busy records; the population includes them. Handing
  // off `remaining` would under-predict and refuse the next round.
  assert.match(
    cleanupBlock,
    /\.filteredRegistrations - \.deleted - \.alreadyAbsent/u,
  );
  assert.doesNotMatch(cleanupBlock, /\|\s*\.remaining\s*$/mu);
});
