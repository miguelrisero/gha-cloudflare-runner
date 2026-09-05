import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

import { guardDevWorkerTransport } from "./dev-worker-transport.js";

process.env.WRANGLER_WRITE_LOGS = "false";

const { unstable_dev } = await import("wrangler");
const execFileAsync = promisify(execFile);

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = join(TEST_DIRECTORY, "..");
const TOOL_PATH = join(
  REPOSITORY_DIRECTORY,
  "scripts",
  "sign-capacity-approval.sh",
);
const AUTOPILOT_SOURCE_PATH = join(
  REPOSITORY_DIRECTORY,
  "src",
  "autopilot-control.js",
);
const CONTROL_TOKEN = "control-token-with-at-least-32-characters";
const APPROVED_BY = "capacity-owner";
const EFFECTIVE_AT_MS = 1_800_000_000_000;
const CAPACITY_ROUTE =
  "http://example.com/autopilot/control/capacity";
const CONTROL_ROUTE = "http://example.com/autopilot/control";

let persistencePath;
let keyDirectory;
let signingKeyPath;
let wrongKeyPath;
let publicKeyPemPath;
let publicKeyBase64Url;
let toolPublicKeyOutput;
let worker;

function devOptions(vars, persistTo) {
  return {
    config: "test/autopilot-wrangler.jsonc",
    logLevel: "none",
    persist: true,
    persistTo,
    vars,
    experimental: {
      disableDevRegistry: true,
      disableExperimentalWarning: true,
      watch: false,
    },
  };
}

function runTool(arguments_) {
  return execFileAsync(TOOL_PATH, arguments_, {
    cwd: REPOSITORY_DIRECTORY,
    encoding: "utf8",
  });
}

function signWithTool({
  key = signingKeyPath,
  approvedBy = APPROVED_BY,
  capacity = 3,
  effectiveAtMs = EFFECTIVE_AT_MS,
} = {}) {
  return runTool([
    "--key",
    key,
    "--approved-by",
    approvedBy,
    "--capacity",
    String(capacity),
    "--effective-at",
    String(effectiveAtMs),
  ]);
}

async function runToolFailure(arguments_) {
  let failure;
  try {
    await runTool(arguments_);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, "the tool must exit with an error");
  assert.notEqual(failure.code, 0);
  return failure;
}

function authenticatedHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${CONTROL_TOKEN}`,
    ...extra,
  };
}

function postCapacity(body) {
  return worker.fetch(CAPACITY_ROUTE, {
    method: "POST",
    headers: authenticatedHeaders({
      "Content-Type": "application/json",
    }),
    body,
  });
}

async function controlStatus() {
  const response = await worker.fetch(CONTROL_ROUTE, {
    headers: authenticatedHeaders(),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function responseBody(response, expectedStatus) {
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}

async function generateEd25519Key(path) {
  await execFileAsync(
    "openssl",
    ["genpkey", "-algorithm", "ed25519", "-out", path],
    { encoding: "utf8" },
  );
}

before(async () => {
  persistencePath = await mkdtemp(
    join(tmpdir(), "capacity-approval-persistence-"),
  );
  keyDirectory = await mkdtemp(
    join(tmpdir(), "capacity-approval-keys-"),
  );
  signingKeyPath = join(keyDirectory, "capacity-approval.key");
  wrongKeyPath = join(keyDirectory, "wrong-capacity-approval.key");
  publicKeyPemPath = join(keyDirectory, "capacity-approval.pub");

  await generateEd25519Key(signingKeyPath);
  const documentedPublicKey = await execFileAsync(
    "bash",
    [
      "-c",
      'openssl pkey -in "$1" -pubout -outform DER | tail -c 32 | base64 -w0',
      "capacity-approval-public-key",
      signingKeyPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    Buffer.from(documentedPublicKey.stdout, "base64").length,
    32,
  );
  assert.match(documentedPublicKey.stdout, /=$/u);
  publicKeyBase64Url = documentedPublicKey.stdout
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

  const toolPublicKey = await runTool([
    "--key",
    signingKeyPath,
    "--public-key",
  ]);
  assert.equal(toolPublicKey.stdout, `${publicKeyBase64Url}\n`);
  assert.equal(toolPublicKey.stderr, "");
  toolPublicKeyOutput = toolPublicKey.stdout;

  await generateEd25519Key(wrongKeyPath);
  await execFileAsync(
    "openssl",
    [
      "pkey",
      "-in",
      signingKeyPath,
      "-pubout",
      "-out",
      publicKeyPemPath,
    ],
    { encoding: "utf8" },
  );

  worker = guardDevWorkerTransport(await unstable_dev(
    "test/autopilot-harness.js",
    devOptions(
      { CAPACITY_APPROVAL_PUBLIC_KEY: publicKeyBase64Url },
      persistencePath,
    ),
  ));
});

after(async () => {
  try {
    await worker?.stop();
  } finally {
    await Promise.all([
      persistencePath === undefined
        ? Promise.resolve()
        : rm(persistencePath, { recursive: true, force: true }),
      keyDirectory === undefined
        ? Promise.resolve()
        : rm(keyDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("the signing tool round trips through the real Worker route", async () => {
  const signed = await signWithTool();
  const payload = JSON.parse(signed.stdout);
  assert.deepEqual(Object.keys(payload), [
    "approvedBy",
    "capacity",
    "effectiveAtMs",
    "signature",
  ]);
  assert.equal(payload.approvedBy, APPROVED_BY);
  assert.equal(payload.capacity, 3);
  assert.equal(payload.effectiveAtMs, EFFECTIVE_AT_MS);
  assert.match(payload.signature, /^[A-Za-z0-9_-]+$/u);
  assert.equal(Buffer.from(payload.signature, "base64url").length, 64);
  assert.match(
    signed.stderr,
    new RegExp(
      `Canonical approval: ${JSON.stringify({
        approvedBy: APPROVED_BY,
        capacity: 3,
        effectiveAtMs: EFFECTIVE_AT_MS,
      }).replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
      "u",
    ),
  );
  assert.ok(signed.stderr.includes(`Signature: ${payload.signature}\n`));
  assert.ok(signed.stderr.includes(`Public key: ${publicKeyBase64Url}\n`));

  const response = await postCapacity(signed.stdout);
  assert.deepEqual(await responseBody(response, 200), {
    recorded: true,
    approvedCapacity: 3,
    effectiveAtMs: EFFECTIVE_AT_MS,
    approvedBy: APPROVED_BY,
  });

  const status = await controlStatus();
  assert.equal(status.approvedCapacity, 3);
  assert.equal(status.maxCapacity, 3);
});

