import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const [workflowSource, listenerSource] = await Promise.all([
  readFile(
    new URL("../.github/workflows/bootstrap-fleet.yml", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../src/scaleset-listener.js", import.meta.url), "utf8"),
]);

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

function lineIsInsideEnvMapping(lines, lineIndex) {
  const valueIndent = indentation(lines[lineIndex]);
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    if (lines[index].trim().length === 0) {
      continue;
    }
    const candidateIndent = indentation(lines[index]);
    if (candidateIndent >= valueIndent) {
      continue;
    }
    return candidateIndent === valueIndent - 2 &&
      /^ *env: *$/u.test(lines[index]);
  }
  return false;
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

const scaleSetPreflightBlock = runBlockForStep("Preflight the scale set");

function curlStubSource() {
  return `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
let method = "GET";
let outputPath = null;
let url = null;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--request") {
    method = args[index + 1];
    index += 1;
  } else if (args[index] === "--output") {
    outputPath = args[index + 1];
    index += 1;
  } else if ([
    "--connect-timeout",
    "--max-time",
    "--retry",
    "--header",
    "--write-out",
  ].includes(args[index])) {
    index += 1;
  } else if (!args[index].startsWith("-")) {
    url = args[index];
  }
}
appendFileSync(
  process.env.CURL_REQUEST_LOG,
  JSON.stringify({ method, url }) + "\\n",
);
writeFileSync(outputPath, process.env.LISTENER_STATUS);
process.stdout.write("200");
`;
}

function executeScaleSetPreflight(listenerStatus) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "bootstrap-scale-set-test-"),
  );
  const curlPath = join(temporaryDirectory, "curl");
  const requestLog = join(temporaryDirectory, "requests.jsonl");
  writeFileSync(curlPath, curlStubSource());
  chmodSync(curlPath, 0o755);
  writeFileSync(requestLog, "");

  try {
    const result = spawnSync("bash", ["-c", scaleSetPreflightBlock], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${temporaryDirectory}:${process.env.PATH}`,
        RUNNER_TEMP: temporaryDirectory,
        WORKER_URL: "https://worker.example/",
        CONTROL_TOKEN: "control-token-value-must-stay-secret",
        SCALE_SET: "cloudflare-sandbox",
        LISTENER_STATUS: JSON.stringify(listenerStatus),
        CURL_REQUEST_LOG: requestLog,
      },
    });
    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      requests,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("the workflow run-block parser finds every shell block", () => {
  assert.notEqual(
    runBlocks.length,
    0,
    "the run-block parser must not pass without examining a shell block",
  );
});

test("the workflow never enables shell tracing or verbose input", () => {
  const tracingCommand =
    /\bset[\t ]+(?:-[A-Za-z]*[vx][A-Za-z]*|-o[\t ]+(?:verbose|xtrace))(?=[\t ]|\n|$)/u;
  assert.equal(
    tracingCommand.test(workflowSource),
    false,
    "the workflow must not enable set -x, set -v, xtrace, or verbose mode",
  );
});

test("CONTROL_TOKEN expressions occur only in env mappings", () => {
  const lines = workflowSource.split(/\r?\n/u);
  const tokenLines = lines
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => line.includes("secrets.CONTROL_TOKEN"));
  assert.equal(
    tokenLines.length > 0 && tokenLines.every(({ index }) =>
      lineIsInsideEnvMapping(lines, index)
    ),
    true,
    "secrets.CONTROL_TOKEN must occur only below an env mapping",
  );
});

test("run blocks contain no direct input or secret expressions", () => {
  const directExpression = /\$\{\{\s*(?:inputs|secrets)\./u;
  assert.equal(
    runBlocks.some(({ text }) => directExpression.test(text)),
    false,
    "run blocks must receive inputs and secrets through env mappings",
  );
});

test("the workflow supplies no literal capacity", () => {
  const literalCapacity =
    /(?:["']capacity["']|(?<![A-Za-z0-9_])capacity)[\t ]*(?::|=)[\t ]*["']?[0-9]+|--capacity(?:=|[\t ]+)["']?[0-9]+/iu;
  assert.equal(
    literalCapacity.test(workflowSource),
    false,
    "only the operator input may supply a capacity",
  );
});

test("the workflow and listener use the same scale set name pattern", () => {
  const workflowPattern =
    /scale_set_pattern='([^'\r\n]+)'/u.exec(workflowSource)?.[1];
  const sourcePattern =
    /export const SCALE_SET_NAME_PATTERN\s*=\s*\/([^/\r\n]+)\/u;/u
      .exec(listenerSource)?.[1];
  assert.equal(
    workflowPattern,
    sourcePattern,
    "the workflow scale set pattern must match SCALE_SET_NAME_PATTERN",
  );
});

test("the workflow masks the approval before response bodies are printed", () => {
  const maskBlockIndex = runBlocks.findIndex(({ text }) =>
    text.includes("printf '::add-mask::%s\\n'") &&
    text.includes('mask_value "$CAPACITY_APPROVAL"') &&
    text.includes('mask_value "$approval_signature"')
  );
  const responseBlockIndexes = runBlocks
    .map(({ text }, index) => ({ index, text }))
    .filter(({ text }) => /response body:/iu.test(text))
    .map(({ index }) => index);
  assert.equal(
    maskBlockIndex >= 0 &&
      responseBlockIndexes.length > 0 &&
      responseBlockIndexes.every((index) => index > maskBlockIndex),
    true,
    "the signature and approval masks must precede every response body step",
  );
});

test("the scale set preflight precedes the capacity approval", () => {
  const preflightIndex = workflowSource.indexOf(
    "- name: Preflight the scale set",
  );
  const capacityIndex = workflowSource.indexOf(
    "- name: Apply the signed capacity approval",
  );
  assert.equal(
    preflightIndex >= 0 && capacityIndex > preflightIndex,
    true,
    "the read-only scale set check must run before the capacity change",
  );
});

test("the scale set preflight fails when the listener is not configured", () => {
  const result = executeScaleSetPreflight({
    configured: false,
    stoppedReason: null,
    exhaustionMarkers: [],
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Create the runner scale set named/u);
  assert.match(result.stdout, /docs\/AUTOPILOT-OPERATIONS\.md/u);
  assert.match(result.stdout, /scripts\/preflight-scale-set\.sh/u);
});

test("the scale set preflight fails for a missing-scale-set stop", () => {
  const result = executeScaleSetPreflight({
    configured: true,
    stoppedReason: "failure:scale-set-not-found-exhausted",
    exhaustionMarkers: [],
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Runner scale set prerequisite missing/u);
});

test("the scale set preflight fails for the exhaustion marker", () => {
  const result = executeScaleSetPreflight({
    configured: true,
    stoppedReason: null,
    exhaustionMarkers: ["scale-set-not-found-exhausted"],
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Runner scale set prerequisite missing/u);
});

test("the scale set preflight passes a healthy listener status", () => {
  const responseSecret = "listener-response-value-must-stay-secret";
  const result = executeScaleSetPreflight({
    configured: true,
    stoppedReason: null,
    exhaustionMarkers: [],
    sessionId: responseSecret,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /has no runner scale set prerequisite error/u);
  assert.equal(result.stdout.includes(responseSecret), false);
  assert.deepEqual(result.requests, [{
    method: "GET",
    url: "https://worker.example/autopilot/listener/cloudflare-sandbox",
  }]);
});
