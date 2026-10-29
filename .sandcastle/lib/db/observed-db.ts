/**
 * Guard 2 of issue #1025 — surface the database a test run ACTUALLY resolved
 * to, and refuse to certify green when it is not the loop's minted clone.
 *
 * ## The hole this closes
 *
 * `implementerCertification` (`../verdicts/schemas.ts`) records
 * `e2eActuallyRan`, `testCommandUsed`, `e2eAssertionLine` and
 * `testReachedFeature` — every one of which was truthfully "yes" on the #1015
 * false green. What it had NO field for was WHICH DATABASE the run touched. The
 * host mints a per-job clone (`sc_job_<branch>_<pid>_<rand>`, `./job-clone.ts`)
 * and knows its name; the agent reports the command it ran; nothing put the two
 * side by side. So a run that passed against the plain `postgres` database —
 * where the grader never looks — was indistinguishable in the record from a run
 * against the clone the grader reads.
 *
 * This module is the missing comparison, kept pure so it can be reproduced
 * against the exact #1015 shape in a unit test:
 *
 *   - `apps/nextjs/e2e/global-setup.ts` emits one line naming the database its
 *     `@acme/db` connection actually resolved to, prefixed with
 *     {@link OBSERVED_DB_SENTINEL}. That line rides back on the run's stdout.
 *   - {@link parseObservedDatabases} pulls every such name out of that stdout,
 *     HOST-SIDE — never from a field the agent can write.
 *   - {@link compareObservedDatabase} sets those observed names beside the
 *     clone the host minted for this job and returns a mismatch when they
 *     disagree, modelled on `ScreenClaimMismatchError`'s expected-vs-observed
 *     shape (`apps/nextjs/e2e/lib/graded-screen-check.ts`).
 *
 * The database name survives credential redaction (`redactUrlCredentials`,
 * `../harness/check-run-log.ts`) because it lives in the URL PATH, not the
 * userinfo — so reading it off a persisted, credential-scrubbed run log is
 * safe.
 *
 * ## Why the sentinel string is duplicated across the boundary
 *
 * `.sandcastle` never imports `apps/nextjs` module code (the same boundary
 * `verdict.ts`'s screen-check sentinels already draw). So
 * {@link OBSERVED_DB_SENTINEL} is duplicated as a literal in
 * `apps/nextjs/e2e/global-setup.ts`, and `./observed-db.contract.test.ts` pins
 * the two copies together by reading that file's source text — rename either
 * and the pin turns red, rather than this comparison silently going blind.
 */

import { isJobDatabaseName } from "./job-clone.js";

/**
 * Prefix `global-setup.ts` stamps in front of the database name it resolved to,
 * greppable out of the run's own stdout. Duplicated as a literal there and
 * pinned by `./observed-db.contract.test.ts` — see the module doc.
 *
 * The value is one line per Playwright invocation: `SANDCASTLE_OBSERVED_DB:<db>`
 * where `<db>` is exactly what `SELECT current_database()` returned.
 */
export const OBSERVED_DB_SENTINEL = "SANDCASTLE_OBSERVED_DB:";

/** Matches one emitted line and captures the database name. */
const OBSERVED_DB_LINE_RE = new RegExp(
  `${OBSERVED_DB_SENTINEL}([A-Za-z0-9_]+)`,
  "g",
);

/**
 * Every DISTINCT database name the run announced, in first-seen order.
 *
 * A run can announce more than once — global setup runs per Playwright
 * invocation, and an agent that ran the suite twice leaves two lines. Distinct
 * + ordered keeps the evidence honest without drowning a message in repeats.
 *
 * Total and non-throwing: no announcement at all comes back `[]`, which the
 * caller must NOT read as "matched" — see {@link compareObservedDatabase}'s
 * `no-observation` outcome.
 */
