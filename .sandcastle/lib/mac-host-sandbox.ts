import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { worktreePathFor as canonicalWorktreePathFor } from "../main.mjs";

export interface MacHostSandboxOptions {
  readonly repoRoot: string;
  readonly env?: Record<string, string>;
}

export interface MacHostCreateSpec {
  readonly branch: string;
}

export interface MacHostTopLevelRunSpec {
  readonly name: string;
  readonly maxIterations?: number;
  readonly model: string;
  readonly promptFile: string;
  readonly promptArgs?: Record<string, string>;
  readonly idleTimeoutSeconds?: number;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface MacHostRunSpec {
  readonly name: string;
  readonly maxIterations?: number;
  readonly model: string;
  readonly promptFile: string;
  readonly promptArgs?: Record<string, string>;
  readonly idleTimeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface MacHostRunHandle {
  readonly stdout: string;
  readonly commits: readonly { sha: string }[];
  // Reserved for future sessionFilePath integration:
  readonly iterations?: readonly {
    readonly sessionFilePath?: string;
    readonly sessionId?: string;
  }[];
}

export interface MacHostSandboxHandle {
  readonly branch: string;
  readonly worktreePath: string;
  run(spec: MacHostRunSpec): Promise<MacHostRunHandle>;
  close(): Promise<void>;
}

export interface MacHostSandboxFactory {
  createSandbox(spec: MacHostCreateSpec): Promise<MacHostSandboxHandle>;
  run(spec: MacHostTopLevelRunSpec): Promise<MacHostRunHandle>;
}

function absoluteWorktreePath(repoRoot: string, branch: string): string {
  return path.join(repoRoot, canonicalWorktreePathFor(branch));
}

function preCleanWorktree(repoRoot: string, wtPath: string): void {
  // Mirror main.mts:1745-1772 — three-tier cleanup so a stale registration
  // or orphan dir never blocks a fresh `git worktree add`.
  if (existsSync(wtPath)) {
    try {
      execFileSync(
        "git",
        ["worktree", "remove", "--force", wtPath],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      rmSync(wtPath, { recursive: true, force: true });
    }
  }
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // best-effort
  }
}

function readCommitsSince(wtPath: string, forkSha: string): { sha: string }[] {
  try {
    const out = execFileSync(
      "git",
      ["log", "--format=%H", `${forkSha}..HEAD`],
      { cwd: wtPath, stdio: ["ignore", "pipe", "ignore"] },
    ).toString("utf8");
    return out.split("\n").filter(Boolean).map((sha) => ({ sha }));
  } catch {
    return [];
  }
}

async function spawnAgent(
  cwd: string,
  runSpec: MacHostRunSpec | MacHostTopLevelRunSpec,
  env: Record<string, string>,
  forkSha: string | null,
): Promise<MacHostRunHandle> {
  const promptFullPath = path.join(cwd, runSpec.promptFile);
  if (!existsSync(promptFullPath)) {
    throw new Error(`prompt file not found: ${promptFullPath}`);
  }

  // The Claude Code CLI binary used by the host. Override via env for
  // tests. Default `claude` is whatever's on PATH (the user's normal CLI).
  const claudeBin =
    process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN ??
    (process.env.NODE_ENV === "test" ? "/bin/cat" : "claude");
  // When SANDCASTLE_MAC_HOST_CLAUDE_BIN is set (test seam) or we're in the
  // default test path (/bin/cat), pass only the prompt path as the argument
  // so the substitute binary receives it cleanly (cat reads it, sleep uses it
  // as duration, etc.). In production the full Claude CLI flags are used.
  const isTestSeam = process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN !== undefined
    || process.env.NODE_ENV === "test";
  const claudeArgs = isTestSeam
    ? [promptFullPath]
    : [
        "--model", runSpec.model,
        "--print",
        "--prompt-file", promptFullPath,
      ];

  const childEnv = { ...process.env, ...env };
  const idleMs = (runSpec.idleTimeoutSeconds ?? 600) * 1000;

  return await new Promise<MacHostRunHandle>((resolve, reject) => {
    let settled = false;
    const safeReject = (err: Error) => {
      if (!settled) { settled = true; reject(err); }
    };
    const safeResolve = (val: MacHostRunHandle) => {
      if (!settled) { settled = true; resolve(val); }
    };

    const child = spawn(claudeBin, claudeArgs, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wire abort signal — kill the child and reject before it can settle normally.
    const onAbort = () => {
      child.kill("SIGTERM");
      safeReject(new Error(`run "${runSpec.name}": aborted`));
    };
    if (runSpec.signal) {
      if (runSpec.signal.aborted) {
        child.kill("SIGTERM");
        safeReject(new Error(`run "${runSpec.name}": already aborted before spawn`));
      } else {
        runSpec.signal.addEventListener("abort", onAbort);
      }
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let lastChunkAt = Date.now();
    const idleTimer = setInterval(() => {
      if (Date.now() - lastChunkAt > idleMs) {
        clearInterval(idleTimer);
        child.kill("SIGTERM");
        safeReject(new Error(`run "${runSpec.name}": idle timeout after ${idleMs}ms`));
      }
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      lastChunkAt = Date.now();
      stdoutBuf += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      lastChunkAt = Date.now();
      stderrBuf += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (err: Error) => {
      clearInterval(idleTimer);
      runSpec.signal?.removeEventListener("abort", onAbort);
      safeReject(err);
    });
    child.on("close", (code: number | null) => {
      clearInterval(idleTimer);
      runSpec.signal?.removeEventListener("abort", onAbort);
      if (code !== 0 && !isTestSeam) {
        safeReject(new Error(
          `run "${runSpec.name}" exited ${code}: ${stderrBuf.slice(-500)}`,
        ));
        return;
      }
      // commits: read git log on the worktree branch since createSandbox,
      // or return [] when running outside any worktree (forkSha === null).
      const commits = forkSha !== null ? readCommitsSince(cwd, forkSha) : [];
      safeResolve({ stdout: stdoutBuf, commits });
    });
  });
}

export function macHostSandbox(
  opts: MacHostSandboxOptions,
): MacHostSandboxFactory {
  const { repoRoot } = opts;

  return {
    async createSandbox(spec) {
      const wtPath = absoluteWorktreePath(repoRoot, spec.branch);
      preCleanWorktree(repoRoot, wtPath);
      execFileSync(
        "git",
        ["worktree", "add", "-B", spec.branch, wtPath],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      const forkSha = execFileSync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: wtPath, stdio: ["ignore", "pipe", "ignore"] },
      ).toString("utf8").trim();

      return {
        branch: spec.branch,
        worktreePath: wtPath,
        async run(runSpec): Promise<MacHostRunHandle> {
          return await spawnAgent(wtPath, runSpec, opts.env ?? {}, forkSha);
        },
        async close() {
          preCleanWorktree(repoRoot, wtPath);
        },
      };
    },

    async run(spec): Promise<MacHostRunHandle> {
      const effectiveCwd = spec.cwd ?? repoRoot;
      return await spawnAgent(effectiveCwd, spec, opts.env ?? {}, null);
    },
  };
}
