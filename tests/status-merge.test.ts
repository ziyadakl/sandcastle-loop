/**
 * Tests for `foldPeers` (`.sandcastle/lib/status/merge.ts`) — the pure fold of
 * peer snapshots into the local one for the cross-host unified viewer.
 *
 * Guards: peer projection shape, single-host byte-cleanliness (peers omitted),
 * host-tagged + deduped + sorted + capped merged history, and input immutability.
 */
import { describe, it, expect } from "vitest";
import {
  foldPeers,
  sumTotalsAcrossHosts,
  MAX_MERGED_HISTORY,
} from "../.sandcastle/lib/status/merge.js";
import {
  SandcastleStatusSchema,
  STATUS_SCHEMA_VERSION,
  type SandcastleStatus,
  type StatusHistoryEntry,
} from "../.sandcastle/lib/status/schema.js";

function historyEntry(
  overrides: Partial<StatusHistoryEntry> = {},
): StatusHistoryEntry {
  return {
    number: 1,
    title: "Some issue",
    branch: "sandcastle/some-branch",
    phase: "merged",
    completedAt: "2026-07-14T10:00:00.000Z",
    ...overrides,
  };
}

function makeStatus(
  overrides: Partial<SandcastleStatus> = {},
): SandcastleStatus {
  const base: SandcastleStatus = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    state: "running",
    run: {
      branch: "main",
      repo: "owner/repo",
      startedAt: "2026-07-14T09:00:00.000Z",
      iterations: { current: 2, total: 5 },
      maxConcurrent: 2,
    },
    totals: { merged: 1, needsHuman: 0, requeued: 0, running: 1 },
    issues: [
      {
        number: 10,
        title: "Live issue",
        branch: "sandcastle/live",
        phase: "implementer",
      },
    ],
    hostId: "host-a",
    runId: "run-xyz",
    updatedAt: "2026-07-14T10:30:00.000Z",
    activity: "planning",
    history: [
      historyEntry({ number: 1, completedAt: "2026-07-14T10:00:00.000Z" }),
      historyEntry({ number: 2, completedAt: "2026-07-14T10:10:00.000Z" }),
    ],
  };
  return { ...base, ...overrides };
}

