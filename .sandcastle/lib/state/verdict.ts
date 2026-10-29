/**
 * The verdict — which side was wrong when the run's check and the run's
 * builder disagree (issue #1117, job two of three split out of issue #923).
 *
 * ## What was broken
 *
 * The slot already existed and nothing had ever filled it. Measured from
 * `.sandcastle/telemetry/issues.jsonl` on 2026-08-16, covering 2 to 14
 * August 2026: eight stops were a real disagreement, they cost $239.46, and
 * ALL EIGHT carry an empty verdict. So "how often is the check itself the
 * wrong one" — the number the whole judge design rests on — was a feeling,
 * not a figure.
 *
 * ## Where a verdict lives, and why only there
 *
 * **On the GitHub ticket, in its own block in the BODY. Nowhere else.**
 * Owner ruling 12 of the 2026-08-16 grilling: never in
 * `.sandcastle/telemetry/issues.jsonl`, because that file is committed to
 * git, so a verdict there would need a branch and a pull request every
 * time — the exact overhead the owner refused. The consequence is stated
 * out loud rather than discovered later: **anything reading only the
 * telemetry file cannot count verdicts.** This number is read from GitHub.
 *
 * **The old `disagreement.resolution` field is GONE.** It was the earlier,
 * two-value idea, and it lived on the durable record — exactly where ruling
 * 12 says a verdict may not live. Nothing had ever written it in twelve
 * days across eight real disagreements, and it only ever offered two of the
 * four outcomes. It was deleted from `lib/status/schema.ts` and from both
 * telemetry writers, so ruling 12 is enforced by the validator rather than
 * by a comment asking nicely: a verdict smuggled into the durable record is
 * dropped, and two tests prove it.
 *
 * Deleting it needed no migration and none was written. The record schema
 * is a plain object, not a strict one, so an older line on disk that still
 * carries the key is read normally and the key is stripped — proven by
 * round-tripping a synthetic legacy line through `readReworkRecords`, which
 * skipped nothing and preserved every other field. The committed record
 * held zero real occurrences of the field.
 *
 * ## Its own block, not a line inside the stop block
 *
 * The verdict gets its own markers, separate from the stop report's and
 * from the watch-only observation's. That is not tidiness. The stop block
 * is REPLACED wholesale every time the run stops the same ticket again, so
 * a verdict written inside it — including one the owner typed by hand —
 * would be destroyed by the next night's run. Ruling 1 is that he can
 * overturn any verdict by editing the ticket; a correction that survives
 * only until the next run is not an overturn.
 *
 * ## Four values, not two
 *
 * Ruling 3. The old field offered `builder-wrong` and `checks-wrong` only.
 * Two of the four real outcomes had nowhere to go, and the missing pair is
 * the interesting pair: a disagreement about something the ticket never
 * mentioned, and a ticket too vague to settle the argument at all. Ruling
 * 14: a vague ticket is a real finding about the writing step, and defaulting
 * it to "the check wins" would hide it.
 */

import { readMarkedSection, upsertMarkedSection } from "./body-sections.js";

/**
 * The four outcomes the judge (or the owner) may reach, in the order the
 * owner named them. `checks-wrong` is first because it is the one the whole
 * exercise exists to count.
 */
export const VERDICT_VALUES = [
  "checks-wrong",
  "builder-wrong",
  "neither-side",
  "ticket-silent",
] as const;

export type Verdict = (typeof VERDICT_VALUES)[number];

/** Who put the verdict on the ticket. `human` outranks `judge` — see
 *  {@link decideVerdictWrite}. */
export type VerdictDecidedBy = "judge" | "human";

/** The plain-English sentence for each verdict. One spelling, used by the
 *  rendered block and by the GitHub label description, so the ticket and
 *  the label can never describe the same outcome differently. */
export const VERDICT_MEANINGS: Record<Verdict, string> = {
  "checks-wrong": "the check was wrong — it did not test what the ticket asked for",
  "builder-wrong": "the builder was wrong — the code did not do what the ticket asked for",
  "neither-side": "neither side was about the ticket — the argument was over something else",
  "ticket-silent": "the ticket did not say — it never stated what was wanted here",
};

