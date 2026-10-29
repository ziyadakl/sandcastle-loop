/**
 * Issue #1179 — `upsertRunPrReport`'s GH-facing half: find the run's open
 * PR, replace ONLY its run-report marker section, write the whole body back.
 *
 * `runGh` is injected (mirrors every other stop/report test in this file's
 * siblings — see `gh.stop-report.test.ts`) so these run with no real `gh`
 * process and no network.
 */
import { describe, expect, it, vi } from "vitest";

import { upsertRunPrReport } from "./gh.js";
import { runReportSectionEnd, runReportSectionStart } from "./run-report.js";

describe("upsertRunPrReport", () => {
  it("finds the open PR for the branch, upserts the HOST-SCOPED marker section, and edits with --body", async () => {
    const calls: string[][] = [];
    const runGh = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([{ number: 7, body: "Original PR description." }]),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await upsertRunPrReport(
      "sandcastle/run-1",
      "## Nothing needs you.",
      "host-a",
      { runGh },
    );

    expect(result.updated).toBe(true);
    const editCall = calls.find((c) => c[0] === "pr" && c[1] === "edit");
    expect(editCall).toBeDefined();
    expect(editCall).toContain("7");
    expect(editCall).toContain("--body");
    const bodyIdx = editCall!.indexOf("--body") + 1;
    expect(editCall![bodyIdx]).toContain("Original PR description.");
    expect(editCall![bodyIdx]).toContain(runReportSectionStart("host-a"));
    expect(editCall![bodyIdx]).toContain("Report from host-a");
    expect(editCall![bodyIdx]).toContain("## Nothing needs you.");
    expect(editCall![bodyIdx]).toContain(runReportSectionEnd("host-a"));
  });

  it("REPLACES the marker section on a second call from the SAME host, rather than appending a duplicate", async () => {
    let currentBody = "Original PR description.";
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return {
          stdout: JSON.stringify([{ number: 7, body: currentBody }]),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "edit") {
        const bodyIdx = args.indexOf("--body") + 1;
        currentBody = args[bodyIdx]!;
      }
      return { stdout: "", stderr: "" };
    });

    await upsertRunPrReport(
      "sandcastle/run-1",
      "## Nothing needs you.\n\nfirst render",
      "host-a",
      { runGh },
    );
    await upsertRunPrReport("sandcastle/run-1", "## Needs you:\n\n- #9 fix it", "host-a", {
      runGh,
    });

    // Exactly one occurrence of each marker — a second write from the SAME
    // host REPLACED the block rather than appending a second one.
    expect(currentBody.split(runReportSectionStart("host-a")).length - 1).toBe(1);
    expect(currentBody.split(runReportSectionEnd("host-a")).length - 1).toBe(1);
    // The stale first render is gone; the fresh one is present.
    expect(currentBody).not.toContain("first render");
    expect(currentBody).toContain("#9 fix it");
    // Everything outside the marker survives byte-for-byte.
    expect(currentBody).toContain("Original PR description.");
  });

  it("issue #1179 review, blocker 4: two DIFFERENT hosts' sections coexist — one upsert never clobbers the other's report", async () => {
    let currentBody = "Original PR description.";
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: JSON.stringify([{ number: 7, body: currentBody }]), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "edit") {
        const bodyIdx = args.indexOf("--body") + 1;
        currentBody = args[bodyIdx]!;
      }
      return { stdout: "", stderr: "" };
    });

    await upsertRunPrReport("sandcastle/run-1", "## Needs you:\n\n- #42 host A's warning", "host-a", {
      runGh,
    });
    await upsertRunPrReport("sandcastle/run-1", "## Nothing needs you.", "host-b", { runGh });

    // Host B finishing clean must NOT erase host A's "Needs you" — the exact
    // multi-host clobber the shared-marker design produced.
    expect(currentBody).toContain("#42 host A's warning");
    expect(currentBody).toContain("Report from host-a");
    expect(currentBody).toContain("Report from host-b");
    // Each host owns exactly one occurrence of its own marker pair.
    expect(currentBody.split(runReportSectionStart("host-a")).length - 1).toBe(1);
    expect(currentBody.split(runReportSectionStart("host-b")).length - 1).toBe(1);

    // A SECOND upsert from host A only replaces host A's own section.
    await upsertRunPrReport("sandcastle/run-1", "## Nothing needs you.", "host-a", { runGh });
    expect(currentBody).not.toContain("#42 host A's warning");
    expect(currentBody).toContain("Report from host-b");
    expect(currentBody.split(runReportSectionStart("host-b")).length - 1).toBe(1);
  });

  it("reports updated: false with an error when no open PR exists for the branch — never throws", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await upsertRunPrReport("sandcastle/no-pr", "report text", "host-a", { runGh });

    expect(result.updated).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("never throws when gh itself fails", async () => {
    const runGh = vi.fn(async () => {
      throw new Error("gh: authentication failed");
    });

    const result = await upsertRunPrReport("sandcastle/run-1", "report text", "host-a", { runGh });

    expect(result.updated).toBe(false);
    expect(result.error).toContain("authentication failed");
  });
});
