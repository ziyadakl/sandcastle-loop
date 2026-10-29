import { describe, expect, it } from "vitest";

import type {
  IssueTelemetryRow,
  RunIdentity,
  RunTelemetry,
  SandcastleStatus,
} from "./schema.js";
import type { StatusStoreMeta, StatusStoreOpts } from "./store.js";
import { SandcastleStatusSchema } from "./schema.js";
import { createStatusStore } from "./store.js";

// ---------------------------------------------------------------------------
// `store.ts` is the ONLY writer of `.sandcastle/status.json`. These tests cover
// the telemetry mutators (`recordIssueTelemetry` / `recordRunTelemetry` /
// `recordRunIdentity`) against the four properties that keep an overnight run
// alive and its feed readable:
//
//   1. ABSENT WHEN NEVER CALLED — an untouched telemetry key must not
//      materialize as `null`/`[]`/`{}`; absent and empty mean different things
//      to consumers (store.ts:145-151).
//   2. SCHEMA ROUND-TRIP — what we write must survive `SandcastleStatusSchema`
//      UNCHANGED. `z.object` strips unknown keys and still reports `success`,
//      so `.success` alone proves nothing: the deep-equal of parsed-vs-raw is
//      the real tripwire for a write shape the frozen schema doesn't declare.
//   3. SYNCHRONICITY — the write must land BEFORE the mutator returns
//      (store.ts:7-13). An async mutator reintroduces the torn-write race.
//   4. NEVER-THROW — `commit()` routes write failures to `onError` and never
//      throws (store.ts:328-332). A telemetry exception must not kill a run.
//
// Every test injects `writeFn` so the live `status.json` is never touched.
// ---------------------------------------------------------------------------

const META: StatusStoreMeta = {
  branch: "feat/x",
  repo: "r",
  repoRoot: "/nowhere",
  startedAt: "2026-08-01T00:00:00.000Z",
  iterationsTotal: 10,
  maxConcurrent: 2,
  hostId: "test-host",
  runId: "run-1",
};

/** Peer snapshot fixture (fold input). Mirrors `push.test.mts`'s `snap()`. */
function snap(over: Partial<SandcastleStatus> = {}): SandcastleStatus {
  return {
    schemaVersion: 3,
    state: "running",
    hostId: "peer-host",
    runId: "run-1",
    run: {
      branch: "b",
      repo: "r",
      startedAt: "2026-08-01T00:00:00.000Z",
      iterations: { current: 1, total: 10 },
      maxConcurrent: 1,
      tickets: { done: 1, working: 0, waiting: 0, cap: 10 },
    },
    totals: { merged: 1, needsHuman: 0, requeued: 0, running: 0 },
    issues: [],
    history: [],
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  } as SandcastleStatus;
}

/** Store wired to a recording in-memory writer. Never touches disk. */
function makeStore(over: Partial<StatusStoreOpts> = {}) {
  const writes: string[] = [];
  let clock = 1_000;
  const store = createStatusStore(META, {
    path: "/nowhere/status.json",
    pid: 4242,
    writeFn: (_p, content): void => {
      writes.push(content);
    },
    now: (): string => new Date(clock).toISOString(),
    ...over,
  });
  return {
    store,
    writes,
    tick: (ms = 1_000): void => {
      clock += ms;
    },
    /** The most recently written file, parsed. */
    last: (): SandcastleStatus =>
      JSON.parse(writes[writes.length - 1] ?? "{}") as SandcastleStatus,
  };
}

// A MAXIMAL row: every declared field populated. A minimal row would pass the
// round-trip trivially and prove nothing about the fields that actually carry
// the telemetry.
const ROW: IssueTelemetryRow = {
  issue: 42,
  title: "Add telemetry",
  type: "type:feature",
  costUsd: 1.25,
  wallMs: 90_000,
  tokens: { input: 100, output: 20, cacheWrite: 5, cacheRead: 300 },
  perRole: {
    implementer: {
      costUsd: 1.0,
      wallMs: 60_000,
      tokens: { input: 80, output: 15, cacheWrite: 5, cacheRead: 200 },
      runs: 2,
    },
    reviewer: { costUsd: null, wallMs: 30_000, runs: 1 },
  },
  implementerAttempts: 2,
  reviewerBlockers: 1,
  critiqueRetries: 0,
  deferrals: 0,
  reviewerEscalated: true,
  reviewerEscalationModel: "claude-opus-5",
  changedLines: 210,
  changedFiles: 3,
  shipPath: "implementer-retry",
  outcome: "ok",
  recovery: false,
  quarantined: false,
};

