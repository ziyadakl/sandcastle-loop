import { describe, expect, it } from "vitest";

import { costForUsage, isPricedModel, type Usage } from "./pricing.js";
import {
  HAIKU_DATED_COST_AFTER_FIX,
  HAIKU_DATED_MODEL,
  HAIKU_DATED_USAGE,
  NEVER_PRICED_MODEL,
} from "./__fixtures__/expected.js";

// ---------------------------------------------------------------------------
// `pricing.ts` keyed only on UNDATED model ids, but real session JSONL reports
// the DATED id (`claude-haiku-4-5-20251001`). A corpus scan of ~400 sessions
// attributed ~14,296 lines to that one id, which is why the loop's "critique"
// role had been reporting no cost at all. These tests pin the normalization:
//
//   1. exact table hit wins (every already-priced id stays byte-identical),
//   2. else strip ONE trailing `-YYYYMMDD` (anchored — `claude-opus-4-8` must
//      NOT be mangled into `claude-opus`),
//   3. else unpriced.
//
// And, above all, that `costForUsage` and `isPricedModel` can never disagree:
// if only one of them normalized, `unpricedModels` would start lying, which
// reads to an operator like a ledger bug rather than a telemetry bug.
// ---------------------------------------------------------------------------

/** One token in each bucket per 1e6 — so cost === the row's summed rates. */
const ONE_MILLION_EACH: Usage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheCreationInputTokens: 1_000_000,
  cacheReadInputTokens: 1_000_000,
};

describe("costForUsage — dated model ids", () => {
  it("prices the dated haiku id identically to its undated base", () => {
    expect(costForUsage(HAIKU_DATED_MODEL, HAIKU_DATED_USAGE)).toBeCloseTo(
      costForUsage("claude-haiku-4-5", HAIKU_DATED_USAGE)!,
      10,
    );
  });

  it("matches HAIKU_DATED_COST_AFTER_FIX, the shared fixture constant", () => {
    expect(costForUsage(HAIKU_DATED_MODEL, HAIKU_DATED_USAGE)).toBeCloseTo(
      HAIKU_DATED_COST_AFTER_FIX,
      10,
    );
  });

  it("strips a date from any priced base, not just haiku", () => {
    expect(costForUsage("claude-sonnet-5-20250929", ONE_MILLION_EACH)).toBeCloseTo(
      22.05,
      10,
    );
  });

  it("does not price a date stripped off an UNPRICED base", () => {
    expect(costForUsage(`${NEVER_PRICED_MODEL}-20251001`, ONE_MILLION_EACH)).toBeNull();
  });

  // ANCHORING GUARD. `4-8` is a version, not a date. A greedy or unanchored
  // `-\d{8}` (or a `\d{8}` search anywhere in the string) would either mangle
  // this id or strip a date from the middle of one.
  it("keeps claude-opus-4-8 priced — `4-8` is a version, not a date", () => {
    expect(isPricedModel("claude-opus-4-8")).toBe(true);
    expect(costForUsage("claude-opus-4-8", ONE_MILLION_EACH)).toBeCloseTo(36.75, 10);
  });

  it("only strips a date at the END of the id", () => {
    expect(costForUsage("claude-20251001-haiku-4-5", ONE_MILLION_EACH)).toBeNull();
  });

  it("does not strip a run of digits that is not 8 long", () => {
    expect(costForUsage("claude-haiku-4-5-2025100", ONE_MILLION_EACH)).toBeNull();
    expect(costForUsage("claude-haiku-4-5-202510012", ONE_MILLION_EACH)).toBeNull();
  });

  it("strips at most ONE date suffix", () => {
    expect(
      costForUsage("claude-haiku-4-5-20251001-20251001", ONE_MILLION_EACH),
    ).toBeNull();
  });
});

