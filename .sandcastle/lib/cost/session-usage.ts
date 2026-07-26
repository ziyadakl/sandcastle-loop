/**
 * Extract per-model token usage from a captured Claude Code session JSONL.
 *
 * The cost analogue of `skill-discipline.ts:extractSkillInvocationsFromSession`:
 * both walk the session JSONL via the shared {@link forEachAssistantMessage}
 * (the single source of the read/parse/filter robustness contract — missing or
 * unreadable file and malformed lines are skipped, never thrown). This extractor
 * harvests `message.model` + `message.usage` (token counts) instead of `Skill`
 * tool_use blocks; an assistant line with no usage (or no string model) is
 * skipped, and missing individual usage sub-fields default to 0.
 *
 * The JSONL usage fields are snake_case; we map them to camelCase so the rest
 * of the cost pipeline (pricing.ts, ledger.ts) never sees the wire shape.
 */

import { forEachAssistantMessage } from "../session-jsonl.js";
import type { Usage } from "./pricing.js";

/** One model's aggregated usage across every assistant line in a session. */
export interface ModelUsage {
  readonly model: string;
  readonly usage: Usage;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parse a session JSONL and return per-model AGGREGATED usage. One entry per
 * distinct `message.model` seen, with its token buckets summed across all of
 * that model's assistant lines. Order follows first appearance of each model.
 */
export function extractUsageFromSession(
  sessionFilePath: string | undefined,
): ModelUsage[] {
  // Preserve first-seen order while aggregating by model.
  const order: string[] = [];
  const acc = new Map<string, { input: number; output: number; write: number; read: number }>();
  forEachAssistantMessage(sessionFilePath, (message) => {
    const model = (message as { model?: unknown }).model;
    if (typeof model !== "string") return;
    const usage = (message as { usage?: unknown }).usage as
      | Record<string, unknown>
      | null
      | undefined;
    if (!usage || typeof usage !== "object") return;
    let bucket = acc.get(model);
    if (bucket === undefined) {
      bucket = { input: 0, output: 0, write: 0, read: 0 };
      acc.set(model, bucket);
      order.push(model);
    }
    bucket.input += num(usage.input_tokens);
    bucket.output += num(usage.output_tokens);
    bucket.write += num(usage.cache_creation_input_tokens);
    bucket.read += num(usage.cache_read_input_tokens);
  });
  return order.map((model) => {
    const b = acc.get(model)!;
    return {
      model,
      usage: {
        inputTokens: b.input,
        outputTokens: b.output,
        cacheCreationInputTokens: b.write,
        cacheReadInputTokens: b.read,
      },
    };
  });
}
