/**
 * Impure half of the harness-run browser check (issue #912, Piece F):
 * actually execute the check-writer's check inside the sandbox, on the
 * FINISHED code, and apply the "one re-run, then stop" rule.
 *
 * "The failures here are mostly transient — a flaky render, an app that did
 * not boot. The check itself may be re-run once before the ticket stops."
 * This is NOT a second build round (Piece E's "no retry rounds" for an
 * ungradeable page means no BUILD rounds) — it is re-running the exact same
 * command against the exact same commit, which can only ever re-observe
 * reality, never change it. Applied to every non-`match` first result,
 * because a flaky render can just as easily manufacture a wrong-figure
 * result (a half-painted number) as it can a timeout — the spec's own
 * wording ("mostly transient") does not carve out just the infra-shaped
 * failures.
 */
import type { CheckKind } from "../checkwriter/check-kind.js";
import type { SandboxCommandRunner } from "../sandbox-exec.js";
import type { CheckRunLogTarget } from "./check-run-log.js";
import { writeCheckRunLog } from "./check-run-log.js";
import type { HarnessVerdictResult } from "./verdict.js";
import { classifyHarnessRun, moreEvidencedVerdict } from "./verdict.js";

export interface HarnessCheckRunAttempt {
  readonly verdict: HarnessVerdictResult;
  readonly output: string;
}

export interface HarnessCheckResult {
  /**
   * The FINAL verdict. When a re-run happened this is the MORE-EVIDENCED of
   * the two attempts, not simply the second one — see
   * {@link moreEvidencedVerdict}. Re-running cannot change reality, only
   * re-observe it, so a second run that saw less than the first must not
   * erase what the first proved.
   */
  readonly verdict: HarnessVerdictResult;
  /** Every attempt made, in order. Length 1 (no re-run needed) or 2 (one re-run, the max allowed). */
  readonly attempts: readonly HarnessCheckRunAttempt[];
  readonly rerun: boolean;
}

/**
 * The OUTER budget for one whole check-running process, PER RUNNER — it must
 * CONTAIN every inner budget that process can legitimately spend, or the
 * startup cost alone eats the whole thing and manufactures a false
 * `inconclusive` (`classifyHarnessRun`'s `timedOut` branch) on a check that
 * was never actually given the chance to run. A slow night must not be able to
 * waive the proof.
 *
 * ## `browser` — 420_000
 *
 * Two inner budgets stack sequentially inside one `pnpm … e2e -- <file>`,
 * back to back:
 *
 *   1. Playwright's own `webServer.timeout` (`apps/nextjs/playwright.config.ts`,
 *      120_000) — `reuseExistingServer: false` there means EVERY invocation
 *      boots a fresh dev server, and Playwright will not start running any
 *      test file until that boot completes or times out.
 *   2. Playwright's own per-test `timeout` (same file, 240_000) — the
 *      budget one test gets once the server is up, sized for the sign-in +
 *      navigation + readiness-deadline worst case documented there.
 *
 * 120_000 + 240_000 = 360_000 worst case; the number has to exceed that, not
 * merely approach it. It was once 120_000 — exactly equal to
 * `webServer.timeout` alone, with zero room left for the test itself to run
 * even once the server was up.
 *
 * ## `unit` — 240_000 (issue #956)
 *
 * A vitest check needs a fraction of the browser budget, but NOT an arbitrary
 * fraction. The same stacking argument applies, against the numbers the
 * package configs really set:
 *
 *   1. `hookTimeout: 60_000` (`apps/nextjs/vitest.config.ts` and, via
 *      `@acme/vitest-config`, the packages that inherit it) — one `beforeAll`
 *      seeding the shared test Postgres. Raised from vitest's 5s default
 *      precisely because those legitimately take 10-30s on a contended box.
 *   2. `testTimeout: 60_000` (same files) — the single graded test's own
 *      budget once the hook is done.
 *
 * 60_000 + 60_000 = 120_000 worst case for the graded portion; 240_000 leaves
 * the same order of headroom over it that the browser number leaves over its
 * own worst case, spent on what neither inner budget covers — vitest's own
 * cold start and Vite's transform of the module graph, which for
 * `apps/nextjs` is not small. Note that the `globalSetup` files do NOT
 * provision a database (read them: they only point `POSTGRES_URL` at an
 * already-running local test DB), so no provisioning cost belongs in this sum.
 *
 * Sanity-checked against the loop's OWN existing vitest bounds rather than
 * invented: `TEST_VERIFY_PACKAGE_TIMEOUT_MS` (`lib/testing/test-verification.ts`)
 * gives a WHOLE PACKAGE's suite 8 minutes, under a 20-minute
 * `TEST_VERIFY_TOTAL_CEILING_MS` across every package in a ticket's scope.
 * This budget runs ONE FILE, so it must sit well below the whole-suite bound —
 * 240_000 is exactly half of it. A unit check that cannot fail inside four
 * minutes is not a check this loop should be minting a receipt for.
 *
 * Exported as a per-kind record (not two loose constants) so a caller cannot
 * hand a browser budget to a unit run by accident, and so
 * `timeout-budget-contract.test.ts` can pin BOTH numbers against the real
 * source text of the configs they are derived from — a comment doing the
 * arithmetic by hand is exactly the kind of claim
 * `docs/specs/2026-08-04-screen-check-design-lock.md`'s Piece L warns never
 * survives a rename on its own.
 */
