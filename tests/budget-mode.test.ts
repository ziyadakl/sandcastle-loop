import { describe, it, expect } from "vitest";
import {
  parseSandcastleArgs,
  roleModelsFor,
  escalationForAttempt,
} from "../.sandcastle/main.mjs";
import { models, budgetModels } from "../.sandcastle/models.js";

describe("--budget (per-role ladder)", () => {
  it("defaults budget to false with no flag", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1"]);
    expect(args.budget).toBe(false);
    expect(args.implementerModel).toBe(models.implementer.default);
  });

  it("puts the implementer first-pass on Opus 4.8 (1M)", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--budget"]);
    expect(args.budget).toBe(true);
    expect(args.implementerModel).toBe("claude-opus-4-8[1m]");
  });

  it("gives the budget implementer an Opus-1M retry rung then Opus 5", () => {
    const impl = roleModelsFor({ budget: true }).implementer;
    expect(impl.default).toBe("claude-opus-4-8[1m]");
    expect(impl.escalations).toEqual([
      "claude-opus-4-8[1m]",
      "claude-opus-5",
    ]);
  });

  it("keeps the Opus 1M escalation rung intact on the non-budget default", () => {
    // The implementer's retry escalation reads roleModelsFor(...).implementer,
    // which the DEFAULT (non-budget) profile leaves as the single Opus rung.
    expect(
      roleModelsFor({ backend: "claude" }).implementer.escalations,
    ).toEqual(["claude-opus-4-8[1m]"]);
  });

  it("pins the finalized budget ladder for every role", () => {
    expect(budgetModels.planner).toEqual({
      default: "claude-sonnet-5",
      escalations: [],
    });
    expect(budgetModels.implementer).toEqual({
      default: "claude-opus-4-8[1m]",
      escalations: ["claude-opus-4-8[1m]", "claude-opus-5"],
    });
    expect(budgetModels.reviewer).toEqual({
      default: "claude-haiku-4-5",
      escalations: ["claude-sonnet-5"],
    });
    expect(budgetModels.critique).toEqual({
      default: "claude-haiku-4-5",
      escalations: [],
    });
    expect(budgetModels.merger).toEqual({
      default: "claude-opus-4-8[1m]",
      escalations: ["claude-opus-5"],
    });
    expect(budgetModels.postMergeReviewer).toEqual({
      default: "claude-opus-4-8[1m]",
      escalations: ["claude-opus-5"],
    });
    expect(budgetModels.postMergeFixer).toEqual({
      default: "claude-opus-4-8[1m]",
      escalations: ["claude-opus-4-8[1m]"],
    });
    expect(budgetModels.recovery).toEqual({
      default: "claude-opus-4-8[1m]",
      escalations: ["claude-opus-4-8[1m]"],
    });
  });

  it("has the same role keys as models", () => {
    expect(Object.keys(budgetModels).sort()).toEqual(
      Object.keys(models).sort(),
    );
  });

  it("lets an explicit --implementer-model win over --budget", () => {
    const { args } = parseSandcastleArgs([
      "--iterations",
      "1",
      "--budget",
      "--implementer-model",
      "claude-opus-4-8",
    ]);
    expect(args.implementerModel).toBe("claude-opus-4-8");
  });

  it("resolves the other role models from the budget map", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--budget"]);
    expect(args.reviewerModel).toBe(budgetModels.reviewer.default);
    expect(args.critiqueModel).toBe(budgetModels.critique.default);
    expect(args.plannerModel).toBe(budgetModels.planner.default);
    expect(args.mergerModel).toBe(budgetModels.merger.default);
  });

  it("hard-errors on --budget + --backend codex", () => {
    expect(() =>
      parseSandcastleArgs(["--iterations", "1", "--budget", "--backend", "codex"]),
    ).toThrow();
  });

  it("hard-errors on --budget + --provider kimi", () => {
    expect(() =>
      parseSandcastleArgs(["--iterations", "1", "--budget", "--provider", "kimi"]),
    ).toThrow();
  });

  it("hard-errors on --budget + --opus 5 (contradictory profiles)", () => {
    expect(() =>
      parseSandcastleArgs(["--iterations", "1", "--budget", "--opus", "5"]),
    ).toThrow(/opus 5/i);
  });
});

describe("escalationForAttempt", () => {
  it("walks the budget ladder: attempt 2 → Opus 1M, attempt 3 → Opus 5", () => {
    const escalations = budgetModels.implementer.escalations;
    expect(escalationForAttempt(escalations, 2)).toBe("claude-opus-4-8[1m]");
    expect(escalationForAttempt(escalations, 3)).toBe("claude-opus-5");
  });

  it("clamps a single-element (non-budget) array to index 0 for BOTH attempts 2 and 3", () => {
    const escalations = models.implementer.escalations; // ["claude-opus-4-8[1m]"]
    expect(escalationForAttempt(escalations, 2)).toBe("claude-opus-4-8[1m]");
    expect(escalationForAttempt(escalations, 3)).toBe("claude-opus-4-8[1m]");
  });
});
