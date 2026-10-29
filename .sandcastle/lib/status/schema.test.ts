import { describe, expect, it } from "vitest";

import type { SandcastleStatus } from "./schema.js";
import { SandcastleStatusSchema, STATUS_SCHEMA_VERSION } from "./schema.js";

// ---------------------------------------------------------------------------
// The telemetry DATA CONTRACT.
//
// These tests exist because `z.object` STRIPS unknown keys: a field the schema
// does not declare still reaches the push wire but is silently deleted by every
// `safeParse` consumer (the viewer, `status-sync.ts`, the web view-model). So a
// producer can write per-issue telemetry all run long and the dashboard sees
// nothing, with no error anywhere. The contract therefore has to be pinned by
// tests, not by prose:
//
//  1. the schema version MUST NOT move (cross-host peer fusion in
//     `lib/state/status-sync.ts` safeParses peers against `z.literal(3)`, so a
//     bump makes an un-updated host silently drop an updated host's snapshot);
//  2. a status.json written before telemetry existed MUST still parse;
//  3. the new keys MUST survive a parse round-trip;
//  4. `null` MUST survive where `null` means "unknown / unpriced", never 0.
// ---------------------------------------------------------------------------

/** Minimal valid v3 snapshot; `over` layers the field under test on top. */
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

const TOKENS = { input: 100, output: 20, cacheWrite: 5, cacheRead: 900 };

describe("STATUS_SCHEMA_VERSION", () => {
  it("stays at 3 — telemetry is additive+optional, so no bump", () => {
    // MECHANICAL ENFORCEMENT of the no-bump rule. `status-sync.ts` parses peer
    // snapshots against `z.literal(STATUS_SCHEMA_VERSION)`; during any window
    // where one machine is updated and another is not, a bump makes the
    // un-updated host `return null` on the updated host's snapshot and
    // cross-host fusion dies mid-run with nothing surfaced.
    expect(STATUS_SCHEMA_VERSION).toBe(3);
  });
});

describe("backward compatibility", () => {
  it("parses a snapshot written before telemetry existed", () => {
    expect(SandcastleStatusSchema.safeParse(snap()).success).toBe(true);
  });

  it("leaves both telemetry keys undefined when absent", () => {
    const parsed = SandcastleStatusSchema.parse(snap());
    expect(parsed.issueTelemetry).toBeUndefined();
    expect(parsed.runTelemetry).toBeUndefined();
  });

  it("strips an undeclared key — the reason this contract is gated", () => {
    const parsed = SandcastleStatusSchema.parse(
      snap({ notDeclaredAnywhere: 1 } as unknown as Partial<SandcastleStatus>),
    );
    expect("notDeclaredAnywhere" in parsed).toBe(false);
  });
});

describe("issueTelemetry", () => {
  it("survives a parse round-trip", () => {
    const parsed = SandcastleStatusSchema.parse(
      snap({
        issueTelemetry: [
          {
            issue: 42,
            title: "Add a thing",
            type: "type:feature",
            costUsd: 1.25,
            wallMs: 60_000,
            tokens: TOKENS,
            perRole: {
              implementer: {
                costUsd: 1.0,
                wallMs: 40_000,
                tokens: TOKENS,
                runs: 2,
              },
            },
            implementerAttempts: 2,
            reviewerBlockers: 1,
            critiqueRetries: 0,
            deferrals: 0,
            reviewerEscalated: true,
            reviewerEscalationModel: "claude-opus-5",
            changedLines: 120,
            changedFiles: 3,
            shipPath: "implementer-retry",
            outcome: "ok",
            recovery: false,
            quarantined: false,
          },
        ],
      }),
    );
    expect(parsed.issueTelemetry).toBeDefined();
    expect(parsed.issueTelemetry?.[0]?.issue).toBe(42);
    expect(parsed.issueTelemetry?.[0]?.perRole?.implementer?.runs).toBe(2);
    expect(parsed.issueTelemetry?.[0]?.tokens.cacheRead).toBe(900);
  });

  it("accepts a row carrying only the required fields", () => {
    const parsed = SandcastleStatusSchema.parse(
      snap({
        issueTelemetry: [
          { issue: 7, costUsd: 0.5, wallMs: 1_000, tokens: TOKENS },
        ],
      }),
    );
    expect(parsed.issueTelemetry?.[0]?.title).toBeUndefined();
  });

  it("keeps `costUsd: null` as null — unpriced, NOT free", () => {
    const parsed = SandcastleStatusSchema.parse(
      snap({
        issueTelemetry: [
          {
            issue: 7,
            costUsd: null,
            wallMs: 1_000,
            tokens: TOKENS,
            perRole: { reviewer: { costUsd: null } },
          },
        ],
      }),
    );
    expect(parsed.issueTelemetry?.[0]?.costUsd).toBeNull();
    expect(parsed.issueTelemetry?.[0]?.perRole?.reviewer?.costUsd).toBeNull();
  });

  it("accepts a perRole entry with no token split — tokens is optional there", () => {
    const parsed = SandcastleStatusSchema.parse(
      snap({
        issueTelemetry: [
          {
            issue: 7,
            costUsd: null,
            wallMs: 1,
            tokens: TOKENS,
            perRole: { critique: { runs: 1 } },
          },
        ],
      }),
    );
    expect(parsed.issueTelemetry?.[0]?.perRole?.critique?.runs).toBe(1);
    // ASYMMETRY, pinned on purpose: the ROW's `tokens` is required, but a
    // per-role `tokens` is OPTIONAL — a timing-only source (a role with a
    // dispatch count and no resolvable session) must stay valid.
    expect(parsed.issueTelemetry?.[0]?.perRole?.critique?.tokens).toBeUndefined();
  });

  it("rejects a shipPath outside the three known legs", () => {
    const bad = SandcastleStatusSchema.safeParse(
      snap({
        issueTelemetry: [
          {
            issue: 7,
            costUsd: null,
            wallMs: 1,
            tokens: TOKENS,
            shipPath: "teleported",
          },
        ] as never,
      }),
    );
    expect(bad.success).toBe(false);
  });
});

