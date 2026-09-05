import { DurableObject } from "cloudflare:workers";

import { canonicalOutagePermit } from "../../src/autopilot-control.js";
import {
  isPlainObject,
  isPositiveSafeInteger,
  isRepositoryName,
} from "../../src/scaleset-protocol.js";

// PERMIT_TTL_MS stays strictly under AutopilotControl RESERVATION_TTL_MS
// (60_000) so a permit can never outlive the reservation window it buys, and
// so ordinary clock skew between the two Workers cannot push
// permit.expiresAtMs past nowMs + RESERVATION_TTL_MS at verification time.
export const PERMIT_TTL_MS = 45_000;

const TOKEN_MINIMUM_LENGTH = 32;
const textEncoder = new TextEncoder();

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

function refusal(reason, status = 400) {
  return jsonResponse({ refused: true, reason }, status);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function decodeBase64Url(value) {
  if (
    !nonEmptyString(value) ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length % 4 === 1
  ) {
    return null;
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    return Uint8Array.from(
      atob(base64 + padding),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function encodeBase64Url(bytes) {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function constantTimeEqual(left, right) {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function configuredToken(value) {
  return typeof value === "string" && value.length >= TOKEN_MINIMUM_LENGTH;
}

function parseAllowlist(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((repository) => !isRepositoryName(repository))
  ) {
    return null;
  }
  return new Set(parsed);
}

function configuration(env, includeAllowlist) {
  if (
    !configuredToken(env.OUTAGE_GATE_TOKEN) ||
    !configuredToken(env.OUTAGE_GATE_ADMIN_TOKEN) ||
    constantTimeEqual(
      env.OUTAGE_GATE_TOKEN,
      env.OUTAGE_GATE_ADMIN_TOKEN,
    )
  ) {
    return null;
  }
  const privateKeyBytes = decodeBase64Url(env.OUTAGE_GATE_PRIVATE_KEY);
  if (privateKeyBytes === null) {
    return null;
  }
  const allowlist = includeAllowlist
    ? parseAllowlist(env.OUTAGE_GATE_REPOSITORY_ALLOWLIST)
    : null;
  if (includeAllowlist && allowlist === null) {
    return null;
  }
  return {
    adminToken: env.OUTAGE_GATE_ADMIN_TOKEN,
    allowlist,
    listenerToken: env.OUTAGE_GATE_TOKEN,
    privateKeyBytes,
  };
}

function bearerToken(request) {
  const authorization = request.headers.get("Authorization");
  const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? "");
  return match?.[1] ?? null;
}

function authorize(request, config, role) {
  const provided = bearerToken(request);
  if (provided === null) {
    return null;
  }
  const listener = constantTimeEqual(provided, config.listenerToken);
  const admin = constantTimeEqual(provided, config.adminToken);
  if (role === "listener") {
    return listener ? "listener" : null;
  }
  if (role === "admin") {
    return admin ? "admin" : null;
  }
  if (listener) {
    return "listener";
  }
  return admin ? "admin" : null;
}

async function jsonObject(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  return isPlainObject(body) ? body : null;
}

async function discardRequestBody(request) {
  if (request.body !== null) {
    await request.arrayBuffer();
  }
}

function permitRequestReason(body) {
  if (body === null) {
    return "invalid-json-object";
  }
  if (!isPositiveSafeInteger(body.scaleSetId)) {
    return "invalid-scale-set-id";
  }
  if (!isPositiveSafeInteger(body.runnerRequestId)) {
    return "invalid-runner-request-id";
  }
  if (!isRepositoryName(body.repository)) {
    return "invalid-repository";
  }
  if (!nonEmptyString(body.wave)) {
    return "invalid-wave";
  }
  if (!isPositiveSafeInteger(body.expiresAtMs)) {
    return "invalid-expiry";
  }
  return null;
}

function closeRequestReason(body) {
  if (body === null) {
    return "invalid-json-object";
  }
  if (body.action !== "close") {
    return "invalid-action";
  }
  if (!isNonNegativeSafeInteger(body.closedAtMs)) {
    return "invalid-close-time";
  }
  if (!nonEmptyString(body.reason)) {
    return "invalid-reason";
  }
  if (
    body.scaleSetId !== undefined &&
    !isPositiveSafeInteger(body.scaleSetId)
  ) {
    return "invalid-scale-set-id";
  }
  if (
    body.scaleSetName !== undefined &&
    !nonEmptyString(body.scaleSetName)
  ) {
    return "invalid-scale-set-name";
  }
  return null;
}

function openRequestReason(body) {
  if (body === null) {
    return "invalid-json-object";
  }
  if (body.action !== "open") {
    return "invalid-action";
  }
  if (!isNonNegativeSafeInteger(body.openedAtMs)) {
    return "invalid-open-time";
  }
  if (!nonEmptyString(body.reason)) {
    return "invalid-reason";
  }
  if (!nonEmptyString(body.actor)) {
    return "invalid-actor";
  }
  return null;
}

function permitFromRow(row) {
  return {
    permitId: row.permit_id,
    expiresAtMs: row.expires_at_ms,
    signature: row.signature,
  };
}

// KV writes can take approximately 60 seconds to propagate globally.
// A KV read could therefore answer "open" for the incident's first minute.
// The switch exists to prevent this result after an operator closes the gate.
// This Durable Object provides one authoritative instance. Its transactional
// SQLite state survives eviction, restart, and redeploy.
export class OutageGate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.privateKeyPromise = null;
    ctx.blockConcurrencyWhile(async () => this.#initializeSchema());
  }

  #initializeSchema() {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS gate_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
          generation INTEGER NOT NULL CHECK (generation >= 0),
          changed_at_ms INTEGER NOT NULL,
          reason TEXT,
          actor TEXT,
          scale_set_id INTEGER,
          scale_set_name TEXT
        )
      `);
      // A fresh gate has no operator approval, so it grants no permits.
      this.sql.exec(
        `INSERT OR IGNORE INTO gate_state (
           singleton, state, generation, changed_at_ms, reason, actor,
           scale_set_id, scale_set_name
         ) VALUES (1, 'closed', 0, 0, NULL, NULL, NULL, NULL)`,
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS issued_permits (
          permit_id TEXT PRIMARY KEY,
          scale_set_id INTEGER NOT NULL,
          runner_request_id INTEGER NOT NULL,
          repository TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          issued_at_ms INTEGER NOT NULL,
          signature TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE INDEX IF NOT EXISTS issued_permits_expiry
          ON issued_permits (expires_at_ms)
      `);
      this.sql.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS issued_permits_live_request
          ON issued_permits (scale_set_id, runner_request_id)
      `);
    });
  }

  #state() {
    const rows = this.sql.exec(
      `SELECT state, generation, changed_at_ms, reason, actor,
              scale_set_id, scale_set_name
       FROM gate_state
       WHERE singleton = 1`,
    ).toArray();
    if (rows.length !== 1) {
      throw new Error("The outage gate state is unavailable");
    }
    return rows[0];
  }

  #prunePermits(nowMs) {
    this.sql.exec(
      "DELETE FROM issued_permits WHERE expires_at_ms <= ?",
      nowMs,
    );
  }

  #existingPermit(request) {
    return this.sql.exec(
      `SELECT permit_id, repository, expires_at_ms, signature
       FROM issued_permits
       WHERE scale_set_id = ?
         AND runner_request_id = ?`,
      request.scaleSetId,
      request.runnerRequestId,
    ).toArray()[0] ?? null;
  }

  #closedResponse(state) {
    return jsonResponse({
      refused: true,
      reason: "gate-closed",
      generation: state.generation,
      closedAtMs: state.changed_at_ms,
    }, 503);
  }

  #configurationResponse(pathname) {
    if (pathname === "/permit") {
      return refusal("outage-gate-unconfigured", 503);
    }
    return jsonResponse({ error: "outage-gate-unconfigured" }, 500);
  }

  #privateKey(privateKeyBytes) {
    if (this.privateKeyPromise === null) {
      this.privateKeyPromise = crypto.subtle.importKey(
        "pkcs8",
        privateKeyBytes,
        { name: "Ed25519" },
        false,
        ["sign"],
      );
    }
    return this.privateKeyPromise;
  }

  async #permit(request, config) {
    const nowMs = Date.now();
    this.ctx.storage.transactionSync(() => this.#prunePermits(nowMs));
    const body = await jsonObject(request);
    const invalidReason = permitRequestReason(body);
    if (invalidReason !== null) {
      return refusal(invalidReason);
    }
    if (!config.allowlist.has(body.repository)) {
      return refusal("repository-not-allowed");
    }

    const expiresAtMs = Math.min(
      body.expiresAtMs,
      nowMs + PERMIT_TTL_MS,
    );
    if (expiresAtMs <= nowMs) {
      return refusal("start-deadline-passed", 409);
    }

    const privateKey = await this.#privateKey(config.privateKeyBytes);
    const first = this.ctx.storage.transactionSync(() => {
      this.#prunePermits(nowMs);
      const state = this.#state();
      if (state.state === "closed") {
        return { closed: state };
      }
      const existing = this.#existingPermit(body);
      return { existing };
    });
    if (first.closed !== undefined) {
      return this.#closedResponse(first.closed);
    }
    if (first.existing !== null) {
      if (first.existing.repository !== body.repository) {
        return refusal("permit-scope-conflict", 409);
      }
      return jsonResponse(permitFromRow(first.existing));
    }

    const permitId = crypto.randomUUID();
    const canonical = canonicalOutagePermit({
      permitId,
      scaleSetId: body.scaleSetId,
      runnerRequestId: body.runnerRequestId,
      repository: body.repository,
      expiresAtMs,
    });
    const signature = encodeBase64Url(await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      textEncoder.encode(canonical),
    ));
    const permit = { permitId, expiresAtMs, signature };

    const final = this.ctx.storage.transactionSync(() => {
      this.#prunePermits(nowMs);
      const state = this.#state();
      if (state.state === "closed") {
        return { closed: state };
      }
      const existing = this.#existingPermit(body);
      if (existing !== null) {
        return { existing };
      }
      this.sql.exec(
        `INSERT INTO issued_permits (
           permit_id, scale_set_id, runner_request_id, repository,
           expires_at_ms, issued_at_ms, signature
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        permit.permitId,
        body.scaleSetId,
        body.runnerRequestId,
        body.repository,
        permit.expiresAtMs,
        nowMs,
        permit.signature,
      );
      return { existing: null };
    });
    if (final.closed !== undefined) {
      return this.#closedResponse(final.closed);
    }
    if (final.existing !== null) {
      if (final.existing.repository !== body.repository) {
        return refusal("permit-scope-conflict", 409);
      }
      return jsonResponse(permitFromRow(final.existing));
    }
    return jsonResponse(permit);
  }

  async #close(request, actor) {
    const body = await jsonObject(request);
    const invalidReason = closeRequestReason(body);
    if (invalidReason !== null) {
      return jsonResponse({ error: invalidReason }, 400);
    }
    const state = this.ctx.storage.transactionSync(() => {
      const current = this.#state();
      const generation = current.state === "open"
        ? current.generation + 1
        : current.generation;
      const rows = this.sql.exec(
        `UPDATE gate_state
         SET state = 'closed', generation = ?, changed_at_ms = ?,
             reason = ?, actor = ?, scale_set_id = ?, scale_set_name = ?
         WHERE singleton = 1
         RETURNING state, generation, changed_at_ms, reason`,
        generation,
        body.closedAtMs,
        body.reason,
        actor,
        body.scaleSetId ?? null,
        body.scaleSetName ?? null,
      ).toArray();
      return rows[0];
    });
    return jsonResponse({
      state: state.state,
      generation: state.generation,
      closedAtMs: state.changed_at_ms,
      reason: state.reason,
    });
  }

  async #open(request) {
    const body = await jsonObject(request);
    const invalidReason = openRequestReason(body);
    if (invalidReason !== null) {
      return jsonResponse({ error: invalidReason }, 400);
    }
    const state = this.ctx.storage.transactionSync(() =>
      this.sql.exec(
        `UPDATE gate_state
         SET state = 'open', generation = generation + 1,
             changed_at_ms = ?, reason = ?, actor = ?,
             scale_set_id = NULL, scale_set_name = NULL
         WHERE singleton = 1
         RETURNING state, generation, changed_at_ms`,
        body.openedAtMs,
        body.reason,
        body.actor,
      ).toArray()[0]
    );
    return jsonResponse({
      state: state.state,
      generation: state.generation,
      openedAtMs: state.changed_at_ms,
    });
  }

  #status() {
    const state = this.#state();
    const livePermits = this.sql.exec(
      `SELECT COUNT(*) AS live_permits
       FROM issued_permits
       WHERE expires_at_ms > ?`,
      Date.now(),
    ).toArray()[0]?.live_permits;
    if (!Number.isSafeInteger(livePermits)) {
      throw new Error("The live permit count is invalid");
    }
    return jsonResponse({
      state: state.state,
      generation: state.generation,
      changedAtMs: state.changed_at_ms,
      reason: state.reason,
      actor: state.actor,
      livePermits,
    });
  }

  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const methods = new Map([
      ["/permit", "POST"],
      ["/close", "POST"],
      ["/open", "POST"],
      ["/status", "GET"],
    ]);
    const method = methods.get(pathname);
    if (method === undefined) {
      await discardRequestBody(request);
      return jsonResponse({ error: "Not found" }, 404);
    }
    if (request.method !== method) {
      await discardRequestBody(request);
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const config = configuration(this.env, pathname === "/permit");
    if (config === null) {
      await discardRequestBody(request);
      return this.#configurationResponse(pathname);
    }
    const requiredRole = pathname === "/permit"
      ? "listener"
      : pathname === "/open"
        ? "admin"
        : "either";
    const actor = authorize(request, config, requiredRole);
    if (actor === null) {
      await discardRequestBody(request);
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    try {
      switch (pathname) {
        case "/permit":
          return await this.#permit(request, config);
        case "/close":
          return await this.#close(request, actor);
        case "/open":
          return await this.#open(request);
        default:
          return this.#status();
      }
    } catch {
      if (pathname === "/permit") {
        return refusal("outage-gate-unavailable", 503);
      }
      return jsonResponse({ error: "Outage gate unavailable" }, 500);
    }
  }
}
