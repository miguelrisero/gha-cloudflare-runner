import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url));
const workflowSource = await readFile(
  new URL("../.github/workflows/orphan-audit.yml", import.meta.url),
  "utf8",
);

function indentation(line) {
  return /^ */u.exec(line)[0].length;
}

function extractRunBlocks(source) {
  const lines = source.split(/\r?\n/u);
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const runStart = /^( *)run: *\| *$/u.exec(lines[index]);
    if (runStart === null) {
      continue;
    }
    const runIndent = runStart[1].length;
    const contentIndent = runIndent + 2;
    const content = [];
    let nextIndex = index + 1;
    for (; nextIndex < lines.length; nextIndex += 1) {
      const line = lines[nextIndex];
      if (line.trim().length === 0) {
        content.push("");
        continue;
      }
      if (indentation(line) <= runIndent) {
        break;
      }
      if (indentation(line) < contentIndent) {
        throw new Error(`Invalid run block indentation at line ${nextIndex + 1}`);
      }
      content.push(line.slice(contentIndent));
    }
    blocks.push({ line: index + 1, text: content.join("\n") });
    index = nextIndex - 1;
  }

  return blocks;
}

const runBlocks = extractRunBlocks(workflowSource);

function runBlockForStep(stepName) {
  const stepMarker = `- name: ${stepName}`;
  const stepIndex = workflowSource.indexOf(stepMarker);
  assert.notEqual(stepIndex, -1, `workflow step not found: ${stepName}`);
  const stepLine = workflowSource.slice(0, stepIndex).split(/\r?\n/u).length;
  const block = runBlocks.find(({ line }) => line > stepLine);
  assert.notEqual(block, undefined, `run block not found: ${stepName}`);
  return block.text;
}

const auditBlock = runBlockForStep("Run the orphan audit");
const alertBlock = runBlockForStep("Alert on the audit result");
const preflightBlock = runBlockForStep("Preflight the audit configuration");

function extractExitCodeAgreementProgram(block) {
  const invocationMarker =
    `jq -e --argjson auditExitCode "$audit_exit_code" '`;
  const invocationIndex = block.indexOf(invocationMarker);
  assert.notEqual(
    invocationIndex,
    -1,
    "audit exit-code agreement jq invocation not found",
  );
  assert.equal(
    block.indexOf(invocationMarker, invocationIndex + invocationMarker.length),
    -1,
    "audit exit-code agreement jq invocation is not unique",
  );
  const programStart = invocationIndex + invocationMarker.length;
  const programTerminator = `' >/dev/null 2>&1 <<<"$summary_record"; then`;
  const programEnd = block.indexOf(programTerminator, programStart);
  assert.notEqual(
    programEnd,
    -1,
    "audit exit-code agreement jq program terminator not found",
  );
  return block.slice(programStart, programEnd).trim();
}

const exitCodeAgreementProgram = extractExitCodeAgreementProgram(auditBlock);

const probeReason = [
  "AUDIT_GITHUB_TOKEN cannot read runner scope organization:example-org at endpoint orgs/example-org/actions/runners.",
  "A token holding only repository `Administration: Read-only` gets HTTP 403 on an organization endpoint.",
].join("\n");
const probeAction = "Grant Organization `Self-hosted runners: Read-only` to "
  + "AUDIT_GITHUB_TOKEN. Read docs/ORPHAN-RUNBOOK.md.";

function curlStubSource() {
  return `#!/usr/bin/env bash
set -euo pipefail
payload=''
while (($# > 0)); do
  if [[ "$1" == '--data' ]]; then
    payload=$2
    shift 2
    continue
  fi
  shift
done
printf '%s' "$payload" > "$SLACK_PAYLOAD_FILE"
`;
}

function operationalAlertOptions() {
  return {
    auditOutcome: "skipped",
    preflightOutcome: "failure",
    jobStatus: "failure",
    preflightFailureReason: probeReason,
    preflightFailureAction: probeAction,
  };
}

function findingSummary(overrides = {}) {
  return {
    type: "summary",
    orphanCount: 4,
    ambiguousInstanceCount: 5,
    destroyAlreadyScheduledCount: 1,
    destroyFailureCount: 2,
    destroyOperatorRequiredCount: 3,
    repository: "example-org/gha-cloudflare-runner",
    ...overrides,
  };
}

