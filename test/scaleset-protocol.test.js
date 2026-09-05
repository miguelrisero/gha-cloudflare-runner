import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InvalidActionsServiceUrl,
  MalformedAcquireResponse,
  MalformedJitConfig,
  MalformedMessageResponse,
  MESSAGE_TYPES,
  RUNNER_ENDPOINT,
  SCALE_SET_API_VERSION,
  SCALE_SET_ENDPOINT,
  SCALE_SET_MAX_CAPACITY_HEADER,
  SCALE_SET_MESSAGE_TYPE,
  SCALE_UP_REQUEST_ID_BASE,
  UnsupportedMessageType,
  actionsServiceRequestUrl,
  deleteMessageUrl,
  messageQueueRequestUrl,
  parseAcquireJobsResponse,
  parseJitRunnerConfig,
  parseRateLimit,
  parseScaleSetMessage,
} from "../src/scaleset-protocol.js";

function statistics(overrides = {}) {
  return {
    totalAvailableJobs: 1,
    totalAcquiredJobs: 2,
    totalAssignedJobs: 3,
    totalRunningJobs: 4,
    totalRegisteredRunners: 5,
    totalBusyRunners: 6,
    totalIdleRunners: 7,
    ...overrides,
  };
}

function jobMessage(messageType, runnerRequestId = 101, overrides = {}) {
  return {
    messageType,
    runnerRequestId,
    ownerName: "example-org",
    repositoryName: "example-repo",
    ...overrides,
  };
}

function messageEnvelope(messages, overrides = {}) {
  return {
    messageId: 37,
    messageType: "RunnerScaleSetJobMessages",
    body: JSON.stringify(messages),
    statistics: statistics(),
    ...overrides,
  };
}

// Live capture: scale set "cloudflare-sandbox" id 1, messageId 100000002,
// 2026-08-24, workflow run 10000000001.
const CAPTURED_UNASSIGNED_JOB_COMPLETIONS = {
  messageId: 100000002,
  messageType: "RunnerScaleSetJobMessages",
  statistics: {
    totalAssignedJobs: 0,
    totalRunningJobs: 0,
    totalRegisteredRunners: 0,
    totalBusyRunners: 0,
    totalIdleRunners: 0,
    totalAvailableJobs: 0,
    totalAcquiredJobs: 0,
  },
  body: JSON.stringify([
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:22:51.585395516Z",
      jobId: "22cbc484-4585-59d1-b322-4cb72689d7b4",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Playwright browsers",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:22:51.585337932Z",
      jobId: "38d60651-317a-5020-a32e-0f201c0ca047",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Redis",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:22:51.58542456Z",
      jobId: "5e3a3eee-14a5-5b15-8a82-17dd2181a530",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · egress and action cache",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:22:51.585372043Z",
      jobId: "fb145416-a680-5738-ae4c-550d147cb675",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · PostgreSQL",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
  ]),
};

// Live capture: scale set "cloudflare-sandbox", messageId 100000004,
// 2026-08-24, workflow run 10000000001.
const CAPTURED_STALE_ASSIGNMENTS = {
  messageId: 100000004,
  messageType: "RunnerScaleSetJobMessages",
  statistics: {
    totalAssignedJobs: 1,
    totalRunningJobs: 0,
    totalRegisteredRunners: 0,
    totalBusyRunners: 0,
    totalIdleRunners: 0,
    totalAvailableJobs: 0,
    totalAcquiredJobs: 0,
  },
  body: JSON.stringify([
    {
      messageType: "JobAssigned",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.38632275Z",
      jobId: "eef49de0-85f5-5da0-bc6b-c549574c317a",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · PostgreSQL",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
    },
    {
      messageType: "JobAssigned",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.38636234Z",
      jobId: "7401b12c-6978-5b3c-b550-ec945c5e23bd",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Redis",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
    },
    {
      messageType: "JobAssigned",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.386385449Z",
      jobId: "b29b5b74-5845-5110-9d07-ac977190c77f",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Playwright browsers",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
    },
    {
      messageType: "JobAssigned",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.386409568Z",
      jobId: "b340e3db-74f0-5d8b-9bc9-4fbcd42793de",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · egress and action cache",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.38636234Z",
      jobId: "7401b12c-6978-5b3c-b550-ec945c5e23bd",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Redis",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.386385449Z",
      jobId: "b29b5b74-5845-5110-9d07-ac977190c77f",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Playwright browsers",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.38632275Z",
      jobId: "eef49de0-85f5-5da0-bc6b-c549574c317a",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · PostgreSQL",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 0,
      runnerName: "",
      result: "canceled",
    },
  ]),
};

