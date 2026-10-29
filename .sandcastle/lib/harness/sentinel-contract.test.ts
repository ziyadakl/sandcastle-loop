/**
 * The contract test `verdict.ts`'s own doc comment used to CLAIM already
 * existed and did not (finding #5 of the 2026-08-04 screen-check review —
 * verified by grepping both files for a test file, and finding none).
 *
 * `.sandcastle` never imports the project's module code (the same boundary
 * `LINT_CERT_TOKEN`/`TEST_CERT_TOKEN` in `main.mts` already draws for
 * cross-boundary string contracts), so `NEVER_SETTLED_SENTINEL` and
 * `CLAIM_MISMATCH_SENTINEL` are duplicated as literal strings in both
 * `verdict.ts` and the project's graded-screen helper (the reference copy
 * under `__fixtures__/project-side/` is what this test reads). Nothing
 * PINS them together — rename either copy and every existing test still
 * passes, while `classifyHarnessRun` silently stops recognising
 * `never-settled`/`claim-mismatch` output and reads it as an ordinary
 * `graded-mismatch` instead. That is the exact verdict inversion Piece E/F
 * exists to prevent, now happening one file over from where anyone would
 * look for it.
 *
 * This is that missing pin: it reads `graded-screen-check.ts`'s SOURCE TEXT
 * (the module itself can't be imported across the boundary) and proves the
 * two literal `export const` declarations there still match this module's
 * own constants, byte for byte. Proven to actually catch a drift before
 * being trusted: temporarily renaming either sentinel constant on either
 * side and re-running this file turns it red (see the PR description for
 * the transcript) — it was reverted before committing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { GRADE_MARK_ENV } from "./grade-mark.js";
import {
  CLAIM_MISMATCH_SENTINEL,
  GRADED_FIGURE_SENTINEL,
  NEVER_SETTLED_SENTINEL,
  SCREEN_SETTLED_SENTINEL,
} from "./verdict.js";

// Resolved against this module, not the cwd — mirrors
// `.sandcastle/lib/telemetry/example-contract.test.ts`'s own fixture-path
// pattern, since vitest here can be invoked from either the repo root or
// `.sandcastle/`.
const SOURCE_URL = new URL(
  "../../__fixtures__/project-side/graded-screen-check.ts",
  import.meta.url,
);
const source = readFileSync(SOURCE_URL, "utf8");

describe("sentinel contract with the project-side graded-screen helper (reference copy)", () => {
  it("the source file actually loaded and is non-trivial — proves the instrument before trusting its silence", () => {
    // A wrong path would resolve to an empty/missing read, and every
    // `toContain` below would then vacuously... not pass, but the failure
    // would read as "sentinel not found" instead of "file not found",
    // which is the wrong diagnosis. Assert the read itself succeeded first.
    expect(source.length).toBeGreaterThan(500);
    expect(source).toContain("waitForGradableScreen");
  });

  it("NEVER_SETTLED_SENTINEL is the exact same literal on both sides", () => {
    expect(source).toContain(
      `export const NEVER_SETTLED_SENTINEL = "${NEVER_SETTLED_SENTINEL}"`,
    );
  });

  it("CLAIM_MISMATCH_SENTINEL is the exact same literal on both sides", () => {
    expect(source).toContain(
      `export const CLAIM_MISMATCH_SENTINEL = "${CLAIM_MISMATCH_SENTINEL}"`,
    );
  });

  // 2026-08-04 review finding #6: the third sentinel — its ABSENCE, not its
  // presence, is what changed `classifyHarnessRun`'s default (see that
  // constant's own doc comment). Just as reachable to silently drift as the
  // two above, so it gets the identical pin.
  it("GRADED_FIGURE_SENTINEL is the exact same literal on both sides", () => {
    expect(source).toContain(
      `export const GRADED_FIGURE_SENTINEL =\n  "${GRADED_FIGURE_SENTINEL}"`,
    );
  });

  // Issues #1160/#1161 (2026-08-31): the SUCCESS line `waitForGradableScreen`
  // prints once the page settled and its claim matched — the positive evidence
  // `classifyCheckRun`'s browser gate accepts on a red that failed a plain
  // `expect()` before ever reaching `gradeScreenText`. Drift here and every
  // such red reads "inconclusive" again, which is the exact quarantine this
  // sentinel was added to stop.
  it("SCREEN_SETTLED_SENTINEL is the exact same literal on both sides", () => {
    expect(source).toContain(
      `export const SCREEN_SETTLED_SENTINEL = "${SCREEN_SETTLED_SENTINEL}"`,
    );
  });

  it("the helper still PRINTS the settled line, on the matched path (human diagnostics)", () => {
    // The printed line is diagnostic only since 2026-09-01 (the verdict rests
    // on the nonce-keyed settled record below), but it is still part of the
    // contract: a person reading raw output finds the settling moment by it.
    expect(source).toContain(
      "console.log(`${SCREEN_SETTLED_SENTINEL} screen=${opts.screen}`)",
    );
  });

  // 2026-09-01: the settled evidence a verdict actually rests on. The
  // browser side appends `{screen, url, settled: true}` to the SAME
  // nonce-named mark file as the grade mark; `gradeMarkEpilogue`
  // (`./grade-mark.ts`) tells the two kinds apart by the `settled: true` /
  // `figure` shape and relays the settled count on its own `SC-SETTLED`
  // line. Drift the record's shape on either side and every
  // settled-then-red check silently reads "never reached the screen" again
  // — the exact quarantine the record exists to stop.
  it("the helper actually WRITES the settled record, before the settled line prints", () => {
    expect(source).toContain("function writeSettledMark(");
    expect(source).toContain(
      "JSON.stringify({ screen, url: page.url(), settled: true })",
    );
    const write = source.indexOf("writeSettledMark(page, opts.screen)");
    const print = source.indexOf(
      "console.log(`${SCREEN_SETTLED_SENTINEL} screen=${opts.screen}`)",
    );
    expect(write).toBeGreaterThan(-1);
    expect(print).toBeGreaterThan(write);
  });

  it("the settled record rides the grade-mark file, read by the same env variable", () => {
    // `writeSettledMark` must read the SAME variable the epilogue's file is
    // named under — a second variable on either side would strand the record
    // in a file nothing reads.
    const fn = source.slice(
      source.indexOf("function writeSettledMark("),
      source.indexOf("function writeGradeMark("),
    );
    expect(fn).toContain("process.env[GRADE_MARK_ENV]");
  });

  // Issue #925. The fourth cross-boundary literal, and the first that is a
  // SUCCESS path rather than a failure one — which makes a silent drift here
  // worse than a drift in the three above. Rename either copy alone and the
  // helper writes its marks to a file nothing set and nothing reads, so every
  // browser check at once reports "grading never ran" and every ticket in the
  // night stops on a check that was in fact perfect.
  it("GRADE_MARK_ENV is the exact same literal on both sides", () => {
    expect(source).toContain(`export const GRADE_MARK_ENV = "${GRADE_MARK_ENV}"`);
  });

  it("the helper actually WRITES a mark, and only after the assertion passed", () => {
    // Proves the instrument, not just the name: a file that exported the
    // constant and never used it would satisfy the pin above while leaving
    // the hole #925 is about wide open.
    expect(source).toContain("function writeGradeMark(");
    const assertion = source.indexOf(").toBe(true);");
    const mark = source.indexOf("writeGradeMark(locator");
    expect(assertion).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(assertion);
  });
});