const IDENTITY: RunIdentity = {
  profile: "budget",
  backend: "claude",
  provider: "kimi",
  roleModels: {
    implementer: { default: "sonnet-4.7", escalations: ["opus-5"] },
    reviewer: { default: "sonnet-4.7", escalations: [] },
  },
  promptHashes: { "implement-prompt.md": "a1b2c3d4" },
};

const RUN_TELEMETRY: RunTelemetry = {
  counters: {
    reviewerBlockers: 3,
    implementerRetries: 2,
    critiqueFails: 1,
    recoveries: 0,
    quarantines: 1,
    deferrals: 2,
    skillDisciplineMisses: { implementer: 1 },
  },
  errorClasses: { transient: 4, stalled: 1, noVerdict: 0, outputCap: 9 },
  tokenEfficiency: {
    implementer: {
      input: 100,
      output: 20,
      cacheWrite: 5,
      cacheRead: 300,
      cacheHitRatio: 0.75,
    },
    // The all-zero role: `cacheRead/(cacheRead+input)` is NaN, which `z.number()`
    // rejects — producers must emit `null`, and the schema must accept it.
    merger: {
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      cacheHitRatio: null,
    },
  },
  overheadCostUsd: 0.42,
};

describe("telemetry mutators — absent when never called", () => {
  it("omits both telemetry keys from a snapshot that never records them", () => {
    const { store, last } = makeStore();
    store.setActivity("planning");
    const written = last();
    expect(written).not.toHaveProperty("issueTelemetry");
    expect(written).not.toHaveProperty("runTelemetry");
    expect(store.snapshot()).not.toHaveProperty("issueTelemetry");
    expect(store.snapshot()).not.toHaveProperty("runTelemetry");
  });

  it("still parses against the frozen schema with no telemetry at all", () => {
    const { store, last } = makeStore();
    store.setActivity("planning");
    expect(SandcastleStatusSchema.safeParse(last()).success).toBe(true);
  });
});

describe("recordIssueTelemetry", () => {
  it("writes the rows at the TOP LEVEL (not under totals) and commits once", () => {
    const { store, writes, last } = makeStore();
    const before = writes.length;
    store.recordIssueTelemetry([ROW]);
    expect(writes.length).toBe(before + 1);
    expect(last().issueTelemetry).toEqual([ROW]);
    expect(last().totals).not.toHaveProperty("issueTelemetry");
  });

  it("replaces wholesale on a second call (rows are a full re-statement)", () => {
    const { store, last } = makeStore();
    store.recordIssueTelemetry([ROW]);
    store.recordIssueTelemetry([{ ...ROW, issue: 43 }]);
    expect(last().issueTelemetry).toHaveLength(1);
    expect(last().issueTelemetry?.[0]?.issue).toBe(43);
  });

  it("records an explicit empty array as an empty array, not as absent", () => {
    const { store, last } = makeStore();
    store.recordIssueTelemetry([]);
    expect(last()).toHaveProperty("issueTelemetry");
    expect(last().issueTelemetry).toEqual([]);
  });
});

