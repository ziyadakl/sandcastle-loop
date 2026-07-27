/**
 * Tests for the Phase-2 wall-clock timing ledger (`.sandcastle/lib/cost/timing.ts`).
 *
 * Mirrors cost-ledger.test.ts: guards the pure aggregation (per-role cumulative
 * ms + run count) and the `timeRole` bracket's "never change control flow, never
 * throw the wrong thing, measure even on throw" contract.
 */
import { describe, it, expect } from "vitest";
import { TimingLedger, timeRole } from "../.sandcastle/lib/cost/timing.js";

describe("TimingLedger", () => {
  it("accumulates wallMs and runs per role across multiple adds", () => {
    const led = new TimingLedger();
    led.add("implementer", 100);
    led.add("implementer", 250);
    led.add("reviewer", 40);
    const s = led.summary();
    expect(s.implementer).toEqual({ wallMs: 350, runs: 2 });
    expect(s.reviewer).toEqual({ wallMs: 40, runs: 1 });
  });

  it("an empty ledger yields an empty summary", () => {
    expect(new TimingLedger().summary()).toEqual({});
  });

  it("counts a run even when its measured duration is zero", () => {
    const led = new TimingLedger();
    led.add("planner", 0);
    expect(led.summary().planner).toEqual({ wallMs: 0, runs: 1 });
  });

  it("clamps a negative/non-finite duration to 0 but still counts the run", () => {
    const led = new TimingLedger();
    led.add("merger", -50);
    led.add("merger", Number.NaN);
    expect(led.summary().merger).toEqual({ wallMs: 0, runs: 2 });
  });

  it("summary is present only for roles that received a dispatch", () => {
    const led = new TimingLedger();
    led.add("critique", 10);
    const s = led.summary();
    expect(Object.keys(s)).toEqual(["critique"]);
    expect(s.implementer).toBeUndefined();
  });
});

describe("timeRole", () => {
  it("records the elapsed delta from an injected fake clock", async () => {
    const led = new TimingLedger();
    let call = 0;
    const clock = () => [100, 350][call++]!; // start 100, end 350 → 250ms
    const out = await timeRole(led, "implementer", async () => "done", clock);
    expect(out).toBe("done");
    expect(led.summary().implementer).toEqual({ wallMs: 250, runs: 1 });
  });

  it("records timing even when fn throws, and re-throws the same error", async () => {
    const led = new TimingLedger();
    let call = 0;
    const clock = () => [1000, 1200][call++]!; // 200ms even though fn throws
    const boom = new Error("dispatch blew up");
    await expect(
      timeRole(led, "reviewer", async () => {
        throw boom;
      }, clock),
    ).rejects.toBe(boom);
    expect(led.summary().reviewer).toEqual({ wallMs: 200, runs: 1 });
  });

  it("is a pure no-op when the ledger is undefined and still returns fn's value", async () => {
    let clockCalls = 0;
    const clock = () => {
      clockCalls++;
      return 0;
    };
    const out = await timeRole(undefined, "planner", async () => 42, clock);
    expect(out).toBe(42);
    // undefined ledger short-circuits before ever reading the clock.
    expect(clockCalls).toBe(0);
  });

  it("defaults to Date.now() and records a non-negative real duration", async () => {
    const led = new TimingLedger();
    await timeRole(led, "merger", async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const s = led.summary().merger!;
    expect(s.runs).toBe(1);
    expect(s.wallMs).toBeGreaterThanOrEqual(0);
  });
});
