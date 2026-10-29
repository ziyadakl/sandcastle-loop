import { describe, expect, it, vi } from "vitest";

import { CHECK_TIMEOUT_BUDGET_MS } from "../harness/run-harness-check.js";
import {
  formatGradeMarkLine,
  formatSettledMarkLine,
} from "../harness/grade-mark.js";
import { formatRunEvidence } from "../harness/tally-signals.js";
import {
  GRADED_FIGURE_SENTINEL,
  SCREEN_SETTLED_SENTINEL,
} from "../harness/verdict.js";
import {
  CHECK_OUTPUT_TAIL_CHARS,
  checkOutputTail,
  classifyCheckRun,
  redactUrlCredentials,
  runCheckCommand,
} from "./verify-checks.js";

const NONCE = "0123456789abcdef0123456789abcdef";

/**
 * The host's evidence line for one run, appended to whatever the runner (and
 * the check) happened to print. Every fixture below is built through this,
 * because that line is now the ONLY thing this classifier reads — see
 * `lib/harness/tally-signals.ts` for why the regexes it replaced could be
 * satisfied by the check file itself.
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
     * How many screens the run graded — issue #925. A real BROWSER run always
     * shows one of two things: a grade mark, or a screen-check sentinel saying
     * the helper ran and refused. `classifyCheckRun` now demands one of the
     * pair, so a fixture carrying neither asserts the broken case.
     */
    graded?: number;
    /**
     * Settled records for the host's `SC-SETTLED` line (2026-09-01) — each
     * entry is one record's screen. Empty by default: a run whose helper
     * never settled a page prints `settled=0`.
     */
    settledScreens?: readonly string[];
    /** Force the settled COUNT apart from the readable records (truncation). */
    settledCount?: number;
  },
): string {
  const settledScreens = ev.settledScreens ?? [];
  const settledDetail =
    settledScreens.length > 0
      ? Buffer.from(
          settledScreens
            .map((screen) =>
              JSON.stringify({
                screen,
                url: `http://localhost:3000${screen}`,
                settled: true,
              }),
            )
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
    })}\n${formatGradeMarkLine(NONCE, ev.graded ?? 0, "")}\n${formatSettledMarkLine(
      NONCE,
      ev.settledCount ?? settledScreens.length,
      settledDetail,
    )}\n`
  );
}

// A green browser run that GRADED — the mark is what makes it trustworthy.
const PASS_OUTPUT = withEvidence(
  "Running 1 test using 1 worker\n\n  1 passed (1.2s)\n",
  { exitCode: 0, passed: 1, graded: 1 },
);
// A red browser run that graded and REFUSED. It leaves no success mark by
// design — the sentinel is its proof the helper was reached.
const FAIL_OUTPUT = withEvidence(
  "Running 1 test using 1 worker\n\n  1) checks/issue-911/x.spec.ts:5 › fails\n" +
    `\n  ${GRADED_FIGURE_SENTINEL} graded figure mismatch\n\n  1 failed\n`,
  { exitCode: 1, failed: 1 },
);
/**
 * A browser run that came back RED without ever reaching the screen — a bad
 * import, a missing route, a syntax error. Issue #925's build step 3: this
 * mints a must-fail-first receipt on a check that cannot detect a wrong figure
 * at all, and a whole builder round is spent before anything notices.
 */
const NEVER_REACHED_SCREEN = withEvidence(
  "Running 1 test using 1 worker\n\n  Error: Cannot find module '../lib/x'\n\n  1 failed\n",
  { exitCode: 1, failed: 1 },
);

/**
 * Issues #1160/#1161 (2026-08-31): the page SETTLED — `waitForGradableScreen`
 * left its nonce-keyed settled record — and then a plain `expect()` went red
 * BEFORE `gradeScreenText` was ever reached. No grade mark (written only after
 * the assertion passes) and no refusal sentinel (the helper did not refuse):
 * exactly the genuinely-red proof the old two-arm gate refused as
 * "inconclusive" and quarantined. Carries the printed sentinel too, as a real
 * run does — but the verdict rests on the record (2026-09-01).
 */
const SETTLED_THEN_PLAIN_RED = withEvidence(
  "Running 1 test using 1 worker\n\n" +
    `${SCREEN_SETTLED_SENTINEL} screen=/finance/reports?view=team\n` +
    "  1) checks/issue-1160/x.spec.ts:12 › fails\n" +
    "  Error: expect(received).toBe(expected)\n\n  1 failed\n",
  {
    exitCode: 1,
    failed: 1,
    settledScreens: ["/finance/reports?view=team"],
  },
);
/**
 * THE SPOOF (2026-09-01 review, finding A): the check PRINTED the literal
 * settled sentinel itself — one `console.log`, no page ever opened — and the
 * host's settled line honestly reports zero records. The old `includes()`
 * arm accepted this red; it must stay inconclusive.
 */
const FORGED_SETTLED_RED = withEvidence(
  "Running 1 test using 1 worker\n\n" +
    `${SCREEN_SETTLED_SENTINEL} screen=/finance/reports?view=team\n` +
    "  1) checks/issue-1160/x.spec.ts:12 › fails\n\n  1 failed\n",
  { exitCode: 1, failed: 1 },
);
// The mirror hazard: a GREEN run carrying real settled evidence but no grade
// mark — a `gradeScreenText` call the run never reached. Must stay
// inconclusive.
const SETTLED_GREEN_NO_MARK = withEvidence(
  "Running 1 test using 1 worker\n\n" +
    `${SCREEN_SETTLED_SENTINEL} screen=/finance/reports?view=team\n` +
    "\n  1 passed (1.2s)\n",
  {
    exitCode: 0,
    passed: 1,
    settledScreens: ["/finance/reports?view=team"],
  },
);

const obs = (output: string, exitCode: number | null, over = {}) => ({
  exitCode,
  timedOut: false,
  spawnFailed: false,
  output,
  nonce: NONCE,
  ...over,
});

describe("classifyCheckRun — pure classifier", () => {
  it("PROVES THE INSTRUMENT: a run that actually failed, on real Playwright-shaped output, classifies as observed=red", () => {
    const v = classifyCheckRun("browser", obs(FAIL_OUTPUT, 1), "red");
    expect(v.status).toBe("pass"); // expected red, observed red -> instrument confirms
    expect(v.reason).toContain("observed red");
  });

  // Issue #925, build step 3 — the gate that stops a red receipt being minted
  // by a check that never looked at the screen.
  it("REFUSES a browser run that never reached the screen, whichever colour", () => {
    const red = classifyCheckRun("browser", obs(NEVER_REACHED_SCREEN, 1), "red");
    expect(red.status).toBe("inconclusive");
    expect(red.reason).toContain("no grade mark and no");
  });

  it("a MARK alone satisfies the gate — the green re-check has no sentinel", () => {
    // Both arms are needed. Demanding a sentinel on a green run is impossible
    // by construction, exactly as demanding a success mark on a red one is.
    const v = classifyCheckRun("browser", obs(PASS_OUTPUT, 0), "green");
    expect(v.status).toBe("pass");
  });

  it("a SENTINEL alone satisfies the gate — the red proof leaves no mark", () => {
    // `writeGradeMark` runs only after the assertion passes, so a check that
    // graded and refused has a sentinel and no mark. That is healthy work.
    const v = classifyCheckRun("browser", obs(FAIL_OUTPUT, 1), "red");
    expect(v.status).toBe("pass");
  });

  // Issues #1160/#1161 — the third arm of the gate.
  it("ACCEPTS a red that settled but failed a plain expect() before gradeScreenText — the nonce-keyed record proves the screen was reached", () => {
    const v = classifyCheckRun("browser", obs(SETTLED_THEN_PLAIN_RED, 1), "red");
    expect(v.status).toBe("pass");
    expect(v.reason).toContain("observed red");
  });

  // 2026-09-01 review, finding A: the spoof channel.
  it("STAYS INCONCLUSIVE on a red whose output contains the literal settled sentinel but no nonce-keyed record", () => {
    const v = classifyCheckRun("browser", obs(FORGED_SETTLED_RED, 1), "red");
    expect(v.status).toBe("inconclusive");
    expect(v.screenUnreached).toBe(true);
  });

  it("REFUSES settled evidence that names a DIFFERENT screen than the envelope declared", () => {
    const v = classifyCheckRun(
      "browser",
      obs(SETTLED_THEN_PLAIN_RED, 1, { declaredScreen: "/deals" }),
      "red",
    );
    expect(v.status).toBe("inconclusive");
    expect(v.screenUnreached).toBe(true);
  });

  it("ACCEPTS settled evidence whose record matches the declared screen (route inside full URL included)", () => {
    const exact = classifyCheckRun(
      "browser",
      obs(SETTLED_THEN_PLAIN_RED, 1, {
        declaredScreen: "/finance/reports?view=team",
      }),
      "red",
    );
    expect(exact.status).toBe("pass");
    // The record also carries the real page.url(); a declared screen that is
    // the fuller spelling of a recorded route still matches.
    const viaUrl = classifyCheckRun(
      "browser",
      obs(SETTLED_THEN_PLAIN_RED, 1, {
        declaredScreen: "http://localhost:3000/finance/reports?view=team",
      }),
      "red",
    );
    expect(viaUrl.status).toBe("pass");
  });

  it("a settled COUNT with no readable record fails a declared-screen comparison — unconfirmed is never a match", () => {
    const truncated = withEvidence(
      "Running 1 test using 1 worker\n\n  1 failed\n",
      { exitCode: 1, failed: 1, settledCount: 1 },
    );
    const v = classifyCheckRun(
      "browser",
      obs(truncated, 1, { declaredScreen: "/finance/reports?view=team" }),
      "red",
    );
    expect(v.status).toBe("inconclusive");
  });

  it("a red with NEITHER a settled record nor a mark nor a sentinel is still inconclusive — and flagged screenUnreached", () => {
    const v = classifyCheckRun("browser", obs(NEVER_REACHED_SCREEN, 1), "red");
    expect(v.status).toBe("inconclusive");
    expect(v.reason).toContain("no nonce-keyed settled record");
    expect(v.screenUnreached).toBe(true);
  });

  it("an environment-shaped inconclusive (timeout) is NOT flagged screenUnreached", () => {
    const v = classifyCheckRun(
      "browser",
      { ...obs(NEVER_REACHED_SCREEN, null), timedOut: true },
      "red",
    );
    expect(v.status).toBe("inconclusive");
    expect(v.screenUnreached).toBeUndefined();
  });

  it("a GREEN with real settled evidence but no grade mark stays inconclusive — the settled arm must not weaken the green gate (#925)", () => {
    const v = classifyCheckRun("browser", obs(SETTLED_GREEN_NO_MARK, 0), "green");
    expect(v.status).toBe("inconclusive");
  });

  it("the settled-then-red run still reads as a real red at ship-time — a fail against green, never inconclusive", () => {
    const v = classifyCheckRun("browser", obs(SETTLED_THEN_PLAIN_RED, 1), "green");
    expect(v.status).toBe("fail");
  });

  it("a UNIT check is never asked for either — it has no screen", () => {
    const v = classifyCheckRun("unit", obs(NEVER_REACHED_SCREEN, 1), "red");
    expect(v.status).toBe("pass");
  });

  it("a run that actually passed, on real Playwright-shaped output, classifies as observed=green", () => {
    const v = classifyCheckRun("browser", obs(PASS_OUTPUT, 0), "green");
    expect(v.status).toBe("pass");
    expect(v.reason).toContain("observed green");
  });

  it("must-fail-first case: a check that came back GREEN when RED was required is a mismatch (fail), not a pass", () => {
    const v = classifyCheckRun("browser", obs(PASS_OUTPUT, 0), "red");
    expect(v.status).toBe("fail");
    expect(v.reason).toContain("mismatch");
  });

  it("ship-time case: a check still RED when GREEN was required is a mismatch (fail)", () => {
    const v = classifyCheckRun("browser", obs(FAIL_OUTPUT, 1), "green");
    expect(v.status).toBe("fail");
  });

  it("a zero exit with NO attributable evidence is inconclusive, never a trusted pass (the manufactured-exit-0 hazard)", () => {
    const v = classifyCheckRun("browser", obs("", 0), "green");
    expect(v.status).toBe("inconclusive");
  });

  it("spawnFailed is inconclusive", () => {
    const v = classifyCheckRun("browser", obs("", null, { spawnFailed: true }), "red");
    expect(v.status).toBe("inconclusive");
  });

  it("timedOut is inconclusive", () => {
    const v = classifyCheckRun(
      "browser",
      obs(PASS_OUTPUT, 124, { timedOut: true }),
      "red",
    );
    expect(v.status).toBe("inconclusive");
  });

  it("an evidence line signed with another run's nonce proves nothing here either", () => {
    const v = classifyCheckRun(
      "browser",
      { ...obs(PASS_OUTPUT, 0), nonce: "ffffffffffffffffffffffffffffffff" },
      "green",
    );
    expect(v.status).toBe("inconclusive");
  });
});

// ---------------------------------------------------------------------------
// THE FORGERY (2026-08-06). This is the MUST-FAIL-FIRST classifier: a `pass`
// here MINTS a byte-locked receipt. Until this fix, a check file that printed
// `Tests  1 failed (1)` and then skipped its only test minted one, having
// graded nothing whatsoever.
// ---------------------------------------------------------------------------

/** Verbatim bytes of that real vitest run, minus the host's evidence line. */
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
      Tests  no tests
   Start at  00:16:31
   Duration  509ms (transform 93ms, setup 0ms, collect 318ms, tests 0ms)
`;

