import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("./cloudflare-workers-loader.js", import.meta.url));

const { MAX_ACTIVE_RUNNERS } = await import("../src/autopilot-control.js");

const INSTANCE_SHAPES = Object.freeze({
  lite: Object.freeze({
    vCpuSixteenths: 1,
    memoryMiB: 256,
    diskGB: 2,
  }),
  basic: Object.freeze({
    vCpuSixteenths: 4,
    memoryMiB: 1_024,
    diskGB: 4,
  }),
  "standard-1": Object.freeze({
    vCpuSixteenths: 8,
    memoryMiB: 4_096,
    diskGB: 8,
  }),
  "standard-2": Object.freeze({
    vCpuSixteenths: 16,
    memoryMiB: 6_144,
    diskGB: 12,
  }),
  "standard-3": Object.freeze({
    vCpuSixteenths: 32,
    memoryMiB: 8_192,
    diskGB: 16,
  }),
  "standard-4": Object.freeze({
    vCpuSixteenths: 64,
    memoryMiB: 12_288,
    diskGB: 20,
  }),
});

const ACCOUNT_LIMITS = Object.freeze({
  vCpuSixteenths: 1_500 * 16,
  memoryMiB: 6_144 * 1_024,
  diskGB: 30_000,
});

function stripJsonComments(input) {
  let output = "";
  let index = 0;
  let inString = false;
  let escaped = false;

  while (index < input.length) {
    const character = input[index];
    const nextCharacter = input[index + 1];

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (character === "\"") {
      inString = true;
      output += character;
      index += 1;
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      output += "  ";
      index += 2;
      while (index < input.length && !["\n", "\r"].includes(input[index])) {
        output += " ";
        index += 1;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      output += "  ";
      index += 2;
      let closed = false;
      while (index < input.length) {
        if (input[index] === "*" && input[index + 1] === "/") {
          output += "  ";
          index += 2;
          closed = true;
          break;
        }
        output += ["\n", "\r"].includes(input[index]) ? input[index] : " ";
        index += 1;
      }
      if (!closed) {
        throw new SyntaxError("Unterminated JSONC block comment");
      }
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

async function readFleetConfiguration() {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  return JSON.parse(stripJsonComments(source));
}

function sandboxConfiguration(config) {
  const sandboxes = config.containers.filter(
    (container) => container.class_name === "Sandbox",
  );
  assert.equal(sandboxes.length, 1, "exactly one Sandbox container must exist");
  return sandboxes[0];
}

test("the JSONC comment stripper preserves comment markers in strings", () => {
  const input = String.raw`{
    // A line comment.
    "url": "https://example.com/a/*literal*/",
    "escaped": "quote: \" // literal",
    /* A block
       comment. */
    "value": 1
  }`;

  assert.deepEqual(JSON.parse(stripJsonComments(input)), {
    url: "https://example.com/a/*literal*/",
    escaped: 'quote: " // literal',
    value: 1,
  });
  assert.throws(
    () => stripJsonComments("{/* unterminated"),
    /Unterminated JSONC block comment/,
  );
});

test("the Sandbox fleet uses a documented shape within every account ceiling", async () => {
  const config = await readFleetConfiguration();
  const sandbox = sandboxConfiguration(config);
  assert.equal(
    Object.hasOwn(INSTANCE_SHAPES, sandbox.instance_type),
    true,
    `unknown Sandbox instance_type: ${sandbox.instance_type}`,
  );
  assert.equal(Number.isSafeInteger(sandbox.max_instances), true);
  assert.ok(sandbox.max_instances > 0, "max_instances must be positive");
  assert.equal(sandbox.max_instances, MAX_ACTIVE_RUNNERS);

  const shape = INSTANCE_SHAPES[sandbox.instance_type];
  assert.ok(
    sandbox.max_instances * shape.vCpuSixteenths <=
      ACCOUNT_LIMITS.vCpuSixteenths,
    "the fleet exceeds the 1,500-vCPU account ceiling",
  );
  assert.ok(
    sandbox.max_instances * shape.memoryMiB <= ACCOUNT_LIMITS.memoryMiB,
    "the fleet exceeds the 6-TiB memory account ceiling",
  );
  assert.ok(
    sandbox.max_instances * shape.diskGB <= ACCOUNT_LIMITS.diskGB,
    "the fleet exceeds the 30-TB disk account ceiling",
  );
});

test("vCPU is the binding constraint", async () => {
  const config = await readFleetConfiguration();
  const sandbox = sandboxConfiguration(config);
  const shape = INSTANCE_SHAPES[sandbox.instance_type];
  const usedVCpu = sandbox.max_instances * shape.vCpuSixteenths;
  const usedMemory = sandbox.max_instances * shape.memoryMiB;
  const usedDisk = sandbox.max_instances * shape.diskGB;

  assert.ok(
    usedVCpu * ACCOUNT_LIMITS.memoryMiB >
      usedMemory * ACCOUNT_LIMITS.vCpuSixteenths,
    "the fleet must consume a larger vCPU fraction than memory fraction",
  );
  assert.ok(
    usedVCpu * ACCOUNT_LIMITS.diskGB >
      usedDisk * ACCOUNT_LIMITS.vCpuSixteenths,
    "the fleet must consume a larger vCPU fraction than disk fraction",
  );
});
