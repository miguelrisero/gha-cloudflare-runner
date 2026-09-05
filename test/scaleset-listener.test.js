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
const { MAX_ACTIVE_RUNNERS } = await import("../src/autopilot-control.js");
const {
  ADMISSION_PROBE_MIN_INTERVAL_MS,
  ADMISSION_PROBE_SUCCESSES,
  ALARM_WALL_BUDGET_MS,
  ALARM_WORK_BUDGET_MS,
  DRAIN_RUNNER_RECHECK_MS,
  MAX_DISPATCH_CONCURRENCY,
  MAX_LIVENESS_PROBE_ATTEMPTS,
  MAX_LIVENESS_PROBES_PER_PASS,
  MAX_PACE_BACKOFF_DOUBLINGS,
  MAX_START_PACE_MS,
  MIN_ADMISSION_LIMIT,
  MIN_PACED_POLL_TIMEOUT_MS,
  MIN_RUNNERS,
  POOL_DECAY_MS,
  POOL_GROWTH_SLOTS_PER_SECOND,
  RECOVERY_BASE_DELAY_MS,
  RECOVERY_MAX_ATTEMPTS,
  RECOVERY_MAX_DELAY_MS,
  RUNNER_LIVENESS_PROBE_MIN_AGE_MS,
  START_PACE_MS,
  desiredRunnerCount,
  paceOutrunsPoolGrowth,
  pollTimeoutForElapsed,
} = await import("../src/scaleset-listener.js");
const { simulatePoolRamp } = await import("./pool-model.js");
const { SCALE_UP_REQUEST_ID_BASE } = await import(
  "../src/scaleset-protocol.js"
);

const CONTROL_TOKEN = "control-token-with-at-least-32-characters";
const OUTAGE_GATE_TOKEN = "outage-gate-token-with-at-least-32-characters";
const CLOCK_MS = 1_800_000_000_000;
const START_DEADLINE_MS = 60_000;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_TOKEN = "literal-message-session-token-secret";
const ADMIN_TOKEN = "literal-admin-token-secret";
const APP_JWT = "literal-app-jwt-secret";
const APP_PRIVATE_KEY = "literal-bare-base64-pkcs8-private-key-secret";
const GITHUB_TOKEN = "github-token-secret";
const INSTALLATION_TOKEN = "literal-installation-token-secret";
const REGISTRATION_TOKEN_URL =
  "https://api.github.com/repos/example-org/example-repo/" +
  "actions/runners/registration-token";
const REAL_GITHUB_403_BODY =
  "Request forbidden by administrative rules. Please make sure your request " +
  "has a User-Agent header (https://docs.github.com/en/rest/overview/" +
  "resources-in-the-rest-api#user-agent-required). Check " +
  "https://developer.github.com for other possible causes.";
const REFRESHED_ADMIN_TOKEN = "literal-refreshed-admin-token-secret";
const JIT_CONFIG = "literal-jit-config-secret";
const REGISTRATION_TOKEN = "literal-registration-token-secret";
const RUN_PREFIX = crypto.randomUUID();
const ACTIVE_RUNNER_CLEANUP_DELAY_MS = 3_600_000;
const STATISTICS = Object.freeze({
  totalAvailableJobs: 0,
  totalAcquiredJobs: 0,
  totalAssignedJobs: 1,
  totalRunningJobs: 0,
  totalRegisteredRunners: 0,
  totalBusyRunners: 0,
  totalIdleRunners: 0,
});
const CAPTURED_UNASSIGNED_JOB_COMPLETIONS = {
  messageId: 100000002,
  messageType: "RunnerScaleSetJobMessages",
  statistics: {
    totalAssignedJobs: 0,
    totalRunningJobs: 0,
    totalRegisteredRunners: 0,
    totalBusyRunners: 0,
    totalIdleRunners: 0,
    totalAvailableJobs: 0,
    totalAcquiredJobs: 0,
  },
  body: JSON.stringify([
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:22:51.585395516Z",
      jobId: "22cbc484-4585-59d1-b322-4cb72689d7b4",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Playwright browsers",
      workflowRunId: 32779061593,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:22:51.585337932Z",
      jobId: "38d60651-317a-5020-a32e-0f201c0ca047",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Redis",
      workflowRunId: 32779061593,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:22:51.58542456Z",
      jobId: "5e3a3eee-14a5-5b15-8a82-17dd2181a530",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · egress and action cache",
      workflowRunId: 32779061593,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:22:51.585372043Z",
      jobId: "fb145416-a680-5738-ae4c-550d147cb675",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · PostgreSQL",
      workflowRunId: 32779061593,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
  ]),
};

// The message that stopped the deployed listener. Provenance and the
// captured-versus-reconstructed breakdown live beside the copy in
// test/scaleset-protocol.test.js. The four `JobStarted` entries carry the
// captured `runnerRequestId: 0` of workflow run 32779061593.
const RECONSTRUCTED_UNASSIGNED_JOB_STARTS = {
  messageId: 100000006,
  messageType: "RunnerScaleSetJobMessages",
  statistics: {
    totalAssignedJobs: 3,
    totalRunningJobs: 3,
    totalRegisteredRunners: 4,
    totalBusyRunners: 3,
    totalIdleRunners: 0,
    totalAvailableJobs: 0,
    totalAcquiredJobs: 0,
  },
  body: JSON.stringify([
    {
      messageType: "JobStarted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "0001-01-01T00:00:00Z",
      jobId: "00000000-0000-0000-0000-000000000000",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Redis",
      workflowRunId: 32779061593,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 227,
      runnerName: "cloudflare-1-4503599627370517",
    },
    {
      messageType: "JobStarted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T22:29:53.121094892Z",
      jobId: "3fb0a03e-2845-58b5-b9ea-5972b26a7830",
      runnerAssignTime: "2026-08-25T09:05:11.292631415Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · PostgreSQL",
      workflowRunId: 32779061593,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 226,
      runnerName: "cloudflare-1-4503599627370518",
    },
    {
      messageType: "JobStarted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T22:29:53.121069575Z",
      jobId: "a6f789e2-e81a-55fc-9a65-1f7266f99bde",
      runnerAssignTime: "2026-08-25T09:05:10.113670815Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Playwright browsers",
      workflowRunId: 32779061593,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 228,
      runnerName: "cloudflare-1-4503599627370519",
    },
    {
      messageType: "JobStarted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.386409568Z",
      jobId: "b340e3db-74f0-5d8b-9bc9-4fbcd42793de",
      runnerAssignTime: "2026-08-25T09:05:08.772196059Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · egress and action cache",
      workflowRunId: 32779061593,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 225,
      runnerName: "cloudflare-1-4503599627370520",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "0001-01-01T00:00:00Z",
      jobId: "00000000-0000-0000-0000-000000000000",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Redis",
      workflowRunId: 32779061593,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 227,
      runnerName: "cloudflare-1-4503599627370517",
      result: "succeeded",
    },
  ]),
};

let worker;
let disabledWorker;
let unconfiguredWorker;
let noGithubTokenWorker;
let ambiguousRepositoryWorker;
let undeclaredRepositoryWorker;
let disallowedRepositoryWorker;
let permitKeys;
let capacityKeys;
let persistencePath;

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function devOptions(
  vars,
  config = "test/scaleset-listener-wrangler.jsonc",
  persistTo,
) {
  return {
    config,
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
    join(tmpdir(), "scaleset-listener-test-"),
  );
  permitKeys = await crypto.subtle.generateKey(
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
  [
    worker,
    disabledWorker,
    unconfiguredWorker,
    noGithubTokenWorker,
    ambiguousRepositoryWorker,
    undeclaredRepositoryWorker,
    disallowedRepositoryWorker,
  ] = await Promise.all([
    unstable_dev(
      "test/scaleset-listener-harness.js",
      devOptions({
        AUTOPILOT_ENABLED: "1",
        CAPACITY_APPROVAL_PUBLIC_KEY: capacityPublicKey,
        OUTAGE_GATE_PUBLIC_KEY: publicKey,
      }, undefined, join(persistencePath, "configured")),
    ).then(guardDevWorkerTransport),
    unstable_dev(
      "test/scaleset-listener-harness.js",
      devOptions(undefined, undefined, join(persistencePath, "disabled")),
    ).then(guardDevWorkerTransport),
    unstable_dev(
      "test/scaleset-listener-harness.js",
      devOptions(
        { AUTOPILOT_ENABLED: "1" },
        "test/scaleset-listener-unconfigured-wrangler.jsonc",
        join(persistencePath, "unconfigured"),
      ),
    ).then(guardDevWorkerTransport),
    unstable_dev(
      "test/scaleset-listener-harness.js",
      devOptions(
        { AUTOPILOT_ENABLED: "1" },
        "test/scaleset-listener-no-github-token-wrangler.jsonc",
        join(persistencePath, "no-github-token"),
      ),
    ).then(guardDevWorkerTransport),
    unstable_dev(
      "test/scaleset-listener-harness.js",
      devOptions({
        AUTOPILOT_ENABLED: "1",
        CAPACITY_APPROVAL_PUBLIC_KEY: capacityPublicKey,
        GITHUB_REPOSITORY_ALLOWLIST:
          "example/runner-test,example/other-repository",
        OUTAGE_GATE_PUBLIC_KEY: publicKey,
      }, undefined, join(persistencePath, "ambiguous-repository")),
    ).then(guardDevWorkerTransport),
    unstable_dev(
      "test/scaleset-listener-harness.js",
      devOptions({
        AUTOPILOT_ENABLED: "1",
        AUTOPILOT_SCALE_SETS: "{\"example-scale-set\": {\"actionsServiceUrl\": \"https://actions.stub.test/tenant\", \"adminToken\": \"literal-admin-token-secret\", \"adminTokenExpiresAtMs\": 8000000000000000, \"owner\": \"listener-owner\", \"outageGateCloseUrl\": \"https://outage-gate.stub.test/close\", \"outageGateUrl\": \"https://outage-gate.stub.test/permit\", \"runnerGroupId\": 17, \"scaleSetId\": 101, \"wave\": \"wave-1\", \"workerUrl\": \"https://worker.stub.test\"}}",
        CAPACITY_APPROVAL_PUBLIC_KEY: capacityPublicKey,
        GITHUB_REPOSITORY_ALLOWLIST:
          "example/runner-test,example/other-repository",
        OUTAGE_GATE_PUBLIC_KEY: publicKey,
      }, undefined, join(persistencePath, "undeclared-repository")),
    ).then(guardDevWorkerTransport),
    unstable_dev(
      "test/scaleset-listener-harness.js",
      devOptions({
        AUTOPILOT_ENABLED: "1",
        CAPACITY_APPROVAL_PUBLIC_KEY: capacityPublicKey,
        GITHUB_REPOSITORY_ALLOWLIST: "example/other-repository",
        OUTAGE_GATE_PUBLIC_KEY: publicKey,
      }, undefined, join(persistencePath, "disallowed-repository")),
    ).then(guardDevWorkerTransport),
  ]);
});

after(async () => {
  await Promise.all([
    worker?.stop(),
    disabledWorker?.stop(),
    unconfiguredWorker?.stop(),
    noGithubTokenWorker?.stop(),
    ambiguousRepositoryWorker?.stop(),
    undeclaredRepositoryWorker?.stop(),
    disallowedRepositoryWorker?.stop(),
  ]);
  await rm(persistencePath, { recursive: true, force: true });
});

async function listenerRpc(
  target,
  method,
  body = {},
  name = `listener-${crypto.randomUUID()}`,
) {
  const durableObjectName = `${RUN_PREFIX}-${name}`;
  const response = await target.fetch(
    `/harness/listener/${method}?name=${encodeURIComponent(durableObjectName)}`,
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

async function listenerStatusRoute(target, specification, name) {
  const durableObjectName = `${RUN_PREFIX}-${name}`;
  const response = await target.fetch(
    `/harness/listener-status-route?name=${encodeURIComponent(durableObjectName)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(specification),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

function emittedRecord(result, event) {
  return emittedRecords(result, event)[0];
}

function emittedRecords(result, event) {
  return result.snapshot.emittedRecords
    .map((record) => JSON.parse(record))
    .filter((record) => record.event === event);
}

function dispatchBudgetClockValues(expirationCall) {
  return [
    ...Array(expirationCall).fill(null),
    CLOCK_MS + 1_000 + ALARM_WORK_BUDGET_MS,
  ];
}

function pacedNoMessagePolls(count, paceMs = START_PACE_MS) {
  return Array.from({ length: count }, () => ({
    outcome: "no-message",
    advanceMs: paceMs,
  }));
}

async function autopilotControlRpc(target, name, method, body = {}) {
  const response = await target.fetch(
    `/harness/autopilot-control/${method}?name=${encodeURIComponent(name)}`,
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

async function approveCapacity(target, name, capacity) {
  const effectiveAtMs = CLOCK_MS;
  const approvedBy = "capacity-owner";
  const canonical = JSON.stringify({ approvedBy, capacity, effectiveAtMs });
  const signature = await crypto.subtle.sign(
    "Ed25519",
    capacityKeys.privateKey,
    new TextEncoder().encode(canonical),
  );
  return autopilotControlRpc(target, name, "recordCapacityApproval", {
    capacity,
    signature: base64Url(signature),
    effectiveAtMs,
    approvedBy,
  });
}

async function outagePermit(runnerRequestId, expiresAtMs) {
  const permitId = `permit-${runnerRequestId}-${expiresAtMs}`;
  const canonical = [
    permitId,
    101,
    runnerRequestId,
    "example/runner-test",
    expiresAtMs,
  ].join(".");
  const signature = await crypto.subtle.sign(
    "Ed25519",
    permitKeys.privateKey,
    new TextEncoder().encode(canonical),
  );
  return { permitId, expiresAtMs, signature: base64Url(signature) };
}

async function outagePermits(runnerRequestIds, expiresAtMs) {
  return Object.fromEntries(await Promise.all(runnerRequestIds.map(
    async (runnerRequestId) => [
      runnerRequestId,
      await outagePermit(runnerRequestId, expiresAtMs),
    ],
  )));
}

function persistedSessionState(overrides = {}) {
  return {
    actionsServiceUrl: "https://actions.stub.test/tenant",
    adminToken: ADMIN_TOKEN,
    adminTokenExpiresAtMs: 8_000_000_000_000_000,
    owner: "listener-owner",
    runnerGroupId: 17,
    scaleSetId: 101,
    scaleSetName: "example-scale-set",
    sessionCreatedAtMs: CLOCK_MS - 1_000,
    sessionId: SESSION_ID,
    sessionQueueToken: SESSION_TOKEN,
    sessionQueueUrl: "https://queue.stub.test/messages",
    ...overrides,
  };
}

function availableMessage(messageId, runnerRequestIds, overrides = {}) {
  return {
    messageId,
    available: runnerRequestIds,
    statistics: {
      ...STATISTICS,
      totalAvailableJobs: runnerRequestIds.length,
      totalAssignedJobs: 0,
    },
    ...overrides,
  };
}

function statisticsMessage(
  messageId,
  totalAssignedJobs,
  totalRegisteredRunners = 0,
  overrides = {},
) {
  return {
    messageId,
    statistics: {
      ...STATISTICS,
      totalAssignedJobs,
      totalRegisteredRunners,
      ...overrides,
    },
  };
}

function startedReservationRow(
  runnerRequestId,
  updatedAtMs,
  overrides = {},
) {
  return {
    runnerRequestId,
    state: "started",
    runnerName: `cloudflare-101-${runnerRequestId}`,
    runnerId: 9_000 + runnerRequestId,
    reservationId: `reservation-${runnerRequestId}`,
    updatedAtMs,
    ...overrides,
  };
}

function pendingAdmissionRows(firstRunnerRequestId, count, recordedAtMs) {
  return Array.from({ length: count }, (_, index) => ({
    runnerRequestId: firstRunnerRequestId + index,
    state: "pending",
    intentRecordedAtMs: recordedAtMs,
    updatedAtMs: recordedAtMs,
  }));
}

function livenessAlarmSpecification(overrides = {}) {
  return {
    clockMs: CLOCK_MS,
    polls: [{
      outcome: "no-message",
      advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
    }],
    ...overrides,
  };
}

function rawScaleSetMessage(messageId, entries, statistics = STATISTICS) {
  return {
    messageId,
    messageType: "RunnerScaleSetJobMessages",
    statistics,
    body: JSON.stringify(entries),
  };
}

function unassignedLifecycleEntry(
  messageType,
  runnerName,
  runnerId,
  overrides = {},
) {
  return {
    messageType,
    runnerRequestId: 0,
    ownerName: "example",
    repositoryName: "runner-test",
    runnerName,
    runnerId,
    ...overrides,
  };
}

test("policy constants retain the design arithmetic", async () => {
  const policy = await listenerRpc(worker, "policy", {}, "policy");
  assert.deepEqual(policy, {
    alarmWallBudgetMs: 900_000,
    alarmWorkBudgetMs: 10_000,
    heartbeatStaleMs: 60_000,
    maxDispatchConcurrency: 5,
    maxLivenessProbeAttempts: 3,
    maxLivenessProbesPerPass: 5,
    pollTimeoutMs: 50_000,
    recoveryBaseDelayMs: 2_000,
    recoveryMaxDelayMs: 60_000,
    recoveryMaxElapsedMs: 900_000,
    recoveryMaxAttempts: 6,
    runnerLivenessProbeMinAgeMs: 60_000,
    startDeadlineMs: 60_000,
    boundaryPollTimeouts: [50_000, 49_999, 0, -1],
  });
  assert.equal(
    policy.heartbeatStaleMs,
    policy.pollTimeoutMs + policy.alarmWorkBudgetMs,
  );
  assert.equal(policy.recoveryMaxElapsedMs, policy.alarmWallBudgetMs);
  assert.equal(
    policy.maxLivenessProbesPerPass,
    policy.maxDispatchConcurrency,
  );
  assert.equal(
    policy.maxLivenessProbeAttempts,
    MAX_LIVENESS_PROBE_ATTEMPTS,
  );
  assert.equal(
    policy.runnerLivenessProbeMinAgeMs,
    policy.startDeadlineMs,
  );
});

test("S1: desiredRunnerCount follows the reference scaler arithmetic", () => {
  const cases = [
    { maxRunners: 10, minRunners: 0, assignedJobs: 3, expected: 3 },
    { maxRunners: 3, minRunners: 0, assignedJobs: 10, expected: 3 },
    { maxRunners: 10, minRunners: 0, assignedJobs: 0, expected: 0 },
    { maxRunners: 0, minRunners: 0, assignedJobs: 10, expected: 0 },
    { maxRunners: 10, minRunners: 2, assignedJobs: 3, expected: 5 },
  ];
  for (const scenario of cases) {
    assert.equal(
      desiredRunnerCount(scenario),
      scenario.expected,
    );
  }
  for (const invalid of [
    { maxRunners: -1, minRunners: 0, assignedJobs: 0 },
    { maxRunners: 1, minRunners: -1, assignedJobs: 0 },
    { maxRunners: 1, minRunners: 0, assignedJobs: -1 },
    { maxRunners: 1.5, minRunners: 0, assignedJobs: 0 },
    { maxRunners: 1, minRunners: 0.5, assignedJobs: 0 },
    { maxRunners: 1, minRunners: 0, assignedJobs: Number.NaN },
  ]) {
    assert.throws(() => desiredRunnerCount(invalid), TypeError);
  }
  assert.equal(MIN_RUNNERS, 0);
});

test("idle-supply anti-famine preserves every step of a 30-job burst", () => {
  for (let live = 0; live <= 30; live += 1) {
    const idleRunners = live;
    const unownedIdleRunners = Math.max(0, idleRunners - live);
    const desired = desiredRunnerCount({
      maxRunners: MAX_ACTIVE_RUNNERS,
      minRunners: MIN_RUNNERS,
      assignedJobs: 30,
      unownedIdleRunners,
    });
    const shortfall = Math.max(0, desired - live);

    assert.equal(desired, 30, `live supply ${live} changed desired demand`);
    assert.equal(shortfall, 30 - live);
    assert.equal(shortfall === 0, live === 30);
  }
});

test("desiredRunnerCount rejects invalid unowned idle supply", () => {
  for (const unownedIdleRunners of [
    -1,
    0.5,
    Number.NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => desiredRunnerCount({
      maxRunners: 30,
      minRunners: MIN_RUNNERS,
      assignedJobs: 30,
      unownedIdleRunners,
    }), TypeError);
  }
});

test("an unset AUTOPILOT_ENABLED keeps the listener inert", async () => {
  const result = await listenerRpc(
    disabledWorker,
    "alarm",
    {},
    "disabled-default",
  );
  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "disabled");
  assert.equal(result.snapshot.calls.createSession, 0);
  assert.equal(result.snapshot.calls.poll, 0);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
});

test("an enabled listener without a scale set configuration stays inert", async () => {
  const result = await listenerRpc(
    unconfiguredWorker,
    "alarm",
    {},
    "missing-configuration",
  );
  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "disabled");
  assert.equal(result.snapshot.calls.createSession, 0);
  assert.equal(result.snapshot.calls.poll, 0);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
});

test("an enabled and configured listener passes both production gates", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {},
    "production-gates-positive",
  );
  assert.equal(result.error, null);
  assert.notEqual(result.result.outcome, "disabled");
});

test("S2: assigned-job statistics admit starts without acquisition work", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: statisticsMessage(101, 3),
        },
        {
          outcome: "message",
          advanceMs: START_PACE_MS,
          message: statisticsMessage(1011, 0),
        },
        ...pacedNoMessagePolls(1),
      ],
    },
    "statistics-scale-up-three",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox.length, 3);
  assert.equal(
    result.snapshot.outbox.every((row) =>
      row.runnerRequestId >= SCALE_UP_REQUEST_ID_BASE
    ),
    true,
  );
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.deepEqual(result.snapshot.intents, []);
  assert.equal(result.snapshot.calls.postRunners, 3);
  assert.equal(result.snapshot.listener.scaleUpSequence, 3);
  assert.equal(emittedRecords(result, "scale-up-start-admitted").length, 3);
});

test("idle-supply convergence stops an under-ceiling incident refill", async () => {
  const name = "idle-supply-under-ceiling-convergence";
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
        message: statisticsMessage(120_001, 5, 100, {
          totalIdleRunners: 100,
        }),
      }],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);
  const saturated = emittedRecord(result, "scale-up-saturated");

  assert.equal(result.error, null);
  assert.equal(saturated.desired, 0);
  assert.equal(saturated.shortfall, 0);
  assert.equal(saturated.idleRunners, 100);
  assert.equal(saturated.unownedIdleRunners, 100);
  assert.equal(saturated.liveSupply, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.deepEqual(result.snapshot.outbox, []);
  assert.equal(status.scaleUp.lastDecision.reason, "idle-supply-converged");
});

test("idle-supply anti-famine keeps a mid-burst scale-up at 30", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 10,
      polls: [{
        outcome: "message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
        message: statisticsMessage(120_002, 30, 10, {
          totalIdleRunners: 10,
        }),
      }],
    },
    "idle-supply-mid-burst-anti-famine",
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");
  const desiredWithoutLiveSubtraction = desiredRunnerCount({
    maxRunners: MAX_ACTIVE_RUNNERS,
    minRunners: MIN_RUNNERS,
    assignedJobs: 30,
    unownedIdleRunners: 10,
  });

  assert.equal(result.error, null);
  assert.equal(evaluation.desired, 30);
  assert.equal(desiredWithoutLiveSubtraction, 20);
  assert.equal(evaluation.idleRunners, 10);
  assert.equal(evaluation.unownedIdleRunners, 0);
  assert.equal(evaluation.liveSupply, 10);
  assert.equal(evaluation.shortfall, 20);
  assert.ok(evaluation.admitted > 0);
  assert.ok(result.snapshot.calls.postRunners > 0);
});

test("idle-supply clamp stays disabled without idle statistics", async () => {
  const name = "idle-supply-information-absent";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(120_003, 3, 20, {
          totalBusyRunners: undefined,
          totalIdleRunners: undefined,
        }).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "no-message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(evaluation.idleRunners, null);
  assert.equal(evaluation.unownedIdleRunners, 0);
  assert.equal(evaluation.desired, 3);
  assert.equal(evaluation.shortfall, 3);
  assert.ok(result.snapshot.calls.postRunners > 0);
});

test("idle-supply clamp derives registered minus busy runners", async () => {
  const name = "idle-supply-derived-fallback";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(120_004, 10, 8, {
          totalBusyRunners: 2,
          totalIdleRunners: undefined,
        }).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "no-message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(evaluation.idleRunners, 6);
  assert.equal(evaluation.unownedIdleRunners, 6);
  assert.equal(evaluation.desired, 4);
  assert.equal(evaluation.shortfall, 4);
  assert.ok(result.snapshot.calls.postRunners > 0);
});

test("S3: unapproved capacity prevents statistics scale-up", async () => {
  const name = "statistics-scale-up-unapproved-capacity";
  const controlName = `${RUN_PREFIX}-${name}-control`;
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(102, 5).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    { controlName },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "kill-switch");
  assert.deepEqual(result.snapshot.outbox, []);
  assert.equal(result.snapshot.calls.postRunners, 0);
});

test("S4: an outage-gate refusal fails every statistics start", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      outageGateStatus: 503,
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: statisticsMessage(103, 2),
        },
        {
          outcome: "message",
          advanceMs: START_PACE_MS,
          message: statisticsMessage(1031, 0),
        },
      ],
    },
    "statistics-scale-up-outage-gate",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox.length, 2);
  assert.equal(
    result.snapshot.outbox.every((row) =>
      row.state === "failed" && row.lastError === "outage-gate-refused"
    ),
    true,
  );
  assert.equal(result.snapshot.calls.outageGate, 2);
  assert.equal(result.snapshot.outageGateRequests.length, 2);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(emittedRecords(result, "runner-spawn-failed").length, 2);
});

test("S5: statistics scale-up obeys both runner ceilings", async () => {
  const globalCeiling = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: MAX_ACTIVE_RUNNERS + 20,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(104, MAX_ACTIVE_RUNNERS + 20),
      }],
    },
    "statistics-global-ceiling",
  );
  const globalEvaluation = emittedRecord(
    globalCeiling,
    "scale-up-evaluated",
  );
  assert.equal(globalEvaluation.maxRunners, MAX_ACTIVE_RUNNERS);
  assert.equal(globalEvaluation.desired, MAX_ACTIVE_RUNNERS);

  const approvedCeiling = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: 3,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(105, 20),
      }],
    },
    "statistics-approved-ceiling",
  );
  const approvedEvaluation = emittedRecord(
    approvedCeiling,
    "scale-up-evaluated",
  );
  assert.equal(approvedEvaluation.maxRunners, 3);
  assert.equal(approvedEvaluation.desired, 3);
  assert.equal(approvedCeiling.snapshot.outbox.length, 3);
});

test("S6: a failed statistics start receives a new identifier next poll", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: statisticsMessage(106, 1),
        },
        {
          outcome: "message",
          advanceMs: START_PACE_MS,
          message: statisticsMessage(107, 1),
        },
      ],
      startStatuses: [503, 202],
    },
    "statistics-failed-start-recovery",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox.length, 2);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "start-request-failed:503",
  );
  assert.equal(result.snapshot.outbox[1].state, "started");
  assert.ok(
    result.snapshot.outbox[1].runnerRequestId >
      result.snapshot.outbox[0].runnerRequestId,
  );
  assert.equal(result.snapshot.calls.postRunners, 2);
  assert.equal(emittedRecords(result, "runner-spawn-failed").length, 1);
});

test("S7: live reservations reduce the statistics shortfall", async () => {
  const name = "statistics-control-census";
  const controlName = `${RUN_PREFIX}-${name}-control`;
  const firstRunnerRequestIds = [
    SCALE_UP_REQUEST_ID_BASE + 1,
    SCALE_UP_REQUEST_ID_BASE + 2,
  ];
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });
  assert.equal(
    (await approveCapacity(worker, controlName, 3)).recorded,
    true,
  );

  const first = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      controlName,
      outagePermits: await outagePermits(
        firstRunnerRequestIds,
        CLOCK_MS + 1_000 + START_DEADLINE_MS,
      ),
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: statisticsMessage(108, 2),
        },
        ...pacedNoMessagePolls(1),
      ],
    },
    name,
  );
  assert.equal(first.error, null);
  assert.equal(first.snapshot.outbox.length, 2);
  assert.equal(
    (await autopilotControlRpc(worker, controlName, "status"))
      .liveReservationCount,
    2,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 7_000,
      controlName,
      outagePermits: await outagePermits(
        [SCALE_UP_REQUEST_ID_BASE + 3],
        CLOCK_MS + 8_000 + START_DEADLINE_MS,
      ),
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(1082, 3),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.equal(result.snapshot.outbox.length, 3);
  const evaluation = emittedRecord(result, "scale-up-evaluated");
  assert.equal(evaluation.registeredRunners, 0);
  assert.equal(evaluation.liveReservationCount, 2);
  assert.equal(evaluation.unreservedDispatches, 0);
  assert.equal(evaluation.shortfall, 1);
  assert.equal(evaluation.admitted, 1);
});

test("S8: a closed local gate runs the kill switch before statistics scale-up", async () => {
  const name = "statistics-kill-switch";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(109, 2).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    { controlClosed: true },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "kill-switch");
  assert.deepEqual(result.snapshot.outbox, []);
  assert.equal(result.snapshot.calls.postRunners, 0);
});

test("S9: a reserved GitHub identifier stops the listener", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: {
          messageId: 110,
          messageType: "RunnerScaleSetJobMessages",
          statistics: statisticsMessage(110, 1).statistics,
          body: JSON.stringify([{
            messageType: "JobAvailable",
            runnerRequestId: SCALE_UP_REQUEST_ID_BASE,
            ownerName: "example",
            repositoryName: "runner-test",
          }]),
        },
      }],
    },
    "statistics-reserved-identifier-quarantine",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.mode, "stopped");
  assert.match(
    result.snapshot.listener.stoppedReason,
    /routing-semantics:reserved-runner-request-id/u,
  );
  assert.equal(result.snapshot.calls.closeGate, 1);
  assert.deepEqual(result.snapshot.outbox, []);
});

test("S10: a declared repository admits under a wider allow-list", async () => {
  // The listener attributes every start to one repository. When the scale set
  // declares its own, a second allowed repository cannot make that attribution
  // ambiguous, so a second scale set can run beside the primary one.
  const result = await listenerRpc(
    ambiguousRepositoryWorker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(111, 2),
      }],
    },
    "statistics-declared-repository",
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecord(result, "scale-up-refused"), undefined);
  assert.ok(
    result.snapshot.outbox.length > 0,
    "a declared repository must admit a start",
  );
  for (const row of result.snapshot.outbox) {
    assert.equal(row.repository, "example/runner-test");
  }
});

test("S10a: an undeclared repository refuses under a wider allow-list", async () => {
  // Without a declared repository the listener falls back to
  // GITHUB_REPOSITORY, so a second allowed repository leaves the attribution
  // undetermined. Refuse rather than guess.
  const result = await listenerRpc(
    undeclaredRepositoryWorker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(111, 2),
      }],
    },
    "statistics-undeclared-repository",
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.outbox, []);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(
    emittedRecord(result, "scale-up-refused").reason,
    "repository-attribution-ambiguous",
  );
});

test("S10b: a repository outside the allow-list refuses", async () => {
  const result = await listenerRpc(
    disallowedRepositoryWorker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(111, 2),
      }],
    },
    "statistics-disallowed-repository",
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.outbox, []);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(
    emittedRecord(result, "scale-up-refused").reason,
    "repository-not-allowed",
  );
});

test("runner registrations above the ceiling refuse statistics scale-up", async () => {
  const name = "statistics-registration-leak-refusal";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(
          1111,
          1,
          MAX_ACTIVE_RUNNERS + 1,
        ).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "no-message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "scale-up-refused").length, 1);
  assert.equal(
    emittedRecord(result, "scale-up-refused").reason,
    "registration-leak",
  );
  assert.equal(
    emittedRecords(result, "scale-up-start-admitted").length,
    0,
  );
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.deepEqual(result.snapshot.outbox, []);
  assert.equal(status.scaleUp.lastDecision.reason, "registration-leak");
});

test("runner registrations at the ceiling admit statistics scale-up", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(1112, 1, MAX_ACTIVE_RUNNERS),
      }],
    },
    "statistics-registration-ceiling-boundary",
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "scale-up-refused").length, 0);
  assert.equal(
    emittedRecords(result, "scale-up-start-admitted").length,
    1,
  );
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.equal(result.snapshot.outbox[0].state, "started");
});

test("S11: one statistics pass respects dispatch admission capacity", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: 20,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(112, 20),
      }],
    },
    "statistics-admission-cap",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox.length, MAX_DISPATCH_CONCURRENCY);
  assert.ok(result.snapshot.outbox.length <= MAX_DISPATCH_CONCURRENCY);
  assert.equal(
    emittedRecord(result, "scale-up-evaluated").admitted,
    MAX_DISPATCH_CONCURRENCY,
  );
});

test("S12: a statistics start never creates an acquisition intent", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(113, 1),
      }],
    },
    "statistics-no-acquisition-coupling",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].state, "started");
  assert.deepEqual(result.snapshot.intents, []);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.deepEqual(result.snapshot.acquisitionIntentCountsAtStart, [0]);
});

test("statistics refusal reasons remain observable", async (t) => {
  await t.test("malformed statistics", async () => {
    const name = "statistics-malformed-refusal";
    await listenerRpc(
      worker,
      "seed",
      {
        state: persistedSessionState({ latestStatistics: [] }),
      },
      name,
    );
    const result = await listenerRpc(
      worker,
      "alarm",
      {
        polls: [
          { outcome: "no-message", advanceMs: 1_000 },
          { outcome: "no-message", advanceMs: 1_000 },
          { outcome: "no-message", advanceMs: 1_000 },
        ],
      },
      name,
    );
    assert.equal(emittedRecords(result, "scale-up-refused").length, 1);
    assert.equal(
      emittedRecord(result, "scale-up-refused").reason,
      "statistics-unavailable",
    );
  });

  await t.test("repository unconfigured", async () => {
    const result = await listenerRpc(
      worker,
      "alarm",
      {
        config: { repository: "" },
        polls: [{
          outcome: "message",
          advanceMs: 1_000,
          message: statisticsMessage(114, 1),
        }],
      },
      "statistics-repository-unconfigured-refusal",
    );
    assert.equal(
      emittedRecord(result, "scale-up-refused").reason,
      "repository-unconfigured",
    );
    assert.deepEqual(result.snapshot.outbox, []);
  });

  await t.test("request identifier space exhausted", async () => {
    const name = "statistics-request-id-exhausted-refusal";
    await listenerRpc(
      worker,
      "seed",
      {
        state: persistedSessionState({
          scaleUpSequence:
            Number.MAX_SAFE_INTEGER - SCALE_UP_REQUEST_ID_BASE - 1,
        }),
      },
      name,
    );
    const result = await listenerRpc(
      worker,
      "alarm",
      {
        polls: [{
          outcome: "message",
          advanceMs: 1_000,
          message: statisticsMessage(115, 2),
        }],
      },
      name,
    );
    assert.equal(
      emittedRecord(result, "scale-up-refused").reason,
      "request-id-space-exhausted",
    );
    assert.equal(result.snapshot.outbox.length, 1);
    assert.equal(
      result.snapshot.outbox[0].runnerRequestId,
      Number.MAX_SAFE_INTEGER,
    );
  });
});

test("S13: scale-up schema migration is additive and idempotent", async () => {
  const name = "statistics-schema-migration";
  const runnerRequestId = 11601;
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId,
        messageId: 116,
        state: "granted",
        recordedAtMs: CLOCK_MS - 1_000,
      }],
      outbox: [{
        runnerRequestId,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      }],
      legacyScaleUpSchema: true,
    },
    name,
  );
  assert.equal(seeded.legacyScaleUpSchemaSeeded, true);

  await listenerRpc(worker, "reconstruct", {}, name);
  const firstSnapshot = await listenerRpc(worker, "inspect", {}, name);
  assert.equal(firstSnapshot.outbox.length, 1);
  assert.equal(firstSnapshot.outbox[0].runnerRequestId, runnerRequestId);
  assert.equal(firstSnapshot.outbox[0].intentRecordedAtMs, null);
  assert.equal(firstSnapshot.outbox[0].livenessProbeAttempts, 0);
  assert.equal(firstSnapshot.outbox[0].livenessProbedAtMs, null);
  assert.equal(firstSnapshot.intents[0].runnerRequestId, runnerRequestId);

  const secondStatus = await listenerRpc(worker, "reconstruct", {}, name);
  const secondSnapshot = await listenerRpc(worker, "inspect", {}, name);
  assert.deepEqual(secondStatus.scaleUp, {
    activeDispatches: 1,
    unreservedDispatches: 1,
    lastSequence: 0,
    lastDecision: null,
    lastDecisionAtMs: null,
  });
  assert.equal(firstSnapshot.listener.scaleUpSequence, 0);
  assert.deepEqual(secondSnapshot.outbox, firstSnapshot.outbox);
  assert.deepEqual(secondSnapshot.intents, firstSnapshot.intents);
});

test("liveness schema migration resets stale attempts and restores probing", async () => {
  const name = "liveness-schema-migration";
  const updatedAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1;
  const row = startedReservationRow(11_602, updatedAtMs, {
    livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS,
  });
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [row],
      legacyLivenessProbeSchema: true,
    },
    name,
  );
  assert.equal(seeded.legacyLivenessProbeSchemaSeeded, true);

  await listenerRpc(worker, "reconstruct", {}, name);
  const migrated = await listenerRpc(worker, "inspect", {}, name);
  assert.equal(migrated.outbox[0].livenessProbeAttempts, 0);
  assert.equal(migrated.outbox[0].updatedAtMs, updatedAtMs);

  const probed = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ error: "post-migration liveness failure" }],
    }),
    name,
  );
  assert.equal(probed.error, null);
  assert.equal(probed.snapshot.calls.getRunnerByName, 1);
  assert.equal(probed.snapshot.outbox[0].livenessProbeAttempts, 1);
  assert.equal(probed.snapshot.outbox[0].updatedAtMs, updatedAtMs);

  await listenerRpc(worker, "reconstruct", {}, name);
  const reconstructed = await listenerRpc(worker, "inspect", {}, name);
  assert.equal(reconstructed.outbox[0].livenessProbeAttempts, 1);
});

test("settle rotation schema migration is additive and idempotent", async () => {
  const name = "settle-rotation-schema-migration";
  const runnerRequestId = 11_603;
  const updatedAtMs = CLOCK_MS - 10_000;
  const row = startedReservationRow(runnerRequestId, updatedAtMs, {
    state: "failed",
    spawnObserved: true,
    attempts: 2,
    livenessProbeAttempts: 3,
    livenessProbedAtMs: updatedAtMs + 1_000,
    undeliveredCheckedAtMs: updatedAtMs + 2_000,
    lastError: "legacy settlement failure",
    intentRecordedAtMs: updatedAtMs - 1_000,
  });
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [row],
      legacySettleRotationSchema: true,
    },
    name,
  );
  assert.equal(seeded.legacySettleRotationSchemaSeeded, true);

  await listenerRpc(worker, "reconstruct", {}, name);
  const firstSnapshot = await listenerRpc(worker, "inspect", {}, name);
  assert.deepEqual(firstSnapshot.outbox[0], {
    runnerRequestId,
    state: "failed",
    runnerName: row.runnerName,
    runnerId: row.runnerId,
    correlationId: `scale-set:101:runner-request:${runnerRequestId}`,
    repository: "example/runner-test",
    wave: "wave-1",
    reservationId: row.reservationId,
    reservationReleasedAtMs: null,
    settleCheckedAtMs: null,
    spawnObserved: true,
    attempts: 2,
    livenessProbeAttempts: 3,
    livenessProbedAtMs: updatedAtMs + 1_000,
    undeliveredCheckedAtMs: updatedAtMs + 2_000,
    lastError: "legacy settlement failure",
    intentRecordedAtMs: updatedAtMs - 1_000,
    updatedAtMs,
    jitConfigPresent: false,
  });

  await listenerRpc(worker, "reconstruct", {}, name);
  const secondSnapshot = await listenerRpc(worker, "inspect", {}, name);
  assert.deepEqual(secondSnapshot.outbox, firstSnapshot.outbox);
});

test("scale-up decision schema migration is additive and idempotent", async () => {
  const name = "statistics-decision-schema-migration";
  const runnerRequestId = 11602;
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ scaleUpSequence: 7 }),
      outbox: [{
        runnerRequestId,
        state: "pending",
        intentRecordedAtMs: CLOCK_MS,
        updatedAtMs: CLOCK_MS,
      }],
      legacyScaleUpDecisionSchema: true,
    },
    name,
  );
  assert.equal(seeded.legacyScaleUpDecisionSchemaSeeded, true);

  const firstStatus = await listenerRpc(worker, "reconstruct", {}, name);
  const firstSnapshot = await listenerRpc(worker, "inspect", {}, name);
  assert.deepEqual(firstStatus.scaleUp, {
    activeDispatches: 1,
    unreservedDispatches: 1,
    lastSequence: 7,
    lastDecision: null,
    lastDecisionAtMs: null,
  });
  assert.equal(firstSnapshot.listener.scaleUpSequence, 7);
  assert.equal(firstSnapshot.outbox[0].runnerRequestId, runnerRequestId);

  const secondStatus = await listenerRpc(worker, "reconstruct", {}, name);
  const secondSnapshot = await listenerRpc(worker, "inspect", {}, name);
  assert.deepEqual(secondStatus.scaleUp, firstStatus.scaleUp);
  assert.deepEqual(secondSnapshot.outbox, firstSnapshot.outbox);
});

test("start-gate schema migration is additive and idempotent", async () => {
  const name = "start-gate-schema-migration";
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      legacyStartGateSchema: true,
    },
    name,
  );
  assert.equal(seeded.legacyStartGateSchemaSeeded, true);

  const firstStatus = await listenerRpc(worker, "reconstruct", {}, name);
  assert.deepEqual(firstStatus.startGate, {
    lastRefusal: null,
    lastRefusalAtMs: null,
    lastClosedReason: null,
    lastClosedAtMs: null,
  });

  const secondStatus = await listenerRpc(worker, "reconstruct", {}, name);
  assert.deepEqual(secondStatus.startGate, firstStatus.startGate);
});

test("legacy recovery schema migration preserves every row", async () => {
  const expectedLegacyRows = [
    {
      condition: "github-rate-limit",
      first_failure_at_ms: 1_800_000_123_456,
      attempts: 4,
      next_attempt_at_ms: 1_800_000_234_567,
      exhausted_marker: null,
    },
    {
      condition: "scale-set-not-found",
      first_failure_at_ms: 1_800_000_345_678,
      attempts: 6,
      next_attempt_at_ms: 1_800_000_456_789,
      exhausted_marker: "scale-set-recovery-exhausted",
    },
  ];
  const result = await listenerRpc(
    worker,
    "legacy-recovery-schema-migration",
    {},
    "legacy-recovery-schema-migration",
  );

  assert.deepEqual(result.legacy.rows, expectedLegacyRows);
  assert.doesNotMatch(result.legacy.tableSql, /'alarm-failure'/);
  assert.deepEqual(result.legacy.tableNames, ["recovery"]);
  assert.deepEqual(result.migrated.rows, expectedLegacyRows);
  assert.match(result.migrated.tableSql, /'alarm-failure'/);
  assert.match(result.migrated.tableSql, /'session-expired'/);
  assert.deepEqual(result.migrated.tableNames, ["recovery"]);
  assert.deepEqual(result.migrated.sentinelIndexes, []);
  assert.deepEqual(result.beforeSecondInitialization.rows, [
    {
      condition: "alarm-failure",
      first_failure_at_ms: 1_800_000_567_890,
      attempts: 2,
      next_attempt_at_ms: 1_800_000_678_901,
      exhausted_marker: null,
    },
    ...expectedLegacyRows,
  ]);
  assert.deepEqual(
    result.beforeSecondInitialization.tableNames,
    ["recovery"],
  );
  assert.deepEqual(
    result.beforeSecondInitialization.sentinelIndexes,
    ["harness_recovery_legacy_sentinel"],
  );
  assert.deepEqual(
    result.afterSecondInitialization,
    result.beforeSecondInitialization,
  );
});

test("fresh recovery schema initialization does not rebuild the table", async () => {
  const result = await listenerRpc(
    worker,
    "fresh-recovery-schema-initialization",
    {},
    "fresh-recovery-schema-initialization",
  );
  const expectedRows = [{
    condition: "session-conflict",
    first_failure_at_ms: 1_800_000_789_012,
    attempts: 3,
    next_attempt_at_ms: 1_800_000_890_123,
    exhausted_marker: "session-reclaim-exhausted",
  }];

  assert.match(result.beforeSecondInitialization.tableSql, /'alarm-failure'/);
  assert.match(
    result.beforeSecondInitialization.tableSql,
    /'session-expired'/,
  );
  assert.deepEqual(result.beforeSecondInitialization.tableNames, ["recovery"]);
  assert.deepEqual(result.beforeSecondInitialization.rows, expectedRows);
  assert.deepEqual(
    result.beforeSecondInitialization.sentinelIndexes,
    ["harness_recovery_fresh_sentinel"],
  );
  assert.deepEqual(
    result.afterSecondInitialization,
    result.beforeSecondInitialization,
  );
});

test("S14: unchanged statistics do not admit a second wave", async () => {
  const name = "statistics-unchanged-census";
  const controlName = `${RUN_PREFIX}-${name}-control`;
  const runnerRequestIds = [1, 2, 3, 4].map(
    (sequence) => SCALE_UP_REQUEST_ID_BASE + sequence,
  );
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });
  assert.equal(
    (await approveCapacity(worker, controlName, runnerRequestIds.length))
      .recorded,
    true,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      controlName,
      outagePermits: await outagePermits(
        runnerRequestIds,
        CLOCK_MS + 1_000 + START_DEADLINE_MS,
      ),
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: statisticsMessage(1140, runnerRequestIds.length),
        },
        ...pacedNoMessagePolls(runnerRequestIds.length - 1),
      ],
    },
    name,
  );

  // Reverting the census to statistics.totalRegisteredRunners makes this test
  // red because the second poll admits another wave after the rows start.
  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox.length, runnerRequestIds.length);
  assert.equal(result.snapshot.calls.postRunners, runnerRequestIds.length);
  assert.equal(
    emittedRecords(result, "scale-up-start-admitted").length,
    runnerRequestIds.length,
  );
  assert.equal(
    result.snapshot.outbox.every((row) => row.state === "started"),
    true,
  );
});

test("S15: repeated scale-up decisions are deduplicated", async () => {
  const activeDispatches = Array.from(
    { length: MAX_DISPATCH_CONCURRENCY },
    (_, index) => ({
      runnerRequestId: 11501 + index,
      state: "pending",
      intentRecordedAtMs: CLOCK_MS - START_DEADLINE_MS,
      updatedAtMs: CLOCK_MS,
    }),
  );
  const name = "statistics-decision-dedupe";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: activeDispatches,
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [
        {
          outcome: "message",
          advanceMs: 0,
          message: statisticsMessage(1150, 10),
        },
        { outcome: "no-message", advanceMs: 0 },
        { outcome: "no-message", advanceMs: 0 },
        { outcome: "no-message", advanceMs: 0 },
      ],
    },
    name,
  );

  const evaluations = emittedRecords(result, "scale-up-evaluated");
  assert.equal(result.error, null);
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].shortfall, MAX_DISPATCH_CONCURRENCY);
  assert.equal(evaluations[0].admitted, 0);
  assert.equal(
    emittedRecords(result, "scale-up-start-admitted").length,
    0,
  );

  const admitted = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(1151, 3),
      }],
    },
    "statistics-admission-events",
  );
  assert.equal(admitted.error, null);
  assert.equal(
    emittedRecords(admitted, "scale-up-start-admitted").length,
    3,
  );
});

test("S16: absent statistics emit no scale-up refusal", async () => {
  const name = "statistics-absent-silent";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ latestStatistics: null }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        { outcome: "no-message", advanceMs: 1_000 },
        { outcome: "no-message", advanceMs: 1_000 },
        { outcome: "no-message", advanceMs: 1_000 },
      ],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "scale-up-refused").length, 0);
});

test("poll-aborted statistics still admit scale-up starts", async () => {
  const name = "poll-aborted-statistics-scale-up";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(1160, 4).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      maxCapacity: 10,
      polls: [{ outcome: "poll-aborted", advanceMs: 50_000 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.ok(result.snapshot.listener.scaleUpSequence > 0);
  assert.ok(emittedRecords(result, "scale-up-start-admitted").length > 0);
});

test("poll-aborted dispatches a pending outbox row", async () => {
  const name = "poll-aborted-pending-dispatch";
  const runnerRequestId = 11611;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(1161, 0).statistics,
      }),
      outbox: [{
        runnerRequestId,
        state: "pending",
        intentRecordedAtMs: CLOCK_MS,
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "poll-aborted", advanceMs: 50_000 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].state, "started");
  assert.equal(result.snapshot.calls.postRunners, 1);
});

test("absent statistics persist a silent scale-up decision", async () => {
  const name = "statistics-absent-persisted-decision";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ latestStatistics: null }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 890_000 }],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "scale-up-refused").length, 0);
  assert.deepEqual(status.scaleUp.lastDecision, {
    reason: "statistics-absent",
  });
  assert.equal(status.scaleUp.lastDecisionAtMs, CLOCK_MS + 890_000);
});

test("zero assigned jobs persist the scale-up decision", async () => {
  const name = "statistics-zero-assigned-decision";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(1162, 0, 2).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 890_000 }],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.deepEqual(status.scaleUp.lastDecision, {
    reason: "no-assigned-jobs",
    totalAssignedJobs: 0,
    minRunners: MIN_RUNNERS,
    registeredRunners: 2,
  });
});

test("exhausted work budget persists the scale-up decision", async () => {
  const name = "statistics-work-budget-exhausted-decision";
  const workStartMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const workDeadlineMs = CLOCK_MS + ALARM_WALL_BUDGET_MS;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(1163, 3).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      clockValues: [
        CLOCK_MS,
        CLOCK_MS,
        CLOCK_MS,
        CLOCK_MS,
        workStartMs,
        workStartMs,
        workStartMs,
        workDeadlineMs,
      ],
      polls: [{
        outcome: "no-message",
        advanceMs: workStartMs - CLOCK_MS,
      }],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.deepEqual(status.scaleUp.lastDecision, {
    reason: "work-budget-exhausted",
  });
});

test("elapsed statistics deadline persists its arithmetic", async () => {
  const name = "statistics-work-deadline-elapsed-decision";
  const workStartMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const workDeadlineMs = CLOCK_MS + ALARM_WALL_BUDGET_MS;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(1164, 4, 2).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      clockValues: [
        CLOCK_MS,
        CLOCK_MS,
        CLOCK_MS,
        CLOCK_MS,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workDeadlineMs,
      ],
      liveReservationCount: 1,
      maxCapacity: 10,
      polls: [{
        outcome: "no-message",
        advanceMs: workStartMs - CLOCK_MS,
      }],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.deepEqual(status.scaleUp.lastDecision, {
    reason: "work-deadline-elapsed",
    totalAssignedJobs: 4,
    maxRunners: 10,
    minRunners: MIN_RUNNERS,
    desired: 4,
    idleRunners: 0,
    unownedIdleRunners: 0,
    registeredRunners: 2,
    liveReservationCount: 1,
    liveSupply: 1,
  });
});

test("covered assigned jobs persist no-shortfall arithmetic", async () => {
  const name = "statistics-no-shortfall-decision";
  const workStartMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(1165, 1).statistics,
      }),
      outbox: [{
        runnerRequestId: 11651,
        state: "pending",
        intentRecordedAtMs: workStartMs,
        updatedAtMs: workStartMs,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      maxCapacity: 10,
      polls: [{
        outcome: "no-message",
        advanceMs: workStartMs - CLOCK_MS,
      }],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.deepEqual(status.scaleUp.lastDecision, {
    reason: "no-shortfall",
    totalAssignedJobs: 1,
    maxRunners: 10,
    minRunners: MIN_RUNNERS,
    desired: 1,
    idleRunners: 0,
    unownedIdleRunners: 0,
    registeredRunners: 0,
    activeStarts: 1,
    liveReservationCount: 0,
    unreservedDispatches: 1,
    liveSupply: 1,
    shortfall: 0,
    admitted: 0,
    admissionLimit: null,
    availabilityHeadroom: null,
    admissionLimited: false,
    contendingCount: 0,
    neverSpawnedCount: 0,
  });
});

test("scale-up saturation is observable and deduplicated", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 2,
      maxCapacity: 10,
      polls: [
        {
          outcome: "message",
          advanceMs: 0,
          message: statisticsMessage(11_651, 2),
        },
        { outcome: "no-message", advanceMs: 0 },
        { outcome: "poll-aborted", advanceMs: 890_000 },
      ],
    },
    "statistics-scale-up-saturated",
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "scale-up-saturated").length, 1);
  assert.deepEqual(emittedRecord(result, "scale-up-saturated"), {
    source: "ScaleSetListener",
    event: "scale-up-saturated",
    createdAtMs: CLOCK_MS,
    scaleSet: "example-scale-set",
    scaleSetId: 101,
    sessionId: SESSION_ID,
    messageId: null,
    runnerRequestId: null,
    registryCorrelation: null,
    sandboxId: null,
    runnerId: null,
    runnerName: null,
    workflow: null,
    wave: null,
    totalAssignedJobs: 2,
    maxRunners: 10,
    minRunners: MIN_RUNNERS,
    desired: 2,
    idleRunners: 0,
    unownedIdleRunners: 0,
    registeredRunners: 0,
    activeStarts: 0,
    liveReservationCount: 2,
    unreservedDispatches: 0,
    liveSupply: 2,
    shortfall: 0,
    admitted: 0,
    admissionLimit: null,
    availabilityHeadroom: null,
    admissionLimited: false,
    contendingCount: 0,
    neverSpawnedCount: 0,
  });
  assert.equal(emittedRecords(result, "scale-up-start-admitted").length, 0);
});

test("elapsed allocation deadline persists its arithmetic", async () => {
  const name = "statistics-allocation-deadline-elapsed-decision";
  const workStartMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const workDeadlineMs = CLOCK_MS + ALARM_WALL_BUDGET_MS;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(1166, 4, 2).statistics,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      clockValues: [
        CLOCK_MS,
        CLOCK_MS,
        CLOCK_MS,
        CLOCK_MS,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workStartMs,
        workDeadlineMs,
      ],
      liveReservationCount: 1,
      maxCapacity: 10,
      polls: [{
        outcome: "no-message",
        advanceMs: workStartMs - CLOCK_MS,
      }],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.deepEqual(status.scaleUp.lastDecision, {
    reason: "work-deadline-elapsed-before-allocation",
    totalAssignedJobs: 4,
    maxRunners: 10,
    minRunners: MIN_RUNNERS,
    desired: 4,
    idleRunners: 0,
    unownedIdleRunners: 0,
    registeredRunners: 2,
    activeStarts: 0,
    liveReservationCount: 1,
    unreservedDispatches: 0,
    liveSupply: 1,
    shortfall: 3,
    admitted: 3,
    admissionLimit: null,
    availabilityHeadroom: null,
    admissionLimited: false,
    contendingCount: 0,
    neverSpawnedCount: 0,
  });
});

test("deduplicated saturation remains the latest scale-up decision", async () => {
  const activeDispatches = Array.from(
    { length: MAX_DISPATCH_CONCURRENCY },
    (_, index) => ({
      runnerRequestId: 11620 + index,
      state: "pending",
      intentRecordedAtMs: CLOCK_MS - START_DEADLINE_MS,
      updatedAtMs: CLOCK_MS,
    }),
  );
  const name = "statistics-saturation-persisted-decision";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        latestStatistics: statisticsMessage(1163, 10).statistics,
      }),
      outbox: activeDispatches,
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      maxCapacity: 10,
      polls: [
        { outcome: "no-message", advanceMs: 0 },
        { outcome: "no-message", advanceMs: 890_000 },
      ],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "scale-up-evaluated").length, 1);
  assert.deepEqual(status.scaleUp.lastDecision, {
    reason: "dispatch-concurrency-saturated",
    totalAssignedJobs: 10,
    maxRunners: 10,
    minRunners: MIN_RUNNERS,
    desired: 10,
    idleRunners: 0,
    unownedIdleRunners: 0,
    registeredRunners: 0,
    activeStarts: MAX_DISPATCH_CONCURRENCY,
    liveReservationCount: 0,
    unreservedDispatches: MAX_DISPATCH_CONCURRENCY,
    liveSupply: MAX_DISPATCH_CONCURRENCY,
    shortfall: MAX_DISPATCH_CONCURRENCY,
    admitted: 0,
    admissionLimit: null,
    availabilityHeadroom: null,
    admissionLimited: false,
    contendingCount: 0,
    neverSpawnedCount: 0,
  });
  assert.equal(status.scaleUp.lastDecisionAtMs, CLOCK_MS + 890_000);
});

test("successful admission persists the allocated start count", async () => {
  const name = "statistics-starts-admitted-decision";
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      maxCapacity: 10,
      polls: [{
        outcome: "message",
        advanceMs: 890_000,
        message: statisticsMessage(1164, 3),
      }],
    },
    name,
  );
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "scale-up-start-admitted").length, 3);
  assert.deepEqual(status.scaleUp.lastDecision, {
    reason: "starts-admitted",
    totalAssignedJobs: 3,
    maxRunners: 10,
    minRunners: MIN_RUNNERS,
    desired: 3,
    idleRunners: 0,
    unownedIdleRunners: 0,
    registeredRunners: 0,
    activeStarts: 0,
    liveReservationCount: 0,
    unreservedDispatches: 0,
    liveSupply: 0,
    shortfall: 3,
    admitted: 3,
    admissionLimit: null,
    availabilityHeadroom: null,
    admissionLimited: false,
    contendingCount: 0,
    neverSpawnedCount: 0,
    startsAdmitted: 3,
  });
});

test("S17: a statistics start is reconciled by its registry correlation", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(117, 1),
      }],
      reconciledSandboxId: "runner-reconciled-statistics",
      reconciledStart: true,
      startErrors: ["network"],
    },
    "statistics-reconciled-start",
  );
  const row = result.snapshot.outbox[0];
  const expectedCorrelation =
    `scale-set:${result.snapshot.listener.scaleSetId}:runner-request:${row.runnerRequestId}`;

  // This property keeps a reserved-band start reconcilable: the Worker never
  // sees the identifier, only the correlation, and the reserved band cannot
  // push that string past the Worker's reflected-length bound.
  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox.length, 1);
  assert.ok(row.runnerRequestId >= SCALE_UP_REQUEST_ID_BASE);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 1);
  assert.deepEqual(result.snapshot.getStartCorrelations, [row.correlationId]);
  assert.equal(row.correlationId, expectedCorrelation);
  assert.ok(row.correlationId.length <= 58);
  assert.equal(row.state, "started");
  assert.equal(result.snapshot.calls.postRunners, 1);
});

test("A1: an unlearned availability limit preserves admission", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(201, MAX_ACTIVE_RUNNERS),
      }],
    },
    "admission-unlearned",
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(evaluation.admitted, MAX_DISPATCH_CONCURRENCY);
  assert.equal(evaluation.admissionLimit, null);
  assert.equal(evaluation.availabilityHeadroom, null);
  assert.equal(evaluation.admissionLimited, false);
});

test("A2: a learned availability limit lowers admission", async () => {
  const name = "admission-learned-lower";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ admissionLimit: 2 }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(202, MAX_ACTIVE_RUNNERS),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.equal(evaluation.admitted, 2);
  assert.equal(evaluation.availabilityHeadroom, 2);
  assert.equal(evaluation.admissionLimited, true);
  assert.equal(result.snapshot.outbox.length, 2);
  assert.equal(status.admissionLimit, 2);
  assert.equal(status.admissionSuccessStreak, 0);
  assert.equal(status.admissionLimited, true);
});

test("A3: a high availability limit cannot widen dispatch admission", async () => {
  const name = "admission-dispatch-guard";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MAX_DISPATCH_CONCURRENCY + 50,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(203, MAX_ACTIVE_RUNNERS),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(
    emittedRecord(result, "scale-up-evaluated").admitted,
    MAX_DISPATCH_CONCURRENCY,
  );
  assert.equal(result.snapshot.outbox.length, MAX_DISPATCH_CONCURRENCY);
});

test("A4: a high availability limit cannot widen the shortfall", async () => {
  const name = "admission-shortfall-guard";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MAX_DISPATCH_CONCURRENCY + 50,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(204, 1),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecord(result, "scale-up-evaluated").admitted, 1);
  assert.equal(result.snapshot.outbox.length, 1);
});

test("A5: exhausted availability records the binding reason", async () => {
  const name = "admission-availability-exhausted";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ admissionLimit: 2 }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      liveReservationCount: 2,
      maxCapacity: 10,
      polls: [{
        outcome: "message",
        advanceMs: 890_000,
        message: statisticsMessage(205, 5),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.equal(evaluation.admitted, 0);
  assert.equal(evaluation.availabilityHeadroom, 0);
  assert.equal(result.snapshot.outbox.length, 0);
  assert.equal(status.scaleUp.lastDecision.reason, "availability-limited");
});

test("A6 / P8: an account ceiling refusal lowers the observed limit", async () => {
  const name = "admission-capacity-refusal-lowers";
  const runnerRequestId = 20_603;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [
        startedReservationRow(20_601, CLOCK_MS),
        startedReservationRow(20_602, CLOCK_MS),
        ...pendingAdmissionRows(runnerRequestId, 1, CLOCK_MS),
      ],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      startReason: "max-instances-exceeded",
      startStatus: 502,
    },
    name,
  );
  const lowered = emittedRecord(result, "admission-limit-lowered");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, 2);
  assert.equal(
    result.snapshot.listener.admissionLimitChangedAtMs,
    CLOCK_MS,
  );
  assert.equal(lowered.admissionLimit, 2);
  assert.equal(lowered.previousLimit, null);
  assert.equal(lowered.contendingCount, 3);
  assert.equal(lowered.startFailureReason, "max-instances-exceeded");
  assert.equal(lowered.runnerRequestId, runnerRequestId);
});

test("A7: a capacity refusal cannot raise a learned limit", async () => {
  const name = "admission-capacity-refusal-holds-low-limit";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionLimitChangedAtMs: CLOCK_MS - 1_000,
      }),
      outbox: [
        startedReservationRow(20_701, CLOCK_MS),
        startedReservationRow(20_702, CLOCK_MS),
        ...pendingAdmissionRows(20_703, 1, CLOCK_MS),
      ],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      startReason: "max-instances-exceeded",
      startStatus: 502,
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(
    result.snapshot.listener.admissionLimit,
    MIN_ADMISSION_LIMIT,
  );
  assert.equal(
    result.snapshot.listener.admissionLimitChangedAtMs,
    CLOCK_MS - 1_000,
  );
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
  assert.equal(emittedRecords(result, "admission-limit-raised").length, 0);
});

test("A8: the admission floor prevents pool stranding", async () => {
  const name = "admission-floor-anti-stranding";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: pendingAdmissionRows(20_801, 1, CLOCK_MS),
    },
    name,
  );
  const refused = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      startReason: "max-instances-exceeded",
      startStatus: 502,
    },
    name,
  );

  assert.equal(refused.error, null);
  assert.equal(
    refused.snapshot.listener.admissionLimit,
    MIN_ADMISSION_LIMIT,
  );

  const probe = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + START_PACE_MS,
      maxCapacity: 10,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(208, 10),
      }],
    },
    name,
  );

  assert.equal(probe.error, null);
  assert.equal(emittedRecord(probe, "scale-up-evaluated").admitted, 1);
  assert.equal(probe.snapshot.calls.postRunners, 1);
});

test("A9: sustained observed spawns stay neutral for recovery", async () => {
  const name = "admission-sustained-recovery";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
        admissionLimited: true,
      }),
      outbox: pendingAdmissionRows(
        20_900,
        ADMISSION_PROBE_SUCCESSES,
        CLOCK_MS,
      ),
    },
    name,
  );
  const first = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [
        { outcome: "no-message", advanceMs: 0 },
        ...pacedNoMessagePolls(ADMISSION_PROBE_SUCCESSES - 1),
      ],
    },
    name,
  );
  assert.equal(first.error, null);
  assert.equal(first.snapshot.calls.postRunners, ADMISSION_PROBE_SUCCESSES);
  assert.equal(
    first.snapshot.listener.admissionLimit,
    MIN_ADMISSION_LIMIT,
  );
  assert.equal(first.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(
    first.snapshot.listener.admissionLimitChangedAtMs,
    CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
  );
  assert.equal(emittedRecords(first, "admission-limit-raised").length, 0);

  const secondClockMs = Math.max(
    first.snapshot.listener.admissionLimitChangedAtMs +
      ADMISSION_PROBE_MIN_INTERVAL_MS,
    first.snapshot.listener.startPace.lastStartIssuedAtMs + START_PACE_MS,
  );
  await listenerRpc(
    worker,
    "seed",
    {
      outbox: pendingAdmissionRows(
        21_000,
        ADMISSION_PROBE_SUCCESSES,
        secondClockMs,
      ),
    },
    name,
  );
  const second = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: secondClockMs,
      polls: [
        { outcome: "no-message", advanceMs: 0 },
        ...pacedNoMessagePolls(ADMISSION_PROBE_SUCCESSES - 1),
      ],
    },
    name,
  );
  assert.equal(second.error, null);
  assert.equal(second.snapshot.calls.postRunners, ADMISSION_PROBE_SUCCESSES);
  assert.equal(
    second.snapshot.listener.admissionLimit,
    MIN_ADMISSION_LIMIT,
  );
  assert.equal(second.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(emittedRecords(second, "admission-limit-raised").length, 0);
});

test("A10: one observed spawn cannot raise the learned limit", async () => {
  const name = "admission-one-success-no-raise";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: 2,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
        admissionLimited: true,
      }),
      outbox: pendingAdmissionRows(21_101, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, 2);
  assert.equal(result.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(emittedRecords(result, "admission-limit-raised").length, 0);
});

test("A11: the probe interval damps a learned-limit raise", async () => {
  const name = "admission-probe-interval";
  const changedAtMs = CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS + 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: 2,
        admissionSuccessStreak: ADMISSION_PROBE_SUCCESSES,
        admissionLimitChangedAtMs: changedAtMs,
        admissionLimited: true,
      }),
      outbox: pendingAdmissionRows(21_201, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, 2);
  assert.equal(
    result.snapshot.listener.admissionSuccessStreak,
    ADMISSION_PROBE_SUCCESSES,
  );
  assert.equal(
    result.snapshot.listener.admissionLimitChangedAtMs,
    changedAtMs,
  );
  assert.equal(emittedRecords(result, "admission-limit-raised").length, 0);
});

test("A11b: the damping interval holds a raise for a full minute", async () => {
  const name = "admission-probe-interval-minute";
  // A15 uses the constant to place the boundary. This scenario states the age
  // as a literal, so the damping is asserted against a fixed minute rather than
  // against whatever the constant happens to hold.
  const changedAtMs = CLOCK_MS - 59_999;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: 2,
        admissionSuccessStreak: ADMISSION_PROBE_SUCCESSES,
        admissionLimitChangedAtMs: changedAtMs,
        admissionLimited: true,
      }),
      outbox: pendingAdmissionRows(21_251, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );

  assert.ok(ADMISSION_PROBE_MIN_INTERVAL_MS >= 60_000);
  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, 2);
  assert.equal(emittedRecords(result, "admission-limit-raised").length, 0);
});

test("A12: a nonbinding learned limit cannot raise", async () => {
  const name = "admission-nonbinding-no-raise";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: 2,
        admissionSuccessStreak: ADMISSION_PROBE_SUCCESSES,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
        admissionLimited: false,
      }),
      outbox: pendingAdmissionRows(21_301, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, 2);
  assert.equal(
    result.snapshot.listener.admissionSuccessStreak,
    ADMISSION_PROBE_SUCCESSES,
  );
  assert.equal(emittedRecords(result, "admission-limit-raised").length, 0);
});

test("A13: a reconciled start does not change admission evidence", async () => {
  const name = "admission-reconciled-start-no-evidence";
  const successStreak = ADMISSION_PROBE_SUCCESSES - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionSuccessStreak: successStreak,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
        admissionLimited: true,
      }),
      outbox: pendingAdmissionRows(21_401, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      reconciledStart: true,
      startErrors: ["network"],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "runner-start-reconciled").length, 1);
  assert.equal(
    result.snapshot.listener.admissionLimit,
    MIN_ADMISSION_LIMIT,
  );
  assert.equal(
    result.snapshot.listener.admissionSuccessStreak,
    successStreak,
  );
  assert.equal(emittedRecords(result, "admission-limit-raised").length, 0);
});

test("A14: every capacity refusal resets the success streak", async () => {
  const name = "admission-refusal-resets-streak";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionSuccessStreak: ADMISSION_PROBE_SUCCESSES - 1,
        admissionLimitChangedAtMs: CLOCK_MS - 1_000,
        admissionLimited: true,
      }),
      outbox: [
        startedReservationRow(21_501, CLOCK_MS),
        startedReservationRow(21_502, CLOCK_MS),
        ...pendingAdmissionRows(21_503, 1, CLOCK_MS),
      ],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      startReason: "max-instances-exceeded",
      startStatus: 502,
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(
    result.snapshot.listener.admissionLimit,
    MIN_ADMISSION_LIMIT,
  );
  assert.equal(result.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
});

test("A15: admission schema migration is additive and idempotent", async () => {
  const name = "admission-schema-migration";
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      legacyAdmissionSchema: true,
    },
    name,
  );
  assert.equal(seeded.legacyAdmissionSchemaSeeded, true);

  await listenerRpc(worker, "reconstruct", {}, name);
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, null);
  assert.equal(result.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(result.snapshot.listener.admissionLimitChangedAtMs, null);
  assert.equal(result.snapshot.listener.admissionLimited, false);
  assert.equal(result.snapshot.listener.startPace.paceMs, START_PACE_MS);
  assert.equal(result.snapshot.listener.startPace.refusalStreak, 0);
  assert.equal(result.snapshot.listener.startPace.lastStartIssuedAtMs, null);

  const secondStatus = await listenerRpc(worker, "reconstruct", {}, name);
  assert.equal(secondStatus.admissionLimit, null);
  assert.equal(secondStatus.admissionSuccessStreak, 0);
  assert.equal(secondStatus.admissionLimited, false);
});

test("P0: the measured pool model favors the three-second pace", () => {
  const paced = simulatePoolRamp({
    starts: 60,
    paceMs: START_PACE_MS,
    releaseAfterMs: POOL_DECAY_MS,
  });
  const oneSecond = simulatePoolRamp({
    starts: 28,
    paceMs: 1_000,
    releaseAfterMs: POOL_DECAY_MS,
  });

  assert.ok(paced.admitted >= 57);
  assert.ok(paced.refused <= 3);
  assert.ok(oneSecond.refused >= 10);
  assert.equal(
    paceOutrunsPoolGrowth(
      START_PACE_MS,
      POOL_GROWTH_SLOTS_PER_SECOND,
    ),
    false,
  );
  assert.equal(
    paceOutrunsPoolGrowth(999, POOL_GROWTH_SLOTS_PER_SECOND),
    true,
  );
});

test("P1: one pass issues one start and pace-defers the second", async () => {
  const name = "pace-one-start-per-pass";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: pendingAdmissionRows(22_001, 2, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [
        { outcome: "no-message", advanceMs: 0 },
        { outcome: "no-message", advanceMs: 0 },
      ],
    },
    name,
  );
  const deferred = emittedRecord(result, "dispatch-deferred");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.equal(result.snapshot.outbox[0].state, "started");
  assert.equal(result.snapshot.outbox[1].state, "pending");
  assert.equal(deferred.reason, "start-pace");
  assert.equal(deferred.paceMs, START_PACE_MS);
  assert.equal(deferred.waitMs, START_PACE_MS);
  assert.equal(deferred.sinceLastStartMs, 0);
  assert.equal(deferred.deferred, 1);
});

test("P2: a pass at the pace boundary issues the next start", async () => {
  const name = "pace-boundary-permitted";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        lastStartIssuedAtMs: CLOCK_MS,
      }),
      outbox: pendingAdmissionRows(22_101, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + START_PACE_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.equal(result.snapshot.outbox[0].state, "started");
  assert.equal(
    result.snapshot.listener.startPace.lastStartIssuedAtMs,
    CLOCK_MS + START_PACE_MS,
  );
});

test("P3: a pass one millisecond before the boundary issues no start", async () => {
  const name = "pace-boundary-deferred";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        lastStartIssuedAtMs: CLOCK_MS,
      }),
      outbox: pendingAdmissionRows(22_201, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + START_PACE_MS - 1,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );
  const deferred = emittedRecord(result, "dispatch-deferred");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.outbox[0].state, "pending");
  assert.equal(deferred.reason, "start-pace");
  assert.equal(deferred.waitMs, 1);
  assert.equal(deferred.sinceLastStartMs, START_PACE_MS - 1);
});

test("P4: the pace cannot widen dispatch concurrency", async () => {
  const name = "pace-narrows-dispatch-concurrency";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: pendingAdmissionRows(
        22_301,
        MAX_DISPATCH_CONCURRENCY + 2,
        CLOCK_MS,
      ),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.ok(
    result.snapshot.calls.postRunners <= MAX_DISPATCH_CONCURRENCY,
  );
});

test("P5: a pool refusal widens only the start pace", async () => {
  const name = "pool-refusal-widens-pace";
  const runnerRequestId = 22_401;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: pendingAdmissionRows(runnerRequestId, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      startReason: "no-container-instance",
      startStatus: 502,
    },
    name,
  );
  const widened = emittedRecord(result, "start-pace-widened");
  const status = await listenerStatusRoute(worker, {}, name);

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, null);
  assert.equal(result.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(result.snapshot.listener.admissionLimitChangedAtMs, null);
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
  assert.equal(widened.paceMs, START_PACE_MS * 2);
  assert.equal(widened.previousPaceMs, START_PACE_MS);
  assert.equal(widened.refusalStreak, 1);
  assert.equal(widened.startFailureReason, "no-container-instance");
  assert.equal(widened.runnerRequestId, runnerRequestId);
  assert.deepEqual(status.startPace, {
    paceMs: START_PACE_MS * 2,
    refusalStreak: 1,
    lastStartIssuedAtMs: CLOCK_MS,
  });
});

test("P6: a refusal storm reaches a bounded pace and still probes", async () => {
  const name = "pool-refusal-pace-bound";
  let clockMs = CLOCK_MS;
  let lastRefusal = null;

  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  for (
    let index = 0;
    index < MAX_PACE_BACKOFF_DOUBLINGS + 2;
    index += 1
  ) {
    await listenerRpc(
      worker,
      "seed",
      { outbox: pendingAdmissionRows(22_500 + index, 1, clockMs) },
      name,
    );
    lastRefusal = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs,
        polls: [{ outcome: "no-message", advanceMs: 0 }],
        startReason: "no-container-instance",
        startStatus: 502,
      },
      name,
    );
    assert.equal(lastRefusal.error, null);
    assert.equal(lastRefusal.snapshot.calls.postRunners, 1);
    clockMs += lastRefusal.snapshot.listener.startPace.paceMs;
  }

  assert.equal(
    lastRefusal.snapshot.listener.startPace.refusalStreak,
    MAX_PACE_BACKOFF_DOUBLINGS,
  );
  assert.equal(
    lastRefusal.snapshot.listener.startPace.paceMs,
    MAX_START_PACE_MS,
  );
  assert.equal(
    emittedRecord(lastRefusal, "start-pace-widened").paceMs,
    MAX_START_PACE_MS,
  );

  await listenerRpc(
    worker,
    "seed",
    { outbox: pendingAdmissionRows(22_599, 1, clockMs) },
    name,
  );
  const probe = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );

  assert.equal(probe.error, null);
  assert.equal(probe.snapshot.calls.postRunners, 1);
  assert.equal(probe.snapshot.outbox.at(-1).state, "started");
});

test("P7: an admitted start restores the base pace", async () => {
  const name = "successful-start-restores-pace";
  const previousRefusalStreak = 2;
  const previousPaceMs = START_PACE_MS * 2 ** previousRefusalStreak;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        lastStartIssuedAtMs: CLOCK_MS,
        paceRefusalStreak: previousRefusalStreak,
      }),
      outbox: pendingAdmissionRows(22_601, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + previousPaceMs,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );
  const restored = emittedRecord(result, "start-pace-restored");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.equal(restored.paceMs, START_PACE_MS);
  assert.equal(restored.previousPaceMs, previousPaceMs);
  assert.equal(restored.previousRefusalStreak, previousRefusalStreak);
  assert.equal(result.snapshot.listener.startPace.paceMs, START_PACE_MS);
  assert.equal(result.snapshot.listener.startPace.refusalStreak, 0);
});

test("P9: a pace wait only narrows the poll timeout", () => {
  const base = pollTimeoutForElapsed(0);

  assert.equal(pollTimeoutForElapsed(0, null), base);
  assert.equal(
    pollTimeoutForElapsed(0, MAX_START_PACE_MS),
    MAX_START_PACE_MS,
  );
  assert.ok(
    pollTimeoutForElapsed(0, MAX_START_PACE_MS) <= base,
  );
  assert.equal(
    pollTimeoutForElapsed(0, 0),
    MIN_PACED_POLL_TIMEOUT_MS,
  );
  assert.equal(
    pollTimeoutForElapsed(889_500, 0),
    pollTimeoutForElapsed(889_500),
  );
  for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => pollTimeoutForElapsed(0, invalid),
      TypeError,
    );
  }
});

test("P10: the alarm narrows polls only for paced work", async () => {
  const activeName = "paced-poll-active-outbox";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        lastStartIssuedAtMs: CLOCK_MS,
      }),
      outbox: pendingAdmissionRows(22_701, 1, CLOCK_MS),
    },
    activeName,
  );
  const active = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    activeName,
  );

  const emptyName = "paced-poll-empty-outbox";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        lastStartIssuedAtMs: CLOCK_MS,
      }),
    },
    emptyName,
  );
  const empty = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    emptyName,
  );

  assert.equal(active.error, null);
  assert.equal(empty.error, null);
  assert.equal(active.snapshot.pollTimeouts[0], START_PACE_MS);
  assert.equal(empty.snapshot.pollTimeouts[0], pollTimeoutForElapsed(0));
});

test("a permitted pace avoids the full long-poll timeout", async () => {
  const name = "permitted-pace-poll-timeout";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        lastStartIssuedAtMs: CLOCK_MS - START_PACE_MS,
      }),
      outbox: pendingAdmissionRows(22_702, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(
    result.snapshot.pollTimeouts[0],
    MIN_PACED_POLL_TIMEOUT_MS,
  );
});

test("P11: the widest pace cannot deadlock admission recovery", async () => {
  const name = "pace-admission-no-deadlock";
  const intervalMs = Math.max(
    MAX_START_PACE_MS,
    ADMISSION_PROBE_MIN_INTERVAL_MS,
  );
  let raised = null;

  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
        admissionLimited: true,
        paceRefusalStreak: MAX_PACE_BACKOFF_DOUBLINGS,
      }),
    },
    name,
  );

  for (let index = 0; index < ADMISSION_PROBE_SUCCESSES; index += 1) {
    const clockMs = CLOCK_MS + index * intervalMs;
    const completed = startedReservationRow(22_800 + index, clockMs, {
      spawnObserved: true,
    });
    const pending = pendingAdmissionRows(22_900 + index, 1, clockMs)[0];
    await listenerRpc(
      worker,
      "seed",
      { outbox: [completed, pending] },
      name,
    );
    const result = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs,
        polls: [{
          outcome: "message",
          advanceMs: 0,
          envelope: rawScaleSetMessage(
            22_800 + index,
            [unassignedLifecycleEntry(
              "JobCompleted",
              completed.runnerName,
              completed.runnerId,
            )],
            { ...STATISTICS, totalAssignedJobs: 0 },
          ),
        }],
      },
      name,
    );

    assert.equal(result.error, null);
    assert.equal(result.snapshot.calls.postRunners, 1);
    assert.equal(
      result.snapshot.outbox.find((row) =>
        row.runnerRequestId === pending.runnerRequestId
      ).state,
      "started",
    );
    raised = emittedRecord(result, "admission-limit-raised") ?? raised;
  }

  const snapshot = await listenerRpc(worker, "inspect", {}, name);
  assert.equal(snapshot.listener.admissionLimit, MIN_ADMISSION_LIMIT + 1);
  assert.equal(raised.previousLimit, MIN_ADMISSION_LIMIT);
  assert.equal(raised.admissionLimit, MIN_ADMISSION_LIMIT + 1);
});

test("N1: an unlearned limit preserves dispatch admission", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_001, MAX_ACTIVE_RUNNERS),
      }],
    },
    "never-spawned-unlearned-admission",
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(evaluation.admitted, MAX_DISPATCH_CONCURRENCY);
  assert.equal(evaluation.admissionLimit, null);
  assert.equal(evaluation.availabilityHeadroom, null);
});

test("N2: a learned limit lowers admission", async () => {
  const name = "never-spawned-learned-admission";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ admissionLimit: 2 }) },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_002, MAX_ACTIVE_RUNNERS),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecord(result, "scale-up-evaluated").admitted, 2);
  assert.equal(result.snapshot.outbox.length, 2);
});

test("N3: a high learned limit cannot widen dispatch admission", async () => {
  const name = "never-spawned-dispatch-guard";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MAX_DISPATCH_CONCURRENCY + 50,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_003, MAX_ACTIVE_RUNNERS),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(
    emittedRecord(result, "scale-up-evaluated").admitted,
    MAX_DISPATCH_CONCURRENCY,
  );
  assert.equal(result.snapshot.outbox.length, MAX_DISPATCH_CONCURRENCY);
});

test("N4: a learned limit cannot widen the shortfall", async () => {
  const name = "never-spawned-shortfall-guard";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MAX_DISPATCH_CONCURRENCY + 50,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_004, 1),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecord(result, "scale-up-evaluated").admitted, 1);
  assert.equal(result.snapshot.outbox.length, 1);
});

test("N5: exhausted learned headroom records availability-limited", async () => {
  const name = "never-spawned-headroom-exhausted";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ admissionLimit: 2 }) },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      liveReservationCount: 2,
      maxCapacity: 10,
      polls: [{
        outcome: "message",
        advanceMs: 890_000,
        message: statisticsMessage(30_005, 5),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecord(result, "scale-up-evaluated").admitted, 0);
  assert.equal(
    (await listenerStatusRoute(worker, {}, name)).scaleUp.lastDecision.reason,
    "availability-limited",
  );
});

test("N24: a reconciled ghost cohort never lowers the limit", async () => {
  const name = "ghost-cohort-does-not-lower";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  // The 19:17Z production shape: 20 contending rows, 15 of them reconciled
  // starts whose runners sit idle past their acquisition deadline, against a
  // learned limit of 18. Every job in that burst succeeded.
  //
  // The ghosts are seeded UNPROBED, which is how production reaches them. That
  // is load-bearing. Seeding them already probed encodes a state the idle
  // teardown makes unreachable, and a fixture in that state reports a collapse
  // the running system cannot produce.
  //
  // Two guards keep this green, and each is mutation-tested:
  //   - the evidence gate: an unprobed row is not scored as a failed spawn
  //   - the idle teardown: the pass that probes a ghost also removes it
  // Together they leave no pass in which a doomed row is both counted and live.
  const ghosts = Array.from(
    { length: 15 },
    (_, index) => startedReservationRow(52_000 + index, oldAtMs, {
      intentRecordedAtMs: CLOCK_MS - START_DEADLINE_MS * 4,
    }),
  );
  const delivered = Array.from(
    { length: 5 },
    (_, index) => startedReservationRow(52_100 + index, oldAtMs, {
      spawnObserved: true,
    }),
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ admissionLimit: 18 }),
      outbox: [...ghosts, ...delivered],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 20,
      // Every probe answers idle: the runner registered and never took a job.
      runnerLookups: Array.from({ length: 60 }, () => ({ busy: false })),
      polls: Array.from({ length: 8 }, (_, index) => ({
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(52_900 + index, 30),
      })),
    },
    name,
  );

  assert.equal(result.error, null);
  // Every ghost is torn down rather than scored.
  assert.equal(
    emittedRecords(result, "runner-unassigned").length,
    ghosts.length,
  );
  // No census on this burst scores a never-spawned row.
  for (const evaluation of emittedRecords(result, "scale-up-evaluated")) {
    assert.equal(evaluation.neverSpawnedCount, 0);
  }
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
  assert.equal(result.snapshot.listener.admissionLimit, 18);
});

test("N20: a busy probe proves delivery on the measured live shape", async () => {
  const name = "census-live-shape-reconciled";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  // Measured on the 18:06Z burst: contending 21, never-spawned 14, previous
  // limit 20, and 30 of 30 jobs green. The fourteen rows are reconciled starts.
  // #reconcileLostStart is the only path that writes state 'started' without
  // spawn_observed, so the census read unproven delivery as a failed spawn.
  const reconciled = Array.from(
    { length: 14 },
    (_, index) => startedReservationRow(37_000 + index, oldAtMs),
  );
  const observed = Array.from(
    { length: 7 },
    (_, index) => startedReservationRow(37_100 + index, oldAtMs, {
      spawnObserved: true,
    }),
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ admissionLimit: 20 }),
      outbox: [...reconciled, ...observed],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 21,
      // The burst ran every job to completion, so every runner probes busy.
      runnerLookups: Array.from({ length: 40 }, () => ({ busy: true })),
      polls: Array.from({ length: 4 }, (_, index) => ({
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(37_900 + index, 30),
      })),
    },
    name,
  );
  const evaluations = emittedRecords(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  // Every reconciled row is proven delivered by a busy probe.
  assert.equal(
    emittedRecords(result, "runner-spawn-proven").length,
    reconciled.length,
  );
  // The measured shape reaches the first census intact.
  assert.equal(evaluations[0].contendingCount, 21);
  // A row the probe has not reached yet is not evidence of a failed spawn, so
  // no census on this burst scores one.
  for (const evaluation of evaluations) {
    assert.equal(evaluation.neverSpawnedCount, 0);
  }
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
  assert.equal(result.snapshot.listener.admissionLimit, 20);
});

test("N22: a probe that threw is not evidence of a failed spawn", async () => {
  const name = "census-requires-a-returned-probe";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  // The pass stamps liveness_probed_at_ms and increments the attempt counter
  // before it calls the registry, and zeroes the counter only when the call
  // returns. This row carries a stamp with an exhausted counter, so it looks
  // probed while no probe ever answered for it.
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ admissionLimit: 20 }),
      outbox: [
        startedReservationRow(37_600, oldAtMs, {
          livenessProbedAtMs: oldAtMs,
          livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS,
        }),
        startedReservationRow(37_601, oldAtMs, { spawnObserved: true }),
      ],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 2,
      runnerLookups: [{ busy: true }],
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(37_960, 30),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(evaluation.neverSpawnedCount, 0);
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
  assert.equal(result.snapshot.listener.admissionLimit, 20);
});

test("N21: a proven spawn is never demoted by a later probe", async () => {
  const name = "spawn-proof-is-one-way";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ admissionLimit: 20 }),
      outbox: [startedReservationRow(37_500, oldAtMs)],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 1,
      // Busy first, then idle. The idle probe must not take the proof back.
      runnerLookups: [{ busy: true }, { busy: false }, { busy: false }],
      polls: Array.from({ length: 3 }, (_, index) => ({
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(37_950 + index, 30),
      })),
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(
    emittedRecords(result, "runner-spawn-proven").length,
    1,
  );
  assert.equal(result.snapshot.outbox[0].spawnObserved, true);
});

test("N18: a burst tail does not collapse the limit", async () => {
  const name = "census-tail-keeps-limit";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  // The production shape after the spawn_observed backfill: a census of five
  // contending rows of which four never spawned, against a limit of nine.
  // The burst's completed rows released their reservations when their jobs
  // finished, which is what left only the failing residue behind.
  const stragglers = Array.from(
    { length: 4 },
    (_, index) => startedReservationRow(35_000 + index, oldAtMs),
  );
  const stillRunning = startedReservationRow(35_100, oldAtMs, {
    spawnObserved: true,
  });
  const delivered = Array.from(
    { length: 27 },
    (_, index) => startedReservationRow(35_200 + index, oldAtMs, {
      spawnObserved: true,
      reservationReleasedAtMs: oldAtMs,
    }),
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ admissionLimit: 9 }),
      outbox: [...stragglers, stillRunning, ...delivered],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 5,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(35_900, 30),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  // A delivered start is evidence of capacity and belongs in the denominator.
  assert.equal(evaluation.contendingCount, 32);
  assert.equal(evaluation.neverSpawnedCount, 4);
  assert.equal(result.snapshot.listener.admissionLimit, 9);
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
});

test("N19: repeated tail censuses do not ratchet the limit down", async () => {
  const name = "census-tail-no-ratchet";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  const rows = [
    ...Array.from(
      { length: 4 },
      (_, index) => startedReservationRow(36_000 + index, oldAtMs),
    ),
    ...Array.from(
      { length: 27 },
      (_, index) => startedReservationRow(36_200 + index, oldAtMs, {
        spawnObserved: true,
        reservationReleasedAtMs: oldAtMs,
      }),
    ),
  ];
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ admissionLimit: 17 }),
      outbox: rows,
    },
    name,
  );
  // Nine lowering events walked production from seventeen to one. Nine censuses
  // over the same residue must leave the limit where the evidence puts it.
  let limit = null;
  for (let round = 0; round < 9; round += 1) {
    const result = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs: CLOCK_MS + round,
        liveReservationCount: 4,
        polls: [{
          outcome: "message",
          advanceMs: 0,
          message: statisticsMessage(36_900 + round, 30),
        }],
      },
      name,
    );
    assert.equal(result.error, null);
    limit = result.snapshot.listener.admissionLimit;
  }

  assert.equal(limit, 17);
});

test("N6: a past-deadline never-spawned row lowers the limit", async () => {
  const name = "never-spawned-census-lowers";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [
        startedReservationRow(30_601, oldAtMs, { spawnObserved: true }),
        startedReservationRow(30_602, oldAtMs, { spawnObserved: true }),
        startedReservationRow(30_603, oldAtMs),
      ],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 3,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_006, 5),
      }],
    },
    name,
  );
  const lowered = emittedRecord(result, "admission-limit-lowered");
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, 2);
  assert.equal(lowered.admissionLimit, 2);
  assert.equal(lowered.previousLimit, null);
  assert.equal(lowered.contendingCount, 3);
  assert.equal(lowered.neverSpawnedCount, 1);
  assert.equal(lowered.deliveredStarts, 2);
  assert.equal(lowered.reason, "reserved-never-spawned");
  assert.equal(evaluation.contendingCount, 3);
  assert.equal(evaluation.neverSpawnedCount, 1);
});

test("N7: an inside-deadline never-spawned row does not lower", async () => {
  const name = "never-spawned-deadline-guard";
  const pendingAtMs = CLOCK_MS - START_DEADLINE_MS + 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [
        startedReservationRow(30_701, pendingAtMs, {
          spawnObserved: true,
        }),
        startedReservationRow(30_702, pendingAtMs, {
          spawnObserved: true,
        }),
        startedReservationRow(30_703, pendingAtMs),
      ],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 3,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_007, 4),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, null);
  assert.equal(evaluation.contendingCount, 3);
  assert.equal(evaluation.neverSpawnedCount, 0);
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
});

test("N8: a spawn-observed row is not counted as never-spawned", async () => {
  const name = "never-spawned-observed-excluded";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [
        startedReservationRow(30_801, oldAtMs, { spawnObserved: true }),
      ],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 1,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_008, 2),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, null);
  assert.equal(evaluation.contendingCount, 1);
  assert.equal(evaluation.neverSpawnedCount, 0);
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
});

test("N9: a reconciled start a probe cannot own stays in the census", async () => {
  const name = "never-spawned-reconciled-census";
  const runnerRequestId = 30_901;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: pendingAdmissionRows(runnerRequestId, 1, CLOCK_MS),
    },
    name,
  );
  const reconciled = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      reconciledStart: true,
      startErrors: ["network"],
    },
    name,
  );

  assert.equal(reconciled.error, null);
  assert.equal(reconciled.snapshot.outbox[0].state, "started");
  assert.equal(reconciled.snapshot.outbox[0].spawnObserved, false);

  const measured = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + START_DEADLINE_MS + 1,
      liveReservationCount: 1,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_009, 2),
      }],
      // An answered probe resolves absent by release, busy by proof, and idle
      // by teardown. Only a foreign registration leaves this row unproven.
      runnerLookups: [{ busy: false, name: "foreign-runner" }],
    },
    name,
  );
  const evaluation = emittedRecord(measured, "scale-up-evaluated");

  assert.equal(measured.error, null);
  assert.equal(measured.snapshot.listener.admissionLimit, 1);
  assert.equal(evaluation.contendingCount, 1);
  assert.equal(evaluation.neverSpawnedCount, 1);
});

test("N21: a reconciled idle start releases its reservation", async () => {
  const name = "reconciled-idle-start-released";
  const runnerRequestId = 30_921;
  const intentRecordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  const row = startedReservationRow(runnerRequestId, intentRecordedAtMs, {
    intentRecordedAtMs,
    spawnObserved: false,
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ busy: false }],
    }),
    name,
  );
  const unassigned = emittedRecord(result, "runner-unassigned");

  assert.equal(result.error, null);
  assert.equal(unassigned.runnerRequestId, runnerRequestId);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(result.snapshot.outbox[0].lastError, "runner-unassigned");
  assert.equal(result.snapshot.outbox[0].spawnObserved, false);
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId: row.reservationId,
    reason: "runner-unassigned",
  }]);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
});

test("N22: releasing a reconciled idle start restores shortfall", async () => {
  const name = "reconciled-idle-start-restores-shortfall";
  const runnerRequestId = 30_922;
  const intentRecordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  const row = startedReservationRow(runnerRequestId, intentRecordedAtMs, {
    intentRecordedAtMs,
    spawnObserved: false,
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const saturated = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 1,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_922, 1),
      }],
      runnerLookups: [{ busy: false, name: "foreign-runner" }],
    },
    name,
  );
  assert.equal(saturated.snapshot.outbox[0].spawnObserved, false);
  assert.equal(
    emittedRecord(saturated, "scale-up-saturated").shortfall,
    0,
  );

  const released = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1,
      liveReservationCount: 1,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      runnerLookups: [{ busy: false }],
    },
    name,
  );
  const reservationReleasedAtMs = released.snapshot.outbox[0]
    .reservationReleasedAtMs;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 2,
      liveReservationCount: Number.isSafeInteger(reservationReleasedAtMs)
        ? 0
        : 1,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_923, 1),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(released.error, null);
  assert.equal(Number.isSafeInteger(reservationReleasedAtMs), true);
  assert.equal(emittedRecords(released, "runner-unassigned").length, 1);
  assert.equal(result.error, null);
  assert.equal(evaluation.liveReservationCount, 0);
  assert.equal(evaluation.shortfall, 1);
  assert.equal(evaluation.admitted, 1);
  assert.equal(emittedRecords(result, "scale-up-saturated").length, 0);
  assert.equal(emittedRecords(result, "scale-up-start-admitted").length, 1);
  assert.equal(result.snapshot.calls.postRunners, 1);
});

test("N23: a busy reconciled start is proven and keeps its reservation", async () => {
  const name = "reconciled-busy-start-preserved";
  const runnerRequestId = 30_923;
  const intentRecordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  const row = startedReservationRow(runnerRequestId, intentRecordedAtMs, {
    intentRecordedAtMs,
    spawnObserved: false,
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ busy: true }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].state, "started");
  assert.equal(result.snapshot.outbox[0].spawnObserved, true);
  assert.equal(emittedRecords(result, "runner-spawn-proven").length, 1);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(emittedRecords(result, "runner-unassigned").length, 0);
});

test("N10: a high delivered count cannot raise a low limit", async () => {
  const name = "never-spawned-lowering-only";
  const changedAtMs = CLOCK_MS - 1_000;
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionSuccessStreak: ADMISSION_PROBE_SUCCESSES - 1,
        admissionLimitChangedAtMs: changedAtMs,
      }),
      outbox: [
        startedReservationRow(31_001, oldAtMs, { spawnObserved: true }),
        startedReservationRow(31_002, oldAtMs, { spawnObserved: true }),
        startedReservationRow(31_003, oldAtMs),
      ],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 3,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_010, 4),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, MIN_ADMISSION_LIMIT);
  assert.equal(result.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(
    result.snapshot.listener.admissionLimitChangedAtMs,
    changedAtMs,
  );
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
});

test("N11: the floor leaves one dispatch probe on the next pass", async () => {
  const name = "never-spawned-floor-probe";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [startedReservationRow(31_101, oldAtMs)],
    },
    name,
  );
  const measured = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 1,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_011, 1),
      }],
    },
    name,
  );

  assert.equal(measured.error, null);
  assert.equal(
    measured.snapshot.listener.admissionLimit,
    MIN_ADMISSION_LIMIT,
  );

  const probe = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1,
      liveReservationCount: 0,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_012, 10),
      }],
    },
    name,
  );

  assert.equal(probe.error, null);
  assert.equal(emittedRecord(probe, "scale-up-evaluated").admitted, 1);
  assert.equal(probe.snapshot.calls.postRunners, 1);
});

test("L1: a cleared floor-limit flag can recover after evaluation", async () => {
  const name = "admission-cleared-flag-recovers";
  const row = startedReservationRow(32_200, CLOCK_MS, {
    spawnObserved: true,
  });
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionSuccessStreak: ADMISSION_PROBE_SUCCESSES - 1,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
        admissionLimited: false,
      }),
      outbox: [row],
    },
    name,
  );

  const evaluated = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: MIN_ADMISSION_LIMIT,
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_113, MIN_ADMISSION_LIMIT + 1),
      }],
    },
    name,
  );
  const delivered = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        envelope: rawScaleSetMessage(
          30_114,
          [unassignedLifecycleEntry(
            "JobCompleted",
            row.runnerName,
            row.runnerId,
          )],
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );
  const raised = emittedRecord(delivered, "admission-limit-raised");

  assert.equal(evaluated.error, null);
  assert.equal(delivered.error, null);
  assert.equal(evaluated.snapshot.listener.admissionLimited, true);
  assert.equal(delivered.snapshot.listener.admissionLimit, 2);
  assert.equal(raised.previousLimit, MIN_ADMISSION_LIMIT);
  assert.equal(raised.admissionLimit, 2);
});

test("L2: a floor-limit evaluation with live work sets the flag", async () => {
  const name = "admission-floor-live-work-sets-flag";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionLimited: false,
      }),
      outbox: pendingAdmissionRows(32_300, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        envelope: rawScaleSetMessage(
          30_115,
          [],
          { ...STATISTICS, totalAssignedJobs: 30 },
        ),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(evaluation.admitted, 0);
  assert.equal(evaluation.admissionLimited, true);
  assert.equal(result.snapshot.listener.admissionLimited, true);
});

test("L3: a floor-limited pool recovers through public alarms", async () => {
  const name = "admission-floor-reachable-recovery";
  const rows = Array.from(
    { length: ADMISSION_PROBE_SUCCESSES },
    (_, index) => startedReservationRow(31_150 + index, CLOCK_MS, {
      spawnObserved: true,
    }),
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
      }),
      outbox: rows,
    },
    name,
  );

  const evaluated = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: MIN_ADMISSION_LIMIT,
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(30_012, MIN_ADMISSION_LIMIT + 1),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(evaluated, "scale-up-evaluated");

  const delivered = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        envelope: rawScaleSetMessage(
          30_013,
          rows.map((row) =>
            unassignedLifecycleEntry(
              "JobCompleted",
              row.runnerName,
              row.runnerId,
            )
          ),
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );

  assert.equal(evaluated.error, null);
  assert.equal(delivered.error, null);
  assert.deepEqual(
    {
      admissionLimited: evaluation.admissionLimited,
      admissionLimit: delivered.snapshot.listener.admissionLimit,
    },
    {
      admissionLimited: true,
      admissionLimit: MIN_ADMISSION_LIMIT + 1,
    },
  );
});

test("N12: a seeded binding flag verifies one-step raise arithmetic", async () => {
  const name = "never-spawned-verified-recovery";
  const firstRows = Array.from(
    { length: ADMISSION_PROBE_SUCCESSES },
    (_, index) => startedReservationRow(31_200 + index, CLOCK_MS, {
      spawnObserved: true,
    }),
  );
  await listenerRpc(
    worker,
    "seed",
    {
      // N12 seeds the flag to isolate arithmetic. L3 proves reachability.
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
        admissionLimited: true,
      }),
      outbox: firstRows,
    },
    name,
  );
  const first = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        envelope: rawScaleSetMessage(
          30_013,
          firstRows.map((row) =>
            unassignedLifecycleEntry(
              "JobCompleted",
              row.runnerName,
              row.runnerId,
            )
          ),
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );
  const firstRaise = emittedRecord(first, "admission-limit-raised");

  assert.equal(first.error, null);
  assert.equal(first.snapshot.listener.admissionLimit, 2);
  assert.equal(first.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(firstRaise.previousLimit, MIN_ADMISSION_LIMIT);
  assert.equal(firstRaise.admissionLimit, 2);
  assert.equal(firstRaise.successStreak, ADMISSION_PROBE_SUCCESSES);
  assert.equal(firstRaise.reason, "verified-delivery");

  const secondClockMs = CLOCK_MS + ADMISSION_PROBE_MIN_INTERVAL_MS;
  const secondRows = Array.from(
    { length: ADMISSION_PROBE_SUCCESSES },
    (_, index) => startedReservationRow(31_300 + index, secondClockMs, {
      spawnObserved: true,
    }),
  );
  await listenerRpc(worker, "seed", { outbox: secondRows }, name);
  const second = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: secondClockMs,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        envelope: rawScaleSetMessage(
          30_014,
          secondRows.map((row) =>
            unassignedLifecycleEntry(
              "JobCompleted",
              row.runnerName,
              row.runnerId,
            )
          ),
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );
  const secondRaise = emittedRecord(second, "admission-limit-raised");

  assert.equal(second.error, null);
  assert.equal(second.snapshot.listener.admissionLimit, 3);
  assert.equal(second.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(secondRaise.previousLimit, 2);
  assert.equal(secondRaise.admissionLimit, 3);
  assert.equal(secondRaise.reason, "verified-delivery");
});

test("N13: runner-spawned does not raise the learned limit", async () => {
  const name = "never-spawned-start-neutral";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionSuccessStreak: ADMISSION_PROBE_SUCCESSES - 1,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
        admissionLimited: true,
      }),
      outbox: pendingAdmissionRows(31_401, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [
        { outcome: "no-message", advanceMs: 0 },
        { outcome: "poll-aborted", advanceMs: 890_000 },
      ],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "runner-spawned").length, 1);
  assert.equal(result.snapshot.outbox[0].spawnObserved, true);
  assert.equal(
    result.snapshot.listener.admissionLimit,
    MIN_ADMISSION_LIMIT,
  );
  assert.equal(
    result.snapshot.listener.admissionSuccessStreak,
    ADMISSION_PROBE_SUCCESSES - 1,
  );
  assert.equal(emittedRecords(result, "admission-limit-raised").length, 0);
});

test("N14: one verified completion does not raise the limit", async () => {
  const name = "never-spawned-single-completion";
  const row = startedReservationRow(31_501, CLOCK_MS, {
    spawnObserved: true,
  });
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionLimitChangedAtMs:
          CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS,
        admissionLimited: true,
      }),
      outbox: [row],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        envelope: rawScaleSetMessage(
          30_015,
          [unassignedLifecycleEntry(
            "JobCompleted",
            row.runnerName,
            row.runnerId,
          )],
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, MIN_ADMISSION_LIMIT);
  assert.equal(result.snapshot.listener.admissionSuccessStreak, 1);
  assert.equal(emittedRecords(result, "admission-limit-raised").length, 0);
});

test("N15: the probe interval blocks a verified raise", async () => {
  const name = "never-spawned-probe-interval";
  const changedAtMs = CLOCK_MS - ADMISSION_PROBE_MIN_INTERVAL_MS + 1;
  const row = startedReservationRow(31_601, CLOCK_MS, {
    spawnObserved: true,
  });
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: MIN_ADMISSION_LIMIT,
        admissionSuccessStreak: ADMISSION_PROBE_SUCCESSES - 1,
        admissionLimitChangedAtMs: changedAtMs,
        admissionLimited: true,
      }),
      outbox: [row],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        envelope: rawScaleSetMessage(
          30_016,
          [unassignedLifecycleEntry(
            "JobCompleted",
            row.runnerName,
            row.runnerId,
          )],
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, MIN_ADMISSION_LIMIT);
  assert.equal(
    result.snapshot.listener.admissionSuccessStreak,
    ADMISSION_PROBE_SUCCESSES,
  );
  assert.equal(
    result.snapshot.listener.admissionLimitChangedAtMs,
    changedAtMs,
  );
  assert.equal(emittedRecords(result, "admission-limit-raised").length, 0);
});

test("N16: the legacy admission schema migrates during an alarm", async () => {
  const name = "never-spawned-schema-migration";
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [startedReservationRow(31_701, CLOCK_MS, {
        state: "failed",
        reservationId: null,
        spawnObserved: true,
      })],
      legacyAdmissionSchema: true,
    },
    name,
  );
  assert.equal(seeded.legacyAdmissionSchemaSeeded, true);

  await listenerRpc(worker, "reconstruct", {}, name);
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, null);
  assert.equal(result.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(result.snapshot.listener.admissionLimitChangedAtMs, null);
  assert.equal(result.snapshot.listener.admissionLimited, false);
  assert.equal(result.snapshot.outbox[0].spawnObserved, true);
});

test("RS1: reset restores the unlearned admission state", async () => {
  const name = "admission-reset-state";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: 4,
        admissionSuccessStreak: 5,
        admissionLimitChangedAtMs: CLOCK_MS - 1_000,
        admissionLimited: true,
      }),
    },
    name,
  );
  const reset = await listenerRpc(
    worker,
    "control",
    { method: "resetAdmission" },
    name,
  );
  const event = emittedRecord(reset, "admission-limit-reset");

  assert.deepEqual(reset.result, {
    reset: true,
    previousLimit: 4,
    admissionLimit: null,
  });
  assert.equal(reset.snapshot.listener.admissionLimit, null);
  assert.equal(reset.snapshot.listener.admissionSuccessStreak, 0);
  assert.equal(reset.snapshot.listener.admissionLimitChangedAtMs, null);
  assert.equal(reset.snapshot.listener.admissionLimited, false);
  assert.equal(event.previousLimit, 4);
  assert.equal(event.previousSuccessStreak, 5);
  assert.equal(event.admissionLimit, null);
});

test("RS2: reset cannot accept an arbitrary admission target", async () => {
  const name = "admission-reset-no-target";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ admissionLimit: 3 }),
    },
    name,
  );
  const reset = await listenerRpc(
    worker,
    "control",
    {
      method: "resetAdmission",
      input: { admissionLimit: MAX_ACTIVE_RUNNERS },
    },
    name,
  );

  assert.equal(reset.result.admissionLimit, null);
  assert.equal(reset.snapshot.listener.admissionLimit, null);
  assert.notEqual(typeof reset.snapshot.listener.admissionLimit, "number");

  const routeScaleSet = `reset-route-${RUN_PREFIX}`;
  const headers = { Authorization: `Bearer ${CONTROL_TOKEN}` };
  const routed = await worker.fetch(
    `/autopilot/listener/${routeScaleSet}/reset-admission`,
    { method: "POST", headers },
  );
  assert.equal(routed.status, 200);
  assert.deepEqual(await routed.json(), {
    reset: true,
    previousLimit: null,
    admissionLimit: null,
  });

  const targeted = await worker.fetch(
    `/autopilot/listener/${routeScaleSet}/reset-admission`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ admissionLimit: MAX_ACTIVE_RUNNERS }),
    },
  );
  assert.equal(targeted.status, 400);
  assert.deepEqual(await targeted.json(), {
    error: "Unknown field: admissionLimit",
  });
});

test("RS3: reset route authenticates before calling the listener", async () => {
  const response = await worker.fetch("/harness/listener-reset-auth", {
    method: "POST",
  });
  assert.equal(response.status, 200);
  const result = await response.json();

  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: "Unauthorized" });
  assert.equal(result.resetAdmissionCalls, 0);
});

test("RS4: lowering observers relearn after a reset", async () => {
  const refusalName = "admission-reset-refusal-relearn";
  const refusedRunnerRequestId = 32_401;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: 7,
        admissionSuccessStreak: 4,
        admissionLimitChangedAtMs: CLOCK_MS - 1_000,
        admissionLimited: true,
      }),
      outbox: [
        startedReservationRow(32_402, CLOCK_MS),
        startedReservationRow(32_403, CLOCK_MS),
        ...pendingAdmissionRows(refusedRunnerRequestId, 1, CLOCK_MS),
      ],
    },
    refusalName,
  );
  await listenerRpc(
    worker,
    "control",
    { method: "resetAdmission" },
    refusalName,
  );
  const refused = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      startReason: "max-instances-exceeded",
      startStatus: 502,
    },
    refusalName,
  );
  const refusalLowered = emittedRecord(
    refused,
    "admission-limit-lowered",
  );

  assert.equal(refused.error, null);
  assert.equal(refused.snapshot.listener.admissionLimit, 2);
  assert.equal(refusalLowered.previousLimit, null);
  assert.equal(refusalLowered.admissionLimit, 2);

  const censusName = "admission-reset-census-relearn";
  const oldAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        admissionLimit: 7,
        admissionSuccessStreak: 4,
        admissionLimitChangedAtMs: CLOCK_MS - 1_000,
        admissionLimited: true,
      }),
      outbox: [
        startedReservationRow(32_404, oldAtMs, {
          spawnObserved: true,
        }),
        startedReservationRow(32_405, oldAtMs, {
          spawnObserved: true,
        }),
        startedReservationRow(32_406, oldAtMs),
      ],
    },
    censusName,
  );
  await listenerRpc(
    worker,
    "control",
    { method: "resetAdmission" },
    censusName,
  );
  const measured = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 3,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(32_407, 5),
      }],
    },
    censusName,
  );
  const censusLowered = emittedRecord(
    measured,
    "admission-limit-lowered",
  );

  assert.equal(measured.error, null);
  assert.equal(measured.snapshot.listener.admissionLimit, 2);
  assert.equal(censusLowered.previousLimit, null);
  assert.equal(censusLowered.admissionLimit, 2);
  assert.equal(censusLowered.reason, "reserved-never-spawned");
});

test("C1: historical backlog does not collapse admission", async () => {
  const name = "census-historical-backlog";
  const historicalAtMs = CLOCK_MS - ACTIVE_RUNNER_CLEANUP_DELAY_MS * 2;
  const recentAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  const historicalRows = Array.from({ length: 200 }, (_, index) =>
    startedReservationRow(40_000 + index, historicalAtMs + index)
  );
  const recentRows = Array.from({ length: 3 }, (_, index) =>
    startedReservationRow(40_200 + index, recentAtMs + index, {
      spawnObserved: true,
    })
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [...historicalRows, ...recentRows],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: recentRows.length,
      maxCapacity: MAX_ACTIVE_RUNNERS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(40_001, MAX_ACTIVE_RUNNERS),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.notEqual(
    result.snapshot.listener.admissionLimit,
    MIN_ADMISSION_LIMIT,
  );
  assert.equal(evaluation.contendingCount, recentRows.length);
  assert.equal(evaluation.neverSpawnedCount, 0);
  assert.equal(evaluation.admitted > 1, true);
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
});

test("C2: migration backfills every historical spawn observation", async () => {
  const name = "census-migration-backfill";
  const historicalRows = [
    startedReservationRow(40_301, CLOCK_MS, {
      state: "failed",
      reservationId: null,
    }),
    startedReservationRow(40_302, CLOCK_MS + 1, {
      state: "failed",
      reservationId: null,
      spawnObserved: true,
    }),
    startedReservationRow(40_303, CLOCK_MS + 2, {
      state: "cancelled",
      reservationId: null,
    }),
  ];
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: historicalRows,
      legacyAdmissionSchema: true,
    },
    name,
  );
  assert.equal(seeded.legacyAdmissionSchemaSeeded, true);

  await listenerRpc(worker, "reconstruct", {}, name);
  const snapshot = await listenerRpc(worker, "inspect", {}, name);

  assert.deepEqual(
    snapshot.outbox.map((row) => row.spawnObserved),
    historicalRows.map(() => true),
  );
});

test("C3: an expired row is excluded from the contending census", async () => {
  const name = "census-expired-contending-excluded";
  const expiredAtMs = CLOCK_MS - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1;
  const recentAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [
        startedReservationRow(40_401, expiredAtMs, {
          reservationId: null,
          spawnObserved: true,
        }),
        startedReservationRow(40_402, recentAtMs, {
          reservationId: null,
          spawnObserved: true,
        }),
      ],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 1,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(40_003, 2),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(evaluation.contendingCount, 1);
});

test("C4: an expired row is excluded from the never-spawned census", async () => {
  const name = "census-expired-never-spawned-excluded";
  const expiredAtMs = CLOCK_MS - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1;
  const recentAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [
        startedReservationRow(40_501, expiredAtMs, {
          reservationId: null,
        }),
        startedReservationRow(40_502, recentAtMs, {
          reservationId: null,
          spawnObserved: true,
        }),
      ],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 1,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(40_004, 2),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(evaluation.neverSpawnedCount, 0);
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
});

test("C5: a recent past-deadline failure lowers admission", async () => {
  const name = "census-recent-failure-lowers";
  const pastDeadlineAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [
        startedReservationRow(40_601, pastDeadlineAtMs, {
          spawnObserved: true,
        }),
        startedReservationRow(40_602, pastDeadlineAtMs, {
          spawnObserved: true,
        }),
        startedReservationRow(40_603, pastDeadlineAtMs),
      ],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 3,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(40_005, 5),
      }],
    },
    name,
  );
  const lowered = emittedRecord(result, "admission-limit-lowered");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, 2);
  assert.equal(lowered.contendingCount, 3);
  assert.equal(lowered.neverSpawnedCount, 1);
  assert.equal(lowered.deliveredStarts, 2);
});

test("C6: a recent inside-deadline row does not lower admission", async () => {
  const name = "census-recent-pending-guard";
  const insideDeadlineAtMs = CLOCK_MS - START_DEADLINE_MS + 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [
        startedReservationRow(40_701, insideDeadlineAtMs, {
          spawnObserved: true,
        }),
        startedReservationRow(40_702, insideDeadlineAtMs, {
          spawnObserved: true,
        }),
        startedReservationRow(40_703, insideDeadlineAtMs),
      ],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      liveReservationCount: 3,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        message: statisticsMessage(40_006, 4),
      }],
    },
    name,
  );
  const evaluation = emittedRecord(result, "scale-up-evaluated");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.admissionLimit, null);
  assert.equal(evaluation.neverSpawnedCount, 0);
  assert.equal(emittedRecords(result, "admission-limit-lowered").length, 0);
});

test("C7: an expired reservation is settled", async () => {
  const name = "reservation-expired-settled";
  const settlementNowMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const expiredAtMs = settlementNowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1;
  const row = startedReservationRow(40_801, expiredAtMs, {
    state: "failed",
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification(),
    name,
  );
  const settled = emittedRecord(result, "reservation-expired-settled");

  assert.equal(result.error, null);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId: row.reservationId,
    reason: "reservation-expired",
  }]);
  assert.equal(settled.runnerRequestId, row.runnerRequestId);
  assert.equal(settled.reservationId, row.reservationId);
  assert.equal(settled.ageMs, settlementNowMs - expiredAtMs);
});

test("C8: settlement leaves a recent reservation untouched", async () => {
  const name = "reservation-recent-not-settled";
  const settlementNowMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const recentAtMs = settlementNowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS + 1;
  const row = startedReservationRow(40_901, recentAtMs, {
    state: "failed",
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification(),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(
    emittedRecords(result, "reservation-expired-settled").length,
    0,
  );
});

test("C9: expired settlement is bounded and self-draining", async () => {
  const name = "reservation-expired-self-draining";
  const settlementNowMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const rowCount = MAX_LIVENESS_PROBES_PER_PASS * 2;
  const expiredAtMs = settlementNowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS -
    rowCount;
  const rows = Array.from({ length: rowCount }, (_, index) =>
    startedReservationRow(41_000 + index, expiredAtMs + index, {
      state: "failed",
    })
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const first = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification(),
    name,
  );

  assert.equal(first.error, null);
  assert.equal(
    first.snapshot.calls.compensate,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.equal(
    emittedRecords(first, "reservation-expired-settled").length,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.deepEqual(
    first.snapshot.outbox.map((candidate) =>
      candidate.reservationReleasedAtMs !== null
    ),
    rows.map((_, index) => index < MAX_LIVENESS_PROBES_PER_PASS),
  );

  const second = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      clockMs: CLOCK_MS + ALARM_WALL_BUDGET_MS,
    }),
    name,
  );

  assert.equal(second.error, null);
  assert.equal(
    second.snapshot.calls.compensate,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.equal(
    emittedRecords(second, "reservation-expired-settled").length,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.equal(
    second.snapshot.outbox.every((candidate) =>
      candidate.reservationReleasedAtMs !== null
    ),
    true,
  );
});

test("C10: a settlement error does not stop the pass", async () => {
  const name = "reservation-expired-error-continues";
  const settlementNowMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const expiredAtMs = settlementNowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 2;
  const failing = startedReservationRow(41_101, expiredAtMs, {
    state: "failed",
  });
  const healthy = startedReservationRow(41_102, expiredAtMs + 1, {
    state: "failed",
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [failing, healthy] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      compensateError: ["network", null],
    }),
    name,
  );
  const failed = emittedRecord(
    result,
    "reservation-expired-settle-failed",
  );
  const settled = emittedRecord(result, "reservation-expired-settled");

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.compensate, 2);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[1].reservationReleasedAtMs),
    true,
  );
  assert.equal(failed.runnerRequestId, failing.runnerRequestId);
  assert.match(failed.error, /stub network response was lost/u);
  assert.equal(settled.runnerRequestId, healthy.runnerRequestId);
});

test("settle rotation reaches a reservation behind a throwing head block", async () => {
  const name = "settle-rotation-throwing-head-block";
  const settlementNowMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const expiredAtMs = settlementNowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS -
    MAX_LIVENESS_PROBES_PER_PASS - 1;
  const failingRows = Array.from(
    { length: MAX_LIVENESS_PROBES_PER_PASS },
    (_, index) =>
      startedReservationRow(41_201 + index, expiredAtMs + index, {
        state: "failed",
      }),
  );
  const healthy = startedReservationRow(
    41_201 + MAX_LIVENESS_PROBES_PER_PASS,
    expiredAtMs + MAX_LIVENESS_PROBES_PER_PASS,
    { state: "failed" },
  );
  const compensateErrorsByReservation = Object.fromEntries(
    failingRows.map((row) => [row.reservationId, "network"]),
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [...failingRows, healthy],
    },
    name,
  );

  const first = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ compensateErrorsByReservation }),
    name,
  );
  const firstHealthy = first.snapshot.outbox.find((row) =>
    row.runnerRequestId === healthy.runnerRequestId
  );
  assert.equal(first.error, null);
  assert.equal(
    first.snapshot.calls.compensate,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.equal(firstHealthy.reservationReleasedAtMs, null);
  assert.equal(firstHealthy.settleCheckedAtMs, null);

  const second = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      clockMs: CLOCK_MS + ALARM_WALL_BUDGET_MS,
      compensateErrorsByReservation,
    }),
    name,
  );
  const secondHealthy = second.snapshot.outbox.find((row) =>
    row.runnerRequestId === healthy.runnerRequestId
  );

  assert.equal(second.error, null);
  assert.equal(
    Number.isSafeInteger(secondHealthy.reservationReleasedAtMs),
    true,
  );
  assert.deepEqual(
    emittedRecords(second, "reservation-expired-settled").map((record) =>
      record.runnerRequestId
    ),
    [healthy.runnerRequestId],
  );
});

test("settle rotation stamps a throwing compensation without moving updated time", async () => {
  const name = "settle-rotation-throw-stamp";
  const settlementNowMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const updatedAtMs = settlementNowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1;
  const row = startedReservationRow(41_301, updatedAtMs, {
    state: "failed",
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      compensateErrorsByReservation: {
        [row.reservationId]: "network",
      },
    }),
    name,
  );
  const failed = emittedRecord(
    result,
    "reservation-expired-settle-failed",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].settleCheckedAtMs, settlementNowMs);
  assert.equal(result.snapshot.outbox[0].updatedAtMs, updatedAtMs);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(failed.settleCheckedAtMs, settlementNowMs);
});

test("settle rotation stamps before an elapsed work deadline", async () => {
  const name = "settle-rotation-deadline-stamp";
  const workStartMs = CLOCK_MS + ALARM_WALL_BUDGET_MS -
    ALARM_WORK_BUDGET_MS;
  const workDeadlineMs = CLOCK_MS + ALARM_WALL_BUDGET_MS;
  const updatedAtMs = workStartMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1;
  const row = startedReservationRow(41_401, updatedAtMs, {
    state: "failed",
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      clockValues: [
        CLOCK_MS,
        CLOCK_MS,
        CLOCK_MS,
        CLOCK_MS,
        null,
        null,
        null,
        null,
        null,
        workDeadlineMs,
      ],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].settleCheckedAtMs, workDeadlineMs);
  assert.equal(result.snapshot.outbox[0].updatedAtMs, updatedAtMs);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
});

test("the entry rearm failure returns with a bounded alarm", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    { throwAfterEntry: true },
    "entry-rearm",
  );
  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "alarm-failed");
  assert.equal(result.result.lastResort, true);
  assert.match(result.result.failure, /stub throw after entry rearm/u);
  assert.equal(result.snapshot.listener.alarmGeneration, 1);
  assert.equal(result.snapshot.alarmTimes[0], CLOCK_MS);
  assert.deepEqual(result.snapshot.events.slice(0, 2), [
    "set-alarm",
    "after-entry",
  ]);
  assert.equal(
    result.snapshot.scheduledAlarm,
    CLOCK_MS + RECOVERY_BASE_DELAY_MS,
  );
  assert.equal(result.snapshot.calls.createSession, 0);
});

test("the production alarm uses the default storage alarm bindings", async () => {
  const failed = await listenerRpc(
    worker,
    "platform-alarm",
    { dropExportOutbox: true },
    "production-platform-alarm-failure",
  );
  assert.equal(failed.error, null);
  assert.equal(failed.result.outcome, "alarm-failed");
  assert.match(failed.result.failure, /export_outbox/u);
  assert.equal(failed.result.nextAttemptAtMs, failed.scheduledAlarm);
  assert.equal(failed.alarmGeneration, 1);
  assert.equal(Number.isFinite(failed.scheduledAlarm), true);

  const disabled = await listenerRpc(
    disabledWorker,
    "platform-alarm",
    {},
    "production-platform-alarm-disabled",
  );
  assert.equal(disabled.error, null);
  assert.equal(disabled.result.outcome, "disabled");
  assert.equal(disabled.alarmGeneration, 1);
  assert.equal(disabled.scheduledAlarm, null);
});

test("a crash before acknowledgement redelivers the stored message", async () => {
  const name = "crash-before-ack";
  const first = await listenerRpc(
    worker,
    "alarm",
    {
      failpoint: "after-message-commit",
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(10, [1001]),
      }],
    },
    name,
  );
  assert.equal(first.error, null);
  assert.match(first.result.failure, /stub crash at after-message-commit/u);
  assert.equal(first.snapshot.listener.cursor, 0);
  assert.equal(first.snapshot.inbox[0].state, "stored");
  assert.equal(first.snapshot.calls.deleteMessage, 0);

  const replay = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: first.snapshot.scheduledAlarm,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(10, [1001]),
      }],
    },
    name,
  );
  assert.equal(replay.error, null);
  assert.equal(replay.snapshot.listener.cursor, 10);
  assert.equal(replay.snapshot.calls.deleteMessage, 1);
  assert.deepEqual(replay.snapshot.postRunnerIds, [1001]);
});

test("a legacy inbox payload replays with an empty ignored list", async () => {
  const name = "legacy-inbox-ignored-default";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      inbox: [{
        messageId: 12,
        receivedAtMs: CLOCK_MS - 1_000,
        state: "stored",
        message: availableMessage(12, [1201]),
      }],
      intents: [{
        runnerRequestId: 1201,
        messageId: 12,
        state: "intended",
        recordedAtMs: CLOCK_MS - 1_000,
      }],
    },
    name,
  );
  const replay = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: {
          messageId: 12,
          messageType: "RunnerScaleSetJobMessages",
          body: JSON.stringify([{
            messageType: "JobAvailable",
            runnerRequestId: 1201,
            ownerName: "example",
            repositoryName: "runner-test",
          }]),
          statistics: {
            ...STATISTICS,
            totalAvailableJobs: 1,
            totalAssignedJobs: 0,
          },
        },
      }],
    },
    name,
  );

  assert.equal(replay.error, null);
  assert.equal(replay.snapshot.listener.cursor, 12);
  assert.equal(replay.snapshot.calls.deleteMessage, 1);
});

test("a crash after acknowledgement keeps durable dispatch work", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      failpoint: "after-dispatch-enqueue",
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(11, [1101]),
      }],
    },
    "crash-after-ack",
  );
  assert.equal(result.error, null);
  assert.match(result.result.failure, /stub crash at after-dispatch-enqueue/u);
  assert.equal(result.snapshot.listener.cursor, 11);
  assert.equal(result.snapshot.intents[0].state, "granted");
  assert.equal(result.snapshot.outbox[0].state, "pending");
  assert.equal(result.snapshot.calls.postRunners, 0);
});

test("the remaining alarm budget shrinks and then stops polling", async () => {
  const policy = await listenerRpc(worker, "policy", {}, "budget-policy");
  assert.deepEqual(policy.boundaryPollTimeouts, [50_000, 49_999, 0, -1]);

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        { outcome: "no-message", advanceMs: 840_001 },
        { outcome: "poll-aborted", advanceMs: 49_999 },
      ],
    },
    "budget-loop",
  );
  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.pollTimeouts, [50_000, 49_999]);
  assert.equal(840_001 + 49_999 + 10_000, 900_000);
});

test("an aborted poll persists a heartbeat without acknowledgement", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        { outcome: "poll-aborted", advanceMs: 50_000 },
      ],
    },
    "aborted-poll",
  );
  assert.equal(result.error, null);
  assert.ok(result.snapshot.calls.poll >= 2);
  assert.equal(result.snapshot.calls.deleteMessage, 0);
  assert.equal(result.snapshot.listener.cursor, 0);
  assert.equal(result.snapshot.listener.heartbeatGeneration, 1);
  assert.equal(result.snapshot.listener.heartbeatCursor, 0);
});

test("an admin token refreshes inside its 60-second window", async () => {
  const name = "admin-token-refresh";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminTokenExpiresAtMs: CLOCK_MS + 59_999,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.adminRefresh, 1);
  assert.ok(result.snapshot.events.includes("refresh-admin"));
});

test("an expired static admin token names both durable remedies", async () => {
  const expiredAtMs = CLOCK_MS - 1;
  const result = await listenerRpc(
    noGithubTokenWorker,
    "alarm",
    {
      authenticationChain: { omitAppCredentials: true },
      clockMs: CLOCK_MS,
      config: { adminTokenExpiresAtMs: expiredAtMs },
    },
    "expired-static-admin-token",
  );

  const failure = result.result.failure;
  assert.equal(result.error, null);
  assert.equal(result.result.failureName, "InvalidListenerConfiguration");
  assert.match(failure, /configured Actions Service admin token expired/u);
  assert.match(failure, new RegExp(new Date(expiredAtMs).toISOString(), "u"));
  assert.match(failure, /configure a GitHub App.*or a GITHUB_TOKEN/u);
  assert.match(failure, /`repo`/u);
  assert.match(failure, /`Administration: write`/u);
  assert.equal(emittedRecords(result, "admin-token-refreshed").length, 0);
});

test("missing admin credentials report no minting path", async () => {
  const result = await listenerRpc(
    noGithubTokenWorker,
    "alarm",
    {
      authenticationChain: { omitAppCredentials: true },
      clockMs: CLOCK_MS,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
      },
    },
    "missing-admin-credentials",
  );

  const failure = result.result.failure;
  assert.equal(result.error, null);
  assert.equal(result.result.failureName, "InvalidListenerConfiguration");
  assert.match(
    failure,
    /has no way to mint an Actions Service admin connection/u,
  );
  assert.match(failure, /Configure a GitHub App.*or a GITHUB_TOKEN/u);
  assert.match(failure, /`repo`/u);
  assert.match(failure, /`Administration: write`/u);
  assert.equal(result.snapshot.calls.fetchRegistrationToken, 0);
  assert.equal(emittedRecords(result, "admin-token-refreshed").length, 0);
});

test("a usable static admin trio wins over App and GITHUB_TOKEN", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: true,
      clockMs: CLOCK_MS,
      config: {
        adminTokenExpiresAtMs: CLOCK_MS + 600_000,
        appId: "123456",
        installationId: "654321",
        privateKeyPkcs8: APP_PRIVATE_KEY,
      },
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    "usable-static-admin-token",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.createAppJwt, 0);
  assert.equal(result.snapshot.calls.fetchInstallationToken, 0);
  assert.equal(result.snapshot.calls.fetchRegistrationToken, 0);
  assert.equal(result.snapshot.calls.fetchActionsServiceConnection, 0);
  assert.equal(emittedRecords(result, "admin-token-refreshed").length, 1);
});

test("an expired static admin trio falls through to the App", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: {
        expectedGithubToken: INSTALLATION_TOKEN,
      },
      clockMs: CLOCK_MS,
      config: {
        adminTokenExpiresAtMs: CLOCK_MS - 1,
        appId: "123456",
        installationId: "654321",
        privateKeyPkcs8: APP_PRIVATE_KEY,
      },
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    "expired-static-admin-token-app-fallback",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.createAppJwt, 1);
  assert.equal(result.snapshot.calls.fetchInstallationToken, 1);
  assert.equal(result.snapshot.calls.fetchRegistrationToken, 1);
  assert.equal(result.snapshot.calls.fetchActionsServiceConnection, 1);
  assert.equal(emittedRecords(result, "admin-token-refreshed").length, 1);
});

test("GITHUB_TOKEN mints the admin connection without App credentials", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: {
        expectedGithubToken: GITHUB_TOKEN,
        omitAppCredentials: true,
      },
      clockMs: CLOCK_MS,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
      },
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    "github-token-admin-connection",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.createAppJwt, 0);
  assert.equal(result.snapshot.calls.fetchInstallationToken, 0);
  assert.equal(result.snapshot.calls.fetchRegistrationToken, 1);
  assert.equal(result.snapshot.calls.fetchActionsServiceConnection, 1);
  assert.equal(emittedRecords(result, "admin-token-refreshed").length, 1);
});

test("missing runner scope rejects GITHUB_TOKEN before registration", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: {
        expectedGithubToken: GITHUB_TOKEN,
        omitAppCredentials: true,
        omitScopeInputs: true,
      },
      clockMs: CLOCK_MS,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
      },
    },
    "github-token-missing-runner-scope",
  );

  assert.equal(result.error, null);
  assert.equal(result.result.failureName, "InvalidListenerConfiguration");
  assert.match(result.result.failure, /repository, owner, or scope/u);
  assert.match(result.result.failure, /configUrl/u);
  assert.equal(result.snapshot.calls.fetchRegistrationToken, 0);
  assert.equal(result.snapshot.calls.fetchActionsServiceConnection, 0);
  assert.equal(emittedRecords(result, "admin-token-refreshed").length, 0);
});

test("GITHUB_TOKEN remains behind complete App credentials", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: {
        expectedGithubToken: INSTALLATION_TOKEN,
      },
      clockMs: CLOCK_MS,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
        appId: "123456",
        githubToken: GITHUB_TOKEN,
        installationId: "654321",
        privateKeyPkcs8: APP_PRIVATE_KEY,
      },
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    "github-token-last-resort",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.createAppJwt, 1);
  assert.equal(result.snapshot.calls.fetchInstallationToken, 1);
  assert.equal(result.snapshot.calls.fetchRegistrationToken, 1);
  assert.equal(result.snapshot.calls.fetchActionsServiceConnection, 1);
  assert.equal(emittedRecords(result, "admin-token-refreshed").length, 1);
});

test("an under-permissioned GITHUB_TOKEN reports repository access", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: {
        expectedGithubToken: GITHUB_TOKEN,
        fetchRegistrationTokenStatus: 403,
        omitAppCredentials: true,
      },
      clockMs: CLOCK_MS,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
      },
    },
    "github-token-insufficient-permission",
  );

  const failure = result.result.failure;
  assert.equal(result.error, null);
  assert.equal(result.result.failureName, "InvalidListenerConfiguration");
  assert.equal(result.result.failureCauseName, "ScaleSetRequestError");
  assert.equal(result.result.failureCauseStatus, 403);
  assert.match(failure, /Minting a runner registration token failed/u);
  assert.match(failure, /Possible cause: the GITHUB_TOKEN/u);
  assert.doesNotMatch(failure, /is present but lacks/u);
  assert.match(failure, /`repo`/u);
  assert.match(failure, /`Administration: write`/u);
  assert.equal(failure.includes(GITHUB_TOKEN), false);
  assert.equal(result.snapshot.calls.fetchRegistrationToken, 1);
  assert.equal(result.snapshot.calls.fetchActionsServiceConnection, 0);
  assert.equal(emittedRecords(result, "admin-token-refreshed").length, 0);
});

test("registration-token diagnostics lead with the real GitHub 403 facts", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: {
        expectedGithubToken: GITHUB_TOKEN,
        fetchRegistrationTokenError: {
          status: 403,
          method: "POST",
          url: REGISTRATION_TOKEN_URL,
          responseSnippet: `  ${REAL_GITHUB_403_BODY}\n`,
        },
        omitAppCredentials: true,
      },
      clockMs: CLOCK_MS,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
        repository: "example-org/example-repo",
      },
    },
    "registration-token-real-github-403",
  );

  const failure = result.result.failure;
  assert.equal(result.error, null);
  assert.equal(result.result.failureName, "InvalidListenerConfiguration");
  assert.match(failure, /403/u);
  assert.match(failure, /POST/u);
  assert.match(failure, new RegExp(REGISTRATION_TOKEN_URL, "u"));
  assert.match(failure, /Possible cause/u);
  assert.match(failure, /User-Agent header/u);
  assert.doesNotMatch(failure, /is present but lacks/u);
  const factIndexes = [
    "Minting a runner registration token failed",
    "Method: POST",
    `URL: ${REGISTRATION_TOKEN_URL}`,
    "HTTP status: 403",
    "Request forbidden by administrative rules",
    "Possible cause",
  ].map((fact) => failure.indexOf(fact));
  assert.equal(factIndexes.every((index) => index >= 0), true);
  assert.deepEqual(
    factIndexes,
    [...factIndexes].sort((left, right) => left - right),
  );
});

test("a registration-token 404 has no permission hint", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: {
        expectedGithubToken: GITHUB_TOKEN,
        fetchRegistrationTokenError: {
          status: 404,
          method: "POST",
          url: REGISTRATION_TOKEN_URL,
          responseSnippet: "Not Found",
        },
        omitAppCredentials: true,
      },
      clockMs: CLOCK_MS,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
      },
    },
    "registration-token-404",
  );

  assert.equal(result.error, null);
  assert.equal(result.result.failureName, "ScaleSetRequestError");
  assert.equal(result.result.failureStatus, 404);
  assert.doesNotMatch(
    result.result.failure,
    /`repo` scope|`Administration: write`|Possible cause/u,
  );
});

test("an evidenced registration-token 403 enters GitHub rate-limit recovery", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: {
        expectedGithubToken: GITHUB_TOKEN,
        fetchRegistrationTokenError: {
          rateLimited: true,
          status: 403,
          method: "POST",
          url: REGISTRATION_TOKEN_URL,
          responseSnippet: "secondary rate limit",
          pauseMs: 7_000,
        },
        omitAppCredentials: true,
      },
      clockMs: CLOCK_MS,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
      },
    },
    "registration-token-rate-limit-403",
  );

  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "recovery-deferred");
  assert.equal(result.snapshot.recoveries[0].condition, "github-rate-limit");
  assert.equal(
    result.snapshot.recoveries[0].nextAttemptAtMs - CLOCK_MS,
    7_000,
  );
  assert.equal(
    result.snapshot.registrationTokenError.name,
    "RateLimitedError",
  );
  assert.doesNotMatch(
    result.snapshot.registrationTokenError.message,
    /`repo`|`Administration: write`|Possible cause/u,
  );
});

test("a registration-token transport failure remains ambiguous", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: {
        expectedGithubToken: GITHUB_TOKEN,
        fetchRegistrationTokenError: {
          status: null,
          method: "POST",
          url: REGISTRATION_TOKEN_URL,
          message: "stub registration-token transport failure",
        },
        omitAppCredentials: true,
      },
      clockMs: CLOCK_MS,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
      },
    },
    "registration-token-transport-failure",
  );

  assert.equal(result.error, null);
  assert.equal(result.result.failureName, "ScaleSetRequestError");
  assert.equal(result.result.failureStatus, null);
  assert.notEqual(
    result.result.failureName,
    "InvalidListenerConfiguration",
  );
  assert.doesNotMatch(
    result.result.failure,
    /`repo`|`Administration: write`|Possible cause/u,
  );
});

test("paced dispatches reuse one refreshed admin token", async () => {
  const name = "deduplicated-admin-token-refresh";
  const requestIds = [1401, 1402, 1403, 1404, 1405];
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminTokenExpiresAtMs: CLOCK_MS + 60_001,
      }),
      intents: requestIds.map((runnerRequestId) => ({
        runnerRequestId,
        messageId: 14,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      })),
      outbox: requestIds.map((runnerRequestId) => ({
        runnerRequestId,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      })),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [
        { outcome: "no-message", advanceMs: 1_000 },
        ...pacedNoMessagePolls(requestIds.length - 1),
      ],
    },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.adminRefresh, 1);
  assert.deepEqual(result.snapshot.postRunnerIds.sort(), requestIds);
});

test("SQLITE_FULL stops acknowledgement and keeps the alarm chain armed", async () => {
  const name = "sqlite-full";
  const first = await listenerRpc(
    worker,
    "alarm",
    {
      sqliteFullAt: "after-message-commit",
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9, [901]),
      }],
    },
    name,
  );
  assert.equal(first.result.outcome, "sqlite-full");
  assert.equal(first.snapshot.listener.sqliteFull, true);
  assert.equal(first.snapshot.listener.cursor, 0);
  assert.equal(first.snapshot.calls.deleteMessage, 0);
  assert.ok(first.snapshot.alarmTimes.length >= 2);

  const recovered = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9, [901]),
      }],
    },
    name,
  );
  assert.equal(recovered.error, null);
  assert.equal(recovered.snapshot.listener.sqliteFull, false);
  assert.equal(recovered.snapshot.listener.cursor, 9);
});

test("a JobAssigned entry does not create acquisition work", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: { messageId: 6_001, assigned: [4242] },
      }],
    },
    "assigned-is-not-acquisition",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.deepEqual(result.snapshot.intents, []);
  assert.deepEqual(result.snapshot.outbox, []);
});

test("a JobAvailable entry creates granted dispatch work", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      grants: [4242],
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(6_002, [4242]),
      }],
    },
    "available-creates-acquisition",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.acquireJobs, 1);
  assert.equal(result.snapshot.events.includes("acquire:4242"), true);
  assert.deepEqual(result.snapshot.grantedIds, [4242]);
  assert.equal(result.snapshot.intents[0].runnerRequestId, 4242);
  assert.equal(result.snapshot.intents[0].state, "granted");
  assert.equal(result.snapshot.outbox[0].runnerRequestId, 4242);
  assert.equal(
    result.snapshot.outbox[0].intentRecordedAtMs,
    result.snapshot.intents[0].recordedAtMs,
  );
});

test("a mixed message acquires only its JobAvailable entries", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: {
          messageId: 6_003,
          available: [11],
          assigned: [22],
        },
      }],
    },
    "mixed-acquisition-source",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.acquireJobs, 1);
  assert.equal(result.snapshot.events.includes("acquire:11"), true);
  assert.deepEqual(result.snapshot.grantedIds, [11]);
  assert.deepEqual(
    result.snapshot.intents.map((row) => row.runnerRequestId),
    [11],
  );
  assert.deepEqual(
    result.snapshot.outbox.map((row) => row.runnerRequestId),
    [11],
  );
});

test("AcquireJobs starts only the exact granted subset", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      grants: [1201, 1203],
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(12, [1201, 1202, 1203]),
        },
        ...pacedNoMessagePolls(1),
      ],
    },
    "strict-grant-subset",
  );
  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.grantedIds, [1201, 1203]);
  assert.deepEqual(result.snapshot.postRunnerIds.sort(), [1201, 1203]);
  assert.equal(
    result.snapshot.intents.find(
      (row) => row.runnerRequestId === 1202,
    ).state,
    "not-granted",
  );
});

test("a lost acquisition response is ambiguous and starts nothing", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      acquireErrors: ["network"],
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(13, [1301, 1302]),
      }],
    },
    "ambiguous-acquisition",
  );
  assert.equal(result.error, null);
  assert.deepEqual(
    result.snapshot.intents.map((row) => row.state),
    ["ambiguous", "ambiguous"],
  );
  assert.equal(result.snapshot.outbox.length, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
});

test("a lost JIT response reuses the exact persisted runner name", async () => {
  const name = "lost-jit-response";
  const first = await listenerRpc(
    worker,
    "alarm",
    {
      jitErrors: ["network"],
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(14, [1401]),
      }],
    },
    name,
  );
  assert.equal(first.error, null);
  assert.equal(first.snapshot.outbox[0].state, "jit-requested");
  const persistedName = first.snapshot.outbox[0].runnerName;
  assert.equal(first.snapshot.calls.postRunners, 0);

  const second = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1_000 + START_PACE_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      runnerLookups: [{
        id: 714,
        runnerRequestId: 1401,
        busy: false,
      }],
    },
    name,
  );
  assert.equal(second.error, null);
  assert.ok(second.snapshot.events.includes(`get-runner:${persistedName}`));
  assert.ok(second.snapshot.events.includes(`generate-jit:${persistedName}`));
  assert.deepEqual(second.snapshot.removedRunnerIds, [714]);
  assert.deepEqual(second.snapshot.postRunnerIds, [1401]);
});

test("crash recovery owns a RunnerReference by its persisted name", async () => {
  const name = "runner-reference-ownership";
  const first = await listenerRpc(
    worker,
    "alarm",
    {
      jitErrors: ["network"],
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(140, [14001]),
      }],
    },
    name,
  );
  assert.equal(first.error, null);
  assert.equal(first.snapshot.outbox[0].state, "jit-requested");

  const second = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1_000 + START_PACE_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
      runnerLookups: [{
        id: 7_140,
        status: "offline",
        busy: false,
      }],
    },
    name,
  );

  assert.equal(second.error, null);
  assert.deepEqual(second.snapshot.removedRunnerIds, [7_140]);
  assert.deepEqual(second.snapshot.postRunnerIds, [14_001]);
  assert.notEqual(
    second.snapshot.outbox[0].lastError,
    "runner-registration-ownership-mismatch",
  );
});

test("JIT reconciliation removes idle registrations and preserves busy ones", async () => {
  const idle = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(15, [1501]),
      }],
      runnerLookups: [{
        id: 715,
        runnerRequestId: 1501,
        busy: false,
      }],
    },
    "idle-registration",
  );
  assert.deepEqual(idle.snapshot.removedRunnerIds, [715]);
  assert.deepEqual(idle.snapshot.postRunnerIds, [1501]);

  const busy = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(16, [1601]),
      }],
      runnerLookups: [{
        id: 716,
        runnerRequestId: 1601,
        busy: true,
      }],
    },
    "busy-registration",
  );
  assert.deepEqual(busy.snapshot.removedRunnerIds, []);
  assert.equal(busy.snapshot.calls.generateJit, 0);
  assert.equal(busy.snapshot.calls.postRunners, 0);
  assert.equal(busy.snapshot.outbox[0].lastError, "busy-registration-preserved");
});

test("a cancelled JobAssigned entry cancels prior JobAvailable work", async () => {
  const name = "assigned-cancellation-after-available";
  const runnerRequestId = 4244;
  const acquired = await listenerRpc(
    worker,
    "alarm",
    {
      jitErrors: ["network"],
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(6_004, [runnerRequestId]),
      }],
    },
    name,
  );

  assert.equal(acquired.error, null);
  assert.equal(acquired.snapshot.intents[0].state, "granted");
  assert.equal(acquired.snapshot.outbox[0].state, "jit-requested");

  const cancelled = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: {
          messageId: 6_005,
          assigned: [{
            messageType: "JobAssigned",
            runnerRequestId,
            ownerName: "example",
            repositoryName: "runner-test",
            cancelled: true,
          }],
        },
      }],
    },
    name,
  );

  assert.equal(cancelled.error, null);
  assert.equal(cancelled.snapshot.calls.acquireJobs, 0);
  assert.equal(cancelled.snapshot.intents[0].state, "cancelled");
  assert.equal(cancelled.snapshot.outbox[0].state, "cancelled");
  assert.deepEqual(
    cancelled.snapshot.cancellations.map((row) => row.runnerRequestId),
    [runnerRequestId],
  );
});

test("a cancellation tombstone blocks a mid-chain start", async () => {
  const midChain = await listenerRpc(
    worker,
    "alarm",
    {
      cancelAt: "after-jit",
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(17, [1701]),
      }],
    },
    "mid-chain-cancellation",
  );
  assert.equal(midChain.snapshot.calls.postRunners, 0);
  assert.equal(midChain.snapshot.outbox[0].state, "cancelled");
  assert.equal(midChain.snapshot.calls.compensate, 1);
});

test("a cancellation tombstone blocks a deferred outbox start", async () => {
  const name = "deferred-cancellation";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 1702,
        messageId: 17,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 1702,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      }],
      cancellations: [1702],
    },
    name,
  );
  const deferred = await listenerRpc(
    worker,
    "alarm",
    { polls: [{ outcome: "no-message", advanceMs: 1_000 }] },
    name,
  );
  assert.equal(deferred.snapshot.calls.postRunners, 0);
  assert.equal(deferred.snapshot.outbox[0].state, "cancelled");
});

test("paced dispatch reaches the five-chain ceiling", async () => {
  const requestIds = [1801, 1802, 1803, 1804, 1805, 1806];
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      startBarrier: MAX_DISPATCH_CONCURRENCY,
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(18, requestIds),
        },
        ...pacedNoMessagePolls(MAX_DISPATCH_CONCURRENCY - 1),
      ],
    },
    "dispatch-concurrency",
  );
  assert.equal(result.error, null);
  assert.equal(
    result.snapshot.peakDispatch,
    MAX_DISPATCH_CONCURRENCY,
  );
  assert.equal(result.snapshot.calls.postRunners, 5);
});

test("five paced starts overlap", async () => {
  const name = "five-paced-starts-overlap";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: pendingAdmissionRows(
        18_101,
        MAX_DISPATCH_CONCURRENCY,
        CLOCK_MS,
      ),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      startBarrier: MAX_DISPATCH_CONCURRENCY,
      polls: [
        { outcome: "no-message", advanceMs: 0 },
        ...pacedNoMessagePolls(MAX_DISPATCH_CONCURRENCY - 1),
      ],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(
    result.snapshot.peakDispatch,
    MAX_DISPATCH_CONCURRENCY,
  );
  assert.equal(
    result.snapshot.calls.postRunners,
    MAX_DISPATCH_CONCURRENCY,
  );
});

test("the dispatch width gate refuses a sixth chain", async () => {
  const name = "dispatch-width-gate";
  const queued = MAX_DISPATCH_CONCURRENCY + 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: pendingAdmissionRows(18_201, queued, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      startBarrier: queued,
      polls: [
        { outcome: "no-message", advanceMs: 0 },
        ...pacedNoMessagePolls(queued - 1),
      ],
    },
    name,
  );
  const deferred = emittedRecord(result, "dispatch-deferred");

  assert.equal(result.error, null);
  assert.equal(deferred.reason, "dispatch-width");
  assert.equal(deferred.inFlight, MAX_DISPATCH_CONCURRENCY);
  assert.equal(
    deferred.maxDispatchConcurrency,
    MAX_DISPATCH_CONCURRENCY,
  );
  assert.ok(
    result.snapshot.calls.postRunners <= MAX_DISPATCH_CONCURRENCY,
  );
});

test("delivered starts never exceed the paced elapsed time", async () => {
  const name = "paced-delivered-rate";
  const passCount = 3;
  const elapsedMs = (passCount - 1) * START_PACE_MS;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        lastStartIssuedAtMs: CLOCK_MS - START_PACE_MS * 10,
      }),
      outbox: pendingAdmissionRows(
        18_301,
        MAX_DISPATCH_CONCURRENCY + passCount,
        CLOCK_MS,
      ),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [
        { outcome: "no-message", advanceMs: 0 },
        ...pacedNoMessagePolls(passCount - 1),
      ],
    },
    name,
  );
  const pacedMaximum = Math.floor(elapsedMs / START_PACE_MS) + 1;

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, passCount);
  assert.ok(result.snapshot.calls.postRunners <= pacedMaximum);
});

test("an in-flight dispatch row is not selected twice", async () => {
  const name = "in-flight-dispatch-exclusion";
  const runnerRequestId = 18_401;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: pendingAdmissionRows(runnerRequestId, 1, CLOCK_MS),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      startBarrier: 2,
      polls: [
        { outcome: "no-message", advanceMs: 0 },
        ...pacedNoMessagePolls(1),
      ],
    },
    name,
  );
  const uniqueRunnerIds = new Set(result.snapshot.postRunnerIds);

  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.postRunnerIds, [runnerRequestId]);
  assert.equal(uniqueRunnerIds.size, result.snapshot.postRunnerIds.length);
});

test("every paced dispatch rejection reaches the export outbox", async () => {
  const name = "all-dispatch-rejections";
  await listenerRpc(
    worker,
    "alarm",
    {
      jitErrorsByRunner: {
        1807: "first-dispatch-rejection",
        1808: "second-dispatch-rejection",
      },
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(180, [1807, 1808]),
      }],
    },
    name,
  );
  await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1_000 + START_PACE_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );
  await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1_000 + START_PACE_MS * 2,
      jitErrorsByRunner: {
        1808: "second-dispatch-rejection",
      },
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1_000 + START_PACE_MS * 3,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );
  const rejections = result.snapshot.exportRecords
    .map((row) => JSON.parse(row.record))
    .filter((row) => row.event === "dispatch-rejected")
    .map((row) => ({
      error: row.error,
      runnerRequestId: row.runnerRequestId,
    }));
  assert.deepEqual(rejections, [
    { error: "first-dispatch-rejection", runnerRequestId: 1807 },
    { error: "second-dispatch-rejection", runnerRequestId: 1808 },
  ]);
});

test("the alarm drains an outstanding dispatch chain before handoff", async () => {
  const name = "alarm-drains-dispatch-chain";
  const runnerRequestId = 18_601;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: pendingAdmissionRows(runnerRequestId, 1, CLOCK_MS),
    },
    name,
  );
  // The barrier parks the only chain, so the chain is still outstanding when the
  // poll loop ends. The alarm must settle it rather than hand off and abandon it.
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      startBarrier: 2,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, 1);
  // The handoff snapshot must show a settled row. An active state proves the
  // alarm returned while its chain was still running.
  assert.ok(![
    "pending",
    "jit-requested",
    "jit-ready",
    "reserved",
    "start-requested",
  ].includes(result.snapshot.outbox[0].state));
});

test("a deferred dispatch failure reaches recovery on the next pass", async () => {
  const runnerRequestId = 18_501;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      jitErrorsByRunner: { [runnerRequestId]: "rate-limit" },
      polls: [
        {
          outcome: "message",
          advanceMs: 0,
          message: availableMessage(18_500, [runnerRequestId]),
        },
        ...pacedNoMessagePolls(1),
      ],
    },
    "deferred-dispatch-recovery",
  );
  const rejection = emittedRecord(result, "dispatch-rejected");

  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "recovery-deferred");
  assert.equal(result.snapshot.recoveries[0].condition, "github-rate-limit");
  assert.equal(rejection.runnerRequestId, runnerRequestId);
});

test("a later SQLITE_FULL dispatch rejection uses sqlite recovery", async () => {
  const name = "sqlite-dispatch-rejection";
  await listenerRpc(
    worker,
    "alarm",
    {
      jitErrorsByRunner: {
        1809: "arbitrary-dispatch-rejection",
        1810: "SQLITE_FULL: dispatch database is full",
      },
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(181, [1809, 1810]),
      }],
    },
    name,
  );
  await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1_000 + START_PACE_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );
  await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1_000 + START_PACE_MS * 2,
      jitErrorsByRunner: {
        1810: "SQLITE_FULL: dispatch database is full",
      },
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1_000 + START_PACE_MS * 3,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "sqlite-full");
  const rejections = result.snapshot.exportRecords
    .map((row) => JSON.parse(row.record))
    .filter((row) => row.event === "dispatch-rejected");
  assert.equal(rejections.length, 2);
});

test("a malformed reservation fails only its dispatch", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      reserveErrorsByRunner: { 1817: "type-error" },
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(182, [1817, 1818]),
        },
        ...pacedNoMessagePolls(1),
      ],
    },
    "malformed-reservation-isolated",
  );
  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.postRunnerIds, [1818]);
  assert.deepEqual(
    result.snapshot.outbox.map((row) => ({
      lastError: row.lastError,
      runnerRequestId: row.runnerRequestId,
      state: row.state,
    })),
    [
      {
        lastError: "reservation-error",
        runnerRequestId: 1817,
        state: "failed",
      },
      { lastError: null, runnerRequestId: 1818, state: "started" },
    ],
  );
});

test("completed runners release every consumed capacity reservation", async () => {
  const name = "completed-capacity-release";
  const controlName = `${RUN_PREFIX}-control-${name}`;
  const runnerRequestIds = [1811, 1812, 1813, 1814, 1815];
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });
  assert.equal(
    (await approveCapacity(worker, controlName, MAX_ACTIVE_RUNNERS)).recorded,
    true,
  );

  const started = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      controlName,
      outagePermits: await outagePermits(
        runnerRequestIds,
        CLOCK_MS + 1_000 + START_DEADLINE_MS,
      ),
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(181, runnerRequestIds),
        },
        ...pacedNoMessagePolls(runnerRequestIds.length - 1),
      ],
    },
    name,
  );
  assert.deepEqual(started.snapshot.postRunnerIds.sort(), runnerRequestIds);
  assert.equal(
    (await autopilotControlRpc(worker, controlName, "status"))
      .liveReservationCount,
    runnerRequestIds.length,
  );

  await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 14_000,
      controlName,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: {
          messageId: 182,
          completed: runnerRequestIds.slice(0, -1),
          started: [{
            messageType: "JobStarted",
            runnerRequestId: runnerRequestIds.at(-1),
            ownerName: "example",
            repositoryName: "runner-test",
            cancelled: true,
          }],
        },
      }],
    },
    name,
  );

  const nextRunnerRequestId = 1816;
  const next = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 16_000,
      controlName,
      outagePermits: await outagePermits(
        [nextRunnerRequestId],
        CLOCK_MS + 17_000 + START_DEADLINE_MS,
      ),
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(183, [nextRunnerRequestId]),
      }],
    },
    name,
  );
  assert.deepEqual(next.snapshot.postRunnerIds, [nextRunnerRequestId]);
});

test("an ignored completion releases its owned reservation", async () => {
  const name = "ignored-completion-owned-reservation";
  const runnerRequestId = 18_201;
  const runnerName = `cloudflare-101-${runnerRequestId}`;
  const reservationId = "reservation-ignored-completion-owned";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [{
        runnerRequestId,
        state: "started",
        runnerName,
        runnerId: 8_201,
        reservationId,
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: rawScaleSetMessage(
          18_201,
          [unassignedLifecycleEntry("JobCompleted", runnerName, 8_201)],
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId,
    reason: "job-completed",
  }]);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
  const completed = emittedRecord(result, "runner-job-completed");
  assert.deepEqual({
    runnerRequestId: completed.runnerRequestId,
    registryCorrelation: completed.registryCorrelation,
    runnerName: completed.runnerName,
    runnerId: completed.runnerId,
    reservationId: completed.reservationId,
    repository: completed.repository,
    wave: completed.wave,
  }, {
    runnerRequestId,
    registryCorrelation: `scale-set:101:runner-request:${runnerRequestId}`,
    runnerName,
    runnerId: 8_201,
    reservationId,
    repository: "example/runner-test",
    wave: "wave-1",
  });
});

test("ignored starts and assignments do not release a reservation", async () => {
  const name = "ignored-active-lifecycle-no-release";
  const runnerRequestId = 18_202;
  const runnerName = `cloudflare-101-${runnerRequestId}`;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [{
        runnerRequestId,
        state: "started",
        runnerName,
        reservationId: "reservation-ignored-active-lifecycle",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: rawScaleSetMessage(
          18_202,
          [
            unassignedLifecycleEntry("JobStarted", runnerName, 8_202),
            unassignedLifecycleEntry("JobAssigned", runnerName, 8_202),
          ],
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-job-completed").length, 0);
});

test("a foreign runner name does not release an owned reservation", async () => {
  const name = "ignored-completion-foreign-runner";
  const runnerRequestId = 18_203;
  const ownedRunnerName = `cloudflare-101-${runnerRequestId}`;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [{
        runnerRequestId,
        state: "started",
        runnerName: ownedRunnerName,
        reservationId: "reservation-ignored-completion-owned-runner",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: rawScaleSetMessage(
          18_203,
          [unassignedLifecycleEntry(
            "JobCompleted",
            "cloudflare-202-4503599627370497",
            8_203,
          )],
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].runnerName, ownedRunnerName);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
});

test("a redelivered ignored completion releases only once", async () => {
  const name = "ignored-completion-idempotent-release";
  const runnerRequestId = 18_204;
  const runnerName = `cloudflare-101-${runnerRequestId}`;
  const envelope = rawScaleSetMessage(
    18_204,
    [unassignedLifecycleEntry("JobCompleted", runnerName, 8_204)],
    { ...STATISTICS, totalAssignedJobs: 0 },
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [{
        runnerRequestId,
        state: "started",
        runnerName,
        reservationId: "reservation-ignored-completion-idempotent",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        { outcome: "message", advanceMs: 1_000, envelope },
        { outcome: "message", advanceMs: 1_000, envelope },
      ],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteMessage, 1);
  assert.equal(result.snapshot.calls.compensate, 1);
  assert.equal(emittedRecords(result, "runner-job-completed").length, 1);
});

test("an ignored completion refills freed capacity in the same pass", async () => {
  const name = "ignored-completion-same-pass-refill";
  const controlName = `${RUN_PREFIX}-control-${name}`;
  const firstRunnerRequestId = SCALE_UP_REQUEST_ID_BASE + 1;
  const replacementRunnerRequestId = SCALE_UP_REQUEST_ID_BASE + 2;
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });
  assert.equal((await approveCapacity(worker, controlName, 1)).recorded, true);

  const started = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      controlName,
      outagePermits: await outagePermits(
        [firstRunnerRequestId],
        CLOCK_MS + 1_000 + START_DEADLINE_MS,
      ),
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(18_205, 1),
      }],
    },
    name,
  );
  const startedRow = started.snapshot.outbox[0];
  assert.equal(startedRow.runnerRequestId, firstRunnerRequestId);
  assert.equal(startedRow.state, "started");
  assert.equal(
    (await autopilotControlRpc(worker, controlName, "status"))
      .liveReservationCount,
    1,
  );

  const saturated = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 2_000,
      controlName,
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  assert.deepEqual(saturated.snapshot.postRunnerIds, []);
  assert.equal(saturated.snapshot.outbox.length, 1);

  const completed = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 4_000,
      controlName,
      outagePermits: await outagePermits(
        [replacementRunnerRequestId],
        CLOCK_MS + 5_000 + START_DEADLINE_MS,
      ),
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: rawScaleSetMessage(
          18_206,
          [unassignedLifecycleEntry(
            "JobCompleted",
            startedRow.runnerName,
            startedRow.runnerId,
          )],
          statisticsMessage(18_206, 1).statistics,
        ),
      }],
    },
    name,
  );

  assert.equal(completed.error, null);
  assert.deepEqual(completed.snapshot.postRunnerIds, [
    replacementRunnerRequestId,
  ]);
  assert.equal(
    emittedRecord(completed, "scale-up-start-admitted").runnerRequestId,
    replacementRunnerRequestId,
  );
  assert.equal(
    completed.snapshot.outbox.find((row) =>
      row.runnerRequestId === firstRunnerRequestId
    ).reservationReleasedAtMs !== null,
    true,
  );
  const events = completed.snapshot.emittedRecords.map(
    (record) => JSON.parse(record).event,
  );
  assert.ok(
    events.indexOf("runner-job-completed") <
      events.indexOf("scale-up-start-admitted"),
  );
  assert.equal(
    (await autopilotControlRpc(worker, controlName, "status"))
      .liveReservationCount,
    1,
  );
});

test("one failed completion release does not stop later releases", async () => {
  const name = "ignored-completion-release-failure-isolated";
  const rows = [18_207, 18_208].map((runnerRequestId) => ({
    runnerRequestId,
    state: "started",
    runnerName: `cloudflare-101-${runnerRequestId}`,
    reservationId: `reservation-${runnerRequestId}`,
    updatedAtMs: CLOCK_MS,
  }));
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      compensateError: ["stub first completion release failed", null],
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: rawScaleSetMessage(
          18_207,
          rows.map((row, index) => unassignedLifecycleEntry(
            "JobCompleted",
            row.runnerName,
            8_207 + index,
          )),
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "handoff");
  assert.equal(result.snapshot.calls.compensate, 2);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[1].reservationReleasedAtMs),
    true,
  );
  const failure = emittedRecord(result, "reservation-release-failed");
  assert.equal(failure.runnerRequestId, rows[0].runnerRequestId);
  assert.equal(failure.reservationId, rows[0].reservationId);
  assert.match(failure.error, /stub first completion release failed/u);
  assert.deepEqual(
    emittedRecords(result, "runner-job-completed").map(
      (record) => record.runnerRequestId,
    ),
    [rows[1].runnerRequestId],
  );
});

test("an elapsed release deadline does not prevent acknowledgement", async () => {
  const name = "ignored-completion-release-deadline";
  const runnerRequestId = 18_209;
  const runnerName = `cloudflare-101-${runnerRequestId}`;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [{
        runnerRequestId,
        state: "started",
        runnerName,
        reservationId: "reservation-ignored-completion-deadline",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      deleteMessageAdvanceMs: ALARM_WORK_BUDGET_MS,
      polls: [{
        outcome: "message",
        advanceMs: 0,
        envelope: rawScaleSetMessage(
          18_209,
          [unassignedLifecycleEntry("JobCompleted", runnerName, 8_209)],
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteMessage, 1);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.ok(emittedRecord(result, "message-acknowledged"));
  assert.equal(result.snapshot.inbox[0].state, "acknowledged");
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
});

test("a mixed completion message still acquires its available job", async () => {
  const name = "ignored-completion-mixed-acquisition";
  const completedRunnerRequestId = 18_210;
  const availableRunnerRequestId = 18_211;
  const completedRunnerName =
    `cloudflare-101-${completedRunnerRequestId}`;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [{
        runnerRequestId: completedRunnerRequestId,
        state: "started",
        runnerName: completedRunnerName,
        reservationId: "reservation-ignored-completion-mixed",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: rawScaleSetMessage(
          18_210,
          [
            {
              messageType: "JobAvailable",
              runnerRequestId: availableRunnerRequestId,
              ownerName: "example",
              repositoryName: "runner-test",
            },
            unassignedLifecycleEntry(
              "JobCompleted",
              completedRunnerName,
              8_210,
            ),
          ],
          {
            ...STATISTICS,
            totalAvailableJobs: 1,
            totalAssignedJobs: 0,
          },
        ),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.compensate, 1);
  assert.equal(result.snapshot.calls.acquireJobs, 1);
  assert.deepEqual(result.snapshot.grantedIds, [availableRunnerRequestId]);
  assert.deepEqual(result.snapshot.postRunnerIds, [availableRunnerRequestId]);
  assert.equal(
    result.snapshot.intents.find((row) =>
      row.runnerRequestId === availableRunnerRequestId
    ).state,
    "granted",
  );
});

test("a missing reservation settles as terminal compensation success", async () => {
  const name = "missing-reservation-terminal-success";
  const runnerRequestId = 18_212;
  const runnerName = `cloudflare-101-${runnerRequestId}`;
  const reservationId = "reservation-already-pruned";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [{
        runnerRequestId,
        state: "started",
        runnerName,
        runnerId: 8_212,
        reservationId,
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      compensateResult: {
        compensated: false,
        reason: "reservation-not-found",
      },
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: rawScaleSetMessage(
          18_212,
          [unassignedLifecycleEntry("JobCompleted", runnerName, 8_212)],
          { ...STATISTICS, totalAssignedJobs: 0 },
        ),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
  const absent = emittedRecord(result, "reservation-already-absent");
  assert.deepEqual({
    runnerRequestId: absent.runnerRequestId,
    registryCorrelation: absent.registryCorrelation,
    reservationId: absent.reservationId,
    reason: absent.reason,
    repository: absent.repository,
    wave: absent.wave,
  }, {
    runnerRequestId,
    registryCorrelation: `scale-set:101:runner-request:${runnerRequestId}`,
    reservationId,
    reason: "job-completed",
    repository: "example/runner-test",
    wave: "wave-1",
  });
  assert.equal(emittedRecords(result, "reservation-compensated").length, 0);
});

test("another non-compensated result still rejects settlement", async () => {
  const name = "non-terminal-compensation-rejected";
  const runnerRequestId = 18_213;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        mode: "drained",
        sessionId: null,
        sessionQueueUrl: null,
        sessionQueueToken: null,
      }),
      outbox: [{
        runnerRequestId,
        state: "reserved",
        reservationId: "reservation-still-present",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      compensateResult: {
        compensated: false,
        reason: "reservation-still-active",
      },
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "alarm-failed");
  assert.match(
    result.result.failure,
    /The reservation compensation failed: reservation-still-active/u,
  );
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "reservation-already-absent").length, 0);
  assert.equal(emittedRecords(result, "reservation-compensated").length, 0);
});

test("a liveness pass ensures one admin connection for several rows", async () => {
  const name = "liveness-admin-connection-once";
  const oldAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 3;
  const rows = [18_228, 18_229, 18_230].map((runnerRequestId, index) =>
    startedReservationRow(
      runnerRequestId,
      oldAtMs + index,
    )
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminTokenExpiresAtMs: CLOCK_MS + 60_001,
      }),
      outbox: rows,
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      adminRefreshConnection: {
        actionsServiceUrl: "https://actions.stub.test/tenant",
        adminToken: REFRESHED_ADMIN_TOKEN,
        adminTokenExpiresAtMs: CLOCK_MS + 1,
      },
      runnerLookups: rows.map(() => ({ busy: true })),
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.adminRefresh, 1);
  assert.equal(result.snapshot.calls.getRunnerByName, rows.length);
});

test("a liveness pass without candidates does not ensure an admin connection", async () => {
  const name = "liveness-no-candidate-admin-connection";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminTokenExpiresAtMs: CLOCK_MS + 60_001,
      }),
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification(),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.adminRefresh, 0);
  assert.equal(result.snapshot.calls.getRunnerByName, 0);
});

test("an invalid admin connection skips and de-duplicates liveness probes", async () => {
  const name = "liveness-invalid-admin-connection";
  const row = startedReservationRow(
    18_231,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminTokenExpiresAtMs: Number.MAX_SAFE_INTEGER + 1,
      }),
      outbox: [row],
    },
    name,
  );

  const specification = livenessAlarmSpecification({
    runnerLookups: [{ error: "must not be called" }],
  });
  const first = await listenerRpc(worker, "alarm", specification, name);
  const second = await listenerRpc(worker, "alarm", specification, name);

  assert.equal(first.error, null);
  assert.equal(second.error, null);
  assert.equal(first.result.outcome, "handoff");
  assert.equal(second.result.outcome, "handoff");
  assert.equal(first.snapshot.calls.getRunnerByName, 0);
  assert.equal(second.snapshot.calls.getRunnerByName, 0);
  assert.equal(
    emittedRecord(first, "runner-liveness-probe-skipped")?.reason,
    "admin-connection-invalid",
  );
  assert.equal(
    emittedRecords(second, "runner-liveness-probe-skipped").length,
    0,
  );
  assert.equal(
    second.snapshot.exportRecords
      .map((entry) => JSON.parse(entry.record))
      .filter((entry) => entry.event === "runner-liveness-probe-skipped")
      .length,
    1,
  );
});

test("a liveness probe uses the refreshed admin token", async () => {
  const name = "liveness-refreshed-admin-token";
  const row = startedReservationRow(
    18_232,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminTokenExpiresAtMs: CLOCK_MS + 60_001,
      }),
      outbox: [row],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ runnerLookups: [{ busy: true }] }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.adminRefresh, 1);
  assert.deepEqual(
    result.snapshot.getRunnerRequests.map((request) => request.adminToken),
    [REFRESHED_ADMIN_TOKEN],
  );
  assert.notEqual(
    result.snapshot.getRunnerRequests[0]?.adminToken,
    ADMIN_TOKEN,
  );
});

test("a pruned reservation is not probed after its first pass", async () => {
  const name = "pruned-reservation-single-probe";
  const row = startedReservationRow(
    18_214,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const first = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      compensateResult: {
        compensated: false,
        reason: "reservation-not-found",
      },
      runnerLookups: [null],
    }),
    name,
  );
  assert.equal(first.error, null);
  assert.equal(first.snapshot.calls.getRunnerByName, 1);
  assert.equal(first.snapshot.outbox[0].livenessProbeAttempts, 1);
  assert.equal(
    Number.isSafeInteger(first.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
  assert.equal(
    emittedRecords(first, "reservation-already-absent").length,
    1,
  );

  const second = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ runnerLookups: [null] }),
    name,
  );
  assert.equal(second.error, null);
  assert.equal(second.snapshot.calls.getRunnerByName, 0);
  assert.equal(second.snapshot.calls.compensate, 0);
  assert.equal(second.snapshot.outbox[0].livenessProbeAttempts, 1);
});

test("a failing row is abandoned at the liveness attempt bound", async () => {
  const name = "liveness-attempt-bound";
  const row = startedReservationRow(
    18_215,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  let boundedResult;
  for (let attempt = 1; attempt <= MAX_LIVENESS_PROBE_ATTEMPTS; attempt += 1) {
    boundedResult = await listenerRpc(
      worker,
      "alarm",
      livenessAlarmSpecification({
        runnerLookups: [{ error: "persistent liveness failure" }],
      }),
      name,
    );
    assert.equal(boundedResult.error, null);
    assert.equal(boundedResult.snapshot.calls.getRunnerByName, 1);
    assert.equal(
      boundedResult.snapshot.outbox[0].livenessProbeAttempts,
      attempt,
    );
  }

  const abandoned = emittedRecord(
    boundedResult,
    "runner-liveness-probe-abandoned",
  );
  assert.equal(abandoned.runnerRequestId, row.runnerRequestId);
  assert.equal(abandoned.runnerName, row.runnerName);
  assert.equal(abandoned.reservationId, row.reservationId);
  assert.equal(abandoned.attempts, MAX_LIVENESS_PROBE_ATTEMPTS);

  const afterBound = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ error: "must not be called" }],
    }),
    name,
  );
  assert.equal(afterBound.error, null);
  assert.equal(afterBound.snapshot.calls.getRunnerByName, 0);
  assert.equal(
    afterBound.snapshot.outbox[0].livenessProbeAttempts,
    MAX_LIVENESS_PROBE_ATTEMPTS,
  );
  assert.equal(
    emittedRecords(afterBound, "runner-liveness-probe-abandoned").length,
    0,
  );
});

test("a live result resets the consecutive liveness failure count", async () => {
  const name = "liveness-failure-streak-reset";
  const row = startedReservationRow(
    18_225,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const lookups = [
    { error: "liveness failure one" },
    { error: "liveness failure two" },
    { busy: true },
    { error: "liveness failure three" },
    { error: "liveness failure four" },
  ];
  const expectedFailureCounts = [1, 2, 0, 1, 2];
  for (const [index, lookup] of lookups.entries()) {
    const result = await listenerRpc(
      worker,
      "alarm",
      livenessAlarmSpecification({ runnerLookups: [lookup] }),
      name,
    );

    assert.equal(result.error, null, `pass ${index + 1}`);
    assert.equal(result.snapshot.calls.getRunnerByName, 1, `pass ${index + 1}`);
    assert.equal(
      result.snapshot.outbox[0].livenessProbeAttempts,
      expectedFailureCounts[index],
      `pass ${index + 1}`,
    );
    assert.equal(
      emittedRecords(result, "runner-liveness-probe-abandoned").length,
      0,
      `pass ${index + 1}`,
    );
  }
});

test("a failed liveness attempt preserves the started timestamp", async () => {
  const name = "liveness-attempt-preserves-timestamp";
  const updatedAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1;
  const row = startedReservationRow(18_216, updatedAtMs);
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ error: "timestamp probe failure" }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].livenessProbeAttempts, 1);
  assert.equal(result.snapshot.outbox[0].updatedAtMs, updatedAtMs);
});

test("a liveness counter reset preserves the started timestamp", async () => {
  const name = "liveness-reset-preserves-timestamp";
  const updatedAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1;
  const row = startedReservationRow(18_226, updatedAtMs, {
    livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS - 1,
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ runnerLookups: [{ busy: true }] }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].livenessProbeAttempts, 0);
  assert.equal(result.snapshot.outbox[0].updatedAtMs, updatedAtMs);
  assert.equal(
    emittedRecords(result, "runner-liveness-probe-abandoned").length,
    0,
  );
});

test("each liveness attempt records its probe time before lookup", async () => {
  const name = "liveness-probed-at-updated-before-lookup";
  const row = startedReservationRow(
    18_227,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const pollAdvanceMs = ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS;
  const first = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ runnerLookups: [{ busy: true }] }),
    name,
  );
  assert.equal(first.error, null);
  assert.equal(
    first.snapshot.outbox[0].livenessProbedAtMs,
    CLOCK_MS + pollAdvanceMs,
  );

  const secondClockMs = CLOCK_MS + ALARM_WALL_BUDGET_MS;
  const second = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      clockMs: secondClockMs,
      runnerLookups: [{ error: "liveness lookup failed" }],
    }),
    name,
  );
  assert.equal(second.error, null);
  assert.equal(second.snapshot.outbox[0].livenessProbeAttempts, 1);
  assert.equal(
    second.snapshot.outbox[0].livenessProbedAtMs,
    secondClockMs + pollAdvanceMs,
  );
});

test("a row from another scale set is never probed", async () => {
  const name = "foreign-scale-set-not-probed";
  const row = startedReservationRow(
    18_217,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
    { runnerName: "cloudflare-1-4503599627370517" },
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ scaleSetId: 2 }), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      config: { scaleSetId: 2 },
      runnerLookups: [null],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getRunnerByName, 0);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(result.snapshot.outbox[0].livenessProbeAttempts, 0);
});

test("the foreign scale-set count is emitted once while unchanged", async () => {
  const name = "foreign-scale-set-count-deduplicated";
  const oldAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 2;
  const rows = [18_218, 18_219].map((runnerRequestId, index) =>
    startedReservationRow(runnerRequestId, oldAtMs + index, {
      runnerName: `cloudflare-1-${runnerRequestId}`,
    })
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ scaleSetId: 2 }), outbox: rows },
    name,
  );

  const first = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ config: { scaleSetId: 2 } }),
    name,
  );
  assert.equal(first.error, null);
  assert.equal(
    emittedRecord(first, "liveness-probe-scope-skipped").count,
    rows.length,
  );

  const second = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ config: { scaleSetId: 2 } }),
    name,
  );
  assert.equal(second.error, null);
  assert.equal(
    emittedRecords(second, "liveness-probe-scope-skipped").length,
    0,
  );
});

test("the current scale-set row is probed beside foreign rows", async () => {
  const name = "current-scale-set-probed-with-foreign-row";
  const oldAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 2;
  const foreign = startedReservationRow(18_220, oldAtMs, {
    runnerName: "cloudflare-1-4503599627370518",
  });
  const current = startedReservationRow(18_221, oldAtMs + 1, {
    runnerName: "cloudflare-2-4503599627370519",
  });
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ scaleSetId: 2 }),
      outbox: [foreign, current],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      config: { scaleSetId: 2 },
      runnerLookups: [null],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getRunnerByName, 1);
  assert.deepEqual(
    result.snapshot.events.filter((event) => event.startsWith("get-runner:")),
    [`get-runner:${current.runnerName}`],
  );
  assert.equal(
    result.snapshot.outbox.find((row) =>
      row.runnerRequestId === foreign.runnerRequestId
    ).reservationReleasedAtMs,
    null,
  );
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox.find((row) =>
      row.runnerRequestId === current.runnerRequestId
    ).reservationReleasedAtMs),
    true,
  );
});

test("an invalid scale-set identifier skips the scope filter", async () => {
  const scenarios = [
    { label: "absent", scaleSetId: null },
    { label: "malformed", scaleSetId: "invalid" },
  ];
  for (const scenario of scenarios) {
    const name = `invalid-probe-scope-${scenario.label}`;
    const row = startedReservationRow(
      scenario.label === "absent" ? 18_222 : 18_223,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
      { runnerName: "cloudflare-1-4503599627370520" },
    );
    await listenerRpc(
      worker,
      "seed",
      {
        state: persistedSessionState(),
        outbox: [row],
      },
      name,
    );

    const result = await listenerRpc(
      worker,
      "alarm",
      livenessAlarmSpecification({
        runnerLookups: [{ busy: true }],
        scaleSetIdAfterPoll: scenario.scaleSetId,
      }),
      name,
    );

    assert.equal(result.error, null, scenario.label);
    assert.equal(result.snapshot.calls.getRunnerByName, 1, scenario.label);
    assert.equal(result.snapshot.listener.scaleSetId, scenario.scaleSetId);
    assert.equal(result.snapshot.outbox[0].livenessProbeAttempts, 0);
    assert.equal(
      emittedRecords(result, "liveness-probe-scope-skipped").length,
      0,
    );
  }
});

test("R1: startup-failure cleanup reclaims an undelivered runner", async () => {
  const name = "r1-undelivered-startup-failure";
  const runnerRequestId = 29_001;
  const row = startedReservationRow(
    runnerRequestId,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
    {
      livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS,
      runnerName: `worker-runner-${runnerRequestId}`,
    },
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminToken: null,
        adminTokenExpiresAtMs: null,
      }),
      outbox: [row],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [{
        cleanupRequestedBy: "startup-failure",
        sandboxId: "undelivered-sandbox-29001",
        state: "destroying",
      }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 1);
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId: row.reservationId,
    reason: "runner-undelivered",
  }]);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
  const reclaimed = emittedRecord(result, "runner-undelivered");
  assert.deepEqual({
    cleanupRequestedBy: reclaimed.cleanupRequestedBy,
    registryCorrelation: reclaimed.registryCorrelation,
    registryState: reclaimed.registryState,
    repository: reclaimed.repository,
    reservationId: reclaimed.reservationId,
    runnerName: reclaimed.runnerName,
    runnerRequestId: reclaimed.runnerRequestId,
    sandboxId: reclaimed.sandboxId,
    wave: reclaimed.wave,
  }, {
    cleanupRequestedBy: "startup-failure",
    registryCorrelation: `scale-set:101:runner-request:${runnerRequestId}`,
    registryState: "destroying",
    repository: "example/runner-test",
    reservationId: row.reservationId,
    runnerName: row.runnerName,
    runnerRequestId,
    sandboxId: "undelivered-sandbox-29001",
    wave: "wave-1",
  });
});

test("R2: callback cleanup does not reclaim a runner", async () => {
  const name = "r2-undelivered-callback-guard";
  const row = startedReservationRow(
    29_002,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [{
        cleanupRequestedBy: "callback",
        state: "destroying",
      }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 1);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-undelivered").length, 0);
});

test("R3: cleanup without a cause does not reclaim a runner", async () => {
  const name = "r3-undelivered-null-cleanup-cause";
  const row = startedReservationRow(
    29_003,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [{
        cleanupRequestedBy: null,
        state: "starting",
      }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 1);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-undelivered").length, 0);
});

test("R4: an absent registry row does not reclaim a runner", async () => {
  const name = "r4-undelivered-absent-registry-row";
  const row = startedReservationRow(
    29_004,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ startLookups: [null] }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 1);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-undelivered").length, 0);
});

test("R5: a registry lookup failure does not stop reclamation", async () => {
  const name = "r5-undelivered-registry-failure-isolated";
  const rows = [29_005, 29_006].map((runnerRequestId, index) =>
    startedReservationRow(
      runnerRequestId,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 2 + index,
    )
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [
        { error: "registry lookup failed" },
        {
          cleanupRequestedBy: "startup-failure",
          sandboxId: "undelivered-sandbox-29006",
          state: "destroying",
        },
      ],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 2);
  assert.equal(result.snapshot.calls.compensate, 1);
  assert.equal(
    result.snapshot.outbox.find((outboxRow) =>
      outboxRow.runnerRequestId === rows[0].runnerRequestId
    ).reservationReleasedAtMs,
    null,
  );
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox.find((outboxRow) =>
      outboxRow.runnerRequestId === rows[1].runnerRequestId
    ).reservationReleasedAtMs),
    true,
  );
  const failure = emittedRecord(result, "runner-undelivered-check-failed");
  assert.equal(failure.runnerRequestId, rows[0].runnerRequestId);
  assert.equal(
    failure.registryCorrelation,
    `scale-set:101:runner-request:${rows[0].runnerRequestId}`,
  );
  assert.equal(failure.runnerName, rows[0].runnerName);
  assert.equal(failure.repository, "example/runner-test");
  assert.equal(failure.wave, "wave-1");
  assert.match(failure.error, /registry lookup failed/u);
  assert.equal(
    emittedRecord(result, "runner-undelivered").runnerRequestId,
    rows[1].runnerRequestId,
  );
});

test("R6: a young row is not checked for non-delivery", async () => {
  const name = "r6-undelivered-minimum-age";
  const checkAtMs = CLOCK_MS +
    ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS;
  const row = startedReservationRow(
    29_007,
    checkAtMs - RUNNER_LIVENESS_PROBE_MIN_AGE_MS + 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [{
        cleanupRequestedBy: "startup-failure",
        state: "destroying",
      }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 0);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-undelivered").length, 0);
});

test("R7: a released reservation is not checked for non-delivery", async () => {
  const name = "r7-undelivered-released-reservation";
  const releasedAtMs = CLOCK_MS - 1;
  const row = startedReservationRow(
    29_008,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
    { reservationReleasedAtMs: releasedAtMs },
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [{
        cleanupRequestedBy: "startup-failure",
        state: "destroying",
      }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 0);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(
    result.snapshot.outbox[0].reservationReleasedAtMs,
    releasedAtMs,
  );
  assert.equal(emittedRecords(result, "runner-undelivered").length, 0);
});

test("R8: one alarm bounds undelivered reclamation", async () => {
  const name = "r8-undelivered-pass-bound";
  const rowCount = MAX_LIVENESS_PROBES_PER_PASS + 2;
  const rows = Array.from({ length: rowCount }, (_, index) =>
    startedReservationRow(
      29_100 + index,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - rowCount + index,
    )
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: Array.from({ length: rowCount }, () => ({
        cleanupRequestedBy: "startup-failure",
        state: "destroying",
      })),
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(
    result.snapshot.calls.getStartByCorrelation,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.equal(
    result.snapshot.calls.compensate,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.deepEqual(
    emittedRecords(result, "runner-undelivered").map((record) =>
      record.runnerRequestId
    ),
    rows.slice(0, MAX_LIVENESS_PROBES_PER_PASS).map((boundedRow) =>
      boundedRow.runnerRequestId
    ),
  );
  assert.equal(
    result.snapshot.outbox.filter((outboxRow) =>
      Number.isSafeInteger(outboxRow.reservationReleasedAtMs)
    ).length,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
});

test("T1: consecutive undelivered passes examine disjoint rows", async () => {
  const name = "t1-undelivered-rotation-disjoint";
  const rowCount = MAX_LIVENESS_PROBES_PER_PASS * 2;
  const rows = Array.from({ length: rowCount }, (_, index) =>
    startedReservationRow(
      30_001 + index,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - rowCount + index,
      { livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS },
    )
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );
  const specification = livenessAlarmSpecification({
    startLookups: Array.from(
      { length: MAX_LIVENESS_PROBES_PER_PASS },
      () => ({ cleanupRequestedBy: "callback", state: "destroying" }),
    ),
  });

  const first = await listenerRpc(worker, "alarm", specification, name);
  const firstIds = first.snapshot.outbox
    .filter((row) => Number.isSafeInteger(row.undeliveredCheckedAtMs))
    .map((row) => row.runnerRequestId);
  const second = await listenerRpc(worker, "alarm", specification, name);
  const firstIdSet = new Set(firstIds);
  const secondIds = second.snapshot.outbox
    .filter((row) =>
      Number.isSafeInteger(row.undeliveredCheckedAtMs) &&
      !firstIdSet.has(row.runnerRequestId)
    )
    .map((row) => row.runnerRequestId);

  assert.deepEqual(
    firstIds,
    rows.slice(0, MAX_LIVENESS_PROBES_PER_PASS).map((row) =>
      row.runnerRequestId
    ),
  );
  assert.deepEqual(
    secondIds,
    rows.slice(MAX_LIVENESS_PROBES_PER_PASS).map((row) =>
      row.runnerRequestId
    ),
  );
  assert.equal(secondIds.some((runnerRequestId) =>
    firstIdSet.has(runnerRequestId)
  ), false);
  assert.deepEqual(
    emittedRecord(first, "runner-undelivered-pass").causes,
    { callback: MAX_LIVENESS_PROBES_PER_PASS },
  );
  assert.deepEqual(
    emittedRecord(second, "runner-undelivered-pass").causes,
    { callback: MAX_LIVENESS_PROBES_PER_PASS },
  );
});

test("T2: undelivered rotation eventually examines every row", async () => {
  const name = "t2-undelivered-rotation-complete";
  const rowCount = MAX_LIVENESS_PROBES_PER_PASS * 2 + 1;
  const passCount = Math.ceil(rowCount / MAX_LIVENESS_PROBES_PER_PASS);
  const rows = Array.from({ length: rowCount }, (_, index) =>
    startedReservationRow(
      30_101 + index,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - rowCount + index,
      { livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS },
    )
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const examinedIds = new Set();
  let result;
  for (let pass = 0; pass < passCount; pass += 1) {
    result = await listenerRpc(
      worker,
      "alarm",
      livenessAlarmSpecification({
        startLookups: Array.from(
          { length: MAX_LIVENESS_PROBES_PER_PASS },
          () => ({ cleanupRequestedBy: "callback", state: "destroying" }),
        ),
      }),
      name,
    );
    for (const correlation of result.snapshot.getStartCorrelations) {
      examinedIds.add(Number(correlation.split(":").at(-1)));
    }
  }

  assert.deepEqual(
    [...examinedIds].sort((left, right) => left - right),
    rows.map((row) => row.runnerRequestId),
  );
  assert.equal(result.snapshot.outbox.every((row) =>
    Number.isSafeInteger(row.undeliveredCheckedAtMs)
  ), true);
});

test("T3: a throwing undelivered lookup rotates out of the head", async () => {
  const name = "t3-undelivered-throw-rotates";
  const rowCount = MAX_LIVENESS_PROBES_PER_PASS * 2;
  const rows = Array.from({ length: rowCount }, (_, index) =>
    startedReservationRow(
      30_201 + index,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - rowCount + index,
      { livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS },
    )
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const first = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [
        { error: "registry lookup failed" },
        ...Array.from(
          { length: MAX_LIVENESS_PROBES_PER_PASS - 1 },
          () => ({ cleanupRequestedBy: "callback", state: "destroying" }),
        ),
      ],
    }),
    name,
  );
  const throwingRow = first.snapshot.outbox.find((row) =>
    row.runnerRequestId === rows[0].runnerRequestId
  );
  const firstPass = emittedRecord(first, "runner-undelivered-pass");
  assert.equal(Number.isSafeInteger(throwingRow.undeliveredCheckedAtMs), true);
  assert.equal(firstPass.lookupFailed, 1);
  assert.equal(firstPass.examined, MAX_LIVENESS_PROBES_PER_PASS - 1);

  const second = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: Array.from(
        { length: MAX_LIVENESS_PROBES_PER_PASS },
        () => ({ cleanupRequestedBy: "callback", state: "destroying" }),
      ),
    }),
    name,
  );
  const secondIds = second.snapshot.getStartCorrelations.map((correlation) =>
    Number(correlation.split(":").at(-1))
  );
  assert.deepEqual(
    secondIds,
    rows.slice(MAX_LIVENESS_PROBES_PER_PASS).map((row) =>
      row.runnerRequestId
    ),
  );
  assert.equal(secondIds.includes(rows[0].runnerRequestId), false);
});

test("T4: startup-failure remains the undelivered reclaim cause", async () => {
  const name = "t4-undelivered-startup-failure-reclaimed";
  const row = startedReservationRow(
    30_301,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
    { livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS },
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [{
        cleanupRequestedBy: "startup-failure",
        sandboxId: "undelivered-sandbox-30301",
        state: "destroying",
      }],
    }),
    name,
  );
  const pass = emittedRecord(result, "runner-undelivered-pass");

  assert.deepEqual(result.snapshot.compensated, [{
    reservationId: row.reservationId,
    reason: "runner-undelivered",
  }]);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
  assert.equal(emittedRecords(result, "runner-undelivered").length, 1);
  assert.deepEqual({
    examined: pass.examined,
    reclaimed: pass.reclaimed,
    causes: pass.causes,
  }, {
    examined: 1,
    reclaimed: 1,
    causes: { "startup-failure": 1 },
  });
});

test("T5: callback remains outside undelivered reclamation", async () => {
  const name = "t5-undelivered-callback-not-reclaimed";
  const row = startedReservationRow(
    30_401,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
    { livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS },
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [{ cleanupRequestedBy: "callback", state: "destroying" }],
    }),
    name,
  );
  const pass = emittedRecord(result, "runner-undelivered-pass");

  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-undelivered").length, 0);
  assert.deepEqual({
    examined: pass.examined,
    reclaimed: pass.reclaimed,
    causes: pass.causes,
  }, {
    examined: 1,
    reclaimed: 0,
    causes: { callback: 1 },
  });
});

test("T6: an absent registry row remains unreclaimed", async () => {
  const name = "t6-undelivered-absent-not-reclaimed";
  const row = startedReservationRow(
    30_501,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
    { livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS },
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ startLookups: [null] }),
    name,
  );
  const pass = emittedRecord(result, "runner-undelivered-pass");

  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-undelivered").length, 0);
  assert.deepEqual({
    examined: pass.examined,
    reclaimed: pass.reclaimed,
    absentRegistry: pass.absentRegistry,
    causes: pass.causes,
  }, {
    examined: 0,
    reclaimed: 0,
    absentRegistry: 1,
    causes: {},
  });
});

test("T7: undelivered pass diagnostics cover empty and guarded rows", async () => {
  const name = "t7-undelivered-pass-diagnostics";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );

  const empty = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification(),
    name,
  );
  assert.equal(
    emittedRecords(empty, "runner-undelivered-pass").length,
    1,
  );
  const emptyPass = emittedRecord(empty, "runner-undelivered-pass");
  assert.deepEqual({
    candidates: emptyPass.candidates,
    examined: emptyPass.examined,
    reclaimed: emptyPass.reclaimed,
    lookupFailed: emptyPass.lookupFailed,
    absentRegistry: emptyPass.absentRegistry,
    causes: emptyPass.causes,
  }, {
    candidates: 0,
    examined: 0,
    reclaimed: 0,
    lookupFailed: 0,
    absentRegistry: 0,
    causes: {},
  });
  assert.equal(empty.snapshot.exportRecords
    .map((entry) => JSON.parse(entry.record))
    .some((entry) => entry.event === "runner-undelivered-pass"), false);

  const rows = [30_601, 30_602].map((runnerRequestId, index) =>
    startedReservationRow(
      runnerRequestId,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 2 + index,
      { livenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS },
    )
  );
  await listenerRpc(worker, "seed", { outbox: rows }, name);
  const guarded = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      startLookups: [
        { cleanupRequestedBy: "callback", state: "destroying" },
        { cleanupRequestedBy: null, state: "starting" },
      ],
    }),
    name,
  );
  assert.equal(
    emittedRecords(guarded, "runner-undelivered-pass").length,
    1,
  );
  const guardedPass = emittedRecord(guarded, "runner-undelivered-pass");

  assert.deepEqual({
    candidates: guardedPass.candidates,
    examined: guardedPass.examined,
    reclaimed: guardedPass.reclaimed,
    lookupFailed: guardedPass.lookupFailed,
    absentRegistry: guardedPass.absentRegistry,
    causes: guardedPass.causes,
  }, {
    candidates: 2,
    examined: 2,
    reclaimed: 0,
    lookupFailed: 0,
    absentRegistry: 0,
    causes: { callback: 1, null: 1 },
  });
  assert.equal(guarded.snapshot.exportRecords
    .map((entry) => JSON.parse(entry.record))
    .some((entry) => entry.event === "runner-undelivered-pass"), false);
});

test("bounded failures cannot starve a newer liveness row", async () => {
  const name = "bounded-liveness-head-of-line";
  const oldAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 100;
  const failingCount = MAX_LIVENESS_PROBES_PER_PASS + 1;
  const failingRows = Array.from({ length: failingCount }, (_, index) =>
    startedReservationRow(18_300 + index, oldAtMs + index)
  );
  const healthy = startedReservationRow(
    18_300 + failingCount,
    oldAtMs + failingCount,
  );
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [...failingRows, healthy],
    },
    name,
  );

  const blocked = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: Array.from(
        { length: MAX_LIVENESS_PROBES_PER_PASS },
        () => ({ error: "unsettleable row" }),
      ),
    }),
    name,
  );
  assert.equal(blocked.error, null);
  assert.equal(
    blocked.snapshot.calls.getRunnerByName,
    MAX_LIVENESS_PROBES_PER_PASS,
  );

  const reached = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ error: "unsettleable row" }, null],
    }),
    name,
  );
  assert.equal(reached.error, null);
  assert.equal(
    reached.snapshot.calls.getRunnerByName,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.ok(
    reached.snapshot.events.includes(`get-runner:${healthy.runnerName}`),
  );
  assert.equal(
    Number.isSafeInteger(reached.snapshot.outbox.find((row) =>
      row.runnerRequestId === healthy.runnerRequestId
    ).reservationReleasedAtMs),
    true,
  );
});

test("an absent started runner releases its reservation", async () => {
  const name = "deregistered-runner-release";
  const runnerRequestId = 18_301;
  const row = startedReservationRow(
    runnerRequestId,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "no-message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
      runnerLookups: [null],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId: row.reservationId,
    reason: "runner-deregistered",
  }]);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
  const deregistered = emittedRecord(result, "runner-deregistered");
  assert.deepEqual({
    runnerRequestId: deregistered.runnerRequestId,
    registryCorrelation: deregistered.registryCorrelation,
    runnerName: deregistered.runnerName,
    runnerId: deregistered.runnerId,
    reservationId: deregistered.reservationId,
    repository: deregistered.repository,
    wave: deregistered.wave,
  }, {
    runnerRequestId,
    registryCorrelation: `scale-set:101:runner-request:${runnerRequestId}`,
    runnerName: row.runnerName,
    runnerId: row.runnerId,
    reservationId: row.reservationId,
    repository: "example/runner-test",
    wave: "wave-1",
  });
});

test("C1: an idle started runner past its deadline is reclaimed", async () => {
  const name = "idle-started-runner-reclaimed";
  const runnerRequestId = 31_801;
  const intentRecordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  const sandboxId = "runner-unassigned-sandbox-31801";
  const row = startedReservationRow(runnerRequestId, intentRecordedAtMs, {
    intentRecordedAtMs,
    spawnObserved: true,
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ busy: false }],
      startLookups: [
        { cleanupRequestedBy: null, sandboxId, state: "running" },
        { cleanupRequestedBy: null, sandboxId, state: "running" },
      ],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId: row.reservationId,
    reason: "runner-unassigned",
  }]);
  assert.deepEqual(result.snapshot.scheduledCleanup, [sandboxId]);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
  const reclaimed = emittedRecord(result, "runner-unassigned");
  assert.deepEqual({
    runnerRequestId: reclaimed.runnerRequestId,
    registryCorrelation: reclaimed.registryCorrelation,
    runnerName: reclaimed.runnerName,
    runnerId: reclaimed.runnerId,
    reservationId: reclaimed.reservationId,
    acquisitionDeadlineMs: reclaimed.acquisitionDeadlineMs,
    ageMs: reclaimed.ageMs,
    repository: reclaimed.repository,
    wave: reclaimed.wave,
  }, {
    runnerRequestId,
    registryCorrelation: `scale-set:101:runner-request:${runnerRequestId}`,
    runnerName: row.runnerName,
    runnerId: row.runnerId,
    reservationId: row.reservationId,
    acquisitionDeadlineMs: intentRecordedAtMs + START_DEADLINE_MS,
    ageMs: CLOCK_MS + ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS -
      intentRecordedAtMs,
    repository: "example/runner-test",
    wave: "wave-1",
  });
});

test("C2: a busy started runner past its deadline is untouched", async () => {
  const name = "busy-started-runner-preserved";
  const intentRecordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  const row = startedReservationRow(31_802, intentRecordedAtMs, {
    intentRecordedAtMs,
    spawnObserved: true,
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ busy: true }],
      startLookups: [{ cleanupRequestedBy: null, state: "running" }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.calls.scheduleCleanup, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-unassigned").length, 0);
});

test("C3: an idle started runner inside its deadline is untouched", async () => {
  const name = "idle-started-runner-inside-deadline";
  const probeAtMs = CLOCK_MS + ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS;
  const intentRecordedAtMs = probeAtMs - START_DEADLINE_MS + 1;
  const updatedAtMs = probeAtMs - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1;
  const row = startedReservationRow(31_803, updatedAtMs, {
    intentRecordedAtMs,
    spawnObserved: true,
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ busy: false }],
      startLookups: [{ cleanupRequestedBy: null, state: "running" }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getRunnerByName, 1);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.calls.scheduleCleanup, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-unassigned").length, 0);
});

test("C4: an idle never-spawned runner inside its deadline is untouched", async () => {
  const name = "idle-never-spawned-runner-inside-deadline";
  const probeAtMs = CLOCK_MS + ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS;
  const intentRecordedAtMs = probeAtMs - START_DEADLINE_MS + 1;
  const updatedAtMs = probeAtMs - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1;
  const row = startedReservationRow(31_804, updatedAtMs, {
    intentRecordedAtMs,
    spawnObserved: false,
  });
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ busy: false }],
      startLookups: [{ cleanupRequestedBy: null, state: "running" }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getRunnerByName, 1);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.calls.scheduleCleanup, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(emittedRecords(result, "runner-unassigned").length, 0);
});

test("C5: reclaiming an idle runner clears the live shortfall", async () => {
  const name = "idle-runner-same-pass-refill";
  const controlName = `${RUN_PREFIX}-control-${name}`;
  const firstRunnerRequestId = SCALE_UP_REQUEST_ID_BASE + 1;
  const replacementRunnerRequestId = SCALE_UP_REQUEST_ID_BASE + 2;
  const sandboxId = `runner-sandbox-${firstRunnerRequestId}`;
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });
  assert.equal((await approveCapacity(worker, controlName, 1)).recorded, true);

  const started = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      controlName,
      outagePermits: await outagePermits(
        [firstRunnerRequestId],
        CLOCK_MS + 1_000 + START_DEADLINE_MS,
      ),
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(31_805, 1),
      }],
    },
    name,
  );
  const startedRow = started.snapshot.outbox[0];
  assert.equal(startedRow.state, "started");
  assert.equal(startedRow.spawnObserved, true);
  assert.equal(
    (await autopilotControlRpc(worker, controlName, "status"))
      .liveReservationCount,
    1,
  );

  const alarmStartMs = startedRow.updatedAtMs + ALARM_WORK_BUDGET_MS;
  const firstPollAdvanceMs = RUNNER_LIVENESS_PROBE_MIN_AGE_MS -
    ALARM_WORK_BUDGET_MS - 1;
  const probeAtMs = startedRow.updatedAtMs +
    RUNNER_LIVENESS_PROBE_MIN_AGE_MS + 1;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: alarmStartMs,
      controlName,
      outagePermits: await outagePermits(
        [replacementRunnerRequestId],
        probeAtMs + START_DEADLINE_MS,
      ),
      polls: [
        { outcome: "no-message", advanceMs: firstPollAdvanceMs },
        { outcome: "no-message", advanceMs: 2 },
      ],
      runnerLookups: [{ busy: false }],
      startLookups: [
        { cleanupRequestedBy: null, sandboxId, state: "running" },
        { cleanupRequestedBy: null, sandboxId, state: "running" },
      ],
    },
    name,
  );

  assert.equal(result.error, null);
  const compensated = emittedRecord(result, "reservation-compensated");
  assert.equal(compensated.reservationId, startedRow.reservationId);
  assert.equal(compensated.reason, "runner-unassigned");
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox.find((row) =>
      row.runnerRequestId === firstRunnerRequestId
    ).reservationReleasedAtMs),
    true,
  );
  assert.deepEqual(result.snapshot.scheduledCleanup, [sandboxId]);
  const evaluation = emittedRecord(result, "scale-up-evaluated");
  assert.equal(evaluation.liveReservationCount, 0);
  assert.equal(evaluation.shortfall > 0, true);
  assert.equal(evaluation.admitted, 1);
  assert.equal(
    emittedRecord(result, "scale-up-start-admitted").runnerRequestId,
    replacementRunnerRequestId,
  );
  assert.deepEqual(result.snapshot.postRunnerIds, [replacementRunnerRequestId]);
  const events = result.snapshot.emittedRecords.map(
    (record) => JSON.parse(record).event,
  );
  assert.ok(
    events.indexOf("runner-unassigned") <
      events.indexOf("scale-up-start-admitted"),
  );
  assert.equal(
    (await autopilotControlRpc(worker, controlName, "status"))
      .liveReservationCount,
    1,
  );
});

test("C6: a reclaimed runner request accepts redelivery", async () => {
  const name = "reclaimed-runner-request-redelivery";
  const runnerRequestId = 31_806;
  const firstMessageId = 31_806;
  const redeliveryMessageId = 31_807;
  const intentRecordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  const redeliveryClockMs = CLOCK_MS + ALARM_WALL_BUDGET_MS;
  const sandboxId = "runner-unassigned-sandbox-31806";
  const row = startedReservationRow(runnerRequestId, intentRecordedAtMs, {
    intentRecordedAtMs,
    spawnObserved: true,
  });
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId,
        messageId: firstMessageId,
        state: "granted",
        recordedAtMs: intentRecordedAtMs,
      }],
      outbox: [row],
    },
    name,
  );

  const reclaimed = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ busy: false }],
      startLookups: [
        { cleanupRequestedBy: null, sandboxId, state: "running" },
        { cleanupRequestedBy: null, sandboxId, state: "running" },
      ],
    }),
    name,
  );
  assert.equal(reclaimed.error, null);
  assert.equal(
    Number.isSafeInteger(
      reclaimed.snapshot.outbox[0].reservationReleasedAtMs,
    ),
    true,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: redeliveryClockMs,
      failpoint: "after-message-commit",
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(redeliveryMessageId, [runnerRequestId]),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.match(result.result.failure, /stub crash at after-message-commit/u);
  const redelivered = emittedRecord(result, "runner-request-redelivered");
  assert.equal(redelivered?.runnerRequestId, runnerRequestId);
  assert.equal(redelivered?.previousMessageId, firstMessageId);
  assert.deepEqual(result.snapshot.outbox, []);
  assert.deepEqual({
    messageId: result.snapshot.intents[0].messageId,
    state: result.snapshot.intents[0].state,
    recordedAtMs: result.snapshot.intents[0].recordedAtMs,
  }, {
    messageId: redeliveryMessageId,
    state: "intended",
    recordedAtMs: redeliveryClockMs + 1_000,
  });
  const refusedReasons = emittedRecords(
    result,
    "runner-request-redelivery-refused",
  ).map((record) => record.reason);
  assert.equal(refusedReasons.includes("dispatch-started"), false);
  assert.equal(refusedReasons.includes("reservation-unreleased"), false);
});

test("C7: a reclaimed row uses one redelivery", async () => {
  const name = "reclaimed-row-redelivery-budget";
  const runnerRequestId = 31_808;
  const firstMessageId = 31_808;
  const redeliveryMessageId = 31_809;
  const redeliveriesBefore = 1;
  const intentRecordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  const sandboxId = "runner-unassigned-sandbox-31808";
  const row = startedReservationRow(runnerRequestId, intentRecordedAtMs, {
    intentRecordedAtMs,
    spawnObserved: true,
  });
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId,
        messageId: firstMessageId,
        state: "granted",
        redeliveries: redeliveriesBefore,
        recordedAtMs: intentRecordedAtMs,
      }],
      outbox: [row],
    },
    name,
  );

  const reclaimed = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ busy: false }],
      startLookups: [
        { cleanupRequestedBy: null, sandboxId, state: "running" },
        { cleanupRequestedBy: null, sandboxId, state: "running" },
      ],
    }),
    name,
  );
  assert.equal(reclaimed.error, null);
  assert.equal(
    reclaimed.snapshot.intents[0].redeliveries,
    redeliveriesBefore,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + ALARM_WALL_BUDGET_MS,
      failpoint: "after-message-commit",
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(redeliveryMessageId, [runnerRequestId]),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  const expectedRedeliveries = redeliveriesBefore + 1;
  assert.equal(
    emittedRecord(result, "runner-request-redelivered")?.redeliveries,
    expectedRedeliveries,
  );
  assert.equal(
    result.snapshot.intents[0].redeliveries,
    expectedRedeliveries,
  );
});

test("P1: a busy liveness result emits an observation without reclamation", async () => {
  const name = "p1-busy-liveness-observation";
  const row = startedReservationRow(
    28_001,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ runnerLookups: [{ busy: true }] }),
    name,
  );

  assert.equal(result.error, null);
  const observations = emittedRecords(
    result,
    "runner-liveness-probe-observed",
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].runnerRequestId, row.runnerRequestId);
  assert.equal(observations[0].outcome, "busy");
  assert.equal(observations[0].busy, true);
  assert.equal(emittedRecords(result, "runner-deregistered").length, 0);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  assert.equal(
    result.snapshot.exportRecords
      .map((entry) => JSON.parse(entry.record))
      .some((entry) => entry.event === "runner-liveness-probe-observed"),
    false,
  );
});

test("P2: an idle liveness result emits an observation without reclamation", async () => {
  const name = "p2-idle-liveness-observation";
  const row = startedReservationRow(
    28_002,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ runnerLookups: [{ busy: false }] }),
    name,
  );

  assert.equal(result.error, null);
  const observations = emittedRecords(
    result,
    "runner-liveness-probe-observed",
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].runnerRequestId, row.runnerRequestId);
  assert.equal(observations[0].outcome, "idle");
  assert.equal(observations[0].busy, false);
  assert.equal(emittedRecords(result, "runner-deregistered").length, 0);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
});

test("P3: an absent liveness result preserves reclamation", async () => {
  const name = "p3-absent-liveness-observation";
  const row = startedReservationRow(
    28_003,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ runnerLookups: [null] }),
    name,
  );

  assert.equal(result.error, null);
  const observations = emittedRecords(
    result,
    "runner-liveness-probe-observed",
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].runnerRequestId, row.runnerRequestId);
  assert.equal(observations[0].outcome, "absent");
  assert.equal(observations[0].busy, false);
  assert.equal(emittedRecords(result, "runner-deregistered").length, 1);
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId: row.reservationId,
    reason: "runner-deregistered",
  }]);
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
});

test("P4: an empty liveness pass emits its candidate count", async () => {
  const name = "p4-empty-liveness-pass-observation";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification(),
    name,
  );

  assert.equal(result.error, null);
  const passes = emittedRecords(result, "runner-liveness-probe-pass");
  assert.equal(passes.length, 1);
  assert.equal(passes[0].candidates, 0);
  assert.equal(result.snapshot.calls.getRunnerByName, 0);
  assert.equal(
    result.snapshot.exportRecords
      .map((entry) => JSON.parse(entry.record))
      .some((entry) => entry.event === "runner-liveness-probe-pass"),
    false,
  );
});

test("P5: a liveness observation reports the started age", async () => {
  const name = "p5-liveness-started-age-observation";
  const row = startedReservationRow(
    28_005,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ runnerLookups: [{ busy: true }] }),
    name,
  );

  assert.equal(result.error, null);
  const observed = emittedRecord(result, "runner-liveness-probe-observed");
  assert.equal(typeof observed.startedAgeMs, "number");
  assert.ok(observed.startedAgeMs >= 0);
  assert.ok(observed.startedAgeMs >= RUNNER_LIVENESS_PROBE_MIN_AGE_MS);
});

for (const scenario of [
  { outcome: "busy", runnerRequestId: 18_302, lookup: { busy: true } },
  { outcome: "idle", runnerRequestId: 18_303, lookup: { busy: false } },
  {
    outcome: "not-owned",
    runnerRequestId: 18_304,
    lookup: { busy: false, name: "foreign-runner" },
  },
]) {
  test(`a ${scenario.outcome} runner stays probeable after the failure bound`, async () => {
    const name = `liveness-${scenario.outcome}-retained`;
    const row = startedReservationRow(
      scenario.runnerRequestId,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
    );
    await listenerRpc(
      worker,
      "seed",
      { state: persistedSessionState(), outbox: [row] },
      name,
    );

    for (
      let pass = 1;
      pass <= MAX_LIVENESS_PROBE_ATTEMPTS + 1;
      pass += 1
    ) {
      const result = await listenerRpc(
        worker,
        "alarm",
        livenessAlarmSpecification({
          runnerLookups: [scenario.lookup],
        }),
        name,
      );

      assert.equal(result.error, null, `pass ${pass}`);
      assert.equal(result.snapshot.calls.getRunnerByName, 1, `pass ${pass}`);
      assert.equal(result.snapshot.calls.compensate, 0, `pass ${pass}`);
      assert.equal(
        result.snapshot.outbox[0].reservationReleasedAtMs,
        null,
        `pass ${pass}`,
      );
      assert.equal(
        result.snapshot.outbox[0].livenessProbeAttempts,
        0,
        `pass ${pass}`,
      );
      assert.equal(
        emittedRecords(result, "runner-liveness-probe-abandoned").length,
        0,
        `pass ${pass}`,
      );
      assert.equal(
        emittedRecords(result, "runner-deregistered").length,
        0,
        `pass ${pass}`,
      );
      assert.equal(
        emittedRecords(result, "runner-liveness-probe-failed").length,
        0,
        `pass ${pass}`,
      );
    }
  });
}

test("live liveness candidates rotate across bounded passes", async () => {
  const name = "live-liveness-candidates-rotate";
  const rowCount = MAX_LIVENESS_PROBES_PER_PASS + 2;
  const oldAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - rowCount;
  const rows = Array.from({ length: rowCount }, (_, index) =>
    startedReservationRow(18_350 + index, oldAtMs + index)
  );
  const expectedRunnerNames = rows.map((row) => row.runnerName);
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const liveLookups = Array.from(
    { length: MAX_LIVENESS_PROBES_PER_PASS },
    () => ({ busy: true }),
  );
  const first = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({ runnerLookups: liveLookups }),
    name,
  );
  assert.equal(first.error, null);
  const firstRunnerNames = first.snapshot.events
    .filter((event) => event.startsWith("get-runner:"))
    .map((event) => event.slice("get-runner:".length));
  assert.deepEqual(
    firstRunnerNames,
    expectedRunnerNames.slice(0, MAX_LIVENESS_PROBES_PER_PASS),
  );

  const second = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      clockMs: CLOCK_MS + ALARM_WALL_BUDGET_MS,
      runnerLookups: liveLookups,
    }),
    name,
  );
  assert.equal(second.error, null);
  const secondRunnerNames = second.snapshot.events
    .filter((event) => event.startsWith("get-runner:"))
    .map((event) => event.slice("get-runner:".length));
  assert.notDeepEqual(secondRunnerNames, firstRunnerNames);
  assert.deepEqual(
    secondRunnerNames.slice(0, rowCount - MAX_LIVENESS_PROBES_PER_PASS),
    expectedRunnerNames.slice(MAX_LIVENESS_PROBES_PER_PASS),
  );
});

test("a never-probed liveness row sorts before a probed row", async () => {
  const name = "never-probed-liveness-row-first";
  const oldAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 2;
  const probed = startedReservationRow(18_360, oldAtMs, {
    livenessProbedAtMs: CLOCK_MS - 1,
  });
  const neverProbed = startedReservationRow(18_361, oldAtMs + 1);
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      outbox: [probed, neverProbed],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    livenessAlarmSpecification({
      runnerLookups: [{ busy: true }, { busy: true }],
    }),
    name,
  );

  assert.equal(result.error, null);
  assert.deepEqual(
    result.snapshot.events
      .filter((event) => event.startsWith("get-runner:"))
      .map((event) => event.slice("get-runner:".length)),
    [neverProbed.runnerName, probed.runnerName],
  );
});

test("a young started runner is not probed", async () => {
  const name = "young-runner-liveness-guard";
  const probeAtMs = CLOCK_MS +
    ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS;
  const row = startedReservationRow(
    18_305,
    probeAtMs - RUNNER_LIVENESS_PROBE_MIN_AGE_MS + 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "no-message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
      runnerLookups: [null],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getRunnerByName, 0);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
});

test("a liveness pass probes only its oldest bounded candidates", async () => {
  const name = "liveness-probe-pass-bound";
  const rowCount = MAX_LIVENESS_PROBES_PER_PASS + 2;
  const rows = Array.from({ length: rowCount }, (_, index) =>
    startedReservationRow(
      18_400 + rowCount - index,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - rowCount + index,
    )
  );
  const expectedRunnerNames = rows.map((row) => row.runnerName);
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const first = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "no-message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
      runnerLookups: Array(rowCount).fill(null),
    },
    name,
  );
  assert.equal(first.error, null);
  assert.equal(
    first.snapshot.calls.getRunnerByName,
    MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.deepEqual(
    first.snapshot.events
      .filter((event) => event.startsWith("get-runner:"))
      .map((event) => event.slice("get-runner:".length)),
    expectedRunnerNames.slice(0, MAX_LIVENESS_PROBES_PER_PASS),
  );

  const second = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "no-message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
      runnerLookups: Array(rowCount).fill(null),
    },
    name,
  );
  assert.equal(second.error, null);
  assert.equal(
    second.snapshot.calls.getRunnerByName,
    rowCount - MAX_LIVENESS_PROBES_PER_PASS,
  );
  assert.deepEqual(
    second.snapshot.events
      .filter((event) => event.startsWith("get-runner:"))
      .map((event) => event.slice("get-runner:".length)),
    expectedRunnerNames.slice(MAX_LIVENESS_PROBES_PER_PASS),
  );
});

test("a failed liveness probe does not stop the next probe", async () => {
  const name = "liveness-probe-failure-isolated";
  const rows = [18_501, 18_502].map((runnerRequestId, index) =>
    startedReservationRow(
      runnerRequestId,
      CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 2 + index,
    )
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "no-message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
      runnerLookups: [{ error: "runner lookup failed" }, null],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "handoff");
  assert.equal(result.snapshot.calls.getRunnerByName, 2);
  assert.equal(result.snapshot.calls.compensate, 1);
  assert.equal(
    result.snapshot.outbox.find((row) =>
      row.runnerRequestId === rows[0].runnerRequestId
    ).reservationReleasedAtMs,
    null,
  );
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox.find((row) =>
      row.runnerRequestId === rows[1].runnerRequestId
    ).reservationReleasedAtMs),
    true,
  );
  const failure = emittedRecord(result, "runner-liveness-probe-failed");
  assert.equal(failure.runnerRequestId, rows[0].runnerRequestId);
  assert.equal(failure.reservationId, rows[0].reservationId);
  assert.match(failure.error, /runner lookup failed/u);
});

test("ineligible reservation rows are not probed", async () => {
  const name = "ineligible-liveness-rows";
  const oldAtMs = CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1;
  const rows = [
    startedReservationRow(18_601, oldAtMs, { state: "failed" }),
    startedReservationRow(18_602, oldAtMs, {
      reservationReleasedAtMs: CLOCK_MS - 1,
    }),
  ];
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: rows },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "no-message",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
      runnerLookups: [null, null],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.getRunnerByName, 0);
  assert.equal(result.snapshot.calls.compensate, 0);
});

test("a deregistered reservation refills capacity in the same pass", async () => {
  const name = "deregistered-runner-same-pass-refill";
  const controlName = `${RUN_PREFIX}-control-${name}`;
  const firstRunnerRequestId = SCALE_UP_REQUEST_ID_BASE + 1;
  const replacementRunnerRequestId = SCALE_UP_REQUEST_ID_BASE + 2;
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });
  assert.equal((await approveCapacity(worker, controlName, 1)).recorded, true);

  const started = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      controlName,
      outagePermits: await outagePermits(
        [firstRunnerRequestId],
        CLOCK_MS + 1_000 + START_DEADLINE_MS,
      ),
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: statisticsMessage(18_701, 1),
      }],
    },
    name,
  );
  const startedRow = started.snapshot.outbox[0];
  assert.equal(startedRow.runnerRequestId, firstRunnerRequestId);
  assert.equal(startedRow.state, "started");
  assert.equal(
    (await autopilotControlRpc(worker, controlName, "status"))
      .liveReservationCount,
    1,
  );

  const alarmStartMs = startedRow.updatedAtMs + ALARM_WORK_BUDGET_MS;
  const firstPollAdvanceMs = RUNNER_LIVENESS_PROBE_MIN_AGE_MS -
    ALARM_WORK_BUDGET_MS - 1;
  const probeAtMs = startedRow.updatedAtMs +
    RUNNER_LIVENESS_PROBE_MIN_AGE_MS;
  const refilled = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: alarmStartMs,
      controlName,
      outagePermits: await outagePermits(
        [replacementRunnerRequestId],
        probeAtMs + START_DEADLINE_MS,
      ),
      polls: [
        { outcome: "no-message", advanceMs: firstPollAdvanceMs },
        { outcome: "no-message", advanceMs: 1 },
      ],
      runnerLookups: [null, null],
    },
    name,
  );

  assert.equal(refilled.error, null);
  const saturated = emittedRecord(refilled, "scale-up-saturated");
  assert.equal(saturated.totalAssignedJobs, 1);
  assert.equal(saturated.desired, 1);
  assert.equal(saturated.liveReservationCount, 1);
  assert.equal(saturated.shortfall, 0);
  assert.deepEqual(refilled.snapshot.postRunnerIds, [
    replacementRunnerRequestId,
  ]);
  assert.equal(
    emittedRecord(refilled, "scale-up-start-admitted").runnerRequestId,
    replacementRunnerRequestId,
  );
  const events = refilled.snapshot.emittedRecords.map(
    (record) => JSON.parse(record).event,
  );
  assert.ok(
    events.indexOf("scale-up-saturated") <
      events.indexOf("runner-deregistered"),
  );
  assert.ok(
    events.indexOf("runner-deregistered") <
      events.indexOf("scale-up-start-admitted"),
  );
  assert.equal(
    (await autopilotControlRpc(worker, controlName, "status"))
      .liveReservationCount,
    1,
  );
});

test("an aborted poll probes a deregistered runner", async () => {
  const name = "aborted-poll-runner-liveness";
  const row = startedReservationRow(
    18_801,
    CLOCK_MS - RUNNER_LIVENESS_PROBE_MIN_AGE_MS - 1,
  );
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState(), outbox: [row] },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{
        outcome: "poll-aborted",
        advanceMs: ALARM_WALL_BUDGET_MS - ALARM_WORK_BUDGET_MS,
      }],
      runnerLookups: [null],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(emittedRecords(result, "message-poll-aborted").length, 1);
  assert.equal(result.snapshot.calls.getRunnerByName, 1);
  assert.equal(result.snapshot.calls.compensate, 1);
  assert.equal(emittedRecords(result, "runner-deregistered").length, 1);
});

test("an unapproved control triggers the pre-poll kill switch", async () => {
  const name = "unapproved-control";
  const controlName = `${RUN_PREFIX}-control-${name}`;
  const runnerRequestIds = [1822, 1823, 1824, 1825, 1826];
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      controlName,
      outagePermits: await outagePermits(
        runnerRequestIds,
        CLOCK_MS + 1_000 + START_DEADLINE_MS,
      ),
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(184, runnerRequestIds),
      }],
    },
    name,
  );
  // Pin the pre-poll controlStatus.maxCapacity <= 0 kill-switch branch.
  assert.equal(result.result.outcome, "kill-switch");
  assert.deepEqual(
    {
      mode: result.snapshot.listener.mode,
      stoppedReason: result.snapshot.listener.stoppedReason,
    },
    {
      mode: "stopped",
      stoppedReason: "failure:kill-switch-transition",
    },
  );
  assert.deepEqual(result.snapshot.postRunnerIds, []);
  assert.deepEqual(result.snapshot.outbox, []);
});

test("the outage gate serves a real permit for one runner request", async () => {
  const name = "real-outage-gate-permit";
  const controlName = `${RUN_PREFIX}-control-${name}`;
  const runnerRequestId = 1821;
  const outageGateUrl = "https://outage-gate.stub.test/permit";
  const expiresAtMs = CLOCK_MS + 1_000 + START_DEADLINE_MS;
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });
  assert.equal(
    (await approveCapacity(worker, controlName, 1)).recorded,
    true,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      config: { outageGateUrl },
      controlName,
      outageGatePermits: {
        [runnerRequestId]: await outagePermit(runnerRequestId, expiresAtMs),
      },
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(184, [runnerRequestId]),
      }],
    },
    name,
  );
  assert.deepEqual(result.snapshot.postRunnerIds, [runnerRequestId]);
  assert.deepEqual(result.snapshot.outageGateRequests, [{
    body: {
      expiresAtMs,
      repository: "example/runner-test",
      runnerRequestId,
      scaleSetId: 101,
      wave: "wave-1",
    },
    headers: {
      authorization: `Bearer ${OUTAGE_GATE_TOKEN}`,
      "content-type": "application/json",
    },
    method: "POST",
    signalPresent: true,
    url: outageGateUrl,
  }]);
  const status = await listenerRpc(worker, "reconstruct", {}, name);
  assert.deepEqual(status.startGate, {
    lastRefusal: null,
    lastRefusalAtMs: null,
    lastClosedReason: null,
    lastClosedAtMs: null,
  });
});

test("a closed outage gate names its refusal and metadata", async () => {
  const name = "outage-gate-closed-diagnosis";
  const runnerRequestId = 1827;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      outageGateResponseBody: {
        refused: true,
        reason: "gate-closed",
        generation: 7,
        closedAtMs: 1234,
      },
      outageGateStatus: 503,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(185, [runnerRequestId]),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(result.snapshot.outbox[0].lastError, "outage-gate-closed");
  assert.equal(result.snapshot.calls.reserve, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
  const failure = emittedRecord(result, "runner-spawn-failed");
  assert.equal(failure.reason, "outage-gate-closed");
  assert.equal(failure.upstreamStatus, 503);
  assert.equal(failure.gateReason, "gate-closed");
  assert.equal(failure.gateGeneration, 7);
  assert.equal(failure.gateClosedAtMs, 1234);
  const status = await listenerRpc(worker, "reconstruct", {}, name);
  assert.deepEqual(status.startGate.lastRefusal, {
    reason: "outage-gate-closed",
    upstreamStatus: 503,
    gateReason: "gate-closed",
    gateGeneration: 7,
    gateClosedAtMs: 1234,
    repository: "example/runner-test",
    runnerRequestId,
  });
  assert.equal(status.startGate.lastRefusalAtMs, CLOCK_MS + 1_000);
});

test("a non-JSON outage gate refusal keeps the generic reason", async () => {
  const runnerRequestId = 1828;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      outageGateResponseBody: "not JSON",
      outageGateStatus: 401,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(186, [runnerRequestId]),
      }],
    },
    "outage-gate-non-json-diagnosis",
  );

  assert.equal(result.snapshot.outbox[0].lastError, "outage-gate-refused");
  const failure = emittedRecord(result, "runner-spawn-failed");
  assert.equal(failure.reason, "outage-gate-refused");
  assert.equal(failure.upstreamStatus, 401);
  assert.equal(Object.hasOwn(failure, "gateReason"), false);
});

test("a repository outage gate refusal keeps its upstream reason", async () => {
  const runnerRequestId = 1829;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      outageGateResponseBody: {
        refused: true,
        reason: "repository-not-allowed",
      },
      outageGateStatus: 400,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(187, [runnerRequestId]),
      }],
    },
    "outage-gate-repository-diagnosis",
  );

  const failure = emittedRecord(result, "runner-spawn-failed");
  assert.equal(failure.reason, "outage-gate-refused");
  assert.equal(failure.upstreamStatus, 400);
  assert.equal(failure.gateReason, "repository-not-allowed");
});

test("an outage gate refusal omits invalid numeric metadata", async () => {
  const runnerRequestId = 1830;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      outageGateResponseBody: {
        refused: true,
        reason: "gate-closed",
        generation: "7",
        closedAtMs: -1,
      },
      outageGateStatus: 503,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(188, [runnerRequestId]),
      }],
    },
    "outage-gate-invalid-metadata",
  );

  const failure = emittedRecord(result, "runner-spawn-failed");
  assert.equal(failure.reason, "outage-gate-closed");
  assert.equal(failure.upstreamStatus, 503);
  assert.equal(failure.gateReason, "gate-closed");
  assert.equal(Object.hasOwn(failure, "gateGeneration"), false);
  assert.equal(Object.hasOwn(failure, "gateClosedAtMs"), false);
});

test("every non-HTTP outage gate failure remains named and durable", async () => {
  const outageGateUrl = "https://outage-gate.stub.test/permit";
  const cases = [
    {
      name: "url-unconfigured",
      reason: "outage-gate-url-unconfigured",
      config: {
        outageGateUrl: null,
        outagePermit: await outagePermit(1831, CLOCK_MS + START_DEADLINE_MS),
      },
    },
    {
      name: "url-invalid",
      reason: "outage-gate-url-invalid",
      config: { outageGateUrl: "ftp://outage-gate.stub.test/permit" },
    },
    {
      name: "token-unconfigured",
      reason: "outage-gate-token-unconfigured",
      config: { outageGateUrl },
      target: noGithubTokenWorker,
    },
    {
      name: "unreachable",
      reason: "outage-gate-unreachable",
      config: { outageGateUrl },
      outageGateError: "stub outage gate unreachable",
    },
    {
      name: "invalid-response",
      reason: "outage-gate-invalid-response",
      config: { outageGateUrl },
      outageGateResponseBody: "not JSON",
    },
  ];
  for (const [offset, scenario] of cases.entries()) {
    const runnerRequestId = 1831 + offset;
    const { target = worker, ...specification } = scenario;
    const name = `outage-gate-${scenario.name}`;
    const result = await listenerRpc(
      target,
      "alarm",
      {
        ...specification,
        clockMs: CLOCK_MS,
        polls: [{
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(185 + offset, [runnerRequestId]),
        }],
      },
      name,
    );
    assert.deepEqual(result.snapshot.postRunnerIds, []);
    assert.equal(result.snapshot.outbox[0].lastError, scenario.reason);
    const status = await listenerRpc(target, "reconstruct", {}, name);
    assert.deepEqual(status.startGate.lastRefusal, {
      reason: scenario.reason,
      repository: "example/runner-test",
      runnerRequestId,
    });
    assert.equal(status.startGate.lastRefusalAtMs, CLOCK_MS + 1_000);
  }
});

test("excess dispatch work remains durable until the next alarm", async () => {
  const name = "deferred-dispatch";
  const requestIds = [1901, 1902, 1903, 1904, 1905, 1906];
  const first = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(19, requestIds),
        },
        ...pacedNoMessagePolls(MAX_DISPATCH_CONCURRENCY - 1),
      ],
    },
    name,
  );
  assert.equal(first.snapshot.calls.postRunners, 5);
  assert.equal(
    first.snapshot.outbox.filter((row) => row.state === "pending").length,
    1,
  );

  const second = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 1_000 +
        MAX_DISPATCH_CONCURRENCY * START_PACE_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );
  assert.deepEqual(second.snapshot.postRunnerIds, [1906]);
});

test("S2 records a spent row budget without dispatching", async () => {
  const name = "dispatch-row-budget-exhausted";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 1911,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 1911,
        state: "reserved",
        runnerName: "cloudflare-101-1911",
        reservationId: "reservation-1911",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      clockValues: dispatchBudgetClockValues(15),
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  const deferred = emittedRecord(result, "dispatch-deferred");

  assert.deepEqual(
    {
      jitRegistered: deferred?.jitRegistered,
      reason: deferred?.reason,
      registryCorrelation: deferred?.registryCorrelation,
      remainingMs: deferred?.remainingMs,
      runnerName: deferred?.runnerName,
      runnerRequestId: deferred?.runnerRequestId,
      state: deferred?.state,
    },
    {
      jitRegistered: false,
      reason: "work-budget-exhausted",
      registryCorrelation: "scale-set:101:runner-request:1911",
      remainingMs: 0,
      runnerName: "cloudflare-101-1911",
      runnerRequestId: 1911,
      state: "reserved",
    },
  );
  assert.equal(result.snapshot.calls.reserve, 0);
  assert.equal(result.snapshot.calls.generateJit, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.outbox[0].state, "reserved");
});

test("S2 identifies rows that hold a JIT registration", async () => {
  for (const [offset, state, expected] of [
    [0, "jit-ready", true],
    [1, "reserved", false],
  ]) {
    const runnerRequestId = 1912 + offset;
    const name = `dispatch-jit-registration-${state}`;
    await listenerRpc(
      worker,
      "seed",
      {
        state: persistedSessionState(),
        intents: [{
          runnerRequestId,
          messageId: 19,
          state: "granted",
          recordedAtMs: CLOCK_MS,
        }],
        outbox: [{
          runnerRequestId,
          state,
          runnerName: `cloudflare-101-${runnerRequestId}`,
          reservationId: `reservation-${runnerRequestId}`,
          jitConfig: state === "jit-ready" ? JIT_CONFIG : null,
          updatedAtMs: CLOCK_MS,
        }],
      },
      name,
    );

    const result = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs: CLOCK_MS,
        clockValues: dispatchBudgetClockValues(15),
        polls: [{ outcome: "no-message", advanceMs: 1_000 }],
      },
      name,
    );

    assert.equal(
      emittedRecord(result, "dispatch-deferred")?.jitRegistered,
      expected,
    );
    assert.equal(result.snapshot.calls.postRunners, 0);
  }
});

test("S3 records a skipped dispatch pass and its deferred count", async () => {
  const name = "dispatch-pass-budget-exhausted";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [1914, 1915].map((runnerRequestId) => ({
        runnerRequestId,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      })),
      outbox: [1914, 1915].map((runnerRequestId) => ({
        runnerRequestId,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      })),
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      clockValues: dispatchBudgetClockValues(14),
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  const deferred = emittedRecord(result, "dispatch-deferred");

  assert.deepEqual(
    { deferred: deferred?.deferred, reason: deferred?.reason },
    { deferred: 2, reason: "pass-budget-exhausted" },
  );
  assert.equal(result.result.deferredOutbox, 2);
  assert.equal(result.snapshot.calls.reserve, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.deepEqual(
    result.snapshot.outbox.map((row) => row.attempts),
    [0, 0],
  );
});

test("S1 excludes a row that became terminal before the next pass", async () => {
  const name = "dispatch-selected-row-terminal";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [1916, 1917].map((runnerRequestId) => ({
        runnerRequestId,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      })),
      outbox: [
        {
          runnerRequestId: 1916,
          state: "reserved",
          reservationId: "reservation-1916",
          updatedAtMs: CLOCK_MS,
        },
        {
          runnerRequestId: 1917,
          state: "pending",
          updatedAtMs: CLOCK_MS + 1,
        },
      ],
      cancellations: [1916],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      drainMutationAfterCompensate: { terminal: [1917] },
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  assert.equal(emittedRecords(result, "dispatch-deferred").length, 0);
  assert.equal(
    result.snapshot.outbox.find((row) =>
      row.runnerRequestId === 1917
    ).state,
    "cancelled",
  );
  assert.equal(result.snapshot.calls.postRunners, 0);
});

test("S1 excludes a row that vanished before the next pass", async () => {
  const name = "dispatch-selected-row-absent";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [1918, 1919].map((runnerRequestId) => ({
        runnerRequestId,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      })),
      outbox: [
        {
          runnerRequestId: 1918,
          state: "reserved",
          reservationId: "reservation-1918",
          updatedAtMs: CLOCK_MS,
        },
        {
          runnerRequestId: 1919,
          state: "pending",
          updatedAtMs: CLOCK_MS + 1,
        },
      ],
      cancellations: [1918],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      drainMutationAfterCompensate: { deleted: [1919] },
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  assert.equal(emittedRecords(result, "dispatch-deferred").length, 0);
  assert.equal(
    result.snapshot.outbox.some((row) => row.runnerRequestId === 1919),
    false,
  );
  assert.equal(result.snapshot.calls.postRunners, 0);
});

test("an unchanged dispatch deferral emits once across passes", async () => {
  const name = "dispatch-deferral-deduplicated";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 1920,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 1920,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const specification = {
    clockMs: CLOCK_MS,
    clockValues: dispatchBudgetClockValues(14),
    polls: [{ outcome: "no-message", advanceMs: 1_000 }],
  };

  const first = await listenerRpc(worker, "alarm", specification, name);
  const second = await listenerRpc(worker, "alarm", specification, name);

  assert.equal(emittedRecords(first, "dispatch-deferred").length, 1);
  assert.equal(emittedRecords(second, "dispatch-deferred").length, 0);
  assert.equal(
    second.snapshot.exportRecords
      .map((row) => JSON.parse(row.record))
      .filter((row) => row.event === "dispatch-deferred").length,
    1,
  );
});

test("a changed dispatch deferral emits on the next pass", async () => {
  const name = "dispatch-deferral-changed";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 1921,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 1921,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const specification = {
    clockMs: CLOCK_MS,
    clockValues: dispatchBudgetClockValues(14),
    polls: [{ outcome: "no-message", advanceMs: 1_000 }],
  };

  const first = await listenerRpc(worker, "alarm", specification, name);
  await listenerRpc(
    worker,
    "seed",
    {
      intents: [{
        runnerRequestId: 1922,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 1922,
        state: "pending",
        updatedAtMs: CLOCK_MS + 1,
      }],
    },
    name,
  );
  const second = await listenerRpc(worker, "alarm", specification, name);

  assert.equal(emittedRecord(first, "dispatch-deferred")?.deferred, 1);
  assert.equal(emittedRecord(second, "dispatch-deferred")?.deferred, 2);
});

test("a deferred row dispatches on a later pass with available budget", async () => {
  const name = "dispatch-deferral-reselected";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 1923,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 1923,
        state: "reserved",
        runnerName: "cloudflare-101-1923",
        reservationId: "reservation-1923",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const deferred = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      clockValues: dispatchBudgetClockValues(15),
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  const dispatched = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs:
        deferred.snapshot.listener.startPace.lastStartIssuedAtMs +
        START_PACE_MS,
      polls: [{ outcome: "no-message", advanceMs: 0 }],
    },
    name,
  );

  assert.equal(emittedRecords(deferred, "dispatch-deferred").length, 1);
  assert.equal(deferred.snapshot.calls.postRunners, 0);
  assert.deepEqual(dispatched.snapshot.postRunnerIds, [1923]);
  assert.equal(emittedRecord(dispatched, "runner-spawned")?.runnerRequestId, 1923);
  assert.equal(dispatched.snapshot.outbox[0].state, "started");
});

test("a successful dispatch emits no dispatch deferral", async () => {
  const name = "dispatch-success-not-deferred";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 1924,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 1924,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );

  assert.equal(emittedRecords(result, "dispatch-deferred").length, 0);
  assert.deepEqual(result.snapshot.postRunnerIds, [1924]);
  assert.equal(emittedRecord(result, "runner-spawned")?.runnerRequestId, 1924);
});

test("S4 records both reconcile deferral guards", async () => {
  const budgetName = "reconcile-budget-exhausted";
  await listenerRpc(
    worker,
    "seed",
    {
      intents: [{
        runnerRequestId: 1925,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 1925,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      }],
    },
    budgetName,
  );
  const budget = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 0,
        clockMs: CLOCK_MS,
        clockValues: [CLOCK_MS, CLOCK_MS + ALARM_WORK_BUDGET_MS + 1],
      },
    },
    budgetName,
  );

  assert.deepEqual(
    {
      reason: emittedRecord(budget, "dispatch-deferred")?.reason,
      runnerRequestId:
        emittedRecord(budget, "dispatch-deferred")?.runnerRequestId,
    },
    { reason: "reconcile-budget-exhausted", runnerRequestId: 1925 },
  );

  const rowName = "reconcile-row-terminal";
  await listenerRpc(
    worker,
    "seed",
    {
      intents: [1926, 1927].map((runnerRequestId) => ({
        runnerRequestId,
        messageId: 19,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      })),
      outbox: [
        {
          runnerRequestId: 1926,
          state: "reserved",
          reservationId: "reservation-1926",
          updatedAtMs: CLOCK_MS,
        },
        {
          runnerRequestId: 1927,
          state: "pending",
          updatedAtMs: CLOCK_MS + 1,
        },
      ],
    },
    rowName,
  );
  const row = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 0,
        clockMs: CLOCK_MS,
        drainMutationAfterCompensate: { terminal: [1927] },
      },
    },
    rowName,
  );
  const rowDeferred = emittedRecord(row, "dispatch-deferred");

  assert.deepEqual(
    {
      reason: rowDeferred?.reason,
      runnerRequestId: rowDeferred?.runnerRequestId,
      state: rowDeferred?.state,
    },
    {
      reason: "reconcile-row-terminal",
      runnerRequestId: 1927,
      state: "cancelled",
    },
  );
});

test("an expired start deadline compensates without POST /runners", async () => {
  const name = "deadline-before-start";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 2001,
        messageId: 20,
        state: "granted",
        recordedAtMs: CLOCK_MS - START_DEADLINE_MS - 1,
      }],
      outbox: [{
        runnerRequestId: 2001,
        state: "reserved",
        reservationId: "reservation-2001",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.calls.compensate, 1);
  assert.equal(result.snapshot.outbox[0].lastError, "deadline-exceeded");
});

test("a refused reservation replay compensates the durable reservation", async () => {
  const name = "refused-reservation-replay";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 2002,
        messageId: 20,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 2002,
        state: "reserved",
        reservationId: "durable-reservation-2002",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      reserveRefusal: "inactive-wave",
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.compensated, [{
    reason: "inactive-wave",
    reservationId: "durable-reservation-2002",
  }]);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(result.snapshot.outbox[0].lastError, "inactive-wave");
});

test("a replay refuses a changed reservation identity", async () => {
  const name = "changed-reservation-identity";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 2003,
        messageId: 20,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 2003,
        state: "reserved",
        reservationId: "reservation-2003",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      reservationIdsByRunner: {
        2003: "replacement-reservation-2003",
      },
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );
  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.postRunnerIds, []);
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "reservation-identity-changed",
  );
});

test("Q2b: a held reservation keeps its identity across dispatch", async () => {
  const runnerRequestId = 20_031;
  const reservationId = `reservation-${runnerRequestId}`;
  const sameName = "q2b-same-reservation-identity";
  const seed = {
    state: persistedSessionState(),
    intents: [{
      runnerRequestId,
      messageId: 20_031,
      state: "granted",
      recordedAtMs: CLOCK_MS,
    }],
    outbox: [{
      runnerRequestId,
      state: "reserved",
      reservationId,
      updatedAtMs: CLOCK_MS,
    }],
  };
  await listenerRpc(worker, "seed", seed, sameName);

  const replayed = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    sameName,
  );

  assert.equal(replayed.error, null);
  assert.equal(replayed.snapshot.calls.reserve, 1);
  assert.equal(
    emittedRecord(replayed, "runner-reserved").reservationId,
    reservationId,
  );
  assert.equal(replayed.snapshot.outbox[0].reservationId, reservationId);
  assert.notEqual(
    replayed.snapshot.outbox[0].lastError,
    "reservation-identity-changed",
  );

  const changedName = "q2b-changed-reservation-identity";
  await listenerRpc(worker, "seed", seed, changedName);
  const changed = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
      reservationIdsByRunner: {
        [runnerRequestId]: `replacement-${reservationId}`,
      },
    },
    changedName,
  );

  assert.equal(changed.error, null);
  assert.deepEqual(changed.snapshot.postRunnerIds, []);
  assert.deepEqual(changed.snapshot.compensated, [{
    reservationId,
    reason: "reservation-identity-changed",
  }]);
  assert.equal(changed.snapshot.outbox[0].state, "failed");
  assert.equal(
    changed.snapshot.outbox[0].lastError,
    "reservation-identity-changed",
  );
  assert.equal(
    Number.isSafeInteger(changed.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
});

test("Q2c: an expired start-requested row fails on its next pass", async () => {
  const name = "q2c-expired-start-requested";
  const runnerRequestId = 20_032;
  const reservationId = `reservation-${runnerRequestId}`;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId,
        messageId: 20_032,
        state: "granted",
        recordedAtMs: CLOCK_MS - START_DEADLINE_MS - 1,
      }],
      outbox: [{
        runnerRequestId,
        state: "start-requested",
        runnerName: `cloudflare-101-${runnerRequestId}`,
        runnerId: runnerRequestId,
        reservationId,
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.reserve, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId,
    reason: "deadline-exceeded",
  }]);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(result.snapshot.outbox[0].lastError, "deadline-exceeded");
  assert.equal(
    Number.isSafeInteger(result.snapshot.outbox[0].reservationReleasedAtMs),
    true,
  );
});

test("a late start response schedules cleanup for the existing sandbox", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      startAdvanceMs: START_DEADLINE_MS + 1,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(21, [2101]),
      }],
    },
    "deadline-after-start",
  );
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.equal(result.snapshot.calls.scheduleCleanup, 1);
  assert.deepEqual(result.snapshot.scheduledCleanup, ["runner-sandbox-2101"]);
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "deadline-exceeded-after-start",
  );
});

test("a non-success runner start response fails and compensates dispatch", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      startStatus: 503,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(211, [2111]),
      }],
    },
    "non-success-runner-start",
  );
  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.postRunnerIds, [2111]);
  assert.equal(result.snapshot.calls.compensate, 1);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "start-request-failed:503",
  );
  assert.equal(
    emittedRecord(result, "runner-spawn-failed")?.startFailureReason,
    null,
  );
});

test("a thrown start with a registry record emits a reconciled start", async () => {
  const runnerRequestId = 96_001;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_601, [runnerRequestId]),
      }],
      reconciledSandboxId: "runner-reconciled-96001",
      reconciledStart: true,
      startErrors: ["network"],
    },
    "start-response-ambiguous-reconciled",
  );

  const row = result.snapshot.outbox[0];
  const reconciled = emittedRecord(result, "runner-start-reconciled");
  assert.equal(result.error, null);
  assert.equal(row.state, "started");
  assert.equal(row.lastError, null);
  assert.deepEqual({
    runnerRequestId: reconciled?.runnerRequestId,
    registryCorrelation: reconciled?.registryCorrelation,
    runnerName: reconciled?.runnerName,
    runnerId: reconciled?.runnerId,
    sandboxId: reconciled?.sandboxId,
    repository: reconciled?.repository,
    wave: reconciled?.wave,
    reason: reconciled?.reason,
  }, {
    runnerRequestId,
    registryCorrelation: row.correlationId,
    runnerName: row.runnerName,
    runnerId: row.runnerId,
    sandboxId: "runner-reconciled-96001",
    repository: row.repository,
    wave: row.wave,
    reason: "start-response-ambiguous",
  });
  assert.equal(emittedRecords(result, "runner-spawned").length, 0);
  assert.equal(emittedRecords(result, "runner-spawn-failed").length, 0);
});

test("a thrown start without a registry record keeps its failure", async () => {
  const runnerRequestId = 96_002;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_602, [runnerRequestId]),
      }],
      reconciledStart: false,
      startErrors: ["network"],
    },
    "start-response-ambiguous-not-reconciled",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "start-response-ambiguous",
  );
  assert.equal(
    emittedRecord(result, "runner-spawn-failed")?.reason,
    "start-response-ambiguous",
  );
  assert.equal(emittedRecords(result, "runner-start-reconciled").length, 0);
});

test("start-absent reconciliation does not compensate its reservation", async () => {
  const runnerRequestId = 96_020;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_620, [runnerRequestId]),
      }],
      reconciledStart: false,
      startErrors: ["network"],
    },
    "start-absent-compensation-deferred",
  );
  const row = result.snapshot.outbox[0];
  const reconciliation = emittedRecord(
    result,
    "runner-start-reconcile-attempted",
  );

  assert.equal(result.error, null);
  assert.equal(reconciliation.outcome, "start-absent");
  assert.notEqual(row.reservationId, null);
  assert.equal(row.reservationReleasedAtMs, null);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.deepEqual(result.snapshot.compensated, []);
});

test("a late thrown start emits only its deadline failure", async () => {
  const runnerRequestId = 96_003;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_603, [runnerRequestId]),
      }],
      reconciledStart: true,
      startAdvanceMs: START_DEADLINE_MS + 1,
      startErrors: ["network"],
    },
    "late-start-response-ambiguous-reconciled",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "deadline-exceeded-after-start",
  );
  assert.equal(
    emittedRecord(result, "runner-spawn-failed")?.reason,
    "deadline-exceeded-after-start",
  );
  assert.equal(emittedRecords(result, "runner-start-reconciled").length, 0);
});

test("a missing JIT config with a registry record emits reconciliation", async () => {
  const name = "missing-jit-config-reconciled";
  const runnerRequestId = 96_004;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId,
        messageId: 9_604,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId,
        state: "start-requested",
        runnerName: `cloudflare-101-${runnerRequestId}`,
        runnerId: 96_004,
        reservationId: `reservation-${runnerRequestId}`,
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
      reconciledSandboxId: "runner-reconciled-96004",
      reconciledStart: true,
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.outbox[0].state, "started");
  assert.equal(
    emittedRecord(result, "runner-start-reconciled")?.reason,
    "jit-config-missing",
  );
  assert.equal(emittedRecords(result, "runner-spawned").length, 0);
  assert.equal(emittedRecords(result, "runner-spawn-failed").length, 0);
});

test("a missing JIT config without a registry record keeps its failure", async () => {
  const name = "missing-jit-config-not-reconciled";
  const runnerRequestId = 96_005;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId,
        messageId: 9_605,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId,
        state: "start-requested",
        runnerName: `cloudflare-101-${runnerRequestId}`,
        runnerId: 96_005,
        reservationId: `reservation-${runnerRequestId}`,
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
      reconciledStart: false,
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(
    emittedRecord(result, "runner-spawn-failed")?.reason,
    "start-response-ambiguous",
  );
  assert.equal(emittedRecords(result, "runner-start-reconciled").length, 0);
});

test("a reconciled start records a present or absent sandbox identifier", async () => {
  const present = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_606, [96_006]),
      }],
      reconciledSandboxId: "runner-reconciled-96006",
      reconciledStart: true,
      startErrors: ["network"],
    },
    "reconciled-sandbox-present",
  );
  const absent = await listenerRpc(
    worker,
    "alarm",
    {
      omitReconciledSandboxId: true,
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_607, [96_007]),
      }],
      reconciledStart: true,
      startErrors: ["network"],
    },
    "reconciled-sandbox-absent",
  );

  assert.equal(
    emittedRecord(present, "runner-start-reconciled")?.sandboxId,
    "runner-reconciled-96006",
  );
  assert.equal(
    emittedRecord(absent, "runner-start-reconciled")?.sandboxId,
    null,
  );
});

test("a normal successful start emits only runner-spawned", async () => {
  const runnerRequestId = 96_008;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_608, [runnerRequestId]),
      }],
    },
    "normal-start-not-reconciled",
  );

  assert.equal(
    emittedRecord(result, "runner-spawned")?.runnerRequestId,
    runnerRequestId,
  );
  assert.equal(emittedRecords(result, "runner-start-reconciled").length, 0);
});

test("a timely container refusal emits only its 502 start failure", async () => {
  const runnerRequestId = 96_009;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_609, [runnerRequestId]),
      }],
      startReason: "no-container-instance",
      startStatus: 502,
    },
    "timely-container-refusal",
  );

  const failure = emittedRecord(result, "runner-spawn-failed");
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(failure?.reason, "start-request-failed:502");
  assert.equal(failure?.startFailureReason, "no-container-instance");
  assert.equal(emittedRecords(result, "runner-start-reconciled").length, 0);
});

test("two paced reconciled rows emit two records", async () => {
  const runnerRequestIds = [96_010, 96_011];
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(9_610, runnerRequestIds),
        },
        ...pacedNoMessagePolls(1),
      ],
      reconciledStart: true,
      startErrors: ["network", "network"],
    },
    "two-reconciled-starts",
  );

  const reconciled = emittedRecords(result, "runner-start-reconciled");
  assert.equal(reconciled.length, 2);
  assert.deepEqual(
    reconciled.map((record) => record.runnerRequestId).sort((left, right) =>
      left - right
    ),
    runnerRequestIds,
  );
  assert.equal(emittedRecords(result, "runner-spawned").length, 0);
  assert.equal(emittedRecords(result, "runner-spawn-failed").length, 0);
});

test("the reconcile census records a recovered missing JIT path", async () => {
  const name = "reconcile-census-missing-jit-recovered";
  const runnerRequestId = 97_001;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId,
        messageId: 9_701,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId,
        state: "start-requested",
        runnerName: `cloudflare-101-${runnerRequestId}`,
        runnerId: runnerRequestId,
        reservationId: `reservation-${runnerRequestId}`,
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
      reconciledSandboxId: "runner-reconciled-97001",
      reconciledStart: true,
    },
    name,
  );

  const census = emittedRecord(
    result,
    "runner-start-reconcile-attempted",
  );
  assert.equal(result.error, null);
  assert.deepEqual({
    reason: census?.reason,
    outcome: census?.outcome,
    startErrorClass: census?.startErrorClass,
    sandboxId: census?.sandboxId,
  }, {
    reason: "jit-config-missing",
    outcome: "start-recovered",
    startErrorClass: null,
    sandboxId: "runner-reconciled-97001",
  });
});

test("the reconcile census makes an absent missing JIT path readable", async () => {
  const name = "reconcile-census-missing-jit-absent";
  const runnerRequestId = 97_002;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId,
        messageId: 9_702,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId,
        state: "start-requested",
        runnerName: `cloudflare-101-${runnerRequestId}`,
        runnerId: runnerRequestId,
        reservationId: `reservation-${runnerRequestId}`,
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
      reconciledStart: false,
    },
    name,
  );

  const census = emittedRecord(
    result,
    "runner-start-reconcile-attempted",
  );
  assert.deepEqual({
    reason: census?.reason,
    outcome: census?.outcome,
    startErrorClass: census?.startErrorClass,
  }, {
    reason: "jit-config-missing",
    outcome: "start-absent",
    startErrorClass: null,
  });
  assert.equal(
    emittedRecord(result, "runner-spawn-failed")?.reason,
    "start-response-ambiguous",
  );
});

test("the reconcile census records a recovered thrown start", async () => {
  const runnerRequestId = 97_003;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_703, [runnerRequestId]),
      }],
      reconciledStart: true,
      startErrors: ["network"],
    },
    "reconcile-census-thrown-recovered",
  );

  const census = emittedRecords(
    result,
    "runner-start-reconcile-attempted",
  );
  assert.equal(census.length, 1);
  assert.deepEqual({
    reason: census[0]?.reason,
    outcome: census[0]?.outcome,
    startErrorClass: census[0]?.startErrorClass,
  }, {
    reason: "start-response-ambiguous",
    outcome: "start-recovered",
    startErrorClass: "request-failed",
  });
  assert.equal(emittedRecords(result, "runner-start-reconciled").length, 1);
});

test("the reconcile census records an absent thrown start", async () => {
  const runnerRequestId = 97_004;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_704, [runnerRequestId]),
      }],
      reconciledStart: false,
      startErrors: ["network"],
    },
    "reconcile-census-thrown-absent",
  );

  const census = emittedRecord(
    result,
    "runner-start-reconcile-attempted",
  );
  assert.deepEqual({
    reason: census?.reason,
    outcome: census?.outcome,
    startErrorClass: census?.startErrorClass,
  }, {
    reason: "start-response-ambiguous",
    outcome: "start-absent",
    startErrorClass: "request-failed",
  });
});

test("the reconcile census distinguishes a late thrown start", async () => {
  const runnerRequestId = 97_005;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_705, [runnerRequestId]),
      }],
      reconciledStart: true,
      startAdvanceMs: START_DEADLINE_MS + 1,
      startErrors: ["network"],
    },
    "reconcile-census-late-thrown-start",
  );

  const census = emittedRecord(
    result,
    "runner-start-reconcile-attempted",
  );
  assert.deepEqual({
    reason: census?.reason,
    outcome: census?.outcome,
    startErrorClass: census?.startErrorClass,
  }, {
    reason: "start-response-ambiguous",
    outcome: "start-recovered",
    startErrorClass: "request-failed",
  });
  assert.equal(
    emittedRecord(result, "runner-spawn-failed")?.reason,
    "deadline-exceeded-after-start",
  );
  assert.equal(emittedRecords(result, "runner-start-reconciled").length, 0);
});

test("the reconcile census distinguishes a drain deadline path", async () => {
  const name = "reconcile-census-drain-recovered";
  const runnerRequestId = 97_006;
  const recordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      intents: [{
        runnerRequestId,
        messageId: 9_706,
        state: "granted",
        recordedAtMs,
      }],
      outbox: [{
        runnerRequestId,
        state: "start-requested",
        reservationId: `reservation-${runnerRequestId}`,
        updatedAtMs: recordedAtMs,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 1,
        clockMs: CLOCK_MS,
        reconciledSandboxId: "runner-reconciled-drain-97006",
        reconciledStart: true,
      },
    },
    name,
  );

  const census = emittedRecord(
    result,
    "runner-start-reconcile-attempted",
  );
  assert.deepEqual({
    reason: census?.reason,
    outcome: census?.outcome,
    startErrorClass: census?.startErrorClass,
  }, {
    reason: "deadline-exceeded-after-start",
    outcome: "start-recovered",
    startErrorClass: null,
  });
  assert.equal(
    emittedRecord(result, "runner-spawn-failed")?.reason,
    "deadline-exceeded-after-start",
  );
});

test("the reconcile census classifies exhausted start budgets", async () => {
  const runnerRequestId = 97_007;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_707, [runnerRequestId]),
      }],
      // Budget exhaustion occurs before the start request leaves the Worker,
      // so no correlated start can exist.
      reconciledStart: false,
      startErrors: ["budget-exhausted"],
    },
    "reconcile-census-budget-exhausted",
  );

  const census = emittedRecord(
    result,
    "runner-start-reconcile-attempted",
  );
  assert.deepEqual({
    reason: census?.reason,
    outcome: census?.outcome,
    startErrorClass: census?.startErrorClass,
  }, {
    reason: "start-response-ambiguous",
    outcome: "start-absent",
    startErrorClass: "budget-exhausted",
  });
});

test("the reconcile census classifies aborted start requests", async () => {
  const runnerRequestId = 97_008;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_708, [runnerRequestId]),
      }],
      reconciledStart: true,
      startErrors: ["aborted"],
    },
    "reconcile-census-aborted",
  );

  assert.equal(
    emittedRecord(result, "runner-start-reconcile-attempted")
      ?.startErrorClass,
    "aborted",
  );
});

test("the reconcile census is not gated by reconciled delivery emission", async () => {
  const runnerRequestId = 97_009;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_709, [runnerRequestId]),
      }],
      reconciledStart: true,
      startErrors: ["network"],
    },
    "reconcile-census-emit-false",
  );

  assert.equal(
    emittedRecords(result, "runner-start-reconcile-attempted").length,
    1,
  );
});

test("a reconciled clear preserves the durable census reason", async () => {
  const runnerRequestId = 97_010;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_710, [runnerRequestId]),
      }],
      reconciledStart: true,
      startErrors: ["network"],
    },
    "reconcile-census-last-error-clear",
  );

  assert.equal(result.snapshot.outbox[0].lastError, null);
  assert.equal(
    emittedRecord(result, "runner-start-reconcile-attempted")?.reason,
    "start-response-ambiguous",
  );
});

test("the reconcile census fields stay within their closed sets", async () => {
  const missingName = "reconcile-census-closed-set-missing-jit";
  const missingRunnerRequestId = 97_011;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: missingRunnerRequestId,
        messageId: 9_711,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: missingRunnerRequestId,
        state: "start-requested",
        runnerName: `cloudflare-101-${missingRunnerRequestId}`,
        runnerId: missingRunnerRequestId,
        reservationId: `reservation-${missingRunnerRequestId}`,
        updatedAtMs: CLOCK_MS,
      }],
    },
    missingName,
  );
  const missing = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{ outcome: "no-message", advanceMs: 1_000 }],
      reconciledStart: true,
    },
    missingName,
  );

  const absentRunnerRequestId = 97_012;
  const absent = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_712, [absentRunnerRequestId]),
      }],
      reconciledStart: false,
      startErrors: ["network"],
    },
    "reconcile-census-closed-set-absent",
  );

  const budgetRunnerRequestId = 97_013;
  const budget = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_713, [budgetRunnerRequestId]),
      }],
      reconciledStart: false,
      startErrors: ["budget-exhausted"],
    },
    "reconcile-census-closed-set-budget",
  );

  const abortedRunnerRequestId = 97_014;
  const aborted = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_714, [abortedRunnerRequestId]),
      }],
      reconciledStart: true,
      startErrors: ["aborted"],
    },
    "reconcile-census-closed-set-aborted",
  );

  const drainName = "reconcile-census-closed-set-drain";
  const drainRunnerRequestId = 97_015;
  const recordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      intents: [{
        runnerRequestId: drainRunnerRequestId,
        messageId: 9_715,
        state: "granted",
        recordedAtMs,
      }],
      outbox: [{
        runnerRequestId: drainRunnerRequestId,
        state: "start-requested",
        reservationId: `reservation-${drainRunnerRequestId}`,
        updatedAtMs: recordedAtMs,
      }],
    },
    drainName,
  );
  const drain = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 1,
        clockMs: CLOCK_MS,
        reconciledStart: true,
      },
    },
    drainName,
  );

  const records = [missing, absent, budget, aborted, drain].flatMap(
    (result) => emittedRecords(result, "runner-start-reconcile-attempted"),
  );
  const reasons = [
    "jit-config-missing",
    "start-response-ambiguous",
    "deadline-exceeded-after-start",
  ];
  const outcomes = ["start-recovered", "start-absent"];
  const startErrorClasses = [
    "budget-exhausted",
    "aborted",
    "request-failed",
    null,
  ];
  const expectedKeys = [
    "source",
    "event",
    "createdAtMs",
    "scaleSet",
    "scaleSetId",
    "sessionId",
    "messageId",
    "runnerRequestId",
    "registryCorrelation",
    "sandboxId",
    "runnerId",
    "runnerName",
    "workflow",
    "wave",
    "repository",
    "reason",
    "outcome",
    "startErrorClass",
  ].sort();

  assert.equal(records.length, 5);
  for (const record of records) {
    assert.equal(reasons.includes(record.reason), true);
    assert.equal(outcomes.includes(record.outcome), true);
    assert.equal(startErrorClasses.includes(record.startErrorClass), true);
    assert.deepEqual(Object.keys(record).sort(), expectedKeys);
  }
  assert.deepEqual(new Set(records.map((record) => record.reason)),
    new Set(reasons));
  assert.deepEqual(new Set(records.map((record) => record.outcome)),
    new Set(outcomes));
  assert.deepEqual(
    new Set(records.map((record) => record.startErrorClass)),
    new Set(startErrorClasses),
  );
});

test("a failed request is re-admitted from a new assignment message", async () => {
  const runnerRequestId = 91_011;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      startStatuses: [503, 202],
      startReasons: ["no-container-instance", null],
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(9_101, [runnerRequestId]),
        },
        {
          outcome: "message",
          advanceMs: START_PACE_MS * 2,
          message: availableMessage(9_102, [runnerRequestId]),
        },
      ],
    },
    "failed-request-redelivery",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteMessage, 2);
  assert.equal(result.snapshot.calls.acquireJobs, 2);
  assert.equal(result.snapshot.calls.postRunners, 2);
  assert.deepEqual(result.snapshot.postRunnerIds, [
    runnerRequestId,
    runnerRequestId,
  ]);
  assert.deepEqual(result.snapshot.postRunnerCorrelations, [
    `scale-set:101:runner-request:${runnerRequestId}`,
    `scale-set:101:rr1:${runnerRequestId}`,
  ]);
  assert.notEqual(
    result.snapshot.postRunnerCorrelations[0],
    result.snapshot.postRunnerCorrelations[1],
  );
  assert.deepEqual(
    emittedRecords(result, "runner-acquired").map(
      (record) => record.registryCorrelation,
    ),
    result.snapshot.postRunnerCorrelations,
  );
  assert.equal(result.snapshot.outbox[0].state, "started");
  assert.equal(result.snapshot.intents[0].redeliveries, 1);
  assert.equal(
    emittedRecord(result, "runner-spawn-failed")?.startFailureReason,
    "no-container-instance",
  );
  const redelivered = emittedRecord(result, "runner-request-redelivered");
  assert.deepEqual({
    messageId: redelivered?.messageId,
    runnerRequestId: redelivered?.runnerRequestId,
    previousMessageId: redelivered?.previousMessageId,
    redeliveries: redelivered?.redeliveries,
    previousError: redelivered?.previousError,
  }, {
    messageId: 9_102,
    runnerRequestId,
    previousMessageId: 9_101,
    redeliveries: 1,
    previousError: "start-request-failed:503",
  });
});

test("a second request re-admission uses the second dispatch suffix", async () => {
  const runnerRequestId = 91_021;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      startStatuses: [503, 503, 202],
      polls: [9_111, 9_112, 9_113].map((messageId, index) => ({
        outcome: "message",
        advanceMs: index === 0 ? 1_000 : START_PACE_MS,
        message: availableMessage(messageId, [runnerRequestId]),
      })),
    },
    "failed-request-second-redelivery",
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.postRunnerCorrelations, [
    `scale-set:101:runner-request:${runnerRequestId}`,
    `scale-set:101:rr1:${runnerRequestId}`,
    `scale-set:101:rr2:${runnerRequestId}`,
  ]);
  assert.equal(result.snapshot.outbox[0].state, "started");
  assert.equal(result.snapshot.intents[0].redeliveries, 2);
});

test("a started request refuses redelivery without another dispatch", async () => {
  const runnerRequestId = 92_011;
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(9_201, [runnerRequestId]),
        },
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(9_202, [runnerRequestId]),
        },
      ],
    },
    "started-request-redelivery",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteMessage, 2);
  assert.equal(result.snapshot.calls.acquireJobs, 1);
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.deepEqual(result.snapshot.postRunnerIds, [runnerRequestId]);
  assert.equal(result.snapshot.outbox[0].state, "started");
  const refused = emittedRecord(
    result,
    "runner-request-redelivery-refused",
  );
  assert.equal(refused?.runnerRequestId, runnerRequestId);
  assert.equal(refused?.reason, "dispatch-started");
});

test("a request refuses redelivery after GitHub's reassignment bound", async () => {
  const runnerRequestId = 93_011;
  const messageIds = [9_301, 9_302, 9_303, 9_304, 9_305];
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      startStatuses: [503, 503, 503, 503],
      polls: messageIds.map((messageId, index) => ({
        outcome: "message",
        advanceMs: index === 0 ? 1_000 : START_PACE_MS,
        message: availableMessage(messageId, [runnerRequestId]),
      })),
    },
    "request-redelivery-exhausted",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteMessage, 5);
  assert.equal(result.snapshot.calls.acquireJobs, 4);
  assert.equal(result.snapshot.calls.postRunners, 4);
  assert.equal(result.snapshot.intents[0].redeliveries, 3);
  assert.equal(
    emittedRecords(result, "runner-request-redelivered").length,
    3,
  );
  const exhausted = emittedRecord(
    result,
    "runner-request-redelivery-exhausted",
  );
  assert.deepEqual({
    messageId: exhausted?.messageId,
    runnerRequestId: exhausted?.runnerRequestId,
    previousMessageId: exhausted?.previousMessageId,
    redeliveries: exhausted?.redeliveries,
  }, {
    messageId: 9_305,
    runnerRequestId,
    previousMessageId: 9_304,
    redeliveries: 3,
  });
});

test("the same message replay does not create a redelivery decision", async () => {
  const runnerRequestId = 94_011;
  const message = availableMessage(9_401, [runnerRequestId]);
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        { outcome: "message", advanceMs: 1_000, message },
        { outcome: "message", advanceMs: 1_000, message },
      ],
    },
    "same-message-replay",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteMessage, 1);
  assert.equal(result.snapshot.calls.acquireJobs, 1);
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.equal(result.snapshot.intents[0].redeliveries, 0);
  const redeliveryEvents = result.snapshot.emittedRecords
    .map((record) => JSON.parse(record).event)
    .filter((event) => event.startsWith("runner-request-redeliver"));
  assert.deepEqual(redeliveryEvents, []);
});

test("an unreleased failed reservation refuses request redelivery", async () => {
  const name = "unreleased-reservation-redelivery";
  const runnerRequestId = 95_011;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId,
        messageId: 9_501,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId,
        state: "failed",
        reservationId: "reservation-95011",
        lastError: "start-request-failed:503",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(9_502, [runnerRequestId]),
      }],
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteMessage, 1);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(result.snapshot.outbox[0].reservationReleasedAtMs, null);
  const refused = emittedRecord(
    result,
    "runner-request-redelivery-refused",
  );
  assert.equal(refused?.runnerRequestId, runnerRequestId);
  assert.equal(refused?.reason, "reservation-unreleased");
});

test("a late reconciled start schedules cleanup for the existing sandbox", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(22, [2201]),
      }],
      reconciledSandboxId: "runner-reconciled-late",
      reconciledStart: true,
      startAdvanceMs: START_DEADLINE_MS + 1,
      startErrors: ["network"],
    },
    "late-reconciled-start",
  );
  assert.equal(result.snapshot.calls.postRunners, 1);
  assert.equal(result.snapshot.calls.scheduleCleanup, 1);
  assert.deepEqual(
    result.snapshot.scheduledCleanup,
    ["runner-reconciled-late"],
  );
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "deadline-exceeded-after-start",
  );
});

test("lost-start recovery resolves one registry correlation directly", async () => {
  const runnerRequestId = 22_002;
  const correlationId =
    `scale-set:101:runner-request:${runnerRequestId}`;
  const registryResponse = await worker.fetch(
    "/harness/runner-registry/record-starting",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sandboxId: "runner-correlation-point-lookup",
        runnerName: "worker-runner-22002",
        correlationId,
        createdAt: new Date(CLOCK_MS).toISOString(),
        createdAtMs: CLOCK_MS,
      }),
    },
  );
  assert.equal(registryResponse.status, 200, await registryResponse.text());

  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(220, [runnerRequestId]),
      }],
      startErrors: ["network"],
      useRegistryCorrelationLookup: true,
    },
    "direct-correlation-recovery",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.outbox[0].state, "started");
  assert.equal(result.snapshot.outbox[0].lastError, null);
});

test("session conflict deletes a recorded session only for a matching owner", async () => {
  const matchingName = "matching-session-owner";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    matchingName,
  );
  const matching = await listenerRpc(
    worker,
    "alarm",
    {
      forceSessionCreation: true,
      createSessionErrors: [{ type: "conflict", owner: "listener-owner" }],
    },
    matchingName,
  );
  assert.equal(matching.error, null);
  assert.equal(matching.snapshot.calls.deleteSession, 1);
  assert.equal(matching.snapshot.listener.sessionId, null);
  assert.equal(
    matching.snapshot.recoveries[0].nextAttemptAtMs - CLOCK_MS,
    2_000,
  );

  const otherName = "different-session-owner";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    otherName,
  );
  const different = await listenerRpc(
    worker,
    "alarm",
    {
      forceSessionCreation: true,
      createSessionErrors: [{ type: "conflict", owner: "another-owner" }],
    },
    otherName,
  );
  assert.equal(different.error, null);
  assert.equal(different.snapshot.calls.deleteSession, 0);
  assert.equal(different.snapshot.listener.sessionId, SESSION_ID);
});

test("graceful stop deletes its persisted message session", async () => {
  const name = "shutdown-graceful-stop";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "stop",
      input: { reason: "operator maintenance" },
    },
    name,
  );
  assert.equal(result.snapshot.calls.deleteSession, 1);
  assert.equal(result.snapshot.listener.sessionId, null);
  assert.equal(result.result.advertisedMaxCapacity, 0);
});

test("a kill-switch transition deletes its persisted message session", async () => {
  const name = "shutdown-kill-switch";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    { controlClosed: true },
    name,
  );
  assert.equal(result.result.outcome, "kill-switch");
  assert.equal(result.snapshot.calls.deleteSession, 1);
  assert.equal(result.snapshot.listener.sessionId, null);
});

test("zero capacity triggers the kill switch while the gate stays open", async () => {
  const name = "zero-capacity-kill-switch";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    { controlGate: "open", maxCapacity: 0 },
    name,
  );
  assert.equal(result.result.outcome, "kill-switch");
  assert.equal(result.snapshot.calls.deleteSession, 1);
});

test("the poll advertises no more than MAX_ACTIVE_RUNNERS", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      controlGate: "open",
      maxCapacity: MAX_ACTIVE_RUNNERS + 1,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    "advertised-capacity-clamp",
  );
  assert.equal(result.error, null);
  assert.deepEqual(result.snapshot.advertisedCapacities, [
    MAX_ACTIVE_RUNNERS,
  ]);
});

test("listener status clamps to a lower control capacity", async () => {
  const approvedCapacity = MAX_ACTIVE_RUNNERS - 1;
  const status = await listenerStatusRoute(
    worker,
    { maxCapacity: approvedCapacity },
    "status-lower-control-capacity",
  );

  assert.equal(status.enabled, true);
  assert.equal(status.configured, true);
  assert.equal(status.mode, "running");
  assert.equal(status.advertisedMaxCapacity, approvedCapacity);
  assert.equal(status.controlStatusReadFailed, false);
});

test("listener status fails closed for invalid control capacity", async () => {
  const missing = await listenerStatusRoute(
    worker,
    { controlStatusMissingMaxCapacity: true },
    "status-missing-control-capacity",
  );
  const nonFinite = await listenerStatusRoute(
    worker,
    { controlStatusNonFiniteMaxCapacity: true },
    "status-non-finite-control-capacity",
  );

  assert.equal(missing.advertisedMaxCapacity, 0);
  assert.equal(missing.controlStatusReadFailed, false);
  assert.equal(nonFinite.advertisedMaxCapacity, 0);
  assert.equal(nonFinite.controlStatusReadFailed, false);
});

test("listener status returns a fail-closed payload after a control read failure", async () => {
  const status = await listenerStatusRoute(
    worker,
    { controlStatusError: "simulated control status failure" },
    "status-control-read-failure",
  );

  assert.equal(status.scaleSet, "example-scale-set");
  assert.equal(status.mode, "running");
  assert.equal(status.advertisedMaxCapacity, 0);
  assert.equal(status.controlStatusReadFailed, true);
  assert.deepEqual(status.liveIntents, []);
  assert.deepEqual(status.recoveries, []);
  assert.deepEqual(status.quarantinedMessages, []);
});

test("a terminal session authentication failure deletes its session", async () => {
  const name = "shutdown-terminal-auth";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ cursor: 31 }) },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{ error: "401" }, { error: "401" }],
    },
    name,
  );
  assert.equal(result.error, null);
  assert.match(result.result.failure, /failed authentication twice/u);
  assert.equal(result.snapshot.calls.poll, 2);
  assert.equal(result.snapshot.calls.refreshSession, 1);
  assert.equal(result.snapshot.calls.deleteSession, 1);
  assert.deepEqual(
    result.snapshot.events.filter((event) => event.startsWith("poll:")),
    ["poll:31", "poll:31"],
  );
  assert.equal(result.snapshot.listener.sessionId, null);
});

test("an expired refreshed session is dropped and re-created", async () => {
  const name = "expired-refreshed-session-recovery";
  const replacementSessionId = "22222222-2222-4222-8222-222222222222";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ cursor: 31 }) },
    name,
  );

  const expired = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ error: "401" }],
      refreshErrors: ["session-expired"],
    },
    name,
  );

  assert.equal(expired.error, null);
  assert.equal(expired.result.outcome, "recovery-deferred");
  assert.equal(expired.result.generation, 1);
  assert.equal(expired.snapshot.listener.mode, "running");
  assert.equal(expired.snapshot.listener.sessionId, null);
  assert.equal(expired.snapshot.calls.deleteSession, 0);
  assert.equal(expired.snapshot.recoveries[0].condition, "session-expired");
  assert.equal(
    expired.snapshot.scheduledAlarm,
    CLOCK_MS + RECOVERY_BASE_DELAY_MS,
  );
  const expiration = emittedRecord(expired, "message-session-expired");
  assert.equal(expiration.operation, "GetMessage");
  assert.equal(expiration.sessionId, SESSION_ID);
  assert.match(expiration.error, /RunnerScaleSetSessionExpiredException/u);
  assert.equal(emittedRecords(expired, "listener-alarm-failed").length, 0);

  const recreated = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: expired.snapshot.scheduledAlarm,
      createdSession: {
        sessionId: replacementSessionId,
        messageQueueUrl: "https://queue.stub.test/replacement",
        messageQueueAccessToken: "literal-replacement-session-token-secret",
      },
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    name,
  );

  assert.equal(recreated.error, null);
  assert.equal(recreated.result.outcome, "handoff");
  assert.equal(recreated.snapshot.calls.createSession, 1);
  assert.equal(recreated.snapshot.listener.sessionId, replacementSessionId);
  assert.equal(recreated.snapshot.listener.mode, "running");
  assert.equal(Number.isFinite(recreated.snapshot.scheduledAlarm), true);
  assert.deepEqual(recreated.snapshot.recoveries, []);
});

test("an expired first poll attempt is dropped and re-created", async () => {
  const name = "expired-first-poll-session-recovery";
  const replacementSessionId = "33333333-3333-4333-8333-333333333333";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ cursor: 31 }) },
    name,
  );

  const expired = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ error: "session-expired" }],
    },
    name,
  );

  assert.equal(expired.error, null);
  assert.equal(expired.result.outcome, "recovery-deferred");
  assert.equal(expired.result.generation, 1);
  assert.equal(expired.snapshot.listener.mode, "running");
  assert.equal(expired.snapshot.listener.sessionId, null);
  assert.equal(expired.snapshot.calls.poll, 1);
  assert.equal(expired.snapshot.calls.refreshSession, 0);
  assert.equal(expired.snapshot.calls.deleteSession, 0);
  assert.equal(expired.snapshot.recoveries[0].condition, "session-expired");
  assert.equal(
    expired.snapshot.scheduledAlarm,
    CLOCK_MS + RECOVERY_BASE_DELAY_MS,
  );
  const expiration = emittedRecord(expired, "message-session-expired");
  assert.equal(expiration.operation, "GetMessage");
  assert.equal(expiration.sessionId, SESSION_ID);
  assert.match(expiration.error, /RunnerScaleSetSessionExpiredException/u);
  assert.equal(emittedRecords(expired, "listener-alarm-failed").length, 0);

  const recreated = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: expired.snapshot.scheduledAlarm,
      createdSession: {
        sessionId: replacementSessionId,
        messageQueueUrl: "https://queue.stub.test/replacement",
        messageQueueAccessToken: "literal-replacement-session-token-secret",
      },
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    name,
  );

  assert.equal(recreated.error, null);
  assert.equal(recreated.result.outcome, "handoff");
  assert.equal(recreated.snapshot.calls.createSession, 1);
  assert.equal(recreated.snapshot.listener.sessionId, replacementSessionId);
  assert.equal(recreated.snapshot.listener.mode, "running");
  assert.equal(Number.isFinite(recreated.snapshot.scheduledAlarm), true);
  assert.deepEqual(recreated.snapshot.recoveries, []);
});

test("an expired second poll attempt is dropped and re-created", async () => {
  const name = "expired-second-poll-session-recovery";
  const replacementSessionId = "44444444-4444-4444-8444-444444444444";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ cursor: 31 }) },
    name,
  );

  const expired = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ error: "401" }, { error: "session-expired" }],
    },
    name,
  );

  assert.equal(expired.error, null);
  assert.equal(expired.result.outcome, "recovery-deferred");
  assert.equal(expired.result.generation, 1);
  assert.equal(expired.snapshot.listener.mode, "running");
  assert.equal(expired.snapshot.listener.sessionId, null);
  assert.equal(expired.snapshot.calls.poll, 2);
  assert.equal(expired.snapshot.calls.refreshSession, 1);
  assert.equal(expired.snapshot.calls.deleteSession, 0);
  assert.equal(expired.snapshot.recoveries[0].condition, "session-expired");
  assert.equal(
    expired.snapshot.scheduledAlarm,
    CLOCK_MS + RECOVERY_BASE_DELAY_MS,
  );
  const expiration = emittedRecord(expired, "message-session-expired");
  assert.equal(expiration.operation, "GetMessage");
  assert.equal(expiration.sessionId, SESSION_ID);
  assert.match(expiration.error, /RunnerScaleSetSessionExpiredException/u);
  assert.equal(emittedRecords(expired, "listener-alarm-failed").length, 0);

  const recreated = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: expired.snapshot.scheduledAlarm,
      createdSession: {
        sessionId: replacementSessionId,
        messageQueueUrl: "https://queue.stub.test/replacement",
        messageQueueAccessToken: "literal-replacement-session-token-secret",
      },
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    name,
  );

  assert.equal(recreated.error, null);
  assert.equal(recreated.result.outcome, "handoff");
  assert.equal(recreated.snapshot.calls.createSession, 1);
  assert.equal(recreated.snapshot.listener.sessionId, replacementSessionId);
  assert.equal(recreated.snapshot.listener.mode, "running");
  assert.equal(Number.isFinite(recreated.snapshot.scheduledAlarm), true);
  assert.deepEqual(recreated.snapshot.recoveries, []);
});

test("session replacement deletes the partial persisted session first", async () => {
  const name = "shutdown-session-replacement";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        sessionQueueToken: null,
        sessionQueueUrl: null,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    { polls: [{ outcome: "no-message", advanceMs: 1_000 }] },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteSession, 1);
  assert.equal(result.snapshot.calls.createSession, 1);
  assert.equal(result.snapshot.listener.sessionId, SESSION_ID);
  assert.ok(
    result.snapshot.events.indexOf(`delete-session:${SESSION_ID}`) <
      result.snapshot.events.indexOf("create-session"),
  );
});

test("an abandoning alarm failure deletes its persisted session", async () => {
  const name = "shutdown-alarm-failure";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    { polls: [{ error: "fatal-poll-failure" }] },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "alarm-failed");
  assert.match(result.result.failure, /fatal-poll-failure/u);
  assert.equal(result.snapshot.calls.deleteSession, 1);
  assert.equal(result.snapshot.listener.sessionId, null);
});

test(
  "an unexpected GitHub status commits its backoff alarm and full failure chain",
  async () => {
    const failureUrl = "https://actions.stub.test/tenant/sessions/unexpected";
    const responseSnippet = "unexpected GitHub response body";
    const result = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs: CLOCK_MS,
        polls: [{
          error: {
            type: "request",
            message: "stub unexpected GitHub status",
            status: 418,
            method: "PATCH",
            url: failureUrl,
            responseSnippet,
          },
        }],
      },
      "unexpected-status-durable-backoff",
    );

    assert.equal(result.error, null);
    assert.equal(result.result.outcome, "alarm-failed");
    assert.equal(result.result.condition, "alarm-failure");
    assert.equal(result.snapshot.listener.mode, "running");
    assert.equal(result.snapshot.listener.stoppedReason, null);
    assert.equal(result.snapshot.calls.closeGate, 0);
    assert.equal(result.snapshot.recoveries[0].attempts, 1);
    assert.equal(
      result.snapshot.recoveries[0].nextAttemptAtMs,
      CLOCK_MS + RECOVERY_BASE_DELAY_MS,
    );
    assert.equal(
      result.snapshot.scheduledAlarm,
      result.snapshot.recoveries[0].nextAttemptAtMs,
    );
    const alarmFailure = emittedRecord(result, "listener-alarm-failed");
    for (const expected of [
      "ScaleSetRequestError: stub unexpected GitHub status",
      "status: 418",
      "method: PATCH",
      `url: ${failureUrl}`,
      `responseSnippet: ${responseSnippet}`,
    ]) {
      assert.match(alarmFailure.error, new RegExp(expected, "u"));
      assert.match(result.result.failure, new RegExp(expected, "u"));
    }
  },
);

test(
  "a recovery bookkeeping failure uses the last-resort bounded alarm",
  async () => {
    const result = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs: CLOCK_MS,
        createSessionErrors: ["stub alarm failure"],
        failRecoveryBookkeeping: true,
      },
      "last-resort-recovery-alarm",
    );

    assert.equal(result.error, null);
    assert.equal(result.result.outcome, "alarm-failed");
    assert.equal(result.result.lastResort, true);
    assert.match(result.result.failure, /stub alarm failure/u);
    assert.match(
      result.result.recoveryFailure,
      /stub recovery bookkeeping failed/u,
    );
    assert.equal(result.snapshot.listener.mode, "running");
    assert.deepEqual(result.snapshot.recoveries, []);
    assert.equal(
      result.snapshot.scheduledAlarm,
      CLOCK_MS + RECOVERY_BASE_DELAY_MS,
    );
    const fallback = result.snapshot.logs
      .map((record) => JSON.parse(record))
      .find((record) =>
        record.event === "alarm-failure-last-resort-rearmed"
      );
    assert.equal(fallback.consecutive, 1);
    assert.equal(fallback.pauseMs, RECOVERY_BASE_DELAY_MS);
    assert.match(fallback.recoveryError, /stub recovery bookkeeping failed/u);
  },
);

test(
  "consecutive last-resort re-arms back off, cap, and reset after success",
  async () => {
    const name = "last-resort-recovery-backoff";
    const expectedDelays = [
      RECOVERY_BASE_DELAY_MS,
      RECOVERY_BASE_DELAY_MS * 2,
      RECOVERY_BASE_DELAY_MS * 4,
      RECOVERY_BASE_DELAY_MS * 8,
      RECOVERY_BASE_DELAY_MS * 16,
      RECOVERY_MAX_DELAY_MS,
      RECOVERY_MAX_DELAY_MS,
    ];
    let clockMs = CLOCK_MS;

    for (const [index, expectedDelay] of expectedDelays.entries()) {
      const result = await listenerRpc(
        worker,
        "alarm",
        {
          clockMs,
          createSessionErrors: ["stub alarm failure"],
          failRecoveryBookkeeping: index === 0,
        },
        name,
      );
      const fallback = result.snapshot.logs
        .map((record) => JSON.parse(record))
        .find((record) =>
          record.event === "alarm-failure-last-resort-rearmed"
        );

      assert.equal(result.error, null);
      assert.equal(result.result.lastResort, true);
      assert.equal(fallback.consecutive, index + 1);
      assert.equal(fallback.pauseMs, expectedDelay);
      assert.equal(result.snapshot.scheduledAlarm - clockMs, expectedDelay);
      clockMs = result.snapshot.scheduledAlarm;
    }

    const successful = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs,
        polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
      },
      name,
    );
    assert.equal(successful.error, null);
    assert.equal(successful.result.outcome, "handoff");

    const resetFailureAtMs = clockMs + 890_000;
    const resetFailure = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs: resetFailureAtMs,
        polls: [{ error: "stub alarm failure" }],
      },
      name,
    );
    const fallback = resetFailure.snapshot.logs
      .map((record) => JSON.parse(record))
      .find((record) =>
        record.event === "alarm-failure-last-resort-rearmed"
      );

    assert.equal(resetFailure.error, null);
    assert.equal(resetFailure.result.lastResort, true);
    assert.equal(fallback.consecutive, 1);
    assert.equal(fallback.pauseMs, RECOVERY_BASE_DELAY_MS);
    assert.equal(
      resetFailure.snapshot.scheduledAlarm - resetFailureAtMs,
      RECOVERY_BASE_DELAY_MS,
    );
  },
);

test("a GitHub 5xx stays transient on its first occurrence", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ error: "500" }],
    },
    "github-5xx-transient-recovery",
  );

  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "alarm-failed");
  assert.equal(result.result.failureName, "ScaleSetRequestError");
  assert.equal(result.result.failureStatus, 500);
  assert.equal(result.snapshot.listener.mode, "running");
  assert.equal(result.snapshot.listener.stoppedReason, null);
  assert.equal(result.snapshot.recoveries[0].attempts, 1);
  assert.equal(
    result.snapshot.scheduledAlarm,
    CLOCK_MS + RECOVERY_BASE_DELAY_MS,
  );
  assert.equal(emittedRecords(result, "recovery-exhausted").length, 0);
});

test(
  "the alarm exit invariant repairs live modes and preserves deliberate deletes",
  async () => {
    const running = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs: CLOCK_MS,
        dropAlarmAfterEntry: true,
        polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
      },
      "running-alarm-exit-invariant",
    );
    assert.equal(running.error, null);
    assert.equal(running.snapshot.listener.mode, "running");
    assert.equal(running.result.alarmInvariantRepaired, true);
    assert.equal(
      running.snapshot.scheduledAlarm,
      CLOCK_MS + 890_000 + RECOVERY_BASE_DELAY_MS,
    );
    assert.ok(emittedRecord(running, "listener-alarm-invariant-repaired"));

    const drainedName = "drained-alarm-exit-invariant";
    await listenerRpc(
      worker,
      "seed",
      { state: persistedSessionState({ mode: "drained" }) },
      drainedName,
    );
    const drained = await listenerRpc(
      worker,
      "alarm",
      { clockMs: CLOCK_MS },
      drainedName,
    );
    assert.equal(drained.result.drained, true);
    assert.equal(drained.snapshot.listener.mode, "drained");
    assert.equal(drained.result.alarmInvariantRepaired, true);
    assert.equal(
      drained.snapshot.scheduledAlarm,
      CLOCK_MS + DRAIN_RUNNER_RECHECK_MS,
    );
    assert.ok(emittedRecord(drained, "listener-alarm-invariant-repaired"));

    const stoppedCases = [
      {
        name: "deliberately-stopped-alarm-exit",
        target: worker,
        state: persistedSessionState({
          mode: "stopped",
          stoppedReason: "deliberate:operator stop",
        }),
        expectedOutcome: "deliberately-stopped",
        specification: {},
      },
      {
        name: "failure-stopped-alarm-exit",
        target: worker,
        state: persistedSessionState({
          mode: "stopped",
          stoppedReason: "failure:test failure",
        }),
        expectedOutcome: "stopped-by-failure",
        specification: {},
      },
      {
        name: "disabled-alarm-exit",
        target: disabledWorker,
        state: null,
        expectedOutcome: "disabled",
        specification: {},
      },
      {
        name: "kill-switch-alarm-exit",
        target: worker,
        state: null,
        expectedOutcome: "kill-switch",
        specification: { controlClosed: true },
      },
    ];
    for (const scenario of stoppedCases) {
      if (scenario.state !== null) {
        await listenerRpc(
          scenario.target,
          "seed",
          { state: scenario.state },
          scenario.name,
        );
      }
      const stopped = await listenerRpc(
        scenario.target,
        "alarm",
        { clockMs: CLOCK_MS, ...scenario.specification },
        scenario.name,
      );
      assert.equal(stopped.error, null, scenario.name);
      assert.equal(
        stopped.result.outcome,
        scenario.expectedOutcome,
        scenario.name,
      );
      assert.equal(stopped.snapshot.scheduledAlarm, null, scenario.name);
    }
  },
);

test(
  "consecutive alarm invariant repairs back off, cap, and preserve the drained floor",
  async () => {
    const expectedDelays = [
      RECOVERY_BASE_DELAY_MS,
      RECOVERY_BASE_DELAY_MS * 2,
      RECOVERY_BASE_DELAY_MS * 4,
      RECOVERY_BASE_DELAY_MS * 8,
      RECOVERY_BASE_DELAY_MS * 16,
      RECOVERY_MAX_DELAY_MS,
      RECOVERY_MAX_DELAY_MS,
    ];
    let clockMs = CLOCK_MS;

    for (const [index, expectedDelay] of expectedDelays.entries()) {
      const result = await listenerRpc(
        worker,
        "alarm",
        {
          clockMs,
          dropAlarmAfterEntry: true,
          polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
        },
        "running-alarm-invariant-backoff",
      );
      const repair = emittedRecord(
        result,
        "listener-alarm-invariant-repaired",
      );
      const repairAtMs = clockMs + 890_000;

      assert.equal(result.error, null);
      assert.equal(result.result.alarmInvariantRepaired, true);
      assert.equal(repair.consecutive, index + 1);
      assert.equal(repair.pauseMs, expectedDelay);
      assert.equal(
        result.snapshot.scheduledAlarm - repairAtMs,
        expectedDelay,
      );
      clockMs = result.snapshot.scheduledAlarm;
    }

    const drainedName = "drained-alarm-invariant-backoff";
    await listenerRpc(
      worker,
      "seed",
      { state: persistedSessionState({ mode: "drained" }) },
      drainedName,
    );
    const drainedDelays = [
      DRAIN_RUNNER_RECHECK_MS,
      DRAIN_RUNNER_RECHECK_MS,
      RECOVERY_BASE_DELAY_MS * 4,
    ];
    clockMs = CLOCK_MS;

    for (const [index, expectedDelay] of drainedDelays.entries()) {
      const result = await listenerRpc(
        worker,
        "alarm",
        { clockMs },
        drainedName,
      );
      const repair = emittedRecord(
        result,
        "listener-alarm-invariant-repaired",
      );

      assert.equal(result.error, null);
      assert.equal(result.result.alarmInvariantRepaired, true);
      assert.equal(repair.consecutive, index + 1);
      assert.equal(repair.pauseMs, expectedDelay);
      assert.ok(expectedDelay >= DRAIN_RUNNER_RECHECK_MS);
      assert.equal(result.snapshot.scheduledAlarm - clockMs, expectedDelay);
      clockMs = result.snapshot.scheduledAlarm;
    }
  },
);

test("consecutive alarm failures use increasing recovery delays", async () => {
  const name = "alarm-failure-backoff";
  const first = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      createSessionErrors: ["fatal-alarm-failure"],
    },
    name,
  );
  const firstRecovery = first.snapshot.recoveries[0];

  assert.equal(first.error, null);
  assert.equal(first.result.outcome, "alarm-failed");
  assert.match(first.result.failure, /fatal-alarm-failure/u);
  assert.equal(firstRecovery.condition, "alarm-failure");
  assert.ok(first.snapshot.scheduledAlarm >= CLOCK_MS + RECOVERY_BASE_DELAY_MS);

  const second = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: first.snapshot.scheduledAlarm,
      createSessionErrors: ["fatal-alarm-failure"],
    },
    name,
  );
  const secondRecovery = second.snapshot.recoveries[0];
  const firstDelayMs = firstRecovery.nextAttemptAtMs - CLOCK_MS;
  const secondDelayMs = secondRecovery.nextAttemptAtMs -
    first.snapshot.scheduledAlarm;

  assert.equal(second.error, null);
  assert.equal(second.result.outcome, "alarm-failed");
  assert.ok(secondDelayMs > firstDelayMs);
  assert.equal(second.snapshot.scheduledAlarm, secondRecovery.nextAttemptAtMs);
});

test(
  "alarm failure recovery uses the exact bounded schedule and exhausts loudly",
  async () => {
    const name = "alarm-failure-exhaustion";
    const expectedDelays = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
    assert.equal(expectedDelays.length, RECOVERY_MAX_ATTEMPTS);
    let clockMs = CLOCK_MS;
    let result;

    for (const [attempt, expectedDelay] of expectedDelays.entries()) {
      result = await listenerRpc(
        worker,
        "alarm",
        {
          clockMs,
          createSessionErrors: ["fatal-alarm-failure"],
        },
        name,
      );
      const recovery = result.snapshot.recoveries[0];
      assert.equal(result.error, null);
      assert.equal(recovery.attempts, attempt + 1);
      assert.equal(recovery.nextAttemptAtMs - clockMs, expectedDelay);
      assert.equal(
        result.snapshot.alarmTimes.includes(clockMs + expectedDelay),
        true,
      );
      if (attempt < expectedDelays.length - 1) {
        assert.equal(result.result.outcome, "alarm-failed");
        assert.equal(result.snapshot.listener.mode, "running");
        assert.equal(result.snapshot.scheduledAlarm, recovery.nextAttemptAtMs);
        assert.equal(recovery.exhaustedMarker, null);
      }
      clockMs = recovery.nextAttemptAtMs;
    }

    assert.equal(result.result.outcome, "recovery-exhausted");
    assert.match(result.result.failure, /fatal-alarm-failure/u);
    assert.equal(
      result.snapshot.recoveries[0].attempts,
      RECOVERY_MAX_ATTEMPTS,
    );
    assert.equal(
      result.snapshot.recoveries[0].exhaustedMarker,
      "alarm-failure-recovery-exhausted",
    );
    assert.equal(result.snapshot.listener.mode, "stopped");
    assert.equal(
      result.snapshot.listener.stoppedReason,
      "failure:alarm-failure-recovery-exhausted",
    );
    assert.equal(result.snapshot.calls.closeGate, 1);
    assert.equal(result.snapshot.scheduledAlarm, null);
    assert.ok(emittedRecord(result, "recovery-exhausted"));
  },
);

test("a successful alarm resets alarm failure recovery", async () => {
  const name = "alarm-failure-reset";
  const first = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      createSessionErrors: ["fatal-alarm-failure"],
    },
    name,
  );
  const successStartMs = first.snapshot.scheduledAlarm;
  const successful = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: successStartMs,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    name,
  );

  assert.equal(successful.error, null);
  assert.equal(successful.result.outcome, "handoff");
  assert.deepEqual(successful.snapshot.recoveries, []);

  const nextFailureAtMs = successStartMs + 890_000;
  const nextFailure = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: nextFailureAtMs,
      polls: [{ error: "fatal-alarm-failure" }],
    },
    name,
  );

  assert.equal(nextFailure.error, null);
  assert.equal(nextFailure.result.outcome, "alarm-failed");
  assert.match(nextFailure.result.failure, /fatal-alarm-failure/u);
  assert.equal(nextFailure.snapshot.recoveries[0].attempts, 1);
  assert.equal(
    nextFailure.snapshot.scheduledAlarm - nextFailureAtMs,
    RECOVERY_BASE_DELAY_MS,
  );
});

test("a malformed created session is persisted before cleanup", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      createdSession: {
        sessionId: SESSION_ID,
        messageQueueUrl: null,
        messageQueueAccessToken: null,
      },
    },
    "malformed-created-session",
  );
  assert.equal(result.error, null);
  assert.match(
    result.result.failure,
    /The message session response is invalid/u,
  );
  assert.equal(result.snapshot.calls.createSession, 1);
  assert.equal(result.snapshot.calls.deleteSession, 1);
  assert.equal(result.snapshot.listener.sessionId, null);
});

test("a 401 refreshes and retries the same acknowledgement once", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      deleteMessageErrors: ["401", null],
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(32, [3201]),
      }],
    },
    "refresh-delete-message",
  );
  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteMessage, 2);
  assert.equal(result.snapshot.calls.refreshSession, 1);
  assert.equal(result.snapshot.listener.cursor, 32);
  assert.deepEqual(result.snapshot.postRunnerIds, [3201]);
});

test("a 401 refreshes and retries the same poll once", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        { error: "401" },
        { outcome: "poll-aborted", advanceMs: 890_000 },
      ],
    },
    "refresh-get-message",
  );
  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.poll, 2);
  assert.equal(result.snapshot.calls.refreshSession, 1);
  assert.deepEqual(
    result.snapshot.events.filter((event) => event.startsWith("poll:")),
    ["poll:0", "poll:0"],
  );
});

test("a 401 refreshes and retries the same acquisition once", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      acquireErrors: ["401", null],
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: availableMessage(33, [3301]),
      }],
    },
    "refresh-acquire-jobs",
  );
  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.acquireJobs, 2);
  assert.equal(result.snapshot.calls.refreshSession, 1);
  assert.deepEqual(
    result.snapshot.events.filter((event) => event.startsWith("acquire:")),
    ["acquire:3301", "acquire:3301"],
  );
  assert.deepEqual(result.snapshot.postRunnerIds, [3301]);
});

test("bounded recovery exhausts on the sixth cumulative failure", async () => {
  const name = "bounded-recovery-exhaustion";
  const attemptTimes = [
    CLOCK_MS,
    CLOCK_MS + 2_000,
    CLOCK_MS + 6_000,
    CLOCK_MS + 14_000,
    CLOCK_MS + 30_000,
    CLOCK_MS + 62_000,
  ];
  let result;
  for (const clockMs of attemptTimes) {
    result = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs,
        createSessionErrors: [{
          type: "conflict",
          owner: "another-owner",
        }],
      },
      name,
    );
  }
  assert.equal(result.snapshot.recoveries[0].attempts, 6);
  assert.equal(
    result.snapshot.recoveries[0].exhaustedMarker,
    "session-reclaim-exhausted",
  );
  assert.equal(result.snapshot.listener.mode, "stopped");
  assert.equal(result.snapshot.calls.closeGate, 1);
  const status = await listenerRpc(worker, "reconstruct", {}, name);
  assert.equal(
    status.startGate.lastClosedReason,
    "session-reclaim-exhausted",
  );
  assert.equal(status.startGate.lastClosedAtMs, CLOCK_MS + 62_000);
});

test("one scale set exhaustion closes only the external gate", async () => {
  const listenerName = "external-gate-blast-radius";
  const controlName = `shared-control-${RUN_PREFIX}`;
  const closeUrl = "https://runner-host.stub.test/outage-gate/close";
  const attemptTimes = [
    CLOCK_MS,
    CLOCK_MS + 2_000,
    CLOCK_MS + 6_000,
    CLOCK_MS + 14_000,
    CLOCK_MS + 30_000,
    CLOCK_MS + 62_000,
  ];
  await autopilotControlRpc(worker, controlName, "setActiveWave", {
    wave: "wave-1",
  });
  assert.equal(
    (await approveCapacity(worker, controlName, 1)).recorded,
    true,
  );
  let exhausted;
  for (const clockMs of attemptTimes) {
    exhausted = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs,
        config: { outageGateCloseUrl: closeUrl },
        controlName,
        createSessionErrors: [{
          type: "conflict",
          owner: "another-owner",
        }],
        useProductionGateClose: true,
      },
      listenerName,
    );
  }
  assert.equal(exhausted.error, null);
  assert.equal(exhausted.snapshot.calls.localGateClose, 0);
  assert.equal(exhausted.snapshot.calls.closeGate, 1);
  assert.equal(exhausted.snapshot.outageGateCloseRequests.length, 1);
  assert.deepEqual(exhausted.snapshot.outageGateCloseRequests[0], {
    body: {
      action: "close",
      closedAtMs: CLOCK_MS + 62_000,
      reason: "session-reclaim-exhausted",
      scaleSetId: 101,
      scaleSetName: "example-scale-set",
    },
    headers: {
      authorization: `Bearer ${OUTAGE_GATE_TOKEN}`,
      "content-type": "application/json",
    },
    method: "POST",
    signalPresent: true,
    url: closeUrl,
  });
  const controlStatus = await autopilotControlRpc(
    worker,
    controlName,
    "status",
  );
  assert.equal(controlStatus.localGate, "open");

  const other = await listenerRpc(
    worker,
    "alarm",
    {
      controlName,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    "external-gate-unaffected-listener",
  );
  assert.equal(other.error, null);
  assert.notEqual(other.result.outcome, "kill-switch");
});

test("an external gate close failure is durable and loud", async () => {
  const name = "external-gate-close-failure";
  const attemptTimes = [
    CLOCK_MS,
    CLOCK_MS + 2_000,
    CLOCK_MS + 6_000,
    CLOCK_MS + 14_000,
    CLOCK_MS + 30_000,
    CLOCK_MS + 62_000,
  ];
  let exhausted;
  for (const clockMs of attemptTimes) {
    exhausted = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs,
        createSessionErrors: [{
          type: "conflict",
          owner: "another-owner",
        }],
        outageGateCloseError: "runner-host unavailable",
        useProductionGateClose: true,
      },
      name,
    );
  }
  assert.equal(exhausted.error, null);
  assert.equal(exhausted.result.outcome, "alarm-failed");
  assert.match(exhausted.result.failure, /external start gate/u);
  assert.equal(exhausted.snapshot.listener.mode, "running");
  assert.equal(Number.isFinite(exhausted.snapshot.scheduledAlarm), true);
  const events = exhausted.snapshot.exportRecords.map(
    (row) => JSON.parse(row.record).event,
  );
  assert.ok(events.includes("start-gate-close-failed"));
  const status = await listenerRpc(worker, "reconstruct", {}, name);
  assert.equal(status.startGate.lastClosedReason, null);
  assert.equal(status.startGate.lastClosedAtMs, null);
});

test("recovery exhaustion deletes its live message session", async () => {
  const name = "bounded-recovery-session-cleanup";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  const attemptTimes = [
    CLOCK_MS,
    CLOCK_MS + 2_000,
    CLOCK_MS + 6_000,
    CLOCK_MS + 14_000,
    CLOCK_MS + 30_000,
    CLOCK_MS + 62_000,
  ];
  let result;
  for (const clockMs of attemptTimes) {
    result = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs,
        forceSessionCreation: true,
        createSessionErrors: [{
          type: "conflict",
          owner: "another-owner",
        }],
      },
      name,
    );
  }
  assert.equal(result.snapshot.listener.mode, "stopped");
  assert.equal(result.snapshot.calls.deleteSession, 1);
  assert.equal(result.snapshot.listener.sessionId, null);
});

test("stopped and disabled alarm exits delete live sessions", async () => {
  const cases = [
    {
      name: "stopped-session-cleanup",
      target: worker,
      state: persistedSessionState({
        mode: "stopped",
        stoppedReason: "failure:session-reclaim-exhausted",
      }),
    },
    {
      name: "disabled-session-cleanup",
      target: disabledWorker,
      state: persistedSessionState(),
    },
    {
      name: "unconfigured-session-cleanup",
      target: unconfiguredWorker,
      state: persistedSessionState(),
    },
  ];
  for (const scenario of cases) {
    await listenerRpc(
      scenario.target,
      "seed",
      { state: scenario.state },
      scenario.name,
    );
    const result = await listenerRpc(
      scenario.target,
      "alarm",
      {},
      scenario.name,
    );
    assert.equal(result.error, null, JSON.stringify(result));
    assert.equal(
      result.snapshot.calls.deleteSession,
      1,
      JSON.stringify(result),
    );
    assert.equal(result.snapshot.listener.sessionId, null, scenario.name);
  }
});

test("bounded recovery exhausts at the cumulative elapsed-time boundary", async () => {
  const name = "bounded-recovery-elapsed";
  await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      createSessionErrors: [{
        type: "conflict",
        owner: "another-owner",
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS + 900_000,
      createSessionErrors: [{
        type: "conflict",
        owner: "another-owner",
      }],
    },
    name,
  );
  assert.equal(result.snapshot.recoveries[0].attempts, 1);
  assert.equal(
    result.snapshot.recoveries[0].exhaustedMarker,
    "session-reclaim-exhausted",
  );
  assert.equal(result.snapshot.listener.mode, "stopped");
  assert.equal(result.snapshot.calls.closeGate, 1);
});

test("Retry-After overrides the exponential recovery pause", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      createSessionErrors: ["rate-limit"],
      retryAfterMs: 12_345,
    },
    "retry-after-recovery",
  );
  assert.equal(result.error, null);
  assert.equal(result.snapshot.recoveries[0].condition, "github-rate-limit");
  assert.equal(
    result.snapshot.recoveries[0].nextAttemptAtMs - CLOCK_MS,
    12_345,
  );
});

test("a stale rate-limit pause cannot shorten exponential recovery", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      createSessionErrors: ["rate-limit"],
      retryAfterMs: 0,
    },
    "stale-rate-limit-recovery",
  );
  assert.equal(result.error, null);
  assert.equal(
    result.snapshot.recoveries[0].nextAttemptAtMs - CLOCK_MS,
    2_000,
  );
});

test("rearm clears exhausted recovery before the next failure", async () => {
  const name = "rearm-exhausted-recovery";
  const attemptTimes = [
    CLOCK_MS,
    CLOCK_MS + 2_000,
    CLOCK_MS + 6_000,
    CLOCK_MS + 14_000,
    CLOCK_MS + 30_000,
    CLOCK_MS + 62_000,
  ];
  let exhausted;
  for (const clockMs of attemptTimes) {
    exhausted = await listenerRpc(
      worker,
      "alarm",
      {
        clockMs,
        createSessionErrors: [{
          type: "conflict",
          owner: "another-owner",
        }],
      },
      name,
    );
  }
  assert.equal(exhausted.snapshot.recoveries[0].attempts, 6);

  const rearmed = await listenerRpc(
    worker,
    "control",
    {
      method: "rearm",
      input: {
        requestedGeneration:
          exhausted.snapshot.listener.alarmGeneration,
      },
    },
    name,
  );
  assert.equal(rearmed.result.rearmed, true);
  assert.deepEqual(rearmed.snapshot.recoveries, []);

  const failed = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: attemptTimes.at(-1) + 1,
      createSessionErrors: [{
        type: "conflict",
        owner: "another-owner",
      }],
    },
    name,
  );
  assert.equal(failed.snapshot.recoveries[0].attempts, 1);
  assert.equal(
    failed.snapshot.recoveries[0].nextAttemptAtMs,
    attemptTimes.at(-1) + 1 + 2_000,
  );
});

test("resume completes when persisted session deletion fails", async () => {
  const name = "resume-after-failed-session-deletion";
  const recovery = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      createSessionErrors: ["rate-limit"],
    },
    name,
  );
  assert.equal(recovery.snapshot.recoveries.length, 1);
  const alarmGeneration = recovery.snapshot.listener.alarmGeneration;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        mode: "stopped",
        stoppedReason: "deliberate:operator investigation",
        sqliteFull: true,
      }),
    },
    name,
  );

  const resumed = await listenerRpc(
    worker,
    "control",
    {
      method: "resume",
      input: {},
      specification: {
        clockMs: CLOCK_MS,
        deleteSessionError: "500",
        scheduledAlarm: CLOCK_MS + 1,
      },
    },
    name,
  );

  assert.deepEqual(resumed.result, {
    resumed: true,
    changed: true,
    armed: true,
    alarmGeneration,
    sessionDeleted: false,
  });
  assert.equal(resumed.snapshot.listener.mode, "running");
  assert.equal(resumed.snapshot.listener.stoppedReason, null);
  assert.equal(resumed.snapshot.listener.sqliteFull, false);
  assert.deepEqual(resumed.snapshot.recoveries, []);
  assert.deepEqual(resumed.snapshot.alarmTimes, [CLOCK_MS]);
  assert.equal(resumed.snapshot.scheduledAlarm, CLOCK_MS);
  assert.equal(resumed.snapshot.calls.deleteSession, 1);
  assert.equal(resumed.snapshot.listener.sessionId, SESSION_ID);
  assert.ok(emittedRecord(resumed, "listener-resumed"));
});

test("resume deletes a persisted session when GitHub accepts it", async () => {
  const name = "resume-after-successful-session-deletion";
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        mode: "stopped",
        stoppedReason: "deliberate:operator maintenance",
      }),
    },
    name,
  );

  const resumed = await listenerRpc(
    worker,
    "control",
    {
      method: "resume",
      input: {},
      specification: { clockMs: CLOCK_MS },
    },
    name,
  );

  assert.deepEqual(resumed.result, {
    resumed: true,
    changed: true,
    armed: true,
    alarmGeneration: seeded.listener.alarmGeneration,
    sessionDeleted: true,
  });
  assert.equal(resumed.snapshot.calls.deleteSession, 1);
  assert.equal(resumed.snapshot.listener.sessionId, null);
});

test("stop completes when a running session deletion fails", async () => {
  const name = "stop-after-failed-session-deletion";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );

  const stopped = await listenerRpc(
    worker,
    "control",
    {
      method: "stop",
      input: { reason: "operator maintenance" },
      specification: { deleteSessionError: "500" },
    },
    name,
  );

  assert.deepEqual(stopped.result, {
    stopped: true,
    changed: true,
    reason: "operator maintenance",
    advertisedMaxCapacity: 0,
    sessionDeleted: false,
  });
  assert.equal(stopped.snapshot.listener.mode, "stopped");
  assert.equal(
    stopped.snapshot.listener.stoppedReason,
    "deliberate:operator maintenance",
  );
  assert.equal(stopped.snapshot.listener.sessionId, SESSION_ID);
  assert.equal(stopped.snapshot.calls.deleteSession, 1);
});

test("repeated stop completes when persisted session deletion fails", async () => {
  const name = "repeat-stop-after-failed-session-deletion";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        mode: "stopped",
        stoppedReason: "deliberate:prior operator stop",
      }),
    },
    name,
  );

  const stopped = await listenerRpc(
    worker,
    "control",
    {
      method: "stop",
      input: { reason: "repeated operator stop" },
      specification: { deleteSessionError: "500" },
    },
    name,
  );

  assert.deepEqual(stopped.result, {
    stopped: true,
    changed: false,
    reason: "prior operator stop",
    advertisedMaxCapacity: 0,
    sessionDeleted: false,
  });
  assert.equal(stopped.snapshot.listener.mode, "stopped");
  assert.equal(
    stopped.snapshot.listener.stoppedReason,
    "deliberate:prior operator stop",
  );
  assert.equal(stopped.snapshot.listener.sessionId, SESSION_ID);
  assert.equal(stopped.snapshot.calls.deleteSession, 1);
});

test("session teardown refreshes an admin token near expiry", async () => {
  const name = "teardown-refreshes-admin-token";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminTokenExpiresAtMs: CLOCK_MS + 30_000,
      }),
    },
    name,
  );

  const stopped = await listenerRpc(
    worker,
    "control",
    {
      method: "stop",
      input: { reason: "operator maintenance" },
      specification: { clockMs: CLOCK_MS },
    },
    name,
  );

  assert.equal(stopped.result.stopped, true);
  assert.equal(stopped.snapshot.calls.adminRefresh, 1);
  assert.deepEqual(stopped.snapshot.deleteSessionRequests, [{
    actionsServiceUrl: "https://actions.stub.test/tenant",
    adminToken: REFRESHED_ADMIN_TOKEN,
    sessionId: SESSION_ID,
  }]);
  assert.ok(
    stopped.snapshot.events.indexOf("refresh-admin") <
      stopped.snapshot.events.indexOf(`delete-session:${SESSION_ID}`),
  );
  assert.equal(stopped.snapshot.listener.sessionId, null);
});

test("session teardown reuses an admin token that is still valid", async () => {
  const name = "teardown-reuses-valid-admin-token";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );

  const stopped = await listenerRpc(
    worker,
    "control",
    {
      method: "stop",
      input: { reason: "operator maintenance" },
      specification: { clockMs: CLOCK_MS },
    },
    name,
  );

  assert.equal(stopped.result.stopped, true);
  assert.equal(stopped.snapshot.calls.adminRefresh, 0);
  assert.deepEqual(stopped.snapshot.deleteSessionRequests, [{
    actionsServiceUrl: "https://actions.stub.test/tenant",
    adminToken: ADMIN_TOKEN,
    sessionId: SESSION_ID,
  }]);
});

test("resume completes when the admin token refresh fails", async () => {
  const name = "resume-after-failed-admin-refresh";
  const seeded = await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminTokenExpiresAtMs: CLOCK_MS + 30_000,
        mode: "stopped",
        stoppedReason: "deliberate:operator investigation",
      }),
    },
    name,
  );

  const resumed = await listenerRpc(
    worker,
    "control",
    {
      method: "resume",
      input: {},
      specification: {
        adminRefreshError: "registration token unavailable",
        clockMs: CLOCK_MS,
      },
    },
    name,
  );

  assert.deepEqual(resumed.result, {
    resumed: true,
    changed: true,
    armed: true,
    alarmGeneration: seeded.listener.alarmGeneration,
    sessionDeleted: true,
  });
  assert.equal(resumed.snapshot.listener.mode, "running");
  assert.equal(resumed.snapshot.calls.adminRefresh, 1);
  assert.deepEqual(resumed.snapshot.deleteSessionRequests, [{
    actionsServiceUrl: "https://actions.stub.test/tenant",
    adminToken: ADMIN_TOKEN,
    sessionId: SESSION_ID,
  }]);
  assert.deepEqual(resumed.snapshot.alarmTimes, [CLOCK_MS]);
});

test("stop completes when the admin token refresh fails", async () => {
  const name = "stop-after-failed-admin-refresh";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        adminTokenExpiresAtMs: CLOCK_MS + 30_000,
      }),
    },
    name,
  );

  const stopped = await listenerRpc(
    worker,
    "control",
    {
      method: "stop",
      input: { reason: "operator maintenance" },
      specification: {
        adminRefreshError: "registration token unavailable",
        clockMs: CLOCK_MS,
      },
    },
    name,
  );

  assert.deepEqual(stopped.result, {
    stopped: true,
    changed: true,
    reason: "operator maintenance",
    advertisedMaxCapacity: 0,
    sessionDeleted: true,
  });
  assert.equal(stopped.snapshot.listener.mode, "stopped");
  assert.equal(stopped.snapshot.calls.adminRefresh, 1);
  assert.deepEqual(stopped.snapshot.deleteSessionRequests, [{
    actionsServiceUrl: "https://actions.stub.test/tenant",
    adminToken: ADMIN_TOKEN,
    sessionId: SESSION_ID,
  }]);
});

test("rearm refuses a deliberate stop without changing generation", async () => {
  const name = "rearm-refuses-deliberate-stop";
  const stopped = await listenerRpc(
    worker,
    "control",
    {
      method: "stop",
      input: { reason: "operator stop" },
    },
    name,
  );
  const alarmGeneration = stopped.snapshot.listener.alarmGeneration;

  const rearmed = await listenerRpc(
    worker,
    "control",
    {
      method: "rearm",
      input: { requestedGeneration: alarmGeneration },
    },
    name,
  );

  assert.deepEqual(rearmed.result, {
    rearmed: false,
    reason: "deliberately-stopped",
    alarmGeneration,
  });
  assert.equal(
    rearmed.snapshot.listener.alarmGeneration,
    alarmGeneration,
  );
  assert.equal(rearmed.snapshot.listener.mode, "stopped");
  assert.deepEqual(rearmed.snapshot.alarmTimes, []);
});

test("stop, resume, and external rearm have explicit generation behavior", async () => {
  const name = "listener-control-transitions";
  const stopped = await listenerRpc(
    worker,
    "control",
    {
      method: "stop",
      input: { reason: "planned stop" },
    },
    name,
  );
  assert.equal(stopped.result.stopped, true);
  assert.equal(stopped.result.advertisedMaxCapacity, 0);

  const refusedRearm = await listenerRpc(
    worker,
    "control",
    {
      method: "rearm",
      input: {
        requestedGeneration: stopped.snapshot.listener.alarmGeneration,
      },
    },
    name,
  );
  assert.equal(refusedRearm.result.rearmed, false);
  assert.equal(refusedRearm.result.reason, "deliberately-stopped");

  const resumed = await listenerRpc(
    worker,
    "control",
    { method: "resume", input: {} },
    name,
  );
  assert.equal(resumed.result.resumed, true);
  assert.equal(resumed.snapshot.listener.mode, "running");

  const freshSession = await listenerRpc(
    worker,
    "alarm",
    { polls: [{ outcome: "no-message", advanceMs: 1_000 }] },
    name,
  );
  assert.equal(freshSession.snapshot.calls.createSession, 1);

  await listenerRpc(
    worker,
    "seed",
    {
      state: {
        mode: "stopped",
        stoppedReason: "failure:alarm-retries-exhausted",
      },
    },
    name,
  );
  const requestedGeneration = resumed.snapshot.listener.alarmGeneration;
  const rearmed = await listenerRpc(
    worker,
    "control",
    {
      method: "rearm",
      input: { requestedGeneration },
    },
    name,
  );
  assert.equal(rearmed.result.rearmed, true);
  assert.ok(rearmed.result.alarmGeneration > requestedGeneration);
  assert.equal(rearmed.snapshot.listener.mode, "running");
});

test("resume arms only a running listener that has no alarm", async () => {
  const fresh = await listenerRpc(
    worker,
    "control",
    {
      method: "resume",
      input: {},
      specification: { clockMs: CLOCK_MS },
    },
    "fresh-listener-resume",
  );
  const existingAlarm = CLOCK_MS + 1;
  const healthy = await listenerRpc(
    worker,
    "control",
    {
      method: "resume",
      input: {},
      specification: {
        clockMs: CLOCK_MS,
        scheduledAlarm: existingAlarm,
      },
    },
    "healthy-listener-resume",
  );

  assert.deepEqual(
    {
      fresh: {
        result: fresh.result,
        alarmTimes: fresh.snapshot.alarmTimes,
        scheduledAlarm: fresh.snapshot.scheduledAlarm,
      },
      healthy: {
        result: healthy.result,
        alarmTimes: healthy.snapshot.alarmTimes,
        scheduledAlarm: healthy.snapshot.scheduledAlarm,
      },
    },
    {
      fresh: {
        result: {
          resumed: true,
          changed: false,
          armed: true,
          alarmGeneration: 0,
        },
        alarmTimes: [CLOCK_MS],
        scheduledAlarm: CLOCK_MS,
      },
      healthy: {
        result: {
          resumed: true,
          changed: false,
          armed: false,
          alarmGeneration: 0,
        },
        alarmTimes: [],
        scheduledAlarm: existingAlarm,
      },
    },
  );
});

test("resume immediately rearms a drained listener", async () => {
  const name = "drained-listener-resume";
  const existingAlarm = CLOCK_MS + 1;
  await listenerRpc(
    worker,
    "seed",
    { state: { mode: "drained" } },
    name,
  );
  const resumed = await listenerRpc(
    worker,
    "control",
    {
      method: "resume",
      input: {},
      specification: {
        clockMs: CLOCK_MS,
        scheduledAlarm: existingAlarm,
      },
    },
    name,
  );

  assert.deepEqual(
    {
      result: resumed.result,
      alarmTimes: resumed.snapshot.alarmTimes,
      scheduledAlarm: resumed.snapshot.scheduledAlarm,
      mode: resumed.snapshot.listener.mode,
    },
    {
      result: {
        resumed: true,
        changed: true,
        armed: true,
        alarmGeneration: 0,
        sessionDeleted: true,
      },
      alarmTimes: [CLOCK_MS],
      scheduledAlarm: CLOCK_MS,
      mode: "running",
    },
  );
});

test("drain starts no runner and cancels undispatched work", async () => {
  const name = "listener-drain";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      inbox: [{
        messageId: 40,
        receivedAtMs: CLOCK_MS,
        state: "stored",
        message: availableMessage(40, []),
      }],
      intents: [{
        runnerRequestId: 4001,
        messageId: 39,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 4001,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: { clockMs: CLOCK_MS },
    },
    name,
  );
  assert.equal(result.result.drained, true);
  assert.equal(result.result.activeOutbox, 0);
  assert.equal(result.result.activeRunners, 0);
  assert.equal(result.result.pendingAcquisitions, 0);
  assert.equal(result.result.unacknowledgedMessages, 0);
  assert.equal(result.result.inFlightOperations, 0);
  assert.equal(result.result.inFlightPoll, false);
  assert.equal(result.snapshot.calls.deleteMessage, 1);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.calls.deleteSession, 1);
  assert.equal(result.snapshot.calls.reserve, 0);
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.outbox.length, 0);
  assert.equal(
    emittedRecord(result, "runner-start-cancelled")?.runnerRequestId,
    4001,
  );
});

test("drain compensates a reserved row it cancels", async () => {
  const name = "listener-drain-reserved";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 4003,
        messageId: 39,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 4003,
        state: "reserved",
        reservationId: "reservation-4003",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: { clockMs: CLOCK_MS },
    },
    name,
  );
  assert.equal(result.result.drained, true);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.calls.reserve, 0);
  assert.equal(result.snapshot.calls.compensate, 1);
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId: "reservation-4003",
    reason: "runner-request-cancelled",
  }]);
  assert.equal(result.snapshot.outbox.length, 0);
  assert.equal(
    emittedRecord(result, "runner-start-cancelled")?.runnerRequestId,
    4003,
  );
});

test("drain skips selected rows that disappear or become terminal", async () => {
  const name = "listener-drain-concurrent-compaction";
  await listenerRpc(
    worker,
    "seed",
    {
      intents: [4007, 4008, 4009].map((runnerRequestId) => ({
        runnerRequestId,
        messageId: 45,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      })),
      outbox: [
        {
          runnerRequestId: 4007,
          state: "reserved",
          reservationId: "reservation-4007",
          updatedAtMs: CLOCK_MS,
        },
        {
          runnerRequestId: 4008,
          state: "pending",
          updatedAtMs: CLOCK_MS + 1,
        },
        {
          runnerRequestId: 4009,
          state: "pending",
          updatedAtMs: CLOCK_MS + 2,
        },
      ],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 0,
        clockMs: CLOCK_MS,
        drainMutationAfterCompensate: {
          deleted: [4008],
          terminal: [4009],
        },
      },
    },
    name,
  );

  assert.equal(result.result.drained, true);
  assert.equal(result.snapshot.calls.compensate, 1);
  assert.deepEqual(
    result.snapshot.emittedRecords
      .map((record) => JSON.parse(record))
      .filter((record) => record.event === "runner-start-cancelled")
      .map((record) => record.runnerRequestId),
    [4007],
  );
});

test("drain reports drained false while a runner is still in flight", async () => {
  const name = "listener-drain-active-runner";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 1,
        clockMs: CLOCK_MS,
      },
    },
    name,
  );
  assert.equal(result.result.drained, false);
  assert.equal(result.result.activeRunners, 1);
  assert.equal(result.result.reason, "work-outstanding");
  assert.equal(result.snapshot.calls.deleteSession, 0);
  assert.equal(result.snapshot.listener.sessionId, SESSION_ID);
  assert.equal(result.snapshot.events.includes("delete-alarm"), false);
  assert.equal(result.snapshot.events.includes("set-alarm"), true);
  assert.deepEqual(result.snapshot.alarmTimes, [CLOCK_MS + 5_000]);
});

test("drain reports drained false when the runner inventory cannot be read", async () => {
  const name = "listener-drain-runner-inventory-error";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCountError: "registry unavailable",
        clockMs: CLOCK_MS,
      },
    },
    name,
  );
  assert.equal(result.result.drained, false);
  assert.equal(result.result.activeRunners, null);
  assert.equal(result.result.reason, "runner-inventory-unavailable");
  assert.equal(result.snapshot.calls.deleteSession, 0);
  assert.equal(result.snapshot.events.includes("delete-alarm"), false);
  assert.equal(result.snapshot.events.includes("set-alarm"), true);
  assert.equal(
    result.snapshot.exportRecords.some((row) =>
      row.record.includes("drain-runner-inventory-unavailable")
    ),
    true,
  );
});

test("drain fails closed on a malformed RunnerRegistry inventory", async () => {
  const name = "listener-drain-malformed-runner-inventory";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        clockMs: CLOCK_MS,
        runnerRegistryActiveResult: {
          runners: { length: 0 },
          hasMore: false,
        },
      },
    },
    name,
  );
  assert.equal(result.result.drained, false);
  assert.equal(result.result.activeRunners, null);
  assert.equal(result.result.reason, "runner-inventory-unavailable");
});

test("the real runner inventory path counts rows and hasMore", async () => {
  for (const testCase of [
    { hasMore: false, expected: 1, suffix: "row" },
    { hasMore: true, expected: 2, suffix: "has-more" },
  ]) {
    const result = await listenerRpc(
      worker,
      "control",
      {
        method: "drain",
        input: {},
        specification: {
          clockMs: CLOCK_MS,
          runnerRegistryActiveResult: {
            runners: [{ sandboxId: "runner-counted" }],
            hasMore: testCase.hasMore,
          },
        },
      },
      `listener-real-runner-count-${testCase.suffix}`,
    );

    assert.equal(result.result.activeRunners, testCase.expected);
    assert.equal(result.result.drained, false);
    assert.equal(result.snapshot.calls.activeRunnerCount, 0);
  }
});

test("drain sees a runner recorded ahead of the listener clock", async () => {
  const sandboxId = `runner-ahead-${crypto.randomUUID()}`;
  const registryResponse = await disabledWorker.fetch(
    "/harness/runner-registry/record-starting",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sandboxId,
        runnerName: `cloudflare-${crypto.randomUUID()}`,
        correlationId: `correlation-${crypto.randomUUID()}`,
        repository: "example/runner-test",
        createdAt: new Date(CLOCK_MS + 1).toISOString(),
        createdAtMs: CLOCK_MS + 1,
      }),
    },
  );
  assert.equal(registryResponse.status, 200, await registryResponse.text());

  const result = await listenerRpc(
    disabledWorker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        clockMs: CLOCK_MS,
        useRunnerRegistryActiveList: true,
      },
    },
    "listener-runner-clock-ahead",
  );

  assert.equal(result.result.activeRunners, 1);
  assert.equal(result.result.drained, false);
});

test("drain keeps a start-requested row inside its deadline", async () => {
  const name = "listener-drain-start-requested";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 4002,
        messageId: 39,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 4002,
        state: "start-requested",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 0,
        clockMs: CLOCK_MS,
        reconciledStart: false,
      },
    },
    name,
  );
  assert.equal(result.result.drained, false);
  assert.equal(result.result.activeOutbox, 1);
  assert.equal(result.result.activeRunners, 0);
  assert.equal(result.result.pendingAcquisitions, 1);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 0);
  assert.equal(result.snapshot.outbox.length, 1);
  assert.equal(result.snapshot.outbox[0].state, "start-requested");
});

test("drain stops settlement when its work deadline has passed", async () => {
  const name = "listener-drain-work-deadline";
  await listenerRpc(
    worker,
    "seed",
    {
      intents: [{
        runnerRequestId: 4006,
        messageId: 44,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 4006,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 0,
        clockMs: CLOCK_MS,
        clockValues: [CLOCK_MS, CLOCK_MS + 10_001],
      },
    },
    name,
  );

  assert.equal(result.result.drained, false);
  assert.equal(result.result.activeOutbox, 1);
  assert.equal(result.snapshot.outbox[0].state, "pending");
  assert.equal(result.snapshot.calls.compensate, 0);
  assert.equal(result.snapshot.events.includes("set-alarm"), true);
});

test("drain fails a lost start-requested row past its deadline", async () => {
  const name = "listener-drain-expired-start-requested";
  const recordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      intents: [{
        runnerRequestId: 4005,
        messageId: 43,
        state: "granted",
        recordedAtMs,
      }],
      outbox: [{
        runnerRequestId: 4005,
        state: "start-requested",
        updatedAtMs: recordedAtMs,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 1,
        clockMs: CLOCK_MS,
        reconciledStart: false,
      },
    },
    name,
  );
  assert.equal(result.result.drained, false);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 1);
  assert.equal(result.snapshot.outbox.length, 1);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "start-response-ambiguous",
  );
});

test("drain cleans up a late start found by reconciliation", async () => {
  const name = "listener-drain-reconciled-late-start";
  const recordedAtMs = CLOCK_MS - START_DEADLINE_MS - 1;
  await listenerRpc(
    worker,
    "seed",
    {
      intents: [{
        runnerRequestId: 4011,
        messageId: 47,
        state: "granted",
        recordedAtMs,
      }],
      outbox: [{
        runnerRequestId: 4011,
        state: "start-requested",
        reservationId: "reservation-4011",
        updatedAtMs: recordedAtMs,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 1,
        clockMs: CLOCK_MS,
        reconciledSandboxId: "runner-reconciled-drain",
        reconciledStart: true,
      },
    },
    name,
  );

  assert.equal(result.result.drained, false);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "deadline-exceeded-after-start",
  );
  assert.deepEqual(result.snapshot.compensated, [{
    reservationId: "reservation-4011",
    reason: "deadline-exceeded-after-start",
  }]);
  assert.deepEqual(
    result.snapshot.scheduledCleanup,
    ["runner-reconciled-drain"],
  );
  assert.equal(
    emittedRecord(result, "runner-spawn-failed")?.reason,
    "deadline-exceeded-after-start",
  );
});

test("drain settles a start whose acquisition intent is missing", async () => {
  const name = "listener-drain-missing-acquisition-intent";
  await listenerRpc(
    worker,
    "seed",
    {
      outbox: [{
        runnerRequestId: 4012,
        state: "start-requested",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 1,
        clockMs: CLOCK_MS,
        reconciledStart: false,
      },
    },
    name,
  );

  assert.equal(result.result.drained, false);
  assert.equal(result.snapshot.calls.getStartByCorrelation, 1);
  assert.equal(result.snapshot.outbox[0].state, "failed");
  assert.equal(
    result.snapshot.outbox[0].lastError,
    "start-response-ambiguous",
  );
});

test("a drained alarm discounts its own tracked operation", async () => {
  const name = "listener-drained-alarm-own-operation";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ mode: "drained" }) },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    { clockMs: CLOCK_MS },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.result.drained, true);
  assert.equal(result.result.inFlightOperations, 0);
  assert.equal(result.snapshot.calls.deleteSession, 1);
});

test("a drained alarm handles a settlement rejection", async () => {
  const name = "listener-drained-alarm-settlement-rejection";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        mode: "drained",
        sessionId: null,
        sessionQueueUrl: null,
        sessionQueueToken: null,
      }),
      intents: [{
        runnerRequestId: 4010,
        messageId: 46,
        state: "granted",
        recordedAtMs: CLOCK_MS,
      }],
      outbox: [{
        runnerRequestId: 4010,
        state: "reserved",
        reservationId: "reservation-4010",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      compensateError: "compensation failed",
    },
    name,
  );

  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "alarm-failed");
  assert.match(result.result.failure, /compensation failed/u);
  assert.ok(emittedRecord(result, "listener-alarm-failed"));
});

test("a drained alarm completes interrupted pre-settlement work", async () => {
  const name = "listener-drained-alarm-interrupted-settlement";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ mode: "drained" }),
      inbox: [{
        messageId: 41,
        receivedAtMs: CLOCK_MS,
        state: "stored",
        message: availableMessage(41, []),
      }],
      intents: [{
        runnerRequestId: 4004,
        messageId: 41,
        state: "intended",
        recordedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    { clockMs: CLOCK_MS },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.result.drained, true);
  assert.equal(result.result.pendingAcquisitions, 0);
  assert.equal(result.snapshot.calls.deleteMessage, 1);
  assert.deepEqual(result.snapshot.inbox, []);
  assert.deepEqual(result.snapshot.intents, []);
});

test("a completed drain retains cancellation evidence in status", async () => {
  const name = "listener-drain-cancellation-evidence";
  await listenerRpc(
    worker,
    "seed",
    {
      intents: [
        {
          runnerRequestId: 4013,
          messageId: 48,
          state: "intended",
          recordedAtMs: CLOCK_MS,
        },
        {
          runnerRequestId: 4014,
          messageId: 48,
          state: "ambiguous",
          recordedAtMs: CLOCK_MS,
        },
        {
          runnerRequestId: 4015,
          messageId: 48,
          state: "granted",
          recordedAtMs: CLOCK_MS,
        },
      ],
      outbox: [{
        runnerRequestId: 4015,
        state: "pending",
        updatedAtMs: CLOCK_MS,
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control",
    {
      method: "drain",
      input: {},
      specification: {
        activeRunnerCount: 0,
        clockMs: CLOCK_MS,
      },
    },
    name,
  );

  assert.equal(result.result.drained, true);
  const acquisitionEvent = emittedRecord(
    result,
    "runner-acquisitions-cancelled",
  );
  assert.equal(acquisitionEvent.acquisitionCount, 2);
  assert.deepEqual(acquisitionEvent.runnerRequestIds, [4013, 4014]);

  const status = await listenerRpc(worker, "reconstruct", {}, name);
  const retainedEvents = status.exportRecords.map((row) => row.record.event);
  assert.equal(retainedEvents.includes("runner-start-cancelled"), true);
  assert.equal(
    retainedEvents.includes("runner-acquisitions-cancelled"),
    true,
  );
});

test("an incomplete drained alarm uses the runner recheck floor", async () => {
  const name = "listener-drained-alarm-recheck-floor";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        mode: "drained",
        sessionId: null,
        sessionQueueUrl: null,
        sessionQueueToken: null,
      }),
      inbox: [{
        messageId: 42,
        receivedAtMs: CLOCK_MS,
        state: "stored",
        message: availableMessage(42, []),
      }],
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    { clockMs: CLOCK_MS },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.result.drained, false);
  assert.deepEqual(result.snapshot.alarmTimes, [
    CLOCK_MS,
    CLOCK_MS + 5_000,
  ]);
  assert.notEqual(result.snapshot.alarmTimes.at(-1), CLOCK_MS);
});

test("drain waits for a tracked drained alarm", async () => {
  const name = "listener-drained-alarm-fence";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ mode: "drained" }) },
    name,
  );
  const result = await listenerRpc(
    worker,
    "drained-alarm-fence",
    { activeRunnerCount: 1, clockMs: CLOCK_MS },
    name,
  );
  assert.equal(result.drainSettledBeforeRelease, false);
  assert.equal(result.alarmResult.drained, false);
  assert.equal(result.alarmResult.activeRunners, 1);
  assert.equal(result.alarmResult.inFlightOperations, 0);
  assert.equal(result.drainResult.drained, false);
  assert.equal(result.drainResult.activeRunners, 1);
  assert.equal(result.drainResult.inFlightOperations, 0);
});

test("the drained alarm fence preserves runner inventory errors", async () => {
  const name = "listener-drained-alarm-fence-error";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState({ mode: "drained" }) },
    name,
  );
  const result = await listenerRpc(
    worker,
    "drained-alarm-fence",
    {
      activeRunnerCountError: "registry unavailable",
      clockMs: CLOCK_MS,
    },
    name,
  );

  assert.equal(result.drainSettledBeforeRelease, false);
  assert.equal(result.alarmResult.drained, false);
  assert.equal(result.alarmResult.activeRunners, null);
  assert.equal(result.drainResult.drained, false);
  assert.equal(result.drainResult.activeRunners, null);
  assert.equal(result.drainResult.reason, "runner-inventory-unavailable");
});

test("a disabled drained alarm performs shutdown handling", async () => {
  const name = "listener-disabled-drained-alarm";
  await listenerRpc(
    disabledWorker,
    "seed",
    { state: persistedSessionState({ mode: "drained" }) },
    name,
  );
  const result = await listenerRpc(
    disabledWorker,
    "alarm",
    { clockMs: CLOCK_MS },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.result.outcome, "disabled");
  assert.equal(result.snapshot.calls.activeRunnerCount, 0);
  assert.equal(result.snapshot.calls.deleteSession, 1);
  assert.equal(result.snapshot.listener.sessionId, null);
});

test("a drained alarm performs SQLITE_FULL recovery first", async () => {
  const name = "listener-sqlite-full-drained-alarm";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        mode: "drained",
        sqliteFull: true,
      }),
    },
    name,
  );
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      activeRunnerCount: 1,
      clockMs: CLOCK_MS,
    },
    name,
  );
  assert.equal(result.error, null);
  assert.equal(result.result.drained, false);
  assert.equal(result.result.inFlightOperations, 0);
  assert.equal(result.snapshot.listener.sqliteFull, false);
  assert.ok(emittedRecord(result, "sqlite-full-recovered"));
});

test("drain waits for an alarm suspended at control status", async () => {
  const name = "control-status-drain-fence";
  await listenerRpc(
    worker,
    "seed",
    { state: persistedSessionState() },
    name,
  );
  const result = await listenerRpc(
    worker,
    "control-status-fence",
    { clockMs: CLOCK_MS },
    name,
  );
  assert.equal(result.drainSettledBeforeRelease, false);
  assert.equal(result.drainResult.drained, true);
  assert.equal(result.drainResult.inFlightOperations, 0);
  assert.equal(result.snapshot.listener.sessionId, null);
});

test("a new object instance reads the persisted session and cursor", async () => {
  const name = "listener-eviction-survival";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        cursor: 77,
        latestStatistics: STATISTICS,
      }),
    },
    name,
  );
  const reconstructed = await listenerRpc(
    worker,
    "reconstruct",
    {},
    name,
  );
  assert.equal(reconstructed.sessionId, SESSION_ID);
  assert.equal(reconstructed.cursor, 77);
  assert.deepEqual(reconstructed.latestStatistics, STATISTICS);

  const resumed = await listenerRpc(
    worker,
    "alarm",
    { polls: [{ outcome: "no-message", advanceMs: 1_000 }] },
    name,
  );
  assert.equal(resumed.snapshot.calls.createSession, 0);
  assert.ok(resumed.snapshot.events.includes("poll:77"));
});

test("logs and export rows exclude every listener credential and JIT config", async () => {
  const name = "listener-secret-redaction";
  const secrets = [
    SESSION_TOKEN,
    REFRESHED_ADMIN_TOKEN,
    CONTROL_TOKEN,
    GITHUB_TOKEN,
    APP_PRIVATE_KEY,
    APP_JWT,
    INSTALLATION_TOKEN,
    REGISTRATION_TOKEN,
    JIT_CONFIG,
  ];
  const sourceRecord = JSON.stringify({ valuesBeforeRedaction: secrets });
  for (const secret of secrets) {
    assert.equal(sourceRecord.includes(secret), true, secret);
  }
  const alarm = await listenerRpc(
    worker,
    "alarm",
    {
      authenticationChain: true,
      config: {
        actionsServiceUrl: null,
        adminToken: null,
        adminTokenExpiresAtMs: null,
        appId: "123456",
        installationId: "654321",
        privateKeyPkcs8: APP_PRIVATE_KEY,
      },
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          message: availableMessage(50, [5001]),
        },
        { errorMessage: sourceRecord },
      ],
    },
    name,
  );
  assert.deepEqual(alarm.snapshot.postRunnerIds, [5001]);
  const scan = await listenerRpc(
    worker,
    "secret-scan",
    { secrets },
    name,
  );
  for (const [secret, result] of Object.entries(scan)) {
    assert.equal(result.logs, false, secret);
    assert.equal(result.exportRows, false, secret);
  }
});

test("captured unassigned completions keep the listener running", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: CAPTURED_UNASSIGNED_JOB_COMPLETIONS,
      }],
    },
    "captured-unassigned-completions",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.mode, "running");
  assert.equal(result.snapshot.calls.closeGate, 0);
  assert.equal(result.snapshot.calls.deleteMessage, 1);
  assert.equal(result.snapshot.inbox[0].state, "acknowledged");
  assert.equal(result.snapshot.listener.cursor, 100000002);
  assert.deepEqual(result.snapshot.cancellations, []);
  const pollRecord = emittedRecord(result, "message-polled");
  assert.equal(pollRecord.ignoredCount, 4);
  assert.deepEqual(
    pollRecord.ignoredReasons,
    ["unassigned-job-completion"],
  );
});

test("zero request lifecycle entries stay ignored without quarantine", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: {
          messageId: 100000005,
          messageType: "RunnerScaleSetJobMessages",
          statistics: {
            ...STATISTICS,
            totalAssignedJobs: 0,
          },
          body: JSON.stringify([{
            messageType: "JobAssigned",
            runnerRequestId: 0,
            ownerName: "example",
            repositoryName: "runner-test",
          }, {
            messageType: "JobCompleted",
            runnerRequestId: 0,
            ownerName: "example",
            repositoryName: "runner-test",
          }]),
        },
      }],
    },
    "zero-request-lifecycle-ignored",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.mode, "running");
  assert.equal(result.snapshot.calls.closeGate, 0);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.equal(result.snapshot.inbox[0].state, "acknowledged");
  assert.equal(result.snapshot.inbox[0].quarantineReason, null);
  assert.deepEqual(result.snapshot.intents, []);
  assert.deepEqual(result.snapshot.outbox, []);
  assert.deepEqual(result.snapshot.cancellations, []);
  const pollRecord = emittedRecord(result, "message-polled");
  assert.equal(pollRecord.ignoredCount, 2);
  assert.deepEqual(pollRecord.ignoredReasons, [
    "stale-job-assignment",
    "unassigned-job-completion",
  ]);
});

test("stale assignments do not create acquisition work", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: {
          ...CAPTURED_UNASSIGNED_JOB_COMPLETIONS,
          messageId: 100000003,
          body: JSON.stringify([{
            messageType: "JobAssigned",
            repositoryName: "example-repo",
            ownerName: "example-org",
            runnerRequestId: 0,
          }, {
            messageType: "JobAssigned",
            repositoryName: "example-repo",
            ownerName: "example-org",
            runnerRequestId: 0,
          }]),
        },
      }],
    },
    "stale-job-assignments",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.mode, "running");
  assert.equal(result.snapshot.calls.closeGate, 0);
  assert.equal(result.snapshot.calls.deleteMessage, 1);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.inbox[0].state, "acknowledged");
  assert.equal(result.snapshot.listener.cursor, 100000003);
  assert.deepEqual(result.snapshot.intents, []);
  assert.deepEqual(result.snapshot.outbox, []);
  const pollRecord = emittedRecord(result, "message-polled");
  assert.equal(pollRecord.ignoredCount, 2);
  assert.deepEqual(
    pollRecord.ignoredReasons,
    ["stale-job-assignment"],
  );
});

test("a raw malformed request identifier still stops the listener", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: {
          ...CAPTURED_UNASSIGNED_JOB_COMPLETIONS,
          messageId: 100000004,
          body: JSON.stringify([{
            messageType: "JobAssigned",
            repositoryName: "example-repo",
            ownerName: "example-org",
            runnerRequestId: -1,
          }, {
            messageType: "JobAssigned",
            repositoryName: "example-repo",
            ownerName: "example-org",
            runnerRequestId: 0,
          }]),
        },
      }],
    },
    "raw-malformed-request-id",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.mode, "stopped");
  assert.match(
    result.snapshot.listener.stoppedReason,
    /routing-semantics:invalid-runner-request-id/u,
  );
  assert.equal(result.snapshot.calls.closeGate, 1);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.equal(result.snapshot.inbox[0].state, "quarantined");
});

test("the job starts of a successful wave keep the listener running", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [
        {
          outcome: "message",
          advanceMs: 1_000,
          envelope: RECONSTRUCTED_UNASSIGNED_JOB_STARTS,
        },
        {
          outcome: "message",
          advanceMs: START_PACE_MS,
          message: statisticsMessage(100000007, 0),
        },
        ...pacedNoMessagePolls(1),
      ],
    },
    "unassigned-job-starts",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.mode, "running");
  assert.equal(result.snapshot.calls.closeGate, 0);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.equal(result.snapshot.inbox[0].state, "acknowledged");
  assert.equal(result.snapshot.inbox[0].quarantineReason, null);
  assert.equal(result.snapshot.listener.cursor, 100000007);
  assert.deepEqual(result.snapshot.intents, []);
  assert.deepEqual(result.snapshot.cancellations, []);

  const pollRecord = emittedRecord(result, "message-polled");
  assert.equal(pollRecord.quarantined, false);
  assert.deepEqual(pollRecord.quarantineReasons, []);
  assert.equal(pollRecord.ignoredCount, 5);
  assert.deepEqual(pollRecord.ignoredReasons, [
    "unassigned-job-start",
    "unassigned-job-completion",
  ]);

  // The point of the fix: the wave's own success no longer stops the pass.
  // Statistics-driven scale-up still runs, from the reserved identifier band
  // that GitHub can never mint.
  assert.equal(result.snapshot.calls.postRunners, 3);
  assert.equal(result.snapshot.outbox.length, 3);
  for (const row of result.snapshot.outbox) {
    assert.ok(row.runnerRequestId >= SCALE_UP_REQUEST_ID_BASE);
  }
});

test("a negative job start identifier still stops the listener", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        envelope: {
          ...RECONSTRUCTED_UNASSIGNED_JOB_STARTS,
          messageId: 100000008,
          body: JSON.stringify([{
            messageType: "JobStarted",
            repositoryName: "example-repo",
            ownerName: "example-org",
            runnerRequestId: -1,
            runnerId: 227,
            runnerName: "cloudflare-1-4503599627370517",
          }, {
            messageType: "JobStarted",
            repositoryName: "example-repo",
            ownerName: "example-org",
            runnerRequestId: 0,
            runnerId: 226,
            runnerName: "cloudflare-1-4503599627370518",
          }]),
        },
      }],
    },
    "negative-job-start-id",
  );

  assert.equal(result.error, null);
  assert.equal(result.snapshot.listener.mode, "stopped");
  assert.match(
    result.snapshot.listener.stoppedReason,
    /routing-semantics:invalid-runner-request-id/u,
  );
  assert.equal(result.snapshot.calls.closeGate, 1);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.inbox[0].state, "quarantined");
});

test("invalid request zero and unknown message types quarantine the scale set", async () => {
  const result = await listenerRpc(
    worker,
    "alarm",
    {
      polls: [{
        outcome: "message",
        advanceMs: 1_000,
        message: {
          messageId: 60,
          assigned: [],
          quarantined: [
            {
              reason: "invalid-runner-request-id",
              entry: {
                messageType: "JobAssigned",
                runnerRequestId: 0,
              },
            },
            {
              reason: "unknown-message-type",
              entry: {
                messageType: "FutureMessage",
                runnerRequestId: 6001,
              },
            },
          ],
        },
      }],
    },
    "routing-quarantine",
  );
  assert.equal(result.error, null);
  assert.equal(result.snapshot.calls.deleteMessage, 1);
  assert.equal(result.snapshot.calls.acquireJobs, 0);
  assert.equal(result.snapshot.calls.postRunners, 0);
  assert.equal(result.snapshot.calls.closeGate, 1);
  assert.equal(result.snapshot.listener.mode, "stopped");
  assert.equal(result.snapshot.inbox[0].state, "quarantined");
  assert.match(
    result.snapshot.inbox[0].quarantineReason,
    /invalid-runner-request-id/u,
  );
  assert.match(
    result.snapshot.inbox[0].quarantineReason,
    /unknown-message-type/u,
  );
});

test("listener status redacts retained legacy quarantine payloads", async () => {
  const name = "legacy-quarantine-redaction";
  const payloadSecret = SESSION_TOKEN;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState(),
      inbox: [{
        messageId: 61,
        receivedAtMs: CLOCK_MS,
        state: "quarantined",
        quarantineReason: "unknown-message-type",
        message: {
          messageId: 61,
          quarantined: [{
            reason: "unknown-message-type",
            entry: {
              messageType: "FutureMessage",
              futureMetadata: [payloadSecret],
            },
          }],
        },
      }],
    },
    name,
  );
  const status = await listenerRpc(worker, "reconstruct", {}, name);
  const serialized = JSON.stringify(status.quarantinedMessages);
  assert.equal(serialized.includes(payloadSecret), false);
  assert.equal(status.quarantinedMessages[0].reason, "unknown-message-type");
});

test("forced compaction retains pending exports and reclaims other history", async () => {
  const name = "sqlite-full-history-reclaim";
  const removedMarker = "forced-compaction-sent-export";
  const retainedMarker = "forced-compaction-pending-export";
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({
        cursor: 72,
        sqliteFull: true,
      }),
      cancellations: [7201],
      inbox: [{
        messageId: 72,
        receivedAtMs: CLOCK_MS,
        state: "quarantined",
        quarantineReason: "unknown-message-type",
        message: { messageId: 72, quarantined: [{ reason: "unknown" }] },
      }],
      exportRecords: [
        {
          record: { marker: removedMarker },
          createdAtMs: CLOCK_MS,
          state: "sent",
        },
        {
          record: { marker: retainedMarker },
          createdAtMs: CLOCK_MS,
          state: "pending",
        },
      ],
      recordedAtMs: CLOCK_MS,
    },
    name,
  );
  const alarm = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    name,
  );
  assert.equal(alarm.error, null);
  assert.equal(alarm.snapshot.listener.sqliteFull, false);
  assert.deepEqual(alarm.snapshot.cancellations, []);
  assert.deepEqual(alarm.snapshot.inbox, []);
  assert.equal(
    alarm.snapshot.exportRecords.some((row) =>
      row.record.includes(removedMarker)
    ),
    false,
  );
  assert.equal(
    alarm.snapshot.exportRecords.some((row) =>
      row.record.includes(retainedMarker)
    ),
    true,
  );
});

test("normal compaction keeps only history inside the cleanup horizon", async () => {
  const name = "normal-history-retention";
  const oldAtMs = CLOCK_MS - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1;
  const recentAtMs = CLOCK_MS - ACTIVE_RUNNER_CLEANUP_DELAY_MS + 1;
  await listenerRpc(
    worker,
    "seed",
    {
      state: persistedSessionState({ cursor: 74 }),
      cancellations: [7301, 7401],
      inbox: [
        {
          messageId: 73,
          receivedAtMs: oldAtMs,
          state: "quarantined",
          quarantineReason: "old",
          message: { messageId: 73, quarantined: [{ reason: "old" }] },
        },
        {
          messageId: 74,
          receivedAtMs: recentAtMs,
          state: "quarantined",
          quarantineReason: "recent",
          message: { messageId: 74, quarantined: [{ reason: "recent" }] },
        },
      ],
      exportRecords: [
        { record: { marker: "old-export" }, createdAtMs: oldAtMs },
        { record: { marker: "recent-export" }, createdAtMs: recentAtMs },
      ],
      recordedAtMs: oldAtMs,
    },
    name,
  );
  await listenerRpc(
    worker,
    "seed",
    { cancellations: [7401], recordedAtMs: recentAtMs },
    name,
  );
  const alarm = await listenerRpc(
    worker,
    "alarm",
    {
      clockMs: CLOCK_MS,
      polls: [{ outcome: "poll-aborted", advanceMs: 890_000 }],
    },
    name,
  );
  assert.deepEqual(
    alarm.snapshot.cancellations.map((row) => row.runnerRequestId),
    [7401],
  );
  assert.deepEqual(
    alarm.snapshot.inbox.map((row) => row.messageId),
    [74],
  );
  const records = alarm.snapshot.exportRecords.map((row) => row.record);
  assert.equal(records.some((record) => record.includes("old-export")), false);
  assert.equal(records.some((record) => record.includes("recent-export")), true);
});

test("listener routes authenticate, validate names, and return Allow", async () => {
  const headers = { Authorization: `Bearer ${CONTROL_TOKEN}` };
  const routeScaleSet = `route-${RUN_PREFIX}`;
  const status = await worker.fetch(
    `/autopilot/listener/${routeScaleSet}`,
    { headers },
  );
  assert.equal(status.status, 200);
  assert.equal((await status.json()).scaleSet, routeScaleSet);

  const invalid = await worker.fetch(
    "/autopilot/listener/bad%2Fname",
    { headers },
  );
  assert.equal(invalid.status, 400);

  const method = await worker.fetch(
    `/autopilot/listener/${routeScaleSet}`,
    { method: "POST", headers },
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "GET");

  const unauthorized = await worker.fetch(
    `/autopilot/listener/${routeScaleSet}`,
  );
  assert.equal(unauthorized.status, 401);
});

test("deep listener TypeErrors return and log redacted detail", async () => {
  const secret = CONTROL_TOKEN;
  const source = `deep durable failure ${secret}`;
  assert.equal(source.includes(secret), true);
  const response = await worker.fetch("/harness/listener-route-failure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, {
    error: "Failed to update scale set listener",
    detail: {
      name: "TypeError",
      message: "deep durable failure [REDACTED]",
      status: null,
    },
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.logs.length, 1);
  assert.deepEqual(JSON.parse(result.logs[0]), {
    message: "scale set listener request failed",
    route: "/autopilot/listener/example-scale-set",
    error: {
      name: "TypeError",
      message: "deep durable failure [REDACTED]",
      cause: null,
    },
  });
});

test("listener route returns safe ScaleSetRequestError detail", async () => {
  const secret = CONTROL_TOKEN;
  const response = await worker.fetch(
    "/harness/listener-route-request-error",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, {
    error: "Failed to update scale set listener",
    detail: {
      name: "ScaleSetRequestError",
      message: "session deletion failed [REDACTED]",
      status: 401,
    },
  });
  const responseText = JSON.stringify(result.body);
  assert.equal(responseText.includes(secret), false);
  assert.equal(responseText.includes("responseSnippet"), false);
  assert.equal(responseText.includes("expired session"), false);
  assert.equal(responseText.includes("?page=1"), false);

  assert.equal(result.logs.length, 1);
  const record = JSON.parse(result.logs[0]);
  assert.equal(record.error.status, 401);
  assert.equal(record.error.method, "DELETE");
  assert.equal(
    record.error.url,
    "https://actions.stub.test/message-sessions?page=1",
  );
  assert.equal(record.error.responseSnippet, "expired session [REDACTED]");
  assert.equal(result.logs[0].includes(secret), false);
});
