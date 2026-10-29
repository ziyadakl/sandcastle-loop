/**
 * Issue #1038 (2026-09-04) — `runImplementer` batches its dispatch through
 * `runBuilderIterations` (`lib/builder-progress.ts`) instead of one
 * `maxIterations: 100` `sb.run` call.
 *
 * Modelled on `main.reviewer-reask.test.mts`: calls the exported
 * `runImplementer` directly against a stub sandbox and a minimal ctx, rather
 * than driving the whole `runMain` pipeline.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BuilderNoProgressError } from "./lib/builder-progress.js";
import {
  isOutputCapError,
  isTransientServerError,
} from "./lib/error-classification.js";
import { runImplementer } from "./main.mts";

const PROSE =
  "This session is you and me talking. Which do you want — option A or option B?";

/** The implementer's fenced-JSON certification envelope, same shape used
 * throughout `main.test.mts`'s implementer stubs. */
const ENVELOPE = {
  marker: "STORY_COMPLETE",
  storyType: "backend-only",
  e2eRequired: false,
  e2eActuallyRan: false,
  testCommandUsed: null,
  e2eAssertionLine: null,
  outputNotFiltered: true,
  testReachedFeature: false,
};
const ENVELOPE_STDOUT = [
  "work done",
  "```json",
  JSON.stringify(ENVELOPE),
  "```",
  "STORY_COMPLETE",
].join("\n");

interface StubReply {
  readonly stdout: string;
  readonly commits?: readonly { sha: string }[];
}

interface CapturedSpec {
  readonly name: string;
  readonly maxIterations?: number;
  readonly ceilingMs?: number;
}

/** Replays `replies` in call order, recording every dispatched spec. */
function stubSandbox(
  replies: readonly StubReply[],
  opts: { worktreePath?: string } = {},
) {
  const specs: CapturedSpec[] = [];
  const sb = {
    worktreePath: opts.worktreePath,
    run: async (spec: CapturedSpec) => {
      specs.push(spec);
      const reply = replies[specs.length - 1] ?? replies.at(-1);
      return {
        stdout: reply?.stdout ?? "",
        commits: reply?.commits ?? [],
        iterations: [],
      };
    },
  };
  return { sb, specs };
}

function stubCtx(overrides: {
  captureSha?: (worktreePath: string) => Promise<string>;
} = {}) {
  return {
    args: { implementerModel: "stub", hardCeilingSec: 3600 },
    ticketOrdinal: 1,
    issueNumber: 1038,
    issue: {
      title: "Retire the hand-coded New Deal panel",
      branch: "run",
    },
    deps: {
      log: () => {},
      logError: () => {},
      captureSha: overrides.captureSha ?? (async (): Promise<string> => "same"),
    },
  };
}

type RunImplementerCtx = Parameters<typeof runImplementer>[1];

