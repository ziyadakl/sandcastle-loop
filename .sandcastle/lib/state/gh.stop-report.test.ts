/**
 * Issue #914 (Piece H) — the GH-facing half of the five stop reasons:
 * label create-on-demand, and the issue-BODY update (never a comment).
 *
 * `runGh` is injected (mirrors `GetIssueClosureDeps` in `gh.ts`) so these run
 * with no real `gh` process and no network — the args passed to each fake
 * call are the unit under test.
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyStopLabelOnly,
  applyStopReport,
  ensureStopLabelsExist,
} from "./gh.js";
import { STOP_LABEL_DEFINITIONS } from "./stop-reasons.js";

describe("ensureStopLabelsExist — create-on-demand, idempotent", () => {
  it("calls `gh label create --force` once per label, for every one of them", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await ensureStopLabelsExist({ runGh });
    expect(calls).toHaveLength(STOP_LABEL_DEFINITIONS.length);
    for (const call of calls) {
      expect(call[0]).toBe("label");
      expect(call[1]).toBe("create");
      expect(call).toContain("--force");
    }
    const names = calls.map((c) => c[2]);
    expect(new Set(names)).toEqual(
      new Set(STOP_LABEL_DEFINITIONS.map((d) => d.name)),
    );
  });

  it("one label's failure does not stop the rest — reported via onError", async () => {
    let n = 0;
    const runGh = vi.fn(async (args: string[]) => {
      n += 1;
      if (n === 2) throw new Error("HTTP 422");
      return { stdout: "", stderr: "" };
    });
    const failed: string[] = [];
    await ensureStopLabelsExist({ runGh, onError: (name) => failed.push(name) });
    // Every label is still attempted, however many there are.
    expect(runGh).toHaveBeenCalledTimes(STOP_LABEL_DEFINITIONS.length);
    expect(failed).toHaveLength(1);
  });
});

describe("applyStopReport — updates the issue BODY, never posts a comment", () => {
  it("fetches the body, upserts the section, writes it back with --body (not --comment)", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: "Original ticket description.\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await applyStopReport(
      42,
      { label: "stopped:already-built", section: "## Stopped: already built\n\nfound in packages/api" },
      { runGh },
    );

    const editCall = calls.find((c) => c[0] === "issue" && c[1] === "edit");
    expect(editCall).toBeDefined();
    expect(editCall).toContain("--body");
    expect(editCall).not.toContain("--comment");
    const bodyIdx = editCall!.indexOf("--body") + 1;
    expect(editCall![bodyIdx]).toContain("Original ticket description.");
    expect(editCall![bodyIdx]).toContain("found in packages/api");

    // No `gh issue comment` call anywhere.
    expect(calls.some((c) => c[0] === "issue" && c[1] === "comment")).toBe(false);
  });

  it("an old-style stopped:check-disagreement adds verdict:needed but never needs-owner-decision (spec #1334)", async () => {
    // #1130 finding 2: a STOPPED disagreement owes a ruling just as a WATCHED
    // one does, but only the watch path applied `verdict:needed`, so a hand
    // query `gh issue list --label verdict:needed` silently missed every
    // stopped case. The stop path now applies it too — when the body carries no
    // verdict yet.
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyStopReport(
      1,
      { label: "stopped:check-disagreement", section: "x" },
      { runGh },
    );
    const editCall = runGh.mock.calls.map((c) => c[0] as string[]).find((a) => a[1] === "edit")!;
    expect(editCall.filter((a) => a === "--add-label")).toHaveLength(2);
    expect(editCall).toContain("stopped:check-disagreement");
    expect(editCall).not.toContain("needs-owner-decision");
    expect(editCall).toContain("verdict:needed");
  });

  it("does NOT re-add verdict:needed when the body already carries a verdict (a verdict written first by hand)", async () => {
    // If the judge ruled and wrote a verdict (which also removes verdict:needed)
    // before the stop is reported, re-adding the label would falsely mark a
    // settled ticket as owing a ruling. applyStopReport reads the body it
    // already fetched and skips the label when a verdict is present.
    const bodyWithVerdict = [
      "Ticket text.",
      "<!-- sandcastle:verdict:start -->",
      "**Verdict:** `checks-wrong`",
      "<!-- sandcastle:verdict:end -->",
    ].join("\n");
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return { stdout: bodyWithVerdict, stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyStopReport(
      1,
      { label: "stopped:check-disagreement", section: "x" },
      { runGh },
    );
    const editCall = runGh.mock.calls.map((c) => c[0] as string[]).find((a) => a[1] === "edit")!;
    expect(editCall).not.toContain("verdict:needed");
  });

  it("stopped:checks-tampered (also loud) does NOT add needs-owner-decision — loudness is not the rule", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyStopReport(1, { label: "stopped:checks-tampered", section: "x" }, { runGh });
    const editCall = runGh.mock.calls.map((c) => c[0] as string[]).find((a) => a[1] === "edit")!;
    expect(editCall.filter((a) => a === "--add-label")).toHaveLength(1);
    expect(editCall).not.toContain("needs-owner-decision");
  });

  // Issue #1118. A ticket that never said what was wanted is a question no
  // agent can answer — the judge's only authority IS the issue body, and the
  // issue body is what came up short. That is exactly what
  // `needs-owner-decision` means ("Business question only the owner can
  // answer; non-technical. Never dispatchable.").
  it("stopped:ticket-unclear ALSO adds needs-owner-decision, though it is a QUIET stop", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyStopReport(1, { label: "stopped:ticket-unclear", section: "x" }, { runGh });
    const editCall = runGh.mock.calls.map((c) => c[0] as string[]).find((a) => a[1] === "edit")!;
    expect(editCall.filter((a) => a === "--add-label")).toHaveLength(2);
    expect(editCall).toContain("stopped:ticket-unclear");
    expect(editCall).toContain("needs-owner-decision");
  });

  // The other half of the same decision: a weak check is a technical failure
  // with a technical fix, and must not reach the one person who has said he
  // will not review code.
  it("stopped:weak-check does NOT add needs-owner-decision", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyStopReport(1, { label: "stopped:weak-check", section: "x" }, { runGh });
    const editCall = runGh.mock.calls.map((c) => c[0] as string[]).find((a) => a[1] === "edit")!;
    expect(editCall.filter((a) => a === "--add-label")).toHaveLength(1);
    expect(editCall).not.toContain("needs-owner-decision");
  });

  it("a second stop on the same issue UPDATES the body section rather than duplicating it", async () => {
    let storedBody = "Human-written ticket text.";
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "issue" && args[1] === "view") {
        return { stdout: `${storedBody}\n`, stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "edit") {
        const bodyIdx = args.indexOf("--body") + 1;
        storedBody = args[bodyIdx]!;
      }
      return { stdout: "", stderr: "" };
    });

    await applyStopReport(
      7,
      { label: "stopped:no-failing-check", section: "first stop content" },
      { runGh },
    );
    await applyStopReport(
      7,
      { label: "stopped:check-disagreement", section: "second stop content" },
      { runGh },
    );

    expect(storedBody).toContain("Human-written ticket text.");
    expect(storedBody).toContain("second stop content");
    expect(storedBody).not.toContain("first stop content");
    const sectionCount =
      storedBody.split("<!-- sandcastle:stop-report:start -->").length - 1;
    expect(sectionCount).toBe(1);
  });

  it("rejects an invalid issue number without calling gh at all", async () => {
    const runGh = vi.fn();
    await expect(
      applyStopReport(0, { label: "stopped:already-built", section: "x" }, { runGh }),
    ).rejects.toThrow(/invalid issueNum/);
    expect(runGh).not.toHaveBeenCalled();
  });
});

/**
 * Issue #923 — the label-only path, for the three stop sites whose full
 * explanation is already a GitHub COMMENT and must stay one (owner
 * decision, 2026-08-16). They were missing only a label, because a comment
 * cannot be counted.
 */
