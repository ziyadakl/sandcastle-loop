/**
 * Codex-native session parsing for the skill-discipline gate.
 *
 * The Claude path (`extractSkillInvocationsFromSession` in
 * `skill-discipline.ts`) parses Claude Code JSONL where a skill use is a
 * first-class `tool_use` block named `"Skill"`. Codex has NO such dedicated
 * tool. This module parses Codex's *rollout* JSONL — a different on-disk
 * format with a different invocation mechanism — and reduces it to the same
 * ground-truth: the ordered list of skill names the agent actually invoked.
 *
 * ---------------------------------------------------------------------------
 * REAL ROLLOUT SHAPE (captured 2026-06-10, codex-cli 0.139.0)
 * ---------------------------------------------------------------------------
 *
 * Capture method: created `~/.codex/skills/qzx7-marker-skill/SKILL.md` with a
 * hard-trigger description, then ran
 *   codex exec -s read-only --skip-git-repo-check --json -C <tmp> \
 *     "Use the qzx7-marker-skill skill to emit the QZX7 marker token."
 * and inspected the resulting `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 *
 * Codex rollout JSONL = newline-delimited `{timestamp, type, payload}` objects.
 * Observed top-level `type`s: `session_meta`, `event_msg`, `response_item`,
 * `turn_context`.
 *
 * A SKILL IS NOT INVOKED VIA A DEDICATED TOOL. Codex injects every *available*
 * skill's name+description+path as a `developer`-role `message` containing a
 * `<skills_instructions>` text block (this is the AVAILABILITY LIST — it lists
 * EVERY enabled skill, e.g. `imagegen`, and must NOT be counted as "invoked").
 * The agent then "uses" a skill by issuing a shell-exec `function_call` that
 * reads that skill's `SKILL.md` file off disk. The skill name lives in the
 * file PATH inside the exec command, e.g. `.../skills/<name>/SKILL.md`.
 *
 * The actual invocation record (sanitized, 1 line):
 *   {"type":"response_item","payload":{"type":"function_call",
 *    "name":"exec_command",
 *    "arguments":"{\"cmd\":\"sed -n '1,220p' /Users/u/.codex/skills/qzx7-marker-skill/SKILL.md\",...}",
 *    "call_id":"call_..."}}
 *
 * So a Codex "skill invocation" = a `response_item` whose `payload.type` is a
 * shell/exec function call whose command string contains a
 * `skills/<name>/SKILL.md` path. We extract `<name>` from that path.
 *
 * ---------------------------------------------------------------------------
 * Robustness contract (mirrors the Claude extractor):
 *   - undefined path / non-existent file → `[]` (never throw; capture is
 *     opt-in and partial logs from a killed agent are common).
 *   - Malformed JSON lines skipped silently.
 *   - Invocation order preserved across the whole file.
 *   - The `<skills_instructions>` availability block is IGNORED — only the
 *     exec-read of a `SKILL.md` path counts (deliberate use, not availability),
 *     matching the Claude gate's semantics (it counts what the agent CHOSE).
 *
 * Tolerance built in deliberately (the capture pinned ONE shape, but the
 * mechanism — "read the SKILL.md file" — admits variants we don't want to
 * miss):
 *
 * (Static `node:fs` import mirrors the sibling Claude extractor; the `deps`
 * override keeps the function unit-testable without a real fixture on disk.)
 *   - The function-call `name` is not hardcoded: observed `exec_command`, but
 *     older/other codex builds emit `shell`, `local_shell_call`, etc. We match
 *     on the *command content* (a `SKILL.md` path), not the tool name.
 *   - `payload.arguments` is a JSON-encoded STRING (observed) holding the
 *     command under `cmd`; we also accept `command` and array-of-args forms,
 *     and as a last resort scan the raw arguments string for a SKILL.md path.
 *   - Any read tool works (`sed`/`cat`/`head`/`rg`/`python …`) — we only care
 *     that a `skills/<name>/SKILL.md` path appears in the command.
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * Match a `skills/<name>/SKILL.md` path anywhere in a command string and
 * capture `<name>`. The `skills/` prefix is what disambiguates a genuine skill
 * read from an unrelated file read; `<name>` is the directory immediately
 * preceding `SKILL.md`. Case-insensitive on the `SKILL.md` filename only —
 * the dir name is taken verbatim (skill names are case-sensitive identifiers).
 *
 * Examples that match (capture group → name):
 *   /Users/u/.codex/skills/qzx7-marker-skill/SKILL.md  → qzx7-marker-skill
 *   ~/.codex/skills/simplify/SKILL.md                  → simplify
 *   .codex/skills/new-component/SKILL.md               → new-component
 */
