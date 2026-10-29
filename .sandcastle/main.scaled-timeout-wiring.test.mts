/**
 * ROT-GUARD (issue #1176, review finding 7): the CONTRACT tests in
 * `lib/harness/scaled-timeout-budget.test.ts` and
 * `lib/harness/timeout-budget-contract.test.ts` pin `scaledCheckTimeoutBudgetMs`
 * itself — pass it a scaled value explicitly and it returns the right budget.
 * Neither one proves that `main.mts`'s own call sites actually COMPUTE a
 * scaled value rather than a hardcoded one, or that a refactor could not
 * silently drop the wiring while every contract test keeps passing. This file
 * reads `main.mts` as TEXT and pins that each of the four places a check's
 * time budget is decided actually calls `scaledCheckTimeoutBudgetMs`, the
 * same grep-style approach `main.test.mts`'s "telemetry call-site rot-guard"
 * and `lib/git/identity.test.ts` use for the same class of silent-drop risk.
 *
 * The four sites, and what each threads in as the scenario count:
 *
 *   1. `buildDefaultDeps().runScreenCheckHarness` — the SHIP-TIME re-run,
 *      scaled by `opts.testCount` (now `effectiveCheckTestCount`'s answer,
 *      threaded in by the caller — review finding 4).
 *   2. `runCheckWriterStage`'s must-fail-first proof — scaled by a fresh
 *      static read (`staticTestCount`), since no proof tally exists yet.
 *   3. The must-fail-first RE-RUN (`rerunInconclusiveProof`, when the first
 *      attempt came back inconclusive) — same static-read scaling.
 *   4. `proveFirstTestRewrite`'s `runFrozen` — the first test's one
 *      rewrite (spec #1334), scaled by a static read of the check as
 *      REWRITTEN, never capped below the ordinary ceiling (#1176 review
 *      finding 1). It replaced the judge's `repairCheckAfterBuilder`.
 *
 * A failure here does not necessarily mean a bug: a call site's own variable
 * names can legitimately change. It means the text needle below no longer
 * matches, which is exactly the signal to go re-verify the site still calls
 * the real function before updating the needle.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(path.join(import.meta.dirname, "main.mts"), "utf8");

/** Non-overlapping occurrences of a literal needle in main.mts. */
function count(needle: string): number {
  return SRC.split(needle).length - 1;
}

