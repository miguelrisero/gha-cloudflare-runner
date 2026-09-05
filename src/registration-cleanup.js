import { SCALE_UP_REQUEST_ID_BASE } from "./scaleset-protocol.js";

const LOOP_SPAWNED_RUNNER_NAME_PATTERN =
  /^cloudflare-(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/u;
const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/u;

export class CensusIncompleteError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CensusIncompleteError";
  }
}

export class RunnerRecordInvalidError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RunnerRecordInvalidError";
  }
}

function scaleSetIdOption(value) {
  if (typeof value === "bigint" && value >= 0n) {
    return value;
  }
  if (typeof value === "string" && DECIMAL_INTEGER_PATTERN.test(value)) {
    return BigInt(value);
  }
  throw new TypeError("scaleSetId must be a non-negative decimal string or bigint");
}

function assertRunnerRecord(runner) {
  if (
    typeof runner !== "object" ||
    runner === null ||
    Array.isArray(runner) ||
    !Number.isSafeInteger(runner.id) ||
    runner.id <= 0 ||
    typeof runner.name !== "string" ||
    typeof runner.busy !== "boolean"
  ) {
    throw new RunnerRecordInvalidError(
      "A runner record must have a positive safe integer id, a string name, and a boolean busy value",
    );
  }
}

export function parseLoopSpawnedRunnerName(name) {
  if (typeof name !== "string") {
    return null;
  }
  const match = LOOP_SPAWNED_RUNNER_NAME_PATTERN.exec(name);
  if (match === null) {
    return null;
  }
  const scaleSetId = BigInt(match[1]);
  const runnerRequestId = BigInt(match[2]);
  if (runnerRequestId < BigInt(SCALE_UP_REQUEST_ID_BASE)) {
    return null;
  }
  return { scaleSetId, runnerRequestId };
}

export function isLoopSpawnedRunnerName(name) {
  return parseLoopSpawnedRunnerName(name) !== null;
}

export function classifyDeleteCapability(oauthScopes) {
  if (typeof oauthScopes !== "string" || oauthScopes.trim().length === 0) {
    return "unknown-fine-grained";
  }
  const scopes = oauthScopes.split(",").map((scope) => scope.trim());
  return scopes.includes("admin:org")
    ? "proven-classic-admin-org"
    : "unproven-classic-scopes";
}

export function classifyRunner(runner, options = {}) {
  assertRunnerRecord(runner);
  const parsedName = parseLoopSpawnedRunnerName(runner.name);
  const result = {
    decision: "skip",
    reason: "not-loop-spawned",
    runnerId: runner.id,
    runnerName: runner.name,
    scaleSetId: parsedName?.scaleSetId ?? null,
  };
  if (parsedName === null) {
    return result;
  }
  if (
    options.scaleSetId !== undefined &&
    parsedName.scaleSetId !== scaleSetIdOption(options.scaleSetId)
  ) {
    return {
      ...result,
      reason: "foreign-scale-set",
      scaleSetId: parsedName.scaleSetId,
    };
  }
  if (runner.busy) {
    return {
      ...result,
      reason: "busy",
      scaleSetId: parsedName.scaleSetId,
    };
  }
  return {
    ...result,
    decision: "delete",
    reason: "loop-spawned",
    scaleSetId: parsedName.scaleSetId,
  };
}

export function selectDeletions(runners, options = {}) {
  const deletions = [];
  const skipped = [];
  const counts = {
    total: 0,
    delete: 0,
    notLoopSpawned: 0,
    foreignScaleSet: 0,
    busy: 0,
  };
  for (const runner of runners) {
    const classification = classifyRunner(runner, options);
    counts.total += 1;
    if (classification.decision === "delete") {
      counts.delete += 1;
      deletions.push({
        runnerId: classification.runnerId,
        runnerName: classification.runnerName,
      });
      continue;
    }
    skipped.push(classification);
    if (classification.reason === "not-loop-spawned") {
      counts.notLoopSpawned += 1;
    } else if (classification.reason === "foreign-scale-set") {
      counts.foreignScaleSet += 1;
    } else if (classification.reason === "busy") {
      counts.busy += 1;
    }
  }
  return { deletions, skipped, counts };
}

export function isCensusPopulationMember(runner, options = {}) {
  const classification = classifyRunner(runner, options);
  return classification.decision === "delete" || classification.reason === "busy";
}

export function assertCensusComplete({
  initialTotalCount,
  finalTotalCount,
  filteredIds,
  baselineFilteredCount,
  pagesFetched,
  pageLimit,
  lastPageSize,
  pageSize,
}) {
  if (
    !Number.isSafeInteger(initialTotalCount) ||
    initialTotalCount < 0 ||
    !Number.isSafeInteger(finalTotalCount) ||
    finalTotalCount < 0
  ) {
    throw new CensusIncompleteError(
      `The census initial total_count ${String(initialTotalCount)} and final total_count ${String(finalTotalCount)} must be non-negative safe integers.`,
    );
  }
  if (
    baselineFilteredCount !== null &&
    baselineFilteredCount !== undefined &&
    (
      !Number.isSafeInteger(baselineFilteredCount) ||
      baselineFilteredCount < 0
    )
  ) {
    throw new CensusIncompleteError(
      `The census baseline filtered count ${String(baselineFilteredCount)} must be a non-negative safe integer.`,
    );
  }
  if (pagesFetched >= pageLimit && lastPageSize === pageSize) {
    throw new CensusIncompleteError(
      `The census fetched ${pagesFetched} pages at the ${pageLimit}-page limit, and the last page contained ${lastPageSize} of ${pageSize} entries.`,
    );
  }

  // The invariants are scoped to the population this cleanup acts on, NOT to
  // the organization `total_count`. `GET /orgs/{org}/actions/runners` returns
  // every org-scoped runner, and this organization also runs an unrelated
  // ephemeral fleet that mints a new registration name on every respawn. Its
  // `total_count` therefore changes continuously. A guard on `total_count`
  // measures that fleet's health, refuses on its activity, and blocks this
  // cleanup permanently. Growth in the filtered population is the real signal:
  // it means the leak is producing again, so cleanup refuses rather than race a
  // live producer. Do not re-point these checks at `total_count`.
  //
  // A skipped record is safe. Cleanup only ever acts on a record it read and
  // classified, so a short census under-deletes and the next round collects the
  // rest. There is no server-side count of the filtered population, so the
  // lower bound has no filtered analogue. Its absence costs an accurate
  // `remaining`, never a wrong delete.
  if (
    baselineFilteredCount !== null &&
    baselineFilteredCount !== undefined &&
    filteredIds.length > baselineFilteredCount
  ) {
    throw new CensusIncompleteError(
      `The population this cleanup acts on grew from ${baselineFilteredCount} to ${filteredIds.length}. A growing population means the leak is producing again, so cleanup refuses rather than race a live producer.`,
    );
  }
  const uniqueIdCount = new Set(filteredIds).size;
  if (uniqueIdCount !== filteredIds.length) {
    throw new CensusIncompleteError(
      `The census collected ${filteredIds.length} runner ids, but only ${uniqueIdCount} ids are unique.`,
    );
  }
}
