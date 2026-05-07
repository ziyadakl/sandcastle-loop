/**
 * Recovery track barrel — re-exports the Sonnet → Opus ladder and the
 * higher-level quarantine coordinator. Track C imports from here; nothing
 * else should reach into the leaf modules directly.
 */

export { runRecoveryLadder } from "./ladder.js";
export type {
  AttemptSummary,
  HaltContext,
  RecoveryLadderConfig,
  RecoveryLadderResult,
} from "./ladder.js";

export { quarantineStory } from "./quarantine.js";
export type { QuarantineStoryOptions } from "./quarantine.js";
