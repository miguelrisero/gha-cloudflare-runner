import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { guardDevWorkerTransport } from "./dev-worker-transport.js";

import {
  MAX_BUSY_POSTPONE_MS,
  MAX_CLEANUP_CONCURRENCY,
  RECONCILE_CANDIDATE_PAGE_SIZE,
  RECONCILE_LISTING_PAGINATION_RESERVE,
  RECONCILE_REGISTRY_READ_SUBREQUESTS,
  RECONCILE_SUBREQUESTS_PER_CANDIDATE,
  RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING,
  WORKER_SUBREQUEST_LIMIT,
} from "../src/runner-policy.js";

register(new URL("./cloudflare-workers-loader.js", import.meta.url));

process.env.WRANGLER_WRITE_LOGS = "false";

const { unstable_dev } = await import("wrangler");
const { MAX_ACTIVE_RUNNERS } = await import("../src/autopilot-control.js");

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DOCUMENT_SECTIONS = [
  {
    documentPath: "docs/ORPHAN-RUNBOOK.md",
    heading: "## Use the operator route",
  },
];
const RECLAIM_DOCUMENT_SECTIONS = [
  {
    documentPath: "docs/ORPHAN-RUNBOOK.md",
    heading: "## Reclaim an `absent-from-cloudflare` row",
  },
];
const testRunId = crypto.randomUUID();
const ACTIVE_RUNNER_CLEANUP_DELAY_MS = 3_600_000;
// The longest job this pool can legitimately run. The reference workload set
// timeout-minutes: 25, so GitHub cancels at this age and no legitimate busy
// span can exceed it. The observed maxima sit far below it: 621 s across 1,162
// successful jobs, and 910 s across repositories.
const LONGEST_ALLOWED_JOB_MS = 25 * 60 * 1000;
const CALLBACK_CLEANUP_HANDOFF_DELAY_MS = 30_000;
const CLEANUP_CLAIM_STALE_MS = 90_000;
const DESTROY_TIMEOUT_MS = 60_000;
const CLEANUP_RETRY_DELAY_MS = DESTROY_TIMEOUT_MS;
const MAX_CLEANUP_ATTEMPTS = 10;
const ORPHAN_DESTROY_GRACE_MS = 60_000;
const RUNNER_LIST_PAGE_SIZE = 100;
const GITHUB_WEBHOOK_REDELIVERY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const CONTROL_TOKEN = "control-token-with-at-least-32-characters";
const ORPHAN_TEST_NOW_MS = 1_800_000_000_000;
const DEFAULT_SANDBOX_INSTANCE_ID = "a".repeat(64);
const REMOVED_CREATION_TIME_FIELD = ["observedSandbox", "CreatedAt"].join("");
const TERMINAL_RUNNER_RETENTION_MS =
  GITHUB_WEBHOOK_REDELIVERY_WINDOW_MS + ACTIVE_RUNNER_CLEANUP_DELAY_MS;
const ORPHAN_OBSERVATION_MAX_AGE_MS = TERMINAL_RUNNER_RETENTION_MS;
const TERMINAL_RUNNER_PRUNE_BATCH_SIZE = 1_000;
let worker;
let workerPersistencePath;

function devOptions(persistTo) {
  return {
    config: "test/wrangler.jsonc",
    logLevel: "none",
    persist: true,
    persistTo,
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false,
    },
  };
}

before(async () => {
  workerPersistencePath = await mkdtemp(
    join(tmpdir(), "runner-registry-test-"),
  );
  worker = guardDevWorkerTransport(await unstable_dev(
    "test/runner-registry-harness.js",
    devOptions(workerPersistencePath),
  ));
});

after(async () => {
  await worker?.stop();
  await rm(workerPersistencePath, { recursive: true, force: true });
});

async function registryRequest(registry, pathname, body) {
  const init = body === undefined
    ? undefined
    : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
  return worker.fetch(`${pathname}?registry=${registry}`, init);
}

function callbackDestroy(registry, sandboxId, nowMs) {
  const nowQuery = nowMs === undefined ? "" : `&nowMs=${nowMs}`;
  return worker.fetch(
    `/runners/${encodeURIComponent(sandboxId)}?registry=${registry}${nowQuery}`,
    { method: "DELETE" },
  );
}

