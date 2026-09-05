import {
  default as productionWorker,
  decodeRunnerCursor,
  destroyCompletedRunner,
  destroyOrphanedRunner,
  reclaimAbsentRunner,
  reconcileRunners,
  resolveRunnerScope,
  RunnerRegistry as ProductionRunnerRegistry,
  SandboxDestroyTimeout,
  runRunnerRegistryAlarm,
  validateEnvironment,
} from "../src/worker.js";
import {
  ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  GITHUB_RUNNER_LIST_PAGE_SIZE,
  MAX_CLEANUP_CONCURRENCY,
  RECONCILE_CANDIDATE_PAGE_SIZE,
  RECONCILE_LISTING_PAGINATION_RESERVE,
  RECONCILE_REGISTRY_READ_SUBREQUESTS,
  RECONCILE_SUBREQUEST_BUDGET,
  RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING,
  RUNNER_LIST_PAGE_SIZE,
  WORKER_SIMULTANEOUS_CONNECTION_LIMIT,
} from "../src/runner-policy.js";

export { AutopilotControl } from "../src/worker.js";

export class RunnerRegistry extends ProductionRunnerRegistry {
  replaceOrphanInstanceId(sandboxId, instanceId) {
    const updatedRows = this.sql
      .exec(
        `UPDATE runners
         SET orphan_instance_id = ?
         WHERE sandbox_id = ?
         RETURNING sandbox_id`,
        instanceId,
        sandboxId,
      )
      .toArray();
    if (updatedRows.length !== 1) {
      throw new Error("The orphan instance identifier was not replaced");
    }
  }

  seedUnverifiedTerminalRow(sandboxId) {
    this.sql.exec(
      `INSERT INTO runners (
         sandbox_id,
         runner_name,
         correlation_id,
         created_at,
         created_at_ms,
         state,
         destroyed_at,
         destroyed_by
       ) VALUES (?, ?, ?, ?, ?, 'destroyed', NULL, 'callback')`,
      sandboxId,
      `${sandboxId}-name`,
      `${sandboxId}-correlation`,
      new Date(0).toISOString(),
      0,
    );
  }

  seedOrphanObservations(observations) {
    for (const observation of observations) {
      this.sql.exec(
        `INSERT INTO orphan_observations (
           sandbox_id,
           instance_id,
           first_observed_at_ms
         ) VALUES (?, ?, ?)`,
        observation.sandboxId,
        observation.instanceId,
        observation.firstObservedAtMs,
      );
    }
  }

  listOrphanObservations() {
    return this.sql
      .exec(
        `SELECT sandbox_id, instance_id, first_observed_at_ms
         FROM orphan_observations
         ORDER BY sandbox_id, instance_id`,
      )
      .toArray();
  }

  listOrphanReclaimObservations() {
    return this.sql
      .exec(
        `SELECT sandbox_id, revision, first_observed_at_ms
         FROM orphan_reclaim_observations
         ORDER BY sandbox_id, revision`,
      )
      .toArray();
  }

  advanceRevision(sandboxId) {
    const updatedRows = this.sql
      .exec(
        `UPDATE runners
         SET revision = revision + 1
         WHERE sandbox_id = ?
         RETURNING revision`,
        sandboxId,
      )
      .toArray();
    if (updatedRows.length !== 1) {
      throw new Error("The runner revision was not advanced");
    }
    return updatedRows[0].revision;
  }

  schemaSnapshot(sandboxId) {
    const version = this.sql
      .exec(
        `SELECT version
         FROM runner_registry_schema
         WHERE singleton = 1`,
      )
      .toArray()[0]?.version;
    const runnerColumns = this.sql
      .exec("PRAGMA table_info(runners)")
      .toArray()
      .map((column) => column.name);
    const observationColumns = this.sql
      .exec("PRAGMA table_info(orphan_observations)")
      .toArray()
      .map((column) => ({ name: column.name, primaryKey: column.pk }));
    const reclaimObservationColumns = this.sql
      .exec("PRAGMA table_info(orphan_reclaim_observations)")
      .toArray()
      .map((column) => ({ name: column.name, primaryKey: column.pk }));
    const runner = this.sql
      .exec(
        `SELECT sandbox_id, runner_name, github_runner_name, correlation_id,
                created_at,
                created_at_ms, repository, observed_created_at,
                orphan_instance_id,
                state, cleanup_started_at, reconcile_token,
                cleanup_due_at_ms, cleanup_requested_by, cleanup_attempts,
                busy_since_ms, revision, destroyed_at, destroyed_by
         FROM runners
         WHERE sandbox_id = ?`,
        sandboxId,
      )
      .toArray()[0];
    return {
      version,
      runnerColumns,
      observationColumns,
      reclaimObservationColumns,
      runner,
    };
  }

  async invokeAlarmEntry(
    nowMs,
    { runnerCheckFailure = false, pruningFailure = false } = {},
  ) {
    this.pruningFailure = pruningFailure;
    try {
      if (nowMs === undefined && !runnerCheckFailure) {
        await super.alarm();
        return;
      }
      await this.runAlarmMaintenance({
        ...(nowMs === undefined ? {} : { now: () => nowMs }),
        ...(runnerCheckFailure
          ? {
              findRepositoryRunnerByName: async () => {
                throw new Error("simulated GitHub runner check failure");
              },
            }
          : {}),
      });
    } finally {
      this.pruningFailure = false;
    }
  }

  async settleCleanupRetryWithErrors({
    sandboxId,
    cleanupToken,
    settledAtMs,
  }) {
    const errors = [];
    const originalError = console.error;
    console.error = (value) => errors.push(String(value));
    try {
      return {
        released: await this.settleCleanupClaim(
          sandboxId,
          cleanupToken,
          "retry",
          { settledAtMs },
        ),
        errors,
        alarmAt: await this.scheduledAlarm(),
      };
    } finally {
      console.error = originalError;
    }
  }

  async invokeBusyCleanupCycles({
    record,
    firstAttemptAtMs,
    cycleCount,
    busyByCycle,
    registrationStatus = "online",
    initialCleanupRequestedBy = null,
  }) {
    await this.recordStarting(record);
    if (initialCleanupRequestedBy !== null) {
      const preparedRows = this.sql
        .exec(
          `UPDATE runners
           SET state = 'destroying',
               orphan_instance_id = ?,
               cleanup_started_at = ?,
               cleanup_due_at_ms = ?,
               cleanup_requested_by = ?,
               revision = revision + 1
           WHERE sandbox_id = ?
           RETURNING sandbox_id`,
          initialCleanupRequestedBy === "orphan" ? "a".repeat(64) : null,
          new Date(firstAttemptAtMs - 1).toISOString(),
          firstAttemptAtMs,
          initialCleanupRequestedBy,
          record.sandboxId,
        )
        .toArray();
      if (preparedRows.length !== 1) {
        throw new Error("The busy cleanup runner was not prepared");
      }
    }
    let nowMs = firstAttemptAtMs;
    let beginSandboxDestroyCalls = 0;
    let deleteRepositoryRunnerCalls = 0;
    const cycles = [];
    const logs = [];
    for (let cycle = 0; cycle < cycleCount; cycle += 1) {
      const outcome = await runRunnerRegistryAlarm(this.env, this, {
        now: () => nowMs,
        async findRepositoryRunnerByName(_repository, _token, runnerName) {
          return {
            outcome: "registration-found",
            runnerId: cycle + 1,
            runnerName,
            status: registrationStatus,
            busy: busyByCycle?.[cycle] ?? true,
          };
        },
        async deleteRepositoryRunner() {
          deleteRepositoryRunnerCalls += 1;
          return "deleted";
        },
        reconciliationSandbox: () => ({}),
        beginSandboxDestroy: () => {
          beginSandboxDestroyCalls += 1;
          return Promise.resolve();
        },
        waitForSandboxDestroy: (destroyPromise) => destroyPromise,
        control: {
          async releaseBySandbox() {
            return { released: false, reason: "not-reserved" };
          },
        },
        logger: {
          error: (value) => logs.push(JSON.parse(String(value))),
          log: (value) => logs.push(JSON.parse(String(value))),
        },
      });
      const runner = this.listRunners().runners[0];
      cycles.push({
        nowMs,
        status: outcome.status,
        forcedBusyExit: outcome.forcedBusyExit === true,
        state: runner.state,
        cleanupAttempts: runner.cleanupAttempts,
        cleanupDueAt: runner.cleanupDueAt,
        cleanupRequestedBy: runner.cleanupRequestedBy,
        cleanupStalled: runner.cleanupStalled,
        busySinceMs: runner.busySinceMs,
        destroyedBy: runner.destroyedBy,
        revision: runner.revision,
      });
      if (runner.cleanupDueAt !== null) {
        nowMs = Date.parse(runner.cleanupDueAt);
      }
    }
    return {
      beginSandboxDestroyCalls,
      deleteRepositoryRunnerCalls,
      cycles,
      logs,
    };
  }

