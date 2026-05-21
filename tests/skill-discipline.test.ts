/**
 * Tests for skill-discipline enforcement: per-implementer collection of
 * `Skill()` tool-call invocations from the SDK agent stream, used as
 * host-computed ground truth for the reviewer.
 */
import { describe, it, expect } from "vitest";
import { collectSkillInvocations } from "../.sandcastle/main.mjs";

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
