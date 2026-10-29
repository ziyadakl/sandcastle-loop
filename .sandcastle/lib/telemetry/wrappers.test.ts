import { describe, expect, it, vi } from "vitest";

import { CostLedger } from "../cost/ledger.js";
import { TimingLedger } from "../cost/timing.js";
import type { ModelUsage } from "../cost/session-usage.js";
import { IssueLedger } from "./issue-ledger.js";
import { captureIssueRoleCost, timeIssueRole } from "./wrappers.js";
import type { TelemetryCtx } from "./wrappers.js";

function usage(model: string, input = 100): ModelUsage {
  return {
    model,
    usage: {
      inputTokens: input,
      outputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}

function ctx(over: Partial<TelemetryCtx> = {}): TelemetryCtx {
  return {
    issueNumber: 42,
    deps: { logError: () => {} },
    ...over,
  };
}

/** A capture stub standing in for the real `captureRoleCost` collaborator. */
function captureDeps(entries: ModelUsage[]) {
  return {
    resolveSessionFilePath: async () => "/fake/session.jsonl",
    extractUsageFromSession: () => entries,
  };
}

const HANDLE = { iterations: [{ sessionFilePath: "/fake/session.jsonl" }] };

describe("timeIssueRole", () => {
  it("folds the SAME dispatch into both the run and the per-issue ledger", async () => {
    const timingLedger = new TimingLedger();
    const issueLedger = new IssueLedger();
    let clock = 1000;
    const now = () => clock;

    await timeIssueRole(
      ctx({ timingLedger, issueLedger }),
      "implementer",
      async () => {
        clock += 250;
        return "done";
      },
      now,
    );

    expect(timingLedger.summary().implementer).toEqual({
      wallMs: 250,
      runs: 1,
    });
    const row = issueLedger.rows()[0]!;
    expect(row.issue).toBe(42);
    expect(row.perRole!.implementer).toEqual({ wallMs: 250, runs: 1 });
  });

  it("passes the dispatch's return value through untouched", async () => {
    const result = await timeIssueRole(
      ctx({ timingLedger: new TimingLedger(), issueLedger: new IssueLedger() }),
      "reviewer",
      async () => ({ stdout: "ok" }),
    );
    expect(result).toEqual({ stdout: "ok" });
  });

  it("re-raises a throwing dispatch AND still records its elapsed time", async () => {
    const issueLedger = new IssueLedger();
    let clock = 0;
    await expect(
      timeIssueRole(
        ctx({ issueLedger }),
        "critique",
        async () => {
          clock += 70;
          throw new Error("boom");
        },
        () => clock,
      ),
    ).rejects.toThrow("boom");
    expect(issueLedger.rows()[0]!.perRole!.critique).toEqual({
      wallMs: 70,
      runs: 1,
    });
  });

  it("is a silent no-op on a BARE ctx (no ledgers at all)", async () => {
    await expect(
      timeIssueRole(ctx(), "implementer", async () => "fine"),
    ).resolves.toBe("fine");
  });

  it("still feeds the run ledger when only the issue ledger is absent", async () => {
    const timingLedger = new TimingLedger();
    let clock = 0;
    await timeIssueRole(
      ctx({ timingLedger }),
      "recovery",
      async () => {
        clock += 5;
      },
      () => clock,
    );
    expect(timingLedger.summary().recovery).toEqual({ wallMs: 5, runs: 1 });
  });

  it("records nothing for a non-positive issue number", async () => {
    const issueLedger = new IssueLedger();
    await timeIssueRole(
      ctx({ issueNumber: 0, issueLedger }),
      "implementer",
      async () => "x",
    );
    expect(issueLedger.rows()).toEqual([]);
  });

  it("never throws into the run when the issue ledger itself misbehaves", async () => {
    const hostile = {
      addTiming: () => {
        throw new Error("ledger exploded");
      },
    } as unknown as IssueLedger;
    await expect(
      timeIssueRole(ctx({ issueLedger: hostile }), "implementer", async () => "ok"),
    ).resolves.toBe("ok");
  });
});

describe("captureIssueRoleCost", () => {
  it("folds the captured entries into BOTH ledgers from one session read", async () => {
    const costLedger = new CostLedger();
    const issueLedger = new IssueLedger();
    const entries = [usage("claude-sonnet-5")];

    await captureIssueRoleCost(
      ctx({ costLedger, issueLedger }),
      "implementer",
      HANDLE,
      captureDeps(entries),
    );

    expect(costLedger.summary().perRole.implementer!.tokens.inputTokens).toBe(
      100,
    );
    const row = issueLedger.rows()[0]!;
    expect(row.issue).toBe(42);
    expect(row.tokens.input).toBe(100);
    expect(row.perRole!.implementer!.costUsd).toBeGreaterThan(0);
  });

  it("reads each session exactly ONCE despite feeding two ledgers", async () => {
    const extract = vi.fn(() => [usage("claude-sonnet-5")]);
    await captureIssueRoleCost(
      ctx({ costLedger: new CostLedger(), issueLedger: new IssueLedger() }),
      "reviewer",
      HANDLE,
      {
        resolveSessionFilePath: async () => "/fake/session.jsonl",
        extractUsageFromSession: extract,
      },
    );
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("attributes NOTHING (no phantom row) when no session resolved", async () => {
    const issueLedger = new IssueLedger();
    await captureIssueRoleCost(
      ctx({ costLedger: new CostLedger(), issueLedger }),
      "implementer",
      HANDLE,
      {
        resolveSessionFilePath: async () => undefined,
        extractUsageFromSession: () => [],
      },
    );
    // `[]` is "nothing to attribute", NOT "this role cost zero".
    expect(issueLedger.rows()).toEqual([]);
  });

  it("preserves costUsd null for an all-unpriced role", async () => {
    const issueLedger = new IssueLedger();
    await captureIssueRoleCost(
      ctx({ costLedger: new CostLedger(), issueLedger }),
      "critique",
      HANDLE,
      captureDeps([usage("zzz-not-a-model")]),
    );
    const row = issueLedger.rows()[0]!;
    expect(row.costUsd).toBeNull();
    expect(row.perRole!.critique!.costUsd).toBeNull();
  });

  it("is a silent no-op on a bare ctx", async () => {
    await expect(
      captureIssueRoleCost(ctx(), "implementer", HANDLE, captureDeps([])),
    ).resolves.toBeUndefined();
  });

  it("never throws into the run when the issue ledger misbehaves", async () => {
    const hostile = {
      addCost: () => {
        throw new Error("ledger exploded");
      },
    } as unknown as IssueLedger;
    await expect(
      captureIssueRoleCost(
        ctx({ costLedger: new CostLedger(), issueLedger: hostile }),
        "implementer",
        HANDLE,
        captureDeps([usage("claude-sonnet-5")]),
      ),
    ).resolves.toBeUndefined();
  });

  it("attributes the PARTIAL accumulation when a later session read throws", async () => {
    const issueLedger = new IssueLedger();
    let call = 0;
    await captureIssueRoleCost(
      ctx({ costLedger: new CostLedger(), issueLedger }),
      "implementer",
      { iterations: [{ sessionFilePath: "a" }, { sessionFilePath: "b" }] },
      {
        resolveSessionFilePath: async (it) =>
          (it as { sessionFilePath?: string }).sessionFilePath,
        extractUsageFromSession: () => {
          if (call++ === 0) return [usage("claude-sonnet-5", 77)];
          throw new Error("parse blew up");
        },
      },
    );
    // The first iteration already reached the cost ledger; dropping it here
    // would leave the two ledgers disagreeing about the same run.
    expect(issueLedger.rows()[0]!.tokens.input).toBe(77);
  });
});
