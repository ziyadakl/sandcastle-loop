/**
 * The PURE assembly step that turns four run-scoped accumulators into the two
 * additive `status.json` keys — `issueTelemetry` and `runTelemetry`.
 *
 * This module exists so the hardest slice of the telemetry work is not a diff
 * inside `main.mts` (8,786 lines, no unit-test seam, and a loop that refuses to
 * launch while it is dirty). `lib/cost/capture.ts:5-9` already set the
 * precedent: `captureRoleCost` was extracted from `main.mts` for exactly this
 * reason. Everything here is data-in/data-out with no I/O, so the entire
 * derivation is testable in milliseconds and `main.mts`'s drain shrinks to a
 * call plus two guarded store writes.
 *
 * ## What it derives (as opposed to passes through)
 *
 *  - **`issueTelemetry`** — an OUTER JOIN of the {@link IssueLedger}'s rows
 *    (cost/tokens/wall-time spine) with the {@link IssueTelemetryBag}'s rows
 *    (attempt counts, ship path, outcome). Two accumulators, one row per issue.
 *  - **`tokenEfficiency`** — the per-role 4-way split plus `cacheHitRatio`,
 *    recovered from the `CostSummary` whose own `totals.perRole` output flattens
 *    tokens to a single number.
 *  - **`overheadCostUsd`** — the summed cost of the four BATCH roles, which are
 *    structurally unchargeable to any one ticket.
 *
 * ## Contracts it must not break
 *
 * ABSENT ≠ ZERO, everywhere. An empty patch is returned rather than
 * `{issueTelemetry: [], runTelemetry: {}}`, because an emitted-but-empty member
 * asserts "measured, and there was nothing", which is a different claim from
 * "never instrumented". The same rule governs every member below.
 *
 * `costUsd: null` NEVER means free — it means every model was unpriced
 * (`ledger.ts:157-165`). It is never coerced to, or summed as, 0.
 *
 * Like every other module under `lib/telemetry/`, this one must NEVER throw
 * into a run (`capture.ts:62-68`, `timing.ts:42-43`) — a telemetry exception at
 * 3am kills a ~$300 overnight run. It is pure and total: every input is
 * optional, and malformed entries are dropped rather than propagated into a row
 * that would fail `SandcastleStatusSchema`. An unparseable snapshot is just as
 * fatal as a throw and much harder to see, since `z.object` STRIPS silently.
 */

import { CostLedger, type CostRole, type CostSummary } from "../cost/ledger.js";
import type {
  IssueTelemetryRow,
  RunIdentity,
  RunTelemetry,
} from "../status/schema.js";
import type { IssueTelemetryBagRow, RunCountersTelemetry } from "./issue-bag.js";
import {
  ATTRIBUTABLE_ROLES,
  cacheHitRatio,
  isRecordableIssue,
  usageToSplit,
  zeroSplit,
} from "./issue-ledger.js";

/**
 * The roles that serve a whole ITERATION rather than one ticket, so their spend
 * cannot honestly be charged to an issue — `planner`, `merger`,
 * `postMergeReviewer`, `postMergeFixer` today; see `main.mts:8117-8122`, which
 * documents the point for the post-merge fixer. Their cost lands in
 * {@link RunTelemetry.overheadCostUsd} instead, so that
 * `sum(issueTelemetry[].costUsd) + overheadCostUsd` reconciles to the run total.
 *
 * DERIVED, not hand-listed: it is exactly `CostLedger.ROLE_ORDER` minus
 * `ATTRIBUTABLE_ROLES`. Two literal arrays that must partition a third are a
 * silent-money-loss hazard — a new role added to `ROLE_ORDER` would land in
 * neither list, and its spend would vanish from BOTH sides of the identity with
 * no type error and no failing test. Deriving the complement makes that
 * impossible by construction; `payload.test.ts` pins the partition.
 */
export const BATCH_ROLES: readonly CostRole[] = CostLedger.ROLE_ORDER.filter(
  (role) => !(ATTRIBUTABLE_ROLES as readonly string[]).includes(role),
);

/** Everything the drain has on hand. Every member optional — see ABSENT ≠ ZERO. */
export interface TelemetryPayloadInput {
  /** `CostLedger.summary()` — the source of `tokenEfficiency` + `overheadCostUsd`. */
  readonly costSummary?: CostSummary;
  /** `IssueLedger.rows()` — the cost/token/wall-time spine, one row per issue. */
  readonly issueRows?: readonly IssueTelemetryRow[];
  /**
   * `issue → IssueTelemetryBag.toRow()`. ROWS, not bag instances, so this
   * module stays pure data and its tests need instantiate nothing.
   */
  readonly issueBagRows?: ReadonlyMap<number, IssueTelemetryBagRow>;
  /** `RunCounters.toRunTelemetry()` — passed through verbatim. */
  readonly runCounters?: RunCountersTelemetry;
  /**
   * `resolveRunIdentity(...)`. Re-stated here even though `recordRunIdentity`
   * wrote it at startup: `recordRunTelemetry` merges rather than replaces, so
   * restating is idempotent, and it keeps this function's output a COMPLETE
   * description of the run for consumers (notably the replay test) that never
   * saw the startup write.
   */
  readonly runIdentity?: RunIdentity;
}

/** The two additive top-level `status.json` keys. Absent ⇒ nothing captured. */
export interface TelemetryPayload {
  issueTelemetry?: IssueTelemetryRow[];
  runTelemetry?: RunTelemetry;
}

