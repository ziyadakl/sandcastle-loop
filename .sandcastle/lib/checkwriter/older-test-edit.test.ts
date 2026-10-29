/**
 * Spec #1334 SH — the pure half of the ship gate's older-test rule: which
 * touched files are an older ticket's test, and whether an edit to one keeps
 * its case count and switches nothing off. The graded red/green runs are
 * pinned end to end in `main.older-test-edit.scripted.test.mts`.
 */
import { describe, expect, it } from "vitest";

import {
  countConditionalCases,
  countTestCases,
  MAX_OLDER_TICKETS_EDITED,
  olderCheckAt,
  planOlderTestEdits,
} from "./older-test-edit.js";

/** Where #1058's check really lives. */
const OLDER = "packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts";
const RECEIPT = "packages/api/src/__checks__/issue-1058/must-fail-first-proof.json";
const BROWSER = "apps/nextjs/e2e/checks/issue-819/cross-team-rate-cell-delete.spec.ts";

const TWO_CASES = `it("a", () => {});\nit("b", () => {});\n`;

describe("olderCheckAt", () => {
  it("resolves a unit test file to its ticket, package and location", () => {
    const c = olderCheckAt(OLDER);
    expect(c?.issueNumber).toBe(1058);
    expect(c?.packageDir).toBe("packages/api");
    expect(c?.location.kind).toBe("unit");
  });

  it("resolves a browser test file", () => {
    const c = olderCheckAt(BROWSER);
    expect(c?.issueNumber).toBe(819);
    expect(c?.location.kind).toBe("browser");
  });

  it("answers undefined for anything else in a check folder, ordinary source, `..`, and junk", () => {
    expect(olderCheckAt(RECEIPT)).toBeUndefined();
    expect(olderCheckAt("packages/api/src/router/deals.ts")).toBeUndefined();
    expect(
      olderCheckAt("packages/api/src/__checks__/issue-1058/../x.test.ts"),
    ).toBeUndefined();
    expect(olderCheckAt(undefined as unknown as string)).toBeUndefined();
  });
});

describe("planOlderTestEdits", () => {
  const plan = (
    touched: { path: string; before?: string; after?: string }[],
    preauthorizedDeletions: string[] = [],
  ) =>
    planOlderTestEdits({
      touched: touched.map((t) => ({ path: t.path, before: t.before, after: t.after })),
      preauthorizedDeletions,
    });

  it("allows an in-place edit that keeps every case, and hands it back to be run", () => {
    const p = plan([{ path: OLDER, before: TWO_CASES, after: TWO_CASES.replace('"a"', '"a2"') }]);
    expect(p.ok).toBe(true);
    expect(p.ok && p.edited.map((c) => c.path)).toEqual([OLDER]);
  });

  it("refuses an ADDED file", () => {
    const p = plan([{ path: OLDER, after: TWO_CASES }]);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.because).toMatch(/ADDS/);
  });

  it("refuses a DELETED file unless the ticket's own text authorised it", () => {
    expect(plan([{ path: OLDER, before: TWO_CASES }]).ok).toBe(false);
    const allowed = plan([{ path: OLDER, before: TWO_CASES }], [OLDER]);
    expect(allowed).toEqual({ ok: true, edited: [], deleted: [OLDER] });
  });

  it("refuses an edit to anything in the older check folder that is not the test file — the receipt is named", () => {
    const p = plan([
      { path: OLDER, before: TWO_CASES, after: TWO_CASES },
      { path: RECEIPT, before: "{}", after: '{"x":1}' },
    ]);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.paths).toEqual([RECEIPT]);
    expect(!p.ok && p.because).toContain(RECEIPT);
  });

  it("refuses a changed case count, either way", () => {
    expect(plan([{ path: OLDER, before: TWO_CASES, after: `it("a", () => {});\n` }]).ok).toBe(false);
    expect(
      plan([{ path: OLDER, before: TWO_CASES, after: `${TWO_CASES}it("c", () => {});\n` }]).ok,
    ).toBe(false);
  });

  it("refuses a newly skipped case, and a new skipIf / runIf", () => {
    const skipped = `it.skip("a", () => {});\nit("b", () => {});\n`;
    expect(plan([{ path: OLDER, before: TWO_CASES, after: skipped }]).ok).toBe(false);
    const skipIf = `it.skipIf(true)("a", () => {});\nit("b", () => {});\n`;
    const p = plan([{ path: OLDER, before: TWO_CASES, after: skipIf }]);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.because).toMatch(/skipIf/);
    const runIf = `it.runIf(false)("a", () => {});\nit("b", () => {});\n`;
    expect(plan([{ path: OLDER, before: TWO_CASES, after: runIf }]).ok).toBe(false);
  });

  it("refuses an edit that UN-skips a case — the live count still moves", () => {
    const skipped = `it.skip("a", () => {});\nit("b", () => {});\n`;
    const unskipped = `it("a", () => {});\nit("b", () => {});\n`;
    // Un-skipping turns a disabled case live: the live count rises, which is
    // still a count change and refused — an older test may only be edited in
    // what a case asserts.
    expect(plan([{ path: OLDER, before: skipped, after: unskipped }]).ok).toBe(false);
  });

  it(`refuses edits to more than ${MAX_OLDER_TICKETS_EDITED} older tickets`, () => {
    const many = [1, 2, 3, 4].map((n) => ({
      path: `packages/api/src/__checks__/issue-${n}/x.test.ts`,
      before: TWO_CASES,
      after: TWO_CASES,
    }));
    expect(plan(many).ok).toBe(false);
    expect(plan(many.slice(0, 3)).ok).toBe(true);
  });

  it("answers an empty plan on nothing", () => {
    expect(plan([])).toEqual({ ok: true, edited: [], deleted: [] });
  });
});

