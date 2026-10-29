/**
 * The check reading — what the judge made of a ticket's check when it read
 * it, before the builder started (issue #1118).
 *
 * ## What was broken
 *
 * The judge's EARLY pass reads every ticket's check and answers one of three
 * things: the check is sound, the check is too weak, or the ticket does not
 * say clearly enough to judge it. Two of those three reach the ticket, both
 * through the stop machinery — a too-weak check and an unclear ticket each
 * halt the ticket and say so.
 *
 * **The third answer — `CHECK_SOUND`, the healthy majority — was written
 * nowhere at all.** Only the failures left a trace, so the only number the
 * run could produce was a count of bad checks with no total under it.
 *
 * Owner's decision, 2026-08-20, in his words: eight bad checks out of twelve
 * means the run is broken; eight out of three hundred means it is fine. Same
 * eight. A numerator with no denominator is a number he cannot act on. So
 * EVERY early-pass reading gets recorded, the routine one included, and the
 * healthy readings are what make the bad ones mean something.
 *
 * ## Where a reading lives, and why only there
 *
 * **On the GitHub ticket, in its own block in the BODY**, exactly as the
 * verdict does (`lib/state/verdict.ts`, issue #1117) and for the same owner
 * ruling: never in `.sandcastle/telemetry/issues.jsonl`, because that file is
 * committed to git, so writing there would need a branch and a pull request
 * every night. The consequence is stated out loud rather than discovered
 * later: **anything reading only the telemetry file cannot count readings.**
 * This number is read from GitHub.
 *
 * ## Its own markers, so it never eats another block
 *
 * A ticket can carry four separate blocks — the stop report, the watch-only
 * screen-check observation, the verdict, and this. Each has its own marker
 * pair and each writer touches only its own, because the stop block is
 * REPLACED wholesale on every stop and would take anything sharing its
 * markers down with it.
 *
 * ## The design question: is there a human-outranks-the-run rule here?
 *
 * **There is not, and that is deliberate.** `decideVerdictWrite` in
 * `verdict.ts` refuses to overwrite a verdict a person set by hand, because a
 * verdict is a JUDGEMENT — "which side was wrong" — and owner ruling 1 is
 * that he may overturn any judgement by editing the ticket. A judgement he
 * corrected, then silently re-ruled by the next night's run, would make the
 * correction worthless.
 *
 * A check reading is not a judgement. It is a RECORD OF WHAT THE RUN DID on a
 * given night: the judge opened this check, and this is what it said. Nobody
 * overturns that, any more than anybody overturns a timestamp — a person can
 * DISAGREE with the judge's reading, and the place to say so is the verdict
 * block, which is built for exactly that and which this block never touches.
 * Guarding this one against the run would only mean a hand edit froze the
 * ticket's record at one night forever, so the denominator would quietly stop
 * counting that ticket.
 *
 * **So this block is simply REPLACED on every run**, and the rendered block
 * says so in plain words, so a person who edits it is not surprised when
 * tomorrow's run writes over the edit.
 */

import { createHash } from "node:crypto";

/**
 * The three answers the judge's early pass could give about a first test.
 * Kept here, where the historical check-reading labels still map from them,
 * after spec #1334 deleted the judge and its `lib/judge/schema.ts`.
 */
export const JUDGE_COVERAGE_MARKERS = [
  "CHECK_SOUND",
  "CHECK_TOO_WEAK",
  "TICKET_UNCLEAR",
] as const;
export type JudgeCoverageMarker = (typeof JUDGE_COVERAGE_MARKERS)[number];
import { readMarkedSection, upsertMarkedSection } from "./body-sections.js";
// Type-only, so this stays a compile-time tie to the stop labels and adds no
// runtime edge between these two modules.
import type { StopReasonLabel } from "./stop-reasons.js";

/**
 * The three readings, in the order the judge's own markers are declared.
 * `sound` is first because it is the healthy one, and counting it is the
 * whole reason this module exists.
 */
