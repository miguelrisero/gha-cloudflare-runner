import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MessageQueueTokenExpiredError,
  MessageSessionExpiredError,
  RateLimitedError,
  RequestBudgetExhausted,
  ScaleSetNotFoundError,
  ScaleSetRequestError,
  SessionConflictError,
  acquireJobs,
  adminTokenNeedsRefresh,
  createAppJwt,
  createMessageSession,
  deleteMessage,
  deleteMessageSession,
  fetchActionsServiceConnection,
  fetchInstallationToken,
  fetchRegistrationToken,
  generateJitRunnerConfig,
  getMessage,
  getRunnerByName,
  getRunnerScaleSet,
  issueRequest,
  redactSecrets,
  refreshMessageSession,
  registrationTokenPath,
  removeRunner,
  runnerListPath,
  runnerPath,
} from "../src/scaleset-client.js";

const NOW_MS = 1_800_000_000_000;
const DEADLINE_MS = NOW_MS + 30_000;
const ACTIONS_SERVICE_URL = "https://actions.example.test/tenant";
const ADMIN_TOKEN = "admin-token-secret";
const GITHUB_USER_AGENT = "gha-cloudflare-runner";
const REGISTRATION_TOKEN_INPUT = Object.freeze({
  scope: Object.freeze({
    type: "repository",
    owner: "example-org",
    repository: "example-repo",
  }),
  githubToken: "github-token",
});
const SESSION = Object.freeze({
  sessionId: "11111111-1111-4111-8111-111111111111",
  messageQueueUrl: "https://queue.example.test/messages?tenant=one",
  messageQueueAccessToken: "message-queue-token-secret",
});

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers });
}

function emptyResponse(status, headers = {}) {
  return new Response(null, { status, headers });
}

function fetchSequence(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const response = responses[calls.length - 1];
    if (response === undefined) {
      throw new Error(`No stub response exists for call ${calls.length}`);
    }
    return typeof response === "function"
      ? response(url, init)
      : response;
  };
  return { calls, fetch };
}

function services(fetch, overrides = {}) {
  return { fetch, now: () => NOW_MS, ...overrides };
}

function normalizedHeaders(call) {
  return Object.fromEntries(new Headers(call.init.headers).entries());
}

function assertCall(call, { method, url, headers, body }) {
  assert.equal(call.init.method, method);
  assert.equal(call.url, url);
  assert.deepEqual(normalizedHeaders(call), headers);
  assert.equal(call.init.body, body);
  assert.equal(call.init.signal instanceof AbortSignal, true);
}

function validStatistics() {
  return {
    totalAvailableJobs: 0,
    totalAcquiredJobs: 0,
    totalAssignedJobs: 1,
    totalRunningJobs: 1,
    totalRegisteredRunners: 1,
    totalBusyRunners: 1,
    totalIdleRunners: 0,
  };
}

