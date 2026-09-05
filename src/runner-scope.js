function isValidRunnerOrganization(organization) {
  return typeof organization === "string" &&
    organization.trim().length > 0 &&
    !organization.includes("/") &&
    !organization.includes("*") &&
    !organization.includes("..");
}

// GITHUB_TOKEN is singular and deployment-wide, so its permission scope sets
// the cleanup scope. AUTOPILOT_SCALE_SETS is optional, and configuredScaleSet
// returns null when multiple scale sets exist. A registry repository records
// the job repository for allowlisting and logs, not runner registration; do
// not add a scope column. The repository allowlist also exists for org tokens.
export function resolveRunnerScope(env, repository) {
  const configured = env.GITHUB_RUNNER_SCOPE;
  if (
    configured === undefined ||
    configured === null ||
    (typeof configured === "string" && configured.trim().length === 0) ||
    configured === "repository"
  ) {
    return { type: "repository", repository };
  }

  let organization;
  if (configured === "organization") {
    organization = typeof env.GITHUB_REPOSITORY === "string"
      ? env.GITHUB_REPOSITORY.split("/", 1)[0]
      : undefined;
  } else if (
    typeof configured === "string" &&
    configured.startsWith("organization:")
  ) {
    organization = configured.slice("organization:".length);
  } else {
    throw new Error(
      "GITHUB_RUNNER_SCOPE must be repository, organization, or organization:<org>",
    );
  }

  if (!isValidRunnerOrganization(organization)) {
    throw new Error(
      "GITHUB_RUNNER_SCOPE organization must be non-empty and contain no \"/\", \"*\", or \"..\"",
    );
  }
  return { type: "organization", organization };
}
