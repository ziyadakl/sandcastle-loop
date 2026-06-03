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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  runMain,
  runImplementer,
  parsePlan,
  parseBlockedBy,
  buildBlockedByNote,
  parseSandcastleArgs,
  preflight,
  loadDotenv,
  isTransientServerError,
  ensureStagingWorktree,
  fastForwardIntegration,
  detectChangedLockfiles,
  parseWorktreeList,
  serializeDotenv,
  extractCategorySweep,
  priorFindingsResolved,
  WRITE_PROJECT_DOTENV_COMMAND,
  __resetTransientStateForTests,
  type Deps,
  type SandcastleArgs,
  type SandboxRunSpec,
  type TopLevelRunSpec,
  type CreateSandboxSpec,
  type RunHandle,
  type SandboxHandle,
  type PlanIssue,
} from "../.sandcastle/main.mjs";
import {
  MissingRequiredSkillsError,
  validateRequiredSkillsInvoked,
} from "../.sandcastle/lib/skill-discipline.js";
import { envForModel } from "../.sandcastle/providers.js";
import { parse as parseDotenv } from "dotenv";
import { expand as expandDotenv } from "dotenv-expand";

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
  /** If true, release() throws — exercises the release-failure fallthrough
   *  to quarantine. */
  releaseThrows?: boolean;
  /** Stub return for validateMigrationJournal. Empty array (default) means
   *  every new migration is registered. Override to exercise the staleness
   *  gate in shipAfterMigrations. */
  unregisteredMigrations?: readonly {
    file: string;
    expectedTag: string;
    journalPath: string;
    journalMissing: boolean;
  }[];
  /** Optional iteration-start hook. Tests use this to inject mid-run
   *  filesystem mutations so the restart-detector path can be exercised. */
  iterationStartHook?: (it: number) => void | Promise<void>;
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
      if (opts.releaseThrows) {
        throw new Error("simulated release failure");
      }
    },
    async comment(n, body) {
      state.comments.push({ issueNum: n, body });
    },
    async listIssuesByLabel(_label) {
      // Skill-discipline gate is opt-in via SANDCASTLE.md at the repo root.
      // Existing tests use `repoRoot: "/repo"` which never has the file, so
      // the orchestrator never calls this path. Tests that exercise the
      // skill-discipline filter explicitly override this stub.
      return [];
    },
    async listOpenIssuesWithBodies() {
      // Issue E: default empty so the "no claimable issues" exit falls back
      // to the plain message. Blocked-by tests override this stub.
      return [];
    },
    async applyMigrations(repoRoot, preSha, postSha) {
      state.migrationsCalls.push({ repoRoot, preSha, postSha });
      if (opts.migrationsFail) {
        return { applied: 0, realErrors: [{ msg: "fake migration failure" }] };
      }
      return { applied: 0, realErrors: [] };
    },
    async validateMigrationJournal(_repoRoot, _preSha, _postSha) {
      // Default: nothing unregistered. Specific journal-staleness tests
      // can override this stub via opts.unregisteredMigrations.
      return opts.unregisteredMigrations ?? [];
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
    iterationStartHook: opts.iterationStartHook,
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

// runMain now acquires a real single-instance file lock at startup
// (`<repoRoot>/.sandcastle/.loop.lock`, via proper-lockfile) so two parallel
// loops on the same checkout can't race on the in-progress label state.
// The previous test default `repoRoot: "/repo"` is not writable, so the
// lock acquisition would fail and runMain would return exitCode 1 before
// running any pipeline. Anchor every baseArgs call to a real tmpdir
// instead. Per-file module-level (not per-test) is intentional — tests in
// this file run sequentially within vitest, so the lock is released
// between calls and we don't need per-test directories.
const TEST_REPO_ROOT = mkdtempSync(path.join(tmpdir(), "sandcastle-main-test-"));

function baseArgs(over: Partial<SandcastleArgs> = {}): SandcastleArgs {
  return {
    iterations: 1,
    repoRoot: TEST_REPO_ROOT,
    branch: "feature/work",
    label: "ready-for-agent",
    maxConcurrent: 3,
    imageName: "sandcastle:affinity-tracker",
    plannerModel: "claude-opus-4-7",
    implementerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-haiku-4-5",
    critiqueModel: "claude-haiku-4-5",
    mergerModel: "claude-opus-4-7",
    postMergeReviewerModel: "claude-opus-4-7",
    recoveryModel: "claude-opus-4-7",
    implementerTimeoutSec: 1200,
    reviewerTimeoutSec: 600,
    hardCeilingSec: 3600,
    consecutiveFailureLimit: 3,
    dryRun: false,
    recoveryEnabled: true,
    retryEnabled: true,
    stagingEnabled: true,
    allowDirtySandcastle: false,
    sandbox: "docker",
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
  // it up out of the (synthetic) "assistant" envelope. Wrap the envelope in
  // a fenced ```json block — parseVerdict now requires a fenced block
  // (brace-walking removed; see parse.ts).
  const assistantText =
    "Here is the verdict:\n\n```json\n" +
    JSON.stringify(envelope, null, 2) +
    "\n```\n\n" +
    marker;
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

// Reset module-level transient state (fallback breaker + defer counter)
// before every test so prior-test state can't bleed into ordering-sensitive
// cases. Cheap; safe.
beforeEach(() => {
  __resetTransientStateForTests();
});

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

  // Issue E: surface `Blocked by: #N` chains at the "no claimable issues"
  // exit so the operator can tell "nothing ready" from "everything ready is
  // blocked". The blocker (#313) is deliberately NOT itself ready-for-agent
  // (it's in-progress) — proving the openness check consults the full open
  // set, not just the ready-for-agent slice.
  it("enriches the clean-exit message with open blocked-by chains", async () => {
    const b = buildDeps();
    b.enqueue("planner", { stdout: plannerStdout([]) });
    b.deps.listOpenIssuesWithBodies = async () => [
      {
        number: 316,
        body: "Implement the thing.\n\nBlocked by: #313\n",
        labels: ["ready-for-agent", "type:feature"],
      },
      {
        // The blocker — open but in-progress, not ready-for-agent.
        number: 313,
        body: "Foundation work.",
        labels: ["in-progress"],
      },
    ];

    const result = await runMain(baseArgs(), b.deps);

    expect(result.exitCode).toBe(0);
    const exitLine = b.state.logs.find((l) =>
      l.startsWith("no claimable issues — exiting cleanly"),
    );
    expect(exitLine).toBeDefined();
    expect(exitLine).toContain(
      "#316 is ready-for-agent but blocked by #313 (open)",
    );
  });

  it("keeps the plain clean-exit message when the blocker is closed", async () => {
    const b = buildDeps();
    b.enqueue("planner", { stdout: plannerStdout([]) });
    // #316 ready-for-agent, blocked by #313 — but #313 is NOT in the open
    // set (it's closed), so the chain must NOT be surfaced.
    b.deps.listOpenIssuesWithBodies = async () => [
      {
        number: 316,
        body: "Blocked by: #313\n",
        labels: ["ready-for-agent"],
      },
    ];

    const result = await runMain(baseArgs(), b.deps);

    expect(result.exitCode).toBe(0);
    expect(b.state.logs).toContain("no claimable issues — exiting cleanly");
    expect(
      b.state.logs.some((l) => l.includes("blocked by")),
    ).toBe(false);
  });

  it("degrades to the plain clean-exit message when the gh query throws", async () => {
    const b = buildDeps();
    b.enqueue("planner", { stdout: plannerStdout([]) });
    b.deps.listOpenIssuesWithBodies = async () => {
      throw new Error("gh boom");
    };

    const result = await runMain(baseArgs(), b.deps);

    // A gh failure must NOT crash the clean exit.
    expect(result.exitCode).toBe(0);
    expect(b.state.logs).toContain("no claimable issues — exiting cleanly");
  });
});

describe("sandcastle-loop main.mts — post-merge reviewer stall retry", () => {
  // Regression for affinity-tracker #197: the post-merge reviewer went
  // silent past the 600s idle timeout, the SDK aborted it, and the
  // catch path quarantined perfectly good code. A stall is
  // environmental (the reviewer never produced a verdict); retry once
  // on the same model before treating it as a real failure.

  it("stall on first attempt + ALL_CLEAR on retry → no quarantine, issue ships", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "197", title: "stall then recover", branch: "agent/issue-197" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 197 }),
      commits: [{ sha: "good-sha" }],
    });
    b.enqueue("reviewer", { stdout: "ok\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    // First post-merge attempt stalls (SDK idle timeout).
    b.enqueue("post-merge-reviewer", {
      stdout: "",
      throw: new Error("Agent idle for 600 seconds — no output received"),
    });
    // Retry succeeds.
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([197]);
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.marksDone.map((m) => m.issueNum)).toEqual([197]);
    // Two post-merge-reviewer calls prove the retry actually fired.
    const postMergeCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "post-merge-reviewer",
    );
    expect(postMergeCalls).toHaveLength(2);
  });

  it("stall on both first attempt AND retry → falls through (no third retry)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "198", title: "persistent stall", branch: "agent/issue-198" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 198 }),
      commits: [{ sha: "good-sha" }],
    });
    b.enqueue("reviewer", { stdout: "ok\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", {
      stdout: "",
      throw: new Error("Agent idle for 600 seconds — no output received"),
    });
    b.enqueue("post-merge-reviewer", {
      stdout: "",
      throw: new Error("AgentIdleTimeoutError"),
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    // Exactly two attempts — the retry is single-shot.
    const postMergeCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "post-merge-reviewer",
    );
    expect(postMergeCalls).toHaveLength(2);
  });

  it("non-stall throw (e.g. SDK auth error) → no retry, single attempt", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "199", title: "non-stall error", branch: "agent/issue-199" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 199 }),
      commits: [{ sha: "good-sha" }],
    });
    b.enqueue("reviewer", { stdout: "ok\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", {
      stdout: "",
      throw: new Error("Anthropic API: 401 invalid api key"),
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    // No retry because the throw isn't stall-shaped.
    const postMergeCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "post-merge-reviewer",
    );
    expect(postMergeCalls).toHaveLength(1);
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

  // Regression for the affinity-tracker "no commits" pattern: implementers
  // on multi-surface stories would write real code, hit a budget-burning
  // step (slow e2e, install failure, network blip), and exit before the
  // STEP 9 final commit. Two failure modes ganged up:
  //   (1) `r.commits.length === 0` → runImplementer threw "implementer
  //       made no commits", losing the work.
  //   (2) When the implementer correctly emitted <promise>HALT</promise>
  //       for a real blocker, parseVerdict still demanded a JSON envelope
  //       and threw "no fenced ```json``` block", burning a recovery pass.
  // STEP 3.5 (commit 0663182) commits a WIP checkpoint right after writing
  // code, so r.commits has at least one entry. The HALT gate (commit
  // 37e1e27) skips parseVerdict when the marker is HALT. This test wires
  // both regressions together — implementer reports ONE WIP commit and a
  // HALT marker, pipeline must survive to quarantine cleanly.
  it("WIP checkpoint + HALT marker: pipeline survives 'no commits' + missing-envelope regression and quarantines cleanly", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "200", title: "no-commits regression", branch: "agent/issue-200" },
      ]),
    });
    // Implementer ends with <promise>HALT</promise> and reports EXACTLY ONE
    // commit — the STEP 3.5 WIP checkpoint. No JSON envelope: HALT path
    // doesn't carry one (per implement-prompt step 8 contract).
    b.enqueue("implementer", {
      stdout:
        "Cannot install workspace deps — pnpm install blocked inside sandbox " +
        "(sandcastle-loop git dep requires GH creds). Implementation code is " +
        "committed in the WIP checkpoint above; install side cannot proceed.\n\n" +
        "<promise>HALT</promise>",
      commits: [{ sha: "wip-checkpoint-200" }],
    });
    // Reviewer reads the WIP commit (no certification block) → HAS_BLOCKERS.
    // With retry disabled, the pipeline quarantines after this single pass.
    b.enqueue("reviewer", {
      stdout: "Commit body has no certification block.\n\nHAS_BLOCKERS",
    });
    // Iter 2 sees an empty plan and exits cleanly.
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, retryEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(200);
    expect(b.state.marksDone).toEqual([]);
    // CRITICAL: assert the quarantine reason mentions HAS_BLOCKERS. If the
    // HALT gate ever regresses, parseVerdict will throw on the missing
    // envelope, runImplementer will re-throw, and the pipeline will
    // quarantine via the implementer-error path — same final count, but
    // the reason text will differ (and won't match HAS_BLOCKERS). This
    // assertion is what makes the test load-bearing for BOTH fixes
    // simultaneously, not just for "any path that quarantines."
    expect(b.state.quarantines[0]!.reason).toMatch(/HAS_BLOCKERS/);
  });

  // Regression for the affinity-tracker "stale Drizzle journal" pattern:
  // implementer writes 0060_*.sql, applies it via psql, tests pass on dev,
  // BUT doesn't register the file in packages/db/migrations/meta/_journal.json.
  // Recovery agent marks "recovered — work already committed" without fixing
  // the journal. drizzle-kit migrate later silently skips the file in prod /
  // downstream consumers. The shipAfterMigrations gate (commit pending)
  // fails the iteration before applyMigrations runs.
  it("stale journal: unregistered migration file fails the iteration before applyMigrations runs", async () => {
    const b = buildDeps({
      // 50/50 mock SHAs so preSha !== postSha → migration check fires.
      shas: ["pre-sha", "post-sha"],
      unregisteredMigrations: [
        {
          file: "packages/db/migrations/0060_budget_notifications.sql",
          expectedTag: "0060_budget_notifications",
          journalPath: "packages/db/migrations/meta/_journal.json",
          journalMissing: false,
        },
      ],
    });
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "210", title: "adds untracked migration", branch: "agent/issue-210" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 210 }),
      commits: [{ sha: "wip-210" }],
    });
    b.enqueue("reviewer", { stdout: "ok\nALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, retryEnabled: false }),
      b.deps,
    );

    // ALL_CLEAR reviewer routes to shipAfterMigrations. The journal gate
    // throws BEFORE applyMigrations runs (assert it never got called),
    // pipeline catches the error and quarantines the issue with a
    // journal-specific reason.
    expect(result.exitCode).toBe(0);
    expect(b.state.migrationsCalls).toEqual([]);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(210);
    expect(b.state.quarantines[0]!.reason).toMatch(
      /0060_budget_notifications|journal/i,
    );
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
      "Here is the verdict:\n\n```json\n" +
      JSON.stringify(envelope, null, 2) +
      "\n```\n\nSTORY_COMPLETE";

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
      baseArgs({ iterations: 2, recoveryEnabled: false, stagingEnabled: false }),
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

  it("--recovery on: implementer error → recovery RECOVERY_COMPLETE → recovery-reviewer ALL_CLEAR → markDone (no quarantine)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "71", title: "recover", branch: "agent/issue-71" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("recovery", { stdout: "fixed it up\n\nRECOVERY_COMPLETE" });
    b.enqueue("recovery-reviewer", { stdout: "looks good\n\nALL_CLEAR" });
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
    // Confirm the recovery-reviewer pass actually fired.
    const recoveryReviewerCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "recovery-reviewer",
    );
    expect(recoveryReviewerCalls).toHaveLength(1);
  });

  it("--recovery on: diagnosed migration error feeds DIAGNOSE_HINT into recovery promptArgs", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "73", title: "migration halt", branch: "agent/issue-73" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: "",
      throw: new Error(`PostgresError: relation "foo" does not exist`),
    });
    b.enqueue("recovery", { stdout: "ran the migration\n\nRECOVERY_COMPLETE" });
    b.enqueue("recovery-reviewer", { stdout: "looks good\n\nALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });

    await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: true, stagingEnabled: false }),
      b.deps,
    );

    const recoveryCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "recovery",
    );
    expect(recoveryCalls).toHaveLength(1);
    const hint = recoveryCalls[0]!.spec.promptArgs?.DIAGNOSE_HINT ?? "";
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain("pnpm db:migrate");
  });

  it("--recovery on: recovery RECOVERY_COMPLETE → recovery-reviewer HAS_BLOCKERS → quarantines (no ship)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "72", title: "bad recover", branch: "agent/issue-72" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("recovery", { stdout: "papered over it\n\nRECOVERY_COMPLETE" });
    b.enqueue("recovery-reviewer", {
      stdout: "this fix is bogus\n\nHAS_BLOCKERS",
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: true, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([]);
    expect(b.state.marksDone).toEqual([]);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(72);
    // Reviewer fired exactly once on the recovery output.
    const recoveryReviewerCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "recovery-reviewer",
    );
    expect(recoveryReviewerCalls).toHaveLength(1);
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
    const result = await runMain(baseArgs({ issue: 71, iterations: 1, stagingEnabled: false }), b.deps);

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

describe("sandcastle-loop main.mts — parseSandcastleArgs", () => {
  it("--help sets showHelp", () => {
    const r = parseSandcastleArgs(["--help"]);
    expect(r.showHelp).toBe(true);
  });

  it("requires --iterations", () => {
    expect(() => parseSandcastleArgs([])).toThrow(/--iterations/);
  });

  it("rejects non-integer --iterations", () => {
    expect(() => parseSandcastleArgs(["--iterations", "0"])).toThrow();
  });

  it("parses defaults for unspecified flags", () => {
    const r = parseSandcastleArgs(["--iterations", "3"]);
    expect(r.showHelp).toBe(false);
    expect(r.args.iterations).toBe(3);
    expect(r.args.maxConcurrent).toBe(3);
    expect(r.args.implementerModel).toBe("claude-opus-4-7");
    expect(r.args.reviewerModel).toBe("claude-haiku-4-5");
    expect(r.args.recoveryModel).toBe("claude-opus-4-7");
    expect(r.args.recoveryEnabled).toBe(true);
    expect(r.args.consecutiveFailureLimit).toBe(3);
  });
});

describe("sandcastle-loop main.mts — loadDotenv chain", () => {
  // The chain (first hit per-key wins, lower fills gaps):
  //   1. process.env  2. $SANDCASTLE_ENV_FILE  3. <repoRoot>/.sandcastle/.env
  //   4. <repoRoot>/.env
  //   5. $XDG_CONFIG_HOME/sandcastle/.env or ~/.config/sandcastle/.env

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

  it("unescapes \\n \\r \\t \\\\ inside double-quoted values only", () => {
    withTempDirs(({ repoRoot }) => {
      writeFileSync(
        path.join(repoRoot, ".env"),
        [
          'KIMI_API_KEY="line1\\nline2"',
          "GLM_API_KEY='line1\\nline2'",
          'ANTHROPIC_API_KEY="back\\\\slash"',
        ].join("\n") + "\n",
      );
      loadDotenv(repoRoot);
      expect(process.env.KIMI_API_KEY).toBe("line1\nline2");
      expect(process.env.GLM_API_KEY).toBe("line1\\nline2");
      expect(process.env.ANTHROPIC_API_KEY).toBe("back\\slash");
    });
  });

  it("<repoRoot>/.sandcastle/.env wins over <repoRoot>/.env for same key", () => {
    withTempDirs(({ repoRoot }) => {
      mkdirSync(path.join(repoRoot, ".sandcastle"), { recursive: true });
      writeFileSync(
        path.join(repoRoot, ".sandcastle", ".env"),
        "KIMI_API_KEY=from-sandcastle\n",
      );
      writeFileSync(path.join(repoRoot, ".env"), "KIMI_API_KEY=from-project\n");
      loadDotenv(repoRoot);
      expect(process.env.KIMI_API_KEY).toBe("from-sandcastle");
    });
  });

  it("<repoRoot>/.sandcastle/.env fills gaps left by project .env", () => {
    withTempDirs(({ repoRoot }) => {
      mkdirSync(path.join(repoRoot, ".sandcastle"), { recursive: true });
      writeFileSync(
        path.join(repoRoot, ".sandcastle", ".env"),
        "KIMI_API_KEY=from-sandcastle\n",
      );
      writeFileSync(path.join(repoRoot, ".env"), "GH_TOKEN=from-project\n");
      loadDotenv(repoRoot);
      expect(process.env.KIMI_API_KEY).toBe("from-sandcastle");
      expect(process.env.GH_TOKEN).toBe("from-project");
    });
  });

  it("single-pass replace: \\\\n resolves to literal backslash + n, not newline", () => {
    // Regression guard: a future refactor to sequential .replace() calls
    // (first \\ → \, then \n → LF) would silently emit a newline here.
    // Single-pass regex must consume \\ before the n is reconsidered.
    withTempDirs(({ repoRoot }) => {
      writeFileSync(
        path.join(repoRoot, ".env"),
        'KIMI_API_KEY="a\\\\nb"\n',
      );
      loadDotenv(repoRoot);
      expect(process.env.KIMI_API_KEY).toBe("a\\nb");
      expect(process.env.KIMI_API_KEY).not.toContain("\n");
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
      // Adversarial-review false-positive cases: bare 3-digit numbers must
      // NOT classify as transient (would burn 3 retries on real bugs like a
      // dead Postgres / Vite dev server / unreachable port).
      "connect ECONNREFUSED 127.0.0.1:5432",
      "vite dev server on 5173 unreachable",
      "couchdb on 5984 timed out",
      "node v20.5.0 crashed",
      "playwright timeout after 500ms exceeded",
      "file not found: api_error.log",
      "the server is overloaded with traffic",
      "permission denied accessing internal server error.log",
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

  it("recovery-throw deferrals are bounded by MAX_DEFERRALS — 4th hit quarantines", async () => {
    const b = buildDeps();
    const transientThrow = () =>
      new Error("API Error: The server had an error while processing your request");
    // 4 iterations, each plans the same issue, each errors via recovery throw.
    for (let i = 0; i < 4; i++) {
      b.enqueue("planner", {
        stdout: plannerStdout([{ id: "502", title: "rec-bounded", branch: "agent/issue-502" }]),
      });
      b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
      b.enqueue("recovery", { stdout: "", throw: transientThrow() });
    }
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({
        iterations: 5,
        recoveryEnabled: true,
        consecutiveFailureLimit: 99,
      }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.releases).toHaveLength(3);
    expect(b.state.releases.every((r) => r.issueNum === 502)).toBe(true);
    // The 4th attempt exceeds MAX_DEFERRALS and quarantines.
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(502);
  });

  it("recovery-throw release-comment cites the recovery error, not the original", async () => {
    // Regression for the misleading-log issue surfaced in adversarial review:
    // the release comment must point at the actual cause (recovery's throw),
    // not the original pipeline error.
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "503", title: "log-cause", branch: "agent/issue-503" }]),
    });
    b.enqueue("implementer", {
      stdout: "",
      throw: new Error("DISTINCTIVE_PIPELINE_ERROR_TOKEN"),
    });
    b.enqueue("recovery", {
      stdout: "",
      throw: new Error("DISTINCTIVE_RECOVERY_TOKEN: the server had an error"),
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: true }),
      b.deps,
    );

    expect(b.state.releases).toHaveLength(1);
    expect(b.state.releases[0]!.reason).toMatch(/DISTINCTIVE_RECOVERY_TOKEN/);
    expect(b.state.releases[0]!.reason).not.toMatch(/DISTINCTIVE_PIPELINE_ERROR_TOKEN/);
  });

  it("recovery returns HALT marker → quarantines (no defer, no release)", async () => {
    // Recovery RAN and judged the work unrecoverable. That's a legit
    // verdict, not a transient error — should quarantine, not defer.
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "504", title: "rec-halt", branch: "agent/issue-504" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("recovery", {
      stdout: "Tried but couldn't fix it.\n\nHALT",
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: true }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.releases).toEqual([]);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(504);
  });

  it("two-tier deferral across iterations shares one MAX_DEFERRALS counter", async () => {
    // Iteration 1: implementer throws transient (rate-limit) → defers at
    //   pipeline-catch level. Counter = 1.
    // Iteration 2: implementer throws non-transient → recovery runs →
    //   recovery throws transient → defers at recovery-throw level.
    //   Counter = 2.
    // The same counter is incremented both times, proving the two paths
    // share one budget per issue (a flaky issue can't slip past the
    // MAX_DEFERRALS=3 ceiling by bouncing between the two paths).
    //
    const b = buildDeps();
    // Iteration 1 — pipeline-catch defer (rate-limit).
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "505", title: "two-tier", branch: "agent/issue-505" }]),
    });
    const rl = () =>
      new Error('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}');
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("implementer", { stdout: "", throw: rl() });
    // Iteration 2 — recovery-throw defer (5xx).
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "505", title: "two-tier", branch: "agent/issue-505" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("recovery", {
      stdout: "",
      throw: new Error("API Error: The server had an error while processing your request"),
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({
        iterations: 3,
        recoveryEnabled: true,
        consecutiveFailureLimit: 99,
      }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.releases).toHaveLength(2);
    expect(b.state.releases[0]!.reason).toMatch(/attempt 1\/3/);
    expect(b.state.releases[0]!.reason).toMatch(/transient error/);
    expect(b.state.releases[1]!.reason).toMatch(/attempt 2\/3/);
    expect(b.state.releases[1]!.reason).toMatch(/recovery threw transient/);
  });

  it("release-failure on recovery-throw branch falls through to quarantine", async () => {
    // If the release() call itself throws (GitHub flake, etc.), the
    // pipeline can't actually defer the issue. Falls through to
    // quarantine rather than leaving the issue in a stuck in-progress
    // state forever.
    const b = buildDeps({ releaseThrows: true });
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "506", title: "rel-fail", branch: "agent/issue-506" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
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
    // Release was attempted but threw — so it's in releases (mock pushes
    // before throwing) but quarantine also fires.
    expect(b.state.releases).toHaveLength(1);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(506);
  });

  it("quarantine path clears deferralCounts (un-quarantine starts fresh at 1/3)", async () => {
    // Scenario: an issue defers a couple of times for transient errors,
    // then a non-transient failure quarantines it. The counter must be
    // cleared on quarantine so that if an operator un-quarantines the
    // issue and the loop picks it up again, the next transient gets a
    // fresh `attempt 1/3` budget — not whatever stale count was left.
    const b = buildDeps();
    const rl = () =>
      new Error('API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}');
    // Iteration 1: rate-limit → defer #507 (counter goes 0→1)
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "507", title: "leak", branch: "agent/issue-507" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("implementer", { stdout: "", throw: rl() });
    // Iteration 2: non-transient implementer crash + non-transient
    // recovery error → quarantines (no defer). MUST clear counter.
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "507", title: "leak", branch: "agent/issue-507" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("recovery", {
      stdout: "",
      throw: new Error("invalid_api_key"),
    });
    // Iteration 3: simulate operator un-quarantine — fresh transient error
    // should land as `attempt 1/3`, not `attempt 2/3`.
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "507", title: "leak", branch: "agent/issue-507" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    await runMain(
      baseArgs({
        iterations: 4,
        recoveryEnabled: true,
        consecutiveFailureLimit: 99,
      }),
      b.deps,
    );

    // First defer (iter 1) → 1/3, then quarantine (iter 2) clears the
    // counter, then re-defer (iter 3) → 1/3 again. If the counter leaked,
    // iter 3 would say 2/3.
    expect(b.state.releases).toHaveLength(2);
    expect(b.state.releases[0]!.reason).toMatch(/attempt 1\/3/);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(507);
    expect(b.state.releases[1]!.reason).toMatch(/attempt 1\/3/);
  });
});

