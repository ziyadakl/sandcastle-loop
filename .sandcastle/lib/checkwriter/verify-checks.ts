/**
 * Actually RUNS a check-writer's check inside the sandbox and classifies
 * what happened — the deterministic instrument behind Piece D's
 * must-fail-first rule (issue #911).
 *
 * "They are then run against untouched code and must fail. If they pass,
 * they are incapable of failing and prove nothing." That is a claim about
 * REALITY, not about what an agent reports, so it is proven the same way
 * `verifyTestRun` (`lib/testing/test-verification.ts`) proves a builder's
 * `SANDCASTLE-TEST: pass` cert: execute the real command inside the sandbox
 * and read the real exit code and output, never the agent's self-report.
 *
 * Mirrors `classifyTestRun`'s central asymmetry: a bare exit code can be
 * MANUFACTURED (a killed `docker exec` client can arrive here as exit 0 with
 * truncated output — `test-verification.ts:266-272`), so a result is only
 * accepted once the RUNNER's own machine-readable report says what it graded.
 * Absent that, the run is INCONCLUSIVE, never a confident pass or fail — an
 * environment that can't prove anything must not be read as "the check is
 * green".
 *
 * ## And the check's own output proves nothing either (2026-08-06)
 *
 * That evidence used to be a REGEX over the run's combined output, which the
 * check file could satisfy by PRINTING it — the check is agent-authored and
 * its `console.log` lands in the same stream. See
 * `lib/harness/tally-signals.ts` for the reproduction and the fix; the short
 * version is that every verdict here is now read from counters the runner
 * wrote to a nonce-named file, relayed on a line the HOST printed under a
 * nonce generated after the check's bytes were sha256-locked.
 */

import type { CheckRunLogTarget } from "../harness/check-run-log.js";
import {
  redactUrlCredentials,
  writeCheckRunLog,
} from "../harness/check-run-log.js";
import { CHECK_TIMEOUT_BUDGET_MS } from "../harness/run-harness-check.js";
import { parseGradeMark, parseSettledMark } from "../harness/grade-mark.js";
import { readRunEvidence } from "../harness/tally-signals.js";
import { SCREEN_CHECK_SENTINELS } from "../harness/verdict.js";
import type { SandboxCommandRunner } from "../sandbox-exec.js";
import { stripAnsi } from "../testing/test-verification.js";
import type { CheckKind } from "./check-kind.js";
import { CHECK_KIND_RUNNER_NAME } from "./check-kind.js";

/**
 * Re-exported, not re-implemented. The definition moved to
 * `../harness/check-run-log.js` because that module persists the same
 * credential-carrying output and this file already imports from `../harness/`,
 * so importing it back would close a module cycle. Kept exported under its
 * original name here so every existing import site — and this module's own
 * tests — are unchanged.
 */
export { redactUrlCredentials };

/** What the caller expected this run to observe. */
export type CheckRunExpectation = "red" | "green";

export type CheckRunStatus = "pass" | "fail" | "inconclusive";

export interface CheckRunObservation {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly spawnFailed: boolean;
  readonly output: string;
  /**
   * The nonce THIS run's command was built with — the key the host's own
   * evidence line is signed with, and the only thing that makes any part of
   * `output` attributable to the runner rather than to the check file's own
   * `console.log`. Required, never optional: a call site that could omit it
   * would be a call site that grades a run on unattributable text, which is
   * exactly the hole this field closes.
   */
  readonly nonce: string;
  /**
   * The screen the check-writer's ENVELOPE declared this check targets (e.g.
   * `/finance/reports?view=team`), when the caller has one. Read only by the
   * browser red arm that accepts settled evidence: a nonce-keyed settled
   * record must name a screen matching this before it can move a red from
   * inconclusive to accepted, so a check that settled some OTHER page cannot
   * borrow the evidence. `undefined` scopes the comparison away (a unit
   * check, or a caller with no envelope in hand) — the record's presence is
   * then the whole test, exactly what was checked before this field existed.
   */
  readonly declaredScreen?: string;
}

