import { getSandbox, Sandbox as VendorSandbox } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import {
  ScaleSetRequestError,
  createRunnerScaleSet,
  fetchActionsServiceConnection,
  fetchRegistrationToken,
  getRunnerScaleSet,
  redactSecrets,
  registrationTokenPath,
  runnerListPath,
  runnerPath,
} from "./scaleset-client.js";
import {
  AutopilotControl,
  InvalidReservationCursor,
  MAX_ACTIVE_RUNNERS,
  createHmacSha256Hex,
  decodeReservationCursor,
  getAutopilotControl,
  secureEqual,
} from "./autopilot-control.js";
import {
  isPlainObject,
  isPositiveSafeInteger,
  isRepositoryName,
} from "./scaleset-protocol.js";
import {
  SCALE_SET_NAME_PATTERN,
  ScaleSetListener,
} from "./scaleset-listener.js";
import { handleRegistrationCleanupRequest } from "./registration-cleanup-route.js";
import {
  ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  DEFAULT_RECONCILE_MAX_AGE_SECONDS,
  GITHUB_RUNNER_LIST_PAGE_SIZE,
  MAX_BUSY_POSTPONE_MS,
  MAX_CLEANUP_CONCURRENCY,
  RECONCILE_CANDIDATE_PAGE_SIZE,
  RECONCILE_LISTING_PAGINATION_RESERVE,
  RECONCILE_REGISTRY_READ_SUBREQUESTS,
  RECONCILE_SUBREQUEST_BUDGET,
  RECONCILE_SUBREQUESTS_PER_CANDIDATE,
  RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING,
  RUNNER_LIST_PAGE_SIZE,
  WORKER_SIMULTANEOUS_CONNECTION_LIMIT,
} from "./runner-policy.js";
import { withConfirmedDestroy } from "./runner-sandbox.js";
import { resolveRunnerScope } from "./runner-scope.js";

// The vendor `destroy()` reports success when the platform refuses to bind a
// container instance. `withConfirmedDestroy` makes that a failure so the
// existing cleanup-claim retry runs. See src/runner-sandbox.js.
export class Sandbox extends withConfirmedDestroy(VendorSandbox) {}
export { AutopilotControl, ScaleSetListener };
export { resolveRunnerScope } from "./runner-scope.js";

const RUNNER_READY = /Listening for Jobs/i;
const RUNNER_ID_PATTERN = /^runner-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SANDBOX_INSTANCE_ID_PATTERN = /^[0-9a-f]{64}$/;
const APPLICATION_ID_PATTERN = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const COMPLETE_INSTANCE_ENUMERATION_OUTCOMES = new Set([
  "cycle-closed",
  "exhausted",
  "lap-closed",
]);
const REQUIRED_RUNNER_LABEL = "cloudflare-sandbox";
const REGISTRY_NAME = "singleton";
const RUNNER_REGISTRY_SCHEMA_VERSION = 12;
// At 3,558 terminal rows daily, four immediate alarm passes delete one day's
// arrivals. Each pass rearms the alarm while an expired backlog remains.
const TERMINAL_RUNNER_PRUNE_BATCH_SIZE = 1_000;
const GITHUB_WEBHOOK_REDELIVERY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
// GitHub retains webhook deliveries for three days. Add the existing
// reconciliation window so a delivery at that boundary cannot race pruning.
const TERMINAL_RUNNER_RETENTION_MS =
  GITHUB_WEBHOOK_REDELIVERY_WINDOW_MS + ACTIVE_RUNNER_CLEANUP_DELAY_MS;
// Use the existing terminal retention horizon for orphan observations.
const ORPHAN_OBSERVATION_MAX_AGE_MS = TERMINAL_RUNNER_RETENTION_MS;
const ECMASCRIPT_DATE_LIMIT_MS = 8_640_000_000_000_000;
// Match the cleanup client's existing request bound.
const DESTROY_TIMEOUT_MS = 60_000;
// This budget is 14 times the measured 2,140 ms maximum healthy
// sandboxStartProcessMs and half the frozen 60,000 ms START_DEADLINE_MS.
// A dead start stops in the Worker before the listener deadline.
const CONTAINER_START_BUDGET_MS = 30_000;
const SCALE_SET_CREATE_TIMEOUT_MS = 30_000;
// A Worker can use waitUntil for 30 seconds after its response. A claim becomes
// stale only after both existing bounds pass. The alarm then replaces the claim.
const WORKER_WAIT_UNTIL_LIMIT_MS = 30_000;
const CLEANUP_CLAIM_STALE_MS =
  DESTROY_TIMEOUT_MS + WORKER_WAIT_UNTIL_LIMIT_MS;
// Give the sandbox callback the existing response window before alarm cleanup.
const CALLBACK_CLEANUP_HANDOFF_DELAY_MS = WORKER_WAIT_UNTIL_LIMIT_MS;
// Retry failed cleanup after the existing destroy request bound.
const CLEANUP_RETRY_DELAY_MS = DESTROY_TIMEOUT_MS;
// A cleanup that keeps failing must stop, not retry forever. On 2026-08-25 a
// GitHub 403 in the pre-destroy registration check retried every
// CLEANUP_RETRY_DELAY_MS for 14.5 hours across eight rows: about 1,740
// revisions per row, 3,209 failure logs, and the sandbox destroy never reached.
// Ten attempts bound that at ten minutes of retrying and ten GitHub requests.
// A transient GitHub failure clears well inside that window; anything longer is
// an operator problem and must be loud instead of silent.
const MAX_CLEANUP_ATTEMPTS = 10;
// Match the external audit's ORPHAN_GRACE_SECONDS safety policy.
const ORPHAN_DESTROY_GRACE_MS = 60_000;
// A legacy (v1-v5) row has no recorded busy observation, so it must migrate to NULL.
const RUNNER_MIGRATION_COLUMNS = Object.freeze([
  "sandbox_id",
  "runner_name",
  "github_runner_name",
  "correlation_id",
  "repository",
  "created_at",
  "created_at_ms",
  "orphan_instance_id",
  "state",
  "cleanup_started_at",
  "reconcile_token",
  "cleanup_due_at_ms",
  "cleanup_requested_by",
  "cleanup_attempts",
  "revision",
  "destroyed_at",
  "destroyed_by",
]);
const LEGACY_CLEANUP_DUE_AT_EXPRESSION = `CASE
  WHEN state = 'destroyed' THEN NULL
  ELSE created_at_ms + ${ACTIVE_RUNNER_CLEANUP_DELAY_MS}
END`;
const LEGACY_CLEANUP_REQUESTED_BY_EXPRESSION =
  "CASE WHEN state = 'destroying' THEN 'reconcile' ELSE NULL END";
const RUNNER_MIGRATION_EXPRESSION_OVERRIDES = Object.freeze({
  1: Object.freeze({
    github_runner_name: "NULL",
    correlation_id: "sandbox_id",
    repository: "NULL",
    cleanup_started_at: "NULL",
    reconcile_token: "NULL",
    cleanup_due_at_ms: LEGACY_CLEANUP_DUE_AT_EXPRESSION,
    cleanup_requested_by: "NULL",
    cleanup_attempts: "0",
    revision: "0",
    orphan_instance_id: "NULL",
  }),
  2: Object.freeze({
    github_runner_name: "NULL",
    correlation_id: "sandbox_id",
    repository: "NULL",
    cleanup_due_at_ms: LEGACY_CLEANUP_DUE_AT_EXPRESSION,
    cleanup_requested_by: LEGACY_CLEANUP_REQUESTED_BY_EXPRESSION,
    cleanup_attempts: "0",
    orphan_instance_id: "NULL",
  }),
  3: Object.freeze({
    github_runner_name: "NULL",
    repository: "NULL",
    cleanup_due_at_ms: LEGACY_CLEANUP_DUE_AT_EXPRESSION,
    cleanup_requested_by: LEGACY_CLEANUP_REQUESTED_BY_EXPRESSION,
    cleanup_attempts: "0",
    orphan_instance_id: "NULL",
  }),
  4: Object.freeze({
    github_runner_name: "NULL",
    orphan_instance_id: "NULL",
    repository: "NULL",
    cleanup_attempts: "0",
  }),
  5: Object.freeze({
    github_runner_name: "NULL",
    orphan_instance_id: "NULL",
    repository: "NULL",
    cleanup_attempts: "0",
  }),
});

function safeLogRecord(record, env = {}, extraSecrets = []) {
  let serialized = redactSecrets(JSON.stringify(record));
  const secretValues = [
    env.CONTROL_TOKEN,
    env.GITHUB_APP_PRIVATE_KEY,
    env.GITHUB_TOKEN,
    env.RUNNER_CLEANUP_TOKEN,
    env.RUNNER_TOKEN,
    ...extraSecrets,
  ];
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length > 0) {
      serialized = serialized.replaceAll(secret, "[REDACTED]");
    }
  }
  return serialized;
}

function errorSummary(value, includeResponseSnippet = false) {
  const summary = {
    name: value instanceof Error ? value.name : typeof value,
    message: value instanceof Error ? value.message : String(value),
  };
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function")
  ) {
    const fields = includeResponseSnippet
      ? ["status", "method", "url", "responseSnippet"]
      : ["status", "method", "url"];
    for (const field of fields) {
      if (Object.hasOwn(value, field)) {
        summary[field] = value[field];
      }
    }
  }
  return summary;
}

function loggedError(error) {
  const aggregate = error instanceof AggregateError
    ? error
    : error instanceof Error && error.cause instanceof AggregateError
      ? error.cause
      : null;
  return {
    ...errorSummary(error, true),
    cause: error instanceof Error && error.cause instanceof Error
      ? errorSummary(error.cause, true)
      : null,
    ...(aggregate === null
      ? {}
      : {
          aggregateErrors: aggregate.errors.map((entry) =>
            errorSummary(entry, true)
          ),
        }),
  };
}

class ContainerStartBudgetExceeded extends Error {
  constructor(budgetMs) {
    super(`Container start exceeded the ${budgetMs} ms budget`);
    this.name = "ContainerStartBudgetExceeded";
  }
}

export function containerCapacityRefusal(error) {
  let current = error;
  let typedUnavailable = false;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const message = typeof current?.message === "string"
      ? current.message
      : String(current);
    const normalized = message.toLowerCase();
    if (
      normalized.includes(
        "there is no container instance that can be provided to this durable object",
      ) ||
      normalized.includes(
        "there is no container instance available at this time",
      )
    ) {
      return "no-container-instance";
    }
    if (
      normalized.includes(
        "maximum number of running container instances exceeded",
      )
    ) {
      return "max-instances-exceeded";
    }
    if (current?.code === "CONTAINER_UNAVAILABLE") {
      typedUnavailable = true;
    }
    current = typeof current === "object" ? current.cause : undefined;
  }
  return typedUnavailable ? "no-container-instance" : null;
}

function hasContainerStartBudgetExceeded(error, depth = 0) {
  if (depth >= 8 || error == null) {
    return false;
  }
  if (error instanceof ContainerStartBudgetExceeded) {
    return true;
  }
  if (
    error instanceof AggregateError &&
    error.errors.some((entry) =>
      hasContainerStartBudgetExceeded(entry, depth + 1)
    )
  ) {
    return true;
  }
  return hasContainerStartBudgetExceeded(
    typeof error === "object" ? error.cause : undefined,
    depth + 1,
  );
}

export function spawnFailureReason(error) {
  const capacityRefusal = containerCapacityRefusal(error);
  if (capacityRefusal !== null) {
    return capacityRefusal;
  }
  return hasContainerStartBudgetExceeded(error)
    ? "container-start-budget-exceeded"
    : null;
}

function defaultStartBudgetTimer(ms) {
  let timeoutId;
  const expired = new Promise((resolve) => {
    timeoutId = setTimeout(resolve, ms);
  });
  return {
    expired,
    cancel() {
      clearTimeout(timeoutId);
    },
  };
}

function logSuppressedSecondaryFailure(logger, env, recordFactory) {
  try {
    logger.error(safeLogRecord(recordFactory(), env));
  } catch {
    // Logging must not replace the JIT start conflict.
  }
}

