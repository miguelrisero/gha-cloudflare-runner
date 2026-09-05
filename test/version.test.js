import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { guardDevWorkerTransport } from "./dev-worker-transport.js";

process.env.WRANGLER_WRITE_LOGS = "false";

const { unstable_dev } = await import("wrangler");

const CONTROL_TOKEN = "control-token-with-at-least-32-characters";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const BUILD_REF = "chief/l23-repo-allowlist";
const BUILD_TIME = "2026-08-22T12:34:56Z";
const MAX_BOOT_ATTEMPTS = 3;
const BOOT_RETRY_DELAY_MS = 250;

function devOptions(vars) {
  return {
    config: "test/version-wrangler.jsonc",
    logLevel: "none",
    vars,
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false,
    },
  };
}

async function bootWorker(scenario, vars) {
  let worker;
  let lastError;

  for (let attempt = 1; attempt <= MAX_BOOT_ATTEMPTS; attempt += 1) {
    try {
      worker = guardDevWorkerTransport(
        await unstable_dev("src/worker.js", devOptions(vars)),
      );
      return worker;
    } catch (error) {
      lastError = error;
      await worker?.stop();
      worker = undefined;

      if (attempt < MAX_BOOT_ATTEMPTS) {
        await delay(BOOT_RETRY_DELAY_MS);
      }
    }
  }

  const detail = lastError instanceof Error
    ? lastError.message
    : String(lastError);
  throw new Error(
    `Failed to boot the ${scenario} worker after ${MAX_BOOT_ATTEMPTS} attempts: ${detail}`,
    { cause: lastError },
  );
}

function versionRequest(target, init = {}) {
  return target.fetch("/version", {
    ...init,
    headers: {
      Authorization: `Bearer ${CONTROL_TOKEN}`,
      ...init.headers,
    },
  });
}

test("Worker entry module has no named value exports", async () => {
  // workerd requires every named entry-module export to be a function or ExportedHandler; Node cannot import src/worker.js because only workerd resolves cloudflare:workers.
  const workerUrl = new URL("../src/worker.js", import.meta.url);
  const workerSource = await readFile(workerUrl, "utf8");
  const sourceLines = workerSource
    .split(/\r?\n/u)
    .map((source, index) => ({ line: index + 1, source }));
  const inlineOffendingExport = sourceLines
    .find(({ source }) =>
      /^[\t ]*export\s+(?:const|let|var)\b/u.test(source),
    );
  const valueBindings = new Set(
    [...workerSource.matchAll(
      /^[\t ]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gmu,
    )].map((match) => match[1]),
  );
  const importPattern =
    /^[\t ]*import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];/gmu;
  for (const match of workerSource.matchAll(importPattern)) {
    const moduleSpecifier = match[2];
    if (!moduleSpecifier.startsWith(".")) {
      continue;
    }
    const importedSource = await readFile(
      new URL(moduleSpecifier, workerUrl),
      "utf8",
    );
    const exportedValues = new Set(
      [...importedSource.matchAll(
        /^[\t ]*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gmu,
      )].map((valueMatch) => valueMatch[1]),
    );
    for (const specifier of match[1].split(",")) {
      const [importedName, localName = importedName] = specifier
        .trim()
        .split(/\s+as\s+/u);
      if (exportedValues.has(importedName)) {
        valueBindings.add(localName);
      }
    }
  }

  let clauseOffendingExport;
  const exportClausePattern =
    /^[\t ]*export\s*\{([^}]*)\}(?:\s*from\s*["'][^"']+["'])?\s*;/gmu;
  for (const match of workerSource.matchAll(exportClausePattern)) {
    for (const specifier of match[1].split(",")) {
      const [localName] = specifier.trim().split(/\s+as\s+/u);
      if (!valueBindings.has(localName)) {
        continue;
      }
      const offset = match.index + match[0].indexOf(localName);
      const line = workerSource.slice(0, offset).split(/\r?\n/u).length;
      clauseOffendingExport = { line, source: sourceLines[line - 1].source };
      break;
    }
    if (clauseOffendingExport !== undefined) {
      break;
    }
  }
  const offendingExport = [
    inlineOffendingExport,
    clauseOffendingExport,
  ].filter((value) => value !== undefined)
    .sort((left, right) => left.line - right.line)[0];

  assert.equal(
    offendingExport,
    undefined,
    offendingExport
      ? `src/worker.js:${offendingExport.line}: ${offendingExport.source}`
      : undefined,
  );
});

// Five-file test concurrency on a two-core runner can starve a dev proxy.
// This structure keeps only one worker from this file alive at a time.
describe("with BUILD_SHA", () => {
  let worker;

  before(async () => {
    worker = await bootWorker("BUILD_SHA-present", {
      CONTROL_TOKEN,
      BUILD_SHA,
      BUILD_REF,
      BUILD_TIME,
    });
  });

  after(async () => {
    await worker?.stop();
  });

  test("GET /version returns the injected build metadata", async () => {
    const response = await versionRequest(worker);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sha: BUILD_SHA,
      ref: BUILD_REF,
      builtAt: BUILD_TIME,
      worker: "gha-cloudflare-runner",
    });
  });

  test("GET /version requires the control token", async () => {
    const response = await worker.fetch("/version");

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  });

  test("POST /operator/registrations/cleanup reaches the authenticated Worker route", async () => {
    const response = await worker.fetch(
      "/operator/registrations/cleanup",
      { method: "POST" },
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  });

  test("GET /operator/registrations/cleanup reaches the POST-only Worker route", async () => {
    const response = await worker.fetch("/operator/registrations/cleanup");

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST");
    assert.deepEqual(await response.json(), { error: "Method not allowed" });
  });
});

describe("without BUILD_SHA", () => {
  let worker;

  before(async () => {
    worker = await bootWorker("BUILD_SHA-absent", {
      CONTROL_TOKEN,
      BUILD_REF,
      BUILD_TIME,
    });
  });

  after(async () => {
    await worker?.stop();
  });

  test("GET /version reports an unknown absent build SHA", async () => {
    const response = await versionRequest(worker);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sha: "unknown",
      ref: BUILD_REF,
      builtAt: BUILD_TIME,
      worker: "gha-cloudflare-runner",
    });
  });

  test("/version rejects non-GET methods with Allow", async () => {
    const response = await versionRequest(worker, { method: "POST" });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET");
    assert.deepEqual(await response.json(), { error: "Method not allowed" });
  });
});
