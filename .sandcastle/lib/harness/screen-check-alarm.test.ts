import { describe, expect, it } from "vitest";

import {
  createScreenCheckAlarmGate,
  isSystemicScreenCheckVerdict,
} from "./screen-check-alarm.js";
import {
  LOUD_STOP_REASONS,
  mapHarnessVerdictToStopReason,
} from "../state/stop-reasons.js";

// ---------------------------------------------------------------------------
// 2026-08-04 review, BLOCKER 1. A red screen check calls
// `reportScreenCheckWatch`, which deliberately raises no alarm for a
// per-ticket verdict. That is right for a wrong figure, and wrong for the
// rest. "The dev server never started" is not a
// per-ticket judgement whose false-alarm rate anybody is measuring; it is the
// same failure repeating on every ticket of the night, and the failure mode is
// eight tickets shipping unproven while the owner finds out next morning.
// ---------------------------------------------------------------------------

describe("isSystemicScreenCheckVerdict — which failures are the night's, not the ticket's", () => {
  it("the three no-evidence-at-all verdicts are systemic", () => {
    expect(isSystemicScreenCheckVerdict("never-settled")).toBe(true);
    expect(isSystemicScreenCheckVerdict("environment-fault")).toBe(true);
    expect(isSystemicScreenCheckVerdict("inconclusive")).toBe(true);
  });

  it("a wrong-figure disagreement is NOT systemic — it is the per-ticket judgement being measured", () => {
    expect(isSystemicScreenCheckVerdict("graded-mismatch")).toBe(false);
  });

  it("claim-mismatch is NOT systemic — the app booted, rendered, and declared a claim", () => {
    // It settled and said which screen it was showing; what disagreed is
    // WHICH screen, which is as often the check-writer naming a route that
    // redirects as it is a broken app. The three above produced no usable
    // evidence at all.
    expect(isSystemicScreenCheckVerdict("claim-mismatch")).toBe(false);
  });

  it("a match is never systemic", () => {
    expect(isSystemicScreenCheckVerdict("match")).toBe(false);
  });
});

describe("createScreenCheckAlarmGate — one broken night raises one alarm, not forty", () => {
  it("the first systemic verdict alarms", () => {
    const gate = createScreenCheckAlarmGate();
    expect(gate("never-settled")).toEqual({ alarm: true, suppressedCount: 0 });
  });

  it("every systemic verdict after the first is suppressed and counted", () => {
    const gate = createScreenCheckAlarmGate();
    gate("never-settled");
    expect(gate("environment-fault")).toEqual({
      alarm: false,
      suppressedCount: 1,
    });
    expect(gate("inconclusive")).toEqual({ alarm: false, suppressedCount: 2 });
  });

  it("a wrong-figure verdict never alarms, and never consumes the one alarm", () => {
    const gate = createScreenCheckAlarmGate();
    expect(gate("graded-mismatch")).toEqual({ alarm: false, suppressedCount: 0 });
    expect(gate("claim-mismatch")).toEqual({ alarm: false, suppressedCount: 0 });
    // The night's first REAL infrastructure failure still gets its alarm.
    expect(gate("never-settled")).toEqual({ alarm: true, suppressedCount: 0 });
  });

  it("two gates are independent — one run's alarm never silences another's", () => {
    const a = createScreenCheckAlarmGate();
    const b = createScreenCheckAlarmGate();
    a("never-settled");
    expect(b("never-settled").alarm).toBe(true);
  });
});

describe("the systemic split lines up with the stop labels it stands in for", () => {
  it("every systemic verdict maps to a stop reason that is LOUD", () => {
    // The verdicts that alarm are exactly the ones whose old stop label was
    // already loud — the alarm never makes more noise than the stop did.
    for (const verdict of [
      "never-settled",
      "environment-fault",
      "inconclusive",
    ] as const) {
      const label = mapHarnessVerdictToStopReason(verdict);
      expect(label).toBeDefined();
      expect(LOUD_STOP_REASONS.has(label!)).toBe(true);
    }
  });
});
