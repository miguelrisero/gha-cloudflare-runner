import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import {
  MessageQueueTokenExpiredError,
  MessageSessionExpiredError,
  RateLimitedError,
  RequestBudgetExhausted,
  ScaleSetNotFoundError,
  ScaleSetRequestError,
  SessionConflictError,
} from "../src/scaleset-client.js";
import { parseScaleSetMessage } from "../src/scaleset-protocol.js";
import {
  AutopilotControl as ProductionAutopilotControl,
  MAX_ACTIVE_RUNNERS,
} from "../src/autopilot-control.js";
import {
  ALARM_WALL_BUDGET_MS,
  ALARM_WORK_BUDGET_MS,
  HEARTBEAT_STALE_MS,
  MAX_DISPATCH_CONCURRENCY,
  MAX_LIVENESS_PROBE_ATTEMPTS,
  MAX_LIVENESS_PROBES_PER_PASS,
  MAX_PACE_BACKOFF_DOUBLINGS,
  MAX_START_PACE_MS,
  POLL_TIMEOUT_MS,
  RECOVERY_BASE_DELAY_MS,
  RECOVERY_MAX_DELAY_MS,
  RECOVERY_MAX_ELAPSED_MS,
  RECOVERY_MAX_ATTEMPTS,
  RUNNER_LIVENESS_PROBE_MIN_AGE_MS,
  START_DEADLINE_MS,
  START_PACE_MS,
  ScaleSetListener as ProductionScaleSetListener,
  pollTimeoutForElapsed,
} from "../src/scaleset-listener.js";
import {
  RunnerRegistry as ProductionRunnerRegistry,
  handleWorkerRequest,
} from "../src/worker.js";

const SESSION_TOKEN = "literal-message-session-token-secret";
const REFRESHED_SESSION_TOKEN = "literal-refreshed-session-token-secret";
const ADMIN_TOKEN = "literal-admin-token-secret";
const APP_JWT = "literal-app-jwt-secret";
const APP_PRIVATE_KEY = "literal-bare-base64-pkcs8-private-key-secret";
const INSTALLATION_TOKEN = "literal-installation-token-secret";
const JIT_CONFIG = "literal-jit-config-secret";
const REFRESHED_ADMIN_TOKEN = "literal-refreshed-admin-token-secret";
const REGISTRATION_TOKEN = "literal-registration-token-secret";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ACTIONS_SERVICE_URL = "https://actions.stub.test/tenant";
const MESSAGE_QUEUE_URL = "https://queue.stub.test/messages";
const TEST_CONFIG = Object.freeze({
  actionsServiceUrl: ACTIONS_SERVICE_URL,
  adminToken: ADMIN_TOKEN,
  adminTokenExpiresAtMs: 8_000_000_000_000_000,
  owner: "listener-owner",
  outageGateCloseUrl: "https://outage-gate.stub.test/close",
  outageGateUrl: "https://outage-gate.stub.test/permit",
  repository: "example/runner-test",
  runnerGroupId: 17,
  scaleSetId: 101,
  scaleSetName: "example-scale-set",
  wave: "wave-1",
  workerUrl: "https://worker.stub.test",
});

function assertSecret(actual, expected) {
  if (actual !== expected) {
    throw new Error("The authentication chain received the wrong secret");
  }
}

function session(token = SESSION_TOKEN) {
  return {
    sessionId: SESSION_ID,
    messageQueueUrl: MESSAGE_QUEUE_URL,
    messageQueueAccessToken: token,
  };
}

function emptyStatistics(overrides = {}) {
  return {
    totalAvailableJobs: 0,
    totalAcquiredJobs: 0,
    totalAssignedJobs: 0,
    totalRunningJobs: 0,
    totalRegisteredRunners: 0,
    totalBusyRunners: 0,
    totalIdleRunners: 0,
    ...overrides,
  };
}

function job(messageType, runnerRequestId, overrides = {}) {
  return {
    messageType,
    runnerRequestId,
    ownerName: "example",
    repositoryName: "runner-test",
    ...overrides,
  };
}

function scaleSetMessage({
  messageId = 1,
  assigned = [],
  completed = [],
  started = [],
  available = [],
  quarantined = [],
  statistics = emptyStatistics(),
} = {}) {
  return {
    messageId,
    statistics,
    jobAvailable: available.map((value) => job("JobAvailable", value)),
    jobAssigned: assigned.map((value) =>
      typeof value === "number" ? job("JobAssigned", value) : value
    ),
    jobStarted: started.map((value) =>
      typeof value === "number" ? job("JobStarted", value) : value
    ),
    jobCompleted: completed.map((value) =>
      typeof value === "number" ? job("JobCompleted", value) : value
    ),
    quarantined,
  };
}

function requestError(message, status = null) {
  return new ScaleSetRequestError(message, { status });
}

function registrationTokenError(authenticationChain) {
  const specification = authenticationChain.fetchRegistrationTokenError;
  if (typeof specification !== "object" || specification === null) {
    return null;
  }
  const context = {
    status: specification.status ?? null,
    method: specification.method ?? null,
    url: specification.url ?? null,
    responseSnippet: specification.responseSnippet ?? "",
  };
  if (specification.rateLimited === true) {
    return new RateLimitedError(context, specification.pauseMs ?? null);
  }
  return new ScaleSetRequestError(
    specification.message ?? "stub registration token request failed",
    context,
  );
}

function operationError(specification) {
  if (
    typeof specification === "object" &&
    specification !== null &&
    specification.type === "request"
  ) {
    return new ScaleSetRequestError(
      specification.message ?? "stub scale set request failed",
      {
        status: specification.status ?? null,
        method: specification.method ?? null,
        url: specification.url ?? null,
        responseSnippet: specification.responseSnippet ?? "",
      },
    );
  }
  if (specification === "401") {
    return new MessageQueueTokenExpiredError("queue token expired", {
      status: 401,
    });
  }
  if (specification === "network") {
    return requestError("stub network response was lost");
  }
  if (specification === "500") {
    return requestError("stub service failure", 500);
  }
  if (specification === "rate-limit") {
    return new RateLimitedError({ status: 429 }, null);
  }
  if (specification === "not-found") {
    return new ScaleSetNotFoundError("stub scale set missing", {
      status: 404,
    });
  }
  if (specification === "session-expired") {
    return new MessageSessionExpiredError("stub message session expired", {
      status: 400,
      method: "PATCH",
      url: `${ACTIONS_SERVICE_URL}/sessions/${SESSION_ID}`,
      responseSnippet: "RunnerScaleSetSessionExpiredException",
    });
  }
  if (specification === "budget-exhausted") {
    return new RequestBudgetExhausted("stub start budget exhausted");
  }
  if (specification === "aborted") {
    const aborted = new Error("stub start aborted");
    aborted.name = "AbortError";
    return aborted;
  }
  return new Error(String(specification));
}

function initialCalls() {
  return {
    activeRunnerCount: 0,
    acquireJobs: 0,
    adminRefresh: 0,
    closeGate: 0,
    localGateClose: 0,
    compensate: 0,
    createAppJwt: 0,
    createSession: 0,
    deleteMessage: 0,
    deleteSession: 0,
    generateJit: 0,
    fetchActionsServiceConnection: 0,
    fetchInstallationToken: 0,
    fetchRegistrationToken: 0,
    getStartByCorrelation: 0,
    getRunnerByName: 0,
    outageGate: 0,
    poll: 0,
    postRunners: 0,
    refreshSession: 0,
    removeRunner: 0,
    reserve: 0,
    scheduleCleanup: 0,
  };
}

