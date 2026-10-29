import { describe, expect, it } from "vitest";

import type { ModelUsage } from "../cost/session-usage.js";
import type { SandcastleStatus } from "../status/schema.js";
import { SandcastleStatusSchema } from "../status/schema.js";
import {
  ATTRIBUTABLE_ROLES,
  cacheHitRatio,
  IssueLedger,
} from "./issue-ledger.js";

// ---------------------------------------------------------------------------
// The run-scoped cost/timing ledgers attribute spend to a ROLE, so a $297 run
// is a black box: you cannot tell whether one ticket ate $60. This ledger is
// the per-ISSUE accumulator that closes that gap. It is telemetry, so the two
// properties that dominate every other concern are:
//   1. it never throws (a telemetry exception kills a $300 overnight run), and
//   2. its rows always satisfy `SandcastleStatusSchema` (a NaN slipping into
//      `z.number()` takes the ENTIRE status snapshot parse down at 3am).
// Every garbage-input test below asserts BOTH, because "didn't throw" while
// silently emitting an unparseable row is the failure mode that actually ships.
// ---------------------------------------------------------------------------

/** Local snapshot fixture — mirrors `push.test.mts:23-41` (unowned this wave). */
function snap(over: Partial<SandcastleStatus> = {}): SandcastleStatus {
  return {
    schemaVersion: 3,
    state: "running",
    hostId: "test-host",
    runId: "run-1",
    run: {
      branch: "b",
      repo: "r",
      startedAt: "2026-07-30T00:00:00.000Z",
      iterations: { current: 1, total: 10 },
      maxConcurrent: 1,
    },
    totals: { merged: 0, needsHuman: 0, requeued: 0, running: 0 },
    issues: [],
    history: [],
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...over,
  } as SandcastleStatus;
}

/** Fixture convention: `claude-sonnet-5` is priced, `zzz-not-a-model` is not. */
const PRICED = "claude-sonnet-5";
const UNPRICED = "zzz-not-a-model";

function usage(
  model: string,
  input: number,
  output = 0,
  cacheWrite = 0,
  cacheRead = 0,
): ModelUsage {
  return {
    model,
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheCreationInputTokens: cacheWrite,
      cacheReadInputTokens: cacheRead,
    },
  };
}

/** sonnet-5 list rates: 3 / 15 / 3.75 / 0.30 per 1e6. */
function sonnetCost(
  input: number,
  output = 0,
  cacheWrite = 0,
  cacheRead = 0,
): number {
  return (
    (input * 3 + output * 15 + cacheWrite * 3.75 + cacheRead * 0.3) / 1_000_000
  );
}

function rowFor(ledger: IssueLedger, issue: number) {
  const row = ledger.rows().find((r) => r.issue === issue);
  expect(row, `expected a row for issue ${issue}`).toBeDefined();
  return row!;
}

