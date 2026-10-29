/**
 * Issue #1038 (2026-09-04) — the builder no-progress guard.
 *
 * Tables for the pure predicates/decision (`implementerIterationComplete`,
 * `iterationMadeProgress`, `builderProgressDecision`) plus scripted-`runOnce`
 * scenarios for the orchestration helper `runBuilderIterations`.
 */
import { describe, expect, it } from "vitest";

import {
  BuilderNoProgressError,
  builderProgressDecision,
  type BuilderRunResult,
  implementerIterationComplete,
  iterationMadeProgress,
  runBuilderIterations,
} from "./builder-progress.js";

describe("implementerIterationComplete", () => {
  it("a completion promise anywhere in the text is complete", () => {
    expect(
      implementerIterationComplete("wrapping up now\n<promise>COMPLETE</promise>"),
    ).toBe(true);
  });

  it("a bare last-line STORY_COMPLETE is complete", () => {
    expect(implementerIterationComplete("work done\nSTORY_COMPLETE")).toBe(true);
  });

  it("a HALT promise is complete (HALT is itself a verdict)", () => {
    expect(
      implementerIterationComplete("blocked, need input\n<promise>HALT</promise>"),
    ).toBe(true);
  });

  it("prose asking a human, with no marker, is not complete", () => {
    expect(
      implementerIterationComplete(
        "This session is you and me talking. Which do you want — option A or option B?",
      ),
    ).toBe(false);
  });

  it("a mention of the marker that was withheld, not emitted, is not complete", () => {
    expect(
      implementerIterationComplete(
        "I nearly emitted STORY_COMPLETE but the tests still fail.\nWithheld.",
      ),
    ).toBe(false);
  });

  it("empty stdout is not complete", () => {
    expect(implementerIterationComplete("")).toBe(false);
  });
});

describe("iterationMadeProgress", () => {
  it("any commit counts as progress, regardless of HEAD", () => {
    expect(iterationMadeProgress({ commitsThisRun: 1 })).toBe(true);
    expect(
      iterationMadeProgress({
        commitsThisRun: 2,
        headBefore: "a",
        headAfter: "a",
      }),
    ).toBe(true);
  });

  it("zero commits with both heads unknown is not progress", () => {
    expect(iterationMadeProgress({ commitsThisRun: 0 })).toBe(false);
  });

  it("zero commits with HEAD movement is progress", () => {
    expect(
      iterationMadeProgress({ commitsThisRun: 0, headBefore: "a", headAfter: "b" }),
    ).toBe(true);
  });

  it("zero commits with an unchanged HEAD is not progress", () => {
    expect(
      iterationMadeProgress({ commitsThisRun: 0, headBefore: "a", headAfter: "a" }),
    ).toBe(false);
  });

  it("zero commits with only one HEAD known is not progress (can't prove movement)", () => {
    expect(
      iterationMadeProgress({ commitsThisRun: 0, headBefore: "a" }),
    ).toBe(false);
  });
});

describe("builderProgressDecision", () => {
  it("a complete pass wins regardless of commits, streak reset to 0", () => {
    expect(
      builderProgressDecision({
        iteration: 1,
        maxIterations: 100,
        idleLimit: 3,
        consecutiveIdle: 2,
        outcome: { complete: true, commitsThisRun: 0 },
      }),
    ).toEqual({ kind: "done", reason: "complete", idleStreak: 0 });
  });

  it("a no-progress pass extends the streak by one and continues under the limit", () => {
    expect(
      builderProgressDecision({
        iteration: 1,
        maxIterations: 100,
        idleLimit: 3,
        consecutiveIdle: 0,
        outcome: { complete: false, commitsThisRun: 0 },
      }),
    ).toEqual({ kind: "continue", idleStreak: 1 });
  });

  it("streak 2 plus another idle pass reaches the limit and stops", () => {
    expect(
      builderProgressDecision({
        iteration: 3,
        maxIterations: 100,
        idleLimit: 3,
        consecutiveIdle: 2,
        outcome: { complete: false, commitsThisRun: 0 },
      }),
    ).toEqual({ kind: "stop", reason: "no-progress", idleStreak: 3 });
  });

  it("streak 2 plus a commit resets the streak and continues", () => {
    expect(
      builderProgressDecision({
        iteration: 3,
        maxIterations: 100,
        idleLimit: 3,
        consecutiveIdle: 2,
        outcome: { complete: false, commitsThisRun: 1 },
      }),
    ).toEqual({ kind: "continue", idleStreak: 0 });
  });

  it("reaching max-iterations on a fresh idle streak ends the batch normally", () => {
    expect(
      builderProgressDecision({
        iteration: 100,
        maxIterations: 100,
        idleLimit: 3,
        consecutiveIdle: 0,
        outcome: { complete: false, commitsThisRun: 0 },
      }),
    ).toEqual({ kind: "done", reason: "max-iterations", idleStreak: 1 });
  });

  it("stop outranks max-iterations when both would fire on the same pass", () => {
    expect(
      builderProgressDecision({
        iteration: 3,
        maxIterations: 3,
        idleLimit: 3,
        consecutiveIdle: 2,
        outcome: { complete: false, commitsThisRun: 0 },
      }),
    ).toEqual({ kind: "stop", reason: "no-progress", idleStreak: 3 });
  });

  it("a batch capped at 1 iteration ends on max-iterations, not stop, when the streak is still under the limit", () => {
    expect(
      builderProgressDecision({
        iteration: 1,
        maxIterations: 1,
        idleLimit: 3,
        consecutiveIdle: 0,
        outcome: { complete: false, commitsThisRun: 0 },
      }),
    ).toEqual({ kind: "done", reason: "max-iterations", idleStreak: 1 });
  });
});

