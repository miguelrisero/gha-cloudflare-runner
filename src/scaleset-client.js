import {
  RUNNER_ENDPOINT,
  SCALE_SET_API_VERSION,
  SCALE_SET_ENDPOINT,
  SCALE_SET_MAX_CAPACITY_HEADER,
  actionsServiceRequestUrl,
  deleteMessageUrl,
  messageQueueRequestUrl,
  parseAcquireJobsResponse,
  parseJitRunnerConfig,
  parseRateLimit,
  parseScaleSetMessage,
} from "./scaleset-protocol.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_USER_AGENT = "gha-cloudflare-runner";
const ADMIN_TOKEN_REFRESH_WINDOW_MS = 60_000;
const RESPONSE_SNIPPET_LIMIT = 512;
const SECRET_FIELD_NAMES = Object.freeze([
  "CONTROL_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_TOKEN",
  "RUNNER_CLEANUP_TOKEN",
  "RUNNER_JITCONFIG",
  "RUNNER_TOKEN",
  "access_token",
  "adminToken",
  "admin_token",
  "appJwt",
  "app_jwt",
  "authorization",
  "cleanupToken",
  "encodedJITConfig",
  "githubToken",
  "github_token",
  "installationToken",
  "installation_token",
  "jitConfig",
  "jit_config",
  "messageQueueAccessToken",
  "message_queue_access_token",
  "privateKeyPkcs8",
  "private_key_pkcs8",
  "reconcileToken",
  "registrationToken",
  "registration_token",
  "reservationToken",
  "session_queue_token",
  "token",
]);
const SECRET_FIELD_PATTERN = SECRET_FIELD_NAMES.join("|");

function jsonValueEnd(value, start) {
  let index = start;
  while (/\s/u.test(value[index] ?? "")) {
    index += 1;
  }
  if (index >= value.length) {
    return null;
  }
  const first = value[index];
  if (first === "\"") {
    for (index += 1; index < value.length; index += 1) {
      if (value[index] === "\\") {
        index += 1;
      } else if (value[index] === "\"") {
        return index + 1;
      }
    }
    return null;
  }
  if (first === "{" || first === "[") {
    const stack = [first];
    let inString = false;
    for (index += 1; index < value.length; index += 1) {
      const character = value[index];
      if (inString) {
        if (character === "\\") {
          index += 1;
        } else if (character === "\"") {
          inString = false;
        }
        continue;
      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{" || character === "[") {
        stack.push(character);
      } else if (character === "}" || character === "]") {
        const opening = stack.pop();
        if (
          (opening === "{" && character !== "}") ||
          (opening === "[" && character !== "]")
        ) {
          return null;
        }
        if (stack.length === 0) {
          return index + 1;
        }
      }
    }
    return null;
  }
  while (index < value.length && !/[,}\]\s]/u.test(value[index])) {
    index += 1;
  }
  return index === start ? null : index;
}

function redactJsonSecretValues(value) {
  const pattern = new RegExp(
    `"(?:${SECRET_FIELD_PATTERN})"\\s*:`,
    "giu",
  );
  let cursor = 0;
  let result = "";
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    if (match.index < cursor) {
      continue;
    }
    const valueStart = match.index + match[0].length;
    const valueEnd = jsonValueEnd(value, valueStart);
    if (valueEnd === null) {
      continue;
    }
    result += value.slice(cursor, valueStart);
    result += "\"[REDACTED]\"";
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  return result + value.slice(cursor);
}

