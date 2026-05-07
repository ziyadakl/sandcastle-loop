/**
 * Recovery track barrel — re-exports the diagnose-first ladder, the legacy
 * Sonnet → Opus ladder, and the higher-level quarantine coordinator. Track C
 * imports from here; nothing else should reach into the leaf modules
 * directly.
 *
 * The legacy `runRecoveryLadder` stays exported for callers that haven't
 * migrated to `runRecoveryDiagnosisOrEscalate` yet. New call sites should
 * prefer the diagnose-first variant — it skips the wasteful Sonnet→Opus
 * escalation when the halt cause is a known environment problem.
 */

export {
  runRecoveryLadder,
  runRecoveryDiagnosisOrEscalate,
} from "./ladder.js";
export type {
  AttemptSummary,
  HaltContext,
  RecoveryLadderConfig,
  RecoveryLadderResult,
} from "./ladder.js";

export { diagnoseHaltCause } from "./diagnose.js";
export type { Diagnosis, HaltCause } from "./diagnose.js";

export { quarantineStory } from "./quarantine.js";
export type { QuarantineStoryOptions } from "./quarantine.js";