// Live capture: scale set `cloudflare-sandbox` id 1, messageId 100000007,
// read 2026-08-25 through a read-only message session that was created and
// deleted (HTTP 204) for the capture. This was the wave that stopped the
// deployed listener. Every entry reports `runnerRequestId: 0`
// while `runnerId` and `runnerName` are populated, and each `runnerName`
// carries the listener's own reserved-band scale-up identifier
// (`SCALE_UP_REQUEST_ID_BASE + n`). GitHub echoes that identifier only in the
// runner name string, never in `runnerRequestId`.
const CAPTURED_SUCCEEDED_JOB_COMPLETIONS = {
  messageId: 100000007,
  messageType: "RunnerScaleSetJobMessages",
  statistics: {
    totalAssignedJobs: 0,
    totalRunningJobs: 0,
    totalRegisteredRunners: 0,
    totalBusyRunners: 0,
    totalIdleRunners: 0,
    totalAvailableJobs: 0,
    totalAcquiredJobs: 0,
  },
  body: JSON.stringify([
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T22:29:53.121094892Z",
      jobId: "3fb0a03e-2845-58b5-b9ea-5972b26a7830",
      runnerAssignTime: "2026-08-25T09:05:11.292631415Z",
      finishTime: "2026-08-25T09:05:25.499040028Z",
      jobDisplayName: "toolchain · PostgreSQL",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 226,
      runnerName: "cloudflare-1-4503599627370518",
      result: "succeeded",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T22:29:53.121069575Z",
      jobId: "a6f789e2-e81a-55fc-9a65-1f7266f99bde",
      runnerAssignTime: "2026-08-25T09:05:10.113670815Z",
      finishTime: "2026-08-25T09:05:29.831910207Z",
      jobDisplayName: "toolchain · Playwright browsers",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 228,
      runnerName: "cloudflare-1-4503599627370519",
      result: "succeeded",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.386409568Z",
      jobId: "b340e3db-74f0-5d8b-9bc9-4fbcd42793de",
      runnerAssignTime: "2026-08-25T09:05:08.772196059Z",
      finishTime: "2026-08-25T09:06:09.846593993Z",
      jobDisplayName: "toolchain · egress and action cache",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 225,
      runnerName: "cloudflare-1-4503599627370520",
      result: "succeeded",
    },
  ]),
};

