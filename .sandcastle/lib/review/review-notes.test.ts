/**
 * The approving reviewer's two report-only rows (spec #1334 follow-on):
 * `Structure (quality rubric)` and `First-test strength`. Each can only ever
 * ADD a label to a shipped ticket — a missing or unreadable row is no note,
 * never an error.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractCategorySweep } from "../../main.mts";
import { readReviewNotes } from "./review-notes.js";

function review(rows: readonly string[]): string {
  return [
    "I read the diff.",
    "",
    "CATEGORY SWEEP:",
    "- Spec fit: OK",
    ...rows,
    "SWEEP COMPLETE.",
    "",
    "ALL_CLEAR",
  ].join("\n");
}

describe("readReviewNotes", () => {
  it("a Structure FINDING is a structure note carrying the reviewer's one line", () => {
    expect(
      readReviewNotes(
        review([
          "- Structure (quality rubric): FINDING: totals.ts grows a special case for one Team",
          "- First-test strength: STRONG",
        ]),
      ),
    ).toEqual({ structureFinding: "totals.ts grows a special case for one Team" });
  });

  it("a WEAK first test is a weak-first-test note carrying the reviewer's why", () => {
    expect(
      readReviewNotes(
        review([
          "- Structure (quality rubric): OK",
          "- First-test strength: WEAK: asserts the screen renders, not the $1,000 total",
        ]),
      ),
    ).toEqual({ weakFirstTest: "asserts the screen renders, not the $1,000 total" });
  });

  it("OK and STRONG are no notes", () => {
    expect(
      readReviewNotes(
        review([
          "- Structure (quality rubric): OK",
          "- First-test strength: STRONG",
        ]),
      ),
    ).toEqual({});
  });

  it("N/A on both rows is no notes", () => {
    expect(
      readReviewNotes(
        review([
          "- Structure (quality rubric): N/A (docs-only diff)",
          "- First-test strength: N/A (no first test on this ticket)",
        ]),
      ),
    ).toEqual({});
  });

  it("missing rows, no sweep at all, or an unreadable answer are no notes", () => {
    expect(readReviewNotes(review([]))).toEqual({});
    expect(readReviewNotes("looks good\nALL_CLEAR")).toEqual({});
    expect(
      readReviewNotes(
        review([
          "- Structure (quality rubric): ✅",
          "- First-test strength: **",
        ]),
      ),
    ).toEqual({});
  });

  it("tolerates markdown emphasis and a bare WEAK with no reason", () => {
    expect(
      readReviewNotes(
        review([
          "- **Structure (quality rubric)**: **FINDING**: a comment says the total is cached; it is not",
          "- **First-test strength**: **WEAK**",
        ]),
      ),
    ).toEqual({
      structureFinding: "a comment says the total is cached; it is not",
      weakFirstTest: "no reason given",
    });
  });

  it("accepts the reason in brackets as well as after a colon", () => {
    expect(
      readReviewNotes(
        review([
          "- Structure (quality rubric): FINDING (helper duplicates formatMoney)",
          "- First-test strength: WEAK (only checks the page loads)",
        ]),
      ),
    ).toEqual({
      structureFinding: "helper duplicates formatMoney",
      weakFirstTest: "only checks the page loads",
    });
  });

  it("leaves the unfilled template line alone", () => {
    expect(
      readReviewNotes(
        review([
          "- Structure (quality rubric): <OK | N/A (<reason>) | FINDING: <one-line finding>>",
          "- First-test strength: <STRONG | WEAK: <one-line why> | N/A (<reason>)>",
        ]),
      ),
    ).toEqual({});
  });
});

describe("the two report-only rows never count as sweep findings", () => {
  it("extractCategorySweep leaves both rows out, so they cannot buy or deny a review round", () => {
    const sweep = extractCategorySweep(
      review([
        "- Structure (quality rubric): FINDING: a 1,200-line file",
        "- First-test strength: WEAK: asserts presence only",
      ]),
    );
    expect(sweep).not.toBeNull();
    expect([...sweep!.keys()]).toEqual(["spec fit"]);
  });
});

describe("review-prompt.md asks for both rows and says they never block", () => {
  const prompt = readFileSync(
    fileURLToPath(new URL("../../review-prompt.md", import.meta.url)),
    "utf8",
  );
  const sweepBlock = prompt.slice(
    prompt.indexOf("```\nCATEGORY SWEEP:"),
    prompt.indexOf("SWEEP COMPLETE.\n```"),
  );

  it("the required checklist carries both rows, in the sweep's bullet format", () => {
    expect(sweepBlock).toContain(
      "- Structure (quality rubric): <OK | N/A (<reason>) | FINDING: <one-line finding>>",
    );
    expect(sweepBlock).toContain(
      "- First-test strength: <STRONG | WEAK: <one-line why> | N/A (<reason>)>",
    );
  });

  it("tells the reviewer plainly the rows never change the verdict", () => {
    expect(prompt).toContain(
      "**These two rows NEVER change the verdict marker. Report, don't block.**",
    );
  });

  it("no longer tells the reviewer to skip structure findings, and names comment accuracy", () => {
    expect(prompt).not.toContain("Skip cosmetic / SOFT findings entirely");
    expect(prompt).toContain("Do NOT block on cosmetic / SOFT findings");
    expect(prompt).toContain("**Comment accuracy**");
  });
});
