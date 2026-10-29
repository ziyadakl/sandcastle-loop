/**
 * Tests for the presentation half of the rework report.
 *
 * What is at stake here is presentation, and one presentation bug is worse than
 * all the others: rendering a `null` rework rate as `0%`. An issue shipped
 * yesterday that nothing has touched has not scored well — nothing has had time
 * to go wrong. If the report says "0%" the reader draws exactly the wrong
 * conclusion, so the assertions below check the rendered STRING, not the model.
 *
 * The second class this file guards is DISAGREEMENT: the bucket a row is
 * printed in must be the bucket the summary counted it in. Those assertions
 * pair a `bucketRows` result against the aggregate from the same input.
 *
 * Scoring policy itself is Part 2's and is tested in `rework-rate.test.ts`.
 */
import { describe, expect, it } from "vitest";

import type { RenderInput, ReworkReportJson, Row } from "./rework-render.js";
import type { ReworkRecord } from "./rework-store.js";
import { flattenModels } from "./rework-projection.js";
import { DEFAULT_REWORK_WINDOW_DAYS, scoreRework } from "./rework-rate.js";
import {
  basisSplit,
  bucketRows,
  buildJson,
  formatCost,
  formatPercent,
  renderReport,
  sortWorstFirst,
} from "./rework-render.js";

const NOW = "2026-08-01T00:00:00.000Z";

function record(over: Partial<ReworkRecord> = {}): ReworkRecord {
  return {
    schemaVersion: 1,
    issueNumber: 1,
    runId: "run-a",
    hostId: "mac",
    shippedAtIso: "2026-07-01T00:00:00.000Z",
    shippedSha: "a".repeat(40),
    outcome: "shipped",
    ...over,
  };
}

/**
 * Build the render input the way `run()` does, so the coupling is exercised.
 *
 * `outcome` is passed exactly as `run` passes it — omitting it would send every
 * record down the scorer's excluded path and quietly empty each table these
 * tests assert on, which is a failure mode worth reproducing here rather than
 * discovering in the report.
 *
 * `modes` overrides the per-record history basis; anything unnamed is
 */