function explicitServiceOverrides(specification) {
  const overrides = {};
  if (Object.hasOwn(specification, "enabled")) {
    overrides.enabled = specification.enabled;
  }
  if (Object.hasOwn(specification, "forceSessionCreation")) {
    overrides.forceSessionCreation = specification.forceSessionCreation;
  }
  if (
    Object.hasOwn(specification, "configured") &&
    specification.configured === false
  ) {
    overrides.config = null;
  } else if (Object.hasOwn(specification, "config")) {
    overrides.config = specification.config === null
      ? null
      : { ...TEST_CONFIG, ...specification.config };
  } else if (Object.hasOwn(specification, "configured")) {
    overrides.config = TEST_CONFIG;
  }
  if (
    typeof specification.authenticationChain === "object" &&
    specification.authenticationChain !== null &&
    specification.authenticationChain.omitAppCredentials === true &&
    overrides.config !== null &&
    overrides.config !== undefined
  ) {
    overrides.config = {
      ...overrides.config,
      appId: null,
      installationId: null,
      privateKeyPkcs8: null,
    };
  }
  if (
    typeof specification.authenticationChain === "object" &&
    specification.authenticationChain !== null &&
    specification.authenticationChain.omitScopeInputs === true &&
    overrides.config !== null &&
    overrides.config !== undefined
  ) {
    delete overrides.config.repository;
    delete overrides.config.owner;
    delete overrides.config.scope;
    delete overrides.config.configUrl;
  }
  return overrides;
}

function publicOutbox(row) {
  return {
    runnerRequestId: row.runner_request_id,
    state: row.state,
    runnerName: row.runner_name,
    runnerId: row.runner_id,
    correlationId: row.correlation_id,
    repository: row.repository,
    wave: row.wave,
    reservationId: row.reservation_id,
    reservationReleasedAtMs: row.reservation_released_at_ms,
    settleCheckedAtMs: row.settle_checked_at_ms,
    spawnObserved: row.spawn_observed === 1,
    attempts: row.attempts,
    livenessProbeAttempts: row.liveness_probe_attempts,
    livenessProbedAtMs: row.liveness_probed_at_ms,
    undeliveredCheckedAtMs: row.undelivered_checked_at_ms,
    lastError: row.last_error,
    intentRecordedAtMs: row.intent_recorded_at_ms,
    updatedAtMs: row.updated_at_ms,
    jitConfigPresent: row.jit_config !== null,
  };
}

export class AutopilotControl extends ProductionAutopilotControl {}

export class RunnerRegistry extends ProductionRunnerRegistry {
  async stubNextActiveList(result) {
    await this.ctx.storage.put("harness-next-active-list", result);
  }

  async listActiveBefore(cutoffMs) {
    const result = await this.ctx.storage.get("harness-next-active-list");
    if (result === undefined) {
      return super.listActiveBefore(cutoffMs);
    }
    await this.ctx.storage.delete("harness-next-active-list");
    return result;
  }
}

export class ScaleSetListener extends ProductionScaleSetListener {
  constructor(ctx, env) {
    super(ctx, env);
    this.harnessLogs = [];
    this.lastScenario = null;
  }

  #scenarioServices(specification = {}) {
    const state = {
      alarmTimes: [],
      acquisitionIntentCountsAtStart: [],
      advertisedCapacities: [],
      calls: initialCalls(),
      clockMs: specification.clockMs ?? 1_800_000_000_000,
      compensated: [],
      createSessionIndex: 0,
      deleteMessageIndex: 0,
      deleteSessionRequests: [],
      emittedRecords: [],
      events: [],
      generateJitIndex: 0,
      getRunnerIndex: 0,
      getRunnerRequests: [],
      getStartCorrelations: [],
      grantedIds: [],
      logs: [],
      nowIndex: 0,
      outageGateRequests: [],
      outageGateCloseRequests: [],
      peakDispatch: 0,
      pollIndex: 0,
      pollTimeouts: [],
      postRunnerCorrelations: [],
      postRunnerIds: [],
      refreshIndex: 0,
      registrationTokenError: null,
      removedRunnerIds: [],
      reservationIds: [],
      runningDispatch: 0,
      scheduledCleanup: [],
      scheduledAlarm: specification.scheduledAlarm ?? null,
      startResolvers: [],
    };
    const advance = (field) => {
      const value = specification[field];
      if (Number.isFinite(value)) {
        state.clockMs += value;
      }
    };
    const throwConfigured = (field, index) => {
      const configured = specification[field];
      const value = Array.isArray(configured) ? configured[index] : configured;
      if (value !== undefined && value !== null) {
        if (value === "rate-limit") {
          throw new RateLimitedError(
            { status: 429 },
            specification.retryAfterMs ?? null,
          );
        }
        throw operationError(value);
      }
    };
    const insertCancellation = (runnerRequestId) => {
      this.sql.exec(
        `INSERT OR IGNORE INTO cancellations (
           runner_request_id,
           recorded_at_ms
         ) VALUES (?, ?)`,
        runnerRequestId,
        state.clockMs,
      );
    };
    const stubControl = {
      status: async () => {
        if (specification.controlStatusError !== undefined) {
          throw operationError(specification.controlStatusError);
        }
        const status = {
          localGate: specification.controlGate ?? (
            specification.controlClosed ? "closed" : "open"
          ),
          liveReservationCount: specification.liveReservationCount ?? 0,
        };
        if (!specification.controlStatusMissingMaxCapacity) {
          status.maxCapacity = specification.controlStatusNonFiniteMaxCapacity
            ? Number.NaN
            : specification.maxCapacity ?? (
              specification.controlClosed ? 0 : MAX_ACTIVE_RUNNERS
            );
        }
        return status;
      },
      reserve: async (input) => {
        state.calls.reserve += 1;
        advance("reserveAdvanceMs");
        const reserveError = specification.reserveErrorsByRunner?.[
          String(input.runnerRequestId)
        ];
        if (reserveError === "type-error") {
          throw new TypeError(
            `stub malformed reservation ${input.runnerRequestId}`,
          );
        }
        if (reserveError !== undefined) {
          throw operationError(reserveError);
        }
        if (specification.cancelAt === "after-reserve") {
          insertCancellation(input.runnerRequestId);
        }
        if (specification.reserveRefusal !== undefined) {
          return { reserved: false, reason: specification.reserveRefusal };
        }
        const reservationId = specification.reservationIdsByRunner?.[
          String(input.runnerRequestId)
        ] ?? `reservation-${input.runnerRequestId}`;
        state.reservationIds.push(reservationId);
        return {
          reserved: true,
          replayed: state.reservationIds.filter(
            (value) => value === reservationId,
          ).length > 1,
          reservationId,
          token: `reservation-token-${input.runnerRequestId}`,
          expiresAtMs: input.nowMs + 60_000,
          gateGeneration: 0,
        };
      },
      compensate: async (input) => {
        state.calls.compensate += 1;
        state.compensated.push(input);
        const reservationError =
          specification.compensateErrorsByReservation?.[
            input.reservationId
          ];
        if (reservationError !== undefined && reservationError !== null) {
          throw operationError(reservationError);
        }
        throwConfigured("compensateError", state.calls.compensate - 1);
        if (
          state.calls.compensate === 1 &&
          specification.drainMutationAfterCompensate !== undefined
        ) {
          for (const runnerRequestId of
            specification.drainMutationAfterCompensate.deleted ?? []) {
            this.sql.exec(
              "DELETE FROM dispatch_outbox WHERE runner_request_id = ?",
              runnerRequestId,
            );
          }
          for (const runnerRequestId of
            specification.drainMutationAfterCompensate.terminal ?? []) {
            this.sql.exec(
              `UPDATE dispatch_outbox
               SET state = 'cancelled'
               WHERE runner_request_id = ?`,
              runnerRequestId,
            );
          }
        }
        const configuredResult = Array.isArray(
            specification.compensateResults,
          )
          ? specification.compensateResults[state.calls.compensate - 1]
          : specification.compensateResult;
        return configuredResult ?? { compensated: true };
      },
      closeGate: async () => {
        state.calls.localGateClose += 1;
        return { closed: true, maxCapacity: 0 };
      },
    };
    const realControl = specification.controlName === undefined
      ? null
      : this.env.AutopilotControl.get(
        this.env.AutopilotControl.idFromName(specification.controlName),
      );
    const control = realControl ?? stubControl;

