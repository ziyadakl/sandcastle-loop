/**
 * State track barrel — re-exports the user-land state machine surface.
 * Track C imports from here; nothing else should reach into the leaf modules.
 */

export {
  loadPrd,
  claimStory,
  pickNextEligibleStory,
  releaseStory,
  markDone,
  quarantineStoryInPrd,
} from "./prd.js";

export {
  configureGh,
  transitionLabel,
  closeIssue,
  defaultBranch,
  getIssueBody,
  getIssueSpec,
  getIssueClosure,
  parseSupersededBy,
  // V1 label-state-machine surface.
  listReadyIssues,
  listIssuesByLabel,
  listOpenIssuesWithBodies,
  claimViaLabel,
  markDoneViaLabel,
  markMergedToStagingViaLabel,
  promoteAllStagingToDone,
  quarantineViaLabel,
  releaseViaLabel,
  openDraftPr,
  postIssueComment,
  getPriorityFromLabels,
  isStatusLabel,
  isQuarantineLabel,
  // Wave 3 / M2 — pagination-limit WARN helper, shared across the gh
  // wrappers and the loop driver's in-progress sweep.
  warnIfHitLimit,
  LABEL_READY,
  LABEL_IN_PROGRESS,
  LABEL_DONE,
  LABEL_MERGED_TO_STAGING,
  LABEL_SHIPPED_LOCAL,
  LABEL_NEEDS_HUMAN,
  LABEL_QUARANTINE_LEGACY,
  LABEL_QUARANTINE_ALIAS,
  STATUS_LABELS,
  // The stop reasons (issue #914, Piece H; four more added by issue #923).
  ensureStopLabelsExist,
  applyStopReport,
  // Label-only, no body write (issue #923) — for the three stop sites whose
  // explanation is already a comment and must stay one.
  applyStopLabelOnly,
  // The screen-check record twin (issue #916) — body only, never a label.
  applyScreenCheckWatchReport,
  // The verdict — which side was wrong (issue #1117). Only its label creation
  // is re-exported, because `main.mts` calls that one through this barrel at
  // run startup. Everything else about verdicts, and EVERYTHING about the
  // check reading — what the judge made of the check before the builder
  // started (issue #1118) — is reached by importing `gh.js` / `verdict.js` /
  // `check-reading.js` directly, the way `scripts/verdict.mts` does. An
  // unused re-export is public surface somebody has to keep working, so
  // `ensureCheckReadingLabelsExist` is deliberately NOT listed here: its one
  // caller imports it from `gh.js`, which is the rule this comment states.
  ensureVerdictLabelsExist,
} from "./gh.js";
export type {
  ReadyIssueSummary,
  LabelledIssueSummary,
  OpenIssueWithBody,
  StopReportDeps,
} from "./gh.js";

// The stop reasons' pure half — Piece H's five (issue #914) and issue
// #923's four. Labels, the
// harness-verdict mapping, body-section rendering, and the two typed errors
// `main.mts` throws so its catch block can apply the right label without
// re-deriving it from a string prefix.
export {
  LOUD_STOP_REASONS,
  mapHarnessVerdictToStopReason,
  NEEDS_OWNER_DECISION_LABEL,
  ProtectedPathTamperStopError,
  ScreenCheckStopError,
  PIECE_H_STOP_REASON_LABELS,
  STOP_LABEL_DEFINITIONS,
  STOP_REASON_LABELS,
  reviewerRefusedExplanation,
  runFaultExplanation,
  stuckNoCommitsExplanation,
  buildScreenCheckWatchSection,
  buildStopBodySection,
  upsertScreenCheckWatchSection,
  upsertStopSection,
} from "./stop-reasons.js";
export type {
  DisagreementEvidence,
  ReviewerRefusalPath,
  ScreenCheckWatchReportInput,
  StopExplanation,
  StopReasonLabel,
  StopReportInput,
} from "./stop-reasons.js";

export { collectIssueRefs } from "./issue-refs.js";

// The `Blocked-by:` rule, as code (2026-09-03). Read by BOTH deciders: the
// plan (`eligible-set.ts`) and the deal-time re-check (`main.mts`).
export {
  BLOCKER_RESOLVING_LABELS,
  describeUnresolvedBlockers,
  parseBlockedBy,
  unresolvedBlockers,
} from "./blocked-by.js";
export type { OpenIssueLabels } from "./blocked-by.js";

// THE PLANNER ITSELF (2026-09-03). Not a gate over an agent's answer — the
// whole answer. See `eligible-set.ts`'s header for the two misreadings that
// ended the LLM planner.
export {
  buildEligibilityNote,
  eligibleForPlanning,
  planDeterministic,
  priorityRank,
} from "./eligible-set.js";
export type {
  DeterministicPlan,
  EligibleForPlanningOptions,
  OpenIssueRow,
  PlanDeterministicInput,
  PlannedCard,
  PlanningEligibility,
  PlanningExclusion,
} from "./eligible-set.js";

