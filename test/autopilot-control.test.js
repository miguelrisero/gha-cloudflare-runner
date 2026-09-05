import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { guardDevWorkerTransport } from "./dev-worker-transport.js";

register(new URL("./cloudflare-workers-loader.js", import.meta.url));

process.env.WRANGLER_WRITE_LOGS = "false";

const { unstable_dev } = await import("wrangler");
const {
  MAX_ACTIVE_RUNNERS,
  RESERVATION_LIST_PAGE_SIZE,
  RESERVATION_STATES,
  decodeReservationCursor,
} = await import("../src/autopilot-control.js");

const CONTROL_TOKEN = "control-token-with-at-least-32-characters";
const RESERVATION_TTL_MS = 60_000;
const ACTIVE_RUNNER_CLEANUP_DELAY_MS = 3_600_000;
const TEST_NOW_MS = 1_800_000_000_000;
const JIT_SECRET = "opaque-jit-secret-never-log-or-return";
let permitKeys;
let wrongPermitKeys;
let capacityKeys;
let worker;
let unconfiguredWorker;
let persistencePath;

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function devOptions(vars, persistTo) {
  return {
    config: "test/autopilot-wrangler.jsonc",
    logLevel: "none",
    persist: true,
    persistTo,
    ...(vars === undefined ? {} : { vars }),
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false,
    },
  };
}

before(async () => {
  persistencePath = await mkdtemp(
    join(tmpdir(), "autopilot-control-test-"),
  );
  permitKeys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  wrongPermitKeys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  capacityKeys = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const publicKey = base64Url(
    await crypto.subtle.exportKey("raw", permitKeys.publicKey),
  );
  const capacityPublicKey = base64Url(
    await crypto.subtle.exportKey("raw", capacityKeys.publicKey),
  );
  [worker, unconfiguredWorker] = await Promise.all([
    unstable_dev(
      "test/autopilot-harness.js",
      devOptions({
        CAPACITY_APPROVAL_PUBLIC_KEY: capacityPublicKey,
        OUTAGE_GATE_PUBLIC_KEY: publicKey,
      }, join(persistencePath, "configured")),
    ).then(guardDevWorkerTransport),
    unstable_dev(
      "test/autopilot-harness.js",
      devOptions(undefined, join(persistencePath, "unconfigured")),
    ).then(guardDevWorkerTransport),
  ]);
});

after(async () => {
  await Promise.all([
    worker?.stop(),
    unconfiguredWorker?.stop(),
  ]);
  await rm(persistencePath, { recursive: true, force: true });
});

async function rpc(target, name, method, body = {}) {
  const response = await target.fetch(
    `/harness/control/${method}?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const failure = response.status === 200 ? undefined : await response.text();
  assert.equal(response.status, 200, failure);
  return response.json();
}

async function setActiveWave(target, name, wave = "wave-1") {
  const result = await rpc(target, name, "setActiveWave", { wave });
  assert.deepEqual(result, { updated: true, activeWave: wave });
}

async function signPermit({
  keys = permitKeys,
  permitId,
  scaleSetId,
  runnerRequestId,
  repository = "example/runner-test",
  expiresAtMs,
}) {
  const canonical = [
    permitId,
    scaleSetId,
    runnerRequestId,
    repository,
    expiresAtMs,
  ].join(".");
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(canonical),
  );
  return {
    permitId,
    expiresAtMs,
    signature: base64Url(signature),
  };
}

async function reservationInput({
  index,
  nowMs = TEST_NOW_MS,
  permitId = `permit-${index}`,
  scaleSetId = 101,
  runnerRequestId = index,
  repository = "example/runner-test",
  wave = "wave-1",
  owner = "listener-1",
  keys = permitKeys,
  permitExpiresAtMs = nowMs + RESERVATION_TTL_MS,
}) {
  return {
    scaleSetId,
    runnerRequestId,
    repository,
    wave,
    owner,
    nowMs,
    outagePermit: await signPermit({
      keys,
      permitId,
      scaleSetId,
      runnerRequestId,
      repository,
      expiresAtMs: permitExpiresAtMs,
    }),
  };
}

async function reserve(target, name, options) {
  return rpc(
    target,
    name,
    "reserve",
    await reservationInput(options),
  );
}

async function approveCapacity(target, name, capacity) {
  const effectiveAtMs = TEST_NOW_MS;
  const approvedBy = "capacity-owner";
  const canonical = JSON.stringify({ approvedBy, capacity, effectiveAtMs });
  const signature = await crypto.subtle.sign(
    "Ed25519",
    capacityKeys.privateKey,
    new TextEncoder().encode(canonical),
  );
  return rpc(target, name, "recordCapacityApproval", {
    capacity,
    signature: base64Url(signature),
    effectiveAtMs,
    approvedBy,
  });
}

async function consumeRunnerReservation(target, name, index, sandboxId) {
  const reservation = await reserve(target, name, { index });
  assert.equal(reservation.reserved, true);
  assert.equal((await rpc(target, name, "markStartCreated", {
    reservationId: reservation.reservationId,
    correlationId: `release-correlation-${index}`,
    sandboxId,
  })).started, true);
  assert.deepEqual(await rpc(target, name, "consume", {
    reservationId: reservation.reservationId,
    token: reservation.token,
    nowMs: TEST_NOW_MS + 1,
  }), { consumed: true });
  return reservation;
}

async function seedLiveReservations(target, name, count) {
  const result = await rpc(target, name, "seedLiveReservations", {
    count,
    nowMs: TEST_NOW_MS,
    expiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS,
  });
  assert.deepEqual(result, { seeded: count });
}

async function seedReservation(target, name, reservation) {
  assert.deepEqual(
    await rpc(target, name, "seedReservation", reservation),
    { seeded: true },
  );
}

function compareReservationKeys(left, right) {
  if (left.requestedAtMs !== right.requestedAtMs) {
    return left.requestedAtMs < right.requestedAtMs ? -1 : 1;
  }
  if (left.reservationId === right.reservationId) {
    return 0;
  }
  return left.reservationId < right.reservationId ? -1 : 1;
}

function reservationSweepCounts(overrides = {}) {
  return {
    expired: 0,
    runnerHorizonExceeded: 0,
    reclaimTimeMissing: 0,
    timestampsInconsistent: 0,
    ...overrides,
  };
}

async function expectedReservationToken(reservation, input) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CONTROL_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonical = [
    reservation.reservationId,
    reservation.gateGeneration,
    reservation.expiresAtMs,
    input.scaleSetId,
    input.runnerRequestId,
    input.repository,
  ].join(".");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );
  return Buffer.from(signature).toString("hex");
}

function authenticatedHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${CONTROL_TOKEN}`,
    ...extra,
  };
}

function validJitBody(overrides = {}) {
  return {
    jitConfig: JIT_SECRET,
    repository: "example/runner-test",
    reservation: {
      reservationId: "reservation-jit",
      token: "reservation-token",
      expiresAtMs: Date.now() + RESERVATION_TTL_MS,
      gateGeneration: 0,
    },
    scaleSetId: 101,
    runnerRequestId: 501,
    wave: "wave-1",
    ...overrides,
  };
}

async function jitRequest(
  scenario,
  mode,
  body,
  {
    control,
    githubRepository,
    githubRepositoryAllowlist,
    headers = {},
    omitRepositoryAllowlist = false,
    registry,
  } = {},
) {
  const query = new URLSearchParams({ scenario, mode });
  if (control !== undefined) {
    query.set("control", control);
  }
  if (githubRepository !== undefined) {
    query.set("githubRepository", githubRepository);
  }
  if (githubRepositoryAllowlist !== undefined) {
    query.set(
      "githubRepositoryAllowlist",
      JSON.stringify(githubRepositoryAllowlist),
    );
  }
  if (omitRepositoryAllowlist) {
    query.set("omitRepositoryAllowlist", "true");
  }
  if (registry !== undefined) {
    query.set("registry", registry);
  }
  return worker.fetch(`/runners?${query}`, {
    method: "POST",
    headers: authenticatedHeaders({
      "Content-Type": "application/json",
      "Idempotency-Key": `correlation-${scenario}`,
      ...headers,
    }),
    body: JSON.stringify(body),
  });
}

async function repositoryConfig(body) {
  return worker.fetch("/harness/repository-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jitState(scenario, action = "state") {
  const response = await worker.fetch(
    `/harness/jit-${action}?scenario=${encodeURIComponent(scenario)}`,
  );
  const failure = response.status === 200 ? undefined : await response.text();
  assert.equal(response.status, 200, failure);
  return response.json();
}

async function closeKillSwitch(reason) {
  const killResponse = await worker.fetch("/autopilot/control/kill", {
    method: "POST",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ reason }),
  });
  assert.equal(killResponse.status, 200);
  assert.equal((await killResponse.json()).maxCapacity, 0);

  const statusResponse = await worker.fetch("/autopilot/control", {
    headers: authenticatedHeaders(),
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.localGate, "closed");
  assert.equal(status.maxCapacity, 0);
}

async function assertJitOnlyRejection(scenario, requestOptions) {
  await closeKillSwitch(`reject invalid JIT start: ${scenario}`);
  const response = await worker.fetch(
    `/runners?scenario=${encodeURIComponent(scenario)}` +
      "&mode=ready&control=singleton",
    {
      method: "POST",
      ...requestOptions,
      headers: authenticatedHeaders({
        "Idempotency-Key": `correlation-${scenario}`,
        ...(requestOptions.headers ?? {}),
      }),
    },
  );
  assert.equal(response.status, 400);
  const state = await jitState(scenario);
  assert.equal(state.sandboxCreations, 0);
  assert.equal(state.registrationTokenRequests, 0);
  assert.equal(state.registryRows, 0);

  const resumeResponse = await worker.fetch("/autopilot/control/resume", {
    method: "POST",
    headers: authenticatedHeaders(),
  });
  assert.equal(resumeResponse.status, 200);
}

test("a closed kill switch refuses POST /runners with an empty JSON body and spawns nothing", async () => {
  const scenario = `jit-only-empty-json-${crypto.randomUUID()}`;
  await assertJitOnlyRejection(scenario, {
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
});

test("a closed kill switch refuses POST /runners with no body", async () => {
  const scenario = `jit-only-no-body-${crypto.randomUUID()}`;
  await assertJitOnlyRejection(scenario, {});
});

test("a closed kill switch refuses POST /runners with text content", async () => {
  const scenario = `jit-only-text-content-${crypto.randomUUID()}`;
  await assertJitOnlyRejection(scenario, {
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(validJitBody()),
  });
});

test("a closed kill switch refuses POST /runners with a JSON array", async () => {
  const scenario = `jit-only-json-array-${crypto.randomUUID()}`;
  await assertJitOnlyRejection(scenario, {
    headers: { "Content-Type": "application/json" },
    body: "[]",
  });
});

test("a closed kill switch refuses POST /runners without JIT fields", async () => {
  const scenario = `jit-only-no-jit-fields-${crypto.randomUUID()}`;
  await assertJitOnlyRejection(scenario, {
    headers: { "Content-Type": "application/json" },
    body: '{"nope":1}',
  });
});

test("a valid complete JIT body still starts one runner", async () => {
  const scenario = `jit-only-valid-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "pending-readiness",
    validJitBody(),
  );
  assert.equal(response.status, 202);
  const state = await jitState(scenario);
  assert.equal(state.sandboxCreations, 1);
  assert.equal(state.registrationTokenRequests, 0);
  assert.equal(state.registryRows, 1);
  assert.equal(state.processStarts, 1);
  assert.equal(state.startEnvironment.RUNNER_JITCONFIG, JIT_SECRET);
  await jitState(scenario, "release");
});

test("an unlisted repository is refused by name and spawns nothing", async () => {
  const scenario = `repository-unlisted-${crypto.randomUUID()}`;
  const rejectedRepository = "example/unlisted-repository";
  const response = await jitRequest(
    scenario,
    "ready",
    validJitBody({ repository: rejectedRepository }),
    { githubRepositoryAllowlist: ["example/runner-test"] },
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error:
      `repository "${rejectedRepository}" is not in the configured repository allow-list`,
  });
  const state = await jitState(scenario);
  assert.equal(state.sandboxCreations, 0);
  assert.equal(state.registryRows, 0);
  assert.equal(state.processStarts, 0);
});

test("a listed non-default repository configures its own sandbox", async () => {
  const scenario = `repository-listed-${crypto.randomUUID()}`;
  const repository = "example/second-repository";
  const response = await jitRequest(
    scenario,
    "pending-readiness",
    validJitBody({ repository }),
    {
      githubRepositoryAllowlist: [
        "example/runner-test",
        repository,
      ],
    },
  );
  assert.equal(response.status, 202);
  const state = await jitState(scenario);
  assert.equal(
    state.startEnvironment.RUNNER_URL,
    `https://github.com/${repository}`,
  );
  assert.equal(state.sandboxLabels.repository, repository);
  await jitState(scenario, "release");
});

test("repository validation rejects malformed and prohibited names", async () => {
  const cases = [
    {
      repository: "missing-slash",
      message: "repository must use the OWNER/REPO format",
    },
    {
      repository: "example/*",
      message: "repository must use the OWNER/REPO format",
    },
    {
      repository: "example/..",
      message:
        'repository "example/.." is not in the configured repository allow-list',
    },
  ];
  for (const entry of cases) {
    const scenario = `repository-malformed-${crypto.randomUUID()}`;
    const response = await jitRequest(
      scenario,
      "ready",
      validJitBody({ repository: entry.repository }),
      { githubRepositoryAllowlist: ["example/runner-test"] },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: entry.message });
    const state = await jitState(scenario);
    assert.equal(state.sandboxCreations, 0);
  }
});

