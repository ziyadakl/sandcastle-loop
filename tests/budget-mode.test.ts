import { describe, it, expect } from "vitest";
import { parseSandcastleArgs, roleModelsFor } from "../.sandcastle/main.mjs";
import { models, BUDGET_IMPLEMENTER_MODEL } from "../.sandcastle/models.js";

describe("--budget (Sonnet-5 implementer)", () => {
  it("defaults budget to false with no flag", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1"]);
    expect(args.budget).toBe(false);
    expect(args.implementerModel).toBe(models.implementer.default);
  });

  it("puts the implementer first-pass on Sonnet 5", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--budget"]);
    expect(args.budget).toBe(true);
    expect(args.implementerModel).toBe(BUDGET_IMPLEMENTER_MODEL);
    expect(BUDGET_IMPLEMENTER_MODEL).toBe("claude-sonnet-5");
  });

  it("keeps the Opus 1M escalation rung intact (budget touches only first pass)", () => {
    // The implementer's retry escalation reads roleModelsFor(...).implementer,
    // which --budget must NOT alter — hard issues still get Opus muscle.
    expect(roleModelsFor({ backend: "claude" }).implementer.escalations[0]).toBe(
      "claude-opus-4-8[1m]",
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

  it("does NOT change the other role models", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--budget"]);
    expect(args.reviewerModel).toBe(models.reviewer.default);
    expect(args.critiqueModel).toBe(models.critique.default);
    expect(args.plannerModel).toBe(models.planner.default);
    expect(args.mergerModel).toBe(models.merger.default);
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
});
