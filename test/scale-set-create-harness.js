import { handleWorkerRequest } from "../src/worker.js";

const CLOCK_MS = 1_800_000_000_000;
const REGISTRATION_TOKEN = "literal-registration-token-secret";
const ADMIN_TOKEN =
  "stub.eyJleHAiOjgwMDAwMDAwMDB9.literal-admin-token-secret";
const ACTIONS_SERVICE_URL = "https://actions.stub.test/tenant";
const CREATED_SCALE_SET_ID = 72;
const EXISTING_SCALE_SET_ID = 71;

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function outboundBody(init) {
  if (typeof init.body !== "string" || init.body.length === 0) {
    return null;
  }
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

function requestStub(scenario, env, outboundRequests) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const authorization = headers.get("Authorization") ?? "";
    const secretValues = [
      env.GITHUB_TOKEN,
      REGISTRATION_TOKEN,
      ADMIN_TOKEN,
    ].filter((value) => typeof value === "string" && value.length > 0);
    outboundRequests.push({
      method,
      url,
      authorizationCarriesSecret: secretValues.some((secret) =>
        authorization.includes(secret)
      ),
      hasAbortSignal: init.signal instanceof AbortSignal,
      body: outboundBody(init),
    });

    const parsedUrl = new URL(url);
    if (
      parsedUrl.origin === "https://api.github.com" &&
      parsedUrl.pathname.endsWith(
        "/actions/runners/registration-token",
      )
    ) {
      if (scenario === "registration-throw") {
        throw new Error(`stub transport echoed ${env.GITHUB_TOKEN}`);
      }
      if (scenario === "registration-forbidden") {
        return jsonResponse(
          { message: `stub denied ${env.GITHUB_TOKEN}` },
          403,
        );
      }
      return jsonResponse({ token: REGISTRATION_TOKEN }, 201);
    }

    if (
      parsedUrl.origin === "https://api.github.com" &&
      parsedUrl.pathname === "/actions/runner-registration"
    ) {
      if (scenario === "handshake-failure") {
        return jsonResponse(
          { message: `stub rejected ${REGISTRATION_TOKEN}` },
          500,
        );
      }
      return jsonResponse({
        url: ACTIONS_SERVICE_URL,
        token: ADMIN_TOKEN,
      }, 200);
    }

    if (
      parsedUrl.origin === "https://actions.stub.test" &&
      parsedUrl.pathname === "/tenant/_apis/runtime/runnerscalesets"
    ) {
      const runnerGroupId = Number(parsedUrl.searchParams.get("runnerGroupId"));
      const name = parsedUrl.searchParams.get("name");
      if (method === "GET") {
        if (scenario === "lookup-failure") {
          return jsonResponse(
            { message: `stub lookup rejected ${ADMIN_TOKEN}` },
            502,
          );
        }
        return jsonResponse({
          value: scenario === "existing"
            ? [{ id: EXISTING_SCALE_SET_ID, name, runnerGroupId }]
            : [],
        }, 200);
      }
      if (method === "POST") {
        if (scenario === "create-failure") {
          return jsonResponse(
            { message: `stub create rejected ${ADMIN_TOKEN}` },
            503,
          );
        }
        if (scenario === "malformed-create") {
          return jsonResponse({ id: 0 }, 200);
        }
        return jsonResponse({ id: CREATED_SCALE_SET_ID }, 200);
      }
    }

    throw new Error(`Unexpected outbound request: ${method} ${url}`);
  };
}

function operatorRequest(specification, controlToken) {
  const method = specification.method ?? "POST";
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  if (!Object.hasOwn(specification, "authorization")) {
    headers.set("Authorization", `Bearer ${controlToken}`);
  } else if (typeof specification.authorization === "string") {
    headers.set("Authorization", specification.authorization);
  }

  let body;
  if (method !== "GET" && method !== "HEAD") {
    body = Object.hasOwn(specification, "rawBody")
      ? specification.rawBody
      : JSON.stringify(specification.body ?? {});
  }
  return new Request(
    "https://worker.stub.test/operator/scale-set/create",
    {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    },
  );
}

export default {
  async fetch(harnessRequest, env) {
    const harnessUrl = new URL(harnessRequest.url);
    if (harnessUrl.pathname !== "/harness/scale-set-create") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const specification = await harnessRequest.json();
    const routeEnv = { ...env };
    if (specification.githubToken === "missing") {
      delete routeEnv.GITHUB_TOKEN;
    } else if (specification.githubToken === "empty") {
      routeEnv.GITHUB_TOKEN = "";
    }
    const outboundRequests = [];
    const logs = [];
    const services = {
      fetch: requestStub(
        specification.scenario ?? "create",
        routeEnv,
        outboundRequests,
      ),
      now: () => CLOCK_MS,
      logger: {
        error: (value) => logs.push(String(value)),
        log: (value) => logs.push(String(value)),
      },
    };
    const request = operatorRequest(specification, routeEnv.CONTROL_TOKEN);
    const response = await handleWorkerRequest(request, routeEnv, {}, services);
    return Response.json({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
      outboundRequests,
      logs,
    });
  },
};
