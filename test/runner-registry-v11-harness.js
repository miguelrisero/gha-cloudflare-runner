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
        revision INTEGER NOT NULL DEFAULT 0,
        destroyed_at TEXT,
        destroyed_by TEXT CHECK (
          destroyed_by IS NULL OR
          destroyed_by IN (
            'callback', 'reconcile', 'startup-failure', 'alarm', 'orphan'
          )
        )
      );
      CREATE TABLE IF NOT EXISTS orphan_observations (
        sandbox_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        first_observed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (sandbox_id, instance_id)
      );
      CREATE TABLE IF NOT EXISTS orphan_reclaim_observations (
        sandbox_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        first_observed_at_ms INTEGER NOT NULL,
        PRIMARY KEY (sandbox_id, revision)
      );
      CREATE TABLE IF NOT EXISTS runner_registry_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO runner_registry_schema (singleton, version)
      VALUES (1, 11)
      ON CONFLICT (singleton) DO UPDATE SET version = excluded.version;
    `);
  }

  recordRunner({
    sandboxId,
    runnerName,
    githubRunnerName,
    correlationId,
    repository,
    createdAt,
    createdAtMs,
    state,
    cleanupDueAtMs,
    cleanupAttempts,
    revision,
  }) {
    this.sql.exec(
      `INSERT INTO runners (
         sandbox_id,
         runner_name,
         github_runner_name,
         correlation_id,
         repository,
         created_at,
         created_at_ms,
         state,
         cleanup_due_at_ms,
         cleanup_attempts,
         revision
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sandboxId,
      runnerName,
      githubRunnerName,
      correlationId,
      repository,
      createdAt,
      createdAtMs,
      state,
      cleanupDueAtMs,
      cleanupAttempts,
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
    await registry.recordRunner(await request.json());
    return new Response(null, { status: 204 });
  },
};