/**
 * Per-role cache economics for EVERY role that reported cost — batch roles
 * included. The attributable-only restriction applies to
 * `IssueTelemetryRowSchema.perRole`, where charging a batch role
 * to a ticket would be a lie; here the role IS the unit, so all eight belong.
 */
function buildTokenEfficiency(
  cost: CostSummary,
): NonNullable<RunTelemetry["tokenEfficiency"]> | undefined {
  const out: NonNullable<RunTelemetry["tokenEfficiency"]> = {};
  let any = false;
  for (const [role, summary] of Object.entries(cost.perRole)) {
    if (summary === undefined) continue;
    const split = usageToSplit(summary.tokens);
    // `cacheHitRatio` returns null (never NaN) for a role with no prompt
    // tokens. That guard is load-bearing: `z.number()` REJECTS NaN, so one NaN
    // here would fail the parse of the ENTIRE snapshot, not just this field.
    out[role] = { ...split, cacheHitRatio: cacheHitRatio(split) };
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Summed estimated USD of the four batch roles. TRI-STATE, and all three states
 * are distinct claims:
 *
 *   `undefined` ⇒ no batch role ran at all (key omitted).
 *   `null`      ⇒ batch roles ran, and every model they used was unpriced.
 *   number      ⇒ the priced total (a partially-unpriced set reports its
 *                 priced-only figure, matching `ledger.ts:187-201`).
 */
function buildOverheadCostUsd(cost: CostSummary): number | null | undefined {
  let sawRole = false;
  let total: number | null = null;
  for (const role of BATCH_ROLES) {
    const summary = cost.perRole[role];
    if (summary === undefined) continue;
    sawRole = true;
    // Null-preserving fold: an all-unpriced set stays null, it does NOT become 0.
    if (summary.costUsd !== null && Number.isFinite(summary.costUsd)) {
      total = (total ?? 0) + summary.costUsd;
    }
  }
  return sawRole ? total : undefined;
}

/**
 * Outer-join the ledger's spine rows with the bag's counter rows.
 *
 * OUTER, not inner, in both directions:
 *  - A ledger row with no bag (cost captured, pipeline instrumentation absent)
 *    passes through untouched.
 *  - A BAG-ONLY issue — e.g. one quarantined before any session resolved — gets
 *    a synthesised spine, because `IssueTelemetryRowSchema` REQUIRES `issue`,
 *    `costUsd`, `wallMs` and `tokens`. Dropping it instead would lose the
 *    quarantine, which is precisely the event worth recording.
 *
 * A caveat worth stating rather than papering over: the synthesised
 * `costUsd: null` reads as the schema's documented "every model was unpriced"
 * when it actually means "no cost data at all". There is no third value in the
 * schema to distinguish them, and inventing one would be a breaking change.
 *
 * The bag row is spread FIRST so the ledger's four owned fields always win a
 * collision; the bag's type cannot express them, but a stale or hand-built
 * object could, and silent spine corruption is not worth the saved line.
 */
function buildIssueRows(
  ledgerRows: readonly IssueTelemetryRow[],
  bagRows: ReadonlyMap<number, IssueTelemetryBagRow> | undefined,
): IssueTelemetryRow[] {
  const byIssue = new Map<number, IssueTelemetryRow>();

  for (const row of ledgerRows) {
    if (row === null || typeof row !== "object") continue;
    if (!isRecordableIssue(row.issue)) continue;
    byIssue.set(row.issue, row);
  }

  for (const [issue, bag] of bagRows ?? []) {
    if (!isRecordableIssue(issue)) continue;
    if (bag === null || typeof bag !== "object") continue;
    const spine = byIssue.get(issue) ?? {
      issue,
      costUsd: null,
      wallMs: 0,
      // A FRESH split per synthesised row: a shared reference would let a
      // consumer mutating one row's `tokens` silently edit every other.
      tokens: zeroSplit(),
    };
    byIssue.set(issue, {
      ...bag,
      ...spine,
      // Re-applied explicitly: `spine` above carries the ledger's own extras
      // (`perRole`), and these four are the fields the ledger OWNS outright.
      issue: spine.issue,
      costUsd: spine.costUsd,
      wallMs: spine.wallMs,
      tokens: spine.tokens,
    });
  }

  // Numeric sort, not lexicographic — #100 must not sort before #9.
  return [...byIssue.values()].sort((a, b) => a.issue - b.issue);
}

/**
 * Assemble the two additive `status.json` telemetry keys from the run's
 * accumulators. Pure, total, and never-throwing; a member is emitted only when
 * it actually has content.
 */
export function buildTelemetryPayload(
  input: TelemetryPayloadInput,
): TelemetryPayload {
  const out: TelemetryPayload = {};

  const issueRows = buildIssueRows(input.issueRows ?? [], input.issueBagRows);
  if (issueRows.length > 0) out.issueTelemetry = issueRows;

  const run: RunTelemetry = { ...input.runCounters };
  if (input.runIdentity !== undefined) run.identity = input.runIdentity;
  if (input.costSummary !== undefined) {
    const efficiency = buildTokenEfficiency(input.costSummary);
    if (efficiency !== undefined) run.tokenEfficiency = efficiency;
    const overhead = buildOverheadCostUsd(input.costSummary);
    // `!== undefined` rather than truthiness: `null` is a MEANINGFUL value here
    // ("ran, all unpriced") and must be written, not skipped.
    if (overhead !== undefined) run.overheadCostUsd = overhead;
  }
  // Emitted only when non-empty: `runTelemetry: {}` would assert "measured,
  // and there was nothing", a different claim from "never instrumented".
  if (Object.keys(run).length > 0) out.runTelemetry = run;

  return out;
}
