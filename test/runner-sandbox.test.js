import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  SandboxDestroyNotConfirmed,
  withConfirmedDestroy,
} from "../src/runner-sandbox.js";

const NO_INSTANCE_MESSAGE =
  "There is no container instance that can be provided to this Durable " +
  "Object, try again later";

/**
 * Mirrors the vendor `doDestroy()` swallow: the destroy error reaches
 * `this.isNoInstanceError`, and a `true` answer returns instead of throwing.
 */
class VendorLikeSandbox {
  constructor({ destroyError = null, running = false } = {}) {
    this.sandboxName = "runner-test";
    this.destroyCalls = 0;
    this.destroyError = destroyError;
    this.ctx = { container: { running } };
  }

  isNoInstanceError(error) {
    return String(error?.message ?? error).toLowerCase().includes(
      "no container instance",
    );
  }

  async destroy() {
    this.destroyCalls += 1;
    const error = this.destroyError;
    if (error === null) {
      return;
    }
    if (!this.isNoInstanceError(error)) {
      throw error;
    }
  }
}

const ConfirmedSandbox = withConfirmedDestroy(VendorLikeSandbox);

async function withCapturedLog(run) {
  const records = [];
  const original = console.log;
  console.log = (line) => {
    records.push(line);
  };
  try {
    return await run(records);
  } finally {
    console.log = original;
  }
}

test("a confirmed destroy resolves and logs nothing", async () => {
  const sandbox = new ConfirmedSandbox();
  await withCapturedLog(async (records) => {
    await sandbox.destroy();
    assert.deepEqual(records, []);
  });
  assert.equal(sandbox.destroyCalls, 1);
});

test("a swallowed no-instance destroy fails instead of reporting success", async () => {
  const platformError = new Error(NO_INSTANCE_MESSAGE);
  const sandbox = new ConfirmedSandbox({ destroyError: platformError });
  await withCapturedLog(async () => {
    await assert.rejects(
      () => sandbox.destroy(),
      (error) => {
        assert.ok(error instanceof SandboxDestroyNotConfirmed);
        assert.equal(error.cause, platformError);
        assert.match(error.message, /runner-test/u);
        return true;
      },
    );
  });
});

test("the unconfirmed destroy records one observation", async () => {
  const sandbox = new ConfirmedSandbox({
    destroyError: new Error(NO_INSTANCE_MESSAGE),
    running: true,
  });
  await withCapturedLog(async (records) => {
    await assert.rejects(() => sandbox.destroy());
    assert.equal(records.length, 1);
    assert.deepEqual(JSON.parse(records[0]), {
      message: "sandbox destroy not confirmed",
      reason: "no-container-instance",
      sandboxName: "runner-test",
      containerRunning: true,
      detail: NO_INSTANCE_MESSAGE,
    });
  });
});

test("an unrelated destroy error keeps its own type", async () => {
  const failure = new Error("the durable object is overloaded");
  const sandbox = new ConfirmedSandbox({ destroyError: failure });
  await assert.rejects(() => sandbox.destroy(), (error) => {
    assert.equal(error, failure);
    return true;
  });
});

test("the predicate arms nothing outside a destroy", async () => {
  const sandbox = new ConfirmedSandbox();
  assert.equal(
    sandbox.isNoInstanceError(new Error(NO_INSTANCE_MESSAGE)),
    true,
  );
  await sandbox.destroy();
});

test("a later confirmed destroy is not failed by an earlier one", async () => {
  const sandbox = new ConfirmedSandbox({
    destroyError: new Error(NO_INSTANCE_MESSAGE),
  });
  await withCapturedLog(async () => {
    await assert.rejects(() => sandbox.destroy());
  });
  sandbox.destroyError = null;
  await sandbox.destroy();
  assert.equal(sandbox.destroyCalls, 2);
});

test("an unreadable container handle does not mask the destroy result", async () => {
  const sandbox = new ConfirmedSandbox({
    destroyError: new Error(NO_INSTANCE_MESSAGE),
  });
  Object.defineProperty(sandbox, "ctx", {
    get() {
      throw new Error("the container handle is unavailable");
    },
  });
  await withCapturedLog(async (records) => {
    await assert.rejects(
      () => sandbox.destroy(),
      (error) => error instanceof SandboxDestroyNotConfirmed,
    );
    assert.equal(JSON.parse(records[0]).containerRunning, null);
  });
});

// The vendor package resolves `cloudflare:` imports, so it cannot be loaded
// here. Read its build instead: this pins the two facts the mixin relies on.
test("the vendor still routes its destroy swallow through isNoInstanceError", () => {
  // The package exports map hides package.json, so resolve the build by path.
  const distDirectory = new URL(
    "../node_modules/@cloudflare/sandbox/dist/",
    import.meta.url,
  );
  const sources = readdirSync(distDirectory)
    .filter((entry) => entry.endsWith(".js"))
    .map((entry) => readFileSync(new URL(entry, distDirectory), "utf8"));

  const swallow = sources.filter((source) =>
    source.includes("if (!this.isNoInstanceError(error)) throw error;")
  );
  assert.equal(
    swallow.length,
    1,
    "the vendor destroy swallow moved; re-check withConfirmedDestroy",
  );
  const callSites = swallow[0].split("this.isNoInstanceError(").length - 1;
  assert.equal(
    callSites,
    1,
    "isNoInstanceError gained a call site outside the destroy swallow",
  );
  assert.ok(
    swallow[0].includes(
      "there is no container instance that can be provided to this durable object",
    ),
    "the vendor no longer classifies the observed platform error",
  );
});
