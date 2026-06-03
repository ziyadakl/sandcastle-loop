/**
 * Skill-discipline helpers.
 *
 * Self-contained domain logic for the orchestrator's skill-discipline gate.
 * No dependency on `.sandcastle/main.mts` internals — kept in `lib/` per the
 * CONTEXT.md pattern (`code that doesn't touch orchestrator internals lives
 * in lib/`).
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
 *      pre-compute the required-skill set per dispatched issue and the
 *      implementer/fixer gates can fail-fast on omissions.
 *
 *   4. {@link validateRequiredSkillsInvoked} — set-diff between the
 *      pre-computed required list and the host-extracted invoked list,
 *      returning the missing skills (preserving required-list order so
 *      operator-facing error messages stay deterministic).
 *
 *   5. {@link findLoadableRubrics} — dual-path (project-local then
 *      `~/.claude/skills/`) existence check for the critique sub-agent's
 *      required design rubrics. Drives the no-rubric preflight.
 *
 *   6. {@link MissingRequiredSkillsError} / {@link CritiqueCriticalError} /
 *      {@link critiqueErrorReasonCode} — structured error types + reason-code
 *      mapping for the two-gate design (skill-discipline backstop + critique
 *      outcome-gate). See `docs/adr/0006-sandcastle-critique-as-gate.md`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Thrown by the per-issue implementer skill-discipline gate when the
 * agent skipped one or more required `Skill()` invocations for its
 * ticket's `type:X` label. Carries structured `missing`/`invoked`/
 * `required`/`issueNumber` fields alongside the formatted message so
 * the orchestrator's quarantine path can `instanceof`-check the error
 * and emit a distinct `skill-discipline-fail` reason for human triage.
 *
 * History: this class was removed on 2026-05-30 per ADR 0006 v1 when
 * the skill-counting gate was demoted to telemetry, then restored on
 * 2026-06-02 per ADR 0006 v3 when log analysis showed critique-as-gate
 * silently abstains on issues whose required principles lack SKILL.md
 * rubric files (#308/#309 shipped real dead code via that path). The
 * two-gate design now in force: critique grades the diff against
 * loaded rubrics; skill-discipline catches the abstention class
 * critique misses by enforcing Skill() invocation as a hard backstop.
 *
 * Scope note: only the per-issue implementer gate throws. The post-
 * merge-fixer gate remains WARN-only telemetry (separate concern —
 * the per-issue gate already covered each diff before rollup, so
 * doubling up at rollup level produces noise rather than signal).
 *
 * Using a plain `Error` would force the quarantine handler to string-
 * match the message to distinguish skill-discipline failures from
 * other thrown pipeline errors. The custom type makes the
 * discrimination structural.
 */
export class MissingRequiredSkillsError extends Error {
  readonly missing: readonly string[];
  readonly invoked: readonly string[];
  readonly required: readonly string[];
  readonly issueNumber: number;
  constructor(
    missing: readonly string[],
    invoked: readonly string[],
    required: readonly string[],
    issueNumber: number,
  ) {
    super(
      `skill-discipline: issue=${issueNumber} missed required Skill() ` +
        `invocations: ${missing.join(", ")}; invoked: ` +
        `${invoked.length === 0 ? "(none)" : invoked.join(", ")}`,
    );
    this.name = "MissingRequiredSkillsError";
    this.missing = missing;
    this.invoked = invoked;
    this.required = required;
    this.issueNumber = issueNumber;
  }
}

/**
 * Thrown by the critique sub-agent gate when the diff fails the
 * design-principles review with CRITICAL_BLOCKERS verdict. Carries the
 * critique's findings (markdown prose) and the issue's `type:` label
 * alongside the formatted message so the orchestrator's quarantine path
 * can `instanceof`-check the error, post the findings as a GitHub issue
 * comment, and emit a distinct `critique-critical-fail` reason for
 * human triage.
 *
 * Critique replaces the skill-counting gate's role as the design-discipline
 * blocker. See ADR 0006 for the architectural reasoning (process-gating
 * → outcome-gating).
 */
