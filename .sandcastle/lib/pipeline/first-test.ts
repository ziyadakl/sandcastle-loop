/**
 * The first test a ticket's review rounds and ship gate use (spec #1334): the
 * check stage's accepted test, or — once a rewrite has PROVED itself — the
 * rewritten one. One value type, so every reader takes the same seven fields
 * from the same place.
 */
import { posix } from "node:path";

import type { CheckKind } from "../checkwriter/check-kind.js";
import type { CheckLocation } from "../checkwriter/must-fail-first-receipt.js";

/**
 * The identity of a first test that was REWRITTEN after a reviewer's
 * `GROUNDS: WRONG-CHECK` and proved (spec #1334). Every ship call on a
 * `proved` outcome must use these, never the pre-rewrite
 * `checkStage.*` values the caller already holds: the rewrite is a fresh
 * check-writer dispatch, free to name a different file, and its command is
 * minted fresh.
 */
export interface RewrittenFirstTest {
  readonly checkLocation: CheckLocation;
  readonly checkCommand: string | undefined;
  readonly checkKind: CheckKind | undefined;
  readonly screen: string | undefined;
  readonly checkPackage: string | undefined;
}

/** The first test every review round and the ship gate use. */
export interface FirstTest {
  readonly checkPath: string | undefined;
  readonly checkCommand: string | undefined;
  readonly screen: string | undefined;
  readonly checkKind: CheckKind | undefined;
  readonly checkLocation: CheckLocation | undefined;
  readonly checkPackage: string | undefined;
  readonly checkTestCount: number | undefined;
}

/**
 * The first test in force: the check stage's `accepted` one, or `rewritten`
 * once a rewrite has proved itself.
 */
export function currentFirstTest(
  accepted: { readonly [K in keyof FirstTest]?: FirstTest[K] },
  rewritten: RewrittenFirstTest | undefined,
): FirstTest {
  if (rewritten === undefined) {
    return {
      checkPath: accepted.checkPath,
      checkCommand: accepted.checkCommand,
      screen: accepted.screen,
      checkKind: accepted.checkKind,
      checkLocation: accepted.checkLocation,
      checkPackage: accepted.checkPackage,
      checkTestCount: accepted.checkTestCount,
    };
  }
  return {
    checkPath: posix.join(rewritten.checkLocation.checkDir, rewritten.checkLocation.checkPath),
    checkCommand: rewritten.checkCommand,
    screen: rewritten.screen,
    checkKind: rewritten.checkKind,
    checkLocation: rewritten.checkLocation,
    checkPackage: rewritten.checkPackage,
    // Issue #1227: DELIBERATELY `undefined`. A rewritten file the proof's
    // tally never counted; `effectiveCheckTestCount` sizes the window from
    // a fresh static read of the file shipping.
    checkTestCount: undefined,
  };
}
