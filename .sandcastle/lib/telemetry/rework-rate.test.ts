/**
 * Tests for the rework-rate scorer.
 *
 * The requirement most likely to mislead a human is `insufficientData`: a
 * ticket shipped yesterday cannot have a 0% rework rate, it has an UNKNOWN
 * rework rate. So the first block below pins that, including the exact instant
 * the window finishes elapsing — an off-by-one between the "has the window
 * elapsed" comparison and the "is this commit inside the window" comparison
 * would otherwise be invisible.
 *
 * The second-most-dangerous case is the interaction between two rules that
 * pull opposite ways: commits mentioning the issue's own number are excluded
 * as the issue's own work, but a REVERT of the issue names that same number
 * and must count as rework (strongly so).
 *
 * The third is `outcome`: a quarantined issue never merged, so later commits to
 * "its" files are a redo of work that never landed. The last block pins that it
 * is excluded by default, that an ABSENT outcome is excluded too, and — the one
 * that would corrupt real rows rather than merely hide one — that exclusion
 * never shortens or reorders `scoreRework`'s per-issue list.
 *
 * Everything here is pure data in / data out — no filesystem, no git, no clock.
 */
import { describe, expect, it } from "vitest";

import type {
  LaterCommit,
  ReworkInput,
  ReworkIssueRecord,
  ReworkOptions,
} from "./rework-rate.js";
import {
  aggregateRework,
  DAY_MS,
  DEFAULT_REWORK_EXCLUDED_PATH_GLOBS,
  DEFAULT_REWORK_WINDOW_DAYS,
  referencesIssue,
  resolveWindowDays,
  scoreIssueRework,
  scoreRework,
} from "./rework-rate.js";

const SHIPPED_AT = "2026-01-01T00:00:00.000Z";

/** `n` days after {@link SHIPPED_AT}, as an ISO string. */
function daysAfterShip(n: number): string {
  return new Date(Date.parse(SHIPPED_AT) + n * DAY_MS).toISOString();
}

/** A SHIPPED record by default — the only outcome the scorer scores without an
 *  explicit opt-in. Tests about other outcomes override it. */
function record(over: Partial<ReworkIssueRecord> = {}): ReworkIssueRecord {
  return {
    issueNumber: 100,
    shippedAtIso: SHIPPED_AT,
    shippedSha: "ship0",
    changedFilePaths: ["src/a.ts"],
    outcome: "shipped",
    ...over,
  };
}

function commit(over: Partial<LaterCommit> = {}): LaterCommit {
  return {
    sha: "c1",
    dateIso: daysAfterShip(1),
    message: "fix: something else",
    files: ["src/a.ts"],
    ...over,
  };
}

describe("attribution — the loop's own commits must not read as rework", () => {
  // The bug this pins: the loop writes `SANDCASTLE(it=9 issue=783):` with NO
  // `#`. 1,061 commits in this repo's history use that form. A matcher that
  // only knew `#783` scored every one of an issue's own follow-up commits as
  // rework OF ITSELF, driving the rate toward 100% — a report that looks
  // alarming and means nothing. Verified against real `git log` output.
  it("recognises the loop's own `issue=N` form, not just a human's `#N`", () => {
    expect(referencesIssue("SANDCASTLE(it=9 issue=783): scope it", 783)).toBe(
      true,
    );
    expect(
      referencesIssue("SANDCASTLE(it=9 issue=783) WIP: scope it", 783),
    ).toBe(true);
    expect(referencesIssue("fix: something (#783)", 783)).toBe(true);
  });

  it("does not let a longer number satisfy a shorter one, in either form", () => {
    expect(referencesIssue("SANDCASTLE(it=1 issue=7830): x", 783)).toBe(false);
    expect(referencesIssue("fix: thing (#7830)", 783)).toBe(false);
  });

  it("excludes an issue's own loop commit from its rework score", () => {
    const score = scoreIssueRework(
      {
        record: record({ issueNumber: 783 }),
        laterCommits: [
          commit({ message: "SANDCASTLE(it=9 issue=783): follow-up" }),
        ],
      },
      { nowIso: daysAfterShip(DEFAULT_REWORK_WINDOW_DAYS + 1) },
    );
    expect(score.reworkedFileCount).toBe(0);
    expect(score.reworkRate).toBe(0);
  });

  it("still counts a REVERT of the issue, even though it names the issue", () => {
    const score = scoreIssueRework(
      {
        record: record({ issueNumber: 783 }),
        laterCommits: [
          commit({
            message: 'Revert "SANDCASTLE(it=9 issue=783): follow-up"',
          }),
        ],
      },
      { nowIso: daysAfterShip(DEFAULT_REWORK_WINDOW_DAYS + 1) },
    );
    expect(score.reworkedFileCount).toBe(1);
  });
});