export const CHECK_READING_VALUES = ["sound", "too-weak", "ticket-unclear"] as const;

export type CheckReading = (typeof CHECK_READING_VALUES)[number];

/**
 * Which reading each of the judge's early-pass marker words means.
 *
 * Two vocabularies exist because they answer to different masters: the marker
 * is the word the judge agent must emit and is validated by
 * `lib/judge/schema.ts`, while the reading is the word a person sees on the
 * ticket and the word the label is named after. Keeping the SHOUTING marker
 * on the ticket would put the agent's protocol in front of the owner, and
 * renaming the marker would break the judge's prompt contract.
 */
const READING_FOR_MARKER = {
  CHECK_SOUND: "sound",
  CHECK_TOO_WEAK: "too-weak",
  TICKET_UNCLEAR: "ticket-unclear",
} as const satisfies Record<JudgeCoverageMarker, CheckReading>;

/** The same mapping the other way, written out rather than derived, so the
 *  compile-time proof below has both directions to check. */
const MARKER_FOR_READING = {
  sound: "CHECK_SOUND",
  "too-weak": "CHECK_TOO_WEAK",
  "ticket-unclear": "TICKET_UNCLEAR",
} as const satisfies Record<CheckReading, JudgeCoverageMarker>;

/**
 * Compile-time proof that the three readings map ONE-TO-ONE onto the judge's
 * three markers, in the style of `lib/judge/ruling.ts:78-83`.
 *
 * Both `satisfies Record<…>` annotations above already force each map to
 * cover every member of its key list and to produce only real members of the
 * other. These two lines close the remaining gap in the other direction: that
 * every reading is REACHED by some marker, and every marker is reached by
 * some reading. Exhaustive both ways over two lists of the same length is a
 * bijection — so if either list ever grows a member the other lacks, or two
 * markers ever collapse onto one reading, the build stops here rather than
 * letting a tally quietly answer a different question than its label claims.
 */
const _everyReadingComesFromAMarker: CheckReading extends (typeof READING_FOR_MARKER)[JudgeCoverageMarker]
  ? true
  : never = true;
const _everyMarkerHasAReading: JudgeCoverageMarker extends (typeof MARKER_FOR_READING)[CheckReading]
  ? true
  : never = true;
void _everyReadingComesFromAMarker;
void _everyMarkerHasAReading;

/**
 * Turn one of the judge's early-pass markers into the reading recorded on the
 * ticket.
 *
 * Takes a {@link JudgeCoverageMarker} and nothing wider, which is the point.
 * `main.mts`'s `JudgeEarlyPassResult` carries a FOURTH marker,
 * `JUDGE_DID_NOT_RUN`, meaning no judging happened — and a pass that never
 * ran has no reading to record. The type refuses it at the call site, so a
 * skipped pass can never be counted into the denominator as though a check
 * had been read.
 */
export function checkReadingForMarker(marker: JudgeCoverageMarker): CheckReading {
  return READING_FOR_MARKER[marker];
}

/** The plain-English sentence for each reading. One spelling, used by the
 *  rendered block and by the GitHub label description, so the ticket and the
 *  label can never describe the same reading differently. */
export const CHECK_READING_MEANINGS: Record<CheckReading, string> = {
  sound: "the check does test what the ticket asked for — the builder was allowed to start",
  "too-weak": "the check would pass on work that misses what the ticket asked for",
  "ticket-unclear": "the ticket does not say clearly enough to judge the check against",
};

/** The GitHub label carrying a reading. The BODY is the record; the label is
 *  only an index, so one query can find every ticket whose check was read
 *  without fetching and parsing all of them.
 *  {@link parseCheckReadingSection} is the only reader anything should trust. */
export function checkReadingLabelFor(reading: CheckReading): string {
  return `check-read:${reading}`;
}

