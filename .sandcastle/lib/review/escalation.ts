// First-pass reviewer escalation policy.
//
// The per-issue reviewer's FIRST pass normally runs on the cheap default model
// (Haiku). That is the right call for the common case — a small, ordinary diff —
// but a large refactor or a change to a sensitive path (DB migrations, etc.) is
// exactly where a cheap miss is most expensive. This module decides, purely from
// diff shape, whether that first pass should instead run on the reviewer's
// escalation model. One strong pass beats a cheap miss; ordinary diffs keep the
// cheap default so cost only rises where it matters.
//
// Everything here is pure (no IO): the caller measures the diff with git and
// passes the numbers in, so the policy is fully unit-testable.

type GetEnv = (key: string) => string | undefined;

/** Default added+deleted line count at/above which the first reviewer pass
 * escalates. Overridable via `SANDCASTLE_REVIEW_ESCALATE_DIFF_LINES`. */
export const DEFAULT_REVIEW_ESCALATE_DIFF_LINES = 400;

/** Default sensitive-path globs: DB migration files/dirs only. Deliberately
 * generic — no project's business paths are hardcoded. Overridable via
 * `SANDCASTLE_REVIEW_ESCALATE_PATHS` (comma-separated globs). */
export const DEFAULT_REVIEW_ESCALATE_PATHS: readonly string[] = [
  "**/migrations/**",
  "*.sql",
];

/**
 * Resolve `SANDCASTLE_REVIEW_ESCALATE_DIFF_LINES`. Honors a positive integer;
 * an unset/blank value OR any non-integer / non-positive value falls back to
 * {@link DEFAULT_REVIEW_ESCALATE_DIFF_LINES}. Mirrors `resolveLockTtlSec` in
 * `host-id.ts` (fail-soft to the default, never throw). `getEnv` is an
 * injectable seam for tests.
 */
export function reviewEscalateDiffLinesFromEnv(
  getEnv: GetEnv = (k) => process.env[k],
): number {
  const raw = (getEnv("SANDCASTLE_REVIEW_ESCALATE_DIFF_LINES") ?? "").trim();
  if (raw === "") return DEFAULT_REVIEW_ESCALATE_DIFF_LINES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_REVIEW_ESCALATE_DIFF_LINES;
  return n;
}

/**
 * Resolve `SANDCASTLE_REVIEW_ESCALATE_PATHS` (comma-separated globs). An
 * unset/blank value — or one that parses to zero non-empty entries — falls back
 * to {@link DEFAULT_REVIEW_ESCALATE_PATHS}. Each entry is trimmed; empty entries
 * (e.g. from a trailing comma) are dropped. `getEnv` is an injectable seam.
 */
export function reviewEscalatePathsFromEnv(
  getEnv: GetEnv = (k) => process.env[k],
): readonly string[] {
  const raw = (getEnv("SANDCASTLE_REVIEW_ESCALATE_PATHS") ?? "").trim();
  if (raw === "") return DEFAULT_REVIEW_ESCALATE_PATHS;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : DEFAULT_REVIEW_ESCALATE_PATHS;
}

/** Escape a string for literal use inside a RegExp, EXCEPT `*` and `/`, which
 * the glob translator handles specially. */
function escapeForGlobRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a simple glob to an anchored RegExp source. Supported tokens, matched
 * against a POSIX-style (`/`-separated) path:
 *   - `**` spanning directory boundaries, incl. zero leading/trailing segments
 *     (`**​/migrations/**` matches `migrations/x`, `a/migrations/b`, `a/migrations`)
 *   - `*` within a single path segment (never crosses `/`)
 * All other characters are literal.
 */
function globToRegExpSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      const doubled = pattern[i + 1] === "*";
      if (doubled) {
        // Collapse `**` (optionally with an adjacent `/`) into a segment-spanning
        // matcher that also allows zero segments, so a leading/inner/trailing
        // `**/` or `/**` doesn't force an extra separator.
        i++; // consume the second '*'
        if (pattern[i + 1] === "/") {
          i++; // consume trailing slash of `**/`
          out += "(?:.*/)?";
        } else if (out.endsWith("/")) {
          // `/**` — the slash we already emitted becomes optional.
          out = out.slice(0, -1) + "(?:/.*)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "/") {
      out += "/";
    } else {
      out += escapeForGlobRegex(c);
    }
  }
  return `^${out}$`;
}

/**
 * Does `filePath` (repo-relative, `/`-separated) match `pattern`? The full path
 * is tested against the glob; additionally, a pattern with no `/` is tested
 * against the path's basename, so `*.sql` matches a nested `db/schema.sql` too —
 * the intent of a sensitive-path rule is "any file of this shape, anywhere".
 */
export function pathMatchesGlob(filePath: string, pattern: string): boolean {
  const re = new RegExp(globToRegExpSource(pattern));
  if (re.test(filePath)) return true;
  if (!pattern.includes("/")) {
    const base = filePath.includes("/")
      ? filePath.slice(filePath.lastIndexOf("/") + 1)
      : filePath;
    if (re.test(base)) return true;
  }
  return false;
}

/**
 * Decide whether the FIRST reviewer pass should escalate to the stronger model.
 * Pure: returns true when the change is substantial (`changedLines >=
 * diffLineThreshold`, with the line rule disabled for a non-positive threshold)
 * OR any changed file matches any sensitive pattern. Small, ordinary diffs with
 * no sensitive path return false → the caller keeps the cheap default.
 */
export function shouldEscalateReviewer(input: {
  changedLines: number;
  changedFiles: readonly string[];
  diffLineThreshold: number;
  sensitivePathPatterns: readonly string[];
}): boolean {
  const { changedLines, changedFiles, diffLineThreshold, sensitivePathPatterns } =
    input;
  if (diffLineThreshold > 0 && changedLines >= diffLineThreshold) return true;
  for (const file of changedFiles) {
    for (const pattern of sensitivePathPatterns) {
      if (pathMatchesGlob(file, pattern)) return true;
    }
  }
  return false;
}