test("repository allow-list configuration rejects invalid entries", async () => {
  for (const repository of ["example/*", "example/..", "missing-slash"]) {
    const response = await repositoryConfig({
      githubRepositoryAllowlist: [repository],
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /GITHUB_REPOSITORY_ALLOWLIST entry/u);
    assert.equal(body.error.includes(`"${repository}"`), true);
  }
});

test("repository allow-list configuration rejects an empty result", async () => {
  const response = await repositoryConfig({
    githubRepository: "",
    githubRepositoryAllowlist: [],
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "GITHUB_REPOSITORY_ALLOWLIST must contain at least one repository",
  });
});

test("an empty repository allow-list binding uses the default repository", async () => {
  for (const githubRepositoryAllowlist of [[], " , \n\n"]) {
    const response = await repositoryConfig({ githubRepositoryAllowlist });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      repositories: ["example/runner-test"],
    });
  }
});

test("array and separated repository allow-lists normalize equally", async () => {
  const repositories = [
    "example/runner-test",
    "example/second-repository",
    "example/third-repository",
  ];
  const arrayResponse = await repositoryConfig({
    githubRepositoryAllowlist: repositories,
  });
  const stringResponse = await repositoryConfig({
    githubRepositoryAllowlist:
      " example/runner-test, example/second-repository\n\n" +
      "example/third-repository, ",
  });
  assert.equal(arrayResponse.status, 200);
  assert.equal(stringResponse.status, 200);
  assert.deepEqual(await arrayResponse.json(), { repositories });
  assert.deepEqual(await stringResponse.json(), { repositories });
});

test("legacy repository configuration keeps exact default containment", async () => {
  const acceptedScenario = `repository-legacy-accepted-${crypto.randomUUID()}`;
  const accepted = await jitRequest(
    acceptedScenario,
    "pending-readiness",
    validJitBody(),
    { omitRepositoryAllowlist: true },
  );
  assert.equal(accepted.status, 202);
  await jitState(acceptedScenario, "release");

  const rejectedScenario = `repository-legacy-rejected-${crypto.randomUUID()}`;
  const rejectedRepository = "example/other-repository";
  const rejected = await jitRequest(
    rejectedScenario,
    "ready",
    validJitBody({ repository: rejectedRepository }),
    { omitRepositoryAllowlist: true },
  );
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), {
    error:
      `repository "${rejectedRepository}" is not in the configured repository allow-list`,
  });
  assert.equal((await jitState(rejectedScenario)).sandboxCreations, 0);
});

test("an absent capacity approval grants no capacity", async () => {
  const name = `capacity-unapproved-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  const policyGuard = await approveCapacity(
    worker,
    name,
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(policyGuard.recorded, false);
  assert.equal(policyGuard.reason, "exceeds-policy-guard");
  assert.equal(policyGuard.guard, "MAX_ACTIVE_RUNNERS");

  const unapprovedStatus = await rpc(worker, name, "status");
  assert.equal(unapprovedStatus.localGate, "open");
  assert.equal(unapprovedStatus.approvedCapacity, 0);
  assert.equal(unapprovedStatus.maxCapacity, 0);
  assert.equal(unapprovedStatus.liveReservationCount, 0);
  assert.deepEqual(
    await reserve(worker, name, { index: 100 }),
    { reserved: false, reason: "capacity-unapproved" },
  );
  assert.equal(
    (await rpc(worker, name, "status")).liveReservationCount,
    0,
  );

  const approvedCapacity = 2;
  assert.equal(
    (await approveCapacity(worker, name, approvedCapacity)).recorded,
    true,
  );
  const approvedStatus = await rpc(worker, name, "status");
  assert.equal(approvedStatus.approvedCapacity, approvedCapacity);
  assert.equal(approvedStatus.maxCapacity, approvedCapacity);
  for (let index = 1; index <= approvedCapacity; index += 1) {
    assert.equal(
      (await reserve(worker, name, { index })).reserved,
      true,
    );
  }
  assert.deepEqual(
    await reserve(worker, name, { index: approvedCapacity + 1 }),
    { reserved: false, reason: "capacity-exhausted" },
  );
});

test("maxCapacity follows the local gate", async () => {
  const name = `gate-${crypto.randomUUID()}`;
  assert.equal(
    (await approveCapacity(worker, name, MAX_ACTIVE_RUNNERS)).recorded,
    true,
  );
  const initial = await rpc(worker, name, "status");
  assert.equal(initial.localGate, "open");
  assert.equal(initial.maxCapacity, MAX_ACTIVE_RUNNERS);

  const closed = await rpc(worker, name, "closeGate", {
    reason: "operator test",
    nowMs: TEST_NOW_MS,
  });
  assert.equal(closed.changed, true);
  assert.equal(closed.gateGeneration, initial.gateGeneration + 1);
  assert.equal((await rpc(worker, name, "status")).maxCapacity, 0);

  const closedReplay = await rpc(worker, name, "closeGate", {
    reason: "operator test replay",
    nowMs: TEST_NOW_MS + 1,
  });
  assert.equal(closedReplay.changed, false);
  assert.equal(closedReplay.gateGeneration, closed.gateGeneration);

  const opened = await rpc(worker, name, "openGate", {
    nowMs: TEST_NOW_MS + 2,
  });
  assert.equal(opened.changed, true);
  assert.equal(opened.gateGeneration, closed.gateGeneration + 1);
  assert.equal(opened.maxCapacity, MAX_ACTIVE_RUNNERS);
});

test("capacity approval enforces MAX_ACTIVE_RUNNERS", async () => {
  const name = `capacity-guard-${crypto.randomUUID()}`;
  for (const capacity of [
    MAX_ACTIVE_RUNNERS + 1,
    MAX_ACTIVE_RUNNERS + 2,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const result = await approveCapacity(worker, name, capacity);
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "exceeds-policy-guard");
    assert.equal(result.guard, "MAX_ACTIVE_RUNNERS");
    assert.equal(result.guardValue, MAX_ACTIVE_RUNNERS);
    assert.equal(result.offeredCapacity, capacity);
  }

  for (const capacity of [MAX_ACTIVE_RUNNERS, 1, 0]) {
    const result = await approveCapacity(worker, name, capacity);
    assert.equal(result.recorded, true);
    assert.equal(result.approvedCapacity, capacity);
  }
  const status = await rpc(worker, name, "status");
  assert.equal(status.approvedCapacity, 0);
  assert.equal(status.maxCapacity, 0);
});

test("capacity approval rejects a wrong key and an unset key", async () => {
  const approval = {
    approvedBy: "capacity-owner",
    capacity: 3,
    effectiveAtMs: TEST_NOW_MS,
  };
  const wrongSignature = await crypto.subtle.sign(
    "Ed25519",
    wrongPermitKeys.privateKey,
    new TextEncoder().encode(JSON.stringify(approval)),
  );
  assert.deepEqual(
    await rpc(
      worker,
      `capacity-wrong-key-${crypto.randomUUID()}`,
      "recordCapacityApproval",
      { ...approval, signature: base64Url(wrongSignature) },
    ),
    { recorded: false, reason: "capacity-approval-invalid" },
  );
  const validSignature = await crypto.subtle.sign(
    "Ed25519",
    capacityKeys.privateKey,
    new TextEncoder().encode(JSON.stringify(approval)),
  );
  assert.deepEqual(
    await rpc(
      unconfiguredWorker,
      `capacity-unconfigured-${crypto.randomUUID()}`,
      "recordCapacityApproval",
      { ...approval, signature: base64Url(validSignature) },
    ),
    { recorded: false, reason: "capacity-approval-unconfigured" },
  );
});

test("approved capacity rejects the fourth reservation at three", async () => {
  const approvedName = `capacity-three-${crypto.randomUUID()}`;
  await setActiveWave(worker, approvedName);
  assert.equal((await approveCapacity(worker, approvedName, 3)).recorded, true);
  for (let index = 1; index <= 3; index += 1) {
    assert.equal(
      (await reserve(worker, approvedName, { index })).reserved,
      true,
    );
  }
  assert.deepEqual(
    await reserve(worker, approvedName, { index: 4 }),
    { reserved: false, reason: "capacity-exhausted" },
  );

  const policyName = `capacity-policy-${crypto.randomUUID()}`;
  await setActiveWave(worker, policyName);
  assert.equal(
    (await approveCapacity(worker, policyName, MAX_ACTIVE_RUNNERS)).recorded,
    true,
  );
  await seedLiveReservations(worker, policyName, MAX_ACTIVE_RUNNERS);
  assert.deepEqual(
    await reserve(worker, policyName, { index: MAX_ACTIVE_RUNNERS + 1 }),
    { reserved: false, reason: "capacity-exhausted" },
  );
});

test("concurrent reservations stop at MAX_ACTIVE_RUNNERS", async () => {
  const name = `capacity-concurrent-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal(
    (await approveCapacity(worker, name, MAX_ACTIVE_RUNNERS)).recorded,
    true,
  );
  await seedLiveReservations(worker, name, MAX_ACTIVE_RUNNERS - 1);
  const inputs = await Promise.all(
    Array.from(
      { length: 2 },
      (_, offset) => reservationInput({
        index: MAX_ACTIVE_RUNNERS + offset,
      }),
    ),
  );
  const results = await Promise.all(
    inputs.map((input) => rpc(worker, name, "reserve", input)),
  );
  assert.equal(results.filter((result) => result.reserved).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.reserved),
    [{ reserved: false, reason: "capacity-exhausted" }],
  );
  assert.equal(
    (await rpc(worker, name, "status")).liveReservationCount,
    MAX_ACTIVE_RUNNERS,
  );
});

