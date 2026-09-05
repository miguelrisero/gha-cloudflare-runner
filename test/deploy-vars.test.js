import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  droppedBindings,
  formatBindings,
  latestVersionId,
  parseBindings,
  parseVersionBindings,
  parseVersionList,
  readKeepVars,
} from "../scripts/lib/deploy-vars.mjs";

const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url));
const deployVarsCli = fileURLToPath(
  new URL("../scripts/lib/deploy-vars.mjs", import.meta.url),
);

function runCli(args) {
  return spawnSync(process.execPath, [deployVarsCli, ...args], {
    cwd: repositoryDirectory,
    encoding: "utf8",
  });
}

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "deploy-vars-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("wrangler.jsonc sets keep_vars", () => {
  assert.equal(
    readKeepVars("wrangler.jsonc"),
    true,
    "keep_vars must stay true because a deploy destroyed 7 production variables",
  );
});

test("assert-keep-vars fails when the config omits keep_vars", (t) => {
  const directory = temporaryDirectory(t);
  const configPath = join(directory, "wrangler.jsonc");
  const repositoryConfig = readFileSync(
    join(repositoryDirectory, "wrangler.jsonc"),
    "utf8",
  );
  const configWithoutKeepVars = repositoryConfig.replace(
    /^ {2}"keep_vars": true,\n/mu,
    "",
  );
  assert.notEqual(configWithoutKeepVars, repositoryConfig);
  symlinkSync(
    join(repositoryDirectory, "container"),
    join(directory, "container"),
    "dir",
  );
  symlinkSync(
    join(repositoryDirectory, "src"),
    join(directory, "src"),
    "dir",
  );
  writeFileSync(configPath, configWithoutKeepVars);

  const result = runCli(["assert-keep-vars", configPath]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /keep_vars/u);
});

test("assert-keep-vars passes for the repository configuration", () => {
  const result = runCli(["assert-keep-vars", "wrangler.jsonc"]);

  assert.equal(result.status, 0, result.stderr);
});

test("the deploy script asserts keep_vars and diffs the bindings", () => {
  const source = readFileSync(
    join(repositoryDirectory, "scripts/deploy.sh"),
    "utf8",
  );

  assert.match(source, /deploy-vars\.mjs assert-keep-vars wrangler\.jsonc/u);
  assert.match(source, /deploy-vars\.mjs bindings/u);
  assert.match(source, /deploy-vars\.mjs diff-bindings/u);
});

test("parseVersionBindings fails closed when the version JSON has no bindings", () => {
  assert.throws(() => parseVersionBindings("{}"), /resources\.bindings/u);
  assert.throws(
    () => parseVersionBindings('{"resources":{}}'),
    /resources\.bindings/u,
  );
  assert.throws(
    () =>
      parseVersionBindings(
        '{"resources":{"bindings":[{"type":"plain_text"}]}}',
      ),
    /non-empty string name/u,
  );
});

test("parseVersionBindings keeps secret bindings", () => {
  const bindings = parseVersionBindings(
    JSON.stringify({
      resources: {
        bindings: [
          { name: "VISIBLE_VAR", type: "plain_text" },
          { name: "CONTROL_TOKEN", type: "secret_text" },
        ],
      },
    }),
  );

  assert.deepEqual(bindings, [
    { name: "CONTROL_TOKEN", type: "secret_text" },
    { name: "VISIBLE_VAR", type: "plain_text" },
  ]);
});

test("droppedBindings reports a var the deploy removed", () => {
  const before = [
    { name: "AUTOPILOT_ENABLED", type: "plain_text" },
    { name: "AUTOPILOT_SCALE_SETS", type: "json" },
    { name: "GITHUB_RUNNER_SCOPE", type: "plain_text" },
    { name: "RUNNER_REGISTRATION_DELETE", type: "plain_text" },
    { name: "GITHUB_REPOSITORY", type: "plain_text" },
  ];
  const after = [{ name: "GITHUB_REPOSITORY", type: "plain_text" }];

  assert.deepEqual(droppedBindings(before, after), [
    "AUTOPILOT_ENABLED",
    "AUTOPILOT_SCALE_SETS",
    "GITHUB_RUNNER_SCOPE",
    "RUNNER_REGISTRATION_DELETE",
  ]);
});

test("droppedBindings reports a dropped secret", () => {
  const before = [
    { name: "CONTROL_TOKEN", type: "secret_text" },
    { name: "GITHUB_REPOSITORY", type: "plain_text" },
  ];
  const after = [{ name: "GITHUB_REPOSITORY", type: "plain_text" }];

  assert.deepEqual(droppedBindings(before, after), ["CONTROL_TOKEN"]);
});

test("diff-bindings exits non-zero when a binding disappeared", (t) => {
  const directory = temporaryDirectory(t);
  const beforePath = join(directory, "before.tsv");
  const afterPath = join(directory, "after.tsv");
  const before = [
    { name: "AUTOPILOT_ENABLED", type: "plain_text" },
    { name: "GITHUB_REPOSITORY", type: "plain_text" },
  ];
  const after = [{ name: "GITHUB_REPOSITORY", type: "plain_text" }];
  writeFileSync(beforePath, formatBindings(before));
  writeFileSync(afterPath, formatBindings(after));

  const droppedResult = runCli(["diff-bindings", beforePath, afterPath]);
  assert.equal(droppedResult.status, 1);
  assert.match(droppedResult.stderr, /AUTOPILOT_ENABLED \(plain_text\)/u);

  const unchangedResult = runCli(["diff-bindings", beforePath, beforePath]);
  assert.equal(unchangedResult.status, 0, unchangedResult.stderr);
});

test("latestVersionId picks the newest version and tolerates an empty list", () => {
  const versions = parseVersionList(
    JSON.stringify([
      { id: "old", metadata: { created_on: "2026-08-25T00:00:00Z" } },
      { id: "new", metadata: { created_on: "2026-08-26T00:00:00Z" } },
    ]),
  );

  assert.equal(latestVersionId(versions), "new");
  assert.equal(latestVersionId([]), null);
});

test("binding snapshots use sorted name and type lines", () => {
  const bindings = [
    { name: "SECOND", type: "secret_text" },
    { name: "FIRST", type: "plain_text" },
  ];

  const snapshot = "FIRST\tplain_text\nSECOND\tsecret_text\n";
  assert.equal(formatBindings(bindings), snapshot);
  assert.deepEqual(parseBindings(snapshot), bindings.toReversed());
});

test("version parsers reject invalid top-level data", () => {
  assert.throws(() => parseVersionList("{}"), /JSON array/u);
  assert.throws(
    () => latestVersionId([{ metadata: { created_on: "2026-08-26" } }]),
    /non-empty string id/u,
  );
  assert.throws(
    () =>
      parseVersionBindings(
        '{"resources":{"bindings":[{"name":"VAR"}]}}',
      ),
    /non-empty string type/u,
  );
});

test("bindings exits non-zero when the version JSON is malformed", (t) => {
  const directory = temporaryDirectory(t);
  const versionPath = join(directory, "version.json");
  writeFileSync(versionPath, "{}");

  const result = runCli(["bindings", versionPath]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /resources\.bindings/u);
});