  async invokeFailingAlarmUntilPark({
    record,
    firstAttemptAtMs,
    attemptLimit,
  }) {
    await this.recordStarting(record);
    let nowMs = firstAttemptAtMs;
    let beginSandboxDestroyCalls = 0;
    let githubCalls = 0;
    const failures = [];
    const logs = [];
    const originalError = console.error;
    console.error = (value) => logs.push(String(value));
    try {
      for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
        try {
          await runRunnerRegistryAlarm(this.env, this, {
            now: () => nowMs,
            async findRepositoryRunnerByName() {
              githubCalls += 1;
              throw new Error("GitHub runner-list request failed: 403");
            },
            beginSandboxDestroy: () => {
              beginSandboxDestroyCalls += 1;
              return Promise.resolve();
            },
          });
        } catch (error) {
          failures.push({
            message: error instanceof Error ? error.message : String(error),
            phase: error?.phase,
          });
        }
        const runner = this.listRunners().runners[0];
        if (runner.cleanupDueAt === null) {
          break;
        }
        nowMs = Date.parse(runner.cleanupDueAt);
      }
      const runner = this.listRunners().runners[0];
      const idleOutcome = await runRunnerRegistryAlarm(this.env, this, {
        now: () => nowMs + 10 * 24 * 60 * 60 * 1000,
        async findRepositoryRunnerByName() {
          githubCalls += 1;
          throw new Error("GitHub runner-list request failed: 403");
        },
        beginSandboxDestroy: () => {
          beginSandboxDestroyCalls += 1;
          return Promise.resolve();
        },
      });
      return {
        alarmAt: await this.scheduledAlarm(),
        beginSandboxDestroyCalls,
        failures,
        githubCalls,
        idleStatus: idleOutcome.status,
        logs,
        runner,
      };
    } finally {
      console.error = originalError;
    }
  }

  async invokeAlarmCleanupBatchScenario({ scenario, nowMs }) {
    const runnerCounts = {
      "batch-size": MAX_CLEANUP_CONCURRENCY + 3,
      concurrency: MAX_CLEANUP_CONCURRENCY,
      "failure-isolation": 3,
      "sequential-claims": MAX_CLEANUP_CONCURRENCY,
      "single-parity": 1,
    };
    const runnerCount = runnerCounts[scenario];
    if (runnerCount === undefined) {
      throw new Error(`Unknown alarm cleanup batch scenario ${scenario}`);
    }

    const sandboxIdPrefix = `runner-alarm-${scenario}-`;
    const firstCreatedAtMs =
      nowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS - runnerCount;
    for (let index = 0; index < runnerCount; index += 1) {
      const sandboxId = `${sandboxIdPrefix}${index}`;
      const createdAtMs = firstCreatedAtMs + index;
      await this.recordStarting({
        sandboxId,
        runnerName: `${sandboxId}-name`,
        ...(scenario === "failure-isolation"
          ? { githubRunnerName: `${sandboxId}-github` }
          : {}),
        correlationId: `${sandboxId}-correlation`,
        createdAt: new Date(createdAtMs).toISOString(),
        createdAtMs,
      });
    }

    const durableRegistry = this;
    let claimCalls = 0;
    let claimsInFlight = 0;
    let maxClaimsInFlight = 0;
    const registry = {
      async claimNextDueCleanup(claimAtMs) {
        claimCalls += 1;
        claimsInFlight += 1;
        maxClaimsInFlight = Math.max(
          maxClaimsInFlight,
          claimsInFlight,
        );
        await Promise.resolve();
        try {
          return await durableRegistry.claimNextDueCleanup(claimAtMs);
        } finally {
          claimsInFlight -= 1;
        }
      },
      settleCleanupClaim: (...args) =>
        durableRegistry.settleCleanupClaim(...args),
    };

    let destroyInFlight = 0;
    let maxDestroysInFlight = 0;
    let releaseDestroyGate;
    let destroyGateEscapeTimer = null;
    const destroyGate = new Promise((resolve) => {
      releaseDestroyGate = resolve;
    });
    const destroyEvents = [];
    const logs = [];
    const services = {
      now: () => nowMs,
      async findRepositoryRunnerByName(_scope, _token, runnerName) {
        if (
          scenario === "failure-isolation" &&
          runnerName === `${sandboxIdPrefix}1-github`
        ) {
          throw new Error("simulated middle GitHub runner check failure");
        }
        return { outcome: "registration-not-found", runnerName };
      },
      reconciliationSandbox(_env, sandboxId) {
        return { sandboxId };
      },
      beginSandboxDestroy(sandbox) {
        destroyInFlight += 1;
        maxDestroysInFlight = Math.max(
          maxDestroysInFlight,
          destroyInFlight,
        );
        destroyEvents.push({
          event: "entry",
          sandboxId: sandbox.sandboxId,
          inFlight: destroyInFlight,
        });
        const recordExit = () => {
          destroyInFlight -= 1;
          destroyEvents.push({
            event: "exit",
            sandboxId: sandbox.sandboxId,
            inFlight: destroyInFlight,
          });
        };
        if (scenario !== "concurrency") {
          recordExit();
          return Promise.resolve();
        }
        if (destroyGateEscapeTimer === null) {
          // The 500 ms valve permits harness scheduling and keeps a sequential mutant failure fast.
          destroyGateEscapeTimer = setTimeout(releaseDestroyGate, 500);
        }
        if (destroyInFlight === MAX_CLEANUP_CONCURRENCY) {
          clearTimeout(destroyGateEscapeTimer);
          releaseDestroyGate();
        }
        return destroyGate.finally(recordExit);
      },
      waitForSandboxDestroy: (destroyPromise) => destroyPromise,
      control: {
        async releaseBySandbox() {
          return { released: false, reason: "not-reserved" };
        },
      },
      logger: {
        error() {},
        log() {},
      },
    };

    const originalLog = console.log;
    console.log = (value) => logs.push(String(value));
    let outcome = null;
    let error = null;
    try {
      outcome = await runRunnerRegistryAlarm(
        this.env,
        registry,
        services,
      );
    } catch (caught) {
      error = {
        message: caught instanceof Error ? caught.message : String(caught),
        phase: caught?.phase,
      };
    } finally {
      console.log = originalLog;
    }

    return {
      claimCalls,
      destroyEvents,
      error,
      logs,
      maxCleanupConcurrency: MAX_CLEANUP_CONCURRENCY,
      maxClaimsInFlight,
      maxDestroysInFlight,
      outcome,
      runners: this.listRunners().runners,
    };
  }

  async invokeAlarmSnapshot(nowMs, includeObservationCount = false) {
    await this.runAlarmMaintenance({
      ...(nowMs === undefined ? {} : { now: () => nowMs }),
    });
    const remainingRows = this.sql
      .exec("SELECT COUNT(*) AS row_count FROM runners")
      .toArray()[0].row_count;
    return {
      remainingRows,
      ...(includeObservationCount
        ? {
            remainingObservations: this.sql
              .exec(
                "SELECT COUNT(*) AS row_count FROM orphan_observations",
              )
              .toArray()[0].row_count,
          }
        : {}),
      alarmAt: await this.scheduledAlarm(),
    };
  }

  async invokePruningFailureControl(nowMs, cleanupSandboxId) {
    this.pruningFailure = true;
    try {
      await this.runAlarmMaintenance({ now: () => nowMs });
      throw new Error("simulated pruning failure did not escape");
    } catch (error) {
      const cleanupState = this.sql
        .exec(
          "SELECT state FROM runners WHERE sandbox_id = ?",
          cleanupSandboxId,
        )
        .toArray()[0]?.state;
      const prunableRows = this.sql
        .exec(
          "SELECT COUNT(*) AS row_count FROM runners WHERE sandbox_id LIKE 'runner-page-%'",
        )
        .toArray()[0].row_count;
      return {
        error: error instanceof Error ? error.message : String(error),
        cleanupState,
        prunableRows,
        alarmAt: await this.scheduledAlarm(),
      };
    } finally {
      this.pruningFailure = false;
    }
  }

  async pruneTerminalRows() {
    if (this.pruningFailure) {
      throw new Error("simulated terminal pruning failure");
    }
    await super.pruneTerminalRows();
  }

  async recordOnline(record) {
    const result = await this.recordStarting(record);
    if (!this.markOnline(record.sandboxId)) {
      throw new Error(`Runner ${record.sandboxId} did not become online`);
    }
    return result;
  }

  async recordCallbackCleanup(record, cleanupStartedAt) {
    await this.recordStarting(record);
    return this.beginCallbackCleanup(record.sandboxId, cleanupStartedAt);
  }

  async recordAbandonedClaim(record, claimAtMs) {
    await this.recordStarting(record);
    return this.claimNextDueCleanup(claimAtMs);
  }

  seedActiveRows({ count, sandboxIdPrefix, createdAtMs }) {
    const createdAt = new Date(createdAtMs).toISOString();
    if (sandboxIdPrefix === undefined) {
      this.sql.exec(
        `WITH RECURSIVE sequence(row_index) AS (
           VALUES (0)
           UNION ALL
           SELECT row_index + 1
           FROM sequence
           WHERE row_index + 1 < ?
         )
         INSERT INTO runners (
           sandbox_id,
           runner_name,
           correlation_id,
           repository,
           created_at,
           created_at_ms,
           state
         )
         SELECT
           'runner-active-page-' || printf('%05d', row_index),
           'runner-active-page-name-' || printf('%05d', row_index),
           'runner-active-page-correlation-' || printf('%05d', row_index),
           'example/repository-' || printf('%03d', row_index % 20),
           ?,
           ? + row_index,
           'online'
         FROM sequence`,
        count,
        createdAt,
        createdAtMs,
      );
      return;
    }
    const cleanupDueAtMs = createdAtMs + ACTIVE_RUNNER_CLEANUP_DELAY_MS;
    this.sql.exec(
      `WITH RECURSIVE sequence(row_index) AS (
         VALUES (0)
         UNION ALL
         SELECT row_index + 1
         FROM sequence
         WHERE row_index + 1 < ?
       ), active_rows(sandbox_id) AS (
         SELECT ? || row_index
         FROM sequence
       )
       INSERT INTO runners (
         sandbox_id,
         runner_name,
         correlation_id,
         created_at,
         created_at_ms,
         state,
         cleanup_due_at_ms
       )
       SELECT
         sandbox_id,
         sandbox_id || '-name',
         sandbox_id || '-correlation',
         ?,
         ?,
         'starting',
         ?
       FROM active_rows`,
      count,
      sandboxIdPrefix,
      createdAt,
      createdAtMs,
      cleanupDueAtMs,
    );
  }

  seedTerminalRows({
    count,
    createdAtMs,
    destroyedAtMs = createdAtMs,
    tieAtIndex = -1,
  }) {
    const createdAt = new Date(createdAtMs).toISOString();
    const destroyedAt = new Date(destroyedAtMs).toISOString();
    this.sql.exec(
      `WITH RECURSIVE sequence(row_index) AS (
         VALUES (0)
         UNION ALL
         SELECT row_index + 1
         FROM sequence
         WHERE row_index + 1 < ?
       )
       INSERT INTO runners (
         sandbox_id,
         runner_name,
         correlation_id,
         created_at,
         created_at_ms,
         state,
         destroyed_at,
         destroyed_by
       )
       SELECT
         'runner-page-' || printf('%05d', row_index),
         'runner-page-name-' || printf('%05d', row_index),
         'runner-page-correlation-' || printf('%05d', row_index),
         ?,
         ? + row_index - CASE WHEN row_index = ? + 1 THEN 1 ELSE 0 END,
         'destroyed',
         ?,
         'callback'
       FROM sequence`,
      count,
      createdAt,
      createdAtMs,
      tieAtIndex,
      destroyedAt,
    );
  }

  seedInvalidActiveRow(sandboxId, cleanupDueAtMs) {
    this.sql.exec(
      `INSERT INTO runners (
         sandbox_id,
         runner_name,
         correlation_id,
         created_at,
         created_at_ms,
         state,
         cleanup_due_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'starting', ?)`,
      sandboxId,
      `${sandboxId}-name`,
      `${sandboxId}-correlation`,
      new Date(0).toISOString(),
      0,
      cleanupDueAtMs,
    );
  }

  seedInvalidTerminalRow(sandboxId) {
    this.sql.exec(
      `INSERT INTO runners (
         sandbox_id,
         runner_name,
         correlation_id,
         created_at,
         created_at_ms,
         state,
         destroyed_at,
         destroyed_by
       ) VALUES (?, ?, ?, ?, ?, 'destroyed', 'invalid', 'callback')`,
      sandboxId,
      `${sandboxId}-name`,
      `${sandboxId}-correlation`,
      new Date(0).toISOString(),
      0,
    );
  }

  async recordStartingWithErrors(record) {
    const errors = [];
    const originalError = console.error;
    console.error = (value) => errors.push(String(value));
    try {
      const result = await this.recordStarting(record);
      return {
        alarmAt: await this.scheduledAlarm(),
        errors,
        result,
      };
    } finally {
      console.error = originalError;
    }
  }

  async setDestroyFailures(destroyFailures) {
    await this.ctx.storage.put("destroyFailures", destroyFailures);
    await this.ctx.storage.put("destroyAttempts", 0);
    await this.ctx.storage.put("destroyed", 0);
  }

  async destroy() {
    const destroyAttempts =
      (await this.ctx.storage.get("destroyAttempts")) ?? 0;
    await this.ctx.storage.put("destroyAttempts", destroyAttempts + 1);
    const destroyFailures =
      (await this.ctx.storage.get("destroyFailures")) ?? 0;
    if (destroyFailures > 0) {
      await this.ctx.storage.put("destroyFailures", destroyFailures - 1);
      throw new Error("simulated interrupted destroy");
    }
    const destroyed = (await this.ctx.storage.get("destroyed")) ?? 0;
    await this.ctx.storage.put("destroyed", destroyed + 1);
  }

  async status() {
    return {
      destroyAttempts: (await this.ctx.storage.get("destroyAttempts")) ?? 0,
      destroyed: (await this.ctx.storage.get("destroyed")) ?? 0,
    };
  }
}