test("admission refuses a closed gate and an inactive wave", async () => {
  const name = `admission-gates-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  await rpc(worker, name, "closeGate", {
    reason: "admission gate test",
    nowMs: TEST_NOW_MS,
  });
  assert.deepEqual(
    await reserve(worker, name, { index: 1 }),
    { reserved: false, reason: "local-gate-closed" },
  );

  await rpc(worker, name, "openGate", { nowMs: TEST_NOW_MS + 1 });
  assert.deepEqual(
    await reserve(worker, name, { index: 2, wave: "wave-2" }),
    { reserved: false, reason: "wave-not-active" },
  );
});

test("reservation replay returns one live reservation", async () => {
  const name = `reservation-replay-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal(
    (await approveCapacity(worker, name, MAX_ACTIVE_RUNNERS)).recorded,
    true,
  );
  const input = await reservationInput({ index: 1 });
  const first = await rpc(worker, name, "reserve", input);
  const second = await rpc(worker, name, "reserve", input);
  assert.equal(first.reserved, true);
  assert.equal(first.replayed, false);
  assert.equal(second.reserved, true);
  assert.equal(second.replayed, true);
  assert.equal(second.reservationId, first.reservationId);
  assert.equal(second.token, first.token);
  assert.equal(first.expiresAtMs, input.nowMs + RESERVATION_TTL_MS);
  assert.equal(first.token, await expectedReservationToken(first, input));
  const status = await rpc(worker, name, "status");
  assert.equal(status.liveReservationCount, 1);
  assert.equal(status.maxCapacity, MAX_ACTIVE_RUNNERS);
});

test("absent capacity approval refuses consume and reservation replay", async () => {
  const name = `absent-capacity-replay-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  const input = await reservationInput({ index: 1 });
  const reservationId = crypto.randomUUID();
  assert.deepEqual(
    await rpc(worker, name, "seedStartCreatedReservation", {
      reservationId,
      scaleSetId: input.scaleSetId,
      runnerRequestId: input.runnerRequestId,
      repository: input.repository,
      wave: input.wave,
      owner: input.owner,
      expiresAtMs: input.nowMs + RESERVATION_TTL_MS,
      nowMs: input.nowMs,
    }),
    { seeded: true },
  );
  assert.deepEqual(
    await rpc(worker, name, "reserve", input),
    { reserved: false, reason: "capacity-unapproved" },
  );
  const token = await expectedReservationToken({
    reservationId,
    gateGeneration: 0,
    expiresAtMs: input.nowMs + RESERVATION_TTL_MS,
  }, input);
  assert.deepEqual(
    await rpc(worker, name, "consume", {
      reservationId,
      token,
      nowMs: TEST_NOW_MS + 1,
    }),
    { consumed: false, reason: "capacity-unapproved" },
  );
});

test("signed zero capacity admits replay and consume but refuses new work", async () => {
  const name = `zero-capacity-replay-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 1)).recorded, true);
  const input = await reservationInput({ index: 1 });
  const reservation = await rpc(worker, name, "reserve", input);
  assert.equal(reservation.reserved, true);
  assert.equal(
    (await rpc(worker, name, "markStartCreated", {
      reservationId: reservation.reservationId,
      correlationId: "zero-capacity-replay-correlation",
      sandboxId: "runner-zero-capacity-replay",
    })).started,
    true,
  );
  assert.equal((await approveCapacity(worker, name, 0)).recorded, true);
  const replay = await rpc(worker, name, "reserve", input);
  assert.equal(replay.reserved, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.reservationId, reservation.reservationId);
  assert.deepEqual(
    await rpc(worker, name, "consume", {
      reservationId: reservation.reservationId,
      token: reservation.token,
      nowMs: TEST_NOW_MS + 1,
    }),
    { consumed: true },
  );
  assert.deepEqual(
    await reserve(worker, name, { index: 2 }),
    { reserved: false, reason: "capacity-exhausted" },
  );
});

test("consume accepts a reservation token once", async () => {
  const name = `consume-once-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 1)).recorded, true);
  const reservation = await reserve(worker, name, { index: 1 });
  const started = await rpc(worker, name, "markStartCreated", {
    reservationId: reservation.reservationId,
    correlationId: "consume-once-correlation",
    sandboxId: "runner-consume-once",
  });
  assert.equal(started.started, true);
  assert.deepEqual(
    await rpc(worker, name, "consume", {
      reservationId: reservation.reservationId,
      token: reservation.token,
      nowMs: TEST_NOW_MS + 1,
    }),
    { consumed: true },
  );
  assert.deepEqual(
    await rpc(worker, name, "consume", {
      reservationId: reservation.reservationId,
      token: reservation.token,
      nowMs: TEST_NOW_MS + 2,
    }),
    { consumed: false, reason: "already-consumed" },
  );
});

test("consume refuses an invalid reservation token", async () => {
  const name = `consume-token-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 1)).recorded, true);
  const reservation = await reserve(worker, name, { index: 1 });
  assert.equal(
    (await rpc(worker, name, "markStartCreated", {
      reservationId: reservation.reservationId,
      correlationId: "consume-token-correlation",
      sandboxId: "runner-consume-token",
    })).started,
    true,
  );
  assert.deepEqual(
    await rpc(worker, name, "consume", {
      reservationId: reservation.reservationId,
      token: `${reservation.token}0`,
      nowMs: TEST_NOW_MS + 1,
    }),
    { consumed: false, reason: "token-invalid" },
  );
  assert.deepEqual(
    await rpc(worker, name, "consume", {
      reservationId: reservation.reservationId,
      token: reservation.token,
      nowMs: TEST_NOW_MS + 2,
    }),
    { consumed: true },
  );
});

test("markStartCreated refuses a second state transition", async () => {
  const name = `mark-state-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 1)).recorded, true);
  const reservation = await reserve(worker, name, { index: 1 });
  const transition = {
    reservationId: reservation.reservationId,
    correlationId: "mark-state-correlation",
    sandboxId: "runner-mark-state",
  };
  assert.equal(
    (await rpc(worker, name, "markStartCreated", transition)).started,
    true,
  );
  assert.deepEqual(
    await rpc(worker, name, "markStartCreated", transition),
    { started: false, reason: "invalid-state", state: "start-created" },
  );
});

test("compensate releases a reservation idempotently", async () => {
  const name = `compensate-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 1)).recorded, true);
  const reservation = await reserve(worker, name, { index: 1 });
  assert.deepEqual(
    await rpc(worker, name, "compensate", {
      reservationId: reservation.reservationId,
      reason: "cancelled",
    }),
    { compensated: true, replayed: false },
  );
  assert.deepEqual(
    await rpc(worker, name, "compensate", {
      reservationId: reservation.reservationId,
      reason: "cancelled again",
    }),
    { compensated: true, replayed: true },
  );
  assert.equal(
    (await rpc(worker, name, "status")).liveReservationCount,
    0,
  );
});

test("a destroyed runner's reservation frees exactly one capacity slot", async () => {
  const name = `release-capacity-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 2)).recorded, true);
  const first = await consumeRunnerReservation(
    worker,
    name,
    1,
    "runner-release-capacity-first",
  );
  await consumeRunnerReservation(
    worker,
    name,
    2,
    "runner-release-capacity-second",
  );

  assert.equal(
    (await rpc(worker, name, "status")).liveReservationCount,
    2,
  );
  assert.deepEqual(
    await reserve(worker, name, { index: 3 }),
    { reserved: false, reason: "capacity-exhausted" },
  );
  assert.deepEqual(
    await rpc(worker, name, "releaseBySandbox", {
      sandboxId: "runner-release-capacity-first",
      reason: "runner-destroyed",
    }),
    {
      released: true,
      replayed: false,
      reservationId: first.reservationId,
    },
  );
  assert.equal(
    (await rpc(worker, name, "status")).liveReservationCount,
    1,
  );
  assert.equal((await reserve(worker, name, { index: 3 })).reserved, true);
});

test("releasing the same sandbox twice frees only one slot", async () => {
  const name = `release-replay-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 2)).recorded, true);
  const first = await consumeRunnerReservation(
    worker,
    name,
    1,
    "runner-release-replay-first",
  );
  await consumeRunnerReservation(
    worker,
    name,
    2,
    "runner-release-replay-second",
  );
  assert.equal((await rpc(worker, name, "releaseBySandbox", {
    sandboxId: "runner-release-replay-first",
    reason: "runner-destroyed",
  })).released, true);
  assert.equal((await reserve(worker, name, { index: 3 })).reserved, true);
  const countBeforeReplay = (await rpc(worker, name, "status"))
    .liveReservationCount;

  assert.deepEqual(
    await rpc(worker, name, "releaseBySandbox", {
      sandboxId: "runner-release-replay-first",
      reason: "runner-destroyed",
    }),
    {
      released: true,
      replayed: true,
      reservationId: first.reservationId,
    },
  );
  assert.equal(
    (await rpc(worker, name, "status")).liveReservationCount,
    countBeforeReplay,
  );
  assert.deepEqual(
    await reserve(worker, name, { index: 4 }),
    { reserved: false, reason: "capacity-exhausted" },
  );
});

test("a live runner's reservation is never released", async () => {
  const name = `release-live-runner-${crypto.randomUUID()}`;
  const retainedSandboxId = "runner-release-live-retained";
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 2)).recorded, true);
  await consumeRunnerReservation(
    worker,
    name,
    1,
    "runner-release-live-destroyed",
  );
  const retained = await consumeRunnerReservation(
    worker,
    name,
    2,
    retainedSandboxId,
  );
  assert.equal((await rpc(worker, name, "releaseBySandbox", {
    sandboxId: "runner-release-live-destroyed",
    reason: "runner-destroyed",
  })).released, true);

  const live = await rpc(worker, name, "listReservations", {
    state: "consumed",
    limit: MAX_ACTIVE_RUNNERS,
  });
  assert.equal(live.reservations.length, 1);
  assert.equal(live.reservations[0].reservationId, retained.reservationId);
  assert.equal(live.reservations[0].sandboxId, retainedSandboxId);
  assert.equal(live.reservations[0].state, "consumed");
  assert.equal((await rpc(worker, name, "status")).liveReservationCount, 1);
  assert.deepEqual(
    await rpc(worker, name, "releaseBySandbox", {
      sandboxId: "runner-release-live-unknown",
      reason: "runner-destroyed",
    }),
    { released: false, reason: "reservation-not-found" },
  );
  assert.equal((await rpc(worker, name, "status")).liveReservationCount, 1);
});

test("the capacity ceiling still binds after a release", async () => {
  const name = `release-capacity-ceiling-${crypto.randomUUID()}`;
  const approvedCapacity = 3;
  await setActiveWave(worker, name);
  assert.equal(
    (await approveCapacity(worker, name, approvedCapacity)).recorded,
    true,
  );
  const reservations = [];
  for (let index = 1; index <= approvedCapacity; index += 1) {
    reservations.push(await consumeRunnerReservation(
      worker,
      name,
      index,
      `runner-release-ceiling-${index}`,
    ));
  }
  assert.equal(
    (await rpc(worker, name, "status")).maxCapacity,
    Math.min(MAX_ACTIVE_RUNNERS, approvedCapacity),
  );
  assert.deepEqual(
    await reserve(worker, name, { index: approvedCapacity + 1 }),
    { reserved: false, reason: "capacity-exhausted" },
  );

  assert.deepEqual(await rpc(worker, name, "releaseBySandbox", {
    sandboxId: "runner-release-ceiling-1",
    reason: "runner-destroyed",
  }), {
    released: true,
    replayed: false,
    reservationId: reservations[0].reservationId,
  });
  assert.equal(
    (await reserve(worker, name, { index: approvedCapacity + 1 })).reserved,
    true,
  );
  assert.deepEqual(
    await reserve(worker, name, { index: approvedCapacity + 2 }),
    { reserved: false, reason: "capacity-exhausted" },
  );
  assert.equal(
    (await rpc(worker, name, "status")).liveReservationCount,
    Math.min(MAX_ACTIVE_RUNNERS, approvedCapacity),
  );
});