/** The GitHub label carrying a verdict. The BODY is the record; the label
 *  is only an index, so one query can count verdicts without fetching and
 *  parsing every ticket. {@link parseVerdictSection} is the only reader
 *  anything should trust. */
export function verdictLabelFor(verdict: Verdict): string {
  return `verdict:${verdict}`;
}

/**
 * "Somebody should rule this, and nobody has."
 *
 * A disagreement the screen check saw while only WATCHING never stops the
 * ticket and never wears a `stopped:*` label — issue #916 is explicit that
 * a watched verdict must not pretend anything was held back. Without a
 * label of its own it is therefore invisible to every query, and issue
 * #1117 acceptance 4 needs exactly those to be rulable: three of them were
 * already sitting unruled when this was written.
 *
 * This label says only "a ruling is owed here". It holds nothing back, so
 * issue #916's rule stands. {@link VERDICT_LABEL_DEFINITIONS} does not
 * include it, because it is not one of the four outcomes; it comes OFF the
 * ticket the moment a verdict goes on.
 */
export const VERDICT_NEEDED_LABEL = "verdict:needed";

/** The `verdict:needed` label's metadata, created alongside the four. */
export const VERDICT_NEEDED_LABEL_DEFINITION = {
  name: VERDICT_NEEDED_LABEL,
  color: "d4c5f9",
  description: "A disagreement nobody has ruled on yet: which side was wrong?",
} as const;

/**
 * Label metadata for every verdict, fed to `gh label create --force` at run
 * startup the same way the stop labels are. Descriptions are held under
 * GitHub's 100-character cap; `gh label create` rejects a longer one with
 * HTTP 422.
 */
export const VERDICT_LABEL_DEFINITIONS: ReadonlyArray<{
  readonly verdict: Verdict;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}> = VERDICT_VALUES.map((verdict) => ({
  verdict,
  name: verdictLabelFor(verdict),
  color: "5319e7",
  description: `Disagreement verdict: ${VERDICT_MEANINGS[verdict]}`.slice(0, 100),
}));

/** One verdict, everything the ticket records about it. */
export interface VerdictRecord {
  readonly verdict: Verdict;
  readonly decidedBy: VerdictDecidedBy;
  readonly whenIso: string;
  readonly runId?: string;
  /**
   * WHERE the argument came from — the browser check grading a screen, the
   * reviewer refusing over a check that went red, or the reviewer refusing on
   * grounds with no check behind it at all.
   *
   * **Recorded because the same four words mean different things on different
   * paths, and one of the differences is load-bearing.** `checks-wrong` on a
   * screen check means a check ran and demanded the wrong thing. The same word
   * on a `reviewer-no-check` refusal means there was no check at all — the
   * rendered sentence "the check was wrong" is then not true of that ticket,
   * and the `verdict:checks-wrong` label counts it beside the real ones.
   *
   * The number this exists to produce is "how often is the check itself the
   * wrong one" (issue #1117). Two unlike events under one label is how that
   * number quietly starts answering a different question. Optional so every
   * verdict written before this field existed, and every one the owner types
   * by hand, still reads.
   */
  readonly source?: string;
  /** Why this side was wrong, in plain English, drawn from the ticket. Never
   *  the figure the app produced and never the builder's code: "give it
   *  nothing it can use to make it go green on purpose". That is ruling 7 of
   *  the 2026-08-16 grilling in issue #923, whose numbering this file uses
   *  throughout; issue #1118 re-lists the same ruling as its ruling 6, so the
   *  ticket is named here rather than a bare number that reads wrong against
   *  whichever list the reader has open. */
  readonly why?: string;
  /**
   * The rulings this one replaced, oldest first — see
   * {@link carryVerdictHistory}. Absent on the ordinary ticket, which has been
   * ruled once.
   */
  readonly superseded?: readonly SupersededVerdict[];
}

