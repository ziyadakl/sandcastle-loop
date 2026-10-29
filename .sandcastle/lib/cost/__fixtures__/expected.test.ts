/**
 * Self-check for the shared session-JSONL fixtures.
 *
 * The three `.jsonl` files and the constants in `expected.ts` are two hand-kept
 * halves of one thing; this pins them together so a fixture edit that forgets
 * to update the numbers fails here instead of silently corrupting whichever
 * Wave-1 test imported the stale constant. It is fixture infrastructure, NOT
 * coverage of `session-usage.ts` — that module's own tests live elsewhere.
 *
 * FORWARD-COMPATIBLE BY DESIGN: the dated-haiku assertions accept BOTH the
 * current unpriced state (`costForUsage` → null) and the post-fix priced state
 * (→ HAIKU_DATED_COST_AFTER_FIX), so pricing `claude-haiku-4-5-20251001` does
 * not have to touch this file.
 */

import { describe, expect, it } from "vitest";

import { totalTokens } from "../ledger.js";
import { costForUsage, type Usage } from "../pricing.js";
import { extractUsageFromSession } from "../session-usage.js";
import {
  HAIKU_DATED_COST_AFTER_FIX,
  HAIKU_DATED_FIXTURE,
  HAIKU_DATED_MODEL,
  HAIKU_DATED_TOTAL_TOKENS,
  HAIKU_DATED_USAGE,
  MULTI_MODEL_FIXTURE,
  MULTI_MODEL_HAIKU_DATED_COST_AFTER_FIX,
  MULTI_MODEL_SONNET_COST,
  MULTI_MODEL_TOTAL_TOKENS,
  MULTI_MODEL_USAGE,
  NEVER_PRICED_MODEL,
  SONNET_COST,
  SONNET_FIXTURE,
  SONNET_TOTAL_TOKENS,
  SONNET_USAGE,
} from "./expected.js";

/** Haiku list rate (1 / 5 / 1.25 / 0.10 per 1e6) applied by hand. */
function haikuRateCost(u: Usage): number {
  return (
    (u.inputTokens * 1 +
      u.outputTokens * 5 +
      u.cacheCreationInputTokens * 1.25 +
      u.cacheReadInputTokens * 0.1) /
    1_000_000
  );
}

/**
 * `claude-haiku-4-5-20251001` is unpriced today and priced after the pricing
 * fix. Accept either, but require that whichever it is, it matches the
 * documented figure.
 */
function expectDatedHaikuCost(u: Usage, expected: number): void {
  const actual = costForUsage(HAIKU_DATED_MODEL, u);
  if (actual !== null) expect(actual).toBeCloseTo(expected, 10);
  expect(haikuRateCost(u)).toBeCloseTo(expected, 10);
}

describe("session-haiku-dated.jsonl", () => {
  it("extracts exactly one model with the documented totals", () => {
    expect(extractUsageFromSession(HAIKU_DATED_FIXTURE)).toEqual([
      { model: HAIKU_DATED_MODEL, usage: HAIKU_DATED_USAGE },
    ]);
    expect(totalTokens(HAIKU_DATED_USAGE)).toBe(HAIKU_DATED_TOTAL_TOKENS);
  });

  it("costs HAIKU_DATED_COST_AFTER_FIX at the haiku list rate", () => {
    expectDatedHaikuCost(HAIKU_DATED_USAGE, HAIKU_DATED_COST_AFTER_FIX);
  });
});

describe("session-sonnet.jsonl", () => {
  it("extracts exactly one priced model with the documented totals", () => {
    expect(extractUsageFromSession(SONNET_FIXTURE)).toEqual([
      { model: "claude-sonnet-5", usage: SONNET_USAGE },
    ]);
    expect(totalTokens(SONNET_USAGE)).toBe(SONNET_TOTAL_TOKENS);
    expect(costForUsage("claude-sonnet-5", SONNET_USAGE)).toBeCloseTo(
      SONNET_COST,
      10,
    );
  });
});

describe("session-multi-model.jsonl", () => {
  it("extracts three models in first-appearance order, skipping every noise line", () => {
    // If a noise line leaked in, the 999999-token entry would blow this up.
    expect(extractUsageFromSession(MULTI_MODEL_FIXTURE)).toEqual(
      MULTI_MODEL_USAGE,
    );
    expect(
      MULTI_MODEL_USAGE.reduce((sum, e) => sum + totalTokens(e.usage), 0),
    ).toBe(MULTI_MODEL_TOTAL_TOKENS);
  });

  it("prices the sonnet slice, leaves zzz-not-a-model unpriced", () => {
    expect(costForUsage("claude-sonnet-5", MULTI_MODEL_USAGE[0]!.usage)).toBeCloseTo(
      MULTI_MODEL_SONNET_COST,
      10,
    );
    expect(MULTI_MODEL_USAGE[2]!.model).toBe(NEVER_PRICED_MODEL);
    expect(costForUsage(NEVER_PRICED_MODEL, MULTI_MODEL_USAGE[2]!.usage)).toBeNull();
  });

  it("costs its dated-haiku slice at the documented figure", () => {
    expectDatedHaikuCost(
      MULTI_MODEL_USAGE[1]!.usage,
      MULTI_MODEL_HAIKU_DATED_COST_AFTER_FIX,
    );
  });
});
