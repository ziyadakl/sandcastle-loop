import { describe, expect, it } from "vitest";

import type { SandboxCommandRunner } from "../sandbox-exec.js";
import { runHarnessScreenCheck } from "./run-harness-check.js";
import { formatGradeMarkLine } from "./grade-mark.js";
import { formatRunEvidence } from "./tally-signals.js";
import { GRADED_FIGURE_SENTINEL } from "./verdict.js";

const NONCE = "0123456789abcdef0123456789abcdef";

/**
 * One run's stream: whatever the runner printed, plus the HOST's evidence line
 * — the only part either classifier reads. See `./tally-signals.ts` for why a
 * check's own printing can no longer move a verdict.
 */
function withEvidence(
  runnerOutput: string,
  ev: {
    exitCode: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    flaky?: number;
    reportPresent?: boolean;
    /**
     * How many screens the run graded — issue #925. Defaults to 1 because a
     * real browser run of a real check always grades at least one screen, and
     * a fixture that defaulted to 0 would quietly assert the broken case
     * everywhere. Pass 0 deliberately to build the unreachable-grading-call
     * run this gate exists to refuse.
     */
    graded?: number;
  },
): string {
  return (
    `${runnerOutput}\n${formatRunEvidence(NONCE, {
      reportPresent: ev.reportPresent ?? true,
      exitCode: ev.exitCode,
      passed: ev.passed ?? 0,
      failed: ev.failed ?? 0,
      skipped: ev.skipped ?? 0,
      flaky: ev.flaky ?? 0,
    })}\n${formatGradeMarkLine(NONCE, ev.graded ?? 1, "")}\n`
  );
}

const PASS_OUTPUT = withEvidence("1 passed (1.2s)", { exitCode: 0, passed: 1 });
// Carries GRADED_FIGURE_SENTINEL (2026-08-04 review finding #6) so this
// represents a GENUINE graded mismatch — gradeScreenText itself ran and
// failed — not an environment fault (no sentinel at all).
const FAIL_OUTPUT = withEvidence(
  `1 failed\n${GRADED_FIGURE_SENTINEL} graded figure mismatch\n1 passed (1.2s)`,
  { exitCode: 1, failed: 1 },
);

function fakeExec(
  results: readonly { exitCode: number | null; stdout?: string; timedOut?: boolean }[],
): { exec: SandboxCommandRunner; calls: number[] } {
  let n = 0;
  const calls: number[] = [];
  const exec: SandboxCommandRunner = async () => {
    calls.push(n);
    const r = results[n] ?? results[results.length - 1]!;
    n += 1;
    return {
      stdout: r.stdout ?? "",
      stderr: "",
      exitCode: r.exitCode,
      timedOut: r.timedOut ?? false,
    };
  };
  return { exec, calls };
}

