/**
 * Briefing-builder unit tests.
 *
 * Covers Wave 2 / N2: the seven-question certification block used to embed a
 * literal `{N}` placeholder that never got interpolated (it was concatenated
 * AFTER the `substitute()` pass). The fix takes the iteration number as an
 * arg and uses a template literal — these tests verify the placeholder leak
 * is gone AND the iteration-specific log path renders correctly.
 */
import { describe, it, expect } from "vitest";

import { buildImplementerBriefing } from "../loop/briefing.js";
import type { IssueRef } from "../loop/briefing.js";

const stubIssue: IssueRef = {
  number: 42,
  title: "Test issue",
  body: "# Acceptance\n\nNo playwright command here.",
  labels: ["ready-for-agent"],
};

describe("buildImplementerBriefing — Wave 2 / N2 ({N} placeholder)", () => {
  it("interpolates iterationNum into the e2e log path AND drops the literal {N}", () => {
    const briefing = buildImplementerBriefing({
      story: { id: "S-001", title: "test", status: "in_progress", ghIssue: 42 },
      ghIssue: 42,
      iterationNum: 42,
      iterationTotal: 100,
      issue: stubIssue,
      // Inject an empty implementer template so this test doesn't need
      // refs/prompt.md.local-fork — the seven-question block is appended
      // outside the template, so this still exercises the bug.
      implementerTemplate: "(template body — iteration {N})",
    });

    // The interpolated path must be present.
    expect(briefing).toContain("/tmp/ralph-e2e-it42.log");

    // The literal placeholder must NOT appear anywhere in the output. We
    // check for `it{N}` specifically — that's the exact substring the
    // pre-fix code emitted in the seven-question block.
    expect(briefing).not.toContain("it{N}");
    // Defense in depth: the substitute() pass should also replace `{N}` in
    // the template body, so the bare placeholder shouldn't appear at all.
    expect(briefing).not.toContain("{N}");
  });

  it("renders different iteration numbers correctly across calls", () => {
    const args = {
      story: { id: "S-001", title: "test", status: "in_progress" as const, ghIssue: 42 },
      ghIssue: 42,
      iterationTotal: 100,
      issue: stubIssue,
      implementerTemplate: "(empty)",
    };
    const it7 = buildImplementerBriefing({ ...args, iterationNum: 7 });
    const it999 = buildImplementerBriefing({ ...args, iterationNum: 999 });

    expect(it7).toContain("/tmp/ralph-e2e-it7.log");
    expect(it7).not.toContain("/tmp/ralph-e2e-it999.log");
    expect(it999).toContain("/tmp/ralph-e2e-it999.log");
    expect(it999).not.toContain("/tmp/ralph-e2e-it7.log");
  });
});
