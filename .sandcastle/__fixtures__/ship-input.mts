/**
 * Shared defaults for `shipAfterMigrations`'s named inputs (issue #1227).
 *
 * ## Why this file exists
 *
 * Issue #1227 made every field of `ShipAfterMigrationsInput` REQUIRED —
 * `| undefined` rather than `?` — so a caller that forgets one gets a type
 * error instead of a silent omission. That guarantee is aimed at the five
 * RUNNING call sites in `main.mts`, which is where a dropped field ships a
 * wrong decision.
 *
 * The 48 TEST call sites are a different matter. Most of them care about two
 * or three fields and were passing seven positional arguments; making each one
 * restate all fourteen would have added roughly 400 lines of noise and made
 * the one migration commit unreadable. They spread these defaults instead.
 *
 * ## The trade this file takes, stated plainly
 *
 * A test site that spreads these defaults CANNOT catch a missing field — the
 * spread supplies it. That is deliberate and it is the right way round: when a
 * fifteenth required field is added later, the five running call sites break
 * and demand a real answer, while the 48 tests keep compiling on a default
 * that was never the point of what they assert.
 *
 * **Never spread this into production code.** `main.mts`'s five call sites
 * write every field out, and that is the whole guarantee.
 *
 * ## Why three fields are missing from it
 *
 * `preSha`, `postSha` and `finalMarker` are deliberately NOT defaulted. They
 * are the inputs every test actually varies, and a placeholder commit
 * fingerprint silently standing in for a real one is exactly the class of
 * quiet wrongness this issue set out to remove. `Omit` forces each call site
 * to state them.
 *
 * ## The values themselves
 *
 * These are the three defaults the old positional signature declared —
 * `skillsInvoked = []`, `legPath = "first-pass-only"`,
 * `checkWriterCheckKind = "browser"` — plus `undefined` for the eight fields
 * that carried no default. (Fourteen fields in all: `Omit` drops three, leaving
 * eleven here, of which three carry a default and eight do not.)
 *
 * So a test that spreads these and states the three required fields behaves
 * exactly as the same test did when it passed seven positional arguments. That
 * equivalence is the point; do not "tidy" a value here without checking what it
 * changes across all 48 sites.
 *
 * ## Why `Object.freeze` and not the type alone
 *
 * One object is shared by 48 call sites, so a single test that mutated it
 * would silently change the inputs of the 47 others — and, because vitest
 * files run in an unpredictable order, it would change a DIFFERENT 47 on every
 * run. That is the hardest class of flake to trace back to its cause.
 *
 * The `readonly` modifiers on `ShipAfterMigrationsInput` already refuse that
 * write, but only while someone is running `pnpm sandcastle:typecheck` — and
 * this repo's `CLAUDE.md` records that `lefthook.yml` runs `lint` on
 * pre-commit and NOT `typecheck`, so a type error reaches `main` unless a
 * person remembers to run it. `Object.freeze` closes the same door at runtime,
 * where the tests actually execute: the mutation throws in a module the whole
 * suite treats as ES-module strict code, naming the guilty line, instead of
 * quietly succeeding.
 *
 * It does not widen or narrow the exported type. The annotation below flows
 * INTO the `Object.freeze` call as a contextual type, so `legPath` still
 * infers as `PromptLegPath` rather than widening to `string`, and
 * `SHIP_INPUT_DEFAULTS` still reads to every call site as exactly
 * `Omit<ShipAfterMigrationsInput, "preSha" | "postSha" | "finalMarker">`.
 * Keep the annotation if you touch this line — dropping it is what would
 * widen the literals.
 */

import type { ShipAfterMigrationsInput } from "../main.mts";

export const SHIP_INPUT_DEFAULTS: Omit<
  ShipAfterMigrationsInput,
  "preSha" | "postSha" | "finalMarker"
> = Object.freeze({
  reviewNotes: {},
  skillsInvoked: [],
  legPath: "first-pass-only",
  checkWriterMarker: undefined,
  checkWriterCheckCommand: undefined,
  checkWriterScreen: undefined,
  checkWriterCheckKind: "browser",
  builderAccount: undefined,
  checkLocation: undefined,
  checkWriterCheckPackage: undefined,
  implementerCertification: undefined,
  checkTestCount: undefined,
});
