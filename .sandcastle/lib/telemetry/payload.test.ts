import { describe, expect, it } from "vitest";

import { CostLedger, type CostSummary } from "../cost/ledger.js";
import { SandcastleStatusSchema } from "../status/schema.js";
import type { IssueTelemetryRow, RunIdentity } from "../status/schema.js";
import type { IssueTelemetryBagRow } from "./issue-bag.js";
import { ATTRIBUTABLE_ROLES } from "./issue-ledger.js";
import { BATCH_ROLES, buildTelemetryPayload } from "./payload.js";

/** A `CostSummary` with only the fields `buildTelemetryPayload` reads. */
function costSummary(
  perRole: CostSummary["perRole"],
  extra: Partial<CostSummary> = {},
): CostSummary {
  return {
    perRole,
    perModel: [],
    totalCostUsd: 0,
    unpricedModels: [],
    ...extra,
  };
}

const ZERO_SPLIT = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/** A ledger-shaped row: the spine the `IssueLedger` owns. */
function ledgerRow(
  issue: number,
  over: Partial<IssueTelemetryRow> = {},
): IssueTelemetryRow {
  return {
    issue,
    costUsd: 1.5,
    wallMs: 1000,
    tokens: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
    ...over,
  };
}

const IDENTITY: RunIdentity = {
  profile: "default",
  roleModels: { implementer: { default: "claude-sonnet-5", escalations: [] } },
};

