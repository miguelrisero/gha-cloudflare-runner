import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const auditNowEpoch = Date.parse("2026-08-21T13:43:10Z") / 1000;
export const cloudflareCreatedAt = "2026-08-20T23:24:56.656999936Z";
export const registryCreatedAt = "2026-08-21T13:41:00.000Z";

export function runnerUuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function sandboxId(uuid) {
  return `runner-${uuid}`;
}

export function cloudflareInstanceId(name) {
  return createHash("sha256").update(name).digest("hex");
}

export function cloudflareInstance({
  uuid,
  name = sandboxId(uuid),
  id = cloudflareInstanceId(name),
  state = "running",
  created = cloudflareCreatedAt,
  ...fields
}) {
  return { id, name, state, created, ...fields };
}

export function registryRow(options) {
  const {
    uuid,
    sandbox = sandboxId(uuid),
    state = "online",
    createdAt = registryCreatedAt,
    githubRunnerName: suppliedGithubRunnerName,
    revision: suppliedRevision,
    ...fields
  } = options;
  const row = { sandboxId: sandbox, state, createdAt, ...fields };
  if (Object.hasOwn(options, "githubRunnerName")) {
    row.githubRunnerName = suppliedGithubRunnerName;
  }
  const revision = Object.hasOwn(options, "revision") ? suppliedRevision : 0;
  if (revision !== undefined) {
    row.revision = revision;
  }
  return row;
}

export function githubRunner({
  id,
  uuid,
  githubRunnerName,
  name = githubRunnerName ?? `cloudflare-${uuid}`,
  status = "online",
  busy = false,
}) {
  return { id, name, status, busy };
}

export function runJq(filter, variables, flags = ["-n"]) {
  const variableArguments = Object.entries(variables).flatMap(([name, value]) => [
    "--argjson",
    name,
    JSON.stringify(value),
  ]);
  return execFileSync(
    "jq",
    ["-L", "scripts/lib", ...flags, ...variableArguments, filter],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

export function assertCommandRejected(callback, messagePattern, sentinel) {
  assert.throws(
    callback,
    (error) => {
      const stderr = String(error.stderr ?? "");

      assert.notEqual(error.status, 0);
      assert.match(stderr, messagePattern);
      assert.ok(stderr.includes(JSON.stringify(sentinel)));
      return true;
    },
  );
}
