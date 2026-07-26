/**
 * Tests for `extractUsageFromSession` — the cost analogue of
 * `extractSkillInvocationsFromSession`. It walks a captured session JSONL and
 * returns per-model AGGREGATED token usage (snake_case JSONL fields mapped to
 * camelCase). It must mirror the skill-discipline extractor's robustness:
 * tolerate non-assistant lines, unparseable lines, and missing usage, and
 * return [] for a missing/empty file rather than throwing (telemetry is
 * best-effort — it must never break a run).
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extractUsageFromSession } from "../.sandcastle/lib/cost/session-usage.js";

const FIXTURE = join(__dirname, "fixtures", "cost", "session-with-usage.jsonl");

describe("extractUsageFromSession", () => {
  it("sums usage per model, ignoring non-assistant/malformed/usage-less lines", () => {
    const result = extractUsageFromSession(FIXTURE);
    const byModel = new Map(result.map((r) => [r.model, r.usage]));

    // Two opus assistant lines aggregate; the third opus line has no usage → skipped.
    expect(byModel.get("claude-opus-4-8")).toEqual({
      inputTokens: 2 + 10,
      outputTokens: 2388 + 300,
      cacheCreationInputTokens: 16295 + 100,
      cacheReadInputTokens: 24050 + 5000,
    });

    // The single sonnet line stands alone.
    expect(byModel.get("claude-sonnet-5")).toEqual({
      inputTokens: 50,
      outputTokens: 80,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1000,
    });

    // Only the two models with real usage survive.
    expect(byModel.size).toBe(2);
  });

  it("returns [] for a missing file (never throws)", () => {
    expect(extractUsageFromSession("/no/such/file.jsonl")).toEqual([]);
  });

  it("returns [] for undefined path", () => {
    expect(extractUsageFromSession(undefined)).toEqual([]);
  });

  it("returns [] for an empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cost-usage-"));
    const p = join(dir, "empty.jsonl");
    writeFileSync(p, "");
    expect(extractUsageFromSession(p)).toEqual([]);
  });

  it("tolerates missing usage sub-fields, defaulting each to 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "cost-usage-"));
    const p = join(dir, "partial.jsonl");
    // usage present but only output_tokens — the rest must default to 0.
    writeFileSync(
      p,
      `${JSON.stringify({
        type: "assistant",
        message: { model: "claude-haiku-4-5", usage: { output_tokens: 7 } },
      })}\n`,
    );
    expect(extractUsageFromSession(p)).toEqual([
      {
        model: "claude-haiku-4-5",
        usage: {
          inputTokens: 0,
          outputTokens: 7,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]);
  });
});
