/**
 * Skill-discipline helpers.
 *
 * Self-contained domain logic for the orchestrator's skill-discipline gate.
 * No dependency on `.sandcastle/main.mts` internals — kept in `lib/` per the
 * CONTEXT.md pattern (`code that doesn't touch orchestrator internals lives
 * in lib/`).
 *
 * Two responsibilities:
 *
 *   1. {@link extractSkillInvocationsFromSession} — parse the raw Claude Code
 *      session JSONL produced by `@ai-hero/sandcastle`'s orchestrator
 *      (`IterationResult.sessionFilePath`) and return the ordered list of
 *      `Skill()` tool-call invocations. The reviewer prompt consumes the
 *      result as host-computed ground truth (`SKILLS_INVOKED`) rather than
 *      trusting the implementer's self-report.
 *
 *   2. {@link filterPlanByTypeLabels} — re-validate the planner's selected
 *      issues against a host-side label fetch, excluding any that don't
 *      carry exactly one `type:` label. Opt-in via a SANDCASTLE.md file at
 *      the repo root (passed in as `sandcastleMdExists`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Session-path resolution (SDK sessionFilePath, with sessionId fallback)
// ---------------------------------------------------------------------------

/**
 * Match `@ai-hero/sandcastle`'s `SessionStore.encodeProjectPath` exactly:
 * root-like paths preserved; otherwise drop trailing separators, drop a
 * leading Windows drive-letter colon, then `/` and `\` → `-`. Drift here
 * would silently point the fallback at a non-existent file and the loop
 * would behave as if no skills were ever invoked.
 */
function encodeProjectPath(cwd: string): string {
  const isRoot = cwd === "/" || /^[A-Za-z]:[\\/]?$/.test(cwd);
  const normalized = isRoot ? cwd : cwd.replace(/[\\/]+$/, "");
  return normalized.replace(/^([A-Za-z]):/, "$1").replace(/[\\/]/g, "-");
}

/**
 * Resolve the JSONL session file path for an iteration result.
 *
 * Prefer the SDK's `sessionFilePath` when present — it's authoritative
 * (the SDK chose it). Fall back to constructing the host path from
 * `sessionId` + `repoRoot` using Claude Code's
 * `~/.claude/projects/<encoded>/` layout (see `encodeProjectPath` in
 * `@ai-hero/sandcastle/dist/SessionStore.js`).
 *
 * Why the fallback exists: `IterationResult.sessionFilePath` is only
 * populated when the SDK is wired with a `bindMountHandle` (sandbox-
 * backed session transfer). On normal host-backed orchestration it stays
 * `undefined` even though the session JSONL exists at the conventional
 * path — a consumer that reads only `sessionFilePath` then returns `[]`
 * and quarantines every iteration for "no skills invoked". Audit Issue 1
 * (2026-05-30) — fixed in affinity-tracker `24204d2f6`, propagated here.
 *
 * Returns `undefined` when neither source can produce a path (`HOME`
 * unset + caller didn't override). Existence is NOT checked here; the
 * caller (`extractSkillInvocationsFromSession`) handles missing files.
 */