describe("a check cannot mint a receipt by printing its own red", () => {
  it("THE ONE THAT MATTERS: forged `Tests  1 failed (1)` beside a report that graded NOTHING is inconclusive", () => {
    const v = classifyCheckRun(
      "unit",
      obs(withEvidence(FORGED_RUNNER_OUTPUT, { exitCode: 1 }), 1),
      "red",
    );
    expect(v.status).toBe("inconclusive");
  });

  it("the same forgery with NO host evidence line at all is inconclusive too", () => {
    const v = classifyCheckRun("unit", obs(FORGED_RUNNER_OUTPUT, 1), "red");
    expect(v.status).toBe("inconclusive");
  });

  it("the browser twin: a Playwright check printing `1 failed` while skipping its only test", () => {
    const v = classifyCheckRun(
      "browser",
      obs(
        withEvidence("\n  1 failed (1.2s)\n  1 skipped\n", {
          exitCode: 1,
          skipped: 1,
        }),
        1,
      ),
      "red",
    );
    expect(v.status).toBe("inconclusive");
  });

  it("a forged evidence line printed DURING the run loses to the host's, which is always last", () => {
    const forged = formatRunEvidence(NONCE, {
      reportPresent: true,
      exitCode: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      flaky: 0,
    });
    const v = classifyCheckRun(
      "unit",
      obs(withEvidence(`${forged}\n${FORGED_RUNNER_OUTPUT}`, { exitCode: 1 }), 1),
      "red",
    );
    expect(v.status).toBe("inconclusive");
  });
});

