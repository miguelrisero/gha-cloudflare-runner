import {
  runnerListPath,
  runnerPath,
} from "./scaleset-client.js";
import {
  CensusIncompleteError,
  assertCensusComplete,
  classifyDeleteCapability,
  isCensusPopulationMember,
  selectDeletions,
} from "./registration-cleanup.js";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "gha-cloudflare-runner-registration-cleanup";

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateRunOptions({
  apply,
  limit,
  expectedTargets,
  pageSize,
  pageLimit,
  minDeleteIntervalMs,
}) {
  if (typeof apply !== "boolean") {
    throw new TypeError("apply must be a boolean");
  }
  if (!nonNegativeSafeInteger(limit)) {
    throw new TypeError("limit must be a non-negative safe integer");
  }
  if (
    expectedTargets !== undefined &&
    !nonNegativeSafeInteger(expectedTargets)
  ) {
    throw new TypeError("expectedTargets must be a non-negative safe integer");
  }
  if (!positiveSafeInteger(pageSize)) {
    throw new TypeError("pageSize must be a positive safe integer");
  }
  if (!positiveSafeInteger(pageLimit)) {
    throw new TypeError("pageLimit must be a positive safe integer");
  }
  if (!nonNegativeSafeInteger(minDeleteIntervalMs)) {
    throw new TypeError(
      "minDeleteIntervalMs must be a non-negative safe integer",
    );
  }
}

function githubHeaders(githubToken) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${githubToken}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
  };
}

function scopeLabel(listPath) {
  const suffix = "/actions/runners";
  if (listPath.startsWith("/orgs/") && listPath.endsWith(suffix)) {
    return `organization:${listPath.slice(6, -suffix.length)}`;
  }
  if (listPath.startsWith("/repos/") && listPath.endsWith(suffix)) {
    return `repository:${listPath.slice(7, -suffix.length)}`;
  }
  throw new TypeError("The runner registration scope is invalid");
}

function listResponseError(status, pageNumber) {
  let message = `The runner census failed with HTTP ${status} on page ${pageNumber}.`;
  if (status === 403) {
    message += " The token needs Organization \"Self-hosted runners: Read and write\" (classic PAT: admin:org).";
  }
  return new CensusIncompleteError(message);
}

async function parseListPage(response, pageNumber) {
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new CensusIncompleteError(
      `The runner census page ${pageNumber} does not contain valid JSON.`,
      { cause: error },
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !Array.isArray(body.runners) ||
    !nonNegativeSafeInteger(body.total_count)
  ) {
    throw new CensusIncompleteError(
      `The runner census page ${pageNumber} has a malformed body.`,
    );
  }
  return body;
}

