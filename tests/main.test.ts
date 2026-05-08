/**
 * Smoke harness for `.sandcastle/main.mts`.
 *
 * Drives the orchestrator's `runMain` directly, with a hand-built {@link Deps}
 * stub. We never call sandcastle.run / sandcastle.createSandbox / gh — every
 * external side effect is captured in arrays the assertions read.
 *
 * Coverage targets (Wave 6.1 Agent B):
 *   1. Happy path: planner emits one issue → claim → implementer + reviewer
 *      → ALL_CLEAR → markDone.
 *   2. Reviewer ladder: HAS_BLOCKERS on first review → fixer (sonnet) →
 *      ALL_CLEAR on re-review.
 *   3. Reviewer ladder escalation: HAS_BLOCKERS persists past sonnet fix →
 *      fixer (opus) → final-review ALL_CLEAR.
 *   4. Implementer error → recovery-sonnet RECOVERY_COMPLETE → markDone fires.
 *   5. Implementer error → recovery-sonnet HALT → recovery-opus
 *      RECOVERY_COMPLETE → markDone fires.
 *   6. Implementer error → recovery ladder both HALT → quarantine fires.
 *   7. Three consecutive quarantines → circuit breaker trips, comment posted
 *      on last failing issue, exitCode 1.
 *   8. parsePlan: empty issues array → exitCode 0 (no claimable stories).
 *   9. One-shot --issue mode: planner is skipped entirely.
 *  10. parsePlan: malformed input throws.
 */

import { describe, it, expect } from "vitest";
import {
  runMain,
  parsePlan,
  parseRalphArgs,
  type Deps,
  type RalphArgs,
  type SandboxRunSpec,
  type TopLevelRunSpec,
  type CreateSandboxSpec,
  type RunHandle,
  type SandboxHandle,
} from "../.sandcastle/main.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunCall {
  readonly kind: "top-level";
  readonly spec: TopLevelRunSpec;
}
interface SandboxRunCall {
  readonly kind: "sandbox";
  readonly branch: string;
  readonly spec: SandboxRunSpec;
}
type AnyRunCall = RunCall | SandboxRunCall;

interface MockState {
  runCalls: AnyRunCall[];
  sandboxesCreated: CreateSandboxSpec[];
  sandboxesClosed: number;
  claims: number[];
  marksDone: { issueNum: number; summary: string }[];
  quarantines: { issueNum: number; reason: string }[];
  comments: { issueNum: number; body: string }[];
  migrationsCalls: { repoRoot: string; preSha: string; postSha: string }[];
  logs: string[];
  errors: string[];
}

function newState(): MockState {
  return {
    runCalls: [],
    sandboxesCreated: [],
    sandboxesClosed: 0,
    claims: [],
    marksDone: [],
    quarantines: [],
    comments: [],
    migrationsCalls: [],
    logs: [],
    errors: [],
  };
}

/**
 * Build a deps stub. The caller passes a queue of canned `RunHandle` outcomes
 * keyed by run-name (e.g. "planner", "implementer", "reviewer"). The next
 * call with that name pops the next outcome from the queue. If a name is
 * missing or exhausted the harness throws so test authors notice.
 */
interface RunOutcome {
  readonly stdout: string;
  readonly commits?: readonly { sha: string }[];
  readonly throw?: Error;
}

interface DepsBuilder {
  readonly state: MockState;
  readonly deps: Deps;
  /** Queue an outcome under a name. Pops in FIFO order on each match. */
  enqueue(name: string, outcome: RunOutcome): void;
}

