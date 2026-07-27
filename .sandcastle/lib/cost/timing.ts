/**
 * Run-scoped WALL-CLOCK timing ledger (Phase-2 telemetry).
 *
 * The sibling of `ledger.ts`: where the cost ledger accumulates per-role dollars
 * and tokens, this accumulates per-role cumulative wall-clock milliseconds and a
 * dispatch count. ONE instance is created per sandcastle run (next to the cost
 * ledger and status store) and threaded to the role dispatch sites via
 * `timeRole`, which brackets each agent dispatch with a clock read and folds the
 * delta in. At the end of the run the finally block merges `summary()` with the
 * cost summary into the per-role breakdown persisted to status.json.
 *
 * Pure aggregation; no I/O. Like the cost ledger it must NEVER throw into a run —
 * telemetry is best-effort and must not perturb control flow. It reuses the same
 * {@link CostRole} type from `./ledger.js` so the 8 roles are defined in exactly
 * one place.
 */

import type { CostRole } from "./ledger.js";

/** Cumulative wall-clock ms + dispatch count for one role. */
export interface RoleTiming {
  /** Sum of every timed dispatch's wall-clock duration, in whole ms. */
  wallMs: number;
  /** How many dispatches were timed under this role. */
  runs: number;
}

interface RoleTimingAcc {
  wallMs: number;
  runs: number;
}

export class TimingLedger {
  private readonly roles = new Map<CostRole, RoleTimingAcc>();

  /**
   * Fold one dispatch's wall-clock duration under `role`, bumping its run
   * count. Best-effort caller contract: a negative or non-finite `wallMs` is
   * clamped to 0 so a bad clock read can never corrupt the total (and never
   * throws).
   */
  add(role: CostRole, wallMs: number): void {
    const safe = Number.isFinite(wallMs) && wallMs > 0 ? Math.round(wallMs) : 0;
    let acc = this.roles.get(role);
    if (acc === undefined) {
      acc = { wallMs: 0, runs: 0 };
      this.roles.set(role, acc);
    }
    acc.wallMs += safe;
    acc.runs += 1;
  }

  /** Present only for roles that received at least one timed dispatch. */
  summary(): Partial<Record<CostRole, RoleTiming>> {
    const out: Partial<Record<CostRole, RoleTiming>> = {};
    for (const [role, acc] of this.roles) {
      out[role] = { wallMs: acc.wallMs, runs: acc.runs };
    }
    return out;
  }
}

/**
 * Time one role's agent dispatch and fold the wall-clock delta into `ledger`.
 *
 * Wrap the dispatch call itself, e.g.:
 *
 *   const r = await timeRole(ctx.timingLedger, "implementer", () => runX(...));
 *
 * Contract (mirrors the cost ledger's "never change control flow" ethos):
 *  - A pure no-op when `ledger === undefined` — `fn` is awaited and its result
 *    (or throw) passes straight through, untouched.
 *  - Timing is recorded in a `finally`, so a THROWING `fn` still contributes its
 *    elapsed time AND its throw is re-raised unchanged.
 *  - `now` defaults to `() => Date.now()` and is INJECTABLE so tests can drive a
 *    deterministic clock.
 *
 * Telemetry NEVER swallows `fn`'s result or throw and NEVER alters the value.
 */
export async function timeRole<T>(
  ledger: TimingLedger | undefined,
  role: CostRole,
  fn: () => Promise<T>,
  now: () => number = () => Date.now(),
): Promise<T> {
  if (ledger === undefined) return fn();
  const start = now();
  try {
    return await fn();
  } finally {
    ledger.add(role, now() - start);
  }
}
