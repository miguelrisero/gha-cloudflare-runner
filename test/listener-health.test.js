import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LISTENER_HEALTH_CONSTANTS,
  LISTENER_WATCHDOG_DEFAULTS,
  evaluateListenerHealth,
} from "../scripts/lib/listener-health.mjs";

register(new URL("./cloudflare-workers-loader.js", import.meta.url));

const {
  HEARTBEAT_STALE_MS,
  MIN_ADMISSION_LIMIT,
  RECOVERY_MAX_ELAPSED_MS,
} = await import("../src/scaleset-listener.js");
const { ACTIVE_RUNNER_CLEANUP_DELAY_MS } = await import(
  "../src/runner-policy.js"
);
const { MAX_ACTIVE_RUNNERS } = await import("../src/autopilot-control.js");

const NOW_MS = 1_800_000_000_000;
const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url));
const listenerHealthCli = fileURLToPath(
  new URL("../scripts/lib/listener-health.mjs", import.meta.url),
);

function listenerStatus(overrides = {}) {
  return {
    enabled: true,
    configured: true,
    mode: "running",
    stoppedReason: null,
    advertisedMaxCapacity: 10,
    controlStatusReadFailed: false,
    heartbeatAtMs: NOW_MS,
    heartbeatAgeMs: 0,
    admissionLimit: 5,
    admissionLimited: false,
    exhaustionMarkers: [],
    recoveries: [],
    latestStatistics: {
      totalRegisteredRunners: 0,
    },
    scaleUp: {
      lastDecision: {
        reason: "evaluated",
        desired: 0,
        shortfall: 0,
      },
    },
    ...overrides,
  };
}

function controlStatus(overrides = {}) {
  return {
    liveReservationCount: 0,
    nextReclaimAtMs: null,
    ...overrides,
  };
}

function reservationStatus(overrides = {}) {
  return {
    reservations: [],
    pageSize: 100,
    nextCursor: null,
    hasMore: false,
    summary: {
      nowMs: NOW_MS,
      counts: {},
      liveReservationCount: 0,
      nextReclaimAtMs: null,
      pageSize: 100,
    },
    ...overrides,
  };
}

function reservation({
  reservationId = "reservation-1",
  requestedAtMs = NOW_MS,
  state = "consumed",
  live = true,
} = {}) {
  return {
    reservationId,
    requestedAtMs,
    state,
    live,
  };
}

function evaluate({
  listener = listenerStatus(),
  control = controlStatus(),
  reservations = reservationStatus(),
  nowMs = NOW_MS,
  thresholds = LISTENER_WATCHDOG_DEFAULTS,
  positiveControl = false,
} = {}) {
  return evaluateListenerHealth({
    listenerStatus: listener,
    controlStatus: control,
    reservationStatus: reservations,
    nowMs,
    thresholds,
    positiveControl,
  });
}

function findingCodes(result) {
  return result.findings.map(({ code }) => code);
}

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "listener-health-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeStatuses(
  directory,
  listener,
  control,
  reservations = reservationStatus(),
) {
  const listenerPath = join(directory, "listener.json");
  const controlPath = join(directory, "control.json");
  const reservationPath = join(directory, "reservations.json");
  writeFileSync(listenerPath, JSON.stringify(listener));
  writeFileSync(controlPath, JSON.stringify(control));
  writeFileSync(reservationPath, JSON.stringify(reservations));
  return { listenerPath, controlPath, reservationPath };
}

function runCli(args, environment = {}) {
  return spawnSync(process.execPath, [listenerHealthCli, ...args], {
    cwd: repositoryDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      LISTENER_WATCHDOG_DARK_MS: "",
      LISTENER_WATCHDOG_STRANDED_AGE_MS: "",
      LISTENER_WATCHDOG_STRANDED_COUNT: "",
      ...environment,
    },
  });
}

