/**
 * Temp-git-repo helpers shared by `.sandcastle`'s host-side tests.
 *
 * WHY THIS FILE EXISTS: the diff-measurement tests drive real `git diff
 * --numstat` / `git merge-base` against real commits rather than stubbing the
 * git layer, so several describe blocks each need "make a commit in this temp
 * repo and give me its sha". That helper had been copy-pasted per describe;
 * when the ship-funnel blocks moved to `main.ship.test.mts` the copies would
 * have crossed a FILE boundary, where a drift between them stops being
 * obvious. One definition, imported by both files, removes that hazard.
 *
 * NOT a `*.test.ts` file on purpose: vitest's default include glob only picks
 * up `*.{test,spec}.*`, so this module is imported, never collected as a suite.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Run git in `cwd` and return trimmed stdout. Throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * `git` with extra environment — the only way to forge a commit's dates, which
 * the rework walk's traversal-vs-filter test needs (committer-date skew is what
 * makes `--since` prune history rather than filter it).
 */
export function gitWithEnv(
  cwd: string,
  env: Readonly<Record<string, string>>,
  ...args: string[]
): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

/**
 * Write `files` (path → contents, relative to `repo`, parent dirs created),
 * commit them all, and return the resulting sha.
 */
export function commitInto(
  repo: string,
  files: Record<string, string>,
  message: string,
): string {
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(repo, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}