function renderInputFor(
  records: readonly ReworkRecord[],
  later: Record<
    number,
    Parameters<typeof scoreRework>[0][number]["laterCommits"]
  >,
  modes: Record<number, Row["mode"]> = {},
): RenderInput {
  const inputs = records.map((r) => ({
    record: {
      issueNumber: r.issueNumber,
      shippedAtIso: r.shippedAtIso,
      shippedSha: r.shippedSha,
      changedFilePaths: r.changedFilePaths,
      runId: r.runId,
      outcome: r.outcome,
      ...(flattenModels(r.models) === undefined
        ? {}
        : { models: flattenModels(r.models) }),
    },
    laterCommits: later[r.issueNumber] ?? [],
  }));
  const report = scoreRework(inputs, { nowIso: NOW });
  const rows: Row[] = report.issues.map((score, i) => ({
    score,
    record: records[i]!,
    mode: modes[score.issueNumber] ?? ("ancestry" as const),
  }));
  return {
    storePath: "/repo/.sandcastle/telemetry/issues.jsonl",
    repoRoot: "/repo",
    windowDays: DEFAULT_REWORK_WINDOW_DAYS,
    skippedLines: 0,
    futureVersionLines: 0,
    duplicateLines: 0,
    recordCount: records.length,
    report,
    rows,
    unreadable: [],
  };
}
describe("formatting", () => {
  it("never rounds a real, nonzero rate down to 0%", () => {
    expect(formatPercent(1 / 300)).toBe("<1%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.5)).toBe("50%");
  });

  it("keeps absent, unpriced and measured cost distinguishable", () => {
    expect(formatCost(undefined)).toBe("not measured");
    expect(formatCost(null)).toBe("unpriced");
    expect(formatCost(1.5)).toBe("$1.50");
  });
});

describe("sortWorstFirst", () => {
  it("puts the highest rate first and breaks ties deterministically", () => {
    const mk = (issueNumber: number, reworkRate: number): Row => ({
      score: {
        issueNumber,
        totalFileCount: 4,
        reworkedFileCount: Math.round(reworkRate * 4),
        reworkRate,
        daysToFirstRework: 1,
        insufficientData: false,
        excludedByOutcome: false,
        reworkedFilePaths: [],
        windowEndsAtIso: null,
      },
      record: record({ issueNumber }),
      mode: "ancestry",
    });
    expect(
      sortWorstFirst([mk(1, 0.25), mk(2, 1), mk(3, 0.5)]).map(
        (r) => r.score.issueNumber,
      ),
    ).toEqual([2, 3, 1]);
  });
});

describe("renderReport — the insufficient-data row", () => {
  // THE assertion this file exists for.
  const shippedYesterday = record({
    issueNumber: 42,
    shippedAtIso: "2026-07-31T00:00:00.000Z",
    changedFilePaths: ["src/a.ts", "src/b.ts"],
    costUsd: 2.5,
    models: { implementer: { default: "claude-sonnet-5", escalations: [] } },
  });

  it("says 'not enough time elapsed' and never prints 0% for it", () => {
    const input = renderInputFor([shippedYesterday], {});
    const text = renderReport(input);

    expect(input.report.issues[0]?.reworkRate).toBeNull();
    expect(input.report.issues[0]?.insufficientData).toBe(true);
    expect(text).toContain("NOT ENOUGH TIME ELAPSED");
    expect(text).toContain("not enough time elapsed");
    // Zero files were reworked, so a naive formatter would print "0%" here.
    expect(text).not.toContain("0%");
    expect(text).not.toContain("%");
  });

  it("keeps it out of the scored table entirely", () => {
    const text = renderReport(renderInputFor([shippedYesterday], {}));
    const scoredSection = text.slice(
      text.indexOf("SCORED"),
      text.indexOf("NOT ENOUGH TIME ELAPSED"),
    );
    expect(scoredSection).not.toContain("#42");
  });

  it("is excluded from the aggregate's numerator AND denominator", () => {
    const input = renderInputFor([shippedYesterday], {});
    expect(input.report.overall.scoredIssueCount).toBe(0);
    expect(input.report.overall.totalFileCount).toBe(0);
    expect(input.report.overall.insufficientDataCount).toBe(1);
    expect(renderReport(input)).toContain("1 issue(s) still inside the window");
  });
});

describe("renderReport — a real score", () => {
  const shipped = record({
    issueNumber: 7,
    shippedAtIso: "2026-07-01T00:00:00.000Z",
    changedFilePaths: ["src/a.ts", "src/b.ts"],
    costUsd: 4,
    models: {
      implementer: { default: "claude-sonnet-5", escalations: [] },
      reviewer: { default: "claude-haiku-4-5", escalations: [] },
    },
  });
  const later = {
    7: [
      {
        sha: "b".repeat(40),
        dateIso: "2026-07-03T00:00:00.000Z",
        message: "fix: correct the thing",
        files: ["src/a.ts"],
      },
    ],
  };

  it("prints the rate, the implementer model and the cost", () => {
    const text = renderReport(renderInputFor([shipped], later));
    expect(text).toContain("#7");
    expect(text).toContain("50%");
    expect(text).toContain("2.0d");
    expect(text).toContain("$4.00");
    expect(text).toContain("claude-sonnet-5");
  });

  it("labels the aggregate's days-to-rework 'earliest', never 'average'", () => {
    const text = renderReport(renderInputFor([shipped], later));
    expect(text).toContain("earliest rework");
    expect(text).toContain("MINIMUM days-to-first-rework");
    // The ONLY place the word may appear is the disclaimer denying it.
    expect(text).toContain("not an average");
    expect(text.toLowerCase().split("average")).toHaveLength(2);
  });

  it("warns that byModel groups do not sum to overall", () => {
    const text = renderReport(renderInputFor([shipped], later));
    // The ladder names two models, so this one issue is in BOTH groups.
    expect(text).toContain("claude-haiku-4-5");
    expect(text).toContain("do NOT sum to OVERALL");
    expect(text).toContain("in ANY role");
  });
});

describe("bucketRows", () => {
  it("matches aggregateRework's precedence: insufficient wins over zero-file", () => {
    const input = renderInputFor(
      [
        // Shipped yesterday AND no files — must land in ONE bucket, the same
        // one the aggregate counts it in.
        record({ issueNumber: 9, shippedAtIso: "2026-07-31T00:00:00.000Z" }),
      ],
      {},
    );
    const buckets = bucketRows(input.rows);
    expect(buckets.insufficient).toHaveLength(1);
    expect(buckets.zeroFile).toHaveLength(0);
    expect(buckets.excluded).toHaveLength(0);
    expect(input.report.overall.insufficientDataCount).toBe(1);
    expect(input.report.overall.zeroFileIssueCount).toBe(0);
  });

  it("matches it for the FOURTH bucket too: outcome wins over insufficient", () => {
    // The case the table and the summary can disagree about. A quarantined
    // issue shipped yesterday is BOTH excluded-by-outcome and inside its
    // window; if the table filed it under "not enough time elapsed" while the
    // aggregate counted it as excluded, the report would contradict itself —
    // and it would tell the reader to "give this ticket more time" for a ticket
    // that will never be scoreable at all.
    const input = renderInputFor(
      [
        record({
          issueNumber: 9,
          outcome: "quarantined",
          shippedAtIso: "2026-07-31T00:00:00.000Z",
          changedFilePaths: ["src/a.ts"],
        }),
      ],
      {},
    );
    const buckets = bucketRows(input.rows);
    expect(buckets.excluded).toHaveLength(1);
    expect(buckets.insufficient).toHaveLength(0);
    expect(buckets.zeroFile).toHaveLength(0);
    expect(buckets.scored).toHaveLength(0);
    expect(input.report.overall.excludedByOutcomeCount).toBe(1);
    expect(input.report.overall.insufficientDataCount).toBe(0);
  });

  it("excludes a needs-human and an UNRECORDED outcome on the same terms", () => {
    const input = renderInputFor(
      [
        record({
          issueNumber: 1,
          outcome: "needs-human",
          changedFilePaths: ["src/a.ts"],
        }),
        // An absent outcome states "we do not know how this issue left". An
        // unknown is not a pass.
        {
          ...record({ issueNumber: 2, changedFilePaths: ["src/b.ts"] }),
          outcome: undefined,
        } as unknown as ReworkRecord,
      ],
      {},
    );
    expect(bucketRows(input.rows).excluded).toHaveLength(2);
    expect(input.report.overall.excludedByOutcomeCount).toBe(2);
    expect(input.report.overall.scoredIssueCount).toBe(0);
  });
});

describe("renderReport — work that never landed", () => {
  const quarantined = record({
    issueNumber: 11,
    outcome: "quarantined",
    changedFilePaths: ["src/a.ts", "src/b.ts"],
  });
  const later = {
    11: [
      {
        sha: "c".repeat(40),
        dateIso: "2026-07-03T00:00:00.000Z",
        message: "redo: the thing, properly",
        files: ["src/a.ts", "src/b.ts"],
      },
    ],
  };

  it("keeps it out of the rate rather than printing 100%", () => {
    // Both of this issue's files were touched again. Scored as shipped work
    // that would be a 100% rework rate — for code that was never in the tree.
    const input = renderInputFor([quarantined], later);
    const text = renderReport(input);
    expect(input.report.issues[0]?.reworkRate).toBeNull();
    expect(input.report.overall.reworkRate).toBeNull();
    expect(text).toContain("NOT SCORED — the work never landed");
    expect(text).not.toContain("100%");
  });

  it("still shows the later touches, because the redo cost is real", () => {
    const text = renderReport(renderInputFor([quarantined], later));
    expect(text).toContain("later touches");
    expect(text).toContain("quarantined");
    expect(text).toContain("REDO of work that was never in the tree");
  });

  it("moves the quarantine-floor caveat next to the outcome column", () => {
    // It used to sit above the by-run/by-model tables, which carry no outcome
    // at all — a caveat pointing at nothing. It belongs where an outcome is
    // actually printed, i.e. the scored table.
    const scored = record({
      issueNumber: 7,
      changedFilePaths: ["src/a.ts", "src/b.ts"],
    });
    const text = renderReport(
      renderInputFor([scored], {
        7: [
          {
            sha: "b".repeat(40),
            dateIso: "2026-07-03T00:00:00.000Z",
            message: "fix: correct the thing",
            files: ["src/a.ts"],
          },
        ],
      }),
    );
    const caveat = text.indexOf("A FLOOR, NOT A CENSUS");
    expect(caveat).toBeGreaterThan(-1);
    expect(caveat).toBeGreaterThan(text.indexOf("SCORED —"));
    expect(caveat).toBeLessThan(text.indexOf("OVERALL:"));
    expect(text).toContain("QUARANTINES IN THE outcome COLUMN");
  });
});

/** Two owned files, and `count` of them touched again by a stranger's commit.
 *  Module-scoped because the basis rule is asserted on BOTH outputs, and the
 *  `--json` block below has to build the same shape the table block does. */
const files = ["src/a.ts", "src/b.ts"];
const rework = (issueNumber: number, count: number) => ({
  [issueNumber]: [
    {
      sha: `${issueNumber}`.repeat(40).slice(0, 40),
      dateIso: "2026-07-03T00:00:00.000Z",
      message: "fix: something else entirely",
      files: files.slice(0, count),
    },
  ],
});

describe("basis — a date-only row is not worth an ancestry-verified one", () => {
  /** #7 verified and clean; #8 read by date only and apparently 100% dirty. */
  const mixed = (): RenderInput =>
    renderInputFor(
      [
        record({ issueNumber: 7, changedFilePaths: files }),
        record({ issueNumber: 8, changedFilePaths: files }),
      ],
      { ...rework(7, 0), ...rework(8, 2) },
      { 8: "date-only" },
    );

  it("restates the rate over ancestry-verified rows alone", () => {
    const split = basisSplit(bucketRows(mixed().rows));
    expect(split.dateOnlyScoredCount).toBe(1);
    expect(split.ancestryScoredCount).toBe(1);
    // Overall is 2 of 4 files = 50%, but half of that rests on a row where
    // ANOTHER issue's concurrent commit could be what was counted.
    expect(split.ancestryOnly.reworkRate).toBe(0);
    expect(split.ancestryOnly.scoredIssueCount).toBe(1);
  });

  it("says so in the report instead of printing one hard number", () => {
    const input = mixed();
    const text = renderReport(input);
    expect(input.report.overall.reworkRate).toBe(0.5);
    expect(text).toContain("1 of 2 scored issue(s) were read by DATE ONLY");
    expect(text).toContain("ANCESTRY-VERIFIED ONLY");
    expect(text).toContain("can only");
    expect(text).toContain("OVERSTATE the rate");
  });

  it("says the opposite, positively, when every row is verified", () => {
    const text = renderReport(
      renderInputFor([record({ issueNumber: 7, changedFilePaths: files })], {}),
    );
    expect(text).toContain(
      "every scored issue's ship commit is an ancestor of HEAD",
    );
    expect(text).not.toContain("DATE ONLY");
  });

  it("counts date-only rows per group with the SAME keys the library groups by", () => {
    // A count joined onto the wrong row is worse than no count: `byModel` keys
    // on each DISTINCT model VALUE, not on the role name.
    const text = renderReport(
      renderInputFor(
        [
          record({
            issueNumber: 8,
            runId: "run-z",
            changedFilePaths: files,
            models: {
              implementer: { default: "claude-sonnet-5", escalations: [] },
            },
          }),
        ],
        rework(8, 1),
        { 8: "date-only" },
      ),
    );
    const byRun = text.slice(text.indexOf("BY RUN"), text.indexOf("BY MODEL"));
    expect(byRun).toContain("date-only");
    // run-z: scored=1 files=2 rate=50% ancestry=unknown earliest=2.0d
    //        in-window=0 excluded=0 date-only=1
    //
    // The `ancestry` column is the point: the group's ONE scored row was read
    // by date, so there is no verified rate to state and the table says
    // "unknown" rather than letting 50% borrow an authority it has not got.
    expect(byRun).toMatch(/run-z\s+1\s+2\s+50%\s+unknown\s+2\.0d\s+0\s+0\s+1/);
    const byModel = text.slice(text.indexOf("BY MODEL"));
    expect(byModel).toMatch(
      /claude-sonnet-5\s+1\s+2\s+50%\s+unknown\s+2\.0d\s+0\s+0\s+1/,
    );
  });

  it("gives an ancestry-verified group a REAL ancestry rate, not `unknown`", () => {
    // The other side of the same column: when the group's rows ARE verified,
    // the two rates agree and the reader can see that they do.
    const text = renderReport(
      renderInputFor(
        [record({ issueNumber: 8, runId: "run-z", changedFilePaths: files })],
        rework(8, 1),
      ),
    );
    const byRun = text.slice(text.indexOf("BY RUN"));
    expect(byRun).toMatch(/run-z\s+1\s+2\s+50%\s+50%\s+2\.0d\s+0\s+0\s+0/);
  });
});

describe("HISTORY UNREADABLE — the reason has to reach the READER", () => {
  it("prints a long `why` intact, not clipped to a column width", () => {
    // The diagnostics the walk produces are only worth writing if they survive
    // the table. `why` is the last column and the actionable instruction can be
    // long — the buffer-overflow reason names a constant AND a file. A width
    // clamp or a `.slice()` here would silently put the reader back on a
    // useless message while every test of the walk itself stayed green.
    const why =
      "raise REWORK_GIT_MAX_BUFFER_BYTES in lib/telemetry/rework-history.ts — " +
      "git log output outgrew its 268435456-byte buffer " +
      "(this repo's history has grown past it)";
    const rec = record({ issueNumber: 21, changedFilePaths: ["src/a.ts"] });
    const text = renderReport({
      ...renderInputFor([rec], {}),
      unreadable: [{ record: rec, mode: "unavailable", laterCommits: [], note: why }],
    });
    const section = text.slice(text.indexOf("HISTORY UNREADABLE"));
    expect(section).toContain(why);
  });
});

describe("buildJson", () => {
  it("carries the semantics a machine consumer would otherwise misread", () => {
    const json: ReworkReportJson = buildJson({
      ...renderInputFor(
        [
          record({ issueNumber: 3, shippedAtIso: "2026-07-31T00:00:00.000Z" }),
          record({ issueNumber: 4 }),
        ],
        {},
      ),
      exists: true,
      generatedAtIso: NOW,
    });
    expect(json.semantics.join(" ")).toContain("never 0%");
    // #3 is still inside its window; #4's window elapsed but it recorded no
    // files. Two different unknowns, and neither may be reported as a score.
    expect(json.counts.insufficientData).toBe(1);
    expect(json.counts.zeroFile).toBe(1);
    expect(json.counts.scored).toBe(0);
  });

  it("gives the excluded bucket and the basis split their own keys", () => {
    // A typed contract that omitted a whole bucket would let a consumer read
    // `counts.scored` as the population. It is not.
    const json: ReworkReportJson = buildJson({
      ...renderInputFor(
        [
          record({
            issueNumber: 5,
            outcome: "quarantined",
            changedFilePaths: ["src/a.ts"],
          }),
          record({ issueNumber: 6, changedFilePaths: ["src/b.ts"] }),
        ],
        {},
        { 6: "date-only" },
      ),
      exists: true,
      generatedAtIso: NOW,
    });
    expect(json.counts.excludedByOutcome).toBe(1);
    expect(json.counts.scored).toBe(1);
    expect(json.basis.dateOnlyScoredCount).toBe(1);
    expect(json.basis.ancestryScoredCount).toBe(0);
    expect(json.basis.ancestryOnly.scoredIssueCount).toBe(0);
    // Every issue still appears exactly once, excluded ones included.
    expect(json.issues.map((i) => i.issueNumber).sort()).toEqual([5, 6]);
    expect(
      json.issues.find((i) => i.issueNumber === 5)?.excludedByOutcome,
    ).toBe(true);
    expect(json.semantics.join(" ")).toContain("Only outcome === 'shipped'");
  });

  it("gives EVERY byRun / byModel group its own basis, not just OVERALL", () => {
    // `byRun[0].aggregate.reworkRate` emitted alone is an unknown wearing the
    // costume of a hard number. `--json` is the contract a future consumer
    // builds on, so the basis has to travel with the rate there too.
    const json: ReworkReportJson = buildJson({
      ...renderInputFor(
        [
          record({
            issueNumber: 8,
            runId: "run-z",
            changedFilePaths: files,
            models: {
              implementer: { default: "claude-sonnet-5", escalations: [] },
            },
          }),
        ],
        rework(8, 1),
        { 8: "date-only" },
      ),
      exists: true,
      generatedAtIso: NOW,
    });
    const run = json.byRun.find((g) => g.key === "run-z");
    expect(run?.aggregate.reworkRate).toBe(0.5);
    // The whole point: 50% rests on ONE date-only row and NOTHING verified, so
    // the verified rate is null — the machine can tell the two apart.
    expect(run?.basis.dateOnlyScoredCount).toBe(1);
    expect(run?.basis.ancestryScoredCount).toBe(0);
    expect(run?.basis.ancestryOnly.reworkRate).toBeNull();
    const model = json.byModel.find((g) => g.key === "claude-sonnet-5");
    expect(model?.basis.dateOnlyScoredCount).toBe(1);
    expect(model?.basis.ancestryOnly.reworkRate).toBeNull();
  });

  it("gives each basis-less group its OWN empty basis, not a shared object", () => {
    // Two groups with no scored rows both fall back to the empty basis. It used
    // to be one module-level object handed out by reference: the payload
    // serialised correctly, but one consumer mutating a group's basis — or its
    // nested `ancestryOnly` — rewrote every other empty group at once.
    const json: ReworkReportJson = buildJson({
      ...renderInputFor(
        [
          record({
            issueNumber: 11,
            runId: "run-p",
            outcome: "quarantined",
            changedFilePaths: ["src/a.ts"],
          }),
          record({
            issueNumber: 12,
            runId: "run-q",
            outcome: "quarantined",
            changedFilePaths: ["src/b.ts"],
          }),
        ],
        {},
      ),
      exists: true,
      generatedAtIso: NOW,
    });
    const p = json.byRun.find((g) => g.key === "run-p");
    const q = json.byRun.find((g) => g.key === "run-q");
    // Both really are basis-less — otherwise this asserts nothing.
    expect(p?.basis.ancestryScoredCount).toBe(0);
    expect(p?.basis.dateOnlyScoredCount).toBe(0);
    expect(q?.basis.dateOnlyScoredCount).toBe(0);
    expect(p?.basis).not.toBe(q?.basis);
    // The nested aggregate too — sharing only that would survive a half-fix.
    expect(p?.basis.ancestryOnly).not.toBe(q?.basis.ancestryOnly);
  });

  it("states a group's verified rate when the group IS verified", () => {
    const json: ReworkReportJson = buildJson({
      ...renderInputFor(
        [record({ issueNumber: 8, runId: "run-z", changedFilePaths: files })],
        rework(8, 1),
      ),
      exists: true,
      generatedAtIso: NOW,
    });
    const run = json.byRun.find((g) => g.key === "run-z");
    expect(run?.basis.ancestryScoredCount).toBe(1);
    expect(run?.basis.dateOnlyScoredCount).toBe(0);
    expect(run?.basis.ancestryOnly.reworkRate).toBe(0.5);
  });
});

describe("store-health notes the reader would otherwise not get", () => {
  it("says duplicates were collapsed rather than collapsing them silently", () => {
    const input = renderInputFor([record({ issueNumber: 9 })], {});
    const text = renderReport({ ...input, duplicateLines: 3 });
    expect(text).toContain("3 duplicate line(s)");
    expect(text).toContain("Expected, not damage");
  });

  it("states that the quarantine count is a FLOOR, always", () => {
    // The store REQUIRES a shippedSha, and the loop's bare-`HALT` quarantines
    // never produce one — so those quarantines are absent from this file by
    // construction and no reader can count them. The outcome mix therefore reads
    // cleaner than the run actually was, and a clean-looking report is precisely
    // when that needs saying: this is unconditional on purpose.
    const input = renderInputFor([record({ issueNumber: 9 })], {});
    expect(renderReport(input)).toContain("A FLOOR, NOT A CENSUS");
  });
});
