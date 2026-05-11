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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  runMain,
  parsePlan,
  parseRalphArgs,
  loadDotenv,
  isTransientServerError,
  type Deps,
  type RalphArgs,
  type SandboxRunSpec,
  type TopLevelRunSpec,
  type CreateSandboxSpec,
  type RunHandle,
  type SandboxHandle,
} from "../.sandcastle/main.mjs";
import { envForModel } from "../.sandcastle/providers.js";

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
  releases: { issueNum: number; reason: string }[];
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
    releases: [],
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
    async markMergedToStaging(_n) {
      // no-op for legacy tests; staging-aware tests can override.
    },
    async promoteStagingToDone(_ns, _summary) {
      // no-op for legacy tests; staging-aware tests can override.
      return { failed: [] };
    },
    async quarantine(n, reason) {
      state.quarantines.push({ issueNum: n, reason });
    },
    async release(n, reason) {
      state.releases.push({ issueNum: n, reason });
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
    imageName: "sandcastle:affinity-tracker",
    plannerModel: "claude-opus-4-7",
    implementerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-haiku-4-5",
    mergerModel: "claude-opus-4-7",
    postMergeReviewerModel: "claude-opus-4-7",
    recoveryModel: "claude-opus-4-7",
    implementerTimeoutSec: 1200,
    reviewerTimeoutSec: 600,
    consecutiveFailureLimit: 3,
    dryRun: false,
    recoveryEnabled: true,
    retryEnabled: true,
    stagingEnabled: true,
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
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    // After the first successful cycle the orchestrator loops; we want it
    // to exit 0 ("no claimable") on iteration 2 — enqueue an empty plan.
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

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
      "post-merge-reviewer",
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

describe("sandcastle-loop main.mts — reviewer + error paths (no ladder)", () => {
  it("reviewer HAS_BLOCKERS quarantines the issue, no markDone", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "100", title: "x", branch: "agent/issue-100" }]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 100 }),
      commits: [{ sha: "c1" }],
    });
    b.enqueue("reviewer", { stdout: "Found a bug.\nHAS_BLOCKERS" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 2 }), b.deps);

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([]);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(100);
    expect(b.state.marksDone).toEqual([]);
  });

  it("implementer error quarantines the issue (no recovery ladder)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "300", title: "z", branch: "agent/issue-300" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 2 }), b.deps);

    expect(result.exitCode).toBe(0);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(300);
    expect(b.state.marksDone).toEqual([]);
  });

  it("rate-limit error defers the issue (release, no quarantine)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "400", title: "rl", branch: "agent/issue-400" }]),
    });
    const rl = () =>
      new Error('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}');
    // First implementer attempt rate-limits; runWithRateLimitFallback retries
    // on the escalation model — that also rate-limits and the pipeline catch
    // deferral fires.
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.releases).toHaveLength(1);
    expect(b.state.releases[0]!.issueNum).toBe(400);
    expect(b.state.releases[0]!.reason).toMatch(/sandcastle-defer/);
    expect(b.state.releases[0]!.reason).toMatch(/attempt 1\/3/);
  });

  it("rate-limit deferrals are bounded by MAX_DEFERRALS — 4th hit quarantines", async () => {
    const b = buildDeps();
    const rlError = () => new Error('API Error: 429 rate_limit_error');
    // 4 iterations, each plans the same issue, each rate-limits.
    // 4 iterations × 2 implementer calls each (primary + fallback both 429).
    for (let i = 0; i < 4; i++) {
      b.enqueue("planner", {
        stdout: plannerStdout([{ id: "401", title: "rl-bounded", branch: "agent/issue-401" }]),
      });
      b.enqueue("implementer", { stdout: "", throw: rlError() });
      b.enqueue("implementer", { stdout: "", throw: rlError() });
    }
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 5, recoveryEnabled: false, consecutiveFailureLimit: 99 }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.releases).toHaveLength(3);
    expect(b.state.releases.every((r) => r.issueNum === 401)).toBe(true);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(401);
  });

  it("ships when implementer stdout is plain assistant text (no stream-json wrapper)", async () => {
    // Regression for the 2026-05-08 smoke-test bug: sandcastle's r.stdout is
    // the parsed `result.result` from claude's final stream event, which is
    // already-extracted assistant text — there are no `{type:"assistant"}`
    // envelopes to walk. Without the dual-mode try in runImplementer, every
    // real overnight run threw "no assistant text could be extracted" and
    // bounced through recovery, doubling Opus spend. This test enqueues that
    // exact prod shape and asserts the issue ships normally.
    const envelope = {
      storyId: "gh-71",
      ghIssue: 71,
      e2eVerdict: "passed",
      uiTouched: false,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
      storyType: "backend-only",
      e2eRequired: false,
      e2eActuallyRan: true,
      testCommandUsed: "pnpm test",
      e2eAssertionLine: "✓ does the thing",
      outputNotFiltered: true,
      testReachedFeature: true,
    };
    const plainAssistantText =
      "Here is the verdict:\n" +
      JSON.stringify(envelope, null, 2) +
      "\n\nSTORY_COMPLETE";

    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "71", title: "smoke", branch: "agent/issue-71" }]),
    });
    b.enqueue("implementer", {
      stdout: plainAssistantText,
      commits: [{ sha: "abc123" }],
    });
    b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    // Disable recovery so a parser failure manifests as a quarantine
    // (clean assertion target) rather than a missing-mock error from a
    // stray recovery call.
    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([71]);
    expect(b.state.quarantines).toEqual([]);
    const recoveryCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "recovery",
    );
    expect(recoveryCalls).toEqual([]);
  });

  it("--recovery on: implementer error → recovery RECOVERY_COMPLETE → markDone (no quarantine)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "71", title: "recover", branch: "agent/issue-71" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("recovery", { stdout: "fixed it up\n\nRECOVERY_COMPLETE" });
    b.enqueue("planner", { stdout: plannerStdout([]) });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });

    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: true, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([71]);
    expect(b.state.marksDone).toHaveLength(1);
    expect(b.state.marksDone[0]!.issueNum).toBe(71);
    expect(b.state.quarantines).toEqual([]);
    // Confirm the recovery run happened against the sandbox.
    const recoveryCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "recovery",
    );
    expect(recoveryCalls).toHaveLength(1);
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
    expect(r.args.implementerModel).toBe("kimi-for-coding");
    expect(r.args.reviewerModel).toBe("kimi-for-coding");
    expect(r.args.recoveryModel).toBe("claude-opus-4-7");
    expect(r.args.recoveryEnabled).toBe(true);
    expect(r.args.consecutiveFailureLimit).toBe(3);
  });
});

