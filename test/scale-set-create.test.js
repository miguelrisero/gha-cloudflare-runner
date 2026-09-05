import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { guardDevWorkerTransport } from "./dev-worker-transport.js";

process.env.WRANGLER_WRITE_LOGS = "false";

const { unstable_dev } = await import("wrangler");

const GITHUB_TOKEN = "literal-github-token-secret";
const REGISTRATION_TOKEN = "literal-registration-token-secret";
const ADMIN_TOKEN =
  "stub.eyJleHAiOjgwMDAwMDAwMDB9.literal-admin-token-secret";
const SCALE_SET_NAME = "cloudflare-sandbox";
const RUNNER_GROUP_ID = 17;
const CREATED_SCALE_SET_ID = 72;
const EXISTING_SCALE_SET_ID = 71;
const REPOSITORY_ROOT = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

let worker;

function devOptions() {
  return {
    config: "test/scale-set-create-wrangler.jsonc",
    logLevel: "none",
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false,
    },
  };
}

before(async () => {
  worker = guardDevWorkerTransport(await unstable_dev(
    "test/scale-set-create-harness.js",
    devOptions(),
  ));
});

after(async () => {
  await worker?.stop();
});

function organizationScope() {
  return { type: "organization", organization: "example-org" };
}

function repositoryScope() {
  return {
    type: "repository",
    owner: "example-org",
    repository: "example-repo",
  };
}

function validBody(overrides = {}) {
  return {
    scaleSetName: SCALE_SET_NAME,
    runnerGroupId: RUNNER_GROUP_ID,
    scope: organizationScope(),
    ...overrides,
  };
}

