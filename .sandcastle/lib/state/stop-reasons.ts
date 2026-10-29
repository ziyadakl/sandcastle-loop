/**
 * The ways a ticket stops — Piece H of
 * `docs/specs/2026-08-04-screen-check-design-lock.md` ("The ways a ticket
 * stops, and how they reach someone"). Five of them come from issue #914
 * and describe the check-writer and the harness; four more come from issue
 * #923 and describe the reviewer, the merge gates, and the run's own
 * machinery breaking; two more come from issue #1118 and describe what the
 * judge finds when it reads a ticket beside the check written for it.
 * Eleven in total — see {@link STOP_REASON_LABELS}.
 *
 * The loop's terminal write splits by CAUSE (issue #1150): a loop FAILURE
 * removes `in-progress` and adds `quarantine`; an owner/config handoff adds
 * `needs-human` instead. Either way it posts a COMMENT carrying the reason and
 * leaves the issue open (`lib/state/gh.ts`'s `quarantineViaLabel`). But the
 * terminal label is only the two-way split — it cannot say WHY a ticket
 * stopped. Five stop reasons through one terminal label would be five jobs
 * wearing one name — an agent triaging stopped tickets (the owner does not
 * read them himself) can only filter on a `stopped:*` LABEL, not on parsing
 * five different comment bodies.
 *
 * This module is the PURE half — labels, which ones are loud, how to render
 * the human-readable explanation that goes into the issue BODY (never a
 * comment — this repo's own rule is that state lives in the body), and the
 * two typed errors that carry a stop's full payload from the exact point in
 * `main.mts` that knows it (inside `shipAfterMigrations` /
 * `enforceProtectedPaths`) out to the one place that applies the label and
 * writes the record (`runIssuePipeline`'s catch block). `lib/state/gh.ts`
 * is the IMPURE half — it does the actual `gh` calls this module's output
 * feeds.
 *
 * The TERMINAL status label a stop carries is chosen by the split issue
 * #1150 introduced: a genuine LOOP FAILURE gets `quarantine`, and `needs-human`
 * is reserved for stops a PERSON or an interactive session must act on — an
 * owner/config handoff (see {@link QuarantineOpts} and, in `lib/state/gh.ts`,
 * `quarantineViaLabel` / `quarantineTerminalLabel`). Whichever terminal label
 * lands, a `stopped:*` label is ADDITIVE on top of it, never a replacement, and
 * both `quarantine` and `needs-human` keep a ticket that depends on this one
 * treated as still-blocked, by the one code path that decides what may be
 * worked (`unresolvedBlockers` in `./blocked-by.ts`, read by
 * `eligibleForPlanning` in `./eligible-set.ts` and by `blockedByGate` in
 * `.sandcastle/main.mts`).
 */

import type { HarnessVerdict } from "../harness/verdict.js";
import { upsertMarkedSection } from "./body-sections.js";
import { renderRefusalOutcomeCheckbox } from "./refusal.js";

/**
 * Every stop label, and the string values used EVERYWHERE this stop reason is
 * represented — the GitHub label name, the telemetry record's `label` field,
 * and the body section's heading all read this same literal. One spelling,
 * never a second mapping table to drift out of sync with it.
 *
 * **The first five are Piece H's original set** — every one of them is about
 * the CHECK-WRITER or the harness: the check did not fail, the ticket looks
 * already built, the check and the builder disagree, the locked check file
 * was edited, the page could not be graded.
 *
 * **The last four were added by issue #923** and are about a completely
 * different axis: the REVIEWER, the merge gates, and the run's own
 * machinery breaking. Seven `quarantine` call sites in `main.mts` carried no
 * label at all, so those stops were invisible to any count of what the run
 * did last night — measured at $1,011.63 of unrecorded stops over twelve
 * days.
 *
 * Folding them into one of the original five was refused deliberately: a
 * reviewer refusing on code quality is not "the check disagrees with the
 * builder", and filing it as such would make the disagreement count — the
 * one number the whole judge design rests on — a lie. #914 anticipated
 * exactly this split ("one label is being asked to mean five different
 * things… splitting the one label into a small set of honest ones may be
 * part of the answer").
 *
 * **The last two were added by issue #1118** — the judge, the agent that
 * reads the ticket beside the check written for it. Both are things nothing
 * in the run could previously say out loud, and neither fits any label above:
 *
 *   - `stopped:weak-check` — the check goes red on cue, so it is NOT
 *     `stopped:no-failing-check` (that one means the check could never go red
 *     at all, and is a quiet requeue). It simply asserts too little: delete
 *     the feature and the check stays green. Ticket #1078 (the screen for
 *     creating a new Team) reached `main` exactly that way — its check asked
 *     "was the request refused?" and never "was it refused by the permission
 *     gate?". The judge gets ONE repair attempt at it (issue #1118 acceptance
 *     11, on a budget of its own); this label means that attempt is spent.
 *   - `stopped:ticket-unclear` — the ticket itself never says what was
 *     wanted, so nothing can judge the check against it. It is NOT a
 *     disagreement: filing it as `stopped:check-disagreement` would add a
 *     phantom to the disagreement count, and siding with the check by default
 *     would silently make a vague ticket mean "the check always wins"
 *     (ruling 10). It is a real finding about how the ticket was WRITTEN, and
 *     it is only a finding if it stops.
 *
 * ## TWO OF THESE ARE RETIRED (#1198 A, 2026-09-03)
 *
 * `stopped:no-failing-check` and `stopped:weak-check` have NO PRODUCER any
 * more. Both named the same event — the loop could not make the first test
 * good — and that event no longer stops a ticket: it falls through and the
 * builder runs, with the diagnosis written to the issue body as a
 * `first-test-fallthrough` section and the merge labelled
 * `shipped-without-first-test`. The `firstTestFallThrough` counter on the
 * telemetry row (`lib/status/schema.ts`) is the successor to counting these
 * two labels.
 *
 * They stay in THIS list, and only in lists that READ:
 * `z.enum(STOP_REASON_LABELS)` in `lib/status/schema.ts` parses the durable
 * telemetry rows, 38 of which were written carrying one of these two before
 * #1198, and `CHECK_READING_STOP_LABELS` (`lib/state/check-reading.ts`)
 * queries tickets that still wear one. Removing the constants would make
 * that history unreadable, which is the opposite of what retiring a label
 * is for. They are gone from {@link STOP_LABEL_DEFINITIONS}, the list that
 * CREATES labels on GitHub, so nothing can resurrect a label the pipeline
 * no longer handles.
 */
export const STOP_REASON_LABELS = [
  /** @deprecated #1198 A — no producer. Read-only, for old records. */
  "stopped:no-failing-check",
  "stopped:already-built",
  "stopped:check-disagreement",
  "stopped:checks-tampered",
  "stopped:could-not-grade",
  "stopped:reviewer-refused",
  /** @deprecated #1334 — no producer: the design critique was folded into
   *  the reviewer. Read-only, for old records. */
  "stopped:critique-blocked",
  /** @deprecated #1334 SG — no producer: a missing record of a required
   *  skill run never stops a ticket. Read-only, for old records. */
  "stopped:skills-skipped",
  "stopped:run-fault",
  /** @deprecated #1198 A — no producer. Read-only, for old records. */
  "stopped:weak-check",
  "stopped:ticket-unclear",
] as const;

/** Piece H's original five — the check-writer/harness axis. Kept as its own
 *  list so a test can prove issue #923's four additions, and issue #1118's
 *  two, never silently changed one of the five the locked design already
 *  named. **Nothing is ever added here.** This list is a snapshot of the
 *  locked design, not a category anyone joins; the moment a later ticket's
 *  label is appended to it, it stops being able to prove the thing it
 *  exists to prove. */
export const PIECE_H_STOP_REASON_LABELS = [
  "stopped:no-failing-check",
  "stopped:already-built",
  "stopped:check-disagreement",
  "stopped:checks-tampered",
  "stopped:could-not-grade",
] as const;
export type StopReasonLabel = (typeof STOP_REASON_LABELS)[number];

/**
 * The three stops that carry an alarm (Piece H's "Loud?" column). Every
 * other stop is routine disposal, not an incident. No notification address
 * is set on any machine (issue #1107, deferred by owner decision
 * 2026-08-15), so the alarm today is a line in the run log.
 *
 * Since spec #1334 none of the three has a producer that stops a ticket on a
 * first-test problem: a first test that disagrees, is edited, or cannot be
 * graded ships on the reviewer's pass instead. The set stays so the old
 * records that wear one still render the same way.
 */
export const LOUD_STOP_REASONS: ReadonlySet<StopReasonLabel> = new Set([
  "stopped:check-disagreement",
  "stopped:checks-tampered",
  "stopped:could-not-grade",
]);