test("the mirrored constants and defaults match their source expressions", () => {
  assert.equal(
    LISTENER_HEALTH_CONSTANTS.HEARTBEAT_STALE_MS,
    HEARTBEAT_STALE_MS,
  );
  assert.equal(
    LISTENER_HEALTH_CONSTANTS.RECOVERY_MAX_ELAPSED_MS,
    RECOVERY_MAX_ELAPSED_MS,
  );
  assert.equal(
    LISTENER_HEALTH_CONSTANTS.MIN_ADMISSION_LIMIT,
    MIN_ADMISSION_LIMIT,
  );
  assert.equal(
    LISTENER_HEALTH_CONSTANTS.ACTIVE_RUNNER_CLEANUP_DELAY_MS,
    ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  );
  assert.equal(
    LISTENER_WATCHDOG_DEFAULTS.darkHeartbeatMs,
    RECOVERY_MAX_ELAPSED_MS,
  );
  assert.equal(
    LISTENER_WATCHDOG_DEFAULTS.admissionFloor,
    MIN_ADMISSION_LIMIT,
  );
  assert.equal(
    LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs,
    ACTIVE_RUNNER_CLEANUP_DELAY_MS / 2,
  );
  assert.equal(
    LISTENER_WATCHDOG_DEFAULTS.strandedReservationCount,
    2,
  );
  assert.equal(Object.isFrozen(LISTENER_HEALTH_CONSTANTS), true);
  assert.equal(Object.isFrozen(LISTENER_WATCHDOG_DEFAULTS), true);
});

test("a healthy listener has no findings", () => {
  assert.deepEqual(evaluate(), { findings: [], exitCode: 0 });
});

test("the registration ceiling mirror is fixed at 300", () => {
  assert.equal(
    LISTENER_HEALTH_CONSTANTS.MAX_ACTIVE_RUNNERS,
    MAX_ACTIVE_RUNNERS,
  );
  assert.equal(LISTENER_HEALTH_CONSTANTS.MAX_ACTIVE_RUNNERS, 300);
});

test("positive control returns exactly one warning and exits zero", () => {
  const result = evaluate({
    listener: null,
    control: null,
    reservations: null,
    thresholds: null,
    positiveControl: true,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].code, "positive-control");
  assert.equal(result.findings[0].severity, "warning");
  assert.match(result.findings[0].summary, /delivery test/u);
  assert.match(result.findings[0].summary, /pool is not affected/u);
});

test("listener-unreachable fires when any status is unavailable", () => {
  const missingListener = evaluate({ listener: null });
  assert.deepEqual(findingCodes(missingListener), ["listener-unreachable"]);
  assert.equal(missingListener.findings[0].severity, "operational");
  assert.equal(missingListener.exitCode, 2);

  const missingControl = evaluate({ control: null });
  assert.deepEqual(findingCodes(missingControl), ["listener-unreachable"]);
  assert.equal(missingControl.exitCode, 2);

  const missingReservations = evaluate({ reservations: null });
  assert.deepEqual(
    findingCodes(missingReservations),
    ["listener-unreachable"],
  );
  assert.equal(missingReservations.exitCode, 2);
});

test("listener-unreachable has precedence over partial listener findings", () => {
  const result = evaluate({
    listener: listenerStatus({
      enabled: false,
      exhaustionMarkers: ["alarm-failure-recovery-exhausted"],
    }),
    control: null,
  });
  assert.deepEqual(findingCodes(result), ["listener-unreachable"]);
  assert.equal(result.exitCode, 2);
});

test("listener-unconfigured fires without dwell", () => {
  const disabled = evaluate({
    listener: listenerStatus({ enabled: false }),
  });
  assert.deepEqual(findingCodes(disabled), ["listener-unconfigured"]);
  assert.equal(disabled.findings[0].severity, "critical");
  assert.equal(disabled.findings[0].fields.enabled, "false");

  const unconfigured = evaluate({
    listener: listenerStatus({ configured: false }),
  });
  assert.deepEqual(findingCodes(unconfigured), ["listener-unconfigured"]);
});

test("listener-stopped fires for each non-running listener mode", () => {
  for (const mode of ["drained", "stopped"]) {
    const result = evaluate({
      listener: listenerStatus({ mode, stoppedReason: "operator request" }),
    });
    assert.deepEqual(findingCodes(result), ["listener-stopped"]);
    assert.equal(result.findings[0].fields.stoppedReason, "operator request");
  }
});

test("listener-stopped ignores a missing or running mode", () => {
  const missingMode = listenerStatus();
  delete missingMode.mode;
  assert.deepEqual(findingCodes(evaluate({ listener: missingMode })), []);
  assert.deepEqual(
    findingCodes(evaluate({ listener: listenerStatus({ mode: "running" }) })),
    [],
  );
});

