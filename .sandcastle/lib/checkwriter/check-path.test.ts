import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultProjectConfig, resetProjectConfig, setProjectConfig } from "../project-config.js";

import {
  buildCheckCommand,
  CheckWriterMissingGradedHelperError,
  checkDirForIssue,
  checkDirGlobForIssue,
  hasPreexistingCheckFiles,
  isSafeCheckRelativePath,
  isUsableIssueNumber,
  missingGradedHelperCalls,
  withoutRedundantIssueDirPrefix,
} from "./check-path.js";

describe("checkDirForIssue / checkDirGlobForIssue", () => {
  it("lives inside apps/nextjs/e2e — where Playwright's testDir can find it", () => {
    expect(checkDirForIssue(911)).toBe("apps/nextjs/e2e/checks/issue-911");
  });

  it("the glob covers everything under that directory, additively", () => {
    expect(checkDirGlobForIssue(911)).toBe(
      "apps/nextjs/e2e/checks/issue-911/**",
    );
  });

  it("two different issues never collide on the same directory", () => {
    expect(checkDirForIssue(1)).not.toBe(checkDirForIssue(2));
  });
});

// The one definition every site now shares: the receipt locations here and in
// `must-fail-first-receipt.ts`, `buildUnitCheckCommand`'s shell path, the
// sibling-brief collector, and `runMain`'s dispatch pool. Four copies of this
// two-clause test had grown, and two of them had drifted to `Number.isInteger`.
describe("isUsableIssueNumber", () => {
  it("accepts an ordinary issue number", () => {
    expect(isUsableIssueNumber(911)).toBe(true);
    expect(isUsableIssueNumber(1)).toBe(true);
  });

  it("refuses zero, negatives and fractions", () => {
    for (const n of [0, -1, -911, 8.5]) {
      expect(isUsableIssueNumber(n)).toBe(false);
    }
  });

  it("refuses what `Number.isInteger` would have waved through", () => {
    // The drift that mattered: `Number.isInteger(1e21)` is true, so the two
    // sites using it would have interpolated `issue-1e+21` into a directory
    // name and shown a model `#1e+21`.
    expect(Number.isInteger(1e21)).toBe(true);
    expect(isUsableIssueNumber(1e21)).toBe(false);
  });

  it("refuses NaN, Infinity, and anything that is not a number at all", () => {
    for (const n of [NaN, Infinity, -Infinity, "911", null, undefined, {}]) {
      expect(isUsableIssueNumber(n)).toBe(false);
    }
  });
});

describe("isSafeCheckRelativePath — whitelist, not a blacklist", () => {
  it("accepts a plain spec filename", () => {
    expect(isSafeCheckRelativePath("team-cash-flow.spec.ts")).toBe(true);
  });

  it("accepts one level of nesting", () => {
    expect(isSafeCheckRelativePath("finance/team-cash-flow.spec.ts")).toBe(
      true,
    );
  });

  it("rejects path traversal", () => {
    expect(isSafeCheckRelativePath("../../etc/passwd.spec.ts")).toBe(false);
  });

  it("rejects a leading slash (absolute path)", () => {
    expect(isSafeCheckRelativePath("/etc/passwd.spec.ts")).toBe(false);
  });

  it("rejects shell metacharacters", () => {
    expect(isSafeCheckRelativePath("x.spec.ts; rm -rf /")).toBe(false);
    expect(isSafeCheckRelativePath("$(whoami).spec.ts")).toBe(false);
    expect(isSafeCheckRelativePath("x.spec.ts && echo pwned")).toBe(false);
  });

  it("rejects a file that isn't a .spec.ts", () => {
    expect(isSafeCheckRelativePath("team-cash-flow.ts")).toBe(false);
    expect(isSafeCheckRelativePath("team-cash-flow.spec.js")).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    expect(isSafeCheckRelativePath(undefined)).toBe(false);
    expect(isSafeCheckRelativePath(42)).toBe(false);
    expect(isSafeCheckRelativePath(null)).toBe(false);
  });
});

