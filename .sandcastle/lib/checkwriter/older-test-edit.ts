/**
 * MAY THIS DIFF EDIT AN OLDER TICKET'S TEST? — the pure half of the ship
 * gate's older-test rule (spec #1334, slice SH).
 *
 * Every ticket the loop ships leaves a test behind under
 * `apps/nextjs/e2e/checks/issue-<N>/` or `packages/<p>/src/__checks__/issue-<N>/`
 * that pins the rule as it stood that night. When a later ticket changes one
 * of those rules, the older test goes red on correct code (#1235 and #1058's
 * cross-Team relist guard, 2026-09-10). The builder or the fixer may then
 * edit that older test, but only when all four hold:
 *
 *   1. the loop ran the ORIGINAL older test against the new code and saw it
 *      fail (run by `verifyOlderTestEdits` in `main.mts`, never here);
 *   2. the edit stays inside that one test file — nothing else in the older
 *      ticket's folder (its proof receipt, a fixture, a helper) changes, and
 *      the file is modified in place, never added;
 *   3. the file's test-case count is unchanged;
 *   4. no skip / only / todo / fails / skipIf / runIf was added.
 *
 * This module answers rules 2-4 and the location of each file, from bytes the
 * host read itself. Pure: no git, no fs, no clock, no agent.
 */

import { checksRoot } from "./check-path.js";
import { UNIT_CHECK_DIR_SEGMENT } from "./unit-check-path.js";
import {
  browserCheckLocation,
  unitCheckLocation,
  type CheckLocation,
} from "./must-fail-first-receipt.js";
import { escapeRegExp } from "../escape-regexp.js";

/**
 * How many DIFFERENT older tickets one diff may edit the tests of. A ticket
 * whose rule change breaks four other tickets' tests is a product decision for
 * a person, not something to push through the ship gate.
 */
export const MAX_OLDER_TICKETS_EDITED = 3;

/** One older ticket's test file, resolved to the location every command
 *  builder takes. */
export interface OlderCheck {
  /** Repo-relative, POSIX-separated path of the test file. */
  readonly path: string;
  /** The OLDER ticket whose test this is. */
  readonly issueNumber: number;
  /** The host package, on the unit route only. */
  readonly packageDir?: string;
  readonly location: CheckLocation;
}

/** A BROWSER check: `<checksRoot>/issue-<N>/<file>.spec.ts`. */
const browserCheckRe = (): RegExp =>
  new RegExp(`^${escapeRegExp(checksRoot())}/issue-(\\d+)/(.+\\.spec\\.ts)$`);

/** A UNIT check: `packages/<p>/src/__checks__/issue-<N>/<file>.test.ts`. */
const UNIT_CHECK_RE = new RegExp(
  `^(packages/[^/]+)/src/${UNIT_CHECK_DIR_SEGMENT}/issue-(\\d+)/(.+\\.test\\.ts)$`,
);

/**
 * The older test file at `repoPath`, or `undefined` when the path is not a
 * test file of a ticket's check folder (a proof receipt, a fixture, a helper,
 * ordinary source) or carries `..`.
 */
export function olderCheckAt(repoPath: string): OlderCheck | undefined {
  if (typeof repoPath !== "string" || repoPath.split("/").includes("..")) {
    return undefined;
  }
  const browser = browserCheckRe().exec(repoPath);
  if (browser !== null) {
    const location = browserCheckLocation(Number(browser[1]), browser[2]!);
    if (location === undefined) return undefined;
    return { path: repoPath, issueNumber: location.issueNumber, location };
  }
  const unit = UNIT_CHECK_RE.exec(repoPath);
  if (unit !== null) {
    const packageDir = unit[1]!;
    const location = unitCheckLocation(Number(unit[2]), packageDir, unit[3]!);
    if (location === undefined) return undefined;
    return {
      path: repoPath,
      issueNumber: location.issueNumber,
      packageDir,
      location,
    };
  }
  return undefined;
}

/** How many live cases a check file holds, and how many are switched off. */
export interface TestCaseCounts {
  /** An `it` / `test` call opening a line, in ANY of vitest's call forms —
   *  `it(`, `test(`, `it.each(`, `it.concurrent(`, `test.skipIf(…)(`,
   *  ``it.each` `` — counted once each. A form whose modifier chain switches
   *  the case OFF is not one of these; see {@link countTestCases}. */
  readonly cases: number;
  /** A call whose modifier chain switches cases off: `it.skip(`, `test.todo(`,
   *  `it.fails(`, `it.only(`, `describe.skip(`, `describe.only(`. */
  readonly disabled: number;
}

