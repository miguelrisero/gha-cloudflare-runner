import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SCALE_UP_REQUEST_ID_BASE } from "../src/scaleset-protocol.js";
import {
  CensusIncompleteError,
  RunnerRecordInvalidError,
  assertCensusComplete,
  classifyDeleteCapability,
  classifyRunner,
  isCensusPopulationMember,
  isLoopSpawnedRunnerName,
  parseLoopSpawnedRunnerName,
  selectDeletions,
} from "../src/registration-cleanup.js";
import { runRegistrationCleanup } from "../scripts/registration-cleanup.mjs";

const ORGANIZATION_SCOPE = {
  type: "organization",
  organization: "example-org",
};
const REQUEST_ID_BASE = BigInt(SCALE_UP_REQUEST_ID_BASE);
const cleanupCli = fileURLToPath(
  new URL("../scripts/registration-cleanup.mjs", import.meta.url),
);

function loopRunner(id, overrides = {}) {
  const scaleSetId = overrides.scaleSetId ?? 7n;
  const runnerRequestId = overrides.runnerRequestId
    ?? REQUEST_ID_BASE + BigInt(id);
  return {
    id,
    name: `cloudflare-${scaleSetId}-${runnerRequestId}`,
    busy: false,
    ...overrides,
  };
}

function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function requestMethod(init) {
  return init?.method ?? "GET";
}

function registryService(initialRunners, options = {}) {
  const runners = initialRunners.map((runner) => ({ ...runner }));
  const calls = [];
  let deleteIndex = 0;
  const fetch = async (url, init = {}) => {
    const method = requestMethod(init);
    calls.push({ url, init, method, at: options.clock?.() });
    if (method === "GET") {
      const parsedUrl = new URL(url);
      const pageSize = Number(parsedUrl.searchParams.get("per_page"));
      const page = Number(parsedUrl.searchParams.get("page"));
      const start = (page - 1) * pageSize;
      return fakeResponse(200, {
        total_count: runners.length,
        runners: runners.slice(start, start + pageSize),
      });
    }
    const runnerId = Number(new URL(url).pathname.split("/").at(-1));
    const status = typeof options.deleteStatus === "function"
      ? options.deleteStatus(runnerId, deleteIndex)
      : options.deleteStatuses?.get(runnerId) ?? 204;
    deleteIndex += 1;
    if (status >= 200 && status < 300) {
      const runnerIndex = runners.findIndex(({ id }) => id === runnerId);
      if (runnerIndex !== -1) {
        runners.splice(runnerIndex, 1);
      }
    }
    return fakeResponse(status);
  };
  return { fetch, calls, runners };
}

function cleanupOptions(overrides = {}) {
  return {
    githubToken: "test-token",
    scope: ORGANIZATION_SCOPE,
    minDeleteIntervalMs: 0,
    ...overrides,
  };
}

function deleteCalls(calls) {
  return calls.filter(({ method }) => method === "DELETE");
}

test("rejects a runner name outside the loop-spawn pattern", () => {
  const names = [
    "runner-7",
    "cloudflare-1",
    "cloudflare-1-2-3",
    "Cloudflare-1-9007199254740991",
    `cloudflare-01-${REQUEST_ID_BASE}`,
    ` cloudflare-1-${REQUEST_ID_BASE}`,
    null,
    undefined,
    17,
    {},
    "",
  ];
  for (const name of names) {
    assert.equal(parseLoopSpawnedRunnerName(name), null);
    assert.equal(isLoopSpawnedRunnerName(name), false);
  }
});

test("rejects a loop-spawn name whose request id is below the reserved band", () => {
  assert.equal(
    parseLoopSpawnedRunnerName(`cloudflare-1-${REQUEST_ID_BASE - 1n}`),
    null,
  );
  assert.equal(parseLoopSpawnedRunnerName("cloudflare-1-12345"), null);
  assert.deepEqual(
    parseLoopSpawnedRunnerName(`cloudflare-1-${REQUEST_ID_BASE}`),
    { scaleSetId: 1n, runnerRequestId: REQUEST_ID_BASE },
  );
});