export const CHECK_TIMEOUT_BUDGET_MS: Readonly<Record<CheckKind, number>> = {
  browser: 420_000,
  unit: 240_000,
};

/**
 * Per-runner cost of EACH scenario past the first, inside one check FILE
 * (issue #1176). `CHECK_TIMEOUT_BUDGET_MS` was derived for a file holding
 * exactly ONE graded `test`/`it` — it pays once for the fixed costs (a cold
 * dev-server boot, sign-in, navigation) and once for the one assertion. A
 * file with N scenarios pays the fixed cost once but the assertion cost N
 * times, and #1054's four-scenario check (pin a task template to a person)
 * timed out twice on 2026-09-01 for exactly that reason: scenario one
 * finished, scenario two was mid-run, and the single-scenario budget ran out.
 *
 * Sized as the same "per-test" figure `run-harness-check.ts`'s own budget
 * derivation already isolated for each runner:
 *
 *   - `browser`: 240_000 — Playwright's own per-test `timeout`
 *     (`apps/nextjs/playwright.config.ts`), the SAME number
 *     `CHECK_TIMEOUT_BUDGET_MS.browser`'s doc comment already counts once as
 *     "the budget one test gets once the server is up". A second scenario
 *     does not pay the server-boot half again, only this half.
 *   - `unit`: 120_000 — `hookTimeout` (60_000) + `testTimeout` (60_000) from
 *     `apps/nextjs/vitest.config.ts`, the graded portion
 *     `CHECK_TIMEOUT_BUDGET_MS.unit`'s doc comment counts once. A second
 *     scenario re-pays the per-test budget; the shared `beforeAll` seeding
 *     is already paid for once by the first.
 */
const PER_ADDITIONAL_SCENARIO_MS: Readonly<Record<CheckKind, number>> = {
  browser: 240_000,
  unit: 120_000,
};

