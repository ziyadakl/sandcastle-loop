/**
 * Wiring proof for the ceiling-abort kill.
 *
 * `sandbox-provider.test.ts` tests `terminateSandboxProcessesOnAbort` in
 * isolation. This file proves the thing that actually failed on 2026-08-07:
 * that the docker provider's `run` path ATTACHES that terminator to the signal
 * the hard ceiling raises, so aborting a real `provider.createSandbox(...).run()`
 * reaches the container.
 *
 * Lives in its own file because it mocks the `@ai-hero/sandcastle` module, and
 * `vi.mock` is hoisted per-file — the sibling suite must keep the real imports.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Commands the fake sandbox handle was asked to run inside the container. */
const execCalls: string[] = [];
/** Aborts observed by the fake agent run, in order. */
const runAborts: string[] = [];

/** The slice of the SDK's run result `makeDockerProvider` actually reads. */
interface FakeRunResult {
  stdout: string;
  commits: { sha: string }[];
  iterations: { sessionFilePath?: string; sessionId?: string }[];
}

const fakeSdkHandle = {
  branch: "agent/issue-803",
  // Undefined on purpose: `makeDockerProvider` only takes the stuck-detector
  // branch when a host worktree path exists, and this test drives the plain path.
  worktreePath: undefined as string | undefined,
  run: (opts: { signal?: AbortSignal }): Promise<FakeRunResult> =>
    // Models the real failure shape: the agent never settles on its own. Only
    // the abort ends it — and on the real docker sandbox the underlying
    // `docker exec` kept running even then.
    new Promise<FakeRunResult>((_resolve, reject) => {
      opts.signal?.addEventListener("abort", () => {
        runAborts.push(String((opts.signal as AbortSignal).reason));
        reject(new Error("aborted"));
      });
    }),
  exec: async (command: string) => {
    execCalls.push(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  close: async () => {},
};

vi.mock("@ai-hero/sandcastle", () => ({
  createSandbox: async () => fakeSdkHandle,
  run: async () => ({ stdout: "", commits: [] }),
  claudeCode: (model: string) => ({ name: "claude-code", model }),
  codex: (model: string) => ({ name: "codex", model }),
}));

vi.mock("@ai-hero/sandcastle/sandboxes/docker", () => ({
  docker: () => ({ tag: "bind-mount" }),
}));

const { makeDockerProvider } = await import("./sandbox-provider.js");

function buildProvider() {
  return makeDockerProvider(
    {
      imageName: "sandcastle:test",
      repoRoot: "/repo",
      hooks: {},
      copyToWorktree: [],
      copyToWorktreeMs: 1000,
      completionSignal: ["<promise>COMPLETE</promise>"],
    },
    {},
  );
}

describe("docker provider: the hard ceiling actually terminates the agent", () => {
  beforeEach(() => {
    execCalls.length = 0;
    runAborts.length = 0;
  });

  it("kills the sandboxed agent when the run's signal aborts", async () => {
    const provider = buildProvider();
    const sandbox = await provider.createSandbox({
      branch: "agent/issue-803",
      sandboxEnv: {},
    });

    const controller = new AbortController();
    const running = sandbox.run({
      name: "implementer",
      model: "claude-sonnet-5",
      promptFile: "implement-prompt.md",
      signal: controller.signal,
    });

    // Mid-run: the agent is working, nothing has been killed.
    await Promise.resolve();
    expect(execCalls).toEqual([]);

    controller.abort(
      new Error(
        'hard ceiling: sandbox run "implementer" exceeded 3600s wall-clock',
      ),
    );
    await expect(running).rejects.toThrow();
    // Let the fire-and-forget kill reach the fake handle.
    await new Promise((r) => setTimeout(r, 0));

    expect(runAborts).toHaveLength(1);
    // THE ASSERTION THAT WOULD HAVE CAUGHT #803: aborting must reach the
    // container, not merely reject a promise on the host.
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toContain("/proc/[0-9]*");
    expect(execCalls[0]).toContain("kill -9");
  });

  it("kills nothing when the run completes normally", async () => {
    const provider = buildProvider();
    const sandbox = await provider.createSandbox({
      branch: "agent/issue-803",
      sandboxEnv: {},
    });

    const controller = new AbortController();
    const settle = vi
      .spyOn(fakeSdkHandle, "run")
      .mockResolvedValueOnce({ stdout: "done", commits: [], iterations: [] });

    await sandbox.run({
      name: "implementer",
      model: "claude-sonnet-5",
      promptFile: "implement-prompt.md",
      signal: controller.signal,
    });

    // The listener must be detached with the run, so a later abort of a
    // long-lived signal cannot kill a container that has moved on.
    controller.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(execCalls).toEqual([]);
    settle.mockRestore();
  });
});