// Reconstruction of messageId 100000006, the message that stopped the
// deployed listener. It could not be captured: the listener had already
// consumed and deleted it before the capture session existed, and the broker
// no longer replays it.
//
// What is observed, not assumed:
//   * The listener's own record for 100000006 lists exactly four
//     `{reason: "invalid-runner-request-id", messageType: "JobStarted"}`
//     quarantines and one
//     `{reason: "unassigned-job-completion", messageType: "JobCompleted"}`
//     ignore. The `JobCompleted` ignore fires only at `runnerRequestId === 0`.
//   * `runnerRequestId: 0` is the CAPTURED value for this wave. Every entry of
//     the immediately following message 100000007 reads zero, for the same
//     jobs and the same runners.
//   * `gh api repos/example-org/example-repo/actions/runs/
//     10000000001/jobs` reports all four jobs `success` on runners
//     `cloudflare-1-4503599627370517..520` (runner ids 227, 226, 228, 225),
//     with `toolchain · Redis` finishing first at 09:05:18Z. That is why its
//     `JobCompleted` rode in 100000006 beside the four `JobStarted`, while the
//     other three landed in 100000007.
//   * `actions/scaleset@cb0405b2` `types.go:30-34` and `types.go:47-49` show
//     `JobStarted` embedding `JobMessageBase`, whose
//     `RunnerRequestID int64 \`json:"runnerRequestId"\`` carries no
//     `omitempty`. The field is therefore always present and always an
//     integer, so `invalid-runner-request-id` on a well-formed `JobStarted`
//     can only come from the `<= 0` branch.
//
// Every field of the PostgreSQL, Playwright and egress entries is transcribed
// from the captured 100000007 siblings, minus `result` and with `finishTime`
// reset to the Go zero time because the job had not finished. The Redis entry
// keeps only what `gh api` reports; its `jobId`, `scaleSetAssignTime`,
// `runnerAssignTime` and `queueTime` are not recoverable and are left as
// deliberately synthetic zero values so they cannot be mistaken for capture.
// The parser reads none of them.
const RECONSTRUCTED_UNASSIGNED_JOB_STARTS = {
  messageId: 100000006,
  messageType: "RunnerScaleSetJobMessages",
  statistics: {
    totalAssignedJobs: 3,
    totalRunningJobs: 3,
    totalRegisteredRunners: 4,
    totalBusyRunners: 3,
    totalIdleRunners: 0,
    totalAvailableJobs: 0,
    totalAcquiredJobs: 0,
  },
  body: JSON.stringify([
    {
      messageType: "JobStarted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "0001-01-01T00:00:00Z",
      jobId: "00000000-0000-0000-0000-000000000000",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Redis",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 227,
      runnerName: "cloudflare-1-4503599627370517",
    },
    {
      messageType: "JobStarted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T22:29:53.121094892Z",
      jobId: "3fb0a03e-2845-58b5-b9ea-5972b26a7830",
      runnerAssignTime: "2026-08-25T09:05:11.292631415Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · PostgreSQL",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 226,
      runnerName: "cloudflare-1-4503599627370518",
    },
    {
      messageType: "JobStarted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T22:29:53.121069575Z",
      jobId: "a6f789e2-e81a-55fc-9a65-1f7266f99bde",
      runnerAssignTime: "2026-08-25T09:05:10.113670815Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Playwright browsers",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 228,
      runnerName: "cloudflare-1-4503599627370519",
    },
    {
      messageType: "JobStarted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "2026-08-24T21:57:32.386409568Z",
      jobId: "b340e3db-74f0-5d8b-9bc9-4fbcd42793de",
      runnerAssignTime: "2026-08-25T09:05:08.772196059Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · egress and action cache",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 225,
      runnerName: "cloudflare-1-4503599627370520",
    },
    {
      messageType: "JobCompleted",
      repositoryName: "example-repo",
      ownerName: "example-org",
      jobWorkflowRef: "example-org/example-repo/.github/" +
        "workflows/cf-toolchain.yml@refs/heads/main",
      requestLabels: ["cloudflare-sandbox"],
      scaleSetAssignTime: "0001-01-01T00:00:00Z",
      jobId: "00000000-0000-0000-0000-000000000000",
      runnerAssignTime: "0001-01-01T00:00:00Z",
      finishTime: "0001-01-01T00:00:00Z",
      jobDisplayName: "toolchain · Redis",
      workflowRunId: 10000000001,
      eventName: "workflow_dispatch",
      queueTime: "0001-01-01T00:00:00Z",
      runnerRequestId: 0,
      runnerId: 227,
      runnerName: "cloudflare-1-4503599627370517",
      result: "succeeded",
    },
  ]),
};