    const services = {
      ...explicitServiceOverrides(specification),
      control,
      now: () => {
        const configured = specification.clockValues?.[state.nowIndex];
        state.nowIndex += 1;
        if (Number.isFinite(configured)) {
          state.clockMs = configured;
        }
        return state.clockMs;
      },
      logger: {
        log: (value) => {
          const record = String(value);
          state.emittedRecords.push(record);
          state.logs.push(record);
          this.harnessLogs.push(record);
        },
        error: (value) => {
          state.logs.push(String(value));
          this.harnessLogs.push(String(value));
        },
      },
      setAlarm: async (atMs) => {
        state.events.push("set-alarm");
        state.alarmTimes.push(atMs);
        state.scheduledAlarm = atMs;
      },
      deleteAlarm: async () => {
        state.events.push("delete-alarm");
        state.scheduledAlarm = null;
      },
      getAlarm: async () => state.scheduledAlarm,
      afterEntryRearm: async () => {
        state.events.push("after-entry");
        if (specification.dropAlarmAfterEntry) {
          state.events.push("drop-alarm-after-entry");
          state.scheduledAlarm = null;
        }
        if (specification.failRecoveryBookkeeping) {
          this.sql.exec(`
            CREATE TRIGGER harness_fail_recovery_bookkeeping
            BEFORE INSERT ON recovery
            BEGIN
              SELECT RAISE(FAIL, 'stub recovery bookkeeping failed');
            END
          `);
        }
        if (specification.throwAfterEntry) {
          throw new Error("stub throw after entry rearm");
        }
      },
      failpoint: async (name) => {
        state.events.push(name);
        if (specification.sqliteFullAt === name) {
          throw new Error("SQLITE_FULL: database or disk is full");
        }
        if (specification.failpoint === name) {
          throw new Error(`stub crash at ${name}`);
        }
      },
      createMessageSession: async () => {
        const index = state.createSessionIndex;
        state.createSessionIndex += 1;
        state.calls.createSession += 1;
        state.events.push("create-session");
        const failure = specification.createSessionErrors?.[index];
        if (failure?.type === "conflict") {
          throw new SessionConflictError(
            { status: 409 },
            failure.owner ?? "listener-owner",
          );
        }
        if (failure !== undefined) {
          if ((failure.type ?? failure) === "rate-limit") {
            throw new RateLimitedError(
              { status: 429 },
              specification.retryAfterMs ?? null,
            );
          }
          throw operationError(failure.type ?? failure);
        }
        return specification.createdSession ?? {
          ...session(),
          statistics: specification.initialStatistics ?? emptyStatistics(),
        };
      },
      refreshAdminConnection: async () => {
        state.calls.adminRefresh += 1;
        state.events.push("refresh-admin");
        throwConfigured("adminRefreshError", state.calls.adminRefresh - 1);
        return specification.adminRefreshConnection ?? {
          actionsServiceUrl: ACTIONS_SERVICE_URL,
          adminToken: REFRESHED_ADMIN_TOKEN,
          adminTokenExpiresAtMs: 8_000_000_000_000_000,
        };
      },
      deleteMessageSession: async (input) => {
        state.calls.deleteSession += 1;
        state.events.push(`delete-session:${input.sessionId}`);
        state.deleteSessionRequests.push({
          actionsServiceUrl: input.actionsServiceUrl,
          adminToken: input.adminToken,
          sessionId: input.sessionId,
        });
        const index = state.calls.deleteSession - 1;
        throwConfigured("deleteSessionError", index);
        const configured = specification.deleteSessionResults;
        const result = Array.isArray(configured)
          ? configured[index]
          : configured;
        return result ?? "deleted";
      },
      refreshMessageSession: async (input) => {
        const index = state.refreshIndex;
        state.refreshIndex += 1;
        state.calls.refreshSession += 1;
        state.events.push("refresh-session");
        throwConfigured("refreshErrors", index);
        return {
          sessionId: input.sessionId,
          messageQueueUrl: MESSAGE_QUEUE_URL,
          messageQueueAccessToken: REFRESHED_SESSION_TOKEN,
        };
      },
      getMessage: async (input) => {
        const index = state.pollIndex;
        state.pollIndex += 1;
        state.calls.poll += 1;
        state.pollTimeouts.push(input.pollTimeoutMs);
        state.advertisedCapacities.push(input.maxCapacity);
        state.events.push(`poll:${input.lastMessageId}`);
        await yieldToEventLoop();
        const poll = specification.polls?.[index];
        if (poll === undefined) {
          state.clockMs += Math.max(
            input.pollTimeoutMs,
            ALARM_WALL_BUDGET_MS - (state.clockMs -
              (specification.clockMs ?? 1_800_000_000_000)),
          );
          return { outcome: "poll-aborted" };
        }
        if (poll.errorMessage !== undefined) {
          throw new Error(poll.errorMessage);
        }
        if (poll.error !== undefined) {
          throw operationError(poll.error);
        }
        state.clockMs += poll.advanceMs ?? input.pollTimeoutMs;
        if (Object.hasOwn(specification, "scaleSetIdAfterPoll")) {
          this.sql.exec(
            `UPDATE listener_state
             SET scale_set_id = ?
             WHERE singleton = 1`,
            specification.scaleSetIdAfterPoll,
          );
        }
        if (poll.outcome === "message") {
          return {
            outcome: "message",
            message: Object.hasOwn(poll, "envelope")
              ? parseScaleSetMessage(poll.envelope)
              : scaleSetMessage(poll.message),
          };
        }
        return { outcome: poll.outcome };
      },
      deleteMessage: async () => {
        const index = state.deleteMessageIndex;
        state.deleteMessageIndex += 1;
        state.calls.deleteMessage += 1;
        state.events.push("delete-message");
        advance("deleteMessageAdvanceMs");
        throwConfigured("deleteMessageErrors", index);
      },
      fetch: async (url, init = {}) => {
        const body = JSON.parse(init.body);
        if (body.action === "close") {
          state.calls.closeGate += 1;
          state.outageGateCloseRequests.push({
            body,
            headers: Object.fromEntries(new Headers(init.headers)),
            method: init.method,
            signalPresent: init.signal instanceof AbortSignal,
            url,
          });
          if (specification.outageGateCloseError !== undefined) {
            throw new Error(specification.outageGateCloseError);
          }
          return new Response(null, {
            status: specification.outageGateCloseStatus ?? 204,
          });
        }
        state.calls.outageGate += 1;
        advance("outageGateAdvanceMs");
        if (specification.outageGateError !== undefined) {
          throw new Error(specification.outageGateError);
        }
        state.outageGateRequests.push({
          body,
          headers: Object.fromEntries(new Headers(init.headers)),
          method: init.method,
          signalPresent: init.signal instanceof AbortSignal,
          url,
        });
        const permit = specification.outageGatePermits?.[
          String(body.runnerRequestId)
        ] ?? {
          permitId: `stub-permit-${body.runnerRequestId}`,
          expiresAtMs: body.expiresAtMs,
          signature: "stub-signature",
        };
        if (Object.hasOwn(specification, "outageGateResponseBody")) {
          const responseBody = specification.outageGateResponseBody;
          return new Response(
            typeof responseBody === "string"
              ? responseBody
              : JSON.stringify(responseBody),
            { status: specification.outageGateStatus ?? 200 },
          );
        }
        return Response.json(permit, {
          status: specification.outageGateStatus ?? 200,
        });
      },
      acquireJobs: async ({ requestIds }) => {
        const index = state.calls.acquireJobs;
        state.calls.acquireJobs += 1;
        state.events.push(`acquire:${requestIds.join(",")}`);
        advance("acquireAdvanceMs");
        throwConfigured("acquireErrors", index);
        const configuredGrants = specification.grants;
        const grants = Array.isArray(configuredGrants?.[0])
          ? configuredGrants[index] ?? requestIds
          : configuredGrants ?? requestIds;
        state.grantedIds.push(...grants);
        return grants;
      },
      getRunnerByName: async (input) => {
        const { name } = input;
        const index = state.getRunnerIndex;
        state.getRunnerIndex += 1;
        state.calls.getRunnerByName += 1;
        state.getRunnerRequests.push({
          actionsServiceUrl: input.actionsServiceUrl,
          adminToken: input.adminToken,
          name,
        });
        state.events.push(`get-runner:${name}`);
        const configured = specification.runnerLookups?.[index];
        if (configured?.error !== undefined) {
          throw operationError(configured.error);
        }
        if (configured === null) {
          return null;
        }
        if (configured === undefined) {
          const started = this.sql.exec(
            `SELECT runner_id
             FROM dispatch_outbox
             WHERE state = 'started'
               AND runner_name = ?
             LIMIT 1`,
            name,
          ).toArray()[0];
          if (started === undefined) {
            return null;
          }
          return {
            id: started.runner_id ?? 700 + index,
            name,
            busy: false,
            status: "online",
          };
        }
        return {
          id: configured.id ?? 700 + index,
          name: configured.name ?? name,
          busy: configured.busy ?? false,
          status: configured.status ?? "online",
          ...(Object.hasOwn(configured, "runnerRequestId")
            ? { runnerRequestId: configured.runnerRequestId }
            : {}),
        };
      },
      removeRunner: async ({ runnerId }) => {
        state.calls.removeRunner += 1;
        state.removedRunnerIds.push(runnerId);
        state.events.push(`remove-runner:${runnerId}`);
        return "removed";
      },
      generateJitRunnerConfig: async ({ name }) => {
        const index = state.generateJitIndex;
        state.generateJitIndex += 1;
        state.calls.generateJit += 1;
        state.events.push(`generate-jit:${name}`);
        advance("jitAdvanceMs");
        const requestId = Number(name.split("-").at(-1));
        const runnerError = specification.jitErrorsByRunner?.[
          String(requestId)
        ];
        if (runnerError !== undefined) {
          throw operationError(runnerError);
        }
        if (specification.cancelAt === "after-jit") {
          insertCancellation(requestId);
        }
        throwConfigured("jitErrors", index);
        return {
          runner: { id: 900 + index, name },
          encodedJITConfig: JIT_CONFIG,
        };
      },
      startRunner: async ({ body, correlationId }) => {
        const acquisitionIntentCount = this.sql.exec(
          `SELECT COUNT(*) AS count
           FROM acquisition_intents
           WHERE runner_request_id = ?`,
          body.runnerRequestId,
        ).toArray()[0]?.count ?? 0;
        state.acquisitionIntentCountsAtStart.push(acquisitionIntentCount);
        state.calls.postRunners += 1;
        state.runningDispatch += 1;
        state.peakDispatch = Math.max(
          state.peakDispatch,
          state.runningDispatch,
        );
        state.postRunnerCorrelations.push(correlationId);
        state.postRunnerIds.push(body.runnerRequestId);
        state.events.push(`post-runner:${body.runnerRequestId}`);
        if (specification.cancelAt === "before-start") {
          insertCancellation(body.runnerRequestId);
        }
        if (specification.startBarrier !== undefined) {
          if (state.runningDispatch === specification.startBarrier) {
            for (const resolve of state.startResolvers.splice(0)) {
              resolve();
            }
          } else {
            await Promise.race([
              new Promise((resolve) => state.startResolvers.push(resolve)),
              new Promise((resolve) => setTimeout(resolve, 250)),
            ]);
          }
        }
        if (specification.startGate === true) {
          await yieldToEventLoop();
        }
        advance("startAdvanceMs");
        const error = specification.startErrors?.[
          state.calls.postRunners - 1
        ];
        if (error !== undefined) {
          state.runningDispatch -= 1;
          throw operationError(error);
        }
        state.runningDispatch -= 1;
        const payload = {
          correlationId,
          runnerName: `worker-runner-${body.runnerRequestId}`,
          sandboxId: `runner-sandbox-${body.runnerRequestId}`,
          reason: specification.startReasons?.[
            state.calls.postRunners - 1
          ] ?? specification.startReason ?? null,
        };
        if (realControl !== null) {
          const started = await realControl.markStartCreated({
            reservationId: body.reservation.reservationId,
            correlationId,
            sandboxId: payload.sandboxId,
          });
          if (!started.started) {
            throw new Error(`stub start mark failed: ${started.reason}`);
          }
          const consumed = await realControl.consume({
            reservationId: body.reservation.reservationId,
            token: body.reservation.token,
            nowMs: state.clockMs,
          });
          if (!consumed.consumed) {
            throw new Error(`stub reservation consume failed: ${consumed.reason}`);
          }
        }
        return {
          status: specification.startStatuses?.[
            state.calls.postRunners - 1
          ] ?? specification.startStatus ?? 202,
          payload,
        };
      },
      getStartByCorrelation: async (correlationId) => {
        const index = state.calls.getStartByCorrelation;
        state.calls.getStartByCorrelation += 1;
        state.getStartCorrelations.push(correlationId);
        const configured = specification.startLookups?.[index];
        if (configured?.error !== undefined) {
          throw operationError(configured.error);
        }
        if (configured !== undefined) {
          if (configured === null) {
            return null;
          }
          return {
            correlationId,
            sandboxId: "runner-reconciled",
            ...configured,
          };
        }
        if (!specification.reconciledStart) {
          return null;
        }
        return {
          correlationId,
          ...(specification.omitReconciledSandboxId
            ? {}
            : {
              sandboxId: specification.reconciledSandboxId ??
                "runner-reconciled",
            }),
          state: "starting",
        };
      },
      activeRunnerCount: async () => {
        const index = state.calls.activeRunnerCount;
        state.calls.activeRunnerCount += 1;
        throwConfigured("activeRunnerCountError", index);
        return specification.activeRunnerCount ?? 0;
      },
      scheduleCleanup: async (sandboxId) => {
        state.calls.scheduleCleanup += 1;
        state.scheduledCleanup.push(sandboxId);
      },
      closeExternalGate: async () => {
        state.calls.closeGate += 1;
      },
    };
    if (
      specification.authenticationChain === true ||
      (
        typeof specification.authenticationChain === "object" &&
        specification.authenticationChain !== null
      )
    ) {
      const authenticationChain = specification.authenticationChain === true
        ? {}
        : specification.authenticationChain;
      delete services.refreshAdminConnection;
      Object.assign(services, {
        createAppJwt: async ({ privateKeyPkcs8 }) => {
          state.calls.createAppJwt += 1;
          assertSecret(privateKeyPkcs8, APP_PRIVATE_KEY);
          return APP_JWT;
        },
        fetchInstallationToken: async ({ appJwt }) => {
          state.calls.fetchInstallationToken += 1;
          assertSecret(appJwt, APP_JWT);
          return INSTALLATION_TOKEN;
        },
        fetchRegistrationToken: async ({ githubToken }) => {
          state.calls.fetchRegistrationToken += 1;
          assertSecret(
            githubToken,
            authenticationChain.expectedGithubToken ?? INSTALLATION_TOKEN,
          );
          const configuredError = registrationTokenError(authenticationChain);
          if (configuredError !== null) {
            state.registrationTokenError = {
              message: configuredError.message,
              name: configuredError.constructor.name,
              status: configuredError.status,
            };
            throw configuredError;
          }
          if (
            Number.isInteger(
              authenticationChain.fetchRegistrationTokenStatus,
            )
          ) {
            throw requestError(
              "stub registration token request failed",
              authenticationChain.fetchRegistrationTokenStatus,
            );
          }
          return REGISTRATION_TOKEN;
        },
        fetchActionsServiceConnection: async ({ registrationToken }) => {
          state.calls.fetchActionsServiceConnection += 1;
          assertSecret(registrationToken, REGISTRATION_TOKEN);
          return {
            actionsServiceUrl: ACTIONS_SERVICE_URL,
            adminToken: REFRESHED_ADMIN_TOKEN,
            adminTokenExpiresAtMs: 8_000_000_000_000_000,
          };
        },
      });
    }
    if (specification.outagePermits !== undefined) {
      services.getOutagePermit = ({ runnerRequestId }) =>
        specification.outagePermits[String(runnerRequestId)] ?? null;
    }
    if (specification.useProductionGateClose === true) {
      delete services.closeExternalGate;
    }
    if (Object.hasOwn(specification, "runnerRegistryActiveResult")) {
      delete services.activeRunnerCount;
    }
    if (specification.useRunnerRegistryActiveList === true) {
      delete services.activeRunnerCount;
    }
    if (specification.useRegistryCorrelationLookup === true) {
      delete services.getStartByCorrelation;
    }
    return { services, state };
  }

  #snapshot(scenarioState) {
    const listener = this.sql.exec(
      `SELECT scale_set_id, scale_set_name, owner, session_id,
              last_message_id, latest_statistics, alarm_generation,
              heartbeat_at_ms, heartbeat_generation, heartbeat_cursor,
              mode, stopped_reason, sqlite_full, scale_up_sequence,
              admission_limit, admission_success_streak,
              admission_limit_changed_at_ms, admission_limited,
              last_start_issued_at_ms, pace_refusal_streak
       FROM listener_state
       WHERE singleton = 1`,
    ).toArray()[0];
    const inbox = this.sql.exec(
      `SELECT message_id, received_at_ms, state, quarantine_reason
       FROM inbox
       ORDER BY message_id`,
    ).toArray();
    const intents = this.sql.exec(
      `SELECT runner_request_id, message_id, state, attempts, redeliveries,
              recorded_at_ms
       FROM acquisition_intents
       ORDER BY runner_request_id`,
    ).toArray();
    const outbox = this.sql.exec(
      "SELECT * FROM dispatch_outbox ORDER BY runner_request_id",
    ).toArray().map(publicOutbox);
    const recoveries = this.sql.exec(
      "SELECT * FROM recovery ORDER BY condition",
    ).toArray();
    const cancellations = this.sql.exec(
      `SELECT runner_request_id, recorded_at_ms
       FROM cancellations
       ORDER BY runner_request_id`,
    ).toArray();
    const exportRecords = this.sql.exec(
      `SELECT id, record, created_at_ms, state
       FROM export_outbox
       ORDER BY id`,
    ).toArray();
    const paceRefusalStreak =
      Number.isSafeInteger(listener.pace_refusal_streak) &&
        listener.pace_refusal_streak >= 0
        ? listener.pace_refusal_streak
        : 0;
    const lastStartIssuedAtMs =
      Number.isSafeInteger(listener.last_start_issued_at_ms) &&
        listener.last_start_issued_at_ms >= 0
        ? listener.last_start_issued_at_ms
        : null;
    return {
      calls: scenarioState?.calls ?? initialCalls(),
      emittedRecords: scenarioState?.emittedRecords ?? [],
      events: scenarioState?.events ?? [],
      logs: scenarioState?.logs ?? [],
      alarmTimes: scenarioState?.alarmTimes ?? [],
      acquisitionIntentCountsAtStart:
        scenarioState?.acquisitionIntentCountsAtStart ?? [],
      scheduledAlarm: scenarioState?.scheduledAlarm ?? null,
      advertisedCapacities: scenarioState?.advertisedCapacities ?? [],
      pollTimeouts: scenarioState?.pollTimeouts ?? [],
      grantedIds: scenarioState?.grantedIds ?? [],
      getStartCorrelations: scenarioState?.getStartCorrelations ?? [],
      getRunnerRequests: scenarioState?.getRunnerRequests ?? [],
      postRunnerCorrelations:
        scenarioState?.postRunnerCorrelations ?? [],
      postRunnerIds: scenarioState?.postRunnerIds ?? [],
      peakDispatch: scenarioState?.peakDispatch ?? 0,
      registrationTokenError: scenarioState?.registrationTokenError ?? null,
      removedRunnerIds: scenarioState?.removedRunnerIds ?? [],
      compensated: scenarioState?.compensated ?? [],
      deleteSessionRequests: scenarioState?.deleteSessionRequests ?? [],
      scheduledCleanup: scenarioState?.scheduledCleanup ?? [],
      outageGateRequests: scenarioState?.outageGateRequests ?? [],
      outageGateCloseRequests:
        scenarioState?.outageGateCloseRequests ?? [],
      listener: {
        scaleSetId: listener.scale_set_id,
        scaleSetName: listener.scale_set_name,
        owner: listener.owner,
        sessionId: listener.session_id,
        cursor: listener.last_message_id,
        latestStatistics: listener.latest_statistics === null
          ? null
          : JSON.parse(listener.latest_statistics),
        scaleUpSequence: listener.scale_up_sequence,
        admissionLimit: listener.admission_limit,
        admissionSuccessStreak: listener.admission_success_streak,
        admissionLimitChangedAtMs: listener.admission_limit_changed_at_ms,
        admissionLimited: listener.admission_limited === 1,
        startPace: {
          paceMs: Math.min(
            MAX_START_PACE_MS,
            START_PACE_MS * 2 ** Math.min(
              paceRefusalStreak,
              MAX_PACE_BACKOFF_DOUBLINGS,
            ),
          ),
          lastStartIssuedAtMs,
          refusalStreak: paceRefusalStreak,
        },
        alarmGeneration: listener.alarm_generation,
        heartbeatAtMs: listener.heartbeat_at_ms,
        heartbeatGeneration: listener.heartbeat_generation,
        heartbeatCursor: listener.heartbeat_cursor,
        mode: listener.mode,
        stoppedReason: listener.stopped_reason,
        sqliteFull: listener.sqlite_full === 1,
      },
      inbox: inbox.map((row) => ({
        messageId: row.message_id,
        receivedAtMs: row.received_at_ms,
        state: row.state,
        quarantineReason: row.quarantine_reason,
      })),
      intents: intents.map((row) => ({
        runnerRequestId: row.runner_request_id,
        messageId: row.message_id,
        state: row.state,
        attempts: row.attempts,
        redeliveries: row.redeliveries,
        recordedAtMs: row.recorded_at_ms,
      })),
      outbox,
      cancellations: cancellations.map((row) => ({
        runnerRequestId: row.runner_request_id,
        recordedAtMs: row.recorded_at_ms,
      })),
      exportRecords: exportRecords.map((row) => ({
        id: row.id,
        record: row.record,
        createdAtMs: row.created_at_ms,
        state: row.state,
      })),
      recoveries: recoveries.map((row) => ({
        condition: row.condition,
        firstFailureAtMs: row.first_failure_at_ms,
        attempts: row.attempts,
        nextAttemptAtMs: row.next_attempt_at_ms,
        exhaustedMarker: row.exhausted_marker,
      })),
    };
  }

  async testAlarm(specification = {}) {
    const scenario = this.#scenarioServices(specification);
    this.lastScenario = scenario.state;
    let result;
    let error = null;
    let errorCauseName = null;
    let errorCauseStatus = null;
    let errorName = null;
    let errorStatus = null;
    try {
      result = await super.runAlarm(scenario.services);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      errorCauseName = thrown?.cause instanceof Error
        ? thrown.cause.constructor.name
        : null;
      errorCauseStatus = thrown?.cause instanceof Error
        ? thrown.cause.status ?? null
        : null;
      errorName = thrown instanceof Error ? thrown.constructor.name : null;
      errorStatus = thrown instanceof Error ? thrown.status ?? null : null;
    }
    return {
      result,
      error,
      errorCauseName,
      errorCauseStatus,
      errorName,
      errorStatus,
      snapshot: this.#snapshot(scenario.state),
    };
  }

  async testControlStatusFence(specification = {}) {
    const scenario = this.#scenarioServices(specification);
    this.lastScenario = scenario.state;
    let releaseStatus;
    let reportStatusEntered;
    const statusEntered = new Promise((resolve) => {
      reportStatusEntered = resolve;
    });
    const statusRelease = new Promise((resolve) => {
      releaseStatus = resolve;
    });
    scenario.services.control = {
      async status() {
        scenario.state.events.push("control-status-entered");
        reportStatusEntered();
        await statusRelease;
        scenario.state.events.push("control-status-released");
        return { localGate: "open", maxCapacity: MAX_ACTIVE_RUNNERS };
      },
    };

    const alarmPromise = super.runAlarm(scenario.services);
    await statusEntered;
    let drainSettled = false;
    const drainPromise = super.drain({}, scenario.services).then((result) => {
      drainSettled = true;
      return result;
    });
    const drainSettledBeforeRelease = drainSettled;
    releaseStatus();
    const [alarmResult, drainResult] = await Promise.all([
      alarmPromise,
      drainPromise,
    ]);
    return {
      alarmResult,
      drainResult,
      drainSettledBeforeRelease,
      snapshot: this.#snapshot(scenario.state),
    };
  }

  async testDrainedAlarmFence(specification = {}) {
    const scenario = this.#scenarioServices(specification);
    this.lastScenario = scenario.state;
    const configuredActiveRunnerCount = scenario.services.activeRunnerCount;
    let runnerCountCalls = 0;
    let releaseRunnerCount;
    let reportRunnerCountEntered;
    const runnerCountEntered = new Promise((resolve) => {
      reportRunnerCountEntered = resolve;
    });
    const runnerCountRelease = new Promise((resolve) => {
      releaseRunnerCount = resolve;
    });
    scenario.services.activeRunnerCount = async () => {
      const index = runnerCountCalls;
      runnerCountCalls += 1;
      if (index === 0) {
        reportRunnerCountEntered();
        await runnerCountRelease;
      }
      return configuredActiveRunnerCount();
    };

    const alarmPromise = super.runAlarm(scenario.services);
    alarmPromise.catch(() => {});
    await runnerCountEntered;
    let drainSettled = false;
    const drainPromise = super.drain({}, scenario.services).then((result) => {
      drainSettled = true;
      return result;
    });
    drainPromise.catch(() => {});
    await yieldToEventLoop();
    const drainSettledBeforeRelease = drainSettled;
    releaseRunnerCount();
    const [alarmResult, drainResult] = await Promise.all([
      alarmPromise,
      drainPromise,
    ]);
    return {
      alarmResult,
      drainResult,
      drainSettledBeforeRelease,
      snapshot: this.#snapshot(scenario.state),
    };
  }

  async testPlatformAlarm({ dropExportOutbox = false } = {}) {
    if (dropExportOutbox) {
      this.sql.exec("DROP TABLE export_outbox");
    }
    let result = null;
    let error = null;
    try {
      result = await this.alarm();
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const alarmGeneration = this.sql.exec(
      `SELECT alarm_generation
       FROM listener_state
       WHERE singleton = 1`,
    ).toArray()[0]?.alarm_generation ?? null;
    const scheduledAlarm = await super.scheduledAlarm();
    await this.ctx.storage.deleteAlarm();
    return {
      alarmGeneration,
      error,
      result,
      scheduledAlarm,
    };
  }

  inspect() {
    return this.#snapshot(this.lastScenario);
  }

  #recoverySchemaSnapshot() {
    const tables = this.sql.exec(
      `SELECT name, sql
       FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('recovery', 'recovery_with_session_expired')
       ORDER BY name`,
    ).toArray();
    const sentinelIndexes = this.sql.exec(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'index'
         AND tbl_name = 'recovery'
         AND name LIKE 'harness_recovery_%'
       ORDER BY name`,
    ).toArray().map((row) => row.name);
    const rows = this.sql.exec(
      `SELECT condition, first_failure_at_ms, attempts, next_attempt_at_ms,
              exhausted_marker
       FROM recovery
       ORDER BY condition`,
    ).toArray();
    return {
      rows,
      sentinelIndexes,
      tableNames: tables.map((table) => table.name),
      tableSql: tables.find((table) => table.name === "recovery")?.sql ?? null,
    };
  }

  async #reinitializeSchema() {
    new ProductionScaleSetListener(this.ctx, this.env);
    await yieldToEventLoop();
  }

  async testLegacyRecoverySchemaMigration() {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DROP TABLE recovery");
      this.sql.exec(`
        CREATE TABLE recovery (
          condition TEXT PRIMARY KEY CHECK (
            condition IN (
              'session-conflict',
              'github-rate-limit',
              'scale-set-not-found'
            )
          ),
          first_failure_at_ms INTEGER NOT NULL,
          attempts INTEGER NOT NULL,
          next_attempt_at_ms INTEGER NOT NULL,
          exhausted_marker TEXT
        )
      `);
      this.sql.exec(
        `INSERT INTO recovery (
           condition, first_failure_at_ms, attempts, next_attempt_at_ms,
           exhausted_marker
         ) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
        "github-rate-limit",
        1_800_000_123_456,
        4,
        1_800_000_234_567,
        null,
        "scale-set-not-found",
        1_800_000_345_678,
        6,
        1_800_000_456_789,
        "scale-set-recovery-exhausted",
      );
    });
    const legacy = this.#recoverySchemaSnapshot();

    await this.#reinitializeSchema();
    const migrated = this.#recoverySchemaSnapshot();
    this.sql.exec(
      `INSERT INTO recovery (
         condition, first_failure_at_ms, attempts, next_attempt_at_ms,
         exhausted_marker
       ) VALUES (?, ?, ?, ?, ?)`,
      "alarm-failure",
      1_800_000_567_890,
      2,
      1_800_000_678_901,
      null,
    );
    this.sql.exec(
      "CREATE INDEX harness_recovery_legacy_sentinel ON recovery (attempts)",
    );
    const beforeSecondInitialization = this.#recoverySchemaSnapshot();

    await this.#reinitializeSchema();
    return {
      afterSecondInitialization: this.#recoverySchemaSnapshot(),
      beforeSecondInitialization,
      legacy,
      migrated,
    };
  }

  async testFreshRecoverySchemaInitialization() {
    this.sql.exec(
      `INSERT INTO recovery (
         condition, first_failure_at_ms, attempts, next_attempt_at_ms,
         exhausted_marker
       ) VALUES (?, ?, ?, ?, ?)`,
      "session-conflict",
      1_800_000_789_012,
      3,
      1_800_000_890_123,
      "session-reclaim-exhausted",
    );
    this.sql.exec(
      "CREATE INDEX harness_recovery_fresh_sentinel ON recovery (attempts)",
    );
    const beforeSecondInitialization = this.#recoverySchemaSnapshot();

    await this.#reinitializeSchema();
    return {
      afterSecondInitialization: this.#recoverySchemaSnapshot(),
      beforeSecondInitialization,
    };
  }

  seed(input = {}) {
    const state = input.state ?? {};
    const fields = {
      scale_set_id: state.scaleSetId,
      scale_set_name: state.scaleSetName,
      runner_group_id: state.runnerGroupId,
      owner: state.owner,
      session_id: state.sessionId,
      session_queue_url: state.sessionQueueUrl,
      session_queue_token: state.sessionQueueToken,
      session_created_at_ms: state.sessionCreatedAtMs,
      last_message_id: state.cursor,
      latest_statistics: state.latestStatistics === undefined
        ? undefined
        : state.latestStatistics === null
        ? null
        : JSON.stringify(state.latestStatistics),
      scale_up_sequence: state.scaleUpSequence,
      admission_limit: state.admissionLimit,
      admission_success_streak: state.admissionSuccessStreak,
      admission_limit_changed_at_ms: state.admissionLimitChangedAtMs,
      admission_limited: state.admissionLimited === undefined
        ? undefined
        : Number(state.admissionLimited),
      last_start_issued_at_ms: state.lastStartIssuedAtMs,
      pace_refusal_streak: state.paceRefusalStreak,
      admin_token: state.adminToken,
      admin_token_expires_at_ms: state.adminTokenExpiresAtMs,
      actions_service_url: state.actionsServiceUrl,
      mode: state.mode,
      stopped_reason: state.stoppedReason,
      sqlite_full: state.sqliteFull === undefined
        ? undefined
        : Number(state.sqliteFull),
    };
    const entries = Object.entries(fields).filter(([, value]) =>
      value !== undefined
    );
    if (entries.length > 0) {
      this.sql.exec(
        `UPDATE listener_state
         SET ${entries.map(([field]) => `${field} = ?`).join(", ")}
         WHERE singleton = 1`,
        ...entries.map(([, value]) => value),
      );
    }
    for (const row of input.inbox ?? []) {
      this.sql.exec(
        `INSERT OR REPLACE INTO inbox (
           message_id, received_at_ms, payload, state, quarantine_reason
         ) VALUES (?, ?, ?, ?, ?)`,
        row.messageId,
        row.receivedAtMs,
        JSON.stringify(scaleSetMessage(row.message)),
        row.state,
        row.quarantineReason ?? null,
      );
    }
    for (const row of input.intents ?? []) {
      this.sql.exec(
        `INSERT OR REPLACE INTO acquisition_intents (
           runner_request_id, message_id, state, attempts, redeliveries,
           recorded_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        row.runnerRequestId,
        row.messageId,
        row.state,
        row.attempts ?? 0,
        row.redeliveries ?? 0,
        row.recordedAtMs,
      );
    }
    for (const row of input.outbox ?? []) {
      this.sql.exec(
        `INSERT OR REPLACE INTO dispatch_outbox (
           runner_request_id, state, runner_name, runner_id,
           correlation_id, repository, wave, reservation_id,
           reservation_released_at_ms, spawn_observed, jit_config, attempts,
           liveness_probe_attempts, liveness_probed_at_ms,
           undelivered_checked_at_ms, last_error, intent_recorded_at_ms,
           updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.runnerRequestId,
        row.state,
        row.runnerName ?? null,
        row.runnerId ?? null,
        row.correlationId ??
          `scale-set:101:runner-request:${row.runnerRequestId}`,
        row.repository ?? "example/runner-test",
        row.wave ?? "wave-1",
        row.reservationId ?? null,
        row.reservationReleasedAtMs ?? null,
        Number(row.spawnObserved ?? false),
        row.jitConfig ?? null,
        row.attempts ?? 0,
        row.livenessProbeAttempts ?? 0,
        row.livenessProbedAtMs ?? null,
        row.undeliveredCheckedAtMs ?? null,
        row.lastError ?? null,
        row.intentRecordedAtMs ?? null,
        row.updatedAtMs,
      );
    }
    for (const runnerRequestId of input.cancellations ?? []) {
      this.sql.exec(
        `INSERT OR REPLACE INTO cancellations (
           runner_request_id, recorded_at_ms
         ) VALUES (?, ?)`,
        runnerRequestId,
        input.recordedAtMs ?? 1_800_000_000_000,
      );
    }
    for (const row of input.exportRecords ?? []) {
      this.sql.exec(
        `INSERT INTO export_outbox (record, created_at_ms, state)
         VALUES (?, ?, ?)`,
        typeof row.record === "string"
          ? row.record
          : JSON.stringify(row.record),
        row.createdAtMs,
        row.state ?? "pending",
      );
    }
    if (input.legacyScaleUpSchema === true) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN scale_up_sequence",
        );
        this.sql.exec(
          "ALTER TABLE dispatch_outbox DROP COLUMN intent_recorded_at_ms",
        );
        this.sql.exec(
          "ALTER TABLE dispatch_outbox DROP COLUMN liveness_probe_attempts",
        );
        this.sql.exec(
          "ALTER TABLE dispatch_outbox DROP COLUMN liveness_probed_at_ms",
        );
      });
      return { legacyScaleUpSchemaSeeded: true };
    }
    if (input.legacyLivenessProbeSchema === true) {
      this.sql.exec(
        "ALTER TABLE dispatch_outbox DROP COLUMN liveness_probed_at_ms",
      );
      return { legacyLivenessProbeSchemaSeeded: true };
    }
    if (input.legacySettleRotationSchema === true) {
      this.sql.exec(
        "ALTER TABLE dispatch_outbox DROP COLUMN settle_checked_at_ms",
      );
      return { legacySettleRotationSchemaSeeded: true };
    }
    if (input.legacyScaleUpDecisionSchema === true) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN last_scale_up_decision_at_ms",
        );
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN last_scale_up_decision",
        );
      });
      return { legacyScaleUpDecisionSchemaSeeded: true };
    }
    if (input.legacyStartGateSchema === true) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN last_start_gate_refusal",
        );
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN last_start_gate_refusal_at_ms",
        );
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN last_start_gate_closed_reason",
        );
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN last_start_gate_closed_at_ms",
        );
      });
      return { legacyStartGateSchemaSeeded: true };
    }
    if (input.legacyAdmissionSchema === true) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN admission_limit",
        );
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN admission_success_streak",
        );
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN admission_limit_changed_at_ms",
        );
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN admission_limited",
        );
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN last_start_issued_at_ms",
        );
        this.sql.exec(
          "ALTER TABLE listener_state DROP COLUMN pace_refusal_streak",
        );
        this.sql.exec(
          "ALTER TABLE dispatch_outbox DROP COLUMN spawn_observed",
        );
      });
      return { legacyAdmissionSchemaSeeded: true };
    }
    return this.#snapshot(null);
  }

  async testControl({ method, input = {}, specification = {} }) {
    if (Object.hasOwn(specification, "runnerRegistryActiveResult")) {
      const registry = this.env.RunnerRegistry.get(
        this.env.RunnerRegistry.idFromName("singleton"),
      );
      await registry.stubNextActiveList(
        specification.runnerRegistryActiveResult,
      );
    }
    const scenario = this.#scenarioServices(specification);
    this.lastScenario = scenario.state;
    const result = await super[method](input, scenario.services);
    return { result, snapshot: this.#snapshot(scenario.state) };
  }

  secretScan({ secrets }) {
    const records = this.sql.exec(
      "SELECT record FROM export_outbox ORDER BY id",
    ).toArray().map((row) => row.record);
    return Object.fromEntries(secrets.map((secret) => [
      secret,
      {
        exportRows: records.some((record) => record.includes(secret)),
        logs: this.harnessLogs.some((record) => record.includes(secret)),
      },
    ]));
  }

  async reconstructedStatus() {
    const replacement = new ProductionScaleSetListener(this.ctx, this.env);
    await yieldToEventLoop();
    return replacement.status({ scaleSetName: "example-scale-set" });
  }

  policy() {
    return {
      alarmWallBudgetMs: ALARM_WALL_BUDGET_MS,
      alarmWorkBudgetMs: ALARM_WORK_BUDGET_MS,
      heartbeatStaleMs: HEARTBEAT_STALE_MS,
      maxDispatchConcurrency: MAX_DISPATCH_CONCURRENCY,
      maxLivenessProbeAttempts: MAX_LIVENESS_PROBE_ATTEMPTS,
      maxLivenessProbesPerPass: MAX_LIVENESS_PROBES_PER_PASS,
      pollTimeoutMs: POLL_TIMEOUT_MS,
      recoveryBaseDelayMs: RECOVERY_BASE_DELAY_MS,
      recoveryMaxDelayMs: RECOVERY_MAX_DELAY_MS,
      recoveryMaxElapsedMs: RECOVERY_MAX_ELAPSED_MS,
      recoveryMaxAttempts: RECOVERY_MAX_ATTEMPTS,
      runnerLivenessProbeMinAgeMs: RUNNER_LIVENESS_PROBE_MIN_AGE_MS,
      startDeadlineMs: START_DEADLINE_MS,
      boundaryPollTimeouts: [
        pollTimeoutForElapsed(840_000),
        pollTimeoutForElapsed(840_001),
        pollTimeoutForElapsed(890_000),
        pollTimeoutForElapsed(890_001),
      ],
    };
  }
}

