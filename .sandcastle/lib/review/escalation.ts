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
//
// POLICY ONLY, since issue #959. This module used to also hold `parseNumstat`
// and `parseGuttedFiles`, and the header above was false of both: neither is a
// reviewer-escalation decision, and `parseGuttedFiles` feeds the ship-time
// removal gate, which never asks this module anything. They now live in
// `./numstat.ts` beside the one record loop they share. Keep this module a
// policy module — a parser that lands here is a parser nothing here reads.

// The glob matcher lives in `lib/paths/` on purpose: it is a path question,
// not review policy, and `lib/telemetry/rework-rate.ts` needs the same answer.
import { pathMatchesGlob } from "../paths/glob.js";

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
