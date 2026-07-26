/**
 * Tests for the Phase-1 cost pricing table + cost function.
 *
 * `costForUsage(model, usage)` returns an estimated USD figure computed from
 * the baked list-rate price table, or `null` for an unpriced model (so nothing
 * is silently zeroed). The cache-heavy case is the whole point of Phase 1 —
 * cacheRead tokens dominate a real sandcastle session, so a correct estimate
 * must weight them at the 0.10× rate, not the input rate.
 */
import { describe, it, expect } from "vitest";
import { costForUsage } from "../.sandcastle/lib/cost/pricing.js";

describe("costForUsage", () => {
  it("prices a plain opus usage with no cache", () => {
    // opus rates: input 5, output 25 per 1e6.
    // 1000 input + 1000 output = (1000*5 + 1000*25)/1e6 = 0.03
    const cost = costForUsage("claude-opus-4-8", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.03, 10);
  });

  it("prices the real cache-heavy shape where cacheRead dominates", () => {
    // Real verified shape from the task:
    //   input 2, cacheCreation 16295, cacheRead 24050, output 2388
    // opus rates: in 5, out 25, write 6.25, read 0.50 (per 1e6)
    //   2*5        =        10
    //   2388*25    =     59700
    //   16295*6.25 =    101843.75
    //   24050*0.50 =     12025
    //   sum        =    173578.75  → /1e6 = 0.17357875
    const cost = costForUsage("claude-opus-4-8", {
      inputTokens: 2,
      outputTokens: 2388,
      cacheCreationInputTokens: 16295,
      cacheReadInputTokens: 24050,
    });
    expect(cost).toBeCloseTo(0.17357875, 10);
  });

  it("prices sonnet correctly (implementer under --budget)", () => {
    // sonnet rates: in 3, out 15, write 3.75, read 0.30
    //   1000*3 + 1000*15 + 1000*3.75 + 1000*0.30 = 22050 → /1e6 = 0.02205
    const cost = costForUsage("claude-sonnet-5", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 1000,
    });
    expect(cost).toBeCloseTo(0.02205, 10);
  });

  it("prices haiku correctly", () => {
    // haiku rates: in 1, out 5, write 1.25, read 0.10
    //   1000*1 + 1000*5 + 1000*1.25 + 1000*0.10 = 7350 → /1e6 = 0.00735
    const cost = costForUsage("claude-haiku-4-5", {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 1000,
    });
    expect(cost).toBeCloseTo(0.00735, 10);
  });

  it("prices the [1m] variant identically to its base model (premium NOT modeled)", () => {
    const usage = {
      inputTokens: 2,
      outputTokens: 2388,
      cacheCreationInputTokens: 16295,
      cacheReadInputTokens: 24050,
    };
    expect(costForUsage("claude-opus-4-8[1m]", usage)).toBe(
      costForUsage("claude-opus-4-8", usage),
    );
  });

  it("prices claude-opus-5 and claude-sonnet-4-6 (table membership)", () => {
    expect(
      costForUsage("claude-opus-5", {
        inputTokens: 1000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBeCloseTo(0.005, 10);
    expect(
      costForUsage("claude-sonnet-4-6", {
        inputTokens: 1000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBeCloseTo(0.003, 10);
  });

  it("returns null for unpriced / unknown models (never guesses)", () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    expect(costForUsage("gpt-5.5", usage)).toBeNull();
    expect(costForUsage("kimi-for-coding", usage)).toBeNull();
    expect(costForUsage("glm-4.6", usage)).toBeNull();
    expect(costForUsage("some-model-that-does-not-exist", usage)).toBeNull();
  });
});