/** Reused, not re-created: `needs-owner-decision` already exists in this repo
 *  (description: "Business question only the owner can answer; non-technical.
 *  Never dispatchable."). Added beside the stop label for every stop in
 *  {@link OWNER_DECISION_STOP_REASONS}. */
export const NEEDS_OWNER_DECISION_LABEL = "needs-owner-decision";

/**
 * The stops that ALSO carry {@link NEEDS_OWNER_DECISION_LABEL} — the ones
 * nobody but the owner can settle. Kept as a named set rather than an `if`
 * inside `lib/state/gh.ts` so there is one spelling of the rule and a test
 * can pin it.
 *
 * One member: `stopped:ticket-unclear` — the ticket never said what was
 * wanted, and the agent that hit it names the exact product question in the
 * issue body. No agent can answer that; the issue body is what came up short.
 *
 * `stopped:check-disagreement` was a member until spec #1334: a first test
 * that disagrees with the build no longer stops a ticket at all (it ships on
 * the reviewer's pass, labelled `shipped-without-first-test`), so it is never
 * a question for the owner. The label stays parseable for old records.
 */
export const OWNER_DECISION_STOP_REASONS: ReadonlySet<StopReasonLabel> =
  new Set(["stopped:ticket-unclear"]);

/**
 * How one quarantine chooses its TERMINAL status label (issue #1150). The
 * default — no options — is `quarantine`, the loop-failure label. `needs-human`
 * is reserved for stops a PERSON or config must act on, and there are exactly
 * two ways to ask for it:
 *
 *   - `handoff: true` — this stop is an owner/config handoff outright, decided
 *     by the CALL SITE rather than by a stop label: the ticket was already
 *     built (verify-and-close), the practice world lacks the data the ticket
 *     needs, or a required rubric is not installed. A person or a config change
 *     unblocks it; the loop did not fail.
 *   - `stopLabel` — route the decision through
 *     {@link OWNER_DECISION_STOP_REASONS}. A stop only the owner can settle
 *     (`stopped:ticket-unclear`) → `needs-human`; every other stop
 *     (`stopped:run-fault`, `stopped:reviewer-refused`, …) → `quarantine`. One rule,
 *     the same set the body-section labeller reads, so the two can never drift.
 *
 * When both are present, `handoff: true` wins. Kept a single shared shape so
 * every re-wrapping of the `quarantine` dep (main.mts, strand-backup.ts)
 * forwards the same options without a second hand-copied inline type.
 */
export interface QuarantineOpts {
  readonly stopLabel?: StopReasonLabel;
  readonly handoff?: boolean;
}

/**
 * Every harness verdict `classifyHarnessRun` can return — the closed set
 * {@link mapHarnessVerdictToStopReason}'s switch below is written against.
 * This is the ONE place that list is spelled out for the could-not-grade
 * label description to iterate over; see {@link buildCouldNotGradeDescription}
 * for why iterating it (rather than hand-copying the four names into a
 * second string) is what keeps the label from re-drifting the way issue
 * #926 found it: the description said two causes while the switch already
 * mapped four.
 */
const ALL_HARNESS_VERDICTS: readonly HarnessVerdict[] = [
  "match",
  "graded-mismatch",
  "never-settled",
  "claim-mismatch",
  "environment-fault",
  "inconclusive",
];

/**
 * The plain-English phrase for each harness verdict that folds into
 * `stopped:could-not-grade` — deliberately a `Partial`, not a full
 * `Record<HarnessVerdict, string>`: `match` and `graded-mismatch` never
 * reach this bucket and must never need an entry here just to satisfy the
 * type. {@link buildCouldNotGradeDescription} is what turns "no entry" into
 * a loud failure instead of a silently-omitted cause.
 */
const COULD_NOT_GRADE_PHRASES: Partial<Record<HarnessVerdict, string>> = {
  "never-settled": "page never finished",
  "claim-mismatch": "wrong page",
  "environment-fault": "sign-in/app error",
  inconclusive: "no result",
};

/**
 * Builds the `stopped:could-not-grade` label description FROM
 * {@link mapHarnessVerdictToStopReason} itself, rather than a hand-written
 * sentence somebody has to remember to update — issue #926: the label said
 * "page never finished, or claimed the wrong view" (two causes) while the
 * switch below had already grown a third (`environment-fault`) and a
 * fourth (`inconclusive`) fold into the same bucket, so a broken sign-in
 * got filed under wording that only described a stuck page.
 *
 * Walks every verdict, asks the mapping function itself which bucket it
 * falls into, and collects the phrase for each one that lands in
 * could-not-grade. A verdict added to that fold without a matching entry
 * in {@link COULD_NOT_GRADE_PHRASES} throws HERE, at module load — every
 * test in this file (and every consumer that imports `STOP_LABEL_DEFINITIONS`)
 * fails immediately instead of shipping a description that quietly omits it.
 */
function buildCouldNotGradeDescription(): string {
  const phrases = ALL_HARNESS_VERDICTS.filter(
    (v) => mapHarnessVerdictToStopReason(v) === "stopped:could-not-grade",
  ).map((v) => {
    const phrase = COULD_NOT_GRADE_PHRASES[v];
    if (phrase === undefined) {
      throw new Error(
        `stop-reasons.ts: harness verdict "${v}" now maps to ` +
          `stopped:could-not-grade but COULD_NOT_GRADE_PHRASES has no plain-` +
          `English phrase for it — the label description would silently drop ` +
          `it. Add an entry for "${v}" to COULD_NOT_GRADE_PHRASES.`,
      );
    }
    return phrase;
  });
  const lead = phrases.slice(0, -1).join(", ");
  const last = phrases[phrases.length - 1];
  const causes = lead.length > 0 ? `${lead}, or ${last}` : last;
  return `Harness couldn't grade: ${causes}. App issue.`;
}

/**
 * The closing sentence the three comment-keeping stops share. One constant,
 * because five separate copies of the same sentence — three stop
 * explanations and two GitHub label descriptions — drift the moment one of
 * them is reworded.
 */
const POINTS_AT_ITS_COMMENT = "in a comment on this ticket";

/**
 * GitHub label metadata for EVERY stop label — Piece H's five (issue #914)
 * and issue #923's four.
 * Consumed by `ensureStopLabelsExist` (`lib/state/gh.ts`) — `gh label
 * create --force` is idempotent (creates if absent, updates color/description
 * if present), so calling this at every loop startup is safe and cheap, and
 * it is also how these labels were created for real in the repo before
 * this branch's first commit (`gh label list` proof in the PR description).
 *
 * Descriptions are held under GitHub's 100-character cap — `gh label
 * create` rejects longer ones with HTTP 422, discovered the hard way while
 * building this.
 */
export const STOP_LABEL_DEFINITIONS: ReadonlyArray<{
  readonly name: StopReasonLabel;
  readonly color: string;
  readonly description: string;
}> = [
  // `stopped:no-failing-check` USED to head this list. It was REMOVED by
  // #1198 A: nothing produces it any more (the loop builds anyway instead of
  // stopping), and a label GitHub keeps offering in its picker for a stop the
  // pipeline can no longer take is a label somebody eventually applies by
  // hand. The constant survives in `STOP_REASON_LABELS` so the 38 telemetry
  // rows that already carry it stay readable — see that list's doc comment.
  {
    name: "stopped:already-built",
    color: "0E8A16",
    description:
      "Check-writer reports this ticket looks already implemented. Verify by content and close.",
  },
  {
    name: "stopped:check-disagreement",
    color: "B60205",
    // Deliberately NOT "...after retries": on the MAIN ship path
    // (shipAfterMigrations) the harness check runs exactly once, on
    // finished code, with no retry round of its own (Piece F: "Known cost,
    // accepted") — "after retries" there would describe implementer/
    // reviewer rounds spent on unrelated review blockers, not on this
    // check. The label's wording says retries MAY have happened, not
    // "did", so it holds on every path.
    description:
      "Builder finished but the check disagrees with it. The owner breaks the tie.",
  },
  {
    name: "stopped:checks-tampered",
    color: "8B0000",
    description:
      "Builder edited the locked check file twice. Signals the lock isn't holding, not this ticket.",
  },
  {
    name: "stopped:could-not-grade",
    color: "D93F0B",
    description: buildCouldNotGradeDescription(),
  },
  // The four below are issue #923's additions — the reviewer/gate/run-fault
  // axis, not the check-writer axis. See STOP_REASON_LABELS' doc comment for
  // why they are not folded into one of the five above.
  {
    name: "stopped:reviewer-refused",
    color: "E99695",
    description:
      "Reviewer refused the finished code after every retry allowed. The most expensive stop there is.",
  },
  {
    name: "stopped:run-fault",
    color: "555555",
    description:
      "The run broke, not the ticket: a spinning builder, a crash, or a failed merge step.",
  },
  // Issue #1118 added TWO here — the judge's axis. Only one is left:
  // `stopped:weak-check` was REMOVED by #1198 A for the same reason
  // `stopped:no-failing-check` was, and by the same rule. A check the judge
  // rules too weak no longer stops the ticket; the builder runs and the merge
  // carries `shipped-without-first-test`. The constant survives in
  // `STOP_REASON_LABELS` for reading old records and for
  // `CHECK_READING_STOP_LABELS`, which still queries tickets wearing it.
  {
    name: "stopped:ticket-unclear",
    color: "A0522D",
    description:
      "The ticket never says what was wanted here, so no check can be judged against it.",
  },
];

