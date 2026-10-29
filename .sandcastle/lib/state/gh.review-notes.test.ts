/**
 * The two review-note labels (`shipped-with-structure-finding`,
 * `shipped-with-weak-first-test`): created at run start, added at the ship
 * moment, never status labels.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ensureReviewNoteLabelsExist,
  LABEL_SHIPPED_WITH_STRUCTURE_FINDING,
  LABEL_SHIPPED_WITH_WEAK_FIRST_TEST,
  markShippedWithReviewNote,
  REVIEW_NOTE_LABEL_DEFINITIONS,
  STATUS_LABELS,
} from "./gh.js";

function recordingGh() {
  const calls: string[][] = [];
  const runGh = vi.fn(async (args: string[]) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  });
  return { calls, runGh };
}

describe("review-note labels", () => {
  it("run start creates both labels with --force", async () => {
    const { calls, runGh } = recordingGh();
    await ensureReviewNoteLabelsExist({ runGh });
    expect(calls.map((c) => c.slice(0, 3))).toEqual([
      ["label", "create", LABEL_SHIPPED_WITH_STRUCTURE_FINDING],
      ["label", "create", LABEL_SHIPPED_WITH_WEAK_FIRST_TEST],
    ]);
    for (const c of calls) expect(c).toContain("--force");
  });

  it("a failed create is reported, never thrown, and the other label is still tried", async () => {
    const errors: string[] = [];
    let n = 0;
    const runGh = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("HTTP 500");
      return { stdout: "", stderr: "" };
    });
    await ensureReviewNoteLabelsExist({ runGh, onError: (name) => errors.push(name) });
    expect(errors).toEqual([LABEL_SHIPPED_WITH_STRUCTURE_FINDING]);
    expect(runGh).toHaveBeenCalledTimes(2);
  });

  it("the ship moment adds exactly the one label and writes nothing else", async () => {
    const { calls, runGh } = recordingGh();
    await markShippedWithReviewNote(42, LABEL_SHIPPED_WITH_WEAK_FIRST_TEST, { runGh });
    expect(calls).toEqual([
      ["issue", "edit", "42", "--add-label", LABEL_SHIPPED_WITH_WEAK_FIRST_TEST],
    ]);
  });

  it("neither is a status label, so both survive every later transition", () => {
    const status: readonly string[] = STATUS_LABELS;
    expect(status).not.toContain(LABEL_SHIPPED_WITH_STRUCTURE_FINDING);
    expect(status).not.toContain(LABEL_SHIPPED_WITH_WEAK_FIRST_TEST);
  });

  it("both descriptions fit GitHub's 100-character cap", () => {
    for (const def of REVIEW_NOTE_LABEL_DEFINITIONS) {
      expect(def.description.length).toBeLessThanOrEqual(100);
    }
  });
});
