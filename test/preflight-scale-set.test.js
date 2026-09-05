import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adminToken,
  githubToken,
  keyedConfig,
  liveResponses,
  privateKey,
  registrationToken,
  runPreflight,
  scaleSetName,
  staticAdminToken,
  validEntry,
} from "./preflight-scale-set-harness.js";

test("a fully valid configuration passes the offline check", () => {
  const result = runPreflight();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /offline scale set configuration is valid/u);
  assert.deepEqual(result.requests, []);
});

test("the configuration can come from a file or the environment", () => {
  for (const configSource of ["file", "environment"]) {
    const result = runPreflight({ configSource });
    assert.equal(result.status, 0, `${configSource}: ${result.stderr}`);
  }
});

test("the supported flat and array configuration shapes resolve", () => {
  for (const config of [validEntry(), [validEntry()]]) {
    const result = runPreflight({ config });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("a missing outageGateUrl fails with the field name", () => {
  const entry = validEntry();
  delete entry.outageGateUrl;
  const result = runPreflight({ config: keyedConfig(entry) });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outageGateUrl/u);
  assert.match(result.stderr, /docs\/AUTOPILOT-OPERATIONS\.md/u);
});

test("a missing scale set identity fails with runnerGroupId", () => {
  const entry = validEntry();
  delete entry.scaleSetId;
  delete entry.runnerGroupId;
  const result = runPreflight({ config: keyedConfig(entry) });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /runnerGroupId/u);
});

test("a scale set name outside SCALE_SET_NAME_PATTERN fails", () => {
  const invalidName = "cloudflare sandbox";
  const result = runPreflight({
    scaleSet: invalidName,
    config: {
      [invalidName]: validEntry({ scaleSetName: invalidName }),
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set scaleSetName, name, or the object key/u);
});

test("one run reports every independent configuration problem", () => {
  const result = runPreflight({
    config: keyedConfig({
      scaleSetName,
      outageGateUrl: "ftp://outage-gate.example/permit",
    }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /outageGateUrl/u);
  assert.match(result.stderr, /runnerGroupId/u);
  assert.match(result.stderr, /admin connection/u);
});

test("duplicate array entries fail exact selection", () => {
  const result = runPreflight({
    config: [validEntry(), validEntry({ scaleSetId: 102 })],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one object/u);
});

test("GitHub App environment fallbacks satisfy the offline check", () => {
  const entry = validEntry();
  delete entry.actionsServiceUrl;
  delete entry.adminToken;
  delete entry.adminTokenExpiresAtMs;
  const result = runPreflight({
    config: keyedConfig(entry),
    env: {
      GITHUB_APP_ID: "1234",
      GITHUB_APP_INSTALLATION_ID: "5678",
      GITHUB_APP_PRIVATE_KEY: privateKey,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(privateKey, "u"));
});

test("GITHUB_TOKEN satisfies the offline admin connection check", () => {
  const entry = validEntry();
  delete entry.actionsServiceUrl;
  delete entry.adminToken;
  delete entry.adminTokenExpiresAtMs;
  const result = runPreflight({
    config: keyedConfig(entry),
    env: { GITHUB_TOKEN: githubToken },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.requests, []);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(githubToken, "u"));
});

test("missing GITHUB_TOKEN names every offline admin connection remedy", () => {
  const entry = validEntry();
  delete entry.actionsServiceUrl;
  delete entry.adminToken;
  delete entry.adminTokenExpiresAtMs;
  const result = runPreflight({
    config: keyedConfig(entry),
    env: { GITHUB_TOKEN: undefined },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /static trio/u);
  assert.match(result.stderr, /GitHub App inputs/u);
  assert.match(result.stderr, /GITHUB_TOKEN/u);
  assert.match(result.stderr, /classic PAT\/OAuth `repo` scope/u);
  assert.match(result.stderr, /fine-grained PAT `Administration: write`/u);
  assert.match(result.stderr, /classic PAT\/OAuth `admin:org` scope/u);
  assert.match(result.stderr, /plus `repo` when the repository is private/u);
  assert.deepEqual(result.requests, []);
});

test("--live reports that an absent runner scale set does not exist", () => {
  const result = runPreflight({
    args: ["--live"],
    responses: liveResponses([]),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /the runner scale set does not exist/iu);
});

test("--live reports the existing scale set id", () => {
  const result = runPreflight({
    args: ["--live"],
    responses: liveResponses([{
      id: 321,
      name: scaleSetName,
      runnerGroupId: 17,
    }]),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scale set exists: id=321 runnerGroupId=17/u);
});

test("--live sends the three required requests in order without leaking tokens", () => {
  const result = runPreflight({
    args: ["--live"],
    responses: liveResponses([{ id: 321, name: scaleSetName }]),
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
        url: "https://actions.example/tenant/_apis/runtime/" +
          "runnerscalesets?runnerGroupId=17&name=cloudflare-sandbox&" +
          "api-version=6.0-preview",
      },
    ],
  );
  assert.ok(
    result.requests[0].headers.includes(`Authorization: Bearer ${githubToken}`),
  );
  assert.ok(
    result.requests[1].headers.includes(
      `Authorization: RemoteAuth ${registrationToken}`,
    ),
  );
  assert.deepEqual(JSON.parse(result.requests[1].body), {
    url: "https://github.com/octo-org/octo-repo",
    runner_event: "register",
  });
  assert.ok(
    result.requests[2].headers.includes(`Authorization: Bearer ${adminToken}`),
  );

  const output = result.stdout + result.stderr;
  for (const token of [
    githubToken,
    registrationToken,
    adminToken,
    staticAdminToken,
  ]) {
    assert.equal(output.includes(token), false, `output leaked ${token}`);
  }
});

test("--live cannot query by scaleSetId alone", () => {
  const entry = validEntry();
  delete entry.runnerGroupId;
  const result = runPreflight({
    config: keyedConfig(entry),
    args: ["--live"],
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot query by scaleSetId alone/u);
  assert.match(result.stderr, /runnerGroupId/u);
  assert.deepEqual(result.requests, []);
});
