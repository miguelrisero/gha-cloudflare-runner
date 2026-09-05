#!/usr/bin/env node

import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SANDBOX_ID_PATTERN =
  /^runner-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SANDBOX_INSTANCE_ID_PATTERN = /^[0-9a-f]{64}$/u;
const REGISTRY_STATES = new Set([
  "starting",
  "online",
  "destroying",
  "destroyed",
]);
const OPERATOR_REASONS = new Set([
  "absent-from-registry",
  "terminal-registry-row",
]);
const ROUTE_OUTCOMES = new Set([
  "destroyed",
  "invalid-request",
  "live-row",
  "observation-mismatch",
  "revision-conflict",
  "inside-grace",
  "sandbox-generation-mismatch",
  "terminal-generation-unverified",
  "claim-conflict",
  "runner-busy",
  "runner-online",
  "registration-observation-mismatch",
]);
const ROUTE_OUTCOME_HTTP_STATUS = new Map([
  ["destroyed", 200],
  ["invalid-request", 400],
  ["live-row", 409],
  ["observation-mismatch", 409],
  ["revision-conflict", 409],
  ["inside-grace", 409],
  ["sandbox-generation-mismatch", 409],
  ["terminal-generation-unverified", 409],
  ["claim-conflict", 409],
  ["runner-busy", 409],
  ["runner-online", 409],
  ["registration-observation-mismatch", 409],
]);
const REGISTRY_PAGE_SIZE = 100;
// This value matches the owner-set max_page_count in scripts/orphan-audit.sh.
const MAX_REGISTRY_PAGE_COUNT = 1000;
const GITHUB_API_VERSION = "2026-03-10";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryDirectory = dirname(dirname(scriptPath));
const auditScriptPath = fileURLToPath(
  new URL("./orphan-audit.sh", import.meta.url),
);

class OperatorDestroyError extends Error {}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new OperatorDestroyError(`${flag} requires a value`);
  }
  return value;
}

export function parseArguments(argv) {
  const parsed = { destroy: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--destroy") {
      parsed.destroy = true;
      continue;
    }
    if (
      argument === "--audit-file" ||
      argument === "--audit-report" ||
      argument === "--audit-stderr" ||
      argument === "--report"
    ) {
      const value = argumentValue(argv, index, argument);
      index += 1;
      if (argument === "--audit-file") {
        parsed.auditFile = value;
      } else if (argument === "--audit-report") {
        parsed.auditReport = value;
      } else if (argument === "--audit-stderr") {
        parsed.auditStderr = value;
      } else {
        parsed.report = value;
      }
      continue;
    }
    if (argument === "-h" || argument === "--help") {
      parsed.help = true;
      continue;
    }
    throw new OperatorDestroyError(`Unknown argument: ${argument}`);
  }
  if (
    parsed.auditFile !== undefined &&
    (parsed.auditReport !== undefined || parsed.auditStderr !== undefined)
  ) {
    throw new OperatorDestroyError(
      "--audit-report and --audit-stderr require the self-audit mode",
    );
  }
  return parsed;
}

function usage() {
  return [
    "Usage: scripts/operator-destroy-orphans.mjs [--audit-file <jsonl>] [--destroy]",
    "       [--audit-report <jsonl>] [--audit-stderr <log>] [--report <jsonl>]",
    "",
    "The command runs scripts/orphan-audit.sh --json when --audit-file is absent.",
    "The command performs live observations but sends no destroy request by default.",
  ].join("\n");
}

export function validateSandboxInstanceId(value) {
  if (
    typeof value !== "string" ||
    !SANDBOX_INSTANCE_ID_PATTERN.test(value)
  ) {
    throw new OperatorDestroyError(
      "observedSandboxInstanceId must contain exactly 64 lowercase hexadecimal characters",
    );
  }
  return value;
}