test("releaseBySandbox rejects an empty sandbox identifier and an empty reason", async () => {
  const name = `release-validation-${crypto.randomUUID()}`;
  assert.deepEqual(
    await rpc(worker, name, "releaseBySandboxError", {
      sandboxId: "",
      reason: "runner-destroyed",
    }),
    {
      threw: true,
      errorName: "TypeError",
      error: "sandboxId must be a non-empty string",
    },
  );
  assert.deepEqual(
    await rpc(worker, name, "releaseBySandboxError", {
      sandboxId: "runner-release-validation",
      reason: "",
    }),
    {
      threw: true,
      errorName: "TypeError",
      error: "reason must be a non-empty string",
    },
  );
});

test("releaseBySandbox refuses to guess between two live reservations on one sandbox", async () => {
  const name = `release-ambiguous-${crypto.randomUUID()}`;
  const sandboxId = "runner-release-ambiguous";
  await setActiveWave(worker, name);
  assert.deepEqual(
    await rpc(worker, name, "seedDuplicateSandboxReservations", {
      sandboxId,
    }),
    { seeded: 2 },
  );
  assert.deepEqual(
    await rpc(worker, name, "releaseBySandboxError", {
      sandboxId,
      reason: "runner-destroyed",
    }),
    {
      threw: true,
      errorName: "Error",
      error: "The sandbox has multiple live reservations",
    },
  );
  assert.equal((await rpc(worker, name, "status")).liveReservationCount, 2);
});

test("a gate generation transition supersedes an unconsumed token", async () => {
  const name = `generation-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 1)).recorded, true);
  const reservation = await reserve(worker, name, { index: 1 });
  assert.equal(
    (await rpc(worker, name, "markStartCreated", {
      reservationId: reservation.reservationId,
      correlationId: "generation-correlation",
      sandboxId: "runner-generation",
    })).started,
    true,
  );
  await rpc(worker, name, "closeGate", {
    reason: "generation test",
    nowMs: TEST_NOW_MS + 1,
  });
  assert.deepEqual(
    await rpc(worker, name, "consume", {
      reservationId: reservation.reservationId,
      token: reservation.token,
      nowMs: TEST_NOW_MS + 2,
    }),
    { consumed: false, reason: "generation-superseded" },
  );
});

test("an expired reservation is compensated and frees its slot", async () => {
  const name = `expiry-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  await approveCapacity(worker, name, 1);
  const permitId = "expiry-reusable-permit";
  const first = await reserve(worker, name, { index: 1, permitId });
  assert.equal(first.reserved, true);
  const nextNowMs = TEST_NOW_MS + RESERVATION_TTL_MS + 1;
  const second = await reserve(worker, name, {
    index: 2,
    nowMs: nextNowMs,
    permitId,
  });
  assert.equal(second.reserved, true);

  const page = await rpc(worker, name, "listReservations", {
    state: "compensated",
    limit: MAX_ACTIVE_RUNNERS,
  });
  assert.equal(page.reservations.length, 1);
  assert.equal(page.reservations[0].reservationId, first.reservationId);
  assert.equal(page.reservations[0].compensationReason, "expired");
  assert.equal(
    (await rpc(worker, name, "status")).liveReservationCount,
    1,
  );
});

test("the control alarm releases a consumed reservation at the runner horizon", async () => {
  const name = `consumed-horizon-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 1)).recorded, true);
  const reservation = await reserve(worker, name, { index: 1 });
  assert.equal((await rpc(worker, name, "markStartCreated", {
    reservationId: reservation.reservationId,
    correlationId: "consumed-horizon-correlation",
    sandboxId: "runner-consumed-horizon",
  })).started, true);
  assert.deepEqual(await rpc(worker, name, "consume", {
    reservationId: reservation.reservationId,
    token: reservation.token,
    nowMs: TEST_NOW_MS + 1,
  }), { consumed: true });

  const alarmNowMs = TEST_NOW_MS + ACTIVE_RUNNER_CLEANUP_DELAY_MS + 2;
  await rpc(worker, name, "alarm", { nowMs: alarmNowMs });
  const next = await reserve(worker, name, {
    index: 2,
    nowMs: alarmNowMs,
  });
  assert.equal(next.reserved, true);
  const compensated = await rpc(worker, name, "listReservations", {
    state: "compensated",
    limit: MAX_ACTIVE_RUNNERS,
  });
  assert.equal(compensated.reservations[0].reservationId, reservation.reservationId);
  assert.equal(
    compensated.reservations[0].compensationReason,
    "runner-horizon-exceeded",
  );
});

test("the control alarm prunes terminal reservations after the runner horizon", async () => {
  const name = `terminal-prune-${crypto.randomUUID()}`;
  const reservationId = "old-compensated-reservation";
  await rpc(worker, name, "seedCompensatedReservation", {
    reservationId,
    compensatedAtMs: TEST_NOW_MS - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1,
  });
  assert.deepEqual(
    await rpc(worker, name, "reservationExists", { reservationId }),
    { exists: true },
  );
  await rpc(worker, name, "alarm", { nowMs: TEST_NOW_MS });
  assert.deepEqual(
    await rpc(worker, name, "reservationExists", { reservationId }),
    { exists: false },
  );
});

test("a reservation cursor walks every row exactly once", async () => {
  const name = `reservation-cursor-walk-${crypto.randomUUID()}`;
  const reservationCount = RESERVATION_LIST_PAGE_SIZE + 1;
  await setActiveWave(worker, name);
  await seedLiveReservations(worker, name, reservationCount);

  const expectedReservationIds = new Set(
    Array.from(
      { length: reservationCount },
      (_, index) => `seeded-reservation-${index + 1}`,
    ),
  );
  const seenReservationIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  do {
    const page = await rpc(worker, name, "listReservations", {
      cursor: decodeReservationCursor(cursor),
      nowMs: TEST_NOW_MS,
    });
    for (const reservation of page.reservations) {
      assert.equal(seenReservationIds.has(reservation.reservationId), false);
      seenReservationIds.add(reservation.reservationId);
    }
    if (page.nextCursor !== null) {
      assert.equal(seenCursors.has(page.nextCursor), false);
      seenCursors.add(page.nextCursor);
    }
    assert.equal(page.hasMore, page.nextCursor !== null);
    cursor = page.nextCursor;
  } while (cursor !== null);

  assert.deepEqual(seenReservationIds, expectedReservationIds);
});

test("reservation cursor pages advance in a strict order and terminate", async () => {
  const name = `reservation-cursor-termination-${crypto.randomUUID()}`;
  const reservationCount = 2 * RESERVATION_LIST_PAGE_SIZE + 1;
  const expectedPageCount = Math.ceil(
    reservationCount / RESERVATION_LIST_PAGE_SIZE,
  );
  await setActiveWave(worker, name);
  await seedLiveReservations(worker, name, reservationCount);

  let cursor = null;
  let previousLast = null;
  for (let pageIndex = 0; pageIndex < expectedPageCount; pageIndex += 1) {
    const page = await rpc(worker, name, "listReservations", {
      cursor: decodeReservationCursor(cursor),
      nowMs: TEST_NOW_MS,
    });
    assert.ok(page.reservations.length > 0);
    for (let index = 1; index < page.reservations.length; index += 1) {
      assert.ok(
        compareReservationKeys(
          page.reservations[index],
          page.reservations[index - 1],
        ) > 0,
      );
    }
    if (previousLast !== null) {
      assert.ok(
        compareReservationKeys(page.reservations[0], previousLast) > 0,
      );
    }
    previousLast = page.reservations.at(-1);
    if (pageIndex === expectedPageCount - 1) {
      assert.equal(page.nextCursor, null);
      assert.equal(page.hasMore, false);
    } else {
      assert.notEqual(page.nextCursor, null);
      assert.equal(page.hasMore, true);
    }
    cursor = page.nextCursor;
  }
  assert.equal(cursor, null);
});

test("reservation cursors preserve tied request times across pages", async () => {
  const name = `reservation-cursor-ties-${crypto.randomUUID()}`;
  const reservationCount = 5;
  const limit = 2;
  await setActiveWave(worker, name);
  await seedLiveReservations(worker, name, reservationCount);

  const reservationIds = [];
  let cursor = null;
  do {
    const page = await rpc(worker, name, "listReservations", {
      cursor: decodeReservationCursor(cursor),
      limit,
      nowMs: TEST_NOW_MS,
    });
    for (const reservation of page.reservations) {
      assert.equal(reservation.requestedAtMs, TEST_NOW_MS);
      reservationIds.push(reservation.reservationId);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  const expectedReservationIds = Array.from(
    { length: reservationCount },
    (_, index) => `seeded-reservation-${index + 1}`,
  ).sort();
  assert.deepEqual(reservationIds, expectedReservationIds);
  assert.equal(new Set(reservationIds).size, reservationCount);
});

test("the reservation route rejects a malformed cursor with status 400", async () => {
  const [cursorResponse, limitResponse] = await Promise.all([
    worker.fetch(
      "/autopilot/control/reservations?cursor=not-a-reservation-cursor",
      { headers: authenticatedHeaders() },
    ),
    worker.fetch(
      "/autopilot/control/reservations?limit=not-a-limit",
      { headers: authenticatedHeaders() },
    ),
  ]);
  assert.equal(cursorResponse.status, limitResponse.status);
  assert.equal(cursorResponse.status, 400);
  assert.deepEqual(await cursorResponse.json(), {
    error: "cursor must be a reservation cursor",
  });
});

test("the reservation page-size clamp remains a ceiling", async () => {
  const name = `reservation-page-clamp-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  await seedLiveReservations(
    worker,
    name,
    RESERVATION_LIST_PAGE_SIZE + 1,
  );

  const page = await rpc(worker, name, "listReservations", {
    limit: RESERVATION_LIST_PAGE_SIZE + 1,
    nowMs: TEST_NOW_MS,
  });
  assert.equal(page.pageSize, RESERVATION_LIST_PAGE_SIZE);
  assert.equal(page.summary.pageSize, RESERVATION_LIST_PAGE_SIZE);
  assert.equal(page.reservations.length, RESERVATION_LIST_PAGE_SIZE);
  assert.equal(page.hasMore, true);
  assert.notEqual(page.nextCursor, null);
});

test("the sweep expires a requested reservation", async () => {
  const name = `requested-expiry-${crypto.randomUUID()}`;
  const reservationId = "expired-requested-reservation";
  await seedReservation(worker, name, {
    reservationId,
    runnerRequestId: 1,
    state: "requested",
    requestedAtMs: TEST_NOW_MS - RESERVATION_TTL_MS,
    expiresAtMs: TEST_NOW_MS,
  });

  assert.deepEqual(
    await rpc(worker, name, "alarm", { nowMs: TEST_NOW_MS }),
    reservationSweepCounts({ expired: 1 }),
  );
  const page = await rpc(worker, name, "listReservations", {
    state: "compensated",
    nowMs: TEST_NOW_MS,
  });
  assert.equal(page.reservations[0].reservationId, reservationId);
  assert.equal(page.reservations[0].compensationReason, "expired");
});

test("the sweep reclaims a consumed reservation with no consume time", async () => {
  const name = `missing-consumed-time-${crypto.randomUUID()}`;
  const reservationId = "missing-consumed-time-reservation";
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 1)).recorded, true);
  await seedReservation(worker, name, {
    reservationId,
    runnerRequestId: 1,
    state: "consumed",
    requestedAtMs: TEST_NOW_MS,
    expiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS,
    consumedAtMs: null,
  });

  assert.deepEqual(
    await rpc(worker, name, "alarm", { nowMs: TEST_NOW_MS }),
    reservationSweepCounts({ reclaimTimeMissing: 1 }),
  );
  const page = await rpc(worker, name, "listReservations", {
    state: "compensated",
    nowMs: TEST_NOW_MS,
  });
  assert.equal(page.reservations[0].reservationId, reservationId);
  assert.equal(
    page.reservations[0].compensationReason,
    "reclaim-time-missing",
  );
  assert.equal((await reserve(worker, name, { index: 1 })).reserved, true);
});