async function extractOperatorRequestBodies({ documentPath, heading }) {
  const markdown = await readFile(join(REPOSITORY_ROOT, documentPath), "utf8");
  const lines = markdown.split("\n");
  const sectionStart = lines.indexOf(heading);
  assert.notEqual(sectionStart, -1, `${documentPath} has no ${heading} section`);
  const headingLevel = heading.match(/^#+/)[0].length;
  const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}} `);
  const relativeSectionEnd = lines
    .slice(sectionStart + 1)
    .findIndex((line) => nextHeadingPattern.test(line));
  const sectionEnd = relativeSectionEnd === -1
    ? lines.length
    : sectionStart + relativeSectionEnd + 1;
  const section = lines.slice(sectionStart, sectionEnd).join("\n");
  const jsonFencePattern = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  const bodies = [];

  for (const match of section.matchAll(jsonFencePattern)) {
    const line = sectionStart + section.slice(0, match.index).split("\n").length;
    bodies.push({
      body: JSON.parse(match[1]),
      source: `${documentPath}:${line}`,
    });
  }

  assert.ok(
    bodies.length > 0,
    `${documentPath} has no operator-route JSON request bodies`,
  );
  return bodies;
}

function substitutePlaceholders(documentedBody, index) {
  const body = structuredClone(documentedBody);
  const uuid = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  if (
    typeof body.observedSandboxInstanceId === "string" &&
    body.observedSandboxInstanceId.startsWith("<") &&
    body.observedSandboxInstanceId.endsWith(">")
  ) {
    body.observedSandboxInstanceId = String(index + 1).repeat(64);
  }
  if (typeof body.observedRegistration?.runnerName === "string") {
    body.observedRegistration.runnerName =
      body.observedRegistration.runnerName.replace("<uuid>", uuid);
  }
  return { body, sandboxId: `runner-${uuid}` };
}

async function recordStarting(
  registry,
  sandboxId,
  createdAtMs = Date.now(),
  githubRunnerName,
) {
  const createdAt = new Date(createdAtMs).toISOString();
  const response = await registryRequest(registry, "/record-starting", {
    sandboxId,
    runnerName: `${sandboxId}-name`,
    ...(githubRunnerName === undefined ? {} : { githubRunnerName }),
    correlationId: `${sandboxId}-correlation`,
    createdAt,
    createdAtMs,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.created, true);
  return { createdAt, createdAtMs };
}

async function seedActiveRows(registry, sandboxIdPrefix, count) {
  const response = await registryRequest(registry, "/seed-active-rows", {
    count,
    sandboxIdPrefix,
    createdAtMs: Date.now(),
  });
  assert.equal(response.status, 204, await response.text());
}

async function replayStartingWithErrors(registry, record) {
  const response = await registryRequest(
    registry,
    "/record-starting-with-errors",
    record,
  );
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  return JSON.parse(responseText);
}

async function claimNextDue(registry, nowMs) {
  const response = await registryRequest(registry, "/claim-next-due", {
    nowMs,
  });
  assert.equal(response.status, 200);
  const claim = await response.json();
  assert.equal(typeof claim.cleanupToken, "string");
  return claim;
}

async function configureSandbox(registry, sandboxId, destroyFailures = 0) {
  const response = await registryRequest(registry, "/configure-sandbox", {
    sandboxId,
    destroyFailures,
  });
  assert.equal(response.status, 204, await response.text());
}

async function sandboxStatus(registry, sandboxId) {
  const response = await registryRequest(registry, "/sandbox-status", {
    sandboxId,
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function runRegistryAlarm(registry, nowMs) {
  const response = await registryRequest(
    registry,
    "/alarm",
    nowMs === undefined ? {} : { nowMs },
  );
  assert.equal(response.status, 204, await response.text());
}

async function runAlarmCleanupBatchScenario(scenario) {
  const registry = `alarm-cleanup-${scenario}-${testRunId}`;
  const response = await registryRequest(
    registry,
    "/alarm-cleanup-batch",
    { nowMs: ORPHAN_TEST_NOW_MS, scenario },
  );
  return {
    responseStatus: response.status,
    ...(await response.json()),
  };
}

function runnerRecord(sandboxId, createdAtMs) {
  return {
    sandboxId,
    runnerName: `${sandboxId}-name`,
    githubRunnerName: `cloudflare-github-${sandboxId.slice("runner-".length)}`,
    correlationId: `${sandboxId}-correlation`,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  };
}

async function listRegistry(registry) {
  const response = await registryRequest(registry, "/runners");
  assert.equal(response.status, 200);
  return response.json();
}

async function driveCleanupRetries(
  registry,
  sandboxId,
  attemptCount = MAX_CLEANUP_ATTEMPTS,
) {
  const createdAtMs = Date.now();
  await recordStarting(registry, sandboxId, createdAtMs);
  let dueAtMs = createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS;
  const cycles = [];
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    const claim = await claimNextDue(registry, dueAtMs);
    const settledAtMs = dueAtMs + 1;
    const settlementResponse = await registryRequest(
      registry,
      "/settle-cleanup-retry-with-errors",
      {
        sandboxId,
        cleanupToken: claim.cleanupToken,
        settledAtMs,
      },
    );
    assert.equal(settlementResponse.status, 200);
    const settlement = await settlementResponse.json();
    assert.equal(settlement.released, true);
    const runner = (await listRegistry(registry)).runners[0];
    cycles.push({ attempt, claim, runner, settledAtMs, settlement });
    if (runner.cleanupDueAt !== null) {
      dueAtMs = Date.parse(runner.cleanupDueAt);
    }
  }
  return { createdAtMs, cycles };
}

async function listReclaimObservations(registry) {
  const response = await registryRequest(
    registry,
    "/orphan-reclaim-observations",
    {},
  );
  assert.equal(response.status, 200);
  return (await response.json()).observations;
}

async function recordTerminal(
  registry,
  sandboxId,
  createdAtMs,
  githubRunnerName = `cloudflare-github-${sandboxId.slice("runner-".length)}`,
) {
  await recordStarting(registry, sandboxId, createdAtMs, githubRunnerName);
  const cleanupStartedAt = new Date(createdAtMs + 1).toISOString();
  const cleanupResponse = await registryRequest(
    registry,
    "/begin-callback-cleanup",
    { sandboxId, cleanupStartedAt },
  );
  assert.equal(cleanupResponse.status, 200);
  const claim = await claimNextDue(
    registry,
    Date.parse(cleanupStartedAt) + CALLBACK_CLEANUP_HANDOFF_DELAY_MS,
  );
  const destroyedResponse = await registryRequest(registry, "/mark-destroyed", {
    sandboxId,
    destroyedAt: new Date(createdAtMs + 2).toISOString(),
    destroyedBy: "callback",
    cleanupToken: claim.cleanupToken,
  });
  assert.equal(destroyedResponse.status, 204);
  return (await listRegistry(registry)).runners.find(
    (runner) => runner.sandboxId === sandboxId,
  );
}

async function destroyOrphan(
  registry,
  sandboxId,
  observation = {},
  options = {},
) {
  const {
    nowMs = ORPHAN_TEST_NOW_MS,
    github = "absent",
    destroy = "complete",
    deleteResult = "complete",
    cancel = "complete",
    ownership = "held",
    claimLease = "current",
    sandboxGeneration = "unchanged",
    registrationDelete = "on",
    errorMessage,
    authorization = `Bearer ${CONTROL_TOKEN}`,
  } = options;
  const observedRegistryCondition =
    observation.observedRegistryCondition ?? "absent";
  const normalizedObservation = {
    observedRegistryCondition,
    expectedRevision: observedRegistryCondition === "absent" ? null : undefined,
    observedSandboxInstanceId: DEFAULT_SANDBOX_INSTANCE_ID,
    ...observation,
  };
  const runnerName = `cloudflare-${sandboxId.slice("runner-".length)}`;
  const observedRegistration = normalizedObservation.observedRegistration ?? (
    github === "absent" || github === "error" || github === "lease-expired"
      ? { outcome: "registration-not-found", runnerName }
      : {
          outcome: "registration-found",
          runnerId: 901,
          runnerName,
          status:
            github === "busy" || github === "online" ? "online" : "offline",
          busy: github === "busy",
        }
  );
  const query = new URLSearchParams({
    registry,
    nowMs: String(nowMs),
    github,
    destroy,
    delete: deleteResult,
    cancel,
    ownership,
    claimLease,
    sandboxGeneration,
    registrationDelete,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  });
  return worker.fetch(
    `/operator/orphans/${sandboxId}/destroy?${query}`,
    {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...normalizedObservation, observedRegistration }),
    },
  );
}

async function destroyAfterGrace(registry, sandboxId, observation, options) {
  const nowMs = options.nowMs ?? ORPHAN_TEST_NOW_MS;
  const firstResponse = await destroyOrphan(
    registry,
    sandboxId,
    observation,
    {
      ...options,
      destroy: "complete",
      nowMs: nowMs - ORPHAN_DESTROY_GRACE_MS,
    },
  );
  assert.equal(firstResponse.status, 409);
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.outcome, "inside-grace");
  assert.equal(firstBody.sandboxAgeMs, 0);
  return destroyOrphan(registry, sandboxId, observation, { ...options, nowMs });
}

function destroyAbsentOrphan(
  registry,
  sandboxId,
  { observation = {}, primeGrace = true, ...options } = {},
) {
  const absentObservation = {
    observedRegistryCondition: "absent",
    ...observation,
  };
  return primeGrace
    ? destroyAfterGrace(registry, sandboxId, absentObservation, options)
    : destroyOrphan(registry, sandboxId, absentObservation, options);
}

function destroyTerminalOrphan(
  registry,
  sandboxId,
  terminalRunner,
  { observation = {}, primeGrace = true, ...options } = {},
) {
  const terminalObservation = {
    observedRegistryCondition: "terminal",
    expectedRevision: terminalRunner.revision,
    observedSandboxInstanceId:
      terminalRunner.orphanInstanceId ?? DEFAULT_SANDBOX_INSTANCE_ID,
    observedRegistration: {
      outcome: "registration-not-found",
      runnerName: terminalRunner.githubRunnerName ?? terminalRunner.runnerName,
    },
    ...observation,
  };
  return primeGrace
    ? destroyAfterGrace(registry, sandboxId, terminalObservation, options)
    : destroyOrphan(registry, sandboxId, terminalObservation, options);
}

async function recordReclaimRunner(
  registry,
  sandboxId,
  createdAtMs = ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS,
  githubRunnerName,
) {
  const response = await registryRequest(registry, "/record-starting", {
    sandboxId,
    runnerName: `cloudflare-${sandboxId.slice("runner-".length)}`,
    ...(githubRunnerName === undefined ? {} : { githubRunnerName }),
    correlationId: `${sandboxId}-correlation`,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  });
  assert.equal(response.status, 200);
  const onlineResponse = await registryRequest(registry, "/mark-online", {
    sandboxId,
  });
  assert.equal(onlineResponse.status, 204);
  return (await listRegistry(registry)).runners[0];
}

function reclaimRequestBody(sandboxId, expectedRevision, overrides = {}) {
  return {
    observedRegistryCondition: "live",
    expectedRevision,
    cloudflareAbsence: {
      enumerationOutcome: "exhausted",
      instanceCount: 3,
      liveInstanceCount: 2,
      pageCount: 1,
      applicationId: "11111111-1111-4111-8111-111111111111",
      ...(overrides.cloudflareAbsence ?? {}),
    },
    observedRegistration: {
      outcome: "registration-not-found",
      runnerName: `cloudflare-${sandboxId.slice("runner-".length)}`,
      ...(overrides.observedRegistration ?? {}),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([field]) =>
          field !== "cloudflareAbsence" && field !== "observedRegistration",
      ),
    ),
  };
}

function reclaimAbsent(
  registry,
  sandboxId,
  expectedRevision,
  {
    nowMs = ORPHAN_TEST_NOW_MS,
    github = "absent",
    destroy = "complete",
    claimRace,
    authorization = `Bearer ${CONTROL_TOKEN}`,
    body = {},
    rawBody,
  } = {},
) {
  const query = new URLSearchParams({
    registry,
    nowMs: String(nowMs),
    github,
    destroy,
    ...(claimRace === undefined ? {} : { claimRace }),
  });
  return worker.fetch(
    `/operator/orphans/${sandboxId}/reclaim?${query}`,
    {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        rawBody ?? reclaimRequestBody(sandboxId, expectedRevision, body),
      ),
    },
  );
}

async function primeReclaimObservation(
  registry,
  sandboxId,
  nowMs = ORPHAN_TEST_NOW_MS,
) {
  const runner = await recordReclaimRunner(
    registry,
    sandboxId,
    nowMs - ORPHAN_DESTROY_GRACE_MS,
    `cloudflare-${sandboxId.slice("runner-".length)}`,
  );
  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    { nowMs },
  );
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.outcome, "absence-recorded");
  return { body, runner };
}

test("resolveRunnerScope resolves every configured scope [mutation: derive scope from the runner repository]", async () => {
  const response = await worker.fetch("/production-runner-scope");
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.resolutions, {
    absent: {
      type: "repository",
      repository: "example/job-repository",
    },
    repository: {
      type: "repository",
      repository: "example/job-repository",
    },
    organization: { type: "organization", organization: "example" },
    explicit: { type: "organization", organization: "acme" },
  });
  assert.match(
    body.badResolutionError,
    /GITHUB_RUNNER_SCOPE must be repository, organization/u,
  );
});

test("validateEnvironment accepts each scope and rejects malformed organizations [mutation: skip scope validation at boot]", async () => {
  const response = await worker.fetch("/production-runner-scope");
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(
    body.accepted,
    [
      "absent",
      "undefined",
      "null",
      "empty",
      "whitespace",
      "repository",
      "organization",
      "explicit",
    ].map((label) => ({ label, accepted: true })),
  );
  assert.deepEqual(
    body.rejected.map(({ value, rejected }) => ({ value, rejected })),
    [
      "owner",
      "organization:",
      "organization:acme/team",
      "organization:ac*me",
      "organization:ac..me",
    ].map((value) => ({ value, rejected: true })),
  );
});

test("markOnline accepts one starting row and rejects a stale transition", async () => {
  const registry = `mark-online-${testRunId}`;
  const sandboxId = "runner-mark-online";
  const { createdAt, createdAtMs } = await recordStarting(registry, sandboxId);

  const onlineResponse = await registryRequest(registry, "/mark-online", {
    sandboxId,
  });
  assert.equal(onlineResponse.status, 204);

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), {
    runners: [
      {
        sandboxId,
        runnerName: `${sandboxId}-name`,
        githubRunnerName: null,
        correlationId: `${sandboxId}-correlation`,
        repository: "example/runner-test",
        createdAt,
        orphanInstanceId: null,
        state: "online",
        cleanupStartedAt: null,
        cleanupDueAt: new Date(
          createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS,
        ).toISOString(),
        cleanupRequestedBy: null,
        cleanupAttempts: 0,
        busySinceMs: null,
        cleanupStalled: false,
        destroyedAt: null,
        destroyedBy: null,
        revision: 1,
      },
    ],
    pageSize: RUNNER_LIST_PAGE_SIZE,
    nextCursor: null,
  });

  const staleResponse = await registryRequest(registry, "/mark-online", {
    sandboxId,
  });
  assert.equal(staleResponse.status, 409);
  assert.deepEqual(await staleResponse.json(), {
    error: `Runner registry row changed before ${sandboxId} became online`,
  });
});

test("recordStarting stores the runner repository", async () => {
  const registry = `runner-repository-${testRunId}`;
  const sandboxId = "runner-repository";
  const repository = "example/second-repository";
  const createdAtMs = Date.now();
  const response = await registryRequest(registry, "/record-starting", {
    sandboxId,
    runnerName: `${sandboxId}-name`,
    correlationId: `${sandboxId}-correlation`,
    repository,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runner.repository, repository);
  const page = await listRegistry(registry);
  assert.equal(page.runners.length, 1);
  assert.equal(page.runners[0].repository, repository);
});

test("recordStarting persists and lists the GitHub runner name", async () => {
  const registry = `github-runner-name-${testRunId}`;
  const sandboxId = "runner-github-runner-name";
  const githubRunnerName = "cloudflare-101-501";
  const createdAtMs = Date.now();
  const response = await registryRequest(registry, "/record-starting", {
    sandboxId,
    runnerName: `${sandboxId}-name`,
    githubRunnerName,
    correlationId: `${sandboxId}-correlation`,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runner.githubRunnerName, githubRunnerName);

  const page = await listRegistry(registry);
  assert.equal(page.runners.length, 1);
  assert.equal(page.runners[0].githubRunnerName, githubRunnerName);
});

test("recordStarting defaults the GitHub runner name to null", async () => {
  const registry = `legacy-github-runner-name-${testRunId}`;
  const sandboxId = "runner-legacy-github-runner-name";
  const createdAtMs = Date.now();
  const response = await registryRequest(registry, "/record-starting", {
    sandboxId,
    runnerName: `${sandboxId}-name`,
    correlationId: `${sandboxId}-correlation`,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runner.githubRunnerName, null);

  const page = await listRegistry(registry);
  assert.equal(page.runners.length, 1);
  assert.equal(page.runners[0].githubRunnerName, null);
});

test("beginCallbackCleanup reports whether one active row changed", async () => {
  const registry = `callback-cleanup-${testRunId}`;
  const sandboxId = "runner-callback-cleanup";
  const { createdAt } = await recordStarting(registry, sandboxId);

  const cleanupStartedAt = new Date(Date.now() + 60_000).toISOString();
  const cleanupResponse = await registryRequest(
    registry,
    "/begin-callback-cleanup",
    { sandboxId, cleanupStartedAt },
  );
  assert.equal(cleanupResponse.status, 200);
  assert.deepEqual(await cleanupResponse.json(), {
    claimed: true,
    reason: "scheduled",
  });

  const earlyReconcileResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    {
      sandboxId,
      expectedRevision: 1,
      reconcileToken: "early-reconcile-token",
      cleanupStartedAt: new Date(
        Date.parse(cleanupStartedAt) +
          CALLBACK_CLEANUP_HANDOFF_DELAY_MS -
          1,
      ).toISOString(),
    },
  );
  assert.equal(earlyReconcileResponse.status, 200);
  assert.deepEqual(await earlyReconcileResponse.json(), {
    claimed: false,
    reason: "already-scheduled",
    cleanupAttempts: 0,
    cleanupStalled: false,
  });

  const claim = await claimNextDue(
    registry,
    Date.parse(cleanupStartedAt) + CALLBACK_CLEANUP_HANDOFF_DELAY_MS,
  );
  const claimedCleanupStartedAt = new Date(
    Date.parse(cleanupStartedAt) + CALLBACK_CLEANUP_HANDOFF_DELAY_MS,
  ).toISOString();

  const destroyedAt = new Date().toISOString();
  const destroyedResponse = await registryRequest(registry, "/mark-destroyed", {
    sandboxId,
    destroyedAt,
    destroyedBy: "callback",
    cleanupToken: claim.cleanupToken,
  });
  assert.equal(destroyedResponse.status, 204);

  const scheduledAlarmResponse = await registryRequest(
    registry,
    "/scheduled-alarm",
    {},
  );
  assert.equal(scheduledAlarmResponse.status, 200);
  const scheduledAlarm = await scheduledAlarmResponse.json();
  assert.equal(typeof scheduledAlarm.alarmAt, "number");

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), {
    runners: [
      {
        sandboxId,
        runnerName: `${sandboxId}-name`,
        githubRunnerName: null,
        correlationId: `${sandboxId}-correlation`,
        repository: "example/runner-test",
        createdAt,
        orphanInstanceId: null,
        state: "destroyed",
        cleanupStartedAt: claimedCleanupStartedAt,
        cleanupDueAt: null,
        cleanupRequestedBy: null,
        cleanupAttempts: 1,
        busySinceMs: null,
        cleanupStalled: false,
        destroyedAt,
        destroyedBy: "callback",
        revision: 3,
      },
    ],
    pageSize: RUNNER_LIST_PAGE_SIZE,
    nextCursor: null,
  });

  const staleResponse = await registryRequest(
    registry,
    "/begin-callback-cleanup",
    { sandboxId, cleanupStartedAt },
  );
  assert.equal(staleResponse.status, 200);
  assert.deepEqual(await staleResponse.json(), {
    claimed: false,
    reason: "already-destroyed",
  });
});

test("claimForReconcile reports whether the expected revision changed", async () => {
  const registry = `reconcile-claim-${testRunId}`;
  const sandboxId = "runner-reconcile-claim";
  await recordStarting(registry, sandboxId);

  const claim = {
    sandboxId,
    expectedRevision: 0,
    reconcileToken: "reconcile-token",
    cleanupStartedAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const claimResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    claim,
  );
  assert.equal(claimResponse.status, 200);
  assert.deepEqual(await claimResponse.json(), {
    claimed: true,
    reason: "claimed",
  });

  const staleResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    claim,
  );
  assert.equal(staleResponse.status, 200);
  assert.deepEqual(await staleResponse.json(), {
    claimed: false,
    reason: "contended",
  });

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(body.runners[0].state, "destroying");
});

test("a stale cleanup claim can be replaced", async () => {
  const registry = `stale-reconcile-claim-${testRunId}`;
  const sandboxId = "runner-stale-reconcile-claim";
  await recordStarting(registry, sandboxId);

  const firstStartedAtMs = Date.now() + 60_000;
  const firstResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    {
      sandboxId,
      expectedRevision: 0,
      reconcileToken: "first-reconcile-token",
      cleanupStartedAt: new Date(firstStartedAtMs).toISOString(),
    },
  );
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(await firstResponse.json(), {
    claimed: true,
    reason: "claimed",
  });

  const freshResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    {
      sandboxId,
      expectedRevision: 1,
      reconcileToken: "fresh-reconcile-token",
      cleanupStartedAt: new Date(
        firstStartedAtMs + CLEANUP_CLAIM_STALE_MS - 1,
      ).toISOString(),
    },
  );
  assert.equal(freshResponse.status, 200);
  assert.deepEqual(await freshResponse.json(), {
    claimed: false,
    reason: "contended",
  });

  const staleStartedAtMs = firstStartedAtMs + CLEANUP_CLAIM_STALE_MS + 1;
  const staleResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    {
      sandboxId,
      expectedRevision: 1,
      reconcileToken: "replacement-reconcile-token",
      cleanupStartedAt: new Date(staleStartedAtMs).toISOString(),
    },
  );
  assert.equal(staleResponse.status, 200);
  assert.deepEqual(await staleResponse.json(), {
    claimed: true,
    reason: "claimed",
  });

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(body.runners[0].state, "destroying");
  assert.equal(Object.hasOwn(body.runners[0], "reconcileToken"), false);
  assert.equal(body.runners[0].revision, 2);
});

test("cleanup retries park exactly at the bound and log once [mutation: retry unconditionally]", async () => {
  const registry = `cleanup-attempt-bound-${testRunId}`;
  const sandboxId = "runner-cleanup-attempt-bound";
  const { cycles } = await driveCleanupRetries(registry, sandboxId);

  assert.equal(cycles.length, MAX_CLEANUP_ATTEMPTS);
  for (const cycle of cycles.slice(0, -1)) {
    assert.equal(cycle.claim.runner.cleanupAttempts, cycle.attempt);
    assert.equal(cycle.runner.cleanupAttempts, cycle.attempt);
    assert.equal(cycle.runner.cleanupStalled, false);
    assert.equal(
      cycle.runner.cleanupDueAt,
      new Date(cycle.settledAtMs + CLEANUP_RETRY_DELAY_MS).toISOString(),
    );
    assert.deepEqual(cycle.settlement.errors, []);
  }

  const penultimate = cycles[MAX_CLEANUP_ATTEMPTS - 2];
  assert.equal(penultimate.runner.cleanupAttempts, MAX_CLEANUP_ATTEMPTS - 1);
  assert.equal(
    penultimate.runner.cleanupDueAt,
    new Date(
      penultimate.settledAtMs + CLEANUP_RETRY_DELAY_MS,
    ).toISOString(),
  );

  const final = cycles.at(-1);
  assert.equal(final.claim.runner.cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  assert.equal(final.runner.cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  assert.equal(final.runner.cleanupDueAt, null);
  assert.equal(final.runner.cleanupStalled, true);
  assert.equal(final.settlement.alarmAt, null);
  assert.equal(final.settlement.errors.length, 1);
  assert.deepEqual(JSON.parse(final.settlement.errors[0]), {
    message: "runner registry cleanup stalled",
    sandboxId,
    runnerName: `${sandboxId}-name`,
    cleanupAttempts: MAX_CLEANUP_ATTEMPTS,
    cleanupRequestedBy: "alarm",
    remedy: "scripts/orphan-audit.sh --destroy",
  });

  const laterClaimResponse = await registryRequest(
    registry,
    "/claim-next-due",
    { nowMs: Date.now() + 365 * 24 * 60 * 60 * 1000 },
  );
  assert.equal(laterClaimResponse.status, 200);
  assert.equal(await laterClaimResponse.json(), null);
  const alarmResponse = await registryRequest(
    registry,
    "/scheduled-alarm",
    {},
  );
  assert.equal(alarmResponse.status, 200);
  assert.deepEqual(await alarmResponse.json(), { alarmAt: null });
});

test("a parked cleanup remains visible and can be reclaimed [mutation: reject a null due time]", async () => {
  const registry = `parked-cleanup-reclaim-${testRunId}`;
  const sandboxId = "runner-parked-cleanup-reclaim";
  const { createdAtMs, cycles } = await driveCleanupRetries(
    registry,
    sandboxId,
  );
  const parked = cycles.at(-1).runner;

  assert.equal(parked.state, "destroying");
  assert.equal(parked.cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  assert.equal(parked.cleanupStalled, true);
  const activeResponse = await registryRequest(
    registry,
    "/list-active-before",
    { cutoffMs: createdAtMs + 1 },
  );
  assert.equal(activeResponse.status, 200);
  const activePage = await activeResponse.json();
  assert.equal(activePage.runners.length, 1);
  assert.equal(activePage.runners[0].sandboxId, sandboxId);
  assert.equal(activePage.runners[0].cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  assert.equal(activePage.runners[0].cleanupStalled, true);

  const cleanupStartedAtMs = Date.now() + 60_000;
  const claimResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    {
      sandboxId,
      expectedRevision: parked.revision,
      reconcileToken: "parked-reconcile-token",
      cleanupStartedAt: new Date(cleanupStartedAtMs).toISOString(),
    },
  );
  assert.equal(claimResponse.status, 200);
  assert.deepEqual(await claimResponse.json(), {
    claimed: true,
    reason: "claimed",
  });

  const reclaimed = (await listRegistry(registry)).runners[0];
  assert.equal(reclaimed.cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  assert.equal(reclaimed.cleanupStalled, false);
  assert.equal(
    reclaimed.cleanupDueAt,
    new Date(cleanupStartedAtMs + CLEANUP_CLAIM_STALE_MS).toISOString(),
  );
});

test("claimForReconcile cannot reset the cleanup attempt bound [mutation: reset the attempt counter on reconcile claim]", async () => {
  const registry = `bounded-reconcile-claim-${testRunId}`;
  const sandboxId = "runner-bounded-reconcile-claim";
  const { cycles } = await driveCleanupRetries(registry, sandboxId);
  const parked = cycles.at(-1).runner;
  const cleanupStartedAtMs = Date.now() + 60_000;
  const reconcileToken = "bounded-reconcile-token";

  const claimResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    {
      sandboxId,
      expectedRevision: parked.revision,
      reconcileToken,
      cleanupStartedAt: new Date(cleanupStartedAtMs).toISOString(),
    },
  );
  assert.equal(claimResponse.status, 200);
  assert.deepEqual(await claimResponse.json(), {
    claimed: true,
    reason: "claimed",
  });

  const claimed = (await listRegistry(registry)).runners[0];
  assert.equal(claimed.cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  const settlementResponse = await registryRequest(
    registry,
    "/settle-cleanup-retry-with-errors",
    {
      sandboxId,
      cleanupToken: reconcileToken,
      settledAtMs: cleanupStartedAtMs + 1,
    },
  );
  assert.equal(settlementResponse.status, 200);
  assert.equal((await settlementResponse.json()).released, true);

  const reparks = (await listRegistry(registry)).runners[0];
  assert.equal(reparks.cleanupDueAt, null);
  assert.equal(reparks.cleanupStalled, true);
});

test("a reconcile claim on a healthy row still starts from a zero attempt count [mutation: increment instead of preserving]", async () => {
  const registry = `healthy-reconcile-claim-${testRunId}`;
  const sandboxId = "runner-healthy-reconcile-claim";
  const createdAtMs = Date.now();
  await recordStarting(registry, sandboxId, createdAtMs);
  const healthy = (await listRegistry(registry)).runners[0];
  const cleanupStartedAtMs = createdAtMs + 60_000;

  const claimResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    {
      sandboxId,
      expectedRevision: healthy.revision,
      reconcileToken: "healthy-reconcile-token",
      cleanupStartedAt: new Date(cleanupStartedAtMs).toISOString(),
    },
  );
  assert.equal(claimResponse.status, 200);
  assert.deepEqual(await claimResponse.json(), {
    claimed: true,
    reason: "claimed",
  });

  const claimed = (await listRegistry(registry)).runners[0];
  assert.equal(claimed.cleanupAttempts, 0);
  assert.equal(
    claimed.cleanupDueAt,
    new Date(cleanupStartedAtMs + CLEANUP_CLAIM_STALE_MS).toISOString(),
  );
});

test("rearmStalledCleanup re-arms one parked cleanup [mutation: refuse the parked update]", async () => {
  const registry = `rearm-stalled-cleanup-${testRunId}`;
  const sandboxId = "runner-rearm-stalled-cleanup";
  const { cycles } = await driveCleanupRetries(registry, sandboxId);
  const parked = cycles.at(-1).runner;
  const rearmedAtMs = Date.now() + 60_000;
  const rearmedAt = new Date(rearmedAtMs).toISOString();

  const response = await registryRequest(
    registry,
    "/rearm-stalled-cleanup",
    { sandboxId, rearmedAt },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rearmed: true });

  const rearmed = (await listRegistry(registry)).runners[0];
  assert.equal(rearmed.cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  assert.equal(rearmed.cleanupStartedAt, rearmedAt);
  assert.equal(rearmed.cleanupDueAt, rearmedAt);
  assert.equal(rearmed.cleanupStalled, false);
  assert.equal(rearmed.revision, parked.revision + 1);
  const alarmResponse = await registryRequest(
    registry,
    "/scheduled-alarm",
    {},
  );
  assert.equal(alarmResponse.status, 200);
  assert.deepEqual(await alarmResponse.json(), { alarmAt: rearmedAtMs });

  const claim = await claimNextDue(registry, rearmedAtMs);
  assert.equal(claim.runner.sandboxId, sandboxId);
  assert.equal(claim.runner.cleanupAttempts, MAX_CLEANUP_ATTEMPTS + 1);
});

test("a re-armed parked cleanup re-parks after one attempt [mutation: reset the attempt counter on re-arm]", async () => {
  const registry = `rearmed-cleanup-reparks-${testRunId}`;
  const sandboxId = "runner-rearmed-cleanup-reparks";
  await driveCleanupRetries(registry, sandboxId);
  const rearmedAtMs = Date.now() + 60_000;
  const rearmedAt = new Date(rearmedAtMs).toISOString();

  const rearmResponse = await registryRequest(
    registry,
    "/rearm-stalled-cleanup",
    { sandboxId, rearmedAt },
  );
  assert.equal(rearmResponse.status, 200);
  assert.deepEqual(await rearmResponse.json(), { rearmed: true });
  const rearmed = (await listRegistry(registry)).runners[0];
  assert.equal(rearmed.cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  assert.equal(rearmed.cleanupStalled, false);

  const claim = await claimNextDue(registry, rearmedAtMs);
  assert.equal(
    claim.runner.cleanupAttempts,
    MAX_CLEANUP_ATTEMPTS + 1,
  );
  const settlementResponse = await registryRequest(
    registry,
    "/settle-cleanup-retry-with-errors",
    {
      sandboxId,
      cleanupToken: claim.cleanupToken,
      settledAtMs: rearmedAtMs + 1,
    },
  );
  assert.equal(settlementResponse.status, 200);
  assert.equal((await settlementResponse.json()).released, true);

  const reparks = (await listRegistry(registry)).runners[0];
  assert.equal(reparks.cleanupDueAt, null);
  assert.equal(reparks.cleanupStalled, true);
  const laterClaimResponse = await registryRequest(
    registry,
    "/claim-next-due",
    { nowMs: Date.now() + 365 * 24 * 60 * 60 * 1000 },
  );
  assert.equal(laterClaimResponse.status, 200);
  assert.equal(await laterClaimResponse.json(), null);
  const alarmResponse = await registryRequest(
    registry,
    "/scheduled-alarm",
    {},
  );
  assert.equal(alarmResponse.status, 200);
  assert.deepEqual(await alarmResponse.json(), { alarmAt: null });
});

test("repeated cleanup callbacks cannot outrun the cleanup attempt bound [mutation: reset the attempt counter on re-arm]", async () => {
  const registry = `repeated-cleanup-callbacks-${testRunId}`;
  const sandboxId = "runner-repeated-cleanup-callbacks";
  await driveCleanupRetries(registry, sandboxId);
  const firstRearmedAtMs = Date.now() + 60_000;
  let claimsGranted = 0;

  // Three nudges cover the first re-arm and two repeated re-arms. This proves
  // that counter preservation continues across repeated external callbacks.
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    const rearmedAtMs = firstRearmedAtMs + iteration - 1;
    const rearmResponse = await registryRequest(
      registry,
      "/rearm-stalled-cleanup",
      {
        sandboxId,
        rearmedAt: new Date(rearmedAtMs).toISOString(),
      },
    );
    assert.equal(rearmResponse.status, 200);
    assert.deepEqual(await rearmResponse.json(), { rearmed: true });
    const rearmed = (await listRegistry(registry)).runners[0];
    assert.equal(
      rearmed.cleanupAttempts,
      MAX_CLEANUP_ATTEMPTS + iteration - 1,
    );

    const claim = await claimNextDue(registry, rearmedAtMs);
    claimsGranted += 1;
    assert.equal(
      claim.runner.cleanupAttempts,
      MAX_CLEANUP_ATTEMPTS + iteration,
    );
    const settlementResponse = await registryRequest(
      registry,
      "/settle-cleanup-retry-with-errors",
      {
        sandboxId,
        cleanupToken: claim.cleanupToken,
        settledAtMs: rearmedAtMs + 1,
      },
    );
    assert.equal(settlementResponse.status, 200);
    assert.equal((await settlementResponse.json()).released, true);

    const reparks = (await listRegistry(registry)).runners[0];
    assert.equal(
      reparks.cleanupAttempts,
      MAX_CLEANUP_ATTEMPTS + iteration,
    );
    assert.equal(reparks.cleanupDueAt, null);
    assert.equal(reparks.cleanupStalled, true);
  }

  assert.equal(claimsGranted, 3);
});

test("rearmStalledCleanup refuses every non-parked row [mutation: widen the parked predicate]", async () => {
  const registry = `refuse-rearm-cleanup-${testRunId}`;
  const armedSandboxId = "runner-refuse-rearm-armed";
  const startingSandboxId = "runner-refuse-rearm-starting";
  const onlineSandboxId = "runner-refuse-rearm-online";
  const missingSandboxId = "runner-refuse-rearm-missing";
  const createdAtMs = Date.now();
  await recordStarting(registry, armedSandboxId, createdAtMs);
  await recordStarting(registry, startingSandboxId, createdAtMs + 1);
  const onlineResponse = await registryRequest(registry, "/record-online", {
    record: runnerRecord(onlineSandboxId, createdAtMs + 2),
  });
  assert.equal(onlineResponse.status, 200);
  const cleanupStartedAt = new Date(createdAtMs + 3).toISOString();
  const cleanupResponse = await registryRequest(
    registry,
    "/begin-callback-cleanup",
    { sandboxId: armedSandboxId, cleanupStartedAt },
  );
  assert.equal(cleanupResponse.status, 200);
  const before = (await listRegistry(registry)).runners;
  const revisionBySandbox = new Map(
    before.map((runner) => [runner.sandboxId, runner.revision]),
  );
  const rearmedAt = new Date(createdAtMs + 60_000).toISOString();
  const cases = [
    [armedSandboxId, "already-armed"],
    [startingSandboxId, "not-destroying"],
    [onlineSandboxId, "not-destroying"],
    [missingSandboxId, "not-found"],
  ];

  for (const [sandboxId, reason] of cases) {
    const response = await registryRequest(
      registry,
      "/rearm-stalled-cleanup",
      { sandboxId, rearmedAt },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { rearmed: false, reason });
  }

  const after = (await listRegistry(registry)).runners;
  for (const runner of after) {
    assert.equal(
      runner.revision,
      revisionBySandbox.get(runner.sandboxId),
      runner.sandboxId,
    );
  }
});

test("the callback re-arms a parked cleanup [mutation: omit callback rearm]", async () => {
  const registry = `callback-rearm-stalled-${testRunId}`;
  const sandboxId = "runner-callback-rearm-stalled";
  const { cycles } = await driveCleanupRetries(registry, sandboxId);
  const parked = cycles.at(-1).runner;

  const response = await callbackDestroy(
    registry,
    sandboxId,
    Date.now() + 60_000,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    cleanupStatus: "rearmed",
    sandboxId,
    cleanupAttempts: MAX_CLEANUP_ATTEMPTS,
  });
  const rearmed = (await listRegistry(registry)).runners[0];
  assert.equal(rearmed.cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  assert.equal(rearmed.cleanupStalled, false);
  assert.equal(rearmed.cleanupDueAt, rearmed.cleanupStartedAt);
  assert.equal(rearmed.revision, parked.revision + 1);
});

test("the callback reports an armed failed cleanup [mutation: omit refused attempt count]", async () => {
  const registry = `callback-armed-retry-${testRunId}`;
  const sandboxId = "runner-callback-armed-retry";
  await driveCleanupRetries(registry, sandboxId, 1);
  const before = (await listRegistry(registry)).runners[0];
  assert.ok(before.cleanupAttempts > 0);

  const response = await callbackDestroy(
    registry,
    sandboxId,
    Date.now() + 60_000,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    cleanupStatus: "already-scheduled",
    sandboxId,
    cleanupAttempts: before.cleanupAttempts,
  });
  assert.deepEqual((await listRegistry(registry)).runners[0], before);
});

test("the callback reports a fresh armed cleanup [mutation: omit zero attempt count]", async () => {
  const registry = `callback-fresh-cleanup-${testRunId}`;
  const sandboxId = "runner-callback-fresh-cleanup";
  const createdAtMs = Date.now();
  await recordStarting(registry, sandboxId, createdAtMs);
  const cleanupResponse = await registryRequest(
    registry,
    "/begin-callback-cleanup",
    {
      sandboxId,
      cleanupStartedAt: new Date(createdAtMs + 1).toISOString(),
    },
  );
  assert.equal(cleanupResponse.status, 200);
  const before = (await listRegistry(registry)).runners[0];

  const response = await callbackDestroy(
    registry,
    sandboxId,
    Date.now() + 60_000,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    cleanupStatus: "already-scheduled",
    sandboxId,
    cleanupAttempts: 0,
  });
  assert.deepEqual((await listRegistry(registry)).runners[0], before);
});

test("a callback-rearmed cleanup reaches destroyed [mutation: leave the cleanup parked]", async () => {
  const registry = `callback-rearmed-destroy-${testRunId}`;
  const sandboxId = "runner-callback-rearmed-destroy";
  await configureSandbox(registry, sandboxId);
  await driveCleanupRetries(registry, sandboxId);

  const response = await callbackDestroy(
    registry,
    sandboxId,
    Date.now() + 60_000,
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    cleanupStatus: "rearmed",
    sandboxId,
    cleanupAttempts: MAX_CLEANUP_ATTEMPTS,
  });
  const alarmResponse = await registryRequest(
    registry,
    "/scheduled-alarm",
    {},
  );
  assert.equal(alarmResponse.status, 200);
  const { alarmAt } = await alarmResponse.json();
  assert.equal(typeof alarmAt, "number");

  await runRegistryAlarm(registry, alarmAt);

  const runner = (await listRegistry(registry)).runners[0];
  assert.equal(runner.state, "destroyed");
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 1,
    destroyed: 1,
  });
});

test("markOnline refuses a row claimed for reconcile", async () => {
  const registry = `mark-online-claim-${testRunId}`;
  const sandboxId = "runner-mark-online-claim";
  await recordStarting(registry, sandboxId);

  const claimResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    {
      sandboxId,
      expectedRevision: 0,
      reconcileToken: "reconcile-token",
      cleanupStartedAt: new Date(Date.now() + 60_000).toISOString(),
    },
  );
  assert.equal(claimResponse.status, 200);
  assert.deepEqual(await claimResponse.json(), {
    claimed: true,
    reason: "claimed",
  });

  const onlineResponse = await registryRequest(registry, "/mark-online", {
    sandboxId,
  });
  assert.equal(onlineResponse.status, 409);
  assert.deepEqual(await onlineResponse.json(), {
    error: `Runner registry row changed before ${sandboxId} became online`,
  });
});

test("beginCallbackCleanup does not replace a reconcile claim", async () => {
  const registry = `callback-reconcile-claim-${testRunId}`;
  const sandboxId = "runner-callback-reconcile-claim";
  await recordStarting(registry, sandboxId);

  const reconcileToken = "reconcile-token";
  const reconcileStartedAt = new Date(Date.now() + 60_000).toISOString();
  const claimResponse = await registryRequest(
    registry,
    "/claim-for-reconcile",
    {
      sandboxId,
      expectedRevision: 0,
      reconcileToken,
      cleanupStartedAt: reconcileStartedAt,
    },
  );
  assert.equal(claimResponse.status, 200);
  assert.deepEqual(await claimResponse.json(), {
    claimed: true,
    reason: "claimed",
  });

  const callbackResponse = await registryRequest(
    registry,
    "/begin-callback-cleanup",
    {
      sandboxId,
      cleanupStartedAt: new Date(Date.now() + 120_000).toISOString(),
    },
  );
  assert.equal(callbackResponse.status, 200);
  assert.deepEqual(await callbackResponse.json(), {
    claimed: false,
    reason: "contended",
  });

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(Object.hasOwn(body.runners[0], "reconcileToken"), false);
  assert.equal(body.runners[0].cleanupStartedAt, reconcileStartedAt);
  assert.equal(body.runners[0].state, "destroying");
  assert.equal(body.runners[0].revision, 1);
});

test("the harness reports SQL failures as server errors", async () => {
  const registry = `sql-error-${testRunId}`;
  const sandboxId = "runner-sql-error";
  await recordStarting(registry, sandboxId);

  const cleanupStartedAt = new Date(Date.now() + 60_000).toISOString();
  const cleanupResponse = await registryRequest(
    registry,
    "/begin-callback-cleanup",
    {
      sandboxId,
      cleanupStartedAt,
    },
  );
  assert.equal(cleanupResponse.status, 200);
  const claim = await claimNextDue(
    registry,
    Date.parse(cleanupStartedAt) + CALLBACK_CLEANUP_HANDOFF_DELAY_MS,
  );

  const invalidResponse = await registryRequest(registry, "/mark-destroyed", {
    sandboxId,
    destroyedAt: "2026-08-20T12:02:00.000Z",
    destroyedBy: "invalid-destroyer",
    cleanupToken: claim.cleanupToken,
  });
  assert.equal(invalidResponse.status, 500);
});

test("listRunners walks the retained fleet inside the audit page budget", async () => {
  const registry = `list-page-${testRunId}`;
  const seededRowCount = 10_674;
  const terminalCreatedAtMs = Date.now();
  const seedResponse = await registryRequest(
    registry,
    "/seed-terminal-rows",
    {
      count: seededRowCount,
      createdAtMs: terminalCreatedAtMs,
      tieAtIndex: seededRowCount - 98,
    },
  );
  assert.equal(seedResponse.status, 204, await seedResponse.text());
  const activeRows = [
    ["runner-active-order-oldest", terminalCreatedAtMs - 300_000],
    ["runner-active-order-middle", terminalCreatedAtMs - 200_000],
    ["runner-active-order-newest", terminalCreatedAtMs - 100_000],
  ];
  for (const [sandboxId, createdAtMs] of activeRows) {
    await recordStarting(registry, sandboxId, createdAtMs);
  }

  const seenRunners = [];
  let cursor = null;
  let pageCount = 0;
  do {
    const cursorQuery = cursor === null
      ? ""
      : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await worker.fetch(
      `/runners?registry=${registry}${cursorQuery}`,
    );
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.pageSize, RUNNER_LIST_PAGE_SIZE);
    assert.equal(page.nextCursor === null, page.runners.length < page.pageSize);
    seenRunners.push(...page.runners);
    cursor = page.nextCursor;
    pageCount += 1;
  } while (cursor !== null);

  assert.equal(pageCount, 107);
  assert.deepEqual(
    seenRunners.slice(0, 3).map((runner) => runner.sandboxId),
    [
      "runner-active-order-newest",
      "runner-active-order-middle",
      "runner-active-order-oldest",
    ],
  );
  const terminalRanks = seenRunners.map((runner) =>
    runner.state === "destroyed" ? 1 : 0
  );
  assert.equal(
    terminalRanks.every(
      (rank, index) => index === 0 || rank >= terminalRanks[index - 1],
    ),
    true,
  );
  assert.equal(seenRunners.length, seededRowCount + activeRows.length);
  assert.equal(
    new Set(seenRunners.map((runner) => runner.sandboxId)).size,
    seededRowCount + activeRows.length,
  );
  assert.equal(
    seenRunners[99].sandboxId,
    `runner-page-${String(seededRowCount - 97).padStart(5, "0")}`,
  );
  assert.equal(
    seenRunners[100].sandboxId,
    `runner-page-${String(seededRowCount - 98).padStart(5, "0")}`,
  );
});

test("recordStarting bounds active rows at sandbox capacity", async () => {
  const registry = `active-capacity-${testRunId}`;
  await seedActiveRows(
    registry,
    "runner-active-capacity-",
    MAX_ACTIVE_RUNNERS,
  );

  const overflowResponse = await registryRequest(
    registry,
    "/record-starting",
    {
      sandboxId: "runner-active-capacity-overflow",
      runnerName: "runner-active-capacity-overflow-name",
      correlationId: "runner-active-capacity-overflow-correlation",
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
    },
  );
  assert.equal(overflowResponse.status, 500);
  assert.deepEqual(await overflowResponse.json(), {
    error: `Runner registry active capacity is ${MAX_ACTIVE_RUNNERS}`,
  });

  const replayResponse = await registryRequest(
    registry,
    "/record-starting",
    {
      sandboxId: "runner-active-capacity-replay",
      runnerName: "runner-active-capacity-replay-name",
      correlationId: "runner-active-capacity-0-correlation",
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
    },
  );
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.created, false);
  assert.equal(replay.runner.sandboxId, "runner-active-capacity-0");
});

test("listActiveBefore pages by the reconcile page size, not the admission ceiling", async () => {
  const createdAtMs = Date.now();
  const registry = `active-reconcile-page-${testRunId}`;
  const seedResponse = await registryRequest(
    registry,
    "/seed-active-rows",
    { count: 12, createdAtMs },
  );
  assert.equal(seedResponse.status, 204, await seedResponse.text());

  const pageResponse = await registryRequest(
    registry,
    "/list-active-before",
    { cutoffMs: createdAtMs + 12 },
  );
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json();
  assert.equal(page.runners.length, 12);
  assert.equal(page.hasMore, false);

  const clampedRegistry = `active-reconcile-clamp-${testRunId}`;
  const clampedSeedResponse = await registryRequest(
    clampedRegistry,
    "/seed-active-rows",
    { count: 101, createdAtMs },
  );
  assert.equal(
    clampedSeedResponse.status,
    204,
    await clampedSeedResponse.text(),
  );
  const clampedResponse = await registryRequest(
    clampedRegistry,
    "/list-active-before",
    { cutoffMs: createdAtMs + 101, limit: Number.MAX_SAFE_INTEGER },
  );
  assert.equal(clampedResponse.status, 200);
  const clampedPage = await clampedResponse.json();
  assert.equal(clampedPage.runners.length, 100);
  assert.equal(clampedPage.hasMore, true);

  const invalidResponse = await registryRequest(
    clampedRegistry,
    "/list-active-before",
    { cutoffMs: createdAtMs + 101, limit: 1.5 },
  );
  assert.equal(invalidResponse.status, 500);
  assert.deepEqual(await invalidResponse.json(), {
    error: "limit must be a positive safe integer",
  });

  const zeroResponse = await registryRequest(
    clampedRegistry,
    "/list-active-before",
    { cutoffMs: createdAtMs + 101, limit: 0 },
  );
  assert.equal(zeroResponse.status, 500);
  assert.deepEqual(await zeroResponse.json(), {
    error: "limit must be a positive safe integer",
  });
});

test("orphan claims do not consume live runner capacity", async () => {
  const registry = `orphan-capacity-${testRunId}`;
  const claimAtMs = Date.now() + 24 * 60 * 60 * 1000;
  await seedActiveRows(
    registry,
    "runner-orphan-capacity-live-",
    MAX_ACTIVE_RUNNERS - 1,
  );
  const terminalSeedResponse = await registryRequest(
    registry,
    "/seed-terminal-rows",
    {
      count: 1,
      createdAtMs: claimAtMs - ORPHAN_DESTROY_GRACE_MS - 1,
    },
  );
  assert.equal(
    terminalSeedResponse.status,
    204,
    await terminalSeedResponse.text(),
  );

  const sandboxId = "runner-page-00000";
  const observedSandboxInstanceId = "0".repeat(64);
  const observationSeedResponse = await registryRequest(
    registry,
    "/seed-orphan-observations",
    {
      observations: [{
        sandboxId,
        instanceId: observedSandboxInstanceId,
        firstObservedAtMs: claimAtMs - ORPHAN_DESTROY_GRACE_MS,
      }],
    },
  );
  assert.equal(
    observationSeedResponse.status,
    204,
    await observationSeedResponse.text(),
  );

  const claimResponse = await registryRequest(
    registry,
    "/claim-for-orphan-cleanup",
    {
      sandboxId,
      observedCondition: "terminal",
      expectedRevision: 0,
      observedSandboxInstanceId,
      cleanupToken: "orphan-capacity-token",
      cleanupStartedAt: new Date(claimAtMs).toISOString(),
    },
  );
  assert.equal(claimResponse.status, 200);
  const claim = await claimResponse.json();
  assert.equal(claim.claimed, true);
  assert.equal(claim.runner.state, "destroying");
  assert.equal(claim.runner.cleanupRequestedBy, "orphan");
  assert.equal(claim.runner.destroyedAt, null);
  assert.equal(claim.runner.destroyedBy, null);

  await recordStarting(registry, "runner-live-after-orphan-claims");
  const overflowResponse = await registryRequest(
    registry,
    "/record-starting",
    {
      sandboxId: "runner-live-after-orphan-claims-overflow",
      runnerName: "runner-live-after-orphan-claims-overflow-name",
      correlationId: "runner-live-after-orphan-claims-overflow-correlation",
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
    },
  );
  assert.equal(overflowResponse.status, 500);
  assert.deepEqual(await overflowResponse.json(), {
    error: `Runner registry active capacity is ${MAX_ACTIVE_RUNNERS}`,
  });
});

test("alarm scheduling skips an invalid active cleanup time", async () => {
  const registry = `invalid-active-alarm-${testRunId}`;
  const sandboxId = "runner-valid-alarm-active";
  const createdAtMs = Date.now();
  await recordStarting(registry, sandboxId, createdAtMs);
  const invalidValue = 0.5;
  const seedResponse = await registryRequest(
    registry,
    "/seed-invalid-active-row",
    {
      sandboxId: "runner-invalid-alarm-active",
      cleanupDueAtMs: invalidValue,
    },
  );
  assert.equal(seedResponse.status, 204, await seedResponse.text());

  const result = await replayStartingWithErrors(
    registry,
    runnerRecord(sandboxId, createdAtMs),
  );
  assert.equal(result.result.created, false);
  assert.equal(
    result.alarmAt,
    createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  );
  assert.deepEqual(result.errors.map(JSON.parse), [{
    message: "runner registry skipped an invalid cleanup_due_at_ms value",
    value: invalidValue,
  }]);
});

test("alarm scheduling skips an invalid terminal destruction time", async () => {
  const registry = `invalid-terminal-alarm-${testRunId}`;
  const sandboxId = "runner-valid-alarm-terminal";
  const createdAtMs = Date.now();
  await recordStarting(registry, sandboxId, createdAtMs);
  const invalidValue = "invalid";
  const seedResponse = await registryRequest(
    registry,
    "/seed-invalid-terminal-row",
    { sandboxId: "runner-invalid-alarm-terminal" },
  );
  assert.equal(seedResponse.status, 204, await seedResponse.text());

  const result = await replayStartingWithErrors(
    registry,
    runnerRecord(sandboxId, createdAtMs),
  );
  assert.equal(result.result.created, false);
  assert.equal(
    result.alarmAt,
    createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  );
  assert.deepEqual(result.errors.map(JSON.parse), [{
    message: "runner registry skipped an invalid destroyed_at value",
    value: invalidValue,
  }]);
});

test("alarm scheduling skips an invalid orphan observation time", async () => {
  const registry = `invalid-orphan-alarm-${testRunId}`;
  const sandboxId = "runner-valid-alarm-orphan";
  const createdAtMs = Date.now();
  await recordStarting(registry, sandboxId, createdAtMs);
  const invalidValue = 0.5;
  const seedResponse = await registryRequest(
    registry,
    "/seed-orphan-observations",
    {
      observations: [{
        sandboxId: "runner-invalid-alarm-orphan",
        instanceId: "f".repeat(64),
        firstObservedAtMs: invalidValue,
      }],
    },
  );
  assert.equal(seedResponse.status, 204, await seedResponse.text());

  const result = await replayStartingWithErrors(
    registry,
    runnerRecord(sandboxId, createdAtMs),
  );
  assert.equal(result.result.created, false);
  assert.equal(
    result.alarmAt,
    createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  );
  assert.deepEqual(result.errors.map(JSON.parse), [{
    message: "runner registry skipped an invalid orphan observation time",
    value: invalidValue,
  }]);
});

test("alarm prunes terminal rows after the retention window", async () => {
  const registry = `retention-${testRunId}`;
  const sandboxId = "runner-retention";
  await recordStarting(registry, sandboxId);

  const cleanupStartedAt = new Date(Date.now() + 60_000).toISOString();
  const cleanupResponse = await registryRequest(
    registry,
    "/begin-callback-cleanup",
    {
      sandboxId,
      cleanupStartedAt,
    },
  );
  assert.equal(cleanupResponse.status, 200);
  assert.deepEqual(await cleanupResponse.json(), {
    claimed: true,
    reason: "scheduled",
  });
  const claim = await claimNextDue(
    registry,
    Date.parse(cleanupStartedAt) + CALLBACK_CLEANUP_HANDOFF_DELAY_MS,
  );

  const destroyedResponse = await registryRequest(registry, "/mark-destroyed", {
    sandboxId,
    destroyedAt: new Date(
      Date.now() - TERMINAL_RUNNER_RETENTION_MS - 1,
    ).toISOString(),
    destroyedBy: "callback",
    cleanupToken: claim.cleanupToken,
  });
  assert.equal(destroyedResponse.status, 204);

  const alarmResponse = await registryRequest(registry, "/alarm", {});
  assert.equal(alarmResponse.status, 204, await alarmResponse.text());

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), {
    runners: [],
    pageSize: RUNNER_LIST_PAGE_SIZE,
    nextCursor: null,
  });
});

test("alarm prunes expired orphan observations with the terminal bound", async () => {
  const registry = `orphan-observation-pruning-${testRunId}`;
  const nowMs = Date.now();
  const expiredSandboxId = "runner-orphan-observation-expired";
  const retainedSandboxId = "runner-orphan-observation-retained";
  const seedResponse = await registryRequest(
    registry,
    "/seed-orphan-observations",
    {
      observations: [
        {
          sandboxId: expiredSandboxId,
          instanceId: "7".repeat(64),
          firstObservedAtMs:
            nowMs - TERMINAL_RUNNER_RETENTION_MS - 1,
        },
        {
          sandboxId: retainedSandboxId,
          instanceId: "8".repeat(64),
          firstObservedAtMs: nowMs,
        },
      ],
    },
  );
  assert.equal(seedResponse.status, 204);

  await runRegistryAlarm(registry);

  const observationsResponse = await registryRequest(
    registry,
    "/orphan-observations",
    {},
  );
  assert.equal(observationsResponse.status, 200);
  const observations = (await observationsResponse.json()).observations;
  assert.deepEqual(observations, [
    {
      sandbox_id: retainedSandboxId,
      instance_id: "8".repeat(64),
      first_observed_at_ms: nowMs,
    },
  ]);
});

test("alarm pruning respects one batch and immediately rearms", async () => {
  const registry = `retention-batch-${testRunId}`;
  const nowMs = Date.now();
  const seededRowCount = TERMINAL_RUNNER_PRUNE_BATCH_SIZE + 1;
  const seedResponse = await registryRequest(
    registry,
    "/seed-terminal-rows",
    {
      count: seededRowCount,
      createdAtMs: nowMs - seededRowCount,
      destroyedAtMs: nowMs - TERMINAL_RUNNER_RETENTION_MS - 1,
    },
  );
  assert.equal(seedResponse.status, 204, await seedResponse.text());

  const firstAlarmResponse = await registryRequest(
    registry,
    "/alarm-snapshot",
    {},
  );
  assert.equal(firstAlarmResponse.status, 200);
  const firstAlarm = await firstAlarmResponse.json();
  assert.equal(firstAlarm.remainingRows, 1);
  const { alarmAt } = firstAlarm;
  assert.equal(typeof alarmAt, "number");
  assert.ok(alarmAt <= Date.now());

  const secondAlarmResponse = await registryRequest(
    registry,
    "/alarm-snapshot",
    {},
  );
  assert.equal(secondAlarmResponse.status, 200);
  assert.deepEqual(await secondAlarmResponse.json(), {
    remainingRows: 0,
    alarmAt: null,
  });
});

test("orphan observation pruning uses the terminal batch and rearms", async () => {
  const registry = `orphan-retention-batch-${testRunId}`;
  const nowMs = Date.now();
  const seededRowCount = TERMINAL_RUNNER_PRUNE_BATCH_SIZE + 1;
  const observations = Array.from(
    { length: seededRowCount },
    (_, index) => ({
      sandboxId: `runner-orphan-prune-${String(index).padStart(5, "0")}`,
      instanceId: "9".repeat(64),
      firstObservedAtMs: nowMs - TERMINAL_RUNNER_RETENTION_MS - 1,
    }),
  );
  const seedResponse = await registryRequest(
    registry,
    "/seed-orphan-observations",
    { observations },
  );
  assert.equal(seedResponse.status, 204, await seedResponse.text());

  const firstAlarmResponse = await registryRequest(
    registry,
    "/alarm-snapshot",
    { includeObservationCount: true },
  );
  const firstAlarm = await firstAlarmResponse.json();
  assert.equal(firstAlarm.remainingObservations, 1);
  const firstAlarmAt = firstAlarm.alarmAt;
  assert.equal(typeof firstAlarmAt, "number");
  assert.ok(firstAlarmAt <= Date.now());

  const secondAlarmResponse = await registryRequest(
    registry,
    "/alarm-snapshot",
    { includeObservationCount: true },
  );
  assert.deepEqual(await secondAlarmResponse.json(), {
    remainingRows: 0,
    remainingObservations: 0,
    alarmAt: null,
  });
});

test("terminal correlation records survive GitHub's redelivery window", async () => {
  const registry = `redelivery-retention-${testRunId}`;
  const sandboxId = "runner-redelivery-retention";
  await recordStarting(registry, sandboxId);

  const cleanupStartedAt = new Date(Date.now() + 60_000).toISOString();
  const cleanupResponse = await registryRequest(
    registry,
    "/begin-callback-cleanup",
    { sandboxId, cleanupStartedAt },
  );
  assert.equal(cleanupResponse.status, 200);
  const claim = await claimNextDue(
    registry,
    Date.parse(cleanupStartedAt) + CALLBACK_CLEANUP_HANDOFF_DELAY_MS,
  );
  const destroyedResponse = await registryRequest(registry, "/mark-destroyed", {
    sandboxId,
    destroyedAt: new Date(
      Date.now() - GITHUB_WEBHOOK_REDELIVERY_WINDOW_MS,
    ).toISOString(),
    destroyedBy: "callback",
    cleanupToken: claim.cleanupToken,
  });
  assert.equal(destroyedResponse.status, 204);

  const alarmResponse = await registryRequest(registry, "/alarm", {});
  assert.equal(alarmResponse.status, 204, await alarmResponse.text());

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(body.runners.length, 1);
  assert.equal(body.runners[0].correlationId, `${sandboxId}-correlation`);
});

test("recordStarting replays one durable correlation identifier", async () => {
  const registry = `idempotent-start-${testRunId}`;
  const correlationId = "delivery-correlation";
  const firstSandboxId = "runner-idempotent-first";
  const createdAtMs = Date.now();
  const firstResponse = await registryRequest(registry, "/record-starting", {
    sandboxId: firstSandboxId,
    runnerName: `${firstSandboxId}-name`,
    correlationId,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  });
  assert.equal(firstResponse.status, 200);
  const firstResult = await firstResponse.json();
  assert.equal(firstResult.created, true);
  assert.equal(firstResult.runner.correlationId, correlationId);

  const secondResponse = await registryRequest(registry, "/record-starting", {
    sandboxId: "runner-idempotent-second",
    runnerName: "runner-idempotent-second-name",
    correlationId,
    createdAt: new Date(createdAtMs + 60_000).toISOString(),
    createdAtMs: createdAtMs + 60_000,
  });
  assert.equal(secondResponse.status, 200);
  const secondResult = await secondResponse.json();
  assert.equal(secondResult.created, false);
  assert.equal(secondResult.runner.sandboxId, firstSandboxId);
  assert.equal(secondResult.runner.correlationId, correlationId);

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(body.runners.length, 1);
  assert.equal(body.runners[0].sandboxId, firstSandboxId);
});

test("the real alarm destroys an online runner after its callback is dropped", async () => {
  const registry = `wired-alarm-dropped-callback-${testRunId}`;
  const sandboxId = "runner-wired-alarm-dropped-callback";
  await configureSandbox(registry, sandboxId);
  const createdAtMs = Date.now() - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1;
  const recordResponse = await registryRequest(registry, "/record-online", {
    record: runnerRecord(sandboxId, createdAtMs),
  });
  assert.equal(recordResponse.status, 200);

  await runRegistryAlarm(registry);

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(body.runners.length, 1);
  assert.equal(body.runners[0].state, "destroyed");
  assert.equal(body.runners[0].destroyedBy, "alarm");
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 1,
    destroyed: 1,
  });
});

test("the real alarm retries an interrupted sandbox destroy", async () => {
  const registry = `wired-alarm-retry-${testRunId}`;
  const sandboxId = "runner-wired-alarm-retry";
  await configureSandbox(registry, sandboxId, 1);
  const cleanupStartedAtMs =
    Date.now() - CALLBACK_CLEANUP_HANDOFF_DELAY_MS - 1;
  const recordResponse = await registryRequest(
    registry,
    "/record-callback-cleanup",
    {
      record: runnerRecord(sandboxId, cleanupStartedAtMs - 1),
      cleanupStartedAt: new Date(cleanupStartedAtMs).toISOString(),
    },
  );
  assert.equal(recordResponse.status, 200);
  assert.deepEqual(await recordResponse.json(), {
    claimed: true,
    reason: "scheduled",
  });

  await runRegistryAlarm(registry);
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 1,
    destroyed: 0,
  });

  const scheduledResponse = await registryRequest(
    registry,
    "/scheduled-alarm",
    {},
  );
  assert.equal(scheduledResponse.status, 200);
  const { alarmAt } = await scheduledResponse.json();
  assert.equal(typeof alarmAt, "number");
  await runRegistryAlarm(registry, alarmAt);
  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(body.runners[0].state, "destroyed");
  assert.equal(body.runners[0].destroyedBy, "callback");
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 2,
    destroyed: 1,
  });
});

test("alarm maintenance owns a thrown cleanup retry", async () => {
  const registry = `alarm-owned-retry-${testRunId}`;
  const sandboxId = "runner-alarm-owned-retry";
  await configureSandbox(registry, sandboxId);
  const cleanupStartedAtMs = Date.now();
  const firstAttemptAtMs =
    cleanupStartedAtMs + CALLBACK_CLEANUP_HANDOFF_DELAY_MS;
  const recordResponse = await registryRequest(
    registry,
    "/record-callback-cleanup",
    {
      record: runnerRecord(sandboxId, cleanupStartedAtMs - 1),
      cleanupStartedAt: new Date(cleanupStartedAtMs).toISOString(),
    },
  );
  assert.equal(recordResponse.status, 200);

  const firstAlarmResponse = await registryRequest(registry, "/alarm", {
    nowMs: firstAttemptAtMs,
    runnerCheckFailure: true,
  });
  assert.equal(firstAlarmResponse.status, 204, await firstAlarmResponse.text());
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });

  const scheduledResponse = await registryRequest(
    registry,
    "/scheduled-alarm",
    {},
  );
  assert.equal(scheduledResponse.status, 200);
  const { alarmAt } = await scheduledResponse.json();
  assert.equal(typeof alarmAt, "number");
  assert.ok(alarmAt > firstAttemptAtMs);

  await runRegistryAlarm(registry, alarmAt);
  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(body.runners[0].state, "destroyed");
  assert.equal(body.runners[0].destroyedBy, "callback");
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 1,
    destroyed: 1,
  });
});

test("busy postponement keeps the forced-exit claim at the exact bound [mutation: report a forced exit as postponed]", async () => {
  const registry = `busy-postponement-contract-${testRunId}`;
  const sandboxId = "runner-busy-postponement-contract";
  const createdAtMs = Date.now();
  const firstObservationAtMs =
    createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS;
  await recordStarting(registry, sandboxId, createdAtMs);

  const postponedResponse = await registryRequest(
    registry,
    "/postpone-busy-cleanup",
    {
      nowMs: firstObservationAtMs,
      checkedAtMs: firstObservationAtMs,
    },
  );
  assert.equal(
    postponedResponse.status,
    200,
    await postponedResponse.clone().text(),
  );
  const postponed = await postponedResponse.json();
  assert.equal(postponed.result.postponed, true);
  assert.equal(postponed.result.forcedBusyExit, false);
  assert.equal(postponed.result.busySinceMs, firstObservationAtMs);
  assert.equal(postponed.result.busyAgeMs, 0);
  assert.equal(postponed.row.state, "starting");
  assert.equal(postponed.row.reconcile_token, null);
  assert.equal(
    postponed.row.cleanup_due_at_ms,
    firstObservationAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  );
  assert.equal(postponed.row.revision, postponed.claim.runner.revision + 1);

  const checkedAtMs = firstObservationAtMs + MAX_BUSY_POSTPONE_MS;
  const forcedResponse = await registryRequest(
    registry,
    "/postpone-busy-cleanup",
    { nowMs: checkedAtMs, checkedAtMs },
  );
  assert.equal(
    forcedResponse.status,
    200,
    await forcedResponse.clone().text(),
  );
  const forced = await forcedResponse.json();
  assert.equal(forced.result.postponed, false);
  assert.equal(forced.result.forcedBusyExit, true);
  assert.equal(forced.result.busySinceMs, firstObservationAtMs);
  assert.equal(forced.result.busyAgeMs, MAX_BUSY_POSTPONE_MS);
  assert.equal(forced.row.state, "destroying");
  assert.equal(forced.row.reconcile_token, forced.claim.cleanupToken);
  assert.equal(
    forced.row.cleanup_due_at_ms,
    Date.parse(forced.claim.runner.cleanupDueAt),
  );
  assert.equal(forced.row.revision, forced.claim.runner.revision);
});

test("a live busy runner reaches its cleanup bound while resetting attempts [mutation: keep the attempt count]", async () => {
  const registry = `busy-cleanup-attempts-${testRunId}`;
  const sandboxId = "runner-busy-cleanup-attempts";
  const createdAtMs = Date.now();
  const firstAttemptAtMs = createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS;
  const expectedPostponedCycleCount = Math.ceil(
    MAX_BUSY_POSTPONE_MS / ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  );
  const response = await registryRequest(
    registry,
    "/busy-cleanup-cycles",
    {
      record: runnerRecord(sandboxId, createdAtMs),
      firstAttemptAtMs,
      cycleCount: expectedPostponedCycleCount + 1,
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.cycles.length, expectedPostponedCycleCount + 1);
  for (const cycle of body.cycles.slice(0, expectedPostponedCycleCount)) {
    assert.equal(cycle.status, "retained-busy");
    assert.equal(cycle.cleanupAttempts, 0);
    assert.notEqual(cycle.cleanupDueAt, null);
    assert.equal(cycle.cleanupStalled, false);
    assert.equal(cycle.busySinceMs, firstAttemptAtMs);
  }
  const forcedCycle = body.cycles.at(-1);
  assert.equal(forcedCycle.status, "destroyed");
  assert.equal(forcedCycle.forcedBusyExit, true);
  assert.equal(forcedCycle.state, "destroyed");
  assert.equal(forcedCycle.busySinceMs, firstAttemptAtMs);
  assert.equal(body.beginSandboxDestroyCalls, 1);
  assert.equal(body.deleteRepositoryRunnerCalls, 1);
  const forcedLogs = body.logs.filter(
    (record) => record.message === "runner registry forced busy exit",
  );
  assert.equal(forcedLogs.length, 1);
  assert.equal(forcedLogs[0].githubRunnerId, expectedPostponedCycleCount + 1);
  assert.equal(forcedLogs[0].busySinceMs, firstAttemptAtMs);
  assert.equal(forcedLogs[0].busyAgeMs, MAX_BUSY_POSTPONE_MS);
  assert.equal(forcedLogs[0].maxBusyPostponeMs, MAX_BUSY_POSTPONE_MS);
});

test("busy cleanup preserves its stamp across claims and alarm generations", async () => {
  const registry = `busy-stamp-generations-${testRunId}`;
  const sandboxId = "runner-busy-stamp-generations";
  const createdAtMs = Date.now();
  const firstAttemptAtMs = createdAtMs + CALLBACK_CLEANUP_HANDOFF_DELAY_MS;
  const response = await registryRequest(
    registry,
    "/busy-cleanup-cycles",
    {
      record: runnerRecord(sandboxId, createdAtMs),
      firstAttemptAtMs,
      cycleCount: 2,
      initialCleanupRequestedBy: "callback",
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(
    body.cycles.map((cycle) => cycle.status),
    ["retained-busy", "retained-busy"],
  );
  assert.deepEqual(
    body.cycles.map((cycle) => cycle.busySinceMs),
    [firstAttemptAtMs, firstAttemptAtMs],
  );
  assert.ok(body.cycles[1].revision > body.cycles[0].revision);
  assert.equal(body.beginSandboxDestroyCalls, 0);
});

test("the busy bound cannot force exit a legitimately busy runner [mutation: lower the bound below the workflow hard stop]", async () => {
  const busyBoundRatio = MAX_BUSY_POSTPONE_MS / LONGEST_ALLOWED_JOB_MS;
  assert.ok(
    MAX_BUSY_POSTPONE_MS > LONGEST_ALLOWED_JOB_MS,
    `MAX_BUSY_POSTPONE_MS / LONGEST_ALLOWED_JOB_MS = ${busyBoundRatio}`,
  );

  const firstIdleCycle = Math.ceil(
    LONGEST_ALLOWED_JOB_MS / ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  );
  const busyByCycle = Array.from(
    { length: firstIdleCycle + 1 },
    (_value, cycle) => cycle < firstIdleCycle,
  );
  const registry = `busy-job-safety-margin-${testRunId}`;
  const sandboxId = "runner-busy-job-safety-margin";
  const createdAtMs = Date.now();
  const firstAttemptAtMs = createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS;
  const response = await registryRequest(
    registry,
    "/busy-cleanup-cycles",
    {
      record: runnerRecord(sandboxId, createdAtMs),
      firstAttemptAtMs,
      cycleCount: busyByCycle.length,
      busyByCycle,
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.ok(body.cycles.every((cycle) => cycle.forcedBusyExit === false));
  assert.equal(
    body.logs.some(
      (record) => record.message === "runner registry forced busy exit",
    ),
    false,
  );
  const ordinaryExit = body.cycles.at(-1);
  assert.equal(ordinaryExit.status, "destroyed");
  assert.equal(ordinaryExit.state, "destroyed");
  assert.equal(body.beginSandboxDestroyCalls, 1);
});

test("a busy runner that becomes idle uses normal cleanup without a forced exit", async () => {
  const registry = `busy-then-idle-${testRunId}`;
  const sandboxId = "runner-busy-then-idle";
  const createdAtMs = Date.now();
  const firstAttemptAtMs = createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS;
  const response = await registryRequest(
    registry,
    "/busy-cleanup-cycles",
    {
      record: runnerRecord(sandboxId, createdAtMs),
      firstAttemptAtMs,
      cycleCount: 2,
      busyByCycle: [true, false],
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(
    body.cycles.map((cycle) => cycle.status),
    ["retained-busy", "destroyed"],
  );
  assert.ok(body.cycles.every((cycle) => !cycle.forcedBusyExit));
  assert.equal(body.beginSandboxDestroyCalls, 1);
  assert.equal(body.deleteRepositoryRunnerCalls, 1);
  assert.equal(
    body.logs.some(
      (record) => record.message === "runner registry forced busy exit",
    ),
    false,
  );
});

test("an online and busy orphan registration reaches the forced exit", async () => {
  const registry = `online-busy-orphan-bound-${testRunId}`;
  const sandboxId = "runner-online-busy-orphan-bound";
  const createdAtMs = Date.now();
  const firstAttemptAtMs = createdAtMs + CALLBACK_CLEANUP_HANDOFF_DELAY_MS;
  const expectedPostponedCycleCount = Math.ceil(
    MAX_BUSY_POSTPONE_MS / CLEANUP_RETRY_DELAY_MS,
  );
  const response = await registryRequest(
    registry,
    "/busy-cleanup-cycles",
    {
      record: runnerRecord(sandboxId, createdAtMs),
      firstAttemptAtMs,
      cycleCount: expectedPostponedCycleCount + 1,
      registrationStatus: "online",
      initialCleanupRequestedBy: "orphan",
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  for (const cycle of body.cycles.slice(0, expectedPostponedCycleCount)) {
    assert.equal(cycle.status, "retained-busy");
  }
  const forcedCycle = body.cycles.at(-1);
  assert.equal(forcedCycle.status, "destroyed");
  assert.equal(forcedCycle.forcedBusyExit, true);
  assert.equal(body.beginSandboxDestroyCalls, 1);
  assert.equal(body.deleteRepositoryRunnerCalls, 1);
  assert.equal(
    body.logs.filter(
      (record) => record.message === "runner registry forced busy exit",
    ).length,
    1,
  );
});

test("an orphan busy runner reaches the bound and destroys its stale registration", async () => {
  const registry = `orphan-busy-bound-${testRunId}`;
  const sandboxId = "runner-orphan-busy-bound";
  const createdAtMs = Date.now();
  const firstAttemptAtMs = createdAtMs + CALLBACK_CLEANUP_HANDOFF_DELAY_MS;
  const expectedPostponedCycleCount = Math.ceil(
    MAX_BUSY_POSTPONE_MS / CLEANUP_RETRY_DELAY_MS,
  );
  const response = await registryRequest(
    registry,
    "/busy-cleanup-cycles",
    {
      record: runnerRecord(sandboxId, createdAtMs),
      firstAttemptAtMs,
      cycleCount: expectedPostponedCycleCount + 1,
      registrationStatus: "offline",
      initialCleanupRequestedBy: "orphan",
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  for (const cycle of body.cycles.slice(0, expectedPostponedCycleCount)) {
    assert.equal(cycle.status, "retained-busy");
    assert.equal(cycle.cleanupAttempts, 0);
    assert.equal(cycle.busySinceMs, firstAttemptAtMs);
    assert.equal(cycle.cleanupRequestedBy, "orphan");
  }
  const forcedCycle = body.cycles.at(-1);
  assert.equal(forcedCycle.status, "destroyed");
  assert.equal(forcedCycle.forcedBusyExit, true);
  assert.equal(forcedCycle.destroyedBy, "orphan");
  assert.equal(forcedCycle.busySinceMs, firstAttemptAtMs);
  assert.equal(body.beginSandboxDestroyCalls, 1);
  assert.equal(body.deleteRepositoryRunnerCalls, 1);
  const forcedLogs = body.logs.filter(
    (record) => record.message === "runner registry forced busy exit",
  );
  assert.equal(forcedLogs.length, 1);
  assert.equal(forcedLogs[0].githubRunnerId, expectedPostponedCycleCount + 1);
  assert.equal(forcedLogs[0].busySinceMs, firstAttemptAtMs);
  assert.equal(forcedLogs[0].maxBusyPostponeMs, MAX_BUSY_POSTPONE_MS);
});

test("busy cleanup retains the last pre-bound observation and exits at the bound", async () => {
  const registry = `busy-exact-bound-${testRunId}`;
  const sandboxId = "runner-busy-exact-bound";
  const createdAtMs = Date.now();
  const firstAttemptAtMs = createdAtMs + CALLBACK_CLEANUP_HANDOFF_DELAY_MS;
  const exactBoundCycle = MAX_BUSY_POSTPONE_MS / CLEANUP_RETRY_DELAY_MS;
  assert.equal(Number.isSafeInteger(exactBoundCycle), true);
  const response = await registryRequest(
    registry,
    "/busy-cleanup-cycles",
    {
      record: runnerRecord(sandboxId, createdAtMs),
      firstAttemptAtMs,
      cycleCount: exactBoundCycle + 1,
      initialCleanupRequestedBy: "callback",
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  const preBoundCycle = body.cycles.at(-2);
  const boundCycle = body.cycles.at(-1);
  assert.equal(preBoundCycle.status, "retained-busy");
  assert.equal(
    preBoundCycle.nowMs - preBoundCycle.busySinceMs,
    MAX_BUSY_POSTPONE_MS - CLEANUP_RETRY_DELAY_MS,
  );
  assert.equal(boundCycle.status, "destroyed");
  assert.equal(boundCycle.forcedBusyExit, true);
  assert.equal(
    boundCycle.nowMs - boundCycle.busySinceMs,
    MAX_BUSY_POSTPONE_MS,
  );
  assert.equal(body.beginSandboxDestroyCalls, 1);
});

test("repeated GitHub 403 alarms stop before sandbox destruction [mutation: keep retrying]", async () => {
  const registry = `github-403-cleanup-bound-${testRunId}`;
  const sandboxId = "runner-github-403-cleanup-bound";
  const createdAtMs = Date.now();
  const response = await registryRequest(
    registry,
    "/failing-alarm-until-park",
    {
      record: runnerRecord(sandboxId, createdAtMs),
      firstAttemptAtMs: createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS,
      attemptLimit: MAX_CLEANUP_ATTEMPTS,
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();

  assert.equal(body.failures.length, MAX_CLEANUP_ATTEMPTS);
  assert.ok(
    body.failures.every(
      (failure) =>
        failure.phase === "github-runner-check" &&
        failure.message === "GitHub runner-list request failed: 403",
    ),
  );
  assert.ok(body.githubCalls <= MAX_CLEANUP_ATTEMPTS);
  assert.equal(body.githubCalls, MAX_CLEANUP_ATTEMPTS);
  assert.equal(body.beginSandboxDestroyCalls, 0);
  assert.equal(body.runner.cleanupAttempts, MAX_CLEANUP_ATTEMPTS);
  assert.equal(body.runner.cleanupDueAt, null);
  assert.equal(body.runner.cleanupStalled, true);
  assert.equal(body.alarmAt, null);
  assert.equal(body.idleStatus, "idle");
});

test("alarm maintenance lets pruning failures escape", async () => {
  const registry = `alarm-pruning-failure-${testRunId}`;
  const sandboxId = "runner-pruning-failure-cleanup";
  const wallNowMs = Date.now();
  const nowMs = wallNowMs + 60_000;
  await configureSandbox(registry, sandboxId);
  const recordResponse = await registryRequest(
    registry,
    "/record-callback-cleanup",
    {
      record: runnerRecord(
        sandboxId,
        nowMs - CALLBACK_CLEANUP_HANDOFF_DELAY_MS - 1,
      ),
      cleanupStartedAt: new Date(
        nowMs - CALLBACK_CLEANUP_HANDOFF_DELAY_MS,
      ).toISOString(),
    },
  );
  assert.equal(recordResponse.status, 200);
  const seedResponse = await registryRequest(
    registry,
    "/seed-terminal-rows",
    {
      count: 1,
      createdAtMs: wallNowMs - TERMINAL_RUNNER_RETENTION_MS - 2,
      destroyedAtMs: wallNowMs - TERMINAL_RUNNER_RETENTION_MS - 1,
    },
  );
  assert.equal(seedResponse.status, 204);

  const response = await registryRequest(
    registry,
    "/alarm-pruning-failure",
    { nowMs, cleanupSandboxId: sandboxId },
  );
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "simulated terminal pruning failure");
  assert.equal(body.cleanupState, "destroyed");
  assert.equal(body.prunableRows, 1);
  assert.equal(typeof body.alarmAt, "number");
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 1,
    destroyed: 1,
  });
});

test("the real alarm replaces an abandoned stale cleanup claim", async () => {
  const registry = `wired-alarm-stale-claim-${testRunId}`;
  const sandboxId = "runner-wired-alarm-stale-claim";
  await configureSandbox(registry, sandboxId);
  const claimAtMs = Date.now() - CLEANUP_CLAIM_STALE_MS - 1;
  const recordResponse = await registryRequest(
    registry,
    "/record-abandoned-claim",
    {
      record: runnerRecord(
        sandboxId,
        claimAtMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1,
      ),
      claimAtMs,
    },
  );
  assert.equal(recordResponse.status, 200);
  const abandonedClaim = await recordResponse.json();
  assert.equal(typeof abandonedClaim.cleanupToken, "string");

  await runRegistryAlarm(registry);

  const listResponse = await registryRequest(registry, "/runners");
  assert.equal(listResponse.status, 200);
  const body = await listResponse.json();
  assert.equal(body.runners[0].state, "destroyed");
  assert.equal(body.runners[0].destroyedBy, "alarm");
  assert.notEqual(
    body.runners[0].cleanupStartedAt,
    new Date(claimAtMs).toISOString(),
  );
  assert.equal(body.runners[0].revision, 3);
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 1,
    destroyed: 1,
  });
});

test("the production alarm destroys and records one due runner", async () => {
  const response = await worker.fetch("/production-alarm-cleanup");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome.status, "destroyed");
  assert.deepEqual(body.events.slice(0, 2), [
    "claimed",
    "destroyed",
  ]);
  assert.deepEqual(body.events[2], {
    sandboxId: "runner-alarm-cleanup",
    destroyedAt: "2026-04-23T12:00:00.000Z",
    destroyedBy: "alarm",
    cleanupToken: "alarm-token",
  });
});

test("one alarm pass claims only the cleanup concurrency batch", async () => {
  const body = await runAlarmCleanupBatchScenario("batch-size");
  const runners = body.runners ?? [];
  assert.deepEqual(
    {
      awaitingCleanupCount: runners.filter(
        (runner) =>
          runner.state === "starting" &&
          Date.parse(runner.cleanupDueAt) <= ORPHAN_TEST_NOW_MS,
      ).length,
      destroyedCount: runners.filter(
        (runner) => runner.state === "destroyed",
      ).length,
      loggedSandboxIds: body.logs?.map(
        (record) => JSON.parse(record).sandboxId,
      ),
      maxCleanupConcurrency: body.maxCleanupConcurrency,
      responseStatus: body.responseStatus,
      returnedSandboxId: body.outcome?.runner?.sandboxId,
    },
    {
      awaitingCleanupCount: 3,
      destroyedCount: MAX_CLEANUP_CONCURRENCY,
      loggedSandboxIds: Array.from(
        { length: MAX_CLEANUP_CONCURRENCY },
        (_, index) => `runner-alarm-batch-size-${index}`,
      ),
      maxCleanupConcurrency: MAX_CLEANUP_CONCURRENCY,
      responseStatus: 200,
      returnedSandboxId: "runner-alarm-batch-size-0",
    },
  );
});

test("one alarm pass executes its cleanup batch concurrently", async () => {
  const body = await runAlarmCleanupBatchScenario("concurrency");
  const destroyEvents = body.destroyEvents ?? [];
  assert.deepEqual(
    {
      claimCalls: body.claimCalls,
      destroyedCount: (body.runners ?? []).filter(
        (runner) => runner.state === "destroyed",
      ).length,
      destroyEntries: destroyEvents.filter(
        (event) => event.event === "entry",
      ).length,
      destroyExits: destroyEvents.filter(
        (event) => event.event === "exit",
      ).length,
      maxDestroysInFlight: body.maxDestroysInFlight,
      responseStatus: body.responseStatus,
    },
    {
      claimCalls: MAX_CLEANUP_CONCURRENCY,
      destroyedCount: MAX_CLEANUP_CONCURRENCY,
      destroyEntries: MAX_CLEANUP_CONCURRENCY,
      destroyExits: MAX_CLEANUP_CONCURRENCY,
      maxDestroysInFlight: MAX_CLEANUP_CONCURRENCY,
      responseStatus: 200,
    },
  );
});

test("one alarm pass isolates a middle cleanup failure", async () => {
  const body = await runAlarmCleanupBatchScenario("failure-isolation");
  const runners = body.runners ?? [];
  const sandboxIds = Array.from(
    { length: 3 },
    (_, index) => `runner-alarm-failure-isolation-${index}`,
  );
  const failedRunner = runners.find(
    (runner) => runner.sandboxId === sandboxIds[1],
  );
  assert.deepEqual(
    {
      error: body.error,
      loggedSandboxIds: body.logs?.map(
        (record) => JSON.parse(record).sandboxId,
      ),
      responseStatus: body.responseStatus,
      retryAttempts: failedRunner?.cleanupAttempts,
      retryIsFuture:
        Date.parse(failedRunner?.cleanupDueAt) > ORPHAN_TEST_NOW_MS,
      states: sandboxIds.map(
        (sandboxId) =>
          runners.find((runner) => runner.sandboxId === sandboxId)?.state,
      ),
    },
    {
      error: {
        message: "simulated middle GitHub runner check failure",
        phase: "github-runner-check",
      },
      loggedSandboxIds: [sandboxIds[0], sandboxIds[2]],
      responseStatus: 200,
      retryAttempts: 1,
      retryIsFuture: true,
      states: ["destroyed", "destroying", "destroyed"],
    },
  );
});

test("one alarm pass preserves single-claim outcome and log parity", async () => {
  const body = await runAlarmCleanupBatchScenario("single-parity");
  const sandboxId = "runner-alarm-single-parity-0";
  const runnerName = `${sandboxId}-name`;
  const createdAtMs =
    ORPHAN_TEST_NOW_MS - ACTIVE_RUNNER_CLEANUP_DELAY_MS - 1;
  const outcome = {
    status: "destroyed",
    runner: {
      sandboxId,
      runnerName,
      githubRunnerName: null,
      correlationId: `${sandboxId}-correlation`,
      repository: "example/runner-test",
      createdAt: new Date(createdAtMs).toISOString(),
      orphanInstanceId: null,
      state: "destroying",
      cleanupStartedAt: new Date(ORPHAN_TEST_NOW_MS).toISOString(),
      cleanupDueAt: new Date(
        ORPHAN_TEST_NOW_MS + CLEANUP_CLAIM_STALE_MS,
      ).toISOString(),
      cleanupRequestedBy: "alarm",
      cleanupAttempts: 1,
      busySinceMs: null,
      cleanupStalled: false,
      destroyedAt: null,
      destroyedBy: null,
      revision: 1,
    },
    registrationCleanup: {
      runnerId: null,
      result: "name-unknown",
    },
  };
  assert.deepEqual(
    {
      claimCalls: body.claimCalls,
      logs: body.logs,
      outcome: body.outcome,
      responseStatus: body.responseStatus,
    },
    {
      claimCalls: 2,
      logs: [JSON.stringify({
        message: "runner registry alarm cleanup",
        status: "destroyed",
        runnerName,
        sandboxId,
        runnerId: null,
        result: "name-unknown",
      })],
      outcome,
      responseStatus: 200,
    },
  );
});

test("one alarm pass claims cleanup rows sequentially", async () => {
  const body = await runAlarmCleanupBatchScenario("sequential-claims");
  assert.deepEqual(
    {
      claimCalls: body.claimCalls,
      destroyedCount: (body.runners ?? []).filter(
        (runner) => runner.state === "destroyed",
      ).length,
      maxClaimsInFlight: body.maxClaimsInFlight,
      responseStatus: body.responseStatus,
    },
    {
      claimCalls: MAX_CLEANUP_CONCURRENCY,
      destroyedCount: MAX_CLEANUP_CONCURRENCY,
      maxClaimsInFlight: 1,
      responseStatus: 200,
    },
  );
});

test("the registry alarm's completed-runner destroy releases its reservation exactly once", async () => {
  const response = await worker.fetch(
    "/production-alarm-reservation-release",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.outcome.status, "destroyed");
  assert.deepEqual(body.releaseCalls, [{
    sandboxId: "runner-alarm-reservation-release",
    reason: "runner-destroyed",
  }]);
  assert.equal(body.logs.length, 1);
  assert.deepEqual(JSON.parse(body.logs[0]), {
    message: "released destroyed runner reservation",
    sandboxId: "runner-alarm-reservation-release",
    destroyedBy: "callback",
    released: true,
    replayed: false,
    reservationId: "reservation-runner-alarm-reservation-release",
    releaseReason: null,
  });
});

test("alarm cleanup uses the repository stored on its registry row", async () => {
  const registry = `repository-cleanup-${testRunId}`;
  const repository = "example/second-repository";
  const createdAtMs = Date.now();
  const record = {
    sandboxId: "runner-stored-repository-cleanup",
    runnerName: "cloudflare-stored-repository-cleanup",
    githubRunnerName: "cloudflare-github-stored-repository-cleanup",
    correlationId: "stored-repository-cleanup",
    repository,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
  };
  const response = await registryRequest(registry, "/repository-cleanup", {
    record,
    nowMs: createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.calls, [{ operation: "find", repository }]);
  assert.equal(body.outcome.runner.repository, repository);
  assert.equal(body.outcome.status, "destroyed");
});

test("orphan cleanup uses its runner repository for checks and deletion", async () => {
  const response = await worker.fetch(
    "/production-orphan-repository-cleanup",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.calls, [
    {
      operation: "find",
      repository: "example/second-repository",
      runnerName: "cloudflare-github-orphan-repository",
    },
    {
      operation: "find",
      repository: "example/second-repository",
      runnerName: "cloudflare-github-orphan-repository",
    },
    {
      operation: "delete",
      repository: "example/second-repository",
      runnerId: 901,
    },
  ]);
  assert.equal(body.outcome.status, "destroyed");
});

test("the production alarm retries an interrupted destroy", async () => {
  const response = await worker.fetch("/production-alarm-retry");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.firstError, {
    message: "simulated interrupted destroy",
    phase: "sandbox-destroy",
  });
  assert.equal(body.second.status, "destroyed");
  assert.equal(
    body.events.filter((event) => event === "claimed").length,
    2,
  );
  assert.ok(body.events.includes("released-for-retry"));
  assert.ok(body.events.includes("marked-destroyed"));
});

test("a sandbox destroy timeout never releases a reservation and retries cleanup", async () => {
  const response = await worker.fetch(
    "/production-alarm-destroy-timeout",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.error, {
    causeName: "SandboxDestroyTimeout",
    message: "simulated bounded sandbox destroy timeout",
    phase: "sandbox-destroy",
  });
  assert.deepEqual(body.events, ["claimed", "claim-retry"]);
  assert.deepEqual(body.releaseCalls, []);

  const completed = await worker.fetch(
    "/production-alarm-reservation-release",
  );
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).releaseCalls.length, 1);
});

test("a reservation release failure does not change a destroyed alarm outcome", async () => {
  const response = await worker.fetch(
    "/production-alarm-release-failure",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.outcome.status, "destroyed");
  assert.deepEqual(body.releaseCalls, [{
    sandboxId: "runner-alarm-release-failure",
    reason: "runner-destroyed",
  }]);
  assert.equal(body.logs.length, 1);
  const failureLog = JSON.parse(body.logs[0]);
  assert.equal(
    failureLog.message,
    "failed to release destroyed runner reservation",
  );
  assert.equal(failureLog.sandboxId, "runner-alarm-release-failure");
  assert.equal(failureLog.destroyedBy, "callback");
  assert.deepEqual(failureLog.error, {
    name: "Error",
    message: "simulated reservation release failure",
    cause: null,
  });
});

test("alarm orphan takeover stops at lease expiry [mutation: derive a fresh deadline]", async () => {
  const response = await worker.fetch("/production-alarm-orphan-lease");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error.phase, "github-runner-recheck");
  assert.match(body.error.message, /claim expired/);
  assert.deepEqual(body.events, [
    "claimed",
    "github-checked",
    "claim-retry",
  ]);
});

test("alarm orphan takeover revalidates before runner deletion [mutation: skip the delete ownership check]", async () => {
  const response = await worker.fetch(
    "/production-alarm-orphan-delete-ownership",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error.phase, "github-runner-delete");
  assert.deepEqual(body.events, [
    "claimed",
    "github-checked",
    "github-checked",
    "ownership-revalidated",
  ]);
});

test("alarm orphan takeover revalidates before sandbox destruction [mutation: skip the destroy ownership check]", async () => {
  const response = await worker.fetch(
    "/production-alarm-orphan-destroy-ownership",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error.phase, "sandbox-destroy");
  assert.deepEqual(body.events, [
    "claimed",
    "github-checked",
    "github-checked",
    "sandbox-accessed",
    "ownership-revalidated",
  ]);
});

test("alarm orphan cleanup retains a busy registration [mutation: remove the busy refusal]", async () => {
  const response = await worker.fetch("/production-alarm-orphan-busy");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome.status, "retained-busy");
  assert.equal(body.outcome.githubRunner.runnerId, 901);
  assert.deepEqual(body.events, [
    "claimed",
    "github-checked",
    "busy-postponed",
  ]);
});

test("alarm orphan cleanup retries an online registration [mutation: remove the online refusal]", async () => {
  const response = await worker.fetch("/production-alarm-orphan-online");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error.phase, "orphan-cleanup-refusal");
  assert.equal(
    body.error.message,
    "An online GitHub runner requires a terminal registry row",
  );
  assert.deepEqual(body.events, [
    "claimed",
    "github-checked",
    "claim-retry",
  ]);
});

test("repository cleanup keeps the exact GitHub URLs [mutation: route repository cleanup through an organization]", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=repository",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const listUrl =
    "https://api.github.com/repos/example/job-repository/actions/runners?" +
    "per_page=100&page=1&name=cloudflare-2-7";

  assert.deepEqual(body.calls, [
    { method: "GET", url: listUrl },
    { method: "GET", url: listUrl },
    {
      method: "DELETE",
      url:
        "https://api.github.com/repos/example/job-repository/actions/" +
        "runners/27",
    },
  ]);
  assert.equal(body.lookupOutcome, "registration-found");
  assert.equal(body.destroyCalls, 1);
  assert.equal(body.deleteCalls, 1);
});

test("organization cleanup uses the org endpoints and exact name [mutation: select the first scale-set runner]", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=organization",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const listUrl =
    "https://api.github.com/orgs/example/actions/runners?" +
    "per_page=100&page=1&name=cloudflare-2-7";

  assert.deepEqual(body.calls, [
    { method: "GET", url: listUrl },
    { method: "GET", url: listUrl },
    {
      method: "DELETE",
      url: "https://api.github.com/orgs/example/actions/runners/27",
    },
  ]);
  assert.equal(body.lookupOutcome, "registration-found");
  assert.equal(body.outcome.registrationCleanup.runnerId, 27);
});

test("organization cleanup does not delete a nonmatching runner [mutation: trust the server-side name filter]", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=absent",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.lookupOutcome, "registration-not-found");
  assert.equal(body.outcome.registrationCleanup.result, "already-absent");
  assert.deepEqual(
    body.calls.map((call) => call.method),
    ["GET"],
  );
  assert.equal(body.deleteCalls, 0);
});

test("organization cleanup retains a busy runner [mutation: remove the live busy guard]", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=busy",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.outcome.status, "retained-busy");
  assert.equal(body.postponeCalls, 1);
  assert.deepEqual(body.postponeOptions, [{ busy: true }]);
  assert.equal(body.destroyCalls, 0);
  assert.equal(body.deleteCalls, 0);
  assert.deepEqual(body.calls.map((call) => call.method), ["GET"]);
});

test("online idle retention postpones without entering the busy bound [mutation: remove retainOnlineRunner]", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=online",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.outcome.status, "retained-online");
  assert.equal(body.postponeCalls, 1);
  assert.deepEqual(body.postponeOptions, [null]);
  assert.equal(body.outcome.forcedBusyExit, undefined);
  assert.equal(body.destroyCalls, 0);
  assert.equal(body.deleteCalls, 0);
  assert.deepEqual(body.calls.map((call) => call.method), ["GET"]);
});

test("cleanup rechecks busy state after sandbox destruction [mutation: skip pre-delete recheck]", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=recheck-busy",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.outcome.status, "destroyed");
  assert.deepEqual(body.outcome.registrationCleanup, {
    runnerId: 27,
    result: "retained-busy",
  });
  assert.equal(body.destroyCalls, 1);
  assert.equal(body.deleteCalls, 0);
  assert.deepEqual(body.calls.map((call) => call.method), ["GET", "GET"]);
});

test("cleanup retains a changed registration identity [mutation: delete the rechecked id]", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=identity-changed",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.outcome.registrationCleanup, {
    runnerId: 28,
    result: "registration-identity-changed",
  });
  assert.equal(body.destroyCalls, 1);
  assert.equal(body.deleteCalls, 0);
  assert.deepEqual(body.calls.map((call) => call.method), ["GET", "GET"]);
});

test("cleanup skips GitHub when githubRunnerName is null [mutation: fall back to runnerName]", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=name-unknown",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.calls, []);
  assert.equal(body.deleteCalls, 0);
  assert.equal(body.destroyCalls, 1);
  assert.deepEqual(body.outcome.registrationCleanup, {
    runnerId: null,
    result: "name-unknown",
  });
  assert.equal(
    body.events.some((event) => event?.destroyedBy === "alarm"),
    true,
  );
});

test("cleanup treats a blank githubRunnerName as unknown", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=name-blank",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.calls, []);
  assert.deepEqual(body.outcome.registrationCleanup, {
    runnerId: null,
    result: "name-unknown",
  });
});

test("the registration delete switch skips a reverified delete", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=delete-disabled",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.outcome.registrationCleanup, {
    runnerId: 27,
    result: "delete-disabled",
  });
  assert.equal(body.destroyCalls, 1);
  assert.equal(body.deleteCalls, 0);
  assert.deepEqual(body.calls.map((call) => call.method), ["GET", "GET"]);
  assert.equal(
    body.logs.some(
      (entry) =>
        JSON.parse(entry).message ===
          "GitHub runner registration deletion disabled",
    ),
    true,
  );
});

test("only the exact off value disables registration deletion", async () => {
  const response = await worker.fetch(
    "/production-scoped-cleanup?mode=delete-enabled-other",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.outcome.registrationCleanup.result, "deleted");
  assert.equal(body.deleteCalls, 1);
  assert.deepEqual(
    body.calls.map((call) => call.method),
    ["GET", "GET", "DELETE"],
  );
});

test("reconcile rechecks GitHub busy state before sandbox destruction", async () => {
  const response = await worker.fetch("/production-reconcile-busy-race");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.events, ["claimed", "busy-claim-released"]);
  assert.equal(body.summary.destroyedSandboxes.length, 0);
  assert.equal(body.summary.retainedBusy.length, 1);
  assert.equal(body.summary.retainedBusy[0].source, "live-recheck");
  assert.equal(body.summary.subrequestsSpent, 9);
});

test("reconcile retains a busy authoritative name from the bulk listing [mutation: look up runnerName]", async () => {
  const response = await worker.fetch(
    "/production-reconcile-authoritative-busy-listing",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const runnerName =
    "cloudflare-00000000-0000-4000-8000-000000000701";
  const githubRunnerName = "cloudflare-74-4503599627370701";

  assert.deepEqual(body.listedRunnerNames, [githubRunnerName]);
  assert.equal(body.listedRunnerNames.includes(runnerName), false);
  assert.deepEqual(body.summary.retainedBusy, [{
    sandboxId: "runner-authoritative-busy-listing",
    runnerName,
    githubStatus: "online",
    githubBusy: true,
  }]);
  assert.equal(
    Object.hasOwn(body.summary.retainedBusy[0], "source"),
    false,
  );
  assert.deepEqual(body.claimCalls, []);
  assert.deepEqual(body.liveLookupNames, []);
  assert.deepEqual(body.destroyedSandboxIds, []);
  assert.deepEqual(body.deletedRunnerIds, []);
  assert.deepEqual(body.releaseCalls, []);
});

test("a retained-busy outcome never releases a reservation", async () => {
  const response = await worker.fetch("/production-reconcile-busy-race");
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.summary.retainedBusy.length, 1);
  assert.deepEqual(body.releaseCalls, []);

  const completed = await worker.fetch(
    "/production-alarm-reservation-release",
  );
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).releaseCalls.length, 1);
});

test("reconcile keeps repository summaries byte-compatible [mutation: add a scope field]", async () => {
  const response = await worker.fetch("/production-reconcile-repositories");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.listCalls, [
    "example/runner-test",
    "example/second-repository",
  ]);
  assert.equal(body.summary.githubRunnersListed, 2);
  assert.deepEqual(
    body.summary.retainedBusy.map((runner) => runner.runnerName),
    ["cloudflare-repository-1", "cloudflare-repository-2"],
  );
  assert.equal(body.summary.destroyedSandboxes.length, 0);
  assert.equal(body.summary.errors.length, 0);
  assert.equal(body.summary.subrequestsSpent, 3);
  assert.equal(JSON.stringify(body.summary).includes("\"scope\":"), false);
});

test("organization reconcile lists one scope for three repositories [mutation: group by job repository]", async () => {
  const response = await worker.fetch(
    "/production-reconcile-organization",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.listCalls, [{
    type: "organization",
    organization: "example",
  }]);
  assert.equal(body.summary.githubRunnersListed, 3);
  assert.equal(body.summary.retainedBusy.length, 3);
  assert.equal(body.summary.errors.length, 0);
  assert.equal(body.summary.subrequestsSpent, 2);
  assert.ok(
    body.summary.subrequestsSpent <= body.reconcileSubrequestBudget,
  );
});

test("organization listing errors include the organization label [mutation: emit a repository-shaped error]", async () => {
  const response = await worker.fetch(
    "/production-reconcile-organization?failure=1",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.summary.errors, [{
    repository: "example",
    scope: "organization",
    phase: "github-runner-list",
    errorName: "Error",
    error: "simulated organization listing failure",
  }]);
});

test("reconcile bounds simultaneous repository listings", async () => {
  const response = await worker.fetch(
    "/production-reconcile-listing-concurrency",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.repositoryCount, body.connectionLimit + 1);
  assert.equal(body.listCalls, body.repositoryCount);
  assert.equal(body.maxActiveListings, body.connectionLimit);
  assert.equal(body.summary.retainedBusy.length, body.repositoryCount);
  assert.equal(body.summary.errors.length, 0);
  assert.equal(body.summary.subrequestsSpent, body.repositoryCount + 1);
});

test("reconcile continues after a mid-loop registry claim rejection", async () => {
  const response = await worker.fetch(
    "/production-reconcile-claim-failure",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.claimCalls, [
    "runner-claim-before",
    "runner-claim-failed",
    "runner-claim-after",
  ]);
  assert.deepEqual(body.summary.destroyedSandboxes, [
    "runner-claim-before",
    "runner-claim-after",
  ]);
  assert.deepEqual(
    body.summary.reconciled.map((runner) => runner.sandboxId),
    ["runner-claim-before", "runner-claim-after"],
  );
  assert.deepEqual(body.summary.errors, [{
    sandboxId: "runner-claim-failed",
    runnerName: "cloudflare-claim-failed",
    phase: "registry-claim",
    error: "simulated registry claim rejection",
  }]);
  assert.equal(body.summary.subrequestsSpent, 17);
});

test("reconcile releases every destroyed candidate reservation exactly once", async () => {
  const response = await worker.fetch(
    "/production-reconcile-claim-failure",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.summary.destroyedSandboxes, [
    "runner-claim-before",
    "runner-claim-after",
  ]);
  assert.deepEqual(body.releaseCalls, [
    {
      sandboxId: "runner-claim-before",
      reason: "runner-destroyed",
    },
    {
      sandboxId: "runner-claim-after",
      reason: "runner-destroyed",
    },
  ]);
});

test("reconcile reports a runner listing that exceeds its page cap", async () => {
  const response = await worker.fetch(
    "/production-reconcile-listing-page-limit",
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.runnerListingPageLimitFetches, body.pageLimit);
  assert.equal(body.claimCalls, 0);
  assert.equal(body.summary.hasMoreCandidates, true);
  assert.equal(body.summary.subrequestsSpent, body.pageLimit + 1);
  assert.ok(
    body.summary.subrequestsSpent <= body.reconcileSubrequestBudget,
  );
  assert.deepEqual(body.summary.errors, [{
    repository: "example/listing-page-limit",
    phase: "github-runner-list",
    errorName: "GitHubRunnerListPageLimitExceeded",
    error:
      `GitHub runner listing for example/listing-page-limit exceeded the ` +
      `${body.pageLimit}-page reconcile limit`,
  }]);
});

test("reconcile at a 300-row fleet stays under the subrequest budget", async () => {
  const response = await worker.fetch("/production-reconcile-budget");
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.reconcileCandidatePageSize, 100);
  assert.equal(body.reconcileSubrequestBudget, 900);
  assert.equal(body.summary.candidates, 100);
  assert.equal(body.summary.hasMoreCandidates, true);
  assert.equal(body.summary.candidatePageSize, 100);
  assert.equal(body.summary.subrequestBudget, 900);
  assert.equal(body.summary.budgetExhausted, false);
  assert.equal(body.calls.releaseBySandbox, 100);
  // The observed spend equals the modelled spend, so the release occupies the
  // slot that a retry or a busy postponement would have taken on a failure.
  assert.equal(body.observedSubrequests, 723);
  assert.equal(body.summary.subrequestsSpent, 723);
  assert.ok(body.observedSubrequests <= body.reconcileSubrequestBudget);
  assert.equal(body.calls.listActiveBefore, 1);
  assert.equal(body.calls.listRepositoryRunners, 20);
  assert.equal(body.calls.claimForReconcile, 100);
  assert.equal(body.calls.findRepositoryRunnerByName, 200);
  assert.equal(body.calls.reconciliationSandbox, 100);
  assert.equal(body.calls.beginSandboxDestroy, 100);
  assert.equal(body.calls.waitForSandboxDestroy, 100);
  assert.equal(body.calls.deleteRepositoryRunner, 100);
  assert.equal(body.calls.settleCleanupClaim, 100);

  const fullPageWorstCase =
    RECONCILE_REGISTRY_READ_SUBREQUESTS +
    RECONCILE_LISTING_PAGINATION_RESERVE +
    RECONCILE_CANDIDATE_PAGE_SIZE *
      (
        RECONCILE_SUBREQUESTS_PER_CANDIDATE +
        RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING
      );
  // The shipped full-page worst-case bound is 833 subrequests.
  assert.ok(fullPageWorstCase < 900);
  assert.ok(fullPageWorstCase < 1_000);
  assert.ok(fullPageWorstCase < WORKER_SUBREQUEST_LIMIT);
});

test("the budget guard bounds the loop when the registry ignores the page limit", async () => {
  const response = await worker.fetch(
    "/production-reconcile-budget-ignored-limit",
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  const processedCandidates = body.calls.claimForReconcile;

  assert.ok(processedCandidates > 100);
  assert.ok(processedCandidates < 300);
  assert.ok(body.observedSubrequests <= 900);
  assert.ok(body.summary.subrequestsSpent <= 900);
  assert.equal(body.summary.budgetExhausted, true);
  assert.equal(body.summary.hasMoreCandidates, true);
  assert.equal(
    body.summary.errors.some(
      (error) => error.phase === "subrequest-budget",
    ),
    true,
  );
});

test("reconcile truncates unfunded candidate repository listings [mutation: list every repository]", async () => {
  const response = await worker.fetch(
    "/production-reconcile-listing-budget",
  );
  const body = await response.json();
  const hasListingBudgetError = body.summary.errors.some(
    (error) =>
      error.phase === "subrequest-budget" &&
      error.error.includes("list another candidate repository"),
  );

  // Candidate repositories: floor((900 - 32) / 1) + 1 = 869.
  // Funded listings: floor((900 - 1 - 32) / 1) = 867.
  // The harness records 1 registry read, 866 one-page listings, and one
  // 33-page listing: 1 + 866 + 33 = 900. Listing all repositories adds two
  // one-page listings, reaches 902, and omits the listing-budget error.
  assert.deepEqual(
    {
      budgetExhausted: body.summary.budgetExhausted,
      hasMoreCandidates: body.summary.hasMoreCandidates,
      hasListingBudgetError,
      distinctCandidateRepositories:
        body.distinctCandidateRepositories,
      fundedRepositoryCount: body.fundedRepositoryCount,
      listRepositoryRunners: body.calls.listRepositoryRunners,
      multiPageRepositoryListingSubrequests:
        body.multiPageRepositoryListingSubrequests,
      listedFewerThanCandidateRepositories:
        body.calls.listRepositoryRunners <
        body.distinctCandidateRepositories,
      observedSubrequests: body.observedSubrequests,
    },
    {
      budgetExhausted: true,
      hasMoreCandidates: true,
      hasListingBudgetError: true,
      distinctCandidateRepositories: 869,
      fundedRepositoryCount: 867,
      listRepositoryRunners: 867,
      multiPageRepositoryListingSubrequests: 33,
      listedFewerThanCandidateRepositories: true,
      observedSubrequests: 900,
    },
  );
});

test("the callback returns before its durable alarm destroys the sandbox", async () => {
  const response = await worker.fetch("/production-callback-scheduled");
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    cleanupStatus: "scheduled",
    sandboxId: "runner-callback-scheduled",
  });
});

test("callback contention is not reported as completed cleanup", async () => {
  const response = await worker.fetch("/production-callback-contention");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Runner cleanup could not be scheduled",
    cleanupStatus: "contended",
    sandboxId: "runner-callback-contention",
  });
});

test("documented orphan destroy bodies satisfy the Worker request contract", async () => {
  const documentedBodies = (
    await Promise.all(DOCUMENT_SECTIONS.map(extractOperatorRequestBodies))
  ).flat().filter(({ body }) =>
    Object.hasOwn(body, "observedSandboxInstanceId")
  );

  for (const [index, documented] of documentedBodies.entries()) {
    const { body, sandboxId } = substitutePlaceholders(documented.body, index);
    const response = await destroyOrphan(
      `orphan-runbook-contract-${index}`,
      sandboxId,
      body,
    );
    const responseText = await response.text();
    const responseBody = JSON.parse(responseText);

    assert.notEqual(
      response.status,
      400,
      `${documented.source} returned HTTP 400: ${responseText}`,
    );
    assert.notEqual(
      responseBody.outcome,
      "invalid-request",
      `${documented.source} returned invalid-request: ${responseText}`,
    );
    assert.equal(
      Object.hasOwn(documented.body, REMOVED_CREATION_TIME_FIELD),
      false,
      `${documented.source} contains ${REMOVED_CREATION_TIME_FIELD}`,
    );
  }
});

test("documented orphan reclaim bodies satisfy the Worker request contract", async () => {
  const documentedBodies = (
    await Promise.all(
      RECLAIM_DOCUMENT_SECTIONS.map(extractOperatorRequestBodies),
    )
  ).flat().filter(({ body }) => Object.hasOwn(body, "cloudflareAbsence"));

  for (const [index, documented] of documentedBodies.entries()) {
    const { body, sandboxId } = substitutePlaceholders(documented.body, index);
    const response = await reclaimAbsent(
      `reclaim-runbook-contract-${index}`,
      sandboxId,
      body.expectedRevision,
      { rawBody: body },
    );
    const responseText = await response.text();
    const responseBody = JSON.parse(responseText);

    assert.notEqual(
      response.status,
      400,
      `${documented.source} returned HTTP 400: ${responseText}`,
    );
    assert.notEqual(
      responseBody.outcome,
      "invalid-request",
      `${documented.source} returned invalid-request: ${responseText}`,
    );
  }
});

test("operator cleanup skips GitHub for an absent-row orphan [mutation: fall back to runnerName]", async () => {
  const registry = `orphan-absent-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000101";
  const response = await destroyAbsentOrphan(registry, sandboxId, {
    github: "idle",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, "destroyed");
  assert.equal(body.registrationLookupOutcome, "registration-name-unknown");
  assert.deepEqual(body.registrationCleanup, {
    runnerId: null,
    result: "name-unknown",
  });
  assert.deepEqual(body.githubRunnerNames, []);
  assert.deepEqual(body.deletedRunnerIds, []);
  assert.deepEqual(body.events, ["sandbox-destroyed"]);

  const rows = (await listRegistry(registry)).runners;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sandboxId, sandboxId);
  assert.equal(rows[0].state, "destroyed");
  assert.equal(rows[0].destroyedBy, "orphan");
  assert.equal(rows[0].createdAt, new Date(ORPHAN_TEST_NOW_MS).toISOString());
  assert.equal(rows[0].orphanInstanceId, DEFAULT_SANDBOX_INSTANCE_ID);
});

