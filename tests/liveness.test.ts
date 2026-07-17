/**
 * Tests for the ONE source of truth on loop liveness
 * (`.sandcastle/lib/status/liveness.ts`).
 *
 * `deriveLiveness` encodes the single rule that used to live inline in
 * `watch/reducer.ts` and in prose in a skill: a `state:"running"` snapshot whose
 * `updatedAt` is older than `STALE_AFTER_MS` is NOT live (the loop was hard-killed
 * and never got to flip `state`). Terminal states are authoritative and
 * time-independent. `lockHeld:false` is a same-host proxy for "the process that
 * owned this feed is gone" (the single-instance lock released on death, or a
 * `process.kill(pid,0)` probe failed) — it can only DOWNGRADE liveness, never
 * upgrade a stale feed back to live.
 *
 * Table-driven: every state × freshness × lock/pid combination.
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
};

function status(over: Partial<St> = {}): St {
  return { state: "running", updatedAt: FRESH, ...over };
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

  // --- pid presence does not change the stale rule (2b) ---
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

  // --- lockHeld: same-host death proxy, DOWNGRADE-ONLY ---
  it("fresh running but lockHeld:false → not live (loop is provably gone before the stale window)", () => {
    expect(
      deriveLiveness(status({ state: "running", updatedAt: FRESH }), {
        now: NOW,
        lockHeld: false,
      }),
    ).toEqual<Liveness>({ live: false, reason: "stale" });
  });
  it("fresh running with lockHeld:true → live", () => {
    expect(
      deriveLiveness(status({ state: "running", updatedAt: FRESH }), {
        now: NOW,
        lockHeld: true,
      }),
    ).toEqual<Liveness>({ live: true, reason: "running" });
  });
  it("lockHeld:true CANNOT rescue a stale feed (a wedged process that stopped heartbeating is not live)", () => {
    expect(
      deriveLiveness(status({ state: "running", updatedAt: STALE }), {
        now: NOW,
        lockHeld: true,
      }),
    ).toEqual<Liveness>({ live: false, reason: "stale" });
  });
  it("lockHeld:false forces non-live even on a terminal-looking... no — terminal wins over lock", () => {
    // A done run legitimately stops holding the lock; that must still read "done",
    // not "stale". Terminal authority is checked before the lock signal.
    expect(
      deriveLiveness(status({ state: "done", updatedAt: FRESH }), {
        now: NOW,
        lockHeld: false,
      }),
    ).toEqual<Liveness>({ live: false, reason: "done" });
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
