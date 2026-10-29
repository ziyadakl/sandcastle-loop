/**
 * Tests for the git half of the rework report.
 *
 * The point of this module having its own file at all: almost every rule below
 * is pinned from a `git log` STDOUT FIXTURE, with no temp repo and no real
 * commits. Two of them are rules a temp repo could not have proved cheaply —
 * that ten records cost ONE process, and that a single unparsable ship date
 * does not poison the walk bound for every other record in the store.
 *
 * TWO blocks at the bottom DO use a real repo, and have to: whether `--since`
 * prunes a traversal or filters it is a property of GIT, not of this code, and
 * a stdout fixture would only pin what we already believed. Those two also
 * cover `resolveMainRepoRoot`, whose whole bug class is what git prints
 * relative to WHICH directory.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GitRunner } from "../state/issue-lease.js";
import type { ReworkRecord } from "./rework-store.js";
import {
  commitInto,
  git as gitSync,
  gitWithEnv,
} from "../../__fixtures__/git-repo.js";
import {
  DEFAULT_GIT_MAX_BUFFER_BYTES,
  makeExecFileGitRunner,
} from "../state/index.js";
import {
  commitsInWindow,
  parseGitLog,
  placeInHistory,
  resolveMainRepoRoot,
  REWORK_GIT_MAX_BUFFER_BYTES,
  unionWindow,
  walkUnionWindow,
} from "./rework-history.js";
import { scoreIssueRework } from "./rework-rate.js";

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

describe("parseGitLog", () => {
  const commit = (
    sha: string,
    date: string,
    parents: string,
    body: string,
    files: string,
  ): string => `\0${sha}\x1f${date}\x1f${parents}\x1f${body}\x1f\n\n${files}\n`;

  it("reads sha, date, multi-line body and files", () => {
    const out = parseGitLog(
      commit(
        "abc",
        "2026-07-02T00:00:00Z",
        "p1",
        "fix: thing\n\nCloses #7",
        "src/a.ts\nsrc/b.ts",
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sha: "abc", isMerge: false });
    // The BODY, not just the subject — Part 2's attribution rule reads "Closes #7".
    expect(out[0]?.message).toContain("Closes #7");
    expect(out[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("flags a two-parent commit as a merge", () => {
    const out = parseGitLog(
      commit("m", "2026-07-02T00:00:00Z", "p1 p2", "merge", ""),
    );
    expect(out[0]?.isMerge).toBe(true);
  });

  it("skips damaged chunks instead of throwing", () => {
    expect(parseGitLog("\0garbage-with-no-fields")).toEqual([]);
    expect(parseGitLog("")).toEqual([]);
  });

  it("keeps the file list when the MESSAGE contains the field separator", () => {
    // Nothing stops an author pasting \x1f into a body. Counting separators
    // shifted every field by one and read a FRAGMENT OF THE MESSAGE as the
    // file list — so the commit's real files vanished, and files that never
    // existed could not match anything, which understates rework.
    const out = parseGitLog(
      commit(
        "abc",
        "2026-07-02T00:00:00Z",
        "p1",
        "fix: thing\n\nbody with \x1f a separator\n\nCloses #42",
        "src/a.ts\nsrc/b.ts",
      ),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
    // And the body survives WHOLE, separator included — Part 2 reads it for
    // "Closes #42" and for revert detection.
    expect(out[0]?.message).toContain("body with \x1f a separator");
    expect(out[0]?.message).toContain("Closes #42");
  });
});
// ---------------------------------------------------------------------------
// THE GIT WALK. One process for the whole store, not one per record — and
// testable from a stdout fixture rather than a temp repo, which is the second
// reason the union walk is worth having.
// ---------------------------------------------------------------------------
describe("unionWindow", () => {
  it("reaches the LAST window end across every record", () => {
    const window = unionWindow(
      [
        record({ issueNumber: 1, shippedAtIso: "2026-07-10T00:00:00.000Z" }),
        record({ issueNumber: 2, shippedAtIso: "2026-07-01T00:00:00.000Z" }),
      ],
      14,
    );
    // 2026-07-10 + 14d, plus the one-minute over-fetch slack.
    expect(window?.untilIso).toBe("2026-07-24T00:01:00.000Z");
  });

  it("offers no lower bound at all — `--since` would PRUNE the walk", () => {
    // Not a style point. `--since` stops git descending a line of history, so
    // an in-window commit under an older-committer-date commit is never
    // reached; see the real-repo block at the bottom of this file for the
    // proof. This asserts the shape the walk can therefore depend on.
    const window = unionWindow([record()], 14);
    expect(window).toEqual({ untilIso: expect.any(String) });
  });

  it("is not poisoned by ONE unparsable ship date", () => {
    // `Math.max(NaN, x)` is `NaN`, which would render an invalid `--until` and
    // make git reject the walk for every OTHER record too.
    const window = unionWindow(
      [
        record({ issueNumber: 1, shippedAtIso: "not a date" }),
        record({ issueNumber: 2, shippedAtIso: "2026-07-01T00:00:00.000Z" }),
      ],
      14,
    );
    expect(window?.untilIso).toBe("2026-07-15T00:01:00.000Z");
  });

  it("is undefined when NOTHING is parsable, rather than a bad bound", () => {
    expect(unionWindow([record({ shippedAtIso: "nope" })], 14)).toBeUndefined();
    expect(unionWindow([], 14)).toBeUndefined();
  });
});

describe("commitsInWindow", () => {
  const at = (dateIso: string) => ({
    sha: "x",
    dateIso,
    message: "m",
    files: [],
  });
  const shipMs = Date.parse("2026-07-01T00:00:00.000Z");

  it("keeps the boundaries and drops what is outside them", () => {
    const kept = commitsInWindow(
      [
        at("2026-06-30T23:59:00.000Z"), // before the ship
        at("2026-07-01T00:00:00.000Z"), // exactly at it
        at("2026-07-08T00:00:00.000Z"), // inside
        at("2026-07-15T00:00:00.000Z"), // exactly at ship + 14d
        at("2026-07-20T00:00:00.000Z"), // past the window
        at("not a date"),
      ],
      shipMs,
      14,
    );
    expect(kept.map((c) => c.dateIso)).toEqual([
      "2026-07-01T00:00:00.000Z",
      "2026-07-08T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
    ]);
  });

  it("drops the commit AT the ship instant when asked to bound strictly", () => {
    // The date-only self-exclusion. See `placeInHistory`: with no sha that
    // identifies the ship commit in the walk, its timestamp is the only thing
    // left that does.
    const kept = commitsInWindow(
      [at("2026-07-01T00:00:00.000Z"), at("2026-07-01T00:00:00.001Z")],
      shipMs,
      14,
      true,
    );
    expect(kept.map((c) => c.dateIso)).toEqual(["2026-07-01T00:00:00.001Z"]);
  });
});

describe("walkUnionWindow — ONE process for the whole store", () => {
  const commit = (sha: string, date: string, body: string, files: string) =>
    `\0${sha}\x1f${date}\x1f p \x1f${body}\x1f\n\n${files}\n`;

  function spyRunner(
    stdout: string,
    ok = true,
  ): {
    runner: GitRunner;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const runner: GitRunner = (_cwd, ...gitArgs) => {
      calls.push(gitArgs);
      return Promise.resolve({ ok, stdout, stderr: ok ? "" : "boom" });
    };
    return { runner, calls };
  }

  it("spawns exactly one git log for many records", async () => {
    // The rule `run` states and used to break in the same breath: never fan out
    // a process per record. Ten records, one walk.
    const { runner, calls } = spyRunner(
      commit("b".repeat(40), "2026-07-03T00:00:00.000Z", "fix", "src/a.ts"),
    );
    const records = Array.from({ length: 10 }, (_, i) =>
      record({ issueNumber: i + 1 }),
    );
    const out = await walkUnionWindow(runner, "/repo", records, 14);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("log");
    expect(calls[0]).toContain("HEAD");
    expect(out.commits).toHaveLength(1);
    expect(out.error).toBeUndefined();
  });

  it("reports a failed walk once, rather than per record", async () => {
    const { runner } = spyRunner("", false);
    const out = await walkUnionWindow(runner, "/repo", [record()], 14);
    expect(out.error).toContain("git log failed");
    expect(out.commits).toEqual([]);
  });

  it("names the buffer when git's output outgrew it, rather than 'unknown error'", async () => {
    // The failure mode this whole constant exists for: git SUCCEEDED and Node
    // threw the output away, so stderr is EMPTY. Read off stderr alone the
    // report would tell every reader "unknown error" while the entire metric
    // went dark. Detected by CODE — the message text is Node's prose.
    const runner: GitRunner = () =>
      Promise.resolve({
        ok: false,
        stdout: "",
        stderr: "",
        errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      });
    const out = await walkUnionWindow(runner, "/repo", [record()], 14);
    expect(out.commits).toEqual([]);
    expect(out.error).not.toContain("unknown error");
    // It must say WHAT happened and WHAT to change, not merely fail loudly.
    expect(out.error).toContain(String(REWORK_GIT_MAX_BUFFER_BYTES));
    expect(out.error).toContain("REWORK_GIT_MAX_BUFFER_BYTES");
  });

  it("still reports an ordinary git failure off stderr", async () => {
    // The overflow branch is an ADDITION. A real `fatal:` still has to surface
    // its own text — an exit-128 code must not be mistaken for an overflow.
    const runner: GitRunner = () =>
      Promise.resolve({
        ok: false,
        stdout: "",
        stderr: "fatal: bad revision\n",
        errorCode: 128,
      });
    const out = await walkUnionWindow(runner, "/repo", [record()], 14);
    expect(out.error).toContain("fatal: bad revision");
    expect(out.error).not.toContain("REWORK_GIT_MAX_BUFFER_BYTES");
  });

  it("asks for more headroom than the default every other git call gets", async () => {
    // The wiring at `rework-report.mts`'s runner is what keeps the walk off the
    // shared default; this pins the invariant that makes that wiring worth
    // doing. The walk is unbounded from HEAD, so it is the one caller whose
    // output grows with the repository.
    expect(REWORK_GIT_MAX_BUFFER_BYTES).toBeGreaterThan(
      DEFAULT_GIT_MAX_BUFFER_BYTES,
    );
  });

  it("runs no git at all when no record has a usable date", async () => {
    const { runner, calls } = spyRunner("");
    const out = await walkUnionWindow(
      runner,
      "/repo",
      [record({ shippedAtIso: "nope" })],
      14,
    );
    expect(calls).toHaveLength(0);
    expect(out).toEqual({ commits: [] });
  });
});
describe("placeInHistory — an unresolvable ship sha is not a reason to drop", () => {
  const later = [
    {
      sha: "d".repeat(40),
      dateIso: "2026-07-03T00:00:00.000Z",
      message: "fix: correct the thing",
      files: ["src/a.ts"],
    },
  ];

  /** `rev-parse` cannot find the object; everything else would have worked. */
  const unknownSha: GitRunner = (_cwd, ...gitArgs) =>
    Promise.resolve(
      gitArgs[0] === "rev-parse"
        ? { ok: false, stdout: "", stderr: "" }
        : { ok: true, stdout: "", stderr: "" },
    );

  it("falls back to the date-bounded reading instead of dropping the record", async () => {
    // The normal case on a shallow clone, and for every lane that never merged.
    // The record already carries a ship DATE and a file list — everything the
    // scorer needs; the sha was only ever wanted so the ship commit could be
    // excluded from its own rework set.
    const history = await placeInHistory(
      unknownSha,
      "/repo",
      record({ issueNumber: 5, changedFilePaths: ["src/a.ts"] }),
      later,
      14,
    );
    expect(history.mode).toBe("date-only");
    expect(history.laterCommits).toHaveLength(1);
    expect(history.note).toContain("not in this clone");
    expect(history.note).toContain("scored by date only");
    // No full sha to hand on — and none is needed: an object git cannot
    // resolve is not in this clone, so it cannot be in the walk either.
    expect(history.resolvedSha).toBeUndefined();
  });

  it("still refuses to walk anything for an unparsable ship date", async () => {
    const history = await placeInHistory(
      unknownSha,
      "/repo",
      record({ issueNumber: 6, shippedAtIso: "whenever" }),
      later,
      14,
    );
    expect(history.laterCommits).toEqual([]);
    expect(history.note).toContain("ship date unparsable");
  });
});

