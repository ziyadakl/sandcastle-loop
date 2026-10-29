/**
 * Pins the containment property `run-harness-check.ts`'s
 * `DEFAULT_TIMEOUT_MS` doc comment claims by hand-computed arithmetic
 * (finding #9 of the 2026-08-04 screen-check review): the harness's OUTER
 * per-attempt command budget must exceed Playwright's own `webServer.timeout`
 * (a cold dev-server boot, `reuseExistingServer: false`) PLUS Playwright's
 * own per-test `timeout` — those two stack sequentially inside one harness
 * attempt, back to back. Before this was fixed, the outer budget was
 * exactly EQUAL to the boot budget alone, so a cold boot could eat the
 * whole thing and leave the test zero time to ever run, manufacturing an
 * `inconclusive` verdict and burning the harness's one sanctioned re-run on
 * a check that was never actually attempted.
 *
 * `.sandcastle` never imports `apps/nextjs` module code (see
 * `verdict.ts`'s own doc comment on that boundary), so — mirroring
 * `sentinel-contract.test.ts` in this same directory — this reads
 * `playwright.config.ts`'s SOURCE TEXT rather than importing it, and
 * extracts the two real numeric literals instead of re-typing them by
 * hand, so a change on either side that breaks the containment property
 * turns this test red instead of leaving a stale comment.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runCheckCommand } from "../checkwriter/verify-checks.js";
import type {
  SandboxExecOptions,
  SandboxExecResult,
} from "../sandbox-exec.js";
import { TEST_VERIFY_PACKAGE_TIMEOUT_MS } from "../testing/test-verification.js";
import {
  CHECK_TIMEOUT_BUDGET_MS,
  runHarnessScreenCheck,
  scaledCheckTimeoutBudgetMs,
} from "./run-harness-check.js";

const CONFIG_URL = new URL(
  "../../__fixtures__/project-side/playwright.config.ts",
  import.meta.url,
);
const configSource = readFileSync(CONFIG_URL, "utf8");

function extractTimeoutMs(haystack: string, label: string): number {
  const match = /\btimeout:\s*([\d_]+)/.exec(haystack);
  if (!match) {
    throw new Error(
      `could not find a "timeout:" numeric literal for ${label} in ` +
        `playwright.config.ts — has its shape changed enough that this ` +
        `probe needs updating too?`,
    );
  }
  return Number(match[1]!.replace(/_/g, ""));
}

/**
 * The worst case one invocation of the check command can legitimately spend,
 * read out of `playwright.config.ts`'s SOURCE rather than re-typed here: a
 * cold dev-server boot (`webServer.timeout`, since `reuseExistingServer` is
 * false) followed by one test's own budget (the top-level `timeout`). Any
 * budget at or below this can be eaten entirely by the boot, leaving the
 * check zero time to ever run.
 */
function playwrightWorstCaseMs(): number {
  const useIdx = configSource.indexOf("use: {");
  const webServerIdx = configSource.indexOf("webServer: {");
  const projectsIdx = configSource.indexOf("projects: [");
  if (useIdx <= 0 || webServerIdx <= useIdx || projectsIdx <= webServerIdx) {
    throw new Error(
      "playwright.config.ts no longer has the use/webServer/projects ordering " +
        "this probe slices on — the probe needs updating before its result " +
        "means anything.",
    );
  }
  // The top-level per-test `timeout` sits before `use: {`; `webServer`'s
  // own `timeout` sits inside its own block, between `webServer: {` and
  // `projects: [`. Slicing keeps the two same-named keys from being
  // confused with each other.
  return (
    extractTimeoutMs(
      configSource.slice(0, useIdx),
      "the top-level per-test `timeout`",
    ) +
    extractTimeoutMs(
      configSource.slice(webServerIdx, projectsIdx),
      "`webServer.timeout`",
    )
  );
}

