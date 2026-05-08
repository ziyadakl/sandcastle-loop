/**
 * Track B public surface. Track C imports from this barrel; nothing else
 * should reach into the underlying files directly.
 */

export {
  IMPLEMENTER_MARKERS,
  REVIEWER_MARKERS,
  FIXER_MARKERS,
  RECOVERY_MARKERS,
  ALL_MARKERS,
  HALT_PROMISE,
  canonicalizeMarker,
  stripDecoration,
} from "./markers.js";
export type {
  ImplementerMarker,
  ReviewerMarker,
  FixerMarker,
  RecoveryMarker,
  AnyMarker,
} from "./markers.js";

export {
  ConcernSeveritySchema,
  ConcernSchema,
  ImplementerOutputSchema,
  ReviewerVerdictSchema,
  FixerVerdictSchema,
  RecoveryDecisionSchema,
} from "./schemas.js";
export type {
  ImplementerOutputParsed,
  ReviewerVerdictParsed,
  FixerVerdictParsed,
  RecoveryDecisionParsed,
} from "./schemas.js";

export {
  extractMarker,
  extractAssistantText,
  parseVerdict,
  MarkerNotFoundError,
  VerdictParseError,
} from "./parse.js";
export type {
  MarkerMode,
  ExtractMarkerOptions,
  ParseVerdictOptions,
} from "./parse.js";
