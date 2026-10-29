/**
 * Protected paths — the loop's first path-based refusal (issue #909 / Piece C
 * of `docs/specs/2026-08-04-screen-check-design-lock.md`).
 *
 * Before this module, nothing in `.sandcastle/main.mts` or `.sandcastle/lib/`
 * refused a change to a specific file. Every existing "refuse" is a git error
 * or a merge-conflict case (a HUMAN's file collided with another human's
 * file); none of them read a path and said "not this one". This is new
 * machinery, verified absent by grepping `main.mts` and every module under
 * `lib/` (recursively) for path-conditioned refusals before writing a line
 * of it.
 *
 * ## One mechanism, two uses
 *
 * The design calls for exactly one lock, aimed at two different kinds of file:
 *
 *   1. **Project-declared paths** (`protectedPaths` in
 *      `.sandcastle/project.json`) — barred to EVERY agent, builder and
 *      check-writer alike: seed data a check's answer could be written
 *      through, the check runner's own config, the code that reads a check's
 *      verdict. If the check-writer could edit them, it could make its own
 *      check come out right. Empty unless the project sets it — see
 *      {@link defaultProtectedPathGlobs}.
 *
 *   2. **The acceptance-check file** the check-writing agent hands the
 *      builder. The builder reads it and aims at it; it must never be able to
 *      edit it. {@link resolveProtectedPathGlobs} accepts a PER-JOB glob list
 *      as its second input for that.
 *
 * ## Additive only, never subtractive
 *
 * The per-job list can only ADD globs on top of the project's; it can never
 * remove or replace them. An env-var-replaces-defaults design was deliberately
 * rejected here: a misconfigured or empty override would silently un-protect
 * the project's files, which is exactly the failure this module exists to make
 * impossible.
 *
 * ## What this module does NOT do
 *
 * It only ANSWERS "does this changed path match a protected glob" — pure, no
 * IO, no git, matching `lib/paths/glob.ts`'s own contract. Restoring a
 * tampered path (reading the original blob back out of git, writing it to the
 * worktree, committing the restoration) is real IO and lives in the sibling
 * module `protected-path-restore.ts`, deliberately kept out of this one so the
 * detection logic stays trivially unit-testable and the IO stays isolated to
 * where a test needs a real git repo to exercise it.
 */

import { getProjectConfig } from "../project-config.js";
import { pathMatchesGlob } from "./glob.js";

/**
 * Always-on protected-path globs — no per-job value, env var, or caller can
 * remove these. They come from `protectedPaths` in `.sandcastle/project.json`
 * (see `project.example.json` for the kinds of file worth listing: the check
 * runner's config, the code that grades a check, seed data). Nothing is
 * built in: which files decide a check's verdict is a fact about the project.
 */
export function defaultProtectedPathGlobs(): readonly string[] {
  return getProjectConfig().protectedPaths;
}

/**
 * Resolve the full protected-path glob set for one job: the always-on
 * defaults, plus whatever the job itself declared (today: nothing real ever
 * does — see the module header). `perJobGlobs` is validated element-by-element
 * (`typeof === "string"`, non-blank after trim) and never coerced, matching
 * `lib/telemetry/issue-bag.ts`'s "total, never throw" discipline for anything
 * that might be handed a hostile or malformed value; a non-array or garbage
 * input is treated as "the job declared nothing extra", not an error.
 *
 * De-duplicated (a per-job glob identical to a default, or repeated by a
 * caller, contributes exactly one entry) so a consumer counting "how many
 * globs are active" gets an honest number.
 */
export function resolveProtectedPathGlobs(
  perJobGlobs?: readonly string[],
): readonly string[] {
  const extra: string[] = [];
  if (Array.isArray(perJobGlobs)) {
    for (const g of perJobGlobs) {
      if (typeof g === "string" && g.trim().length > 0) extra.push(g);
    }
  }
  return [...new Set([...defaultProtectedPathGlobs(), ...extra])];
}

/**
 * Which of `changedFiles` land inside a protected glob? Pure: given the same
 * two inputs it always returns the same paths, in the order they appeared in
 * `changedFiles` (not the order the globs are declared) — so a caller logging
 * "these files were touched" reads the same order the diff itself reported.
 *
 * Total, like every function in this module: a non-array `changedFiles`, or a
 * non-string/blank entry inside it, is skipped rather than thrown on — the
 * caller is a ship-time gate on an overnight run, where a telemetry-adjacent
 * throw can kill a $300 night for a reason that has nothing to do with the
 * lock actually working.
 */
export function detectProtectedPathViolations(
  changedFiles: readonly string[],
  protectedGlobs: readonly string[],
): string[] {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return [];
  if (!Array.isArray(protectedGlobs) || protectedGlobs.length === 0) return [];
  const hits: string[] = [];
  for (const file of changedFiles) {
    if (typeof file !== "string" || file.length === 0) continue;
    if (protectedGlobs.some((g) => pathMatchesGlob(file, g))) hits.push(file);
  }
  return hits;
}