function executeAlert({
  auditExitCode = "2",
  preflightOutcome = "success",
  auditOutcome = "success",
  jobStatus = "failure",
  preflightFailureReason = "",
  preflightFailureAction = "",
  auditFailureReason = "",
  auditFailureAction = "",
  slackWebhookUrl = "https://hooks.slack.test/services/test",
  summaryRecord,
} = {}) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "orphan-audit-workflow-test-"),
  );
  const curlPath = join(temporaryDirectory, "curl");
  const payloadFile = join(temporaryDirectory, "slack-payload.json");
  const stepSummaryFile = join(temporaryDirectory, "step-summary.md");
  const outputFile = join(temporaryDirectory, "github-output.txt");
  writeFileSync(curlPath, curlStubSource());
  chmodSync(curlPath, 0o755);
  writeFileSync(stepSummaryFile, "");
  writeFileSync(outputFile, "");
  if (summaryRecord !== undefined) {
    writeFileSync(
      join(temporaryDirectory, "orphan-audit.jsonl"),
      `${JSON.stringify(summaryRecord)}\n`,
    );
  }

  const result = spawnSync("bash", ["-c", alertBlock], {
    cwd: temporaryDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${temporaryDirectory}:${process.env.PATH}`,
      AUDIT_EXIT_CODE: auditExitCode,
      PREFLIGHT_OUTCOME: preflightOutcome,
      AUDIT_OUTCOME: auditOutcome,
      JOB_STATUS: jobStatus,
      PREFLIGHT_FAILURE_REASON: preflightFailureReason,
      PREFLIGHT_FAILURE_ACTION: preflightFailureAction,
      AUDIT_FAILURE_REASON: auditFailureReason,
      AUDIT_FAILURE_ACTION: auditFailureAction,
      SLACK_WEBHOOK_URL: slackWebhookUrl,
      RUN_URL: "https://github.com/example-org/gha-cloudflare-runner/actions/runs/123",
      RUNBOOK_URL: "https://github.com/example-org/gha-cloudflare-runner/blob/abc/docs/ORPHAN-RUNBOOK.md",
      GITHUB_REPOSITORY: "example-org/gha-cloudflare-runner",
      GITHUB_STEP_SUMMARY: stepSummaryFile,
      GITHUB_OUTPUT: outputFile,
      SLACK_PAYLOAD_FILE: payloadFile,
    },
  });
  const payloadSource = existsSync(payloadFile)
    ? readFileSync(payloadFile, "utf8")
    : null;
  return {
    result,
    payloadFile,
    payloadSource,
    stepSummary: readFileSync(stepSummaryFile, "utf8"),
    temporaryDirectory,
  };
}

function withAlert(options, inspect) {
  const execution = executeAlert(options);
  try {
    const payload = execution.payloadSource === null
      ? null
      : JSON.parse(execution.payloadSource);
    inspect({ ...execution, payload });
  } finally {
    rmSync(execution.temporaryDirectory, { recursive: true, force: true });
  }
}

function assertJq(payloadFile, filter, variables = {}) {
  const argumentsList = ["-e"];
  for (const [name, value] of Object.entries(variables)) {
    argumentsList.push("--arg", name, value);
  }
  argumentsList.push(filter, payloadFile);
  execFileSync("jq", argumentsList, { encoding: "utf8" });
}

test("the audit exit code agrees with all finding types", () => {
  const cases = [
    {
      name: "an ambiguous-only exit 0",
      summary: {
        orphanCount: 0,
        ambiguousInstanceCount: 1,
        findingCount: 1,
      },
      auditExitCode: 0,
      expectedStatus: 1,
    },
    {
      name: "an ambiguous-only exit 1",
      summary: {
        orphanCount: 0,
        ambiguousInstanceCount: 1,
        findingCount: 1,
      },
      auditExitCode: 1,
      expectedStatus: 0,
    },
    {
      name: "a clean exit 0",
      summary: {
        orphanCount: 0,
        ambiguousInstanceCount: 0,
        findingCount: 0,
      },
      auditExitCode: 0,
      expectedStatus: 0,
    },
    {
      name: "a mixed-finding exit 3",
      summary: {
        orphanCount: 2,
        ambiguousInstanceCount: 1,
        findingCount: 3,
      },
      auditExitCode: 3,
      expectedStatus: 0,
    },
    {
      name: "an inconsistent finding count",
      summary: {
        orphanCount: 2,
        ambiguousInstanceCount: 1,
        findingCount: 2,
      },
      auditExitCode: 1,
      expectedStatus: 1,
    },
    {
      name: "an orphan exit 0",
      summary: {
        orphanCount: 1,
        ambiguousInstanceCount: 0,
        findingCount: 1,
      },
      auditExitCode: 0,
      expectedStatus: 1,
    },
  ];

  for (const testCase of cases) {
    const result = spawnSync(
      "jq",
      [
        "-e",
        "--argjson",
        "auditExitCode",
        String(testCase.auditExitCode),
        exitCodeAgreementProgram,
      ],
      {
        encoding: "utf8",
        input: JSON.stringify(testCase.summary),
      },
    );
    assert.equal(
      result.status,
      testCase.expectedStatus,
      `${testCase.name}: ${result.error?.message ?? result.stderr}`,
    );
  }
});

test("the operational alert states the cause", () => {
  withAlert(operationalAlertOptions(), ({ result, payload, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    const sectionTexts = payload.attachments[0].blocks
      .filter((block) => block.type === "section" && block.text !== undefined)
      .map((block) => block.text.text);
    assert.equal(sectionTexts.some((text) => text.includes(probeReason)), true);
    assert.equal(sectionTexts.some((text) => text.includes(probeAction)), true);
    assertJq(
      payloadFile,
      `
        ([
          .attachments[0].blocks[]
          | select(.type == "section" and .text.type == "mrkdwn")
          | .text.text
        ] | join("\\n")) as $sections
        | ($sections | contains($reason))
          and ($sections | contains($action))
      `,
      { reason: probeReason, action: probeAction },
    );
  });
});

test("the operational alert reports no counter that was never measured", () => {
  withAlert({
    auditFailureReason: "The orphan audit script exited with operational code 2.",
    auditFailureAction: "Read the job log and the archived audit artifact.",
  }, ({ result, payloadSource }) => {
    assert.equal(result.status, 0, result.stderr);
    for (const counterName of [
      "orphanCount",
      "ambiguousInstanceCount",
      "destroyAlreadyScheduledCount",
      "destroyFailureCount",
      "destroyOperatorRequiredCount",
    ]) {
      assert.equal(payloadSource.includes(counterName), false);
    }
    assert.equal(payloadSource.includes("repository"), false);
    assert.equal(payloadSource.includes("unavailable"), false);
  });
});

test("the finding alert names the audited repository", () => {
  const repository = "example-org/gha-cloudflare-runner";
  withAlert({
    auditExitCode: "3",
    summaryRecord: findingSummary({ repository }),
  }, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `
        [
          .attachments[0].blocks[]
          | select(.type == "context")
          | .elements[]
          | .text
        ]
        | any(contains($repository))
      `,
      { repository },
    );
  });
});

test("the destroy-failure alert is red and named", () => {
  withAlert({
    auditExitCode: "3",
    summaryRecord: findingSummary(),
  }, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `
        .attachments[0].color == "#d13212"
        and .attachments[0].blocks[0].text.text
          == "Orphan audit: destroy failed"
      `,
    );
  });
});

test("the operational alert has no counter fields", () => {
  withAlert(operationalAlertOptions(), ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `[.attachments[0].blocks[] | select(has("fields"))] | length == 0`,
    );
  });
});

test("an unmeasured counter stays unavailable and never becomes zero", () => {
  const summaryRecord = {
    type: "summary",
    orphanCount: 2,
    destroyAlreadyScheduledCount: 1,
    destroyFailureCount: null,
    repository: "example-org/gha-cloudflare-runner",
  };
  withAlert({
    auditExitCode: "3",
    summaryRecord,
  }, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `
        def field($name): [
          .attachments[0].blocks[]
          | select(.type == "section")
          | .fields[]?
          | select(.text | startswith("*\\($name)*\\n"))
          | .text
        ];
        (field("destroyFailureCount") | length == 1)
        and (field("destroyFailureCount")[0] | endswith("\\nunavailable"))
        and (field("destroyFailureCount")[0] | endswith("\\n0") | not)
        and (field("destroyOperatorRequiredCount") | length == 1)
        and (field("destroyOperatorRequiredCount")[0] | endswith("\\nunavailable"))
        and (field("destroyOperatorRequiredCount")[0] | endswith("\\n0") | not)
        and (field("ambiguousInstanceCount") | length == 1)
        and (field("ambiguousInstanceCount")[0] | endswith("\\nunavailable"))
        and (field("ambiguousInstanceCount")[0] | endswith("\\n0") | not)
      `,
    );
  });
});

test("the finding alert keeps the measured counters", () => {
  withAlert({
    auditExitCode: "3",
    summaryRecord: findingSummary({ orphanCount: 7 }),
  }, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `
        [
          .attachments[0].blocks[]
          | select(.type == "section")
          | .fields[]?
          | select(.text | startswith("*orphanCount*\\n"))
          | .text
        ] as $fields
        | ($fields | length == 1)
          and ($fields[0] | endswith("\\n7"))
      `,
    );
  });
});

test("the finding alert carries the ambiguous instance count", () => {
  withAlert({
    auditExitCode: "3",
    summaryRecord: findingSummary({ ambiguousInstanceCount: 9 }),
  }, ({ result, payloadFile }) => {
    assert.equal(result.status, 0, result.stderr);
    assertJq(
      payloadFile,
      `
        [
          .attachments[0].blocks[]
          | select(.type == "section")
          | .fields[]?
          | select(.text | startswith("*ambiguousInstanceCount*\\n"))
          | .text
        ] as $fields
        | ($fields | length == 1)
          and ($fields[0] | endswith("\\n9"))
      `,
    );
  });
});

test("the payload is Block Kit with a fallback text", () => {
  const alertCases = [
    operationalAlertOptions(),
    { auditExitCode: "3", summaryRecord: findingSummary() },
  ];
  for (const alertOptions of alertCases) {
    withAlert(alertOptions, ({ result, payloadFile }) => {
      assert.equal(result.status, 0, result.stderr);
      assertJq(
        payloadFile,
        `
          (.text | type == "string" and length > 0)
          and (.attachments[0].color | test("^#[0-9a-f]{6}$"))
          and (.attachments[0].blocks[0].type == "header")
          and (.attachments[0].blocks[0].text.type == "plain_text")
          and ([.attachments[0].blocks[].type] | index("context") != null)
          and (
            [
              ..
              | objects
              | select(
                  (.type == "mrkdwn" or .type == "plain_text")
                  and has("text")
                )
              | .text
            ]
            | length > 0
              and all(type == "string" and length > 0)
          )
        `,
      );
    });
  }
});

test("the alert stays degraded without a webhook", () => {
  withAlert({
    ...operationalAlertOptions(),
    slackWebhookUrl: "",
  }, ({ result, payloadSource, stepSummary }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(payloadSource, null);
    assert.match(
      result.stdout,
      /::warning title=Orphan audit alert degraded/u,
    );
    assert.match(stepSummary, /Slack delivery is not configured/u);
  });
});

test("findings without a destroy failure send nothing", () => {
  // The scheduled operator destroy workflow removes the provable orphan
  // classes and ambiguous records are a listing artifact, so a plain exit 1
  // is not an alert. The job status and the archived record still carry it.
  withAlert({
    auditExitCode: "1",
    auditOutcome: "success",
    jobStatus: "failure",
    summaryRecord: findingSummary({ orphanCount: 6, ambiguousInstanceCount: 17 }),
  }, ({ result, payloadSource }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(payloadSource, null);
  });
});

test("a clean audit with a green job sends nothing", () => {
  withAlert({
    auditExitCode: "0",
    auditOutcome: "success",
    jobStatus: "success",
  }, ({ result, payloadSource }) => {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(payloadSource, null);
  });
});

test("the preflight records the GitHub probe cause it prints", () => {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "orphan-audit-preflight-test-"),
  );
  const ghPath = join(temporaryDirectory, "gh");
  const outputFile = join(temporaryDirectory, "github-output.txt");
  writeFileSync(ghPath, "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(ghPath, 0o755);
  writeFileSync(outputFile, "");

  try {
    const result = spawnSync("bash", ["-c", preflightBlock], {
      cwd: repositoryDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${temporaryDirectory}:${process.env.PATH}`,
        WORKER_URL: "https://gha-cloudflare-runner.example.com",
        CLOUDFLARE_API_TOKEN: "cloudflare-token-value-must-stay-secret",
        CONTROL_TOKEN: "control-token-value-must-stay-secret",
        AUDIT_GITHUB_TOKEN: "github-token-value-must-stay-secret",
        GH_TOKEN: "github-token-value-must-stay-secret",
        GITHUB_RUNNER_SCOPE: "organization:example-org",
        GITHUB_OUTPUT: outputFile,
      },
    });
    const recordedOutput = readFileSync(outputFile, "utf8");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AUDIT_GITHUB_TOKEN cannot read runner scope/u);
    assert.match(result.stdout, /::error title=Orphan audit GitHub probe/u);
    assert.match(recordedOutput, /failure_reason<<ORPHAN_AUDIT_EOF/u);
    assert.match(
      recordedOutput,
      /AUDIT_GITHUB_TOKEN cannot read runner scope organization:example-org/u,
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the alert never embeds a secret expression", () => {
  assert.equal(alertBlock.includes("${{ secrets."), false);
  assert.equal(alertBlock.includes("${{ inputs."), false);
});