/**
 * Map one of the harness's SIX verdicts (`lib/harness/verdict.ts` — the six
 * are listed in {@link ALL_HARNESS_VERDICTS}) to one of
 * Piece H's five stop labels — never one of issue #923's four, which are
 * about the reviewer and the run's own machinery, not the harness, and never
 * one of issue #1118's two, which the JUDGE decides and which are reached
 * before the harness has anything to grade. Returns
 * `undefined` for `"match"`, the one verdict that
 * ships instead of stopping.
 *
 * FOUR of the six harness verdicts fold into ONE label,
 * `stopped:could-not-grade`: `never-settled` (the page never declared
 * itself finished), `claim-mismatch` (it settled but claimed to be showing
 * something other than what the address asked for — an APP fault per Piece
 * E's own table), `environment-fault` (something failed before the check
 * ever reached a graded assertion at all — sign-in, navigation, an app
 * error), and `inconclusive` (the environment never produced evidence at
 * all, even after the one allowed re-run). Piece H names exactly FIVE
 * labels total, and `docs/specs/2026-08-04-screen-check-design-lock.md`
 * Piece E's own words for all four are variants of "the app is broken for
 * everyone, not this ticket's fault" — none of them is the builder's diff
 * being wrong, which is the ONE thing `stopped:check-disagreement` means.
 * `graded-mismatch` (the page settled, the claim matched, the figure did
 * not) is the sole occupant of `stopped:check-disagreement` — the one case
 * where "somebody is wrong and nobody inside the loop is allowed to say
 * who." **Overturned 2026-08-16: the judge (issue #1118) now says who, and
 * writes it onto the ticket. This label still means the same disagreement;
 * what changed is that it no longer has to wait for a morning that never
 * came.**
 *
 * `[ASSUMED: claim-mismatch, environment-fault and inconclusive all fold
 * into stopped:could-not-grade alongside never-settled]` — Piece H's table
 * listed exactly five labels total and gave no sixth for "app fault"
 * (issue #923 later added four on a different axis, none of them an app
 * fault, so this reasoning is untouched by them);
 * Piece E's own language for all of them is "the app is broken", never
 * "this ticket's diff is wrong". Documented here rather than left implicit
 * so a future reader can re-litigate it on purpose, not by accident.
 *
 * This is also the ONE place the fold is spelled out in prose — issue #926
 * found the GitHub label description undercounting this same fold (it said
 * two causes; the switch below already had four), because the description
 * was a hand-written sentence with nothing tying it back to this switch. The
 * label's own text is now derived FROM this function (see
 * `buildCouldNotGradeDescription`, above `STOP_LABEL_DEFINITIONS`), so this
 * comment is the only copy left to keep in sync by hand — update it if the
 * fold changes again.
 */
export function mapHarnessVerdictToStopReason(
  verdict: HarnessVerdict,
): StopReasonLabel | undefined {
  switch (verdict) {
    case "graded-mismatch":
      return "stopped:check-disagreement";
    case "never-settled":
    case "claim-mismatch":
    case "environment-fault":
    case "inconclusive":
      return "stopped:could-not-grade";
    case "match":
      return undefined;
  }
}

/** The evidence a `stopped:check-disagreement` record must carry on both
 *  sides — "the owner is the tie-breaker by design, so he cannot be handed
 *  only one side." All three are free text; nothing here is a proposed
 *  figure (the same "never propose the answer" discipline the check-writer's
 *  own schema enforces). */
export interface DisagreementEvidence {
  /** What the check demanded — the command, the screen, and the harness's
   *  own stated reason for the mismatch. */
  readonly checkDemanded?: string;
  /** What the builder produced — described from the SHIPPED diff the ship
   *  funnel actually measured, never from a claim. */
  readonly builderProduced?: string;
  /** The builder's own account of why it believes it is right — see the
   *  call site's doc comment for exactly what this is sourced from and why
   *  (an honest, bounded proxy, not a fabricated quote). */
  readonly builderAccount?: string;
}

/** Everything one stop needs to become a label, a telemetry record, and a
 *  body section — the shared input both `lib/state/gh.ts` (body rendering)
 *  and the durable record (`rework-record-input.ts`) build FROM, so the
 *  three surfaces can never independently drift about what happened. */
export interface StopReportInput {
  readonly label: StopReasonLabel;
  /** Human-readable explanation, in the owner's plain English — no ticket
   *  jargon, no bare issue numbers without saying what they are (repo
   *  convention). This is the text that becomes the issue body's stop
   *  section. */
  readonly detail: string;
  readonly disagreement?: DisagreementEvidence;
  readonly runId: string;
  readonly whenIso: string;
}

/** The stop-report block's opening marker. Exported because a caller needs
 *  to ask "does this body already carry a stop section?" and a second
 *  hand-copied spelling of the literal is a reader that never finds what
 *  the writer wrote. */
export const STOP_SECTION_START = "<!-- sandcastle:stop-report:start -->";
const SECTION_START = STOP_SECTION_START;
const SECTION_END = "<!-- sandcastle:stop-report:end -->";

const STOP_LABEL_TITLES: Record<StopReasonLabel, string> = {
  "stopped:no-failing-check": "Stopped: no failing check",
  "stopped:already-built": "Stopped: already built",
  "stopped:check-disagreement": "Stopped: check disagreement",
  "stopped:checks-tampered": "Stopped: checks tampered with",
  "stopped:could-not-grade": "Stopped: could not grade",
  "stopped:reviewer-refused": "Stopped: the reviewer refused the code",
  "stopped:critique-blocked": "Stopped: the critique gate blocked the merge",
  "stopped:skills-skipped": "Stopped: the builder skipped required skills",
  "stopped:run-fault": "Stopped: the run itself broke",
  "stopped:weak-check": "Stopped: the check proves too little",
  "stopped:ticket-unclear": "Stopped: the ticket doesn't say what was wanted",
};

/**
 * Render the markdown that goes BETWEEN the section markers in the issue
 * body — never the whole body, and never a comment. Pure string-building,
 * no IO; `lib/state/gh.ts` handles the fetch-modify-write around it.
 */
export function buildStopBodySection(input: StopReportInput): string {
  const lines: string[] = [
    `## ${STOP_LABEL_TITLES[input.label]}`,
    "",
    `**Label:** \`${input.label}\`${LOUD_STOP_REASONS.has(input.label) ? " (loud — an alarm was raised)" : ""}`,
    `**When:** ${input.whenIso}`,
    `**Run:** ${input.runId}`,
    "",
    input.detail,
  ];
  if (input.disagreement !== undefined) {
    lines.push(...renderDisagreementLines(input.disagreement));
  }
  return lines.join("\n");
}

/** The both-sides block, shared verbatim by the stop section and the
 *  watch-only observation section — the owner must be handed the same two
 *  sides whether the check stopped the ticket or merely watched it. */
function renderDisagreementLines(d: DisagreementEvidence): string[] {
  return [
    "",
    "**What the check demanded:**",
    d.checkDemanded ?? "(not recorded)",
    "",
    "**What the builder produced:**",
    d.builderProduced ?? "(not recorded)",
    "",
    "**The builder's own account:**",
    d.builderAccount ?? "(not recorded)",
    "",
    "**Which side was wrong:** see the **Verdict** block on this ticket. It " +
      "is absent unless someone writes one in " +
      "by hand.",
  ];
}

const WATCH_SECTION_START = "<!-- sandcastle:screen-check-watch:start -->";
const WATCH_SECTION_END = "<!-- sandcastle:screen-check-watch:end -->";

/**
 * Everything ONE red screen-check observation needs to become an issue body
 * section (issue #916; since spec #1334 the only screen-check outcome). Deliberately NOT a {@link StopReportInput}: this
 * ticket did not stop, carries no stop label, and must never be counted as a
 * stop by anything reading the body.
 */
