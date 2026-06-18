/**
 * Tests for the status feed StatusStore (`.sandcastle/lib/status/store.ts`).
 *
 * Guards the load-bearing properties: every mutation yields a schema-valid
 * snapshot, writes go through the injected writeFn, and a write failure is
 * NON-FATAL (routed to onError, never thrown) so a disk hiccup can't kill an
 * overnight loop.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createStatusStore,
  type StatusStoreMeta,
} from "../.sandcastle/lib/status/store.js";
import {
  SandcastleStatusSchema,
  HEARTBEAT_MS,
} from "../.sandcastle/lib/status/schema.js";
import type { SandcastleStatus } from "../.sandcastle/lib/status/schema.js";

const FIXED_NOW = "2026-06-04T12:00:00.000Z";

function makeStore(overrides: Partial<{ writeFn: (p: string, c: string) => void; onError: (e: unknown) => void }> = {}) {
  const writes: Array<{ path: string; content: string }> = [];
  const writeFn = overrides.writeFn ?? ((path: string, content: string) => {
    writes.push({ path, content });
  });
  const meta: StatusStoreMeta = {
    branch: "sandcastle/run-jun4",
    repo: "affinity-tracker",
    repoRoot: "/tmp/sandcastle-test",
    startedAt: FIXED_NOW,
    iterationsTotal: 50,
    maxConcurrent: 2,
  };
  const store = createStatusStore(meta, {
    writeFn,
    onError: overrides.onError,
    now: () => FIXED_NOW,
  });
  return { store, writes };
}

describe("StatusStore", () => {
  it("produces a schema-valid snapshot through a full lifecycle", () => {
    const { store } = makeStore();
    store.startIteration(1);
    store.setPlan([
      { number: 337, title: "backfilled txns uncategorized", branch: "agent/issue-337" },
      { number: 339, title: "scope setUserEnabled to team", branch: "agent/issue-339" },
    ]);
    store.setIssuePhase(337, "implementer");
    store.setIssuePhase(339, "reviewer");
    store.recordOutcome(339, { status: "ok", finalMarker: "ALL_CLEAR" });
    store.recordOutcome(337, { status: "quarantined", finalMarker: "HAS_BLOCKERS" });

    const parsed = SandcastleStatusSchema.safeParse(store.snapshot());
    expect(parsed.success).toBe(true);
  });

  it("writes the whole object on every mutation via the injected writeFn", () => {
    const { store, writes } = makeStore();
    store.startIteration(1);
    store.setPlan([{ number: 337, title: "t", branch: "agent/issue-337" }]);

    expect(writes).toHaveLength(2);
    expect(writes[0]!.path).toBe("/tmp/sandcastle-test/.sandcastle/status.json");
    // Each write is the full serialized object, not a slice.
    const last = JSON.parse(writes[1]!.content);
    expect(last.run.iterations.current).toBe(1);
    expect(last.issues).toHaveLength(1);
    expect(last.issues[0].phase).toBe("planned");
    expect(last.updatedAt).toBe(FIXED_NOW);
  });

  it("derives totals: merged / needsHuman / requeued / running", () => {
    const { store } = makeStore();
    store.setPlan([
      { number: 1, title: "a", branch: "b1" },
      { number: 2, title: "b", branch: "b2" },
      { number: 3, title: "c", branch: "b3" },
    ]);
    store.setIssuePhase(1, "implementer"); // active
    store.recordOutcome(2, { status: "ok" }); // merged
    store.recordOutcome(3, { status: "deferred" }); // requeued

    const s = store.snapshot();
    expect(s.totals.merged).toBe(1);
    expect(s.totals.requeued).toBe(1);
    expect(s.totals.needsHuman).toBe(0);
    expect(s.totals.running).toBe(1); // only #1 still active
    expect(s.issues.find((i) => i.number === 2)!.phase).toBe("merged");
    expect(s.issues.find((i) => i.number === 3)!.phase).toBe("deferred");
  });

  it("flags attention on needs-human outcomes", () => {
    const { store } = makeStore();
    store.setPlan([{ number: 9, title: "x", branch: "b" }]);
    store.recordOutcome(9, { status: "error" });
    const issue = store.snapshot().issues.find((i) => i.number === 9)!;
    expect(issue.phase).toBe("needs-human");
    expect(issue.attention).toBe(true);
    expect(store.snapshot().totals.needsHuman).toBe(1);
  });

  it("is NON-FATAL: a throwing writeFn does not throw and calls onError", () => {
    const onError = vi.fn();
    const { store } = makeStore({
      writeFn: () => {
        throw new Error("ENOSPC");
      },
      onError,
    });
    expect(() => store.startIteration(1)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe("ENOSPC");
  });

  it("startHeartbeat re-stamps updatedAt on the injected timer at HEARTBEAT_MS; finish stops it", () => {
    let captured: (() => void) | undefined;
    let capturedMs = 0;
    let cleared = false;
    const handle = { id: "hb" };
    const times = ["t0", "t1", "t2"];
    let i = 0;
    const writes: string[] = [];
    const store = createStatusStore(
      {
        branch: "b",
        repo: "r",
        repoRoot: "/tmp/x",
        startedAt: "t0",
        iterationsTotal: 1,
        maxConcurrent: 1,
      },
      {
        writeFn: (_p, c) => writes.push(c),
        now: () => times[Math.min(i++, times.length - 1)]!, // t0 (ctor), then t1, t2…
        setIntervalFn: (fn, ms) => {
          captured = fn;
          capturedMs = ms;
          return handle;
        },
        clearIntervalFn: (h) => {
          cleared = h === handle;
        },
      },
    );

    store.startHeartbeat();
    expect(capturedMs).toBe(HEARTBEAT_MS);
    expect(captured).toBeTypeOf("function");
    // startHeartbeat is idempotent — a second call must not re-register.
    store.startHeartbeat();

    // Firing the timer writes a fresh snapshot with a NEW updatedAt, no phase change.
    const before = writes.length;
    captured!();
    expect(writes.length).toBe(before + 1);
    expect(JSON.parse(writes.at(-1)!).updatedAt).toBe("t1");

    store.finish("done");
    expect(cleared).toBe(true);
  });

  it("finish() sets distinct terminal run states (done vs restarting)", () => {
    const a = makeStore();
    a.store.finish("done");
    expect(a.store.snapshot().state).toBe("done");

    const b = makeStore();
    b.store.finish("restarting");
    expect(b.store.snapshot().state).toBe("restarting");
  });

  it("setActivity writes the run-level activity into the serialized snapshot", () => {
    const { store, writes } = makeStore();
    store.setActivity("merging");

    expect(JSON.parse(writes.at(-1)!.content).activity).toBe("merging");
    expect(store.snapshot().activity).toBe("merging");
    // Still a valid snapshot with the new optional field present.
    expect(SandcastleStatusSchema.safeParse(store.snapshot()).success).toBe(true);
  });

  it("setActivity(null) clears the field (dropped from JSON entirely)", () => {
    const { store, writes } = makeStore();
    store.setActivity("planning");
    store.setActivity(null);

    const last = JSON.parse(writes.at(-1)!.content);
    expect("activity" in last).toBe(false);
    expect(store.snapshot().activity).toBeUndefined();
  });

  it("finish() clears any lingering activity so a finished run shows none", () => {
    const { store } = makeStore();
    store.setActivity("cleanup");
    store.finish("done");
    expect(store.snapshot().activity).toBeUndefined();
  });

  // --- history persistence tests ---

  it("history accumulates terminal outcomes across multiple issues", () => {
    const { store } = makeStore();
    store.setPlan([
      { number: 10, title: "add feature A", branch: "agent/issue-10" },
      { number: 11, title: "fix bug B", branch: "agent/issue-11" },
    ]);
    store.recordOutcome(10, { status: "ok" });
    store.recordOutcome(11, { status: "deferred" });

    const snap = store.snapshot();
    expect(snap.history).toHaveLength(2);

    const entry10 = snap.history.find((e) => e.number === 10)!;
    expect(entry10.number).toBe(10);
    expect(entry10.title).toBe("add feature A");
    expect(entry10.branch).toBe("agent/issue-10");
    expect(entry10.phase).toBe("merged");
    expect(typeof entry10.completedAt).toBe("string");

    const entry11 = snap.history.find((e) => e.number === 11)!;
    expect(entry11.number).toBe(11);
    expect(entry11.phase).toBe("deferred");
    expect(typeof entry11.completedAt).toBe("string");
  });

  it("history survives a re-plan: issues overwritten, history preserved", () => {
    const { store } = makeStore();
    store.setPlan([{ number: 20, title: "initial issue", branch: "agent/issue-20" }]);
    store.recordOutcome(20, { status: "ok" });

    // history has 1 entry after first batch
    expect(store.snapshot().history).toHaveLength(1);

    // re-plan with a fresh batch
    store.setPlan([
      { number: 30, title: "new issue A", branch: "agent/issue-30" },
      { number: 31, title: "new issue B", branch: "agent/issue-31" },
    ]);

    const snap = store.snapshot();
    // history still has the old entry — not cleared
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0]!.number).toBe(20);

    // issues reflects the NEW batch only
    expect(snap.issues).toHaveLength(2);
    expect(snap.issues.map((i) => i.number).sort()).toEqual([30, 31]);
  });

  it("backward compat: v1 file without history field still parses and defaults to []", () => {
    const { store } = makeStore();
    store.setPlan([{ number: 5, title: "t", branch: "b" }]);
    const snap = store.snapshot() as Record<string, unknown>;

    // Simulate an old v1 snapshot that pre-dates the history field
    delete snap["history"];
    expect("history" in snap).toBe(false);

    const result = SandcastleStatusSchema.safeParse(snap);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.history).toEqual([]);
    }
  });

  it("schema stays valid through a full lifecycle WITH history; schemaVersion is still 1", () => {
    const { store } = makeStore();
    store.startIteration(1);
    store.setPlan([
      { number: 337, title: "backfilled txns uncategorized", branch: "agent/issue-337" },
      { number: 339, title: "scope setUserEnabled to team", branch: "agent/issue-339" },
    ]);
    store.setIssuePhase(337, "implementer");
    store.setIssuePhase(339, "reviewer");
    store.recordOutcome(339, { status: "ok", finalMarker: "ALL_CLEAR" });
    store.recordOutcome(337, { status: "quarantined", finalMarker: "HAS_BLOCKERS" });

    const snap = store.snapshot();
    const parsed = SandcastleStatusSchema.safeParse(snap);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schemaVersion).toBe(1);
      // Both issues got outcomes, so history should have 2 entries
      expect(parsed.data.history).toHaveLength(2);
    }
  });

  it("re-recording the same issue across iterations appends a second history row (NO dedup); per-phase counts mirror totals", () => {
    // INTENT LOCK: history is a log of terminal OUTCOMES, not a set of issues.
    // An issue deferred (requeued) then later merged legitimately produces two
    // rows — one per totals increment. Deduping on issue number would orphan a
    // pill's count (e.g. requeued=1 with an empty drill-down). Do NOT "tidy"
    // this into a dedup: that breaks the history<->totals correspondence.
    const { store } = makeStore();
    store.setPlan([{ number: 40, title: "flaky", branch: "agent/issue-40" }]);
    store.recordOutcome(40, { status: "deferred" }); // requeued in iteration 1
    // re-plan the same issue (fresh planned entry) and merge it in iteration 2
    store.setPlan([{ number: 40, title: "flaky", branch: "agent/issue-40" }]);
    store.recordOutcome(40, { status: "ok" }); // merged in iteration 2

    const s = store.snapshot();
    expect(s.history).toHaveLength(2);
    expect(s.history.map((e) => e.phase)).toEqual(["deferred", "merged"]);
    // Each pill's count equals the number of history rows for that phase.
    expect(s.history.filter((e) => e.phase === "deferred")).toHaveLength(s.totals.requeued);
    expect(s.history.filter((e) => e.phase === "merged")).toHaveLength(s.totals.merged);
  });
});
