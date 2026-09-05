import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const scaleSetName = "cloudflare-sandbox";
export const githubToken = "github-token-value-must-stay-secret";
export const registrationToken =
  "registration-token-value-must-stay-secret";
export const adminToken = "admin-token-value-must-stay-secret";
export const staticAdminToken =
  "static-admin-token-value-must-stay-secret";
export const privateKey = "private-key-value-must-stay-secret";

const preflightScript = join(
  repositoryRoot,
  "scripts/preflight-scale-set.sh",
);

function writeExecutable(directory, name, source) {
  const path = join(directory, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function curlStubSource() {
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
let method = "GET";
let outputPath = null;
let requestBody = null;
let url = null;
const headers = [];

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--request") {
    method = args[index + 1];
    index += 1;
  } else if (argument === "--header") {
    headers.push(args[index + 1]);
    index += 1;
  } else if (argument === "--output") {
    outputPath = args[index + 1];
    index += 1;
  } else if (argument === "--write-out" ||
    argument === "--connect-timeout" || argument === "--max-time" ||
    argument === "--retry") {
    index += 1;
  } else if (argument === "--data-binary") {
    const data = args[index + 1];
    requestBody = data.startsWith("@")
      ? readFileSync(data.slice(1), "utf8")
      : data;
    index += 1;
  } else if (!argument.startsWith("-")) {
    url = argument;
  }
}

appendFileSync(
  process.env.CURL_REQUEST_LOG,
  JSON.stringify({ method, url, headers, body: requestBody }) + "\\n",
);
const responses = JSON.parse(
  readFileSync(process.env.CURL_RESPONSES, "utf8"),
);
const responseIndex = Number(
  readFileSync(process.env.CURL_RESPONSE_INDEX, "utf8"),
);
const response = responses[responseIndex];
if (response === undefined) {
  process.exit(97);
}
writeFileSync(
  process.env.CURL_RESPONSE_INDEX,
  String(responseIndex + 1),
);
if (outputPath !== null) {
  writeFileSync(outputPath, response.body ?? "");
}
if (response.exitCode !== undefined && response.exitCode !== 0) {
  process.exit(response.exitCode);
}
process.stdout.write(String(response.status));
`;
}

export function validEntry(overrides = {}) {
  return {
    scaleSetName,
    scaleSetId: 101,
    runnerGroupId: 17,
    owner: "octo-org",
    repository: "octo-org/octo-repo",
    outageGateUrl: "https://outage-gate.example/permit",
    actionsServiceUrl: "https://static-actions.example/tenant",
    adminToken: staticAdminToken,
    adminTokenExpiresAtMs: 1_900_000_000_000,
    ...overrides,
  };
}

export function keyedConfig(entry = validEntry()) {
  return { [scaleSetName]: entry };
}

export function liveResponses(scaleSets) {
  return [
    { status: 201, body: JSON.stringify({ token: registrationToken }) },
    {
      status: 200,
      body: JSON.stringify({
        url: "https://actions.example/tenant",
        token: adminToken,
      }),
    },
    { status: 200, body: JSON.stringify({ value: scaleSets }) },
  ];
}

export function runPreflight({
  config = keyedConfig(),
  configSource = "argument",
  scaleSet = scaleSetName,
  args = [],
  responses = [],
  env = {},
} = {}) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "preflight-scale-set-test-"),
  );
  const requestLog = join(temporaryDirectory, "curl-requests.jsonl");
  const responseFile = join(temporaryDirectory, "curl-responses.json");
  const responseIndex = join(temporaryDirectory, "curl-response-index");
  const configFile = join(temporaryDirectory, "scale-set-config.json");
  const configJson = typeof config === "string"
    ? config
    : JSON.stringify(config);

  writeExecutable(temporaryDirectory, "curl", curlStubSource());
  writeFileSync(requestLog, "");
  writeFileSync(responseFile, JSON.stringify(responses));
  writeFileSync(responseIndex, "0");
  writeFileSync(configFile, configJson);

  const childEnv = {
    ...process.env,
    PATH: `${temporaryDirectory}:${process.env.PATH}`,
    CURL_REQUEST_LOG: requestLog,
    CURL_RESPONSES: responseFile,
    CURL_RESPONSE_INDEX: responseIndex,
    GITHUB_TOKEN: githubToken,
    ...env,
  };
  delete childEnv.AUTOPILOT_SCALE_SETS;
  delete childEnv.REGISTRATION_TOKEN;
  delete childEnv.GITHUB_APP_ID;
  delete childEnv.GITHUB_APP_INSTALLATION_ID;
  delete childEnv.GITHUB_APP_PRIVATE_KEY;
  Object.assign(childEnv, env);

  const scriptArgs = [preflightScript, "--scale-set", scaleSet];
  if (configSource === "argument") {
    scriptArgs.push("--config", configJson);
  } else if (configSource === "file") {
    scriptArgs.push("--config", `@${configFile}`);
  } else if (configSource === "environment") {
    childEnv.AUTOPILOT_SCALE_SETS = configJson;
  } else {
    throw new Error(`Unknown configuration source: ${configSource}`);
  }
  scriptArgs.push(...args);

  try {
    const result = spawnSync("bash", scriptArgs, {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: childEnv,
    });
    const requests = existsSync(requestLog)
      ? readFileSync(requestLog, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line))
      : [];
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      requests,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