export function parseObservedDatabases(output: string | null | undefined): string[] {
  if (typeof output !== "string" || output.length === 0) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  OBSERVED_DB_LINE_RE.lastIndex = 0;
  for (
    let m = OBSERVED_DB_LINE_RE.exec(output);
    m !== null;
    m = OBSERVED_DB_LINE_RE.exec(output)
  ) {
    const name = m[1];
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * The result of setting what the host provisioned beside what the run resolved
 * to. Modelled on the expected-vs-observed shape `ScreenClaimMismatchError`
 * carries.
 *
 *   - `match`          — every database the run announced IS the expected
 *                        clone. The one outcome that lets a certification stay
 *                        green.
 *   - `mismatch`       — the run announced at least one database that is NOT the
 *                        expected clone. This is the #1015 defect: a green run
 *                        against a database the grader never reads. The offending
 *                        names are named.
 *   - `no-observation` — the run announced no database at all. NOT a pass: the
 *                        guard could not see what the run touched, so a caller
 *                        that requires proof must treat it as unproven, not
 *                        clear. (A backend-only story that ran no e2e legitimately
 *                        produces this — the caller decides whether a database
 *                        observation was owed at all.)
 */
export type ObservedDbComparison =
  | { readonly kind: "match"; readonly expected: string; readonly observed: readonly string[] }
  | {
      readonly kind: "mismatch";
      readonly expected: string;
      readonly observed: readonly string[];
      /** The announced names that are NOT the expected clone — the evidence. */
      readonly unexpected: readonly string[];
    }
  | { readonly kind: "no-observation"; readonly expected: string };

/**
 * Compare the database(s) a run announced against the clone the host minted for
 * it.
 *
 * `expected` is the exact `jobDb` name `main.mts` created via
 * `jobDatabaseName(branch)` and exported as `POSTGRES_URL`. It cannot be
 * re-derived — `jobDatabaseName` embeds `process.pid` and a random suffix — so
 * the caller must pass the value it actually minted, never recompute it.
 *
 * Pure. Any announced name outside the expected clone is a mismatch, even if
 * the expected clone was ALSO announced: a run that touched both the clone and
 * `postgres` still touched `postgres`, and the grader cannot tell which one the
 * passing assertion read.
 */
export function compareObservedDatabase(args: {
  readonly expected: string;
  readonly observed: readonly string[];
}): ObservedDbComparison {
  const { expected, observed } = args;
  if (observed.length === 0) {
    return { kind: "no-observation", expected };
  }
  const unexpected = observed.filter((name) => name !== expected);
  if (unexpected.length === 0) {
    return { kind: "match", expected, observed };
  }
  return { kind: "mismatch", expected, observed, unexpected };
}

/**
 * Raised when the GRADED test run cannot be proven to have used the clone the
 * loop provisioned for this job — the #1015 false green, made impossible to
 * certify green through. Two shapes:
 *
 *   - `mismatch`       — the run demonstrably touched a database OTHER than the
 *                        clone. The offending names are named, and the message
 *                        flags whether one of them is an un-isolated SHARED
 *                        database (`postgres`, the template) rather than another
 *                        job's clone — the shared case is the exact #1015 shape
 *                        and the more dangerous one, because the grader's own
 *                        reads land there too.
 *   - `no-observation` — the run announced no database at all, yet an e2e that
 *                        SHOULD have announced one ran (a green browser check).
 *                        The guard could not see which database decided the
 *                        ship, so it fails CLOSED rather than certify green on
 *                        zero evidence — the reviewer's blocker: "if the marker
 *                        channel produces nothing, do not certify green".
 */
export class WrongTestDatabaseError extends Error {
  readonly reasonKind: "mismatch" | "no-observation";
  readonly expected: string;
  /** The wrong databases, for the `mismatch` case; empty for `no-observation`. */
  readonly unexpected: readonly string[];

  constructor(
    args:
      | { readonly kind: "mismatch"; readonly expected: string; readonly unexpected: readonly string[] }
      | { readonly kind: "no-observation"; readonly expected: string },
  ) {
    const expected = args.expected;
    const message =
      args.kind === "mismatch"
        ? `WRONG_TEST_DATABASE: the graded test run resolved to ` +
          `${args.unexpected.map((n) => `"${n}"`).join(", ")}, not the clone the ` +
          `loop minted for it ("${expected}"). ` +
          (args.unexpected.some((n) => !isJobDatabaseName(n))
            ? `At least one of those is a SHARED database the grader also reads, ` +
              `so a green run there decided nothing about this job's own clone ` +
              `(the #1015 false green). `
            : "") +
          `The exported POSTGRES_URL is authoritative; a test command must not ` +
          `override it or scrape a connection string from .env.`
        : `WRONG_TEST_DATABASE: the graded browser check passed, but NOTHING in ` +
          `its output named the database it ran against — so the loop cannot ` +
          `prove it touched this job's clone ("${expected}") rather than a ` +
          `shared database the grader never reads (the #1015 false green). A ` +
          `green run with no database evidence is not trusted; failing closed. ` +
          `Expected the \`${OBSERVED_DB_SENTINEL}\` line ` +
          `\`apps/nextjs/e2e/global-setup.ts\` prints on every Playwright run.`;
    super(message);
    this.name = "WrongTestDatabaseError";
    this.reasonKind = args.kind;
    this.expected = expected;
    this.unexpected = args.kind === "mismatch" ? args.unexpected : [];
  }
}

/**
 * The single ship-time decision, pure: given the clone the host minted and the
 * database(s) the GRADED harness run announced, return the error to throw or
 * `null` to let the ship proceed.
 *
 * This is the load-bearing half of guard 2. It runs at the SHIP FUNNEL, over
 * the HARNESS run's own output (the same combined stdout+stderr the harness
 * grades and `check-run-log.ts` persists) — never over the implementer agent's
 * already-extracted assistant text, which does not reliably carry the sentinel.
 *
 * The rules, in order:
 *   - No clone was minted (`expected` null/undefined — the
 *     `SANDCASTLE_TEST_DB_URL` escape hatch, the mac host, a test double): there
 *     is nothing to verify against, so `null`.
 *   - The check does not emit an observation (`checkEmitsObservation` false —
 *     the unit/vitest route has no `global-setup` printing the sentinel):
 *     `null`, an absent observation there is expected and benign.
 *   - `mismatch` — the run touched a database that is not the clone: ERROR,
 *     always, regardless of anything else.
 *   - `no-observation` — the sentinel never appeared: ERROR **only when an e2e
 *     that should have printed it definitely ran** (`e2eDefinitelyRan`). A
 *     backend-only story that ran no e2e produces this legitimately and stays
 *     green; a GREEN browser run that printed no database name is the fail-closed
 *     case.
 *   - `match` — `null`.
 */
export function enforceObservedDatabase(args: {
  readonly expected: string | null | undefined;
  readonly observed: readonly string[];
  readonly checkEmitsObservation: boolean;
  readonly e2eDefinitelyRan: boolean;
}): WrongTestDatabaseError | null {
  const { expected, observed, checkEmitsObservation, e2eDefinitelyRan } = args;
  if (expected == null) return null;
  if (!checkEmitsObservation) return null;
  const cmp = compareObservedDatabase({ expected, observed });
  if (cmp.kind === "mismatch") {
    return new WrongTestDatabaseError({
      kind: "mismatch",
      expected: cmp.expected,
      unexpected: cmp.unexpected,
    });
  }
  if (cmp.kind === "no-observation" && e2eDefinitelyRan) {
    return new WrongTestDatabaseError({ kind: "no-observation", expected: cmp.expected });
  }
  return null;
}