test("area 1: Actions Service URLs merge queries and preserve an API version", () => {
  const query = new URLSearchParams([
    ["duplicate", "explicit"],
    ["runnerGroupId", "7"],
  ]);
  assert.equal(
    actionsServiceRequestUrl(
      "https://actions.example.test/tenant/",
      "/_apis/runtime/runnerscalesets?name=example-set&duplicate=path",
      query,
    ),
    "https://actions.example.test/tenant/_apis/runtime/runnerscalesets" +
      `?api-version=${SCALE_SET_API_VERSION}` +
      "&duplicate=path&duplicate=explicit&name=example-set&runnerGroupId=7",
  );

  assert.equal(
    actionsServiceRequestUrl(
      "https://actions.example.test/tenant",
      "_apis/runtime/runnerscalesets?api-version=7.1-preview",
      { name: "example-set" },
    ),
    "https://actions.example.test/tenant/_apis/runtime/runnerscalesets" +
      "?api-version=7.1-preview&name=example-set",
  );
  assert.throws(
    () => actionsServiceRequestUrl("http://actions.example.test", "path"),
    InvalidActionsServiceUrl,
  );
});

test("area 2: queue URLs include only positive replay cursors", () => {
  const queueUrl = "https://queue.example.test/messages?tenant=one";
  assert.equal(
    messageQueueRequestUrl(queueUrl, { lastMessageId: 0 }),
    queueUrl,
  );
  assert.equal(
    messageQueueRequestUrl(queueUrl, { lastMessageId: 19 }),
    `${queueUrl}&lastMessageId=19`,
  );
});

test("area 3: delete URLs append the identifier and preserve the query", () => {
  assert.equal(
    deleteMessageUrl(
      "https://queue.example.test/messages?tenant=one&mode=long",
      41,
    ),
    "https://queue.example.test/messages/41?tenant=one&mode=long",
  );
});

test("area 4: scale set messages decode, group, and preserve null statistics", () => {
  const messages = [
    jobMessage("JobAvailable", 101),
    jobMessage("JobAssigned", 102),
    jobMessage("JobStarted", 103, { runnerId: 501 }),
    jobMessage("JobCompleted", 104, { result: "Succeeded" }),
  ];
  const parsed = parseScaleSetMessage(
    messageEnvelope(messages, { statistics: null }),
  );

  assert.equal(parsed.messageId, 37);
  assert.equal(parsed.statistics, null);
  assert.deepEqual(parsed.jobAvailable, [messages[0]]);
  assert.deepEqual(parsed.jobAssigned, [messages[1]]);
  assert.deepEqual(parsed.jobStarted, [messages[2]]);
  assert.deepEqual(parsed.jobCompleted, [messages[3]]);
  assert.deepEqual(parsed.quarantined, []);
  assert.deepEqual(parsed.ignored, []);
});

test("captured unassigned completions are ignored", () => {
  const parsed = parseScaleSetMessage(
    CAPTURED_UNASSIGNED_JOB_COMPLETIONS,
  );

  assert.deepEqual(parsed.quarantined, []);
  assert.deepEqual(parsed.jobCompleted, []);
  assert.deepEqual(parsed.ignored, Array.from({ length: 4 }, () => ({
    reason: "unassigned-job-completion",
    messageType: "JobCompleted",
    runnerId: null,
    runnerName: null,
  })));
  assert.deepEqual(
    parsed.statistics,
    CAPTURED_UNASSIGNED_JOB_COMPLETIONS.statistics,
  );
});

test("captured stale assignments and completions are ignored", () => {
  const parsed = parseScaleSetMessage(CAPTURED_STALE_ASSIGNMENTS);

  assert.deepEqual(parsed.jobAssigned, []);
  assert.deepEqual(parsed.jobCompleted, []);
  assert.deepEqual(parsed.quarantined, []);
  assert.deepEqual(parsed.ignored, [
    ...Array.from({ length: 4 }, () => ({
      reason: "stale-job-assignment",
      messageType: "JobAssigned",
      runnerId: null,
      runnerName: null,
    })),
    ...Array.from({ length: 3 }, () => ({
      reason: "unassigned-job-completion",
      messageType: "JobCompleted",
      runnerId: null,
      runnerName: null,
    })),
  ]);
});