function responseOauthScopes(response) {
  let responseHeaders;
  try {
    responseHeaders = response.headers;
  } catch {
    return null;
  }
  let getHeader;
  try {
    getHeader = responseHeaders?.get;
  } catch {
    return null;
  }
  if (typeof getHeader !== "function") {
    return null;
  }
  let value;
  try {
    value = getHeader.call(responseHeaders, "x-oauth-scopes");
  } catch {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const oauthScopes = value.trim();
  return oauthScopes.length === 0 ? null : oauthScopes;
}

async function collectRunnerCensus({
  fetchService,
  githubToken,
  listPath,
  scaleSetId,
  expectedTargets,
  pageSize,
  pageLimit,
}) {
  const runners = [];
  const collectedIds = [];
  const filteredIds = [];
  const headers = githubHeaders(githubToken);
  let initialTotalCount = null;
  let latestTotalCount = null;
  let pagesFetched = 0;
  let lastPageSize = 0;
  let oauthScopes = null;

  try {
    while (pagesFetched < pageLimit) {
      const pageNumber = pagesFetched + 1;
      const url = `${GITHUB_API_URL}${listPath}?per_page=${pageSize}&page=${pageNumber}`;
      let response;
      try {
        response = await fetchService(url, { method: "GET", headers });
      } catch (error) {
        throw new CensusIncompleteError(
          `The runner census request failed on page ${pageNumber}.`,
          { cause: error },
        );
      }
      if (!response.ok) {
        throw listResponseError(response.status, pageNumber);
      }
      if (pagesFetched === 0) {
        oauthScopes = responseOauthScopes(response);
      }
      const body = await parseListPage(response, pageNumber);
      pagesFetched += 1;
      if (initialTotalCount === null) {
        initialTotalCount = body.total_count;
      }
      latestTotalCount = body.total_count;
      runners.push(...body.runners);
      for (const runner of body.runners) {
        collectedIds.push(runner?.id);
        if (isCensusPopulationMember(runner, { scaleSetId })) {
          filteredIds.push(runner.id);
        }
      }
      lastPageSize = body.runners.length;
      if (lastPageSize < pageSize) {
        break;
      }
    }

    assertCensusComplete({
      initialTotalCount,
      finalTotalCount: latestTotalCount,
      collectedIds,
      filteredIds,
      baselineFilteredCount: expectedTargets ?? null,
      pagesFetched,
      pageLimit,
      lastPageSize,
      pageSize,
    });
  } catch (error) {
    if (error instanceof Error) {
      error.census = {
        runners: [...runners],
        filteredIds: [...filteredIds],
        initialTotalCount,
        latestTotalCount,
        pagesFetched,
        oauthScopes,
      };
    }
    throw error;
  }

  const finalTotalCount = latestTotalCount;
  return {
    runners,
    filteredIds,
    initialTotalCount,
    finalTotalCount,
    removedDuringCensus: initialTotalCount - finalTotalCount,
    pagesFetched,
    oauthScopes,
    totalCount: finalTotalCount,
  };
}

function serializableClassification(classification) {
  return {
    ...classification,
    scaleSetId: typeof classification.scaleSetId === "bigint"
      ? classification.scaleSetId.toString()
      : classification.scaleSetId,
  };
}

function cleanupReport({
  label,
  apply,
  oauthScopes,
  totalRegistrations,
  initialRegistrations,
  removedDuringCensus,
  filteredRegistrations,
  expectedTargets,
  selection,
  attempted,
  deleted,
  alreadyAbsent,
  busySkipped,
  limit,
  censusPagesFetched,
  refused = false,
  provisional = false,
  refusalReason = null,
}) {
  const hasSelection = selection !== null;
  return {
    scope: label,
    apply,
    tokenScopes: oauthScopes,
    deleteCapability: classifyDeleteCapability(oauthScopes),
    refused,
    provisional,
    refusalReason,
    censusPagesFetched,
    totalRegistrations,
    initialRegistrations,
    removedDuringCensus,
    filteredRegistrations,
    expectedTargets,
    counts: hasSelection ? selection.counts : null,
    attempted,
    deleted,
    alreadyAbsent,
    busySkipped,
    remaining: hasSelection
      ? selection.counts.delete - deleted - alreadyAbsent
      : null,
    limit,
    truncatedByLimit: hasSelection
      ? selection.deletions.length > limit
      : null,
    deletions: hasSelection
      ? selection.deletions.map((deletion) => ({ ...deletion }))
      : null,
    skippedSample: hasSelection
      ? selection.skipped.slice(0, 20).map(serializableClassification)
      : null,
  };
}

function deleteFailure(message, report, cause) {
  const error = cause === undefined
    ? new Error(message)
    : new Error(message, { cause });
  error.report = report;
  return error;
}

async function nextDeleteTime({
  lastDeleteAt,
  minDeleteIntervalMs,
  now,
  sleep,
}) {
  let requestAt = now();
  if (lastDeleteAt === null) {
    return requestAt;
  }
  let waitMs = Math.max(
    0,
    lastDeleteAt + minDeleteIntervalMs - requestAt,
  );
  await sleep(waitMs);
  requestAt = now();
  while (requestAt - lastDeleteAt < minDeleteIntervalMs) {
    waitMs = lastDeleteAt + minDeleteIntervalMs - requestAt;
    await sleep(waitMs);
    requestAt = now();
  }
  return requestAt;
}

export async function runRegistrationCleanup(options, services = {}) {
  const {
    githubToken,
    scope,
    apply = false,
    limit = 250,
    scaleSetId,
    expectedTargets,
    pageSize = 100,
    pageLimit = 40,
    minDeleteIntervalMs = 1000,
  } = options ?? {};
  if (typeof githubToken !== "string" || githubToken.trim().length === 0) {
    throw new Error("A GitHub token is required");
  }
  validateRunOptions({
    apply,
    limit,
    expectedTargets,
    pageSize,
    pageLimit,
    minDeleteIntervalMs,
  });
  const fetchService = services.fetch ?? globalThis.fetch;
  const now = services.now ?? Date.now;
  const sleep = services.sleep ?? defaultSleep;
  if (typeof fetchService !== "function") {
    throw new TypeError("fetch must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  if (typeof sleep !== "function") {
    throw new TypeError("sleep must be a function");
  }

  const listPath = runnerListPath(scope);
  const label = scopeLabel(listPath);
  let census = null;
  let selection;
  try {
    census = await collectRunnerCensus({
      fetchService,
      githubToken,
      listPath,
      scaleSetId,
      expectedTargets,
      pageSize,
      pageLimit,
    });
    selection = selectDeletions(census.runners, { scaleSetId });
  } catch (error) {
    const partialCensus = census ?? (
      error instanceof Error &&
      typeof error.census === "object" &&
      error.census !== null
        ? error.census
        : null
    );
    const partialRunners = Array.isArray(partialCensus?.runners)
      ? partialCensus.runners
      : [];
    let partialSelection = null;
    try {
      partialSelection = selectDeletions(partialRunners, { scaleSetId });
    } catch {
      partialSelection = null;
    }
    const initialRegistrations = partialCensus?.initialTotalCount ?? null;
    const totalRegistrations = partialCensus?.latestTotalCount
      ?? partialCensus?.finalTotalCount
      ?? null;
    const filteredRegistrations = Array.isArray(partialCensus?.filteredIds)
      ? partialCensus.filteredIds.length
      : null;
    const removedDuringCensus = initialRegistrations === null ||
        totalRegistrations === null
      ? null
      : initialRegistrations - totalRegistrations;
    const report = cleanupReport({
      label,
      apply,
      oauthScopes: partialCensus?.oauthScopes ?? null,
      totalRegistrations,
      initialRegistrations,
      removedDuringCensus,
      filteredRegistrations,
      expectedTargets: expectedTargets ?? null,
      selection: partialSelection,
      attempted: 0,
      deleted: 0,
      alreadyAbsent: 0,
      busySkipped: 0,
      limit,
      censusPagesFetched: partialCensus?.pagesFetched ?? null,
      refused: true,
      provisional: true,
      refusalReason: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof Error) {
      error.report = report;
      throw error;
    }
    const refusalError = new Error(String(error), { cause: error });
    refusalError.report = report;
    throw refusalError;
  }
  const progress = {
    attempted: 0,
    deleted: 0,
    alreadyAbsent: 0,
    busySkipped: 0,
  };
  const makeReport = () => cleanupReport({
    label,
    apply,
    oauthScopes: census.oauthScopes,
    totalRegistrations: census.totalCount,
    initialRegistrations: census.initialTotalCount,
    removedDuringCensus: census.removedDuringCensus,
    filteredRegistrations: census.filteredIds.length,
    expectedTargets: expectedTargets ?? null,
    selection,
    ...progress,
    limit,
    censusPagesFetched: census.pagesFetched,
  });

  if (!apply) {
    return makeReport();
  }

  const headers = githubHeaders(githubToken);
  const plannedDeletions = selection.deletions.slice(0, limit);
  let lastDeleteAt = null;
  for (const deletion of plannedDeletions) {
    lastDeleteAt = await nextDeleteTime({
      lastDeleteAt,
      minDeleteIntervalMs,
      now,
      sleep,
    });
    progress.attempted += 1;
    const url = `${GITHUB_API_URL}${runnerPath(scope, deletion.runnerId)}`;
    let response;
    try {
      response = await fetchService(url, { method: "DELETE", headers });
    } catch (error) {
      throw deleteFailure(
        `The DELETE request for runner ${deletion.runnerId} failed.`,
        makeReport(),
        error,
      );
    }
    if (response.status >= 200 && response.status < 300) {
      progress.deleted += 1;
      continue;
    }
    if (response.status === 404) {
      progress.alreadyAbsent += 1;
      continue;
    }
    if (response.status === 422) {
      progress.busySkipped += 1;
      continue;
    }
    if (response.status === 403) {
      throw deleteFailure(
        `GitHub returned HTTP 403 for runner ${deletion.runnerId}. Rate limiting or a missing Organization "Self-hosted runners: Read and write" permission stopped cleanup. A classic PAT needs admin:org.`,
        makeReport(),
      );
    }
    if (response.status === 429) {
      throw deleteFailure(
        `GitHub rate limiting returned HTTP 429 for runner ${deletion.runnerId}.`,
        makeReport(),
      );
    }
    throw deleteFailure(
      `GitHub returned HTTP ${response.status} for runner ${deletion.runnerId}.`,
      makeReport(),
    );
  }
  return makeReport();
}