describe("sandcastle-loop main.mts — loadDotenv chain", () => {
  // The chain (first hit per-key wins, lower fills gaps):
  //   1. process.env  2. $SANDCASTLE_ENV_FILE  3. <repoRoot>/.env
  //   4. $XDG_CONFIG_HOME/sandcastle/.env or ~/.config/sandcastle/.env

  function withTempDirs(fn: (dirs: {
    repoRoot: string;
    xdg: string;
    explicit: string;
  }) => void): void {
    const tmp = mkdtempSync(path.join(tmpdir(), "sc-env-"));
    const repoRoot = path.join(tmp, "repo");
    const xdg = path.join(tmp, "xdg");
    const explicitDir = path.join(tmp, "explicit");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(path.join(xdg, "sandcastle"), { recursive: true });
    mkdirSync(explicitDir, { recursive: true });
    const explicit = path.join(explicitDir, "explicit.env");

    const savedKeys = [
      "KIMI_API_KEY",
      "GLM_API_KEY",
      "ANTHROPIC_API_KEY",
      "GH_TOKEN",
      "XDG_CONFIG_HOME",
      "SANDCASTLE_ENV_FILE",
    ] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of savedKeys) saved[k] = process.env[k];

    try {
      for (const k of savedKeys) delete process.env[k];
      process.env.XDG_CONFIG_HOME = xdg;
      fn({ repoRoot, xdg, explicit });
    } finally {
      for (const k of savedKeys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("loads from host-level file when no project .env", () => {
    withTempDirs(({ repoRoot, xdg }) => {
      writeFileSync(
        path.join(xdg, "sandcastle", ".env"),
        "KIMI_API_KEY=from-host\n",
      );
      loadDotenv(repoRoot);
      expect(process.env.KIMI_API_KEY).toBe("from-host");
    });
  });

  it("project .env overrides host-level for same key", () => {
    withTempDirs(({ repoRoot, xdg }) => {
      writeFileSync(
        path.join(xdg, "sandcastle", ".env"),
        "KIMI_API_KEY=from-host\n",
      );
      writeFileSync(path.join(repoRoot, ".env"), "KIMI_API_KEY=from-project\n");
      loadDotenv(repoRoot);
      expect(process.env.KIMI_API_KEY).toBe("from-project");
    });
  });

  it("merges keys across sources when they don't conflict", () => {
    withTempDirs(({ repoRoot, xdg }) => {
      writeFileSync(
        path.join(xdg, "sandcastle", ".env"),
        "KIMI_API_KEY=from-host\n",
      );
      writeFileSync(path.join(repoRoot, ".env"), "GH_TOKEN=from-project\n");
      loadDotenv(repoRoot);
      expect(process.env.KIMI_API_KEY).toBe("from-host");
      expect(process.env.GH_TOKEN).toBe("from-project");
    });
  });

  it("pre-set process.env wins over every file", () => {
    withTempDirs(({ repoRoot, xdg }) => {
      process.env.KIMI_API_KEY = "from-shell";
      writeFileSync(
        path.join(xdg, "sandcastle", ".env"),
        "KIMI_API_KEY=from-host\n",
      );
      writeFileSync(path.join(repoRoot, ".env"), "KIMI_API_KEY=from-project\n");
      loadDotenv(repoRoot);
      expect(process.env.KIMI_API_KEY).toBe("from-shell");
    });
  });

  it("$SANDCASTLE_ENV_FILE wins over both project and host files", () => {
    withTempDirs(({ repoRoot, xdg, explicit }) => {
      writeFileSync(
        path.join(xdg, "sandcastle", ".env"),
        "KIMI_API_KEY=from-host\n",
      );
      writeFileSync(path.join(repoRoot, ".env"), "KIMI_API_KEY=from-project\n");
      writeFileSync(explicit, "KIMI_API_KEY=from-explicit\n");
      process.env.SANDCASTLE_ENV_FILE = explicit;
      loadDotenv(repoRoot);
      expect(process.env.KIMI_API_KEY).toBe("from-explicit");
    });
  });

  it("silently no-ops when no files exist and no env vars set", () => {
    withTempDirs(({ repoRoot }) => {
      expect(() => loadDotenv(repoRoot)).not.toThrow();
      expect(process.env.KIMI_API_KEY).toBeUndefined();
    });
  });
});

describe("sandcastle-loop — provider env injection (SDK workaround)", () => {
  // Verifies the fix for the SDK bug where createSandbox hardcodes
  // agentProviderEnv: {}, dropping per-call env. We bake the implementer's
  // provider env into sandbox.env at sandbox-creation time instead.

  it("envForModel returns ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY for kimi", () => {
    const saved = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = "test-kimi-key";
    try {
      const env = envForModel("kimi-for-coding");
      expect(env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");
      expect(env.ANTHROPIC_API_KEY).toBe("test-kimi-key");
    } finally {
      if (saved === undefined) delete process.env.KIMI_API_KEY;
      else process.env.KIMI_API_KEY = saved;
    }
  });

  it("envForModel returns empty bag for anthropic models (subscription path)", () => {
    const env = envForModel("claude-sonnet-4-6");
    expect(env).toEqual({});
  });

  it("envForModel throws when kimi key missing — fails loudly at startup", () => {
    const saved = process.env.KIMI_API_KEY;
    delete process.env.KIMI_API_KEY;
    try {
      expect(() => envForModel("kimi-for-coding")).toThrow(/KIMI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.KIMI_API_KEY = saved;
    }
  });

  it("runIssuePipeline forwards implementerModel into the sandbox spec", async () => {
    // The bug fix's effect: createSandbox now needs the implementer model
    // so it can compute the right provider env. This test asserts the
    // caller (runIssuePipeline) actually threads it through.
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: `<plan>${JSON.stringify({
        issues: [{ id: "71", title: "smoke", branch: "agent/issue-71" }],
      })}</plan>`,
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 71 }),
      commits: [{ sha: "abc123" }],
    });
    b.enqueue("reviewer", { stdout: "ALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    b.enqueue("planner", { stdout: `<plan>${JSON.stringify({ issues: [] })}</plan>` });

    await runMain(
      baseArgs({
        iterations: 2,
        stagingEnabled: false,
        implementerModel: "kimi-for-coding",
      }),
      b.deps,
    );

    expect(b.state.sandboxesCreated).toHaveLength(1);
    expect(b.state.sandboxesCreated[0]!.implementerModel).toBe(
      "kimi-for-coding",
    );
  });
});

describe("sandcastle-loop — transient-error defer on recovery throw", () => {
  // The bug: when the recovery agent throws a transient upstream 5xx
  // (Anthropic "The server had an error"), the orchestrator used to
  // quarantine. Now it defers, bounded by MAX_DEFERRALS=3.

  it("isTransientServerError matches common 5xx shapes", () => {
    const positive = [
      "API Error: The server had an error while processing your request",
      "529 overloaded",
      "503 Service Unavailable",
      "Bad Gateway 502",
      "Gateway Timeout 504",
      "500 Internal Server Error",
      '{"type":"error","error":{"type":"overloaded_error"}}',
      '{"type":"error","error":{"type":"api_error","message":"oops"}}',
    ];
    for (const msg of positive) {
      expect(isTransientServerError(msg)).toBe(true);
    }
    const negative = [
      "invalid_api_key",
      "model_not_found",
      "authentication_error",
      "permission_error",
      "not_found_error",
      "agent crashed",
      "implementer made no commits",
    ];
    for (const msg of negative) {
      expect(isTransientServerError(msg)).toBe(false);
    }
  });

  it("recovery throws transient 5xx → defers (release, no quarantine)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "500", title: "rec-5xx", branch: "agent/issue-500" }]),
    });
    // Implementer throws a non-transient error so the pipeline runs recovery.
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    // Recovery itself throws an Anthropic 5xx. Pipeline should defer.
    b.enqueue("recovery", {
      stdout: "",
      throw: new Error("API Error: The server had an error while processing your request"),
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: true }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.releases).toHaveLength(1);
    expect(b.state.releases[0]!.issueNum).toBe(500);
    expect(b.state.releases[0]!.reason).toMatch(/recovery threw transient/);
    expect(b.state.releases[0]!.reason).toMatch(/attempt 1\/3/);
  });

  it("recovery throws non-transient → still quarantines (existing behavior preserved)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "501", title: "rec-perm", branch: "agent/issue-501" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    // Recovery throws a permanent error (auth) — should not defer.
    b.enqueue("recovery", {
      stdout: "",
      throw: new Error("authentication_error: bad key"),
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: true }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.releases).toEqual([]);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(501);
  });
});
