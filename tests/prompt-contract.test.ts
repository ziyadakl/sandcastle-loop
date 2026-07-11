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

  it("the test cert token the host greps for is the one implement-prompt.md tells the implementer to write", () => {
    // Sibling of the lint-cert drift guard: the shipAfterMigrations backstop
    // greps the shipped commit body for `SANDCASTLE-TEST: pass` (TEST_CERT_TOKEN).
    // If the host token and the implementer prompt drift, every test-enabled run
    // quarantines on a cert the model was never told to emit.
    expect(mainSource).toContain("SANDCASTLE-TEST: pass");
    expect(implementPrompt).toContain("SANDCASTLE-TEST: pass");
  });

  it("recovery-prompt.md also emits the test cert (its commits hit the same host cert gate)", () => {
    // The test-cert gate greps recovery commits exactly as it does implementer
    // commits. If recovery-prompt.md drops the cert instruction, every
    // test-enabled recovered issue false-quarantines.
    expect(recoveryPrompt).toContain("SANDCASTLE-TEST: pass");
  });

  it("the reviewer enforces tests via a CATEGORY SWEEP line and must actually run them", () => {
    // The host backstop only checks cert PRESENCE; the reviewer verifies the
    // cert is TRUE by re-running the suite. Dropping either the sweep line or the
    // run-it instruction is what let a red test ship through review (#125).
    expect(reviewPrompt).toMatch(/Test suite/);
    expect(reviewPrompt).toMatch(/RUN the project's test script/i);
  });
});

describe("reviewer reviews the cumulative branch diff (issue #340)", () => {
  const reviewPrompt = readFileSync(
    join(sandcastleDir, "review-prompt.md"),
    "utf8",
  );

  it("the review diff is computed against {{REVIEW_BASE}}, not the tip's parent", () => {
    // #340: an implementer split work across a WIP + final commit; the reviewer
    // saw only `git diff COMMIT_SHA~1 COMMIT_SHA` (the final slice) and
    // false-quarantined complete, passing work. The fix widens the diff to the
    // whole branch via a host-computed merge-base passed as {{REVIEW_BASE}}.
    expect(reviewPrompt).toContain("{{REVIEW_BASE}}");
    // The tip-only delta must be gone from the diff commands.
    expect(reviewPrompt).not.toMatch(/COMMIT_SHA\}\}~1/);
  });

  it("REVIEW_BASE is host-computed via merge-base and wired into runReviewer promptArgs", () => {
    // lint-placeholders already gates placeholder→promptArg presence; this
    // pins the *source* of the value so the cumulative-diff wiring can't be
    // silently reverted to a single-commit base.
    expect(mainSource).toMatch(/\bREVIEW_BASE:/);
    expect(mainSource).toContain('"merge-base"');
  });

  it("the cumulative branch patch is bounded so a large branch can't crash the prompt", () => {
    // Widening from one commit to the whole branch removes the natural size
    // bound; an unbounded patch re-opens the "Prompt is too long" crash the
    // e2e log cap was added to prevent. The patch body is capped (the --stat
    // file inventory stays complete).
    expect(reviewPrompt).toMatch(/branch patch truncated/);
  });
});

describe("non-behavioral UI carve-out ↔ prompt contract (issue #342)", () => {
  const reviewPrompt = readFileSync(
    join(sandcastleDir, "review-prompt.md"),
    "utf8",
  );

  it("review-prompt.md defines the carve-out, scoped to no-playwright specs", () => {
    // #342: clean test-only code that only added `export` keywords to a .tsx
    // was hard-blocked because COMMIT_TOUCHED_UI=yes forced the e2e cert. The
    // carve-out waives it for non-behavioral touches, but ONLY when the spec
    // has no playwright command — that scope is the wall against abuse.
    expect(reviewPrompt).toMatch(/non-behavioral UI carve-out/i);
    expect(reviewPrompt).toMatch(/NEVER\s+applies\s+when\s+SPEC_REQUIRES_PLAYWRIGHT=yes/i);
  });

  it("the carve-out lists the behavioral exclusions (so it can't be read as a blanket waiver)", () => {
    expect(reviewPrompt).toMatch(/rendered\s+JSX/i);
    expect(reviewPrompt).toMatch(/props, hooks, state, or styling/i);
  });

  it("the downgrade requires the exact auditable n/a sweep line", () => {
    expect(reviewPrompt).toMatch(/Execution evidence: n\/a \([^)]*export-only/);
  });

  it("the sweep line parses as n/a (not a finding) via extractCategorySweep", async () => {
    // The carve-out is useless if its own justification line blocks. Confirm
    // the `n/a (...)` form classifies as n/a, not finding.
    const { extractCategorySweep } = await import("../.sandcastle/main.mjs");
    const sweep = extractCategorySweep(
      [
        "CATEGORY SWEEP:",
        "- Execution evidence: n/a (UI-file touch is export-only/non-behavioral, no playwright in spec)",
        "- Spec fit: ok",
        "- Test coverage: ok",
        "- Type safety: ok",
        "- Security: ok",
        "- Error handling: ok",
        "- Edge cases: ok",
        "- Skill discipline: n/a (no SANDCASTLE.md)",
        "- Migration schema qualification: n/a (no sql)",
        "- Lint / code style: n/a (no lint script)",
        "SWEEP COMPLETE.",
      ].join("\n"),
    );
    expect(sweep).not.toBeNull();
    expect(sweep!.get("execution evidence")).toBe("n/a");
  });

  it("the non-behavioral definition is symmetric between review-prompt and implement-prompt (can't drift)", () => {
    expect(reviewPrompt).toMatch(/non-behavioral/i);
    expect(implementPrompt).toMatch(/non-behavioral/i);
    // both sides name the export-keyword case as the canonical example
    expect(reviewPrompt).toMatch(/`export` keywords/);
    expect(implementPrompt).toMatch(/`export` keywords/);
  });
});

