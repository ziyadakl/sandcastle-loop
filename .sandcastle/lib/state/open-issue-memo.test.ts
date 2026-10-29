/**
 * The short-lived memo the `Blocked-by:` gate reads its 500-row open-issue
 * listing through. Three properties matter and each has its own failure mode:
 * it must COLLAPSE a burst (or the gate makes nine identical `gh` calls every
 * refill), it must NOT cache a failure (or one blip is replayed for the whole
 * window and the gate's own retry cannot reach `gh` again), and it must be
 * droppable on demand (or the deal-time gate cannot see a label the loop
 * itself just flipped).
 */
import { describe, expect, it, vi } from "vitest";

import { createMemo } from "./open-issue-memo.js";

describe("createMemo", () => {
  it("makes ONE fetch for two reads inside the TTL", async () => {
    const fetch = vi.fn(async () => ["rows"]);
    const memo = createMemo(fetch, { ttlMs: 30_000 });

    expect(await memo.read()).toEqual(["rows"]);
    expect(await memo.read()).toEqual(["rows"]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the TTL has passed", async () => {
    let now = 0;
    const fetch = vi.fn(async () => ["rows"]);
    const memo = createMemo(fetch, { ttlMs: 1_000, now: () => now });

    await memo.read();
    now = 999;
    await memo.read();
    expect(fetch).toHaveBeenCalledTimes(1);

    now = 1_000;
    await memo.read();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent reads of a cold memo", async () => {
    let release!: (rows: string[]) => void;
    const fetch = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const memo = createMemo(fetch, { ttlMs: 30_000 });

    const a = memo.read();
    const b = memo.read();
    // `fetch` is invoked a tick late on purpose (see the sync-throw case
    // below), so let the microtask queue drain before releasing it.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    release(["rows"]);

    expect(await a).toEqual(["rows"]);
    expect(await b).toEqual(["rows"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches NOTHING on failure — the next read reaches the source again", async () => {
    const fetch = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("gh boom"))
      .mockResolvedValue(["rows"]);
    const memo = createMemo(fetch, { ttlMs: 30_000 });

    await expect(memo.read()).rejects.toThrow("gh boom");
    expect(await memo.read()).toEqual(["rows"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not park a rejected promise when `fetch` throws SYNCHRONOUSLY", async () => {
    let boom = true;
    const fetch = vi.fn((): Promise<string[]> => {
      if (boom) throw new Error("sync boom");
      return Promise.resolve(["rows"]);
    });
    const memo = createMemo(fetch, { ttlMs: 30_000 });

    await expect(memo.read()).rejects.toThrow("sync boom");
    boom = false;
    expect(await memo.read()).toEqual(["rows"]);
  });

  it("invalidate() drops the cached value even inside the TTL", async () => {
    const fetch = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(["before"])
      .mockResolvedValue(["after"]);
    const memo = createMemo(fetch, { ttlMs: 30_000 });

    expect(await memo.read()).toEqual(["before"]);
    memo.invalidate();
    expect(await memo.read()).toEqual(["after"]);
  });
});
