import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupIssueBranch,
  verifyLandedBranches,
  worktreePathFor,
} from "../.sandcastle/main.mjs";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("verifyLandedBranches", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-gc-test-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], {
      cwd: repo,
    });
    git(repo, "checkout", "-b", "agent/issue-1");
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "work 1"], {
      cwd: repo,
    });
    git(repo, "checkout", "main");
    git(repo, "merge", "--no-ff", "-q", "-m", "merge issue 1", "agent/issue-1");
    git(repo, "checkout", "-b", "agent/issue-2");
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "work 2"], {
      cwd: repo,
    });
    git(repo, "checkout", "main");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns only branches reachable from the launch branch", () => {
    const warnings: string[] = [];
    const landed = verifyLandedBranches(
      repo,
      "main",
      ["agent/issue-1", "agent/issue-2"],
      (w) => warnings.push(w),
    );
    expect(landed).toEqual(["agent/issue-1"]);
    expect(warnings).toEqual([]);
  });

  it("returns empty when no candidates landed", () => {
    const warnings: string[] = [];
    const landed = verifyLandedBranches(repo, "main", ["agent/issue-2"], (w) =>
      warnings.push(w),
    );
    expect(landed).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("ignores candidates that don't exist locally", () => {
    const warnings: string[] = [];
    const landed = verifyLandedBranches(
      repo,
      "main",
      ["agent/issue-999"],
      (w) => warnings.push(w),
    );
    expect(landed).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("calls warn when git fails (e.g. nonexistent launch branch)", () => {
    const warnings: string[] = [];
    const landed = verifyLandedBranches(
      repo,
      "does-not-exist",
      ["agent/issue-1"],
      (w) => warnings.push(w),
    );
    expect(landed).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("does-not-exist");
  });
});

describe("cleanupIssueBranch", () => {
  let repo: string;
  let warnings: string[];

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-gc-cleanup-"));
    warnings = [];
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], {
      cwd: repo,
    });
    git(repo, "checkout", "-b", "agent/issue-1");
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "work"], {
      cwd: repo,
    });
    git(repo, "checkout", "main");
    git(repo, "merge", "--no-ff", "-q", "-m", "merge", "agent/issue-1");
    mkdirSync(path.join(repo, ".sandcastle", "worktrees"), { recursive: true });
    git(
      repo,
      "worktree",
      "add",
      ".sandcastle/worktrees/agent-issue-1",
      "agent/issue-1",
    );
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("removes worktree then branch on success", () => {
    const result = cleanupIssueBranch(repo, "agent/issue-1", "main", (w) =>
      warnings.push(w),
    );
    expect(result).toBe("ok");
    expect(
      existsSync(path.join(repo, ".sandcastle", "worktrees", "agent-issue-1")),
    ).toBe(false);
    const branches = git(repo, "branch", "--list", "agent/issue-1");
    expect(branches).toBe("");
    expect(warnings).toEqual([]);
  });

  it("returns 'skipped-unmerged' and emits a warning when branch isn't merged", () => {
    git(repo, "checkout", "-b", "agent/issue-2");
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "unmerged"], {
      cwd: repo,
    });
    git(repo, "checkout", "main");
    git(
      repo,
      "worktree",
      "add",
      ".sandcastle/worktrees/agent-issue-2",
      "agent/issue-2",
    );

    const result = cleanupIssueBranch(repo, "agent/issue-2", "main", (w) =>
      warnings.push(w),
    );
    expect(result).toBe("skipped-unmerged");
    expect(warnings.length).toBeGreaterThan(0);
    const branches = git(repo, "branch", "--list", "agent/issue-2");
    expect(branches.trim()).toContain("agent/issue-2");
  });

  it("never throws on missing worktree directory", () => {
    rmSync(path.join(repo, ".sandcastle", "worktrees", "agent-issue-1"), {
      recursive: true,
      force: true,
    });
    const result = cleanupIssueBranch(repo, "agent/issue-1", "main", (w) =>
      warnings.push(w),
    );
    expect(["ok", "skipped-worktree-error"]).toContain(result);
  });

  it("does NOT warn when prune already cleared a dangling registration", () => {
    // Issue D (benign case): the worktree's `.git` link is gone (so the
    // registration is dangling), but a stray non-git dir still sits at the
    // worktree path. Flow: the first clean `git worktree remove` fails
    // (".git does not exist"); the in-worktree `git status` runs against the
    // OUTER repo and reports the stray dir as untracked → non-empty →
    // canForce=false → else branch; `git worktree prune` clears the dangling
    // registration. The retry-remove then fails with "not a working tree"
    // EVEN THOUGH cleanup has effectively succeeded (the worktree is no
    // longer registered). The old code warned there — misleading noise.
    const wt = path.join(repo, ".sandcastle", "worktrees", "agent-issue-1");
    // Replace the worktree dir with a plain (non-git) dir holding a stray
    // file: removing the original deletes the `.git` gitlink → registration
    // is now dangling, while the path still exists on disk.
    rmSync(wt, { recursive: true, force: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, "stray.txt"), "junk\n");

    const result = cleanupIssueBranch(repo, "agent/issue-1", "main", (w) =>
      warnings.push(w),
    );
    // Cleanup still removes the (merged) branch and returns ok.
    expect(result).toBe("ok");
    // And — the point of Issue D — it must NOT emit a worktree-remove warn,
    // because prune already cleared the dangling registration.
    expect(warnings).toEqual([]);
    expect(git(repo, "branch", "--list", "agent/issue-1")).toBe("");
  });

  it("STILL warns on a genuine worktree-remove failure (registration not cleared)", () => {
    // Issue D guard against over-suppression: a LOCKED worktree whose dir is
    // gone. `prune` will NOT clear a locked registration, so after prune the
    // worktree is still registered and the retry-remove genuinely fails. The
    // warn MUST still fire here — suppressing it would hide a real problem.
    // This test is green before AND after the fix; its job is to fail loudly
    // if the suppression logic over-reaches (e.g. an existsSync- or
    // path-based check that wrongly classifies this as "already cleaned").
    const wt = path.join(repo, ".sandcastle", "worktrees", "agent-issue-1");
    git(repo, "worktree", "lock", ".sandcastle/worktrees/agent-issue-1");
    rmSync(wt, { recursive: true, force: true });

    const result = cleanupIssueBranch(repo, "agent/issue-1", "main", (w) =>
      warnings.push(w),
    );
    // Branch is merged, so after the (warned) worktree step it still deletes
    // the branch and returns "ok".
    expect(result).toBe("ok");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("worktree remove"))).toBe(true);
  });

  it("uses launchBranch (not HEAD) to determine merged status", () => {
    git(repo, "checkout", "-b", "some-other-branch", "main^");
    const result = cleanupIssueBranch(repo, "agent/issue-1", "main", (w) =>
      warnings.push(w),
    );
    expect(result).toBe("ok");
    expect(warnings).toEqual([]);
  });

  it("returns 'skipped-branch-error' with clear message when branch doesn't exist", () => {
    const result = cleanupIssueBranch(repo, "agent/issue-999", "main", (w) =>
      warnings.push(w),
    );
    expect(result).toBe("skipped-branch-error");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("does not exist"))).toBe(true);
  });
});

describe("worktreePathFor", () => {
  // This helper MUST stay in sync with `@ai-hero/sandcastle/dist/
  // WorktreeManager.js` — both our `createSandbox` pre-clean guard and
  // `cleanupIssueBranch` derive paths from it, so the formula bridges
  // our code and the SDK. Pin the contract: forward slashes become
  // dashes; no other transforms.
  it("converts forward slashes to dashes for typical agent branches", () => {
    expect(worktreePathFor("agent/issue-100")).toBe(
      ".sandcastle/worktrees/agent-issue-100",
    );
  });

  it("collapses multiple path segments to a flat dash-separated name", () => {
    expect(worktreePathFor("feat/foo/bar")).toBe(
      ".sandcastle/worktrees/feat-foo-bar",
    );
  });

  it("returns a branch name unchanged when it contains no slashes", () => {
    expect(worktreePathFor("main")).toBe(".sandcastle/worktrees/main");
  });
});