describe("recordRunTelemetry / recordRunIdentity", () => {
  it("MERGES rather than replaces — identity first, then a patch", () => {
    const { store, last } = makeStore();
    store.recordRunIdentity(IDENTITY);
    store.recordRunTelemetry(RUN_TELEMETRY);
    expect(last().runTelemetry?.identity).toEqual(IDENTITY);
    expect(last().runTelemetry?.counters).toEqual(RUN_TELEMETRY.counters);
    expect(last().runTelemetry?.overheadCostUsd).toBe(0.42);
  });

  it("MERGES in the other order too — a patch first, then identity", () => {
    const { store, last } = makeStore();
    store.recordRunTelemetry(RUN_TELEMETRY);
    store.recordRunIdentity(IDENTITY);
    expect(last().runTelemetry?.identity).toEqual(IDENTITY);
    expect(last().runTelemetry?.counters).toEqual(RUN_TELEMETRY.counters);
    expect(last().runTelemetry?.errorClasses).toEqual(
      RUN_TELEMETRY.errorClasses,
    );
  });

  it("merges SHALLOWLY — a second patch replaces a member wholesale", () => {
    const { store, last } = makeStore();
    store.recordRunTelemetry({ counters: { reviewerBlockers: 3 } });
    store.recordRunTelemetry({ counters: { deferrals: 1 } });
    expect(last().runTelemetry?.counters).toEqual({ deferrals: 1 });
  });

  it("creates the object on a first patch when nothing exists yet", () => {
    const { store, last } = makeStore();
    store.recordRunTelemetry({ overheadCostUsd: null });
    expect(last().runTelemetry).toEqual({ overheadCostUsd: null });
  });
});