test("orphan cleanup releases only a destroyed sandbox reservation", async () => {
  const destroyedSandboxId =
    "runner-00000000-0000-4000-8000-000000000501";
  const destroyedResponse = await destroyAbsentOrphan(
    `orphan-release-destroyed-${testRunId}`,
    destroyedSandboxId,
  );
  assert.equal(destroyedResponse.status, 200);
  const destroyed = await destroyedResponse.json();
  assert.equal(destroyed.outcome, "destroyed");
  assert.deepEqual(destroyed.releaseCalls, [{
    sandboxId: destroyedSandboxId,
    reason: "runner-destroyed",
  }]);

  const refusedRegistry = `orphan-release-refused-${testRunId}`;
  const refusedSandboxId =
    "runner-00000000-0000-4000-8000-000000000502";
  const refusedRunner = await recordTerminal(
    refusedRegistry,
    refusedSandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
    "cloudflare-2-502",
  );
  const refusedResponse = await destroyTerminalOrphan(
    refusedRegistry,
    refusedSandboxId,
    refusedRunner,
    {
      github: "busy",
      observation: {
        observedRegistration: {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: refusedRunner.githubRunnerName,
          status: "online",
          busy: true,
        },
      },
    },
  );
  assert.equal(refusedResponse.status, 409);
  const refused = await refusedResponse.json();
  assert.equal(refused.outcome, "runner-busy");
  assert.deepEqual(refused.releaseCalls, []);
});