/**
 * Label metadata for every reading, fed to `gh label create --force` at run
 * startup the same way the stop and verdict labels are. Descriptions are held
 * under GitHub's 100-character cap; `gh label create` rejects a longer one
 * with HTTP 422.
 *
 * One colour for all three, matching the verdict labels. These are an index,
 * not a scorecard — a green `sound` beside a red `too-weak` would turn a
 * routine reading into a grade at a glance, which is the exact reading of
 * this block the owner's decision rules out.
 */
export const CHECK_READING_LABEL_DEFINITIONS: ReadonlyArray<{
  readonly reading: CheckReading;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}> = CHECK_READING_VALUES.map((reading) => ({
  reading,
  name: checkReadingLabelFor(reading),
  color: "1d76db",
  description: `Check reading: ${CHECK_READING_MEANINGS[reading]}`.slice(0, 100),
}));

/**
 * The stop labels a ticket whose check was READ may be wearing instead of a
 * `check-read:*` one.
 *
 * A count that queries only the `check-read:*` labels cannot see the tickets
 * most likely to have lost one. The reading is written to the BODY first and
 * the label second, on purpose (see `applyCheckReadingReport`), so a label
 * write that fails leaves a real reading with no index entry — and the tickets
 * where that matters are precisely the ones the judge stopped, which wear one
 * of these two. `countVerdicts` already solves the same problem by also
 * querying `stopped:check-disagreement`.
 *
 * Typed as {@link StopReasonLabel}, so renaming a stop label breaks the build
 * here rather than silently emptying half the denominator.
 *
 * These two only WIDEN the search. A ticket found through one of them still
 * has to carry a reading in its body to be counted, and a ticket found only
 * this way is never accused of having lost one — it never claimed to be read.
 *
 * `stopped:weak-check` was RETIRED by #1198 A — nothing applies it any more,
 * because a check the judge rules too weak no longer stops the ticket. It
 * stays here on purpose: this is a QUERY, and the tickets it has to find are
 * the ones already wearing the label from before #1198. Dropping it would
 * silently shrink the historical denominator rather than tidy anything.
 */
export const CHECK_READING_STOP_LABELS: readonly StopReasonLabel[] = [
  "stopped:weak-check",
  "stopped:ticket-unclear",
];

/** One reading, everything the ticket records about it. */
export interface CheckReadingRecord {
  readonly reading: CheckReading;
  /** When the judge read the check. Kept because the block is replaced every
   *  run: without a date, a reader cannot tell last night's record from one
   *  written a month ago. */
  readonly whenIso: string;
  readonly runId?: string;
  /**
   * The acceptance criterion the judge quoted from the ticket. Present on
   * `too-weak` (the judge's schema requires it there, because a repair brief
   * is built from it), and absent on a routine `sound` reading, which has no
   * one criterion to name.
   */
  readonly criterion?: string;
  /** The judge's own reason, in plain English. Required of the judge on every
   *  marker including `CHECK_SOUND` — a judge that must say WHY a check is
   *  sound has to have read it. Optional here only so a block written before
   *  this field existed, or one hand-trimmed, still reads. */
  readonly why?: string;
  /**
   * A fingerprint of the exact check text this reading was made of
   * ({@link fingerprintCheckSource}).
   *
   * WHAT IT IS FOR, and it is the only thing that reads it: a ticket that
   * paused mid-build and is picked up again on a later night re-runs the
   * early pass over the SAME check. On a resumed worktree the judge may not
   * repair anything — the builder's finished code is on disk, so ruling 6's
   * "give it nothing it can use to go green on purpose" is defeated by the
   * room — so a `too-weak` ruling there stops the ticket with no rewrite. The
   * judge is an AI re-reading a check it already approved, so a second opinion
   * it never asked for could strand saved work, every night, for ever.
   *
   * With this, the resume can prove the bytes have not moved since the reading
   * already on the ticket and skip the re-read entirely. Absent on a block
   * written before this field existed, which simply means the resume cannot
   * prove it and reads again — the old behaviour.
   */
  readonly checkFingerprint?: string;
}

