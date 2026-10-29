/**
 * Unit tests for the in-sandbox lint verification the #931 fix rests on.
 *
 * The gate above this (`shipAfterMigrations`, covered in
 * `main.lint-verify.test.mts`) turns these three statuses into ship/stop, so
 * every wrong verdict here is either a false quarantine of finished work or an
 * unlinted slice shipping. The two directions are not symmetric — see the
 * cardinal rule in the module doc — and the tests below are written to hold
 * that asymmetry in place.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxExecResult } from "../sandbox-exec.js";
import {
  buildLintCommand,
  classifyLintRun,
  LINT_COMPLETED_SIGNALS,
  LINT_VERIFY_TIMEOUT_MS,
  verifyProjectLint,
} from "./lint-verification.js";

/** Real turbo tail from this repo's `pnpm lint`, captured from a live run. */
const TURBO_TALLY = [
  " Tasks:    15 successful, 15 total",
  "Cached:    15 cached, 15 total",
  "  Time:    3.943s >>> FULL TURBO",
].join("\n");

/** Real eslint summary line from the same run (warnings, exit 0). */
const ESLINT_SUMMARY = "✖ 277 problems (0 errors, 277 warnings)";

const obs = (over: Partial<Parameters<typeof classifyLintRun>[0]>) =>
  classifyLintRun({
    spawnFailed: false,
    timedOut: false,
    exitCode: 0,
    output: "",
    ...over,
  });

describe("classifyLintRun", () => {
  it("exit 0 WITH a turbo tally is the only shape that passes", () => {
    expect(obs({ exitCode: 0, output: TURBO_TALLY }).status).toBe("pass");
  });

  it("accepts eslint's own summary as completion evidence too", () => {
    expect(obs({ exitCode: 0, output: ESLINT_SUMMARY }).status).toBe("pass");
  });

  // The manufactured-zero hole. The docker provider resolves `exitCode: code ??
  // 0`, so a client killed mid-run arrives here as a silent exit 0. Reading
  // that as "lint passed" would have the gate inventing the very claim it was
  // built to stop taking on trust.
  it("exit 0 with NO evidence it ran is inconclusive, never a pass", () => {
    const v = obs({ exitCode: 0, output: "" });
    expect(v.status).toBe("inconclusive");
    expect(v.reason).toMatch(/nothing proves it ran/);
  });

  it("a clean non-zero exit is a real failure", () => {
    expect(obs({ exitCode: 1, output: TURBO_TALLY }).status).toBe("fail");
  });

  it("a non-zero exit needs no tally — coercion can only fabricate a zero", () => {
    expect(obs({ exitCode: 2, output: "boom" }).status).toBe("fail");
  });

  it("a toolchain gap is inconclusive, not a failure", () => {
    // `sh: 1: turbo: not found` — dash's phrasing, no "command" prefix.
    const v = obs({ exitCode: 127, output: "sh: 1: turbo: not found" });
    expect(v.status).toBe("inconclusive");
    expect(v.reason).toMatch(/inconclusive signal/);
  });

  // The guard that keeps the broad `/not found/` pattern safe: once the run
  // printed its tally it demonstrably RAN, so a runnability word above it came
  // from eslint's own output and must not excuse a real failure.
  it("a run that printed its tally cannot excuse itself with a runnability word", () => {
    const output = [
      "@acme/api:lint:   3:1  error  Definition for rule 'x/y' was not found",
      TURBO_TALLY,
    ].join("\n");
    expect(obs({ exitCode: 1, output }).status).toBe("fail");
  });

  it("a process that never started is inconclusive", () => {
    expect(obs({ spawnFailed: true, exitCode: null }).status).toBe(
      "inconclusive",
    );
  });

  it("a bound that fired is inconclusive, and says so without guessing the cause", () => {
    const v = obs({ timedOut: true, exitCode: 124, output: TURBO_TALLY });
    expect(v.status).toBe("inconclusive");
    // Not "timed out": exit 137 is also what an OOM kill returns.
    expect(v.reason).toMatch(/bound fired or the process was killed/);
  });

  it("a signal kill (exit code unknown) is inconclusive", () => {
    expect(obs({ exitCode: null, output: TURBO_TALLY }).status).toBe(
      "inconclusive",
    );
  });
});

describe("buildLintCommand", () => {
  it("runs the project's own script, with the env the tally guard depends on", () => {
    // NO_COLOR is load-bearing, not cosmetic: escape codes land mid-tally and
    // defeat LINT_COMPLETED_SIGNALS, which would turn every pass into an
    // inconclusive — i.e. silently restore the #931 false quarantine.
    expect(buildLintCommand()).toBe(
      "env CI=1 NO_COLOR=1 FORCE_COLOR=0 pnpm lint",
    );
  });

  it("the completion signals match the REAL output this repo's lint prints", () => {
    expect(LINT_COMPLETED_SIGNALS.some((re) => re.test(TURBO_TALLY))).toBe(true);
    expect(LINT_COMPLETED_SIGNALS.some((re) => re.test(ESLINT_SUMMARY))).toBe(
      true,
    );
  });
});

describe("verifyProjectLint", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const execReturning =
    (over: Partial<SandboxExecResult>, seen?: unknown[][]) =>
    async (cmd: string, opts?: unknown): Promise<SandboxExecResult> => {
      seen?.push([cmd, opts]);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        ...over,
      };
    };

  it("reports inconclusive — never a pass — when the sandbox offers no exec", async () => {
    const v = await verifyProjectLint(undefined);
    expect(v.status).toBe("inconclusive");
    expect(v.reason).toMatch(/command execution/);
  });

  it("bounds the command inside the sandbox", async () => {
    const seen: unknown[][] = [];
    await verifyProjectLint(execReturning({ stdout: TURBO_TALLY }, seen));
    expect(seen[0]?.[0]).toBe(buildLintCommand());
    expect(seen[0]?.[1]).toEqual({ timeoutMs: LINT_VERIFY_TIMEOUT_MS });
  });

  it("sees through ANSI colour, so a tool ignoring NO_COLOR cannot blind the guard", async () => {
    const coloured =
      "\u001B[2m Tasks:\u001B[22m    \u001B[1m\u001B[32m15 successful\u001B[39m, 15 total";
    const v = await verifyProjectLint(execReturning({ stdout: coloured }));
    expect(v.status).toBe("pass");
  });

  it("treats a rejected exec as could-not-run, not as a lint failure", async () => {
    // A wedged docker daemon rejecting on every issue must not quarantine
    // ticket after ticket for failing lint it never ran.
    const v = await verifyProjectLint(async () => {
      throw new Error("docker daemon is not responding");
    });
    expect(v.status).toBe("inconclusive");
  });

  it("gives up on a transport that never answers, rather than hanging the loop", async () => {
    vi.useFakeTimers();
    const v = verifyProjectLint(
      // The failure the in-sandbox timeout cannot cover: the exec call itself
      // never returns, so no provider-side kill can be reported back.
      () => new Promise<SandboxExecResult>(() => {}),
      { timeoutMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(1_000 + 30_000 + 1);
    expect((await v).status).toBe("inconclusive");
  });

  it("never throws, whatever the exec does", async () => {
    await expect(
      verifyProjectLint(() => {
        throw new Error("synchronous explosion");
      }),
    ).resolves.toHaveProperty("status", "inconclusive");
  });
});