describe("insufficientData — an un-elapsed window is an unknown, never a 0%", () => {
  it("flags an issue whose window has not fully elapsed and refuses to score it", () => {
    const score = scoreIssueRework(
      { record: record(), laterCommits: [] },
      { nowIso: daysAfterShip(1) },
    );
    expect(score.insufficientData).toBe(true);
    expect(score.reworkRate).toBeNull();
    expect(score.reworkedFileCount).toBe(0);
    expect(score.daysToFirstRework).toBeNull();
  });

  it("still reports the rework it DID observe inside a partial window", () => {
    // Rework found early is real; only the ZERO is untrustworthy. The flag says
    // "not final", it does not blank an observation.
    const score = scoreIssueRework(
      { record: record(), laterCommits: [commit()] },
      { nowIso: daysAfterShip(2) },
    );
    expect(score.insufficientData).toBe(true);
    expect(score.reworkedFileCount).toBe(1);
    expect(score.daysToFirstRework).toBeCloseTo(1);
    // The RATE stays null while the window is open — a partial window can only
    // ever undercount, so no number from it is final.
    expect(score.reworkRate).toBeNull();
  });

  it("treats the window as elapsed at EXACTLY shippedAt + windowDays, and the same instant is still inside the window", () => {
    // Both comparisons must agree at the boundary instant.
    const boundary = daysAfterShip(DEFAULT_REWORK_WINDOW_DAYS);
    const score = scoreIssueRework(
      { record: record(), laterCommits: [commit({ dateIso: boundary })] },
      { nowIso: boundary },
    );
    expect(score.insufficientData).toBe(false);
    expect(score.reworkedFileCount).toBe(1);
    expect(score.daysToFirstRework).toBeCloseTo(DEFAULT_REWORK_WINDOW_DAYS);
  });

  it("excludes a commit one millisecond past the window", () => {
    const past = new Date(
      Date.parse(SHIPPED_AT) + DEFAULT_REWORK_WINDOW_DAYS * DAY_MS + 1,
    ).toISOString();
    const score = scoreIssueRework(
      { record: record(), laterCommits: [commit({ dateIso: past })] },
      { nowIso: daysAfterShip(30) },
    );
    expect(score.insufficientData).toBe(false);
    expect(score.reworkedFileCount).toBe(0);
    expect(score.reworkRate).toBe(0);
  });

  it("honors a custom windowDays for BOTH the elapsed check and the commit filter", () => {
    const score = scoreIssueRework(
      {
        record: record(),
        laterCommits: [commit({ dateIso: daysAfterShip(4) })],
      },
      { nowIso: daysAfterShip(3), windowDays: 3 },
    );
    expect(score.insufficientData).toBe(false);
    expect(score.reworkedFileCount).toBe(0);

    const inside = scoreIssueRework(
      {
        record: record(),
        laterCommits: [commit({ dateIso: daysAfterShip(2) })],
      },
      { nowIso: daysAfterShip(3), windowDays: 3 },
    );
    expect(inside.reworkedFileCount).toBe(1);
  });

  it("is insufficient when the ship date or the clock is unparsable", () => {
    const badShip = scoreIssueRework(
      {
        record: record({ shippedAtIso: "not-a-date" }),
        laterCommits: [commit()],
      },
      { nowIso: daysAfterShip(30) },
    );
    expect(badShip.insufficientData).toBe(true);
    expect(badShip.reworkRate).toBeNull();

    const badClock = scoreIssueRework(
      { record: record(), laterCommits: [commit()] },
      { nowIso: "whenever" },
    );
    expect(badClock.insufficientData).toBe(true);
    expect(badClock.reworkRate).toBeNull();
  });
});

