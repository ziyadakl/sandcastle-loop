/**
 * Why the first reviewer is looking at work no build pass produced this
 * attempt (spec #1334, SG). Rendered into `{{REVIEW_SITUATION}}` on the first
 * review only — see {@link reviewSituationNotice}.
 */
export type ReviewSituation =
  /** Resumed from this ticket's own saved checkpoint, already finished. */
  | { readonly kind: "resumed-built"; readonly evidence: string }
  /** The test-writer read the change as already present in the code. */
  | {
      readonly kind: "already-built";
      readonly evidence: string;
      /** The ticket's committed slice was matched on `origin/main`. */
      readonly onMain: boolean;
    };

/**
 * The reviewer's notice for work no build pass produced this attempt (spec
 * #1334, SG). Without it the reviewer reads the missing certification
 * envelope — there was no build pass to write one — as ABSENT EVIDENCE and
 * spends a whole build round asking for paperwork.
 */
export function reviewSituationNotice(situation: ReviewSituation): string {
  const common =
    "No build pass ran this attempt, so there is NO certification envelope " +
    "and no e2e log from one. That absence is expected here and is NOT a " +
    "finding: skip the EXECUTION EVIDENCE, EVIDENCE QUOTE and CROSS-CHECK " +
    "CERTIFICATION sections, run the affected tests yourself, and grade the " +
    "code on every other category exactly as usual.";
  if (situation.kind === "resumed-built") {
    return (
      "THIS IS RESUMED, FINISHED WORK. The worktree was restored from this " +
      "ticket's own saved checkpoint, and the test-writing AI found the work " +
      "already finished. Review the whole branch diff as the ticket's " +
      "implementation. " +
      common +
      `

What the test-writing AI read:
${situation.evidence}`
    );
  }
  return (
    "THE TEST-WRITING AI SAYS THIS TICKET IS ALREADY BUILT" +
    (situation.onMain
      ? " (its committed slice was found on `origin/main`)"
      : " (the run could not confirm where)") +
    ". The diff may be EMPTY. Your job on this pass is to CONFIRM OR REFUTE " +
    "that: read the code this worktree holds against every acceptance " +
    "criterion in the ticket. If every one is met, emit ALL_CLEAR — the ticket " +
    "closes as done with nothing built. If any is not met, emit HAS_BLOCKERS " +
    "naming what is missing — a builder then builds it from your findings. " +
    common +
    `

What the test-writing AI read:
${situation.evidence}`
  );
}
