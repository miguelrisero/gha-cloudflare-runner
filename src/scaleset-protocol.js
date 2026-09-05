export const SCALE_SET_ENDPOINT = "_apis/runtime/runnerscalesets";
export const RUNNER_ENDPOINT = "_apis/distributedtask/pools/0/agents";
export const SCALE_SET_MAX_CAPACITY_HEADER = "X-ScaleSetMaxCapacity";
export const SCALE_SET_API_VERSION = "6.0-preview";
export const SCALE_SET_MESSAGE_TYPE = "RunnerScaleSetJobMessages";
export const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;

// The listener allocates its own runner request identifiers for
// statistics-driven starts from this band. GitHub identifiers are Actions
// Service sequence numbers and never reach it. `quarantineReason` treats any
// inbound identifier in this band as a fatal routing-semantics violation, so
// the disjointness is enforced, not assumed.
export const SCALE_UP_REQUEST_ID_BASE = 2 ** 52;

export const MESSAGE_TYPES = Object.freeze(
  new Set(["JobAvailable", "JobAssigned", "JobStarted", "JobCompleted"]),
);

const STATISTICS_FIELDS = Object.freeze([
  "totalAvailableJobs",
  "totalAcquiredJobs",
  "totalAssignedJobs",
  "totalRunningJobs",
  "totalRegisteredRunners",
  "totalBusyRunners",
  "totalIdleRunners",
]);

const MESSAGE_GROUPS = Object.freeze({
  JobAvailable: "jobAvailable",
  JobAssigned: "jobAssigned",
  JobStarted: "jobStarted",
  JobCompleted: "jobCompleted",
});

// runnerName(scaleSetId, runnerRequestId) needs at most 44 characters: the
// 11-character prefix, two 16-digit safe integers, and one separator. Keep a
// larger input envelope because GitHub can report runner names longer than 64.
const RUNNER_NAME_MAX_LENGTH = 256;

// GitHub reports `runnerRequestId: 0` for the whole lifecycle of a job it
// never handed out through `AcquireJobs`. The field carries the acquisition
// request identifier, and a statistics-driven start never creates one, so
// every lifecycle message about such a job reads zero. Captured live on
// message 100000007 of scale set `cloudflare-sandbox`, where three
// `JobCompleted` entries for jobs that had just succeeded all read
// `"runnerRequestId": 0` while `runnerId` and `runnerName` were populated.
//
// `JobAvailable` is absent from this table on purpose. Its `runnerRequestId`
// IS the acquisition key that `AcquireJobs` consumes, so a zero there is a
// genuine routing-semantics violation and must stay fatal.
const UNACQUIRED_LIFECYCLE_REASONS = Object.freeze(
  new Map([
    ["JobAssigned", "stale-job-assignment"],
    ["JobStarted", "unassigned-job-start"],
    ["JobCompleted", "unassigned-job-completion"],
  ]),
);

// Only an exact zero is exempt. A negative identifier is malformed for every
// message type and still quarantines fatally.
function unacquiredLifecycleReason(message) {
  if (message.runnerRequestId !== 0) {
    return null;
  }
  return UNACQUIRED_LIFECYCLE_REASONS.get(message.messageType) ?? null;
}

export class ScaleSetProtocolError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidActionsServiceUrl extends ScaleSetProtocolError {}
export class UnsupportedMessageType extends ScaleSetProtocolError {
  constructor(messageType) {
    super("The Actions Service message type is not supported");
    this.messageType = messageType;
  }
}
export class MalformedMessageResponse extends ScaleSetProtocolError {}
export class MalformedAcquireResponse extends ScaleSetProtocolError {}
export class MalformedJitConfig extends ScaleSetProtocolError {}

export function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function isScaleUpRequestId(value) {
  return Number.isSafeInteger(value) && value >= SCALE_UP_REQUEST_ID_BASE;
}

export function isRepositoryName(value) {
  return typeof value === "string" && REPOSITORY_PATTERN.test(value);
}

function trimRightSlashes(value) {
  return value.replace(/\/+$/u, "");
}

function joinUrlPath(base, path) {
  if (base === "") {
    if (path === "") {
      return "";
    }
    return path.startsWith("/") ? path : `/${path}`;
  }
  if (path === "") {
    return trimRightSlashes(base);
  }
  return path.startsWith("/")
    ? `${trimRightSlashes(base)}${path}`
    : `${trimRightSlashes(base)}/${path}`;
}

function decodeQueryComponent(value) {
  return decodeURIComponent(value.replaceAll("+", " "));
}

