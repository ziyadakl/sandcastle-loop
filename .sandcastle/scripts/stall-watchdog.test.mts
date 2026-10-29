import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STALL_LIMIT_MS,
  deriveRunFreshness,
  deriveStall,
  handleStall,
  killLoop,
  pidAlive,
  remainingIterations,
  watchdogStep,
  type KillOutcome,
  type RawStatus,
  type WatchdogStepConfig,
  type WatchdogStepDeps,
  type WatchdogStepState,
} from "./stall-watchdog.mts";

// ---------------------------------------------------------------------------
// `deriveStall` is the PURE core of the stall watchdog — the single "is this
// run wedged?" decision, mirroring `deriveLiveness`'s injected-`now` shape. The
// whole point of the watchdog is to fire ONLY on a genuine hang and NEVER on a
// missing/torn/absent signal, so the fail-safe cases matter as much as the
// positive one. `now` is fixed so every case is deterministic.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const LIMIT = DEFAULT_STALL_LIMIT_MS; // 90 min

/** An ISO timestamp `minutes` before NOW. */
function minsAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

describe("deriveStall — the pure stall decision", () => {
  it("STALLS a running loop whose last progress is older than the limit", () => {
    const d = deriveStall(
      { state: "running", lastProgressAt: minsAgo(91) },
      { now: NOW, stallLimitMs: LIMIT },
    );
    expect(d).toEqual({ stalled: true, reason: "stalled" });
  });

  it("does NOT stall a running loop with fresh progress (a slow-but-healthy phase)", () => {
    // 59 minutes — inside the 60-min hardCeilingSec, well under the 90-min limit.
    const d = deriveStall(
      { state: "running", lastProgressAt: minsAgo(59) },
      { now: NOW, stallLimitMs: LIMIT },
    );
    expect(d).toEqual({ stalled: false, reason: "fresh-progress" });
  });

  it("treats exactly-at-the-limit as NOT yet stalled (strictly greater)", () => {
    const d = deriveStall(
      { state: "running", lastProgressAt: new Date(NOW - LIMIT).toISOString() },
      { now: NOW, stallLimitMs: LIMIT },
    );
    expect(d.stalled).toBe(false);
  });

  it("never stalls a run that is not `running` — even with ancient progress", () => {
    for (const state of ["done", "stopped", "stopping", "restarting", "unhealthy", "wat"]) {
      const d = deriveStall(
        { state, lastProgressAt: minsAgo(999) },
        { now: NOW, stallLimitMs: LIMIT },
      );
      expect(d).toEqual({ stalled: false, reason: "not-running" });
    }
  });

  it("FAILS SAFE when lastProgressAt is missing (a pre-watchdog run)", () => {
    const d = deriveStall(
      { state: "running" },
      { now: NOW, stallLimitMs: LIMIT },
    );
    expect(d).toEqual({ stalled: false, reason: "missing-progress" });
  });

  it("FAILS SAFE when lastProgressAt is unparseable (a torn write)", () => {
    const d = deriveStall(
      { state: "running", lastProgressAt: "not-a-date" },
      { now: NOW, stallLimitMs: LIMIT },
    );
    expect(d).toEqual({ stalled: false, reason: "unparseable-progress" });
  });

  it("honors a custom (tighter) stall limit", () => {
    const d = deriveStall(
      { state: "running", lastProgressAt: minsAgo(11) },
      { now: NOW, stallLimitMs: 10 * 60_000 },
    );
    expect(d).toEqual({ stalled: true, reason: "stalled" });
  });
});