// ---------------------------------------------------------------------------
// runBuilderIterations
// ---------------------------------------------------------------------------

const IDLE = "This session is you and me talking. Which option do you want?";
const COMMIT_NO_MARKER = "Committed a partial fix.\nStill investigating further.";
const MARKER = "All done here.\nSTORY_COMPLETE";

function idleReply(sha?: string): BuilderRunResult {
  return { stdout: IDLE, commits: sha ? [{ sha }] : [] };
}
function commitNoMarkerReply(sha: string): BuilderRunResult {
  return { stdout: COMMIT_NO_MARKER, commits: [{ sha }] };
}
function markerReply(sha?: string): BuilderRunResult {
  return { stdout: MARKER, commits: sha ? [{ sha }] : [] };
}

/** Replay `replies` in order, recording every (pass, ceilingMs) dispatch. */
function scriptedRunOnce(replies: readonly BuilderRunResult[]) {
  const calls: { pass: number; ceilingMs: number | undefined }[] = [];
  const runOnce = async (
    pass: number,
    ceilingMs: number | undefined,
  ): Promise<BuilderRunResult> => {
    calls.push({ pass, ceilingMs });
    const reply = replies[pass - 1];
    if (reply === undefined) {
      throw new Error(`scriptedRunOnce: no scripted reply for pass ${pass}`);
    }
    return reply;
  };
  return { runOnce, calls };
}

