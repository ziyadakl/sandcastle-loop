/**
 * THE FIRST-TEST FALL-THROUGH (#1198 A) — the section the loop writes onto a
 * ticket it is building ANYWAY, after failing to produce a good first test.
 *
 * ## Why this exists at all
 *
 * The loop writes an independent test for a ticket BEFORE any code exists
 * (`runCheckWriterStage` in `main.mts`). When it could not make that test
 * good, it used to stop the ticket and write no code. Measured on the loop's
 * own records: that one stage caused 51 of 75 stops since 2 August 2026, and
 * in the last two runs 24 of 27 stops happened there with nothing spent on a
 * builder at all. When a builder DOES run, 91 of 119 attempts ship. Three
 * tickets the loop killed this way were built by hand afterwards and all
 * three passed review first try.
 *
 * Owner decision: when the first test cannot be made good, BUILD ANYWAY and
 * let the reviewer decide. The ticket ships only on the reviewer's pass and
 * carries the `shipped-without-first-test` label so the weaker proof is
 * visible on every such merge.
 *
 * ## Why the diagnosis still lands on the ticket
 *
 * The stop it replaces wrote a full explanation onto the issue BODY, and that
 * explanation is the only durable record of what went wrong with the check —
 * the host run log is wiped nightly. Dropping it because nothing stopped
 * would trade a stalled ticket for a silent one. So the same diagnosis is
 * still written, in a section of its own, with NO stop label: the ticket is
 * not held, it is being built on a weaker proof and saying so.
 *
 * ## Why the text is escaped
 *
 * `detail` is assembled from agent-authored strings (a check-writer's parse
 * error, a judge's reason, a classifier's verdict). Nothing stops that text
 * containing `-->`, which would close the marked-section HTML comment early
 * and spill the rest into the ticket's own prose, or a triple-backtick fence,
 * which would swallow everything after it into a code block. Both are
 * neutralized here, before the section is built — a builder that CAN produce
 * a body-corrupting string is a bug whether or not today's inputs trigger it.
 */

/**
 * The HTML-comment markers passed to `upsertMarkedSection` /
 * `readMarkedSection` (`lib/state/body-sections.ts`). Matched by
 * `proof-demand.ts`'s `MACHINE_SECTION_RE`, so nothing written here can be
 * read back as owner-authored permission to delete a test file.
 */
export const FIRST_TEST_FALLTHROUGH_SECTION_START =
  "<!-- sandcastle:first-test-fallthrough:start -->";
export const FIRST_TEST_FALLTHROUGH_SECTION_END =
  "<!-- sandcastle:first-test-fallthrough:end -->";

/**
 * WHICH of the three ways the first test failed to come out good. Each maps
 * to a stop this loop used to take, and the mapping is the whole vocabulary:
 *
 *   - `no-failing-check` — a check was written but never proven able to fail
 *     (it passed against untouched code, or could not be graded). Was
 *     `stopped:no-failing-check`.
 *   - `run-fault` — the loop's own machinery could not settle the question:
 *     the sandbox never produced evidence. Was `stopped:run-fault`.
 *
 *   - `test-disagreed` — the first test held up before the build, the
 *     reviewer then said the TEST (not the code) contradicts the ticket, the
 *     test-writing AI rewrote it once with the reviewer's reason, and the
 *     rewrite still could not be proved against the code (spec #1334). The
 *     ticket ships on the reviewer's pass. Was `stopped:reviewer-refused`.
 *
 *   - `already-built` — the test-writing AI found the change already in the
 *     code (or in this ticket's own resumed, finished work), so it wrote no
 *     test; the reviewer judged the existing code against the ticket (spec
 *     #1334, SG). Was `stopped:already-built`, an owner handoff.
 *
 *   - `red-at-ship` — the first test held up before the build, the reviewer
 *     passed the code, and the ship-time re-run of the test still came back
 *     red (or could not be graded). Recorded, never a stop (spec #1334): the
 *     ticket ships on the reviewer's pass.
 *
 * `weak-check` (a check the judge's early pass ruled too weak) is GONE with
 * that pass (spec #1334, SF1). Telemetry rows already on disk may still carry
 * it — `lib/status/schema.ts` keeps it in its own enum so they parse — but
 * nothing produces it any more.
 */
