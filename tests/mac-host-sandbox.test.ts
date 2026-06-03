import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { macHostSandbox } from "../.sandcastle/lib/mac-host-sandbox.js";

function initTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mac-host-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

describe("macHostSandbox", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = initTempRepo();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("createSandbox returns a handle with branch and worktreePath", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/x" });
    expect(handle.branch).toBe("feat/x");
    expect(handle.worktreePath).toContain(".sandcastle/worktrees/feat-x");
    expect(existsSync(handle.worktreePath!)).toBe(true);
    await handle.close();
  });

  it("close() removes the worktree", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/y" });
    const wtPath = handle.worktreePath!;
    expect(existsSync(wtPath)).toBe(true);
    await handle.close();
    expect(existsSync(wtPath)).toBe(false);
  });

  it("createSandbox pre-cleans a stale worktree at the same path", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    // First create + abandon
    const h1 = await factory.createSandbox({ branch: "feat/reuse" });
    const stalePath = h1.worktreePath!;
    // Simulate abandonment: do NOT call close()
    // Second create with same branch must succeed (not collide)
    const h2 = await factory.createSandbox({ branch: "feat/reuse" });
    expect(h2.worktreePath).toBe(stalePath);
    expect(existsSync(stalePath)).toBe(true);
    await h2.close();
  });

  it("createSandbox handles an orphan dir that git does not know about (tier 2)", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const h1 = await factory.createSandbox({ branch: "feat/orphan" });
    const wtPath = h1.worktreePath;
    // Remove the worktree registration but leave the directory orphan
    execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: repoRoot });
    // Recreate the directory but NOT the registration
    execFileSync("mkdir", ["-p", wtPath]);
    // Re-create — should reap the orphan and succeed
    const h2 = await factory.createSandbox({ branch: "feat/orphan" });
    expect(h2.worktreePath).toBe(wtPath);
    expect(existsSync(wtPath)).toBe(true);
    await h2.close();
  });

  it("createSandbox handles a dangling registration with no dir (tier 3)", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const h1 = await factory.createSandbox({ branch: "feat/dangle" });
    const wtPath = h1.worktreePath;
    // rmSync the dir but leave git's registration intact
    rmSync(wtPath, { recursive: true, force: true });
    // Re-create — should prune the dangling registration and succeed
    const h2 = await factory.createSandbox({ branch: "feat/dangle" });
    expect(existsSync(h2.worktreePath)).toBe(true);
    await h2.close();
  });
});
