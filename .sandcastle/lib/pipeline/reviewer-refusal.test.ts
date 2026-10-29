/**
 * The reviewer-refusal decision (issue #1217, rewritten by spec #1334).
 *
 * The judge is gone. The host reads the reviewer's own GROUNDS line, and the
 * one thing a refusal can buy beyond an ordinary builder round is the first
 * test's single rewrite — only when the reviewer says `WRONG-CHECK`, the ticket
 * has a first test of its own, and the rewrite has not been spent.
 *
 * The rewrite itself lives in `main.mts`; this file pins the pure decision of
 * whether it runs, and with what reason.
 */
import { describe, expect, it } from "vitest";

import { wrongCheckRewriteEligibility } from "./reviewer-refusal.js";

const refusal = (grounds: string): string =>
  ["CATEGORY SWEEP:", "- Spec fit: FINDING: x", "SWEEP COMPLETE.", grounds, "", "HAS_BLOCKERS"].join(
    "\n",
  );

const WRONG = refusal("GROUNDS: WRONG-CHECK (team.spec.ts: the ticket says $2,000; the test expects $1,000)");

describe("wrongCheckRewriteEligibility — when the rewrite does NOT run", () => {
  it.each([
    ["RED-CHECK", "GROUNDS: RED-CHECK (a.spec.ts: 1 failed)"],
    ["NO-CHECK", "GROUNDS: NO-CHECK"],
    ["no grounds line at all", ""],
    ["WRONG-CHECK beside NO-CHECK", "GROUNDS: WRONG-CHECK (x)\nGROUNDS: NO-CHECK"],
  ])("%s → refused", (_name, grounds) => {
    const outcome = wrongCheckRewriteEligibility({
      reviewStdout: refusal(grounds),
      ownTest: "rewritable",
    });
    expect(outcome.kind).toBe("refused");
  });

  it("WRONG-CHECK on a ticket with no first test of its own → refused, saying so", () => {
    const outcome = wrongCheckRewriteEligibility({ reviewStdout: WRONG, ownTest: "none" });
    expect(outcome).toMatchObject({ kind: "refused", grounds: "reviewer-wrong-check" });
    expect(outcome.kind === "refused" && outcome.why).toMatch(/no first test of its own/);
  });

  it("WRONG-CHECK after the one rewrite was already spent → refused, saying so", () => {
    const outcome = wrongCheckRewriteEligibility({ reviewStdout: WRONG, ownTest: "spent" });
    expect(outcome.kind === "refused" && outcome.why).toMatch(/already/);
  });
});

describe("wrongCheckRewriteEligibility — WRONG-CHECK buys the one rewrite", () => {
  it("answers rewrite, carrying the reviewer's own reason", () => {
    expect(wrongCheckRewriteEligibility({ reviewStdout: WRONG, ownTest: "rewritable" })).toEqual({
      kind: "rewrite",
      reason: "team.spec.ts: the ticket says $2,000; the test expects $1,000",
    });
  });
});
