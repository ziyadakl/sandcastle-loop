/**
 * Run-scoped PER-ISSUE telemetry ledger.
 *
 * The third sibling of `lib/cost/ledger.ts` (dollars + tokens per ROLE) and
 * `lib/cost/timing.ts` (wall-clock ms per ROLE). Those two answer "which role
 * dominated this run"; neither can answer "did ticket #412 alone eat $60",
 * because a role total is smeared across every issue the run touched. This
 * ledger closes that gap by accumulating the same dollars, tokens and wall-time
 * against the `(issue, role)` pair, and emitting one {@link IssueTelemetryRow}
 * per issue for `status.json`.
 *
 * It is a SEPARATE accumulator on purpose: `CostLedger`/`TimingLedger` produce
 * already-shipping output pinned by a characterization test, so they are not
 * touched. Call sites feed both.
 *
 * Design notes:
 *  - Keyed on `` `${issue}\0${role}` `` — the same composite-string-key idiom as
 *    `ledger.ts:139`, so one (issue, role) pair is one lookup rather than a
 *    map-of-maps.
 *  - Pricing goes through `costForUsage` (the single source of truth for
 *    "unpriced"), so any price-table fix is inherited for free.
 *  - `costUsd: null` means EVERY model was unpriced — it never means free, and
 *    must never be coerced to or summed as 0 (mirrors `ledger.ts:157-165`).
 *  - Only the six ATTRIBUTABLE roles are recorded. `planner`, `merger`,
 *    `postMergeReviewer` and `postMergeFixer` serve a whole iteration, not one
 *    ticket; their spend belongs in `runTelemetry.overheadCostUsd` (see
 *    `RunTelemetrySchema.overheadCostUsd`). The schema's `perRole` record is
 *    open-keyed and would happily accept them, so the contract is enforced HERE
 *    or nowhere.
 *
 * Pure aggregation + pricing lookup; no I/O. Like its siblings it must NEVER
 * throw into a run (`capture.ts:62-68`, `timing.ts:42-43`): a telemetry
 * exception can kill a $300 overnight run. Every input is clamped at ingest so
 * a bad clock read or a malformed usage blob can neither throw nor produce a
 * row that fails `SandcastleStatusSchema` — an unparseable snapshot at 3am is
 * just as fatal as a throw, and much harder to see.
 */

import type { CostRole } from "../cost/ledger.js";
import { costForUsage, type Usage } from "../cost/pricing.js";
import type { ModelUsage } from "../cost/session-usage.js";
import type {
  IssueRoleTelemetry,
  IssueTelemetryRow,
  TokenSplit,
} from "../status/schema.js";

export type { IssueRoleTelemetry, IssueTelemetryRow, TokenSplit };

/**
 * The six roles whose spend is chargeable to ONE ticket. The other four
 * `CostRole`s are batch/run-scoped and structurally unattributable.
 *
 * `checkWriter` (issue #911) joined this list, not `BATCH_ROLES`
 * (`lib/telemetry/payload.ts`), because it is dispatched once per issue,
 * before the implementer, to write that ONE issue's acceptance check — it is
 * exactly as chargeable to a single ticket as `implementer` or `reviewer`
 * are, unlike `planner`/`merger`/`postMergeReviewer`/`postMergeFixer`, which
 * serve a whole iteration.
 *
 * `judge` (issue #1118) joined it on exactly the same reasoning. It is
 * dispatched once or twice per ticket — an early pass over that ONE ticket's
 * freshly-written check, and a second only if that ticket's check and its
 * builder's code contradict each other — and both passes read that ticket's
 * own issue body and nothing else. Every dollar it spends was spent on one
 * ticket, so it is exactly as chargeable as `implementer` is, and putting it
 * in `BATCH_ROLES` would smear a per-ticket referee's cost across the whole
 * run's overhead where no ticket could ever be asked what it cost.
 */
export const ATTRIBUTABLE_ROLES = [
  "checkWriter",
  "judge",
  "implementer",
  "reviewer",
  // No producer since spec #1334; kept so older rows still attribute.
  "critique",
  "recovery",
] as const;

/** A `CostRole` narrowed to the ones this ledger will record. */
export type AttributableRole = (typeof ATTRIBUTABLE_ROLES)[number];

const ATTRIBUTABLE = new Set<string>(ATTRIBUTABLE_ROLES);

function isAttributable(role: CostRole): role is AttributableRole {
  return ATTRIBUTABLE.has(role);
}

/**
 * `IssueTelemetryRowSchema.issue` is `int().positive()`; anything else is
 * dropped. Exported and shared with `payload.ts`, which applies the identical
 * rule at the assembly boundary — two copies of a schema constraint is exactly
 * how the two drift apart.
 */
