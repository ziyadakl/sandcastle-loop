/**
 * Shared session-JSONL fixtures for the cost pipeline — and their EXPECTED
 * extracted totals, exported as typed constants so consumers assert against
 * one definition instead of each re-deriving the arithmetic.
 *
 * The `.jsonl` files next to this module are HAND-AUTHORED, not copied from a
 * real session. They are calibrated to realistic token magnitudes observed in
 * `~/.claude/projects/**` but contain ZERO prose, tool input, file paths, or
 * any other conversation content — every line carries only the structural
 * fields `extractUsageFromSession` actually reads:
 *
 *   type === "assistant"  →  message.model (string)
 *                            message.usage.{input,output,cache_creation_input,
 *                                           cache_read_input}_tokens
 *
 * Anything else on those lines (uuid, timestamp, id, stop_reason, empty
 * `content: []`) is inert shape, present only so the files look like real
 * session logs to a human reading them.
 *
 * ── FIXTURE INVENTORY ──────────────────────────────────────────────────────
 *
 * session-haiku-dated.jsonl
 *   3 assistant lines, all `claude-haiku-4-5-20251001` — the DATED haiku id.
 *   As of this commit that exact string is UNPRICED: `pricing.ts` keys on the
 *   undated `claude-haiku-4-5`, so `costForUsage` returns null and the ledger
 *   files it under `unpricedModels`. A corpus scan attributed ~14,296 session
 *   lines to this id, i.e. this is the single biggest source of silently
 *   uncosted usage. This fixture is the regression proof for the pricing fix:
 *   before it, cost is null; after it, cost is HAIKU_DATED_COST_AFTER_FIX.
 *
 * session-sonnet.jsonl
 *   2 assistant lines, all `claude-sonnet-5` — a model that IS priced today
 *   and is not expected to change. Use this whenever a test needs a stable
 *   priced session.
 *
 * session-multi-model.jsonl
 *   Three distinct models in one session (first-appearance order:
 *   claude-sonnet-5, claude-haiku-4-5-20251001, zzz-not-a-model), plus four
 *   deliberate NOISE lines that the extractor's robustness contract must skip
 *   and which therefore contribute NOTHING to the totals below:
 *     - a `type: "user"` line
 *     - an assistant line with a model but no `usage`
 *     - an assistant line with a `usage` full of 999999s but NO model
 *     - a truncated / unparseable JSON line, and a `type: "summary"` line
 *   One sonnet line also omits both cache sub-fields entirely, exercising the
 *   "missing usage sub-field defaults to 0" rule.
 *   `zzz-not-a-model` is a permanent placeholder: it is guaranteed never to be
 *   added to the price table, so it is the safe way to test unpriced handling.
 */

import type { Usage } from "../pricing.js";

/** Repo-relative-free absolute paths to the three fixtures. */
export const FIXTURE_DIR = import.meta.dirname;

export const HAIKU_DATED_FIXTURE = `${FIXTURE_DIR}/session-haiku-dated.jsonl`;
export const SONNET_FIXTURE = `${FIXTURE_DIR}/session-sonnet.jsonl`;
export const MULTI_MODEL_FIXTURE = `${FIXTURE_DIR}/session-multi-model.jsonl`;

/** The dated haiku id that `pricing.ts` does not yet key on. */
export const HAIKU_DATED_MODEL = "claude-haiku-4-5-20251001";
/** A model id that must NEVER be priced — the canonical unpriced test value. */
export const NEVER_PRICED_MODEL = "zzz-not-a-model";

// ── session-haiku-dated.jsonl ────────────────────────────────────────────────

/** Aggregated usage for the single model in `session-haiku-dated.jsonl`. */
export const HAIKU_DATED_USAGE: Usage = {
  inputTokens: 12,
  outputTokens: 2000,
  cacheCreationInputTokens: 55000,
  cacheReadInputTokens: 90000,
};
/** `totalTokens(HAIKU_DATED_USAGE)`. */
export const HAIKU_DATED_TOTAL_TOKENS = 147012;
/**
 * Estimated USD once `claude-haiku-4-5-20251001` gains the haiku rate row
 * (1 / 5 / 1.25 / 0.10 per 1e6). Until then `costForUsage` returns null.
 */
export const HAIKU_DATED_COST_AFTER_FIX = 0.087762;

// ── session-sonnet.jsonl ─────────────────────────────────────────────────────

/** Aggregated usage for the single model in `session-sonnet.jsonl`. */
export const SONNET_USAGE: Usage = {
  inputTokens: 20,
  outputTokens: 2000,
  cacheCreationInputTokens: 50000,
  cacheReadInputTokens: 30000,
};
/** `totalTokens(SONNET_USAGE)`. */
export const SONNET_TOTAL_TOKENS = 82020;
/** Estimated USD at the current sonnet rate (3 / 15 / 3.75 / 0.30 per 1e6). */
export const SONNET_COST = 0.22656;

// ── session-multi-model.jsonl ────────────────────────────────────────────────

/**
 * Per-model aggregates for `session-multi-model.jsonl`, in the extractor's
 * first-appearance order. `extractUsageFromSession` returns exactly this,
 * with these three entries and no others.
 */
export const MULTI_MODEL_USAGE: readonly {
  readonly model: string;
  readonly usage: Usage;
}[] = [
  {
    model: "claude-sonnet-5",
    usage: {
      inputTokens: 12,
      outputTokens: 350,
      cacheCreationInputTokens: 12000,
      cacheReadInputTokens: 0,
    },
  },
  {
    model: HAIKU_DATED_MODEL,
    usage: {
      inputTokens: 5,
      outputTokens: 400,
      cacheCreationInputTokens: 5000,
      cacheReadInputTokens: 28000,
    },
  },
  {
    model: NEVER_PRICED_MODEL,
    usage: {
      inputTokens: 1,
      outputTokens: 100,
      cacheCreationInputTokens: 2000,
      cacheReadInputTokens: 0,
    },
  },
];

/** Estimated USD for the sonnet slice of the multi-model fixture. */
export const MULTI_MODEL_SONNET_COST = 0.050286;
/** Estimated USD for the dated-haiku slice, once that id is priced. */
export const MULTI_MODEL_HAIKU_DATED_COST_AFTER_FIX = 0.011055;
/**
 * `totalTokens` summed over all three models — priced and unpriced alike,
 * which is what `RoleSummary.tokens` reports.
 */
export const MULTI_MODEL_TOTAL_TOKENS = 47868;
