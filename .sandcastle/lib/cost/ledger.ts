/**
 * Run-scoped cost ledger.
 *
 * ONE instance is created per sandcastle run (near the status store) and
 * threaded to the role runners. Each role runner, after its agent run
 * completes, resolves the session JSONL, extracts per-model usage via
 * `extractUsageFromSession`, and calls `add(role, entries)`. At the end of the
 * run the loop logs `summary()` — a per-role dollar/token breakdown, a grand
 * total, and any unpriced models so nothing is silently zeroed.
 *
 * Pure aggregation + pricing lookup; no I/O. The dollar figures are ESTIMATES
 * from list rates (see pricing.ts) — for relative comparison, not billing.
 */

import { costForUsage, type Usage } from "./pricing.js";
import type { ModelUsage } from "./session-usage.js";

/**
 * The 10 loop roles a run dispatches agents for.
 *
 * `judge` (issue #1118) was added the same way and for the same reason: it is
 * dispatched once or twice per ticket — an early pass over the freshly-written
 * check, and again when the check and the builder's code contradict each other
 * — so its spend is chargeable to ONE ticket. Registering it in the three
 * places `checkWriter` is registered is the whole of its instrumentation.
 *
 * `checkWriter` (issue #911, Piece D) was added alongside the check-writer
 * pass — the design's own "instrument this first" requirement: "what one
 * check-writing pass costs is the design's one open unknown… add the
 * per-agent cost split before the check-writer's first run". Registering it
 * here, in `ROLE_ORDER` below, and in `ATTRIBUTABLE_ROLES`
 * (`lib/telemetry/issue-ledger.ts`) is the whole of that instrumentation —
 * every other consumer (the summary line, `status.json`'s `perRole`,
 * `issues.jsonl`'s per-issue rows) derives from these three registrations
 * rather than needing its own edit.
 */
export type CostRole =
  | "planner"
  | "checkWriter"
  | "judge"
  | "implementer"
  | "reviewer"
  /** No producer since spec #1334 folded the design critique into the
   *  reviewer. Kept: a closed union, and cost rows on disk carry it. */
  | "critique"
  | "merger"
  | "postMergeReviewer"
  | "postMergeFixer"
  | "recovery";

interface RoleSummary {
  /**
   * Estimated USD for this role's PRICED models, or `null` when the role saw
   * no priced model at all (so an all-unpriced role reads null, not $0).
   */
  readonly costUsd: number | null;
  /** Total tokens across ALL of this role's models (priced + unpriced). */
  readonly tokens: Usage;
}

/**
 * One (role, model) pair actually dispatched. Which model counts as "the
 * default" vs "an escalation" is a judgment call left to the reader — this
 * ledger has no view of `models.ts`'s ladder and no view of which backend
 * (Anthropic vs Codex) was even active, so it makes no claim about that here.
 * It only reports what ran and what it cost; a consumer with the config in
 * hand (or simply "the model with the most calls is the default") can label
 * the rest as escalations without this file ever needing to know the ladder.
 */
export interface ModelSummary {
  readonly role: CostRole;
  readonly model: string;
  /** Estimated USD for this (role, model) pair; `null` when unpriced. */
  readonly costUsd: number | null;
  readonly tokens: Usage;
  /** Number of usage entries folded in — one per agent dispatch that used it. */
  readonly calls: number;
}

/**
 * Flattened wire row for one (role, model) pair — the `ModelSummary` above
 * with its token breakdown summed to one number, mirroring how
 * {@link RoleBreakdown} flattens `RoleSummary`. This is the shape that
 * actually reaches `status.json` (see `recordModelBreakdown` in
 * `lib/status/store.ts`); the un-flattened `ModelSummary` never leaves this
 * file.
 */
export interface ModelBreakdownRow {
  role: CostRole;
  model: string;
  costUsd?: number | null;
  tokens?: number;
  calls?: number;
}

export interface CostSummary {
  /** Present only for roles that received at least one usage entry. */
  readonly perRole: Partial<Record<CostRole, RoleSummary>>;
  /** Same totals as `perRole`, split further by which model ran. */
  readonly perModel: readonly ModelSummary[];
  /** Sum of every role's priced cost. Unpriced usage is excluded. */
  readonly totalCostUsd: number;
  /** Deduped, sorted model ids seen with no baked price. */
  readonly unpricedModels: string[];
}

/**
 * Canonical per-role breakdown row merged from the cost ledger (estimated USD +
 * total tokens) and the timing ledger (cumulative wall-clock ms + dispatch
 * count). This is the ONE definition of the shape that flows into the status
 * store's `recordRoleBreakdown` and out to the web view-model; every field is
 * optional so a partial source (cost-only, timing-only, absent) stays valid.
 */
export interface RoleBreakdown {
  /** Estimated USD for the role's priced models; `null` when all unpriced. */
  costUsd?: number | null;
  /** Total tokens across the role's models (priced + unpriced). */
  tokens?: number;
  /** Cumulative wall-clock milliseconds across the role's dispatches. */
  wallMs?: number;
  /** Number of agent dispatches attributed to the role. */
  runs?: number;
}

interface RoleAcc {
  /** Running dollar total for PRICED models; stays null until one prices. */
  costUsd: number | null;
  tokens: { input: number; output: number; write: number; read: number };
}

interface ModelAcc extends RoleAcc {
  role: CostRole;
  model: string;
  calls: number;
}

export class CostLedger {
  private readonly roles = new Map<CostRole, RoleAcc>();
  // Keyed by "role model" — a plain string key, not a nested Map, so one
  // (role, model) pair is one lookup instead of a map-of-maps.
  private readonly models = new Map<string, ModelAcc>();
  private readonly unpriced = new Set<string>();