describe("regression sweep — every id already priced keeps its exact value", () => {
  // Hard-coded on purpose: iterating the table would assert whatever the table
  // says and pin nothing. These pairs ARE the byte-identical contract.
  const BASELINE: readonly (readonly [string, number])[] = [
    // 4 + 20 + 5 + 0.20 — the one row off the 0.10×input cache-read rule.
    ["claude-opus-5-5", 29.2],
    ["claude-opus-4-8", 36.75],
    ["claude-opus-4-8[1m]", 36.75],
    ["claude-opus-5", 36.75],
    ["claude-sonnet-5", 22.05],
    ["claude-sonnet-4-6", 22.05],
    ["claude-haiku-4-5", 7.35],
  ];

  for (const [model, expected] of BASELINE) {
    it(`${model} → $${expected} per 1e6 tokens in each bucket`, () => {
      expect(isPricedModel(model)).toBe(true);
      expect(costForUsage(model, ONE_MILLION_EACH)).toBeCloseTo(expected, 10);
    });
  }
});

describe("<synthetic> — a non-model that must not be reported as unpriced", () => {
  // `<synthetic>` is emitted by Claude Code for locally-generated assistant
  // messages (10 occurrences in the corpus scan). It is not a model and bills
  // nothing, so listing it under `unpricedModels` would be crying wolf at an
  // operator. It is priced at an all-zero rate, which is the ONLY lever this
  // module has to express "drop it": the ledger keys `unpriced` off
  // `costForUsage(...) === null`.
  it("costs exactly 0 rather than null", () => {
    expect(costForUsage("<synthetic>", ONE_MILLION_EACH)).toBe(0);
  });

  it("reads as priced, so the ledger never files it under unpricedModels", () => {
    expect(isPricedModel("<synthetic>")).toBe(true);
  });
});

describe("bare aliases — decided: NOT priced", () => {
  // `sonnet` (17 occurrences) and `opus` (3) appear in real logs as config
  // aliases with no version. Which concrete model they resolved to is not
  // knowable from the id, and the families differ 3× in price, so guessing a
  // rate would silently misprice real spend. Leaving them unpriced surfaces
  // them in `unpricedModels`, which is exactly the signal that channel exists
  // for. This is a DECISION, asserted so it cannot drift by accident.
  for (const alias of ["sonnet", "opus", "haiku"]) {
    it(`"${alias}" stays unpriced`, () => {
      expect(isPricedModel(alias)).toBe(false);
      expect(costForUsage(alias, ONE_MILLION_EACH)).toBeNull();
    });
  }
});

describe("agreement invariant — the two exports can never drift", () => {
  const IDS = [
    // priced, exact
    "claude-opus-5-5",
    "claude-opus-4-8",
    "claude-opus-4-8[1m]",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    // priced via date-stripping
    HAIKU_DATED_MODEL,
    "claude-sonnet-5-20250929",
    // zero-rate sentinel
    "<synthetic>",
    // unpriced
    NEVER_PRICED_MODEL,
    `${NEVER_PRICED_MODEL}-20251001`,
    "sonnet",
    "opus",
    "gpt-5.5",
    "claude-opus",
    "",
  ];

  for (const model of IDS) {
    it(`isPricedModel(${JSON.stringify(model)}) agrees with costForUsage`, () => {
      expect(isPricedModel(model)).toBe(
        costForUsage(model, ONE_MILLION_EACH) !== null,
      );
    });
  }
});

describe("never-throw contract", () => {
  // Codified at capture.ts:62-68 and timing.ts:42-43: telemetry clamps bad
  // input, it never throws into a run. An exception here can kill a $300
  // overnight loop.
  const BAD: unknown[] = [
    "",
    undefined,
    null,
    123,
    {},
    [],
    // Inherited Object.prototype keys: a plain-object rate table would return
    // a FUNCTION for these, and `tokens * fn` is NaN — which would poison
    // totalCostUsd for the rest of the run and render as "$NaN".
    "toString",
    "constructor",
    "__proto__",
    "valueOf",
    "valueOf-20251001",
  ];

  for (const model of BAD) {
    it(`returns null (never throws) for ${JSON.stringify(model) ?? String(model)}`, () => {
      expect(() =>
        costForUsage(model as string, ONE_MILLION_EACH),
      ).not.toThrow();
      expect(costForUsage(model as string, ONE_MILLION_EACH)).toBeNull();
      expect(() => isPricedModel(model as string)).not.toThrow();
      expect(isPricedModel(model as string)).toBe(false);
    });
  }
});
