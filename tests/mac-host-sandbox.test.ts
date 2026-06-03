import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, chmodSync } from "node:fs";
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

describe("macHostSandbox run()", () => {
  let repoRoot: string;
  beforeEach(() => { repoRoot = initTempRepo(); });
  afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

  it("run() spawns a process in the worktree and captures stdout", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/spawn" });
    // Place a tiny prompt file the fake claude wrapper can consume.
    const promptPath = path.join(handle.worktreePath, "prompt.md");
    writeFileSync(promptPath, "hello world");
    // Use the test seam: override claude binary path via env.
    const result = await handle.run({
      name: "smoke",
      model: "claude-test",
      promptFile: "prompt.md",
      idleTimeoutSeconds: 30,
    });
    // Default seam runs `cat <promptFile>` if SANDCASTLE_MAC_HOST_CLAUDE_BIN
    // is unset for tests — see implementation note in Step 3.3.
    expect(result.stdout).toContain("hello world");
    await handle.close();
  });

  it("run() rejects when promptFile does not exist in the worktree", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/missing" });
    await expect(
      handle.run({
        name: "smoke",
        model: "claude-test",
        promptFile: "nope.md",
        idleTimeoutSeconds: 30,
      }),
    ).rejects.toThrow(/prompt file not found/);
    await handle.close();
  });

  it("run() returns commits made in the worktree as { sha } objects", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/commits" });
    const wt = handle.worktreePath;
    // Make a real commit in the worktree before calling run().
    writeFileSync(path.join(wt, "f.txt"), "x");
    execFileSync("git", ["add", "f.txt"], { cwd: wt });
    execFileSync("git", ["commit", "-m", "test commit"], { cwd: wt });
    // Place a prompt and call run() (the spawn does nothing important; we are
    // testing that readCommitsSince picks up the pre-spawn commit).
    writeFileSync(path.join(wt, "p.md"), "hi");
    const result = await handle.run({
      name: "smoke",
      model: "claude-test",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    });
    expect(result.commits.length).toBe(1);
    expect(result.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    await handle.close();
  });
});

describe("macHostSandbox abort signal", () => {
  let repoRoot: string;
  beforeEach(() => { repoRoot = initTempRepo(); });
  afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

  it("run() aborts when signal fires mid-spawn", async () => {
    // Write a tiny shell script that sleeps for 5 s, giving us a long-running
    // child that the abort signal can reliably kill before it exits.
    const sleepScript = path.join(repoRoot, "fake-claude.sh");
    writeFileSync(sleepScript, "#!/bin/sh\nsleep 5\n");
    chmodSync(sleepScript, 0o755);
    const oldBin = process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN;
    process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN = sleepScript;
    try {
      const factory = macHostSandbox({ repoRoot, env: {} });
      const handle = await factory.createSandbox({ branch: "feat/abort" });
      writeFileSync(path.join(handle.worktreePath, "p.md"), "x");
      const controller = new AbortController();
      const runPromise = handle.run({
        name: "abort-me",
        model: "claude-test",
        promptFile: "p.md",
        idleTimeoutSeconds: 60,
        signal: controller.signal,
      });
      // Fire abort after a short delay to let the process start
      setTimeout(() => controller.abort(), 100);
      await expect(runPromise).rejects.toThrow(/aborted/);
      await handle.close();
    } finally {
      if (oldBin === undefined) delete process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN;
      else process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN = oldBin;
    }
  });

  it("run() rejects immediately if signal is already aborted before spawn", async () => {
    const factory = macHostSandbox({ repoRoot, env: {} });
    const handle = await factory.createSandbox({ branch: "feat/abort-pre" });
    writeFileSync(path.join(handle.worktreePath, "p.md"), "x");
    const controller = new AbortController();
    controller.abort();
    await expect(
      handle.run({
        name: "pre-aborted",
        model: "claude-test",
        promptFile: "p.md",
        idleTimeoutSeconds: 60,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/already aborted/);
    await handle.close();
  });
});

describe("macHostSandbox top-level run()", () => {
  let repoRoot: string;
  beforeEach(() => { repoRoot = initTempRepo(); });
  afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

  it("top-level run executes in repoRoot when no cwd override", async () => {
    const promptPath = path.join(repoRoot, "merger-prompt.md");
    writeFileSync(promptPath, "merge please");
    const factory = macHostSandbox({ repoRoot, env: {} });
    const result = await factory.run({
      name: "merger",
      model: "claude-test",
      promptFile: "merger-prompt.md",
      idleTimeoutSeconds: 30,
    });
    expect(result.stdout).toContain("merge please");
  });

  it("top-level run honours cwd override", async () => {
    const subDir = path.join(repoRoot, "staging");
    mkdirSync(subDir, { recursive: true });
    const promptPath = path.join(subDir, "p.md");
    writeFileSync(promptPath, "staged prompt");
    const factory = macHostSandbox({ repoRoot, env: {} });
    const result = await factory.run({
      name: "merger",
      model: "claude-test",
      promptFile: "p.md",
      cwd: subDir,
      idleTimeoutSeconds: 30,
    });
    expect(result.stdout).toContain("staged prompt");
  });
});