function parsePathQuery(rawQuery) {
  const values = [];
  for (const part of rawQuery.split("&")) {
    if (part === "") {
      continue;
    }
    if (part.includes(";")) {
      throw new Error("The query contains an invalid semicolon separator");
    }
    const separator = part.indexOf("=");
    const rawKey = separator === -1 ? part : part.slice(0, separator);
    const rawValue = separator === -1 ? "" : part.slice(separator + 1);
    values.push([
      decodeQueryComponent(rawKey),
      decodeQueryComponent(rawValue),
    ]);
  }
  return values;
}

function queryEntries(query) {
  if (query === undefined || query === null) {
    return [];
  }
  if (query instanceof URLSearchParams) {
    return query.entries();
  }
  if (typeof query[Symbol.iterator] === "function") {
    return query;
  }
  if (isPlainObject(query)) {
    return Object.entries(query).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map((entry) => [key, String(entry)])
        : [[key, String(value)]],
    );
  }
  throw new TypeError("The query must contain URL query values");
}

function appendQueryValues(target, entries) {
  for (const [key, value] of entries) {
    target.append(String(key), String(value));
  }
}

export function actionsServiceRequestUrl(baseUrl, path, query) {
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch (error) {
    throw new InvalidActionsServiceUrl(
      "The Actions Service URL is invalid",
      { cause: error },
    );
  }
  if (parsedBaseUrl.protocol !== "https:") {
    throw new InvalidActionsServiceUrl(
      "The Actions Service URL must use HTTPS",
    );
  }

  let requestPath = path;
  let pathQuery = [];
  const querySeparator = path.indexOf("?");
  if (querySeparator !== -1) {
    requestPath = path.slice(0, querySeparator);
    try {
      pathQuery = parsePathQuery(path.slice(querySeparator + 1));
    } catch (error) {
      throw new ScaleSetProtocolError(
        "The Actions Service path query is invalid",
        { cause: error },
      );
    }
  }

  const requestUrl = joinUrlPath(baseUrl, requestPath);
  const requestQuery = new URLSearchParams();
  appendQueryValues(requestQuery, pathQuery);
  appendQueryValues(requestQuery, queryEntries(query));
  if (requestQuery.get("api-version") === "" ||
      requestQuery.get("api-version") === null) {
    requestQuery.set("api-version", SCALE_SET_API_VERSION);
  }
  requestQuery.sort();
  const rawQuery = requestQuery.toString();
  return rawQuery === "" ? requestUrl : `${requestUrl}?${rawQuery}`;
}

export function messageQueueRequestUrl(
  messageQueueUrl,
  { lastMessageId },
) {
  const url = new URL(messageQueueUrl);
  if (lastMessageId > 0) {
    url.searchParams.set("lastMessageId", String(lastMessageId));
  }
  return url.toString();
}

export function deleteMessageUrl(messageQueueUrl, messageId) {
  const url = new URL(messageQueueUrl);
  url.pathname = `${url.pathname}/${messageId}`;
  return url.toString();
}

function parseStatistics(statistics) {
  if (statistics === undefined || statistics === null) {
    return null;
  }
  if (!isPlainObject(statistics)) {
    throw new MalformedMessageResponse(
      "The message statistics are malformed",
    );
  }

  const parsed = {};
  for (const field of STATISTICS_FIELDS) {
    const value = statistics[field];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MalformedMessageResponse(
        "The message statistics are malformed",
      );
    }
    parsed[field] = value;
  }
  return parsed;
}

function parseBatchedMessages(body) {
  if (body === undefined || body === null || body === "") {
    return [];
  }
  if (typeof body !== "string") {
    throw new MalformedMessageResponse(
      "The batched message body is malformed",
    );
  }

  let messages;
  try {
    messages = JSON.parse(body);
  } catch (error) {
    throw new MalformedMessageResponse(
      "The batched message body is malformed",
      { cause: error },
    );
  }
  if (!Array.isArray(messages)) {
    throw new MalformedMessageResponse(
      "The batched message body is malformed",
    );
  }
  return messages;
}

