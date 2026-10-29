/** Issue #902 — the ranked refill stack behind the rolling worker pool. */
import { describe, expect, it, vi } from "vitest";

import type { DealerCard } from "./dealer.js";
import { createDealer } from "./dealer.js";

const c = (n: number): DealerCard => ({
  id: String(n),
  title: `t${n}`,
  branch: `agent/issue-${n}`,
});

describe("createDealer", () => {
  it("deals from the top, calls plan once per empty stack, skips a card validate rejects", async () => {
    const plans = [[c(1), c(2), c(3)], []];
    const planCalls: number[] = [];
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async ({ deal }) => {
          planCalls.push(deal);
          return plans.shift() ?? [];
        },
        validate: async (card) => card.id !== "2",
      },
    });
    expect(await d.next()).toEqual(c(1));
    expect(await d.next()).toEqual(c(3));
    const p = d.next();
    d.done(c(1));
    d.done(c(3));
    expect(await p).toBeNull();
    expect(planCalls).toEqual([1, 2]);
  });

  it("single-flight: two concurrent next() calls on an empty stack trigger one plan() call", async () => {
    let planCalls = 0;
    let resolvePlan!: (cards: DealerCard[]) => void;
    const planPromise = new Promise<DealerCard[]>((resolve) => {
      resolvePlan = resolve;
    });
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async () => {
          planCalls += 1;
          return planPromise;
        },
      },
    });
    const first = d.next();
    const second = d.next();
    expect(planCalls).toBe(1);
    resolvePlan([c(1), c(2)]);
    expect(await first).toEqual(c(1));
    expect(await second).toEqual(c(2));
  });

  it("drops a card the plan re-offers while it is already in flight", async () => {
    const plans = [[c(1)], [c(1), c(2)]];
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async () => plans.shift() ?? [],
      },
    });
    expect(await d.next()).toEqual(c(1)); // c(1) now in flight
    // Second deal re-offers c(1) (still in the planner's ranked list) plus c(2);
    // c(1) must be dropped as a dupe, only c(2) reaches the stack.
    expect(await d.next()).toEqual(c(2));
  });

  it("truncates a plan's cards to stackSize", async () => {
    const d = createDealer({
      stackSize: 2,
      deps: {
        plan: async () => [c(1), c(2), c(3)],
      },
    });
    expect(await d.next()).toEqual(c(1));
    expect(await d.next()).toEqual(c(2));
    expect(d.stack()).toEqual([]);
  });

  it("treats a throwing validate as valid (fail-open)", async () => {
    const log = vi.fn();
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async () => [c(1)],
        validate: async () => {
          throw new Error("gh flaked");
        },
        log,
      },
    });
    expect(await d.next()).toEqual(c(1));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("validate #1 threw"),
    );
  });

  it("parks until done() when the stack is empty but siblings are still in flight, then re-plans", async () => {
    // Plan #1 hands out c(1). Plan #2 (triggered while c(1) is in flight)
    // comes back empty, so the second worker must park rather than exit —
    // c(1) is still in flight, so the pool is not drained. Only once `done()`
    // frees that slot does a THIRD plan call (re-plan) hand out c(2).
    const plans = [[c(1)], [], [c(2)]];
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async () => plans.shift() ?? [],
      },
    });
    const one = await d.next(); // c(1) in flight, stack now empty
    expect(one).toEqual(c(1));

    let parkedResolved = false;
    const parked = d.next().then((card) => {
      parkedResolved = true;
      return card;
    });
    // Drain the microtask queue a generous number of times: the parked call's
    // own plan() (#2, empty) must settle and it must reach `waitForCompletion`
    // — still unresolved — before `done()` is called below.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(parkedResolved).toBe(false);

    d.done(one!);
    expect(await parked).toEqual(c(2));
    expect(parkedResolved).toBe(true);
  });

  it("wakes EVERY parked worker, not just the last one to park (Opus review blocker)", async () => {
    // One card in flight, three siblings park on an empty stack (every plan
    // call after the first comes back empty — nothing new to deal). A single
    // `done()` must resolve all three, not strand any but the most recently
    // parked one behind a clobbered resolver.
    const plans: DealerCard[][] = [[c(1)]];
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async () => plans.shift() ?? [],
      },
    });
    const one = await d.next();
    expect(one).toEqual(c(1));

    const settled: Array<DealerCard | null> = [];
    const parkedPromises = [d.next(), d.next(), d.next()].map((p) =>
      p.then((card) => {
        settled.push(card);
        return card;
      }),
    );

    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(settled).toEqual([]);

    d.done(one!);

    // None of the three may hang forever — race each against a short timer.
    const timeout = Symbol("timeout");
    const withTimeout = (p: Promise<unknown>) =>
      Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => resolve(timeout), 200)),
      ]);
    const results = await Promise.all(parkedPromises.map(withTimeout));
    expect(results.every((r) => r !== timeout)).toBe(true);
    // Nothing is in flight and the plan is exhausted, so every parked call
    // resolves to null (drained) once the one in-flight card is freed.
    expect(results).toEqual([null, null, null]);
  });

  it("returns null again on a later call once already drained, re-consulting the planner", async () => {
    let planCalls = 0;
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async () => {
          planCalls += 1;
          return [];
        },
      },
    });
    expect(await d.next()).toBeNull();
    expect(await d.next()).toBeNull();
    // Draining is NOT latched: each call re-asks the planner (a `Blocked-by:`
    // dependent can become freshly dealable between calls).
    expect(planCalls).toBe(2);
  });

  it("#1191 finding C: an empty plan with a merge pending drains the lane and re-plans before giving up", async () => {
    // Nothing in flight, stack empty, plan comes back empty — the naive read
    // is "queue drained". But a merge is still queued on the separate merge
    // lane (a sibling ticket's blocker landing), and once it drains the very
    // same planner call would offer up the now-unblocked dependent. The
    // dealer must drain the lane and give the planner one more shot before
    // returning null.
    const plans = [[], [c(1)]];
    let drained = false;
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async () => plans.shift() ?? [],
        pendingMerges: () => (drained ? 0 : 1),
        drainMerges: async () => {
          drained = true;
        },
      },
    });
    expect(await d.next()).toEqual(c(1));
  });

  it("#1191 finding C: no pending merge and an empty plan returns null without draining", async () => {
    let drainCalls = 0;
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async () => [],
        pendingMerges: () => 0,
        drainMerges: async () => {
          drainCalls += 1;
        },
      },
    });
    expect(await d.next()).toBeNull();
    expect(drainCalls).toBe(0);
  });

  it("reserves a card in-flight the instant it leaves the stack, before validate() has a chance to yield (found while testing #1191 finding A)", async () => {
    // A one-card queue and two concurrent `next()` calls (the exact shape a
    // `maxConcurrent: 2` pool with a single dealable ticket produces): the
    // FIRST call to actually take the card off the stack must be reflected
    // in `inFlight` synchronously, in the same tick — otherwise the SECOND
    // call's "stack empty AND nothing in flight" check can land in the gap
    // between the shift and the reservation and wrongly conclude the queue
    // is drained, when the card is in fact still being claimed. A `validate`
    // that never resolves pins the gap open for as long as possible; if the
    // second call still parks (rather than returning null) with `validate`
    // stuck, the reservation happened before `validate` was ever awaited.
    let resolveValidate!: (ok: boolean) => void;
    const validateGate = new Promise<boolean>((r) => {
      resolveValidate = r;
    });
    const plans = [[c(1)], []];
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan: async () => plans.shift() ?? [],
        validate: async () => validateGate,
      },
    });
    const first = d.next();
    const second = d.next();

    let secondSettled: DealerCard | null | undefined;
    void second.then((card) => {
      secondSettled = card;
    });
    // Give the second call every chance to (wrongly) resolve to null before
    // validate() ever settles.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(secondSettled).toBeUndefined(); // still parked, not drained

    resolveValidate(true);
    expect(await first).toEqual(c(1));
    d.done((await first)!);
    expect(await second).toBeNull(); // now genuinely drained
  });

  // -------------------------------------------------------------------------
  // The barren-refill guard. Found while proving the `Blocked-by:` code gate
  // (2026-09-03): a per-card gate that refuses EVERY card — a `gh` outage
  // making the blocker gate fail closed on every pick — left `next()` in a
  // tight plan→refuse→plan loop that dispatched the planner LLM forever,
  // because no ticket is ever attempted and the ticket cap is never reached.
  // A test run with that shape hung for over ten minutes before it was killed.
  // -------------------------------------------------------------------------
  it("stops re-planning when every card of two refills in a row is refused (nothing in flight → drained)", async () => {
    // The fake planner REFUSES to be asked more than a handful of times, so a
    // lost guard fails this test in milliseconds instead of hanging the pool
    // worker until vitest kills it (which is exactly what happened before the
    // guard existed).
    const plan = vi.fn(async () => {
      if (plan.mock.calls.length > 12) {
        throw new Error(
          "planner asked 13+ times for the same refused cards — the barren-refill guard is not holding",
        );
      }
      return [c(1), c(2)];
    });
    const d = createDealer({
      stackSize: 4,
      deps: { plan, validate: async () => false },
    });

    expect(await d.next()).toBeNull();
    // Bounded, not unbounded: the planner is asked a small fixed number of
    // times and then the pass ends. Before the guard this never terminated.
    expect(plan.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("parks instead of ending the pass when everything is refused but a sibling is still in flight", async () => {
    let refuse = false;
    const plan = vi.fn(async () => {
      if (plan.mock.calls.length > 12) {
        throw new Error(
          "planner asked 13+ times for the same refused cards — the barren-refill guard is not holding",
        );
      }
      return refuse ? [c(2)] : [c(1), c(2)];
    });
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan,
        // #1 is dealable; #2 never is.
        validate: async (card) => card.id === "1",
      },
    });

    const first = await d.next();
    expect(first).toEqual(c(1));
    refuse = true;

    // #1 is still in flight, so a second worker asking for work must PARK on
    // a completion rather than either spinning on the planner or wrongly
    // declaring the queue drained.
    let settled: DealerCard | null | undefined;
    void d.next().then((card) => {
      settled = card;
    });
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    expect(settled).toBeUndefined();
    const plannerCallsWhileParked = plan.mock.calls.length;

    d.done(first!);
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    expect(settled).toBeNull(); // woken, re-checked, genuinely drained
    // Waking re-plans, but the guard keeps even that bounded.
    expect(plan.mock.calls.length).toBeLessThanOrEqual(
      plannerCallsWhileParked + 3,
    );
  });

  it("keeps a card the tripping refill had never offered — the barren trip drops only what THIS call refused", async () => {
    // The refill that trips the guard is exactly where a freshly-dealable
    // ticket appears: a `Blocked-by:` dependent becomes workable the moment
    // its blocker's label flips, which can happen between two refills. A
    // blanket `stack.length = 0` on the trip threw that card away without
    // ever offering it to `validate`, and then parked.
    const offered: string[] = [];
    const plan = vi.fn(async () => {
      if (plan.mock.calls.length > 12) {
        throw new Error(
          "planner asked 13+ times — the barren-refill guard is not holding",
        );
      }
      // The third refill — the one that trips the guard — also carries #9,
      // which nothing has looked at yet.
      return plan.mock.calls.length >= 3 ? [c(1), c(9)] : [c(1)];
    });
    const d = createDealer({
      stackSize: 4,
      deps: {
        plan,
        // #1 is never dealable; #9 always is.
        validate: async (card) => {
          offered.push(card.id);
          return card.id === "9";
        },
      },
    });

    // Without the fix this returns null: #9 was cleared unexamined.
    expect(await d.next()).toEqual(c(9));
    // #9 was offered to `validate` rather than swept off the stack with the
    // cards that had already been refused.
    expect(offered).toContain("9");
  });

  it("throws when constructed with stackSize < 1", () => {
    expect(() =>
      createDealer({ stackSize: 0, deps: { plan: async () => [] } }),
    ).toThrow("createDealer: stackSize must be ≥ 1");
  });
});