export interface CheckRunVerdict {
  readonly status: CheckRunStatus;
  readonly reason: string;
  /**
   * Set (only ever to `true`, only on `status: "inconclusive"`) when the
   * runner demonstrably ran and reported a colour, but nothing proves the
   * check ever reached its screen — no grade mark, no refusal sentinel, and
   * no nonce-keyed settled record (2026-09-01). This shape is usually the
   * CHECK's own deterministic fault (a bad import, a dead route, a
   * hand-rolled wait) rather than the environment's, so the caller routes it
   * to a briefed check-writer retry instead of an environment-fault stop.
   * Absent on every other inconclusive (spawn failure, timeout, no evidence
   * line), which really are the environment failing to produce evidence.
   */
  readonly screenUnreached?: boolean;
  /**
   * Redacted, bounded TAIL of what the check actually printed — the evidence
   * behind {@link reason}, carried on the verdict so a caller can log it.
   *
   * Exists because of a real production night (2026-08-05): the sandbox could
   * not reach the test Postgres at all, every must-fail-first proof died in
   * Playwright's `globalSetup` with `write CONNECT_TIMEOUT 172.17.0.1:55432`,
   * and issues #803/#813 were quarantined `stopped:no-failing-check` after ~19
   * minutes each with NOTHING in the run log saying why. The classifier's
   * `reason` alone ("no Playwright tally line in the output") is true but
   * un-actionable; the one line that names the address is in the output the
   * verdict used to throw away.
   *
   * Present only on the paths where output actually exists — `undefined` when
   * `exec` was absent or rejected before producing any. See
   * {@link CHECK_OUTPUT_TAIL_CHARS} for the bound and
   * {@link redactUrlCredentials} for the redaction, both applied HERE rather
   * than at the log site so no caller can forget either one.
   */
  readonly outputTail?: string;
  /**
   * What the run PROVED, and the counters it proved it from — present only
   * when {@link readRunEvidence} returned `proved`, absent on every
   * inconclusive reading (issue #1118, layer 3).
   *
   * ADDITIVE and never load-bearing for {@link status}: `status` still answers
   * the only question the existing callers ask ("did the run match the
   * expectation it was graded against?"), byte for byte as before. This field
   * exists because the mutant gate asks a second question the expectation
   * cannot express — was this run GRADED AT ALL, or did it merely exit
   * non-zero — and a run that graded nothing must never be counted as a check
   * catching something. Carried on the verdict rather than re-parsed by the
   * caller so there is exactly one place the host's nonce-signed evidence line
   * is read, which is the property that closes the log-forging hole
   * `lib/harness/tally-signals.ts` documents.
   */
  readonly proved?: {
    readonly colour: "red" | "green";
    readonly passed: number;
    readonly failed: number;
    /**
     * Issue #1176, review finding 4: a scenario `test.skip(`/`it.skip(` (or
     * one Playwright/vitest skipped for its own reasons) is a real scenario
     * in the FILE — it still costs a slot in whatever counted the file
     * statically — but it is neither `passed` nor `failed`, so a tally that
     * summed only those two undercounted every file with one. Carried
     * separately, rather than folded into `passed`, so a caller that only
     * wants "did anything really run" is unaffected.
     */
    readonly skipped: number;
  };
}

/**
 * Characters of the check's combined output retained on the verdict.
 *
 * The TAIL, not the head: Playwright prints its failure block and any
 * `globalSetup` stack last, and the head of an e2e run is dev-server boot
 * noise. Deliberately far smaller than `EXEC_OUTPUT_TAIL_CHARS`
 * (`lib/sandbox-exec.ts`, 64 KiB — what the provider itself retains): this
 * value is written into a run log on every unproven proof, so it is sized to
 * "enough to name the fault", not "the whole run".
 */
export const CHECK_OUTPUT_TAIL_CHARS = 4000;

/**
 * Redact, then keep at most {@link CHECK_OUTPUT_TAIL_CHARS} characters from
 * the END, prefixed with a marker when anything was dropped so a reader is
 * never misled into thinking they are looking at the whole run.
 */
export function checkOutputTail(
  output: string,
  maxChars = CHECK_OUTPUT_TAIL_CHARS,
): string {
  const redacted = redactUrlCredentials(output);
  if (redacted.length <= maxChars) return redacted;
  return `… ${redacted.length - maxChars} earlier characters omitted …\n${redacted.slice(-maxChars)}`;
}

