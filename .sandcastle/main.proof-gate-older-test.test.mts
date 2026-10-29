/**
 * THE SHIP GATE AND ANOTHER TICKET'S CHECK (#1271).
 *
 * Two things are pinned here, and they are the two halves of one rule:
 *
 *   1. THE HOLE THAT WAS THERE BEFORE #1271. `lockedCheckTouches` used to run
 *      BELOW `proofDemandSatisfied`'s early return, so a diff that edited an
 *      older ticket's locked red-first check and ALSO satisfied its own proof
 *      demand — the ordinary case, since a ticket that writes a unit check and
 *      edits a unit check satisfies a `unit` demand — sailed through and
 *      shipped with the edit never examined. Passing your own exam says
 *      nothing about whose answer key you rewrote on the way.
 *
 *   2. THE ONE THING THAT MAY OPEN IT. The ship gate's older-test check
 *      (`verifyOlderTestEdits`, spec #1334 SH) allows EXACTLY the older-test
 *      files it ran red-then-green and measured, and those paths travel in
 *      code as `olderTestEdits.authorizedPaths`. An authorised path passes; a second,
 *      unauthorised file sitting in the SAME directory still stops the ticket,
 *      which is the property that makes the allowlist an allowlist rather than
 *      a door held open for the folder.
 *
 * Plus one source pin: the ship-moment record has to fire at every ship, and
 * both sites are inside `shipAfterMigrations`, which no behavioural test in
 * this suite can reach for both at once.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { CheckWriterMarker } from "./lib/checkwriter/schema.js";
import { proofGateRefusal } from "./main.mts";

/** #1058's check — the real file from the 2026-09-10 #1235 refusal. */
const SIBLING_CHECK =
  "packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts";
/** A second file of the SAME older ticket, which the check did not allow. */
const SIBLING_SIBLING =
  "packages/api/src/__checks__/issue-1058/relist-fixtures.test.ts";
/** The directory THIS run's check-writer created — never the sibling's. */
const OWN_CHECK_DIR = "packages/api/src/__checks__/issue-1235";

/**
 * A gate call whose demand is SATISFIED: the diff's strongest demand is
 * `unit` (a `.test.ts` under `packages/**` renders nothing), and
 * `UNIT_CHECK_WRITTEN` offers exactly `unit`. Everything above the demand
 * comparison is clean too — `guttedFiles: []` means nothing was deleted or
 * emptied, so the removal refusals do not fire and the only question left is
 * the locked check.
 */
function gate(opts: {
  readonly changedFiles: readonly string[];
  readonly authorizedOlderTestPaths?: readonly string[];
}) {
  return proofGateRefusal({
    issueNumber: 1235,
    marker: "UNIT_CHECK_WRITTEN" satisfies CheckWriterMarker,
    changedFiles: opts.changedFiles,
    guttedFiles: [],
    ownCheckDirs: [OWN_CHECK_DIR],
    pathLabel: "",
    authorizedOlderTestPaths: opts.authorizedOlderTestPaths,
    logError: () => {},
  });
}

describe("proofGateRefusal — another ticket's locked check (#1271)", () => {
  it("refuses a sibling-check edit even when this ticket's own proof demand IS satisfied", () => {
    const refusal = gate({
      changedFiles: [
        "packages/api/src/services/deal-intake/create-listing.ts",
        `${OWN_CHECK_DIR}/names-a-live-deal.test.ts`,
        SIBLING_CHECK,
      ],
    });

    // The hole: before the hoist this returned `undefined`, because
    // `UNIT_CHECK_WRITTEN` satisfies the `unit` demand the diff raises and the
    // early return fired before the locked-check test ran.
    expect(refusal).toBeDefined();
    // Never waived — not by watch-only mode, not by a fall-through build.
    expect(refusal?.neverWaived).toBe(true);
    // And it names the file, not the diff: the evidence a person acts on.
    expect(refusal?.touchedPaths).toEqual([SIBLING_CHECK]);
    expect(refusal?.message).toContain(SIBLING_CHECK);
    // This ticket's OWN check directory is not evidence of anything — writing
    // one is the job.
    expect(refusal?.message).not.toContain("names-a-live-deal.test.ts");
  });

  it("passes when the older-test check allowed that exact path", () => {
    const refusal = gate({
      changedFiles: [
        "packages/api/src/services/deal-intake/create-listing.ts",
        SIBLING_CHECK,
      ],
      authorizedOlderTestPaths: [SIBLING_CHECK],
    });

    expect(refusal).toBeUndefined();
  });

  it("an authorisation covers the named FILE, never its directory — a second file in the same folder still stops the ticket", () => {
    const refusal = gate({
      changedFiles: [SIBLING_CHECK, SIBLING_SIBLING],
      authorizedOlderTestPaths: [SIBLING_CHECK],
    });

    expect(refusal).toBeDefined();
    expect(refusal?.neverWaived).toBe(true);
    // Only the unauthorised one is named. Listing the authorised file too
    // would send a person hunting for a problem the run had permission for.
    expect(refusal?.touchedPaths).toEqual([SIBLING_SIBLING]);
    expect(refusal?.message).toContain(SIBLING_SIBLING);
  });
});

describe("#1271 — the ship-moment record fires at every ship", () => {
  const SRC = readFileSync(path.join(import.meta.dirname, "main.mts"), "utf8");

  it("sits beside both `noteShippedWithoutFirstTest` calls and nowhere else", () => {
    // The one ship funnel has two terminals (staging and `--no-staging`); the
    // fixer ships through it too since spec #1334 SG deleted the recovery
    // road's own ship. The first-test record already covers both, so pairing
    // this one to it is the cheapest way to be sure a third terminal added
    // later is noticed: whoever adds it copies the pair or fails this pin.
    const calls =
      SRC.split("await noteShippedWithOlderTestEdit(ctx)").length - 1;
    expect(calls).toBe(2);

    for (
      let i = SRC.indexOf("await noteShippedWithOlderTestEdit(ctx)");
      i > -1;
      i = SRC.indexOf("await noteShippedWithOlderTestEdit(ctx)", i + 1)
    ) {
      const before = SRC.slice(Math.max(0, i - 200), i);
      expect(
        before.includes("noteShippedWithoutFirstTest(ctx)"),
        `a sibling-check ship record is not beside a first-test one:\n${before.slice(-200)}`,
      ).toBe(true);
    }
  });
});
