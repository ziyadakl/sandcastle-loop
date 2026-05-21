/**
 * Tests for skill-discipline enforcement: per-implementer collection of
 * `Skill()` tool-call invocations from the SDK agent stream, used as
 * host-computed ground truth for the reviewer.
 */
import { describe, it, expect } from "vitest";
import { collectSkillInvocations } from "../.sandcastle/main.mjs";
import { filterPlanByTypeLabels } from "../.sandcastle/main.mjs";

describe("collectSkillInvocations", () => {
  it("returns a collector with empty list before any events", () => {
    const c = collectSkillInvocations();
    expect(c.invoked).toEqual([]);
  });

  it("appends the skill name when a Skill toolCall fires", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: 'skill: "glass-morphism"',
      iteration: 1,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual(["glass-morphism"]);
  });

  it("ignores non-Skill tool calls", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "toolCall",
      name: "Bash",
      formattedArgs: 'command: "ls"',
      iteration: 1,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual([]);
  });

  it("ignores text events", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "text",
      message: "hello",
      iteration: 1,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual([]);
  });

  it("preserves invocation order", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: 'skill: "impeccable"',
      iteration: 1,
      timestamp: new Date(),
    });
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: 'skill: "layout"',
      iteration: 2,
      timestamp: new Date(),
    });
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: 'skill: "polish"',
      iteration: 3,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual(["impeccable", "layout", "polish"]);
  });

  it("parses skill names from different formattedArgs shapes", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: "skill: 'critique'",
      iteration: 1,
      timestamp: new Date(),
    });
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: "skill: `audit`",
      iteration: 2,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual(["critique", "audit"]);
  });

  it("falls back to raw args when parsing fails", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: "unrecognized-format",
      iteration: 1,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual(["unrecognized-format"]);
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