async function runScenario(specification = {}) {
  const response = await worker.fetch("/harness/scale-set-create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body: validBody(),
      ...specification,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

function responseBody(result) {
  return JSON.parse(result.body);
}

function assertNoOutboundRequests(result) {
  assert.deepEqual(result.outboundRequests, []);
}

function assertSafeResult(result) {
  const serialized = JSON.stringify({ body: result.body, logs: result.logs });
  for (const secret of [GITHUB_TOKEN, REGISTRATION_TOKEN, ADMIN_TOKEN]) {
    assert.equal(serialized.includes(secret), false);
  }
}

test("the operator route authenticates before every outbound request", async () => {
  for (const authorization of [null, "Bearer wrong-control-token"]) {
    const result = await runScenario({
      authorization,
      rawBody: "not-json",
    });
    assert.equal(result.status, 401);
    assert.deepEqual(responseBody(result), { error: "Unauthorized" });
    assertNoOutboundRequests(result);
  }
});

test("the operator route permits POST only", async () => {
  for (const method of ["GET", "DELETE"]) {
    const result = await runScenario({ method });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, "POST");
    assert.deepEqual(responseBody(result), { error: "Method not allowed" });
    assertNoOutboundRequests(result);
  }
});

test("an organization request creates the exact scale set", async () => {
  const result = await runScenario();

  assert.equal(result.status, 201);
  const expectedResponse = {
    created: true,
    scaleSet: {
      id: CREATED_SCALE_SET_ID,
      name: SCALE_SET_NAME,
      runnerGroupId: RUNNER_GROUP_ID,
    },
  };
  assert.equal(result.body, JSON.stringify(expectedResponse));
  assert.deepEqual(responseBody(result), expectedResponse);
  assert.deepEqual(
    result.outboundRequests.map(({ method }) => method),
    ["POST", "POST", "GET", "POST"],
  );
  assert.equal(
    result.outboundRequests[0].url,
    "https://api.github.com/orgs/example-org/actions/runners/registration-token",
  );
  assert.equal(
    result.outboundRequests[1].url,
    "https://api.github.com/actions/runner-registration",
  );
  assert.deepEqual(result.outboundRequests[1].body, {
    url: "https://github.com/example-org",
    runner_event: "register",
  });
  const lookupUrl = new URL(result.outboundRequests[2].url);
  assert.equal(
    lookupUrl.origin + lookupUrl.pathname,
    "https://actions.stub.test/tenant/_apis/runtime/runnerscalesets",
  );
  assert.equal(lookupUrl.searchParams.get("runnerGroupId"), "17");
  assert.equal(lookupUrl.searchParams.get("name"), SCALE_SET_NAME);
  assert.equal(lookupUrl.searchParams.get("api-version"), "6.0-preview");
  assert.equal(
    result.outboundRequests[3].url,
    "https://actions.stub.test/tenant/_apis/runtime/runnerscalesets?api-version=6.0-preview",
  );
  assert.deepEqual(result.outboundRequests[3].body, {
    name: SCALE_SET_NAME,
    runnerGroupId: RUNNER_GROUP_ID,
    labels: [{ type: "System", name: SCALE_SET_NAME }],
    RunnerSetting: { disableUpdate: true },
    createdOn: "0001-01-01T00:00:00Z",
  });
  assert.equal(
    result.outboundRequests.every((call) =>
      call.authorizationCarriesSecret && call.hasAbortSignal
    ),
    true,
  );
  assert.deepEqual(result.logs, []);
});

test("a repository request uses the repository registration scope", async () => {
  const result = await runScenario({
    body: validBody({ scope: repositoryScope() }),
  });

  assert.equal(result.status, 201);
  assert.equal(
    result.outboundRequests[0].url,
    "https://api.github.com/repos/example-org/example-repo/actions/runners/registration-token",
  );
  assert.deepEqual(result.outboundRequests[1].body, {
    url: "https://github.com/example-org/example-repo",
    runner_event: "register",
  });
});

test("an existing scale set prevents every modifying request", async () => {
  const result = await runScenario({ scenario: "existing" });

  assert.equal(result.status, 200);
  assert.equal(result.body, JSON.stringify({
    created: false,
    scaleSet: {
      id: EXISTING_SCALE_SET_ID,
      name: SCALE_SET_NAME,
      runnerGroupId: RUNNER_GROUP_ID,
    },
  }));
  assert.equal(result.outboundRequests.length, 3);
  assert.equal(
    result.outboundRequests.filter((call) => {
      const url = new URL(call.url);
      return call.method === "POST" &&
        url.pathname.endsWith("/_apis/runtime/runnerscalesets");
    }).length,
    0,
  );
  assert.equal(
    result.outboundRequests.some((call) =>
      call.method === "DELETE" || call.method === "PATCH"
    ),
    false,
  );
});

test("the route refuses a scale set name with the wrong runner label", async () => {
  const result = await runScenario({
    body: validBody({ scaleSetName: "cloudflare-sandbox-other" }),
  });

  assert.equal(result.status, 400);
  assert.deepEqual(responseBody(result), {
    error: `scaleSetName must equal "${SCALE_SET_NAME}"`,
  });
  assertNoOutboundRequests(result);
});

test("the route refuses every invalid runner group ID", async () => {
  for (const runnerGroupId of [0, -1, 1.5, "3"]) {
    const result = await runScenario({
      body: validBody({ runnerGroupId }),
    });
    assert.equal(result.status, 400);
    assert.deepEqual(responseBody(result), {
      error: "runnerGroupId must be a positive safe integer",
    });
    assertNoOutboundRequests(result);
  }
});

test("the route refuses every invalid or missing scope", async () => {
  const bodies = [
    { scaleSetName: SCALE_SET_NAME, runnerGroupId: RUNNER_GROUP_ID },
    validBody({ scope: null }),
    validBody({ scope: [] }),
    validBody({ scope: {} }),
    validBody({ scope: { type: "enterprise", owner: "example" } }),
    validBody({ scope: { type: "organization" } }),
    validBody({ scope: { type: "repository", owner: "example" } }),
  ];
  for (const body of bodies) {
    const result = await runScenario({ body });
    assert.equal(result.status, 400);
    assertNoOutboundRequests(result);
  }
});

test("the route refuses unknown fields and malformed JSON", async () => {
  const unknownField = await runScenario({
    body: validBody({ unexpected: true }),
  });
  assert.equal(unknownField.status, 400);
  assert.deepEqual(responseBody(unknownField), {
    error: "Unknown field: unexpected",
  });
  assertNoOutboundRequests(unknownField);

  const malformed = await runScenario({ rawBody: "not-json" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(responseBody(malformed), {
    error: "The control request body must be valid JSON",
  });
  assertNoOutboundRequests(malformed);
});

test("the route refuses a non-HTTPS configuration URL", async () => {
  for (const configUrl of ["http://github.com/example-org", "not-a-url", 7]) {
    const result = await runScenario({
      body: validBody({ configUrl }),
    });
    assert.equal(result.status, 400);
    assert.deepEqual(responseBody(result), {
      error: "configUrl must be an HTTPS URL",
    });
    assertNoOutboundRequests(result);
  }
});

test("a missing GitHub token stops before every outbound request", async () => {
  for (const githubToken of ["missing", "empty"]) {
    const result = await runScenario({ githubToken });
    assert.equal(result.status, 500);
    assert.deepEqual(responseBody(result), {
      error: "GITHUB_TOKEN is not configured",
    });
    assertNoOutboundRequests(result);
  }
});

test("each outbound failure reports its exact creation phase", async () => {
  const scenarios = new Map([
    ["registration-forbidden", ["registration-token", 403]],
    ["handshake-failure", ["handshake", 500]],
    ["lookup-failure", ["lookup", 502]],
    ["create-failure", ["create", 503]],
  ]);
  for (const [scenario, [phase, status]] of scenarios) {
    const result = await runScenario({ scenario });
    assert.equal(result.status, 502);
    assert.deepEqual(responseBody(result), {
      error: "Failed to create the runner scale set",
      phase,
      detail: {
        name: "ScaleSetRequestError",
        message: "The scale set request returned an unexpected status",
        status,
      },
    });
    assert.equal(result.logs.length, 1);
    assert.equal(JSON.parse(result.logs[0]).phase, phase);
    assertSafeResult(result);
  }
});

test("registration-token response and transport errors cannot leak tokens", async () => {
  for (const scenario of ["registration-forbidden", "registration-throw"]) {
    const result = await runScenario({ scenario });
    assert.equal(result.status, 502);
    assert.equal(responseBody(result).phase, "registration-token");
    assert.equal(result.logs.length, 1);
    assertSafeResult(result);
  }
});

test("the client refuses a malformed scale set creation response", async () => {
  const result = await runScenario({ scenario: "malformed-create" });

  assert.equal(result.status, 502);
  const body = responseBody(result);
  assert.equal(body.phase, "create");
  assert.deepEqual(body.detail, {
    name: "ScaleSetRequestError",
    message: "The scale set request returned a malformed response",
    status: 200,
  });
  assertSafeResult(result);
});

function occurrenceCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

async function sourceFiles(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...await sourceFiles(path));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths;
}

test("scale set creation is unreachable from every automation path", async () => {
  const workerPath = join(REPOSITORY_ROOT, "src/worker.js");
  const listenerPath = join(REPOSITORY_ROOT, "src/scaleset-listener.js");
  const controlPath = join(REPOSITORY_ROOT, "src/autopilot-control.js");
  const [workerSource, listenerSource, controlSource] = await Promise.all([
    readFile(workerPath, "utf8"),
    readFile(listenerPath, "utf8"),
    readFile(controlPath, "utf8"),
  ]);

  assert.equal(occurrenceCount(listenerSource, /createRunnerScaleSet/gu), 0);
  assert.equal(occurrenceCount(controlSource, /createRunnerScaleSet/gu), 0);
  assert.equal(
    occurrenceCount(workerSource, /\bcreateRunnerScaleSet\s*\(/gu),
    1,
  );
  assert.equal(
    occurrenceCount(workerSource, /\/operator\/scale-set\/create/gu),
    1,
  );
  const handlerStart = workerSource.indexOf(
    "async function handleScaleSetCreateRequest",
  );
  const handlerEnd = workerSource.indexOf("\nfunction listenerRoute", handlerStart);
  const routeIndex = workerSource.indexOf("/operator/scale-set/create");
  assert.equal(handlerStart >= 0, true);
  assert.equal(handlerEnd > handlerStart, true);
  assert.equal(routeIndex > handlerStart && routeIndex < handlerEnd, true);

  for (const source of [listenerSource, controlSource]) {
    assert.equal(source.includes("/operator/scale-set/create"), false);
  }
  const automationFiles = [
    ...await sourceFiles(join(REPOSITORY_ROOT, "outage-gate")),
    ...await sourceFiles(join(REPOSITORY_ROOT, ".github/workflows")),
  ];
  for (const path of automationFiles) {
    const source = await readFile(path, "utf8");
    assert.equal(
      source.includes("/operator/scale-set/create"),
      false,
      path,
    );
  }
});
