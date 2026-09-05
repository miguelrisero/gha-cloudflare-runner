import { DurableObject } from "cloudflare:workers";

export { AutopilotControl } from "../src/worker.js";

export class RunnerRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS runners (
        sandbox_id TEXT PRIMARY KEY,
        runner_name TEXT NOT NULL UNIQUE,
        correlation_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        observed_created_at TEXT,
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
        revision INTEGER NOT NULL DEFAULT 0,
        destroyed_at TEXT,
        destroyed_by TEXT CHECK (
          destroyed_by IS NULL OR
          destroyed_by IN (
            'callback', 'reconcile', 'startup-failure', 'alarm', 'orphan'
          )
        )
      );
      CREATE TABLE IF NOT EXISTS runner_registry_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO runner_registry_schema (singleton, version)
      VALUES (1, 6)
      ON CONFLICT (singleton) DO UPDATE SET version = excluded.version;
    `);
  }

  recordTerminal({
    sandboxId,
    runnerName,
    correlationId,
    createdAt,
    createdAtMs,
    observedCreatedAt,
    revision,
    destroyedAt,
  }) {
    this.sql.exec(
      `INSERT INTO runners (
         sandbox_id,
         runner_name,
         correlation_id,
         created_at,
         created_at_ms,
         observed_created_at,
         state,
         revision,
         destroyed_at,
         destroyed_by
       ) VALUES (?, ?, ?, ?, ?, ?, 'destroyed', ?, ?, 'orphan')`,
      sandboxId,
      runnerName,
      correlationId,
      createdAt,
      createdAtMs,
      observedCreatedAt,
      revision,
      destroyedAt,
    );
  }

  recordInFlight({
    sandboxId,
    runnerName,
    correlationId,
    createdAt,
    createdAtMs,
    cleanupStartedAt,
    reconcileToken,
    cleanupDueAtMs,
    revision,
  }) {
    this.sql.exec(
      `INSERT INTO runners (
         sandbox_id,
         runner_name,
         correlation_id,
         created_at,
         created_at_ms,
         state,
         cleanup_started_at,
         reconcile_token,
         cleanup_due_at_ms,
         cleanup_requested_by,
         revision
       ) VALUES (?, ?, ?, ?, ?, 'destroying', ?, ?, ?, 'orphan', ?)`,
      sandboxId,
      runnerName,
      correlationId,
      createdAt,
      createdAtMs,
      cleanupStartedAt,
      reconcileToken,
      cleanupDueAtMs,
      revision,
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const registryName = url.searchParams.get("registry");
    if (registryName === null) {
      return Response.json(
        { error: "The registry query parameter is required" },
        { status: 400 },
      );
    }

    const registry = env.RunnerRegistry.get(
      env.RunnerRegistry.idFromName(registryName),
    );
    const body = await request.json();
    if (url.pathname === "/record-in-flight") {
      await registry.recordInFlight(body);
    } else {
      await registry.recordTerminal(body);
    }
    return new Response(null, { status: 204 });
  },
};
