import {
  AutopilotControl as ProductionAutopilotControl,
  RunnerRegistry as ProductionRunnerRegistry,
  handleWorkerRequest,
  validateEnvironment,
} from "../src/worker.js";

export class RunnerRegistry extends ProductionRunnerRegistry {
  alarm() {
    // This harness stubs sandboxes, so it suppresses production cleanup work.
    return { status: "suppressed-by-test-harness" };
  }
}

export class AutopilotControl extends ProductionAutopilotControl {
  seedLiveReservations({ count, nowMs, expiresAtMs }) {
    const control = this.sql.exec(
      `SELECT gate_generation, active_wave
       FROM control_state
       WHERE singleton = 1`,
    ).toArray()[0];
    if (control === undefined || control.active_wave === null) {
      throw new Error("The active wave must be set before seeding reservations");
    }
    this.ctx.storage.transactionSync(() => {
      for (let index = 1; index <= count; index += 1) {
        this.sql.exec(
          `INSERT INTO reservations (
             reservation_id, scale_set_id, runner_request_id, repository, wave,
             state, gate_generation, owner, expires_at_ms,
             requested_at_ms, reserved_at_ms
           ) VALUES (?, 101, ?, 'example/runner-test', ?, 'reserved', ?,
                     'listener-1', ?, ?, ?)`,
          `seeded-reservation-${index}`,
          index,
          control.active_wave,
          control.gate_generation,
          expiresAtMs,
          nowMs,
          nowMs,
        );
      }
    });
    return { seeded: count };
  }

  seedStartCreatedReservation({
    reservationId,
    scaleSetId,
    runnerRequestId,
    repository,
    wave,
    owner,
    expiresAtMs,
    nowMs,
  }) {
    this.sql.exec(
      `INSERT INTO reservations (
         reservation_id, scale_set_id, runner_request_id, repository, wave,
         state, gate_generation, owner, expires_at_ms,
         correlation_id, sandbox_id, requested_at_ms, reserved_at_ms,
         start_created_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'start-created', 0, ?, ?,
                 'seeded-correlation', 'seeded-sandbox', ?, ?, ?)`,
      reservationId,
      scaleSetId,
      runnerRequestId,
      repository,
      wave,
      owner,
      expiresAtMs,
      nowMs,
      nowMs,
      nowMs,
    );
    return { seeded: true };
  }