test("a completed orphan destroy restarts grace for the same generation", async () => {
  const registry = `orphan-grace-restart-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000401";
  const firstResponse = await destroyAbsentOrphan(registry, sandboxId);
  assert.equal(firstResponse.status, 200);

  const terminalRunner = (await listRegistry(registry)).runners[0];
  const reobservedAtMs = ORPHAN_TEST_NOW_MS + 1;
  const secondResponse = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    { primeGrace: false, nowMs: reobservedAtMs },
  );

  assert.equal(secondResponse.status, 409);
  const secondBody = await secondResponse.json();
  assert.equal(secondBody.outcome, "inside-grace");
  assert.equal(secondBody.sandboxAgeMs, 0);
  assert.equal(secondBody.ageSource, "worker-first-observed-at");
  const observationsResponse = await registryRequest(
    registry,
    "/orphan-observations",
    {},
  );
  assert.deepEqual((await observationsResponse.json()).observations, [
    {
      sandbox_id: sandboxId,
      instance_id: DEFAULT_SANDBOX_INSTANCE_ID,
      first_observed_at_ms: reobservedAtMs,
    },
  ]);
});

test("an observation beyond the existing horizon restarts grace", async () => {
  const registry = `orphan-observation-horizon-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000402";
  const seedResponse = await registryRequest(
    registry,
    "/seed-orphan-observations",
    {
      observations: [{
        sandboxId,
        instanceId: DEFAULT_SANDBOX_INSTANCE_ID,
        firstObservedAtMs:
          ORPHAN_TEST_NOW_MS - TERMINAL_RUNNER_RETENTION_MS - 1,
      }],
    },
  );
  assert.equal(seedResponse.status, 204);

  const response = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "inside-grace");
  assert.equal(body.sandboxAgeMs, 0);
  assert.equal(body.ageSource, "worker-first-observed-at");
  const observationsResponse = await registryRequest(
    registry,
    "/orphan-observations",
    {},
  );
  assert.deepEqual((await observationsResponse.json()).observations, [
    {
      sandbox_id: sandboxId,
      instance_id: DEFAULT_SANDBOX_INSTANCE_ID,
      first_observed_at_ms: ORPHAN_TEST_NOW_MS,
    },
  ]);
});

