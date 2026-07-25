import { describe, it, expect } from "vitest";
import { models, opus5Models } from "../.sandcastle/models.js";
import { parseSandcastleArgs, roleModelsFor } from "../.sandcastle/main.mjs";
import { codexModels } from "../.sandcastle/models.js";

describe("opus5Models", () => {
  it("sets the 6 opus-heavy roles to claude-opus-5 with empty escalations", () => {
    for (const role of [
      "planner",
      "implementer",
      "merger",
      "postMergeReviewer",
      "postMergeFixer",
      "recovery",
    ] as const) {
      expect(opus5Models[role].default).toBe("claude-opus-5");
      expect(opus5Models[role].escalations).toEqual([]);
    }
  });

  it("keeps reviewer + critique byte-identical to models", () => {
    expect(opus5Models.reviewer).toEqual(models.reviewer);
    expect(opus5Models.critique).toEqual(models.critique);
  });

  it("has the same role keys as models", () => {
    expect(Object.keys(opus5Models).sort()).toEqual(Object.keys(models).sort());
  });
});

describe("roleModelsFor with opus profile", () => {
  it("returns opus5Models for claude backend + profile 5", () => {
    expect(roleModelsFor({ backend: "claude", opusProfile: "5" })).toBe(opus5Models);
  });

  it("returns models for claude backend + profile 4.8 (default)", () => {
    expect(roleModelsFor({ backend: "claude", opusProfile: "4.8" })).toBe(models);
    expect(roleModelsFor({ backend: "claude" })).toBe(models);
  });

  it("returns codexModels for codex backend regardless of profile", () => {
    expect(roleModelsFor({ backend: "codex", opusProfile: "5" })).toBe(codexModels);
    expect(roleModelsFor({ backend: "codex", opusProfile: "4.8" })).toBe(codexModels);
  });
});

describe("parseSandcastleArgs --opus", () => {
  it("defaults opusProfile to 4.8 with no flag", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1"]);
    expect(args.opusProfile).toBe("4.8");
  });

  it("parses --opus 5", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--opus", "5"]);
    expect(args.opusProfile).toBe("5");
    expect(args.plannerModel).toBe("claude-opus-5");
    expect(args.implementerModel).toBe("claude-opus-5");
  });

  it("hard-errors on an invalid --opus value", () => {
    expect(() => parseSandcastleArgs(["--iterations", "1", "--opus", "6"])).toThrow();
  });

  it("hard-errors on --opus 5 + --backend codex", () => {
    expect(() =>
      parseSandcastleArgs(["--iterations", "1", "--opus", "5", "--backend", "codex"]),
    ).toThrow();
  });

  it("hard-errors on --opus 5 + --provider kimi", () => {
    expect(() =>
      parseSandcastleArgs(["--iterations", "1", "--opus", "5", "--provider", "kimi"]),
    ).toThrow();
  });

  it("does NOT error on --opus 4.8 + --backend codex", () => {
    expect(() =>
      parseSandcastleArgs(["--iterations", "1", "--opus", "4.8", "--backend", "codex"]),
    ).not.toThrow();
  });
});