describe("IssueLedger — per-(issue, role) accumulation", () => {
  it("keeps two issues from bleeding into each other", () => {
    const l = new IssueLedger();
    l.addCost(101, "implementer", [usage(PRICED, 1000, 500)]);
    l.addCost(202, "implementer", [usage(PRICED, 4000, 100)]);
    l.addTiming(101, "implementer", 1_000);
    l.addTiming(202, "implementer", 9_000);

    expect(rowFor(l, 101).tokens).toEqual({
      input: 1000,
      output: 500,
      cacheWrite: 0,
      cacheRead: 0,
    });
    expect(rowFor(l, 202).tokens).toEqual({
      input: 4000,
      output: 100,
      cacheWrite: 0,
      cacheRead: 0,
    });
    expect(rowFor(l, 101).wallMs).toBe(1_000);
    expect(rowFor(l, 202).wallMs).toBe(9_000);
    expect(rowFor(l, 101).costUsd).toBeCloseTo(sonnetCost(1000, 500), 10);
    expect(rowFor(l, 202).costUsd).toBeCloseTo(sonnetCost(4000, 100), 10);
  });

  it("keeps two roles under one issue separate, and sums them into the row", () => {
    const l = new IssueLedger();
    l.addCost(7, "implementer", [usage(PRICED, 1000, 200, 50, 4000)]);
    l.addCost(7, "reviewer", [usage(PRICED, 300, 40)]);
    l.addTiming(7, "implementer", 5_000);
    l.addTiming(7, "reviewer", 2_500);

    const row = rowFor(l, 7);
    expect(row.perRole?.implementer?.tokens).toEqual({
      input: 1000,
      output: 200,
      cacheWrite: 50,
      cacheRead: 4000,
    });
    expect(row.perRole?.reviewer?.tokens).toEqual({
      input: 300,
      output: 40,
      cacheWrite: 0,
      cacheRead: 0,
    });
    expect(row.perRole?.implementer?.wallMs).toBe(5_000);
    expect(row.perRole?.reviewer?.wallMs).toBe(2_500);
    expect(row.perRole?.implementer?.costUsd).toBeCloseTo(
      sonnetCost(1000, 200, 50, 4000),
      10,
    );
    expect(row.perRole?.reviewer?.costUsd).toBeCloseTo(sonnetCost(300, 40), 10);

    // Row level aggregates every role of that issue.
    expect(row.tokens).toEqual({
      input: 1300,
      output: 240,
      cacheWrite: 50,
      cacheRead: 4000,
    });
    expect(row.wallMs).toBe(7_500);
    expect(row.costUsd).toBeCloseTo(
      sonnetCost(1000, 200, 50, 4000) + sonnetCost(300, 40),
      10,
    );
  });

  it("accumulates repeated dispatches of the same (issue, role) and counts runs", () => {
    const l = new IssueLedger();
    l.addCost(7, "implementer", [usage(PRICED, 100)]);
    l.addCost(7, "implementer", [usage(PRICED, 400)]);
    l.addTiming(7, "implementer", 1_000);
    l.addTiming(7, "implementer", 2_000);

    const role = rowFor(l, 7).perRole?.implementer;
    expect(role?.tokens?.input).toBe(500);
    expect(role?.wallMs).toBe(3_000);
    expect(role?.runs).toBe(2);
  });

  it("sorts rows numerically by issue number", () => {
    const l = new IssueLedger();
    for (const n of [10, 9, 2, 100, 1]) {
      l.addCost(n, "implementer", [usage(PRICED, 10)]);
    }
    expect(l.rows().map((r) => r.issue)).toEqual([1, 2, 9, 10, 100]);
  });

  it("returns no rows when nothing was recorded", () => {
    expect(new IssueLedger().rows()).toEqual([]);
  });
});

describe("IssueLedger — costUsd null semantics (null is NOT free)", () => {
  it("reports null for an issue whose every model was unpriced", () => {
    const l = new IssueLedger();
    l.addCost(5, "implementer", [usage(UNPRICED, 1000, 500)]);
    l.addCost(5, "reviewer", [usage(UNPRICED, 200)]);

    const row = rowFor(l, 5);
    expect(row.costUsd).toBeNull();
    expect(row.perRole?.implementer?.costUsd).toBeNull();
    // Tokens are still counted for unpriced models.
    expect(row.tokens.input).toBe(1200);
  });

  it("reports the PRICED-ONLY sum for an issue that mixed priced and unpriced", () => {
    const l = new IssueLedger();
    l.addCost(6, "implementer", [
      usage(PRICED, 1000, 500),
      usage(UNPRICED, 9_000_000, 9_000_000),
    ]);
    l.addCost(6, "critique", [usage(UNPRICED, 100)]);

    const row = rowFor(l, 6);
    expect(row.costUsd).toBeCloseTo(sonnetCost(1000, 500), 10);
    expect(row.perRole?.implementer?.costUsd).toBeCloseTo(
      sonnetCost(1000, 500),
      10,
    );
    // A role that saw ONLY unpriced models stays null, never 0.
    expect(row.perRole?.critique?.costUsd).toBeNull();
    // The unpriced tokens still land in the totals.
    expect(row.tokens.input).toBe(1000 + 9_000_000 + 100);
  });
});

