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
}

export interface PrdState {
  stories: Story[];
}

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface ImplementerOutput {
  storyId: string;
  ghIssue: number;
  commitSha?: string;
  e2eRan: boolean;
  e2eVerdict: "passed" | "failed" | "skipped" | "halted";
  uiTouched: boolean;
  certificationPresent: boolean;
  marker: "STORY_COMPLETE" | "HALT" | "RECOVERY_COMPLETE";
  haltReason?: string;
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