/**
 * A ruling that was made, paid for, and later replaced by another.
 *
 * Deliberately NOT the full {@link VerdictRecord}: no `runId` and no nested
 * history, because it renders on one line and a nested chain of chains is
 * unreadable on a ticket. Everything that says WHICH RULING WAS MADE and on
 * what grounds is kept — losing the `source` would leave an earlier
 * `checks-wrong` unable to say whether a check even existed, which is the
 * split {@link verdictGrounds} exists to make.
 */
export interface SupersededVerdict {
  readonly verdict: Verdict;
  readonly decidedBy: VerdictDecidedBy;
  readonly whenIso: string;
  readonly source?: string;
  readonly why?: string;
}

/** The first words of the closing note. Shared by the writer and the
 *  reader, because the reader uses it to find where the free-text reason
 *  ends — two spellings of it would silently swallow the note into the
 *  reason. */
const OVERTURN_NOTE_START = "> **To overturn this:**";

const VERDICT_SECTION_START = "<!-- sandcastle:verdict:start -->";
const VERDICT_SECTION_END = "<!-- sandcastle:verdict:end -->";

/** The heading above the superseded rulings. Shared by the writer and the
 *  reader for the same reason {@link OVERTURN_NOTE_START} is. */
const SUPERSEDED_HEADING =
  "**Earlier rulings on this ticket, kept because each one was paid for:**";

/** The separator between an earlier ruling's fields. A middle dot, because it
 *  is not a character a plain-English reason ever contains — and the reason is
 *  the last field, so anything after the fourth separator is rejoined into it
 *  regardless. */
const SUPERSEDED_SEPARATOR = " · ";

/**
 * One earlier ruling, on one line.
 *
 * Flattened to a single line on purpose: the CURRENT ruling gets the full
 * multi-line treatment, and a ticket whose block grows a paragraph per night
 * stops being read at all. `**Why:**` is neutralised in the flattened text so
 * a quoted reason can never be mistaken for the current ruling's own reason
 * line by {@link parseVerdictSection}.
 */
function renderSupersededVerdict(s: SupersededVerdict): string {
  const flat = (s.why ?? "").replace(/\*\*Why:\*\*/g, "Why:").replace(/\s+/g, " ").trim();
  const fields = [
    `\`${s.verdict}\``,
    `decided by \`${s.decidedBy}\``,
    s.whenIso === "" ? "(no date recorded)" : s.whenIso,
    `argument came from \`${s.source ?? "(not stated)"}\``,
  ];
  if (flat.length > 0) fields.push(flat);
  return `- ${fields.join(SUPERSEDED_SEPARATOR)}`;
}

/** Read one earlier ruling back, or `undefined` when the line is not one.
 *  Strict about the verdict word for the same reason
 *  {@link parseVerdictSection} is: a typo must not become a fifth outcome. */
