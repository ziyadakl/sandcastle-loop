/**
 * Tests for `CostLedger` — accumulates per-model token usage keyed by the 8
 * loop roles and produces a run summary: per-role cost + tokens, a grand
 * total, and the list of unpriced models seen (so an unpriced role/model is
 * never silently counted as $0).
 */
import { describe, it, expect } from "vitest";
import { CostLedger } from "../.sandcastle/lib/cost/ledger.js";

const opusEntry = {
  model: "claude-opus-4-8",
  usage: {
    inputTokens: 1000,
    outputTokens: 1000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
}; // cost = (1000*5 + 1000*25)/1e6 = 0.03

const sonnetEntry = {
  model: "claude-sonnet-5",
  usage: {
    inputTokens: 1000,
    outputTokens: 1000,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  },
}; // cost = (1000*3 + 1000*15)/1e6 = 0.018

describe("CostLedger", () => {
  it("aggregates two roles on different models into a correct total", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [sonnetEntry]);
    ledger.add("reviewer", [opusEntry]);
    const s = ledger.summary();

    expect(s.perRole.implementer?.costUsd).toBeCloseTo(0.018, 10);
    expect(s.perRole.reviewer?.costUsd).toBeCloseTo(0.03, 10);
    expect(s.totalCostUsd).toBeCloseTo(0.048, 10);
    expect(s.unpricedModels).toEqual([]);
    // token buckets are preserved per role
    expect(s.perRole.implementer?.tokens).toEqual({
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it("accumulates multiple add() calls for the same role", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [opusEntry]);
    ledger.add("implementer", [opusEntry]);
    const s = ledger.summary();
    expect(s.perRole.implementer?.costUsd).toBeCloseTo(0.06, 10);
    expect(s.perRole.implementer?.tokens.outputTokens).toBe(2000);
    expect(s.totalCostUsd).toBeCloseTo(0.06, 10);
  });

  it("surfaces an unpriced model without crashing the total", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [opusEntry]);
    ledger.add("planner", [
      {
        model: "kimi-for-coding",
        usage: {
          inputTokens: 5000,
          outputTokens: 5000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]);
    const s = ledger.summary();

    // Priced role unaffected; total counts only the priced role.
    expect(s.perRole.implementer?.costUsd).toBeCloseTo(0.03, 10);
    expect(s.totalCostUsd).toBeCloseTo(0.03, 10);
    // Unpriced role: cost null, but tokens still preserved.
    expect(s.perRole.planner?.costUsd).toBeNull();
    expect(s.perRole.planner?.tokens.inputTokens).toBe(5000);
    // The unpriced model is surfaced (deduped).
    expect(s.unpricedModels).toEqual(["kimi-for-coding"]);
  });

  it("a role mixing priced + unpriced models sums the priced part and lists the unpriced", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", [
      opusEntry,
      {
        model: "glm-4.6",
        usage: {
          inputTokens: 100,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]);
    const s = ledger.summary();
    expect(s.perRole.implementer?.costUsd).toBeCloseTo(0.03, 10);
    expect(s.unpricedModels).toEqual(["glm-4.6"]);
    expect(s.totalCostUsd).toBeCloseTo(0.03, 10);
  });

  it("empty ledger → zero total, no roles, no unpriced models", () => {
    const s = new CostLedger().summary();
    expect(s.totalCostUsd).toBe(0);
    expect(s.unpricedModels).toEqual([]);
    expect(Object.keys(s.perRole)).toEqual([]);
  });

  it("add() with empty entries is a no-op", () => {
    const ledger = new CostLedger();
    ledger.add("implementer", []);
    const s = ledger.summary();
    expect(Object.keys(s.perRole)).toEqual([]);
    expect(s.totalCostUsd).toBe(0);
  });
});