describe("runCheckCommand — the impure half", () => {
  it("is inconclusive with no exec available", async () => {
    const v = await runCheckCommand("browser", undefined, "echo hi", "red", NONCE);
    expect(v.status).toBe("inconclusive");
    expect(v.reason).toContain("does not expose command execution");
  });

  it("classifies a real exec result", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: FAIL_OUTPUT,
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const v = await runCheckCommand(
      "browser",
      exec,
      "pnpm --filter @acme/nextjs e2e -- x",
      "red",
      NONCE,
    );
    expect(v.status).toBe("pass");
    expect(exec).toHaveBeenCalledWith("pnpm --filter @acme/nextjs e2e -- x", {
      // The SHARED harness budget, not a second number of this module's own.
      // Was `120_000` — exactly Playwright's cold-boot budget alone, leaving
      // the check zero time to run and manufacturing an `inconclusive`
      // must-fail-first proof on a slow night (2026-08-04 review, F2). The
      // number itself is pinned against `playwright.config.ts`'s real
      // cold-boot + per-test worst case in
      // `lib/harness/timeout-budget-contract.test.ts`; asserting it again by
      // hand here would just be a second place for it to drift.
      timeoutMs: CHECK_TIMEOUT_BUDGET_MS.browser,
    });
  });

  it("a transport rejection from exec is inconclusive, never a false pass or fail", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("docker daemon wedged"));
    const v = await runCheckCommand("browser", exec, "pnpm test", "green", NONCE);
    expect(v.status).toBe("inconclusive");
    expect(v.reason).toContain("docker daemon wedged");
  });
});