const SKILL_MD_PATH = /skills\/([^/\s"']+)\/SKILL\.md/gi;

/**
 * Pull every `skills/<name>/SKILL.md` skill name out of a shell command
 * string. A single command could touch more than one SKILL.md (unusual but
 * possible); all are returned in textual order.
 */
function skillNamesFromCommand(command: string): string[] {
  const out: string[] = [];
  SKILL_MD_PATH.lastIndex = 0; // reset stateful global regex before each use
  let m: RegExpExecArray | null;
  while ((m = SKILL_MD_PATH.exec(command)) !== null) {
    const name = m[1];
    if (name !== undefined && name.length > 0) out.push(name);
  }
  return out;
}

/**
 * Coerce a `response_item` exec `payload` into the command string(s) it ran,
 * tolerating the several shapes codex has used for shell function calls.
 *
 * Observed (0.139.0): `payload.arguments` is a JSON STRING like
 *   `{"cmd":"sed -n ... /path/SKILL.md","yield_time_ms":...}`
 * Also handled defensively (UNOBSERVED — best-effort tolerance, not verified):
 * `arguments.command` (string or string[]), a pre-parsed object `arguments`,
 * a top-level `payload.command` array, and `payload.action.command` (the
 * OpenAI Responses-API `local_shell_call` shape, where the command lives under
 * `action`). When all structured paths fail we fall back to scanning the raw
 * arguments string itself — the SKILL.md path is present there regardless of
 * field naming.
 */
function commandStringsFromPayload(payload: {
  readonly arguments?: unknown;
  readonly command?: unknown;
  readonly action?: unknown;
}): string[] {
  const cmds: string[] = [];
  const pushCommandField = (val: unknown): void => {
    if (typeof val === "string") cmds.push(val);
    else if (Array.isArray(val)) cmds.push(val.filter((x) => typeof x === "string").join(" "));
  };

  // Top-level `payload.command` (array-of-args style exec records).
  pushCommandField(payload.command);

  // `payload.action.command` — OpenAI Responses-API `local_shell_call` nests
  // its argv under `action` (`{type:"exec", command:[...]}`).
  if (typeof payload.action === "object" && payload.action !== null) {
    pushCommandField((payload.action as { command?: unknown }).command);
  }

  // `payload.arguments`: usually a JSON-encoded string; sometimes an object.
  const args = payload.arguments;
  if (typeof args === "string" && args.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
      const a = parsed as { cmd?: unknown; command?: unknown };
      pushCommandField(a.cmd);
      pushCommandField(a.command);
    }
    // Last resort: scan the raw arguments JSON string itself. If structured
    // extraction missed the field (unknown key), the SKILL.md path is still
    // present verbatim in the serialized arguments.
    if (cmds.length === 0) cmds.push(args);
  } else if (typeof args === "object" && args !== null) {
    const a = args as { cmd?: unknown; command?: unknown };
    pushCommandField(a.cmd);
    pushCommandField(a.command);
  }

  return cmds;
}

/**
 * Extract every skill the agent invoked from a captured Codex rollout JSONL
 * file. Returns skill names in invocation order — the Codex-backend equivalent
 * of {@link extractSkillInvocationsFromSession} for Claude.
 *
 * A skill counts as invoked iff the agent issued a shell/exec `function_call`
 * whose command reads that skill's `skills/<name>/SKILL.md` file. The
 * `<skills_instructions>` availability block (a `developer` message listing all
 * enabled skills) is deliberately NOT parsed — it reflects what was *offered*,
 * not what the agent *chose*, and counting it would make the gate vacuous
 * (every available skill would read as "invoked").
 *
 * Robustness mirrors the Claude extractor exactly: undefined/missing file →
 * `[]`, malformed lines skipped, order preserved, never throws.
 *
 * `readFile`/`fileExists` are injected so the signature stays pure-importable
 * and unit-testable without a real fixture on disk; production callers use the
 * `node:fs` defaults.
 */
export function extractSkillInvocationsFromCodexSession(
  sessionFilePath: string | undefined,
  deps?: {
    readonly fileExists?: (p: string) => boolean;
    readonly readFile?: (p: string) => string;
  },
): readonly string[] {
  if (sessionFilePath === undefined) return [];
  const fileExists = deps?.fileExists ?? ((p: string) => existsSync(p));
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  if (!fileExists(sessionFilePath)) return [];
  let raw: string;
  try {
    raw = readFile(sessionFilePath);
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
    const o = obj as { type?: unknown; payload?: unknown };
    // Only response_item records carry exec function calls. event_msg /
    // session_meta / turn_context never hold a skill read.
    if (o.type !== "response_item") continue;
    const payload = o.payload as
      | { type?: unknown; arguments?: unknown; command?: unknown; action?: unknown }
      | null
      | undefined;
    if (!payload || typeof payload !== "object") continue;
    // We do NOT gate on a specific payload.type/name — a skill read can come
    // from any shell/exec function-call variant. We gate on the COMMAND
    // CONTENT instead (a SKILL.md path). `message` records (incl. the
    // <skills_instructions> availability block) carry no arguments/command
    // field, so they naturally fall through with no match.
    const ptype = (payload as { type?: unknown }).type;
    if (ptype !== "function_call" && ptype !== "local_shell_call" && ptype !== "custom_tool_call") {
      // Fast-skip records that are clearly not exec calls (e.g. plain
      // messages, reasoning) — but only when we can positively identify them.
      // If type is absent/unknown we still try, since older builds vary.
      if (typeof ptype === "string") continue;
    }
    for (const cmd of commandStringsFromPayload(payload)) {
      for (const name of skillNamesFromCommand(cmd)) out.push(name);
    }
  }
  return out;
}
