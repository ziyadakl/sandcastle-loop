/**
 * Runtime Zod schemas for every load-bearing agent verdict in the Sandcastle loop.
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
import { isGenericAssertionLine } from "./forbidden-lines.js";
import { findTestDatabaseUrlOverride } from "./test-command-db-guard.js";

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
 * Story-type enum mirroring {@link import("../types.js").StoryType}.
 *
 * Exported so callers (planner, driver, persistence layer) can import it
 * without re-deriving from a string literal union.
 */
export const StoryTypeSchema = z.enum(["ui", "backend-only", "infra"]);

// Wave 3 / M7 — the schema's assertion-line vacuousness check now imports
// from `./forbidden-lines.js`, which is the single source of truth shared with
// the reviewer prompt. The 9 forbidden patterns (empty, `Running N tests`,
// bare URL, `<paste line>`, `using N worker`, `Workers:`, `Slow test file`,
// `[chromium]` alone, bare words `passed`/`failed`/`all green`) live there.
//
// Pre-Wave-3 the schema covered 3 patterns and the reviewer prompt covered 9
// — vacuous lines passed the schema and were rubber-stamped. With this import
// the two stay in lockstep.

/**
 * Base shape of the implementer verdict before cross-field refinement. Kept
 * as a separate object schema so refinements can be layered on cleanly and
 * the inferred type matches {@link ImplementerOutput} 1:1 (the `Equals`
 * assertion at the bottom of this file enforces the match).
 */
const ImplementerOutputBaseSchema = z.object({
  // ---- legacy carry-over fields (now OPTIONAL) ----
  // implement-prompt.md only teaches the implementer to emit "the 7 fields"
  // of the structural certification + marker. These five carryover fields
  // were required by older tracks but no new-path code reads them, so they
  // were dead weight that just made parses fail. Validation still applies
  // (.min, .nonnegative, .enum) when they ARE present.
  storyId: z.string().min(1).optional(),
  ghIssue: z.number().int().nonnegative().optional(),
  commitSha: z.string().min(1).optional(),
  e2eVerdict: z.enum(["passed", "failed", "skipped", "halted"]).optional(),
  uiTouched: z.boolean().optional(),
  certificationPresent: z.boolean().optional(),
  marker: z.enum(["STORY_COMPLETE", "HALT", "RECOVERY_COMPLETE"]),
  haltReason: z.string().optional(),

  // ---- 7-question structural certification (NEW, all required) ----
  storyType: StoryTypeSchema,
  e2eRequired: z.boolean(),
  e2eActuallyRan: z.boolean(),
  testCommandUsed: z.string().min(1).nullable(),
  e2eAssertionLine: z.string().min(1).nullable(),
  outputNotFiltered: z.boolean(),
  testReachedFeature: z.boolean(),

  // ---- host-observed, NOT agent-authored (issue #1025) ----
  // The database this job's test run actually resolved to, read HOST-SIDE from
  // the run's stdout (`../db/observed-db.ts`) and written onto the certification
  // AFTER parse — never trusted from the agent. Optional so the agent is not
  // asked to emit it and a legitimately-skipped e2e (backend-only) leaves it
  // absent; when the host DOES observe a database, the driver compares it to the
  // clone it minted and refuses to certify green on a mismatch (the #1015 false
  // green). Recorded here so the observation lands in the certification the
  // reviewer and telemetry read, rather than being inferred after the fact.
  observedDatabase: z.string().min(1).nullable().optional(),

  // ---- host-decided, NOT agent-authored (issue #871, repair 3) ----
  // Whether the FINISHED diff touched a rendered surface, computed HOST-SIDE by
  // the driver from the actual changed files (`requiredProofForDiff` →
  // `demand === "browser"`, `./story-diff-enforcement.ts`) and stamped onto the
  // envelope AFTER parse. This is the wired `COMMIT_TOUCHED_UI`: the envelope
  // could not previously express the difference between what the story CALLED
  // itself (`storyType`/`e2eRequired`, self-reports) and what its own diff
  // actually touched. Carried so the reviewer and telemetry see both side by
  // side; the driver acts on a contradiction (a UI-touching diff certified as
  // needing no e2e) at the ship gate. Optional — absent on the paths that never
  // reach a measured ship diff.
  commitTouchedUi: z.boolean().optional(),
});

