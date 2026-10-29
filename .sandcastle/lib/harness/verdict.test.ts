import { describe, expect, it } from "vitest";

import { formatGradeMarkLine, formatSettledMarkLine } from "./grade-mark.js";
import { formatRunEvidence } from "./tally-signals.js";
import {
  CLAIM_MISMATCH_SENTINEL,
  classifyHarnessRun,
  GRADED_FIGURE_SENTINEL,
  moreEvidencedVerdict,
  NEVER_SETTLED_SENTINEL,
  SCREEN_SETTLED_SENTINEL,
} from "./verdict.js";

const NONCE = "0123456789abcdef0123456789abcdef";

/**
 * The host's evidence line for one run, appended to whatever the runner (and
 * the check) happened to print. Every fixture below is built through this,
 * because that line is now the ONLY thing either classifier reads.
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
    /** Settled records for the host's `SC-SETTLED` line (2026-09-01) — one
     *  entry per record's screen. Empty by default. */
    settledScreens?: readonly string[];
  },
): string {
  const settledScreens = ev.settledScreens ?? [];
  const settledDetail =
    settledScreens.length > 0
      ? Buffer.from(
          settledScreens
            .map((screen) => JSON.stringify({ screen, settled: true }))
            .join("\n"),
          "utf8",
        ).toString("base64")
      : "";
  return (
    `${runnerOutput}\n${formatRunEvidence(NONCE, {
      reportPresent: ev.reportPresent ?? true,
      exitCode: ev.exitCode,
      passed: ev.passed ?? 0,
      failed: ev.failed ?? 0,
      skipped: ev.skipped ?? 0,
      flaky: ev.flaky ?? 0,
    })}\n${formatGradeMarkLine(NONCE, ev.graded ?? 1, "")}\n${formatSettledMarkLine(
      NONCE,
      settledScreens.length,
      settledDetail,
    )}\n`
  );
}

/** Playwright's real line-reporter tallies — now decoration, not evidence. */
const TALLY_PASS = "1 passed (2.1s)";
const TALLY_FAIL = "1 failed\n1 passed (2.1s)";