describe("setPlan — merge-by-number for the rolling refill pool (#902)", () => {
  it("appends unknown numbers, resets a re-dealt known number to planned, and derives the tickets tally", () => {
    const { store, last } = makeStore();
    store.setPlan([
      { number: 1, title: "one", branch: "agent/issue-1" },
      { number: 2, title: "two", branch: "agent/issue-2" },
    ]);
    store.setIssuePhase(1, "implementer");
    // A re-plan: #3 is new, #1 and #2 are NOT re-offered — they must survive
    // untouched (this is a MERGE, not a wholesale replace, which would erase
    // #1's in-flight phase the instant the pool refills).
    store.setPlan([{ number: 3, title: "three", branch: "agent/issue-3" }]);

    const raw = last();
    expect(raw.issues.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(raw.issues.find((i) => i.number === 1)?.phase).toBe("implementer");
    expect(raw.issues.find((i) => i.number === 2)?.phase).toBe("planned");
    expect(raw.issues.find((i) => i.number === 3)?.phase).toBe("planned");
    // META.iterationsTotal is 10 — the tally's `cap` for now.
    expect(raw.run.tickets).toEqual({ done: 0, working: 1, waiting: 2, cap: 10 });
  });

  it("resets a RE-DEALT known number back to planned, dropping its old detail, for a non-terminal phase", () => {
    const { store, last } = makeStore();
    store.setPlan([{ number: 1, title: "one", branch: "agent/issue-1" }]);
    store.setIssuePhase(1, "deferred", "requeued after a transient blocker");

    // The dealer re-offers #1 (a deferred ticket IS meant to be picked back
    // up by a later plan call — see SKIP_REPLAN_PHASES's doc comment) with a
    // refreshed title/branch — it must come back as a fresh planned card.
    store.setPlan([
      { number: 1, title: "one (redealt)", branch: "agent/issue-1-v2" },
    ]);

    const issue = last().issues.find((i) => i.number === 1);
    expect(issue?.phase).toBe("planned");
    expect(issue?.title).toBe("one (redealt)");
    expect(issue?.branch).toBe("agent/issue-1-v2");
    expect(issue?.detail).toBeUndefined();
    expect(issue?.attention).toBeUndefined();
  });

  it("does NOT reset a merged or needs-human row — a shipped/quarantined ticket must never fall back to waiting (#902 D3)", () => {
    const { store, last } = makeStore();
    store.setPlan([
      { number: 1, title: "shipped", branch: "agent/issue-1" },
      { number: 2, title: "quarantined", branch: "agent/issue-2" },
    ]);
    store.recordOutcome(1, { status: "ok" }); // → merged
    store.setIssuePhase(2, "needs-human", "blocked on #99"); // → needs-human, attention

    // A stale ranked stack, or a planner that hasn't yet learned #1/#2 are
    // done, re-offers both numbers. Neither may be reset to planned.
    store.setPlan([
      { number: 1, title: "shipped (stale re-offer)", branch: "agent/issue-1-v2" },
      { number: 2, title: "quarantined (stale re-offer)", branch: "agent/issue-2-v2" },
    ]);

    const raw = last();
    const merged = raw.issues.find((i) => i.number === 1);
    const needsHuman = raw.issues.find((i) => i.number === 2);
    expect(merged?.phase).toBe("merged");
    expect(merged?.title).toBe("shipped"); // untouched, not overwritten by the stale re-offer
    expect(needsHuman?.phase).toBe("needs-human");
    expect(needsHuman?.attention).toBe(true);
    expect(needsHuman?.detail).toBe("blocked on #99");
    // The tally must not count either as waiting.
    expect(raw.run.tickets).toEqual({ done: 2, working: 0, waiting: 0, cap: 10 });
  });

  it("counts a merged/needs-human/deferred issue as done, not waiting or working", () => {
    const { store, last } = makeStore();
    store.setPlan([
      { number: 1, title: "a", branch: "b1" },
      { number: 2, title: "b", branch: "b2" },
      { number: 3, title: "c", branch: "b3" },
    ]);
    store.recordOutcome(1, { status: "ok" }); // → merged
    store.setIssuePhase(2, "reviewer"); // → working
    // #3 stays planned → waiting.
    expect(last().run.tickets).toEqual({ done: 1, working: 1, waiting: 1, cap: 10 });
  });

  // #1191 finding F: check-writer, judge, and needs-rerun were all bucketed
  // as `done` (everything not `planned` and not in the old `ACTIVE_PHASES`
  // set) — wrong, since all three are still being worked (check-writer/judge
  // run before the builder ever starts; needs-rerun auto-requeues rather
  // than terminating). Each gets its own case so a future phase added to
  // `WORKING_PHASES` without a matching case here can't silently regress.
  it.each([
    ["check-writer" as const],
    ["judge" as const],
    ["needs-rerun" as const],
  ])("counts a %s issue as working, not done", (phase) => {
    const { store, last } = makeStore();
    store.setPlan([{ number: 1, title: "a", branch: "b1" }]);
    store.setIssuePhase(1, phase);
    expect(last().run.tickets).toEqual({
      done: 0,
      working: 1,
      waiting: 0,
      cap: 10,
    });
  });
});

describe("schema round-trip (the cross-agent tripwire)", () => {
  it("survives SandcastleStatusSchema UNCHANGED — no field is stripped", () => {
    const { store, last } = makeStore();
    store.setPlan([{ number: 42, title: "Add telemetry", branch: "b" }]);
    store.recordIssueTelemetry([ROW]);
    store.recordRunIdentity(IDENTITY);
    store.recordRunTelemetry(RUN_TELEMETRY);

    const raw = last();
    const parsed = SandcastleStatusSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    // `.success` alone is blind: `z.object` STRIPS undeclared keys and still
    // succeeds. Deep-equal of parsed-vs-raw is what catches a shape the frozen
    // schema does not declare.
    expect(parsed.data?.issueTelemetry).toEqual(raw.issueTelemetry);
    expect(parsed.data?.runTelemetry).toEqual(raw.runTelemetry);
  });

  it("keeps a null cacheHitRatio and a null costUsd (null ≠ 0)", () => {
    const { store, last } = makeStore();
    store.recordIssueTelemetry([{ ...ROW, costUsd: null }]);
    store.recordRunTelemetry(RUN_TELEMETRY);
    const raw = last();
    const parsed = SandcastleStatusSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.issueTelemetry?.[0]?.costUsd).toBeNull();
    expect(parsed.data?.runTelemetry?.tokenEfficiency?.merger?.cacheHitRatio)
      .toBeNull();
  });
});

describe("synchronicity (race-safety invariant)", () => {
  it("writes BEFORE the mutator returns, in the same tick", () => {
    const order: string[] = [];
    const store = createStatusStore(META, {
      path: "/nowhere/status.json",
      pid: 4242,
      writeFn: (): void => {
        order.push("write");
      },
      now: (): string => "2026-08-01T00:00:00.000Z",
    });

    store.recordIssueTelemetry([ROW]);
    order.push("returned:issue");
    store.recordRunTelemetry(RUN_TELEMETRY);
    order.push("returned:run");
    store.recordRunIdentity(IDENTITY);
    order.push("returned:identity");

    expect(order).toEqual([
      "write",
      "returned:issue",
      "write",
      "returned:run",
      "write",
      "returned:identity",
    ]);
  });

  it("returns void, not a promise (an async mutator would tear the write)", () => {
    const { store } = makeStore();
    expect(store.recordIssueTelemetry([ROW])).toBeUndefined();
    expect(store.recordRunTelemetry(RUN_TELEMETRY)).toBeUndefined();
    expect(store.recordRunIdentity(IDENTITY)).toBeUndefined();
  });
});