/**
 * The hard ceiling on ANY scaled check-execution budget, no matter how many
 * scenarios a file claims (issue #1176's second acceptance criterion: "a
 * genuinely hung run still gets killed"). Scaling exists to buy real
 * multi-scenario tests the time they actually need, never to waive the
 * loop's own ability to notice a wedged run — so the scaled sum above still
 * stops somewhere, and this is where.
 *
 * ## Why 45 minutes (issue #1198, piece C)
 *
 * This used to be 900_000 (15 minutes), and that was too small to be a
 * hung-run backstop at all — it was cutting off checks that were still
 * working. #1160's browser check (the client-portal fact strip) held FIVE
 * scenarios, each entitled to Playwright's own 240_000 per-test timeout:
 * 1_200_000 ms of graded run before the cold dev-server boot is even paid
 * for. A check whose failure mode is WAITING — a locator that never
 * resolves, an assertion that polls to its own timeout — could therefore
 * never reach its own verdict. It was killed mid-run and reported as a run
 * fault instead of as the honest red the check was in the middle of
 * producing. Any browser check with three or more scenarios was clamped.
 *
 * 2_700_000 is chosen so the scaled sum, not the clamp, decides every
 * realistic case: `CHECK_TIMEOUT_BUDGET_MS.browser` (420_000) plus nine
 * more scenarios at `PER_ADDITIONAL_SCENARIO_MS.browser` (240_000) is
 * 2_580_000 — TEN browser scenarios in one file fit under it, and the
 * eleventh is where a file stops being a multi-scenario check and starts
 * being something nobody should be gating a ticket on. It is also chosen to
 * stay under the two clocks that would otherwise kill a check that is
 * legitimately using this window: the loop's 90-minute stall watchdog (two
 * back-to-back ceiling-length harness attempts inside one phase still come
 * to 90 minutes, which is why `runScreenCheckHarness` threads `onAttempt`
 * to `noteProgress()` between them). Note that `hardCeilingSec: 3600` is NOT
 * a clock on these runs: it only caps AI agent invocations (`main.mts`), not
 * host-side check runs. Each red/green run is capped by its own scaled
 * timeout (at most this ceiling, 45 minutes); nothing caps the older-test
 * sequence as a whole, whose worst case is 3 files x 2 runs x 45 minutes. It
 * runs inside the ticket's own pipeline (`shipAfterMigrations`), never the
 * shared merge lane — accepted by spec #1366.
 *
 * ## It is a policy cap, not a mirror of anything the sandbox enforces
 *
 * `DEFAULT_SANDBOX_EXEC_TIMEOUT_MS` (900_000, `../sandbox-provider.ts`) is
 * NOT an upper bound this has to respect, and the ceiling now deliberately
 * sits above it. That constant is only ever the FALLBACK for a caller that
 * omits `timeoutMs` (`opts?.timeoutMs ?? DEFAULT_SANDBOX_EXEC_TIMEOUT_MS`);
 * a caller that passes an explicit `timeoutMs` — which every call site here
 * does — is honored verbatim, with no clamp from the sandbox layer at all.
 * The mac host (`../mac-host-sandbox.ts`) is the same shape and even
 * stricter about it: it arms its kill timer ONLY `if (opts.timeoutMs !==
 * undefined)`, applying no default of its own. So the number below is this
 * loop's own policy on how long a single check run may occupy a sandbox,
 * answerable to the two clocks named above and to nothing else.
 *
 * The alternative — shrinking Playwright's per-test `timeout` in
 * `apps/nextjs/playwright.config.ts` so five scenarios fit the old ceiling
 * — was considered and refused: it changes the application's own config for
 * the loop's convenience, and it would make the must-fail-first proof run
 * under different timing than a real `pnpm e2e` on the same file.
 */
export const CHECK_TIMEOUT_CEILING_MS = 2_700_000;

/**
 * Scale `CHECK_TIMEOUT_BUDGET_MS[kind]` — sized for ONE scenario — by how
 * many scenarios `testCount` says the check file actually holds (issue
 * #1176). `testCount` is `undefined` or `1` for the ordinary single-scenario
 * case, and the result is then BYTE-IDENTICAL to `CHECK_TIMEOUT_BUDGET_MS
 * [kind]` — every existing pin on that exact constant (
 * `timeout-budget-contract.test.ts`) keeps passing unchanged, because this
 * function is additive, never a replacement for the base numbers.
 *
 * The result is capped at {@link CHECK_TIMEOUT_CEILING_MS}. Every call site,
 * including `main.mts`'s repair road, which runs the SAME check file up to
 * seven times in one ticket, gets its true scaled window: a repair round
 * used to cap itself below this ceiling so the worst-case round count times
 * the cap stayed under an hour, but that starved every repaired
 * multi-scenario check of the budget this function exists to give it, and
 * after a repair the ship harness is NOT re-run — those rounds are the
 * check's only remaining proof. No running total cuts a sequence short (the
 * one that did was deleted by spec #1366, because it refused a ten-second
 * test on a worst-case guess).
 *
 * A negative or zero `testCount` is treated the same as `1` (`Math.max`),
 * so a caller that could not count anything (a failed read, an empty file)
 * degrades to the ordinary single-scenario budget rather than to something
 * smaller than that.
 */
