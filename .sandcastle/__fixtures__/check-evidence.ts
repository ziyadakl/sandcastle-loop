/**
 * Fake check runs that produce the HOST-generated evidence a real check run
 * produces (issue #956).
 *
 * WHY THIS FILE EXISTS: since the forged-tally hole was closed, NOTHING in the
 * verdict path reads free text. A fake `exec` returning `stdout: "1 failed"`
 * now proves exactly what it should prove — nothing — so every test that used
 * one was silently asserting against `inconclusive`. The honest fixture has to
 * do what the real host does: read the nonce out of the command it was handed
 * and print {@link formatRunEvidence} under it.
 *
 * ONE copy, imported by every suite that needs it. Five hand-kept copies of a
 * nonce parse across five `main.*.test.mts` files is the same drift liability
 * `lib/harness/tally-signals.ts` exists to remove, and it would rot the first
 * time the evidence line changes shape.
 *
 * NOT a `*.test.ts` file on purpose: vitest's default include glob only picks
 * up `*.{test,spec}.*`, so this module is imported, never collected as a suite.
 */
import type {
  SandboxCommandRunner,
  SandboxExecResult,
} from "../lib/sandbox-exec.js";
import {
  formatGradeMarkLine,
  formatSettledMarkLine,
} from "../lib/harness/grade-mark.js";
import {
  checkNonceFromCommand,
  checkReportPathFor,
  formatRunEvidence,
  newCheckNonce,
} from "../lib/harness/tally-signals.js";

/** One fake run's counters, as the runner's own report would have carried them. */
export interface FakeCheckRun {
  /** The RUNNER's exit status. Must agree with the counters, as a real one does. */
  readonly exitCode: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped?: number;
  readonly flaky?: number;
  /** `false` simulates a runner that never wrote its report at all. */
  readonly reportPresent?: boolean;
  /** The CHECK's own output, printed BEFORE the host's line, where it really lands. */
  readonly stdout?: string;
  /**
   * How many screens the run graded — issue #925.
   *
   * Defaults to 1, because a real browser run of a real check always grades at
   * least one screen. A fixture defaulting to 0 would quietly assert the
   * BROKEN case — a `gradeScreenText` call the run never reached — in every
   * suite at once. Pass 0 deliberately to build that case.
   */
  readonly graded?: number;
  /**
   * How many screens `waitForGradableScreen` settled — the nonce-keyed
   * settled record of 2026-09-01. Defaults to 0: most fixtures prove their
   * run via the grade mark, and a settled record is only what a
   * settled-then-plain-red run leaves behind. Pass 1+ (with
   * {@link settledScreen}) to build that case.
   */
  readonly settled?: number;
  /** The screen the settled record names. Defaults to "/practice-screen". */
  readonly settledScreen?: string;
}

/** A check that ran and failed one assertion — the must-fail-first proof's target. */
export const RED_RUN: FakeCheckRun = { exitCode: 1, passed: 0, failed: 1 };

/** A check that ran and passed — the ship-time `match`. */
export const GREEN_RUN: FakeCheckRun = { exitCode: 0, passed: 1, failed: 0 };

/**
 * What a real run of `command` would have put on stdout: the check's own
 * output, then the host epilogue's nonce-keyed evidence line last — LAST
 * because {@link parseRunEvidence} deliberately takes the final match.
 *
 * A `command` carrying no nonce yields only the check's own output, which is
 * exactly what the classifier should refuse to grade.
 */
export function checkRunStdout(command: string, run: FakeCheckRun): string {
  const nonce = checkNonceFromCommand(command);
  const own = run.stdout ?? "";
  if (nonce === undefined) return own;
  const line = formatRunEvidence(nonce, {
    reportPresent: run.reportPresent ?? true,
    exitCode: run.exitCode,
    passed: run.passed,
    failed: run.failed,
    skipped: run.skipped ?? 0,
    flaky: run.flaky ?? 0,
  });
  // Issue #925: a real browser run also carries the host's grade-mark line,
  // printed by the same epilogue right after the evidence line. A green run
  // without one is now refused, so a fixture that omitted it would assert the
  // broken case everywhere.
  const mark = formatGradeMarkLine(nonce, run.graded ?? 1, "");
  // The settled line rides the same epilogue (2026-09-01). A count of 0 with
  // empty detail is exactly what the real epilogue prints for a run whose
  // helper never settled a page.
  const settledCount = run.settled ?? 0;
  const settledDetail =
    settledCount > 0
      ? Buffer.from(
          Array.from({ length: settledCount }, () =>
            JSON.stringify({
              screen: run.settledScreen ?? "/practice-screen",
              url: `http://localhost:3000${run.settledScreen ?? "/practice-screen"}`,
              settled: true,
            }),
          ).join("\n"),
          "utf8",
        ).toString("base64")
      : "";
  const settledLine = formatSettledMarkLine(nonce, settledCount, settledDetail);
  return `${own}\n${line}\n${mark}\n${settledLine}\n`;
}

/** {@link checkRunStdout} wrapped in a full exec result. */
export function checkRunResult(
  command: string,
  run: FakeCheckRun,
): SandboxExecResult {
  return {
    stdout: checkRunStdout(command, run),
    stderr: "",
    exitCode: run.exitCode,
    timedOut: false,
  };
}

/** An `exec` fake that answers every command with the same run. */
export function checkRunExec(run: FakeCheckRun): SandboxCommandRunner {
  return async (command) => checkRunResult(command, run);
}

/**
 * An `exec` fake that walks `runs` in order, one per call, and repeats the
 * last entry once it runs out — for the ladders that need attempt 1 and
 * attempt 2 to differ.
 */
export function checkRunExecSequence(
  runs: readonly FakeCheckRun[],
): SandboxCommandRunner {
  let call = 0;
  return async (command) => {
    const run = runs[Math.min(call, runs.length - 1)]!;
    call += 1;
    return checkRunResult(command, run);
  };
}

/**
 * A stand-in for a command a real builder produced: whatever `base` is, plus
 * the nonce-named report path the builders bake in. Tests that hand a
 * `checkCommand` straight to the ship-time harness need one, because that
 * funnel recovers the nonce FROM the command (see `main.mts`'s
 * `runScreenCheckHarness`).
 */
export function commandWithNonce(base: string, nonce = newCheckNonce()): string {
  return `${base} --outputFile=${checkReportPathFor(nonce)}`;
}
