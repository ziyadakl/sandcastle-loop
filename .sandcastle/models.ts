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
 * `claude-opus-4-7[1m]` for the 1M-context tier — lowercase, square brackets,
 * no space).
 */

type RoleConfig = {
  readonly default: string;
  readonly escalations: readonly string[];
};

export const models = {
  planner:           { default: "claude-opus-4-7",   escalations: ["claude-opus-4-7[1m]"] },
  implementer:       { default: "claude-opus-4-7",   escalations: ["claude-opus-4-7[1m]"] },
  reviewer:          { default: "claude-haiku-4-5",  escalations: ["claude-sonnet-4-6"] },
  merger:            { default: "claude-opus-4-7",   escalations: ["claude-opus-4-7[1m]"] },
  postMergeReviewer: { default: "claude-opus-4-7",   escalations: ["claude-opus-4-7[1m]"] },
  postMergeFixer:    { default: "claude-opus-4-7",   escalations: ["claude-opus-4-7[1m]"] },
  recovery:          { default: "claude-opus-4-7",   escalations: ["claude-opus-4-7[1m]"] },
} as const satisfies Record<string, RoleConfig>;

export type ModelRole = keyof typeof models;
