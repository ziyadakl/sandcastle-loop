/** Issue #902 — the completion-order breaker (two counters, mutated in the
 *  order completions actually finish, not in round order). */
import { describe, expect, it } from "vitest";

import { createCompletionBreaker } from "./breaker.js";

const LIMITS = { failureLimit: 3, quarantineLimit: 3, stallLimit: 3 };

describe("quarantine counter", () => {
  it("Q Q ship Q Q Q trips on the sixth note, a ship having reset the streak", () => {
    const b = createCompletionBreaker(LIMITS);
    expect(b.note("quarantine")).toBeUndefined(); // 1
    expect(b.note("quarantine")).toBeUndefined(); // 2
    expect(b.note("ship")).toBeUndefined(); // resets to 0
    expect(b.note("quarantine")).toBeUndefined(); // 1
    expect(b.note("quarantine")).toBeUndefined(); // 2
    const trip = b.note("quarantine"); // 3 → trip
    expect(trip).toEqual({
      kind: "quarantine",
      count: 3,
      limit: 3,
      flag: "--quarantine-limit",
    });
  });
});

describe("defer and skip", () => {
  it("touch neither counter", () => {
    const b = createCompletionBreaker(LIMITS);
    b.note("quarantine");
    b.note("error");
    b.note("defer");
    b.note("skip");
    b.note("defer");
    b.note("skip");
    expect(b.counters()).toEqual({ failures: 1, quarantines: 1, stalls: 0 });
    expect(b.tripped()).toBeUndefined();
  });

  it("skip does not even reset the stall streak", () => {
    const b = createCompletionBreaker(LIMITS);
    b.note("error", { stalled: true });
    b.note("skip");
    expect(b.counters().stalls).toBe(1);
  });
});

describe("failure counter", () => {
  it("three consecutive error notes trip a failure", () => {
    const b = createCompletionBreaker(LIMITS);
    expect(b.note("error")).toBeUndefined();
    expect(b.note("error")).toBeUndefined();
    const trip = b.note("error");
    expect(trip).toEqual({
      kind: "failure",
      count: 3,
      limit: 3,
      flag: "--consecutive-failure-limit",
    });
  });
});

describe("stall detector", () => {
  it("a stalled streak of stallLimit trips regardless of completion kind", () => {
    const b = createCompletionBreaker(LIMITS);
    expect(b.note("ship", { stalled: true })).toBeUndefined();
    expect(b.note("quarantine", { stalled: true })).toBeUndefined();
    const trip = b.note("error", { stalled: true });
    expect(trip).toEqual({
      kind: "stall",
      count: 3,
      limit: 3,
      flag: "(sandbox health)",
    });
  });

  it("a non-stalled completion resets the streak", () => {
    const b = createCompletionBreaker(LIMITS);
    b.note("ship", { stalled: true });
    b.note("ship", { stalled: true });
    b.note("ship", { stalled: false });
    expect(b.counters().stalls).toBe(0);
    expect(b.note("ship", { stalled: true })).toBeUndefined();
    expect(b.counters().stalls).toBe(1);
  });
});

describe("latching", () => {
  it("the first trip is never overwritten by a later ship", () => {
    const b = createCompletionBreaker(LIMITS);
    b.note("error");
    b.note("error");
    const trip = b.note("error");
    expect(trip?.kind).toBe("failure");
    const after = b.note("ship");
    expect(after).toBe(trip); // still the original trip object, unchanged
    expect(b.tripped()).toBe(trip);
  });
});
