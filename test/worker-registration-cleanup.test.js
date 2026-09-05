import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("./cloudflare-workers-loader.js", import.meta.url));

const {
  handleRegistrationCleanupRequest,
} = await import("../src/registration-cleanup-route.js");
const {
  GITHUB_RUNNER_LIST_PAGE_SIZE,
  REGISTRATION_CLEANUP_CENSUS_PAGE_LIMIT,
  REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL,
  REGISTRATION_CLEANUP_MIN_DELETE_INTERVAL_MS,
} = await import("../src/runner-policy.js");
const {
  SCALE_UP_REQUEST_ID_BASE,
} = await import("../src/scaleset-protocol.js");

const CONTROL_TOKEN = "control-token-with-at-least-32-characters";
const GITHUB_TOKEN = "worker-github-token";
const CLEANUP_URL =
  "https://worker.example/operator/registrations/cleanup";
const NO_BODY = Symbol("no-body");
const nodeDigest = globalThis.crypto.subtle.digest.bind(
  globalThis.crypto.subtle,
);
const testSubtle = {
  digest: nodeDigest,
  timingSafeEqual(left, right) {
    const leftBytes = new Uint8Array(left);
    const rightBytes = new Uint8Array(right);
    let difference = leftBytes.length ^ rightBytes.length;
    for (let index = 0; index < leftBytes.length; index += 1) {
      difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
    }
    return difference === 0;
  },
};

function runner(id, overrides = {}) {
  return {
    id,
    name: `cloudflare-1-${SCALE_UP_REQUEST_ID_BASE + id}`,
    busy: false,
    status: "offline",
    ...overrides,
  };
}

function targets(count, startId = 1) {
  return Array.from({ length: count }, (_, index) =>
    runner(startId + index)
  );
}

function registryService(initialRunners = [], options = {}) {
  let currentRunners = initialRunners.map((entry) => ({ ...entry }));
  let virtualNow = 0;
  const requests = [];
  const deleteIds = [];
  const deleteTimes = [];
  const logs = [];

  const fetch = async (input, init = {}) => {
    const requestUrl = new URL(input);
    const method = init.method ?? "GET";
    requests.push({ method, url: requestUrl.href });
    if (method === "GET") {
      const page = Number(requestUrl.searchParams.get("page"));
      if (options.listPage !== undefined) {
        const result = await options.listPage({
          page,
          pageSize: GITHUB_RUNNER_LIST_PAGE_SIZE,
          runners: currentRunners.map((entry) => ({ ...entry })),
        });
        if (result instanceof Response) {
          return result;
        }
        return Response.json(result);
      }
      const offset = (page - 1) * GITHUB_RUNNER_LIST_PAGE_SIZE;
      return Response.json({
        total_count: currentRunners.length,
        runners: currentRunners.slice(
          offset,
          offset + GITHUB_RUNNER_LIST_PAGE_SIZE,
        ),
      });
    }

    assert.equal(method, "DELETE");
    const match = /\/actions\/runners\/([0-9]+)$/u.exec(requestUrl.pathname);
    assert.notEqual(match, null);
    const runnerId = Number(match[1]);
    deleteIds.push(runnerId);
    deleteTimes.push(virtualNow);
    const status = options.deleteStatus?.({
      runnerId,
      attempt: deleteIds.length,
    }) ?? 204;
    if (status >= 200 && status < 300) {
      currentRunners = currentRunners.filter((entry) => entry.id !== runnerId);
    }
    return new Response(null, { status });
  };

  return {
    deleteIds,
    deleteTimes,
    logs,
    requests,
    remainingRunners: () => currentRunners.map((entry) => ({ ...entry })),
    services: {
      fetch,
      logger: {
        error(record) {
          logs.push(record);
        },
        log(record) {
          logs.push(record);
        },
      },
      now: () => virtualNow,
      sleep: async (delayMs) => {
        virtualNow += delayMs;
      },
      subtle: testSubtle,
    },
  };
}

