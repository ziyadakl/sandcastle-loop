/**
 * A tiny, dependency-free glob matcher for repo-relative paths.
 *
 * WHY IT LIVES HERE AND NOT IN `lib/review/`: it was born inside the reviewer
 * escalation policy, because that policy was its first caller. It is not review
 * policy — it decides nothing about models, cost or escalation; it answers
 * "does this path match this pattern", which is a path question. Once
 * `lib/telemetry/rework-rate.ts` needed the same answer for its excluded-path
 * globs, importing it from `../review/escalation.js` meant telemetry breaking
 * the day the review module is moved or renamed. So both callers now import a
 * neutral module instead, and neither domain owns the other's matcher.
 *
 * Pure by construction — no IO, no clock, no state.
 */

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
