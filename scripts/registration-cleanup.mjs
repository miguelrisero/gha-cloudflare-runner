import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { runRegistrationCleanup } from "../src/registration-cleanup-engine.js";

export { runRegistrationCleanup } from "../src/registration-cleanup-engine.js";

const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/u;

function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseLimit(value) {
  if (!DECIMAL_INTEGER_PATTERN.test(value)) {
    throw new Error("--limit must be a non-negative decimal integer");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new Error("--limit must be a non-negative safe integer");
  }
  return limit;
}

function parseArguments(argv) {
  const parsed = { apply: false, limit: 250 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (
      argument === "--organization" ||
      argument === "--repository" ||
      argument === "--scope" ||
      argument === "--limit" ||
      argument === "--scale-set-id" ||
      argument === "--report"
    ) {
      const value = argumentValue(argv, index, argument);
      index += 1;
      if (argument === "--organization") {
        parsed.organization = value;
      } else if (argument === "--repository") {
        parsed.repository = value;
      } else if (argument === "--scope") {
        parsed.scopeType = value;
      } else if (argument === "--limit") {
        parsed.limit = parseLimit(value);
      } else if (argument === "--scale-set-id") {
        if (!DECIMAL_INTEGER_PATTERN.test(value)) {
          throw new Error(
            "--scale-set-id must be a non-negative decimal integer",
          );
        }
        parsed.scaleSetId = value;
      } else if (argument === "--report") {
        parsed.reportPath = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function cliScope(parsed) {
  if (parsed.organization !== undefined && parsed.repository !== undefined) {
    throw new Error("Use either --organization or --repository, not both");
  }
  const type = parsed.scopeType ?? (
    parsed.organization !== undefined
      ? "organization"
      : parsed.repository !== undefined
        ? "repository"
        : undefined
  );
  if (type !== "organization" && type !== "repository") {
    throw new Error("--scope must be organization or repository");
  }
  if (type === "organization") {
    if (
      typeof parsed.organization !== "string" ||
      !/^[^/\s]+$/u.test(parsed.organization)
    ) {
      throw new Error("--organization must name one organization");
    }
    return { type, organization: parsed.organization };
  }
  if (
    typeof parsed.repository !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/u.test(parsed.repository)
  ) {
    throw new Error("--repository must have the owner/repository format");
  }
  return { type, repository: parsed.repository };
}

function writeCleanupSummary(report) {
  process.stderr.write(
    `Registration cleanup: ${report.totalRegistrations ?? "unknown"} registrations, ${report.counts?.delete ?? "unknown"} targets, ${report.deleted} deleted, ${report.remaining ?? "unknown"} remaining.\n`,
  );
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const parsed = parseArguments(argv);
  let report;
  try {
    report = await runRegistrationCleanup({
      githubToken: environment.GH_TOKEN || environment.GITHUB_TOKEN,
      scope: cliScope(parsed),
      apply: parsed.apply,
      limit: parsed.limit,
      scaleSetId: parsed.scaleSetId,
    });
  } catch (error) {
    const errorReport = error instanceof Error ? error.report : undefined;
    if (errorReport !== undefined) {
      const reportJson = `${JSON.stringify(errorReport, null, 2)}\n`;
      if (parsed.reportPath !== undefined) {
        await writeFile(parsed.reportPath, reportJson, "utf8");
      }
      if (errorReport.refused === true) {
        process.stdout.write(reportJson);
        writeCleanupSummary(errorReport);
      }
    }
    throw error;
  }
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  if (parsed.reportPath !== undefined) {
    await writeFile(parsed.reportPath, reportJson, "utf8");
  }
  process.stdout.write(reportJson);
  writeCleanupSummary(report);
  return report;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