describe("attribution — the issue's own follow-ups do not count against it", () => {
  const opts = { nowIso: daysAfterShip(30) };

  it("excludes a commit whose message references the issue's own number", () => {
    const score = scoreIssueRework(
      {
        record: record({ issueNumber: 100 }),
        laterCommits: [commit({ message: "fix: tidy up (#100)" })],
      },
      opts,
    );
    expect(score.reworkedFileCount).toBe(0);
    expect(score.reworkRate).toBe(0);
  });

  it("does not confuse #1000 with #100", () => {
    const score = scoreIssueRework(
      {
        record: record({ issueNumber: 100 }),
        laterCommits: [commit({ message: "fix: unrelated (#1000)" })],
      },
      opts,
    );
    expect(score.reworkedFileCount).toBe(1);
  });

  it("COUNTS a revert of the issue itself, even though it names the issue number", () => {
    const score = scoreIssueRework(
      {
        record: record({ issueNumber: 100 }),
        laterCommits: [
          commit({ message: 'Revert "feat: add the thing (#100)"' }),
        ],
      },
      opts,
    );
    expect(score.reworkedFileCount).toBe(1);
    expect(score.reworkRate).toBe(1);
  });

  it("counts a revert identified by its body line", () => {
    const score = scoreIssueRework(
      {
        record: record({ issueNumber: 100 }),
        laterCommits: [
          commit({
            message: "chore: undo (#100)\n\nThis reverts commit ship0.",
          }),
        ],
      },
      opts,
    );
    expect(score.reworkedFileCount).toBe(1);
  });

  it("excludes merge commits by default and counts them when configured off", () => {
    const merge = commit({ isMerge: true, message: "Merge pull request #999" });
    expect(
      scoreIssueRework({ record: record(), laterCommits: [merge] }, opts)
        .reworkedFileCount,
    ).toBe(0);
    expect(
      scoreIssueRework(
        { record: record(), laterCommits: [merge] },
        { ...opts, excludeMergeCommits: false },
      ).reworkedFileCount,
    ).toBe(1);
  });

  it("counts the issue's own commits when attribution is configured off", () => {
    const own = commit({ message: "fix: tidy up (#100)" });
    expect(
      scoreIssueRework(
        { record: record(), laterCommits: [own] },
        { ...opts, excludeSameIssueCommits: false },
      ).reworkedFileCount,
    ).toBe(1);
  });

  it("never counts the ship commit itself", () => {
    const score = scoreIssueRework(
      {
        record: record({ shippedSha: "ship0" }),
        laterCommits: [commit({ sha: "ship0", message: "feat: the thing" })],
      },
      opts,
    );
    expect(score.reworkedFileCount).toBe(0);
  });

  it("drops a commit dated BEFORE the ship (rebase/committer-date skew)", () => {
    const score = scoreIssueRework(
      {
        record: record(),
        laterCommits: [commit({ dateIso: daysAfterShip(-1) })],
      },
      opts,
    );
    expect(score.reworkedFileCount).toBe(0);
  });
});

describe("path handling", () => {
  const opts = { nowIso: daysAfterShip(30) };

  it("ignores lockfile and minified churn by default", () => {
    expect(DEFAULT_REWORK_EXCLUDED_PATH_GLOBS).toContain("pnpm-lock.yaml");
    const score = scoreIssueRework(
      {
        record: record({
          changedFilePaths: [
            "src/a.ts",
            "pnpm-lock.yaml",
            "vendor/x.lock",
            "public/app.min.js",
          ],
        }),
        laterCommits: [
          commit({
            files: ["pnpm-lock.yaml", "vendor/x.lock", "public/app.min.js"],
          }),
        ],
      },
      opts,
    );
    // Excluded paths leave the issue's own file list too — they were never
    // signal on either side.
    expect(score.totalFileCount).toBe(1);
    expect(score.reworkedFileCount).toBe(0);
  });

  it("counts a file listed twice in one issue's changed files only once", () => {
    const score = scoreIssueRework(
      {
        record: record({
          changedFilePaths: ["src/a.ts", "src/a.ts", "src/b.ts"],
        }),
        laterCommits: [commit({ files: ["src/a.ts"] })],
      },
      opts,
    );
    expect(score.totalFileCount).toBe(2);
    expect(score.reworkedFileCount).toBe(1);
    expect(score.reworkRate).toBeCloseTo(0.5);
    expect(score.reworkedFilePaths).toEqual(["src/a.ts"]);
  });

  it("counts a file reworked by several commits once, dating it from the EARLIEST", () => {
    const score = scoreIssueRework(
      {
        record: record({ changedFilePaths: ["src/a.ts"] }),
        laterCommits: [
          commit({ sha: "c3", dateIso: daysAfterShip(9) }),
          commit({ sha: "c2", dateIso: daysAfterShip(3) }),
          commit({ sha: "c4", dateIso: daysAfterShip(11) }),
        ],
      },
      opts,
    );
    expect(score.reworkedFileCount).toBe(1);
    expect(score.reworkRate).toBe(1);
    expect(score.daysToFirstRework).toBeCloseTo(3);
  });

  it("ignores commit files the issue never touched", () => {
    const score = scoreIssueRework(
      {
        record: record({ changedFilePaths: ["src/a.ts"] }),
        laterCommits: [commit({ files: ["src/zzz.ts"] })],
      },
      opts,
    );
    expect(score.reworkedFileCount).toBe(0);
    expect(score.daysToFirstRework).toBeNull();
  });
});

