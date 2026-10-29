/**
 * Tests for the in-sandbox test-verification gate's pure classifier and
 * bounded runner (`./test-verification.ts`). Co-located per this package's
 * convention — see `../paths/glob.test.ts`, `../cost/ledger.test.ts`,
 * `../telemetry/run-identity.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type {
  SandboxCommandRunner,
  SandboxExecResult,
} from "../sandbox-exec.js";
import {
  aggregateTestRuns,
  buildPackageTestCommand,
  classifyTestRun,
  INCONCLUSIVE_SIGNALS,
  runPackageTests,
  runScopedTests,
  SAFE_PACKAGE_NAME,
  stripAnsi,
  SUITE_COMPLETED_SIGNALS,
  TEST_VERIFY_MAX_OUTPUT_BYTES,
  TEST_VERIFY_PACKAGE_TIMEOUT_MS,
} from "./test-verification.js";

// ---------------------------------------------------------------------------
// classifyTestRun — the pure classifier at the heart of the host-side
// test-VERIFICATION gate (`.sandcastle/lib/testing/test-verification.ts`).
// THE crux of this module is precedence: an INCONCLUSIVE_SIGNALS match in the
// captured output must win over the exit code, in BOTH directions (a matching
// signal with exit 1 stays inconclusive; a matching signal with exit 0 ALSO
// stays inconclusive) — because "a test that could not run" and "a test that
// ran and told us it passed/failed" are different claims, and the gate's only
// dangerous failure direction is treating an unverifiable host as a failed
// suite and quarantining a good ticket for it.
// ---------------------------------------------------------------------------

describe("classifyTestRun", () => {
  const obs = (
    over: Partial<Parameters<typeof classifyTestRun>[0]> = {},
  ): Parameters<typeof classifyTestRun>[0] => ({
    packageName: "@acme/example",
    spawnFailed: false,
    timedOut: false,
    exitCode: 0,
    output: "",
    ...over,
  });

  it("spawnFailed -> inconclusive, even with a non-zero exit code", () => {
    expect(
      classifyTestRun(obs({ spawnFailed: true, exitCode: 1 })).status,
    ).toBe("inconclusive");
  });

  it("timedOut -> inconclusive, even with a non-zero exit code", () => {
    expect(
      classifyTestRun(obs({ timedOut: true, exitCode: 1 })).status,
    ).toBe("inconclusive");
  });

  // THE crux: an INCONCLUSIVE_SIGNALS match wins over the exit code even
  // though the real-world case (a Linux-built node_modules checked out on a
  // Mac) always carries a non-zero exit alongside the module-resolution
  // error. Asserted with the EXACT captured string verified this session, per
  // the module's own doc comment. No suite-tally line here, so the
  // SUITE_COMPLETED_SIGNALS guard does not engage.
  it("an INCONCLUSIVE_SIGNALS match overrides a non-zero exit code", () => {
    const verdict = classifyTestRun(
      obs({
        exitCode: 1,
        output: "Error: Cannot find module @rollup/rollup-darwin-arm64",
      }),
    );
    expect(verdict.status).toBe("inconclusive");
  });

  // The direction that matters most for "don't quarantine on ambiguity": the
  // signal wins even when the exit code LOOKS clean. A pass-looking exit code
  // must not paper over evidence the suite never actually ran (e.g. pnpm
  // printed "No test files found" and still exited 0). Intended direction:
  // resolving toward inconclusive can only ever cost a false-quarantine
  // AVOIDANCE, never cause one — the opposite of resolving toward pass, which
  // could let a broken-toolchain run masquerade as a genuine green suite.
  it("an INCONCLUSIVE_SIGNALS match overrides exit 0 too", () => {
    const verdict = classifyTestRun(
      obs({ exitCode: 0, output: "No test files found" }),
    );
    expect(verdict.status).toBe("inconclusive");
  });

  it("exit 0 WITH a suite tally -> pass", () => {
    expect(
      classifyTestRun(obs({ exitCode: 0, output: " Tests  11 passed (11)" }))
        .status,
    ).toBe("pass");
  });

  // The false-green this closed. The SDK's docker provider resolves
  // `exitCode: code ?? 0`, so a `docker exec` client killed by a signal —
  // daemon restart, container removed mid-run — arrives as exit 0 with empty
  // output. Reading that as PASS is the gate fabricating the very confidence
  // it exists to check.
  it("exit 0 with NO tally -> inconclusive, never a manufactured pass", () => {
    const verdict = classifyTestRun(obs({ exitCode: 0, output: "" }));
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reason).toContain("never printed a result tally");
  });

  // The asymmetry is deliberate, so it gets its own assertion: coercion can
  // only ever fabricate a ZERO, so a non-zero code is evidence no accident
  // produces and needs no tally to be believed.
  it("non-zero exit needs NO tally -> still fail", () => {
    expect(classifyTestRun(obs({ exitCode: 1, output: "" })).status).toBe(
      "fail",
    );
  });

  it("exit null (killed by signal, not our timeout) -> inconclusive", () => {
    expect(classifyTestRun(obs({ exitCode: null })).status).toBe(
      "inconclusive",
    );
  });

  it("non-zero exit with clean output -> fail (the suite ran and told us)", () => {
    expect(
      classifyTestRun(obs({ exitCode: 1, output: "1 test failed" })).status,
    ).toBe("fail");
  });

  // ---------------------------------------------------------------------
  // SUITE_COMPLETED_SIGNALS guard — the bug this fixed: several
  // INCONCLUSIVE_SIGNALS patterns (ECONNREFUSED, ENOENT, Cannot find module)
  // are ordinary substrings a test's OWN failing-assertion output can print.
  // Without the guard, a suite that genuinely ran and failed could excuse
  // itself as "could not run" just because its diff output happened to
  // contain one of those words. The guard says: once the output contains a
  // vitest tally line, the suite demonstrably ran to completion, so any
  // INCONCLUSIVE_SIGNALS match in that output is a red herring from the
  // test's own printed output, not evidence about the host.
  // ---------------------------------------------------------------------

  it("a suite tally line present -> a signal-like string in a FAILING test's own output still classifies fail, not inconclusive", () => {
    const output = [
      "FAIL src/client.test.ts",
      "  ✗ retries the request and surfaces the error",
      "    Expected error message to equal 'ECONNREFUSED'",
      "    Received: 'ECONNREFUSED'",
      "",
      " Test Files  1 failed (1)",
      "      Tests  1 failed (1)",
    ].join("\n");
    const verdict = classifyTestRun(obs({ exitCode: 1, output }));
    expect(verdict.status).toBe("fail");
  });

  it("the same runnability string with NO tally line still classifies inconclusive (guard does not fire without proof the suite ran)", () => {
    const output = [
      "FAIL src/client.test.ts",
      "    Expected error message to equal 'ECONNREFUSED'",
      "    Received: 'ECONNREFUSED'",
      // No "Test Files"/"Tests" tally line — the run never reached the end.
    ].join("\n");
    const verdict = classifyTestRun(obs({ exitCode: 1, output }));
    expect(verdict.status).toBe("inconclusive");
  });

  // ---------------------------------------------------------------------
  // TABLE-DRIVEN drift protection. Replaces a prior vacuous version of this
  // test that only asserted `INCONCLUSIVE_SIGNALS.length > 0` — a regex
  // typo'd to `/Cannnot find module/` would still have passed that. Every
  // pattern gets one realistic evidence string, asserted individually, plus a
  // length check so a pattern added to the export without a matching table
  // row fails this suite instead of silently going untested.
  // ---------------------------------------------------------------------

  const INCONCLUSIVE_EVIDENCE: readonly string[] = [
    "Error: Cannot find module '@rollup/rollup-darwin-arm64'",
    "node:internal/modules/cjs/loader:1080\n  throw err;\n  ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find module",
    "Error: Cannot find module '/repo/packages/ui/dist/index.js'\nRequire stack:\n- /repo/main.js\ncode: 'MODULE_NOT_FOUND'",
    "Error: Cannot find package 'vitest' imported from /repo/packages/ui/index.js",
    "ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @acme/ui@9.9.9",
    "ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT  Command \"test\" not found",
    "No projects matched the filters in \"/repo\"",
    'Command "test" not found',
    // dash's phrasing, which the container's /bin/sh actually uses. VERIFIED
    // in a live container: `sh: 1: timeout: not found` — no "command" prefix.
    // The old narrower /command not found/ pattern missed exactly this, so a
    // missing `timeout` binary exited 127 with no matching signal and
    // classified as FAIL — a toolchain gap false-quarantining a healthy
    // ticket, which is the one outcome this module forbids.
    "sh: 1: timeout: not found",
    "spawn pnpm ENOENT",
    "'pnpm' is not recognized as an internal or external command,\noperable program or batch file.",
    "connect ECONNREFUSED 127.0.0.1:5432",
    "Error: could not connect to server: Connection refused",
    "Error: Connection terminated unexpectedly",
    "error: password authentication failed for user \"postgres\"",
    "error: database \"acme_test\" does not exist",
    "Error: Executable doesn't exist at /root/.cache/ms-playwright/chromium/chrome",
    "browserType.launch: Please run the following command to download new browsers:\n  npx playwright install",
    "Error: Failed to launch the browser process!",
    "No test files found, exiting with code 1",
  ] as const;

  // Bash phrases it `command not found`; dash phrases it `not found`. The
  // table above pins the dash form because that is what the container's
  // /bin/sh actually emits; this pins the bash form too, so narrowing the
  // pattern back to /command not found/ fails here rather than in production.
  it("both shells' missing-binary phrasings classify inconclusive", () => {
    for (const evidence of [
      "sh: 1: timeout: not found",
      "/bin/sh: pnpm: command not found",
      "bash: line 1: pnpm: command not found",
    ]) {
      expect(
        classifyTestRun(obs({ exitCode: 127, output: evidence })).status,
        evidence,
      ).toBe("inconclusive");
    }
  });

  it("every documented INCONCLUSIVE_SIGNALS pattern actually matches its evidence string", () => {
    expect(INCONCLUSIVE_EVIDENCE.length).toBe(INCONCLUSIVE_SIGNALS.length);
    INCONCLUSIVE_EVIDENCE.forEach((evidence, i) => {
      const pattern = INCONCLUSIVE_SIGNALS[i];
      expect(
        pattern.test(evidence),
        `pattern ${pattern.source} did not match its evidence string: ${evidence}`,
      ).toBe(true);
      expect(
        classifyTestRun(obs({ exitCode: 1, output: evidence })).status,
        `evidence for ${pattern.source} did not classify inconclusive`,
      ).toBe("inconclusive");
    });
  });
});

// ---------------------------------------------------------------------------
// SUITE_COMPLETED_SIGNALS — sanity-checks the tally patterns themselves,
// independent of the classifier that consumes them.
// ---------------------------------------------------------------------------

describe("SUITE_COMPLETED_SIGNALS", () => {
  it("matches vitest's real tally line shapes", () => {
    expect(
      SUITE_COMPLETED_SIGNALS.some((re) =>
        re.test(" Test Files  3 passed (3)"),
      ),
    ).toBe(true);
    expect(
      SUITE_COMPLETED_SIGNALS.some((re) => re.test("      Tests  12 passed (12)")),
    ).toBe(true);
  });

  it("does not match ordinary output with neither tally line", () => {
    expect(
      SUITE_COMPLETED_SIGNALS.some((re) => re.test("Running tests...")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// aggregateTestRuns — folds one issue's per-package verdicts into the single
// verdict the ship gate acts on. Precedence is fail > inconclusive > pass, and
// an EMPTY list is inconclusive, never a vacuous pass — "nothing ran" is not
// evidence of "nothing is wrong".
// ---------------------------------------------------------------------------

describe("aggregateTestRuns", () => {
  const verdict = (
    packageName: string,
    status: "pass" | "fail" | "inconclusive",
  ) => ({ packageName, status, reason: `${packageName}: ${status}` });

  it("fail wins over inconclusive and pass", () => {
    const result = aggregateTestRuns([
      verdict("@acme/a", "pass"),
      verdict("@acme/b", "inconclusive"),
      verdict("@acme/c", "fail"),
    ]);
    expect(result.status).toBe("fail");
  });

  it("inconclusive wins over pass", () => {
    const result = aggregateTestRuns([
      verdict("@acme/a", "pass"),
      verdict("@acme/b", "inconclusive"),
    ]);
    expect(result.status).toBe("inconclusive");
  });

  it("an empty list is inconclusive, NOT a vacuous pass", () => {
    expect(aggregateTestRuns([]).status).toBe("inconclusive");
  });

  it("all-pass -> pass", () => {
    const result = aggregateTestRuns([
      verdict("@acme/a", "pass"),
      verdict("@acme/b", "pass"),
    ]);
    expect(result.status).toBe("pass");
  });
});
// ---------------------------------------------------------------------------
// buildPackageTestCommand + SAFE_PACKAGE_NAME — the command string is now the
// module's ENTIRE contract with the outside world (the sandbox seam takes a
// shell string, not argv), so it is asserted verbatim rather than paraphrased.
// The name guard exists because that switch from argv to a shell string is
// exactly the change that turns a harmless package name into an injection
// vector.
// ---------------------------------------------------------------------------

describe("buildPackageTestCommand", () => {
  it("emits the exact shell string the sandbox will run", () => {
    expect(buildPackageTestCommand("@acme/example")).toBe(
      "env CI=1 NO_COLOR=1 FORCE_COLOR=0 pnpm --filter @acme/example run test",
    );
  });

  it("sets CI=1 — without it a bare `vitest` can enter watch mode and hang forever", () => {
    expect(buildPackageTestCommand("@acme/example")).toContain("CI=1");
  });

  // Verified against a live container: FORCE_COLOR=0 alone does NOT stop
  // vitest colourising its summary, and the escapes land inside the tally line
  // that SUITE_COMPLETED_SIGNALS matches on. NO_COLOR=1 does stop it.
  it("sets NO_COLOR=1 — FORCE_COLOR=0 alone leaves ANSI in the tally line", () => {
    expect(buildPackageTestCommand("@acme/example")).toContain("NO_COLOR=1");
  });
});

// ---------------------------------------------------------------------------
// stripAnsi — the belt to NO_COLOR's braces. Asserted against the REAL byte
// sequence vitest emits, captured from a live container. Un-stripped, that
// line matches NEITHER completion signal (escapes sit before `Test Files` AND
// between it and the digit), so the guard was dead and INCONCLUSIVE_SIGNALS
// was consulted on every single run — which is exactly the hole the guard
// exists to close.
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  const REAL_VITEST_TALLY =
    "\u001B[2m Test Files \u001B[22m \u001B[1m\u001B[32m11 passed\u001B[39m\u001B[22m\u001B[90m (11)\u001B[39m";

  it("the raw vitest tally line does NOT match the completion guard", () => {
    expect(
      SUITE_COMPLETED_SIGNALS.some((re) => re.test(REAL_VITEST_TALLY)),
    ).toBe(false);
  });

  it("the stripped tally line DOES match the completion guard", () => {
    const stripped = stripAnsi(REAL_VITEST_TALLY);
    expect(stripped).toBe(" Test Files  11 passed (11)");
    expect(SUITE_COMPLETED_SIGNALS.some((re) => re.test(stripped))).toBe(true);
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("Tests  3 failed | 1 passed")).toBe(
      "Tests  3 failed | 1 passed",
    );
  });
});

describe("SAFE_PACKAGE_NAME", () => {
  it("accepts the scoped and unscoped names this workspace actually uses", () => {
    for (const name of ["@acme/api", "@acme/db", "vitest-config", "app.web"]) {
      expect(SAFE_PACKAGE_NAME.test(name)).toBe(true);
    }
  });

  it("rejects every shape that could break out of the shell string", () => {
    for (const name of [
      "@acme/api; rm -rf /",
      "$(whoami)",
      "`id`",
      "a b",
      "a&&b",
      "a|b",
      "a>b",
      "a\nb",
      "",
    ]) {
      expect(SAFE_PACKAGE_NAME.test(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// runPackageTests / runScopedTests — against a fake SandboxCommandRunner.
// NEVER touches a real sandbox or spawns a real process.
//
// The seam this exercises is the whole point of the rework: the gate no longer
// spawns anything on the host, it hands a command string to the sandbox that
// already has the right dependencies installed. So the assertions are about
// what command goes in, what bound goes with it, and — the load-bearing part —
// that every way the sandbox can fail to give an answer reads as INCONCLUSIVE
// rather than as a failing suite.
// ---------------------------------------------------------------------------

function execOk(over: Partial<SandboxExecResult> = {}): SandboxExecResult {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...over };
}

describe("runPackageTests", () => {
  it("passes the built command and a per-package timeout to the sandbox", async () => {
    const seen: { command: string; opts?: { timeoutMs?: number } }[] = [];
    const exec: SandboxCommandRunner = async (command, opts) => {
      seen.push({ command, opts });
      return execOk();
    };

    await runPackageTests(exec, "@acme/example", { perPackageTimeoutMs: 1234 });

    expect(seen).toHaveLength(1);
    expect(seen[0].command).toBe(buildPackageTestCommand("@acme/example"));
    expect(seen[0].opts?.timeoutMs).toBe(1234);
  });

  it("defaults the bound to TEST_VERIFY_PACKAGE_TIMEOUT_MS — never unbounded", async () => {
    let seenTimeout: number | undefined;
    const exec: SandboxCommandRunner = async (_cmd, opts) => {
      seenTimeout = opts?.timeoutMs;
      return execOk();
    };

    await runPackageTests(exec, "@acme/example");

    expect(seenTimeout).toBe(TEST_VERIFY_PACKAGE_TIMEOUT_MS);
  });

  // The distinction this asserts is the one the whole gate rests on: a
  // transport fault is "we could not run the tests", not "the tests failed".
  // Without it a wedged docker daemon would quarantine every healthy ticket in
  // the queue, one after another, with nobody watching.
  it("a REJECTED exec is spawnFailed (inconclusive), never a failure", async () => {
    const exec: SandboxCommandRunner = async () => {
      throw new Error("docker daemon is not responding");
    };

    const obs = await runPackageTests(exec, "@acme/example");

    expect(obs.spawnFailed).toBe(true);
    expect(obs.exitCode).toBe(null);
    expect(obs.output).toContain("docker daemon is not responding");
    expect(classifyTestRun(obs).status).toBe("inconclusive");
  });

  it("an unsafe package name is refused without ever calling the sandbox", async () => {
    let called = false;
    const exec: SandboxCommandRunner = async () => {
      called = true;
      return execOk();
    };

    const obs = await runPackageTests(exec, "@acme/api; rm -rf /");

    expect(called).toBe(false);
    expect(obs.spawnFailed).toBe(true);
    expect(classifyTestRun(obs).status).toBe("inconclusive");
  });

  it("forwards a provider-reported timeout as timedOut (inconclusive)", async () => {
    const exec: SandboxCommandRunner = async () =>
      execOk({ exitCode: 124, timedOut: true });

    const obs = await runPackageTests(exec, "@acme/example");

    expect(obs.timedOut).toBe(true);
    expect(classifyTestRun(obs).status).toBe("inconclusive");
  });

  it("a non-zero exit is normal flow — reported, not thrown", async () => {
    const exec: SandboxCommandRunner = async () =>
      execOk({ exitCode: 1, stdout: " Test Files  1 failed (1)\n" });

    const obs = await runPackageTests(exec, "@acme/example");

    expect(obs.spawnFailed).toBe(false);
    expect(obs.exitCode).toBe(1);
    expect(classifyTestRun(obs).status).toBe("fail");
  });

  // End-to-end for the colour bug: a REAL coloured tally must reach the
  // classifier as a completed suite, so a stray runnability word elsewhere in
  // the output can no longer excuse a genuine failure.
  it("a colourised vitest tally still registers as a completed suite", async () => {
    const exec: SandboxCommandRunner = async () =>
      execOk({
        exitCode: 1,
        stdout:
          "Cannot find module 'x' (printed by a test's own assertion)\n" +
          "\u001B[2m Test Files \u001B[22m \u001B[1m\u001B[31m1 failed\u001B[39m\u001B[22m (1)\n",
      });

    const obs = await runPackageTests(exec, "@acme/example");

    // Without the strip this classifies inconclusive and the ticket ships.
    expect(classifyTestRun(obs).status).toBe("fail");
  });

  it("merges stdout and stderr into the classifier's input", async () => {
    const exec: SandboxCommandRunner = async () =>
      execOk({ stdout: "from-stdout", stderr: "from-stderr" });

    const obs = await runPackageTests(exec, "@acme/example");

    expect(obs.output).toContain("from-stdout");
    expect(obs.output).toContain("from-stderr");
  });

  it("truncates to the TAIL — a vitest failure summary prints last", async () => {
    const exec: SandboxCommandRunner = async () =>
      execOk({
        stdout: "X".repeat(TEST_VERIFY_MAX_OUTPUT_BYTES * 2) + "THE-SUMMARY",
      });

    const obs = await runPackageTests(exec, "@acme/example");

    expect(obs.output.length).toBeLessThanOrEqual(TEST_VERIFY_MAX_OUTPUT_BYTES);
    expect(obs.output).toContain("THE-SUMMARY");
  });
});

describe("runScopedTests", () => {
  it("a failing package short-circuits: the sandbox is never asked for later packages", async () => {
    const calls: string[] = [];
    const exec: SandboxCommandRunner = async (command) => {
      calls.push(command);
      return command.includes("@acme/broken")
        ? execOk({ exitCode: 1 })
        : execOk();
    };

    const { verdict, perPackage } = await runScopedTests(exec, [
      "@acme/first",
      "@acme/broken",
      "@acme/never-run",
    ]);

    expect(calls).toHaveLength(2);
    expect(calls.join(" ")).not.toContain("@acme/never-run");
    expect(verdict.status).toBe("fail");
    expect(perPackage.map((p) => p.packageName)).toEqual([
      "@acme/first",
      "@acme/broken",
    ]);
  });

  it("a mixed inconclusive+pass result folds to inconclusive", async () => {
    const exec: SandboxCommandRunner = async (command) => {
      if (command.includes("@acme/flaky")) throw new Error("container gone");
      return execOk();
    };

    const { verdict } = await runScopedTests(exec, [
      "@acme/good",
      "@acme/flaky",
    ]);

    expect(verdict.status).toBe("inconclusive");
  });

  // The overall ceiling has to bind the LAST package too. Without the shrink,
  // a package reached with 1s of budget left would still be handed the full
  // 8-minute per-package timeout, and a real test run would keep going inside
  // the container with nobody waiting on it.
  it("shrinks each package's bound to what is left of the overall ceiling", async () => {
    const seen: number[] = [];
    const exec: SandboxCommandRunner = async (_cmd, opts) => {
      seen.push(opts?.timeoutMs ?? Infinity);
      return execOk();
    };

    await runScopedTests(exec, ["@acme/a", "@acme/b"], {
      totalCeilingMs: 5_000,
      perPackageTimeoutMs: 60_000,
    });

    expect(seen).toHaveLength(2);
    for (const t of seen) expect(t).toBeLessThanOrEqual(5_000);
  });

  it("an already-exhausted ceiling reports inconclusive without running anything", async () => {
    let called = false;
    const exec: SandboxCommandRunner = async () => {
      called = true;
      return execOk();
    };

    const { verdict, perPackage } = await runScopedTests(exec, ["@acme/a"], {
      totalCeilingMs: 0,
    });

    expect(called).toBe(false);
    expect(verdict.status).toBe("inconclusive");
    expect(perPackage[0].reason).toContain("overall ceiling");
  });

  // The host-side race is the backstop for the one failure the in-sandbox
  // `timeout` cannot cover: the exec transport itself never returning.
  it("a never-resolving exec is cut off by the host-side backstop", async () => {
    const exec: SandboxCommandRunner = () => new Promise(() => {});

    const { verdict } = await runScopedTests(exec, ["@acme/hangs"], {
      totalCeilingMs: 25,
    });

    expect(verdict.status).toBe("inconclusive");
  });

  it("an empty scope is inconclusive, not a vacuous pass", async () => {
    const exec: SandboxCommandRunner = async () => execOk();

    const { verdict } = await runScopedTests(exec, []);

    expect(verdict.status).toBe("inconclusive");
  });
});
