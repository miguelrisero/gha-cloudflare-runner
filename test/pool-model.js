import {
  POOL_DECAY_MS,
  POOL_FLOOR_INSTANCES,
  POOL_GROWTH_SLOTS_PER_SECOND,
} from "../src/scaleset-listener.js";

// The cold standard-4 ramp consumed its seven ready slots and recorded ten
// refusals during the 28-second run. This lag reproduces that measured cold
// preparation window before steady growth at POOL_GROWTH_SLOTS_PER_SECOND
// becomes ready.
const MEASURED_COLD_GROWTH_LAG_MS =
  (POOL_FLOOR_INSTANCES + 10) * 1_000;

export function simulatePoolRamp({
  starts,
  paceMs,
  releaseAfterMs = null,
}) {
  if (!Number.isSafeInteger(starts) || starts < 0) {
    throw new TypeError("starts must be a non-negative safe integer");
  }
  if (!Number.isFinite(paceMs) || paceMs < 0) {
    throw new TypeError("paceMs must be a non-negative finite number");
  }
  if (
    releaseAfterMs !== null &&
    (!Number.isFinite(releaseAfterMs) || releaseAfterMs < 0)
  ) {
    throw new TypeError(
      "releaseAfterMs must be null or a non-negative finite number",
    );
  }

  let admitted = 0;
  let refused = 0;
  let readySlots = POOL_FLOOR_INSTANCES;
  let grownSlots = 0;
  const returningSlots = [];
  const outcomes = [];

  for (let index = 0; index < starts; index += 1) {
    const nowMs = index * paceMs;
    const returned = returningSlots.filter((returnAtMs) =>
      returnAtMs <= nowMs
    );
    readySlots += returned.length;
    for (const returnAtMs of returned) {
      returningSlots.splice(returningSlots.indexOf(returnAtMs), 1);
    }

    const growthElapsedMs = nowMs - MEASURED_COLD_GROWTH_LAG_MS;
    const availableGrowth = growthElapsedMs < 0
      ? 0
      : Math.floor(
        growthElapsedMs * POOL_GROWTH_SLOTS_PER_SECOND / 1_000,
      ) + 1;
    readySlots += Math.max(0, availableGrowth - grownSlots);
    grownSlots = Math.max(grownSlots, availableGrowth);

    if (readySlots === 0) {
      refused += 1;
      outcomes.push("refused");
      continue;
    }

    readySlots -= 1;
    admitted += 1;
    outcomes.push("admitted");
    if (releaseAfterMs !== null) {
      returningSlots.push(nowMs + releaseAfterMs + POOL_DECAY_MS);
    }
  }

  return { admitted, refused, outcomes, readySlots };
}
