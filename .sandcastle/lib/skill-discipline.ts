/**
 * Skill-discipline helpers.
 *
 * Self-contained domain logic for the orchestrator's skill-discipline gate.
 * No dependency on `.sandcastle/main.mts` internals — kept in `lib/`, where
 * code that doesn't touch orchestrator internals lives.
 *
 * Responsibilities:
 *
 *   1. {@link extractSkillInvocationsFromSession} — parse the raw Claude Code
 *      session JSONL produced by `@ai-hero/sandcastle`'s orchestrator
 *      (`IterationResult.sessionFilePath`) and return the ordered list of
 *      `Skill()` tool-call invocations. The reviewer prompt consumes the
 *      result as host-computed ground truth (`SKILLS_INVOKED`) rather than
 *      trusting the implementer's self-report. (Path resolution lives in
 *      {@link resolveSessionFilePath}, which generalizes the host layout
 *      across docker and mac-host sandboxes.)
 *
 *   2. {@link filterPlanByTypeLabels} — re-validate the planner's selected
 *      issues against a host-side label fetch, excluding any that don't
 *      carry exactly one `type:` label. Opt-in via a SANDCASTLE.md file at
 *      the repo root (passed in as `sandcastleMdExists`).
 *
 *   3. {@link parseRequiredSkillsByType} — parse the project's `SANDCASTLE.md`
 *      into a `type:X → required-skills[]` map so the orchestrator can
 *      pre-compute the required-skill set per dispatched issue. Advisory:
 *      the builder's prompt names them, and nothing stops on them (spec
 *      #1334, SG).
 *
 *   4. {@link validateRequiredSkillsInvoked} — set-diff between the
 *      pre-computed required list and the host-extracted invoked list,
 *      returning the missing skills (preserving required-list order so
 *      operator-facing error messages stay deterministic). Used only by the
 *      post-merge fixer's telemetry WARN.
 *
 * A missing record of a skill run never stops a ticket (spec #1334, SG):
 * the reviewer grades the diff against the same principles itself
 * ("Design rules" in `review-prompt.md`).
 */

import { forEachAssistantMessage } from "./session-jsonl.js";
import { findClaudeSessionOnHost, findCodexSessionOnHost } from "@ai-hero/sandcastle";
import { backendForModel } from "../providers.js";
import { extractSkillInvocationsFromCodexSession } from "./codex-session.js";

// ---------------------------------------------------------------------------
// Session-path resolution (SDK sessionFilePath, with a by-id host scan)
// ---------------------------------------------------------------------------

/**
 * Resolve the JSONL session file path for an iteration result.
 *
 * Prefer the SDK's `sessionFilePath` when present — it's authoritative (the
 * SDK chose it). Otherwise locate the file by the iteration's globally-unique
 * `sessionId`, scanning every `~/.claude/projects/<encoded-cwd>/` directory
 * via the SDK's `findClaudeSessionOnHost`.
 *
 * Why scan by id rather than reconstruct the path from a cwd: Claude Code
 * runs inside the sandbox at a different working directory than the host
 * `repoRoot`, so it writes its session JSONL under the CONTAINER cwd slug
 * (e.g. `-home-agent-workspace`), never the host slug (e.g.
 * `-home-you-dev-myproject`). Reconstructing a host-cwd path can
 * never match the container slug → file "not found" → zero skills read →
 * every typed issue silently quarantines. The session id is the one key
 * stable across the host/container boundary, so we search by it. This also
 * covers the mac-host profile uniformly (no container, host slug) — the scan
 * finds the file wherever it landed.
 *
 * Why the fallback exists at all: `IterationResult.sessionFilePath` is only
 * populated when the SDK is wired with a `bindMountHandle` (sandbox-backed
 * session transfer). On the worktree-copy pipeline it stays `undefined` even
 * though the JSONL exists on the host — a consumer that reads only
 * `sessionFilePath` then returns `[]` and quarantines every iteration for
 * "no skills invoked". Audit Issue 1 (2026-05-30); container-slug fix
 * (2026-06-05, a sandcastle-feedback audit).
 *
 * `projectsDir` overrides the scanned root (defaults to `~/.claude/projects`
 * inside `findClaudeSessionOnHost`); used by tests. Returns `undefined` when
 * neither source yields a path. The by-id scan only returns paths that exist;
 * an SDK-provided `sessionFilePath` is returned without an existence check
 * (the caller `extractSkillInvocationsFromSession` tolerates a missing file).
 */
