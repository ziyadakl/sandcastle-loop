/**
 * The `finalMarker` an #1110 case-2 auto-close carries. It reports `status:
 * "ok"` so the ship accounting lists it in `Closes #N`, but no builder ran, so
 * it must be kept OUT of the Phase-3 merge batch. `selectMergeBatch` (`main.mts`) is
 * the one place that exclusion lives; `disposeAlreadyBuilt` is the one place
 * the marker is minted. Both reference this constant so the two cannot drift.
 */
export const ALREADY_BUILT_ON_STAGING_MARKER = "ALREADY_BUILT_ON_STAGING";

/**
 * The `finalMarker` a reviewer-confirmed already-built close carries (spec
 * #1334, SG): the test-writer read the change as already in the code, the
 * reviewer confirmed it, and nothing was built. Like the #1110 case-2 close
 * it reports `"ok"` for the ship accounting and must stay OUT of the merge
 * batch — {@link builtNothing} is the one test every exclusion site asks.
 */
export const ALREADY_BUILT_CONFIRMED_MARKER = "ALREADY_BUILT_CONFIRMED";

/** True for an `"ok"` outcome that built nothing and so merges nothing. */
export function builtNothing(finalMarker: string | undefined): boolean {
  return (
    finalMarker === ALREADY_BUILT_ON_STAGING_MARKER ||
    finalMarker === ALREADY_BUILT_CONFIRMED_MARKER
  );
}