function redactSecretText(value) {
  const namedQueryPattern = new RegExp(
    `([?&](?:${SECRET_FIELD_PATTERN})=)[^&#\\s]*`,
    "giu",
  );
  const namedAssignmentPattern = new RegExp(
    `(\\b(?:${SECRET_FIELD_PATTERN})\\b\\s*[=:]\\s*)[^\\s,;}]+`,
    "giu",
  );
  return redactJsonSecretValues(String(value))
    .replace(
      /\b(Bearer|RemoteAuth)(\s+)[^\s"',;}]+/giu,
      "$1$2[REDACTED]",
    )
    .replace(namedQueryPattern, "$1[REDACTED]")
    .replace(namedAssignmentPattern, "$1[REDACTED]")
    .replace(
      /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/gu,
      "[REDACTED PRIVATE KEY]",
    );
}

function sanitizeError(error, seen = new WeakSet()) {
  if (!(error instanceof Error)) {
    return new Error(redactSecretText(error));
  }
  if (seen.has(error)) {
    return new Error("[Circular error]");
  }
  seen.add(error);
  const options = error.cause === undefined
    ? undefined
    : { cause: sanitizeError(error.cause, seen) };
  const sanitized = error instanceof AggregateError
    ? new AggregateError(
        error.errors.map((entry) => sanitizeError(entry, seen)),
        redactSecretText(error.message),
        options,
      )
    : new Error(redactSecretText(error.message), options);
  sanitized.name = error.name;
  for (const [name, entry] of Object.entries(error)) {
    if (name === "cause" || name === "errors") {
      continue;
    }
    sanitized[name] = typeof entry === "string"
      ? redactSecretText(entry)
      : entry;
  }
  seen.delete(error);
  return sanitized;
}

function errorChainText(error, seen = new WeakSet()) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (seen.has(error)) {
    return "[Circular error]";
  }
  seen.add(error);
  const parts = [`${error.name}: ${error.message}`];
  for (const field of ["status", "method", "url", "responseSnippet"]) {
    const value = error[field];
    if (
      value !== null &&
      value !== undefined &&
      (typeof value !== "string" || value.length > 0)
    ) {
      parts.push(`${field}: ${value}`);
    }
  }
  if (error instanceof AggregateError) {
    for (const entry of error.errors) {
      parts.push(`error: ${errorChainText(entry, seen)}`);
    }
  }
  if (error.cause !== undefined) {
    parts.push(`cause: ${errorChainText(error.cause, seen)}`);
  }
  seen.delete(error);
  return parts.join("\n");
}

function emptyRateLimit() {
  return {
    limit: null,
    remaining: null,
    resetAtMs: null,
    retryAfterMs: null,
  };
}

export function redactSecrets(value) {
  const source = value instanceof Error ? errorChainText(value) : value;
  return redactSecretText(source);
}

function safeSnippet(value) {
  return redactSecrets(value).slice(0, RESPONSE_SNIPPET_LIMIT);
}

function safeUrl(value) {
  return redactSecrets(value);
}

export class ScaleSetRequestError extends Error {
  constructor(
    message,
    {
      status = null,
      method = null,
      url = null,
      rateLimit = emptyRateLimit(),
      responseSnippet = "",
      cause,
    } = {},
  ) {
    super(
      redactSecretText(message),
      cause === undefined ? undefined : { cause: sanitizeError(cause) },
    );
    this.name = new.target.name;
    this.status = status;
    this.method = method;
    this.url = url === null ? null : safeUrl(url);
    this.rateLimit = rateLimit;
    this.responseSnippet = safeSnippet(responseSnippet);
  }
}

export class SessionConflictError extends ScaleSetRequestError {
  constructor(context, owner) {
    super("The runner scale set already has an active message session", context);
    this.owner = owner;
  }
}

export class MessageQueueTokenExpiredError extends ScaleSetRequestError {}
export class MessageSessionExpiredError extends ScaleSetRequestError {}
export class ScaleSetNotFoundError extends ScaleSetRequestError {}

export class RateLimitedError extends ScaleSetRequestError {
  constructor(context, pauseMs) {
    super("GitHub rate limited the scale set request", context);
    this.pauseMs = pauseMs;
  }
}

export class RequestBudgetExhausted extends ScaleSetRequestError {}

function nowFunction(services) {
  return services.now ?? Date.now;
}

function fetchFunction(services) {
  return services.fetch ?? globalThis.fetch;
}

function subtleService(services) {
  return services.subtle ?? globalThis.crypto.subtle;
}

function requestContext(method, url, response, responseText, nowMs) {
  return {
    status: response.status,
    method,
    url,
    rateLimit: parseRateLimit(response.headers, nowMs),
    responseSnippet: responseText,
  };
}

function messageFromResponse(responseText) {
  try {
    const payload = JSON.parse(responseText);
    return typeof payload?.message === "string"
      ? payload.message
      : responseText;
  } catch {
    return responseText;
  }
}

function sessionConflictOwner(responseText) {
  const message = messageFromResponse(responseText);
  const marker = "already has an active session for owner ";
  const markerIndex = message.toLowerCase().indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  const owner = message.slice(markerIndex + marker.length).trim();
  return owner === "" ? null : owner;
}