/**
 * Does the settled evidence name the screen the envelope declared?
 *
 * `declaredScreen` absent scopes the comparison away — the record's presence
 * is the whole test (a caller with no envelope in hand, and the pre-2026-09-01
 * behaviour). With one present, at least one recorded name (the caller's own
 * `screen` label or the browser's real `page.url()`) must equal or contain
 * it, or be contained by it — a route (`/finance/reports?view=team`) sits
 * inside a full address (`http://localhost:3000/finance/reports?view=team`),
 * and either side may be the fuller spelling. `count > 0` with NO readable
 * screen (the detail truncated mid-record) fails the comparison — unconfirmed
 * is never a match.
 */
function settledScreenConfirmed(
  screens: readonly string[],
  declaredScreen: string | undefined,
): boolean {
  if (declaredScreen === undefined) return true;
  const declared = declaredScreen.trim();
  if (declared.length === 0) return true;
  return screens.some((s) => {
    const recorded = s.trim();
    return (
      recorded.length > 0 &&
      (recorded === declared ||
        recorded.includes(declared) ||
        declared.includes(recorded))
    );
  });
}

/**
 * Pure. Turns one raw subprocess observation into a verdict against
 * `expect`. Decision order mirrors `classifyTestRun`:
 *
 *   1. `spawnFailed` / `timedOut` — the environment, not the check, is what
 *      failed to produce evidence.
 *   2. {@link readRunEvidence} decides what colour the run PROVED, from the
 *      RUNNER's own machine-readable report, delivered on a line the HOST
 *      printed under this run's nonce. Anything it cannot prove is
 *      inconclusive, never a confident colour.
 *   3. `observed === expect` → `pass` (the check behaved as required);
 *      otherwise `fail` — including a check that was supposed to be RED and
 *      came back GREEN, which is Piece D's whole reason for existing.
 *
 * ## Why step 2 no longer greps the output (2026-08-06)
 *
 * It used to: RED was `Tests  N failed` somewhere in the stream, GREEN was
 * `Tests  N passed`, and the browser kind trusted the exit code once ANY
 * `N passed`/`N failed` had been seen. THE CHECK FILE IS WRITTEN BY AN AGENT
 * AND ITS OWN OUTPUT IS IN THAT STREAM, so a check could print the sentence
 * that constituted its own proof — `console.log("Tests  1 failed (1)")` above
 * an `it.skip` was enough to mint a byte-locked must-fail-first receipt over a
 * check that graded nothing. `lib/harness/tally-signals.ts` carries the full
 * account and the reproduction. Nothing in this decision path reads free text
 * any more.
 *
 * `kind` still leads the parameter list and still has no default (issue #956):
 * it selects the timeout budget in {@link runCheckCommand} and it names the
 * runner in every diagnostic, and a call site that could omit it is a call site
 * that does not know which runner it just graded.
 */