describe("runHarnessScreenCheck", () => {
  it("does not re-run when the first attempt matches", async () => {
    const { exec, calls } = fakeExec([{ exitCode: 0, stdout: PASS_OUTPUT }]);
    const result = await runHarnessScreenCheck(
      "browser",
      exec,
      "check-command",
      NONCE,
    );
    expect(result.verdict.verdict).toBe("match");
    expect(result.rerun).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(calls).toEqual([0]);
  });

  it("re-runs exactly once when the first attempt is not a match, and uses the second result as final", async () => {
    const { exec, calls } = fakeExec([
      { exitCode: 1, stdout: FAIL_OUTPUT },
      { exitCode: 0, stdout: PASS_OUTPUT },
    ]);
    const result = await runHarnessScreenCheck(
      "browser",
      exec,
      "check-command",
      NONCE,
    );
    expect(result.rerun).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(calls).toEqual([0, 1]);
    // The flake resolved on re-run — final verdict is the SECOND attempt's.
    expect(result.verdict.verdict).toBe("match");
  });

  it("never runs a third time — a reproducible failure stays failed after exactly one re-run", async () => {
    const { exec, calls } = fakeExec([
      { exitCode: 1, stdout: FAIL_OUTPUT },
      { exitCode: 1, stdout: FAIL_OUTPUT },
    ]);
    const result = await runHarnessScreenCheck(
      "browser",
      exec,
      "check-command",
      NONCE,
    );
    expect(result.attempts).toHaveLength(2);
    expect(calls).toEqual([0, 1]);
    expect(result.verdict.verdict).toBe("graded-mismatch");
  });

  it("keeps the first attempt's graded mismatch when the re-run only proves nothing", async () => {
    const { exec } = fakeExec([
      { exitCode: 1, stdout: FAIL_OUTPUT },
      // No host evidence line anywhere: nothing proves the suite ran at all,
      // which `classifyHarnessRun` reads as `inconclusive`.
      { exitCode: 1, stdout: "docker: dev server never came up" },
    ]);
    const result = await runHarnessScreenCheck(
      "browser",
      exec,
      "check-command",
      NONCE,
    );
    expect(result.rerun).toBe(true);
    expect(result.attempts).toHaveLength(2);
    // Attempt 1 carries positive proof that grading itself ran and the
    // figure was wrong. Attempt 2 proves nothing happened at all. A verdict
    // with evidence behind it must not be erased by one without, or the
    // ticket stops as `could-not-grade` and the issue is told "the app is
    // broken for everyone tonight" — which is false.
    expect(result.verdict.verdict).toBe("graded-mismatch");
  });

  it("takes the re-run's graded mismatch when the first attempt proved nothing", async () => {
    const { exec } = fakeExec([
      { exitCode: null, stdout: "", timedOut: true },
      { exitCode: 1, stdout: FAIL_OUTPUT },
    ]);
    const result = await runHarnessScreenCheck(
      "browser",
      exec,
      "check-command",
      NONCE,
    );
    expect(result.rerun).toBe(true);
    // The mirror of the case above, and the guard against over-correcting
    // it: "prefer the first attempt" would be just as wrong. Evidence, not
    // running order, decides.
    expect(result.verdict.verdict).toBe("graded-mismatch");
  });

  it("stays inconclusive when neither attempt proved the check ran", async () => {
    const { exec } = fakeExec([
      { exitCode: null, stdout: "", timedOut: true },
      { exitCode: 1, stdout: "docker: dev server never came up" },
    ]);
    const result = await runHarnessScreenCheck(
      "browser",
      exec,
      "check-command",
      NONCE,
    );
    // Two different ways of proving nothing still prove nothing. Preferring
    // the more-evidenced attempt must not invent evidence where there is
    // none — this is the genuinely ungradeable night the
    // `stopped:could-not-grade` wording is actually true for.
    expect(result.verdict.verdict).toBe("inconclusive");
  });

  it("keeps the graded mismatch when the re-run never reaches a graded assertion", async () => {
    const { exec } = fakeExec([
      { exitCode: 1, stdout: FAIL_OUTPUT },
      // A real failure but NO sentinel: the suite ran and died before
      // `gradeScreenText` was ever reached — `environment-fault`.
      {
        exitCode: 1,
        stdout: withEvidence("1 failed\n1 passed (1.2s)", {
          exitCode: 1,
          failed: 1,
        }),
      },
    ]);
    const result = await runHarnessScreenCheck(
      "browser",
      exec,
      "check-command",
      NONCE,
    );
    // The same defect as the inconclusive case, through the verdict kind
    // added by the 2026-08-04 finding #6: a run that never reached grading
    // saw strictly less than one that did, so it cannot downgrade
    // `stopped:check-disagreement` to `stopped:could-not-grade`.
    expect(result.verdict.verdict).toBe("graded-mismatch");
  });

  it("is inconclusive, not a silent pass, when no exec is available at all", async () => {
    const result = await runHarnessScreenCheck(
      "browser",
      undefined,
      "check-command",
      NONCE,
    );
    expect(result.verdict.verdict).toBe("inconclusive");
    // Still applies the one re-run — an absent exec is a runtime condition,
    // not a special case that skips the rule.
    expect(result.attempts).toHaveLength(2);
  });

  it("reports inconclusive, never a manufactured pass, when exec rejects", async () => {
    const exec: SandboxCommandRunner = async () => {
      throw new Error("docker daemon unreachable");
    };
    const result = await runHarnessScreenCheck(
      "browser",
      exec,
      "check-command",
      NONCE,
    );
    expect(result.verdict.verdict).toBe("inconclusive");
    expect(result.attempts[0]!.verdict.reason).toContain(
      "docker daemon unreachable",
    );
  });

  it("PROVES THE NONCE REACHES THE CLASSIFIER: a run graded under the wrong nonce proves nothing", async () => {
    // The command carries one nonce; the caller passes another. Every part of
    // the output becomes unattributable, so both attempts read inconclusive.
    // Safe, and loud enough to notice — the alternative (accepting any
    // evidence line) would be the hole all over again.
    const { exec } = fakeExec([{ exitCode: 0, stdout: PASS_OUTPUT }]);
    const result = await runHarnessScreenCheck(
      "browser",
      exec,
      "check-command",
      "ffffffffffffffffffffffffffffffff",
    );
    expect(result.verdict.verdict).toBe("inconclusive");
  });
});