describe("runBuilderIterations", () => {
  it("(a) a marker on pass 1 completes in exactly one call", async () => {
    const { runOnce, calls } = scriptedRunOnce([markerReply("c1")]);
    const result = await runBuilderIterations({
      runOnce,
      maxIterations: 100,
      idleLimit: 3,
    });
    expect(calls.length).toBe(1);
    expect(result.iterationsRun).toBe(1);
    expect(result.commits).toEqual([{ sha: "c1" }]);
  });

  it("(b) three consecutive idle passes reject BuilderNoProgressError after exactly three calls", async () => {
    const { runOnce, calls } = scriptedRunOnce([idleReply(), idleReply(), idleReply()]);
    await expect(
      runBuilderIterations({ runOnce, maxIterations: 100, idleLimit: 3 }),
    ).rejects.toThrow(BuilderNoProgressError);
    expect(calls.length).toBe(3);
  });

  it("(b) the rejected error carries idleStreak 3 and no commits", async () => {
    const { runOnce } = scriptedRunOnce([idleReply(), idleReply(), idleReply()]);
    let thrown: unknown;
    try {
      await runBuilderIterations({ runOnce, maxIterations: 100, idleLimit: 3 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BuilderNoProgressError);
    const err = thrown as BuilderNoProgressError;
    expect(err.idleStreak).toBe(3);
    expect(err.commits).toEqual([]);
  });

  it("(c) a commit-no-marker pass resets the streak — idle, commit, idle, idle, idle takes 5 calls and reports 1 commit", async () => {
    const { runOnce, calls } = scriptedRunOnce([
      idleReply(),
      commitNoMarkerReply("c1"),
      idleReply(),
      idleReply(),
      idleReply(),
    ]);
    let thrown: unknown;
    try {
      await runBuilderIterations({ runOnce, maxIterations: 100, idleLimit: 3 });
    } catch (err) {
      thrown = err;
    }
    expect(calls.length).toBe(5);
    expect(thrown).toBeInstanceOf(BuilderNoProgressError);
    expect((thrown as BuilderNoProgressError).commits.length).toBe(1);
  });

  it("(d) idle, idle, commit, marker resolves after 4 calls with concatenated stdout and iterations", async () => {
    const { runOnce, calls } = scriptedRunOnce([
      idleReply(),
      idleReply(),
      { stdout: "committed", commits: [{ sha: "c1" }], iterations: [{ sessionId: "s1" }] },
      { ...markerReply(), iterations: [{ sessionId: "s2" }] },
    ]);
    const result = await runBuilderIterations({ runOnce, maxIterations: 100, idleLimit: 3 });
    expect(calls.length).toBe(4);
    expect(result.stdout).toBe([IDLE, IDLE, "committed", MARKER].join("\n"));
    expect(result.iterations).toEqual([{ sessionId: "s1" }, { sessionId: "s2" }]);
    expect(result.commits).toEqual([{ sha: "c1" }]);
    expect(result.iterationsRun).toBe(4);
  });

  describe("(e) headSha wiring", () => {
    it("HEAD movement with zero commits counts as progress and resets the streak", async () => {
      const heads = ["start", "moved"];
      let headCall = 0;
      const headSha = async (): Promise<string> => heads[headCall++] ?? "moved";
      // idleLimit 1 would stop immediately on a no-progress pass 1; HEAD moved,
      // so it must NOT stop — pass 2 (a marker) completes the batch instead.
      const { runOnce, calls } = scriptedRunOnce([idleReply(), markerReply("c1")]);
      const result = await runBuilderIterations({
        runOnce,
        headSha,
        maxIterations: 100,
        idleLimit: 1,
      });
      expect(calls.length).toBe(2);
      expect(result.iterationsRun).toBe(2);
    });

    it("a rejecting headSha is treated as undefined, not as a batch failure", async () => {
      const headSha = async (): Promise<string> => {
        throw new Error("cannot read HEAD");
      };
      const { runOnce } = scriptedRunOnce([idleReply()]);
      // headBefore/headAfter both collapse to undefined (rejection swallowed),
      // so no progress can be proven — a single idle pass at idleLimit 1 stops
      // on BuilderNoProgressError, never on the headSha's own "cannot read
      // HEAD" error.
      await expect(
        runBuilderIterations({ runOnce, headSha, maxIterations: 100, idleLimit: 1 }),
      ).rejects.toThrow(BuilderNoProgressError);
    });
  });

  it("(f) a stuckAborted pass returns immediately without further passes", async () => {
    const { runOnce, calls } = scriptedRunOnce([
      idleReply(),
      { stdout: "[stuck-detector] aborted", commits: [], stuckAborted: true },
      markerReply(),
    ]);
    const result = await runBuilderIterations({ runOnce, maxIterations: 100, idleLimit: 3 });
    expect(calls.length).toBe(2);
    expect(result.stuckAborted).toBe(true);
    expect(result.iterationsRun).toBe(2);
  });

  it("(g) two commit-no-marker passes at maxIterations 2 resolve at the iteration ceiling", async () => {
    const { runOnce, calls } = scriptedRunOnce([
      commitNoMarkerReply("c1"),
      commitNoMarkerReply("c2"),
    ]);
    const result = await runBuilderIterations({ runOnce, maxIterations: 2, idleLimit: 3 });
    expect(calls.length).toBe(2);
    expect(result.iterationsRun).toBe(2);
    expect(result.commits).toEqual([{ sha: "c1" }, { sha: "c2" }]);
  });

  it("(h) a deadline that passes before pass 2 rejects a hard-ceiling error after exactly one call", async () => {
    const nowSeq = [500, 1500];
    const now = (): number => nowSeq.shift() ?? 1500;
    const { runOnce, calls } = scriptedRunOnce([idleReply(), idleReply(), idleReply()]);
    await expect(
      runBuilderIterations({
        runOnce,
        maxIterations: 100,
        idleLimit: 3,
        deadlineMs: 1000,
        now,
      }),
    ).rejects.toThrow(/^hard ceiling:/);
    expect(calls.length).toBe(1);
  });

  it("(i) ceilingMs is the shared deadline's remainder, shrinking pass over pass", async () => {
    const nowSeq = [1000, 2000];
    const now = (): number => nowSeq.shift() ?? 2000;
    const { runOnce, calls } = scriptedRunOnce([idleReply(), markerReply()]);
    await runBuilderIterations({
      runOnce,
      maxIterations: 100,
      idleLimit: 3,
      deadlineMs: 5000,
      now,
    });
    expect(calls[0]!.ceilingMs).toBe(4000);
    expect(calls[1]!.ceilingMs).toBe(3000);
  });

  it("(i) a non-finite deadline (NaN) means no ceiling at all", async () => {
    const { runOnce, calls } = scriptedRunOnce([markerReply()]);
    await runBuilderIterations({
      runOnce,
      maxIterations: 100,
      idleLimit: 3,
      deadlineMs: Number.NaN,
    });
    expect(calls[0]!.ceilingMs).toBeUndefined();
  });

  it("(j) the no-progress error message trips none of the pipeline's classifiers", async () => {
    const { runOnce } = scriptedRunOnce([idleReply(), idleReply(), idleReply()]);
    let thrown: unknown;
    try {
      await runBuilderIterations({ runOnce, maxIterations: 100, idleLimit: 3 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toMatch(
      /rate[- ]?limit|\b429\b|rate_limit_error|\bquota\b|usage limit|hard ceiling|idle|AgentIdleTimeoutError|no output received|ETIMEDOUT|max_tokens|maximum output tokens?|output too long/i,
    );
  });
});