test("the sweep reclaims a reserved row with an inconsistent expiry", async () => {
  const name = `reserved-timestamps-inconsistent-${crypto.randomUUID()}`;
  const reservationId = "reserved-timestamps-inconsistent";
  await seedReservation(worker, name, {
    reservationId,
    runnerRequestId: 1,
    state: "reserved",
    requestedAtMs: TEST_NOW_MS,
    expiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS + 1,
    reservedAtMs: TEST_NOW_MS,
  });

  assert.deepEqual(
    await rpc(worker, name, "alarm", { nowMs: TEST_NOW_MS }),
    reservationSweepCounts({ timestampsInconsistent: 1 }),
  );
  const page = await rpc(worker, name, "listReservations", {
    state: "compensated",
    nowMs: TEST_NOW_MS,
  });
  assert.equal(page.reservations[0].reservationId, reservationId);
  assert.equal(
    page.reservations[0].compensationReason,
    "timestamps-inconsistent",
  );
});

test("the sweep reclaims consumed rows with impossible consume times", async () => {
  const name = `consumed-timestamps-inconsistent-${crypto.randomUUID()}`;
  const rows = [
    {
      reservationId: "consumed-after-reservation-ttl",
      runnerRequestId: 1,
      consumedAtMs: TEST_NOW_MS + RESERVATION_TTL_MS + 1,
    },
    {
      reservationId: "consumed-before-request",
      runnerRequestId: 2,
      consumedAtMs: TEST_NOW_MS - 1,
    },
  ];
  for (const row of rows) {
    await seedReservation(worker, name, {
      ...row,
      state: "consumed",
      requestedAtMs: TEST_NOW_MS,
      expiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS,
    });
  }

  assert.deepEqual(
    await rpc(worker, name, "alarm", { nowMs: TEST_NOW_MS }),
    reservationSweepCounts({ timestampsInconsistent: rows.length }),
  );
  const page = await rpc(worker, name, "listReservations", {
    state: "compensated",
    nowMs: TEST_NOW_MS,
  });
  assert.deepEqual(
    page.reservations.map((reservation) => reservation.reservationId).sort(),
    rows.map((row) => row.reservationId).sort(),
  );
  for (const reservation of page.reservations) {
    assert.equal(reservation.compensationReason, "timestamps-inconsistent");
  }
});

test("the timestamp consistency boundaries preserve healthy rows", async () => {
  const name = `timestamp-consistency-boundary-${crypto.randomUUID()}`;
  const rows = [
    {
      reservationId: "reserved-at-ttl-boundary",
      runnerRequestId: 1,
      state: "reserved",
      requestedAtMs: TEST_NOW_MS,
      expiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS,
      reservedAtMs: TEST_NOW_MS,
    },
    {
      reservationId: "normally-consumed-reservation",
      runnerRequestId: 2,
      state: "consumed",
      requestedAtMs: TEST_NOW_MS,
      expiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS,
      reservedAtMs: TEST_NOW_MS,
      startCreatedAtMs: TEST_NOW_MS,
      consumedAtMs: TEST_NOW_MS + 1,
    },
  ];
  for (const row of rows) {
    await seedReservation(worker, name, row);
  }

  assert.deepEqual(
    await rpc(worker, name, "alarm", { nowMs: TEST_NOW_MS }),
    reservationSweepCounts(),
  );
  const page = await rpc(worker, name, "listReservations", {
    nowMs: TEST_NOW_MS,
  });
  assert.deepEqual(
    page.reservations
      .map(({ reservationId, state }) => ({ reservationId, state }))
      .sort((left, right) => left.reservationId.localeCompare(
        right.reservationId,
      )),
    rows
      .map(({ reservationId, state }) => ({ reservationId, state }))
      .sort((left, right) => left.reservationId.localeCompare(
        right.reservationId,
      )),
  );
});

test("an inconsistent reservation schedules an immediate alarm", async () => {
  const name = `inconsistent-reservation-alarm-${crypto.randomUUID()}`;
  await seedReservation(worker, name, {
    reservationId: "poisoned-reservation-alarm",
    runnerRequestId: 1,
    state: "reserved",
    requestedAtMs: TEST_NOW_MS,
    expiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS + 1,
  });

  assert.deepEqual(await rpc(worker, name, "compensate", {
    reservationId: "missing-reservation",
    reason: "test-alarm-schedule",
    nowMs: TEST_NOW_MS,
  }), {
    compensated: false,
    reason: "reservation-not-found",
  });
  assert.deepEqual(await rpc(worker, name, "reservationAlarm"), {
    alarmAtMs: TEST_NOW_MS,
  });
});

test("the alarm prunes a compensated row with no compensation time", async () => {
  const name = `null-compensation-time-${crypto.randomUUID()}`;
  const reservationId = "null-compensation-time";
  await seedReservation(worker, name, {
    reservationId,
    runnerRequestId: 1,
    state: "compensated",
    requestedAtMs: TEST_NOW_MS,
    expiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS,
    compensatedAtMs: null,
  });

  await rpc(worker, name, "alarm", { nowMs: TEST_NOW_MS });
  assert.deepEqual(
    await rpc(worker, name, "reservationExists", { reservationId }),
    { exists: false },
  );
});

test("reservation summary counts ignore the state filter", async () => {
  const name = `reservation-summary-counts-${crypto.randomUUID()}`;
  const states = ["requested", "reserved", "reserved", "compensated"];
  for (const [index, state] of states.entries()) {
    await seedReservation(worker, name, {
      reservationId: `summary-count-${index}`,
      runnerRequestId: index + 1,
      state,
      requestedAtMs: TEST_NOW_MS,
      expiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS,
      compensatedAtMs: state === "compensated" ? TEST_NOW_MS : null,
    });
  }

  const page = await rpc(worker, name, "listReservations", {
    state: "reserved",
    nowMs: TEST_NOW_MS,
  });
  assert.equal(page.reservations.length, 2);
  assert.equal(
    page.reservations.every((reservation) => reservation.state === "reserved"),
    true,
  );
  const expectedCounts = Object.fromEntries(
    RESERVATION_STATES.map((state) => [state, 0]),
  );
  for (const state of states) {
    expectedCounts[state] += 1;
  }
  assert.deepEqual(page.summary.counts, expectedCounts);
});

test("reservation list and status report the same next reclaim time", async () => {
  const name = `reservation-next-reclaim-${crypto.randomUUID()}`;
  const nowMs = Date.now();
  const nextReclaimAtMs = nowMs + RESERVATION_TTL_MS;
  await seedReservation(worker, name, {
    reservationId: "next-reclaim-reserved",
    runnerRequestId: 1,
    state: "reserved",
    requestedAtMs: nowMs,
    expiresAtMs: nextReclaimAtMs,
    reservedAtMs: nowMs,
  });
  await seedReservation(worker, name, {
    reservationId: "next-reclaim-consumed",
    runnerRequestId: 2,
    state: "consumed",
    requestedAtMs: nowMs,
    expiresAtMs: nextReclaimAtMs,
    reservedAtMs: nowMs,
    startCreatedAtMs: nowMs,
    consumedAtMs: nowMs,
  });

  const page = await rpc(worker, name, "listReservations", { nowMs });
  const status = await rpc(worker, name, "status");
  assert.equal(page.summary.nextReclaimAtMs, nextReclaimAtMs);
  assert.equal(status.nextReclaimAtMs, nextReclaimAtMs);
});

test("per-row liveness matches the status live reservation count", async () => {
  const name = `reservation-row-liveness-${crypto.randomUUID()}`;
  const nowMs = Date.now();
  const rows = [
    {
      reservationId: "liveness-requested",
      state: "requested",
      requestedAtMs: nowMs,
      expiresAtMs: nowMs + RESERVATION_TTL_MS,
    },
    {
      reservationId: "liveness-reserved-live",
      state: "reserved",
      requestedAtMs: nowMs,
      expiresAtMs: nowMs + RESERVATION_TTL_MS,
    },
    {
      reservationId: "liveness-reserved-expired",
      state: "reserved",
      requestedAtMs: nowMs - RESERVATION_TTL_MS,
      expiresAtMs: nowMs - 1,
    },
    {
      reservationId: "liveness-start-created-live",
      state: "start-created",
      requestedAtMs: nowMs,
      expiresAtMs: nowMs + RESERVATION_TTL_MS,
    },
    {
      reservationId: "liveness-consumed-live",
      state: "consumed",
      requestedAtMs: nowMs,
      expiresAtMs: nowMs + RESERVATION_TTL_MS,
      consumedAtMs: nowMs,
    },
    {
      reservationId: "liveness-consumed-stale",
      state: "consumed",
      requestedAtMs: nowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1,
      expiresAtMs:
        nowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1 + RESERVATION_TTL_MS,
      consumedAtMs: nowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1,
    },
    {
      reservationId: "liveness-compensated",
      state: "compensated",
      requestedAtMs: nowMs,
      expiresAtMs: nowMs + RESERVATION_TTL_MS,
      compensatedAtMs: nowMs,
    },
  ];
  for (const [index, row] of rows.entries()) {
    await seedReservation(worker, name, {
      runnerRequestId: index + 1,
      ...row,
    });
  }

  const page = await rpc(worker, name, "listReservations", { nowMs });
  const status = await rpc(worker, name, "status");
  const listedLiveCount = page.reservations.filter(
    (reservation) => reservation.live,
  ).length;
  assert.equal(listedLiveCount, status.liveReservationCount);
  assert.equal(page.summary.liveReservationCount, status.liveReservationCount);
  assert.equal(listedLiveCount, 3);
});

test("Q2a: an unconsumed reservation stops counting at its TTL", async () => {
  const name = `q2a-unconsumed-reservation-ttl-${crypto.randomUUID()}`;
  const requestedAtMs = TEST_NOW_MS;
  const expiresAtMs = requestedAtMs + RESERVATION_TTL_MS;
  const rows = [
    {
      reservationId: "q2a-reserved",
      runnerRequestId: 1,
      state: "reserved",
      reservedAtMs: requestedAtMs,
    },
    {
      reservationId: "q2a-start-created",
      runnerRequestId: 2,
      state: "start-created",
      reservedAtMs: requestedAtMs,
      startCreatedAtMs: requestedAtMs,
    },
  ];
  for (const row of rows) {
    await seedReservation(worker, name, {
      ...row,
      requestedAtMs,
      expiresAtMs,
    });
  }

  const beforeExpiry = await rpc(worker, name, "listReservations", {
    nowMs: expiresAtMs - 1,
  });
  const atExpiry = await rpc(worker, name, "listReservations", {
    nowMs: expiresAtMs,
  });

  assert.equal(beforeExpiry.summary.liveReservationCount, rows.length);
  assert.equal(
    beforeExpiry.reservations.every((reservation) => reservation.live),
    true,
  );
  assert.equal(atExpiry.summary.liveReservationCount, 0);
  assert.equal(
    atExpiry.reservations.every((reservation) => !reservation.live),
    true,
  );
  assert.equal(expiresAtMs - requestedAtMs, RESERVATION_TTL_MS);
  assert.ok(RESERVATION_TTL_MS < ACTIVE_RUNNER_CLEANUP_DELAY_MS);
});

