/**
 * Guard 1 of issue #1025 — the implementer may NOT choose its own test
 * database.
 *
 * ## The hole this closes
 *
 * The loop clones the configured `testDatabase.templateDb` into a per-job database
 * (`sc_job_<branch>_<pid>_<rand>`, `../db/job-clone.ts`) and EXPORTS its URL as
 * `POSTGRES_URL`/`DATABASE_URL` into the sandbox. That exported value is the
 * one and only database a job's tests are allowed to touch — the grader reads
 * the same clone afterwards, so a green run there is a green run the grader can
 * trust.
 *
 * On the 2026-08-11 run (#1015) the implementer decided the clone did not
 * exist, scraped a connection string out of `.env`, and built its test command
 * as `env POSTGRES_URL="$PG_URL" DATABASE_URL="$PG_URL" pnpm --filter
 * @acme/nextjs e2e …`. `apps/nextjs/playwright.config.ts` reads
 * `process.env.POSTGRES_URL ||= LOCAL_TEST_DB_URL`, so the command's own
 * override won for both the runner and the app under test. Its passing run and
 * its fixture cleanup both hit the plain `postgres` database; the grader read
 * the untouched clone. Two deal rows, same address, two databases — and a green
 * tick on a run that decided nothing.
 *
 * ## The rule
 *
 * A `testCommandUsed` the implementer certifies MUST NOT set `POSTGRES_URL` or
 * `DATABASE_URL` itself. The value is already exported by the host; a command
 * that re-sets it is either pointing the run at a different database than the
 * grader will read (the #1015 defect) or is redundant noise dressed up as one.
 * Either way the run's database is no longer the one the loop provisioned, so
 * the certification cannot be trusted. {@link findTestDatabaseUrlOverride}
 * finds such an assignment; the schema (`./schemas.ts`) turns a hit into a
 * PARSE-time rejection, so a STORY_COMPLETE built on a self-chosen database
 * fails before it can reach the reviewer or be committed.
 *
 * Pure by construction — no IO, no clock, no state. The whole point is that the
 * check can be reproduced against the #1015 command string in a unit test.
 */

/**
 * The two environment variables that redirect BOTH the Playwright runner and
 * the Next.js app under test to a database. `apps/nextjs/playwright.config.ts`
 * and `apps/nextjs/e2e/global-setup.ts` both read `POSTGRES_URL`, and Drizzle
 * reads `DATABASE_URL`; setting either inside the test command overrides the
 * host-exported clone. Kept as a named list so a message can spell out exactly
 * which name was found and so a future third variable is one edit.
 */
export const FORBIDDEN_TEST_DB_ENV_VARS: readonly string[] = [
  "POSTGRES_URL",
  "DATABASE_URL",
];

/** One override found inside a `testCommandUsed` string. */
export interface TestDbUrlOverride {
  /** Which forbidden variable was assigned — a member of {@link FORBIDDEN_TEST_DB_ENV_VARS}. */
  readonly varName: string;
  /**
   * The assignment as it appeared, trimmed of any surrounding whitespace —
   * e.g. `POSTGRES_URL="$PG_URL"`. Carried so a stop/parse message can quote
   * the exact evidence rather than gesture at "the command".
   */
  readonly assignment: string;
}

/**
 * A shell environment-variable assignment, whether bare (`FOO=bar cmd`) or
 * introduced by `env`/`export` (`env FOO=bar cmd`).
 *
 * Anchored to a word boundary on the LEFT so `MY_POSTGRES_URL=…` (a different
 * variable whose name merely ends in one of ours) is NOT a match: the `\b`
 * after the optional leading whitespace/`;`/`&`/`(` will not fire in the middle
 * of `MY_POSTGRES_URL`. The name is captured so the caller can report which one
 * fired; the RHS is consumed up to the next unquoted whitespace, tolerating a
 * single- or double-quoted value that itself contains spaces (a connection URL
 * with query parameters can).
 *
 * NOTE this is a heuristic over a command STRING, not a shell parse — it is
 * deliberately eager. A false positive costs the implementer a re-emit with the
 * host-exported value left alone (which is what it was supposed to do); a false
 * negative ships the #1015 defect. When the trade is asymmetric like that, the
 * guard leans toward refusing.
 */
const ASSIGNMENT_RE =
  /(?:^|[\s;&|(])(?:env\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/g;

/**
 * Find the FIRST forbidden test-database URL override in a test command, or
 * `null` if the command sets neither `POSTGRES_URL` nor `DATABASE_URL`.
 *
 * Returns the first hit only — one is enough to reject, and naming the first
 * keeps the message short. `null` (not throwing) on a non-string or empty input
 * so the schema layer decides what absence means; a command that was never run
 * has nothing to override.
 */
export function findTestDatabaseUrlOverride(
  command: string | null | undefined,
): TestDbUrlOverride | null {
  if (typeof command !== "string" || command.length === 0) return null;
  ASSIGNMENT_RE.lastIndex = 0;
  for (
    let m = ASSIGNMENT_RE.exec(command);
    m !== null;
    m = ASSIGNMENT_RE.exec(command)
  ) {
    const varName = m[1];
    if (varName !== undefined && FORBIDDEN_TEST_DB_ENV_VARS.includes(varName)) {
      // Reconstruct `NAME=value` from the two captures so the reported
      // assignment is free of the leading separator and any `env `/`export `
      // keyword the outer group consumed.
      return { varName, assignment: `${varName}=${m[2] ?? ""}` };
    }
  }
  return null;
}
