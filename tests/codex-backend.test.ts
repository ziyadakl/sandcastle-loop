// WS-A coverage for the Codex agent backend (ADR 0012): the backend-detection
// axis, the codex model map, and the `--backend codex` CLI selection. Kept in a
// dedicated file so it doesn't collide with the mac-host / skill-discipline /
// prompt test suites that the Codex port also touches.
import { describe, it, expect } from "vitest";
import { backendForModel } from "../.sandcastle/providers.js";
import { models, codexModels } from "../.sandcastle/models.js";
import { parseSandcastleArgs } from "../.sandcastle/main.mjs";

describe("backendForModel", () => {
  it("routes Codex / OpenAI model ids to the codex backend", () => {
    for (const id of [
      "gpt-5.5",
      "gpt-5.1-codex",
      "o3",
      "o1-mini",
      "codex-mini",
      "GPT-5.5", // case-insensitive
    ]) {
      expect(backendForModel(id)).toBe("codex");
    }
  });

  it("routes Claude / Kimi / GLM ids to the claude backend", () => {
    for (const id of [
      "claude-opus-4-8",
      "claude-opus-4-8[1m]",
      "claude-haiku-4-5",
      "kimi-for-coding",
      "glm-4.6",
    ]) {
      expect(backendForModel(id)).toBe("claude");
    }
  });
});

describe("codexModels", () => {
  it("covers exactly the same roles as the claude models map", () => {
    expect(Object.keys(codexModels).sort()).toEqual(Object.keys(models).sort());
  });

  it("pins every role to a model the dispatcher routes to codex", () => {
    for (const role of Object.keys(codexModels) as (keyof typeof codexModels)[]) {
      expect(backendForModel(codexModels[role].default)).toBe("codex");
    }
  });

  it("defines no escalation ladder (a codex run must never escalate onto a Claude model)", () => {
    for (const role of Object.keys(codexModels) as (keyof typeof codexModels)[]) {
      expect(codexModels[role].escalations).toEqual([]);
    }
  });
});

describe("--backend flag (parseSandcastleArgs)", () => {
  it("defaults to the claude models when omitted", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1"]);
    expect(args.plannerModel).toBe(models.planner.default);
    expect(args.implementerModel).toBe(models.implementer.default);
    expect(backendForModel(args.implementerModel)).toBe("claude");
  });

  it("routes every role to codex models under --backend codex", () => {
    const { args } = parseSandcastleArgs(["--iterations", "1", "--backend", "codex"]);
    expect(args.plannerModel).toBe(codexModels.planner.default);
    expect(args.implementerModel).toBe(codexModels.implementer.default);
    expect(args.reviewerModel).toBe(codexModels.reviewer.default);
    expect(args.critiqueModel).toBe(codexModels.critique.default);
    expect(args.mergerModel).toBe(codexModels.merger.default);
    expect(args.backend).toBe("codex");
    expect(backendForModel(args.implementerModel)).toBe("codex");
  });

  it("still honors an explicit --implementer-model over the backend default", () => {
    const { args } = parseSandcastleArgs([
      "--iterations",
      "1",
      "--backend",
      "codex",
      "--implementer-model",
      "gpt-5.1-codex",
    ]);
    expect(args.implementerModel).toBe("gpt-5.1-codex");
  });

  it("rejects --provider combined with --backend codex", () => {
    expect(() =>
      parseSandcastleArgs([
        "--iterations",
        "1",
        "--backend",
        "codex",
        "--provider",
        "kimi",
      ]),
    ).toThrow(/provider/i);
  });

  it("rejects an unknown --backend value", () => {
    expect(() =>
      parseSandcastleArgs(["--iterations", "1", "--backend", "bogus"]),
    ).toThrow(/backend/i);
  });

  it("infers codex backend from an explicit codex --implementer-model (no --backend)", () => {
    const { args } = parseSandcastleArgs([
      "--iterations",
      "1",
      "--implementer-model",
      "gpt-5.1-codex",
    ]);
    // The whole run flips to codex — not just the implementer — so policy
    // (escalations/role defaults) can't split from dispatch (agent factory).
    expect(args.backend).toBe("codex");
    expect(args.implementerModel).toBe("gpt-5.1-codex");
    expect(args.plannerModel).toBe(codexModels.planner.default);
    expect(args.reviewerModel).toBe(codexModels.reviewer.default);
    expect(backendForModel(args.implementerModel)).toBe("codex");
  });

  it("hard-errors when --backend codex contradicts a claude --implementer-model", () => {
    expect(() =>
      parseSandcastleArgs([
        "--iterations",
        "1",
        "--backend",
        "codex",
        "--implementer-model",
        "claude-sonnet-4-6",
      ]),
    ).toThrow(/contradict/i);
  });

  it("hard-errors when --backend claude contradicts a codex --implementer-model", () => {
    expect(() =>
      parseSandcastleArgs([
        "--iterations",
        "1",
        "--backend",
        "claude",
        "--implementer-model",
        "gpt-5.1-codex",
      ]),
    ).toThrow(/contradict/i);
  });
});
