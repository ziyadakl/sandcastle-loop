/**
 * Shared type contracts. Track B owns the runtime Zod schemas in src/verdicts/;
 * this file is interface-only so all tracks compile against the same shape
 * without a hard import-order dependency on Track B finishing first.
 *
 * Every load-bearing verdict in the loop is a typed object, never free-text grep.
 */

export type StoryStatus = "pending" | "in_progress" | "done" | "quarantined";

export interface Story {
  id: string;
  title: string;
  status: StoryStatus;
  ghIssue?: number;
  attempts?: number;
  quarantinedAt?: string;
  quarantineReason?: string;
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
  outcome: "shipped" | "quarantined" | "halted" | "circuit_break";
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