export async function resolveSessionFilePath(
  iteration: { readonly sessionFilePath?: string; readonly sessionId?: string },
  projectsDir?: string,
): Promise<string | undefined> {
  if (iteration.sessionFilePath !== undefined && iteration.sessionFilePath !== "") {
    return iteration.sessionFilePath;
  }
  if (iteration.sessionId === undefined || iteration.sessionId === "") return undefined;
  const { path } = await findClaudeSessionOnHost(iteration.sessionId, projectsDir);
  return path;
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
  const out: string[] = [];
  forEachAssistantMessage(sessionFilePath, (message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b.type !== "tool_use") continue;
      if (b.name !== "Skill") continue;
      const input = b.input as { skill?: unknown } | null | undefined;
      if (input && typeof input.skill === "string") {
        out.push(input.skill);
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Backend-aware resolve + extract (Claude OR Codex)
// ---------------------------------------------------------------------------

/**
 * Backend-aware variant of {@link resolveSessionFilePath} for the Codex
 * agent backend. Locates a Codex *rollout* JSONL on the host by the
 * iteration's session id via the SDK's `findCodexSessionOnHost` — the Codex
 * analogue of `findClaudeSessionOnHost`. Rollouts live under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`; the SDK does the
 * date-nested scan so we never reconstruct the path.
 *
 * Prefers an SDK-provided `sessionFilePath` when present (authoritative),
 * exactly like the Claude resolver. `sessionsDir` overrides the scanned root
 * (defaults to `~/.codex/sessions` inside `findCodexSessionOnHost`); used by
 * tests. Returns `undefined` when neither source yields a path.
 */
export async function resolveCodexSessionFilePath(
  iteration: { readonly sessionFilePath?: string; readonly sessionId?: string },
  sessionsDir?: string,
): Promise<string | undefined> {
  if (iteration.sessionFilePath !== undefined && iteration.sessionFilePath !== "") {
    return iteration.sessionFilePath;
  }
  if (iteration.sessionId === undefined || iteration.sessionId === "") return undefined;
  const { path } = await findCodexSessionOnHost(iteration.sessionId, sessionsDir);
  return path;
}

/**
 * Resolve an iteration's session file and extract the ordered list of skills
 * the agent invoked, dispatching on the agent backend the run used.
 *
 * This is the single backend-aware entry point the orchestrator should call
 * for `SKILLS_INVOKED` ground truth. It does NOT change the existing
 * Claude-only exports ({@link resolveSessionFilePath} +
 * {@link extractSkillInvocationsFromSession}), which stay in place for the
 * existing callers and tests:
 *
 *   - `backendForModel(model) === "codex"` → resolve the Codex rollout via
 *     {@link resolveCodexSessionFilePath} and parse it with
 *     {@link extractSkillInvocationsFromCodexSession} (Codex records a skill
 *     use as a shell-exec function_call that reads `skills/<name>/SKILL.md`,
 *     NOT a dedicated `Skill` tool_use; see `codex-session.ts`).
 *   - otherwise (claude / kimi / glm — all the `claude` backend) → resolve via
 *     {@link resolveSessionFilePath} and parse with
 *     {@link extractSkillInvocationsFromSession} (unchanged Claude path).
 *
 * Both branches return the same shape — an ordered, deduplication-free list of
 * invoked skill names — so {@link validateRequiredSkillsInvoked} consumes the
 * result identically regardless of backend.
 *
 * `dirOverride` is forwarded to the relevant resolver's scan-root parameter
 * (`projectsDir` for Claude, `sessionsDir` for Codex); used by tests. The
 * extractor never throws, so a missing/undefined path yields `[]`.
 */
export async function resolveAndExtractSkillInvocations(
  iteration: { readonly sessionFilePath?: string; readonly sessionId?: string },
  model: string,
  dirOverride?: string,
): Promise<readonly string[]> {
  if (backendForModel(model) === "codex") {
    const path = await resolveCodexSessionFilePath(iteration, dirOverride);
    return extractSkillInvocationsFromCodexSession(path);
  }
  const path = await resolveSessionFilePath(iteration, dirOverride);
  return extractSkillInvocationsFromSession(path);
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
/**
 * THE `type:` LABEL RULE, on its own, over one issue's labels. Returns the
 * exclusion reason, or `undefined` when the labels are fine.
 *
 * ONE definition, two readers: {@link filterPlanByTypeLabels} re-validates the
 * planner's PICKS with it, and `eligibleForPlanning`
 * (`lib/state/eligible-set.ts`) applies the same rule when the host builds the
 * candidate list the planner is allowed to rank in the first place. They must
 * never drift — an issue the host withholds as untyped and the same issue the
 * pick-filter would have kept is a contradiction a reader cannot resolve.
 */
export function typeLabelExclusionReason(
  labels: readonly string[],
): string | undefined {
  const typeLabels = labels.filter((l) => l.startsWith("type:"));
  if (typeLabels.length === 0) return "missing type: label";
  if (typeLabels.length > 1) return "multiple type: labels";
  return undefined;
}

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
    const reason = typeLabelExclusionReason(labelLookup.get(issue.id) ?? []);
    if (reason !== undefined) {
      excluded.push({ id: issue.id, reason });
    } else {
      kept.push(issue);
    }
  }
  return { kept, excluded };
}

// ---------------------------------------------------------------------------
// SANDCASTLE.md parser (type:X heading → required skill list)
// ---------------------------------------------------------------------------

/**
 * Parse `SANDCASTLE.md` into a `type:X → required-skills[]` map.
 *
 * Walks the markdown line-by-line. State machine:
 *   - On a `### type:X` heading, open a new section keyed by the heading
 *     (e.g. `type:new-component`).
 *   - Within a section, on a `Required:` line, enter "collecting" mode.
 *   - Each `-` bullet while collecting contributes its first
 *     whitespace-delimited token to the required list (so descriptive
 *     prose in parens like `impeccable (load design context)` reduces to
 *     `impeccable`). `Required: (none)` is treated as zero bullets and
 *     the section's array stays empty — explicitly NOT a sentinel; the
 *     validator composes cleanly over an empty array.
 *   - Stop collecting on a blank line, a line whose trimmed form starts
 *     with `Opt in` (case-sensitive — that's the literal text in the
 *     file), or the next `###` heading.
 *
 * The parser deliberately ignores `tool:` opt-in bullets — those live
 * under separate `Opt in via tool:` blocks and represent per-ticket
 * opt-in skills, not the unconditional Required set the gate enforces.
 *
 * Callers (orchestrator startup) parse SANDCASTLE.md once, then look up
 * each dispatched issue's `type:X` label in the resulting map to compute
 * `requiredSkills` per issue. A `type:` label with no matching section
 * yields `undefined` from the map's `.get()` and the gate becomes a
 * no-op for that issue (matches SANDCASTLE.md's "graceful degradation"
 * rule — unknown type labels dispatch normally).
 */
export function parseRequiredSkillsByType(
  content: string,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  const lines = content.split("\n");
  let currentType: string | null = null;
  let collecting = false;
  // SANDCASTLE.md puts a blank line between `Required:` and the first
  // bullet, AND between the last bullet and the `Opt in` line. We only
  // want the second blank line (after bullets) to terminate collection
  // — the first one is benign formatting. Track "have we seen at least
  // one bullet yet?" with this flag, which resets on every new section.
  let sawBullet = false;
  for (const line of lines) {
    const trimmed = line.trim();
    // Section boundary: any `###` heading. If it's a `type:` heading, open
    // a new section; otherwise close out the previous one (e.g. a `### Opt-in
    // mechanism` heading ends the last `type:` section).
    if (trimmed.startsWith("### ")) {
      const heading = trimmed.slice(4).trim();
      if (heading.startsWith("type:")) {
        currentType = heading;
        if (!out.has(currentType)) out.set(currentType, []);
      } else {
        currentType = null;
      }
      collecting = false;
      sawBullet = false;
      continue;
    }
    if (currentType === null) continue;
    // Enter collecting mode on the `Required:` line. The line itself may
    // also carry inline content (e.g. `Required: (none)`), which is fine —
    // there's no bullet on this line so nothing is collected for it. Reset
    // sawBullet so the next blank line is tolerated until bullets start.
    // Match `Required:` (legacy) and `Required critique dimensions:` (ADR 0006
    // outcome-language). Both signal the start of the rubric block; we don't
    // care what the prefix is, only that bullets follow.
    if (trimmed.startsWith("Required")) {
      collecting = true;
      sawBullet = false;
      continue;
    }
    if (!collecting) continue;
    // End-of-block conditions while collecting:
    //   - `Opt in...` lead-in line → always terminates.
    //   - Blank line → terminates ONLY after we've seen at least one
    //     bullet. The blank line that sits between `Required:` and the
    //     first bullet (canonical SANDCASTLE.md formatting) must NOT
    //     end the block.
    //   - Next `### ...` heading → handled by the `### ` branch above.
    if (trimmed.startsWith("Opt in")) {
      collecting = false;
      continue;
    }
    if (trimmed.length === 0) {
      if (sawBullet) collecting = false;
      continue;
    }
    // Bullet inside the Required block. First whitespace-delimited token
    // after the `- ` lead. Drops any trailing prose like
    // `(load design context — prerequisite ...)`.
    if (trimmed.startsWith("- ")) {
      const after = trimmed.slice(2).trim();
      if (after.length === 0) continue;
      const token = after.split(/\s+/)[0] ?? "";
      // Skip stray `tool:` bullets defensively — these belong under
      // `Opt in via tool:` blocks, not `Required:`. The current file
      // doesn't mix them, but a future edit might.
      if (token.length === 0) continue;
      if (token.startsWith("tool:")) continue;
      out.get(currentType)!.push(token);
      sawBullet = true;
      continue;
    }
    // Non-bullet, non-blank line while collecting — treat as out-of-block
    // narration (e.g. an inline paragraph after Required:). Stop collecting
    // so we don't accidentally absorb prose into the required list.
    collecting = false;
  }
  // Freeze each array so consumers can't mutate the returned map.
  const frozen = new Map<string, readonly string[]>();
  for (const [k, v] of out) frozen.set(k, Object.freeze(v.slice()));
  return frozen;
}

// ---------------------------------------------------------------------------
// Required-vs-invoked validator
// ---------------------------------------------------------------------------

/**
 * Compute the set difference `required \ invoked`, preserving the order of
 * `required` in the returned `missing` array. Order preservation matters:
 * downstream error messages are read by humans, and a deterministic
 * required-list-order presentation makes triage faster ("we always list the
 * missing skills in the same canonical order as SANDCASTLE.md").
 *
 * Pure function with no I/O — safe to call inside hot paths.
 */
export function validateRequiredSkillsInvoked(
  required: readonly string[],
  invoked: readonly string[],
): { readonly missing: readonly string[] } {
  const invokedSet = new Set(invoked);
  return { missing: required.filter((s) => !invokedSet.has(s)) };
}

// ---------------------------------------------------------------------------
// Custom error type for the implementer + post-merge-fixer gates
// ---------------------------------------------------------------------------
