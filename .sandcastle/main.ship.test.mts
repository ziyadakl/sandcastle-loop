import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "./__fixtures__/git-repo.js";
import {
  guttedFilesBetween,
  resolveShipDiffBase,
  shipDiffBase,
  shouldRecordDiffMeasurement,
} from "./lib/review/diff-measurement.js";
import { parseGuttedFiles } from "./lib/review/numstat.js";
import { decideFirstPassReviewerModel, shipAfterMigrations } from "./main.mts";
import { SHIP_INPUT_DEFAULTS } from "./__fixtures__/ship-input.mts";

// ---------------------------------------------------------------------------
// The SHIP-FUNNEL diff measurement, split out of `main.test.mts` when that file
// crossed its 1,000-line ceiling. Everything here is about the second of the
// loop's two diff measurements: where its base comes from (`shipDiffBase` /
// `resolveShipDiffBase`), what is allowed to reach the telemetry bag
// (`shouldRecordDiffMeasurement`), and that `shipAfterMigrations` records the
// WHOLE issue rather than one implementer attempt.
//
// The first-pass measurement (`decideFirstPassReviewerModel`) stays in
// `main.test.mts` next to the escalation decision it falls out of.
//
// These run against a REAL temp git repo with real commits, so the numstat
// parsing and the base resolution are exercised for real rather than stubbed.
// ---------------------------------------------------------------------------

/** The telemetry bag's diff setter, as these tests observe it. */
type NoteDiff = (
  lines: number,
  files: number,
  paths?: readonly string[],
) => void;

/**
 * A ctx carrying only the fields `shipAfterMigrations` actually reads. ONE
 * definition for the whole file: this had been copy-pasted per describe block,
 * where the copies drift silently — `repoRoot`/`branch`/the log sink and the
 * no-critique block's extra fields are the only things that ever differed, so
 * they are the overrides. Fields a given block doesn't exercise (the
 * implementer setters, `runCounters`) are inert stubs, not behavior.
 */
function makeShipCtx(over: {
  repoRoot: string;
  noteDiff: NoteDiff;
  /** The RUN branch — REQUIRED, not defaulted: a fixture that points it at the
   *  branch the issue commits on takes the `<sha>~1` rescue on every case. */
  branch: string;
  log?: (line: string) => void;
  /** Merged into `ctx.args`. */
  args?: Record<string, unknown>;
  /** Merged into the ctx root (`requiredSkills`, …). */
  ctx?: Record<string, unknown>;
}): Parameters<typeof shipAfterMigrations>[0] {
  return {
    args: {
      repoRoot: over.repoRoot,
      branch: over.branch,
      stagingEnabled: true,
      ...over.args,
    },
    deps: {
      log: over.log ?? ((): void => {}),
      logError: () => {},
      checkLintCert: async () => ({ status: "dormant" }),
      checkTestCert: async () => ({ status: "dormant" }),
      validateMigrationJournal: async () => [],
      applyMigrations: async () => ({ realErrors: [], applied: 0 }),
    },
    issueNumber: 42,
    issue: { branch: "issue-42" },
    telemetry: {
      noteShipPath: () => {},
      noteDiff: over.noteDiff,
      noteImplementerAttempt: () => {},
      // Issue #886: should anything here run a real `runImplementer`, it
      // records the implementer's certification envelope. This is a partial
      // hand-rolled bag, so an unstubbed setter is a TypeError, not a no-op —
      // `ctx.telemetry?.` guards an absent bag, never an absent method.
      noteImplementerCertification: () => {},
    },
    runCounters: { bump: () => {} },
    ...over.ctx,
  } as unknown as Parameters<typeof shipAfterMigrations>[0];
}

// ---------------------------------------------------------------------------
// `shouldRecordDiffMeasurement` guards a second `noteDiff` call (the ship-time
// re-measurement) from blanking a real first-pass record with a fail-quiet
// `{0, []}` git hiccup. Pure — no git, no ctx.
// ---------------------------------------------------------------------------

