/**
 * Track B unit tests for src/verdicts/.
 *
 * Coverage requirements (from the track B brief):
 *   - valid implementer/reviewer/fixer/recovery outputs parse cleanly
 *   - missing marker fails loud (throws, no silent fallback)
 *   - markdown-decorated marker still extracts in tolerant mode
 *   - markdown-decorated marker FAILS in strict mode
 *   - multi-line content with marker buried mid-stream is rejected
 *     (only last-non-empty-line wins)
 *   - free-text mention of "ALL_CLEAR" earlier in the response does NOT count
 */

import { describe, it, expect } from "vitest";
import {
  IMPLEMENTER_MARKERS,
  REVIEWER_MARKERS,
  FIXER_MARKERS,
  RECOVERY_MARKERS,
  HALT_PROMISE,
  ImplementerOutputSchema,
  ReviewerVerdictSchema,
  FixerVerdictSchema,
  RecoveryDecisionSchema,
  extractMarker,
  extractAssistantText,
  parseVerdict,
  MarkerNotFoundError,
  VerdictParseError,
} from "../src/verdicts/index.js";

// ---------------------------------------------------------------------------
// Helpers — synthesize realistic claude stream-json blobs
// ---------------------------------------------------------------------------

function streamJson(...textChunks: string[]): string {
  return textChunks
    .map((text) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text }],
        },
      }),
    )
    .join("\n");
}

function streamJsonWithNoise(textChunks: string[], noise: string[]): string {
  // Interleave non-JSON noise lines + system envelopes among assistant lines
  // to verify the extractor ignores them.
  const out: string[] = [];
  textChunks.forEach((text, i) => {
    if (noise[i] !== undefined) out.push(noise[i]);
    out.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      }),
    );
  });
  // Always include a non-assistant envelope and a non-JSON line.
  out.push(JSON.stringify({ type: "system", subtype: "init" }));
  out.push("DEBUG: not json");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// extractAssistantText
// ---------------------------------------------------------------------------