describe("credential carve-out ↔ prompt contract (audit Issue 1)", () => {
  const reviewPrompt = readFileSync(
    join(sandcastleDir, "review-prompt.md"),
    "utf8",
  );

  it("review-prompt.md carves out the documented test-credential pattern so the reviewer can't false-quarantine it", () => {
    // affinity-tracker #454: the implementer prompt tells the builder
    // "Credentials are not blockers" and to reuse the project's ADMIN_PASSWORD
    // test pattern, while the reviewer flagged that exact line as a credential
    // leak — an unsatisfiable contradiction no retry can fix. The carve-out
    // makes the documented test-credential pattern explicitly NOT a leak.
    expect(reviewPrompt).toMatch(/credential carve-out/i);
    expect(reviewPrompt).toMatch(/ADMIN_PASSWORD/);
  });

  it("the credential carve-out is scoped, not a blanket waiver (real secrets still block)", () => {
    // The carve-out is useless if it can be read as "never flag credentials".
    // It must name what still blocks: production/live secrets.
    expect(reviewPrompt).toMatch(/production|live (secret|value|key)/i);
  });

  it("the credential rule is symmetric between implement-prompt and review-prompt (can't drift)", () => {
    // The audit's core ask: a credential rule must never be added to one side
    // without the other (the implementer-says-use-it / reviewer-flags-it split
    // is what caused the deadlock). Both prompts must reference the rule.
    expect(implementPrompt).toMatch(/Credentials are not blockers/i);
    expect(reviewPrompt).toMatch(
      /Credentials are not blockers|documented test-credential/i,
    );
  });
});

describe("critique objective/subjective rule ↔ prompt contract (audit Issue 2)", () => {
  const critiquePrompt = readFileSync(
    join(sandcastleDir, "critique-prompt.md"),
    "utf8",
  );

  it("restricts blocking severity to OBJECTIVE defects and demotes SUBJECTIVE polish", () => {
    // affinity-tracker #454/#470 parked shippable work over subjective copy-tone
    // findings ("reads procedural"). The rule restricts blocking severity to
    // objective, verifiable defects and demotes taste/phrasing preferences.
    expect(critiquePrompt).toMatch(/objective/i);
    expect(critiquePrompt).toMatch(/subjective/i);
    expect(critiquePrompt).toMatch(/does NOT block|non-gating/i);
  });

  it("subjective findings are demoted to a non-gating NOTE that keeps CRITIQUE_CLEAN", () => {
    // The whole point: a subjective finding must NOT flip the verdict. The rule
    // ties subjective polish to a NOTE that preserves the CLEAN marker.
    expect(critiquePrompt).toMatch(/note/i);
    expect(critiquePrompt).toMatch(/CRITIQUE_CLEAN/);
  });
});

describe("post-merge no-defer rule ↔ no-verdict retry contract (ADR 0015)", () => {
  const postMergePrompt = readFileSync(
    join(sandcastleDir, "post-merge-review-prompt.md"),
    "utf8",
  );
  const mainSource = readFileSync(join(sandcastleDir, "main.mts"), "utf8");

  it("post-merge-review-prompt.md forbids the reviewer from deferring its single-turn verdict", () => {
    // affinity-tracker #475: the reviewer ended its one turn without a marker
    // ("standing by for the suite result before issuing the verdict") and a
    // clean integration was quarantined. The prompt must forbid deferral and
    // tell the reviewer it gets exactly one turn — this is the load-bearing
    // half of the fix (the retry below is only the backstop).
    expect(postMergePrompt).toMatch(/do not defer/i);
    expect(postMergePrompt).toMatch(/one turn/i);
  });

  it("the no-defer rule sits outside the test-runner variant region so it survives assembly", () => {
    // The rule is useless if a profile's variant override strips it on
    // assembly. It must live after the test-runner variant's close marker,
    // i.e. outside any <!-- variant:... --> region.
    const ruleIdx = postMergePrompt.search(/do not defer/i);
    const variantClose = postMergePrompt.indexOf(
      "<!-- /variant:test-runner-post-merge-review -->",
    );
    expect(variantClose).toBeGreaterThanOrEqual(0);
    expect(ruleIdx).toBeGreaterThan(variantClose);
  });

  it("runPostMergeReviewer survives a no-verdict turn by retrying on MarkerNotFoundError", () => {
    // The code half: a no-verdict turn surfaces as MarkerNotFoundError, which
    // is NOT stall-shaped, so it must be matched explicitly (canonically, via
    // instanceof — not a brittle name string) and share the single-shot retry.
    expect(mainSource).toMatch(/err instanceof MarkerNotFoundError/);
  });
});