test("worker observations enforce the exact grace boundary [mutation: bypass ledger]", async () => {
  const registry = `orphan-realistic-grace-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000301";
  const observedSandboxInstanceId = "1".repeat(64);

  const firstResponse = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
    observation: {
      observedSandboxInstanceId,
    },
  });
  assert.equal(firstResponse.status, 409);
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.outcome, "inside-grace");
  assert.equal(firstBody.sandboxAgeMs, 0);
  assert.equal(firstBody.graceMs, ORPHAN_DESTROY_GRACE_MS);
  assert.equal(firstBody.ageSource, "worker-first-observed-at");

  const insideResponse = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
    nowMs: ORPHAN_TEST_NOW_MS + ORPHAN_DESTROY_GRACE_MS - 1,
    observation: { observedSandboxInstanceId },
  });
  assert.equal(insideResponse.status, 409);
  const insideBody = await insideResponse.json();
  assert.equal(insideBody.outcome, "inside-grace");
  assert.equal(insideBody.sandboxAgeMs, ORPHAN_DESTROY_GRACE_MS - 1);

  const boundaryResponse = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
    nowMs: ORPHAN_TEST_NOW_MS + ORPHAN_DESTROY_GRACE_MS,
    observation: { observedSandboxInstanceId },
  });
  assert.equal(boundaryResponse.status, 200);
  assert.equal((await boundaryResponse.json()).outcome, "destroyed");
});

test("instance identity distinguishes sandbox generations", async () => {
  const registry = `orphan-realistic-generation-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000302";
  const inventory = [
    "2".repeat(64),
    "3".repeat(64),
  ];

  const firstSighting = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
    observation: {
      observedSandboxInstanceId: inventory[0],
    },
  });
  assert.equal(firstSighting.status, 409);
  assert.equal((await firstSighting.json()).sandboxAgeMs, 0);

  const firstResponse = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
    nowMs: ORPHAN_TEST_NOW_MS + ORPHAN_DESTROY_GRACE_MS,
    observation: { observedSandboxInstanceId: inventory[0] },
  });
  assert.equal(firstResponse.status, 200);
  const terminalRow = (await listRegistry(registry)).runners[0];
  assert.equal(terminalRow.orphanInstanceId, inventory[0]);

  const secondResponse = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRow,
    {
      primeGrace: false,
      nowMs:
        ORPHAN_TEST_NOW_MS + ORPHAN_DESTROY_GRACE_MS + 48_000,
      observation: {
        observedSandboxInstanceId: inventory[1],
      },
    },
  );

  assert.equal(secondResponse.status, 409);
  const secondBody = await secondResponse.json();
  assert.equal(secondBody.outcome, "sandbox-generation-mismatch");
  assert.equal(secondBody.observedSandboxInstanceId, inventory[1]);
  assert.equal(secondBody.recordedSandboxInstanceId, inventory[0]);
});