describe("runTelemetry", () => {
  it("survives a parse round-trip", () => {
    const parsed = SandcastleStatusSchema.parse(
      snap({
        runTelemetry: {
          identity: {
            profile: "budget",
            backend: "claude",
            roleModels: {
              implementer: {
                default: "claude-sonnet-5",
                escalations: ["claude-opus-5"],
              },
            },
            promptHashes: { "implementer-prompt.md": "a1b2c3d4" },
          },
          counters: {
            reviewerBlockers: 3,
            implementerRetries: 1,
            critiqueFails: 0,
            recoveries: 0,
            quarantines: 1,
            deferrals: 2,
            skillDisciplineMisses: { implementer: 4 },
          },
          errorClasses: {
            transient: 2,
            stalled: 0,
            noVerdict: 1,
            outputCap: 0,
          },
          tokenEfficiency: {
            implementer: {
              input: 100,
              output: 20,
              cacheWrite: 5,
              cacheRead: 900,
              cacheHitRatio: 0.9,
            },
          },
          overheadCostUsd: 2.5,
        },
      }),
    );
    expect(parsed.runTelemetry).toBeDefined();
    expect(parsed.runTelemetry?.identity?.profile).toBe("budget");
    expect(
      parsed.runTelemetry?.identity?.roleModels?.implementer?.escalations,
    ).toEqual(["claude-opus-5"]);
    expect(parsed.runTelemetry?.counters?.skillDisciplineMisses?.implementer).toBe(
      4,
    );
  });

  it("accepts an empty runTelemetry object", () => {
    expect(SandcastleStatusSchema.safeParse(snap({ runTelemetry: {} })).success).toBe(
      true,
    );
  });

  it("keeps `cacheHitRatio: null` — an all-zero role, where NaN would fail", () => {
    const parsed = SandcastleStatusSchema.parse(
      snap({
        runTelemetry: {
          tokenEfficiency: {
            merger: {
              input: 0,
              output: 0,
              cacheWrite: 0,
              cacheRead: 0,
              cacheHitRatio: null,
            },
          },
        },
      }),
    );
    expect(parsed.runTelemetry?.tokenEfficiency?.merger?.cacheHitRatio).toBeNull();
  });

  it("rejects NaN for cacheHitRatio, so producers must send null", () => {
    const bad = SandcastleStatusSchema.safeParse(
      snap({
        runTelemetry: {
          tokenEfficiency: {
            merger: {
              input: 0,
              output: 0,
              cacheWrite: 0,
              cacheRead: 0,
              cacheHitRatio: Number.NaN,
            },
          },
        },
      }),
    );
    expect(bad.success).toBe(false);
    // ATTRIBUTION: assert the rejection is ON cacheHitRatio, not on some other
    // field of the same object. Without this the test would stay green even if
    // zod accepted NaN, and the contract's central guarantee — "emit null or
    // the whole snapshot parse dies" — would be unenforced.
    expect(
      bad.error?.issues.some((i) => i.path.includes("cacheHitRatio")),
    ).toBe(true);
  });

  it("keeps `overheadCostUsd: null` as null — unpriced, NOT free", () => {
    const parsed = SandcastleStatusSchema.parse(
      snap({ runTelemetry: { overheadCostUsd: null } }),
    );
    expect(parsed.runTelemetry?.overheadCostUsd).toBeNull();
  });

  it("rejects a profile outside the four known model-map profiles", () => {
    const bad = SandcastleStatusSchema.safeParse(
      snap({
        runTelemetry: {
          identity: { profile: "turbo", roleModels: {} },
        } as never,
      }),
    );
    expect(bad.success).toBe(false);
  });
});