function validateSandboxId(value) {
  if (typeof value !== "string" || !SANDBOX_ID_PATTERN.test(value)) {
    throw new OperatorDestroyError(
      `The audit record has an invalid sandboxId: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function assertOperatorRouteRequiredFinding(finding) {
  if (!isPlainObject(finding) || finding.type !== "orphan") {
    throw new OperatorDestroyError("The evidence finding must be an orphan record");
  }
  if (finding.destroyResult !== "operator-route-required") {
    throw new OperatorDestroyError(
      `Refusing ${String(finding.sandboxId)} because destroyResult is not operator-route-required`,
    );
  }
  if (!OPERATOR_REASONS.has(finding.reason)) {
    throw new OperatorDestroyError(
      `Refusing ${String(finding.sandboxId)} because ${String(finding.reason)} does not use the operator destroy route`,
    );
  }
  validateSandboxId(finding.sandboxId);
  validateSandboxInstanceId(finding.instanceId);
  if (
    typeof finding.runnerName !== "string" ||
    finding.runnerName.length === 0
  ) {
    throw new OperatorDestroyError(
      `The audit record has no runnerName for ${finding.sandboxId}`,
    );
  }
  return finding;
}

export function parseJsonLines(source, sourceLabel = "audit evidence") {
  if (typeof source !== "string") {
    throw new OperatorDestroyError(`${sourceLabel} must be text`);
  }
  const records = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new OperatorDestroyError(
        `${sourceLabel} line ${index + 1} is not valid JSON`,
        { cause: error },
      );
    }
    if (!isPlainObject(record)) {
      throw new OperatorDestroyError(
        `${sourceLabel} line ${index + 1} must contain a JSON object`,
      );
    }
    records.push(record);
  }
  if (records.length === 0) {
    throw new OperatorDestroyError(`${sourceLabel} has no JSON records`);
  }
  return records;
}

function validateEvidenceSummary(records) {
  const summaries = records.filter((record) => record.type === "summary");
  if (summaries.length !== 1) {
    throw new OperatorDestroyError(
      "The audit evidence must contain exactly one summary record",
    );
  }
  const summary = summaries[0];
  const orphanCount = records.filter((record) => record.type === "orphan").length;
  const ambiguousCount = records.filter(
    (record) => record.type === "ambiguous-instance",
  ).length;
  if (!isNonNegativeSafeInteger(summary.orphanCount)) {
    throw new OperatorDestroyError("The audit summary has an invalid orphanCount");
  }
  if (summary.orphanCount !== orphanCount) {
    throw new OperatorDestroyError(
      "The audit summary orphanCount does not match the orphan records",
    );
  }
  if (!isNonNegativeSafeInteger(summary.ambiguousInstanceCount)) {
    throw new OperatorDestroyError(
      "The audit summary has an invalid ambiguousInstanceCount",
    );
  }
  if (summary.ambiguousInstanceCount !== ambiguousCount) {
    throw new OperatorDestroyError(
      "The audit summary ambiguousInstanceCount does not match the ambiguous records",
    );
  }
  if (
    !isNonNegativeSafeInteger(summary.findingCount) ||
    summary.findingCount !== orphanCount + ambiguousCount
  ) {
    throw new OperatorDestroyError(
      "The audit summary findingCount does not match the finding records",
    );
  }
  const operatorRequiredCount = records.filter(
    (record) =>
      record.type === "orphan" &&
      record.destroyResult === "operator-route-required",
  ).length;
  if (
    !isNonNegativeSafeInteger(summary.destroyOperatorRequiredCount) ||
    summary.destroyOperatorRequiredCount !== operatorRequiredCount
  ) {
    throw new OperatorDestroyError(
      "The audit summary destroyOperatorRequiredCount does not match the operator records",
    );
  }
  return summary;
}

function reportOnlyOperatorFinding(record) {
  return record.type === "orphan" &&
    record.destroyResult === "not-requested" &&
    OPERATOR_REASONS.has(record.reason);
}

export function selectOperatorFindings(records, options = {}) {
  validateEvidenceSummary(records);
  const findings = [];
  const refused = [];
  const seenSandboxIds = new Set();
  for (const record of records) {
    const fromSelfAudit = options.reportOnlyEvidence === true &&
      reportOnlyOperatorFinding(record);
    if (
      record.type !== "orphan" ||
      (record.destroyResult !== "operator-route-required" && !fromSelfAudit)
    ) {
      continue;
    }
    const finding = fromSelfAudit
      ? {
          ...record,
          auditDestroyResult: record.destroyResult,
          destroyResult: "operator-route-required",
        }
      : record;
    if (typeof finding.sandboxId === "string") {
      if (seenSandboxIds.has(finding.sandboxId)) {
        throw new OperatorDestroyError(
          `The audit evidence repeats sandbox ${finding.sandboxId}`,
        );
      }
      seenSandboxIds.add(finding.sandboxId);
    }
    try {
      assertOperatorRouteRequiredFinding(finding);
      findings.push(finding);
    } catch (error) {
      if (!(error instanceof OperatorDestroyError)) {
        throw error;
      }
      refused.push({
        type: "operator-orphan-result",
        sandboxId: finding.sandboxId ?? null,
        reason: finding.reason ?? null,
        outcome: "refused-finding",
        terminalResolution: false,
        error: error.message,
      });
    }
  }
  return { findings, refused };
}

function validateRegistryRow(row) {
  if (
    !isPlainObject(row) ||
    typeof row.sandboxId !== "string" ||
    !SANDBOX_ID_PATTERN.test(row.sandboxId) ||
    !REGISTRY_STATES.has(row.state) ||
    typeof row.createdAt !== "string" ||
    !isNonNegativeSafeInteger(row.revision) ||
    (
      row.githubRunnerName !== undefined &&
      row.githubRunnerName !== null &&
      (
        typeof row.githubRunnerName !== "string" ||
        row.githubRunnerName.length === 0
      )
    )
  ) {
    throw new OperatorDestroyError(
      `Worker returned an invalid registry row: ${JSON.stringify(row)}`,
    );
  }
  return row;
}

function validateRegistryPage(page) {
  const pageSize = page?.pageSize ?? REGISTRY_PAGE_SIZE;
  if (
    !isPlainObject(page) ||
    !Array.isArray(page.runners) ||
    !Number.isSafeInteger(pageSize) ||
    pageSize !== REGISTRY_PAGE_SIZE ||
    page.runners.length > pageSize ||
    (
      page.nextCursor !== undefined &&
      page.nextCursor !== null &&
      (
        typeof page.nextCursor !== "string" ||
        page.nextCursor.length === 0 ||
        !/^[A-Za-z0-9_=-]+$/u.test(page.nextCursor)
      )
    )
  ) {
    throw new OperatorDestroyError("Worker returned an invalid runner registry page");
  }
  return {
    rows: page.runners.map(validateRegistryRow),
    nextCursor: page.nextCursor ?? null,
  };
}

async function responseJson(response, label) {
  const responseText = await response.text();
  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw new OperatorDestroyError(`${label} returned invalid JSON`, {
      cause: error,
    });
  }
}

function workerEndpoint(workerUrl, path) {
  return `${workerUrl.replace(/\/+$/u, "")}${path}`;
}

function workerHeaders(controlToken) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${controlToken}`,
  };
}

export async function observeRegistry(options, services = {}) {
  const fetchImpl = services.fetch ?? globalThis.fetch;
  const rowsBySandbox = new Map();
  const seenCursors = new Set();
  const seenPages = new Set();
  let cursor = null;
  let pageCount = 0;

  while (true) {
    if (pageCount >= MAX_REGISTRY_PAGE_COUNT) {
      throw new OperatorDestroyError(
        "Worker runner registry page cap reached; get owner approval before changing the existing cap",
      );
    }
    pageCount += 1;
    const url = new URL(workerEndpoint(options.workerUrl, "/runners"));
    if (cursor !== null) {
      url.searchParams.set("cursor", cursor);
    }
    const response = await fetchImpl(url, {
      method: "GET",
      headers: workerHeaders(options.controlToken),
      redirect: "error",
    });
    if (!response.ok) {
      throw new OperatorDestroyError(
        `Worker runner registry listing returned HTTP ${response.status}`,
      );
    }
    const page = validateRegistryPage(
      await responseJson(response, "Worker runner registry listing"),
    );
    const pageFingerprint = JSON.stringify(
      page.rows.map((row) => JSON.stringify(row)).sort(),
    );
    if (seenPages.has(pageFingerprint)) {
      throw new OperatorDestroyError("Worker repeated a runner registry page");
    }
    seenPages.add(pageFingerprint);

    for (const row of page.rows) {
      const existing = rowsBySandbox.get(row.sandboxId);
      if (existing === undefined || row.revision > existing.revision) {
        rowsBySandbox.set(row.sandboxId, row);
      } else if (
        row.revision === existing.revision &&
        !isDeepStrictEqual(row, existing)
      ) {
        throw new OperatorDestroyError(
          `Worker returned conflicting rows for ${row.sandboxId} at revision ${row.revision}`,
        );
      }
    }

    if (page.nextCursor === null) {
      if (page.rows.length === REGISTRY_PAGE_SIZE) {
        throw new OperatorDestroyError(
          "Worker runner registry list may be truncated: a full final page had no next cursor",
        );
      }
      return rowsBySandbox;
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new OperatorDestroyError("Worker repeated a runner registry cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function githubScope(summary) {
  if (
    typeof summary.repository !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/u.test(summary.repository)
  ) {
    throw new OperatorDestroyError(
      "The audit summary repository must have the owner/repository format",
    );
  }
  if (
    typeof summary.runnerScope !== "string" ||
    summary.runnerScope.length === 0
  ) {
    throw new OperatorDestroyError("The audit summary has no runnerScope");
  }
  if (summary.runnerScope.startsWith("repository:")) {
    const repository = summary.runnerScope.slice("repository:".length);
    if (repository !== summary.repository) {
      throw new OperatorDestroyError(
        "The audit summary runnerScope does not match its repository",
      );
    }
    return {
      label: summary.runnerScope,
      path: `repos/${repository}/actions/runners`,
    };
  }
  if (summary.runnerScope.startsWith("organization:")) {
    const organization = summary.runnerScope.slice("organization:".length);
    if (
      organization.length === 0 ||
      organization.includes("/") ||
      organization.includes("*") ||
      organization.includes("..") ||
      /\s/u.test(organization)
    ) {
      throw new OperatorDestroyError(
        "The audit summary has an invalid organization runnerScope",
      );
    }
    return {
      label: summary.runnerScope,
      path: `orgs/${organization}/actions/runners`,
    };
  }
  throw new OperatorDestroyError(
    "The audit summary runnerScope must select a repository or organization",
  );
}

function validateGithubListing(body, runnerName) {
  if (
    !isPlainObject(body) ||
    !isNonNegativeSafeInteger(body.total_count) ||
    !Array.isArray(body.runners)
  ) {
    throw new OperatorDestroyError(
      `GitHub returned invalid data for runner ${runnerName}`,
    );
  }
  if (body.total_count === 0 && body.runners.length === 0) {
    return {
      outcome: "registration-not-found",
      runnerName,
    };
  }
  if (
    body.total_count !== 1 ||
    body.runners.length !== 1 ||
    !isPlainObject(body.runners[0]) ||
    !isNonNegativeSafeInteger(body.runners[0].id) ||
    body.runners[0].name !== runnerName ||
    (body.runners[0].status !== "online" &&
      body.runners[0].status !== "offline") ||
    typeof body.runners[0].busy !== "boolean"
  ) {
    throw new OperatorDestroyError(
      `GitHub returned invalid or ambiguous data for runner ${runnerName}`,
    );
  }
  return {
    outcome: "registration-found",
    runnerId: body.runners[0].id,
    runnerName,
    status: body.runners[0].status,
    busy: body.runners[0].busy,
  };
}

export async function observeGithubRegistration(
  options,
  runnerName,
  services = {},
) {
  if (typeof runnerName !== "string" || runnerName.length === 0) {
    throw new OperatorDestroyError("A runner name is required for GitHub observation");
  }
  const fetchImpl = services.fetch ?? globalThis.fetch;
  const url = new URL(`https://api.github.com/${options.githubScope.path}`);
  url.searchParams.set("name", runnerName);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.githubToken}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "gha-cloudflare-runner-operator-destroy-orphans",
    },
    redirect: "error",
  });
  if (!response.ok) {
    throw new OperatorDestroyError(
      `GitHub runner ${runnerName} observation returned HTTP ${response.status}`,
    );
  }
  return validateGithubListing(
    await responseJson(response, `GitHub runner ${runnerName} observation`),
    runnerName,
  );
}

