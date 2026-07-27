/**
 * Tests for the ONE source of truth on loop liveness
 * (`.sandcastle/lib/status/liveness.ts`).
 *
 * `deriveLiveness` encodes the single rule that used to live inline in
 * `watch/reducer.ts` and in prose in a skill: a `state:"running"` snapshot whose
 * `updatedAt` is older than `STALE_AFTER_MS` is NOT live (the loop was hard-killed
 * and never got to flip `state`). Terminal states are authoritative and
 * time-independent; every other state — including one from a writer NEWER than
 * this build — degrades to freshness rather than blanking out.
 *
 * Table-driven: every state (terminal / non-terminal / unknown) × freshness.
 */
import { describe, it, expect } from "vitest";
import {
  deriveLiveness,
  type Liveness,
} from "../.sandcastle/lib/status/liveness.js";
import { STALE_AFTER_MS } from "../.sandcastle/lib/status/schema.js";

const NOW = Date.parse("2026-06-04T12:00:00.000Z");
const FRESH = "2026-06-04T11:59:00.000Z"; // 60s old — well under STALE_AFTER_MS
const STALE = new Date(NOW - STALE_AFTER_MS - 1000).toISOString(); // just past the window

type St = {
  state: string;
  updatedAt: string;
  pid?: number;
  hostId?: string;
};

function status(over: Partial<St> = {}): St {
  return { state: "running", updatedAt: FRESH, ...over };
}

const SELF = "mac-abc";
const PEER = "vps-xyz";
/** A probe that reports the pid dead, and records that it was consulted. */
function deadProbe(): { fn: (pid: number) => boolean; calls: number[] } {
  const calls: number[] = [];
  return {
    fn: (pid: number) => {
      calls.push(pid);
      return false; // ESRCH ⇒ dead
    },
    calls,
  };
}