describe("an issue that changed no files scores null, NOT 0%", () => {
  const opts = { nowIso: daysAfterShip(30) };

  it("returns a null rate for an empty changed-file list", () => {
    const score = scoreIssueRework(
      { record: record({ changedFilePaths: [] }), laterCommits: [commit()] },
      opts,
    );
    expect(score.totalFileCount).toBe(0);
    expect(score.reworkRate).toBeNull();
    expect(score.insufficientData).toBe(false);
  });

  it("returns a null rate when changedFilePaths was never recorded", () => {
    const score = scoreIssueRework(
      { record: record({ changedFilePaths: undefined }), laterCommits: [] },
      opts,
    );
    expect(score.totalFileCount).toBe(0);
    expect(score.reworkRate).toBeNull();
  });
});

describe("aggregates", () => {
  const nowIso = daysAfterShip(30);

  const inputs: readonly ReworkInput[] = [
    {
      // 1 of 2 files reworked, fully elapsed.
      record: record({
        issueNumber: 1,
        runId: "run-a",
        changedFilePaths: ["src/a.ts", "src/b.ts"],
        models: { implementer: "sonnet", reviewer: "haiku" },
      }),
      laterCommits: [
        commit({ files: ["src/a.ts"], dateIso: daysAfterShip(2) }),
      ],
    },
    {
      // 0 of 2 reworked, fully elapsed.
      record: record({
        issueNumber: 2,
        runId: "run-a",
        changedFilePaths: ["src/c.ts", "src/d.ts"],
        models: { implementer: "sonnet" },
      }),
      laterCommits: [],
    },
    {
      // Shipped yesterday — must not be reported as a clean 0%.
      record: record({
        issueNumber: 3,
        runId: "run-b",
        shippedAtIso: daysAfterShip(29),
        changedFilePaths: ["src/e.ts", "src/f.ts", "src/g.ts"],
        models: { implementer: "opus" },
      }),
      laterCommits: [],
    },
    {
      // A no-op ticket: zero files.
      record: record({
        issueNumber: 4,
        runId: "run-b",
        changedFilePaths: [],
        models: { implementer: "opus" },
      }),
      laterCommits: [],
    },
  ];

  it("excludes insufficient-data issues from the rate and counts them separately", () => {
    const report = scoreRework(inputs, { nowIso });
    const { overall } = report;
    expect(overall.issueCount).toBe(4);
    expect(overall.insufficientDataCount).toBe(1);
    expect(overall.zeroFileIssueCount).toBe(1);
    // Only issues 1 and 2 are in the rate: the unelapsed one and the no-op one
    // are both counted separately, never folded in as clean scores.
    expect(overall.scoredIssueCount).toBe(2);
    // src/e|f|g (issue 3) must NOT be in the denominator.
    expect(overall.totalFileCount).toBe(4);
    expect(overall.reworkedFileCount).toBe(1);
    expect(overall.reworkRate).toBeCloseTo(0.25);
    expect(overall.daysToFirstRework).toBeCloseTo(2);
  });

  it("returns a null aggregate rate when nothing scoreable is left", () => {
    const report = scoreRework([inputs[2]!, inputs[3]!], { nowIso });
    expect(report.overall.reworkRate).toBeNull();
    expect(report.overall.daysToFirstRework).toBeNull();
  });

  it("groups by run", () => {
    const report = scoreRework(inputs, { nowIso });
    expect(report.byRun.map((g) => g.key)).toEqual(["run-a", "run-b"]);
    const runA = report.byRun[0]!;
    expect(runA.aggregate.totalFileCount).toBe(4);
    expect(runA.aggregate.reworkRate).toBeCloseTo(0.25);
    const runB = report.byRun[1]!;
    expect(runB.aggregate.insufficientDataCount).toBe(1);
    expect(runB.aggregate.reworkRate).toBeNull();
  });

  it("groups by each distinct model value, so a multi-model issue lands in every group it used", () => {
    const report = scoreRework(inputs, { nowIso });
    expect(report.byModel.map((g) => g.key).sort()).toEqual([
      "haiku",
      "opus",
      "sonnet",
    ]);
    const sonnet = report.byModel.find((g) => g.key === "sonnet")!;
    expect(sonnet.aggregate.issueCount).toBe(2);
    expect(sonnet.aggregate.reworkRate).toBeCloseTo(0.25);
    const haiku = report.byModel.find((g) => g.key === "haiku")!;
    expect(haiku.aggregate.issueCount).toBe(1);
    expect(haiku.aggregate.reworkRate).toBeCloseTo(0.5);
  });

  it("keeps per-issue scores in the report, worst-first ordering left to the caller", () => {
    const report = scoreRework(inputs, { nowIso });
    expect(report.issues.map((s) => s.issueNumber)).toEqual([1, 2, 3, 4]);
    expect(report.issues[2]!.insufficientData).toBe(true);
  });

  it("keeps every bucket disjoint — the four counts sum to issueCount", () => {
    const report = scoreRework(
      [
        ...inputs,
        {
          record: record({ issueNumber: 5, outcome: "quarantined" }),
          laterCommits: [],
        },
      ],
      { nowIso },
    );
    const { overall } = report;
    expect(
      overall.scoredIssueCount +
        overall.insufficientDataCount +
        overall.zeroFileIssueCount +
        overall.excludedByOutcomeCount,
    ).toBe(overall.issueCount);
  });

  it("scores an empty input set without dividing by zero", () => {
    const report = scoreRework([], { nowIso });
    expect(report.issues).toEqual([]);
    expect(report.byRun).toEqual([]);
    expect(report.byModel).toEqual([]);
    expect(report.overall.issueCount).toBe(0);
    expect(report.overall.reworkRate).toBeNull();
  });
});

