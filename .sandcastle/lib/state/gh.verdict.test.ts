/**
 * Issue #1117 — the GitHub-facing half of the verdict slot: create the
 * labels, write a verdict onto a ticket, read one back, refuse to trample a
 * human's correction, and count them.
 *
 * `runGh` is injected (same shape as `gh.stop-report.test.ts`) so these run
 * with no real `gh` process and no network.
 */
import { describe, expect, it, vi } from "vitest";

import {
  applyScreenCheckWatchReport,
  applyVerdictReport,
  countVerdicts,
  ensureVerdictLabelsExist,
  readVerdict,
} from "./gh.js";
import {
  VERDICT_LABEL_DEFINITIONS,
  VERDICT_NEEDED_LABEL,
  buildVerdictSection,
  parseVerdictSection,
  upsertVerdictSection,
  verdictLabelFor,
  type VerdictRecord,
} from "./verdict.js";

const rec = (over: Partial<VerdictRecord> = {}): VerdictRecord => ({
  verdict: "checks-wrong",
  decidedBy: "judge",
  whenIso: "2026-08-19T09:00:00.000Z",
  runId: "run-1",
  why: "The ticket asked for the team total; the check asserted one agent's figure.",
  ...over,
});

const bodyWith = (r: VerdictRecord): string =>
  upsertVerdictSection("Ticket description.", buildVerdictSection(r));

describe("ensureVerdictLabelsExist", () => {
  it("creates one label per verdict, idempotently", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await ensureVerdictLabelsExist({ runGh });
    // The four outcomes, plus `verdict:needed` — "somebody should rule this".
    expect(calls).toHaveLength(VERDICT_LABEL_DEFINITIONS.length + 1);
    for (const c of calls) {
      expect(c.slice(0, 2)).toEqual(["label", "create"]);
      expect(c).toContain("--force");
    }
  });

  it("one label's failure does not stop the rest", async () => {
    let n = 0;
    const runGh = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error("HTTP 422");
      return { stdout: "", stderr: "" };
    });
    const failed: string[] = [];
    await ensureVerdictLabelsExist({ runGh, onError: (name) => failed.push(name) });
    expect(runGh).toHaveBeenCalledTimes(VERDICT_LABEL_DEFINITIONS.length + 1);
    expect(failed).toHaveLength(1);
  });
});

describe("applyVerdictReport — the body is the record, the label is the index", () => {
  it("writes the verdict into the BODY and never posts a comment", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const outcome = await applyVerdictReport(7, { record: rec() }, { runGh });
    expect(outcome).toBe("written");
    const edit = calls.find((c) => c[1] === "edit");
    expect(edit).toBeDefined();
    expect(edit).not.toContain("--comment");
    const body = edit?.[edit.indexOf("--body") + 1] ?? "";
    expect(body).toContain("Ticket description.");
    expect(body).toContain("`checks-wrong`");
  });

  it("adds the matching label and removes the other three, so a count is never double", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyVerdictReport(7, { record: rec({ verdict: "builder-wrong" }) }, { runGh });
    const edit = calls.find((c) => c.includes("--add-label")) ?? [];
    const added = edit.filter((a, i) => edit[i - 1] === "--add-label");
    const removed = edit.filter((a, i) => edit[i - 1] === "--remove-label");
    expect(added).toEqual([verdictLabelFor("builder-wrong")]);
    expect(new Set(removed)).toEqual(
      new Set([
        ...["checks-wrong", "neither-side", "ticket-silent"].map((v) =>
          verdictLabelFor(v as never),
        ),
        VERDICT_NEEDED_LABEL,
      ]),
    );
  });

  it("refuses to overwrite a verdict a person set by hand, and writes nothing", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") {
        return { stdout: bodyWith(rec({ verdict: "builder-wrong", decidedBy: "human" })), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const outcome = await applyVerdictReport(7, { record: rec() }, { runGh });
    expect(outcome).toBe("kept-human");
    expect(calls.some((c) => c[1] === "edit")).toBe(false);
  });

  it("replaces its own earlier verdict on a second run", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: bodyWith(rec()), stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const outcome = await applyVerdictReport(
      7,
      { record: rec({ verdict: "ticket-silent" }) },
      { runGh },
    );
    expect(outcome).toBe("written");
    const edit = calls.find((c) => c[1] === "edit") ?? [];
    const body = edit[edit.indexOf("--body") + 1] ?? "";
    expect(body).toContain("`ticket-silent`");
    expect(body.match(/## Verdict/g)).toHaveLength(1);
  });

  // Issue #1133, item 5. A ticket can be judged twice in one night — the
  // reviewer refuses on pass 1, the retry comes back clear, then the screen
  // check mismatches — and both rounds were paid for. The second ruling wins,
  // and the first is kept on the ticket rather than deleted.
  it("keeps the judge's earlier ruling on the ticket when it rules again", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") {
        return {
          stdout: bodyWith(rec({ verdict: "checks-wrong", source: "reviewer-red-check" })),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });
    await applyVerdictReport(
      7,
      { record: rec({ verdict: "builder-wrong", source: "screen-check" }) },
      { runGh },
    );
    const edit = calls.find((c) => c[1] === "edit") ?? [];
    const body = edit[edit.indexOf("--body") + 1] ?? "";
    const back = parseVerdictSection(body);
    expect(back?.verdict).toBe("builder-wrong");
    expect(back?.superseded?.map((h) => h.verdict)).toEqual(["checks-wrong"]);
    // Still ONE block, so the tally still counts this ticket once.
    expect(body.match(/## Verdict/g)).toHaveLength(1);
  });

  it("rejects a nonsense issue number before touching the network", async () => {
    const runGh = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(applyVerdictReport(0, { record: rec() }, { runGh })).rejects.toThrow();
    expect(runGh).not.toHaveBeenCalled();
  });
});

