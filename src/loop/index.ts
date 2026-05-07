/**
 * Public entry-point for Track C (orchestration loop). Track A's CLI driver
 * imports `runLoop` from here.
 */
export { runLoop } from "./run.js";
export type { RunLoopOptions } from "./run.js";
export {
  runIteration,
  fetchIssueBody,
  getDiffLineCount,
  hasOutputSuppression,
  appendProgress,
  readProgressTail,
  defaultIsIssueDone,
} from "./iteration.js";
export type {
  RunIterationArgs,
  IterationOutcome,
  AgentRunner,
} from "./iteration.js";
export {
  runImplementer,
  runReviewer,
  runFixer,
  runFinalReviewer,
  reviewerEffortForDiffSize,
} from "./agents.js";
export type {
  ImplementerCallArgs,
  ImplementerResult,
  ReviewerCallArgs,
  ReviewerResult,
  FixerCallArgs,
  FixerResult,
  FinalReviewerCallArgs,
  AgentRole,
} from "./agents.js";
export {
  buildImplementerBriefing,
  buildReviewerBriefing,
  buildFixerBriefing,
  buildRecoveryBriefing,
  formatIssueBlock,
  formatProgressBlock,
  _resetImplementerTemplateCache,
} from "./briefing.js";
export type { IssueRef } from "./briefing.js";