export class CritiqueCriticalError extends Error {
  readonly findings: string;
  readonly typeLabel: string;
  readonly retryExhausted: boolean;
  readonly criticalAfterRetry: boolean;
  readonly noRubricLoaded: boolean;
  constructor(
    findings: string,
    typeLabel: string,
    opts: {
      retryExhausted?: boolean;
      criticalAfterRetry?: boolean;
      noRubricLoaded?: boolean;
    } = {},
  ) {
    super(`critique CRITICAL_BLOCKERS for ${typeLabel} — see findings`);
    this.name = "CritiqueCriticalError";
    this.findings = findings;
    this.typeLabel = typeLabel;
    this.retryExhausted = opts.retryExhausted ?? false;
    this.criticalAfterRetry = opts.criticalAfterRetry ?? false;
    this.noRubricLoaded = opts.noRubricLoaded ?? false;
  }
}

/**
 * Given an issue's required critique principles, return the subset that
 * actually has a `.claude/skills/<name>/SKILL.md` file resolvable from
 * either the repo (`<repoRoot>/.claude/skills/<name>/SKILL.md`) or the
 * user's global Claude config (`<homeDir>/.claude/skills/<name>/SKILL.md`).
 * Project-local takes precedence semantically (the project can override a
 * global rubric by shipping its own copy), though here we only care that
 * at least one path resolves — the critique sub-agent uses the same
 * dual-path lookup when actually reading the rubric content.
 *
 * The home fallback exists because cross-project rubrics like `simplify`
 * (reuse / quality / efficiency) and `context7-docs` (verify library API
 * signatures before writing) are generic engineering principles that
 * naturally live in `~/.claude/skills/` rather than being duplicated into
 * every project's repo. Without the fallback, the orchestrator's
 * no-rubric preflight (`shipAfterMigrations` in main.mts) would quarantine
 * every backend slice on projects that rely on the global skills.
 *
 * `homeDir` is injectable for unit testing — production callers should
 * accept the default (`os.homedir()`); tests should pass an isolated
 * tmpdir to prevent the dev user's real `~/.claude/skills/` from leaking
 * positive results into assertions about repo-local-only setups.
 *
 * Pure-ish — performs filesystem reads but no writes. Safe in hot paths.
 */
export function findLoadableRubrics(
  required: readonly string[],
  repoRoot: string,
  homeDir: string = homedir(),
): readonly string[] {
  return required.filter(
    (name) =>
      existsSync(join(repoRoot, ".claude", "skills", name, "SKILL.md")) ||
      existsSync(join(homeDir, ".claude", "skills", name, "SKILL.md")),
  );
}

/**
 * Map a {@link CritiqueCriticalError} to its quarantine reason code and
 * the verdict header displayed in the GitHub issue comment. Four shapes:
 *
 * 1. `noRubricLoaded` — operator-config failure: zero SKILL.md files
 *    loaded for the issue's required principles. Highest precedence
 *    because no other flag is meaningful without rubric coverage.
 * 2. `criticalAfterRetry` — the implementer's critique-retry pass
 *    introduced a new CRITICAL verdict.
 * 3. `retryExhausted` — the critique-retry pass couldn't clear the
 *    original NEEDS_FIXES findings (or attempt-2 marker was malformed).
 * 4. default — first-pass CRITICAL or initial marker-parse failure.
 *
 * Extracted to a pure helper so the branching is testable without
 * driving the full `runIssuePipeline` catch handler.
 */
export function critiqueErrorReasonCode(err: CritiqueCriticalError): {
  readonly reasonCode: string;
  readonly verdictHeader: string;
} {
  if (err.noRubricLoaded) {
    return {
      reasonCode: "critique-no-rubric-loaded",
      verdictHeader: "NO RUBRIC LOADED (operator config)",
    };
  }
  if (err.criticalAfterRetry) {
    return {
      reasonCode: "critique-retry-critical",
      verdictHeader: "CRITICAL (introduced by retry)",
    };
  }
  if (err.retryExhausted) {
    return {
      reasonCode: "critique-retry-exhausted",
      verdictHeader: "NEEDS_FIXES (retry exhausted)",
    };
  }
  return {
    reasonCode: "critique-critical-fail",
    verdictHeader: "CRITICAL",
  };
}
