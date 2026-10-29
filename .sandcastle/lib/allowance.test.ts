/**
 * The loop waits for the soonest reset when every pooled account is out
 * (tokenmaxxing build plan 4.5).
 *
 * The fixture strings below are the exact shapes CLIProxyAPI v8.0.15 sends a
 * Claude Code client, read from its source:
 *   - `sdk/cliproxy/auth/selector.go:122-162` builds the cooldown message
 *     ("All credentials for model X are cooling down via provider Y") and
 *     answers 429 with `Retry-After` = seconds to the soonest cooldown end.
 *   - `sdk/api/handlers/claude/code_handlers.go:448-481` rewrites it to the
 *     Anthropic error shape, keeping only `type` and `message`.
 * Claude Code prints that body after "API Error: 429", and the sandbox SDK
 * wraps it as "claude exited with code 1:\n<text>".
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FALLBACK_WAIT_MS,
  RESET_MARGIN_MS,
  allowanceWait,
  createAllowanceGate,
  isPoolCooldownError,
  poolAuthFilesReader,
} from "./allowance.js";

const COOLDOWN_BODY =
  '{"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-5-5 are cooling down via provider claude"}}';

describe("isPoolCooldownError", () => {
  it("matches the pool's every-login-is-out answer as Claude Code reports it", () => {
    expect(
      isPoolCooldownError(`claude exited with code 1:\nAPI Error: 429 ${COOLDOWN_BODY}`),
    ).toBe(true);
  });

  it("matches the message when the pool appends the last upstream error", () => {
    expect(
      isPoolCooldownError(
        "All credentials for model claude-sonnet-5 are cooling down (last error: rate_limit_error: usage limit)",
      ),
    ).toBe(true);
  });

  it("does not match an ordinary upstream rate limit", () => {
    expect(
      isPoolCooldownError(
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}',
      ),
    ).toBe(false);
  });
});

const NOW = Date.parse("2026-10-06T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

/** One entry of `GET /v0/management/auth-files`, in the v8.0.15 shape
 *  (`auth_files.go:654-726`). Only the fields the loop reads. */
function login(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "claude-a.json",
    provider: "claude",
    type: "claude",
    disabled: false,
    unavailable: false,
    status: "active",
    quota: { signals: {} },
    ...over,
  };
}
const files = (...entries: Record<string, unknown>[]) => async () => ({ files: entries });

describe("allowanceWait", () => {
  it("waits until the soonest login comes back when every login is out", async () => {
    const wait = await allowanceWait(`API Error: 429 ${COOLDOWN_BODY}`, {
      nowMs: NOW,
      readAuthFiles: files(
        login({ name: "a", unavailable: true, next_retry_after: iso(NOW + 3 * HOUR) }),
        login({ name: "b", unavailable: true, next_retry_after: iso(NOW + 2 * HOUR) }),
      ),
    });
    expect(wait).toMatchObject({ untilMs: NOW + 2 * HOUR + RESET_MARGIN_MS, source: "pool" });
  });

  it("ignores disabled logins and other providers' logins", async () => {
    const wait = await allowanceWait(`API Error: 429 ${COOLDOWN_BODY}`, {
      nowMs: NOW,
      readAuthFiles: files(
        login({ name: "out", unavailable: true, next_retry_after: iso(NOW + HOUR) }),
        login({ name: "off", disabled: true, status: "disabled" }),
        login({ name: "codex", provider: "codex", type: "codex" }),
      ),
    });
    expect(wait).toMatchObject({ untilMs: NOW + HOUR + RESET_MARGIN_MS });
  });

  it("does not wait when one Claude login is still usable and the error is an ordinary 429", async () => {
    const wait = await allowanceWait("API Error: 429 rate_limit_error", {
      nowMs: NOW,
      readAuthFiles: files(
        login({ name: "out", unavailable: true, next_retry_after: iso(NOW + HOUR) }),
        login({ name: "ok" }),
      ),
    });
    expect(wait).toBeNull();
  });

  it("reads the reset from the rate-limit headers the pool kept, for the failing model", async () => {
    // A per-model cooldown leaves the login itself "available" in the listing;
    // the model's saved Anthropic headers still say which window ran out.
    const sec = (ms: number) => String(Math.floor(ms / 1000));
    const wait = await allowanceWait(`API Error: 429 ${COOLDOWN_BODY}`, {
      nowMs: NOW,
      readAuthFiles: files(
        login({
          name: "a",
          model_quotas: {
            "claude-opus-5-5": {
              signals: {
                "Anthropic-Ratelimit-Unified-5h-Utilization": "0.4",
                "Anthropic-Ratelimit-Unified-5h-Reset": sec(NOW + HOUR),
                "Anthropic-Ratelimit-Unified-7d-Utilization": "1.0",
                "Anthropic-Ratelimit-Unified-7d-Reset": sec(NOW + 30 * HOUR),
              },
            },
          },
        }),
        login({
          name: "b",
          quota: {
            signals: {
              "Anthropic-Ratelimit-Unified-5h-Utilization": "1",
              "Anthropic-Ratelimit-Unified-5h-Reset": sec(NOW + 4 * HOUR),
            },
          },
        }),
      ),
    });
    expect(wait).toMatchObject({ untilMs: NOW + 4 * HOUR + RESET_MARGIN_MS, source: "pool" });
  });

  it("trusts the pool's cooldown answer and re-checks later when the pool cannot be read", async () => {
    const wait = await allowanceWait(`API Error: 429 ${COOLDOWN_BODY}`, {
      nowMs: NOW,
      readAuthFiles: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8317");
      },
    });
    expect(wait).toMatchObject({ untilMs: NOW + FALLBACK_WAIT_MS, source: "fallback" });
  });

  it("trusts the pool's cooldown answer when no login looks out (a per-model cooldown)", async () => {
    const wait = await allowanceWait(`API Error: 429 ${COOLDOWN_BODY}`, {
      nowMs: NOW,
      readAuthFiles: files(login({ name: "ok" })),
    });
    expect(wait).toMatchObject({ untilMs: NOW + FALLBACK_WAIT_MS, source: "fallback" });
  });

  it("does not wait on an ordinary 429 when the pool cannot be read", async () => {
    const wait = await allowanceWait("API Error: 429 rate_limit_error", {
      nowMs: NOW,
      readAuthFiles: async () => {
        throw new Error("401");
      },
    });
    expect(wait).toBeNull();
  });

  it("never treats a non-rate-limit failure as an empty pool, and does not ask the pool", async () => {
    let asked = false;
    const wait = await allowanceWait("reviewer marked HAS_BLOCKERS", {
      nowMs: NOW,
      readAuthFiles: async () => {
        asked = true;
        return { files: [login({ unavailable: true, next_retry_after: iso(NOW + HOUR) })] };
      },
    });
    expect(wait).toBeNull();
    expect(asked).toBe(false);
  });
});

