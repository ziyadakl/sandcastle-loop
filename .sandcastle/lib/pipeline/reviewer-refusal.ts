/**
 * The reviewer-refusal decision (issue #1217), read at the one refusal site
 * left after spec #1334: `runReviewRounds` in `main.mts`, which the builder's
 * review rounds and the fixer's review rounds both run through.
 *
 * ## What it decides (spec #1334)
 *
 * The judge that used to referee a refusal is gone. The HOST now reads the
 * reviewer's own `GROUNDS:` line (`lib/judge/grounds.ts`), and a refusal can
 * buy exactly one thing beyond an ordinary builder round: the first test's
 * single rewrite, when ALL three hold —
 *
 *   - the reviewer declared `GROUNDS: WRONG-CHECK` (this ticket's own first
 *     test contradicts the ticket, and the code is right);
 *   - the ticket has a first test of its own to rewrite;
 *   - the one rewrite has not already been spent on this ticket.
 *
 * Everything else is `refused`, and the caller takes its ordinary road: a
 * fix round while rounds remain, then the fixer; a fixer whose own rounds are
 * spent stops the ticket as `stopped:reviewer-refused`.
 *
 * This module is the pure half: it answers whether the rewrite runs. The
 * rewrite itself (`rewriteFirstTestOnce` in `main.mts`) dispatches the
 * test-writing AI and the reviewer, and the caller runs it on a `rewrite`
 * answer.
 */
import { parseReviewerGrounds, wrongCheckReasonIn } from "../judge/grounds.js";
import type { ReviewerGrounds } from "../judge/grounds.js";
import type { CheckLocation } from "../checkwriter/must-fail-first-receipt.js";
import type { FirstTestFallThrough } from "../state/first-test-fallthrough.js";

/**
 * Whether this ticket has a first test the rewrite could act on.
 *
 *   - `rewritable` — it has one, and the one rewrite is unspent.
 *   - `none` — the ticket has no first test of its own (it was built without
 *     one, or wrote no check at all), so a `WRONG-CHECK` has nothing to aim at.
 *   - `spent` — the one rewrite has already been used on this ticket.
 */
export type OwnTestState = "rewritable" | "none" | "spent";

/** Whether a refusal buys the first test's one rewrite. */
export type WrongCheckRewriteEligibility =
  /** No rewrite applies; the site takes its ordinary road. `why` is a
   *  plain-English sentence for the run log. */
  | {
      readonly kind: "refused";
      readonly grounds: ReviewerGrounds;
      readonly why: string;
    }
  /** Rewrite the first test once, briefed with the reviewer's own reason
   *  (empty when its `WRONG-CHECK` line gave none). */
  | { readonly kind: "rewrite"; readonly reason: string };

const NOT_WRONG_CHECK: Readonly<Record<Exclude<ReviewerGrounds, "reviewer-wrong-check">, string>> = {
  "reviewer-red-check": "the reviewer said a check went red against the code (GROUNDS: RED-CHECK)",
  "reviewer-no-check": "the reviewer's objection has no check behind it (GROUNDS: NO-CHECK)",
  unreadable: "the reviewer's GROUNDS line was missing or could not be read",
};

/** Read a refusing reviewer's output and decide whether the rewrite runs. */
export function wrongCheckRewriteEligibility(opts: {
  /** The refusing reviewer's raw output. */
  readonly reviewStdout: string;
  readonly ownTest: OwnTestState;
}): WrongCheckRewriteEligibility {
  const grounds = parseReviewerGrounds(opts.reviewStdout);
  if (grounds !== "reviewer-wrong-check") {
    return { kind: "refused", grounds, why: NOT_WRONG_CHECK[grounds] };
  }
  if (opts.ownTest === "none") {
    return {
      kind: "refused",
      grounds,
      why:
        "the reviewer said the first test is wrong, but this ticket has no " +
        "first test of its own to rewrite",
    };
  }
  if (opts.ownTest === "spent") {
    return {
      kind: "refused",
      grounds,
      why:
        "the reviewer said the first test is wrong, and its one rewrite was " +
        "already spent on this ticket",
    };
  }
  return { kind: "rewrite", reason: wrongCheckReasonIn(opts.reviewStdout) ?? "" };
}

/**
 * Whether this ticket's first test can still be rewritten (spec #1334).
 * `none` when it has no first test of its own — no check was written, or the
 * ticket is already going on without one — and `spent` once a reviewer's
 * `WRONG-CHECK` has used the one rewrite at any refusal site.
 */
export function ownFirstTestState(
  ctx: {
    readonly firstTestFellThrough?: FirstTestFallThrough;
    readonly firstTestRewriteSpent: { readonly current: boolean };
  },
  location: CheckLocation | undefined,
): OwnTestState {
  if (location === undefined || ctx.firstTestFellThrough !== undefined) return "none";
  return ctx.firstTestRewriteSpent.current ? "spent" : "rewritable";
}

/**
 * The brief the test-writing AI gets when the reviewer said its first test is
 * wrong (spec #1334). The reason is the reviewer's own, from its
 * `GROUNDS: WRONG-CHECK (…)` parenthetical, followed by the reviewer's own
 * one-line findings. Nothing here carries the application's output or the
 * figure the finished code produces.
 */
export function firstTestRewriteBrief(opts: {
  readonly reason: string;
  readonly findings: readonly string[];
}): string {
  return [
    "The reviewer read the finished code and your first test beside the",
    "ticket, and said the TEST — not the code — contradicts what the ticket",
    "asks for. You get exactly one rewrite.",
    "",
    "**The reviewer's reason, in its own words:**",
    opts.reason.trim().length > 0
      ? opts.reason.trim()
      : "(the reviewer gave no reason in its GROUNDS line)",
    ...(opts.findings.length > 0
      ? ["", "**The reviewer's findings:**", ...opts.findings]
      : []),
    "",
    "Rewrite the test IN PLACE — the same file, in this ticket's own check",
    "directory; a test moved anywhere else is refused — so it tests what the",
    "TICKET asks for. Read the ticket again first; where the reviewer and",
    "the ticket disagree, the ticket wins. The finished code is on disk, but it",
    "is not your answer key: the run proves your rewrite FAILS against the code",
    "the builder was handed and PASSES against the code it produced, so a test",
    "that only copies what the code does cannot pass that proof. Keep every",
    "case that is still right, and do not weaken an assertion to make it pass.",
  ].join("\n");
}