function buildDeps(opts: {
  /** Sequence of SHAs to return from captureSha. Cycles if exhausted. */
  shas?: readonly string[];
  /** If true, applyMigrations always reports realErrors[0]. */
  migrationsFail?: boolean;
} = {}): DepsBuilder {
  const state = newState();
  const queues = new Map<string, RunOutcome[]>();
  const shas = opts.shas ?? ["sha-pre", "sha-post"];
  let shaIdx = 0;

  const popOutcome = (name: string): RunOutcome => {
    const q = queues.get(name);
    if (!q || q.length === 0) {
      throw new Error(
        `mock deps: no queued outcome for run name=${name}; enqueue one with builder.enqueue("${name}", ...)`,
      );
    }
    return q.shift()!;
  };

  const handleOutcome = (name: string, outcome: RunOutcome): RunHandle => {
    if (outcome.throw) throw outcome.throw;
    return { stdout: outcome.stdout, commits: outcome.commits ?? [] };
  };

  const deps: Deps = {
    async run(spec: TopLevelRunSpec): Promise<RunHandle> {
      state.runCalls.push({ kind: "top-level", spec });
      const out = popOutcome(spec.name);
      return handleOutcome(spec.name, out);
    },
    async createSandbox(spec: CreateSandboxSpec): Promise<SandboxHandle> {
      state.sandboxesCreated.push(spec);
      const branch = spec.branch;
      const handle: SandboxHandle = {
        branch,
        worktreePath: "/mock/worktree",
        async run(opts: SandboxRunSpec): Promise<RunHandle> {
          state.runCalls.push({ kind: "sandbox", branch, spec: opts });
          const out = popOutcome(opts.name);
          return handleOutcome(opts.name, out);
        },
        async close() {
          state.sandboxesClosed += 1;
          return {};
        },
      };
      return handle;
    },
    async claim(n) {
      state.claims.push(n);
    },
    async markDone(n, summary) {
      state.marksDone.push({ issueNum: n, summary });
    },
    async quarantine(n, reason) {
      state.quarantines.push({ issueNum: n, reason });
    },
    async comment(n, body) {
      state.comments.push({ issueNum: n, body });
    },
    async applyMigrations(repoRoot, preSha, postSha) {
      state.migrationsCalls.push({ repoRoot, preSha, postSha });
      if (opts.migrationsFail) {
        return { applied: 0, realErrors: [{ msg: "fake migration failure" }] };
      }
      return { applied: 0, realErrors: [] };
    },
    async captureSha(_w) {
      const v = shas[shaIdx % shas.length] ?? "sha-x";
      shaIdx += 1;
      return v;
    },
    log(line) {
      state.logs.push(line);
    },
    logError(line) {
      state.errors.push(line);
    },
  };

  return {
    state,
    deps,
    enqueue(name, outcome) {
      const q = queues.get(name) ?? [];
      q.push(outcome);
      queues.set(name, q);
    },
  };
}

function baseArgs(over: Partial<RalphArgs> = {}): RalphArgs {
  return {
    iterations: 1,
    repoRoot: "/repo",
    branch: "feature/work",
    label: "ready-for-agent",
    maxConcurrent: 3,
    imageName: "sandcastle:loop",
    implementerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-haiku-4-5",
    fixerModel: "claude-sonnet-4-6",
    recoveryModel: "claude-sonnet-4-6",
    recoveryEscalatedModel: "claude-opus-4-7",
    implementerTimeoutSec: 1200,
    reviewerTimeoutSec: 600,
    fixerTimeoutSec: 900,
    recoveryTimeoutSec: 1800,
    consecutiveFailureLimit: 3,
    dryRun: false,
    ...over,
  };
}

/**
 * Build a valid implementer envelope wrapped in stream-json so parseVerdict
 * accepts it. The marker on the last line drives extractMarker; the JSON in
 * the assistant text drives ImplementerOutputSchema.
 */
function implementerStdout(opts: {
  ghIssue: number;
  storyId?: string;
  marker?: "STORY_COMPLETE" | "HALT" | "RECOVERY_COMPLETE";
} = { ghIssue: 71 }): string {
  const marker = opts.marker ?? "STORY_COMPLETE";
  const isHalt = marker === "HALT";
  const envelope = {
    storyId: opts.storyId ?? `gh-${opts.ghIssue}`,
    ghIssue: opts.ghIssue,
    e2eVerdict: isHalt ? "halted" : "passed",
    uiTouched: false,
    certificationPresent: !isHalt,
    marker,
    storyType: "backend-only",
    e2eRequired: false,
    e2eActuallyRan: !isHalt,
    testCommandUsed: isHalt ? null : "pnpm test",
    e2eAssertionLine: isHalt ? null : "✓ does the thing",
    outputNotFiltered: true,
    testReachedFeature: !isHalt,
  };
  // Pack as a stream-json line so parseVerdict's extractAssistantText picks
  // it up out of the (synthetic) "assistant" envelope.
  const assistantText =
    "Here is the verdict:\n" +
    JSON.stringify(envelope, null, 2) +
    `\n\n${marker}`;
  const streamLine = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: assistantText }] },
  });
  return streamLine + "\n";
}

function plannerStdout(issues: { id: string; title: string; branch: string }[]): string {
  return `<plan>${JSON.stringify({ issues })}</plan>`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sandcastle-loop main.mts — happy path", () => {
  it("ships a single issue: planner → claim → implementer → review ALL_CLEAR → markDone", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "71", title: "smoke", branch: "agent/issue-71" }]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 71 }),
      commits: [{ sha: "abc123" }],
    });
    b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    // After the first successful cycle the orchestrator loops; we want it
    // to exit 0 ("no claimable") on iteration 2 — enqueue an empty plan.
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 2 }), b.deps);

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([71]);
    expect(b.state.claims).toEqual([71]);
    expect(b.state.marksDone).toHaveLength(1);
    expect(b.state.marksDone[0]!.issueNum).toBe(71);
    expect(b.state.quarantines).toEqual([]);
    // sandbox.close() must run.
    expect(b.state.sandboxesClosed).toBe(1);
    // Run order: planner (top-level) → implementer (sandbox) → reviewer
    // (sandbox) → merger (top-level) → planner (cycle 2, returns empty).
    const names = b.state.runCalls.map((c) => c.spec.name);
    expect(names).toEqual([
      "planner",
      "implementer",
      "reviewer",
      "merger",
      "planner",
    ]);
  });

  it("returns exitCode 0 immediately when planner emits an empty issues array", async () => {
    const b = buildDeps();
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs(), b.deps);

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([]);
    expect(b.state.claims).toEqual([]);
    expect(b.state.marksDone).toEqual([]);
    // No sandbox should ever be created when there's nothing to plan.
    expect(b.state.sandboxesCreated).toEqual([]);
  });
});

