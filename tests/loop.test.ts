/**
 * Track C unit tests — exercise the v1 orchestration state machine without a
 * real Docker daemon. We mock:
 *   - sandbox.run() — produces canned RunResult objects
 *   - Track B parsers — return typed verdicts directly from canned text
 *   - Track D label-state ops — listReadyIssues / claimViaLabel /
 *     markDoneViaLabel / quarantineViaLabel / transitionLabel
 *   - Planner — return canned PlannerOutput
 *   - Track E recovery — record calls, return canned outcome
 *
 * Coverage targets (post-FIX-1 wave):
 *   1. Happy path: planner returns priorityOrder → claim via label →
 *      implementer STORY_COMPLETE → reviewer ALL_CLEAR → markDoneViaLabel.
 *   2. One-fix-cycle: impl OK → review HAS_BLOCKERS → fixer FIXED →
 *      final-pass ALL_CLEAR (Opus xhigh).
 *   3. Implementer HALT path: implementer HALT → quarantineViaLabel
 *      (no recovery; issue stays OPEN with needs-human label).
 *   4. Implementer crash path: recovery ladder runs → recovery HALT →
 *      outcome halted.
 *   5. Fix-cap exhaustion: two fixer attempts both BLOCKED → ship-with-issue-OPEN.
 *   6. Circuit breaker: N consecutive halts trip it.
 *   7. Startup recovery: stranded `in-progress` issues are released back to
 *      `ready-for-agent` before the planner runs.
 *   8. Planner output is honored: priorityOrder + dependency-blocking.
 *   9. Output-suppression scan surfaces evidence to the reviewer.
 *  10. Final-pass reviewer is hardcoded to opus + xhigh (Fix #9).
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
    // V1 label-state surface (post-FIX-1).
    listReadyIssues: vi.fn(),
    claimViaLabel: vi.fn(),
    markDoneViaLabel: vi.fn(),
    quarantineViaLabel: vi.fn(),
    transitionLabel: vi.fn(),
    withSingleInstance: vi.fn(),
    closeIssue: vi.fn(),
    getIssueBody: vi.fn(),
    postIssueComment: vi.fn(),
    withPrdLock: vi.fn(),
    // V1-D rename: the multi-step ladder is gone; the diagnose-first variant
    // is the new integration point.
    runRecoveryLadder: vi.fn(),
    runRecoveryDiagnosisOrEscalate: vi.fn(),
    diagnoseHaltCause: vi.fn(),
    quarantineStory: vi.fn(),
    applyMigrationsBetween: vi.fn(),
    runPlanner: vi.fn(),
    // Track-C-internal seam: every git execFile call routed through this
    // mock so /tmp/test never has to be a real git repo.
    execFileMock: vi.fn(),
  };
});

vi.mock("@ai-hero/sandcastle", () => ({
  // claudeCode is called inside agents.ts; return a stub object so
  // sandbox.run() can be invoked without exploding on the agent value.
  claudeCode: vi.fn(
    (model: string, options?: Record<string, unknown>) => ({
      _model: model,
      _options: options,
    }),
  ),
  createSandbox: vi.fn(),
}));

// Mock node:child_process so the driver-side `git rev-parse HEAD` and
// `git diff --name-only ...` calls don't actually shell out.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  type ExecArgs = readonly string[];
  let revParseCounter = 0;
  function fakeExecArgvHandler(args: ExecArgs): { stdout: string; stderr: string } {
    mocks.execFileMock(args);
    const argv = args ?? [];
    let stdout = "";
    if (argv[0] === "rev-parse" && argv[1] === "HEAD") {
      // Increment-per-call so preSha !== postSha by default.
      revParseCounter += 1;
      stdout = `deadbeef${String(revParseCounter).padStart(36, "0")}\n`;
    } else if (argv[0] === "diff") {
      stdout = "";
    } else if (argv[0] === "show") {
      // git show <sha> --format=%B --no-patch — used by hasOutputSuppression
      // to read the commit body. Default: empty body (no suppression).
      stdout = "";
    } else if (argv[0] === "issue") {
      // Two shapes flow through here:
      //   1. `gh issue view <num> --json title,body,labels,number` (the
      //      driver's pre-fetch of the issue snapshot).
      //   2. `gh issue view <num> --json state,labels` (the blocker probe,
      //      via defaultIsIssueDone — but tests inject `_isIssueDone` so
      //      this path is rarely hit).
      //   3. `gh issue list --label in-progress --state open --json number`
      //      (startup-recovery sweep — tests inject `_listInProgressIssues`
      //      so this is rarely hit).
      //   4. `gh issue comment <num> --body <text>` (ship-with-issue-OPEN).
      if (argv[1] === "view") {
        // Distinguish the two view shapes by the JSON arg.
        const jsonArg = argv[argv.indexOf("--json") + 1] ?? "";
        if (jsonArg.includes("state")) {
          stdout = JSON.stringify({ state: "OPEN", labels: [] });
        } else {
          stdout = JSON.stringify({
            title: "Test issue title",
            body: "# A test story\n\nNo playwright command here.",
            labels: [],
            number: Number(argv[2] ?? 0) || 42,
          });
        }
      } else if (argv[1] === "list") {
        stdout = "[]";
      } else {
        stdout = "";
      }
    }
    return { stdout, stderr: "" };
  }
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
  IMPLEMENTER_MARKERS: ["STORY_COMPLETE", "HALT", "RECOVERY_COMPLETE"] as const,
  REVIEWER_MARKERS: ["ALL_CLEAR", "HAS_BLOCKERS"] as const,
  FIXER_MARKERS: ["FIXED", "BLOCKED"] as const,
  ImplementerOutputSchema: {},
  ReviewerVerdictSchema: {},
  FixerVerdictSchema: {},
}));

// State barrel — Track C now imports the V1 label-state surface.
vi.mock("../src/state/index.js", () => ({
  listReadyIssues: mocks.listReadyIssues,
  claimViaLabel: mocks.claimViaLabel,
  markDoneViaLabel: mocks.markDoneViaLabel,
  quarantineViaLabel: mocks.quarantineViaLabel,
  transitionLabel: mocks.transitionLabel,
  withSingleInstance: mocks.withSingleInstance,
  closeIssue: mocks.closeIssue,
  getIssueBody: mocks.getIssueBody,
  postIssueComment: mocks.postIssueComment,
  withPrdLock: mocks.withPrdLock,
  LABEL_READY: "ready-for-agent",
  LABEL_IN_PROGRESS: "in-progress",
  LABEL_DONE: "done",
  LABEL_NEEDS_HUMAN: "needs-human",
}));

// Recovery barrel.
vi.mock("../src/recovery/index.js", () => ({
  runRecoveryLadder: mocks.runRecoveryLadder,
  runRecoveryDiagnosisOrEscalate: mocks.runRecoveryDiagnosisOrEscalate,
  diagnoseHaltCause: mocks.diagnoseHaltCause,
  quarantineStory: mocks.quarantineStory,
}));

// Migrations barrel.
vi.mock("../src/migrations/index.js", () => ({
  applyMigrationsBetween: mocks.applyMigrationsBetween,
}));

// Planner barrel.
vi.mock("../src/planner/index.js", () => ({
  runPlanner: mocks.runPlanner,
}));

// Re-export for inline test usage.
const {
  extractMarker,
  parseVerdict,
  listReadyIssues,
  claimViaLabel,
  markDoneViaLabel,
  quarantineViaLabel,
  transitionLabel,
  withSingleInstance,
  runRecoveryLadder,
  runRecoveryDiagnosisOrEscalate,
  applyMigrationsBetween,
  runPlanner,
} = mocks;

// ---- After-mock imports -----------------------------------------------------
import { runLoop } from "../src/loop/run.js";

// ---- Test helpers -----------------------------------------------------------

/**
 * V1 schema scaffold — fills the 7 required certification fields with safe
 * defaults so tests can override only what they care about.
 */
