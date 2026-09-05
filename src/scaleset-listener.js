import { DurableObject } from "cloudflare:workers";

import {
  MAX_ACTIVE_RUNNERS,
  getAutopilotControl,
} from "./autopilot-control.js";
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
  redactSecrets,
  refreshMessageSession,
  removeRunner,
} from "./scaleset-client.js";
import {
  SCALE_UP_REQUEST_ID_BASE,
  isPlainObject,
  isPositiveSafeInteger,
  isRepositoryName,
} from "./scaleset-protocol.js";
import {
  ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  WORKER_SIMULTANEOUS_CONNECTION_LIMIT,
} from "./runner-policy.js";

export const ALARM_WALL_BUDGET_MS = 900_000;
export const ALARM_WORK_BUDGET_MS = 10_000;
export const POLL_TIMEOUT_MS = 50_000;
// Each concurrent in-flight dispatch chain can hold one connection. The
// listener's long poll holds one connection, so the chains use the remaining
// connections. An approved capacity above this number cannot raise it. The
// durable dispatch outbox retains excess work.
const LISTENER_CONNECTION_RESERVE = 1;
export const MAX_DISPATCH_CONCURRENCY =
  WORKER_SIMULTANEOUS_CONNECTION_LIMIT - LISTENER_CONNECTION_RESERVE;
// The learned availability limit is a further restriction on admission. It can
// only lower `admitted`; it can never raise it above MAX_DISPATCH_CONCURRENCY
// or above the shortfall.
// One admitted start is the smallest probe that can prove the platform will
// serve anything at all. A floor of one is what stops the controller latching
// at zero and stranding the pool for ever.
export const MIN_ADMISSION_LIMIT = 1;
// A raise is speculative, so it needs a run of verified deliveries, not one
// sample. Eight completed jobs provide the required evidence for each probe.
export const ADMISSION_PROBE_SUCCESSES = 8;
// A raise can happen at most once per this interval. A lowering is evidence of
// harm and is never delayed. This asymmetry is the anti-thrash damper.
export const ADMISSION_PROBE_MIN_INTERVAL_MS = 60_000;
// probe/RESULTS.md, 2026-08-27. Cloudflare serves a container start only from a
// pre-warmed pool slot. The pool floor is min(7, max_instances). The pool returns
// to the floor about two minutes after the containers exit.
export const POOL_FLOOR_INSTANCES = 7;
// probe/pool-growth.py re-derives this rate from the committed census series in
// probe/evidence. An earlier reading recorded one slot per second. That figure is
// the demand rate of the one-second ramps, not the growth the pool sustained.
// Five cold ramps refused at least a quarter of their starts, so their demand
// exceeded their supply. Those five measured 0.665, 0.678, 0.799, 0.820 and 0.837
// slots per second. The median is 0.799.
// This constant records the slowest of the five, because the guard must refuse an
// unsafe pace rather than describe a typical one. At 0.665 slots per second the
// guard puts the floor at 1,503 ms between starts.
export const POOL_GROWTH_SLOTS_PER_SECOND = 0.665;
export const POOL_DECAY_MS = 120_000;
// The start pace is the minimum interval between two issued container starts. One
// start every 3,000 ms is 0.33 starts per second, which stays below the slowest
// measured pool growth, so demand never outruns supply. The measured three-second
// standard-4 ramp admitted 57 of 60 starts. The one-second ramps admitted 17 of 28
// and 16 of 28. A pace faster than the pool growth is the defect this constant
// exists to prevent.
// A dispatch pass issues one paced start and does not await it. The delivered
// rate is min(1 / START_PACE_MS, MAX_DISPATCH_CONCURRENCY / dispatch latency).
// This is 0.333 starts per second while dispatch latency stays at or below
// 15,000 ms. probe/DISPATCH-RATE.md records the latency measurements.
export const START_PACE_MS = 3_000;
// A pool refusal proves the pool held no ready slot at that instant. The pace
// doubles for each consecutive pool refusal and returns to the base pace on the
// next admitted start. The backoff is bounded, so a refusal can never suppress
// admission: at the widest pace the listener still issues one start every
// 24,000 ms, and that start is what clears the streak.
export const MAX_PACE_BACKOFF_DOUBLINGS = 3;
export const MAX_START_PACE_MS =
  START_PACE_MS * 2 ** MAX_PACE_BACKOFF_DOUBLINGS;
// A paced poll must not spin. The clamped poll timeout never falls below this.
export const MIN_PACED_POLL_TIMEOUT_MS = 1_000;
// The pool refusal is a warm-up signal, not a ceiling. Only the account ceiling
// refusal lowers the learned admission limit.
export const POOL_WARMTH_REFUSALS = Object.freeze([
  "no-container-instance",
]);
export const ADMISSION_CEILING_REFUSALS = Object.freeze([
  "max-instances-exceeded",
]);
export const ADMISSION_CAPACITY_REFUSALS = Object.freeze([
  ...POOL_WARMTH_REFUSALS,
  ...ADMISSION_CEILING_REFUSALS,
]);

export function paceOutrunsPoolGrowth(paceMs, slotsPerSecond) {
  return paceMs * slotsPerSecond < 1_000;
}

if (paceOutrunsPoolGrowth(START_PACE_MS, POOL_GROWTH_SLOTS_PER_SECOND)) {
  throw new Error("START_PACE_MS must not outrun the measured pool growth");
}
export const RECOVERY_BASE_DELAY_MS = 2_000;
export const RECOVERY_MAX_DELAY_MS = 60_000;
export const RECOVERY_MAX_ATTEMPTS = 6;
export const RECOVERY_MAX_ELAPSED_MS = ALARM_WALL_BUDGET_MS;
export const HEARTBEAT_STALE_MS =
  POLL_TIMEOUT_MS + ALARM_WORK_BUDGET_MS;
// GitHub requeues an assigned job when a runner does not acquire it within this
// 60-second window. An over-queued dispatch fails as "deadline-exceeded"
// against this job-acquisition deadline.
export const START_DEADLINE_MS = 60_000;
// A started runner can need the full 60,000 ms START_DEADLINE_MS to appear in
// the Actions Service. This equal lower bound prevents an early absent result.
export const RUNNER_LIVENESS_PROBE_MIN_AGE_MS = START_DEADLINE_MS;
// The six-connection platform bound minus the listener reserve gives five
// dispatch slots. Reusing that count caps each pass at five sequential probes
// inside the existing 10,000 ms alarm work budget.
export const MAX_LIVENESS_PROBES_PER_PASS = MAX_DISPATCH_CONCURRENCY;
// GitHub permits at most three reassignments after the acquisition deadline.
export const MAX_REQUEST_REDELIVERIES = 3;
// The request redelivery policy already limits one request to three retries.
// Reuse that ceiling for consecutive liveness probe failures of one row.
export const MAX_LIVENESS_PROBE_ATTEMPTS = MAX_REQUEST_REDELIVERIES;
export const DRAIN_RUNNER_RECHECK_MS = 5_000;
export const MIN_RUNNERS = 0;

export const SCALE_SET_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

const ACTIVE_OUTBOX_STATES = Object.freeze([
  "pending",
  "jit-requested",
  "jit-ready",
  "reserved",
  "start-requested",
]);
const ACTIVE_OUTBOX_STATES_SQL = ACTIVE_OUTBOX_STATES
  .map((state) => `'${state}'`)
  .join(", ");
const TERMINAL_OUTBOX_STATES = Object.freeze([
  "started",
  "failed",
  "cancelled",
]);
const RECOVERY_CONDITIONS = Object.freeze([
  "session-conflict",
  "session-expired",
  "github-rate-limit",
  "scale-set-not-found",
  "alarm-failure",
]);
const RECOVERY_MARKERS = Object.freeze({
  "session-conflict": "session-reclaim-exhausted",
  "session-expired": "message-session-expired-recovery-exhausted",
  "github-rate-limit": "github-rate-recovery-exhausted",
  "scale-set-not-found": "scale-set-not-found-exhausted",
  "alarm-failure": "alarm-failure-recovery-exhausted",
});
const ALARMLESS_OUTCOMES = Object.freeze([
  "deliberately-stopped",
  "stopped-by-failure",
  "disabled",
  "kill-switch",
  "recovery-exhausted",
]);
const DELIBERATE_STOP_PREFIX = "deliberate:";
const FAILURE_STOP_PREFIX = "failure:";
const DEFAULT_WORK_FOLDER = "_work";
const RUNNER_REGISTRY_NAME = "singleton";

class InvalidListenerConfiguration extends Error {}
class RoutingSemanticsError extends Error {}
class TerminalSessionAuthenticationError extends Error {}

function nowFunction(services) {
  return services.now ?? Date.now;
}

function recoveryPauseMs(consecutive) {
  return Math.min(
    RECOVERY_BASE_DELAY_MS * (2 ** (consecutive - 1)),
    RECOVERY_MAX_DELAY_MS,
  );
}

function loggerService(services) {
  return services.logger ?? console;
}

function safeJsonParse(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function messageWithDefaults(message) {
  if (!isPlainObject(message)) {
    return message;
  }
  return {
    ...message,
    ignored: message.ignored ?? [],
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function definedNonNullFields(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) =>
      entry !== undefined && entry !== null
    ),
  );
}

function registrationScopeIsValid(scope) {
  if (!isPlainObject(scope)) {
    return false;
  }
  const type = scope.type ?? scope.level ?? scope.kind;
  if (type === "repository") {
    const owner = scope.owner ?? scope.organization;
    const repository = scope.repository ?? scope.repo;
    if (nonEmptyString(owner) && nonEmptyString(repository)) {
      return true;
    }
    if (owner !== undefined || !nonEmptyString(repository)) {
      return false;
    }
    const [derivedOwner, derivedRepository] = repository.split("/", 2);
    return nonEmptyString(derivedOwner) && nonEmptyString(derivedRepository);
  }
  if (type === "organization") {
    return nonEmptyString(
      scope.organization ?? scope.org ?? scope.owner,
    );
  }
  return false;
}

function normalizeScaleSetConfig(name, value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const scaleSetName = value.scaleSetName ?? value.name ?? name;
  if (
    !nonEmptyString(scaleSetName) ||
    !SCALE_SET_NAME_PATTERN.test(scaleSetName)
  ) {
    return null;
  }
  return { ...value, scaleSetName };
}

export function configuredScaleSet(env, requestedName = null) {
  const raw = env.AUTOPILOT_SCALE_SETS;
  if (!nonEmptyString(raw)) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    const candidates = parsed
      .map((entry) => normalizeScaleSetConfig(null, entry))
      .filter((entry) => entry !== null);
    if (requestedName !== null) {
      return candidates.find(
        (entry) => entry.scaleSetName === requestedName,
      ) ?? null;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  if (!isPlainObject(parsed)) {
    return null;
  }
  if (requestedName !== null && Object.hasOwn(parsed, requestedName)) {
    return normalizeScaleSetConfig(requestedName, parsed[requestedName]);
  }
  if (Object.hasOwn(parsed, "scaleSetName") || Object.hasOwn(parsed, "name")) {
    const candidate = normalizeScaleSetConfig(null, parsed);
    return requestedName === null || candidate?.scaleSetName === requestedName
      ? candidate
      : null;
  }
  if (requestedName === null && Object.keys(parsed).length === 1) {
    const [name, value] = Object.entries(parsed)[0];
    return normalizeScaleSetConfig(name, value);
  }
  return null;
}

export function pollTimeoutForElapsed(elapsedMs, paceWaitMs = null) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new TypeError("elapsedMs must be a non-negative finite number");
  }
  const remainingMs = ALARM_WALL_BUDGET_MS - elapsedMs;
  const base = Math.min(
    POLL_TIMEOUT_MS,
    remainingMs - ALARM_WORK_BUDGET_MS,
  );
  if (paceWaitMs === null) {
    return base;
  }
  if (!Number.isFinite(paceWaitMs) || paceWaitMs < 0) {
    throw new TypeError("paceWaitMs must be a non-negative finite number");
  }
  return Math.min(
    base,
    Math.max(MIN_PACED_POLL_TIMEOUT_MS, paceWaitMs),
  );
}

export function desiredRunnerCount({
  maxRunners,
  minRunners,
  assignedJobs,
  unownedIdleRunners = 0,
}) {
  const inputs = [
    maxRunners,
    minRunners,
    assignedJobs,
    unownedIdleRunners,
  ];
  if (inputs.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(
      "Runner count inputs must be non-negative safe integers",
    );
  }
  return Math.min(
    maxRunners,
    minRunners + Math.max(0, assignedJobs - unownedIdleRunners),
  );
}

function resolveIdleRunnerCount(statistics) {
  if (
    Number.isSafeInteger(statistics?.totalIdleRunners) &&
    statistics.totalIdleRunners >= 0
  ) {
    return statistics.totalIdleRunners;
  }
  if (
    Number.isSafeInteger(statistics?.totalRegisteredRunners) &&
    statistics.totalRegisteredRunners >= 0 &&
    Number.isSafeInteger(statistics?.totalBusyRunners) &&
    statistics.totalBusyRunners >= 0
  ) {
    const derivedIdleRunners = statistics.totalRegisteredRunners -
      statistics.totalBusyRunners;
    if (derivedIdleRunners >= 0) {
      return derivedIdleRunners;
    }
  }
  return null;
}

export function runnerCorrelationId(
  scaleSetId,
  runnerRequestId,
  redelivery = 0,
) {
  if (!isPositiveSafeInteger(scaleSetId)) {
    throw new TypeError("scaleSetId must be a positive safe integer");
  }
  if (!isPositiveSafeInteger(runnerRequestId)) {
    throw new TypeError("runnerRequestId must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(redelivery) ||
    redelivery < 0 ||
    redelivery > MAX_REQUEST_REDELIVERIES
  ) {
    throw new TypeError(
      `redelivery must be a safe integer between 0 and ${MAX_REQUEST_REDELIVERIES}`,
    );
  }
  if (redelivery > 0) {
    return `scale-set:${scaleSetId}:rr${redelivery}:${runnerRequestId}`;
  }
  return `scale-set:${scaleSetId}:runner-request:${runnerRequestId}`;
}

export function runnerName(scaleSetId, runnerRequestId) {
  return `cloudflare-${scaleSetId}-${runnerRequestId}`;
}

export function isSqliteFullError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_FULL|database or disk is full/iu.test(message);
}

function stateSession(state) {
  if (
    !nonEmptyString(state.session_id) ||
    !nonEmptyString(state.session_queue_url) ||
    !nonEmptyString(state.session_queue_token)
  ) {
    return null;
  }
  return {
    sessionId: state.session_id,
    messageQueueUrl: state.session_queue_url,
    messageQueueAccessToken: state.session_queue_token,
  };
}

function publicStoppedReason(value) {
  if (!nonEmptyString(value)) {
    return null;
  }
  if (value.startsWith(DELIBERATE_STOP_PREFIX)) {
    return value.slice(DELIBERATE_STOP_PREFIX.length);
  }
  if (value.startsWith(FAILURE_STOP_PREFIX)) {
    return value.slice(FAILURE_STOP_PREFIX.length);
  }
  return value;
}

function deliberatelyStopped(state) {
  return state.mode === "stopped" &&
    state.stopped_reason?.startsWith(DELIBERATE_STOP_PREFIX) === true;
}

function recoveryConditionForError(error) {
  if (error instanceof MessageSessionExpiredError) {
    return "session-expired";
  }
  if (error instanceof RateLimitedError) {
    return "github-rate-limit";
  }
  if (error instanceof ScaleSetNotFoundError) {
    return "scale-set-not-found";
  }
  return null;
}

function ambiguousExternalResult(error) {
  if (error instanceof RequestBudgetExhausted) {
    return false;
  }
  return error instanceof ScaleSetRequestError &&
    (error.status === null || error.status >= 500);
}

// A start throw carries the only evidence of how far the request got, and
// #issueStart collapses every throw into one reason. RequestBudgetExhausted is
// raised by #fetchWithDeadline before the POST leaves the Worker, so it proves
// no start was ever issued; an abort proves the request was sent and then cut
// off at min(workDeadlineMs, requestDeadlineMs). This classifies for the
// reconcile record only. No branch reads it, so the dispatch behaviour is
// unchanged.
function startFailureClass(error) {
  if (error instanceof RequestBudgetExhausted) {
    return "budget-exhausted";
  }
  if (error?.name === "AbortError") {
    return "aborted";
  }
  return "request-failed";
}

function runnerIsBusy(value) {
  return value?.busy === true || value?.status === "busy";
}

function requestRepository(message) {
  const repository = `${message.ownerName}/${message.repositoryName}`;
  return isRepositoryName(repository) ? repository : null;
}

function requestWorkflow(message) {
  const workflow = {
    runId: message.workflowRunId ?? message.runId ?? null,
    runAttempt: message.runAttempt ?? null,
    jobId: message.jobId ?? null,
  };
  return Object.values(workflow).every((value) => value === null)
    ? null
    : workflow;
}

function isExactRepositoryName(repository) {
  const firstSlash = repository.indexOf("/");
  return isRepositoryName(repository) &&
    !repository.includes("*") &&
    !repository.includes("..") &&
    firstSlash !== -1 &&
    firstSlash === repository.lastIndexOf("/");
}

// Keep these parsing rules identical to normalizeRepositoryAllowlist in
// worker.js. The listener cannot import worker.js because worker.js imports the
// listener Durable Object.
function scaleUpRepositoryAllowlist(env) {
  const configured = env.GITHUB_REPOSITORY_ALLOWLIST;
  let entries;
  if (configured === undefined || configured === null) {
    entries = [];
  } else if (Array.isArray(configured)) {
    entries = configured;
  } else if (typeof configured === "string") {
    entries = configured.split(/[,\n]/u);
  } else {
    throw new Error("The repository allow-list configuration is invalid");
  }

  const repositories = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      throw new Error("The repository allow-list entry is invalid");
    }
    const repository = entry.trim();
    if (repository.length > 0) {
      repositories.push(repository);
    }
  }

  if (repositories.length === 0 && typeof env.GITHUB_REPOSITORY === "string") {
    const fallbackRepository = env.GITHUB_REPOSITORY.trim();
    if (fallbackRepository.length > 0) {
      repositories.push(fallbackRepository);
    }
  }
  if (repositories.length === 0) {
    throw new Error("The repository allow-list is empty");
  }
  if (repositories.some((repository) => !isExactRepositoryName(repository))) {
    throw new Error("The repository allow-list entry is invalid");
  }
  return repositories;
}

function sessionPayloadIsValid(session) {
  return isPlainObject(session) &&
    nonEmptyString(session.sessionId) &&
    nonEmptyString(session.messageQueueUrl) &&
    nonEmptyString(session.messageQueueAccessToken);
}

function adminConnectionIsValid(connection) {
  return isPlainObject(connection) &&
    nonEmptyString(connection.actionsServiceUrl) &&
    nonEmptyString(connection.adminToken) &&
    isPositiveSafeInteger(connection.adminTokenExpiresAtMs);
}

function safeErrorMessage(error) {
  return redactSecrets(error);
}