export function classifyCheckRun(
  kind: CheckKind,
  obs: CheckRunObservation,
  expect: CheckRunExpectation,
): CheckRunVerdict {
  // Stripped before ANY matching, for BOTH kinds — see `classifyHarnessRun`'s
  // identical guard and `stripAnsi`'s doc comment for the failure it prevents.
  // The evidence line is line-anchored, so a stray escape ahead of it would
  // defeat the match exactly as it defeated the old tally patterns.
  const output = stripAnsi(obs.output);
  if (obs.spawnFailed) {
    return { status: "inconclusive", reason: "process could not be spawned" };
  }
  if (obs.timedOut) {
    return {
      status: "inconclusive",
      reason: "did not complete — the bound fired or the process was killed",
    };
  }
  const reading = readRunEvidence(output, obs.nonce);
  if (reading.kind !== "proved") {
    return {
      status: "inconclusive",
      reason: `${CHECK_KIND_RUNNER_NAME[kind]}: ${reading.reason}`,
    };
  }
  // Issue #925, build step 3 — "`classifyCheckRun` demands a mark. No mark, no
  // trusted proof."
  //
  // A browser check that never REACHED its own grading helper can still exit
  // non-zero for an unrelated reason: a missing route, a bad import, a syntax
  // error. That mints a must-fail-first receipt on a check which cannot detect
  // a wrong figure at all — the very red the ticket's failure scenario names.
  // The builder is then dispatched and a whole round is spent before the
  // ship-time gate catches it.
  //
  // The demand is POSITIVE EVIDENCE THE HELPER RAN, in any direction:
  //
  //   - a grade mark, meaning it ran and the figure matched, or
  //   - any of `SCREEN_CHECK_SENTINELS`, meaning it ran and refused, or
  //   - on a RED reading only, a nonce-keyed SETTLED record —
  //     `waitForGradableScreen` appended it to the run's mark file once the
  //     page settled and its claim matched, and the HOST's epilogue relayed
  //     it (`parseSettledMark`).
  //
  // The third arm was added 2026-08-31 (issues #1160/#1161). This comment
  // used to claim "a healthy check always produces one or the other" of the
  // first two, and that was FALSE: a check that settled fine and then went
  // red on a plain `expect()` BEFORE reaching `gradeScreenText` — exactly the
  // red a must-fail-first proof needs — produced no grade mark (written only
  // after the assertion passes) and no refusal sentinel (the helper did not
  // refuse), so its genuinely-red proof read "inconclusive" and the ticket
  // quarantined.
  //
  // HARDENED 2026-09-01: the arm originally read the printed
  // `SCREEN_SETTLED_SENTINEL` line with `output.includes()`. That line is a
  // plain `console.log` from the agent-authored check — the exact spoof
  // channel the nonce-signed evidence line and grade mark exist to close —
  // so a check could print the literal and have a red that never opened a
  // page accepted. The verdict now rests ONLY on the nonce-keyed settled
  // record, and when the caller supplied the envelope's declared screen the
  // record must also NAME that screen (by its label or its real URL —
  // equality or containment either way, since one is a route and the other a
  // full address). The printed line survives as human diagnostics only.
  //
  // Red only, on purpose. A GREEN accepted on settled evidence alone would be
  // a check whose `gradeScreenText` was never reached — behind `if (false)`,
  // after an early return — passing the gate, which is the very hole issue
  // #925 closed. The green acceptance path is byte-for-byte what it was:
  // grade mark or refusal sentinel, nothing weaker.
  //
  // Browser only: a unit check has no screen and no helper to reach.
  if (kind === "browser") {
    const graded = (parseGradeMark(output, obs.nonce)?.count ?? 0) > 0;
    const spoke = SCREEN_CHECK_SENTINELS.some((s) => output.includes(s));
    const settled = parseSettledMark(output, obs.nonce);
    const settledRed =
      reading.colour === "red" &&
      settled !== undefined &&
      settled.count > 0 &&
      settledScreenConfirmed(settled.screens, obs.declaredScreen);
    if (!graded && !spoke && !settledRed) {
      return {
        status: "inconclusive",
        screenUnreached: true,
        reason:
          `observed ${reading.colour} (exit ${obs.exitCode}), but nothing ` +
          "says the check ever reached the screen: no grade mark and no " +
          "screen-check sentinel (and no nonce-keyed settled record naming " +
          "the declared screen, on a red). A check that cannot look at the " +
          "screen cannot prove a wrong figure, whichever colour it came back",
      };
    }
  }
  const observed = reading.colour;
  const proved = {
    colour: observed,
    passed: reading.evidence.passed,
    failed: reading.evidence.failed,
    skipped: reading.evidence.skipped,
  } as const;
  if (observed === expect) {
    return {
      status: "pass",
      proved,
      reason: `observed ${observed}, expected ${expect} (exit ${obs.exitCode}) — matched`,
    };
  }
  return {
    status: "fail",
    proved,
    reason: `observed ${observed}, expected ${expect} (exit ${obs.exitCode}) — mismatch`,
  };
}