function hasScaleSetNotFoundException(responseText) {
  return responseText.includes("RunnerScaleSetNotFoundException");
}

function hasSessionExpiredException(responseText) {
  return responseText.includes("RunnerScaleSetSessionExpiredException");
}

function pauseFromRateLimit(rateLimit, nowMs) {
  if (rateLimit.retryAfterMs !== null) {
    return rateLimit.retryAfterMs;
  }
  if (rateLimit.resetAtMs !== null) {
    return Math.max(0, rateLimit.resetAtMs - nowMs);
  }
  return null;
}

export function hasRateLimitEvidence(response, responseText) {
  return response.headers.has("retry-after") ||
    response.headers.get("x-ratelimit-remaining")?.trim() === "0" ||
    /rate limit|secondary rate limit|abuse detection/iu.test(
      messageFromResponse(responseText),
    );
}

function unexpectedResponseError(
  method,
  url,
  response,
  responseText,
  nowMs,
  { sessionConflict = false, queueToken = false } = {},
) {
  const context = requestContext(
    method,
    url,
    response,
    responseText,
    nowMs,
  );
  if (
    response.status === 429 ||
    (response.status === 403 && hasRateLimitEvidence(response, responseText))
  ) {
    return new RateLimitedError(
      context,
      pauseFromRateLimit(context.rateLimit, nowMs),
    );
  }
  if (queueToken && response.status === 401) {
    return new MessageQueueTokenExpiredError(
      "The message queue access token expired",
      context,
    );
  }
  if (sessionConflict && response.status === 409) {
    return new SessionConflictError(
      context,
      sessionConflictOwner(responseText),
    );
  }
  if (
    response.status === 404 &&
    hasScaleSetNotFoundException(responseText)
  ) {
    return new ScaleSetNotFoundError(
      "GitHub did not find the runner scale set",
      context,
    );
  }
  if (hasSessionExpiredException(responseText)) {
    return new MessageSessionExpiredError(
      "GitHub expired the message session",
      context,
    );
  }
  return new ScaleSetRequestError(
    "The scale set request returned an unexpected status",
    context,
  );
}

function malformedResponseError(
  method,
  url,
  response,
  responseText,
  nowMs,
  cause,
) {
  return new ScaleSetRequestError(
    "The scale set request returned a malformed response",
    {
      ...requestContext(method, url, response, responseText, nowMs),
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

function startDeadline(deadlineMs, nowMs, method, url, externalSignal) {
  const hasDeadline = deadlineMs !== undefined;
  const remainingMs = hasDeadline ? deadlineMs - nowMs : null;
  if (hasDeadline && (!Number.isFinite(deadlineMs) || remainingMs <= 0)) {
    throw new RequestBudgetExhausted(
      "The request deadline has no remaining budget",
      { method, url },
    );
  }

  const abortController = new AbortController();
  const abortFromExternal = () => abortController.abort(externalSignal.reason);
  if (externalSignal?.aborted === true) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
  }
  const timeoutId = hasDeadline
    ? setTimeout(() => abortController.abort(), remainingMs)
    : null;
  return {
    signal: abortController.signal,
    cancel() {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      externalSignal?.removeEventListener("abort", abortFromExternal);
    },
  };
}

function isAbort(error, signal) {
  return signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError");
}

export async function issueRequest(
  url,
  init,
  services,
  { deadlineMs, signal, abortIsOutcome = false } = {},
) {
  const fetch = fetchFunction(services);
  const now = nowFunction(services);
  const method = init.method ?? "GET";
  const deadline = deadlineMs === undefined && signal === undefined
    ? null
    : startDeadline(deadlineMs, now(), method, url, signal);
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", GITHUB_USER_AGENT);
  }
  try {
    const response = await fetch(url, {
      ...init,
      headers,
      ...(deadline === null ? {} : { signal: deadline.signal }),
    });
    const responseText = (await response.text()).replace(/^\uFEFF/u, "");
    return { aborted: false, response, responseText };
  } catch (error) {
    if (abortIsOutcome && isAbort(error, deadline?.signal)) {
      return { aborted: true, response: null, responseText: "" };
    }
    throw new ScaleSetRequestError(
      "The scale set request did not complete",
      {
        method,
        url,
        cause: error,
      },
    );
  } finally {
    deadline?.cancel();
  }
}

function decodeJsonResponse(
  method,
  url,
  response,
  responseText,
  nowMs,
) {
  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw malformedResponseError(
      method,
      url,
      response,
      responseText,
      nowMs,
      error,
    );
  }
}