/**
 * Implementer verdict object. Mirrors {@link ImplementerOutput} in src/types.ts.
 *
 * The 7-question structural certification is encoded as required fields, and
 * cross-field validation enforces the rules the bash reference fork's reviewer
 * applies post-hoc — so a rubber-stamp attempt fails at PARSE time, before it
 * can reach the reviewer or be committed:
 *
 *   1. STORY_COMPLETE + `e2eRequired === true` ⇒ `testCommandUsed` MUST be
 *      non-null AND `e2eActuallyRan` MUST be true. Skipping the test or
 *      omitting the command is a hard rejection.
 *   2. STORY_COMPLETE + `e2eActuallyRan === true` ⇒ `e2eAssertionLine` MUST
 *      be non-empty AND MUST NOT match the generic preamble (`Running N
 *      tests`) or a bare URL pattern.
 *   3. `e2eActuallyRan === true` AND `outputNotFiltered === false` ⇒ marker
 *      MUST be HALT. Filtered output is auto-HALT — the reviewer cannot
 *      trust filtered evidence so the implementer is required to admit
 *      defeat. The rule is gated on a test having actually run, because the
 *      "did you filter the output" question is vacuous when no test ran
 *      (backend-only stories, HITL holds, etc.) — in that case the
 *      implementer should emit `outputNotFiltered: true` (vacuously true).
 *   4. HALT marker is the escape hatch: the soft fields (`testCommandUsed`,
 *      `e2eAssertionLine`) may be null even when `e2eRequired === true`,
 *      because the implementer is admitting they couldn't run / verify.
 *      `haltReason` SHOULD be present on HALT.
 */
export const ImplementerOutputSchema = ImplementerOutputBaseSchema.superRefine(
  (val, ctx) => {
    const isHalt = val.marker === "HALT";

    // Rule 3: filtered output ⇒ auto-HALT, but ONLY when a test actually ran.
    // If e2eActuallyRan=false (backend-only story, no spec, HITL hold) the
    // "did you filter the output" question is vacuous — there is no output to
    // filter — so we don't punish the implementer for emitting `false` there.
    // The implementer prompt instructs them to emit `true` (vacuously) when
    // no test ran; this gate is defensive in case they emit `false` instead.
    if (
      val.e2eActuallyRan === true &&
      val.outputNotFiltered === false &&
      !isHalt
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["marker"],
        message:
          "outputNotFiltered=false (implementer admitted filtering playwright " +
          "output before tee) requires marker=HALT — filtered evidence cannot " +
          "be trusted, so the verdict is auto-HALT.",
      });
    }

    // Rules 1-2 (and the #1025 override guard) only bite on the STORY_COMPLETE
    // / RECOVERY_COMPLETE path. HALT is the explicit escape hatch ("I gave up")
    // and lets soft fields be null, so we skip the strict checks below when the
    // marker is HALT.
    if (isHalt) return;

    // Issue #1025, guard 1: the test command MAY NOT set POSTGRES_URL or
    // DATABASE_URL itself. The loop already exports the job's own database clone
    // as POSTGRES_URL; a command that re-sets it points the run at a different
    // database than the grader reads (the #1015 false green — a green run
    // against plain `postgres` while the grader inspected the untouched clone).
    // Rejected at PARSE time so a STORY_COMPLETE built on a self-chosen database
    // never reaches the reviewer or a commit.
    const dbOverride = findTestDatabaseUrlOverride(val.testCommandUsed);
    if (dbOverride !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["testCommandUsed"],
        message:
          `testCommandUsed sets ${dbOverride.varName} itself ` +
          `(${dbOverride.assignment}). The loop already exports this job's own ` +
          `database clone as POSTGRES_URL — that value is authoritative. A ` +
          `command that overrides it (or scrapes a connection string from .env) ` +
          `runs the tests against a database the grader never reads, so a green ` +
          `run there certifies nothing. Remove the override and let the ` +
          `exported POSTGRES_URL stand, or switch the marker to HALT.`,
      });
    }

    // Rule 1: e2eRequired ⇒ testCommandUsed non-null AND e2eActuallyRan.
    if (val.e2eRequired) {
      if (val.testCommandUsed === null) {
        ctx.addIssue({
          code: "custom",
          path: ["testCommandUsed"],
          message:
            "e2eRequired=true but testCommandUsed is null. Either run the " +
            "spec's playwright command (and record it here verbatim) or " +
            "switch the marker to HALT.",
        });
      }
      if (val.e2eActuallyRan === false) {
        ctx.addIssue({
          code: "custom",
          path: ["e2eActuallyRan"],
          message:
            "e2eRequired=true but e2eActuallyRan=false. The spec mandates " +
            "playwright; a STORY_COMPLETE verdict requires the test to have " +
            "actually executed. Switch the marker to HALT if you couldn't " +
            "run it.",
        });
      }
    }

    // Rule 2: e2eActuallyRan ⇒ e2eAssertionLine non-empty AND not generic.
    if (val.e2eActuallyRan) {
      if (val.e2eAssertionLine === null) {
        ctx.addIssue({
          code: "custom",
          path: ["e2eAssertionLine"],
          message:
            "e2eActuallyRan=true but e2eAssertionLine is null. Quote the " +
            "exact assertion line from the playwright log that proves the " +
            "test reached its assertion.",
        });
      } else if (isGenericAssertionLine(val.e2eAssertionLine)) {
        ctx.addIssue({
          code: "custom",
          path: ["e2eAssertionLine"],
          message:
            "e2eAssertionLine is generic (matches the playwright preamble " +
            "'Running N tests' or a bare URL). Quote a line that starts " +
            "with ✓ / ✔ / PASS, contains 'expect(', or contains the test " +
            "description text — anything that PROVES the assertion ran.",
        });
      }
    }
  },
);

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
