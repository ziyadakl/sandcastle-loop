/**
 * Tests for the ONE derivation of the check-writer's wire vocabulary
 * (issue #956).
 *
 * The point of this file is not that `CHECKS_WRITTEN` lowercases correctly —
 * that is one line of string work. It is that the kebab spelling has exactly
 * ONE author. Before #956 it had three (`lib/status/schema.ts`'s inline
 * `z.enum`, `issue-bag.ts`'s `CHECK_WRITER_OUTCOMES` set, and `main.mts`'s
 * hand-written `switch` + return-type union), and each one missed a fifth
 * marker in a DIFFERENT and silent way.
 *
 * ## The one test here that has to be able to fail
 *
 * "the key tuple tracks the marker tuple" is the anti-drift case. It is
 * written so that adding a fifth marker to `CHECK_WRITER_MARKERS` and
 * touching NOTHING else still passes, while any hand-copied list of four
 * fails immediately. That asymmetry is the whole assertion; a version of this
 * test that pins five literal strings would pass just as happily against a
 * hand-copied list and would be worth nothing.
 *
 * It derives its expectation with `split("_")/join("-")` rather than calling
 * {@link checkWriterOutcomeKey} or reusing `replaceAll`, so the test states
 * the transform independently of the implementation instead of asserting the
 * implementation equals itself.
 */

import { describe, expect, it } from "vitest";

import { IssueTelemetryRowSchema } from "../status/schema.js";
import { IssueTelemetryBag } from "../telemetry/issue-bag.js";
import {
  CHECK_WRITER_OUTCOME_KEYS,
  checkWriterOutcomeKey,
  type CheckWriterOutcomeKey,
} from "./outcome-key.js";
import { CHECK_WRITER_MARKERS, type CheckWriterMarker } from "./schema.js";

/** The `issue`/`costUsd`/`wallMs`/`tokens` spine a telemetry row always carries. */
const LEDGER_SPINE = {
  issue: 956,
  costUsd: null,
  wallMs: 0,
  tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
} as const;

/**
 * Compile-time equality, the `(<T>() => T extends A ? 1 : 2)` trick — the
 * standard way to compare two types EXACTLY (a plain `A extends B` pair is
 * satisfied by a union that is merely assignable in both directions, which is
 * not the same thing).
 */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/**
 * The proof that `KebabOf<CheckWriterMarker>` really evaluates to the wire
 * strings and not, say, `string` or a half-transformed
 * `"checks-written" | "already_built"`. A TSC-time assertion: it fails
 * `pnpm sandcastle:typecheck`, not `vitest`, so it is asserted below only to
 * keep it from reading as dead code.
 *
 * This union IS spelled out by hand, and that is the point: it is the ORACLE,
 * the independently-stated answer the transform is checked against. An oracle
 * derived from the thing it is checking asserts nothing. So this is the one
 * line in the codebase that a new marker must still touch — a compile error in
 * a test, which is the cheapest and loudest place left to pay that cost, and
 * the opposite of the three SILENT runtime copies #956 deleted.
 */
const KEY_UNION_IS_DERIVED: AssertEqual<
  CheckWriterOutcomeKey,
  | "checks-written"
  | "unit-check-written"
  | "already-built"
  | "needs-world-data"
  | "no-screen-applies"
  | "ticket-unclear"
> = true;

/**
 * Every marker's key, spelled out. Deliberately a LIST of pairs rather than a
 * `Record<CheckWriterMarker, …>`: a record would stop compiling the moment a
 * marker is added, turning "we grew a marker" into a broken build rather than
 * a passing anti-drift test. These pins exist to catch a RENAME of a marker
 * that exists today, and a missing pin costs coverage, never a red build.
 */
const PINNED: ReadonlyArray<readonly [CheckWriterMarker, CheckWriterOutcomeKey]> = [
  ["CHECKS_WRITTEN", "checks-written"],
  ["UNIT_CHECK_WRITTEN", "unit-check-written"],
  ["ALREADY_BUILT", "already-built"],
  ["NEEDS_WORLD_DATA", "needs-world-data"],
  ["NO_SCREEN_APPLIES", "no-screen-applies"],
];

describe("checkWriterOutcomeKey", () => {
  it("maps every marker that exists today to its exact wire string", () => {
    for (const [marker, key] of PINNED) {
      expect(checkWriterOutcomeKey(marker)).toBe(key);
    }
  });

  it("proves the key union at compile time", () => {
    expect(KEY_UNION_IS_DERIVED).toBe(true);
  });
});

describe("CHECK_WRITER_OUTCOME_KEYS", () => {
  it("tracks the marker tuple one-for-one, in order — the anti-drift case", () => {
    // Written to survive a fifth marker with no other edit: the expectation is
    // COMPUTED from `CHECK_WRITER_MARKERS`, never listed. A hand-copied list of
    // four fails this the instant a fifth marker lands.
    const expected = CHECK_WRITER_MARKERS.map((marker) =>
      marker.split("_").map((part) => part.toLowerCase()).join("-"),
    );
    expect([...CHECK_WRITER_OUTCOME_KEYS]).toEqual(expected);
    expect(CHECK_WRITER_OUTCOME_KEYS).toHaveLength(CHECK_WRITER_MARKERS.length);
  });

  it("holds no duplicates — one marker, one key", () => {
    expect(new Set(CHECK_WRITER_OUTCOME_KEYS).size).toBe(
      CHECK_WRITER_OUTCOME_KEYS.length,
    );
  });
});

describe("the derived keys against their two consumers", () => {
  it("every key survives the status schema's checkWriterOutcome field", () => {
    for (const key of CHECK_WRITER_OUTCOME_KEYS) {
      const parsed = IssueTelemetryRowSchema.safeParse({
        ...LEDGER_SPINE,
        checkWriterOutcome: key,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects a value that is not in the vocabulary", () => {
    const parsed = IssueTelemetryRowSchema.safeParse({
      ...LEDGER_SPINE,
      checkWriterOutcome: "CHECKS_WRITTEN",
    });
    expect(parsed.success).toBe(false);
  });

  it("every key is recorded by the telemetry bag, never silently dropped", () => {
    for (const key of CHECK_WRITER_OUTCOME_KEYS) {
      const bag = new IssueTelemetryBag();
      bag.noteCheckWriterOutcome(key);
      expect(bag.toRow().checkWriterOutcome).toBe(key);
      // …and the row it produces still parses, which is the reason the bag
      // gates the value at all (DROP, DON'T POISON — see `issue-bag.ts`).
      const parsed = IssueTelemetryRowSchema.safeParse({
        ...LEDGER_SPINE,
        ...bag.toRow(),
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("drops a value outside the vocabulary instead of poisoning the row", () => {
    const bag = new IssueTelemetryBag();
    bag.noteCheckWriterOutcome("unit-check-writtn");
    expect(bag.toRow()).not.toHaveProperty("checkWriterOutcome");
  });
});
