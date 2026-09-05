import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { guardDevWorkerTransport } from "./dev-worker-transport.js";

register(new URL("./cloudflare-workers-loader.js", import.meta.url));

process.env.WRANGLER_WRITE_LOGS = "false";

const { unstable_dev } = await import("wrangler");
const { PERMIT_TTL_MS } = await import("../outage-gate/src/gate.js");
const { RESERVATION_TTL_MS } = await import(
  "../src/autopilot-control.js"
);

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = join(TEST_DIRECTORY, "..");
const LISTENER_SOURCE_PATH = join(
  REPOSITORY_DIRECTORY,
  "src",
  "scaleset-listener.js",
);
const REPOSITORY = "example-org/example-repo";
const OUTSIDE_REPOSITORY = "example/not-allowed";
const LISTENER_TOKEN = "listener-outage-token-with-32-characters";
const ADMIN_TOKEN = "operator-admin-token-with-at-least-32-characters";
const CONTROL_TOKEN = "control-token-with-at-least-32-characters";
const WAVE = "wave-1";
const SCALE_SET_ID = 101;

let capacityKeys;
let gate;
let gateKeys;
let gatePersistencePath;
let persistencePath;
let control;
let scopeSequence = 10_000;

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function devOptions(config, vars, persistTo) {
  return {
    config,
    logLevel: "none",
    persist: true,
    persistTo,
    vars,
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false,
    },
  };
}