describe("IssueLedger — only the 6 attributable roles reach perRole", () => {
  it.each(["planner", "merger", "postMergeReviewer", "postMergeFixer"] as const)(
    "ignores the batch role %s entirely (cost AND timing)",
    (role) => {
      const l = new IssueLedger();
      l.addCost(9, role, [usage(PRICED, 1_000_000, 1_000_000)]);
      l.addTiming(9, role, 60_000);
      expect(l.rows()).toEqual([]);
    },
  );

  it("keeps an attributable role while dropping a batch role on the same issue", () => {
    const l = new IssueLedger();
    l.addCost(9, "implementer", [usage(PRICED, 100)]);
    l.addCost(9, "planner", [usage(PRICED, 1_000_000)]);
    l.addTiming(9, "planner", 60_000);

    const row = rowFor(l, 9);
    expect(Object.keys(row.perRole ?? {})).toEqual(["implementer"]);
    expect(row.tokens.input).toBe(100);
    expect(row.wallMs).toBe(0);
  });

  it("accepts all six attributable roles", () => {
    const l = new IssueLedger();
    for (const role of [
      "checkWriter",
      "judge",
      "implementer",
      "reviewer",
      "critique",
      "recovery",
    ] as const) {
      l.addCost(4, role, [usage(PRICED, 10)]);
    }
    expect(Object.keys(rowFor(l, 4).perRole ?? {}).sort()).toEqual([
      "checkWriter",
      "critique",
      "implementer",
      "judge",
      "recovery",
      "reviewer",
    ]);
  });

  // The literal above is only worth as much as its agreement with the exported
  // list — a seventh role added to `ATTRIBUTABLE_ROLES` and forgotten here
  // would leave the pin silently under-testing.
  it("pins exactly the exported ATTRIBUTABLE_ROLES, no more and no fewer", () => {
    expect([...ATTRIBUTABLE_ROLES].sort()).toEqual([
      "checkWriter",
      "critique",
      "implementer",
      "judge",
      "recovery",
      "reviewer",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ADDITIVE-SCHEMA GUARD (issue #1118). `judge` is the newest `perRole` key, and
// `status.json` files written before it existed are still read by the viewer,
// the hub and `/sandcastle-status`. An older snapshot has no `judge` key at
// all; if that stopped parsing, every pre-#1118 run would blank-screen. These
// two tests are the proof the new key is additive rather than required.
// ---------------------------------------------------------------------------
describe("perRole stays additive — a pre-judge status file still validates", () => {
  /** One issue row's worth of role telemetry, as it reaches `status.json`. */
  function statusWithPerRole(
    perRole: Record<string, { costUsd: number | null; runs?: number }>,
  ): unknown {
    return snap({
      issueTelemetry: [
        {
          issue: 42,
          costUsd: 1,
          wallMs: 10,
          tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
          perRole,
        },
      ],
    } as Partial<SandcastleStatus>);
  }

  it("parses a role-telemetry object with NO judge key", () => {
    const parsed = SandcastleStatusSchema.safeParse(
      statusWithPerRole({
        checkWriter: { costUsd: 0.5, runs: 1 },
        implementer: { costUsd: 2, runs: 1 },
        reviewer: { costUsd: 1, runs: 1 },
        critique: { costUsd: 0.25, runs: 1 },
        recovery: { costUsd: null, runs: 1 },
      }),
    );
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
    // And it still RENDERS: the absent key reads as absent, not as $0.
    const row = parsed.data?.issueTelemetry?.[0];
    expect(row?.perRole?.judge).toBeUndefined();
    expect(row?.perRole?.implementer?.costUsd).toBe(2);
  });

  it("parses the same object once a judge key is present", () => {
    const parsed = SandcastleStatusSchema.safeParse(
      statusWithPerRole({
        implementer: { costUsd: 2, runs: 1 },
        judge: { costUsd: 0.75, runs: 2 },
      }),
    );
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
    expect(parsed.data?.issueTelemetry?.[0]?.perRole?.judge?.costUsd).toBe(0.75);
  });
});

describe("cacheHitRatio", () => {
  // CRITICAL: 0/0 is NaN, `z.number()` rejects NaN, and a NaN here would take
  // the entire status snapshot parse down. It MUST be null.
  it("returns null — NOT NaN — for an all-zero token split", () => {
    const r = cacheHitRatio({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
    expect(r).toBeNull();
    expect(Number.isNaN(r as number)).toBe(false);
  });

  it("is the cache-read share of PROMPT tokens (output excluded)", () => {
    expect(
      cacheHitRatio({ input: 100, output: 999_999, cacheWrite: 100, cacheRead: 800 }),
    ).toBeCloseTo(0.8, 10);
  });

  it("returns 0 when nothing was read from cache but prompt tokens exist", () => {
    expect(
      cacheHitRatio({ input: 100, output: 0, cacheWrite: 0, cacheRead: 0 }),
    ).toBe(0);
  });

  it("returns null rather than NaN/Infinity for non-finite fields", () => {
    const bad = { input: NaN, output: 0, cacheWrite: 0, cacheRead: 10 };
    expect(cacheHitRatio(bad as never)).toBeNull();
    const inf = { input: Infinity, output: 0, cacheWrite: 0, cacheRead: 10 };
    expect(cacheHitRatio(inf as never)).toBeNull();
  });
});

describe("IssueLedger — seam tripwire against SandcastleStatusSchema", () => {
  it("produces rows a POPULATED status snapshot parses cleanly", () => {
    const l = new IssueLedger();
    l.addCost(101, "implementer", [usage(PRICED, 1000, 500, 250, 40_000)]);
    l.addCost(101, "reviewer", [usage(UNPRICED, 300)]);
    l.addCost(202, "critique", [usage(PRICED, 10, 5)]);
    l.addTiming(101, "implementer", 12_345);
    l.addTiming(202, "critique", 678);

    expect(l.rows().length).toBe(2);
    expect(
      SandcastleStatusSchema.safeParse({
        ...snap(),
        issueTelemetry: l.rows(),
      }).success,
    ).toBe(true);
  });
});

describe("IssueLedger — never throws, never corrupts (garbage in)", () => {
  function expectParses(l: IssueLedger) {
    const parsed = SandcastleStatusSchema.safeParse({
      ...snap(),
      issueTelemetry: l.rows(),
    });
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  }

  it("absorbs NaN / negative / Infinity wallMs without throwing or corrupting", () => {
    const l = new IssueLedger();
    expect(() => {
      l.addTiming(11, "implementer", NaN);
      l.addTiming(11, "implementer", -5_000);
      l.addTiming(11, "implementer", Infinity);
      l.addTiming(11, "implementer", 1_500.6);
    }).not.toThrow();

    // Only the one good read survives, rounded; the rest clamp to 0.
    expect(rowFor(l, 11).wallMs).toBe(1_501);
    expect(rowFor(l, 11).perRole?.implementer?.runs).toBe(4);
    expectParses(l);
  });

  it("treats an empty entries array as a no-op that creates NO row", () => {
    const l = new IssueLedger();
    expect(() => l.addCost(12, "implementer", [])).not.toThrow();
    expect(l.rows()).toEqual([]);
    expectParses(l);
  });

  it("creates NO row when every entry is malformed (symmetric with an empty array)", () => {
    const l = new IssueLedger();
    const allJunk = [undefined, null, {}, { model: 42 }] as unknown as ModelUsage[];
    expect(() => l.addCost(13, "implementer", allJunk)).not.toThrow();
    expect(l.rows()).toEqual([]);
    expectParses(l);
  });

  it("absorbs a malformed usage object without corrupting a healthy sibling row", () => {
    const l = new IssueLedger();
    const good = usage(PRICED, 1000, 500);
    l.addCost(20, "implementer", [good]);

    const junk = [
      { model: PRICED, usage: { inputTokens: NaN } },
      { model: PRICED, usage: undefined },
      { model: PRICED },
      { model: 42, usage: { inputTokens: 10 } },
      undefined,
      null,
      { model: PRICED, usage: { inputTokens: Infinity, outputTokens: -10 } },
    ] as unknown as ModelUsage[];
    expect(() => l.addCost(21, "implementer", junk)).not.toThrow();

    // The healthy row is untouched...
    const healthy = rowFor(l, 20);
    expect(healthy.tokens).toEqual({
      input: 1000,
      output: 500,
      cacheWrite: 0,
      cacheRead: 0,
    });
    expect(healthy.costUsd).toBeCloseTo(sonnetCost(1000, 500), 10);

    // ...and the garbage row is finite, non-negative, and schema-valid.
    const junkRow = rowFor(l, 21);
    expect(junkRow.tokens).toEqual({
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
    });
    expect(Number.isNaN(junkRow.costUsd as number)).toBe(false);
    expectParses(l);
  });

  it("ignores issue numbers the schema would reject (0, negative, fractional, NaN)", () => {
    const l = new IssueLedger();
    expect(() => {
      for (const bad of [0, -1, 1.5, NaN, Infinity]) {
        l.addCost(bad, "implementer", [usage(PRICED, 1000)]);
        l.addTiming(bad, "implementer", 1000);
      }
    }).not.toThrow();
    expect(l.rows()).toEqual([]);
    expectParses(l);
  });

  it("survives a completely unknown role string without throwing", () => {
    const l = new IssueLedger();
    expect(() =>
      l.addCost(30, "not-a-role" as never, [usage(PRICED, 1000)]),
    ).not.toThrow();
    expect(l.rows()).toEqual([]);
    expectParses(l);
  });
});

describe("IssueLedger — wallMs 0 is ambiguous at the ROW, not at perRole", () => {
  // `rows()` folds `sawTiming` away: `row.wallMs` is always a number, so an
  // issue that never saw a timing sample is indistinguishable from one measured
  // at 0ms — unlike `costUsd`, which keeps its three-state null through the same
  // fold. That is fine INSIDE status.json (the schema types it as a number), but
  // `main.mts` writes the same value into the rework store, where "not
  // instrumented" and "measured zero" are required to stay distinguishable.
  //
  // `perRole` is where the distinction survives, and these two tests pin it,
  // because that is exactly what main.mts's `sawTiming` derivation reads.
  it("omits perRole.wallMs entirely for an issue with cost but no timing", () => {
    const l = new IssueLedger();
    l.addCost(11, "implementer", [usage(PRICED, 10, 10)]);

    const row = rowFor(l, 11);
    expect(row.wallMs).toBe(0);
    expect(row.perRole?.implementer).not.toHaveProperty("wallMs");
    expect(
      Object.values(row.perRole ?? {}).some((r) => r.wallMs !== undefined),
    ).toBe(false);
  });

  it("keeps perRole.wallMs present for a genuinely 0ms measurement", () => {
    // The other direction, and the reason "wallMs > 0" would be the wrong test:
    // a real 0ms sample IS a measurement and must not be erased.
    const l = new IssueLedger();
    l.addTiming(12, "implementer", 0);

    const row = rowFor(l, 12);
    expect(row.wallMs).toBe(0);
    expect(row.perRole?.implementer?.wallMs).toBe(0);
    expect(
      Object.values(row.perRole ?? {}).some((r) => r.wallMs !== undefined),
    ).toBe(true);
  });
});