test("a tampered capacity is rejected", async () => {
  const signed = await signWithTool();
  const payload = JSON.parse(signed.stdout);
  payload.capacity = 2;
  const statusBefore = await controlStatus();

  const response = await postCapacity(JSON.stringify(payload));
  const body = await responseBody(response, 400);
  assert.equal(body.reason, "capacity-approval-invalid");

  const statusAfter = await controlStatus();
  assert.equal(
    statusAfter.approvedCapacity,
    statusBefore.approvedCapacity,
  );
  assert.equal(statusAfter.maxCapacity, statusBefore.maxCapacity);
});

test("a signature from the wrong key is rejected", async () => {
  const signed = await signWithTool({ key: wrongKeyPath });
  const response = await postCapacity(signed.stdout);
  const body = await responseBody(response, 400);
  assert.equal(body.reason, "capacity-approval-invalid");
});

test("a reordered canonical key order is rejected", async () => {
  const canonicalPath = join(keyDirectory, "reordered-capacity.json");
  const signaturePath = join(keyDirectory, "reordered-capacity.sig");
  const canonical = JSON.stringify({
    capacity: 3,
    approvedBy: APPROVED_BY,
    effectiveAtMs: EFFECTIVE_AT_MS,
  });

  try {
    await writeFile(canonicalPath, canonical);
    await execFileAsync(
      "openssl",
      [
        "pkeyutl",
        "-sign",
        "-rawin",
        "-inkey",
        signingKeyPath,
        "-in",
        canonicalPath,
        "-out",
        signaturePath,
      ],
      { encoding: "utf8" },
    );
    const signature = await readFile(signaturePath);
    assert.equal(signature.length, 64);

    const response = await postCapacity(JSON.stringify({
      approvedBy: APPROVED_BY,
      capacity: 3,
      effectiveAtMs: EFFECTIVE_AT_MS,
      signature: signature.toString("base64url"),
    }));
    const body = await responseBody(response, 400);
    assert.equal(body.reason, "capacity-approval-invalid");
  } finally {
    await Promise.all([
      rm(canonicalPath, { force: true }),
      rm(signaturePath, { force: true }),
    ]);
  }
});

test("the signing tool refuses to exceed MAX_ACTIVE_RUNNERS", async () => {
  const source = await readFile(AUTOPILOT_SOURCE_PATH, "utf8");
  const matches = [
    ...source.matchAll(
      /^export const MAX_ACTIVE_RUNNERS = (0|[1-9][0-9]*);$/gmu,
    ),
  ];
  assert.equal(matches.length, 1);
  const maxActiveRunners = Number(matches[0][1]);
  assert.equal(maxActiveRunners, 300);

  const failure = await runToolFailure([
    "--key",
    signingKeyPath,
    "--approved-by",
    APPROVED_BY,
    "--capacity",
    String(maxActiveRunners + 1),
    "--effective-at",
    String(EFFECTIVE_AT_MS),
  ]);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /MAX_ACTIVE_RUNNERS/u);
  assert.doesNotMatch(failure.stderr, /Signature:/u);
});

test("signing never produces a private key", async () => {
  const filesBefore = (await readdir(keyDirectory)).sort();
  const signed = await signWithTool({ approvedBy: "key-safety-owner" });
  const filesAfter = (await readdir(keyDirectory)).sort();

  assert.deepEqual(filesAfter, filesBefore);
  assert.doesNotMatch(signed.stdout, /PRIVATE KEY|BEGIN/u);
  assert.doesNotMatch(signed.stderr, /PRIVATE KEY|BEGIN/u);
});