test("an ignored JobCompleted retains its runner identity", () => {
  const entry = jobMessage("JobCompleted", 0, {
    runnerId: 901,
    runnerName: "cloudflare-101-4503599627370497",
  });
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobCompleted, []);
  assert.deepEqual(parsed.quarantined, []);
  assert.deepEqual(parsed.ignored, [{
    reason: "unassigned-job-completion",
    messageType: "JobCompleted",
    runnerId: 901,
    runnerName: "cloudflare-101-4503599627370497",
  }]);
});

test("malformed ignored identities stay null while JobAvailable zero quarantines", () => {
  const longRunnerName = `cloudflare-${"long-runner-name-".repeat(6)}`;
  const oversizedRunnerName = "r".repeat(300);
  const missingName = jobMessage("JobCompleted", 0, { runnerId: 0 });
  const malformedName = jobMessage("JobCompleted", 0, {
    runnerId: Number.MAX_SAFE_INTEGER + 1,
    runnerName: 42,
  });
  const longName = jobMessage("JobCompleted", 0, {
    runnerId: 902,
    runnerName: longRunnerName,
  });
  const oversizedName = jobMessage("JobCompleted", 0, {
    runnerId: 903,
    runnerName: oversizedRunnerName,
  });
  const zeroAvailable = jobMessage("JobAvailable", 0);
  const parsed = parseScaleSetMessage(messageEnvelope([
    missingName,
    malformedName,
    longName,
    oversizedName,
    zeroAvailable,
  ]));

  assert.deepEqual(parsed.jobAvailable, []);
  assert.deepEqual(parsed.ignored, [
    ...Array.from({ length: 2 }, () => ({
      reason: "unassigned-job-completion",
      messageType: "JobCompleted",
      runnerId: null,
      runnerName: null,
    })),
    {
      reason: "unassigned-job-completion",
      messageType: "JobCompleted",
      runnerId: 902,
      runnerName: longRunnerName,
    },
    {
      reason: "unassigned-job-completion",
      messageType: "JobCompleted",
      runnerId: 903,
      runnerName: oversizedRunnerName.slice(0, 256),
    },
  ]);
  assert.deepEqual(parsed.quarantined, [{
    reason: "invalid-runner-request-id",
    messageType: "JobAvailable",
  }]);
});

test("the captured succeeded completions all report request id zero", () => {
  const entries = JSON.parse(CAPTURED_SUCCEEDED_JOB_COMPLETIONS.body);

  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.equal(entry.messageType, "JobCompleted");
    assert.equal(entry.result, "succeeded");
    // The value GitHub actually sends is a plain zero, never the listener's
    // own reserved-band identifier. That identifier comes back only inside
    // the runner name.
    assert.equal(entry.runnerRequestId, 0);
    assert.ok(entry.runnerId > 0);
    const reservedId = Number(entry.runnerName.split("-").at(-1));
    assert.ok(reservedId >= SCALE_UP_REQUEST_ID_BASE);
  }

  const parsed = parseScaleSetMessage(CAPTURED_SUCCEEDED_JOB_COMPLETIONS);
  assert.deepEqual(parsed.quarantined, []);
  assert.deepEqual(parsed.jobCompleted, []);
  assert.deepEqual(parsed.ignored, [
    {
      reason: "unassigned-job-completion",
      messageType: "JobCompleted",
      runnerId: 226,
      runnerName: "cloudflare-1-4503599627370518",
    },
    {
      reason: "unassigned-job-completion",
      messageType: "JobCompleted",
      runnerId: 228,
      runnerName: "cloudflare-1-4503599627370519",
    },
    {
      reason: "unassigned-job-completion",
      messageType: "JobCompleted",
      runnerId: 225,
      runnerName: "cloudflare-1-4503599627370520",
    },
  ]);
});