test("every schema reservation state has a finite terminal path", async () => {
  const name = `reservation-state-completeness-${crypto.randomUUID()}`;
  const sweepAtMs = TEST_NOW_MS;
  const writerTimes = (state, value) => ({
    ...(state === "requested" ? {} : { reservedAtMs: value }),
    ...(state === "start-created" ? { startCreatedAtMs: value } : {}),
  });
  const shapesForState = (state) => {
    if (["requested", "reserved", "start-created"].includes(state)) {
      return [
        {
          name: "null-transition-times",
          requestedAtMs: sweepAtMs - RESERVATION_TTL_MS,
          expiresAtMs: sweepAtMs,
          expectedReason: "expired",
        },
        {
          name: "consistent-lower-bound",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs,
          expectedReason: "expired",
          ...writerTimes(state, sweepAtMs),
        },
        {
          name: "consistent-upper-bound",
          requestedAtMs: sweepAtMs - RESERVATION_TTL_MS,
          expiresAtMs: sweepAtMs,
          expectedReason: "expired",
          ...writerTimes(state, sweepAtMs - RESERVATION_TTL_MS),
        },
        {
          name: "inconsistent-before-request",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs - 1,
          expectedReason: "timestamps-inconsistent",
          ...writerTimes(state, sweepAtMs),
        },
        {
          name: "inconsistent-after-ttl",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs + RESERVATION_TTL_MS + 1,
          expectedReason: "timestamps-inconsistent",
          ...writerTimes(state, sweepAtMs),
        },
      ];
    }
    if (state === "consumed") {
      return [
        {
          name: "null-consume-time",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs + RESERVATION_TTL_MS,
          consumedAtMs: null,
          expectedReason: "reclaim-time-missing",
        },
        {
          name: "consistent-lower-bound",
          requestedAtMs: sweepAtMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS,
          expiresAtMs:
            sweepAtMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS + RESERVATION_TTL_MS,
          consumedAtMs: sweepAtMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS,
          expectedReason: "runner-horizon-exceeded",
        },
        {
          name: "consistent-upper-bound",
          requestedAtMs:
            sweepAtMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - RESERVATION_TTL_MS,
          expiresAtMs: sweepAtMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS,
          consumedAtMs: sweepAtMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS,
          expectedReason: "runner-horizon-exceeded",
        },
        {
          name: "inconsistent-before-request",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs + RESERVATION_TTL_MS,
          consumedAtMs: sweepAtMs - 1,
          expectedReason: "timestamps-inconsistent",
        },
        {
          name: "inconsistent-after-ttl",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs + RESERVATION_TTL_MS,
          consumedAtMs: sweepAtMs + RESERVATION_TTL_MS + 1,
          expectedReason: "timestamps-inconsistent",
        },
      ];
    }
    if (state === "compensated") {
      return [
        {
          name: "null-compensation-time",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs + RESERVATION_TTL_MS,
          compensatedAtMs: null,
          retained: false,
        },
        {
          name: "consistent-lower-bound",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs,
          compensatedAtMs: sweepAtMs,
          retained: true,
        },
        {
          name: "consistent-upper-bound",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs + RESERVATION_TTL_MS,
          compensatedAtMs: sweepAtMs,
          retained: true,
        },
        {
          name: "inconsistent-before-request",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs - 1,
          compensatedAtMs: sweepAtMs,
          retained: true,
        },
        {
          name: "inconsistent-after-ttl",
          requestedAtMs: sweepAtMs,
          expiresAtMs: sweepAtMs + RESERVATION_TTL_MS + 1,
          compensatedAtMs: sweepAtMs,
          retained: true,
        },
      ];
    }
    throw new Error(`The ${state} state has no sweep completeness matrix`);
  };

  const scenarios = [];
  let runnerRequestId = 1;
  for (const state of RESERVATION_STATES) {
    const shapes = shapesForState(state);
    assert.equal(shapes.length, 5);
    for (const shape of shapes) {
      const reservationId = `${state}-${shape.name}`;
      await seedReservation(worker, name, {
        reservationId,
        runnerRequestId,
        state,
        compensationReason:
          state === "compensated" ? "seeded-terminal" : null,
        ...shape,
      });
      scenarios.push({ reservationId, state, ...shape });
      runnerRequestId += 1;
    }
  }

  assert.deepEqual(
    await rpc(worker, name, "alarm", { nowMs: sweepAtMs }),
    reservationSweepCounts({
      expired: 9,
      runnerHorizonExceeded: 2,
      reclaimTimeMissing: 1,
      timestampsInconsistent: 8,
    }),
  );
  const page = await rpc(worker, name, "listReservations", {
    nowMs: sweepAtMs,
  });
  assert.equal(page.nextCursor, null);
  const reservationsById = new Map(
    page.reservations.map((reservation) => [
      reservation.reservationId,
      reservation,
    ]),
  );
  for (const scenario of scenarios) {
    const reservation = reservationsById.get(scenario.reservationId);
    if (scenario.state === "compensated" && scenario.retained === false) {
      assert.equal(reservation, undefined, scenario.reservationId);
      continue;
    }
    assert.equal(reservation?.state, "compensated", scenario.reservationId);
    if (scenario.expectedReason !== undefined) {
      assert.equal(
        reservation.compensationReason,
        scenario.expectedReason,
        scenario.reservationId,
      );
    }
  }
});

test("outage permits distinguish invalid expired and replayed permits", async () => {
  const name = `permits-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal(
    (await approveCapacity(worker, name, MAX_ACTIVE_RUNNERS)).recorded,
    true,
  );

  assert.deepEqual(
    await reserve(worker, name, { index: 1, keys: wrongPermitKeys }),
    { reserved: false, reason: "outage-permit-invalid" },
  );
  assert.deepEqual(
    await reserve(worker, name, {
      index: 2,
      permitExpiresAtMs: TEST_NOW_MS - 1,
    }),
    { reserved: false, reason: "outage-permit-expired" },
  );
  assert.deepEqual(
    await reserve(worker, name, {
      index: 5,
      permitExpiresAtMs: TEST_NOW_MS + RESERVATION_TTL_MS + 1,
    }),
    { reserved: false, reason: "outage-permit-invalid" },
  );

  const permitId = "one-use-permit";
  assert.equal(
    (await reserve(worker, name, { index: 3, permitId })).reserved,
    true,
  );
  assert.deepEqual(
    await reserve(worker, name, { index: 4, permitId }),
    { reserved: false, reason: "outage-permit-replayed" },
  );
});

test("a real permit minted before reservation keeps its shorter deadline", async () => {
  const name = `permit-window-${crypto.randomUUID()}`;
  await setActiveWave(worker, name);
  assert.equal((await approveCapacity(worker, name, 1)).recorded, true);
  const permitExpiresAtMs = TEST_NOW_MS + RESERVATION_TTL_MS - 1;
  const reservation = await reserve(worker, name, {
    index: 1,
    permitExpiresAtMs,
  });
  assert.equal(reservation.reserved, true);
  assert.equal(reservation.expiresAtMs, permitExpiresAtMs);
});

test("an unconfigured outage gate refuses every reservation", async () => {
  const name = `unconfigured-${crypto.randomUUID()}`;
  await setActiveWave(unconfiguredWorker, name);
  const first = await reservationInput({ index: 1 });
  first.outagePermit.bypass = true;
  assert.deepEqual(
    await rpc(unconfiguredWorker, name, "reserve", first),
    { reserved: false, reason: "outage-gate-unconfigured" },
  );

  const second = await reservationInput({ index: 2 });
  second.outageGateBypass = true;
  assert.deepEqual(
    await rpc(unconfiguredWorker, name, "reserve", second),
    { reserved: false, reason: "outage-gate-unconfigured" },
  );
  assert.equal(
    (await rpc(unconfiguredWorker, name, "status")).liveReservationCount,
    0,
  );
});

test("a body-less POST /runners is refused with the documented 400", async () => {
  const scenario = `body-less-${crypto.randomUUID()}`;
  const response = await worker.fetch(
    `/runners?scenario=${encodeURIComponent(scenario)}&mode=ready`,
    {
      method: "POST",
      headers: authenticatedHeaders(),
    },
  );
  assert.equal(response.status, 400);
  assert.ok(
    (await response.text()).includes(
      "POST /runners requires a non-empty application/json JIT request body",
    ),
  );
});

test("the JIT branch validates required and unknown fields", async () => {
  const cases = [
    {
      scenario: "missing-jit-config",
      body: (() => {
        const body = validJitBody();
        delete body.jitConfig;
        return body;
      })(),
      field: "jitConfig",
    },
    {
      scenario: "empty-jit-config",
      body: validJitBody({ jitConfig: "" }),
      field: "jitConfig",
    },
    {
      scenario: "repository-mismatch",
      body: validJitBody({ repository: "example/other-repository" }),
      field: "repository",
    },
    {
      scenario: "repository-format",
      body: validJitBody({ repository: "not-a-repository" }),
      field: "repository",
      githubRepository: "not-a-repository",
    },
    {
      scenario: "zero-scale-set",
      body: validJitBody({ scaleSetId: 0 }),
      field: "scaleSetId",
    },
    {
      scenario: "zero-runner-request",
      body: validJitBody({ runnerRequestId: 0 }),
      field: "runnerRequestId",
    },
    {
      scenario: "empty-wave",
      body: validJitBody({ wave: "" }),
      field: "wave",
    },
    {
      scenario: "non-object-reservation",
      body: validJitBody({ reservation: null }),
      field: "reservation",
    },
    {
      scenario: "missing-reservation-id",
      body: validJitBody({
        reservation: {
          token: "reservation-token",
          expiresAtMs: Date.now() + RESERVATION_TTL_MS,
          gateGeneration: 0,
        },
      }),
      field: "reservation.reservationId",
    },
    {
      scenario: "empty-reservation-token",
      body: validJitBody({
        reservation: {
          reservationId: "reservation-jit",
          token: "",
          expiresAtMs: Date.now() + RESERVATION_TTL_MS,
          gateGeneration: 0,
        },
      }),
      field: "reservation.token",
    },
    {
      scenario: "zero-reservation-expiry",
      body: validJitBody({
        reservation: {
          reservationId: "reservation-jit",
          token: "reservation-token",
          expiresAtMs: 0,
          gateGeneration: 0,
        },
      }),
      field: "reservation.expiresAtMs",
    },
    {
      scenario: "negative-gate-generation",
      body: validJitBody({
        reservation: {
          reservationId: "reservation-jit",
          token: "reservation-token",
          expiresAtMs: Date.now() + RESERVATION_TTL_MS,
          gateGeneration: -1,
        },
      }),
      field: "reservation.gateGeneration",
    },
    {
      scenario: "unknown-reservation-field",
      body: validJitBody({
        reservation: {
          reservationId: "reservation-jit",
          token: "reservation-token",
          expiresAtMs: Date.now() + RESERVATION_TTL_MS,
          gateGeneration: 0,
          unexpected: true,
        },
      }),
      field: "reservation.unexpected",
    },
    {
      scenario: "unknown-top-level",
      body: validJitBody({ unexpected: true }),
      field: "unexpected",
    },
  ];
  for (const entry of cases) {
    const response = await jitRequest(
      `${entry.scenario}-${crypto.randomUUID()}`,
      "ready",
      entry.body,
      entry.githubRepository === undefined
        ? undefined
        : { githubRepository: entry.githubRepository },
    );
    assert.equal(response.status, 400);
    const responseText = await response.text();
    assert.match(responseText, new RegExp(entry.field));
    assert.doesNotMatch(responseText, new RegExp(JIT_SECRET));
  }
});

test("the JIT branch never logs or returns jitConfig", async () => {
  const scenario = `secret-${crypto.randomUUID()}`;
  const response = await jitRequest(scenario, "ready", validJitBody());
  assert.equal(response.status, 202);
  const responseText = await response.text();
  assert.doesNotMatch(responseText, new RegExp(JIT_SECRET));
  const state = await jitState(scenario, "flush");
  for (const line of state.logs) {
    assert.doesNotMatch(line, new RegExp(JIT_SECRET));
  }
});

test("a spawn failure logs its redacted error message", async () => {
  const scenario = `spawn-error-log-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "spawn-error-secret",
    validJitBody(),
  );
  assert.equal(response.status, 502);
  const responseText = await response.text();
  assert.deepEqual(JSON.parse(responseText), {
    error: "Failed to start runner",
    phase: "recordStarting",
    upstreamStatus: null,
    reason: null,
    correlationId: null,
  });
  assert.doesNotMatch(responseText, /simulated spawn outage/u);
  assert.doesNotMatch(responseText, new RegExp(CONTROL_TOKEN));
  assert.doesNotMatch(responseText, new RegExp(JIT_SECRET));

  const state = await jitState(scenario);
  assert.equal(state.logs.length, 1);
  assert.doesNotMatch(state.logs[0], new RegExp(CONTROL_TOKEN));
  assert.deepEqual(JSON.parse(state.logs[0]), {
    message: "failed to start ephemeral runner",
    error: {
      name: "RunnerSpawnPhaseError",
      message: "simulated spawn outage: [REDACTED]",
      cause: {
        name: "Error",
        message: "simulated spawn outage: [REDACTED]",
      },
    },
    phase: "recordStarting",
    upstreamStatus: null,
    capacityRefusal: null,
    reason: null,
    correlationId: null,
    repository: "example/runner-test",
    startMode: "jit",
  });
});