async function callRoute(
  registry,
  {
    authToken = CONTROL_TOKEN,
    body = NO_BODY,
    env = {},
    method = "POST",
    rawBody,
  } = {},
) {
  const headers = new Headers();
  if (authToken !== null) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  let requestBody;
  if (rawBody !== undefined) {
    requestBody = rawBody;
  } else if (body !== NO_BODY) {
    requestBody = JSON.stringify(body);
  }
  if (requestBody !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const request = new Request(CLEANUP_URL, {
    method,
    headers,
    ...(requestBody === undefined ? {} : { body: requestBody }),
  });
  return handleRegistrationCleanupRequest(
    request,
    {
      CONTROL_TOKEN,
      GITHUB_REPOSITORY: "example-org/x",
      GITHUB_RUNNER_SCOPE: "organization",
      GITHUB_TOKEN,
      ...env,
    },
    new URL(request.url),
    registry.services,
  );
}

async function applyCleanup(registry, options = {}) {
  const { body = {}, ...callOptions } = options;
  return callRoute(registry, {
    body: { apply: true, confirm: "DELETE", ...body },
    ...callOptions,
  });
}

test("the route deletes only exact cloudflare-<scaleSetId>-<requestId> names", async () => {
  const base = SCALE_UP_REQUEST_ID_BASE;
  const census = [
    runner(1, { name: `cloudflare-1-${base}` }),
    runner(2, { name: `cloudflare-2-${base + 1}` }),
    runner(3, { name: "cloudflare-1" }),
    runner(4, { name: "cloudflare-1-2-3" }),
    runner(5, { name: `Cloudflare-1-${base}` }),
    runner(6, { name: ` cloudflare-1-${base}` }),
    runner(7, { name: `cloudflare-1-${base}x` }),
    runner(8, { name: `cloudflare-01-${base}` }),
    runner(9, { name: "workload-ci-1" }),
    runner(10, {
      name: "cloudflare-00000000-0000-4000-8000-000000000054",
    }),
  ];
  const registry = registryService(census);

  const response = await applyCleanup(registry);

  assert.equal(response.status, 200);
  assert.deepEqual(registry.deleteIds, [1, 2]);
});

test("the route never deletes a request id below the loop-spawn band", async () => {
  const registry = registryService([
    runner(1, { name: `cloudflare-1-${SCALE_UP_REQUEST_ID_BASE - 1}` }),
    runner(2, { name: `cloudflare-1-${SCALE_UP_REQUEST_ID_BASE}` }),
  ]);

  const response = await applyCleanup(registry);

  assert.equal(response.status, 200);
  assert.deepEqual(registry.deleteIds, [2]);
});

test("the route never deletes a busy registration", async () => {
  const registry = registryService([
    runner(1, { busy: true }),
    runner(2),
  ]);

  const response = await applyCleanup(registry);
  const report = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(registry.deleteIds, [2]);
  assert.equal(report.counts.busy, 1);
});

test("the route treats HTTP 422 on delete as an expected skip, not a failure", async () => {
  const registry = registryService(targets(3), {
    deleteStatus: ({ runnerId }) => runnerId === 1 ? 422 : 204,
  });

  const response = await applyCleanup(registry);
  const report = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(registry.deleteIds, [1, 2, 3]);
  assert.equal(report.busySkipped, 1);
  assert.equal(report.deleted, 2);
});

test("the route is a dry run by default", async () => {
  for (const body of [NO_BODY, {}, { apply: false }]) {
    const registry = registryService(targets(2));
    const response = await callRoute(registry, { body });
    const report = await response.json();

    assert.equal(response.status, 200);
    assert.equal(report.apply, false);
    assert.deepEqual(registry.deleteIds, []);
  }
});

test("an apply run requires the literal DELETE confirmation", async () => {
  for (const body of [
    { apply: true },
    { apply: true, confirm: "delete" },
    { apply: true, confirm: "DELETE " },
  ]) {
    const registry = registryService(targets(1));
    const response = await callRoute(registry, { body });

    assert.equal(response.status, 400);
    assert.deepEqual(registry.deleteIds, []);
  }
});

test("the route refuses when total_count and the filtered population grow", async () => {
  const firstPage = targets(GITHUB_RUNNER_LIST_PAGE_SIZE);
  const registry = registryService([], {
    listPage: ({ page }) => page === 1
      ? { total_count: firstPage.length, runners: firstPage }
      : { total_count: firstPage.length + 1, runners: [] },
  });

  const response = await applyCleanup(registry, {
    body: { expectedTargets: firstPage.length - 1 },
  });
  const report = await response.json();

  assert.equal(response.status, 409);
  assert.equal(report.refused, true);
  assert.deepEqual(registry.deleteIds, []);
});

test("the route refuses a census page that fails", async () => {
  // A failing page carries an empty body, a GitHub error body, or a body that
  // parses as a valid runner list. The census refuses every one of them, so the
  // refusal rests on the response status and not on the body shape.
  const failedPages = [
    () => new Response(null, { status: 403 }),
    () => new Response(null, { status: 500 }),
    () => Response.json(
      { message: "Forbidden", documentation_url: "https://docs.github.com" },
      { status: 403 },
    ),
    () => Response.json({ total_count: 0, runners: [] }, { status: 403 }),
    () => Response.json({ total_count: 0, runners: [] }, { status: 500 }),
  ];
  for (const failedPage of failedPages) {
    const firstPage = targets(GITHUB_RUNNER_LIST_PAGE_SIZE);
    const registry = registryService([], {
      listPage: ({ page }) => page === 1
        ? { total_count: firstPage.length + 1, runners: firstPage }
        : failedPage(),
    });

    const response = await applyCleanup(registry);

    assert.equal(response.status, 409);
    assert.equal((await response.json()).refused, true);
    assert.deepEqual(registry.deleteIds, []);
  }
});

test("the route refuses a census with duplicate runner ids", async () => {
  const duplicate = runner(1);
  const registry = registryService([
    duplicate,
    { ...duplicate, name: `cloudflare-2-${SCALE_UP_REQUEST_ID_BASE}` },
  ]);

  const response = await applyCleanup(registry);

  assert.equal(response.status, 409);
  assert.deepEqual(registry.deleteIds, []);
});

test("the route refuses a truncated census", async () => {
  const total = REGISTRATION_CLEANUP_CENSUS_PAGE_LIMIT *
    GITHUB_RUNNER_LIST_PAGE_SIZE;
  const registry = registryService([], {
    listPage: ({ page, pageSize }) => ({
      total_count: total,
      runners: targets(pageSize, (page - 1) * pageSize + 1),
    }),
  });

  const response = await applyCleanup(registry);

  assert.equal(response.status, 409);
  assert.deepEqual(registry.deleteIds, []);
  assert.equal(
    registry.requests.filter(({ method }) => method === "GET").length,
    REGISTRATION_CLEANUP_CENSUS_PAGE_LIMIT,
  );
});

test("the route tolerates a census whose total_count shrinks", async () => {
  const firstPage = [
    runner(1),
    runner(2),
    ...Array.from(
      { length: GITHUB_RUNNER_LIST_PAGE_SIZE - 2 },
      (_, index) => runner(index + 3, { name: `workload-ci-${index + 1}` }),
    ),
  ];
  const registry = registryService([], {
    listPage: ({ page }) => page === 1
      ? { total_count: firstPage.length + 1, runners: firstPage }
      : { total_count: firstPage.length, runners: [] },
  });

  const response = await applyCleanup(registry);

  assert.equal(response.status, 200);
  assert.deepEqual(registry.deleteIds, [1, 2]);
});

test("the route tolerates organization churn from unrelated runners", async () => {
  const firstPage = [
    runner(1),
    runner(2),
    runner(1_001, { name: "gha-runner01-3-41207" }),
    ...Array.from(
      { length: GITHUB_RUNNER_LIST_PAGE_SIZE - 3 },
      (_, index) => runner(1_002 + index, {
        name: `workload-ci-first-${index}`,
      }),
    ),
  ];
  const secondPage = Array.from(
    { length: GITHUB_RUNNER_LIST_PAGE_SIZE },
    (_, index) => runner(2_001 + index, {
      name: index === 0
        ? "gha-runner01-svc-2-9981"
        : `workload-ci-second-${index}`,
    }),
  );
  const thirdPage = [runner(3_001, { name: "gha-runner01-io-11-5522" })];
  // The unrelated fleet is ephemeral, so the organization total both rises and
  // falls during one census. Every ending shape must be tolerated, including a
  // total that ends ABOVE where it started: that is what a fleet scaling up
  // looks like, and it is the shape a `total_count` guard would refuse on.
  const organizationTotals = [
    [1669, 1670, 1668], // ends below the start
    [1669, 1670, 1669], // ends level with the start
    [1669, 1670, 1672], // ends above the start
    [1669, 1668, 1674], // dips, then ends well above the start
  ];
  for (const totals of organizationTotals) {
    const registry = registryService([], {
      listPage: ({ page }) => {
        if (page === 1) {
          return { total_count: totals[0], runners: firstPage };
        }
        if (page === 2) {
          return { total_count: totals[1], runners: secondPage };
        }
        return { total_count: totals[2], runners: thirdPage };
      },
    });

    const response = await applyCleanup(registry, {
      body: { expectedTargets: 2 },
    });

    assert.equal(
      response.status,
      200,
      `organization totals ${totals.join(" -> ")} must not refuse`,
    );
    assert.deepEqual(registry.deleteIds, [1, 2]);
  }
});

test("the route refuses when the population it acts on grows", async () => {
  const registry = registryService(targets(2));

  const response = await applyCleanup(registry, {
    body: { expectedTargets: 1 },
  });
  const report = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(registry.deleteIds, []);
  assert.match(
    report.refusalReason,
    /population this cleanup acts on grew from 1 to 2/iu,
  );
});

test("the route tolerates a shrinking population", async () => {
  const registry = registryService(targets(1));

  const response = await applyCleanup(registry, {
    body: { expectedTargets: 2 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(registry.deleteIds, [1]);
});

test("the route accepts an exact population match", async () => {
  const registry = registryService(targets(2));

  const response = await applyCleanup(registry, {
    body: { expectedTargets: 2 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(registry.deleteIds, [1, 2]);
});

test("the route refuses a duplicate id inside the population it acts on", async () => {
  const duplicate = runner(1);
  const registry = registryService([duplicate, { ...duplicate }]);

  const response = await applyCleanup(registry, {
    body: { expectedTargets: 2 },
  });

  assert.equal(response.status, 409);
  assert.deepEqual(registry.deleteIds, []);
});

test("the route ignores a duplicate id outside the population it acts on", async () => {
  const unrelated = runner(2, { name: "gha-runner01-3-41207" });
  const registry = registryService([runner(1), unrelated, { ...unrelated }]);

  const response = await applyCleanup(registry, {
    body: { expectedTargets: 1 },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(registry.deleteIds, [1]);
});

test("the route rejects an invalid expectedTargets", async () => {
  for (const expectedTargets of ["1", -1, 1.5]) {
    const registry = registryService(targets(1));

    const response = await applyCleanup(registry, {
      body: { expectedTargets },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(registry.deleteIds, []);
  }
});

test("the route reports the filtered population size", async () => {
  const registry = registryService([
    runner(1),
    runner(2, { busy: true }),
    runner(3, { name: "gha-runner01-3-41207" }),
  ]);

  const response = await callRoute(registry, {
    body: { expectedTargets: 2 },
  });
  const report = await response.json();

  assert.equal(response.status, 200);
  assert.equal(report.filteredRegistrations, 2);
  assert.equal(report.expectedTargets, 2);
});

test("the route deletes at most REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL per invocation", async () => {
  const registry = registryService(
    targets(REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL * 4),
  );

  const response = await applyCleanup(registry);
  const report = await response.json();

  assert.equal(response.status, 200);
  assert.equal(
    registry.deleteIds.length,
    REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL,
  );
  assert.equal(report.truncatedByLimit, true);
  assert.ok(report.remaining > 0);
});

test("the route refuses a limit above REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL", async () => {
  const registry = registryService(targets(1));

  const response = await applyCleanup(registry, {
    body: { limit: REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL + 1 },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(registry.deleteIds, []);
});

test("the route resumes across calls", async () => {
  const targetCount = REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL * 2;
  const registry = registryService(targets(targetCount));

  const firstResponse = await applyCleanup(registry);
  const firstDeleted = [...registry.deleteIds];
  const secondResponse = await applyCleanup(registry);
  const allDeleted = registry.deleteIds;

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(firstDeleted.length, REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL);
  assert.equal(new Set(allDeleted).size, targetCount);
  assert.deepEqual(allDeleted, targets(targetCount).map(({ id }) => id));
  assert.deepEqual(registry.remainingRunners(), []);
});

test("the route spaces deletes by REGISTRATION_CLEANUP_MIN_DELETE_INTERVAL_MS", async () => {
  const registry = registryService(targets(3));

  const response = await applyCleanup(registry);

  assert.equal(response.status, 200);
  for (let index = 1; index < registry.deleteTimes.length; index += 1) {
    assert.ok(
      registry.deleteTimes[index] - registry.deleteTimes[index - 1] >=
        REGISTRATION_CLEANUP_MIN_DELETE_INTERVAL_MS,
    );
  }
});

test("the route requires the CONTROL_TOKEN", async () => {
  const cases = [
    { authToken: null },
    { authToken: "wrong-control-token-with-at-least-32-characters" },
    { authToken: CONTROL_TOKEN.slice(0, -1) },
    {
      authToken: "short-token",
      env: { CONTROL_TOKEN: "short-token" },
    },
  ];
  for (const options of cases) {
    const registry = registryService(targets(1));
    const response = await applyCleanup(registry, options);

    assert.equal(response.status, 401);
    assert.deepEqual(registry.deleteIds, []);
  }
});

test("the route rejects a method other than POST", async () => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    const registry = registryService(targets(1));
    const response = await callRoute(registry, { method });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
  }
});

test("the route rejects an unknown body field", async () => {
  for (const body of [{ runnerId: 1 }, { scope: { type: "organization" } }]) {
    const registry = registryService(targets(1));
    const response = await callRoute(registry, { body });

    assert.equal(response.status, 400);
    assert.deepEqual(registry.deleteIds, []);
  }
});

test("the route refuses an apply run while RUNNER_REGISTRATION_DELETE is off", async () => {
  const registry = registryService(targets(1));

  const applyResponse = await applyCleanup(registry, {
    env: { RUNNER_REGISTRATION_DELETE: "off" },
  });
  const dryRunResponse = await callRoute(registry, {
    body: { apply: false },
    env: { RUNNER_REGISTRATION_DELETE: "off" },
  });

  assert.equal(applyResponse.status, 409);
  assert.deepEqual(registry.deleteIds, []);
  assert.equal(dryRunResponse.status, 200);
  assert.equal((await dryRunResponse.json()).apply, false);
});

test("the route takes its scope from the environment, not the request", async () => {
  const registry = registryService(targets(2));

  const response = await applyCleanup(registry, {
    env: {
      GITHUB_REPOSITORY: "example-org/x",
      GITHUB_RUNNER_SCOPE: "organization",
    },
  });

  assert.equal(response.status, 200);
  assert.ok(registry.requests.length > 0);
  for (const request of registry.requests) {
    assert.match(
      request.url,
      /^https:\/\/api\.github\.com\/orgs\/example-org\/actions\/runners/u,
    );
  }
});

test("the route returns 500 when GITHUB_TOKEN is missing", async () => {
  const registry = registryService(targets(1));

  const response = await callRoute(registry, {
    env: { GITHUB_TOKEN: undefined },
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "GITHUB_TOKEN is not configured",
  });
});

test("the route bounds the deletions it echoes", async () => {
  const registry = registryService(
    targets(REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL * 4),
  );

  const response = await callRoute(registry, { body: {} });
  const report = await response.json();

  assert.equal(response.status, 200);
  assert.ok(
    report.deletions.length <=
      REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL,
  );
  assert.equal(
    report.maxDeletesPerCall,
    REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL,
  );
});

test("the route reports a partial result and 502 when a delete returns 403", async () => {
  const registry = registryService(targets(3), {
    deleteStatus: ({ runnerId }) => runnerId === 2 ? 403 : 204,
  });

  const response = await applyCleanup(registry);
  const report = await response.json();

  assert.equal(response.status, 502);
  assert.deepEqual(registry.deleteIds, [1, 2]);
  assert.equal(report.attempted, 2);
  assert.equal(report.deleted, 1);
  assert.equal(report.remaining, 2);
});

test("a busy record does not stall the resume hand-off", async () => {
  // The workflow predicts the next round's population as
  // filteredRegistrations - deleted - alreadyAbsent. A busy record stays in the
  // population but is never deletable, so a hand-off built on `remaining`
  // would under-predict by the busy count and refuse round two as false growth.
  const registry = registryService([
    runner(1),
    runner(2, { busy: true }),
    runner(3),
    runner(4),
  ]);

  const first = await applyCleanup(registry, { body: { limit: 2 } });
  const firstReport = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstReport.filteredRegistrations, 4);
  assert.equal(firstReport.busySkipped, 0);
  assert.deepEqual(registry.deleteIds, [1, 3]);

  const nextExpected = firstReport.filteredRegistrations -
    firstReport.deleted -
    firstReport.alreadyAbsent;
  // `remaining` counts only deletable targets, so it sits one below the true
  // next population for each busy record. Handing it off would refuse round two.
  assert.equal(firstReport.remaining, nextExpected - 1);

  const second = await applyCleanup(registry, {
    body: { limit: 2, expectedTargets: nextExpected },
  });
  const secondReport = await second.json();

  assert.equal(second.status, 200, secondReport.refusalReason ?? "");
  assert.equal(secondReport.refused, false);
  assert.deepEqual(registry.deleteIds, [1, 3, 4]);
  assert.deepEqual(
    registry.remainingRunners().map(({ id }) => id),
    [2],
  );
});

