// Reference copy of the project-side graded-screen helper. See README.txt.
// Deliberately free of imports: it is read as TEXT by the contract tests.

export const GRADE_MARK_ENV = "SANDCASTLE_GRADE_MARK_FILE";
export const NEVER_SETTLED_SENTINEL = "SCREEN_CHECK_VERDICT:NEVER_SETTLED";
export const CLAIM_MISMATCH_SENTINEL = "SCREEN_CHECK_VERDICT:CLAIM_MISMATCH";
export const GRADED_FIGURE_SENTINEL =
  "SCREEN_CHECK_VERDICT:GRADED_FIGURE_MISMATCH";
export const SCREEN_SETTLED_SENTINEL = "SCREEN_CHECK_VERDICT:SCREEN_SETTLED";

interface PageLike {
  url(): string;
}

/** Append the settled record to the same nonce-named file as the grade mark. */
function writeSettledMark(page: PageLike, screen: string): void {
  const file = process.env[GRADE_MARK_ENV];
  if (!file) return;
  const line = JSON.stringify({ screen, url: page.url(), settled: true });
  void line; // a real helper appends `line` to `file`
}

function writeGradeMark(target: unknown, figure: string): void {
  void target;
  void figure; // a real helper appends {figure, matched: true} to the same file
}

export async function waitForGradableScreen(
  page: PageLike,
  opts: { screen: string },
): Promise<void> {
  // ... wait for the page to settle and its claim to match, else throw with
  // NEVER_SETTLED_SENTINEL / CLAIM_MISMATCH_SENTINEL in the message ...
  writeSettledMark(page, opts.screen);
  console.log(`${SCREEN_SETTLED_SENTINEL} screen=${opts.screen}`);
}

export async function gradeScreenText(
  locator: { textContent(): Promise<string | null> },
  expected: string,
): Promise<void> {
  const text = (await locator.textContent()) ?? "";
  // ... throw an Error whose message carries GRADED_FIGURE_SENTINEL on a miss ...
  expect(text.includes(expected)).toBe(true);
  writeGradeMark(locator, expected);
}

declare function expect(value: unknown): { toBe(expected: unknown): void };