export interface ScreenCheckWatchReportInput {
  readonly verdict: HarnessVerdict;
  readonly screen?: string;
  /** Human-readable explanation, distinct per verdict — one piece of text,
   *  not paraphrased twice into two surfaces. */
  readonly detail: string;
  readonly disagreement?: DisagreementEvidence;
  /**
   * `wouldHaveStoppedAs` is the stop label this verdict used to carry before
   * spec #1334 made every red screen check a record instead of a stop. Kept
   * so a reader can tell the five kinds of red apart at a glance.
   */
  readonly wouldHaveStoppedAs?: StopReasonLabel;
  readonly runId: string;
  readonly whenIso: string;
}

/**
 * Render the markdown for a red screen-check observation. Pure string-building;
 * `lib/state/gh.ts` handles the fetch-modify-write, and — crucially —
 * applies NO label around it.
 */
export function buildScreenCheckWatchSection(
  input: ScreenCheckWatchReportInput,
): string {
  const lines: string[] = [
    "## Screen check: the check did not agree",
    "",
    "**This ticket was NOT stopped.** A red screen check is recorded and",
    "flagged but does not hold anything back (spec #1334). The code below",
    "shipped; the reviewer's pass was the gate.",
    "",
    `**Verdict:** \`${input.verdict}\``,
    `**Screen:** ${input.screen ?? "(not stated)"}`,
    `**Old stop label:** \`${input.wouldHaveStoppedAs ?? "(not recorded)"}\` (the stop this verdict caused before spec #1334)`,
    `**When:** ${input.whenIso}`,
    `**Run:** ${input.runId}`,
    "",
    input.detail,
  ];
  if (input.disagreement !== undefined) {
    lines.push(...renderDisagreementLines(input.disagreement));
  }
  return lines.join("\n");
}

/**
 * Insert or REPLACE the stop-report section inside `body`. Re-stopping the
 * same ticket updates the section in place rather than appending a second
 * one — "make re-stopping the same ticket update rather than endlessly
 * append" (the ticket's own instruction). Everything outside the markers is
 * preserved byte-for-byte; this never clobbers the rest of the issue body.
 *
 * Pure and total: `body` may be empty (a brand-new issue), may already carry
 * a section from an earlier stop, or may carry unrelated human-written
 * content above/below — all three are handled.
 */
export function upsertStopSection(body: string, section: string): string {
  return upsertMarkedSection(body, SECTION_START, SECTION_END, section);
}

/**
 * The screen-check-record twin of {@link upsertStopSection}, on its OWN markers so the
 * two can coexist in one body and neither ever overwrites the other — a
 * ticket can be watched on one night and stopped on another, and both facts
 * have to survive.
 */
export function upsertScreenCheckWatchSection(
  body: string,
  section: string,
): string {
  return upsertMarkedSection(
    body,
    WATCH_SECTION_START,
    WATCH_SECTION_END,
    section,
  );
}

/**
 * Thrown from `shipAfterMigrations` (issue #912's harness gate) instead of a
 * generic `Error`, so `runIssuePipeline`'s catch block can apply the right
 * label and durable record WITHOUT re-deriving the verdict from a string
 * prefix. Carries `postSha` — the commit being shipped when the harness
 * ran — because `runIssuePipeline`'s catch block has no other way to reach
 * it (`postSha` there is scoped inside the `try`, not the function). Without
 * this, the rework-store record would be silently dropped (it requires a
 * non-empty `shippedSha` — see `rework-store.ts`'s own doc comment on why a
 * bare `HALT` quarantine with no sha is "correctly dropped").
 */
export class ScreenCheckStopError extends Error {
  readonly stopReasonLabel: StopReasonLabel;
  readonly verdict: HarnessVerdict;
  readonly postSha: string;
  readonly screen: string | undefined;
  readonly disagreement: DisagreementEvidence | undefined;

  constructor(opts: {
    readonly message: string;
    readonly verdict: HarnessVerdict;
    readonly postSha: string;
    readonly screen?: string;
    readonly disagreement?: DisagreementEvidence;
  }) {
    super(opts.message);
    this.name = "ScreenCheckStopError";
    const label = mapHarnessVerdictToStopReason(opts.verdict);
    // `"match"` never throws (shipAfterMigrations only reaches this
    // constructor on a non-match verdict), so this is unreachable in
    // practice; falling back to `could-not-grade` (rather than throwing a
    // second, unrelated error out of an error constructor) keeps this class
    // total the same way every `lib/telemetry/` setter promises to be.
    this.stopReasonLabel = label ?? "stopped:could-not-grade";
    this.verdict = opts.verdict;
    this.postSha = opts.postSha;
    this.screen = opts.screen;
    this.disagreement = opts.disagreement;
  }
}

/**
 * Thrown from `enforceProtectedPaths` (issue #909's protected-path lock)
 * instead of a generic `Error`, for the same reason as
 * {@link ScreenCheckStopError}: `runIssuePipeline`'s catch block needs the
 * shipped sha and cannot see it any other way. Covers all four ways that
 * function refuses to ship a tampered diff (twice-tampered, unrestorable, or
 * a restore that failed to write or failed to commit) — all four are the
 * SAME `stopped:checks-tampered` label; the split between them survives only
 * in `message`, for a human reading the log.
 */
export class ProtectedPathTamperStopError extends Error {
  readonly stopReasonLabel: StopReasonLabel = "stopped:checks-tampered";
  readonly postSha: string;
  readonly nth: number;
  readonly violations: readonly string[];

  constructor(opts: {
    readonly message: string;
    readonly postSha: string;
    readonly nth: number;
    readonly violations: readonly string[];
  }) {
    super(opts.message);
    this.name = "ProtectedPathTamperStopError";
    this.postSha = opts.postSha;
    this.nth = opts.nth;
    this.violations = opts.violations;
  }
}

/**
 * Thrown from `shipAfterMigrations` (the one ship gate, for the builder and
 * the fixer alike) when the FINISHED diff owes more proof than the
 * check-writer's outcome offers, or when it DELETES test coverage — the two
 * ways the ship-time proof router (`lib/checkwriter/proof-demand.ts`) refuses
 * a ticket.
 *
 * RENAMED from `NoScreenAppliesViolatedStopError` by issue #956, because the
 * old name described a gate that only ever fired under one marker. It now
 * fires under every one of them, and the second of its two reasons is the
 * reason it had to:
 *
 *   - UNDER-PROVED. `requiredProofForDiff` reads the finished diff and returns
 *     the STRONGEST proof any single changed file demands — `browser` for
 *     anything that can put different pixels in front of a person, `unit` for
 *     anything else inside `apps/**`/`packages/**`, `none` outside them.
 *     `proofOfferedByMarker` says what this outcome actually proves. A
 *     photograph satisfies a unit demand; a unit test never satisfies a
 *     photograph demand; neither is satisfied by nothing.
 *   - COVERAGE REMOVED. A diff that deletes or empties a test file under
 *     `apps/**` or `packages/**` stops the ticket under EVERY marker, not just
 *     the no-proof one. Passing the one check this ticket wrote proves nothing
 *     about the coverage the same diff removed — the protected-path lock covers
 *     only this issue's own check directory, the ship-time run executes only
 *     the ONE check file, and `verifyTestRun` runs vitest, whose include is
 *     `src/**`, so a deleted Playwright spec goes green by being absent.
 *
 * BEFORE THIS CLASS EXISTED, the gate threw a plain `Error`. `Error` has
 * no `instanceof` arm in `runIssuePipeline`'s catch block the way
 * {@link ScreenCheckStopError} and {@link ProtectedPathTamperStopError} do,
 * so it fell all the way through to the opt-in recovery pass — a ticket
 * whose own check-writer said "no screen applies" could ship WITH NO
 * SCREEN CHECK AT ALL, on a diff that visibly needed one, via a recovery
 * agent's `RECOVERY_COMPLETE` (issue #914 finding).
 *
 * `[ASSUMED: labelled stopped:check-disagreement]` — REUSED, not added to.
 * Piece H's table spells no sixth label for either of these cases, and the
 * shape matches both: "somebody is wrong and nobody inside the loop is allowed
 * to say who" (overturned 2026-08-16 — the judge says who; issue #1118) —
 * either the check-writer offered the wrong proof and the diff
 * proves it, or the builder touched more than the ticket needed to; either the
 * deleted test was dead weight or it was the coverage that made everything
 * else safe. That is precisely the "tie goes to the owner" case Piece H
 * describes for `check-disagreement`, and unlike the harness's four
 * could-not-grade verdicts (an app/environment fault, no diff to weigh) there
 * IS a diff here worth a human's eye. Documented here, as
 * `mapHarnessVerdictToStopReason` documents its own judgment call, so a future
 * reader can re-litigate it on purpose.
 */
