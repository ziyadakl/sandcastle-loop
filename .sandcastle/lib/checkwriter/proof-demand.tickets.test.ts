/**
 * THE FOUR TICKETS THAT DIED, driven end to end through the router (issue #956).
 *
 * `proof-demand.test.ts` tests the three router functions one at a time. This
 * file tests the DECISION they add up to — for each real ticket, what the
 * ship-time gate actually concludes given the marker the check-writer offered
 * and the diff the builder actually produced. It is the artifact to read when
 * asking "would tonight's run have gone differently", and it is deliberately
 * written as a table rather than as prose so a regression names the ticket.
 *
 * Every file list here is real. #848, #845 and #820 are taken from the issue
 * bodies; #836's is the single file of commit `1f79ca2e`, which shipped on
 * `no-screen-applies` with no red-first proof at all; the cash-flow and chart
 * lists are commits `a892c978` and `ea448668`, the two bugs
 * `docs/specs/2026-08-04-screen-check-design-lock.md` cites as the reason the
 * whole screen-check design exists.
 */

import { describe, expect, it } from "vitest";

import type { CheckWriterMarker } from "./schema.js";
import {
  proofDemandSatisfied,
  proofOfferedByMarker,
  requiredProofForDiff,
} from "./proof-demand.js";

/** What the ship-time gate concludes for one (marker, diff) pair. */
function shipTimeVerdict(
  marker: CheckWriterMarker,
  changedFiles: readonly string[],
): { demanded: string; offered: string; ships: boolean } {
  const { demand } = requiredProofForDiff(changedFiles);
  const offered = proofOfferedByMarker(marker);
  return {
    demanded: demand,
    offered: offered ?? "none-offered",
    ships: offered !== undefined && proofDemandSatisfied(offered, demand),
  };
}

const TICKETS = {
  /** Email template registry. Pure backend — nothing renders an email queue. */
  "#848 email template registry": [
    "packages/api/src/services/email/queue.ts",
    "packages/api/src/services/email/render-template.ts",
    "packages/db/src/schema.ts",
  ],
  /** Backup watchdog. A cron script and its test. */
  "#845 backup watchdog": [
    "packages/api/scripts/storage-backup-watchdog-cron.ts",
    "packages/api/scripts/__tests__/storage-backup-watchdog-cron.test.ts",
  ],
  /** "Four team-isolation tests pass even with the guard deleted." */
  "#820 tests that cannot fail": [
    "packages/api/src/router/__tests__/find-pending-client-invitations.test.ts",
    "packages/api/src/services/widgets/__tests__/staging-rls.integration.test.ts",
  ],
  /** The real landed diff that shipped proven by nothing. */
  "#836 activity-feed tenant floor": [
    "packages/api/src/router/__tests__/widget-tenant-isolation-call-sites.test.ts",
  ],
  /** Commit a892c978 — motivating bug 1, a wrong figure computed in a service. */
  "cash-flow fix (a892c978)": [
    "packages/api/src/services/cashflow/cash-flow-team-service.ts",
    "packages/api/src/services/cashflow/__tests__/cash-flow-team-scope.test.ts",
  ],
  /** Commit ea448668 — motivating bug 2, a correct answer drawn wrong. */
  "chart fix (ea448668)": [
    "apps/nextjs/src/app/(tracker)/tracker/_components/widgets/config-driven-chart.tsx",
    "apps/nextjs/src/app/(tracker)/tracker/_components/widgets/widget-editor.tsx",
  ],
  /** An ordinary screen ticket. */
  "screen ticket (d9466c8b)": [
    "apps/nextjs/src/app/(finance)/finance/_components/transactions-content.tsx",
    "packages/ui/src/date-period-picker.tsx",
  ],
  /** Repairing the browser instrument itself. */
  "#927 repair a Playwright spec": ["apps/nextjs/e2e/os-shell-top-bar.spec.ts"],
} as const;

describe("the backend tickets now have a route, and it is not a free pass", () => {
  for (const name of [
    "#848 email template registry",
    "#845 backup watchdog",
    "#820 tests that cannot fail",
    "#836 activity-feed tenant floor",
    "cash-flow fix (a892c978)",
  ] as const) {
    // NOTE ON WHAT THIS PROVES, precisely: the router routes these to a unit
    // proof and accepts one. Whether a red-first unit check can actually be
    // WRITTEN is per-ticket and not this module's job. #848 and #845 are
    // straightforwardly writable. #820 is not: its four tests pass because the
    // guard genuinely works — only the evidence is bad — so a new check of the
    // same behaviour would pass pre-build and be refused. That is the correct
    // outcome and the whole improvement: #820 stops for a human instead of
    // shipping on the cheap carve-out having proven nothing.
    it(`${name}: routes to a UNIT proof, and a unit proof satisfies it`, () => {
      expect(shipTimeVerdict("UNIT_CHECK_WRITTEN", TICKETS[name])).toEqual({
        demanded: "unit",
        offered: "unit",
        ships: true,
      });
    });

    it(`${name}: is REFUSED a bare "no screen applies"`, () => {
      // The half that matters as much as the first: these tickets get a route,
      // they do not get a waiver. Today #820 and #836 take exactly this route
      // and ship having proven nothing.
      expect(shipTimeVerdict("NO_SCREEN_APPLIES", TICKETS[name]).ships).toBe(
        false,
      );
    });

    it(`${name}: may still over-prove with a browser check`, () => {
      expect(shipTimeVerdict("CHECKS_WRITTEN", TICKETS[name]).ships).toBe(true);
    });
  }
});

describe("a screen is still photographed, and nothing else will do", () => {
  for (const name of [
    "chart fix (ea448668)",
    "screen ticket (d9466c8b)",
  ] as const) {
    it(`${name}: demands the browser`, () => {
      expect(shipTimeVerdict("CHECKS_WRITTEN", TICKETS[name])).toEqual({
        demanded: "browser",
        offered: "browser",
        ships: true,
      });
    });

    it(`${name}: a unit check does NOT satisfy it — the dodge this closes`, () => {
      expect(shipTimeVerdict("UNIT_CHECK_WRITTEN", TICKETS[name]).ships).toBe(
        false,
      );
    });

    it(`${name}: nor does "no screen applies"`, () => {
      expect(shipTimeVerdict("NO_SCREEN_APPLIES", TICKETS[name]).ships).toBe(
        false,
      );
    });
  }
});

describe("you cannot be asked to prove the prover", () => {
  it("#927 repairing a Playwright spec still needs no proof", () => {
    expect(
      shipTimeVerdict("NO_SCREEN_APPLIES", TICKETS["#927 repair a Playwright spec"]),
    ).toEqual({ demanded: "none", offered: "none", ships: true });
  });
});

describe("the two markers that never reach a diff", () => {
  for (const marker of ["ALREADY_BUILT", "NEEDS_WORLD_DATA"] as const) {
    it(`${marker} offers nothing, so it can never satisfy a demand`, () => {
      // These stop the ticket before ship. Answering "none" instead of
      // "nothing offered" would quietly let one of them satisfy a `none`
      // demand if a future caller reached the gate by mistake.
      const v = shipTimeVerdict(marker, TICKETS["#848 email template registry"]);
      expect(v.offered).toBe("none-offered");
      expect(v.ships).toBe(false);
    });
  }
});