function makeImplOutput(
  override: Partial<ImplementerOutput> & {
    storyId: string;
    ghIssue: number;
    marker: ImplementerOutput["marker"];
  },
): ImplementerOutput {
  const isHalt = override.marker === "HALT";
  return {
    storyId: override.storyId,
    ghIssue: override.ghIssue,
    commitSha: override.commitSha,
    e2eVerdict: override.e2eVerdict ?? (isHalt ? "halted" : "passed"),
    uiTouched: override.uiTouched ?? false,
    certificationPresent: override.certificationPresent ?? !isHalt,
    marker: override.marker,
    haltReason: override.haltReason,
    storyType: override.storyType ?? "backend-only",
    e2eRequired: override.e2eRequired ?? false,
    e2eActuallyRan: override.e2eActuallyRan ?? !isHalt,
    testCommandUsed:
      override.testCommandUsed !== undefined
        ? override.testCommandUsed
        : isHalt
          ? null
          : "pnpm --filter @acme/nextjs exec playwright test",
    e2eAssertionLine:
      override.e2eAssertionLine !== undefined
        ? override.e2eAssertionLine
        : isHalt
          ? null
          : "✓ login flow completes",
    outputNotFiltered: override.outputNotFiltered ?? true,
    testReachedFeature: override.testReachedFeature ?? !isHalt,
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

/**
 * Build a minimal ReadyIssueSummary-shaped record for the listReadyIssues
 * mock. The driver only reads number/title/body/labels/createdAt off these,
 * and listReadyIssues' return type is exposed via the state barrel.
 */
function makeReadyIssue(
  num: number,
  override: Partial<{
    title: string;
    body: string;
    labels: string[];
    createdAt: string;
  }> = {},
): {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt: string;
} {
  return {
    number: num,
    title: override.title ?? `Issue #${num}`,
    body: override.body ?? "# A test story\n\nNo playwright command here.",
    labels: override.labels ?? [],
    createdAt: override.createdAt ?? "2024-01-01T00:00:00Z",
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
  extractMarker.mockReset();
  parseVerdict.mockReset();
  listReadyIssues.mockReset();
  claimViaLabel.mockReset();
  markDoneViaLabel.mockReset();
  quarantineViaLabel.mockReset();
  transitionLabel.mockReset();
  withSingleInstance.mockReset();
  runRecoveryLadder.mockReset();
  runRecoveryDiagnosisOrEscalate.mockReset();
  applyMigrationsBetween.mockReset();
  runPlanner.mockReset();
  mocks.execFileMock.mockReset();

  // Default behavior: planner-list returns a single ready issue #42; planner
  // returns it as priorityOrder; claim/markDone/quarantine all resolve;
  // migrations are no-op. Tests override the bits they care about.
  listReadyIssues.mockResolvedValue([makeReadyIssue(42)]);
  claimViaLabel.mockResolvedValue(undefined);
  markDoneViaLabel.mockResolvedValue(undefined);
  quarantineViaLabel.mockResolvedValue(undefined);
  transitionLabel.mockResolvedValue(undefined);
  // withSingleInstance just runs the body — no real lock acquired.
  withSingleInstance.mockImplementation(async (_path: string, fn: () => Promise<unknown>) => {
    return await fn();
  });
  runPlanner.mockResolvedValue({
    priorityOrder: [42],
    dependencies: [],
  });
  applyMigrationsBetween.mockResolvedValue({
    applied: 0,
    benignSkipped: 0,
    realErrors: [],
  });
});

// Wire markers + verdicts queue.
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
      parseVerdict.mockImplementationOnce(() => {
        throw new Error("no structured payload");
      });
    } else {
      parseVerdict.mockReturnValueOnce(v);
    }
  }
}

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

/**
 * Default story-id format used by the v1 loop: storyFromIssue(claimedIssue)
 * synthesizes an id of `gh-<num>`. Tests assert on this when needed.
 */
const STORY_ID_42 = "gh-42";

// ---- Tests ------------------------------------------------------------------

describe("runLoop — happy path", () => {
  it("ships when implementer succeeds and reviewer says ALL_CLEAR (label-state machine)", async () => {
    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "STORY_COMPLETE", commits: [{ sha: "abc123" }] }));
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();

    setMarkerSequence(["STORY_COMPLETE", "ALL_CLEAR"]);

    const implOutput = makeImplOutput({
      storyId: STORY_ID_42,
      ghIssue: 42,
      commitSha: "abc123",
      marker: "STORY_COMPLETE",
    });
    const reviewClear: ReviewerVerdict = { marker: "ALL_CLEAR", concerns: [] };
    setVerdictSequence([implOutput, reviewClear]);

    // Tell the planner just to return our single issue #42, no blockers.
    listReadyIssues.mockResolvedValue([makeReadyIssue(42)]);
    runPlanner.mockResolvedValue({
      priorityOrder: [42],
      dependencies: [],
    });
    // Planner is also passed an issue snapshot via _fetchIssueBody; default
    // child_process mock returns a sane body so we don't need to inject.

    const commenter = stubCommenter();
    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _commentOnIssue: commenter.fn,
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("shipped");
    expect(results[0].finalCommitSha).toBe("abc123");
    expect(claimViaLabel).toHaveBeenCalledWith(42);
    expect(markDoneViaLabel).toHaveBeenCalledWith(
      42,
      expect.stringContaining("abc123"),
    );
    expect(quarantineViaLabel).not.toHaveBeenCalled();
    expect(commenter.calls).toHaveLength(0);
  });
});

describe("runLoop — one-fix-cycle", () => {
  it("ships after impl OK -> review HAS_BLOCKERS -> fixer FIXED -> final-pass ALL_CLEAR", async () => {
    const builder = mockSandboxFactory();
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

    const implOutput = makeImplOutput({
      storyId: STORY_ID_42,
      ghIssue: 42,
      commitSha: "c1",
      marker: "STORY_COMPLETE",
    });
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
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("shipped");
    expect(results[0].finalCommitSha).toBe("c3");
    expect(markDoneViaLabel).toHaveBeenCalledWith(
      42,
      expect.stringContaining("after final-review pass"),
    );
    expect(commenter.calls).toHaveLength(0);
  });
});