export class RunnerRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.schemaMigrationError = null;
    ctx.blockConcurrencyWhile(async () => {
      try {
        this.#migrateSchema();
      } catch (error) {
        this.schemaMigrationError = error;
        console.error(
          safeLogRecord({
            message: "runner registry schema migration failed",
            error: error instanceof Error ? error.message : String(error),
          }, this.env),
        );
        return;
      }

      await this.#scheduleNextAlarm();
    });
  }

  #migrateSchema() {
    this.ctx.storage.transactionSync(() => {
      const schemaVersion = this.#readSchemaVersion();
      if (schemaVersion > RUNNER_REGISTRY_SCHEMA_VERSION) {
        throw new Error(
          `Runner registry schema version ${schemaVersion} is newer than ${RUNNER_REGISTRY_SCHEMA_VERSION}`,
        );
      }

      let migratedVersion = schemaVersion;
      if (migratedVersion === 0) {
        this.#createRunnersTable("runners");
        migratedVersion = 8;
      }
      if (migratedVersion > 0 && migratedVersion < 6) {
        this.#migrateRunners(schemaVersion);
        migratedVersion = 8;
      }
      if (migratedVersion === 6) {
        this.sql.exec(
          "ALTER TABLE runners ADD COLUMN orphan_instance_id TEXT",
        );
        migratedVersion = 7;
      }
      if (migratedVersion === 7) {
        this.sql.exec("ALTER TABLE runners ADD COLUMN repository TEXT");
        migratedVersion = 8;
      }
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS orphan_observations (
          sandbox_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          first_observed_at_ms INTEGER NOT NULL,
          PRIMARY KEY (sandbox_id, instance_id)
        )
      `);
      if (migratedVersion === 8) {
        this.sql.exec(`
          CREATE TABLE orphan_reclaim_observations (
            sandbox_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            first_observed_at_ms INTEGER NOT NULL,
            PRIMARY KEY (sandbox_id, revision)
          )
        `);
        migratedVersion = 9;
      }
      if (migratedVersion === 9) {
        const runnerColumns = new Set(
          this.sql
            .exec("PRAGMA table_info(runners)")
            .toArray()
            .map((column) => column.name),
        );
        if (!runnerColumns.has("cleanup_attempts")) {
          this.sql.exec(
            "ALTER TABLE runners ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0",
          );
        }
        migratedVersion = 10;
      }
      if (migratedVersion === 10) {
        const runnerColumns = new Set(
          this.sql
            .exec("PRAGMA table_info(runners)")
            .toArray()
            .map((column) => column.name),
        );
        if (!runnerColumns.has("github_runner_name")) {
          this.sql.exec(
            "ALTER TABLE runners ADD COLUMN github_runner_name TEXT",
          );
        }
        migratedVersion = 11;
      }
      if (migratedVersion === 11) {
        const runnerColumns = new Set(
          this.sql
            .exec("PRAGMA table_info(runners)")
            .toArray()
            .map((column) => column.name),
        );
        if (!runnerColumns.has("busy_since_ms")) {
          this.sql.exec(
            "ALTER TABLE runners ADD COLUMN busy_since_ms INTEGER",
          );
        }
        migratedVersion = 12;
      }
      this.#validateCurrentColumns();

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS runner_registry_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL
        )
      `);
      const recordedVersions = this.sql
        .exec(
          `INSERT INTO runner_registry_schema (singleton, version)
           VALUES (1, ?)
           ON CONFLICT (singleton) DO UPDATE SET version = excluded.version
           RETURNING version`,
          RUNNER_REGISTRY_SCHEMA_VERSION,
        )
        .toArray();
      if (
        recordedVersions.length !== 1 ||
        recordedVersions[0].version !== RUNNER_REGISTRY_SCHEMA_VERSION
      ) {
        throw new Error("Runner registry schema version was not recorded");
      }

      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS runners_active_age
          ON runners (state, cleanup_due_at_ms)
      `);
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS runners_terminal_age
          ON runners (state, destroyed_at)
      `);
    });
    this.schemaMigrationError = null;
  }

  #readSchemaVersion() {
    const schemaTableExists =
      this.sql
        .exec(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table' AND name = 'runner_registry_schema'`,
        )
        .toArray().length === 1;
    if (schemaTableExists) {
      const versions = this.sql
        .exec(
          `SELECT version
           FROM runner_registry_schema
           WHERE singleton = 1`,
        )
        .toArray();
      if (
        versions.length !== 1 ||
        !Number.isSafeInteger(versions[0].version) ||
        versions[0].version < 1
      ) {
        throw new Error("Runner registry schema version is invalid");
      }
      return versions[0].version;
    }

    const runnerTableExists =
      this.sql
        .exec(
          `SELECT name
           FROM sqlite_master
           WHERE type = 'table' AND name = 'runners'`,
        )
        .toArray().length === 1;
    if (!runnerTableExists) {
      return 0;
    }

    const columns = new Set(
      this.sql
        .exec("PRAGMA table_info(runners)")
        .toArray()
        .map((column) => column.name),
    );
    const legacyColumns = [
      "sandbox_id",
      "runner_name",
      "created_at",
      "created_at_ms",
      "state",
      "destroyed_at",
      "destroyed_by",
    ];
    if (!legacyColumns.every((column) => columns.has(column))) {
      throw new Error("Runner registry has an unsupported legacy schema");
    }

    const cleanupColumns = [
      "cleanup_started_at",
      "reconcile_token",
      "revision",
    ];
    if (!cleanupColumns.every((column) => columns.has(column))) {
      return 1;
    }
    if (columns.has("busy_since_ms")) {
      return 12;
    }
    if (columns.has("github_runner_name")) {
      return 11;
    }
    if (columns.has("cleanup_attempts")) {
      return 10;
    }
    if (columns.has("repository")) {
      return 8;
    }
    if (columns.has("orphan_instance_id")) {
      return 7;
    }
    if (columns.has("observed_created_at")) {
      return 6;
    }
    if (columns.has("cleanup_due_at_ms")) {
      return 4;
    }
    return columns.has("correlation_id") ? 3 : 2;
  }

  #createRunnersTable(tableName) {
    if (tableName !== "runners" && tableName !== "runners_next") {
      throw new Error("Runner registry table name is invalid");
    }
    this.sql.exec(`
      CREATE TABLE ${tableName} (
        sandbox_id TEXT PRIMARY KEY,
        runner_name TEXT NOT NULL UNIQUE,
        github_runner_name TEXT,
        correlation_id TEXT NOT NULL UNIQUE,
        repository TEXT,
        created_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        observed_created_at TEXT,
        orphan_instance_id TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('starting', 'online', 'destroying', 'destroyed')
        ),
        cleanup_started_at TEXT,
        reconcile_token TEXT,
        cleanup_due_at_ms INTEGER,
        cleanup_requested_by TEXT CHECK (
          cleanup_requested_by IS NULL OR
          cleanup_requested_by IN (
            'callback', 'reconcile', 'startup-failure', 'alarm', 'orphan'
          )
        ),
        cleanup_attempts INTEGER NOT NULL DEFAULT 0,
        busy_since_ms INTEGER,
        revision INTEGER NOT NULL DEFAULT 0,
        destroyed_at TEXT,
        destroyed_by TEXT CHECK (
          destroyed_by IS NULL OR
          destroyed_by IN (
            'callback', 'reconcile', 'startup-failure', 'alarm', 'orphan'
          )
        )
      )
    `);
  }

  #migrateRunners(schemaVersion) {
    this.sql.exec("DROP INDEX IF EXISTS runners_active_age");
    this.sql.exec("DROP INDEX IF EXISTS runners_terminal_age");
    this.sql.exec("DROP TABLE IF EXISTS runners_next");
    this.#createRunnersTable("runners_next");
    const expressionOverrides =
      RUNNER_MIGRATION_EXPRESSION_OVERRIDES[schemaVersion] ?? {};
    const migrationExpressions = RUNNER_MIGRATION_COLUMNS.map(
      (column) => expressionOverrides[column] ?? column,
    );
    const copiedRows = this.sql
      .exec(`
        INSERT INTO runners_next (
          ${RUNNER_MIGRATION_COLUMNS.join(",\n          ")}
        )
        SELECT
          ${migrationExpressions.join(",\n          ")}
        FROM runners
        RETURNING sandbox_id
      `)
      .toArray();
    const existingRows = this.sql
      .exec("SELECT sandbox_id FROM runners")
      .toArray();
    if (copiedRows.length !== existingRows.length) {
      throw new Error("Runner registry legacy rows were not copied completely");
    }
    this.sql.exec("DROP TABLE runners");
    this.sql.exec("ALTER TABLE runners_next RENAME TO runners");
  }

  #validateCurrentColumns() {
    const columns = new Set(
      this.sql
        .exec("PRAGMA table_info(runners)")
        .toArray()
        .map((column) => column.name),
    );
    const requiredColumns = [
      "sandbox_id",
      "runner_name",
      "github_runner_name",
      "correlation_id",
      "repository",
      "created_at",
      "created_at_ms",
      "observed_created_at",
      "orphan_instance_id",
      "state",
      "cleanup_started_at",
      "reconcile_token",
      "cleanup_due_at_ms",
      "cleanup_requested_by",
      "cleanup_attempts",
      "busy_since_ms",
      "revision",
      "destroyed_at",
      "destroyed_by",
    ];
    if (!requiredColumns.every((column) => columns.has(column))) {
      throw new Error("Runner registry schema columns do not match its version");
    }
    const observationColumns = new Set(
      this.sql
        .exec("PRAGMA table_info(orphan_observations)")
        .toArray()
        .map((column) => column.name),
    );
    const requiredObservationColumns = [
      "sandbox_id",
      "instance_id",
      "first_observed_at_ms",
    ];
    if (
      !requiredObservationColumns.every(
        (column) => observationColumns.has(column),
      )
    ) {
      throw new Error(
        "Runner registry orphan observation columns do not match its version",
      );
    }
    const reclaimObservationColumns = new Set(
      this.sql
        .exec("PRAGMA table_info(orphan_reclaim_observations)")
        .toArray()
        .map((column) => column.name),
    );
    const requiredReclaimObservationColumns = [
      "sandbox_id",
      "revision",
      "first_observed_at_ms",
    ];
    if (
      !requiredReclaimObservationColumns.every(
        (column) => reclaimObservationColumns.has(column),
      )
    ) {
      throw new Error(
        "Runner registry orphan reclaim observation columns do not match its version",
      );
    }
  }

  #ensureSchema() {
    if (this.schemaMigrationError === null) {
      return;
    }
    try {
      this.#migrateSchema();
    } catch (error) {
      this.schemaMigrationError = error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Runner registry schema is unavailable: ${message}`, {
        cause: error,
      });
    }
  }

  async recordStarting({
    sandboxId,
    runnerName,
    githubRunnerName = null,
    correlationId,
    repository = this.env.GITHUB_REPOSITORY,
    createdAt,
    createdAtMs,
  }) {
    this.#ensureSchema();
    const columns = `sandbox_id, runner_name, github_runner_name,
                     correlation_id, repository,
                     created_at, created_at_ms, orphan_instance_id, state,
                     cleanup_started_at,
                     reconcile_token, cleanup_due_at_ms,
                     cleanup_requested_by, destroyed_at, destroyed_by,
                     cleanup_attempts, busy_since_ms, revision`;
    const existingRows = this.sql
      .exec(
        `SELECT ${columns}
         FROM runners
         WHERE correlation_id = ?`,
        correlationId,
      )
      .toArray();
    if (existingRows.length === 1) {
      await this.#scheduleNextAlarm();
      return { created: false, runner: this.#runnerFromRow(existingRows[0]) };
    }
    if (existingRows.length !== 0) {
      throw new Error(
        `Runner correlation ${correlationId} resolved to multiple registry rows`,
      );
    }

    const activeCount = this.sql
      .exec(
        `SELECT COUNT(*) AS active_count
         FROM runners
         WHERE state IN ('starting', 'online', 'destroying')
           AND NOT (
             state = 'destroying' AND cleanup_requested_by = 'orphan'
           )`,
      )
      .toArray()[0]?.active_count;
    if (!Number.isSafeInteger(activeCount)) {
      throw new Error("Runner registry active count is invalid");
    }
    if (activeCount >= MAX_ACTIVE_RUNNERS) {
      throw new Error(
        `Runner registry active capacity is ${MAX_ACTIVE_RUNNERS}`,
      );
    }

    const cleanupDueAtMs = createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS;
    const insertedRows = this.sql
      .exec(
        `INSERT INTO runners (
           sandbox_id,
           runner_name,
           github_runner_name,
           correlation_id,
           repository,
           created_at,
           created_at_ms,
           state,
           cleanup_due_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?)
         RETURNING ${columns}`,
        sandboxId,
        runnerName,
        githubRunnerName,
        correlationId,
        repository,
        createdAt,
        createdAtMs,
        cleanupDueAtMs,
      )
      .toArray();
    if (insertedRows.length !== 1) {
      throw new Error(`Runner ${sandboxId} was not recorded`);
    }

    try {
      await this.#scheduleNextAlarm();
    } catch (error) {
      this.sql.exec(
        `DELETE FROM runners
         WHERE sandbox_id = ?
           AND correlation_id = ?
           AND state = 'starting'
           AND revision = 0`,
        sandboxId,
        correlationId,
      );
      throw error;
    }
    return { created: true, runner: this.#runnerFromRow(insertedRows[0]) };
  }

  getByCorrelation(correlationId) {
    this.#ensureSchema();
    if (typeof correlationId !== "string" || correlationId.length === 0) {
      throw new TypeError("correlationId must be a non-empty string");
    }
    const rows = this.#selectRunners(
      `SELECT sandbox_id, runner_name, github_runner_name,
              correlation_id, repository,
              created_at, created_at_ms, orphan_instance_id, state,
              cleanup_started_at, reconcile_token, cleanup_due_at_ms,
              cleanup_requested_by, destroyed_at, destroyed_by,
              cleanup_attempts, busy_since_ms, revision
       FROM runners
       WHERE correlation_id = ?`,
      correlationId,
    );
    if (rows.length > 1) {
      throw new Error(
        `Runner correlation ${correlationId} resolved to multiple registry rows`,
      );
    }
    return rows[0] ?? null;
  }

  markOnline(sandboxId) {
    this.#ensureSchema();
    const updatedRows = this.sql
      .exec(
        `UPDATE runners
         SET state = 'online', revision = revision + 1
         WHERE sandbox_id = ?
           AND state = 'starting'
           AND reconcile_token IS NULL
         RETURNING sandbox_id`,
        sandboxId,
      )
      .toArray();
    return updatedRows.length === 1;
  }

  // Reconcile and operator requests carry revisions from their registry reads.
  // Alarm selection and claiming use one turn and predicate on that revision.
  // The authenticated callback atomically claims its own live row, so its
  // state-and-token predicate is sufficient without a caller snapshot.
  beginCallbackCleanup(sandboxId, cleanupStartedAt) {
    return this.#queueCleanup(sandboxId, cleanupStartedAt, "callback");
  }

  beginStartupCleanup(sandboxId, cleanupStartedAt) {
    return this.#queueCleanup(sandboxId, cleanupStartedAt, "startup-failure");
  }

  async rearmStalledCleanup(sandboxId, rearmedAt) {
    this.#ensureSchema();
    const rearmedAtMs = this.#timestampMs(rearmedAt, "cleanup_started_at");
    // The 2026-08-25 incident recorded at MAX_CLEANUP_ATTEMPTS ran for 14.5
    // hours. Preserve the counter: an external nudge buys one attempt, never a
    // fresh sequence.
    const updatedRows = this.sql
      .exec(
        `UPDATE runners
         SET cleanup_due_at_ms = ?,
             cleanup_started_at = ?,
             reconcile_token = NULL,
             revision = revision + 1
         WHERE sandbox_id = ?
           AND state = 'destroying'
           AND cleanup_due_at_ms IS NULL
         RETURNING sandbox_id`,
        rearmedAtMs,
        rearmedAt,
        sandboxId,
      )
      .toArray();
    if (updatedRows.length === 1) {
      await this.#scheduleNextAlarm();
      return { rearmed: true };
    }

    const rows = this.sql
      .exec(
        `SELECT state
         FROM runners
         WHERE sandbox_id = ?`,
        sandboxId,
      )
      .toArray();
    if (rows.length === 0) {
      return { rearmed: false, reason: "not-found" };
    }
    if (rows[0].state !== "destroying") {
      return { rearmed: false, reason: "not-destroying" };
    }
    return { rearmed: false, reason: "already-armed" };
  }

  async #queueCleanup(sandboxId, cleanupStartedAt, cleanupRequestedBy) {
    this.#ensureSchema();
    const cleanupStartedAtMs = this.#timestampMs(
      cleanupStartedAt,
      "cleanup_started_at",
    );
    const cleanupDueAtMs = cleanupStartedAtMs + (
      cleanupRequestedBy === "callback"
        ? CALLBACK_CLEANUP_HANDOFF_DELAY_MS
        : 0
    );
    const updatedRows = this.sql
      .exec(
        `UPDATE runners
         SET state = 'destroying',
             cleanup_started_at = ?,
             reconcile_token = NULL,
             cleanup_due_at_ms = ?,
             cleanup_requested_by = ?,
             revision = revision + 1
         WHERE sandbox_id = ?
           AND state IN ('starting', 'online')
           AND reconcile_token IS NULL
         RETURNING sandbox_id, state`,
        cleanupStartedAt,
        cleanupDueAtMs,
        cleanupRequestedBy,
        sandboxId,
      )
      .toArray();
    if (updatedRows.length === 1) {
      await this.#scheduleNextAlarm();
      return { claimed: true, reason: "scheduled" };
    }
    return this.#cleanupClaimFailure(sandboxId);
  }

  async observeOrphanReclaim(
    sandboxId,
    expectedRevision,
    expectedRunnerName,
    observedAt,
  ) {
    this.#ensureSchema();
    const observedAtMs = this.#timestampMs(observedAt, "observed_at");
    const columns = `sandbox_id, runner_name, github_runner_name,
                     correlation_id, repository,
                     created_at, created_at_ms, orphan_instance_id, state,
                     cleanup_started_at, reconcile_token, cleanup_due_at_ms,
                     cleanup_requested_by, destroyed_at, destroyed_by,
                     cleanup_attempts, busy_since_ms, revision`;
    const rows = this.sql
      .exec(
        `SELECT ${columns}
         FROM runners
         WHERE sandbox_id = ?`,
        sandboxId,
      )
      .toArray();
    if (rows.length === 0) {
      return { ready: false, reason: "not-found" };
    }
    if (rows.length !== 1) {
      throw new Error("The orphan reclaim runner row is invalid");
    }

    const row = rows[0];
    const runner = this.#runnerFromRow(row);
    // Check immediately after the row read so not-found keeps precedence and
    // a mismatched GitHub attestation cannot reach any later registry write.
    const recordedRunnerName = runner.githubRunnerName ?? runner.runnerName;
    if (expectedRunnerName !== recordedRunnerName) {
      return {
        ready: false,
        reason: "runner-name-mismatch",
        runnerName: recordedRunnerName,
      };
    }
    if (runner.state === "destroyed") {
      return { ready: false, reason: "already-destroyed" };
    }
    if (runner.revision !== expectedRevision) {
      return {
        ready: false,
        reason: "revision-conflict",
        expectedRevision,
        actualRevision: runner.revision,
      };
    }

    const rowAgeMs = observedAtMs - row.created_at_ms;
    if (rowAgeMs < ORPHAN_DESTROY_GRACE_MS) {
      return {
        ready: false,
        reason: "within-grace",
        rowAgeMs,
      };
    }

    const observationRows = this.sql
      .exec(
        `SELECT first_observed_at_ms
         FROM orphan_reclaim_observations
         WHERE sandbox_id = ?
           AND revision = ?`,
        sandboxId,
        expectedRevision,
      )
      .toArray();
    if (observationRows.length === 0) {
      const insertedRows = this.sql
        .exec(
          `INSERT INTO orphan_reclaim_observations (
             sandbox_id,
             revision,
             first_observed_at_ms
           ) VALUES (?, ?, ?)
           RETURNING sandbox_id`,
          sandboxId,
          expectedRevision,
          observedAtMs,
        )
        .toArray();
      if (insertedRows.length !== 1) {
        throw new Error("The orphan reclaim observation was not recorded");
      }
      await this.#scheduleNextAlarm();
      return {
        ready: false,
        reason: "absence-recorded",
        revision: expectedRevision,
        reclaimableAtMs: observedAtMs + ORPHAN_DESTROY_GRACE_MS,
      };
    }
    if (
      observationRows.length !== 1 ||
      !Number.isSafeInteger(observationRows[0].first_observed_at_ms)
    ) {
      throw new Error("The orphan reclaim observation is invalid");
    }

    const firstObservedAtMs = observationRows[0].first_observed_at_ms;
    const observationAgeMs = observedAtMs - firstObservedAtMs;
    if (observationAgeMs > ORPHAN_OBSERVATION_MAX_AGE_MS) {
      const refreshedRows = this.sql
        .exec(
          `UPDATE orphan_reclaim_observations
           SET first_observed_at_ms = ?
           WHERE sandbox_id = ?
             AND revision = ?
             AND first_observed_at_ms = ?
           RETURNING sandbox_id`,
          observedAtMs,
          sandboxId,
          expectedRevision,
          firstObservedAtMs,
        )
        .toArray();
      if (refreshedRows.length !== 1) {
        throw new Error(
          "The stale orphan reclaim observation was not refreshed",
        );
      }
      await this.#scheduleNextAlarm();
      return {
        ready: false,
        reason: "absence-recorded",
        revision: expectedRevision,
        reclaimableAtMs: observedAtMs + ORPHAN_DESTROY_GRACE_MS,
      };
    }

    const reclaimableAtMs = firstObservedAtMs + ORPHAN_DESTROY_GRACE_MS;
    if (observedAtMs < reclaimableAtMs) {
      return {
        ready: false,
        reason: "absence-pending",
        revision: expectedRevision,
        reclaimableAtMs,
      };
    }
    return {
      ready: true,
      reason: "reclaimable",
      revision: expectedRevision,
      reclaimableAtMs,
      runner,
    };
  }

  async claimOrphanCleanup(
    sandboxId,
    observedCondition,
    expectedRevision,
    observedSandboxInstanceId,
    cleanupToken,
    cleanupStartedAt,
  ) {
    this.#ensureSchema();
    const cleanupStartedAtMs = this.#timestampMs(
      cleanupStartedAt,
      "cleanup_started_at",
    );
    const columns = `sandbox_id, runner_name, github_runner_name,
                     correlation_id, repository,
                     created_at, created_at_ms, orphan_instance_id, state,
                     cleanup_started_at,
                     reconcile_token, cleanup_due_at_ms,
                     cleanup_requested_by, destroyed_at, destroyed_by,
                     cleanup_attempts, busy_since_ms, revision`;
    const rows = this.#selectRunners(
      `SELECT ${columns}
       FROM runners
       WHERE sandbox_id = ?`,
      sandboxId,
    );
    const existingRunner = rows[0];
    const actualCondition = existingRunner === undefined
      ? "absent"
      : existingRunner.state === "destroyed"
        ? "terminal"
        : "live";
    if (actualCondition === "live") {
      return {
        claimed: false,
        reason: "live-row",
        actualCondition,
        runner: existingRunner,
      };
    }
    if (actualCondition !== observedCondition) {
      return {
        claimed: false,
        reason: "observation-mismatch",
        actualCondition,
      };
    }
    if (
      existingRunner !== undefined &&
      existingRunner.revision !== expectedRevision
    ) {
      return {
        claimed: false,
        reason: "revision-conflict",
        actualCondition,
        expectedRevision,
        actualRevision: existingRunner.revision,
      };
    }

    if (existingRunner !== undefined) {
      if (typeof existingRunner.destroyedAt !== "string") {
        return {
          claimed: false,
          reason: "terminal-generation-unverified",
          actualCondition,
        };
      }
      if (
        existingRunner.orphanInstanceId !== null &&
        existingRunner.orphanInstanceId !== observedSandboxInstanceId
      ) {
        return {
          claimed: false,
          reason: "sandbox-generation-mismatch",
          actualCondition,
          observedSandboxInstanceId,
          recordedSandboxInstanceId: existingRunner.orphanInstanceId,
        };
      }
      if (existingRunner.orphanInstanceId === null) {
        const boundRows = this.sql
          .exec(
            `UPDATE runners
             SET orphan_instance_id = ?
             WHERE sandbox_id = ?
               AND state = 'destroyed'
               AND revision = ?
               AND orphan_instance_id IS NULL
             RETURNING sandbox_id`,
            observedSandboxInstanceId,
            sandboxId,
            expectedRevision,
          )
          .toArray();
        if (boundRows.length !== 1) {
          throw new Error(
            "The terminal sandbox generation was not bound",
          );
        }
        existingRunner.orphanInstanceId = observedSandboxInstanceId;
      }
    }

    const observationRows = this.sql
      .exec(
        `SELECT first_observed_at_ms
         FROM orphan_observations
         WHERE sandbox_id = ?
           AND instance_id = ?`,
        sandboxId,
        observedSandboxInstanceId,
      )
      .toArray();
    if (observationRows.length === 0) {
      const insertedRows = this.sql
        .exec(
          `INSERT INTO orphan_observations (
             sandbox_id,
             instance_id,
             first_observed_at_ms
           ) VALUES (?, ?, ?)
           RETURNING sandbox_id`,
          sandboxId,
          observedSandboxInstanceId,
          cleanupStartedAtMs,
        )
        .toArray();
      if (insertedRows.length !== 1) {
        throw new Error("The orphan observation was not recorded");
      }
      await this.#scheduleNextAlarm();
      return {
        claimed: false,
        reason: "inside-grace",
        actualCondition,
        sandboxAgeMs: 0,
      };
    }
    if (
      observationRows.length !== 1 ||
      !Number.isSafeInteger(observationRows[0].first_observed_at_ms)
    ) {
      throw new Error("The orphan observation is invalid");
    }
    const sandboxAgeMs =
      cleanupStartedAtMs - observationRows[0].first_observed_at_ms;
    if (sandboxAgeMs > ORPHAN_OBSERVATION_MAX_AGE_MS) {
      const refreshedRows = this.sql
        .exec(
          `UPDATE orphan_observations
           SET first_observed_at_ms = ?
           WHERE sandbox_id = ?
             AND instance_id = ?
             AND first_observed_at_ms = ?
           RETURNING sandbox_id`,
          cleanupStartedAtMs,
          sandboxId,
          observedSandboxInstanceId,
          observationRows[0].first_observed_at_ms,
        )
        .toArray();
      if (refreshedRows.length !== 1) {
        throw new Error("The stale orphan observation was not refreshed");
      }
      await this.#scheduleNextAlarm();
      return {
        claimed: false,
        reason: "inside-grace",
        actualCondition,
        sandboxAgeMs: 0,
      };
    }
    if (sandboxAgeMs < ORPHAN_DESTROY_GRACE_MS) {
      return {
        claimed: false,
        reason: "inside-grace",
        actualCondition,
        sandboxAgeMs,
      };
    }

    let claimedRows;
    if (existingRunner === undefined) {
      const runnerName = runnerNameForSandbox(sandboxId);
      claimedRows = this.sql
        .exec(
          `INSERT INTO runners (
             sandbox_id,
             runner_name,
             correlation_id,
             created_at,
             created_at_ms,
             orphan_instance_id,
             state,
             cleanup_started_at,
             reconcile_token,
             cleanup_due_at_ms,
             cleanup_requested_by
           ) VALUES (?, ?, ?, ?, ?, ?, 'destroying', ?, ?, ?, 'orphan')
           RETURNING ${columns}`,
          sandboxId,
          runnerName,
          `orphan-cleanup:${sandboxId}`,
          cleanupStartedAt,
          cleanupStartedAtMs,
          observedSandboxInstanceId,
          cleanupStartedAt,
          cleanupToken,
          cleanupStartedAtMs + CLEANUP_CLAIM_STALE_MS,
        )
        .toArray();
    } else {
      claimedRows = this.sql
        .exec(
          `UPDATE runners
           SET state = 'destroying',
               orphan_instance_id = ?,
               cleanup_started_at = ?,
               reconcile_token = ?,
               cleanup_due_at_ms = ?,
               cleanup_requested_by = 'orphan',
               destroyed_at = NULL,
               destroyed_by = NULL,
               revision = revision + 1
           WHERE sandbox_id = ?
             AND state = 'destroyed'
             AND revision = ?
           RETURNING ${columns}`,
          observedSandboxInstanceId,
          cleanupStartedAt,
          cleanupToken,
          cleanupStartedAtMs + CLEANUP_CLAIM_STALE_MS,
          sandboxId,
          expectedRevision,
        )
        .toArray();
    }
    if (claimedRows.length !== 1) {
      return {
        claimed: false,
        reason: "observation-mismatch",
        actualCondition,
      };
    }

    const originalTerminal = existingRunner === undefined
      ? null
      : {
          cleanupStartedAt: existingRunner.cleanupStartedAt,
          orphanInstanceId: existingRunner.orphanInstanceId,
          destroyedAt: existingRunner.destroyedAt,
          destroyedBy: existingRunner.destroyedBy,
          revision: existingRunner.revision,
        };
    try {
      await this.#scheduleNextAlarm();
    } catch (error) {
      const compensatedRows = existingRunner === undefined
        ? this.sql
            .exec(
              `DELETE FROM runners
               WHERE sandbox_id = ?
                 AND state = 'destroying'
                 AND reconcile_token = ?
                 AND cleanup_requested_by = 'orphan'
                 AND correlation_id = ?
               RETURNING sandbox_id`,
              sandboxId,
              cleanupToken,
              `orphan-cleanup:${sandboxId}`,
            )
            .toArray()
        : this.sql
            .exec(
              `UPDATE runners
               SET state = 'destroyed',
                   orphan_instance_id = ?,
                   cleanup_started_at = ?,
                   reconcile_token = NULL,
                   cleanup_due_at_ms = NULL,
                   cleanup_requested_by = NULL,
                   destroyed_at = ?,
                   destroyed_by = ?,
                   revision = ?
               WHERE sandbox_id = ?
                 AND state = 'destroying'
                 AND reconcile_token = ?
                 AND cleanup_requested_by = 'orphan'
               RETURNING sandbox_id`,
              originalTerminal.orphanInstanceId,
              originalTerminal.cleanupStartedAt,
              originalTerminal.destroyedAt,
              originalTerminal.destroyedBy,
              originalTerminal.revision,
              sandboxId,
              cleanupToken,
            )
            .toArray();
      if (compensatedRows.length !== 1) {
        console.error(
          safeLogRecord({
            message: "failed to compensate orphan claim alarm rearm",
            sandboxId,
          }, this.env),
        );
      }
      throw error;
    }
    return {
      claimed: true,
      reason: "claimed",
      actualCondition,
      originalTerminal,
      runner: this.#runnerFromRow(claimedRows[0]),
    };
  }

  async settleCleanupClaim(
    sandboxId,
    cleanupToken,
    settlement,
    details = {},
  ) {
    this.#ensureSchema();
    let changedRows;
    if (settlement === "abandon") {
      changedRows = this.#abandonOrphanCleanupClaim(
        sandboxId,
        details.originalCondition,
        details.originalTerminal,
        cleanupToken,
      );
    } else if (settlement === "retry") {
      const settledAtMs = details.settledAtMs ?? Date.now();
      const cleanupStartedAt = new Date(settledAtMs).toISOString();
      changedRows = this.sql
        .exec(
          `UPDATE runners
           SET state = 'destroying',
               cleanup_started_at = ?,
               reconcile_token = NULL,
               cleanup_due_at_ms = CASE
                 WHEN cleanup_attempts >= ${MAX_CLEANUP_ATTEMPTS} THEN NULL
                 ELSE ?
               END,
               revision = revision + 1
           WHERE sandbox_id = ?
             AND state = 'destroying'
             AND reconcile_token = ?
           RETURNING sandbox_id, runner_name, cleanup_attempts,
                     cleanup_due_at_ms, cleanup_requested_by`,
          cleanupStartedAt,
          settledAtMs + CLEANUP_RETRY_DELAY_MS,
          sandboxId,
          cleanupToken,
        )
        .toArray();
    } else if (settlement === "complete") {
      this.#timestampMs(details.destroyedAt, "destroyed_at");
      changedRows = this.ctx.storage.transactionSync(() => {
        const claimRows = this.sql
          .exec(
            `SELECT cleanup_requested_by, orphan_instance_id
             FROM runners
             WHERE sandbox_id = ?
               AND state = 'destroying'
               AND reconcile_token = ?`,
            sandboxId,
            cleanupToken,
          )
          .toArray();
        const settledRows = this.sql
          .exec(
            `UPDATE runners
             SET state = 'destroyed',
                 destroyed_at = ?,
                 destroyed_by = ?,
                 reconcile_token = NULL,
                 cleanup_due_at_ms = NULL,
                 cleanup_requested_by = NULL,
                 revision = revision + 1
             WHERE sandbox_id = ?
               AND state = 'destroying'
               AND reconcile_token = ?
             RETURNING sandbox_id`,
            details.destroyedAt,
            details.destroyedBy,
            sandboxId,
            cleanupToken,
          )
          .toArray();
        const claimRow = claimRows[0];
        if (
          settledRows.length === 1 &&
          claimRows.length === 1 &&
          claimRow.cleanup_requested_by === "orphan"
        ) {
          if (typeof claimRow.orphan_instance_id !== "string") {
            throw new Error("The orphan cleanup generation is missing");
          }
          this.sql.exec(
            `DELETE FROM orphan_observations
             WHERE sandbox_id = ?
               AND instance_id = ?`,
            sandboxId,
            claimRow.orphan_instance_id,
          );
        }
        if (settledRows.length === 1) {
          this.sql.exec(
            `DELETE FROM orphan_reclaim_observations
             WHERE sandbox_id = ?`,
            sandboxId,
          );
        }
        return settledRows;
      });
    } else {
      throw new Error(`Unknown cleanup claim settlement ${settlement}`);
    }
    const changed = changedRows.length === 1;
    const cleanupStalled = settlement === "retry" &&
      changedRows[0]?.cleanup_due_at_ms === null;
    if (cleanupStalled) {
      const [stalledRunner] = changedRows;
      console.error(safeLogRecord({
        message: "runner registry cleanup stalled",
        sandboxId: stalledRunner.sandbox_id,
        runnerName: stalledRunner.runner_name,
        cleanupAttempts: stalledRunner.cleanup_attempts,
        cleanupRequestedBy: stalledRunner.cleanup_requested_by,
        remedy: "scripts/orphan-audit.sh --destroy",
      }, this.env));
    }
    if (changed) {
      await this.#scheduleNextAlarm(settlement !== "retry" || cleanupStalled);
    }
    return changed;
  }

  async settleUnownedOrphanCleanupClaim(
    sandboxId,
    originalCondition,
    originalTerminal = null,
  ) {
    this.#ensureSchema();
    const changedRows = this.#abandonOrphanCleanupClaim(
      sandboxId,
      originalCondition,
      originalTerminal,
    );
    const changed = changedRows.length === 1;
    if (changed) {
      await this.#scheduleNextAlarm(true);
    }
    return changed;
  }

  #abandonOrphanCleanupClaim(
    sandboxId,
    originalCondition,
    originalTerminal,
    cleanupToken,
  ) {
    if (originalCondition !== "absent" && originalCondition !== "terminal") {
      throw new Error(`Cannot abandon ${originalCondition} orphan claim`);
    }
    const tokenPredicate = cleanupToken === undefined
      ? ""
      : "\n               AND reconcile_token = ?";
    const tokenBindings = cleanupToken === undefined ? [] : [cleanupToken];
    return originalCondition === "absent"
      ? this.sql
          .exec(
            `DELETE FROM runners
             WHERE sandbox_id = ?
               AND state = 'destroying'
               AND cleanup_requested_by = 'orphan'
               AND correlation_id = ?${tokenPredicate}
             RETURNING sandbox_id`,
            sandboxId,
            `orphan-cleanup:${sandboxId}`,
            ...tokenBindings,
          )
          .toArray()
      : this.sql
          .exec(
            `UPDATE runners
             SET state = 'destroyed',
                 orphan_instance_id = ?,
                 cleanup_started_at = ?,
                 reconcile_token = NULL,
                 cleanup_due_at_ms = NULL,
                 cleanup_requested_by = NULL,
                 destroyed_at = ?,
                 destroyed_by = ?,
                 revision = revision + 1
             WHERE sandbox_id = ?
               AND state = 'destroying'
               AND cleanup_requested_by = 'orphan'${tokenPredicate}
             RETURNING sandbox_id`,
            originalTerminal?.orphanInstanceId ?? null,
            originalTerminal?.cleanupStartedAt ?? null,
            originalTerminal?.destroyedAt ?? null,
            originalTerminal?.destroyedBy ?? null,
            sandboxId,
            ...tokenBindings,
          )
          .toArray();
  }

  revalidateOrphanCleanupClaim(
    sandboxId,
    cleanupToken,
    checkedAtMs,
    observedSandboxInstanceId,
  ) {
    this.#ensureSchema();
    if ((cleanupToken === undefined) !== (checkedAtMs === undefined)) {
      throw new Error("Cleanup token and check time must be supplied together");
    }
    if (
      cleanupToken !== undefined &&
      observedSandboxInstanceId !== undefined &&
      typeof observedSandboxInstanceId !== "string"
    ) {
      throw new Error(
        "The observed sandbox instance identifier is required for claim revalidation",
      );
    }
    const ownershipPredicate = cleanupToken === undefined
      ? ""
      : `\n           AND reconcile_token = ?
           AND cleanup_due_at_ms > ?`;
    const ownershipBindings = cleanupToken === undefined
      ? []
      : [cleanupToken, checkedAtMs];
    const rows = this.sql
      .exec(
        `SELECT sandbox_id, orphan_instance_id
         FROM runners
         WHERE sandbox_id = ?
           AND state = 'destroying'
           AND cleanup_requested_by = 'orphan'${ownershipPredicate}`,
        sandboxId,
        ...ownershipBindings,
      )
      .toArray();
    if (rows.length !== 1) {
      return { valid: false, reason: "claim-lost" };
    }
    if (
      cleanupToken !== undefined &&
      observedSandboxInstanceId === undefined
    ) {
      if (rows[0].orphan_instance_id === null) {
        return { valid: true, migratedClaim: true };
      }
      throw new Error(
        "The observed sandbox instance identifier is required for claim revalidation",
      );
    }
    if (
      cleanupToken !== undefined &&
      typeof observedSandboxInstanceId === "string" &&
      rows[0].orphan_instance_id === null
    ) {
      const boundRows = this.sql.exec(
        `UPDATE runners
         SET orphan_instance_id = ?
         WHERE sandbox_id = ?
           AND state = 'destroying'
           AND cleanup_requested_by = 'orphan'
           AND reconcile_token = ?
           AND cleanup_due_at_ms > ?
           AND orphan_instance_id IS NULL
         RETURNING sandbox_id`,
        observedSandboxInstanceId,
        sandboxId,
        cleanupToken,
        checkedAtMs,
      ).toArray();
      if (boundRows.length !== 1) {
        return { valid: false, reason: "claim-lost" };
      }
      return {
        valid: true,
        migratedClaim: true,
        generationBound: true,
      };
    }
    if (
      observedSandboxInstanceId !== undefined &&
      rows[0].orphan_instance_id !== observedSandboxInstanceId
    ) {
      return {
        valid: false,
        reason: "sandbox-generation-mismatch",
        observedSandboxInstanceId,
        recordedSandboxInstanceId: rows[0].orphan_instance_id,
      };
    }
    return { valid: true };
  }

  async claimForReconcile(
    sandboxId,
    expectedRevision,
    reconcileToken,
    cleanupStartedAt,
  ) {
    this.#ensureSchema();
    const cleanupStartedAtMs = this.#timestampMs(
      cleanupStartedAt,
      "cleanup_started_at",
    );
    const staleClaimBefore = new Date(
      cleanupStartedAtMs - CLEANUP_CLAIM_STALE_MS,
    ).toISOString();
    // The 2026-08-25 incident recorded at MAX_CLEANUP_ATTEMPTS ran for 14.5
    // hours. Preserve the counter: an external nudge buys one attempt, never a
    // fresh sequence.
    const updatedRows = this.sql
      .exec(
        `UPDATE runners
         SET state = 'destroying',
             cleanup_started_at = ?,
             reconcile_token = ?,
             cleanup_due_at_ms = ?,
             cleanup_requested_by = 'reconcile',
             revision = revision + 1
         WHERE sandbox_id = ?
           AND revision = ?
           AND state IN ('starting', 'online', 'destroying')
           AND (
             cleanup_requested_by IS NULL OR
             cleanup_due_at_ms <= ? OR
             cleanup_due_at_ms IS NULL
           )
           AND (
             reconcile_token IS NULL OR
             cleanup_started_at <= ?
           )
         RETURNING sandbox_id, state`,
        cleanupStartedAt,
        reconcileToken,
        cleanupStartedAtMs + CLEANUP_CLAIM_STALE_MS,
        sandboxId,
        expectedRevision,
        cleanupStartedAtMs,
        staleClaimBefore,
      )
      .toArray();
    if (updatedRows.length === 1) {
      await this.#scheduleNextAlarm();
      return { claimed: true, reason: "claimed" };
    }
    return this.#cleanupClaimFailure(
      sandboxId,
      expectedRevision,
      reconcileToken,
    );
  }

  async claimNextDueCleanup(nowMs) {
    this.#ensureSchema();
    const columns = `sandbox_id, runner_name, github_runner_name,
                     correlation_id, repository,
                     created_at, created_at_ms, orphan_instance_id, state,
                     cleanup_started_at, reconcile_token,
                     cleanup_due_at_ms, cleanup_requested_by, destroyed_at,
                     destroyed_by, cleanup_attempts, busy_since_ms, revision`;
    const rows = this.#selectRunners(
      `SELECT ${columns}
       FROM runners
       WHERE state IN ('starting', 'online', 'destroying')
         AND cleanup_due_at_ms <= ?
       ORDER BY cleanup_due_at_ms ASC, created_at_ms ASC
       LIMIT 1`,
      nowMs,
    );
    const runner = rows[0];
    if (runner === undefined) {
      return null;
    }

    const cleanupStartedAt = new Date(nowMs).toISOString();
    const staleClaimBefore = new Date(
      nowMs - CLEANUP_CLAIM_STALE_MS,
    ).toISOString();
    const cleanupToken = crypto.randomUUID();
    const claimedRows = this.#selectRunners(
      `UPDATE runners
         SET state = 'destroying',
             cleanup_started_at = ?,
             reconcile_token = ?,
             cleanup_due_at_ms = ?,
             cleanup_requested_by = COALESCE(
               cleanup_requested_by,
               'alarm'
             ),
             cleanup_attempts = cleanup_attempts + 1,
             revision = revision + 1
         WHERE sandbox_id = ?
           AND revision = ?
           AND state IN ('starting', 'online', 'destroying')
           AND cleanup_due_at_ms <= ?
           AND (
             reconcile_token IS NULL OR
             cleanup_started_at <= ?
           )
         RETURNING ${columns}`,
      cleanupStartedAt,
      cleanupToken,
      nowMs + CLEANUP_CLAIM_STALE_MS,
      runner.sandboxId,
      runner.revision,
      nowMs,
      staleClaimBefore,
    );
    if (claimedRows.length !== 1) {
      await this.#scheduleNextAlarm(true);
      return null;
    }

    const claimedRunner = claimedRows[0];
    await this.#scheduleNextAlarm();
    return {
      cleanupToken,
      destroyedBy: claimedRunner.cleanupRequestedBy,
      previousState: runner.state,
      previousCleanupRequestedBy: runner.cleanupRequestedBy,
      runner: claimedRunner,
    };
  }

  async postponeBusyCleanup(
    sandboxId,
    cleanupToken,
    previousState,
    previousCleanupRequestedBy,
    checkedAtMs,
    options = {},
  ) {
    this.#ensureSchema();
    if (!["starting", "online", "destroying"].includes(previousState)) {
      throw new Error(`Cannot restore runner state ${previousState}`);
    }
    const cleanupRequestedBy = previousState === "destroying"
      ? previousCleanupRequestedBy
      : null;
    const cleanupDelayMs = previousState === "destroying"
      ? CLEANUP_RETRY_DELAY_MS
      : ACTIVE_RUNNER_CLEANUP_DELAY_MS;
    const postponement = this.ctx.storage.transactionSync(() => {
      const claimRows = this.sql
        .exec(
          `SELECT busy_since_ms
           FROM runners
           WHERE sandbox_id = ?
             AND state = 'destroying'
             AND reconcile_token = ?`,
          sandboxId,
          cleanupToken,
        )
        .toArray();
      if (claimRows.length === 0) {
        return {
          postponed: false,
          forcedBusyExit: false,
          busySinceMs: null,
          busyAgeMs: null,
        };
      }

      let busySinceMs = null;
      let busyAgeMs = null;
      if (options.busy === true) {
        const recordedBusySinceMs = Number.isSafeInteger(
          claimRows[0].busy_since_ms,
        )
          ? claimRows[0].busy_since_ms
          : null;
        busySinceMs = recordedBusySinceMs ?? checkedAtMs;
        busyAgeMs = Math.max(0, checkedAtMs - busySinceMs);
        if (busyAgeMs >= MAX_BUSY_POSTPONE_MS) {
          return {
            postponed: false,
            forcedBusyExit: true,
            busySinceMs,
            busyAgeMs,
          };
        }
      }

      const updatedRows = options.busy === true
        ? this.sql
            .exec(
              `UPDATE runners
               SET state = ?,
                   cleanup_started_at = NULL,
                   reconcile_token = NULL,
                   cleanup_due_at_ms = ?,
                   cleanup_requested_by = ?,
                   cleanup_attempts = 0,
                   busy_since_ms = COALESCE(busy_since_ms, ?),
                   revision = revision + 1
               WHERE sandbox_id = ?
                 AND state = 'destroying'
                 AND reconcile_token = ?
               RETURNING sandbox_id`,
              previousState,
              checkedAtMs + cleanupDelayMs,
              cleanupRequestedBy,
              checkedAtMs,
              sandboxId,
              cleanupToken,
            )
            .toArray()
        : this.sql
            .exec(
              `UPDATE runners
               SET state = ?,
                   cleanup_started_at = NULL,
                   reconcile_token = NULL,
                   cleanup_due_at_ms = ?,
                   cleanup_requested_by = ?,
                   cleanup_attempts = 0,
                   revision = revision + 1
               WHERE sandbox_id = ?
                 AND state = 'destroying'
                 AND reconcile_token = ?
               RETURNING sandbox_id`,
              previousState,
              checkedAtMs + cleanupDelayMs,
              cleanupRequestedBy,
              sandboxId,
              cleanupToken,
            )
            .toArray();
      return {
        postponed: updatedRows.length === 1,
        forcedBusyExit: false,
        busySinceMs,
        busyAgeMs,
      };
    });
    if (postponement.postponed) {
      await this.#scheduleNextAlarm(true);
    }
    return postponement;
  }

  listRunners(cursor = null) {
    this.#ensureSchema();
    const columns = `sandbox_id, runner_name, github_runner_name,
                     correlation_id, repository,
                     created_at, created_at_ms, orphan_instance_id, state,
                     cleanup_started_at, reconcile_token,
                     cleanup_due_at_ms, cleanup_requested_by, destroyed_at,
                     destroyed_by, cleanup_attempts, busy_since_ms, revision,
                     CASE WHEN state = 'destroyed' THEN 1 ELSE 0 END
                       AS terminal_rank`;
    const rows = cursor === null
      ? this.sql
          .exec(
            `SELECT ${columns}
             FROM runners
             ORDER BY terminal_rank ASC, created_at_ms DESC, sandbox_id DESC
             LIMIT ?`,
            RUNNER_LIST_PAGE_SIZE,
          )
          .toArray()
      : this.sql
          .exec(
            `SELECT ${columns}
             FROM runners
             WHERE (CASE WHEN state = 'destroyed' THEN 1 ELSE 0 END) > ?
                OR (
                  (CASE WHEN state = 'destroyed' THEN 1 ELSE 0 END) = ?
                  AND created_at_ms < ?
                )
                OR (
                  (CASE WHEN state = 'destroyed' THEN 1 ELSE 0 END) = ?
                  AND created_at_ms = ?
                  AND sandbox_id < ?
                )
             ORDER BY terminal_rank ASC, created_at_ms DESC, sandbox_id DESC
             LIMIT ?`,
            cursor.terminalRank,
            cursor.terminalRank,
            cursor.createdAtMs,
            cursor.terminalRank,
            cursor.createdAtMs,
            cursor.sandboxId,
            RUNNER_LIST_PAGE_SIZE,
          )
          .toArray();
    const lastRow = rows.at(-1);
    return {
      runners: rows.map((row) => this.#runnerFromRow(row)),
      pageSize: RUNNER_LIST_PAGE_SIZE,
      nextCursor:
        rows.length === RUNNER_LIST_PAGE_SIZE
          ? encodeRunnerCursor(
              lastRow.terminal_rank,
              lastRow.created_at_ms,
              lastRow.sandbox_id,
            )
          : null,
    };
  }

  listActiveBefore(cutoffMs, limit = RECONCILE_CANDIDATE_PAGE_SIZE) {
    this.#ensureSchema();
    if (!isPositiveSafeInteger(limit)) {
      throw new TypeError("limit must be a positive safe integer");
    }
    const effectiveLimit = Math.min(
      limit,
      RECONCILE_CANDIDATE_PAGE_SIZE,
    );
    const rows = this.#selectRunners(
      `SELECT sandbox_id, runner_name, github_runner_name,
              correlation_id, repository,
              created_at, created_at_ms, orphan_instance_id, state,
              cleanup_started_at, reconcile_token,
              cleanup_due_at_ms, cleanup_requested_by, destroyed_at,
              destroyed_by, cleanup_attempts, busy_since_ms, revision
       FROM runners
       WHERE state IN ('starting', 'online', 'destroying')
         AND created_at_ms <= ?
       ORDER BY created_at_ms ASC
       LIMIT ?`,
      cutoffMs,
      // Read one extra row so the response reports another page.
      effectiveLimit + 1,
    );
    return {
      runners: rows.slice(0, effectiveLimit),
      hasMore: rows.length > effectiveLimit,
    };
  }

  async alarm() {
    await this.runAlarmMaintenance();
  }

  async runAlarmMaintenance(services = {}) {
    // Application alarms own cleanup retries. A cleanup failure keeps a due
    // claim or releases it with CLEANUP_RETRY_DELAY_MS. Pruning then rearms
    // that due time. Do not rethrow and duplicate it with a platform retry.
    // A pruning or rearm failure still escapes, so the alarm chain cannot stop.
    try {
      await runRunnerRegistryAlarm(this.env, this, services);
    } catch (error) {
      console.error(
        safeLogRecord({
          message: "runner registry alarm cleanup failed",
          error: error instanceof Error ? error.message : String(error),
        }, this.env),
      );
    } finally {
      await this.pruneTerminalRows();
    }
  }

  scheduledAlarm() {
    return this.ctx.storage.getAlarm();
  }

  async pruneTerminalRows() {
    this.#ensureSchema();
    const pruningStartedAtMs = Date.now();
    const cutoffAt = new Date(
      pruningStartedAtMs - TERMINAL_RUNNER_RETENTION_MS,
    ).toISOString();
    const deletedRows = this.sql
      .exec(
        `DELETE FROM runners
         WHERE sandbox_id IN (
           SELECT sandbox_id
           FROM runners
           WHERE state = 'destroyed'
             AND destroyed_at <= ?
           ORDER BY destroyed_at ASC
           LIMIT ?
         )
         RETURNING sandbox_id`,
        cutoffAt,
        TERMINAL_RUNNER_PRUNE_BATCH_SIZE,
      )
      .toArray();
    const deletedObservationRows = this.sql
      .exec(
        `DELETE FROM orphan_observations
         WHERE rowid IN (
           SELECT rowid
           FROM orphan_observations
           WHERE first_observed_at_ms <= ?
           ORDER BY first_observed_at_ms ASC, sandbox_id ASC, instance_id ASC
           LIMIT ?
         )
         RETURNING sandbox_id`,
        pruningStartedAtMs - ORPHAN_OBSERVATION_MAX_AGE_MS,
        TERMINAL_RUNNER_PRUNE_BATCH_SIZE,
      )
      .toArray();
    const remainingObservationPruneCapacity = Math.max(
      0,
      TERMINAL_RUNNER_PRUNE_BATCH_SIZE - deletedObservationRows.length,
    );
    const deletedReclaimObservationRows = this.sql
      .exec(
        `DELETE FROM orphan_reclaim_observations
         WHERE rowid IN (
           SELECT rowid
           FROM orphan_reclaim_observations
           WHERE first_observed_at_ms <= ?
           ORDER BY first_observed_at_ms ASC, sandbox_id ASC, revision ASC
           LIMIT ?
         )
         RETURNING sandbox_id`,
        pruningStartedAtMs - ORPHAN_OBSERVATION_MAX_AGE_MS,
        remainingObservationPruneCapacity,
      )
      .toArray();
    await this.#scheduleNextAlarm(true);
    if (deletedRows.length > 0) {
      console.log(
        safeLogRecord({
          message: "pruned terminal runner registry rows",
          deletedRows: deletedRows.length,
        }, this.env),
      );
    }
    if (deletedObservationRows.length > 0) {
      console.log(
        safeLogRecord({
          message: "pruned orphan observations",
          deletedRows: deletedObservationRows.length,
        }, this.env),
      );
    }
    if (deletedReclaimObservationRows.length > 0) {
      console.log(
        safeLogRecord({
          message: "pruned orphan reclaim observations",
          deletedRows: deletedReclaimObservationRows.length,
        }, this.env),
      );
    }
  }

  async #scheduleNextAlarm(replaceCurrentAlarm = false) {
    const activeCleanupAt = this.sql
      .exec(
        `SELECT MIN(cleanup_due_at_ms) AS cleanup_due_at_ms
         FROM runners
         WHERE state IN ('starting', 'online', 'destroying')`,
      )
      .toArray()[0]?.cleanup_due_at_ms;
    const oldestTerminal = this.sql
      .exec(
        `SELECT MIN(destroyed_at) AS destroyed_at
         FROM runners
         WHERE state = 'destroyed'`,
      )
      .toArray()[0]?.destroyed_at;
    const oldestOrphanObservation = this.sql
      .exec(
        `SELECT MIN(first_observed_at_ms) AS first_observed_at_ms
         FROM orphan_observations`,
      )
      .toArray()[0]?.first_observed_at_ms;
    const oldestOrphanReclaimObservation = this.sql
      .exec(
        `SELECT MIN(first_observed_at_ms) AS first_observed_at_ms
         FROM orphan_reclaim_observations`,
      )
      .toArray()[0]?.first_observed_at_ms;
    const alarmTimes = [];
    if (
      activeCleanupAt !== null &&
      activeCleanupAt !== undefined &&
      !Number.isSafeInteger(activeCleanupAt)
    ) {
      console.error(
        safeLogRecord({
          message: "runner registry skipped an invalid cleanup_due_at_ms value",
          value: activeCleanupAt,
        }, this.env),
      );
    }
    if (Number.isSafeInteger(activeCleanupAt)) {
      alarmTimes.push(activeCleanupAt);
    }
    if (typeof oldestTerminal === "string") {
      const destroyedAtMs = Date.parse(oldestTerminal);
      if (!Number.isFinite(destroyedAtMs)) {
        console.error(
          safeLogRecord({
            message: "runner registry skipped an invalid destroyed_at value",
            value: oldestTerminal,
          }, this.env),
        );
      } else {
        alarmTimes.push(destroyedAtMs + TERMINAL_RUNNER_RETENTION_MS);
      }
    }
    if (
      oldestOrphanObservation !== null &&
      oldestOrphanObservation !== undefined &&
      !Number.isSafeInteger(oldestOrphanObservation)
    ) {
      console.error(
        safeLogRecord({
          message: "runner registry skipped an invalid orphan observation time",
          value: oldestOrphanObservation,
        }, this.env),
      );
    }
    if (Number.isSafeInteger(oldestOrphanObservation)) {
      alarmTimes.push(
        oldestOrphanObservation + ORPHAN_OBSERVATION_MAX_AGE_MS,
      );
    }
    if (
      oldestOrphanReclaimObservation !== null &&
      oldestOrphanReclaimObservation !== undefined &&
      !Number.isSafeInteger(oldestOrphanReclaimObservation)
    ) {
      console.error(
        safeLogRecord({
          message:
            "runner registry skipped an invalid orphan reclaim observation time",
          value: oldestOrphanReclaimObservation,
        }, this.env),
      );
    }
    if (Number.isSafeInteger(oldestOrphanReclaimObservation)) {
      alarmTimes.push(
        oldestOrphanReclaimObservation + ORPHAN_OBSERVATION_MAX_AGE_MS,
      );
    }
    if (alarmTimes.length === 0) {
      if (replaceCurrentAlarm) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }

    const nextAlarmAt = Math.max(Math.min(...alarmTimes), Date.now());
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (
      replaceCurrentAlarm ||
      currentAlarm === null ||
      currentAlarm > nextAlarmAt
    ) {
      await this.ctx.storage.setAlarm(nextAlarmAt);
    }
  }

  #cleanupClaimFailure(sandboxId, expectedRevision, cleanupToken) {
    const rows = this.sql
      .exec(
        `SELECT state, reconcile_token, cleanup_due_at_ms,
                cleanup_attempts, revision
         FROM runners
         WHERE sandbox_id = ?`,
        sandboxId,
      )
      .toArray();
    if (rows.length === 0) {
      return { claimed: false, reason: "not-found" };
    }
    if (rows[0].state === "destroyed") {
      return { claimed: false, reason: "already-destroyed" };
    }
    if (
      Number.isSafeInteger(expectedRevision) &&
      rows[0].revision !== expectedRevision &&
      rows[0].reconcile_token !== cleanupToken
    ) {
      return {
        claimed: false,
        reason: "revision-conflict",
        expectedRevision,
        actualRevision: rows[0].revision,
      };
    }
    if (rows[0].reconcile_token !== null) {
      return { claimed: false, reason: "contended" };
    }
    if (rows[0].state === "destroying") {
      return {
        claimed: false,
        reason: "already-scheduled",
        cleanupAttempts: rows[0].cleanup_attempts,
        cleanupStalled: rows[0].cleanup_due_at_ms === null,
      };
    }
    return { claimed: false, reason: "changed" };
  }

  #timestampMs(value, columnName) {
    const valueMs = Date.parse(value);
    if (!Number.isFinite(valueMs)) {
      throw new Error(`Runner registry ${columnName} value is invalid`);
    }
    return valueMs;
  }

  #selectRunners(query, ...bindings) {
    return this.sql
      .exec(query, ...bindings)
      .toArray()
      .map((row) => this.#runnerFromRow(row));
  }

  #runnerFromRow(row) {
    return {
      sandboxId: row.sandbox_id,
      runnerName: row.runner_name,
      githubRunnerName: row.github_runner_name ?? null,
      correlationId: row.correlation_id,
      repository: row.repository ?? this.env.GITHUB_REPOSITORY,
      createdAt: row.created_at,
      orphanInstanceId: row.orphan_instance_id ?? null,
      state: row.state,
      cleanupStartedAt: row.cleanup_started_at,
      cleanupDueAt:
        Number.isSafeInteger(row.cleanup_due_at_ms)
          ? new Date(row.cleanup_due_at_ms).toISOString()
          : null,
      cleanupRequestedBy: row.cleanup_requested_by,
      cleanupAttempts: row.cleanup_attempts,
      busySinceMs:
        Number.isSafeInteger(row.busy_since_ms) ? row.busy_since_ms : null,
      cleanupStalled:
        row.state === "destroying" && row.cleanup_due_at_ms === null,
      destroyedAt: row.destroyed_at,
      destroyedBy: row.destroyed_by,
      revision: row.revision,
    };
  }
}

function encodeRunnerCursor(terminalRank, createdAtMs, sandboxId) {
  return btoa(JSON.stringify([terminalRank, createdAtMs, sandboxId]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

class InvalidRunnerCursor extends Error {}

export function decodeRunnerCursor(value) {
  if (value === null) {
    return null;
  }

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = JSON.parse(atob(base64 + padding));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 3 ||
      (decoded[0] !== 0 && decoded[0] !== 1) ||
      !Number.isSafeInteger(decoded[1]) ||
      typeof decoded[2] !== "string" ||
      decoded[2].length === 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return {
      terminalRank: decoded[0],
      createdAtMs: decoded[1],
      sandboxId: decoded[2],
    };
  } catch {
    throw new InvalidRunnerCursor("The runner cursor is invalid");
  }
}

function getRunnerRegistry(env) {
  const id = env.RunnerRegistry.idFromName(REGISTRY_NAME);
  return env.RunnerRegistry.get(id);
}

async function authenticate(request, expectedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length < 32) {
    return false;
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const providedToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  return secureEqual(providedToken, expectedToken);
}

function buildMetadataValue(value) {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

async function handleVersionRequest(request, env) {
  if (request.method !== "GET") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: "GET" } },
    );
  }
  if (!(await authenticate(request, env.CONTROL_TOKEN))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json({
    sha: buildMetadataValue(env.BUILD_SHA),
    ref: buildMetadataValue(env.BUILD_REF),
    builtAt: buildMetadataValue(env.BUILD_TIME),
    worker: "gha-cloudflare-runner",
  });
}

async function createCleanupToken(sandboxId, controlToken) {
  return createHmacSha256Hex(sandboxId, controlToken);
}

function githubHeaders(githubToken) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${githubToken}`,
    "User-Agent": "cloudflare-sandbox-actions-runner",
    "X-GitHub-Api-Version": "2026-03-10",
  };
}