test("an invalid terminal alarm source does not block an orphan claim", async () => {
  const registry = `orphan-claim-invalid-terminal-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000202";
  await configureSandbox(registry, sandboxId);
  const observationResponse = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
  });
  assert.equal(observationResponse.status, 409);
  assert.equal((await observationResponse.json()).outcome, "inside-grace");
  const seedResponse = await registryRequest(
    registry,
    "/seed-invalid-terminal-row",
    { sandboxId: "runner-invalid-terminal-alarm" },
  );
  assert.equal(seedResponse.status, 204);

  const response = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
    nowMs: ORPHAN_TEST_NOW_MS + ORPHAN_DESTROY_GRACE_MS,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, "destroyed");
  assert.deepEqual(body.events, ["sandbox-destroyed"]);
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });
  const rows = (await listRegistry(registry)).runners;
  assert.equal(
    rows.some(
      (runner) => runner.sandboxId === sandboxId && runner.state === "destroyed",
    ),
    true,
  );
});

test("a GitHub check failure cancels the orphan claim", async () => {
  const registry = `orphan-check-failure-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000203";
  await configureSandbox(registry, sandboxId);
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );

  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    { github: "error" },
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.phase, "github-runner-check");
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, ["github-checked"]);

  await runRegistryAlarm(
    registry,
    ORPHAN_TEST_NOW_MS + CLEANUP_CLAIM_STALE_MS + 1,
  );
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });
  assert.equal((await listRegistry(registry)).runners[0].state, "destroyed");
});

test("a GitHub delete failure cancels the orphan claim", async () => {
  const registry = `orphan-delete-failure-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000204";
  await configureSandbox(registry, sandboxId);
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );

  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    {
      github: "offline",
      deleteResult: "error",
      observation: {
        observedRegistration: {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: terminalRunner.githubRunnerName,
          status: "offline",
          busy: false,
        },
      },
    },
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.phase, "github-runner-delete");
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, ["github-checked", "github-checked"]);

  await runRegistryAlarm(
    registry,
    ORPHAN_TEST_NOW_MS + CLEANUP_CLAIM_STALE_MS + 1,
  );
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });
  assert.equal((await listRegistry(registry)).runners[0].state, "destroyed");
});

test("the production route reaches guarded orphan destruction", async () => {
  const sandboxId = `runner-${testRunId}`;
  const observedSandboxInstanceId = "5".repeat(64);
  await configureSandbox("orphan-production-route", sandboxId);
  const observationResponse = await registryRequest(
    "singleton",
    "/claim-for-orphan-cleanup",
    {
      sandboxId,
      observedCondition: "absent",
      expectedRevision: null,
      observedSandboxInstanceId,
      cleanupToken: "production-route-observation",
      cleanupStartedAt: new Date(
        Date.now() - ORPHAN_DESTROY_GRACE_MS - 1,
      ).toISOString(),
    },
  );
  assert.equal(observationResponse.status, 200);
  assert.equal((await observationResponse.json()).reason, "inside-grace");
  const response = await worker.fetch(
    `/operator/orphans/${sandboxId}/destroy?productionRoute=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONTROL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        observedRegistryCondition: "absent",
        expectedRevision: null,
        observedSandboxInstanceId,
        observedRegistration: {
          outcome: "registration-not-found",
          runnerName: `cloudflare-${testRunId}`,
        },
      }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outcome, "destroyed");
  assert.deepEqual(await sandboxStatus("orphan-production-route", sandboxId), {
    destroyAttempts: 1,
    destroyed: 1,
  });
  const terminalRow = (await listRegistry("singleton")).runners.find(
    (runner) => runner.sandboxId === sandboxId,
  );
  assert.equal(terminalRow?.state, "destroyed");
  assert.equal(terminalRow?.destroyedBy, "orphan");
});

test("the first terminal orphan observation binds its sandbox generation", async () => {
  const registry = `orphan-terminal-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000102";
  const observedSandboxInstanceId = "7".repeat(64);
  const mismatchedSandboxInstanceId = "8".repeat(64);
  const terminalRow = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - 60_001,
  );

  const firstResponse = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRow,
    {
      primeGrace: false,
      nowMs: ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS,
      observation: { observedSandboxInstanceId },
    },
  );
  assert.equal(firstResponse.status, 409);
  assert.equal((await firstResponse.json()).outcome, "inside-grace");
  assert.equal(
    (await listRegistry(registry)).runners[0].orphanInstanceId,
    observedSandboxInstanceId,
  );

  const mismatchResponse = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRow,
    {
      primeGrace: false,
      observation: {
        observedSandboxInstanceId: mismatchedSandboxInstanceId,
      },
    },
  );
  assert.equal(mismatchResponse.status, 409);
  const mismatch = await mismatchResponse.json();
  assert.equal(mismatch.outcome, "sandbox-generation-mismatch");
  assert.equal(mismatch.recordedSandboxInstanceId, observedSandboxInstanceId);

  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRow,
    {
      primeGrace: false,
      observation: { observedSandboxInstanceId },
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, "destroyed");
  assert.deepEqual(body.events, [
    "github-checked",
    "github-checked",
    "sandbox-destroyed",
  ]);

  const rows = (await listRegistry(registry)).runners;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "destroyed");
  assert.equal(rows[0].destroyedBy, "orphan");
});

test("operator cleanup keeps a terminal row without a destruction time", async () => {
  const registry = `orphan-terminal-unverified-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000303";
  const seedResponse = await registryRequest(
    registry,
    "/seed-unverified-terminal-row",
    { sandboxId },
  );
  assert.equal(seedResponse.status, 204);
  const terminalRow = (await listRegistry(registry)).runners[0];

  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRow,
    { primeGrace: false },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "terminal-generation-unverified");
  assert.deepEqual(body.events, []);
  const retainedRow = (await listRegistry(registry)).runners[0];
  assert.equal(retainedRow.state, "destroyed");
  assert.equal(retainedRow.revision, terminalRow.revision);
});

test("operator cleanup refuses a live registry row", async () => {
  const registry = `orphan-live-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000103";
  await recordStarting(registry, sandboxId, ORPHAN_TEST_NOW_MS - 60_001);

  const response = await destroyOrphan(
    registry,
    sandboxId,
    {
      observedRegistryCondition: "terminal",
      expectedRevision: 0,
    },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "live-row");
  assert.deepEqual(body.correctPaths, [
    "DELETE /runners/:sandboxId",
    "POST /reconcile",
  ]);
  assert.deepEqual(body.events, []);
  assert.equal((await listRegistry(registry)).runners[0].state, "starting");
});

test("operator cleanup refuses changed registry observations", async () => {
  const terminalRegistry = `orphan-mismatch-terminal-${testRunId}`;
  const terminalId = "runner-00000000-0000-4000-8000-000000000104";
  await recordTerminal(
    terminalRegistry,
    terminalId,
    ORPHAN_TEST_NOW_MS - 60_001,
  );
  const terminalResponse = await destroyOrphan(
    terminalRegistry,
    terminalId,
    { observedRegistryCondition: "absent" },
  );
  assert.equal(terminalResponse.status, 409);
  const terminalBody = await terminalResponse.json();
  assert.equal(terminalBody.outcome, "observation-mismatch");
  assert.equal(terminalBody.actualRegistryCondition, "terminal");
  assert.deepEqual(terminalBody.events, []);

  const absentRegistry = `orphan-mismatch-absent-${testRunId}`;
  const absentId = "runner-00000000-0000-4000-8000-000000000105";
  const absentResponse = await destroyOrphan(
    absentRegistry,
    absentId,
    {
      observedRegistryCondition: "terminal",
      expectedRevision: 0,
    },
  );
  assert.equal(absentResponse.status, 409);
  const absentBody = await absentResponse.json();
  assert.equal(absentBody.outcome, "observation-mismatch");
  assert.equal(absentBody.actualRegistryCondition, "absent");
  assert.deepEqual(absentBody.events, []);
  assert.equal((await listRegistry(absentRegistry)).runners.length, 0);
});

test("operator cleanup uses the audited GitHub name and deletes the rechecked id", async () => {
  const registry = `orphan-authoritative-name-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000601";
  const githubRunnerName = "cloudflare-72-4503599627370601";
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
    githubRunnerName,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    {
      github: "offline",
      observation: {
        observedRegistration: {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: githubRunnerName,
          status: "offline",
          busy: false,
        },
      },
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.registrationLookupOutcome, "registration-found");
  assert.deepEqual(body.githubRunnerNames, [
    githubRunnerName,
    githubRunnerName,
  ]);
  assert.deepEqual(body.deletedRunnerIds, [901]);
  assert.deepEqual(body.registrationCleanup, {
    runnerId: 901,
    result: "deleted",
  });
  assert.deepEqual(body.events, [
    "github-checked",
    "github-checked",
    "registration-deleted",
    "sandbox-destroyed",
  ]);
});

test("the registration delete switch skips an orphan by-id delete", async () => {
  const registry = `orphan-delete-disabled-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000602";
  const githubRunnerName = "cloudflare-72-4503599627370602";
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
    githubRunnerName,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    {
      github: "offline",
      registrationDelete: "off",
      observation: {
        observedRegistration: {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: githubRunnerName,
          status: "offline",
          busy: false,
        },
      },
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.githubRunnerNames, [
    githubRunnerName,
    githubRunnerName,
  ]);
  assert.deepEqual(body.deletedRunnerIds, []);
  assert.deepEqual(body.registrationCleanup, {
    runnerId: 901,
    result: "delete-disabled",
  });
  assert.equal(
    body.logs.some(
      (entry) =>
        JSON.parse(entry).message ===
          "GitHub runner registration deletion disabled",
    ),
    true,
  );
});

test("operator cleanup refuses a busy GitHub runner", async () => {
  const registry = `orphan-busy-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000106";
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    {
      github: "busy",
      observation: {
        observedRegistration: {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: terminalRunner.githubRunnerName,
          status: "online",
          busy: true,
        },
      },
    },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "runner-busy");
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, ["github-checked"]);
  assert.equal((await listRegistry(registry)).runners[0].state, "destroyed");
});

test("operator cleanup skips an online lookup without an authoritative name", async () => {
  const registry = `orphan-online-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000205";
  await configureSandbox(registry, sandboxId);
  const response = await destroyAbsentOrphan(registry, sandboxId, {
    github: "online",
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, "destroyed");
  assert.equal(body.registrationLookupOutcome, "registration-name-unknown");
  assert.deepEqual(body.registrationCleanup, {
    runnerId: null,
    result: "name-unknown",
  });
  assert.deepEqual(body.events, ["sandbox-destroyed"]);
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });
  assert.equal((await listRegistry(registry)).runners[0].state, "destroyed");
});

test("operator cleanup refuses a changed registration observation", async () => {
  const registry = `orphan-registration-mismatch-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000206";
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    { github: "offline" },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "registration-observation-mismatch");
  assert.equal(body.liveRegistration.outcome, "registration-found");
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, ["github-checked"]);
  assert.equal((await listRegistry(registry)).runners[0].state, "destroyed");
});

test("operator cleanup rechecks busy state before registration deletion", async () => {
  const registry = `orphan-busy-recheck-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000207";
  await configureSandbox(registry, sandboxId);
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    {
      github: "busy-on-recheck",
      observation: {
        observedRegistration: {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: terminalRunner.githubRunnerName,
          status: "offline",
          busy: false,
        },
      },
    },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "runner-busy");
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, ["github-checked", "github-checked"]);
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });
  assert.equal((await listRegistry(registry)).runners[0].state, "destroyed");
});

test("a busy refusal disarms a stale-reclaimed orphan claim", async () => {
  const registry = `orphan-busy-stale-claim-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000208";
  await configureSandbox(registry, sandboxId);
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    {
      github: "busy",
      cancel: "stale-reclaim",
      observation: {
        observedRegistration: {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: terminalRunner.githubRunnerName,
          status: "online",
          busy: true,
        },
      },
    },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "runner-busy");
  assert.equal(body.cancelAttempts, 2);
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, ["github-checked"]);
  assert.equal((await listRegistry(registry)).runners[0].state, "destroyed");

  await runRegistryAlarm(
    registry,
    ORPHAN_TEST_NOW_MS + 2 * CLEANUP_CLAIM_STALE_MS,
  );
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });
});

test("operator cleanup stops when the claim lease expires", async () => {
  const registry = `orphan-lease-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000209";
  await configureSandbox(registry, sandboxId);
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    { github: "lease-expired" },
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.phase, "github-runner-recheck");
  assert.equal(body.error, "Runner cleanup failed");
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, ["github-checked"]);
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });
});

test("operator cleanup logs redacted internal failure text", async () => {
  const registry = `orphan-secret-failure-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000215";
  const secret = CONTROL_TOKEN;
  const source = `simulated cleanup failure ${secret}`;
  assert.equal(source.includes(secret), true);
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    { errorMessage: source, github: "error" },
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.outcome, "failed");
  assert.equal(body.error, "Runner cleanup failed");
  assert.equal(JSON.stringify(body).includes(secret), false);
  assert.equal(JSON.stringify(body.logs).includes(secret), false);
  assert.equal(body.logs.length, 1);
  assert.deepEqual(JSON.parse(body.logs[0]).error, {
    name: "Error",
    message: "simulated cleanup failure [REDACTED]",
    cause: {
      name: "Error",
      message: "simulated cleanup failure [REDACTED]",
    },
  });
});

