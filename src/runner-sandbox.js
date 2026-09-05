/**
 * Raised when the vendor SDK reports a successful destroy that the platform
 * never confirmed. The cleanup callers translate it into a claim retry.
 */
export class SandboxDestroyNotConfirmed extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SandboxDestroyNotConfirmed";
  }
}

function containerRunning(sandbox) {
  // `ctx.container` is a host object. Reading it must never mask the real
  // destroy result, so an unavailable handle reports null, not a failure.
  try {
    const running = sandbox.ctx?.container?.running;
    return typeof running === "boolean" ? running : null;
  } catch {
    return null;
  }
}

/**
 * Make `destroy()` fail when the platform refused to bind a container
 * instance, instead of reporting success.
 *
 * `@cloudflare/sandbox` 0.12.7 wraps its `super.destroy()` call in
 * `doDestroy()` with a catch that swallows the platform's
 * "there is no container instance ..." error and returns normally. That error
 * is an admission failure under capacity pressure, not proof of absence: on
 * 2026-09-03 it answered 27 destroy calls in 24 hours on this Worker, while
 * every one of 514 destroys reported success. A container that survives its
 * destroy keeps running and keeps billing, and the registry row that says
 * `destroyed` stops anyone looking. Only the hourly orphan audit could see it.
 *
 * `isNoInstanceError` is the predicate that catch consults, and that catch is
 * its only call site in the vendor build. Recording its answer during a
 * destroy therefore observes exactly the swallow and nothing else.
 *
 * Both cleanup callers already translate a thrown destroy into a claim retry
 * (bounded by MAX_CLEANUP_ATTEMPTS), so a failure here re-destroys about a
 * minute later and gives the platform another chance to admit the instance.
 *
 * `containerRunning` is reported for observation only. Nothing decides on it:
 * a Durable Object that the platform refused to bind sees no container, so its
 * view cannot witness this leak, and acting on an unproven signal would risk
 * failing every healthy destroy.
 */
export function withConfirmedDestroy(BaseSandbox) {
  return class ConfirmedDestroySandbox extends BaseSandbox {
    #destroyDepth = 0;
    #swallowedNoInstanceError = null;

    isNoInstanceError(error) {
      const matched = super.isNoInstanceError(error);
      if (matched && this.#destroyDepth > 0) {
        this.#swallowedNoInstanceError = error;
      }
      return matched;
    }

    async destroy() {
      const outermost = this.#destroyDepth === 0;
      if (outermost) {
        this.#swallowedNoInstanceError = null;
      }
      this.#destroyDepth += 1;
      try {
        await super.destroy();
      } finally {
        this.#destroyDepth -= 1;
      }
      if (!outermost) {
        return;
      }
      const swallowed = this.#swallowedNoInstanceError;
      this.#swallowedNoInstanceError = null;
      if (swallowed === null) {
        return;
      }
      const detail = swallowed instanceof Error
        ? swallowed.message
        : String(swallowed);
      console.log(JSON.stringify({
        message: "sandbox destroy not confirmed",
        reason: "no-container-instance",
        sandboxName: this.sandboxName ?? null,
        containerRunning: containerRunning(this),
        detail,
      }));
      throw new SandboxDestroyNotConfirmed(
        `The platform did not confirm the destruction of sandbox ${
          this.sandboxName ?? "unknown"
        }: ${detail}`,
        { cause: swallowed },
      );
    }
  };
}