describe("readVerdict", () => {
  it("reads back what was written", async () => {
    const runGh = vi.fn(async () => ({ stdout: bodyWith(rec()), stderr: "" }));
    expect((await readVerdict(7, { runGh }))?.verdict).toBe("checks-wrong");
  });

  it("returns nothing for a ticket that has no verdict", async () => {
    const runGh = vi.fn(async () => ({ stdout: "Just a description.", stderr: "" }));
    expect(await readVerdict(7, { runGh })).toBeUndefined();
  });
});

describe("countVerdicts — the number this whole ticket exists to produce", () => {
  it("counts every verdict-carrying ticket, and names the ones still unruled", async () => {
    // Bodies ride back on the SAME list call now (#1130 finding 1), so there
    // is no second per-ticket pass.
    const list = [
      { number: 11, body: bodyWith(rec({ verdict: "checks-wrong" })) },
      { number: 12, body: bodyWith(rec({ verdict: "checks-wrong" })) },
      { number: 13, body: bodyWith(rec({ verdict: "builder-wrong" })) },
      { number: 14, body: "A disagreement nobody has ruled on." },
    ];
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") {
        expect(args).toContain("number,body");
        return { stdout: JSON.stringify(list), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const tally = await countVerdicts({ runGh });
    expect(tally.counts["checks-wrong"]).toBe(2);
    expect(tally.counts["builder-wrong"]).toBe(1);
    expect(tally.counts.unrecorded).toBe(1);
    expect(tally.unruledIssues).toEqual([14]);
    // The whole win: bodies came inline, so no `gh issue view` was spawned.
    expect(runGh.mock.calls.some((c) => c[0][1] === "view")).toBe(false);
  });

  it("splits by the source in the BODY — two tickets wear one label and mean two things", async () => {
    // Both tickets carry `verdict:checks-wrong`, so a count by label says two
    // wrong checks. Only #32 had a check. #33 is the reviewer refusing over
    // poor code, where no check ever ran, and the label cannot tell them
    // apart — only the `source` line in the body can.
    const list = [
      { number: 32, body: bodyWith(rec({ verdict: "checks-wrong", source: "screen-check" })) },
      { number: 33, body: bodyWith(rec({ verdict: "checks-wrong", source: "reviewer-no-check" })) },
    ];
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return { stdout: JSON.stringify(list), stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const tally = await countVerdicts({ runGh });
    expect(tally.counts["checks-wrong"]).toBe(2);
    expect(tally.counts.byGrounds["with-check"]["checks-wrong"]).toBe(1);
    expect(tally.counts.byGrounds["no-check"]["checks-wrong"]).toBe(1);
  });

  it("counts the same issue once when two label queries both return it, using the inline body", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      // Every label query returns #21 with its body; the second is deduped.
      if (args[1] === "list") {
        return { stdout: JSON.stringify([{ number: 21, body: bodyWith(rec()) }]), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const tally = await countVerdicts({ runGh });
    expect(tally.counts["checks-wrong"]).toBe(1);
    expect(tally.issuesRead).toEqual([21]);
    // No second pass at all — the whole point of finding 1.
    expect(runGh.mock.calls.some((c) => c[0][1] === "view")).toBe(false);
  });
});

describe("countVerdicts — reaching a disagreement older than the labels", () => {
  it("reads a ticket named by number even though no label query returns it", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return { stdout: "[]", stderr: "" };
      return { stdout: bodyWith(rec({ verdict: "checks-wrong" })), stderr: "" };
    });
    const tally = await countVerdicts({ runGh, extraIssues: [805, 820] });
    expect(tally.issuesRead).toEqual([805, 820]);
    expect(tally.counts["checks-wrong"]).toBe(2);
  });

  it("ignores a nonsense number rather than asking GitHub about it", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return { stdout: "[]", stderr: "" };
      return { stdout: "no verdict", stderr: "" };
    });
    const tally = await countVerdicts({ runGh, extraIssues: [0, -3, 805] });
    expect(tally.issuesRead).toEqual([805]);
  });
});

