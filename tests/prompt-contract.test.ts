/**
 * Gate ↔ prompt contract invariants.
 *
 * Background: twice now (affinity-tracker #310, then #316) a host-side gate was
 * hardened from warn → throw WITHOUT the model-facing prompt being updated in
 * the same change, so the next real run quarantined on a reason code the prompt
 * never told the implementer about. These tests lock that contract so the same
 * class of regression fails in CI instead of in a 30-minute Opus loop.
 *
 * They are deliberately source-text assertions (read the prompt + main.mts as
 * strings): the point is to catch "gate and prompt drifted apart", which is a
 * cross-file property no single unit can assert.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRequiredSkillsByType } from "../.sandcastle/lib/skill-discipline.js";

const sandcastleDir = join(process.cwd(), ".sandcastle");
const implementPrompt = readFileSync(
  join(sandcastleDir, "implement-prompt.md"),
  "utf8",
);
const mainSource = readFileSync(join(sandcastleDir, "main.mts"), "utf8");
const sandcastleExample = readFileSync(
  join(sandcastleDir, "SANDCASTLE.md.example"),
  "utf8",
);

describe("gate reason-code ↔ prompt contract", () => {
  it("the per-attempt skill-discipline gate's reason code is named in implement-prompt.md", () => {
    // The implementer gate throws and quarantines with `skill-discipline-fail`.
    // If the orchestrator can throw it, the implementer prompt MUST warn about
    // it — otherwise the model has no way to know the rule exists (the exact
    // failure that quarantined #310 on the v3 hard-gate's first live run).
    expect(mainSource).toContain("skill-discipline-fail");
    expect(implementPrompt).toContain("skill-discipline-fail");
  });

  it("implement-prompt.md tells the implementer the gate is per-attempt", () => {
    // v3.3: the retry leg must also know STEP 0 re-applies each attempt
    // (#316 quarantined on the retry leg because the prompt didn't say this).
    expect(implementPrompt).toMatch(/per-attempt/i);
  });
});

describe("critique-gate placeholder symmetry", () => {
  // Every critique-gate placeholder the prompt reads MUST be set in
  // runImplementer's promptArgs, and vice-versa. lint-placeholders covers the
  // forward direction (placeholder → value) across all prompts; this pins the
  // two critique-specific keys on both sides so the wiring can't half-land.
  const keys = ["REQUIRED_SKILLS", "CRITIQUE_FEEDBACK"] as const;

  for (const key of keys) {
    it(`{{${key}}} is present in implement-prompt.md`, () => {
      expect(implementPrompt).toContain(`{{${key}}}`);
    });

    it(`${key} is set in main.mts promptArgs`, () => {
      // matches `REQUIRED_SKILLS:` / `CRITIQUE_FEEDBACK:` in a promptArgs object
      expect(mainSource).toMatch(new RegExp(`\\b${key}:`));
    });
  }
});

describe("SANDCASTLE.md.example parses to its documented map (can't rot)", () => {
  it("maps type:new-component -> [impeccable, layout] and type:cleanup -> []", () => {
    const map = parseRequiredSkillsByType(sandcastleExample);
    expect([...(map.get("type:new-component") ?? [])]).toEqual([
      "impeccable",
      "layout",
    ]);
    expect([...(map.get("type:cleanup") ?? [])]).toEqual([]);
  });
});

describe("lint-gate ↔ prompt contract", () => {
  const reviewPrompt = readFileSync(
    join(sandcastleDir, "review-prompt.md"),
    "utf8",
  );
  const recoveryPrompt = readFileSync(
    join(sandcastleDir, "recovery-prompt.md"),
    "utf8",
  );

  it("the lint cert token the host greps for is the one implement-prompt.md tells the implementer to write", () => {
    // The shipAfterMigrations backstop greps the shipped commit body for
    // `SANDCASTLE-LINT: pass` (LINT_CERT_TOKEN). If the host token and the
    // implementer prompt ever drift, every lint-enabled run quarantines on a
    // cert the model was never told to emit — the same warn/throw drift class
    // the skill-discipline contract above guards.
    expect(mainSource).toContain("SANDCASTLE-LINT: pass");
    expect(implementPrompt).toContain("SANDCASTLE-LINT: pass");
  });

  it("recovery-prompt.md also emits the lint cert (its commits hit the recovery-reviewer's cert check)", () => {
    // review-prompt.md treats a missing SANDCASTLE-LINT cert as a HARD finding,
    // and it reviews BOTH implementer commits AND recovery commits (the
    // recovery-reviewer pass). If recovery-prompt.md drops the cert
    // instruction, every lint-enabled recovered issue false-quarantines.
    expect(recoveryPrompt).toContain("SANDCASTLE-LINT: pass");
  });

  it("the reviewer enforces lint via a CATEGORY SWEEP line", () => {
    // The host backstop only checks cert PRESENCE; the reviewer verifies the
    // cert is TRUE. If the sweep line is dropped, lint stops being enforced.
    expect(reviewPrompt).toMatch(/Lint \/ code style/);
  });
});