test("operator cleanup uses the stored lease [mutation: derive it from the Worker clock]", async () => {
  const registry = `orphan-stored-lease-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000214";
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    { claimLease: "expired" },
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.phase, "github-runner-check");
  assert.equal(body.error, "Runner cleanup failed");
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, []);
  assert.equal((await listRegistry(registry)).runners[0].state, "destroyed");
});

test("operator cleanup revalidates claim ownership before deletion", async () => {
  const registry = `orphan-ownership-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000210";
  await configureSandbox(registry, sandboxId);
  const terminalRunner = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS - 1,
  );
  const response = await destroyTerminalOrphan(
    registry,
    sandboxId,
    terminalRunner,
    {
      github: "offline",
      ownership: "lost",
      observation: {
        observedRegistration: {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: terminalRunner.githubRunnerName,
          status: "offline",
          busy: false,
        },
      },
    },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "claim-lost");
  assert.equal(body.phase, "github-runner-delete");
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, ["github-checked", "github-checked"]);
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });
});

test("operator cleanup revalidates claim ownership before sandbox destruction", async () => {
  const registry = `orphan-destroy-ownership-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000213";
  await configureSandbox(registry, sandboxId);
  const response = await destroyAbsentOrphan(registry, sandboxId, {
    ownership: "lost",
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "claim-lost");
  assert.equal(body.phase, "sandbox-destroy");
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, []);
  assert.deepEqual(await sandboxStatus(registry, sandboxId), {
    destroyAttempts: 0,
    destroyed: 0,
  });
});

test("operator cleanup refuses a stale terminal revision before destroy", async () => {
  const registry = `orphan-stale-revision-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000112";
  const observedRow = await recordTerminal(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - 60_001,
  );

  const mutationResponse = await destroyTerminalOrphan(
    registry,
    sandboxId,
    observedRow,
    {
      observation: {
        observedRegistration: {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: observedRow.githubRunnerName,
          status: "online",
          busy: true,
        },
      },
      github: "busy",
    },
  );
  assert.equal(mutationResponse.status, 409);
  assert.equal((await mutationResponse.json()).outcome, "runner-busy");
  const changedRow = (await listRegistry(registry)).runners[0];
  assert.notEqual(changedRow.revision, observedRow.revision);
  assert.equal(changedRow.destroyedAt, observedRow.destroyedAt);
  assert.equal(changedRow.destroyedBy, observedRow.destroyedBy);

  const staleResponse = await destroyTerminalOrphan(
    registry,
    sandboxId,
    observedRow,
    { primeGrace: false },
  );
  assert.equal(staleResponse.status, 409);
  const staleBody = await staleResponse.json();
  assert.equal(staleBody.outcome, "revision-conflict");
  assert.equal(staleBody.expectedRevision, observedRow.revision);
  assert.equal(staleBody.actualRevision, changedRow.revision);
  assert.deepEqual(staleBody.events, []);
  assert.equal((await listRegistry(registry)).runners[0].state, "destroyed");
});

test("operator cleanup abandons a changed generation before destroy", async () => {
  const registry = `orphan-generation-recheck-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000107";
  const observedSandboxInstanceId = "6".repeat(64);
  const firstResponse = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
    observation: { observedSandboxInstanceId },
  });
  assert.equal(firstResponse.status, 409);
  assert.equal((await firstResponse.json()).sandboxAgeMs, 0);

  const response = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
    nowMs: ORPHAN_TEST_NOW_MS + ORPHAN_DESTROY_GRACE_MS,
    sandboxGeneration: "changed",
    observation: { observedSandboxInstanceId },
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "sandbox-generation-mismatch");
  assert.equal(body.phase, "sandbox-destroy");
  assert.equal(body.observedSandboxInstanceId, observedSandboxInstanceId);
  assert.equal(body.recordedSandboxInstanceId, "f".repeat(64));
  assert.equal(body.residualDestroyClaim, false);
  assert.deepEqual(body.events, []);
  assert.equal((await listRegistry(registry)).runners.length, 0);
});

test("the orphan claim clock starts after the request body is parsed", async () => {
  const response = await worker.fetch("/production-orphan-claim-clock");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.responseStatus, 409);
  assert.equal(body.claimedAt, body.parsedAt);
});

test("operator cleanup requires a lowercase 64-hex instance identifier", async () => {
  const invalidInstanceIds = [
    undefined,
    1,
    ["a".repeat(64)],
    { value: "a".repeat(64) },
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
  ];
  for (const [index, observedSandboxInstanceId] of invalidInstanceIds.entries()) {
    const registry = `orphan-instance-invalid-${index}-${testRunId}`;
    const sandboxId = `runner-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const response = await destroyAbsentOrphan(registry, sandboxId, {
      primeGrace: false,
      observation: { observedSandboxInstanceId },
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.outcome, "invalid-request");
    assert.match(body.error, /observedSandboxInstanceId/);
    assert.match(body.error, /exactly 64 lowercase hexadecimal characters/);
    assert.deepEqual(body.events, []);
    assert.equal((await listRegistry(registry)).runners.length, 0);
  }
});

test("operator cleanup rejects the removed timestamp as an unknown field", async () => {
  const registry = `orphan-removed-field-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000109";
  const removedField = ["observedSandbox", "CreatedAt"].join("");
  const response = await destroyAbsentOrphan(registry, sandboxId, {
    primeGrace: false,
    observation: {
      [removedField]: new Date(ORPHAN_TEST_NOW_MS).toISOString(),
    },
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.outcome, "invalid-request");
  assert.equal(body.error, `Unknown request field: ${removedField}`);
  assert.deepEqual(body.events, []);
  assert.equal((await listRegistry(registry)).runners.length, 0);
});

test("operator cleanup reports a bounded destroy timeout", async () => {
  const registry = `orphan-timeout-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000110";
  const response = await destroyAbsentOrphan(registry, sandboxId, {
    destroy: "timeout",
  });
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.outcome, "destroy-timeout");
  assert.equal(body.error, "Runner cleanup exceeded the destroy timeout");
  assert.deepEqual(body.events, ["sandbox-destroy-started"]);
  assert.deepEqual(body.timeoutProof, {
    timeoutMs: DESTROY_TIMEOUT_MS,
    settledBeforeBoundary: false,
  });
  const rows = (await listRegistry(registry)).runners;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "destroying");
  assert.equal(
    rows[0].cleanupDueAt,
    new Date(ORPHAN_TEST_NOW_MS + DESTROY_TIMEOUT_MS).toISOString(),
  );
});

test("operator cleanup authenticates and validates the sandbox identifier", async () => {
  const sandboxId = "runner-00000000-0000-4000-8000-000000000111";
  const unauthorizedResponse = await destroyAbsentOrphan(
    `orphan-unauthorized-${testRunId}`,
    sandboxId,
    {
      primeGrace: false,
      authorization: "Bearer incorrect-control-token-value",
    },
  );
  assert.equal(unauthorizedResponse.status, 401);
  const unauthorizedBody = await unauthorizedResponse.json();
  assert.equal(unauthorizedBody.outcome, "unauthorized");
  assert.deepEqual(unauthorizedBody.events, []);

  const invalidResponse = await destroyOrphan(
    `orphan-invalid-id-${testRunId}`,
    "runner-invalid",
    { observedRegistryCondition: "terminal", expectedRevision: 0 },
  );
  assert.equal(invalidResponse.status, 400);
  const invalidBody = await invalidResponse.json();
  assert.equal(invalidBody.outcome, "invalid-request");
  assert.deepEqual(invalidBody.events, []);
});

test("orphan reclaim requires complete Cloudflare enumeration evidence", async () => {
  const registry = `reclaim-enumeration-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000401";
  const validBody = reclaimRequestBody(sandboxId, 0);
  const missingAbsence = structuredClone(validBody);
  delete missingAbsence.cloudflareAbsence;
  const invalidBodies = [
    missingAbsence,
    ...[
      "truncated",
      "page-limit-reached",
      "incomplete",
      "",
      1,
      null,
    ].map((enumerationOutcome) => ({
      ...validBody,
      cloudflareAbsence: {
        ...validBody.cloudflareAbsence,
        enumerationOutcome,
      },
    })),
  ];

  for (const rawBody of invalidBodies) {
    const response = await reclaimAbsent(registry, sandboxId, 0, { rawBody });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.outcome, "invalid-request");
    assert.deepEqual(body.events, []);
    assert.deepEqual(body.releaseCalls, []);
  }
});

test("orphan reclaim rejects unknown attestation fields", async () => {
  const registry = `reclaim-fields-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000402";
  const cases = [
    { unexpected: true },
    { cloudflareAbsence: { unexpected: true } },
  ];
  for (const body of cases) {
    const response = await reclaimAbsent(registry, sandboxId, 0, { body });
    assert.equal(response.status, 400);
    const responseBody = await response.json();
    assert.equal(responseBody.outcome, "invalid-request");
    assert.deepEqual(responseBody.events, []);
  }
});

test("orphan reclaim requires an absent matching GitHub registration", async () => {
  const registry = `reclaim-registration-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000403";
  await recordReclaimRunner(registry, sandboxId);
  const cases = [
    {
      observedRegistration: {
        outcome: "registration-found",
        runnerName: "cloudflare-00000000-0000-4000-8000-000000000403",
      },
    },
    {
      observedRegistration: {
        runnerName: "cloudflare-00000000-0000-4000-8000-000000000404",
      },
    },
  ];
  for (const body of cases) {
    const response = await reclaimAbsent(registry, sandboxId, 0, { body });
    assert.equal(response.status, 400);
    const responseBody = await response.json();
    assert.equal(responseBody.outcome, "invalid-request");
    assert.deepEqual(responseBody.events, []);
  }
});

test("orphan reclaim validates the recorded GitHub runner name before mutation", async () => {
  const registry = `reclaim-authoritative-name-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000414";
  const derivedRunnerName =
    "cloudflare-00000000-0000-4000-8000-000000000414";
  const authoritativeRunnerName = "cloudflare-2-4503599627370520";
  const runner = await recordReclaimRunner(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS,
    authoritativeRunnerName,
  );

  const mismatchResponse = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    {
      body: {
        observedRegistration: { runnerName: derivedRunnerName },
      },
    },
  );
  assert.equal(mismatchResponse.status, 400);
  const mismatchBody = await mismatchResponse.json();
  assert.equal(mismatchBody.outcome, "invalid-request");
  assert.equal(
    mismatchBody.error,
    "observedRegistration.runnerName does not match the registry runner",
  );
  assert.equal(mismatchBody.sandboxId, sandboxId);
  assert.equal(mismatchBody.runnerName, authoritativeRunnerName);
  assert.deepEqual(mismatchBody.events, []);
  assert.deepEqual(mismatchBody.releaseCalls, []);
  assert.deepEqual(await listReclaimObservations(registry), []);

  const acceptedResponse = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    {
      body: {
        observedRegistration: { runnerName: authoritativeRunnerName },
      },
    },
  );
  assert.equal(acceptedResponse.status, 202);
  assert.equal((await acceptedResponse.json()).outcome, "absence-recorded");
  assert.deepEqual(await listReclaimObservations(registry), [
    {
      sandbox_id: sandboxId,
      revision: runner.revision,
      first_observed_at_ms: ORPHAN_TEST_NOW_MS,
    },
  ]);
});

test("orphan reclaim accepts the UUID-derived name for a legacy row", async () => {
  const registry = `reclaim-legacy-name-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000415";
  const runner = await recordReclaimRunner(registry, sandboxId);
  assert.equal(runner.githubRunnerName, null);

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).outcome, "absence-recorded");
  assert.deepEqual(await listReclaimObservations(registry), [
    {
      sandbox_id: sandboxId,
      revision: runner.revision,
      first_observed_at_ms: ORPHAN_TEST_NOW_MS,
    },
  ]);
});

test("orphan reclaim keeps a row inside the existing grace", async () => {
  const registry = `reclaim-row-grace-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000404";
  const runner = await recordReclaimRunner(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS + 1,
  );

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "within-grace");
  assert.equal(body.graceMs, ORPHAN_DESTROY_GRACE_MS);
  assert.deepEqual(body.events, []);
  assert.deepEqual(body.releaseCalls, []);
  assert.deepEqual(await listReclaimObservations(registry), []);
  const retained = (await listRegistry(registry)).runners[0];
  assert.equal(retained.state, "online");
  assert.equal(retained.revision, runner.revision);
});

test("orphan reclaim records one observation without changing the runner", async () => {
  const registry = `reclaim-first-observation-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000405";
  const runner = await recordReclaimRunner(registry, sandboxId);

  const firstResponse = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
  );
  assert.equal(firstResponse.status, 202);
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.outcome, "absence-recorded");
  assert.equal(firstBody.sandboxId, sandboxId);
  assert.equal(firstBody.revision, runner.revision);
  assert.equal(
    firstBody.reclaimableAtMs,
    ORPHAN_TEST_NOW_MS + ORPHAN_DESTROY_GRACE_MS,
  );
  assert.deepEqual(firstBody.events, []);
  assert.deepEqual(firstBody.releaseCalls, []);
  const afterFirst = (await listRegistry(registry)).runners[0];
  assert.equal(afterFirst.state, runner.state);
  assert.equal(afterFirst.revision, runner.revision);

  const earlyResponse = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    { nowMs: firstBody.reclaimableAtMs - 1 },
  );
  assert.equal(earlyResponse.status, 409);
  const earlyBody = await earlyResponse.json();
  assert.equal(earlyBody.outcome, "absence-pending");
  assert.deepEqual(earlyBody.events, []);
  assert.deepEqual(earlyBody.releaseCalls, []);
  const afterEarly = (await listRegistry(registry)).runners[0];
  assert.equal(afterEarly.state, runner.state);
  assert.equal(afterEarly.revision, runner.revision);
});

test("a changed revision starts a new orphan reclaim observation pair", async () => {
  const registry = `reclaim-new-revision-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000406";
  const { body: firstBody, runner } = await primeReclaimObservation(
    registry,
    sandboxId,
  );
  const advanceResponse = await registryRequest(
    registry,
    "/advance-revision",
    { sandboxId },
  );
  assert.equal(advanceResponse.status, 200);
  const nextRevision = (await advanceResponse.json()).revision;
  assert.notEqual(nextRevision, runner.revision);

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    nextRevision,
    { nowMs: firstBody.reclaimableAtMs },
  );
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.outcome, "absence-recorded");
  assert.equal(body.revision, nextRevision);
  assert.deepEqual(body.events, []);
  assert.deepEqual(body.releaseCalls, []);
  const row = (await listRegistry(registry)).runners[0];
  assert.equal(row.state, "online");
  assert.equal(row.revision, nextRevision);
  assert.deepEqual(
    (await listReclaimObservations(registry)).map(
      (observation) => observation.revision,
    ),
    [runner.revision, nextRevision],
  );
});

test("a stale orphan reclaim observation restarts its grace", async () => {
  const registry = `reclaim-stale-observation-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000407";
  const { runner } = await primeReclaimObservation(registry, sandboxId);
  const refreshedAtMs =
    ORPHAN_TEST_NOW_MS + ORPHAN_OBSERVATION_MAX_AGE_MS + 1;

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    { nowMs: refreshedAtMs },
  );
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.outcome, "absence-recorded");
  assert.equal(
    body.reclaimableAtMs,
    refreshedAtMs + ORPHAN_DESTROY_GRACE_MS,
  );
  assert.deepEqual(body.events, []);
  assert.deepEqual(body.releaseCalls, []);
  assert.equal((await listRegistry(registry)).runners[0].state, "online");
});

test("orphan reclaim reports a revision conflict at the cleanup claim", async () => {
  const registry = `reclaim-claim-conflict-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000408";
  const { body: firstBody, runner } = await primeReclaimObservation(
    registry,
    sandboxId,
  );

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    {
      nowMs: firstBody.reclaimableAtMs,
      claimRace: "revision",
    },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "revision-conflict");
  assert.equal(body.expectedRevision, runner.revision);
  assert.equal(body.actualRevision, runner.revision + 1);
  assert.deepEqual(body.events, []);
  assert.deepEqual(body.releaseCalls, []);
  const row = (await listRegistry(registry)).runners[0];
  assert.equal(row.state, "online");
  assert.equal(row.revision, runner.revision + 1);
});

test("orphan reclaim keeps a busy runner after the live GitHub check", async () => {
  const registry = `reclaim-busy-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000409";
  const { body: firstBody, runner } = await primeReclaimObservation(
    registry,
    sandboxId,
  );

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    { nowMs: firstBody.reclaimableAtMs, github: "busy" },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "runner-busy");
  assert.deepEqual(body.events, ["github-checked"]);
  assert.deepEqual(body.releaseCalls, []);
  const row = (await listRegistry(registry)).runners[0];
  assert.equal(row.state, "online");
  assert.equal(row.destroyedAt, null);
});

test("orphan reclaim keeps an online registration that contradicts the caller", async () => {
  const registry = `reclaim-online-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000410";
  const { body: firstBody, runner } = await primeReclaimObservation(
    registry,
    sandboxId,
  );

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    { nowMs: firstBody.reclaimableAtMs, github: "online" },
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.outcome, "runner-online");
  assert.deepEqual(body.events, ["github-checked"]);
  assert.deepEqual(body.releaseCalls, []);
  const row = (await listRegistry(registry)).runners[0];
  assert.equal(row.state, "online");
  assert.equal(row.destroyedAt, null);
});

test("two orphan reclaim observations execute the reconcile cleanup", async () => {
  const registry = `reclaim-success-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000411";
  const { body: firstBody, runner } = await primeReclaimObservation(
    registry,
    sandboxId,
  );

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    { nowMs: firstBody.reclaimableAtMs },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, "reclaimed");
  assert.equal(body.sandboxId, sandboxId);
  assert.equal(body.runnerName, runner.runnerName);
  assert.equal(body.registrationLookupOutcome, "registration-not-found");
  assert.deepEqual(body.events, [
    "github-checked",
    "sandbox-destroyed",
  ]);
  assert.equal(body.releaseCalls.length, 1);
  assert.equal(body.releaseCalls[0].sandboxId, sandboxId);
  const row = (await listRegistry(registry)).runners[0];
  assert.equal(row.state, "destroyed");
  assert.equal(row.destroyedBy, "reconcile");
  assert.deepEqual(await listReclaimObservations(registry), []);
});

test("orphan reclaim deletes an offline registration by its reverified id", async () => {
  const registry = `reclaim-offline-delete-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000603";
  const githubRunnerName = "cloudflare-73-4503599627370603";
  const runner = await recordReclaimRunner(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS,
    githubRunnerName,
  );
  const firstResponse = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    {
      body: {
        observedRegistration: { runnerName: githubRunnerName },
      },
    },
  );
  assert.equal(firstResponse.status, 202);
  const firstBody = await firstResponse.json();

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    {
      nowMs: firstBody.reclaimableAtMs,
      github: "offline",
      body: {
        observedRegistration: { runnerName: githubRunnerName },
      },
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.outcome, "reclaimed");
  assert.deepEqual(body.events, [
    "github-checked",
    "sandbox-destroyed",
    "github-checked",
    "registration-cleaned",
  ]);
  assert.deepEqual(body.deletedRunnerIds, [901]);
  assert.deepEqual(body.githubRunnerNames, [
    githubRunnerName,
    githubRunnerName,
  ]);
  assert.deepEqual(body.registrationCleanup, {
    runnerId: 901,
    result: "deleted",
  });
});