/**
 * The modifier names that switch a case, or a whole block, OFF.
 *
 * `only` belongs with `skip` here even though it reads as an emphasis rather
 * than a removal: it switches every OTHER case in the file off, so an edit
 * that adds one has taken assertions away exactly as surely as one that
 * skipped them, and {@link planOlderTestEdits} must refuse the rise.
 *
 * The trailing `(?![\w$])` is what keeps `skipIf` and `runIf` — CONDITIONAL
 * cases, which ordinarily run — out of this set. Without it `it.skipIf(` would
 * read as a skip and a perfectly live case would count on the wrong side.
 */
const DISABLING_MODIFIER_SRC = "(?:skip|todo|only|fails)(?![\\w$])";

/** The call's own opening: `(`, or the backtick of ``it.each` ``'s table. */
const CALL_OPEN_SRC = "\\s*[(`]";

/**
 * Live cases: `it` or `test` opening a line, then ANY chain of modifiers none
 * of which switches the case off, then the call's own opening.
 *
 * The per-segment negative lookahead is what keeps the two counts DISJOINT
 * without a second subtracting pass: on `it.skip(` the one segment fails the
 * lookahead, the chain then matches zero segments, and `.skip(` is not an
 * opening — so the line yields no live match at all.
 */
const LIVE_CASE_RE = new RegExp(
  "^\\s*(?:it|test)(?:\\.(?!" +
    DISABLING_MODIFIER_SRC +
    ")\\w+)*" +
    CALL_OPEN_SRC,
  "gm",
);

/**
 * Switched-off cases: any `it` / `test` / `describe` call whose modifier chain
 * holds one of the disabling names.
 *
 * `describe` is counted HERE and never as a live case. A `describe.skip(` line
 * switches every case inside its block off while those cases' own `it(` lines
 * still count exactly as they did — so without this arm the single strongest
 * way to gut a check moves neither number and the verdict waves it through.
 */
const DISABLED_CASE_RE = new RegExp(
  "^\\s*(?:it|test|describe)(?:\\.\\w+)*\\." +
    DISABLING_MODIFIER_SRC +
    "(?:\\.\\w+)*" +
    CALL_OPEN_SRC,
  "gm",
);

/**
 * Count the cases in a check file's source.
 *
 * Line-anchored on purpose: a mention of `it(` inside a comment or a string
 * must not inflate a number the gate then compares. The two counts
 * are deliberately DISJOINT — `it.skip(` matches the disabled pattern and not
 * the live one — so converting a live case into a skipped one moves both
 * numbers at once, and either move alone is enough for
 * {@link planOlderTestEdits} to refuse.
 *
 * BOTH PATTERNS ARE MODIFIER-AWARE, and that is load-bearing rather than
 * tidiness. They used to read `it(`/`test(` and `it.skip(`/`.todo(`/`.fails(`
 * literally, so a file written entirely in `it.each(` counted ZERO cases on
 * both sides of an edit and every one of them could have been deleted under a
 * verdict that saw nothing move; and `describe.skip(`, `describe.only(` and
 * `it.only(` — three lines that switch other people's assertions off — moved
 * neither count either.
 *
 * Total: a non-string answers zeros.
 */
export function countTestCases(source: string): TestCaseCounts {
  if (typeof source !== "string" || source.length === 0) {
    return { cases: 0, disabled: 0 };
  }
  return {
    cases: source.match(LIVE_CASE_RE)?.length ?? 0,
    disabled: source.match(DISABLED_CASE_RE)?.length ?? 0,
  };
}


/**
 * Conditional cases — `.skipIf(` / `.runIf(` anywhere in a call chain.
 * {@link countTestCases} counts them LIVE on purpose (`describe.skipIf(!RUN)`
 * is the `packages/db` convention), so `it.skipIf(true)(` would otherwise
 * switch a case off without moving either count. Rule 4 refuses any rise.
 */