async function jsonRequest(
  url,
  init,
  services,
  {
    deadlineMs,
    expectedStatus,
    acceptsStatus,
    sessionConflict = false,
    queueToken = false,
  },
) {
  const method = init.method ?? "GET";
  const result = await issueRequest(url, init, services, { deadlineMs });
  const responseNowMs = nowFunction(services)();
  const accepted = acceptsStatus === undefined
    ? result.response.status === expectedStatus
    : acceptsStatus(result.response.status);
  if (!accepted) {
    throw unexpectedResponseError(
      method,
      url,
      result.response,
      result.responseText,
      responseNowMs,
      { sessionConflict, queueToken },
    );
  }
  return {
    ...result,
    payload: decodeJsonResponse(
      method,
      url,
      result.response,
      result.responseText,
      responseNowMs,
    ),
    responseNowMs,
  };
}

function base64Url(bytes) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function encodedJwtPart(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pkcs8Bytes(privateKeyPkcs8) {
  if (privateKeyPkcs8 instanceof ArrayBuffer) {
    return privateKeyPkcs8;
  }
  if (ArrayBuffer.isView(privateKeyPkcs8)) {
    return privateKeyPkcs8.buffer.slice(
      privateKeyPkcs8.byteOffset,
      privateKeyPkcs8.byteOffset + privateKeyPkcs8.byteLength,
    );
  }
  if (typeof privateKeyPkcs8 === "string") {
    const encoded = privateKeyPkcs8
      .replace(/-----BEGIN PRIVATE KEY-----/gu, "")
      .replace(/-----END PRIVATE KEY-----/gu, "")
      .replace(/\s/gu, "");
    const binary = atob(encoded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
      .buffer;
  }
  throw new TypeError("The GitHub App private key must use PKCS#8 format");
}

export async function createAppJwt(
  { appId, privateKeyPkcs8 },
  services = {},
) {
  const nowSeconds = Math.floor(nowFunction(services)() / 1000);
  const header = encodedJwtPart({ alg: "RS256", typ: "JWT" });
  const payload = encodedJwtPart({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: appId,
  });
  const signingInput = `${header}.${payload}`;
  const subtle = subtleService(services);

  let privateKey;
  try {
    privateKey = await subtle.importKey(
      "pkcs8",
      pkcs8Bytes(privateKeyPkcs8),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    throw new Error("The GitHub App private key is invalid", { cause: error });
  }

  let signature;
  try {
    signature = await subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(signingInput),
    );
  } catch (error) {
    throw new Error("The GitHub App JWT signature failed", { cause: error });
  }
  return `${signingInput}.${base64Url(signature)}`;
}

function tokenFromPayload(
  payload,
  method,
  url,
  response,
  responseText,
  nowMs,
) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof payload.token !== "string" ||
    payload.token.length === 0
  ) {
    throw malformedResponseError(
      method,
      url,
      response,
      responseText,
      nowMs,
    );
  }
  return payload.token;
}

