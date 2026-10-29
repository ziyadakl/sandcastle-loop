import { describe, expect, it, vi } from "vitest";

import type { SandcastleStatus } from "./lib/status/schema.js";
import {
  createStatusPusher,
  isTestRunner,
  nullPusher,
  pushConfigFromEnv,
  trimForPush,
} from "./lib/status/push.js";

// ---------------------------------------------------------------------------
// The live status push exists because both existing surfaces are PULL-only and
// neither ever carries a run's terminal state or final cost: those are written
// after the last publish. That is how a finished run rendered as "running" for
// half an hour, and how a dashboard reported $167 for a run that spent ~$505.
//
// It is wired into `commit()`, which is SYNCHRONOUS by contract and runs on
// every mutation. So the three properties under test, in priority order, are:
// it cannot throw, it cannot block, and it cannot pile up. Everything else is
// secondary to those.
// ---------------------------------------------------------------------------

function snap(over: Partial<SandcastleStatus> = {}): SandcastleStatus {
  return {
    schemaVersion: 3,
    state: "running",
    hostId: "test-host",
    runId: "run-1",
    run: {
      branch: "b",
      repo: "r",
      startedAt: "2026-07-30T00:00:00.000Z",
      iterations: { current: 1, total: 10 },
      maxConcurrent: 1,
    },
    totals: { merged: 0, needsHuman: 0, requeued: 0, running: 0 },
    issues: [],
    history: [],
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...over,
  } as SandcastleStatus;
}