export class ProofDemandUnsatisfiedStopError extends Error {
  readonly stopReasonLabel: StopReasonLabel = "stopped:check-disagreement";
  readonly postSha: string;
  /**
   * The exact files that forced the stop, and only those — the diff's
   * screen-or-flow touches for an unmet `browser` demand, its product touches
   * for an unmet `unit` one, or the removed test files. A stop message that
   * gestured at the whole diff is one nobody can act on.
   */
  readonly touchedPaths: readonly string[];
  /**
   * The both-sides block for the issue body, built where the refusal was
   * decided — never re-derived by the catch block that reports it.
   *
   * It used to be re-derived, and it said only "NO_SCREEN_APPLIES (the
   * check-writer's declaration)" no matter what actually happened. With three
   * distinct refusals now sharing one class (coverage removed, proof too weak,
   * a marker that should never have reached a ship path) a re-derived block
   * would describe the wrong one two times out of three — and the owner is the
   * tie-breaker by design, so he cannot be handed the wrong side. Matches
   * {@link ScreenCheckStopError}, which already carries its own.
   */
  readonly disagreement: DisagreementEvidence | undefined;

  constructor(opts: {
    readonly message: string;
    readonly postSha: string;
    readonly touchedPaths: readonly string[];
    readonly disagreement?: DisagreementEvidence;
  }) {
    super(opts.message);
    this.name = "ProofDemandUnsatisfiedStopError";
    this.postSha = opts.postSha;
    this.touchedPaths = opts.touchedPaths;
    this.disagreement = opts.disagreement;
  }
}

/**
 * Thrown from BOTH ship funnels (`shipAfterMigrations` on the main path and the
 * rescue ladder) when the GRADED harness run cannot be proven to have used the
 * per-job database clone the loop minted for this issue (issue #1025, review
 * blocker 2). Two shapes, both carried in `message`:
 *
 *   - the run demonstrably touched a database OTHER than the clone; or
 *   - a green browser check produced NO database name at all, so the loop
 *     cannot prove which database decided the ship, and fails closed rather than
 *     certify green on zero evidence.
 *
 * TYPED, like {@link ScreenCheckStopError} and
 * {@link ProofDemandUnsatisfiedStopError} beside it, for the SAME two reasons:
 * `runIssuePipeline`'s catch needs the shipped `postSha` (its own is scoped
 * inside the `try`), and — without a dedicated `instanceof` arm — a bare `Error`
 * would be handed to the fixer, which would burn a whole fix pass and its
 * review rounds on a DETERMINISTIC wrong-database failure that a rerun cannot
 * fix. A typed stop quarantines immediately instead.
 *
 * `stopped:could-not-grade` — a wrong (or unprovable) database is a
 * WIRING/ENVIRONMENT fault, not a builder-vs-check content dispute: the loop
 * could not trust the grade of this ticket's isolation, which is exactly what
 * that loud, no-owner-decision label already means (it is in
 * `LOUD_STOP_REASONS`).
 */
export class WrongTestDatabaseStopError extends Error {
  readonly stopReasonLabel: StopReasonLabel = "stopped:could-not-grade";
  readonly postSha: string;
  readonly disagreement: DisagreementEvidence | undefined;

  constructor(opts: {
    readonly message: string;
    readonly postSha: string;
    readonly disagreement?: DisagreementEvidence;
  }) {
    super(opts.message);
    this.name = "WrongTestDatabaseStopError";
    this.postSha = opts.postSha;
    this.disagreement = opts.disagreement;
  }
}

/**
 * Thrown from `runCheckWriter` (2026-08-04 review finding #2, BLOCKER) when
 * the check-writer's OUTCOME MARKER (the last non-empty line, extracted by
 * `extractMarker`) disagrees with its own JSON ENVELOPE's `marker` field
 * (extracted separately by `parseVerdict`, from a fenced ```json``` block).
 *
 * Both are pulled from the SAME raw agent output by two independent passes,
 * and — before this class existed — nothing ever compared them. A
 * mismatch (e.g. the last line says `CHECKS_WRITTEN` but the envelope block
 * says `NO_SCREEN_APPLIES`) is silent and severe: `runCheckWriterStage`
 * branches on the LINE marker everywhere (`result.marker === "..."`) while
 * every PAYLOAD field (`checkPath`, `screen`, `noScreenReason`, …) comes
 * from the envelope — so a `CHECKS_WRITTEN` line paired with a
 * `NO_SCREEN_APPLIES` envelope yields `checkCommand: undefined` (the
 * envelope has no `checkPath`) AND `noScreenApplies: false` (computed from
 * the LINE marker, which isn't `NO_SCREEN_APPLIES`) — switching OFF both
 * ship-time gates (`shipAfterMigrations`'s no-screen re-check AND its
 * harness gate) simultaneously, on one ticket, with nothing left to catch
 * it. Made MORE reachable, not less, by `parseVerdict`'s own documented
 * fallback: on a last-block schema-validation failure it tries EARLIER
 * fenced blocks, so a stale draft envelope for a different marker can win
 * over the final line the agent actually meant.
 *
 * NOT thrown for the one pair the loop can settle itself (2026-09-10): the
 * two "written" markers (`CHECKS_WRITTEN` / `UNIT_CHECK_WRITTEN`) over each
 * other. #1249 and #1235 both died on that pair in one run with $0 of builder
 * spend — a self-consistent unit envelope closed by the browser marker's name
 * on the last line. `reconcileCheckWriterMarkers` (`lib/checkwriter/
 * schema.ts`) resolves it to the envelope with a warning; this error is for a
 * disagreement between two DIFFERENT outcomes, where neither side's payload
 * can stand in for the other's.
 *
 * `[ASSUMED: labelled stopped:check-disagreement]` — same reasoning
 * {@link ProofDemandUnsatisfiedStopError} documents for its own identical
 * judgment call: Piece H names no sixth label for "the check-writer's own
 * output disagreed with itself", but the shape matches exactly — nobody
 * inside the loop is positioned to say which of the two readings is the
 * one the agent meant, so the tie goes to the owner, loudly (this label is
 * in `LOUD_STOP_REASONS`), rather than the quiet `stopped:no-failing-check`
 * requeue an ordinary malformed-envelope parse failure gets.
 */
export class CheckWriterMarkerEnvelopeMismatchError extends Error {
  readonly stopReasonLabel: StopReasonLabel = "stopped:check-disagreement";
  readonly lineMarker: string;
  readonly envelopeMarker: string;

  constructor(opts: {
    readonly lineMarker: string;
    readonly envelopeMarker: string;
  }) {
    super(
      `check-writer-marker-envelope-mismatch: the outcome marker on the ` +
        `last line said "${opts.lineMarker}" but the parsed JSON envelope's ` +
        `own marker field said "${opts.envelopeMarker}" — these must agree ` +
        `(the one exception, CHECKS_WRITTEN over UNIT_CHECK_WRITTEN or the ` +
        `reverse, is reconciled to the envelope before this is thrown — but ` +
        `only when the envelope is the LAST fenced block). ` +
        `This usually means the model closed with the wrong outcome's name, ` +
        `or parseVerdict fell back to an earlier, stale fenced JSON block ` +
        `after the final one failed schema validation. Neither reading can ` +
        `be trusted over the other.`,
    );
    this.name = "CheckWriterMarkerEnvelopeMismatchError";
    this.lineMarker = opts.lineMarker;
    this.envelopeMarker = opts.envelopeMarker;
  }
}

