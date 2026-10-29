/**
 * CHARACTERIZATION tests for the CURRENT `CostLedger`.
 *
 * These pin today's observed behaviour EXACTLY AS IT IS. They are a regression
 * baseline, not a specification of desired behaviour: `perRole` / `perModel`
 * already ship to `status.json` and out to the web viewer, and a later wave
 * adds a SEPARATE `IssueLedger` alongside this one. If a change to that new
 * ledger makes a test in this file fail, the change perturbed shipped output —
 * that is the signal this file exists to give.
 *
 * FIXTURE CONVENTION — read before adding a case:
 *   priced   → `claude-sonnet-5`   (in the price table, stable)
 *   unpriced → `zzz-not-a-model`   (guaranteed never to be priced)
 * Deliberately NOT used here: `claude-haiku-4-5-20251001`. That id is unpriced
 * today but a later wave makes it priced, so any dollar figure or
 * `unpricedModels` entry asserted for it would break on that (correct) change.
 * `__fixtures__/expected.ts` is where the haiku-pricing expectations live.
 */

import { describe, expect, it } from "vitest";

import {
  CostLedger,
  formatCostSummary,
  totalTokens,
  type CostRole,
} from "./ledger.js";
import { costForUsage, type Usage } from "./pricing.js";
import type { ModelUsage } from "./session-usage.js";

const PRICED = "claude-sonnet-5";
const UNPRICED = "zzz-not-a-model";

function usage(
  input: number,
  output: number,
  write = 0,
  read = 0,
): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationInputTokens: write,
    cacheReadInputTokens: read,
  };
}

function entry(model: string, u: Usage): ModelUsage {
  return { model, usage: u };
}

describe("CostLedger.add", () => {
  it("is a no-op for an empty entry list — the role never appears", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", []);
    const s = ledger.summary();
    expect(s.perRole).toEqual({});
    expect(s.perModel).toEqual([]);
    expect(s.totalCostUsd).toBe(0);
    expect(s.unpricedModels).toEqual([]);
  });

  it("aggregates all four token buckets per role across repeated adds", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [entry(PRICED, usage(10, 20, 30, 40))]);
    ledger.add("implementer", [entry(PRICED, usage(1, 2, 3, 4))]);

    const role = ledger.summary().perRole.implementer;
    expect(role?.tokens).toEqual(usage(11, 22, 33, 44));
  });

  it("keeps roles independent", () => {
    const ledger = new CostLedger();
    ledger.add("planner", [entry(PRICED, usage(100, 0))]);
    ledger.add("reviewer", [entry(PRICED, usage(0, 200))]);

    const s = ledger.summary();
    expect(s.perRole.planner?.tokens.inputTokens).toBe(100);
    expect(s.perRole.planner?.tokens.outputTokens).toBe(0);
    expect(s.perRole.reviewer?.tokens.inputTokens).toBe(0);
    expect(s.perRole.reviewer?.tokens.outputTokens).toBe(200);
    expect(Object.keys(s.perRole).sort()).toEqual(["planner", "reviewer"]);
  });

  it("counts one `call` per usage entry folded in, not per add()", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [
      entry(PRICED, usage(1, 1)),
      entry(PRICED, usage(1, 1)),
    ]);
    ledger.add("implementer", [entry(PRICED, usage(1, 1))]);

    expect(ledger.summary().perModel[0]?.calls).toBe(3);
  });
});

describe("CostLedger per-model keying", () => {
  // ledger.ts:139 — models are keyed `${role}\0${model}`, so the SAME model
  // under two roles is two rows, and two models under one role are two rows.
  it("splits the same model across two roles into two rows", () => {
    const ledger = new CostLedger();
    ledger.add("planner", [entry(PRICED, usage(10, 0))]);
    ledger.add("reviewer", [entry(PRICED, usage(20, 0))]);

    const rows = ledger.summary().perModel;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.role, r.model, r.tokens.inputTokens])).toEqual([
      ["planner", PRICED, 10],
      ["reviewer", PRICED, 20],
    ]);
  });

  it("splits two models under one role into two rows", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [
      entry(PRICED, usage(10, 0)),
      entry(UNPRICED, usage(20, 0)),
    ]);

    const rows = ledger.summary().perModel;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.model).sort()).toEqual([PRICED, UNPRICED].sort());
  });

  it("does not collide when a role name and model name would concatenate alike", () => {
    // The NUL separator is what stops ("planner", "x") and ("plannerx", "")
    // style collisions. Exercise a near-miss pair.
    const ledger = new CostLedger();
    ledger.add("planner", [entry("a-b", usage(1, 0))]);
    ledger.add("planner", [entry("a", usage(2, 0))]);

    expect(ledger.summary().perModel).toHaveLength(2);
  });
});

