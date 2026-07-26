import { describe, it, expect } from "vitest";
import { captureRoleCost, type CaptureDeps } from "../.sandcastle/lib/cost/capture.js";
import { CostLedger } from "../.sandcastle/lib/cost/ledger.js";
import type { ModelUsage } from "../.sandcastle/lib/cost/session-usage.js";

const USAGE: ModelUsage[] = [
  {
    model: "claude-opus-4-8",
    usage: {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  },
];

/** Deps that resolve a fixed path and return fixed usage. */
function stubDeps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    resolveSessionFilePath: async () => "/fake/session.jsonl",
    extractUsageFromSession: () => USAGE,
    ...overrides,
  };
}

const handle = { iterations: [{ sessionId: "s1" }] };
const noop = () => {};

describe("captureRoleCost", () => {
  it("folds resolved usage into the ledger under the role", async () => {
    const ledger = new CostLedger();
    await captureRoleCost(ledger, "implementer", handle, noop, stubDeps());
    const s = ledger.summary();
    expect(s.perRole.implementer).toBeDefined();
    expect(s.totalCostUsd).toBeGreaterThan(0);
  });

  it("is a no-op when the ledger is undefined (never resolves)", async () => {
    let resolverCalled = false;
    await captureRoleCost(undefined, "implementer", handle, noop, {
      resolveSessionFilePath: async () => {
        resolverCalled = true;
        return "/x";
      },
      extractUsageFromSession: () => USAGE,
    });
    expect(resolverCalled).toBe(false);
  });

  it("swallows a throwing resolver — never throws into the run — and logs once", async () => {
    const ledger = new CostLedger();
    const logs: string[] = [];
    await expect(
      captureRoleCost(ledger, "reviewer", handle, (l) => logs.push(l), {
        resolveSessionFilePath: async () => {
          throw new Error("boom");
        },
        extractUsageFromSession: () => USAGE,
      }),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes("reviewer") && l.includes("boom"))).toBe(true);
    expect(ledger.summary().totalCostUsd).toBe(0);
  });

  it("swallows a throwing extractor too", async () => {
    const ledger = new CostLedger();
    const logs: string[] = [];
    await expect(
      captureRoleCost(ledger, "merger", handle, (l) => logs.push(l), {
        resolveSessionFilePath: async () => "/fake",
        extractUsageFromSession: () => {
          throw new Error("parse fail");
        },
      }),
    ).resolves.toBeUndefined();
    expect(logs.length).toBe(1);
  });

  it("survives even when the error logger itself throws", async () => {
    const ledger = new CostLedger();
    await expect(
      captureRoleCost(
        ledger,
        "planner",
        handle,
        () => {
          throw new Error("log sink dead");
        },
        stubDeps({
          resolveSessionFilePath: async () => {
            throw new Error("boom");
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("no-ops on empty iterations and on an unresolved path", async () => {
    const ledger = new CostLedger();
    await captureRoleCost(ledger, "planner", { iterations: [] }, noop, stubDeps());
    await captureRoleCost(ledger, "planner", handle, noop, {
      resolveSessionFilePath: async () => undefined,
      extractUsageFromSession: () => USAGE,
    });
    expect(ledger.summary().totalCostUsd).toBe(0);
  });
});