describe("buildTelemetryPayload", () => {
  describe("the empty case — absent, never empty-but-present", () => {
    it("returns an EMPTY patch when nothing at all was captured", () => {
      expect(buildTelemetryPayload({})).toEqual({});
    });

    it("omits issueTelemetry when both row sources are empty", () => {
      const out = buildTelemetryPayload({
        issueRows: [],
        issueBagRows: new Map(),
      });
      expect(out.issueTelemetry).toBeUndefined();
    });

    it("omits runTelemetry when every run-level source is empty", () => {
      const out = buildTelemetryPayload({
        costSummary: costSummary({}),
        runCounters: {},
      });
      expect(out.runTelemetry).toBeUndefined();
    });

    it("does not emit a runTelemetry key merely because a cost summary was passed", () => {
      // A run that dispatched nothing still produces a CostSummary object.
      // Emitting `runTelemetry: {}` would claim "measured, all empty".
      expect(buildTelemetryPayload({ costSummary: costSummary({}) })).toEqual(
        {},
      );
    });
  });

  describe("issueTelemetry — outer join of ledger rows and bag rows", () => {
    it("passes ledger-only rows through untouched", () => {
      const row = ledgerRow(7, { perRole: { implementer: { costUsd: 1.5 } } });
      const out = buildTelemetryPayload({ issueRows: [row] });
      expect(out.issueTelemetry).toEqual([row]);
    });

    it("merges a bag row onto the ledger row for the same issue", () => {
      const bag: IssueTelemetryBagRow = {
        implementerAttempts: 2,
        shipPath: "implementer-retry",
        outcome: "ok",
      };
      const out = buildTelemetryPayload({
        issueRows: [ledgerRow(7)],
        issueBagRows: new Map([[7, bag]]),
      });
      expect(out.issueTelemetry).toEqual([
        {
          issue: 7,
          costUsd: 1.5,
          wallMs: 1000,
          tokens: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
          implementerAttempts: 2,
          shipPath: "implementer-retry",
          outcome: "ok",
        },
      ]);
    });

    it("synthesises a spine for a BAG-ONLY issue so the row still parses", () => {
      // An issue quarantined before any session resolved has counters but no
      // cost/timing at all. Dropping it would lose the quarantine entirely.
      const out = buildTelemetryPayload({
        issueBagRows: new Map([[9, { outcome: "quarantined", quarantined: true }]]),
      });
      expect(out.issueTelemetry).toEqual([
        {
          issue: 9,
          costUsd: null,
          wallMs: 0,
          tokens: ZERO_SPLIT,
          outcome: "quarantined",
          quarantined: true,
        },
      ]);
    });

    it("never lets a bag row overwrite the ledger's spine", () => {
      // The bag's row type cannot carry these, but a hand-built or stale
      // object could; the ledger must win on the four fields it owns.
      const rogue = {
        costUsd: 999,
        wallMs: 999,
        tokens: ZERO_SPLIT,
        issue: 123,
        outcome: "ok",
      } as unknown as IssueTelemetryBagRow;
      const out = buildTelemetryPayload({
        issueRows: [ledgerRow(7)],
        issueBagRows: new Map([[7, rogue]]),
      });
      const row = out.issueTelemetry![0]!;
      expect(row.issue).toBe(7);
      expect(row.costUsd).toBe(1.5);
      expect(row.wallMs).toBe(1000);
      expect(row.tokens.input).toBe(10);
      expect(row.outcome).toBe("ok");
    });

    it("sorts NUMERICALLY by issue across both sources", () => {
      const out = buildTelemetryPayload({
        issueRows: [ledgerRow(100), ledgerRow(9)],
        issueBagRows: new Map([[20, { outcome: "ok" }]]),
      });
      expect(out.issueTelemetry!.map((r) => r.issue)).toEqual([9, 20, 100]);
    });

    it("drops a bag row whose issue key is not a positive integer", () => {
      const out = buildTelemetryPayload({
        issueBagRows: new Map([
          [0, { outcome: "ok" as const }],
          [-4, { outcome: "ok" as const }],
          [1.5, { outcome: "ok" as const }],
          [5, { outcome: "ok" as const }],
        ]),
      });
      expect(out.issueTelemetry!.map((r) => r.issue)).toEqual([5]);
    });

    it("preserves a null costUsd on a ledger row (all-unpriced ≠ free)", () => {
      const out = buildTelemetryPayload({
        issueRows: [ledgerRow(3, { costUsd: null })],
      });
      expect(out.issueTelemetry![0]!.costUsd).toBeNull();
    });
  });

  describe("tokenEfficiency", () => {
    it("derives the 4-way split plus the cache-hit ratio per role", () => {
      const out = buildTelemetryPayload({
        costSummary: costSummary({
          implementer: {
            costUsd: 1,
            tokens: {
              inputTokens: 10,
              outputTokens: 500,
              cacheCreationInputTokens: 30,
              cacheReadInputTokens: 60,
            },
          },
        }),
      });
      expect(out.runTelemetry!.tokenEfficiency).toEqual({
        implementer: {
          input: 10,
          output: 500,
          cacheWrite: 30,
          cacheRead: 60,
          // 60 / (10 + 30 + 60) — output is excluded from the denominator.
          cacheHitRatio: 0.6,
        },
      });
    });

    it("emits cacheHitRatio null (never NaN) for a role with no prompt tokens", () => {
      const out = buildTelemetryPayload({
        costSummary: costSummary({
          reviewer: {
            costUsd: null,
            tokens: {
              inputTokens: 0,
              outputTokens: 40,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
          },
        }),
      });
      const eff = out.runTelemetry!.tokenEfficiency!.reviewer!;
      expect(eff.cacheHitRatio).toBeNull();
      expect(Number.isNaN(eff.cacheHitRatio as number)).toBe(false);
    });

    it("covers BATCH roles too — the attributable-only rule is per-issue, not here", () => {
      const out = buildTelemetryPayload({
        costSummary: costSummary({
          planner: {
            costUsd: 1,
            tokens: {
              inputTokens: 4,
              outputTokens: 1,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 4,
            },
          },
        }),
      });
      expect(out.runTelemetry!.tokenEfficiency!.planner).toBeDefined();
    });

    it("is omitted when no role reported cost", () => {
      const out = buildTelemetryPayload({
        costSummary: costSummary({}),
        runCounters: { counters: { deferrals: 1 } },
      });
      expect(out.runTelemetry!.tokenEfficiency).toBeUndefined();
    });
  });

  describe("overheadCostUsd — tri-state", () => {
    it("is ABSENT when no batch role ran", () => {
      const out = buildTelemetryPayload({
        costSummary: costSummary({
          implementer: {
            costUsd: 2,
            tokens: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
          },
        }),
      });
      expect("overheadCostUsd" in out.runTelemetry!).toBe(false);
    });

    it("is NULL when batch roles ran but every model was unpriced", () => {
      const out = buildTelemetryPayload({
        costSummary: costSummary({
          planner: {
            costUsd: null,
            tokens: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
          },
          merger: {
            costUsd: null,
            tokens: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
          },
        }),
      });
      expect(out.runTelemetry!.overheadCostUsd).toBeNull();
    });

    it("sums ONLY the four batch roles, ignoring the attributable ones", () => {
      const tokens = {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      const out = buildTelemetryPayload({
        costSummary: costSummary({
          planner: { costUsd: 1, tokens },
          merger: { costUsd: 2, tokens },
          postMergeReviewer: { costUsd: 4, tokens },
          postMergeFixer: { costUsd: 8, tokens },
          implementer: { costUsd: 1000, tokens },
          reviewer: { costUsd: 1000, tokens },
        }),
      });
      expect(out.runTelemetry!.overheadCostUsd).toBe(15);
    });

    it("sums the priced batch roles when only SOME are unpriced", () => {
      const tokens = {
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      const out = buildTelemetryPayload({
        costSummary: costSummary({
          planner: { costUsd: 3, tokens },
          merger: { costUsd: null, tokens },
        }),
      });
      expect(out.runTelemetry!.overheadCostUsd).toBe(3);
    });

    it("names exactly the four structurally unattributable roles", () => {
      expect([...BATCH_ROLES].sort()).toEqual([
        "merger",
        "planner",
        "postMergeFixer",
        "postMergeReviewer",
      ]);
    });
  });

  describe("run counters and identity pass through", () => {
    it("carries counters and errorClasses verbatim", () => {
      const out = buildTelemetryPayload({
        runCounters: {
          counters: { implementerRetries: 6, quarantines: 1 },
          errorClasses: { outputCap: 2 },
        },
      });
      expect(out.runTelemetry!.counters).toEqual({
        implementerRetries: 6,
        quarantines: 1,
      });
      expect(out.runTelemetry!.errorClasses).toEqual({ outputCap: 2 });
    });

    it("carries identity, so a late drain re-states what startup wrote", () => {
      const out = buildTelemetryPayload({ runIdentity: IDENTITY });
      expect(out.runTelemetry!.identity).toEqual(IDENTITY);
    });

    it("omits identity entirely when resolution failed at startup", () => {
      const out = buildTelemetryPayload({
        runCounters: { counters: { deferrals: 1 } },
      });
      expect("identity" in out.runTelemetry!).toBe(false);
    });
  });

  describe("the output always parses as part of a real status.json", () => {
    it("survives SandcastleStatusSchema with every field populated", () => {
      const tokens = {
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 40,
      };
      const payload = buildTelemetryPayload({
        costSummary: costSummary({
          implementer: { costUsd: 2, tokens },
          planner: { costUsd: 1, tokens },
        }),
        issueRows: [ledgerRow(7, { perRole: { implementer: { runs: 1 } } })],
        issueBagRows: new Map([[7, { implementerAttempts: 2, outcome: "ok" }]]),
        runCounters: { counters: { implementerRetries: 1 } },
        runIdentity: IDENTITY,
      });
      const parsed = SandcastleStatusSchema.safeParse({
        schemaVersion: 3,
        state: "running",
        run: {
          branch: "b",
          repo: "r",
          startedAt: new Date().toISOString(),
          iterations: { current: 1, total: 1 },
          maxConcurrent: 1,
        },
        totals: { merged: 0, needsHuman: 0, requeued: 0, running: 0 },
        issues: [],
        hostId: "h",
        runId: "r1",
        updatedAt: new Date().toISOString(),
        ...payload,
      });
      expect(parsed.error?.issues).toBeUndefined();
      expect(parsed.success).toBe(true);
    });
  });
});

describe("BATCH_ROLES", () => {
  /**
   * The money invariant. `Σ issueTelemetry[].costUsd + overheadCostUsd` equals
   * the run total ONLY IF the attributable and batch role lists partition
   * `CostLedger.ROLE_ORDER` exactly. A new role belonging to neither would
   * have its spend silently vanish from both sides — no type error, no other
   * failing test. This is the test that makes that loud.
   */
  it("partitions CostLedger.ROLE_ORDER exactly, with no overlap", () => {
    const attributable = new Set<string>(ATTRIBUTABLE_ROLES);
    const batch = new Set<string>(BATCH_ROLES);

    // Disjoint: no role can be charged to a ticket AND treated as overhead.
    expect([...batch].filter((r) => attributable.has(r))).toEqual([]);

    // Exhaustive, both ways. Sorted rather than order-compared: nothing depends
    // on the ordering, and pinning it would fail on a harmless reshuffle.
    expect([...attributable, ...batch].sort()).toEqual(
      [...CostLedger.ROLE_ORDER].sort(),
    );
    expect(attributable.size + batch.size).toBe(CostLedger.ROLE_ORDER.length);
  });
});