export function isRecordableIssue(issue: number): boolean {
  return Number.isInteger(issue) && issue > 0;
}

/**
 * A finite, non-negative integer, or `undefined` for anything else. The shared
 * core of the REQUIRED-count clamps in `lib/telemetry/` (`occurrences` in
 * `issue-bag.ts` is deliberately separate — it is a different predicate, not a
 * boundary variation: it coerces `true` to 1 and treats 0 as "no bump").
 * Mirrors `timing.ts:43`, and
 * is applied to token buckets too because this ledger cannot assume its entries
 * came through `extractUsageFromSession`'s sanitizer. Clamping BEFORE pricing
 * also keeps a `NaN` token count from propagating into a `NaN` dollar figure.
 */
export function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/**
 * {@link safeCount} with `undefined` folded to `0`, for the fields the schema
 * requires rather than allows to be absent.
 *
 * `count(v) === (safeCount(v) ?? 0)` for every input: a negative or non-finite
 * value clamps to 0 either way, and the only boundary they could disagree on is
 * exactly 0, where `safeCount` already returns 0.
 */
function count(v: unknown): number {
  return safeCount(v) ?? 0;
}

/** All-zero {@link TokenSplit}. A FUNCTION, never a shared constant — a single
 *  frozen-in-spirit object handed to several rows means one consumer's mutation
 *  silently edits the others. */
