import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(new URL("./cloudflare-workers-loader.js", import.meta.url));

const {
  MAX_REQUEST_REDELIVERIES,
  runnerCorrelationId,
} = await import("../src/scaleset-listener.js");

test("runner correlation identifiers stay inside the reflection contract", () => {
  // This literal is REFLECTED_CORRELATION_ID_MAX_LENGTH in src/worker.js.
  const reflectedCorrelationIdMaxLength = 58;
  const scaleSetId = Number.MAX_SAFE_INTEGER;
  const runnerRequestId = Number.MAX_SAFE_INTEGER;
  const pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
  const initial = runnerCorrelationId(scaleSetId, runnerRequestId, 0);

  assert.equal(initial.length, reflectedCorrelationIdMaxLength);
  assert.match(initial, pattern);
  for (let redelivery = 1; redelivery <= MAX_REQUEST_REDELIVERIES;
    redelivery += 1) {
    const correlationId = runnerCorrelationId(
      scaleSetId,
      runnerRequestId,
      redelivery,
    );
    assert.ok(correlationId.length <= reflectedCorrelationIdMaxLength);
    assert.match(correlationId, pattern);
  }
});

test("runner correlation identifiers reject invalid redeliveries", () => {
  for (const redelivery of [
    -1,
    1.5,
    MAX_REQUEST_REDELIVERIES + 1,
  ]) {
    assert.throws(
      () => runnerCorrelationId(101, 5, redelivery),
      TypeError,
    );
  }
});
