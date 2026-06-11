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
  planner:           { default: "claude-opus-4-8",   escalations: ["claude-opus-4-8[1m]"] },
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

export type ModelRole = keyof typeof models;