describe("outcome — work that never merged is not rework of shipped work", () => {
  // The bug this pins, reproduced by a reviewer at 80%: a QUARANTINED issue's
  // lane branch never merged, so the loop's later attempts at the same files
  // are the redo of work that never landed. Scored as if it had shipped, it
  // printed an alarming rate for code that was never in the tree — and the
  // table gave no way to tell it apart from a genuine regression.
  const elapsedNow = daysAfterShip(DEFAULT_REWORK_WINDOW_DAYS + 1);

  function scoreWith(
    outcome: ReworkIssueRecord["outcome"],
    options: Partial<ReworkOptions> = {},
  ) {
    return scoreIssueRework(
      {
        record: record(
          outcome === undefined ? { outcome: undefined } : { outcome },
        ),
        laterCommits: [commit()],
      },
      { nowIso: elapsedNow, ...options },
    );
  }

  it("scores a shipped issue exactly as before", () => {
    const score = scoreWith("shipped");
    expect(score.excludedByOutcome).toBe(false);
    expect(score.reworkedFileCount).toBe(1);
    expect(score.reworkRate).toBe(1);
    expect(score.outcome).toBe("shipped");
  });

  it("refuses to score a quarantined issue by default", () => {
    const score = scoreWith("quarantined");
    expect(score.excludedByOutcome).toBe(true);
    expect(score.reworkRate).toBeNull();
    // The measurement survives for the renderer; only the RATE is withheld.
    expect(score.totalFileCount).toBe(1);
    expect(score.reworkedFileCount).toBe(1);
    expect(score.outcome).toBe("quarantined");
  });

  it("treats a needs-human outcome the same way", () => {
    expect(scoreWith("needs-human").excludedByOutcome).toBe(true);
  });

  it("treats an ABSENT outcome as unknown, never as shipped", () => {
    // Absent ≠ zero, applied to outcomes: "we did not record how this left" is
    // not a licence to assume it landed.
    const score = scoreWith(undefined);
    expect(score.excludedByOutcome).toBe(true);
    expect(score.reworkRate).toBeNull();
    expect(score.outcome).toBeUndefined();
  });

  it("scores every outcome when the caller opts in", () => {
    const score = scoreWith("quarantined", { includeAllOutcomes: true });
    expect(score.excludedByOutcome).toBe(false);
    expect(score.reworkRate).toBe(1);
    // The opt-in must not lose the label — a report that mixes outcomes has to
    // be able to say which row was which.
    expect(score.outcome).toBe("quarantined");
  });

  it("counts an excluded issue ONLY as excluded, even inside an un-elapsed window", () => {
    // Precedence matters: quarantined-and-recent is not "give it more time",
    // it will never be scoreable, so it must not inflate insufficientData.
    const score = scoreIssueRework(
      {
        record: record({ outcome: "quarantined" }),
        laterCommits: [],
      },
      { nowIso: daysAfterShip(1) },
    );
    expect(score.excludedByOutcome).toBe(true);
    expect(score.insufficientData).toBe(true);
    const aggregate = aggregateRework([score]);
    expect(aggregate.excludedByOutcomeCount).toBe(1);
    expect(aggregate.insufficientDataCount).toBe(0);
    expect(aggregate.zeroFileIssueCount).toBe(0);
    expect(aggregate.scoredIssueCount).toBe(0);
  });

  it("keeps an excluded issue out of the numerator AND the denominator", () => {
    const report = scoreRework(
      [
        {
          record: record({
            issueNumber: 1,
            changedFilePaths: ["src/a.ts", "src/b.ts"],
          }),
          laterCommits: [commit({ files: ["src/a.ts"] })],
        },
        {
          record: record({
            issueNumber: 2,
            outcome: "quarantined",
            changedFilePaths: ["src/x.ts", "src/y.ts"],
          }),
          laterCommits: [commit({ files: ["src/x.ts", "src/y.ts"] })],
        },
      ],
      { nowIso: elapsedNow },
    );
    // Without the exclusion this would be 3/4 = 75%; the quarantined issue's
    // two files are the ones that would have dominated it.
    expect(report.overall.totalFileCount).toBe(2);
    expect(report.overall.reworkedFileCount).toBe(1);
    expect(report.overall.reworkRate).toBeCloseTo(0.5);
    expect(report.overall.excludedByOutcomeCount).toBe(1);
  });

  it("returns one score per input, in input order, INCLUDING excluded ones", () => {
    // The report script pairs `issues[i]` back to its own `inputs[i]`. Dropping
    // an excluded issue here would shift every later row onto the wrong record
    // — mis-attributing real shipped work rather than merely hiding a row.
    const report = scoreRework(
      [
        { record: record({ issueNumber: 1 }), laterCommits: [] },
        {
          record: record({ issueNumber: 2, outcome: "quarantined" }),
          laterCommits: [],
        },
        { record: record({ issueNumber: 3 }), laterCommits: [] },
      ],
      { nowIso: elapsedNow },
    );
    expect(report.issues.map((s) => s.issueNumber)).toEqual([1, 2, 3]);
    expect(report.issues.map((s) => s.excludedByOutcome)).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe("the window arithmetic the caller must share", () => {
  // `resolveWindowDays` and `DAY_MS` are exported because whoever bounds a git
  // walk before calling in must resolve the window IDENTICALLY. They used to be
  // copied into the report CLI under a comment asserting the two "MUST agree";
  // these assertions plus a shared import are what actually make that true.
  it("falls back to the default for anything that is not a positive number", () => {
    expect(resolveWindowDays(undefined)).toBe(DEFAULT_REWORK_WINDOW_DAYS);
    expect(resolveWindowDays(0)).toBe(DEFAULT_REWORK_WINDOW_DAYS);
    expect(resolveWindowDays(-5)).toBe(DEFAULT_REWORK_WINDOW_DAYS);
    expect(resolveWindowDays(Number.NaN)).toBe(DEFAULT_REWORK_WINDOW_DAYS);
    expect(resolveWindowDays(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_REWORK_WINDOW_DAYS,
    );
  });

  it("honours a positive window, fractional included", () => {
    expect(resolveWindowDays(30)).toBe(30);
    expect(resolveWindowDays(0.5)).toBe(0.5);
  });

  it("resolves the same window the report itself reports", () => {
    const report = scoreRework([], { nowIso: SHIPPED_AT, windowDays: 30 });
    expect(report.windowDays).toBe(resolveWindowDays(30));
  });

  it("exports the day constant the window is measured in", () => {
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
  });
});
