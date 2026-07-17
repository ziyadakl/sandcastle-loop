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
  getIssueBody,
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
  LABEL_NEEDS_HUMAN,
  LABEL_QUARANTINE_LEGACY,
  LABEL_QUARANTINE_ALIAS,
  STATUS_LABELS,
} from "./gh.js";
export type {
  ReadyIssueSummary,
  LabelledIssueSummary,
  OpenIssueWithBody,
} from "./gh.js";

export { withPrdLock, withSingleInstance, acquireSingleInstanceLock } from "./locks.js";

// Cross-host issue lease (ADR 0019) — the real cross-host claim signal.
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

// Cross-host lane sync (ADR 0019) — the code-sharing substrate for two hosts.
export { createLaneSync, LaneSyncError } from "./lane-sync.js";
export type { LaneSyncResult, PeerMergeResult, LaneSyncOpts } from "./lane-sync.js";

// Cross-host CONVERGENCE (Workstream 3) — the operator "bring both machines to
// one point" command: merges every peer lane onto the run branch and pushes it.
export { convergeLanes } from "./converge.js";
export type { ConvergeOpts, ConvergeResult, LaneConvergeResult } from "./converge.js";

// Cross-host status sync (ADR 0020) — the fail-soft telemetry transport that
// fuses two hosts' status feeds into one viewer.
export { createStatusSync } from "./status-sync.js";
export type { StatusSyncOpts, PublishResult } from "./status-sync.js";

// Branch checkpoint / resume-on-pickup (ADR 0021) — WIP-ref primitives plus the
// pure sandbox-creation decision (`reuseOrFresh`) both worktree-add sites route
// through.
export {
  wipRef,
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

// Canonical GitRunner adapters (Quality #2 dedup) — the single home for the
// async (execFileAsync) and sync (execFileSync) git shell-out shapes the three
// former inline `makeGitRunner()` / `gitRunner` adapters hand-rolled.
export {
  makeExecFileGitRunner,
  makeSyncGitRunner,
} from "./git-runner-adapter.js";