const nativeFetch = globalThis.fetch.bind(globalThis);
let runnerListingPageLimitFetches = 0;
let scopedCleanupFetchState = null;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (
    scopedCleanupFetchState !== null &&
    url.origin === "https://api.github.com"
  ) {
    scopedCleanupFetchState.calls.push({
      method: request.method,
      url: request.url,
    });
    if (request.method === "GET") {
      scopedCleanupFetchState.lookupCalls += 1;
      const runners = scopedCleanupFetchState.runners.map((runner) => ({
        ...runner,
        ...(scopedCleanupFetchState.mode === "recheck-busy" &&
            scopedCleanupFetchState.lookupCalls > 1 &&
            runner.name === scopedCleanupFetchState.authoritativeName
          ? { status: "online", busy: true }
          : {}),
        ...(scopedCleanupFetchState.mode === "identity-changed" &&
            scopedCleanupFetchState.lookupCalls > 1 &&
            runner.name === scopedCleanupFetchState.authoritativeName
          ? { id: runner.id + 1 }
          : {}),
      }));
      return Response.json({
        total_count: runners.length,
        runners,
      });
    }
    if (request.method === "DELETE") {
      scopedCleanupFetchState.deleteCalls += 1;
      return new Response(null, { status: 204 });
    }
  }
  if (
    request.method === "GET" &&
    url.origin === "https://api.github.com" &&
    url.pathname === "/repos/example/listing-page-limit/actions/runners"
  ) {
    runnerListingPageLimitFetches += 1;
    const page = Number(url.searchParams.get("page"));
    const pageLimit = RECONCILE_LISTING_PAGINATION_RESERVE + 1;
    const runners = page <= pageLimit
      ? Array.from({ length: GITHUB_RUNNER_LIST_PAGE_SIZE }, (_, index) => ({
          id: (page - 1) * GITHUB_RUNNER_LIST_PAGE_SIZE + index + 1,
          name: `listing-page-limit-${page}-${index}`,
          status: "online",
          busy: false,
        }))
      : [];
    return Response.json({ total_count: runners.length, runners });
  }
  if (
    request.method === "GET" &&
    url.origin === "https://api.github.com" &&
    url.pathname === "/repos/example/runner-test/actions/runners"
  ) {
    return Response.json({ total_count: 0, runners: [] });
  }
  return nativeFetch(input, init);
};

const productionTestEnv = {
  CONTROL_TOKEN: "control-token-with-at-least-32-characters",
  GITHUB_REPOSITORY: "example/runner-test",
  GITHUB_TOKEN: "github-token",
  RUNNER_LABELS: "cloudflare-sandbox",
};

function createProductionStubs({
  events = [],
  runner: runnerOverrides = {},
  claim: claimOverrides = {},
  registry: registryOverrides = {},
  services: serviceOverrides = {},
} = {}) {
  const runner = {
    sandboxId: "runner-production-control",
    runnerName: "cloudflare-production-control",
    state: "online",
    cleanupRequestedBy: null,
    revision: 0,
    ...runnerOverrides,
  };
  if (!Object.hasOwn(runnerOverrides, "githubRunnerName")) {
    runner.githubRunnerName = runner.runnerName;
  }
  let cleanupClaimOutstanding = false;
  const registry = {
    async claimNextDueCleanup() {
      if (cleanupClaimOutstanding) {
        return null;
      }
      cleanupClaimOutstanding = true;
      events.push("claimed");
      return {
        cleanupToken: "alarm-token",
        destroyedBy: "alarm",
        runner,
        ...claimOverrides,
      };
    },
    async revalidateOrphanCleanupClaim() {
      events.push("ownership-revalidated");
      return true;
    },
    async settleCleanupClaim(sandboxId, cleanupToken, settlement, details) {
      cleanupClaimOutstanding = false;
      if (settlement === "complete") {
        events.push({ sandboxId, cleanupToken, ...(details ?? {}) });
      } else {
        events.push("released");
      }
      return true;
    },
    async settleUnownedOrphanCleanupClaim() {
      return true;
    },
    async postponeBusyCleanup() {
      events.push("busy-claim-released");
      return {
        postponed: true,
        forcedBusyExit: false,
        busySinceMs: null,
        busyAgeMs: null,
      };
    },
    ...registryOverrides,
  };
  const services = {
    now: () => 1_776_945_600_000,
    randomUUID: () => "production-control-token",
    async findRepositoryRunnerByName(_repository, _token, runnerName) {
      return { outcome: "registration-not-found", runnerName };
    },
    async deleteRepositoryRunner() {
      events.push("registration-deleted");
      return "deleted";
    },
    reconciliationSandbox() {
      return {
        async destroy() {
          events.push("destroyed");
        },
      };
    },
    ...serviceOverrides,
  };
  return { events, runner, registry, services };
}

async function productionScopedCleanupResponse(request) {
  const mode = new URL(request.url).searchParams.get("mode");
  const organizationScope = mode !== "repository";
  const authoritativeName = mode === "absent"
    ? "cloudflare-4-7"
    : "cloudflare-2-7";
  const fetchState = {
    calls: [],
    deleteCalls: 0,
    lookupCalls: 0,
    authoritativeName,
    mode,
    runners: [
      {
        id: 37,
        name: "cloudflare-3-7",
        status: "offline",
        busy: false,
      },
      {
        id: 27,
        name: "cloudflare-2-7",
        status: "online",
        busy: mode === "busy",
      },
      {
        id: 99,
        name: "unrelated-runner",
        status: "offline",
        busy: false,
      },
    ],
  };
  let destroyCalls = 0;
  let postponeCalls = 0;
  const postponeOptions = [];
  const events = [];
  const logs = [];
  const { registry, services } = createProductionStubs({
    events,
    runner: {
      sandboxId: `runner-scoped-${mode}`,
      runnerName: `cloudflare-sandbox-${mode}`,
      githubRunnerName: mode === "name-unknown"
        ? null
        : mode === "name-blank"
          ? "   "
          : `  ${authoritativeName}  `,
      repository: "example/job-repository",
    },
    claim: {
      ...(mode === "online" ? { retainOnlineRunner: true } : {}),
    },
    registry: {
      async postponeBusyCleanup(...args) {
        postponeCalls += 1;
        postponeOptions.push(args[5]);
        return {
          postponed: true,
          forcedBusyExit: false,
          busySinceMs: null,
          busyAgeMs: null,
        };
      },
    },
    services: {
      findRepositoryRunnerByName: undefined,
      deleteRepositoryRunner: undefined,
      reconciliationSandbox: () => ({
        async destroy() {
          destroyCalls += 1;
        },
      }),
      control: {
        async releaseBySandbox() {
          return { released: false, reason: "not-reserved" };
        },
      },
      logger: {
        error: (value) => logs.push(String(value)),
        log: (value) => logs.push(String(value)),
      },
    },
  });
  const env = {
    ...productionTestEnv,
    ...(mode === "delete-disabled"
      ? { RUNNER_REGISTRATION_DELETE: "off" }
      : mode === "delete-enabled-other"
        ? { RUNNER_REGISTRATION_DELETE: "OFF" }
        : {}),
    ...(organizationScope
      ? { GITHUB_RUNNER_SCOPE: "organization" }
      : {}),
  };

  scopedCleanupFetchState = fetchState;
  let outcome;
  try {
    outcome = await runRunnerRegistryAlarm(env, registry, services);
  } finally {
    scopedCleanupFetchState = null;
  }
  return Response.json({
    calls: fetchState.calls,
    deleteCalls: fetchState.deleteCalls,
    destroyCalls,
    events,
    logs,
    postponeCalls,
    postponeOptions,
    lookupOutcome: outcome.githubRunner === undefined
      ? "registration-not-found"
      : "registration-found",
    outcome,
  });
}