function sandboxRunnerName(sandboxId) {
  return `cloudflare-${sandboxId.slice("runner-".length)}`;
}

function currentRunnerName(finding, registryRow) {
  if (registryRow === undefined) {
    return sandboxRunnerName(finding.sandboxId);
  }
  return finding.runnerName;
}

export function composeRequestBody({ finding, registryRow, registration }) {
  assertOperatorRouteRequiredFinding(finding);
  if (
    registration?.outcome !== "registration-found" &&
    registration?.outcome !== "registration-not-found"
  ) {
    throw new OperatorDestroyError("The GitHub registration observation is invalid");
  }
  const observedSandboxInstanceId = validateSandboxInstanceId(
    finding.instanceId,
  );
  if (registryRow === undefined) {
    const runnerName = sandboxRunnerName(finding.sandboxId);
    if (registration.runnerName !== runnerName) {
      throw new OperatorDestroyError(
        "The absent-row registration observation has the wrong runner name",
      );
    }
    return {
      observedRegistryCondition: "absent",
      expectedRevision: null,
      observedSandboxInstanceId,
      observedRegistration: registration,
    };
  }
  validateRegistryRow(registryRow);
  if (registryRow.state !== "destroyed") {
    throw new OperatorDestroyError(
      "A live Worker row cannot use the operator destroy request body",
    );
  }
  if (registration.runnerName !== currentRunnerName(finding, registryRow)) {
    throw new OperatorDestroyError(
      "The terminal-row registration observation has the wrong runner name",
    );
  }
  return {
    observedRegistryCondition: "terminal",
    expectedRevision: registryRow.revision,
    observedSandboxInstanceId,
    observedRegistration: registration,
  };
}

