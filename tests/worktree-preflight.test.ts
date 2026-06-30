/**
 * Boot-time defensive worktree-health pass (audit issue #1).
 *
 * A single corrupt git worktree (e.g. a `00000000` dir whose `.git` link is
 * gone, producing `git worktree list` -> `couldn't read .git/packed-refs`)
 * used to kill the whole loop: the fatal `git worktree list --porcelain` runs
 * INSIDE the vendored SDK (`WorktreeManager.create` -> `listWorktrees`) which
 * throws with no catch. The template can't patch the vendored SDK, so we prune
 * the corrupt entry at boot — BEFORE the first `createSandbox` — so the SDK's
 * enumeration succeeds.
 *
 * These tests drive the extracted helpers with a faked git interface so we
 * never need a real corrupt repo:
 *   - `selectCorruptWorktrees` — pure: given parsed entries + an existence
 *     check, return the set of paths to prune.
 *   - `pruneCorruptWorktrees` — orchestration: best-effort, NON-THROWING. Even
 *     when `git worktree list` fails (the corrupt-packed-refs symptom) it must
 *     prune and never throw.
 */
import { describe, it, expect } from "vitest";
import {
  selectCorruptWorktrees,
  pruneCorruptWorktrees,
  type GitRunResult,
} from "../.sandcastle/main.mjs";

describe("selectCorruptWorktrees (pure)", () => {
  it("flags worktree entries whose directory is missing", () => {
    const entries = [
      { path: "/repo/.sandcastle/worktrees/issue-12", branch: "refs/heads/issue-12" },
      { path: "/repo/.sandcastle/worktrees/00000000", branch: null },
      { path: "/repo", branch: "refs/heads/main" },
    ];
    // Only the live launch worktree (/repo) and one issue worktree exist; the
    // 00000000 entry's dir is gone (orphaned registration).
    const exists = (p: string) =>
      p === "/repo" || p === "/repo/.sandcastle/worktrees/issue-12";
    expect(selectCorruptWorktrees(entries, exists).sort()).toEqual([
      "/repo/.sandcastle/worktrees/00000000",
    ]);
  });

  it("returns nothing when every worktree directory exists", () => {
    const entries = [
      { path: "/repo", branch: "refs/heads/main" },
      { path: "/repo/.sandcastle/worktrees/staging", branch: "refs/heads/integration-candidate" },
    ];
    expect(selectCorruptWorktrees(entries, () => true)).toEqual([]);
  });

  it("never selects the launch repo root even if the existence check is flaky", () => {
    // Defensive: the repo root is passed and must never be pruned.
    const entries = [{ path: "/repo", branch: "refs/heads/main" }];
    expect(selectCorruptWorktrees(entries, () => false, "/repo")).toEqual([]);
  });
});

describe("pruneCorruptWorktrees (orchestration, non-throwing)", () => {
  function makeFakeGit(opts: {
    listResult: GitRunResult;
    onCall?: (args: string[]) => void;
  }) {
    const calls: string[][] = [];
    const fakeGit = (_repoRoot: string, ...gitArgs: string[]): GitRunResult => {
      calls.push(gitArgs);
      opts.onCall?.(gitArgs);
      if (gitArgs[0] === "worktree" && gitArgs[1] === "list") {
        return opts.listResult;
      }
      // prune / remove succeed by default.
      return { ok: true, stdout: "", stderr: "" };
    };
    return { fakeGit, calls };
  }

  it("prunes when `git worktree list` FAILS (corrupt packed-refs) and does NOT throw", () => {
    const logs: string[] = [];
    const removed: string[] = [];
    const { fakeGit, calls } = makeFakeGit({
      listResult: {
        ok: false,
        stdout: "",
        stderr: "fatal: couldn't read .git/packed-refs",
      },
    });

    expect(() =>
      pruneCorruptWorktrees("/repo", (s) => logs.push(s), {
        git: fakeGit,
        exists: () => true,
        rm: (p) => removed.push(p),
      }),
    ).not.toThrow();

    // It must have attempted a `git worktree prune` to clear the bad
    // registration so the SDK's enumeration can succeed.
    expect(calls.some((c) => c[0] === "worktree" && c[1] === "prune")).toBe(true);
    expect(logs.join("\n")).toMatch(/worktree/i);
  });

  it("removes an orphaned worktree (registered but dir gone)", () => {
    const logs: string[] = [];
    const removed: string[] = [];
    const listStdout = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/.sandcastle/worktrees/00000000",
      "HEAD 000",
      "detached",
    ].join("\n");
    const { fakeGit, calls } = makeFakeGit({
      listResult: { ok: true, stdout: listStdout, stderr: "" },
    });

    pruneCorruptWorktrees("/repo", (s) => logs.push(s), {
      git: fakeGit,
      // launch root exists; the 00000000 dir is gone.
      exists: (p) => p === "/repo",
      rm: (p) => removed.push(p),
    });

    // It must have force-removed the orphan registration AND rm'd the path.
    const orphan = "/repo/.sandcastle/worktrees/00000000";
    expect(
      calls.some(
        (c) =>
          c[0] === "worktree" &&
          c[1] === "remove" &&
          c.includes("--force") &&
          c.includes(orphan),
      ),
    ).toBe(true);
    expect(removed).toContain(orphan);
  });

  it("does nothing destructive when all worktrees are healthy", () => {
    const logs: string[] = [];
    const removed: string[] = [];
    const listStdout = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
    ].join("\n");
    const { fakeGit, calls } = makeFakeGit({
      listResult: { ok: true, stdout: listStdout, stderr: "" },
    });

    pruneCorruptWorktrees("/repo", (s) => logs.push(s), {
      git: fakeGit,
      exists: () => true,
      rm: (p) => removed.push(p),
    });

    expect(calls.some((c) => c[1] === "remove")).toBe(false);
    expect(calls.some((c) => c[1] === "prune")).toBe(false);
    expect(removed).toEqual([]);
  });

  it("swallows a throw from the injected git interface (never fatal)", () => {
    const logs: string[] = [];
    const throwingGit = (): GitRunResult => {
      throw new Error("boom from git interface");
    };
    expect(() =>
      pruneCorruptWorktrees("/repo", (s) => logs.push(s), {
        git: throwingGit,
        exists: () => true,
        rm: () => {},
      }),
    ).not.toThrow();
    expect(logs.join("\n")).toMatch(/worktree/i);
  });
});