/** A fetch double that records calls and resolves with a controllable result. */
function fakeFetch(impl?: (body: unknown) => Promise<Response> | Response) {
  const calls: { body: SandcastleStatus; headers: Record<string, string> }[] =
    [];
  const fn = vi.fn(async (_url: unknown, init: unknown) => {
    const opts = init as { body: string; headers: Record<string, string> };
    const body = JSON.parse(opts.body) as SandcastleStatus;
    calls.push({ body, headers: opts.headers });
    if (impl) return impl(body);
    return { ok: true, status: 204 } as Response;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const CONFIG = { url: "https://example.invalid/ingest", token: "t0ken" };

describe("pushConfigFromEnv", () => {
  it("is disabled unless BOTH url and token are set", () => {
    const only = pushConfigFromEnv((k) =>
      k === "SANDCASTLE_STATUS_PUSH_URL" ? "https://x" : undefined,
    );
    expect(only.url).toBe("https://x");
    expect(only.token).toBeUndefined();
  });

  it("treats blank/whitespace as unset, matching the loop's other flags", () => {
    const c = pushConfigFromEnv(() => "   ");
    expect(c.url).toBeUndefined();
    expect(c.token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A test run must never reach the owner's live dashboard. The suite drives the
// real `runMain`, which builds a real pusher from the real environment, and it
// runs inside a container that inherits the orchestrator's env — so before this
// guard existed every run POSTed real snapshots under the container id, and the
// breaker tests' terminal `unhealthy` state bypassed the coalescer and flushed
// on the spot. Both halves are pinned below: inert under the runner, unchanged
// outside it.
// ---------------------------------------------------------------------------
describe("test-runner suppression", () => {
  const LIVE_ENV: Record<string, string> = {
    SANDCASTLE_STATUS_PUSH_URL: "https://dash.invalid/ingest",
    SANDCASTLE_STATUS_PUSH_TOKEN: "t0ken",
  };
  const bag =
    (over: Record<string, string> = {}) =>
    (k: string): string | undefined =>
      ({ ...LIVE_ENV, ...over })[k];

  it("detects vitest by its own variables, and nothing else", () => {
    // This assertion is the instrument check: the suite you are reading runs
    // under vitest, so a detector that cannot see itself is broken.
    expect(isTestRunner()).toBe(true);
    expect(isTestRunner(() => undefined)).toBe(false);
    expect(isTestRunner((k) => (k === "VITEST" ? "true" : undefined))).toBe(
      true,
    );
    expect(
      isTestRunner((k) => (k === "VITEST_WORKER_ID" ? "3" : undefined)),
    ).toBe(true);
    // NODE_ENV is deliberately NOT a trigger — a real host could carry it, and
    // muting a live host's telemetry is worse than the bug being fixed.
    expect(isTestRunner((k) => (k === "NODE_ENV" ? "test" : undefined))).toBe(
      false,
    );
  });

  it("reports push as unconfigured under the runner, even with both vars set", () => {
    const c = pushConfigFromEnv(bag({ VITEST: "true" }));
    expect(c.url).toBeUndefined();
    expect(c.token).toBeUndefined();
  });

  it("leaves the real loop's config untouched — same bag, no VITEST", () => {
    const c = pushConfigFromEnv(bag());
    expect(c.url).toBe("https://dash.invalid/ingest");
    expect(c.token).toBe("t0ken");
  });

  it("refuses to build a network-capable pusher under the runner", async () => {
    // No fetchFn: this is the shape `runMain` produces. The spy stands in for
    // the process's real fetch, so a call here IS a call to the dashboard.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 204 } as Response);
    try {
      const p = createStatusPusher({ ...CONFIG, coalesceMs: 0 });
      p.push(snap({ state: "unhealthy" })); // terminal ⇒ would flush at once
      await p.flush();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("still builds a live pusher outside the runner — identical call, clean env", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 204 } as Response);
    try {
      const p = createStatusPusher({
        ...CONFIG,
        coalesceMs: 0,
        getEnv: () => undefined,
      });
      p.push(snap({ state: "unhealthy" }));
      await p.flush();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createStatusPusher — disabled path", () => {
  it("returns a no-op when unconfigured, so an unset host behaves as before", async () => {
    const { fn, calls } = fakeFetch();
    const p = createStatusPusher({ fetchFn: fn, url: undefined, token: "t" });
    p.push(snap());
    await p.flush();
    expect(calls).toHaveLength(0);
  });

  it("nullPusher is inert and awaitable", async () => {
    const p = nullPusher();
    expect(() => p.push(snap())).not.toThrow();
    await expect(p.flush()).resolves.toBeUndefined();
  });
});

describe("createStatusPusher — never throws, never blocks", () => {
  it("push() returns synchronously even when the endpoint hangs forever", () => {
    const hang = vi.fn(() => new Promise<Response>(() => {}));
    const p = createStatusPusher({
      ...CONFIG,
      fetchFn: hang as unknown as typeof fetch,
    });
    // If push() awaited anything, commit() would block the whole run.
    const before = Date.now();
    p.push(snap());
    expect(Date.now() - before).toBeLessThan(50);
  });

  it("swallows a rejected request and logs at most once per run", async () => {
    const boom = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const logged: string[] = [];
    const p = createStatusPusher({
      ...CONFIG,
      coalesceMs: 0,
      fetchFn: boom as unknown as typeof fetch,
      logError: (l) => logged.push(l),
    });
    for (let i = 0; i < 5; i += 1) {
      p.push(snap({ updatedAt: `t${i}` }));
      await p.flush();
    }
    // A dashboard being down must not flood the run log.
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("connection refused");
  });

  it("swallows a non-2xx response", async () => {
    const { fn } = fakeFetch(() => ({ ok: false, status: 500 }) as Response);
    const logged: string[] = [];
    const p = createStatusPusher({
      ...CONFIG,
      coalesceMs: 0,
      fetchFn: fn,
      logError: (l) => logged.push(l),
    });
    p.push(snap());
    await expect(p.flush()).resolves.toBeUndefined();
    expect(logged[0]).toContain("500");
  });
});

describe("createStatusPusher — delivery", () => {
  it("sends the snapshot with bearer auth and JSON content type", async () => {
    const { fn, calls } = fakeFetch();
    const p = createStatusPusher({ ...CONFIG, coalesceMs: 0, fetchFn: fn });
    p.push(snap({ hostId: "mac" }));
    await p.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe("Bearer t0ken");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].body.hostId).toBe("mac");
  });

  it("coalesces a burst into one request carrying the LATEST state", async () => {
    // A single phase change writes several times in quick succession; the
    // dashboard only cares about the newest, and a stampede is pure waste.
    const { fn, calls } = fakeFetch();
    let clock = 1_000;
    const p = createStatusPusher({
      ...CONFIG,
      coalesceMs: 1_000,
      fetchFn: fn,
      nowMs: () => clock,
    });
    p.push(snap({ updatedAt: "first" }));
    await p.flush();
    expect(calls).toHaveLength(1);

    // Still inside the coalesce window — these must not each fire.
    p.push(snap({ updatedAt: "second" }));
    p.push(snap({ updatedAt: "third" }));
    p.push(snap({ updatedAt: "fourth" }));
    clock += 5_000; // window elapsed
    await p.flush();

    expect(calls).toHaveLength(2);
    expect(calls[1].body.updatedAt).toBe("fourth");
  });

  it("flushes a TERMINAL state immediately, bypassing the coalesce window", async () => {
    // The terminal commit carries the run's final cost and outcome — the two
    // things the pull surfaces structurally cannot show. It must not sit in a
    // window it might not survive.
    const { fn, calls } = fakeFetch();
    let clock = 1_000;
    const p = createStatusPusher({
      ...CONFIG,
      coalesceMs: 60_000,
      fetchFn: fn,
      nowMs: () => clock,
    });
    p.push(snap());
    await p.flush();
    expect(calls).toHaveLength(1);

    p.push(
      snap({
        state: "done",
        totals: {
          merged: 3,
          needsHuman: 0,
          requeued: 0,
          running: 0,
          totalCostUsd: 337.87,
        },
      } as Partial<SandcastleStatus>),
    );
    await p.flush();

    expect(calls).toHaveLength(2);
    expect(calls[1].body.state).toBe("done");
    expect(calls[1].body.totals.totalCostUsd).toBe(337.87);
  });

  it("delivers a snapshot queued WHILE a request was in flight", async () => {
    // Otherwise the final state of a run can be dropped precisely because the
    // preceding send was slow — the worst possible time to lose an update.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const { fn, calls } = fakeFetch(async () => {
      if (first) {
        first = false;
        await gate;
      }
      return { ok: true, status: 204 } as Response;
    });
    const p = createStatusPusher({ ...CONFIG, coalesceMs: 0, fetchFn: fn });

    p.push(snap({ updatedAt: "in-flight" }));
    await Promise.resolve();
    p.push(snap({ state: "done", updatedAt: "queued-during" }));
    release();
    await p.flush();

    expect(calls).toHaveLength(2);
    expect(calls[1].body.updatedAt).toBe("queued-during");
  });
});

describe("trimForPush", () => {
  it("caps unbounded history without mutating the caller's object", () => {
    // `history` is append-only and never truncated by the store, so a long run
    // would otherwise grow the payload without limit. The on-disk file must
    // stay complete, so trimming has to be non-destructive.
    const history = Array.from({ length: 50 }, (_, i) => ({
      number: i,
      title: `t${i}`,
      branch: "b",
      phase: "merged" as const,
      completedAt: "2026-07-30T00:00:00.000Z",
    }));
    const original = snap({ history });
    const trimmed = trimForPush(original);

    expect(trimmed.history).toHaveLength(30);
    expect(trimmed.history?.[29].number).toBe(49); // keeps the NEWEST
    expect(original.history).toHaveLength(50); // caller untouched
  });

  it("returns the snapshot unchanged when history is already small", () => {
    const s = snap();
    expect(trimForPush(s)).toBe(s);
  });
});
