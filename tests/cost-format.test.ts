/**
 * Tests for `formatCostSummary` — turns a CostLedger summary into the single
 * operator-facing log line printed at the end of a run.
 */
import { describe, it, expect } from "vitest";
import { CostLedger } from "../.sandcastle/lib/cost/ledger.js";
import { formatCostSummary } from "../.sandcastle/lib/cost/ledger.js";

describe("formatCostSummary", () => {
  it("renders per-role dollars + tokens and a total", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [
      {
        model: "claude-sonnet-5",
        usage: {
          inputTokens: 1000,
          outputTokens: 1000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]); // 0.018, 2000 tok
    ledger.add("reviewer", [
      {
        model: "claude-opus-4-8",
        usage: {
          inputTokens: 1000,
          outputTokens: 1000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]); // 0.03, 2000 tok
    const line = formatCostSummary(ledger.summary());
    expect(line).toContain("implementer $0.02 (2000 tok)");
    expect(line).toContain("reviewer $0.03 (2000 tok)");
    expect(line).toContain("TOTAL $0.05");
    expect(line).toContain("estimate");
    expect(line.startsWith("cost:")).toBe(true);
  });

  it("notes unpriced models and renders an unpriced role's cost as n/a", () => {
    const ledger = new CostLedger();
    ledger.add("planner", [
      {
        model: "kimi-for-coding",
        usage: {
          inputTokens: 5000,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]);
    const line = formatCostSummary(ledger.summary());
    expect(line).toContain("planner $n/a (5000 tok)");
    expect(line).toContain("unpriced: kimi-for-coding");
  });

  it("renders an empty ledger as a zero total", () => {
    const line = formatCostSummary(new CostLedger().summary());
    expect(line).toContain("TOTAL $0.00");
  });
});
