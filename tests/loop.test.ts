/**
 * Track C unit tests — exercise the orchestration state machine without a
 * real Docker daemon. We mock:
 *   - sandbox.run() — produces canned RunResult objects
 *   - Track B parsers — return typed verdicts directly from canned text
 *   - Track D state ops — record calls, return canned story
 *   - Track E recovery — record calls, return canned outcome
 *
 * Coverage targets (from the brief):
 *   1. Happy path: implementer STORY_COMPLETE + reviewer ALL_CLEAR.
 *   2. One-fix-cycle: impl OK -> review HAS_BLOCKERS -> fixer FIXED ->
 *      final-pass ALL_CLEAR.
 *   3. HALT path: implementer HALT -> recovery escalates -> recovery HALT ->
 *      quarantine.
 *   4. Fix-cap exhaustion: two fixer attempts both BLOCKED -> ship-with-issue-OPEN
 *      (this is bash's actual fix-cap-exhausted behavior; the brief calls
 *      it "quarantine path" but the bash code marks the story DONE and
 *      leaves the issue OPEN, not quarantined).
 *   5. Circuit breaker: N consecutive halts trip it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  Sandbox,
  SandboxRunOptions,
  SandboxRunResult,
} from "@ai-hero/sandcastle";

import type {
  ImplementerOutput,
  ReviewerVerdict,
  FixerVerdict,
  LoopConfig,
  Story,
} from "../src/types.js";

// ---- Mocks (must be hoisted via vi.hoisted to satisfy vi.mock factory rule) -

// Vitest hoists vi.mock() above all imports, so any variable referenced inside
// a factory must be declared via vi.hoisted() (which also hoists). This block
// declares all mock fns + class so the factories below can close over them.
const mocks = vi.hoisted(() => {
  class MarkerNotFoundError extends Error {}
  return {
    extractMarker: vi.fn(),
    parseVerdict: vi.fn(),
    MarkerNotFoundError,
    pickNextEligibleStory: vi.fn(),
    markDone: vi.fn(),
    claimStory: vi.fn(),
    releaseStory: vi.fn(),
    quarantineStoryInPrd: vi.fn(),
    loadPrd: vi.fn(),
    transitionLabel: vi.fn(),
    getIssueBody: vi.fn(),
    closeIssue: vi.fn(),
    withPrdLock: vi.fn(),
    withSingleInstance: vi.fn(),
    runRecoveryLadder: vi.fn(),
    quarantineStory: vi.fn(),
    applyMigrationsBetween: vi.fn(),
    // Track-C-internal seam: every git execFile call routed through this
    // mock so /tmp/test never has to be a real git repo.
    execFileMock: vi.fn(),
  };
});

vi.mock("@ai-hero/sandcastle", () => ({
  // claudeCode is called inside agents.ts; return a stub object so
  // sandbox.run() can be invoked without exploding on the agent value.
  claudeCode: vi.fn((model: string) => ({ _model: model })),
  createSandbox: vi.fn(),
}));

// Mock node:child_process so the driver-side `git rev-parse HEAD` and
// `git diff --name-only ...` calls don't actually shell out. The loop uses
// `promisify(execFile)`; promisify recognizes the `util.promisify.custom`
// symbol on the target function — when present, the promisified form returns
// whatever that custom impl resolves with. We attach a custom implementation
// that returns `{ stdout, stderr }` — the same shape Node's real
// `child_process.execFile` produces under promisify.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  type ExecArgs = readonly string[];
  let revParseCounter = 0;
  function fakeExecArgvHandler(args: ExecArgs): { stdout: string; stderr: string } {
    mocks.execFileMock(args);
    const argv = args ?? [];
    let stdout = "";
    if (argv[0] === "rev-parse" && argv[1] === "HEAD") {
      // Increment-per-call so preSha !== postSha by default — otherwise
      // gitDiffTouchedUi short-circuits when both SHAs match and the
      // driver never calls `git diff`. Tests that need a specific SHA
      // pair override via mocks.execFileMock.mockImplementationOnce.
      revParseCounter += 1;
      stdout = `deadbeef${String(revParseCounter).padStart(36, "0")}\n`;
    } else if (argv[0] === "diff") {
      // No UI files touched by default.
      stdout = "";
    } else if (argv[0] === "issue") {
      // gh issue comment etc. — silently succeed.
      stdout = "";
    }
    return { stdout, stderr: "" };
  }
  // Callback form for any caller that uses execFile directly. Most of the
  // loop uses `promisify(execFile)`, but defaultCommentPoster also uses
  // promisified execFile.
  const execFileFn = vi.fn(
    (
      _file: string,
      args: ExecArgs,
      _opts: unknown,
      cb?: (err: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      const callback =
        typeof _opts === "function"
          ? (_opts as typeof cb)
          : cb;
      const r = fakeExecArgvHandler(args);
      callback?.(null, r.stdout, r.stderr);
    },
  );
  // Attach the custom-promisify symbol so `promisify(execFile)` returns a
  // function that resolves with `{ stdout, stderr }` instead of just stdout.
  (execFileFn as unknown as { [k: symbol]: unknown })[promisify.custom] = (
    _file: string,
    args: ExecArgs,
  ) => Promise.resolve(fakeExecArgvHandler(args));
  return { execFile: execFileFn };
});

vi.mock("../src/verdicts/index.js", () => ({
  extractMarker: mocks.extractMarker,
  parseVerdict: mocks.parseVerdict,
  MarkerNotFoundError: mocks.MarkerNotFoundError,
  // Marker constants — passed back into extractMarker by agents.ts. The mock
  // extractMarker ignores the allowed-set, so any constant value works.
  IMPLEMENTER_MARKERS: ["STORY_COMPLETE", "HALT", "RECOVERY_COMPLETE"] as const,
  REVIEWER_MARKERS: ["ALL_CLEAR", "HAS_BLOCKERS"] as const,
  FIXER_MARKERS: ["FIXED", "BLOCKED"] as const,
  ImplementerOutputSchema: {},
  ReviewerVerdictSchema: {},
  FixerVerdictSchema: {},
}));

// State barrel — Track C now imports `pickNextEligibleStory`, `markDone`,
// `closeIssue`, `getIssueBody` from `../state/index.js` (Fix #8).
vi.mock("../src/state/index.js", () => ({
  pickNextEligibleStory: mocks.pickNextEligibleStory,
  markDone: mocks.markDone,
  claimStory: mocks.claimStory,
  releaseStory: mocks.releaseStory,
  quarantineStoryInPrd: mocks.quarantineStoryInPrd,
  loadPrd: mocks.loadPrd,
  transitionLabel: mocks.transitionLabel,
  getIssueBody: mocks.getIssueBody,
  closeIssue: mocks.closeIssue,
  withPrdLock: mocks.withPrdLock,
  withSingleInstance: mocks.withSingleInstance,
}));

// Recovery barrel — Track C imports recoveryLadder + quarantineStory from
// `../recovery/index.js` (Fix #8).
vi.mock("../src/recovery/index.js", () => ({
  runRecoveryLadder: mocks.runRecoveryLadder,
  quarantineStory: mocks.quarantineStory,
}));

// Migrations barrel — Track C imports `applyMigrationsBetween` from
// `../migrations/index.js` (Fix #3 + Fix #8).
vi.mock("../src/migrations/index.js", () => ({
  applyMigrationsBetween: mocks.applyMigrationsBetween,
}));

// Re-export for inline test usage (avoids `mocks.foo.mockReset()` everywhere).
const {
  extractMarker,
  parseVerdict,
  pickNextEligibleStory,
  markDone,
  getIssueBody,
  closeIssue,
  runRecoveryLadder,
  quarantineStory,
  applyMigrationsBetween,
} = mocks;

// ---- After-mock imports -----------------------------------------------------
import { runLoop } from "../src/loop/run.js";

// ---- Test helpers -----------------------------------------------------------

function makeStory(id: string, ghIssue = 42): Story {
  return {
    id,
    title: `Test story ${id}`,
    status: "in_progress",
    ghIssue,
  };
}

function makeRunResult(opts: {
  stdout: string;
  commits?: { sha: string }[];
  completionSignal?: string;
}): SandboxRunResult {
  return {
    iterations: [],
    completionSignal: opts.completionSignal,
    stdout: opts.stdout,
    commits: opts.commits ?? [],
  };
}

const baseConfig: LoopConfig = {
  repoRoot: "/tmp/test",
  maxIterations: 5,
  consecutiveFailureLimit: 3,
  agentTimeouts: {
    implementer: 60_000,
    reviewer: 30_000,
    fixer: 30_000,
    recovery: 60_000,
  },
  models: {
    implementer: "sonnet",
    reviewer: "haiku",
    fixer: "sonnet",
    recovery: "sonnet",
    recoveryEscalated: "opus",
  },
};

interface MockSandboxBuilder {
  enqueue: (result: SandboxRunResult) => void;
  enqueueError: (err: Error) => void;
  build: () => { sandbox: Sandbox; runCalls: SandboxRunOptions[] };
}

function mockSandboxFactory(): MockSandboxBuilder {
  const queue: Array<{ kind: "result"; v: SandboxRunResult } | { kind: "error"; v: Error }> = [];
  const runCalls: SandboxRunOptions[] = [];
  return {
    enqueue: (result) => queue.push({ kind: "result", v: result }),
    enqueueError: (err) => queue.push({ kind: "error", v: err }),
    build: () => ({
      sandbox: {
        branch: "agent/test",
        worktreePath: "/tmp/test-worktree",
        run: vi.fn(async (opts: SandboxRunOptions): Promise<SandboxRunResult> => {
          runCalls.push(opts);
          const next = queue.shift();
          if (!next) {
            throw new Error("mock sandbox.run() exhausted — test enqueued too few results");
          }
          if (next.kind === "error") throw next.v;
          return next.v;
        }) as Sandbox["run"],
        interactive: vi.fn() as unknown as Sandbox["interactive"],
        close: vi.fn(async () => ({})) as Sandbox["close"],
        [Symbol.asyncDispose]: vi.fn(async () => {}),
      } as unknown as Sandbox,
      runCalls,
    }),
  };
}

beforeEach(() => {
  // mockReset() (not clearAllMocks) — the latter only clears `.mock.calls`,
  // leaving any persistent `mockReturnValue` from a prior test intact, which
  // poisons the queued `mockReturnValueOnce` chain in this test.
  extractMarker.mockReset();
  parseVerdict.mockReset();
  pickNextEligibleStory.mockReset();
  markDone.mockReset();
  getIssueBody.mockReset();
  closeIssue.mockReset();
  runRecoveryLadder.mockReset();
  quarantineStory.mockReset();
  applyMigrationsBetween.mockReset();
  mocks.execFileMock.mockReset();
  // Default Track D/E behavior: gh fetch returns empty body; everything else
  // resolves with no value.
  getIssueBody.mockResolvedValue("# A test story\n\nNo playwright command here.");
  closeIssue.mockResolvedValue(undefined);
  markDone.mockResolvedValue(undefined);
  quarantineStory.mockResolvedValue(undefined);
  // Default migrations: no-op (no SQL files added between commits).
  applyMigrationsBetween.mockResolvedValue({
    applied: 0,
    benignSkipped: 0,
    realErrors: [],
  });
});

// Wire the mocks for one iteration: extractMarker pulls from the queue
// `markerQueue` in order; parseVerdict pulls from `verdictQueue` in order.
// Each sandbox.run() consumes one extractMarker + one parseVerdict slot.
function setMarkerSequence(markers: string[]): void {
  extractMarker.mockReset();
  for (const m of markers) extractMarker.mockReturnValueOnce(m);
}
function setVerdictSequence(
  verdicts: Array<ImplementerOutput | ReviewerVerdict | FixerVerdict | undefined | "throw">,
): void {
  parseVerdict.mockReset();
  for (const v of verdicts) {
    if (v === "throw") {
      parseVerdict.mockImplementationOnce(() => {
        throw new Error("mock parse failure");
      });
    } else if (v === undefined) {
      // agents.ts swallows parseVerdict throws — emit a throw to signal "no
      // structured payload available".
      parseVerdict.mockImplementationOnce(() => {
        throw new Error("no structured payload");
      });
    } else {
      parseVerdict.mockReturnValueOnce(v);
    }
  }
}

// Helper to build a stub commenter that we can spy on.
function stubCommenter(): {
  fn: (issueNum: number, body: string) => Promise<void>;
  calls: Array<{ issueNum: number; body: string }>;
} {
  const calls: Array<{ issueNum: number; body: string }> = [];
  return {
    fn: async (issueNum, body) => {
      calls.push({ issueNum, body });
    },
    calls,
  };
}

// ---- Tests ------------------------------------------------------------------

describe("runLoop — happy path", () => {
  it("ships when implementer succeeds and reviewer says ALL_CLEAR", async () => {
    const story = makeStory("S-001");
    pickNextEligibleStory
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "STORY_COMPLETE", commits: [{ sha: "abc123" }] }));
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();

    setMarkerSequence(["STORY_COMPLETE", "ALL_CLEAR"]);

    const implOutput: ImplementerOutput = {
      storyId: "S-001",
      ghIssue: 42,
      commitSha: "abc123",
      e2eRan: true,
      e2eVerdict: "passed",
      uiTouched: false,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
    };
    const reviewClear: ReviewerVerdict = { marker: "ALL_CLEAR", concerns: [] };
    setVerdictSequence([implOutput, reviewClear]);

    const commenter = stubCommenter();
    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _commentOnIssue: commenter.fn,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("shipped");
    expect(results[0].finalCommitSha).toBe("abc123");
    expect(markDone).toHaveBeenCalledWith(
      "/tmp/test",
      "S-001",
      "abc123",
      1,
      "Test story S-001",
    );
    expect(closeIssue).toHaveBeenCalledWith(
      42,
      expect.stringContaining("abc123"),
    );
    expect(quarantineStory).not.toHaveBeenCalled();
    expect(commenter.calls).toHaveLength(0);
  });
});

describe("runLoop — one-fix-cycle", () => {
  it("ships after impl OK -> review HAS_BLOCKERS -> fixer FIXED -> final-pass ALL_CLEAR", async () => {
    const story = makeStory("S-002");
    pickNextEligibleStory
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    // sandbox.run() call order:
    //   impl -> reviewer(att1) -> fixer(att1) -> reviewer(att2) -> fixer(att2) -> finalReviewer
    builder.enqueue(makeRunResult({ stdout: "STORY_COMPLETE", commits: [{ sha: "c1" }] }));
    builder.enqueue(makeRunResult({ stdout: "HAS_BLOCKERS" }));
    builder.enqueue(makeRunResult({ stdout: "FIXED", commits: [{ sha: "c2" }] }));
    builder.enqueue(makeRunResult({ stdout: "HAS_BLOCKERS" }));
    builder.enqueue(makeRunResult({ stdout: "FIXED", commits: [{ sha: "c3" }] }));
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();

    setMarkerSequence([
      "STORY_COMPLETE",
      "HAS_BLOCKERS",
      "FIXED",
      "HAS_BLOCKERS",
      "FIXED",
      "ALL_CLEAR",
    ]);

    const implOutput: ImplementerOutput = {
      storyId: "S-002",
      ghIssue: 42,
      commitSha: "c1",
      e2eRan: true,
      e2eVerdict: "passed",
      uiTouched: false,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
    };
    const reviewBlock: ReviewerVerdict = {
      marker: "HAS_BLOCKERS",
      concerns: [{ severity: "HARD", summary: "missing" }],
    };
    const reviewClear: ReviewerVerdict = { marker: "ALL_CLEAR", concerns: [] };
    const fix1: FixerVerdict = { marker: "FIXED", commitSha: "c2" };
    const fix2: FixerVerdict = { marker: "FIXED", commitSha: "c3" };
    setVerdictSequence([
      implOutput,
      reviewBlock,
      fix1,
      reviewBlock,
      fix2,
      reviewClear,
    ]);

    const commenter = stubCommenter();
    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _commentOnIssue: commenter.fn,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("shipped");
    expect(results[0].finalCommitSha).toBe("c3");
    expect(markDone).toHaveBeenCalledTimes(1);
    expect(closeIssue).toHaveBeenCalledWith(
      42,
      expect.stringContaining("after final-review pass"),
    );
    expect(commenter.calls).toHaveLength(0);
  });
});

describe("runLoop — implementer HALT path (Fix #14)", () => {
  // Fix #14: implementer-emitted `<promise>HALT</promise>` is "stop, don't
  // retry, quarantine for human review" — recovery is for crash/timeout
  // /parse-fail only. Outcome is "quarantined" (not "halted"), and the
  // recovery ladder is NEVER invoked.
  it("quarantines IMMEDIATELY (no recovery) when implementer emits HALT with no commit", async () => {
    const story = makeStory("S-003");
    pickNextEligibleStory
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "<promise>HALT</promise>" }));
    const built = builder.build();

    setMarkerSequence(["HALT"]);

    const implOutput: ImplementerOutput = {
      storyId: "S-003",
      ghIssue: 42,
      e2eRan: false,
      e2eVerdict: "halted",
      uiTouched: false,
      certificationPresent: false,
      marker: "HALT",
      haltReason: "blocked",
    };
    setVerdictSequence([implOutput]);

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("quarantined");
    expect(runRecoveryLadder).not.toHaveBeenCalled(); // <-- the load-bearing assertion
    expect(quarantineStory).toHaveBeenCalledWith(
      "/tmp/test",
      story,
      expect.stringContaining("implementer HALT"),
    );
    // No commit landed, so no markDone/closeIssue.
    expect(markDone).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
  });

  it("quarantines (issue stays OPEN) when implementer emits HALT but a commit landed", async () => {
    // Per Fix #14: HALT-with-commit still quarantines (the implementer chose
    // to stop), but the commit stays on the branch and we deliberately do
    // NOT closeIssue or markDone. The story is left for human triage.
    const story = makeStory("S-003b");
    pickNextEligibleStory
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    builder.enqueue(
      makeRunResult({
        stdout: "<promise>HALT</promise>",
        commits: [{ sha: "halfwork1" }],
      }),
    );
    const built = builder.build();
    setMarkerSequence(["HALT"]);

    const implOutput: ImplementerOutput = {
      storyId: "S-003b",
      ghIssue: 42,
      commitSha: "halfwork1",
      e2eRan: false,
      e2eVerdict: "halted",
      uiTouched: false,
      certificationPresent: false,
      marker: "HALT",
      haltReason: "partial work, can't continue",
    };
    setVerdictSequence([implOutput]);

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("quarantined");
    expect(runRecoveryLadder).not.toHaveBeenCalled();
    expect(quarantineStory).toHaveBeenCalledWith(
      "/tmp/test",
      // Stamped attempts:1 — implementer ran once, no recovery.
      // The reason mentions the partial commit so a human can pick it up.
      expect.objectContaining({ id: "S-003b" }),
      expect.stringContaining("partial commit halfwork1"),
    );
    expect(markDone).not.toHaveBeenCalled();
    expect(closeIssue).not.toHaveBeenCalled();
  });
});

describe("runLoop — implementer-error path (recovery ladder)", () => {
  // Fix #14: a thrown implementer error (timeout, crash, marker-not-found)
  // is recoverable through the Track E ladder. Recovery HALT -> outcome
  // "halted" (NOT quarantined — bash:halted is the right tag here).
  it("runs recovery on implementer error; recovery HALT -> outcome halted", async () => {
    const story = makeStory("S-003c");
    pickNextEligibleStory
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    // Sandbox.run throws — implementer "errored" rather than emitted HALT.
    builder.enqueueError(new Error("simulated implementer crash"));
    const built = builder.build();

    runRecoveryLadder.mockResolvedValueOnce({
      decision: {
        marker: "HALT",
        fixApplied: false,
        haltReason: "Sonnet+Opus recovery HALT: still blocked",
      },
      resolvedBy: "opus",
      sonnet: { model: "claude-sonnet-4-6", clean: true, marker: "HALT" },
      opus: { model: "claude-opus-4-7", clean: true, marker: "HALT" },
    });

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("halted");
    expect(runRecoveryLadder).toHaveBeenCalledTimes(1);
    expect(quarantineStory).toHaveBeenCalled();
  });
});

describe("runLoop — fix-cap exhaustion", () => {
  it("ships with issue OPEN when 2 fixer attempts both BLOCKED", async () => {
    const story = makeStory("S-004");
    pickNextEligibleStory
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "STORY_COMPLETE", commits: [{ sha: "c1" }] }));
    builder.enqueue(makeRunResult({ stdout: "HAS_BLOCKERS" }));
    builder.enqueue(makeRunResult({ stdout: "BLOCKED" }));
    builder.enqueue(makeRunResult({ stdout: "HAS_BLOCKERS" }));
    builder.enqueue(makeRunResult({ stdout: "BLOCKED" }));
    const built = builder.build();

    setMarkerSequence([
      "STORY_COMPLETE",
      "HAS_BLOCKERS",
      "BLOCKED",
      "HAS_BLOCKERS",
      "BLOCKED",
    ]);

    const implOutput: ImplementerOutput = {
      storyId: "S-004",
      ghIssue: 42,
      commitSha: "c1",
      e2eRan: true,
      e2eVerdict: "passed",
      uiTouched: false,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
    };
    const reviewBlock: ReviewerVerdict = {
      marker: "HAS_BLOCKERS",
      concerns: [{ severity: "HARD", summary: "blocker" }],
    };
    const fixBlocked: FixerVerdict = { marker: "BLOCKED", notes: "couldn't fix" };
    setVerdictSequence([
      implOutput,
      reviewBlock,
      fixBlocked,
      reviewBlock,
      fixBlocked,
    ]);

    const commenter = stubCommenter();
    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _commentOnIssue: commenter.fn,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("shipped");
    expect(closeIssue).not.toHaveBeenCalled(); // ship-with-issue-OPEN
    expect(commenter.calls).toHaveLength(1);
    expect(commenter.calls[0].issueNum).toBe(42);
    expect(commenter.calls[0].body).toContain("Reviewer findings");
    expect(markDone).toHaveBeenCalledWith(
      "/tmp/test",
      "S-004",
      "c1",
      1,
      "Test story S-004",
    );
  });
});

describe("runLoop — circuit breaker (Fix #10)", () => {
  // Fix #10 splits the breaker into two counters:
  //   consecutiveFailures (quarantines)  -> trips at config.consecutiveFailureLimit
  //   consecutiveHalts                   -> trips at consecutiveHaltLimit (default 3)
  // Either counter ≥ its limit short-circuits the loop. "shipped" resets BOTH;
  // "skipped" bumps NEITHER.

  it("trips on 3 consecutive HALTs (default haltLimit=3) via implementer-error -> recovery HALT path", async () => {
    const story1 = makeStory("S-100");
    const story2 = makeStory("S-101");
    const story3 = makeStory("S-102");
    pickNextEligibleStory
      .mockResolvedValueOnce(story1)
      .mockResolvedValueOnce(story2)
      .mockResolvedValueOnce(story3)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    // Three implementer crashes in a row — that triggers the recovery
    // ladder. Recovery HALTs each time -> outcome="halted".
    for (let n = 0; n < 3; n++) {
      builder.enqueueError(new Error(`simulated crash ${n + 1}`));
    }
    const built = builder.build();

    runRecoveryLadder.mockResolvedValue({
      decision: { marker: "HALT", fixApplied: false, haltReason: "blocked" },
      resolvedBy: "opus",
      sonnet: { model: "claude-sonnet-4-6", clean: true, marker: "HALT" },
      opus: { model: "claude-opus-4-7", clean: true, marker: "HALT" },
    });

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      // Default haltLimit=3 — three halts trips the breaker.
    });

    // 3 halted + 1 circuit_break sentinel.
    expect(results).toHaveLength(4);
    expect(results.slice(0, 3).map((r) => r.outcome)).toEqual([
      "halted",
      "halted",
      "halted",
    ]);
    expect(results[3].outcome).toBe("circuit_break");
    expect(results[3].haltReason).toContain("consecutive halts");
  });

  it("trips on N consecutive QUARANTINEs via implementer-HALT path (Fix #14 + Fix #10)", async () => {
    // Fix #14 routes implementer-HALT to quarantined (NOT halted), so this
    // test exercises the OTHER breaker counter — consecutiveFailures.
    const story1 = makeStory("S-110");
    const story2 = makeStory("S-111");
    const story3 = makeStory("S-112");
    pickNextEligibleStory
      .mockResolvedValueOnce(story1)
      .mockResolvedValueOnce(story2)
      .mockResolvedValueOnce(story3)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    for (let n = 0; n < 3; n++) {
      builder.enqueue(makeRunResult({ stdout: "<promise>HALT</promise>" }));
    }
    const built = builder.build();

    extractMarker.mockReturnValue("HALT");
    parseVerdict.mockReturnValue({
      storyId: "S-???",
      ghIssue: 42,
      e2eRan: false,
      e2eVerdict: "halted",
      uiTouched: false,
      certificationPresent: false,
      marker: "HALT",
      haltReason: "blocked",
    } satisfies ImplementerOutput);

    const cfg: LoopConfig = { ...baseConfig, consecutiveFailureLimit: 3 };
    const results = await runLoop({
      config: cfg,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
    });

    expect(results).toHaveLength(4);
    expect(results.slice(0, 3).map((r) => r.outcome)).toEqual([
      "quarantined",
      "quarantined",
      "quarantined",
    ]);
    expect(results[3].outcome).toBe("circuit_break");
    expect(results[3].haltReason).toContain("consecutive quarantines");
    // Fix #14 — implementer HALT should NEVER call recovery.
    expect(runRecoveryLadder).not.toHaveBeenCalled();
  });

  it("does NOT count skipped iterations toward either breaker (Fix #13)", async () => {
    // A "skipped" iteration (no commit landed) is verification-only — it
    // bumps neither counter. Three skips + then an attempt should still
    // be possible.
    const stories = ["S-130", "S-131", "S-132", "S-133"].map((id) =>
      makeStory(id),
    );
    for (const s of stories) pickNextEligibleStory.mockResolvedValueOnce(s);
    pickNextEligibleStory.mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    // Three implementer runs with NO commits and STORY_COMPLETE markers
    // — produces "skipped" each time per Fix #13.
    for (let n = 0; n < 3; n++) {
      builder.enqueue(makeRunResult({ stdout: "STORY_COMPLETE" })); // no commits
    }
    // Fourth iteration ships normally.
    builder.enqueue(
      makeRunResult({ stdout: "STORY_COMPLETE", commits: [{ sha: "ok1" }] }),
    );
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();

    setMarkerSequence([
      "STORY_COMPLETE",
      "STORY_COMPLETE",
      "STORY_COMPLETE",
      "STORY_COMPLETE",
      "ALL_CLEAR",
    ]);
    const implOutput: ImplementerOutput = {
      storyId: "S-skip",
      ghIssue: 42,
      e2eRan: false,
      e2eVerdict: "skipped",
      uiTouched: false,
      certificationPresent: false,
      marker: "STORY_COMPLETE",
    };
    setVerdictSequence([
      implOutput,
      implOutput,
      implOutput,
      { ...implOutput, commitSha: "ok1" },
      { marker: "ALL_CLEAR", concerns: [] } satisfies ReviewerVerdict,
    ]);

    // consecutiveFailureLimit=3 — if "skipped" wrongly counted as failure,
    // the breaker would trip after 3 skips and the fourth iteration would
    // never get a chance to ship.
    const cfg: LoopConfig = { ...baseConfig, consecutiveFailureLimit: 3 };
    const results = await runLoop({
      config: cfg,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      consecutiveHaltLimit: 3,
    });

    // 3 skipped + 1 shipped — no circuit_break.
    expect(results.map((r) => r.outcome)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "shipped",
    ]);
  });

  it("resets the consecutive counters after a shipped iteration", async () => {
    const s1 = makeStory("S-200");
    const s2 = makeStory("S-201");
    const s3 = makeStory("S-202");
    pickNextEligibleStory
      .mockResolvedValueOnce(s1)
      .mockResolvedValueOnce(s2)
      .mockResolvedValueOnce(s3)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    // Iter 1: implementer crash -> recovery HALT (halt counter = 1).
    // Iter 2: ship (resets BOTH counters).
    // Iter 3: implementer crash -> recovery HALT (halt counter = 1, not 2).
    builder.enqueueError(new Error("crash 1"));
    builder.enqueue(
      makeRunResult({ stdout: "STORY_COMPLETE", commits: [{ sha: "c1" }] }),
    );
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    builder.enqueueError(new Error("crash 2"));
    const built = builder.build();

    setMarkerSequence(["STORY_COMPLETE", "ALL_CLEAR"]);
    parseVerdict
      .mockReturnValueOnce({
        storyId: "S-201",
        ghIssue: 42,
        commitSha: "c1",
        e2eRan: true,
        e2eVerdict: "passed",
        uiTouched: false,
        certificationPresent: true,
        marker: "STORY_COMPLETE",
      } satisfies ImplementerOutput)
      .mockReturnValueOnce({
        marker: "ALL_CLEAR",
        concerns: [],
      } satisfies ReviewerVerdict);
    // The third iteration's implementer throws before parseVerdict runs.

    runRecoveryLadder.mockResolvedValue({
      decision: { marker: "HALT", fixApplied: false, haltReason: "blocked" },
      resolvedBy: "opus",
      sonnet: { model: "claude-sonnet-4-6", clean: true, marker: "HALT" },
      opus: { model: "claude-opus-4-7", clean: true, marker: "HALT" },
    });

    // haltLimit=2 — would trip if the counter weren't reset by the shipped
    // iter. With the reset, iter 3's halt is counter=1, well under the limit.
    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      consecutiveHaltLimit: 2,
    });

    // 3 results, no circuit break: shipped iteration resets BOTH counters.
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.outcome)).toEqual(["halted", "shipped", "halted"]);
  });
});

describe("runLoop — migration auto-apply (Fix #3)", () => {
  it("quarantines (and skips reviewer) when applyMigrationsBetween returns realErrors", async () => {
    const story = makeStory("S-MIG-1");
    pickNextEligibleStory
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    // Implementer ships a commit. Migration auto-apply is invoked between
    // preSha (from `git rev-parse HEAD`) and postSha (also from rev-parse).
    builder.enqueue(
      makeRunResult({
        stdout: "STORY_COMPLETE",
        commits: [{ sha: "withmigration" }],
      }),
    );
    const built = builder.build();
    setMarkerSequence(["STORY_COMPLETE"]);
    setVerdictSequence([
      {
        storyId: "S-MIG-1",
        ghIssue: 42,
        commitSha: "withmigration",
        e2eRan: true,
        e2eVerdict: "passed",
        uiTouched: false,
        certificationPresent: true,
        marker: "STORY_COMPLETE",
      } satisfies ImplementerOutput,
    ]);

    applyMigrationsBetween.mockResolvedValueOnce({
      applied: 0,
      benignSkipped: 0,
      realErrors: [
        {
          file: "packages/db/migrations/0001_test.sql",
          stmt: "ALTER TABLE foo ADD COLUMN bar",
          msg: "ERROR:  column \"bar\" of relation \"foo\" already exists, but with a different type",
        },
      ],
    });

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
    });

    expect(applyMigrationsBetween).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("quarantined");
    expect(results[0].haltReason).toContain("migration failed");
    expect(quarantineStory).toHaveBeenCalledWith(
      "/tmp/test",
      // attempts:2 stamped onto the story (implementer + migration applier).
      expect.objectContaining({ id: "S-MIG-1", attempts: 2 }),
      expect.stringContaining("migration auto-apply failed"),
    );
    // Reviewer never ran — sandbox.run was called exactly once (implementer).
    expect(built.runCalls).toHaveLength(1);
  });
});

describe("runLoop — driver-side UI ground truth (Fix #5)", () => {
  it("uses git-diff ground truth (NOT implementer self-attestation) for commitTouchedUi", async () => {
    const story = makeStory("S-UI-1");
    pickNextEligibleStory
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(null);

    const builder = mockSandboxFactory();
    builder.enqueue(
      makeRunResult({
        stdout: "STORY_COMPLETE",
        commits: [{ sha: "uicommit" }],
      }),
    );
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();
    setMarkerSequence(["STORY_COMPLETE", "ALL_CLEAR"]);

    // Implementer LIES — claims uiTouched=false even though the diff shows
    // a .tsx file. The driver MUST ignore this and source from git diff.
    setVerdictSequence([
      {
        storyId: "S-UI-1",
        ghIssue: 42,
        commitSha: "uicommit",
        e2eRan: false,
        e2eVerdict: "skipped",
        uiTouched: false, // LIE
        certificationPresent: false,
        marker: "STORY_COMPLETE",
      } satisfies ImplementerOutput,
      { marker: "ALL_CLEAR", concerns: [] } satisfies ReviewerVerdict,
    ]);

    // The vi.mock factory for node:child_process records every execFile
    // argv vector via mocks.execFileMock(args). Tests can read that mock's
    // .mock.calls to confirm the driver-side flow. The Fix #5 load-bearing
    // assertion is that `git diff --name-only --diff-filter=AM ... -- *.tsx
    // *.jsx *.vue` is invoked AT ALL between preSha and postSha — the
    // ground truth for `commitTouchedUi`, NOT the implementer's
    // self-attested `uiTouched=false` (a known lie pattern, see bash:678–691).
    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
    });

    expect(results[0].outcome).toBe("shipped");
    // Confirm the driver invoked `git diff --name-only --diff-filter=AM`
    // with .tsx/.jsx/.vue scoping, which is the load-bearing Fix #5
    // behavior — without this call, commitTouchedUi could only come from
    // the implementer's self-attestation.
    const diffCalls = mocks.execFileMock.mock.calls
      .map((c) => c[0] as readonly string[])
      .filter((argv) => argv?.[0] === "diff");
    expect(diffCalls.length).toBeGreaterThanOrEqual(1);
    const firstDiff = diffCalls[0];
    expect(firstDiff).toContain("--diff-filter=AM");
    expect(firstDiff).toContain("*.tsx");
    expect(firstDiff).toContain("*.jsx");
    expect(firstDiff).toContain("*.vue");
  });
});

describe("runLoop — agent runner injection seam (Bonus Fix)", () => {
  it("invokes _agentRunner instead of sandbox.run when provided", async () => {
    const story = makeStory("S-SMOKE-1");
    pickNextEligibleStory
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(null);

    // Empty sandbox queue — if the loop wrongly falls back to sandbox.run,
    // it'll throw "exhausted".
    const builder = mockSandboxFactory();
    const built = builder.build();

    // Mark sequence: implementer STORY_COMPLETE, reviewer ALL_CLEAR.
    setMarkerSequence(["STORY_COMPLETE", "ALL_CLEAR"]);
    setVerdictSequence([
      {
        storyId: "S-SMOKE-1",
        ghIssue: 42,
        commitSha: "smoke-c1",
        e2eRan: false,
        e2eVerdict: "skipped",
        uiTouched: false,
        certificationPresent: false,
        marker: "STORY_COMPLETE",
      } satisfies ImplementerOutput,
      { marker: "ALL_CLEAR", concerns: [] } satisfies ReviewerVerdict,
    ]);

    // The injected runner returns canned outputs per role.
    const runnerCalls: Array<{ role: string; model: string }> = [];
    const fakeRunner = vi.fn(
      async (role: string, model: string, _prompt: string) => {
        runnerCalls.push({ role, model });
        if (role === "implementer") {
          return {
            stdout: "STORY_COMPLETE",
            commits: [{ sha: "smoke-c1" }],
            completionSignal: "STORY_COMPLETE",
          };
        }
        return {
          stdout: "ALL_CLEAR",
          commits: [] as { sha: string }[],
          completionSignal: "ALL_CLEAR",
        };
      },
    );

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _agentRunner: fakeRunner,
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("shipped");
    // sandbox.run was NEVER called — runner won.
    expect(built.runCalls).toHaveLength(0);
    expect(fakeRunner).toHaveBeenCalled();
    expect(runnerCalls.map((c) => c.role)).toEqual(["implementer", "reviewer"]);
  });
});