export function scaledCheckTimeoutBudgetMs(
  kind: CheckKind,
  testCount: number | undefined,
): number {
  const count = Math.max(1, testCount ?? 1);
  const scaled =
    CHECK_TIMEOUT_BUDGET_MS[kind] + PER_ADDITIONAL_SCENARIO_MS[kind] * (count - 1);
  return Math.min(scaled, CHECK_TIMEOUT_CEILING_MS);
}

/**
 * How many graded scenarios `source` (a check file's own text) declares, by
 * counting calls that open a `test(` / `it(` block — including their
 * `.skip`/`.only`/`.each`/… modifier forms, but never `describe(`, which
 * groups scenarios rather than being one. Used ONLY to SCALE the time
 * budget above; it is a cheap regex scan, not a parser, and it is never
 * asked to grade anything.
 *
 * ## Deliberately over-counts, and that is acceptable headroom
 *
 * The scan does not strip comments first, so a commented-out
 * `// test("...", ...)` still counts. A budget that is slightly too
 * generous because of a dead scenario in a comment costs nothing but a few
 * idle minutes of sandbox time on the rare file that has one; a budget that
 * is too STINGY because a real scenario was missed is the bug this ticket
 * exists to fix. Same reasoning as `missingGradedHelperCalls` in
 * `check-path.ts`, which chose the same side of that trade-off for the same
 * kind of scan.
 *
 * ## The pattern
 *
 * `(^|[^\w.])(test|it)(\.\w+)?\s*\(` — a `test`/`it` call opens only when it
 * is NOT immediately preceded by a word character or a `.` (so `await
 * something.it(` and `unit(` never match) and is followed, optionally, by a
 * `.modifier` (`test.skip(`, `it.each(`) then an opening paren. `describe(`
 * never matches because neither alternative is the literal word `describe`.
 *
 * ## `.each(` is a TABLE, not one scenario (issue #1176, review finding 5)
 *
 * `test.each([a, b, c])("...", ...)` opens exactly ONE `test(`-shaped call in
 * the source text, but Playwright and vitest both expand it into one graded
 * scenario PER ROW at run time — a 10-row table really does pay the
 * per-scenario cost {@link PER_ADDITIONAL_SCENARIO_MS} ten times over, and
 * the original single-scenario-per-call count reintroduced exactly the bug
 * this whole feature exists to fix, on the one shape it could not see. A row
 * count cannot be read from a static regex scan without becoming a parser
 * (rows can be a literal array, a template tag, a variable, a function call),
 * so every `.each(` is weighted a fixed {@link EACH_TABLE_SCENARIO_WEIGHT}
 * scenarios instead of guessing the real row count — a documented, modest
 * heuristic, not an attempt at exactness. It also covers the ONE place a
 * static count is the ONLY count that ever exists: at MUST-FAIL-FIRST time,
 * before any proof has run, a `.each(` table gets the same weighting an
 * ordinary scenario would have gotten wrong on its own. Bounded by
 * {@link scaledCheckTimeoutBudgetMs}'s own ceiling regardless, so an
 * `.each(` table combined with several other scenarios cannot blow past the
 * ordinary per-file ceiling just because this weighting is generous.
 *
 * Returns at least `1`: a file with no recognizable scenario is graded as
 * whatever the SINGLE-scenario budget already assumed, which is exactly the
 * legacy behaviour for a scan this coarse.
 */
const EACH_TABLE_SCENARIO_WEIGHT = 3;