test("the job starts that stopped the listener are ignored", () => {
  const parsed = parseScaleSetMessage(RECONSTRUCTED_UNASSIGNED_JOB_STARTS);

  assert.deepEqual(parsed.quarantined, []);
  assert.deepEqual(parsed.jobStarted, []);
  assert.deepEqual(parsed.jobCompleted, []);
  assert.deepEqual(parsed.ignored, [
    ...Array.from({ length: 4 }, () => ({
      reason: "unassigned-job-start",
      messageType: "JobStarted",
    })).map((entry, index) => ({
      ...entry,
      runnerId: [227, 226, 228, 225][index],
      runnerName: [
        "cloudflare-1-4503599627370517",
        "cloudflare-1-4503599627370518",
        "cloudflare-1-4503599627370519",
        "cloudflare-1-4503599627370520",
      ][index],
    })),
    {
      reason: "unassigned-job-completion",
      messageType: "JobCompleted",
      runnerId: 227,
      runnerName: "cloudflare-1-4503599627370517",
    },
  ]);
});

test("area 5: each bad batch entry is quarantined beside a good entry", async (t) => {
  const unknownMessageType = "FutureMessage".repeat(8);
  const cases = [
    {
      reason: "unknown-message-type",
      entry: jobMessage(unknownMessageType, 201),
    },
    {
      reason: "invalid-runner-request-id",
      entry: jobMessage("JobAvailable", "202"),
    },
    {
      reason: "runner-request-id-overflow",
      entry: jobMessage("JobAvailable", Number.MAX_SAFE_INTEGER + 1),
    },
    {
      reason: "invalid-repository-identity",
      entry: jobMessage("JobAvailable", 204, { ownerName: null }),
    },
    { reason: "malformed-message", entry: ["not", "an", "object"] },
  ];

  for (const scenario of cases) {
    await t.test(scenario.reason, () => {
      const good = jobMessage("JobAssigned", 999);
      const parsed = parseScaleSetMessage(
        messageEnvelope([scenario.entry, good]),
      );
      assert.deepEqual(parsed.quarantined, [
        {
          reason: scenario.reason,
          messageType: typeof scenario.entry?.messageType === "string"
            ? scenario.entry.messageType.slice(0, 64)
            : null,
        },
      ]);
      assert.deepEqual(parsed.jobAssigned, [good]);
    });
  }
});

test("area 6: runner request identifier zero is quarantined", () => {
  const zero = jobMessage("JobAvailable", 0);
  const good = jobMessage("JobAvailable", 301);
  const parsed = parseScaleSetMessage(messageEnvelope([zero, good]));

  assert.deepEqual(parsed.jobAvailable, [good]);
  assert.deepEqual(parsed.quarantined, [
    {
      reason: "invalid-runner-request-id",
      messageType: "JobAvailable",
    },
  ]);
});

test("negative request ids quarantine every message type", () => {
  const cases = [...MESSAGE_TYPES].map((messageType) => (
    jobMessage(messageType, -1)
  ));

  for (const entry of cases) {
    const parsed = parseScaleSetMessage(messageEnvelope([entry]));
    assert.deepEqual(parsed.quarantined, [{
      reason: "invalid-runner-request-id",
      messageType: entry.messageType,
    }]);
    assert.deepEqual(parsed.ignored, []);
  }
});

test("a missing JobAssigned request id is quarantined", () => {
  const entry = {
    messageType: "JobAssigned",
    ownerName: "example-org",
    repositoryName: "example-repo",
  };
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobAssigned, []);
  assert.deepEqual(parsed.ignored, []);
  assert.deepEqual(parsed.quarantined, [{
    reason: "invalid-runner-request-id",
    messageType: "JobAssigned",
  }]);
});