/* ------------------------------------------------------------------ *
 * Issue #923 — the seven `quarantine` call sites that left no RECORD
 * ------------------------------------------------------------------ *
 *
 * Measured from `.sandcastle/telemetry/issues.jsonl` on 2026-08-16, over
 * 2 to 14 August 2026: 109 tickets ran, 40 stopped, and **16 of those 40
 * stops carried no reason at all, costing $1,011.63**. The worst single one
 * was ticket #806 at $123.07.
 *
 * **Corrected 2026-08-19, by review, before this ever merged.** The first
 * draft of this comment said those sixteen tickets were "completely
 * blank". They were not. `quarantineViaLabel` (`lib/state/gh.ts`) posts a
 * one-line reason as a GitHub COMMENT at every stop, and #806 and #1064
 * both carry one — checked on the live tickets. What those sixteen stops
 * really lacked is a `stopped:*` LABEL, a section in the issue BODY, and
 * a `stopReason` in the durable record. So they could not be counted, they
 * broke this repo's own rule that state lives in the body, and the run's
 * own numbers could not see them. That is the real defect, and it is what
 * the $1,011.63 measures. #806 has since shipped.
 *
 * `main.mts` has sixteen `ctx.deps.quarantine(...)` call sites. Nine of them
 * already pair with `reportStopBestEffort`, which writes the explanation
 * into the issue BODY (never a comment — this repo's own rule is that a
 * ticket's state lives in its body). Seven did not:
 *
 *   FOUR WERE FULLY SILENT — nothing on the ticket at all. Each one now
 *   builds its explanation here and writes it into the body:
 *     1. the reviewer refused and there was no stronger model to retry with
 *     2. the reviewer refused after the third attempt (implementer-retry)
 *     3. the reviewer refused after the escalated retry (critique-retry)
 *     4. the pipeline halted on an unexpected error
 *
 *   THREE ALREADY POSTED A GOOD COMMENT but carried no label, so no count of
 *   last night's stops could ever see them:
 *     5. the design-principles critique gate blocked the merge (deleted in
 *        spec #1334 — the reviewer grades design rules now)
 *     6. the builder skipped the skills its ticket type requires
 *     7. the stuck-detector aborted a spinning builder with nothing committed
 *
 *   **Those that remain keep their comment exactly where it is — owner decision,
 *   2026-08-16, do not move that text into the body.** They take the LABEL
 *   only, which is the single thing that makes them countable. That is why
 *   they get a `label` and a short telemetry `detail` here, and why
 *   `main.mts` applies them through a label-only path rather than through
 *   `reportStopBestEffort`.
 *
 * Everything below is PURE — string building and nothing else — so the
 * wording each stop leaves on a ticket is testable without standing up the
 * whole pipeline. `main.mts` owns the IO.
 */

/**
 * Wrap arbitrary text in a code fence that the text cannot break out of.
 *
 * A plain three-backtick fence is NOT safe here: the text is agent output
 * and error messages, which routinely contain fenced code blocks of their
 * own. One stray fence inside would close the block early and mangle the
 * rest of the issue body — the one surface a stopped ticket is read from.
 * So the fence is always at least one backtick longer than the longest run
 * of backticks in the text, which is the rule CommonMark itself uses.
 */