test("the public-key output agrees with the documented recipe", async () => {
  assert.equal(toolPublicKeyOutput, `${publicKeyBase64Url}\n`);
  assert.equal(Buffer.from(toolPublicKeyOutput.trim(), "base64url").length, 32);
  assert.doesNotMatch(toolPublicKeyOutput, /=/u);

  const publicKeyFailure = await runToolFailure([
    "--key",
    publicKeyPemPath,
    "--public-key",
  ]);
  assert.equal(publicKeyFailure.stdout, "");
  assert.match(publicKeyFailure.stderr, /Ed25519 private key/u);

  const signingFailure = await runToolFailure([
    "--key",
    publicKeyPemPath,
    "--approved-by",
    APPROVED_BY,
    "--capacity",
    "3",
    "--effective-at",
    String(EFFECTIVE_AT_MS),
  ]);
  assert.equal(signingFailure.stdout, "");
  assert.match(signingFailure.stderr, /Ed25519 private key/u);
});

test("a non-Ed25519 private key is refused", async () => {
  const rsaKeyPath = join(keyDirectory, "rsa-capacity-approval.key");
  const ecKeyPath = join(keyDirectory, "ec-capacity-approval.key");

  try {
    await execFileAsync(
      "openssl",
      [
        "genpkey",
        "-algorithm",
        "RSA",
        "-pkeyopt",
        "rsa_keygen_bits:2048",
        "-out",
        rsaKeyPath,
      ],
      { encoding: "utf8" },
    );
    await execFileAsync(
      "openssl",
      [
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        ecKeyPath,
      ],
      { encoding: "utf8" },
    );

    for (const keyPath of [rsaKeyPath, ecKeyPath]) {
      const signingFailure = await runToolFailure([
        "--key",
        keyPath,
        "--approved-by",
        APPROVED_BY,
        "--capacity",
        "3",
        "--effective-at",
        String(EFFECTIVE_AT_MS),
      ]);
      assert.equal(signingFailure.stdout, "");
      assert.match(signingFailure.stderr, /Ed25519 private key/u);

      const publicKeyFailure = await runToolFailure([
        "--key",
        keyPath,
        "--public-key",
      ]);
      assert.equal(publicKeyFailure.stdout, "");
      assert.match(publicKeyFailure.stderr, /Ed25519 private key/u);
    }
  } finally {
    await Promise.all([
      rm(rsaKeyPath, { force: true }),
      rm(ecKeyPath, { force: true }),
    ]);
  }
});

test("the curl output carries a sendable payload and never the token value", async () => {
  const signingArguments = [
    "--key",
    signingKeyPath,
    "--approved-by",
    APPROVED_BY,
    "--capacity",
    "1",
    "--effective-at",
    String(EFFECTIVE_AT_MS),
  ];
  const curlResult = await runTool([
    ...signingArguments,
    "--curl",
    "--worker-url",
    "https://worker.example",
  ]);

  assert.ok(curlResult.stdout.startsWith("curl "));
  assert.ok(curlResult.stdout.includes("$CONTROL_TOKEN"));
  assert.ok(!curlResult.stdout.includes(CONTROL_TOKEN));
  assert.ok(curlResult.stdout.includes(
    "https://worker.example/autopilot/control/capacity",
  ));
  assert.ok(curlResult.stdout.endsWith("\n"));
  assert.doesNotMatch(curlResult.stdout.slice(0, -1), /[\r\n]/u);

  const dataArguments = [
    ...curlResult.stdout.matchAll(
      / -d ('(?:[^'\r\n]|'\\'')*')(?= )/gu,
    ),
  ];
  assert.equal(dataArguments.length, 1);
  const quotedPayload = dataArguments[0][1];
  const extractedPayload = quotedPayload
    .slice(1, -1)
    .replaceAll("'\\''", "'");
  const payload = JSON.parse(extractedPayload);
  assert.deepEqual(Object.keys(payload), [
    "approvedBy",
    "capacity",
    "effectiveAtMs",
    "signature",
  ]);

  const response = await worker.fetch(CAPACITY_ROUTE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONTROL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: extractedPayload,
  });
  const body = await responseBody(response, 200);
  assert.equal(body.recorded, true);
  assert.equal(body.approvedCapacity, 1);

  const environment = { ...process.env };
  delete environment.WORKER_URL;
  let missingWorkerUrlFailure;
  try {
    await execFileAsync(TOOL_PATH, [...signingArguments, "--curl"], {
      cwd: REPOSITORY_DIRECTORY,
      encoding: "utf8",
      env: environment,
    });
  } catch (error) {
    missingWorkerUrlFailure = error;
  }
  assert.ok(
    missingWorkerUrlFailure instanceof Error,
    "the tool must exit with an error",
  );
  assert.notEqual(missingWorkerUrlFailure.code, 0);
  assert.equal(missingWorkerUrlFailure.stdout, "");
  assert.match(
    missingWorkerUrlFailure.stderr,
    /--curl requires --worker-url URL or the WORKER_URL environment variable/u,
  );
});