test("keeps 16-digit request ids exact", () => {
  const firstRequestId = REQUEST_ID_BASE;
  const secondRequestId = REQUEST_ID_BASE + 1n;
  const firstName = `cloudflare-4-${firstRequestId}`;
  const secondName = `cloudflare-4-${secondRequestId}`;

  assert.equal(
    parseLoopSpawnedRunnerName(firstName).runnerRequestId,
    firstRequestId,
  );
  assert.equal(
    parseLoopSpawnedRunnerName(secondName).runnerRequestId,
    secondRequestId,
  );
  assert.notEqual(
    parseLoopSpawnedRunnerName(firstName).runnerRequestId,
    parseLoopSpawnedRunnerName(secondName).runnerRequestId,
  );
  assert.equal(classifyRunner({ id: 1, name: firstName, busy: false }).decision, "delete");
  assert.equal(classifyRunner({ id: 2, name: secondName, busy: false }).decision, "delete");
});

test("never deletes a busy registration", () => {
  const classification = classifyRunner(loopRunner(1, { busy: true }));
  assert.deepEqual(
    { decision: classification.decision, reason: classification.reason },
    { decision: "skip", reason: "busy" },
  );
  assert.deepEqual(selectDeletions([loopRunner(1, { busy: true })]).deletions, []);
  assert.equal(isCensusPopulationMember(loopRunner(1, { busy: true })), true);
});

test("treats a 422 delete response as an expected skip and continues", async () => {
  const service = registryService(
    [loopRunner(1), loopRunner(2)],
    { deleteStatuses: new Map([[1, 422], [2, 204]]) },
  );
  const report = await runRegistrationCleanup(
    cleanupOptions({ apply: true }),
    { fetch: service.fetch, sleep: async () => {} },
  );

  assert.equal(report.attempted, 2);
  assert.equal(report.deleted, 1);
  assert.equal(report.busySkipped, 1);
  assert.equal(report.remaining, 1);
  assert.deepEqual(
    deleteCalls(service.calls).map(({ url }) => url),
    [
      "https://api.github.com/orgs/example-org/actions/runners/1",
      "https://api.github.com/orgs/example-org/actions/runners/2",
    ],
  );
});

test("treats a 404 delete response as already absent and continues", async () => {
  const service = registryService(
    [loopRunner(1), loopRunner(2)],
    { deleteStatuses: new Map([[1, 404], [2, 204]]) },
  );
  const report = await runRegistrationCleanup(
    cleanupOptions({ apply: true }),
    { fetch: service.fetch, sleep: async () => {} },
  );

  assert.equal(report.attempted, 2);
  assert.equal(report.deleted, 1);
  assert.equal(report.alreadyAbsent, 1);
  assert.equal(report.remaining, 0);
  assert.equal(deleteCalls(service.calls).length, 2);
});

test("issues no DELETE request at all when apply is false", async () => {
  const service = registryService([loopRunner(1), loopRunner(2)]);
  const report = await runRegistrationCleanup(
    cleanupOptions(),
    { fetch: service.fetch },
  );

  assert.equal(report.apply, false);
  assert.equal(report.attempted, 0);
  assert.equal(report.deleted, 0);
  assert.equal(report.filteredRegistrations, 2);
  assert.equal(report.expectedTargets, null);
  assert.equal(deleteCalls(service.calls).length, 0);
});

test("reports proven delete capability for a classic admin:org token", async () => {
  const fetch = async () => ({
    ...fakeResponse(200, { total_count: 0, runners: [] }),
    headers: {
      get: () => "repo, admin:org, workflow",
    },
  });

  const report = await runRegistrationCleanup(cleanupOptions(), { fetch });

  assert.equal(report.deleteCapability, "proven-classic-admin-org");
  assert.equal(report.tokenScopes, "repo, admin:org, workflow");
});

