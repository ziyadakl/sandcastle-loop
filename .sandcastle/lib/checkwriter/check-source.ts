/**
 * Reading a check file's SOURCE without being fooled by it — the one scanner
 * both check-path rules share, and the one path-shape factory both use.
 *
 * ## Why this module exists (issue #956 follow-up)
 *
 * `check-path.ts` and `unit-check-path.ts` each grep a check the agent just
 * wrote: the browser rule needs "is `gradeScreenText` imported AND called", the
 * unit rule needs "does this import real product code". Both questions are only
 * answerable against source with COMMENTS REMOVED and STRING LITERALS
 * NEUTRALISED — otherwise a mention inside `// …` or `"…"` satisfies the
 * requirement and the guard grades a file that does nothing.
 *
 * That scanner was written twice, ~45 lines each, differing only in what they
 * emitted for a literal. The unit copy said so in its own doc and left it for a
 * follow-up, on the ground that `check-path.ts` was off limits in that slice.
 * It is not off limits any more — this branch edits it — so the duplication is
 * collapsed here rather than left as a comment describing itself. Hand-copied
 * duplication where a later tightening lands on one copy and the other keeps
 * quietly accepting what the tightening was meant to refuse is precisely the
 * defect class issue #956 exists to remove.
 *
 * Neutral by design: this module knows nothing about screens, runners, markers
 * or issue numbers, so neither check-path module has to depend on the other.
 */

import { escapeRegExp } from "../escape-regexp.js";

/**
 * The sentinel wrapping each captured literal's index inside its placeholder,
 * e.g. `"@@3@@"`.
 *
 * It cannot collide with real content, and that is a property of the
 * substitution rather than of the characters chosen: in the `placeholders` view
 * below the ONLY quote characters left are the ones this emits, because every
 * real quote opened a literal whose body was replaced. So `["']@@\d+@@["']` can
 * only ever match a placeholder, whatever a check file happens to contain.
 *
 * Deliberately plain ASCII. A NUL byte would be the textbook sentinel and it
 * was the first thing tried — but it makes the whole SOURCE FILE read as binary
 * to `grep`, which then reports no matches and exit 1 for every pattern,
 * including patterns that are present. A module nobody can grep is a module the
 * next person cannot audit.
 */
export const LITERAL_MARK = "@@";

/** The three views {@link scanCheckSource} produces, plus the captured bodies. */
export interface ScannedCheckSource {
  /**
   * Comments removed, string literals INTACT. What an import scan that needs to
   * READ the module specifier wants.
   */
  readonly withoutComments: string;
  /**
   * Comments removed AND every string/template body emptied, so a
   * `"…gradeScreenText(…)"` mention cannot pose as a call. What a CALL scan
   * wants.
   */
  readonly codeOnly: string;
  /**
   * Comments removed and every literal body replaced by a same-quoted
   * placeholder holding its index into {@link literals}.
   *
   * The view that does BOTH jobs at once, which is why it exists alongside the
   * other two rather than instead of them: the specifier is still recoverable
   * (via the index), and a literal's CONTENTS can never be read as code. An
   * import written INSIDE a string collapses to one opaque token, so the word
   * `import` is no longer present in the scanned text at all.
   */
  readonly placeholders: string;
  /** Each literal's body, in source order, indexed by its placeholder number. */
  readonly literals: readonly string[];
}

/**
 * One pass over `source`, producing every view a check-file scan can need.
 *
 * All three views are built in the same walk on purpose. They must agree about
 * where every comment and literal began and ended — two walks that disagreed by
 * one character would let a call be visible in one view and hidden in another,
 * which is a guard that reports different answers to the same question.
 *
 * TOTAL BY CONSTRUCTION: an unterminated comment or string simply consumes the
 * rest of the file, which can only ever HIDE an import or a call. Fail-closed,
 * in both callers.
 */
export function scanCheckSource(source: string): ScannedCheckSource {
  let withoutComments = "";
  let codeOnly = "";
  let placeholders = "";
  const literals: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let body = "";
      i++;
      while (i < source.length) {
        const d = source[i];
        if (d === "\\") {
          body += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        i++;
        if (d === quote) break;
        body += d;
      }
      withoutComments += `${quote}${body}${quote}`;
      // An EMPTY literal of the same quote style: the token survives for any
      // downstream scan, its contents cannot pose as code.
      codeOnly += `${quote}${quote}`;
      placeholders += `${quote}${LITERAL_MARK}${literals.length}${LITERAL_MARK}${quote}`;
      literals.push(body);
      continue;
    }
    withoutComments += c;
    codeOnly += c;
    placeholders += c;
    i++;
  }
  return { withoutComments, codeOnly, placeholders, literals };
}

/**
 * The one path shape both runners' relative-path rules are cut from, given the
 * extension that identifies the runner: a single path segment (or a shallow
 * nested one) of registry-safe characters, ending in `suffix` literally.
 *
 * ## Why a factory and not two regexes
 *
 * The browser rule is `.spec.ts` and the unit rule is `.test.ts`; everything
 * else about them is identical. Two hand-written literals is the same
 * duplication trap as the scanner above — a later tightening lands on one and
 * the other keeps accepting what the tightening was meant to refuse. So the
 * shape is expressed once, parameterised by the only thing that differs.
 *
 * A WHITELIST, not a blacklist: the value is interpolated into a filesystem
 * path and, downstream, into a shell string.
 *
 * The suffix is escaped before use — `.test.ts` contains regex-significant
 * dots, and an unescaped `.` would make `xxtestxts` a legal check filename.
 */
export function checkRelativePathPattern(suffix: string): RegExp {
  const segment = "[a-zA-Z0-9][a-zA-Z0-9._-]*";
  const literalSuffix = escapeRegExp(suffix);
  return new RegExp(`^${segment}(?:/${segment})*${literalSuffix}$`);
}
