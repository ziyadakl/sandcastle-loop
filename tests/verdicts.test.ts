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
import { readFileSync } from "node:fs";
import * as path from "node:path";
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
  extractAllJsonFences,
  extractJsonCandidate,
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
  // -------------------------------------------------------------------------
  // Fixture builders — keep tests focused on the rule under test, not on
  // boilerplate. `validUiStoryComplete()` returns a payload that satisfies
  // every cross-field rule; tests then mutate one field to exercise one rule.
  // -------------------------------------------------------------------------

  /**
   * A fully-valid STORY_COMPLETE payload for a UI story whose spec required
   * playwright. Every one of the 7 certification fields is filled and
   * consistent. Tests mutate this fixture to exercise individual rules.
   */
  function validUiStoryComplete() {
    return {
      storyId: "s-101",
      ghIssue: 42,
      commitSha: "abc1234",
      e2eVerdict: "passed" as const,
      uiTouched: true,
      certificationPresent: true,
      marker: "STORY_COMPLETE" as const,
      // 7-question certification — all consistent for STORY_COMPLETE.
      storyType: "ui" as const,
      e2eRequired: true,
      e2eActuallyRan: true,
      testCommandUsed: "pnpm playwright test specs/accept-suggestion.spec.ts",
      e2eAssertionLine:
        "✓ accept-suggestion › clicking Accept opens prefilled dialog",
      outputNotFiltered: true,
      testReachedFeature: true,
    };
  }

  /**
   * A fully-valid HALT payload. HALT is the explicit escape hatch: soft
   * fields (`testCommandUsed`, `e2eAssertionLine`) may be null and the
   * `e2eRequired ⇒ e2eActuallyRan` rule does not apply.
   */
  function validHalt() {
    return {
      storyId: "s-101",
      ghIssue: 42,
      e2eVerdict: "halted" as const,
      uiTouched: false,
      certificationPresent: false,
      marker: "HALT" as const,
      haltReason: "spec contradicts itself",
      storyType: "ui" as const,
      e2eRequired: true,
      e2eActuallyRan: false,
      testCommandUsed: null,
      e2eAssertionLine: null,
      outputNotFiltered: true,
      testReachedFeature: false,
    };
  }

  // -------------------------------------------------------------------------
  // Happy paths
  // -------------------------------------------------------------------------

  it("parses a valid STORY_COMPLETE payload with all 7 certification fields", () => {
    const parsed = ImplementerOutputSchema.parse(validUiStoryComplete());
    expect(parsed.marker).toBe("STORY_COMPLETE");
    expect(parsed.commitSha).toBe("abc1234");
    // Verify the 7 fields round-trip intact — the parser must not silently
    // drop or default any of them.
    expect(parsed.storyType).toBe("ui");
    expect(parsed.e2eRequired).toBe(true);
    expect(parsed.e2eActuallyRan).toBe(true);
    expect(parsed.testCommandUsed).toBe(
      "pnpm playwright test specs/accept-suggestion.spec.ts",
    );
    expect(parsed.e2eAssertionLine).toBe(
      "✓ accept-suggestion › clicking Accept opens prefilled dialog",
    );
    expect(parsed.outputNotFiltered).toBe(true);
    expect(parsed.testReachedFeature).toBe(true);
  });

  it("parses a backend-only STORY_COMPLETE with e2eRequired=false", () => {
    // Backend stories don't require playwright. testCommandUsed and
    // e2eAssertionLine may be null; e2eActuallyRan may be false.
    const parsed = ImplementerOutputSchema.parse({
      ...validUiStoryComplete(),
      storyType: "backend-only" as const,
      e2eRequired: false,
      e2eActuallyRan: false,
      testCommandUsed: null,
      e2eAssertionLine: null,
      uiTouched: false,
      testReachedFeature: false,
    });
    expect(parsed.storyType).toBe("backend-only");
    expect(parsed.testCommandUsed).toBeNull();
  });

  it("parses a HALT payload with haltReason", () => {
    expect(ImplementerOutputSchema.parse(validHalt()).haltReason).toBe(
      "spec contradicts itself",
    );
  });

  it("rejects an invalid e2eVerdict", () => {
    expect(() =>
      ImplementerOutputSchema.parse({
        ...validUiStoryComplete(),
        e2eVerdict: "kinda-passed",
      }),
    ).toThrow();
  });

  it("rejects a negative ghIssue", () => {
    expect(() =>
      ImplementerOutputSchema.parse({ ...validHalt(), ghIssue: -1 }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // 7-question certification — required-field enforcement
  // -------------------------------------------------------------------------

  it("rejects payload missing any of the 7 certification fields (no silent default)", () => {
    // Each of the 7 questions is required. Iterate over every field and
    // assert that omitting it makes the parse fail loud — never silently
    // fall back to a default. This is the central anti-rubber-stamp guard.
    const fields = [
      "storyType",
      "e2eRequired",
      "e2eActuallyRan",
      "testCommandUsed",
      "e2eAssertionLine",
      "outputNotFiltered",
      "testReachedFeature",
    ] as const;

    for (const f of fields) {
      const payload: Record<string, unknown> = { ...validUiStoryComplete() };
      delete payload[f];
      expect(
        () => ImplementerOutputSchema.parse(payload),
        `expected schema to reject payload missing required field ${f}`,
      ).toThrow();
    }
  });

  it("rejects an invalid storyType enum value", () => {
    expect(() =>
      ImplementerOutputSchema.parse({
        ...validUiStoryComplete(),
        storyType: "frontend",
      }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // Cross-field rule 1: e2eRequired=true ⇒ testCommandUsed non-null AND
  //                    e2eActuallyRan=true (unless marker=HALT)
  // -------------------------------------------------------------------------

  it("REJECTS STORY_COMPLETE when e2eRequired=true but e2eActuallyRan=false", () => {
    // This is the canonical rubber-stamp attempt: spec mandates playwright,
    // implementer skipped the test, claims success anyway. The schema must
    // reject this BEFORE it reaches the reviewer.
    expect(() =>
      ImplementerOutputSchema.parse({
        ...validUiStoryComplete(),
        e2eActuallyRan: false,
      }),
    ).toThrow();
  });

  it("REJECTS STORY_COMPLETE when e2eRequired=true but testCommandUsed is null", () => {
    expect(() =>
      ImplementerOutputSchema.parse({
        ...validUiStoryComplete(),
        testCommandUsed: null,
      }),
    ).toThrow();
  });

  it("ACCEPTS HALT when e2eRequired=true but e2eActuallyRan=false (escape hatch)", () => {
    // HALT is the implementer's "I gave up" signal. The strict cross-field
    // rules don't apply because the implementer is admitting they could not
    // verify the feature. Soft fields may be null.
    const parsed = ImplementerOutputSchema.parse(validHalt());
    expect(parsed.marker).toBe("HALT");
    expect(parsed.testCommandUsed).toBeNull();
    expect(parsed.e2eAssertionLine).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cross-field rule 2: e2eActuallyRan=true ⇒ e2eAssertionLine non-empty AND
  //                    not generic (preamble / bare URL)
  // -------------------------------------------------------------------------

  it("REJECTS the generic 'Running 3 tests' assertion line", () => {
    // The bash reviewer rejects this exact pattern as fabricated evidence.
    // Encoding it in the schema means a rubber-stamp attempt that quotes the
    // playwright preamble line fails at parse time.
    expect(() =>
      ImplementerOutputSchema.parse({
        ...validUiStoryComplete(),
        e2eAssertionLine: "Running 3 tests using 1 worker",
      }),
    ).toThrow();
  });

  it("REJECTS 'Running 1 test' (singular) — case-insensitive preamble match", () => {
    expect(() =>
      ImplementerOutputSchema.parse({
        ...validUiStoryComplete(),
        e2eAssertionLine: "running 1 test",
      }),
    ).toThrow();
  });

  it("REJECTS a bare URL line as the assertion quote", () => {
    expect(() =>
      ImplementerOutputSchema.parse({
        ...validUiStoryComplete(),
        e2eAssertionLine: "http://localhost:3000/dashboard",
      }),
    ).toThrow();
  });

  it("REJECTS e2eAssertionLine=null when e2eActuallyRan=true", () => {
    expect(() =>
      ImplementerOutputSchema.parse({
        ...validUiStoryComplete(),
        e2eAssertionLine: null,
      }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // Cross-field rule 3: outputNotFiltered=false ⇒ marker=HALT
  // -------------------------------------------------------------------------

  it("REJECTS STORY_COMPLETE when outputNotFiltered=false (auto-HALT rule)", () => {
    // The implementer admitted piping playwright through a filter (grep -v,
    // 2>/dev/null, etc.) before tee. Filtered output cannot be trusted by
    // the reviewer, so the verdict is auto-HALT — STORY_COMPLETE here is a
    // schema error, not a reviewer judgement call.
    expect(() =>
      ImplementerOutputSchema.parse({
        ...validUiStoryComplete(),
        outputNotFiltered: false,
      }),
    ).toThrow();
  });

  it("ACCEPTS HALT when outputNotFiltered=false (the auto-HALT path)", () => {
    const parsed = ImplementerOutputSchema.parse({
      ...validHalt(),
      outputNotFiltered: false,
      haltReason: "filtered playwright output, re-running with raw tee",
    });
    expect(parsed.marker).toBe("HALT");
    expect(parsed.outputNotFiltered).toBe(false);
  });

  it("ACCEPTS STORY_COMPLETE with outputNotFiltered=false when e2eActuallyRan=false (vacuous — no output to filter)", () => {
    // Backend-only stories don't run e2e, so the filtering question is
    // meaningless. Earlier the schema rejected this combo and forced
    // implementers to HALT correct work; now Rule 3 is gated on
    // e2eActuallyRan=true.
    const parsed = ImplementerOutputSchema.parse({
      ...validUiStoryComplete(),
      storyType: "backend-only" as const,
      e2eRequired: false,
      e2eActuallyRan: false,
      testCommandUsed: null,
      e2eAssertionLine: null,
      outputNotFiltered: false,
      testReachedFeature: false,
    });
    expect(parsed.marker).toBe("STORY_COMPLETE");
    expect(parsed.outputNotFiltered).toBe(false);
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
    // Includes the full 7-question certification — the schema rejects
    // payloads missing any of these fields, so parseVerdict must surface a
    // complete, consistent payload to the loop driver.
    const payload = {
      storyId: "s-101",
      ghIssue: 42,
      commitSha: "cafe1234",
      e2eVerdict: "passed",
      uiTouched: true,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
      storyType: "ui",
      e2eRequired: true,
      e2eActuallyRan: true,
      testCommandUsed: "pnpm playwright test specs/foo.spec.ts",
      e2eAssertionLine: "✓ foo › opens dialog when Accept clicked",
      outputNotFiltered: true,
      testReachedFeature: true,
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
    const text = `Done.\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n\nFIXED\n`;
    expect(
      parseVerdict(text, FixerVerdictSchema, { alreadyAssistantText: true })
        .marker,
    ).toBe("FIXED");
  });

  it("throws VerdictParseError on schema mismatch (no silent fallback)", () => {
    const broken = {
      storyId: "s-1",
      ghIssue: "not-a-number", // wrong type
      e2eVerdict: "passed",
      uiTouched: true,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
      // Even with the 7-question fields filled in correctly, the bad
      // ghIssue type must surface as a VerdictParseError — never silently
      // coerced.
      storyType: "ui",
      e2eRequired: true,
      e2eActuallyRan: true,
      testCommandUsed: "pnpm playwright test specs/foo.spec.ts",
      e2eAssertionLine: "✓ foo › works",
      outputNotFiltered: true,
      testReachedFeature: true,
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

// ---------------------------------------------------------------------------
// extractAllJsonFences (last-fence-first) + extractJsonCandidate without
// brace-walker. Synthetic + fixture-driven coverage for the prior brace-walk
// regression that mis-parsed `style={{ transform }}` prose as a JSON object
// and grabbed earlier "progress summary" fenced blocks instead of the real
// envelope.
// ---------------------------------------------------------------------------

describe("extractAllJsonFences", () => {
  it("returns blocks in reverse source order (last fence first)", () => {
    const text = [
      "prose",
      "```json",
      '{"first": true}',
      "```",
      "more prose",
      "```json",
      '{"second": true}',
      "```",
    ].join("\n");
    expect(extractAllJsonFences(text)).toEqual([
      '{"second": true}',
      '{"first": true}',
    ]);
  });

  it("accepts json, JSON, and jsonc info-strings", () => {
    const text = [
      "```json",
      '{"a":1}',
      "```",
      "```JSON",
      '{"b":2}',
      "```",
      "```jsonc",
      '{"c":3}',
      "```",
    ].join("\n");
    expect(extractAllJsonFences(text)).toEqual([
      '{"c":3}',
      '{"b":2}',
      '{"a":1}',
    ]);
  });

  it("returns empty array when no fences exist", () => {
    expect(extractAllJsonFences("just prose with { braces } but no fence")).toEqual([]);
  });

  it("ignores braces inside prose (no brace-walking)", () => {
    // The whole point of the regression: prose `style={{ transform }}` used
    // to be picked up by the brace-walker. Now there's no fence → no
    // candidate.
    const text = "Inline `style={{ transform }}` could become Tailwind.";
    expect(extractJsonCandidate(text)).toBeNull();
  });
});

describe("parseVerdict — fenced-block strategy (envelope-extraction regression)", () => {
  it("returns the LAST fenced block when both fenced blocks would parse but only one is the real envelope", () => {
    const text = [
      "Story progress:",
      "```json",
      '{"marker":"STORY_COMPLETE","storyType":"ui","e2eRequired":false,"e2eActuallyRan":false,"testCommandUsed":null,"e2eAssertionLine":null,"outputNotFiltered":true,"testReachedFeature":true}',
      "```",
      "More prose.",
      "```json",
      '{"marker":"STORY_COMPLETE","storyType":"backend-only","e2eRequired":false,"e2eActuallyRan":false,"testCommandUsed":null,"e2eAssertionLine":null,"outputNotFiltered":true,"testReachedFeature":true}',
      "```",
      "STORY_COMPLETE",
    ].join("\n");
    const parsed = parseVerdict(text, ImplementerOutputSchema, {
      alreadyAssistantText: true,
    });
    expect(parsed.storyType).toBe("backend-only"); // last fence wins
  });

  it("falls through to an earlier fence when the last fence fails schema validation", () => {
    const text = [
      "```json",
      '{"marker":"STORY_COMPLETE","storyType":"ui","e2eRequired":false,"e2eActuallyRan":false,"testCommandUsed":null,"e2eAssertionLine":null,"outputNotFiltered":true,"testReachedFeature":true}',
      "```",
      "trailing noise:",
      "```json",
      '{"this":"is not the envelope, missing required fields"}',
      "```",
    ].join("\n");
    const parsed = parseVerdict(text, ImplementerOutputSchema, {
      alreadyAssistantText: true,
    });
    expect(parsed.marker).toBe("STORY_COMPLETE");
  });

  it("throws with fence-count detail when no fence validates", () => {
    const text = [
      "```json",
      '{"this":"is junk"}',
      "```",
      "```json",
      '{"also":"junk"}',
      "```",
    ].join("\n");
    try {
      parseVerdict(text, ImplementerOutputSchema, { alreadyAssistantText: true });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VerdictParseError);
      const e = err as VerdictParseError;
      expect(e.message).toMatch(/Found 2 fenced json block/);
    }
  });

  it("throws clear error when no fenced json block exists at all", () => {
    expect(() =>
      parseVerdict("just prose, no fence anywhere.", ImplementerOutputSchema, {
        alreadyAssistantText: true,
      }),
    ).toThrow(/fenced ```json/);
  });
});

describe("parseVerdict — captured-fixture regressions (#123, #131, #132)", () => {
  const FIXTURE_DIR = path.join(__dirname, "fixtures", "envelope-parse");

  // Fixtures are full sandcastle driver logs. parseVerdict in main.mts is
  // invoked once per implementer attempt (attempt 1, then attempt 2 on
  // retry). The driver writes "Agent started\n...\nAgent stopped\n" around
  // each attempt's output, concatenating multiple attempts into one log.
  // We extract the LAST attempt's slice — that's the one whose envelope
  // would have shipped or HALTed.
  function loadFixture(issue: number): string {
    const raw = readFileSync(
      path.join(FIXTURE_DIR, `agent-issue-${issue}-implementer.log`),
      "utf-8",
    );
    const startMarker = "Agent started\n";
    const stopMarker = "\nAgent stopped";
    const startIdx = raw.lastIndexOf(startMarker);
    if (startIdx === -1) {
      throw new Error(`fixture ${issue}: could not locate Agent started`);
    }
    const stopIdx = raw.indexOf(stopMarker, startIdx);
    if (stopIdx === -1) {
      throw new Error(`fixture ${issue}: no Agent stopped after last Agent started`);
    }
    return raw.slice(startIdx + startMarker.length, stopIdx);
  }

  it("#123 — duplicate fenced ```json``` blocks: validates against the real (last) envelope, not the progress-summary block", () => {
    const text = loadFixture(123);
    const parsed = parseVerdict(text, ImplementerOutputSchema, {
      alreadyAssistantText: true,
    });
    expect(parsed.marker).toBe("STORY_COMPLETE");
  });

  it("#131 — HALT path with no envelope: extractMarker returns HALT so the loop gate can skip parseVerdict (parseVerdict itself would correctly refuse to find a fence)", () => {
    const text = loadFixture(131);
    expect(extractMarker(text, IMPLEMENTER_MARKERS)).toBe("HALT");
    // Without the HALT gate in main.mts, parseVerdict on this fixture would
    // throw — that's exactly the bug the gate at main.mts:1530 prevents.
    expect(() =>
      parseVerdict(text, ImplementerOutputSchema, { alreadyAssistantText: true }),
    ).toThrow(VerdictParseError);
  });

  it("#132 — brace-in-prose (`style={{ transform }}`): real envelope at the end validates; the prose braces are invisible to the fenced-block extractor", () => {
    const text = loadFixture(132);
    const parsed = parseVerdict(text, ImplementerOutputSchema, {
      alreadyAssistantText: true,
    });
    expect(parsed.marker).toBe("STORY_COMPLETE");
  });
});