describe("runLoop — implementer HALT path (Fix #14)", () => {
  it("quarantines via label IMMEDIATELY (no recovery) when implementer emits HALT with no commit", async () => {
    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "<promise>HALT</promise>" }));
    const built = builder.build();

    setMarkerSequence(["HALT"]);

    const implOutput = makeImplOutput({
      storyId: STORY_ID_42,
      ghIssue: 42,
      marker: "HALT",
      haltReason: "blocked",
    });
    setVerdictSequence([implOutput]);

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("quarantined");
    expect(runRecoveryDiagnosisOrEscalate).not.toHaveBeenCalled();
    expect(runRecoveryLadder).not.toHaveBeenCalled();
    expect(quarantineViaLabel).toHaveBeenCalledWith(
      42,
      expect.stringContaining("implementer HALT"),
    );
    expect(markDoneViaLabel).not.toHaveBeenCalled();
  });

  it("quarantines (issue stays OPEN) when implementer emits HALT but a commit landed", async () => {
    const builder = mockSandboxFactory();
    builder.enqueue(
      makeRunResult({
        stdout: "<promise>HALT</promise>",
        commits: [{ sha: "halfwork1" }],
      }),
    );
    const built = builder.build();
    setMarkerSequence(["HALT"]);

    const implOutput = makeImplOutput({
      storyId: STORY_ID_42,
      ghIssue: 42,
      commitSha: "halfwork1",
      marker: "HALT",
      haltReason: "partial work, can't continue",
    });
    setVerdictSequence([implOutput]);

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("quarantined");
    expect(runRecoveryDiagnosisOrEscalate).not.toHaveBeenCalled();
    expect(runRecoveryLadder).not.toHaveBeenCalled();
    expect(quarantineViaLabel).toHaveBeenCalledWith(
      42,
      expect.stringContaining("partial commit halfwork1"),
    );
    expect(markDoneViaLabel).not.toHaveBeenCalled();
  });
});

describe("runLoop — Wave 2 / M4: quarantineViaLabel exhausting retries is non-fatal", () => {
  it("returns quarantined when implementer HALT + quarantineViaLabel always throws (loop continues, WARN on stderr)", async () => {
    // Make quarantineViaLabel reject — simulates the GH label transition
    // failing after the retry-with-backoff inside transitionLabel exhausted
    // its 3 attempts. The iteration should still return `quarantined` (not
    // crash) so the global circuit breaker counts the failure and the next
    // loop wake-up's startup-recovery sweep can reset orphaned in-progress
    // issues back to ready-for-agent.
    quarantineViaLabel.mockRejectedValue(
      new Error("gh API 503 (final after retries)"),
    );

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "<promise>HALT</promise>" }));
    const built = builder.build();
    setMarkerSequence(["HALT"]);

    const implOutput = makeImplOutput({
      storyId: STORY_ID_42,
      ghIssue: 42,
      marker: "HALT",
      haltReason: "blocked external API",
    });
    setVerdictSequence([implOutput]);

    // Capture stderr writes so we can assert the WARN line is emitted.
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((..._a: unknown[]) => true) as never);

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _listInProgressIssues: async () => [],
    });

    // Outcome is still `quarantined` even though the label transition failed.
    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("quarantined");

    // quarantineViaLabel was attempted at least once (and threw).
    expect(quarantineViaLabel).toHaveBeenCalled();

    // stderr received the WARN line with the expected shape.
    const stderrText = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .join("");
    expect(stderrText).toMatch(
      /WARN: quarantineViaLabel\(42\) failed after retries: gh API 503 \(final after retries\)/,
    );

    // markDoneViaLabel must not have been called — the iteration didn't ship.
    expect(markDoneViaLabel).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });
});