describe("DEFAULT_STALL_LIMIT_MS", () => {
  it("sits safely above the 60-min hardCeilingSec so a slow phase is never killed", () => {
    expect(DEFAULT_STALL_LIMIT_MS).toBeGreaterThan(3600 * 1000);
    expect(DEFAULT_STALL_LIMIT_MS).toBe(90 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// The IMPERATIVE half — handleStall / watchdogStep — behind an injected `deps`
// seam. The fakes below record the ORDER of side effects and simulate a FAILED
// kill without touching a real process, so the three self-heal correctness bugs
// (marker-ordering, latch-on-failed-kill, startup-window race) are exercised
// without any real IO or process control.
// ---------------------------------------------------------------------------

const PID = 4242;

/** A fake `deps` that records the order of side effects and lets a test dial in
 *  the kill outcome / pid liveness / clock. */
function makeDeps(
  opts: { killOutcome?: KillOutcome; pidAlive?: boolean; now?: number } = {},
): {
  deps: WatchdogStepDeps;
  order: string[];
  killPids: number[];
  markerWrites: Array<{ path: string; contents: string }>;
} {
  const order: string[] = [];
  const killPids: number[] = [];
  const markerWrites: Array<{ path: string; contents: string }> = [];
  const deps: WatchdogStepDeps = {
    now: () => opts.now ?? NOW,
    writeMarker: (p, c) => {
      order.push("marker");
      markerWrites.push({ path: p, contents: c });
    },
    killSandboxContainers: () => {
      order.push("sweep");
    },
    pidAlive: () => opts.pidAlive ?? true,
    killLoop: (pid) => {
      order.push("kill");
      killPids.push(pid);
      return opts.killOutcome ?? "signalled";
    },
  };
  return { deps, order, killPids, markerWrites };
}

const noopLog = (): void => {};

/** A running status that IS stalled at NOW: 91-min-old progress, alive pid, and
 *  a run that started 30 min ago (after any launch time the tests use). */
function stalledStatus(overrides: Partial<RawStatus> = {}): RawStatus {
  return {
    state: "running",
    lastProgressAt: new Date(NOW - 91 * 60_000).toISOString(),
    pid: PID,
    run: {
      startedAt: new Date(NOW - 30 * 60_000).toISOString(),
      iterations: { current: 1, total: 1 },
    },
    ...overrides,
  };
}

/** A step config whose launch time is old enough that `stalledStatus`'s run
 *  counts as current (unless a test overrides it). */
function stepConfig(overrides: Partial<WatchdogStepConfig> = {}): WatchdogStepConfig {
  return {
    repoRoot: "/repo",
    stallLimitMs: LIMIT,
    launchedAtMs: NOW - 60 * 60_000,
    ...overrides,
  };
}

describe("handleStall — marker is written BEFORE the sweep (bug 1)", () => {
  it("orders the side effects marker → sweep → kill", () => {
    const { deps, order, markerWrites } = makeDeps();
    const res = handleStall(stalledStatus(), "/repo", noopLog, deps);
    // The critical invariant: the restart marker exists on disk before anything
    // that could unblock the loop into a fast non-75 exit.
    expect(order).toEqual(["marker", "sweep", "kill"]);
    expect(order.indexOf("marker")).toBeLessThan(order.indexOf("sweep"));
    expect(markerWrites).toEqual([{ path: "/repo/.sandcastle/.stall-restart", contents: "1" }]);
    expect(res.latch).toBe(true);
  });
});

describe("failed kill does NOT latch and re-fires (bug 2)", () => {
  it("returns latch=false when a non-ESRCH kill fails", () => {
    const { deps, killPids } = makeDeps({ killOutcome: "failed" });
    const res = handleStall(stalledStatus(), "/repo", noopLog, deps);
    expect(res.latch).toBe(false);
    expect(killPids).toEqual([PID]);
  });

  it("re-fires the kill on the next poll when the first kill failed", () => {
    const { deps, killPids } = makeDeps({ killOutcome: "failed" });
    const status = stalledStatus();
    const config = stepConfig();
    let state: WatchdogStepState = { actedProgressAt: undefined };
    state = watchdogStep(status, state, config, deps, noopLog);
    state = watchdogStep(status, state, config, deps, noopLog);
    // Fired BOTH polls — the failed kill never latched.
    expect(killPids).toEqual([PID, PID]);
    expect(state.actedProgressAt).toBeUndefined();
  });

  it("latches on a successful kill and does NOT re-fire the same stall", () => {
    const { deps, killPids } = makeDeps({ killOutcome: "signalled" });
    const status = stalledStatus();
    const config = stepConfig();
    let state: WatchdogStepState = { actedProgressAt: undefined };
    state = watchdogStep(status, state, config, deps, noopLog);
    state = watchdogStep(status, state, config, deps, noopLog);
    expect(killPids).toEqual([PID]); // fired exactly once
    expect(state.actedProgressAt).toBe(status.lastProgressAt);
  });

  it("treats ESRCH (already gone) as a latch — does NOT re-fire", () => {
    const { deps, killPids } = makeDeps({ killOutcome: "already-gone" });
    const status = stalledStatus();
    const config = stepConfig();
    let state: WatchdogStepState = { actedProgressAt: undefined };
    state = watchdogStep(status, state, config, deps, noopLog);
    state = watchdogStep(status, state, config, deps, noopLog);
    expect(killPids).toEqual([PID]);
    expect(state.actedProgressAt).toBe(status.lastProgressAt);
  });
});

describe("startup-window guard ignores a prior run's stale status (bug 3)", () => {
  it("does not act when run.startedAt predates the watchdog's launch", () => {
    const config = stepConfig({ launchedAtMs: NOW - 10 * 60_000 }); // launched 10 min ago
    const status = stalledStatus({
      run: {
        startedAt: new Date(NOW - 300 * 60_000).toISOString(), // 5h ago — a prior run
        iterations: { current: 1, total: 1 },
      },
    });
    const { deps, order, killPids } = makeDeps();
    const state = watchdogStep(status, { actedProgressAt: undefined }, config, deps, noopLog);
    expect(order).toEqual([]); // no marker, no sweep, no kill
    expect(killPids).toEqual([]);
    expect(state.actedProgressAt).toBeUndefined();
  });

  it("acts on the same stalled status once run.startedAt is at/after launch", () => {
    const config = stepConfig({ launchedAtMs: NOW - 120 * 60_000 });
    const status = stalledStatus({
      run: {
        startedAt: new Date(NOW - 100 * 60_000).toISOString(), // after launch
        iterations: { current: 1, total: 1 },
      },
    });
    const { deps, killPids } = makeDeps();
    watchdogStep(status, { actedProgressAt: undefined }, config, deps, noopLog);
    expect(killPids).toEqual([PID]);
  });

  it("fails safe (no kill) when run.startedAt is missing or unparseable", () => {
    const config = stepConfig();
    for (const bad of [undefined, "not-a-date"]) {
      const status = stalledStatus({
        run: {
          startedAt: bad as unknown as string,
          iterations: { current: 1, total: 1 },
        },
      });
      const { deps, killPids } = makeDeps();
      watchdogStep(status, { actedProgressAt: undefined }, config, deps, noopLog);
      expect(killPids).toEqual([]);
    }
  });

  it("does NOT SIGKILL when the pid is no longer alive", () => {
    const { deps, killPids } = makeDeps({ pidAlive: false });
    const res = handleStall(stalledStatus(), "/repo", noopLog, deps);
    expect(killPids).toEqual([]); // liveness check skipped the kill
    expect(res.latch).toBe(true); // already gone ⇒ nothing more to do ⇒ latch
  });

  it("latches (no re-sweep every poll) when status carries no pid", () => {
    const { deps, order } = makeDeps();
    const res = handleStall(stalledStatus({ pid: undefined }), "/repo", noopLog, deps);
    expect(res.latch).toBe(true);
    expect(order).toEqual(["marker", "sweep"]); // marker + sweep ran, no kill
  });
});

describe("deriveRunFreshness (pure)", () => {
  const launch = NOW - 30 * 60_000;
  it("is 'current' when the run started at or after launch", () => {
    expect(deriveRunFreshness({ run: { startedAt: new Date(launch).toISOString() } }, launch)).toBe("current");
    expect(deriveRunFreshness({ run: { startedAt: new Date(NOW).toISOString() } }, launch)).toBe("current");
  });
  it("is 'stale-residue' when the run started before launch", () => {
    expect(
      deriveRunFreshness({ run: { startedAt: new Date(launch - 1).toISOString() } }, launch),
    ).toBe("stale-residue");
  });
  it("is 'indeterminate' when startedAt is missing or unparseable", () => {
    expect(deriveRunFreshness({}, launch)).toBe("indeterminate");
    expect(deriveRunFreshness({ run: {} }, launch)).toBe("indeterminate");
    expect(deriveRunFreshness({ run: { startedAt: "nope" } }, launch)).toBe("indeterminate");
  });
});

describe("remainingIterations (pure)", () => {
  // #1191 finding B: nothing in main.mts calls `statusStore.startIteration`
  // any more (the rolling pool tracks per-ticket phases instead), so
  // `run.iterations.current` sits frozen at 0 for the pool's whole life.
  // `run.tickets` (present on any current-build status file) is now
  // preferred; the `iterations` math below is the fallback for an old-build
  // status file that predates `tickets` entirely.
  describe("preferring run.tickets when present", () => {
    it("computes cap - done - working", () => {
      expect(
        remainingIterations({
          run: { tickets: { done: 1, working: 1, cap: 5 } },
        }),
      ).toBe(3);
      expect(
        remainingIterations({
          run: { tickets: { done: 0, working: 0, cap: 5 } },
        }),
      ).toBe(5);
    });
    it("does NOT subtract `waiting` — a planned-but-not-yet-picked-up ticket has not been attempted", () => {
      expect(
        remainingIterations({
          run: {
            tickets: { done: 1, working: 0, cap: 5 },
            // `waiting` isn't even read by remainingIterations — the shape
            // it's typed against has no such field — but a status file WILL
            // carry one; this just documents that it is irrelevant here.
          },
        }),
      ).toBe(4);
    });
    it("clamps to at least 1 — never a zero or negative marker", () => {
      expect(
        remainingIterations({
          run: { tickets: { done: 5, working: 2, cap: 5 } },
        }),
      ).toBe(1);
    });
    it("ignores a stale run.iterations sitting alongside a fresh run.tickets", () => {
      // The exact shape a real pool status file has: `iterations.current`
      // frozen at 0 from startup, `tickets` doing the real accounting.
      expect(
        remainingIterations({
          run: {
            iterations: { current: 0, total: 71 },
            tickets: { done: 60, working: 1, cap: 71 },
          },
        }),
      ).toBe(10);
    });
    it("falls back to the old iterations math when tickets is only PARTIALLY present", () => {
      expect(
        remainingIterations({
          run: {
            iterations: { current: 3, total: 5 },
            tickets: { done: 1 }, // missing working/cap
          },
        }),
      ).toBe(3);
    });
  });

  describe("falling back to run.iterations for a pre-#902 status file with no tickets field at all", () => {
    it("computes total - current + 1", () => {
      expect(remainingIterations({ run: { iterations: { current: 1, total: 5 } } })).toBe(5);
      expect(remainingIterations({ run: { iterations: { current: 3, total: 5 } } })).toBe(3);
      expect(remainingIterations({ run: { iterations: { current: 5, total: 5 } } })).toBe(1);
    });
    it("clamps to at least 1 — never a zero or negative marker", () => {
      expect(remainingIterations({ run: { iterations: { current: 6, total: 5 } } })).toBe(1);
    });
    it("defaults missing iteration fields to 1", () => {
      expect(remainingIterations({})).toBe(1);
      expect(remainingIterations({ run: {} })).toBe(1);
      expect(remainingIterations({ run: { iterations: {} } })).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The REAL error-code mapping — killLoop / pidAlive against a stubbed
// `process.kill`. The imperative-half tests above use FAKES for these two, so
// the actual ESRCH-vs-EPERM branching (which bugs 2 and 3 hinge on) was
// untested: a swapped ESRCH/EPERM would ship green. Stub Node's `process.kill`
// to simulate each syscall outcome and assert the real return values.
// ---------------------------------------------------------------------------

/** Build a NodeJS.ErrnoException carrying a specific `.code`, as `process.kill`
 *  throws (ESRCH = no such process, EPERM = exists but not ours to signal). */
function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("killLoop (real) — SIGKILL outcome mapping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'signalled' when process.kill delivers SIGKILL", () => {
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(killLoop(PID, noopLog)).toBe("signalled");
    expect(spy).toHaveBeenCalledWith(PID, "SIGKILL");
  });

  it("returns 'already-gone' when process.kill throws ESRCH (process gone)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("ESRCH");
    });
    expect(killLoop(PID, noopLog)).toBe("already-gone");
  });

  it("returns 'failed' when process.kill throws EPERM (still wedged, not ours)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("EPERM");
    });
    expect(killLoop(PID, noopLog)).toBe("failed");
  });

  it("returns 'failed' on any other non-ESRCH error", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("EINVAL");
    });
    expect(killLoop(PID, noopLog)).toBe("failed");
  });
});

describe("pidAlive (real) — null-signal liveness probe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is alive (true) when the null-signal probe succeeds", () => {
    const spy = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(pidAlive(PID)).toBe(true);
    expect(spy).toHaveBeenCalledWith(PID, 0);
  });

  it("is NOT alive (false) when the probe throws ESRCH (process gone)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("ESRCH");
    });
    expect(pidAlive(PID)).toBe(false);
  });

  it("is alive (true) when the probe throws EPERM (exists, not ours to signal)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw errnoError("EPERM");
    });
    expect(pidAlive(PID)).toBe(true);
  });
});