test("reports unknown delete capability when no scope header is present", async () => {
  const fetch = async () => ({
    ...fakeResponse(200, { total_count: 0, runners: [] }),
    headers: { get: () => null },
  });

  const report = await runRegistrationCleanup(cleanupOptions(), { fetch });

  assert.equal(report.deleteCapability, "unknown-fine-grained");
  assert.equal(report.tokenScopes, null);
});

test("reports unproven delete capability for a classic token without admin:org", async () => {
  const fetch = async () => ({
    ...fakeResponse(200, { total_count: 0, runners: [] }),
    headers: { get: () => "read:org,repo" },
  });

  const report = await runRegistrationCleanup(cleanupOptions(), { fetch });

  assert.equal(report.deleteCapability, "unproven-classic-scopes");
  assert.equal(report.tokenScopes, "read:org,repo");
});

test("tolerates a response with no headers accessor", async () => {
  const fetch = async () => fakeResponse(200, {
    total_count: 0,
    runners: [],
  });

  const report = await runRegistrationCleanup(cleanupOptions(), { fetch });

  assert.equal(report.deleteCapability, "unknown-fine-grained");
  assert.equal(report.tokenScopes, null);
});

test("tolerates a throwing headers accessor", async () => {
  const response = fakeResponse(200, { total_count: 0, runners: [] });
  Object.defineProperty(response, "headers", {
    get() {
      throw new Error("headers are unavailable");
    },
  });
  const fetch = async () => response;

  const report = await runRegistrationCleanup(cleanupOptions(), { fetch });

  assert.equal(report.deleteCapability, "unknown-fine-grained");
  assert.equal(report.tokenScopes, null);
});

test("classifies delete capability from OAuth scope strings", () => {
  assert.equal(classifyDeleteCapability(undefined), "unknown-fine-grained");
  assert.equal(classifyDeleteCapability(""), "unknown-fine-grained");
  assert.equal(classifyDeleteCapability("   "), "unknown-fine-grained");
  assert.equal(
    classifyDeleteCapability("admin:org"),
    "proven-classic-admin-org",
  );
  assert.equal(
    classifyDeleteCapability(" admin : org "),
    "unproven-classic-scopes",
  );
  assert.equal(
    classifyDeleteCapability("read:org,repo"),
    "unproven-classic-scopes",
  );
});

test("refuses when a listing page fails", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: requestMethod(init) });
    const page = Number(new URL(url).searchParams.get("page"));
    if (page === 1) {
      return fakeResponse(200, {
        total_count: 3,
        runners: [loopRunner(1), loopRunner(2)],
      });
    }
    return fakeResponse(500);
  };

  await assert.rejects(
    runRegistrationCleanup(
      cleanupOptions({ apply: true, pageSize: 2 }),
      { fetch, sleep: async () => {} },
    ),
    CensusIncompleteError,
  );
  assert.equal(deleteCalls(calls).length, 0);
  assert.equal(calls.length, 2);
});

test("accepts a short census because cleanup acts only on records it read", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: requestMethod(init) });
    return fakeResponse(200, {
      total_count: 2,
      runners: [loopRunner(1)],
    });
  };

  const report = await runRegistrationCleanup(
    cleanupOptions({ apply: true, pageSize: 2 }),
    { fetch, sleep: async () => {} },
  );

  assert.equal(report.filteredRegistrations, 1);
  assert.equal(report.counts.delete, 1);
  assert.deepEqual(
    deleteCalls(calls).map(({ url }) => Number(new URL(url).pathname.split("/").at(-1))),
    [1],
  );
});

test("refuses when the listing is truncated at the page limit", async () => {
  const service = registryService([loopRunner(1), loopRunner(2), loopRunner(3)]);

  await assert.rejects(
    runRegistrationCleanup(
      cleanupOptions({ apply: true, pageSize: 2, pageLimit: 1 }),
      { fetch: service.fetch, sleep: async () => {} },
    ),
    (error) => {
      assert.equal(error instanceof CensusIncompleteError, true);
      assert.match(error.message, /fetched 1 pages/u);
      assert.match(error.message, /1-page limit/u);
      assert.match(error.message, /contained 2 of 2 entries/u);
      return true;
    },
  );
  assert.equal(deleteCalls(service.calls).length, 0);
});

