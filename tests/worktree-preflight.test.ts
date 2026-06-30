/**
 * Boot-time worktree-health pass + lazy createSandbox repair (audit issue #1).
 *
 * A single corrupt git worktree (e.g. a `00000000` dir whose `.git` link is
 * gone, producing `git worktree list` -> `couldn't read .git/packed-refs`)
 * used to kill the whole loop: the fatal `git worktree list --porcelain` runs
 * INSIDE the vendored SDK (`WorktreeManager.create` -> `listWorktrees`) which
 * throws with no catch. The template can't patch the vendored SDK.
 *
 * SAFEST-REBUILD shape (this rework):
 *   - `pruneCorruptWorktrees` is now NON-DESTRUCTIVE: a cheap, harmless boot
 *     `git worktree prune` that clears dangling administrative registrations.
 *     It NEVER calls `git worktree remove --force` and NEVER `rm`s a directory,
 *     so a sibling loop's live worktree that momentarily fails an `existsSync`
 *     check can no longer be force-deleted (the old DATA-LOSS bug A).
 *   - `createSandboxWithWorktreeRepair` wraps the FIRST sandbox-create: try
 *     once, and on a worktree-enumeration failure run `git worktree prune`
 *     ONCE and retry the create ONCE. If it STILL fails, throw a CLEAR,
 *     actionable error (it never deletes a worktree and never loops). This is
 *     what actually repairs the dir-present-but-internally-corrupt case the
 *     old `existsSync` detector structurally couldn't see (bug B).
 *
 * These tests drive the extracted helpers with injected git + create stubs so
 * we never need a real corrupt repo.
 */
import { describe, it, expect } from "vitest";
import {
  pruneCorruptWorktrees,
  createSandboxWithWorktreeRepair,
  type GitRunResult,
  type SandboxHandle,
} from "../.sandcastle/main.mjs";

function fakeHandle(branch = "issue-1"): SandboxHandle {
  return {
    branch,
    worktreePath: `/repo/.sandcastle/worktrees/${branch}`,
    run: async () => {
      throw new Error("not used in these tests");
    },
    close: async () => undefined,
  };
}

describe("pruneCorruptWorktrees (non-destructive boot pass)", () => {
  function makeFakeGit() {
    const calls: string[][] = [];
    const fakeGit = (_repoRoot: string, ...gitArgs: string[]): GitRunResult => {
      calls.push(gitArgs);
      return { ok: true, stdout: "", stderr: "" };
    };
    return { fakeGit, calls };
  }

  it("runs a cheap `git worktree prune` at boot", () => {
    const logs: string[] = [];
    const { fakeGit, calls } = makeFakeGit();

    pruneCorruptWorktrees("/repo", (s) => logs.push(s), { git: fakeGit });

    expect(calls.some((c) => c[0] === "worktree" && c[1] === "prune")).toBe(
      true,
    );
  });

  it("NEVER force-removes a worktree and NEVER rm's a directory (no destructive path at all)", () => {
    const logs: string[] = [];
    const { fakeGit, calls } = makeFakeGit();

    // The remedy deletes the destructive deps entirely, so `pruneCorruptWorktrees`
    // no longer accepts an `exists`/`rm` injection point. Even calling it the way
    // the boot sequence does (git only) must produce zero destructive git ops.
    pruneCorruptWorktrees("/repo", (s) => logs.push(s), { git: fakeGit });

    expect(
      calls.some((c) => c[0] === "worktree" && c[1] === "remove"),
    ).toBe(false);
    expect(
      calls.some((c) => c.includes("--force")),
    ).toBe(false);
  });

  it("never throws even when the injected git interface throws", () => {
    const logs: string[] = [];
    const throwingGit = (): GitRunResult => {
      throw new Error("boom from git interface");
    };
    expect(() =>
      pruneCorruptWorktrees("/repo", (s) => logs.push(s), { git: throwingGit }),
    ).not.toThrow();
  });

  it("never throws when `git worktree prune` itself fails (corrupt packed-refs)", () => {
    const logs: string[] = [];
    const failingPrune = (): GitRunResult => ({
      ok: false,
      stdout: "",
      stderr: "fatal: couldn't read .git/packed-refs",
    });
    expect(() =>
      pruneCorruptWorktrees("/repo", (s) => logs.push(s), { git: failingPrune }),
    ).not.toThrow();
  });
});

