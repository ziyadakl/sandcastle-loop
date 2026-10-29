/**
 * The two dispatch-site wrappers that make cost and wall-time attributable to
 * ONE issue, without disturbing the run-scoped ledgers that already ship.
 *
 * ## Why wrappers instead of editing `timeRole` / `captureRoleCost`
 *
 * `lib/cost/timing.ts` and `lib/cost/capture.ts` feed `totals.perRole` and
 * `totals.perModel`, output that is pinned by a characterization test and read
 * by the mission-control viewer. Leaving those two modules BYTE-IDENTICAL is
 * what guarantees that adding per-issue telemetry cannot perturb a number
 * anyone already depends on. These wrappers call straight through to them and
 * *additionally* fold the same measurement into the per-issue
 * {@link IssueLedger}. One dispatch, one session read, two ledgers.
 *
 * Only the four ATTRIBUTABLE roles (`issue-ledger.ts:54`) should reach these.
 * The four batch roles — `planner`, `merger`, `postMergeReviewer`,
 * `postMergeFixer` — serve a whole iteration and keep calling the unwrapped
 * `timeRole` / `captureRoleCost` directly; their spend lands in
 * `runTelemetry.overheadCostUsd`. The `IssueLedger` no-ops them defensively
 * anyway, so a mistake degrades to missing data rather than a lie.
 *
 * ## The never-throw contract, restated
 *
 * A telemetry exception at 3am kills a ~$300 overnight run. Both wrappers
 * therefore:
 *  - no-op silently when their ledgers are absent (a bare test ctx), exactly as
 *    `timeRole` (`timing.ts:86`) and `captureRoleCost` (`capture.ts:54`) do;
 *  - never swallow, alter, or delay the wrapped dispatch's result or throw;
 *  - wrap their OWN extra bookkeeping in try/catch, so even a misbehaving
 *    ledger cannot reach the pipeline.
 */

import { captureRoleCost, type CaptureDeps } from "../cost/capture.js";
import type { CostLedger, CostRole } from "../cost/ledger.js";
import { timeRole, type TimingLedger } from "../cost/timing.js";
import type { IssueLedger } from "./issue-ledger.js";

/**
 * The slice of `PipelineCtx` these wrappers read — a structural subset, so
 * `main.mts` can pass its real ctx while tests build a two-field literal and
 * neither module has to import the other.
 */
export interface TelemetryCtx {
  readonly issueNumber: number;
  readonly costLedger?: CostLedger;
  readonly timingLedger?: TimingLedger;
  readonly issueLedger?: IssueLedger;
  readonly deps: { readonly logError: (line: string) => void };
}

/** Run `fn`, swallowing anything it throws. Bookkeeping only — never a dispatch. */
function neverThrow(ctx: TelemetryCtx, what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    try {
      ctx.deps.logError(
        `issue telemetry (${what}) skipped: ${(err as Error).message}`,
      );
    } catch {
      // never fail a run over telemetry, not even the error log
    }
  }
}

/**
 * Time one attributable role's dispatch into BOTH the run-scoped
 * {@link TimingLedger} and the per-issue {@link IssueLedger}.
 *
 * Drop-in for `timeRole(ctx.timingLedger, role, fn)` at the four attributable
 * sites; the argument order and pass-through semantics are identical.
 *
 * It brackets its own clock reads around the `timeRole` call rather than
 * reusing that function's delta, because `timeRole` returns the dispatch's
 * value `T`, not the elapsed time — and changing it to return both would break
 * the byte-identical guarantee above. The two brackets differ only by the
 * function-call overhead between them, which is immaterial against dispatches
 * measured in minutes.
 *
 * The fold happens in a `finally`, mirroring `timing.ts:90-92`, so a THROWING
 * dispatch still contributes its elapsed time and its throw is re-raised
 * unchanged.
 */
export async function timeIssueRole<T>(
  ctx: TelemetryCtx,
  role: CostRole,
  fn: () => Promise<T>,
  now: () => number = () => Date.now(),
): Promise<T> {
  const issueLedger = ctx.issueLedger;
  if (issueLedger === undefined) return timeRole(ctx.timingLedger, role, fn, now);
  const start = now();
  try {
    return await timeRole(ctx.timingLedger, role, fn, now);
  } finally {
    neverThrow(ctx, `${role} timing`, () => {
      issueLedger.addTiming(ctx.issueNumber, role, now() - start);
    });
  }
}

/**
 * Capture one attributable role's token usage into BOTH the run-scoped
 * {@link CostLedger} and the per-issue {@link IssueLedger}.
 *
 * Drop-in for `captureRoleCost(ctx.costLedger, role, handle, ctx.deps.logError)`
 * at the four attributable sites. It reuses the entries `captureRoleCost` now
 * returns rather than re-resolving and re-parsing the session JSONL, so the
 * per-issue attribution costs one extra `Map` write, not a second file read —
 * and the two ledgers can never disagree about what they saw.
 *
 * `[]` back from the capture means "nothing to attribute" and produces NO row;
 * it must never be read as "this role cost zero" (`ledger.ts:157-165`).
 */
export async function captureIssueRoleCost(
  ctx: TelemetryCtx,
  role: CostRole,
  handle: { readonly iterations?: readonly unknown[] } | undefined,
  deps?: CaptureDeps,
): Promise<void> {
  const entries = await captureRoleCost(
    ctx.costLedger,
    role,
    handle as Parameters<typeof captureRoleCost>[2],
    ctx.deps.logError,
    // `undefined` selects `captureRoleCost`'s own default deps.
    deps,
  );
  const issueLedger = ctx.issueLedger;
  if (issueLedger === undefined || entries.length === 0) return;
  neverThrow(ctx, `${role} cost`, () => {
    issueLedger.addCost(ctx.issueNumber, role, entries);
  });
}