function listener(env, name) {
  return env.ScaleSetListener.get(env.ScaleSetListener.idFromName(name));
}

function autopilotControl(env, name) {
  return env.AutopilotControl.get(env.AutopilotControl.idFromName(name));
}

function runnerRegistry(env) {
  return env.RunnerRegistry.get(env.RunnerRegistry.idFromName("singleton"));
}

async function autopilotControlRpc(request, env, url) {
  const name = url.searchParams.get("name");
  if (name === null || name.length === 0) {
    return Response.json({ error: "The control name is required" }, {
      status: 400,
    });
  }
  const method = url.pathname.slice("/harness/autopilot-control/".length);
  const input = request.body === null ? {} : await request.json();
  const control = autopilotControl(env, name);
  if (method === "setActiveWave") {
    return Response.json(await control.setActiveWave(input));
  }
  if (method === "recordCapacityApproval") {
    return Response.json(await control.recordCapacityApproval(input));
  }
  if (method === "status") {
    return Response.json(await control.status());
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/harness/listener-reset-auth") {
      let resetAdmissionCalls = 0;
      const response = await handleWorkerRequest(
        new Request(
          "https://example.test/autopilot/listener/example-scale-set/" +
            "reset-admission",
          { method: "POST" },
        ),
        env,
        ctx,
        {
          listener: {
            resetAdmission() {
              resetAdmissionCalls += 1;
              return { reset: true, admissionLimit: null };
            },
          },
        },
      );
      return Response.json({
        body: await response.json(),
        resetAdmissionCalls,
        status: response.status,
      });
    }
    if (url.pathname === "/harness/listener-status-route") {
      const specification = await request.json();
      const name = url.searchParams.get("name") ?? "example-scale-set";
      const target = listener(env, name);
      return handleWorkerRequest(
        new Request(
          "https://example.test/autopilot/listener/example-scale-set",
          {
            headers: {
              Authorization: `Bearer ${env.CONTROL_TOKEN}`,
            },
          },
        ),
        env,
        ctx,
        {
          listener: {
            async status(input) {
              const result = await target.testControl({
                method: "status",
                input,
                specification,
              });
              return result.result;
            },
          },
        },
      );
    }
    if (url.pathname === "/harness/listener-route-failure") {
      const { secret } = await request.json();
      const logs = [];
      const response = await handleWorkerRequest(
        new Request(
          "https://example.test/autopilot/listener/example-scale-set",
          {
            headers: {
              Authorization: `Bearer ${env.CONTROL_TOKEN}`,
            },
          },
        ),
        env,
        ctx,
        {
          listener: {
            status() {
              throw new TypeError(`deep durable failure ${secret}`);
            },
          },
          logger: {
            error: (value) => logs.push(String(value)),
            log: (value) => logs.push(String(value)),
          },
        },
      );
      return Response.json({
        body: await response.json(),
        logs,
        status: response.status,
      });
    }
    if (url.pathname === "/harness/listener-route-request-error") {
      const { secret } = await request.json();
      const logs = [];
      const response = await handleWorkerRequest(
        new Request(
          "https://example.test/autopilot/listener/example-scale-set/resume",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.CONTROL_TOKEN}`,
            },
          },
        ),
        env,
        ctx,
        {
          listener: {
            resume() {
              throw new ScaleSetRequestError(
                `session deletion failed ${secret}`,
                {
                  status: 401,
                  method: "DELETE",
                  url: "https://actions.stub.test/message-sessions?page=1",
                  responseSnippet: `expired session ${secret}`,
                },
              );
            },
          },
          logger: {
            error: (value) => logs.push(String(value)),
            log: (value) => logs.push(String(value)),
          },
        },
      );
      return Response.json({
        body: await response.json(),
        logs,
        status: response.status,
      });
    }
    if (url.pathname === "/harness/runner-registry/record-starting") {
      return Response.json(
        await runnerRegistry(env).recordStarting(await request.json()),
      );
    }
    if (url.pathname.startsWith("/harness/autopilot-control/")) {
      return autopilotControlRpc(request, env, url);
    }
    if (url.pathname.startsWith("/harness/listener/")) {
      const name = url.searchParams.get("name") ?? "example-scale-set";
      const method = url.pathname.slice("/harness/listener/".length);
      const target = listener(env, name);
      const body = request.body === null ? {} : await request.json();
      if (method === "alarm") {
        return Response.json(await target.testAlarm(body));
      }
      if (method === "control-status-fence") {
        return Response.json(await target.testControlStatusFence(body));
      }
      if (method === "drained-alarm-fence") {
        return Response.json(await target.testDrainedAlarmFence(body));
      }
      if (method === "platform-alarm") {
        return Response.json(await target.testPlatformAlarm(body));
      }
      if (method === "inspect") {
        return Response.json(await target.inspect());
      }
      if (method === "legacy-recovery-schema-migration") {
        return Response.json(
          await target.testLegacyRecoverySchemaMigration(),
        );
      }
      if (method === "fresh-recovery-schema-initialization") {
        return Response.json(
          await target.testFreshRecoverySchemaInitialization(),
        );
      }
      if (method === "seed") {
        return Response.json(await target.seed(body));
      }
      if (method === "control") {
        return Response.json(await target.testControl(body));
      }
      if (method === "secret-scan") {
        return Response.json(await target.secretScan(body));
      }
      if (method === "reconstruct") {
        return Response.json(await target.reconstructedStatus());
      }
      if (method === "policy") {
        return Response.json(await target.policy());
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return handleWorkerRequest(request, env, ctx);
  },
};

export const harnessSecrets = Object.freeze({
  ADMIN_TOKEN,
  APP_JWT,
  APP_PRIVATE_KEY,
  INSTALLATION_TOKEN,
  JIT_CONFIG,
  REFRESHED_ADMIN_TOKEN,
  REFRESHED_SESSION_TOKEN,
  REGISTRATION_TOKEN,
  SESSION_TOKEN,
});
