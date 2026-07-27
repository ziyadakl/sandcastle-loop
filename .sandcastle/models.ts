/**
 * Model configuration for sandcastle-loop roles.
 *
 * Each role has a `default` model used for its initial pass and an `escalations`
 * array of progressively-stronger models tried on retry. The retry ladder is:
 *   try `default` → fail → try `escalations[0]` → fail → try `escalations[1]`
 *   → ... → fail → quarantine.
 * Total attempts per role = 1 + escalations.length. Empty `escalations: []`
 * means no retry — failure goes straight to quarantine.
 *
 * Only `default` is consumed today. The retry ladder reads `escalations` —
 * the per-issue retry loop and the post-merge fix loop.
 *
 * To swap any role to a non-Anthropic provider (Kimi, GLM), change `default`
 * here. The runtime will dispatch to the right base URL based on the model ID
 * once multi-provider support lands.
 *
 * Model IDs must be the exact strings the SDK accepts (e.g.
 * `claude-opus-4-8[1m]` for the 1M-context tier — lowercase, square brackets,
 * no space).
 */

type RoleConfig = {
  readonly default: string;
  readonly escalations: readonly string[];
};

export const models = {
  planner:           { default: "claude-sonnet-5",   escalations: ["claude-opus-4-8[1m]"] },
  implementer:       { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
  reviewer:          { default: "claude-haiku-4-5",  escalations: ["claude-sonnet-4-6"] },
  critique:          { default: "claude-haiku-4-5",  escalations: ["claude-sonnet-4-6"] },
  merger:            { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
  postMergeReviewer: { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
  postMergeFixer:    { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
  recovery:          { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
} as const satisfies Record<string, RoleConfig>;

/**
 * Codex backend model defaults (ADR 0012). Selected by `--backend codex`, which
 * swaps the per-role fallback from `models` to this map. `gpt-5.5` is the
 * spike-verified default for codex-cli 0.139.0; `backendForModel` routes any
 * `gpt-*` / `*codex*` / `o[1-9]` id to `sandcastle.codex()`. Per-role tuning is
 * via Codex reasoning *effort* (CodexOptions.effort), not the model string, so
 * all roles share one model id for now; escalations are empty (no model-tier
 * retry ladder defined for Codex yet — a follow-up).
 */
export const codexModels = {
  planner:           { default: "gpt-5.5", escalations: [] },
  implementer:       { default: "gpt-5.5", escalations: [] },
  reviewer:          { default: "gpt-5.5", escalations: [] },
  critique:          { default: "gpt-5.5", escalations: [] },
  merger:            { default: "gpt-5.5", escalations: [] },
  postMergeReviewer: { default: "gpt-5.5", escalations: [] },
  postMergeFixer:    { default: "gpt-5.5", escalations: [] },
  recovery:          { default: "gpt-5.5", escalations: [] },
} as const satisfies Record<keyof typeof models, RoleConfig>;

/**
 * Opus 5 profile (`--opus 5`). NOT a new backend/provider — this is the same
 * anthropic provider on the `claude` backend as `models`, differing ONLY by the
 * model string on the five opus-heavy roles (implementer, merger, post-merge
 * reviewer, post-merge fixer, recovery). `claude-opus-5` is the dateless
 * `claude-{name}-{major}` id and ships with a 1M-context window BY DEFAULT, so
 * there is no `[1m]` escalation tier for it — `escalations` is empty on those
 * roles. Planner, reviewer, and critique do NOT run on Opus in any profile:
 * planner is Sonnet-first (escalating to `claude-opus-5` on a failed plan
 * here), and reviewer + critique stay byte-identical to `models` (Haiku
 * default, Sonnet escalation).
 */
export const opus5Models = {
  planner:           { default: "claude-sonnet-5", escalations: ["claude-opus-5"] },
  implementer:       { default: "claude-opus-5", escalations: [] },
  reviewer:          { default: "claude-haiku-4-5",  escalations: ["claude-sonnet-4-6"] },
  critique:          { default: "claude-haiku-4-5",  escalations: ["claude-sonnet-4-6"] },
  merger:            { default: "claude-opus-5", escalations: [] },
  postMergeReviewer: { default: "claude-opus-5", escalations: [] },
  postMergeFixer:    { default: "claude-opus-5", escalations: [] },
  recovery:          { default: "claude-opus-5", escalations: [] },
} as const satisfies Record<keyof typeof models, RoleConfig>;

/**
 * Budget profile (`--budget`). NOT a new backend/provider — the same anthropic
 * provider on the `claude` backend as `models`, differing ONLY on the
 * implementer (the loop's dominant token consumer: the only multi-turn role,
 * runs per-issue — the single lever that moves the bill). Every other role is
 * copied verbatim from `models`.
 *
 * The implementer gets a "Sonnet fix-it rung" ladder that spends the cheap
 * model twice before any Opus:
 *   - first pass       → `claude-sonnet-5` (~40% cheaper than Opus, same 1M ctx)
 *   - attempt 2 (fix)  → `claude-sonnet-5` WITH the reviewer's HAS_BLOCKERS
 *                        feedback — a cheap fix-it pass, no Opus spent yet
 *   - attempt 3        → `claude-opus-4-8[1m]` — Opus is reserved for the
 *                        round-3 grant path only, when a Sonnet fix-it still
 *                        can't clear the reviewer.
 * The retry loop walks this array by attempt number (see `escalationForAttempt`
 * in main.mts), so the ordering here is what defines the ladder.
 *
 * Budget is rejected in combination with `--opus 5`: the two flags express
 * CONTRADICTORY profiles (budget = cheapest-first, opus5 = Opus-5-everywhere)
 * and cannot both apply. See the parse-time guard in main.mts.
 */
export const budgetModels = {
  planner:           { default: "claude-sonnet-5",   escalations: ["claude-opus-4-8[1m]"] },
  implementer:       { default: "claude-sonnet-5",   escalations: ["claude-sonnet-5", "claude-opus-4-8[1m]"] },
  reviewer:          { default: "claude-haiku-4-5",  escalations: ["claude-sonnet-4-6"] },
  critique:          { default: "claude-haiku-4-5",  escalations: ["claude-sonnet-4-6"] },
  merger:            { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
  postMergeReviewer: { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
  postMergeFixer:    { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
  recovery:          { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
} as const satisfies Record<keyof typeof models, RoleConfig>;

/** Launch-time Opus model profile selector (`--opus`). */
export type OpusProfile = "4.8" | "5";

export type ModelRole = keyof typeof models;