/**
 * The fingerprint of one check file's exact text.
 *
 * sha256 of the bytes, hex, first 16 characters — enough that two different
 * checks colliding is not a thing that happens, and short enough to sit on a
 * line a person reads. It fingerprints the SOURCE rather than a path or a
 * commit sha on purpose: a resumed worktree is a different commit carrying the
 * same check, and it is the check's text that the reading was about.
 */
export function fingerprintCheckSource(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16);
}

/** The first words of the closing note. Shared by the writer and the reader,
 *  because the reader uses it to find where the free-text reason ends — two
 *  spellings of it would silently swallow the note into the reason. */
const REPLACED_NOTE_START = "> **This is a record, not a ruling:**";

const CHECK_READING_SECTION_START = "<!-- sandcastle:check-reading:start -->";
const CHECK_READING_SECTION_END = "<!-- sandcastle:check-reading:end -->";

/**
 * Render the check-reading block. Pure string-building, no IO;
 * `lib/state/gh.ts` does the fetch-modify-write around it.
 *
 * Written for somebody who has never seen this ticket: it says who looked,
 * what they looked at, when, and what they concluded, before it says anything
 * machine-readable.
 *
 * **A `sound` reading is deliberately not written as an achievement.** No
 * tick, no "passed", no congratulation. It is the routine case, it exists to
 * be counted, and dressing it up as good news would invite a reader to skim
 * past exactly the number that gives the bad readings their scale.
 */
export function buildCheckReadingSection(record: CheckReadingRecord): string {
  const lines = [
    "## Check reading: what the judge made of this ticket's check",
    "",
    "Before any code was written, the judge opened this ticket's check and read",
    "it against what the ticket asks for. This is what it found. Every ticket",
    "gets one of these, so the routine readings and the bad ones can be counted",
    "against each other.",
    "",
    `**Reading:** \`${record.reading}\``,
    `**Meaning:** ${CHECK_READING_MEANINGS[record.reading]}`,
    `**When:** ${record.whenIso}`,
    `**Run:** ${record.runId ?? "(not stated)"}`,
    `**Criterion the judge named:** ${record.criterion ?? "(not stated)"}`,
    `**Check fingerprint:** \`${record.checkFingerprint ?? "(not stated)"}\``,
  ];
  if (record.why !== undefined && record.why.trim().length > 0) {
    lines.push("", "**Why:**", record.why.trim());
  }
  lines.push(
    "",
    `${REPLACED_NOTE_START} it says what the run did on the date`,
    "> above, so it is REPLACED every time the judge reads this ticket's check",
    "> again. An edit made here will not survive the next run. To say the judge",
    "> got it wrong, use the verdict block instead — that one is yours, and the",
    "> run never overwrites it once it is marked `human`.",
  );
  return lines.join("\n");
}

/**
 * Insert or replace the check-reading block in an issue body, leaving
 * everything else — the ticket description, the stop block, the watch-only
 * block and the verdict block — untouched.
 */
export function upsertCheckReadingSection(body: string, section: string): string {
  return upsertMarkedSection(
    body,
    CHECK_READING_SECTION_START,
    CHECK_READING_SECTION_END,
    section,
  );
}

// The three field readers below are the same shape as `verdict.ts`'s private
// ones. Deliberately not shared yet: `body-sections.ts` was extracted when a
// body-EDITING routine reached three copies, because each copy rewrites a
// human-edited ticket description and a divergence there loses somebody's
// words. These readers only read, and a divergence costs a missing decoration
// field. If a third block ever needs them, they move to `body-sections.ts`
// then — not before.

/** Find the one line labelled `**Field:**`, whatever its value looks like. */
function findFieldLine(section: string, field: string): string | undefined {
  const wanted = `**${field.toLowerCase()}:**`;
  return section.split("\n").find((l) => l.trim().toLowerCase().startsWith(wanted));
}

