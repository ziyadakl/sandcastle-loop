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
  planner:           { default: "claude-sonnet-5",     escalations: [] },
  implementer:       { default: "claude-opus-4-8[1m]", escalations: ["claude-opus-4-8[1m]", "claude-opus-5"] },
  reviewer:          { default: "claude-haiku-4-5",    escalations: ["claude-sonnet-5"] },
  critique:          { default: "claude-haiku-4-5",    escalations: [] },
  merger:            { default: "claude-opus-4-8[1m]", escalations: ["claude-opus-5"] },
  postMergeReviewer: { default: "claude-opus-4-8[1m]", escalations: ["claude-opus-5"] },
  postMergeFixer:    { default: "claude-opus-4-8[1m]", escalations: ["claude-opus-4-8[1m]"] },
  recovery:          { default: "claude-opus-4-8[1m]", escalations: ["claude-opus-4-8[1m]"] },
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
 * default; reviewer escalates to Sonnet, critique has no escalation).
 */
export const opus5Models = {
  planner:           { default: "claude-sonnet-5", escalations: ["claude-opus-5"] },
  implementer:       { default: "claude-opus-5", escalations: [] },
  reviewer:          { default: "claude-haiku-4-5",  escalations: ["claude-sonnet-5"] },
  critique:          { default: "claude-haiku-4-5",  escalations: [] },
  merger:            { default: "claude-opus-5", escalations: [] },
  postMergeReviewer: { default: "claude-opus-5", escalations: [] },
  postMergeFixer:    { default: "claude-opus-5", escalations: [] },
  recovery:          { default: "claude-opus-5", escalations: [] },
} as const satisfies Record<keyof typeof models, RoleConfig>;

/**
 * Budget profile (`--budget`). NOT a new backend/provider — the same anthropic
 * provider on the `claude` backend as `models`, differing per-role to spend the
 * cheapest model that can do each job and reserve the expensive tiers for a
 * single escalation rung.
 *
 * The finalized budget ladder (cheapest-first, expensive tiers reserved for
 * escalation; empty `escalations` means the role has no model-tier retry):
 *   - planner            → `claude-sonnet-5`, no escalation
 *   - implementer        → `claude-sonnet-5` first pass (the cheap try), then a
 *                          `claude-sonnet-5` "fix-it rung" (attempt 2, WITH the
 *                          reviewer's HAS_BLOCKERS feedback), then
 *                          `claude-opus-4-8[1m]` (attempt 3) — Opus 1M reserved
 *                          for the round-3 grant
 *   - reviewer           → `claude-haiku-4-5`, escalates to `claude-sonnet-5`
 *   - critique           → `claude-haiku-4-5`, no escalation
 *   - merger             → `claude-opus-4-8[1m]`, escalates to `claude-opus-5`
 *   - postMergeReviewer  → `claude-opus-4-8[1m]`, escalates to `claude-opus-5`
 *   - postMergeFixer     → `claude-sonnet-5`, escalates to `claude-opus-5`
 *   - recovery           → `claude-opus-4-8[1m]`, no escalation
 * The retry loops walk each `escalations` array by attempt number (see
 * `escalationForAttempt` in main.mts), so the ordering here defines the ladder.
 *
 * Budget is rejected in combination with `--opus 5`: the two flags express
 * CONTRADICTORY profiles (budget = cheapest-first, opus5 = Opus-5-everywhere)
 * and cannot both apply. See the parse-time guard in main.mts.
 */
export const budgetModels = {
  planner:           { default: "claude-sonnet-5",     escalations: [] },
  implementer:       { default: "claude-sonnet-5",     escalations: ["claude-sonnet-5", "claude-opus-4-8[1m]"] },
  reviewer:          { default: "claude-haiku-4-5",    escalations: ["claude-sonnet-5"] },
  critique:          { default: "claude-haiku-4-5",    escalations: [] },
  merger:            { default: "claude-opus-4-8[1m]", escalations: ["claude-opus-5"] },
  postMergeReviewer: { default: "claude-opus-4-8[1m]", escalations: ["claude-opus-5"] },
  postMergeFixer:    { default: "claude-sonnet-5",     escalations: ["claude-opus-5"] },
  recovery:          { default: "claude-opus-4-8[1m]", escalations: [] },
} as const satisfies Record<keyof typeof models, RoleConfig>;

/** Launch-time Opus model profile selector (`--opus`). */
export type OpusProfile = "4.8" | "5";

export type ModelRole = keyof typeof models;