function validMessagePayload() {
  return {
    messageId: 73,
    messageType: "RunnerScaleSetJobMessages",
    body: JSON.stringify([
      {
        messageType: "JobAssigned",
        runnerRequestId: 902,
        ownerName: "example-org",
        repositoryName: "example-repo",
      },
    ]),
    statistics: validStatistics(),
  };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function unsignedAdminToken(exp) {
  return `${base64UrlJson({ alg: "none" })}.${base64UrlJson({ exp })}.x`;
}

function baseOperationConfig(overrides = {}) {
  return {
    actionsServiceUrl: ACTIONS_SERVICE_URL,
    adminToken: ADMIN_TOKEN,
    scaleSetId: 9,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
}

test("runner paths share the exact repository and organization bases [mutation: keep repository-only paths]", () => {
  const repositoryScope = {
    type: "repository",
    owner: "example-org",
    repository: "example-repo",
  };
  const organizationScope = {
    type: "organization",
    organization: "example-org",
  };

  assert.deepEqual(
    [
      runnerListPath(repositoryScope),
      runnerPath(repositoryScope, 73),
      registrationTokenPath(repositoryScope),
    ],
    [
      "/repos/example-org/example-repo/actions/runners",
      "/repos/example-org/example-repo/actions/runners/73",
      "/repos/example-org/example-repo/actions/runners/registration-token",
    ],
  );
  assert.deepEqual(
    [
      runnerListPath(organizationScope),
      runnerPath(organizationScope, 73),
      registrationTokenPath(organizationScope),
    ],
    [
      "/orgs/example-org/actions/runners",
      "/orgs/example-org/actions/runners/73",
      "/orgs/example-org/actions/runners/registration-token",
    ],
  );
});

test("runnerPath rejects every non-positive safe integer [mutation: remove the runner-id guard]", () => {
  const scope = {
    type: "repository",
    repository: "example-org/example-repo",
  };
  for (const runnerId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => runnerPath(scope, runnerId),
      {
        name: "TypeError",
        message: "The runner identifier must be a positive safe integer",
      },
    );
  }
});

test("the authentication chain uses the exact GitHub requests", async () => {
  const adminToken = unsignedAdminToken(1_800_000_600);
  const stub = fetchSequence([
    jsonResponse({ token: "installation-token" }, 201),
    jsonResponse({ token: "repository-registration-token" }, 201),
    jsonResponse({ token: "organization-registration-token" }, 201),
    jsonResponse({ url: ACTIONS_SERVICE_URL, token: adminToken }, 202),
  ]);
  const injected = services(stub.fetch);

  assert.equal(
    await fetchInstallationToken(
      { installationId: 1234, appJwt: "app-jwt" },
      injected,
    ),
    "installation-token",
  );
  assert.equal(
    await fetchRegistrationToken(
      {
        scope: {
          type: "repository",
          owner: "example-org",
          repository: "example-repo",
        },
        githubToken: "installation-token",
      },
      injected,
    ),
    "repository-registration-token",
  );
  assert.equal(
    await fetchRegistrationToken(
      {
        scope: { type: "organization", organization: "example-org" },
        githubToken: "installation-token",
      },
      injected,
    ),
    "organization-registration-token",
  );
  assert.deepEqual(
    await fetchActionsServiceConnection(
      {
        configUrl: "https://github.com/example-org",
        registrationToken: "organization-registration-token",
      },
      injected,
    ),
    {
      actionsServiceUrl: ACTIONS_SERVICE_URL,
      adminToken,
      adminTokenExpiresAtMs: 1_800_000_600_000,
    },
  );

  assert.deepEqual(stub.calls.map((call) => ({
    method: call.init.method,
    url: call.url,
    headers: normalizedHeaders(call),
    body: call.init.body,
    hasSignal: "signal" in call.init,
  })), [
    {
      method: "POST",
      url: "https://api.github.com/app/installations/1234/access_tokens",
      headers: {
        authorization: "Bearer app-jwt",
        "content-type": "application/vnd.github+json",
        "user-agent": GITHUB_USER_AGENT,
      },
      body: undefined,
      hasSignal: false,
    },
    {
      method: "POST",
      url: "https://api.github.com/repos/example-org/example-repo/actions/runners/registration-token",
      headers: {
        authorization: "Bearer installation-token",
        "content-type": "application/vnd.github.v3+json",
        "user-agent": GITHUB_USER_AGENT,
      },
      body: undefined,
      hasSignal: false,
    },
    {
      method: "POST",
      url: "https://api.github.com/orgs/example-org/actions/runners/registration-token",
      headers: {
        authorization: "Bearer installation-token",
        "content-type": "application/vnd.github.v3+json",
        "user-agent": GITHUB_USER_AGENT,
      },
      body: undefined,
      hasSignal: false,
    },
    {
      method: "POST",
      url: "https://api.github.com/actions/runner-registration",
      headers: {
        authorization: "RemoteAuth organization-registration-token",
        "content-type": "application/json",
        "user-agent": GITHUB_USER_AGENT,
      },
      body: JSON.stringify({
        url: "https://github.com/example-org",
        runner_event: "register",
      }),
      hasSignal: false,
    },
  ]);
});

test("fetchRegistrationToken sends the GitHub User-Agent", async () => {
  const stub = fetchSequence([jsonResponse({ token: "registration-token" }, 201)]);

  await fetchRegistrationToken(REGISTRATION_TOKEN_INPUT, services(stub.fetch));

  assert.equal(
    new Headers(stub.calls[0].init.headers).get("User-Agent"),
    GITHUB_USER_AGENT,
  );
});

test("installation and Actions connection requests send the GitHub User-Agent", async () => {
  const adminToken = unsignedAdminToken(1_800_000_600);
  const stub = fetchSequence([
    jsonResponse({ token: "installation-token" }, 201),
    jsonResponse({ url: ACTIONS_SERVICE_URL, token: adminToken }, 200),
  ]);
  const injected = services(stub.fetch);

  await fetchInstallationToken(
    { installationId: 1234, appJwt: "app-jwt" },
    injected,
  );
  await fetchActionsServiceConnection(
    {
      configUrl: "https://github.com/example-org",
      registrationToken: "registration-token",
    },
    injected,
  );

  assert.equal(
    new Headers(stub.calls[0].init.headers).get("User-Agent"),
    GITHUB_USER_AGENT,
  );
  assert.equal(
    new Headers(stub.calls[1].init.headers).get("User-Agent"),
    GITHUB_USER_AGENT,
  );
});

test("issueRequest preserves an explicit User-Agent from Headers", async () => {
  const stub = fetchSequence([emptyResponse(204)]);

  await issueRequest(
    "https://api.github.test/example",
    { headers: new Headers({ "User-Agent": "caller-supplied-agent" }) },
    services(stub.fetch),
  );

  assert.equal(
    new Headers(stub.calls[0].init.headers).get("User-Agent"),
    "caller-supplied-agent",
  );
});

test("an unevidenced 403 remains a ScaleSetRequestError", async () => {
  const stub = fetchSequence([
    jsonResponse({ message: "Request forbidden by administrative rules." }, 403),
  ]);

  await assert.rejects(
    fetchRegistrationToken(REGISTRATION_TOKEN_INPUT, services(stub.fetch)),
    (error) => {
      assert.equal(error instanceof ScaleSetRequestError, true);
      assert.equal(error instanceof RateLimitedError, false);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test("a 403 Retry-After header produces a RateLimitedError", async () => {
  const stub = fetchSequence([
    jsonResponse({ message: "Slow down." }, 403, { "Retry-After": "7" }),
  ]);

  await assert.rejects(
    fetchRegistrationToken(REGISTRATION_TOKEN_INPUT, services(stub.fetch)),
    (error) => {
      assert.equal(error instanceof RateLimitedError, true);
      assert.equal(error.pauseMs, 7_000);
      return true;
    },
  );
});

test("a zero 403 rate-limit remainder produces a RateLimitedError", async () => {
  const stub = fetchSequence([
    jsonResponse(
      { message: "Slow down." },
      403,
      { "X-RateLimit-Remaining": "0" },
    ),
  ]);

  await assert.rejects(
    fetchRegistrationToken(REGISTRATION_TOKEN_INPUT, services(stub.fetch)),
    (error) => {
      assert.equal(error instanceof RateLimitedError, true);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test("a 429 remains a RateLimitedError without other evidence", async () => {
  const stub = fetchSequence([
    jsonResponse({ message: "Slow down." }, 429),
  ]);

  await assert.rejects(
    fetchRegistrationToken(REGISTRATION_TOKEN_INPUT, services(stub.fetch)),
    (error) => {
      assert.equal(error instanceof RateLimitedError, true);
      assert.equal(error.status, 429);
      return true;
    },
  );
});

test("area 11: every Actions Service operation matches the wire request", async () => {
  const createdSession = { ...SESSION, ownerName: "listener-owner" };
  const refreshedSession = {
    ...createdSession,
    messageQueueAccessToken: "refreshed-message-token",
  };
  const jitPayload = {
    encodedJITConfig: "encoded-jit-config",
    runner: { id: 71, name: "cloudflare-71", runnerScaleSetId: 9 },
  };
  const runner = { id: 71, name: "cloudflare-71", runnerScaleSetId: 9 };
  const stub = fetchSequence([
    jsonResponse({ count: 1, value: [{ id: 9, name: "example-set" }] }),
    jsonResponse(createdSession),
    emptyResponse(204),
    jsonResponse(refreshedSession),
    emptyResponse(202),
    emptyResponse(204),
    jsonResponse({ count: 1, value: [902] }),
    jsonResponse(jitPayload),
    jsonResponse({ count: 1, value: [runner] }),
    emptyResponse(204),
  ]);
  const injected = services(stub.fetch);

  assert.deepEqual(
    await getRunnerScaleSet(
      baseOperationConfig({ runnerGroupId: 17, name: "example-set" }),
      injected,
    ),
    { id: 9, name: "example-set" },
  );
  assert.deepEqual(
    await createMessageSession(
      baseOperationConfig({ owner: "listener-owner" }),
      injected,
    ),
    createdSession,
  );
  assert.equal(
    await deleteMessageSession(
      baseOperationConfig({ sessionId: SESSION.sessionId }),
      injected,
    ),
    "deleted",
  );
  assert.deepEqual(
    await refreshMessageSession(
      baseOperationConfig({ sessionId: SESSION.sessionId }),
      injected,
    ),
    refreshedSession,
  );
  assert.deepEqual(
    await getMessage(
      {
        session: SESSION,
        lastMessageId: 12,
        maxCapacity: 5,
        pollTimeoutMs: 20_000,
        deadlineMs: DEADLINE_MS,
      },
      injected,
    ),
    { outcome: "no-message" },
  );
  assert.equal(
    await deleteMessage(
      { session: SESSION, messageId: 81, deadlineMs: DEADLINE_MS },
      injected,
    ),
    undefined,
  );
  assert.deepEqual(
    await acquireJobs(
      baseOperationConfig({ session: SESSION, requestIds: [901, 902] }),
      injected,
    ),
    [902],
  );
  assert.deepEqual(
    await generateJitRunnerConfig(
      baseOperationConfig({ name: "cloudflare-71", workFolder: "_work" }),
      injected,
    ),
    jitPayload,
  );
  assert.deepEqual(
    await getRunnerByName(
      baseOperationConfig({ name: "cloudflare-71" }),
      injected,
    ),
    runner,
  );
  assert.equal(
    await removeRunner(baseOperationConfig({ runnerId: 71 }), injected),
    "removed",
  );

  const adminHeaders = {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    "content-type": "application/json",
    "user-agent": GITHUB_USER_AGENT,
  };
  const queueHeaders = {
    authorization: `Bearer ${SESSION.messageQueueAccessToken}`,
    "content-type": "application/json",
    "user-agent": GITHUB_USER_AGENT,
  };
  assertCall(stub.calls[0], {
    method: "GET",
    url: `${ACTIONS_SERVICE_URL}/_apis/runtime/runnerscalesets` +
      "?api-version=6.0-preview&name=example-set&runnerGroupId=17",
    headers: adminHeaders,
    body: undefined,
  });
  assertCall(stub.calls[1], {
    method: "POST",
    url: `${ACTIONS_SERVICE_URL}/_apis/runtime/runnerscalesets/9/sessions` +
      "?api-version=6.0-preview",
    headers: adminHeaders,
    body: JSON.stringify({ ownerName: "listener-owner" }),
  });
  assertCall(stub.calls[2], {
    method: "DELETE",
    url: `${ACTIONS_SERVICE_URL}/_apis/runtime/runnerscalesets/9/sessions/` +
      `${SESSION.sessionId}?api-version=6.0-preview`,
    headers: adminHeaders,
    body: undefined,
  });
  assertCall(stub.calls[3], {
    method: "PATCH",
    url: `${ACTIONS_SERVICE_URL}/_apis/runtime/runnerscalesets/9/sessions/` +
      `${SESSION.sessionId}?api-version=6.0-preview`,
    headers: adminHeaders,
    body: undefined,
  });
  assertCall(stub.calls[4], {
    method: "GET",
    url: "https://queue.example.test/messages?tenant=one&lastMessageId=12",
    headers: {
      accept: "application/json; api-version=6.0-preview",
      authorization: `Bearer ${SESSION.messageQueueAccessToken}`,
      "user-agent": GITHUB_USER_AGENT,
      "x-scalesetmaxcapacity": "5",
    },
    body: undefined,
  });
  assertCall(stub.calls[5], {
    method: "DELETE",
    url: "https://queue.example.test/messages/81?tenant=one",
    headers: queueHeaders,
    body: undefined,
  });
  assertCall(stub.calls[6], {
    method: "POST",
    url: `${ACTIONS_SERVICE_URL}/_apis/runtime/runnerscalesets/9/acquirejobs` +
      "?api-version=6.0-preview",
    headers: queueHeaders,
    body: "[901,902]",
  });
  assertCall(stub.calls[7], {
    method: "POST",
    url: `${ACTIONS_SERVICE_URL}/_apis/runtime/runnerscalesets/9/generatejitconfig` +
      "?api-version=6.0-preview",
    headers: adminHeaders,
    body: JSON.stringify({ name: "cloudflare-71", workFolder: "_work" }),
  });
  assertCall(stub.calls[8], {
    method: "GET",
    url: `${ACTIONS_SERVICE_URL}/_apis/distributedtask/pools/0/agents` +
      "?agentName=cloudflare-71&api-version=6.0-preview",
    headers: adminHeaders,
    body: undefined,
  });
  assertCall(stub.calls[9], {
    method: "DELETE",
    url: `${ACTIONS_SERVICE_URL}/_apis/distributedtask/pools/0/agents/71` +
      "?api-version=6.0-preview",
    headers: adminHeaders,
    body: undefined,
  });
});

test("area 12: getMessage sends the exact maximum capacity", async () => {
  const stub = fetchSequence([jsonResponse(validMessagePayload())]);
  const result = await getMessage(
    {
      session: SESSION,
      lastMessageId: 0,
      maxCapacity: 0,
      pollTimeoutMs: 20_000,
      deadlineMs: DEADLINE_MS,
    },
    services(stub.fetch),
  );

  assert.equal(result.outcome, "message");
  assert.equal(
    new Headers(stub.calls[0].init.headers).get("X-ScaleSetMaxCapacity"),
    "0",
  );
});

test("area 13: acquireJobs sends a bare JSON array", async () => {
  const stub = fetchSequence([
    jsonResponse({ count: 2, value: [501, 502] }),
  ]);
  await acquireJobs(
    baseOperationConfig({ session: SESSION, requestIds: [501, 502] }),
    services(stub.fetch),
  );
  assert.equal(stub.calls[0].init.body, "[501,502]");
});

test("area 14: status responses map to the required typed errors", async (t) => {
  await t.test("409 session conflict includes the active owner", async () => {
    const stub = fetchSequence([
      jsonResponse(
        {
          message: "The runner scale set example-set already has an active session for owner listener-a",
        },
        409,
      ),
    ]);
    await assert.rejects(
      createMessageSession(
        baseOperationConfig({ owner: "listener-b" }),
        services(stub.fetch),
      ),
      (error) => {
        assert.equal(error instanceof SessionConflictError, true);
        assert.equal(error.owner, "listener-a");
        assert.equal(error.status, 409);
        return true;
      },
    );
  });

  for (const [operation, invoke] of [
    ["getMessage", (injected) => getMessage(
      {
        session: SESSION,
        lastMessageId: 0,
        maxCapacity: 5,
        pollTimeoutMs: 20_000,
        deadlineMs: DEADLINE_MS,
      },
      injected,
    )],
    ["deleteMessage", (injected) => deleteMessage(
      { session: SESSION, messageId: 81, deadlineMs: DEADLINE_MS },
      injected,
    )],
    ["acquireJobs", (injected) => acquireJobs(
      baseOperationConfig({ session: SESSION, requestIds: [501] }),
      injected,
    )],
  ]) {
    await t.test(`401 ${operation}`, async () => {
      const stub = fetchSequence([jsonResponse({ message: "expired" }, 401)]);
      await assert.rejects(
        invoke(services(stub.fetch)),
        MessageQueueTokenExpiredError,
      );
    });
  }

  await t.test("404 scale set exception", async () => {
    const stub = fetchSequence([
      jsonResponse({ typeKey: "RunnerScaleSetNotFoundException" }, 404),
    ]);
    await assert.rejects(
      getRunnerScaleSet(
        baseOperationConfig({ runnerGroupId: 17, name: "missing" }),
        services(stub.fetch),
      ),
      ScaleSetNotFoundError,
    );
  });

  await t.test("403 uses Retry-After before the reset header", async () => {
    const stub = fetchSequence([
      jsonResponse(
        { message: "rate limited" },
        403,
        {
          "Retry-After": "7",
          "X-RateLimit-Reset": String((NOW_MS + 90_000) / 1000),
        },
      ),
    ]);
    await assert.rejects(
      getRunnerScaleSet(
        baseOperationConfig({ runnerGroupId: 17, name: "example-set" }),
        services(stub.fetch),
      ),
      (error) => {
        assert.equal(error instanceof RateLimitedError, true);
        assert.equal(error.status, 403);
        assert.equal(error.pauseMs, 7_000);
        return true;
      },
    );
  });

  await t.test("429 falls back to X-RateLimit-Reset", async () => {
    const stub = fetchSequence([
      jsonResponse(
        { message: "rate limited" },
        429,
        { "X-RateLimit-Reset": String((NOW_MS + 9_000) / 1000) },
      ),
    ]);
    await assert.rejects(
      getRunnerScaleSet(
        baseOperationConfig({ runnerGroupId: 17, name: "example-set" }),
        services(stub.fetch),
      ),
      (error) => {
        assert.equal(error instanceof RateLimitedError, true);
        assert.equal(error.status, 429);
        assert.equal(error.pauseMs, 9_000);
        return true;
      },
    );
  });
});

test("area 15: an exhausted deadline prevents fetch", async () => {
  const stub = fetchSequence([
    jsonResponse({ count: 0, value: [] }),
  ]);
  await assert.rejects(
    getRunnerScaleSet(
      baseOperationConfig({
        runnerGroupId: 17,
        name: "example-set",
        deadlineMs: NOW_MS,
      }),
      services(stub.fetch),
    ),
    RequestBudgetExhausted,
  );
  assert.equal(stub.calls.length, 0);
});

test("area 16: an aborted poll returns without an acknowledgement", async () => {
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, init });
    return new Promise((resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("poll expired", "AbortError")),
        { once: true },
      );
    });
  };
  const result = await getMessage(
    {
      session: SESSION,
      lastMessageId: 73,
      maxCapacity: 5,
      pollTimeoutMs: 5,
      deadlineMs: NOW_MS + 100,
    },
    services(fetch),
  );

  assert.deepEqual(result, { outcome: "poll-aborted" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
});

test("area 17: deleteMessageSession treats 404 as already absent", async () => {
  const stub = fetchSequence([jsonResponse({ message: "gone" }, 404)]);
  assert.equal(
    await deleteMessageSession(
      baseOperationConfig({ sessionId: SESSION.sessionId }),
      services(stub.fetch),
    ),
    "already-absent",
  );
});

test(
  "area 17: deleteMessageSession treats an expired session as already absent",
  async () => {
    const stub = fetchSequence([
      jsonResponse(
        {
          message: `The session identifier ${SESSION.sessionId} is not valid.`,
          typeName:
            "GitHub.Actions.Runtime.WebApi." +
            "RunnerScaleSetSessionExpiredException, " +
            "GitHub.Actions.Runtime.WebApi",
          typeKey: "RunnerScaleSetSessionExpiredException",
        },
        400,
      ),
    ]);
    assert.equal(
      await deleteMessageSession(
        baseOperationConfig({ sessionId: SESSION.sessionId }),
        services(stub.fetch),
      ),
      "already-absent",
    );
  },
);

test(
  "area 17: deleteMessageSession still reports an unexplained 400",
  async () => {
    const stub = fetchSequence([
      jsonResponse({ message: "the request body is malformed" }, 400),
    ]);
    await assert.rejects(
      deleteMessageSession(
        baseOperationConfig({ sessionId: SESSION.sessionId }),
        services(stub.fetch),
      ),
      (error) => {
        assert.equal(error instanceof ScaleSetRequestError, true);
        assert.equal(error.status, 400);
        assert.equal(error.method, "DELETE");
        return true;
      },
    );
  },
);

test("refreshMessageSession classifies a typed expired session", async () => {
  const responseBody = {
    message: `The session identifier ${SESSION.sessionId} is not valid.`,
    typeName:
      "GitHub.Actions.Runtime.WebApi." +
      "RunnerScaleSetSessionExpiredException, " +
      "GitHub.Actions.Runtime.WebApi",
    typeKey: "RunnerScaleSetSessionExpiredException",
  };
  const stub = fetchSequence([jsonResponse(responseBody, 400)]);

  await assert.rejects(
    refreshMessageSession(
      baseOperationConfig({ sessionId: SESSION.sessionId }),
      services(stub.fetch),
    ),
    (error) => {
      assert.equal(error instanceof MessageSessionExpiredError, true);
      assert.equal(error.status, 400);
      assert.equal(error.method, "PATCH");
      assert.match(
        error.responseSnippet,
        /RunnerScaleSetSessionExpiredException/u,
      );
      return true;
    },
  );
});

test("refreshMessageSession keeps an unexplained 400 unclassified", async () => {
  const stub = fetchSequence([
    jsonResponse({ message: "the request body is malformed" }, 400),
  ]);

  await assert.rejects(
    refreshMessageSession(
      baseOperationConfig({ sessionId: SESSION.sessionId }),
      services(stub.fetch),
    ),
    (error) => {
      assert.equal(error.constructor, ScaleSetRequestError);
      assert.equal(error.status, 400);
      assert.equal(error.method, "PATCH");
      return true;
    },
  );
});

test("area 17: deleteMessage treats a replayed 404 as success", async () => {
  const stub = fetchSequence([new Response(null, { status: 404 })]);
  assert.equal(
    await deleteMessage(
      { session: SESSION, messageId: 81, deadlineMs: DEADLINE_MS },
      services(stub.fetch),
    ),
    undefined,
  );
});

test("area 18: secret redaction removes values and caps snippets", async () => {
  const secrets = {
    bearer: "bearer-value-must-disappear",
    remote: "remote-value-must-disappear",
    queue: "queue-value-must-disappear",
    jit: "jit-value-must-disappear",
  };
  const source = [
    `Authorization: Bearer ${secrets.bearer}`,
    `Authorization: RemoteAuth ${secrets.remote}`,
    JSON.stringify({
      messageQueueAccessToken: secrets.queue,
      encodedJITConfig: secrets.jit,
    }),
  ].join("\n");
  const redacted = redactSecrets(source);
  for (const secret of Object.values(secrets)) {
    assert.equal(redacted.includes(secret), false);
  }

  const stub = fetchSequence([
    new Response(`${source}${"x".repeat(700)}`, { status: 500 }),
  ]);
  await assert.rejects(
    getRunnerScaleSet(
      baseOperationConfig({ runnerGroupId: 17, name: "example-set" }),
      services(stub.fetch),
    ),
    (error) => {
      assert.equal(error instanceof ScaleSetRequestError, true);
      assert.equal(error.responseSnippet.length <= 512, true);
      for (const secret of Object.values(secrets)) {
        assert.equal(error.responseSnippet.includes(secret), false);
      }
      return true;
    },
  );
});

test("area 18: secret redaction covers system names and error chains", () => {
  const namedSecrets = Object.fromEntries([
    "jitConfig",
    "jit_config",
    "RUNNER_JITCONFIG",
    "adminToken",
    "githubToken",
    "github_token",
    "registrationToken",
    "installationToken",
    "appJwt",
    "RUNNER_TOKEN",
    "RUNNER_CLEANUP_TOKEN",
  ].map((name) => [name, `literal-${name}-secret`]));
  const nestedSecret = "literal-nested-token-secret";
  const source = JSON.stringify({
    ...namedSecrets,
    token: { value: nestedSecret },
  });
  const redacted = redactSecrets(source);
  for (const secret of [...Object.values(namedSecrets), nestedSecret]) {
    assert.equal(redacted.includes(secret), false, secret);
  }

  const causeMessageSecret = "literal-cause-message-secret";
  const causeSnippetSecret = "literal-cause-snippet-secret";
  const aggregateMessageSecret = "literal-aggregate-message-secret";
  const cause = new ScaleSetRequestError(
    `cause-visible-marker RUNNER_TOKEN=${causeMessageSecret}`,
    {
      responseSnippet: JSON.stringify({
        jit_config: causeSnippetSecret,
      }),
    },
  );
  const aggregate = new AggregateError(
    [cause],
    `aggregate-visible-marker adminToken=${aggregateMessageSecret}`,
    { cause },
  );
  const wrapped = new ScaleSetRequestError("outer-visible-marker", {
    cause: aggregate,
  });
  const chain = redactSecrets(wrapped);
  assert.match(chain, /cause-visible-marker/u);
  assert.match(chain, /aggregate-visible-marker/u);
  for (const secret of [
    causeMessageSecret,
    causeSnippetSecret,
    aggregateMessageSecret,
  ]) {
    assert.equal(chain.includes(secret), false, secret);
    assert.equal(wrapped.cause.message.includes(secret), false, secret);
  }
  assert.equal(
    wrapped.cause.errors[0].responseSnippet.includes(causeSnippetSecret),
    false,
  );
});

test("a redacted request error includes its HTTP status and method", async () => {
  const responseSecret = "literal-response-admin-token-secret";
  const stub = fetchSequence([
    jsonResponse({ adminToken: responseSecret }, 401),
  ]);

  await assert.rejects(
    refreshMessageSession(
      {
        ...baseOperationConfig(),
        sessionId: SESSION.sessionId,
      },
      services(stub.fetch),
    ),
    (error) => {
      assert.equal(error instanceof ScaleSetRequestError, true);
      const redacted = redactSecrets(error);
      assert.match(redacted, /^status: 401$/mu);
      assert.match(redacted, /^method: PATCH$/mu);
      assert.equal(redacted.includes(responseSecret), false);
      assert.match(redacted, /\[REDACTED\]/u);
      return true;
    },
  );
});

test("area 19: the admin token refresh boundary is inclusive", () => {
  assert.equal(adminTokenNeedsRefresh(NOW_MS + 60_000, NOW_MS), true);
  assert.equal(adminTokenNeedsRefresh(NOW_MS + 60_001, NOW_MS), false);
});

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

test("area 20: createAppJwt signs the exact RS256 claims", async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateKeyPkcs8 = await crypto.subtle.exportKey(
    "pkcs8",
    keyPair.privateKey,
  );
  const jwt = await createAppJwt(
    { appId: "123456", privateKeyPkcs8 },
    { now: () => NOW_MS, subtle: crypto.subtle },
  );
  const [headerPart, payloadPart, signaturePart] = jwt.split(".");
  const header = JSON.parse(decodeBase64Url(headerPart));
  const payload = JSON.parse(decodeBase64Url(payloadPart));

  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, "123456");
  assert.equal(payload.iat, Math.floor(NOW_MS / 1000) - 60);
  assert.equal(payload.exp, Math.floor(NOW_MS / 1000) + 540);
  assert.equal(payload.exp - payload.iat, 600);
  assert.equal(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      decodeBase64Url(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    ),
    true,
  );
});

test("malformed successful credential responses reject without a secret", async () => {
  const adminSecret = "malformed-admin-secret";
  const stub = fetchSequence([
    jsonResponse({ token: "" }, 201),
    jsonResponse({ url: ACTIONS_SERVICE_URL, token: adminSecret }, 200),
  ]);
  await assert.rejects(
    fetchInstallationToken(
      { installationId: 1234, appJwt: "app-jwt" },
      services(stub.fetch),
    ),
    ScaleSetRequestError,
  );
  await assert.rejects(
    fetchActionsServiceConnection(
      {
        configUrl: "https://github.com/example-org",
        registrationToken: "registration-token",
      },
      services(stub.fetch),
    ),
    (error) => {
      assert.equal(error instanceof ScaleSetRequestError, true);
      assert.equal(error.message.includes(adminSecret), false);
      assert.equal(error.responseSnippet.includes(adminSecret), false);
      return true;
    },
  );
});
