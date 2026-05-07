/**
 * Runtime Zod schemas for every load-bearing agent verdict in the Ralph loop.
 *
 * Each schema's inferred type MUST match the corresponding interface in
 * src/types.ts exactly — types.ts is the contract shared with all five
 * tracks; this file is the runtime validator. A type-level assertion at the
 * bottom of this file guarantees the two stay in sync (the file fails to
 * compile if the shapes drift).
 */

import { z } from "zod";
import type {
  ImplementerOutput,
  ReviewerVerdict,
  FixerVerdict,
  RecoveryDecision,
} from "../types.js";

/** Severity ladder for reviewer concerns. */
export const ConcernSeveritySchema = z.enum([
  "HARD",
  "MEDIUM",
  "SOFT",
  "CLEAR",
]);

/** A single reviewer concern entry. */
export const ConcernSchema = z.object({
  severity: ConcernSeveritySchema,
  summary: z.string().min(1),
});

/**
 * Implementer verdict object. Mirrors {@link ImplementerOutput} in src/types.ts.
 * The implementer emits this as a JSON object inside an XML tag (per the
 * sandcastle Output.object pattern when we run with maxIterations === 1) OR as
 * a plain JSON object in the assistant text whose terminal marker line then
 * confirms the verdict. Either way Zod validates the shape.
 */
export const ImplementerOutputSchema = z.object({
  storyId: z.string().min(1),
  ghIssue: z.number().int().nonnegative(),
  commitSha: z.string().min(1).optional(),
  e2eRan: z.boolean(),
  e2eVerdict: z.enum(["passed", "failed", "skipped", "halted"]),
  uiTouched: z.boolean(),
  certificationPresent: z.boolean(),
  marker: z.enum(["STORY_COMPLETE", "HALT", "RECOVERY_COMPLETE"]),
  haltReason: z.string().optional(),
});

/** Reviewer verdict object. Mirrors {@link ReviewerVerdict} in src/types.ts. */
export const ReviewerVerdictSchema = z.object({
  marker: z.enum(["ALL_CLEAR", "HAS_BLOCKERS"]),
  concerns: z.array(ConcernSchema),
});

/** Fixer verdict object. Mirrors {@link FixerVerdict} in src/types.ts. */
export const FixerVerdictSchema = z.object({
  marker: z.enum(["FIXED", "BLOCKED"]),
  commitSha: z.string().min(1).optional(),
  notes: z.string().optional(),
});

/** Recovery decision object. Mirrors {@link RecoveryDecision} in src/types.ts. */
export const RecoveryDecisionSchema = z.object({
  marker: z.enum(["RECOVERY_COMPLETE", "HALT"]),
  fixApplied: z.boolean(),
  commitSha: z.string().min(1).optional(),
  haltReason: z.string().optional(),
});

/**
 * Compile-time guard: each Zod schema's inferred output type must be
 * assignable to (and from) the corresponding interface in src/types.ts.
 * If types.ts ever drifts from the schemas above, these lines fail to
 * compile and the bug is caught before runtime.
 *
 * The `Equals` helper expresses bidirectional assignability without using
 * `any` or runtime checks.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Each line below evaluates to `true` only when the schema and interface match.
// The `satisfies true` assertion forces a compile error on drift.
const _implementerOutputMatches: Equals<
  z.infer<typeof ImplementerOutputSchema>,
  ImplementerOutput
> = true;
const _reviewerVerdictMatches: Equals<
  z.infer<typeof ReviewerVerdictSchema>,
  ReviewerVerdict
> = true;
const _fixerVerdictMatches: Equals<
  z.infer<typeof FixerVerdictSchema>,
  FixerVerdict
> = true;
const _recoveryDecisionMatches: Equals<
  z.infer<typeof RecoveryDecisionSchema>,
  RecoveryDecision
> = true;

// Reference the guards so unused-locals rules don't strip them in strict mode.
// The values themselves are meaningless; the assignment is what enforces shape.
void _implementerOutputMatches;
void _reviewerVerdictMatches;
void _fixerVerdictMatches;
void _recoveryDecisionMatches;

/** Convenience inferred types for callers that don't want to import types.ts. */
export type ImplementerOutputParsed = z.infer<typeof ImplementerOutputSchema>;
export type ReviewerVerdictParsed = z.infer<typeof ReviewerVerdictSchema>;
export type FixerVerdictParsed = z.infer<typeof FixerVerdictSchema>;
export type RecoveryDecisionParsed = z.infer<typeof RecoveryDecisionSchema>;
