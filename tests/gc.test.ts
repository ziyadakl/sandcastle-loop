import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
