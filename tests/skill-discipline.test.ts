/**
 * Tests for skill-discipline enforcement.
 *
 * `extractSkillInvocationsFromSession` parses the captured Claude Code
 * session JSONL produced by `@ai-hero/sandcastle`'s orchestrator (exposed
 * as `IterationResult.sessionFilePath`). It returns the ordered list of
 * `Skill()` tool-call invocations so the reviewer prompt has host-computed
 * ground truth rather than self-reported claims from the implementer.
 *
 * The prior implementation relied on the SDK's `onAgentStreamEvent`
 * callback, which is fed by `parseStreamJsonLine` in
 * `node_modules/@ai-hero/sandcastle/dist/AgentProvider.js`. That function
 * hardcodes a `TOOL_ARG_FIELDS` allowlist of `Bash`, `WebSearch`,
 * `WebFetch`, `Agent` — every other `tool_use` block (including `Skill`)
 * is silently dropped before a `tool_call` event ever fires. These tests
 * exercise the JSONL parser end-to-end so we know the skill list reaching
 * the reviewer is real.
 *
 * `filterPlanByTypeLabels` is exercised separately at the bottom of the
 * file (unchanged by the JSONL refactor — kept here for cohesion).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractSkillInvocationsFromSession,
  filterPlanByTypeLabels,
} from "../.sandcastle/lib/skill-discipline.js";

describe("extractSkillInvocationsFromSession", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sandcastle-skill-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeFixture = (name: string, lines: readonly string[]): string => {
    const p = join(dir, name);
    writeFileSync(p, lines.join("\n"), "utf8");
    return p;
  };

  it("returns [] when sessionFilePath is undefined", () => {
    expect(extractSkillInvocationsFromSession(undefined)).toEqual([]);
  });

  it("returns [] when the file does not exist", () => {
    const ghost = join(dir, "does-not-exist.jsonl");
    expect(extractSkillInvocationsFromSession(ghost)).toEqual([]);
  });

  it("returns [] for an empty file", () => {
    const p = writeFixture("empty.jsonl", []);
    expect(extractSkillInvocationsFromSession(p)).toEqual([]);
  });

  it("returns [] when the file has no Skill tool_use blocks", () => {
    const p = writeFixture("no-skills.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "thinking..." },
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "ok" }] },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([]);
  });

  it("extracts a single Skill invocation", () => {
    const p = writeFixture("one-skill.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg_x",
          content: [
            { type: "text", text: "I'll use the skill." },
            {
              type: "tool_use",
              id: "toolu_x",
              name: "Skill",
              input: { skill: "glass-morphism" },
            },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "glass-morphism",
    ]);
  });

  it("preserves the order of multiple Skill invocations across lines", () => {
    const p = writeFixture("multi-skill.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "impeccable" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "layout" } },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "polish" } },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "impeccable",
      "layout",
      "polish",
    ]);
  });

  it("returns only Skill names from a mixed tool_use stream, in order", () => {
    const p = writeFixture("mixed.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "pwd" } },
            { type: "tool_use", name: "Skill", input: { skill: "critique" } },
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/a/b.ts" },
            },
            { type: "tool_use", name: "Skill", input: { skill: "audit" } },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "critique",
      "audit",
    ]);
  });

  it("skips malformed JSON lines and still extracts Skill names from valid lines", () => {
    const p = writeFixture("malformed.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "first" } },
          ],
        },
      }),
      "this is not json {{{",
      "{\"type\": \"assistant\", \"message\": {\"content\": [", // truncated
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "second" } },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "first",
      "second",
    ]);
  });

  it("finds a Skill tool_use at a non-first position in the content array", () => {
    const p = writeFixture("not-first.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "ok" },
            { type: "text", text: "still thinking" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "trailing-skill" },
            },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual([
      "trailing-skill",
    ]);
  });

  it("ignores non-assistant message types (user/system)", () => {
    const p = writeFixture("non-assistant.jsonl", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "x" }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "irrelevant" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "only-one" } },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual(["only-one"]);
  });

  it("ignores Skill tool_use blocks with non-string skill input", () => {
    const p = writeFixture("bad-skill-input.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: 42 } },
            { type: "tool_use", name: "Skill", input: {} },
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "valid-one" },
            },
          ],
        },
      }),
    ]);
    expect(extractSkillInvocationsFromSession(p)).toEqual(["valid-one"]);
  });
});

describe("filterPlanByTypeLabels", () => {
  it("includes tickets that have a type: label", () => {
    const issues = [
      { id: "71", title: "new ui", branch: "agent/issue-71" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      ["71", ["ready-for-agent", "type:new-component"]],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, true);
    expect(r.kept).toEqual(issues);
    expect(r.excluded).toEqual([]);
  });

  it("excludes tickets missing a type: label when SANDCASTLE.md exists", () => {
    const issues = [
      { id: "72", title: "broken backend", branch: "agent/issue-72" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      ["72", ["ready-for-agent"]],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, true);
    expect(r.kept).toEqual([]);
    expect(r.excluded).toEqual([
      { id: "72", reason: "missing type: label" },
    ]);
  });

  it("excludes tickets with multiple type: labels (config error)", () => {
    const issues = [
      { id: "73", title: "ambiguous", branch: "agent/issue-73" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      [
        "73",
        ["ready-for-agent", "type:new-component", "type:backend"],
      ],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, true);
    expect(r.kept).toEqual([]);
    expect(r.excluded).toEqual([
      { id: "73", reason: "multiple type: labels" },
    ]);
  });

  it("does NOT filter when sandcastleMdExists is false (backward compat)", () => {
    const issues = [
      { id: "74", title: "no sandcastle", branch: "agent/issue-74" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      ["74", ["ready-for-agent"]],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, false);
    expect(r.kept).toEqual(issues);
    expect(r.excluded).toEqual([]);
  });
});