describe("buildCheckCommand: the runner follows the project settings", () => {
  const NONCE = "0123456789abcdef0123456789abcdef";

  it("with no settings: runs Playwright on the repo-relative path under the default checks root", () => {
    resetProjectConfig();
    const cmd = buildCheckCommand(7, "a.spec.ts", NONCE)!;
    expect(cmd).toContain("pnpm exec playwright test e2e/checks/issue-7/a.spec.ts --reporter=line,json");
    expect(cmd).not.toContain("@acme");
    expect(checkDirForIssue(7)).toBe("e2e/checks/issue-7");
  });

  it("with browserCheckCommand: hands the runner the path relative to the checks root's parent", () => {
    setProjectConfig({
      ...defaultProjectConfig(),
      checksRoot: "apps/web/e2e/checks",
      browserCheckCommand: "pnpm --filter web e2e",
    });
    const cmd = buildCheckCommand(7, "a.spec.ts", NONCE)!;
    expect(cmd).toContain("pnpm --filter web e2e checks/issue-7/a.spec.ts --reporter=line,json");
    expect(checkDirForIssue(7)).toBe("apps/web/e2e/checks/issue-7");
  });
});

describe("buildCheckCommand", () => {
  const NONCE = "0123456789abcdef0123456789abcdef";

  it("builds the exact string the sandbox will receive", () => {
    const cmd = buildCheckCommand(911, "team-cash-flow.spec.ts", NONCE);
    expect(cmd).toBe(
      "env CI=1 NO_COLOR=1 FORCE_COLOR=0 " +
        `PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sandcastle-check-${NONCE}.json ` +
        // Issue #925: browser checks also carry the mark file the grading
        // helper appends to, so the host can tell "graded and matched" from
        // "never graded at all". Unit checks have no screen and get neither.
        `SANDCASTLE_GRADE_MARK_FILE=/tmp/sandcastle-graded-${NONCE}.jsonl ` +
        "pnpm --filter @acme/nextjs e2e checks/issue-911/team-cash-flow.spec.ts " +
        "--reporter=line,json" +
        `; __sc_rc=$?; node -e "${[
          "const f=require('fs');",
          "let o=null;",
          `try{o=JSON.parse(f.readFileSync('/tmp/sandcastle-check-${NONCE}.json','utf8'))}catch(e){}`,
          "const s=o&&o.stats;",
          "const n=(x)=>Number.isInteger(x)?x:-1;",
          "const p=s?n(s.expected):n(o&&o.numPassedTests);",
          "const q=s?n(s.unexpected):n(o&&o.numFailedTests);",
          "const k=s?n(s.skipped):n(o&&o.numPendingTests);",
          "const y=s?n(s.flaky):0;",
          `process.stdout.write('\\n${NONCE} sandcastle-run-evidence report='+(o?'ok':'missing')+`,
          "' exit=$__sc_rc passed='+p+' failed='+q+' skipped='+k+' flaky='+y+'\\n')",
        ].join("")}"` +
        `; rm -f /tmp/sandcastle-check-${NONCE}.json` +
        `; node -e "${[
          "const f=require('fs');",
          "let t='';",
          `try{t=f.readFileSync('/tmp/sandcastle-graded-${NONCE}.jsonl','utf8')}catch(e){}`,
          // Only lines that ARE a mark are counted — issue #925. Counting any
          // non-empty line would set the forgery bar at one stray byte. Two
          // record kinds share the file since 2026-09-01, told apart by
          // shape: a grade mark carries a figure, a settled record carries
          // `settled: true` and no figure.
          "const c=(s)=>{try{const o=JSON.parse(s);",
          "if(!o||typeof o.screen!=='string')return 0;",
          "if(typeof o.figure==='string')return 1;",
          "if(o.settled===true)return 2;return 0}",
          "catch(e){return 0}};",
          "const a=t.split('\\n');",
          "const l=a.filter(s=>c(s)===1);",
          "const m=a.filter(s=>c(s)===2);",
          "const e=(x)=>Buffer.from(x.join('\\n'),'utf8')",
          ".subarray(0,600).toString('base64');",
          `process.stdout.write('\\n${NONCE} SC-GRADED graded='+l.length+`,
          `' detail='+e(l)+'\\n${NONCE} SC-SETTLED settled='+m.length+`,
          "' detail='+e(m)+'\\n')",
        ].join("")}"` +
        `; rm -f /tmp/sandcastle-graded-${NONCE}.jsonl` +
        "; exit $__sc_rc",
    );
  });

  it("keeps the line reporter beside the json one — the run log still needs a readable failure", () => {
    const cmd = buildCheckCommand(911, "x.spec.ts", NONCE) ?? "";
    expect(cmd).toContain("--reporter=line,json");
  });

  it("NEVER puts a bare `--` before the spec path — it swallows every flag after it", () => {
    // Regression lock for the 2026-08-06 quarantine of issue #803. Playwright's
    // CLI is a commander program: a bare `--` ends option parsing, so
    // `--reporter=line,json` after it becomes a positional test-filter, no JSON
    // report is written, and a check that CORRECTLY failed is scored
    // `report=missing` → `inconclusive` → `stopped:no-failing-check`. Verified
    // by hand on the loop host: `playwright test -- <dir> --reporter=json
    // --list` ignored BOTH flags (it even started the web server); the same
    // line without `--` emitted JSON and started nothing.
    const cmd = buildCheckCommand(911, "x.spec.ts", NONCE) ?? "";
    expect(cmd).not.toMatch(/\se2e\s+--\s/);
    // And the flags must still land AFTER the spec path, where pnpm forwards
    // them to the runner rather than eating them itself.
    expect(cmd).toContain(
      "pnpm --filter @acme/nextjs e2e checks/issue-911/x.spec.ts --reporter=",
    );
  });

  it("PRESERVES THE RUNNER'S EXIT CODE — `timedOut` inference (exit 124/137) depends on it", () => {
    expect(buildCheckCommand(911, "x.spec.ts", NONCE)).toMatch(/; exit \$__sc_rc$/);
  });

  it("writes the report OUTSIDE the worktree — an untracked file there strands the whole run", () => {
    const cmd = buildCheckCommand(911, "x.spec.ts", NONCE) ?? "";
    expect(cmd).toContain("=/tmp/sandcastle-check-");
    expect(cmd).not.toContain("apps/nextjs/test-results/");
  });

  it("returns undefined rather than interpolating an unsafe path", () => {
    expect(
      buildCheckCommand(911, "../../etc/passwd.spec.ts", NONCE),
    ).toBeUndefined();
    expect(buildCheckCommand(911, "x.spec.ts; rm -rf /", NONCE)).toBeUndefined();
  });

  it("returns undefined rather than interpolating an unsafe nonce — it reaches a shell, a path AND a RegExp", () => {
    expect(buildCheckCommand(911, "x.spec.ts", "")).toBeUndefined();
    expect(buildCheckCommand(911, "x.spec.ts", "; rm -rf /")).toBeUndefined();
    expect(buildCheckCommand(911, "x.spec.ts", "(.*)")).toBeUndefined();
    expect(buildCheckCommand(911, "x.spec.ts", "NOTHEX".repeat(5))).toBeUndefined();
  });
});

describe("hasPreexistingCheckFiles — the host's own observation, not the agent's claim", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is false when the check directory doesn't exist at all", () => {
    expect(hasPreexistingCheckFiles(dir, 911)).toBe(false);
  });

  it("is false when the directory exists but is empty", () => {
    mkdirSync(path.join(dir, checkDirForIssue(911)), { recursive: true });
    expect(hasPreexistingCheckFiles(dir, 911)).toBe(false);
  });

  it("is true once a .spec.ts file is present — proves the instrument on a case that definitely exists", () => {
    const checkDir = path.join(dir, checkDirForIssue(911));
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(path.join(checkDir, "already-here.spec.ts"), "// inherited");
    expect(hasPreexistingCheckFiles(dir, 911)).toBe(true);
  });

  it("finds a spec nested one level deep", () => {
    const nested = path.join(dir, checkDirForIssue(911), "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "deep.spec.ts"), "// nested");
    expect(hasPreexistingCheckFiles(dir, 911)).toBe(true);
  });

  it("a non-spec file alone does not count as a pre-existing check", () => {
    const checkDir = path.join(dir, checkDirForIssue(911));
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(path.join(checkDir, "README.md"), "not a check");
    expect(hasPreexistingCheckFiles(dir, 911)).toBe(false);
  });

  it("a DIFFERENT issue's directory is not seen as this issue's inheritance", () => {
    const checkDir = path.join(dir, checkDirForIssue(1));
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(path.join(checkDir, "unrelated.spec.ts"), "// #1's check");
    expect(hasPreexistingCheckFiles(dir, 911)).toBe(false);
  });
});

