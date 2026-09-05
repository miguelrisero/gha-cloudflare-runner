import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT_PATH = fileURLToPath(
  new URL("../container/run-actions-runner.sh", import.meta.url),
);
const CLEANUP_TOKEN = "cleanup-bearer-token";
const CLEANUP_URL = "https://cleanup.invalid/runners/test-runner";
const RUNNER_NAME = "test-runner";
const RUNNER_URL = "https://github.com/example/repository";
const RUNNER_LABELS = "self-hosted,cloudflare";

async function writeExecutable(path, lines) {
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o755 });
}

async function createFixture(root, name) {
  const fixtureDirectory = join(root, name);
  const binDirectory = join(fixtureDirectory, "bin");
  const runnerDirectory = join(fixtureDirectory, "actions-runner");
  const chmodLog = join(fixtureDirectory, "chmod.log");
  const configLog = join(fixtureDirectory, "config.log");
  const curlLog = join(fixtureDirectory, "curl.log");
  const runLog = join(fixtureDirectory, "run.log");
  const umaskDirectory = join(fixtureDirectory, "umask-directory");
  const umaskFile = join(fixtureDirectory, "umask-file");

  await Promise.all([
    mkdir(binDirectory, { recursive: true }),
    mkdir(runnerDirectory, { recursive: true }),
  ]);

  await Promise.all([
    writeFile(chmodLog, ""),
    writeExecutable(join(binDirectory, "runuser"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "while (($# > 0)); do",
      "  case $1 in",
      "    --user)",
      "      shift 2",
      "      ;;",
      "    --preserve-environment)",
      "      shift",
      "      ;;",
      "    --)",
      "      shift",
      "      break",
      "      ;;",
      "    *)",
      "      exit 64",
      "      ;;",
      "  esac",
      "done",
      "if [[ \"${1:-}\" == /usr/local/bin/docker ]]; then",
      "  shift",
      "  exec docker \"$@\"",
      "fi",
      "if [[ \"${1:-}\" == /bin/bash && \"${2:-}\" == -c ]]; then",
      "  runner_command=$3",
      "  runner_command=${runner_command/\"cd /opt/actions-runner\"/:}",
      "  cd \"$RUNNER_TEST_RUNNER_DIR\"",
      "  exec /bin/bash -c \"$runner_command\"",
      "fi",
      "exit 64",
    ]),
    writeExecutable(join(binDirectory, "docker"), [
      "#!/usr/bin/env bash",
      "exit 0",
    ]),
    writeExecutable(join(binDirectory, "chmod"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ': >"$RUNNER_TEST_CHMOD_LOG"',
      'for argument in "$@"; do',
      "  printf '%s\\n' \"$argument\" >>\"$RUNNER_TEST_CHMOD_LOG\"",
      "done",
      'exit "$RUNNER_TEST_CHMOD_EXIT_STATUS"',
    ]),
    writeExecutable(join(binDirectory, "curl"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "[[ ! -v RUNNER_JITCONFIG ]]",
      ': >"$RUNNER_TEST_CURL_LOG"',
      'for argument in "$@"; do',
      "  printf '%s\\n' \"$argument\" >>\"$RUNNER_TEST_CURL_LOG\"",
      "done",
    ]),
    writeExecutable(join(runnerDirectory, "config.sh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ': >"$RUNNER_TEST_CONFIG_LOG"',
      'for argument in "$@"; do',
      "  printf '%s\\n' \"$argument\" >>\"$RUNNER_TEST_CONFIG_LOG\"",
      "done",
    ]),
    writeExecutable(join(runnerDirectory, "run.sh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      ': >"$RUNNER_TEST_RUN_LOG"',
      'for argument in "$@"; do',
      "  printf '%s\\n' \"$argument\" >>\"$RUNNER_TEST_RUN_LOG\"",
      "done",
      ': >"$RUNNER_TEST_UMASK_FILE"',
      'mkdir -p "$RUNNER_TEST_UMASK_DIR"',
      "printf 'Listening for Jobs\\n'",
      'exit "$RUNNER_TEST_RUN_EXIT_STATUS"',
    ]),
  ]);

  return {
    binDirectory,
    chmodLog,
    configLog,
    curlLog,
    runLog,
    runnerDirectory,
    umaskDirectory,
    umaskFile,
  };
}