test("refuses a malformed runner record", async () => {
  const service = registryService([{ id: 1, name: "runner-7" }]);

  await assert.rejects(
    runRegistrationCleanup(
      cleanupOptions({ apply: true }),
      { fetch: service.fetch, sleep: async () => {} },
    ),
    RunnerRecordInvalidError,
  );
  assert.equal(deleteCalls(service.calls).length, 0);
});

test("throttles deletes to at least one second apart", async () => {
  let clock = 0;
  const waits = [];
  const service = registryService(
    [loopRunner(1), loopRunner(2), loopRunner(3)],
    { clock: () => clock },
  );
  const report = await runRegistrationCleanup(
    cleanupOptions({ apply: true, minDeleteIntervalMs: 1000 }),
    {
      fetch: service.fetch,
      now: () => clock,
      sleep: async (waitMs) => {
        waits.push(waitMs);
        clock += waitMs;
      },
    },
  );
  const timestamps = deleteCalls(service.calls).map(({ at }) => at);

  assert.equal(report.deleted, 3);
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(waits.reduce((total, waitMs) => total + waitMs, 0), 2000);
  assert.deepEqual(timestamps, [0, 1000, 2000]);
  for (let index = 1; index < timestamps.length; index += 1) {
    assert.ok(timestamps[index] - timestamps[index - 1] >= 1000);
  }
});

test("stops at the limit and reports the remainder", async () => {
  const service = registryService([loopRunner(1), loopRunner(2), loopRunner(3)]);
  const report = await runRegistrationCleanup(
    cleanupOptions({ apply: true, limit: 2 }),
    { fetch: service.fetch, sleep: async () => {} },
  );

  assert.equal(report.attempted, 2);
  assert.equal(report.deleted, 2);
  assert.equal(report.remaining, 1);
  assert.equal(report.truncatedByLimit, true);
  assert.equal(report.deletions.length, 3);
  assert.deepEqual(
    deleteCalls(service.calls).map(({ url }) => Number(new URL(url).pathname.split("/").at(-1))),
    [1, 2],
  );
});

test("aborts on 403 and reports progress", async () => {
  const service = registryService(
    [loopRunner(1), loopRunner(2), loopRunner(3)],
    { deleteStatuses: new Map([[1, 204], [2, 403], [3, 204]]) },
  );

  await assert.rejects(
    runRegistrationCleanup(
      cleanupOptions({ apply: true }),
      { fetch: service.fetch, sleep: async () => {} },
    ),
    (error) => {
      assert.match(error.message, /HTTP 403/u);
      assert.match(
        error.message,
        /Organization "Self-hosted runners: Read and write"/u,
      );
      assert.equal(error.report.attempted, 2);
      assert.equal(error.report.deleted, 1);
      assert.equal(error.report.remaining, 2);
      assert.doesNotThrow(() => JSON.stringify(error.report));
      return true;
    },
  );
  assert.equal(deleteCalls(service.calls).length, 2);
});

test("is idempotent across runs", async () => {
  const service = registryService([loopRunner(1), loopRunner(2), loopRunner(3)]);
  const firstReport = await runRegistrationCleanup(
    cleanupOptions({ apply: true, limit: 1 }),
    { fetch: service.fetch, sleep: async () => {} },
  );
  const secondReport = await runRegistrationCleanup(
    cleanupOptions({ apply: true }),
    { fetch: service.fetch, sleep: async () => {} },
  );

  assert.equal(firstReport.deleted, 1);
  assert.equal(firstReport.remaining, 2);
  assert.equal(secondReport.totalRegistrations, 2);
  assert.equal(secondReport.deleted, 2);
  assert.equal(secondReport.remaining, 0);
  assert.equal(service.runners.length, 0);
  assert.deepEqual(
    deleteCalls(service.calls).map(({ url }) => Number(new URL(url).pathname.split("/").at(-1))),
    [1, 2, 3],
  );
});