export async function fetchInstallationToken(
  { installationId, appJwt, deadlineMs },
  services = {},
) {
  const method = "POST";
  const url = `${GITHUB_API_URL}/app/installations/${installationId}/access_tokens`;
  const result = await jsonRequest(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${appJwt}`,
        "Content-Type": "application/vnd.github+json",
      },
    },
    services,
    { deadlineMs, expectedStatus: 201 },
  );
  return tokenFromPayload(
    result.payload,
    method,
    url,
    result.response,
    result.responseText,
    result.responseNowMs,
  );
}

function runnersBasePath(scope) {
  if (typeof scope !== "object" || scope === null) {
    throw new TypeError("The runner registration scope is invalid");
  }
  const type = scope.type ?? scope.level ?? scope.kind;
  if (type === "repository") {
    let owner = scope.owner ?? scope.organization;
    let repository = scope.repository ?? scope.repo;
    if (
      owner === undefined &&
      typeof repository === "string" &&
      repository.includes("/")
    ) {
      [owner, repository] = repository.split("/", 2);
    }
    if (
      typeof owner !== "string" ||
      owner.length === 0 ||
      typeof repository !== "string" ||
      repository.length === 0
    ) {
      throw new TypeError("The repository runner scope is invalid");
    }
    return `/repos/${owner}/${repository}/actions/runners`;
  }
  if (type === "organization") {
    const organization = scope.organization ?? scope.org ?? scope.owner;
    if (typeof organization !== "string" || organization.length === 0) {
      throw new TypeError("The organization runner scope is invalid");
    }
    return `/orgs/${organization}/actions/runners`;
  }
  throw new TypeError("The runner registration scope is invalid");
}

export function runnerListPath(scope) {
  return runnersBasePath(scope);
}

export function runnerPath(scope, runnerId) {
  const basePath = runnersBasePath(scope);
  if (!Number.isSafeInteger(runnerId) || runnerId <= 0) {
    throw new TypeError("The runner identifier must be a positive safe integer");
  }
  return `${basePath}/${runnerId}`;
}

export function registrationTokenPath(scope) {
  return `${runnersBasePath(scope)}/registration-token`;
}

export async function fetchRegistrationToken(
  { scope, githubToken, deadlineMs },
  services = {},
) {
  const method = "POST";
  const url = `${GITHUB_API_URL}${registrationTokenPath(scope)}`;
  const result = await jsonRequest(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${githubToken}`,
        "Content-Type": "application/vnd.github.v3+json",
      },
    },
    services,
    { deadlineMs, expectedStatus: 201 },
  );
  return tokenFromPayload(
    result.payload,
    method,
    url,
    result.response,
    result.responseText,
    result.responseNowMs,
  );
}

function decodeBase64UrlText(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(base64 + padding);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function adminTokenExpiresAtMs(adminToken) {
  const tokenParts = adminToken.split(".");
  if (tokenParts.length !== 3) {
    throw new Error("The Actions Service admin token is malformed");
  }
  let payload;
  try {
    payload = JSON.parse(decodeBase64UrlText(tokenParts[1]));
  } catch (error) {
    throw new Error("The Actions Service admin token is malformed", {
      cause: error,
    });
  }
  const expiresAtMs = payload?.exp * 1000;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error("The Actions Service admin token has no valid expiry");
  }
  return expiresAtMs;
}