export function resolveSessionFilePath(
  iteration: { readonly sessionFilePath?: string; readonly sessionId?: string },
  repoRoot: string,
  homeDir?: string,
): string | undefined {
  if (iteration.sessionFilePath !== undefined && iteration.sessionFilePath !== "") {
    return iteration.sessionFilePath;
  }
  if (iteration.sessionId === undefined || iteration.sessionId === "") return undefined;
  const home = homeDir ?? process.env.HOME;
  if (home === undefined || home === "") return undefined;
  const encoded = encodeProjectPath(repoRoot);
  return join(home, ".claude", "projects", encoded, `${iteration.sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Skill-discipline extractor (raw session JSONL → ground truth for reviewer)
// ---------------------------------------------------------------------------

/**
 * Extract every `Skill()` tool-call invocation from a captured Claude Code
 * session JSONL file. The returned array becomes the `SKILLS_INVOKED`
 * ground-truth field passed to the reviewer prompt — host-computed, not
 * self-reported by the implementer, so the implementer cannot lie about
 * which skills it invoked.
 *
 * Why parse the raw JSONL instead of using the SDK's `onAgentStreamEvent`
 * callback (which is the natural-looking path)? Because that callback is
 * fed by `parseStreamJsonLine` in `@ai-hero/sandcastle`'s `AgentProvider.js`,
 * which carries a hardcoded `TOOL_ARG_FIELDS` allowlist of `Bash`,
 * `WebSearch`, `WebFetch`, `Agent`. Any `tool_use` block whose `name` is
 * NOT in that map is silently dropped before a `tool_call` event ever
 * fires. `Skill` is not in the allowlist, so the callback yielded zero
 * `Skill` events in production and `SKILLS_INVOKED` was always
 * `(none invoked)`. The orchestrator's session-JSONL capture (see
 * `IterationResult.sessionFilePath` from the SDK's `Orchestrator.d.ts`)
 * holds the unfiltered `tool_use` blocks — exactly the data we need.
 *
 * Shape we walk:
 *   {"type":"assistant","message":{"content":[
 *     {"type":"text","text":"..."},
 *     {"type":"tool_use","name":"Skill","input":{"skill":"glass-morphism"}}
 *   ]}}
 *
 * Robustness contract:
 *   - undefined `sessionFilePath` or non-existent file → `[]` (capture is
 *     opt-in on the SDK side; we never want to throw here).
 *   - Malformed JSON lines are skipped silently — partial logs from a
 *     killed agent are common in this codebase.
 *   - Order of invocation is preserved across the entire file (and across
 *     iterations if the SDK appends multiple to one file).
 */
export function extractSkillInvocationsFromSession(
  sessionFilePath: string | undefined,
): readonly string[] {
  if (sessionFilePath === undefined) return [];
  if (!existsSync(sessionFilePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(sessionFilePath, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
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
    const message = o.message as { content?: unknown } | null | undefined;
    if (!message || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b.type !== "tool_use") continue;
      if (b.name !== "Skill") continue;
      const input = b.input as { skill?: unknown } | null | undefined;
      if (input && typeof input.skill === "string") {
        out.push(input.skill);
      }
    }
  }
  return out;
}

/**
 * Filter the planner's selected issues to enforce `type:` label discipline.
 * Only runs when SANDCASTLE.md exists at the repo root — that's the opt-in
 * signal that the project wants skill discipline enforced.
 *
 * Rules:
 * - Issue MUST carry exactly one label starting with `type:`.
 * - Zero `type:` labels → excluded with reason "missing type: label".
 * - Multiple `type:` labels → excluded with reason "multiple type: labels"
 *   (config error — the user should fix in triage).
 *
 * When `sandcastleMdExists` is false, the filter is a no-op (returns all
 * issues unchanged). This preserves backward compatibility for projects
 * that haven't adopted SANDCASTLE.md.
 */
export function filterPlanByTypeLabels(
  issues: readonly { readonly id: string; readonly title: string; readonly branch: string }[],
  labelLookup: ReadonlyMap<string, readonly string[]>,
  sandcastleMdExists: boolean,
): {
  readonly kept: readonly { readonly id: string; readonly title: string; readonly branch: string }[];
  readonly excluded: readonly { readonly id: string; readonly reason: string }[];
} {
  if (!sandcastleMdExists) {
    return { kept: issues, excluded: [] };
  }
  const kept: typeof issues[number][] = [];
  const excluded: { id: string; reason: string }[] = [];
  for (const issue of issues) {
    const labels = labelLookup.get(issue.id) ?? [];
    const typeLabels = labels.filter((l) => l.startsWith("type:"));
    if (typeLabels.length === 0) {
      excluded.push({ id: issue.id, reason: "missing type: label" });
    } else if (typeLabels.length > 1) {
      excluded.push({ id: issue.id, reason: "multiple type: labels" });
    } else {
      kept.push(issue);
    }
  }
  return { kept, excluded };
}