test("recovery-exhausted names its markers and matching conditions", () => {
  const marker = "alarm-failure-recovery-exhausted";
  const result = evaluate({
    listener: listenerStatus({
      exhaustionMarkers: [marker],
      recoveries: [
        {
          condition: "alarm-failure",
          exhaustedMarker: marker,
        },
        {
          condition: "session-expired",
          exhaustedMarker: null,
        },
      ],
    }),
  });
  assert.deepEqual(findingCodes(result), ["recovery-exhausted"]);
  assert.equal(result.findings[0].fields.exhaustionMarkers, marker);
  assert.equal(result.findings[0].fields.recoveryConditions, "alarm-failure");
});

test("an empty exhaustion marker array is healthy", () => {
  assert.deepEqual(
    findingCodes(evaluate({
      listener: listenerStatus({ exhaustionMarkers: [] }),
    })),
    [],
  );
});

test("control-status-unreadable fires and describes the unreliable view", () => {
  const result = evaluate({
    listener: listenerStatus({
      controlStatusReadFailed: true,
      advertisedMaxCapacity: 0,
    }),
  });
  assert.deepEqual(findingCodes(result), ["control-status-unreadable"]);
  assert.equal(result.findings[0].severity, "warning");
  assert.match(result.findings[0].detail, /unreliable/u);
});

test("advertised capacity zero is not a finding without the read flag", () => {
  assert.deepEqual(
    findingCodes(evaluate({
      listener: listenerStatus({ advertisedMaxCapacity: 0 }),
    })),
    [],
  );
});

test("listener-dark fires above the recovery threshold", () => {
  const result = evaluate({
    listener: listenerStatus({
      heartbeatAtMs: NOW_MS - RECOVERY_MAX_ELAPSED_MS - 1,
      heartbeatAgeMs: RECOVERY_MAX_ELAPSED_MS + 1,
    }),
  });
  assert.deepEqual(findingCodes(result), ["listener-dark"]);
  assert.equal(result.findings[0].severity, "critical");
});

test("listener-never-started fires when no alarm has completed", () => {
  const result = evaluate({
    listener: listenerStatus({
      heartbeatAtMs: null,
      heartbeatAgeMs: null,
    }),
  });
  assert.deepEqual(findingCodes(result), ["listener-never-started"]);
  assert.equal(result.findings[0].severity, "critical");
  assert.equal(result.findings[0].fields.heartbeatAgeMs, "null");
});

test("listener-never-started requires running mode", () => {
  const result = evaluate({
    listener: listenerStatus({
      mode: "stopped",
      heartbeatAtMs: null,
      heartbeatAgeMs: null,
    }),
  });
  assert.deepEqual(findingCodes(result), ["listener-stopped"]);
});

test("listener-dark has strict threshold boundaries", () => {
  const threshold = LISTENER_WATCHDOG_DEFAULTS.darkHeartbeatMs;
  for (const age of [threshold - 1, threshold]) {
    assert.deepEqual(
      findingCodes(evaluate({
        listener: listenerStatus({
          heartbeatAtMs: NOW_MS - age,
          heartbeatAgeMs: age,
        }),
      })),
      [],
    );
  }
  assert.deepEqual(
    findingCodes(evaluate({
      listener: listenerStatus({
        heartbeatAtMs: NOW_MS - threshold - 1,
        heartbeatAgeMs: threshold + 1,
      }),
    })),
    ["listener-dark"],
  );
});

test("listener-dark requires a configured running listener", () => {
  const result = evaluate({
    listener: listenerStatus({
      mode: "stopped",
      heartbeatAtMs: NOW_MS - RECOVERY_MAX_ELAPSED_MS - 1,
      heartbeatAgeMs: RECOVERY_MAX_ELAPSED_MS + 1,
    }),
  });
  assert.deepEqual(findingCodes(result), ["listener-stopped"]);
});

test("admission-floor fires without dwell at the floor", () => {
  const result = evaluate({
    listener: listenerStatus({
      admissionLimit: MIN_ADMISSION_LIMIT,
      admissionLimited: true,
    }),
  });
  assert.deepEqual(findingCodes(result), ["admission-floor"]);
  assert.equal(result.findings[0].severity, "warning");
});

