/**
 * Phase-1 token → cost pricing.
 *
 * A pure, I/O-free price table + cost function used by the run-scoped cost
 * ledger to turn per-model token usage (extracted from session JSONL) into an
 * estimated USD figure the operator can read at the end of a run.
 *
 * IMPORTANT — these are ESTIMATES, not billed figures:
 *   - Rates are the vendor LIST rates (USD per 1,000,000 tokens) baked at the
 *     time of writing; the actual invoice may differ (negotiated rates,
 *     promo credits, rounding).
 *   - The >200K-context ("[1m]") premium tier is NOT modeled: a `...[1m]`
 *     model id is priced identically to its base model. Long-context requests
 *     are billed at a higher rate in reality, so a run that spilled past 200K
 *     tokens of context will read LOWER here than it actually cost.
 *   - cacheWrite is modeled at 1.25× the input rate and cacheRead at 0.10× the
 *     input rate (Anthropic prompt-caching multipliers).
 * The whole point is RELATIVE comparison — which role dominated, roughly how
 * much a run cost — not an accountant-grade number.
 */

/** Per-1,000,000-token rates. cacheWrite = 1.25×input, cacheRead = 0.10×input. */
interface ModelRate {
  /** USD per 1e6 input tokens. */
  readonly input: number;
  /** USD per 1e6 output tokens. */
  readonly output: number;
  /** USD per 1e6 cache-creation (write) tokens = 1.25×input. */
  readonly cacheWrite: number;
  /** USD per 1e6 cache-read tokens = 0.10×input. */
  readonly cacheRead: number;
}

/** Token counts for a single model's aggregated usage (camelCase). */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

/**
 * Baked list-rate table, keyed by the model id as it appears in the session
 * JSONL's `message.model`. The `[1m]` long-context variants deliberately share
 * their base model's row (premium NOT modeled — see the module header).
 *
 * UNPRICED models (gpt-5.5, kimi-for-coding, glm-4.6, anything not listed) are
 * absent by design: `costForUsage` returns `null` for them so the ledger can
 * surface them in `unpricedModels` rather than silently counting them as $0.
 */
const RATES: Readonly<Record<string, ModelRate>> = {
  // opus family: 5 / 25 / 6.25 / 0.50
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8[1m]": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  // sonnet family: 3 / 15 / 3.75 / 0.30
  "claude-sonnet-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // haiku: 1 / 5 / 1.25 / 0.10
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * Estimated USD cost for one model's aggregated token usage.
 *
 * Returns `null` — never `0` — when the model is not in the price table, so the
 * caller can distinguish "unpriced" from "priced but free". Cost is the sum of
 * each token bucket times its per-1e6 rate, divided by 1e6.
 */
export function costForUsage(model: string, usage: Usage): number | null {
  const rate = RATES[model];
  if (rate === undefined) return null;
  return (
    (usage.inputTokens * rate.input +
      usage.outputTokens * rate.output +
      usage.cacheCreationInputTokens * rate.cacheWrite +
      usage.cacheReadInputTokens * rate.cacheRead) /
    1_000_000
  );
}

/** True iff the model id has a baked rate (i.e. `costForUsage` won't return null). */
export function isPricedModel(model: string): boolean {
  return RATES[model] !== undefined;
}