describe("CostLedger pricing / null semantics", () => {
  // ledger.ts:30-34 — costUsd is null (NOT 0) when a role saw only unpriced
  // models, so "unpriced" is never read as "free".
  it("reports costUsd null for a role whose models are all unpriced", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [entry(UNPRICED, usage(1_000_000, 1_000_000))]);

    const s = ledger.summary();
    expect(s.perRole.implementer?.costUsd).toBeNull();
    expect(s.perModel[0]?.costUsd).toBeNull();
    // tokens are still counted for unpriced models
    expect(totalTokens(s.perRole.implementer!.tokens)).toBe(2_000_000);
    expect(s.totalCostUsd).toBe(0);
  });

  it("reports the PRICED-only sum (not null) for a role that saw both", () => {
    // The mixed case: acc.costUsd only stays null if NOTHING ever priced.
    const ledger = new CostLedger();
    const priced = usage(1_000_000, 0);
    ledger.add("implementer", [entry(PRICED, priced), entry(UNPRICED, usage(0, 9_999_999))]);

    const s = ledger.summary();
    const expected = costForUsage(PRICED, priced);
    expect(expected).not.toBeNull();
    expect(s.perRole.implementer?.costUsd).toBeCloseTo(expected!, 10);
    expect(s.totalCostUsd).toBeCloseTo(expected!, 10);
    // ...but the unpriced model's tokens still land in the role's token total.
    expect(s.perRole.implementer?.tokens.outputTokens).toBe(9_999_999);
  });

  it("totalCostUsd is the sum of every role's priced cost", () => {
    const ledger = new CostLedger();
    const u = usage(1_000_000, 1_000_000, 1_000_000, 1_000_000);
    ledger.add("planner", [entry(PRICED, u)]);
    ledger.add("merger", [entry(PRICED, u)]);

    const one = costForUsage(PRICED, u)!;
    expect(ledger.summary().totalCostUsd).toBeCloseTo(one * 2, 10);
  });

  it("prices each (role, model) row independently of the role total", () => {
    const ledger = new CostLedger();
    const a = usage(1_000_000, 0);
    const b = usage(0, 1_000_000);
    ledger.add("implementer", [entry(PRICED, a), entry(PRICED, b)]);

    const row = ledger.summary().perModel[0]!;
    expect(row.costUsd).toBeCloseTo(
      costForUsage(PRICED, a)! + costForUsage(PRICED, b)!,
      10,
    );
  });
});

describe("CostLedger.unpricedModels", () => {
  it("dedupes across roles and sorts", () => {
    const ledger = new CostLedger();
    ledger.add("planner", [entry("zzz-not-a-model", usage(1, 1))]);
    ledger.add("reviewer", [entry("zzz-not-a-model", usage(1, 1))]);
    ledger.add("merger", [entry("aaa-not-a-model", usage(1, 1))]);

    expect(ledger.summary().unpricedModels).toEqual([
      "aaa-not-a-model",
      "zzz-not-a-model",
    ]);
  });

  it("stays empty when every model is priced", () => {
    const ledger = new CostLedger();
    ledger.add("planner", [entry(PRICED, usage(1, 1))]);
    expect(ledger.summary().unpricedModels).toEqual([]);
  });
});