test("a wrapped spawn failure logs both error classes", async () => {
  const scenario = `spawn-error-class-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "spawn-error-class",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  const state = await jitState(scenario);
  const record = JSON.parse(state.logs.at(-1));
  assert.equal(record.error.name, "RunnerSpawnPhaseError");
  assert.deepEqual(record.error.cause, {
    name: "RunnerRegistryWriteError",
    message: "simulated registry write failure",
  });
});

test("a spawn AggregateError logs every member error", async () => {
  const scenario = `spawn-aggregate-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "start-process-cleanup-error",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.phase, "startProcess");
  const state = await jitState(scenario);
  const record = JSON.parse(state.logs.at(-1));
  assert.equal(record.error.name, "RunnerSpawnPhaseError");
  assert.equal(record.error.cause.name, "AggregateError");
  assert.deepEqual(record.error.aggregateErrors, [
    {
      name: "SandboxProcessError",
      message: "simulated sandbox process failure",
    },
    {
      name: "RunnerCleanupScheduleError",
      message: "simulated cleanup scheduling failure",
    },
  ]);
});

test("a container start budget expiry reports its classification", async () => {
  const scenario = `start-budget-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "start-process-budget-exceeded",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Failed to start runner",
    phase: "startProcess",
    upstreamStatus: null,
    reason: "container-start-budget-exceeded",
    correlationId: null,
  });
  const state = await jitState(scenario);
  assert.equal(state.cleanupScheduled, 1);
  assert.equal(state.startBudgetMs, 30_000);
  assert.equal(state.startBudgetCancelled, true);
  assert.equal(
    JSON.parse(state.logs.at(-1)).reason,
    "container-start-budget-exceeded",
  );
});

test("a healthy container start cancels its budget timer", async () => {
  const scenario = `healthy-start-budget-${crypto.randomUUID()}`;
  const response = await jitRequest(scenario, "ready", validJitBody());

  assert.equal(response.status, 202);
  const state = await jitState(scenario);
  assert.equal(state.startBudgetMs, 30_000);
  assert.equal(state.startBudgetCancelled, true);
});

test("a container start budget cleanup failure logs both errors", async () => {
  const scenario = `start-budget-cleanup-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "start-process-budget-cleanup-error",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).reason, "container-start-budget-exceeded");
  const state = await jitState(scenario);
  const record = JSON.parse(state.logs.at(-1));
  assert.equal(record.error.name, "RunnerSpawnPhaseError");
  assert.equal(record.error.cause.name, "AggregateError");
  assert.deepEqual(record.error.aggregateErrors, [
    {
      name: "ContainerStartBudgetExceeded",
      message: "Container start exceeded the 30000 ms budget",
    },
    {
      name: "RunnerCleanupScheduleError",
      message: "simulated cleanup scheduling failure",
    },
  ]);
  assert.equal(state.startBudgetCancelled, true);
});

test("a markStartCreated failure reports its spawn phase", async () => {
  const scenario = `mark-start-error-${crypto.randomUUID()}`;
  const correlationId = "valid-correlation:123";
  const response = await jitRequest(
    scenario,
    "mark-start-error",
    validJitBody(),
    { headers: { "Idempotency-Key": correlationId } },
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Failed to start runner",
    phase: "markStartCreated",
    upstreamStatus: null,
    reason: null,
    correlationId,
  });
});

test("a spawn failure reports a numeric upstream status", async () => {
  const scenario = `spawn-status-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "spawn-error-status",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Failed to start runner",
    phase: "recordStarting",
    upstreamStatus: 503,
    reason: null,
    correlationId: null,
  });
});

test("a spawn failure ignores a numeric success status", async () => {
  const scenario = `spawn-success-status-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "spawn-error-success-status",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Failed to start runner",
    phase: "recordStarting",
    upstreamStatus: null,
    reason: null,
    correlationId: null,
  });
});

test("a container capacity refusal reports its cause classification", async () => {
  const scenario = `container-capacity-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "start-process-container-capacity",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Failed to start runner",
    phase: "startProcess",
    upstreamStatus: null,
    reason: "no-container-instance",
    correlationId: null,
  });
  const state = await jitState(scenario);
  assert.equal(state.cleanupScheduled, 1);
  assert.equal(state.startBudgetCancelled, true);
  const record = JSON.parse(state.logs.at(-1));
  assert.equal(
    record.capacityRefusal,
    "no-container-instance",
  );
  assert.equal(record.reason, "no-container-instance");
});

test("a new dispatch correlation starts after a retained capacity failure", async () => {
  const firstCorrelation = "scale-set:101:runner-request:5";
  const secondCorrelation = "scale-set:101:rr1:5";
  const requestBody = validJitBody({ runnerRequestId: 5 });
  const distinctRegistry = `distinct-dispatch-${crypto.randomUUID()}`;
  const firstScenario = `distinct-first-${crypto.randomUUID()}`;
  const first = await jitRequest(
    firstScenario,
    "start-process-container-capacity",
    requestBody,
    {
      registry: distinctRegistry,
      headers: { "Idempotency-Key": firstCorrelation },
    },
  );

  assert.equal(first.status, 502);
  assert.deepEqual(await first.json(), {
    error: "Failed to start runner",
    phase: "startProcess",
    upstreamStatus: null,
    reason: "no-container-instance",
    correlationId: firstCorrelation,
  });
  const firstState = await jitState(firstScenario);
  assert.equal(firstState.sandboxIds.length, 1);

  const secondScenario = `distinct-second-${crypto.randomUUID()}`;
  const second = await jitRequest(
    secondScenario,
    "ready",
    requestBody,
    {
      registry: distinctRegistry,
      headers: { "Idempotency-Key": secondCorrelation },
    },
  );
  assert.equal(second.status, 202);
  const secondBody = await second.json();
  assert.equal(secondBody.correlationId, secondCorrelation);
  assert.equal(secondBody.replayed, false);
  assert.notEqual(secondBody.sandboxId, firstState.sandboxIds[0]);
  const secondState = await jitState(secondScenario);
  assert.deepEqual(secondState.sandboxIds, [secondBody.sandboxId]);

  const replayRegistry = `same-dispatch-${crypto.randomUUID()}`;
  const replayFirstScenario = `same-first-${crypto.randomUUID()}`;
  const replayFirst = await jitRequest(
    replayFirstScenario,
    "start-process-container-capacity",
    requestBody,
    {
      registry: replayRegistry,
      headers: { "Idempotency-Key": firstCorrelation },
    },
  );
  assert.equal(replayFirst.status, 502);
  const replayFirstState = await jitState(replayFirstScenario);
  assert.equal(replayFirstState.sandboxIds.length, 1);

  const replayScenario = `same-second-${crypto.randomUUID()}`;
  const replay = await jitRequest(
    replayScenario,
    "ready",
    requestBody,
    {
      registry: replayRegistry,
      headers: { "Idempotency-Key": firstCorrelation },
    },
  );
  assert.equal([200, 409].includes(replay.status), true);
  const replayBody = await replay.json();
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.sandboxId, replayFirstState.sandboxIds[0]);
  const replayState = await jitState(replayScenario);
  assert.equal(replayState.sandboxCreations, 0);
  assert.deepEqual(replayState.sandboxIds, []);
});

test("a process exit code is not an upstream HTTP status", async () => {
  const scenario = `spawn-exit-code-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "start-process-exit-code",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Failed to start runner",
    phase: "startProcess",
    upstreamStatus: null,
    reason: null,
    correlationId: null,
  });
  const state = await jitState(scenario);
  assert.equal(state.cleanupScheduled, 1);
});

test("a non-capacity startProcess failure has no capacity reason", async () => {
  const scenario = `non-capacity-start-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "start-process-exit-code",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).reason, null);
  const state = await jitState(scenario);
  assert.equal(JSON.parse(state.logs.at(-1)).capacityRefusal, null);
});

test("an unwrapped spawn failure uses the request phase", async () => {
  const scenario = `spawn-request-phase-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "schedule-wait-error",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Failed to start runner",
    phase: "request",
    upstreamStatus: null,
    reason: null,
    correlationId: null,
  });
  const state = await jitState(scenario);
  assert.equal(state.processStarts, 1);
});

test("a spawn failure derives a trailing upstream status", async () => {
  const scenario = `spawn-message-status-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "spawn-error-message-status",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Failed to start runner",
    phase: "recordStarting",
    upstreamStatus: 429,
    reason: null,
    correlationId: null,
  });
});

test("a spawn failure ignores unrelated trailing digits", async () => {
  const scenario = `spawn-unrelated-message-status-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "spawn-error-unrelated-message-status",
    validJitBody(),
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Failed to start runner",
    phase: "recordStarting",
    upstreamStatus: null,
    reason: null,
    correlationId: null,
  });
});

test("unsafe correlation identifiers are not reflected", async () => {
  for (const testCase of [
    { label: "oversized", value: "a".repeat(59) },
    { label: "control", value: "unsafe\tcorrelation" },
  ]) {
    const scenario = `unsafe-correlation-${testCase.label}-${crypto.randomUUID()}`;
    const response = await jitRequest(
      scenario,
      "mark-start-error",
      validJitBody(),
      { headers: { "Idempotency-Key": testCase.value } },
    );

    assert.equal(response.status, 502);
    assert.equal((await response.json()).correlationId, null);
    const state = await jitState(scenario);
    assert.equal(JSON.parse(state.logs.at(-1)).correlationId, null);
  }
});

test("markStartCreated refusal creates no sandbox", async () => {
  const scenario = `mark-refused-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "mark-refused",
    validJitBody(),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "JIT runner start authorization was refused",
    phase: "markStartCreated",
    reason: "invalid-state",
  });
  const state = await jitState(scenario);
  assert.equal(state.sandboxCreations, 0);
  assert.equal(state.processStarts, 0);
  assert.deepEqual(state.events, ["mark-start-created"]);
});

test("a missing stored reservation fails the JIT start closed", async () => {
  const scenario = `missing-stored-reservation-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "missing-reservation",
    validJitBody(),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "JIT runner start authorization was refused",
    phase: "markStartCreated",
    reason: "reservation-mismatch",
  });
  const state = await jitState(scenario);
  assert.equal(state.sandboxCreations, 0);
  assert.equal(state.processStarts, 0);
  assert.deepEqual(state.events, ["mark-start-created", "compensate"]);
});