export type FirstTestFallThroughReason =
  | "no-failing-check"
  | "run-fault"
  | "test-disagreed"
  | "already-built"
  | "red-at-ship";

export interface FirstTestFallThrough {
  readonly reason: FirstTestFallThroughReason;
  /**
   * The diagnosis in the loop's own words — what it observed, in the same
   * detail the stop it replaces used to put on the ticket.
   */
  readonly detail: string;
}

export interface BuildFirstTestFallThroughOptions
  extends FirstTestFallThrough {
  readonly issueNumber: number;
  /** ISO date (`YYYY-MM-DD`), for the heading. */
  readonly date: string;
}

/**
 * One plain-English sentence per reason, in the owner's register: what went
 * wrong in the world, never the mechanism's name.
 */
const REASON_SENTENCE: Readonly<Record<FirstTestFallThroughReason, string>> = {
  // Deliberately covers BOTH shapes this reason is used for, because three
  // roads reach it and only one of them actually wrote a test: a test that
  // passed against untouched code, an envelope nobody could read, and a
  // practice world with no data to write a test against. Naming only the
  // first would tell the owner a test was written on two roads where none
  // ever was. The paragraph below says which of the three this ticket hit.
  "no-failing-check":
    "No test the loop could stand behind was produced for this ticket " +
    "before any code existed — either the one written passed against the " +
    "unchanged code, so it could never have caught the thing this ticket is " +
    "about, or no test could be written at all.",
  "run-fault":
    "The loop could not settle whether the test written for this ticket was " +
    "any good — the sandbox never produced a readable result.",
  "test-disagreed":
    "The reviewer said this ticket's first test, not its code, was wrong. " +
    "The test was rewritten once with the reviewer's reason, and the rewrite " +
    "still could not be shown to fail on the old code and pass on the new.",
  "already-built":
    "The test-writing AI found this ticket's change already in the code, so " +
    "it wrote no first test. The reviewer checked the existing code against " +
    "the ticket instead of a build being started from scratch.",
  "red-at-ship":
    "This ticket's first test failed before the build, as it should, but " +
    "when the loop ran it again on the finished code it did not come back " +
    "green. The reviewer passed the code, so the ticket shipped on that pass " +
    "and the test's result was recorded rather than trusted.",
};

/**
 * Neutralize the two sequences that would let agent-authored free text break
 * out of the HTML-comment markers or open an unterminated code fence: a
 * zero-width space inside each, so it renders identically to a human reader
 * and no longer matches the literal marker/fence pattern.
 */
function sanitize(text: string): string {
  return text
    .trim()
    .replace(/--(\s*)>/g, (_m, ws: string) => `--${ws}​>`)
    .replace(/```/g, "``​`");
}

/**
 * Build the marked-section markdown. Pure and total — the same inputs always
 * produce the same string, which is what lets the writer decide whether
 * anything actually changed rather than reasoning about it.
 */
export function buildFirstTestFallThroughSection(
  opts: BuildFirstTestFallThroughOptions,
): string {
  const detail = sanitize(opts.detail);
  return [
    `## Built without a first test — the loop, ${opts.date} (#1198)`,
    "",
    REASON_SENTENCE[opts.reason],
    "",
    "**Nothing is held.** The loop built this ticket anyway. The reviewer " +
      "read the finished code and ran the suites, and its pass is the only " +
      "thing that let this ship — so the proof behind this one is weaker " +
      "than behind a ticket whose first test held up. Merges that took this " +
      "route carry the `shipped-without-first-test` label.",
    "",
    "What the loop observed, in its own words:",
    "",
    detail.length > 0 ? detail : "(nothing recorded)",
    "",
    `If this ticket's behaviour matters enough to want a real test behind ` +
      `it, the thing to do is write one — not to re-queue #${opts.issueNumber}, ` +
      `which would rebuild code that already shipped.`,
  ].join("\n");
}