describe("classifyHarnessRun", () => {
  it("is inconclusive when the process could not be spawned — genuine absence of proof", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: null,
      timedOut: false,
      spawnFailed: true,
      output: "",
      nonce: NONCE,
    });
    expect(r.verdict).toBe("inconclusive");
  });

  it("is inconclusive on a timeout, even with a full evidence line in the output", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: 1,
      timedOut: true,
      spawnFailed: false,
      output: withEvidence(TALLY_FAIL, { exitCode: 1, failed: 1 }),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("inconclusive");
  });

  it("is inconclusive when nothing attributable to the runner reached us", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: 1,
      timedOut: false,
      spawnFailed: false,
      output: "some unrelated crash output",
      nonce: NONCE,
    });
    expect(r.verdict).toBe("inconclusive");
  });

  it("is inconclusive when the evidence line is signed with a DIFFERENT run's nonce", () => {
    // A replayed command, or a command built with one nonce and graded with
    // another. Safe direction: nothing is attributable, so nothing is proven.
    const r = classifyHarnessRun("browser", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(TALLY_PASS, { exitCode: 0, passed: 1 }),
      nonce: "ffffffffffffffffffffffffffffffff",
    });
    expect(r.verdict).toBe("inconclusive");
  });

  it("is match on a report recording a passed test beside a zero exit", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(TALLY_PASS, { exitCode: 0, passed: 1 }),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("match");
  });

  // Issue #925, the failure this whole ticket is about. A check whose
  // `gradeScreenText` call sits behind `if (false)`, after an early `return`,
  // or inside a function nobody calls exits 0 with a real Playwright report
  // and no sentinel. Before the grade mark, that was byte-for-byte identical
  // to a check that graded correctly, and shipped a wrong figure on screen
  // behind a green tick.
  it("REFUSES a clean browser exit that graded NO screen — the hole #925 names", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(TALLY_PASS, { exitCode: 0, passed: 1, graded: 0 }),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("environment-fault");
    expect(r.reason).toContain("graded NO screen");
  });

  it("REFUSES a clean browser exit whose grade mark never reached the host", () => {
    // The epilogue's own `node` died, or the output was truncated below it.
    // Absence of the line is a different fact from `graded=0`, and both must
    // fail closed: neither says the screen was graded.
    const r = classifyHarnessRun("browser", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: `${TALLY_PASS}\n${formatRunEvidence(NONCE, {
        reportPresent: true,
        exitCode: 0,
        passed: 1,
        failed: 0,
        skipped: 0,
        flaky: 0,
      })}\n`,
      nonce: NONCE,
    });
    expect(r.verdict).toBe("environment-fault");
    expect(r.reason).toContain("no grade mark");
  });

  it("a UNIT check is never asked for a grade mark — it has no screen", () => {
    // Demanding one there would refuse every unit check for a screen it was
    // never asked about.
    const r = classifyHarnessRun("unit", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: `1 passed\n${formatRunEvidence(NONCE, {
        reportPresent: true,
        exitCode: 0,
        passed: 1,
        failed: 0,
        skipped: 0,
        flaky: 0,
      })}\n`,
      nonce: NONCE,
    });
    expect(r.verdict).toBe("match");
  });

  it("is never-settled when the never-settled sentinel appears in a PROVEN-RED run", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: 1,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(
        `Error: ${NEVER_SETTLED_SENTINEL} screen=/finance/reports reason=timeout\n${TALLY_FAIL}`,
        { exitCode: 1, failed: 1 },
      ),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("never-settled");
  });

  it("is claim-mismatch when the claim-mismatch sentinel appears", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: 1,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(
        `Error: ${CLAIM_MISMATCH_SENTINEL} screen=/finance/reports detail={}\n${TALLY_FAIL}`,
        { exitCode: 1, failed: 1 },
      ),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("claim-mismatch");
  });

  it("is graded-mismatch ONLY when GRADED_FIGURE_SENTINEL proves gradeScreenText itself ran and failed", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: 1,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(
        `Error: ${GRADED_FIGURE_SENTINEL} graded figure mismatch: expected ` +
          `text to contain "$50,032.50", got "$41,000.00"\n${TALLY_FAIL}`,
        { exitCode: 1, failed: 1 },
      ),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("graded-mismatch");
  });

  // 2026-08-04 review finding #6 (BLOCKER): sign-in, navigation, an app
  // 500, or a bare Playwright test-level timeout all happen OUTSIDE
  // waitForGradableScreen's guarded call and OUTSIDE gradeScreenText — none
  // of them carry ANY sentinel. Before that fix, "no sentinel" defaulted to
  // graded-mismatch (which maps to the LOUD stopped:check-disagreement PLUS
  // needs-owner-decision) — on a systemic failure (e.g. the practice
  // database failing to clone), every queued ticket would wake the owner to
  // break a builder-vs-check tie that never existed.
  describe("environment-fault — no sentinel present at all (finding #6 fix)", () => {
    it("PROVES THE INSTRUMENT: an ordinary Playwright assertion failure with NO GRADED_FIGURE_SENTINEL is environment-fault, not graded-mismatch", () => {
      const r = classifyHarnessRun("browser", {
        exitCode: 1,
        timedOut: false,
        spawnFailed: false,
        output: withEvidence(
          `Error: expect(locator).toHaveText(expected)\nExpected: "$50,032.50"\nReceived: "$41,000.00"\n${TALLY_FAIL}`,
          { exitCode: 1, failed: 1 },
        ),
        nonce: NONCE,
      });
      expect(r.verdict).toBe("environment-fault");
    });

    it("classifies a broken sign-in (signInAsPracticeUser's plain, un-sentineled throw) as environment-fault", () => {
      const r = classifyHarnessRun("browser", {
        exitCode: 1,
        timedOut: false,
        spawnFailed: false,
        output: withEvidence(
          `Error: signInAsPracticeUser: still on /auth/login after retries (email=x@example.com)\n${TALLY_FAIL}`,
          { exitCode: 1, failed: 1 },
        ),
        nonce: NONCE,
      });
      expect(r.verdict).toBe("environment-fault");
    });

    it("classifies a bare Playwright test-level timeout (no sentinel ever reached) as environment-fault", () => {
      const r = classifyHarnessRun("browser", {
        exitCode: 1,
        // the PROCESS didn't time out — Playwright's own per-test timeout fired internally
        timedOut: false,
        spawnFailed: false,
        output: withEvidence(`Test timeout of 240000ms exceeded.\n${TALLY_FAIL}`, {
          exitCode: 1,
          failed: 1,
        }),
        nonce: NONCE,
      });
      expect(r.verdict).toBe("environment-fault");
    });

    it("classifies a Playwright globalSetup failure — no test ever graded — as environment-fault", () => {
      // Playwright still writes a report, with every counter at zero.
      const r = classifyHarnessRun("browser", {
        exitCode: 1,
        timedOut: false,
        spawnFailed: false,
        output: withEvidence("Error: write CONNECT_TIMEOUT 172.17.0.1:55432", {
          exitCode: 1,
        }),
        nonce: NONCE,
      });
      expect(r.verdict).toBe("environment-fault");
    });
  });

  // 2026-09-01 review, finding B: pass-early-die-late. The proof gate admits a
  // settled-then-plain-red check; the ship-time classifier must read the same
  // evidence, or that check's real red is misfiled as an environment fault.
  describe("settled evidence at ship time (2026-09-01)", () => {
    const settledRed = withEvidence(
      `${SCREEN_SETTLED_SENTINEL} screen=/finance/reports?view=team\n` +
        "Error: expect(received).toBe(expected)\n1 failed",
      {
        exitCode: 1,
        failed: 1,
        graded: 0,
        settledScreens: ["/finance/reports?view=team"],
      },
    );

    it("a red that provably settled its screen (nonce-keyed record, no sentinel) is graded-mismatch — the judge road, not an environment fault", () => {
      const r = classifyHarnessRun("browser", {
        exitCode: 1,
        timedOut: false,
        spawnFailed: false,
        output: settledRed,
        nonce: NONCE,
      });
      expect(r.verdict).toBe("graded-mismatch");
    });

    it("the same red with only the PRINTED sentinel (no nonce-keyed record) stays environment-fault — the spoof channel is closed here too", () => {
      const forged = withEvidence(
        `${SCREEN_SETTLED_SENTINEL} screen=/finance/reports?view=team\n1 failed`,
        { exitCode: 1, failed: 1, graded: 0 },
      );
      const r = classifyHarnessRun("browser", {
        exitCode: 1,
        timedOut: false,
        spawnFailed: false,
        output: forged,
        nonce: NONCE,
      });
      expect(r.verdict).toBe("environment-fault");
    });
  });

  it("distinguishes never-settled from claim-mismatch from graded-mismatch from environment-fault — four verdicts, never one shared failure", () => {
    const red = (extra: string) => ({
      exitCode: 1,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(`${extra}\n${TALLY_FAIL}`, { exitCode: 1, failed: 1 }),
      nonce: NONCE,
    });
    const all = new Set([
      classifyHarnessRun("browser", red(NEVER_SETTLED_SENTINEL)).verdict,
      classifyHarnessRun("browser", red(CLAIM_MISMATCH_SENTINEL)).verdict,
      classifyHarnessRun("browser", red(GRADED_FIGURE_SENTINEL)).verdict,
      classifyHarnessRun("browser", red("an ordinary failure, no sentinel")).verdict,
    ]);
    expect(all.size).toBe(4);
  });

  it("is NOT match on a Playwright 'flaky' result — a Playwright-level retry in disguise", () => {
    // A test that failed then passed on Playwright's OWN internal retry. This
    // is why `playwright.config.ts` hardcodes `retries: 0` regardless of
    // `CI=1`. It used to be INVISIBLE — the line reporter's "N flaky" summary
    // carries neither tally word, so the old regexes saw no tally at all. The
    // JSON report has a `flaky` counter, so it is now an explicit refusal.
    const r = classifyHarnessRun("browser", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(
        "Retrying issue-912/team-net-income.spec.ts, attempt #1\n  1 flaky\n",
        { exitCode: 0, flaky: 1 },
      ),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("environment-fault");
  });

  it("prefers never-settled over claim-mismatch if both sentinels somehow appear (never-settled is more specific)", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: 1,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(
        `${NEVER_SETTLED_SENTINEL}\n${CLAIM_MISMATCH_SENTINEL}\n${TALLY_FAIL}`,
        { exitCode: 1, failed: 1 },
      ),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("never-settled");
  });
});