describe("extractAssistantText", () => {
  it("concatenates text blocks from assistant envelopes in stream order", () => {
    const blob = streamJson("hello ", "world\n", "DONE");
    expect(extractAssistantText(blob)).toBe("hello world\nDONE");
  });

  it("skips non-assistant envelopes and non-JSON lines", () => {
    const blob = streamJsonWithNoise(
      ["only ", "this counts"],
      ["DEBUG line", "RANDOM"],
    );
    expect(extractAssistantText(blob)).toBe("only this counts");
  });

  it("returns empty string when nothing matches", () => {
    expect(extractAssistantText("DEBUG: line\nDEBUG: another\n")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractMarker — tolerant mode
// ---------------------------------------------------------------------------

describe("extractMarker (tolerant)", () => {
  it("extracts a bare marker on the last line", () => {
    expect(
      extractMarker("did the work\n\nALL_CLEAR\n", REVIEWER_MARKERS),
    ).toBe("ALL_CLEAR");
  });

  it("tolerates **markdown bold** decoration (bash awk parity)", () => {
    expect(
      extractMarker("...review summary...\n\n**ALL_CLEAR**", REVIEWER_MARKERS),
    ).toBe("ALL_CLEAR");
  });

  it("tolerates ### heading decoration", () => {
    expect(
      extractMarker("findings\n\n### HAS_BLOCKERS", REVIEWER_MARKERS),
    ).toBe("HAS_BLOCKERS");
  });

  it("tolerates blockquote prefix", () => {
    expect(extractMarker("notes\n> FIXED", FIXER_MARKERS)).toBe("FIXED");
  });

  it("recognizes <promise>HALT</promise> on its own line", () => {
    const text = "I tried but the migration is broken.\n\n<promise>HALT</promise>\n";
    expect(extractMarker(text, IMPLEMENTER_MARKERS)).toBe("HALT");
  });

  it("strips trailing whitespace and punctuation only at the edges", () => {
    expect(
      extractMarker("blah\n\n  RECOVERY_COMPLETE  ", RECOVERY_MARKERS),
    ).toBe("RECOVERY_COMPLETE");
  });

  it("REJECTS marker buried in the middle (only last non-empty line wins)", () => {
    const text = [
      "I'll start by saying ALL_CLEAR but actually...",
      "...there are issues.",
      "",
      "HAS_BLOCKERS",
    ].join("\n");
    expect(extractMarker(text, REVIEWER_MARKERS)).toBe("HAS_BLOCKERS");
  });

  it("REJECTS free-text mention of marker word in last line", () => {
    const text =
      "the build is mostly clear and would be ALL_CLEAR if the test passed\n";
    expect(() => extractMarker(text, REVIEWER_MARKERS)).toThrow(
      MarkerNotFoundError,
    );
  });

  it("REJECTS empty input", () => {
    expect(() => extractMarker("", REVIEWER_MARKERS)).toThrow(
      MarkerNotFoundError,
    );
    expect(() => extractMarker("\n\n\n", REVIEWER_MARKERS)).toThrow(
      MarkerNotFoundError,
    );
  });

  it("does NOT silently fall through to a default (fails loud)", () => {
    // The key bug from the bash version was returning HAS_BLOCKERS by default
    // when no marker was found. We must throw instead.
    let caught: unknown;
    try {
      extractMarker("ambiguous reasoning text", REVIEWER_MARKERS);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MarkerNotFoundError);
  });

  it("does NOT unwrap <promise>HALT</promise> via generic punctuation strip", () => {
    // If we accidentally stripped < and > we'd accept "<promise>STORY_COMPLETE</promise>"
    // as STORY_COMPLETE. That should fail.
    const bad = "...\n<promise>STORY_COMPLETE</promise>\n";
    expect(() => extractMarker(bad, IMPLEMENTER_MARKERS)).toThrow(
      MarkerNotFoundError,
    );
  });

  it("includes preview and last line in MarkerNotFoundError", () => {
    try {
      extractMarker("nope", REVIEWER_MARKERS);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MarkerNotFoundError);
      const e = err as MarkerNotFoundError;
      expect(e.lastLine).toBe("nope");
      expect(e.allowed).toEqual(REVIEWER_MARKERS);
    }
  });
});

// ---------------------------------------------------------------------------
// extractMarker — strict mode
// ---------------------------------------------------------------------------

describe("extractMarker (strict)", () => {
  it("accepts a bare marker on its own line", () => {
    expect(
      extractMarker("...\nALL_CLEAR\n", REVIEWER_MARKERS, { mode: "strict" }),
    ).toBe("ALL_CLEAR");
  });

  it("accepts the bare <promise>HALT</promise> element", () => {
    expect(
      extractMarker(`done\n${HALT_PROMISE}\n`, IMPLEMENTER_MARKERS, {
        mode: "strict",
      }),
    ).toBe("HALT");
  });

  it("REJECTS markdown-decorated marker", () => {
    expect(() =>
      extractMarker("ok\n**ALL_CLEAR**", REVIEWER_MARKERS, { mode: "strict" }),
    ).toThrow(MarkerNotFoundError);
  });

  it("REJECTS heading-decorated marker", () => {
    expect(() =>
      extractMarker("ok\n### HAS_BLOCKERS", REVIEWER_MARKERS, {
        mode: "strict",
      }),
    ).toThrow(MarkerNotFoundError);
  });

  it("REJECTS marker with trailing punctuation", () => {
    expect(() =>
      extractMarker("ok\nFIXED.", FIXER_MARKERS, { mode: "strict" }),
    ).toThrow(MarkerNotFoundError);
  });

  it("accepts only-whitespace surrounding the bare marker", () => {
    expect(
      extractMarker("ok\n   FIXED   \n", FIXER_MARKERS, { mode: "strict" }),
    ).toBe("FIXED");
  });
});

// ---------------------------------------------------------------------------
// Schemas — happy paths
// ---------------------------------------------------------------------------

describe("ImplementerOutputSchema", () => {
  it("parses a valid STORY_COMPLETE payload", () => {
    const payload = {
      storyId: "s-101",
      ghIssue: 42,
      commitSha: "abc1234",
      e2eRan: true,
      e2eVerdict: "passed" as const,
      uiTouched: true,
      certificationPresent: true,
      marker: "STORY_COMPLETE" as const,
    };
    const parsed = ImplementerOutputSchema.parse(payload);
    expect(parsed.marker).toBe("STORY_COMPLETE");
    expect(parsed.commitSha).toBe("abc1234");
  });

  it("parses a HALT payload with haltReason", () => {
    const payload = {
      storyId: "s-101",
      ghIssue: 42,
      e2eRan: false,
      e2eVerdict: "halted" as const,
      uiTouched: false,
      certificationPresent: false,
      marker: "HALT" as const,
      haltReason: "spec contradicts itself",
    };
    expect(ImplementerOutputSchema.parse(payload).haltReason).toBe(
      "spec contradicts itself",
    );
  });

  it("rejects an invalid e2eVerdict", () => {
    const bad = {
      storyId: "s-1",
      ghIssue: 1,
      e2eRan: true,
      e2eVerdict: "kinda-passed",
      uiTouched: true,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
    };
    expect(() => ImplementerOutputSchema.parse(bad)).toThrow();
  });

  it("rejects a negative ghIssue", () => {
    const bad = {
      storyId: "s-1",
      ghIssue: -1,
      e2eRan: false,
      e2eVerdict: "skipped",
      uiTouched: false,
      certificationPresent: false,
      marker: "HALT",
    };
    expect(() => ImplementerOutputSchema.parse(bad)).toThrow();
  });
});

describe("ReviewerVerdictSchema", () => {
  it("parses an ALL_CLEAR with empty concerns", () => {
    const parsed = ReviewerVerdictSchema.parse({
      marker: "ALL_CLEAR",
      concerns: [],
    });
    expect(parsed.marker).toBe("ALL_CLEAR");
  });

  it("parses HAS_BLOCKERS with mixed-severity concerns", () => {
    const parsed = ReviewerVerdictSchema.parse({
      marker: "HAS_BLOCKERS",
      concerns: [
        { severity: "HARD", summary: "test reaches login redirect" },
        { severity: "SOFT", summary: "missing JSDoc" },
      ],
    });
    expect(parsed.concerns).toHaveLength(2);
  });

  it("rejects unknown severity", () => {
    expect(() =>
      ReviewerVerdictSchema.parse({
        marker: "HAS_BLOCKERS",
        concerns: [{ severity: "CRITICAL", summary: "x" }],
      }),
    ).toThrow();
  });
});

describe("FixerVerdictSchema", () => {
  it("parses FIXED with a commit", () => {
    expect(
      FixerVerdictSchema.parse({
        marker: "FIXED",
        commitSha: "deadbeef",
        notes: "addressed 2 of 2 hard concerns",
      }).marker,
    ).toBe("FIXED");
  });

  it("parses BLOCKED without commit", () => {
    expect(
      FixerVerdictSchema.parse({
        marker: "BLOCKED",
        notes: "auth path can't be fixed in this iteration",
      }).marker,
    ).toBe("BLOCKED");
  });

  it("rejects empty commitSha string", () => {
    expect(() =>
      FixerVerdictSchema.parse({ marker: "FIXED", commitSha: "" }),
    ).toThrow();
  });
});

describe("RecoveryDecisionSchema", () => {
  it("parses a successful RECOVERY_COMPLETE", () => {
    const parsed = RecoveryDecisionSchema.parse({
      marker: "RECOVERY_COMPLETE",
      fixApplied: true,
      commitSha: "1234567",
    });
    expect(parsed.fixApplied).toBe(true);
  });

  it("parses a HALT recovery with a reason", () => {
    const parsed = RecoveryDecisionSchema.parse({
      marker: "HALT",
      fixApplied: false,
      haltReason: "external API down",
    });
    expect(parsed.marker).toBe("HALT");
  });

  it("rejects missing fixApplied", () => {
    expect(() =>
      RecoveryDecisionSchema.parse({ marker: "HALT" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseVerdict (stream-json -> assistant text -> JSON -> Zod)
// ---------------------------------------------------------------------------

describe("parseVerdict", () => {
  it("parses an implementer verdict embedded in stream-json output", () => {
    const payload = {
      storyId: "s-101",
      ghIssue: 42,
      commitSha: "cafe1234",
      e2eRan: true,
      e2eVerdict: "passed",
      uiTouched: true,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
    };
    const text =
      "I finished the story. Here is the structured verdict:\n\n" +
      "```json\n" +
      JSON.stringify(payload, null, 2) +
      "\n```\n\nSTORY_COMPLETE\n";
    const blob = streamJson("Working...\n\n", text);
    const result = parseVerdict(blob, ImplementerOutputSchema);
    expect(result.commitSha).toBe("cafe1234");
    expect(result.marker).toBe("STORY_COMPLETE");
  });

  it("parses a reviewer verdict via an XML tag", () => {
    const payload = { marker: "ALL_CLEAR", concerns: [] };
    const text =
      "Reviewing now...\n<verdict>" +
      JSON.stringify(payload) +
      "</verdict>\n\nALL_CLEAR\n";
    const blob = streamJson(text);
    const result = parseVerdict(blob, ReviewerVerdictSchema, {
      jsonTag: "verdict",
    });
    expect(result.marker).toBe("ALL_CLEAR");
  });

  it("parses already-extracted assistant text", () => {
    const payload = { marker: "FIXED", commitSha: "abc1", notes: "ok" };
    const text = `Done.\n\n${JSON.stringify(payload)}\n\nFIXED\n`;
    expect(
      parseVerdict(text, FixerVerdictSchema, { alreadyAssistantText: true })
        .marker,
    ).toBe("FIXED");
  });

  it("throws VerdictParseError on schema mismatch (no silent fallback)", () => {
    const broken = {
      storyId: "s-1",
      ghIssue: "not-a-number", // wrong type
      e2eRan: true,
      e2eVerdict: "passed",
      uiTouched: true,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
    };
    const text = JSON.stringify(broken);
    expect(() =>
      parseVerdict(text, ImplementerOutputSchema, { alreadyAssistantText: true }),
    ).toThrow(VerdictParseError);
  });

  it("throws VerdictParseError when assistant text is empty", () => {
    expect(() => parseVerdict("DEBUG: nothing here", ImplementerOutputSchema)).toThrow(
      VerdictParseError,
    );
  });

  it("throws VerdictParseError when no JSON candidate is present", () => {
    const blob = streamJson("just prose, no braces here at all");
    expect(() => parseVerdict(blob, FixerVerdictSchema)).toThrow(
      VerdictParseError,
    );
  });

  it("throws VerdictParseError on malformed JSON", () => {
    const blob = streamJson("{ this is not valid JSON, ");
    expect(() => parseVerdict(blob, FixerVerdictSchema)).toThrow(
      VerdictParseError,
    );
  });

  it("includes the offending text in the error message", () => {
    const broken = { marker: "MAYBE_CLEAR", concerns: [] };
    try {
      parseVerdict(JSON.stringify(broken), ReviewerVerdictSchema, {
        alreadyAssistantText: true,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VerdictParseError);
      const e = err as VerdictParseError;
      expect(e.rawText).toContain("MAYBE_CLEAR");
    }
  });
});