// ---------------------------------------------------------------------------
// The two branches `placeInHistory` takes when the sha DOES resolve, and the
// rule that spans all three: a ship is never its own rework.
// ---------------------------------------------------------------------------
describe("placeInHistory — the resolvable-sha branches", () => {
  const SHORT = "abc1234";
  const FULL = `${"e".repeat(33)}1234567`;

  /**
   * A runner that resolves `SHORT` to `FULL`, and answers `--is-ancestor` with
   * `isAncestor`. Everything else succeeds emptily.
   */
  function runnerFor(isAncestor: boolean): GitRunner {
    return (_cwd, ...gitArgs) => {
      if (gitArgs[0] === "rev-parse") {
        return Promise.resolve({ ok: true, stdout: `${FULL}\n`, stderr: "" });
      }
      if (gitArgs[0] === "merge-base") {
        return Promise.resolve({ ok: isAncestor, stdout: "", stderr: "" });
      }
      return Promise.resolve({ ok: true, stdout: "", stderr: "" });
    };
  }

  const later = [
    {
      sha: FULL,
      dateIso: "2026-07-01T00:00:00.000Z",
      message: "SANDCASTLE(it=1 issue=9): ship it",
      files: ["src/a.ts"],
    },
    {
      sha: "f".repeat(40),
      dateIso: "2026-07-03T00:00:00.000Z",
      message: "fix: correct the thing",
      files: ["src/a.ts"],
    },
  ];

  it("labels an ancestor ship `ancestry` and keeps the ship-instant commit", async () => {
    const history = await placeInHistory(
      runnerFor(true),
      "/repo",
      record({ issueNumber: 9, shippedSha: SHORT }),
      later,
      14,
    );
    expect(history.mode).toBe("ancestry");
    expect(history.note).toBeUndefined();
    // Inclusive lower bound survives here, because Part 2's sha match is exact:
    // it removes THE ship commit and nothing else.
    expect(history.laterCommits.map((c) => c.sha)).toEqual([
      FULL,
      "f".repeat(40),
    ]);
  });

  it("expands a SHORT ship sha to the full one Part 2 compares against", async () => {
    // `%H` is always 40 chars, so a short sha never matches and the ship commit
    // would be scored as rework of its own files — a 100% row.
    const history = await placeInHistory(
      runnerFor(true),
      "/repo",
      record({ issueNumber: 9, shippedSha: SHORT }),
      later,
      14,
    );
    expect(history.resolvedSha).toBe(FULL);
    expect(history.resolvedSha).not.toBe(SHORT);
  });

  it("a non-ancestor ship is date-only AND excluded from its own rework", async () => {
    // The squash-merge shape: the recorded lane commit resolves but is not on
    // HEAD, while the same work sits on HEAD under a DIFFERENT sha at the same
    // instant. Excluding by sha cannot see it; the timestamp bound must.
    const history = await placeInHistory(
      runnerFor(false),
      "/repo",
      record({ issueNumber: 9, shippedSha: SHORT }),
      later,
      14,
    );
    expect(history.mode).toBe("date-only");
    expect(history.laterCommits.map((c) => c.sha)).toEqual(["f".repeat(40)]);
  });

  it("an UNRESOLVABLE ship sha is excluded from its own rework too", async () => {
    const unknownSha: GitRunner = (_cwd, ...gitArgs) =>
      Promise.resolve(
        gitArgs[0] === "rev-parse"
          ? { ok: false, stdout: "", stderr: "" }
          : { ok: true, stdout: "", stderr: "" },
      );
    const history = await placeInHistory(
      unknownSha,
      "/repo",
      record({ issueNumber: 9, shippedSha: SHORT }),
      later,
      14,
    );
    expect(history.mode).toBe("date-only");
    expect(history.laterCommits.map((c) => c.sha)).toEqual(["f".repeat(40)]);
  });

  it("END TO END: a date-only ship does not score 100% against itself", async () => {
    // The shape the reviewer reproduced — a row reading 100% at 0.0d, where the
    // only "rework" was the issue's own shipping commit. Scored through Part 2
    // exactly as `rework-report.mts` does, with a message that names no issue
    // number so the attribution filter cannot be what saves it.
    const shipOnly = [
      {
        sha: "0".repeat(40),
        dateIso: "2026-07-01T00:00:00.000Z",
        message: "Merge pull request #4141 from lane",
        files: ["src/a.ts", "src/b.ts"],
      },
    ];
    const history = await placeInHistory(
      runnerFor(false),
      "/repo",
      record({
        issueNumber: 9,
        shippedSha: SHORT,
        changedFilePaths: ["src/a.ts", "src/b.ts"],
      }),
      shipOnly,
      14,
    );
    const score = scoreIssueRework(
      {
        record: {
          issueNumber: 9,
          shippedAtIso: "2026-07-01T00:00:00.000Z",
          shippedSha: history.resolvedSha ?? SHORT,
          changedFilePaths: ["src/a.ts", "src/b.ts"],
          outcome: "shipped",
        },
        laterCommits: history.laterCommits,
      },
      { nowIso: "2026-09-01T00:00:00.000Z" },
    );
    expect(score.reworkRate).toBe(0);
    expect(score.reworkedFilePaths).toEqual([]);
    expect(score.daysToFirstRework).toBeNull();
  });

  it("END TO END: a ship RE-LANDED seconds later is not its own rework either", async () => {
    // The shape that actually occurs. `shippedAtIso` is the clock at record
    // time (milliseconds); `%cI` is second-granular and the squash onto the
    // integration branch happens AFTER the record is written — so the re-landed
    // ship sits a few seconds past the ship instant, where the strict timestamp
    // bound no longer reaches it. What catches it is attribution: a squash
    // concatenates the lane's `SANDCASTLE(… issue=N)` subjects, and Part 2's
    // `referencesIssue` matches `issue=N` with no `#`. This pins that defence
    // in the date-only context, where it is the one doing the work.
    const reLanded = [
      {
        sha: "0".repeat(40),
        dateIso: "2026-07-01T00:00:30.000Z",
        message:
          "chore: promote lane\n\nSANDCASTLE(it=1 issue=9): ship it\nSANDCASTLE(it=1 issue=9): fix the review note",
        files: ["src/a.ts", "src/b.ts"],
      },
    ];
    const history = await placeInHistory(
      runnerFor(false),
      "/repo",
      record({
        issueNumber: 9,
        shippedSha: SHORT,
        changedFilePaths: ["src/a.ts", "src/b.ts"],
      }),
      reLanded,
      14,
    );
    // The timestamp bound does NOT save this one — the commit is genuinely in
    // the window — so the assertion below is about attribution alone.
    expect(history.laterCommits).toHaveLength(1);
    const score = scoreIssueRework(
      {
        record: {
          issueNumber: 9,
          shippedAtIso: "2026-07-01T00:00:00.000Z",
          shippedSha: history.resolvedSha ?? SHORT,
          changedFilePaths: ["src/a.ts", "src/b.ts"],
          outcome: "shipped",
        },
        laterCommits: history.laterCommits,
      },
      { nowIso: "2026-09-01T00:00:00.000Z" },
    );
    expect(score.reworkRate).toBe(0);
    expect(score.reworkedFilePaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The blocks that need a REAL repository. Everything above pins this code's own
// rules; these two pin properties of GIT that this code depends on and that a
// stdout fixture could only restate.
// ---------------------------------------------------------------------------
describe("resolveMainRepoRoot — where git measures `--git-common-dir` FROM", () => {
  it("resolves a relative common-dir against the CWD, not the toplevel", async () => {
    // git prints `--git-common-dir` relative to the directory the command ran
    // in. Resolving `../.git` against the TOPLEVEL walks a level above the
    // repo; the report then finds no store there and prints "no data yet".
    const runner: GitRunner = (_cwd, ...gitArgs) =>
      Promise.resolve({
        ok: true,
        stdout: gitArgs.includes("--show-toplevel") ? "/repo\n" : "../.git\n",
        stderr: "",
      });
    expect(await resolveMainRepoRoot(runner, "/repo/sub")).toBe("/repo");
  });

  it("takes an ABSOLUTE common-dir as-is — the linked-worktree case", async () => {
    const runner: GitRunner = (_cwd, ...gitArgs) =>
      Promise.resolve({
        ok: true,
        stdout: gitArgs.includes("--show-toplevel")
          ? "/repo/.sandcastle/worktrees/lane\n"
          : "/repo/.git\n",
        stderr: "",
      });
    expect(
      await resolveMainRepoRoot(runner, "/repo/.sandcastle/worktrees/lane"),
    ).toBe("/repo");
  });

  it("falls back to the toplevel when git cannot answer the second question", async () => {
    const runner: GitRunner = (_cwd, ...gitArgs) =>
      Promise.resolve(
        gitArgs.includes("--show-toplevel")
          ? { ok: true, stdout: "/repo\n", stderr: "" }
          : { ok: false, stdout: "", stderr: "boom" },
      );
    expect(await resolveMainRepoRoot(runner, "/repo/sub")).toBe("/repo");
  });

  it("is undefined outside a repository, rather than a guess", async () => {
    const runner: GitRunner = () =>
      Promise.resolve({ ok: false, stdout: "", stderr: "not a git repo" });
    expect(await resolveMainRepoRoot(runner, "/tmp")).toBeUndefined();
  });

  it("finds THIS repo's root from a subdirectory, against real git", async () => {
    // The reproduction that started this: run from `.sandcastle/scripts`, where
    // git prints `../../.git`.
    //
    // Compare against the MAIN worktree's root, NOT `--show-toplevel`. Inside a
    // linked worktree (`.sandcastle/worktrees/<lane>`, which CLAUDE.md tells
    // sessions to use for parallel work) `--show-toplevel` is the throwaway
    // checkout, while `resolveMainRepoRoot` returns the shared repo root BY
    // DESIGN — so the old assertion failed the pre-merge gate for anyone running
    // it from a worktree. `git worktree list --porcelain` names the main
    // worktree on its first line, an oracle independent of `resolveMainRepoRoot`'s
    // own `--git-common-dir` walk, so this still proves behaviour rather than
    // restating the implementation. It also holds from the main checkout, where
    // the main worktree and the current worktree are one and the same.
    const here = path.dirname(new URL(import.meta.url).pathname);
    const root = await resolveMainRepoRoot(makeExecFileGitRunner(), here);
    const mainWorktreeRoot = gitSync(here, "worktree", "list", "--porcelain")
      .split("\n")[0]
      .replace(/^worktree /, "");
    expect(root).toBe(mainWorktreeRoot);
  });
});

describe("walkUnionWindow against a real repo — `--since` would PRUNE", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "rework-walk-"));
    execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
    gitSync(repo, "config", "user.email", "t@t");
    gitSync(repo, "config", "user.name", "t");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /** Commit one file with a forged AUTHOR and COMMITTER date. */
  function commitAt(name: string, iso: string, message: string): void {
    execFileSync("sh", ["-c", `printf '%s\\n' "${iso}" > ${name}`], {
      cwd: repo,
    });
    gitSync(repo, "add", "-A");
    gitWithEnv(
      repo,
      { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
      "commit",
      "-q",
      "-m",
      message,
    );
  }

  it("returns an in-window commit hidden under an older-committer-date one", async () => {
    // c2's committer date is INSIDE the window but it sits under c3, whose
    // committer date is months older — exactly what a rebase or cherry-pick
    // leaves behind. `--since` stops descending at c3 and c2 is never reached,
    // so its rework never enters the numerator and the rate reads LOW.
    commitAt("c1.txt", "2026-02-01T00:00:00Z", "c1");
    commitAt("c2.txt", "2026-06-01T00:00:00Z", "c2");
    commitAt("c3.txt", "2026-03-01T00:00:00Z", "c3");
    commitAt("c4.txt", "2026-07-01T00:00:00Z", "c4");

    const out = await walkUnionWindow(
      makeExecFileGitRunner(),
      repo,
      [record({ shippedAtIso: "2026-05-01T00:00:00.000Z" })],
      120,
    );
    expect(out.error).toBeUndefined();
    // Everything at or below the `--until` bound (2026-08-29 + slack), newest
    // first. c2 is the one a `--since` walk would have lost.
    expect(out.commits.map((c) => c.message.trim())).toEqual([
      "c4",
      "c3",
      "c2",
      "c1",
    ]);
  });

  it("carries a REAL buffer overflow all the way to a diagnosable message", async () => {
    // End-to-end over real git and real Node, because the two halves of this
    // fix only work together: the adapter has to accept a cap AND surface the
    // machine code, and the walk has to recognise it. A 16-byte cap forces the
    // same rejection a repo that outgrew the real cap would produce — git
    // succeeds, Node discards the output, stderr is EMPTY. If either half is
    // removed this reads "unknown error", which is what shipped before.
    commitAt("c1.txt", "2026-02-01T00:00:00Z", "c1");

    const out = await walkUnionWindow(
      makeExecFileGitRunner(16),
      repo,
      [record({ shippedAtIso: "2026-02-01T00:00:00.000Z" })],
      14,
    );
    expect(out.commits).toEqual([]);
    expect(out.error).not.toContain("unknown error");
    expect(out.error).toContain("REWORK_GIT_MAX_BUFFER_BYTES");

    // Same repo, same walk, the default cap: it is the CAP that failed, not
    // the repository or the arguments.
    const ok = await walkUnionWindow(
      makeExecFileGitRunner(),
      repo,
      [record({ shippedAtIso: "2026-02-01T00:00:00.000Z" })],
      14,
    );
    expect(ok.error).toBeUndefined();
    expect(ok.commits).toHaveLength(1);
  });

  it("still applies `--until` as a real filter, dropping what is past it", async () => {
    commitAt("c1.txt", "2026-02-01T00:00:00Z", "c1");
    commitAt("c2.txt", "2026-12-01T00:00:00Z", "way past the window");

    const out = await walkUnionWindow(
      makeExecFileGitRunner(),
      repo,
      [record({ shippedAtIso: "2026-02-01T00:00:00.000Z" })],
      14,
    );
    expect(out.commits.map((c) => c.message.trim())).toEqual(["c1"]);
  });

  it("reads a `\\x1f`-bearing body and its file list from REAL git output", async () => {
    // The fixture above proves the parser; this proves the FORMAT it is fed —
    // that git really does emit a raw \x1f from `%B` and really does escape one
    // in a path, so the last separator is reliably the message/files boundary.
    commitInto(repo, { "src/a.ts": "a\n" }, "seed");
    commitAt(
      "src-b.txt",
      "2026-07-02T00:00:00Z",
      "fix: thing\n\nbody \x1f here",
    );

    const out = await walkUnionWindow(
      makeExecFileGitRunner(),
      repo,
      [record({ shippedAtIso: "2026-07-01T00:00:00.000Z" })],
      14,
    );
    const commit = out.commits.find((c) => c.message.includes("fix: thing"));
    expect(commit?.files).toEqual(["src-b.txt"]);
    expect(commit?.message).toContain("body \x1f here");
  });
});
