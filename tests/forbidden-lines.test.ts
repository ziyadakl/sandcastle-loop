/**
 * Wave 3 / M7 — forbidden assertion-line patterns shared between the
 * implementer-output Zod schema and the reviewer prompt.
 *
 * These tests pin down the parametric contract:
 *   1. Every forbidden line listed in the reviewer prompt's text is rejected
 *      by `isGenericAssertionLine`.
 *   2. Realistic non-forbidden assertion lines are accepted.
 *   3. The schema-side check and the prompt-side text are kept in sync
 *      (cardinality + correspondence).
 */
import { describe, it, expect } from "vitest";

import {
  FORBIDDEN_LINES_DESCRIPTIONS,
  FORBIDDEN_LINES_PROMPT_TEXT,
  GENERIC_ASSERTION_LINE_PATTERNS,
  isGenericAssertionLine,
} from "../src/verdicts/forbidden-lines.js";

describe("isGenericAssertionLine — forbidden patterns (parametric)", () => {
  // Each row pairs a representative line with the rule it's expected to trip.
  // Every pattern in GENERIC_ASSERTION_LINE_PATTERNS gets at least one row.
  const cases: Array<{ line: string; rule: string }> = [
    // 1. Empty / whitespace-only
    { line: "", rule: "empty / whitespace-only" },
    { line: "   ", rule: "empty / whitespace-only" },
    { line: "\t\t", rule: "empty / whitespace-only" },

    // 2. `Running N tests` / `Running 1 test using 1 worker`
    { line: "Running 3 tests using 1 worker", rule: "Running N tests preamble" },
    { line: "Running 1 test", rule: "Running N tests preamble" },
    { line: "running 7 tests", rule: "Running N tests preamble (case)" },
    { line: "  Running 12 tests", rule: "Running N tests preamble (whitespace)" },

    // 3. Bare URL line
    { line: "http://localhost:3000/foo", rule: "bare URL" },
    { line: "https://example.com/path", rule: "bare URL https" },
    { line: "  https://localhost:5173/login  ", rule: "bare URL whitespace" },

    // 4. `<paste line>` / `<the quoted line>` placeholders
    { line: "<paste line>", rule: "<paste line> placeholder" },
    { line: "<paste the quoted line>", rule: "<paste …> placeholder" },
    { line: "<the quoted line>", rule: "<the quoted line> placeholder" },
    { line: "✓ login: <paste line>", rule: "<paste …> embedded" },

    // 5. `using N worker` / `using N workers` (case-insensitive)
    { line: "using 1 worker", rule: "using N worker" },
    { line: "Using 4 workers", rule: "using N workers" },
    { line: "playwright using 2 workers", rule: "using N workers embedded" },

    // 6. `Workers:` banner
    { line: "Workers: 4", rule: "Workers banner" },
    { line: "  workers: 1", rule: "Workers banner case+ws" },

    // 7. `Slow test file` banner
    { line: "Slow test file: apps/web/e2e/login.spec.ts", rule: "Slow test file" },
    { line: "  slow test file detected", rule: "Slow test file case" },

    // 8. `[chromium]` alone
    { line: "[chromium]", rule: "[chromium] alone" },
    { line: "  [chromium]  ", rule: "[chromium] alone with ws" },
    { line: "[ chromium ]", rule: "[chromium] alone with internal ws" },

    // 9. Standalone words `passed`, `failed`, or `all green`
    { line: "passed", rule: "passed alone" },
    { line: "Passed.", rule: "passed alone, capital + dot" },
    { line: "failed", rule: "failed alone" },
    { line: "FAILED", rule: "failed alone caps" },
    { line: "all green", rule: "all green alone" },
    { line: "ALL GREEN!", rule: "all green alone caps + bang" },
  ];

  for (const { line, rule } of cases) {
    it(`rejects: ${JSON.stringify(line)} — ${rule}`, () => {
      expect(isGenericAssertionLine(line)).toBe(true);
    });
  }
});

