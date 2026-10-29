/**
 * Spec #1368, decision 1: every sandbox container is created with hard
 * memory / swap / process / cgroup limits, so one runaway search in one
 * container cannot freeze the whole server (the 2026-10-13 freeze: a single
 * grep grew to 18 GB).
 *
 * Exercises the REAL docker provider from the (patched) `@ai-hero/sandcastle`
 * with a fake `docker` binary on PATH that records the argv it receives, so
 * this proves both that the loop asks for the limits and that the library
 * patch (`patches/@ai-hero__sandcastle@0.12.0.patch`) turns them into flags.
 * Same real-spawn-of-a-fake-binary discipline as
 * `mac-host-sandbox.production-argv.test.ts`.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTAINER_CGROUP_PARENT,
  CONTAINER_MEMORY,
  CONTAINER_MEMORY_SWAP,
  CONTAINER_PIDS_LIMIT,
  makeDockerProvider,
} from "./sandbox-provider.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

describe("docker provider hands hard resource limits to `docker run`", () => {
  let repo: string;
  let binDir: string;
  let argvLog: string;
  const savedPath = process.env.PATH;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-docker-limits-repo-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    writeFileSync(path.join(repo, "README.md"), "seed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "seed");

    binDir = mkdtempSync(path.join(tmpdir(), "sc-docker-limits-bin-"));
    argvLog = path.join(binDir, "argv.log");
    // One line per invocation, args joined by U+001F so a value with spaces
    // cannot be confused with a separator. Every subcommand succeeds with no
    // output: `image inspect` empty (uid check passes), `ps -a` empty (no
    // existing container), `run`/`exec`/`rm` fine.
    const fake = path.join(binDir, "docker");
    writeFileSync(
      fake,
      `#!/bin/sh\nIFS=$(printf '\\037'); echo "$*" >> "${argvLog}"\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(repo, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  });

  it("the run argv carries --memory, --memory-swap, --pids-limit and --cgroup-parent", async () => {
    const provider = makeDockerProvider(
      {
        imageName: "sandcastle:limits-test",
        repoRoot: repo,
        hooks: {},
        copyToWorktree: [],
        copyToWorktreeMs: 1000,
        completionSignal: ["DONE"],
      },
      {},
    );
    // The fake container has no real filesystem, so later steps may fail;
    // only the `docker run` line matters here.
    await provider
      .createSandbox({ branch: "limits-test", sandboxEnv: {} })
      .catch(() => undefined);

    const runLine = readFileSync(argvLog, "utf8")
      .split("\n")
      .find((l) => l.startsWith("run\u001f"));
    expect(runLine, "no `docker run` was issued").toBeDefined();
    const argv = (runLine as string).split("\u001f");

    const valueOf = (flag: string): string | undefined => {
      const i = argv.indexOf(flag);
      return i === -1 ? undefined : argv[i + 1];
    };
    expect(valueOf("--memory")).toBe("8g");
    expect(valueOf("--memory-swap")).toBe("8g");
    expect(valueOf("--pids-limit")).toBe("4096");
    expect(valueOf("--cgroup-parent")).toBe("sandcastle.slice");

    // Named constants stay in step with what the spec requires.
    expect(CONTAINER_MEMORY).toBe("8g");
    expect(CONTAINER_MEMORY_SWAP).toBe(CONTAINER_MEMORY);
    expect(CONTAINER_PIDS_LIMIT).toBe(4096);
    expect(CONTAINER_CGROUP_PARENT).toBe("sandcastle.slice");

    // The flags go before the image name, which `docker run` requires.
    expect(argv.indexOf("--cgroup-parent")).toBeLessThan(
      argv.indexOf("sandcastle:limits-test"),
    );
  });
});
