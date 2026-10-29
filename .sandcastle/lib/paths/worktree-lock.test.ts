import { describe, expect, it } from "vitest";

import {
  findRegisteredWorktree,
  lockWorktree,
  mayRemoveWorktree,
  unlockWorktree,
  worktreeLockOwner,
  worktreeLockReason,
  WORKTREE_LOCK_REASON_PREFIX,
  type WorktreeGit,
  type WorktreeGitResult,
} from "./worktree-lock.js";

/** A git runner that answers from a fixed script and records what was asked. */
function fakeGit(
  answers: (args: string[]) => WorktreeGitResult,
): { git: WorktreeGit; calls: string[][] } {
  const calls: string[][] = [];
  const git: WorktreeGit = (_repoRoot, ...args) => {
    calls.push(args);
    return answers(args);
  };
  return { git, calls };
}

const ok = (stdout = ""): WorktreeGitResult => ({ ok: true, stdout, stderr: "" });
const fail = (stderr: string): WorktreeGitResult => ({
  ok: false,
  stdout: "",
  stderr,
});

/** Real `git worktree list --porcelain` shape, blank-line separated. */
const porcelain = (
  blocks: readonly { path: string; branch: string; locked?: string | true }[],
): string =>
  blocks
    .map((b) => {
      const lines = [
        `worktree ${b.path}`,
        "HEAD 1da418e7006db090cc0ff0d1d71f331fb13dd0e6",
        `branch refs/heads/${b.branch}`,
      ];
      if (b.locked === true) lines.push("locked");
      else if (typeof b.locked === "string") lines.push(`locked ${b.locked}`);
      return lines.join("\n");
    })
    .join("\n\n");

describe("the lock reason names the branch that owns the worktree", () => {
  it("round-trips a branch through the reason string", () => {
    const reason = worktreeLockReason("agent/issue-1260");
    expect(reason).toBe("sandcastle: in flight for agent/issue-1260");
    expect(worktreeLockOwner(reason)).toBe("agent/issue-1260");
  });

  it("stays ASCII, so git never C-quotes it in the porcelain listing", () => {
    // A non-ASCII byte makes `git worktree list --porcelain` print the reason
    // as `locked "... \342\200\224 ..."`, which no plain prefix match can read.
    // eslint-disable-next-line no-control-regex
    expect(/^[\x20-\x7e]+$/.test(worktreeLockReason("agent/issue-1"))).toBe(
      true,
    );
  });

  it("reads a reason this loop did not write as NOT ours", () => {
    expect(worktreeLockOwner("held by hand, do not touch")).toBeUndefined();
    expect(worktreeLockOwner("")).toBeUndefined();
    // The C-quoted form of one of our own reasons: unreadable, so foreign.
    expect(
      worktreeLockOwner('"sandcastle: in flight for agent/issue-\\303\\251"'),
    ).toBeUndefined();
    // The prefix alone, with no branch after it, names no owner.
    expect(worktreeLockOwner(WORKTREE_LOCK_REASON_PREFIX)).toBeUndefined();
  });
});

describe("lockWorktree / unlockWorktree fold git's non-idempotence away", () => {
  it("locks with a reason naming the branch", () => {
    const { git, calls } = fakeGit(() => ok());
    expect(lockWorktree("/repo", ".sandcastle/worktrees/a", "agent/issue-7", git)).toBe(
      "locked",
    );
    expect(calls[0]).toEqual([
      "worktree",
      "lock",
      ".sandcastle/worktrees/a",
      "--reason",
      "sandcastle: in flight for agent/issue-7",
    ]);
  });

  it("treats an already-locked worktree as a success", () => {
    const { git } = fakeGit(() => fail("fatal: '.../a' is already locked"));
    expect(lockWorktree("/repo", "a", "agent/issue-7", git)).toBe(
      "already-locked",
    );
  });

  it("reports any other lock failure so the caller can warn", () => {
    const { git } = fakeGit(() => fail("fatal: not a working tree"));
    expect(lockWorktree("/repo", "a", "agent/issue-7", git)).toBe("failed");
  });

  it("treats an unlock of something never locked as a success", () => {
    const { git } = fakeGit(() => fail("fatal: '.../a' is not locked"));
    expect(unlockWorktree("/repo", "a", git)).toBe("was-not-locked");
  });

  it("reports a genuine unlock failure", () => {
    const { git } = fakeGit(() => fail("fatal: unable to write file"));
    expect(unlockWorktree("/repo", "a", git)).toBe("failed");
  });
});