test("a compensation failure preserves a markStartCreated conflict", async () => {
  const scenario = `mark-conflict-compensation-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "missing-reservation-compensate-error",
    validJitBody(),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "JIT runner start authorization was refused",
    phase: "markStartCreated",
    reason: "reservation-mismatch",
  });
  const state = await jitState(scenario);
  assert.equal(state.sandboxCreations, 0);
  assert.deepEqual(state.events, ["mark-start-created", "compensate"]);
  assert.equal(
    JSON.parse(state.logs.at(-1)).message,
    "JIT start reservation compensation failed",
  );
});

test("a live correlation replay keeps its consumed capacity reservation", async () => {
  const scenario = `live-correlation-replay-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "correlation-replay-live",
    validJitBody(),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, true);
  const state = await jitState(scenario);
  assert.equal(state.processStarts, 0);
  assert.deepEqual(state.events, [
    "mark-start-created",
    "record-starting",
  ]);
});

test("consume refusal prevents startProcess and schedules cleanup", async () => {
  const scenario = `consume-refused-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "consume-refused",
    validJitBody(),
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.phase, "consume");
  assert.equal(body.reason, "generation-superseded");
  const state = await jitState(scenario);
  assert.equal(state.processStarts, 0);
  assert.equal(state.cleanupScheduled, 1);
  assert.deepEqual(state.events, [
    "mark-start-created",
    "record-starting",
    "sandbox-created",
    "consume",
    "cleanup-scheduled",
  ]);
});

test("a cleanup failure preserves a consume conflict", async () => {
  const scenario = `consume-conflict-cleanup-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "consume-refused-cleanup-error",
    validJitBody(),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "JIT runner start authorization was refused",
    phase: "consume",
    reason: "generation-superseded",
  });
  const state = await jitState(scenario);
  assert.equal(state.processStarts, 0);
  assert.equal(
    JSON.parse(state.logs.at(-1)).message,
    "JIT start cleanup scheduling failed",
  );
});

test("a superseded real reservation cannot start a runner", async () => {
  const controlName = `jit-generation-${crypto.randomUUID()}`;
  await setActiveWave(worker, controlName);
  assert.equal(
    (await approveCapacity(worker, controlName, 1)).recorded,
    true,
  );
  const reservation = await reserve(worker, controlName, {
    index: 701,
    nowMs: Date.now(),
  });
  const scenario = `real-generation-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "generation-superseded",
    validJitBody({
      reservation: {
        reservationId: reservation.reservationId,
        token: reservation.token,
        expiresAtMs: reservation.expiresAtMs,
        gateGeneration: reservation.gateGeneration,
      },
      runnerRequestId: 701,
    }),
    { control: controlName },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.reason, "generation-superseded");
  const state = await jitState(scenario);
  assert.equal(state.processStarts, 0);
  assert.equal(state.cleanupScheduled, 1);
});

test("the JIT body must match the stored reservation identity", async () => {
  const controlName = `jit-identity-${crypto.randomUUID()}`;
  await setActiveWave(worker, controlName);
  assert.equal(
    (await approveCapacity(worker, controlName, 1)).recorded,
    true,
  );
  const nowMs = Date.now();
  const reservation = await reserve(worker, controlName, {
    index: 702,
    nowMs,
  });
  const scenario = `reservation-mismatch-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "real-control",
    validJitBody({
      reservation: {
        reservationId: reservation.reservationId,
        token: reservation.token,
        expiresAtMs: reservation.expiresAtMs,
        gateGeneration: reservation.gateGeneration,
      },
      scaleSetId: 102,
      runnerRequestId: 702,
    }),
    { control: controlName },
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "JIT runner start authorization was refused",
    phase: "markStartCreated",
    reason: "reservation-mismatch",
  });
  const state = await jitState(scenario);
  assert.equal(state.sandboxCreations, 0);
  assert.equal(state.processStarts, 0);
  assert.deepEqual(state.events, ["mark-start-created"]);
});

test("the JIT branch returns 202 before readiness and marks online later", async () => {
  const scenario = `pending-readiness-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "pending-readiness",
    validJitBody(),
  );
  assert.equal(response.status, 202);
  const responseBody = await response.json();
  assert.equal(responseBody.state, "starting");

  const beforeReadiness = await jitState(scenario);
  assert.equal(beforeReadiness.markOnlineCalls, 0);
  assert.equal(beforeReadiness.registryState, "starting");
  assert.equal(beforeReadiness.waitUntilCount, 1);

  const afterReadiness = await jitState(scenario, "release");
  assert.equal(afterReadiness.markOnlineCalls, 1);
  assert.equal(afterReadiness.registryState, "online");
  const onlineLog = afterReadiness.logs.find((line) =>
    line.includes("JIT runner became online")
  );
  assert.equal(JSON.parse(onlineLog).phase, "markOnline");
});

test("readiness beyond WORKER_WAIT_UNTIL_LIMIT_MS can still become online", async () => {
  const scenario = `readiness-timeout-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "timeout-readiness",
    validJitBody(),
  );
  assert.equal(response.status, 202);
  const state = await jitState(scenario, "flush");
  assert.equal(state.readinessTimeoutMs, 30_000);
  assert.equal(state.markOnlineCalls, 1);
  assert.equal(state.registryState, "online");
  assert.equal(state.cleanupScheduled, 0);
  assert.equal(
    state.logs.some((line) =>
      line.includes("JIT runner readiness observation exceeded") &&
      JSON.parse(line).phase === "readinessWait" &&
      line.includes(`correlation-${scenario}`)
    ),
    true,
  );
});

test("a readiness log redacts CONTROL_TOKEN", async () => {
  const scenario = `readiness-secret-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "readiness-secret",
    validJitBody(),
  );
  assert.equal(response.status, 202);

  const state = await jitState(scenario, "flush");
  const cleanupLog = state.logs.find((line) =>
    line.includes("scheduled runner startup cleanup")
  );
  assert.equal(typeof cleanupLog, "string");
  assert.doesNotMatch(cleanupLog, new RegExp(CONTROL_TOKEN));
  assert.equal(JSON.parse(cleanupLog).reason, "[REDACTED]");
});

test("a rejected JIT readiness observation schedules startup cleanup", async () => {
  const scenario = `readiness-rejected-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "readiness-rejected",
    validJitBody(),
  );
  assert.equal(response.status, 202);

  const state = await jitState(scenario, "flush");
  assert.equal(state.readinessTimeoutMs, 30_000);
  assert.equal(state.markOnlineCalls, 0);
  assert.equal(state.cleanupScheduled, 1);
  assert.equal(state.registryState, "destroying");
});

test("an existing startup cleanup owner is an accepted refusal", async () => {
  const scenario = `cleanup-already-scheduled-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "cleanup-already-scheduled",
    validJitBody(),
  );
  assert.equal(response.status, 202);

  const state = await jitState(scenario, "flush");
  assert.equal(state.cleanupScheduled, 1);
  assert.equal(
    state.logs.some((line) =>
      line.includes("startup cleanup already has a durable owner")
    ),
    true,
  );
});

test("an unexpected startup cleanup refusal rejects the waitUntil task", async () => {
  const scenario = `cleanup-refused-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "cleanup-refused",
    validJitBody(),
  );
  assert.equal(response.status, 202);

  const flush = await worker.fetch(
    `/harness/jit-flush?scenario=${encodeURIComponent(scenario)}`,
  );
  assert.equal(flush.status, 500);
  assert.match(
    (await flush.json()).error,
    /cleanup alarm was not scheduled/u,
  );
});

test("a thrown JIT online update schedules startup cleanup", async () => {
  const scenario = `mark-online-throws-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "mark-online-throws",
    validJitBody(),
  );
  assert.equal(response.status, 202);

  const state = await jitState(scenario, "flush");
  assert.equal(state.markOnlineCalls, 1);
  assert.equal(state.cleanupScheduled, 1);
  assert.equal(state.registryState, "destroying");
});

test("the JIT process receives only the dedicated runner contract", async () => {
  const scenario = `jit-environment-${crypto.randomUUID()}`;
  const response = await jitRequest(
    scenario,
    "pending-readiness",
    validJitBody(),
  );
  assert.equal(response.status, 202);
  const state = await jitState(scenario);
  assert.equal(state.startEnvironment.RUNNER_JITCONFIG, JIT_SECRET);
  assert.equal(
    Object.hasOwn(state.startEnvironment, "RUNNER_TOKEN"),
    false,
  );
  assert.equal(
    state.startEnvironment.RUNNER_LABELS,
    "cloudflare-sandbox",
  );
  assert.deepEqual(state.events.slice(0, 5), [
    "mark-start-created",
    "record-starting",
    "sandbox-created",
    "consume",
    "process-started",
  ]);
  await jitState(scenario, "release");
});

test("all autopilot routes enforce authentication and methods", async () => {
  const routes = [
    { path: "/autopilot/control", method: "GET", wrong: "POST" },
    {
      path: "/autopilot/control/kill",
      method: "POST",
      wrong: "GET",
      body: { reason: "route test" },
    },
    {
      path: "/autopilot/control/resume",
      method: "POST",
      wrong: "GET",
    },
    {
      path: "/autopilot/control/capacity",
      method: "POST",
      wrong: "GET",
      body: {
        capacity: 1,
        signature: "route-signature",
        effectiveAtMs: TEST_NOW_MS,
        approvedBy: "route-owner",
      },
    },
    {
      path: "/autopilot/control/wave",
      method: "POST",
      wrong: "GET",
      body: { wave: "wave-route" },
    },
    {
      path: "/autopilot/control/reservations",
      method: "GET",
      wrong: "POST",
    },
  ];

  for (const route of routes) {
    const unauthorized = await worker.fetch(route.path, {
      method: route.method,
      ...(route.body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(route.body),
          }),
    });
    assert.equal(unauthorized.status, 401, route.path);

    const wrongMethod = await worker.fetch(route.path, {
      method: route.wrong,
      headers: authenticatedHeaders(),
    });
    assert.equal(wrongMethod.status, 405, route.path);
    assert.equal(wrongMethod.headers.get("Allow"), route.method);
  }
});

test("autopilot routes expose control state and the policy conflict", async () => {
  const statusResponse = await worker.fetch("/autopilot/control", {
    headers: authenticatedHeaders(),
  });
  assert.equal(statusResponse.status, 200);
  assert.equal(typeof (await statusResponse.json()).maxCapacity, "number");

  const capacityResponse = await worker.fetch(
    "/autopilot/control/capacity",
    {
      method: "POST",
      headers: authenticatedHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        capacity: MAX_ACTIVE_RUNNERS + 1,
        signature: "rejected-route-signature",
        effectiveAtMs: TEST_NOW_MS,
        approvedBy: "route-owner",
      }),
    },
  );
  assert.equal(capacityResponse.status, 409);
  assert.deepEqual(await capacityResponse.json(), {
    error: "Capacity exceeds MAX_ACTIVE_RUNNERS",
    reason: "exceeds-policy-guard",
    guard: "MAX_ACTIVE_RUNNERS",
    guardValue: MAX_ACTIVE_RUNNERS,
    offeredCapacity: MAX_ACTIVE_RUNNERS + 1,
  });

  const waveResponse = await worker.fetch("/autopilot/control/wave", {
    method: "POST",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ wave: "wave-route" }),
  });
  assert.equal(waveResponse.status, 200);
  assert.equal((await waveResponse.json()).activeWave, "wave-route");

  const killResponse = await worker.fetch("/autopilot/control/kill", {
    method: "POST",
    headers: authenticatedHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ reason: "route test" }),
  });
  assert.equal(killResponse.status, 200);
  assert.equal((await killResponse.json()).maxCapacity, 0);

  const resumeResponse = await worker.fetch("/autopilot/control/resume", {
    method: "POST",
    headers: authenticatedHeaders(),
  });
  assert.equal(resumeResponse.status, 200);
  assert.equal((await resumeResponse.json()).opened, true);

  const reservationsResponse = await worker.fetch(
    "/autopilot/control/reservations?limit=5",
    { headers: authenticatedHeaders() },
  );
  assert.equal(reservationsResponse.status, 200);
  assert.equal(
    Array.isArray((await reservationsResponse.json()).reservations),
    true,
  );
});
