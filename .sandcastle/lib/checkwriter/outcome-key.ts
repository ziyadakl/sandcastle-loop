/**
 * The check-writer's marker vocabulary in its TELEMETRY spelling — derived
 * from {@link CHECK_WRITER_MARKERS}, never re-typed (issue #956).
 *
 * The agent says `CHECKS_WRITTEN`; the durable record says `checks-written`.
 * One vocabulary, two spellings, and until #956 the kebab one was HAND-COPIED
 * in three unrelated files, none of them reading the canonical list in
 * `./schema.ts`. Each copy failed differently, and all three failed SILENTLY
 * — which is why `UNIT_CHECK_WRITTEN`, the fifth marker, was the thing that
 * would have found them:
 *
 *   - `lib/status/schema.ts`'s inline `z.enum([...])` on
 *     `IssueTelemetryRow.checkWriterOutcome` — a value outside its four
 *     rejects at `safeParse`, and because the row is parsed as a whole, that
 *     takes down the WHOLE status snapshot, not just this field.
 *   - `lib/telemetry/issue-bag.ts`'s `CHECK_WRITER_OUTCOMES` set — the only
 *     runtime gate on `noteCheckWriterOutcome`, which DROPS anything it does
 *     not recognise (correctly: see that file's "DROP, DON'T POISON"). An
 *     unlisted fifth outcome therefore produces a blank telemetry column that
 *     reads exactly like "the check-writer never ran".
 *   - `main.mts`'s `checkWriterOutcomeTelemetryKey` — a `switch` with a
 *     hand-written return-type union, so a new marker falls through it
 *     returning `undefined` at runtime while the compiler, satisfied by the
 *     stale union, says nothing.
 *
 * This module is the single author of that spelling, and everything above now
 * reads it. It is the policy `lib/telemetry/issue-bag.ts:85-117` already
 * states for `SHIP_PATHS`, `OUTCOMES` and `SCREEN_CHECK_VERDICTS` — "a
 * hand-kept copy quietly stops recognising the next verdict someone adds" —
 * applied to the one enum in that file that was still violating it.
 */

import { CHECK_WRITER_MARKERS, type CheckWriterMarker } from "./schema.js";

/**
 * `SCREAMING_SNAKE` → `kebab-case`, at the type level, so the key union is
 * COMPUTED from the marker union rather than restated beside it. Restating it
 * is precisely what #956 removed; a second literal union here would put the
 * bug back one file over.
 */
type KebabOf<S extends string> = S extends `${infer H}_${infer T}`
  ? `${Lowercase<H>}-${KebabOf<T>}`
  : Lowercase<S>;

/** The wire vocabulary `IssueTelemetryRow.checkWriterOutcome` speaks. */
export type CheckWriterOutcomeKey = KebabOf<CheckWriterMarker>;

/** The same transform applied element-wise, preserving tuple length and order. */
type KebabTuple<T extends readonly string[]> = {
  readonly [I in keyof T]: KebabOf<T[I]>;
};

/**
 * The runtime half of {@link KebabOf}.
 *
 * The assertion is unavoidable: TypeScript cannot see that
 * `toLowerCase()` + `replaceAll("_", "-")` computes the same thing
 * `KebabOf` does — string METHODS return plain `string`, only template-literal
 * TYPES carry the transform. What makes the assertion safe is not the
 * compiler, it is `outcome-key.test.ts`, which pins every marker's key as a
 * literal, so a marker whose spelling the two halves disagree about (an
 * embedded digit, a doubled underscore, a hyphen already in the marker) fails
 * the suite rather than shipping a key nothing downstream recognises.
 */
export function checkWriterOutcomeKey(
  marker: CheckWriterMarker,
): CheckWriterOutcomeKey {
  return marker.toLowerCase().replaceAll("_", "-") as CheckWriterOutcomeKey;
}

/**
 * Every key, in `CHECK_WRITER_MARKERS` order, typed as a readonly TUPLE (not
 * `string[]`) so `z.enum(...)` keeps the literal union instead of widening to
 * `string` — the same shape `CHECK_WRITER_MARKERS` itself hands `z.enum` in
 * `./schema.ts`. `lib/status/schema.ts` feeds this straight to `z.enum`, and
 * `issue-bag.ts` reads `.options` back off that schema, so there is one chain
 * from one list and no branch of it can drift from another.
 */
const outcomeKeys: readonly CheckWriterOutcomeKey[] = CHECK_WRITER_MARKERS.map(
  (marker) => checkWriterOutcomeKey(marker),
);
export const CHECK_WRITER_OUTCOME_KEYS = outcomeKeys as KebabTuple<
  typeof CHECK_WRITER_MARKERS
>;
