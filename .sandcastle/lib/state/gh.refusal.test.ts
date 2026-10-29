/**
 * `countRefusals` — read every reviewer refusal and the outcome ticked on its
 * body (issue #1096). `runGh` is injected, so these run with no real `gh`.
 */
import { describe, expect, it, vi } from "vitest";

import { countRefusals } from "./gh.js";
import { renderRefusalOutcomeCheckbox } from "./refusal.js";

/** Build a reviewer-refused body with the outcome boxes in a given state. */
function refusalBody(opts: {
  runId: string;
  whenIso: string;
  correct?: boolean;
  wrong?: boolean;
}): string {
  const stamp = renderRefusalOutcomeCheckbox("reviewer refused")
    .replace("- [ ] correct", `- [${opts.correct ? "x" : " "}] correct`)
    .replace("- [ ] wrong", `- [${opts.wrong ? "x" : " "}] wrong`);
  return [
    "## Stopped: the reviewer refused the code",
    "",
    `**Run:** ${opts.runId}`,
    `**When:** ${opts.whenIso}`,
    "",
    stamp,
  ].join("\n");
}

describe("countRefusals — one list call, bodies inline, outcome read off each", () => {
  it("classifies correct / wrong / unjudged and never makes a second per-ticket call", async () => {
    const list = [
      { number: 10, body: refusalBody({ runId: "night-1", whenIso: "2026-08-11T02:00:00.000Z", wrong: true }) },
      { number: 11, body: refusalBody({ runId: "night-1", whenIso: "2026-08-11T02:05:00.000Z", correct: true }) },
      { number: 12, body: refusalBody({ runId: "night-2", whenIso: "2026-08-20T02:00:00.000Z" }) },
    ];
    const runGh = vi.fn(async (_args: string[]) => ({ stdout: JSON.stringify(list), stderr: "" }));

    const { rows } = await countRefusals({ runGh });

    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.issue === 10)?.outcome).toBe("wrong");
    expect(rows.find((r) => r.issue === 11)?.outcome).toBe("correct");
    expect(rows.find((r) => r.issue === 12)?.outcome).toBe("unjudged");
    expect(rows.find((r) => r.issue === 10)?.runId).toBe("night-1");

    // The whole point of reading bodies inline: exactly one call, no `view`.
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(runGh.mock.calls[0]![0]).toContain("number,body");
    expect(runGh.mock.calls.some((c) => c[0][1] === "view")).toBe(false);
  });

  it("includes closed tickets — a refusal shown wrong and then closed is the row that matters most", async () => {
    const runGh = vi.fn(async (args: string[]) => {
      expect(args).toContain("all"); // --state all
      return { stdout: "[]", stderr: "" };
    });
    await countRefusals({ runGh });
    expect(runGh).toHaveBeenCalled();
  });

  it("counts a labelled ticket with no stamp (an older refusal) as unjudged rather than dropping it", async () => {
    const list = [{ number: 7, body: "A pre-#1096 refusal with no outcome checkbox." }];
    const runGh = vi.fn(async () => ({ stdout: JSON.stringify(list), stderr: "" }));
    const { rows } = await countRefusals({ runGh });
    expect(rows).toEqual([{ issue: 7, outcome: "unjudged", runId: undefined, whenIso: undefined }]);
  });

  it("returns no rows for an empty tracker without throwing", async () => {
    const runGh = vi.fn(async () => ({ stdout: "", stderr: "" }));
    expect((await countRefusals({ runGh })).rows).toEqual([]);
  });
});
