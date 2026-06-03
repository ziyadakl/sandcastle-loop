import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildSandboxProvider } from "../.sandcastle/lib/sandbox-provider.js";

// `buildSandboxProvider(args, containerEnv, dockerConfig?)` is a pure helper
// that returns a uniform SandboxProvider shape regardless of which provider
// is selected. Both docker and mac-host expose the same topLevelRun /
// createSandbox methods.

const DUMMY_DOCKER_CONFIG = {
  hooks: {},
  copyToWorktree: ["node_modules"],
  copyToWorktreeMs: 600_000,
  completionSignal: ["<promise>COMPLETE</promise>"],
};

describe("sandbox routing by --sandbox flag", () => {
  it("returns a SandboxProvider with topLevelRun and createSandbox when args.sandbox === 'mac-host'", () => {
    const provider = buildSandboxProvider(
      { sandbox: "mac-host", repoRoot: "/tmp/x", imageName: "unused" } as any,
      {},
    );
    expect(typeof provider.topLevelRun).toBe("function");
    expect(typeof provider.createSandbox).toBe("function");
  });

  it("returns a SandboxProvider with topLevelRun and createSandbox when args.sandbox === 'docker'", () => {
    const provider = buildSandboxProvider(
      { sandbox: "docker", repoRoot: "/tmp/x", imageName: "sandcastle:foo" } as any,
      {},
      DUMMY_DOCKER_CONFIG,
    );
    expect(typeof provider.topLevelRun).toBe("function");
    expect(typeof provider.createSandbox).toBe("function");
  });

  it("throws when docker is selected without a dockerConfig", () => {
    expect(() =>
      buildSandboxProvider(
        { sandbox: "docker", repoRoot: "/tmp/x", imageName: "sandcastle:foo" } as any,
        {},
      ),
    ).toThrow();
  });
});

describe("buildSandboxProvider mac-host end-to-end", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "sandbox-provider-e2e-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
  });
  afterEach(() => { rmSync(repoRoot, { recursive: true, force: true }); });

  it("mac-host createSandbox().run() returns commits made inside the worktree", async () => {
    // Test-seam fake binary that makes one commit in the worktree it inherits.
    const fakeBin = path.join(repoRoot, "fake-claude.sh");
    writeFileSync(
      fakeBin,
      `#!/bin/sh\necho touched > new.txt\ngit add new.txt\ngit commit -m "agent commit" >/dev/null 2>&1\nexit 0\n`,
    );
    chmodSync(fakeBin, 0o755);

    const prevBin = process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN;
    process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN = fakeBin;
    try {
      const provider = buildSandboxProvider(
        { sandbox: "mac-host", repoRoot, imageName: "unused" } as any,
        {},
      );
      const handle = await provider.createSandbox({
        branch: "feat/e2e",
        sandboxEnv: {},
      });
      // Place the prompt inside the per-call worktree.
      writeFileSync(path.join(handle.worktreePath!, "p.md"), "ignored\n");
      const result = await handle.run({
        name: "smoke",
        model: "claude-test",
        promptFile: "p.md",
        idleTimeoutSeconds: 30,
      });
      expect(result.commits.length).toBe(1);
      expect(result.commits[0].sha).toMatch(/^[a-f0-9]{40}$/);
      await handle.close();
    } finally {
      if (prevBin === undefined) delete process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN;
      else process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN = prevBin;
    }
  });
});
