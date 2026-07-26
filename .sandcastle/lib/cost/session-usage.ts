/**
 * Extract per-model token usage from a captured Claude Code session JSONL.
 *
 * This is the cost analogue of
 * `skill-discipline.ts:extractSkillInvocationsFromSession` and deliberately
 * MIRRORS its file-walk exactly: readFileSync, split on newlines, JSON.parse
 * each line, filter `o.type === "assistant"`, read `message`. The one
 * difference is what we harvest — here it's `message.model` + `message.usage`
 * (the token counts) instead of `Skill` tool_use blocks.
 *
 * Robustness contract (identical to the skill-discipline extractor — telemetry
 * is BEST-EFFORT and must NEVER throw into a run):
 *   - undefined path or non-existent file → `[]`.
 *   - unreadable file → `[]`.
 *   - malformed / partial JSON lines → skipped silently (a killed agent leaves
 *     truncated logs).
 *   - non-assistant lines, or assistant lines with no `message.usage` → skipped.
 *   - missing individual usage sub-fields default to 0.
 *
 * The JSONL usage fields are snake_case; we map them to camelCase so the rest
 * of the cost pipeline (pricing.ts, ledger.ts) never sees the wire shape.
 */

import { existsSync, readFileSync } from "node:fs";
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
  if (sessionFilePath === undefined) return [];
  if (!existsSync(sessionFilePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(sessionFilePath, "utf8");
  } catch {
    return [];
  }
  // Preserve first-seen order while aggregating by model.
  const order: string[] = [];
  const acc = new Map<string, { input: number; output: number; write: number; read: number }>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // partial / corrupt line — skip silently
    }
    if (typeof obj !== "object" || obj === null) continue;
    const o = obj as { type?: unknown; message?: unknown };
    if (o.type !== "assistant") continue;
    const message = o.message as { model?: unknown; usage?: unknown } | null | undefined;
    if (!message || typeof message.model !== "string") continue;
    const usage = message.usage as Record<string, unknown> | null | undefined;
    if (!usage || typeof usage !== "object") continue;
    const model = message.model;
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
  }
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