export async function fetchActionsServiceConnection(
  { configUrl, registrationToken, deadlineMs },
  services = {},
) {
  const method = "POST";
  const url = `${GITHUB_API_URL}/actions/runner-registration`;
  const result = await jsonRequest(
    url,
    {
      method,
      headers: {
        Authorization: `RemoteAuth ${registrationToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: configUrl, runner_event: "register" }),
    },
    services,
    {
      deadlineMs,
      acceptsStatus: (status) => status >= 200 && status <= 299,
    },
  );
  if (
    typeof result.payload !== "object" ||
    result.payload === null ||
    typeof result.payload.url !== "string" ||
    result.payload.url.length === 0 ||
    typeof result.payload.token !== "string" ||
    result.payload.token.length === 0
  ) {
    throw malformedResponseError(
      method,
      url,
      result.response,
      result.responseText,
      result.responseNowMs,
    );
  }

  let expiresAtMs;
  try {
    expiresAtMs = adminTokenExpiresAtMs(result.payload.token);
  } catch (error) {
    throw malformedResponseError(
      method,
      url,
      result.response,
      result.responseText,
      result.responseNowMs,
      error,
    );
  }
  return {
    actionsServiceUrl: result.payload.url,
    adminToken: result.payload.token,
    adminTokenExpiresAtMs: expiresAtMs,
  };
}

export function adminTokenNeedsRefresh(expiresAtMs, nowMs) {
  return !Number.isFinite(expiresAtMs) ||
    !Number.isFinite(nowMs) ||
    expiresAtMs - nowMs <= ADMIN_TOKEN_REFRESH_WINDOW_MS;
}

function adminHeaders(adminToken) {
  return {
    Authorization: `Bearer ${adminToken}`,
    "Content-Type": "application/json",
  };
}

function requireArrayPayload(
  payload,
  method,
  url,
  response,
  responseText,
  nowMs,
) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray(payload.value)
  ) {
    throw malformedResponseError(
      method,
      url,
      response,
      responseText,
      nowMs,
    );
  }
  return payload.value;
}

export async function getRunnerScaleSet(
  {
    actionsServiceUrl,
    adminToken,
    runnerGroupId,
    name,
    deadlineMs,
  },
  services = {},
) {
  const method = "GET";
  const url = actionsServiceRequestUrl(actionsServiceUrl, SCALE_SET_ENDPOINT, {
    runnerGroupId,
    name,
  });
  const result = await jsonRequest(
    url,
    { method, headers: adminHeaders(adminToken) },
    services,
    { deadlineMs, expectedStatus: 200 },
  );
  const scaleSets = requireArrayPayload(
    result.payload,
    method,
    url,
    result.response,
    result.responseText,
    result.responseNowMs,
  );
  return scaleSets[0] ?? null;
}

export async function createRunnerScaleSet(
  {
    actionsServiceUrl,
    adminToken,
    runnerGroupId,
    name,
    deadlineMs,
  },
  services = {},
) {
  const method = "POST";
  const url = actionsServiceRequestUrl(actionsServiceUrl, SCALE_SET_ENDPOINT);
  const result = await jsonRequest(
    url,
    {
      method,
      headers: adminHeaders(adminToken),
      body: JSON.stringify({
        name,
        runnerGroupId,
        labels: [{ type: "System", name }],
        RunnerSetting: { disableUpdate: true },
        createdOn: "0001-01-01T00:00:00Z",
      }),
    },
    services,
    { deadlineMs, expectedStatus: 200 },
  );
  if (
    typeof result.payload !== "object" ||
    result.payload === null ||
    !Number.isSafeInteger(result.payload.id) ||
    result.payload.id <= 0
  ) {
    throw malformedResponseError(
      method,
      url,
      result.response,
      result.responseText,
      result.responseNowMs,
    );
  }
  return result.payload;
}

export async function createMessageSession(
  { actionsServiceUrl, adminToken, scaleSetId, owner, deadlineMs },
  services = {},
) {
  const method = "POST";
  const url = actionsServiceRequestUrl(
    actionsServiceUrl,
    `/${SCALE_SET_ENDPOINT}/${scaleSetId}/sessions`,
  );
  const result = await jsonRequest(
    url,
    {
      method,
      headers: adminHeaders(adminToken),
      body: JSON.stringify({ ownerName: owner }),
    },
    services,
    { deadlineMs, expectedStatus: 200, sessionConflict: true },
  );
  return result.payload;
}

export async function deleteMessageSession(
  {
    actionsServiceUrl,
    adminToken,
    scaleSetId,
    sessionId,
    deadlineMs,
  },
  services = {},
) {
  const method = "DELETE";
  const url = actionsServiceRequestUrl(
    actionsServiceUrl,
    `/${SCALE_SET_ENDPOINT}/${scaleSetId}/sessions/${sessionId}`,
  );
  const result = await issueRequest(
    url,
    { method, headers: adminHeaders(adminToken) },
    services,
    { deadlineMs },
  );
  if (result.response.status === 404) {
    return "already-absent";
  }
  // GitHub answers a DELETE for a session it has already expired with
  // RunnerScaleSetSessionExpiredException. The session is gone, so the caller
  // has nothing left to reclaim and must drop its local copy, exactly as for a
  // 404. Key on the typed exception, never on the bare status: an ordinary 400
  // still reports a failure.
  if (hasSessionExpiredException(result.responseText)) {
    return "already-absent";
  }
  if (result.response.status !== 204) {
    throw unexpectedResponseError(
      method,
      url,
      result.response,
      result.responseText,
      nowFunction(services)(),
    );
  }
  return "deleted";
}

export async function refreshMessageSession(
  {
    actionsServiceUrl,
    adminToken,
    scaleSetId,
    sessionId,
    deadlineMs,
  },
  services = {},
) {
  const method = "PATCH";
  const url = actionsServiceRequestUrl(
    actionsServiceUrl,
    `/${SCALE_SET_ENDPOINT}/${scaleSetId}/sessions/${sessionId}`,
  );
  const result = await jsonRequest(
    url,
    { method, headers: adminHeaders(adminToken) },
    services,
    { deadlineMs, expectedStatus: 200 },
  );
  return result.payload;
}

export async function getMessage(
  {
    session,
    lastMessageId,
    maxCapacity,
    pollTimeoutMs,
    deadlineMs,
    signal,
  },
  services = {},
) {
  if (!Number.isInteger(maxCapacity) || maxCapacity < 0) {
    throw new RangeError("The scale set maximum capacity must be non-negative");
  }
  const method = "GET";
  const url = messageQueueRequestUrl(session.messageQueueUrl, {
    lastMessageId,
  });
  const nowMs = nowFunction(services)();
  const pollDeadlineMs = Math.min(deadlineMs, nowMs + pollTimeoutMs);
  const result = await issueRequest(
    url,
    {
      method,
      headers: {
        Accept: `application/json; api-version=${SCALE_SET_API_VERSION}`,
        Authorization: `Bearer ${session.messageQueueAccessToken}`,
        [SCALE_SET_MAX_CAPACITY_HEADER]: String(maxCapacity),
      },
    },
    services,
    { deadlineMs: pollDeadlineMs, signal, abortIsOutcome: true },
  );
  if (result.aborted) {
    return { outcome: "poll-aborted" };
  }
  if (result.response.status === 202) {
    return { outcome: "no-message" };
  }
  if (result.response.status !== 200) {
    throw unexpectedResponseError(
      method,
      url,
      result.response,
      result.responseText,
      nowFunction(services)(),
      { queueToken: true },
    );
  }
  const payload = decodeJsonResponse(
    method,
    url,
    result.response,
    result.responseText,
    nowFunction(services)(),
  );
  return { outcome: "message", message: parseScaleSetMessage(payload) };
}

export async function deleteMessage(
  { session, messageId, deadlineMs },
  services = {},
) {
  const method = "DELETE";
  const url = deleteMessageUrl(session.messageQueueUrl, messageId);
  const result = await issueRequest(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${session.messageQueueAccessToken}`,
        "Content-Type": "application/json",
      },
    },
    services,
    { deadlineMs },
  );
  if (result.response.status !== 204 && result.response.status !== 404) {
    throw unexpectedResponseError(
      method,
      url,
      result.response,
      result.responseText,
      nowFunction(services)(),
      { queueToken: true },
    );
  }
}