export function zeroSplit(): TokenSplit {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

/** Defensive copy, so an emitted row never aliases a live accumulator. */
export function copySplit(b: TokenSplit): TokenSplit {
  return {
    input: b.input,
    output: b.output,
    cacheWrite: b.cacheWrite,
    cacheRead: b.cacheRead,
  };
}

/**
 * Map the cost ledger's `Usage` field names to the wire {@link TokenSplit}
 * names. The two vocabularies differ (`TokenSplitSchema` is the canonical map)
 * and crossing them is silently wrong rather than a type error, since both are
 * all-number — so the map lives in exactly one place.
 */
export function usageToSplit(u: Usage): TokenSplit {
  return {
    input: u.inputTokens,
    output: u.outputTokens,
    cacheWrite: u.cacheCreationInputTokens,
    cacheRead: u.cacheReadInputTokens,
  };
}

function addInto(target: TokenSplit, src: TokenSplit): void {
  target.input += src.input;
  target.output += src.output;
  target.cacheWrite += src.cacheWrite;
  target.cacheRead += src.cacheRead;
}

interface RoleAcc {
  readonly issue: number;
  readonly role: AttributableRole;
  /** Running dollar total for PRICED models; stays null until one prices. */
  costUsd: number | null;
  tokens: TokenSplit;
  wallMs: number;
  /** Timed dispatches folded in — the timing ledger's `runs` semantics. */
  runs: number;
  /** Whether any cost entry landed, so an untimed role omits wallMs/runs. */
  sawCost: boolean;
  /** Whether any timing landed, so an uncosted role omits costUsd/tokens. */
  sawTiming: boolean;
}

export class IssueLedger {
  /** Keyed by `${issue}\0${role}` — one lookup per pair, no map-of-maps. */
  private readonly cells = new Map<string, RoleAcc>();

  private cell(issue: number, role: AttributableRole): RoleAcc {
    const key = `${issue}\0${role}`;
    let acc = this.cells.get(key);
    if (acc === undefined) {
      acc = {
        issue,
        role,
        costUsd: null,
        tokens: zeroSplit(),
        wallMs: 0,
        runs: 0,
        sawCost: false,
        sawTiming: false,
      };
      this.cells.set(key, acc);
    }
    return acc;
  }

  /**
   * Accumulate one session's per-model usage under `(issue, role)`.
   *
   * Best-effort caller contract, identical to `CostLedger.add`: `[]` (no
   * resolvable session) is a harmless no-op that creates no row. A non-positive
   * or fractional `issue`, a batch role, and any malformed entry are dropped
   * silently rather than throwing or emitting an unparseable row.
   */
  addCost(issue: number, role: CostRole, entries: readonly ModelUsage[]): void {
    if (!isRecordableIssue(issue)) return;
    if (!isAttributable(role)) return;
    if (!Array.isArray(entries) || entries.length === 0) return;

    // The cell is created LAZILY, on the first entry that names a model, so a
    // batch of entirely-malformed entries behaves like `[]` — no phantom row —
    // rather than emitting an issue with an empty per-role object.
    let acc: RoleAcc | undefined;
    for (const entry of entries) {
      const model = (entry as { model?: unknown } | null | undefined)?.model;
      if (typeof model !== "string") continue;
      acc ??= this.cell(issue, role);
      acc.sawCost = true;

      const raw = (entry as { usage?: Record<string, unknown> }).usage;
      const usage = {
        inputTokens: count(raw?.inputTokens),
        outputTokens: count(raw?.outputTokens),
        cacheCreationInputTokens: count(raw?.cacheCreationInputTokens),
        cacheReadInputTokens: count(raw?.cacheReadInputTokens),
      };
      addInto(acc.tokens, usageToSplit(usage));

      // `costForUsage` returns null iff the model has no baked price — the one
      // source of truth for "unpriced". Priced models still sum normally, so a
      // MIXED role reports its priced-only figure rather than collapsing to null.
      const cost = costForUsage(model, usage);
      if (cost !== null && Number.isFinite(cost)) {
        acc.costUsd = (acc.costUsd ?? 0) + cost;
      }
    }
  }

  /**
   * Fold one dispatch's wall-clock duration into `(issue, role)`, bumping its
   * run count. A negative or non-finite `wallMs` clamps to 0 (`timing.ts:42-43`)
   * so a bad clock read can never corrupt the total — the dispatch is still
   * counted, since it demonstrably happened.
   */
  addTiming(issue: number, role: CostRole, wallMs: number): void {
    if (!isRecordableIssue(issue)) return;
    if (!isAttributable(role)) return;
    const acc = this.cell(issue, role);
    acc.sawTiming = true;
    acc.wallMs += count(wallMs);
    acc.runs += 1;
  }

  /**
   * One row per issue, ascending by issue number (numeric, not lexicographic).
   *
   * Only the fields this ledger OWNS are populated: `issue`, `costUsd`,
   * `wallMs`, `tokens` and `perRole`. The rest of `IssueTelemetryRow`
   * (`implementerAttempts`, `shipPath`, `changedLines`, …) comes from a separate
   * accumulator and is merged later, so it is deliberately left absent.
   */
  rows(): IssueTelemetryRow[] {
    const byIssue = new Map<
      number,
      {
        issue: number;
        costUsd: number | null;
        tokens: TokenSplit;
        wallMs: number;
        perRole: Record<string, IssueRoleTelemetry>;
      }
    >();

    for (const acc of this.cells.values()) {
      let row = byIssue.get(acc.issue);
      if (row === undefined) {
        row = {
          issue: acc.issue,
          costUsd: null,
          tokens: zeroSplit(),
          wallMs: 0,
          perRole: {},
        };
        byIssue.set(acc.issue, row);
      }
      addInto(row.tokens, acc.tokens);
      row.wallMs += acc.wallMs;
      // Null-preserving fold: an all-unpriced issue must stay null, NOT become 0.
      if (acc.costUsd !== null) row.costUsd = (row.costUsd ?? 0) + acc.costUsd;

      // Report only what this role actually saw, so "no cost data" never
      // masquerades as "all models unpriced" (and vice versa for timing).
      row.perRole[acc.role] = {
        ...(acc.sawCost ? { costUsd: acc.costUsd, tokens: copySplit(acc.tokens) } : {}),
        ...(acc.sawTiming ? { wallMs: acc.wallMs, runs: acc.runs } : {}),
      };
    }

    return [...byIssue.values()]
      .sort((a, b) => a.issue - b.issue)
      .map((r) => ({
        issue: r.issue,
        costUsd: r.costUsd,
        wallMs: r.wallMs,
        tokens: copySplit(r.tokens),
        perRole: r.perRole,
      }));
  }
}

/**
 * Share of an issue's (or role's) PROMPT tokens that were served from cache:
 * `cacheRead / (input + cacheWrite + cacheRead)`. Output tokens are excluded —
 * they are generated, never cacheable, so folding them in would understate the
 * hit rate on output-heavy work.
 *
 * Returns `null`, never `NaN`, when there were no prompt tokens at all (0/0) or
 * when any field is non-finite. That guard is load-bearing: `z.number()` REJECTS
 * `NaN`, so a single NaN here would fail the whole `status.json` parse — the
 * entire snapshot, not just this number.
 *
 * The inputs are validated rather than only the result, because a garbage field
 * can yield a plausible-looking finite answer (`10 / Infinity === 0` reads as a
 * confident "0% cache hit"). This ledger's own splits are always clamped, but
 * the helper is exported and pure, so callers can hand it anything.
 */
export function cacheHitRatio(t: TokenSplit): number | null {
  const parts = [t.input, t.cacheWrite, t.cacheRead];
  if (!parts.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return null;
  }
  const denom = t.input + t.cacheWrite + t.cacheRead;
  if (denom <= 0) return null;
  const ratio = t.cacheRead / denom;
  return Number.isFinite(ratio) ? ratio : null;
}
