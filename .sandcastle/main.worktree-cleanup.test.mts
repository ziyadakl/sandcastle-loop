/**
 * ISSUE #1260 — a cleanup for LANDED tickets must not destroy a LIVE ticket's
 * worktree.
 *
 * The failure this file pins, from run `sandcastle/queue-20260910b` on
 * 2026-09-11: issue #1260's builder finished, three other tickets landed and
 * ran the per-ticket cleanup, and then #1260's reviewer died on
 *
 *   fatal: not a git repository:
 *     /home/you/dev/my-project/.git/worktrees/agent-issue-1260
 *
 * The live ticket's ADMINISTRATIVE directory had been reaped by a repo-global
 * `git worktree prune` that the landed ticket's cleanup ran. A finished build
 * and a paid reviewer were thrown away.
 *
 * REAL GIT, REAL WORKTREES, on purpose. The whole bug lives in what git
 * actually does to a worktree that is live but momentarily unreadable, and a
 * stubbed git runner would have agreed with the old code's comment that
 * `git worktree prune` "NEVER removes a live/healthy worktree" — which is the
 * sentence the incident disproved. Each test below asserts on the bytes on
 * disk afterwards, never on what a fake was asked.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "./__fixtures__/git-repo.js";
import { cleanupIssueBranch } from "./main.mjs";
import {
  lockWorktree,
  unlockOwnWorktree,
  worktreeLockReason,
} from "./lib/paths/worktree-lock.js";
import { worktreePathFor } from "./lib/worktree-path.js";

/** The branch the loop was still working when the incident happened. */
const LIVE = "agent/issue-1260";
/** One of the three branches that had landed and were being cleaned up. */
const LANDED = "agent/issue-1037";

/** A git runner shaped for the lock helpers: never throws. */
const lockGit = (cwd: string, ...args: string[]) => {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, { cwd, encoding: "utf8" }).trim(),
      stderr: "",
    };
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string };
    const stderr =
      typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    return { ok: false, stdout: "", stderr: stderr.trim() || e.message };
  }
};

/** Absolute path of the per-worktree ADMIN directory — the thing #1260 lost.
 * `git worktree prune` deletes exactly this and leaves the working directory,
 * which is why the container kept running and only git inside it broke. */
