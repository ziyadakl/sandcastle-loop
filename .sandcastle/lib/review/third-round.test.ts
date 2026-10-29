/**
 * Issue #1216 — lifted verbatim out of `runIssuePipeline` in `main.mts`,
 * where reviewer attempt 2 still says HAS_BLOCKERS and the loop had to
 * decide whether to grant a third implementer+reviewer pass. Behaviour
 * preserved exactly: see `third-round.ts` for the original inline code.
 */
import { describe, expect, it } from "vitest";
import { decideThirdRound } from "./third-round.js";

describe("decideThirdRound", () => {
  it("grants on round-1-cleared basis when round1Cleared is true", () => {
    expect(
      decideThirdRound({ round1Cleared: true, freshLatestFinding: false }),
    ).toEqual({ grant: true, basis: "round-1 categories resolved" });
  });

  it("grants on the #1211 basis when only freshLatestFinding is true", () => {
    expect(
      decideThirdRound({ round1Cleared: false, freshLatestFinding: true }),
    ).toEqual({
      grant: true,
      basis: "round 1 named no readable finding but round 2 did (issue #1211)",
    });
  });

  it("round1Cleared wins the basis when both are true", () => {
    expect(
      decideThirdRound({ round1Cleared: true, freshLatestFinding: true }),
    ).toEqual({ grant: true, basis: "round-1 categories resolved" });
  });

  it("denies when neither basis holds", () => {
    expect(
      decideThirdRound({ round1Cleared: false, freshLatestFinding: false }),
    ).toEqual({ grant: false });
  });
});
