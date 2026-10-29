/**
 * Issue #1118 — which builder diffs make the pre-builder replay LIE.
 *
 * The claim this replaces was in four places and was backwards: "the database
 * is not put back, which skews toward a false red, never a false green, so the
 * guard still holds". RED is the answer the pre-builder proof WANTS, so a red
 * the check did not earn certifies the rewrite whatever it says.
 */
import { describe, expect, it } from "vitest";

import { replayHazardIn } from "./replay-hazard.js";

describe("a diff the replay can put back", () => {
  it("passes an ordinary application change", () => {
    expect(
      replayHazardIn([
        "apps/nextjs/src/app/finance/reports/page.tsx",
        "packages/api/src/router/deal.ts",
      ]),
    ).toBeUndefined();
  });

  it("passes an empty diff", () => {
    expect(replayHazardIn([])).toBeUndefined();
  });

  it("does not confuse a directory merely NAMED like one of the hazards", () => {
    // Proves the instrument is not simply matching everything: the word
    // "migration" in a component name is not a migration.
    expect(
      replayHazardIn(["apps/nextjs/src/components/migration-banner.tsx"]),
    ).toBeUndefined();
  });
});

describe("a diff the replay cannot put back", () => {
  it("REFUSES a migration — the mutant path buys the free red too", () => {
    // This was a refusal, then was removed for a day on the ground that the
    // mutant gate "runs entirely on the FINISHED tree, where the schema and the
    // code agree". Only the CONTROL run does. Every mutant is the finished tree
    // with one source file reverted, run against a database the host already
    // migrated — so reverted code meets a moved column, the page throws at
    // request time, the runner reports a real failure with matching counters,
    // and `readMutantGate` counts it as CAUGHT. `graded` screens out
    // runner-level breakage only; an app-level failure looks exactly like the
    // check noticing. On a migration ticket both surviving guards are then
    // satisfied for free.
    const why = replayHazardIn([
      "packages/db/migrations/0099_add_team_total.sql",
    ]);
    expect(why).toBeDefined();
    expect(why).toContain("0099_add_team_total.sql");
    expect(why).toContain("un-apply a migration");
    expect(replayHazardIn(["backfill.sql"])).toBeDefined();
  });

  it("refuses a dependency manifest, because node_modules stays warm", () => {
    // The replay leaves ignored files alone on purpose — that is what makes it
    // affordable against a one-hour ceiling. But a builder that added or
    // removed a package has already reshaped what is installed, so the
    // pre-builder manifest the replay restores no longer describes it.
    const why = replayHazardIn(["packages/api/package.json"]);
    expect(why).toBeDefined();
    expect(why).toContain("packages/api/package.json");
  });

  it("refuses a lockfile change", () => {
    expect(replayHazardIn(["pnpm-lock.yaml"])).toBeDefined();
  });

  it("names the offending paths, not just the category", () => {
    // The owner reading the stop has to see WHICH file made the run decline,
    // or the refusal is indistinguishable from the feature being switched off.
    const why = replayHazardIn([
      "apps/nextjs/src/app/page.tsx",
      "packages/api/package.json",
    ]);
    expect(why).toContain("packages/api/package.json");
    expect(why).not.toContain("page.tsx");
  });
});