const adminDirFor = (repo: string, branch: string): string =>
  path.join(repo, ".git", "worktrees", branch.replace(/\//g, "-"));

describe("cleanupIssueBranch leaves an in-flight ticket alone (issue #1260)", () => {
  let repo: string;
  let liveWt: string;
  let landedWt: string;
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
  };

  beforeEach(() => {
    warnings.length = 0;
    repo = mkdtempSync(path.join(tmpdir(), "sc-wt-1260-"));
    git(repo, "init", "-q", "-b", "run-branch");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commitInto(repo, { "README.md": "seed\n" }, "chore: seed");
    mkdirSync(path.join(repo, ".sandcastle", "worktrees"), { recursive: true });

    // The LIVE ticket: a worktree the loop is still working in, locked the way
    // `createSandboxRaw` locks one the instant it exists.
    liveWt = path.join(repo, worktreePathFor(LIVE));
    git(repo, "worktree", "add", "-q", liveWt, "-b", LIVE);
    expect(lockWorktree(repo, liveWt, LIVE, lockGit)).toBe("locked");

    // The LANDED ticket: finished, merged into the run branch, unlocked by its
    // own pipeline's `finally` — exactly the state cleanup meets.
    landedWt = path.join(repo, worktreePathFor(LANDED));
    git(repo, "worktree", "add", "-q", landedWt, "-b", LANDED);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("removes the landed ticket and leaves the live one entirely intact", () => {
    const result = cleanupIssueBranch(repo, LANDED, "run-branch", warn);

    expect(result).toBe("ok");
    // The landed ticket is gone, both halves.
    expect(existsSync(landedWt)).toBe(false);
    expect(existsSync(adminDirFor(repo, LANDED))).toBe(false);
    // The live ticket is untouched, both halves. The admin directory is the
    // one #1260 actually lost.
    expect(existsSync(liveWt)).toBe(true);
    expect(existsSync(adminDirFor(repo, LIVE))).toBe(true);
    // And git still agrees it is a worktree, which is what the reviewer's
    // `git config --global --add safe.directory` needed and did not get.
    expect(git(liveWt, "rev-parse", "--is-inside-work-tree")).toBe("true");
  });

  it("leaves the live ticket intact even when it is momentarily unreadable", () => {
    // THE ACTUAL INCIDENT. A live worktree is not continuously healthy: the
    // vendored SDK's `pruneStale` sweep can empty its directory out between
    // two heartbeats. Moving the directory aside reproduces that state, and
    // an UNLOCKED worktree in it is reaped on the spot by any global prune:
    //   Removing worktrees/live: gitdir file points to non-existent location
    // Force the landed cleanup down its prune fallback by making the clean
    // remove fail on an uncommitted file, then prove the lock held.
    const moved = `${liveWt}-moved-aside`;
    renameSync(liveWt, moved);
    execFileSync("sh", ["-c", `echo dirty > ${JSON.stringify(landedWt)}/dirty.txt`]);

    const result = cleanupIssueBranch(repo, LANDED, "run-branch", warn);

    // The live ticket's registration survived the global prune this cleanup
    // ran. Without the lock, this is the assertion that fails and #1260 dies.
    expect(existsSync(adminDirFor(repo, LIVE))).toBe(true);
    expect(
      git(repo, "worktree", "list", "--porcelain"),
    ).toContain(`branch refs/heads/${LIVE}`);
    // Put it back and confirm git can still use it — a surviving admin
    // directory is only worth anything if the worktree still works.
    renameSync(moved, liveWt);
    expect(git(liveWt, "rev-parse", "--is-inside-work-tree")).toBe("true");
    // The landed ticket's own outcome is pinned exactly, not merely "not
    // refused": a bare `not.toBe(...)` would also pass if the cleanup had
    // done nothing at all, which would hide a guard that refuses everything.
    // Its worktree is dirty, so the clean remove fails, `--force` is withheld,
    // the prune fallback runs and the retry-remove fails too — the cleanup
    // continues to the branch delete and reports "ok".
    expect(result).toBe("ok");
  });

  it("refuses outright when the worktree is locked for a DIFFERENT ticket", () => {
    // A path-derivation bug, or a branch-name collision, pointing the landed
    // ticket's cleanup at the live ticket's folder. The lock's reason names
    // the owner, so the cleanup stops before it unlocks or removes anything.
    git(repo, "worktree", "lock", landedWt, "--reason", worktreeLockReason(LIVE));

    const result = cleanupIssueBranch(repo, LANDED, "run-branch", warn);

    expect(result).toBe("skipped-worktree-locked");
    expect(existsSync(landedWt)).toBe(true);
    // Nothing was touched — not even the branch, because a branch whose
    // worktree is still standing may still be in use.
    expect(git(repo, "rev-parse", "--verify", `refs/heads/${LANDED}`)).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(warnings.join("\n")).toContain(LIVE);
  });

  it("refuses a lock this loop did not take, and never breaks it", () => {
    git(repo, "worktree", "lock", landedWt, "--reason", "held by a person");

    expect(cleanupIssueBranch(repo, LANDED, "run-branch", warn)).toBe(
      "skipped-worktree-locked",
    );
    expect(existsSync(landedWt)).toBe(true);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(
      "locked held by a person",
    );
  });

  it("removes a landed ticket that is still holding its own lock", () => {
    // The ordinary path when a ticket's pipeline died before its `finally`
    // could unlock: the lock is ours and names THIS branch, so the cleanup
    // drops it and proceeds. Without the unlock, `git worktree remove`
    // refuses a locked worktree and every finished ticket accumulates.
    expect(lockWorktree(repo, landedWt, LANDED, lockGit)).toBe("locked");

    expect(cleanupIssueBranch(repo, LANDED, "run-branch", warn)).toBe("ok");
    expect(existsSync(landedWt)).toBe(false);
    expect(existsSync(adminDirFor(repo, LANDED))).toBe(false);
    expect(existsSync(adminDirFor(repo, LIVE))).toBe(true);
  });

  it("never guesses a path when git has no worktree for the branch", () => {
    // Registration gone, directory gone — a prior run already cleaned it. The
    // derived `worktreePathFor(branch)` must NOT be used as a fallback: a
    // wrong derivation names some other ticket's live folder.
    git(repo, "worktree", "remove", landedWt);

    expect(cleanupIssueBranch(repo, LANDED, "run-branch", warn)).toBe("ok");
    expect(existsSync(liveWt)).toBe(true);
    expect(existsSync(adminDirFor(repo, LIVE))).toBe(true);
  });

  it("a killed run's locked-but-vanished worktree does not wedge the branch", () => {
    // THE DEFECT THIS FIX ITSELF INTRODUCED, pinned so it cannot return. A
    // `kill -9` can leave the REGISTRATION locked with its DIRECTORY already
    // gone. Neither `git worktree prune` nor `git worktree remove --force`
    // will touch a locked worktree, so if the restart's unlock is gated on
    // the directory existing, nothing can ever clear it and the next
    // `git worktree add` dies for good:
    //   fatal: '<path>' is a missing but locked worktree
    // Measured on git 2.39.5. The restart must therefore unlock FIRST.
    rmSync(liveWt, { recursive: true, force: true });
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(
      `branch refs/heads/${LIVE}`,
    );
    // Prune alone cannot clear it — that refusal is the guard working.
    git(repo, "worktree", "prune");
    expect(existsSync(adminDirFor(repo, LIVE))).toBe(true);

    // What the restart does, in order: unlock by branch, then clear.
    expect(unlockOwnWorktree(repo, LIVE, lockGit)).toBe("unlocked");
    git(repo, "worktree", "prune");

    // The branch is workable again.
    git(repo, "worktree", "add", "-q", liveWt, LIVE);
    expect(git(liveWt, "rev-parse", "--is-inside-work-tree")).toBe("true");
  });

  it("finds its own lock on a worktree left with no branch checked out", () => {
    // Every unlock site keys on the BRANCH, and a detached worktree prints no
    // `branch` line at all. Our lock reason still names the branch, so it
    // stays findable — without that second key the lock is unreachable and
    // the branch wedges exactly as above.
    git(liveWt, "checkout", "-q", "--detach");
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(
      `branch refs/heads/${LIVE}`,
    );
    expect(unlockOwnWorktree(repo, LIVE, lockGit)).toBe("unlocked");
  });

  it("refuses rather than guessing when git cannot be asked at all", () => {
    // An unreadable listing and a foreign lock must fail the same way. The
    // old code would have fallen through to a derived path and removed
    // whatever happened to be there.
    const notARepo = mkdtempSync(path.join(tmpdir(), "sc-wt-1260-norepo-"));
    try {
      expect(cleanupIssueBranch(notARepo, LANDED, "run-branch", warn)).toBe(
        "skipped-worktree-locked",
      );
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