describe("CostLedger.ROLE_ORDER", () => {
  it("is the ten loop roles in pipeline order", () => {
    expect(CostLedger.ROLE_ORDER).toEqual([
      "planner",
      "checkWriter",
      "judge",
      "implementer",
      "reviewer",
      "critique",
      "recovery",
      "merger",
      "postMergeReviewer",
      "postMergeFixer",
    ]);
  });

  // ledger.ts:172-175 documents that this list is MIRRORED in
  // web/view-model.js because the browser bundle can't import TS. Assert the
  // mirror rather than trusting the comment — the same trick liveness.ts uses
  // to share web/own-process-dead.js.
  it("stays in sync with the ROLE_ORDER mirror in web/view-model.js", async () => {
    const webModule = (await import("../../web/view-model.js")) as {
      ROLE_ORDER: string[];
    };
    expect(webModule.ROLE_ORDER).toEqual([...CostLedger.ROLE_ORDER]);
  });

  it("sorts perModel by pipeline order, then by most calls within a role", () => {
    const ledger = new CostLedger();
    // Added out of pipeline order on purpose.
    ledger.add("postMergeFixer", [entry(PRICED, usage(1, 0))]);
    ledger.add("planner", [entry(PRICED, usage(1, 0))]);
    // implementer: "b" gets 1 call, "a" gets 2 — "a" must sort first.
    ledger.add("implementer", [
      entry("b-model", usage(1, 0)),
      entry("a-model", usage(1, 0)),
      entry("a-model", usage(1, 0)),
    ]);

    expect(
      ledger.summary().perModel.map((r) => `${r.role}/${r.model}`),
    ).toEqual([
      "planner/claude-sonnet-5",
      "implementer/a-model",
      "implementer/b-model",
      "postMergeFixer/claude-sonnet-5",
    ]);
  });

  it("sorts every role ahead of a role absent from ROLE_ORDER", () => {
    // indexOf returns -1 for an unknown role, so it sorts FIRST today. Pinning
    // that so a future 9th role added to only one of the two lists is noticed.
    const ledger = new CostLedger();
    ledger.add("planner", [entry(PRICED, usage(1, 0))]);
    ledger.add("ghost" as CostRole, [entry(PRICED, usage(1, 0))]);

    expect(ledger.summary().perModel.map((r) => r.role)).toEqual([
      "ghost",
      "planner",
    ]);
  });
});

describe("totalTokens", () => {
  it("sums all four buckets", () => {
    expect(totalTokens(usage(1, 20, 300, 4000))).toBe(4321);
  });

  it("is 0 for an all-zero usage", () => {
    expect(totalTokens(usage(0, 0, 0, 0))).toBe(0);
  });
});

describe("formatCostSummary", () => {
  it("renders roles in ROLE_ORDER regardless of insertion order", () => {
    const ledger = new CostLedger();
    ledger.add("merger", [entry(PRICED, usage(1000, 0))]);
    ledger.add("planner", [entry(PRICED, usage(2000, 0))]);

    const line = formatCostSummary(ledger.summary());
    expect(line.indexOf("planner")).toBeLessThan(line.indexOf("merger"));
  });

  it("omits roles with no entries and always tags the total as an estimate", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [entry(PRICED, usage(1_000_000, 0))]);

    const line = formatCostSummary(ledger.summary());
    expect(line).toBe("cost: implementer $3.00 (1000000 tok) | TOTAL $3.00 (estimate)");
    expect(line).not.toContain("reviewer");
  });

  it("renders an all-unpriced role's dollars as $n/a but still shows its tokens", () => {
    const ledger = new CostLedger();
    ledger.add("reviewer", [entry(UNPRICED, usage(10, 20, 30, 40))]);

    expect(formatCostSummary(ledger.summary())).toBe(
      "cost: reviewer $n/a (100 tok) | TOTAL $0.00 (estimate) | unpriced: zzz-not-a-model",
    );
  });

  it("renders an empty ledger as a bare total with no leading separator", () => {
    expect(formatCostSummary(new CostLedger().summary())).toBe(
      "cost: TOTAL $0.00 (estimate)",
    );
  });

  it("joins multiple roles with ' | ' and appends unpriced models comma-separated", () => {
    const ledger = new CostLedger();
    ledger.add("planner", [entry(PRICED, usage(1_000_000, 0))]);
    ledger.add("reviewer", [
      entry(PRICED, usage(1_000_000, 0)),
      entry("zzz-not-a-model", usage(5, 0)),
      entry("aaa-not-a-model", usage(5, 0)),
    ]);

    expect(formatCostSummary(ledger.summary())).toBe(
      "cost: planner $3.00 (1000000 tok) | reviewer $3.00 (1000010 tok) | " +
        "TOTAL $6.00 (estimate) | unpriced: aaa-not-a-model, zzz-not-a-model",
    );
  });

  it("rounds dollars to exactly two decimals", () => {
    const ledger = new CostLedger();
    // 1 input token at $3/1e6 = $0.000003 → renders as $0.00, not $3e-6.
    ledger.add("planner", [entry(PRICED, usage(1, 0))]);
    expect(formatCostSummary(ledger.summary())).toBe(
      "cost: planner $0.00 (1 tok) | TOTAL $0.00 (estimate)",
    );
  });
});