describe("runLoop — implementer-error path (recovery ladder)", () => {
  it("runs recovery on implementer error; recovery HALT -> outcome halted", async () => {
    const builder = mockSandboxFactory();
    builder.enqueueError(new Error("simulated implementer crash"));
    const built = builder.build();

    runRecoveryDiagnosisOrEscalate.mockResolvedValueOnce({
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
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("halted");
    expect(runRecoveryDiagnosisOrEscalate).toHaveBeenCalledTimes(1);
    expect(quarantineViaLabel).toHaveBeenCalled();
  });
});

describe("runLoop — fix-cap exhaustion", () => {
  it("ships with issue OPEN when 2 fixer attempts both BLOCKED (no markDoneViaLabel — issue stays OPEN)", async () => {
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

    const implOutput = makeImplOutput({
      storyId: STORY_ID_42,
      ghIssue: 42,
      commitSha: "c1",
      marker: "STORY_COMPLETE",
    });
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
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("shipped");
    // ship-with-issue-OPEN: NO markDoneViaLabel call (it would close the
    // issue); just a ship-open comment.
    expect(markDoneViaLabel).not.toHaveBeenCalled();
    expect(commenter.calls).toHaveLength(1);
    expect(commenter.calls[0].issueNum).toBe(42);
    expect(commenter.calls[0].body).toContain("Reviewer findings");
  });
});

describe("runLoop — circuit breaker (Fix #10)", () => {
  it("trips on 3 consecutive HALTs (default haltLimit=3) via implementer-error -> recovery HALT path", async () => {
    // Three different stories, three implementer crashes, three recovery HALTs.
    listReadyIssues.mockResolvedValue([
      makeReadyIssue(100),
      makeReadyIssue(101),
      makeReadyIssue(102),
    ]);
    runPlanner.mockResolvedValue({
      priorityOrder: [100, 101, 102],
      dependencies: [],
    });

    const builder = mockSandboxFactory();
    for (let n = 0; n < 3; n++) {
      builder.enqueueError(new Error(`simulated crash ${n + 1}`));
    }
    const built = builder.build();

    runRecoveryDiagnosisOrEscalate.mockResolvedValue({
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
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(4);
    expect(results.slice(0, 3).map((r) => r.outcome)).toEqual([
      "halted",
      "halted",
      "halted",
    ]);
    expect(results[3].outcome).toBe("circuit_break");
    expect(results[3].haltReason).toContain("consecutive halts");
  });

  it("trips on N consecutive QUARANTINEs via implementer-HALT path", async () => {
    listReadyIssues.mockResolvedValue([
      makeReadyIssue(110),
      makeReadyIssue(111),
      makeReadyIssue(112),
    ]);
    runPlanner.mockResolvedValue({
      priorityOrder: [110, 111, 112],
      dependencies: [],
    });

    const builder = mockSandboxFactory();
    for (let n = 0; n < 3; n++) {
      builder.enqueue(makeRunResult({ stdout: "<promise>HALT</promise>" }));
    }
    const built = builder.build();

    extractMarker.mockReturnValue("HALT");
    parseVerdict.mockReturnValue(
      makeImplOutput({
        storyId: "gh-?",
        ghIssue: 0,
        marker: "HALT",
        haltReason: "blocked",
      }),
    );

    const cfg: LoopConfig = { ...baseConfig, consecutiveFailureLimit: 3 };
    const results = await runLoop({
      config: cfg,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(4);
    expect(results.slice(0, 3).map((r) => r.outcome)).toEqual([
      "quarantined",
      "quarantined",
      "quarantined",
    ]);
    expect(results[3].outcome).toBe("circuit_break");
    expect(results[3].haltReason).toContain("consecutive quarantines");
    expect(runRecoveryDiagnosisOrEscalate).not.toHaveBeenCalled();
    expect(runRecoveryLadder).not.toHaveBeenCalled();
  });

  it("does NOT count skipped iterations toward either breaker (Fix #13)", async () => {
    // Four issues; first three skip (no commit), fourth ships.
    listReadyIssues.mockResolvedValue([
      makeReadyIssue(130),
      makeReadyIssue(131),
      makeReadyIssue(132),
      makeReadyIssue(133),
    ]);
    runPlanner.mockResolvedValue({
      priorityOrder: [130, 131, 132, 133],
      dependencies: [],
    });

    const builder = mockSandboxFactory();
    for (let n = 0; n < 3; n++) {
      builder.enqueue(makeRunResult({ stdout: "STORY_COMPLETE" })); // no commit
    }
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
    const implOutput = makeImplOutput({
      storyId: "gh-skip",
      ghIssue: 130,
      marker: "STORY_COMPLETE",
      e2eVerdict: "skipped",
      e2eActuallyRan: false,
      certificationPresent: false,
    });
    setVerdictSequence([
      implOutput,
      implOutput,
      implOutput,
      { ...implOutput, commitSha: "ok1" },
      { marker: "ALL_CLEAR", concerns: [] } satisfies ReviewerVerdict,
    ]);

    const cfg: LoopConfig = { ...baseConfig, consecutiveFailureLimit: 3 };
    const results = await runLoop({
      config: cfg,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      consecutiveHaltLimit: 3,
      _listInProgressIssues: async () => [],
    });

    expect(results.map((r) => r.outcome)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "shipped",
    ]);
  });
});

describe("runLoop — startup recovery sweep (Fix #7)", () => {
  it("releases stranded in-progress issues back to ready-for-agent before the planner runs", async () => {
    // Two stranded issues from a previous (crashed) loop.
    const listInProgressFn = vi.fn(async () => [201, 202]);

    // Default planner output; we don't really care, just ensure runLoop fires.
    listReadyIssues.mockResolvedValue([makeReadyIssue(42)]);
    runPlanner.mockResolvedValue({
      priorityOrder: [42],
      dependencies: [],
    });

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "STORY_COMPLETE", commits: [{ sha: "ok" }] }));
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();

    setMarkerSequence(["STORY_COMPLETE", "ALL_CLEAR"]);
    setVerdictSequence([
      makeImplOutput({
        storyId: STORY_ID_42,
        ghIssue: 42,
        commitSha: "ok",
        marker: "STORY_COMPLETE",
      }),
      { marker: "ALL_CLEAR", concerns: [] } satisfies ReviewerVerdict,
    ]);

    await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _listInProgressIssues: listInProgressFn,
    });

    expect(listInProgressFn).toHaveBeenCalledTimes(1);
    // Each stranded issue gets a transitionLabel(in-progress -> ready).
    expect(transitionLabel).toHaveBeenCalledWith(201, "in-progress", "ready-for-agent");
    expect(transitionLabel).toHaveBeenCalledWith(202, "in-progress", "ready-for-agent");
  });

  it("wraps the loop body in withSingleInstance", async () => {
    // Confirm withSingleInstance is invoked exactly once with the sandcastle
    // lock path and runs the inner body to completion.
    const lockPaths: string[] = [];
    withSingleInstance.mockImplementation(async (lockPath: string, fn: () => Promise<unknown>) => {
      lockPaths.push(lockPath);
      return await fn();
    });

    listReadyIssues.mockResolvedValue([]); // no work — fast path
    runPlanner.mockResolvedValue({ priorityOrder: [], dependencies: [] });

    const builder = mockSandboxFactory();
    const built = builder.build();
    await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _listInProgressIssues: async () => [],
    });

    expect(withSingleInstance).toHaveBeenCalledTimes(1);
    expect(lockPaths).toHaveLength(1);
    expect(lockPaths[0]).toContain(".sandcastle.lock");
  });
});

describe("runLoop — planner output is honored (Fix #2)", () => {
  it("walks priorityOrder and skips issues whose blockers are NOT done", async () => {
    listReadyIssues.mockResolvedValue([
      makeReadyIssue(300),
      makeReadyIssue(301),
    ]);
    // Planner says try #300 first, but it's blocked by #999 which is NOT done.
    // Then #301 has no blockers — claim that.
    runPlanner.mockResolvedValue({
      priorityOrder: [300, 301],
      dependencies: [{ issue: 300, blockedBy: [999] }],
    });

    const isDoneFn = vi.fn(async (num: number) => num !== 999);

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "STORY_COMPLETE", commits: [{ sha: "okk" }] }));
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();

    setMarkerSequence(["STORY_COMPLETE", "ALL_CLEAR"]);
    setVerdictSequence([
      makeImplOutput({
        storyId: "gh-301",
        ghIssue: 301,
        commitSha: "okk",
        marker: "STORY_COMPLETE",
      }),
      { marker: "ALL_CLEAR", concerns: [] } satisfies ReviewerVerdict,
    ]);

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _isIssueDone: isDoneFn,
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("shipped");
    // We claim #301, NOT #300 (blocked).
    expect(claimViaLabel).toHaveBeenCalledTimes(1);
    expect(claimViaLabel).toHaveBeenCalledWith(301);
  });

  it("returns no_story when every priorityOrder entry has open blockers", async () => {
    listReadyIssues.mockResolvedValue([makeReadyIssue(400)]);
    runPlanner.mockResolvedValue({
      priorityOrder: [400],
      dependencies: [{ issue: 400, blockedBy: [999] }],
    });

    const isDoneFn = vi.fn(async () => false);

    const builder = mockSandboxFactory();
    const built = builder.build();
    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _isIssueDone: isDoneFn,
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(0);
    expect(claimViaLabel).not.toHaveBeenCalled();
  });
});