async function privateKeySecret(keys) {
  return base64Url(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
}

async function gateVars(keys = gateKeys, overrides = {}) {
  return {
    OUTAGE_GATE_ADMIN_TOKEN: ADMIN_TOKEN,
    OUTAGE_GATE_PRIVATE_KEY: await privateKeySecret(keys),
    OUTAGE_GATE_REPOSITORY_ALLOWLIST: [REPOSITORY],
    OUTAGE_GATE_TOKEN: LISTENER_TOKEN,
    ...overrides,
  };
}

async function startGate(keys, persistTo, overrides = {}) {
  return guardDevWorkerTransport(await unstable_dev(
    "outage-gate/src/worker.js",
    devOptions(
      "outage-gate/wrangler.jsonc",
      await gateVars(keys, overrides),
      persistTo,
    ),
  ));
}

function authenticatedHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

async function responseBody(response, expectedStatus) {
  const text = await response.text();
  assert.equal(response.status, expectedStatus, text);
  return JSON.parse(text);
}

function postJson(target, path, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  return target.fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function gateStatus(target = gate, token = ADMIN_TOKEN) {
  const response = await target.fetch("/status", {
    headers: authenticatedHeaders(token),
  });
  return responseBody(response, 200);
}

async function openGate(target = gate) {
  const openedAtMs = Date.now();
  const response = await postJson(target, "/open", ADMIN_TOKEN, {
    action: "open",
    openedAtMs,
    reason: "test setup",
    actor: "outage-gate-test",
  });
  const body = await responseBody(response, 200);
  assert.equal(body.state, "open");
  assert.equal(body.openedAtMs, openedAtMs);
  return body;
}

async function closeGate(target = gate, overrides = {}) {
  const request = {
    action: "close",
    closedAtMs: Date.now(),
    reason: "test closure",
    scaleSetId: SCALE_SET_ID,
    scaleSetName: "cloudflare-sandbox",
    ...overrides,
  };
  const response = await postJson(
    target,
    "/close",
    LISTENER_TOKEN,
    request,
  );
  return {
    request,
    response: await responseBody(response, 200),
  };
}

function permitRequest(overrides = {}) {
  scopeSequence += 1;
  return {
    expiresAtMs: Date.now() + RESERVATION_TTL_MS,
    repository: REPOSITORY,
    runnerRequestId: scopeSequence,
    scaleSetId: SCALE_SET_ID,
    wave: WAVE,
    ...overrides,
  };
}

async function requestPermit(body, target = gate) {
  const response = await postJson(
    target,
    "/permit",
    LISTENER_TOKEN,
    body,
  );
  return responseBody(response, 200);
}

async function controlRpc(name, method, body = {}) {
  const response = await control.fetch(
    `/harness/control/${method}?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function prepareControl(name) {
  assert.deepEqual(await controlRpc(name, "setActiveWave", { wave: WAVE }), {
    updated: true,
    activeWave: WAVE,
  });
  const effectiveAtMs = Date.now();
  const approvedBy = "outage-gate-test";
  const capacity = 10;
  const signature = base64Url(await crypto.subtle.sign(
    "Ed25519",
    capacityKeys.privateKey,
    new TextEncoder().encode(JSON.stringify({
      approvedBy,
      capacity,
      effectiveAtMs,
    })),
  ));
  const approval = await controlRpc(name, "recordCapacityApproval", {
    approvedBy,
    capacity,
    effectiveAtMs,
    signature,
  });
  assert.equal(approval.recorded, true);
  assert.equal((await controlRpc(name, "openGate", {
    nowMs: Date.now(),
  })).opened, true);
}

function reservationInput(request, outagePermit, overrides = {}) {
  return {
    scaleSetId: request.scaleSetId,
    runnerRequestId: request.runnerRequestId,
    repository: request.repository,
    wave: request.wave,
    owner: "listener-1",
    outagePermit,
    nowMs: Date.now(),
    ...overrides,
  };
}

async function reserve(name, request, outagePermit, overrides = {}) {
  return controlRpc(
    name,
    "reserve",
    reservationInput(request, outagePermit, overrides),
  );
}

before(async () => {
  persistencePath = await mkdtemp(join(tmpdir(), "outage-gate-test-"));
  gatePersistencePath = join(persistencePath, "gate");
  gateKeys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  capacityKeys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const gatePublicKey = base64Url(
    await crypto.subtle.exportKey("raw", gateKeys.publicKey),
  );
  const capacityPublicKey = base64Url(
    await crypto.subtle.exportKey("raw", capacityKeys.publicKey),
  );
  [gate, control] = await Promise.all([
    startGate(gateKeys, gatePersistencePath),
    unstable_dev(
      "test/autopilot-harness.js",
      devOptions(
        "test/autopilot-wrangler.jsonc",
        {
          CAPACITY_APPROVAL_PUBLIC_KEY: capacityPublicKey,
          OUTAGE_GATE_PUBLIC_KEY: gatePublicKey,
        },
        join(persistencePath, "control"),
      ),
    ).then(guardDevWorkerTransport),
  ]);
});

after(async () => {
  try {
    await Promise.all([gate?.stop(), control?.stop()]);
  } finally {
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test("a fresh outage gate starts closed", async () => {
  const status = await gateStatus();
  assert.deepEqual(status, {
    state: "closed",
    generation: 0,
    changedAtMs: 0,
    reason: null,
    actor: null,
    livePermits: 0,
  });
  const response = await postJson(
    gate,
    "/permit",
    LISTENER_TOKEN,
    permitRequest(),
  );
  const body = await responseBody(response, 503);
  assert.equal(body.reason, "gate-closed");
});

test("a real gate permit reserves through the real verifier", async () => {
  await openGate();
  const name = `round-trip-${crypto.randomUUID()}`;
  await prepareControl(name);
  const request = permitRequest();
  const permit = await requestPermit(request);
  assert.deepEqual(Object.keys(permit), [
    "permitId",
    "expiresAtMs",
    "signature",
  ]);
  assert.match(permit.signature, /^[A-Za-z0-9_-]+$/u);
  assert.equal(Buffer.from(permit.signature, "base64url").byteLength, 64);

  const result = await reserve(name, request, permit);
  assert.equal(result.reserved, true);
  assert.equal(result.replayed, false);
});

test("a closed gate refuses permits and issues no new row", async () => {
  await openGate();
  const livePermits = (await gateStatus()).livePermits;
  const closed = await closeGate();
  assert.equal(closed.response.state, "closed");
  assert.equal(closed.response.closedAtMs, closed.request.closedAtMs);

  const response = await postJson(
    gate,
    "/permit",
    LISTENER_TOKEN,
    permitRequest(),
  );
  const body = await responseBody(response, 503);
  assert.equal(response.ok, false);
  assert.equal(body.reason, "gate-closed");
  assert.equal((await gateStatus()).livePermits, livePermits);
});

test("the real verifier refuses an expired permit", async () => {
  await openGate();
  const name = `expired-${crypto.randomUUID()}`;
  await prepareControl(name);
  const request = permitRequest();
  const permit = await requestPermit(request);
  const result = await reserve(name, request, permit, {
    nowMs: permit.expiresAtMs,
  });
  assert.deepEqual(result, {
    reserved: false,
    reason: "outage-permit-expired",
  });
});

test("the real verifier refuses a different runner request", async () => {
  await openGate();
  const name = `runner-scope-${crypto.randomUUID()}`;
  await prepareControl(name);
  const request = permitRequest();
  const permit = await requestPermit(request);
  const result = await reserve(name, request, permit, {
    runnerRequestId: request.runnerRequestId + 1,
  });
  assert.deepEqual(result, {
    reserved: false,
    reason: "outage-permit-invalid",
  });
});

test("the real verifier refuses each tampered permit field", async () => {
  await openGate();
  const request = permitRequest();
  const permit = await requestPermit(request);
  for (const [field, value] of [
    ["expiresAtMs", permit.expiresAtMs - 1],
    ["permitId", `${permit.permitId}-tampered`],
  ]) {
    const name = `tampered-${field}-${crypto.randomUUID()}`;
    await prepareControl(name);
    const result = await reserve(name, request, {
      ...permit,
      [field]: value,
    });
    assert.deepEqual(result, {
      reserved: false,
      reason: "outage-permit-invalid",
    });
  }
});

test("the real verifier refuses a permit from a different key", async () => {
  const wrongKeys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const wrongPersistence = join(persistencePath, "wrong-gate");
  const wrongGate = await startGate(wrongKeys, wrongPersistence);
  try {
    await openGate(wrongGate);
    const name = `wrong-key-${crypto.randomUUID()}`;
    await prepareControl(name);
    const request = permitRequest();
    const permit = await requestPermit(request, wrongGate);
    const result = await reserve(name, request, permit);
    assert.deepEqual(result, {
      reserved: false,
      reason: "outage-permit-invalid",
    });
  } finally {
    await wrongGate.stop();
  }
});

test("the real verifier refuses a different repository", async () => {
  await openGate();
  const name = `repository-scope-${crypto.randomUUID()}`;
  await prepareControl(name);
  const request = permitRequest();
  const permit = await requestPermit(request);
  const result = await reserve(name, request, permit, {
    repository: "example/different-repository",
  });
  assert.deepEqual(result, {
    reserved: false,
    reason: "outage-permit-invalid",
  });
});

test("the real verifier refuses a different scale set", async () => {
  await openGate();
  const name = `scale-set-scope-${crypto.randomUUID()}`;
  await prepareControl(name);
  const request = permitRequest();
  const permit = await requestPermit(request);
  const result = await reserve(name, request, permit, {
    scaleSetId: request.scaleSetId + 1,
  });
  assert.deepEqual(result, {
    reserved: false,
    reason: "outage-permit-invalid",
  });
});

test("every mutating endpoint requires its permitted token", async () => {
  const cases = [
    {
      path: "/permit",
      body: permitRequest(),
    },
    {
      path: "/close",
      body: {
        action: "close",
        closedAtMs: Date.now(),
        reason: "auth test",
      },
    },
    {
      path: "/open",
      body: {
        action: "open",
        openedAtMs: Date.now(),
        reason: "auth test",
        actor: "auth-test",
      },
    },
  ];
  for (const scenario of cases) {
    for (const token of [
      undefined,
      "wrongxxx-outage-token-with-32-characters",
      CONTROL_TOKEN,
    ]) {
      const response = await postJson(
        gate,
        scenario.path,
        token,
        scenario.body,
      );
      const text = await response.text();
      assert.equal(
        response.status,
        401,
        `${scenario.path} ${String(token)}: ${text}`,
      );
      assert.deepEqual(JSON.parse(text), { error: "Unauthorized" });
    }
  }

  const listenerOpen = await postJson(gate, "/open", LISTENER_TOKEN, {
    action: "open",
    openedAtMs: Date.now(),
    reason: "least privilege test",
    actor: "listener",
  });
  await responseBody(listenerOpen, 401);
});

test("permit expiry stays inside both required bounds", async () => {
  await openGate();
  assert.ok(PERMIT_TTL_MS < RESERVATION_TTL_MS);
  const request = permitRequest();
  const requestedAtMs = Date.now();
  request.expiresAtMs = requestedAtMs + RESERVATION_TTL_MS;
  const permit = await requestPermit(request);
  const receivedAtMs = Date.now();
  assert.ok(permit.expiresAtMs <= receivedAtMs + PERMIT_TTL_MS);
  assert.ok(permit.expiresAtMs <= request.expiresAtMs);

  const shortRequest = permitRequest({
    expiresAtMs: Date.now() + 10_000,
  });
  const shortPermit = await requestPermit(shortRequest);
  assert.equal(shortPermit.expiresAtMs, shortRequest.expiresAtMs);
});

test("an idempotent permit re-issue replays through the verifier", async () => {
  await openGate();
  const name = `idempotent-${crypto.randomUUID()}`;
  await prepareControl(name);
  const request = permitRequest();
  const firstPermit = await requestPermit(request);
  const secondPermit = await requestPermit(request);
  assert.deepEqual(secondPermit, firstPermit);

  const firstReservation = await reserve(name, request, firstPermit);
  assert.equal(firstReservation.reserved, true);
  assert.equal(firstReservation.replayed, false);
  const replay = await reserve(name, request, secondPermit);
  assert.equal(replay.reserved, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.reservationId, firstReservation.reservationId);
});

test("the repository allow-list refuses an unlisted repository", async () => {
  await openGate();
  const response = await postJson(
    gate,
    "/permit",
    LISTENER_TOKEN,
    permitRequest({ repository: OUTSIDE_REPOSITORY }),
  );
  const body = await responseBody(response, 400);
  assert.deepEqual(body, {
    refused: true,
    reason: "repository-not-allowed",
  });
});

test("a passed start deadline returns a conflict", async () => {
  await openGate();
  const response = await postJson(
    gate,
    "/permit",
    LISTENER_TOKEN,
    permitRequest({ expiresAtMs: Date.now() - 1 }),
  );
  assert.deepEqual(await responseBody(response, 409), {
    refused: true,
    reason: "start-deadline-passed",
  });
});

test("permit request validation refuses malformed fields", async () => {
  await openGate();
  const valid = permitRequest();
  const invalidBodies = [
    null,
    { ...valid, scaleSetId: 0 },
    { ...valid, runnerRequestId: 0 },
    { ...valid, repository: "invalid" },
    { ...valid, wave: "" },
    { ...valid, expiresAtMs: 0 },
  ];
  for (const body of invalidBodies) {
    const response = await postJson(
      gate,
      "/permit",
      LISTENER_TOKEN,
      body,
    );
    const refused = await responseBody(response, 400);
    assert.equal(refused.refused, true);
    assert.equal(typeof refused.reason, "string");
  }
});

test("missing and short secrets fail closed", async () => {
  const misconfiguredPersistence = join(persistencePath, "misconfigured");
  const misconfigured = await startGate(
    gateKeys,
    misconfiguredPersistence,
    { OUTAGE_GATE_TOKEN: "short" },
  );
  try {
    const permit = await postJson(
      misconfigured,
      "/permit",
      "short",
      permitRequest(),
    );
    assert.deepEqual(await responseBody(permit, 503), {
      refused: true,
      reason: "outage-gate-unconfigured",
    });
    const open = await postJson(misconfigured, "/open", ADMIN_TOKEN, {
      action: "open",
      openedAtMs: Date.now(),
      reason: "configuration test",
      actor: "configuration-test",
    });
    assert.deepEqual(await responseBody(open, 500), {
      error: "outage-gate-unconfigured",
    });
  } finally {
    await misconfigured.stop();
  }
});

test("unknown paths and wrong methods return their contract statuses", async () => {
  const missing = await gate.fetch("/missing", {
    headers: authenticatedHeaders(ADMIN_TOKEN),
  });
  await responseBody(missing, 404);
  const wrongMethod = await gate.fetch("/status", {
    method: "POST",
    headers: authenticatedHeaders(ADMIN_TOKEN),
  });
  await responseBody(wrongMethod, 405);
});

test("closed state survives a Worker restart", async () => {
  await openGate();
  const closed = await closeGate(gate, {
    reason: "restart persistence test",
  });
  const generation = closed.response.generation;
  const closedAtMs = closed.response.closedAtMs;
  await gate.stop();
  gate = null;
  gate = await startGate(gateKeys, gatePersistencePath);

  const status = await gateStatus();
  assert.equal(status.state, "closed");
  assert.equal(status.generation, generation);
  assert.equal(status.changedAtMs, closedAtMs);
  assert.equal(status.reason, "restart persistence test");
  const permit = await postJson(
    gate,
    "/permit",
    LISTENER_TOKEN,
    permitRequest(),
  );
  assert.equal(permit.ok, false);
  assert.equal((await permit.json()).reason, "gate-closed");
});

test("the listener source keeps the exact permit request contract", async () => {
  const source = await readFile(LISTENER_SOURCE_PATH, "utf8");
  const methodStart = source.indexOf("async #outagePermit(");
  assert.notEqual(methodStart, -1);
  const literalStart = source.indexOf("const request = {", methodStart);
  assert.notEqual(literalStart, -1);
  const literalEnd = source.indexOf("\n    };", literalStart);
  assert.notEqual(literalEnd, -1);
  const literal = source.slice(literalStart, literalEnd);
  const keys = [...literal.matchAll(/^ {6}([A-Za-z][A-Za-z0-9]*):?/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(keys, [
    "expiresAtMs",
    "repository",
    "runnerRequestId",
    "scaleSetId",
    "wave",
  ]);
});