describe("sandcastle-loop main.mts — DATABASE_URL preflight", () => {
  // Default stub injections: every gate except the DB-URL one passes, so the
  // DB-URL gate is the only thing that can toggle ok/errors. Tests then vary
  // listMigrations and getEnv to drive the new check.
  function preflightWith(over: {
    migrations?: string[];
    dbUrl?: string | undefined;
    postgresUrl?: string | undefined;
  }) {
    return preflight(baseArgs(), {
      exec: () => ({ ok: true }),
      fileExists: () => true,
      listMigrations: () => over.migrations ?? [],
      getEnv: (k) => {
        if (k === "DATABASE_URL") return over.dbUrl;
        if (k === "POSTGRES_URL") return over.postgresUrl;
        return undefined;
      },
    });
  }

  it("fails when migrations exist on disk and DATABASE_URL is unset", () => {
    const res = preflightWith({
      migrations: ["db/migrations/0001_init.sql"],
      dbUrl: undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(
      /Neither DATABASE_URL nor POSTGRES_URL is set/,
    );
    expect(res.errors.join("\n")).toMatch(/0001_init\.sql/);
  });

  it("fails when migrations exist on disk and DATABASE_URL is blank", () => {
    const res = preflightWith({
      migrations: ["db/migrations/0001_init.sql"],
      dbUrl: "   ",
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(
      /Neither DATABASE_URL nor POSTGRES_URL is set/,
    );
  });

  it("passes when migrations exist on disk and DATABASE_URL is set", () => {
    const res = preflightWith({
      migrations: ["db/migrations/0001_init.sql"],
      dbUrl: "postgres://fake@localhost/db",
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("passes when DATABASE_URL is unset but POSTGRES_URL is set (t3-turbo default)", () => {
    const res = preflightWith({
      migrations: ["db/migrations/0001_init.sql"],
      dbUrl: undefined,
      postgresUrl: "postgres://fake@localhost/db",
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("passes when no migrations exist, regardless of DATABASE_URL", () => {
    const res = preflightWith({ migrations: [], dbUrl: undefined });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  // Integration test: exercise the REAL listMigrationsOnDisk walk against a
  // real temp dir. The four stubbed tests above only cover the preflight
  // gate logic; this one catches regressions in the actual fs scan
  // (symlink handling, path-separator normalization, skip-dir denylist).
  it("real walk detects a drizzle migration file written to disk", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "sc-preflight-"));
    try {
      mkdirSync(path.join(tmp, "db", "migrations"), { recursive: true });
      writeFileSync(
        path.join(tmp, "db", "migrations", "0001_init.sql"),
        "CREATE TABLE foo (id int);\n",
      );
      const args = baseArgs({ repoRoot: tmp });
      const prevDb = process.env.DATABASE_URL;
      const prevPg = process.env.POSTGRES_URL;
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_URL;
      try {
        const res = preflight(args, {
          exec: () => ({ ok: true }),
          fileExists: () => true,
        });
        expect(res.ok).toBe(false);
        expect(res.errors.join("\n")).toMatch(
          /Neither DATABASE_URL nor POSTGRES_URL is set/,
        );
        expect(res.errors.join("\n")).toMatch(/0001_init\.sql/);
      } finally {
        if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
        if (prevPg !== undefined) process.env.POSTGRES_URL = prevPg;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("sandcastle-loop main.mts — sandbox image preflight", () => {
  // Regression guard: iteration 1 used to crash with "Image not found" on a
  // fresh worktree because preflight only checked `docker info`. Preflight
  // now also verifies `docker image inspect <imageName>` and produces a
  // clear build command when missing.
  it("fails with a clear build command when the named image isn't on disk", () => {
    const res = preflight(baseArgs({ imageName: "sandcastle:test-proj" }), {
      exec: (bin, a) => {
        if (bin === "docker" && a[0] === "image" && a[1] === "inspect") {
          return { ok: false, stderr: "Error: No such image" };
        }
        return { ok: true };
      },
      fileExists: () => true,
      listMigrations: () => [],
      getEnv: () => undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(
      /sandbox image 'sandcastle:test-proj' not found locally/,
    );
    expect(res.errors.join("\n")).toMatch(/build-image --image-name sandcastle:test-proj/);
  });

  it("passes when the named image exists", () => {
    const res = preflight(baseArgs({ imageName: "sandcastle:test-proj" }), {
      exec: () => ({ ok: true }),
      fileExists: () => true,
      listMigrations: () => [],
      getEnv: () => undefined,
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  // Sandcastle-source dirty-check tests live just below in their own block.

  it("skips the image check when docker daemon itself is down (avoids redundant errors)", () => {
    const res = preflight(baseArgs({ imageName: "sandcastle:test-proj" }), {
      exec: (bin, a) => {
        if (bin === "docker" && a[0] === "info") {
          return { ok: false, stderr: "Cannot connect to the Docker daemon" };
        }
        if (bin === "docker" && a[0] === "image" && a[1] === "inspect") {
          throw new Error("image check should not run when daemon is down");
        }
        return { ok: true };
      },
      fileExists: () => true,
      listMigrations: () => [],
      getEnv: () => undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(/docker info failed/);
    expect(res.errors.join("\n")).not.toMatch(/sandbox image/);
  });
});

describe("sandcastle-loop main.mts — .sandcastle/main.mts dirty-check preflight", () => {
  // The dirty-check refuses to launch when `.sandcastle/main.mts` has
  // uncommitted changes vs HEAD. It guards against the "patched locally
  // but never propagated upstream" failure mode that has bitten the
  // loop twice (`.pnpm-store/` gitignore slip, worktree pre-clean slip).
  // baseArgs() defaults `allowDirtySandcastle: false`. Other preflight
  // tests pass through this gate because their default `exec` stub
  // returns `{ ok: true }` for every call — which on the `git diff
  // --quiet` invocation means "main.mts is clean", so no error is
  // pushed. These tests opt in explicitly to either state.

  // `exec` mock that only fails the dirty-check call. All other gates
  // pass (gh auth, docker info, docker image inspect, ...).
  function execWithDirtyCheck(dirty: boolean) {
    return (bin: string, a: readonly string[]) => {
      if (
        bin === "git" &&
        a.includes("diff") &&
        a.includes("--quiet") &&
        a.includes(".sandcastle/main.mts")
      ) {
        return dirty ? { ok: false, stderr: "" } : { ok: true };
      }
      return { ok: true };
    };
  }

  it("fails when .sandcastle/main.mts is dirty vs HEAD (default strict)", () => {
    const res = preflight(baseArgs({ allowDirtySandcastle: false }), {
      exec: execWithDirtyCheck(true),
      fileExists: () => true,
      listMigrations: () => [],
      getEnv: () => undefined,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("\n")).toMatch(
      /uncommitted changes in \.sandcastle\/main\.mts/,
    );
    expect(res.errors.join("\n")).toMatch(/--allow-dirty-sandcastle/);
  });

  it("passes when .sandcastle/main.mts is clean vs HEAD", () => {
    const res = preflight(baseArgs({ allowDirtySandcastle: false }), {
      exec: execWithDirtyCheck(false),
      fileExists: () => true,
      listMigrations: () => [],
      getEnv: () => undefined,
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("skips the dirty-check entirely when allowDirtySandcastle is true", () => {
    let dirtyCheckCalled = false;
    const res = preflight(baseArgs({ allowDirtySandcastle: true }), {
      exec: (bin, a) => {
        if (
          bin === "git" &&
          a[0] === "diff" &&
          a[1] === "--quiet" &&
          a.includes(".sandcastle/main.mts")
        ) {
          dirtyCheckCalled = true;
          // If anything DID call us, simulate a dirty state to prove
          // we didn't observe it.
          return { ok: false, stderr: "" };
        }
        return { ok: true };
      },
      fileExists: () => true,
      listMigrations: () => [],
      getEnv: () => undefined,
    });
    expect(dirtyCheckCalled).toBe(false);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

describe("sandcastle-loop main.mts — staging worktree", () => {
  // Helper: initialise a real git repo with one commit on `main`.
  function initTempRepo(): { repoRoot: string; cleanup: () => void } {
    const tmp = mkdtempSync(path.join(tmpdir(), "sc-staging-"));
    const repoRoot = tmp;
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const run = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repoRoot, env: gitEnv, stdio: "ignore" });
    };
    run("init", "-q", "-b", "main");
    // Need real config for commit to land.
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    writeFileSync(path.join(repoRoot, "README.md"), "hello\n");
    run("add", "README.md");
    run("commit", "-q", "-m", "init");
    return {
      repoRoot,
      cleanup: () => rmSync(tmp, { recursive: true, force: true }),
    };
  }

  it("creates the staging worktree + integration-candidate branch when neither exists", async () => {
    const { repoRoot, cleanup } = initTempRepo();
    try {
      const logs: string[] = [];
      const stagingPath = await ensureStagingWorktree(repoRoot, "main", (l) => logs.push(l));
      expect(stagingPath).toBe(path.join(repoRoot, ".sandcastle/worktrees/staging"));
      expect(existsSync(stagingPath)).toBe(true);
      // HEAD inside the staging worktree must be on integration-candidate.
      const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: stagingPath,
        encoding: "utf8",
      }).trim();
      expect(head).toBe("integration-candidate");
      expect(logs.some((l) => l.includes("[staging] worktree ready at"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("is idempotent — second call returns the same path without duplicating worktrees", async () => {
    const { repoRoot, cleanup } = initTempRepo();
    try {
      const first = await ensureStagingWorktree(repoRoot, "main", () => {});
      const second = await ensureStagingWorktree(repoRoot, "main", () => {});
      expect(second).toBe(first);
      // git worktree list should show launch + staging only (2 entries).
      const wtList = execFileSync("git", ["worktree", "list"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      const lines = wtList.trim().split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("throws with recovery instruction when launch worktree is on integration-candidate", async () => {
    const { repoRoot, cleanup } = initTempRepo();
    try {
      // Put the launch worktree HEAD on integration-candidate to simulate
      // a previously-buggy run that left it parked there.
      execFileSync("git", ["checkout", "-q", "-b", "integration-candidate"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      await expect(
        ensureStagingWorktree(repoRoot, "main", () => {}),
      ).rejects.toThrow(/integration-candidate.*git checkout/i);
    } finally {
      cleanup();
    }
  });
});

describe("sandcastle-loop main.mts — fastForwardIntegration", () => {
  function initRepoForFastForward(): {
    repoRoot: string;
    gitEnv: NodeJS.ProcessEnv;
    cleanup: () => void;
  } {
    const tmp = mkdtempSync(path.join(tmpdir(), "sc-ff-"));
    const repoRoot = tmp;
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const run = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repoRoot, env: gitEnv, stdio: "ignore" });
    };
    run("init", "-q", "-b", "main");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "Test");
    writeFileSync(path.join(repoRoot, "README.md"), "hello\n");
    run("add", "README.md");
    run("commit", "-q", "-m", "init");
    return { repoRoot, gitEnv, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  }

  // Regression guard for the disk-drift incident: bare `git update-ref` advanced
  // HEAD on the launch worktree while leaving the working tree on the old snapshot.
  // After the fix, fastForwardIntegration must use `merge --ff-only` inside any
  // worktree that has the target branch checked out, so disk advances with HEAD.
  it("advances HEAD AND working tree in a worktree that has the target branch checked out", () => {
    const { repoRoot, gitEnv, cleanup } = initRepoForFastForward();
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: repoRoot, env: gitEnv, encoding: "utf8" }).trim();

      git("branch", "feat-x");
      git("branch", "integration-candidate");
      git("checkout", "-q", "integration-candidate");
      writeFileSync(path.join(repoRoot, "finance.ts"), "export const TOTAL = 42;\n");
      git("add", "finance.ts");
      git("commit", "-q", "-m", "add finance.ts to integration-candidate");
      const candidateTip = git("rev-parse", "HEAD");
      git("checkout", "-q", "feat-x");
      expect(existsSync(path.join(repoRoot, "finance.ts"))).toBe(false);

      const logs: string[] = [];
      const errors: string[] = [];
      const ok = fastForwardIntegration(
        repoRoot,
        "feat-x",
        (s) => logs.push(s),
        (s) => errors.push(s),
      );

      expect(errors).toEqual([]);
      expect(ok).toBe(true);
      expect(git("rev-parse", "HEAD")).toBe(candidateTip);
      expect(existsSync(path.join(repoRoot, "finance.ts"))).toBe(true);
      expect(readFileSync(path.join(repoRoot, "finance.ts"), "utf8")).toBe(
        "export const TOTAL = 42;\n",
      );
      expect(logs.some((l) => l.includes("via worktree merge"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("falls back to update-ref when the target branch is not checked out anywhere", () => {
    const { repoRoot, gitEnv, cleanup } = initRepoForFastForward();
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: repoRoot, env: gitEnv, encoding: "utf8" }).trim();

      git("branch", "feat-x");
      git("branch", "integration-candidate");
      git("checkout", "-q", "integration-candidate");
      writeFileSync(path.join(repoRoot, "finance.ts"), "x\n");
      git("add", "finance.ts");
      git("commit", "-q", "-m", "advance");
      const candidateTip = git("rev-parse", "HEAD");
      git("checkout", "-q", "main");

      const logs: string[] = [];
      const ok = fastForwardIntegration(repoRoot, "feat-x", (s) => logs.push(s), () => {});
      expect(ok).toBe(true);
      expect(git("rev-parse", "refs/heads/feat-x")).toBe(candidateTip);
      expect(logs.some((l) => l.includes("via worktree merge"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  // Issue 7 (audit 2026-05-30): when an operator commits to integrationBranch
  // mid-iteration, the staging tip is no longer an ancestor of integration —
  // FF refuses and a human merges manually. Three such recoveries hit
  // affinity-tracker in two days. The orchestrator should attempt a non-FF
  // merge on the live worktree before quarantining. Conflicts still
  // quarantine — they're real author work; FF refusal alone is plumbing.
  it("auto-merges with --no-ff when integration has diverged from staging (no conflicts)", () => {
    const { repoRoot, gitEnv, cleanup } = initRepoForFastForward();
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: repoRoot, env: gitEnv, encoding: "utf8" }).trim();

      // staging gets one commit (loop's iteration work)
      git("branch", "integration-candidate");
      git("checkout", "-q", "integration-candidate");
      writeFileSync(path.join(repoRoot, "staging-file.ts"), "export const STAGING = 1;\n");
      git("add", "staging-file.ts");
      git("commit", "-q", "-m", "staging work");
      const stagingTip = git("rev-parse", "HEAD");

      // operator commits to integration (feat-x) on a DIFFERENT path → divergence, no conflict
      git("checkout", "-q", "-b", "feat-x", "main");
      writeFileSync(path.join(repoRoot, "operator-file.ts"), "export const OP = 1;\n");
      git("add", "operator-file.ts");
      git("commit", "-q", "-m", "operator hotfix");
      const integrationTipBefore = git("rev-parse", "HEAD");

      const logs: string[] = [];
      const errors: string[] = [];
      const ok = fastForwardIntegration(
        repoRoot,
        "feat-x",
        (s) => logs.push(s),
        (s) => errors.push(s),
      );

      expect(errors).toEqual([]);
      expect(ok).toBe(true);

      // HEAD on feat-x must now be a merge commit with both staging-tip and
      // the operator's commit as parents.
      const parents = git("rev-parse", "HEAD^@").split("\n");
      expect(parents.length).toBe(2);
      expect(parents).toContain(stagingTip);
      expect(parents).toContain(integrationTipBefore);

      // Both files present in working tree (no data lost in either direction)
      expect(existsSync(path.join(repoRoot, "staging-file.ts"))).toBe(true);
      expect(existsSync(path.join(repoRoot, "operator-file.ts"))).toBe(true);

      // Deterministic, audit-traceable commit message
      const subject = git("log", "-1", "--format=%s");
      expect(subject).toBe(
        "Sandcastle: merge integration-candidate into feat-x [auto-no-ff]",
      );
      expect(logs.some((l) => l.includes("auto --no-ff"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("aborts and refuses when --no-ff auto-merge would conflict", () => {
    const { repoRoot, gitEnv, cleanup } = initRepoForFastForward();
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: repoRoot, env: gitEnv, encoding: "utf8" }).trim();

      // staging modifies shared.ts one way
      git("branch", "integration-candidate");
      git("checkout", "-q", "integration-candidate");
      writeFileSync(path.join(repoRoot, "shared.ts"), "export const X = 'staging';\n");
      git("add", "shared.ts");
      git("commit", "-q", "-m", "staging touches shared");

      // operator modifies the SAME file differently on feat-x → real conflict
      git("checkout", "-q", "-b", "feat-x", "main");
      writeFileSync(path.join(repoRoot, "shared.ts"), "export const X = 'operator';\n");
      git("add", "shared.ts");
      git("commit", "-q", "-m", "operator touches shared");
      const integrationTipBefore = git("rev-parse", "HEAD");

      const logs: string[] = [];
      const errors: string[] = [];
      const ok = fastForwardIntegration(
        repoRoot,
        "feat-x",
        (s) => logs.push(s),
        (s) => errors.push(s),
      );

      expect(ok).toBe(false);
      expect(errors.length).toBeGreaterThan(0);
      // Monitoring continuity: keep "fast-forward refused" as the prefix that
      // downstream grep/alerting may already match.
      expect(errors.some((e) => e.startsWith("fast-forward refused"))).toBe(true);
      // Proves we ACTUALLY attempted the auto-merge before giving up — without
      // this, the conflict path would silently regress to the old "refuse
      // without trying" behaviour and still pass the assertions above.
      expect(errors.some((e) => e.includes("auto --no-ff also failed"))).toBe(true);

      // HEAD must be unchanged — no half-applied merge state
      expect(git("rev-parse", "HEAD")).toBe(integrationTipBefore);
      // Working tree must be clean — `git merge --abort` ran on the failed merge
      expect(git("status", "--porcelain")).toBe("");
      expect(existsSync(path.join(repoRoot, ".git", "MERGE_HEAD"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  // Issue 8 (audit 2026-05-30): detect dep-manifest changes between two
  // commits so the loop can warn the operator that host node_modules is
  // stale after a successful merge. Auto --no-ff (Issue 7) makes this
  // strictly more frequent.
  describe("detectChangedLockfiles", () => {
    function initRepoForDiff(): {
      repoRoot: string;
      git: (...args: string[]) => string;
      cleanup: () => void;
    } {
      const tmp = mkdtempSync(path.join(tmpdir(), "sc-lock-"));
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: tmp, env: gitEnv, encoding: "utf8" }).trim();
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp, env: gitEnv, stdio: "ignore" });
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      writeFileSync(path.join(tmp, "README.md"), "hello\n");
      git("add", "README.md");
      git("commit", "-q", "-m", "init");
      return { repoRoot: tmp, git, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
    }

    it("returns [] when the two SHAs are identical", () => {
      const { repoRoot, git, cleanup } = initRepoForDiff();
      try {
        const sha = git("rev-parse", "HEAD");
        expect(detectChangedLockfiles(repoRoot, sha, sha)).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it("returns [] when the diff contains no dep-manifest files", () => {
      const { repoRoot, git, cleanup } = initRepoForDiff();
      try {
        const from = git("rev-parse", "HEAD");
        writeFileSync(path.join(repoRoot, "src.ts"), "export const X = 1;\n");
        git("add", "src.ts");
        git("commit", "-q", "-m", "code only");
        const to = git("rev-parse", "HEAD");
        expect(detectChangedLockfiles(repoRoot, from, to)).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it("flags a root package.json change", () => {
      const { repoRoot, git, cleanup } = initRepoForDiff();
      try {
        const from = git("rev-parse", "HEAD");
        writeFileSync(path.join(repoRoot, "package.json"), `{"name":"x"}\n`);
        git("add", "package.json");
        git("commit", "-q", "-m", "add pkg");
        const to = git("rev-parse", "HEAD");
        expect(detectChangedLockfiles(repoRoot, from, to)).toEqual(["package.json"]);
      } finally {
        cleanup();
      }
    });

    it("flags every supported lockfile basename in one diff", () => {
      const { repoRoot, git, cleanup } = initRepoForDiff();
      try {
        const from = git("rev-parse", "HEAD");
        writeFileSync(path.join(repoRoot, "package.json"), `{"name":"x"}\n`);
        writeFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "lockfile: 9\n");
        writeFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "packages:\n");
        writeFileSync(path.join(repoRoot, "yarn.lock"), "# yarn\n");
        writeFileSync(path.join(repoRoot, "package-lock.json"), `{"name":"x"}\n`);
        writeFileSync(path.join(repoRoot, "bun.lock"), "# bun\n");
        writeFileSync(path.join(repoRoot, "bun.lockb"), "binary\n");
        git("add", "-A");
        git("commit", "-q", "-m", "all manifests");
        const to = git("rev-parse", "HEAD");
        const result = detectChangedLockfiles(repoRoot, from, to);
        expect(result.slice().sort()).toEqual([
          "bun.lock",
          "bun.lockb",
          "package-lock.json",
          "package.json",
          "pnpm-lock.yaml",
          "pnpm-workspace.yaml",
          "yarn.lock",
        ]);
      } finally {
        cleanup();
      }
    });

    // Regression guard for the review finding: pnpm-workspace.yaml
    // controls `allowBuilds` / `ignoredBuiltDependencies`, so a change
    // there genuinely stales node_modules install-script state. The
    // file IS present in this very repo. Without this case the warning
    // would silently miss the exact shape the audit's Issue 8 is about.
    it("flags a standalone pnpm-workspace.yaml change", () => {
      const { repoRoot, git, cleanup } = initRepoForDiff();
      try {
        const from = git("rev-parse", "HEAD");
        writeFileSync(
          path.join(repoRoot, "pnpm-workspace.yaml"),
          "allowBuilds:\n  esbuild: false\n",
        );
        git("add", "pnpm-workspace.yaml");
        git("commit", "-q", "-m", "add workspace config");
        const to = git("rev-parse", "HEAD");
        expect(detectChangedLockfiles(repoRoot, from, to)).toEqual([
          "pnpm-workspace.yaml",
        ]);
      } finally {
        cleanup();
      }
    });

    it("flags lockfiles inside workspace subdirectories", () => {
      const { repoRoot, git, cleanup } = initRepoForDiff();
      try {
        const from = git("rev-parse", "HEAD");
        mkdirSync(path.join(repoRoot, "apps", "web"), { recursive: true });
        writeFileSync(path.join(repoRoot, "apps", "web", "package.json"), `{"name":"web"}\n`);
        writeFileSync(path.join(repoRoot, "apps", "web", "pnpm-lock.yaml"), "lockfile: 9\n");
        git("add", "-A");
        git("commit", "-q", "-m", "nested workspace lockfile");
        const to = git("rev-parse", "HEAD");
        const result = detectChangedLockfiles(repoRoot, from, to);
        expect(result.slice().sort()).toEqual([
          "apps/web/package.json",
          "apps/web/pnpm-lock.yaml",
        ]);
      } finally {
        cleanup();
      }
    });

    it("ignores files that merely contain a lockfile-shaped basename (no full match)", () => {
      const { repoRoot, git, cleanup } = initRepoForDiff();
      try {
        const from = git("rev-parse", "HEAD");
        // Files with substrings of lockfile names must NOT be flagged.
        writeFileSync(path.join(repoRoot, "my-package.json.bak"), "{}\n");
        writeFileSync(path.join(repoRoot, "package.json.template"), "{}\n");
        git("add", "-A");
        git("commit", "-q", "-m", "lookalikes");
        const to = git("rev-parse", "HEAD");
        expect(detectChangedLockfiles(repoRoot, from, to)).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it("fails quiet on empty SHA (returns [])", () => {
      const { repoRoot, git, cleanup } = initRepoForDiff();
      try {
        const sha = git("rev-parse", "HEAD");
        expect(detectChangedLockfiles(repoRoot, "", sha)).toEqual([]);
        expect(detectChangedLockfiles(repoRoot, sha, "")).toEqual([]);
      } finally {
        cleanup();
      }
    });
  });

  describe("parseWorktreeList", () => {
    it("parses attached and detached worktrees", () => {
      const stdout = [
        "worktree /path/main",
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        "worktree /path/staging",
        "HEAD def456",
        "branch refs/heads/integration-candidate",
        "",
        "worktree /path/detached",
        "HEAD 789aaa",
        "detached",
      ].join("\n");
      expect(parseWorktreeList(stdout)).toEqual([
        { path: "/path/main", branch: "refs/heads/main" },
        { path: "/path/staging", branch: "refs/heads/integration-candidate" },
        { path: "/path/detached", branch: null },
      ]);
    });

    it("returns an empty array for empty input", () => {
      expect(parseWorktreeList("")).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// serializeDotenv — projectEnv → sandbox .env (b) materialization
// ---------------------------------------------------------------------------

/**
 * Round-trip through the REAL `dotenv` + `dotenv-expand` libraries. The
 * previous incarnation of this test used a hand-rolled parser that
 * mirrored the serializer's escape table — a "test of self" that
 * silently agreed with serializer bugs. Using the real libraries means
 * the test fails when our output diverges from what production consumers
 * (dotenv-cli, Next.js, etc.) would parse.
 *
 * dotenv-expand v11 mutates the `parsed` object in place and returns
 * `{ parsed }`. The signature accepts `{ parsed, processEnv }`.
 */
function parseWithRealDotenv(
  content: string,
  processEnv: Record<string, string> = {},
): Record<string, string> {
  const parsed = parseDotenv(Buffer.from(content));
  const expanded =
    expandDotenv({ parsed, processEnv } as Parameters<typeof expandDotenv>[0])
      .parsed ?? {};
  return expanded;
}

describe("serializeDotenv", () => {
  it("empty record → empty string", () => {
    expect(serializeDotenv({})).toBe("");
  });

  it("simple key/value emits single-quoted form with trailing newline", () => {
    expect(serializeDotenv({ FOO: "bar" })).toBe("FOO='bar'\n");
  });

  it("backslashes pass through literally (single quotes don't escape)", () => {
    // BLOCKER-1 regression: the prior double-quoted serializer emitted
    // `WINPATH="C:\\Users\\agent"`, which real dotenv read back as
    // `C:\\Users\\agent` (doubled backslashes). Single-quoted form passes
    // backslashes through untouched.
    const out = serializeDotenv({ WINPATH: "C:\\Users\\agent" });
    expect(out).toBe("WINPATH='C:\\Users\\agent'\n");
    expect(parseWithRealDotenv(out).WINPATH).toBe("C:\\Users\\agent");
  });

  it("escapes $ so dotenv-expand doesn't substitute against process.env", () => {
    // BLOCKER-2 regression: previously `TOKEN="$PATH"` was empirically
    // expanded to the host PATH by dotenv-cli's built-in dotenv-expand.
    // The new serializer prepends `\` to every `$`; dotenv-expand strips
    // the backslash and leaves the `$VAR` literal.
    const out = serializeDotenv({ TOKEN: "$PATH-not-expanded" });
    expect(out).toBe("TOKEN='\\$PATH-not-expanded'\n");
    expect(
      parseWithRealDotenv(out, { PATH: "/usr/bin:/bin" }).TOKEN,
    ).toBe("$PATH-not-expanded");
  });

  it("escapes $ in bcrypt-style hashes (real-world case)", () => {
    const hash = "$2b$12$Kix5/qPwYABCDEFGHIJKLMabcdefghijklmnopqrstuvwx";
    const out = serializeDotenv({ BCRYPT_HASH: hash });
    expect(parseWithRealDotenv(out, {}).BCRYPT_HASH).toBe(hash);
  });

  it("survives values containing = (base64-ish)", () => {
    const out = serializeDotenv({ B64: "abc=def==" });
    expect(parseWithRealDotenv(out).B64).toBe("abc=def==");
  });

  it("survives values containing # (don't parse as comments)", () => {
    const out = serializeDotenv({ HASH: "value#with-hash" });
    expect(parseWithRealDotenv(out).HASH).toBe("value#with-hash");
  });

  it("throws on single-quote-bearing values (not representable)", () => {
    expect(() => serializeDotenv({ KEY: "he said 'hi'" })).toThrow(
      /single quote/,
    );
  });

  it("throws on newline-bearing values", () => {
    expect(() => serializeDotenv({ KEY: "line1\nline2" })).toThrow(/newline/);
  });

  it("throws on keys that aren't valid dotenv identifiers", () => {
    expect(() => serializeDotenv({ "BAD KEY": "x" })).toThrow(/invalid key/);
    expect(() => serializeDotenv({ "1STARTS_NUMERIC": "x" })).toThrow(
      /invalid key/,
    );
  });

  it("round-trips a realistic multi-key project env through the real-consumer parser", () => {
    const record = {
      POSTGRES_URL:
        "postgresql://user:p@ss%23word@localhost:5432/db?sslmode=require",
      AUTH_SECRET: "ABCdef==/+random",
      NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      AIRTABLE_API_KEY: "patABC.def123",
      WEBHOOK_SIGNING: "whsec_$abc$def",
    };
    expect(parseWithRealDotenv(serializeDotenv(record))).toEqual(
      record,
    );
  });

  it("empty value round-trips as empty", () => {
    const out = serializeDotenv({ EMPTY: "" });
    expect(parseWithRealDotenv(out)).toEqual({ EMPTY: "" });
  });

  it("inner whitespace inside single quotes is preserved", () => {
    const out = serializeDotenv({ PAD: "  needstrim  " });
    expect(parseWithRealDotenv(out).PAD).toBe("  needstrim  ");
  });

  it("trailing backslash round-trips literally", () => {
    const out = serializeDotenv({ TRAIL: "x\\" });
    expect(parseWithRealDotenv(out).TRAIL).toBe("x\\");
  });

  it("embedded ${VAR} stays literal (escaped $)", () => {
    const out = serializeDotenv({ LIT: "${FOO}-suffix" });
    expect(
      parseWithRealDotenv(out, { FOO: "should-not-substitute" }).LIT,
    ).toBe("${FOO}-suffix");
  });
});

// ---------------------------------------------------------------------------
// buildDefaultDeps writeProjectDotenv hook — structural assertions on the
// shell command that materializes `.env` inside the sandbox at boot.
// ---------------------------------------------------------------------------

describe("buildDefaultDeps writeProjectDotenv hook", () => {
  const cmd = WRITE_PROJECT_DOTENV_COMMAND;

  it("creates the file with mode 0o600 atomically (no separate chmod)", () => {
    // Either `0o600` or its decimal equivalent (384) is acceptable in the
    // serialized command string.
    expect(/0o600|384/.test(cmd)).toBe(true);
    expect(cmd.includes("mode")).toBe(true);
    expect(cmd.includes("chmod 600")).toBe(false);
  });

  it("backs up an existing .env to .env.sandcastle-bak.<ts> before writing", () => {
    expect(cmd.includes("existsSync")).toBe(true);
    expect(cmd.includes("renameSync")).toBe(true);
    // The literal `'.sandcastle-bak.'` is concatenated with `p` (= `.env`)
    // at runtime; assert the suffix literal that appears in the command.
    expect(cmd.includes(".sandcastle-bak.")).toBe(true);
  });

  it("writes from process.env.SANDCASTLE_PROJECT_DOTENV via writeFileSync", () => {
    expect(cmd.includes("writeFileSync")).toBe(true);
    expect(cmd.includes("process.env.SANDCASTLE_PROJECT_DOTENV")).toBe(true);
  });

  it("does NOT use a shell redirect to .env", () => {
    // The user's global CLAUDE.md forbids shell-redirect-to-.env; that
    // pattern is what destroyed a `.env` on a VPS once. The node -e form
    // routes the bytes through fs.writeFileSync instead.
    expect(cmd.includes("> .env")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractCategorySweep — reviewer CATEGORY SWEEP block parser
// ---------------------------------------------------------------------------

describe("extractCategorySweep", () => {
  it("parses a clean sweep with all three statuses", () => {
    const stdout = [
      "Review prose ...",
      "",
      "CATEGORY SWEEP:",
      "- Spec fit: ok",
      "- Test coverage: n/a (no new test files)",
      "- Type safety: missing return annotation on getUser at line 42",
      "SWEEP COMPLETE.",
      "",
      "HAS_BLOCKERS",
    ].join("\n");
    const sweep = extractCategorySweep(stdout);
    expect(sweep).not.toBeNull();
    expect(sweep!.get("spec fit")).toBe("ok");
    expect(sweep!.get("test coverage")).toBe("n/a");
    expect(sweep!.get("type safety")).toBe("finding");
  });

  it("returns null when CATEGORY SWEEP: marker is missing", () => {
    expect(extractCategorySweep("Some review prose.\nHAS_BLOCKERS")).toBeNull();
  });

  it("returns null when SWEEP COMPLETE. marker is missing (truncated)", () => {
    const stdout = "CATEGORY SWEEP:\n- Spec fit: ok\n[output cut here]";
    expect(extractCategorySweep(stdout)).toBeNull();
  });

  it("treats verbatim template placeholders as unparsable (skipped)", () => {
    // Reviewer pasted the example shape instead of filling it in.
    const stdout = [
      "CATEGORY SWEEP:",
      "- Spec fit: <ok | n/a (...) | <finding>>",
      "- Type safety: ok",
      "SWEEP COMPLETE.",
    ].join("\n");
    const sweep = extractCategorySweep(stdout);
    expect(sweep).not.toBeNull();
    expect(sweep!.has("spec fit")).toBe(false);
    expect(sweep!.get("type safety")).toBe("ok");
  });

  it("returns null on a sweep block with no valid lines", () => {
    const stdout = [
      "CATEGORY SWEEP:",
      "- Spec fit: <ok | n/a (...) | <finding>>",
      "SWEEP COMPLETE.",
    ].join("\n");
    expect(extractCategorySweep(stdout)).toBeNull();
  });

  // Adversarial: a reviewer hedging with `ok — but actually X is broken` used
  // to silently classify as ok because the regex was `/^ok[\s.,]/`. The new
  // strict parser treats anything after `ok` other than `.` or `(...)` as a
  // finding — the reviewer's complaint isn't lost.
  it("`ok — actually there's a bug` classifies as a finding, not ok", () => {
    const stdout = [
      "CATEGORY SWEEP:",
      "- Type safety: ok — actually there's a bug at line 42",
      "SWEEP COMPLETE.",
    ].join("\n");
    expect(extractCategorySweep(stdout)!.get("type safety")).toBe("finding");
  });

  it("`ok, but worth noting X` classifies as a finding", () => {
    const stdout = [
      "CATEGORY SWEEP:",
      "- Spec fit: ok, but missing the refine() per spec",
      "SWEEP COMPLETE.",
    ].join("\n");
    expect(extractCategorySweep(stdout)!.get("spec fit")).toBe("finding");
  });

  it("`ok (parenthetical explanation)` stays classified as ok", () => {
    const stdout = [
      "CATEGORY SWEEP:",
      "- Spec fit: ok (acceptance criteria fully covered)",
      "- Test coverage: ok.",
      "SWEEP COMPLETE.",
    ].join("\n");
    const sweep = extractCategorySweep(stdout)!;
    expect(sweep.get("spec fit")).toBe("ok");
    expect(sweep.get("test coverage")).toBe("ok");
  });

  it("`n/a — actually this matters` classifies as a finding, not n/a", () => {
    const stdout = [
      "CATEGORY SWEEP:",
      "- Security: n/a — wait, the new endpoint takes user input",
      "SWEEP COMPLETE.",
    ].join("\n");
    expect(extractCategorySweep(stdout)!.get("security")).toBe("finding");
  });

  it("compact `<finding text>` notation classifies as a finding, not skipped", () => {
    // Previously the placeholder-skip rule ate any value wrapped in <...>,
    // silently dropping real findings written in compact form. Now only the
    // literal template placeholder is skipped.
    const stdout = [
      "CATEGORY SWEEP:",
      "- Type safety: <missing return type on toggle helper>",
      "SWEEP COMPLETE.",
    ].join("\n");
    expect(extractCategorySweep(stdout)!.get("type safety")).toBe("finding");
  });

  it("ignores prose mentions of `CATEGORY SWEEP:` before the real block", () => {
    // `indexOf` on the bare string would lock onto the prose mention and
    // try to parse review prose as bullets. Line-anchored matching skips it.
    const stdout = [
      "I'll discuss the CATEGORY SWEEP: block below in detail.",
      "Review prose continues here.",
      "",
      "CATEGORY SWEEP:",
      "- Spec fit: ok",
      "- Test coverage: missing tests for the new branch",
      "SWEEP COMPLETE.",
    ].join("\n");
    const sweep = extractCategorySweep(stdout)!;
    expect(sweep.get("spec fit")).toBe("ok");
    expect(sweep.get("test coverage")).toBe("finding");
  });

  it("ignores prose mentions of `SWEEP COMPLETE.` AFTER the real block", () => {
    // Conversely, a prose mention after the real block shouldn't matter
    // because parsing already terminated at the first SWEEP COMPLETE.
    const stdout = [
      "CATEGORY SWEEP:",
      "- Type safety: ok",
      "SWEEP COMPLETE.",
      "",
      "Note: the SWEEP COMPLETE. marker above is the load-bearing one.",
    ].join("\n");
    expect(extractCategorySweep(stdout)!.get("type safety")).toBe("ok");
  });

  it("tolerates a bolded header `**CATEGORY SWEEP:**`", () => {
    const stdout = [
      "**CATEGORY SWEEP:**",
      "- Spec fit: ok",
      "SWEEP COMPLETE.",
    ].join("\n");
    expect(extractCategorySweep(stdout)!.get("spec fit")).toBe("ok");
  });

  it("tolerates a mixed-case header `Category Sweep:`", () => {
    const stdout = [
      "Category Sweep:",
      "- Spec fit: ok",
      "Sweep complete.",
    ].join("\n");
    expect(extractCategorySweep(stdout)!.get("spec fit")).toBe("ok");
  });

  it("tolerates a trailing space before the header colon", () => {
    const stdout = [
      "CATEGORY SWEEP :",
      "- Spec fit: ok",
      "SWEEP COMPLETE.",
    ].join("\n");
    expect(extractCategorySweep(stdout)!.get("spec fit")).toBe("ok");
  });

  it("strips markdown emphasis from a bolded category name", () => {
    const stdout = [
      "CATEGORY SWEEP:",
      "- **Spec fit**: ok",
      "SWEEP COMPLETE.",
    ].join("\n");
    const sweep = extractCategorySweep(stdout)!;
    expect(sweep.has("spec fit")).toBe(true);
    expect(sweep.get("spec fit")).toBe("ok");
    // No leftover asterisks in the key.
    expect([...sweep.keys()].some((k) => k.includes("*"))).toBe(false);
  });

  it("splits on the LAST `: ` so category names containing a colon parse", () => {
    const stdout = [
      "CATEGORY SWEEP:",
      "- Type safety (RFC: 1234): ok",
      "SWEEP COMPLETE.",
    ].join("\n");
    const sweep = extractCategorySweep(stdout)!;
    expect(sweep.get("type safety (rfc: 1234)")).toBe("ok");
  });

  it("duplicate category, weaker first → strictest replaces existing", () => {
    const logs: string[] = [];
    const stdout = [
      "CATEGORY SWEEP:",
      "- Spec fit: ok",
      "- Spec fit: missing the refine() per spec",
      "SWEEP COMPLETE.",
    ].join("\n");
    const sweep = extractCategorySweep(stdout, (m) => logs.push(m))!;
    expect(sweep.get("spec fit")).toBe("finding");
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("spec fit");
    expect(logs[0]).toContain("ok");
    expect(logs[0]).toContain("finding");
  });

  it("duplicate category, stronger first → existing kept, still logs", () => {
    const logs: string[] = [];
    const stdout = [
      "CATEGORY SWEEP:",
      "- Spec fit: missing the refine() per spec",
      "- Spec fit: ok",
      "SWEEP COMPLETE.",
    ].join("\n");
    const sweep = extractCategorySweep(stdout, (m) => logs.push(m))!;
    expect(sweep.get("spec fit")).toBe("finding");
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("spec fit");
    expect(logs[0]).toContain("ok");
    expect(logs[0]).toContain("finding");
  });

  it("mid-block prose echo of `SWEEP COMPLETE.` does NOT terminate parsing", () => {
    // Reviewer's finding body mentions the marker mid-text; the
    // terminator regex requires the whole trimmed line to match, so
    // parsing continues to the real terminator.
    const stdout = [
      "CATEGORY SWEEP:",
      "- Type safety: finding — body mentions SWEEP COMPLETE. but mid-line",
      "- Spec fit: ok",
      "SWEEP COMPLETE.",
    ].join("\n");
    const sweep = extractCategorySweep(stdout)!;
    expect(sweep.get("type safety")).toBe("finding");
    expect(sweep.get("spec fit")).toBe("ok");
  });
});

// Build a minimal reviewer stdout that includes a CATEGORY SWEEP block.
// `findings` is a map of category → finding text (omit a category to mark
// it `ok`). All categories listed in the active reviewer prompt appear.
function reviewerStdoutWithSweep(opts: {
  prose?: string;
  findings: Record<string, string>;
  marker: "ALL_CLEAR" | "HAS_BLOCKERS";
}): string {
  const categories = [
    "Execution evidence",
    "Spec fit",
    "Test coverage",
    "Type safety",
    "Security",
    "Error handling",
    "Edge cases",
  ];
  const lines: string[] = [];
  if (opts.prose) lines.push(opts.prose, "");
  lines.push("CATEGORY SWEEP:");
  for (const cat of categories) {
    const lookup = cat.toLowerCase();
    const finding = opts.findings[lookup];
    lines.push(`- ${cat}: ${finding ?? "ok"}`);
  }
  lines.push("SWEEP COMPLETE.", "", opts.marker);
  return lines.join("\n");
}

describe("priorFindingsResolved", () => {
  it("true: every round-1 finding is ok-or-n/a in round 2 (no overlap)", () => {
    const r1 = new Map([
      ["spec fit", "finding" as const],
      ["test coverage", "ok" as const],
    ]);
    const r2 = new Map([
      ["spec fit", "ok" as const],
      ["test coverage", "ok" as const],
      ["type safety", "finding" as const], // a NEW finding — grant round 3
    ]);
    expect(priorFindingsResolved(r1, r2)).toBe(true);
  });

  it("false: same category still flagged in round 2 — implementer is stuck", () => {
    const r1 = new Map([["type safety", "finding" as const]]);
    const r2 = new Map([["type safety", "finding" as const]]);
    expect(priorFindingsResolved(r1, r2)).toBe(false);
  });

  it("false: round-1 category absent from round-2 sweep (conservative)", () => {
    const r1 = new Map([["security", "finding" as const]]);
    const r2 = new Map([["spec fit", "ok" as const]]);
    expect(priorFindingsResolved(r1, r2)).toBe(false);
  });

  it("false: round 1 had only ok/n/a — empty sweep1 is NOT evidence of progress", () => {
    // Previously this case granted vacuously. New policy: an empty
    // sweep1 (no structured findings to clear) means we have no
    // positive evidence the implementer made progress, so we deny
    // the third attempt instead of gifting a freebie.
    const r1 = new Map([
      ["spec fit", "ok" as const],
      ["test coverage", "n/a" as const],
    ]);
    const r2 = new Map([["type safety", "finding" as const]]);
    expect(priorFindingsResolved(r1, r2)).toBe(false);
  });

  it("false: completely empty sweep1 → deny", () => {
    const r1 = new Map<string, "ok" | "n/a" | "finding">();
    const r2 = new Map([["spec fit", "finding" as const]]);
    expect(priorFindingsResolved(r1, r2)).toBe(false);
  });

  it("n/a in round 2 counts as resolved for a round-1 finding", () => {
    const r1 = new Map([["test coverage", "finding" as const]]);
    const r2 = new Map([
      ["test coverage", "n/a" as const],
      ["security", "finding" as const],
    ]);
    expect(priorFindingsResolved(r1, r2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Third-attempt grant — pipeline integration
// ---------------------------------------------------------------------------
// Regression for the #151 pattern: round 1 finds bug A, implementer fixes A,
// round 2 finds bug B that was always there. Without the grant, the ticket
// bounces to needs-human even though the implementer made real progress. With
// the grant, the loop tries once more and often ships.

describe("sandcastle-loop main.mts — third-attempt grant", () => {
  it("ships after round 3 when round 2's findings are in different categories than round 1", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "151", title: "scope toggle", branch: "agent/issue-151" },
      ]),
    });
    // Round 1: type-safety finding.
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 151 }),
      commits: [{ sha: "round1" }],
    });
    b.enqueue("reviewer", {
      stdout: reviewerStdoutWithSweep({
        findings: { "type safety": "missing return type on toggle helper" },
        marker: "HAS_BLOCKERS",
      }),
    });
    // Round 2: implementer fixed type-safety, reviewer surfaces a NEW
    // category (spec fit). priorFindingsResolved → true → grant round 3.
    b.enqueue("implementer-retry", {
      stdout: implementerStdout({ ghIssue: 151 }),
      commits: [{ sha: "round2" }],
    });
    b.enqueue("reviewer-retry", {
      stdout: reviewerStdoutWithSweep({
        findings: { "spec fit": "missing .refine() per acceptance criteria" },
        marker: "HAS_BLOCKERS",
      }),
    });
    // Round 3: implementer fixes spec-fit, reviewer ships.
    b.enqueue("implementer-retry-2", {
      stdout: implementerStdout({ ghIssue: 151 }),
      commits: [{ sha: "round3" }],
    });
    b.enqueue("reviewer-retry-2", {
      stdout: reviewerStdoutWithSweep({ findings: {}, marker: "ALL_CLEAR" }),
    });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([151]);
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.marksDone).toHaveLength(1);
    const names = b.state.runCalls.map((c) => c.spec.name);
    expect(names).toContain("implementer-retry-2");
    expect(names).toContain("reviewer-retry-2");
  });

  it("round 3 still HAS_BLOCKERS → quarantines (deferral counter reset, ship blocked)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "159", title: "round-3-fails", branch: "agent/issue-159" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 159 }),
      commits: [{ sha: "r1" }],
    });
    b.enqueue("reviewer", {
      stdout: reviewerStdoutWithSweep({
        findings: { "type safety": "missing return type" },
        marker: "HAS_BLOCKERS",
      }),
    });
    // Round 2: type-safety resolved, new spec-fit finding → grants round 3.
    b.enqueue("implementer-retry", {
      stdout: implementerStdout({ ghIssue: 159 }),
      commits: [{ sha: "r2" }],
    });
    b.enqueue("reviewer-retry", {
      stdout: reviewerStdoutWithSweep({
        findings: { "spec fit": "missing acceptance criterion" },
        marker: "HAS_BLOCKERS",
      }),
    });
    // Round 3 implementer runs but reviewer-retry-2 still finds an issue.
    b.enqueue("implementer-retry-2", {
      stdout: implementerStdout({ ghIssue: 159 }),
      commits: [{ sha: "r3" }],
    });
    b.enqueue("reviewer-retry-2", {
      stdout: reviewerStdoutWithSweep({
        findings: { security: "fresh issue uncovered on attempt 3" },
        marker: "HAS_BLOCKERS",
      }),
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([]);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(159);
    expect(b.state.quarantines[0]!.reason).toMatch(/third attempt/);
    // Issue F: round-3 quarantine carries the implementer-retry path token.
    expect(b.state.quarantines[0]!.reason).toContain("path=implementer-retry");
    // Round 3 actually ran (regression guard).
    const names = b.state.runCalls.map((c) => c.spec.name);
    expect(names).toContain("implementer-retry-2");
    expect(names).toContain("reviewer-retry-2");
  });

  it("quarantines after round 2 when the same category still has a finding (implementer is stuck)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "152", title: "stuck issue", branch: "agent/issue-152" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 152 }),
      commits: [{ sha: "round1" }],
    });
    b.enqueue("reviewer", {
      stdout: reviewerStdoutWithSweep({
        findings: { "type safety": "missing return type" },
        marker: "HAS_BLOCKERS",
      }),
    });
    b.enqueue("implementer-retry", {
      stdout: implementerStdout({ ghIssue: 152 }),
      commits: [{ sha: "round2" }],
    });
    // Round 2: SAME category still flagged → no round 3, quarantine.
    b.enqueue("reviewer-retry", {
      stdout: reviewerStdoutWithSweep({
        findings: {
          "type safety": "still missing return type, plus a new cast bug",
        },
        marker: "HAS_BLOCKERS",
      }),
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([]);
    expect(b.state.quarantines).toHaveLength(1);
    expect(b.state.quarantines[0]!.issueNum).toBe(152);
    expect(b.state.quarantines[0]!.reason).toMatch(/escalated retry/);
    // Issue F: escalated-retry quarantine carries the critique-retry path token.
    expect(b.state.quarantines[0]!.reason).toContain("path=critique-retry");
    // Crucially: no third attempt was made.
    const names = b.state.runCalls.map((c) => c.spec.name);
    expect(names).not.toContain("implementer-retry-2");
  });

  it("quarantines after round 2 when either sweep is missing (conservative fallback)", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "153", title: "no sweep", branch: "agent/issue-153" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 153 }),
      commits: [{ sha: "round1" }],
    });
    // Reviewer emits HAS_BLOCKERS without a CATEGORY SWEEP block. The
    // grant logic must NOT fire — a missing sweep should never produce
    // a free extra retry.
    b.enqueue("reviewer", {
      stdout: "Plain prose review, no sweep block.\nHAS_BLOCKERS",
    });
    b.enqueue("implementer-retry", {
      stdout: implementerStdout({ ghIssue: 153 }),
      commits: [{ sha: "round2" }],
    });
    b.enqueue("reviewer-retry", {
      stdout: "Still broken, also no sweep.\nHAS_BLOCKERS",
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(b.state.quarantines).toHaveLength(1);
    const names = b.state.runCalls.map((c) => c.spec.name);
    expect(names).not.toContain("implementer-retry-2");
  });
});

// Issue F: each terminal outcome is annotated with the prompt-leg path it
// traversed (path=first-pass-only | critique-retry | implementer-retry),
// partitioned by the reviewer pass that decided the outcome.
describe("sandcastle-loop main.mts — prompt-leg path annotation (Issue F)", () => {
  it("ships on reviewer attempt 1 ALL_CLEAR → path=first-pass-only", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "401", title: "first pass", branch: "agent/issue-401" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 401 }),
      commits: [{ sha: "fp" }],
    });
    b.enqueue("reviewer", { stdout: "ok\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([401]);
    expect(
      b.state.logs.some(
        (l) => l.includes("[issue=401]") && l.includes("path=first-pass-only"),
      ),
    ).toBe(true);
  });

  it("ships on reviewer attempt 2 ALL_CLEAR → path=critique-retry", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "402", title: "critique retry", branch: "agent/issue-402" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 402 }),
      commits: [{ sha: "r1" }],
    });
    // Reviewer attempt 1 blocks → escalate to implementer + reviewer attempt 2.
    b.enqueue("reviewer", { stdout: "needs work\n\nHAS_BLOCKERS" });
    b.enqueue("implementer-retry", {
      stdout: implementerStdout({ ghIssue: 402 }),
      commits: [{ sha: "r2" }],
    });
    b.enqueue("reviewer-retry", { stdout: "fixed\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([402]);
    expect(
      b.state.logs.some(
        (l) => l.includes("[issue=402]") && l.includes("path=critique-retry"),
      ),
    ).toBe(true);
  });

  it("ships on reviewer attempt 3 ALL_CLEAR → path=implementer-retry", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "403", title: "round 3", branch: "agent/issue-403" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 403 }),
      commits: [{ sha: "r1" }],
    });
    b.enqueue("reviewer", {
      stdout: reviewerStdoutWithSweep({
        findings: { "type safety": "missing return type" },
        marker: "HAS_BLOCKERS",
      }),
    });
    // Round 2 resolves type safety but surfaces a NEW category → grants round 3.
    b.enqueue("implementer-retry", {
      stdout: implementerStdout({ ghIssue: 403 }),
      commits: [{ sha: "r2" }],
    });
    b.enqueue("reviewer-retry", {
      stdout: reviewerStdoutWithSweep({
        findings: { "spec fit": "missing acceptance criterion" },
        marker: "HAS_BLOCKERS",
      }),
    });
    // Round 3 ships.
    b.enqueue("implementer-retry-2", {
      stdout: implementerStdout({ ghIssue: 403 }),
      commits: [{ sha: "r3" }],
    });
    b.enqueue("reviewer-retry-2", {
      stdout: reviewerStdoutWithSweep({ findings: {}, marker: "ALL_CLEAR" }),
    });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([403]);
    expect(
      b.state.logs.some(
        (l) =>
          l.includes("[issue=403]") && l.includes("path=implementer-retry"),
      ),
    ).toBe(true);
  });
});

// Issue E unit tests for the pure blocked-by helpers.
describe("parseBlockedBy", () => {
  it("extracts a single `Blocked by: #N` directive", () => {
    expect(parseBlockedBy("Do the thing.\n\nBlocked by: #313\n")).toEqual([313]);
  });

  it("accepts the hyphenated `Blocked-by:` spelling, case-insensitively", () => {
    expect(parseBlockedBy("BLOCKED-BY: #42")).toEqual([42]);
    expect(parseBlockedBy("blocked by: #7")).toEqual([7]);
  });

  it("captures multiple blockers on one directive line, deduped + sorted", () => {
    expect(parseBlockedBy("Blocked by: #314, #313 and #313")).toEqual([
      313, 314,
    ]);
  });

  it("returns [] when there is no directive (a bare `#5` reference is ignored)", () => {
    expect(parseBlockedBy("See #5 for context.")).toEqual([]);
    expect(parseBlockedBy("")).toEqual([]);
  });
});

describe("buildBlockedByNote", () => {
  it("surfaces a ready-for-agent issue blocked by a still-open (non-ready) blocker", () => {
    const note = buildBlockedByNote([
      {
        number: 316,
        body: "Blocked by: #313",
        labels: ["ready-for-agent"],
      },
      { number: 313, body: "foundation", labels: ["in-progress"] },
    ]);
    expect(note).toBe(
      " (note: #316 is ready-for-agent but blocked by #313 (open))",
    );
  });

  it("returns '' when the blocker is not in the open set (closed)", () => {
    const note = buildBlockedByNote([
      { number: 316, body: "Blocked by: #313", labels: ["ready-for-agent"] },
    ]);
    expect(note).toBe("");
  });

  it("ignores blocked-by directives on issues that aren't ready-for-agent", () => {
    const note = buildBlockedByNote([
      { number: 200, body: "Blocked by: #199", labels: ["in-progress"] },
      { number: 199, body: "x", labels: ["in-progress"] },
    ]);
    expect(note).toBe("");
  });
});

describe("runMain — restart on .sandcastle/** change", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "scrr-"));
    // Lay down the tracked files the detector will snapshot at runMain start.
    mkdirSync(path.join(tmpRoot, ".sandcastle/lib/migrations"), { recursive: true });
    writeFileSync(path.join(tmpRoot, ".sandcastle/main.mts"), "// stub\n");
    writeFileSync(path.join(tmpRoot, ".sandcastle/models.ts"), "// stub\n");
    writeFileSync(path.join(tmpRoot, ".sandcastle/providers.ts"), "// stub\n");
    writeFileSync(
      path.join(tmpRoot, ".sandcastle/lib/migrations/drizzle-applier.ts"),
      "// v1\n",
    );
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("exits 75 with remaining-iterations file after a tracked file changes between iterations", async () => {
    const args = baseArgs({ iterations: 10, repoRoot: tmpRoot });
    const builder = buildDeps({
      iterationStartHook: (it: number) => {
        if (it === 1) {
          // Simulate a recovery commit landing while the orchestrator was
          // starting up: mutate a tracked file so the detector fires before
          // the planner even runs on this first iteration.
          writeFileSync(
            path.join(tmpRoot, ".sandcastle/lib/migrations/drizzle-applier.ts"),
            "// v2 — recovery fix\n",
          );
        }
      },
    });
    // No planner outcome needed — the detector fires before the planner runs.

    const result = await runMain(args, builder.deps);

    // Plan said iterationsRun=1, marker="9" (hook at it=2 after iteration 1
    // completed). Empty-plan path returns exitCode 0 before reaching iteration
    // 2, so the hook fires at it=1 instead. Zero iterations completed; the
    // marker holds the full remaining count.
    expect(result.exitCode).toBe(75);
    expect(result.iterationsRun).toBe(0);
    const markerPath = path.join(tmpRoot, ".sandcastle/.restart-remaining");
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf8").trim()).toBe("10");
  });

  it("does NOT exit 75 when no tracked file changes", async () => {
    const args = baseArgs({ iterations: 2, repoRoot: tmpRoot });
    const builder = buildDeps({});
    builder.enqueue("planner", { stdout: plannerStdout([]) });
    builder.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(args, builder.deps);

    expect(result.exitCode).toBe(0);
    expect(
      existsSync(path.join(tmpRoot, ".sandcastle/.restart-remaining")),
    ).toBe(false);
  });

  it("honors SANDCASTLE_REMAINING_ITERATIONS env var as override for --iterations", () => {
    const prev = process.env.SANDCASTLE_REMAINING_ITERATIONS;
    process.env.SANDCASTLE_REMAINING_ITERATIONS = "7";
    try {
      const { args } = parseSandcastleArgs(["--iterations", "100"]);
      expect(args.iterations).toBe(7);
    } finally {
      if (prev === undefined) delete process.env.SANDCASTLE_REMAINING_ITERATIONS;
      else process.env.SANDCASTLE_REMAINING_ITERATIONS = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Critique-as-gate / skill-discipline weave (ADR 0006 v3 / v3.2)
//
// These exercise the orchestrator-side weave added to main.mts:
//   1. runImplementer's per-issue skill-discipline HARD gate (throw →
//      MissingRequiredSkillsError → skill-discipline-fail quarantine).
//   2. runImplementer's REQUIRED_SKILLS prompt-arg linkage.
//   3. The post-merge-fixer WARN-only union telemetry shape.
// Pure-library coverage (findLoadableRubrics, critiqueErrorReasonCode,
// parseRequiredSkillsByType, validateRequiredSkillsInvoked, etc.) lives in
// tests/skill-discipline.test.ts — the template splits orchestrator-behavior
// tests (here) from library-unit tests (there), so those blocks are NOT
// duplicated into this file.
// ---------------------------------------------------------------------------

/** Write a session JSONL fixture whose assistant turns each carry one
 *  `Skill(<name>)` tool_use block — the shape
 *  extractSkillInvocationsFromSession parses. */
function writeSessionJsonl(
  dir: string,
  name: string,
  skills: readonly string[],
): string {
  const p = path.join(dir, name);
  const lines: string[] = [];
  for (const s of skills) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Skill", input: { skill: s } }],
        },
      }),
    );
  }
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

/** Build a minimal SandboxHandle whose `run()` returns a RunHandle pointing
 *  at the given JSONL fixture. runImplementer doesn't care about commits
 *  (attempt 2 path) or stdout shape (rebuttal/halt branches skip parsing),
 *  so both are minimal. attemptNumber=2 bypasses `requireCommits` — the gate
 *  runs BEFORE it anyway, but skipping it keeps the fixture simpler. */
function makeMockSandbox(sessionFilePath: string): SandboxHandle {
  const handle: RunHandle = {
    stdout: "<rebuttal>noop</rebuttal>",
    commits: [],
    iterations: [{ sessionFilePath }],
  };
  return {
    branch: "agent/issue-1",
    run: async () => handle,
    close: async () => undefined,
  };
}

/** Minimal Deps for runImplementer. The implementer only touches `log` and
 *  `logError` (no rate-limit thrown), so the remaining stubs are unused but
 *  must satisfy the type. */
function makeNoopDeps(): Deps {
  const unused = (): Promise<never> => {
    throw new Error("noop dep called");
  };
  return {
    run: unused,
    createSandbox: unused,
    claim: unused,
    markDone: unused,
    markMergedToStaging: unused,
    promoteStagingToDone: unused,
    quarantine: unused,
    release: unused,
    comment: unused,
    listIssuesByLabel: unused,
    listOpenIssuesWithBodies: unused,
    applyMigrations: unused,
    validateMigrationJournal: unused,
    captureSha: unused,
    log: () => undefined,
    logError: () => undefined,
  };
}

function skillGateArgs(): SandcastleArgs {
  return {
    iterations: 1,
    repoRoot: "/repo",
    branch: "main",
    label: "ready-for-agent",
    maxConcurrent: 1,
    plannerModel: "stub-planner",
    implementerModel: "stub-implementer",
    reviewerModel: "stub-reviewer",
    critiqueModel: "stub-critique",
    mergerModel: "stub-merger",
    postMergeReviewerModel: "stub-pmr",
    recoveryModel: "stub-recovery",
    implementerTimeoutSec: 60,
    reviewerTimeoutSec: 60,
    hardCeilingSec: 60,
    consecutiveFailureLimit: 5,
    dryRun: true,
    recoveryEnabled: false,
    retryEnabled: true,
    stagingEnabled: false,
  } as SandcastleArgs;
}

describe("runImplementer skill-discipline gate", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sc-skill-gate-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws MissingRequiredSkillsError when the session JSONL lacks a required Skill() invocation (re-promoted per ADR 0006 v3)", async () => {
    // Per ADR 0006 v3, the per-issue skill-discipline gate is RE-PROMOTED
    // from telemetry-only (v1) back to throw → quarantine. Critique-as-
    // gate silently abstains on issues whose required principles lack
    // SKILL.md rubric files, so the skill-discipline gate is the hard
    // backstop. This test verifies the gate throws and carries the
    // structured missing/invoked/required/issueNumber fields the
    // orchestrator's quarantine path consumes.
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", ["impeccable"]);
    const sandbox = makeMockSandbox(jsonl);
    const issue: PlanIssue = {
      id: "1",
      title: "test issue",
      branch: "agent/issue-1",
    };
    const ctx = {
      args: skillGateArgs(),
      deps: makeNoopDeps(),
      iteration: 1,
      issueNumber: 42,
      issue,
      requiredSkills: ["impeccable", "polish"] as readonly string[],
    };
    await expect(
      runImplementer(sandbox, ctx, {
        attemptNumber: 2, // bypass requireCommits
        requiredSkills: ctx.requiredSkills,
      }),
    ).rejects.toThrowError(MissingRequiredSkillsError);

    // Re-run to inspect the thrown error's structured fields.
    let caught: unknown;
    try {
      await runImplementer(sandbox, ctx, {
        attemptNumber: 2,
        requiredSkills: ctx.requiredSkills,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MissingRequiredSkillsError);
    const err = caught as MissingRequiredSkillsError;
    expect(err.missing).toEqual(["polish"]);
    expect(err.invoked).toEqual(["impeccable"]);
    expect(err.required).toEqual(["impeccable", "polish"]);
    expect(err.issueNumber).toBe(42);
  });

  it("does not throw when all required Skill() invocations are present", async () => {
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", [
      "impeccable",
      "polish",
    ]);
    const sandbox = makeMockSandbox(jsonl);
    const issue: PlanIssue = {
      id: "1",
      title: "test issue",
      branch: "agent/issue-1",
    };
    const ctx = {
      args: skillGateArgs(),
      deps: makeNoopDeps(),
      iteration: 1,
      issueNumber: 1,
      issue,
    };
    const r = await runImplementer(sandbox, ctx, {
      attemptNumber: 2,
      requiredSkills: ["impeccable", "polish"],
    });
    expect(r.skillsInvoked).toEqual(["impeccable", "polish"]);
  });

  it("does not throw when opts.requiredSkills is undefined (backward compat for projects without SANDCASTLE.md)", async () => {
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", ["impeccable"]);
    const sandbox = makeMockSandbox(jsonl);
    const issue: PlanIssue = {
      id: "1",
      title: "test issue",
      branch: "agent/issue-1",
    };
    const ctx = {
      args: skillGateArgs(),
      deps: makeNoopDeps(),
      iteration: 1,
      issueNumber: 1,
      issue,
    };
    const r = await runImplementer(sandbox, ctx, { attemptNumber: 2 });
    expect(r.skillsInvoked).toEqual(["impeccable"]);
  });

  it("does not throw when opts.requiredSkills is empty (type:cleanup case)", async () => {
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", []);
    const sandbox = makeMockSandbox(jsonl);
    const issue: PlanIssue = {
      id: "1",
      title: "test issue",
      branch: "agent/issue-1",
    };
    const ctx = {
      args: skillGateArgs(),
      deps: makeNoopDeps(),
      iteration: 1,
      issueNumber: 1,
      issue,
    };
    const r = await runImplementer(sandbox, ctx, {
      attemptNumber: 2,
      requiredSkills: [],
    });
    expect(r.skillsInvoked).toEqual([]);
  });
});

describe("runImplementer REQUIRED_SKILLS prompt-arg linkage (ADR 0006 v3.2)", () => {
  // The v3 re-promotion turned skill-discipline into a hard throw, but the
  // implementer prompt didn't tell the model the rule changed. v3.2 closes
  // the loop: the prompt now reads {{REQUIRED_SKILLS}} and instructs the
  // model to invoke Skill(<name>) for each principle. These tests verify the
  // orchestrator-side wiring — that opts.requiredSkills reaches the
  // implementer's promptArgs as a comma-joined string — so future refactors
  // can't silently break the linkage.

  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sc-prompt-args-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Sandbox whose `run()` captures the opts it was called with so tests can
   *  assert on promptArgs. Returns a successful no-op iteration so the rest
   *  of runImplementer (skill extraction, gate validation) sees a
   *  fully-invoked principle set and doesn't throw before we check args. */
  function makeCapturingSandbox(
    sessionFilePath: string,
  ): SandboxHandle & { captured: Record<string, unknown>[] } {
    const captured: Record<string, unknown>[] = [];
    const handle: RunHandle = {
      stdout: "<rebuttal>noop</rebuttal>",
      commits: [],
      iterations: [{ sessionFilePath }],
    };
    const sb: SandboxHandle = {
      branch: "agent/issue-1",
      run: async (opts) => {
        captured.push(opts as unknown as Record<string, unknown>);
        return handle;
      },
      close: async () => undefined,
    };
    return Object.assign(sb, { captured });
  }

  it("threads opts.requiredSkills into promptArgs as comma-joined REQUIRED_SKILLS", async () => {
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", [
      "impeccable",
      "layout",
      "clarify",
      "polish",
      "glass-morphism",
      "context7-docs",
    ]);
    const sandbox = makeCapturingSandbox(jsonl);
    const ctx = {
      args: skillGateArgs(),
      deps: makeNoopDeps(),
      iteration: 1,
      issueNumber: 310,
      issue: {
        id: "310",
        title: "10-Item soft cap",
        branch: "agent/issue-310",
      },
    };
    await runImplementer(sandbox, ctx, {
      attemptNumber: 2,
      requiredSkills: [
        "impeccable",
        "layout",
        "clarify",
        "polish",
        "glass-morphism",
        "context7-docs",
      ],
    });
    expect(sandbox.captured).toHaveLength(1);
    const promptArgs = sandbox.captured[0]?.promptArgs as Record<
      string,
      string
    >;
    expect(promptArgs.REQUIRED_SKILLS).toBe(
      "impeccable, layout, clarify, polish, glass-morphism, context7-docs",
    );
  });

  it("passes REQUIRED_SKILLS='' when opts.requiredSkills is undefined (no SANDCASTLE.md)", async () => {
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", []);
    const sandbox = makeCapturingSandbox(jsonl);
    const ctx = {
      args: skillGateArgs(),
      deps: makeNoopDeps(),
      iteration: 1,
      issueNumber: 1,
      issue: { id: "1", title: "test", branch: "agent/issue-1" },
    };
    await runImplementer(sandbox, ctx, { attemptNumber: 2 });
    expect(sandbox.captured).toHaveLength(1);
    const promptArgs = sandbox.captured[0]?.promptArgs as Record<
      string,
      string
    >;
    expect(promptArgs.REQUIRED_SKILLS).toBe("");
  });

  it("passes REQUIRED_SKILLS='' when opts.requiredSkills is an empty list (type:cleanup case)", async () => {
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", []);
    const sandbox = makeCapturingSandbox(jsonl);
    const ctx = {
      args: skillGateArgs(),
      deps: makeNoopDeps(),
      iteration: 1,
      issueNumber: 1,
      issue: { id: "1", title: "test", branch: "agent/issue-1" },
    };
    await runImplementer(sandbox, ctx, {
      attemptNumber: 2,
      requiredSkills: [],
    });
    expect(sandbox.captured).toHaveLength(1);
    const promptArgs = sandbox.captured[0]?.promptArgs as Record<
      string,
      string
    >;
    expect(promptArgs.REQUIRED_SKILLS).toBe("");
  });
});

describe("post-merge fixer skill-discipline union (telemetry helper)", () => {
  // The post-merge fixer gate is WARN-only telemetry (ADR 0006 extended).
  // The union-compute logic is exercised — host code uses it to format the
  // WARN log — so we keep this thin shape assertion on
  // validateRequiredSkillsInvoked over a UNION-style input. Nothing throws.
  it("computes missing skills from the UNION across rollup issues", () => {
    const issueRequirements: Array<readonly string[]> = [
      ["impeccable"],
      ["polish"],
    ];
    const fixerInvoked: readonly string[] = ["impeccable"];
    const unionSet = new Set<string>();
    const union: string[] = [];
    for (const req of issueRequirements) {
      for (const s of req) {
        if (unionSet.has(s)) continue;
        unionSet.add(s);
        union.push(s);
      }
    }
    expect(union).toEqual(["impeccable", "polish"]);
    const { missing } = validateRequiredSkillsInvoked(union, fixerInvoked);
    expect(missing).toEqual(["polish"]);
  });
});
