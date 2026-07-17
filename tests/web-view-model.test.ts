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
  STALE_AFTER_MS,
} from "../.sandcastle/web/view-model.js";

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
});
