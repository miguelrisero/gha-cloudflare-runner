import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adminToken,
  applyResponses,
  createdScaleSetId,
  expectedRequestBody,
  githubToken,
  keyedConfig,
  liveActionsServiceUrl,
  liveResponses,
  privateKey,
  registrationToken,
  runCreateScaleSet,
  runnerGroupId,
  scaleSetName,
  staticActionsServiceUrl,
  staticAdminToken,
  validEntry,
} from "./create-scale-set-harness.js";

function creationRequests(result) {
  return result.requests.filter(({ method, url }) =>
    method === "POST" && url.includes("_apis/runtime/runnerscalesets")
  );
}

function assertNoSecretOutput(result) {
  const output = result.stdout + result.stderr;
  for (const secret of [
    githubToken,
    registrationToken,
    adminToken,
    staticAdminToken,
    privateKey,
  ]) {
    assert.equal(output.includes(secret), false, `output leaked ${secret}`);
  }
}

test("the default mode prints the request and makes no requests", () => {
  const result = runCreateScaleSet();

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(
      `POST ${staticActionsServiceUrl}/_apis/runtime/runnerscalesets` +
      "\\?api-version=6\\.0-preview",
      "u",
    ),
  );
  assert.deepEqual(result.requests, []);
});

test("the default mode prints the exact ARC request body", () => {
  const result = runCreateScaleSet();

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(expectedRequestBody()), result.stdout);
});

test("the default mode prints the Actions Service placeholder", () => {
  const entry = validEntry();
  delete entry.actionsServiceUrl;
  const result = runCreateScaleSet({ config: keyedConfig(entry) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /POST <actionsServiceUrl>\/_apis\/runtime\/runnerscalesets/u,
  );
  assert.deepEqual(result.requests, []);
});

test("--live performs only the three read-only resolution requests", () => {
  const result = runCreateScaleSet({
    args: ["--live"],
    responses: liveResponses(),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.requests.map(({ method, url }) => ({ method, url })),
    [
      {
        method: "POST",
        url: "https://api.github.com/repos/octo-org/octo-repo/" +
          "actions/runners/registration-token",
      },
      {
        method: "POST",
        url: "https://api.github.com/actions/runner-registration",
      },
      {
        method: "GET",
        url: `${liveActionsServiceUrl}/_apis/runtime/runnerscalesets` +
          `?runnerGroupId=${runnerGroupId}&name=${scaleSetName}&` +
          "api-version=6.0-preview",
      },
    ],
  );
  assert.deepEqual(creationRequests(result), []);
  assert.match(result.stdout, new RegExp(`POST ${liveActionsServiceUrl}`, "u"));
});

test("--apply sends one creation POST with the exact ARC body", () => {
  const result = runCreateScaleSet({
    args: ["--apply"],
    responses: applyResponses(),
  });

  assert.equal(result.status, 0, result.stderr);
  const requests = creationRequests(result);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `${liveActionsServiceUrl}/_apis/runtime/runnerscalesets` +
      "?api-version=6.0-preview",
  );
  assert.equal(requests[0].body, expectedRequestBody());
  assert.ok(requests[0].headers.includes("Content-Type: application/json"));
  assert.ok(
    requests[0].headers.includes(`Authorization: Bearer ${adminToken}`),
  );
  const sentUserAgent = requests[0].headers.find((header) =>
    header.startsWith("User-Agent: ")
  );
  assert.equal(
    sentUserAgent,
    "User-Agent: gha-cloudflare-runner-create-scale-set",
  );
  const printedUserAgent = result.stdout.split("\n").find((line) =>
    line.startsWith("User-Agent: ")
  );
  assert.equal(printedUserAgent, sentUserAgent);
});

test("--apply prints the new ID and a sanitized configuration entry", () => {
  const result = runCreateScaleSet({
    args: ["--apply"],
    responses: applyResponses(),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(
      `created scale set: id=${createdScaleSetId} ` +
      `runnerGroupId=${runnerGroupId}`,
      "u",
    ),
  );
  const lines = result.stdout.trim().split("\n");
  const entryLabel = lines.indexOf("AUTOPILOT_SCALE_SETS entry:");
  assert.notEqual(entryLabel, -1);
  const printedConfig = JSON.parse(lines[entryLabel + 1]);
  assert.equal(printedConfig[scaleSetName].scaleSetId, createdScaleSetId);
  assert.equal(printedConfig[scaleSetName].runnerGroupId, runnerGroupId);
  assert.equal("adminToken" in printedConfig[scaleSetName], false);
  assert.equal("privateKeyPkcs8" in printedConfig[scaleSetName], false);
});

test("an existing scale set prevents creation", () => {
  const existingId = 321;
  const result = runCreateScaleSet({
    args: ["--apply"],
    responses: liveResponses([{
      id: existingId,
      name: scaleSetName,
      runnerGroupId,
    }]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`id=${existingId}`, "u"));
  assert.match(
    result.stderr,
    new RegExp(`runnerGroupId=${runnerGroupId}`, "u"),
  );
  assert.deepEqual(creationRequests(result), []);
});

test("every mode rejects a missing or invalid runnerGroupId", () => {
  for (const args of [[], ["--live"], ["--apply"]]) {
    for (const value of [undefined, 0]) {
      const entry = validEntry();
      if (value === undefined) {
        delete entry.runnerGroupId;
      } else {
        entry.runnerGroupId = value;
      }
      const result = runCreateScaleSet({
        config: keyedConfig(entry),
        args,
      });

      assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
      assert.match(result.stderr, /runnerGroupId/u);
      assert.deepEqual(result.requests, []);
    }
  }
});

test("extra labels are System labels and duplicate values are dropped", () => {
  const result = runCreateScaleSet({
    args: [
      "--label",
      "gpu",
      "--label",
      scaleSetName,
      "--label",
      "gpu",
      "--label",
      "arm64",
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(expectedRequestBody({
    labels: [scaleSetName, "gpu", "arm64"],
  })));
});

test("the output never contains any authentication secret", () => {
  const result = runCreateScaleSet({
    args: ["--apply"],
    responses: applyResponses(),
  });

  assert.equal(result.status, 0, result.stderr);
  assertNoSecretOutput(result);
});

test("--runner-group-id overrides the configured value", () => {
  const overrideId = 29;
  const result = runCreateScaleSet({
    args: ["--runner-group-id", String(overrideId), "--live"],
    responses: liveResponses(),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(expectedRequestBody({
    usedRunnerGroupId: overrideId,
  })));
  assert.match(
    result.requests[2].url,
    new RegExp(`runnerGroupId=${overrideId}`, "u"),
  );
});

test("an existing registration token skips its GitHub request", () => {
  const result = runCreateScaleSet({
    args: ["--live", "--registration-token", registrationToken],
    responses: liveResponses().slice(1),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 2);
  assert.equal(
    result.requests[0].url,
    "https://api.github.com/actions/runner-registration",
  );
  assertNoSecretOutput(result);
});

test("an unknown option exits 2 and --help exits 0", () => {
  const unknown = runCreateScaleSet({ args: ["--unknown"] });
  const help = runCreateScaleSet({ args: ["--help"] });

  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option/u);
  assert.equal(help.status, 0, help.stderr);
  assert.match(
    help.stdout,
    /Usage: scripts\/create-scale-set\.sh --scale-set <name>/u,
  );
});