// ---------------------------------------------------------------------------
// The evidence the verdict used to throw away (2026-08-05 production failure).
//
// The sandbox could not reach the test Postgres at all: every must-fail-first
// proof died in Playwright's globalSetup with a CONNECT_TIMEOUT to the docker
// bridge gateway, printed no tally line, and classified `inconclusive`. Issues
// #803 and #813 were quarantined after ~19 minutes each and the run log held
// no explanation, because `runCheckCommand` returned only status + reason and
// dropped the output that names the address.
// ---------------------------------------------------------------------------

/** The real shape of that night's failure, password and all. */
const CONNECT_TIMEOUT_OUTPUT =
  "Running 1 test using 1 worker\n" +
  "Error: connect to postgres://postgres:hunter2@172.17.0.1:55432/postgres\n" +
  "  write CONNECT_TIMEOUT 172.17.0.1:55432\n" +
  "    at globalSetup (apps/nextjs/e2e/global-setup.ts:14:11)\n";

describe("redactUrlCredentials", () => {
  it("strips the userinfo but KEEPS host:port — the address is the whole diagnostic", () => {
    const out = redactUrlCredentials(CONNECT_TIMEOUT_OUTPUT);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("postgres:hunter2@");
    expect(out).toContain("postgres://***@172.17.0.1:55432/postgres");
    expect(out).toContain("write CONNECT_TIMEOUT 172.17.0.1:55432");
  });

  it("PROVES THE INSTRUMENT: text with no URL in it comes back byte-for-byte", () => {
    expect(redactUrlCredentials(PASS_OUTPUT)).toBe(PASS_OUTPUT);
    expect(redactUrlCredentials(FAIL_OUTPUT)).toBe(FAIL_OUTPUT);
  });

  it("redacts a credential-less URL's host untouched, and every URL on the line", () => {
    // No userinfo → nothing to strip. Two URLs → both handled, and the
    // userinfo match cannot run past the authority into the next word.
    expect(redactUrlCredentials("see http://localhost:3000/x and it failed")).toBe(
      "see http://localhost:3000/x and it failed",
    );
    expect(
      redactUrlCredentials("a postgres://u:p@h:1/db b redis://x:y@r:2"),
    ).toBe("a postgres://***@h:1/db b redis://***@r:2");
  });
});

