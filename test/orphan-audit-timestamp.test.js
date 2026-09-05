import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCommandRejected,
  runJq,
} from "./orphan-audit-harness.js";

const jqFilter = 'include "rfc3339"; $value | rfc3339_to_epoch';

function parseTimestamp(value) {
  const output = runJq(jqFilter, { value });

  return Number(output.trim());
}

test("truncates each Cloudflare fractional precision to one epoch second", () => {
  const expectedEpoch = 1_787_268_296;
  const timestamps = [
    "2026-08-20T23:24:56Z",
    "2026-08-20T23:24:56.6Z",
    "2026-08-20T23:24:56.656Z",
    "2026-08-20T23:24:56.656999Z",
    "2026-08-20T23:24:56.656999936Z",
  ];

  for (const timestamp of timestamps) {
    assert.equal(parseTimestamp(timestamp), expectedEpoch);
  }
});

test("truncates fractional seconds instead of rounding them", () => {
  assert.equal(
    parseTimestamp("2026-08-20T23:24:56.999999999Z"),
    parseTimestamp("2026-08-20T23:24:56Z"),
  );
});

test("accepts uppercase and lowercase RFC 3339 separators", () => {
  const expectedEpoch = 1_787_268_296;

  assert.equal(parseTimestamp("2026-08-20T23:24:56Z"), expectedEpoch);
  assert.equal(parseTimestamp("2026-08-20T23:24:56z"), expectedEpoch);
  assert.equal(parseTimestamp("2026-08-20t23:24:56Z"), expectedEpoch);
  assert.equal(parseTimestamp("2026-08-20t23:24:56z"), expectedEpoch);
});

test("applies positive and negative timezone offsets in the UTC direction", () => {
  assert.equal(
    parseTimestamp("2026-08-20T23:24:56+01:30"),
    1_787_262_896,
    "a positive offset must be subtracted from local time",
  );
  assert.equal(
    parseTimestamp("2026-08-20T23:24:56-01:30"),
    1_787_273_696,
    "a negative offset must be added to local time",
  );
  assert.equal(
    parseTimestamp("2026-08-20T23:24:56.5+01:00"),
    1_787_264_696,
    "a fraction must remain valid with an offset",
  );
});

test("accepts a leap day in a leap year", () => {
  assert.equal(
    parseTimestamp("2024-02-29T00:00:00Z"),
    Date.parse("2024-02-29T00:00:00Z") / 1000,
  );
});

test("rejects malformed timestamps and names each offending value", () => {
  const invalidValues = [
    "2026-08-20T23:24:56",
    "2026-08-20T23:24:56+",
    "2026-08-20",
    "",
    42,
    "2026-08-20T23:24:56+01:30garbage",
    "2026-08-20T23:24:56.Z",
    "2026-01-01T00:00:00Z\n",
    "2026-02-30T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-02-29T00:00:00Z",
  ];

  for (const value of invalidValues) {
    assertCommandRejected(
      () => parseTimestamp(value),
      /invalid RFC 3339 timestamp:/,
      value,
    );
  }
});