export function outcomeExitCode(outcome) {
  if (
    outcome === "destroyed" ||
    outcome === "dry-run" ||
    outcome === "inside-grace"
  ) {
    return 0;
  }
  if (
    ROUTE_OUTCOMES.has(outcome) ||
    outcome === "refused-finding"
  ) {
    return 1;
  }
  return 2;
}

function validateConfiguration(options) {
  let workerUrl;
  try {
    workerUrl = new URL(options.workerUrl);
  } catch (error) {
    throw new OperatorDestroyError("WORKER_URL must be a valid URL", {
      cause: error,
    });
  }
  if (workerUrl.protocol !== "https:") {
    throw new OperatorDestroyError("WORKER_URL must begin with https://");
  }
  if (
    typeof options.controlToken !== "string" ||
    options.controlToken.length < 32
  ) {
    throw new OperatorDestroyError(
      "CONTROL_TOKEN must contain at least 32 characters",
    );
  }
  if (typeof options.githubToken !== "string" || options.githubToken.length === 0) {
    throw new OperatorDestroyError("GH_TOKEN must be set");
  }
}

async function sendDestroyRequest(options, request, services) {
  const fetchImpl = services.fetch ?? globalThis.fetch;
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: {
      ...workerHeaders(options.controlToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request.body),
    redirect: "error",
  });
  const responseBody = await responseJson(response, request.url);
  if (
    !isPlainObject(responseBody) ||
    typeof responseBody.outcome !== "string" ||
    !ROUTE_OUTCOMES.has(responseBody.outcome)
  ) {
    throw new OperatorDestroyError(
      `The operator destroy route returned an unrecognized HTTP ${response.status} response`,
    );
  }
  if (ROUTE_OUTCOME_HTTP_STATUS.get(responseBody.outcome) !== response.status) {
    throw new OperatorDestroyError(
      `The operator destroy route returned outcome ${responseBody.outcome} with unexpected HTTP ${response.status}`,
    );
  }
  return {
    outcome: responseBody.outcome,
    httpStatus: response.status,
    response: responseBody,
  };
}