test("filters a foreign scale set before checking busy state", () => {
  const selection = selectDeletions([
    loopRunner(1, { scaleSetId: 7n }),
    loopRunner(2, { scaleSetId: 8n, busy: true }),
    { id: 3, name: "runner-3", busy: true },
  ], { scaleSetId: "7" });

  assert.deepEqual(selection.counts, {
    total: 3,
    delete: 1,
    notLoopSpawned: 1,
    foreignScaleSet: 1,
    busy: 0,
  });
  assert.deepEqual(selection.deletions, [{
    runnerId: 1,
    runnerName: loopRunner(1).name,
  }]);
  assert.equal(
    isCensusPopulationMember(loopRunner(1, { busy: true }), {
      scaleSetId: "7",
    }),
    true,
  );
  assert.equal(
    isCensusPopulationMember(
      loopRunner(2, { scaleSetId: 8n, busy: true }),
      { scaleSetId: "7" },
    ),
    false,
  );
});

test("refuses duplicate runner ids inside the filtered population", async () => {
  const service = registryService([loopRunner(1), loopRunner(1)]);

  await assert.rejects(
    runRegistrationCleanup(
      cleanupOptions({ apply: true }),
      { fetch: service.fetch, sleep: async () => {} },
    ),
    (error) => {
      assert.equal(error instanceof CensusIncompleteError, true);
      assert.match(error.message, /collected 2 runner ids/u);
      assert.match(error.message, /only 1 ids are unique/u);
      return true;
    },
  );
  assert.equal(deleteCalls(service.calls).length, 0);
});

test("accepts a total_count that shrinks between pages", async () => {
  const runners = Array.from(
    { length: 1675 },
    (_, index) => loopRunner(index + 1),
  );
  const pageSize = 559;
  const pages = [
    {
      total_count: 1677,
      runners: runners.slice(0, pageSize),
    },
    {
      total_count: 1677,
      runners: runners.slice(pageSize, pageSize * 2),
    },
    {
      total_count: 1676,
      runners: runners.slice(pageSize * 2),
    },
  ];
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: requestMethod(init) });
    const page = Number(new URL(url).searchParams.get("page"));
    return fakeResponse(200, pages[page - 1]);
  };

  const report = await runRegistrationCleanup(
    cleanupOptions({ pageSize }),
    { fetch },
  );

  assert.equal(report.refused, false);
  assert.equal(report.provisional, false);
  assert.equal(report.refusalReason, null);
  assert.equal(report.totalRegistrations, 1676);
  assert.equal(report.censusPagesFetched, 3);
  assert.equal(report.counts.delete, runners.length);
  assert.deepEqual(
    report.deletions.map(({ runnerId }) => runnerId),
    runners.map(({ id }) => id),
  );
  assert.equal(deleteCalls(calls).length, 0);
});

test("reports the initial count and the reaping that happened during the census", async () => {
  const runners = Array.from(
    { length: 1675 },
    (_, index) => loopRunner(index + 1),
  );
  const pageSize = 50;
  const fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const start = (page - 1) * pageSize;
    return fakeResponse(200, {
      total_count: page === 1 ? 1677 : 1676,
      runners: runners.slice(start, start + pageSize),
    });
  };

  const report = await runRegistrationCleanup(
    cleanupOptions({ pageSize }),
    { fetch },
  );

  assert.equal(report.initialRegistrations, 1677);
  assert.equal(report.totalRegistrations, 1676);
  assert.equal(report.removedDuringCensus, 1);
});

test("reports zero reaping for a quiet registry", async () => {
  const service = registryService([
    loopRunner(1),
    loopRunner(2),
    loopRunner(3),
  ]);

  const report = await runRegistrationCleanup(
    cleanupOptions({ pageSize: 2 }),
    { fetch: service.fetch },
  );

  assert.equal(report.removedDuringCensus, 0);
  assert.equal(report.initialRegistrations, report.totalRegistrations);
});

