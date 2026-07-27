import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Integration test for the docker provider's `createSandbox().run()` wiring of
// ticket 03's stuck-detector. We mock `@ai-hero/sandcastle` so no container is
// launched, but drive the REAL `buildSandboxProvider` → `makeDockerProvider` →
// `runWithStuckDetection` seam, and use a REAL temp git repo so the abort→
// recover→graceful path exercises the actual git helpers (gitHeadSha /
// gitCommitsSince) rather than fakes.

const h = vi.hoisted(() => ({
  runImpl: null as null | ((opts: any) => Promise<any>),
  worktreePath: undefined as string | undefined,
  lastRunOpts: undefined as any,
}));

vi.mock("@ai-hero/sandcastle", () => ({
  run: vi.fn(),
  createSandbox: vi.fn(async () => ({
    branch: "feat/stuck-e2e",
    worktreePath: h.worktreePath,
    run: (opts: any) => {
      h.lastRunOpts = opts;
      return h.runImpl!(opts);
    },
    close: vi.fn(async () => {}),
  })),
  codex: vi.fn((m: string) => ({ backend: "codex", model: m })),
  claudeCode: vi.fn((m: string) => ({ backend: "claude", model: m })),
}));

vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: vi.fn(() => ({ __docker: true })),
}));

const { buildSandboxProvider } = await import(
  "../.sandcastle/lib/sandbox-provider.js"
);

const BASE_DOCKER_CONFIG = {
  hooks: {},
  copyToWorktree: ["node_modules"],
  copyToWorktreeMs: 600_000,
  completionSignal: ["<promise>COMPLETE</promise>"],
};

beforeEach(() => {
  h.runImpl = null;
  h.worktreePath = undefined;
  h.lastRunOpts = undefined;
});

describe("docker createSandbox().run() — stuck-detector wiring", () => {
  it("flag OFF: run does NOT attach logging/onAgentStreamEvent (today's path)", async () => {
    h.worktreePath = "/tmp/does-not-matter-when-off";
    h.runImpl = async () => ({
      stdout: "ok",
      commits: [{ sha: "a".repeat(40) }],
      iterations: [],
    });

    const provider = buildSandboxProvider(
      {
        sandbox: "docker",
        repoRoot: "/tmp/x",
        imageName: "sandcastle:foo",
        stuckDetector: false,
      } as any,
      {},
      BASE_DOCKER_CONFIG,
    );
    const handle = await provider.createSandbox({
      branch: "feat/stuck-e2e",
      sandboxEnv: {},
    });
    const result = await handle.run({
      name: "implement",
      model: "claude-test",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    } as any);

    expect(result.commits.length).toBe(1);
    // The load-bearing assertion: the off path passes today's exact opts with
    // no logging block and therefore no onAgentStreamEvent callback.
    expect(h.lastRunOpts.logging).toBeUndefined();
    expect("onAgentStreamEvent" in (h.lastRunOpts ?? {})).toBe(false);
  });
});

describe("docker createSandbox().run() — stuck-detector ON, simulated spin", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), "stuck-detector-e2e-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: repoRoot,
    });
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("aborts on a 6× identical tool-call spin and returns a graceful result carrying recovered commits", async () => {
    h.worktreePath = repoRoot;
    h.runImpl = async (opts: any) => {
      // Simulate a demonstrably-stuck implementer: the same tool with the same
      // args, six times in a row (e.g. `Bash: cat e2e.log` polled to death).
      for (let i = 0; i < 6; i++) {
        opts.logging.onAgentStreamEvent({
          type: "toolCall",
          name: "Bash",
          formattedArgs: "cat e2e.log",
        });
      }
      // By now the internal controller has fired. Simulate that the agent had
      // already committed real work before the abort landed.
      execFileSync("git", ["commit", "--allow-empty", "-m", "wip: partial"], {
        cwd: repoRoot,
      });
      // The SDK contract: reject with signal.reason on abort.
      return await new Promise((_resolve, reject) => {
        if (opts.signal?.aborted) reject(opts.signal.reason);
        else
          opts.signal?.addEventListener("abort", () =>
            reject(opts.signal.reason),
          );
      });
    };

    const provider = buildSandboxProvider(
      {
        sandbox: "docker",
        repoRoot,
        imageName: "sandcastle:foo",
        stuckDetector: true,
      } as any,
      {},
      BASE_DOCKER_CONFIG,
    );
    const handle = await provider.createSandbox({
      branch: "feat/stuck-e2e",
      sandboxEnv: {},
    });
    const result = await handle.run({
      name: "implement",
      model: "claude-test",
      promptFile: "p.md",
      idleTimeoutSeconds: 30,
    } as any);

    // Graceful result — NOT a throw — carrying the recovered commit.
    expect(result.stdout).toContain("[stuck-detector]");
    expect(result.commits.length).toBe(1);
    expect(result.commits[0].sha).toMatch(/^[a-f0-9]{40}$/);
    // Ticket 03: the graceful result flags itself so runImplementer can route
    // the partial work to the reviewer instead of tripping its normal-run gates.
    expect(result.stuckAborted).toBe(true);
    // Proves the ON path attached the live stream callback.
    expect(typeof h.lastRunOpts.logging.onAgentStreamEvent).toBe("function");
  });
});
