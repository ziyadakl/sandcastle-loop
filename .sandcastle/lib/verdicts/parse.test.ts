import { describe, expect, it } from "vitest";
import { MarkerNotFoundError, extractMarker } from "./parse.js";
import { COMPLETION_PROMISE, HALT_PROMISE } from "./markers.js";

/**
 * Regression cover for the 2026-08-05 run: all four issues failed within
 * seconds of each other with
 *
 *   Expected one of [CHECKS_WRITTEN, ALREADY_BUILT, NEEDS_WORLD_DATA,
 *   NO_SCREEN_APPLIES]. Last line was: "<promise>COMPLETE</promise>".
 *
 * Each agent had produced a valid marker; the SDK's end-of-turn token landed
 * one line below it and the last-non-empty-line rule read that instead.
 */
describe("extractMarker — the SDK completion signal is not a verdict", () => {
  const CHECK_WRITER = [
    "CHECKS_WRITTEN",
    "ALREADY_BUILT",
    "NEEDS_WORLD_DATA",
    "NO_SCREEN_APPLIES",
  ] as const;

  it("reads the marker when the completion signal trails it", () => {
    const text = `Working tree is clean, check is committed.\n\nCHECKS_WRITTEN\n${COMPLETION_PROMISE}\n`;
    expect(extractMarker(text, CHECK_WRITER)).toBe("CHECKS_WRITTEN");
  });

  it("works in strict mode too", () => {
    const text = `NEEDS_WORLD_DATA\n${COMPLETION_PROMISE}`;
    expect(extractMarker(text, CHECK_WRITER, { mode: "strict" })).toBe(
      "NEEDS_WORLD_DATA",
    );
  });

  it("skips several completion signals and trailing blank lines", () => {
    const text = `ALREADY_BUILT\n${COMPLETION_PROMISE}\n\n${COMPLETION_PROMISE}\n  \n`;
    expect(extractMarker(text, CHECK_WRITER)).toBe("ALREADY_BUILT");
  });

  it("tolerates leading/trailing whitespace around the signal line", () => {
    const text = `CHECKS_WRITTEN\n   ${COMPLETION_PROMISE}   \n`;
    expect(extractMarker(text, CHECK_WRITER)).toBe("CHECKS_WRITTEN");
  });

  it("still HALTs — the HALT promise is a verdict and must NOT be skipped", () => {
    const text = `I cannot proceed.\n${HALT_PROMISE}\n`;
    expect(extractMarker(text, ["HALT", "STORY_COMPLETE"] as const)).toBe(
      "HALT",
    );
  });

  it("prefers HALT over an earlier marker when both appear", () => {
    const text = `STORY_COMPLETE\n${HALT_PROMISE}\n${COMPLETION_PROMISE}\n`;
    expect(extractMarker(text, ["HALT", "STORY_COMPLETE"] as const)).toBe(
      "HALT",
    );
  });

  it("ignores prose the model appends BELOW the completion signal", () => {
    // The second shape seen on 2026-08-05: issue #761's check-writer emitted a
    // valid CHECKS_WRITTEN, then the token, then two lines of sign-off prose.
    const text = [
      "```json",
      '{ "marker": "CHECKS_WRITTEN", "inherited": true }',
      "```",
      "CHECKS_WRITTEN",
      COMPLETION_PROMISE,
      "Unverified: whether this inherited check actually fails.",
      "Skipped: nothing asked for.",
    ].join("\n");
    expect(extractMarker(text, CHECK_WRITER)).toBe("CHECKS_WRITTEN");
  });

  it("ignores post-turn prose in strict mode too", () => {
    const text = `NO_SCREEN_APPLIES\n${COMPLETION_PROMISE}\nSkipped: nothing.`;
    expect(extractMarker(text, CHECK_WRITER, { mode: "strict" })).toBe(
      "NO_SCREEN_APPLIES",
    );
  });

  it("cuts at the LAST completion signal when the agent ran several turns", () => {
    const text = [
      "CHECKS_WRITTEN",
      COMPLETION_PROMISE,
      "second turn reasoning",
      "NEEDS_WORLD_DATA",
      COMPLETION_PROMISE,
      "trailing sign-off",
    ].join("\n");
    expect(extractMarker(text, CHECK_WRITER)).toBe("NEEDS_WORLD_DATA");
  });

  it("HALT survives prose appended after it", () => {
    const text = `${HALT_PROMISE}\nUnverified: nothing.\nSkipped: nothing.`;
    expect(extractMarker(text, ["HALT", "STORY_COMPLETE"] as const)).toBe(
      "HALT",
    );
  });

  // -------------------------------------------------------------------------
  // The three real end-of-turn shapes captured in the 2026-08-05 logs. Strings
  // are verbatim from those logs. Shapes 1 and 2 were fixed by 7d11f84b and
  // 712de03a; shape 3 — sign-off prose ABOVE the completion token — still put
  // the ticket in the ground, because the prose survives the cut window and
  // became the last non-empty line.
  // -------------------------------------------------------------------------

  it("shape 1: MARKER then COMPLETE", () => {
    const text = ["NO_SCREEN_APPLIES", COMPLETION_PROMISE].join("\n");
    expect(extractMarker(text, CHECK_WRITER)).toBe("NO_SCREEN_APPLIES");
  });

  it("shape 2: MARKER then COMPLETE then Unverified: then Skipped:", () => {
    const text = [
      "NO_SCREEN_APPLIES",
      COMPLETION_PROMISE,
      "Unverified: whether the screen inventory is complete for this route.",
      "Skipped: nothing requested by this pass — no check file was needed given the NO_SCREEN_APPLIES outcome.",
    ].join("\n");
    expect(extractMarker(text, CHECK_WRITER)).toBe("NO_SCREEN_APPLIES");
  });

  it("shape 3: MARKER then Unverified: then Skipped: then COMPLETE", () => {
    // The shape still failing as of 2026-08-05. The sign-off sits ABOVE the
    // completion token, so cutting at the token keeps it, and
    //   Last line was: "Skipped: nothing requested by this pass — …"
    const text = [
      "NO_SCREEN_APPLIES",
      "Unverified: whether the screen inventory is complete for this route.",
      "Skipped: nothing requested by this pass — no check file was needed given the NO_SCREEN_APPLIES outcome.",
      COMPLETION_PROMISE,
    ].join("\n");
    expect(extractMarker(text, CHECK_WRITER)).toBe("NO_SCREEN_APPLIES");
  });

  it("shape 3 in strict mode too", () => {
    const text = [
      "CHECKS_WRITTEN",
      "Unverified: whether this inherited check actually fails.",
      "Skipped: nothing requested by this pass — no check file was needed given the NO_SCREEN_APPLIES outcome.",
      COMPLETION_PROMISE,
    ].join("\n");
    expect(extractMarker(text, CHECK_WRITER, { mode: "strict" })).toBe(
      "CHECKS_WRITTEN",
    );
  });

  it("shape 3 with no completion token at all (sign-off is simply last)", () => {
    const text = [
      "ALREADY_BUILT",
      "Note: the existing check already covers this screen.",
      "Skipped: nothing requested by this pass — no check file was needed given the NO_SCREEN_APPLIES outcome.",
    ].join("\n");
    expect(extractMarker(text, CHECK_WRITER)).toBe("ALREADY_BUILT");
  });

  it("steps over the other observed sign-off labels, rules and blank lines", () => {
    const text = [
      "NEEDS_WORLD_DATA",
      "",
      "---",
      "Verified: the fixture loads.",
      "Caveat: dates shift daily.",
      "Assumed: the practice world is seeded.",
      "**Note:** nothing else to report.",
      "- Skipped: nothing.",
      "",
      COMPLETION_PROMISE,
    ].join("\n");
    expect(extractMarker(text, CHECK_WRITER)).toBe("NEEDS_WORLD_DATA");
  });

  it("HALT survives sign-off prose sitting between it and the token", () => {
    const text = [
      HALT_PROMISE,
      "Unverified: nothing.",
      "Skipped: nothing.",
      COMPLETION_PROMISE,
    ].join("\n");
    expect(extractMarker(text, ["HALT", "STORY_COMPLETE"] as const)).toBe(
      "HALT",
    );
  });

  // --- the safety property: the walk must not become a marker hunt ---------

  it("refuses to reach BACK PAST real prose to find an earlier marker", () => {
    // The exact hazard the upward walk must not create: a marker the agent
    // talked itself out of, with real reasoning in between. The walk stops at
    // that reasoning line and fails, blaming it.
    const text = [
      "CHECKS_WRITTEN",
      "On reflection the screen does not exist yet, so I wrote nothing.",
      "Skipped: nothing requested by this pass.",
      COMPLETION_PROMISE,
    ].join("\n");
    try {
      extractMarker(text, CHECK_WRITER);
      throw new Error("expected extractMarker to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MarkerNotFoundError);
      expect((err as MarkerNotFoundError).lastLine).toBe(
        "On reflection the screen does not exist yet, so I wrote nothing.",
      );
    }
  });

  it("does not skip a sentence that merely STARTS with a sign-off word", () => {
    // "Skipped tests" has no colon — it is prose, not a label, so the walk
    // stops on it rather than stepping over it to the marker above.
    const text = [
      "CHECKS_WRITTEN",
      "Skipped tests are listed in the envelope above.",
      COMPLETION_PROMISE,
    ].join("\n");
    expect(() => extractMarker(text, CHECK_WRITER)).toThrow(
      MarkerNotFoundError,
    );
  });

  it("throws when sign-off prose is ALL there is", () => {
    const text = [
      "Unverified: whether any of this worked.",
      "Skipped: nothing requested by this pass.",
      COMPLETION_PROMISE,
    ].join("\n");
    expect(() => extractMarker(text, CHECK_WRITER)).toThrow(
      MarkerNotFoundError,
    );
  });

  it("still throws when a sign-off trails real prose and no marker exists", () => {
    const text = [
      "I got confused and stopped.",
      "Skipped: nothing requested by this pass.",
      COMPLETION_PROMISE,
    ].join("\n");
    try {
      extractMarker(text, CHECK_WRITER);
      throw new Error("expected extractMarker to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MarkerNotFoundError);
      expect((err as MarkerNotFoundError).lastLine).toBe(
        "I got confused and stopped.",
      );
    }
  });

  it("still throws when there is no marker at all, and blames the real line", () => {
    const text = `I got confused and stopped.\n${COMPLETION_PROMISE}\n`;
    try {
      extractMarker(text, CHECK_WRITER);
      throw new Error("expected extractMarker to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MarkerNotFoundError);
      // The reported line must be the agent's real last words, not the token —
      // otherwise every genuine failure reads as the same protocol noise.
      expect((err as MarkerNotFoundError).lastLine).toBe(
        "I got confused and stopped.",
      );
    }
  });

  it("throws when the completion signal is the ONLY content", () => {
    expect(() => extractMarker(COMPLETION_PROMISE, CHECK_WRITER)).toThrow(
      MarkerNotFoundError,
    );
  });
});
