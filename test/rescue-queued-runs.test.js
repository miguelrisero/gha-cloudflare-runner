import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelCommand,
  commandCount,
  dispatchCommand,
  ledgerRows,
  replacementLedgerRow,
  rescueRunName,
  runRescue,
  sourceJobLedgerRow,
  sourceRun,
} from "./rescue-queued-runs-harness.js";

test("does not dispatch a rescue workflow that fails validation", () => {
  const result = runRescue({ runsOn: "cloudflare-sandbox" });

  assert.match(
    result.stderr,
    /Refusing to dispatch an unsafe rescue workflow/,
  );
  assert.equal(commandCount(result.commandLog, dispatchCommand), 0);
  assert.notEqual(result.status, 0);
});

test("does not report a dry-run dispatch when validation fails", () => {
  const result = runRescue({
    runsOn: "cloudflare-sandbox",
    dryRun: true,
  });

  assert.doesNotMatch(result.stdout, /would_dispatch/);
  assert.notEqual(result.status, 0);
});

test("cancels and dispatches one run after rescue validation succeeds", () => {
  const result = runRescue({ runsOn: "ubuntu-latest" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(commandCount(result.commandLog, cancelCommand), 1);
  assert.equal(commandCount(result.commandLog, dispatchCommand), 1);
  const rows = ledgerRows(result.ledger);
  assert.equal(rows.filter((row) => row.record_type === "source_job").length, 1);
  assert.equal(rows.filter((row) => row.record_type === "replacement").length, 1);
});

test("recovers completed source runs from the ledger backlog", () => {
  const sourceRuns = [
    sourceRun({ status: "completed" }),
    sourceRun({
      runId: 301,
      workflow: 201,
      status: "completed",
      jobId: 401,
      replacementId: 501,
    }),
  ];
  const result = runRescue({
    runsOn: "ubuntu-latest",
    sourceRuns,
    initialLedgerRows: sourceRuns.map(sourceJobLedgerRow),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(commandCount(result.commandLog, dispatchCommand), 2);
  const rows = ledgerRows(result.ledger);
  assert.equal(rows.filter((row) => row.record_type === "replacement").length, 2);
});

test("exits non-zero while a ledger backlog remains undispatched", () => {
  const sourceRuns = [
    sourceRun({ status: "completed" }),
    sourceRun({
      runId: 301,
      workflow: 201,
      status: "completed",
      jobId: 401,
      replacementId: 501,
    }),
  ];
  const result = runRescue({
    runsOn: "ubuntu-latest",
    sourceRuns,
    initialLedgerRows: sourceRuns.map(sourceJobLedgerRow),
    failedDispatchRunIds: [sourceRuns[0].runId],
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /SUMMARY \| status=failed/);
  assert.doesNotMatch(result.stdout, /SUMMARY \| status=success/);
});

test("continues dispatching after one source run dispatch fails", () => {
  const sourceRuns = [
    sourceRun(),
    sourceRun({
      runId: 301,
      workflow: 201,
      jobId: 401,
      replacementId: 501,
    }),
    sourceRun({
      runId: 302,
      workflow: 202,
      jobId: 402,
      replacementId: 502,
    }),
  ];
  const result = runRescue({
    runsOn: "ubuntu-latest",
    sourceRuns,
    failedDispatchRunIds: [sourceRuns[1].runId],
  });

  assert.notEqual(result.status, 0);
  assert.equal(commandCount(result.commandLog, dispatchCommand), 3);
  assert.match(result.commandLog, /INPUT .*"source_run_id":"302"/);
  const rows = ledgerRows(result.ledger);
  assert.equal(rows.filter((row) => row.record_type === "replacement").length, 2);
});

test("rejects a rescue run-name mismatch before cancelling a source run", () => {
  const result = runRescue({
    runsOn: "ubuntu-latest",
    runName: "Rescue with a different identity",
  });

  assert.notEqual(result.status, 0);
  assert.equal(commandCount(result.commandLog, cancelCommand), 0);
  assert.ok(
    result.stderr.includes(
      `The rescue workflow run-name must equal: ${rescueRunName}`,
    ),
  );
});

test("does not redispatch a source run with a replacement ledger row", () => {
  const completedRun = sourceRun({ status: "completed" });
  const result = runRescue({
    runsOn: "cloudflare-sandbox",
    sourceRuns: [completedRun],
    initialLedgerRows: [
      sourceJobLedgerRow(completedRun),
      replacementLedgerRow(completedRun),
    ],
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(commandCount(result.commandLog, dispatchCommand), 0);
  assert.match(result.stdout, /SUMMARY \| status=success/);
});