export async function acquireJobs(
  {
    actionsServiceUrl,
    session,
    scaleSetId,
    requestIds,
    deadlineMs,
  },
  services = {},
) {
  const method = "POST";
  const url = actionsServiceRequestUrl(
    actionsServiceUrl,
    `/${SCALE_SET_ENDPOINT}/${scaleSetId}/acquirejobs`,
  );
  const result = await jsonRequest(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${session.messageQueueAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestIds),
    },
    services,
    { deadlineMs, expectedStatus: 200, queueToken: true },
  );
  return parseAcquireJobsResponse(result.payload);
}

export async function generateJitRunnerConfig(
  {
    actionsServiceUrl,
    adminToken,
    scaleSetId,
    name,
    workFolder,
    deadlineMs,
  },
  services = {},
) {
  const method = "POST";
  const url = actionsServiceRequestUrl(
    actionsServiceUrl,
    `/${SCALE_SET_ENDPOINT}/${scaleSetId}/generatejitconfig`,
  );
  const result = await jsonRequest(
    url,
    {
      method,
      headers: adminHeaders(adminToken),
      body: JSON.stringify({ name, workFolder }),
    },
    services,
    { deadlineMs, expectedStatus: 200 },
  );
  return parseJitRunnerConfig(result.payload);
}

export async function getRunnerByName(
  { actionsServiceUrl, adminToken, name, deadlineMs },
  services = {},
) {
  const method = "GET";
  const url = actionsServiceRequestUrl(actionsServiceUrl, RUNNER_ENDPOINT, {
    agentName: name,
  });
  const result = await jsonRequest(
    url,
    { method, headers: adminHeaders(adminToken) },
    services,
    { deadlineMs, expectedStatus: 200 },
  );
  const runners = requireArrayPayload(
    result.payload,
    method,
    url,
    result.response,
    result.responseText,
    result.responseNowMs,
  );
  return runners[0] ?? null;
}

export async function removeRunner(
  { actionsServiceUrl, adminToken, runnerId, deadlineMs },
  services = {},
) {
  const method = "DELETE";
  const url = actionsServiceRequestUrl(
    actionsServiceUrl,
    `/${RUNNER_ENDPOINT}/${runnerId}`,
  );
  const result = await issueRequest(
    url,
    { method, headers: adminHeaders(adminToken) },
    services,
    { deadlineMs },
  );
  if (result.response.status === 404) {
    return "already-absent";
  }
  if (result.response.status !== 204) {
    throw unexpectedResponseError(
      method,
      url,
      result.response,
      result.responseText,
      nowFunction(services)(),
    );
  }
  return "removed";
}
