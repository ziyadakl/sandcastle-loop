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
} from "./lock.js";
export type {
  LockLease,
  LockBackend,
  LockDeps,
  GitRunner,
  GitRunResult,
  GitLockBackendOpts,
} from "./lock.js";
