import path from "node:path";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Append `entry` to the COMMON git directory's `info/exclude` (idempotent),
 * so git never sees a loop-written file as untracked. Never throws: a
 * failure (including a plain non-git directory) calls `warn` once.
 */
export function addToGitInfoExclude(
  worktreePath: string,
  entry: string,
  warn: (message: string) => void = () => {},
): void {
  try {
    const excludeRel = execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: worktreePath, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString("utf8")
      .trim();
    const excludePath = path.resolve(worktreePath, excludeRel);
    const existing = existsSync(excludePath)
      ? readFileSync(excludePath, "utf8")
      : "";
    const alreadyExcluded = existing
      .split("\n")
      .some((line) => line.trim() === entry);
    if (!alreadyExcluded) {
      const prefix =
        existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
      appendFileSync(excludePath, `${prefix}${entry}\n`);
    }
  } catch (err) {
    warn(
      `failed to add ${entry} to git's info/exclude in ${worktreePath}: ` +
        `${(err as Error).message}`,
    );
  }
}