describe("checkOutputTail", () => {
  it("keeps the END, not the head — Playwright prints the failure last, and the host's evidence line last of all", () => {
    const text = `${"boot noise\n".repeat(50)}THE FAILURE`;
    const tail = checkOutputTail(text, 20);
    expect(tail).toContain("THE FAILURE");
    expect(tail).toContain("earlier characters omitted");
  });

  it("is bounded — a runaway log cannot be written to the run log whole", () => {
    const huge = "x".repeat(CHECK_OUTPUT_TAIL_CHARS * 3);
    const tail = checkOutputTail(huge);
    // The marker adds a few characters; what matters is it is bounded and far
    // below the input, not an exact length.
    expect(tail.length).toBeLessThan(CHECK_OUTPUT_TAIL_CHARS + 100);
  });

  it("passes short output through unchanged, with no misleading omission marker", () => {
    expect(checkOutputTail(PASS_OUTPUT)).toBe(PASS_OUTPUT);
  });

  it("redacts BEFORE bounding, so a credential cannot survive in the tail", () => {
    expect(checkOutputTail(CONNECT_TIMEOUT_OUTPUT)).not.toContain("hunter2");
  });
});

describe("runCheckCommand — the verdict carries its evidence", () => {
  it("REPRODUCES 2026-08-05: an inconclusive proof carries the tail that names the unreachable address", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: CONNECT_TIMEOUT_OUTPUT,
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const v = await runCheckCommand("browser", exec, "pnpm e2e -- x", "red", NONCE);
    // Nothing attributable to the runner → inconclusive, exactly as that night.
    expect(v.status).toBe("inconclusive");
    expect(v.reason).toContain("Playwright");
    // ...and the reason alone is un-actionable, which is why the tail exists.
    expect(v.outputTail).toBeDefined();
    expect(v.outputTail).toContain("write CONNECT_TIMEOUT 172.17.0.1:55432");
    expect(v.outputTail).not.toContain("hunter2");
  });

  it("carries the tail on a PASS too — evidence is not only for outcomes we anticipated", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: FAIL_OUTPUT,
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const v = await runCheckCommand("browser", exec, "pnpm e2e -- x", "red", NONCE);
    expect(v.status).toBe("pass");
    expect(v.outputTail).toContain("1 failed");
  });

  it("has no tail when there was no output to have — exec absent or rejected", async () => {
    expect(
      (await runCheckCommand("browser", undefined, "x", "red", NONCE)).outputTail,
    ).toBeUndefined();
    const exec = vi.fn().mockRejectedValue(new Error("docker daemon wedged"));
    expect(
      (await runCheckCommand("browser", exec, "x", "red", NONCE)).outputTail,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The vitest runner (issue #956). This is the MUST-FAIL-FIRST classifier, so
// the assertion that matters most in this whole file is the one below saying a
// collection failure is NOT red: without it, a check-writer that emits a file
// with a deliberate syntax error mints a receipt having proven nothing.
//
// Every counter combination below is one this repo's own vitest 3.2.4 really
// reported, captured from real runs of real check files.
// ---------------------------------------------------------------------------

describe("classifyCheckRun — kind: unit (vitest)", () => {
  const unit = (ev: Parameters<typeof withEvidence>[1], runnerOutput = "") =>
    obs(withEvidence(runnerOutput, ev), ev.exitCode);

  it("PROVES THE INSTRUMENT: a real assertion failure classifies as observed=red", () => {
    const v = classifyCheckRun("unit", unit({ exitCode: 1, failed: 1 }), "red");
    expect(v.status).toBe("pass");
    expect(v.reason).toContain("observed red");
  });

  it("counts a mixed run as red — one passing sibling does not hide the failure", () => {
    const v = classifyCheckRun(
      "unit",
      unit({ exitCode: 1, failed: 1, passed: 1 }),
      "red",
    );
    expect(v.status).toBe("pass");
  });

  it("THE ONE THAT MATTERS: a collection failure is INCONCLUSIVE, never red — a broken file must not mint a receipt", () => {
    // A top-level throw, an import of a module that does not exist, and a
    // `describe` holding no `it()` all exit 1 with every counter at zero. The
    // exit code says 1; nothing was ever graded. Read as red, a check-writer
    // could satisfy the must-fail-first rule with a deliberate syntax error
    // and prove precisely nothing.
    const v = classifyCheckRun(
      "unit",
      unit({ exitCode: 1 }, "Error: Cannot find module './nope.js'"),
      "red",
    );
    expect(v.status).toBe("inconclusive");
  });

  it("a collection failure is not a `fail` against green either — it is evidence of nothing in both directions", () => {
    const v = classifyCheckRun("unit", unit({ exitCode: 1 }), "green");
    expect(v.status).toBe("inconclusive");
  });

  it("observed green requires a report recording a passed test beside a zero exit", () => {
    const v = classifyCheckRun("unit", unit({ exitCode: 0, passed: 1 }), "green");
    expect(v.status).toBe("pass");
    expect(v.reason).toContain("observed green");
  });

  it("an all-skipped run is INCONCLUSIVE, never green — exit 0 with zero assertions run", () => {
    // `it.skip` everywhere exits ZERO with a perfectly real report. A
    // ship-time re-check that read this as green would confirm a check that
    // graded nothing at all.
    const v = classifyCheckRun("unit", unit({ exitCode: 0, skipped: 1 }), "green");
    expect(v.status).toBe("inconclusive");
  });

  it("must-fail-first case: a unit check that came back GREEN when RED was required is a mismatch (fail)", () => {
    const v = classifyCheckRun("unit", unit({ exitCode: 0, passed: 1 }), "red");
    expect(v.status).toBe("fail");
    expect(v.reason).toContain("mismatch");
  });

  it("ship-time case: a unit check still RED when GREEN was required is a mismatch (fail)", () => {
    const v = classifyCheckRun("unit", unit({ exitCode: 1, failed: 1 }), "green");
    expect(v.status).toBe("fail");
  });

  it("is inconclusive when the filter matched no file — a check that would 'pass by being absent'", () => {
    // What a unit check written OUTSIDE its package's vitest `include` glob
    // prints. vitest writes no report at all.
    const v = classifyCheckRun(
      "unit",
      unit(
        { exitCode: 1, reportPresent: false },
        "No test files found, exiting with code 1",
      ),
      "red",
    );
    expect(v.status).toBe("inconclusive");
  });

  it("names vitest, not Playwright, when it cannot prove the run happened", () => {
    const v = classifyCheckRun("unit", obs("", 0), "green");
    expect(v.status).toBe("inconclusive");
    expect(v.reason).toContain("vitest");
  });

  it("spawnFailed and timedOut are inconclusive, exactly as for the browser kind", () => {
    expect(
      classifyCheckRun("unit", obs("", null, { spawnFailed: true }), "red").status,
    ).toBe("inconclusive");
    expect(
      classifyCheckRun(
        "unit",
        { ...unit({ exitCode: 1, failed: 1 }), exitCode: 124, timedOut: true },
        "red",
      ).status,
    ).toBe("inconclusive");
  });

  it("PROVES WHY stripAnsi IS MANDATORY: a colorized stream still grades, because the escapes are stripped first", () => {
    // Both runners colorize even under `CI`/`NO_COLOR`, and the escapes land
    // at the START of the line — exactly where the evidence line's `^` anchor
    // is. See `stripAnsi`'s own doc comment for the time this defect silently
    // killed `SUITE_COMPLETED_SIGNALS` outright.
    const evidence = formatRunEvidence(NONCE, {
      reportPresent: true,
      exitCode: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      flaky: 0,
    });
    const colorized = `[2m${evidence}[22m\n`;
    expect(classifyCheckRun("unit", obs(colorized, 1), "red").status).toBe("pass");
  });
});

describe("runCheckCommand — kind: unit", () => {
  it("spends the UNIT budget, never the browser one", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: withEvidence("", { exitCode: 1, failed: 1 }),
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const v = await runCheckCommand(
      "unit",
      exec,
      "pnpm --filter @acme/api run test src/x.test.ts",
      "red",
      NONCE,
    );
    expect(v.status).toBe("pass");
    expect(exec).toHaveBeenCalledWith(
      "pnpm --filter @acme/api run test src/x.test.ts",
      { timeoutMs: CHECK_TIMEOUT_BUDGET_MS.unit },
    );
    // Handing a vitest run Playwright's seven-minute budget is the accident
    // the per-kind record exists to prevent.
    expect(CHECK_TIMEOUT_BUDGET_MS.unit).toBeLessThan(
      CHECK_TIMEOUT_BUDGET_MS.browser,
    );
  });

  it("carries the output tail on a unit verdict too, redacted the same way", async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: withEvidence(
        "Error: connect to postgres://postgres:hunter2@172.17.0.1:55432/postgres",
        { exitCode: 1, failed: 1 },
      ),
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const v = await runCheckCommand("unit", exec, "pnpm test", "red", NONCE);
    expect(v.outputTail).toContain("172.17.0.1:55432");
    expect(v.outputTail).not.toContain("hunter2");
  });
});