describe("applyStopLabelOnly — the label, and nothing else", () => {
  it("adds the label with ONE `gh issue edit` call and never reads or writes the body", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await applyStopLabelOnly(
      412,
      { label: "stopped:skills-skipped" },
      { runGh },
    );
    expect(calls).toEqual([
      ["issue", "edit", "412", "--add-label", "stopped:skills-skipped"],
    ]);
    // The two things that would mean it touched the body at all.
    const flat = calls.flat();
    expect(flat).not.toContain("--body");
    expect(flat).not.toContain("view");
  });

  it("never posts a comment — the comment these sites already wrote must not be duplicated", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await applyStopLabelOnly(7, { label: "stopped:run-fault" }, { runGh });
    expect(calls.flat()).not.toContain("comment");
  });

  it("refuses a nonsense issue number rather than editing something else", async () => {
    const runGh = vi.fn(async () => ({ stdout: "", stderr: "" }));
    for (const bad of [0, -3, 1.5]) {
      await expect(
        applyStopLabelOnly(bad, { label: "stopped:run-fault" }, { runGh }),
      ).rejects.toThrow(/invalid issueNum/);
    }
    expect(runGh).not.toHaveBeenCalled();
  });

  it("lets a gh failure propagate — the caller in main.mts owns the best-effort swallow, so a silent failure here would be invisible twice", async () => {
    const runGh = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    await expect(
      applyStopLabelOnly(9, { label: "stopped:skills-skipped" }, { runGh }),
    ).rejects.toThrow("HTTP 503");
  });
});