test("admission-floor does not require the floor to bind this poll", () => {
  const result = evaluate({
    listener: listenerStatus({
      admissionLimit: MIN_ADMISSION_LIMIT,
      admissionLimited: false,
    }),
  });
  assert.deepEqual(findingCodes(result), ["admission-floor"]);
  assert.equal(result.findings[0].fields.admissionLimited, "false");
});

test("admission-floor ignores the unrestricted null limit", () => {
  assert.deepEqual(findingCodes(evaluate({
    listener: listenerStatus({
      admissionLimit: null,
      admissionLimited: false,
    }),
  })), []);
});

test("admission-floor has inclusive floor boundaries", () => {
  const thresholds = {
    ...LISTENER_WATCHDOG_DEFAULTS,
    admissionFloor: 2,
  };
  for (const limit of [1, 2]) {
    assert.deepEqual(
      findingCodes(evaluate({
        listener: listenerStatus({
          admissionLimit: limit,
          admissionLimited: true,
        }),
        thresholds,
      })),
      ["admission-floor"],
    );
  }
  assert.deepEqual(
    findingCodes(evaluate({
      listener: listenerStatus({
        admissionLimit: 3,
        admissionLimited: true,
      }),
      thresholds,
    })),
    [],
  );
});

test("registration-leak fires above the active runner ceiling", () => {
  const result = evaluate({
    listener: listenerStatus({
      latestStatistics: { totalRegisteredRunners: 1595 },
    }),
  });

  assert.deepEqual(findingCodes(result), ["registration-leak"]);
  assert.equal(result.findings[0].severity, "critical");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.findings[0].fields, {
    registeredRunners: 1595,
    maxActiveRunners: 300,
  });
});

test("registration-leak does not fire at the active runner ceiling", () => {
  const result = evaluate({
    listener: listenerStatus({
      latestStatistics: { totalRegisteredRunners: 300 },
    }),
  });

  assert.equal(
    result.findings.some(({ code }) => code === "registration-leak"),
    false,
  );
});

test("registration-leak does not require reservations or a decision", () => {
  for (const reservations of [null, "unreadable"]) {
    const result = evaluate({
      listener: listenerStatus({
        latestStatistics: { totalRegisteredRunners: 1595 },
        scaleUp: { lastDecision: null },
      }),
      reservations,
    });
    const leak = result.findings.find(
      ({ code }) => code === "registration-leak",
    );

    assert.equal(leak?.severity, "critical");
    assert.deepEqual(leak?.fields, {
      registeredRunners: 1595,
      maxActiveRunners: 300,
    });
  }
});

test("reservations-stranded fires at both inclusive thresholds", () => {
  const result = evaluate({
    listener: listenerStatus({
      latestStatistics: { totalRegisteredRunners: 3 },
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 3,
          shortfall: 0,
        },
      },
    }),
    control: controlStatus({
      liveReservationCount: 5,
    }),
    reservations: reservationStatus({
      reservations: [reservation({
        requestedAtMs: NOW_MS -
          LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs,
      })],
      summary: {
        liveReservationCount: 5,
      },
    }),
  });
  assert.deepEqual(findingCodes(result), ["reservations-stranded"]);
  assert.deepEqual(result.findings[0].fields, {
    strandedCount: 2,
    oldestLiveReservationAgeMs:
      LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs,
    liveReservationCount: 5,
    registeredRunners: 3,
    desired: 3,
    shortfall: 0,
  });
});

test("reservations-stranded does not fire below the count threshold", () => {
  const result = evaluate({
    listener: listenerStatus({
      latestStatistics: { totalRegisteredRunners: 4 },
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 4,
          shortfall: 0,
        },
      },
    }),
    reservations: reservationStatus({
      reservations: [reservation({
        requestedAtMs: NOW_MS -
          LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs,
      })],
      summary: { liveReservationCount: 5 },
    }),
  });
  assert.deepEqual(findingCodes(result), []);
});

test("reservations-stranded does not fire below the age threshold", () => {
  const age = LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs - 1;
  const result = evaluate({
    listener: listenerStatus({
      latestStatistics: { totalRegisteredRunners: 3 },
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 3,
          shortfall: 0,
        },
      },
    }),
    reservations: reservationStatus({
      reservations: [reservation({ requestedAtMs: NOW_MS - age })],
      summary: { liveReservationCount: 5 },
    }),
  });
  assert.deepEqual(findingCodes(result), []);
});