describe("isGenericAssertionLine — counter-cases (valid lines)", () => {
  const validLines: string[] = [
    // Real playwright passing markers
    "✓ login flow completes",
    "✔ should render the dashboard",
    "PASS apps/web/e2e/login.spec.ts",
    "PASSED login.spec.ts:42 should redirect",
    // Explicit assertion calls
    "expect(foo).toBe(bar)",
    "expect(page.locator('button')).toBeVisible();",
    // Test description text
    "should render the dashboard",
    "should accept valid credentials and redirect to /home",
    // Looks like the playwright preamble but isn't (counts a non-test noun)
    "Running migrations against postgres",
    // Looks superficially URL-ish but has trailing words
    "http://localhost:3000/foo - landed",
    // Valid line containing the word `passed` but not alone on the line
    "1 passed in 12.3s — see /tmp/playwright.log",
    "All assertions passed for the login spec",
    // [chromium] WITH a leading checkmark — that's a real passing-test line
    "✓ [chromium] login flow completes",
    "PASS [chromium] should render",
  ];

  for (const line of validLines) {
    it(`accepts: ${JSON.stringify(line)}`, () => {
      expect(isGenericAssertionLine(line)).toBe(false);
    });
  }
});

describe("schema and prompt agree (single source of truth)", () => {
  it("FORBIDDEN_LINES_DESCRIPTIONS has exactly one entry per pattern", () => {
    expect(FORBIDDEN_LINES_DESCRIPTIONS.length).toBe(
      GENERIC_ASSERTION_LINE_PATTERNS.length,
    );
    expect(FORBIDDEN_LINES_DESCRIPTIONS.length).toBe(9);
  });

  it("FORBIDDEN_LINES_PROMPT_TEXT contains every description as a markdown bullet", () => {
    for (const desc of FORBIDDEN_LINES_DESCRIPTIONS) {
      expect(FORBIDDEN_LINES_PROMPT_TEXT).toContain(desc);
    }
    // The text is a bullet list — count the bullet markers.
    const bulletCount = FORBIDDEN_LINES_PROMPT_TEXT.split("\n").filter((l) =>
      l.trim().startsWith("- "),
    ).length;
    expect(bulletCount).toBe(9);
  });

  it("schema rejects every line the reviewer prompt's text rejects (key cases)", () => {
    // For each forbidden description, derive at least one example line that
    // matches it and assert isGenericAssertionLine returns true. This is the
    // load-bearing invariant: any line mentioned in the prompt's bullet list
    // MUST be rejected by the schema, and vice versa.
    const probesPerDescription: Array<{
      description: string;
      probe: string;
    }> = [
      { description: "empty or whitespace-only line", probe: "" },
      {
        description: "'Running N tests' / 'Running 1 test using 1 worker'",
        probe: "Running 5 tests using 2 workers",
      },
      {
        description: "a bare URL line",
        probe: "https://localhost:3000/dashboard",
      },
      {
        description: "the literal placeholder '<paste line>'",
        probe: "<paste line>",
      },
      {
        description: "'using N worker' / 'using N workers'",
        probe: "using 4 workers",
      },
      { description: "'Workers:' banner line", probe: "Workers: 4" },
      {
        description: "'Slow test file' banner",
        probe: "Slow test file: foo.spec.ts",
      },
      {
        description: "'[chromium]' alone on a line",
        probe: "[chromium]",
      },
      {
        description: "the bare words 'passed', 'failed', or 'all green'",
        probe: "all green",
      },
    ];

    for (const { description, probe } of probesPerDescription) {
      // The description text must appear in the prompt-text constant.
      const matchesPrompt = FORBIDDEN_LINES_DESCRIPTIONS.some((d) =>
        d.includes(description.split(" ")[0]),
      );
      expect(matchesPrompt).toBe(true);
      // The probe line must be rejected by the schema-side check.
      expect(isGenericAssertionLine(probe)).toBe(true);
    }
  });
});