describe("findRegisteredWorktree asks git for the path, keyed on the branch", () => {
  const listing = porcelain([
    { path: "/repo", branch: "main" },
    {
      path: "/private/var/repo/.sandcastle/worktrees/agent-issue-1260",
      branch: "agent/issue-1260",
      locked: "sandcastle: in flight for agent/issue-1260",
    },
    {
      path: "/private/var/repo/.sandcastle/worktrees/agent-issue-1037",
      branch: "agent/issue-1037",
    },
  ]);

  it("returns the path git printed, not one derived from the branch name", () => {
    const { git } = fakeGit(() => ok(listing));
    const found = findRegisteredWorktree("/repo", "agent/issue-1260", git);
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    // Note the realpath'd `/private/var` prefix a derived path would never have.
    expect(found.worktree.path).toBe(
      "/private/var/repo/.sandcastle/worktrees/agent-issue-1260",
    );
    expect(found.worktree.lock).toEqual({
      kind: "ours",
      owner: "agent/issue-1260",
    });
  });

  it("reports an unlocked worktree as unlocked", () => {
    const { git } = fakeGit(() => ok(listing));
    const found = findRegisteredWorktree("/repo", "agent/issue-1037", git);
    expect(found.kind === "found" && found.worktree.lock.kind).toBe("unlocked");
  });

  it("reports a bare `locked` line, with no reason, as foreign", () => {
    const { git } = fakeGit(() =>
      ok(porcelain([{ path: "/w/a", branch: "agent/issue-9", locked: true }])),
    );
    const found = findRegisteredWorktree("/repo", "agent/issue-9", git);
    expect(found.kind === "found" && found.worktree.lock).toEqual({
      kind: "foreign",
      reason: "",
    });
  });

  it("reports a hand-written lock reason as foreign", () => {
    const { git } = fakeGit(() =>
      ok(
        porcelain([
          { path: "/w/a", branch: "agent/issue-9", locked: "mine, leave it" },
        ]),
      ),
    );
    const found = findRegisteredWorktree("/repo", "agent/issue-9", git);
    expect(found.kind === "found" && found.worktree.lock).toEqual({
      kind: "foreign",
      reason: "mine, leave it",
    });
  });

  it("still finds a worktree whose directory is gone (git marks it prunable)", () => {
    const dangling =
      "worktree /w/a\nHEAD abc\nbranch refs/heads/agent/issue-9\n" +
      "prunable gitdir file points to non-existent location";
    const { git } = fakeGit(() => ok(dangling));
    const found = findRegisteredWorktree("/repo", "agent/issue-9", git);
    expect(found.kind).toBe("found");
    expect(found.kind === "found" && found.worktree.path).toBe("/w/a");
  });

  it("says `none` when git knows no worktree for the branch", () => {
    const { git } = fakeGit(() => ok(listing));
    expect(findRegisteredWorktree("/repo", "agent/issue-999", git).kind).toBe(
      "none",
    );
  });

  it("says `unreadable`, never `none`, when the listing itself failed", () => {
    const { git } = fakeGit(() => fail("fatal: couldn't read .git/packed-refs"));
    const got = findRegisteredWorktree("/repo", "agent/issue-1260", git);
    expect(got.kind).toBe("unreadable");
    expect(got.kind === "unreadable" && got.detail).toContain("packed-refs");
  });
});

describe("mayRemoveWorktree — a cleanup may only touch its own ticket", () => {
  const lookupFor = (
    branch: string,
    blocks: readonly { path: string; branch: string; locked?: string | true }[],
  ) => {
    const { git } = fakeGit(() => ok(porcelain(blocks)));
    return findRegisteredWorktree("/repo", branch, git);
  };

  it("allows removing a worktree this loop locked for THIS branch", () => {
    const got = mayRemoveWorktree(
      "agent/issue-1037",
      lookupFor("agent/issue-1037", [
        {
          path: "/w/agent-issue-1037",
          branch: "agent/issue-1037",
          locked: "sandcastle: in flight for agent/issue-1037",
        },
      ]),
    );
    expect(got).toEqual({
      decision: "go",
      path: "/w/agent-issue-1037",
      locked: true,
    });
  });

  it("allows removing an unlocked worktree", () => {
    const got = mayRemoveWorktree(
      "agent/issue-1037",
      lookupFor("agent/issue-1037", [
        { path: "/w/agent-issue-1037", branch: "agent/issue-1037" },
      ]),
    );
    expect(got).toEqual({
      decision: "go",
      path: "/w/agent-issue-1037",
      locked: false,
    });
  });

  it("REFUSES a worktree locked for a DIFFERENT branch (issue #1260)", () => {
    const got = mayRemoveWorktree(
      "agent/issue-1037",
      lookupFor("agent/issue-1037", [
        {
          path: "/w/agent-issue-1037",
          branch: "agent/issue-1037",
          locked: "sandcastle: in flight for agent/issue-1260",
        },
      ]),
    );
    expect(got.decision).toBe("refuse");
    expect(got.decision === "refuse" && got.why).toContain("agent/issue-1260");
  });

  it("REFUSES a lock this loop did not take", () => {
    const got = mayRemoveWorktree(
      "agent/issue-1037",
      lookupFor("agent/issue-1037", [
        {
          path: "/w/agent-issue-1037",
          branch: "agent/issue-1037",
          locked: "held by a person",
        },
      ]),
    );
    expect(got.decision).toBe("refuse");
    expect(got.decision === "refuse" && got.why).toContain("held by a person");
  });

  it("REFUSES when the listing could not be read, rather than guessing", () => {
    const { git } = fakeGit(() => fail("fatal: not a git repository"));
    const got = mayRemoveWorktree(
      "agent/issue-1037",
      findRegisteredWorktree("/repo", "agent/issue-1037", git),
    );
    expect(got.decision).toBe("refuse");
  });

  it("says there is nothing registered rather than offering a guessed path", () => {
    const got = mayRemoveWorktree(
      "agent/issue-1037",
      lookupFor("agent/issue-1037", [{ path: "/repo", branch: "main" }]),
    );
    expect(got).toEqual({ decision: "nothing-registered" });
  });
});