test("a fresh non-consumed reservation does not read as an hour old", () => {
  const result = evaluate({
    listener: listenerStatus({
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 2,
          shortfall: 0,
        },
      },
    }),
    reservations: reservationStatus({
      reservations: [reservation({
        state: "reserved",
        requestedAtMs: NOW_MS - 1_000,
      })],
      summary: { liveReservationCount: 2 },
    }),
  });
  assert.deepEqual(findingCodes(result), []);
});

test("hasMore true with a full page does not change strandedCount", () => {
  const age = LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs;
  const rows = Array.from({ length: 100 }, (_, index) => reservation({
    reservationId: `reservation-${String(index).padStart(3, "0")}`,
    requestedAtMs: NOW_MS - age + index,
    live: index < 5,
  }));
  const result = evaluate({
    listener: listenerStatus({
      latestStatistics: { totalRegisteredRunners: 3 },
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 3,
          shortfall: 0,
        },
      },
    }),
    reservations: reservationStatus({
      reservations: rows,
      hasMore: true,
      nextCursor: "next-page",
      summary: { liveReservationCount: 5 },
    }),
  });
  assert.deepEqual(findingCodes(result), ["reservations-stranded"]);
  assert.equal(result.findings[0].fields.strandedCount, 2);
});

test("a zero live reservation census never produces a finding", () => {
  const age = LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs;
  const result = evaluate({
    listener: listenerStatus({
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 2,
          shortfall: 0,
        },
      },
    }),
    reservations: reservationStatus({
      reservations: [reservation({ requestedAtMs: NOW_MS - age })],
      summary: { liveReservationCount: 0 },
    }),
  });
  assert.deepEqual(findingCodes(result), []);
});

test("the oldest age uses live rows and ignores non-live rows", () => {
  const threshold = LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs;
  const expectedAge = threshold + 1_000;
  const result = evaluate({
    listener: listenerStatus({
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 2,
          shortfall: 0,
        },
      },
    }),
    reservations: reservationStatus({
      reservations: [
        reservation({
          reservationId: "old-terminal",
          requestedAtMs: NOW_MS - threshold - 5_000,
          live: false,
        }),
        reservation({
          reservationId: "oldest-live",
          requestedAtMs: NOW_MS - expectedAge,
        }),
        reservation({
          reservationId: "newer-live",
          requestedAtMs: NOW_MS - threshold,
        }),
      ],
      summary: { liveReservationCount: 2 },
    }),
  });
  assert.deepEqual(findingCodes(result), ["reservations-stranded"]);
  assert.equal(
    result.findings[0].fields.oldestLiveReservationAgeMs,
    expectedAge,
  );
});

test("a page without a live row fails closed", () => {
  const result = evaluate({
    listener: listenerStatus({
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 2,
          shortfall: 0,
        },
      },
    }),
    reservations: reservationStatus({
      reservations: [reservation({
        requestedAtMs: NOW_MS -
          LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs,
        live: false,
      })],
      hasMore: true,
      nextCursor: "next-page",
      summary: { liveReservationCount: 2 },
    }),
  });
  assert.deepEqual(findingCodes(result), []);
});

test("an unordered reservation page fails closed", () => {
  const threshold = LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs;
  const result = evaluate({
    listener: listenerStatus({
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 2,
          shortfall: 0,
        },
      },
    }),
    reservations: reservationStatus({
      reservations: [
        reservation({ requestedAtMs: NOW_MS - threshold }),
        reservation({ requestedAtMs: NOW_MS - threshold - 1 }),
      ],
      summary: { liveReservationCount: 2 },
    }),
  });
  assert.deepEqual(findingCodes(result), []);
});

test("reservations-stranded requires the documented decision arithmetic", () => {
  const decisions = [
    { reason: "evaluated", desired: 2, shortfall: 0 },
    { reason: "no-shortfall", desired: 0, shortfall: 0 },
    { reason: "no-shortfall", desired: 2, shortfall: 1 },
  ];
  for (const lastDecision of decisions) {
    const result = evaluate({
      listener: listenerStatus({ scaleUp: { lastDecision } }),
      reservations: reservationStatus({
        reservations: [reservation({
          requestedAtMs: NOW_MS -
            LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs,
        })],
        summary: { liveReservationCount: 2 },
      }),
    });
    assert.deepEqual(findingCodes(result), []);
  }
});

