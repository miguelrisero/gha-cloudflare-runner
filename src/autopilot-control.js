import { DurableObject } from "cloudflare:workers";

import {
  isPlainObject,
  isPositiveSafeInteger,
  isRepositoryName,
} from "./scaleset-protocol.js";
import { ACTIVE_RUNNER_CLEANUP_DELAY_MS } from "./runner-policy.js";

// This admission ceiling bounds live reservations and caps a signed approval.
// It is not a page size or an error threshold. It MUST equal wrangler.jsonc
// containers[0].max_instances. A mismatch rejects allowed reservations or
// admits reservations that the platform cannot start.
export const MAX_ACTIVE_RUNNERS = 300;
// This value bounds one page of a cursor walk, not the whole response. It
// equals RUNNER_LIST_PAGE_SIZE, so both operator walks page identically. At
// MAX_ACTIVE_RUNNERS = 300, a full enumeration takes three requests. The
// Math.min limit clamp keeps this value as a ceiling.
export const RESERVATION_LIST_PAGE_SIZE = 100;
// No signed capacity approval means no capacity. The owner approving a policy
// ceiling is not the same act as signing a capacity approval, so an absent
// approval must grant nothing. Zero is a reachable, proven state because a
// closed local gate reports maxCapacity 0.
export const UNAPPROVED_CAPACITY = 0;
export const RESERVATION_TTL_MS = 60_000;

const CONTROL_NAME = "singleton";
const LIVE_RESERVATION_STATES = Object.freeze([
  "reserved",
  "start-created",
  "consumed",
]);
export const RESERVATION_STATES = Object.freeze([
  "requested",
  ...LIVE_RESERVATION_STATES,
  "compensated",
]);
const textEncoder = new TextEncoder();

function subtleService(services) {
  return services.subtle ?? globalThis.crypto.subtle;
}

function timestampMs(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function nonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function reservationReclaimTimeSql(prefix, runnerHorizonParameter) {
  const column = (name) => `${prefix}${name}`;
  return `CASE
    WHEN ${column("state")} IN ('requested', 'reserved', 'start-created')
      THEN ${column("expires_at_ms")}
    WHEN ${column("state")} = 'consumed'
      THEN ${column("consumed_at_ms")} + ${runnerHorizonParameter}
    ELSE NULL
  END`;
}

// A non-consumed row is timestamp-consistent only when its expiry is between
// its request time and one reservation TTL after that time, inclusive.
// reserve() is the only writer. It sets requested_at_ms = nowMs and
// expires_at_ms = min(permitExpiry, nowMs + RESERVATION_TTL_MS) from one
// reading of nowMs, and the permit path refuses an expiry after that deadline.
// markStartCreated() never changes either column.
//
// A consumed row is timestamp-consistent only when consumed_at_ms is present
// and falls in the same inclusive interval. consume() refuses when
// expires_at_ms <= nowMs, so a row reaches consumed only with
// consumed_at_ms < expires_at_ms. reserve() bounds expires_at_ms by
// requested_at_ms + RESERVATION_TTL_MS.
//
// This row-internal check uses no clock. It closes missing and mutually
// impossible column shapes. It does not detect a uniformly fast caller clock.
// That case is unreachable here: reserve() receives nowMs from the
// ScaleSetListener Durable Object, and consume() receives it from the Worker.
// Both use the Cloudflare platform clock. timestampMs() bounds every nowMs to a
// safe integer, so every reclaim time is finite and a sweep eventually reaches
// it. A clock-plausibility check has a different blast radius and does not
// belong to this rule.
function reservationTimestampsConsistentSql(prefix, reservationTtlParameter) {
  const column = (name) => `${prefix}${name}`;
  return `CASE
    WHEN ${column("state")} IN ('requested', 'reserved', 'start-created')
      THEN ${column("expires_at_ms")} >= ${column("requested_at_ms")}
        AND ${column("expires_at_ms")} <=
          ${column("requested_at_ms")} + ${reservationTtlParameter}
    WHEN ${column("state")} = 'consumed'
      THEN ${column("consumed_at_ms")} IS NOT NULL
        AND ${column("consumed_at_ms")} >= ${column("requested_at_ms")}
        AND ${column("consumed_at_ms")} <=
          ${column("requested_at_ms")} + ${reservationTtlParameter}
    ELSE 1
  END`;
}

function reclaimableReservationSql(
  reclaimTimeSql,
  timestampsConsistentSql,
  nowParameter,
) {
  return `(
    ${reclaimTimeSql} IS NULL
    OR NOT (${timestampsConsistentSql})
    OR ${reclaimTimeSql} <= ${nowParameter}
  )`;
}

function liveReservationSql(
  prefix,
  runnerCutoffParameter,
  expiryParameter,
) {
  const column = (name) => `${prefix}${name}`;
  return `(
    (
      ${column("state")} = 'consumed'
      AND ${column("consumed_at_ms")} > ${runnerCutoffParameter}
    )
    OR (
      ${column("state")} IN ('reserved', 'start-created')
      AND ${column("expires_at_ms")} > ${expiryParameter}
    )
  )`;
}

function decodeBase64Url(value, expectedLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length % 4 === 1
  ) {
    return null;
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(base64 + padding);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    return bytes.byteLength === expectedLength ? bytes : null;
  } catch {
    return null;
  }
}

