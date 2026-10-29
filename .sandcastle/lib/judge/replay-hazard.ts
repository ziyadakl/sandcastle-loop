/**
 * Which builder diffs make the pre-builder replay LIE, and therefore may never
 * have the first test's rewrite proved against them (issue #1118, ruling 4;
 * since spec #1334 read by the first test's one rewrite, not by a judge).
 * Under `lib/judge/` for the reason `check-freeze.ts`'s header gives.
 *
 * ## The claim this module replaces
 *
 * Four places in this repository used to say that the replay reverts code but
 * not the database, and that this "skews toward a FALSE RED, never a false
 * green, so the guard still holds". **It is backwards, and nobody had checked
 * it.** RED is the answer the pre-builder proof WANTS. A red the repaired check
 * did not earn — old code meeting a schema a migration already moved, a
 * `node_modules` a dependency change already reshaped — certifies the rewrite
 * whatever the rewrite says. A free red is the weakened check's easiest route
 * through the gate. There is no safe direction to skew in; there is only a
 * measurement that means something and one that does not.
 *
 * ## So the repair refuses instead of warning
 *
 * TWO shapes of builder diff put something the replay cannot revert in front of
 * the pre-builder code:
 *
 *   - **A MIGRATION.** The host applies migrations against a real database
 *     before the check runs. The replay reverts the CODE; it cannot un-apply a
 *     column that was added, dropped or renamed. Pre-builder code then meets a
 *     schema that has already moved and throws at request time.
 *   - **A DEPENDENCY MANIFEST.** `node_modules` is ignored, so the replay
 *     deliberately leaves it warm — that is what makes a replay affordable at
 *     all. But a builder that added or removed a package has already reshaped
 *     it, and the pre-builder `package.json` the replay restores no longer
 *     describes what is installed. A removed package fails resolution outright,
 *     which is red for free in the pre-builder run and broken in every mutant
 *     run beside it.
 *
 * Refusing is ADDITIVE: the caller falls back to the stop it already had before
 * repairs existed, which names the ruling and holds the ticket. That is the
 * cheap, honest direction. Certifying a weakened check is not.
 *
 * Pure and total. The caller supplies the changed-file list and decides what to
 * do with an UNMEASURABLE one — which must be refused too, and is, at the call
 * site: a diff git could not be asked about is never an all-clear.
 */
import { pathMatchesGlob } from "../paths/glob.js";

/**
 * Paths whose presence in the builder's diff means the pre-builder run would be
 * measuring something other than the check.
 *
 * ## MIGRATIONS AND `*.sql` WERE REMOVED FOR A DAY AND ARE BACK (2026-08-21)
 *
 * They were dropped on the argument that layer 3 — `lib/judge/mutant-gate.ts`,
 * since deleted with the judge (spec #1334) —
 * "runs entirely on the FINISHED tree, where the schema and the code agree", so
 * a migration ticket could be measured honestly by the break test even though
 * the two-run proof could not measure it at all.
 *
 * **Only the CONTROL run does.** Every MUTANT is the finished tree with one
 * source file reverted, run against a database the host has already migrated.
 * Revert the file that reads the moved column and the page throws at request
 * time: the runner reports a failure, the exit code matches its counters, so
 * `readRunEvidence` proves it RED and `readMutantGate` counts it as CAUGHT. The
 * `graded` rule screens out RUNNER-level breakage — a collection failure, a
 * broken import — and an app-level failure at request time is indistinguishable
 * from the check noticing.
 *
 * So on a migration ticket BOTH surviving guards are satisfied for free: layer
 * 2's red half by the moved schema, and layer 3's one required hit by the same
 * mechanism. That is the exact fault this module was written to correct — a red
 * the rewrite did not earn certifies it whatever it says — reintroduced through
 * the mutant path instead of the replay path.
 *
 * Migrations remain excluded from being CHOSEN as mutants
 * (`NON_RUNTIME_MUTANT_RE`) as well, for the separate reason that reverting the
 * file does not un-apply the migration and a mutant that changes no behaviour
 * measures nothing. Neither exclusion substitutes for the other.
 */
export const REPLAY_HAZARD_GLOBS: readonly string[] = [
  "**/migrations/**",
  "**/*.sql",
  "**/package.json",
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
];

/**
 * Why a repair must not be attempted against this diff, in the owner's words —
 * or `undefined` when nothing in it defeats the replay.
 *
 * Names the offending paths rather than only the category: the owner reading
 * the stop has to be able to see WHICH file made the run decline, or the
 * refusal is indistinguishable from the feature being switched off.
 */
export function replayHazardIn(
  changedFiles: readonly string[],
): string | undefined {
  const hits = changedFiles.filter((f) =>
    REPLAY_HAZARD_GLOBS.some((g) => pathMatchesGlob(f, g)),
  );
  if (hits.length === 0) return undefined;
  const named = hits.slice(0, 5).join(", ");
  const more = hits.length > 5 ? ` (and ${hits.length - 5} more)` : "";
  return (
    `the builder's diff changed something the replay cannot put back — ` +
    `${named}${more}. The run reverts the CODE for this proof, but it cannot ` +
    `un-apply a migration the host has already run against the database, and ` +
    `it leaves the installed packages exactly as the builder left them. Old ` +
    `code standing in front of a moved schema or the wrong packages fails for ` +
    `a reason that has nothing to do with this check — and a failure is the ` +
    `answer both the pre-builder proof and the break test are looking for, so ` +
    `it would wave the rewrite through whatever the rewrite says`
  );
}