/**
 * Impure half: actually execute `command` inside the sandbox via `exec` and
 * classify the result. `exec === undefined` (a sandbox provider that offers
 * no command execution) and any rejection from `exec` itself (a transport
 * fault, not a check result — see `SandboxCommandRunner`'s own doc) both
 * read as inconclusive, never as a silent pass.
 *
 * ## Why the budget is the HARNESS's budget
 *
 * The command run here is the SAME `pnpm … e2e -- <file>` string the ship-time
 * harness gate runs (`buildCheckCommand` builds it once for both). It
 * therefore has the same worst case: Playwright boots a cold dev server
 * (`reuseExistingServer: false`) and only then starts the test, so
 * `webServer.timeout` and the per-test `timeout` stack sequentially inside one
 * invocation — see {@link DEFAULT_TIMEOUT_MS}'s own doc comment for the
 * arithmetic, and `timeout-budget-contract.test.ts`, which pins BOTH entry
 * points against the real numbers in `playwright.config.ts`.
 *
 * This default used to be `120_000` — exactly the cold-boot budget alone,
 * leaving the check zero time to run even once the server was up. That does
 * not merely make the proof slow: a bound that fires produces `timedOut`,
 * which {@link classifyCheckRun} reports as `inconclusive`, and an
 * inconclusive must-fail-first proof is indistinguishable from a check that
 * was never able to prove anything. A slow night must not be able to waive
 * the proof.
 *
 * ## `nonce` MUST be the one `command` was built with
 *
 * It is the key the host's evidence line inside `command` is signed with, and
 * the only thing that makes any of the output attributable to the runner. Pass
 * the wrong one and every run reads `inconclusive` — safe, but it would stop
 * healthy tickets, so build the command and run it in the same breath:
 *
 * ```ts
 * const nonce = newCheckNonce();
 * const command = buildUnitCheckCommand(pkg, issue, rel, nonce);
 * const verdict = await runCheckCommand(kind, exec, command, "red", nonce);
 * ```
 *
 * A command is not a durable artifact: it carries a per-run secret, so it must
 * never be stored and replayed. See `buildCheckCommand`'s doc for why reuse
 * across the must-fail-first proof and the ship-time re-check would hand the
 * builder's own code the report path the second verdict is read from.
 */
export async function runCheckCommand(
  kind: CheckKind,
  exec: SandboxCommandRunner | undefined,
  command: string,
  expect: CheckRunExpectation,
  nonce: string,
  timeoutMs = CHECK_TIMEOUT_BUDGET_MS[kind],
  logTarget?: CheckRunLogTarget,
  /** See {@link CheckRunObservation.declaredScreen}. */
  declaredScreen?: string,
): Promise<CheckRunVerdict> {
  // THE RED RUN IS THE ONE #803 DIED ON, so it gets the same persistence the
  // ship-time harness gets, from the same writer, into the same directory —
  // see `runHarnessScreenCheck`'s own `logTarget` note. Purely additive: every
  // verdict below is byte-for-byte what it was before, target or no target.
  const startedAtIso = new Date().toISOString();
  const startedAt = Date.now();
  const persist = (r: {
    exitCode: number | null;
    timedOut: boolean;
    failure?: string;
    output: string;
    verdict: CheckRunVerdict;
  }): void => {
    if (logTarget === undefined) return;
    writeCheckRunLog(logTarget, {
      kind,
      // The must-fail-first proof is run exactly ONCE — there is no re-run
      // rule on this side. Stated rather than implied so a reader does not go
      // looking for the second file the ship-time phase would have written.
      attempt: 1,
      maxAttempts: 1,
      command,
      timeoutMs,
      durationMs: Date.now() - startedAt,
      startedAtIso,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      failure: r.failure,
      output: r.output,
      verdict: r.verdict.status,
      reason: r.verdict.reason,
      expectation: expect,
    });
  };

  if (exec === undefined) {
    const verdict: CheckRunVerdict = {
      status: "inconclusive",
      reason: "sandbox does not expose command execution",
    };
    persist({
      exitCode: null,
      timedOut: false,
      failure: "the sandbox exposed no command execution — nothing was run",
      output: "",
      verdict,
    });
    return verdict;
  }
  try {
    const res = await exec(command, { timeoutMs });
    const output = `${res.stdout}\n${res.stderr}`;
    // The tail rides back on EVERY verdict, pass included — a caller that only
    // wants it on the unexpected readings can ignore it, but a classifier that
    // only attached evidence to the outcomes it already understood would be
    // useless for exactly the outcome nobody anticipated.
    const verdict: CheckRunVerdict = {
      ...classifyCheckRun(
        kind,
        {
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          spawnFailed: false,
          output,
          nonce,
          declaredScreen,
        },
        expect,
      ),
      outputTail: checkOutputTail(output),
    };
    persist({
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      output,
      verdict,
    });
    return verdict;
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    const verdict: CheckRunVerdict = {
      status: "inconclusive",
      reason: `could not run: ${failure}`,
    };
    persist({ exitCode: null, timedOut: false, failure, output: "", verdict });
    return verdict;
  }
}
