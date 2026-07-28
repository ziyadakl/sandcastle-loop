/**
 * Tests for the pure render-model of the Sandcastle lite web viewer
 * (`.sandcastle/web/view-model.js`).
 *
 * The load-bearing property is CROSS-HOST FUSION WITHOUT LOSS: every host a
 * snapshot knows about (own + peers) must survive into `hosts`, even a stale or
 * offline peer, and totals/active/recent must fold every host together without
 * double-counting. Staleness is injected via an explicit `nowMs` so the tests
 * are deterministic.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildViewModel,
  hostLabel,
  isStale,
  humanizeHostId,
  formatCost,
  formatDuration,
  ROLE_ORDER,
  STALE_AFTER_MS,
} from "../.sandcastle/web/view-model.js";
import { CostLedger } from "../.sandcastle/lib/cost/ledger.js";

function fixture(name: string): any {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/status/${name}`, import.meta.url), "utf8"),
  );
}

// Reference `updatedAt` for the multi-host fixtures is 2026-07-17T01:00:00Z;
// 30s later keeps own fresh and (in the stale fixture) the 10-min-old peer stale.
const MULTI_NOW = Date.parse("2026-07-17T01:00:30.000Z");

describe("humanizeHostId", () => {
  it("title-cases and splits on -_. / whitespace", () => {
    expect(humanizeHostId("ziyads-macbook-air")).toBe("Ziyads Macbook Air");
    expect(humanizeHostId("srv-1360790")).toBe("Srv 1360790");
    expect(humanizeHostId("host_a.local")).toBe("Host A Local");
    expect(humanizeHostId("mac mini")).toBe("Mac Mini");
  });

  it("empty string → empty string, and drops empty segments", () => {
    expect(humanizeHostId("")).toBe("");
    expect(humanizeHostId("--foo__")).toBe("Foo");
  });
});

describe("hostLabel", () => {
  it("uses the alias map when present", () => {
    expect(hostLabel("srv1360790")).toBe("VPS");
    expect(hostLabel("ziyads-macbook-air.local")).toBe("Mac");
  });

  it("falls back to humanizeHostId for an unknown id", () => {
    expect(hostLabel("build-box-07")).toBe("Build Box 07");
  });
});

describe("isStale", () => {
  const base = Date.parse("2026-07-17T01:00:00.000Z");
  it("fresh timestamp → false", () => {
    expect(isStale("2026-07-17T01:00:00.000Z", base + 30_000)).toBe(false);
  });
  it("just past the threshold → true", () => {
    expect(isStale("2026-07-17T01:00:00.000Z", base + STALE_AFTER_MS + 1)).toBe(
      true,
    );
  });
  it("exactly at the threshold → not yet stale (strict >)", () => {
    expect(isStale("2026-07-17T01:00:00.000Z", base + STALE_AFTER_MS)).toBe(
      false,
    );
  });
  it("unparseable / absent timestamp → stale (defensive)", () => {
    expect(isStale("not-a-date", base)).toBe(true);
    expect(isStale(undefined, base)).toBe(true);
  });
});

describe("buildViewModel — single host (sample-status.json)", () => {
  const snap = fixture("sample-status.json");
  const now = Date.parse(snap.updatedAt); // fresh
  const vm = buildViewModel(snap, now);

  it("is not multi-host and carries a single host row with no label badge", () => {
    expect(vm.multiHost).toBe(false);
    expect(vm.hosts).toHaveLength(1);
    expect(vm.hosts[0].hostId).toBe("host-a");
    // active rows omit hostLabel in single-host mode
    for (const row of vm.active) expect(row.hostLabel).toBeUndefined();
  });

  it("totals equal own totals (no peers to fold)", () => {
    expect(vm.totals).toEqual({
      merged: 3,
      needsHuman: 1,
      requeued: 0,
      running: 2,
    });
  });

  it("active excludes terminal phases (merged / needs-human)", () => {
    const nums = vm.active.map((r) => r.number).sort();
    expect(nums).toEqual([337, 339]); // 340 needs-human, 331/334/336 merged excluded
    expect(vm.active.some((r) => r.phase === "merged")).toBe(false);
    expect(vm.active.some((r) => r.phase === "needs-human")).toBe(false);
  });

  it("recent is derived from the issues' terminal phases", () => {
    const nums = vm.recent.map((r) => r.number).sort();
    expect(nums).toEqual([331, 334, 336, 340]);
  });

  it("banner is live for a fresh running snapshot", () => {
    expect(vm.banner.kind).toBe("live");
    expect(vm.banner.live).toBe(true);
    expect(vm.banner.text).toBe("Live");
  });
});

describe("buildViewModel — multi-host live (multihost-live.json)", () => {
  const snap = fixture("multihost-live.json");
  const vm = buildViewModel(snap, MULTI_NOW);

  it("is multi-host with both hosts labelled via the alias map", () => {
    expect(vm.multiHost).toBe(true);
    expect(vm.hosts.map((h: any) => h.label)).toEqual(["VPS", "Mac"]);
    // own host first, then the peer
    expect(vm.hosts[0].hostId).toBe("srv1360790");
    expect(vm.hosts[1].hostId).toBe("ziyads-macbook-air.local");
  });

  it("active is the union across hosts, each badged with its host label", () => {
    const byNum = new Map(vm.active.map((r) => [r.number, r] as const));
    expect([...byNum.keys()].sort()).toEqual([605, 607]);
    expect(byNum.get(607)!.hostLabel).toBe("VPS");
    expect(byNum.get(605)!.hostLabel).toBe("Mac");
    // peer #606 is needs-human (terminal) → not active
    expect(byNum.has(606)).toBe(false);
  });

  it("totals are field-wise summed across hosts", () => {
    expect(vm.totals.merged).toBe(3); // 2 + 1
    expect(vm.totals.needsHuman).toBe(1); // 0 + 1
  });

  it("perMachine has one entry per host", () => {
    expect(vm.meta.perMachine).toHaveLength(2);
    expect(vm.meta.perMachine.map((m: any) => m.label)).toEqual(["VPS", "Mac"]);
    expect(vm.meta.branch).toBe("sandcastle/queue-20260716");
  });

  it("recent folds own history + peer terminal issues, newest-first", () => {
    const nums = vm.recent.map((r: any) => r.number);
    // #606 (peer needs-human, completedAt=peer.updatedAt 00:59:50) newest,
    // then #602 (00:58), then #601 (00:53)
    expect(nums).toEqual([606, 602, 601]);
    expect(vm.recent[0].hostLabel).toBe("Mac"); // peer-derived row badged
  });
});

describe("buildViewModel — stale/offline peer stays present (multihost-stale-peer.json)", () => {
  const snap = fixture("multihost-stale-peer.json");
  const vm = buildViewModel(snap, MULTI_NOW);

  it("keeps the offline peer in hosts, flagged stale, own host fresh", () => {
    expect(vm.hosts).toHaveLength(2);
    const own = vm.hosts.find((h) => h.hostId === "srv1360790");
    const peer = vm.hosts.find((h) => h.hostId === "ziyads-macbook-air.local");
    expect(own!.stale).toBe(false);
    expect(peer!.stale).toBe(true); // 10 minutes old > 3-min threshold
  });
});

describe("buildViewModel — terminal run states", () => {
  it("unhealthy snapshot → banner kind 'unhealthy' (never done/live)", () => {
    const snap = fixture("unhealthy.json");
    const vm = buildViewModel(snap, Date.parse(snap.updatedAt));
    expect(vm.banner.kind).toBe("unhealthy");
    expect(vm.banner.live).toBe(false);
    expect(vm.banner.text).toBe("Unhealthy — needs attention");
  });

  it("done snapshot → banner kind 'done'", () => {
    const snap = fixture("done.json");
    const vm = buildViewModel(snap, Date.parse(snap.updatedAt));
    expect(vm.banner.kind).toBe("done");
    expect(vm.banner.text).toBe("Done");
  });
});

describe("buildViewModel — crashed detection (same-host pid probe)", () => {
  // sample-status.json is state:running, hostId:"host-a", fresh updatedAt.
  const FRESH_NOW = Date.parse("2026-06-04T11:59:40.000Z"); // ~10s after updatedAt

  it("own snapshot + dead pid → banner kind 'crashed' (beats a fresh feed)", () => {
    const snap = { ...fixture("sample-status.json"), pid: 4242 };
    const calls: number[] = [];
    const vm = buildViewModel(snap, FRESH_NOW, undefined, {
      selfHostId: "host-a",
      probeAlive: (pid) => {
        calls.push(pid);
        return false;
      },
    });
    expect(vm.banner.kind).toBe("crashed");
    expect(vm.banner.live).toBe(false);
    expect(vm.banner.text).toBe("Crashed — loop died, work may be recoverable");
    expect(calls).toEqual([4242]);
  });

  it("own snapshot + live pid → live (a running process is not crashed)", () => {
    const snap = { ...fixture("sample-status.json"), pid: 4242 };
    const vm = buildViewModel(snap, FRESH_NOW, undefined, {
      selfHostId: "host-a",
      probeAlive: () => true,
    });
    expect(vm.banner.kind).toBe("live");
  });

  it("PEER-owned snapshot + dead pid → NOT crashed, probe never consulted", () => {
    const snap = { ...fixture("sample-status.json"), pid: 4242 }; // hostId host-a
    const calls: number[] = [];
    const vm = buildViewModel(snap, FRESH_NOW, undefined, {
      selfHostId: "some-other-host",
      probeAlive: (pid) => {
        calls.push(pid);
        return false;
      },
    });
    expect(vm.banner.kind).toBe("live");
    expect(calls).toEqual([]);
  });

  it("no probe injected (browser default) → crashed never appears", () => {
    const snap = { ...fixture("sample-status.json"), pid: 4242 };
    const vm = buildViewModel(snap, FRESH_NOW);
    expect(vm.banner.kind).toBe("live");
  });
});

describe("buildViewModel — pill tone", () => {
  it("a zero total renders a gray pill, non-zero renders a coloured one", () => {
    const snap = fixture("sample-status.json"); // requeued 0, merged 3, needsHuman 1
    const vm = buildViewModel(snap, Date.parse(snap.updatedAt));
    const pill = (k: string) => vm.pills.find((p) => p.key === k)!;
    expect(pill("requeued").count).toBe(0);
    expect(pill("requeued").tone).toBe("gray");
    expect(pill("merged").tone).toBe("success");
    expect(pill("needsHuman").tone).toBe("warning");
  });
});

describe("buildViewModel — recent dedup + overflow", () => {
  const baseRun = {
    branch: "sandcastle/queue-20260716",
    repo: "affinity-tracker",
    startedAt: "2026-07-17T00:50:00.000Z",
    iterations: { current: 1, total: 50 },
    maxConcurrent: 2,
  };
  const zeroTotals = { merged: 0, needsHuman: 0, requeued: 0, running: 0 };

  it("dedups by number, first-writer (own history) wins over a peer fallback", () => {
    const snap = {
      schemaVersion: 3,
      state: "running",
      hostId: "srv1360790",
      runId: "r",
      run: baseRun,
      totals: zeroTotals,
      issues: [],
      history: [
        {
          number: 500,
          title: "shipped by the hub",
          branch: "agent/issue-500",
          phase: "merged",
          completedAt: "2026-07-17T00:59:00.000Z",
          hostId: "srv1360790",
        },
      ],
      updatedAt: "2026-07-17T01:00:00.000Z",
      peers: [
        {
          hostId: "ziyads-macbook-air.local",
          state: "running",
          iterations: { current: 1, total: 50 },
          totals: zeroTotals,
          // same #500 but as a needs-human fallback — must be deduped out
          issues: [
            {
              number: 500,
              title: "peer view of 500",
              branch: "agent/issue-500",
              phase: "needs-human",
              attention: true,
            },
          ],
          updatedAt: "2026-07-17T00:59:50.000Z",
        },
      ],
    };
    const vm = buildViewModel(snap, MULTI_NOW);
    const rows = vm.recent.filter((r: any) => r.number === 500);
    expect(rows).toHaveLength(1);
    expect(rows[0].phaseLabel).toBe("Merged"); // history phase, not the peer's needs-human
  });

  it("caps recent at 10 newest-first and reports overflowRecent", () => {
    const history = Array.from({ length: 11 }, (_, i) => ({
      number: 800 + i,
      title: `terminal ${800 + i}`,
      branch: `agent/issue-${800 + i}`,
      phase: "merged",
      // 800 oldest ... 810 newest
      completedAt: `2026-07-17T00:${String(40 + i).padStart(2, "0")}:00.000Z`,
      hostId: "srv1360790",
    }));
    const snap = {
      schemaVersion: 3,
      state: "running",
      hostId: "srv1360790",
      runId: "r",
      run: baseRun,
      totals: zeroTotals,
      issues: [],
      history,
      updatedAt: "2026-07-17T01:00:00.000Z",
    };
    const vm = buildViewModel(snap, MULTI_NOW);
    expect(vm.recent).toHaveLength(10);
    expect(vm.overflowRecent).toBe(1);
    expect(vm.recent[0].number).toBe(810); // newest first
    expect(vm.recent.some((r: any) => r.number === 800)).toBe(false); // oldest dropped
  });
});

describe("buildViewModel — defensive", () => {
  it("null snapshot → safe minimal model, banner 'no-run', no throw", () => {
    const vm = buildViewModel(null as any, MULTI_NOW);
    expect(vm.banner.kind).toBe("no-run");
    expect(vm.hosts).toEqual([]);
    expect(vm.active).toEqual([]);
    expect(vm.recent).toEqual([]);
  });

  it("null snapshot carries no cost/timing fields", () => {
    const vm = buildViewModel(null as any, MULTI_NOW);
    expect(vm.totals.totalCostUsd).toBeUndefined();
    expect(vm.totals.perRole).toBeUndefined();
  });
});

describe("formatCost", () => {
  it("formats a dollar figure to 2dp", () => {
    expect(formatCost(0.02)).toBe("$0.02");
    expect(formatCost(1.2345)).toBe("$1.23");
    expect(formatCost(0)).toBe("$0.00");
  });
  it("null / undefined / NaN → em dash", () => {
    expect(formatCost(null)).toBe("—");
    expect(formatCost(undefined)).toBe("—");
    expect(formatCost(Number.NaN)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("minutes + seconds", () => {
    expect(formatDuration(80000)).toBe("1m 20s");
    expect(formatDuration(60000)).toBe("1m 0s");
  });
  it("seconds only", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(1000)).toBe("1s");
  });
  it("sub-second milliseconds", () => {
    expect(formatDuration(800)).toBe("800ms");
    expect(formatDuration(0)).toBe("0ms");
  });
  it("null / undefined / negative → em dash", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });
});

describe("buildViewModel — cost & timing (totals.perRole / totalCostUsd)", () => {
  const baseRun = {
    branch: "sandcastle/queue-20260716",
    repo: "affinity-tracker",
    startedAt: "2026-07-17T00:50:00.000Z",
    iterations: { current: 1, total: 50 },
    maxConcurrent: 2,
  };

  it("carries totalCostUsd and perRole in pipeline order, fields passed through", () => {
    const snap = {
      schemaVersion: 3,
      state: "running",
      hostId: "srv1360790",
      runId: "r",
      run: baseRun,
      totals: {
        merged: 1,
        needsHuman: 0,
        requeued: 0,
        running: 1,
        totalCostUsd: 1.2345,
        // deliberately out of pipeline order in the source object
        perRole: {
          reviewer: { costUsd: 0.02, tokens: 1000, wallMs: 80000, runs: 3 },
          implementer: { costUsd: 0.5, wallMs: 800, runs: 2 },
          planner: { costUsd: null, runs: 1 },
          merger: { costUsd: 0.1, wallMs: 60000 },
        },
      },
      issues: [],
      history: [],
      updatedAt: "2026-07-17T01:00:00.000Z",
    };
    const vm = buildViewModel(snap, MULTI_NOW);
    expect(vm.totals.totalCostUsd).toBe(1.2345);
    // pipeline order: planner, implementer, reviewer, ..., merger, ...
    expect(vm.totals.perRole!.map((r: any) => r.role)).toEqual([
      "planner",
      "implementer",
      "reviewer",
      "merger",
    ]);
    const byRole = new Map(vm.totals.perRole!.map((r: any) => [r.role, r]));
    // null cost preserved (renders "—" later), runs carried, no wallMs
    expect(byRole.get("planner")).toEqual({ role: "planner", costUsd: null, runs: 1 });
    // sub-second wallMs + runs, no tokens
    expect(byRole.get("implementer")).toEqual({
      role: "implementer",
      costUsd: 0.5,
      wallMs: 800,
      runs: 2,
    });
    // all four inner fields carried through
    expect(byRole.get("reviewer")).toEqual({
      role: "reviewer",
      costUsd: 0.02,
      tokens: 1000,
      wallMs: 80000,
      runs: 3,
    });
    // no runs → runs omitted
    expect(byRole.get("merger")).toEqual({
      role: "merger",
      costUsd: 0.1,
      wallMs: 60000,
    });
  });

  it("omits roles absent from the data; a role with absent costUsd becomes null", () => {
    const snap = {
      schemaVersion: 3,
      state: "running",
      hostId: "host-a",
      runId: "r",
      run: baseRun,
      totals: {
        merged: 0,
        needsHuman: 0,
        requeued: 0,
        running: 1,
        perRole: {
          implementer: { wallMs: 1500, runs: 1 }, // no costUsd field at all
        },
      },
      issues: [],
      history: [],
      updatedAt: "2026-07-17T01:00:00.000Z",
    };
    const vm = buildViewModel(snap, MULTI_NOW);
    expect(vm.totals.perRole!.map((r: any) => r.role)).toEqual(["implementer"]);
    expect(vm.totals.perRole![0].costUsd).toBeNull();
    // totalCostUsd absent in source → undefined in vm
    expect(vm.totals.totalCostUsd).toBeUndefined();
  });

  it("takes own-host perRole only; peers do NOT contribute cost rows", () => {
    const snap = {
      schemaVersion: 3,
      state: "running",
      hostId: "srv1360790",
      runId: "r",
      run: baseRun,
      totals: {
        merged: 0,
        needsHuman: 0,
        requeued: 0,
        running: 1,
        totalCostUsd: 0.4,
        perRole: { implementer: { costUsd: 0.4, runs: 1 } },
      },
      issues: [],
      history: [],
      updatedAt: "2026-07-17T01:00:00.000Z",
      peers: [
        {
          hostId: "ziyads-macbook-air.local",
          state: "running",
          iterations: { current: 1, total: 50 },
          totals: {
            merged: 0,
            needsHuman: 0,
            requeued: 0,
            running: 1,
            totalCostUsd: 99,
            perRole: { reviewer: { costUsd: 99, runs: 9 } },
          },
          issues: [],
          updatedAt: "2026-07-17T00:59:50.000Z",
        },
      ],
    };
    const vm = buildViewModel(snap, MULTI_NOW);
    // own host only — peer's reviewer/99 must not appear, total not summed
    expect(vm.totals.perRole!.map((r: any) => r.role)).toEqual(["implementer"]);
    expect(vm.totals.totalCostUsd).toBe(0.4);
  });

  it("backward-compat: a status without perRole/totalCostUsd omits both", () => {
    const snap = fixture("sample-status.json");
    const vm = buildViewModel(snap, Date.parse(snap.updatedAt));
    expect(vm.totals.perRole).toBeUndefined();
    expect(vm.totals.totalCostUsd).toBeUndefined();
    // existing four counters untouched
    expect(vm.totals).toEqual({
      merged: 3,
      needsHuman: 1,
      requeued: 0,
      running: 2,
    });
  });
});

describe("ROLE_ORDER drift-guard", () => {
  // The web view-model can't import the TS CostLedger module, so its ROLE_ORDER
  // is a hand-maintained MIRROR of CostLedger.ROLE_ORDER. This test enforces the
  // "drift-guard" comment on both copies: add a 9th role to one and forget the
  // other, and CI fails here instead of the web card silently mis-ordering it.
  it("web ROLE_ORDER exactly mirrors CostLedger.ROLE_ORDER (same roles, same order)", () => {
    expect(ROLE_ORDER).toEqual([...CostLedger.ROLE_ORDER]);
  });
});
