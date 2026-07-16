/**
 * Canonical {@link GitRunner} adapters (Quality #2 dedup).
 *
 * Three call sites used to hand-roll the same ok/stdout/stderr/error-unwrap
 * shell-out to git: `checkpoint-stop.mts`, `launch.mts` (its git-resume runner),
 * and `mac-host-sandbox.ts`'s inline `createSandbox` adapter. They came in two
 * shapes, both preserved here byte-for-byte:
 *
 *   - {@link makeExecFileGitRunner} — async, over `execFileAsync`. Success is
 *     RAW (untrimmed) stdout/stderr; failure is `stderr: e.stderr ?? ""` with no
 *     message fallback (identical in both former async adapters).
 *   - {@link makeSyncGitRunner} — sync, over `execFileSync`. Success TRIMS
 *     stdout (`stderr: ""`); failure unwraps Buffer-or-string stdout/stderr,
 *     trims, and falls back to `e.message` when stderr is empty.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import type { GitRunner, GitRunResult } from "./issue-lease.js";

const execFileAsync = promisify(execFile);

/** Bump-proof cap matching the former inline async adapters' `maxBuffer`. */
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Async git runner (was `makeGitRunner()` in checkpoint-stop.mts and launch.mts,
 * identical in both). Returns raw, untrimmed stdout/stderr on success; on
 * failure `stderr` is `e.stderr ?? ""` — no message fallback.
 */
export function makeExecFileGitRunner(): GitRunner {
  return async (cwd: string, ...gitArgs: string[]): Promise<GitRunResult> => {
    try {
      const { stdout, stderr } = await execFileAsync("git", gitArgs, {
        cwd,
        maxBuffer: MAX_BUFFER,
      });
      return { ok: true, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  };
}

/**
 * Sync git runner (was the inline `gitRunner` in mac-host-sandbox.ts's
 * `createSandbox`). Trims stdout on success; on failure unwraps Buffer-or-string
 * stdout/stderr, trims, and falls back to `e.message` when stderr is empty.
 */
export function makeSyncGitRunner(): GitRunner {
  return (cwd: string, ...gitArgs: string[]): GitRunResult => {
    try {
      const stdout = execFileSync("git", gitArgs, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, stdout: stdout.trim(), stderr: "" };
    } catch (err) {
      const e = err as Error & {
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      const stderr =
        typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
      const stdout =
        typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
      return {
        ok: false,
        stdout: stdout.trim(),
        stderr: stderr.trim() || e.message,
      };
    }
  };
}
