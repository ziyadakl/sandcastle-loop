import path from "node:path";
import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

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
}

export interface MacHostRunSpec {
  readonly name: string;
  readonly maxIterations?: number;
  readonly model: string;
  readonly promptFile: string;
  readonly promptArgs?: Record<string, string>;
  readonly idleTimeoutSeconds?: number;
}

export interface MacHostRunHandle {
  readonly stdout: string;
  readonly commits: readonly string[];
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

function worktreePathFor(repoRoot: string, branch: string): string {
  return path.join(repoRoot, ".sandcastle", "worktrees", branch);
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

export function macHostSandbox(
  opts: MacHostSandboxOptions,
): MacHostSandboxFactory {
  const { repoRoot } = opts;

  return {
    async createSandbox(spec) {
      const wtPath = worktreePathFor(repoRoot, spec.branch);
      preCleanWorktree(repoRoot, wtPath);
      execFileSync(
        "git",
        ["worktree", "add", "-B", spec.branch, wtPath],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
      );

      return {
        branch: spec.branch,
        worktreePath: wtPath,
        async run(_runSpec): Promise<MacHostRunHandle> {
          throw new Error("run() not yet implemented");
        },
        async close() {
          preCleanWorktree(repoRoot, wtPath);
        },
      };
    },

    async run(_spec): Promise<MacHostRunHandle> {
      throw new Error("top-level run() not yet implemented");
    },
  };
}