function parseSupersededVerdict(line: string): SupersededVerdict | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- `")) return undefined;
  const fields = trimmed.slice(2).split(SUPERSEDED_SEPARATOR);
  const verdict = VERDICT_VALUES.find((v) => v === /`([^`]*)`/.exec(fields[0] ?? "")?.[1]);
  if (verdict === undefined) return undefined;
  const decidedByRaw = /`([^`]*)`/.exec(fields[1] ?? "")?.[1];
  const sourceRaw = /`([^`]*)`/.exec(fields[3] ?? "")?.[1];
  const when = (fields[2] ?? "").trim();
  const why = fields.slice(4).join(SUPERSEDED_SEPARATOR).trim();
  return {
    verdict,
    // Same direction as {@link parseVerdictSection}: anything that is not
    // exactly `judge` is a person.
    decidedBy: decidedByRaw === "judge" ? "judge" : "human",
    whenIso: when === "(no date recorded)" ? "" : when,
    source: sourceRaw === undefined || sourceRaw === "(not stated)" ? undefined : sourceRaw,
    why: why.length > 0 ? why : undefined,
  };
}

/**
 * Render the verdict block. Pure string-building, no IO; `lib/state/gh.ts`
 * does the fetch-modify-write around it.
 *
 * Every machine-readable value is inside backticks on its own labelled
 * line, because a person is expected to retype one of them by hand. The
 * closing note tells them exactly which two lines to change and what the
 * four allowed words are — a correction that needs a document open
 * elsewhere is a correction that does not get made.
 */
export function buildVerdictSection(record: VerdictRecord): string {
  const lines = [
    "## Verdict: which side was wrong",
    "",
    `**Verdict:** \`${record.verdict}\``,
    `**Meaning:** ${VERDICT_MEANINGS[record.verdict]}`,
    `**Decided by:** \`${record.decidedBy}\``,
    `**When:** ${record.whenIso}`,
    `**Run:** ${record.runId ?? "(not stated)"}`,
    `**Argument came from:** ${record.source ?? "(not stated)"}`,
  ];
  // Above the current ruling's own reason, never below it: `**Why:**` opens
  // free text that runs to the closing note, so anything printed after it
  // would be read back as part of that reason.
  if (record.superseded !== undefined && record.superseded.length > 0) {
    lines.push(
      "",
      SUPERSEDED_HEADING,
      "",
      ...record.superseded.map(renderSupersededVerdict),
      "",
      "> The ruling above is the one that stands. These are kept because the run",
      "> paid for each of them, and a round that vanishes from the record cannot",
      "> be argued with.",
    );
  }
  if (record.why !== undefined && record.why.trim().length > 0) {
    lines.push("", "**Why:**", record.why.trim());
  }
  lines.push(
    "",
    `${OVERTURN_NOTE_START} change the word in backticks on the **Verdict** line`,
    "> to one of `checks-wrong`, `builder-wrong`, `neither-side`, `ticket-silent`,",
    "> and change the **Decided by** line to `human`. A verdict marked `human` is",
    "> never overwritten by the run. This block is the record — the `verdict:*`",
    "> label on this ticket is only an index and is re-synced on the next run.",
  );
  return lines.join("\n");
}

/**
 * Insert or replace the verdict block in an issue body, leaving everything
 * else — including the stop block and the watch-only block — untouched.
 */
export function upsertVerdictSection(body: string, section: string): string {
  return upsertMarkedSection(
    body,
    VERDICT_SECTION_START,
    VERDICT_SECTION_END,
    section,
  );
}

/** Find the one line labelled `**Field:**`, whatever its value looks like. */
function findFieldLine(section: string, field: string): string | undefined {
  const wanted = `**${field.toLowerCase()}:**`;
  return section
    .split("\n")
    .find((l) => l.trim().toLowerCase().startsWith(wanted));
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
 * Read a verdict back out of an issue body, or `undefined` when there is
 * none to read.
 *
 * Deliberately strict about the verdict word and forgiving about
 * everything else. A body whose verdict word is not one of the four is
 * reported as NO verdict rather than as some fifth kind — a typo in a
 * hand-edit must not become a new outcome that every tally then has to
 * cope with. The date, the run and the reason are decoration for a human
 * and never block the read.
 */
export function parseVerdictSection(body: string): VerdictRecord | undefined {
  const section = readMarkedSection(
    body,
    VERDICT_SECTION_START,
    VERDICT_SECTION_END,
  );
  if (section === undefined) return undefined;

  const raw = readBacktickedField(section, "Verdict");
  const verdict = VERDICT_VALUES.find((v) => v === raw);
  if (verdict === undefined) return undefined;

  // Anything that is not EXACTLY `judge` counts as a person.
  //
  // The direction matters. The run writes `judge` and nothing else, so any
  // other value is a hand edit — `Alex`, `me`, `human` with the backticks
  // rubbed out, a typo. Reading one of those as `judge` would let the next
  // night's run overwrite a correction the owner had just made, which is the
  // one thing {@link decideVerdictWrite} exists to prevent. Guessing wrong
  // this way costs a wasted judge round; guessing wrong the other way
  // destroys his answer.
  const decidedByRaw =
    readBacktickedField(section, "Decided by") ??
    readPlainField(section, "Decided by");
  const decidedBy: VerdictDecidedBy = decidedByRaw === "judge" ? "judge" : "human";

  // `why` runs up to the closing overturn note, NOT to the first line
  // beginning with `>`. A reason that quotes the ticket is ordinary, and
  // splitting on any quote mark would silently cut such a reason in half.
  const whyIdx = section.indexOf("**Why:**");
  const why =
    whyIdx === -1
      ? undefined
      : section
          .slice(whyIdx + "**Why:**".length)
          .split(OVERTURN_NOTE_START)[0]
          ?.trim();

  const supersededIdx = section.indexOf(SUPERSEDED_HEADING);
  const superseded =
    supersededIdx === -1
      ? []
      : section
          .slice(supersededIdx + SUPERSEDED_HEADING.length)
          .split("\n")
          .map(parseSupersededVerdict)
          .filter((s): s is SupersededVerdict => s !== undefined);

  return {
    verdict,
    decidedBy,
    whenIso: readPlainField(section, "When") ?? "",
    runId: readPlainField(section, "Run"),
    source: readPlainField(section, "Argument came from"),
    why: why !== undefined && why.length > 0 ? why : undefined,
    superseded: superseded.length > 0 ? superseded : undefined,
  };
}

/**
 * Fold the ruling already on the ticket into the incoming one, so the ticket
 * ends up carrying BOTH.
 *
 * **A ticket can be judged twice in one night, and both rounds were paid
 * for.** The reviewer refuses on pass 1 and the judge rules; the retry comes
 * back clear; then the screen check mismatches and the judge rules again. Until
 * this existed the second write simply replaced the first, so a ruling the run
 * had spent a judge round to reach vanished from the only place it was ever
 * recorded, and nobody could tell afterwards that it had happened at all.
 *
 * **The LAST ruling stands.** It is the better-informed one — it was made after
 * whatever the earlier round could not see — and it is the one the `verdict:*`
 * label and every count follow. Keeping the FIRST instead would freeze a
 * ticket at a ruling later evidence contradicted; recording both without
 * naming one current would leave nothing countable. So: last wins, earlier
 * ones are kept beside it and are never counted, which is why
 * {@link tallyVerdicts} still counts one ruling per ticket and cannot
 * double-count one.
 *
 * An identical re-ruling — same outcome, same decider, same grounds — is NOT
 * archived. Nothing was decided differently, so the only thing an entry would
 * add is an older timestamp, and a ticket re-run nightly would grow a line a
 * night saying the same thing.
 *
 * A history the caller supplied on `incoming` is ignored: the chain on the
 * ticket is the record, and this is the only thing that appends to it.
 */
export function carryVerdictHistory(
  existing: VerdictRecord | undefined,
  incoming: VerdictRecord,
): VerdictRecord {
  if (existing === undefined) return incoming;
  const sameRuling =
    existing.verdict === incoming.verdict &&
    existing.decidedBy === incoming.decidedBy &&
    existing.source === incoming.source;
  const history: SupersededVerdict[] = [...(existing.superseded ?? [])];
  if (!sameRuling) {
    history.push({
      verdict: existing.verdict,
      decidedBy: existing.decidedBy,
      whenIso: existing.whenIso,
      source: existing.source,
      why: existing.why,
    });
  }
  return history.length === 0 ? incoming : { ...incoming, superseded: history };
}

/**
 * Decide whether an incoming verdict may replace the one already on the
 * ticket.
 *
 * **A verdict a person set is never overwritten by the run.** Ruling 1 is
 * that the owner can overturn any verdict by editing the ticket, and the
 * judge was accepted at all only because he can. A judge that re-ruled over
 * his correction on the next night would make the correction worthless and
 * would quietly poison the one count this whole ticket exists to produce.
 *
 * A person may of course overturn their own earlier verdict — that is an
 * edit, not the run trampling one.
 */
export function decideVerdictWrite(
  existing: VerdictRecord | undefined,
  incoming: VerdictRecord,
): "write" | "keep-human" {
  if (existing === undefined) return "write";
  if (existing.decidedBy === "human" && incoming.decidedBy !== "human") {
    return "keep-human";
  }
  return "write";
}

/**
 * Was there a check behind the argument at all?
 *
 * **This is the split that decides whether the sentence "the check was wrong"
 * is true of a ticket**, and without it the one number this whole exercise
 * exists to produce answers a different question than its heading claims.
 *
 * The judge now rules on the reviewer's first refusal as well as on a screen
 * check. Most reviewer refusals have NO check behind them — poor code, a
 * house rule, missing proof the code was run — and `lib/judge/ruling.ts` calls
 * that "the single most common refusal there is". A `checks-wrong` ruling on
 * one of those is a statement about a ticket that never had a check, so
 * counting it beside a real wrong check inflates the figure with events of an
 * entirely different kind.
 *
 * - `with-check` — a check ran and could be the wrong one. THE figure.
 * - `no-check` — there was no check here. Counted, shown, never added in.
 * - `not-stated` — the source is missing or is a word this does not know.
 */
export const VERDICT_GROUNDS_VALUES = ["with-check", "no-check", "not-stated"] as const;

export type VerdictGrounds = (typeof VERDICT_GROUNDS_VALUES)[number];

/**
 * Sort one recorded `source` into its grounds.
 *
 * **An unknown or absent source is `not-stated`, never a guess.** Guessing
 * `with-check` would inflate the number; guessing `no-check` would hide real
 * wrong checks. Neither is a reading, so it gets its own pile and is shown
 * as its own pile. The three known words are the ones `DisagreementSource` in
 * `lib/judge/ruling.ts` emits; a fourth path added later lands in
 * `not-stated` and is visible there rather than quietly joining the figure.
 */
export function verdictGrounds(source: string | undefined): VerdictGrounds {
  switch (source?.trim().toLowerCase()) {
    case "screen-check":
    case "reviewer-red-check":
      return "with-check";
    case "reviewer-no-check":
      return "no-check";
    default:
      return "not-stated";
  }
}

/** A tally over a set of issue bodies: one count per verdict, plus the
 *  tickets carrying none. `unrecorded` is reported rather than dropped —
 *  eight disagreements with no verdict is the finding that started this
 *  ticket, so a tally that silently omits them repeats the fault.
 *
 *  `byGrounds` is the SAME rulings, split by {@link verdictGrounds}. The flat
 *  counts are kept beside it rather than replaced, so nothing recorded
 *  becomes invisible and no existing reader silently starts counting a
 *  subset. Every ruling lands in exactly one group, so the three groups add
 *  back up to the flat counts. */
export type VerdictTally = Record<Verdict, number> & {
  unrecorded: number;
  byGrounds: Record<VerdictGrounds, Record<Verdict, number>>;
};

function emptyVerdictCounts(): Record<Verdict, number> {
  const counts = {} as Record<Verdict, number>;
  for (const v of VERDICT_VALUES) counts[v] = 0;
  return counts;
}

export function tallyVerdicts(bodies: readonly string[]): VerdictTally {
  const byGrounds = {} as Record<VerdictGrounds, Record<Verdict, number>>;
  for (const g of VERDICT_GROUNDS_VALUES) byGrounds[g] = emptyVerdictCounts();
  const tally = { ...emptyVerdictCounts(), unrecorded: 0, byGrounds } as VerdictTally;
  for (const body of bodies) {
    const read = parseVerdictSection(body);
    if (read === undefined) {
      tally.unrecorded += 1;
      continue;
    }
    tally[read.verdict] += 1;
    byGrounds[verdictGrounds(read.source)][read.verdict] += 1;
  }
  return tally;
}

export { VERDICT_SECTION_START, VERDICT_SECTION_END };