describe("runLoop — driver-side UI ground truth (Fix #5)", () => {
  it("uses git-diff ground truth (NOT implementer self-attestation) for commitTouchedUi", async () => {
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

    setVerdictSequence([
      makeImplOutput({
        storyId: STORY_ID_42,
        ghIssue: 42,
        commitSha: "uicommit",
        marker: "STORY_COMPLETE",
        e2eVerdict: "skipped",
        e2eActuallyRan: false,
        uiTouched: false, // LIE
        certificationPresent: false,
      }),
      { marker: "ALL_CLEAR", concerns: [] } satisfies ReviewerVerdict,
    ]);

    const results = await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _listInProgressIssues: async () => [],
    });

    expect(results[0].outcome).toBe("shipped");
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

describe("runLoop — output-suppression scan (Fix #5 ext.)", () => {
  it("hasOutputSuppression detects '| grep -v' in the commit body", async () => {
    const { hasOutputSuppression } = await import("../src/loop/iteration.js");
    // Patch the execFile mock to return a commit body that includes the
    // suppression pattern, just for this test's `git show` call.
    const callArgsBefore = mocks.execFileMock.mock.calls.length;
    // We need a fresh per-call override. Easiest: spy on the underlying
    // child_process mock to return a custom body for `git show`. The vi.mock
    // factory delegates argv inspection via mocks.execFileMock(args) — but
    // it doesn't read OUR return; it uses fakeExecArgvHandler. So we test
    // the helper against in-memory data by stubbing through a temp dir.
    //
    // Simpler — we test the regex behavior alone by providing a SHA that
    // routes through the default mock (empty body, no suppression). For an
    // integration test of suppression detection use the `progress.txt`
    // path: we drop a file with `| grep -v` in the temp repo and call the
    // helper directly.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-supp-"));
    await fs.writeFile(
      path.join(tmp, "progress.txt"),
      "[it=1] gh-1 — ran tests\n[it=2] gh-2 — playwright | grep -v 'foo' | tee out.log\n",
      "utf8",
    );
    // The default git-show mock returns "" — so the only hit is from
    // progress.txt's last line.
    const out = await hasOutputSuppression(tmp, "deadbeef");
    expect(out.found).toBe(true);
    expect(out.evidence).toContain("progress.txt");
    expect(out.evidence).toContain("grep -v");
    void callArgsBefore;
    // Cleanup
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("hasOutputSuppression returns clean when neither commit nor progress.txt match", async () => {
    const { hasOutputSuppression } = await import("../src/loop/iteration.js");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-supp-"));
    await fs.writeFile(
      path.join(tmp, "progress.txt"),
      "[it=1] gh-1 — clean playwright run\n",
      "utf8",
    );
    const out = await hasOutputSuppression(tmp, "deadbeef");
    expect(out.found).toBe(false);
    expect(out.evidence).toBeNull();
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe("runLoop — agent runner injection seam (Bonus Fix)", () => {
  it("invokes _agentRunner instead of sandbox.run when provided", async () => {
    const builder = mockSandboxFactory();
    const built = builder.build();

    setMarkerSequence(["STORY_COMPLETE", "ALL_CLEAR"]);
    setVerdictSequence([
      makeImplOutput({
        storyId: STORY_ID_42,
        ghIssue: 42,
        commitSha: "smoke-c1",
        marker: "STORY_COMPLETE",
        e2eVerdict: "skipped",
        e2eActuallyRan: false,
        certificationPresent: false,
      }),
      { marker: "ALL_CLEAR", concerns: [] } satisfies ReviewerVerdict,
    ]);

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
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("shipped");
    expect(built.runCalls).toHaveLength(0);
    expect(fakeRunner).toHaveBeenCalled();
    expect(runnerCalls.map((c) => c.role)).toEqual(["implementer", "reviewer"]);
  });
});

describe("runLoop — V1-B pre-fetched issue body in all three prompts", () => {
  it("embeds the issue title + body verbatim at the top of all 3 agent prompts", async () => {
    listReadyIssues.mockResolvedValue([makeReadyIssue(42)]);
    runPlanner.mockResolvedValue({
      priorityOrder: [42],
      dependencies: [],
    });

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "STORY_COMPLETE", commits: [{ sha: "v1b-c1" }] }));
    builder.enqueue(makeRunResult({ stdout: "HAS_BLOCKERS" }));
    builder.enqueue(makeRunResult({ stdout: "FIXED", commits: [{ sha: "v1b-c2" }] }));
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();

    setMarkerSequence(["STORY_COMPLETE", "HAS_BLOCKERS", "FIXED", "ALL_CLEAR"]);
    setVerdictSequence([
      makeImplOutput({
        storyId: STORY_ID_42,
        ghIssue: 42,
        commitSha: "v1b-c1",
        marker: "STORY_COMPLETE",
      }),
      {
        marker: "HAS_BLOCKERS",
        concerns: [{ severity: "HARD", summary: "fix me" }],
      } satisfies ReviewerVerdict,
      { marker: "FIXED", commitSha: "v1b-c2" } satisfies FixerVerdict,
      { marker: "ALL_CLEAR", concerns: [] } satisfies ReviewerVerdict,
    ]);

    const issueSnap = {
      title: "Add bento grid card hover state",
      body: "## Acceptance\n\nUser hovers card → background lifts.\n\nplaywright test apps/nextjs/e2e/bento.spec.ts",
      labels: ["story", "ui"],
      number: 42,
    };
    const fetchSpy = vi.fn(async () => issueSnap);

    const promptsByRole = new Map<string, string>();
    const fakeRunner = vi.fn(
      async (role: string, _model: string, prompt: string) => {
        promptsByRole.set(role, prompt);
        if (role === "implementer") {
          return {
            stdout: "STORY_COMPLETE",
            commits: [{ sha: "v1b-c1" }],
            completionSignal: "STORY_COMPLETE",
          };
        }
        if (role === "fixer") {
          return {
            stdout: "FIXED",
            commits: [{ sha: "v1b-c2" }],
            completionSignal: "FIXED",
          };
        }
        const calls = fakeRunner.mock.calls.filter((c) => c[0] === "reviewer");
        const stdout = calls.length === 1 ? "HAS_BLOCKERS" : "ALL_CLEAR";
        return {
          stdout,
          commits: [] as { sha: string }[],
          completionSignal: stdout,
        };
      },
    );

    await runLoop({
      config: baseConfig,
      branch: "agent/test",
      sandboxProvider: {} as never,
      recoveryPromptPath: "/tmp/recovery.md",
      _createSandbox: async () => built.sandbox,
      _agentRunner: fakeRunner,
      _fetchIssueBody: fetchSpy,
      _listInProgressIssues: async () => [],
    });

    // Pre-fetch fired exactly ONCE per iteration (during the planner-priority
    // walk, not separately).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(42);

    expect(promptsByRole.has("implementer")).toBe(true);
    expect(promptsByRole.has("reviewer")).toBe(true);
    expect(promptsByRole.has("fixer")).toBe(true);

    for (const role of ["implementer", "reviewer", "fixer"] as const) {
      const p = promptsByRole.get(role)!;
      expect(p).toContain(`Issue #42: ${issueSnap.title}`);
      expect(p).toContain("User hovers card → background lifts.");
      expect(p).toContain("Labels: story, ui");
    }

    const headerProbe = "=== Issue spec (pre-fetched by driver";
    for (const role of ["implementer", "reviewer", "fixer"] as const) {
      const p = promptsByRole.get(role)!;
      expect(p.indexOf(headerProbe)).toBe(0);
    }
  });
});

describe("runLoop — V1-B reviewer effort scaling by diff size", () => {
  it("reviewerEffortForDiffSize buckets at 100 / 500 boundaries", async () => {
    const { reviewerEffortForDiffSize } = await import(
      "../src/loop/agents.js"
    );
    expect(reviewerEffortForDiffSize(0)).toBe("low");
    expect(reviewerEffortForDiffSize(50)).toBe("low");
    expect(reviewerEffortForDiffSize(99)).toBe("low");
    expect(reviewerEffortForDiffSize(100)).toBe("medium");
    expect(reviewerEffortForDiffSize(200)).toBe("medium");
    expect(reviewerEffortForDiffSize(499)).toBe("medium");
    expect(reviewerEffortForDiffSize(500)).toBe("high");
    expect(reviewerEffortForDiffSize(600)).toBe("high");
    expect(reviewerEffortForDiffSize(10_000)).toBe("high");
  });

  it("invokes claudeCode with effort=medium when runReviewer is called with 200 lines", async () => {
    const { runReviewer } = await import("../src/loop/agents.js");
    const sandcastle = await import("@ai-hero/sandcastle");
    const claudeCodeMock = vi.mocked(sandcastle.claudeCode);
    claudeCodeMock.mockClear();

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();
    setMarkerSequence(["ALL_CLEAR"]);
    setVerdictSequence([{ marker: "ALL_CLEAR", concerns: [] }]);

    await runReviewer({
      sandbox: built.sandbox,
      prompt: "stub",
      config: baseConfig,
      iterationNum: 1,
      attempt: 1,
      diffLineCount: 200,
    });

    expect(claudeCodeMock).toHaveBeenCalledTimes(1);
    const [, options] = claudeCodeMock.mock.calls[0];
    expect((options as { effort?: string } | undefined)?.effort).toBe("medium");
  });

  it("invokes claudeCode with effort=high when runReviewer is called with 600 lines", async () => {
    const { runReviewer } = await import("../src/loop/agents.js");
    const sandcastle = await import("@ai-hero/sandcastle");
    const claudeCodeMock = vi.mocked(sandcastle.claudeCode);
    claudeCodeMock.mockClear();

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();
    setMarkerSequence(["ALL_CLEAR"]);
    setVerdictSequence([{ marker: "ALL_CLEAR", concerns: [] }]);

    await runReviewer({
      sandbox: built.sandbox,
      prompt: "stub",
      config: baseConfig,
      iterationNum: 1,
      attempt: 1,
      diffLineCount: 600,
    });

    expect(claudeCodeMock).toHaveBeenCalledTimes(1);
    const [, options] = claudeCodeMock.mock.calls[0];
    expect((options as { effort?: string } | undefined)?.effort).toBe("high");
  });

  it("invokes claudeCode with effort=low when runReviewer is called with 50 lines", async () => {
    const { runReviewer } = await import("../src/loop/agents.js");
    const sandcastle = await import("@ai-hero/sandcastle");
    const claudeCodeMock = vi.mocked(sandcastle.claudeCode);
    claudeCodeMock.mockClear();

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();
    setMarkerSequence(["ALL_CLEAR"]);
    setVerdictSequence([{ marker: "ALL_CLEAR", concerns: [] }]);

    await runReviewer({
      sandbox: built.sandbox,
      prompt: "stub",
      config: baseConfig,
      iterationNum: 1,
      attempt: 1,
      diffLineCount: 50,
    });

    expect(claudeCodeMock).toHaveBeenCalledTimes(1);
    const [, options] = claudeCodeMock.mock.calls[0];
    expect((options as { effort?: string } | undefined)?.effort).toBe("low");
  });

  it("escalated reviewer (rc≠0 first attempt) uses xhigh effort regardless of diff size", async () => {
    const { runReviewer } = await import("../src/loop/agents.js");
    const sandcastle = await import("@ai-hero/sandcastle");
    const claudeCodeMock = vi.mocked(sandcastle.claudeCode);
    claudeCodeMock.mockClear();

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();
    setMarkerSequence(["ALL_CLEAR"]);
    setVerdictSequence([{ marker: "ALL_CLEAR", concerns: [] }]);

    await runReviewer({
      sandbox: built.sandbox,
      prompt: "stub",
      config: baseConfig,
      iterationNum: 1,
      attempt: 1,
      escalated: true,
      diffLineCount: 50,
    });

    expect(claudeCodeMock).toHaveBeenCalledTimes(1);
    const [model, options] = claudeCodeMock.mock.calls[0];
    expect(model).toBe("claude-opus-4-7");
    expect((options as { effort?: string } | undefined)?.effort).toBe("xhigh");
  });
});

describe("runFinalReviewer — Fix #9 hardcoded opus + xhigh", () => {
  it("calls claudeCode with model=claude-opus-4-7 and effort=xhigh regardless of config", async () => {
    const { runFinalReviewer } = await import("../src/loop/agents.js");
    const sandcastle = await import("@ai-hero/sandcastle");
    const claudeCodeMock = vi.mocked(sandcastle.claudeCode);
    claudeCodeMock.mockClear();

    const builder = mockSandboxFactory();
    builder.enqueue(makeRunResult({ stdout: "ALL_CLEAR" }));
    const built = builder.build();
    setMarkerSequence(["ALL_CLEAR"]);
    setVerdictSequence([{ marker: "ALL_CLEAR", concerns: [] }]);

    // baseConfig.models.reviewer is "haiku" — yet runFinalReviewer must
    // ignore that and hardcode opus + xhigh.
    await runFinalReviewer({
      sandbox: built.sandbox,
      prompt: "stub",
      config: baseConfig,
      iterationNum: 1,
    });

    expect(claudeCodeMock).toHaveBeenCalledTimes(1);
    const [model, options] = claudeCodeMock.mock.calls[0];
    expect(model).toBe("claude-opus-4-7");
    expect((options as { effort?: string } | undefined)?.effort).toBe("xhigh");
  });
});

describe("buildReviewerBriefing — Fix #8 + Fix #5 ext content", () => {
  it("includes the OUTPUT-SUPPRESSION CHECK paragraph and the EVIDENCE QUOTE rules", async () => {
    const { buildReviewerBriefing } = await import("../src/loop/briefing.js");
    const prompt = buildReviewerBriefing({
      story: { id: "gh-1", title: "x", status: "in_progress", ghIssue: 1 },
      ghIssue: 1,
      iterationNum: 1,
      iterationTotal: 1,
      issue: { title: "x", body: "y", labels: [], number: 1 },
      lastSha: "deadbeef",
      branch: "agent/test",
      specRequiresPlaywright: true,
      commitTouchedUi: false,
    });
    expect(prompt).toContain("OUTPUT-SUPPRESSION CHECK");
    expect(prompt).toContain("EVIDENCE QUOTE");
    expect(prompt).toContain("Running N tests");
    expect(prompt).toContain("CROSS-CHECK CERTIFICATION VS BAIL SIGNALS");
  });

  it("surfaces outputSuppressionEvidence to the prompt as automatic HARD trigger", async () => {
    const { buildReviewerBriefing } = await import("../src/loop/briefing.js");
    const prompt = buildReviewerBriefing({
      story: { id: "gh-1", title: "x", status: "in_progress", ghIssue: 1 },
      ghIssue: 1,
      iterationNum: 1,
      iterationTotal: 1,
      issue: { title: "x", body: "y", labels: [], number: 1 },
      lastSha: "deadbeef",
      branch: "agent/test",
      specRequiresPlaywright: true,
      commitTouchedUi: false,
      outputSuppressionEvidence: "commit body: playwright | grep -v warning",
    });
    expect(prompt).toContain("OUTPUT_SUPPRESSION_EVIDENCE");
    expect(prompt).toContain("playwright | grep -v warning");
    expect(prompt).toContain("automatic HARD");
  });
});

describe("buildImplementerBriefing — Fix #3 + Fix #4 prompt corrections", () => {
  it("uses the schema-correct storyType enum (drops 'docs' / 'backend', adds 'backend-only')", async () => {
    const { buildImplementerBriefing } = await import("../src/loop/briefing.js");
    const prompt = buildImplementerBriefing({
      story: { id: "gh-1", title: "x", status: "in_progress", ghIssue: 1 },
      ghIssue: 1,
      iterationNum: 1,
      iterationTotal: 1,
      issue: { title: "x", body: "y", labels: [], number: 1 },
      implementerTemplate: "TEMPLATE_BODY",
    });
    expect(prompt).toContain('"ui" | "backend-only" | "infra"');
    expect(prompt).not.toContain('"docs"');
    // The schema-incorrect "backend" (without -only) should NOT appear as an
    // option in the storyType question. Allow it to appear in other contexts
    // (e.g. the word "backend-only" includes "backend"); only check the
    // enum-listing line.
    expect(prompt).toMatch(/"ui"\s*\|\s*"backend-only"\s*\|\s*"infra"/);
  });

  it("instructs the implementer to use JSON null (not empty string) for absent test fields", async () => {
    const { buildImplementerBriefing } = await import("../src/loop/briefing.js");
    const prompt = buildImplementerBriefing({
      story: { id: "gh-1", title: "x", status: "in_progress", ghIssue: 1 },
      ghIssue: 1,
      iterationNum: 1,
      iterationTotal: 1,
      issue: { title: "x", body: "y", labels: [], number: 1 },
      implementerTemplate: "TEMPLATE_BODY",
    });
    // The two string-typed cert fields explicitly say "JSON null" or "null,
    // not ''" — i.e. the absence sentinel is null, not the empty string.
    expect(prompt).toContain("JSON null");
    expect(prompt).toMatch(/null.*not.*""/);
  });

  it("instructs the implementer to write a one-line entry to progress.txt before STORY_COMPLETE", async () => {
    const { buildImplementerBriefing } = await import("../src/loop/briefing.js");
    const prompt = buildImplementerBriefing({
      story: { id: "gh-1", title: "x", status: "in_progress", ghIssue: 1 },
      ghIssue: 1,
      iterationNum: 1,
      iterationTotal: 1,
      issue: { title: "x", body: "y", labels: [], number: 1 },
      implementerTemplate: "TEMPLATE_BODY",
    });
    expect(prompt).toContain("Sprint memory write");
    expect(prompt).toContain(">> progress.txt");
  });
});

describe("appendProgress + readProgressTail (Fix #6)", () => {
  it("round-trips one line and reads it back via readProgressTail", async () => {
    const { appendProgress, readProgressTail } = await import(
      "../src/loop/iteration.js"
    );
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-prog-"));
    await appendProgress(tmp, "[it=1] gh-1 — kickoff");
    await appendProgress(tmp, "[it=2] gh-2 — second");
    const tail = await readProgressTail(tmp);
    expect(tail).toContain("[it=1] gh-1 — kickoff");
    expect(tail).toContain("[it=2] gh-2 — second");
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("readProgressTail returns empty string when progress.txt is missing", async () => {
    const { readProgressTail } = await import("../src/loop/iteration.js");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-prog-"));
    const tail = await readProgressTail(tmp);
    expect(tail).toBe("");
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

// ---- Wave 1 (N1 + N1b): typed verdicts MANDATORY for STORY_COMPLETE --------
//
// Background (adversarial review): the implementer's STORY_COMPLETE ship
// signal was relying on the raw stdout marker alone — a parseVerdict() failure
// silently set output=undefined and the loop shipped anyway. Plus the raw
// marker and JSON envelope marker were never cross-checked, so an envelope
// saying HALT could ship on a stdout STORY_COMPLETE. Both paths must throw
// from runImplementer so iteration.ts's existing catch (line ~621) routes to
// the recovery ladder.
//
// These tests exercise runImplementer directly (cheaper, more targeted than
// the full runLoop integration) and one runLoop test that confirms the throw
// flows into the implementer-error → recovery-ladder branch.

describe("runImplementer — Wave 1 (N1): STORY_COMPLETE requires structured envelope", () => {
  it("throws when STORY_COMPLETE marker + parseVerdict fails (invalid JSON body)", async () => {
    const { runImplementer } = await import("../src/loop/agents.js");
    const builder = mockSandboxFactory();
    builder.enqueue(
      makeRunResult({
        stdout: "{ this is not valid json }\nSTORY_COMPLETE",
        commits: [{ sha: "shipme" }],
      }),
    );
    const built = builder.build();
    setMarkerSequence(["STORY_COMPLETE"]);
    // runImplementer parses in dual mode (stream-json then plain text). Both
    // attempts hit the same broken JSON, so enqueue a throw for each leg.
    setVerdictSequence(["throw", "throw"]);

    await expect(
      runImplementer({
        sandbox: built.sandbox,
        prompt: "stub",
        config: baseConfig,
        iterationNum: 1,
        story: { id: STORY_ID_42, ghIssue: 42 },
      }),
    ).rejects.toThrow(/STORY_COMPLETE.*envelope failed to parse/);
  });

  it("throws when STORY_COMPLETE marker but no JSON envelope at all", async () => {
    const { runImplementer } = await import("../src/loop/agents.js");
    const builder = mockSandboxFactory();
    builder.enqueue(
      makeRunResult({
        stdout: "all done.\nSTORY_COMPLETE",
        commits: [{ sha: "shipme" }],
      }),
    );
    const built = builder.build();
    setMarkerSequence(["STORY_COMPLETE"]);
    // `undefined` in setVerdictSequence makes parseVerdict throw "no
    // structured payload" — same as the no-JSON-body production case. Two
    // throws cover the dual-mode (stream-json + plain text) retry pattern.
    setVerdictSequence([undefined, undefined]);

    await expect(
      runImplementer({
        sandbox: built.sandbox,
        prompt: "stub",
        config: baseConfig,
        iterationNum: 1,
        story: { id: STORY_ID_42, ghIssue: 42 },
      }),
    ).rejects.toThrow(/STORY_COMPLETE.*envelope failed to parse/);
  });

  it("throws when raw stdout marker is STORY_COMPLETE but JSON envelope's marker is HALT (markers disagree)", async () => {
    const { runImplementer } = await import("../src/loop/agents.js");
    const builder = mockSandboxFactory();
    builder.enqueue(
      makeRunResult({
        stdout:
          'BEGIN_VERDICT\n{"marker":"HALT", ...}\nEND_VERDICT\nSTORY_COMPLETE',
        commits: [{ sha: "shipme" }],
      }),
    );
    const built = builder.build();
    setMarkerSequence(["STORY_COMPLETE"]);
    // Parser succeeds but returns marker:HALT — disagreement with raw.
    setVerdictSequence([
      makeImplOutput({
        storyId: STORY_ID_42,
        ghIssue: 42,
        marker: "HALT",
        haltReason: "secretly halted",
      }),
    ]);

    await expect(
      runImplementer({
        sandbox: built.sandbox,
        prompt: "stub",
        config: baseConfig,
        iterationNum: 1,
        story: { id: STORY_ID_42, ghIssue: 42 },
      }),
    ).rejects.toThrow(/raw stdout marker.*disagrees with JSON envelope marker/);
  });

  it("regression — STORY_COMPLETE + valid matching JSON envelope still ships (returns marker + output)", async () => {
    const { runImplementer } = await import("../src/loop/agents.js");
    const builder = mockSandboxFactory();
    builder.enqueue(
      makeRunResult({
        stdout: "valid envelope\nSTORY_COMPLETE",
        commits: [{ sha: "shipok" }],
      }),
    );
    const built = builder.build();
    setMarkerSequence(["STORY_COMPLETE"]);
    const happyOutput = makeImplOutput({
      storyId: STORY_ID_42,
      ghIssue: 42,
      commitSha: "shipok",
      marker: "STORY_COMPLETE",
    });
    setVerdictSequence([happyOutput]);

    const r = await runImplementer({
      sandbox: built.sandbox,
      prompt: "stub",
      config: baseConfig,
      iterationNum: 1,
      story: { id: STORY_ID_42, ghIssue: 42 },
    });
    expect(r.marker).toBe("STORY_COMPLETE");
    expect(r.output).toEqual(happyOutput);
  });

  it("regression — HALT marker with no JSON envelope keeps soft fallback (output=undefined)", async () => {
    const { runImplementer } = await import("../src/loop/agents.js");
    const builder = mockSandboxFactory();
    builder.enqueue(
      makeRunResult({
        stdout: "couldn't proceed\n<promise>HALT</promise>",
      }),
    );
    const built = builder.build();
    setMarkerSequence(["HALT"]);
    // Dual-mode parser: two throws (stream-json + plain text) so both legs
    // miss, leaving output=undefined per the HALT soft-fallback contract.
    setVerdictSequence([undefined, undefined]);

    const r = await runImplementer({
      sandbox: built.sandbox,
      prompt: "stub",
      config: baseConfig,
      iterationNum: 1,
      story: { id: STORY_ID_42, ghIssue: 42 },
    });
    expect(r.marker).toBe("HALT");
    expect(r.output).toBeUndefined();
  });

  it("regression — non-STORY_COMPLETE marker + parse failure stays soft (RECOVERY_COMPLETE / future NEEDS_HELP path)", async () => {
    // The current IMPLEMENTER_MARKERS set is {STORY_COMPLETE, HALT,
    // RECOVERY_COMPLETE}. RECOVERY_COMPLETE represents the "implementer
    // recovered after a prior crash" case the spec calls out as a soft
    // path — parse failure must not throw here. (If a future NEEDS_HELP
    // marker is added it inherits the same soft-fallback contract.)
    const { runImplementer } = await import("../src/loop/agents.js");
    const builder = mockSandboxFactory();
    builder.enqueue(
      makeRunResult({
        stdout: "no envelope here\nRECOVERY_COMPLETE",
      }),
    );
    const built = builder.build();
    setMarkerSequence(["RECOVERY_COMPLETE"]);
    // Dual-mode parser: two throws (stream-json + plain text).
    setVerdictSequence([undefined, undefined]);

    const r = await runImplementer({
      sandbox: built.sandbox,
      prompt: "stub",
      config: baseConfig,
      iterationNum: 1,
      story: { id: STORY_ID_42, ghIssue: 42 },
    });
    expect(r.marker).toBe("RECOVERY_COMPLETE");
    expect(r.output).toBeUndefined();
  });
});

describe("runLoop — Wave 1 (N1): runImplementer throw routes into recovery ladder", () => {
  it("STORY_COMPLETE + invalid JSON envelope throws inside runImplementer → caught at iteration.ts → recovery dispatched", async () => {
    const builder = mockSandboxFactory();
    // The implementer's sandbox.run produces a STORY_COMPLETE marker but
    // the parseVerdict mock will throw — so runImplementer rejects, the
    // catch in iteration.ts at L621 sets implementerError, and we expect
    // runRecoveryDiagnosisOrEscalate to fire. We make recovery HALT so
    // the iteration outcome is `halted` (matches the existing
    // implementer-error path test on L645).
    builder.enqueue(
      makeRunResult({
        stdout: "{ broken json }\nSTORY_COMPLETE",
        commits: [{ sha: "ghost" }],
      }),
    );
    const built = builder.build();

    setMarkerSequence(["STORY_COMPLETE"]);
    // Dual-mode parser: both legs throw, so STORY_COMPLETE branch raises.
    setVerdictSequence(["throw", "throw"]);

    runRecoveryDiagnosisOrEscalate.mockResolvedValueOnce({
      decision: {
        marker: "HALT",
        fixApplied: false,
        haltReason: "recovery decided to halt after parse-fail",
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
      _listInProgressIssues: async () => [],
    });

    expect(results).toHaveLength(1);
    expect(results[0].outcome).toBe("halted");
    expect(runRecoveryDiagnosisOrEscalate).toHaveBeenCalledTimes(1);
    // Confirm the recovery reason carries the parse-fail message — proves
    // the throw payload survived the catch.
    const recoveryArgs = runRecoveryDiagnosisOrEscalate.mock.calls[0];
    expect(recoveryArgs[2].reason).toMatch(/envelope failed to parse/);
    expect(recoveryArgs[2].priorWho).toBe("implementer");
    // Critically: markDoneViaLabel must NOT have been called — the loop
    // did not silently ship on the raw marker.
    expect(markDoneViaLabel).not.toHaveBeenCalled();
  });
});