function operationalResult(finding, error) {
  return {
    type: "operator-orphan-result",
    sandboxId: finding.sandboxId,
    reason: finding.reason,
    outcome: "operational-error",
    terminalResolution: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function reportSummary(results, destroy, evidenceSource) {
  const exitCodes = results.map((result) => outcomeExitCode(result.outcome));
  const exitCode = exitCodes.includes(2)
    ? 2
    : exitCodes.includes(1)
      ? 1
      : 0;
  return {
    type: "operator-orphan-summary",
    destroy,
    evidenceSource,
    findingCount: results.length,
    requestCount: results.filter((result) => result.request !== undefined).length,
    sentCount: results.filter((result) => result.requestSent === true).length,
    destroyedCount: results.filter((result) => result.outcome === "destroyed").length,
    dryRunCount: results.filter((result) => result.outcome === "dry-run").length,
    insideGraceCount: results.filter(
      (result) => result.outcome === "inside-grace",
    ).length,
    actionRequiredCount: exitCodes.filter((code) => code === 1).length,
    terminalResolutionCount: results.filter(
      (result) => result.terminalResolution === true,
    ).length,
    unresolvedCount: results.filter(
      (result) => result.terminalResolution !== true,
    ).length,
    operationalFailureCount: exitCodes.filter((code) => code === 2).length,
    exitCode,
  };
}

export function formatOperatorStderr(summary) {
  const lines = [
    `Operator orphan destroy: ${summary.findingCount} finding(s), ${summary.sentCount} request(s) sent, ${summary.destroyedCount} destroyed, ${summary.unresolvedCount} unresolved, and ${summary.operationalFailureCount} operational failure(s).`,
  ];
  if (summary.insideGraceCount > 0) {
    const sandboxNoun = summary.insideGraceCount === 1
      ? "sandbox"
      : "sandboxes";
    const sandboxReference = summary.insideGraceCount === 1
      ? "this sandbox"
      : "these sandboxes";
    lines.push(
      `The orphan observation is recorded for ${summary.insideGraceCount} ${sandboxNoun}. A second destroy run after the 60-second grace window will destroy ${sandboxReference}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runOperatorDestroy(options, services = {}) {
  validateConfiguration(options);
  const summary = validateEvidenceSummary(options.records);
  const githubRunnerScope = githubScope(summary);
  const selection = selectOperatorFindings(options.records, {
    reportOnlyEvidence: options.reportOnlyEvidence,
  });
  const results = [...selection.refused];

  // Validate the complete destructive input set before any live request.
  for (const finding of selection.findings) {
    assertOperatorRouteRequiredFinding(finding);
  }

  if (selection.findings.length === 0) {
    return {
      results,
      summary: reportSummary(results, options.destroy, options.evidenceSource),
    };
  }

  const registryRows = await observeRegistry(options, services);
  for (const finding of selection.findings) {
    const registryRow = registryRows.get(finding.sandboxId);
    const runnerName = currentRunnerName(finding, registryRow);
    let registration;
    try {
      registration = await observeGithubRegistration(
        {
          githubScope: githubRunnerScope,
          githubToken: options.githubToken,
        },
        runnerName,
        services,
      );
    } catch (error) {
      results.push(operationalResult(finding, error));
      continue;
    }

    if (registryRow !== undefined && registryRow.state !== "destroyed") {
      results.push({
        type: "operator-orphan-result",
        sandboxId: finding.sandboxId,
        reason: finding.reason,
        outcome: "live-row",
        terminalResolution: false,
        liveObservation: {
          registryState: registryRow.state,
          registryRevision: registryRow.revision,
          registration,
        },
      });
      continue;
    }

    let body;
    try {
      body = composeRequestBody({ finding, registryRow, registration });
    } catch (error) {
      results.push(operationalResult(finding, error));
      continue;
    }
    const request = {
      method: "POST",
      url: workerEndpoint(
        options.workerUrl,
        `/operator/orphans/${encodeURIComponent(finding.sandboxId)}/destroy`,
      ),
      body,
    };
    if (options.destroy !== true) {
      results.push({
        type: "operator-orphan-result",
        sandboxId: finding.sandboxId,
        reason: finding.reason,
        outcome: "dry-run",
        terminalResolution: false,
        requestSent: false,
        request,
      });
      continue;
    }

    try {
      const routeResult = await sendDestroyRequest(options, request, services);
      results.push({
        type: "operator-orphan-result",
        sandboxId: finding.sandboxId,
        reason: finding.reason,
        ...routeResult,
        terminalResolution: routeResult.outcome === "destroyed",
        requestSent: true,
        request,
      });
    } catch (error) {
      results.push({
        ...operationalResult(finding, error),
        requestSent: true,
        request,
      });
    }
  }

  return {
    results,
    summary: reportSummary(results, options.destroy, options.evidenceSource),
  };
}

function runAudit(environment, services = {}) {
  const spawnImpl = services.spawn ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(auditScriptPath, ["--json"], {
      cwd: repositoryDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(new OperatorDestroyError("The orphan audit could not start", {
        cause: error,
      }));
    });
    child.on("close", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (signal !== null || (code !== 0 && code !== 1)) {
        reject(new OperatorDestroyError(
          signal === null
            ? `The report-only orphan audit exited with code ${code}`
            : `The report-only orphan audit ended with signal ${signal}`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

function reportJsonLines(report) {
  return `${[
    ...report.results,
    report.summary,
  ].map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export async function main(
  argv = process.argv.slice(2),
  environment = process.env,
  services = {},
) {
  const parsed = parseArguments(argv);
  if (parsed.help === true) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let evidenceSource;
  let evidenceText;
  let reportOnlyEvidence = false;
  if (parsed.auditFile !== undefined) {
    evidenceSource = parsed.auditFile;
    evidenceText = await readFile(parsed.auditFile, "utf8");
  } else {
    evidenceSource = "self-audit";
    const audit = await runAudit(environment, services);
    evidenceText = audit.stdout;
    reportOnlyEvidence = true;
    if (parsed.auditReport !== undefined) {
      await writeFile(parsed.auditReport, audit.stdout, "utf8");
    }
    if (parsed.auditStderr !== undefined) {
      await writeFile(parsed.auditStderr, audit.stderr, "utf8");
    } else if (audit.stderr.length > 0) {
      process.stderr.write(audit.stderr);
    }
  }

  const report = await runOperatorDestroy({
    records: parseJsonLines(evidenceText, evidenceSource),
    reportOnlyEvidence,
    evidenceSource,
    destroy: parsed.destroy,
    workerUrl: environment.WORKER_URL,
    controlToken: environment.CONTROL_TOKEN,
    githubToken:
      environment.GH_TOKEN ||
      environment.AUDIT_GITHUB_TOKEN ||
      environment.GITHUB_TOKEN,
  }, services);
  const reportText = reportJsonLines(report);
  if (parsed.report !== undefined) {
    await writeFile(parsed.report, reportText, "utf8");
  }
  process.stdout.write(reportText);
  process.stderr.write(formatOperatorStderr(report.summary));
  return report.summary.exitCode;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  });
}