test("accepts total_count growth outside the filtered population", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: requestMethod(init) });
    const page = Number(new URL(url).searchParams.get("page"));
    return page === 1
      ? fakeResponse(200, {
          total_count: 3,
          runners: [loopRunner(1), loopRunner(2)],
        })
      : fakeResponse(200, {
          total_count: 4,
          runners: [{
            id: 3,
            name: "gha-runner01-3-41207",
            busy: false,
          }],
        });
  };

  const report = await runRegistrationCleanup(
    cleanupOptions({ apply: true, expectedTargets: 2, pageSize: 2 }),
    { fetch, sleep: async () => {} },
  );

  assert.equal(report.refused, false);
  assert.equal(report.initialRegistrations, 3);
  assert.equal(report.totalRegistrations, 4);
  assert.equal(report.filteredRegistrations, 2);
  assert.deepEqual(
    deleteCalls(calls).map(({ url }) => Number(new URL(url).pathname.split("/").at(-1))),
    [1, 2],
  );
  assert.doesNotThrow(() => assertCensusComplete({
    initialTotalCount: 3,
    finalTotalCount: 4,
    collectedIds: [1, 2, 3],
    filteredIds: [1, 2],
    baselineFilteredCount: 2,
    pagesFetched: 2,
    pageLimit: 40,
    lastPageSize: 1,
    pageSize: 2,
  }));
});

test("a refusal report carries the initial count it managed to read", async () => {
  const fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    if (page === 1) {
      return fakeResponse(200, {
        total_count: 2,
        runners: [loopRunner(1)],
      });
    }
    if (page === 2) {
      return fakeResponse(200, {
        total_count: 3,
        runners: [loopRunner(2)],
      });
    }
    return fakeResponse(200, { total_count: 3, runners: [] });
  };

  await assert.rejects(
    runRegistrationCleanup(
      cleanupOptions({ expectedTargets: 1, pageSize: 1 }),
      { fetch },
    ),
    (error) => {
      assert.equal(error instanceof CensusIncompleteError, true);
      assert.equal(error.report.initialRegistrations, 2);
      return true;
    },
  );
});

test("a page-one failure reports null counts rather than guessing", async () => {
  const fetch = async () => fakeResponse(500);

  await assert.rejects(
    runRegistrationCleanup(cleanupOptions(), { fetch }),
    (error) => {
      assert.equal(error instanceof CensusIncompleteError, true);
      assert.equal(error.report.initialRegistrations, null);
      assert.equal(error.report.totalRegistrations, null);
      assert.equal(error.report.removedDuringCensus, null);
      return true;
    },
  );
});

test("accepts a collection shorter than organization reaping can explain", () => {
  assert.doesNotThrow(() => assertCensusComplete({
    initialTotalCount: 5,
    finalTotalCount: 4,
    collectedIds: [1],
    filteredIds: [1],
    baselineFilteredCount: 1,
    pagesFetched: 1,
    pageLimit: 40,
    lastPageSize: 1,
    pageSize: 100,
  }));
});

test("a quiet registry uses the filtered population baseline", () => {
  const census = {
    initialTotalCount: 10,
    finalTotalCount: 10,
    pagesFetched: 1,
    pageLimit: 40,
    lastPageSize: 9,
    pageSize: 100,
  };

  assert.throws(
    () => assertCensusComplete({
      ...census,
      collectedIds: Array.from({ length: 9 }, (_, index) => index + 1),
      filteredIds: Array.from({ length: 9 }, (_, index) => index + 1),
      baselineFilteredCount: 8,
    }),
    (error) => {
      assert.equal(error instanceof CensusIncompleteError, true);
      assert.match(error.message, /population this cleanup acts on grew from 8 to 9/u);
      return true;
    },
  );
  assert.doesNotThrow(() => assertCensusComplete({
    ...census,
    collectedIds: Array.from({ length: 10 }, (_, index) => index + 1),
    filteredIds: Array.from({ length: 10 }, (_, index) => index + 1),
    baselineFilteredCount: 10,
  }));
});