describe("countConditionalCases", () => {
  it("counts skipIf and runIf anywhere in a chain", () => {
    expect(
      countConditionalCases(
        `describe.skipIf(!RUN)("x", () => {\n  it.runIf(a)("y", () => {});\n});\n`,
      ),
    ).toBe(2);
    expect(countConditionalCases(TWO_CASES)).toBe(0);
  });
});

describe("countTestCases", () => {
  it("counts plain `it(` and `test(` cases", () => {
    const src = [
      "import { describe, it, test } from 'vitest';",
      "describe('x', () => {",
      "  it('a', () => {});",
      "  test('b', () => {});",
      "});",
    ].join("\n");
    expect(countTestCases(src)).toEqual({ cases: 2, disabled: 0 });
  });

  it("counts a skipped, todo or failing case as DISABLED, never as a live case", () => {
    const src = [
      "  it('a', () => {});",
      "  it.skip('b', () => {});",
      "  test.todo('c');",
      "  it.fails('d', () => {});",
    ].join("\n");
    // `it.skip(` is not `it(`, so turning a live case into a skipped one shows
    // up TWICE — one fewer case and one more disabled — and either alone is
    // enough for `siblingRepairVerdict` to refuse.
    expect(countTestCases(src)).toEqual({ cases: 1, disabled: 3 });
  });

  it("ignores an `it(` that is not at the start of its line", () => {
    // The regex is line-anchored on purpose: a mention inside a string or a
    // comment tail must not inflate the count the verdict compares.
    const src = [
      "// see it('a') above",
      "const s = \"it('b', () => {})\";",
      "  it('c', () => {});",
    ].join("\n");
    expect(countTestCases(src)).toEqual({ cases: 1, disabled: 0 });
  });

  it("answers zeros rather than throwing on junk", () => {
    expect(countTestCases("" as string)).toEqual({ cases: 0, disabled: 0 });
    expect(countTestCases(null as never)).toEqual({ cases: 0, disabled: 0 });
  });

  it("counts every vitest call form once, not only the bare `it(`", () => {
    // The counts used to read `it(` / `test(` LITERALLY, so each of these four
    // lines counted zero — and a file written entirely in them could have had
    // every case deleted under a verdict that saw nothing move.
    const src = [
      "  it.each([1, 2])('a %s', () => {});",
      "  it.concurrent('b', () => {});",
      "  test.skipIf(process.env.CI)('c', () => {});",
      "  it.runIf(true)('d', () => {});",
    ].join("\n");
    expect(countTestCases(src)).toEqual({ cases: 4, disabled: 0 });
  });

  it("counts a tagged-template `it.each` table as a case", () => {
    const src = ["  it.each`", "    a | b", "  `('a', () => {});"].join("\n");
    expect(countTestCases(src)).toEqual({ cases: 1, disabled: 0 });
  });

  it("keeps `skipIf` and `runIf` LIVE — a conditional case ordinarily runs", () => {
    // The disabling names end on a word boundary for exactly this reason: read
    // as a prefix, `skipIf` would count as a skip and a live case would land on
    // the wrong side of the verdict in both directions at once.
    const src = [
      "  it.skipIf(false)('a', () => {});",
      "  test.runIf(true)('b', () => {});",
    ].join("\n");
    expect(countTestCases(src)).toEqual({ cases: 2, disabled: 0 });
  });

  it("counts `describe.skip(` and `describe.only(` as disabled, never as live cases", () => {
    // A `describe.skip(` switches every case inside its block off while those
    // cases' own `it(` lines keep counting exactly as they did. Both counts
    // must not be allowed to sit still through that.
    const src = [
      "describe.skip('gone', () => {",
      "  it('a', () => {});",
      "});",
      "describe.only('the only block that runs', () => {",
      "  it('b', () => {});",
      "});",
    ].join("\n");
    expect(countTestCases(src)).toEqual({ cases: 2, disabled: 2 });
  });

  it("counts `it.only(` as disabled — it switches every OTHER case off", () => {
    const src = ["  it('a', () => {});", "  it.only('b', () => {});"].join("\n");
    expect(countTestCases(src)).toEqual({ cases: 1, disabled: 1 });
  });

  it("counts a disabling modifier anywhere in the chain", () => {
    const src = ["  it.skip.each([1])('a %s', () => {});"].join("\n");
    expect(countTestCases(src)).toEqual({ cases: 0, disabled: 1 });
  });

  it("does not count a plain `describe(` as a case at all", () => {
    const src = ["describe('a group is not a case', () => {", "});"].join("\n");
    expect(countTestCases(src)).toEqual({ cases: 0, disabled: 0 });
  });
});

