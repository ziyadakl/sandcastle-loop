/**
 * Pins `scaledCheckTimeoutBudgetMs` and `countCheckScenarios`
 * (`run-harness-check.ts`, issue #1176) — the fix for the per-check time
 * budget assuming ONE test and also paying for a cold app compile, which
 * killed #1054's four-scenario check twice on 2026-09-01.
 *
 * Re-derived for issue #1198 piece C, which raised `CHECK_TIMEOUT_CEILING_MS`
 * from 900_000 (15 min) to 2_700_000 (45 min). The old ceiling clamped every
 * browser check with three or more scenarios, so #1160's five-scenario check
 * (the client-portal fact strip) could never reach its own verdict — it was
 * cut off mid-run and reported as a run fault. The sums below are now the
 * real arithmetic up to ten browser scenarios; the clamp only starts at
 * eleven.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SANDBOX_EXEC_TIMEOUT_MS } from "../sandbox-provider.js";
import {
  CHECK_TIMEOUT_BUDGET_MS,
  CHECK_TIMEOUT_CEILING_MS,
  countCheckScenarios,
  scaledCheckTimeoutBudgetMs,
} from "./run-harness-check.js";

describe("scaledCheckTimeoutBudgetMs", () => {
  it("undefined or 1 scenario is byte-identical to the base per-kind budget — legacy behaviour, unchanged", () => {
    expect(scaledCheckTimeoutBudgetMs("browser", undefined)).toBe(
      CHECK_TIMEOUT_BUDGET_MS.browser,
    );
    expect(scaledCheckTimeoutBudgetMs("browser", 1)).toBe(
      CHECK_TIMEOUT_BUDGET_MS.browser,
    );
    expect(scaledCheckTimeoutBudgetMs("unit", undefined)).toBe(
      CHECK_TIMEOUT_BUDGET_MS.unit,
    );
    expect(scaledCheckTimeoutBudgetMs("unit", 1)).toBe(
      CHECK_TIMEOUT_BUDGET_MS.unit,
    );
  });

  it("a zero or negative count degrades to one scenario rather than shrinking the budget", () => {
    expect(scaledCheckTimeoutBudgetMs("browser", 0)).toBe(
      CHECK_TIMEOUT_BUDGET_MS.browser,
    );
    expect(scaledCheckTimeoutBudgetMs("unit", -3)).toBe(
      CHECK_TIMEOUT_BUDGET_MS.unit,
    );
  });

  it("browser: 3 scenarios is a REAL sum, 420_000 + 240_000*2 = 900_000 — no longer the clamped value it was when the ceiling sat at 900_000 (issue #1198 piece C)", () => {
    expect(scaledCheckTimeoutBudgetMs("browser", 3)).toBe(900_000);
    expect(scaledCheckTimeoutBudgetMs("browser", 3)).toBeLessThan(
      CHECK_TIMEOUT_CEILING_MS,
    );
  });

  it("unit: 2 scenarios is 240_000 + 120_000*1 = 360_000", () => {
    expect(scaledCheckTimeoutBudgetMs("unit", 2)).toBe(360_000);
  });

  it("#1054's actual shape — a four-scenario browser check — is 420_000 + 240_000*3 = 1_140_000, the whole sum rather than a clamp", () => {
    expect(scaledCheckTimeoutBudgetMs("browser", 4)).toBe(1_140_000);
    expect(scaledCheckTimeoutBudgetMs("browser", 4)).toBeLessThan(
      CHECK_TIMEOUT_CEILING_MS,
    );
    expect(scaledCheckTimeoutBudgetMs("browser", 4)).toBeGreaterThan(
      CHECK_TIMEOUT_BUDGET_MS.browser,
    );
  });

  it("#1160's five-scenario browser check (the portal fact strip) is 420_000 + 240_000*4 = 1_380_000 and fits under the ceiling — the exact case the old 900_000 ceiling cut off mid-run, so a check that fails by WAITING could never reach its own verdict and was killed as a run fault instead", () => {
    expect(scaledCheckTimeoutBudgetMs("browser", 5)).toBe(1_380_000);
    expect(scaledCheckTimeoutBudgetMs("browser", 5)).toBeLessThan(
      CHECK_TIMEOUT_CEILING_MS,
    );
    // The number that used to cap it. Five scenarios at Playwright's own
    // 240_000 per-test timeout is 1_200_000 of graded run alone — already
    // past the old ceiling before the cold dev-server boot is paid for.
    expect(scaledCheckTimeoutBudgetMs("browser", 5)).toBeGreaterThan(900_000);
  });

  it("the ceiling is sized to fit TEN browser scenarios and no more — ten is a real sum, eleven clamps", () => {
    // 420_000 + 240_000*9 = 2_580_000
    expect(scaledCheckTimeoutBudgetMs("browser", 10)).toBe(2_580_000);
    expect(scaledCheckTimeoutBudgetMs("browser", 10)).toBeLessThanOrEqual(
      CHECK_TIMEOUT_CEILING_MS,
    );
  });

  it("an 11+-scenario browser check hits the 2_700_000 ceiling — the hung-run backstop is still real, only further out", () => {
    // 420_000 + 240_000*10 = 2_820_000, past the ceiling.
    expect(scaledCheckTimeoutBudgetMs("browser", 11)).toBe(
      CHECK_TIMEOUT_CEILING_MS,
    );
    expect(scaledCheckTimeoutBudgetMs("browser", 11)).toBe(2_700_000);
    expect(scaledCheckTimeoutBudgetMs("browser", 1000)).toBe(
      CHECK_TIMEOUT_CEILING_MS,
    );
  });

  it("the ceiling sits ABOVE the sandbox's own default backstop, and that is not a contradiction: the default only ever applies to a caller that OMITS timeoutMs, and every call site here passes one explicitly, which both providers honour verbatim (issue #1198 piece C)", () => {
    expect(CHECK_TIMEOUT_CEILING_MS).toBeGreaterThan(
      DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
    );
    expect(CHECK_TIMEOUT_CEILING_MS).toBe(2_700_000);
  });
});

describe("countCheckScenarios", () => {
  it("counts a plain test( and it(", () => {
    expect(
      countCheckScenarios(`
        test("does a thing", async () => {});
        it("does another thing", async () => {});
      `),
    ).toBe(2);
  });

  it("counts ordinary modifier forms — test.skip(, test.only( — as ONE scenario each", () => {
    expect(
      countCheckScenarios(`
        test.skip("skipped", () => {});
        test.only("only", () => {});
      `),
    ).toBe(2);
  });

  it("counts it.each(/test.each( as THREE scenarios, not one — issue #1176 review finding 5: a table expands to one graded run per row at execution time, which a static regex scan cannot count without becoming a parser, so it is weighted a fixed 3 instead of guessing the real row count", () => {
    expect(
      countCheckScenarios(`
        it.each([1, 2])("each %i", () => {});
      `),
    ).toBe(3);
    expect(
      countCheckScenarios(`
        test.each([
          ["a", 1],
          ["b", 2],
          ["c", 3],
          ["d", 4],
          ["e", 5],
          ["f", 6],
          ["g", 7],
          ["h", 8],
          ["i", 9],
          ["j", 10],
        ])("row %s", () => {});
      `),
    ).toBe(3);
  });

  it("mixes weighted and unweighted forms in one file — the each table alone outweighs two ordinary scenarios", () => {
    expect(
      countCheckScenarios(`
        test.skip("skipped", () => {});
        test.only("only", () => {});
        it.each([1, 2])("each %i", () => {});
      `),
    ).toBe(5); // 1 + 1 + 3
  });

  it("does NOT count describe( — it groups scenarios, it is not one", () => {
    expect(
      countCheckScenarios(`
        describe("a suite", () => {
          test("one scenario", () => {});
        });
      `),
    ).toBe(1);
  });

  it("does NOT count a bare word ending in test/it — unit(, wait(, tests( — floors to the single-scenario default when nothing real matches", () => {
    expect(
      countCheckScenarios(`
        unit("not a scenario call");
        await wait(100);
        tests("also not a scenario call");
      `),
    ).toBe(1);
  });

  it("a commented-out test STILL counts — documented over-count, acceptable headroom", () => {
    expect(
      countCheckScenarios(`
        // test("dead scenario", () => {});
        test("live scenario", () => {});
      `),
    ).toBe(2);
  });

  it("an empty or scenario-less file counts as one — the ordinary single-scenario default", () => {
    expect(countCheckScenarios("")).toBe(1);
    expect(countCheckScenarios("const x = 1;")).toBe(1);
  });
});

describe("countCheckScenarios feeding scaledCheckTimeoutBudgetMs — the each-table weighting stays bounded by the ordinary ceiling", () => {
  it("a lone .each( table (weight 3) scales the browser budget the same as any other 3-scenario file, well under the ceiling", () => {
    const count = countCheckScenarios(`
      test.each([1, 2, 3])("row %i", () => {});
    `);
    expect(count).toBe(3);
    expect(scaledCheckTimeoutBudgetMs("browser", count)).toBe(
      scaledCheckTimeoutBudgetMs("browser", 3),
    );
  });

  it("an each-table alongside real scenarios still clamps at CHECK_TIMEOUT_CEILING_MS once the count runs past ten, exactly like any other over-large count — the weighting cannot buy past the hung-run backstop", () => {
    const count = countCheckScenarios(`
      test("first", () => {});
      test("second", () => {});
      test("third", () => {});
      test("fourth", () => {});
      test("fifth", () => {});
      test("sixth", () => {});
      test("seventh", () => {});
      test("eighth", () => {});
      it.each([1, 2, 3, 4, 5])("row %i", () => {});
    `);
    expect(count).toBe(11); // 8 * 1 + 3
    expect(scaledCheckTimeoutBudgetMs("browser", count)).toBe(
      CHECK_TIMEOUT_CEILING_MS,
    );
  });
});
