/**
 * Issue #886 — the implementer's report card reaches the reviewer.
 *
 * WHAT WAS BROKEN. `runImplementer` schema-validated the implementer's
 * certification envelope and then threw the parsed object away. The reviewer
 * was handed seven prompt arguments and the envelope was not one of them —
 * while `review-prompt.md` instructed it to verify "the certification's
 * `e2eAssertionLine` field", a field name that exists ONLY in that envelope.
 * The reviewer was grading a hand-typed commit-body transcription of a report
 * card it could never see, so envelope-vs-commit-body disagreement was
 * undetectable by construction.
 *
 * WHAT THESE TESTS PROVE. The last test is the arrival proof the ticket asks
 * for, and it deliberately does NOT stub the prompt: it reads the real
 * `review-prompt.md` off disk and runs the real `applyPromptArgs` — the exact
 * function `spawnAgent` calls on the exact bytes it reads (mac-host-sandbox.ts
 * :292-293). If the placeholder were misspelled, the block deleted, or the
 * value rendered empty, this fails. What it cannot cover is the model call
 * itself; `pnpm sandcastle:lint` independently proves every placeholder in the
 * file has a matching key in `main.mts`'s promptArgs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { renderImplementerCertification } from "./main.mts";
import { applyPromptArgs } from "./lib/prompt-args.js";
import { IssueTelemetryBag } from "./lib/telemetry/issue-bag.js";

const REVIEW_PROMPT_PATH = path.join(import.meta.dirname, "review-prompt.md");

/** A realistic envelope: a UI story that ran playwright and passed. */
const ENVELOPE = {
  marker: "STORY_COMPLETE",
  storyType: "ui",
  e2eRequired: true,
  e2eActuallyRan: true,
  testCommandUsed: "pnpm exec playwright test e2e/cash-flow.spec.ts",
  e2eAssertionLine: "  ✓ team cash flow shows the team total",
  outputNotFiltered: true,
  testReachedFeature: true,
} as const;

describe("renderImplementerCertification", () => {
  it("renders the envelope verbatim, every field the reviewer is told to check", () => {
    const rendered = renderImplementerCertification(
      ENVELOPE as unknown as Parameters<
        typeof renderImplementerCertification
      >[0],
    );
    // Round-trips: what the reviewer reads IS the object the host validated,
    // not a summary of it. A paraphrase is exactly the failure mode this
    // ticket exists to remove.
    expect(JSON.parse(rendered)).toEqual(ENVELOPE);
    expect(rendered).toContain("e2eAssertionLine");
    expect(rendered).toContain("team cash flow shows the team total");
  });

  it("states absence in words rather than rendering an empty block", () => {
    const rendered = renderImplementerCertification(undefined);
    // The three no-envelope paths (rebuttal / HALT / stuck-abort) and the
    // recovery-reviewer pass all land here. A blank block reads as "nothing to
    // flag"; the reviewer must read it as unverified.
    expect(rendered).toContain("ABSENT EVIDENCE");
    expect(rendered.trim().length).toBeGreaterThan(0);
    expect(rendered).not.toContain("{");
  });
});