function executeScript(environment, xtrace) {
  return new Promise((resolve, reject) => {
    const scriptArguments = xtrace ? ["-x", SCRIPT_PATH] : [SCRIPT_PATH];
    const arguments_ = [
      "-c",
      'umask 0022; exec /bin/bash "$@"',
      "runner-test",
      ...scriptArguments,
    ];
    const child = spawn("/bin/bash", arguments_, {
      env: environment,
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

async function runScenario(root, name, {
  chmodExitStatus = 0,
  jitConfig,
  runnerExitStatus = 0,
  runnerToken,
  xtrace = false,
}) {
  const fixture = await createFixture(root, name);
  const environment = {
    ...process.env,
    PATH: `${fixture.binDirectory}:${process.env.PATH}`,
    RUNNER_CLEANUP_TOKEN: CLEANUP_TOKEN,
    RUNNER_CLEANUP_URL: CLEANUP_URL,
    RUNNER_LABELS,
    RUNNER_NAME,
    RUNNER_TEST_CHMOD_EXIT_STATUS: String(chmodExitStatus),
    RUNNER_TEST_CHMOD_LOG: fixture.chmodLog,
    RUNNER_TEST_CONFIG_LOG: fixture.configLog,
    RUNNER_TEST_CURL_LOG: fixture.curlLog,
    RUNNER_TEST_RUN_EXIT_STATUS: String(runnerExitStatus),
    RUNNER_TEST_RUN_LOG: fixture.runLog,
    RUNNER_TEST_RUNNER_DIR: fixture.runnerDirectory,
    RUNNER_TEST_UMASK_DIR: fixture.umaskDirectory,
    RUNNER_TEST_UMASK_FILE: fixture.umaskFile,
    RUNNER_URL,
  };

  if (jitConfig === undefined) {
    delete environment.RUNNER_JITCONFIG;
  } else {
    environment.RUNNER_JITCONFIG = jitConfig;
  }
  if (runnerToken === undefined) {
    delete environment.RUNNER_TOKEN;
  } else {
    environment.RUNNER_TOKEN = runnerToken;
  }

  return {
    fixture,
    result: await executeScript(environment, xtrace),
  };
}

async function readArguments(path) {
  const contents = await readFile(path, "utf8");

  if (contents === "") {
    return [];
  }
  assert.ok(contents.endsWith("\n"));
  return contents.slice(0, -1).split("\n");
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function assertCleanup(fixture) {
  const arguments_ = await readArguments(fixture.curlLog);
  const requestIndex = arguments_.indexOf("--request");
  const headerIndex = arguments_.indexOf("--header");

  assert.equal(arguments_[requestIndex + 1], "DELETE");
  assert.equal(
    arguments_[headerIndex + 1],
    `Authorization: Bearer ${CLEANUP_TOKEN}`,
  );
  assert.equal(arguments_.at(-1), CLEANUP_URL);
}

async function assertWorkspacePermissions(fixture) {
  assert.deepEqual(await readArguments(fixture.chmodLog), [
    "0777",
    "/workspace/_work",
  ]);
  const fileMode = (await stat(fixture.umaskFile)).mode & 0o777;
  const directoryMode = (await stat(fixture.umaskDirectory)).mode & 0o777;

  assert.equal(fileMode, 0o666);
  assert.equal(directoryMode, 0o777);
  // An unmatched, unmapped container ID reaches these paths only through the
  // other class.
  assert.equal(fileMode & 0o002, 0o002);
  assert.equal(directoryMode & 0o007, 0o007);
}

function assertRunnerOutput(result) {
  assert.match(result.stdout, /Listening for Jobs/i);
  assert.match(
    result.stdout,
    /CF_RUNNER_SUMMARY \{"runnerName":"test-runner","runnerProcess":"exited","cleanupCallbackExitStatus":0\}/,
  );
}

test("stops boot and runs cleanup when workspace chmod fails", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "run-actions-runner-test-"),
  );
  const runnerToken = "chmod-failure-runner-token";

  try {
    const chmodFailure = await runScenario(
      temporaryDirectory,
      "chmod-failure",
      { chmodExitStatus: 23, runnerToken, xtrace: true },
    );

    assert.notEqual(chmodFailure.result.code, 0);
    assert.deepEqual(await readArguments(chmodFailure.fixture.chmodLog), [
      "0777",
      "/workspace/_work",
    ]);
    assert.equal(await pathExists(chmodFailure.fixture.runLog), false);
    assert.equal(await pathExists(chmodFailure.fixture.configLog), false);
    await assertCleanup(chmodFailure.fixture);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("runs JIT and manual registrations through the real entrypoint", async () => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "run-actions-runner-test-"),
  );
  const jitConfig = "jit-success-config-S3cr3t+/=";
  const failedJitConfig = "jit-failure-config-S3cr3t+/=";
  const runnerToken = "manual-registration-token";

  try {
    const jit = await runScenario(temporaryDirectory, "jit-success", {
      jitConfig,
      xtrace: true,
    });

    assert.equal(jit.result.code, 0);
    assert.equal(jit.result.signal, null);
    assert.deepEqual(
      await readArguments(jit.fixture.runLog),
      ["--jitconfig", jitConfig],
    );
    assert.equal(await pathExists(jit.fixture.configLog), false);
    assert.equal(
      `${jit.result.stdout}${jit.result.stderr}`.includes(jitConfig),
      false,
    );
    assertRunnerOutput(jit.result);
    await assertCleanup(jit.fixture);
    await assertWorkspacePermissions(jit.fixture);

    const failedJit = await runScenario(temporaryDirectory, "jit-failure", {
      jitConfig: failedJitConfig,
      runnerExitStatus: 23,
      xtrace: true,
    });

    assert.equal(failedJit.result.code, 23);
    assert.deepEqual(
      await readArguments(failedJit.fixture.runLog),
      ["--jitconfig", failedJitConfig],
    );
    assert.equal(await pathExists(failedJit.fixture.configLog), false);
    assert.equal(
      `${failedJit.result.stdout}${failedJit.result.stderr}`.includes(
        failedJitConfig,
      ),
      false,
    );
    assertRunnerOutput(failedJit.result);
    await assertCleanup(failedJit.fixture);
    await assertWorkspacePermissions(failedJit.fixture);

    const manual = await runScenario(temporaryDirectory, "manual", {
      jitConfig: "",
      runnerToken,
    });

    assert.equal(manual.result.code, 0);
    assert.deepEqual(await readArguments(manual.fixture.configLog), [
      "--unattended",
      "--ephemeral",
      "--disableupdate",
      "--no-default-labels",
      "--url",
      RUNNER_URL,
      "--token",
      runnerToken,
      "--name",
      RUNNER_NAME,
      "--labels",
      RUNNER_LABELS,
      "--work",
      "/workspace/_work",
    ]);
    assert.deepEqual(await readArguments(manual.fixture.runLog), []);
    assertRunnerOutput(manual.result);
    await assertCleanup(manual.fixture);
    await assertWorkspacePermissions(manual.fixture);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
