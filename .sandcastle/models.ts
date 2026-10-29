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
 * Model IDs must be the exact strings the SDK accepts. Opus 5.5
 * (`claude-opus-5-5`) and Opus 5 (`claude-opus-5`) ship with a 1M-context
 * window by default, so neither takes a `[1m]` suffix.
 */

type RoleConfig = {
  readonly default: string;
  readonly escalations: readonly string[];
};

/**
 * THERE IS NO `planner` ROLE HERE, and that is not an oversight (2026-09-03).
 *
 * The planner was deleted: `planDeterministic` in
 * `lib/state/eligible-set.ts` computes the plan in code, no agent is
 * dispatched, and nothing ever read `models.planner` again. Four dead entries
 * (one per profile map) were kept for a night on the theory that removing them
 * would force a `STATUS_SCHEMA_VERSION` bump — wrong: `RunIdentitySchema`
 * types `roleModels` as an OPEN record (`z.record`), so a missing key parses
 * fine, old and new. The schema-version argument protects the `planner`
 * **`CostRole`** in `lib/cost/ledger.ts`, which IS a closed union and which
 * the telemetry rows already on disk still carry — that one stays.
 *
 * Re-adding a `planner:` line here would put a model string in front of a
 * reader that nothing dispatches.
 */

/**
 * WHY THE REVIEWER IS NOT A CHEAP TIER (decided 2026-08-02, do not revert)
 *
 * `reviewer` and `critique` both ran on `claude-haiku-4-5` in every profile
 * while the implementer ran Opus. The gate was structurally weaker than the
 * work it judged, and it showed: the 2026-08-02 run (PR #844) landed seven
 * issues, and a six-axis review of the merged range found ~26 real defects the
 * in-loop reviewer had passed. The recurring shape was a test that went green
 * without the feature working — a fixture changed to match the code, a
 * tolerance widened, a seam added to serialise a race instead of fixing it.
 * A Haiku reviewer does not ask "would this test still pass if I deleted the
 * feature?", which is the single question that catches all three.
 *
 * The reviewer must therefore be at least the implementer's tier. Post-merge
 * review was already Opus; it is the PER-ISSUE reviewer that was the hole.
 * The `critique` tier is a single-pass read-and-judge tier: since spec #1334
 * folded the design critique into the reviewer (so design rules now get the
 * reviewer's stronger model), its user is the check-writer. Sonnet is enough
 * there.
 *
 * This is paired with a mutation-check acceptance criterion added to the risky
 * tickets in the queue on the same date. Neither half works alone: the ticket
 * tells the implementer to prove the test can fail, the reviewer is what
 * checks that it did.
 */
/**
 * WHY EVERY OPUS ROLE IS OPUS 5.5 (2026-09-28)
 *
 * Opus 5.5 replaced both Opus 4.8 (the old default) and Opus 5 (the old top
 * rung). It is the stronger model AND the cheaper one ($4 / $20 per million
 * tokens against $5 / $25), so there is no rung above it to escalate to. The
 * escalation arrays keep their old LENGTHS on purpose: the length is the
 * number of retries a role gets, and this change is about the model, not the
 * retry count. A retry on the same model is not wasted — it runs on a fresh
 * context with the reviewer's feedback in hand.
 *
 * `--opus 5` (`opus5Models` below) is kept as the step back, for a night where
 * Opus 5.5 misbehaves: it has broader safety classifiers than Opus 5 (`bio`
 * and `reasoning_extraction` join `cyber`), so a refusal pattern is the
 * likeliest reason to reach for it.
 */
export const models = {
  implementer:       { default: "claude-opus-5-5", escalations: ["claude-opus-5-5", "claude-opus-5-5"] },
  reviewer:          { default: "claude-opus-5-5", escalations: ["claude-opus-5-5"] },
  critique:          { default: "claude-sonnet-5", escalations: [] },
  merger:            { default: "claude-opus-5-5", escalations: ["claude-opus-5-5"] },
  postMergeReviewer: { default: "claude-opus-5-5", escalations: ["claude-opus-5-5"] },
  postMergeFixer:    { default: "claude-opus-5-5", escalations: ["claude-opus-5-5"] },
  recovery:          { default: "claude-opus-5-5", escalations: ["claude-opus-5-5"] },
} as const satisfies Record<string, RoleConfig>;

