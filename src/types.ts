/**
 * Shared type contracts. Track B owns the runtime Zod schemas in src/verdicts/;
 * this file is interface-only so all tracks compile against the same shape
 * without a hard import-order dependency on Track B finishing first.
 *
 * Every load-bearing verdict in the loop is a typed object, never free-text grep.
 */

export type StoryStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "quarantined"
  | "needs_human";

export interface Story {
  id: string;
  title: string;
  status: StoryStatus;
  ghIssue?: number;
  attempts?: number;
  quarantinedAt?: string;
  quarantineReason?: string;
  /**
   * Bash-driver compatibility: the hostname (or other identifier) of the
   * worker that currently holds the story. Optional — older prd.json files
   * predate this field.
   */
  claimedBy?: string;
  /**
   * ISO-8601 timestamp recorded when the story was claimed. Optional for the
   * same reason as `claimedBy`.
   */
  claimedAt?: string;
  /**
   * IDs of stories that must reach `status === "done"` before this story is
   * eligible to be picked. Bash driver populated this; the TS port now honors
   * it in pickNextEligibleStory.
   */
  blockedBy?: string[];

  // ---- 7-question structural certification scaffold (NEW, all optional) ----
  // Stories carry an optional copy of the certification fields so the driver
  // can pre-compute story-level ground truth (`storyType`, `e2eRequired`)
  // before the implementer runs and so the post-run verdict can be persisted
  // back into prd.json for audit. See {@link ImplementerOutput} for the
  // canonical 7-question contract — these fields mirror it 1:1 but are all
  // optional here because a freshly-loaded story has none of them yet.
  /** Q1 — pre-computed by the planner / driver, or filled in post-run. */
  storyType?: StoryType;
  /** Q2 — driver greps the issue body for `playwright test`. */
  e2eRequired?: boolean;
  /** Q3 — copied from the implementer's verdict after a run. */
  e2eActuallyRan?: boolean;
  /** Q4 — copied from the implementer's verdict after a run. */
  testCommandUsed?: string | null;
  /** Q5 — copied from the implementer's verdict after a run. */
  e2eAssertionLine?: string | null;
  /** Q6 — copied from the implementer's verdict after a run. */
  outputNotFiltered?: boolean;
  /** Q7 — copied from the implementer's verdict after a run. */
  testReachedFeature?: boolean;
}

export interface PrdState {
  stories: Story[];
}

export type ModelTier = "haiku" | "sonnet" | "opus";

/**
 * Coarse classification of a story's surface area. Drives whether the
 * implementer is required to run playwright at all.
 *
 *   - "ui"            — touches user-facing surface (.tsx/.jsx/.vue under apps/
 *                       or packages/ui). e2e is mandatory if the spec includes
 *                       a `playwright test` command.
 *   - "backend-only"  — pure backend / API / DB / lib changes. Playwright is
 *                       N/A and the e2e checkboxes do not apply.
 *   - "infra"         — config, CI, scripts, tooling, migrations-only. Also
 *                       N/A on playwright but distinct from backend so the
 *                       reviewer can apply different scrutiny.
 */
export type StoryType = "ui" | "backend-only" | "infra";

/**
 * The 7-question structural certification, as required Zod fields. Modelled
 * after the e2e verification certification block in the bash reference fork
 * (`refs/afk-ralph.sh.local-fork`, lines ~135-149 and `refs/prompt.md.local-fork`
 * lines ~142-150). The implementer cannot rubber-stamp this by skipping fields:
 * each one is required, and cross-field validation in
 * {@link import("./verdicts/schemas.js").ImplementerOutputSchema} blocks
 * known evasion patterns.
 *
 * Existing fields preserved for backwards compatibility with other tracks:
 *   - `storyId`, `ghIssue`, `commitSha`, `e2eVerdict`, `uiTouched`,
 *     `certificationPresent`, `marker`, `haltReason`.
 *   - The legacy `e2eRan: boolean` was renamed to `e2eActuallyRan` so the
 *     name reflects what it actually means (question 3 below). Tracks that
 *     read `e2eRan` should migrate.
 */