describe("never-throw (a telemetry hiccup must not kill an overnight run)", () => {
  it("routes a write failure to onError and returns normally", () => {
    const errors: unknown[] = [];
    const store = createStatusStore(META, {
      path: "/nowhere/status.json",
      pid: 4242,
      writeFn: (): never => {
        throw new Error("ENOSPC");
      },
      onError: (err): void => {
        errors.push(err);
      },
      now: (): string => "2026-08-01T00:00:00.000Z",
    });

    expect(() => store.recordIssueTelemetry([ROW])).not.toThrow();
    expect(() => store.recordRunTelemetry(RUN_TELEMETRY)).not.toThrow();
    expect(() => store.recordRunIdentity(IDENTITY)).not.toThrow();
    expect(errors).toHaveLength(3);

    // The in-memory object still holds the telemetry — only the IO failed.
    expect(store.snapshot().issueTelemetry).toEqual([ROW]);
    expect(store.snapshot().runTelemetry?.identity).toEqual(IDENTITY);
  });
});

describe("foldPeers round-trip preserves the new top-level keys", () => {
  it("keeps issueTelemetry + runTelemetry intact when peers are present", () => {
    const { store, last } = makeStore();
    store.recordIssueTelemetry([ROW]);
    store.recordRunIdentity(IDENTITY);
    store.recordRunTelemetry(RUN_TELEMETRY);
    store.setPeers([snap()]);

    const raw = last();
    expect(raw.peers).toHaveLength(1); // the fold really happened
    expect(raw.issueTelemetry).toEqual([ROW]);
    expect(raw.runTelemetry?.identity).toEqual(IDENTITY);
    expect(raw.runTelemetry?.counters).toEqual(RUN_TELEMETRY.counters);
    // NOTE: `totals` is deliberately NOT asserted here — `sumTotalsAcrossHosts`
    // hardcodes four integer adds, which is exactly why these keys are
    // top-level rather than under `totals`.
    expect(SandcastleStatusSchema.safeParse(raw).success).toBe(true);
  });

  it("projects a peer's run.tickets onto its PeerStatus entry (#902 D2)", () => {
    const { store, last } = makeStore();
    store.setPeers([snap()]); // snap()'s run.tickets: {done:1, working:0, waiting:0, cap:10}
    const raw = last();
    expect(raw.peers).toHaveLength(1);
    expect(raw.peers?.[0]?.tickets).toEqual({
      done: 1,
      working: 0,
      waiting: 0,
      cap: 10,
    });
    expect(SandcastleStatusSchema.safeParse(raw).success).toBe(true);
  });
});