/** Pull one backticked value off a `**Label:** \`value\`` line. */
function readBacktickedField(section: string, field: string): string | undefined {
  const line = findFieldLine(section, field);
  if (line === undefined) return undefined;
  return /`([^`]*)`/.exec(line)?.[1]?.trim();
}

/** Pull one plain `**Label:** value` line. */
function readPlainField(section: string, field: string): string | undefined {
  const line = findFieldLine(section, field);
  if (line === undefined) return undefined;
  const value = line.slice(line.indexOf(":**") + 3).trim();
  return value.length === 0 || value === "(not stated)" ? undefined : value;
}

/**
 * The check fingerprint, or `undefined` when the block predates the field or
 * carries the "(not stated)" placeholder. Distinct from
 * {@link readBacktickedField} because that one would hand back the
 * placeholder text as though it were a real fingerprint, and a fingerprint
 * that compares equal to nothing is exactly the wrong failure — it would make
 * a resumed ticket read again, which is safe, but the placeholder must never
 * MATCH anything either.
 */
function readFingerprintField(section: string): string | undefined {
  const raw = readBacktickedField(section, "Check fingerprint");
  if (raw === undefined || raw.length === 0 || raw === "(not stated)") {
    return undefined;
  }
  return raw;
}

/**
 * Read a check reading back out of an issue body, or `undefined` when there
 * is none to read.
 *
 * Deliberately strict about the reading word and forgiving about everything
 * else. A body whose reading word is not one of the three is reported as NO
 * reading rather than as some fourth kind — a typo must not become a new
 * outcome every tally then has to cope with, and, worse, must not land in the
 * denominator as a check that was read. The date, the run, the criterion and
 * the reason are decoration for a person and never block the read.
 */
export function parseCheckReadingSection(body: string): CheckReadingRecord | undefined {
  const section = readMarkedSection(
    body,
    CHECK_READING_SECTION_START,
    CHECK_READING_SECTION_END,
  );
  if (section === undefined) return undefined;

  const raw = readBacktickedField(section, "Reading");
  const reading = CHECK_READING_VALUES.find((r) => r === raw);
  if (reading === undefined) return undefined;

  // `why` runs up to the closing note, NOT to the first line beginning with
  // `>`. A reason that quotes the ticket is ordinary, and splitting on any
  // quote mark would silently cut such a reason in half.
  const whyIdx = section.indexOf("**Why:**");
  const why =
    whyIdx === -1
      ? undefined
      : section
          .slice(whyIdx + "**Why:**".length)
          .split(REPLACED_NOTE_START)[0]
          ?.trim();

  return {
    reading,
    whenIso: readPlainField(section, "When") ?? "",
    runId: readPlainField(section, "Run"),
    criterion: readPlainField(section, "Criterion the judge named"),
    checkFingerprint: readFingerprintField(section),

    why: why !== undefined && why.length > 0 ? why : undefined,
  };
}

/**
 * A tally over a set of issue bodies: one count per reading, the tickets
 * carrying none, and the TOTAL.
 *
 * `total` is the deliverable and is stored rather than left to the caller to
 * add up. The whole fault this module fixes was a numerator arriving without
 * its denominator, and a total every reader has to reconstruct is a total
 * some reader will not reconstruct.
 *
 * `total` counts the checks actually READ — the three readings summed — and
 * excludes `unrecorded`. A ticket wearing the label with no block in its body
 * is a check nobody can vouch for, so counting it as read would inflate the
 * denominator and flatter the run in exactly the direction that matters.
 */
export type CheckReadingTally = Record<CheckReading, number> & {
  unrecorded: number;
  total: number;
};

export function tallyCheckReadings(bodies: readonly string[]): CheckReadingTally {
  const tally = { unrecorded: 0, total: 0 } as CheckReadingTally;
  for (const r of CHECK_READING_VALUES) tally[r] = 0;
  for (const body of bodies) {
    const read = parseCheckReadingSection(body);
    if (read === undefined) {
      tally.unrecorded += 1;
    } else {
      tally[read.reading] += 1;
      tally.total += 1;
    }
  }
  return tally;
}

export { CHECK_READING_SECTION_START, CHECK_READING_SECTION_END };