describe("sandcastle-loop main.mts — reviewer ladder", () => {
  it("fixer-sonnet then re-review ALL_CLEAR ships the issue", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "100", title: "x", branch: "agent/issue-100" }]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 100 }),
      commits: [{ sha: "c1" }],
    });
    b.enqueue("reviewer", { stdout: "Found a bug.\nHAS_BLOCKERS" });
    b.enqueue("fixer", {
      stdout: "fixed",
      commits: [{ sha: "c2" }],
    });
    b.enqueue("reviewer", { stdout: "Looks good now.\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 2 }), b.deps);

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([100]);
    expect(b.state.marksDone).toHaveLength(1);
    // Run order includes the fixer + second reviewer.
    const names = b.state.runCalls.map((c) => c.spec.name);
    expect(names).toEqual([
      "planner",
      "implementer",
      "reviewer",
      "fixer",
      "reviewer",
      "merger",
      "planner",
    ]);
  });

  it("escalates to fixer-opus + final-review when sonnet fix doesn't clear", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "200", title: "y", branch: "agent/issue-200" }]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 200 }),
      commits: [{ sha: "c1" }],
    });
    b.enqueue("reviewer", { stdout: "Bug.\nHAS_BLOCKERS" });
    b.enqueue("fixer", { stdout: "first try\nFIXED", commits: [{ sha: "c2" }] });
    b.enqueue("reviewer", { stdout: "still bad\nHAS_BLOCKERS" });
    b.enqueue("fixer", {
      stdout: "second try\nFIXED",
      commits: [{ sha: "c3" }],
    });
    b.enqueue("reviewer", { stdout: "now good\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 2 }), b.deps);

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([200]);
    // The escalated fixer+reviewer use opus; check the second fixer's model.
    const fixerCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "fixer",
    );
    expect(fixerCalls).toHaveLength(2);
    expect(fixerCalls[0]!.spec.model).toBe("claude-sonnet-4-6");
    expect(fixerCalls[1]!.spec.model).toBe("claude-opus-4-7");
    // Final-review prompt must be referenced for at least one of the
    // post-opus reviewer passes.
    const reviewerCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "reviewer",
    );
    expect(reviewerCalls.length).toBe(3);
    expect(reviewerCalls[2]!.spec.promptFile).toBe(
      "./.sandcastle/final-review-prompt.md",
    );
  });
});

describe("sandcastle-loop main.mts — recovery ladder", () => {
  it("implementer error → recovery-sonnet RECOVERY_COMPLETE → markDone, no quarantine", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "300", title: "z", branch: "agent/issue-300" }]),
    });
    // Implementer crashes — a sandbox.run() that throws.
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("recovery", { stdout: "fixed by recovery\nRECOVERY_COMPLETE" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 2 }), b.deps);

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([300]);
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.marksDone).toHaveLength(1);
    // Recovery is a TOP-LEVEL run (not sandbox) per the orchestrator's design.
    const recoveryCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "recovery",
    );
    expect(recoveryCalls).toHaveLength(1);
    expect(recoveryCalls[0]!.kind).toBe("top-level");
  });

  it("implementer error → recovery-sonnet HALT → recovery-opus RECOVERY_COMPLETE → markDone", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "400", title: "w", branch: "agent/issue-400" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("recovery", { stdout: "give up\nHALT" });
    b.enqueue("recovery", {
      stdout: "rescued by opus\nRECOVERY_COMPLETE",
    });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 2 }), b.deps);

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([400]);
    expect(b.state.quarantines).toEqual([]);
    const recoveryCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "recovery",
    );
    expect(recoveryCalls).toHaveLength(2);
    expect(recoveryCalls[0]!.spec.model).toBe("claude-sonnet-4-6");
    expect(recoveryCalls[1]!.spec.model).toBe("claude-opus-4-7");
  });

  it("implementer error + both recovery passes HALT → quarantine fires, no markDone", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "500", title: "v", branch: "agent/issue-500" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("recovery", { stdout: "give up\nHALT" });
    b.enqueue("recovery", { stdout: "give up too\nHALT" });
    // No second planner — quarantine bumps consecutiveFailures, but with
    // limit 3 (default) and 1 fail, the loop continues to iteration 2.
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 2 }), b.deps);

    expect(result.exitCode).toBe(0);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(500);
    expect(b.state.marksDone).toEqual([]);
    expect(result.shippedIssues).toEqual([]);
  });
});