describe("runImplementer batches through runBuilderIterations (issue #1038)", () => {
  it("(1) three prose replies with no commits reject BuilderNoProgressError after exactly BUILDER_IDLE_ITERATION_LIMIT calls, each a single-iteration pass", async () => {
    const { sb, specs } = stubSandbox([
      { stdout: PROSE },
      { stdout: PROSE },
      { stdout: PROSE },
    ]);
    await expect(
      runImplementer(sb as never, stubCtx() as unknown as RunImplementerCtx),
    ).rejects.toThrow(BuilderNoProgressError);
    expect(specs.length).toBe(3); // BUILDER_IDLE_ITERATION_LIMIT
    for (const spec of specs) {
      expect(spec.name).toBe("implementer");
      expect(spec.maxIterations).toBe(1);
      expect(typeof spec.ceilingMs).toBe("number");
    }
  });

  it("(2) a commit-no-marker pass resets the streak — prose, commit, prose, prose, prose takes 5 calls and the error carries exactly 1 commit", async () => {
    const { sb, specs } = stubSandbox([
      { stdout: PROSE },
      {
        stdout: "Committed a partial fix.\nStill investigating further.",
        commits: [{ sha: "c1" }],
      },
      { stdout: PROSE },
      { stdout: PROSE },
      { stdout: PROSE },
    ]);
    let thrown: unknown;
    try {
      await runImplementer(sb as never, stubCtx() as unknown as RunImplementerCtx);
    } catch (err) {
      thrown = err;
    }
    expect(specs.length).toBe(5);
    expect(thrown).toBeInstanceOf(BuilderNoProgressError);
    expect((thrown as BuilderNoProgressError).commits.length).toBe(1);
  });

  it("(3) prose then a certified STORY_COMPLETE with a commit resolves after exactly 2 calls", async () => {
    const { sb, specs } = stubSandbox([
      { stdout: PROSE },
      { stdout: ENVELOPE_STDOUT, commits: [{ sha: "c1" }] },
    ]);
    const result = await runImplementer(
      sb as never,
      stubCtx() as unknown as RunImplementerCtx,
    );
    expect(specs.length).toBe(2);
    expect(result.certification?.marker).toBe("STORY_COMPLETE");
  });

  it("(4) HEAD movement across the first two passes forestalls the stop; it fires only after 3 further idle passes with an unchanged HEAD", async () => {
    const shas = ["s0", "s1", "s2"];
    let call = 0;
    const captureSha = async (): Promise<string> =>
      shas[Math.min(call++, shas.length - 1)]!;
    const { sb, specs } = stubSandbox(
      [
        { stdout: PROSE },
        { stdout: PROSE },
        { stdout: PROSE },
        { stdout: PROSE },
        { stdout: PROSE },
      ],
      { worktreePath: "/wt" },
    );
    let thrown: unknown;
    try {
      await runImplementer(
        sb as never,
        stubCtx({ captureSha }) as unknown as RunImplementerCtx,
      );
    } catch (err) {
      thrown = err;
    }
    // Passes 1-2 move HEAD (s0->s1->s2), resetting the no-progress streak each
    // time; HEAD then stays at "s2" for passes 3-5, so the stop fires only on
    // pass 5 — 3 idle passes AFTER the two moving ones, never earlier.
    expect(specs.length).toBe(5);
    expect(thrown).toBeInstanceOf(BuilderNoProgressError);
  });

  it("(5) the no-progress error trips neither isOutputCapError nor isTransientServerError, nor any of the pipeline's other stall/rate-limit phrases", async () => {
    const { sb } = stubSandbox([{ stdout: PROSE }, { stdout: PROSE }, { stdout: PROSE }]);
    let thrown: unknown;
    try {
      await runImplementer(sb as never, stubCtx() as unknown as RunImplementerCtx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(isOutputCapError(message)).toBe(false);
    expect(isTransientServerError(message)).toBe(false);
    // Deliberately BROADER than the real patterns in
    // lib/error-classification.ts — bare `idle` rather than `agent idle for`,
    // bare `max_tokens` with no negative lookahead. That width is the point:
    // it catches a no-progress message that merely LOOKS stall-ish. Do NOT
    // "tidy" this into STALL_RE / isRateLimitError imports; that narrows the
    // net and quietly weakens the test.
    expect(message).not.toMatch(
      /rate[- ]?limit|\b429\b|rate_limit_error|\bquota\b|usage limit|hard ceiling|idle|AgentIdleTimeoutError|no output received|ETIMEDOUT|max_tokens|maximum output tokens?|output too long/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Rot-guards — main.mts read as TEXT, so a refactor that silently drops the
// wiring (rather than merely renaming a local variable) is still caught, the
// same class of guard `main.scaled-timeout-wiring.test.mts` uses.
// ---------------------------------------------------------------------------

describe("rot-guards: the #1038 batch wiring is actually in main.mts", () => {
  const SRC = readFileSync(path.join(import.meta.dirname, "main.mts"), "utf8");
  const SQUASHED = SRC.replace(/\s+/g, " ");

  function countIn(src: string, needle: string): number {
    return src.split(needle).length - 1;
  }
  function count(needle: string): number {
    return countIn(SRC, needle);
  }
  function countSquashed(needle: string): number {
    return countIn(SQUASHED, needle.replace(/\s+/g, " "));
  }

  it("the old single-call maxIterations of 100 is gone", () => {
    expect(count("maxIterations: 100")).toBe(0);
  });

  it("runBuilderIterations is wired exactly once", () => {
    expect(count("runBuilderIterations(")).toBe(1);
  });

  it("the batched sb.run call passes maxIterations: 1 and ceilingMs (insensitive to reformatting)", () => {
    expect(countSquashed("maxIterations: 1, ceilingMs,")).toBe(1);
  });

  it("the docker provider's completionSignal is built from SANDBOX_COMPLETION_SIGNALS, not a hand-written literal array", () => {
    expect(SRC).toContain("completionSignal: [...SANDBOX_COMPLETION_SIGNALS]");
    expect(SRC).not.toMatch(/completionSignal:\s*\[\s*"<promise>/);
  });

  it("withCeiling's third argument takes the min of the run's whole ceiling and any per-call cap", () => {
    expect(SRC).toContain(
      "capMs === undefined ? ceilingMs : Math.min(ceilingMs, capMs)",
    );
  });

  it("the sandbox run wrapper forwards opts.ceilingMs to withCeiling", () => {
    const anchor = SRC.indexOf('`sandbox run "${opts.name}"`');
    expect(anchor).toBeGreaterThan(-1);
    const window = SRC.slice(anchor, anchor + 300);
    expect(window).toContain("opts.ceilingMs");
  });

  it("the sandbox run wrapper forwards stuckAborted from the underlying handle (issue #1207 item 1)", () => {
    // The wrapper rebuilds a fresh object from `r`, so any field it does not
    // copy is silently dropped before the readers in `runImplementer` and
    // `runBuilderIterations` ever see it. This pins the forward that was
    // missing: without it, a deliberate stuck-detector abort was mistaken for
    // an ordinary run on the real docker path, and both `stuckAborted`
    // carve-outs were dead.
    //
    // `stuckAborted: r.stuckAborted` is unique to THIS wrapper — the sibling
    // top-level run wrapper spreads `result.`, not `r.` — so an exact-once
    // count plus an after-the-anchor position pins it without a brittle
    // fixed-width window.
    const anchor = SRC.indexOf('`sandbox run "${opts.name}"`');
    expect(anchor).toBeGreaterThan(-1);
    expect(count("stuckAborted: r.stuckAborted")).toBe(1);
    expect(SRC.indexOf("stuckAborted: r.stuckAborted")).toBeGreaterThan(anchor);
  });

  it("no typed catch arm reads BuilderNoProgressError — it must stay a plain run fault that takes the recovery road", () => {
    expect(count("instanceof BuilderNoProgressError")).toBe(0);
  });
});
