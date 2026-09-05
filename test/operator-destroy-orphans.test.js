import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertOperatorRouteRequiredFinding,
  composeRequestBody,
  formatOperatorStderr,
  outcomeExitCode,
  runOperatorDestroy,
  selectOperatorFindings,
  validateSandboxInstanceId,
} from "../scripts/operator-destroy-orphans.mjs";

const SANDBOX_ID = "runner-11111111-1111-4111-8111-111111111111";
const RUNNER_NAME = "cloudflare-11111111-1111-4111-8111-111111111111";
const INSTANCE_ID = "a".repeat(64);
const SECOND_SANDBOX_ID = "runner-22222222-2222-4222-8222-222222222222";
const SECOND_RUNNER_NAME = "cloudflare-22222222-2222-4222-8222-222222222222";
const CONTROL_TOKEN = "c".repeat(32);

function finding(overrides = {}) {
  return {
    type: "orphan",
    sandboxId: SANDBOX_ID,
    instanceId: INSTANCE_ID,
    runnerName: RUNNER_NAME,
    reason: "terminal-registry-row",
    destroyResult: "operator-route-required",
    ...overrides,
  };
}

function summary(overrides = {}) {
  return {
    type: "summary",
    repository: "example-org/example-repo",
    runnerScope: "organization:example-org",
    orphanCount: 1,
    ambiguousInstanceCount: 0,
    findingCount: 1,
    destroyOperatorRequiredCount: 1,
    ...overrides,
  };
}

function evidence(orphan = finding()) {
  return [orphan, summary()];
}

function evidenceForFindings(findings) {
  return [
    ...findings,
    summary({
      orphanCount: findings.length,
      findingCount: findings.length,
      destroyOperatorRequiredCount: findings.length,
    }),
  ];
}

