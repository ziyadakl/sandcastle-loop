/**
 * Slice B: deterministic primitives for detecting a NOT_PLANNED / "superseded
 * by #N" close, so the completion skill can treat such closes as UNPROVEN.
 *
 * Imports the CANONICAL `.sandcastle/lib/state/gh.ts` (what main.mts runs), not
 * the `src/state/gh.ts` twin.
 *
 * `getIssueClosure` is exercised through its injected-runner seam (`deps.runGh`)
 * so the JSON parsing/normalization is tested without a child_process mock.
 */
import { describe, it, expect } from "vitest";

import {
  getIssueClosure,
  parseSupersededBy,
} from "../.sandcastle/lib/state/gh.js";

/** Build a deps object whose runGh returns a fixed stdout payload. */
function stubGh(stdout: string) {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      runGh: async (args: string[]) => {
        calls.push(args);
        return { stdout, stderr: "" };
      },
    },
  };
}

describe("getIssueClosure", () => {
  it("reports a COMPLETED close with lowercase state + empty closeText", async () => {
    const { deps, calls } = stubGh(
      JSON.stringify({
        state: "CLOSED",
        stateReason: "COMPLETED",
        body: "",
        comments: [],
      }),
    );
    const res = await getIssueClosure(42, deps);
    expect(res).toEqual({
      state: "closed",
      stateReason: "COMPLETED",
      closeText: "",
    });
    // Fetches state+reason AND the text a "superseded by #N" note lives in.
    expect(calls[0]).toEqual([
      "issue",
      "view",
      "42",
      "--json",
      "state,stateReason,body,comments",
    ]);
  });

  it("reports a NOT_PLANNED close and surfaces the supersession comment as closeText", async () => {
    const { deps } = stubGh(
      JSON.stringify({
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        body: "Original scope.",
        comments: [{ body: "Superseded by #669" }],
      }),
    );
    const res = await getIssueClosure(7, deps);
    expect(res.state).toBe("closed");
    expect(res.stateReason).toBe("NOT_PLANNED");
    // closeText is the sourced input parseSupersededBy consumes.
    expect(res.closeText).toContain("Superseded by #669");
    expect(parseSupersededBy(res.closeText)).toEqual([669]);
  });

  it("passes a DUPLICATE close through raw (not collapsed to null)", async () => {
    // A "closed as duplicate" is a superseded-style close: callers key UNPROVEN
    // on `stateReason !== "COMPLETED"`, so DUPLICATE must survive normalization.
    const { deps } = stubGh(
      JSON.stringify({
        state: "CLOSED",
        stateReason: "DUPLICATE",
        body: "dupe of #5",
      }),
    );
    const res = await getIssueClosure(8, deps);
    expect(res.state).toBe("closed");
    expect(res.stateReason).toBe("DUPLICATE");
  });

  it("reports an open issue with null stateReason", async () => {
    const { deps } = stubGh(
      JSON.stringify({ state: "OPEN", stateReason: null, body: "wip" }),
    );
    expect(await getIssueClosure(9, deps)).toEqual({
      state: "open",
      stateReason: null,
      closeText: "wip",
    });
  });

  it("normalizes an empty-string stateReason to null", async () => {
    const { deps } = stubGh(
      JSON.stringify({ state: "CLOSED", stateReason: "" }),
    );
    expect(await getIssueClosure(11, deps)).toEqual({
      state: "closed",
      stateReason: null,
      closeText: "",
    });
  });

  it("joins body + every comment body into closeText", async () => {
    const { deps } = stubGh(
      JSON.stringify({
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        body: "line-a",
        comments: [{ body: "line-b" }, { body: "" }, { body: "line-c" }],
      }),
    );
    const res = await getIssueClosure(3, deps);
    expect(res.closeText).toBe("line-a\nline-b\nline-c");
  });

  it("throws a contextual error on malformed gh output", async () => {
    const { deps } = stubGh("not json at all");
    await expect(getIssueClosure(5, deps)).rejects.toThrow(
      /getIssueClosure\(5\): failed to parse gh output as JSON/,
    );
  });

  it("throws on an invalid issueNum", async () => {
    await expect(getIssueClosure(0)).rejects.toThrow(
      /getIssueClosure: invalid issueNum '0'/,
    );
    await expect(getIssueClosure(-3)).rejects.toThrow(
      /getIssueClosure: invalid issueNum '-3'/,
    );
  });
});

describe("parseSupersededBy", () => {
  it("extracts a single superseded-by reference", () => {
    expect(parseSupersededBy("superseded by #669")).toEqual([669]);
  });

  it("extracts multiple references on one supersession line", () => {
    expect(parseSupersededBy("Superseded by #12 and #34")).toEqual([12, 34]);
  });

  it("handles the 'closed as superseded — see #N' phrasing", () => {
    expect(parseSupersededBy("closed as superseded — see #100")).toEqual([100]);
  });

  it("de-duplicates and preserves first-seen order across lines", () => {
    const text = "superseded by #5\nSuperseded by #5 and #8";
    expect(parseSupersededBy(text)).toEqual([5, 8]);
  });

  it("returns [] when there is no supersession language", () => {
    expect(parseSupersededBy("Fixed in a follow-up, see #42")).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(parseSupersededBy("")).toEqual([]);
  });
});
