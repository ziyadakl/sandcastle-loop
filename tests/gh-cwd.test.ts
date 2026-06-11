/**
 * gh cwd threading: every host-side `gh` call must resolve against the managed
 * repo (`configureGh({ cwd })`), not the launch cwd, so a `--repo-root` other
 * than the process cwd doesn't silently hit the wrong repo.
 *
 * NOTE: this imports the CANONICAL `.sandcastle/lib/state/gh.ts` (what main.mts
 * actually runs), not the `src/state/gh.ts` twin that tests/gh.test.ts imports.
 * The two have diverged; the twin lacks `configureGh`.
 *
 * Mocks `node:child_process.execFile` (same approach as tests/gh.test.ts) but
 * additionally captures the `options.cwd` passed to each invocation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { ghCalls } = vi.hoisted(() => ({
  ghCalls: [] as Array<{ args: string[]; cwd?: string }>,
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  const { promisify } = await import("node:util");

  const mockExecFile = (
    _file: string,
    _args: string[],
    _options: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    cb(null, "[]", "");
    return undefined as unknown as ReturnType<typeof actual.execFile>;
  };
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    _file: string,
    args: string[],
    options?: { cwd?: string },
  ) => {
    ghCalls.push({ args: [...args], cwd: options?.cwd });
    return Promise.resolve({ stdout: "[]", stderr: "" });
  };

  return { ...actual, execFile: mockExecFile };
});

import { configureGh, listIssuesByLabel } from "../.sandcastle/lib/state/gh.js";

beforeEach(() => {
  ghCalls.length = 0;
  configureGh({ cwd: undefined });
});
afterEach(() => {
  configureGh({ cwd: undefined });
});

describe("configureGh — gh cwd threading", () => {
  it("forwards the configured repo cwd to the underlying gh call", async () => {
    configureGh({ cwd: "/tmp/managed-repo" });
    await listIssuesByLabel("ready-for-agent");
    expect(ghCalls.length).toBeGreaterThan(0);
    expect(ghCalls[0]?.cwd).toBe("/tmp/managed-repo");
  });

  it("leaves cwd undefined (process cwd / legacy behavior) when not configured", async () => {
    await listIssuesByLabel("ready-for-agent");
    expect(ghCalls.length).toBeGreaterThan(0);
    expect(ghCalls[0]?.cwd).toBeUndefined();
  });

  it("clears a previously-set cwd when reconfigured to undefined", async () => {
    configureGh({ cwd: "/tmp/a" });
    configureGh({ cwd: undefined });
    await listIssuesByLabel("ready-for-agent");
    expect(ghCalls[0]?.cwd).toBeUndefined();
  });
});