describe("the harness's outer command timeout contains Playwright's own inner budgets", () => {
  it("finds both real numbers in playwright.config.ts — proves the instrument before trusting it", () => {
    expect(configSource).toContain("webServer: {");
    expect(configSource).toContain("reuseExistingServer: false");
  });

  it("the browser budget strictly exceeds webServer.timeout + the per-test timeout", () => {
    expect(CHECK_TIMEOUT_BUDGET_MS.browser).toBeGreaterThan(
      playwrightWorstCaseMs(),
    );
  });

  /**
   * The SAME command (`buildCheckCommand`'s `pnpm … e2e -- <file>`) is
   * executed at TWO places in this loop, and until this test only one of them
   * had a budget that could contain it:
   *
   *   - the harness gate at ship time (`runHarnessScreenCheck`), and
   *   - the must-fail-first proof BEFORE the builder ever runs
   *     (`runCheckCommand`, driven from `main.mts`'s `runCheckWriter`).
   *
   * A budget smaller than the worst case does not merely slow the proof down;
   * it manufactures a `timedOut` observation, which `classifyCheckRun` reports
   * as `inconclusive` — and an inconclusive proof is exactly the outcome that
   * used to sail past the ticket-stopping ladder. Asserted through the real
   * functions' OBSERVED behaviour (what budget actually reaches `exec`),
   * never by reading a constant back at itself.
   */
  it("every check-execution entry point spends a budget bigger than a cold boot plus one test", async () => {
    const budgetsSpent: number[] = [];
    const exec = async (
      _command: string,
      opts?: SandboxExecOptions,
    ): Promise<SandboxExecResult> => {
      budgetsSpent.push(opts?.timeoutMs ?? 0);
      return { stdout: "1 failed", stderr: "", exitCode: 1, timedOut: false };
    };

    // The nonce is irrelevant to what this pins (the BUDGET that reaches
    // `exec`), and deliberately does not match the fake output — every run
    // here reads `inconclusive`, which is fine: an inconclusive run still
    // spends the full budget, and `runHarnessScreenCheck` still re-runs.
    const nonce = "0123456789abcdef0123456789abcdef";
    await runCheckCommand(
      "browser",
      exec,
      "pnpm --filter @acme/nextjs e2e -- x.spec.ts",
      "red",
      nonce,
    );
    await runHarnessScreenCheck(
      "browser",
      exec,
      "pnpm --filter @acme/nextjs e2e -- x.spec.ts",
      nonce,
    );

    // Both entry points were really exercised — a silent zero-call run would
    // otherwise pass this vacuously.
    expect(budgetsSpent.length).toBeGreaterThanOrEqual(2);
    const worstCaseMs = playwrightWorstCaseMs();
    for (const spent of budgetsSpent) {
      expect(spent).toBeGreaterThan(worstCaseMs);
    }
  });
});

// ---------------------------------------------------------------------------
// The same property for the vitest runner (issue #956).
//
// `.sandcastle` never imports `apps/nextjs` or `packages/*` module code, so
// these numbers are read out of the configs' SOURCE TEXT exactly as the
// Playwright ones above are. Scanned across EVERY package's config rather than
// just the one that happens to set them today: a package that later raises its
// own `testTimeout` past this budget would otherwise break the containment
// property silently, which is precisely the drift a hand-written comment
// cannot catch.
// ---------------------------------------------------------------------------

const VITEST_CONFIG_URLS = [
  "../../__fixtures__/project-side/vitest.config.ts",
].map((rel) => new URL(rel, import.meta.url));

/** Largest value any config in the workspace sets for `key`, or 0 if none does. */
function maxConfiguredMs(key: "testTimeout" | "hookTimeout"): number {
  let max = 0;
  for (const url of VITEST_CONFIG_URLS) {
    const source = readFileSync(url, "utf8");
    const pattern = new RegExp(`\\b${key}:\\s*([\\d_]+)`, "g");
    for (const match of source.matchAll(pattern)) {
      max = Math.max(max, Number(match[1]!.replace(/_/g, "")));
    }
  }
  return max;
}

/**
 * The worst case ONE vitest check invocation can legitimately spend on the
 * graded portion of its run: one `beforeAll` seeding the shared test Postgres
 * (`hookTimeout`) followed by the single graded test's own budget
 * (`testTimeout`). Both stack sequentially inside the one process, exactly as
 * Playwright's boot and per-test budgets do.
 *
 * Deliberately NOT the whole story — vitest's cold start and Vite's transform
 * of the module graph sit outside both inner budgets, which is why
 * `CHECK_TIMEOUT_BUDGET_MS.unit` has to exceed this comfortably rather than
 * merely clear it.
 */
function vitestGradedWorstCaseMs(): number {
  return maxConfiguredMs("hookTimeout") + maxConfiguredMs("testTimeout");
}