describe("deriveLiveness", () => {
  // --- terminal states are authoritative regardless of freshness ---
  const terminal: Array<[string, Liveness["reason"]]> = [
    ["done", "done"],
    ["stopped", "stopped"],
    ["unhealthy", "unhealthy"],
  ];
  for (const [state, reason] of terminal) {
    it(`${state} → not live, reason "${reason}" even when the write is fresh`, () => {
      expect(deriveLiveness(status({ state, updatedAt: FRESH }), { now: NOW })).toEqual<
        Liveness
      >({ live: false, reason });
    });
    it(`${state} → not live, reason "${reason}" even when the write is stale`, () => {
      expect(deriveLiveness(status({ state, updatedAt: STALE }), { now: NOW })).toEqual<
        Liveness
      >({ live: false, reason });
    });
  }

  // --- non-terminal states are freshness-based ---
  for (const state of ["running", "restarting", "stopping"]) {
    it(`${state} + fresh write → live, reason "running"`, () => {
      expect(deriveLiveness(status({ state, updatedAt: FRESH }), { now: NOW })).toEqual<
        Liveness
      >({ live: true, reason: "running" });
    });
    it(`${state} + stale write → not live, reason "stale" (the hard-kill class)`, () => {
      expect(deriveLiveness(status({ state, updatedAt: STALE }), { now: NOW })).toEqual<
        Liveness
      >({ live: false, reason: "stale" });
    });
  }

  // --- pid is NOT part of LivenessInput, but IS part of the status schema, so
  // the reducer hands whole snapshots that carry it. These lock that the extra
  // field is simply ignored and can never resurrect a dead feed (2b). ---
  it("stale running WITH a pid is still not live (a written pid can't resurrect a dead feed)", () => {
    expect(
      deriveLiveness(status({ state: "running", updatedAt: STALE, pid: 4242 }), {
        now: NOW,
      }),
    ).toEqual<Liveness>({ live: false, reason: "stale" });
  });
  it("stale running with an ABSENT pid is not live", () => {
    const s = status({ state: "running", updatedAt: STALE });
    expect(s.pid).toBeUndefined();
    expect(deriveLiveness(s, { now: NOW })).toEqual<Liveness>({
      live: false,
      reason: "stale",
    });
  });

  // --- UNKNOWN states degrade to freshness — the "no version gate" lesson ---
  // `LivenessInput.state` is deliberately `string`, not the `RunState` union, and
  // the `default:` branch treats an unrecognised state as non-terminal. A newer
  // writer emitting a state this build has never heard of must still render as a
  // live-or-stale run. A strict enum that rejected it is exactly what once blanked
  // the viewer behind an "out of date" screen. These lock that in.
  it("an UNKNOWN/newer state + fresh write → live (never hard-fails on a future writer)", () => {
    expect(
      deriveLiveness(status({ state: "draining-v9", updatedAt: FRESH }), { now: NOW }),
    ).toEqual<Liveness>({ live: true, reason: "running" });
  });
  it("an UNKNOWN/newer state + stale write → not live, reason \"stale\" (freshness still applies)", () => {
    expect(
      deriveLiveness(status({ state: "draining-v9", updatedAt: STALE }), { now: NOW }),
    ).toEqual<Liveness>({ live: false, reason: "stale" });
  });

  // --- crashed detection: same-host PID probe (Fix 1) ---
  // When a snapshot is OURS (its hostId === selfHostId) and carries a pid, an
  // injected `probeAlive(pid)===false` proves the loop process is gone — a hard
  // kill (SIGKILL/OOM/sleep) that never got to flip `state`. This is a stronger
  // signal than freshness (no need to wait out STALE_AFTER_MS) and gets its own
  // reason. It must ONLY fire same-host: `process.kill(peerPid,0)` is meaningless
  // for another machine's PID, so a peer snapshot stays freshness-gated.
  it("same-host FRESH running + dead pid → crashed (beats freshness — no wait needed)", () => {
    const probe = deadProbe();
    expect(
      deriveLiveness(status({ state: "running", updatedAt: FRESH, pid: 4242, hostId: SELF }), {
        now: NOW,
        probeAlive: probe.fn,
        selfHostId: SELF,
      }),
    ).toEqual<Liveness>({ live: false, reason: "crashed" });
    expect(probe.calls).toEqual([4242]);
  });

  it("same-host STALE running + dead pid → crashed (crashed outranks stale)", () => {
    expect(
      deriveLiveness(status({ state: "running", updatedAt: STALE, pid: 4242, hostId: SELF }), {
        now: NOW,
        probeAlive: () => false,
        selfHostId: SELF,
      }),
    ).toEqual<Liveness>({ live: false, reason: "crashed" });
  });

  it("same-host running + LIVE pid → live/running (a running process is not crashed)", () => {
    expect(
      deriveLiveness(status({ state: "running", updatedAt: FRESH, pid: 4242, hostId: SELF }), {
        now: NOW,
        probeAlive: () => true,
        selfHostId: SELF,
      }),
    ).toEqual<Liveness>({ live: true, reason: "running" });
  });

  // THE key non-vacuous guard: a PEER's dead pid must NEVER be labelled crashed,
  // and the probe must not even be consulted for it — it stays freshness-gated.
  it("PEER dead pid + FRESH → running, probe NEVER consulted (peer stays freshness-gated)", () => {
    const probe = deadProbe();
    expect(
      deriveLiveness(status({ state: "running", updatedAt: FRESH, pid: 99, hostId: PEER }), {
        now: NOW,
        probeAlive: probe.fn,
        selfHostId: SELF,
      }),
    ).toEqual<Liveness>({ live: true, reason: "running" });
    expect(probe.calls).toEqual([]);
  });

  it("PEER dead pid + STALE → stale (freshness only), NOT crashed", () => {
    const probe = deadProbe();
    expect(
      deriveLiveness(status({ state: "running", updatedAt: STALE, pid: 99, hostId: PEER }), {
        now: NOW,
        probeAlive: probe.fn,
        selfHostId: SELF,
      }),
    ).toEqual<Liveness>({ live: false, reason: "stale" });
    expect(probe.calls).toEqual([]);
  });

  it("same-host with an ABSENT pid → unchanged freshness (nothing to probe)", () => {
    const probe = deadProbe();
    expect(
      deriveLiveness(status({ state: "running", updatedAt: FRESH, hostId: SELF }), {
        now: NOW,
        probeAlive: probe.fn,
        selfHostId: SELF,
      }),
    ).toEqual<Liveness>({ live: true, reason: "running" });
    expect(probe.calls).toEqual([]);
  });

  it("no probe/selfHostId injected → back-compat, pid ignored (freshness only)", () => {
    expect(
      deriveLiveness(status({ state: "running", updatedAt: STALE, pid: 4242, hostId: SELF }), {
        now: NOW,
      }),
    ).toEqual<Liveness>({ live: false, reason: "stale" });
  });

  it("terminal state still wins even with a same-host dead pid", () => {
    const probe = deadProbe();
    expect(
      deriveLiveness(status({ state: "done", updatedAt: STALE, pid: 4242, hostId: SELF }), {
        now: NOW,
        probeAlive: probe.fn,
        selfHostId: SELF,
      }),
    ).toEqual<Liveness>({ live: false, reason: "done" });
    expect(probe.calls).toEqual([]); // terminal short-circuits before any probe
  });

  // --- degenerate updatedAt mirrors reducer semantics (non-finite ⇒ not stale) ---
  it("an unparseable updatedAt is NOT treated as stale (matches the reducer's finite guard)", () => {
    expect(
      deriveLiveness(status({ state: "running", updatedAt: "not-a-date" }), {
        now: NOW,
      }),
    ).toEqual<Liveness>({ live: true, reason: "running" });
  });
});
