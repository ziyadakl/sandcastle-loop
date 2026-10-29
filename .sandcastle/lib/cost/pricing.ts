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
 * Baked list-rate table, keyed by the UNDATED model id. The `[1m]` long-context
 * variants deliberately share their base model's row (premium NOT modeled — see
 * the module header).
 *
 * Session JSONL usually reports a DATED id (`claude-haiku-4-5-20251001`); those
 * are normalized onto this table by `resolveRate`, so a dated release does NOT
 * need its own row here. Add a row only for a genuinely new base model.
 *
 * UNPRICED models (gpt-5.5, kimi-for-coding, glm-4.6, anything not listed) are
 * absent by design: `costForUsage` returns `null` for them so the ledger can
 * surface them in `unpricedModels` rather than silently counting them as $0.
 */
const RATES: Readonly<Record<string, ModelRate>> = {
  // opus 5.5: 4 / 20 / 5.00 / 0.20. The one row off the 0.10×input cache-read
  // rule: Anthropic publishes $0.20 (0.05×) for this model, and the published
  // rate beats the rule of thumb.
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
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

/** All-zero rate — see `NON_BILLABLE_MODELS`. */
const ZERO_RATE: ModelRate = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/**
 * Ids that are NOT models and bill nothing, priced at an all-zero rate so they
 * are DROPPED rather than surfaced in `unpricedModels`.
 *
 * They live outside {@link RATES} on purpose: that table means "billable
 * models", and its absent-means-unpriced rule exists precisely so real usage is
 * never silently counted as $0. These are the documented exceptions.
 *
 *   `<synthetic>` — Claude Code's own marker for a locally-generated assistant
 *   message (an interrupt notice, a synthesized error). Real value: a corpus
 *   scan of ~400 sessions saw it 10 times. Reporting it as an unpriced MODEL
 *   would cry wolf at an operator reading the end-of-run line.
 *
 * NOT included, deliberately: the bare aliases `sonnet` (17 occurrences) and
 * `opus` (3). Those denote real, billed usage whose concrete model — and thus
 * whose rate, which differs ~3× between the families — is not recoverable from
 * the id. Guessing would silently misprice real spend, so they stay unpriced
 * and show up in `unpricedModels`, which is exactly that channel's job.
 */
const NON_BILLABLE_MODELS: ReadonlySet<string> = new Set(["<synthetic>"]);

/**
 * Anchored trailing-date suffix, e.g. the `-20251001` of
 * `claude-haiku-4-5-20251001`.
 *
 * The `$` anchor and the exact `{8}` are load-bearing: `claude-opus-4-8` must
 * keep its rate (that `4-8` is a version, not a date), and a date must never be
 * stripped from the middle of an id.
 */
const DATE_SUFFIX = /-\d{8}$/;

/**
 * Resolve a model id to its rate row — the SINGLE lookup both public functions
 * route through, so `costForUsage` and `isPricedModel` can never disagree. (If
 * only one normalized, `unpricedModels` would start lying, and a telemetry bug
 * that looks like a ledger bug is the expensive kind.)
 *
 * Order: exact table hit (so every already-priced id behaves byte-identically)
 * → non-billable sentinel → strip ONE trailing date and retry → `undefined`.
 *
 * `Object.hasOwn` rather than a bare index: `RATES` is a plain object, so
 * `RATES["toString"]` would otherwise yield an inherited FUNCTION and make
 * every arithmetic term `NaN`, permanently poisoning the run total. The
 * date-stripping branch widens that exposure (`valueOf-20251001` → `valueOf`).
 *
 * KNOWN GAP, deliberately not handled: a dated long-context id such as
 * `claude-opus-4-8-20260101[1m]` ends in `]`, so the anchored regex won't strip
 * it and it reads as unpriced. That fails LOUDLY into `unpricedModels` rather
 * than silently costing $0, which is the safe direction; add a second pass only
 * once such an id is actually observed in a session log.
 */
function resolveRate(model: string): ModelRate | undefined {
  // Never-throw contract (capture.ts:62-68, timing.ts:42-43): a non-string
  // sneaking past the type boundary is clamped to "unpriced", never thrown.
  if (typeof model !== "string") return undefined;
  if (Object.hasOwn(RATES, model)) return RATES[model];
  if (NON_BILLABLE_MODELS.has(model)) return ZERO_RATE;
  const undated = model.replace(DATE_SUFFIX, "");
  if (undated !== model && Object.hasOwn(RATES, undated)) return RATES[undated];
  return undefined;
}

/**
 * Estimated USD cost for one model's aggregated token usage.
 *
 * Returns `null` — never `0` — when the model is not in the price table, so the
 * caller can distinguish "unpriced" from "priced but free". Cost is the sum of
 * each token bucket times its per-1e6 rate, divided by 1e6.
 */
export function costForUsage(model: string, usage: Usage): number | null {
  const rate = resolveRate(model);
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
  return resolveRate(model) !== undefined;
}