test("a string JobAssigned request id is quarantined", () => {
  const entry = jobMessage("JobAssigned", "0");
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobAssigned, []);
  assert.deepEqual(parsed.ignored, []);
  assert.deepEqual(parsed.quarantined, [{
    reason: "invalid-runner-request-id",
    messageType: "JobAssigned",
  }]);
});

test("a zero JobStarted request id is ignored, not quarantined", () => {
  const entry = jobMessage("JobStarted", 0);
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobStarted, []);
  assert.deepEqual(parsed.quarantined, []);
  assert.deepEqual(parsed.ignored, [{
    reason: "unassigned-job-start",
    messageType: "JobStarted",
    runnerId: null,
    runnerName: null,
  }]);
});

test("a string JobStarted request id is still quarantined", () => {
  const entry = jobMessage("JobStarted", "0");
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobStarted, []);
  assert.deepEqual(parsed.ignored, []);
  assert.deepEqual(parsed.quarantined, [{
    reason: "invalid-runner-request-id",
    messageType: "JobStarted",
  }]);
});

test("a reserved-band JobStarted request id is still quarantined", () => {
  const entry = jobMessage("JobStarted", SCALE_UP_REQUEST_ID_BASE);
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobStarted, []);
  assert.deepEqual(parsed.ignored, []);
  assert.deepEqual(parsed.quarantined, [{
    reason: "reserved-runner-request-id",
    messageType: "JobStarted",
  }]);
});

test("an unassigned job start with an invalid repository is quarantined", () => {
  const entry = jobMessage("JobStarted", 0, {
    ownerName: null,
    repositoryName: null,
  });
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobStarted, []);
  assert.deepEqual(parsed.ignored, []);
  assert.deepEqual(parsed.quarantined, [{
    reason: "invalid-repository-identity",
    messageType: "JobStarted",
  }]);
});

test("a positive JobStarted request id remains a job start", () => {
  const entry = jobMessage("JobStarted", 303, { runnerId: 501 });
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobStarted, [entry]);
  assert.deepEqual(parsed.ignored, []);
  assert.deepEqual(parsed.quarantined, []);
});

test("a stale assignment with an invalid repository is quarantined", () => {
  const entry = jobMessage("JobAssigned", 0, {
    ownerName: null,
    repositoryName: null,
  });
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobAssigned, []);
  assert.deepEqual(parsed.ignored, []);
  assert.deepEqual(parsed.quarantined, [{
    reason: "invalid-repository-identity",
    messageType: "JobAssigned",
  }]);
});

test("a positive JobAssigned request id remains assigned", () => {
  const entry = jobMessage("JobAssigned", 302);
  const parsed = parseScaleSetMessage(messageEnvelope([entry]));

  assert.deepEqual(parsed.jobAssigned, [entry]);
  assert.deepEqual(parsed.ignored, []);
  assert.deepEqual(parsed.quarantined, []);
});

test("area 6: the safe-integer boundary is quarantined", () => {
  const boundary = jobMessage(
    "JobAvailable",
    Number.MAX_SAFE_INTEGER,
  );
  const parsed = parseScaleSetMessage(messageEnvelope([boundary]));
  assert.deepEqual(parsed.jobAvailable, []);
  assert.deepEqual(parsed.quarantined, [
    {
      reason: "runner-request-id-overflow",
      messageType: "JobAvailable",
    },
  ]);
});

test("the statistics scale-up identifier band is quarantined", () => {
  const reserved = jobMessage(
    "JobAvailable",
    SCALE_UP_REQUEST_ID_BASE,
  );
  const parsed = parseScaleSetMessage(messageEnvelope([reserved]));

  assert.deepEqual(parsed.jobAvailable, []);
  assert.deepEqual(parsed.quarantined, [{
    reason: "reserved-runner-request-id",
    messageType: "JobAvailable",
  }]);
});