describe("shouldRecordDiffMeasurement", () => {
  it("rejects a fully empty result (0 lines, 0 files)", () => {
    expect(
      shouldRecordDiffMeasurement({ changedLines: 0, changedFiles: [] }),
    ).toBe(false);
  });

  it("accepts a real measurement", () => {
    expect(
      shouldRecordDiffMeasurement({
        changedLines: 4,
        changedFiles: ["src/a.ts"],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `shipAfterMigrations` re-measures the diff at the ship funnel, spanning the
// whole issue rather than the narrower per-attempt review base. This is the fix
// for under-reporting on any issue that needed a retry: the first measurement
// (at first-pass review) only sees attempt 1's commit, so a retry's additional
// commit was silently dropped from the telemetry record. Why the re-measurement
// can never narrow the record — and how its base is derived — is argued once,
// on `shipDiffBase` in main.mts.
// ---------------------------------------------------------------------------

describe("shipAfterMigrations re-measures the diff at the ship funnel", () => {
  let repo: string;
  const logs: string[] = [];

  const commit = (files: Record<string, string>, message: string): string =>
    commitInto(repo, files, message);

  beforeEach(() => {
    logs.length = 0;
    repo = mkdtempSync(path.join(tmpdir(), "sc-ship-remeasure-"));
    // Production topology (same shape as the two blocks below): the issue's
    // commits go on the ISSUE branch, and `run` — the ctx branch — is left at
    // the fork point. Committing onto the ctx branch instead would make every
    // case take the `<sha>~1` rescue that `shipDiffBase` exists to refuse.
    git(repo, "init", "-q", "-b", "issue-42");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commit({ "README.md": "seed\n" }, "init");
    git(repo, "branch", "run");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const ctxFor = (
    noteDiff: NoteDiff,
  ): Parameters<typeof shipAfterMigrations>[0] =>
    makeShipCtx({
      repoRoot: repo,
      branch: "run",
      noteDiff,
      log: (l) => logs.push(l),
    });

  it("reports BOTH commits' paths at ship time when the implementer retried", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    commit({ "src/a.ts": "one\n" }, "attempt 1");
    const postSha = commit({ "src/b.ts": "two\n" }, "retry commit");

    const diffCalls: [number, number, readonly string[] | undefined][] = [];
    const ctx = ctxFor((lines, files, paths) => {
      diffCalls.push([lines, files, paths]);
    });

    await shipAfterMigrations(
      ctx,
      {} as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    // The ship-time measurement (the LAST noteDiff call) must span both
    // commits, not just the last one.
    const last = diffCalls[diffCalls.length - 1];
    expect(last[2]).toEqual(["src/a.ts", "src/b.ts"]);
  });

  // An issue that produced NO commits must record NOTHING — never a previous
  // commit's files. The trap is real only with a REAL PARENT behind the cut:
  // at a root commit `<postSha>~1` cannot resolve, so a base derived from the
  // reviewer's `~1` rescue would fail harmlessly rather than silently crediting
  // this issue with the PRECEDING commit's work (`other-issue.ts` below).
  it("does not record a ship-time measurement when there is nothing to measure", async () => {
    // The preceding issue's commit belongs on the RUN branch; this issue's
    // branch is then cut from that tip and never committed to.
    git(repo, "checkout", "-q", "run");
    commit({ "other-issue.ts": "not this issue's work\n" }, "a previous issue");
    git(repo, "branch", "-f", "issue-42", "run");
    git(repo, "checkout", "-q", "issue-42");
    const preSha = git(repo, "rev-parse", "HEAD");
    const diffCalls: unknown[] = [];
    const ctx = ctxFor((...args) => diffCalls.push(args));

    await shipAfterMigrations(
      ctx,
      {} as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha: preSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    // `toEqual([])` rather than a length check: on a regression the failure
    // message names the files that were wrongly credited to this issue.
    expect(diffCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The ship-time base on a RESUMED issue. `createSandbox` force-moves the issue
// branch onto the saved WIP ref BEFORE the worktree exists, so on a resume
// `preSha` is the WIP tip — already carrying the previous session's commits —
// while the first-pass measurement based on the run branch's fork point, which
// is BEHIND it. Diffing `preSha → postSha` there measures a strict SUBSET, and
// last-write-wins then overwrites the broader first-pass record with the
// narrower one. The ship base is therefore the common ancestor of both
// candidates, computed by `shipDiffBase`.
// ---------------------------------------------------------------------------

describe("ship-time diff base on a resumed issue", () => {
  let repo: string;

  const commit = (files: Record<string, string>, message: string): string =>
    commitInto(repo, files, message);

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-ship-resume-"));
    git(repo, "init", "-q", "-b", "issue-42");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * Fork point `run`, then the previous session's commit, then this session's.
   * Mirrors the real resume shape: the issue branch sits ahead of the run
   * branch before this session's implementer ever runs.
   */
  function seedResumedIssue(): { preSha: string; postSha: string } {
    commit({ "README.md": "seed\n" }, "init");
    git(repo, "branch", "run");
    const preSha = commit({ "src/prev.ts": "prev\n" }, "previous session");
    const postSha = commit({ "src/new.ts": "new\n" }, "this session");
    return { preSha, postSha };
  }

  const ctxFor = (
    noteDiff: NoteDiff,
  ): Parameters<typeof shipAfterMigrations>[0] =>
    makeShipCtx({ repoRoot: repo, branch: "run", noteDiff });

  it("spans the WHOLE issue, not just this session's commits", async () => {
    const { preSha, postSha } = seedResumedIssue();
    const calls: (readonly string[] | undefined)[] = [];
    await shipAfterMigrations(
      ctxFor((_l, _f, paths) => calls.push(paths)),
      {} as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );
    expect(calls[calls.length - 1]).toEqual(["src/new.ts", "src/prev.ts"]);
  });

  // The intentional-but-previously-untested consequence of basing on the fork
  // point: a resumed issue where THIS session added nothing is NOT
  // short-circuited as "nothing to measure". preSha === postSha, yet the
  // previous session's work is between the fork point and postSha, so it is
  // measured and recorded. Under the old `preSha`-based ship base this issue
  // recorded nothing here and kept whatever the first pass had.
  it("still records the previous session's work when THIS session added no commits", async () => {
    const { postSha } = seedResumedIssue();
    const calls: (readonly string[] | undefined)[] = [];
    await shipAfterMigrations(
      ctxFor((_l, _f, paths) => calls.push(paths)),
      {} as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha: postSha, // preSha === postSha: this session committed nothing
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );
    expect(calls[calls.length - 1]).toEqual(["src/new.ts", "src/prev.ts"]);
  });

  it("resolves EXACTLY the first-pass base, even after a retry commit", () => {
    const { preSha, postSha: attempt1 } = seedResumedIssue();
    // The first pass measures attempt 1 against the run branch's fork point.
    const firstPassBase = git(repo, "merge-base", "run", attempt1);
    // …then a retry lands another commit on the issue branch.
    const postSha = commit({ "src/retry.ts": "retry\n" }, "retry commit");

    // THE property. Not "ancestor-or-equal of preSha" (a different, weaker
    // statement that cannot imply "never narrower" — on a resume `preSha` is
    // strictly AHEAD of the first-pass base). The ship base EQUALS the
    // first-pass base: the merge-base is retry-invariant, and `preSha` descends
    // from the fork point so intersecting with it changes nothing.
    expect(shipDiffBase(repo, "run", preSha, postSha)).toBe(firstPassBase);
  });

  it("collapses to the same base as before on a NON-resumed issue", () => {
    // preSha IS the fork point here, so nothing changes for the common case.
    commit({ "README.md": "seed\n" }, "init");
    git(repo, "branch", "run");
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "src/only.ts": "x\n" }, "the one commit");
    expect(shipDiffBase(repo, "run", preSha, postSha)).toBe(preSha);
  });
});

// ---------------------------------------------------------------------------
// THE design invariant, asserted end-to-end: the ship measurement is a SUPERSET
// of the first-pass measurement FOR THE SAME ISSUE. Every other ship test here
// asserts on the last `noteDiff` call, and `shipAfterMigrations` only ever makes
// one — the first-pass measurement happens in `runIssuePipeline`, OUTSIDE the
// function under test. So a regression that narrowed the ship base would keep
// all of them green. This block runs BOTH measurements against ONE temp repo
// through one shared recorder, which is the assertion that would have caught it.
// ---------------------------------------------------------------------------

describe("ship ⊇ first-pass for the same issue", () => {
  let repo: string;

  const commit = (files: Record<string, string>, message: string): string =>
    commitInto(repo, files, message);

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-ship-superset-"));
    git(repo, "init", "-q", "-b", "issue-42");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("records at ship a path set containing everything the first pass recorded", async () => {
    // Resume shape: fork point → previous session's commit → this session's.
    commit({ "README.md": "seed\n" }, "init");
    git(repo, "branch", "run");
    const preSha = commit({ "src/prev.ts": "prev\n" }, "previous session");
    const attempt1 = commit({ "src/new.ts": "new\n" }, "this session, attempt 1");

    const recorded: (readonly string[] | undefined)[] = [];
    const record: NoteDiff = (_l, _f, paths) => recorded.push(paths);

    // Measurement 1, exactly as `runIssuePipeline` takes it: the decision
    // carries the diff, and the pipeline hands that straight to the bag.
    const decision = decideFirstPassReviewerModel(
      {
        args: { repoRoot: repo, branch: "run" },
        deps: { log: () => {}, logError: () => {} },
        issueNumber: 42,
      } as unknown as Parameters<typeof decideFirstPassReviewerModel>[0],
      attempt1,
    );
    record(
      decision.diff?.changedLines ?? 0,
      decision.diff?.changedFiles.length ?? 0,
      decision.diff?.changedFiles,
    );

    // …then a retry lands more work, and the issue ships.
    const postSha = commit({ "src/retry.ts": "retry\n" }, "retry commit");
    await shipAfterMigrations(
      makeShipCtx({ repoRoot: repo, branch: "run", noteDiff: record }),
      {} as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(recorded).toHaveLength(2);
    const [first, ship] = recorded;
    expect(first).toEqual(["src/new.ts", "src/prev.ts"]);
    // The invariant: NOTHING the first pass recorded may be missing at ship.
    for (const p of first ?? []) expect(ship).toContain(p);
    // …and the retry's work is there too, so this is a strict superset.
    expect(ship).toContain("src/retry.ts");
  });
});

describe("resolveShipDiffBase (pure)", () => {
  const PRE = "a".repeat(40);

  it("takes the merge-base when git resolved one", () => {
    const fork = "b".repeat(40);
    expect(
      resolveShipDiffBase({ ok: true, stdout: fork, stderr: "" }, PRE),
    ).toBe(fork);
  });

  it("falls back to preSha on a git failure, never widening blindly", () => {
    expect(
      resolveShipDiffBase({ ok: false, stdout: "", stderr: "boom" }, PRE),
    ).toBe(PRE);
  });

  it("falls back to preSha on empty stdout (unrelated histories)", () => {
    expect(resolveShipDiffBase({ ok: true, stdout: "", stderr: "" }, PRE)).toBe(
      PRE,
    );
  });
});

// ---------------------------------------------------------------------------
// The ship funnel never dispatches a design critique (spec #1334). Until #1334
// a ticket whose type listed design principles went through a separate
// critique stage here, after the reviewer's pass, which could commit a retry
// and so move `postSha` under the ship measurement. The reviewer now grades
// design rules itself, so the funnel dispatches nothing and measures the
// exact sha it was handed — even with required principles and their rubric on
// disk, the shape that used to wake the critique up.
// ---------------------------------------------------------------------------

describe("the ship funnel never dispatches a design critique", () => {
  let repo: string;

  const commit = (files: Record<string, string>, message: string): string =>
    commitInto(repo, files, message);

  const SKILL = "impeccable";

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-ship-no-critique-"));
    git(repo, "init", "-q", "-b", "issue-42");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commit({ "README.md": "seed\n" }, "init");
    commit({ [`.claude/skills/${SKILL}/SKILL.md`]: "# rubric\n" }, "rubric");
    git(repo, "branch", "run");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("dispatches no agent and measures the handed postSha unchanged", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const handedPostSha = commit({ "src/a.ts": "one\n" }, "attempt 1");

    const dispatched: string[] = [];
    const sandbox = {
      worktreePath: undefined,
      run: async (opts: { promptFile: string }) => {
        dispatched.push(opts.promptFile);
        return { stdout: "CRITIQUE_NEEDS_FIXES", commits: [], iterations: [] };
      },
    };
    const calls: (readonly string[] | undefined)[] = [];

    await shipAfterMigrations(
      makeShipCtx({
        repoRoot: repo,
        branch: "run",
        noteDiff: (_l, _f, paths) => calls.push(paths),
        args: {
          retryEnabled: true,
          critiqueModel: "stub-critique",
          implementerModel: "stub-implementer",
          implementerTimeoutSec: 60,
          reviewerTimeoutSec: 60,
        },
        ctx: {
          ticketOrdinal: 1,
          issue: { branch: "issue-42", title: "a story" },
          // `typeLabel` + `requiredSkills` were what woke the old critique
          // stage; kept here so a revived stage would dispatch and fail this.
          typeLabel: "type:feature",
          requiredSkills: [SKILL],
        },
      }),
      sandbox as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha: handedPostSha,
        finalMarker: "ALL_CLEAR",
      },
    );

    expect(dispatched).toEqual([]);
    expect(calls[calls.length - 1]).toEqual(["src/a.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Which paths a diff REMOVED. Feeds the "no screen applies" guard, which may
// exempt a test file only while the ticket is writing or repairing it — a
// ticket that deletes test coverage must stop instead of shipping. Deleting a
// file and emptying it out are the same act to numstat, which is the point.
// ---------------------------------------------------------------------------

describe("parseGuttedFiles", () => {
  const rec = (added: string, deleted: string, path: string) =>
    `${added}\t${deleted}\t${path}`;

  it("reports a path that removes lines and adds none", () => {
    expect(parseGuttedFiles(rec("0", "40", "e2e/a.spec.ts"))).toEqual([
      "e2e/a.spec.ts",
    ]);
  });

  it("ignores a path that adds anything at all", () => {
    expect(parseGuttedFiles(rec("1", "40", "e2e/a.spec.ts"))).toEqual([]);
  });

  it("ignores a pure addition and an untouched-but-listed path", () => {
    expect(parseGuttedFiles(rec("12", "0", "e2e/new.spec.ts"))).toEqual([]);
    expect(parseGuttedFiles(rec("0", "0", "e2e/none.spec.ts"))).toEqual([]);
  });

  it("a BINARY file (-/-) is not gutted — it has no lines to remove", () => {
    expect(parseGuttedFiles(rec("-", "-", "assets/logo.png"))).toEqual([]);
  });

  it("picks only the gutted entries out of a multi-record payload", () => {
    const stdout = [
      rec("3", "1", "src/keep.ts"),
      rec("0", "9", "src/gone.test.ts"),
      rec("0", "0", "src/binary.png"),
      rec("0", "2", "e2e/gone.spec.ts"),
    ].join("\0");
    expect(parseGuttedFiles(stdout)).toEqual([
      "src/gone.test.ts",
      "e2e/gone.spec.ts",
    ]);
  });

  it("is total on empty and malformed input", () => {
    expect(parseGuttedFiles("")).toEqual([]);
    expect(parseGuttedFiles("\0\0")).toEqual([]);
    expect(parseGuttedFiles("no-tabs-here")).toEqual([]);
    expect(parseGuttedFiles("0\tonly-one-tab")).toEqual([]);
  });

  it("keeps a path containing spaces intact", () => {
    expect(parseGuttedFiles(rec("0", "5", "e2e/a b c.spec.ts"))).toEqual([
      "e2e/a b c.spec.ts",
    ]);
  });
});

describe("guttedFilesBetween — against a real git repo", () => {
  let repo: string;
  const commit = (files: Record<string, string>, message: string): string =>
    commitInto(repo, files, message);

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-gutted-"));
    git(repo, "init", "-q", "-b", "issue-955");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports a DELETED file", () => {
    const before = commit(
      { "e2e/a.spec.ts": "test('x', () => {});\n", "README.md": "seed\n" },
      "seed",
    );
    rmSync(path.join(repo, "e2e/a.spec.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "delete the spec");
    const after = git(repo, "rev-parse", "HEAD");
    expect(guttedFilesBetween(repo, before, after)).toEqual(["e2e/a.spec.ts"]);
  });

  it("reports an EMPTIED file — same act, file left behind", () => {
    const before = commit(
      { "e2e/a.spec.ts": "test('x', () => {});\ntest('y', () => {});\n" },
      "seed",
    );
    const after = commit({ "e2e/a.spec.ts": "" }, "empty the spec");
    expect(guttedFilesBetween(repo, before, after)).toEqual(["e2e/a.spec.ts"]);
  });

  it("does NOT report an ordinary repair", () => {
    const before = commit({ "e2e/a.spec.ts": "test('broken', () => {});\n" }, "seed");
    const after = commit(
      { "e2e/a.spec.ts": "test('fixed', () => {});\n" },
      "repair the spec",
    );
    expect(guttedFilesBetween(repo, before, after)).toEqual([]);
  });

  it("does NOT report a newly added file", () => {
    const before = commit({ "README.md": "seed\n" }, "seed");
    const after = commit({ "e2e/new.spec.ts": "test('n', () => {});\n" }, "add");
    expect(guttedFilesBetween(repo, before, after)).toEqual([]);
  });

  it("identical or blank refs describe an empty diff, so nothing was removed", () => {
    const sha = commit({ "README.md": "seed\n" }, "seed");
    expect(guttedFilesBetween(repo, sha, sha)).toEqual([]);
    expect(guttedFilesBetween(repo, "", sha)).toEqual([]);
    expect(guttedFilesBetween(repo, sha, "")).toEqual([]);
  });

  it("FAILS CLOSED: an unaskable git returns null, never an empty list", () => {
    // The difference that matters. Its neighbour reviewDiffStats returns
    // {0,[]} here; saying "nothing was removed" would silently re-open the
    // hole this function exists to close.
    commit({ "README.md": "seed\n" }, "seed");
    expect(guttedFilesBetween(repo, "nonexistent-ref-a", "nonexistent-ref-b")).toBeNull();
    expect(
      guttedFilesBetween(path.join(repo, "not-a-repo"), "HEAD~1", "HEAD"),
    ).toBeNull();
  });
});
