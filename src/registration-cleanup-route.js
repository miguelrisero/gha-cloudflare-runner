import { secureEqual } from "./autopilot-control.js";
import { runRegistrationCleanup } from "./registration-cleanup-engine.js";
import { CensusIncompleteError } from "./registration-cleanup.js";
import {
  GITHUB_RUNNER_LIST_PAGE_SIZE,
  REGISTRATION_CLEANUP_CENSUS_PAGE_LIMIT,
  REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL,
  REGISTRATION_CLEANUP_MIN_DELETE_INTERVAL_MS,
} from "./runner-policy.js";
import { resolveRunnerScope } from "./runner-scope.js";
import {
  isPlainObject,
  isPositiveSafeInteger,
} from "./scaleset-protocol.js";

const CLEANUP_ROUTE = "/operator/registrations/cleanup";
const CLEANUP_BODY_FIELDS = new Set([
  "apply",
  "confirm",
  "expectedTargets",
  "limit",
  "scaleSetId",
]);
const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/u;

class InvalidCleanupRequest extends Error {}

async function authenticate(request, expectedToken, services) {
  if (typeof expectedToken !== "string" || expectedToken.length < 32) {
    return false;
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const providedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  return secureEqual(providedToken, expectedToken, services);
}

async function readOptionalControlBody(request, allowedFields) {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new InvalidCleanupRequest(
      "The cleanup request body must be valid JSON",
    );
  }
  if (!isPlainObject(body)) {
    throw new InvalidCleanupRequest(
      "The cleanup request body must be a JSON object",
    );
  }
  const extraField = Object.keys(body).find(
    (field) => !allowedFields.has(field),
  );
  if (extraField !== undefined) {
    throw new InvalidCleanupRequest(`Unknown field: ${extraField}`);
  }
  return body;
}

function validateCleanupBody(body) {
  const apply = body.apply === undefined ? false : body.apply;
  if (typeof apply !== "boolean") {
    throw new InvalidCleanupRequest("apply must be a boolean");
  }

  const limit = body.limit === undefined
    ? REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL
    : body.limit;
  if (!isPositiveSafeInteger(limit)) {
    throw new InvalidCleanupRequest(
      "limit must be a positive safe integer",
    );
  }
  if (limit > REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL) {
    throw new InvalidCleanupRequest(
      `limit must not exceed ${REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL}`,
    );
  }

  const expectedTargets = body.expectedTargets;
  if (
    expectedTargets !== undefined &&
    (!Number.isSafeInteger(expectedTargets) || expectedTargets < 0)
  ) {
    throw new InvalidCleanupRequest(
      "expectedTargets must be a non-negative safe integer",
    );
  }

  const scaleSetId = body.scaleSetId;
  if (
    scaleSetId !== undefined &&
    (
      typeof scaleSetId !== "string" ||
      !DECIMAL_INTEGER_PATTERN.test(scaleSetId)
    )
  ) {
    throw new InvalidCleanupRequest(
      "scaleSetId must be a non-negative decimal string",
    );
  }

  if (apply && body.confirm !== "DELETE") {
    throw new InvalidCleanupRequest(
      "An apply run requires the literal DELETE confirmation",
    );
  }

  return { apply, expectedTargets, limit, scaleSetId };
}

function shapeReport(report, limit) {
  return {
    ...report,
    deletions: Array.isArray(report.deletions)
      ? report.deletions.slice(0, limit)
      : report.deletions,
    deleteTargets: report.counts?.delete ?? null,
    maxDeletesPerCall: REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL,
  };
}

function reportLogRecord(report) {
  return {
    route: CLEANUP_ROUTE,
    apply: report.apply,
    attempted: report.attempted,
    deleted: report.deleted,
    alreadyAbsent: report.alreadyAbsent,
    busySkipped: report.busySkipped,
    remaining: report.remaining,
    refused: report.refused,
  };
}

function platformSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function handleRegistrationCleanupRequest(
  request,
  env,
  url,
  services = {},
) {
  if (url.pathname !== CLEANUP_ROUTE) {
    return null;
  }
  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
  if (!(await authenticate(request, env.CONTROL_TOKEN, services))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input;
  try {
    const body = await readOptionalControlBody(request, CLEANUP_BODY_FIELDS);
    input = validateCleanupBody(body);
  } catch (error) {
    if (error instanceof InvalidCleanupRequest) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  if (typeof env.GITHUB_TOKEN !== "string" || env.GITHUB_TOKEN.length === 0) {
    return Response.json(
      { error: "GITHUB_TOKEN is not configured" },
      { status: 500 },
    );
  }
  if (input.apply && env.RUNNER_REGISTRATION_DELETE === "off") {
    return Response.json(
      {
        error:
          "RUNNER_REGISTRATION_DELETE is off; remove the variable to enable deletion",
      },
      { status: 409 },
    );
  }

  let scope;
  try {
    scope = resolveRunnerScope(env, env.GITHUB_REPOSITORY);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }

  const logger = services.logger ?? console;
  const fetchService = services.fetch ?? (
    (fetchInput, fetchInit) => fetch(fetchInput, fetchInit)
  );
  const now = services.now ?? Date.now;
  const sleep = services.sleep ?? platformSleep;
  try {
    const report = await runRegistrationCleanup({
      githubToken: env.GITHUB_TOKEN,
      scope,
      apply: input.apply,
      limit: input.limit,
      expectedTargets: input.expectedTargets,
      scaleSetId: input.scaleSetId,
      pageSize: GITHUB_RUNNER_LIST_PAGE_SIZE,
      pageLimit: REGISTRATION_CLEANUP_CENSUS_PAGE_LIMIT,
      minDeleteIntervalMs: REGISTRATION_CLEANUP_MIN_DELETE_INTERVAL_MS,
    }, { fetch: fetchService, now, sleep });
    const shapedReport = shapeReport(report, input.limit);
    logger.log(reportLogRecord(shapedReport));
    return Response.json(shapedReport);
  } catch (error) {
    if (error instanceof CensusIncompleteError) {
      const shapedReport = {
        ...shapeReport(error.report, input.limit),
        refused: true,
      };
      logger.log(reportLogRecord(shapedReport));
      return Response.json(shapedReport, { status: 409 });
    }
    if (
      error !== null &&
      (typeof error === "object" || typeof error === "function") &&
      isPlainObject(error.report)
    ) {
      const shapedReport = shapeReport(error.report, input.limit);
      logger.log(reportLogRecord(shapedReport));
      return Response.json(shapedReport, { status: 502 });
    }
    logger.error({
      route: CLEANUP_ROUTE,
      apply: input.apply,
      attempted: null,
      deleted: null,
      alreadyAbsent: null,
      busySkipped: null,
      remaining: null,
      refused: true,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: "Failed to clean runner registrations" },
      { status: 500 },
    );
  }
}