describe("foldPeers", () => {
  it("fixtures are schema-valid", () => {
    expect(SandcastleStatusSchema.safeParse(makeStatus()).success).toBe(true);
  });

  it("folds ONE peer: projects it and merges both hosts' history tagged", () => {
    const own = makeStatus({ hostId: "host-a" });
    const peer = makeStatus({
      hostId: "host-b",
      runId: "run-xyz",
      state: "done",
      activity: "merging",
      run: {
        branch: "main",
        repo: "owner/repo",
        startedAt: "2026-07-14T08:00:00.000Z",
        iterations: { current: 4, total: 4 },
        maxConcurrent: 1,
      },
      totals: { merged: 3, needsHuman: 1, requeued: 0, running: 0 },
      issues: [
        {
          number: 20,
          title: "Peer issue",
          branch: "sandcastle/peer",
          phase: "reviewer",
        },
      ],
      updatedAt: "2026-07-14T10:20:00.000Z",
      history: [
        historyEntry({ number: 5, completedAt: "2026-07-14T09:50:00.000Z" }),
      ],
    });

    const result = foldPeers(own, [peer]);

    expect(result.peers).toHaveLength(1);
    expect(result.peers![0]).toEqual({
      hostId: "host-b",
      state: "done",
      activity: "merging",
      iterations: { current: 4, total: 4 },
      totals: { merged: 3, needsHuman: 1, requeued: 0, running: 0 },
      issues: [
        {
          number: 20,
          title: "Peer issue",
          branch: "sandcastle/peer",
          phase: "reviewer",
        },
      ],
      updatedAt: "2026-07-14T10:20:00.000Z",
    });

    // own's rows tagged host-a, peer's row tagged host-b
    const ownRows = result.history.filter((e) => e.hostId === "host-a");
    const peerRows = result.history.filter((e) => e.hostId === "host-b");
    expect(ownRows.map((e) => e.number).sort()).toEqual([1, 2]);
    expect(peerRows.map((e) => e.number)).toEqual([5]);

    // result is still schema-valid
    expect(SandcastleStatusSchema.safeParse(result).success).toBe(true);
  });

  it("empty peers => peers undefined, own history tagged, rest identical", () => {
    const own = makeStatus({ hostId: "host-a" });
    const result = foldPeers(own, []);

    expect(result.peers).toBeUndefined();
    expect(result.history.every((e) => e.hostId === "host-a")).toBe(true);

    // every other top-level field is identical to own
    expect(result.schemaVersion).toBe(own.schemaVersion);
    expect(result.state).toBe(own.state);
    expect(result.run).toEqual(own.run);
    expect(result.totals).toEqual(own.totals);
    expect(result.issues).toEqual(own.issues);
    expect(result.hostId).toBe(own.hostId);
    expect(result.runId).toBe(own.runId);
    expect(result.updatedAt).toBe(own.updatedAt);
    expect(result.activity).toBe(own.activity);
  });

  it("dedupes identical number+hostId+completedAt, sorts DESC, caps at limit", () => {
    // A peer already carrying a hostId-tagged row identical to one derived from own.
    const shared = historyEntry({
      number: 1,
      hostId: "host-a",
      completedAt: "2026-07-14T10:00:00.000Z",
    });
    const own = makeStatus({
      hostId: "host-a",
      history: [
        historyEntry({ number: 1, completedAt: "2026-07-14T10:00:00.000Z" }),
        historyEntry({ number: 2, completedAt: "2026-07-14T10:10:00.000Z" }),
      ],
    });
    const peer = makeStatus({
      hostId: "host-b",
      history: [shared], // hostId host-a, number 1, same completedAt → dup of own's row
    });

    const result = foldPeers(own, [peer]);
    // own has 2 rows; peer's one row is a dedupe of own's #1 → total 2, not 3
    expect(result.history).toHaveLength(2);

    // sorted DESC by completedAt
    const times = result.history.map((e) => e.completedAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(times[0]).toBe("2026-07-14T10:10:00.000Z");

    // cap: build inputs exceeding MAX_MERGED_HISTORY
    const many = Array.from({ length: MAX_MERGED_HISTORY + 20 }, (_, i) =>
      historyEntry({
        number: i + 1,
        completedAt: `2026-07-14T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    const bigOwn = makeStatus({ hostId: "host-a", history: many });
    const capped = foldPeers(bigOwn, []);
    expect(capped.history).toHaveLength(MAX_MERGED_HISTORY);
  });

  it("does not mutate own.history or peer objects", () => {
    const own = makeStatus({ hostId: "host-a" });
    const ownHistorySnapshot = JSON.parse(JSON.stringify(own.history));
    const ownHistoryRef = own.history;

    const peer = makeStatus({
      hostId: "host-b",
      history: [historyEntry({ number: 9 })],
    });
    const peerSnapshot = JSON.parse(JSON.stringify(peer));

    foldPeers(own, [peer]);

    expect(own.history).toBe(ownHistoryRef); // same array reference untouched
    expect(own.history).toEqual(ownHistorySnapshot); // contents unchanged
    expect(peer).toEqual(peerSnapshot); // peer object fully unchanged
  });
});

describe("sumTotalsAcrossHosts", () => {
  it("no peers => returns own totals unchanged (same reference)", () => {
    const own = makeStatus({
      totals: { merged: 2, needsHuman: 1, requeued: 0, running: 3 },
    });
    // foldPeers with no peers leaves top-level totals own-only and omits peers.
    const folded = foldPeers(own, []);
    expect(folded.peers).toBeUndefined();
    expect(sumTotalsAcrossHosts(folded)).toBe(folded.totals);
  });

  it("field-wise sums own + each peer's totals across every key", () => {
    const own = makeStatus({
      hostId: "host-a",
      totals: { merged: 2, needsHuman: 1, requeued: 0, running: 3 },
    });
    const peerA = makeStatus({
      hostId: "host-b",
      totals: { merged: 3, needsHuman: 0, requeued: 2, running: 1 },
    });
    const peerB = makeStatus({
      hostId: "host-c",
      totals: { merged: 5, needsHuman: 4, requeued: 1, running: 0 },
    });

    const fused = sumTotalsAcrossHosts(foldPeers(own, [peerA, peerB]));

    expect(fused).toEqual({
      merged: 2 + 3 + 5,
      needsHuman: 1 + 0 + 4,
      requeued: 0 + 2 + 1,
      running: 3 + 1 + 0,
    });
  });

  it("does not mutate own totals when peers are present", () => {
    const own = makeStatus({
      hostId: "host-a",
      totals: { merged: 2, needsHuman: 0, requeued: 0, running: 0 },
    });
    const peer = makeStatus({
      hostId: "host-b",
      totals: { merged: 3, needsHuman: 0, requeued: 0, running: 0 },
    });
    const folded = foldPeers(own, [peer]);
    const ownTotalsSnapshot = { ...folded.totals };

    sumTotalsAcrossHosts(folded);

    expect(folded.totals).toEqual(ownTotalsSnapshot); // top-level totals stays own-only
  });
});
