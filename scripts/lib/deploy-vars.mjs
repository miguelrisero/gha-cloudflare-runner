import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

function compareBindings(left, right) {
  const nameOrder = left.name.localeCompare(right.name);
  return nameOrder === 0 ? left.type.localeCompare(right.type) : nameOrder;
}

function validateBinding(binding, context) {
  if (
    binding === null ||
    typeof binding !== "object" ||
    typeof binding.name !== "string" ||
    binding.name.trim().length === 0
  ) {
    throw new Error(`${context} must have a non-empty string name.`);
  }
  if (typeof binding.type !== "string" || binding.type.trim().length === 0) {
    throw new Error(`${context} must have a non-empty string type.`);
  }
  if (/\r|\n|\t/u.test(binding.name) || /\r|\n|\t/u.test(binding.type)) {
    throw new Error(`${context} cannot contain tabs or newlines.`);
  }
  return { name: binding.name, type: binding.type };
}

function sortedBindings(bindings, context) {
  if (!Array.isArray(bindings)) {
    throw new Error(`${context} must be an array.`);
  }
  return bindings
    .map((binding, index) =>
      validateBinding(binding, `${context} entry ${index + 1}`),
    )
    .sort(compareBindings);
}

export function readKeepVars(configPath) {
  const config = unstable_readConfig(
    { config: configPath },
    { hideWarnings: true },
  );
  return config.keep_vars === true;
}

export function parseVersionList(text) {
  const versions = JSON.parse(text);
  if (!Array.isArray(versions)) {
    throw new Error("Wrangler versions list output must be a JSON array.");
  }
  return versions;
}

export function latestVersionId(versions) {
  if (versions.length === 0) {
    return null;
  }
  const id = versions.at(-1)?.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("The newest Wrangler version has no non-empty string id.");
  }
  return id;
}

export function parseVersionBindings(text) {
  const version = JSON.parse(text);
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error(
      "Wrangler version output must contain a resources.bindings array.",
    );
  }
  return sortedBindings(bindings, "Wrangler version binding");
}

export function formatBindings(bindings) {
  const lines = sortedBindings(bindings, "Binding").map(
    ({ name, type }) => `${name}\t${type}`,
  );
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export function parseBindings(text) {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const bindings = lines.map((line, index) => {
    const fields = line.split("\t");
    if (fields.length !== 2) {
      throw new Error(
        `Binding snapshot line ${index + 1} must contain one tab.`,
      );
    }
    return { name: fields[0], type: fields[1] };
  });
  return sortedBindings(bindings, "Binding snapshot");
}

export function droppedBindings(before, after) {
  const afterNames = new Set(after.map(({ name }) => name));
  return [...new Set(before.map(({ name }) => name))]
    .filter((name) => !afterNames.has(name))
    .sort((left, right) => left.localeCompare(right));
}

function usage() {
  return [
    "Usage:",
    "  node scripts/lib/deploy-vars.mjs assert-keep-vars <configPath>",
    "  node scripts/lib/deploy-vars.mjs latest-version-id <versionJsonPath>",
    "  node scripts/lib/deploy-vars.mjs bindings <versionJsonPath>",
    "  node scripts/lib/deploy-vars.mjs diff-bindings <beforePath> <afterPath>",
  ].join("\n");
}

function requireArguments(args, expectedCount) {
  if (args.length !== expectedCount) {
    throw new Error(usage());
  }
}

function runCli(args) {
  const [command, ...commandArguments] = args;

  if (command === "assert-keep-vars") {
    requireArguments(commandArguments, 1);
    const [configPath] = commandArguments;
    if (!readKeepVars(configPath)) {
      throw new Error(
        [
          `DEPLOY REFUSED: keep_vars is not true in ${configPath}.`,
          "A deploy without keep_vars deletes every variable that is not declared in the config.",
          "This behavior destroyed 7 variables in production on 2026-08-26.",
          'Set top-level "keep_vars": true before any deploy.',
        ].join("\n"),
      );
    }
    return;
  }

  if (command === "latest-version-id") {
    requireArguments(commandArguments, 1);
    const versions = parseVersionList(readFileSync(commandArguments[0], "utf8"));
    const versionId = latestVersionId(versions);
    if (versionId !== null) {
      process.stdout.write(`${versionId}\n`);
    }
    return;
  }

  if (command === "bindings") {
    requireArguments(commandArguments, 1);
    const bindings = parseVersionBindings(
      readFileSync(commandArguments[0], "utf8"),
    );
    process.stdout.write(formatBindings(bindings));
    return;
  }

  if (command === "diff-bindings") {
    requireArguments(commandArguments, 2);
    const before = parseBindings(readFileSync(commandArguments[0], "utf8"));
    const after = parseBindings(readFileSync(commandArguments[1], "utf8"));
    const dropped = droppedBindings(before, after);
    if (dropped.length === 0) {
      return;
    }
    const beforeTypes = new Map(
      before.map(({ name, type }) => [name, type]),
    );
    throw new Error(
      [
        "DEPLOY VERIFICATION FAILED: The deploy dropped these bindings:",
        ...dropped.map((name) => `${name} (${beforeTypes.get(name)})`),
        "Restore them from this version output:",
        "npx wrangler versions view <BEFORE_VERSION_ID> --json",
      ].join("\n"),
    );
  }

  throw new Error(usage());
}

const isCli =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
