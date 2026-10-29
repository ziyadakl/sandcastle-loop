/** Issue #902 — the one-at-a-time merge lane. */
import { describe, expect, it, vi } from "vitest";

import { createSerialQueue } from "./serial-queue.js";

/** A promise plus its resolver, exposed for manual sequencing in tests. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createSerialQueue", () => {
  it("never overlaps two jobs — the second only starts after the first has fully exited", async () => {
    const order: string[] = [];
    const first = deferred();
    const q = createSerialQueue({ logError: vi.fn() });

    const jobOne = q.enqueue(async () => {
      order.push("one:enter");
      await first.promise;
      order.push("one:exit");
    }, "one");
    const jobTwo = q.enqueue(async () => {
      order.push("two:enter");
      order.push("two:exit");
    }, "two");

    // Give job one's synchronous "enter" a tick to run.
    await Promise.resolve();
    expect(order).toEqual(["one:enter"]);

    first.resolve();
    await Promise.all([jobOne, jobTwo]);
    expect(order).toEqual(["one:enter", "one:exit", "two:enter", "two:exit"]);
  });

  it("logs a throwing job and does not poison the lane for the next one", async () => {
    const logError = vi.fn();
    const q = createSerialQueue({ logError });
    const order: string[] = [];

    await q.enqueue(async () => {
      order.push("bad");
      throw new Error("boom");
    }, "bad-job");
    await q.enqueue(async () => {
      order.push("good");
    }, "good-job");

    expect(order).toEqual(["bad", "good"]);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("bad-job threw: boom"),
    );
  });

  it("drain() resolves only after the last enqueued job has settled", async () => {
    const q = createSerialQueue({ logError: vi.fn() });
    const last = deferred();
    let lastRan = false;

    q.enqueue(async () => {});
    q.enqueue(async () => {
      await last.promise;
      lastRan = true;
    });

    let drained = false;
    const drainPromise = q.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);

    last.resolve();
    await drainPromise;
    expect(drained).toBe(true);
    expect(lastRan).toBe(true);
  });

  it("pending() counts jobs enqueued or running, dropping to zero once all settle", async () => {
    const q = createSerialQueue({ logError: vi.fn() });
    const d1 = deferred();
    const d2 = deferred();

    const p1 = q.enqueue(async () => {
      await d1.promise;
    });
    const p2 = q.enqueue(async () => {
      await d2.promise;
    });
    expect(q.pending()).toBe(2);

    d1.resolve();
    await p1;
    expect(q.pending()).toBe(1);

    d2.resolve();
    await p2;
    expect(q.pending()).toBe(0);
  });
});