export class ScaleSetListener extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.activePollController = null;
    this.adminConnectionRefresh = null;
    this.inFlightOperations = new Set();
    this.dispatchInFlight = new Map();
    this.dispatchFailures = [];
    this.heldSecretValues = new Set();
    this.lastScaleUpDecision = null;
    this.consecutiveAlarmRecoveryRearms = 0;
    this.#holdSecretValues(
      env.CONTROL_TOKEN,
      env.GITHUB_APP_PRIVATE_KEY,
      env.GITHUB_TOKEN,
      env.RUNNER_CLEANUP_TOKEN,
      env.RUNNER_TOKEN,
    );
    ctx.blockConcurrencyWhile(async () => this.#initializeSchema());
  }

  #initializeSchema() {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS listener_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          scale_set_id INTEGER,
          scale_set_name TEXT,
          runner_group_id INTEGER,
          owner TEXT,
          session_id TEXT,
          session_queue_url TEXT,
          session_queue_token TEXT,
          session_created_at_ms INTEGER,
          last_message_id INTEGER NOT NULL DEFAULT 0,
          latest_statistics TEXT,
          scale_up_sequence INTEGER NOT NULL DEFAULT 0,
          last_scale_up_decision TEXT,
          last_scale_up_decision_at_ms INTEGER,
          admission_limit INTEGER,
          admission_success_streak INTEGER NOT NULL DEFAULT 0,
          admission_limit_changed_at_ms INTEGER,
          admission_limited INTEGER NOT NULL DEFAULT 0,
          last_start_issued_at_ms INTEGER,
          pace_refusal_streak INTEGER NOT NULL DEFAULT 0,
          last_start_gate_refusal TEXT,
          last_start_gate_refusal_at_ms INTEGER,
          last_start_gate_closed_reason TEXT,
          last_start_gate_closed_at_ms INTEGER,
          alarm_generation INTEGER NOT NULL DEFAULT 0,
          heartbeat_at_ms INTEGER,
          heartbeat_generation INTEGER,
          heartbeat_cursor INTEGER,
          admin_token TEXT,
          admin_token_expires_at_ms INTEGER,
          actions_service_url TEXT,
          mode TEXT NOT NULL DEFAULT 'running' CHECK (
            mode IN ('running', 'drained', 'stopped')
          ),
          stopped_reason TEXT,
          sqlite_full INTEGER NOT NULL DEFAULT 0 CHECK (sqlite_full IN (0, 1))
        )
      `);
      const stateColumns = new Set(
        this.sql.exec("PRAGMA table_info(listener_state)").toArray().map(
          (column) => column.name,
        ),
      );
      if (!stateColumns.has("scale_up_sequence")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN scale_up_sequence INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!stateColumns.has("last_scale_up_decision")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN last_scale_up_decision TEXT",
        );
      }
      if (!stateColumns.has("last_scale_up_decision_at_ms")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN last_scale_up_decision_at_ms INTEGER",
        );
      }
      if (!stateColumns.has("admission_limit")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN admission_limit INTEGER",
        );
      }
      if (!stateColumns.has("admission_success_streak")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN admission_success_streak INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!stateColumns.has("admission_limit_changed_at_ms")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN admission_limit_changed_at_ms INTEGER",
        );
      }
      if (!stateColumns.has("admission_limited")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN admission_limited INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!stateColumns.has("last_start_issued_at_ms")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN last_start_issued_at_ms INTEGER",
        );
      }
      if (!stateColumns.has("pace_refusal_streak")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN pace_refusal_streak INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!stateColumns.has("last_start_gate_refusal")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN last_start_gate_refusal TEXT",
        );
      }
      if (!stateColumns.has("last_start_gate_refusal_at_ms")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN last_start_gate_refusal_at_ms INTEGER",
        );
      }
      if (!stateColumns.has("last_start_gate_closed_reason")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN last_start_gate_closed_reason TEXT",
        );
      }
      if (!stateColumns.has("last_start_gate_closed_at_ms")) {
        this.sql.exec(
          "ALTER TABLE listener_state ADD COLUMN last_start_gate_closed_at_ms INTEGER",
        );
      }
      this.sql.exec(`
        INSERT OR IGNORE INTO listener_state (
          singleton,
          last_message_id,
          alarm_generation,
          mode,
          sqlite_full
        ) VALUES (1, 0, 0, 'running', 0)
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS inbox (
          message_id INTEGER PRIMARY KEY,
          received_at_ms INTEGER NOT NULL,
          payload TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('stored', 'acknowledged', 'quarantined')
          ),
          quarantine_reason TEXT
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS acquisition_intents (
          runner_request_id INTEGER PRIMARY KEY,
          message_id INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN (
              'intended',
              'granted',
              'not-granted',
              'ambiguous',
              'cancelled'
            )
          ),
          attempts INTEGER NOT NULL DEFAULT 0,
          redeliveries INTEGER NOT NULL DEFAULT 0,
          recorded_at_ms INTEGER NOT NULL
        )
      `);
      const intentColumns = new Set(
        this.sql.exec("PRAGMA table_info(acquisition_intents)").toArray().map(
          (column) => column.name,
        ),
      );
      if (!intentColumns.has("redeliveries")) {
        this.sql.exec(
          "ALTER TABLE acquisition_intents ADD COLUMN redeliveries INTEGER NOT NULL DEFAULT 0",
        );
      }
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS acquisition_intents_message
          ON acquisition_intents (message_id, state)
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS dispatch_outbox (
          runner_request_id INTEGER PRIMARY KEY,
          state TEXT NOT NULL CHECK (
            state IN (
              'pending',
              'jit-requested',
              'jit-ready',
              'reserved',
              'start-requested',
              'started',
              'failed',
              'cancelled'
            )
          ),
          runner_name TEXT,
          runner_id INTEGER,
          correlation_id TEXT NOT NULL,
          repository TEXT NOT NULL,
          wave TEXT NOT NULL,
          reservation_id TEXT,
          reservation_released_at_ms INTEGER,
          settle_checked_at_ms INTEGER,
          spawn_observed INTEGER NOT NULL DEFAULT 0,
          jit_config TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          liveness_probe_attempts INTEGER NOT NULL DEFAULT 0,
          liveness_probed_at_ms INTEGER,
          undelivered_checked_at_ms INTEGER,
          last_error TEXT,
          intent_recorded_at_ms INTEGER,
          updated_at_ms INTEGER NOT NULL
        )
      `);
      const outboxColumns = new Set(
        this.sql.exec("PRAGMA table_info(dispatch_outbox)").toArray().map(
          (column) => column.name,
        ),
      );
      if (!outboxColumns.has("reservation_released_at_ms")) {
        this.sql.exec(
          "ALTER TABLE dispatch_outbox ADD COLUMN reservation_released_at_ms INTEGER",
        );
      }
      if (!outboxColumns.has("settle_checked_at_ms")) {
        this.sql.exec(
          "ALTER TABLE dispatch_outbox ADD COLUMN settle_checked_at_ms INTEGER",
        );
        // Do not backfill historical rows. NULL means never checked, so COALESCE
        // puts each historical row at the head once. Unlike spawn_observed, the
        // safe default here is to check the row.
      }
      if (!outboxColumns.has("spawn_observed")) {
        this.sql.exec(
          "ALTER TABLE dispatch_outbox ADD COLUMN spawn_observed INTEGER NOT NULL DEFAULT 0",
        );
        // A row that predates this column carries no observation either way. Assume it
        // was delivered. This control can only lower admission, so the safe default is
        // the one that cannot throttle. Adding the column without this backfill marked
        // every historical row as never-spawned and throttled production to one runner.
        this.sql.exec("UPDATE dispatch_outbox SET spawn_observed = 1");
      }
      if (!outboxColumns.has("intent_recorded_at_ms")) {
        this.sql.exec(
          "ALTER TABLE dispatch_outbox ADD COLUMN intent_recorded_at_ms INTEGER",
        );
      }
      if (!outboxColumns.has("liveness_probe_attempts")) {
        this.sql.exec(
          "ALTER TABLE dispatch_outbox ADD COLUMN liveness_probe_attempts INTEGER NOT NULL DEFAULT 0",
        );
      }
      if (!outboxColumns.has("liveness_probed_at_ms")) {
        this.sql.exec(
          "ALTER TABLE dispatch_outbox ADD COLUMN liveness_probed_at_ms INTEGER",
        );
        // This release changes the counter to consecutive failures, so values
        // from the old meaning are stale. A failing row re-earns the ceiling
        // within MAX_LIVENESS_PROBE_ATTEMPTS passes after this one-time reset.
        this.sql.exec(
          "UPDATE dispatch_outbox SET liveness_probe_attempts = 0",
        );
      }
      if (!outboxColumns.has("undelivered_checked_at_ms")) {
        this.sql.exec(
          "ALTER TABLE dispatch_outbox ADD COLUMN undelivered_checked_at_ms INTEGER",
        );
      }
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS dispatch_outbox_state
          ON dispatch_outbox (state, updated_at_ms)
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS cancellations (
          runner_request_id INTEGER PRIMARY KEY,
          recorded_at_ms INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS recovery (
          condition TEXT PRIMARY KEY CHECK (
            condition IN (
              'session-conflict',
              'session-expired',
              'github-rate-limit',
              'scale-set-not-found',
              'alarm-failure'
            )
          ),
          first_failure_at_ms INTEGER NOT NULL,
          attempts INTEGER NOT NULL,
          next_attempt_at_ms INTEGER NOT NULL,
          exhausted_marker TEXT
        )
      `);
      const recoveryTable = this.sql.exec(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table' AND name = 'recovery'`,
      ).toArray()[0];
      if (!recoveryTable.sql.includes("'session-expired'")) {
        this.sql.exec(`
          CREATE TABLE recovery_with_session_expired (
            condition TEXT PRIMARY KEY CHECK (
              condition IN (
                'session-conflict',
                'session-expired',
                'github-rate-limit',
                'scale-set-not-found',
                'alarm-failure'
              )
            ),
            first_failure_at_ms INTEGER NOT NULL,
            attempts INTEGER NOT NULL,
            next_attempt_at_ms INTEGER NOT NULL,
            exhausted_marker TEXT
          )
        `);
        this.sql.exec(`
          INSERT INTO recovery_with_session_expired
          SELECT * FROM recovery
        `);
        this.sql.exec("DROP TABLE recovery");
        this.sql.exec(
          "ALTER TABLE recovery_with_session_expired RENAME TO recovery",
        );
      }
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS export_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          state TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS export_outbox_state
          ON export_outbox (state, id)
      `);
    });
  }

  #listenerState() {
    const rows = this.sql.exec("SELECT * FROM listener_state WHERE singleton = 1")
      .toArray();
    if (rows.length !== 1) {
      throw new Error("The scale set listener state is unavailable");
    }
    return rows[0];
  }

  #admissionState() {
    const state = this.#listenerState();
    return {
      // Invalid stored limits stay unrestricted until a refusal relearns one.
      limit: Number.isSafeInteger(state.admission_limit) &&
          state.admission_limit >= 0
        ? state.admission_limit
        : null,
      successStreak:
        Number.isSafeInteger(state.admission_success_streak) &&
          state.admission_success_streak >= 0
          ? state.admission_success_streak
          : 0,
      changedAtMs:
        Number.isSafeInteger(state.admission_limit_changed_at_ms) &&
          state.admission_limit_changed_at_ms >= 0
          ? state.admission_limit_changed_at_ms
          : null,
    };
  }

  #paceState() {
    const state = this.#listenerState();
    const lastStartIssuedAtMs =
      Number.isSafeInteger(state.last_start_issued_at_ms) &&
        state.last_start_issued_at_ms >= 0
        ? state.last_start_issued_at_ms
        : null;
    const refusalStreak =
      Number.isSafeInteger(state.pace_refusal_streak) &&
        state.pace_refusal_streak >= 0
        ? state.pace_refusal_streak
        : 0;
    const paceMs = Math.min(
      MAX_START_PACE_MS,
      START_PACE_MS * 2 ** Math.min(
        refusalStreak,
        MAX_PACE_BACKOFF_DOUBLINGS,
      ),
    );
    return { lastStartIssuedAtMs, refusalStreak, paceMs };
  }

  #pacePermits(nowMs) {
    const pace = this.#paceState();
    const sinceLastStartMs = pace.lastStartIssuedAtMs === null
      ? null
      : nowMs - pace.lastStartIssuedAtMs;
    const permitted = pace.lastStartIssuedAtMs === null ||
        sinceLastStartMs >= pace.paceMs
      ? 1
      : 0;
    const waitMs = pace.lastStartIssuedAtMs === null
      ? 0
      : Math.max(
        0,
        pace.lastStartIssuedAtMs + pace.paceMs - nowMs,
      );
    return {
      permitted,
      waitMs,
      paceMs: pace.paceMs,
      sinceLastStartMs,
    };
  }

  #recordStartIssued(nowMs) {
    this.sql.exec(
      `UPDATE listener_state
       SET last_start_issued_at_ms = ?
       WHERE singleton = 1`,
      nowMs,
    );
  }

  #recordPoolRefusal(row, startFailureReason, services) {
    const previous = this.#paceState();
    const refusalStreak = Math.min(
      previous.refusalStreak + 1,
      MAX_PACE_BACKOFF_DOUBLINGS,
    );
    const paceMs = Math.min(
      MAX_START_PACE_MS,
      START_PACE_MS * 2 ** refusalStreak,
    );
    this.sql.exec(
      `UPDATE listener_state
       SET pace_refusal_streak = ?
       WHERE singleton = 1`,
      refusalStreak,
    );
    this.#emit("start-pace-widened", {
      paceMs,
      previousPaceMs: previous.paceMs,
      refusalStreak,
      startFailureReason,
      runnerRequestId: row.runner_request_id,
      registryCorrelation: row.correlation_id,
      repository: row.repository,
      wave: row.wave,
    }, services);
  }

  #clearPaceBackoff(services) {
    const previous = this.#paceState();
    if (previous.refusalStreak === 0) {
      return;
    }
    this.sql.exec(
      `UPDATE listener_state
       SET pace_refusal_streak = 0
       WHERE singleton = 1`,
    );
    this.#emit("start-pace-restored", {
      paceMs: START_PACE_MS,
      previousPaceMs: previous.paceMs,
      previousRefusalStreak: previous.refusalStreak,
    }, services);
  }

  #neverSpawnedCensus(services) {
    const nowMs = nowFunction(services)();
    // This window is ACTIVE_RUNNER_CLEANUP_DELAY_MS, which is one hour. It spans
    // many bursts. It is a retention bound, not a burst scope.
    const recencyFloorMs = nowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS;
    // A row inside its start deadline is pending, not failed. Load-bearing.
    const deadlineCutoffMs = nowMs - START_DEADLINE_MS;
    // A never-spawned row needs evidence, not the absence of it. An unprobed row
    // says nothing about delivery, and counting it read "we have not looked" as
    // "it failed".
    // The probe stamps liveness_probed_at_ms and increments the attempt counter
    // before it calls the registry, and resets the counter to zero only when the
    // call returns. A stamp with a zero counter is therefore a probe that
    // answered. A stamp with a positive counter is a probe that threw, which is
    // no more evidence of failure than never having looked.
    // A released row counts only when it spawned. A completed job releases its
    // reservation, so an observed spawn is the evidence of delivery this census
    // exists to count, and excluding it drained every success out of the
    // denominator while a failing straggler stayed. The population then skewed
    // toward failures until contending approached never_spawned and the limit
    // ratcheted to the floor.
    // The spawn_observed test is load-bearing. Settling a reservation past the
    // backstop rewrites updated_at_ms, so a settled failure re-enters this
    // window; without this test it would be counted as a delivery.
    const row = this.sql.exec(
      `SELECT
         COUNT(*) AS contending,
         SUM(CASE WHEN state = 'started' AND spawn_observed = 0
                   AND liveness_probed_at_ms IS NOT NULL
                   AND liveness_probe_attempts = 0
                   AND updated_at_ms <= ? THEN 1 ELSE 0 END) AS never_spawned
       FROM dispatch_outbox
       WHERE state IN ('reserved', 'start-requested', 'started')
         AND (reservation_released_at_ms IS NULL OR spawn_observed = 1)
         AND updated_at_ms > ?`,
      deadlineCutoffMs,
      recencyFloorMs,
    ).toArray()[0];
    return {
      contending: Number.isFinite(row?.contending) ? row.contending : 0,
      neverSpawned: Number.isFinite(row?.never_spawned)
        ? row.never_spawned
        : 0,
    };
  }

  #observeNeverSpawnedCensus({ contending, neverSpawned }, services) {
    if (neverSpawned <= 0) {
      return;
    }
    const current = this.#admissionState().limit;
    // Delivered starts are the rows in the window that are not never-spawned.
    // This floor prevents a latch at zero and always leaves one delivery probe.
    const delivered = Math.max(
      MIN_ADMISSION_LIMIT,
      contending - neverSpawned,
    );
    // Math.min makes this observation lowering-only.
    const nextLimit = current === null
      ? delivered
      : Math.min(current, delivered);
    if (nextLimit === current) {
      // Every never-spawned observation invalidates earlier success evidence.
      this.sql.exec(
        `UPDATE listener_state
         SET admission_success_streak = 0
         WHERE singleton = 1`,
      );
      return;
    }
    const nowMs = nowFunction(services)();
    this.sql.exec(
      `UPDATE listener_state
       SET admission_limit = ?,
           admission_success_streak = 0,
           admission_limit_changed_at_ms = ?
       WHERE singleton = 1`,
      nextLimit,
      nowMs,
    );
    this.#emit("admission-limit-lowered", {
      admissionLimit: nextLimit,
      previousLimit: current,
      contendingCount: contending,
      neverSpawnedCount: neverSpawned,
      deliveredStarts: delivered,
      reason: "reserved-never-spawned",
    }, services);
  }

  #bindScaleSetName(scaleSetName) {
    if (scaleSetName === undefined || scaleSetName === null) {
      return this.#listenerState();
    }
    if (
      typeof scaleSetName !== "string" ||
      !SCALE_SET_NAME_PATTERN.test(scaleSetName)
    ) {
      throw new TypeError("scaleSetName is invalid");
    }
    const current = this.#listenerState();
    if (
      current.scale_set_name !== null &&
      current.scale_set_name !== scaleSetName
    ) {
      throw new Error("The listener already belongs to another scale set");
    }
    this.sql.exec(
      `UPDATE listener_state
       SET scale_set_name = COALESCE(scale_set_name, ?)
       WHERE singleton = 1`,
      scaleSetName,
    );
    return this.#listenerState();
  }

  #configuration(services, state = this.#listenerState()) {
    const supplied = typeof services.config === "function"
      ? services.config(state.scale_set_name)
      : services.config;
    const candidate = supplied === undefined
      ? configuredScaleSet(this.env, state.scale_set_name)
      : normalizeScaleSetConfig(state.scale_set_name, supplied);
    if (
      candidate === null ||
      (state.scale_set_name !== null &&
        candidate.scaleSetName !== state.scale_set_name)
    ) {
      return null;
    }
    return candidate;
  }

  #enabled(services) {
    return services.enabled ?? this.env.AUTOPILOT_ENABLED === "1";
  }

  #alarmService(services) {
    return {
      set: services.setAlarm ?? ((atMs) => this.ctx.storage.setAlarm(atMs)),
      delete: services.deleteAlarm ?? (() => this.ctx.storage.deleteAlarm()),
      get: services.getAlarm ?? (() => this.ctx.storage.getAlarm()),
    };
  }

  async #entryRearm(handlerStartMs, services) {
    const rows = this.sql.exec(
      `UPDATE listener_state
       SET alarm_generation = alarm_generation + 1
       WHERE singleton = 1
       RETURNING alarm_generation`,
    ).toArray();
    if (rows.length !== 1) {
      throw new Error("The alarm generation was not persisted");
    }
    const generation = rows[0].alarm_generation;
    await this.#alarmService(services).set(handlerStartMs);
    await services.afterEntryRearm?.({ generation, handlerStartMs });
    return generation;
  }

  #track(operation) {
    const promise = Promise.resolve(operation);
    this.inFlightOperations.add(promise);
    return promise.finally(() => this.inFlightOperations.delete(promise));
  }

  async #waitForInFlight() {
    while (this.inFlightOperations.size > 0) {
      await Promise.allSettled([...this.inFlightOperations]);
    }
  }

  // A chain launched by a dispatch pass outlives that pass. The alarm awaits its
  // chains before it returns, so a chain is never abandoned at handoff. Each
  // chain is bounded by its own min(workDeadlineMs, requestDeadlineMs).
  async #drainDispatchChains() {
    while (this.dispatchInFlight.size > 0) {
      await Promise.allSettled([...this.dispatchInFlight.values()]);
    }
  }

  #holdSecretValues(...values) {
    for (const value of values) {
      if (nonEmptyString(value)) {
        this.heldSecretValues.add(value);
      }
    }
  }

  #secretValues(extraValues = []) {
    const state = this.#listenerState();
    this.#holdSecretValues(
      state.session_queue_token,
      state.admin_token,
      ...extraValues,
    );
    for (const row of this.sql.exec(
      "SELECT jit_config FROM dispatch_outbox WHERE jit_config IS NOT NULL",
    ).toArray()) {
      this.#holdSecretValues(row.jit_config);
    }
    return [...this.heldSecretValues];
  }

  #safeRecord(record, extraSecrets = []) {
    let serialized = redactSecrets(JSON.stringify(record));
    for (const secret of this.#secretValues(extraSecrets)) {
      serialized = serialized.replaceAll(secret, "[REDACTED]");
    }
    return serialized;
  }

  #logWithoutPersistence(event, fields, services, level = "error") {
    let correlations = {};
    try {
      correlations = this.#correlations(fields);
    } catch {
      // The fallback logger must stay available when the database fails.
    }
    let serialized = redactSecrets(JSON.stringify({
      source: "ScaleSetListener",
      event,
      createdAtMs: nowFunction(services)(),
      ...correlations,
      ...fields,
    }));
    for (const secret of this.heldSecretValues) {
      serialized = serialized.replaceAll(secret, "[REDACTED]");
    }
    try {
      const logger = loggerService(services);
      const write = typeof logger[level] === "function"
        ? logger[level]
        : logger.log;
      write.call(logger, serialized);
    } catch {
      // A logger failure must not discard a scheduled alarm.
    }
  }

  #correlations(fields = {}) {
    const state = this.#listenerState();
    return {
      scaleSet: state.scale_set_name,
      scaleSetId: state.scale_set_id,
      sessionId: state.session_id,
      messageId: fields.messageId ?? null,
      runnerRequestId: fields.runnerRequestId ?? null,
      registryCorrelation: fields.registryCorrelation ?? null,
      sandboxId: fields.sandboxId ?? null,
      runnerId: fields.runnerId ?? null,
      runnerName: fields.runnerName ?? null,
      workflow: fields.workflow ?? null,
      wave: fields.wave ?? null,
    };
  }

  #emit(event, fields, services, extraSecrets = []) {
    const createdAtMs = nowFunction(services)();
    const record = {
      source: "ScaleSetListener",
      event,
      createdAtMs,
      ...this.#correlations(fields),
      ...fields,
    };
    const serialized = this.#safeRecord(record, extraSecrets);
    this.sql.exec(
      `INSERT INTO export_outbox (record, created_at_ms, state)
       VALUES (?, ?, 'pending')`,
      serialized,
      createdAtMs,
    );
    loggerService(services).log(serialized);
  }

  #emitScaleUpDecision(event, fields, services) {
    const digest = JSON.stringify({ event, ...fields });
    if (this.lastScaleUpDecision?.[event] === digest) {
      return;
    }
    this.#emit(event, fields, services);
    this.lastScaleUpDecision = {
      ...(this.lastScaleUpDecision ?? {}),
      [event]: digest,
    };
  }

  #recordScaleUpDecision(
    reason,
    fields,
    services,
    event = null,
    eventFields = fields,
  ) {
    const recordedAtMs = nowFunction(services)();
    const decision = { reason, ...fields };
    this.sql.exec(
      `UPDATE listener_state
       SET last_scale_up_decision = ?,
           last_scale_up_decision_at_ms = ?
       WHERE singleton = 1`,
      JSON.stringify(decision),
      recordedAtMs,
    );
    if (event !== null) {
      this.#emitScaleUpDecision(event, eventFields, services);
    }
  }

  #persistHeartbeat(generation, services) {
    const nowMs = nowFunction(services)();
    const state = this.#listenerState();
    this.sql.exec(
      `UPDATE listener_state
       SET heartbeat_at_ms = ?,
           heartbeat_generation = ?,
           heartbeat_cursor = ?
       WHERE singleton = 1`,
      nowMs,
      generation,
      state.last_message_id,
    );
    this.#emit(
      "listener-heartbeat",
      { alarmGeneration: generation, cursor: state.last_message_id },
      services,
    );
  }

  #persistIdentity(config, scaleSetId = null) {
    const runnerGroupId = config.runnerGroupId ?? null;
    const owner = config.owner ?? config.organization ?? null;
    this.sql.exec(
      `UPDATE listener_state
       SET scale_set_id = COALESCE(?, scale_set_id),
           scale_set_name = COALESCE(scale_set_name, ?),
           runner_group_id = COALESCE(?, runner_group_id),
           owner = COALESCE(?, owner)
       WHERE singleton = 1`,
      scaleSetId,
      config.scaleSetName,
      runnerGroupId,
      owner,
    );
  }

  #persistAdminConnection(connection) {
    if (!adminConnectionIsValid(connection)) {
      throw new InvalidListenerConfiguration(
        "The Actions Service connection is invalid",
      );
    }
    this.#holdSecretValues(connection.adminToken);
    this.sql.exec(
      `UPDATE listener_state
       SET actions_service_url = ?,
           admin_token = ?,
           admin_token_expires_at_ms = ?
       WHERE singleton = 1`,
      connection.actionsServiceUrl,
      connection.adminToken,
      connection.adminTokenExpiresAtMs,
    );
  }

  #persistSession(session, createdAtMs, statistics) {
    if (!sessionPayloadIsValid(session)) {
      throw new InvalidListenerConfiguration(
        "The message session response is invalid",
      );
    }
    this.#holdSecretValues(session.messageQueueAccessToken);
    const statisticsJson = statistics === undefined || statistics === null
      ? null
      : JSON.stringify(statistics);
    this.sql.exec(
      `UPDATE listener_state
       SET session_id = ?,
           session_queue_url = ?,
           session_queue_token = ?,
           session_created_at_ms = COALESCE(session_created_at_ms, ?),
           latest_statistics = COALESCE(?, latest_statistics)
       WHERE singleton = 1`,
      session.sessionId,
      session.messageQueueUrl,
      session.messageQueueAccessToken,
      createdAtMs,
      statisticsJson,
    );
  }

  #persistCreatedSessionIdentity(session, createdAtMs) {
    if (!isPlainObject(session) || !nonEmptyString(session.sessionId)) {
      throw new InvalidListenerConfiguration(
        "The message session response has no session identifier",
      );
    }
    this.sql.exec(
      `UPDATE listener_state
       SET session_id = ?,
           session_created_at_ms = COALESCE(session_created_at_ms, ?)
       WHERE singleton = 1`,
      session.sessionId,
      createdAtMs,
    );
  }

  #clearSession() {
    this.sql.exec(
      `UPDATE listener_state
       SET session_id = NULL,
           session_queue_url = NULL,
           session_queue_token = NULL,
           session_created_at_ms = NULL
       WHERE singleton = 1`,
    );
  }

  async #ensureAdminConnection(config, deadlineMs, services) {
    this.#holdSecretValues(
      config.adminToken,
      config.githubToken,
      config.privateKeyPkcs8,
    );
    const state = this.#listenerState();
    if (
      nonEmptyString(state.actions_service_url) &&
      nonEmptyString(state.admin_token) &&
      !adminTokenNeedsRefresh(
        state.admin_token_expires_at_ms,
        nowFunction(services)(),
      )
    ) {
      return {
        actionsServiceUrl: state.actions_service_url,
        adminToken: state.admin_token,
        adminTokenExpiresAtMs: state.admin_token_expires_at_ms,
      };
    }

    if (this.adminConnectionRefresh === null) {
      const refresh = this.#refreshAdminConnection(
        config,
        deadlineMs,
        services,
      );
      const pending = refresh.finally(() => {
        if (this.adminConnectionRefresh === pending) {
          this.adminConnectionRefresh = null;
        }
      });
      this.adminConnectionRefresh = pending;
    }
    return this.adminConnectionRefresh;
  }

  async #refreshAdminConnection(config, deadlineMs, services) {
    let connection;
    if (services.refreshAdminConnection !== undefined) {
      connection = await services.refreshAdminConnection({
        config,
        deadlineMs,
      });
    } else {
      // Resolve a usable static trio first, complete GitHub App credentials
      // second, GITHUB_TOKEN third, or report a configuration error. The
      // static trio costs no API calls while it remains usable. The App is
      // long-lived and least-privilege, so it outranks a broad PAT.
      const staticTrioPresent =
        nonEmptyString(config.actionsServiceUrl) &&
        nonEmptyString(config.adminToken) &&
        isPositiveSafeInteger(config.adminTokenExpiresAtMs);
      const nowMs = nowFunction(services)();
      const staticTokenNeedsRefresh = staticTrioPresent &&
        adminTokenNeedsRefresh(config.adminTokenExpiresAtMs, nowMs);
      if (staticTrioPresent && !staticTokenNeedsRefresh) {
        connection = {
          actionsServiceUrl: config.actionsServiceUrl,
          adminToken: config.adminToken,
          adminTokenExpiresAtMs: config.adminTokenExpiresAtMs,
        };
      } else {
        const appId = config.appId ?? this.env.GITHUB_APP_ID;
        const privateKeyPkcs8 =
          config.privateKeyPkcs8 ?? this.env.GITHUB_APP_PRIVATE_KEY;
        const installationId =
          config.installationId ?? this.env.GITHUB_APP_INSTALLATION_ID;
        const scope = config.scope ?? (
          nonEmptyString(config.repository)
            ? { type: "repository", repository: config.repository }
            : { type: "organization", organization: config.owner }
        );
        const scopeType = scope?.type ?? scope?.level ?? scope?.kind;
        const configUrl = config.configUrl ?? (
          scopeType === "repository" && nonEmptyString(config.repository)
            ? `https://github.com/${config.repository}`
            : scopeType === "organization" && nonEmptyString(config.owner)
              ? `https://github.com/${config.owner}`
              : null
        );
        if (!registrationScopeIsValid(scope) || !nonEmptyString(configUrl)) {
          throw new InvalidListenerConfiguration(
            "Set repository, owner, or scope to a valid runner registration " +
              "scope, and set configUrl or a matching repository or owner.",
          );
        }
        const appCredentialsPresent =
          nonEmptyString(String(appId ?? "")) &&
          nonEmptyString(privateKeyPkcs8) &&
          nonEmptyString(String(installationId ?? ""));
        const configuredGithubToken =
          config.githubToken ?? this.env.GITHUB_TOKEN;
        this.#holdSecretValues(configuredGithubToken);
        let registrationGithubToken;
        let usingConfiguredGithubToken = false;
        if (appCredentialsPresent) {
          const clientServices = services.clientServices ?? {};
          const appJwt = await (
            services.createAppJwt ?? createAppJwt
          )({ appId, privateKeyPkcs8 }, clientServices);
          this.#holdSecretValues(appJwt);
          const installationToken = await (
            services.fetchInstallationToken ?? fetchInstallationToken
          )({ installationId, appJwt, deadlineMs }, clientServices);
          this.#holdSecretValues(installationToken);
          registrationGithubToken = installationToken;
        } else if (nonEmptyString(configuredGithubToken)) {
          registrationGithubToken = configuredGithubToken;
          usingConfiguredGithubToken = true;
        } else {
          const tokenPermission = scope.type === "repository"
            ? "For a repository-scoped runner, GITHUB_TOKEN needs the " +
              "classic PAT/OAuth `repo` scope or the fine-grained PAT " +
              "`Administration: write` permission on the repository."
            : "For an organization-scoped runner, GITHUB_TOKEN needs the " +
              "classic PAT/OAuth `admin:org` scope, plus `repo` when the " +
              "repository is private.";
          if (staticTokenNeedsRefresh) {
            const expiresAt = new Date(
              config.adminTokenExpiresAtMs,
            ).toISOString();
            const timing = config.adminTokenExpiresAtMs <= nowMs
              ? "expired"
              : "expires too soon";
            throw new InvalidListenerConfiguration(
              `The configured Actions Service admin token ${timing} at ` +
                `${expiresAt}; configure a GitHub App (appId, ` +
                "privateKeyPkcs8, installationId) or a GITHUB_TOKEN for " +
                `sustained operation. ${tokenPermission}`,
            );
          }
          throw new InvalidListenerConfiguration(
            "The listener has no way to mint an Actions Service admin " +
              "connection. Configure a GitHub App (appId, privateKeyPkcs8, " +
              `installationId) or a GITHUB_TOKEN. ${tokenPermission}`,
          );
        }
        const clientServices = services.clientServices ?? {};
        let registrationToken;
        try {
          registrationToken = await (
            services.fetchRegistrationToken ?? fetchRegistrationToken
          )({
            scope,
            githubToken: registrationGithubToken,
            deadlineMs,
          }, clientServices);
        } catch (error) {
          if (
            usingConfiguredGithubToken &&
            !(error instanceof RateLimitedError) &&
            error instanceof ScaleSetRequestError &&
            (error.status === 401 || error.status === 403)
          ) {
            const requiredPermission = scope.type === "repository"
              ? "the classic PAT/OAuth `repo` scope or the fine-grained PAT " +
                "`Administration: write` permission on the repository"
              : "the classic PAT/OAuth `admin:org` scope, plus `repo` when " +
                "the repository is private";
            const responseSnippet = error.responseSnippet.trim();
            throw new InvalidListenerConfiguration(
              [
                "Minting a runner registration token failed.",
                `Method: ${error.method ?? "unknown"}`,
                `URL: ${error.url ?? "unknown"}`,
                `HTTP status: ${error.status}`,
                ...(responseSnippet === ""
                  ? []
                  : [`Response: ${responseSnippet}`]),
                "Possible cause: the GITHUB_TOKEN lacks " +
                  `${requiredPermission}.`,
              ].join("\n"),
              { cause: error },
            );
          }
          throw error;
        }
        this.#holdSecretValues(registrationToken);
        connection = await (
          services.fetchActionsServiceConnection ??
            fetchActionsServiceConnection
        )({ configUrl, registrationToken, deadlineMs }, clientServices);
      }
    }

    this.#persistAdminConnection(connection);
    this.#emit("admin-token-refreshed", {}, services);
    return connection;
  }

  async #ensureScaleSet(config, connection, deadlineMs, services) {
    const state = this.#listenerState();
    if (isPositiveSafeInteger(state.scale_set_id)) {
      return state.scale_set_id;
    }
    if (isPositiveSafeInteger(config.scaleSetId)) {
      this.#persistIdentity(config, config.scaleSetId);
      return config.scaleSetId;
    }
    if (!isPositiveSafeInteger(config.runnerGroupId)) {
      throw new InvalidListenerConfiguration(
        "runnerGroupId must be a positive safe integer",
      );
    }
    const scaleSet = await (
      services.getRunnerScaleSet ?? getRunnerScaleSet
    )(
      {
        actionsServiceUrl: connection.actionsServiceUrl,
        adminToken: connection.adminToken,
        runnerGroupId: config.runnerGroupId,
        name: config.scaleSetName,
        deadlineMs,
      },
      services.clientServices ?? {},
    );
    if (scaleSet === null) {
      throw new ScaleSetNotFoundError(
        "GitHub did not find the configured runner scale set",
      );
    }
    if (
      !isPlainObject(scaleSet) ||
      !isPositiveSafeInteger(scaleSet.id) ||
      scaleSet.name !== config.scaleSetName
    ) {
      throw new InvalidListenerConfiguration(
        "The configured runner scale set response is invalid",
      );
    }
    this.#persistIdentity(config, scaleSet.id);
    this.#clearRecovery("scale-set-not-found");
    return scaleSet.id;
  }

  // Resolve the credentials that reclaim a persisted session. The Actions
  // Service rejects an expired admin token as anonymous access, so a teardown
  // that reuses the persisted token alone answers 401 and never reclaims
  // anything. Route through #ensureAdminConnection, which already applies the
  // expiry check and already shares the single in-flight refresh promise, and
  // return its URL and token as one pair.
  //
  // A refresh failure falls back to the persisted credentials and never
  // throws. Teardown runs on the operator paths (resume, stop) and on the
  // shutdown paths (kill switch, drain, routing quarantine), and none of them
  // may gain a new way to fail.
  async #teardownAdminConnection(state, deadlineMs, services) {
    const persisted = {
      actionsServiceUrl: state.actions_service_url,
      adminToken: state.admin_token,
    };
    const config = this.#configuration(services);
    if (config === null) {
      return persisted;
    }
    try {
      const connection = await this.#ensureAdminConnection(
        config,
        deadlineMs,
        services,
      );
      return adminConnectionIsValid(connection) ? connection : persisted;
    } catch (error) {
      // The logger, not #emit: #emit persists the record and can itself throw
      // on a full database, which would defeat the point of this catch.
      loggerService(services).error(this.#safeRecord({
        source: "ScaleSetListener",
        event: "session-delete-token-refresh-failed",
        error: safeErrorMessage(error),
        ...this.#correlations(),
      }));
      return persisted;
    }
  }

  async #deletePersistedSession(reason, deadlineMs, services) {
    const state = this.#listenerState();
    if (!nonEmptyString(state.session_id)) {
      return { deleted: false, result: "not-present" };
    }
    if (
      !isPositiveSafeInteger(state.scale_set_id) ||
      !nonEmptyString(state.actions_service_url) ||
      !nonEmptyString(state.admin_token)
    ) {
      throw new Error("The persisted session cannot be reclaimed safely");
    }
    const connection = await this.#teardownAdminConnection(
      state,
      deadlineMs,
      services,
    );
    const result = await (
      services.deleteMessageSession ?? deleteMessageSession
    )(
      {
        actionsServiceUrl: connection.actionsServiceUrl,
        adminToken: connection.adminToken,
        scaleSetId: state.scale_set_id,
        sessionId: state.session_id,
        deadlineMs,
      },
      services.clientServices ?? {},
    );
    this.#clearSession();
    this.#emit(
      "message-session-deleted",
      { reason, deletionResult: result },
      services,
    );
    return { deleted: true, result };
  }

  async #attemptShutdownSessionDeletion(reason, services) {
    if (!nonEmptyString(this.#listenerState().session_id)) {
      return { deleted: false, result: "not-present" };
    }
    try {
      return await this.#deletePersistedSession(
        reason,
        nowFunction(services)() + ALARM_WORK_BUDGET_MS,
        services,
      );
    } catch (error) {
      loggerService(services).error(this.#safeRecord({
        source: "ScaleSetListener",
        event: "shutdown-session-delete-failed",
        reason,
        error: safeErrorMessage(error),
        ...this.#correlations(),
      }));
      return { deleted: false, result: "failed" };
    }
  }

  async #replaceSession(reason, config, deadlineMs, services) {
    await this.#deletePersistedSession(reason, deadlineMs, services);
    this.#clearSession();
    return this.#createSession(config, deadlineMs, services);
  }

  async #createSession(config, deadlineMs, services) {
    const connection = await this.#ensureAdminConnection(
      config,
      deadlineMs,
      services,
    );
    const scaleSetId = await this.#ensureScaleSet(
      config,
      connection,
      deadlineMs,
      services,
    );
    const owner = config.owner ?? this.#listenerState().owner;
    if (!nonEmptyString(owner)) {
      throw new InvalidListenerConfiguration(
        "The listener owner is not configured",
      );
    }

    let created;
    try {
      created = await (
        services.createMessageSession ?? createMessageSession
      )(
        {
          actionsServiceUrl: connection.actionsServiceUrl,
          adminToken: connection.adminToken,
          scaleSetId,
          owner,
          deadlineMs,
        },
        services.clientServices ?? {},
      );
    } catch (error) {
      if (error instanceof SessionConflictError) {
        await this.#handleSessionConflict(
          error,
          deadlineMs,
          services,
        );
        return null;
      }
      throw error;
    }

    const createdAtMs = nowFunction(services)();
    this.#persistCreatedSessionIdentity(created, createdAtMs);
    this.#persistSession(
      created,
      createdAtMs,
      created.statistics,
    );
    this.#clearRecovery("session-conflict");
    this.#clearRecovery("session-expired");
    this.#clearRecovery("github-rate-limit");
    this.#emit(
      "message-session-created",
      {
        cursor: this.#listenerState().last_message_id,
        statistics: created.statistics ?? null,
      },
      services,
    );
    return stateSession(this.#listenerState());
  }

  async #ensureSession(config, deadlineMs, services) {
    this.#persistIdentity(config, config.scaleSetId ?? null);
    const connection = await this.#ensureAdminConnection(
      config,
      deadlineMs,
      services,
    );
    const scaleSetId = await this.#ensureScaleSet(
      config,
      connection,
      deadlineMs,
      services,
    );
    const state = this.#listenerState();
    const session = stateSession(state);
    if (services.forceSessionCreation === true && session !== null) {
      return this.#createSession(config, deadlineMs, services);
    }
    if (session !== null) {
      return session;
    }
    const hasPartialSession = [
      state.session_id,
      state.session_queue_url,
      state.session_queue_token,
    ].some((value) => value !== null);
    if (hasPartialSession) {
      return this.#replaceSession(
        "session-replacement",
        config,
        deadlineMs,
        services,
      );
    }
    if (!isPositiveSafeInteger(scaleSetId)) {
      throw new Error("The scale set identifier was not persisted");
    }
    return this.#createSession(config, deadlineMs, services);
  }

  #recoveryRow(condition) {
    return this.sql.exec(
      "SELECT * FROM recovery WHERE condition = ?",
      condition,
    ).toArray()[0] ?? null;
  }

  #clearRecovery(condition) {
    if (!RECOVERY_CONDITIONS.includes(condition)) {
      throw new TypeError("The recovery condition is invalid");
    }
    this.sql.exec("DELETE FROM recovery WHERE condition = ?", condition);
  }

  async #closeStartGate(reason, services) {
    const nowMs = nowFunction(services)();
    try {
      if (services.closeExternalGate !== undefined) {
        await services.closeExternalGate({ reason, nowMs });
      } else {
        const config = this.#configuration(services);
        if (!nonEmptyString(config?.outageGateCloseUrl)) {
          throw new InvalidListenerConfiguration(
            "outageGateCloseUrl is not configured",
          );
        }
        let url;
        try {
          url = new URL(config.outageGateCloseUrl);
        } catch (error) {
          throw new InvalidListenerConfiguration(
            "outageGateCloseUrl is invalid",
            { cause: error },
          );
        }
        if (url.protocol !== "https:") {
          throw new InvalidListenerConfiguration(
            "outageGateCloseUrl must use HTTPS",
          );
        }
        if (!nonEmptyString(this.env.OUTAGE_GATE_TOKEN)) {
          throw new InvalidListenerConfiguration(
            "OUTAGE_GATE_TOKEN is not configured",
          );
        }
        const state = this.#listenerState();
        const response = await this.#fetchWithDeadline(
          url.toString(),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.env.OUTAGE_GATE_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              action: "close",
              closedAtMs: nowMs,
              reason,
              scaleSetId: state.scale_set_id,
              scaleSetName: state.scale_set_name,
            }),
          },
          nowMs + ALARM_WORK_BUDGET_MS,
          services,
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            `The external start gate refused closure with status ${response.status}`,
          );
        }
        await response.body?.cancel();
      }
      this.sql.exec(
        `UPDATE listener_state
         SET last_start_gate_closed_reason = ?,
             last_start_gate_closed_at_ms = ?
         WHERE singleton = 1`,
        reason,
        nowMs,
      );
    } catch (error) {
      const fields = { reason, error: safeErrorMessage(error) };
      try {
        this.#emit("start-gate-close-failed", fields, services);
      } catch (emitError) {
        this.#logWithoutPersistence(
          "start-gate-close-failed",
          {
            ...fields,
            eventPersistenceError: safeErrorMessage(emitError),
          },
          services,
        );
      }
      throw new Error("The external start gate could not be closed", {
        cause: error,
      });
    }
  }

  async #exhaustRecovery(condition, row, services) {
    const marker = RECOVERY_MARKERS[condition];
    await this.#closeStartGate(marker, services);
    this.sql.exec(
      `UPDATE recovery
       SET exhausted_marker = ?
       WHERE condition = ?`,
      marker,
      condition,
    );
    this.sql.exec(
      `UPDATE listener_state
       SET mode = 'stopped', stopped_reason = ?
       WHERE singleton = 1`,
      `${FAILURE_STOP_PREFIX}${marker}`,
    );
    const fields = {
      condition,
      exhaustionMarker: marker,
      attempts: row.attempts,
      firstFailureAtMs: row.first_failure_at_ms,
    };
    try {
      this.#emit("recovery-exhausted", fields, services);
    } catch (emitError) {
      this.#logWithoutPersistence(
        "recovery-exhausted",
        {
          ...fields,
          eventPersistenceError: safeErrorMessage(emitError),
        },
        services,
      );
    }
    await this.#attemptShutdownSessionDeletion(
      "recovery-exhausted",
      services,
    );
    await this.#alarmService(services).delete();
    return { exhausted: true, marker };
  }

  async #recordRecoveryFailure(condition, suppliedPauseMs, services) {
    if (!RECOVERY_CONDITIONS.includes(condition)) {
      throw new TypeError("The recovery condition is invalid");
    }
    const nowMs = nowFunction(services)();
    await this.#alarmService(services).set(nowMs);
    const existing = this.#recoveryRow(condition);
    if (existing?.exhausted_marker !== null && existing !== null) {
      return { exhausted: true, marker: existing.exhausted_marker };
    }
    const attempts = (existing?.attempts ?? 0) + 1;
    const firstFailureAtMs = existing?.first_failure_at_ms ?? nowMs;
    const elapsedMs = nowMs - firstFailureAtMs;
    const exponentialPauseMs = recoveryPauseMs(attempts);
    const pauseMs = Number.isFinite(suppliedPauseMs) && suppliedPauseMs >= 0
      ? Math.max(suppliedPauseMs, exponentialPauseMs)
      : exponentialPauseMs;
    const nextAttemptAtMs = nowMs + pauseMs;
    this.sql.exec(
      `INSERT INTO recovery (
         condition,
         first_failure_at_ms,
         attempts,
         next_attempt_at_ms,
         exhausted_marker
       ) VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (condition) DO UPDATE SET
         attempts = excluded.attempts,
         next_attempt_at_ms = excluded.next_attempt_at_ms`,
      condition,
      firstFailureAtMs,
      attempts,
      nextAttemptAtMs,
    );
    const row = this.#recoveryRow(condition);
    await this.#alarmService(services).set(nextAttemptAtMs);
    if (
      attempts >= RECOVERY_MAX_ATTEMPTS ||
      elapsedMs >= RECOVERY_MAX_ELAPSED_MS
    ) {
      return this.#exhaustRecovery(condition, row, services);
    }
    this.#emit(
      "recovery-deferred",
      {
        condition,
        attempts,
        firstFailureAtMs,
        nextAttemptAtMs,
        pauseMs,
      },
      services,
    );
    return { exhausted: false, nextAttemptAtMs };
  }

  async #handleSessionConflict(error, deadlineMs, services) {
    const state = this.#listenerState();
    const ownersMatch = nonEmptyString(state.owner) &&
      nonEmptyString(error.owner) && state.owner === error.owner;
    if (ownersMatch && nonEmptyString(state.session_id)) {
      try {
        await this.#deletePersistedSession(
          "session-conflict-owner-match",
          deadlineMs,
          services,
        );
      } catch (deleteError) {
        this.#emit(
          "session-conflict-delete-failed",
          { error: safeErrorMessage(deleteError), ownersMatch: true },
          services,
        );
      }
    }
    this.#emit(
      "message-session-conflict",
      { ownersMatch, conflictOwner: error.owner ?? null },
      services,
    );
    await this.#recordRecoveryFailure(
      "session-conflict",
      null,
      services,
    );
  }

  async #handleRecoverableError(error, services) {
    const condition = recoveryConditionForError(error);
    if (condition === null) {
      return null;
    }
    const pauseMs = error instanceof RateLimitedError
      ? error.pauseMs
      : null;
    const recovery = await this.#recordRecoveryFailure(
      condition,
      pauseMs,
      services,
    );
    return { condition, recovery };
  }

  async #deferActiveRecovery(services) {
    const nowMs = nowFunction(services)();
    const rows = this.sql.exec(
      `SELECT *
       FROM recovery
       WHERE exhausted_marker IS NULL
       ORDER BY first_failure_at_ms, condition`,
    ).toArray();
    for (const row of rows) {
      if (nowMs - row.first_failure_at_ms >= RECOVERY_MAX_ELAPSED_MS) {
        const recovery = await this.#exhaustRecovery(
          row.condition,
          row,
          services,
        );
        return { condition: row.condition, recovery };
      }
      if (row.next_attempt_at_ms > nowMs) {
        await this.#alarmService(services).set(row.next_attempt_at_ms);
        return {
          condition: row.condition,
          recovery: {
            exhausted: false,
            nextAttemptAtMs: row.next_attempt_at_ms,
          },
        };
      }
    }
    return null;
  }

  async #refreshPersistedSession(deadlineMs, services) {
    const state = this.#listenerState();
    const refreshed = await (
      services.refreshMessageSession ?? refreshMessageSession
    )(
      {
        actionsServiceUrl: state.actions_service_url,
        adminToken: state.admin_token,
        scaleSetId: state.scale_set_id,
        sessionId: state.session_id,
        deadlineMs,
      },
      services.clientServices ?? {},
    );
    if (
      !sessionPayloadIsValid(refreshed) ||
      refreshed.sessionId !== state.session_id
    ) {
      throw new Error("The refreshed message session is invalid");
    }
    this.#persistSession(
      refreshed,
      state.session_created_at_ms ?? nowFunction(services)(),
      refreshed.statistics,
    );
    this.#emit("message-session-refreshed", {}, services);
    return stateSession(this.#listenerState());
  }

  #dropExpiredSession(operation, error, services) {
    const sessionId = this.#listenerState().session_id;
    this.#clearSession();
    const fields = {
      operation,
      sessionId,
      error: safeErrorMessage(error),
    };
    try {
      this.#emit("message-session-expired", fields, services);
    } catch (emitError) {
      this.#logWithoutPersistence(
        "message-session-expired",
        {
          ...fields,
          eventPersistenceError: safeErrorMessage(emitError),
        },
        services,
      );
    }
  }

  async #runSessionOperation(name, operation, deadlineMs, services) {
    const firstSession = stateSession(this.#listenerState());
    if (firstSession === null) {
      throw new Error(`The ${name} operation has no message session`);
    }
    try {
      const result = await operation(firstSession);
      this.#clearRecovery("github-rate-limit");
      return result;
    } catch (error) {
      if (error instanceof MessageSessionExpiredError) {
        this.#dropExpiredSession(name, error, services);
        throw error;
      }
      if (!(error instanceof MessageQueueTokenExpiredError)) {
        throw error;
      }
    }

    let refreshed;
    try {
      refreshed = await this.#refreshPersistedSession(
        deadlineMs,
        services,
      );
    } catch (error) {
      if (error instanceof MessageSessionExpiredError) {
        this.#dropExpiredSession(name, error, services);
      }
      throw error;
    }
    try {
      const result = await operation(refreshed);
      this.#clearRecovery("github-rate-limit");
      return result;
    } catch (error) {
      if (error instanceof MessageSessionExpiredError) {
        this.#dropExpiredSession(name, error, services);
        throw error;
      }
      if (!(error instanceof MessageQueueTokenExpiredError)) {
        throw error;
      }
      this.#emit(
        "terminal-session-authentication-failure",
        { operation: name },
        services,
      );
      await this.#deletePersistedSession(
        "terminal-authentication-failure",
        deadlineMs,
        services,
      );
      await this.#alarmService(services).set(nowFunction(services)());
      throw new TerminalSessionAuthenticationError(
        `The ${name} operation failed authentication twice`,
        { cause: error },
      );
    }
  }

  async #controlStatus(services) {
    const control = services.control ?? getAutopilotControl(this.env);
    return control.status();
  }

  async #killSwitchShutdown(services) {
    const nowMs = nowFunction(services)();
    this.sql.exec(
      `UPDATE listener_state
       SET mode = 'stopped', stopped_reason = ?
       WHERE singleton = 1`,
      `${FAILURE_STOP_PREFIX}kill-switch-transition`,
    );
    await this.#deletePersistedSession(
      "kill-switch-transition",
      nowMs + ALARM_WORK_BUDGET_MS,
      services,
    );
    this.#emit("kill-switch-transition", { advertisedMaxCapacity: 0 }, services);
    await this.#alarmService(services).delete();
  }

  #outboxDepth() {
    const result = Object.fromEntries(
      [...ACTIVE_OUTBOX_STATES, ...TERMINAL_OUTBOX_STATES]
        .map((state) => [state, 0]),
    );
    for (const row of this.sql.exec(
      "SELECT state, COUNT(*) AS depth FROM dispatch_outbox GROUP BY state",
    ).toArray()) {
      result[row.state] = row.depth;
    }
    return result;
  }

  async status({ scaleSetName } = {}, services = {}) {
    const state = this.#bindScaleSetName(scaleSetName);
    const nowMs = Date.now();
    const recoveries = this.sql.exec(
      `SELECT condition, first_failure_at_ms, attempts,
              next_attempt_at_ms, exhausted_marker
       FROM recovery
       ORDER BY condition`,
    ).toArray().map((row) => ({
      condition: row.condition,
      firstFailureAtMs: row.first_failure_at_ms,
      attempts: row.attempts,
      nextAttemptAtMs: row.next_attempt_at_ms,
      exhaustedMarker: row.exhausted_marker,
    }));
    const quarantinedMessages = this.sql.exec(
      `SELECT message_id, received_at_ms, quarantine_reason, payload
       FROM inbox
       WHERE state = 'quarantined'
       ORDER BY message_id`,
    ).toArray().map((row) => ({
      messageId: row.message_id,
      receivedAtMs: row.received_at_ms,
      reason: row.quarantine_reason,
      payload: safeJsonParse(
        this.#safeRecord(safeJsonParse(row.payload)),
      ),
    }));
    const liveIntents = this.sql.exec(
      `SELECT runner_request_id, message_id, state, attempts, redeliveries,
              recorded_at_ms
       FROM acquisition_intents
       WHERE state IN ('intended', 'granted', 'ambiguous')
       ORDER BY recorded_at_ms, runner_request_id`,
    ).toArray().map((row) => ({
      runnerRequestId: row.runner_request_id,
      messageId: row.message_id,
      state: row.state,
      attempts: row.attempts,
      redeliveries: row.redeliveries,
      recordedAtMs: row.recorded_at_ms,
    }));
    const exportRecords = this.sql.exec(
      `SELECT id, record, created_at_ms, state
       FROM export_outbox
       ORDER BY id`,
    ).toArray().map((row) => ({
      id: row.id,
      record: safeJsonParse(row.record),
      createdAtMs: row.created_at_ms,
      state: row.state,
    }));
    const config = this.#configuration({}, state);
    const running = state.mode === "running" &&
      this.env.AUTOPILOT_ENABLED === "1" && config !== null;
    let controlStatusReadFailed = false;
    let controlMaxCapacity = 0;
    if (running) {
      try {
        const controlStatus = await this.#controlStatus(services);
        controlMaxCapacity = Number.isFinite(controlStatus?.maxCapacity)
          ? controlStatus.maxCapacity
          : 0;
      } catch {
        controlStatusReadFailed = true;
      }
    }
    const advertisedMaxCapacity = running
      ? Math.min(MAX_ACTIVE_RUNNERS, controlMaxCapacity)
      : 0;
    const admission = this.#admissionState();
    const pace = this.#paceState();
    return {
      scaleSet: state.scale_set_name,
      scaleSetId: state.scale_set_id,
      enabled: this.env.AUTOPILOT_ENABLED === "1",
      configured: config !== null,
      mode: state.mode,
      stoppedReason: publicStoppedReason(state.stopped_reason),
      advertisedMaxCapacity,
      controlStatusReadFailed,
      alarmGeneration: state.alarm_generation,
      heartbeatAtMs: state.heartbeat_at_ms,
      heartbeatAgeMs: state.heartbeat_at_ms === null
        ? null
        : Math.max(0, nowMs - state.heartbeat_at_ms),
      heartbeatGeneration: state.heartbeat_generation,
      heartbeatCursor: state.heartbeat_cursor,
      cursor: state.last_message_id,
      sessionIdPresent: state.session_id !== null,
      sessionId: state.session_id,
      latestStatistics: safeJsonParse(state.latest_statistics),
      admissionLimit: admission.limit,
      admissionSuccessStreak: admission.successStreak,
      admissionLimited: state.admission_limited === 1,
      startPace: {
        paceMs: pace.paceMs,
        refusalStreak: pace.refusalStreak,
        lastStartIssuedAtMs: pace.lastStartIssuedAtMs,
      },
      scaleUp: {
        activeDispatches: this.#activeOutboxCount(),
        unreservedDispatches: this.#unreservedOutboxCount(),
        lastSequence: state.scale_up_sequence,
        lastDecision: safeJsonParse(state.last_scale_up_decision),
        lastDecisionAtMs: state.last_scale_up_decision_at_ms,
      },
      startGate: {
        lastRefusal: safeJsonParse(state.last_start_gate_refusal),
        lastRefusalAtMs: state.last_start_gate_refusal_at_ms,
        lastClosedReason: state.last_start_gate_closed_reason,
        lastClosedAtMs: state.last_start_gate_closed_at_ms,
      },
      sqliteFull: state.sqlite_full === 1,
      liveIntents,
      outboxDepth: this.#outboxDepth(),
      recoveries,
      exhaustionMarkers: recoveries
        .filter((row) => row.exhaustedMarker !== null)
        .map((row) => row.exhaustedMarker),
      quarantinedMessages,
      exportRecords,
      inFlight: {
        poll: this.activePollController !== null,
        operations: this.inFlightOperations.size,
      },
    };
  }

  #messageRequests(message) {
    return message.jobAvailable.map((entry) => ({
      runnerRequestId: entry.runnerRequestId,
      repository: requestRepository(entry),
      workflow: requestWorkflow(entry),
    }));
  }

  #messageCancellations(message) {
    return [
      ...message.jobCompleted,
      ...message.jobStarted.filter((entry) => entry.cancelled === true),
      ...message.jobAssigned.filter((entry) => entry.cancelled === true),
    ];
  }

  #completedRunnerNames(message) {
    return [...new Set((message.ignored ?? [])
      .filter((entry) =>
        entry.messageType === "JobCompleted" &&
        nonEmptyString(entry.runnerName)
      )
      .map((entry) => entry.runnerName))];
  }

  #messageQuarantineReasons(message) {
    const reasons = message.quarantined.map((entry) => entry.reason);
    for (const request of this.#messageRequests(message)) {
      if (request.repository === null) {
        reasons.push("invalid-repository-identity");
      }
    }
    return [...new Set(reasons)];
  }

  #commitMessage(message, receivedAtMs, services) {
    if (!isPositiveSafeInteger(message.messageId)) {
      throw new RoutingSemanticsError("invalid-message-id");
    }
    const payload = JSON.stringify(messageWithDefaults(message));
    const requests = this.#messageRequests(message);
    const cancellations = this.#messageCancellations(message);
    const quarantineReasons = this.#messageQuarantineReasons(message);
    const quarantined = quarantineReasons.length > 0;
    const ignored = message.ignored ?? [];
    const ignoredReasons = [
      ...new Set(ignored.map((entry) => entry.reason)),
    ];
    const redeliveryDecisions = [];

    this.ctx.storage.transactionSync(() => {
      const existing = this.sql.exec(
        "SELECT payload FROM inbox WHERE message_id = ?",
        message.messageId,
      ).toArray()[0];
      if (
        existing !== undefined &&
        JSON.stringify(messageWithDefaults(safeJsonParse(existing.payload))) !==
          payload
      ) {
        throw new RoutingSemanticsError("reused-message-id");
      }

      this.sql.exec(
        `INSERT OR IGNORE INTO inbox (
           message_id,
           received_at_ms,
           payload,
           state,
           quarantine_reason
         ) VALUES (?, ?, ?, ?, ?)`,
        message.messageId,
        receivedAtMs,
        payload,
        quarantined ? "quarantined" : "stored",
        quarantined ? quarantineReasons.join(",") : null,
      );
      if (message.statistics !== null) {
        this.sql.exec(
          `UPDATE listener_state
           SET latest_statistics = ?
           WHERE singleton = 1`,
          JSON.stringify(message.statistics),
        );
      }

      for (const cancellation of cancellations) {
        this.sql.exec(
          `INSERT INTO cancellations (runner_request_id, recorded_at_ms)
           VALUES (?, ?)
           ON CONFLICT (runner_request_id) DO NOTHING`,
          cancellation.runnerRequestId,
          receivedAtMs,
        );
        this.sql.exec(
          `UPDATE acquisition_intents
           SET state = 'cancelled'
           WHERE runner_request_id = ?
             AND state IN ('intended', 'granted')`,
          cancellation.runnerRequestId,
        );
        this.sql.exec(
          `UPDATE dispatch_outbox
           SET state = 'cancelled',
               jit_config = NULL,
               last_error = 'cancelled',
               updated_at_ms = ?
           WHERE runner_request_id = ?
             AND state IN ('pending', 'reserved', 'jit-requested', 'jit-ready')`,
          receivedAtMs,
          cancellation.runnerRequestId,
        );
      }

      if (!quarantined) {
        for (const request of requests) {
          const existingIntent = this.sql.exec(
            `SELECT message_id, state, redeliveries
             FROM acquisition_intents
             WHERE runner_request_id = ?`,
            request.runnerRequestId,
          ).toArray()[0];
          const cancelled = this.sql.exec(
            "SELECT 1 FROM cancellations WHERE runner_request_id = ?",
            request.runnerRequestId,
          ).toArray().length === 1;
          if (existingIntent === undefined) {
            this.sql.exec(
              `INSERT INTO acquisition_intents (
               runner_request_id,
               message_id,
               state,
               attempts,
               recorded_at_ms
             ) VALUES (?, ?, ?, 0, ?)`,
              request.runnerRequestId,
              message.messageId,
              cancelled ? "cancelled" : "intended",
              receivedAtMs,
            );
            continue;
          }
          if (existingIntent.message_id === message.messageId) {
            continue;
          }

          const decisionFields = {
            messageId: message.messageId,
            runnerRequestId: request.runnerRequestId,
            previousMessageId: existingIntent.message_id,
            redeliveries: existingIntent.redeliveries,
          };
          if (
            existingIntent.redeliveries >= MAX_REQUEST_REDELIVERIES
          ) {
            redeliveryDecisions.push({
              event: "runner-request-redelivery-exhausted",
              fields: decisionFields,
            });
            continue;
          }
          if (cancelled) {
            redeliveryDecisions.push({
              event: "runner-request-redelivery-refused",
              fields: { ...decisionFields, reason: "cancelled" },
            });
            continue;
          }
          if (existingIntent.state === "intended") {
            redeliveryDecisions.push({
              event: "runner-request-redelivery-refused",
              fields: {
                ...decisionFields,
                reason: "acquisition-in-flight",
              },
            });
            continue;
          }

          const outbox = this.sql.exec(
            `SELECT state, reservation_id, reservation_released_at_ms,
                    last_error
             FROM dispatch_outbox
             WHERE runner_request_id = ?`,
            request.runnerRequestId,
          ).toArray()[0];
          if (outbox !== undefined && outbox.state !== "failed") {
            redeliveryDecisions.push({
              event: "runner-request-redelivery-refused",
              fields: {
                ...decisionFields,
                reason: `dispatch-${outbox.state}`,
              },
            });
            continue;
          }
          if (
            outbox !== undefined &&
            outbox.reservation_id !== null &&
            outbox.reservation_released_at_ms === null
          ) {
            redeliveryDecisions.push({
              event: "runner-request-redelivery-refused",
              fields: {
                ...decisionFields,
                reason: "reservation-unreleased",
              },
            });
            continue;
          }

          if (outbox !== undefined) {
            this.sql.exec(
              `DELETE FROM dispatch_outbox
               WHERE runner_request_id = ? AND state = 'failed'`,
              request.runnerRequestId,
            );
          }
          this.sql.exec(
            `UPDATE acquisition_intents
             SET state = 'intended',
                 message_id = ?,
                 attempts = 0,
                 redeliveries = redeliveries + 1,
                 recorded_at_ms = ?
             WHERE runner_request_id = ?`,
            message.messageId,
            receivedAtMs,
            request.runnerRequestId,
          );
          redeliveryDecisions.push({
            event: "runner-request-redelivered",
            fields: {
              ...decisionFields,
              redeliveries: existingIntent.redeliveries + 1,
              previousError: outbox?.last_error ?? null,
            },
          });
        }
      }
    });

    this.#emit(
      "message-polled",
      {
        messageId: message.messageId,
        statistics: message.statistics,
        requestedRunnerCount: requests.length,
        cancellationCount: cancellations.length,
        quarantined,
        quarantineReasons,
        ignoredCount: ignored.length,
        ignoredReasons,
      },
      services,
    );
    for (const cancellation of cancellations) {
      this.#emit(
        "runner-request-cancelled",
        {
          messageId: message.messageId,
          runnerRequestId: cancellation.runnerRequestId,
          workflow: requestWorkflow(cancellation),
        },
        services,
      );
    }
    for (const decision of redeliveryDecisions) {
      this.#emit(decision.event, decision.fields, services);
    }
    return {
      quarantined,
      quarantineReasons,
      requests,
      cancellations,
    };
  }

  #markAcknowledged(messageId) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE listener_state
         SET last_message_id = MAX(last_message_id, ?)
         WHERE singleton = 1`,
        messageId,
      );
      this.sql.exec(
        `UPDATE inbox
         SET state = CASE
           WHEN state = 'quarantined' THEN 'quarantined'
           ELSE 'acknowledged'
         END
         WHERE message_id = ?`,
        messageId,
      );
    });
  }

  #messageFromInbox(messageId) {
    const row = this.sql.exec(
      "SELECT payload FROM inbox WHERE message_id = ?",
      messageId,
    ).toArray()[0];
    return row === undefined
      ? null
      : messageWithDefaults(safeJsonParse(row.payload));
  }

  #intendedRequests(messageId) {
    return this.sql.exec(
      `SELECT runner_request_id, attempts, redeliveries, recorded_at_ms
       FROM acquisition_intents
       WHERE message_id = ? AND state = 'intended'
       ORDER BY runner_request_id`,
      messageId,
    ).toArray();
  }

  #markAcquisitionAmbiguous(rows, message, error, services) {
    const nowMs = nowFunction(services)();
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        this.sql.exec(
          `UPDATE acquisition_intents
           SET state = 'ambiguous', attempts = attempts + 1
           WHERE runner_request_id = ? AND state = 'intended'`,
          row.runner_request_id,
        );
      }
    });
    for (const row of rows) {
      const source = message.jobAvailable.find(
        (entry) => entry.runnerRequestId === row.runner_request_id,
      );
      this.#emit(
        "runner-acquisition-ambiguous",
        {
          messageId: message.messageId,
          runnerRequestId: row.runner_request_id,
          workflow: requestWorkflow(source),
          error: safeErrorMessage(error),
          recordedAtMs: nowMs,
        },
        services,
      );
    }
  }

  #persistAcquisitionResult(rows, grantedIds, message, config, services) {
    const requestedIds = rows.map((row) => row.runner_request_id);
    const granted = new Set(grantedIds);
    if (
      granted.size !== grantedIds.length ||
      grantedIds.some((requestId) => !requestedIds.includes(requestId))
    ) {
      throw new RoutingSemanticsError("invalid-acquisition-subset");
    }
    const nowMs = nowFunction(services)();
    const wave = config.wave;
    if (!nonEmptyString(wave)) {
      throw new InvalidListenerConfiguration("The migration wave is missing");
    }
    const scaleSetId = this.#listenerState().scale_set_id;

    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        const requestId = row.runner_request_id;
        const isGranted = granted.has(requestId);
        this.sql.exec(
          `UPDATE acquisition_intents
           SET state = ?, attempts = attempts + 1
           WHERE runner_request_id = ? AND state = 'intended'`,
          isGranted ? "granted" : "not-granted",
          requestId,
        );
        if (!isGranted) {
          continue;
        }
        const source = message.jobAvailable.find(
          (entry) => entry.runnerRequestId === requestId,
        );
        const repository = requestRepository(source);
        if (repository === null) {
          throw new RoutingSemanticsError("invalid-repository-identity");
        }
        const cancelled = this.sql.exec(
          "SELECT 1 FROM cancellations WHERE runner_request_id = ?",
          requestId,
        ).toArray().length === 1;
        this.sql.exec(
          `INSERT INTO dispatch_outbox (
             runner_request_id,
             state,
             correlation_id,
             repository,
             wave,
             attempts,
             intent_recorded_at_ms,
             updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT (runner_request_id) DO NOTHING`,
          requestId,
          cancelled ? "cancelled" : "pending",
          runnerCorrelationId(scaleSetId, requestId, row.redeliveries),
          repository,
          wave,
          row.recorded_at_ms,
          nowMs,
        );
      }
    });

    for (const row of rows) {
      const source = message.jobAvailable.find(
        (entry) => entry.runnerRequestId === row.runner_request_id,
      );
      this.#emit(
        granted.has(row.runner_request_id)
          ? "runner-acquired"
          : "runner-not-granted",
        {
          messageId: message.messageId,
          runnerRequestId: row.runner_request_id,
          registryCorrelation: runnerCorrelationId(
            scaleSetId,
            row.runner_request_id,
            row.redeliveries,
          ),
          repository: requestRepository(source),
          workflow: requestWorkflow(source),
          wave,
        },
        services,
      );
    }
  }

  async #acquireForMessage(message, config, deadlineMs, services) {
    const rows = this.#intendedRequests(message.messageId);
    if (rows.length === 0) {
      return;
    }
    const controlStatus = await this.#controlStatus(services);
    if (controlStatus.localGate === "closed" || controlStatus.maxCapacity <= 0) {
      await this.#killSwitchShutdown(services);
      return;
    }
    const requestIds = rows.map((row) => row.runner_request_id);
    let grantedIds;
    try {
      grantedIds = await this.#runSessionOperation(
        "AcquireJobs",
        (session) => (services.acquireJobs ?? acquireJobs)(
          {
            actionsServiceUrl: this.#listenerState().actions_service_url,
            session,
            scaleSetId: this.#listenerState().scale_set_id,
            requestIds,
            deadlineMs,
          },
          services.clientServices ?? {},
        ),
        deadlineMs,
        services,
      );
    } catch (error) {
      if (ambiguousExternalResult(error)) {
        this.#markAcquisitionAmbiguous(rows, message, error, services);
        return;
      }
      throw error;
    }
    this.#persistAcquisitionResult(
      rows,
      grantedIds,
      message,
      config,
      services,
    );
    this.#clearRecovery("github-rate-limit");
    await services.failpoint?.("after-dispatch-enqueue");
  }

  async #resumeIntendedAcquisition(config, deadlineMs, services) {
    const row = this.sql.exec(
      `SELECT message_id
       FROM acquisition_intents
       WHERE state = 'intended'
       ORDER BY recorded_at_ms, runner_request_id
       LIMIT 1`,
    ).toArray()[0];
    if (row === undefined) {
      return;
    }
    const message = this.#messageFromInbox(row.message_id);
    if (message === null) {
      throw new RoutingSemanticsError("missing-acquisition-message");
    }
    await this.#acquireForMessage(message, config, deadlineMs, services);
  }

  async #scaleUpToStatistics(config, workDeadlineMs, services) {
    const storedStatistics = this.#listenerState().latest_statistics;
    if (storedStatistics === null) {
      this.#recordScaleUpDecision(
        "statistics-absent",
        {},
        services,
      );
      return;
    }
    const statistics = safeJsonParse(storedStatistics);
    if (
      !isPlainObject(statistics) ||
      !Number.isSafeInteger(statistics.totalAssignedJobs) ||
      statistics.totalAssignedJobs < 0 ||
      !Number.isSafeInteger(statistics.totalRegisteredRunners) ||
      statistics.totalRegisteredRunners < 0
    ) {
      this.#recordScaleUpDecision(
        "statistics-unavailable",
        {},
        services,
        "scale-up-refused",
        { reason: "statistics-unavailable" },
      );
      return;
    }
    if (statistics.totalAssignedJobs === 0) {
      this.#recordScaleUpDecision(
        "no-assigned-jobs",
        {
          totalAssignedJobs: statistics.totalAssignedJobs,
          minRunners: MIN_RUNNERS,
          registeredRunners: statistics.totalRegisteredRunners,
        },
        services,
      );
      return;
    }

    // GitHub keeps one registration per runner this pool has ever created and
    // never removes one on its own. MAX_ACTIVE_RUNNERS is the hard ceiling on
    // how many runners this pool can hold live at once, so a registered count
    // above it proves deregistration has stopped, and a stopped deregistration
    // path can only ratchet the count upward.
    // Every statistic that drives this loop -- totalAssignedJobs,
    // totalRunningJobs, totalBusyRunners -- is reported against those
    // registrations. Once they leak, the demand signal describes this pool's
    // own runners instead of queued work, and the loop spawns without end.
    // Production reached 1,643 registrations against this ceiling of 300 while
    // totalAvailableJobs and totalAcquiredJobs stayed at zero for 48 hours.
    // Refuse rather than warn: a spawn into a leaked registry adds one more
    // registration to a leak this loop has no way to drain.
    if (statistics.totalRegisteredRunners > MAX_ACTIVE_RUNNERS) {
      this.#recordScaleUpDecision(
        "registration-leak",
        {
          totalAssignedJobs: statistics.totalAssignedJobs,
          registeredRunners: statistics.totalRegisteredRunners,
          maxActiveRunners: MAX_ACTIVE_RUNNERS,
        },
        services,
        "scale-up-refused",
        {
          reason: "registration-leak",
          registeredRunners: statistics.totalRegisteredRunners,
          maxActiveRunners: MAX_ACTIVE_RUNNERS,
        },
      );
      return;
    }

    const controlStatus = await this.#controlStatus(services);
    const maxRunners = Math.min(
      MAX_ACTIVE_RUNNERS,
      controlStatus.maxCapacity,
    );
    const unreservedDispatches = this.#unreservedOutboxCount();
    // GitHub's idle runners are existing supply that can satisfy assigned work.
    // Subtract this pool's live supply before clamping demand. The `- live`
    // term prevents a just-booted idle runner from reducing both desired and
    // shortfall, which would make the pool stop at half of a genuine burst.
    // An absent idle count means no information, so it disables the clamp.
    const live = controlStatus.liveReservationCount + unreservedDispatches;
    const idleRunners = resolveIdleRunnerCount(statistics);
    const unownedIdleRunners = idleRunners === null
      ? 0
      : Math.max(0, idleRunners - live);
    const desired = desiredRunnerCount({
      maxRunners,
      minRunners: MIN_RUNNERS,
      assignedJobs: statistics.totalAssignedJobs,
      unownedIdleRunners,
    });
    if (nowFunction(services)() >= workDeadlineMs) {
      this.#recordScaleUpDecision(
        "work-deadline-elapsed",
        {
          totalAssignedJobs: statistics.totalAssignedJobs,
          maxRunners,
          minRunners: MIN_RUNNERS,
          desired,
          idleRunners,
          unownedIdleRunners,
          registeredRunners: statistics.totalRegisteredRunners,
          liveReservationCount: controlStatus.liveReservationCount,
          liveSupply: live,
        },
        services,
      );
      return;
    }
    const census = this.#neverSpawnedCensus(services);
    this.#observeNeverSpawnedCensus(census, services);
    const activeDispatches = this.#activeOutboxCount();
    const registeredRunners = statistics.totalRegisteredRunners;
    // The Worker releases a reservation when it destroys its runner, keyed on
    // sandbox_id. A JobCompleted message releases an acquired start by its
    // GitHub runner request id. ACTIVE_RUNNER_CLEANUP_DELAY_MS is the one-hour
    // backstop for a reservation whose runner is never destroyed.
    // AutopilotControl.reserve refuses at `liveCount >= approvedCapacity` using
    // this same number, so admission and enforcement agree. It also rises the
    // instant a reservation is taken, unlike GitHub's statistics, which only
    // change when a message carries new ones.
    const shortfall = Math.max(0, desired - live);
    const admission = this.#admissionState();
    const availabilityHeadroom = admission.limit === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, admission.limit - live);
    const admitted = Math.min(
      shortfall,
      Math.max(0, MAX_DISPATCH_CONCURRENCY - activeDispatches),
      availabilityHeadroom,
    );
    const admissionLimited = admission.limit !== null &&
      availabilityHeadroom < shortfall &&
      availabilityHeadroom <= MAX_DISPATCH_CONCURRENCY - activeDispatches;
    const arithmetic = {
      totalAssignedJobs: statistics.totalAssignedJobs,
      maxRunners,
      minRunners: MIN_RUNNERS,
      desired,
      idleRunners,
      unownedIdleRunners,
      registeredRunners,
      activeStarts: activeDispatches,
      liveReservationCount: controlStatus.liveReservationCount,
      unreservedDispatches,
      liveSupply: live,
      shortfall,
      admitted,
      admissionLimit: admission.limit,
      availabilityHeadroom: admission.limit === null
        ? null
        : availabilityHeadroom,
      admissionLimited,
      contendingCount: census.contending,
      neverSpawnedCount: census.neverSpawned,
    };
    // The flag records whether the learned limit is the binding constraint.
    this.sql.exec(
      `UPDATE listener_state
       SET admission_limited = ?
       WHERE singleton = 1`,
      Number(admissionLimited),
    );
    if (shortfall > 0 || admitted > 0) {
      this.#recordScaleUpDecision(
        admitted === 0
          ? admission.limit !== null && availabilityHeadroom === 0
            ? "availability-limited"
            : "dispatch-concurrency-saturated"
          : "evaluated",
        arithmetic,
        services,
        "scale-up-evaluated",
      );
    }
    if (admitted === 0) {
      if (shortfall === 0) {
        this.#recordScaleUpDecision(
          unownedIdleRunners > 0 && statistics.totalAssignedJobs > 0
            ? "idle-supply-converged"
            : "no-shortfall",
          arithmetic,
          services,
          "scale-up-saturated",
        );
      }
      return;
    }

    const repository = config.repository ?? this.env.GITHUB_REPOSITORY;
    if (!isRepositoryName(repository)) {
      this.#recordScaleUpDecision(
        "repository-unconfigured",
        arithmetic,
        services,
        "scale-up-refused",
        { reason: "repository-unconfigured" },
      );
      return;
    }
    let repositoryAllowlist;
    try {
      repositoryAllowlist = scaleUpRepositoryAllowlist(this.env);
    } catch {
      this.#recordScaleUpDecision(
        "repository-attribution-ambiguous",
        arithmetic,
        services,
        "scale-up-refused",
        { reason: "repository-attribution-ambiguous" },
      );
      return;
    }
    if (!repositoryAllowlist.includes(repository)) {
      this.#recordScaleUpDecision(
        "repository-not-allowed",
        arithmetic,
        services,
        "scale-up-refused",
        { reason: "repository-not-allowed", repository },
      );
      return;
    }
    // Each listener attributes every start to one repository. A scale set that
    // declares its own repository is unambiguous however long the allow-list
    // is. A scale set that omits one falls back to GITHUB_REPOSITORY, so a
    // second allowed repository would leave the attribution undetermined.
    if (repositoryAllowlist.length > 1 && !isRepositoryName(config.repository)) {
      this.#recordScaleUpDecision(
        "repository-attribution-ambiguous",
        arithmetic,
        services,
        "scale-up-refused",
        { reason: "repository-attribution-ambiguous" },
      );
      return;
    }
    if (!nonEmptyString(config.wave)) {
      throw new InvalidListenerConfiguration("The migration wave is missing");
    }

    const allocationTimeMs = nowFunction(services)();
    if (allocationTimeMs >= workDeadlineMs) {
      this.#recordScaleUpDecision(
        "work-deadline-elapsed-before-allocation",
        arithmetic,
        services,
      );
      return;
    }
    const currentSequence = this.#listenerState().scale_up_sequence;
    if (
      !Number.isSafeInteger(currentSequence) ||
      currentSequence < 0
    ) {
      this.#recordScaleUpDecision(
        "request-id-space-exhausted",
        arithmetic,
        services,
        "scale-up-refused",
        { reason: "request-id-space-exhausted" },
      );
      return;
    }

    const scaleSetId = this.#listenerState().scale_set_id;
    const maxSequence = Number.MAX_SAFE_INTEGER - SCALE_UP_REQUEST_ID_BASE;
    const starts = [];
    let requestIdSpaceExhausted = false;
    this.ctx.storage.transactionSync(() => {
      for (let offset = 0; offset < admitted; offset += 1) {
        const sequenceRow = this.sql.exec(
          `UPDATE listener_state
           SET scale_up_sequence = scale_up_sequence + 1
           WHERE singleton = 1
             AND scale_up_sequence < ?
           RETURNING scale_up_sequence`,
          maxSequence,
        ).toArray()[0];
        if (sequenceRow === undefined) {
          requestIdSpaceExhausted = true;
          break;
        }
        const runnerRequestId = SCALE_UP_REQUEST_ID_BASE +
          sequenceRow.scale_up_sequence;
        const registryCorrelation = runnerCorrelationId(
          scaleSetId,
          runnerRequestId,
        );
        // A failed scale-up row leaves the active census. The next poll admits
        // a fresh identifier while the assigned job remains outstanding.
        this.sql.exec(
          `INSERT INTO dispatch_outbox (
             runner_request_id,
             state,
             correlation_id,
             repository,
             wave,
             attempts,
             intent_recorded_at_ms,
             updated_at_ms
           ) VALUES (?, 'pending', ?, ?, ?, 0, ?, ?)`,
          runnerRequestId,
          registryCorrelation,
          repository,
          config.wave,
          allocationTimeMs,
          allocationTimeMs,
        );
        starts.push({ runnerRequestId, registryCorrelation });
      }
    });

    if (starts.length > 0) {
      this.lastScaleUpDecision = null;
    }
    if (requestIdSpaceExhausted) {
      this.#recordScaleUpDecision(
        "request-id-space-exhausted",
        { ...arithmetic, startsAdmitted: starts.length },
        services,
        "scale-up-refused",
        { reason: "request-id-space-exhausted" },
      );
    } else {
      this.#recordScaleUpDecision(
        "starts-admitted",
        { ...arithmetic, startsAdmitted: starts.length },
        services,
      );
    }
    for (const start of starts) {
      this.#emit(
        "scale-up-start-admitted",
        {
          ...start,
          repository,
          wave: config.wave,
        },
        services,
      );
    }
  }

  async #stopForRoutingSemantics(
    messageId,
    quarantineReasons,
    deadlineMs,
    services,
  ) {
    const reason = `routing-semantics:${quarantineReasons.join(",")}`;
    this.sql.exec(
      `UPDATE listener_state
       SET mode = 'stopped', stopped_reason = ?
       WHERE singleton = 1`,
      `${FAILURE_STOP_PREFIX}${reason}`,
    );
    await this.#closeStartGate(reason, services);
    this.#emit(
      "routing-semantics-quarantined",
      { messageId, quarantineReasons, advertisedMaxCapacity: 0 },
      services,
    );
    await this.#deletePersistedSession(
      "alarm-failure",
      deadlineMs,
      services,
    );
    await this.#alarmService(services).delete();
  }

  async #processMessage(message, config, workDeadlineMs, services) {
    const receivedAtMs = nowFunction(services)();
    const committed = this.#commitMessage(message, receivedAtMs, services);
    await services.failpoint?.("after-message-commit");

    const inbox = this.sql.exec(
      "SELECT state FROM inbox WHERE message_id = ?",
      message.messageId,
    ).toArray()[0];
    if (inbox?.state !== "acknowledged") {
      await this.#runSessionOperation(
        "DeleteMessage",
        (session) => (services.deleteMessage ?? deleteMessage)(
          { session, messageId: message.messageId, deadlineMs: workDeadlineMs },
          services.clientServices ?? {},
        ),
        workDeadlineMs,
        services,
      );
      this.#markAcknowledged(message.messageId);
      this.#emit(
        "message-acknowledged",
        { messageId: message.messageId, cursor: message.messageId },
        services,
      );
    }
    await services.failpoint?.("after-acknowledgement");

    for (const cancellation of committed.cancellations) {
      const row = this.#outboxRow(cancellation.runnerRequestId);
      if (row !== null && nonEmptyString(row.reservation_id)) {
        await this.#compensateReservation(
          row,
          cancellation.messageType === "JobCompleted"
            ? "job-completed"
            : "runner-request-cancelled",
          services,
        );
      }
    }

    // Release zero-request completions beside the real-request case above.
    await this.#releaseCompletedRunnerReservations(
      message,
      workDeadlineMs,
      services,
    );

    if (committed.quarantined) {
      await this.#stopForRoutingSemantics(
        message.messageId,
        committed.quarantineReasons,
        workDeadlineMs,
        services,
      );
      return;
    }
    if (nowFunction(services)() >= workDeadlineMs) {
      return;
    }
    await this.#acquireForMessage(
      message,
      config,
      workDeadlineMs,
      services,
    );
  }

  async #releaseCompletedRunnerReservations(
    message,
    workDeadlineMs,
    services,
  ) {
    completionNames:
    for (const completedRunnerName of this.#completedRunnerNames(message)) {
      if (nowFunction(services)() >= workDeadlineMs) {
        break;
      }
      const runnerId = message.ignored.find((entry) =>
        entry.messageType === "JobCompleted" &&
        entry.runnerName === completedRunnerName &&
        isPositiveSafeInteger(entry.runnerId)
      )?.runnerId ?? null;
      const rows = this.sql.exec(
        `SELECT * FROM dispatch_outbox
         WHERE runner_name = ?
           AND reservation_id IS NOT NULL
           AND reservation_released_at_ms IS NULL`,
        completedRunnerName,
      ).toArray();
      for (const row of rows) {
        if (nowFunction(services)() >= workDeadlineMs) {
          break completionNames;
        }
        try {
          await this.#compensateReservation(
            row,
            "job-completed",
            services,
          );
        } catch (error) {
          const fields = {
            runnerRequestId: row.runner_request_id,
            registryCorrelation: row.correlation_id,
            runnerName: completedRunnerName,
            runnerId,
            reservationId: row.reservation_id,
            repository: row.repository,
            wave: row.wave,
            reason: "job-completed",
            error: safeErrorMessage(error),
          };
          try {
            this.#emit("reservation-release-failed", fields, services);
          } catch (emitError) {
            this.#logWithoutPersistence(
              "reservation-release-failed",
              {
                ...fields,
                eventPersistenceError: safeErrorMessage(emitError),
              },
              services,
            );
          }
          continue;
        }
        this.#emit(
          "runner-job-completed",
          {
            runnerRequestId: row.runner_request_id,
            registryCorrelation: row.correlation_id,
            runnerName: completedRunnerName,
            runnerId,
            reservationId: row.reservation_id,
            repository: row.repository,
            wave: row.wave,
          },
          services,
        );
        this.#observeVerifiedDelivery(services);
      }
    }
  }

  #outboxRow(runnerRequestId) {
    return this.sql.exec(
      "SELECT * FROM dispatch_outbox WHERE runner_request_id = ?",
      runnerRequestId,
    ).toArray()[0] ?? null;
  }

  #isCancelled(runnerRequestId) {
    return this.sql.exec(
      "SELECT 1 FROM cancellations WHERE runner_request_id = ?",
      runnerRequestId,
    ).toArray().length === 1;
  }

  #startClockOriginOrNull(runnerRequestId) {
    const row = this.sql.exec(
      `SELECT outbox.intent_recorded_at_ms,
              intent.recorded_at_ms AS legacy_recorded_at_ms
       FROM dispatch_outbox AS outbox
       LEFT JOIN acquisition_intents AS intent
         ON intent.runner_request_id = outbox.runner_request_id
       WHERE outbox.runner_request_id = ?`,
      runnerRequestId,
    ).toArray()[0];
    if (Number.isSafeInteger(row?.intent_recorded_at_ms)) {
      return row.intent_recorded_at_ms;
    }
    return Number.isSafeInteger(row?.legacy_recorded_at_ms)
      ? row.legacy_recorded_at_ms
      : null;
  }

  #startClockOrigin(runnerRequestId) {
    const recordedAtMs = this.#startClockOriginOrNull(runnerRequestId);
    if (recordedAtMs === null) {
      throw new Error("The runner request has no start clock origin");
    }
    return recordedAtMs;
  }

  #updateOutbox(runnerRequestId, values, services) {
    const allowed = new Set([
      "state",
      "runner_name",
      "runner_id",
      "reservation_id",
      "reservation_released_at_ms",
      "spawn_observed",
      "jit_config",
      "last_error",
    ]);
    const entries = Object.entries(values);
    if (
      entries.length === 0 ||
      entries.some(([field]) => !allowed.has(field))
    ) {
      throw new Error("The dispatch outbox update is invalid");
    }
    const assignments = entries.map(([field]) => `${field} = ?`).join(", ");
    this.sql.exec(
      `UPDATE dispatch_outbox
       SET ${assignments}, updated_at_ms = ?
       WHERE runner_request_id = ?`,
      ...entries.map(([, value]) => value),
      nowFunction(services)(),
      runnerRequestId,
    );
  }

  async #compensateReservation(row, reason, services) {
    if (!nonEmptyString(row.reservation_id)) {
      return;
    }
    const control = services.control ?? getAutopilotControl(this.env);
    const result = await control.compensate({
      reservationId: row.reservation_id,
      reason,
    });
    const reservationAlreadyAbsent = !result.compensated &&
      result.reason === "reservation-not-found";
    if (!result.compensated && !reservationAlreadyAbsent) {
      throw new Error(
        `The reservation compensation failed: ${result.reason ?? "unknown"}`,
      );
    }
    this.#updateOutbox(
      row.runner_request_id,
      { reservation_released_at_ms: nowFunction(services)() },
      services,
    );
    this.#emit(
      reservationAlreadyAbsent
        ? "reservation-already-absent"
        : "reservation-compensated",
      {
        runnerRequestId: row.runner_request_id,
        registryCorrelation: row.correlation_id,
        reservationId: row.reservation_id,
        reason,
        repository: row.repository,
        wave: row.wave,
      },
      services,
    );
  }

  async #cancelDispatch(row, services) {
    await this.#compensateReservation(row, "runner-request-cancelled", services);
    this.#updateOutbox(
      row.runner_request_id,
      { state: "cancelled", jit_config: null, last_error: "cancelled" },
      services,
    );
    this.sql.exec(
      `UPDATE acquisition_intents
       SET state = 'cancelled'
       WHERE runner_request_id = ?`,
      row.runner_request_id,
    );
    this.#emit(
      "runner-start-cancelled",
      {
        runnerRequestId: row.runner_request_id,
        registryCorrelation: row.correlation_id,
        runnerName: row.runner_name,
        runnerId: row.runner_id,
        repository: row.repository,
        wave: row.wave,
      },
      services,
    );
  }

  async #failDispatch(
    row,
    reason,
    services,
    { compensate = true, diagnosis = {}, startFailureReason } = {},
  ) {
    if (POOL_WARMTH_REFUSALS.includes(startFailureReason)) {
      // The pool refusal is warm-up, not a ceiling. It widens the pace and
      // nothing else.
      this.#recordPoolRefusal(row, startFailureReason, services);
    }
    if (ADMISSION_CEILING_REFUSALS.includes(startFailureReason)) {
      // The account ceiling is a real ceiling. The learned limit still records
      // it. The refused row must remain in the contending census.
      this.#observeCapacityRefusal(row, startFailureReason, services);
    }
    if (compensate) {
      await this.#compensateReservation(row, reason, services);
    }
    this.#updateOutbox(
      row.runner_request_id,
      { state: "failed", jit_config: null, last_error: reason },
      services,
    );
    this.#emit(
      "runner-spawn-failed",
      {
        runnerRequestId: row.runner_request_id,
        registryCorrelation: row.correlation_id,
        runnerName: row.runner_name,
        runnerId: row.runner_id,
        repository: row.repository,
        wave: row.wave,
        reason,
        ...(startFailureReason === undefined
          ? {}
          : { startFailureReason }),
        ...definedNonNullFields(diagnosis),
      },
      services,
    );
  }

  #observeCapacityRefusal(row, startFailureReason, services) {
    const contending = this.sql.exec(
      `SELECT COUNT(*) AS depth
       FROM dispatch_outbox
       WHERE state IN ('reserved', 'start-requested', 'started')
         AND reservation_released_at_ms IS NULL`,
    ).toArray()[0];
    const contendingCount = contending?.depth ?? 0;
    const current = this.#admissionState().limit;
    // The floor keeps one probe available and prevents a latch at zero.
    const observed = Math.max(MIN_ADMISSION_LIMIT, contendingCount - 1);
    // A refusal can only lower or hold the learned limit.
    const nextLimit = current === null
      ? observed
      : Math.min(current, observed);
    if (nextLimit === current) {
      // Every capacity refusal invalidates the preceding success evidence.
      this.sql.exec(
        `UPDATE listener_state
         SET admission_success_streak = 0
         WHERE singleton = 1`,
      );
      return;
    }
    const nowMs = nowFunction(services)();
    this.sql.exec(
      `UPDATE listener_state
       SET admission_limit = ?,
           admission_success_streak = 0,
           admission_limit_changed_at_ms = ?
       WHERE singleton = 1`,
      nextLimit,
      nowMs,
    );
    this.#emit("admission-limit-lowered", {
      admissionLimit: nextLimit,
      previousLimit: current,
      contendingCount,
      startFailureReason,
      runnerRequestId: row.runner_request_id,
      registryCorrelation: row.correlation_id,
      repository: row.repository,
      wave: row.wave,
    }, services);
  }

  #observeVerifiedDelivery(services) {
    const admission = this.#admissionState();
    if (admission.limit === null) {
      // An unrestricted controller has no learned limit to raise.
      return;
    }
    const successStreak = Math.min(
      admission.successStreak + 1,
      ADMISSION_PROBE_SUCCESSES,
    );
    const state = this.#listenerState();
    const nowMs = nowFunction(services)();
    // A raise needs verified delivery, a binding limit, and elapsed damping.
    // A 202 start response proves nothing about usable delivery. Reconciled
    // starts and all liveness-probe outcomes are deliberately neutral.
    const canRaise = successStreak >= ADMISSION_PROBE_SUCCESSES &&
      state.admission_limited === 1 &&
      (
        admission.changedAtMs === null ||
        nowMs - admission.changedAtMs >= ADMISSION_PROBE_MIN_INTERVAL_MS
      );
    const nextLimit = Math.min(
      admission.limit + 1,
      MAX_ACTIVE_RUNNERS,
    );
    if (!canRaise || nextLimit <= admission.limit) {
      // A capped streak retains its evidence without growing without bound.
      this.sql.exec(
        `UPDATE listener_state
         SET admission_success_streak = ?
         WHERE singleton = 1`,
        successStreak,
      );
      return;
    }
    this.sql.exec(
      `UPDATE listener_state
       SET admission_limit = ?,
           admission_success_streak = 0,
           admission_limit_changed_at_ms = ?
       WHERE singleton = 1`,
      nextLimit,
      nowMs,
    );
    this.#emit("admission-limit-raised", {
      admissionLimit: nextLimit,
      previousLimit: admission.limit,
      successStreak,
      reason: "verified-delivery",
    }, services);
  }

  async #refusedOutageGateDiagnosis(response) {
    const empty = {
      gateReason: null,
      gateGeneration: null,
      gateClosedAtMs: null,
    };
    try {
      const payload = safeJsonParse(await response.text());
      if (!isPlainObject(payload)) {
        return empty;
      }
      return {
        gateReason: nonEmptyString(payload.reason) ? payload.reason : null,
        gateGeneration:
          Number.isSafeInteger(payload.generation) && payload.generation >= 0
            ? payload.generation
            : null,
        gateClosedAtMs:
          Number.isSafeInteger(payload.closedAtMs) && payload.closedAtMs >= 0
            ? payload.closedAtMs
            : null,
      };
    } catch {
      return empty;
    }
  }

  #recordStartGateRefusal(row, refusal, services) {
    const record = definedNonNullFields({
      reason: refusal.reason,
      upstreamStatus: refusal.upstreamStatus,
      gateReason: refusal.gateReason,
      gateGeneration: refusal.gateGeneration,
      gateClosedAtMs: refusal.gateClosedAtMs,
      repository: row.repository,
      runnerRequestId: row.runner_request_id,
    });
    this.sql.exec(
      `UPDATE listener_state
       SET last_start_gate_refusal = ?,
           last_start_gate_refusal_at_ms = ?
       WHERE singleton = 1`,
      JSON.stringify(record),
      nowFunction(services)(),
    );
  }

  async #outagePermit(row, config, deadlineMs, services) {
    if (services.getOutagePermit !== undefined) {
      return {
        available: true,
        permit: await services.getOutagePermit({
          scaleSetId: this.#listenerState().scale_set_id,
          runnerRequestId: row.runner_request_id,
          repository: row.repository,
          wave: row.wave,
        }),
      };
    }
    if (!nonEmptyString(config.outageGateUrl)) {
      return { available: false, reason: "outage-gate-url-unconfigured" };
    }
    let outageGateUrl;
    try {
      outageGateUrl = new URL(config.outageGateUrl);
    } catch {
      return { available: false, reason: "outage-gate-url-invalid" };
    }
    if (
      outageGateUrl.protocol !== "https:" &&
      outageGateUrl.protocol !== "http:"
    ) {
      return { available: false, reason: "outage-gate-url-invalid" };
    }
    if (!nonEmptyString(this.env.OUTAGE_GATE_TOKEN)) {
      return {
        available: false,
        reason: "outage-gate-token-unconfigured",
      };
    }
    const request = {
      expiresAtMs: this.#startClockOrigin(row.runner_request_id) +
        START_DEADLINE_MS,
      repository: row.repository,
      runnerRequestId: row.runner_request_id,
      scaleSetId: this.#listenerState().scale_set_id,
      wave: row.wave,
    };
    let response;
    try {
      response = await this.#fetchWithDeadline(
        outageGateUrl.toString(),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.OUTAGE_GATE_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
        },
        deadlineMs,
        services,
      );
    } catch {
      return { available: false, reason: "outage-gate-unreachable" };
    }
    if (!response.ok) {
      const diagnosis = await this.#refusedOutageGateDiagnosis(response);
      return {
        available: false,
        reason: diagnosis.gateReason === "gate-closed"
          ? "outage-gate-closed"
          : "outage-gate-refused",
        upstreamStatus: response.status,
        ...diagnosis,
      };
    }
    let permit;
    try {
      permit = await response.json();
    } catch {
      return { available: false, reason: "outage-gate-invalid-response" };
    }
    return { available: true, permit };
  }

  async #reserveDispatch(row, config, deadlineMs, services) {
    const permit = await this.#outagePermit(
      row,
      config,
      deadlineMs,
      services,
    );
    if (!permit.available) {
      this.#recordStartGateRefusal(row, permit, services);
      await this.#failDispatch(row, permit.reason, services, {
        diagnosis: {
          upstreamStatus: permit.upstreamStatus,
          gateReason: permit.gateReason,
          gateGeneration: permit.gateGeneration,
          gateClosedAtMs: permit.gateClosedAtMs,
        },
      });
      return null;
    }
    const control = services.control ?? getAutopilotControl(this.env);
    let reservation;
    try {
      reservation = await control.reserve({
        scaleSetId: this.#listenerState().scale_set_id,
        runnerRequestId: row.runner_request_id,
        repository: row.repository,
        wave: row.wave,
        owner: config.owner ?? this.#listenerState().owner,
        outagePermit: permit.permit,
        nowMs: nowFunction(services)(),
      });
    } catch {
      await this.#failDispatch(row, "reservation-error", services);
      return null;
    }
    if (!reservation.reserved) {
      await this.#failDispatch(
        row,
        reservation.reason ?? "reservation-refused",
        services,
        { compensate: nonEmptyString(row.reservation_id) },
      );
      return null;
    }
    const nextState = row.state === "pending" ? "reserved" : row.state;
    this.#updateOutbox(
      row.runner_request_id,
      { state: nextState, reservation_id: reservation.reservationId },
      services,
    );
    this.#emit(
      "runner-reserved",
      {
        runnerRequestId: row.runner_request_id,
        registryCorrelation: row.correlation_id,
        reservationId: reservation.reservationId,
        repository: row.repository,
        wave: row.wave,
      },
      services,
    );
    return reservation;
  }

  async #reservationForDispatch(row, config, deadlineMs, services) {
    if (row.state === "pending") {
      return this.#reserveDispatch(row, config, deadlineMs, services);
    }
    const replay = await this.#reserveDispatch(
      row,
      config,
      deadlineMs,
      services,
    );
    if (
      replay !== null &&
      nonEmptyString(row.reservation_id) &&
      replay.reservationId !== row.reservation_id
    ) {
      await this.#failDispatch(
        row,
        "reservation-identity-changed",
        services,
      );
      return null;
    }
    return replay;
  }

  async #ownedRunnerRegistration(row, deadlineMs, services) {
    const state = this.#listenerState();
    const registration = await (
      services.getRunnerByName ?? getRunnerByName
    )(
      {
        actionsServiceUrl: state.actions_service_url,
        adminToken: state.admin_token,
        name: row.runner_name,
        deadlineMs,
      },
      services.clientServices ?? {},
    );
    if (registration === null) {
      return { outcome: "absent" };
    }
    if (registration.name !== row.runner_name) {
      return { outcome: "not-owned", registration };
    }
    return runnerIsBusy(registration)
      ? { outcome: "busy", registration }
      : { outcome: "idle", registration };
  }

  async #settleExpiredReservations(workDeadlineMs, services) {
    const cutoffMs = nowFunction(services)() -
      ACTIVE_RUNNER_CLEANUP_DELAY_MS;
    // Successful settlement removes a row from this population. The rotation
    // key lets later rows drain after a failure or an elapsed work deadline.
    const rows = this.sql.exec(
      `SELECT * FROM dispatch_outbox
       WHERE reservation_id IS NOT NULL
         AND reservation_released_at_ms IS NULL
         AND updated_at_ms <= ?
       ORDER BY COALESCE(settle_checked_at_ms, 0) ASC, updated_at_ms ASC
       LIMIT ?`,
      cutoffMs,
      MAX_LIVENESS_PROBES_PER_PASS,
    ).toArray();

    for (const row of rows) {
      const checkedAtMs = nowFunction(services)();
      // Stamp before the deadline check and compensation. A deadline or a
      // throwing compensation then rotates this row instead of blocking the
      // queue.
      this.sql.exec(
        `UPDATE dispatch_outbox
         SET settle_checked_at_ms = ?
         WHERE runner_request_id = ?`,
        checkedAtMs,
        row.runner_request_id,
      );
      if (checkedAtMs >= workDeadlineMs) {
        break;
      }
      try {
        // Compensation treats reservation-not-found as success and releases a
        // reservation that still exists, so settlement cannot strand it.
        await this.#compensateReservation(
          row,
          "reservation-expired",
          services,
        );
        this.#emit(
          "reservation-expired-settled",
          {
            runnerRequestId: row.runner_request_id,
            registryCorrelation: row.correlation_id,
            runnerName: row.runner_name,
            reservationId: row.reservation_id,
            ageMs: nowFunction(services)() - row.updated_at_ms,
            repository: row.repository,
            wave: row.wave,
          },
          services,
        );
      } catch (error) {
        this.#emit(
          "reservation-expired-settle-failed",
          {
            runnerRequestId: row.runner_request_id,
            registryCorrelation: row.correlation_id,
            runnerName: row.runner_name,
            reservationId: row.reservation_id,
            ageMs: nowFunction(services)() - row.updated_at_ms,
            repository: row.repository,
            wave: row.wave,
            settleCheckedAtMs: checkedAtMs,
            error: safeErrorMessage(error),
          },
          services,
        );
      }
    }
  }

  async #reclaimUndeliveredRunnerReservations(workDeadlineMs, services) {
    const cutoffMs = nowFunction(services)() -
      RUNNER_LIVENESS_PROBE_MIN_AGE_MS;
    // This registry is our own Durable Object. Do not inherit GitHub admin
    // connection failures; 14 of 132 historical probe failures were 401s.
    // Exact correlation needs no runner-name prefix. Such a prefix permanently
    // excluded 97 rows while their live reservation count stayed frozen.
    // Do not use the liveness attempt counter. Exhausted rows became permanently
    // unreclaimable. The pass limit and work deadline bound each pass, so the
    // next pass retries a transient failure instead of abandoning the row.
    const rows = this.sql.exec(
      `SELECT * FROM dispatch_outbox
       WHERE state = 'started'
         AND reservation_id IS NOT NULL
         AND reservation_released_at_ms IS NULL
         AND updated_at_ms <= ?
       ORDER BY COALESCE(undelivered_checked_at_ms, 0) ASC, updated_at_ms ASC
       LIMIT ?`,
      cutoffMs,
      MAX_LIVENESS_PROBES_PER_PASS,
    ).toArray();

    let examined = 0;
    let reclaimed = 0;
    let lookupFailed = 0;
    let absentRegistry = 0;
    const causes = {};
    for (const row of rows) {
      const checkedAtMs = nowFunction(services)();
      // Stamp before the deadline check and registry lookup. A deadline or a
      // throwing lookup then rotates this row instead of blocking the queue.
      this.sql.exec(
        `UPDATE dispatch_outbox
         SET undelivered_checked_at_ms = ?
         WHERE runner_request_id = ?`,
        checkedAtMs,
        row.runner_request_id,
      );
      if (checkedAtMs >= workDeadlineMs) {
        break;
      }
      const runnerRequestId = row.runner_request_id;
      const registryCorrelation = row.correlation_id;
      const runnerName = row.runner_name;
      const repository = row.repository;
      const wave = row.wave;
      let runner = null;
      try {
        runner = await this.#getStartByCorrelation(
          registryCorrelation,
          services,
        );
      } catch (error) {
        lookupFailed += 1;
        this.#emit(
          "runner-undelivered-check-failed",
          {
            runnerRequestId,
            registryCorrelation,
            runnerName,
            repository,
            wave,
            error: safeErrorMessage(error),
          },
          services,
        );
        continue;
      }
      if (runner === null) {
        absentRegistry += 1;
        // An absent registry row is ambiguous and cannot prove non-delivery.
        continue;
      }
      examined += 1;
      const cause = runner.cleanupRequestedBy ?? "null";
      causes[cause] = (causes[cause] ?? 0) + 1;
      // A callback means the runner ran and finished. Reclaiming it could
      // release a live runner's reservation.
      if (runner.cleanupRequestedBy !== "startup-failure") {
        continue;
      }
      await this.#compensateReservation(
        row,
        "runner-undelivered",
        services,
      );
      reclaimed += 1;
      this.#emit(
        "runner-undelivered",
        {
          runnerRequestId,
          registryCorrelation,
          runnerName,
          sandboxId: runner.sandboxId ?? null,
          registryState: runner.state,
          cleanupRequestedBy: runner.cleanupRequestedBy,
          reservationId: row.reservation_id,
          repository,
          wave,
        },
        services,
      );
    }

    // This diagnostic stays out of export_outbox. Derive its clock from the
    // cutoff so the scenario clock does not consume an additional tick.
    this.#logWithoutPersistence(
      "runner-undelivered-pass",
      {
        candidates: rows.length,
        examined,
        reclaimed,
        lookupFailed,
        absentRegistry,
        causes,
      },
      {
        ...services,
        now: () => cutoffMs + RUNNER_LIVENESS_PROBE_MIN_AGE_MS,
      },
      "log",
    );
  }

  async #releaseDeregisteredRunnerReservations(
    config,
    workDeadlineMs,
    services,
  ) {
    const cutoffMs = nowFunction(services)() -
      RUNNER_LIVENESS_PROBE_MIN_AGE_MS;
    const scaleSetId = this.#listenerState().scale_set_id;
    const runnerNamePrefix = isPositiveSafeInteger(scaleSetId)
      ? `cloudflare-${scaleSetId}-`
      : null;
    let rows;
    if (runnerNamePrefix === null) {
      rows = this.sql.exec(
        `SELECT * FROM dispatch_outbox
         WHERE state = 'started'
           AND reservation_id IS NOT NULL
           AND reservation_released_at_ms IS NULL
           AND liveness_probe_attempts < ?
           AND updated_at_ms <= ?
         ORDER BY COALESCE(liveness_probed_at_ms, 0) ASC, updated_at_ms ASC
         LIMIT ?`,
        MAX_LIVENESS_PROBE_ATTEMPTS,
        cutoffMs,
        MAX_LIVENESS_PROBES_PER_PASS,
      ).toArray();
    } else {
      const outOfScopeCount = this.sql.exec(
        `SELECT COUNT(*) AS count
         FROM dispatch_outbox
         WHERE state = 'started'
           AND reservation_id IS NOT NULL
           AND reservation_released_at_ms IS NULL
           AND liveness_probe_attempts < ?
           AND updated_at_ms <= ?
           AND (runner_name IS NULL OR runner_name NOT LIKE ?)`,
        MAX_LIVENESS_PROBE_ATTEMPTS,
        cutoffMs,
        `${runnerNamePrefix}%`,
      ).toArray()[0]?.count ?? 0;
      if (outOfScopeCount > 0) {
        this.#emitScaleUpDecision(
          "liveness-probe-scope-skipped",
          { count: outOfScopeCount },
          services,
        );
      }
      rows = this.sql.exec(
        `SELECT * FROM dispatch_outbox
         WHERE state = 'started'
           AND reservation_id IS NOT NULL
           AND reservation_released_at_ms IS NULL
           AND liveness_probe_attempts < ?
           AND updated_at_ms <= ?
           AND runner_name LIKE ?
         ORDER BY COALESCE(liveness_probed_at_ms, 0) ASC, updated_at_ms ASC
         LIMIT ?`,
        MAX_LIVENESS_PROBE_ATTEMPTS,
        cutoffMs,
        `${runnerNamePrefix}%`,
        MAX_LIVENESS_PROBES_PER_PASS,
      ).toArray();
    }

    // Non-absent probe outcomes were previously invisible. This diagnostic-only
    // pass log uses #logWithoutPersistence to stay out of export_outbox.
    // The clock is derived, not read: a real now() call consumes a scenario
    // clock tick and shifts every deadline the surrounding pass measures.
    // cutoffMs is now() - RUNNER_LIVENESS_PROBE_MIN_AGE_MS, so this restores it.
    this.#logWithoutPersistence(
      "runner-liveness-probe-pass",
      { candidates: rows.length },
      {
        ...services,
        now: () => cutoffMs + RUNNER_LIVENESS_PROBE_MIN_AGE_MS,
      },
      "log",
    );
    if (rows.length === 0) {
      return;
    }
    const connection = await this.#ensureAdminConnection(
      config,
      workDeadlineMs,
      services,
    );
    if (!adminConnectionIsValid(connection)) {
      this.#emitScaleUpDecision(
        "runner-liveness-probe-skipped",
        { reason: "admin-connection-invalid" },
        services,
      );
      return;
    }

    // A started row receives updated_at_ms when its state becomes started.
    for (const row of rows) {
      if (nowFunction(services)() >= workDeadlineMs) {
        break;
      }
      const attempt = this.sql.exec(
        `UPDATE dispatch_outbox
         SET liveness_probe_attempts = liveness_probe_attempts + 1,
             liveness_probed_at_ms = ?
         WHERE runner_request_id = ?
         RETURNING liveness_probe_attempts`,
        nowFunction(services)(),
        row.runner_request_id,
      ).toArray()[0];
      if (attempt === undefined) {
        continue;
      }
      try {
        const registration = await this.#ownedRunnerRegistration(
          row,
          workDeadlineMs,
          services,
        );
        // Non-absent probe outcomes were previously invisible. This diagnostic-only
        // outcome log uses #logWithoutPersistence to stay out of export_outbox.
        this.#logWithoutPersistence(
          "runner-liveness-probe-observed",
          {
            runnerRequestId: row.runner_request_id,
            registryCorrelation: row.correlation_id,
            runnerName: row.runner_name,
            outcome: registration.outcome,
            busy: registration.outcome === "busy",
            attempts: attempt.liveness_probe_attempts,
            startedAgeMs: nowFunction(services)() - row.updated_at_ms,
            repository: row.repository,
            wave: row.wave,
          },
          services,
          "log",
        );
        if (registration.outcome === "absent") {
          await this.#compensateReservation(
            row,
            "runner-deregistered",
            services,
          );
          this.#emit(
            "runner-deregistered",
            {
              runnerRequestId: row.runner_request_id,
              registryCorrelation: row.correlation_id,
              runnerName: row.runner_name,
              runnerId: row.runner_id,
              reservationId: row.reservation_id,
              repository: row.repository,
              wave: row.wave,
            },
            services,
          );
        } else {
          this.sql.exec(
            `UPDATE dispatch_outbox
             SET liveness_probe_attempts = 0
             WHERE runner_request_id = ?`,
            row.runner_request_id,
          );
          // A busy registration proves the platform delivered the container and
          // that it is executing a job. #reconcileLostStart writes state
          // 'started' without spawn_observed, because a recovered start record
          // does not prove delivery, and nothing else ever sets that bit. The
          // census then reads unproven delivery as a failed spawn. A busy probe
          // is the proof that was missing.
          // The promotion is one-way. The guard on spawn_observed = 0 means a
          // later idle or absent probe can never take the bit back.
          // This update deliberately leaves updated_at_ms alone, so promoting a
          // row does not move it out of the census or probe age windows.
          if (
            registration.outcome === "busy" &&
            row.spawn_observed !== 1
          ) {
            this.sql.exec(
              `UPDATE dispatch_outbox
               SET spawn_observed = 1
               WHERE runner_request_id = ?
                 AND spawn_observed = 0`,
              row.runner_request_id,
            );
            this.#emit(
              "runner-spawn-proven",
              {
                runnerRequestId: row.runner_request_id,
                registryCorrelation: row.correlation_id,
                runnerName: row.runner_name,
                runnerId: row.runner_id,
                startedAgeMs: nowFunction(services)() - row.updated_at_ms,
                repository: row.repository,
                wave: row.wave,
              },
              services,
            );
          }
          // An owned idle registration past the acquisition deadline is
          // delivery evidence from GitHub itself. The busy promotion above
          // covers a runner that took a job. It cannot reach a surplus runner
          // that never got one, and that runner is never busy, so its
          // spawn_observed stays zero for ever. Gating this teardown on the bit
          // left such a reservation live until the one-hour backstop, which
          // held liveReservationCount above desired and drove shortfall to
          // zero. spawn_observed remains the census's delivery-proof signal and
          // is deliberately not written here.
          if (registration.outcome !== "idle") {
            continue;
          }
          const startClockOriginMs = this.#startClockOriginOrNull(
            row.runner_request_id,
          );
          if (startClockOriginMs === null) {
            continue;
          }
          const observedAtMs = nowFunction(services)();
          const acquisitionDeadlineMs = startClockOriginMs +
            START_DEADLINE_MS;
          if (observedAtMs <= acquisitionDeadlineMs) {
            continue;
          }
          // The outbox does not store the sandbox identifier. The Worker
          // registry keeps it under the durable dispatch correlation.
          const runner = await this.#getStartByCorrelation(
            row.correlation_id,
            services,
          );
          this.#updateOutbox(
            row.runner_request_id,
            {
              state: "failed",
              last_error: "runner-unassigned",
              jit_config: null,
            },
            services,
          );
          const failedRow = this.#outboxRow(row.runner_request_id);
          await this.#compensateReservation(
            failedRow,
            "runner-unassigned",
            services,
          );
          await this.#scheduleRunnerCleanup(runner?.sandboxId, services);
          this.#emit(
            "runner-unassigned",
            {
              runnerRequestId: failedRow.runner_request_id,
              registryCorrelation: failedRow.correlation_id,
              runnerName: failedRow.runner_name,
              runnerId: failedRow.runner_id,
              reservationId: failedRow.reservation_id,
              acquisitionDeadlineMs,
              ageMs: observedAtMs - startClockOriginMs,
              repository: failedRow.repository,
              wave: failedRow.wave,
            },
            services,
          );
          continue;
        }
      } catch (error) {
        const fields = {
          runnerRequestId: row.runner_request_id,
          registryCorrelation: row.correlation_id,
          runnerName: row.runner_name,
          runnerId: row.runner_id,
          reservationId: row.reservation_id,
          repository: row.repository,
          wave: row.wave,
          error: safeErrorMessage(error),
        };
        try {
          this.#emit("runner-liveness-probe-failed", fields, services);
        } catch (emitError) {
          this.#logWithoutPersistence(
            "runner-liveness-probe-failed",
            {
              ...fields,
              eventPersistenceError: safeErrorMessage(emitError),
            },
            services,
          );
        }
      }
      if (
        attempt.liveness_probe_attempts === MAX_LIVENESS_PROBE_ATTEMPTS &&
        this.sql.exec(
          `SELECT 1 FROM dispatch_outbox
           WHERE runner_request_id = ?
             AND state = 'started'
             AND reservation_id IS NOT NULL
             AND reservation_released_at_ms IS NULL`,
          row.runner_request_id,
        ).toArray().length === 1
      ) {
        const fields = {
          runnerRequestId: row.runner_request_id,
          registryCorrelation: row.correlation_id,
          runnerName: row.runner_name,
          runnerId: row.runner_id,
          reservationId: row.reservation_id,
          repository: row.repository,
          wave: row.wave,
          attempts: attempt.liveness_probe_attempts,
        };
        try {
          this.#emit("runner-liveness-probe-abandoned", fields, services);
        } catch (emitError) {
          this.#logWithoutPersistence(
            "runner-liveness-probe-abandoned",
            {
              ...fields,
              eventPersistenceError: safeErrorMessage(emitError),
            },
            services,
          );
        }
      }
    }
  }

  async #prepareForJit(row, deadlineMs, services) {
    const persistedName = row.runner_name ?? runnerName(
      this.#listenerState().scale_set_id,
      row.runner_request_id,
    );
    if (row.runner_name === null) {
      this.#updateOutbox(
        row.runner_request_id,
        { runner_name: persistedName },
        services,
      );
    }
    row = this.#outboxRow(row.runner_request_id);
    const existing = await this.#ownedRunnerRegistration(
      row,
      deadlineMs,
      services,
    );
    if (existing.outcome === "not-owned") {
      await this.#failDispatch(
        row,
        "runner-registration-ownership-mismatch",
        services,
      );
      return false;
    }
    if (existing.outcome === "busy") {
      await this.#failDispatch(
        row,
        "busy-registration-preserved",
        services,
      );
      return false;
    }
    if (existing.outcome === "idle") {
      await (
        services.removeRunner ?? removeRunner
      )(
        {
          actionsServiceUrl: this.#listenerState().actions_service_url,
          adminToken: this.#listenerState().admin_token,
          runnerId: existing.registration.id,
          deadlineMs,
        },
        services.clientServices ?? {},
      );
      this.#emit(
        "idle-runner-registration-removed",
        {
          runnerRequestId: row.runner_request_id,
          registryCorrelation: row.correlation_id,
          runnerName: row.runner_name,
          runnerId: existing.registration.id,
          repository: row.repository,
          wave: row.wave,
        },
        services,
      );
    }
    return true;
  }

  async #generateJit(row, deadlineMs, services) {
    if (!await this.#prepareForJit(row, deadlineMs, services)) {
      return null;
    }
    row = this.#outboxRow(row.runner_request_id);
    if (this.#isCancelled(row.runner_request_id)) {
      await this.#cancelDispatch(row, services);
      return null;
    }
    this.#updateOutbox(
      row.runner_request_id,
      { state: "jit-requested", last_error: null },
      services,
    );
    this.#emit(
      "runner-jit-requested",
      {
        runnerRequestId: row.runner_request_id,
        registryCorrelation: row.correlation_id,
        runnerName: row.runner_name,
        repository: row.repository,
        wave: row.wave,
      },
      services,
    );

    let jit;
    try {
      jit = await (
        services.generateJitRunnerConfig ?? generateJitRunnerConfig
      )(
        {
          actionsServiceUrl: this.#listenerState().actions_service_url,
          adminToken: this.#listenerState().admin_token,
          scaleSetId: this.#listenerState().scale_set_id,
          name: row.runner_name,
          workFolder: services.workFolder ?? DEFAULT_WORK_FOLDER,
          deadlineMs,
        },
        services.clientServices ?? {},
      );
    } catch (error) {
      if (ambiguousExternalResult(error)) {
        this.#updateOutbox(
          row.runner_request_id,
          { last_error: "jit-response-ambiguous" },
          services,
        );
        this.#emit(
          "runner-jit-response-ambiguous",
          {
            runnerRequestId: row.runner_request_id,
            registryCorrelation: row.correlation_id,
            runnerName: row.runner_name,
            repository: row.repository,
            wave: row.wave,
            error: safeErrorMessage(error),
          },
          services,
        );
        return null;
      }
      throw error;
    }
    if (jit.runner.name !== row.runner_name) {
      await this.#failDispatch(row, "jit-runner-name-mismatch", services);
      return null;
    }
    this.#holdSecretValues(jit.encodedJITConfig);
    this.#updateOutbox(
      row.runner_request_id,
      {
        state: "jit-ready",
        runner_id: jit.runner.id,
        jit_config: jit.encodedJITConfig,
        last_error: null,
      },
      services,
    );
    return {
      runner: jit.runner,
      encodedJITConfig: jit.encodedJITConfig,
    };
  }

  async #fetchWithDeadline(url, init, deadlineMs, services) {
    const remainingMs = deadlineMs - nowFunction(services)();
    if (remainingMs <= 0) {
      throw new RequestBudgetExhausted(
        "The outbound request deadline has no remaining budget",
      );
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), remainingMs);
    try {
      return await (services.fetch ?? globalThis.fetch)(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async #startRunnerRequest(body, correlationId, deadlineMs, config, services) {
    if (services.startRunner !== undefined) {
      return services.startRunner({ body, correlationId, deadlineMs });
    }
    const workerUrl = config.workerUrl ?? this.env.AUTOPILOT_WORKER_URL;
    if (!nonEmptyString(workerUrl)) {
      throw new InvalidListenerConfiguration(
        "AUTOPILOT_WORKER_URL is not configured",
      );
    }
    const url = new URL("/runners", workerUrl).toString();
    const response = await this.#fetchWithDeadline(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.CONTROL_TOKEN}`,
          "Content-Type": "application/json",
          "Idempotency-Key": correlationId,
        },
        body: JSON.stringify(body),
      },
      deadlineMs,
      services,
    );
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload };
  }

  async #getStartByCorrelation(correlationId, services) {
    if (services.getStartByCorrelation !== undefined) {
      return services.getStartByCorrelation(correlationId);
    }
    if (this.env.RunnerRegistry === undefined) {
      return null;
    }
    const registry = this.env.RunnerRegistry.get(
      this.env.RunnerRegistry.idFromName(RUNNER_REGISTRY_NAME),
    );
    return registry.getByCorrelation(correlationId);
  }

  async #activeRunnerCount(services) {
    // RunnerRegistry is one singleton for every scale set, so this count is
    // fleet-wide. A drain can wait for another scale set's runners. This safe
    // limitation cannot produce a false drained result.
    try {
      if (services.activeRunnerCount !== undefined) {
        return await services.activeRunnerCount();
      }
      if (this.env.RunnerRegistry === undefined) {
        throw new Error("RunnerRegistry is not configured");
      }
      const registry = this.env.RunnerRegistry.get(
        this.env.RunnerRegistry.idFromName(RUNNER_REGISTRY_NAME),
      );
      // This is a liveness count. Use an inclusive cutoff that cannot exclude
      // a live row written by a RunnerRegistry clock ahead of this listener.
      const result = await registry.listActiveBefore(
        Number.MAX_SAFE_INTEGER,
      );
      if (
        !Array.isArray(result?.runners) ||
        typeof result?.hasMore !== "boolean"
      ) {
        throw new Error("RunnerRegistry returned an invalid active runner list");
      }
      const { runners, hasMore } = result;
      return runners.length + (hasMore ? 1 : 0);
    } catch (error) {
      this.#emit(
        "drain-runner-inventory-unavailable",
        { error: safeErrorMessage(error) },
        services,
      );
      return null;
    }
  }

  async #scheduleRunnerCleanup(sandboxId, services) {
    if (!nonEmptyString(sandboxId)) {
      return;
    }
    if (services.scheduleCleanup !== undefined) {
      await services.scheduleCleanup(sandboxId);
      return;
    }
    if (this.env.RunnerRegistry === undefined) {
      return;
    }
    const registry = this.env.RunnerRegistry.get(
      this.env.RunnerRegistry.idFromName(RUNNER_REGISTRY_NAME),
    );
    await registry.beginStartupCleanup(
      sandboxId,
      new Date(nowFunction(services)()).toISOString(),
    );
  }

  #recordReconciledStart(row, runner, reason, services) {
    // A non-null reconcile proves only that the Worker recorded a start
    // attempt, not that a container exists. This event is an inference, and
    // runner-spawned remains the observed-start counter.
    this.#emit(
      "runner-start-reconciled",
      {
        runnerRequestId: row.runner_request_id,
        registryCorrelation: row.correlation_id,
        runnerName: row.runner_name,
        runnerId: row.runner_id,
        sandboxId: runner?.sandboxId ?? null,
        repository: row.repository,
        wave: row.wave,
        reason,
      },
      services,
    );
  }

  async #reconcileLostStart(
    row,
    reason,
    services,
    { emit = true, failureClass = null } = {},
  ) {
    const runner = await this.#getStartByCorrelation(
      row.correlation_id,
      services,
    );
    // One record per reconcile, written at the single choke point where the
    // entry reason is still in scope. Deliberately NOT gated on `emit`: that
    // flag suppresses only the runner-start-reconciled delivery inference,
    // which two callers re-emit with better information. The census must count
    // every reconcile, including the ones that end in a failure.
    // It is written before the state transition below, so a throwing
    // compensation can never swallow the record.
    // last_error cannot carry this signal: it is live row state that the next
    // transition overwrites, and the success path clears it by design.
    this.#emit(
      "runner-start-reconcile-attempted",
      {
        runnerRequestId: row.runner_request_id,
        registryCorrelation: row.correlation_id,
        runnerName: row.runner_name,
        runnerId: row.runner_id,
        sandboxId: runner?.sandboxId ?? null,
        repository: row.repository,
        wave: row.wave,
        reason,
        outcome: runner === null ? "start-absent" : "start-recovered",
        startErrorClass: failureClass,
      },
      services,
    );
    if (runner === null) {
      // Absence cannot prove non-delivery because the Worker can record this
      // start after the lookup. Eager compensation could then over-admit.
      // Keep the reservation until #settleExpiredReservations drains it after
      // ACTIVE_RUNNER_CLEANUP_DELAY_MS; that query deliberately has no state
      // filter, so this failed row remains eligible for the backstop.
      await this.#failDispatch(
        row,
        "start-response-ambiguous",
        services,
        { compensate: false },
      );
      return null;
    }
    // Keep spawn_observed at zero. A reconciled start proves only that the
    // Worker recorded an attempt before the container existed. It does not
    // prove that the platform delivered a container.
    this.#updateOutbox(
      row.runner_request_id,
      { state: "started", last_error: null, jit_config: null },
      services,
    );
    if (emit) {
      this.#recordReconciledStart(row, runner, reason, services);
    }
    return runner;
  }

  async #recordDeadlineExceededAfterStart(
    runnerRequestId,
    payload,
    services,
  ) {
    this.#updateOutbox(
      runnerRequestId,
      {
        state: "failed",
        last_error: "deadline-exceeded-after-start",
        jit_config: null,
      },
      services,
    );
    const failedRow = this.#outboxRow(runnerRequestId);
    await this.#compensateReservation(
      failedRow,
      "deadline-exceeded-after-start",
      services,
    );
    await this.#scheduleRunnerCleanup(payload?.sandboxId, services);
    this.#emit(
      "runner-spawn-failed",
      {
        runnerRequestId: failedRow.runner_request_id,
        registryCorrelation: failedRow.correlation_id,
        sandboxId: payload?.sandboxId ?? null,
        runnerName: payload?.runnerName ?? failedRow.runner_name,
        runnerId: failedRow.runner_id,
        repository: failedRow.repository,
        wave: failedRow.wave,
        reason: "deadline-exceeded-after-start",
      },
      services,
    );
  }

  async #issueStart(row, reservation, config, startDeadlineMs, services) {
    if (this.#isCancelled(row.runner_request_id)) {
      await this.#cancelDispatch(row, services);
      return;
    }
    const elapsedMs = nowFunction(services)() -
      this.#startClockOrigin(row.runner_request_id);
    if (elapsedMs > START_DEADLINE_MS) {
      await this.#failDispatch(row, "deadline-exceeded", services);
      return;
    }
    const jitConfig = row.jit_config;
    if (!nonEmptyString(jitConfig)) {
      await this.#reconcileLostStart(
        row,
        "jit-config-missing",
        services,
      );
      return;
    }
    const body = {
      jitConfig,
      repository: row.repository,
      reservation: {
        expiresAtMs: reservation.expiresAtMs,
        gateGeneration: reservation.gateGeneration,
        reservationId: reservation.reservationId,
        token: reservation.token,
      },
      runnerRequestId: row.runner_request_id,
      scaleSetId: this.#listenerState().scale_set_id,
      wave: row.wave,
    };
    this.#updateOutbox(
      row.runner_request_id,
      { state: "start-requested", last_error: null },
      services,
    );
    if (this.#isCancelled(row.runner_request_id)) {
      await this.#cancelDispatch(this.#outboxRow(row.runner_request_id), services);
      return;
    }

    let result;
    try {
      result = await this.#startRunnerRequest(
        body,
        row.correlation_id,
        startDeadlineMs,
        config,
        services,
      );
    } catch (error) {
      this.#updateOutbox(
        row.runner_request_id,
        { jit_config: null, last_error: "start-response-ambiguous" },
        services,
      );
      const reconciled = await this.#reconcileLostStart(
        this.#outboxRow(row.runner_request_id),
        "start-response-ambiguous",
        services,
        { emit: false, failureClass: startFailureClass(error) },
      );
      if (
        reconciled !== null &&
        nowFunction(services)() - this.#startClockOrigin(
            row.runner_request_id,
          ) > START_DEADLINE_MS
      ) {
        await this.#recordDeadlineExceededAfterStart(
          row.runner_request_id,
          reconciled,
          services,
        );
      } else if (reconciled === null) {
        this.#emit(
          "runner-start-response-ambiguous",
          {
            runnerRequestId: row.runner_request_id,
            registryCorrelation: row.correlation_id,
            runnerName: row.runner_name,
            runnerId: row.runner_id,
            repository: row.repository,
            wave: row.wave,
            error: safeErrorMessage(error),
          },
          services,
          [jitConfig],
        );
      } else {
        this.#recordReconciledStart(
          this.#outboxRow(row.runner_request_id),
          reconciled,
          "start-response-ambiguous",
          services,
        );
      }
      return;
    } finally {
      this.#updateOutbox(
        row.runner_request_id,
        { jit_config: null },
        services,
      );
    }

    const status = result?.status ?? (result?.created === false ? 200 : 202);
    const payload = result?.payload ?? result?.runner ?? result;
    if (status !== 200 && status !== 202) {
      await this.#failDispatch(
        this.#outboxRow(row.runner_request_id),
        `start-request-failed:${status}`,
        services,
        {
          startFailureReason: typeof payload?.reason === "string"
            ? payload.reason
            : null,
        },
      );
      return;
    }
    this.#updateOutbox(
      row.runner_request_id,
      {
        state: "started",
        spawn_observed: 1,
        last_error: null,
        jit_config: null,
      },
      services,
    );
    const afterStartElapsedMs = nowFunction(services)() -
      this.#startClockOrigin(row.runner_request_id);
    if (afterStartElapsedMs > START_DEADLINE_MS) {
      await this.#recordDeadlineExceededAfterStart(
        row.runner_request_id,
        payload,
        services,
      );
      return;
    }
    this.#clearPaceBackoff(services);
    this.#emit(
      "runner-spawned",
      {
        runnerRequestId: row.runner_request_id,
        registryCorrelation: row.correlation_id,
        sandboxId: payload?.sandboxId ?? null,
        runnerName: payload?.runnerName ?? row.runner_name,
        runnerId: row.runner_id,
        repository: row.repository,
        wave: row.wave,
      },
      services,
    );
  }

  async #dispatchOne(candidate, config, workDeadlineMs, services) {
    let row = this.#outboxRow(candidate.runner_request_id);
    if (row === null || TERMINAL_OUTBOX_STATES.includes(row.state)) {
      this.#emitScaleUpDecision(
        "dispatch-deferred",
        {
          reason: row === null ? "row-absent" : "already-terminal",
          runnerRequestId: candidate.runner_request_id,
          ...(row === null ? {} : { state: row.state }),
        },
        services,
      );
      return;
    }
    this.sql.exec(
      `UPDATE dispatch_outbox
       SET attempts = attempts + 1
       WHERE runner_request_id = ?`,
      row.runner_request_id,
    );
    if (this.#isCancelled(row.runner_request_id)) {
      await this.#cancelDispatch(row, services);
      return;
    }
    const startClockOriginMs = this.#startClockOrigin(row.runner_request_id);
    const requestDeadlineMs = startClockOriginMs + START_DEADLINE_MS;
    if (nowFunction(services)() - startClockOriginMs > START_DEADLINE_MS) {
      await this.#failDispatch(row, "deadline-exceeded", services);
      return;
    }
    const deadlineMs = Math.min(workDeadlineMs, requestDeadlineMs);
    const nowMs = nowFunction(services)();
    if (deadlineMs <= nowMs) {
      this.#emitScaleUpDecision(
        "dispatch-deferred",
        {
          reason: "work-budget-exhausted",
          runnerRequestId: row.runner_request_id,
          registryCorrelation: row.correlation_id,
          runnerName: row.runner_name,
          state: row.state,
          remainingMs: deadlineMs - nowMs,
          jitRegistered: row.state === "jit-ready" ||
            row.state === "start-requested",
        },
        services,
      );
      return;
    }

    const connection = await this.#ensureAdminConnection(
      config,
      deadlineMs,
      services,
    );
    if (!adminConnectionIsValid(connection)) {
      throw new Error("The dispatch has no Actions Service connection");
    }
    let reservation = await this.#reservationForDispatch(
      row,
      config,
      deadlineMs,
      services,
    );
    if (reservation === null) {
      return;
    }
    row = this.#outboxRow(row.runner_request_id);
    if (this.#isCancelled(row.runner_request_id)) {
      await this.#cancelDispatch(row, services);
      return;
    }
    if (row.state !== "jit-ready" && row.state !== "start-requested") {
      const jit = await this.#generateJit(row, deadlineMs, services);
      if (jit === null) {
        return;
      }
    }
    row = this.#outboxRow(row.runner_request_id);
    if (this.#isCancelled(row.runner_request_id)) {
      await this.#cancelDispatch(row, services);
      return;
    }
    if (nowFunction(services)() - startClockOriginMs > START_DEADLINE_MS) {
      await this.#failDispatch(row, "deadline-exceeded", services);
      return;
    }
    const controlStatus = await this.#controlStatus(services);
    if (
      controlStatus.localGate === "closed" ||
      controlStatus.maxCapacity <= 0
    ) {
      await this.#failDispatch(row, "local-gate-closed", services);
      return;
    }
    await this.#issueStart(
      row,
      reservation,
      config,
      deadlineMs,
      services,
    );
  }

  async #dispatchOutbox(config, workDeadlineMs, services) {
    const nowMs = nowFunction(services)();
    if (nowMs >= workDeadlineMs) {
      const deferred = this.#activeOutboxCount();
      this.#emitScaleUpDecision(
        "dispatch-deferred",
        { reason: "pass-budget-exhausted", deferred },
        services,
      );
      return { selected: 0, deferred };
    }
    // The pace decides when a start is issued. This width decides how many
    // chains run at once. A chain holds one connection and the long poll holds
    // the reserve, so five chains reach the platform connection bound.
    const inFlight = this.dispatchInFlight.size;
    const capacity = MAX_DISPATCH_CONCURRENCY - inFlight;
    if (capacity <= 0) {
      const deferred = this.#activeOutboxCount();
      if (deferred > 0) {
        this.#emitScaleUpDecision(
          "dispatch-deferred",
          {
            reason: "dispatch-width",
            inFlight,
            maxDispatchConcurrency: MAX_DISPATCH_CONCURRENCY,
            deferred,
          },
          services,
        );
      }
      return { selected: 0, deferred };
    }
    const {
      permitted,
      waitMs,
      paceMs,
      sinceLastStartMs,
    } = this.#pacePermits(nowMs);
    if (permitted === 0) {
      const deferred = this.#activeOutboxCount();
      if (deferred > 0) {
        this.#emitScaleUpDecision(
          "dispatch-deferred",
          {
            reason: "start-pace",
            paceMs,
            waitMs,
            sinceLastStartMs,
            deferred,
          },
          services,
        );
      }
      return { selected: 0, deferred };
    }
    // A row holds an active state for its whole chain. The pass does not await
    // the chain, so a later pass would select the same request again and start
    // two containers for it. This exclusion is load-bearing.
    const inFlightIds = [...this.dispatchInFlight.keys()];
    const exclusion = inFlightIds.length === 0
      ? ""
      : `AND runner_request_id NOT IN (${
        inFlightIds.map(() => "?").join(", ")
      })`;
    const candidates = this.sql.exec(
      `SELECT runner_request_id
       FROM dispatch_outbox
       WHERE state IN (${ACTIVE_OUTBOX_STATES_SQL})
         ${exclusion}
       ORDER BY updated_at_ms, runner_request_id
       LIMIT ?`,
      ...inFlightIds,
      Math.min(capacity, permitted),
    ).toArray();
    if (candidates.length > 0) {
      this.#recordStartIssued(nowMs);
    }
    // The pass launches the chain and returns. The pace then times the next
    // start against this issue, not against the chain that is still running.
    for (const row of candidates) {
      const id = row.runner_request_id;
      const chain = this.#track(
        this.#dispatchOne(row, config, workDeadlineMs, services),
      ).catch((reason) => {
        this.dispatchFailures.push({ reason, runnerRequestId: id });
      }).finally(() => {
        this.dispatchInFlight.delete(id);
      });
      this.dispatchInFlight.set(id, chain);
    }
    // The launched chain settles after this pass returns, so its failure reaches
    // the emit and the recovery throw on the following pass. The alarm drain
    // holds a last-pass failure for the next alarm. The outbox row is durable, so
    // a lost carry-over retries and raises the same failure again.
    const failures = this.dispatchFailures.splice(0);
    for (const failure of failures) {
      this.#emit(
        "dispatch-rejected",
        {
          error: safeErrorMessage(
            failure.reason instanceof Error
              ? failure.reason.message
              : failure.reason,
          ),
          runnerRequestId: failure.runnerRequestId,
        },
        services,
      );
    }
    if (failures.length > 0) {
      const representative = failures.find((failure) =>
        isSqliteFullError(failure.reason)
      ) ?? failures.find((failure) =>
        recoveryConditionForError(failure.reason) !== null
      ) ?? failures[0];
      throw representative.reason;
    }
    return {
      selected: candidates.length,
      deferred: this.#activeOutboxCount(),
    };
  }

  async #settleDrainOutbox(workDeadlineMs, services) {
    const rows = this.sql.exec(
      `SELECT runner_request_id, state
       FROM dispatch_outbox
       WHERE state IN (${ACTIVE_OUTBOX_STATES_SQL})
       ORDER BY updated_at_ms, runner_request_id`,
    ).toArray();
    for (const selected of rows) {
      if (nowFunction(services)() >= workDeadlineMs) {
        this.#emitScaleUpDecision(
          "dispatch-deferred",
          {
            reason: "reconcile-budget-exhausted",
            runnerRequestId: selected.runner_request_id,
            state: selected.state,
          },
          services,
        );
        break;
      }
      const row = this.#outboxRow(selected.runner_request_id);
      if (row === null || TERMINAL_OUTBOX_STATES.includes(row.state)) {
        this.#emitScaleUpDecision(
          "dispatch-deferred",
          {
            reason: "reconcile-row-terminal",
            runnerRequestId: selected.runner_request_id,
            ...(row === null ? {} : { state: row.state }),
          },
          services,
        );
        continue;
      }
      if (row.state === "start-requested") {
        const recordedAtMs = this.#startClockOriginOrNull(
          row.runner_request_id,
        );
        const startDeadlineMs = recordedAtMs === null
          ? null
          : recordedAtMs + START_DEADLINE_MS;
        if (
          startDeadlineMs === null ||
          nowFunction(services)() > startDeadlineMs
        ) {
          const reconciled = await this.#reconcileLostStart(
            row,
            "deadline-exceeded-after-start",
            services,
            { emit: false },
          );
          if (reconciled !== null) {
            await this.#recordDeadlineExceededAfterStart(
              row.runner_request_id,
              reconciled,
              services,
            );
          }
        }
      } else {
        await this.#cancelDispatch(row, services);
      }
    }
  }

  #activeOutboxCount() {
    const row = this.sql.exec(
      `SELECT COUNT(*) AS depth
       FROM dispatch_outbox
       WHERE state IN (${ACTIVE_OUTBOX_STATES_SQL})`,
    ).toArray()[0];
    return row?.depth ?? 0;
  }

  #unreservedOutboxCount() {
    const row = this.sql.exec(
      `SELECT COUNT(*) AS depth
       FROM dispatch_outbox
       WHERE state IN (${ACTIVE_OUTBOX_STATES_SQL})
         AND reservation_id IS NULL`,
    ).toArray()[0];
    return row?.depth ?? 0;
  }

  #cancelDrainAcquisitions(services) {
    const runnerRequestIds = this.sql.exec(
      `UPDATE acquisition_intents
       SET state = 'cancelled'
       WHERE state IN ('intended', 'ambiguous')
       RETURNING runner_request_id`,
    ).toArray().map((row) => row.runner_request_id).sort((left, right) =>
      left - right
    );
    if (runnerRequestIds.length === 0) {
      return;
    }
    this.#emit(
      "runner-acquisitions-cancelled",
      {
        acquisitionCount: runnerRequestIds.length,
        runnerRequestIds,
      },
      services,
    );
  }

  #drainStatus(activeRunners, ownInFlight = 0) {
    const row = this.sql.exec(
      `SELECT
         (
           SELECT COUNT(*)
           FROM dispatch_outbox
           WHERE state IN (${ACTIVE_OUTBOX_STATES_SQL})
         ) AS active_outbox,
         (
           SELECT COUNT(*)
           FROM inbox
           WHERE state = 'stored'
         ) AS stored_messages,
         (
           SELECT COUNT(*)
           FROM acquisition_intents AS intent
           WHERE intent.state IN ('intended', 'ambiguous')
              OR (
                intent.state = 'granted'
                AND EXISTS (
                  SELECT 1
                  FROM dispatch_outbox AS outbox
                  WHERE outbox.runner_request_id = intent.runner_request_id
                    AND outbox.state IN (${ACTIVE_OUTBOX_STATES_SQL})
                )
              )
         ) AS pending_acquisitions`,
    ).toArray()[0];
    const activeOutbox = row?.active_outbox ?? 0;
    const storedMessages = row?.stored_messages ?? 0;
    const pendingAcquisitions = row?.pending_acquisitions ?? 0;
    const inFlightOperations = Math.max(
      0,
      this.inFlightOperations.size - ownInFlight,
    );
    const inFlightPoll = this.activePollController !== null;
    return {
      drained: activeOutbox === 0 && storedMessages === 0 &&
        pendingAcquisitions === 0 &&
        inFlightOperations === 0 && !inFlightPoll && activeRunners === 0,
      activeOutbox,
      activeRunners,
      storedMessages,
      pendingAcquisitions,
      inFlightOperations,
      inFlightPoll,
    };
  }

  async #rearmDrainedAlarm(services) {
    // An incomplete drain must not create a zero-delay alarm loop. A runner
    // that is starting or assigned must also outlive the deployment gate.
    await this.#alarmService(services).set(
      nowFunction(services)() + DRAIN_RUNNER_RECHECK_MS,
    );
  }

  async #settleDrain(
    ownInFlight,
    workDeadline,
    sessionDeleteDeadline,
    services,
    afterOutboxSettled,
  ) {
    if (stateSession(this.#listenerState()) !== null) {
      await this.#acknowledgeStoredMessages(services);
    }
    this.#cancelDrainAcquisitions(services);
    await this.#settleDrainOutbox(workDeadline(), services);
    afterOutboxSettled?.();
    const activeRunners = await this.#activeRunnerCount(services);
    const status = this.#drainStatus(activeRunners, ownInFlight);
    if (status.drained) {
      this.#compact(nowFunction(services)(), true);
      await this.#deletePersistedSession(
        "graceful-drain",
        sessionDeleteDeadline(),
        services,
      );
      await this.#alarmService(services).delete();
    } else {
      await this.#rearmDrainedAlarm(services);
    }
    return { status, activeRunners };
  }

  #compact(cutoffMs, forceTerminal = false) {
    const terminalPredicate = forceTerminal
      ? "1 = 1"
      : "updated_at_ms < ?";
    const bindings = forceTerminal
      ? []
      : [cutoffMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS];
    const historyPredicate = forceTerminal
      ? "state != 'pending'"
      : "created_at_ms < ?";
    const historyBindings = forceTerminal
      ? []
      : [cutoffMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS];
    const cancellationPredicate = forceTerminal
      ? "1 = 1"
      : "recorded_at_ms < ?";
    const cancellationBindings = forceTerminal
      ? []
      : [cutoffMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS];
    const quarantinePredicate = forceTerminal
      ? "1 = 1"
      : "received_at_ms < ?";
    const quarantineBindings = forceTerminal
      ? []
      : [cutoffMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS];
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `DELETE FROM dispatch_outbox
         WHERE state IN ('started', 'failed', 'cancelled')
           AND (
             reservation_id IS NULL
             OR reservation_released_at_ms IS NOT NULL
           )
           AND ${terminalPredicate}`,
        ...bindings,
      );
      this.sql.exec(
        `DELETE FROM acquisition_intents
         WHERE state IN ('not-granted', 'cancelled')
            OR (
              state = 'granted'
              AND NOT EXISTS (
                SELECT 1
                FROM dispatch_outbox
                WHERE dispatch_outbox.runner_request_id =
                  acquisition_intents.runner_request_id
              )
            )`,
      );
      this.sql.exec(
        `DELETE FROM inbox
         WHERE (
             state = 'acknowledged'
             OR (state = 'quarantined' AND ${quarantinePredicate})
           )
           AND message_id <= (
             SELECT last_message_id
             FROM listener_state
             WHERE singleton = 1
           )
           AND NOT EXISTS (
             SELECT 1
             FROM acquisition_intents
             WHERE acquisition_intents.message_id = inbox.message_id
           )`,
        ...quarantineBindings,
      );
      this.sql.exec(
        `DELETE FROM cancellations
         WHERE ${cancellationPredicate}
           AND NOT EXISTS (
             SELECT 1
             FROM acquisition_intents
             WHERE acquisition_intents.runner_request_id =
               cancellations.runner_request_id
               AND acquisition_intents.state IN (
                 'intended', 'granted', 'ambiguous'
               )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM dispatch_outbox
             WHERE dispatch_outbox.runner_request_id =
               cancellations.runner_request_id
               AND dispatch_outbox.state IN (${ACTIVE_OUTBOX_STATES_SQL})
           )`,
        ...cancellationBindings,
      );
      this.sql.exec(
        `DELETE FROM export_outbox
         WHERE ${historyPredicate}`,
        ...historyBindings,
      );
      this.sql.exec(
        "UPDATE listener_state SET sqlite_full = 0 WHERE singleton = 1",
      );
    });
  }

  async #handleSqliteFull(error, services) {
    try {
      this.sql.exec(
        "UPDATE listener_state SET sqlite_full = 1 WHERE singleton = 1",
      );
    } catch {
      // The original SQLITE_FULL error remains the alert source.
    }
    loggerService(services).error(this.#safeRecord({
      source: "ScaleSetListener",
      event: "sqlite-full",
      error: safeErrorMessage(error),
      ...this.#correlations(),
    }));
    const nextAttemptAtMs = nowFunction(services)() + RECOVERY_BASE_DELAY_MS;
    await this.#alarmService(services).set(nextAttemptAtMs);
    return nextAttemptAtMs;
  }

  #alarmGenerationOrNull() {
    try {
      return this.#listenerState().alarm_generation;
    } catch {
      return null;
    }
  }

  #failureFields(error) {
    return {
      failure: safeErrorMessage(error),
      failureName: error instanceof Error ? error.constructor.name : null,
      failureStatus: error instanceof Error ? error.status ?? null : null,
      failureCauseName: error?.cause instanceof Error
        ? error.cause.constructor.name
        : null,
      failureCauseStatus: error?.cause instanceof Error
        ? error.cause.status ?? null
        : null,
    };
  }

  #recoveryOutcome(
    error,
    generation,
    condition,
    recovery,
    deferredOutcome = "recovery-deferred",
  ) {
    const failureFields = this.#failureFields(error);
    if (recovery.exhausted) {
      return {
        outcome: "recovery-exhausted",
        generation,
        condition,
        ...failureFields,
        exhaustionMarker: recovery.marker,
      };
    }
    return {
      outcome: deferredOutcome,
      generation,
      condition,
      ...failureFields,
      nextAttemptAtMs: recovery.nextAttemptAtMs,
    };
  }

  #emitListenerAlarmFailed(error, generation, services) {
    const fields = {
      error: safeErrorMessage(error),
      alarmGeneration: generation,
    };
    try {
      this.#emit("listener-alarm-failed", fields, services);
      return;
    } catch (emitError) {
      this.#logWithoutPersistence(
        "listener-alarm-failure-persist-failed",
        {
          error: safeErrorMessage(emitError),
          alarmGeneration: generation,
        },
        services,
      );
    }
    this.#logWithoutPersistence(
      "listener-alarm-failed",
      fields,
      services,
      "log",
    );
  }

  async #lastResortAlarmRecovery(
    error,
    recoveryError,
    generation,
    services,
    failureAlreadyEmitted = false,
  ) {
    const recoveryCondition = recoveryConditionForError(error);
    if (!failureAlreadyEmitted && recoveryCondition === null) {
      this.#emitListenerAlarmFailed(error, generation, services);
    }
    const consecutive = this.consecutiveAlarmRecoveryRearms + 1;
    const pauseMs = recoveryPauseMs(consecutive);
    const nextAttemptAtMs = nowFunction(services)() + pauseMs;
    await this.#alarmService(services).set(nextAttemptAtMs);
    this.consecutiveAlarmRecoveryRearms = consecutive;
    const recoveryFailure = recoveryError === null
      ? "The alarm handler escaped its recovery boundary"
      : safeErrorMessage(recoveryError);
    this.#logWithoutPersistence(
      "alarm-failure-last-resort-rearmed",
      {
        alarmGeneration: generation,
        error: safeErrorMessage(error),
        recoveryError: recoveryFailure,
        consecutive,
        nextAttemptAtMs,
        pauseMs,
      },
      services,
    );
    return {
      outcome: recoveryCondition === null
        ? "alarm-failed"
        : "recovery-deferred",
      generation,
      condition: recoveryCondition ?? "alarm-failure",
      ...this.#failureFields(error),
      recoveryFailure,
      nextAttemptAtMs,
      lastResort: true,
    };
  }

  async #recoverAlarmError(error, generation, deadlineMs, services) {
    if (isSqliteFullError(error)) {
      try {
        const nextAttemptAtMs = await this.#handleSqliteFull(error, services);
        return {
          outcome: "sqlite-full",
          generation,
          condition: "sqlite-full",
          ...this.#failureFields(error),
          nextAttemptAtMs,
        };
      } catch (recoveryError) {
        return this.#lastResortAlarmRecovery(
          error,
          recoveryError,
          generation,
          services,
        );
      }
    }

    try {
      const handled = await this.#handleRecoverableError(error, services);
      if (handled !== null) {
        return this.#recoveryOutcome(
          error,
          generation,
          handled.condition,
          handled.recovery,
        );
      }
    } catch (recoveryError) {
      return this.#lastResortAlarmRecovery(
        error,
        recoveryError,
        generation,
        services,
      );
    }

    let state;
    try {
      state = this.#listenerState();
    } catch (recoveryError) {
      return this.#lastResortAlarmRecovery(
        error,
        recoveryError,
        generation,
        services,
      );
    }
    if (state.session_id !== null) {
      try {
        await this.#deletePersistedSession(
          "alarm-failure",
          Math.min(
            deadlineMs,
            nowFunction(services)() + ALARM_WORK_BUDGET_MS,
          ),
          services,
        );
      } catch (deleteError) {
        this.#logWithoutPersistence(
          "alarm-failure-session-delete-failed",
          { error: safeErrorMessage(deleteError) },
          services,
        );
      }
    }
    this.#emitListenerAlarmFailed(error, generation, services);
    try {
      const recovery = await this.#recordRecoveryFailure(
        "alarm-failure",
        null,
        services,
      );
      return this.#recoveryOutcome(
        error,
        generation,
        "alarm-failure",
        recovery,
        "alarm-failed",
      );
    } catch (recoveryError) {
      this.#logWithoutPersistence(
        "alarm-failure-recovery-record-failed",
        {
          error: safeErrorMessage(recoveryError),
          alarmGeneration: generation,
        },
        services,
      );
      return this.#lastResortAlarmRecovery(
        error,
        recoveryError,
        generation,
        services,
        true,
      );
    }
  }

  async #repairAlarmInvariant(result, state, reason, error, services) {
    const consecutive = this.consecutiveAlarmRecoveryRearms + 1;
    const currentPauseMs = state.mode === "drained"
      ? DRAIN_RUNNER_RECHECK_MS
      : RECOVERY_BASE_DELAY_MS;
    const pauseMs = Math.max(
      recoveryPauseMs(consecutive),
      currentPauseMs,
    );
    const nextAttemptAtMs = nowFunction(services)() + pauseMs;
    await this.#alarmService(services).set(nextAttemptAtMs);
    this.consecutiveAlarmRecoveryRearms = consecutive;
    const fields = {
      alarmGeneration: result.generation ?? this.#alarmGenerationOrNull(),
      consecutive,
      mode: state.mode,
      priorOutcome: result.outcome ?? null,
      reason,
      nextAttemptAtMs,
      pauseMs,
      ...(error === null ? {} : { error: safeErrorMessage(error) }),
    };
    try {
      this.#emit("listener-alarm-invariant-repaired", fields, services);
    } catch (emitError) {
      this.#logWithoutPersistence(
        "listener-alarm-invariant-repaired",
        {
          ...fields,
          eventPersistenceError: safeErrorMessage(emitError),
        },
        services,
      );
    }
    return {
      ...result,
      alarmInvariantRepaired: true,
      nextAttemptAtMs,
    };
  }

  async #enforceAlarmExitInvariant(result, services) {
    let state;
    try {
      state = this.#listenerState();
    } catch (error) {
      return this.#lastResortAlarmRecovery(
        error,
        null,
        result.generation ?? this.#alarmGenerationOrNull(),
        services,
      );
    }

    if (state.mode === "stopped") {
      if (ALARMLESS_OUTCOMES.includes(result.outcome)) {
        return result;
      }
      await this.#alarmService(services).delete();
      return {
        ...result,
        outcome: "stopped-by-failure",
        priorOutcome: result.outcome ?? null,
        stoppedReason: state.stopped_reason,
      };
    }
    if (state.mode !== "running" && state.mode !== "drained") {
      return result;
    }
    if (result.outcome === "disabled") {
      return result;
    }

    let scheduledAlarm;
    try {
      scheduledAlarm = await this.#alarmService(services).get();
    } catch (error) {
      return this.#repairAlarmInvariant(
        result,
        state,
        "alarm-read-failed",
        error,
        services,
      );
    }
    if (Number.isFinite(scheduledAlarm)) {
      return result;
    }
    return this.#repairAlarmInvariant(
      result,
      state,
      "alarm-missing",
      null,
      services,
    );
  }

  async #runAlarmWithInvariant(services) {
    let result;
    try {
      result = await this.#runAlarm(services);
    } catch (error) {
      result = await this.#lastResortAlarmRecovery(
        error,
        null,
        this.#alarmGenerationOrNull(),
        services,
      );
    }
    const enforcedResult = await this.#enforceAlarmExitInvariant(
      result,
      services,
    );
    if (
      enforcedResult.lastResort !== true &&
      enforcedResult.alarmInvariantRepaired !== true
    ) {
      this.consecutiveAlarmRecoveryRearms = 0;
    }
    return enforcedResult;
  }

  async #poll(
    session,
    lastMessageId,
    maxCapacity,
    pollTimeoutMs,
    deadlineMs,
    services,
  ) {
    const controller = new AbortController();
    this.activePollController = controller;
    try {
      return await this.#track((services.getMessage ?? getMessage)(
        {
          session,
          lastMessageId,
          maxCapacity,
          pollTimeoutMs,
          deadlineMs,
          signal: controller.signal,
        },
        services.clientServices ?? {},
      ));
    } finally {
      if (this.activePollController === controller) {
        this.activePollController = null;
      }
    }
  }

  async #runDrainedAlarm(generation, deadlineMs, services) {
    const { status, activeRunners } = await this.#settleDrain(
      1,
      () => Math.min(
        deadlineMs,
        nowFunction(services)() + ALARM_WORK_BUDGET_MS,
      ),
      () => deadlineMs,
      services,
      () => this.#persistHeartbeat(generation, services),
    );
    this.#clearRecovery("alarm-failure");
    return {
      drained: status.drained,
      activeRunners,
      pendingAcquisitions: status.pendingAcquisitions,
      inFlightOperations: status.inFlightOperations,
    };
  }

  async alarm() {
    return this.runAlarm();
  }

  async runAlarm(services = {}) {
    return this.#track(this.#runAlarmWithInvariant(services));
  }

  async #runAlarm(services) {
    const now = nowFunction(services);
    const handlerStartMs = now();
    const generation = await this.#entryRearm(handlerStartMs, services);
    const deadlineMs = handlerStartMs + ALARM_WALL_BUDGET_MS;

    try {
      let state = this.#listenerState();
      if (deliberatelyStopped(state)) {
        await this.#attemptShutdownSessionDeletion(
          "deliberately-stopped-alarm",
          services,
        );
        await this.#alarmService(services).delete();
        return { outcome: "deliberately-stopped", generation };
      }
      if (state.mode === "stopped") {
        await this.#attemptShutdownSessionDeletion(
          "failure-stopped-alarm",
          services,
        );
        await this.#alarmService(services).delete();
        return { outcome: "stopped-by-failure", generation };
      }

      const config = this.#configuration(services, state);
      if (!this.#enabled(services) || config === null) {
        await this.#attemptShutdownSessionDeletion(
          "listener-disabled",
          services,
        );
        await this.#alarmService(services).delete();
        return { outcome: "disabled", generation };
      }
      this.#persistIdentity(config, config.scaleSetId ?? null);

      const activeRecovery = await this.#deferActiveRecovery(services);
      if (activeRecovery !== null) {
        return this.#recoveryOutcome(
          new Error(`Recovery remains active for ${activeRecovery.condition}`),
          generation,
          activeRecovery.condition,
          activeRecovery.recovery,
        );
      }

      if (state.sqlite_full === 1) {
        this.#compact(handlerStartMs, true);
        state = this.#listenerState();
        this.#emit("sqlite-full-recovered", {}, services);
      } else {
        this.#compact(handlerStartMs);
      }

      if (state.mode === "drained") {
        return await this.#runDrainedAlarm(
          generation,
          deadlineMs,
          services,
        );
      }

      let controlStatus = await this.#controlStatus(services);
      if (
        controlStatus.localGate === "closed" ||
        controlStatus.maxCapacity <= 0
      ) {
        await this.#killSwitchShutdown(services);
        return { outcome: "kill-switch", generation };
      }

      let session = await this.#ensureSession(
        config,
        deadlineMs,
        services,
      );
      if (session === null) {
        const current = this.#listenerState();
        if (current.mode === "stopped") {
          const exhausted = this.sql.exec(
            `SELECT condition, exhausted_marker
             FROM recovery
             WHERE exhausted_marker IS NOT NULL
             ORDER BY first_failure_at_ms
             LIMIT 1`,
          ).toArray()[0];
          return {
            outcome: "recovery-exhausted",
            generation,
            condition: exhausted?.condition ?? "session-conflict",
            failure: "The message session recovery was exhausted",
            exhaustionMarker: exhausted?.exhausted_marker ?? null,
          };
        }
        return { outcome: "recovery-deferred", generation };
      }

      while (true) {
        state = this.#listenerState();
        if (state.mode !== "running") {
          break;
        }
        const loopNowMs = now();
        const elapsedMs = loopNowMs - handlerStartMs;
        let paceWaitMs = null;
        if (this.#activeOutboxCount() > 0) {
          const pace = this.#pacePermits(loopNowMs);
          paceWaitMs = pace.waitMs;
        }
        // Outstanding work clamps GetMessage to the pace wait. A permitted pace
        // uses the 1,000 ms floor and avoids a full long poll before dispatch.
        const pollTimeoutMs = pollTimeoutForElapsed(elapsedMs, paceWaitMs);
        if (pollTimeoutMs <= 0) {
          break;
        }
        if (
          elapsedMs + pollTimeoutMs + ALARM_WORK_BUDGET_MS >
            ALARM_WALL_BUDGET_MS
        ) {
          throw new Error("The poll would cross the alarm wall budget");
        }
        controlStatus = await this.#controlStatus(services);
        if (
          controlStatus.localGate === "closed" ||
          controlStatus.maxCapacity <= 0
        ) {
          await this.#killSwitchShutdown(services);
          return { outcome: "kill-switch", generation };
        }

        const cursor = state.last_message_id;
        const pollResult = await this.#runSessionOperation(
          "GetMessage",
          (currentSession) => this.#poll(
            currentSession,
            cursor,
            Math.min(MAX_ACTIVE_RUNNERS, controlStatus.maxCapacity),
            pollTimeoutMs,
            deadlineMs,
            services,
          ),
          deadlineMs,
          services,
        );
        session = stateSession(this.#listenerState());
        if (session === null) {
          break;
        }

        const workDeadlineMs = Math.min(
          deadlineMs,
          now() + ALARM_WORK_BUDGET_MS,
        );
        if (pollResult.outcome === "poll-aborted") {
          this.#emit(
            "message-poll-aborted",
            { cursor, pollTimeoutMs },
            services,
          );
        } else if (pollResult.outcome === "message") {
          await this.#track(this.#processMessage(
            pollResult.message,
            config,
            workDeadlineMs,
            services,
          ));
        } else {
          this.#emit(
            "message-poll-empty",
            { cursor, pollTimeoutMs },
            services,
          );
        }
        if (this.#listenerState().mode !== "running") {
          break;
        }
        if (now() < workDeadlineMs) {
          await this.#resumeIntendedAcquisition(
            config,
            workDeadlineMs,
            services,
          );
        }
        if (now() < workDeadlineMs) {
          await this.#settleExpiredReservations(
            workDeadlineMs,
            services,
          );
          await this.#reclaimUndeliveredRunnerReservations(
            workDeadlineMs,
            services,
          );
          await this.#releaseDeregisteredRunnerReservations(
            config,
            workDeadlineMs,
            services,
          );
        }
        if (now() < workDeadlineMs) {
          await this.#scaleUpToStatistics(
            config,
            workDeadlineMs,
            services,
          );
        } else {
          this.#recordScaleUpDecision(
            "work-budget-exhausted",
            {},
            services,
          );
        }
        if (now() < workDeadlineMs) {
          await this.#dispatchOutbox(config, workDeadlineMs, services);
        }
        this.#persistHeartbeat(generation, services);
      }
      this.#clearRecovery("alarm-failure");
      return {
        outcome: "handoff",
        generation,
        cursor: this.#listenerState().last_message_id,
        deferredOutbox: this.#activeOutboxCount(),
      };
    } catch (error) {
      return this.#recoverAlarmError(
        error,
        generation,
        deadlineMs,
        services,
      );
    } finally {
      await this.#drainDispatchChains();
    }
  }

  async scheduledAlarm() {
    return this.ctx.storage.getAlarm();
  }

  async stop({ reason, scaleSetName } = {}, services = {}) {
    this.#bindScaleSetName(scaleSetName);
    if (!nonEmptyString(reason)) {
      throw new TypeError("reason must be a non-empty string");
    }
    const state = this.#listenerState();
    if (deliberatelyStopped(state)) {
      await this.#alarmService(services).delete();
      let deletion = { result: "not-present" };
      if (state.session_id !== null) {
        deletion = await this.#attemptShutdownSessionDeletion(
          "graceful-stop",
          services,
        );
      }
      return {
        stopped: true,
        changed: false,
        reason: publicStoppedReason(state.stopped_reason),
        advertisedMaxCapacity: 0,
        sessionDeleted: deletion.result === "deleted" ||
          deletion.result === "already-absent" ||
          deletion.result === "not-present",
      };
    }
    this.sql.exec(
      `UPDATE listener_state
       SET mode = 'stopped', stopped_reason = ?
       WHERE singleton = 1`,
      `${DELIBERATE_STOP_PREFIX}${reason}`,
    );
    this.activePollController?.abort();
    await this.#alarmService(services).delete();
    await this.#waitForInFlight();
    const deletion = await this.#attemptShutdownSessionDeletion(
      "graceful-stop",
      services,
    );
    this.#emit(
      "listener-stopped",
      { reason, advertisedMaxCapacity: 0 },
      services,
    );
    return {
      stopped: true,
      changed: true,
      reason,
      advertisedMaxCapacity: 0,
      sessionDeleted: deletion.result === "deleted" ||
        deletion.result === "already-absent" ||
        deletion.result === "not-present",
    };
  }

  async resetAdmission({ scaleSetName } = {}, services = {}) {
    this.#bindScaleSetName(scaleSetName);
    const admission = this.#admissionState();
    this.sql.exec(
      `UPDATE listener_state
       SET admission_limit = NULL,
           admission_success_streak = 0,
           admission_limit_changed_at_ms = NULL,
           admission_limited = 0
       WHERE singleton = 1`,
    );
    this.#emit("admission-limit-reset", {
      previousLimit: admission.limit,
      previousSuccessStreak: admission.successStreak,
      admissionLimit: null,
    }, services);
    return {
      reset: true,
      previousLimit: admission.limit,
      admissionLimit: null,
    };
  }

  async #acknowledgeStoredMessages(services) {
    const rows = this.sql.exec(
      "SELECT message_id FROM inbox WHERE state = 'stored' ORDER BY message_id",
    ).toArray();
    for (const row of rows) {
      await this.#runSessionOperation(
        "DeleteMessage",
        (session) => (services.deleteMessage ?? deleteMessage)(
          {
            session,
            messageId: row.message_id,
            deadlineMs: nowFunction(services)() + ALARM_WORK_BUDGET_MS,
          },
          services.clientServices ?? {},
        ),
        nowFunction(services)() + ALARM_WORK_BUDGET_MS,
        services,
      );
      this.#markAcknowledged(row.message_id);
    }
  }

  async drain({ scaleSetName } = {}, services = {}) {
    this.#bindScaleSetName(scaleSetName);
    const current = this.#listenerState();
    if (current.mode === "stopped") {
      return {
        drained: false,
        activeRunners: await this.#activeRunnerCount(services),
        reason: "listener-stopped",
      };
    }
    this.sql.exec(
      `UPDATE listener_state
       SET mode = 'drained', stopped_reason = NULL
       WHERE singleton = 1`,
    );
    this.activePollController?.abort();
    await this.#waitForInFlight();
    const { status, activeRunners } = await this.#settleDrain(
      0,
      () => nowFunction(services)() + ALARM_WORK_BUDGET_MS,
      () => nowFunction(services)() + ALARM_WORK_BUDGET_MS,
      services,
    );
    return {
      drained: status.drained,
      activeOutbox: status.activeOutbox,
      activeRunners,
      pendingAcquisitions: status.pendingAcquisitions,
      unacknowledgedMessages: status.storedMessages,
      inFlightOperations: status.inFlightOperations,
      inFlightPoll: status.inFlightPoll,
      ...(status.drained
        ? {}
        : {
            reason: activeRunners === null
              ? "runner-inventory-unavailable"
              : "work-outstanding",
          }),
    };
  }

  async resume({ scaleSetName } = {}, services = {}) {
    this.#bindScaleSetName(scaleSetName);
    const state = this.#listenerState();
    const alarm = this.#alarmService(services);
    const noAlarmScheduled = await alarm.get() === null;
    if (state.mode === "running") {
      if (noAlarmScheduled) {
        await alarm.set(nowFunction(services)());
      }
      return {
        resumed: true,
        changed: false,
        armed: noAlarmScheduled,
        alarmGeneration: state.alarm_generation,
      };
    }
    let deletion = { result: "not-present" };
    if (state.session_id !== null) {
      deletion = await this.#attemptShutdownSessionDeletion(
        "session-replacement",
        services,
      );
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM recovery");
      this.sql.exec(
        `UPDATE listener_state
         SET mode = 'running', stopped_reason = NULL, sqlite_full = 0
         WHERE singleton = 1`,
      );
    });
    // The mode-changing path always rearms so a drained or failed listener runs immediately.
    await alarm.set(nowFunction(services)());
    this.#emit("listener-resumed", {}, services);
    return {
      resumed: true,
      changed: true,
      armed: true,
      alarmGeneration: this.#listenerState().alarm_generation,
      sessionDeleted: deletion.result === "deleted" ||
        deletion.result === "already-absent" ||
        deletion.result === "not-present",
    };
  }

  async rearm(
    { requestedGeneration, scaleSetName } = {},
    services = {},
  ) {
    this.#bindScaleSetName(scaleSetName);
    if (
      !Number.isSafeInteger(requestedGeneration) ||
      requestedGeneration < 0
    ) {
      throw new TypeError(
        "requestedGeneration must be a non-negative safe integer",
      );
    }
    const state = this.#listenerState();
    if (deliberatelyStopped(state)) {
      return {
        rearmed: false,
        reason: "deliberately-stopped",
        alarmGeneration: state.alarm_generation,
      };
    }
    const nextGeneration = Math.max(
      state.alarm_generation,
      requestedGeneration,
    ) + 1;
    if (!Number.isSafeInteger(nextGeneration)) {
      throw new TypeError("The next alarm generation exceeds a safe integer");
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM recovery");
      this.sql.exec(
        `UPDATE listener_state
         SET alarm_generation = ?,
             mode = 'running',
             stopped_reason = NULL
         WHERE singleton = 1`,
        nextGeneration,
      );
    });
    await this.#alarmService(services).set(nowFunction(services)());
    this.#emit(
      "listener-rearmed",
      { requestedGeneration, alarmGeneration: nextGeneration },
      services,
    );
    return { rearmed: true, alarmGeneration: nextGeneration };
  }
}