test("accepts a collection that exceeds the initial total_count", () => {
  assert.doesNotThrow(() => assertCensusComplete({
    initialTotalCount: 2,
    finalTotalCount: 1,
    collectedIds: [1, 2, 3],
    filteredIds: [1, 2, 3],
    baselineFilteredCount: 3,
    pagesFetched: 1,
    pageLimit: 40,
    lastPageSize: 3,
    pageSize: 100,
  }));
});

test("a population-growth refusal still reports capability and selection", async () => {
  const calls = [];
  const oauthScopes = "repo, admin:org, workflow";
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: requestMethod(init) });
    const page = Number(new URL(url).searchParams.get("page"));
    const response = page === 1
      ? fakeResponse(200, {
          total_count: 3,
          runners: [loopRunner(1), loopRunner(2)],
        })
      : fakeResponse(200, {
          total_count: 4,
          runners: [{
            id: 3,
            name: "gha-runner01-svc-2-9981",
            busy: false,
          }],
        });
    response.headers = {
      get: () => oauthScopes,
    };
    return response;
  };

  await assert.rejects(
    runRegistrationCleanup(
      cleanupOptions({ apply: true, expectedTargets: 1, pageSize: 2 }),
      { fetch, sleep: async () => {} },
    ),
    (error) => {
      assert.equal(error instanceof CensusIncompleteError, true);
      assert.equal(error.report.refused, true);
      assert.equal(error.report.provisional, true);
      assert.equal(error.report.deleteCapability, "proven-classic-admin-org");
      assert.equal(error.report.tokenScopes, oauthScopes);
      assert.equal(error.report.filteredRegistrations, 2);
      assert.equal(error.report.expectedTargets, 1);
      assert.equal(typeof error.report.counts.delete, "number");
      assert.equal(error.report.counts.delete, 2);
      assert.equal(error.report.censusPagesFetched, 2);
      return true;
    },
  );
  assert.equal(deleteCalls(calls).length, 0);
});

test("a refusal report survives a malformed runner record", async () => {
  const calls = [];
  const oauthScopes = "admin:org";
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: requestMethod(init) });
    return {
      ...fakeResponse(200, {
        total_count: 1,
        runners: [{ id: 1, name: "runner-1" }],
      }),
      headers: {
        get: () => oauthScopes,
      },
    };
  };

  await assert.rejects(
    runRegistrationCleanup(
      cleanupOptions({ apply: true }),
      { fetch, sleep: async () => {} },
    ),
    (error) => {
      assert.equal(error instanceof RunnerRecordInvalidError, true);
      assert.equal(error.report.refused, true);
      assert.equal(error.report.counts, null);
      assert.equal(error.report.deletions, null);
      assert.equal(error.report.skippedSample, null);
      assert.equal(error.report.deleteCapability, "proven-classic-admin-org");
      return true;
    },
  );
  assert.equal(deleteCalls(calls).length, 0);
});

test("a page-one failure still reports a refusal", (t) => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "registration-cleanup-refusal-test-"),
  );
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const reportPath = join(temporaryDirectory, "report.json");
  const preloadSource = `
    globalThis.fetch = async () => ({ ok: false, status: 500 });
  `;
  const preloadUrl = `data:text/javascript,${encodeURIComponent(preloadSource)}`;
  const result = spawnSync(process.execPath, [
    "--import",
    preloadUrl,
    cleanupCli,
    "--scope",
    "organization",
    "--organization",
    "example-org",
    "--report",
    reportPath,
  ], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "test-token" },
  });

  assert.equal(result.status, 1);
  const stdoutReport = JSON.parse(result.stdout);
  const fileReport = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(fileReport, stdoutReport);
  assert.equal(stdoutReport.refused, true);
  assert.equal(stdoutReport.provisional, true);
  assert.equal(stdoutReport.censusPagesFetched, 0);
  assert.match(stdoutReport.refusalReason, /HTTP 500 on page 1/u);
  assert.equal(
    result.stderr,
    "Registration cleanup: unknown registrations, 0 targets, 0 deleted, 0 remaining.\nThe runner census failed with HTTP 500 on page 1.\n",
  );
});

