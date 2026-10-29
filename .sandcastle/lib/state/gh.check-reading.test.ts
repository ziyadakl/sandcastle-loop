/**
 * Issue #1118 — the GitHub-facing half of the check reading: create the
 * labels, write a reading onto a ticket, and count them so "eight bad checks"
 * arrives with the total it needs to mean anything.
 *
 * Its own file rather than an addition to `gh.verdict.test.ts`, matching how
 * this directory already splits: one `gh.<feature>.test.ts` per GitHub-facing
 * feature (`gh.stop-report.test.ts`, `gh.verdict.test.ts`), with the pure half
 * beside its module (`check-reading.test.ts`).
 *
 * `runGh` is injected, so these run with no real `gh` process and no network.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CHECK_READING_LABEL_DEFINITIONS,
  CHECK_READING_STOP_LABELS,
  buildCheckReadingSection,
  checkReadingLabelFor,
  upsertCheckReadingSection,
  type CheckReadingRecord,
} from "./check-reading.js";
import {
  applyCheckReadingReport,
  countCheckReadings,
  ensureCheckReadingLabelsExist,
  readCheckReading,
} from "./gh.js";

const rec = (over: Partial<CheckReadingRecord> = {}): CheckReadingRecord => ({
  reading: "sound",
  whenIso: "2026-08-20T09:00:00.000Z",
  runId: "run-1",
  why: "The check asserts the team total, which is what the ticket asked for.",
  ...over,
});

const bodyWith = (r: CheckReadingRecord): string =>
  upsertCheckReadingSection("Ticket description.", buildCheckReadingSection(r));

describe("ensureCheckReadingLabelsExist", () => {
  it("creates one label per reading, idempotently", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    });
    await ensureCheckReadingLabelsExist({ runGh });
    expect(calls).toHaveLength(CHECK_READING_LABEL_DEFINITIONS.length);
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
    await ensureCheckReadingLabelsExist({
      runGh,
      onError: (name) => failed.push(name),
    });
    expect(runGh).toHaveBeenCalledTimes(CHECK_READING_LABEL_DEFINITIONS.length);
    expect(failed).toHaveLength(1);
  });
});

describe("applyCheckReadingReport", () => {
  it("writes the reading into the BODY and never posts a comment", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyCheckReadingReport(7, { record: rec() }, { runGh });
    const edit = calls.find((c) => c.includes("--body"));
    expect(edit).toBeDefined();
    expect(edit).not.toContain("--comment");
    const body = edit?.[edit.indexOf("--body") + 1] ?? "";
    expect(body).toContain("Ticket description.");
    expect(body).toContain("`sound`");
  });

  it("records the healthy majority too — a sound reading is written, not skipped", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyCheckReadingReport(7, { record: rec({ reading: "sound" }) }, { runGh });
    expect(calls.some((c) => c.includes("--body"))).toBe(true);
    const labelEdit = calls.find((c) => c.includes("--add-label")) ?? [];
    expect(labelEdit).toContain(checkReadingLabelFor("sound"));
  });

  it("adds the matching label and removes the other two, so a count is never double", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyCheckReadingReport(7, { record: rec({ reading: "too-weak", criterion: "c" }) }, { runGh });
    const edit = calls.find((c) => c.includes("--add-label")) ?? [];
    const added = edit.filter((_a, i) => edit[i - 1] === "--add-label");
    const removed = edit.filter((_a, i) => edit[i - 1] === "--remove-label");
    expect(added).toEqual([checkReadingLabelFor("too-weak")]);
    expect(new Set(removed)).toEqual(
      new Set([checkReadingLabelFor("sound"), checkReadingLabelFor("ticket-unclear")]),
    );
  });

  it("writes the BODY before the labels, so a label problem cannot lose the record", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: "Ticket description.", stderr: "" };
      if (args.includes("--add-label")) throw new Error("could not add label");
      return { stdout: "", stderr: "" };
    });
    const labelErrors: unknown[] = [];
    await applyCheckReadingReport(
      7,
      { record: rec() },
      { runGh, onLabelError: (e) => labelErrors.push(e) },
    );
    expect(labelErrors).toHaveLength(1);
    const bodyEdit = calls.find((c) => c.includes("--body"));
    expect(bodyEdit).toBeDefined();
    expect(bodyEdit).not.toContain("--add-label");
    expect(bodyEdit?.[bodyEdit.indexOf("--body") + 1]).toContain("`sound`");
  });

  it("replaces last night's reading rather than stacking a second block", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return { stdout: bodyWith(rec()), stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await applyCheckReadingReport(
      7,
      { record: rec({ reading: "ticket-unclear" }) },
      { runGh },
    );
    const edit = calls.find((c) => c.includes("--body")) ?? [];
    const body = edit[edit.indexOf("--body") + 1] ?? "";
    expect(body).toContain("`ticket-unclear`");
    expect(body.match(/sandcastle:check-reading:start/g)).toHaveLength(1);
  });

  it("overwrites a hand edit too — this is a record of the run, not a ruling", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[1] === "view") {
        return { stdout: bodyWith(rec({ reading: "too-weak", criterion: "c" })), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await applyCheckReadingReport(7, { record: rec({ reading: "sound" }) }, { runGh });
    const edit = calls.find((c) => c.includes("--body")) ?? [];
    expect(edit[edit.indexOf("--body") + 1]).toContain("`sound`");
  });

  it("rejects a nonsense issue number before touching the network", async () => {
    const runGh = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(
      applyCheckReadingReport(0, { record: rec() }, { runGh }),
    ).rejects.toThrow();
    expect(runGh).not.toHaveBeenCalled();
  });
});

describe("countCheckReadings — the deliverable: how many of the checks read were sound", () => {
  it("tallies each reading and reports the total the tally is out of", async () => {
    const bodies: Record<string, string> = {
      "11": bodyWith(rec({ reading: "sound" })),
      "12": bodyWith(rec({ reading: "sound" })),
      "13": bodyWith(rec({ reading: "too-weak", criterion: "c" })),
      "14": bodyWith(rec({ reading: "ticket-unclear" })),
    };
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") {
        return {
          stdout: JSON.stringify([11, 12, 13, 14].map((number) => ({ number }))),
          stderr: "",
        };
      }
      return { stdout: bodies[args[2] ?? ""] ?? "", stderr: "" };
    });
    const out = await countCheckReadings({ runGh });
    expect(out.counts.sound).toBe(2);
    expect(out.counts["too-weak"]).toBe(1);
    expect(out.counts["ticket-unclear"]).toBe(1);
    expect(out.counts.total).toBe(4);
    expect(out.issuesRead).toEqual([11, 12, 13, 14]);
  });

  it("queries by label, one query per reading", async () => {
    const queried: string[] = [];
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") {
        queried.push(args[args.indexOf("--label") + 1] ?? "");
        return { stdout: "[]", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    await countCheckReadings({ runGh });
    expect(new Set(queried)).toEqual(
      new Set([
        ...CHECK_READING_LABEL_DEFINITIONS.map((d) => d.name),
        ...CHECK_READING_STOP_LABELS,
      ]),
    );
  });

  // Issue #1133, item 2. The tickets whose `check-read:*` label is most likely
  // to be missing are exactly the ones the judge stopped, and those wear a
  // judge stop label of their own. `countVerdicts` already solves this by also
  // querying `stopped:check-disagreement`; this is the same move.
  it("also asks the two judge stop labels, so a stopped ticket is not lost", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") {
        const label = args[args.indexOf("--label") + 1] ?? "";
        return {
          stdout: label === "stopped:weak-check" ? JSON.stringify([{ number: 41 }]) : "[]",
          stderr: "",
        };
      }
      return { stdout: bodyWith(rec({ reading: "too-weak", criterion: "c" })), stderr: "" };
    });
    const out = await countCheckReadings({ runGh });
    expect(out.issuesRead).toEqual([41]);
    expect(out.counts["too-weak"]).toBe(1);
  });

  // Issue #1133, items 2 and 4. "Labelled as read but carrying no reading" is
  // an accusation — the index and the record disagree. It is only true of a
  // ticket that really does wear a `check-read:*` label. A ticket reached by a
  // stop label, or named by number, was never claimed to have been read.
  it("accuses only tickets that actually wear a check-read label", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") {
        const label = args[args.indexOf("--label") + 1] ?? "";
        return {
          stdout: label === "check-read:sound" ? JSON.stringify([{ number: 51 }]) : "[]",
          stderr: "",
        };
      }
      return { stdout: "A ticket with no check-reading block at all.", stderr: "" };
    });
    const out = await countCheckReadings({ runGh, extraIssues: [805, 820] });
    expect(out.issuesRead).toEqual([51, 805, 820]);
    expect(out.unreadIssues).toEqual([51]);
  });

  it("does not accuse a ticket found only by its judge stop label", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") {
        const label = args[args.indexOf("--label") + 1] ?? "";
        return {
          stdout: label === "stopped:ticket-unclear" ? JSON.stringify([{ number: 61 }]) : "[]",
          stderr: "",
        };
      }
      return { stdout: "Stopped before the reading was ever written.", stderr: "" };
    });
    const out = await countCheckReadings({ runGh });
    expect(out.counts.unrecorded).toBe(1);
    expect(out.unreadIssues).toEqual([]);
  });

  it("reads the BODY, not the label — a label without a block counts as unrecorded", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return { stdout: JSON.stringify([{ number: 31 }]), stderr: "" };
      return { stdout: "A ticket wearing the label with no block in its body.", stderr: "" };
    });
    const out = await countCheckReadings({ runGh });
    expect(out.counts.sound).toBe(0);
    expect(out.counts.unrecorded).toBe(1);
    expect(out.counts.total).toBe(0);
    expect(out.unreadIssues).toEqual([31]);
  });

  it("asks the same issue only once when two label queries both return it", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return { stdout: JSON.stringify([{ number: 21 }]), stderr: "" };
      return { stdout: bodyWith(rec()), stderr: "" };
    });
    const out = await countCheckReadings({ runGh });
    expect(out.counts.sound).toBe(1);
    const views = runGh.mock.calls.filter((c) => c[0][1] === "view");
    expect(views).toHaveLength(1);
  });

  it("includes closed tickets — a check read on a shipped ticket still counts", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return { stdout: "[]", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    await countCheckReadings({ runGh });
    for (const c of runGh.mock.calls) {
      if (c[0][1] !== "list") continue;
      expect(c[0]).toContain("--state");
      expect(c[0][c[0].indexOf("--state") + 1]).toBe("all");
    }
  });

  it("reads extra tickets named by number even when no label query returns them", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[1] === "list") return { stdout: "[]", stderr: "" };
      return { stdout: bodyWith(rec()), stderr: "" };
    });
    const out = await countCheckReadings({ runGh, extraIssues: [0, -3, 805] });
    expect(out.issuesRead).toEqual([805]);
    expect(out.counts.total).toBe(1);
  });
});

describe("readCheckReading — what a resumed ticket asks before re-reading its check", () => {
  it("returns the reading already recorded on the ticket, fingerprint and all", async () => {
    const runGh = vi.fn(async () => ({
      stdout: bodyWith(rec({ checkFingerprint: "abc123abc123abc1" })),
      stderr: "",
    }));
    const back = await readCheckReading(7, { runGh });
    expect(back?.reading).toBe("sound");
    expect(back?.checkFingerprint).toBe("abc123abc123abc1");
  });

  it("returns nothing for a ticket that carries no reading", async () => {
    const runGh = vi.fn(async () => ({ stdout: "Just a description.", stderr: "" }));
    expect(await readCheckReading(7, { runGh })).toBeUndefined();
  });

  it("refuses an invalid issue number rather than fetching a ticket that cannot exist", async () => {
    const runGh = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(readCheckReading(0, { runGh })).rejects.toThrow("invalid issueNum");
    expect(runGh).not.toHaveBeenCalled();
  });
});