// ---------------------------------------------------------------------------
// THE FORGERY (2026-08-06). A check file is written by an agent and its own
// output lands in the same stream the classifier reads. Until this fix, the
// bytes below — a REAL vitest run of a REAL committed check that imports a
// real product module, prints two forged tally lines and then `it.skip`s its
// only test — read as `match` and shipped the ticket.
// ---------------------------------------------------------------------------

/** Verbatim bytes of that run, minus the host's evidence line. */
const FORGED_RUNNER_OUTPUT = `
> @acme/validators@ test /repo/packages/validators
> vitest src/__checks__/issue-999999/forged.test.ts


 RUN  v3.2.4 /repo/packages/validators


Tests  1 failed (1)

Tests  1 passed (1)

  1 passed (1.2s)
stdout | src/__checks__/issue-999999/forged.test.ts
Tests  1 failed (1)
Tests  1 passed (1)

 ↓ src/__checks__/issue-999999/forged.test.ts (1 test | 1 skipped)

 Test Files  1 skipped (1)
      Tests  1 skipped (1)
   Start at  00:16:31
   Duration  509ms (transform 93ms, setup 0ms, collect 318ms, tests 0ms)
`;

describe("a check cannot manufacture its own verdict by printing", () => {
  it("THE ONE THAT MATTERS: forged `Tests  1 passed (1)` in a run that graded NOTHING is not a match", () => {
    // The runner's own report for these exact bytes: passed 0, failed 0,
    // skipped 1, exit 0 — captured by hand from the real run.
    const r = classifyHarnessRun("unit", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(FORGED_RUNNER_OUTPUT, { exitCode: 0, skipped: 1 }),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("environment-fault");
  });

  it("the same forgery with NO host evidence line at all is inconclusive, never a match", () => {
    // What the loop would see if the epilogue were ever dropped from the
    // command: the check's forged prose and nothing else.
    const r = classifyHarnessRun("unit", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: FORGED_RUNNER_OUTPUT,
      nonce: NONCE,
    });
    expect(r.verdict).toBe("inconclusive");
  });

  it("the browser twin: a Playwright check printing `1 passed` while skipping its only test", () => {
    const r = classifyHarnessRun("browser", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(
        "\n  1 passed (1.2s)\n  1 failed (1.2s)\nRunning 1 test using 1 worker\n  1 skipped\n",
        { exitCode: 0, skipped: 1 },
      ),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("environment-fault");
  });

  it("a check that prints a forged EVIDENCE LINE loses to the host's real one, which is always last", () => {
    const forged = formatRunEvidence(NONCE, {
      reportPresent: true,
      exitCode: 0,
      passed: 1,
      failed: 0,
      skipped: 0,
      flaky: 0,
    });
    const r = classifyHarnessRun("unit", {
      exitCode: 0,
      timedOut: false,
      spawnFailed: false,
      output: withEvidence(`${forged}\n${FORGED_RUNNER_OUTPUT}`, {
        exitCode: 0,
        skipped: 1,
      }),
      nonce: NONCE,
    });
    expect(r.verdict).toBe("environment-fault");
  });
});

// ---------------------------------------------------------------------------
// The vitest runner (issue #956). Same receipt, same byte-lock, same ship-time
// re-check — only the instrument changes.
// ---------------------------------------------------------------------------

describe("classifyHarnessRun — kind: unit (vitest)", () => {
  const unit = (
    ev: Parameters<typeof withEvidence>[1],
    runnerOutput = "",
  ) => ({
    exitCode: ev.exitCode,
    timedOut: false,
    spawnFailed: false,
    output: withEvidence(runnerOutput, ev),
    nonce: NONCE,
  });

  it("is inconclusive when the process could not be spawned", () => {
    expect(
      classifyHarnessRun("unit", {
        exitCode: null,
        timedOut: false,
        spawnFailed: true,
        output: "",
        nonce: NONCE,
      }).verdict,
    ).toBe("inconclusive");
  });

  it("is inconclusive on a timeout, even with real evidence in the output", () => {
    expect(
      classifyHarnessRun("unit", {
        ...unit({ exitCode: 1, failed: 1 }),
        timedOut: true,
      }).verdict,
    ).toBe("inconclusive");
  });

  it("is inconclusive when the filter matched no file — a check that would 'pass by being absent' must never read green", () => {
    // Exactly what a unit check written OUTSIDE its package's vitest
    // `include` glob prints: no report is written at all.
    expect(
      classifyHarnessRun("unit", {
        exitCode: 1,
        timedOut: false,
        spawnFailed: false,
        output: withEvidence("No test files found, exiting with code 1\n", {
          exitCode: 1,
          reportPresent: false,
        }),
        nonce: NONCE,
      }).verdict,
    ).toBe("inconclusive");
  });

  it("is match when the report records a passed test", () => {
    expect(classifyHarnessRun("unit", unit({ exitCode: 0, passed: 1 })).verdict).toBe(
      "match",
    );
  });

  it("is NOT match when every test was skipped — exit 0 alone is not evidence", () => {
    // `it.skip` everywhere exits ZERO with a perfectly real report and zero
    // assertions run. Trusting the code alone would ship a ticket whose
    // ship-time re-check graded nothing at all.
    expect(
      classifyHarnessRun("unit", unit({ exitCode: 0, skipped: 1 })).verdict,
    ).toBe("environment-fault");
  });

  it("is graded-mismatch when the report proves a test body ran and an assertion disagreed", () => {
    expect(classifyHarnessRun("unit", unit({ exitCode: 1, failed: 1 })).verdict).toBe(
      "graded-mismatch",
    );
  });

  it("is graded-mismatch on a mixed run too — one passing sibling does not hide the failure", () => {
    expect(
      classifyHarnessRun("unit", unit({ exitCode: 1, failed: 1, passed: 1 })).verdict,
    ).toBe("graded-mismatch");
  });

  it("is environment-fault, NOT graded-mismatch, on a collection failure — it graded nothing", () => {
    // A top-level throw, an import of a module that does not exist, a
    // `describe` with no `it()` in it: all exit 1 with every counter at zero.
    // Nothing was graded, so there is no builder-vs-check tie for the owner to
    // break and this must not wake them.
    expect(
      classifyHarnessRun(
        "unit",
        unit({ exitCode: 1 }, "Error: Cannot find module './nope.js'"),
      ).verdict,
    ).toBe("environment-fault");
  });

  it("ignores the browser-only sentinels — they are unreachable for a vitest run and must not steer it", () => {
    // A unit check's own assertion message could contain anything, including
    // these strings. `never-settled` and `claim-mismatch` describe a PAGE.
    expect(
      classifyHarnessRun(
        "unit",
        unit(
          { exitCode: 1, failed: 1 },
          `AssertionError: expected "${NEVER_SETTLED_SENTINEL}"`,
        ),
      ).verdict,
    ).toBe("graded-mismatch");
  });

  it("grades a COLORIZED stream — both runners colorize even under CI/NO_COLOR, and the escapes land mid-line", () => {
    const colorized =
      `[2m${formatRunEvidence(NONCE, {
        reportPresent: true,
        exitCode: 1,
        passed: 0,
        failed: 1,
        skipped: 0,
        flaky: 0,
      })}[22m\n`;
    expect(
      classifyHarnessRun("unit", {
        exitCode: 1,
        timedOut: false,
        spawnFailed: false,
        output: colorized,
        nonce: NONCE,
      }).verdict,
    ).toBe("graded-mismatch");
  });
});

describe("moreEvidencedVerdict over the unit subset", () => {
  // `never-settled` and `claim-mismatch` are unreachable for a vitest run, so
  // the ladder the unit path actually walks is the four-rung subset
  // inconclusive < environment-fault < graded-mismatch < match. The ranking
  // must stay honest across that gap, or a re-run that proved LESS could
  // overwrite one that proved more — the exact defect `moreEvidencedVerdict`
  // was written for, just on the other runner.
  const r = (verdict: Parameters<typeof moreEvidencedVerdict>[0]["verdict"]) => ({
    verdict,
    reason: verdict,
  });

  it("a graded unit failure outranks a re-run that proved nothing", () => {
    expect(
      moreEvidencedVerdict(r("graded-mismatch"), r("inconclusive")).verdict,
    ).toBe("graded-mismatch");
  });

  it("a graded unit failure outranks a collection failure that graded nothing", () => {
    expect(
      moreEvidencedVerdict(r("graded-mismatch"), r("environment-fault")).verdict,
    ).toBe("graded-mismatch");
  });

  it("a re-run that finally matched wins over any failure — ties and improvements both go to the later attempt", () => {
    expect(moreEvidencedVerdict(r("graded-mismatch"), r("match")).verdict).toBe(
      "match",
    );
    expect(moreEvidencedVerdict(r("match"), r("match")).verdict).toBe("match");
  });

  it("two ways of proving nothing still prove nothing", () => {
    expect(
      moreEvidencedVerdict(r("inconclusive"), r("inconclusive")).verdict,
    ).toBe("inconclusive");
  });
});