test("reports the required permission when listing returns 403", async () => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: requestMethod(init) });
    return fakeResponse(403);
  };

  await assert.rejects(
    runRegistrationCleanup(cleanupOptions({ apply: true }), { fetch }),
    (error) => {
      assert.equal(error instanceof CensusIncompleteError, true);
      assert.match(error.message, /HTTP 403/u);
      assert.match(
        error.message,
        /Organization "Self-hosted runners: Read and write"/u,
      );
      assert.match(error.message, /admin:org/u);
      return true;
    },
  );
  assert.equal(deleteCalls(calls).length, 0);
});

test("uses the required list request path and headers", async () => {
  const service = registryService([]);
  const report = await runRegistrationCleanup(
    cleanupOptions(),
    { fetch: service.fetch },
  );
  const [call] = service.calls;

  assert.equal(
    call.url,
    "https://api.github.com/orgs/example-org/actions/runners?per_page=100&page=1",
  );
  assert.equal(call.method, "GET");
  assert.deepEqual(call.init.headers, {
    Accept: "application/vnd.github+json",
    Authorization: "Bearer test-token",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "gha-cloudflare-runner-registration-cleanup",
  });
  assert.equal(report.scope, "organization:example-org");
});

test("refuses an invalid total_count with a numeric census message", () => {
  assert.throws(
    () => assertCensusComplete({
      initialTotalCount: -1,
      finalTotalCount: -1,
      collectedIds: [],
      pagesFetched: 1,
      pageLimit: 40,
      lastPageSize: 0,
      pageSize: 100,
    }),
    (error) => {
      assert.equal(error instanceof CensusIncompleteError, true);
      assert.match(error.message, /total_count -1/u);
      return true;
    },
  );
});

test("caps the skipped sample and returns JSON-serialisable data", async () => {
  const runners = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    name: `runner-${index + 1}`,
    busy: false,
  }));
  const service = registryService(runners);
  const report = await runRegistrationCleanup(
    cleanupOptions(),
    { fetch: service.fetch },
  );

  assert.equal(report.counts.notLoopSpawned, 25);
  assert.equal(report.skippedSample.length, 20);
  assert.doesNotThrow(() => JSON.stringify(report));
});

test("refuses a missing token before issuing a request", async () => {
  let requestCount = 0;
  await assert.rejects(
    runRegistrationCleanup(
      cleanupOptions({ githubToken: "" }),
      { fetch: async () => {
        requestCount += 1;
        return fakeResponse(200, { total_count: 0, runners: [] });
      } },
    ),
    /GitHub token is required/u,
  );
  assert.equal(requestCount, 0);
});

test("the command-line entry point defaults to a dry run and writes its report", (t) => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "registration-cleanup-cli-test-"),
  );
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));
  const reportPath = join(temporaryDirectory, "report.json");
  const preloadSource = `
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ total_count: 0, runners: [] }),
    });
  `;
  const preloadUrl = `data:text/javascript,${encodeURIComponent(preloadSource)}`;
  const result = spawnSync(process.execPath, [
    "--import",
    preloadUrl,
    cleanupCli,
    "--scope",
    "organization",
    "--organization",
    "example-org",
    "--report",
    reportPath,
  ], {
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "test-token" },
  });

  assert.equal(result.status, 0, result.stderr);
  const stdoutReport = JSON.parse(result.stdout);
  const fileReport = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(fileReport, stdoutReport);
  assert.equal(stdoutReport.apply, false);
  assert.equal(stdoutReport.attempted, 0);
  assert.equal(stdoutReport.deleted, 0);
  assert.equal(
    result.stderr,
    "Registration cleanup: 0 registrations, 0 targets, 0 deleted, 0 remaining.\n",
  );
});
