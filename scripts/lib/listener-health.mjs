import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Production lost 7 of 10 Worker variables during a deploy. The listener
// stopped, and 30 jobs waited for 13 minutes without an alert.
// Nineteen finished runners then retained reservations for one hour. The pool
// recovered only when the reservation backstop expired.
// The learned admission limit also fell to one and repeatedly slowed jobs.
// Before this watchdog, the orphan audit Slack webhook was the only alert path.
// A merge queue that depends on this pool stops with it, so silence is costly.

// src/scaleset-listener.js derives this value from POLL_TIMEOUT_MS (50,000)
// plus ALARM_WORK_BUDGET_MS (10,000).
const HEARTBEAT_STALE_MS = 60_000;
// src/scaleset-listener.js sets this value to ALARM_WALL_BUDGET_MS (900,000).
const RECOVERY_MAX_ELAPSED_MS = 900_000;
// src/scaleset-listener.js defines one as the learned admission limit floor.
const MIN_ADMISSION_LIMIT = 1;
// src/runner-policy.js derives this value from
// DEFAULT_RECONCILE_MAX_AGE_SECONDS (3,600) multiplied by 1,000.
const ACTIVE_RUNNER_CLEANUP_DELAY_MS = 3_600_000;
// src/autopilot-control.js defines this hard ceiling on live runners. GitHub
// never removes a runner registration on its own, so a registered count above
// this ceiling is a deregistration path that has stopped. This is a repository
// constant, not an operator-selected threshold, so it is deliberately absent
// from LISTENER_WATCHDOG_DEFAULTS and cannot be retuned by an operator.
const MAX_ACTIVE_RUNNERS = 300;

export const LISTENER_HEALTH_CONSTANTS = Object.freeze({
  HEARTBEAT_STALE_MS,
  RECOVERY_MAX_ELAPSED_MS,
  MIN_ADMISSION_LIMIT,
  ACTIVE_RUNNER_CLEANUP_DELAY_MS,
  MAX_ACTIVE_RUNNERS,
});

// docs/AUTOPILOT-DESIGN.md:1323-1325 documents a 50-second idle heartbeat
// cadence and a 60-second maximum cadence. Lines 1327-1328 and
// docs/AUTOPILOT-OPERATIONS.md:1053 define an age above 60 seconds as stale.
// That documented diagnostic value conflicts with the valid recovery ladder,
// which can run for RECOVERY_MAX_ELAPSED_MS. The unattended default keeps the
// full recovery window and records that tension. LIMITS.md:617-620 says paced
// work shortens the long poll to a 1-second floor and never lengthens it, so
// pacing makes the heartbeat faster and cannot cause listener-dark.
const darkHeartbeatMs = RECOVERY_MAX_ELAPSED_MS;
// The repository constant defines the admission floor. This is not a selected
// operating value.
const admissionFloor = MIN_ADMISSION_LIMIT;
// This is one half of the repository's one-hour cleanup backstop. The only
// teardown evidence is one normal sample of about 67 seconds at
// MEASUREMENTS.md:516-519 and failure lower bounds above four minutes at
// MEASUREMENTS.md:483-491 and LIMITS.md:507-513. The repository has no measured
// job-duration distribution. An operator can retune this value from evidence
// with LISTENER_WATCHDOG_STRANDED_AGE_MS.
const strandedReservationAgeMs = ACTIVE_RUNNER_CLEANUP_DELAY_MS / 2;
// The repository has no measured normal reservation excess. Two is the
// smallest count that ignores one runner that is only slow to be destroyed.
// The production incident retained 19 reservations. An operator can retune
// this value with LISTENER_WATCHDOG_STRANDED_COUNT.
const strandedReservationCount = 2;