describe("IssueTelemetryBag.noteImplementerCertification", () => {
  it("records the seven fields onto the row that reaches issues.jsonl", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerCertification(ENVELOPE);
    expect(bag.toRow().implementerCertification).toEqual({
      storyType: "ui",
      e2eRequired: true,
      e2eActuallyRan: true,
      testCommandUsed: "pnpm exec playwright test e2e/cash-flow.spec.ts",
      e2eAssertionLine: "  ✓ team cash flow shows the team total",
      outputNotFiltered: true,
      testReachedFeature: true,
    });
    // `marker` is not a certification field and must not ride along — the
    // snapshot is schema-validated and an unexpected key is a parse risk.
    expect(bag.toRow().implementerCertification).not.toHaveProperty("marker");
  });

  it("keeps null as the declared no-e2e sentinel, not as a dropped field", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerCertification({
      storyType: "backend-only",
      e2eRequired: false,
      e2eActuallyRan: false,
      testCommandUsed: null,
      e2eAssertionLine: null,
      outputNotFiltered: true,
      testReachedFeature: false,
    });
    const row = bag.toRow().implementerCertification;
    // `null` MEANS "no e2e ran". Dropping it would make a backend-only story
    // indistinguishable from an envelope whose fields failed to record.
    expect(row).toHaveProperty("testCommandUsed", null);
    expect(row).toHaveProperty("e2eAssertionLine", null);
  });

  it("leaves the slot absent for a pass that produced no envelope", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerCertification(undefined);
    expect(bag.toRow().implementerCertification).toBeUndefined();
    // ...and an object carrying none of the seven fields is not a report card.
    bag.noteImplementerCertification({ unrelated: 1 });
    expect(bag.toRow().implementerCertification).toBeUndefined();
  });

  it("never lets a later no-envelope pass erase a recorded one", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerCertification(ENVELOPE);
    // Attempt 2 emits a rebuttal instead of code: no envelope. Absent evidence
    // is not a correction to present evidence.
    bag.noteImplementerCertification(undefined);
    expect(bag.toRow().implementerCertification).toHaveProperty(
      "storyType",
      "ui",
    );
  });

  it("takes the last envelope, because the last attempt is the one that ships", () => {
    const bag = new IssueTelemetryBag();
    bag.noteImplementerCertification(ENVELOPE);
    bag.noteImplementerCertification({ ...ENVELOPE, storyType: "infra" });
    expect(bag.toRow().implementerCertification).toHaveProperty(
      "storyType",
      "infra",
    );
  });

  it("stays total on a hostile object, per this module's no-throw promise", () => {
    const bag = new IssueTelemetryBag();
    const hostile = {
      storyType: "ui",
      get e2eRequired(): boolean {
        throw new Error("boom");
      },
    };
    expect(() => bag.noteImplementerCertification(hostile)).not.toThrow();
    // A record already held survives the failed write rather than being
    // half-overwritten.
    bag.noteImplementerCertification(ENVELOPE);
    bag.noteImplementerCertification(hostile);
    expect(bag.toRow().implementerCertification).toHaveProperty(
      "storyType",
      "ui",
    );
  });

  it("copies out, so a caller mutating its object cannot rewrite telemetry", () => {
    const bag = new IssueTelemetryBag();
    const mutable = { ...ENVELOPE } as Record<string, unknown>;
    bag.noteImplementerCertification(mutable);
    mutable.storyType = "infra";
    mutable.e2eActuallyRan = false;
    expect(bag.toRow().implementerCertification).toHaveProperty(
      "storyType",
      "ui",
    );
    expect(bag.toRow().implementerCertification).toHaveProperty(
      "e2eActuallyRan",
      true,
    );
  });
});

describe("the report card arrives in the reviewer's actual prompt", () => {
  /**
   * Every placeholder the real file declares, filled with a marker value. Read
   * FROM THE FILE rather than hand-listed, so a future placeholder cannot make
   * this test silently stop covering the substitution — `applyPromptArgs`
   * throws on any key it cannot find.
   */
  function argsForRealPrompt(certification: string): Record<string, string> {
    const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");
    const args: Record<string, string> = {};
    for (const m of raw.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
      args[m[1] as string] = `<${m[1]}>`;
    }
    args.IMPLEMENTER_CERTIFICATION = certification;
    return args;
  }

  it("declares the placeholder the driver fills", () => {
    // Guards the half-wiring failure: driver sends the key, prompt never asks
    // for it, so the envelope is assembled and silently dropped.
    const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");
    expect(raw).toContain("{{IMPLEMENTER_CERTIFICATION}}");
    expect(raw).toContain("<implementer-certification>");
  });

  it("substitutes the envelope into the text the reviewer model is handed", () => {
    const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");
    const rendered = applyPromptArgs(
      raw,
      argsForRealPrompt(
        renderImplementerCertification(
          ENVELOPE as unknown as Parameters<
            typeof renderImplementerCertification
          >[0],
        ),
      ),
    );
    // The values the reviewer is instructed to cross-check are present as data.
    expect(rendered).toContain('"e2eAssertionLine"');
    expect(rendered).toContain("team cash flow shows the team total");
    expect(rendered).toContain('"e2eRequired": true');
    expect(rendered).toContain('"testCommandUsed"');
    // Inside the block, not loose in the document.
    const block = rendered.slice(
      rendered.indexOf("<implementer-certification>"),
      rendered.indexOf("</implementer-certification>"),
    );
    expect(block).toContain("team cash flow shows the team total");
    // And nothing anywhere is left un-substituted.
    expect(rendered).not.toMatch(/\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}/);
  });

  it("carries the absence statement through when no envelope was produced", () => {
    const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");
    const rendered = applyPromptArgs(
      raw,
      argsForRealPrompt(renderImplementerCertification(undefined)),
    );
    const block = rendered.slice(
      rendered.indexOf("<implementer-certification>"),
      rendered.indexOf("</implementer-certification>"),
    );
    expect(block).toContain("ABSENT EVIDENCE");
  });
});