  seedDuplicateSandboxReservations({ sandboxId }) {
    const control = this.sql.exec(
      `SELECT gate_generation, active_wave
       FROM control_state
       WHERE singleton = 1`,
    ).toArray()[0];
    if (control === undefined || control.active_wave === null) {
      throw new Error("The active wave must be set before seeding reservations");
    }
    const nowMs = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (let index = 1; index <= 2; index += 1) {
        this.sql.exec(
          `INSERT INTO reservations (
             reservation_id, scale_set_id, runner_request_id, repository, wave,
             state, gate_generation, owner, expires_at_ms,
             correlation_id, sandbox_id, requested_at_ms, reserved_at_ms,
             start_created_at_ms, consumed_at_ms
           ) VALUES (?, 101, ?, 'example/runner-test', ?, 'consumed', ?,
                     'listener-1', ?, ?, ?, ?, ?, ?, ?)`,
          `duplicate-sandbox-reservation-${index}`,
          700 + index,
          control.active_wave,
          control.gate_generation,
          nowMs + 60_000,
          `duplicate-sandbox-correlation-${index}`,
          sandboxId,
          nowMs,
          nowMs,
          nowMs,
          nowMs,
        );
      }
    });
    return { seeded: 2 };
  }

  async releaseBySandboxError(input) {
    try {
      await this.releaseBySandbox(input);
      return { threw: false };
    } catch (error) {
      return {
        threw: true,
        errorName: error?.constructor?.name,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  seedCompensatedReservation({ reservationId, compensatedAtMs }) {
    this.sql.exec(
      `INSERT INTO reservations (
         reservation_id, scale_set_id, runner_request_id, repository, wave,
         state, gate_generation, owner, expires_at_ms,
         compensation_reason, requested_at_ms, compensated_at_ms
       ) VALUES (?, 101, 501, 'example/runner-test', 'wave-1',
                 'compensated', 0, 'listener-1', ?, 'test', ?, ?)`,
      reservationId,
      compensatedAtMs,
      compensatedAtMs,
      compensatedAtMs,
    );
    return { seeded: true };
  }

  seedReservation({
    reservationId,
    runnerRequestId,
    state,
    requestedAtMs,
    expiresAtMs,
    reservedAtMs = null,
    startCreatedAtMs = null,
    consumedAtMs = null,
    compensatedAtMs = null,
    compensationReason = null,
  }) {
    this.sql.exec(
      `INSERT INTO reservations (
         reservation_id, scale_set_id, runner_request_id, repository, wave,
         state, gate_generation, owner, expires_at_ms,
         compensation_reason, requested_at_ms, reserved_at_ms,
         start_created_at_ms, consumed_at_ms, compensated_at_ms
       ) VALUES (?, 101, ?, 'example/runner-test', 'wave-1', ?, 0,
                 'listener-1', ?, ?, ?, ?, ?, ?, ?)`,
      reservationId,
      runnerRequestId,
      state,
      expiresAtMs,
      compensationReason,
      requestedAtMs,
      reservedAtMs,
      startCreatedAtMs,
      consumedAtMs,
      compensatedAtMs,
    );
    return { seeded: true };
  }

  async reservationAlarm() {
    return { alarmAtMs: await this.ctx.storage.getAlarm() };
  }

  reservationExists(reservationId) {
    return this.sql.exec(
      "SELECT 1 FROM reservations WHERE reservation_id = ?",
      reservationId,
    ).toArray().length === 1;
  }
}

const jitScenarios = new Map();

function getControl(env, name) {
  return env.AutopilotControl.get(
    env.AutopilotControl.idFromName(name),
  );
}

async function controlRpc(request, env, url) {
  const name = url.searchParams.get("name");
  if (name === null || name.length === 0) {
    return Response.json(
      { error: "The control name is required" },
      { status: 400 },
    );
  }
  const method = url.pathname.slice("/harness/control/".length);
  const body = request.body === null ? {} : await request.json();
  const control = getControl(env, name);
  switch (method) {
    case "status":
      return Response.json(await control.status());
    case "reserve":
      return Response.json(await control.reserve(body));
    case "markStartCreated":
      return Response.json(await control.markStartCreated(body));
    case "consume":
      return Response.json(await control.consume(body));
    case "compensate":
      return Response.json(await control.compensate(body));
    case "releaseBySandbox":
      return Response.json(await control.releaseBySandbox(body));
    case "releaseBySandboxError":
      return Response.json(await control.releaseBySandboxError(body));
    case "closeGate":
      return Response.json(await control.closeGate(body));
    case "openGate":
      return Response.json(await control.openGate(body));
    case "recordCapacityApproval":
      return Response.json(await control.recordCapacityApproval(body));
    case "setActiveWave":
      return Response.json(await control.setActiveWave(body));
    case "listReservations":
      return Response.json(await control.listReservations(body));
    case "alarm":
      return Response.json(await control.runAlarm(body));
    case "seedLiveReservations":
      return Response.json(await control.seedLiveReservations(body));
    case "seedStartCreatedReservation":
      return Response.json(await control.seedStartCreatedReservation(body));
    case "seedDuplicateSandboxReservations":
      return Response.json(
        await control.seedDuplicateSandboxReservations(body),
      );
    case "seedCompensatedReservation":
      return Response.json(await control.seedCompensatedReservation(body));
    case "seedReservation":
      return Response.json(await control.seedReservation(body));
    case "reservationAlarm":
      return Response.json(await control.reservationAlarm());
    case "reservationExists":
      return Response.json({
        exists: await control.reservationExists(body.reservationId),
      });
    default:
      return Response.json({ error: "Not found" }, { status: 404 });
  }
}

function createJitScenario() {
  const state = {
    cleanupScheduled: 0,
    clockMs: Date.now(),
    events: [],
    logs: [],
    markOnlineCalls: 0,
    processStarts: 0,
    readinessTimeoutMs: null,
    registrationTokenRequests: 0,
    registryState: null,
    registryRows: 0,
    runnerUuid: crypto.randomUUID(),
    sandboxCreations: 0,
    sandboxIds: [],
    sandboxLabels: null,
    startBudgetCancelled: false,
    startBudgetMs: null,
    startEnvironment: null,
    waitUntilPromises: [],
    waitUntilTasks: [],
  };
  return state;
}

function jitScenarioSnapshot(state) {
  return {
    cleanupScheduled: state.cleanupScheduled,
    events: state.events,
    logs: state.logs,
    markOnlineCalls: state.markOnlineCalls,
    processStarts: state.processStarts,
    readinessTimeoutMs: state.readinessTimeoutMs,
    registrationTokenRequests: state.registrationTokenRequests,
    registryState: state.registryState,
    registryRows: state.registryRows,
    sandboxCreations: state.sandboxCreations,
    sandboxIds: state.sandboxIds,
    sandboxLabels: state.sandboxLabels,
    startBudgetCancelled: state.startBudgetCancelled,
    startBudgetMs: state.startBudgetMs,
    startEnvironment: state.startEnvironment,
    waitUntilCount: state.waitUntilTasks.length,
  };
}

function stubControl(mode, state, realControl) {
  if (realControl !== null) {
    return {
      async markStartCreated(input) {
        state.events.push("mark-start-created");
        const result = await realControl.markStartCreated(input);
        if (result.started && mode === "generation-superseded") {
          await realControl.closeGate({
            reason: "test generation transition",
            nowMs: state.clockMs,
          });
          state.events.push("gate-closed");
        }
        return result;
      },
      async consume(input) {
        state.events.push("consume");
        return realControl.consume(input);
      },
      compensate(input) {
        return realControl.compensate(input);
      },
    };
  }
  return {
    async markStartCreated(input) {
      state.events.push("mark-start-created");
      if (mode === "mark-start-error") {
        throw new Error("simulated markStartCreated failure");
      }
      if (mode === "mark-refused") {
        return { started: false, reason: "invalid-state" };
      }
      if ([
        "missing-reservation",
        "missing-reservation-compensate-error",
      ].includes(mode)) {
        return { started: true };
      }
      return {
        started: true,
        reservation: {
          reservationId: input.reservationId,
          scaleSetId: state.jitRequestBody.scaleSetId,
          runnerRequestId: state.jitRequestBody.runnerRequestId,
          repository: state.jitRequestBody.repository,
          wave: state.jitRequestBody.wave,
          expiresAtMs: state.jitRequestBody.reservation.expiresAtMs,
          gateGeneration: state.jitRequestBody.reservation.gateGeneration,
        },
      };
    },
    async consume() {
      state.events.push("consume");
      return ["consume-refused", "consume-refused-cleanup-error"].includes(mode)
        ? { consumed: false, reason: "generation-superseded" }
        : { consumed: true };
    },
    async compensate() {
      state.events.push("compensate");
      if (mode === "missing-reservation-compensate-error") {
        throw new Error("simulated compensation failure");
      }
      return { compensated: true };
    },
  };
}

function jitServices(mode, state, realControl, realRegistry, env) {
  const registry = realRegistry ?? {
    async recordStarting(record) {
      if (mode === "spawn-error-secret") {
        throw new Error(
          "simulated spawn outage: control-token-with-at-least-32-characters",
        );
      }
      if (mode === "spawn-error-status") {
        const error = new Error("simulated upstream outage");
        error.status = 503;
        throw error;
      }
      if (mode === "spawn-error-success-status") {
        const error = new Error("simulated invalid success status");
        error.status = 200;
        throw error;
      }
      if (mode === "spawn-error-class") {
        const error = new Error("simulated registry write failure");
        error.name = "RunnerRegistryWriteError";
        throw error;
      }
      if (mode === "spawn-error-message-status") {
        throw new Error("simulated upstream request failed: 429");
      }
      if (mode === "spawn-error-unrelated-message-status") {
        throw new Error("database shard: 429");
      }
      state.events.push("record-starting");
      state.registryState = "starting";
      state.record = record;
      if (mode === "correlation-replay-live") {
        return {
          created: false,
          runner: { ...record, state: "online" },
        };
      }
      state.registryRows += 1;
      return { created: true, runner: { ...record, state: "starting" } };
    },
    async beginStartupCleanup() {
      if (
        [
          "consume-refused-cleanup-error",
          "start-process-budget-cleanup-error",
          "start-process-cleanup-error",
        ].includes(mode)
      ) {
        const error = new Error("simulated cleanup scheduling failure");
        error.name = "RunnerCleanupScheduleError";
        throw error;
      }
      state.events.push("cleanup-scheduled");
      state.cleanupScheduled += 1;
      state.registryState = "destroying";
      if (mode === "cleanup-already-scheduled") {
        return { claimed: false, reason: "already-scheduled" };
      }
      if (mode === "cleanup-refused") {
        return { claimed: false, reason: "invalid-state" };
      }
      if (mode === "readiness-secret") {
        return { claimed: true, reason: env.CONTROL_TOKEN };
      }
      return { claimed: true, reason: "scheduled" };
    },
    async markOnline() {
      state.events.push("mark-online");
      state.markOnlineCalls += 1;
      if (mode === "mark-online-throws") {
        throw new Error("simulated markOnline failure");
      }
      state.registryState = "online";
      return true;
    },
  };
  return {
    control: stubControl(mode, state, realControl),
    registry,
    logger: {
      error(value) {
        state.logs.push(String(value));
      },
      log(value) {
        state.logs.push(String(value));
      },
    },
    now: () => state.clockMs,
    randomUUID: () => realRegistry === null
      ? "00000000-0000-4000-8000-000000000101"
      : state.runnerUuid,
    createCleanupToken: async () => "cleanup-token",
    createRegistrationToken: async () => {
      state.registrationTokenRequests += 1;
      return {
        token: "registration-token",
        expires_at: "2026-08-22T12:00:00.000Z",
      };
    },
    startBudgetTimer(ms) {
      state.startBudgetMs = ms;
      return {
        expired: [
          "start-process-budget-cleanup-error",
          "start-process-budget-exceeded",
        ].includes(mode)
          ? Promise.resolve()
          : new Promise(() => {}),
        cancel() {
          state.startBudgetCancelled = true;
        },
      };
    },
    scheduleWaitUntil(_ctx, task) {
      if (mode === "schedule-wait-error") {
        throw new Error("simulated waitUntil scheduling failure");
      }
      state.waitUntilTasks.push(task);
      // Real-registry cases only need the durable starting-row behavior.
      if (mode !== "pending-readiness" && realRegistry === null) {
        state.waitUntilPromises.push(Promise.resolve(task()));
      }
    },
    getSandbox(_binding, sandboxId, options) {
      state.events.push("sandbox-created");
      state.sandboxCreations += 1;
      state.sandboxIds.push(sandboxId);
      state.sandboxLabels = options.labels;
      return {
        async startProcess(_command, options) {
          if (
            [
              "start-process-budget-cleanup-error",
              "start-process-budget-exceeded",
            ].includes(mode)
          ) {
            return new Promise(() => {});
          }
          if (mode === "start-process-container-capacity") {
            throw new Error("Sandbox failed to start", {
              cause: new Error(
                "There is no container instance that can be provided to this Durable Object, try again later",
              ),
            });
          }
          if (mode === "start-process-exit-code") {
            throw new Error("actions-runner failed: 137");
          }
          if (mode === "start-process-cleanup-error") {
            const error = new Error("simulated sandbox process failure");
            error.name = "SandboxProcessError";
            throw error;
          }
          state.events.push("process-started");
          state.processStarts += 1;
          state.startEnvironment = options.env;
          return {
            async waitForLog(_pattern, timeoutMs) {
              state.events.push("readiness-observed");
              state.readinessTimeoutMs = timeoutMs;
              if (mode === "timeout-readiness") {
                state.clockMs += timeoutMs + 1;
              } else if (
                [
                  "cleanup-already-scheduled",
                  "cleanup-refused",
                  "readiness-secret",
                  "readiness-rejected",
                ].includes(mode)
              ) {
                throw new Error("simulated readiness timeout");
              }
            },
          };
        },
      };
    },
  };
}

async function jitResponse(request, env, url) {
  const scenario = url.searchParams.get("scenario");
  const mode = url.searchParams.get("mode") ?? "ready";
  if (scenario === null || scenario.length === 0) {
    return Response.json(
      { error: "The JIT scenario is required" },
      { status: 400 },
    );
  }
  const state = createJitScenario();
  try {
    state.jitRequestBody = await request.clone().json();
  } catch {
    state.jitRequestBody = null;
  }
  jitScenarios.set(scenario, state);
  const controlName = url.searchParams.get("control");
  const realControl = controlName === null
    ? null
    : getControl(env, controlName);
  const registryName = url.searchParams.get("registry");
  const realRegistry = registryName === null
    ? null
    : env.RunnerRegistry.get(env.RunnerRegistry.idFromName(registryName));
  const forwardedUrl = new URL(request.url);
  forwardedUrl.pathname = "/runners";
  forwardedUrl.search = "";
  const forwardedRequest = new Request(forwardedUrl, request);
  const githubRepository = url.searchParams.get("githubRepository");
  let workerEnv = githubRepository === null
    ? env
    : { ...env, GITHUB_REPOSITORY: githubRepository };
  const githubRepositoryAllowlist = url.searchParams.get(
    "githubRepositoryAllowlist",
  );
  if (githubRepositoryAllowlist !== null) {
    workerEnv = {
      ...workerEnv,
      GITHUB_REPOSITORY_ALLOWLIST: JSON.parse(githubRepositoryAllowlist),
    };
  }
  if (url.searchParams.get("omitRepositoryAllowlist") === "true") {
    workerEnv = { ...workerEnv };
    delete workerEnv.GITHUB_REPOSITORY_ALLOWLIST;
  }
  return handleWorkerRequest(
    forwardedRequest,
    workerEnv,
    {},
    jitServices(mode, state, realControl, realRegistry, workerEnv),
  );
}

async function repositoryConfigResponse(request, env) {
  const body = await request.json();
  const workerEnv = {
    ...env,
    ...(Object.hasOwn(body, "githubRepository")
      ? { GITHUB_REPOSITORY: body.githubRepository }
      : {}),
    ...(Object.hasOwn(body, "githubRepositoryAllowlist")
      ? { GITHUB_REPOSITORY_ALLOWLIST: body.githubRepositoryAllowlist }
      : {}),
  };
  if (body.omitRepositoryAllowlist === true) {
    delete workerEnv.GITHUB_REPOSITORY_ALLOWLIST;
  }
  try {
    return Response.json({ repositories: validateEnvironment(workerEnv) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

async function jitScenarioControl(url) {
  const scenario = url.searchParams.get("scenario");
  const state = jitScenarios.get(scenario);
  if (state === undefined) {
    return Response.json({ error: "Scenario not found" }, { status: 404 });
  }
  if (url.pathname === "/harness/jit-release") {
    while (state.waitUntilPromises.length < state.waitUntilTasks.length) {
      const task = state.waitUntilTasks[state.waitUntilPromises.length];
      state.waitUntilPromises.push(Promise.resolve(task()));
    }
    await Promise.all(state.waitUntilPromises);
  }
  if (url.pathname === "/harness/jit-flush") {
    await Promise.all(state.waitUntilPromises);
  }
  return Response.json(jitScenarioSnapshot(state));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/harness/control/")) {
        return await controlRpc(request, env, url);
      }
      if (
        url.pathname === "/harness/jit-state" ||
        url.pathname === "/harness/jit-release" ||
        url.pathname === "/harness/jit-flush"
      ) {
        return await jitScenarioControl(url);
      }
      if (url.pathname === "/harness/repository-config") {
        return await repositoryConfigResponse(request, env);
      }
      if (url.pathname === "/runners") {
        return await jitResponse(request, env, url);
      }
      return handleWorkerRequest(request, env, ctx);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
};
