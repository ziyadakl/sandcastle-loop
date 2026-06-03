import path from "node:path";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { worktreePathFor as canonicalWorktreePathFor } from "./worktree-path.js";

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Mirrors the SDK's substitutePromptArgs contract for the keys this repo
// uses: same placeholder regex, fail-loud on unmatched key. Does NOT inject
// SOURCE_BRANCH/TARGET_BRANCH built-ins or preprocess !`...` shell blocks —
// see FOLLOW_UPS.md.
export function applyPromptArgs(
  prompt: string,
  args: Record<string, string>,
): string {
  return prompt.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    if (!(key in args)) {
      throw new Error(
        `Prompt argument "{{${key}}}" has no matching value in promptArgs`,
      );
    }
    return args[key];
  });
}

// Fields shared by every spec passed to spawnAgent. The buildArgs callback
// reads from this base so callers can declare it once without picking which
// concrete spec type they want — TS function-parameter contravariance makes
// `(spec: MacHostRunSpec) =>` unassignable to a wider union slot, but the
// base type sidesteps that trap.
export interface MacHostRunSpecBase {
  readonly name: string;
  readonly maxIterations?: number;
  readonly model: string;
  readonly promptFile: string;
  readonly promptArgs?: Record<string, string>;
  readonly idleTimeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

export interface MacHostSandboxOptions {
  readonly repoRoot: string;
  readonly env?: Record<string, string>;
  /**
   * Override the binary spawned to run the agent. Default `claude` from PATH.
   * Test code injects a fake binary here for deterministic behavior.
   * `SANDCASTLE_MAC_HOST_CLAUDE_BIN` is consulted as a fallback when this
   * option is omitted.
   *
   * If you set `claudeBin` WITHOUT `buildArgs`, the legacy single-positional
   * form is used: the binary is invoked as `claudeBin <promptFullPath>` and
   * stdin is closed. This matches the historical `/bin/cat <promptFile>` test
   * seam shape. For full control over argv and stdin, also set `buildArgs`.
   */
  readonly claudeBin?: string;
  /**
   * Build the argv passed to the binary. When set, stdin receives the
   * substituted prompt text (production-equivalent behavior). When omitted,
   * args default to production flags if no binary override is in effect, or
   * to `[promptFullPath]` (legacy positional seam) if a binary override is.
   */
  readonly buildArgs?: (spec: MacHostRunSpecBase) => readonly string[];
}

export interface MacHostCreateSpec {
  readonly branch: string;
}

export interface MacHostTopLevelRunSpec extends MacHostRunSpecBase {
  readonly cwd?: string;
}

export interface MacHostRunSpec extends MacHostRunSpecBase {}

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
  opts: MacHostSandboxOptions,
): Promise<MacHostRunHandle> {
  const promptFullPath = path.join(cwd, runSpec.promptFile);
  if (!existsSync(promptFullPath)) {
    throw new Error(`prompt file not found: ${promptFullPath}`);
  }
  const rawPrompt = readFileSync(promptFullPath, "utf8");
  const promptText = applyPromptArgs(rawPrompt, runSpec.promptArgs ?? {});

  // Spawn mode drives three policies (argv shape, stdin piping, exit-code
  // handling) off the same upstream choice — encode it once.
  //   - production: default `claude` binary, production flags, prompt via
  //     stdin, non-zero exit fails.
  //   - explicit-args: caller supplied buildArgs; same stdin/exit policy as
  //     production but argv comes from the callback.
  //   - legacy-positional: caller supplied only claudeBin (option or env
  //     var); argv is `[promptFullPath]`, stdin is closed, non-zero exit is
  //     tolerated. Used by /bin/cat-style test seams.
  // The previous NODE_ENV === "test" implicit branch is intentionally gone
  // — that seam was global-state that could leak into production.
  const envBin = process.env.SANDCASTLE_MAC_HOST_CLAUDE_BIN;
  const mode: "production" | "explicit-args" | "legacy-positional" =
    opts.buildArgs !== undefined
      ? "explicit-args"
      : opts.claudeBin !== undefined || envBin !== undefined
        ? "legacy-positional"
        : "production";
  const claudeBin = opts.claudeBin ?? envBin ?? "claude";
  const claudeArgs =
    mode === "explicit-args"
      ? [...opts.buildArgs!(runSpec)]
      : mode === "legacy-positional"
        ? [promptFullPath]
        : [
            "--print",
            "--model", runSpec.model,
            "--dangerously-skip-permissions",
          ];
  const pipePromptToStdin = mode !== "legacy-positional";
  const failOnNonZero = mode !== "legacy-positional";

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
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Pass the prompt according to the resolved stdin policy: production and
    // explicit buildArgs callers receive prompt text on stdin; legacy
    // positional-arg seams close stdin so /bin/cat doesn't block.
    if (pipePromptToStdin) {
      child.stdin.end(promptText);
    } else {
      child.stdin.end();
    }

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
      if (code !== 0 && failOnNonZero) {
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
          return await spawnAgent(wtPath, runSpec, opts.env ?? {}, forkSha, opts);
        },
        async close() {
          preCleanWorktree(repoRoot, wtPath);
        },
      };
    },

    async run(spec): Promise<MacHostRunHandle> {
      const effectiveCwd = spec.cwd ?? repoRoot;
      const forkSha = execFileSync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: effectiveCwd, stdio: ["ignore", "pipe", "ignore"] },
      ).toString("utf8").trim();
      return await spawnAgent(effectiveCwd, spec, opts.env ?? {}, forkSha, opts);
    },
  };
}