test("area 7: an unsupported outer message type is rejected", () => {
  assert.throws(
    () => parseScaleSetMessage(messageEnvelope([], { messageType: "Other" })),
    UnsupportedMessageType,
  );
});

test("area 8: negative and non-integer statistics are rejected", () => {
  assert.throws(
    () => parseScaleSetMessage(
      messageEnvelope([], {
        statistics: statistics({ totalAssignedJobs: -1 }),
      }),
    ),
    MalformedMessageResponse,
  );
  assert.throws(
    () => parseScaleSetMessage(
      messageEnvelope([], {
        statistics: statistics({ totalRunningJobs: 1.5 }),
      }),
    ),
    MalformedMessageResponse,
  );
});

test("area 9: acquire parsing returns GitHub's exact granted subset", () => {
  const requested = [401, 402, 403];
  const granted = parseAcquireJobsResponse({
    count: 2,
    value: [requested[1], 999],
  });
  assert.deepEqual(granted, [402, 999]);
  assert.equal(Object.isFrozen(granted), true);
  assert.throws(
    () => parseAcquireJobsResponse({ count: 1, value: "402" }),
    MalformedAcquireResponse,
  );
  assert.throws(
    () => parseAcquireJobsResponse({ count: 1, value: [0] }),
    MalformedAcquireResponse,
  );
});

test("area 10: rate limit parsing accepts both Retry-After forms", () => {
  const nowMs = Date.parse("Wed, 21 Oct 2015 07:27:00 GMT");
  assert.deepEqual(
    parseRateLimit(
      new Headers({
        "X-RateLimit-Limit": "5000",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1445412500",
        "Retry-After": "12",
      }),
      nowMs,
    ),
    {
      limit: 5000,
      remaining: 0,
      resetAtMs: 1_445_412_500_000,
      retryAfterMs: 12_000,
    },
  );
  assert.equal(
    parseRateLimit(
      new Headers({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }),
      nowMs,
    ).retryAfterMs,
    60_000,
  );
  assert.deepEqual(
    parseRateLimit(
      new Headers({
        "X-RateLimit-Limit": "many",
        "X-RateLimit-Remaining": "-1",
        "X-RateLimit-Reset": "soon",
        "Retry-After": "later",
      }),
      nowMs,
    ),
    {
      limit: null,
      remaining: null,
      resetAtMs: null,
      retryAfterMs: null,
    },
  );
});

test("protocol validation rejects malformed envelopes and JIT responses", () => {
  assert.equal(SCALE_SET_ENDPOINT, "_apis/runtime/runnerscalesets");
  assert.equal(RUNNER_ENDPOINT, "_apis/distributedtask/pools/0/agents");
  assert.equal(SCALE_SET_MAX_CAPACITY_HEADER, "X-ScaleSetMaxCapacity");
  assert.equal(SCALE_SET_API_VERSION, "6.0-preview");
  assert.equal(SCALE_SET_MESSAGE_TYPE, "RunnerScaleSetJobMessages");
  assert.equal(Object.isFrozen(MESSAGE_TYPES), true);
  assert.throws(
    () => parseScaleSetMessage({ messageType: "RunnerScaleSetJobMessages" }),
    MalformedMessageResponse,
  );
  assert.throws(
    () => parseScaleSetMessage(messageEnvelope([], { body: "{}" })),
    MalformedMessageResponse,
  );

  const payload = {
    encodedJITConfig: "encoded-config",
    runner: { id: 71, name: "cloudflare-71", runnerScaleSetId: 9 },
  };
  assert.deepEqual(parseJitRunnerConfig(payload), payload);
  for (const malformed of [
    { ...payload, encodedJITConfig: "" },
    { ...payload, runner: { id: 0, name: "cloudflare-71" } },
    { ...payload, runner: { id: 71, name: "" } },
  ]) {
    assert.throws(() => parseJitRunnerConfig(malformed), MalformedJitConfig);
  }
});