// ---------------------------------------------------------------------------
// The vitest runner (issue #956). The one-re-run rule and the
// more-evidenced-wins rule are the SAME here — only the instrument changes —
// so what these pin is that `kind` really reaches the classifier, and that a
// vitest run is never graded by Playwright's rules on its way through.
// ---------------------------------------------------------------------------

describe("runHarnessScreenCheck — kind: unit", () => {
  const UNIT_PASS = withEvidence(" Test Files  1 passed (1)", {
    exitCode: 0,
    passed: 1,
  });
  const UNIT_FAIL = withEvidence(" Test Files  1 failed (1)", {
    exitCode: 1,
    failed: 1,
  });
  const UNIT_NO_TESTS = withEvidence(" Test Files  1 failed (1)", { exitCode: 1 });

  it("does not re-run when the first attempt matches", async () => {
    const { exec, calls } = fakeExec([{ exitCode: 0, stdout: UNIT_PASS }]);
    const result = await runHarnessScreenCheck("unit", exec, "check-command", NONCE);
    expect(result.verdict.verdict).toBe("match");
    expect(result.rerun).toBe(false);
    expect(calls).toEqual([0]);
  });

  it("grades a real vitest failure as graded-mismatch and re-runs exactly once", async () => {
    const { exec, calls } = fakeExec([
      { exitCode: 1, stdout: UNIT_FAIL },
      { exitCode: 1, stdout: UNIT_FAIL },
    ]);
    const result = await runHarnessScreenCheck("unit", exec, "check-command", NONCE);
    expect(result.verdict.verdict).toBe("graded-mismatch");
    expect(calls).toEqual([0, 1]);
  });

  it("keeps the first attempt's graded failure when the re-run only blew up in collection", async () => {
    const { exec } = fakeExec([
      { exitCode: 1, stdout: UNIT_FAIL },
      // A real report, but nothing graded: the suite finished having graded
      // nothing — `environment-fault`, strictly less evidence than a real
      // assertion disagreement.
      { exitCode: 1, stdout: UNIT_NO_TESTS },
    ]);
    const result = await runHarnessScreenCheck("unit", exec, "check-command", NONCE);
    expect(result.verdict.verdict).toBe("graded-mismatch");
  });

  it("PROVES THE KIND REACHES THE CLASSIFIER: Playwright prose proves nothing about a unit run", async () => {
    const { exec } = fakeExec([{ exitCode: 0, stdout: "1 passed (1.2s)" }]);
    const result = await runHarnessScreenCheck("unit", exec, "check-command", NONCE);
    expect(result.verdict.verdict).toBe("inconclusive");
    expect(result.verdict.reason).toContain("vitest");
  });
});
