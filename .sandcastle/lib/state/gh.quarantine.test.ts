/**
 * Issue #1150 — the terminal-label split.
 *
 * Before #1150 every loop stop wrote ONE terminal status label, `needs-human`,
 * whether the loop itself failed or a person genuinely had to act. That made
 * "the loop broke" and "a human/config handoff" indistinguishable at a glance.
 * `quarantineTerminalLabel` is the pure decision that splits them: a loop
 * FAILURE defaults to `quarantine`; `needs-human` is reserved for owner/config
 * handoffs (`{ handoff: true }`) and for the stop labels only the owner can
 * settle (`OWNER_DECISION_STOP_REASONS`).
 *
 * The decision is a pure function so it can be pinned without shelling out to
 * `gh` — `quarantineViaLabel` calls it to choose which label `transitionLabel`
 * targets, and `transitionLabel` uses the module-level (real) `runGh`.
 */
import { describe, expect, it } from "vitest";

import {
  LABEL_NEEDS_HUMAN,
  LABEL_QUARANTINE_LEGACY,
  quarantineTerminalLabel,
} from "./gh.js";
import {
  OWNER_DECISION_STOP_REASONS,
  STOP_REASON_LABELS,
} from "./stop-reasons.js";

describe("quarantineTerminalLabel — #1150 loop-failure vs owner/config handoff", () => {
  it("defaults to `quarantine` with no options — a loop failure", () => {
    expect(quarantineTerminalLabel()).toBe(LABEL_QUARANTINE_LEGACY);
    expect(quarantineTerminalLabel({})).toBe(LABEL_QUARANTINE_LEGACY);
  });

  it("`handoff: true` forces `needs-human` — a person or config must act", () => {
    expect(quarantineTerminalLabel({ handoff: true })).toBe(LABEL_NEEDS_HUMAN);
  });

  it("`handoff: false` is still a loop failure → `quarantine`", () => {
    expect(quarantineTerminalLabel({ handoff: false })).toBe(
      LABEL_QUARANTINE_LEGACY,
    );
  });

  it("an owner-decision stop label routes to `needs-human`", () => {
    expect(quarantineTerminalLabel({ stopLabel: "stopped:ticket-unclear" })).toBe(
      LABEL_NEEDS_HUMAN,
    );
  });

  it("a first-test disagreement is a loop failure, never an owner handoff (spec #1334)", () => {
    expect(
      quarantineTerminalLabel({ stopLabel: "stopped:check-disagreement" }),
    ).toBe(LABEL_QUARANTINE_LEGACY);
  });

  it("a non-owner-decision stop label stays `quarantine`", () => {
    expect(quarantineTerminalLabel({ stopLabel: "stopped:weak-check" })).toBe(
      LABEL_QUARANTINE_LEGACY,
    );
    expect(quarantineTerminalLabel({ stopLabel: "stopped:run-fault" })).toBe(
      LABEL_QUARANTINE_LEGACY,
    );
  });

  it("matches OWNER_DECISION_STOP_REASONS for EVERY stop label — one rule, no second table to drift", () => {
    for (const label of STOP_REASON_LABELS) {
      const expected = OWNER_DECISION_STOP_REASONS.has(label)
        ? LABEL_NEEDS_HUMAN
        : LABEL_QUARANTINE_LEGACY;
      expect(quarantineTerminalLabel({ stopLabel: label })).toBe(expected);
    }
  });

  it("`handoff: true` wins even when the stop label alone would not — a config gap is a handoff", () => {
    expect(
      quarantineTerminalLabel({ handoff: true, stopLabel: "stopped:run-fault" }),
    ).toBe(LABEL_NEEDS_HUMAN);
  });
});
