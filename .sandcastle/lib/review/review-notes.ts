/**
 * The approving reviewer's two REPORT-ONLY rows, and the pure parser that
 * reads them (spec #1334 follow-on). No IO, no GitHub.
 *
 * `review-prompt.md`'s CATEGORY SWEEP carries two rows that never change the
 * verdict:
 *
 *   - Structure (quality rubric): OK | N/A (<reason>) | FINDING: <one line>
 *   - First-test strength: STRONG | WEAK: <one line why> | N/A (<reason>)
 *
 * Read off the review whose `ALL_CLEAR` shipped the ticket, a `FINDING`
 * becomes the `shipped-with-structure-finding` label and a `WEAK` becomes
 * `shipped-with-weak-first-test`, each with its one line in the run report.
 * That is ALL they can do (ADR 0015 rule 4: the owner's review is the last
 * guard). A row that is missing, unreadable, or anything but those tokens is
 * no note — never a stop, never an error.
 *
 * {@link REPORT_ONLY_SWEEP_ROWS} is why they cannot do more: the sweep parser
 * (`extractCategorySweep` in `main.mts`) skips them, so a structure finding
 * can never be counted as a blocker, grant a third review round, or deny one.
 */

/** What the approving review reported. Both absent on an ordinary ticket. */
export interface ReviewNotes {
  /** The reviewer's one line, when its Structure row said `FINDING`. */
  readonly structureFinding?: string;
  /** The reviewer's one line, when its First-test strength row said `WEAK`. */
  readonly weakFirstTest?: string;
}

const STRUCTURE_ROW = "structure (quality rubric)";
const FIRST_TEST_STRENGTH_ROW = "first-test strength";

/** The sweep categories (lowercased, emphasis stripped — the key
 *  `extractCategorySweep` builds) that are report-only. */
export const REPORT_ONLY_SWEEP_ROWS: ReadonlySet<string> = new Set([
  STRUCTURE_ROW,
  FIRST_TEST_STRENGTH_ROW,
]);

/** Longest one-line note carried into a label's run-report line. */
const MAX_NOTE_CHARS = 200;

const stripEmphasis = (s: string): string =>
  s.replace(/^[\s*_`]+|[\s*_`]+$/g, "");

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_NOTE_CHARS
    ? `${flat.slice(0, MAX_NOTE_CHARS - 1)}…`
    : flat;
}

/**
 * The text after `token` (e.g. `FINDING`) at the front of `value`, or
 * `undefined` when the value does not start with that token. The text may
 * follow a colon (`WEAK: why`) or sit in brackets (`WEAK (why)`); a bare token
 * gives `""`.
 */
function afterToken(value: string, token: string): string | undefined {
  const m = new RegExp(
    `^${token}[*_\`]*\\s*(?::\\s*(.*)|\\((.*)\\))?$`,
    "i",
  ).exec(stripEmphasis(value));
  if (m === null) return undefined;
  return stripEmphasis(m[1] ?? m[2] ?? "");
}

/**
 * Read the two report-only rows anywhere in `stdout`. The first `FINDING` /
 * `WEAK` wins, so a duplicated row can only keep a note, never lose one.
 */
export function readReviewNotes(stdout: string): ReviewNotes {
  let structureFinding: string | undefined;
  let weakFirstTest: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const bullet = /^\s*-\s*(.+?)\s*:\s+(.*)$/.exec(line);
    if (bullet === null) continue;
    const row = stripEmphasis(bullet[1]!).toLowerCase();
    const value = bullet[2]!;
    if (row === STRUCTURE_ROW && structureFinding === undefined) {
      const text = afterToken(value, "finding");
      if (text !== undefined && text.length > 0) structureFinding = oneLine(text);
    } else if (row === FIRST_TEST_STRENGTH_ROW && weakFirstTest === undefined) {
      const text = afterToken(value, "weak");
      if (text !== undefined) {
        weakFirstTest = text.length > 0 ? oneLine(text) : "no reason given";
      }
    }
  }
  return {
    ...(structureFinding !== undefined ? { structureFinding } : {}),
    ...(weakFirstTest !== undefined ? { weakFirstTest } : {}),
  };
}