function productionRunnerScopeResponse() {
  const resolutionRepository = "example/job-repository";
  const resolve = (value, configured = true) => resolveRunnerScope(
    {
      ...productionTestEnv,
      ...(configured ? { GITHUB_RUNNER_SCOPE: value } : {}),
    },
    resolutionRepository,
  );
  let badResolutionError;
  try {
    resolve("owner");
  } catch (error) {
    badResolutionError = error instanceof Error
      ? error.message
      : String(error);
  }

  const accepted = [
    { label: "absent", configured: false },
    { label: "undefined", value: undefined },
    { label: "null", value: null },
    { label: "empty", value: "" },
    { label: "whitespace", value: " \t" },
    { label: "repository", value: "repository" },
    { label: "organization", value: "organization" },
    { label: "explicit", value: "organization:acme" },
  ].map(({ label, value, configured = true }) => {
    try {
      validateEnvironment({
        ...productionTestEnv,
        ...(configured ? { GITHUB_RUNNER_SCOPE: value } : {}),
      });
      return { label, accepted: true };
    } catch (error) {
      return {
        label,
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const rejected = [
    "owner",
    "organization:",
    "organization:acme/team",
    "organization:ac*me",
    "organization:ac..me",
  ].map((value) => {
    try {
      validateEnvironment({
        ...productionTestEnv,
        GITHUB_RUNNER_SCOPE: value,
      });
      return { value, rejected: false };
    } catch (error) {
      return {
        value,
        rejected: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return Response.json({
    resolutions: {
      absent: resolve(undefined, false),
      repository: resolve("repository"),
      organization: resolve("organization"),
      explicit: resolve("organization:acme"),
    },
    badResolutionError,
    accepted,
    rejected,
  });
}

function recordingControl(releaseCalls, failure) {
  return {
    async releaseBySandbox(input) {
      releaseCalls.push(input);
      if (failure !== undefined) {
        throw failure;
      }
      return {
        released: true,
        replayed: false,
        reservationId: `reservation-${input.sandboxId}`,
      };
    },
  };
}

async function productionAlarmOrphanControl(mode) {
  const claimedAtMs = 1_800_000_000_000;
  let clockMs = mode === "lease" ? claimedAtMs + 30_000 : claimedAtMs;
  let githubChecks = 0;
  const events = [];
  const { runner, registry, services } = createProductionStubs({
    events,
    runner: {
      sandboxId: `runner-alarm-orphan-${mode}`,
      runnerName: `cloudflare-alarm-orphan-${mode}`,
      githubRunnerName: `cloudflare-github-alarm-orphan-${mode}`,
      state: "destroying",
      cleanupDueAt: new Date(claimedAtMs + 90_000).toISOString(),
      cleanupRequestedBy: "orphan",
      revision: 1,
    },
    claim: {
      cleanupToken: `alarm-orphan-${mode}-token`,
      destroyedBy: "orphan",
      previousState: "destroying",
      previousCleanupRequestedBy: "orphan",
    },
    registry: {
      async revalidateOrphanCleanupClaim() {
        events.push("ownership-revalidated");
        return false;
      },
      async settleCleanupClaim(_sandboxId, _token, settlement) {
        events.push(`claim-${settlement}`);
        return true;
      },
      async postponeBusyCleanup() {
        events.push("busy-postponed");
        return {
          postponed: true,
          forcedBusyExit: false,
          busySinceMs: null,
          busyAgeMs: null,
        };
      },
    },
    services: {
      now: () => clockMs,
      async findRepositoryRunnerByName(_repository, _token, runnerName) {
        githubChecks += 1;
        events.push("github-checked");
        if (mode === "lease" && githubChecks === 1) {
          clockMs = Date.parse(runner.cleanupDueAt);
        }
        return ["delete-ownership", "busy", "online"].includes(mode)
          ? {
              outcome: "registration-found",
              runnerId: 901,
              runnerName,
              status: mode === "delete-ownership" ? "offline" : "online",
              busy: mode === "busy",
            }
          : { outcome: "registration-not-found", runnerName };
      },
      reconciliationSandbox() {
        events.push("sandbox-accessed");
        return {
          async destroy() {
            events.push("sandbox-destroyed");
          },
        };
      },
    },
  });
  try {
    const outcome = await runRunnerRegistryAlarm(
      productionTestEnv,
      registry,
      services,
    );
    return Response.json({ events, outcome });
  } catch (error) {
    return Response.json({
      events,
      error: {
        message: error instanceof Error ? error.message : String(error),
        phase: error?.phase,
      },
    });
  }
}

async function productionOrphanClaimClockResponse() {
  const sandboxId = "runner-00000000-0000-4000-8000-000000000201";
  const parsedAtMs = 1_800_000_000_000;
  let clockMs = parsedAtMs - 120_000;
  let claimedAt;
  const { registry, services } = createProductionStubs({
    registry: {
      async claimOrphanCleanup(
        _sandboxId,
        _condition,
        _revision,
        _observedInstanceId,
        _token,
        cleanupStartedAt,
      ) {
        claimedAt = cleanupStartedAt;
        return {
          claimed: false,
          reason: "observation-mismatch",
          actualCondition: "terminal",
        };
      },
    },
    services: {
      now: () => clockMs,
      randomUUID: () => "claim-clock-token",
    },
  });
  const response = await destroyOrphanedRunner(
    {
      headers: new Headers({
        Authorization: `Bearer ${productionTestEnv.CONTROL_TOKEN}`,
      }),
      async json() {
        clockMs = parsedAtMs;
        return {
          observedRegistryCondition: "absent",
          expectedRevision: null,
          observedSandboxInstanceId: "4".repeat(64),
          observedRegistration: {
            outcome: "registration-not-found",
            runnerName: "cloudflare-00000000-0000-4000-8000-000000000201",
          },
        };
      },
    },
    productionTestEnv,
    {},
    sandboxId,
    { ...services, registry },
  );
  return Response.json({
    claimedAt,
    parsedAt: new Date(parsedAtMs).toISOString(),
    responseStatus: response.status,
  });
}

async function productionOrphanDestroyResponse(
  request,
  env,
  ctx,
  url,
  sandboxId,
) {
  if (url.searchParams.get("productionRoute") === "true") {
    return productionWorker.fetch(request, env, ctx);
  }
  const events = [];
  const logs = [];
  const releaseCalls = [];
  const githubState = url.searchParams.get("github") ?? "absent";
  const nowMs = Number(url.searchParams.get("nowMs"));
  let serviceNowMs = nowMs;
  const durableRegistry = getRegistry(request, env);
  const cancelMode = url.searchParams.get("cancel");
  let cancelAttempts = 0;
  let ownershipChecks = 0;
  let githubChecks = 0;
  const githubRunnerNames = [];
  const deletedRunnerIds = [];
  let fakeTimerNow = 0;
  let nextTimerId = 1;
  const fakeTimers = new Map();
  const setTimeoutFn = (callback, delayMs) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    fakeTimers.set(timerId, {
      callback,
      dueAtMs: fakeTimerNow + delayMs,
      delayMs,
    });
    return timerId;
  };
  const clearTimeoutFn = (timerId) => {
    fakeTimers.delete(timerId);
  };
  const advanceTimers = (advanceMs) => {
    fakeTimerNow += advanceMs;
    for (const [timerId, timer] of fakeTimers) {
      if (timer.dueAtMs <= fakeTimerNow) {
        fakeTimers.delete(timerId);
        timer.callback();
      }
    }
  };
  const destroyTimesOut = url.searchParams.get("destroy") === "timeout";
  let reportDestroyStarted;
  const destroyStarted = new Promise((resolve) => {
    reportDestroyStarted = resolve;
  });
  const { registry, services } = createProductionStubs({
    events,
    registry: {
      async claimOrphanCleanup(...args) {
        const claim = await durableRegistry.claimOrphanCleanup(...args);
        if (
          claim.claimed &&
          url.searchParams.get("claimLease") === "expired"
        ) {
          return {
            ...claim,
            runner: {
              ...claim.runner,
              cleanupDueAt: new Date(nowMs - 1).toISOString(),
            },
          };
        }
        return claim;
      },
      async settleCleanupClaim(...args) {
        if (args[2] === "abandon") {
          cancelAttempts += 1;
          if (cancelMode === "stale-reclaim") {
            if (cancelAttempts === 1) {
              await durableRegistry.claimNextDueCleanup(nowMs + 90_001);
              throw new Error("simulated cancellation failure");
            }
            return false;
          }
        }
        return durableRegistry.settleCleanupClaim(...args);
      },
      settleUnownedOrphanCleanupClaim: (...args) =>
        durableRegistry.settleUnownedOrphanCleanupClaim(...args),
      postponeBusyCleanup: (...args) =>
        durableRegistry.postponeBusyCleanup(...args),
      async revalidateOrphanCleanupClaim(...args) {
        if (args[1] !== undefined) {
          ownershipChecks += 1;
          if (
            url.searchParams.get("ownership") === "lost" &&
            ownershipChecks === 1
          ) {
            return false;
          }
          if (
            url.searchParams.get("sandboxGeneration") === "changed" &&
            ownershipChecks === 1
          ) {
            await durableRegistry.replaceOrphanInstanceId(
              sandboxId,
              "f".repeat(64),
            );
          }
        }
        return durableRegistry.revalidateOrphanCleanupClaim(...args);
      },
    },
    services: {
      now: () => serviceNowMs,
      randomUUID: () => `orphan-cleanup-token-${sandboxId}`,
      async findRepositoryRunnerByName(_repository, _token, runnerName) {
        githubChecks += 1;
        githubRunnerNames.push(runnerName);
        events.push("github-checked");
        if (githubState === "lease-expired") {
          serviceNowMs += 90_001;
          return { outcome: "registration-not-found", runnerName };
        }
        if (githubState === "error") {
          throw new Error(
            url.searchParams.get("errorMessage") ??
              "simulated GitHub runner check failure",
          );
        }
        if (githubState === "busy-on-recheck" && githubChecks > 1) {
          return {
            outcome: "registration-found",
            runnerId: 901,
            runnerName,
            status: "online",
            busy: true,
          };
        }
        if (githubState === "absent") {
          return { outcome: "registration-not-found", runnerName };
        }
        return {
          outcome: "registration-found",
          runnerId: 901,
          runnerName,
          status:
            githubState === "busy" || githubState === "online"
              ? "online"
              : "offline",
          busy: githubState === "busy",
        };
      },
      async deleteRepositoryRunner(_repository, _token, runnerId) {
        if (url.searchParams.get("delete") === "error") {
          throw new Error("simulated GitHub runner delete failure");
        }
        deletedRunnerIds.push(runnerId);
        events.push("registration-deleted");
        return "deleted";
      },
      reconciliationSandbox: () => ({
        async destroy() {
          events.push(
            destroyTimesOut
              ? "sandbox-destroy-started"
              : "sandbox-destroyed",
          );
          if (destroyTimesOut) {
            reportDestroyStarted();
            return new Promise(() => {});
          }
        },
      }),
      ...(destroyTimesOut
        ? {
            setTimeout: setTimeoutFn,
            clearTimeout: clearTimeoutFn,
          }
        : {}),
      logger: {
        error: (value) => logs.push(String(value)),
        log: (value) => logs.push(String(value)),
      },
      control: recordingControl(releaseCalls),
    },
  });
  const responsePromise = destroyOrphanedRunner(
    request,
    {
      ...productionTestEnv,
      ...(url.searchParams.get("registrationDelete") === "off"
        ? { RUNNER_REGISTRATION_DELETE: "off" }
        : {}),
    },
    {},
    sandboxId,
    { ...services, registry },
  );
  let timeoutProof;
  let responseSettled = false;
  responsePromise.then(
    () => {
      responseSettled = true;
    },
    () => {
      responseSettled = true;
    },
  );
  if (destroyTimesOut) {
    await destroyStarted;
    const destroyTimer = [...fakeTimers.values()][0];
    advanceTimers(destroyTimer.delayMs - 1);
    await Promise.resolve();
    timeoutProof = {
      timeoutMs: destroyTimer.delayMs,
      settledBeforeBoundary: responseSettled,
    };
    advanceTimers(1);
  }
  const response = await responsePromise;
  const result = await response.json();
  return Response.json(
    {
      ...result,
      events,
      logs,
      releaseCalls,
      githubRunnerNames,
      deletedRunnerIds,
      cancelAttempts,
      timeoutProof,
    },
    { status: response.status, headers: response.headers },
  );
}

async function productionOrphanReclaimResponse(
  request,
  env,
  ctx,
  url,
  sandboxId,
) {
  if (url.searchParams.get("productionRoute") === "true") {
    return productionWorker.fetch(request, env, ctx);
  }
  const durableRegistry = getRegistry(request, env);
  const events = [];
  const logs = [];
  const releaseCalls = [];
  const deletedRunnerIds = [];
  const githubRunnerNames = [];
  const githubLookupResults = [];
  const githubState = url.searchParams.get("github") ?? "absent";
  const destroyMode = url.searchParams.get("destroy") ?? "complete";
  const nowMs = Number(url.searchParams.get("nowMs"));
  const registry = {
    async observeOrphanReclaim(...args) {
      const observation = await durableRegistry.observeOrphanReclaim(...args);
      if (
        observation.ready &&
        url.searchParams.get("claimRace") === "revision"
      ) {
        await durableRegistry.advanceRevision(sandboxId);
      }
      return observation;
    },
    claimForReconcile: (...args) =>
      durableRegistry.claimForReconcile(...args),
    postponeBusyCleanup: (...args) =>
      durableRegistry.postponeBusyCleanup(...args),
    settleCleanupClaim: (...args) =>
      durableRegistry.settleCleanupClaim(...args),
  };
  const services = {
    registry,
    now: () => nowMs,
    randomUUID: () => `orphan-reclaim-token-${sandboxId}`,
    async findRepositoryRunnerByName(_repository, _token, runnerName) {
      githubRunnerNames.push(runnerName);
      events.push("github-checked");
      if (githubState === "absent") {
        const result = { outcome: "registration-not-found", runnerName };
        githubLookupResults.push(result);
        return result;
      }
      const result = {
        outcome: "registration-found",
        runnerId: 901,
        runnerName,
        status:
          githubState === "offline" ||
            (
              githubState === "online-on-recheck" &&
              githubRunnerNames.length === 1
            )
            ? "offline"
            : "online",
        busy: githubState === "busy",
      };
      githubLookupResults.push(result);
      return result;
    },
    async deleteRepositoryRunner(_repository, _token, runnerId) {
      events.push("registration-cleaned");
      deletedRunnerIds.push(runnerId);
      return "deleted";
    },
    reconciliationSandbox() {
      return {
        async destroy() {
          if (destroyMode === "error") {
            events.push("sandbox-destroy-attempted");
            throw new Error("simulated absent sandbox destroy failure");
          }
          events.push("sandbox-destroyed");
        },
      };
    },
    control: recordingControl(releaseCalls),
    logger: {
      error: (value) => logs.push(String(value)),
      log: (value) => logs.push(String(value)),
    },
  };
  const response = await reclaimAbsentRunner(
    request,
    productionTestEnv,
    sandboxId,
    services,
  );
  return Response.json(
    {
      ...(await response.json()),
      events,
      logs,
      releaseCalls,
      deletedRunnerIds,
      githubRunnerNames,
      githubLookupResults,
    },
    { status: response.status, headers: response.headers },
  );
}

async function productionAlarmCleanupResponse() {
  const { events, registry, services } = createProductionStubs({
    runner: {
      sandboxId: "runner-alarm-cleanup",
      runnerName: "cloudflare-alarm-cleanup",
    },
  });
  const outcome = await runRunnerRegistryAlarm(
    productionTestEnv,
    registry,
    services,
  );
  return Response.json({ events, outcome });
}

async function productionAlarmReservationReleaseResponse() {
  const releaseCalls = [];
  const logs = [];
  const { registry, services } = createProductionStubs({
    runner: {
      sandboxId: "runner-alarm-reservation-release",
      runnerName: "cloudflare-alarm-reservation-release",
      cleanupRequestedBy: "callback",
    },
    claim: { destroyedBy: "callback" },
    services: {
      control: recordingControl(releaseCalls),
      logger: {
        error: (value) => logs.push(String(value)),
        log: (value) => logs.push(String(value)),
      },
    },
  });
  const outcome = await runRunnerRegistryAlarm(
    productionTestEnv,
    registry,
    services,
  );
  return Response.json({ logs, outcome, releaseCalls });
}

async function productionAlarmRetryResponse() {
  const events = [];
  let cleanupClaimOutstanding = false;
  const { runner, registry, services } = createProductionStubs({
    events,
    runner: {
      sandboxId: "runner-alarm-retry",
      runnerName: "cloudflare-alarm-retry",
      state: "destroying",
      cleanupRequestedBy: "callback",
      revision: 1,
    },
    registry: {
      async claimNextDueCleanup() {
        if (cleanupClaimOutstanding) {
          return null;
        }
        cleanupClaimOutstanding = true;
        events.push("claimed");
        return {
          cleanupToken: `alarm-token-${events.length}`,
          destroyedBy: "callback",
          runner,
        };
      },
      async settleCleanupClaim(_sandboxId, _token, settlement) {
        cleanupClaimOutstanding = false;
        events.push(
          settlement === "complete"
            ? "marked-destroyed"
            : "released-for-retry",
        );
        return true;
      },
    },
    services: {
      reconciliationSandbox: () => ({ destroy: async () => undefined }),
    },
  });
  let firstError;
  try {
    await runRunnerRegistryAlarm(productionTestEnv, registry, {
      ...services,
      waitForSandboxDestroy: async () => {
        throw new Error("simulated interrupted destroy");
      },
    });
  } catch (error) {
    firstError = {
      message: error instanceof Error ? error.message : String(error),
      phase: error.phase,
    };
  }
  const second = await runRunnerRegistryAlarm(productionTestEnv, registry, {
    ...services,
    waitForSandboxDestroy: async (destroyPromise) => destroyPromise,
  });
  return Response.json({ events, firstError, second });
}

async function productionAlarmDestroyTimeoutResponse() {
  const events = [];
  const releaseCalls = [];
  const { registry, services } = createProductionStubs({
    events,
    runner: {
      sandboxId: "runner-alarm-destroy-timeout",
      runnerName: "cloudflare-alarm-destroy-timeout",
      state: "destroying",
      cleanupRequestedBy: "callback",
      revision: 1,
    },
    claim: { destroyedBy: "callback" },
    registry: {
      async settleCleanupClaim(_sandboxId, _token, settlement) {
        events.push(`claim-${settlement}`);
        return true;
      },
    },
    services: {
      control: recordingControl(releaseCalls),
      reconciliationSandbox: () => ({}),
      beginSandboxDestroy: () => Promise.resolve(),
      waitForSandboxDestroy: async () => {
        throw new SandboxDestroyTimeout(
          "simulated bounded sandbox destroy timeout",
        );
      },
    },
  });
  try {
    await runRunnerRegistryAlarm(productionTestEnv, registry, services);
    throw new Error("The simulated destroy timeout did not escape");
  } catch (error) {
    return Response.json({
      error: {
        causeName: error?.cause?.constructor?.name,
        message: error instanceof Error ? error.message : String(error),
        phase: error?.phase,
      },
      events,
      releaseCalls,
    });
  }
}

async function productionAlarmReleaseFailureResponse() {
  const releaseCalls = [];
  const logs = [];
  const { registry, services } = createProductionStubs({
    runner: {
      sandboxId: "runner-alarm-release-failure",
      runnerName: "cloudflare-alarm-release-failure",
      cleanupRequestedBy: "callback",
    },
    claim: { destroyedBy: "callback" },
    services: {
      control: recordingControl(
        releaseCalls,
        new Error("simulated reservation release failure"),
      ),
      logger: {
        error: (value) => logs.push(String(value)),
        log: (value) => logs.push(String(value)),
      },
    },
  });
  const outcome = await runRunnerRegistryAlarm(
    productionTestEnv,
    registry,
    services,
  );
  return Response.json({ logs, outcome, releaseCalls });
}

async function productionReconcileBusyRaceResponse() {
  const events = [];
  const releaseCalls = [];
  const { runner, registry, services } = createProductionStubs({
    events,
    runner: {
      sandboxId: "runner-busy-race",
      runnerName: "cloudflare-busy-race",
      githubRunnerName: "cloudflare-busy-race",
      correlationId: "busy-race",
      createdAt: "2026-08-20T12:00:00.000Z",
      state: "online",
      cleanupStartedAt: null,
      reconcileToken: null,
      cleanupDueAt: "2026-08-20T13:00:00.000Z",
      cleanupRequestedBy: null,
      destroyedAt: null,
      destroyedBy: null,
      revision: 0,
    },
    registry: {
      async listActiveBefore() {
        return [runner];
      },
      async claimForReconcile() {
        events.push("claimed");
        return { claimed: true, reason: "claimed" };
      },
      async postponeBusyCleanup() {
        events.push("busy-claim-released");
        return {
          postponed: true,
          forcedBusyExit: false,
          busySinceMs: null,
          busyAgeMs: null,
        };
      },
    },
    services: {
      now: () => 1_776_949_200_000,
      randomUUID: () => "reconcile-token",
      listRepositoryRunners: async () => [{
        id: 1,
        name: "cloudflare-busy-race",
        status: "online",
        busy: false,
      }],
      findRepositoryRunnerByName: async () => ({
        outcome: "registration-found",
        runnerId: 1,
        runnerName: "cloudflare-busy-race",
        status: "online",
        busy: true,
      }),
      reconciliationSandbox: () => {
        events.push("sandbox-accessed");
        return { destroy: async () => undefined };
      },
      control: recordingControl(releaseCalls),
    },
  });
  const summary = await reconcileRunners(
    new Request("https://example.test/reconcile", {
      method: "POST",
      body: "{}",
    }),
    productionTestEnv,
    {},
    { ...services, registry },
  );
  return Response.json({ events, releaseCalls, summary });
}

async function productionReconcileAuthoritativeBusyListingResponse() {
  const claimCalls = [];
  const deletedRunnerIds = [];
  const destroyedSandboxIds = [];
  const liveLookupNames = [];
  const releaseCalls = [];
  const listedRunnerNames = [];
  const { runner, registry, services } = createProductionStubs({
    runner: {
      sandboxId: "runner-authoritative-busy-listing",
      runnerName:
        "cloudflare-00000000-0000-4000-8000-000000000701",
      githubRunnerName: "cloudflare-74-4503599627370701",
      correlationId: "authoritative-busy-listing",
      repository: "example/authoritative-busy-listing",
      createdAt: "2026-08-20T12:00:00.000Z",
      state: "online",
      cleanupStartedAt: null,
      reconcileToken: null,
      cleanupDueAt: "2026-08-20T13:00:00.000Z",
      cleanupRequestedBy: null,
      destroyedAt: null,
      destroyedBy: null,
      revision: 0,
    },
    registry: {
      async listActiveBefore() {
        return { runners: [runner], hasMore: false };
      },
      async claimForReconcile(sandboxId) {
        claimCalls.push(sandboxId);
        return { claimed: true, reason: "claimed" };
      },
    },
    services: {
      now: () => 1_776_949_200_000,
      randomUUID: () => "authoritative-busy-listing-token",
      async listRepositoryRunners() {
        const runners = [{
          id: 701,
          name: runner.githubRunnerName,
          status: "online",
          busy: true,
        }];
        listedRunnerNames.push(...runners.map(({ name }) => name));
        return runners;
      },
      async findRepositoryRunnerByName(
        _scope,
        _token,
        runnerName,
      ) {
        liveLookupNames.push(runnerName);
        return {
          outcome: "registration-found",
          runnerId: 701,
          runnerName,
          status: "offline",
          busy: false,
        };
      },
      async deleteRepositoryRunner(_scope, _token, runnerId) {
        deletedRunnerIds.push(runnerId);
        return "deleted";
      },
      reconciliationSandbox(_env, sandboxId) {
        return {
          async destroy() {
            destroyedSandboxIds.push(sandboxId);
          },
        };
      },
      control: recordingControl(releaseCalls),
    },
  });
  const summary = await reconcileRunners(
    new Request("https://example.test/reconcile", {
      method: "POST",
      body: "{}",
    }),
    productionTestEnv,
    {},
    { ...services, registry },
  );
  return Response.json({
    claimCalls,
    deletedRunnerIds,
    destroyedSandboxIds,
    listedRunnerNames,
    liveLookupNames,
    releaseCalls,
    summary,
  });
}

async function productionReconcileRepositoriesResponse() {
  const repositories = [
    "example/runner-test",
    "example/second-repository",
  ];
  const candidates = repositories.map((repository, index) => ({
    sandboxId: `runner-repository-${index + 1}`,
    runnerName: `cloudflare-repository-${index + 1}`,
    githubRunnerName: `cloudflare-repository-${index + 1}`,
    correlationId: `repository-${index + 1}`,
    repository,
    createdAt: "2026-08-20T12:00:00.000Z",
    state: "online",
    cleanupStartedAt: null,
    cleanupDueAt: "2026-08-20T13:00:00.000Z",
    cleanupRequestedBy: null,
    destroyedAt: null,
    destroyedBy: null,
    revision: 0,
  }));
  const listCalls = [];
  const registry = {
    async listActiveBefore() {
      return { runners: candidates, hasMore: false };
    },
    async claimForReconcile() {
      throw new Error("a busy repository candidate must not be claimed");
    },
  };
  const summary = await reconcileRunners(
    new Request("https://example.test/reconcile", {
      method: "POST",
      body: "{}",
    }),
    productionTestEnv,
    {},
    {
      registry,
      now: () => 1_776_949_200_000,
      async listRepositoryRunners(scope) {
        listCalls.push(scope.repository);
        const candidate = candidates.find(
          (runner) => runner.repository === scope.repository,
        );
        return [{
          id: listCalls.length,
          name: candidate.runnerName,
          status: "online",
          busy: true,
        }];
      },
    },
  );
  return Response.json({ listCalls, summary });
}

async function productionReconcileOrganizationResponse(request) {
  const listingFails = new URL(request.url).searchParams.has("failure");
  const candidates = [
    "example/runner-test",
    "example/second-repository",
    "example/third-repository",
  ].map((repository, index) => ({
    sandboxId: `runner-organization-${index + 1}`,
    runnerName: `cloudflare-2-${index + 1}`,
    githubRunnerName: `cloudflare-2-${index + 1}`,
    correlationId: `organization-${index + 1}`,
    repository,
    createdAt: "2026-08-20T12:00:00.000Z",
    state: "online",
    cleanupStartedAt: null,
    cleanupDueAt: "2026-08-20T13:00:00.000Z",
    cleanupRequestedBy: null,
    destroyedAt: null,
    destroyedBy: null,
    revision: 0,
  }));
  const listCalls = [];
  const registry = {
    async listActiveBefore() {
      return { runners: candidates, hasMore: false };
    },
    async claimForReconcile() {
      throw new Error("a busy organization candidate must not be claimed");
    },
  };
  const summary = await reconcileRunners(
    new Request("https://example.test/reconcile", {
      method: "POST",
      body: "{}",
    }),
    {
      ...productionTestEnv,
      GITHUB_RUNNER_SCOPE: "organization",
    },
    {},
    {
      registry,
      now: () => 1_776_949_200_000,
      async listRepositoryRunners(scope) {
        listCalls.push(scope);
        if (listingFails) {
          throw new Error("simulated organization listing failure");
        }
        return candidates.map((candidate, index) => ({
          id: index + 1,
          name: candidate.runnerName,
          status: "online",
          busy: true,
        }));
      },
    },
  );
  return Response.json({
    listCalls,
    reconcileSubrequestBudget: RECONCILE_SUBREQUEST_BUDGET,
    summary,
  });
}

async function productionReconcileListingConcurrencyResponse() {
  const repositoryCount = WORKER_SIMULTANEOUS_CONNECTION_LIMIT + 1;
  const candidates = Array.from({ length: repositoryCount }, (_, index) => ({
    sandboxId: `runner-listing-concurrency-${index}`,
    runnerName: `cloudflare-listing-concurrency-${index}`,
    githubRunnerName: `cloudflare-listing-concurrency-${index}`,
    correlationId: `listing-concurrency-${index}`,
    repository: `example/listing-concurrency-${index}`,
    createdAt: "2026-08-20T12:00:00.000Z",
    state: "online",
    cleanupStartedAt: null,
    cleanupDueAt: "2026-08-20T13:00:00.000Z",
    cleanupRequestedBy: null,
    destroyedAt: null,
    destroyedBy: null,
    revision: 0,
  }));
  let activeListings = 0;
  let listCalls = 0;
  let maxActiveListings = 0;
  const registry = {
    async listActiveBefore() {
      return { runners: candidates, hasMore: false };
    },
    async claimForReconcile() {
      throw new Error("a busy repository candidate must not be claimed");
    },
  };
  const summary = await reconcileRunners(
    new Request("https://example.test/reconcile", {
      method: "POST",
      body: "{}",
    }),
    productionTestEnv,
    {},
    {
      registry,
      now: () => 1_776_949_200_000,
      async listRepositoryRunners(scope) {
        activeListings += 1;
        listCalls += 1;
        maxActiveListings = Math.max(maxActiveListings, activeListings);
        await Promise.resolve();
        activeListings -= 1;
        const candidate = candidates.find(
          (runner) => runner.repository === scope.repository,
        );
        return [{
          id: listCalls,
          name: candidate.runnerName,
          status: "online",
          busy: true,
        }];
      },
    },
  );
  return Response.json({
    connectionLimit: WORKER_SIMULTANEOUS_CONNECTION_LIMIT,
    listCalls,
    maxActiveListings,
    repositoryCount,
    summary,
  });
}

async function productionReconcileClaimFailureResponse() {
  const candidates = ["before", "failed", "after"].map((position) => ({
    sandboxId: `runner-claim-${position}`,
    runnerName: `cloudflare-claim-${position}`,
    githubRunnerName: `cloudflare-claim-${position}`,
    correlationId: `claim-${position}`,
    repository: "example/claim-failure",
    createdAt: "2026-08-20T12:00:00.000Z",
    state: "online",
    cleanupStartedAt: null,
    cleanupDueAt: "2026-08-20T13:00:00.000Z",
    cleanupRequestedBy: null,
    destroyedAt: null,
    destroyedBy: null,
    revision: 0,
  }));
  const claimCalls = [];
  const releaseCalls = [];
  const registry = {
    async listActiveBefore() {
      return { runners: candidates, hasMore: false };
    },
    async claimForReconcile(sandboxId) {
      claimCalls.push(sandboxId);
      if (sandboxId === "runner-claim-failed") {
        throw new Error("simulated registry claim rejection");
      }
      return { claimed: true, reason: "claimed" };
    },
    async settleCleanupClaim() {
      return true;
    },
  };
  const summary = await reconcileRunners(
    new Request("https://example.test/reconcile", {
      method: "POST",
      body: "{}",
    }),
    productionTestEnv,
    {},
    {
      registry,
      now: () => 1_776_949_200_000,
      randomUUID: () => "reconcile-claim-token",
      listRepositoryRunners: async () => [],
      findRepositoryRunnerByName: async (_repository, _token, runnerName) => ({
        outcome: "registration-not-found",
        runnerName,
      }),
      reconciliationSandbox: () => ({}),
      beginSandboxDestroy: () => Promise.resolve(),
      waitForSandboxDestroy: async (destroyPromise) => destroyPromise,
      control: recordingControl(releaseCalls),
    },
  );
  return Response.json({ claimCalls, releaseCalls, summary });
}

async function productionReconcileListingPageLimitResponse() {
  runnerListingPageLimitFetches = 0;
  const candidate = {
    sandboxId: "runner-listing-page-limit",
    runnerName: "cloudflare-listing-page-limit",
    correlationId: "listing-page-limit",
    repository: "example/listing-page-limit",
    createdAt: "2026-08-20T12:00:00.000Z",
    state: "online",
    cleanupStartedAt: null,
    cleanupDueAt: "2026-08-20T13:00:00.000Z",
    cleanupRequestedBy: null,
    destroyedAt: null,
    destroyedBy: null,
    revision: 0,
  };
  let claimCalls = 0;
  const registry = {
    async listActiveBefore() {
      return { runners: [candidate], hasMore: false };
    },
    async claimForReconcile() {
      claimCalls += 1;
      return { claimed: true, reason: "claimed" };
    },
  };
  const summary = await reconcileRunners(
    new Request("https://example.test/reconcile", {
      method: "POST",
      body: "{}",
    }),
    productionTestEnv,
    {},
    {
      registry,
      now: () => 1_776_949_200_000,
    },
  );
  return Response.json({
    claimCalls,
    pageLimit: RECONCILE_LISTING_PAGINATION_RESERVE + 1,
    reconcileSubrequestBudget: RECONCILE_SUBREQUEST_BUDGET,
    runnerListingPageLimitFetches,
    summary,
  });
}

function reconcileBudgetCandidate(index) {
  return {
    sandboxId: `runner-budget-${String(index).padStart(3, "0")}`,
    runnerName: `cloudflare-sandbox-budget-${String(index).padStart(3, "0")}`,
    githubRunnerName: `cloudflare-budget-${String(index).padStart(3, "0")}`,
    correlationId: `budget-${index}`,
    repository: `example/reconcile-${String(index % 20).padStart(2, "0")}`,
    createdAt: "2026-08-20T12:00:00.000Z",
    createdAtMs: 1_776_940_800_000 + index,
    state: "online",
    cleanupStartedAt: null,
    cleanupDueAt: "2026-08-20T13:00:00.000Z",
    cleanupRequestedBy: null,
    destroyedAt: null,
    destroyedBy: null,
    revision: 0,
  };
}

async function productionReconcileBudgetResponse(
  ignoreCandidateLimit,
  exerciseListingBudget = false,
) {
  const fundedRepositoryCount = Math.floor(
    (
      RECONCILE_SUBREQUEST_BUDGET -
      RECONCILE_REGISTRY_READ_SUBREQUESTS -
      RECONCILE_LISTING_PAGINATION_RESERVE
    ) / RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING,
  );
  const listingBudgetCandidateCount =
    Math.floor(
      (
        RECONCILE_SUBREQUEST_BUDGET -
        RECONCILE_LISTING_PAGINATION_RESERVE
      ) / RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING,
    ) + 1;
  // Shipped arithmetic: (869 * 1) + 32 = 901, so the listing pre-charge
  // exceeds 900 while the remaining budget funds only 867 repositories.
  const distinctCandidateRepositories = exerciseListingBudget
    ? listingBudgetCandidateCount
    : 20;
  const candidates = Array.from(
    { length: exerciseListingBudget ? listingBudgetCandidateCount : 300 },
    (_, index) => ({
      ...reconcileBudgetCandidate(index),
      ...(exerciseListingBudget
        ? {
            repository:
              `example/listing-budget-${String(index).padStart(3, "0")}`,
          }
        : {}),
    }),
  );
  const authoritativeRunnerNames = new Set(
    candidates.map((candidate) => candidate.githubRunnerName),
  );
  const multiPageRepository = exerciseListingBudget
    ? candidates[fundedRepositoryCount - 1].repository
    : undefined;
  const calls = Object.fromEntries([
    "listActiveBefore",
    "claimForReconcile",
    "settleCleanupClaim",
    "postponeBusyCleanup",
    "retryCleanupClaim",
    "listRepositoryRunners",
    "findRepositoryRunnerByName",
    "deleteRepositoryRunner",
    "reconciliationSandbox",
    "beginSandboxDestroy",
    "waitForSandboxDestroy",
    "releaseBySandbox",
  ].map((name) => [name, 0]));
  let observedSubrequests = 0;
  let multiPageRepositoryListingSubrequests = 0;
  const runnerIdsByName = new Map();
  const record = (name, cost) => {
    calls[name] += 1;
    observedSubrequests += cost;
  };
  const registry = {
    async listActiveBefore(
      _cutoffMs,
      limit = RECONCILE_CANDIDATE_PAGE_SIZE,
    ) {
      record("listActiveBefore", 1);
      return ignoreCandidateLimit
        ? { runners: candidates, hasMore: false }
        : {
            runners: candidates.slice(0, limit),
            hasMore: candidates.length > limit,
          };
    },
    async claimForReconcile() {
      record("claimForReconcile", 1);
      return { claimed: true, reason: "claimed" };
    },
    async settleCleanupClaim() {
      record("settleCleanupClaim", 1);
      return true;
    },
    async postponeBusyCleanup() {
      record("postponeBusyCleanup", 1);
      return {
        postponed: true,
        forcedBusyExit: false,
        busySinceMs: null,
        busyAgeMs: null,
      };
    },
    async retryCleanupClaim() {
      record("retryCleanupClaim", 1);
      return true;
    },
  };
  const summary = await reconcileRunners(
    new Request("https://example.test/reconcile", {
      method: "POST",
      body: "{}",
    }),
    productionTestEnv,
    {},
    {
      registry,
      now: () => 1_776_949_200_000,
      randomUUID: () => "reconcile-budget-token",
      async listRepositoryRunners(scope) {
        const repository = scope.repository;
        let runners = [];
        if (exerciseListingBudget && repository === multiPageRepository) {
          runners = Array.from(
            {
              length:
                RUNNER_LIST_PAGE_SIZE *
                RECONCILE_LISTING_PAGINATION_RESERVE,
            },
            (_, index) => ({ name: `overflow-runner-${index}` }),
          );
        } else if (
          !exerciseListingBudget &&
          repository === "example/reconcile-00"
        ) {
          runners = Array.from(
            { length: 201 },
            (_, index) => ({ name: `existing-runner-${index}` }),
          );
        }
        const listingSubrequests =
          Math.floor(runners.length / RUNNER_LIST_PAGE_SIZE) + 1;
        if (repository === multiPageRepository) {
          multiPageRepositoryListingSubrequests = listingSubrequests;
        }
        record(
          "listRepositoryRunners",
          listingSubrequests,
        );
        return runners;
      },
      async findRepositoryRunnerByName(_repository, _token, runnerName) {
        record("findRepositoryRunnerByName", 1);
        if (!authoritativeRunnerNames.has(runnerName)) {
          throw new Error(`unexpected GitHub runner name: ${runnerName}`);
        }
        if (!runnerIdsByName.has(runnerName)) {
          runnerIdsByName.set(runnerName, runnerIdsByName.size + 1);
        }
        return {
          outcome: "registration-found",
          runnerId: runnerIdsByName.get(runnerName),
          runnerName,
          status: "offline",
          busy: false,
        };
      },
      async deleteRepositoryRunner() {
        record("deleteRepositoryRunner", 1);
        return "deleted";
      },
      reconciliationSandbox() {
        record("reconciliationSandbox", 0);
        return {};
      },
      beginSandboxDestroy() {
        record("beginSandboxDestroy", 1);
        return Promise.resolve();
      },
      async waitForSandboxDestroy(destroyPromise) {
        record("waitForSandboxDestroy", 0);
        await destroyPromise;
      },
      // The release is a Durable Object subrequest. Counting it here proves
      // that a successful candidate stays inside
      // RECONCILE_SUBREQUESTS_PER_CANDIDATE rather than exceeding it.
      control: {
        async releaseBySandbox({ sandboxId }) {
          record("releaseBySandbox", 1);
          return {
            released: true,
            replayed: false,
            reservationId: `reservation-${sandboxId}`,
          };
        },
      },
    },
  );
  return Response.json({
    calls,
    distinctCandidateRepositories,
    fundedRepositoryCount,
    multiPageRepositoryListingSubrequests,
    observedSubrequests,
    reconcileCandidatePageSize: RECONCILE_CANDIDATE_PAGE_SIZE,
    reconcileSubrequestBudget: RECONCILE_SUBREQUEST_BUDGET,
    summary,
  });
}

async function productionOrphanRepositoryCleanupResponse() {
  const repository = "example/second-repository";
  const calls = [];
  const nowMs = 1_800_000_000_000;
  const runner = {
    sandboxId: "runner-orphan-repository",
    runnerName: "cloudflare-orphan-repository",
    githubRunnerName: "cloudflare-github-orphan-repository",
    repository,
    orphanInstanceId: "a".repeat(64),
    state: "destroying",
    cleanupDueAt: new Date(nowMs + 90_000).toISOString(),
    cleanupRequestedBy: "orphan",
    revision: 1,
  };
  let cleanupClaimOutstanding = false;
  const registry = {
    async claimNextDueCleanup() {
      if (cleanupClaimOutstanding) {
        return null;
      }
      cleanupClaimOutstanding = true;
      return {
        cleanupToken: "orphan-repository-token",
        destroyedBy: "orphan",
        runner,
      };
    },
    async revalidateOrphanCleanupClaim() {
      return true;
    },
    async settleCleanupClaim() {
      cleanupClaimOutstanding = false;
      return true;
    },
  };
  const outcome = await runRunnerRegistryAlarm(
    productionTestEnv,
    registry,
    {
      now: () => nowMs,
      async findRepositoryRunnerByName(
        candidateScope,
        _token,
        githubRunnerName,
      ) {
        calls.push({
          operation: "find",
          repository: candidateScope.repository,
          runnerName: githubRunnerName,
        });
        return {
          outcome: "registration-found",
          runnerId: 901,
          runnerName: runner.runnerName,
          status: "offline",
          busy: false,
        };
      },
      async deleteRepositoryRunner(candidateScope, _token, runnerId) {
        calls.push({
          operation: "delete",
          repository: candidateScope.repository,
          runnerId,
        });
        return "deleted";
      },
      reconciliationSandbox: () => ({
        destroy: async () => undefined,
      }),
    },
  );
  return Response.json({ calls, outcome });
}

function productionCallbackResponse(sandboxId, claimed, reason) {
  const { registry, services } = createProductionStubs({
    registry: {
      async beginCallbackCleanup() {
        return { claimed, reason };
      },
    },
    services: { authenticateCleanup: async () => true },
  });
  return destroyCompletedRunner(
    new Request(`https://example.test/runners/${sandboxId}`, {
      method: "DELETE",
    }),
    productionTestEnv,
    {},
    sandboxId,
    { authenticateCleanup: services.authenticateCleanup, registry },
  );
}

const PRODUCTION_PATH_HANDLERS = Object.freeze({
  "/production-runner-scope": productionRunnerScopeResponse,
  "/production-scoped-cleanup": productionScopedCleanupResponse,
  "/production-alarm-cleanup": productionAlarmCleanupResponse,
  "/production-alarm-destroy-timeout":
    productionAlarmDestroyTimeoutResponse,
  "/production-alarm-release-failure":
    productionAlarmReleaseFailureResponse,
  "/production-alarm-reservation-release":
    productionAlarmReservationReleaseResponse,
  "/production-alarm-retry": productionAlarmRetryResponse,
  "/production-alarm-orphan-lease": () =>
    productionAlarmOrphanControl("lease"),
  "/production-alarm-orphan-delete-ownership": () =>
    productionAlarmOrphanControl("delete-ownership"),
  "/production-alarm-orphan-destroy-ownership": () =>
    productionAlarmOrphanControl("destroy-ownership"),
  "/production-alarm-orphan-busy": () =>
    productionAlarmOrphanControl("busy"),
  "/production-alarm-orphan-online": () =>
    productionAlarmOrphanControl("online"),
  "/production-reconcile-busy-race": productionReconcileBusyRaceResponse,
  "/production-reconcile-authoritative-busy-listing":
    productionReconcileAuthoritativeBusyListingResponse,
  "/production-reconcile-repositories":
    productionReconcileRepositoriesResponse,
  "/production-reconcile-organization":
    productionReconcileOrganizationResponse,
  "/production-reconcile-listing-concurrency":
    productionReconcileListingConcurrencyResponse,
  "/production-reconcile-claim-failure":
    productionReconcileClaimFailureResponse,
  "/production-reconcile-listing-page-limit":
    productionReconcileListingPageLimitResponse,
  "/production-reconcile-budget": () =>
    productionReconcileBudgetResponse(false),
  "/production-reconcile-budget-ignored-limit": () =>
    productionReconcileBudgetResponse(true),
  "/production-reconcile-listing-budget": () =>
    productionReconcileBudgetResponse(true, true),
  "/production-orphan-repository-cleanup":
    productionOrphanRepositoryCleanupResponse,
  "/production-callback-scheduled": () =>
    productionCallbackResponse(
      "runner-callback-scheduled",
      true,
      "scheduled",
    ),
  "/production-callback-contention": () =>
    productionCallbackResponse(
      "runner-callback-contention",
      false,
      "contended",
    ),
  "/production-orphan-claim-clock": productionOrphanClaimClockResponse,
});

async function productionPathResponse(request, env, ctx) {
  productionTestEnv.AutopilotControl = env.AutopilotControl;
  const url = new URL(request.url);
  const handler = PRODUCTION_PATH_HANDLERS[url.pathname];
  if (handler !== undefined) {
    return handler(request, env, ctx);
  }
  const orphanDestroyMatch =
    /^\/operator\/orphans\/([^/]+)\/destroy$/.exec(url.pathname);
  if (orphanDestroyMatch !== null) {
    return productionOrphanDestroyResponse(
      request,
      env,
      ctx,
      url,
      orphanDestroyMatch[1],
    );
  }
  const orphanReclaimMatch =
    /^\/operator\/orphans\/([^/]+)\/reclaim$/.exec(url.pathname);
  if (orphanReclaimMatch !== null) {
    return productionOrphanReclaimResponse(
      request,
      env,
      ctx,
      url,
      orphanReclaimMatch[1],
    );
  }
  return null;
}
function getRegistry(request, env) {
  const registryName = new URL(request.url).searchParams.get("registry");
  if (registryName === null) {
    throw new Error("The registry query parameter is required");
  }

  return env.RunnerRegistry.get(env.RunnerRegistry.idFromName(registryName));
}

function getTestSandbox(env, sandboxId) {
  return env.Sandbox.get(env.Sandbox.idFromName(sandboxId));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const productionResponse = await productionPathResponse(request, env, ctx);
    if (productionResponse !== null) {
      return productionResponse;
    }
    const registry = getRegistry(request, env);

    try {
      if (request.method === "GET" && url.pathname === "/runners") {
        const cursor = decodeRunnerCursor(url.searchParams.get("cursor"));
        return Response.json(await registry.listRunners(cursor));
      }

      const callbackMatch = /^\/runners\/([^/]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && callbackMatch !== null) {
        return destroyCompletedRunner(
          request,
          env,
          ctx,
          decodeURIComponent(callbackMatch[1]),
          {
            authenticateCleanup: async () => true,
            registry,
            ...(url.searchParams.has("nowMs")
              ? { now: () => Number(url.searchParams.get("nowMs")) }
              : {}),
          },
        );
      }

      const body = await request.json();
      switch (url.pathname) {
        case "/alarm-cleanup-batch":
          return Response.json(
            await registry.invokeAlarmCleanupBatchScenario(body),
          );
        case "/record-starting":
          return Response.json(await registry.recordStarting(body));
        case "/record-starting-with-errors":
          return Response.json(await registry.recordStartingWithErrors(body));
        case "/record-online":
          return Response.json(await registry.recordOnline(body.record));
        case "/record-callback-cleanup":
          return Response.json(
            await registry.recordCallbackCleanup(
              body.record,
              body.cleanupStartedAt,
            ),
          );
        case "/record-abandoned-claim":
          return Response.json(
            await registry.recordAbandonedClaim(
              body.record,
              body.claimAtMs,
            ),
          );
        case "/repository-cleanup": {
          await registry.recordStarting(body.record);
          const calls = [];
          const outcome = await runRunnerRegistryAlarm(env, registry, {
            now: () => body.nowMs,
            async findRepositoryRunnerByName(scope) {
              calls.push({ operation: "find", repository: scope.repository });
              return {
                outcome: "registration-not-found",
                runnerName: body.record.runnerName,
              };
            },
            reconciliationSandbox: () => ({
              destroy: async () => undefined,
            }),
          });
          return Response.json({ calls, outcome });
        }
        case "/seed-terminal-rows":
          await registry.seedTerminalRows(body);
          return new Response(null, { status: 204 });
        case "/seed-active-rows":
          await registry.seedActiveRows(body);
          return new Response(null, { status: 204 });
        case "/list-active-before":
          return Response.json(
            await registry.listActiveBefore(body.cutoffMs, body.limit),
          );
        case "/seed-invalid-active-row":
          await registry.seedInvalidActiveRow(
            body.sandboxId,
            body.cleanupDueAtMs,
          );
          return new Response(null, { status: 204 });
        case "/seed-invalid-terminal-row":
          await registry.seedInvalidTerminalRow(body.sandboxId);
          return new Response(null, { status: 204 });
        case "/seed-unverified-terminal-row":
          await registry.seedUnverifiedTerminalRow(body.sandboxId);
          return new Response(null, { status: 204 });
        case "/seed-orphan-observations":
          await registry.seedOrphanObservations(body.observations);
          return new Response(null, { status: 204 });
        case "/orphan-observations":
          return Response.json({
            observations: await registry.listOrphanObservations(),
          });
        case "/orphan-reclaim-observations":
          return Response.json({
            observations: await registry.listOrphanReclaimObservations(),
          });
        case "/schema-snapshot":
          return Response.json(await registry.schemaSnapshot(body.sandboxId));
        case "/settle-cleanup-retry-with-errors":
          return Response.json(
            await registry.settleCleanupRetryWithErrors(body),
          );
        case "/busy-cleanup-cycles":
          return Response.json(await registry.invokeBusyCleanupCycles(body));
        case "/failing-alarm-until-park":
          return Response.json(
            await registry.invokeFailingAlarmUntilPark(body),
          );
        case "/claim-for-orphan-cleanup":
          return Response.json(
            await registry.claimOrphanCleanup(
              body.sandboxId,
              body.observedCondition,
              body.expectedRevision,
              body.observedSandboxInstanceId,
              body.cleanupToken,
              body.cleanupStartedAt,
            ),
          );
        case "/revalidate-orphan-claim":
          return Response.json(
            await registry.revalidateOrphanCleanupClaim(
              body.sandboxId,
              body.cleanupToken,
              body.checkedAtMs,
              body.observedSandboxInstanceId,
            ),
          );
        case "/mark-online":
          if (!(await registry.markOnline(body.sandboxId))) {
            return Response.json(
              {
                error: `Runner registry row changed before ${body.sandboxId} became online`,
              },
              { status: 409 },
            );
          }
          return new Response(null, { status: 204 });
        case "/advance-revision":
          return Response.json({
            revision: await registry.advanceRevision(body.sandboxId),
          });
        case "/begin-callback-cleanup":
          return Response.json(
            await registry.beginCallbackCleanup(
              body.sandboxId,
              body.cleanupStartedAt,
            ),
          );
        case "/rearm-stalled-cleanup":
          return Response.json(
            await registry.rearmStalledCleanup(
              body.sandboxId,
              body.rearmedAt,
            ),
          );
        case "/claim-for-reconcile":
          return Response.json(
            await registry.claimForReconcile(
              body.sandboxId,
              body.expectedRevision,
              body.reconcileToken,
              body.cleanupStartedAt,
            ),
          );
        case "/claim-next-due":
          return Response.json(
            await registry.claimNextDueCleanup(body.nowMs),
          );
        case "/postpone-busy-cleanup": {
          const claim = await registry.claimNextDueCleanup(body.nowMs);
          const result = await registry.postponeBusyCleanup(
            claim.runner.sandboxId,
            claim.cleanupToken,
            claim.previousState,
            claim.previousCleanupRequestedBy,
            body.checkedAtMs,
            { busy: true },
          );
          const snapshot = await registry.schemaSnapshot(
            claim.runner.sandboxId,
          );
          return Response.json({ claim, result, row: snapshot.runner });
        }
        case "/release-cleanup-claim":
          return Response.json({
            released: await registry.settleCleanupClaim(
              body.sandboxId,
              body.cleanupToken,
              "retry",
              { settledAtMs: body.releasedAtMs },
            ),
          });
        case "/mark-destroyed":
          if (
            !(await registry.settleCleanupClaim(
              body.sandboxId,
              body.cleanupToken,
              "complete",
              {
                destroyedAt: body.destroyedAt,
                destroyedBy: body.destroyedBy,
              },
            ))
          ) {
            return Response.json(
              { error: "The runner cleanup claim did not match" },
              { status: 409 },
            );
          }
          return new Response(null, { status: 204 });
        case "/configure-sandbox":
          await getTestSandbox(env, body.sandboxId).setDestroyFailures(
            body.destroyFailures,
          );
          return new Response(null, { status: 204 });
        case "/sandbox-status":
          return Response.json(
            await getTestSandbox(env, body.sandboxId).status(),
          );
        case "/alarm":
          await registry.invokeAlarmEntry(body.nowMs, {
            runnerCheckFailure: body.runnerCheckFailure === true,
            pruningFailure: body.pruningFailure === true,
          });
          return new Response(null, { status: 204 });
        case "/alarm-snapshot":
          return Response.json(
            await registry.invokeAlarmSnapshot(
              body.nowMs,
              body.includeObservationCount === true,
            ),
          );
        case "/alarm-pruning-failure": {
          const result = await registry.invokePruningFailureControl(
            body.nowMs,
            body.cleanupSandboxId,
          );
          return Response.json(result, { status: 500 });
        }
        case "/scheduled-alarm":
          return Response.json({ alarmAt: await registry.scheduledAlarm() });
        default:
          return Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
};