test("orphan reclaim retains a registration that becomes online after sandbox destruction [mutation: remove post-destroy online guard]", async () => {
  const registry = `reclaim-online-recheck-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000604";
  const githubRunnerName = "cloudflare-73-4503599627370604";
  const runner = await recordReclaimRunner(
    registry,
    sandboxId,
    ORPHAN_TEST_NOW_MS - ORPHAN_DESTROY_GRACE_MS,
    githubRunnerName,
  );
  const firstResponse = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    {
      body: {
        observedRegistration: { runnerName: githubRunnerName },
      },
    },
  );
  assert.equal(firstResponse.status, 202);
  const firstBody = await firstResponse.json();

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    {
      nowMs: firstBody.reclaimableAtMs,
      github: "online-on-recheck",
      body: {
        observedRegistration: { runnerName: githubRunnerName },
      },
    },
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.outcome, "reclaimed");
  assert.deepEqual(body.githubLookupResults, [
    {
      outcome: "registration-found",
      runnerId: 901,
      runnerName: githubRunnerName,
      status: "offline",
      busy: false,
    },
    {
      outcome: "registration-found",
      runnerId: 901,
      runnerName: githubRunnerName,
      status: "online",
      busy: false,
    },
  ]);
  assert.deepEqual(body.events, [
    "github-checked",
    "sandbox-destroyed",
    "github-checked",
  ]);
  assert.deepEqual(body.deletedRunnerIds, []);
  assert.deepEqual(body.registrationCleanup, {
    runnerId: 901,
    result: "retained-online",
  });
});

test("orphan reclaim reports a sandbox destroy failure without releasing capacity", async () => {
  const registry = `reclaim-destroy-failure-${testRunId}`;
  const sandboxId = "runner-00000000-0000-4000-8000-000000000412";
  const { body: firstBody, runner } = await primeReclaimObservation(
    registry,
    sandboxId,
  );

  const response = await reclaimAbsent(
    registry,
    sandboxId,
    runner.revision,
    { nowMs: firstBody.reclaimableAtMs, destroy: "error" },
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.outcome, "failed");
  assert.equal(body.phase, "sandbox-destroy");
  assert.deepEqual(body.events, [
    "github-checked",
    "sandbox-destroy-attempted",
  ]);
  assert.deepEqual(body.releaseCalls, []);
  const row = (await listRegistry(registry)).runners[0];
  assert.equal(row.state, "destroying");
  assert.equal(row.destroyedAt, null);
});

test("the orphan reclaim route requires authentication and POST", async () => {
  const sandboxId = "runner-00000000-0000-4000-8000-000000000413";
  const unauthorizedResponse = await reclaimAbsent(
    `reclaim-unauthorized-${testRunId}`,
    sandboxId,
    0,
    { authorization: "Bearer incorrect-control-token-value" },
  );
  assert.equal(unauthorizedResponse.status, 401);
  assert.equal((await unauthorizedResponse.json()).outcome, "unauthorized");

  const methodResponse = await worker.fetch(
    `/operator/orphans/${sandboxId}/reclaim?productionRoute=true`,
  );
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("Allow"), "POST");

  const invalidResponse = await reclaimAbsent(
    `reclaim-invalid-id-${testRunId}`,
    "runner-invalid",
    0,
  );
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).outcome, "invalid-request");
});

test("the schema migration preserves a version 2 registry row", async () => {
  const persistencePath = await mkdtemp(
    join(tmpdir(), "runner-registry-migration-"),
  );
  let legacyWorker;
  let migratedWorker;
  try {
    legacyWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-v2-harness.js",
      devOptions(persistencePath),
    ));
    const registry = `version-two-${testRunId}`;
    const sandboxId = "runner-version-two";
    const createdAtMs = Date.now();
    const seedResponse = await legacyWorker.fetch(
      `/record-starting?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId,
          runnerName: `${sandboxId}-name`,
          createdAt: new Date(createdAtMs).toISOString(),
          createdAtMs,
        }),
      },
    );
    assert.equal(seedResponse.status, 204);
    await legacyWorker.stop();
    legacyWorker = undefined;

    migratedWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-harness.js",
      devOptions(persistencePath),
    ));
    const listResponse = await migratedWorker.fetch(
      `/runners?registry=${registry}`,
    );
    assert.equal(listResponse.status, 200);
    const body = await listResponse.json();
    assert.equal(body.runners.length, 1);
    assert.equal(body.runners[0].sandboxId, sandboxId);
    assert.equal(body.runners[0].correlationId, sandboxId);
    assert.equal(body.runners[0].state, "starting");
  } finally {
    await Promise.all([
      legacyWorker?.stop(),
      migratedWorker?.stop(),
    ]);
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test("the schema migration schedules cleanup for a version 3 row", async () => {
  const persistencePath = await mkdtemp(
    join(tmpdir(), "runner-registry-v3-migration-"),
  );
  let legacyWorker;
  let migratedWorker;
  try {
    legacyWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-v3-harness.js",
      devOptions(persistencePath),
    ));
    const registry = `version-three-${testRunId}`;
    const sandboxId = "runner-version-three";
    const correlationId = "version-three-correlation";
    const createdAtMs = Date.now();
    const seedResponse = await legacyWorker.fetch(
      `/record-starting?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId,
          runnerName: `${sandboxId}-name`,
          correlationId,
          createdAt: new Date(createdAtMs).toISOString(),
          createdAtMs,
        }),
      },
    );
    assert.equal(seedResponse.status, 204);
    await legacyWorker.stop();
    legacyWorker = undefined;

    migratedWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-harness.js",
      devOptions(persistencePath),
    ));
    const listResponse = await migratedWorker.fetch(
      `/runners?registry=${registry}`,
    );
    assert.equal(listResponse.status, 200);
    const body = await listResponse.json();
    assert.equal(body.runners.length, 1);
    assert.equal(body.runners[0].sandboxId, sandboxId);
    assert.equal(body.runners[0].correlationId, correlationId);
    assert.equal(
      body.runners[0].cleanupDueAt,
      new Date(createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS).toISOString(),
    );
  } finally {
    await Promise.all([
      legacyWorker?.stop(),
      migratedWorker?.stop(),
    ]);
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test("the unversioned version 4 migration is lossless and idempotent", async () => {
  const persistencePath = await mkdtemp(
    join(tmpdir(), "runner-registry-v4-migration-"),
  );
  let legacyWorker;
  let migratedWorker;
  try {
    legacyWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-v4-harness.js",
      devOptions(persistencePath),
    ));
    const registry = `version-four-${testRunId}`;
    const sandboxId = "runner-version-four";
    const correlationId = "version-four-correlation";
    const reconcileToken = "version-four-reconcile-token";
    const terminalSandboxId = "runner-version-four-terminal";
    const createdAtMs = Date.now() - 300_000;
    const cleanupStartedAt = new Date(Date.now() - 120_000).toISOString();
    const cleanupDueAtMs = Date.now() + 600_000;
    const revision = 7;
    const terminalDestroyedAt = new Date(Date.now() - 60_000).toISOString();
    const seedResponse = await legacyWorker.fetch(
      `/record-cleanup?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId,
          runnerName: `${sandboxId}-name`,
          correlationId,
          createdAt: new Date(createdAtMs).toISOString(),
          createdAtMs,
          cleanupStartedAt,
          reconcileToken,
          cleanupDueAtMs,
          revision,
          dropSchemaVersion: true,
          terminal: {
            sandboxId: terminalSandboxId,
            runnerName: `${terminalSandboxId}-name`,
            correlationId: "version-four-terminal-correlation",
            createdAt: new Date(createdAtMs - 1).toISOString(),
            createdAtMs: createdAtMs - 1,
            revision: 9,
            destroyedAt: terminalDestroyedAt,
            destroyedBy: "reconcile",
          },
        }),
      },
    );
    assert.equal(seedResponse.status, 204);
    await legacyWorker.stop();
    legacyWorker = undefined;

    migratedWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-harness.js",
      devOptions(persistencePath),
    ));
    const listResponse = await migratedWorker.fetch(
      `/runners?registry=${registry}`,
    );
    assert.equal(listResponse.status, 200);
    const body = await listResponse.json();
    assert.equal(body.runners.length, 2);
    const cleanupRow = body.runners.find(
      (runner) => runner.sandboxId === sandboxId,
    );
    assert.equal(cleanupRow.correlationId, correlationId);
    assert.equal(cleanupRow.state, "destroying");
    assert.equal(cleanupRow.cleanupStartedAt, cleanupStartedAt);
    assert.equal(
      cleanupRow.cleanupDueAt,
      new Date(cleanupDueAtMs).toISOString(),
    );
    assert.equal(cleanupRow.cleanupRequestedBy, "callback");
    assert.equal(Object.hasOwn(cleanupRow, "reconcileToken"), false);
    assert.equal(cleanupRow.revision, revision);
    const snapshotResponse = await migratedWorker.fetch(
      `/schema-snapshot?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.runner.reconcile_token, reconcileToken);
    const terminalRow = body.runners.find(
      (runner) => runner.sandboxId === terminalSandboxId,
    );
    assert.equal(terminalRow.correlationId, "version-four-terminal-correlation");
    assert.equal(terminalRow.state, "destroyed");
    assert.equal(terminalRow.destroyedAt, terminalDestroyedAt);
    assert.equal(terminalRow.destroyedBy, "reconcile");
    assert.equal(terminalRow.revision, 9);

    await migratedWorker.stop();
    migratedWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-harness.js",
      devOptions(persistencePath),
    ));
    const restartedResponse = await migratedWorker.fetch(
      `/runners?registry=${registry}`,
    );
    assert.equal(restartedResponse.status, 200);
    assert.deepEqual(await restartedResponse.json(), body);
  } finally {
    await Promise.all([
      legacyWorker?.stop(),
      migratedWorker?.stop(),
    ]);
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test("the version 7 migration preserves rows and adds repository fallback", async () => {
  const persistencePath = await mkdtemp(
    join(tmpdir(), "runner-registry-v7-migration-"),
  );
  let legacyWorker;
  let migratedWorker;
  try {
    legacyWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-v7-harness.js",
      devOptions(persistencePath),
    ));
    const registry = `version-seven-${testRunId}`;
    const sandboxId = "runner-version-seven";
    const runnerName = `${sandboxId}-name`;
    const correlationId = "version-seven-correlation";
    const createdAtMs = Date.now() - 300_000;
    const createdAt = new Date(createdAtMs).toISOString();
    const cleanupDueAtMs = Date.now() + 600_000;
    const revision = 14;
    const seedResponse = await legacyWorker.fetch(
      `/record-starting?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId,
          runnerName,
          correlationId,
          createdAt,
          createdAtMs,
          cleanupDueAtMs,
          revision,
        }),
      },
    );
    assert.equal(seedResponse.status, 204);
    await legacyWorker.stop();
    legacyWorker = undefined;

    migratedWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-harness.js",
      devOptions(persistencePath),
    ));
    const listResponse = await migratedWorker.fetch(
      `/runners?registry=${registry}`,
    );
    assert.equal(listResponse.status, 200);
    const page = await listResponse.json();
    assert.equal(page.runners.length, 1);
    assert.equal(page.runners[0].sandboxId, sandboxId);
    assert.equal(page.runners[0].runnerName, runnerName);
    assert.equal(page.runners[0].correlationId, correlationId);
    assert.equal(page.runners[0].repository, "example/runner-test");
    assert.equal(page.runners[0].revision, revision);

    const snapshotResponse = await migratedWorker.fetch(
      `/schema-snapshot?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.version, 12);
    assert.ok(snapshot.runnerColumns.includes("repository"));
    assert.ok(snapshot.runnerColumns.includes("github_runner_name"));
    assert.equal(snapshot.runner.repository, null);
    assert.equal(snapshot.runner.github_runner_name, null);
    assert.equal(snapshot.runner.created_at, createdAt);
    assert.equal(snapshot.runner.cleanup_due_at_ms, cleanupDueAtMs);

    const cleanupResponse = await migratedWorker.fetch(
      `/repository-cleanup?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          record: {
            sandboxId,
            runnerName,
            correlationId,
            repository: "example/second-repository",
            createdAt,
            createdAtMs,
          },
          nowMs: cleanupDueAtMs,
        }),
      },
    );
    assert.equal(cleanupResponse.status, 200);
    const cleanup = await cleanupResponse.json();
    assert.deepEqual(cleanup.calls, []);
    assert.deepEqual(cleanup.outcome.registrationCleanup, {
      runnerId: null,
      result: "name-unknown",
    });
    assert.equal(cleanup.outcome.runner.repository, "example/runner-test");
  } finally {
    await Promise.all([
      legacyWorker?.stop(),
      migratedWorker?.stop(),
    ]);
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test("the version 6 migration preserves rows and creates the observation ledger", async () => {
  const persistencePath = await mkdtemp(
    join(tmpdir(), "runner-registry-v6-migration-"),
  );
  let legacyWorker;
  let migratedWorker;
  try {
    legacyWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-v6-harness.js",
      devOptions(persistencePath),
    ));
    const registry = `version-six-${testRunId}`;
    const sandboxId = "runner-version-six-terminal";
    const inFlightSandboxId = "runner-version-six-in-flight";
    const cleanupToken = "version-six-cleanup-token";
    const runnerName = `${sandboxId}-name`;
    const correlationId = "version-six-correlation";
    const checkedAtMs = Date.now();
    const cleanupDueAtMs = checkedAtMs + CLEANUP_CLAIM_STALE_MS;
    const cleanupStartedAt = new Date(checkedAtMs - 1_000).toISOString();
    const createdAtMs = checkedAtMs - 300_000;
    const createdAt = new Date(createdAtMs).toISOString();
    const observedCreatedAt = new Date(createdAtMs - 51_480_000).toISOString();
    const destroyedAt = new Date(createdAtMs + 60_000).toISOString();
    const revision = 12;
    const seedResponse = await legacyWorker.fetch(
      `/record-terminal?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId,
          runnerName,
          correlationId,
          createdAt,
          createdAtMs,
          observedCreatedAt,
          revision,
          destroyedAt,
        }),
      },
    );
    assert.equal(seedResponse.status, 204);
    const inFlightSeedResponse = await legacyWorker.fetch(
      `/record-in-flight?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId: inFlightSandboxId,
          runnerName: `${inFlightSandboxId}-name`,
          correlationId: "version-six-in-flight-correlation",
          createdAt,
          createdAtMs,
          cleanupStartedAt,
          reconcileToken: cleanupToken,
          cleanupDueAtMs,
          revision: revision + 1,
        }),
      },
    );
    assert.equal(inFlightSeedResponse.status, 204);
    await legacyWorker.stop();
    legacyWorker = undefined;

    migratedWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-harness.js",
      devOptions(persistencePath),
    ));
    const snapshotResponse = await migratedWorker.fetch(
      `/schema-snapshot?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.version, 12);
    assert.ok(snapshot.runnerColumns.includes("orphan_instance_id"));
    assert.ok(snapshot.runnerColumns.includes("repository"));
    assert.ok(snapshot.runnerColumns.includes("github_runner_name"));
    assert.deepEqual(snapshot.observationColumns, [
      { name: "sandbox_id", primaryKey: 1 },
      { name: "instance_id", primaryKey: 2 },
      { name: "first_observed_at_ms", primaryKey: 0 },
    ]);
    assert.deepEqual(snapshot.reclaimObservationColumns, [
      { name: "sandbox_id", primaryKey: 1 },
      { name: "revision", primaryKey: 2 },
      { name: "first_observed_at_ms", primaryKey: 0 },
    ]);
    assert.deepEqual(snapshot.runner, {
      sandbox_id: sandboxId,
      runner_name: runnerName,
      github_runner_name: null,
      correlation_id: correlationId,
      created_at: createdAt,
      created_at_ms: createdAtMs,
      repository: null,
      observed_created_at: observedCreatedAt,
      orphan_instance_id: null,
      state: "destroyed",
      cleanup_started_at: null,
      reconcile_token: null,
      cleanup_due_at_ms: null,
      cleanup_requested_by: null,
      cleanup_attempts: 0,
      busy_since_ms: null,
      revision,
      destroyed_at: destroyedAt,
      destroyed_by: "orphan",
    });
    const migratedPageResponse = await migratedWorker.fetch(
      `/runners?registry=${registry}`,
    );
    assert.equal(migratedPageResponse.status, 200);
    const migratedPage = await migratedPageResponse.json();
    assert.equal(migratedPage.runners.length, 2);
    assert.equal(
      migratedPage.runners.find((runner) => runner.sandboxId === sandboxId)
        .repository,
      "example/runner-test",
    );

    const unboundResponse = await migratedWorker.fetch(
      `/revalidate-orphan-claim?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId: inFlightSandboxId,
          cleanupToken,
          checkedAtMs,
        }),
      },
    );
    assert.equal(
      unboundResponse.status,
      200,
      await unboundResponse.clone().text(),
    );
    assert.deepEqual(await unboundResponse.json(), {
      valid: true,
      migratedClaim: true,
    });

    const observedSandboxInstanceId = "6".repeat(64);
    const boundResponse = await migratedWorker.fetch(
      `/revalidate-orphan-claim?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId: inFlightSandboxId,
          cleanupToken,
          checkedAtMs,
          observedSandboxInstanceId,
        }),
      },
    );
    assert.equal(
      boundResponse.status,
      200,
      await boundResponse.clone().text(),
    );
    assert.deepEqual(await boundResponse.json(), {
      valid: true,
      migratedClaim: true,
      generationBound: true,
    });
    const inFlightSnapshotResponse = await migratedWorker.fetch(
      `/schema-snapshot?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId: inFlightSandboxId }),
      },
    );
    assert.equal(inFlightSnapshotResponse.status, 200);
    assert.equal(
      (await inFlightSnapshotResponse.json()).runner.orphan_instance_id,
      observedSandboxInstanceId,
    );
  } finally {
    await Promise.all([
      legacyWorker?.stop(),
      migratedWorker?.stop(),
    ]);
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test("the version 9 migration preserves rows and defaults cleanup attempts [mutation: skip the ALTER]", async () => {
  const persistencePath = await mkdtemp(
    join(tmpdir(), "runner-registry-v9-migration-"),
  );
  let legacyWorker;
  let migratedWorker;
  try {
    legacyWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-v9-harness.js",
      devOptions(persistencePath),
    ));
    const registry = `version-nine-${testRunId}`;
    const createdAtMs = Date.now() - 300_000;
    const cleanupDueAtMs = Date.now() + 600_000;
    const rows = [
      {
        sandboxId: "runner-version-nine-starting",
        runnerName: "runner-version-nine-starting-name",
        correlationId: "version-nine-starting-correlation",
        repository: "example/first-repository",
        createdAt: new Date(createdAtMs).toISOString(),
        createdAtMs,
        state: "starting",
        cleanupStartedAt: null,
        reconcileToken: null,
        cleanupDueAtMs,
        cleanupRequestedBy: null,
        revision: 7,
      },
      {
        sandboxId: "runner-version-nine-destroying",
        runnerName: "runner-version-nine-destroying-name",
        correlationId: "version-nine-destroying-correlation",
        repository: "example/second-repository",
        createdAt: new Date(createdAtMs + 1).toISOString(),
        createdAtMs: createdAtMs + 1,
        state: "destroying",
        cleanupStartedAt: new Date(createdAtMs + 2).toISOString(),
        reconcileToken: "version-nine-cleanup-token",
        cleanupDueAtMs: cleanupDueAtMs + 1,
        cleanupRequestedBy: "callback",
        revision: 12,
      },
    ];
    for (const row of rows) {
      const seedResponse = await legacyWorker.fetch(
        `/record-runner?registry=${registry}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(row),
        },
      );
      assert.equal(seedResponse.status, 204);
    }
    await legacyWorker.stop();
    legacyWorker = undefined;

    migratedWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-harness.js",
      devOptions(persistencePath),
    ));
    const listResponse = await migratedWorker.fetch(
      `/runners?registry=${registry}`,
    );
    assert.equal(listResponse.status, 200);
    const page = await listResponse.json();
    assert.deepEqual(
      page.runners.map((runner) => runner.sandboxId).sort(),
      rows.map((row) => row.sandboxId).sort(),
    );
    assert.ok(
      page.runners.every(
        (runner) =>
          runner.cleanupAttempts === 0 && runner.cleanupStalled === false,
      ),
    );
    for (const row of rows) {
      const migrated = page.runners.find(
        (runner) => runner.sandboxId === row.sandboxId,
      );
      assert.equal(migrated.runnerName, row.runnerName);
      assert.equal(migrated.correlationId, row.correlationId);
      assert.equal(migrated.repository, row.repository);
      assert.equal(migrated.revision, row.revision);
    }

    const snapshotResponse = await migratedWorker.fetch(
      `/schema-snapshot?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId: rows[0].sandboxId }),
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.version, 12);
    assert.ok(snapshot.runnerColumns.includes("cleanup_attempts"));
    assert.ok(snapshot.runnerColumns.includes("github_runner_name"));
    assert.equal(snapshot.runner.cleanup_attempts, 0);
    assert.equal(snapshot.runner.github_runner_name, null);
  } finally {
    await Promise.all([
      legacyWorker?.stop(),
      migratedWorker?.stop(),
    ]);
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test("the version 10 migration adds the GitHub runner name without data loss", async () => {
  const persistencePath = await mkdtemp(
    join(tmpdir(), "runner-registry-v10-migration-"),
  );
  let legacyWorker;
  let migratedWorker;
  try {
    legacyWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-v10-harness.js",
      devOptions(persistencePath),
    ));
    const registry = `version-ten-${testRunId}`;
    const sandboxId = "runner-version-ten";
    const runnerName = "runner-version-ten-name";
    const correlationId = "version-ten-correlation";
    const repository = "example/version-ten-repository";
    const createdAtMs = Date.now() - 300_000;
    const createdAt = new Date(createdAtMs).toISOString();
    const cleanupDueAtMs = Date.now() + 600_000;
    const cleanupAttempts = 3;
    const revision = 8;
    const seedResponse = await legacyWorker.fetch(
      `/record-runner?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId,
          runnerName,
          correlationId,
          repository,
          createdAt,
          createdAtMs,
          state: "starting",
          cleanupDueAtMs,
          cleanupAttempts,
          revision,
        }),
      },
    );
    assert.equal(seedResponse.status, 204);
    await legacyWorker.stop();
    legacyWorker = undefined;

    migratedWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-harness.js",
      devOptions(persistencePath),
    ));
    const listResponse = await migratedWorker.fetch(
      `/runners?registry=${registry}`,
    );
    assert.equal(listResponse.status, 200);
    const page = await listResponse.json();
    assert.equal(page.runners.length, 1);
    const runner = page.runners[0];
    assert.equal(runner.sandboxId, sandboxId);
    assert.equal(runner.runnerName, runnerName);
    assert.equal(runner.githubRunnerName, null);
    assert.equal(runner.correlationId, correlationId);
    assert.equal(runner.repository, repository);
    assert.equal(runner.createdAt, createdAt);
    assert.equal(
      runner.cleanupDueAt,
      new Date(cleanupDueAtMs).toISOString(),
    );
    assert.equal(runner.cleanupAttempts, cleanupAttempts);
    assert.equal(runner.revision, revision);

    const snapshotResponse = await migratedWorker.fetch(
      `/schema-snapshot?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.version, 12);
    assert.ok(snapshot.runnerColumns.includes("github_runner_name"));
    assert.equal(snapshot.runner.github_runner_name, null);
    assert.equal(snapshot.runner.created_at_ms, createdAtMs);
  } finally {
    await Promise.all([
      legacyWorker?.stop(),
      migratedWorker?.stop(),
    ]);
    await rm(persistencePath, { recursive: true, force: true });
  }
});

test("the version 11 migration adds an empty busy stamp without data loss", async () => {
  const persistencePath = await mkdtemp(
    join(tmpdir(), "runner-registry-v11-migration-"),
  );
  let legacyWorker;
  let migratedWorker;
  try {
    legacyWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-v11-harness.js",
      devOptions(persistencePath),
    ));
    const registry = `version-eleven-${testRunId}`;
    const sandboxId = "runner-version-eleven";
    const runnerName = "runner-version-eleven-name";
    const githubRunnerName = "github-version-eleven-name";
    const correlationId = "version-eleven-correlation";
    const repository = "example/version-eleven-repository";
    const createdAtMs = Date.now() - 300_000;
    const createdAt = new Date(createdAtMs).toISOString();
    const cleanupDueAtMs = Date.now() + 600_000;
    const cleanupAttempts = 4;
    const revision = 9;
    const seedResponse = await legacyWorker.fetch(
      `/record-runner?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sandboxId,
          runnerName,
          githubRunnerName,
          correlationId,
          repository,
          createdAt,
          createdAtMs,
          state: "starting",
          cleanupDueAtMs,
          cleanupAttempts,
          revision,
        }),
      },
    );
    assert.equal(seedResponse.status, 204);
    await legacyWorker.stop();
    legacyWorker = undefined;

    migratedWorker = guardDevWorkerTransport(await unstable_dev(
      "test/runner-registry-harness.js",
      devOptions(persistencePath),
    ));
    const listResponse = await migratedWorker.fetch(
      `/runners?registry=${registry}`,
    );
    assert.equal(listResponse.status, 200);
    const page = await listResponse.json();
    assert.equal(page.runners.length, 1);
    const runner = page.runners[0];
    assert.equal(runner.sandboxId, sandboxId);
    assert.equal(runner.runnerName, runnerName);
    assert.equal(runner.githubRunnerName, githubRunnerName);
    assert.equal(runner.correlationId, correlationId);
    assert.equal(runner.repository, repository);
    assert.equal(runner.createdAt, createdAt);
    assert.equal(
      runner.cleanupDueAt,
      new Date(cleanupDueAtMs).toISOString(),
    );
    assert.equal(runner.cleanupAttempts, cleanupAttempts);
    assert.equal(runner.busySinceMs, null);
    assert.equal(runner.revision, revision);

    const snapshotResponse = await migratedWorker.fetch(
      `/schema-snapshot?registry=${registry}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      },
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.version, 12);
    assert.ok(snapshot.runnerColumns.includes("busy_since_ms"));
    assert.equal(snapshot.runner.busy_since_ms, null);
    assert.equal(snapshot.runner.github_runner_name, githubRunnerName);
    assert.equal(snapshot.runner.created_at_ms, createdAtMs);
  } finally {
    await Promise.all([
      legacyWorker?.stop(),
      migratedWorker?.stop(),
    ]);
    await rm(persistencePath, { recursive: true, force: true });
  }
});
