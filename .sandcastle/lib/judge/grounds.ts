/**
 * The reviewer's GROUNDS declaration — the one line that tells the run WHY a
 * reviewer refused, and the pure parser that reads it. No IO, no agent
 * dispatch, no GitHub. Under `lib/judge/` for the reason `check-freeze.ts`'s
 * header gives; the reviewer, not a judge, writes the line it reads.
 *
 * ## Why the reviewer has to say it, rather than the run working it out
 *
 * At reviewer-refusal time the run knows nothing about why the reviewer
 * objected — the screen check runs AFTER the reviewer approves. So the
 * reviewer DECLARES its grounds in one line, and this function reads that
 * declaration mechanically. Nothing here interprets prose; it matches three
 * fixed tokens, exactly as `extractCategorySweep` in `main.mts` matches the
 * sweep's three.
 *
 * - `RED-CHECK` — a check ran and failed against the code. The code is the
 *   side to fix: an ordinary builder round.
 * - `NO-CHECK` — the objection has no check behind it (poor code, a house
 *   rule, missing proof). Also an ordinary builder round.
 * - `WRONG-CHECK` — THIS ticket's own first test contradicts the ticket
 *   (spec #1334). The one grounds that sends the test-writing AI back to
 *   rewrite its test, once, with the reviewer's reason. The judge that used to
 *   decide this from a RED-CHECK is gone; the reviewer now says it outright.
 *
 * ## Which way this fails, and why that direction
 *
 * `"unreadable"` is not a fourth grounds. It is the honest answer "the
 * reviewer did not tell us", and it is deliberately NOT collapsed into a token
 * here.
 *
 * On duplicates, the most conservative reading wins:
 * `no-check` > `unreadable` > `red-check` > `wrong-check`.
 *
 * - `WRONG-CHECK` is the loosest because it is the only grounds that spends
 *   something other than a builder round — the ticket's one test rewrite.
 *   A reviewer that also declared anything else did not say plainly that the
 *   test, rather than the code, is the problem, so the rewrite is not spent.
 * - A clean `RED-CHECK` alongside an unreadable grounds line loses to the
 *   unreadable one. The run cannot tell whether the line it failed to read was
 *   the stricter answer.
 *
 * ## What this function does NOT decide
 *
 * **The caller decides what `"unreadable"` becomes, not this parser.** The
 * run treats it as an ordinary refusal (a builder round), and says so in the
 * log where the reviewer's line can be quoted back. This function stays honest
 * so the caller can be strict out loud.
 */

/**
 * What the reviewer declared, or the honest admission that it declared nothing
 * the run could read.
 */
export type ReviewerGrounds =
  | "reviewer-red-check"
  | "reviewer-no-check"
  | "reviewer-wrong-check"
  | "unreadable";

/**
 * A whole line that is a grounds declaration: optional markdown emphasis, the
 * word `GROUNDS`, an optional space, a colon, then the value. Anchored to the
 * line start so a prose mention — "I nearly wrote GROUNDS: RED-CHECK here" —
 * cannot be read as a declaration.
 */