export class GitHubRunnerListPageLimitExceeded extends Error {
  constructor(label, pagesFetched) {
    super(
      `GitHub runner listing for ${label} exceeded the ` +
        `${pagesFetched}-page reconcile limit`,
    );
    this.name = "GitHubRunnerListPageLimitExceeded";
    this.subrequestsSpent = pagesFetched;
  }
}

async function listRepositoryRunners(
  scope,
  githubToken,
  signal,
  runnerName,
) {
  const runners = [];
  let page = 1;
  const pageLimit = RECONCILE_LISTING_PAGINATION_RESERVE + 1;

  while (true) {
    const query = new URLSearchParams({
      per_page: String(GITHUB_RUNNER_LIST_PAGE_SIZE),
      page: String(page),
      ...(runnerName === undefined ? {} : { name: runnerName }),
    });
    const response = await fetch(
      `https://api.github.com${runnerListPath(scope)}?${query}`,
      { headers: githubHeaders(githubToken), signal },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub runner-list request failed: ${response.status}`);
    }

    const body = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray(body.runners)
    ) {
      throw new Error("GitHub returned an invalid runner-list response");
    }

    for (const runner of body.runners) {
      if (
        typeof runner !== "object" ||
        runner === null ||
        typeof runner.id !== "number" ||
        typeof runner.name !== "string" ||
        typeof runner.status !== "string" ||
        typeof runner.busy !== "boolean"
      ) {
        throw new Error("GitHub returned an invalid runner record");
      }
      runners.push(runner);
    }

    if (body.runners.length < GITHUB_RUNNER_LIST_PAGE_SIZE) {
      return runners;
    }
    if (page === pageLimit) {
      throw new GitHubRunnerListPageLimitExceeded(
        runnerScopeLabel(scope),
        page,
      );
    }
    page += 1;
  }
}

async function deleteRepositoryRunner(
  scope,
  githubToken,
  runnerId,
  signal,
) {
  const response = await fetch(
    `https://api.github.com${runnerPath(scope, runnerId)}`,
    {
      method: "DELETE",
      headers: githubHeaders(githubToken),
      signal,
    },
  );

  if (response.status === 404) {
    await response.body?.cancel();
    return "already-absent";
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub runner-delete request failed: ${response.status}`);
  }

  await response.body?.cancel();
  return "deleted";
}

async function findRepositoryRunnerByName(
  scope,
  githubToken,
  runnerName,
  signal,
) {
  const runners = await listRepositoryRunners(
    scope,
    githubToken,
    signal,
    runnerName,
  );
  const runner = runners.find((candidate) => candidate.name === runnerName);
  return runner === undefined
    ? { outcome: "registration-not-found", runnerName }
    : {
        outcome: "registration-found",
        runnerId: runner.id,
        runnerName: runner.name,
        status: runner.status,
        busy: runner.busy,
      };
}

export class SandboxDestroyTimeout extends Error {}
class CleanupClaimLeaseExpired extends Error {
  constructor(message, timeoutMs) {
    super(message);
    this.timeoutMs = timeoutMs;
  }
}

function beginSandboxDestroy(sandbox) {
  return Promise.resolve().then(() => sandbox.destroy());
}

async function waitForSandboxDestroy(
  destroyPromise,
  sandboxId,
  {
    timeoutMs = DESTROY_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  let timeoutId;
  try {
    await Promise.race([
      destroyPromise,
      new Promise((_, reject) => {
        timeoutId = setTimeoutFn(() => {
          reject(
            new SandboxDestroyTimeout(
              `Sandbox ${sandboxId} destruction exceeded ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeoutFn(timeoutId);
  }
}

async function runCleanupClaimPhase(
  phase,
  operation,
  claimExpiresAtMs,
  now,
  {
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  const remainingLeaseMs = claimExpiresAtMs - now();
  if (remainingLeaseMs <= 0) {
    throw new CleanupClaimLeaseExpired(
      `The orphan cleanup claim expired before ${phase}`,
      0,
    );
  }
  const timeoutMs = Math.min(DESTROY_TIMEOUT_MS, remainingLeaseMs);
  const abortController = new AbortController();
  let timeoutId;
  try {
    return await Promise.race([
      operation(abortController.signal),
      new Promise((_, reject) => {
        timeoutId = setTimeoutFn(() => {
          reject(
            new CleanupClaimLeaseExpired(
              `The orphan cleanup claim expired during ${phase}`,
              timeoutMs,
            ),
          );
          abortController.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeoutFn(timeoutId);
  }
}

async function retryCleanupClaim(
  env,
  registry,
  sandboxId,
  cleanupToken,
  failureMessage,
  settledAtMs,
) {
  try {
    const retried = await registry.settleCleanupClaim(
      sandboxId,
      cleanupToken,
      "retry",
      { settledAtMs },
    );
    if (!retried) {
      console.error(
        safeLogRecord({
          message: `${failureMessage}: cleanup claim did not match`,
          sandboxId,
        }, env),
      );
    }
  } catch (error) {
    console.error(
      safeLogRecord({
        message: failureMessage,
        error: error instanceof Error ? error.message : String(error),
        sandboxId,
      }, env),
    );
  }
}

function upstreamStatusFromError(error) {
  // A status below 400 alongside a spawn failure is not evidence that an
  // upstream request failed.
  for (const status of [
    error?.status,
    error?.statusCode,
    error?.response?.status,
  ]) {
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }
  const match = typeof error?.message === "string"
    ? error.message.match(
      /\b(?:failed|request failed|responded)(?: with)?(?: status)?: ([45][0-9]{2})$/u,
    )
    : null;
  if (match === null) {
    return null;
  }
  return Number(match[1]);
}

class RunnerPhaseError extends Error {
  constructor(phase, error) {
    super(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
    this.phase = phase;
  }
}

class RunnerSpawnPhaseError extends RunnerPhaseError {
  constructor(phase, error) {
    super(phase, error);
    this.name = "RunnerSpawnPhaseError";
    this.upstreamStatus = upstreamStatusFromError(error);
  }
}

class RunnerCleanupPhaseError extends RunnerPhaseError {
  constructor(
    phase,
    error,
    { claimSettlement = "retry", destroyStarted = false } = {},
  ) {
    super(phase, error);
    this.claimSettlement = claimSettlement;
    this.destroyStarted = destroyStarted;
  }
}

const ORPHAN_OWNERSHIP_ACTIONS = Object.freeze({
  "github-runner-delete": "GitHub runner deletion",
  "sandbox-destroy": "sandbox destruction",
});

async function orphanClaimRevalidationRefusal(
  registry,
  sandboxId,
  cleanupToken,
  checkedAtMs,
  observedSandboxInstanceId,
  phase,
) {
  let revalidation;
  try {
    revalidation = await registry.revalidateOrphanCleanupClaim(
      sandboxId,
      cleanupToken,
      checkedAtMs,
      observedSandboxInstanceId,
    );
  } catch (error) {
    return {
      status: 502,
      body: {
        outcome: "failed",
        phase: "registry-ownership-check",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (revalidation === true || revalidation?.valid === true) {
    return null;
  }
  if (revalidation?.reason === "sandbox-generation-mismatch") {
    return {
      status: 409,
      body: {
        outcome: "sandbox-generation-mismatch",
        phase,
        observedSandboxInstanceId:
          revalidation.observedSandboxInstanceId,
        recordedSandboxInstanceId:
          revalidation.recordedSandboxInstanceId,
        error:
          "The observed sandbox instance does not match the claimed generation",
      },
    };
  }
  return {
    status: 409,
    body: {
      outcome: "claim-lost",
      phase,
      error:
        `The orphan cleanup claim changed before ${ORPHAN_OWNERSHIP_ACTIONS[phase]}`,
    },
  };
}

// The registry's runner_name is a sandbox-derived label GitHub never held.
// github_runner_name records the JIT name GitHub issued and echoed back.
// Only that name may drive a GitHub lookup or deletion. A row without one
// (predating the column, or a dispatch that never got a JIT name) yields null,
// and null means "do not touch any GitHub registration" — never a fallback to
// runner_name, which would query a name that cannot exist and turn every guard
// downstream into a guard that cannot fire.
function authoritativeGithubRunnerName(runner) {
  if (typeof runner?.githubRunnerName !== "string") {
    return null;
  }
  const runnerName = runner.githubRunnerName.trim();
  return runnerName === "" ? null : runnerName;
}

function alarmOrphanRegistrationRefusal(liveRegistration, runner) {
  if (liveRegistration.outcome !== "registration-found") {
    return null;
  }
  if (liveRegistration.busy) {
    return {
      outcome: "runner-busy",
      runnerName: runner.runnerName,
      githubRunnerId: liveRegistration.runnerId,
      error: "The matching GitHub runner is busy",
    };
  }
  if (liveRegistration.status === "online") {
    return {
      outcome: "runner-online",
      runnerName: runner.runnerName,
      githubRunnerId: liveRegistration.runnerId,
      error: "An online GitHub runner requires a terminal registry row",
    };
  }
  return null;
}

// A forced busy exit re-runs orphan cleanup with no registration refusal. Both
// alarm refusals exist to protect a runner GitHub still considers live, and the
// busy bound is the evidence that overrides them: two busy observations at
// least MAX_BUSY_POSTPONE_MS apart on a single-job ephemeral runner. Keeping the
// runner-online refusal here would make the forced exit unreachable for the
// ordinary stale shape, which reports status "online" alongside busy, and would
// leave the reservation held for the whole MAX_CLEANUP_ATTEMPTS retry sequence.
// The non-forced path keeps both refusals unchanged.
function forcedBusyOrphanRegistrationRefusal() {
  return null;
}

function logRegistrationDeleteDisabled(
  env,
  services,
  runner,
  githubRunnerName,
  runnerId,
) {
  serviceLogger(services).log(safeLogRecord({
    message: "GitHub runner registration deletion disabled",
    sandboxId: runner.sandboxId,
    runnerName: githubRunnerName,
    githubRunnerId: runnerId,
  }, env));
}

async function releaseDestroyedRunnerReservation(
  env,
  sandboxId,
  destroyedBy,
  services,
) {
  try {
    const control = services.control ?? getAutopilotControl(env);
    const outcome = await control.releaseBySandbox({
      sandboxId,
      reason: "runner-destroyed",
    });
    const {
      released,
      replayed = false,
      reservationId = null,
      reason: releaseReason = null,
    } = outcome;
    serviceLogger(services).log(safeLogRecord({
      message: "released destroyed runner reservation",
      sandboxId,
      destroyedBy,
      released,
      replayed,
      reservationId,
      releaseReason,
    }, env));
    return outcome;
  } catch (error) {
    // Destruction is durable and irreversible here. Retrying cleanup would
    // re-destroy a gone sandbox. The one-hour control sweep is the backstop.
    logSuppressedSecondaryFailure(
      serviceLogger(services),
      env,
      () => ({
        message: "failed to release destroyed runner reservation",
        sandboxId,
        destroyedBy,
        error: loggedError(error),
      }),
    );
    return { released: false, reason: "release-failed" };
  }
}

async function executeClaimedOrphanCleanup(
  env,
  registry,
  claim,
  registrationRefusal,
  services = {},
) {
  const { cleanupToken, runner } = claim;
  const githubRunnerName = authoritativeGithubRunnerName(runner);
  const repository = runner.repository ?? env.GITHUB_REPOSITORY;
  const scope = resolveRunnerScope(env, repository);
  const observedSandboxInstanceId =
    claim.observedSandboxInstanceId ?? runner.orphanInstanceId;
  const now = services.now ?? Date.now;
  const claimExpiresAtMs = Date.parse(runner.cleanupDueAt);
  if (!Number.isFinite(claimExpiresAtMs)) {
    throw new RunnerCleanupPhaseError(
      "registry-claim",
      new Error("The orphan cleanup claim has an invalid lease deadline"),
      { claimSettlement: "abandon" },
    );
  }
  const findRunner =
    services.findRepositoryRunnerByName ?? findRepositoryRunnerByName;
  const deleteRunner =
    services.deleteRepositoryRunner ?? deleteRepositoryRunner;
  const getCleanupSandbox =
    services.reconciliationSandbox ?? reconciliationSandbox;
  const startDestroy = services.beginSandboxDestroy ?? beginSandboxDestroy;
  const waitForDestroy =
    services.waitForSandboxDestroy ?? waitForSandboxDestroy;
  const timerOptions = {
    setTimeoutFn: services.setTimeout ?? setTimeout,
    clearTimeoutFn: services.clearTimeout ?? clearTimeout,
  };
  const lookupRegistration = async (label, phase) => {
    try {
      return await runCleanupClaimPhase(
        label,
        (signal) => findRunner(
          scope,
          env.GITHUB_TOKEN,
          githubRunnerName,
          signal,
        ),
        claimExpiresAtMs,
        now,
        timerOptions,
      );
    } catch (error) {
      throw new RunnerCleanupPhaseError(phase, error, {
        claimSettlement: "abandon",
      });
    }
  };

  let liveRegistration = githubRunnerName === null
    ? { outcome: "registration-name-unknown", runnerName: null }
    : await lookupRegistration(
        "GitHub runner check",
        "github-runner-check",
      );
  let refusalBody = registrationRefusal(liveRegistration, runner);
  if (refusalBody !== null) {
    return {
      status: "refused",
      refusal: { status: 409, body: refusalBody },
      runner,
      liveRegistration,
    };
  }

  // The orphan path deletes the registration first. This order prevents a
  // failed delete from retrying against a sandbox that is already gone. The
  // deliberate second live check guards the first irreversible action.
  if (githubRunnerName !== null) {
    liveRegistration = await lookupRegistration(
      "GitHub runner recheck",
      "github-runner-recheck",
    );
    refusalBody = registrationRefusal(liveRegistration, runner);
    if (refusalBody !== null) {
      return {
        status: "refused",
        refusal: { status: 409, body: refusalBody },
        runner,
        liveRegistration,
      };
    }
  }

  let registrationCleanup;
  if (liveRegistration.outcome === "registration-found") {
    const ownershipRefusal = await orphanClaimRevalidationRefusal(
      registry,
      runner.sandboxId,
      cleanupToken,
      now(),
      observedSandboxInstanceId,
      "github-runner-delete",
    );
    if (ownershipRefusal !== null) {
      return {
        status: "refused",
        refusal: ownershipRefusal,
        runner,
        liveRegistration,
      };
    }
    try {
      let result;
      if (env.RUNNER_REGISTRATION_DELETE === "off") {
        logRegistrationDeleteDisabled(
          env,
          services,
          runner,
          githubRunnerName,
          liveRegistration.runnerId,
        );
        result = "delete-disabled";
      } else {
        result = await runCleanupClaimPhase(
          "GitHub runner deletion",
          (signal) => deleteRunner(
            scope,
            env.GITHUB_TOKEN,
            liveRegistration.runnerId,
            signal,
          ),
          claimExpiresAtMs,
          now,
          timerOptions,
        );
      }
      registrationCleanup = {
        runnerId: liveRegistration.runnerId,
        result,
      };
    } catch (error) {
      throw new RunnerCleanupPhaseError("github-runner-delete", error, {
        claimSettlement: "abandon",
      });
    }
  } else if (liveRegistration.outcome === "registration-name-unknown") {
    registrationCleanup = { runnerId: null, result: "name-unknown" };
  } else {
    registrationCleanup = { runnerId: null, result: "already-absent" };
  }

  let sandbox;
  try {
    sandbox = getCleanupSandbox(env, runner.sandboxId);
  } catch (error) {
    throw new RunnerCleanupPhaseError("sandbox-access", error, {
      claimSettlement: "abandon",
    });
  }

  const ownershipRefusal = await orphanClaimRevalidationRefusal(
    registry,
    runner.sandboxId,
    cleanupToken,
    now(),
    observedSandboxInstanceId,
    "sandbox-destroy",
  );
  if (ownershipRefusal !== null) {
    return {
      status: "refused",
      refusal: ownershipRefusal,
      runner,
      liveRegistration,
    };
  }

  let destroyStarted = false;
  try {
    await runCleanupClaimPhase(
      "sandbox destruction",
      () => {
        const destroyPromise = startDestroy(sandbox);
        destroyStarted = true;
        return waitForDestroy(
          destroyPromise,
          runner.sandboxId,
          timerOptions,
        );
      },
      claimExpiresAtMs,
      now,
      timerOptions,
    );
  } catch (error) {
    throw new RunnerCleanupPhaseError("sandbox-destroy", error, {
      claimSettlement: destroyStarted ? "retry" : "abandon",
      destroyStarted,
    });
  }

  try {
    const completed = await registry.settleCleanupClaim(
      runner.sandboxId,
      cleanupToken,
      "complete",
      {
        destroyedAt: new Date(now()).toISOString(),
        destroyedBy: "orphan",
      },
    );
    if (!completed) {
      throw new Error(
        "The orphan cleanup claim changed before the terminal record",
      );
    }
  } catch (error) {
    throw new RunnerCleanupPhaseError("registry-update", error);
  }

  // Reaching this point requires settleCleanupClaim("complete") to return true.
  // It moves destroying to destroyed under this token after destroy resolves.
  await releaseDestroyedRunnerReservation(
    env,
    runner.sandboxId,
    "orphan",
    services,
  );

  return {
    status: "destroyed",
    runner,
    githubRunner: liveRegistration.outcome === "registration-found"
      ? liveRegistration
      : undefined,
    liveRegistration,
    registrationCleanup,
  };
}

async function executeClaimedRunnerCleanup(
  env,
  registry,
  claim,
  services = {},
) {
  const { cleanupToken, destroyedBy, runner } = claim;
  const repository = runner.repository ?? env.GITHUB_REPOSITORY;
  const scope = resolveRunnerScope(env, repository);
  const now = services.now ?? Date.now;
  if (destroyedBy === "orphan") {
    const executeOrphanCleanup = async (registrationRefusal) => {
      try {
        return await executeClaimedOrphanCleanup(
          env,
          registry,
          claim,
          registrationRefusal,
          services,
        );
      } catch (error) {
        await retryCleanupClaim(
          env,
          registry,
          runner.sandboxId,
          cleanupToken,
          "failed to retry orphan cleanup claim",
          now(),
        );
        throw error;
      }
    };
    let outcome = await executeOrphanCleanup(alarmOrphanRegistrationRefusal);
    let forcedBusyExit = false;
    if (outcome.status === "refused") {
      if (outcome.refusal.body.outcome === "runner-busy") {
        let postponement;
        try {
          postponement = await registry.postponeBusyCleanup(
            runner.sandboxId,
            cleanupToken,
            claim.previousState ?? runner.state,
            claim.previousCleanupRequestedBy ?? runner.cleanupRequestedBy,
            now(),
            { busy: true },
          );
          if (postponement.forcedBusyExit === true) {
            forcedBusyExit = true;
            serviceLogger(services).log(safeLogRecord({
              message: "runner registry forced busy exit",
              sandboxId: runner.sandboxId,
              runnerName: runner.runnerName,
              githubRunnerId: outcome.liveRegistration?.runnerId ?? null,
              busySinceMs: postponement.busySinceMs,
              busyAgeMs: postponement.busyAgeMs,
              maxBusyPostponeMs: MAX_BUSY_POSTPONE_MS,
            }, env));
          } else if (!postponement.postponed) {
            throw new Error(
              `Runner registry cleanup claim changed before ${runner.sandboxId} was retained`,
            );
          }
        } catch (error) {
          throw new RunnerCleanupPhaseError("registry-busy-release", error);
        }
        if (!forcedBusyExit) {
          return {
            status: "retained-busy",
            runner,
            githubRunner: outcome.liveRegistration,
          };
        }
        outcome = await executeOrphanCleanup(
          forcedBusyOrphanRegistrationRefusal,
        );
      }
    }
    if (outcome.status === "refused") {
      if (outcome.refusal.body.outcome !== "claim-lost") {
        await retryCleanupClaim(
          env,
          registry,
          runner.sandboxId,
          cleanupToken,
          "failed to retry refused orphan cleanup claim",
          now(),
        );
      }
      throw new RunnerCleanupPhaseError(
        outcome.refusal.body.phase ?? "orphan-cleanup-refusal",
        new Error(outcome.refusal.body.error),
      );
    }
    return {
      ...outcome,
      ...(forcedBusyExit ? { forcedBusyExit: true } : {}),
    };
  }
  const findRunner =
    services.findRepositoryRunnerByName ?? findRepositoryRunnerByName;
  const deleteRunner =
    services.deleteRepositoryRunner ?? deleteRepositoryRunner;
  const getCleanupSandbox =
    services.reconciliationSandbox ?? reconciliationSandbox;
  const startDestroy = services.beginSandboxDestroy ?? beginSandboxDestroy;
  const waitForDestroy =
    services.waitForSandboxDestroy ?? waitForSandboxDestroy;
  const timerOptions = {
    setTimeoutFn: services.setTimeout ?? setTimeout,
    clearTimeoutFn: services.clearTimeout ?? clearTimeout,
  };

  const githubRunnerName = authoritativeGithubRunnerName(runner);
  let liveRunner;
  if (githubRunnerName !== null) {
    try {
      const registration = await findRunner(
        scope,
        env.GITHUB_TOKEN,
        githubRunnerName,
      );
      liveRunner = registration.outcome === "registration-found"
        ? registration
        : undefined;
    } catch (error) {
      await retryCleanupClaim(
        env,
        registry,
        runner.sandboxId,
        cleanupToken,
        "failed to release cleanup claim after GitHub runner check",
        now(),
      );
      throw new RunnerCleanupPhaseError("github-runner-check", error);
    }
  }
  const gatedRunnerId = liveRunner?.runnerId ?? null;

  let busyPostponement = null;
  if (liveRunner?.busy) {
    try {
      busyPostponement = await registry.postponeBusyCleanup(
        runner.sandboxId,
        cleanupToken,
        claim.previousState ?? runner.state,
        claim.previousCleanupRequestedBy ?? runner.cleanupRequestedBy,
        now(),
        { busy: true },
      );
      if (busyPostponement.forcedBusyExit === true) {
        serviceLogger(services).log(safeLogRecord({
          message: "runner registry forced busy exit",
          sandboxId: runner.sandboxId,
          runnerName: runner.runnerName,
          githubRunnerId: liveRunner.runnerId ?? null,
          busySinceMs: busyPostponement.busySinceMs,
          busyAgeMs: busyPostponement.busyAgeMs,
          maxBusyPostponeMs: MAX_BUSY_POSTPONE_MS,
        }, env));
      } else if (!busyPostponement.postponed) {
        throw new Error(
          `Runner registry cleanup claim changed before ${runner.sandboxId} was retained`,
        );
      }
    } catch (error) {
      throw new RunnerCleanupPhaseError("registry-busy-release", error);
    }
    if (busyPostponement.forcedBusyExit !== true) {
      return {
        status: "retained-busy",
        runner,
        githubRunner: liveRunner,
      };
    }
  }
  const forcedBusyExit = busyPostponement?.forcedBusyExit === true;

  if (
    !forcedBusyExit &&
    claim.retainOnlineRunner === true &&
    liveRunner?.status === "online"
  ) {
    try {
      const postponement = await registry.postponeBusyCleanup(
        runner.sandboxId,
        cleanupToken,
        claim.previousState ?? runner.state,
        claim.previousCleanupRequestedBy ?? runner.cleanupRequestedBy,
        now(),
      );
      if (!postponement.postponed) {
        throw new Error(
          `Runner registry cleanup claim changed before ${runner.sandboxId} was retained`,
        );
      }
    } catch (error) {
      throw new RunnerCleanupPhaseError("registry-online-release", error);
    }
    return {
      status: "retained-online",
      runner,
      githubRunner: liveRunner,
    };
  }

  const cleanupRegistration = async () => {
    if (githubRunnerName === null) {
      return { runnerId: null, result: "name-unknown" };
    }
    if (gatedRunnerId === null) {
      return { runnerId: null, result: "already-absent" };
    }

    // The authoritative name is non-unique across runner-request redeliveries.
    // Recheck the gated identity and guards before deleting by ID so a later
    // sandbox cannot inherit this deletion. A guard that queries a name GitHub
    // cannot hold is not a guard, so both checks use githubRunnerName.
    try {
      const registration = await findRunner(
        scope,
        env.GITHUB_TOKEN,
        githubRunnerName,
      );
      if (registration.outcome === "registration-not-found") {
        return { runnerId: null, result: "already-absent" };
      }
      if (registration.runnerId !== gatedRunnerId) {
        return {
          runnerId: registration.runnerId,
          result: "registration-identity-changed",
        };
      }
      // A forced exit reaches this check after sandbox destruction ended its
      // job. Retention protects nothing and leaves a busy phantom in GitHub.
      if (registration.busy && !forcedBusyExit) {
        return {
          runnerId: registration.runnerId,
          result: "retained-busy",
        };
      }
      if (
        !forcedBusyExit &&
        claim.retainOnlineRunner === true &&
        registration.status === "online"
      ) {
        return {
          runnerId: registration.runnerId,
          result: "retained-online",
        };
      }
      if (env.RUNNER_REGISTRATION_DELETE === "off") {
        logRegistrationDeleteDisabled(
          env,
          services,
          runner,
          githubRunnerName,
          registration.runnerId,
        );
        return {
          runnerId: registration.runnerId,
          result: "delete-disabled",
        };
      }
      return {
        runnerId: registration.runnerId,
        result: await deleteRunner(
          scope,
          env.GITHUB_TOKEN,
          registration.runnerId,
        ),
      };
    } catch (error) {
      await retryCleanupClaim(
        env,
        registry,
        runner.sandboxId,
        cleanupToken,
        "failed to release cleanup claim after GitHub runner deletion",
        now(),
      );
      throw new RunnerCleanupPhaseError("github-runner-delete", error);
    }
  };

  let registrationCleanup;
  try {
    const sandbox = getCleanupSandbox(env, runner.sandboxId);
    const destroyPromise = startDestroy(sandbox);
    await waitForDestroy(destroyPromise, runner.sandboxId, timerOptions);
  } catch (error) {
    await retryCleanupClaim(
      env,
      registry,
      runner.sandboxId,
      cleanupToken,
      "failed to release cleanup claim after sandbox destruction",
      now(),
    );
    throw new RunnerCleanupPhaseError("sandbox-destroy", error);
  }

  registrationCleanup = await cleanupRegistration();

  try {
    const completed = await registry.settleCleanupClaim(
      runner.sandboxId,
      cleanupToken,
      "complete",
      {
        destroyedAt: new Date(now()).toISOString(),
        destroyedBy,
      },
    );
    if (!completed) {
      throw new Error(
        `Runner registry cleanup claim changed before ${runner.sandboxId} was marked destroyed`,
      );
    }
  } catch (error) {
    await retryCleanupClaim(
      env,
      registry,
      runner.sandboxId,
      cleanupToken,
      "failed to release cleanup claim after registry update",
      now(),
    );
    throw new RunnerCleanupPhaseError("registry-update", error);
  }

  // Reaching this point requires settleCleanupClaim("complete") to return true.
  // It moves destroying to destroyed under this token after destroy resolves.
  await releaseDestroyedRunnerReservation(
    env,
    runner.sandboxId,
    destroyedBy,
    services,
  );

  return {
    status: "destroyed",
    runner,
    githubRunner: liveRunner,
    registrationCleanup,
    ...(forcedBusyExit ? { forcedBusyExit: true } : {}),
  };
}

export async function runRunnerRegistryAlarm(
  env,
  registry,
  services = {},
) {
  const now = services.now ?? Date.now;
  const claims = [];
  while (claims.length < MAX_CLEANUP_CONCURRENCY) {
    const claim = await registry.claimNextDueCleanup(now());
    if (claim === null) {
      break;
    }
    claims.push(claim);
  }
  if (claims.length === 0) {
    return { status: "idle" };
  }

  const settlements = await Promise.allSettled(
    claims.map((claim) =>
      executeClaimedRunnerCleanup(env, registry, claim, services)
    ),
  );
  let firstOutcome;
  let firstRejection;
  let hasRejection = false;
  for (const settlement of settlements) {
    if (settlement.status === "rejected") {
      if (!hasRejection) {
        firstRejection = settlement.reason;
        hasRejection = true;
      }
      continue;
    }
    const outcome = settlement.value;
    firstOutcome ??= outcome;
    console.log(
      safeLogRecord({
        message: "runner registry alarm cleanup",
        status: outcome.status,
        runnerName: outcome.runner.runnerName,
        sandboxId: outcome.runner.sandboxId,
        ...(outcome.registrationCleanup ?? {}),
      }, env),
    );
  }
  if (hasRejection) {
    throw firstRejection;
  }
  return firstOutcome;
}

function isExactRepositoryName(repository) {
  const firstSlash = repository.indexOf("/");
  return isRepositoryName(repository) &&
    !repository.includes("*") &&
    !repository.includes("..") &&
    firstSlash !== -1 &&
    firstSlash === repository.lastIndexOf("/");
}

function runnerScopeKey(scope) {
  return scope.type === "organization"
    ? `orgs/${scope.organization}`
    : scope.repository;
}

function runnerScopeLabel(scope) {
  return scope.type === "organization"
    ? scope.organization
    : scope.repository;
}

export function normalizeRepositoryAllowlist(env) {
  const configured = env.GITHUB_REPOSITORY_ALLOWLIST;
  let entries;
  if (configured === undefined || configured === null) {
    entries = [];
  } else if (Array.isArray(configured)) {
    entries = configured;
  } else if (typeof configured === "string") {
    entries = configured.split(/[,\n]/u);
  } else {
    throw new Error(
      "GITHUB_REPOSITORY_ALLOWLIST must be a JSON array or a comma- or newline-separated string",
    );
  }

  const repositories = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "string") {
      throw new Error(
        `GITHUB_REPOSITORY_ALLOWLIST entry ${index + 1} must be a string`,
      );
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
    throw new Error(
      "GITHUB_REPOSITORY_ALLOWLIST must contain at least one repository",
    );
  }

  for (const repository of repositories) {
    if (!isExactRepositoryName(repository)) {
      throw new Error(
        `GITHUB_REPOSITORY_ALLOWLIST entry "${repository}" must be an exact OWNER/REPO without "*" or ".."`,
      );
    }
  }
  return repositories;
}

export function validateEnvironment(env) {
  const repositoryAllowlist = normalizeRepositoryAllowlist(env);
  if (!isRepositoryName(env.GITHUB_REPOSITORY)) {
    throw new Error("GITHUB_REPOSITORY must use the OWNER/REPO format");
  }
  if (!isExactRepositoryName(env.GITHUB_REPOSITORY)) {
    throw new Error(
      "GITHUB_REPOSITORY must be an exact OWNER/REPO without \"*\" or \"..\"",
    );
  }

  resolveRunnerScope(env, env.GITHUB_REPOSITORY);

  if (typeof env.GITHUB_TOKEN !== "string" || env.GITHUB_TOKEN.length === 0) {
    throw new Error("GITHUB_TOKEN must be set");
  }

  if (typeof env.CONTROL_TOKEN !== "string" || env.CONTROL_TOKEN.length < 32) {
    throw new Error("CONTROL_TOKEN must be at least 32 characters");
  }

  if (env.RUNNER_LABELS !== REQUIRED_RUNNER_LABEL) {
    throw new Error(`RUNNER_LABELS must equal ${REQUIRED_RUNNER_LABEL}`);
  }

  return repositoryAllowlist;
}

class InvalidSpawnRequest extends Error {}
class InvalidJitSpawnRequest extends InvalidSpawnRequest {}
class InvalidControlRequest extends Error {}

export class JitStartConflict extends Error {
  constructor(phase, reason) {
    super(`The JIT runner start was refused during ${phase}`);
    this.phase = phase;
    this.reason = reason;
  }
}

export class SpawnReplayUnavailable extends Error {
  constructor(runner) {
    super(
      `Runner correlation ${runner.correlationId} is ${runner.state} and cannot be replayed as live`,
    );
    this.runner = runner;
  }
}

async function runSpawnPhase(phase, task) {
  try {
    return await task();
  } catch (error) {
    if (
      error instanceof JitStartConflict ||
      error instanceof SpawnReplayUnavailable
    ) {
      throw error;
    }
    throw new RunnerSpawnPhaseError(phase, error);
  }
}

function readRunnerCorrelationId(request) {
  const correlationId = request.headers.get("Idempotency-Key");
  if (correlationId === null) {
    return crypto.randomUUID();
  }
  if (correlationId.length === 0) {
    throw new InvalidSpawnRequest("Idempotency-Key must not be empty");
  }
  return correlationId;
}

// The listener's authoritative correlation format has two positive safe
// integers. Its longest value has 58 characters. GitHub delivery GUIDs are
// shorter than this derived bound.
const REFLECTED_CORRELATION_ID_MAX_LENGTH = 58;
const REFLECTED_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function reflectedRunnerCorrelationId(correlationId) {
  return typeof correlationId === "string" &&
      correlationId.length <= REFLECTED_CORRELATION_ID_MAX_LENGTH &&
      REFLECTED_CORRELATION_ID_PATTERN.test(correlationId)
    ? correlationId
    : null;
}

const JIT_START_FIELDS = Object.freeze(new Set([
  "jitConfig",
  "repository",
  "reservation",
  "runnerRequestId",
  "scaleSetId",
  "wave",
]));
const JIT_RESERVATION_FIELDS = Object.freeze(new Set([
  "expiresAtMs",
  "gateGeneration",
  "reservationId",
  "token",
]));

function nonEmptyRequestString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidJitSpawnRequest(`${field} must be a non-empty string`);
  }
  return value;
}

function unknownField(value, fields) {
  return Object.keys(value).find((field) => !fields.has(field));
}

function parseJitStartBody(body, env) {
  if (!isPlainObject(body)) {
    throw new InvalidJitSpawnRequest(
      "The JIT request body must be a JSON object",
    );
  }
  const extraField = unknownField(body, JIT_START_FIELDS);
  if (extraField !== undefined) {
    throw new InvalidJitSpawnRequest(
      `Unknown top-level field: ${extraField}`,
    );
  }

  nonEmptyRequestString(body.jitConfig, "jitConfig");
  if (!isRepositoryName(body.repository)) {
    throw new InvalidJitSpawnRequest(
      "repository must use the OWNER/REPO format",
    );
  }
  const repositoryAllowlist = normalizeRepositoryAllowlist(env);
  if (!repositoryAllowlist.includes(body.repository)) {
    throw new InvalidJitSpawnRequest(
      `repository "${body.repository}" is not in the configured repository allow-list`,
    );
  }
  if (!isPositiveSafeInteger(body.scaleSetId)) {
    throw new InvalidJitSpawnRequest(
      "scaleSetId must be a positive safe integer",
    );
  }
  if (!isPositiveSafeInteger(body.runnerRequestId)) {
    throw new InvalidJitSpawnRequest(
      "runnerRequestId must be a positive safe integer",
    );
  }
  nonEmptyRequestString(body.wave, "wave");
  if (!isPlainObject(body.reservation)) {
    throw new InvalidJitSpawnRequest(
      "reservation must be a JSON object",
    );
  }
  const extraReservationField = unknownField(
    body.reservation,
    JIT_RESERVATION_FIELDS,
  );
  if (extraReservationField !== undefined) {
    throw new InvalidJitSpawnRequest(
      `Unknown reservation field: reservation.${extraReservationField}`,
    );
  }
  nonEmptyRequestString(
    body.reservation.reservationId,
    "reservation.reservationId",
  );
  nonEmptyRequestString(body.reservation.token, "reservation.token");
  if (!isPositiveSafeInteger(body.reservation.expiresAtMs)) {
    throw new InvalidJitSpawnRequest(
      "reservation.expiresAtMs must be a positive safe integer",
    );
  }
  if (
    !Number.isSafeInteger(body.reservation.gateGeneration) ||
    body.reservation.gateGeneration < 0
  ) {
    throw new InvalidJitSpawnRequest(
      "reservation.gateGeneration must be a non-negative safe integer",
    );
  }
  return body;
}

async function readJitStartBody(request, env) {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (request.body === null || contentType !== "application/json") {
    throw new InvalidJitSpawnRequest(
      "POST /runners requires a non-empty application/json JIT request body",
    );
  }
  const text = await request.text();
  if (text.length === 0) {
    throw new InvalidJitSpawnRequest(
      "POST /runners requires a non-empty application/json JIT request body",
    );
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new InvalidJitSpawnRequest(
      "The JIT request body must be valid JSON",
    );
  }
  if (!isPlainObject(body)) {
    throw new InvalidJitSpawnRequest(
      "The JIT request body must be a JSON object",
    );
  }
  if (!Object.keys(body).some((field) => JIT_START_FIELDS.has(field))) {
    throw new InvalidJitSpawnRequest(
      "The JIT request body must contain JIT start fields",
    );
  }
  return parseJitStartBody(body, env);
}

function serviceLogger(services) {
  return services.logger ?? console;
}

function reservationMatchesJitRequest(reservation, requestBody) {
  return reservation.reservationId === requestBody.reservation.reservationId &&
    reservation.scaleSetId === requestBody.scaleSetId &&
    reservation.runnerRequestId === requestBody.runnerRequestId &&
    reservation.repository === requestBody.repository &&
    reservation.wave === requestBody.wave &&
    reservation.expiresAtMs === requestBody.reservation.expiresAtMs &&
    reservation.gateGeneration === requestBody.reservation.gateGeneration;
}

async function scheduleFailedRunnerCleanup(
  registry,
  sandboxId,
  runnerName,
  env,
  logger = console,
) {
  const claim = await registry.beginStartupCleanup(
    sandboxId,
    new Date().toISOString(),
  );
  if (
    !claim.claimed &&
    !["already-scheduled", "contended", "already-destroyed"].includes(
      claim.reason,
    )
  ) {
    throw new Error(
      `Runner startup cleanup was not scheduled: ${claim.reason}`,
    );
  }
  logger.log(
    safeLogRecord({
      message: claim.claimed
        ? "scheduled runner startup cleanup"
        : "runner startup cleanup already has a durable owner",
      reason: claim.reason,
      runnerName,
      sandboxId,
    }, env),
  );
}

async function observeJitRunnerReadiness({
  process,
  registry,
  sandboxId,
  runnerName,
  correlationId,
  env,
  services,
}) {
  const now = services.now ?? Date.now;
  const logger = serviceLogger(services);
  const readinessStartedMs = now();
  try {
    await process.waitForLog(RUNNER_READY, WORKER_WAIT_UNTIL_LIMIT_MS);
  } catch (error) {
    logger.log(
      safeLogRecord({
        message: "JIT runner readiness observation timed out",
        phase: "readinessWait",
        correlationId,
        runnerName,
        sandboxId,
        timeoutMs: WORKER_WAIT_UNTIL_LIMIT_MS,
      }, env),
    );
    try {
      await scheduleFailedRunnerCleanup(
        registry,
        sandboxId,
        runnerName,
        env,
        logger,
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `JIT runner ${sandboxId} readiness failed and its cleanup alarm was not scheduled`,
        { cause: cleanupError },
      );
    }
    return;
  }
  const readinessMs = now() - readinessStartedMs;
  if (readinessMs > WORKER_WAIT_UNTIL_LIMIT_MS) {
    logger.log(
      safeLogRecord({
        message:
          "JIT runner readiness observation exceeded its best-effort budget",
        phase: "readinessWait",
        correlationId,
        runnerName,
        sandboxId,
        timeoutMs: WORKER_WAIT_UNTIL_LIMIT_MS,
      }, env),
    );
  }

  try {
    const registryUpdated = await registry.markOnline(sandboxId);
    if (!registryUpdated) {
      await scheduleFailedRunnerCleanup(
        registry,
        sandboxId,
        runnerName,
        env,
        logger,
      );
      logger.error(
        safeLogRecord({
          message: "JIT runner readiness state changed before markOnline",
          phase: "markOnline",
          correlationId,
          runnerName,
          sandboxId,
        }, env),
      );
      return;
    }
    logger.log(
      safeLogRecord({
        message: "JIT runner became online",
        phase: "markOnline",
        correlationId,
        runnerName,
        sandboxId,
        readinessMs,
      }, env),
    );
  } catch (error) {
    try {
      await scheduleFailedRunnerCleanup(
        registry,
        sandboxId,
        runnerName,
        env,
        logger,
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `JIT runner ${sandboxId} online update failed and its cleanup alarm was not scheduled`,
        { cause: cleanupError },
      );
    }
    logger.error(
      safeLogRecord({
        message: "JIT runner readiness update failed",
        phase: "markOnline",
        correlationId,
        runnerName,
        sandboxId,
      }, env),
    );
  }
}

export async function startJitRunner(
  ctx,
  env,
  origin,
  requestReceivedAt,
  requestReceivedMs,
  correlationId,
  requestBody,
  services = {},
) {
  validateEnvironment(env);

  const randomUUID = services.randomUUID ?? (() => crypto.randomUUID());
  const now = services.now ?? Date.now;
  const getRunnerSandbox = services.getSandbox ?? getSandbox;
  const startBudgetTimer = services.startBudgetTimer ?? defaultStartBudgetTimer;
  const cleanupTokenForSandbox =
    services.createCleanupToken ?? createCleanupToken;
  const control = services.control ?? getAutopilotControl(env);
  const registry = services.registry ?? getRunnerRegistry(env);
  const logger = serviceLogger(services);
  const id = randomUUID();
  const runnerName = `cloudflare-${id}`;
  const sandboxId = `runner-${id}`;
  // GitHub issues this name. The scale-set listener generates the JIT config with
  // exactly this name and refuses the dispatch ("jit-runner-name-mismatch") unless
  // GitHub echoes it back, so it is confirmed upstream before this request exists.
  // Deriving a GitHub identity from the sandbox UUID produced a name GitHub never held.
  const githubRunnerName =
    `cloudflare-${requestBody.scaleSetId}-${requestBody.runnerRequestId}`;

  await runSpawnPhase("markStartCreated", async () => {
    const startCreated = await control.markStartCreated({
      reservationId: requestBody.reservation.reservationId,
      correlationId,
      sandboxId,
    });
    if (!startCreated.started) {
      throw new JitStartConflict(
        "markStartCreated",
        startCreated.reason ?? "reservation-refused",
      );
    }
    if (
      !isPlainObject(startCreated.reservation) ||
      !reservationMatchesJitRequest(startCreated.reservation, requestBody)
    ) {
      try {
        await control.compensate({
          reservationId: requestBody.reservation.reservationId,
          reason: "start-request-mismatch",
        });
      } catch (compensationError) {
        logSuppressedSecondaryFailure(logger, env, () => ({
          message: "JIT start reservation compensation failed",
          error: loggedError(compensationError),
          phase: "markStartCreated",
          correlationId,
          reservationId: requestBody.reservation.reservationId,
        }));
      }
      throw new JitStartConflict(
        "markStartCreated",
        "reservation-mismatch",
      );
    }
  });

  const startingRecord = await runSpawnPhase(
    "recordStarting",
    () => registry.recordStarting({
      sandboxId,
      runnerName,
      githubRunnerName,
      correlationId,
      repository: requestBody.repository,
      createdAt: requestReceivedAt,
      createdAtMs: requestReceivedMs,
    }),
  );
  if (!startingRecord.created) {
    if (!["starting", "online"].includes(startingRecord.runner.state)) {
      throw new SpawnReplayUnavailable(startingRecord.runner);
    }
    const replayedRunner = {
      correlationId: startingRecord.runner.correlationId,
      runnerName: startingRecord.runner.runnerName,
      sandboxId: startingRecord.runner.sandboxId,
      state: startingRecord.runner.state,
      replayed: true,
    };
    logger.log(
      safeLogRecord({
        message: "replayed idempotent JIT runner spawn",
        ...replayedRunner,
      }, env),
    );
    return { created: false, runner: replayedRunner };
  }

  const sandbox = await runSpawnPhase(
    "getSandbox",
    () => getRunnerSandbox(env.Sandbox, sandboxId, {
      enableDefaultSession: false,
      keepAlive: true,
      normalizeId: true,
      transport: "rpc",
      labels: {
        repository: requestBody.repository,
        workload: "github-actions-runner",
      },
    }),
  );
  const cleanupToken = await runSpawnPhase(
    "createCleanupToken",
    () => cleanupTokenForSandbox(
      sandboxId,
      env.CONTROL_TOKEN,
    ),
  );
  await runSpawnPhase("consume", async () => {
    const consumed = await control.consume({
      reservationId: requestBody.reservation.reservationId,
      token: requestBody.reservation.token,
      nowMs: now(),
    });
    if (!consumed.consumed) {
      try {
        await scheduleFailedRunnerCleanup(
          registry,
          sandboxId,
          runnerName,
          env,
          logger,
        );
      } catch (cleanupError) {
        logSuppressedSecondaryFailure(logger, env, () => ({
          message: "JIT start cleanup scheduling failed",
          error: loggedError(cleanupError),
          phase: "consume",
          correlationId,
          runnerName,
          sandboxId,
        }));
      }
      throw new JitStartConflict(
        "consume",
        consumed.reason ?? "reservation-refused",
      );
    }
  });

  const { process, sandboxStartProcessMs } = await runSpawnPhase(
    "startProcess",
    async () => {
      const sandboxStartProcessStartedMs = now();
      let process;
      const timer = startBudgetTimer(CONTAINER_START_BUDGET_MS);
      const budgetExpired = Symbol("container start budget expired");
      try {
        const startProcessPromise = Promise.resolve().then(() =>
          sandbox.startProcess(
            "/usr/local/bin/run-actions-runner",
            {
              processId: "actions-runner",
              autoCleanup: false,
              env: {
                ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT: "1",
                DOCKER_HOST: "unix:///run/user/1001/docker.sock",
                HOME: "/home/runner",
                LOGNAME: "runner",
                RUNNER_CLEANUP_TOKEN: cleanupToken,
                RUNNER_CLEANUP_URL: `${origin}/runners/${sandboxId}`,
                // RUNNER_JITCONFIG is the contract that the container must consume.
                RUNNER_JITCONFIG: requestBody.jitConfig,
                RUNNER_LABELS: REQUIRED_RUNNER_LABEL,
                RUNNER_NAME: runnerName,
                RUNNER_URL: `https://github.com/${requestBody.repository}`,
                USER: "runner",
                XDG_RUNTIME_DIR: "/run/user/1001",
              },
            },
          )
        );
        startProcessPromise.catch(() => {});
        const winner = await Promise.race([
          startProcessPromise,
          timer.expired.then(() => budgetExpired),
        ]);
        if (winner === budgetExpired) {
          throw new ContainerStartBudgetExceeded(CONTAINER_START_BUDGET_MS);
        }
        process = winner;
      } catch (error) {
        try {
          await scheduleFailedRunnerCleanup(
            registry,
            sandboxId,
            runnerName,
            env,
            logger,
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `JIT runner ${sandboxId} failed and its immediate cleanup alarm was not scheduled`,
            { cause: cleanupError },
          );
        }
        throw error;
      } finally {
        timer.cancel();
      }
      return {
        process,
        sandboxStartProcessMs: now() - sandboxStartProcessStartedMs,
      };
    },
  );

  const scheduleWaitUntil = services.scheduleWaitUntil ??
    ((context, task) => context.waitUntil(task()));
  scheduleWaitUntil(
    ctx,
    () => observeJitRunnerReadiness({
      process,
      registry,
      sandboxId,
      runnerName,
      correlationId,
      env,
      services,
    }),
  );
  const result = {
    correlationId,
    runnerName,
    sandboxId,
    state: "starting",
    replayed: false,
    timings: {
      requestReceivedAt,
      sandboxStartProcessMs,
      totalMs: now() - requestReceivedMs,
    },
  };
  logger.log(
    safeLogRecord({
      message: "started JIT runner process",
      ...result,
    }, env),
  );
  return { created: true, runner: result };
}

export async function destroyCompletedRunner(
  request,
  env,
  ctx,
  sandboxId,
  services = {},
) {
  const authenticated = services.authenticateCleanup === undefined
    ? typeof env.CONTROL_TOKEN === "string" &&
      env.CONTROL_TOKEN.length >= 32 &&
      await authenticate(
        request,
        await createCleanupToken(sandboxId, env.CONTROL_TOKEN),
      )
    : await services.authenticateCleanup(request, env, sandboxId);
  if (!authenticated) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const registry = services.registry ?? getRunnerRegistry(env);
  const now = services.now ?? Date.now;
  let claim;
  let cleanupRearmed = false;
  try {
    const cleanupStartedAt = new Date(now()).toISOString();
    claim = await registry.beginCallbackCleanup(
      sandboxId,
      cleanupStartedAt,
    );
    if (!claim.claimed && claim.reason === "already-scheduled") {
      const rearm = await registry.rearmStalledCleanup(
        sandboxId,
        cleanupStartedAt,
      );
      cleanupRearmed = rearm.rearmed;
    }
  } catch (error) {
    console.error(
      safeLogRecord({
        message: "failed to schedule completed runner cleanup",
        error: error instanceof Error ? error.message : String(error),
        sandboxId,
      }, env),
    );
    return Response.json(
      { error: "Failed to schedule completed runner cleanup" },
      { status: 502 },
    );
  }

  if (claim.claimed || claim.reason === "already-scheduled") {
    const cleanupStatus = cleanupRearmed ? "rearmed" : claim.reason;
    console.log(
      safeLogRecord({
        message: cleanupRearmed
          ? "re-armed a stalled runner cleanup"
          : claim.claimed
            ? "scheduled completed runner cleanup"
            : "completed runner cleanup was already scheduled",
        cleanupStatus,
        sandboxId,
        ...(claim.reason === "already-scheduled"
          ? { cleanupAttempts: claim.cleanupAttempts }
          : {}),
      }, env),
    );
    return Response.json(
      {
        cleanupStatus,
        sandboxId,
        ...(claim.reason === "already-scheduled"
          ? { cleanupAttempts: claim.cleanupAttempts }
          : {}),
      },
      { status: 202 },
    );
  }

  if (claim.reason === "already-destroyed") {
    console.log(
      safeLogRecord({
        message: "completed runner cleanup was already terminal",
        sandboxId,
      }, env),
    );
    return new Response(null, { status: 204 });
  }

  if (claim.reason === "not-found") {
    return Response.json(
      { error: "Runner registry row not found" },
      { status: 404 },
    );
  }

  return Response.json(
    {
      error: "Runner cleanup could not be scheduled",
      cleanupStatus: claim.reason,
      sandboxId,
    },
    { status: 409 },
  );
}

class InvalidOrphanDestroyRequest extends Error {}

function readObservedRegistration(body) {
  const observation = body.observedRegistration;
  if (
    typeof observation !== "object" ||
    observation === null ||
    Array.isArray(observation) ||
    typeof observation.runnerName !== "string"
  ) {
    throw new InvalidOrphanDestroyRequest(
      "observedRegistration must include a runnerName",
    );
  }
  if (observation.outcome === "registration-not-found") {
    return {
      outcome: observation.outcome,
      runnerName: observation.runnerName,
    };
  }
  if (
    observation.outcome !== "registration-found" ||
    !Number.isSafeInteger(observation.runnerId) ||
    observation.runnerId < 0 ||
    (observation.status !== "online" && observation.status !== "offline") ||
    typeof observation.busy !== "boolean"
  ) {
    throw new InvalidOrphanDestroyRequest(
      "observedRegistration must describe a found or missing GitHub runner",
    );
  }
  return {
    outcome: observation.outcome,
    runnerId: observation.runnerId,
    runnerName: observation.runnerName,
    status: observation.status,
    busy: observation.busy,
  };
}

async function readOrphanDestroyObservation(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new InvalidOrphanDestroyRequest(
      "The request body must be a JSON object",
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidOrphanDestroyRequest(
      "The request body must be a JSON object",
    );
  }
  const allowedFields = new Set([
    "observedRegistryCondition",
    "expectedRevision",
    "observedSandboxInstanceId",
    "observedRegistration",
  ]);
  const unknownField = Object.keys(body).find(
    (field) => !allowedFields.has(field),
  );
  if (unknownField !== undefined) {
    throw new InvalidOrphanDestroyRequest(
      `Unknown request field: ${unknownField}`,
    );
  }
  if (
    body.observedRegistryCondition !== "absent" &&
    body.observedRegistryCondition !== "terminal"
  ) {
    throw new InvalidOrphanDestroyRequest(
      "observedRegistryCondition must be absent or terminal",
    );
  }
  if (!Object.hasOwn(body, "expectedRevision")) {
    throw new InvalidOrphanDestroyRequest(
      "expectedRevision is required",
    );
  }
  if (
    body.observedRegistryCondition === "absent" &&
    body.expectedRevision !== null
  ) {
    throw new InvalidOrphanDestroyRequest(
      "expectedRevision must be null for an absent registry observation",
    );
  }
  if (
    body.observedRegistryCondition === "terminal" &&
    (!Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0)
  ) {
    throw new InvalidOrphanDestroyRequest(
      "expectedRevision must be a non-negative safe integer for a terminal registry observation",
    );
  }
  if (
    typeof body.observedSandboxInstanceId !== "string" ||
    !SANDBOX_INSTANCE_ID_PATTERN.test(body.observedSandboxInstanceId)
  ) {
    throw new InvalidOrphanDestroyRequest(
      "observedSandboxInstanceId must be a string of exactly 64 lowercase hexadecimal characters",
    );
  }

  return {
    observedRegistryCondition: body.observedRegistryCondition,
    expectedRevision: body.expectedRevision,
    observedSandboxInstanceId: body.observedSandboxInstanceId,
    observedRegistration: readObservedRegistration(body),
  };
}

function runnerNameForSandbox(sandboxId) {
  return `cloudflare-${sandboxId.slice("runner-".length)}`;
}

function registrationObservationsMatch(observed, live) {
  if (
    observed.outcome !== live.outcome ||
    observed.runnerName !== live.runnerName
  ) {
    return false;
  }
  return observed.outcome === "registration-not-found" || (
    observed.runnerId === live.runnerId &&
    observed.status === live.status &&
    observed.busy === live.busy
  );
}

const ORPHAN_CLAIM_REFUSAL_TABLE = Object.freeze({
  "live-row": Object.freeze({
    status: 409,
    outcome: "live-row",
    error: "A live registry row must use the callback or reconcile path",
    details: (claim, observation) => ({
      observedRegistryCondition: observation.observedRegistryCondition,
      actualRegistryCondition: claim.actualCondition,
      state: claim.runner.state,
      revision: claim.runner.revision,
      correctPaths: ["DELETE /runners/:sandboxId", "POST /reconcile"],
    }),
  }),
  "observation-mismatch": Object.freeze({
    status: 409,
    outcome: "observation-mismatch",
    error: "The observed registry condition no longer matches",
    details: (claim, observation) => ({
      observedRegistryCondition: observation.observedRegistryCondition,
      actualRegistryCondition: claim.actualCondition,
    }),
  }),
  "revision-conflict": Object.freeze({
    status: 409,
    outcome: "revision-conflict",
    error: "The observed registry revision no longer matches",
    details: (claim) => ({
      expectedRevision: claim.expectedRevision,
      actualRevision: claim.actualRevision,
    }),
  }),
  "inside-grace": Object.freeze({
    status: 409,
    outcome: "inside-grace",
    error: "The sandbox is inside the orphan destruction grace period",
    details: (claim) => ({
      registryCondition: claim.actualCondition,
      sandboxAgeMs: claim.sandboxAgeMs,
      graceMs: ORPHAN_DESTROY_GRACE_MS,
      ageSource: "worker-first-observed-at",
    }),
  }),
  "sandbox-generation-mismatch": Object.freeze({
    status: 409,
    outcome: "sandbox-generation-mismatch",
    error: "The observed sandbox instance does not match the claimed generation",
    details: (claim) => ({
      observedSandboxInstanceId: claim.observedSandboxInstanceId,
      recordedSandboxInstanceId: claim.recordedSandboxInstanceId,
    }),
  }),
  "terminal-generation-unverified": Object.freeze({
    status: 409,
    outcome: "terminal-generation-unverified",
    error: "The terminal row does not identify a destroyed sandbox generation",
    details: () => ({}),
  }),
});

function orphanClaimRefusalResponse(claim, observation) {
  const refusal = ORPHAN_CLAIM_REFUSAL_TABLE[claim.reason];
  if (refusal === undefined) {
    return Response.json(
      {
        outcome: "claim-conflict",
        error: `Orphan cleanup claim failed: ${claim.reason}`,
      },
      { status: 409 },
    );
  }
  return Response.json(
    {
      outcome: refusal.outcome,
      ...refusal.details(claim, observation),
      error: refusal.error,
    },
    { status: refusal.status },
  );
}

async function abandonOrphanCleanupClaim(
  registry,
  sandboxId,
  cleanupToken,
  originalCondition,
  originalTerminal = null,
) {
  const settlementErrors = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (
        await registry.settleCleanupClaim(
          sandboxId,
          cleanupToken,
          "abandon",
          { originalCondition, originalTerminal },
        )
      ) {
        return { residualDestroyClaim: false };
      }
    } catch (error) {
      settlementErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  try {
    const settled = await registry.settleUnownedOrphanCleanupClaim(
      sandboxId,
      originalCondition,
      originalTerminal,
    );
    if (settled) {
      return { residualDestroyClaim: false };
    }
  } catch (error) {
    settlementErrors.push(
      error instanceof Error ? error.message : String(error),
    );
  }

  let residualDestroyClaim = true;
  try {
    const revalidation = await registry.revalidateOrphanCleanupClaim(sandboxId);
    residualDestroyClaim =
      revalidation === true || revalidation?.valid === true;
  } catch (error) {
    settlementErrors.push(
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    residualDestroyClaim,
    ...(settlementErrors.length === 0
      ? {}
      : { claimReleaseError: settlementErrors.at(-1) }),
  };
}

function orphanCleanupFailureResponse(error, sandboxId) {
  if (!(error instanceof RunnerCleanupPhaseError)) {
    return {
      status: 502,
      body: {
        outcome: "failed",
        phase: "cleanup-task",
        error: "Runner cleanup failed",
      },
    };
  }
  if (
    error.phase === "sandbox-destroy" &&
    error.cause instanceof CleanupClaimLeaseExpired
  ) {
    if (!error.destroyStarted) {
      return {
        status: 409,
        body: {
          outcome: "claim-expired",
          phase: error.phase,
          error: "The runner cleanup claim expired",
        },
      };
    }
    return {
      status: 504,
      body: {
        outcome: "destroy-timeout",
        sandboxId,
        error: "Runner cleanup exceeded the destroy timeout",
      },
    };
  }
  if (
    error.phase === "sandbox-destroy" &&
    error.cause instanceof SandboxDestroyTimeout
  ) {
    return {
      status: 504,
      body: {
        outcome: "destroy-timeout",
        sandboxId,
        error: "Runner cleanup exceeded the destroy timeout",
      },
    };
  }
  return {
    status: 502,
    body: {
      outcome: "failed",
      phase: error.phase,
      error: "Runner cleanup failed",
    },
  };
}

export async function destroyOrphanedRunner(
  request,
  env,
  ctx,
  sandboxId,
  services = {},
) {
  if (!(await authenticate(request, env.CONTROL_TOKEN))) {
    return Response.json(
      { outcome: "unauthorized", error: "Unauthorized" },
      { status: 401 },
    );
  }
  if (!RUNNER_ID_PATTERN.test(sandboxId)) {
    return Response.json(
      {
        outcome: "invalid-request",
        error: "The sandbox identifier is invalid",
      },
      { status: 400 },
    );
  }

  const now = services.now ?? Date.now;
  let observation;
  let claimStartedAtMs;
  try {
    validateEnvironment(env);
    observation = await readOrphanDestroyObservation(request);
    claimStartedAtMs = now();
    const expectedRunnerName = runnerNameForSandbox(sandboxId);
    if (
      observation.observedRegistryCondition === "absent" &&
      observation.observedRegistration.runnerName !== expectedRunnerName
    ) {
      throw new InvalidOrphanDestroyRequest(
        "observedRegistration.runnerName does not match the sandbox identifier",
      );
    }
  } catch (error) {
    if (error instanceof InvalidOrphanDestroyRequest) {
      return Response.json(
        { outcome: "invalid-request", error: error.message },
        { status: 400 },
      );
    }
    throw error;
  }

  const registry = services.registry ?? getRunnerRegistry(env);
  const randomUUID = services.randomUUID ?? (() => crypto.randomUUID());
  const cleanupToken = randomUUID();
  let claim;
  try {
    claim = await registry.claimOrphanCleanup(
      sandboxId,
      observation.observedRegistryCondition,
      observation.expectedRevision,
      observation.observedSandboxInstanceId,
      cleanupToken,
      new Date(claimStartedAtMs).toISOString(),
    );
  } catch (error) {
    const claimState = await abandonOrphanCleanupClaim(
      registry,
      sandboxId,
      cleanupToken,
      observation.observedRegistryCondition,
    );
    console.error(
      safeLogRecord({
        message: "failed to claim orphan cleanup",
        error: error instanceof Error ? error.message : String(error),
        sandboxId,
      }, env, [cleanupToken]),
    );
    return Response.json(
      {
        outcome: "failed",
        phase: "registry-claim",
        error: "Failed to claim orphan cleanup",
        ...claimState,
      },
      { status: 502 },
    );
  }

  if (!claim.claimed) {
    return orphanClaimRefusalResponse(claim, observation);
  }

  const claimedGithubRunnerName =
    claim.runner.githubRunnerName ?? claim.runner.runnerName;
  if (
    observation.observedRegistration.runnerName !== claimedGithubRunnerName
  ) {
    const claimState = await abandonOrphanCleanupClaim(
      registry,
      sandboxId,
      cleanupToken,
      claim.actualCondition,
      claim.originalTerminal,
    );
    return Response.json(
      {
        outcome: "invalid-request",
        error: "observedRegistration.runnerName does not match the registry runner",
        ...claimState,
      },
      { status: 400 },
    );
  }

  const abandonAndRespond = async (body, status) => {
    const claimState = await abandonOrphanCleanupClaim(
      registry,
      sandboxId,
      cleanupToken,
      claim.actualCondition,
      claim.originalTerminal,
    );
    return Response.json({ ...body, ...claimState }, { status });
  };
  const registrationRefusal = (liveRegistration) => {
    if (liveRegistration.outcome === "registration-name-unknown") {
      return null;
    }
    if (
      liveRegistration.outcome === "registration-found" &&
      liveRegistration.busy
    ) {
      return {
        outcome: "runner-busy",
        runnerName: claim.runner.runnerName,
        githubRunnerId: liveRegistration.runnerId,
        error: "The matching GitHub runner is busy",
      };
    }
    if (
      claim.actualCondition !== "terminal" &&
      liveRegistration.outcome === "registration-found" &&
      liveRegistration.status === "online"
    ) {
      return {
        outcome: "runner-online",
        runnerName: claim.runner.runnerName,
        githubRunnerId: liveRegistration.runnerId,
        error: "An online GitHub runner requires a terminal registry row",
      };
    }
    if (
      !registrationObservationsMatch(
        observation.observedRegistration,
        liveRegistration,
      )
    ) {
      return {
        outcome: "registration-observation-mismatch",
        observedRegistration: observation.observedRegistration,
        liveRegistration,
        error: "The observed GitHub registration state no longer matches",
      };
    }
    return null;
  };

  let outcome;
  try {
    outcome = await executeClaimedOrphanCleanup(
      env,
      registry,
      {
        ...claim,
        cleanupToken,
        observedSandboxInstanceId: observation.observedSandboxInstanceId,
      },
      registrationRefusal,
      services,
    );
  } catch (error) {
    const failure = orphanCleanupFailureResponse(error, sandboxId);
    serviceLogger(services).error(safeLogRecord({
      message: "orphan runner cleanup failed",
      error: loggedError(error),
      phase: error instanceof RunnerCleanupPhaseError
        ? error.phase
        : "cleanup-task",
      sandboxId,
    }, env, [cleanupToken]));
    if (
      error instanceof RunnerCleanupPhaseError &&
      error.claimSettlement === "retry"
    ) {
      await retryCleanupClaim(
        env,
        registry,
        sandboxId,
        cleanupToken,
        "failed to release orphan claim after sandbox destruction",
        now(),
      );
      return Response.json(failure.body, { status: failure.status });
    }
    return abandonAndRespond(failure.body, failure.status);
  }

  if (outcome.status === "refused") {
    return abandonAndRespond(
      outcome.refusal.body,
      outcome.refusal.status,
    );
  }

  return Response.json({
    outcome: "destroyed",
    sandboxId,
    runnerName: claim.runner.runnerName,
    observedRegistryCondition: observation.observedRegistryCondition,
    registrationLookupOutcome: outcome.liveRegistration.outcome,
    registrationCleanup: outcome.registrationCleanup,
  });
}

class InvalidOrphanReclaimRequest extends Error {}

async function readOrphanReclaimObservation(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new InvalidOrphanReclaimRequest(
      "The request body must be a JSON object",
    );
  }
  if (!isPlainObject(body)) {
    throw new InvalidOrphanReclaimRequest(
      "The request body must be a JSON object",
    );
  }

  const allowedFields = new Set([
    "observedRegistryCondition",
    "expectedRevision",
    "cloudflareAbsence",
    "observedRegistration",
  ]);
  const unexpectedField = unknownField(body, allowedFields);
  if (unexpectedField !== undefined) {
    throw new InvalidOrphanReclaimRequest(
      `Unknown request field: ${unexpectedField}`,
    );
  }
  if (body.observedRegistryCondition !== "live") {
    throw new InvalidOrphanReclaimRequest(
      "observedRegistryCondition must be live",
    );
  }
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 0
  ) {
    throw new InvalidOrphanReclaimRequest(
      "expectedRevision must be a non-negative safe integer",
    );
  }

  const cloudflareAbsence = body.cloudflareAbsence;
  if (!isPlainObject(cloudflareAbsence)) {
    throw new InvalidOrphanReclaimRequest(
      "cloudflareAbsence must be an object",
    );
  }
  const allowedAbsenceFields = new Set([
    "enumerationOutcome",
    "instanceCount",
    "liveInstanceCount",
    "pageCount",
    "applicationId",
  ]);
  const unexpectedAbsenceField = unknownField(
    cloudflareAbsence,
    allowedAbsenceFields,
  );
  if (unexpectedAbsenceField !== undefined) {
    throw new InvalidOrphanReclaimRequest(
      `Unknown cloudflareAbsence field: ${unexpectedAbsenceField}`,
    );
  }
  if (
    !COMPLETE_INSTANCE_ENUMERATION_OUTCOMES.has(
      cloudflareAbsence.enumerationOutcome,
    )
  ) {
    throw new InvalidOrphanReclaimRequest(
      "cloudflareAbsence.enumerationOutcome must attest a complete enumeration",
    );
  }
  for (const field of ["instanceCount", "liveInstanceCount"]) {
    if (
      !Number.isSafeInteger(cloudflareAbsence[field]) ||
      cloudflareAbsence[field] < 0
    ) {
      throw new InvalidOrphanReclaimRequest(
        `cloudflareAbsence.${field} must be a non-negative safe integer`,
      );
    }
  }
  if (
    !Number.isSafeInteger(cloudflareAbsence.pageCount) ||
    cloudflareAbsence.pageCount <= 0
  ) {
    throw new InvalidOrphanReclaimRequest(
      "cloudflareAbsence.pageCount must be a positive safe integer",
    );
  }
  if (
    typeof cloudflareAbsence.applicationId !== "string" ||
    !APPLICATION_ID_PATTERN.test(cloudflareAbsence.applicationId)
  ) {
    throw new InvalidOrphanReclaimRequest(
      "cloudflareAbsence.applicationId must be a UUID",
    );
  }

  const observedRegistration = body.observedRegistration;
  if (!isPlainObject(observedRegistration)) {
    throw new InvalidOrphanReclaimRequest(
      "observedRegistration must be an object",
    );
  }
  const unexpectedRegistrationField = unknownField(
    observedRegistration,
    new Set(["outcome", "runnerName"]),
  );
  if (unexpectedRegistrationField !== undefined) {
    throw new InvalidOrphanReclaimRequest(
      `Unknown observedRegistration field: ${unexpectedRegistrationField}`,
    );
  }
  if (observedRegistration.outcome !== "registration-not-found") {
    throw new InvalidOrphanReclaimRequest(
      "observedRegistration.outcome must be registration-not-found",
    );
  }
  if (typeof observedRegistration.runnerName !== "string") {
    throw new InvalidOrphanReclaimRequest(
      "observedRegistration.runnerName must be a string",
    );
  }

  return {
    observedRegistryCondition: body.observedRegistryCondition,
    expectedRevision: body.expectedRevision,
    cloudflareAbsence: {
      enumerationOutcome: cloudflareAbsence.enumerationOutcome,
      instanceCount: cloudflareAbsence.instanceCount,
      liveInstanceCount: cloudflareAbsence.liveInstanceCount,
      pageCount: cloudflareAbsence.pageCount,
      applicationId: cloudflareAbsence.applicationId,
    },
    observedRegistration: {
      outcome: observedRegistration.outcome,
      runnerName: observedRegistration.runnerName,
    },
  };
}

function orphanReclaimObservationResponse(observation, sandboxId) {
  if (observation.reason === "runner-name-mismatch") {
    return Response.json(
      {
        outcome: "invalid-request",
        error: "observedRegistration.runnerName does not match the registry runner",
        sandboxId,
        runnerName: observation.runnerName,
      },
      { status: 400 },
    );
  }
  if (observation.reason === "absence-recorded") {
    return Response.json(
      {
        outcome: "absence-recorded",
        sandboxId,
        revision: observation.revision,
        reclaimableAtMs: observation.reclaimableAtMs,
      },
      { status: 202 },
    );
  }
  if (observation.reason === "absence-pending") {
    return Response.json(
      {
        outcome: "absence-pending",
        sandboxId,
        revision: observation.revision,
        reclaimableAtMs: observation.reclaimableAtMs,
      },
      { status: 409 },
    );
  }
  if (observation.reason === "within-grace") {
    return Response.json(
      {
        outcome: "within-grace",
        sandboxId,
        rowAgeMs: observation.rowAgeMs,
        graceMs: ORPHAN_DESTROY_GRACE_MS,
      },
      { status: 409 },
    );
  }
  return Response.json(
    {
      outcome: observation.reason,
      sandboxId,
      ...(observation.reason === "revision-conflict"
        ? {
            expectedRevision: observation.expectedRevision,
            actualRevision: observation.actualRevision,
          }
        : {}),
    },
    { status: 409 },
  );
}

export async function reclaimAbsentRunner(
  request,
  env,
  sandboxId,
  services = {},
) {
  if (!(await authenticate(request, env.CONTROL_TOKEN))) {
    return Response.json(
      { outcome: "unauthorized", error: "Unauthorized" },
      { status: 401 },
    );
  }
  if (!RUNNER_ID_PATTERN.test(sandboxId)) {
    return Response.json(
      {
        outcome: "invalid-request",
        error: "The sandbox identifier is invalid",
      },
      { status: 400 },
    );
  }

  let attestation;
  try {
    validateEnvironment(env);
    attestation = await readOrphanReclaimObservation(request);
  } catch (error) {
    if (error instanceof InvalidOrphanReclaimRequest) {
      return Response.json(
        { outcome: "invalid-request", error: error.message },
        { status: 400 },
      );
    }
    throw error;
  }

  const registry = services.registry ?? getRunnerRegistry(env);
  const now = services.now ?? Date.now;
  const observedAtMs = now();
  let observation;
  try {
    observation = await registry.observeOrphanReclaim(
      sandboxId,
      attestation.expectedRevision,
      attestation.observedRegistration.runnerName,
      new Date(observedAtMs).toISOString(),
    );
  } catch (error) {
    serviceLogger(services).error(safeLogRecord({
      message: "failed to record orphan reclaim observation",
      error: loggedError(error),
      sandboxId,
    }, env));
    return Response.json(
      {
        outcome: "failed",
        phase: "registry-observation",
        error: "Failed to record the orphan reclaim observation",
      },
      { status: 502 },
    );
  }
  if (!observation.ready) {
    return orphanReclaimObservationResponse(observation, sandboxId);
  }

  const randomUUID = services.randomUUID ?? (() => crypto.randomUUID());
  const cleanupToken = randomUUID();
  let claim;
  try {
    claim = await registry.claimForReconcile(
      sandboxId,
      attestation.expectedRevision,
      cleanupToken,
      new Date(now()).toISOString(),
    );
  } catch (error) {
    serviceLogger(services).error(safeLogRecord({
      message: "failed to claim orphan reclaim cleanup",
      error: loggedError(error),
      sandboxId,
    }, env, [cleanupToken]));
    return Response.json(
      {
        outcome: "failed",
        phase: "registry-claim",
        error: "Failed to claim orphan reclaim cleanup",
      },
      { status: 502 },
    );
  }
  if (!claim.claimed) {
    return Response.json(
      {
        outcome: claim.reason,
        sandboxId,
        ...(claim.reason === "revision-conflict"
          ? {
              expectedRevision: claim.expectedRevision,
              actualRevision: claim.actualRevision,
            }
          : {}),
      },
      { status: 409 },
    );
  }

  let outcome;
  try {
    outcome = await executeClaimedRunnerCleanup(
      env,
      registry,
      {
        cleanupToken,
        destroyedBy: "reconcile",
        retainOnlineRunner: true,
        runner: observation.runner,
      },
      services,
    );
  } catch (error) {
    const failure = orphanCleanupFailureResponse(error, sandboxId);
    serviceLogger(services).error(safeLogRecord({
      message: "orphan reclaim cleanup failed",
      error: loggedError(error),
      phase: error instanceof RunnerCleanupPhaseError
        ? error.phase
        : "cleanup-task",
      sandboxId,
    }, env, [cleanupToken]));
    return Response.json(failure.body, { status: failure.status });
  }

  if (outcome.status === "retained-busy") {
    return Response.json(
      {
        outcome: "runner-busy",
        sandboxId,
        runnerName: outcome.runner.runnerName,
        githubRunnerId: outcome.githubRunner.runnerId,
      },
      { status: 409 },
    );
  }
  if (outcome.status === "retained-online") {
    return Response.json(
      {
        outcome: "runner-online",
        sandboxId,
        runnerName: outcome.runner.runnerName,
        githubRunnerId: outcome.githubRunner.runnerId,
      },
      { status: 409 },
    );
  }

  return Response.json({
    outcome: "reclaimed",
    sandboxId,
    runnerName: outcome.runner.runnerName,
    registrationLookupOutcome: outcome.githubRunner === undefined
      ? "registration-not-found"
      : "registration-found",
    registrationCleanup: outcome.registrationCleanup,
  });
}

class InvalidReconcileRequest extends Error {}

async function readMaxAgeSeconds(request) {
  const text = await request.text();
  if (text.trim() === "") {
    return DEFAULT_RECONCILE_MAX_AGE_SECONDS;
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new InvalidReconcileRequest("The request body must be valid JSON");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidReconcileRequest("The request body must be a JSON object");
  }
  if (!("maxAgeSeconds" in body)) {
    return DEFAULT_RECONCILE_MAX_AGE_SECONDS;
  }
  if (
    !Number.isSafeInteger(body.maxAgeSeconds) ||
    body.maxAgeSeconds < 0
  ) {
    throw new InvalidReconcileRequest(
      "maxAgeSeconds must be a non-negative safe integer",
    );
  }

  return body.maxAgeSeconds;
}

function reconciliationSandbox(env, sandboxId) {
  return getSandbox(env.Sandbox, sandboxId, {
    enableDefaultSession: false,
    normalizeId: true,
    transport: "rpc",
  });
}

function reconciliationError(row, phase, error) {
  return {
    sandboxId: row.sandboxId,
    runnerName: row.runnerName,
    phase,
    error: error instanceof Error ? error.message : String(error),
  };
}

export async function reconcileRunners(
  request,
  env,
  ctx,
  services = {},
) {
  validateEnvironment(env);
  const maxAgeSeconds = await readMaxAgeSeconds(request);
  const now = services.now ?? Date.now;
  const requestNowMs = now();
  const cutoffMs = requestNowMs - maxAgeSeconds * 1000;
  if (
    !Number.isSafeInteger(cutoffMs) ||
    cutoffMs < -ECMASCRIPT_DATE_LIMIT_MS
  ) {
    throw new InvalidReconcileRequest(
      "maxAgeSeconds exceeds the ECMAScript Date range",
    );
  }
  const registry = services.registry ?? getRunnerRegistry(env);
  const listRunners =
    services.listRepositoryRunners ?? listRepositoryRunners;
  const randomUUID = services.randomUUID ?? (() => crypto.randomUUID());
  const candidatePage = await registry.listActiveBefore(cutoffMs);
  let subrequestsSpent = RECONCILE_REGISTRY_READ_SUBREQUESTS;
  const candidates = Array.isArray(candidatePage)
    ? candidatePage
    : candidatePage.runners;
  const hasMoreCandidates = Array.isArray(candidatePage)
    ? false
    : candidatePage.hasMore;
  const allCandidateScopes = [];
  const candidateScopeKeys = new Set();
  for (const runner of candidates) {
    const repository = runner.repository ?? env.GITHUB_REPOSITORY;
    const scope = resolveRunnerScope(env, repository);
    const key = runnerScopeKey(scope);
    if (!candidateScopeKeys.has(key)) {
      candidateScopeKeys.add(key);
      allCandidateScopes.push({
        key,
        scope,
        repository: runnerScopeLabel(scope),
      });
    }
  }
  const allListingsPrecharge =
    allCandidateScopes.length *
      RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING +
    RECONCILE_LISTING_PAGINATION_RESERVE;
  const listingBudgetExhausted =
    subrequestsSpent + allListingsPrecharge >
      RECONCILE_SUBREQUEST_BUDGET;
  const fundedScopeCount = listingBudgetExhausted
    ? Math.max(
        0,
        Math.floor(
          (
            RECONCILE_SUBREQUEST_BUDGET -
            subrequestsSpent -
            RECONCILE_LISTING_PAGINATION_RESERVE
          ) / RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING,
        ),
      )
    : allCandidateScopes.length;
  const candidateScopes = allCandidateScopes.slice(
    0,
    fundedScopeCount,
  );
  const fundedScopeKeys = new Set(
    candidateScopes.map(({ key }) => key),
  );
  const fundedCandidates = candidates.filter((runner) => {
    const repository = runner.repository ?? env.GITHUB_REPOSITORY;
    return fundedScopeKeys.has(
      runnerScopeKey(resolveRunnerScope(env, repository)),
    );
  });
  const listingsPrecharge =
    candidateScopes.length *
      RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING +
    RECONCILE_LISTING_PAGINATION_RESERVE;
  subrequestsSpent += listingsPrecharge;
  const listingBudgetSpend = subrequestsSpent;
  const scopeListingResults = [];
  for (
    let offset = 0;
    offset < candidateScopes.length;
    offset += WORKER_SIMULTANEOUS_CONNECTION_LIMIT
  ) {
    const scopes = candidateScopes.slice(
      offset,
      offset + WORKER_SIMULTANEOUS_CONNECTION_LIMIT,
    );
    const listings = await Promise.all(
      scopes.map(async ({ key, scope, repository }) => {
        try {
          return {
            key,
            scope,
            repository,
            runners: await listRunners(scope, env.GITHUB_TOKEN),
          };
        } catch (error) {
          return { key, scope, repository, runners: [], error };
        }
      }),
    );
    scopeListingResults.push(...listings);
  }
  const exactListingSubrequests = scopeListingResults.reduce(
    (total, listing) => {
      if (
        Number.isSafeInteger(listing.error?.subrequestsSpent) &&
        listing.error.subrequestsSpent > 0
      ) {
        return total + listing.error.subrequestsSpent;
      }
      return total +
        Math.floor(
          listing.runners.length / GITHUB_RUNNER_LIST_PAGE_SIZE,
        ) +
        1;
    },
    0,
  );
  subrequestsSpent += exactListingSubrequests - listingsPrecharge;
  const scopeListings = scopeListingResults.filter(
    (listing) => listing.error === undefined,
  );
  const failedListingScopeKeys = new Set(
    scopeListingResults
      .filter((listing) => listing.error !== undefined)
      .map((listing) => listing.key),
  );
  const githubRunnersByScope = new Map(
    scopeListings.map(({ key, runners }) => [
      key,
      new Map(runners.map((runner) => [runner.name, runner])),
    ]),
  );
  const summary = {
    maxAgeSeconds,
    cutoffAt: new Date(cutoffMs).toISOString(),
    candidates: candidates.length,
    hasMoreCandidates: hasMoreCandidates || failedListingScopeKeys.size > 0,
    subrequestBudget: RECONCILE_SUBREQUEST_BUDGET,
    subrequestsSpent,
    candidatePageSize: RECONCILE_CANDIDATE_PAGE_SIZE,
    budgetExhausted: listingBudgetExhausted,
    githubRunnersListed: scopeListings.reduce(
      (total, listing) => total + listing.runners.length,
      0,
    ),
    retainedBusy: [],
    destroyedSandboxes: [],
    deletedRegistrations: [],
    reconciled: [],
    skippedCandidates: [],
    changedCandidates: [],
    errors: scopeListingResults
      .filter((listing) => listing.error !== undefined)
      .map((listing) => ({
        repository: listing.repository,
        ...(listing.scope.type === "organization"
          ? { scope: "organization" }
          : {}),
        phase: "github-runner-list",
        errorName: listing.error instanceof Error
          ? listing.error.name
          : undefined,
        error: listing.error instanceof Error
          ? listing.error.message
          : String(listing.error),
      })),
  };
  if (listingBudgetExhausted) {
    summary.hasMoreCandidates = true;
    summary.errors.push({
      phase: "subrequest-budget",
      error:
        `Reconcile subrequest budget ${RECONCILE_SUBREQUEST_BUDGET} ` +
        "cannot list another candidate repository after " +
        `${listingBudgetSpend} spent subrequests`,
    });
  }
  if (hasMoreCandidates) {
    summary.errors.push({
      phase: "candidate-page",
      error: `More than ${RECONCILE_CANDIDATE_PAGE_SIZE} cleanup candidates matched`,
    });
  }

  for (const row of fundedCandidates) {
    const repository = row.repository ?? env.GITHUB_REPOSITORY;
    const scopeKey = runnerScopeKey(resolveRunnerScope(env, repository));
    if (failedListingScopeKeys.has(scopeKey)) {
      continue;
    }
    if (
      subrequestsSpent + RECONCILE_SUBREQUESTS_PER_CANDIDATE >
      RECONCILE_SUBREQUEST_BUDGET
    ) {
      summary.budgetExhausted = true;
      summary.hasMoreCandidates = true;
      summary.errors.push({
        phase: "subrequest-budget",
        error:
          `Reconcile subrequest budget ${RECONCILE_SUBREQUEST_BUDGET} ` +
          `cannot process another candidate after ${subrequestsSpent} spent subrequests`,
      });
      break;
    }

    let candidateSubrequestsSpent = 0;
    try {
      const githubRunner = githubRunnersByScope
        .get(scopeKey)
        ?.get(authoritativeGithubRunnerName(row));
      if (githubRunner !== undefined && githubRunner.busy) {
        summary.retainedBusy.push({
          sandboxId: row.sandboxId,
          runnerName: row.runnerName,
          githubStatus: githubRunner.status,
          githubBusy: githubRunner.busy,
        });
        continue;
      }

      const reconcileToken = randomUUID();
      const cleanupStartedAt = new Date(now()).toISOString();
      let claim;
      try {
        candidateSubrequestsSpent = 1;
        claim = await registry.claimForReconcile(
          row.sandboxId,
          row.revision,
          reconcileToken,
          cleanupStartedAt,
        );
      } catch (error) {
        summary.errors.push(
          reconciliationError(row, "registry-claim", error),
        );
        continue;
      }
      if (!claim.claimed) {
        const changedCandidate = {
          sandboxId: row.sandboxId,
          runnerName: row.runnerName,
          reason: claim.reason,
        };
        if (claim.reason === "already-destroyed") {
          summary.skippedCandidates.push(changedCandidate);
        } else {
          summary.changedCandidates.push(changedCandidate);
          summary.errors.push(
            reconciliationError(
              row,
              "registry-claim",
              new Error(`Cleanup claim failed: ${claim.reason}`),
            ),
          );
        }
        continue;
      }

      try {
        candidateSubrequestsSpent = RECONCILE_SUBREQUESTS_PER_CANDIDATE;
        const outcome = await executeClaimedRunnerCleanup(
          env,
          registry,
          {
            cleanupToken: reconcileToken,
            destroyedBy: "reconcile",
            runner: row,
          },
          services,
        );
        if (outcome.status === "retained-busy") {
          summary.retainedBusy.push({
            sandboxId: row.sandboxId,
            runnerName: row.runnerName,
            githubStatus: outcome.githubRunner.status,
            githubBusy: outcome.githubRunner.busy,
            source: "live-recheck",
          });
          continue;
        }

        summary.destroyedSandboxes.push(row.sandboxId);
        summary.deletedRegistrations.push({
          runnerId: outcome.registrationCleanup.runnerId,
          runnerName: row.runnerName,
          result: outcome.registrationCleanup.result,
        });
        summary.reconciled.push({
          sandboxId: row.sandboxId,
          runnerName: row.runnerName,
          reason: outcome.githubRunner === undefined
            ? "not-listed"
            : outcome.githubRunner.status === "offline"
              ? "offline"
              : "idle",
        });
      } catch (error) {
        summary.errors.push(
          reconciliationError(
            row,
            error instanceof RunnerCleanupPhaseError
              ? error.phase
              : "cleanup-task",
            error,
          ),
        );
      }
    } finally {
      subrequestsSpent += candidateSubrequestsSpent;
      summary.subrequestsSpent = subrequestsSpent;
    }
  }

  console.log(safeLogRecord({
    message: "runner reconciliation",
    ...summary,
  }, env));
  return summary;
}

const AUTOPILOT_CONTROL_METHODS = Object.freeze(new Map([
  ["/autopilot/control", "GET"],
  ["/autopilot/control/kill", "POST"],
  ["/autopilot/control/resume", "POST"],
  ["/autopilot/control/capacity", "POST"],
  ["/autopilot/control/wave", "POST"],
  ["/autopilot/control/reservations", "GET"],
]));

async function readControlBody(request, allowedFields) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new InvalidControlRequest(
      "The control request body must be valid JSON",
    );
  }
  if (!isPlainObject(body)) {
    throw new InvalidControlRequest(
      "The control request body must be a JSON object",
    );
  }
  const extraField = Object.keys(body).find(
    (field) => !allowedFields.has(field),
  );
  if (extraField !== undefined) {
    throw new InvalidControlRequest(`Unknown field: ${extraField}`);
  }
  return body;
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
    throw new InvalidControlRequest(
      "The control request body must be valid JSON",
    );
  }
  if (!isPlainObject(body)) {
    throw new InvalidControlRequest(
      "The control request body must be a JSON object",
    );
  }
  const extraField = Object.keys(body).find(
    (field) => !allowedFields.has(field),
  );
  if (extraField !== undefined) {
    throw new InvalidControlRequest(`Unknown field: ${extraField}`);
  }
  return body;
}

function scaleSetCreateScope(scope) {
  if (!isPlainObject(scope)) {
    throw new InvalidControlRequest("scope must be a JSON object");
  }
  registrationTokenPath(scope);

  const type = scope.type ?? scope.level ?? scope.kind;
  if (type === "organization") {
    const organization = scope.organization ?? scope.org ?? scope.owner;
    return {
      scope,
      defaultConfigUrl: `https://github.com/${organization}`,
    };
  }

  let owner = scope.owner ?? scope.organization;
  let repository = scope.repository ?? scope.repo;
  if (
    owner === undefined &&
    typeof repository === "string" &&
    repository.includes("/")
  ) {
    [owner, repository] = repository.split("/", 2);
  }
  return {
    scope,
    defaultConfigUrl: `https://github.com/${owner}/${repository}`,
  };
}

function scaleSetCreateConfigUrl(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "string") {
    throw new InvalidControlRequest("configUrl must be an HTTPS URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidControlRequest("configUrl must be an HTTPS URL");
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidControlRequest("configUrl must be an HTTPS URL");
  }
  return value;
}

function scaleSetCreateResult(id, name, runnerGroupId) {
  return { id, name, runnerGroupId };
}

async function handleScaleSetCreateRequest(request, env, url, services) {
  if (url.pathname !== "/operator/scale-set/create") {
    return null;
  }
  const now = services.now ?? Date.now;
  const deadlineMs = now() + SCALE_SET_CREATE_TIMEOUT_MS;
  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: "POST" } },
    );
  }
  if (!(await authenticate(request, env.CONTROL_TOKEN))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input;
  try {
    const body = await readControlBody(
      request,
      new Set(["configUrl", "runnerGroupId", "scaleSetName", "scope"]),
    );
    if (
      typeof body.scaleSetName !== "string" ||
      !SCALE_SET_NAME_PATTERN.test(body.scaleSetName)
    ) {
      throw new InvalidControlRequest(
        `scaleSetName must match ${SCALE_SET_NAME_PATTERN}`,
      );
    }
    if (body.scaleSetName !== REQUIRED_RUNNER_LABEL) {
      throw new InvalidControlRequest(
        `scaleSetName must equal "${REQUIRED_RUNNER_LABEL}"`,
      );
    }
    if (!isPositiveSafeInteger(body.runnerGroupId)) {
      throw new InvalidControlRequest(
        "runnerGroupId must be a positive safe integer",
      );
    }
    const resolvedScope = scaleSetCreateScope(body.scope);
    input = {
      ...body,
      scope: resolvedScope.scope,
      configUrl: scaleSetCreateConfigUrl(
        body.configUrl,
        resolvedScope.defaultConfigUrl,
      ),
    };
  } catch (error) {
    if (error instanceof InvalidControlRequest || error instanceof TypeError) {
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

  // This explicit route uses four subrequests for creation and three when the
  // scale set exists. Both costs are far below RECONCILE_SUBREQUEST_BUDGET
  // (900), which this route does not consume.
  let phase = "registration-token";
  let registrationToken;
  let adminToken;
  try {
    registrationToken = await fetchRegistrationToken({
      scope: input.scope,
      githubToken: env.GITHUB_TOKEN,
      deadlineMs,
    }, services);
    phase = "handshake";
    const connection = await fetchActionsServiceConnection({
      configUrl: input.configUrl,
      registrationToken,
      deadlineMs,
    }, services);
    adminToken = connection.adminToken;
    phase = "lookup";
    const existingScaleSet = await getRunnerScaleSet({
      actionsServiceUrl: connection.actionsServiceUrl,
      adminToken,
      runnerGroupId: input.runnerGroupId,
      name: input.scaleSetName,
      deadlineMs,
    }, services);
    if (existingScaleSet !== null) {
      if (!isPositiveSafeInteger(existingScaleSet.id)) {
        throw new ScaleSetRequestError(
          "The runner scale set lookup returned a malformed response",
        );
      }
      return Response.json({
        created: false,
        scaleSet: scaleSetCreateResult(
          existingScaleSet.id,
          input.scaleSetName,
          input.runnerGroupId,
        ),
      });
    }

    phase = "create";
    const createdScaleSet = await createRunnerScaleSet({
      actionsServiceUrl: connection.actionsServiceUrl,
      adminToken,
      runnerGroupId: input.runnerGroupId,
      name: input.scaleSetName,
      deadlineMs,
    }, services);
    return Response.json(
      {
        created: true,
        scaleSet: scaleSetCreateResult(
          createdScaleSet.id,
          input.scaleSetName,
          input.runnerGroupId,
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    serviceLogger(services).error(safeLogRecord({
      message: "runner scale set creation failed",
      route: url.pathname,
      phase,
      error: loggedError(error),
    }, env, [registrationToken, adminToken]));
    const summary = errorSummary(error);
    const detail = JSON.parse(safeLogRecord({
      name: summary.name,
      message: summary.message,
      status: summary.status ?? null,
    }, env, [registrationToken, adminToken]));
    return Response.json(
      {
        error: "Failed to create the runner scale set",
        phase,
        detail,
      },
      { status: 502 },
    );
  }
}

function listenerRoute(pathname) {
  if (!pathname.startsWith("/autopilot/listener/")) {
    return null;
  }
  const match =
    /^\/autopilot\/listener\/([^/]+)(?:\/(rearm|stop|drain|resume|reset-admission))?$/u
      .exec(pathname);
  if (match === null) {
    return { invalid: true };
  }
  let scaleSetName;
  try {
    scaleSetName = decodeURIComponent(match[1]);
  } catch {
    return { invalid: true };
  }
  if (!SCALE_SET_NAME_PATTERN.test(scaleSetName)) {
    return { invalid: true };
  }
  return { invalid: false, scaleSetName, action: match[2] ?? "status" };
}

function getScaleSetListener(env, scaleSetName) {
  const id = env.ScaleSetListener.idFromName(scaleSetName);
  return env.ScaleSetListener.get(id);
}

async function handleScaleSetListenerRequest(
  request,
  env,
  url,
  services,
) {
  const route = listenerRoute(url.pathname);
  if (route === null) {
    return null;
  }
  if (route.invalid) {
    return Response.json(
      { error: "The scale set name is invalid" },
      { status: 400 },
    );
  }
  const allowedMethod = route.action === "status" ? "GET" : "POST";
  if (request.method !== allowedMethod) {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: allowedMethod } },
    );
  }
  if (!(await authenticate(request, env.CONTROL_TOKEN))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const listener = services.listener ??
    getScaleSetListener(env, route.scaleSetName);
  const input = { scaleSetName: route.scaleSetName };
  try {
    if (route.action === "status") {
      return Response.json(await listener.status(input));
    }
    if (route.action === "stop") {
      const body = await readControlBody(request, new Set(["reason"]));
      if (typeof body.reason !== "string" || body.reason.length === 0) {
        throw new InvalidControlRequest(
          "reason must be a non-empty string",
        );
      }
      return Response.json(await listener.stop({ ...input, ...body }));
    }
    if (route.action === "rearm") {
      const body = await readControlBody(
        request,
        new Set(["requestedGeneration"]),
      );
      if (
        !Number.isSafeInteger(body.requestedGeneration) ||
        body.requestedGeneration < 0
      ) {
        throw new InvalidControlRequest(
          "requestedGeneration must be a non-negative safe integer",
        );
      }
      return Response.json(await listener.rearm({ ...input, ...body }));
    }
    await readOptionalControlBody(request, new Set());
    if (route.action === "reset-admission") {
      return Response.json(await listener.resetAdmission(input));
    }
    return Response.json(
      route.action === "drain"
        ? await listener.drain(input)
        : await listener.resume(input),
    );
  } catch (error) {
    if (error instanceof InvalidControlRequest) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    serviceLogger(services).error(safeLogRecord({
      message: "scale set listener request failed",
      route: url.pathname,
      error: loggedError(error),
    }, env));
    const summary = errorSummary(error);
    const detail = JSON.parse(safeLogRecord({
      name: summary.name,
      message: summary.message,
      status: summary.status ?? null,
    }, env));
    return Response.json(
      {
        error: "Failed to update scale set listener",
        detail,
      },
      { status: 500 },
    );
  }
}

function reservationListParameters(url) {
  const state = url.searchParams.get("state") ?? undefined;
  let cursor;
  try {
    cursor = decodeReservationCursor(url.searchParams.get("cursor"));
  } catch (error) {
    if (error instanceof InvalidReservationCursor) {
      throw new InvalidControlRequest(
        "cursor must be a reservation cursor",
      );
    }
    throw error;
  }
  const rawLimit = url.searchParams.get("limit");
  if (rawLimit === null) {
    return { state, cursor };
  }
  if (!/^\d+$/u.test(rawLimit)) {
    throw new InvalidControlRequest(
      "limit must be a positive safe integer",
    );
  }
  const limit = Number(rawLimit);
  if (!isPositiveSafeInteger(limit)) {
    throw new InvalidControlRequest(
      "limit must be a positive safe integer",
    );
  }
  return { state, limit, cursor };
}

async function handleAutopilotControlRequest(
  request,
  env,
  url,
  requestReceivedMs,
  services,
) {
  const allowedMethod = AUTOPILOT_CONTROL_METHODS.get(url.pathname);
  if (allowedMethod === undefined) {
    return null;
  }
  if (request.method !== allowedMethod) {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: allowedMethod } },
    );
  }
  if (!(await authenticate(request, env.CONTROL_TOKEN))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const control = services.control ?? getAutopilotControl(env);
  const logger = serviceLogger(services);
  try {
    if (url.pathname === "/autopilot/control") {
      return Response.json(await control.status());
    }
    if (url.pathname === "/autopilot/control/reservations") {
      return Response.json(
        await control.listReservations({
          ...reservationListParameters(url),
          nowMs: requestReceivedMs,
        }),
      );
    }
    if (url.pathname === "/autopilot/control/resume") {
      const result = await control.openGate({ nowMs: requestReceivedMs });
      logger.log(safeLogRecord({
        message: "autopilot local gate opened",
        ...result,
      }, env));
      return Response.json(result);
    }
    if (url.pathname === "/autopilot/control/kill") {
      const body = await readControlBody(request, new Set(["reason"]));
      if (typeof body.reason !== "string" || body.reason.length === 0) {
        throw new InvalidControlRequest(
          "reason must be a non-empty string",
        );
      }
      const result = await control.closeGate({
        reason: body.reason,
        nowMs: requestReceivedMs,
      });
      logger.log(safeLogRecord({
        message: "autopilot local gate closed",
        ...result,
      }, env));
      return Response.json(result);
    }
    if (url.pathname === "/autopilot/control/capacity") {
      const body = await readControlBody(
        request,
        new Set(["approvedBy", "capacity", "effectiveAtMs", "signature"]),
      );
      const result = await control.recordCapacityApproval(body);
      if (!result.recorded && result.reason === "exceeds-policy-guard") {
        return Response.json(
          {
            error: "Capacity exceeds MAX_ACTIVE_RUNNERS",
            reason: result.reason,
            guard: result.guard,
            guardValue: result.guardValue,
            offeredCapacity: result.offeredCapacity,
          },
          { status: 409 },
        );
      }
      if (!result.recorded) {
        return Response.json(
          { error: "capacity is invalid", reason: result.reason },
          { status: 400 },
        );
      }
      logger.log(safeLogRecord({
        message: "autopilot capacity approval recorded",
        ...result,
      }, env));
      return Response.json(result);
    }
    const body = await readControlBody(request, new Set(["wave"]));
    if (typeof body.wave !== "string" || body.wave.length === 0) {
      throw new InvalidControlRequest("wave must be a non-empty string");
    }
    const result = await control.setActiveWave(body);
    logger.log(safeLogRecord({
      message: "autopilot active wave changed",
      ...result,
    }, env));
    return Response.json(result);
  } catch (error) {
    if (error instanceof InvalidControlRequest || error instanceof TypeError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    logger.error(safeLogRecord({
      message: "autopilot control request failed",
      route: url.pathname,
    }, env));
    return Response.json(
      { error: "Failed to update autopilot control" },
      { status: 500 },
    );
  }
}

export async function handleWorkerRequest(request, env, ctx, services = {}) {
    const requestReceivedMs = Date.now();
    const requestReceivedAt = new Date(requestReceivedMs).toISOString();
    const url = new URL(request.url);

    if (url.pathname === "/version") {
      return handleVersionRequest(request, env);
    }

    const cleanupSandboxId = url.pathname.startsWith("/runners/")
      ? url.pathname.slice("/runners/".length)
      : "";
    const orphanDestroyMatch =
      /^\/operator\/orphans\/([^/]+)\/destroy$/.exec(url.pathname);
    const orphanReclaimMatch =
      /^\/operator\/orphans\/([^/]+)\/reclaim$/.exec(url.pathname);

    if (request.method === "DELETE" && RUNNER_ID_PATTERN.test(cleanupSandboxId)) {
      return destroyCompletedRunner(request, env, ctx, cleanupSandboxId);
    }

    const listenerResponse = await handleScaleSetListenerRequest(
      request,
      env,
      url,
      services,
    );
    if (listenerResponse !== null) {
      return listenerResponse;
    }

    const scaleSetCreateResponse = await handleScaleSetCreateRequest(
      request,
      env,
      url,
      services,
    );
    if (scaleSetCreateResponse !== null) {
      return scaleSetCreateResponse;
    }

    const registrationCleanupResponse = await handleRegistrationCleanupRequest(
      request,
      env,
      url,
      services,
    );
    if (registrationCleanupResponse !== null) {
      return registrationCleanupResponse;
    }

    const controlResponse = await handleAutopilotControlRequest(
      request,
      env,
      url,
      requestReceivedMs,
      services,
    );
    if (controlResponse !== null) {
      return controlResponse;
    }

    if (orphanDestroyMatch !== null) {
      if (request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      return destroyOrphanedRunner(
        request,
        env,
        ctx,
        orphanDestroyMatch[1],
      );
    }

    if (orphanReclaimMatch !== null) {
      if (request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      return reclaimAbsentRunner(
        request,
        env,
        orphanReclaimMatch[1],
        services,
      );
    }

    if (url.pathname === "/runners") {
      if (request.method !== "GET" && request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "GET, POST" } },
        );
      }
      if (!(await authenticate(request, env.CONTROL_TOKEN))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      if (request.method === "GET") {
        try {
          const cursor = decodeRunnerCursor(url.searchParams.get("cursor"));
          const registry = services.registry ?? getRunnerRegistry(env);
          const page = await registry.listRunners(cursor);
          return Response.json(page);
        } catch (error) {
          if (error instanceof InvalidRunnerCursor) {
            return Response.json({ error: error.message }, { status: 400 });
          }
          console.error(
            safeLogRecord({
              message: "failed to list runner registry",
              error: error instanceof Error ? error.message : String(error),
            }, env),
          );
          return Response.json(
            { error: "Failed to list runners" },
            { status: 500 },
          );
        }
      }

      let correlationId = null;
      let requestRepository = env.GITHUB_REPOSITORY;
      try {
        correlationId = readRunnerCorrelationId(request);
        const jitBody = await readJitStartBody(request, env);
        requestRepository = jitBody.repository;
        const spawn = await startJitRunner(
          ctx,
          env,
          url.origin,
          requestReceivedAt,
          requestReceivedMs,
          correlationId,
          jitBody,
          services,
        );
        return Response.json(spawn.runner, {
          status: spawn.created ? 202 : 200,
        });
      } catch (error) {
        if (error instanceof InvalidSpawnRequest) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        if (error instanceof SpawnReplayUnavailable) {
          return Response.json(
            {
              error: error.message,
              correlationId: error.runner.correlationId,
              runnerName: error.runner.runnerName,
              sandboxId: error.runner.sandboxId,
              state: error.runner.state,
              replayed: true,
            },
            { status: 409 },
          );
        }
        if (error instanceof JitStartConflict) {
          return Response.json(
            {
              error: "JIT runner start authorization was refused",
              phase: error.phase,
              reason: error.reason,
            },
            { status: 409 },
          );
        }
        const phase = error instanceof RunnerSpawnPhaseError
          ? error.phase
          : "request";
        const upstreamStatus = error instanceof RunnerSpawnPhaseError
          ? error.upstreamStatus
          : upstreamStatusFromError(error);
        const capacityRefusal = containerCapacityRefusal(error);
        const reason = spawnFailureReason(error);
        const reflectedCorrelationId = reflectedRunnerCorrelationId(
          correlationId,
        );
        serviceLogger(services).error(safeLogRecord({
          message: "failed to start ephemeral runner",
          error: loggedError(error),
          phase,
          upstreamStatus,
          capacityRefusal,
          reason,
          correlationId: reflectedCorrelationId,
          repository: requestRepository,
          startMode: "jit",
        }, env));
        return Response.json(
          {
            error: "Failed to start runner",
            phase,
            upstreamStatus,
            reason,
            correlationId: reflectedCorrelationId,
          },
          { status: 502 },
        );
      }
    }

    if (url.pathname === "/reconcile") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      if (!(await authenticate(request, env.CONTROL_TOKEN))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const summary = await reconcileRunners(request, env, ctx);
        return Response.json(summary, {
          status: summary.errors.length === 0 ? 200 : 502,
        });
      } catch (error) {
        if (error instanceof InvalidReconcileRequest) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        console.error(
          safeLogRecord({
            message: "failed to reconcile runners",
            error: error instanceof Error ? error.message : String(error),
          }, env),
        );
        return Response.json(
          { error: "Failed to reconcile runners" },
          { status: 502 },
        );
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
}

export default {
  fetch: handleWorkerRequest,
};