const CONDITIONAL_RE = /\.(?:skipIf|runIf)\s*\(/g;

export function countConditionalCases(source: string): number {
  if (typeof source !== "string") return 0;
  return source.match(CONDITIONAL_RE)?.length ?? 0;
}

/** One file of an older ticket's check folder the finished diff touched,
 *  with the bytes the host read on each side. */
export interface OlderTestTouch {
  readonly path: string;
  /** The file's bytes at the diff's base; `undefined` = not there. */
  readonly before: string | undefined;
  /** The file's bytes at the diff's head; `undefined` = not there. */
  readonly after: string | undefined;
}

/** What the gate must still do, or why the edit is refused. */
export type OlderTestEditPlan =
  | {
      readonly ok: true;
      /** Modified older tests, each still to be run red (original) and
       *  green (edited). */
      readonly edited: readonly OlderCheck[];
      /** Older tests the ticket's own body pre-authorised it to delete. */
      readonly deleted: readonly string[];
    }
  | {
      readonly ok: false;
      readonly because: string;
      /** The files the refusal is about — what the fixer should look at. */
      readonly paths: readonly string[];
    };

const refuse = (
  because: string,
  paths: readonly string[],
): OlderTestEditPlan => ({ ok: false, because, paths });

/**
 * Rules 2-4, and the deletion carve-out, over every older-check file the
 * diff touched. Cheap and total: it runs before any graded run, so a refusal
 * costs nothing.
 *
 * A deletion is allowed only when the ticket's own body names the file
 * (`Deletes-test:`, `preauthorizedTestDeletions`) — then it is neither run
 * nor recorded as an edit.
 */
export function planOlderTestEdits(opts: {
  readonly touched: readonly OlderTestTouch[];
  readonly preauthorizedDeletions: readonly string[];
}): OlderTestEditPlan {
  const touched = Array.isArray(opts.touched) ? opts.touched : [];
  const mayDelete = new Set(
    Array.isArray(opts.preauthorizedDeletions) ? opts.preauthorizedDeletions : [],
  );
  const notTests = touched
    .filter((t) => olderCheckAt(t.path) === undefined)
    .map((t) => t.path);
  if (notTests.length > 0) {
    return refuse(
      `it changes ${notTests.join(", ")}, which is not an older ticket's test ` +
        `file but something else in its check folder (a proof receipt, a ` +
        `fixture or a helper). Only the test file itself may be edited — put ` +
        `these back exactly as they were`,
      notTests,
    );
  }
  const tickets = new Set(touched.map((t) => olderCheckAt(t.path)!.issueNumber));
  if (tickets.size > MAX_OLDER_TICKETS_EDITED) {
    return refuse(
      `it edits the tests of ${tickets.size} older tickets, past the limit of ` +
        `${MAX_OLDER_TICKETS_EDITED}. A rule change that breaks that many is ` +
        `a decision for a person`,
      touched.map((t) => t.path),
    );
  }
  const edited: OlderCheck[] = [];
  const deleted: string[] = [];
  for (const t of touched) {
    const check = olderCheckAt(t.path)!;
    if (t.before === undefined) {
      return refuse(
        `it ADDS ${t.path} to an older ticket's check folder. An older ` +
          `ticket's test may be edited in place, never added to`,
        [t.path],
      );
    }
    if (t.after === undefined) {
      if (mayDelete.has(t.path)) {
        deleted.push(t.path);
        continue;
      }
      return refuse(
        `it DELETES ${t.path}, and this ticket's own text does not name that ` +
          `file on a \`Deletes-test:\` line`,
        [t.path],
      );
    }
    const b = countTestCases(t.before);
    const a = countTestCases(t.after);
    if (a.cases !== b.cases) {
      return refuse(
        `${t.path} went from ${b.cases} test case(s) to ${a.cases} — an edit ` +
          `may change what a case asserts, never how many there are`,
        [t.path],
      );
    }
    if (a.disabled > b.disabled) {
      return refuse(
        `${t.path} now switches off ${a.disabled} test case(s) where it ` +
          `switched off ${b.disabled} (skip / only / todo / fails) — switching ` +
          `a case off is not amending it`,
        [t.path],
      );
    }
    const cb = countConditionalCases(t.before);
    const ca = countConditionalCases(t.after);
    if (ca > cb) {
      return refuse(
        `${t.path} now carries ${ca} skipIf / runIf condition(s) where it ` +
          `carried ${cb} — a new condition can switch a case off`,
        [t.path],
      );
    }
    edited.push(check);
  }
  edited.sort((x, y) => x.path.localeCompare(y.path));
  deleted.sort();
  return { ok: true, edited, deleted };
}