function terminalRegistryRow(overrides = {}) {
  return {
    sandboxId: SANDBOX_ID,
    state: "destroyed",
    createdAt: "2026-08-29T00:00:00.000Z",
    revision: 7,
    githubRunnerName: RUNNER_NAME,
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function serviceForOutcomes(outcomes, options = {}) {
  const outcomesBySandboxId = new Map(outcomes);
  const calls = [];
  const fetch = async (url, init = {}) => {
    const stringUrl = String(url);
    const method = init.method ?? "GET";
    calls.push({ url: stringUrl, init, method });
    if (stringUrl === "https://worker.test/runners") {
      return jsonResponse(200, {
        runners: options.registryRows ?? [...outcomesBySandboxId.keys()].map(
          (sandboxId, index) => terminalRegistryRow({
            sandboxId,
            githubRunnerName: `cloudflare-${sandboxId.slice("runner-".length)}`,
            revision: 7 + index,
          }),
        ),
        pageSize: 100,
        nextCursor: null,
      });
    }
    if (stringUrl.startsWith("https://api.github.com/")) {
      const requestedRunnerName = new URL(stringUrl).searchParams.get("name");
      return jsonResponse(200, options.githubResponse ?? {
        total_count: 1,
        runners: [{
          id: 123456,
          name: requestedRunnerName,
          status: "offline",
          busy: false,
        }],
      });
    }
    const routeMatch = /^https:\/\/worker\.test\/operator\/orphans\/([^/]+)\/destroy$/u
      .exec(stringUrl);
    if (routeMatch !== null) {
      const sandboxId = decodeURIComponent(routeMatch[1]);
      const outcome = outcomesBySandboxId.get(sandboxId);
      if (outcome === undefined) {
        throw new Error(`Unexpected sandbox: ${sandboxId}`);
      }
      const status = outcome === "destroyed"
        ? 200
        : outcome === "invalid-request"
          ? 400
          : 409;
      return jsonResponse(status, { outcome });
    }
    throw new Error(`Unexpected request: ${method} ${stringUrl}`);
  };
  return { calls, fetch };
}

function serviceForOutcome(outcome, options = {}) {
  return serviceForOutcomes([[SANDBOX_ID, outcome]], options);
}

function runOptions(overrides = {}) {
  return {
    records: evidence(),
    evidenceSource: "test.jsonl",
    destroy: true,
    workerUrl: "https://worker.test",
    controlToken: CONTROL_TOKEN,
    githubToken: "github-token",
    ...overrides,
  };
}

test("validates exactly 64 lowercase hexadecimal characters", () => {
  assert.equal(validateSandboxInstanceId("0".repeat(64)), "0".repeat(64));
  assert.equal(validateSandboxInstanceId("abcdef09".repeat(8)), "abcdef09".repeat(8));

  for (const invalid of [
    "a".repeat(63),
    "a".repeat(65),
    `${"a".repeat(63)}g`,
    "A".repeat(64),
    64,
    null,
  ]) {
    assert.throws(
      () => validateSandboxInstanceId(invalid),
      /exactly 64 lowercase hexadecimal characters/u,
    );
  }
});

test("composes the absent-row request body with a missing registration", () => {
  const absentFinding = finding({ reason: "absent-from-registry" });
  const body = composeRequestBody({
    finding: absentFinding,
    registryRow: undefined,
    registration: {
      outcome: "registration-not-found",
      runnerName: RUNNER_NAME,
    },
  });

  assert.deepEqual(body, {
    observedRegistryCondition: "absent",
    expectedRevision: null,
    observedSandboxInstanceId: INSTANCE_ID,
    observedRegistration: {
      outcome: "registration-not-found",
      runnerName: RUNNER_NAME,
    },
  });
});

test("composes the terminal-row request body with a found registration", () => {
  const body = composeRequestBody({
    finding: finding(),
    registryRow: terminalRegistryRow(),
    registration: {
      outcome: "registration-found",
      runnerId: 123456,
      runnerName: RUNNER_NAME,
      status: "offline",
      busy: false,
    },
  });

  assert.deepEqual(body, {
    observedRegistryCondition: "terminal",
    expectedRevision: 7,
    observedSandboxInstanceId: INSTANCE_ID,
    observedRegistration: {
      outcome: "registration-found",
      runnerId: 123456,
      runnerName: RUNNER_NAME,
      status: "offline",
      busy: false,
    },
  });
});

test("dry-run mode prints a request plan and sends no POST request", async () => {
  const service = serviceForOutcome("destroyed");
  const report = await runOperatorDestroy(
    runOptions({ destroy: false }),
    { fetch: service.fetch },
  );

  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].outcome, "dry-run");
  assert.equal(report.results[0].requestSent, false);
  assert.deepEqual(
    report.results[0].request.body,
    composeRequestBody({
      finding: finding(),
      registryRow: terminalRegistryRow(),
      registration: {
        outcome: "registration-found",
        runnerId: 123456,
        runnerName: RUNNER_NAME,
        status: "offline",
        busy: false,
      },
    }),
  );
  assert.equal(service.calls.filter(({ method }) => method === "POST").length, 0);
  assert.equal(outcomeExitCode("dry-run"), 0);
  assert.equal(report.summary.dryRunCount, 1);
  assert.equal(report.summary.insideGraceCount, 0);
  assert.equal(report.summary.actionRequiredCount, 0);
  assert.equal(report.summary.exitCode, 0);
});

test("keeps every action-required route outcome at exit code 1", async () => {
  const cases = [
    ["invalid-request", 1, false],
    ["live-row", 1, false],
    ["observation-mismatch", 1, false],
    ["revision-conflict", 1, false],
    ["sandbox-generation-mismatch", 1, false],
    ["terminal-generation-unverified", 1, false],
    ["claim-conflict", 1, false],
    ["runner-busy", 1, false],
    ["runner-online", 1, false],
    ["registration-observation-mismatch", 1, false],
  ];

  for (const [outcome, exitCode, terminalResolution] of cases) {
    const service = serviceForOutcome(outcome);
    const report = await runOperatorDestroy(
      runOptions(),
      { fetch: service.fetch },
    );

    assert.equal(outcomeExitCode(outcome), exitCode, outcome);
    assert.equal(report.results[0].outcome, outcome, outcome);
    assert.equal(
      report.results[0].terminalResolution,
      terminalResolution,
      outcome,
    );
    assert.equal(report.summary.exitCode, exitCode, outcome);
    assert.equal(
      service.calls.filter(({ method }) => method === "POST").length,
      1,
      outcome,
    );
  }
});