describe("the unit budget contains vitest's own inner budgets", () => {
  it("PROVES THE INSTRUMENT: really finds the numbers in the configs, so a zero is never mistaken for 'nothing to contain'", () => {
    expect(maxConfiguredMs("testTimeout")).toBeGreaterThan(0);
    expect(maxConfiguredMs("hookTimeout")).toBeGreaterThan(0);
  });

  it("the unit budget strictly exceeds hookTimeout + testTimeout", () => {
    expect(CHECK_TIMEOUT_BUDGET_MS.unit).toBeGreaterThan(
      vitestGradedWorstCaseMs(),
    );
  });

  it("stays well under the loop's own WHOLE-PACKAGE vitest bound — one file must never cost more than a whole suite", () => {
    // `TEST_VERIFY_PACKAGE_TIMEOUT_MS` is the 8 minutes the loop already gives
    // an entire package's suite, under a 20-minute total ceiling. A single
    // check file asking for more than that would be incoherent.
    expect(CHECK_TIMEOUT_BUDGET_MS.unit).toBeLessThan(
      TEST_VERIFY_PACKAGE_TIMEOUT_MS,
    );
  });

  it("is smaller than the browser budget — the two runners' worst cases are genuinely different", () => {
    expect(CHECK_TIMEOUT_BUDGET_MS.unit).toBeLessThan(
      CHECK_TIMEOUT_BUDGET_MS.browser,
    );
  });

  /**
   * The mirror of the browser entry-point test above, and the reason the
   * budget is a per-KIND record instead of two loose constants: a unit run
   * that silently spent Playwright's seven-minute budget would not fail
   * anything, it would just idle a sandbox for four extra minutes on every
   * backend ticket in the queue. Asserted through the real functions'
   * OBSERVED behaviour — what budget actually reaches `exec` — never by
   * reading a constant back at itself.
   */
  it("every entry point spends the UNIT budget for a unit run, and the BROWSER budget for a browser run", async () => {
    const spentByCommand: { command: string; budget: number }[] = [];
    const exec = async (
      command: string,
      opts?: SandboxExecOptions,
    ): Promise<SandboxExecResult> => {
      spentByCommand.push({ command, budget: opts?.timeoutMs ?? 0 });
      return {
        stdout: "      Tests  1 failed (1)",
        stderr: "",
        exitCode: 1,
        timedOut: false,
      };
    };

    const unitCommand = "pnpm --filter @acme/api run test src/x.test.ts";
    const browserCommand = "pnpm --filter @acme/nextjs e2e -- x.spec.ts";
    const nonce = "0123456789abcdef0123456789abcdef";
    await runCheckCommand("unit", exec, unitCommand, "red", nonce);
    await runHarnessScreenCheck("unit", exec, unitCommand, nonce);
    await runCheckCommand("browser", exec, browserCommand, "red", nonce);
    await runHarnessScreenCheck("browser", exec, browserCommand, nonce);

    // Both kinds, both entry points, all really exercised — a silent
    // zero-call run would otherwise pass every assertion below vacuously.
    // `runHarnessScreenCheck` re-runs a non-match once, so the browser side
    // contributes 1 + 2 and the unit side 1 + 2.
    const unitBudgets = spentByCommand
      .filter((s) => s.command === unitCommand)
      .map((s) => s.budget);
    const browserBudgets = spentByCommand
      .filter((s) => s.command === browserCommand)
      .map((s) => s.budget);
    expect(unitBudgets.length).toBeGreaterThanOrEqual(2);
    expect(browserBudgets.length).toBeGreaterThanOrEqual(2);

    const vitestWorstCaseMs = vitestGradedWorstCaseMs();
    for (const budget of unitBudgets) {
      expect(budget).toBe(CHECK_TIMEOUT_BUDGET_MS.unit);
      expect(budget).toBeGreaterThan(vitestWorstCaseMs);
    }
    for (const budget of browserBudgets) {
      expect(budget).toBe(CHECK_TIMEOUT_BUDGET_MS.browser);
      expect(budget).toBeGreaterThan(playwrightWorstCaseMs());
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #1176 — a scaled (multi-scenario) budget must actually reach `exec`,
// not just exist as a pure computation nobody wires up. Asserted through the
// real entry point's OBSERVED behaviour, same discipline as the two suites
// above.
// ---------------------------------------------------------------------------

describe("a scaled budget reaches exec through the ship-time entry point", () => {
  it("runHarnessScreenCheck spends EXACTLY the caller-supplied scaled budget, not the single-scenario default", async () => {
    const budgetsSpent: number[] = [];
    const exec = async (
      _command: string,
      opts?: SandboxExecOptions,
    ): Promise<SandboxExecResult> => {
      budgetsSpent.push(opts?.timeoutMs ?? 0);
      return { stdout: "1 failed", stderr: "", exitCode: 1, timedOut: false };
    };

    const nonce = "0123456789abcdef0123456789abcdef";
    // A four-scenario browser check — #1054's own shape.
    const scaled = scaledCheckTimeoutBudgetMs("browser", 4);
    expect(scaled).toBeGreaterThan(CHECK_TIMEOUT_BUDGET_MS.browser);

    await runHarnessScreenCheck(
      "browser",
      exec,
      "pnpm --filter @acme/nextjs e2e -- x.spec.ts",
      nonce,
      scaled,
    );

    expect(budgetsSpent.length).toBeGreaterThanOrEqual(1);
    for (const spent of budgetsSpent) {
      expect(spent).toBe(scaled);
      expect(spent).toBeGreaterThan(CHECK_TIMEOUT_BUDGET_MS.browser);
    }
  });

  it("runCheckCommand spends EXACTLY the caller-supplied scaled budget for a multi-scenario unit check", async () => {
    const budgetsSpent: number[] = [];
    const exec = async (
      _command: string,
      opts?: SandboxExecOptions,
    ): Promise<SandboxExecResult> => {
      budgetsSpent.push(opts?.timeoutMs ?? 0);
      return {
        stdout: "      Tests  1 failed (1)",
        stderr: "",
        exitCode: 1,
        timedOut: false,
      };
    };

    const nonce = "0123456789abcdef0123456789abcdef";
    const scaled = scaledCheckTimeoutBudgetMs("unit", 2);
    expect(scaled).toBeGreaterThan(CHECK_TIMEOUT_BUDGET_MS.unit);

    await runCheckCommand(
      "unit",
      exec,
      "pnpm --filter @acme/api run test src/x.test.ts",
      "red",
      nonce,
      scaled,
    );

    expect(budgetsSpent).toEqual([scaled]);
  });
});
