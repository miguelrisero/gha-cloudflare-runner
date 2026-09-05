import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

// The scale-up path admits a start only when the resolved repository appears
// in this allow-list. A scale set that declares its own repository stays
// unambiguous however long the list is; one that omits it falls back to
// GITHUB_REPOSITORY, so a longer list would leave the attribution
// undetermined and the path refuses.
//
// Deploying an allow-list the path cannot satisfy stops the fleet without
// stopping the listener: heartbeats, sessions and polling all stay healthy
// while runner-spawned holds at zero. That shape ran for three days from
// 2026-08-30.
const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

function deployedVars() {
  return unstable_readConfig({ config: configPath }, { hideWarnings: true })
    .vars;
}

test("every allow-list entry names a repository", () => {
  const { GITHUB_REPOSITORY_ALLOWLIST: allowlist } = deployedVars();
  assert.ok(
    Array.isArray(allowlist) && allowlist.length > 0,
    "GITHUB_REPOSITORY_ALLOWLIST must be a non-empty array",
  );
  for (const entry of allowlist) {
    assert.match(
      entry,
      /^[^/\s]+\/[^/\s]+$/u,
      `"${entry}" must read owner/repository`,
    );
  }
});

test("the default repository is allowed", () => {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ALLOWLIST: allowlist,
  } = deployedVars();
  assert.ok(
    allowlist.includes(repository),
    "GITHUB_REPOSITORY must appear in the allow-list, or every scale set " +
      "that omits its own repository refuses each start.",
  );
});