describe("createSandboxWithWorktreeRepair (lazy retry-once on enumeration failure)", () => {
  function makeFakeGit() {
    const calls: string[][] = [];
    const fakeGit = (_repoRoot: string, ...gitArgs: string[]): GitRunResult => {
      calls.push(gitArgs);
      return { ok: true, stdout: "", stderr: "" };
    };
    return { fakeGit, calls };
  }

  it("(happy path) returns the handle on the first try — no prune, no retry, no error", async () => {
    const { fakeGit, calls } = makeFakeGit();
    let createCount = 0;
    const handle = fakeHandle();

    const result = await createSandboxWithWorktreeRepair(
      async () => {
        createCount += 1;
        return handle;
      },
      fakeGit,
      "/repo",
      () => {},
    );

    expect(result).toBe(handle);
    expect(createCount).toBe(1);
    expect(calls.some((c) => c[1] === "prune")).toBe(false);
  });

  it("on a first-try enumeration failure, prunes ONCE then retries ONCE and succeeds", async () => {
    const { fakeGit, calls } = makeFakeGit();
    let createCount = 0;
    const handle = fakeHandle();

    const result = await createSandboxWithWorktreeRepair(
      async () => {
        createCount += 1;
        if (createCount === 1) {
          throw new Error("couldn't read .git/packed-refs");
        }
        return handle;
      },
      fakeGit,
      "/repo",
      () => {},
    );

    expect(result).toBe(handle);
    expect(createCount).toBe(2); // first fail + one retry
    // Exactly one prune between the two attempts.
    expect(calls.filter((c) => c[1] === "prune").length).toBe(1);
  });

  it("when create fails on BOTH tries AND prune fails too, surfaces a CLEAR actionable error and deletes NOTHING", async () => {
    const calls: string[][] = [];
    // The dir-present-but-internally-corrupt case: enumeration fails twice and
    // `git worktree prune` fails the SAME packed-refs way — the loop CANNOT
    // auto-repair and must surface a clear, actionable error rather than die
    // silently. Crucially it must never run a destructive op.
    const failingGit = (_repoRoot: string, ...gitArgs: string[]): GitRunResult => {
      calls.push(gitArgs);
      return {
        ok: false,
        stdout: "",
        stderr: "fatal: couldn't read .git/packed-refs",
      };
    };
    let createCount = 0;

    await expect(
      createSandboxWithWorktreeRepair(
        async () => {
          createCount += 1;
          throw new Error("couldn't read .git/packed-refs");
        },
        failingGit,
        "/repo",
        () => {},
      ),
    ).rejects.toThrow(/corrupt git worktree state.*git worktree prune/is);

    expect(createCount).toBe(2); // tried once, pruned once, retried once — no infinite loop
    expect(calls.some((c) => c[1] === "remove")).toBe(false);
    expect(calls.some((c) => c.includes("--force"))).toBe(false);
  });

  it("when the failure is NOT worktree-related, surfaces the REAL error unchanged (no misleading 'corrupt git worktree state' relabel)", async () => {
    const { fakeGit } = makeFakeGit();
    let createCount = 0;
    const realErr = new Error("Provider request timed out after 30000ms");

    // A transient/provider error (nothing to do with git worktrees). The
    // wrapper still prunes + retries once (cheap, harmless), but on a second
    // failure it must NOT relabel this as worktree corruption — it must rethrow
    // the ORIGINAL error so the operator sees the true cause.
    const promise = createSandboxWithWorktreeRepair(
      async () => {
        createCount += 1;
        throw realErr;
      },
      fakeGit,
      "/repo",
      () => {},
    );

    await expect(promise).rejects.toBe(realErr); // same error object, unchanged
    await expect(promise).rejects.not.toThrow(/corrupt git worktree state/i);
    expect(createCount).toBe(2); // still tried once + retried once
  });
});
