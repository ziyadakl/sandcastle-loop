/**
 * Shared Claude Code session-JSONL walk.
 *
 * Both the skill-discipline extractor (which harvests `Skill` tool_use blocks)
 * and the Phase-1 cost extractor (which harvests `message.model` + `usage`)
 * need the SAME fragile, robustness-critical line walk: read the file, split on
 * newlines, JSON.parse each line, keep only `type === "assistant"` entries, hand
 * back the `message` object. Having that walk copied in two places let the parse
 * contract drift between them; this is the single canonical implementation both
 * project onto.
 *
 * Robustness contract (telemetry/gates are BEST-EFFORT and must NEVER throw):
 *   - undefined path or non-existent file → no callback invoked.
 *   - unreadable file → no callback invoked.
 *   - malformed / partial JSON lines → skipped silently (a killed agent leaves
 *     truncated logs).
 *   - non-`{`-prefixed, empty, non-object, or non-assistant lines → skipped.
 *   - assistant lines with a null/non-object `message` → skipped.
 * The callback receives only well-formed assistant `message` objects; each
 * caller does its own further field checks (content array vs model/usage).
 */

import { existsSync, readFileSync } from "node:fs";

export function forEachAssistantMessage(
  sessionFilePath: string | undefined,
  onAssistantMessage: (message: Record<string, unknown>) => void,
): void {
  if (sessionFilePath === undefined) return;
  if (!existsSync(sessionFilePath)) return;
  let raw: string;
  try {
    raw = readFileSync(sessionFilePath, "utf8");
  } catch {
    return;
  }
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
    const message = o.message;
    if (typeof message !== "object" || message === null) continue;
    onAssistantMessage(message as Record<string, unknown>);
  }
}
