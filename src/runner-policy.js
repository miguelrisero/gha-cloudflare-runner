export const DEFAULT_RECONCILE_MAX_AGE_SECONDS = 3600;
export const ACTIVE_RUNNER_CLEANUP_DELAY_MS =
  DEFAULT_RECONCILE_MAX_AGE_SECONDS * 1000;

// A `busy` GitHub registration postpones cleanup. This bounds how long that can
// last. It is a new bound, not a moved one: no existing constant changes value.
// The runner is single-job ephemeral — container/run-actions-runner.sh passes
// `--ephemeral`, so one busy span covers exactly one job and cannot accumulate
// across jobs. The reference workload measured 621 s as its longest job across
// 1,162 successful runs, with a 142.1 s mean and a 910 s cross-repository
// maximum, against a `timeout-minutes: 25` hard stop of 1,500 s. This bound is
// 3,600 s: 2.4 times that stop and 5.8 times the measured maximum. It is measured from
// the FIRST busy observation, which itself cannot happen before a full
// ACTIVE_RUNNER_CLEANUP_DELAY_MS of runner age, and it is only ever compared at
// a later observation, so a forced exit needs two busy reads at least one hour
// apart. docs/AUTOPILOT-DESIGN.md "Forced-busy exit" specifies this value.
export const MAX_BUSY_POSTPONE_MS = DEFAULT_RECONCILE_MAX_AGE_SECONDS * 1000;

// 106,733 runs in 30 days is about 3,558 runs daily. Three retained days hold
// about 10,674 rows, and the extra retention hour raises that to about 10,822.
// Pages of 100 walk that volume in 109 requests, inside the 1,000-page audit.
export const RUNNER_LIST_PAGE_SIZE = 100;
// GitHub permits at most 100 records through per_page on the runner-list
// endpoint. This API page size is not the runner registry page size.
export const GITHUB_RUNNER_LIST_PAGE_SIZE = 100;
// Forty pages of 100 cover 4,000 registrations. This exceeds the observed
// registry of 1,670 registrations and matches the proven cleanup CLI limit.
export const REGISTRATION_CLEANUP_CENSUS_PAGE_LIMIT = 40;
// One call spends at most 40 census requests and 50 delete requests. These 90
// requests stay below WORKER_SUBREQUEST_LIMIT and use no reconcile budget.
// Fifty deletes add 49 seconds of spacing and keep the response below the
// approximate 100-second client ceiling.
export const REGISTRATION_CLEANUP_MAX_DELETES_PER_CALL = 50;
// GitHub requires at least one second between mutating requests to avoid its
// secondary rate limit. The proven cleanup CLI uses the same interval.
export const REGISTRATION_CLEANUP_MIN_DELETE_INTERVAL_MS = 1000;
// A Cloudflare Worker invocation permits six connections while it awaits
// response headers. docs/AUTOPILOT-DESIGN.md records this platform fact.
export const WORKER_SIMULTANEOUS_CONNECTION_LIMIT = 6;
// One cleanup chain awaits at most one outbound response at a time, so the
// six-connection platform bound caps how many chains one alarm pass can run.
// Reserve one connection so the pass's own registry and pruning work cannot
// push it past that platform bound.
const CLEANUP_CONNECTION_RESERVE = 1;
// A cleanup pass claims at most this many due rows and runs them together.
// A pass that claims one row is the defect this constant exists to prevent: it
// makes a 300-completion drain 300 sequential teardowns through one Durable
// Object, and each runner's reservation is held until its own turn ends.
// This is both the concurrency and the per-pass claim ceiling, so a pass can
// never exceed the connection bound and never runs unbounded work.
export const MAX_CLEANUP_CONCURRENCY =
  WORKER_SIMULTANEOUS_CONNECTION_LIMIT - CLEANUP_CONNECTION_RESERVE;
// This constant records the Cloudflare Workers Paid platform ceiling.
// RECONCILE_SUBREQUEST_BUDGET must stay below it, and the reconcile budget test
// asserts that relationship. docs/PRE-GOLIVE-AUDIT.md records the source.
export const WORKER_SUBREQUEST_LIMIT = 10_000;
// This budget stays below WORKER_SUBREQUEST_LIMIT. Its GitHub request model
// permits 432 requests: 100 candidates at three requests each, 100 initial
// listing pages, and 32 pagination pages. One invocation is less than one tenth
// of the reviewed 5,000-request hourly GitHub primary limit, so one recovery
// cannot exhaust it. An operator decides whether to run back-to-back recovery
// invocations.
export const RECONCILE_SUBREQUEST_BUDGET = 900;
// A successful non-orphan candidate spends these seven subrequests:
// 1 Durable Object request for registry.claimForReconcile.
// 1 name-filtered GitHub page for the registration gate.
// 1 sandbox destroy RPC for beginSandboxDestroy.
// 1 name-filtered GitHub page for pre-delete re-verification.
// 1 by-ID GitHub runner DELETE.
// 1 Durable Object request for registry.settleCleanupClaim.
// 1 Durable Object request for control.releaseBySandbox.
// Success spends no retry or busy-postponement request. A failure stops before
// release. Its completed work and one retry or busy postponement cost at most
// seven subrequests.
export const RECONCILE_SUBREQUESTS_PER_CANDIDATE = 7;
// Each candidate can add one repository whose listing costs at least one page.
export const RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING = 1;
// Pre-charge 32 pagination pages once per invocation, beyond one initial page
// for each funded repository. Each repository listing has a 33-page cap, and
// at most six listings run concurrently. Exact listing spend replaces the
// pre-charge before candidate cleanup, so pagination consumes that budget.
export const RECONCILE_LISTING_PAGINATION_RESERVE = 32;
// RunnerRegistry.listActiveBefore spends one Durable Object subrequest.
export const RECONCILE_REGISTRY_READ_SUBREQUESTS = 1;
export const RECONCILE_MAX_CANDIDATES_PER_INVOCATION = Math.floor(
  (
    RECONCILE_SUBREQUEST_BUDGET -
    RECONCILE_REGISTRY_READ_SUBREQUESTS -
    RECONCILE_LISTING_PAGINATION_RESERVE
  ) /
  (
    RECONCILE_SUBREQUESTS_PER_CANDIDATE +
    RECONCILE_SUBREQUESTS_PER_CANDIDATE_LISTING
  ),
); // 108
export const RECONCILE_CANDIDATE_PAGE_SIZE = Math.min(
  RUNNER_LIST_PAGE_SIZE,
  RECONCILE_MAX_CANDIDATES_PER_INVOCATION,
); // 100