export function safeFence(text: string): string {
  const longestRun = [...text.matchAll(/`+/g)].reduce(
    (max, m) => Math.max(max, m[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * One stop's label plus the plain-English explanation that goes with it.
 * The SAME prose reaches the issue body and the durable telemetry record,
 * so the two surfaces can never drift apart.
 *
 * ## Why this is TWO halves and not one string (#1198 review, blocker 1)
 *
 * Every explanation here says two different kinds of thing, and only one of
 * them survives being reused off a stop path:
 *
 * - `diagnosis` — WHAT WENT WRONG. True whatever happens next, so it is safe
 *   to quote anywhere: a stop's issue section, a telemetry record, or the
 *   #1198 A first-test fall-through, where the loop reuses the judge's
 *   account of a bad check on a ticket it is BUILDING rather than stopping.
 * - `whatToDo` — WHAT A PERSON SHOULD DO ABOUT IT, written for a ticket that
 *   IS held. These tails say things like "no code was written", "re-queue it
 *   (remove `quarantine`, add `ready-for-agent`)", and on one route a
 *   `git push origin :refs/sandcastle/wip/issue-N` that PERMANENTLY DELETES
 *   a saved pause point. Every one of those is false — and the last is
 *   destructive — on a ticket that was built anyway.
 *
 * `detail` is the two composed, so every stop caller that existed before this
 * split is byte-for-byte unchanged. Build one with {@link stopExplanation};
 * the three fields are all required, so a new explanation cannot forget to
 * declare which of its prose is safe to reuse.
 */
export interface StopExplanation {
  readonly label: StopReasonLabel;
  /** What went wrong. Safe to quote off a stop path. */
  readonly diagnosis: string;
  /** What a person should do about the HELD ticket. NEVER quote this
   *  anywhere the ticket is not actually stopped. Empty when the explanation
   *  has no remedy of its own (the three that point at their comment). */
  readonly whatToDo: string;
  /** {@link diagnosis} and {@link whatToDo} joined — the full body a stop
   *  writes. Composed by {@link stopExplanation}, never written by hand. */
  readonly detail: string;
}

/**
 * Build a {@link StopExplanation} from its two halves. The ONLY constructor —
 * `detail` is derived here so the composed string can never drift from the
 * parts, and so a caller cannot supply a `detail` whose "what to do" tail is
 * invisible to {@link StopExplanation.diagnosis}.
 */
export function stopExplanation(opts: {
  readonly label: StopReasonLabel;
  readonly diagnosis: string;
  readonly whatToDo: string;
}): StopExplanation {
  const diagnosis = opts.diagnosis.replace(/\s+$/, "");
  const whatToDo = opts.whatToDo.trim();
  return {
    label: opts.label,
    diagnosis,
    whatToDo,
    detail: whatToDo.length > 0 ? `${diagnosis}\n\n${whatToDo}` : diagnosis,
  };
}

/** The full stop body — `diagnosis` then `whatToDo`. A named reader so a
 *  call site saying "I want the whole thing, tail included" reads as a
 *  decision rather than as a field access nobody weighed. */
export function detailOf(explanation: StopExplanation): string {
  return explanation.detail;
}

/** Which of the reviewer's three refusal paths a stop came down. Named
 *  rather than a bare string so a new path cannot be added without this
 *  file being opened. */
export type ReviewerRefusalPath =
  | "no-retry-available"
  | "implementer-retry"
  | "critique-retry"
  | "recovery-review";

const REVIEWER_REFUSAL_PATHS: Record<ReviewerRefusalPath, string> = {
  "no-retry-available":
    "The reviewer refused on its first pass, and the run had no second, " +
    "stronger model to try with, so it stopped there rather than merging " +
    "over the objection.",
  "implementer-retry":
    "The reviewer refused three times. The builder was given the " +
    "reviewer's complaints and a stronger model between attempts, and the " +
    "reviewer still refused.",
  "critique-retry":
    "The reviewer refused after the escalated retry. The builder answered " +
    "the first refusal with an argument rather than code, that argument " +
    "was put to the reviewer, and the reviewer held its ground.",
  "recovery-review":
    "The builder did not get the ticket through — the reviewer refused its " +
    "work, it failed a check before merging, or it ran past its time " +
    "limit — so the fixer was handed the work, with the same three " +
    "review-and-fix rounds the builder gets. The reviewer still refused " +
    "what the fixer produced, so the run stopped there rather than " +
    "merging over the objection.",
};

/** Each refusal path in plain words, for the one-line why a person reads.
 *  The tokens themselves stay unchanged: telemetry rows on disk carry them
 *  (`critique-retry` predates spec #1334 and names the reviewer's SECOND pass,
 *  not the deleted design critique). */
const REVIEWER_REFUSAL_PATH_NAMES: Record<ReviewerRefusalPath, string> = {
  "no-retry-available": "the reviewer's only pass (no retry available)",
  "implementer-retry": "the reviewer's third pass",
  "critique-retry": "the reviewer's second pass",
  "recovery-review": "the fixer's review",
};

/**
 * The three reviewer-refusal stops — the most expensive stop the run has.
 * Ticket #1064 (index the remaining settings sections for search) took this
 * path on 15 August 2026 and cost **$99.43**, with no label, no body
 * section and no durable record — only the one-line comment every stop
 * posts.
 *
 * Deliberately NOT `stopped:check-disagreement`. That label means "the
 * check and the builder disagree and the owner breaks the tie", and it
 * carries `needs-owner-decision`. A reviewer refusing over code quality, a
 * house rule, or missing proof the code was run is a different thing
 * entirely, and counting the two together would corrupt the disagreement
 * number the judge design (#1117, #1118) is built to produce.
 */
export function reviewerRefusedExplanation(opts: {
  /** The reviewer's own outcome marker, e.g. `HAS_BLOCKERS`. */
  readonly marker: string;
  readonly path: ReviewerRefusalPath;
  /** For `no-retry-available`: why no retry was possible, in the run's own
   *  words (`retry disabled (--no-retry)` or `no escalation model
   *  available for implementer or reviewer`). For `recovery-review` (the
   *  fixer's refusal): what actually happened — why the builder's work was
   *  handed to the fixer, and that the fixer's rounds were refused too.
   *  Ignored on every other path. */
  readonly why?: string;
}): StopExplanation {
  // The lead-in differs by path: `no-retry-available` genuinely ran out of
  // retries, so `why` explains THAT absence. On `recovery-review` (the
  // fixer's refusal) `why` instead narrates what happened to the builder
  // before the fixer took over, so "reason for having no retry" would be
  // describing something that was never true of this path.
  const becauseLeadIn =
    opts.path === "no-retry-available"
      ? "The run's own reason for having no retry"
      : opts.path === "recovery-review"
        ? "What happened before the review"
        : undefined;
  const because =
    becauseLeadIn !== undefined && opts.why !== undefined
      ? ` ${becauseLeadIn}: ${opts.why}.`
      : "";
  // #1096 — stamp the outcome checkbox onto the refusal itself. The reviewer
  // has refused thirteen tickets across nine runs, seven of one night's eight
  // were later built by hand and shipped, and a fair refusal and a wrong one
  // looked identical for ever. Whoever later closes this ticket ticks whether
  // the refusal was correct; a one-line why (the reviewer's marker and which
  // path it came down) lets them judge without reading the whole section.
  const why = `reviewer's last word was ${opts.marker}, via ${REVIEWER_REFUSAL_PATH_NAMES[opts.path]}`;
  return stopExplanation({
    label: "stopped:reviewer-refused",
    diagnosis:
      `The reviewer — the part of the run that reads the finished code — ` +
      `refused to pass it, and the ` +
      `run stopped rather than merging over that refusal.\n\n` +
      `${REVIEWER_REFUSAL_PATHS[opts.path]}${because}\n\n` +
      `**The reviewer's own last word was \`${opts.marker}\`.** Its full ` +
      `reasoning is in the run log for this ticket, not here — this ` +
      `section records THAT the reviewer refused and on which path, which ` +
      `is what nothing wrote down before.`,
    whatToDo:
      `What to do: read the reviewer's objection. If the code really is ` +
      `wrong, the ticket needs re-scoping. If the reviewer is wrong, ` +
      `re-queue with \`ready-for-agent\` after removing \`quarantine\`.` +
      renderRefusalOutcomeCheckbox(why),
  });
}

/**
 * The catch-all: the pipeline threw something it has no arm for. Not the
 * ticket's fault and not the builder's — the run itself broke. Grouped with
 * the stuck-abort under one label because both mean the same thing to
 * whoever triages: nothing about the ticket needs changing, put it back.
 */
export function runFaultExplanation(opts: {
  /** The error text, already truncated by the caller. */
  readonly errorMessage: string;
  /** The three verdict flags the pipeline was carrying when it halted —
   *  kept because they are the only clue to WHERE it halted. */
  readonly verdictFlags?: string;
}): StopExplanation {
  const flags =
    opts.verdictFlags !== undefined && opts.verdictFlags.length > 0
      ? `\n\nRun state at the moment it halted (these are the run's own ` +
        `internal flags, useful only to whoever fixes the run): ` +
        `${opts.verdictFlags}`
      : "";
  return stopExplanation({
    label: "stopped:run-fault",
    diagnosis:
      `The run hit an error it has no handler for and stopped this ticket. ` +
      `This is the run's own machinery failing, not a judgement about the ` +
      `code or the ticket.\n\n` +
      `${safeFence(opts.errorMessage)}${flags}`,
    whatToDo:
      `What to do: nothing about the ticket needs changing. ` +
      `The loop retries this ticket on its next run, until it has spent ` +
      `$100 in total or has been tried three times; then it is ` +
      `labelled \`waiting-for-session\` and listed in the run report. ` +
      `Nothing to do right now unless it is already waiting.`,
  });
}

/**
 * The stuck-detector aborted a spinning builder that committed nothing.
 * Shares `stopped:run-fault` with the catch-all above for the same reason.
 * The full explanation is already posted as a COMMENT by `main.mts` and
 * stays there — this is the label and the countable one-liner only.
 */
export function stuckNoCommitsExplanation(): StopExplanation {
  return stopExplanation({
    label: "stopped:run-fault",
    diagnosis:
      `The stuck-detector aborted a builder that was repeating itself, and ` +
      `nothing had been committed, so there is no partial work to review. ` +
      `The full explanation is ${POINTS_AT_ITS_COMMENT}.`,
    // No remedy of its own: the comment this points at carries it.
    whatToDo: "",
  });
}

/**
 * The staging branch failed its own review after every issue that iteration
 * had already been merged onto it — so EVERY one of those issues is stopped
 * at once, none of them individually judged wrong.
 *
 * Outside `runIssuePipeline` (issue #923 scoped itself to that function's
 * sixteen sites), but the same defect and a WIDER blast radius: one failed
 * iteration blanks every ticket that landed in it, not one.
 */
export function stagingRejectedExplanation(opts: {
  /** The staging reviewer's own marker, or empty if it produced none. */
  readonly marker: string;
  /** The ticket this explanation is being written ONTO. Required so it can
   *  be removed from the sibling list below — a ticket that lists itself
   *  among "the others" reads as a miscount to whoever opens it. */
  readonly issueNumber: number;
  /** EVERY issue stopped by this failure, including `issueNumber` itself —
   *  callers pass the round's whole list and this function does the
   *  excluding, so no caller can forget to. */
  readonly siblingIssues: readonly number[];
}): StopExplanation {
  const others = opts.siblingIssues.filter((n) => n !== opts.issueNumber);
  const company =
    others.length > 0
      ? ` ${others.length} other ticket${others.length === 1 ? " was" : "s were"} ` +
        `stopped by the same failure: ${others.join(", ")}.`
      : "";
  return stopExplanation({
    label: "stopped:run-fault",
    diagnosis:
      `This ticket's own work passed and was merged. The run then reviewed ` +
      `everything merged that round TOGETHER, and that combined review ` +
      `refused it, so every ticket in the round was stopped.\n\n` +
      `**The combined review's last word was ` +
      `\`${opts.marker.length > 0 ? opts.marker : "(no answer at all)"}\`.**` +
      `${company}`,
    whatToDo:
      `What to do: nothing was necessarily wrong with THIS ticket — the ` +
      `round's merge onto staging was never certified onto the integration ` +
      `branch, so nothing built here was lost. Check whether two of the ` +
      `round's tickets clashed with each other. ` +
      `The loop retries this ticket on its next run, until it has spent ` +
      `$100 in total or has been tried three times; then it is ` +
      `labelled \`waiting-for-session\` and listed in the run report.`,
  });
}

/**
 * #972 gap 6 — the round's code passed post-merge review, but the POST-MERGE
 * FIXER's own diff was refused by the never-waived removed-coverage gate: it
 * deleted or emptied test coverage (or its diff could not be measured) after
 * every per-issue proof gate had already run. The fixer writes on one commingled
 * staging branch, so a refusal stops the whole round — same blast radius as a
 * reviewer rejection, different cause, so it reads differently.
 *
 * This is NOT `stagingRejectedExplanation`: that one says the combined REVIEW
 * refused the round. Here the review passed and the FIXER is what broke it, so
 * "re-queue and hope" is the wrong advice — a human should look at what the
 * fixer removed.
 */
export function stagingFixerRejectedExplanation(opts: {
  /** The ticket this explanation is being written ONTO — removed from the
   *  sibling list so it does not read as listing itself among "the others". */
  readonly issueNumber: number;
  /** EVERY issue stopped by this failure, including `issueNumber` itself. */
  readonly siblingIssues: readonly number[];
  /** The test file(s) the fixer removed, when the gate could name them. Empty
   *  when the diff itself was unmeasurable. */
  readonly touchedPaths: readonly string[];
}): StopExplanation {
  const others = opts.siblingIssues.filter((n) => n !== opts.issueNumber);
  const company =
    others.length > 0
      ? ` ${others.length} other ticket${others.length === 1 ? " was" : "s were"} ` +
        `stopped by the same failure: ${others.join(", ")}.`
      : "";
  const removed =
    opts.touchedPaths.length > 0
      ? `**The fixer removed test coverage:** ${opts.touchedPaths.join(", ")}.`
      : `**The fixer's diff could not be measured, so the loop could not prove ` +
        `it kept the tests** — usually a bad staging worktree, not a bad fix.`;
  return stopExplanation({
    label: "stopped:run-fault",
    diagnosis:
      `This ticket's own work passed and was merged, and the combined review ` +
      `of everything merged that round PASSED. A separate automatic fix step ` +
      `then ran on the shared staging branch to tidy the round up — and THAT ` +
      `step is what was refused, because it removed test coverage without a ` +
      `person agreeing. Every ticket in the round was stopped because they all ` +
      `share one staging branch.\n\n` +
      `${removed}${company}`,
    whatToDo:
      `What to do: **${STRANDED_PROMOTION_NO_REQUEUE_MARKER}.** Someone has ` +
      `to look at what the automatic fix step deleted and decide whether it ` +
      `was right first — a person must inspect what was removed before this ` +
      `is safe to re-queue at all, so the loop marks it ` +
      `\`waiting-for-session\` instead of retrying it. Once the deletion is ` +
      `settled, re-queue by hand (remove \`waiting-for-session\`, add ` +
      `\`ready-for-agent\`).`,
  });
}

/**
 * The one literal phrase that marks a `stopped:run-fault` ticket as one this
 * module has judged unsafe to retry — the single thing distinguishing
 * those tickets in the BODY, since every `stopped:run-fault` shape shares
 * the same label.
 *
 * **Load-bearing beyond this file.** The retry budget
 * (`lib/state/retry-budget.ts`, `decideRetry`) checks the ticket body for
 * this exact string and moves such a ticket to `waiting-for-session` rather
 * than retrying it.
 * Three shapes carry it today:
 *
 * - A STRANDED promotion ({@link strandedExplanation}) — the work is already
 *   finished and reviewed, saved at a git ref, and re-queuing it would throw
 *   that away (issue #923's review found this — "the most dangerous place"
 *   for a silent stop to invite a re-queue).
 * - A post-merge-FIXER refusal ({@link stagingFixerRejectedExplanation}) —
 *   the round's code passed review, but the automatic fix step that ran
 *   afterward deleted or emptied test coverage. A person has to look at
 *   what it removed and decide whether that was right BEFORE any re-queue;
 *   auto-requeuing here would silently re-run a ticket while the real
 *   defect (whatever the fixer broke) sits untouched.
 * - `stopCheckRepairChangedItsAnswer` (`main.mts`) — the check-writer's
 *   first pass and its repair pass gave two answers that cannot both be
 *   right (one said "strengthen the check", the other said "no check is
 *   needed at all"). A person has to read the ticket and pick which answer
 *   is true before any re-queue; auto-requeuing here would just run the
 *   same contradiction again with nobody the wiser (final review, BLOCKER
 *   C, 2026-09-01).
 *
 * Every OTHER `stopped:run-fault` shape (`runFaultExplanation`,
 * `stagingRejectedExplanation`) carries no marker and IS safe to
 * retry — nothing was built, or what was built was never certified,
 * so a repeat attempt costs a retry, never a loss.
 *
 * Exported as a constant, not re-typed as a literal in multiple files, so
 * every explanation's own wording and the budget's read of it can never
 * drift apart.
 */
export const STRANDED_PROMOTION_NO_REQUEUE_MARKER = "do not simply re-queue this";

/**
 * The ticket's work was certified, but the run could not fast-forward it
 * onto the integration branch, so it is stranded. **Not a re-queue**: the
 * finished work exists on a saved ref and re-running the ticket would throw
 * it away. See {@link STRANDED_PROMOTION_NO_REQUEUE_MARKER} — this is the
 * one `stopped:run-fault` shape the retry budget must never retry.
 */
export function strandedExplanation(opts: {
  readonly stagingBranch: string;
  readonly integrationBranch: string;
  /** Where the finished work is preserved. */
  readonly savedAt: string;
}): StopExplanation {
  return stopExplanation({
    label: "stopped:run-fault",
    diagnosis:
      `This ticket's work was finished and passed review, but the run could ` +
      `not move it onto the branch it collects finished work on, so it is ` +
      `stranded. It got as far as the holding branch ` +
      `\`${opts.stagingBranch}\` and could not reach the collecting branch ` +
      `\`${opts.integrationBranch}\`.\n\n` +
      `**The finished work is NOT lost.** It is saved at the git marker ` +
      `\`${opts.savedAt}\` — a pointer the run keeps so finished work ` +
      `survives a failed move.`,
    whatToDo:
      `What to do: **${STRANDED_PROMOTION_NO_REQUEUE_MARKER}.** Re-running ` +
      `the ticket would throw the finished work away, so the loop marks it ` +
      `\`waiting-for-session\` instead of retrying it — someone has to look ` +
      `at why the move was refused and land the saved work by hand.`,
  });
}

/* ------------------------------------------------------------------ *
 * Issue #1118 — the two stops the JUDGE can reach
 * ------------------------------------------------------------------ *
 *
 * The judge is the agent that reads the ticket beside the check written for
 * it. It runs once on every ticket, right after the check is committed and
 * BEFORE the builder starts, and again at the first disagreement.
 *
 * Everything below is PURE — string building and nothing else — so the
 * wording each stop leaves on a ticket is testable without standing up the
 * judge, let alone the whole pipeline. `main.mts` owns the IO.
 *
 * Both of these are ordinarily stops the run reaches with NO code written,
 * which is why every "what to do" line below is about the check or the ticket
 * and never about the diff: there is no diff.
 *
 * SPEC #1334 (SF1): the judge's EARLY pass is deleted, and with it the
 * weak-check stop (`weakCheckExplanation`) — a first test that cannot be made
 * to fail is now built anyway, never stopped. `ticketUnclearExplanation` is
 * the one judge-era stop left, and its live producer is the #1143 target
 * audit in `runIssuePipeline`.
 *
 * Every parameter below is one the judge's envelope can actually fill.
 * `weakCheckExplanation` and `ticketUnclearExplanation` each used to take one
 * extra optional field — "what could be deleted without this check noticing"
 * and "the question the ticket has to answer" — that rendered beautifully and
 * that nothing ever supplied: `JudgeCoverageOutputSchema` in
 * `lib/judge/schema.ts` has no field carrying either, so no call site could
 * have passed one without the judge being asked a new question first. They
 * were dropped rather than widened (issue #1133, item 8). Adding a question
 * to the judge's prompt and envelope is the decision, and it should be made
 * on its own merits; leaving the renderer standing does not make it, it just
 * leaves a reader to work out that the branch is dead. Widen the envelope
 * first, then add the field back.
 *
 * ONE EXCEPTION, and it must never be lost. A weak check found on a ticket
 * RESUMED from a saved checkpoint stops with work already on the branch from
 * before the pause. Telling that ticket "no code was written" is untrue, and
 * an owner reading it would think nothing survived. `whyNoRepair` carries that
 * distinction and BOTH the explanation and the "what to do" line branch on it.
 */

/**
 * Where the run was when it found the ticket unclear. Named rather than a bare
 * string, for the same reason {@link ReviewerRefusalPath} is: a new place this
 * conclusion can be reached cannot be added without this file being opened.
 */
export type TicketUnclearStage =
  /** Before the builder started — the judge read the ticket beside the
   *  freshly written check and could not tell what a pass should look like. */
  | "before-any-code"
  /** At a disagreement — the check and the finished code contradict each
   *  other and the ticket does not settle which of them is right. */
  | "at-a-disagreement"
  /** While building — the builder hit a product question the ticket does
   *  not answer, and stopped rather than guess (spec #1334 fix pass). */
  | "while-building";

const TICKET_UNCLEAR_STAGES: Record<TicketUnclearStage, string> = {
  "before-any-code":
    "This was caught before any code was written, so nothing was spent " +
    "building against it.",
  "at-a-disagreement":
    "This was caught after the code was written: the check and the code " +
    "contradict each other, and the ticket does not say which of them is " +
    "right. The work so far is on the ticket's branch and was not thrown away.",
  "while-building":
    "This was caught while the code was being written: the builder reached " +
    "a choice the ticket does not make, and stopped rather than guess. Any " +
    "work so far is on the ticket's branch.",
};

/**
 * The ticket itself does not say clearly enough what was wanted. Two roads
 * reach it (spec #1334 fix pass): a server-only ticket with no target block,
 * and the test-writing AI or the builder answering `TICKET_UNCLEAR` with the
 * exact product question the ticket leaves open — `reason` carries that
 * question onto the issue body.
 *
 * Guessing and carrying on would quietly make the guess the requirement, with
 * nobody told; a vague ticket is a finding about how it was WRITTEN, and it is
 * only a finding if it stops and says so. It is the one stop that goes to the
 * owner (`needs-human`).
 */
export function ticketUnclearExplanation(opts: {
  /** The judge's own plain sentence naming what the ticket does not say. */
  readonly reason: string;
  readonly stage: TicketUnclearStage;
}): StopExplanation {
  return stopExplanation({
    label: "stopped:ticket-unclear",
    diagnosis:
      `The run stopped because this ticket does not say plainly enough what ` +
      `it wanted, so there is no way to tell what a correct result looks ` +
      `like.\n\n` +
      `**What the ticket does not say:**\n${opts.reason.trim()}\n\n` +
      `${TICKET_UNCLEAR_STAGES[opts.stage]}\n\n` +
      `This is a finding about the ticket, not about the code. The run could ` +
      `have guessed and carried on, and the guess would have quietly become ` +
      `the requirement with nobody ever told.`,
    whatToDo:
      `What to do: add the missing answer to the ticket's description, then ` +
      `re-queue it (remove \`needs-human\`, add \`ready-for-agent\`).`,
  });
}