  /**
   * Accumulate one session's per-model usage under `role`. Best-effort caller
   * contract: passing `[]` (no resolvable session) is a harmless no-op.
   */
  add(role: CostRole, entries: readonly ModelUsage[]): void {
    if (entries.length === 0) return;
    let acc = this.roles.get(role);
    if (acc === undefined) {
      acc = { costUsd: null, tokens: { input: 0, output: 0, write: 0, read: 0 } };
      this.roles.set(role, acc);
    }
    for (const { model, usage } of entries) {
      acc.tokens.input += usage.inputTokens;
      acc.tokens.output += usage.outputTokens;
      acc.tokens.write += usage.cacheCreationInputTokens;
      acc.tokens.read += usage.cacheReadInputTokens;

      const modelKey = `${role}\0${model}`;
      let modelAcc = this.models.get(modelKey);
      if (modelAcc === undefined) {
        modelAcc = {
          role,
          model,
          costUsd: null,
          tokens: { input: 0, output: 0, write: 0, read: 0 },
          calls: 0,
        };
        this.models.set(modelKey, modelAcc);
      }
      modelAcc.calls += 1;
      modelAcc.tokens.input += usage.inputTokens;
      modelAcc.tokens.output += usage.outputTokens;
      modelAcc.tokens.write += usage.cacheCreationInputTokens;
      modelAcc.tokens.read += usage.cacheReadInputTokens;

      // costForUsage returns null iff the model has no baked price — that is the
      // single source of truth for "unpriced", so surface it and skip the total.
      const cost = costForUsage(model, usage);
      if (cost === null) {
        this.unpriced.add(model);
      } else {
        acc.costUsd = (acc.costUsd ?? 0) + cost;
        modelAcc.costUsd = (modelAcc.costUsd ?? 0) + cost;
      }
    }
  }

  /**
   * Roles in a stable pipeline order for deterministic summary rendering.
   *
   * DRIFT-GUARD: this list is mirrored by `ROLE_ORDER` in
   * `.sandcastle/web/view-model.js` (the browser bundle can't import this TS
   * module). Keep the two in sync — if a 11th role is added, update both.
   */
  static readonly ROLE_ORDER: readonly CostRole[] = [
    "planner",
    "checkWriter",
    // The judge's early pass runs on the check the check-writer just wrote,
    // before the builder starts, so it sits here rather than beside critique.
    "judge",
    "implementer",
    "reviewer",
    "critique",
    "recovery",
    "merger",
    "postMergeReviewer",
    "postMergeFixer",
  ];

  summary(): CostSummary {
    const perRole: Partial<Record<CostRole, RoleSummary>> = {};
    let total = 0;
    for (const [role, acc] of this.roles) {
      if (acc.costUsd !== null) total += acc.costUsd;
      perRole[role] = {
        costUsd: acc.costUsd,
        tokens: {
          inputTokens: acc.tokens.input,
          outputTokens: acc.tokens.output,
          cacheCreationInputTokens: acc.tokens.write,
          cacheReadInputTokens: acc.tokens.read,
        },
      };
    }
    const perModel: ModelSummary[] = [...this.models.values()]
      .map((m) => ({
        role: m.role,
        model: m.model,
        costUsd: m.costUsd,
        tokens: {
          inputTokens: m.tokens.input,
          outputTokens: m.tokens.output,
          cacheCreationInputTokens: m.tokens.write,
          cacheReadInputTokens: m.tokens.read,
        },
        calls: m.calls,
      }))
      // Stable order: pipeline order first, then most-called model within a
      // role first — the model with the most calls is the de facto default,
      // so a reader with no config in hand still sees it listed first.
      .sort((a, b) => {
        const roleOrder =
          CostLedger.ROLE_ORDER.indexOf(a.role) -
          CostLedger.ROLE_ORDER.indexOf(b.role);
        return roleOrder !== 0 ? roleOrder : b.calls - a.calls;
      });
    return {
      perRole,
      perModel,
      totalCostUsd: total,
      unpricedModels: [...this.unpriced].sort(),
    };
  }
}

/** Sum a role's four token buckets into a single count for display. */
export function totalTokens(t: Usage): number {
  return (
    t.inputTokens +
    t.outputTokens +
    t.cacheCreationInputTokens +
    t.cacheReadInputTokens
  );
}

/**
 * Render a {@link CostSummary} as the one operator-facing log line the loop
 * prints at the end of a run, e.g.:
 *
 *   cost: implementer $0.02 (2000 tok) | reviewer $0.03 (2000 tok) | TOTAL $0.05 (estimate) | unpriced: kimi-for-coding
 *
 * A role with no priced model renders its dollar figure as `$n/a` (its tokens
 * still show). "(estimate)" is always present — these are list-rate estimates,
 * not billed figures. The `unpriced:` suffix appears only when some model had
 * no baked price.
 */
export function formatCostSummary(summary: CostSummary): string {
  const parts: string[] = [];
  for (const role of CostLedger.ROLE_ORDER) {
    const r = summary.perRole[role];
    if (r === undefined) continue;
    const dollars = r.costUsd === null ? "$n/a" : `$${r.costUsd.toFixed(2)}`;
    parts.push(`${role} ${dollars} (${totalTokens(r.tokens)} tok)`);
  }
  const body = parts.length > 0 ? `${parts.join(" | ")} | ` : "";
  let line = `cost: ${body}TOTAL $${summary.totalCostUsd.toFixed(2)} (estimate)`;
  if (summary.unpricedModels.length > 0) {
    line += ` | unpriced: ${summary.unpricedModels.join(", ")}`;
  }
  return line;
}
