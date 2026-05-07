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
  claimViaLabel,
  markDoneViaLabel,
  quarantineViaLabel,
  postIssueComment,
  getPriorityFromLabels,
  isStatusLabel,
  isQuarantineLabel,
  LABEL_READY,
  LABEL_IN_PROGRESS,
  LABEL_DONE,
  LABEL_NEEDS_HUMAN,
  LABEL_QUARANTINE_LEGACY,
  LABEL_QUARANTINE_ALIAS,
  STATUS_LABELS,
} from "./gh.js";
export type { ReadyIssueSummary, LabelledIssueSummary } from "./gh.js";

export { withPrdLock, withSingleInstance } from "./locks.js";