function quarantineReason(message) {
  if (!isPlainObject(message)) {
    return "malformed-message";
  }
  if (!MESSAGE_TYPES.has(message.messageType)) {
    return "unknown-message-type";
  }
  if (!Number.isInteger(message.runnerRequestId)) {
    return "invalid-runner-request-id";
  }
  if (
    message.runnerRequestId <= 0 &&
    unacquiredLifecycleReason(message) === null
  ) {
    return "invalid-runner-request-id";
  }
  if (message.runnerRequestId >= Number.MAX_SAFE_INTEGER) {
    return "runner-request-id-overflow";
  }
  if (isScaleUpRequestId(message.runnerRequestId)) {
    return "reserved-runner-request-id";
  }
  if (
    typeof message.ownerName !== "string" ||
    typeof message.repositoryName !== "string"
  ) {
    return "invalid-repository-identity";
  }
  return null;
}

export function parseScaleSetMessage(payload) {
  if (!isPlainObject(payload) || !Number.isInteger(payload.messageId)) {
    throw new MalformedMessageResponse(
      "The message response envelope is malformed",
    );
  }
  if (payload.messageType !== SCALE_SET_MESSAGE_TYPE) {
    throw new UnsupportedMessageType(payload.messageType);
  }

  const result = {
    messageId: payload.messageId,
    statistics: parseStatistics(payload.statistics),
    jobAvailable: [],
    jobAssigned: [],
    jobStarted: [],
    jobCompleted: [],
    quarantined: [],
    ignored: [],
  };

  for (const message of parseBatchedMessages(payload.body)) {
    const reason = quarantineReason(message);
    if (reason !== null) {
      result.quarantined.push({
        reason,
        messageType: typeof message?.messageType === "string"
          ? message.messageType.slice(0, 64)
          : null,
      });
      continue;
    }
    const ignoredReason = unacquiredLifecycleReason(message);
    if (ignoredReason !== null) {
      result.ignored.push({
        reason: ignoredReason,
        messageType: message.messageType,
        runnerId: isPositiveSafeInteger(message.runnerId)
          ? message.runnerId
          : null,
        runnerName: nonEmptyRunnerName(message.runnerName),
      });
      continue;
    }
    result[MESSAGE_GROUPS[message.messageType]].push(message);
  }

  return result;
}

function nonEmptyRunnerName(value) {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, RUNNER_NAME_MAX_LENGTH)
    : null;
}

export function parseAcquireJobsResponse(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.value)) {
    throw new MalformedAcquireResponse(
      "The acquire-jobs response is malformed",
    );
  }
  if (
    payload.value.some(
      (requestId) => !isPositiveSafeInteger(requestId),
    )
  ) {
    throw new MalformedAcquireResponse(
      "The acquire-jobs response is malformed",
    );
  }
  return Object.freeze([...payload.value]);
}

export function parseJitRunnerConfig(payload) {
  if (
    !isPlainObject(payload) ||
    typeof payload.encodedJITConfig !== "string" ||
    payload.encodedJITConfig.length === 0 ||
    !isPlainObject(payload.runner) ||
    !Number.isSafeInteger(payload.runner.id) ||
    payload.runner.id <= 0 ||
    typeof payload.runner.name !== "string" ||
    payload.runner.name.length === 0
  ) {
    throw new MalformedJitConfig("The JIT runner configuration is malformed");
  }
  return {
    runner: payload.runner,
    encodedJITConfig: payload.encodedJITConfig,
  };
}

function headerValue(headers, name) {
  if (headers === undefined || headers === null) {
    return null;
  }
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry === undefined ? null : entry[1];
}

function nonNegativeIntegerHeader(headers, name, multiplier = 1) {
  const rawValue = headerValue(headers, name);
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  const normalized = String(rawValue).trim();
  if (!/^\d+$/u.test(normalized)) {
    return null;
  }
  const value = Number(normalized) * multiplier;
  return Number.isSafeInteger(value) ? value : null;
}

function retryAfterMilliseconds(headers, nowMs) {
  const rawValue = headerValue(headers, "Retry-After");
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  const normalized = String(rawValue).trim();
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1000;
    return Number.isSafeInteger(delayMs) ? delayMs : null;
  }
  const retryAtMs = Date.parse(normalized);
  if (!Number.isFinite(retryAtMs) || !Number.isFinite(nowMs)) {
    return null;
  }
  return Math.max(0, retryAtMs - nowMs);
}

export function parseRateLimit(headers, nowMs = Date.now()) {
  return {
    limit: nonNegativeIntegerHeader(headers, "X-RateLimit-Limit"),
    remaining: nonNegativeIntegerHeader(headers, "X-RateLimit-Remaining"),
    resetAtMs: nonNegativeIntegerHeader(
      headers,
      "X-RateLimit-Reset",
      1000,
    ),
    retryAfterMs: retryAfterMilliseconds(headers, nowMs),
  };
}
