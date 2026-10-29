import { describe, expect, it } from "vitest";

import {
  parseRefusalRecord,
  REFUSAL_OUTCOME_ANCHOR,
  renderRefusalOutcomeCheckbox,
} from "./refusal.js";

describe("renderRefusalOutcomeCheckbox — the stamp the loop writes on a refusal", () => {
  it("carries the anchor, two empty task-list boxes, and the one-line why", () => {
    const stamp = renderRefusalOutcomeCheckbox("reviewer marked HAS_BLOCKERS after three attempts");
    expect(stamp).toContain(REFUSAL_OUTCOME_ANCHOR);
    expect(stamp).toContain("- [ ] correct");
    expect(stamp).toContain("- [ ] wrong");
    expect(stamp).toContain("Why it was refused: reviewer marked HAS_BLOCKERS after three attempts");
  });

  it("never leaves the why line blank — an empty reason reads as (not recorded)", () => {
    expect(renderRefusalOutcomeCheckbox("   ")).toContain("Why it was refused: (not recorded)");
  });
});

describe("parseRefusalRecord — reading the outcome back off a closed ticket", () => {
  const withBoxes = (correct: string, wrong: string): string =>
    [
      "## Stopped: the reviewer refused the code",
      "",
      "**Run:** night-42",
      "**When:** 2026-08-25T02:00:00.000Z",
      "",
      renderRefusalOutcomeCheckbox("reviewer refused").replace("- [ ] correct", `- [${correct}] correct`).replace("- [ ] wrong", `- [${wrong}] wrong`),
    ].join("\n");

  it("returns undefined for a ticket with no refusal stamp at all", () => {
    expect(parseRefusalRecord("An ordinary ticket description.")).toBeUndefined();
  });

  it("reads an unjudged refusal — stamped, but no box ticked", () => {
    const rec = parseRefusalRecord(withBoxes(" ", " "));
    expect(rec?.outcome).toBe("unjudged");
    expect(rec?.runId).toBe("night-42");
    expect(rec?.whenIso).toBe("2026-08-25T02:00:00.000Z");
  });

  it("reads a refusal ticked correct", () => {
    expect(parseRefusalRecord(withBoxes("x", " "))?.outcome).toBe("correct");
  });

  it("reads a refusal ticked wrong — the finding that makes this worth building", () => {
    expect(parseRefusalRecord(withBoxes(" ", "x"))?.outcome).toBe("wrong");
  });

  it("accepts an uppercase X, as a hand edit may leave", () => {
    expect(parseRefusalRecord(withBoxes("X", " "))?.outcome).toBe("correct");
  });

  it("counts both-boxes-ticked as ambiguous rather than guessing", () => {
    expect(parseRefusalRecord(withBoxes("x", "x"))?.outcome).toBe("ambiguous");
  });
});