test("all inside-grace outcomes complete the observation phase", async () => {
  const secondFinding = finding({
    sandboxId: SECOND_SANDBOX_ID,
    instanceId: "b".repeat(64),
    runnerName: SECOND_RUNNER_NAME,
  });
  const service = serviceForOutcomes([
    [SANDBOX_ID, "inside-grace"],
    [SECOND_SANDBOX_ID, "inside-grace"],
  ]);
  const report = await runOperatorDestroy(
    runOptions({ records: evidenceForFindings([finding(), secondFinding]) }),
    { fetch: service.fetch },
  );

  assert.equal(outcomeExitCode("inside-grace"), 0);
  assert.equal(report.summary.insideGraceCount, 2);
  assert.equal(report.summary.actionRequiredCount, 0);
  assert.equal(report.summary.unresolvedCount, 2);
  assert.equal(report.summary.exitCode, 0);
  assert.equal(
    formatOperatorStderr(report.summary),
    "Operator orphan destroy: 2 finding(s), 2 request(s) sent, 0 destroyed, 2 unresolved, and 0 operational failure(s).\n" +
      "The orphan observation is recorded for 2 sandboxes. A second destroy run after the 60-second grace window will destroy these sandboxes.\n",
  );
});

test("inside-grace mixed with an action-required outcome exits 1", async () => {
  const secondFinding = finding({
    sandboxId: SECOND_SANDBOX_ID,
    instanceId: "b".repeat(64),
    runnerName: SECOND_RUNNER_NAME,
  });
  const service = serviceForOutcomes([
    [SANDBOX_ID, "inside-grace"],
    [SECOND_SANDBOX_ID, "revision-conflict"],
  ]);
  const report = await runOperatorDestroy(
    runOptions({ records: evidenceForFindings([finding(), secondFinding]) }),
    { fetch: service.fetch },
  );

  assert.equal(report.summary.insideGraceCount, 1);
  assert.equal(report.summary.actionRequiredCount, 1);
  assert.equal(report.summary.operationalFailureCount, 0);
  assert.equal(report.summary.exitCode, 1);
});

test("does not retry stale observation or generation outcomes", async () => {
  for (const outcome of [
    "observation-mismatch",
    "sandbox-generation-mismatch",
  ]) {
    const service = serviceForOutcome(outcome);
    await runOperatorDestroy(runOptions(), { fetch: service.fetch });
    assert.equal(
      service.calls.filter(({ method }) => method === "POST").length,
      1,
      outcome,
    );
  }
});

test("refuses to act on a finding that is not operator-route-required", async () => {
  const ineligible = finding({ destroyResult: "not-requested" });
  assert.throws(
    () => assertOperatorRouteRequiredFinding(ineligible),
    /destroyResult is not operator-route-required/u,
  );

  const calls = [];
  const report = await runOperatorDestroy(
    runOptions({
      records: [
        ineligible,
        summary({ destroyOperatorRequiredCount: 0 }),
      ],
    }),
    { fetch: async (...argumentsList) => {
      calls.push(argumentsList);
      throw new Error("No request was expected");
    } },
  );
  assert.equal(report.results.length, 0);
  assert.equal(report.summary.findingCount, 0);
  assert.equal(calls.length, 0);
});

test("derives operator findings only from supported report-only audit classes", () => {
  const reportOnlyFinding = finding({ destroyResult: "not-requested" });
  const records = [
    reportOnlyFinding,
    summary({ destroyOperatorRequiredCount: 0 }),
  ];
  const selection = selectOperatorFindings(records, {
    reportOnlyEvidence: true,
  });

  assert.equal(selection.findings.length, 1);
  assert.equal(selection.findings[0].destroyResult, "operator-route-required");
  assert.equal(selection.findings[0].auditDestroyResult, "not-requested");
});

test("validates all instance identifiers before the first live request", async () => {
  const invalid = finding({ instanceId: "A".repeat(64) });
  const calls = [];
  const report = await runOperatorDestroy(
    runOptions({ records: evidence(invalid) }),
    { fetch: async (...argumentsList) => {
      calls.push(argumentsList);
      throw new Error("No request was expected");
    } },
  );

  assert.equal(report.results[0].outcome, "refused-finding");
  assert.equal(outcomeExitCode("refused-finding"), 1);
  assert.equal(report.summary.actionRequiredCount, 1);
  assert.equal(report.summary.exitCode, 1);
  assert.equal(calls.length, 0);
});

test("keeps operational errors at exit code 2", async () => {
  const service = serviceForOutcome("destroyed", { githubResponse: {} });
  const report = await runOperatorDestroy(
    runOptions(),
    { fetch: service.fetch },
  );

  assert.equal(report.results[0].outcome, "operational-error");
  assert.equal(outcomeExitCode("operational-error"), 2);
  assert.equal(report.summary.operationalFailureCount, 1);
  assert.equal(report.summary.exitCode, 2);
});
