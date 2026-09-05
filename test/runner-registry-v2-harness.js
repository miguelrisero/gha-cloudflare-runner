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
        created_at TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('starting', 'online', 'destroying', 'destroyed')
        ),
        cleanup_started_at TEXT,
        reconcile_token TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        destroyed_at TEXT,
        destroyed_by TEXT CHECK (
          destroyed_by IS NULL OR
          destroyed_by IN ('callback', 'reconcile', 'startup-failure')
        )
      );
      CREATE INDEX IF NOT EXISTS runners_active_age
        ON runners (state, created_at_ms);
    `);
  }

  recordStarting({ sandboxId, runnerName, createdAt, createdAtMs }) {
    this.sql.exec(
      `INSERT INTO runners (
         sandbox_id,
         runner_name,
         created_at,
         created_at_ms,
         state
       ) VALUES (?, ?, ?, ?, 'starting')`,
      sandboxId,
      runnerName,
      createdAt,
      createdAtMs,
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
    await registry.recordStarting(body);
    return new Response(null, { status: 204 });
  },
};
