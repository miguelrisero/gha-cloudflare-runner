import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(TEST_DIRECTORY, "..");
const SCRIPTS_DIRECTORY = join(REPOSITORY_ROOT, "scripts");
const SPAWN_SCRIPT = join(SCRIPTS_DIRECTORY, "spawn-runner.sh");
const MEASUREMENT_SCRIPT = join(
  SCRIPTS_DIRECTORY,
  "run-measurement.sh",
);

function runScript(script, arguments_ = [], environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(script, arguments_, {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
  });
}

async function startCountingServer() {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(204);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
    requestCount: () => requestCount,
    url: `http://127.0.0.1:${address.port}`,
  };
}

test("the retired spawn script refuses and never calls the Worker", async () => {
  const server = await startCountingServer();
  try {
    const result = await runScript(SPAWN_SCRIPT, [], {
      CONTROL_TOKEN: "dummy-control-token",
      WORKER_URL: server.url,
    });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /POST \/runners requires a non-empty application\/json JIT request body/u,
    );
    assert.match(result.stderr, /AutopilotControl/u);
    assert.match(result.stderr, /docs\/AUTOPILOT-OPERATIONS\.md/u);
    assert.equal(server.requestCount(), 0);
  } finally {
    await server.close();
  }
});

test("the retired spawn script refuses with a correlation id argument", async () => {
  const server = await startCountingServer();
  try {
    const result = await runScript(SPAWN_SCRIPT, ["correlation-id"], {
      CONTROL_TOKEN: "dummy-control-token",
      WORKER_URL: server.url,
    });
    assert.equal(result.code, 2);
    assert.equal(server.requestCount(), 0);
  } finally {
    await server.close();
  }
});

test("no script drives the retired manual spawn path", async () => {
  const scriptFileNames = (await readdir(SCRIPTS_DIRECTORY, {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile() && entry.name !== "spawn-runner.sh")
    .map((entry) => entry.name)
    .sort();
  const scriptFiles = await Promise.all(
    scriptFileNames.map(async (fileName) => ({
      contents: await readFile(join(SCRIPTS_DIRECTORY, fileName), "utf8"),
      fileName,
    })),
  );
  const offendingFileNames = scriptFiles
    .filter(({ contents }) => contents.includes("spawn-runner.sh"))
    .map(({ fileName }) => `scripts/${fileName}`);

  assert.deepEqual(
    offendingFileNames,
    [],
    `Scripts reference spawn-runner.sh: ${offendingFileNames.join(", ")}`,
  );
  await assert.rejects(
    access(MEASUREMENT_SCRIPT),
    (error) => error.code === "ENOENT",
    "scripts/run-measurement.sh must not exist",
  );
});