/** A clock that only moves when the gate sleeps. */
function fakeClock(startMs: number) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

describe("createAllowanceGate", () => {
  it("lets the loop through at once while open", async () => {
    const clock = fakeClock(NOW);
    const gate = createAllowanceGate({ ...clock, log: () => undefined });
    await gate.waitWhileClosed(() => false);
    expect(clock.sleeps).toEqual([]);
  });

  it("holds the loop until the latest reset it was closed for, then resumes", async () => {
    const clock = fakeClock(NOW);
    const logs: string[] = [];
    const gate = createAllowanceGate({ ...clock, log: (l) => logs.push(l) });
    gate.close({ untilMs: NOW + 5 * 60_000, source: "pool", detail: "a" });
    gate.close({ untilMs: NOW + 2 * 60_000, source: "pool", detail: "b" });
    await gate.waitWhileClosed(() => false);
    expect(clock.now()).toBe(NOW + 5 * 60_000);
    expect(logs.join("\n")).toMatch(/resum/i);
  });

  it("wakes in slices so a shutdown is noticed while waiting hours", async () => {
    const clock = fakeClock(NOW);
    const gate = createAllowanceGate({ ...clock, log: () => undefined });
    gate.close({ untilMs: NOW + 5 * HOUR, source: "pool", detail: "a" });
    let checks = 0;
    await gate.waitWhileClosed(() => ++checks > 2);
    expect(clock.now()).toBeLessThan(NOW + 5 * HOUR);
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(60_000);
  });
});

describe("poolAuthFilesReader", () => {
  const KEY = "mgmt-key-never-printed";
  let dir: string;
  let keyFile: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sc-allowance-"));
    keyFile = path.join(dir, "pool-management-key");
    writeFileSync(keyFile, `${KEY}\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("asks the pool's management API at the agents' pool address, with the key", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const read = poolAuthFilesReader({
      baseUrl: "http://pool:8317/",
      keyFile,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get("authorization") });
        return new Response(JSON.stringify({ files: [] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(read).toBeDefined();
    expect(await read!()).toEqual({ files: [] });
    expect(calls).toEqual([
      { url: "http://pool:8317/v0/management/auth-files", auth: `Bearer ${KEY}` },
    ]);
  });

  it("fails with the status and never the key", async () => {
    const read = poolAuthFilesReader({
      baseUrl: "http://pool:8317",
      keyFile,
      fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    });
    const err = await read!().catch((e: Error) => e);
    expect(String(err)).toContain("401");
    expect(String(err)).not.toContain(KEY);
  });

  it("is absent when the loop has no pool address", () => {
    expect(poolAuthFilesReader({ baseUrl: undefined, keyFile })).toBeUndefined();
  });
});