describe("sandcastle-loop main.mts — circuit breaker", () => {
  it("trips after consecutive-failure-limit quarantines, posts comment on last failing issue, exits 1", async () => {
    const b = buildDeps();
    // One iteration with three concurrent issues, all of which quarantine.
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "601", title: "a", branch: "agent/issue-601" },
        { id: "602", title: "b", branch: "agent/issue-602" },
        { id: "603", title: "c", branch: "agent/issue-603" },
      ]),
    });
    // Each issue: implementer throws, both recovery passes HALT.
    for (let i = 0; i < 3; i++) {
      b.enqueue("implementer", {
        stdout: "",
        throw: new Error(`issue boom ${i}`),
      });
      b.enqueue("recovery", { stdout: "give up\nHALT" });
      b.enqueue("recovery", { stdout: "give up too\nHALT" });
    }

    const result = await runMain(
      baseArgs({ consecutiveFailureLimit: 3 }),
      b.deps,
    );

    expect(result.exitCode).toBe(1);
    expect(b.state.quarantines).toHaveLength(3);
    expect(b.state.comments).toHaveLength(1);
    // The breaker posts on whichever issue tripped it (last-failing). We
    // only assert it's one of the three planned ids — concurrent ordering
    // is not deterministic.
    const tripped = b.state.comments[0]!.issueNum;
    expect([601, 602, 603]).toContain(tripped);
    expect(b.state.comments[0]!.body).toMatch(/circuit breaker tripped/i);
  });
});

describe("sandcastle-loop main.mts — one-shot --issue mode", () => {
  it("skips the planner and uses the supplied issue number directly", async () => {
    const b = buildDeps();
    // No planner enqueued — if the orchestrator calls planner the popOutcome
    // helper will throw and the test fails with a helpful message.
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 71 }),
      commits: [{ sha: "abc" }],
    });
    b.enqueue("reviewer", { stdout: "good\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    // One-shot mode replays the same fixed plan every iteration. Cap at 1
    // to avoid running it again — and accept exitCode 2 (out of cycles)
    // which is the documented "still ran fine, just time's up" outcome.
    const result = await runMain(baseArgs({ issue: 71, iterations: 1 }), b.deps);

    expect(result.exitCode).toBe(2);
    expect(result.shippedIssues).toEqual([71]);
    // Confirm no top-level "planner" call landed.
    const plannerCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "planner",
    );
    expect(plannerCalls).toHaveLength(0);
    expect(b.state.claims).toEqual([71]);
  });
});

describe("sandcastle-loop main.mts — parsePlan", () => {
  it("parses a well-formed plan", () => {
    const issues = parsePlan(
      `<plan>{"issues":[{"id":"42","title":"hi","branch":"agent/x"}]}</plan>`,
    );
    expect(issues).toEqual([
      { id: "42", title: "hi", branch: "agent/x" },
    ]);
  });

  it("throws if the <plan> tag is missing", () => {
    expect(() => parsePlan("no plan here")).toThrow(/<plan>/);
  });

  it("throws on malformed JSON in <plan>", () => {
    expect(() => parsePlan("<plan>not json</plan>")).toThrow(
      /JSON.parse failed/,
    );
  });

  it("throws if issues is not an array", () => {
    expect(() => parsePlan(`<plan>{"issues":"oops"}</plan>`)).toThrow(
      /'issues' array/,
    );
  });
});

describe("sandcastle-loop main.mts — parseRalphArgs", () => {
  it("--help sets showHelp", () => {
    const r = parseRalphArgs(["--help"]);
    expect(r.showHelp).toBe(true);
  });

  it("requires --iterations", () => {
    expect(() => parseRalphArgs([])).toThrow(/--iterations/);
  });

  it("rejects non-integer --iterations", () => {
    expect(() => parseRalphArgs(["--iterations", "0"])).toThrow();
  });

  it("parses defaults for unspecified flags", () => {
    const r = parseRalphArgs(["--iterations", "3"]);
    expect(r.showHelp).toBe(false);
    expect(r.args.iterations).toBe(3);
    expect(r.args.maxConcurrent).toBe(3);
    expect(r.args.implementerModel).toBe("claude-sonnet-4-6");
    expect(r.args.reviewerModel).toBe("claude-haiku-4-5");
    expect(r.args.recoveryEscalatedModel).toBe("claude-opus-4-7");
    expect(r.args.consecutiveFailureLimit).toBe(3);
  });
});