export interface ImplementerOutput {
  // ---- legacy carry-over fields (now OPTIONAL) ----
  // See .sandcastle/lib/types.ts for the rationale (2026-05-08 smoke-test
  // prompt/schema mismatch). Mirrored here so src/ stays in sync.
  storyId?: string;
  ghIssue?: number;
  commitSha?: string;
  e2eVerdict?: "passed" | "failed" | "skipped" | "halted";
  uiTouched?: boolean;
  certificationPresent?: boolean;
  marker: "STORY_COMPLETE" | "HALT" | "RECOVERY_COMPLETE";
  haltReason?: string;

  // ---- 7-question structural certification (NEW, required) ----
  /** Q1: kind of story this is. Drives whether the e2e checkboxes apply. */
  storyType: StoryType;
  /**
   * Q2: does the spec mandate playwright? The driver pre-computes this by
   * grepping the issue body for `playwright test`; the implementer echoes
   * back the driver's pre-computed flag. Lying here is detectable because
   * the driver records its own value separately and the reviewer compares.
   */
  e2eRequired: boolean;
  /**
   * Q3: did the implementer ACTUALLY run the spec's playwright command in
   * this iteration (formerly `e2eRan`)? Not "did I intend to", not "would it
   * pass if I ran it" — did the command execute and produce a log.
   */
  e2eActuallyRan: boolean;
  /**
   * Q4: the exact command used. MUST match the spec's command verbatim when
   * `e2eRequired === true`. `null` is only valid when `e2eRequired === false`
   * or when the marker is HALT.
   */
  testCommandUsed: string | null;
  /**
   * Q5: a quoted assertion line from the playwright output. Must be
   * non-empty whenever `e2eActuallyRan === true`. The schema rejects the
   * known-generic placeholders ("Running N tests", bare URL lines) that
   * implementers have used historically to fake evidence.
   */
  e2eAssertionLine: string | null;
  /**
   * Q6: implementer attests they did NOT pipe playwright through any output
   * suppression filter (`grep -v`, `sed`, `awk`, `--quiet`, `> /dev/null`,
   * `2>/dev/null`, `--reporter=dot` when not specified) before tee. If
   * `false`, the verdict is auto-HALT — the reviewer cannot trust filtered
   * output.
   */
  outputNotFiltered: boolean;
  /**
   * Q7: did the test reach an assertion that exercises the actual feature?
   * Distinguishes "the test ran and passed" from "the test bailed at login
   * redirect / 401 / unapplied migration / pre-condition setup and reported
   * passed without exercising the user-facing behavior."
   */
  testReachedFeature: boolean;
}

export interface ReviewerVerdict {
  marker: "ALL_CLEAR" | "HAS_BLOCKERS";
  concerns: Array<{
    severity: "HARD" | "MEDIUM" | "SOFT" | "CLEAR";
    summary: string;
  }>;
}

export interface FixerVerdict {
  marker: "FIXED" | "BLOCKED";
  commitSha?: string;
  notes?: string;
}

export interface RecoveryDecision {
  marker: "RECOVERY_COMPLETE" | "HALT";
  fixApplied: boolean;
  commitSha?: string;
  haltReason?: string;
}

export interface IterationContext {
  iterNum: number;
  iterTotal: number;
  story: Story;
  branch: string;
  preSha: string;
  startedAt: number;
}

export interface IterationResult {
  story: Story;
  outcome: "shipped" | "skipped" | "quarantined" | "halted" | "circuit_break";
  iterationsUsed: number;
  finalCommitSha?: string;
  haltReason?: string;
}

export interface LoopConfig {
  repoRoot: string;
  maxIterations: number;
  consecutiveFailureLimit: number;
  agentTimeouts: {
    implementer: number;
    reviewer: number;
    fixer: number;
    recovery: number;
  };
  models: {
    implementer: ModelTier;
    reviewer: ModelTier;
    fixer: ModelTier;
    recovery: ModelTier;
    recoveryEscalated: ModelTier;
  };
}