test("an unreadable control status suppresses the stranded detector", () => {
  const result = evaluate({
    listener: listenerStatus({
      controlStatusReadFailed: true,
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 2,
          shortfall: 0,
        },
      },
    }),
    reservations: reservationStatus({
      reservations: [reservation({
        requestedAtMs: NOW_MS -
          LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs,
      })],
      summary: { liveReservationCount: 2 },
    }),
  });
  assert.deepEqual(findingCodes(result), ["control-status-unreadable"]);
});

test("malformed nested status data never throws or invents a finding", () => {
  const malformedListeners = [
    listenerStatus({ scaleUp: undefined }),
    listenerStatus({ scaleUp: { lastDecision: null } }),
    listenerStatus({ scaleUp: "invalid" }),
    listenerStatus({ admissionLimit: "1", admissionLimited: true }),
    listenerStatus({ heartbeatAgeMs: "900001" }),
    listenerStatus({ unknown: { nested: true } }),
  ];
  for (const listener of malformedListeners) {
    assert.doesNotThrow(() => evaluate({ listener }));
    assert.deepEqual(findingCodes(evaluate({ listener })), []);
  }

  const malformedControl = controlStatus({
    liveReservationCount: "2",
    nextReclaimAtMs: "1800000000000",
  });
  const listener = listenerStatus({
    scaleUp: {
      lastDecision: { reason: "no-shortfall", desired: "0" },
    },
  });
  assert.doesNotThrow(() => evaluate({ listener, control: malformedControl }));
  assert.deepEqual(findingCodes(evaluate({
    listener,
    control: malformedControl,
  })), []);
});

test("malformed recovery rows do not throw", () => {
  const result = evaluate({
    listener: listenerStatus({
      exhaustionMarkers: ["alarm-failure-recovery-exhausted"],
      recoveries: [null, "invalid", { condition: 1 }],
    }),
  });
  assert.deepEqual(findingCodes(result), ["recovery-exhausted"]);
  assert.equal(result.findings[0].fields.recoveryConditions, "unavailable");
});

test("findings preserve the documented precedence", () => {
  const marker = "alarm-failure-recovery-exhausted";
  const result = evaluate({
    listener: listenerStatus({
      mode: "stopped",
      stoppedReason: marker,
      exhaustionMarkers: [marker],
      recoveries: [
        { condition: "alarm-failure", exhaustedMarker: marker },
      ],
      controlStatusReadFailed: true,
      admissionLimit: 1,
      admissionLimited: true,
    }),
  });
  assert.deepEqual(findingCodes(result), [
    "listener-stopped",
    "recovery-exhausted",
    "control-status-unreadable",
    "admission-floor",
  ]);
  assert.equal(result.exitCode, 1);
});

test("every finding field value is a string or number", () => {
  const result = evaluate({
    listener: listenerStatus({
      enabled: false,
      stoppedReason: null,
      exhaustionMarkers: ["marker"],
      recoveries: [],
      controlStatusReadFailed: true,
      admissionLimit: 1,
      admissionLimited: true,
    }),
  });
  for (const item of result.findings) {
    for (const value of Object.values(item.fields)) {
      assert.equal(["string", "number"].includes(typeof value), true);
    }
  }
});

test("the CLI returns zero and one with JSON results", (t) => {
  const directory = temporaryDirectory(t);
  const healthy = writeStatuses(
    directory,
    listenerStatus(),
    controlStatus(),
  );
  const healthyResult = runCli([
    "evaluate",
    healthy.listenerPath,
    healthy.controlPath,
    healthy.reservationPath,
    "--now",
    String(NOW_MS),
  ]);
  assert.equal(healthyResult.status, 0, healthyResult.stderr);
  assert.deepEqual(JSON.parse(healthyResult.stdout), {
    findings: [],
    exitCode: 0,
  });

  writeFileSync(
    healthy.listenerPath,
    JSON.stringify(listenerStatus({ enabled: false })),
  );
  const findingResult = runCli([
    "evaluate",
    healthy.listenerPath,
    healthy.controlPath,
    healthy.reservationPath,
    "--now",
    String(NOW_MS),
  ]);
  assert.equal(findingResult.status, 1, findingResult.stderr);
  assert.deepEqual(
    findingCodes(JSON.parse(findingResult.stdout)),
    ["listener-unconfigured"],
  );
});

