/**
 * Single source of truth for "this assertion-line quote is generic / vacuous"
 * (Wave 3 / M7).
 *
 * Two consumers:
 *
 *   1. `src/verdicts/schemas.ts` — the implementer-output Zod schema rejects a
 *      `STORY_COMPLETE` envelope whose `e2eAssertionLine` matches any of the
 *      patterns here.
 *
 *   2. `src/loop/briefing.ts` — the reviewer prompt's "EVIDENCE QUOTE — STRICT
 *      verification" block lists the forbidden patterns in human-readable form
 *      so the reviewer rejects identical lines.
 *
 * Pre-Wave-3 the schema covered 3 patterns (empty, `Running N tests`, bare
 * URL) while the reviewer prompt covered 9. The mismatch let vacuous lines
 * sneak through the schema and be rubber-stamped by the reviewer (which
 * couldn't actually see them — the schema rejected first).
 *
 * Adding a new forbidden line means: append to the `RawPattern` union below,
 * add a human description to `FORBIDDEN_LINES_DESCRIPTIONS`, and update the
 * tests in `tests/forbidden-lines.test.ts`. The schema and prompt pick up the
 * change automatically.
 */

/**
 * One forbidden-line check. RegExp tested with `re.test(line)`; predicate
 * called with the raw line. Either form is fine — predicates exist so we can
 * express "a line that is exactly the word `passed` (case-insensitive,
 * surrounded only by whitespace)" without writing an unreadable regex.
 */
export type ForbiddenLinePattern = RegExp | ((line: string) => boolean);

/**
 * The 9 forbidden assertion-line patterns. Order is informational only — the
 * `isGenericAssertionLine` check returns true on the FIRST match.
 *
 *   1. Empty / whitespace-only
 *   2. `Running N tests` / `Running 1 test using 1 worker` (case-insensitive)
 *   3. Bare URL line
 *   4. `<paste line>` / `<the quoted line>` placeholders
 *   5. `using N worker` / `using N workers` (case-insensitive)
 *   6. `Workers:` (case-insensitive)
 *   7. `Slow test file` (case-insensitive)
 *   8. `[chromium]` alone (no leading ✓ / ✔ / PASS)
 *   9. Standalone words `passed`, `failed`, or `all green` on a line
 */
export const GENERIC_ASSERTION_LINE_PATTERNS: readonly ForbiddenLinePattern[] = [
  // 1. Empty / whitespace-only
  (line: string): boolean => line.trim().length === 0,

  // 2. Playwright preamble: `Running N tests` (with optional trailing
  //    `using N worker(s)` etc).
  /^\s*Running\s+\d+\s+tests?\b/i,

  // 3. Bare URL on its own line.
  /^\s*https?:\/\/\S+\s*$/i,

  // 4. Literal placeholder text the prompt scaffolds.
  //    `<paste line>` and `<the quoted line>` are the canonical phrasings;
  //    we also catch lone `<paste …>` style placeholders. Encoded as a
  //    single predicate so this counts as ONE forbidden category.
  (line: string): boolean =>
    /<paste[^>]*>/i.test(line) || /<the\s+quoted\s+line>/i.test(line),

  // 5. `using N worker` / `using N workers` (often appears alone on a line
  //    in playwright output banners).
  /\busing\s+\d+\s+workers?\b/i,

  // 6. `Workers:` banner line (e.g. `Workers: 4`).
  /^\s*Workers\s*:/i,

  // 7. `Slow test file` (playwright slow-test report banner).
  /\bSlow\s+test\s+file\b/i,

  // 8. `[chromium]` alone (no leading ✓ / ✔ / PASS / PASSED / OK marker —
  //    those would prove the test actually passed). We accept whitespace
  //    around the bracket but reject any non-whitespace before it.
  (line: string): boolean => {
    const trimmed = line.trim();
    if (!/^\[\s*chromium\s*\]\s*$/i.test(trimmed)) return false;
    return true;
  },

  // 9. Standalone words `passed`, `failed`, or `all green` on a line
  //    (case-insensitive). The line must consist ONLY of one of these words
  //    (with optional surrounding whitespace and an optional trailing
  //    period/exclamation).
  (line: string): boolean => {
    const trimmed = line.trim().toLowerCase().replace(/[.!]+$/, "");
    return trimmed === "passed" || trimmed === "failed" || trimmed === "all green";
  },
];

/**
 * True iff `line` matches ANY of the forbidden patterns above. Used both by
 * the implementer-output schema (to reject vacuous quotes at parse time) and
 * — indirectly — by the reviewer prompt's evidence-quote rules.
 */
export function isGenericAssertionLine(line: string): boolean {
  for (const pattern of GENERIC_ASSERTION_LINE_PATTERNS) {
    if (pattern instanceof RegExp) {
      if (pattern.test(line)) return true;
    } else {
      if (pattern(line)) return true;
    }
  }
  return false;
}

/**
 * Human-readable descriptions for each forbidden pattern. Order matches
 * `GENERIC_ASSERTION_LINE_PATTERNS`. Used to render the reviewer-prompt list
 * (see `FORBIDDEN_LINES_PROMPT_TEXT`) so the reviewer sees the same rules the
 * schema enforces.
 */
export const FORBIDDEN_LINES_DESCRIPTIONS: readonly string[] = [
  "empty or whitespace-only line",
  "'Running N tests' / 'Running 1 test using 1 worker' playwright preamble",
  "a bare URL line (e.g. http://localhost:3000/foo on its own)",
  "the literal placeholder '<paste line>' or '<the quoted line>'",
  "'using N worker' / 'using N workers' (case-insensitive)",
  "'Workers:' banner line",
  "'Slow test file' banner",
  "'[chromium]' alone on a line, with NO leading ✓ / ✔ / PASS marker",
  "the bare words 'passed', 'failed', or 'all green' on a line by themselves",
];

/**
 * Markdown bullet list of the 9 forbidden patterns, suitable for interpolation
 * into the reviewer prompt's "EVIDENCE QUOTE — STRICT verification" block.
 * The reviewer reads this verbatim; the schema enforces the same rules via
 * `isGenericAssertionLine`. Single source of truth.
 */
export const FORBIDDEN_LINES_PROMPT_TEXT: string =
  FORBIDDEN_LINES_DESCRIPTIONS.map((d) => `  - ${d}`).join("\n");