export function canonicalOutagePermit({
  permitId,
  scaleSetId,
  runnerRequestId,
  repository,
  expiresAtMs,
}) {
  return `${permitId}.${scaleSetId}.${runnerRequestId}.${repository}.${expiresAtMs}`;
}

export function canonicalCapacityApproval({
  approvedBy,
  capacity,
  effectiveAtMs,
}) {
  return JSON.stringify({ approvedBy, capacity, effectiveAtMs });
}

export async function verifyCapacityApproval(
  approval,
  publicKeyBase64Url,
  services = {},
) {
  const publicKeyBytes = decodeBase64Url(publicKeyBase64Url, 32);
  if (publicKeyBytes === null) {
    return { verified: false, reason: "capacity-approval-unconfigured" };
  }
  if (
    !isPlainObject(approval) ||
    !Number.isSafeInteger(approval.capacity) ||
    approval.capacity < 0 ||
    !Number.isSafeInteger(approval.effectiveAtMs) ||
    approval.effectiveAtMs < 0 ||
    typeof approval.approvedBy !== "string" ||
    approval.approvedBy.length === 0
  ) {
    return { verified: false, reason: "capacity-approval-invalid" };
  }
  const signature = decodeBase64Url(approval.signature, 64);
  if (signature === null) {
    return { verified: false, reason: "capacity-approval-invalid" };
  }
  try {
    const publicKey = await subtleService(services).importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const verified = await subtleService(services).verify(
      "Ed25519",
      publicKey,
      signature,
      textEncoder.encode(canonicalCapacityApproval(approval)),
    );
    return verified
      ? { verified: true }
      : { verified: false, reason: "capacity-approval-invalid" };
  } catch {
    return { verified: false, reason: "capacity-approval-invalid" };
  }
}

export async function verifyOutageGatePermit(
  {
    outagePermit,
    scaleSetId,
    runnerRequestId,
    repository,
    nowMs,
  },
  publicKeyBase64Url,
  services = {},
) {
  const publicKeyBytes = decodeBase64Url(publicKeyBase64Url, 32);
  if (publicKeyBytes === null) {
    return { verified: false, reason: "outage-gate-unconfigured" };
  }
  if (
    !isPlainObject(outagePermit) ||
    typeof outagePermit.permitId !== "string" ||
    outagePermit.permitId.length === 0 ||
    !isPositiveSafeInteger(outagePermit.expiresAtMs)
  ) {
    return { verified: false, reason: "outage-permit-invalid" };
  }
  if (outagePermit.expiresAtMs <= nowMs) {
    return { verified: false, reason: "outage-permit-expired" };
  }
  const signature = decodeBase64Url(outagePermit.signature, 64);
  if (signature === null) {
    return { verified: false, reason: "outage-permit-invalid" };
  }

  const subtle = subtleService(services);
  try {
    const publicKey = await subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const verified = await subtle.verify(
      "Ed25519",
      publicKey,
      signature,
      textEncoder.encode(
        canonicalOutagePermit({
          permitId: outagePermit.permitId,
          scaleSetId,
          runnerRequestId,
          repository,
          expiresAtMs: outagePermit.expiresAtMs,
        }),
      ),
    );
    return verified
      ? {
          verified: true,
          permitId: outagePermit.permitId,
          expiresAtMs: outagePermit.expiresAtMs,
        }
      : { verified: false, reason: "outage-permit-invalid" };
  } catch {
    return { verified: false, reason: "outage-permit-invalid" };
  }
}

