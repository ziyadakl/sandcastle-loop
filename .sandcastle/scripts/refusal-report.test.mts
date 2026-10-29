/**
 * The refusal report's pure halves: argv (`--last`), run grouping, and the
 * rendered wording (issue #1096). The GitHub read is `countRefusals`, tested
 * beside its own code in `lib/state/gh.refusal.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { RefusalRow } from "../lib/state/gh.js";
import { groupByRun, parseLast, renderRefusalReport } from "./refusal-report.mts";

const row = (o: Partial<RefusalRow> & Pick<RefusalRow, "issue" | "outcome">): RefusalRow => ({
  runId: undefined,
  whenIso: undefined,
  ...o,
});

describe("parseLast", () => {
  it("returns undefined when --last is absent", () => {
    expect(parseLast([])).toBeUndefined();
  });
  it("reads a positive integer", () => {
    expect(parseLast(["--last", "3"])).toBe(3);
  });
  it("throws on a non-number, per the exit-code contract", () => {
    expect(() => parseLast(["--last", "soon"])).toThrow();
    expect(() => parseLast(["--last", "0"])).toThrow();
  });
});

describe("groupByRun — newest run first", () => {
  it("orders runs by their latest timestamp, dated runs before undated", () => {
    const groups = groupByRun([
      row({ issue: 1, outcome: "wrong", runId: "old", whenIso: "2026-08-01T00:00:00Z" }),
      row({ issue: 2, outcome: "correct", runId: "new", whenIso: "2026-08-20T00:00:00Z" }),
      row({ issue: 3, outcome: "unjudged" }),
    ]);
    expect(groups.map((g) => g.runId)).toEqual(["new", "old", "(run not recorded)"]);
  });
});

describe("renderRefusalReport", () => {
  it("prints the wrong count beside its denominator (judged refusals)", () => {
    const out = renderRefusalReport([
      row({ issue: 1, outcome: "wrong", runId: "n1", whenIso: "2026-08-11T00:00:00Z" }),
      row({ issue: 2, outcome: "wrong", runId: "n1", whenIso: "2026-08-11T00:01:00Z" }),
      row({ issue: 3, outcome: "correct", runId: "n1", whenIso: "2026-08-11T00:02:00Z" }),
    ]);
    // 2 of 3 judged were wrong.
    expect(out).toContain("3 refusals judged so far, 2 were wrong — 67%");
  });

  it("says there is no rate rather than a rate of zero when nothing is judged", () => {
    const out = renderRefusalReport([row({ issue: 1, outcome: "unjudged", runId: "n1" })]);
    expect(out).toContain("no error rate to read off this — not a rate of zero");
    expect(out).toContain("#1");
  });

  it("--last N restricts to the N most recent runs", () => {
    const rows = [
      row({ issue: 1, outcome: "wrong", runId: "old", whenIso: "2026-08-01T00:00:00Z" }),
      row({ issue: 2, outcome: "wrong", runId: "new", whenIso: "2026-08-20T00:00:00Z" }),
    ];
    const out = renderRefusalReport(rows, { last: 1 });
    // Only the newest run's single refusal is in scope.
    expect(out).toContain("1 refusal(s)");
    expect(out).toContain("new:");
    expect(out).not.toContain("old:");
  });

  it("names the ambiguous bucket only when it is non-empty", () => {
    const clean = renderRefusalReport([row({ issue: 1, outcome: "correct", runId: "n1" })]);
    expect(clean).not.toContain("ambiguous");
    const messy = renderRefusalReport([row({ issue: 1, outcome: "ambiguous", runId: "n1" })]);
    expect(messy).toContain("ambiguous");
  });
});