// The short-lived single-flight memo the blocked-by gate reads its 500-row
// open-issue listing through (`main.mts`). Its own module because the memo is
// the thing that keeps that gate from making nine identical `gh` calls in a
// few seconds, and it needs its own tests.
export { createMemo, OPEN_ISSUE_MEMO_TTL_MS } from "./open-issue-memo.js";
export type { Memo } from "./open-issue-memo.js";

// The owner-authored-part / fenced-code split, shared by the blocked-by parser
// and the check-writer's proof-demand gate.
export {
  MACHINE_SECTION_RE,
  ownerAuthoredPart,
  stripFencedCode,
} from "./issue-body-sections.js";

export { withPrdLock, withSingleInstance, acquireSingleInstanceLock } from "./locks.js";

// Cross-host issue lease — the real cross-host claim signal.
export {
  acquireLease,
  readLease,
  reclaimIfExpired,
  renewLease,
  releaseLease,
  createGitLockBackend,
  createLeaseCoordinator,
  classifyLease,
  resolveLeaseState,
  LeaseBackendError,
  LeaseReadError,
  LEASE_SKEW_GRACE_SEC,
} from "./issue-lease.js";
export type {
  LockLease,
  LockBackend,
  LockDeps,
  LeaseCoordinator,
  LeaseCoordinatorOpts,
  GitRunner,
  GitRunResult,
  GitLockBackendOpts,
} from "./issue-lease.js";

// Cross-host lane sync — the code-sharing substrate for two hosts.
export { createLaneSync, LaneSyncError } from "./lane-sync.js";
export type { LaneSyncResult, PeerMergeResult, LaneSyncOpts } from "./lane-sync.js";

// Cross-host CONVERGENCE (Workstream 3) — the operator "bring both machines to
// one point" command: merges every peer lane onto the run branch and pushes it.
export { convergeLanes, ConvergeError } from "./converge.js";
export type { ConvergeOpts, ConvergeResult, LaneConvergeResult } from "./converge.js";

// Cross-host status sync — the fail-soft telemetry transport that
// fuses two hosts' status feeds into one viewer.
export { createStatusSync } from "./status-sync.js";
export type { StatusSyncOpts, PublishResult } from "./status-sync.js";

// Branch checkpoint / resume-on-pickup — WIP-ref primitives plus the
// pure sandbox-creation decision (`reuseOrFresh`) both worktree-add sites route
// through.
export {
  wipRef,
  wipMirrorFetchRefspec,
  issueFromBranch,
  reuseOrFresh,
  resolveReuseDecision,
  hasWorktreeChanges,
  commitWorktreeCheckpoint,
  pushWipRef,
  wipRefExists,
  deleteWipRef,
  listWipRefIssues,
} from "./branch-checkpoint.js";

// Strand-backup data-safety primitives (Workstream 1) — pin stranded work to
// durable refs so a refused promotion never loses it, plus the full policy the
// loop runs on that refusal. STAGING_BRANCH lives here so state-layer code can
// name the staging branch without re-hardcoding the literal.
export {
  STAGING_BRANCH,
  strandRef,
  backupStrand,
  stagingCommitsAhead,
  handleStrandedPromotion,
} from "./strand-backup.js";
export type {
  StrandBackupOpts,
  StrandBackupResult,
  StrandedPromotionDeps,
  StrandedPromotionOpts,
} from "./strand-backup.js";

// Post-kill / --now checkpoint sweep — enumerate in-flight worktrees
// and persist+release each. `listInflightIssueWorktrees` has no heartbeat
// consumer (that wiring was removed, commit a4eab4b) — it's re-exported as
// part of this module's public surface, matching every sibling group in this
// barrel, and is consumed today by checkpoint-stop.ts:163 and by tests.
export {
  checkpointStop,
  listInflightIssueWorktrees,
  formatCheckpointStop,
} from "./checkpoint-stop.js";
export type {
  InflightWorktree,
  CheckpointStopResult,
  CheckpointStopOpts,
} from "./checkpoint-stop.js";

// Canonical GitRunner adapters (Quality #2 dedup) — the single home for the
// async (execFileAsync) and sync (execFileSync) git shell-out shapes the three
// former inline `makeGitRunner()` / `gitRunner` adapters hand-rolled.
export {
  DEFAULT_GIT_MAX_BUFFER_BYTES,
  makeExecFileGitRunner,
  makeSyncGitRunner,
} from "./git-runner-adapter.js";
