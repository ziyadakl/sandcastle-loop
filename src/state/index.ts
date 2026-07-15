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
  transitionLabel,
  closeIssue,
  getIssueBody,
  // V1 label-state-machine surface.
  listReadyIssues,
  listIssuesByLabel,
  listOpenIssuesWithBodies,
  claimViaLabel,
  markDoneViaLabel,
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

export { withPrdLock, withSingleInstance } from "./locks.js";

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

// Cross-host status sync (ADR 0020) — the fail-soft telemetry transport that
// fuses two hosts' status feeds into one viewer.
export { createStatusSync } from "./status-sync.js";
export type { StatusSyncOpts } from "./status-sync.js";