/**
 * Codex backend model defaults. Selected by `--backend codex`, which
 * swaps the per-role fallback from `models` to this map. `gpt-5.5` is the
 * spike-verified default for codex-cli 0.139.0; `backendForModel` routes any
 * `gpt-*` / `*codex*` / `o[1-9]` id to `sandcastle.codex()`. Per-role tuning is
 * via Codex reasoning *effort* (CodexOptions.effort), not the model string, so
 * all roles share one model id for now; escalations are empty (no model-tier
 * retry ladder defined for Codex yet — a follow-up).
 */
export const codexModels = {
  implementer:       { default: "gpt-5.5", escalations: [] },
  reviewer:          { default: "gpt-5.5", escalations: [] },
  critique:          { default: "gpt-5.5", escalations: [] },
  merger:            { default: "gpt-5.5", escalations: [] },
  postMergeReviewer: { default: "gpt-5.5", escalations: [] },
  postMergeFixer:    { default: "gpt-5.5", escalations: [] },
  recovery:          { default: "gpt-5.5", escalations: [] },
} as const satisfies Record<keyof typeof models, RoleConfig>;

/**
 * Opus 5 profile (`--opus 5`), the step back from the Opus 5.5 default. NOT a
 * new backend/provider — this is the same
 * anthropic provider on the `claude` backend as `models`, differing ONLY by the
 * model string on the five opus-heavy roles (implementer, merger, post-merge
 * reviewer, post-merge fixer, recovery). `claude-opus-5` is the dateless
 * `claude-{name}-{major}` id and ships with a 1M-context window BY DEFAULT, so
 * there is no `[1m]` escalation tier for it — `escalations` is empty on those
 * roles. Reviewer runs on `claude-opus-5` in this profile — see the
 * 2026-08-02 note on `models.reviewer` for why the reviewer must not be a
 * weaker tier than the implementer. The `critique` tier (the check-writer's)
 * is Sonnet with no escalation.
 */
export const opus5Models = {
  implementer:       { default: "claude-opus-5", escalations: [] },
  reviewer:          { default: "claude-opus-5", escalations: ["claude-opus-5"] },
  critique:          { default: "claude-sonnet-5", escalations: [] },
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
 *   - implementer        → `claude-sonnet-5` first pass (the cheap try), then a
 *                          `claude-sonnet-5` "fix-it rung" (attempt 2, WITH the
 *                          reviewer's HAS_BLOCKERS feedback), then
 *                          `claude-opus-5-5` (attempt 3) — Opus reserved
 *                          for the round-3 grant
 *   - reviewer           → `claude-sonnet-5`, escalates to `claude-opus-5-5`
 *                          (the one place budget deliberately overspends — see
 *                          the 2026-08-02 note on `models.reviewer`)
 *   - critique           → `claude-sonnet-5`, no escalation (the check-writer's tier)
 *   - merger             → `claude-opus-5-5`, one retry on the same model
 *   - postMergeReviewer  → `claude-opus-5-5`, one retry on the same model
 *   - postMergeFixer     → `claude-sonnet-5`, escalates to `claude-opus-5-5`
 *   - recovery           → `claude-opus-5-5`, no escalation
 * The retry loops walk each `escalations` array by attempt number (see
 * `escalationForAttempt` in main.mts), so the ordering here defines the ladder.
 *
 * Budget is rejected in combination with `--opus 5`: the two flags express
 * CONTRADICTORY profiles (budget = cheapest-first, opus5 = Opus-5-everywhere)
 * and cannot both apply. See the parse-time guard in main.mts.
 */
export const budgetModels = {
  implementer:       { default: "claude-sonnet-5", escalations: ["claude-sonnet-5", "claude-opus-5-5"] },
  reviewer:          { default: "claude-sonnet-5", escalations: ["claude-opus-5-5"] },
  critique:          { default: "claude-sonnet-5", escalations: [] },
  merger:            { default: "claude-opus-5-5", escalations: ["claude-opus-5-5"] },
  postMergeReviewer: { default: "claude-opus-5-5", escalations: ["claude-opus-5-5"] },
  postMergeFixer:    { default: "claude-sonnet-5", escalations: ["claude-opus-5-5"] },
  recovery:          { default: "claude-opus-5-5", escalations: [] },
} as const satisfies Record<keyof typeof models, RoleConfig>;

/**
 * Launch-time Opus model profile selector (`--opus`). `"5.5"` is the default
 * (`models`); `"5"` is the step back (`opus5Models`). `"4.8"` was retired on
 * 2026-09-28 when Opus 5.5 became the default — nothing launched with it
 * explicitly, and naming the default after a model it no longer runs would lie.
 */
export type OpusProfile = "5.5" | "5";

export type ModelRole = keyof typeof models;
