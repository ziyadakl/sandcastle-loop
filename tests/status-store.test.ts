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
});