export const LISTENER_WATCHDOG_DEFAULTS = Object.freeze({
  darkHeartbeatMs,
  admissionFloor,
  strandedReservationAgeMs,
  strandedReservationCount,
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function resolvedThresholds(thresholds) {
  const supplied = thresholds === undefined
    ? {}
    : thresholds;
  if (!isObject(supplied)) {
    throw new TypeError("thresholds must be an object");
  }
  const result = {
    ...LISTENER_WATCHDOG_DEFAULTS,
    ...supplied,
  };
  for (const [name, value] of Object.entries(result)) {
    if (!nonNegativeSafeInteger(value)) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return result;
}

function scalarField(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "missing";
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function finding(code, severity, summary, detail, action, fields) {
  return { code, severity, summary, detail, action, fields };
}

function runnerRegistrationLeakFinding(registeredRunners) {
  if (
    nonNegativeSafeInteger(registeredRunners) &&
    registeredRunners > MAX_ACTIVE_RUNNERS
  ) {
    return finding(
      "registration-leak",
      "critical",
      "GitHub holds more runner registrations than the pool can ever run.",
      "Deregistration has stopped. Every statistic that drives scale-up is reported against these registrations, so the pool reads its own leaked runners as demand and spawns without end.",
      "Stop the fleet. Delete the stale registrations, then confirm RUNNER_REGISTRATION_DELETE is not off before you re-enable it.",
      {
        registeredRunners,
        maxActiveRunners: MAX_ACTIVE_RUNNERS,
      },
    );
  }
  return null;
}

function reservationPageIsOrdered(reservations) {
  if (!Array.isArray(reservations)) {
    return false;
  }
  let previousRequestedAtMs = -1;
  for (const reservation of reservations) {
    if (
      !isObject(reservation) ||
      !nonNegativeSafeInteger(reservation.requestedAtMs) ||
      reservation.requestedAtMs < previousRequestedAtMs
    ) {
      return false;
    }
    previousRequestedAtMs = reservation.requestedAtMs;
  }
  return true;
}

export function evaluateListenerHealth({
  listenerStatus,
  controlStatus,
  reservationStatus,
  nowMs,
  thresholds,
  positiveControl = false,
}) {
  if (positiveControl === true) {
    return {
      findings: [finding(
        "positive-control",
        "warning",
        "This is a delivery test. The runner pool is not affected.",
        "The watchdog generated this fixed finding to prove the Slack delivery path.",
        "Confirm that this positive-control message reached the expected Slack channel.",
        { positiveControl: "true" },
      )],
      exitCode: 0,
    };
  }

  const limits = resolvedThresholds(thresholds);
  const findings = [];

  if (
    !isObject(listenerStatus) ||
    !isObject(controlStatus) ||
    !isObject(reservationStatus)
  ) {
    findings.push(finding(
      "listener-unreachable",
      "operational",
      "The watchdog could not read all three status endpoints.",
      "A missing status can mean a deleted CONTROL_TOKEN, an HTTP failure, or a dead Worker.",
      "Check WORKER_URL and CONTROL_TOKEN. Restore the Worker, then run the watchdog again.",
      {
        listenerStatus: isObject(listenerStatus) ? "available" : "unavailable",
        controlStatus: isObject(controlStatus) ? "available" : "unavailable",
        reservationStatus: isObject(reservationStatus)
          ? "available"
          : "unavailable",
      },
    ));
    const latestStatistics = isObject(listenerStatus?.latestStatistics)
      ? listenerStatus.latestStatistics
      : null;
    const registrationLeak = runnerRegistrationLeakFinding(
      latestStatistics?.totalRegisteredRunners ?? 0,
    );
    if (registrationLeak !== null) {
      findings.push(registrationLeak);
    }
    return { findings, exitCode: 2 };
  }

  if (listenerStatus.enabled !== true || listenerStatus.configured !== true) {
    findings.push(finding(
      "listener-unconfigured",
      "critical",
      "The listener is disabled or unconfigured.",
      "This check has no dwell. It detects a dropped AUTOPILOT_ENABLED, GITHUB_TOKEN, or scale-set configuration on the first poll.",
      "Restore the missing Worker configuration. Deploy it, then resume and verify the listener.",
      {
        enabled: scalarField(listenerStatus.enabled),
        configured: scalarField(listenerStatus.configured),
        mode: scalarField(listenerStatus.mode),
        stoppedReason: scalarField(listenerStatus.stoppedReason),
      },
    ));
  }

  if (
    listenerStatus.enabled === true &&
    listenerStatus.configured === true &&
    typeof listenerStatus.mode === "string" &&
    listenerStatus.mode !== "running"
  ) {
    findings.push(finding(
      "listener-stopped",
      "critical",
      "The configured listener is not running.",
      "The listener mode is drained or stopped. The public stopped reason identifies the recorded cause.",
      "Read stoppedReason. Fix the cause, then resume or rearm the listener.",
      {
        mode: listenerStatus.mode,
        stoppedReason: scalarField(listenerStatus.stoppedReason),
      },
    ));
  }

  if (
    Array.isArray(listenerStatus.exhaustionMarkers) &&
    listenerStatus.exhaustionMarkers.length > 0
  ) {
    const markerValues = listenerStatus.exhaustionMarkers.map(scalarField);
    const markerNames = new Set(
      listenerStatus.exhaustionMarkers.filter((value) =>
        typeof value === "string"
      ),
    );
    const conditions = Array.isArray(listenerStatus.recoveries)
      ? listenerStatus.recoveries
        .filter((recovery) =>
          isObject(recovery) &&
          typeof recovery.condition === "string" &&
          markerNames.has(recovery.exhaustedMarker)
        )
        .map((recovery) => recovery.condition)
      : [];
    findings.push(finding(
      "recovery-exhausted",
      "critical",
      "The listener recovery ladder is exhausted.",
      "The listener stopped retrying. This check has no dwell because an operator must restart recovery.",
      "Fix the recorded recovery condition, then rearm and verify the listener.",
      {
        exhaustionMarkers: markerValues.join(", "),
        recoveryConditions: [...new Set(conditions)].join(", ") || "unavailable",
      },
    ));
  }

  if (listenerStatus.controlStatusReadFailed === true) {
    findings.push(finding(
      "control-status-unreadable",
      "warning",
      "The listener could not read AutopilotControl.",
      "The listener forced advertisedMaxCapacity to zero. The reservation view is unreliable for this poll.",
      "Inspect AutopilotControl and its Durable Object request. Retry the status poll after recovery.",
      {
        controlStatusReadFailed: "true",
        advertisedMaxCapacity: scalarField(
          listenerStatus.advertisedMaxCapacity,
        ),
      },
    ));
  }

  const listenerRunning = listenerStatus.enabled === true &&
    listenerStatus.configured === true &&
    listenerStatus.mode === "running";
  const heartbeatAgeIsNumber =
    typeof listenerStatus.heartbeatAgeMs === "number" &&
    Number.isFinite(listenerStatus.heartbeatAgeMs);

  // docs/AUTOPILOT-OPERATIONS.md:687 defines a null heartbeat as no completed
  // listener alarm, which is distinct from a stale heartbeat. Lines 474-476
  // require this check after every deploy. This zero-dwell finding implements
  // that documented post-deploy incident detector.
  if (
    listenerStatus.mode === "running" &&
    listenerStatus.heartbeatAtMs === null
  ) {
    findings.push(finding(
      "listener-never-started",
      "critical",
      "The running listener has never completed an alarm.",
      "A null heartbeat means no listener alarm completed after deployment or initialization.",
      "Resume the listener, then read its status and confirm a completed heartbeat.",
      {
        mode: listenerStatus.mode,
        heartbeatAtMs: "null",
        heartbeatAgeMs: scalarField(listenerStatus.heartbeatAgeMs),
      },
    ));
  }

  if (
    listenerRunning &&
    listenerStatus.heartbeatAtMs !== null &&
    heartbeatAgeIsNumber &&
    listenerStatus.heartbeatAgeMs > limits.darkHeartbeatMs
  ) {
    findings.push(finding(
      "listener-dark",
      "critical",
      "The running listener has no recent completed heartbeat.",
      "The 60-second diagnostic age is valid for manual inspection. This unattended alert waits for the full recovery window.",
      "Inspect the listener alarm and recovery state. Rearm the observed alarm generation after you fix the cause.",
      {
        heartbeatAtMs: scalarField(listenerStatus.heartbeatAtMs),
        heartbeatAgeMs: scalarField(listenerStatus.heartbeatAgeMs),
        darkHeartbeatMs: limits.darkHeartbeatMs,
      },
    ));
  }

  // src/scaleset-listener.js:56-65 defines the floor, eight-success probe, and
  // 60-second damping interval. Lines 3616-3618 define null as unrestricted.
  // Lines 3577-3582 and 1063-1072 let one harm observation lower the limit
  // immediately to the floor. Lines 3629-3638 permit only a +1 raise after
  // eight verified deliveries, a binding limit, and the damping interval.
  // There is no time decay. Recovery from 1 to the ceiling of 300 therefore
  // takes at least 299 minutes of perfect deliveries. The floor finding has
  // zero dwell even when admissionLimited is false at this poll.
  if (
    typeof listenerStatus.admissionLimit === "number" &&
    Number.isFinite(listenerStatus.admissionLimit) &&
    listenerStatus.admissionLimit <= limits.admissionFloor
  ) {
    findings.push(finding(
      "admission-floor",
      "warning",
      "The learned admission limit is at its floor.",
      "The controller was harmed before this poll, and perfect recovery from 1 to 300 needs at least 299 minutes.",
      "Inspect recent start refusals. Reset the learned admission limit only after you fix the capacity cause.",
      {
        admissionLimit: listenerStatus.admissionLimit,
        admissionFloor: limits.admissionFloor,
        admissionLimited: scalarField(listenerStatus.admissionLimited),
      },
    ));
  }

  const scaleUp = isObject(listenerStatus.scaleUp)
    ? listenerStatus.scaleUp
    : null;
  const lastDecision = isObject(scaleUp?.lastDecision)
    ? scaleUp.lastDecision
    : null;
  const desiredValue = lastDecision?.desired;
  const shortfallValue = lastDecision?.shortfall;
  const latestStatistics = isObject(listenerStatus.latestStatistics)
    ? listenerStatus.latestStatistics
    : null;
  const registeredRunners =
    latestStatistics?.totalRegisteredRunners ?? 0;
  const registrationLeak = runnerRegistrationLeakFinding(registeredRunners);
  if (registrationLeak !== null) {
    findings.push(registrationLeak);
  }
  const reservationSummary = isObject(reservationStatus.summary)
    ? reservationStatus.summary
    : null;
  const reservationRows = reservationStatus.reservations;
  const reservationInputsAreNumbers =
    nonNegativeSafeInteger(reservationSummary?.liveReservationCount) &&
    nonNegativeSafeInteger(desiredValue) &&
    nonNegativeSafeInteger(shortfallValue) &&
    nonNegativeSafeInteger(registeredRunners) &&
    nonNegativeSafeInteger(nowMs);

  // docs/AUTOPILOT-OPERATIONS.md:884-885 says to inspect the reservation
  // census when desired > 0 and shortfall is zero. That state is also a healthy
  // satisfied pool. GitHub statistics lag new reservations until a message
  // carries statistics (docs/LISTENER-ACQUISITION-DIAGNOSIS.md:202-208).
  // docs/AUTOPILOT-DESIGN.md:1323-1325 bounds that normal lag at one 60-second
  // poll. The 30-minute age gate is load-bearing: it is 30 times that maximum
  // cadence and separates a persistent stale reservation from the normal lag.
  //
  // listReservations orders by requested_at_ms and reservation_id ascending at
  // src/autopilot-control.js:1303-1311. The cursor uses the same keys at
  // lines 373-379. Therefore, the first live row on page one is the globally
  // oldest live reservation. Exactness depends on that ordering. An unordered
  // page, or a page with no visible live row, fails closed without a finding.
  //
  // summary.liveReservationCount is the whole-table SQL COUNT from
  // src/autopilot-control.js:641-655 and 1332-1344. The rows are one bounded
  // page. Counting reservations.length would treat a truncated page as a
  // complete census, so strandedCount never uses the returned row count.
  if (
    listenerStatus.controlStatusReadFailed !== true &&
    lastDecision?.reason === "no-shortfall" &&
    desiredValue > 0 &&
    shortfallValue === 0 &&
    reservationInputsAreNumbers &&
    reservationSummary.liveReservationCount > 0 &&
    reservationPageIsOrdered(reservationRows)
  ) {
    const liveReservations = reservationRows.filter((reservation) =>
      reservation.live === true
    );
    const oldestRequestedAtMs = liveReservations[0]?.requestedAtMs;
    if (oldestRequestedAtMs === undefined) {
      return {
        findings,
        exitCode: findings.length === 0 ? 0 : 1,
      };
    }
    const strandedCount = reservationSummary.liveReservationCount -
      registeredRunners;
    const oldestLiveReservationAgeMs = nowMs - oldestRequestedAtMs;
    if (
      strandedCount >= limits.strandedReservationCount &&
      oldestLiveReservationAgeMs >= limits.strandedReservationAgeMs
    ) {
      findings.push(finding(
        "reservations-stranded",
        "critical",
        "Old live reservations cover demand but exceed registered runners.",
        "GitHub reports no shortfall, but old reservations can belong to runners that already finished.",
        "Inspect the reservation list. Release completed runners and fix the missing release path.",
        {
          strandedCount,
          oldestLiveReservationAgeMs,
          liveReservationCount: reservationSummary.liveReservationCount,
          registeredRunners,
          desired: desiredValue,
          shortfall: shortfallValue,
        },
      ));
    }
  }

  return {
    findings,
    exitCode: findings.length === 0 ? 0 : 1,
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/lib/listener-health.mjs evaluate <listener-status.json> <control-status.json> <reservation-status.json> [--now <ms>]",
    "  node scripts/lib/listener-health.mjs evaluate --positive-control",
  ].join("\n");
}

function parseInteger(value, name) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  const parsed = Number(value);
  if (!nonNegativeSafeInteger(parsed)) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return parsed;
}

function thresholdOverrides(environment) {
  const mappings = [
    ["LISTENER_WATCHDOG_DARK_MS", "darkHeartbeatMs"],
    ["LISTENER_WATCHDOG_STRANDED_AGE_MS", "strandedReservationAgeMs"],
    ["LISTENER_WATCHDOG_STRANDED_COUNT", "strandedReservationCount"],
  ];
  const thresholds = { ...LISTENER_WATCHDOG_DEFAULTS };
  for (const [environmentName, thresholdName] of mappings) {
    const value = environment[environmentName];
    if (value === undefined || value === "") {
      continue;
    }
    thresholds[thresholdName] = parseInteger(value, environmentName);
  }
  return thresholds;
}

function evaluateArguments(args) {
  const paths = [];
  let nowMs = Date.now();
  let positiveControl = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--positive-control") {
      positiveControl = true;
      continue;
    }
    if (argument === "--now") {
      if (index + 1 >= args.length) {
        throw new Error(usage());
      }
      nowMs = parseInteger(args[index + 1], "--now");
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(usage());
    }
    paths.push(argument);
  }
  if (positiveControl) {
    if (paths.length !== 0) {
      throw new Error(usage());
    }
    return { positiveControl: true };
  }
  if (paths.length !== 3) {
    throw new Error(usage());
  }
  return {
    listenerPath: paths[0],
    controlPath: paths[1],
    reservationPath: paths[2],
    nowMs,
    positiveControl: false,
  };
}

function readStatus(path, label) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${label} status file ${path}: ${message}`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot parse ${label} status file ${path}: ${message}`, {
      cause: error,
    });
  }
}

function runCli(args, environment) {
  const [command, ...commandArguments] = args;
  if (command !== "evaluate") {
    throw new Error(usage());
  }
  const evaluation = evaluateArguments(commandArguments);
  if (evaluation.positiveControl) {
    const result = evaluateListenerHealth({ positiveControl: true });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
    return;
  }
  const {
    listenerPath,
    controlPath,
    reservationPath,
    nowMs,
  } = evaluation;
  const result = evaluateListenerHealth({
    listenerStatus: readStatus(listenerPath, "listener"),
    controlStatus: readStatus(controlPath, "control"),
    reservationStatus: readStatus(reservationPath, "reservation"),
    nowMs,
    thresholds: thresholdOverrides(environment),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  try {
    runCli(process.argv.slice(2), process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  }
}