describe("scaledCheckTimeoutBudgetMs is actually wired into every site that decides a check's time budget", () => {
  it("site 1 — buildDefaultDeps().runScreenCheckHarness (the ship-time re-run) scales by the caller's own testCount", () => {
    expect(count("scaledCheckTimeoutBudgetMs(opts.kind, opts.testCount)")).toBe(1);
  });

  it("site 2 — the must-fail-first proof (runCheckWriterStage) scales by a fresh static read", () => {
    expect(count("scaledCheckTimeoutBudgetMs(checkKind, staticTestCount)")).toBe(1);
  });

  it("site 3 — the must-fail-first RE-RUN (rerunInconclusiveProof) scales by a fresh static read", () => {
    expect(count("scaledCheckTimeoutBudgetMs(kind, staticTestCount)")).toBe(1);
  });

  it("site 4 — the first-test rewrite's runFrozen (spec #1334) scales by a static read of the REWRITTEN check, with no per-round ceiling override (this call must NOT pass a third argument)", () => {
    expect(SRC).toMatch(
      /scaledCheckTimeoutBudgetMs\(\s*location\.kind,\s*countCheckScenarios\(\s*rewrittenFreeze\./,
    );
    // The old per-round starvation cap must not come back as a live constant.
    expect(SRC).not.toMatch(/export const REPAIR_ROUND_TIMEOUT_CEILING_MS/);
  });

  it("site 5 — the older-test check (verifyOlderTestEdits, spec #1334 SH) scales each red/green run by a static read of the file it runs, and keeps no worst-case pre-check (spec #1366)", () => {
    expect(
      count(
        "scaledCheckTimeoutBudgetMs(check.location.kind, countCheckScenarios(bytes))",
      ),
    ).toBe(1);
  });

  it("exactly five occurrences of `scaledCheckTimeoutBudgetMs(` exist in main.mts — the five call sites above. Spec #1334 deleted the judge's repair (its running-total round budget), the sibling-check road's red and green runs, and the worked-arithmetic doc example; slice SH added the older-test check's run; spec #1366 deleted its worst-case pre-check. A count that drifts means a real call site was added or removed without this file being told", () => {
    const total = count("scaledCheckTimeoutBudgetMs(");
    expect(total).toBe(5);
  });
});

/**
 * ROT-GUARD (issue #1227): WHICH ship call site may hand over the proof run's
 * own scenario tally, and which must not.
 *
 * The tally (`checkTestCount`) is fed to `effectiveCheckTestCount`, which takes
 * the LARGER of it and a fresh static read of the check actually shipping. So a
 * wrong tally can never SHRINK a budget — but it can be wrong in the other
 * direction two ways, and the pairing below is what keeps both closed:
 *
 *   - A site that ships the SAME check the proof counted and omits the tally
 *     falls back to the static read alone. That read weights a `test.each(`
 *     table as a flat 3 no matter how many rows it has, so a 10-row check ships
 *     with a 15-minute window where the identical file gets 43 minutes on the
 *     first-pass road. That was the live state of two sites until #1227.
 *   - A site that ships a REPAIRED check — different bytes, which the proof
 *     never counted — must NOT hand over the old tally. `repairedCheck`
 *     carries no tally of its own, and the field's own doc rules out a count
 *     measured against another file.
 *
 * So this pins the RULE, not the literals: the check's identity and its tally
 * must come from the same place. A sixth call site wired the wrong way round
 * fails here even though it would compile and every other test would pass.
 *
 * ## Where the rule lives since spec #1334 SG
 *
 * There used to be seven `await shipAfterMigrations(ctx, sandbox, {` call
 * sites, each building its own argument object. SG put the builder's and the
 * fixer's review rounds behind ONE function, `runReviewRounds`, which builds
 * every ship-gate input and hands it back; the pipeline and the fixer each
 * make exactly one call, passing that input through untouched. So the rule is
 * now pinned where the inputs are BUILT: every object literal in
 * `runReviewRounds` that names a check command must take its tally from the
 * same place.
 *
 * And the TOTAL number of `shipAfterMigrations(` occurrences is pinned, which
 * no spelling of a call can escape: a new call site that builds its own input
 * inline fails here no matter how it is written, and whoever adds it has to
 * come here and say so.
 *
 * `runIssuePipeline` is not exported, so this reads `main.mts` as TEXT — the
 * same approach `main.first-test-fallthrough-wiring.test.mts` takes, and for
 * the same reason. A failure is not proof of a bug; it means a site no longer
 * matches, which is the signal to go read the site before touching this file.
 */
describe("a ship call site's check tally comes from the same place as its check (issue #1227)", () => {
  const roundsStart = SRC.indexOf("async function runReviewRounds(");
  const roundsBody = SRC.slice(roundsStart, SRC.indexOf("\nasync function ", roundsStart + 10));
  // Since the spec #1334 fix pass, every ship input and every reviewer's
  // evidence read ONE helper, `firstTest()`, which is `currentFirstTest` in
  // `lib/pipeline/first-test.ts`: the check stage's test, or the proved
  // rewrite once there is one. The rule is pinned inside that function.
  const FIRST_TEST_SRC = readFileSync(
    path.join(import.meta.dirname, "lib/pipeline/first-test.ts"),
    "utf8",
  );
  const helper = FIRST_TEST_SRC.slice(FIRST_TEST_SRC.indexOf("export function currentFirstTest("));
  const [ordinaryArm, rewrittenArm] = helper
    .split("if (rewritten === undefined) {")[1]!
    .split("return {\n    checkPath: posix.join(");

  it("the review rounds build exactly ONE ship input, and it reads the first test from `firstTest()`", () => {
    expect(roundsStart).toBeGreaterThan(-1);
    expect([...roundsBody.matchAll(/checkWriterCheckCommand:\s*(\w+)\./g)].map((m) => m[1])).toEqual([
      "test",
    ]);
    expect(roundsBody).toContain("const test = firstTest();");
    expect(roundsBody).toContain("currentFirstTest(checkStage, ctx.rewrittenFirstTest)");
    expect(roundsBody).toContain("checkTestCount: test.checkTestCount,");
  });

  it("exactly three occurrences of `shipAfterMigrations(` exist in main.mts — the one declaration and the two running call sites (the builder's and the fixer's), both passing the review rounds' own input through untouched. Pinning the total is what forces a new site to be told about", () => {
    expect(count("shipAfterMigrations(")).toBe(3);
    // Reconciliation for a future reader who greps the BARE name and gets a
    // much larger number: main.mts's prose refers to this function dozens of
    // times without a paren. Only the parenthesised form is a declaration or
    // a call, which is why the needle above carries one.
    expect(count("export async function shipAfterMigrations(")).toBe(1);
    expect(count("await shipAfterMigrations(ctx, sandbox, rounds.ship)")).toBe(1);
    expect(count("await shipAfterMigrations(ctx, sb, rounds.ship)")).toBe(1);
  });

  it("main.mts never spreads the test fixture's SHIP_INPUT_DEFAULTS — the rule `__fixtures__/ship-input.mts` states in its own doc (\"Never spread this into production code\") and that nothing else enforces. A running call site that spread the defaults would be handed every field it forgot, which is the exact silent omission issue #1227 made every field required to stop", () => {
    expect(count("...SHIP_INPUT_DEFAULTS")).toBe(0);
    // Not an import, either — production code has no reason to reach for it,
    // and an import is the step before a spread.
    expect(SRC).not.toMatch(/import[^;]*SHIP_INPUT_DEFAULTS/);
    // Deliberately NOT "main.mts never mentions the name": it mentions it
    // once, on purpose, in `ShipAfterMigrationsInput`'s own doc comment, to
    // point a reader at where the 48 test sites get their fields. That
    // cross-reference is worth keeping, so the rule pinned here is the one
    // the fixture actually states — never SPREAD, not never NAME.
    expect(count("SHIP_INPUT_DEFAULTS")).toBe(1);
  });

  it("the check stage's own test carries the proof's tally — the same check the proof counted", () => {
    expect(ordinaryArm).toContain("checkCommand: accepted.checkCommand,");
    expect(ordinaryArm).toContain("checkTestCount: accepted.checkTestCount,");
  });

  it("a proved rewrite carries NO tally — different bytes, which the proof never counted", () => {
    expect(rewrittenArm).toContain("checkCommand: rewritten.checkCommand,");
    expect(rewrittenArm).toMatch(/checkTestCount: undefined,/);
    expect(rewrittenArm).not.toContain("accepted.checkTestCount");
  });
});