describe("backward compatibility with the existing mutators", () => {
  it("leaves recordCost / recordRoleBreakdown / recordModelBreakdown alone", () => {
    const { store, last } = makeStore();
    store.recordCost(12.5);
    store.recordRoleBreakdown({ implementer: { costUsd: 12.5, tokens: 100 } });
    store.recordModelBreakdown([
      { role: "implementer", model: "sonnet-4.7", costUsd: 12.5, calls: 2 },
    ]);
    const raw = last();
    expect(raw.totals.totalCostUsd).toBe(12.5);
    expect(raw.totals.perRole).toEqual({
      implementer: { costUsd: 12.5, tokens: 100 },
    });
    expect(raw.totals.perModel).toHaveLength(1);
    expect(raw).not.toHaveProperty("issueTelemetry");
    expect(raw).not.toHaveProperty("runTelemetry");
    expect(SandcastleStatusSchema.safeParse(raw).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `lastProgressAt` (Stream 3): the "work advancing" clock, separate from
// `updatedAt` ("process alive"). The stall watchdog reads ONLY this field, so
// the load-bearing property is that the keep-alive heartbeat must NOT bump it
// while a genuine mutator MUST. If the heartbeat ever bumped it, a wedged loop
// would look like it was making progress forever — the exact 6.5h freeze this
// exists to catch.
// ---------------------------------------------------------------------------
describe("lastProgressAt — genuine progress vs keep-alive", () => {
  it("seeds lastProgressAt at construction; a NON-progress commit preserves it", () => {
    const { store, last, tick } = makeStore(); // constructed at clock = 1000
    tick(5000); // clock = 6000
    // recordCost is telemetry, NOT genuine progress — it uses a plain commit().
    store.recordCost(1.23);
    const s = last();
    expect(s.updatedAt).toBe(new Date(6000).toISOString());
    // Unchanged from the construction seed, proving the seed AND that a
    // non-progress commit never touches the progress clock.
    expect(s.lastProgressAt).toBe(new Date(1000).toISOString());
  });

  it("the keep-alive commit() bumps updatedAt but NOT lastProgressAt", () => {
    let heartbeat: (() => void) | undefined;
    const { store, last, tick } = makeStore({
      setIntervalFn: (fn): unknown => {
        heartbeat = fn as () => void;
        return 1;
      },
      clearIntervalFn: (): void => {},
    });
    store.setActivity("planning"); // genuine progress at clock = 1000
    const afterProgress = last();
    expect(afterProgress.lastProgressAt).toBe(afterProgress.updatedAt);

    store.startHeartbeat();
    tick(5000); // clock = 6000
    expect(heartbeat).toBeDefined();
    heartbeat!(); // keep-alive fires

    const afterBeat = last();
    // updatedAt advanced (process still alive) ...
    expect(afterBeat.updatedAt).toBe(new Date(6000).toISOString());
    expect(afterBeat.updatedAt).not.toBe(afterProgress.updatedAt);
    // ... but lastProgressAt is frozen at the last real transition.
    expect(afterBeat.lastProgressAt).toBe(afterProgress.lastProgressAt);
  });

  it("a genuine-progress mutator bumps BOTH clocks together", () => {
    const { store, last, tick } = makeStore();
    store.setActivity("planning"); // clock = 1000
    const first = last();
    tick(1000); // clock = 2000
    store.setActivity("planning"); // genuine progress
    const second = last();
    expect(second.updatedAt).toBe(new Date(2000).toISOString());
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(second.lastProgressAt).toBe(second.updatedAt);
    expect(second.lastProgressAt).not.toBe(first.lastProgressAt);
  });

  it("setIssuePhase and recordOutcome both advance the progress clock", () => {
    const { store, last, tick } = makeStore();
    store.setPlan([{ number: 7, title: "t", branch: "b" }]); // clock 1000
    tick(1000);
    store.setIssuePhase(7, "implementer"); // clock 2000
    expect(last().lastProgressAt).toBe(new Date(2000).toISOString());
    tick(1000);
    store.recordOutcome(7, { status: "ok" }); // clock 3000
    expect(last().lastProgressAt).toBe(new Date(3000).toISOString());
  });

  it("still parses against the frozen schema with the new field present", () => {
    const { store, last } = makeStore();
    store.setActivity("planning");
    const raw = last();
    expect(raw.lastProgressAt).toBeDefined();
    expect(SandcastleStatusSchema.safeParse(raw).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `noteProgress()` (stall-watchdog false-kill fix): a long CROSS-ISSUE step
// ("reviewing" = post-merge review + fixer ladder; "merging" = merger
// escalation) runs SEVERAL ceiling-bounded agent dispatches back-to-back under
// a SINGLE `setActivity(...)` bump. `setActivity` bumps the progress clock only
// ONCE, so two 60-min dispatches froze `lastProgressAt` for 120 min and the
// 90-min stall watchdog SIGKILLed a HEALTHY loop. `noteProgress()` is called on
// each bounded sub-step's completion (the merger / post-merge-reviewer /
// post-merge-fixer dispatch sites in main.mts) to keep the clock fresh WITHOUT
// masking a real hang — it fires only AFTER a `withHardCeiling`-bounded dispatch
// settles, never on a bare timer.
// ---------------------------------------------------------------------------
describe("noteProgress — keeps a long cross-issue step from being false-killed", () => {
  const STALL_LIMIT_MS = 90 * 60 * 1000; // scripts/stall-watchdog.mts DEFAULT_STALL_LIMIT_MS
  const CEILING_MS = 60 * 60 * 1000; // hardCeilingSec default (3600s)

  it("bumps lastProgressAt on each bounded sub-step so a >90-min step stays fresh", () => {
    const { store, last, tick } = makeStore();
    // The "reviewing" step begins: setActivity bumps the progress clock ONCE.
    store.setActivity("reviewing");
    const bumps = [Date.parse(last().lastProgressAt!)];
    // Three back-to-back ceiling-bounded dispatches (first review, fixer,
    // re-review) — 180 min total, TWICE the 90-min stall limit. Each calls
    // noteProgress on completion, exactly as the merger/reviewer/fixer sites do.
    for (let i = 0; i < 3; i++) {
      tick(CEILING_MS);
      store.noteProgress();
      bumps.push(Date.parse(last().lastProgressAt!));
    }
    const span = bumps[bumps.length - 1]! - bumps[0]!;
    expect(span).toBe(3 * CEILING_MS); // 180 min, well beyond the 90-min limit
    // Yet the watchdog's `now - lastProgressAt` can never cross the limit: the
    // gap between consecutive progress bumps is one ceiling-bounded sub-step.
    for (let i = 1; i < bumps.length; i++) {
      expect(bumps[i]! - bumps[i - 1]!).toBeLessThan(STALL_LIMIT_MS);
    }
    // The clock ends at the latest sub-step, not frozen at the setActivity time.
    expect(last().lastProgressAt).toBe(last().updatedAt);
  });

  it("WITHOUT it, a two-dispatch step goes stale past the limit (the bug it fixes)", () => {
    let heartbeat: (() => void) | undefined;
    const { store, last, tick } = makeStore({
      setIntervalFn: (fn): unknown => {
        heartbeat = fn as () => void;
        return 1;
      },
      clearIntervalFn: (): void => {},
    });
    store.setActivity("reviewing"); // the ONLY progress bump in this step
    store.startHeartbeat();
    const progressAt = Date.parse(last().lastProgressAt!);
    // Two 60-min bounded dispatches with only keep-alive beats between them —
    // the pre-fix behaviour, where nothing bumped lastProgressAt for 120 min.
    tick(2 * CEILING_MS);
    heartbeat!();
    const s = last();
    // The process looks alive (updatedAt fresh) but the progress clock is frozen
    // at the setActivity time ...
    expect(Date.parse(s.lastProgressAt!)).toBe(progressAt);
    // ... 120 min stale — past the 90-min limit, i.e. the false kill of healthy
    // work that calling noteProgress on each sub-step prevents.
    expect(
      Date.parse(s.updatedAt) - Date.parse(s.lastProgressAt!),
    ).toBeGreaterThan(STALL_LIMIT_MS);
  });

  it("does NOT fire from the keep-alive — only a completed sub-step bumps", () => {
    let heartbeat: (() => void) | undefined;
    const { store, last, tick } = makeStore({
      setIntervalFn: (fn): unknown => {
        heartbeat = fn as () => void;
        return 1;
      },
      clearIntervalFn: (): void => {},
    });
    tick(1000);
    store.noteProgress(); // a genuine sub-step completes at clock 2000
    const progressAt = last().lastProgressAt;
    store.startHeartbeat();
    tick(5000);
    heartbeat!(); // a bare timer must NOT count as progress
    // A genuinely wedged step (no sub-step completes, only keep-alives) leaves
    // the progress clock stale — exactly what the watchdog must still catch.
    expect(last().lastProgressAt).toBe(progressAt);
    expect(last().updatedAt).not.toBe(progressAt);
  });

  it("commits synchronously and returns void (race-safety invariant)", () => {
    const { store, writes } = makeStore();
    const before = writes.length;
    expect(store.noteProgress()).toBeUndefined();
    expect(writes.length).toBe(before + 1);
  });
});
