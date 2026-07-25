import { describe, it, expect } from "vitest";
import { blockTemplateCommit } from "../.sandcastle/lib/state/template-commit-guard.js";

describe("blockTemplateCommit", () => {
  it("blocks a skills/ commit made in an agent context (CLAUDECODE)", () => {
    const result = blockTemplateCommit({
      stagedPaths: ["skills/sandcastle-run/SKILL.md"],
      env: { CLAUDECODE: "1" },
    });
    expect(result.blocked).toBe(true);
    expect(result.reason).toMatch(/sandcastle-feedback/);
  });

  it("blocks a .sandcastle/lib/ commit made in an agent context", () => {
    const result = blockTemplateCommit({
      stagedPaths: [".sandcastle/lib/state/foo.ts"],
      env: { CLAUDECODE: "true" },
    });
    expect(result.blocked).toBe(true);
  });

  it("does NOT block non-template paths in an agent context", () => {
    const result = blockTemplateCommit({
      stagedPaths: ["README.md", ".sandcastle/main.mts"],
      env: { CLAUDECODE: "1" },
    });
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("does NOT block a template path with no agent env (human maintainer)", () => {
    const result = blockTemplateCommit({
      stagedPaths: ["skills/x/SKILL.md"],
      env: {},
    });
    expect(result.blocked).toBe(false);
  });

  it("blocks a mixed staging set where only one path is a template path", () => {
    const result = blockTemplateCommit({
      stagedPaths: ["README.md", "src/app.ts", ".sandcastle/lib/state/bar.ts"],
      env: { CLAUDECODE: "1" },
    });
    expect(result.blocked).toBe(true);
  });

  it("blocks when SANDCASTLE_LOOP is set even if CLAUDECODE is unset", () => {
    const result = blockTemplateCommit({
      stagedPaths: ["skills/sandcastle-run/SKILL.md"],
      env: { SANDCASTLE_LOOP: "1" },
    });
    expect(result.blocked).toBe(true);
  });
});