test("the CLI positive control returns its finding with exit zero", () => {
  const result = runCli(["evaluate", "--positive-control"], {
    LISTENER_WATCHDOG_DARK_MS: "invalid-but-unused",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.exitCode, 0);
  assert.deepEqual(findingCodes(output), ["positive-control"]);
});

test("the CLI uses --now for reservation age", (t) => {
  const directory = temporaryDirectory(t);
  const paths = writeStatuses(
    directory,
    listenerStatus({
      latestStatistics: { totalRegisteredRunners: 0 },
      scaleUp: {
        lastDecision: {
          reason: "no-shortfall",
          desired: 2,
          shortfall: 0,
        },
      },
    }),
    controlStatus(),
    reservationStatus({
      reservations: [reservation({
        requestedAtMs: NOW_MS -
          LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs,
      })],
      summary: { liveReservationCount: 2 },
    }),
  );
  const result = runCli([
    "evaluate",
    paths.listenerPath,
    paths.controlPath,
    paths.reservationPath,
    "--now",
    String(NOW_MS),
  ]);
  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(
    output.findings[0].fields.oldestLiveReservationAgeMs,
    LISTENER_WATCHDOG_DEFAULTS.strandedReservationAgeMs,
  );
});

test("the CLI returns two for a null status", (t) => {
  const directory = temporaryDirectory(t);
  const paths = writeStatuses(directory, null, controlStatus());
  const result = runCli([
    "evaluate",
    paths.listenerPath,
    paths.controlPath,
    paths.reservationPath,
    "--now",
    String(NOW_MS),
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(
    findingCodes(JSON.parse(result.stdout)),
    ["listener-unreachable"],
  );
});

test("the CLI rejects bad JSON", (t) => {
  const directory = temporaryDirectory(t);
  const paths = writeStatuses(
    directory,
    listenerStatus(),
    controlStatus(),
  );
  writeFileSync(paths.listenerPath, "{");
  const result = runCli([
    "evaluate",
    paths.listenerPath,
    paths.controlPath,
    paths.reservationPath,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cannot parse listener status file/u);
  assert.equal(result.stdout, "");
});

test("the CLI rejects a missing file", (t) => {
  const directory = temporaryDirectory(t);
  const controlPath = join(directory, "control.json");
  const reservationPath = join(directory, "reservations.json");
  writeFileSync(controlPath, JSON.stringify(controlStatus()));
  writeFileSync(reservationPath, JSON.stringify(reservationStatus()));
  const result = runCli([
    "evaluate",
    join(directory, "missing.json"),
    controlPath,
    reservationPath,
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cannot read listener status file/u);
});

test("the CLI rejects an unknown subcommand", () => {
  const result = runCli(["unknown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/u);
});

test("the CLI rejects a non-integer threshold override", (t) => {
  const directory = temporaryDirectory(t);
  const paths = writeStatuses(
    directory,
    listenerStatus(),
    controlStatus(),
  );
  const result = runCli(
    [
      "evaluate",
      paths.listenerPath,
      paths.controlPath,
      paths.reservationPath,
    ],
    { LISTENER_WATCHDOG_DARK_MS: "1.5" },
  );
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /LISTENER_WATCHDOG_DARK_MS must be a non-negative safe integer/u,
  );
  assert.equal(result.stdout, "");
});

test("the CLI applies a valid threshold override", (t) => {
  const directory = temporaryDirectory(t);
  const paths = writeStatuses(
    directory,
    listenerStatus({
      heartbeatAtMs: NOW_MS - 101,
      heartbeatAgeMs: 101,
    }),
    controlStatus(),
  );
  const result = runCli(
    [
      "evaluate",
      paths.listenerPath,
      paths.controlPath,
      paths.reservationPath,
      "--now",
      String(NOW_MS),
    ],
    { LISTENER_WATCHDOG_DARK_MS: "100" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    findingCodes(JSON.parse(result.stdout)),
    ["listener-dark"],
  );
});