const GROUNDS_LINE = /^[*_`]*\s*grounds\s*:\s*(.*)$/i;

/**
 * The token, and nothing that merely starts with it. The trailing guard is
 * what keeps `RED-CHECKING` from being read as `RED-CHECK` plus a complaint.
 */
const GROUNDS_TOKEN = /^(red-check|no-check|wrong-check)(?![\w-])\s*(.*)$/i;

/**
 * True when `rest` is exactly ONE balanced parenthetical group that closes the
 * line (a trailing full stop is tolerated). Written as a scan rather than a
 * regex because a nested group — `(re-run by me: (2 failed))` — is legitimate
 * evidence prose, and no regex can tell that closing bracket from the one in
 * `(a) junk (b)`.
 *
 * ## Why this is exported, and why this file is its only home
 *
 * The category sweep in `main.mts` (`classifySweepStatus`) asks the identical
 * question of its own bullets, and until issue #1133 it carried its own copy.
 * Two copies of a fail-OPEN parser is the worst shape available: the fault
 * this scan exists to stop — a reviewer's complaint hung off a clean token and
 * recorded as agreement — would be fixed in one copy and left standing in the
 * other. So there is one body, and it lives here, beside the pure grounds
 * parser rather than inside the orchestrator, because it can be tested here.
 *
 * **The two copies were NOT identical, and the difference is why the guard
 * below is on the first line.** The `main.mts` copy had no `startsWith("(")`
 * guard: its one caller's regex captured the remainder as `(\(.*)`, so the
 * opening bracket was guaranteed by the caller. Handed anything else — `abc
 * (x)` — that copy answered `true`, because it only ever counts depth from
 * wherever the first bracket happens to be. This file's caller offers no such
 * guarantee, so the guard is required here and is a no-op there. The guarded
 * body is therefore correct for both callers, and it is the one that survived.
 */
export function isOneBalancedGroup(rest: string): boolean {
  if (!rest.startsWith("(")) return false;
  let depth = 0;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i]!;
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch !== ")") continue;
    depth -= 1;
    if (depth < 0) return false;
    // The group closed. Nothing but a full stop may follow it.
    if (depth === 0) return /^\.?$/.test(rest.slice(i + 1).trim());
  }
  // Never closed — an unbalanced opener is not a recognised declaration.
  return false;
}

/** One declaration line, read: its grounds, and — for a clean token — the
 *  text inside its one parenthetical (empty when it carried none). */
interface GroundsLine {
  readonly grounds: ReviewerGrounds;
  readonly evidence: string;
}

const TOKEN_GROUNDS: Readonly<Record<string, ReviewerGrounds>> = {
  "red-check": "reviewer-red-check",
  "no-check": "reviewer-no-check",
  "wrong-check": "reviewer-wrong-check",
};

/** Classify the value written after `GROUNDS:` on a single declaration line. */
function classifyValue(rawValue: string): GroundsLine {
  // Strip the closing half of any markdown emphasis wrapping the whole line
  // (`**GROUNDS: RED-CHECK**`), which the opening match already ate at the
  // front. Only the emphasis characters go; a stray word does not.
  const value = rawValue.replace(/[*_`]+\s*$/, "").trim();
  const token = GROUNDS_TOKEN.exec(value);
  if (!token) return { grounds: "unreadable", evidence: "" };
  const grounds = TOKEN_GROUNDS[token[1]!.toLowerCase()]!;
  const rest = token[2]!.trim();
  // The token comes first, and the line ends where the token — or its one
  // balanced parenthetical of evidence — ends. A complaint hung off a token is
  // not a clean token, exactly as in the category sweep.
  if (rest.length === 0) return { grounds, evidence: "" };
  if (isOneBalancedGroup(rest)) {
    return { grounds, evidence: rest.slice(1, rest.lastIndexOf(")")).trim() };
  }
  return { grounds: "unreadable", evidence: "" };
}

/** Most conservative first — see the module comment. */
const RANK: Readonly<Record<ReviewerGrounds, number>> = {
  "reviewer-no-check": 3,
  unreadable: 2,
  "reviewer-red-check": 1,
  "reviewer-wrong-check": 0,
};

function readGrounds(stdout: string): GroundsLine | null {
  let best: GroundsLine | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const match = GROUNDS_LINE.exec(line.trim());
    if (!match) continue;
    const found = classifyValue(match[1]!);
    if (best === null || RANK[found.grounds] > RANK[best.grounds]) best = found;
  }
  return best;
}

/**
 * Read the reviewer's grounds out of its raw output.
 *
 * Pure and total. Every input has an answer, and the answer is the same every
 * time — which is the point: whether the run rewrites a test or sends the
 * code back for a fix round cannot depend on an agent's
 * mood.
 *
 * Returns `"unreadable"` when no grounds line appears at all, and when one
 * appears but says nothing the run can read. See the module comment for why
 * those two share an answer, and why the caller — not this function — decides
 * what that answer costs the ticket.
 */
export function parseReviewerGrounds(stdout: string): ReviewerGrounds {
  return readGrounds(stdout)?.grounds ?? "unreadable";
}

/**
 * The reviewer's own reason for `GROUNDS: WRONG-CHECK` — the text inside its
 * parenthetical, which `review-prompt.md` asks to name the test file and what
 * it gets wrong. `undefined` when the grounds, read as a whole, are anything
 * but `WRONG-CHECK`; `""` when the token carried no parenthetical.
 *
 * Feeds the rewrite brief the test-writing AI gets (spec #1334): the reason
 * comes from the reviewer, in its own words, never from the host's guess.
 */
export function wrongCheckReasonIn(stdout: string): string | undefined {
  const read = readGrounds(stdout);
  return read?.grounds === "reviewer-wrong-check" ? read.evidence : undefined;
}