export function countCheckScenarios(source: string): number {
  const matches = source.matchAll(/(^|[^\w.])(test|it)(\.\w+)?\s*\(/gm);
  let total = 0;
  for (const match of matches) {
    total += match[3] === ".each" ? EACH_TABLE_SCENARIO_WEIGHT : 1;
  }
  return Math.max(1, total);
}

/**
 * The one-re-run rule's ceiling, restated as a number so the persisted
 * transcript can say "attempt 1 of 2" rather than leaving a reader to guess
 * whether a second one was ever going to happen.
 */
const MAX_HARNESS_ATTEMPTS = 2;

async function runOnce(
  kind: CheckKind,
  exec: SandboxCommandRunner | undefined,
  command: string,
  nonce: string,
  timeoutMs: number,
  attempt: number,
  logTarget: CheckRunLogTarget | undefined,
): Promise<HarnessCheckRunAttempt> {
  // Started/elapsed are captured around EVERY path, including the two that
  // never reach the sandbox — "it returned instantly because there was no
  // exec" and "it burned the whole budget and was killed" are the two readings
  // this number exists to tell apart, and only one of them has any output.
  const startedAtIso = new Date().toISOString();
  const startedAt = Date.now();
  /**
   * Persist the transcript. Diagnostics: it may never throw into the verdict
   * path (`writeCheckRunLog` already guarantees that) and it may never change
   * what is returned — this function's return value is computed by the caller
   * and merely passed through.
   */
  const persist = (r: {
    exitCode: number | null;
    timedOut: boolean;
    failure?: string;
    output: string;
    verdict: HarnessVerdictResult;
  }): void => {
    if (logTarget === undefined) return;
    writeCheckRunLog(logTarget, {
      kind,
      attempt,
      maxAttempts: MAX_HARNESS_ATTEMPTS,
      command,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      startedAtIso,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      failure: r.failure,
      output: r.output,
      verdict: r.verdict.verdict,
      reason: r.verdict.reason,
    });
  };

  if (exec === undefined) {
    const verdict: HarnessVerdictResult = {
      verdict: "inconclusive",
      reason: "sandbox does not expose command execution",
    };
    // WRITTEN ANYWAY, with no output to show. This is one of the three causes
    // the #803 stop report had to list without being able to choose between
    // them; a file that says "nothing was run, because this sandbox exposes no
    // command execution" resolves it in one line.
    persist({ exitCode: null, timedOut: false, output: "", verdict, failure: "the sandbox exposed no command execution — nothing was run" });
    return { verdict, output: "" };
  }
  try {
    const res = await exec(command, { timeoutMs });
    const output = `${res.stdout}\n${res.stderr}`;
    const verdict = classifyHarnessRun(kind, {
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      spawnFailed: false,
      output,
      nonce,
    });
    persist({
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      output,
      verdict,
    });
    return { verdict, output };
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    const verdict: HarnessVerdictResult = {
      verdict: "inconclusive",
      reason: `could not run: ${failure}`,
    };
    // The second output-less path, and the second of the three causes: the
    // process could not be spawned at all. The budget and the elapsed time in
    // the header are what separate "the daemon refused instantly" from "it
    // hung for seven minutes and then threw".
    persist({ exitCode: null, timedOut: false, failure, output: "", verdict });
    return { verdict, output: "" };
  }
}

/**
 * Run `command` once; if the result is anything other than `"match"`, run it
 * ONE more time — win or lose, the ticket's fate is decided on at most two
 * executions of the check, never three.
 *
 * The final verdict is the MORE-EVIDENCED of the two attempts
 * ({@link moreEvidencedVerdict}), not unconditionally the second one. Both
 * runs execute the same command against the same commit, so neither can
 * change what is true — the honest reading is whichever run got further into
 * the check. Taking the second unconditionally let one container hiccup
 * overwrite a first attempt that had already proven, via the grading
 * sentinel, exactly what was wrong; the ticket then stopped as
 * `stopped:could-not-grade` and told the owner the app was broken for
 * everyone that night, which was false.
 *
 * Both attempts are returned so a caller can log/telemetry the full story
 * ("was this a flake that resolved on re-run, or reproducible").
 *
 * `kind` leads the parameter list and has NO default (issue #956): it selects
 * both the grading rules and the budget, and a call site that could omit it
 * would silently give a vitest run Playwright's rules AND Playwright's
 * seven-minute budget. `timeoutMs` still accepts a deliberate override, but
 * its default is now derived FROM `kind`, so the accidental pairing is the one
 * that cannot happen.
 *
 * ## `nonce` must be the one `command` was built with, and fresh for THIS run
 *
 * It is the key the host's evidence line inside `command` is signed with —
 * without it nothing in the output is attributable to the runner rather than
 * to the check's own printing, and every verdict reads `inconclusive`. Build
 * and run in the same breath (`newCheckNonce()` → `buildCheckCommand(…, nonce)`
 * → here). NEVER persist a built command and replay it: this run happens AFTER
 * the builder's diff landed, and the check is required to import real product
 * code, so builder-authored code executes inside the check's own process. A
 * nonce carried over from the must-fail-first proof would hand that code the
 * report path THIS verdict is read from. See `lib/harness/tally-signals.ts`.
 *
 * BOTH attempts share the one nonce, deliberately: they are two observations
 * of the same command against the same commit, back to back, with nothing
 * running in between that could have learned it.
 *
 * ## `logTarget` — where each attempt's transcript is persisted
 *
 * Optional, and purely additive: every verdict this function reaches is
 * byte-for-byte what it reached before, whether or not one is supplied. When
 * it IS supplied, each attempt writes its OWN file under
 * `<repoRoot>/.sandcastle/logs/` (`./check-run-log.ts`) — including the two
 * attempts that produce no output at all, which are exactly the runs a stopped
 * ticket needs explained. The second attempt cannot overwrite the first: a
 * first-attempt failure followed by a second-attempt pass is the single most
 * useful thing this record can say, and one file would erase it.
 *
 * Omitted by the unit tests that only care about grading, and by any legacy
 * call site — an absent target means no file, never a changed verdict.
 *
 * ## `onAttempt` — the stall watchdog's progress clock (issue #1176, finding 3)
 *
 * Optional, called right before the SECOND attempt if one happens, never
 * before the first (the caller's own phase change already covers that one).
 * This whole function can now spend up to `CHECK_TIMEOUT_CEILING_MS`
 * (2_700_000 ms since issue #1198 piece C; 900_000 before it) on EACH
 * attempt (scaled by scenario count), so two back-to-back attempts can run
 * for up to 90 minutes with no phase change in between — the whole stall
 * watchdog, where it used to be ~30 minutes. The watchdog's progress clock
 * is frozen for that entire window unless something bumps it, so this hook
 * is now load-bearing rather than merely prudent. Wired by callers to
 * `StatusStore.noteProgress()`, the existing helper built for exactly this
 * shape ("a bounded cross-issue SUB-STEP has completed"); omitted, this
 * function's behaviour is unchanged.
 */
export async function runHarnessScreenCheck(
  kind: CheckKind,
  exec: SandboxCommandRunner | undefined,
  command: string,
  nonce: string,
  timeoutMs = CHECK_TIMEOUT_BUDGET_MS[kind],
  logTarget?: CheckRunLogTarget,
  onAttempt?: (attemptNumber: number) => void,
): Promise<HarnessCheckResult> {
  const first = await runOnce(kind, exec, command, nonce, timeoutMs, 1, logTarget);
  if (first.verdict.verdict === "match") {
    return { verdict: first.verdict, attempts: [first], rerun: false };
  }
  onAttempt?.(2);
  const second = await runOnce(kind, exec, command, nonce, timeoutMs, 2, logTarget);
  return {
    verdict: moreEvidencedVerdict(first.verdict, second.verdict),
    attempts: [first, second],
    rerun: true,
  };
}
