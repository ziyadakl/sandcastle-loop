/**
 * WHICH RUNNER grades a check-writer's check (issue #956).
 *
 * Until this existed there was only one runner, and "run the check and read
 * its result" meant "run Playwright" in four separate hardcoded places: the
 * command string (`check-path.ts`), the `.spec.ts` filename rule
 * (`check-path.ts` + `schema.ts`), the tally reader (`lib/harness/verdict.ts`
 * with a byte-identical copy in `verify-checks.ts`), and the timeout budget
 * (`lib/harness/run-harness-check.ts`). A ticket with no screen to open
 * therefore had no way to offer a red-first proof at all: it either took the
 * `NO_SCREEN_APPLIES` escape hatch and shipped with NO proof, or it burned an
 * hour trying to photograph something that does not render and stopped. On the
 * night of 2026-08-04 that halted a 71-ticket run at ticket 3.
 *
 * This type is the seam that lets one mechanism serve both runners. Everything
 * else about the red-first rule is deliberately IDENTICAL across the two — the
 * same must-fail-first receipt, the same sha256 lock over the check's exact
 * bytes, the same ship-time re-run. ONLY the runner changes. That is the whole
 * design constraint, and it is why this is a two-value enum threaded through
 * the existing functions rather than a parallel set of unit-flavoured copies
 * of them: a copy is how the two would drift into checking different things.
 *
 * ## Why this is not "browser vs backend"
 *
 * It names the INSTRUMENT, not the ticket. Which instrument a given ticket is
 * *entitled* to use is a separate question with a separate answer — see
 * `proof-demand.ts`, which computes that from the FINISHED diff at ship time
 * rather than taking any agent's word for it.
 *
 * Pure by construction — no IO, no clock, no state. The one import below is a
 * TYPE import, so this module still contributes no runtime edge to anything.
 */

import type { CheckWriterMarker } from "./schema.js";

/** The two ways a check-writer's check can be executed and graded. */
export const CHECK_KINDS = ["browser", "unit"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/**
 * The runner's human name, for stop messages and run logs. Kept beside the
 * enum so a new kind cannot be added without someone deciding what to call it
 * in the one place an owner triaging a stopped ticket will read.
 */
export const CHECK_KIND_RUNNER_NAME: Readonly<Record<CheckKind, string>> = {
  browser: "Playwright",
  unit: "vitest",
};

/**
 * Which runner does this outcome's check need — or `undefined` when the
 * outcome writes no check at all?
 *
 * THE SINGLE DERIVATION of "does this marker produce a check, and if so whose
 * runner grades it". `main.mts` asks it in four places that must never
 * disagree: whether to run the must-fail-first proof and with which rules,
 * whether an unproven proof may spend the check-writer's one retry, whether to
 * commit and LOCK a check directory before the builder starts, and which
 * runner's budget and grading the ship-time re-run gets. Written out four
 * times as `marker === "CHECKS_WRITTEN" || marker === "UNIT_CHECK_WRITTEN"`,
 * the fifth site is the one that forgets — and the fifth site is the lock,
 * whose absence makes the whole proof worthless because the builder can then
 * edit the check it is about to be graded by.
 *
 * Exhaustive by construction, exactly as `proofOfferedByMarker` is: the
 * `switch` has no `default`, so adding a sixth marker to
 * `CHECK_WRITER_MARKERS` fails to COMPILE here rather than silently answering
 * `undefined` — which would read as "this outcome writes no check" and skip
 * every one of those four steps in silence.
 *
 * Note this answers a DIFFERENT question from `proofOfferedByMarker`
 * (`proof-demand.ts`), and the two must not be collapsed: this one is "which
 * instrument runs", that one is "how strong is the proof on offer", and
 * `NO_SCREEN_APPLIES` is the case where they part company — no instrument, but
 * a real (and lowest) offer of `none`.
 */
export function checkKindForMarker(
  marker: CheckWriterMarker,
): CheckKind | undefined {
  switch (marker) {
    case "CHECKS_WRITTEN":
      return "browser";
    case "UNIT_CHECK_WRITTEN":
      return "unit";
    case "ALREADY_BUILT":
    case "NEEDS_WORLD_DATA":
    case "NO_SCREEN_APPLIES":
      return undefined;
  }
}
