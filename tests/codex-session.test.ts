/**
 * Tests for the Codex rollout-JSONL skill-discipline parser.
 *
 * `extractSkillInvocationsFromCodexSession` is the Codex-backend equivalent of
 * the Claude `extractSkillInvocationsFromSession`: it reduces a captured codex
 * rollout `.jsonl` to the ordered list of skill names the agent actually
 * invoked, where an invocation is a shell/exec `function_call` that reads a
 * `skills/<name>/SKILL.md` path off disk. This file is the parser's only
 * coverage — it backs a GATE, so the priority is the false-gate / false-positive
 * cases: the `<skills_instructions>` availability block must be IGNORED, and the
 * defensive (UNOBSERVED) payload shapes must still extract.
 *
 * Pattern mirrors tests/skill-discipline.test.ts: write JSONL fixtures to a
 * tmpdir, pass the absolute path, assert against the real fs (the parser's
 * injectable deps default to node:fs).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSkillInvocationsFromCodexSession } from "../.sandcastle/lib/codex-session.js";

describe("extractSkillInvocationsFromCodexSession", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-codex-session-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeFixture = (name: string, lines: readonly unknown[]): string => {
    const p = join(dir, name);
    writeFileSync(
      p,
      lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"),
      "utf8",
    );
    return p;
  };

  // --- robustness contract ---------------------------------------------------

  it("returns [] when sessionFilePath is undefined", () => {
    expect(extractSkillInvocationsFromCodexSession(undefined)).toEqual([]);
  });

  it("returns [] when the file does not exist", () => {
    expect(
      extractSkillInvocationsFromCodexSession(join(dir, "nope.jsonl")),
    ).toEqual([]);
  });

  it("skips malformed JSON lines and still extracts from valid records", () => {
    const p = writeFixture("malformed.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "cat ~/.codex/skills/alpha/SKILL.md" }),
        },
      },
      "this is not json {{{",
      '{"type":"response_item","payload":{"type":"func',
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "cat ~/.codex/skills/beta/SKILL.md" }),
        },
      },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual(["alpha", "beta"]);
  });

  it("ignores non-response_item records (session_meta / event_msg / turn_context)", () => {
    const p = writeFixture("non-response.jsonl", [
      { type: "session_meta", payload: { cwd: "/x/skills/ghost/SKILL.md" } },
      { type: "event_msg", payload: { text: "read /x/skills/ghost/SKILL.md" } },
      { type: "turn_context", payload: {} },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual([]);
  });

  // --- false-gate: availability block must NOT count -------------------------

  it("IGNORES the <skills_instructions> availability block (offered != invoked)", () => {
    const p = writeFixture("availability.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "text",
              text:
                "<skills_instructions>\nAvailable skills:\n" +
                "- imagegen: ~/.codex/skills/imagegen/SKILL.md\n" +
                "- tdd: ~/.codex/skills/tdd/SKILL.md\n" +
                "</skills_instructions>",
            },
          ],
        },
      },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual([]);
  });

  it("counts a real read even when the availability block lists other skills", () => {
    const p = writeFixture("avail-then-read.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "text",
              text:
                "<skills_instructions>- imagegen: ~/.codex/skills/imagegen/SKILL.md</skills_instructions>",
            },
          ],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "sed -n '1,220p' ~/.codex/skills/tdd/SKILL.md" }),
        },
      },
    ]);
    // Only the skill the agent CHOSE to read — never the offered `imagegen`.
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual(["tdd"]);
  });

  // --- observed shape (codex-cli 0.139.0) ------------------------------------

  it("extracts from the observed shape: arguments JSON-string with `cmd`", () => {
    const p = writeFixture("observed-cmd.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: "sed -n '1,220p' /Users/u/.codex/skills/qzx7-marker-skill/SKILL.md",
            yield_time_ms: 5000,
          }),
        },
      },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual([
      "qzx7-marker-skill",
    ]);
  });

  it("extracts from arguments JSON-string with `command` (string)", () => {
    const p = writeFixture("args-command.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          arguments: JSON.stringify({ command: "cat .claude/skills/diagnose/SKILL.md" }),
        },
      },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual(["diagnose"]);
  });

  // --- defensive (UNOBSERVED) shapes -----------------------------------------

  it("extracts from the UNOBSERVED action.command shape (local_shell_call)", () => {
    const p = writeFixture("action-command.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "local_shell_call",
          action: { type: "exec", command: ["cat", "/root/.codex/skills/simplify/SKILL.md"] },
        },
      },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual(["simplify"]);
  });

  it("extracts from the UNOBSERVED arguments-as-object shape", () => {
    const p = writeFixture("args-object.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          arguments: { cmd: "head -n 50 .codex/skills/new-component/SKILL.md" },
        },
      },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual(["new-component"]);
  });

  it("extracts from a top-level payload.command array", () => {
    const p = writeFixture("top-command.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          command: ["cat", "~/.claude/skills/grill-me/SKILL.md"],
        },
      },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual(["grill-me"]);
  });

  it("falls back to scanning the raw arguments string when the field is unknown", () => {
    // Structured extraction finds no cmd/command, so the parser scans the raw
    // serialized arguments — the SKILL.md path is present there regardless.
    const p = writeFixture("raw-fallback.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          arguments: JSON.stringify({ shell_cmd: "cat ~/.claude/skills/triage/SKILL.md" }),
        },
      },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual(["triage"]);
  });

  // --- ordering / multiplicity ----------------------------------------------

  it("preserves invocation order across the whole file", () => {
    const p = writeFixture("ordered.jsonl", [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          arguments: JSON.stringify({ cmd: "cat ~/.codex/skills/first/SKILL.md" }),
        },
      },
      { type: "event_msg", payload: { text: "thinking..." } },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          arguments: JSON.stringify({ cmd: "cat ~/.codex/skills/second/SKILL.md" }),
        },
      },
    ]);
    expect(extractSkillInvocationsFromCodexSession(p)).toEqual(["first", "second"]);
  });
});