describe("the faults the 2026-08-19 review found", () => {
  it("writes the BODY before the labels, so a label problem cannot lose a verdict", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.", stderr: "" };
      // Every label edit fails, exactly as it did when the four verdict
      // labels did not yet exist in the repository.
      if (args.includes("--add-label")) throw new Error("could not add label");
      return { stdout: "", stderr: "" };
    });
    const labelErrors: unknown[] = [];
    const outcome = await applyVerdictReport(
      7,
      { record: rec() },
      { runGh, onLabelError: (e) => labelErrors.push(e) },
    );
    expect(outcome).toBe("written");
    expect(labelErrors).toHaveLength(1);
    const bodyEdit = calls.find((c) => c.includes("--body"));
    expect(bodyEdit).toBeDefined();
    expect(bodyEdit).not.toContain("--add-label");
    expect(bodyEdit?.[bodyEdit.indexOf("--body") + 1]).toContain("`checks-wrong`");
  });

  it("takes the 'needs a ruling' label off once a verdict is written", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyVerdictReport(7, { record: rec() }, { runGh });
    const labelEdit = calls.find((c) => c.includes("--add-label")) ?? [];
    const removed = labelEdit.filter((a, i) => labelEdit[i - 1] === "--remove-label");
    expect(removed).toContain(VERDICT_NEEDED_LABEL);
  });

  it("creates the 'needs a ruling' label alongside the four", async () => {
    const names: string[] = [];
    const runGh = vi.fn(async (args: string[]) => {
      names.push(args[2] ?? "");
      return { stdout: "", stderr: "" };
    });
    await ensureVerdictLabelsExist({ runGh });
    expect(names).toContain(VERDICT_NEEDED_LABEL);
    expect(names).toHaveLength(VERDICT_LABEL_DEFINITIONS.length + 1);
  });

  it("a watched disagreement takes the 'needs a ruling' label, and no stop label", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyScreenCheckWatchReport(
      7,
      { section: "## Screen check (watch-only)", verdictNeeded: true },
      { runGh },
    );
    const edit = calls.find((c) => c[1] === "edit") ?? [];
    expect(edit).toContain(VERDICT_NEEDED_LABEL);
    expect(edit.some((a) => a.startsWith("stopped:"))).toBe(false);
  });

  it("a watched run the check AGREED with takes no label at all (issue #916)", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyScreenCheckWatchReport(7, { section: "## watch" }, { runGh });
    const edit = calls.find((c) => c[1] === "edit") ?? [];
    expect(edit).not.toContain("--add-label");
  });

  it("finds a watched disagreement, which wears no stop label and would otherwise be invisible", async () => {
    const queried: string[] = [];
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") {
        queried.push(args[args.indexOf("--label") + 1] ?? "");
        return { stdout: "[]", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await countVerdicts({ runGh });
    expect(queried).toContain(VERDICT_NEEDED_LABEL);
  });
});
