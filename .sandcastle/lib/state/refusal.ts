/**
 * Whether a REFUSED ticket was refused correctly (issue #1096).
 *
 * ## The hole this closes
 *
 * When the loop refuses a ticket — the reviewer read the finished code and
 * would not pass it, after every retry the run allows — it stamps the ticket
 * `stopped:reviewer-refused` and stops. It has done this thirteen times across
 * nine runs. Nobody could tell how many of those refusals were CORRECT: eight
 * of the thirteen came from one night, and seven of those eight were later
 * built by hand and shipped. The work was good enough. It was refused anyway,
 * at full cost, and a fair refusal and a wrong one looked identical for ever.
 *
 * ## Where the answer lives — the BODY, not run telemetry
 *
 * Grilling decision, 2026-08-25: the refusal and the later close happen on
 * DIFFERENT runs, so a per-run telemetry record cannot span the gap. The
 * record lives on the ticket body, this repo's own home for state. When the
 * loop refuses, it stamps an empty checkbox; whoever later builds the ticket
 * by hand and closes it ticks whether the refusal was correct or wrong. No
 * hard block on closing — thirteen refusals ever, the volume is tiny.
 *
 * This module is PURE — string building and parsing, no `gh`, no clock — so
 * the stamp the loop writes and the reading a report takes back off it are
 * both testable without standing up the pipeline or touching GitHub.
 */

/**
 * A stable anchor so the stamp is found by a marker, never by matching its
 * prose. The wording of the checkbox may be tuned later; a reader keyed on the
 * words would then silently stop finding it. Kept OUT of the checkbox lines
 * themselves so a person editing the body by hand cannot delete it by ticking.
 */
export const REFUSAL_OUTCOME_ANCHOR = "<!-- sandcastle:refusal-outcome -->";

/** How a refusal turned out, once someone has judged it — or that nobody has. */
export type RefusalOutcome =
  | "correct" // the code really was not good enough; the refusal saved money
  | "wrong" // the work was later built by hand and shipped; the refusal cost a build for nothing
  | "unjudged" // stamped, but nobody has ticked a box yet
  | "ambiguous"; // both boxes ticked — a hand-edit slip, counted apart from either answer

/** What {@link parseRefusalRecord} reads back off one ticket body. */
export interface RefusalRecord {
  readonly outcome: RefusalOutcome;
  /** The run that refused it, from the stop section header. `undefined` when
   *  the header is absent (an older stamp, or a hand-mangled body). */
  readonly runId?: string;
  /** The ISO instant the refusal was written, from the stop section header. */
  readonly whenIso?: string;
}

/**
 * Render the outcome checkbox appended to a reviewer-refusal's body section.
 *
 * A GitHub task list (`- [ ] …`), not the bare `[ ] correct [ ] wrong` the
 * grilling sketched: a checkbox only becomes clickable when it is a list item,
 * and a person closing the ticket should be able to tick it in the UI rather
 * than hand-edit raw markdown. The `why` is the one-line reason the refusal
 * happened, so whoever closes the ticket can judge it without reading the whole
 * section.
 */
export function renderRefusalOutcomeCheckbox(why: string): string {
  const reason = why.trim() === "" ? "(not recorded)" : why.trim();
  return [
    "",
    "---",
    "",
    REFUSAL_OUTCOME_ANCHOR,
    "**Was this refusal correct?** Whoever later builds this ticket by hand and",
    "closes it ticks one box — the refusal rule cannot be tuned until wrong",
    "refusals are countable (#1096).",
    "",
    "- [ ] correct — the code really was not good enough; the refusal saved a bad merge",
    "- [ ] wrong — the work was later built by hand and shipped; the refusal cost a full build for nothing",
    "",
    `Why it was refused: ${reason}`,
  ].join("\n");
}

/** Read one task-list checkbox's ticked state by its trailing label. Matches
 *  `- [ ] correct …` and `- [x] correct …` (any case, extra spaces), and
 *  returns `undefined` when the item is not present at all. */
function readCheckbox(body: string, label: string): boolean | undefined {
  const re = new RegExp(
    `^\\s*[-*]\\s*\\[( |x|X)\\]\\s*${label}\\b`,
    "m",
  );
  const m = re.exec(body);
  if (m === null) return undefined;
  return m[1] === "x" || m[1] === "X";
}

/** Pull a `**Field:** value` line's value out of a body, or `undefined`. */
function readHeaderField(body: string, field: string): string | undefined {
  const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`);
  const m = re.exec(body);
  const value = m?.[1]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Read the refusal-outcome record off a ticket body, or `undefined` when the
 * ticket carries no refusal stamp at all.
 *
 * Keyed on {@link REFUSAL_OUTCOME_ANCHOR}, never on the prose. A body without
 * the anchor is reported as "no refusal recorded" — the reverse (parsing an
 * unrelated ticket as a refusal) would put a phantom into the very count this
 * exists to produce.
 */
export function parseRefusalRecord(body: string): RefusalRecord | undefined {
  if (!body.includes(REFUSAL_OUTCOME_ANCHOR)) return undefined;

  const correct = readCheckbox(body, "correct") ?? false;
  const wrong = readCheckbox(body, "wrong") ?? false;
  const outcome: RefusalOutcome =
    correct && wrong
      ? "ambiguous"
      : wrong
        ? "wrong"
        : correct
          ? "correct"
          : "unjudged";

  return {
    outcome,
    runId: readHeaderField(body, "Run"),
    whenIso: readHeaderField(body, "When"),
  };
}