// 2026-08-04 review finding #5 (BLOCKER) + issue #916 defect 1: nothing
// verified a check file actually uses the two graded helpers — only its PATH
// was ever validated. `missingGradedHelperCalls` below is now the SOLE
// enforcement point; the two per-helper yes/no predicates that used to sit
// here (`checkFileCallsGradedHelper`, `checkFileCallsGradeScreenText`) had no
// production callers left and were deleted with their tests (2026-08-04 fix
// pass). The assertions worth keeping moved into the suites below.
describe("missingGradedHelperCalls — the single message the check-writer is handed", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-missing-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(body: string): void {
    const checkDir = path.join(dir, checkDirForIssue(911));
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(path.join(checkDir, "team-cash-flow.spec.ts"), body);
  }

  it("is empty when BOTH helpers are imported and called — nothing to complain about", () => {
    write(
      `import { waitForGradableScreen, gradeScreenText } from "../../lib/graded-screen-check";\n` +
        `await waitForGradableScreen(page, {});\n` +
        `await gradeScreenText(page.locator(".x"), "$1");\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      [],
    );
  });

  it("names gradeScreenText when only the wait is present", () => {
    write(
      `import { waitForGradableScreen, gradeScreenText } from "../../lib/graded-screen-check";\n` +
        `await waitForGradableScreen(page, {});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["gradeScreenText"],
    );
  });

  it("names waitForGradableScreen when only the grade is present", () => {
    write(
      `import { waitForGradableScreen, gradeScreenText } from "../../lib/graded-screen-check";\n` +
        `await gradeScreenText(page.locator(".x"), "$1");\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["waitForGradableScreen"],
    );
  });

  it("FAILS CLOSED: an unreadable file is missing BOTH, never silently fine", () => {
    expect(missingGradedHelperCalls(dir, 911, "missing.spec.ts")).toEqual([
      "waitForGradableScreen",
      "gradeScreenText",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2026-08-04 review, BLOCKER 5: the guard's own reasoning rested on the
// must-fail-first proof backstopping a no-op mention, and that backstop does
// NOT hold in the ordinary pre-fix case. Pre-fix the figure does not exist,
// so `waitForGradableScreen` throws inside the WAIT and the run exits
// non-zero — the proof goes red and the receipt is minted without grading
// ever happening. Post-fix the page settles, the claim matches, the only
// `gradeScreenText(` in the file sits inside a comment or a string, Playwright
// exits 0, `classifyHarnessRun` returns `match`, and the ticket ships with the
// wrong number on screen behind a green screen check — the exact failure the
// guard exists to prevent, reached one step earlier.
//
// So the guard now asks for two things per helper, both of which a no-op
// mention fails: the helper must be IMPORTED from the graded-screen-check
// module in this same file, and it must be CALLED in code that is neither a
// comment nor a string literal.
// ---------------------------------------------------------------------------

describe("missingGradedHelperCalls — a mention is not a call (review blocker 5)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-bypass-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(body: string): void {
    const checkDir = path.join(dir, checkDirForIssue(911));
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(path.join(checkDir, "team-cash-flow.spec.ts"), body);
  }

  const IMPORT_LINE =
    `import { waitForGradableScreen, gradeScreenText } from "../../lib/graded-screen-check";\n`;

  it("PROVES THE INSTRUMENT: a real import plus real calls is still accepted", () => {
    write(
      IMPORT_LINE +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      [],
    );
  });

  // Ported from the deleted `checkFileCallsGradeScreenText` suite — the
  // wrong-figure hole issue #916 defect 1 closed, still asserted.
  it("a check that waits with the helper but grades with a bare expect() is refused", () => {
    write(
      `import { waitForGradableScreen } from "../../lib/graded-screen-check";\n` +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  await expect(page.locator(".figure")).toContainText("$1,234");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["gradeScreenText"],
    );
  });

  // Ported from the deleted suites — a hand-rolled wait erases two verdicts.
  it("a hand-rolled wait that never calls the helper is refused", () => {
    write(
      `test("x", async ({ page }) => {\n` +
        `  await page.goto("/finance/reports?view=team");\n` +
        `  await page.waitForTimeout(2000);\n` +
        `  await expect(page.locator(".figure")).toContainText("$1,234");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["waitForGradableScreen", "gradeScreenText"],
    );
  });

  // Ported from the deleted suites — the sentinel is emitted by the CALL, so
  // an import on its own has never been enough.
  it("an IMPORT without a call does not count", () => {
    write(
      IMPORT_LINE +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["gradeScreenText"],
    );
  });

  it("a call commented out with // does NOT count", () => {
    write(
      IMPORT_LINE +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  // await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
        `  await expect(page.locator(".figure")).toContainText("$1,234");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["gradeScreenText"],
    );
  });

  it("a call inside a /* */ block comment does NOT count", () => {
    write(
      IMPORT_LINE +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  /* the old way:\n` +
        `     await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
        `  */\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["gradeScreenText"],
    );
  });

  it("a call quoted inside a string literal does NOT count", () => {
    write(
      IMPORT_LINE +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  console.log("remember to gradeScreenText(locator, expected)");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["gradeScreenText"],
    );
  });

  it("a real call with NO import of the helper does NOT count — a local shadow is not the graded helper", () => {
    // Nothing stops a check file declaring its own `gradeScreenText` that
    // emits no sentinel. Requiring the import is what ties the call to the
    // ONE implementation that emits GRADED_FIGURE_SENTINEL.
    write(
      `import { waitForGradableScreen } from "../../lib/graded-screen-check";\n` +
        `function gradeScreenText(_l: unknown, _e: string) { return; }\n` +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  gradeScreenText(page.locator(".figure"), "$1,234");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["gradeScreenText"],
    );
  });

  it("an import from some OTHER module does not satisfy the requirement", () => {
    write(
      `import { waitForGradableScreen, gradeScreenText } from "./my-own-helpers";\n` +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["waitForGradableScreen", "gradeScreenText"],
    );
  });

  it("an aliased import is refused — the prompt gives one exact call shape", () => {
    write(
      `import { waitForGradableScreen, gradeScreenText as grade } from "../../lib/graded-screen-check";\n` +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  await grade(page.locator(".figure"), "$1,234");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      ["gradeScreenText"],
    );
  });

  it("an import with an explicit .js extension still satisfies the requirement", () => {
    write(
      `import { waitForGradableScreen, gradeScreenText } from "../../lib/graded-screen-check.js";\n` +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      [],
    );
  });

  it("a multi-line import block is read the same as a single-line one", () => {
    write(
      `import {\n` +
        `  waitForGradableScreen,\n` +
        `  gradeScreenText,\n` +
        `} from "../../lib/graded-screen-check";\n` +
        `test("x", async ({ page }) => {\n` +
        `  await waitForGradableScreen(page, { screen: "x" });\n` +
        `  await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
        `});\n`,
    );
    expect(missingGradedHelperCalls(dir, 911, "team-cash-flow.spec.ts")).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// ISSUE #1235: the doubled `issue-<N>/` segment. Unit-level rules for the
// normaliser both `CheckLocation` doors run; the joined-path consequences are
// pinned in `must-fail-first-receipt.test.ts`.
// ---------------------------------------------------------------------------
describe("withoutRedundantIssueDirPrefix (issue #1235)", () => {
  it("drops the prefix when it names THIS issue — the exact #1235 answer", () => {
    expect(
      withoutRedundantIssueDirPrefix(
        1058,
        "issue-1058/cross-team-relist-guard.test.ts",
      ),
    ).toBe("cross-team-relist-guard.test.ts");
  });

  it("leaves a bare filename alone", () => {
    expect(withoutRedundantIssueDirPrefix(1058, "guard.test.ts")).toBe(
      "guard.test.ts",
    );
  });

  it("leaves a legitimate nested path alone", () => {
    expect(
      withoutRedundantIssueDirPrefix(911, "reports/team-cash-flow.spec.ts"),
    ).toBe("reports/team-cash-flow.spec.ts");
  });

  it("leaves ANOTHER issue's directory alone", () => {
    expect(withoutRedundantIssueDirPrefix(1058, "issue-999/guard.test.ts")).toBe(
      "issue-999/guard.test.ts",
    );
    // Not a prefix match on the digits either: issue-10580 is not issue-1058.
    expect(
      withoutRedundantIssueDirPrefix(1058, "issue-10580/guard.test.ts"),
    ).toBe("issue-10580/guard.test.ts");
  });

  it("drops only ONE segment, so a triple prefix still fails the whitelist", () => {
    expect(
      withoutRedundantIssueDirPrefix(
        1058,
        "issue-1058/issue-1058/guard.test.ts",
      ),
    ).toBe("issue-1058/guard.test.ts");
  });

  it("leaves a path that is nothing but the issue directory alone", () => {
    expect(withoutRedundantIssueDirPrefix(1058, "issue-1058/")).toBe(
      "issue-1058/",
    );
  });

  it("is total on hostile input", () => {
    // The signature takes `unknown` on both parameters, like every other
    // runtime-checking neighbour in this folder, so no `@ts-expect-error` is
    // needed to reach the guards.
    expect(withoutRedundantIssueDirPrefix(1058, undefined)).toBeUndefined();
    expect(
      withoutRedundantIssueDirPrefix(1.5, "issue-1.5/guard.test.ts"),
    ).toBe("issue-1.5/guard.test.ts");
    // The genuinely hostile SHAPES, gathered here so the safety argument reads
    // in one place rather than being inferred from the whitelist tests: this
    // function only ever strips one known-redundant segment, and it never
    // launders a traversal, a separator or an anchor into something the
    // whitelist would then accept.
    //
    // A traversal keeps its `..` after the strip, so `isSafeCheckRelativePath`
    // (which refuses any `..`) still refuses it.
    expect(withoutRedundantIssueDirPrefix(1058, "issue-1058/../../x")).toBe(
      "../../x",
    );
    // A backslash is not a separator here — the prefix test is POSIX, so the
    // string is untouched and the whitelist refuses the backslash itself.
    expect(
      withoutRedundantIssueDirPrefix(1058, "issue-1058\\foo.test.ts"),
    ).toBe("issue-1058\\foo.test.ts");
    // A leading slash means the first segment is empty, not `issue-1058`, so
    // nothing is stripped and the whitelist refuses the anchor.
    expect(
      withoutRedundantIssueDirPrefix(1058, "/issue-1058/x.test.ts"),
    ).toBe("/issue-1058/x.test.ts");
    // The empty string has no prefix to drop and comes back as it went in.
    expect(withoutRedundantIssueDirPrefix(1058, "")).toBe("");
  });
});

describe("CheckWriterMissingGradedHelperError — the inner cause sentence", () => {
  it("composes `name(...) call(s)` from the helper names by default", () => {
    const err = new CheckWriterMissingGradedHelperError({
      message: "check-writer-missing-graded-helper: …",
      missingHelpers: ["waitForGradableScreen", "gradeScreenText"],
      rawText: "{}",
    });
    expect(err.cause.message).toBe(
      "missing waitForGradableScreen(...), gradeScreenText(...) call(s)",
    );
  });

  // #1235. The missing-file arm carries a REQUIREMENT, not a helper name, and
  // the default composition turned it into `missing exist at all — no file was
  // found at that path in the worktree(...) call(s)` — a broken sentence, in
  // the one run log this whole fix exists to make readable.
  it("uses the caller's own sentence when one is given, and keeps the class", () => {
    const err = new CheckWriterMissingGradedHelperError({
      message: "check-writer-check-file-missing: …",
      missingHelpers: [
        "exist at all — no file was found at that path in the worktree",
      ],
      causeMessage:
        "no check file at packages/api/src/__checks__/issue-1058/guard.test.ts",
      rawText: "{}",
    });
    expect(err.cause.message).toBe(
      "no check file at packages/api/src/__checks__/issue-1058/guard.test.ts",
    );
    expect(err.cause.message).not.toContain("(...) call(s)");
    // The briefed-retry ladder and the quarantine road both key off this
    // `instanceof`, so the new option must not have moved the class.
    expect(err).toBeInstanceOf(CheckWriterMissingGradedHelperError);
    expect(err.missingHelpers).toEqual([
      "exist at all — no file was found at that path in the worktree",
    ]);
  });
});