export async function createHmacSha256Hex(value, secret, services = {}) {
  const subtle = subtleService(services);
  const key = await subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(value),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function secureEqual(provided, expected, services = {}) {
  const subtle = subtleService(services);
  const [providedHash, expectedHash] = await Promise.all([
    subtle.digest("SHA-256", textEncoder.encode(provided)),
    subtle.digest("SHA-256", textEncoder.encode(expected)),
  ]);
  return subtle.timingSafeEqual(providedHash, expectedHash);
}

export async function createReservationToken(
  {
    reservationId,
    gateGeneration,
    expiresAtMs,
    scaleSetId,
    runnerRequestId,
    repository,
  },
  controlToken,
  services = {},
) {
  const value = [
    reservationId,
    gateGeneration,
    expiresAtMs,
    scaleSetId,
    runnerRequestId,
    repository,
  ].join(".");
  return createHmacSha256Hex(value, controlToken, services);
}

function reservationFromRow(row) {
  return {
    reservationId: row.reservation_id,
    scaleSetId: row.scale_set_id,
    runnerRequestId: row.runner_request_id,
    repository: row.repository,
    wave: row.wave,
    state: row.state,
    gateGeneration: row.gate_generation,
    owner: row.owner,
    expiresAtMs: row.expires_at_ms,
    correlationId: row.correlation_id,
    sandboxId: row.sandbox_id,
    compensationReason: row.compensation_reason,
    requestedAtMs: row.requested_at_ms,
    reservedAtMs: row.reserved_at_ms,
    startCreatedAtMs: row.start_created_at_ms,
    consumedAtMs: row.consumed_at_ms,
    compensatedAtMs: row.compensated_at_ms,
  };
}

function listedReservationFromRow(row) {
  if (row.reservation_live !== 0 && row.reservation_live !== 1) {
    throw new Error("The reservation live value is invalid");
  }
  return {
    ...reservationFromRow(row),
    reclaimAtMs: row.reclaim_at_ms ?? null,
    live: row.reservation_live === 1,
  };
}

function encodeReservationCursor(requestedAtMs, reservationId) {
  return btoa(JSON.stringify([requestedAtMs, reservationId]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export class InvalidReservationCursor extends Error {}

export function decodeReservationCursor(value) {
  if (value === null) {
    return null;
  }

  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const decoded = JSON.parse(atob(base64 + padding));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      !Number.isSafeInteger(decoded[0]) ||
      decoded[0] < 0 ||
      typeof decoded[1] !== "string" ||
      decoded[1].length === 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return {
      requestedAtMs: decoded[0],
      reservationId: decoded[1],
    };
  } catch {
    throw new InvalidReservationCursor("The reservation cursor is invalid");
  }
}

export function getAutopilotControl(env) {
  const id = env.AutopilotControl.idFromName(CONTROL_NAME);
  return env.AutopilotControl.get(id);
}

export class AutopilotControl extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.#initializeSchema());
  }

  #initializeSchema() {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS control_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          local_gate TEXT NOT NULL CHECK (local_gate IN ('open', 'closed')),
          gate_generation INTEGER NOT NULL CHECK (gate_generation >= 0),
          approved_capacity INTEGER,
          capacity_approval_signature TEXT,
          capacity_effective_at_ms INTEGER,
          capacity_approved_by TEXT,
          active_wave TEXT,
          closed_reason TEXT,
          updated_at_ms INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        `INSERT OR IGNORE INTO control_state (
           singleton,
           local_gate,
           gate_generation,
           approved_capacity,
           capacity_approval_signature,
           capacity_effective_at_ms,
           capacity_approved_by,
           active_wave,
           closed_reason,
           updated_at_ms
         ) VALUES (1, 'open', 0, NULL, NULL, NULL, NULL, NULL, NULL, 0)`,
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS reservations (
          reservation_id TEXT PRIMARY KEY,
          scale_set_id INTEGER NOT NULL,
          runner_request_id INTEGER NOT NULL,
          repository TEXT NOT NULL,
          wave TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN (
              'requested',
              'reserved',
              'start-created',
              'consumed',
              'compensated'
            )
          ),
          gate_generation INTEGER NOT NULL,
          owner TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          correlation_id TEXT,
          sandbox_id TEXT,
          compensation_reason TEXT,
          requested_at_ms INTEGER NOT NULL,
          reserved_at_ms INTEGER,
          start_created_at_ms INTEGER,
          consumed_at_ms INTEGER,
          compensated_at_ms INTEGER
        )
      `);
      this.sql.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS reservations_live_request
          ON reservations (scale_set_id, runner_request_id)
          WHERE state IN ('requested', 'reserved', 'start-created', 'consumed')
      `);
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS reservations_state_expiry
          ON reservations (state, expires_at_ms)
      `);
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS reservations_sandbox
          ON reservations (sandbox_id)
          WHERE sandbox_id IS NOT NULL
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS consumed_outage_permits (
          permit_id TEXT PRIMARY KEY,
          reservation_id TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS consumed_outage_permits_expiry
          ON consumed_outage_permits (expires_at_ms)
      `);
    });
  }

  #controlState() {
    const rows = this.sql
      .exec(
        `SELECT local_gate, gate_generation, approved_capacity,
                capacity_approval_signature, capacity_effective_at_ms,
                capacity_approved_by, active_wave, closed_reason,
                updated_at_ms
         FROM control_state
         WHERE singleton = 1`,
      )
      .toArray();
    if (rows.length !== 1) {
      throw new Error("The autopilot control state is unavailable");
    }
    return rows[0];
  }

  #approvedCapacity(control) {
    return control.approved_capacity === null
      ? UNAPPROVED_CAPACITY
      : control.approved_capacity;
  }

  #sweepExpiredReservations(nowMs) {
    const reclaimTimeSql = reservationReclaimTimeSql("", "?1");
    const timestampsConsistentSql = reservationTimestampsConsistentSql(
      "",
      "?2",
    );
    const reclaimableSql = reclaimableReservationSql(
      reclaimTimeSql,
      timestampsConsistentSql,
      "?3",
    );
    const reclaimedRows = this.sql.exec(
      `UPDATE reservations
       SET state = 'compensated',
           compensation_reason = CASE
             WHEN ${reclaimTimeSql} IS NULL
               THEN 'reclaim-time-missing'
             WHEN NOT (${timestampsConsistentSql})
               THEN 'timestamps-inconsistent'
             WHEN state = 'consumed'
               THEN 'runner-horizon-exceeded'
             ELSE 'expired'
           END,
           compensated_at_ms = COALESCE(compensated_at_ms, ?3)
       WHERE state IN ('requested', 'reserved', 'start-created', 'consumed')
         AND ${reclaimableSql}
       RETURNING compensation_reason`,
      ACTIVE_RUNNER_CLEANUP_DELAY_MS,
      RESERVATION_TTL_MS,
      nowMs,
    ).toArray();
    this.sql.exec(
      `DELETE FROM consumed_outage_permits
       WHERE expires_at_ms <= ?`,
      nowMs,
    );
    const counts = {
      expired: 0,
      runnerHorizonExceeded: 0,
      reclaimTimeMissing: 0,
      timestampsInconsistent: 0,
    };
    for (const row of reclaimedRows) {
      if (row.compensation_reason === "expired") {
        counts.expired += 1;
      } else if (row.compensation_reason === "runner-horizon-exceeded") {
        counts.runnerHorizonExceeded += 1;
      } else if (row.compensation_reason === "reclaim-time-missing") {
        counts.reclaimTimeMissing += 1;
      } else if (row.compensation_reason === "timestamps-inconsistent") {
        counts.timestampsInconsistent += 1;
      } else {
        throw new Error("The reservation reclaim reason is invalid");
      }
    }
    return counts;
  }

  #pruneTerminalReservations(nowMs) {
    this.sql.exec(
      `DELETE FROM reservations
       WHERE state = 'compensated'
         AND (
           compensated_at_ms IS NULL
           OR compensated_at_ms < ?
         )`,
      nowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS,
    );
  }

  #nextReservationExpiryAtMs(nowMs) {
    const reclaimTimeSql = reservationReclaimTimeSql("", "?1");
    const timestampsConsistentSql = reservationTimestampsConsistentSql(
      "",
      "?2",
    );
    const reclaimableSql = reclaimableReservationSql(
      reclaimTimeSql,
      timestampsConsistentSql,
      "?3",
    );
    const row = this.sql.exec(
      `SELECT CASE
         WHEN MAX(CASE WHEN ${reclaimableSql} THEN 1 ELSE 0 END) = 1
           THEN ?3
         ELSE MIN(${reclaimTimeSql})
       END AS next_expiry_at_ms
       FROM reservations
       WHERE state IN ('requested', 'reserved', 'start-created', 'consumed')`,
      ACTIVE_RUNNER_CLEANUP_DELAY_MS,
      RESERVATION_TTL_MS,
      nowMs,
    ).toArray()[0];
    return row?.next_expiry_at_ms ?? null;
  }

  async #scheduleReservationAlarm(nowMs) {
    const nextExpiryAtMs = this.#nextReservationExpiryAtMs(nowMs);
    if (nextExpiryAtMs === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(nextExpiryAtMs);
  }

  // The sweep includes requested rows, but admission does not count them.
  // Reclaiming more states than admission counts can only free capacity.
  #liveReservationCount(nowMs = Date.now()) {
    const predicate = liveReservationSql("", "?1", "?2");
    const row = this.sql
      .exec(
        `SELECT COUNT(*) AS live_count
         FROM reservations
         WHERE ${predicate}`,
        nowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS,
        nowMs,
      )
      .toArray()[0];
    if (!Number.isSafeInteger(row?.live_count)) {
      throw new Error("The live reservation count is invalid");
    }
    return row.live_count;
  }

  status() {
    const nowMs = Date.now();
    const control = this.#controlState();
    const approvedCapacity = this.#approvedCapacity(control);
    return {
      localGate: control.local_gate,
      gateGeneration: control.gate_generation,
      approvedCapacity,
      activeWave: control.active_wave,
      liveReservationCount: this.#liveReservationCount(nowMs),
      nextReclaimAtMs: this.#nextReservationExpiryAtMs(nowMs),
      maxCapacity: control.local_gate === "open" ? approvedCapacity : 0,
    };
  }

  async reserve({
    scaleSetId,
    runnerRequestId,
    repository,
    wave,
    owner,
    outagePermit,
    nowMs,
  }) {
    if (!isPositiveSafeInteger(scaleSetId)) {
      throw new TypeError("scaleSetId must be a positive safe integer");
    }
    if (!isPositiveSafeInteger(runnerRequestId)) {
      throw new TypeError("runnerRequestId must be a positive safe integer");
    }
    if (!isRepositoryName(repository)) {
      throw new TypeError("repository must use the OWNER/REPO format");
    }
    nonEmptyString(wave, "wave");
    nonEmptyString(owner, "owner");
    timestampMs(nowMs, "nowMs");
    const reservationDeadlineAtMs = nowMs + RESERVATION_TTL_MS;
    if (!Number.isSafeInteger(reservationDeadlineAtMs)) {
      throw new TypeError("The reservation expiry exceeds a safe integer");
    }
    if (
      typeof this.env.CONTROL_TOKEN !== "string" ||
      this.env.CONTROL_TOKEN.length < 32
    ) {
      throw new Error("CONTROL_TOKEN must be at least 32 characters");
    }

    const permit = await verifyOutageGatePermit(
      {
        outagePermit,
        scaleSetId,
        runnerRequestId,
        repository,
        nowMs,
      },
      this.env.OUTAGE_GATE_PUBLIC_KEY,
    );
    if (
      permit.verified &&
      permit.expiresAtMs > reservationDeadlineAtMs
    ) {
      permit.verified = false;
      permit.reason = "outage-permit-invalid";
    }
    const expiresAtMs = permit.verified
      ? Math.min(permit.expiresAtMs, reservationDeadlineAtMs)
      : reservationDeadlineAtMs;
    const candidateReservationId = crypto.randomUUID();

    const result = this.ctx.storage.transactionSync(() => {
      this.#sweepExpiredReservations(nowMs);

      const control = this.#controlState();
      if (control.local_gate === "closed") {
        return { reserved: false, reason: "local-gate-closed" };
      }
      if (!permit.verified) {
        return { reserved: false, reason: permit.reason };
      }

      const existingRows = this.sql
        .exec(
          `SELECT *
           FROM reservations
           WHERE scale_set_id = ?
             AND runner_request_id = ?
             AND state IN ('requested', 'reserved', 'start-created', 'consumed')`,
          scaleSetId,
          runnerRequestId,
        )
        .toArray();
      if (existingRows.length > 1) {
        throw new Error("The runner request has multiple live reservations");
      }
      const existing = existingRows[0] ?? null;
      const consumedPermit = this.sql
        .exec(
          `SELECT reservation_id
           FROM consumed_outage_permits
           WHERE permit_id = ?`,
          permit.permitId,
        )
        .toArray()[0];
      if (
        consumedPermit !== undefined &&
        consumedPermit.reservation_id !== existing?.reservation_id
      ) {
        return { reserved: false, reason: "outage-permit-replayed" };
      }
      if (wave !== control.active_wave) {
        return { reserved: false, reason: "wave-not-active" };
      }

      const approvedCapacity = this.#approvedCapacity(control);
      if (control.approved_capacity === null) {
        return { reserved: false, reason: "capacity-unapproved" };
      }
      const liveCount = this.#liveReservationCount(nowMs);
      if (existing === null && liveCount >= MAX_ACTIVE_RUNNERS) {
        return { reserved: false, reason: "capacity-exhausted" };
      }
      if (existing === null && liveCount >= approvedCapacity) {
        return { reserved: false, reason: "capacity-exhausted" };
      }
      if (existing !== null) {
        return {
          reserved: true,
          replayed: true,
          reservation: reservationFromRow(existing),
        };
      }

      const insertedRows = this.sql
        .exec(
          `INSERT INTO reservations (
             reservation_id,
             scale_set_id,
             runner_request_id,
             repository,
             wave,
             state,
             gate_generation,
             owner,
             expires_at_ms,
             requested_at_ms,
             reserved_at_ms
           ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?)
           RETURNING *`,
          candidateReservationId,
          scaleSetId,
          runnerRequestId,
          repository,
          wave,
          control.gate_generation,
          owner,
          expiresAtMs,
          nowMs,
          nowMs,
        )
        .toArray();
      if (insertedRows.length !== 1) {
        throw new Error("The capacity reservation was not recorded");
      }
      this.sql.exec(
        `INSERT INTO consumed_outage_permits (
           permit_id,
           reservation_id,
           expires_at_ms
         ) VALUES (?, ?, ?)`,
        permit.permitId,
        candidateReservationId,
        permit.expiresAtMs,
      );
      return {
        reserved: true,
        replayed: false,
        reservation: reservationFromRow(insertedRows[0]),
      };
    });

    await this.#scheduleReservationAlarm(nowMs);

    if (!result.reserved) {
      return result;
    }
    const reservation = result.reservation;
    const token = await createReservationToken(
      reservation,
      this.env.CONTROL_TOKEN,
    );
    return {
      reserved: true,
      replayed: result.replayed,
      reservationId: reservation.reservationId,
      token,
      expiresAtMs: reservation.expiresAtMs,
      gateGeneration: reservation.gateGeneration,
    };
  }

  markStartCreated({ reservationId, correlationId, sandboxId }) {
    nonEmptyString(reservationId, "reservationId");
    nonEmptyString(correlationId, "correlationId");
    nonEmptyString(sandboxId, "sandboxId");
    const startCreatedAtMs = Date.now();
    const rows = this.sql
      .exec(
        `UPDATE reservations
         SET state = 'start-created',
             correlation_id = ?,
             sandbox_id = ?,
             start_created_at_ms = ?
         WHERE reservation_id = ?
           AND state = 'reserved'
         RETURNING *`,
        correlationId,
        sandboxId,
        startCreatedAtMs,
        reservationId,
      )
      .toArray();
    if (rows.length === 1) {
      return { started: true, reservation: reservationFromRow(rows[0]) };
    }
    const state = this.sql
      .exec(
        `SELECT state
         FROM reservations
         WHERE reservation_id = ?`,
        reservationId,
      )
      .toArray()[0]?.state;
    return {
      started: false,
      reason: state === undefined ? "reservation-not-found" : "invalid-state",
      ...(state === undefined ? {} : { state }),
    };
  }

  async consume({ reservationId, token, nowMs }) {
    nonEmptyString(reservationId, "reservationId");
    timestampMs(nowMs, "nowMs");
    const rows = this.sql
      .exec(
        `SELECT *
         FROM reservations
         WHERE reservation_id = ?`,
        reservationId,
      )
      .toArray();
    if (rows.length === 0) {
      return { consumed: false, reason: "reservation-not-found" };
    }
    if (rows.length !== 1) {
      throw new Error("The reservation identifier is not unique");
    }
    const reservation = reservationFromRow(rows[0]);
    if (reservation.state === "consumed") {
      return { consumed: false, reason: "already-consumed" };
    }
    if (reservation.state === "compensated") {
      return { consumed: false, reason: "reservation-compensated" };
    }

    const expectedToken = await createReservationToken(
      reservation,
      this.env.CONTROL_TOKEN,
    );
    if (!await secureEqual(
      typeof token === "string" ? token : "",
      expectedToken,
    )) {
      return { consumed: false, reason: "token-invalid" };
    }

    const result = this.ctx.storage.transactionSync(() => {
      const currentRows = this.sql
        .exec(
          `SELECT *
           FROM reservations
           WHERE reservation_id = ?`,
          reservationId,
        )
        .toArray();
      if (currentRows.length !== 1) {
        return { consumed: false, reason: "reservation-not-found" };
      }
      const current = reservationFromRow(currentRows[0]);
      if (current.state === "consumed") {
        return { consumed: false, reason: "already-consumed" };
      }
      if (current.state === "compensated") {
        return { consumed: false, reason: "reservation-compensated" };
      }
      const control = this.#controlState();
      if (current.gateGeneration !== control.gate_generation) {
        return { consumed: false, reason: "generation-superseded" };
      }
      if (current.expiresAtMs <= nowMs) {
        this.sql.exec(
          `UPDATE reservations
           SET state = 'compensated',
               compensation_reason = 'expired',
               compensated_at_ms = ?
           WHERE reservation_id = ?
             AND state IN ('reserved', 'start-created')`,
          nowMs,
          reservationId,
        );
        return { consumed: false, reason: "reservation-expired" };
      }
      if (control.approved_capacity === null) {
        return { consumed: false, reason: "capacity-unapproved" };
      }
      if (current.state !== "start-created") {
        return { consumed: false, reason: "start-not-created" };
      }
      const consumedRows = this.sql
        .exec(
          `UPDATE reservations
           SET state = 'consumed', consumed_at_ms = ?
           WHERE reservation_id = ?
             AND state = 'start-created'
           RETURNING reservation_id`,
          nowMs,
          reservationId,
        )
        .toArray();
      if (consumedRows.length !== 1) {
        throw new Error("The reservation token was not consumed");
      }
      return { consumed: true };
    });
    await this.#scheduleReservationAlarm(nowMs);
    return result;
  }

  async compensate({ reservationId, reason, nowMs = Date.now() }) {
    nonEmptyString(reservationId, "reservationId");
    nonEmptyString(reason, "reason");
    timestampMs(nowMs, "nowMs");
    const compensatedAtMs = nowMs;
    const rows = this.sql
      .exec(
        `UPDATE reservations
         SET state = 'compensated',
             compensation_reason = ?,
             compensated_at_ms = ?
         WHERE reservation_id = ?
           AND state IN ('requested', 'reserved', 'start-created', 'consumed')
         RETURNING reservation_id`,
        reason,
        compensatedAtMs,
        reservationId,
      )
      .toArray();
    let result;
    if (rows.length === 1) {
      result = { compensated: true, replayed: false };
    } else {
      const state = this.sql
        .exec(
          `SELECT state
           FROM reservations
           WHERE reservation_id = ?`,
          reservationId,
        )
        .toArray()[0]?.state;
      result = state === "compensated"
        ? { compensated: true, replayed: true }
        : { compensated: false, reason: "reservation-not-found" };
    }
    await this.#scheduleReservationAlarm(nowMs);
    return result;
  }

  // Destruction proves that the runner stopped consuming capacity. Only a
  // reservation with this exact sandbox_id releases, so a live runner keeps
  // its slot. The one-hour sweep remains the backstop.
  async releaseBySandbox({ sandboxId, reason }) {
    nonEmptyString(sandboxId, "sandboxId");
    nonEmptyString(reason, "reason");
    const liveRows = this.sql
      .exec(
        `SELECT reservation_id
         FROM reservations
         WHERE sandbox_id = ?
           AND state IN ('requested', 'reserved', 'start-created', 'consumed')`,
        sandboxId,
      )
      .toArray();
    if (liveRows.length > 1) {
      throw new Error("The sandbox has multiple live reservations");
    }
    if (liveRows.length === 1) {
      const reservationId = liveRows[0].reservation_id;
      const outcome = await this.compensate({ reservationId, reason });
      return {
        released: outcome.compensated,
        replayed: outcome.replayed ?? false,
        reservationId,
        ...(outcome.compensated ? {} : { reason: outcome.reason }),
      };
    }

    const compensated = this.sql
      .exec(
        `SELECT reservation_id
         FROM reservations
         WHERE sandbox_id = ?
           AND state = 'compensated'
         ORDER BY reservation_id
         LIMIT 1`,
        sandboxId,
      )
      .toArray()[0];
    if (compensated !== undefined) {
      return {
        released: true,
        replayed: true,
        reservationId: compensated.reservation_id,
      };
    }
    return { released: false, reason: "reservation-not-found" };
  }

  async alarm() {
    return this.runAlarm({ nowMs: Date.now() });
  }

  async runAlarm({ nowMs = Date.now() } = {}) {
    timestampMs(nowMs, "nowMs");
    const swept = this.ctx.storage.transactionSync(() =>
      {
        const result = this.#sweepExpiredReservations(nowMs);
        this.#pruneTerminalReservations(nowMs);
        return result;
      }
    );
    await this.#scheduleReservationAlarm(nowMs);
    return swept;
  }

  closeGate({ reason, nowMs }) {
    nonEmptyString(reason, "reason");
    timestampMs(nowMs, "nowMs");
    const result = this.ctx.storage.transactionSync(() => {
      const control = this.#controlState();
      if (control.local_gate === "closed") {
        return {
          changed: false,
          localGate: "closed",
          gateGeneration: control.gate_generation,
          closedReason: control.closed_reason,
        };
      }
      const rows = this.sql
        .exec(
          `UPDATE control_state
           SET local_gate = 'closed',
               gate_generation = gate_generation + 1,
               closed_reason = ?,
               updated_at_ms = ?
           WHERE singleton = 1
           RETURNING gate_generation`,
          reason,
          nowMs,
        )
        .toArray();
      return {
        changed: true,
        localGate: "closed",
        gateGeneration: rows[0].gate_generation,
        closedReason: reason,
      };
    });
    return { closed: true, ...result, maxCapacity: 0 };
  }

  openGate({ nowMs }) {
    timestampMs(nowMs, "nowMs");
    const result = this.ctx.storage.transactionSync(() => {
      const control = this.#controlState();
      if (control.local_gate === "open") {
        return {
          changed: false,
          localGate: "open",
          gateGeneration: control.gate_generation,
        };
      }
      const rows = this.sql
        .exec(
          `UPDATE control_state
           SET local_gate = 'open',
               gate_generation = gate_generation + 1,
               closed_reason = NULL,
               updated_at_ms = ?
           WHERE singleton = 1
           RETURNING gate_generation, approved_capacity`,
          nowMs,
        )
        .toArray();
      return {
        changed: true,
        localGate: "open",
        gateGeneration: rows[0].gate_generation,
      };
    });
    const control = this.#controlState();
    return {
      opened: true,
      ...result,
      maxCapacity: this.#approvedCapacity(control),
    };
  }

  async recordCapacityApproval({
    capacity,
    signature,
    effectiveAtMs,
    approvedBy,
  }) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      return { recorded: false, reason: "invalid-capacity" };
    }
    if (capacity > MAX_ACTIVE_RUNNERS) {
      return {
        recorded: false,
        reason: "exceeds-policy-guard",
        guard: "MAX_ACTIVE_RUNNERS",
        guardValue: MAX_ACTIVE_RUNNERS,
        offeredCapacity: capacity,
      };
    }
    const approval = { approvedBy, capacity, effectiveAtMs, signature };
    const verification = await verifyCapacityApproval(
      approval,
      this.env.CAPACITY_APPROVAL_PUBLIC_KEY,
    );
    if (!verification.verified) {
      return { recorded: false, reason: verification.reason };
    }
    const updatedAtMs = Date.now();
    this.sql.exec(
      `UPDATE control_state
       SET approved_capacity = ?,
           capacity_approval_signature = ?,
           capacity_effective_at_ms = ?,
           capacity_approved_by = ?,
           updated_at_ms = ?
       WHERE singleton = 1`,
      capacity,
      signature,
      effectiveAtMs,
      approvedBy,
      updatedAtMs,
    );
    return {
      recorded: true,
      approvedCapacity: capacity,
      effectiveAtMs,
      approvedBy,
    };
  }

  setActiveWave({ wave }) {
    nonEmptyString(wave, "wave");
    this.sql.exec(
      `UPDATE control_state
       SET active_wave = ?, updated_at_ms = ?
       WHERE singleton = 1`,
      wave,
      Date.now(),
    );
    return { updated: true, activeWave: wave };
  }

  listReservations({
    state,
    limit,
    cursor: cursorValue,
    nowMs = Date.now(),
  } = {}) {
    if (state !== undefined && !RESERVATION_STATES.includes(state)) {
      throw new TypeError("state must name a reservation state");
    }
    timestampMs(nowMs, "nowMs");
    const cursor = cursorValue ?? null;
    if (
      cursor !== null &&
      (
        !isPlainObject(cursor) ||
        !Number.isSafeInteger(cursor.requestedAtMs) ||
        cursor.requestedAtMs < 0 ||
        typeof cursor.reservationId !== "string" ||
        cursor.reservationId.length === 0
      )
    ) {
      throw new TypeError("cursor must be a reservation cursor");
    }
    const pageLimit = limit === undefined
      ? RESERVATION_LIST_PAGE_SIZE
      : limit;
    if (!isPositiveSafeInteger(pageLimit)) {
      throw new TypeError("limit must be a positive safe integer");
    }
    const boundedLimit = Math.min(pageLimit, RESERVATION_LIST_PAGE_SIZE);
    const parameters = [];
    const parameter = (value) => {
      parameters.push(value);
      return `?${parameters.length}`;
    };
    const predicates = [];
    if (cursor !== null) {
      const requestedAtParameter = parameter(cursor.requestedAtMs);
      const reservationIdParameter = parameter(cursor.reservationId);
      predicates.push(
        `(requested_at_ms > ${requestedAtParameter} OR ` +
          `(requested_at_ms = ${requestedAtParameter} AND ` +
          `reservation_id > ${reservationIdParameter}))`,
      );
    }
    if (state !== undefined) {
      predicates.push(`state = ${parameter(state)}`);
    }
    const runnerHorizonParameter = parameter(
      ACTIVE_RUNNER_CLEANUP_DELAY_MS,
    );
    const runnerCutoffParameter = parameter(
      nowMs - ACTIVE_RUNNER_CLEANUP_DELAY_MS,
    );
    const nowParameter = parameter(nowMs);
    const limitParameter = parameter(boundedLimit + 1);
    const where = predicates.length === 0
      ? ""
      : `WHERE ${predicates.join(" AND ")}`;
    const reclaimTimeSql = reservationReclaimTimeSql(
      "",
      runnerHorizonParameter,
    );
    const liveSql = liveReservationSql(
      "",
      runnerCutoffParameter,
      nowParameter,
    );
    const rows = this.sql
      .exec(
        `SELECT *,
                ${reclaimTimeSql} AS reclaim_at_ms,
                CASE WHEN ${liveSql} THEN 1 ELSE 0 END AS reservation_live
         FROM reservations
         ${where}
         ORDER BY requested_at_ms ASC, reservation_id ASC
         LIMIT ${limitParameter}`,
        ...parameters,
      )
      .toArray();
    const returnedRows = rows.slice(0, boundedLimit);
    const counts = Object.fromEntries(
      RESERVATION_STATES.map((reservationState) => [reservationState, 0]),
    );
    for (const row of this.sql.exec(
      `SELECT state, COUNT(*) AS reservation_count
       FROM reservations
       GROUP BY state`,
    ).toArray()) {
      counts[row.state] = row.reservation_count;
    }
    const nextCursor = rows.length > boundedLimit
      ? encodeReservationCursor(
          returnedRows.at(-1).requested_at_ms,
          returnedRows.at(-1).reservation_id,
        )
      : null;
    const nextReclaimAtMs = this.#nextReservationExpiryAtMs(nowMs);
    const liveReservationCount = this.#liveReservationCount(nowMs);
    return {
      reservations: returnedRows.map(listedReservationFromRow),
      pageSize: boundedLimit,
      nextCursor,
      hasMore: nextCursor !== null,
      summary: {
        nowMs,
        counts,
        liveReservationCount,
        nextReclaimAtMs,
        pageSize: boundedLimit,
      },
    };
  }
}
