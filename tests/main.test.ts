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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  runMain,
  runImplementer,
  runCritique,
  shipAfterMigrations,
  parsePlan,
  parseBlockedBy,
  buildBlockedByNote,
  parseSandcastleArgs,
  preflight,
  loadDotenv,
  isTransientServerError,
  isOutputCapError,
  maxOutputTokensEnv,
  ensureStagingWorktree,
  fastForwardIntegration,
  detectChangedLockfiles,
  hasLintScript,
  commitMessageHasLintCert,
  classifyLintCert,
  createRunLogAppender,
  hasCodeDiff,
  parseWorktreeList,
  findWorktreeForBranch,
  serializeDotenv,
  oauthTokenEnv,
  ghTokenEnv,
  extractCategorySweep,
  priorFindingsResolved,
  resolveReviewBase,
  runGitLeaseRetrying,
  isTransientLeaseGitFailure,
  buildDefaultDeps,
  type GitRunResult,
  WRITE_PROJECT_DOTENV_COMMAND,
  REGISTER_CONTEXT7_MCP_COMMAND,
  STAGE_CODEX_AGENTS_MD_COMMAND,
  __resetTransientStateForTests,
  __setStagingWorktreePathForTests,
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
  deriveRunBranchAndId,
  syncStatusOnce,
} from "../.sandcastle/lib/status/run-sync.js";
import {
  MissingRequiredSkillsError,
  validateRequiredSkillsInvoked,
  CritiqueCriticalError,
  critiqueErrorReasonCode,
} from "../.sandcastle/lib/skill-discipline.js";
import { envForModel } from "../.sandcastle/providers.js";
import {
  VerdictParseError,
  MarkerNotFoundError,
} from "../.sandcastle/lib/verdicts/index.js";
import { createStatusStore } from "../.sandcastle/lib/status/store.js";
import {
  LeaseReadError,
  LeaseBackendError,
  createLeaseCoordinator,
  createGitLockBackend,
  createLaneSync,
  createStatusSync,
  resolveLeaseState,
} from "../.sandcastle/lib/state/index.js";
import type { LockLease, LockBackend, LockDeps } from "../.sandcastle/lib/state/index.js";
import type { SandcastleStatus } from "../.sandcastle/lib/status/schema.js";
import { parse as parseDotenv } from "dotenv";
import { expand as expandDotenv } from "dotenv-expand";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Shared no-op status stub for the PipelineCtx literals these tests build by
// hand. The functions exercised here (runImplementer / runCritique /
// shipAfterMigrations) never read ctx.status — only runIssuePipeline/runMain do
// — so this exists purely to satisfy the `readonly status: StatusStore` field.
// The no-op writeFn guarantees these tests never touch disk.
const testStatusStore = createStatusStore(
  {
    branch: "test",
    repo: "test",
    repoRoot: "/tmp",
    startedAt: "2026-01-01T00:00:00.000Z",
    iterationsTotal: 1,
    maxConcurrent: 1,
    hostId: "test-host",
    runId: "test-run",
  },
  { writeFn: () => {} },
);

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
  lintCertChecks: { repoRoot: string; preSha: string; postSha: string }[];
  testCertChecks: { repoRoot: string; preSha: string; postSha: string }[];
  logs: string[];
  errors: string[];
  // Cross-host issue lease (ADR 0019) — the fake records every lease call so
  // the orchestration (gate / release points / reconciliation) can be asserted
  // without a real git backend (which is proven in tests/issue-lease.test.ts).
  leaseAcquires: number[];
  leaseReleases: number[];
  leaseStateCalls: number[];
  leaseRenews: number;
  leaseReleaseAllCalls: number;
  leaseFences: number[];
  // Cross-host LANE SYNC (ADR 0019, Task B) — record every sync/publish call so
  // the flag-off invariant (must be EMPTY) and the two-loop E2E can be asserted
  // without a real git remote (lane-sync.ts is proven in tests/lane-sync.test.ts).
  syncLanesCalls: { branch: string; launchWorktreePath: string }[];
  publishLaneCalls: string[];
  // Cross-host STATUS SYNC (Task S5) — record publish/fetch calls so the
  // flag-off invariant (must be EMPTY) and the per-iteration trigger can be
  // asserted without a real git remote (status-sync.ts is proven separately).
  publishStatusCalls: string[];
  fetchStatusPeersCalls: string[];
  // Ordered event log across mock deps so tests can assert RELATIVE ordering
  // (e.g. lane publish must fire AFTER the Phase-3 merger lands the work on the
  // launch branch, not before). Each recorder pushes a marker onto this array.
  eventOrder: string[];
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
    lintCertChecks: [],
    testCertChecks: [],
    logs: [],
    errors: [],
    leaseAcquires: [],
    leaseReleases: [],
    leaseStateCalls: [],
    leaseRenews: 0,
    leaseReleaseAllCalls: 0,
    leaseFences: [],
    syncLanesCalls: [],
    publishLaneCalls: [],
    publishStatusCalls: [],
    fetchStatusPeersCalls: [],
    eventOrder: [],
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
  /** Stub return for the lint-gate backstop checkLintCert. Defaults to
   *  "dormant" so existing tests are unaffected (the gate is a no-op).
   *  Lint-gate tests set "pass" or "missing" to exercise it. */
  lintCertStatus?: "pass" | "missing" | "dormant";
  /** Stub return for the test-gate backstop checkTestCert. Defaults to
   *  "dormant" so existing tests are unaffected (the gate is a no-op).
   *  Test-gate tests set "pass" or "missing" to exercise it. */
  testCertStatus?: "pass" | "missing" | "dormant";
  /** Cross-host lease (ADR 0019): default win/lose for acquireIssueLease.
   *  Defaults to `true` so existing tests (flag OFF) claim as before. */
  leaseAcquireWins?: boolean;
  /** Per-issue override for acquireIssueLease; wins over leaseAcquireWins. */
  leaseAcquireFor?: (issueNum: number) => boolean;
  /** Default leaseState result. Defaults to "absent" (no ref). */
  leaseStateValue?: "absent" | "live" | "expired";
  /** Per-issue override for leaseState; wins over leaseStateValue. */
  leaseStateFor?: (issueNum: number) => "absent" | "live" | "expired";
  /** Cross-host lease (ADR 0019) Fix 3: default fenceIssue result. Defaults to
   *  `true` (host still holds the lease) so ship proceeds unchanged. */
  leaseFenceValue?: boolean;
  /** Per-issue override for fenceIssue; wins over leaseFenceValue. */
  leaseFenceFor?: (issueNum: number) => boolean;
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
      if (spec.name === "merger") state.eventOrder.push("merger");
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
    async checkLintCert(repoRoot, preSha, postSha) {
      // Default: "dormant" (gate no-op) so existing tests are unaffected.
      // Lint-gate tests set opts.lintCertStatus to "pass" / "missing".
      state.lintCertChecks.push({ repoRoot, preSha, postSha });
      return { status: opts.lintCertStatus ?? "dormant" };
    },
    async checkTestCert(repoRoot, preSha, postSha) {
      // Default: "dormant" (gate no-op) so existing tests are unaffected.
      // Test-gate tests set opts.testCertStatus to "pass" / "missing".
      state.testCertChecks.push({ repoRoot, preSha, postSha });
      return { status: opts.testCertStatus ?? "dormant" };
    },
    async captureSha(_w) {
      const v = shas[shaIdx % shas.length] ?? "sha-x";
      shaIdx += 1;
      return v;
    },
    async acquireIssueLease(n) {
      state.leaseAcquires.push(n);
      if (opts.leaseAcquireFor) return opts.leaseAcquireFor(n);
      return opts.leaseAcquireWins ?? true;
    },
    async releaseIssueLease(n) {
      state.leaseReleases.push(n);
    },
    async leaseState(n) {
      state.leaseStateCalls.push(n);
      if (opts.leaseStateFor) return opts.leaseStateFor(n);
      return opts.leaseStateValue ?? "absent";
    },
    async renewLeases() {
      state.leaseRenews += 1;
    },
    async releaseAllLeases() {
      state.leaseReleaseAllCalls += 1;
    },
    async fenceIssue(n) {
      state.leaseFences.push(n);
      if (opts.leaseFenceFor) return opts.leaseFenceFor(n);
      return opts.leaseFenceValue ?? true;
    },
    // Cross-host LANE SYNC (ADR 0019, Task B). Default recorders: return an
    // empty sync (no peers) and a no-op publish. Two-loop E2E tests override
    // these on `b.deps` to route through a shared in-memory lane store.
    async syncLanes(branch, launchWorktreePath) {
      state.syncLanesCalls.push({ branch, launchWorktreePath });
      return { peers: [] };
    },
    async publishLane(branch) {
      state.publishLaneCalls.push(branch);
      state.eventOrder.push("publishLane");
    },
    // Cross-host STATUS SYNC (Task S5). Default recorders: publish succeeds,
    // no peers. Tests override on `b.deps` to assert the syncStatusOnce trigger.
    async publishStatus(snapshotJson) {
      state.publishStatusCalls.push(snapshotJson);
      return { ok: true };
    },
    async fetchStatusPeers(runId) {
      state.fetchStatusPeersCalls.push(runId);
      return [];
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
    runId: "feature/work",
    label: "ready-for-agent",
    maxConcurrent: 3,
    imageName: "sandcastle:affinity-tracker",
    plannerModel: "claude-opus-4-8",
    implementerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-haiku-4-5",
    critiqueModel: "claude-haiku-4-5",
    mergerModel: "claude-opus-4-8",
    postMergeReviewerModel: "claude-opus-4-8",
    recoveryModel: "claude-opus-4-8",
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

describe("sandcastle-loop main.mts — post-merge reviewer stall / no-verdict retry", () => {
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

  it("no verdict on first attempt (no marker) + ALL_CLEAR on retry → no quarantine, issue ships", async () => {
    // Regression for affinity-tracker #475: the reviewer ran but ended its
    // single turn WITHOUT emitting a marker ("…standing by for the suite
    // result before issuing the verdict"). extractMarker throws
    // MarkerNotFoundError — which is NOT stall-shaped — so the stall-only
    // retry never fired and a clean integration was quarantined. A
    // no-verdict turn is now treated like a stall: retry once on the same
    // model before giving up.
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "475", title: "deferred verdict", branch: "agent/issue-475" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 475 }),
      commits: [{ sha: "good-sha" }],
    });
    b.enqueue("reviewer", { stdout: "ok\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    // First post-merge attempt defers instead of verdicting — no marker
    // anywhere in the output, so extractMarker throws MarkerNotFoundError.
    b.enqueue("post-merge-reviewer", {
      stdout:
        "Reviewing the integration. I've set up a blocking waiter; standing " +
        "by for the api suite result before issuing the verdict.",
    });
    // Retry produces a real verdict.
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([475]);
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.marksDone.map((m) => m.issueNum)).toEqual([475]);
    // Two post-merge-reviewer calls prove the no-verdict retry actually fired.
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

describe("sandcastle-loop main.mts — pre-merge reviewer / critique no-verdict retry + defer", () => {
  // Turn-exhaustion returns partial output with no completion marker, so
  // extractMarker throws MarkerNotFoundError — which is NOT stall-shaped and
  // NOT a code rejection. The pre-merge reviewer now retries once on the same
  // model (mirroring the post-merge reviewer); a persistent no-verdict routes
  // to the `deferred` category (release for a fresh iteration), bounded by
  // MAX_DEFERRALS before real quarantine. HAS_BLOCKERS still drives the
  // existing escalation ladder — the retry must not soften real rejections.

  it("reviewer no verdict on attempt 1 + ALL_CLEAR on same-model retry → ships, no quarantine", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "300", title: "no-verdict then clean", branch: "agent/issue-300" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 300 }),
      commits: [{ sha: "c1" }],
    });
    // Attempt 1 ends its turn without a marker (extractMarker throws).
    b.enqueue("reviewer", {
      stdout: "Still running the suite; I'll issue the verdict once it finishes.",
    });
    // Same-model retry produces a real verdict.
    b.enqueue("reviewer", { stdout: "ok\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([300]);
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.releases).toEqual([]);
    expect(b.state.marksDone.map((m) => m.issueNum)).toEqual([300]);
    // Two "reviewer" calls prove the same-model retry actually fired.
    const reviewerCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "reviewer",
    );
    expect(reviewerCalls).toHaveLength(2);
  });

  it("reviewer no verdict TWICE (attempt 1 + retry) → deferred (released), NOT quarantined", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "301", title: "persistent no verdict", branch: "agent/issue-301" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 301 }),
      commits: [{ sha: "c1" }],
    });
    // Attempt 1 no verdict, same-model retry ALSO no verdict → propagates.
    b.enqueue("reviewer", { stdout: "still standing by for the suite result" });
    b.enqueue("reviewer", { stdout: "still standing by — no verdict yet" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false, recoveryEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([]);
    // Deferred, not quarantined: the label is released for a fresh iteration.
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.releases.map((r) => r.issueNum)).toEqual([301]);
    expect(b.state.marksDone).toEqual([]);
    // Two reviewer calls (attempt + retry), then it gives up and defers.
    const reviewerCalls = b.state.runCalls.filter(
      (c) => c.spec.name === "reviewer",
    );
    expect(reviewerCalls).toHaveLength(2);
  });

  it("persistent no verdict across iterations → quarantines only after MAX_DEFERRALS (3) deferrals", async () => {
    const b = buildDeps();
    // Iterations 1..4 each re-claim #302 (planner re-emits it), the reviewer
    // never verdicts (attempt + retry both marker-less), so iters 1..3 defer
    // and iter 4 (defer budget exhausted) quarantines. Iter 5 exits on empty.
    for (let i = 0; i < 4; i++) {
      b.enqueue("planner", {
        stdout: plannerStdout([
          { id: "302", title: "always no verdict", branch: "agent/issue-302" },
        ]),
      });
      b.enqueue("implementer", {
        stdout: implementerStdout({ ghIssue: 302 }),
        commits: [{ sha: `c${i}` }],
      });
      b.enqueue("reviewer", { stdout: "no verdict this pass (attempt)" });
      b.enqueue("reviewer", { stdout: "no verdict this pass (retry)" });
    }
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 5, stagingEnabled: false, recoveryEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([]);
    // Exactly MAX_DEFERRALS (3) releases, then the 4th attempt quarantines.
    expect(b.state.releases.map((r) => r.issueNum)).toEqual([302, 302, 302]);
    expect(b.state.quarantines.map((q) => q.issueNum)).toEqual([302]);
    expect(b.state.marksDone).toEqual([]);
  });

  it("reviewer HAS_BLOCKERS on attempt 1 → escalation ladder, NOT the no-verdict retry", async () => {
    // Regression guard: a real rejection must NOT be re-dispatched on the same
    // model as a no-verdict would be. HAS_BLOCKERS escalates the implementer +
    // reviewer (the "reviewer-retry" leg), so the plain "reviewer" name fires
    // exactly once and a distinct escalated leg follows.
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "303", title: "real blocker", branch: "agent/issue-303" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 303 }),
      commits: [{ sha: "c1" }],
    });
    b.enqueue("reviewer", { stdout: "Real problem here.\n\nHAS_BLOCKERS" });
    // Escalation ladder: implementer attempt 2 (escalated model, distinct run
    // name) then the escalated reviewer-retry leg.
    b.enqueue("implementer-retry", {
      stdout: implementerStdout({ ghIssue: 303 }),
      commits: [{ sha: "c2" }],
    });
    b.enqueue("reviewer-retry", { stdout: "fixed now\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([303]);
    expect(b.state.releases).toEqual([]);
    // The plain reviewer (attempt 1) fires exactly once — no same-model
    // no-verdict re-dispatch — and the escalated "reviewer-retry" follows.
    const plainReviewer = b.state.runCalls.filter(
      (c) => c.spec.name === "reviewer",
    );
    const escalatedReviewer = b.state.runCalls.filter(
      (c) => c.spec.name === "reviewer-retry",
    );
    expect(plainReviewer).toHaveLength(1);
    expect(escalatedReviewer).toHaveLength(1);
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
    expect(r.args.implementerModel).toBe("claude-opus-4-8");
    expect(r.args.reviewerModel).toBe("claude-haiku-4-5");
    expect(r.args.recoveryModel).toBe("claude-opus-4-8");
    expect(r.args.recoveryEnabled).toBe(true);
    expect(r.args.consecutiveFailureLimit).toBe(3);
  });
});

describe("sandcastle-loop main.mts — runId / run-branch derivation", () => {
  // The cross-host rule: all hosts on ONE shared queue derive the SAME runId
  // (the pre-hostId-suffix branch name), while run.branch stays host-distinct
  // for git safety.
  it("lease ON, auto-derived branch: branch is host-suffixed, runId is the bare derived name", () => {
    const r = deriveRunBranchAndId(undefined, "nightly", true, "hostA");
    expect(r.runId).toBe("nightly");
    expect(r.branch).toBe("nightly-hostA");
  });

  it("lease OFF, auto-derived branch: runId equals branch equals derived (byte-for-byte legacy)", () => {
    const r = deriveRunBranchAndId(undefined, "nightly", false, "hostA");
    expect(r.runId).toBe("nightly");
    expect(r.branch).toBe("nightly");
  });

  it("explicit --branch: runId equals branch equals the explicit value, never suffixed even with lease ON", () => {
    const r = deriveRunBranchAndId("release/1.2", "release/1.2", true, "hostA");
    expect(r.runId).toBe("release/1.2");
    expect(r.branch).toBe("release/1.2");
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

  it("isOutputCapError matches output-token-cap shapes case-insensitively", () => {
    const positive = [
      "max_tokens reached",
      "Requested 50000 tokens exceeds the maximum output tokens of 32000",
      "the response exceeds the maximum output tokens",
      "output too long",
      "OUTPUT TOO LONG to render",
      "Claude's response exceeded the maximum output token limit",
      "claudes response exceeded the limit", // apostrophe-less variant
    ];
    for (const msg of positive) {
      expect(isOutputCapError(msg)).toBe(true);
    }
    const negative = [
      "agent crashed",
      "implementer made no commits",
      "rate_limit_error",
      "The server had an error while processing your request",
      "reviewer marked HAS_BLOCKERS",
      "a token was found in the config", // "token" alone must not match
      "the output of the test was wrong", // "output" alone must not match
      "this exceeds the budget", // "exceeds" alone must not match
      // Permanent-error guard: a permanent-error slug must short-circuit to
      // false even if cap-ish phrasing appears alongside it.
      "invalid_api_key",
      // Audit #2 rework: these are PERMANENT errors, not output-cap. Retrying
      // can't fix an oversized HTTP payload or a too-high config value, so
      // they must NOT be deferred/retried under isOutputCapError.
      "HTTP 413: Payload exceeds the maximum allowed size", // unrelated to output tokens
      "max_tokens: 65536 exceeds the maximum of 32768", // too-high config, not a runtime truncation
      // Moved from the positive set: a too-high-config validation error
      // (config asked for more max_tokens than the model allows) is a
      // permanent config error, not a genuine output-cap/truncation.
      '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 4096 > 8192, the maximum"}}',
    ];
    for (const msg of negative) {
      expect(isOutputCapError(msg)).toBe(false);
    }
  });

  it("maxOutputTokensEnv sets a default only when unset/blank", () => {
    // Unset → default applied.
    expect(maxOutputTokensEnv({})).toEqual({
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
    });
    // Blank → treated as unset, default applied.
    expect(maxOutputTokensEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "   " })).toEqual(
      { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" },
    );
    // Explicit user value → never clobbered.
    expect(
      maxOutputTokensEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" }),
    ).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" });
  });

  it("maxOutputTokensEnv honors a value set only in the project .env, not just process.env (audit #2 rework)", () => {
    // Real call-site bug: containerEnv used to call `...maxOutputTokensEnv()`
    // with NO arg (process.env only), even though projectEnv (the target
    // repo's `.env`/`.env.local`, via readProjectEnv) is spread into
    // containerEnv first. A value present ONLY in projectEnv — not
    // process.env — was invisible to the function and got overwritten by
    // the 32000 default, contradicting the docstring's "never clobbered"
    // claim. The fix takes projectEnv as an explicit second parameter so
    // the call site can pass it through.
    const projectEnv: Record<string, string> = {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "96000",
    };
    const shellEnv: NodeJS.ProcessEnv = {}; // process.env: NOT set here

    expect(maxOutputTokensEnv(shellEnv, projectEnv)).toEqual({
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "96000",
    });

    // Shell-wins precedence (house style — mirrors ghTokenEnv being spread
    // last at the containerEnv call site so a fresh shell/host token wins
    // over a stale project-.env value): when BOTH set it, the shell value
    // wins.
    expect(
      maxOutputTokensEnv(
        { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "12000" },
        projectEnv,
      ),
    ).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "12000" });
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

describe("sandcastle-loop main.mts — branch-base preflight gate", () => {
  // Worker worktrees are cut from the launch checkout's CURRENT HEAD, not from
  // --branch, and fastForwardIntegration advances --branch through the worktree
  // that has it checked out. So the launch checkout must be ATTACHED to --branch,
  // not merely at the same commit: `git branch <run> <base>` with no checkout
  // leaves HEAD attached to <base> at the shared tip, which a SHA-equality check
  // would wave through (the affinity-tracker branch-base trap). The gate is a
  // single attachment model over `git symbolic-ref --short HEAD` (ADR 0016);
  // there is no SHA-comparison fallback. baseArgs().branch is "feature/work".
  //
  // Mock: symbolic-ref returns the branch HEAD is attached to, or fails =
  // detached. Everything else (gh, docker, dirty-check, …) returns ok so only
  // the branch-base check is exercised.
  function execAttach(attachedBranch: string | null) {
    return (bin: string, a: readonly string[]) => {
      if (bin === "git" && a.includes("symbolic-ref")) {
        return attachedBranch === null
          ? { ok: false, stderr: "fatal: ref HEAD is not a symbolic ref" }
          : { ok: true, stdout: `${attachedBranch}\n` };
      }
      return { ok: true };
    };
  }
  const hasAttachError = (errors: readonly string[]) =>
    errors.some((e) => /on branch '.*', not the --branch/i.test(e));

  it("refuses when HEAD is attached to a DIFFERENT branch (even at the same tip)", () => {
    const res = preflight(baseArgs(), { exec: execAttach("main") });
    expect(res.ok).toBe(false);
    expect(hasAttachError(res.errors)).toBe(true);
  });

  it("passes when HEAD is attached to the --branch (no false positive)", () => {
    const res = preflight(baseArgs(), { exec: execAttach("feature/work") });
    expect(hasAttachError(res.errors)).toBe(false);
  });

  it("refuses on a real detached HEAD (symbolic-ref fails) — can't attach to --branch", () => {
    // execAttach(null) models a real detached HEAD: `git symbolic-ref` exits
    // non-zero. The loop can't advance --branch through a detached worktree, so
    // every promotion would be refused mid-run — refuse at boot instead.
    const res = preflight(baseArgs(), { exec: execAttach(null) });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => /detached HEAD/i.test(e))).toBe(true);
  });

  it("stays inert for the legacy no-stdout exec mock (the shape ~15 other preflight tests use)", () => {
    // Real git always resolves symbolic-ref (attached) or fails it (detached); a
    // bare () => ({ ok: true }) mock returns ok with no stdout, which is neither.
    // The gate must treat that as an inert no-op — otherwise every other preflight
    // test that uses this mock shape (DB-URL, sandbox-image, dirty-check blocks)
    // would trip the attachment or detached refusal and break.
    const res = preflight(baseArgs(), { exec: () => ({ ok: true }) });
    expect(hasAttachError(res.errors)).toBe(false);
    expect(res.errors.some((e) => /detached HEAD/i.test(e))).toBe(false);
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

  // 2026-07-02 scheduler incident: the no-worktree fallback used to `git
  // update-ref` the target branch — advancing the ref while NO working tree
  // tracked it, so the launch checkout (parked on a stale base) kept cutting
  // worker worktrees off the old commit. That is the exact silent-stranding the
  // disk-drift comment warns about. This path is now only reachable once the run
  // branch is already stranded (the branch-base preflight gate keeps the launch
  // worktree ON the run branch in normal operation), so refuse loudly instead of
  // silently advancing an unowned ref.
  it("refuses (no silent update-ref) when the target branch is not checked out anywhere", () => {
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
      const featBefore = git("rev-parse", "refs/heads/feat-x");
      git("checkout", "-q", "main");

      const logs: string[] = [];
      const errors: string[] = [];
      const ok = fastForwardIntegration(
        repoRoot,
        "feat-x",
        (s) => logs.push(s),
        (s) => errors.push(s),
      );

      expect(ok).toBe(false);
      // The ref must NOT have moved — no silent advance of an unowned branch.
      expect(git("rev-parse", "refs/heads/feat-x")).toBe(featBefore);
      // Loud, actionable refusal naming the missing worktree.
      expect(errors.some((e) => e.startsWith("fast-forward refused"))).toBe(true);
      expect(errors.some((e) => /no (live )?worktree/i.test(e))).toBe(true);
      expect(logs.some((l) => l.includes("via worktree merge"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  // A stray uncommitted file in the launch worktree makes `git merge --ff-only`
  // refuse ("local changes would be overwritten") and nothing cleans it, so it
  // silently strands EVERY promotion, iteration after iteration, with only a
  // cryptic git error. fastForwardIntegration must detect the dirty worktree,
  // name the offending file, refuse WITHOUT advancing the branch, and never
  // claim a merge. (The launch worktree is never written by the loop itself —
  // such dirt is pre-existing / out-of-band.)
  it("refuses (naming the file) when the launch worktree has uncommitted changes", () => {
    const { repoRoot, gitEnv, cleanup } = initRepoForFastForward();
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", args, { cwd: repoRoot, env: gitEnv, encoding: "utf8" }).trim();

      git("branch", "feat-x");
      git("branch", "integration-candidate");
      git("checkout", "-q", "integration-candidate");
      writeFileSync(path.join(repoRoot, "staging-file.ts"), "export const S = 1;\n");
      git("add", "staging-file.ts");
      git("commit", "-q", "-m", "staging work");
      const featBefore = git("rev-parse", "refs/heads/feat-x");
      git("checkout", "-q", "feat-x");
      // Leave a stray uncommitted change in the launch worktree (a human's WIP,
      // or an out-of-band write) — the exact condition that stranded promotion.
      writeFileSync(path.join(repoRoot, "README.md"), "WIP local edit\n");

      const logs: string[] = [];
      const errors: string[] = [];
      const ok = fastForwardIntegration(
        repoRoot,
        "feat-x",
        (s) => logs.push(s),
        (s) => errors.push(s),
      );

      expect(ok).toBe(false);
      // The branch must NOT have advanced — nothing half-applied.
      expect(git("rev-parse", "refs/heads/feat-x")).toBe(featBefore);
      // Loud, actionable, and names the offending file.
      expect(
        errors.some((e) => /uncommitted changes/i.test(e) && e.includes("README.md")),
      ).toBe(true);
      // Must NOT have attempted / claimed a merge.
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

  describe("findWorktreeForBranch", () => {
    const stdout = [
      "worktree /path/main",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /path/launch",
      "HEAD def456",
      "branch refs/heads/feature/work",
      "",
      "worktree /path/detached",
      "HEAD 789aaa",
      "detached",
    ].join("\n");

    it("returns the worktree entry whose branch matches refs/heads/<branch>", () => {
      const git = (): GitRunResult => ({ ok: true, stdout, stderr: "" });
      expect(findWorktreeForBranch("/repo", "feature/work", git)).toEqual({
        path: "/path/launch",
        branch: "refs/heads/feature/work",
      });
    });

    it("returns undefined when no worktree has that branch checked out", () => {
      const git = (): GitRunResult => ({ ok: true, stdout, stderr: "" });
      expect(findWorktreeForBranch("/repo", "nope", git)).toBeUndefined();
    });

    it("returns undefined (never throws) when the worktree list fails", () => {
      const git = (): GitRunResult => ({ ok: false, stdout: "", stderr: "boom" });
      expect(findWorktreeForBranch("/repo", "feature/work", git)).toBeUndefined();
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

// Audit issue #4: a failed FINAL fast-forward promotion leaves merged +
// post-merge-certified work stranded on `integration-candidate`, yet the run
// historically still exited `done` / code 0 — a silent lie about success.
// After the fix the run must finish `unhealthy` and exit non-zero so both the
// operator's shell AND the viewer see the failure.
describe("sandcastle-loop main.mts — unhealthy on failed final promotion (#4)", () => {
  function initStagingRepo(): {
    repoRoot: string;
    stagingPath: string;
    gitEnv: NodeJS.ProcessEnv;
    cleanup: () => void;
  } {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "sc-unhealthy-"));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();

    git(repoRoot, "init", "-q", "-b", "main");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(path.join(repoRoot, "README.md"), "hello\n");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-q", "-m", "init");
    // The integration branch the loop promotes onto, and the staging branch it
    // certifies on. `feature/work` matches baseArgs().branch.
    git(repoRoot, "branch", "feature/work");
    git(repoRoot, "branch", "integration-candidate");
    // Dedicated staging worktree on integration-candidate (what boot would set
    // up). Place it OUTSIDE repoRoot so the loop's own .sandcastle path is clean.
    const stagingPath = mkdtempSync(path.join(tmpdir(), "sc-unhealthy-staging-"));
    rmSync(stagingPath, { recursive: true, force: true });
    git(repoRoot, "worktree", "add", "-q", stagingPath, "integration-candidate");
    return {
      repoRoot,
      stagingPath,
      gitEnv,
      cleanup: () => {
        rmSync(repoRoot, { recursive: true, force: true });
        rmSync(stagingPath, { recursive: true, force: true });
      },
    };
  }

  it("finishes `unhealthy` and exits non-zero when the final FF refuses", async () => {
    const { repoRoot, stagingPath, gitEnv, cleanup } = initStagingRepo();
    try {
      __setStagingWorktreePathForTests(stagingPath);

      const b = buildDeps();
      b.enqueue("planner", {
        stdout: plannerStdout([
          { id: "71", title: "smoke", branch: "agent/issue-71" },
        ]),
      });
      b.enqueue("implementer", {
        stdout: implementerStdout({ ghIssue: 71 }),
        commits: [{ sha: "abc123" }],
      });
      b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
      b.enqueue("merger", { stdout: "merged" });
      b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });

      // The merger runs AFTER `resetStagingToIntegrationTip` (which makes
      // staging == integration) and BEFORE the final fast-forward. Have the
      // merger side-effect advance `feature/work` (the integration branch) with
      // a brand-new commit via a throwaway worktree. Staging is then NO LONGER
      // an ancestor of integration → divergence; with no live worktree on
      // `feature/work`, the final fast-forward REFUSES → promotionFailed.
      const realRun = b.deps.run.bind(b.deps);
      b.deps.run = async (spec) => {
        const handle = await realRun(spec);
        if (spec.name === "merger") {
          const wt = mkdtempSync(path.join(tmpdir(), "sc-unhealthy-divert-"));
          rmSync(wt, { recursive: true, force: true });
          const git = (cwd: string, ...args: string[]): string =>
            execFileSync("git", args, {
              cwd,
              env: gitEnv,
              encoding: "utf8",
            }).trim();
          git(repoRoot, "worktree", "add", "-q", wt, "feature/work");
          writeFileSync(path.join(wt, "operator.ts"), "export const OP = 1;\n");
          git(wt, "add", "operator.ts");
          git(wt, "commit", "-q", "-m", "operator hotfix — diverges integration");
          git(repoRoot, "worktree", "remove", "--force", wt);
        }
        return handle;
      };

      const result = await runMain(
        baseArgs({ iterations: 1, repoRoot, stagingEnabled: true }),
        b.deps,
      );

      // The run must NOT report success.
      expect(result.exitCode).not.toBe(0);
      // The status feed's terminal state must be `unhealthy`, not `done`.
      const statusRaw = readFileSync(
        path.join(repoRoot, ".sandcastle", "status.json"),
        "utf8",
      );
      const status = JSON.parse(statusRaw) as SandcastleStatus;
      expect(status.state).toBe("unhealthy");
      // And the failure must be logged loudly.
      expect(
        b.state.errors.some((l) => l.includes("final promotion")),
      ).toBe(true);
    } finally {
      __setStagingWorktreePathForTests("");
      cleanup();
    }
  });

  // Regression for the "merged 47m ago but its code isn't on the branch" lie:
  // under staging a reviewer-certified issue was counted/shown `merged` at SHIP
  // time, before the promotion fast-forward. When that FF strands the work, the
  // dashboard kept claiming `merged`. After the fix, stranded work is NOT
  // counted merged and is flagged for a human instead.
  it("does NOT count stranded work as merged when the final FF refuses", async () => {
    const { repoRoot, stagingPath, gitEnv, cleanup } = initStagingRepo();
    try {
      __setStagingWorktreePathForTests(stagingPath);

      const b = buildDeps();
      b.enqueue("planner", {
        stdout: plannerStdout([
          { id: "71", title: "smoke", branch: "agent/issue-71" },
        ]),
      });
      b.enqueue("implementer", {
        stdout: implementerStdout({ ghIssue: 71 }),
        commits: [{ sha: "abc123" }],
      });
      b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
      b.enqueue("merger", { stdout: "merged" });
      b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });

      // Same divergence trick as the unhealthy test → the final FF refuses,
      // stranding #71 on integration-candidate.
      const realRun = b.deps.run.bind(b.deps);
      b.deps.run = async (spec) => {
        const handle = await realRun(spec);
        if (spec.name === "merger") {
          const wt = mkdtempSync(path.join(tmpdir(), "sc-strand-divert-"));
          rmSync(wt, { recursive: true, force: true });
          const git = (cwd: string, ...args: string[]): string =>
            execFileSync("git", args, {
              cwd,
              env: gitEnv,
              encoding: "utf8",
            }).trim();
          git(repoRoot, "worktree", "add", "-q", wt, "feature/work");
          writeFileSync(path.join(wt, "operator.ts"), "export const OP = 1;\n");
          git(wt, "add", "operator.ts");
          git(wt, "commit", "-q", "-m", "operator hotfix — diverges integration");
          git(repoRoot, "worktree", "remove", "--force", wt);
        }
        return handle;
      };

      await runMain(
        baseArgs({ iterations: 1, repoRoot, stagingEnabled: true }),
        b.deps,
      );

      const status = JSON.parse(
        readFileSync(
          path.join(repoRoot, ".sandcastle", "status.json"),
          "utf8",
        ),
      ) as SandcastleStatus;
      // The core lie the fix kills: stranded work must not be tallied merged.
      expect(status.totals.merged).toBe(0);
      const issue71 = status.issues.find((i) => i.number === 71);
      expect(issue71?.phase).not.toBe("merged");
      expect(issue71?.phase).toBe("needs-human");
      expect(issue71?.attention).toBe(true);
    } finally {
      __setStagingWorktreePathForTests("");
      cleanup();
    }
  });

  // The other half of the same fix: when promotion ACTUALLY lands the work, the
  // deferred merged accounting must still fire — merged is credited after the
  // FF, not lost. Otherwise the fix would trade a false-positive for a
  // false-negative.
  it("counts merged only after the final FF actually promotes", async () => {
    const { repoRoot, stagingPath, gitEnv, cleanup } = initStagingRepo();
    let launchPath = "";
    try {
      __setStagingWorktreePathForTests(stagingPath);
      // A clean live worktree on the integration branch so the FF can advance
      // it (mirrors the real launch worktree). Clean ⇒ the dirty-worktree guard
      // passes and the FF succeeds.
      launchPath = mkdtempSync(path.join(tmpdir(), "sc-strand-launch-"));
      rmSync(launchPath, { recursive: true, force: true });
      execFileSync("git", ["worktree", "add", "-q", launchPath, "feature/work"], {
        cwd: repoRoot,
        env: gitEnv,
        stdio: "ignore",
      });

      const b = buildDeps();
      b.enqueue("planner", {
        stdout: plannerStdout([
          { id: "71", title: "smoke", branch: "agent/issue-71" },
        ]),
      });
      b.enqueue("implementer", {
        stdout: implementerStdout({ ghIssue: 71 }),
        commits: [{ sha: "abc123" }],
      });
      b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
      b.enqueue("merger", { stdout: "merged" });
      b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });

      await runMain(
        baseArgs({ iterations: 1, repoRoot, stagingEnabled: true }),
        b.deps,
      );

      const status = JSON.parse(
        readFileSync(
          path.join(repoRoot, ".sandcastle", "status.json"),
          "utf8",
        ),
      ) as SandcastleStatus;
      expect(status.state).not.toBe("unhealthy");
      expect(status.totals.merged).toBe(1);
      expect(
        status.issues.find((i) => i.number === 71)?.phase,
      ).toBe("merged");
    } finally {
      __setStagingWorktreePathForTests("");
      if (launchPath) {
        try {
          execFileSync(
            "git",
            ["worktree", "remove", "--force", launchPath],
            { cwd: repoRoot, env: gitEnv, stdio: "ignore" },
          );
        } catch {
          /* best-effort cleanup */
        }
      }
      cleanup();
    }
  });

  // Review follow-up: when the FF SUCCEEDS (code shipped) but the GitHub
  // promotion (label flip / close) fails for an issue, that issue must NOT be
  // left in silent `merge` limbo — it is flagged needs-human so a human finishes
  // the stale GitHub state. Regression for the post-FF partial-promote gap.
  it("flags needs-human when the FF lands but GitHub promotion fails for an issue", async () => {
    const { repoRoot, stagingPath, gitEnv, cleanup } = initStagingRepo();
    let launchPath = "";
    try {
      __setStagingWorktreePathForTests(stagingPath);
      launchPath = mkdtempSync(path.join(tmpdir(), "sc-promotefail-launch-"));
      rmSync(launchPath, { recursive: true, force: true });
      execFileSync("git", ["worktree", "add", "-q", launchPath, "feature/work"], {
        cwd: repoRoot,
        env: gitEnv,
        stdio: "ignore",
      });

      const b = buildDeps();
      // The FF will land (clean live worktree on feature/work), but the GitHub
      // promotion reports #71 in `.failed` (a label/close API error).
      b.deps.promoteStagingToDone = async () => ({ failed: [71] });
      b.enqueue("planner", {
        stdout: plannerStdout([
          { id: "71", title: "smoke", branch: "agent/issue-71" },
        ]),
      });
      b.enqueue("implementer", {
        stdout: implementerStdout({ ghIssue: 71 }),
        commits: [{ sha: "abc123" }],
      });
      b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
      b.enqueue("merger", { stdout: "merged" });
      b.enqueue("post-merge-reviewer", { stdout: "POST_MERGE_ALL_CLEAR" });

      await runMain(
        baseArgs({ iterations: 1, repoRoot, stagingEnabled: true }),
        b.deps,
      );

      const status = JSON.parse(
        readFileSync(
          path.join(repoRoot, ".sandcastle", "status.json"),
          "utf8",
        ),
      ) as SandcastleStatus;
      const issue71 = status.issues.find((i) => i.number === 71);
      // Not silently stuck in `merge` limbo, and not falsely counted merged.
      expect(issue71?.phase).toBe("needs-human");
      expect(issue71?.attention).toBe(true);
      expect(status.totals.merged).toBe(0);
    } finally {
      __setStagingWorktreePathForTests("");
      if (launchPath) {
        try {
          execFileSync(
            "git",
            ["worktree", "remove", "--force", launchPath],
            { cwd: repoRoot, env: gitEnv, stdio: "ignore" },
          );
        } catch {
          /* best-effort cleanup */
        }
      }
      cleanup();
    }
  });
});

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
// oauthTokenEnv — subscription token forwarded into the container (ADR 0011).
// The no-op-when-unset behavior is what keeps the Linux/VPS file-mount path
// and API-key setups untouched, so it's asserted alongside the happy path.
// ---------------------------------------------------------------------------

describe("oauthTokenEnv", () => {
  it("forwards CLAUDE_CODE_OAUTH_TOKEN when set", () => {
    expect(oauthTokenEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" })).toEqual(
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" },
    );
  });

  it("is empty when the var is unset (file-mount / API-key path untouched)", () => {
    expect(oauthTokenEnv({})).toEqual({});
  });

  it("is empty when the var is blank or whitespace-only", () => {
    expect(oauthTokenEnv({ CLAUDE_CODE_OAUTH_TOKEN: "" })).toEqual({});
    expect(oauthTokenEnv({ CLAUDE_CODE_OAUTH_TOKEN: "   " })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// ghTokenEnv — GitHub CLI token forwarded into the container. On macOS the gh
// keyring token never reaches the Linux container via the ~/.config/gh mount
// (Keychain-stored, absent from hosts.yml), so in-container `gh` (incl. the
// planner prompt's `!`gh issue list …`` shell-expansion blocks) 401s without
// this forward. No-op-when-unset keeps the Linux/VPS on-disk-token path intact.
// ---------------------------------------------------------------------------

describe("ghTokenEnv", () => {
  it("forwards GH_TOKEN when set", () => {
    expect(ghTokenEnv({ GH_TOKEN: "gho_abc123" })).toEqual({
      GH_TOKEN: "gho_abc123",
    });
  });

  it("is empty when the var is unset (on-disk-token path untouched)", () => {
    expect(ghTokenEnv({})).toEqual({});
  });

  it("is empty when the var is blank or whitespace-only", () => {
    expect(ghTokenEnv({ GH_TOKEN: "" })).toEqual({});
    expect(ghTokenEnv({ GH_TOKEN: "   " })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildDefaultDeps writeProjectDotenv hook — structural assertions on the
// shell command that materializes `.env` inside the sandbox at boot.
// ---------------------------------------------------------------------------

describe("createRunLogAppender — loop run-log (audit Mistake 2)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sc-runlog-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults to <repoRoot>/.sandcastle/run.log and appends each line", () => {
    const append = createRunLogAppender({ repoRoot: tmp });
    append("first line\n");
    append("second line\n");
    const logPath = path.join(tmp, ".sandcastle", "run.log");
    expect(readFileSync(logPath, "utf8")).toBe("first line\nsecond line\n");
  });

  it("honors an explicit logFile override", () => {
    const custom = path.join(tmp, "custom-run.log");
    const append = createRunLogAppender({ repoRoot: tmp, logFile: custom });
    append("hello\n");
    expect(readFileSync(custom, "utf8")).toBe("hello\n");
  });

  it("truncates once per run (each loop starts a fresh log, not append-across-runs)", () => {
    const logPath = path.join(tmp, ".sandcastle", "run.log");
    const first = createRunLogAppender({ repoRoot: tmp });
    first("old run line\n");
    // A second appender = a new run → truncates the prior run's log.
    const second = createRunLogAppender({ repoRoot: tmp });
    second("new run line\n");
    expect(readFileSync(logPath, "utf8")).toBe("new run line\n");
  });

  it("is best-effort: a non-writable path disables file logging without throwing", () => {
    // repoRoot whose parent is a FILE (not a dir) → mkdir fails. The loop must
    // never die on a log-write failure (mirrors the status-store onError path).
    const notADir = path.join(tmp, "iam-a-file");
    writeFileSync(notADir, "x");
    const append = createRunLogAppender({
      repoRoot: path.join(notADir, "nested"),
    });
    expect(() => append("line\n")).not.toThrow();
  });
});

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
// registerContext7Mcp hook — structural assertions on the shell command that
// registers the context7 docs MCP inside the sandbox at boot. The command
// must FAIL CLOSED: inert (no error, no MCP) for any project without
// CONTEXT7_API_KEY, so it can never break an existing slice.
// ---------------------------------------------------------------------------

describe("registerContext7Mcp hook", () => {
  const cmd = REGISTER_CONTEXT7_MCP_COMMAND;

  it("is guarded on a non-empty CONTEXT7_API_KEY (fails closed)", () => {
    // The whole command is wrapped in `if [ -n "$CONTEXT7_API_KEY" ]; ... fi`
    // so a project that hasn't configured the key gets graceful absence.
    expect(cmd.includes('if [ -n "$CONTEXT7_API_KEY" ]')).toBe(true);
    expect(cmd.includes("fi")).toBe(true);
  });

  it("registers context7 as a user-scope HTTP MCP", () => {
    expect(
      cmd.includes("claude mcp add --scope user --transport http context7"),
    ).toBe(true);
    expect(cmd.includes("https://mcp.context7.com/mcp")).toBe(true);
  });

  it("passes the key through the CONTEXT7_API_KEY header", () => {
    expect(cmd.includes('--header "CONTEXT7_API_KEY: $CONTEXT7_API_KEY"')).toBe(
      true,
    );
  });

  it("never errors the boot sequence (|| true, output silenced)", () => {
    // `>/dev/null 2>&1 || true` keeps a failed/duplicate registration from
    // aborting the onSandboxReady chain — the hook is best-effort.
    expect(cmd.includes("|| true")).toBe(true);
    expect(cmd.includes(">/dev/null 2>&1")).toBe(true);
  });

  it("is wired into the onSandboxReady hook array (not merely defined)", () => {
    // The wiring is the entire point of the change: a well-formed command
    // const that no hook references would do nothing. Assert the entry sits
    // inside the onSandboxReady array literal.
    const mainSource = readFileSync(
      path.join(process.cwd(), ".sandcastle", "main.mts"),
      "utf8",
    );
    expect(mainSource).toMatch(
      /onSandboxReady:\s*\[[^\]]*registerContext7Mcp[^\]]*\]/,
    );
  });
});

// ---------------------------------------------------------------------------
// STAGE_CODEX_AGENTS_MD_COMMAND — docker hook that stages the Codex AGENTS.md
// into the worktree. Like the context7 hook it MUST fail closed so a cosmetic
// copy can never abort the onSandboxReady boot chain (ADR 0010).
// ---------------------------------------------------------------------------

describe("STAGE_CODEX_AGENTS_MD_COMMAND hook", () => {
  const cmd = STAGE_CODEX_AGENTS_MD_COMMAND;

  it("no-clobbers: copies only when our source exists and no AGENTS.md is present", () => {
    expect(cmd.includes("[ -f .sandcastle/AGENTS.md ]")).toBe(true);
    expect(cmd.includes("[ ! -f AGENTS.md ]")).toBe(true);
    expect(cmd.includes("cp .sandcastle/AGENTS.md AGENTS.md")).toBe(true);
  });

  it("resolves info/exclude via git (worktree-safe) and git-excludes our copy", () => {
    // `.git` is a FILE in a worktree, so a literal `.git/info/exclude` path
    // fails — must go through `git rev-parse --git-path`.
    expect(cmd.includes("git rev-parse --git-path info/exclude")).toBe(true);
    expect(cmd.includes("echo AGENTS.md >>")).toBe(true);
  });

  it("fails closed (`|| true`) so it can never abort the boot chain", () => {
    expect(cmd.trimEnd().endsWith("|| true")).toBe(true);
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

  it("extracts `#N` refs under a `## Blocked by` markdown header (list + bare)", () => {
    expect(
      parseBlockedBy("Do the thing.\n\n## Blocked by\n- #42\n#43\n"),
    ).toEqual([42, 43]);
  });

  it("accepts `### Blocked by` header at any heading level, case-insensitively", () => {
    expect(parseBlockedBy("### blocked by\n* #7\n")).toEqual([7]);
  });

  it("stops collecting header refs at a blank line or the next heading", () => {
    expect(
      parseBlockedBy("## Blocked by\n- #1\n- #2\n\n#999 unrelated\n"),
    ).toEqual([1, 2]);
    expect(
      parseBlockedBy("## Blocked by\n- #1\n## Notes\n#999 unrelated\n"),
    ).toEqual([1]);
  });

  it("merges header-form and inline-form blockers, deduped + sorted", () => {
    expect(
      parseBlockedBy("Blocked by: #5\n\n## Blocked by\n- #3\n- #5\n"),
    ).toEqual([3, 5]);
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
    checkLintCert: unused,
    checkTestCert: unused,
    captureSha: unused,
    acquireIssueLease: unused,
    releaseIssueLease: unused,
    leaseState: unused,
    renewLeases: unused,
    releaseAllLeases: unused,
    fenceIssue: unused,
    syncLanes: unused,
    publishLane: unused,
    publishStatus: unused,
    fetchStatusPeers: unused,
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
      status: testStatusStore,
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
      status: testStatusStore,
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
      status: testStatusStore,
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
      status: testStatusStore,
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
      status: testStatusStore,
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
      status: testStatusStore,
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
      status: testStatusStore,
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

describe("runImplementer missing-envelope one-shot re-ask (audit #22)", () => {
  // When the implementer emits a real STORY_COMPLETE but DROPS the required
  // fenced ```json``` certification envelope, parseVerdict throws
  // VerdictParseError — a class neither isTransientError nor STALL_RE covers,
  // so the whole pass would be wasted (recovery burn → quarantine, or
  // immediate quarantine under --recovery off). The fix re-runs the
  // implementer ONCE for just the envelope, guarded so it can never recurse
  // more than once.

  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sc-envelope-reask-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A real STORY_COMPLETE assistant message WITH the fenced json envelope. */
  function validEnvelopeStdout(ghIssue: number): string {
    const envelope = {
      storyId: `gh-${ghIssue}`,
      ghIssue,
      e2eVerdict: "passed",
      uiTouched: false,
      certificationPresent: true,
      marker: "STORY_COMPLETE",
      storyType: "backend-only",
      e2eRequired: false,
      e2eActuallyRan: true,
      testCommandUsed: "npm test",
      e2eAssertionLine: "✓ does the thing",
      outputNotFiltered: true,
      testReachedFeature: true,
    };
    return (
      "All done.\n\n```json\n" +
      JSON.stringify(envelope, null, 2) +
      "\n```\n\nSTORY_COMPLETE\n\n<promise>COMPLETE</promise>"
    );
  }

  /** A STORY_COMPLETE message that DROPS the json envelope (the #22 bug). */
  function noEnvelopeStdout(): string {
    return (
      "All done — everything works.\n\nSTORY_COMPLETE\n\n" +
      "<promise>COMPLETE</promise>"
    );
  }

  /** Sandbox whose run() returns a sequence of stdouts (one per call),
   *  records every opts it was invoked with, and points each iteration at a
   *  fully-invoked-skills session JSONL so the skill-discipline gate is inert.
   *  Each call has one commit so attempt-1 requireCommits passes. */
  function makeSequencingSandbox(
    stdouts: readonly string[],
    sessionFilePath: string,
  ): SandboxHandle & { captured: Record<string, unknown>[] } {
    const captured: Record<string, unknown>[] = [];
    let call = 0;
    const sb: SandboxHandle = {
      branch: "agent/issue-1",
      run: async (opts) => {
        captured.push(opts as unknown as Record<string, unknown>);
        const stdout = stdouts[Math.min(call, stdouts.length - 1)] ?? "";
        call += 1;
        return {
          stdout,
          commits: [{ sha: `sha-${call}` }],
          iterations: [{ sessionFilePath }],
        } satisfies RunHandle;
      },
      close: async () => undefined,
    };
    return Object.assign(sb, { captured });
  }

  function baseCtx() {
    return {
      args: skillGateArgs(),
      deps: makeNoopDeps(),
      iteration: 1,
      issueNumber: 22,
      issue: { id: "22", title: "drops envelope", branch: "agent/issue-1" },
      status: testStatusStore,
    };
  }

  it("re-asks exactly ONCE and succeeds when the re-ask returns a valid envelope", async () => {
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", []);
    const sandbox = makeSequencingSandbox(
      [noEnvelopeStdout(), validEnvelopeStdout(22)],
      jsonl,
    );
    const ctx = baseCtx();

    // Must NOT throw — the re-ask returns a valid envelope.
    const r = await runImplementer(sandbox, ctx, { attemptNumber: 1 });
    expect(r.stdout).toMatch(/STORY_COMPLETE/);

    // Exactly two runs: the original + ONE re-ask.
    expect(sandbox.captured).toHaveLength(2);

    // First call: ENVELOPE_REASK is empty (normal pass).
    const firstArgs = sandbox.captured[0]?.promptArgs as Record<string, string>;
    expect(firstArgs.ENVELOPE_REASK).toBe("");

    // Second call: ENVELOPE_REASK is the populated re-ask instruction.
    const secondArgs = sandbox.captured[1]?.promptArgs as Record<
      string,
      string
    >;
    expect(secondArgs.ENVELOPE_REASK).toMatch(/json/i);
    expect(secondArgs.ENVELOPE_REASK).toMatch(/STORY_COMPLETE/);
  });

  it("one-shot guard caps the re-ask at one — a second missing envelope propagates VerdictParseError", async () => {
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", []);
    // Both the original AND the re-ask drop the envelope.
    const sandbox = makeSequencingSandbox(
      [noEnvelopeStdout(), noEnvelopeStdout()],
      jsonl,
    );
    const ctx = baseCtx();

    await expect(
      runImplementer(sandbox, ctx, { attemptNumber: 1 }),
    ).rejects.toThrowError(VerdictParseError);

    // Exactly two runs total — the guard prevented a third (second re-ask).
    expect(sandbox.captured).toHaveLength(2);
    const secondArgs = sandbox.captured[1]?.promptArgs as Record<
      string,
      string
    >;
    expect(secondArgs.ENVELOPE_REASK).toMatch(/json/i);
  });

  it("does NOT re-ask when the first pass already carries a valid envelope", async () => {
    const jsonl = writeSessionJsonl(tmp, "session.jsonl", []);
    const sandbox = makeSequencingSandbox([validEnvelopeStdout(22)], jsonl);
    const ctx = baseCtx();

    await runImplementer(sandbox, ctx, { attemptNumber: 1 });

    // Only ONE run — no re-ask fired.
    expect(sandbox.captured).toHaveLength(1);
    const firstArgs = sandbox.captured[0]?.promptArgs as Record<string, string>;
    expect(firstArgs.ENVELOPE_REASK).toBe("");
  });

  // ── self-defeat regression (the DEFECT this rework fixes) ──────────────
  //
  // The original #22 fix recurses via `return runImplementer(sb, ctx, {
  // ...opts, envelopeReask: true })`. attemptNumber is NOT threaded, so it
  // re-defaults to 1 and requireCommits recomputes to true. A COMPLIANT
  // re-ask only RE-EMITS the envelope: it writes NO new commits and invokes
  // NO skills (the work was already done + certified on the first turn).
  // Pre-fix, that re-ask turn hits the skill-discipline gate (throws
  // MissingRequiredSkillsError) or the no-commits throw ("implementer made
  // no commits") and the issue is wrongly quarantined — the feature
  // self-defeats. Both gates must be skipped on an envelope re-ask.
  //
  // This sandbox controls commits AND the session JSONL PER CALL so the
  // re-ask turn is a genuine compliant re-ask: zero commits, zero skills.
  function makePerCallSandbox(
    turns: readonly { stdout: string; commits: readonly { sha: string }[]; sessionFilePath: string }[],
  ): SandboxHandle & { captured: Record<string, unknown>[] } {
    const captured: Record<string, unknown>[] = [];
    let call = 0;
    const sb: SandboxHandle = {
      branch: "agent/issue-1",
      run: async (opts) => {
        captured.push(opts as unknown as Record<string, unknown>);
        const turn = turns[Math.min(call, turns.length - 1)]!;
        call += 1;
        return {
          stdout: turn.stdout,
          commits: turn.commits,
          iterations: [{ sessionFilePath: turn.sessionFilePath }],
        } satisfies RunHandle;
      },
      close: async () => undefined,
    };
    return Object.assign(sb, { captured });
  }

  it("re-ask with required skills succeeds even though the re-ask makes no commits and invokes no skills (self-defeat regression)", async () => {
    // Turn 1: STORY_COMPLETE without the envelope, BUT the work is done —
    // it committed and it invoked the one required skill ("critique").
    const turn1Jsonl = writeSessionJsonl(tmp, "turn1.jsonl", ["critique"]);
    // Turn 2 (the re-ask): a valid envelope but ZERO commits and ZERO skills
    // invoked — exactly what a compliant "just re-emit the envelope" turn
    // looks like.
    const turn2Jsonl = writeSessionJsonl(tmp, "turn2.jsonl", []);
    const sandbox = makePerCallSandbox([
      { stdout: noEnvelopeStdout(), commits: [{ sha: "sha-1" }], sessionFilePath: turn1Jsonl },
      { stdout: validEnvelopeStdout(22), commits: [], sessionFilePath: turn2Jsonl },
    ]);
    const ctx = baseCtx();

    // Pre-fix this REJECTS (MissingRequiredSkillsError or "implementer made
    // no commits") on the re-ask turn. Post-fix it RESOLVES.
    const r = await runImplementer(sandbox, ctx, {
      attemptNumber: 1,
      requiredSkills: ["critique"],
    });
    expect(r.stdout).toMatch(/STORY_COMPLETE/);

    // Exactly two runs: original + ONE re-ask.
    expect(sandbox.captured).toHaveLength(2);
    const secondArgs = sandbox.captured[1]?.promptArgs as Record<
      string,
      string
    >;
    expect(secondArgs.ENVELOPE_REASK).toMatch(/json/i);
  });

  it("FIRST attempt (not a re-ask) STILL enforces the skill-discipline gate", async () => {
    // A first attempt that commits but does NOT invoke the required skill
    // must still throw — the re-ask carve-out must not weaken the first pass.
    const jsonl = writeSessionJsonl(tmp, "nogate.jsonl", []);
    const sandbox = makePerCallSandbox([
      { stdout: validEnvelopeStdout(22), commits: [{ sha: "sha-1" }], sessionFilePath: jsonl },
    ]);
    const ctx = baseCtx();

    await expect(
      runImplementer(sandbox, ctx, {
        attemptNumber: 1,
        requiredSkills: ["critique"],
      }),
    ).rejects.toThrowError(MissingRequiredSkillsError);
  });

  it("FIRST attempt (not a re-ask) STILL enforces the no-commits throw", async () => {
    // A first attempt with a valid envelope but ZERO commits and no required
    // skills must still throw "implementer made no commits".
    const jsonl = writeSessionJsonl(tmp, "nocommits.jsonl", []);
    const sandbox = makePerCallSandbox([
      { stdout: validEnvelopeStdout(22), commits: [], sessionFilePath: jsonl },
    ]);
    const ctx = baseCtx();

    await expect(
      runImplementer(sandbox, ctx, { attemptNumber: 1 }),
    ).rejects.toThrowError(/implementer made no commits/);
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

// ---------------------------------------------------------------------------
// runCritique — the critique gate's dispatch + verdict + retry ladder.
//
// Closes the disclosed integration-test gap: prior to the runCritique
// extraction the gate was inline in the non-exported shipAfterMigrations and
// only the pure helpers (findLoadableRubrics, critiqueErrorReasonCode) had
// coverage — the dispatch/verdict/retry orchestration itself had none. These
// drive runCritique directly against a per-name sandbox stub, asserting every
// verdict outcome and the exact CritiqueCriticalError flags the
// runIssuePipeline catch handler maps to quarantine reason codes.
// ---------------------------------------------------------------------------
describe("runCritique dispatch + verdict ladder (ADR 0006)", () => {
  const ISSUE = 7;
  const A1 = `critique (issue=${ISSUE})`;
  const A2 = `critique-retry attempt 2 (issue=${ISSUE})`;
  const A3 = `critique-retry attempt 3 (issue=${ISSUE})`;
  // runImplementer names the attempt-2 critique-retry leg with this bare
  // marker (see the name ternary in runImplementer's sb.run spec).
  const IMPL = "implementer-critique-retry";

  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sc-critique-"));
    // A loadable rubric so the no-rubric preflight passes for the dispatch
    // tests (findLoadableRubrics resolves <repoRoot>/.claude/skills/<n>/SKILL.md).
    mkdirSync(path.join(tmp, ".claude", "skills", "impeccable"), {
      recursive: true,
    });
    writeFileSync(
      path.join(tmp, ".claude", "skills", "impeccable", "SKILL.md"),
      "# impeccable\n",
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function critiqueArgs(): SandcastleArgs {
    return { ...skillGateArgs(), repoRoot: tmp };
  }

  function critiqueCtx(over: { retryEnabled?: boolean } = {}) {
    const issue: PlanIssue = {
      id: String(ISSUE),
      title: "critique test",
      branch: `agent/issue-${ISSUE}`,
    };
    return {
      args: { ...critiqueArgs(), retryEnabled: over.retryEnabled ?? true },
      deps: makeNoopDeps(),
      iteration: 1,
      issueNumber: ISSUE,
      issue,
      requiredSkills: ["impeccable"] as readonly string[],
      typeLabel: "type:new-component",
      status: testStatusStore,
    };
  }

  /** A sandbox whose run() returns a canned RunHandle keyed by run name, and
   *  records the names it was asked to run. No worktreePath → the retry leg
   *  derives postSha from the implementer's last commit, not captureSha. */
  function makeCritiqueSandbox(byName: Record<string, RunHandle>): {
    sandbox: SandboxHandle;
    names: string[];
  } {
    const names: string[] = [];
    const sandbox: SandboxHandle = {
      branch: `agent/issue-${ISSUE}`,
      run: async (opts) => {
        names.push(opts.name);
        const h = byName[opts.name];
        if (!h) throw new Error(`unexpected run name=${opts.name}`);
        return h;
      },
      close: async () => undefined,
    };
    return { sandbox, names };
  }

  async function catchErr(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
      return undefined;
    } catch (e) {
      return e;
    }
  }

  it("attempt-1 CRITIQUE_CLEAN → returns postSha unchanged, no throw", async () => {
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "all good\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const r = await runCritique(sandbox, critiqueCtx(), "post-sha");
    expect(r.postSha).toBe("post-sha");
    expect(names).toEqual([A1]); // no retry dispatched
  });

  it("attempt-1 CRITIQUE_CRITICAL → throws first-pass critical (no retry flags)", async () => {
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "## Findings\n\n1. P0\n\nCRITIQUE_CRITICAL", commits: [] },
    });
    const err = await catchErr(runCritique(sandbox, critiqueCtx(), "post-sha"));
    expect(err).toBeInstanceOf(CritiqueCriticalError);
    const e = err as CritiqueCriticalError;
    expect(e.retryExhausted).toBe(false);
    expect(e.criticalAfterRetry).toBe(false);
    expect(e.noRubricLoaded).toBe(false);
    expect(critiqueErrorReasonCode(e).reasonCode).toBe("critique-critical-fail");
    expect(names).toEqual([A1]); // CRITICAL is structural — never retries
  });

  it("attempt-1 no marker, retry ALSO no marker → propagates MarkerNotFoundError (defers, never critical)", async () => {
    // A missing marker is turn-exhaustion, not a rejection: dispatchCritique
    // retries once; when the retry also emits no marker the error propagates as
    // MarkerNotFoundError so the pipeline catch DEFERS it. Fail-closing this
    // into a CRITIQUE_CRITICAL (the old behavior) would quarantine clean code
    // that merely ran out of turns.
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "I forgot to emit a marker line.", commits: [] },
      [`${A1} (no-verdict-retry)`]: {
        stdout: "the retry critic also forgot the marker line",
        commits: [],
      },
    });
    const err = await catchErr(runCritique(sandbox, critiqueCtx(), "post-sha"));
    expect(err).toBeInstanceOf(MarkerNotFoundError);
    expect(err).not.toBeInstanceOf(CritiqueCriticalError);
    // Exactly one dispatch + one retry — the retry never dispatches a third.
    expect(names).toEqual([A1, `${A1} (no-verdict-retry)`]);
  });

  it("NEEDS_FIXES → retry → CLEAN → ships, returns refreshed postSha", async () => {
    const implJsonl = writeSessionJsonl(tmp, "impl.jsonl", ["impeccable"]);
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "## Findings\n\n1. P1\n\nCRITIQUE_NEEDS_FIXES", commits: [] },
      [IMPL]: {
        stdout: implementerStdout({ ghIssue: ISSUE }),
        commits: [{ sha: "retry-sha" }],
        iterations: [{ sessionFilePath: implJsonl }],
      },
      [A2]: { stdout: "fixed now\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const r = await runCritique(sandbox, critiqueCtx(), "post-sha");
    expect(r.postSha).toBe("retry-sha"); // refreshed from the retry implementer
    expect(names).toEqual([A1, IMPL, A2]);
  });

  it("NEEDS_FIXES → retry → NEEDS_FIXES → retry → CLEAN → ships on the 2nd retry (cap=2)", async () => {
    // The capability the cap raise buys: a slice that's still imperfect after
    // one retry gets a second before quarantine (affinity-tracker #454/#470).
    const implJsonl = writeSessionJsonl(tmp, "impl.jsonl", ["impeccable"]);
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "CRITIQUE_NEEDS_FIXES", commits: [] },
      [IMPL]: {
        stdout: implementerStdout({ ghIssue: ISSUE }),
        commits: [{ sha: "retry-sha" }],
        iterations: [{ sessionFilePath: implJsonl }],
      },
      [A2]: { stdout: "still off\n\nCRITIQUE_NEEDS_FIXES", commits: [] },
      [A3]: { stdout: "fixed now\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const r = await runCritique(sandbox, critiqueCtx(), "post-sha");
    expect(r.postSha).toBe("retry-sha");
    // First retry still NEEDS_FIXES, second retry CLEAN → ship.
    expect(names).toEqual([A1, IMPL, A2, IMPL, A3]);
  });

  it("NEEDS_FIXES → retry → CRITICAL → throws critical-introduced-by-retry", async () => {
    const implJsonl = writeSessionJsonl(tmp, "impl.jsonl", ["impeccable"]);
    const { sandbox } = makeCritiqueSandbox({
      [A1]: { stdout: "CRITIQUE_NEEDS_FIXES", commits: [] },
      [IMPL]: {
        stdout: implementerStdout({ ghIssue: ISSUE }),
        commits: [],
        iterations: [{ sessionFilePath: implJsonl }],
      },
      [A2]: { stdout: "## Findings\n\n1. P0\n\nCRITIQUE_CRITICAL", commits: [] },
    });
    const err = await catchErr(runCritique(sandbox, critiqueCtx(), "post-sha"));
    expect(err).toBeInstanceOf(CritiqueCriticalError);
    const e = err as CritiqueCriticalError;
    expect(e.retryExhausted).toBe(true);
    expect(e.criticalAfterRetry).toBe(true);
    expect(critiqueErrorReasonCode(e).reasonCode).toBe("critique-retry-critical");
  });

  it("NEEDS_FIXES → retry → NEEDS_FIXES → retry → still NEEDS_FIXES → quarantines retry-exhausted (cap=2)", async () => {
    const implJsonl = writeSessionJsonl(tmp, "impl.jsonl", ["impeccable"]);
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "CRITIQUE_NEEDS_FIXES", commits: [] },
      [IMPL]: {
        stdout: implementerStdout({ ghIssue: ISSUE }),
        commits: [],
        iterations: [{ sessionFilePath: implJsonl }],
      },
      [A2]: { stdout: "## Findings\n\n1. P1\n\nCRITIQUE_NEEDS_FIXES", commits: [] },
      [A3]: { stdout: "## Findings\n\n1. P1\n\nCRITIQUE_NEEDS_FIXES", commits: [] },
    });
    const err = await catchErr(runCritique(sandbox, critiqueCtx(), "post-sha"));
    expect(err).toBeInstanceOf(CritiqueCriticalError);
    const e = err as CritiqueCriticalError;
    expect(e.retryExhausted).toBe(true);
    expect(e.criticalAfterRetry).toBe(false); // unresolved, not newly-critical
    expect(critiqueErrorReasonCode(e).reasonCode).toBe(
      "critique-retry-exhausted",
    );
    // Two full retry rounds before quarantine (cap raised 1→2, ADR 0014).
    expect(names).toEqual([A1, IMPL, A2, IMPL, A3]);
  });

  it("retry-leg (attempt-2) no verdict → its own no-verdict retry recovers CLEAN → ships", async () => {
    // The no-verdict retry applies to EVERY dispatch, including a NEEDS_FIXES
    // ladder retry leg. A2 runs out of turns without a marker; its one-shot
    // no-verdict retry then grades CLEAN, so the slice ships instead of being
    // quarantined for a turn-exhaustion that had nothing to do with the code.
    const implJsonl = writeSessionJsonl(tmp, "impl.jsonl", ["impeccable"]);
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "CRITIQUE_NEEDS_FIXES", commits: [] },
      [IMPL]: {
        stdout: implementerStdout({ ghIssue: ISSUE }),
        commits: [{ sha: "retry-sha" }],
        iterations: [{ sessionFilePath: implJsonl }],
      },
      [A2]: { stdout: "the retry critic ran out of turns", commits: [] },
      [`${A2} (no-verdict-retry)`]: {
        stdout: "graded now\n\nCRITIQUE_CLEAN",
        commits: [],
      },
    });
    const r = await runCritique(sandbox, critiqueCtx(), "post-sha");
    expect(r.postSha).toBe("retry-sha");
    expect(names).toEqual([A1, IMPL, A2, `${A2} (no-verdict-retry)`]);
  });

  it("NEEDS_FIXES with retry disabled → quarantines without dispatching the implementer", async () => {
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "CRITIQUE_NEEDS_FIXES", commits: [] },
    });
    const err = await catchErr(
      runCritique(sandbox, critiqueCtx({ retryEnabled: false }), "post-sha"),
    );
    expect(err).toBeInstanceOf(CritiqueCriticalError);
    const e = err as CritiqueCriticalError;
    expect(e.retryExhausted).toBe(true);
    expect(e.criticalAfterRetry).toBe(false);
    expect(critiqueErrorReasonCode(e).reasonCode).toBe(
      "critique-retry-exhausted",
    );
    expect(names).toEqual([A1]); // implementer never ran
  });

  it("no rubric loaded → throws noRubricLoaded WITHOUT dispatching critique", async () => {
    const { sandbox, names } = makeCritiqueSandbox({});
    const ctx = {
      ...critiqueCtx(),
      // A principle name guaranteed absent from BOTH the tmp repoRoot and the
      // real ~/.claude/skills/ — runCritique calls findLoadableRubrics with
      // the default homeDir, so the name must be one host state can't supply.
      requiredSkills: ["__nonexistent_principle__"] as readonly string[],
    };
    const err = await catchErr(runCritique(sandbox, ctx, "post-sha"));
    expect(err).toBeInstanceOf(CritiqueCriticalError);
    const e = err as CritiqueCriticalError;
    expect(e.noRubricLoaded).toBe(true);
    expect(critiqueErrorReasonCode(e).reasonCode).toBe(
      "critique-no-rubric-loaded",
    );
    expect(names).toEqual([]); // preflight quarantines before any dispatch
  });

  // -------------------------------------------------------------------------
  // No-verdict (turn-exhaustion) retry ladder. Turn-exhaustion does not throw
  // in the SDK — the critic returns partial output with no marker on its last
  // line, so extractMarker throws MarkerNotFoundError. That is NOT a code-level
  // rejection; the gate simply never produced a verdict. dispatchCritique now
  // retries the dispatch ONCE on the same model; if the retry still has no
  // verdict, MarkerNotFoundError propagates (→ deferred at the pipeline catch,
  // not quarantined). A malformed-but-present marker is unaffected.
  // -------------------------------------------------------------------------
  const A1_NV = `${A1} (no-verdict-retry)`;

  it("attempt-1 no verdict → retries dispatch once → CLEAN → returns postSha, no throw", async () => {
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "I ran out of turns before emitting a verdict.", commits: [] },
      [A1_NV]: { stdout: "now graded\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const r = await runCritique(sandbox, critiqueCtx(), "post-sha");
    expect(r.postSha).toBe("post-sha");
    // The no-verdict-retry leg fired exactly once, then produced a clean verdict.
    expect(names).toEqual([A1, A1_NV]);
  });

  it("attempt-1 no verdict → retry CRITIQUE_CRITICAL → throws first-pass critical (retry recovered a real verdict)", async () => {
    // The no-verdict retry recovers a genuine verdict; a CRITICAL on the retry
    // is a real rejection and must still quarantine — the retry softens nothing.
    const { sandbox, names } = makeCritiqueSandbox({
      [A1]: { stdout: "ran out of turns", commits: [] },
      [A1_NV]: { stdout: "## Findings\n\n1. P0\n\nCRITIQUE_CRITICAL", commits: [] },
    });
    const err = await catchErr(runCritique(sandbox, critiqueCtx(), "post-sha"));
    expect(err).toBeInstanceOf(CritiqueCriticalError);
    const e = err as CritiqueCriticalError;
    expect(e.retryExhausted).toBe(false);
    expect(critiqueErrorReasonCode(e).reasonCode).toBe("critique-critical-fail");
    expect(names).toEqual([A1, A1_NV]);
  });
});

describe("shipAfterMigrations gate ordering: critique + journal gate before migrations/ship", () => {
  const ISSUE = 7;
  const CRITIQUE = `critique (issue=${ISSUE})`;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sc-ship-"));
    mkdirSync(path.join(tmp, ".claude", "skills", "impeccable"), {
      recursive: true,
    });
    writeFileSync(
      path.join(tmp, ".claude", "skills", "impeccable", "SKILL.md"),
      "# impeccable\n",
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // No worktreePath: shipAfterMigrations does not call captureSha (unlike
  // runCritique's retry leg), so the canned-by-name sandbox is sufficient.
  function makeShipSandbox(byName: Record<string, RunHandle>): {
    sandbox: SandboxHandle;
    names: string[];
  } {
    const names: string[] = [];
    const sandbox: SandboxHandle = {
      branch: `agent/issue-${ISSUE}`,
      run: async (opts) => {
        names.push(opts.name);
        const h = byName[opts.name];
        if (!h) throw new Error(`unexpected run name=${opts.name}`);
        return h;
      },
      close: async () => undefined,
    };
    return { sandbox, names };
  }

  // deps is injectable (unlike critiqueCtx's fixed makeNoopDeps): the ship
  // tests need the recording buildDeps() harness to assert migrations/markDone.
  function shipCtx(deps: Deps) {
    return {
      args: {
        ...skillGateArgs(),
        repoRoot: tmp,
        stagingEnabled: false, // staging path (markMergedToStaging) is out of scope; covered separately
        retryEnabled: true,
      },
      deps,
      iteration: 1,
      issueNumber: ISSUE,
      issue: {
        id: String(ISSUE),
        title: "integration",
        branch: `agent/issue-${ISSUE}`,
      },
      requiredSkills: ["impeccable"] as readonly string[],
      typeLabel: "type:new-component",
      status: testStatusStore,
    };
  }

  async function catchErr(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
      return undefined;
    } catch (e) {
      return e;
    }
  }

  it("CRITIQUE_CLEAN → dispatches critique, validates journal, applies migrations, marks done", async () => {
    const b = buildDeps();
    const { sandbox, names } = makeShipSandbox({
      [CRITIQUE]: { stdout: "all good\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const out = await shipAfterMigrations(
      shipCtx(b.deps),
      sandbox,
      "pre-sha",
      "post-sha",
      "STORY_COMPLETE",
      ["impeccable"],
      "first-pass-only",
    );
    expect(names).toEqual([CRITIQUE]);
    expect(b.state.migrationsCalls).toHaveLength(1);
    expect(b.state.marksDone).toHaveLength(1);
    expect(b.state.marksDone[0]?.issueNum).toBe(ISSUE);
    expect(b.state.quarantines).toEqual([]);
    expect(out.status).toBe("ok");
  });

  it("CRITIQUE_CRITICAL → throws before migrations; no apply, no markDone", async () => {
    const b = buildDeps();
    const { sandbox } = makeShipSandbox({
      [CRITIQUE]: {
        stdout: "## Findings\n\n1. P0\n\nCRITIQUE_CRITICAL",
        commits: [],
      },
    });
    const err = await catchErr(
      shipAfterMigrations(
        shipCtx(b.deps),
        sandbox,
        "pre-sha",
        "post-sha",
        "STORY_COMPLETE",
      ),
    );
    expect(err).toBeInstanceOf(CritiqueCriticalError);
    expect((err as CritiqueCriticalError).noRubricLoaded).toBe(false);
    expect(critiqueErrorReasonCode(err as CritiqueCriticalError).reasonCode).toBe("critique-critical-fail");
    expect(b.state.migrationsCalls).toEqual([]);
    expect(b.state.marksDone).toEqual([]);
  });

  it("CRITIQUE_CLEAN but unregistered migration → journal gate throws before applyMigrations", async () => {
    const b = buildDeps({
      unregisteredMigrations: [
        {
          file: "0007_thing.sql",
          expectedTag: "0007_thing",
          journalPath: "packages/db/migrations/meta/_journal.json",
          journalMissing: false,
        },
      ],
    });
    const { sandbox } = makeShipSandbox({
      [CRITIQUE]: { stdout: "looks fine\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const err = await catchErr(
      shipAfterMigrations(
        shipCtx(b.deps),
        sandbox,
        "pre-sha",
        "post-sha",
        "STORY_COMPLETE",
      ),
    );
    expect((err as Error).message).toMatch(/not\s+registered/i);
    expect(b.state.migrationsCalls).toEqual([]);
    expect(b.state.marksDone).toEqual([]);
  });

  it("lint cert present (status=pass) → gate runs, then ships normally", async () => {
    const b = buildDeps({ lintCertStatus: "pass" });
    const { sandbox } = makeShipSandbox({
      [CRITIQUE]: { stdout: "all good\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const out = await shipAfterMigrations(
      shipCtx(b.deps),
      sandbox,
      "pre-sha",
      "post-sha",
      "STORY_COMPLETE",
      ["impeccable"],
      "first-pass-only",
    );
    // Gate was consulted with the repoRoot + the shipped SHAs.
    expect(b.state.lintCertChecks).toEqual([
      { repoRoot: tmp, preSha: "pre-sha", postSha: "post-sha" },
    ]);
    // A present cert does not block: migrations apply, issue marks done.
    expect(b.state.migrationsCalls).toHaveLength(1);
    expect(b.state.marksDone).toHaveLength(1);
    expect(out.status).toBe("ok");
  });

  it("lint cert missing (status=missing) on a code diff → throws before migrations/markDone", async () => {
    const b = buildDeps({ lintCertStatus: "missing" });
    const { sandbox, names } = makeShipSandbox({
      [CRITIQUE]: { stdout: "all good\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const err = await catchErr(
      shipAfterMigrations(
        shipCtx(b.deps),
        sandbox,
        "pre-sha",
        "post-sha",
        "STORY_COMPLETE",
      ),
    );
    // Critique ran first; the lint gate then fired before the migration leg.
    expect(names).toEqual([CRITIQUE]);
    expect((err as Error).message).toMatch(/lint-cert-missing/i);
    expect(b.state.migrationsCalls).toEqual([]);
    expect(b.state.marksDone).toEqual([]);
  });

  it("lint dormant (no lint script / status=dormant) → gate is a no-op, ships", async () => {
    const b = buildDeps({ lintCertStatus: "dormant" });
    const { sandbox } = makeShipSandbox({
      [CRITIQUE]: { stdout: "all good\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const out = await shipAfterMigrations(
      shipCtx(b.deps),
      sandbox,
      "pre-sha",
      "post-sha",
      "STORY_COMPLETE",
      ["impeccable"],
      "first-pass-only",
    );
    expect(b.state.lintCertChecks).toHaveLength(1);
    expect(b.state.migrationsCalls).toHaveLength(1);
    expect(b.state.marksDone).toHaveLength(1);
    expect(out.status).toBe("ok");
  });

  it("test cert present (status=pass) → gate runs, then ships normally", async () => {
    const b = buildDeps({ testCertStatus: "pass" });
    const { sandbox } = makeShipSandbox({
      [CRITIQUE]: { stdout: "all good\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const out = await shipAfterMigrations(
      shipCtx(b.deps),
      sandbox,
      "pre-sha",
      "post-sha",
      "STORY_COMPLETE",
      ["impeccable"],
      "first-pass-only",
    );
    // Gate was consulted with the repoRoot + the shipped SHAs.
    expect(b.state.testCertChecks).toEqual([
      { repoRoot: tmp, preSha: "pre-sha", postSha: "post-sha" },
    ]);
    // A present cert does not block: migrations apply, issue marks done.
    expect(b.state.migrationsCalls).toHaveLength(1);
    expect(b.state.marksDone).toHaveLength(1);
    expect(out.status).toBe("ok");
  });

  it("test cert missing (status=missing) on a code diff → throws before migrations/markDone", async () => {
    const b = buildDeps({ testCertStatus: "missing" });
    const { sandbox, names } = makeShipSandbox({
      [CRITIQUE]: { stdout: "all good\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const err = await catchErr(
      shipAfterMigrations(
        shipCtx(b.deps),
        sandbox,
        "pre-sha",
        "post-sha",
        "STORY_COMPLETE",
      ),
    );
    // Critique ran first; the test gate then fired before the migration leg.
    expect(names).toEqual([CRITIQUE]);
    expect((err as Error).message).toMatch(/test-cert-missing/i);
    expect(b.state.migrationsCalls).toEqual([]);
    expect(b.state.marksDone).toEqual([]);
  });

  it("test dormant (no test script / status=dormant) → gate is a no-op, ships", async () => {
    const b = buildDeps({ testCertStatus: "dormant" });
    const { sandbox } = makeShipSandbox({
      [CRITIQUE]: { stdout: "all good\n\nCRITIQUE_CLEAN", commits: [] },
    });
    const out = await shipAfterMigrations(
      shipCtx(b.deps),
      sandbox,
      "pre-sha",
      "post-sha",
      "STORY_COMPLETE",
      ["impeccable"],
      "first-pass-only",
    );
    expect(b.state.testCertChecks).toHaveLength(1);
    expect(b.state.migrationsCalls).toHaveLength(1);
    expect(b.state.marksDone).toHaveLength(1);
    expect(out.status).toBe("ok");
  });
});

describe("lint-gate helpers (hasLintScript, commitMessageHasLintCert)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sc-lint-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writePkg = (scripts: Record<string, string>) =>
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ scripts }));

  it("hasLintScript: true when package.json has a non-empty lint script", () => {
    writePkg({ lint: "eslint ." });
    expect(hasLintScript(tmp)).toBe(true);
  });

  it("hasLintScript: false when there is no lint script", () => {
    writePkg({ test: "vitest run" });
    expect(hasLintScript(tmp)).toBe(false);
  });

  it("hasLintScript: fail-quiet false on missing/malformed package.json or empty script", () => {
    expect(hasLintScript(tmp)).toBe(false); // no package.json
    writeFileSync(path.join(tmp, "package.json"), "{ not json");
    expect(hasLintScript(tmp)).toBe(false); // malformed
    writePkg({ lint: "   " });
    expect(hasLintScript(tmp)).toBe(false); // whitespace-only script
  });

  it("commitMessageHasLintCert: matches the pass token, case/spacing-insensitive", () => {
    expect(commitMessageHasLintCert("body\n\nSANDCASTLE-LINT: pass\n")).toBe(true);
    expect(commitMessageHasLintCert("sandcastle-lint:   PASS (0 problems)")).toBe(
      true,
    );
  });

  it("commitMessageHasLintCert: does NOT match n/a, a missing cert, or 'passed'", () => {
    expect(commitMessageHasLintCert("body\n\nSANDCASTLE-LINT: n/a")).toBe(false);
    expect(commitMessageHasLintCert("no cert in this body")).toBe(false);
    expect(commitMessageHasLintCert("SANDCASTLE-LINT: passed maybe")).toBe(false);
  });
});

describe("hasCodeDiff (shared real-code-diff predicate)", () => {
  it("true only when both SHAs resolve and differ", () => {
    expect(hasCodeDiff("pre", "post")).toBe(true);
  });

  it("false when either SHA is empty or the two are equal", () => {
    expect(hasCodeDiff("", "post")).toBe(false);
    expect(hasCodeDiff("pre", "")).toBe(false);
    expect(hasCodeDiff("", "")).toBe(false);
    expect(hasCodeDiff("sha", "sha")).toBe(false);
  });
});

describe("classifyLintCert (lint-gate dormancy matrix)", () => {
  const CERT = "feat: thing\n\nSANDCASTLE-LINT: pass\n";

  it("dormant when the project has no lint script", () => {
    // Even with a real diff and a missing cert, no lint script ⇒ no-op.
    expect(classifyLintCert(false, "pre", "post", "no cert here")).toEqual({
      status: "dormant",
    });
  });

  it("dormant when there is no code diff (empty or equal SHAs)", () => {
    expect(classifyLintCert(true, "", "post", CERT)).toEqual({
      status: "dormant",
    });
    expect(classifyLintCert(true, "pre", "", CERT)).toEqual({
      status: "dormant",
    });
    expect(classifyLintCert(true, "sha", "sha", CERT)).toEqual({
      status: "dormant",
    });
  });

  it("dormant (fail-quiet) when the commit message is unreadable (null)", () => {
    // The safety-critical branch: a git/infra hiccup must NOT quarantine.
    expect(classifyLintCert(true, "pre", "post", null)).toEqual({
      status: "dormant",
    });
  });

  it("pass when a lint-enabled diff carries the cert", () => {
    expect(classifyLintCert(true, "pre", "post", CERT)).toEqual({
      status: "pass",
    });
  });

  it("missing when a lint-enabled diff lacks the cert", () => {
    expect(classifyLintCert(true, "pre", "post", "feat: thing\n")).toEqual({
      status: "missing",
    });
  });
});

// ---------------------------------------------------------------------------
// Execution-level status.json feed (the `sandcastle-watch` viewer's input)
//
// These drive runMain end-to-end and read the status.json the orchestrator
// actually writes to <repoRoot>/.sandcastle/status.json. The single-instance
// lock acquisition (`ensureFileExists`) creates that dir BEFORE the store is
// built, so the production atomicWrite path lands on disk in tests with no
// writeFn injection. They turn the previously code-read-only claim — "each
// outcome maps to a terminal phase + finish state for the viewer" — into
// proof-by-execution.
// ---------------------------------------------------------------------------

/** Read + parse the status.json the loop just wrote to the shared test root. */
function readStatusFeed(): SandcastleStatus {
  const p = path.join(TEST_REPO_ROOT, ".sandcastle", "status.json");
  return JSON.parse(readFileSync(p, "utf8")) as SandcastleStatus;
}

describe("sandcastle-loop main.mts — status.json feed (execution-level)", () => {
  it("a SIGINT-interrupted run finishes the feed as 'stopped', not 'done'", async () => {
    // Capture the SIGINT listeners present BEFORE runMain (vitest installs its
    // own). The hook below fires only the one runMain newly registers — we
    // invoke that handler directly rather than process.emit("SIGINT"), which
    // would also trip vitest's handler and fight its teardown.
    const sigintBaseline = process.listeners("SIGINT");
    const b = buildDeps({
      iterationStartHook: (it) => {
        if (it !== 1) return;
        for (const l of process.listeners("SIGINT")) {
          if (!sigintBaseline.includes(l)) (l as (sig: string) => void)("SIGINT");
        }
      },
    });
    // Iteration 1 ships issue 71. shuttingDown is set at the top of iteration 1
    // (via the hook), but the break only fires at the TOP of iteration 2 — so
    // 71 still ships, then iteration 2 breaks and falls through to finish().
    // No second planner is enqueued: iteration 2 breaks before calling it.
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

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    // Iteration 1 completed and shipped before the interrupt took effect.
    expect(result.shippedIssues).toEqual([71]);

    // ADR 0021 §4: a genuine stop (SIGINT here) releases every held lease on the
    // way out so a peer reclaims immediately instead of waiting the TTL. The
    // shutdown-gated `deps.releaseAllLeases()` must have fired.
    expect(b.state.leaseReleaseAllCalls).toBeGreaterThanOrEqual(1);

    const feed = readStatusFeed();
    // The interrupt must surface as a distinct terminal state so the viewer
    // shows "stopped", not a false "done — loop finished".
    expect(feed.state).toBe("stopped");
    // The shipped issue's terminal phase is still recorded under the stop.
    expect(feed.issues.find((i) => i.number === 71)?.phase).toBe("merged");
    expect(feed.totals.merged).toBe(1);
  });

  it("a clean ship records ok→merged and finishes the feed 'done'", async () => {
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
    // Iteration 2 returns an empty plan → the loop exits at the no-claimable
    // guard (which finishes "done" BEFORE setPlan could clear iteration 1's
    // issues), so the shipped issue's terminal phase survives in the feed.
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );
    expect(result.shippedIssues).toEqual([71]);

    const feed = readStatusFeed();
    expect(feed.state).toBe("done");
    expect(feed.issues.find((i) => i.number === 71)?.phase).toBe("merged");
    expect(feed.totals).toMatchObject({
      merged: 1,
      needsHuman: 0,
      requeued: 0,
      running: 0,
    });
    // ADR 0021 §4: a CLEAN finish is not a stop — the shutdown-gated bulk lease
    // release must NOT fire (guards against dropping the `if (shuttingDown)`
    // condition, which would hand off work on every normal exit / hot-reload).
    expect(b.state.leaseReleaseAllCalls).toBe(0);
  });

  it("a HAS_BLOCKERS review records quarantined→needs-human with attention", async () => {
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
    expect(result.shippedIssues).toEqual([]);

    const feed = readStatusFeed();
    expect(feed.state).toBe("done");
    const issue = feed.issues.find((i) => i.number === 100);
    expect(issue?.phase).toBe("needs-human");
    expect(issue?.attention).toBe(true);
    expect(feed.totals.needsHuman).toBe(1);
  });

  it("a rate-limit defer records deferred→requeued (phase 'deferred')", async () => {
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "400", title: "rl", branch: "agent/issue-400" }]),
    });
    const rl = () =>
      new Error('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}');
    // Both implementer attempts rate-limit → the pipeline defers (release).
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: false }),
      b.deps,
    );
    expect(result.shippedIssues).toEqual([]);

    const feed = readStatusFeed();
    expect(feed.state).toBe("done");
    const issue = feed.issues.find((i) => i.number === 400);
    expect(issue?.phase).toBe("deferred");
    expect(feed.totals.requeued).toBe(1);
  });
});

describe("resolveReviewBase", () => {
  it("returns the merge-base SHA on a normal feature branch", () => {
    const reviewBase = resolveReviewBase(
      { ok: true, stdout: "aaaa1111", stderr: "" },
      { ok: true, stdout: "bbbb2222", stderr: "" },
      "bbbb2222",
    );
    expect(reviewBase).toBe("aaaa1111");
  });

  it("falls back to the tip's parent when the base can't be resolved", () => {
    const reviewBase = resolveReviewBase(
      { ok: false, stdout: "", stderr: "fatal" },
      { ok: true, stdout: "bbbb2222", stderr: "" },
      "bbbb2222",
    );
    expect(reviewBase).toBe("bbbb2222~1");
  });

  it("falls back to the tip's parent when the merge-base IS the tip", () => {
    // This is the case that would otherwise produce an empty diff
    // (`git diff base..tip` with base === tip) and rubber-stamp the review.
    const reviewBase = resolveReviewBase(
      { ok: true, stdout: "bbbb2222", stderr: "" },
      { ok: true, stdout: "bbbb2222", stderr: "" },
      "bbbb2222",
    );
    expect(reviewBase).toBe("bbbb2222~1");
  });
});

// ---------------------------------------------------------------------------
// Cross-host issue lease orchestration (ADR 0019). Every test drives runMain /
// parseSandcastleArgs with the fake Deps lease methods (see buildDeps) — the
// real git backend is proven in tests/issue-lease.test.ts, so nothing here shells to
// git for a lease. The opt-in flag is set per-test and scrubbed in afterEach so
// the default-OFF suite above is never contaminated.
// ---------------------------------------------------------------------------
describe("cross-host issue lease orchestration (ADR 0019)", () => {
  const LEASE_ENV_KEYS = [
    "SANDCASTLE_CROSS_HOST_LEASE",
    "SANDCASTLE_CROSS_HOST_SYNC",
    "SANDCASTLE_HOST_ID",
    "SANDCASTLE_LOCK_TTL_SEC",
  ];
  afterEach(() => {
    for (const k of LEASE_ENV_KEYS) delete process.env[k];
  });

  // Real bare-ish repo + staging worktree, mirroring the staging-promotion
  // suite's initStagingRepo. Only the two staging-path lease tests need it.
  function initStagingRepo(): {
    repoRoot: string;
    stagingPath: string;
    gitEnv: NodeJS.ProcessEnv;
    cleanup: () => void;
  } {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "sc-lease-"));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const git = (cwd: string, ...args: string[]): string =>
      execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
    git(repoRoot, "init", "-q", "-b", "main");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(path.join(repoRoot, "README.md"), "hello\n");
    git(repoRoot, "add", "README.md");
    git(repoRoot, "commit", "-q", "-m", "init");
    git(repoRoot, "branch", "feature/work");
    git(repoRoot, "branch", "integration-candidate");
    const stagingPath = mkdtempSync(path.join(tmpdir(), "sc-lease-staging-"));
    rmSync(stagingPath, { recursive: true, force: true });
    git(repoRoot, "worktree", "add", "-q", stagingPath, "integration-candidate");
    return {
      repoRoot,
      stagingPath,
      gitEnv,
      cleanup: () => {
        rmSync(repoRoot, { recursive: true, force: true });
        rmSync(stagingPath, { recursive: true, force: true });
      },
    };
  }

  // Hook 1 — claim gate.
  it("hook 1: flag ON + contended lease → issue skipped, claim never called, sibling proceeds", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    // #71 loses the lease (peer holds it), #72 wins.
    const b = buildDeps({ leaseAcquireFor: (n) => n === 72 });
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "71", title: "contended", branch: "agent/issue-71" },
        { id: "72", title: "mine", branch: "agent/issue-72" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 72 }),
      commits: [{ sha: "c72" }],
    });
    b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    // The contended issue was never claimed; the sibling shipped.
    expect(b.state.claims).toEqual([72]);
    expect(result.shippedIssues).toEqual([72]);
    // Both issues attempted a lease.
    expect([...b.state.leaseAcquires].sort()).toEqual([71, 72]);
  });

  // Hook 2 — release points in the accounting loop.
  it("hook 2: non-staging ok releases the lease", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
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
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([71]);
    expect(b.state.leaseReleases).toContain(71);
  });

  it("hook 2: quarantine releases the lease", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "300", title: "z", branch: "agent/issue-300" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: new Error("agent crashed") });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.quarantines.map((q) => q.issueNum)).toEqual([300]);
    expect(b.state.leaseReleases).toContain(300);
  });

  it("hook 2: rate-limit deferral releases the lease", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const b = buildDeps();
    const rl = () => new Error('API Error: 429 rate_limit_error');
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "400", title: "rl", branch: "agent/issue-400" }]),
    });
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("implementer", { stdout: "", throw: rl() });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, recoveryEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.quarantines).toEqual([]);
    expect(b.state.leaseReleases).toContain(400);
  });

  it("hook 2 / Fix 4: staging ok held past ship is RELEASED when the promotion FF is refused (stranded)", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const { repoRoot, stagingPath, gitEnv, cleanup } = initStagingRepo();
    try {
      __setStagingWorktreePathForTests(stagingPath);
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

      // Divergence trick (mirrors the staging suite): the merger advances
      // feature/work so the final fast-forward REFUSES → promotion never runs.
      const realRun = b.deps.run.bind(b.deps);
      b.deps.run = async (spec) => {
        const handle = await realRun(spec);
        if (spec.name === "merger") {
          const wt = mkdtempSync(path.join(tmpdir(), "sc-lease-divert-"));
          rmSync(wt, { recursive: true, force: true });
          const git = (cwd: string, ...args: string[]): string =>
            execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
          git(repoRoot, "worktree", "add", "-q", wt, "feature/work");
          writeFileSync(path.join(wt, "operator.ts"), "export const OP = 1;\n");
          git(wt, "add", "operator.ts");
          git(wt, "commit", "-q", "-m", "diverge");
          git(repoRoot, "worktree", "remove", "--force", wt);
        }
        return handle;
      };

      const result = await runMain(
        baseArgs({ iterations: 1, repoRoot, stagingEnabled: true }),
        b.deps,
      );

      // Promotion FF refused → the work is stranded on integration-candidate
      // and #71 is flagged needs-human. Fix 4: the lease held past ship time is
      // now RELEASED in the stranded branch (matching its promote-success and
      // quarantine siblings) so the ref clears and a peer can reclaim; the issue
      // stays needs-human so the planner won't re-pick it.
      expect(result.exitCode).not.toBe(0);
      expect(b.state.leaseAcquires).toContain(71);
      expect(b.state.leaseReleases).toContain(71);
    } finally {
      __setStagingWorktreePathForTests("");
      cleanup();
    }
  });

  // Hook 3 — promotion release.
  it("hook 3: staging ok lease is released only after promotion succeeds", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const { repoRoot, stagingPath, gitEnv, cleanup } = initStagingRepo();
    let launchPath = "";
    try {
      __setStagingWorktreePathForTests(stagingPath);
      // Clean live worktree on the integration branch so the FF advances it.
      launchPath = mkdtempSync(path.join(tmpdir(), "sc-lease-launch-"));
      rmSync(launchPath, { recursive: true, force: true });
      execFileSync("git", ["worktree", "add", "-q", launchPath, "feature/work"], {
        cwd: repoRoot,
        env: gitEnv,
        stdio: "ignore",
      });

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

      await runMain(
        baseArgs({ iterations: 1, repoRoot, stagingEnabled: true }),
        b.deps,
      );

      const status = JSON.parse(
        readFileSync(path.join(repoRoot, ".sandcastle", "status.json"), "utf8"),
      ) as SandcastleStatus;
      // Promotion landed → merged counted → lease released.
      expect(status.totals.merged).toBe(1);
      expect(b.state.leaseReleases).toContain(71);
    } finally {
      __setStagingWorktreePathForTests("");
      if (launchPath) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", launchPath], {
            cwd: repoRoot,
            env: gitEnv,
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      }
      cleanup();
    }
  });

  // Hook 4 — startup reconciliation.
  it("hook 4: flag ON → live foreign lease NOT released; expired/absent released", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const b = buildDeps({
      leaseStateFor: (n) =>
        n === 10 ? "live" : n === 11 ? "expired" : "absent",
    });
    b.deps.listIssuesByLabel = async (label) =>
      label === "in-progress"
        ? [
            { number: 10, title: "peer-live", labels: ["in-progress"] },
            { number: 11, title: "expired", labels: ["in-progress"] },
            { number: 12, title: "absent", labels: ["in-progress"] },
          ]
        : [];
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 1 }), b.deps);

    expect(result.exitCode).toBe(0);
    // leaseState consulted for every in-progress issue.
    expect([...b.state.leaseStateCalls].sort()).toEqual([10, 11, 12]);
    // The live foreign lease (#10) is left alone; the rest are released.
    expect(b.state.releases.map((r) => r.issueNum).sort()).toEqual([11, 12]);
  });

  it("hook 4: flag OFF → all in-progress released, leaseState never consulted", async () => {
    const b = buildDeps({ leaseStateFor: () => "live" });
    b.deps.listIssuesByLabel = async (label) =>
      label === "in-progress"
        ? [
            { number: 10, title: "a", labels: ["in-progress"] },
            { number: 11, title: "b", labels: ["in-progress"] },
            { number: 12, title: "c", labels: ["in-progress"] },
          ]
        : [];
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 1 }), b.deps);

    expect(result.exitCode).toBe(0);
    // Legacy path: every in-progress issue released unconditionally.
    expect(b.state.releases.map((r) => r.issueNum).sort()).toEqual([10, 11, 12]);
    // The lease was never consulted.
    expect(b.state.leaseStateCalls).toEqual([]);
  });

  // Hook 5 — heartbeat.
  it("hook 5: flag ON → heartbeat set up and torn down without breaking a clean exit", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const b = buildDeps();
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 1 }), b.deps);

    // A clean exit with the heartbeat active proves setup + teardown don't wedge
    // the loop; the renew floor (30s) means it never fires during the test.
    expect(result.exitCode).toBe(0);
    expect(b.state.leaseRenews).toBe(0);
  });

  // Hook 6 — per-host run-branch namespacing.
  it("hook 6: flag ON + auto-derived branch is host-suffixed", () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    process.env.SANDCASTLE_HOST_ID = "myhost";
    const { args } = parseSandcastleArgs(["--iterations", "1"]);
    expect(args.branch.endsWith("-myhost")).toBe(true);
  });

  it("hook 6: explicit --branch is never suffixed", () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    process.env.SANDCASTLE_HOST_ID = "myhost";
    const { args } = parseSandcastleArgs([
      "--iterations",
      "1",
      "--branch",
      "feature/x",
    ]);
    expect(args.branch).toBe("feature/x");
  });

  it("hook 6: flag OFF → auto-derived branch is unchanged (no host suffix)", () => {
    process.env.SANDCASTLE_HOST_ID = "myhost";
    const { args } = parseSandcastleArgs(["--iterations", "1"]);
    expect(args.branch.includes("myhost")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Fix 1 — cross-host contention is a SKIP, not a failure.
  // ---------------------------------------------------------------------------
  it("Fix 1: all-contended issues → SKIP, breaker NOT tripped (exit 0)", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    // Every acquire loses — the peer host holds every ticket. Three tickets
    // matches the default consecutiveFailureLimit (3): pre-fix each would bump
    // consecutiveFailures and trip the breaker (exit 1) on the very first
    // iteration. Post-fix each is a routine skip.
    const b = buildDeps({ leaseAcquireWins: false });
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "51", title: "a", branch: "agent/issue-51" },
        { id: "52", title: "b", branch: "agent/issue-52" },
        { id: "53", title: "c", branch: "agent/issue-53" },
      ]),
    });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0); // breaker did NOT trip
    expect(b.state.claims).toEqual([]); // nothing claimed
    expect(result.shippedIssues).toEqual([]);
    // Contention is routine — no circuit-breaker comment posted, and no
    // "outer pipeline rejected" error was logged for a contended ticket.
    expect(b.state.comments).toEqual([]);
    expect(b.state.errors.join("\n")).not.toMatch(/outer pipeline rejected/);
  });

  it("Fix 1: contended loser skips, winner sibling ships (single iteration)", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    // #61 contended (peer holds it), #62 free.
    const b = buildDeps({ leaseAcquireFor: (n) => n === 62 });
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "61", title: "contended", branch: "agent/issue-61" },
        { id: "62", title: "mine", branch: "agent/issue-62" },
      ]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 62 }),
      commits: [{ sha: "c62" }],
    });
    b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.claims).toEqual([62]); // loser never claimed
    expect(result.shippedIssues).toEqual([62]);
  });

  // ---------------------------------------------------------------------------
  // Fix 2 — an auth/network LeaseBackendError from acquire halts LOUD + fatal.
  // ---------------------------------------------------------------------------
  it("Fix 2: LeaseBackendError from acquire → run halts loudly, not counted as contention", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const b = buildDeps();
    b.deps.acquireIssueLease = async () => {
      throw new LeaseBackendError(
        "fatal: could not read Username for 'https://github.com'",
      );
    };
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "61", title: "a", branch: "agent/issue-61" },
      ]),
    });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).not.toBe(0); // halted, not exit 0
    const joined = b.state.errors.join("\n");
    // Loud, remediation-oriented message.
    expect(joined).toMatch(/auth|setup-git/i);
    // NOT mistaken for routine contention.
    expect(joined.toLowerCase()).not.toContain("contended");
    // The auth fault stops us before we ever claim.
    expect(b.state.claims).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Review Fix 1 — a LeaseReadError on the acquire/reclaim path is OCCUPIED
  // (return false → routine skip), NOT an uncaught throw that trips the breaker
  // and permanently deadlocks. A LeaseBackendError from acquire STILL
  // propagates (must reach Fix 2's loud fatal halt — never swallowed here).
  // Drives the REAL acquireIssueLease closure via the createLeaseCoordinator
  // seam (ADR 0019) so the actual reclaimIfExpired → readRef path runs against
  // a fake LockBackend — a single collaborator, no full Deps graph needed.
  // ---------------------------------------------------------------------------
  describe("acquireIssueLease — LeaseReadError is OCCUPIED (review Fix 1)", () => {
    /** Build a lease coordinator over `backend` with the lease flag ON and a
     *  capture sink for logError (so heartbeat-fence log lines are assertable). */
    function coordFor(backend: LockBackend, logs: string[] = []) {
      const lockDeps: LockDeps = {
        backend,
        now: () => new Date().toISOString(),
        hostId: "test-host",
        ttlSec: 900,
      };
      return createLeaseCoordinator({
        lockDeps,
        leaseEnabled: true,
        dryRun: false,
        logError: (line) => logs.push(line),
        dryLog: () => {},
      });
    }

    /** A backend whose createRef is contended and whose readRef throws
     *  LeaseReadError during the reclaim step. */
    function readThrowsBackend(): LockBackend {
      return {
        async createRef() {
          return { ok: false }; // contended → acquireLease returns null
        },
        async readRef(issue: number): Promise<never> {
          // reclaimIfExpired reads BEFORE the expiry check → throws here.
          throw new LeaseReadError(issue, "unreadable lock-commit");
        },
        async casRef() {
          return { ok: false };
        },
        async deleteRef() {},
      };
    }

    it("returns false (skip) when readRef throws LeaseReadError during reclaim", async () => {
      const coord = coordFor(readThrowsBackend());
      // Pre-fix: the LeaseReadError escapes → this rejects. Post-fix: false.
      await expect(coord.acquireIssueLease(71)).resolves.toBe(false);
    });

    it("still PROPAGATES a LeaseBackendError from acquire (not swallowed)", async () => {
      const backend: LockBackend = {
        async createRef(): Promise<never> {
          throw new LeaseBackendError(
            "fatal: could not read Username for 'https://github.com'",
          );
        },
        async readRef() {
          return null;
        },
        async casRef() {
          return { ok: false };
        },
        async deleteRef() {},
      };
      const coord = coordFor(backend);
      await expect(coord.acquireIssueLease(71)).rejects.toBeInstanceOf(
        LeaseBackendError,
      );
    });

    // -------------------------------------------------------------------------
    // Review Fix 2 — the heartbeat renewLeases loop is best-effort: a THROWN
    // backend error (LeaseBackendError / timeout) on one entry is logged and
    // swallowed (loop continues, entry KEPT), never crashing the loop nor
    // prematurely fencing. Only a clean null-CAS result deletes + FENCE-logs.
    // Drives the REAL renewLeases closure via the same coordinator seam.
    // -------------------------------------------------------------------------
    it("renewLeases: a renewLease THROW is caught+logged, resolves without throwing, keeps the entry", async () => {
      let casCalls = 0;
      const backend: LockBackend = {
        async createRef() {
          return { ok: true, oid: "oid1" }; // acquire wins → registry populated
        },
        async readRef() {
          return null;
        },
        async casRef() {
          casCalls += 1;
          // First CAS (the heartbeat) throws; later CASes (the fence probe
          // below) succeed so we can observe the entry survived.
          if (casCalls === 1) {
            throw new LeaseBackendError("fatal: unable to access: 503");
          }
          return { ok: true, oid: `oid${casCalls}` };
        },
        async deleteRef() {},
      };
      const logs: string[] = [];
      const coord = coordFor(backend, logs);
      expect(await coord.acquireIssueLease(71)).toBe(true);

      // Pre-fix: the thrown LeaseBackendError escapes renewLease → renewLeases
      // rejects. Post-fix: resolves.
      await expect(coord.renewLeases()).resolves.toBeUndefined();
      // It logged the transient heartbeat failure.
      const logged = logs.join("");
      expect(logged).toMatch(/renew/i);
      expect(logged).toContain("71");

      // Entry KEPT (not deleted like the clean-null lost-lease path): the fence
      // probe finds it in the registry and renews it (casRef now succeeds).
      expect(await coord.fenceIssue(71)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Fix 3 — inline-CAS fence before the actual ship/promote.
  // ---------------------------------------------------------------------------
  it("Fix 3: fence FAILS before non-staging ship → NOT marked done (deferred)", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const b = buildDeps({ leaseFenceValue: false });
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "81", title: "x", branch: "agent/issue-81" }]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 81 }),
      commits: [{ sha: "c81" }],
    });
    b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.leaseFences).toContain(81);
    // Lost the lease at ship time → never marked done, never shipped.
    expect(b.state.marksDone).toEqual([]);
    expect(result.shippedIssues).toEqual([]);
  });

  it("Fix 3: fence SUCCEEDS before non-staging ship → normal ship proceeds", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const b = buildDeps({ leaseFenceValue: true });
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "82", title: "x", branch: "agent/issue-82" }]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 82 }),
      commits: [{ sha: "c82" }],
    });
    b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(b.state.leaseFences).toContain(82);
    expect(b.state.marksDone.map((m) => m.issueNum)).toEqual([82]);
    expect(result.shippedIssues).toEqual([82]);
  });

  it("Fix 3: flag OFF → fence is a no-op and non-staging ship is unchanged", async () => {
    // No SANDCASTLE_CROSS_HOST_LEASE env; the mock still exposes fenceIssue but
    // defaults to true, so ship proceeds exactly as before the fence existed.
    const b = buildDeps();
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "83", title: "x", branch: "agent/issue-83" }]),
    });
    b.enqueue("implementer", {
      stdout: implementerStdout({ ghIssue: 83 }),
      commits: [{ sha: "c83" }],
    });
    b.enqueue("reviewer", { stdout: "Everything is good.\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(
      baseArgs({ iterations: 2, stagingEnabled: false }),
      b.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(result.shippedIssues).toEqual([83]);
    expect(b.state.marksDone.map((m) => m.issueNum)).toEqual([83]);
  });

  it("Fix 3: fence FAILS before staging promotion → issue excluded, not merged", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const { repoRoot, stagingPath, gitEnv, cleanup } = initStagingRepo();
    let launchPath = "";
    try {
      __setStagingWorktreePathForTests(stagingPath);
      // Clean live worktree on the integration branch so the FF would advance.
      launchPath = mkdtempSync(path.join(tmpdir(), "sc-lease-launch-"));
      rmSync(launchPath, { recursive: true, force: true });
      execFileSync("git", ["worktree", "add", "-q", launchPath, "feature/work"], {
        cwd: repoRoot,
        env: gitEnv,
        stdio: "ignore",
      });

      // #71 lost its lease between ship and promote (fence fails); no other
      // issue is in play.
      const b = buildDeps({ leaseFenceFor: (n) => n !== 71 });
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

      await runMain(
        baseArgs({ iterations: 1, repoRoot, stagingEnabled: true }),
        b.deps,
      );

      const status = JSON.parse(
        readFileSync(path.join(repoRoot, ".sandcastle", "status.json"), "utf8"),
      ) as SandcastleStatus;
      // Fence failed → #71 excluded from promotion → nothing counted merged.
      expect(b.state.leaseFences).toContain(71);
      expect(status.totals.merged).toBe(0);
    } finally {
      __setStagingWorktreePathForTests("");
      if (launchPath) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", launchPath], {
            cwd: repoRoot,
            env: gitEnv,
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      }
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Review Fix 4 — a LeaseBackendError THROWN by the staging promotion fence
  // must surface the SAME loud fatal as Fix 2 (exitCode 2 + "gh auth setup-git"
  // remediation), not escape runMain as a raw exit-1 stack trace. A lost-lease
  // (fenceIssue returns false) stays the existing needs-human exclusion — only
  // a THROWN backend error triggers the fatal halt.
  // ---------------------------------------------------------------------------
  it("Fix 4: LeaseBackendError from the staging promotion fence → loud exit 2 (not raw exit 1)", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const { repoRoot, stagingPath, gitEnv, cleanup } = initStagingRepo();
    let launchPath = "";
    try {
      __setStagingWorktreePathForTests(stagingPath);
      // Clean live worktree on the integration branch so the FF advances and we
      // reach the promotion fence loop.
      launchPath = mkdtempSync(path.join(tmpdir(), "sc-lease-launch-"));
      rmSync(launchPath, { recursive: true, force: true });
      execFileSync("git", ["worktree", "add", "-q", launchPath, "feature/work"], {
        cwd: repoRoot,
        env: gitEnv,
        stdio: "ignore",
      });

      const b = buildDeps();
      // The fence CAS hits an auth/network fault at promotion time.
      b.deps.fenceIssue = async () => {
        throw new LeaseBackendError(
          "fatal: could not read Username for 'https://github.com'",
        );
      };
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

      // Pre-fix: the throw escapes runMain → this rejects. Post-fix: exit 2.
      const result = await runMain(
        baseArgs({ iterations: 1, repoRoot, stagingEnabled: true }),
        b.deps,
      );

      expect(result.exitCode).toBe(2);
      const joined = b.state.errors.join("\n");
      expect(joined).toMatch(/auth|setup-git/i);
      expect(joined.toLowerCase()).not.toContain("contended");
    } finally {
      __setStagingWorktreePathForTests("");
      if (launchPath) {
        try {
          execFileSync("git", ["worktree", "remove", "--force", launchPath], {
            cwd: repoRoot,
            env: gitEnv,
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      }
      cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // Two-loop E2E — disjoint claims + reclaim-on-death over one shared store.
  // ---------------------------------------------------------------------------
  interface FakeLease {
    holder: string;
    expiresAt: number;
  }
  function wireSharedLease(
    deps: Deps,
    store: Map<number, FakeLease>,
    hostId: string,
    opts: { ttlMs?: number; neverRelease?: boolean } = {},
  ): void {
    const ttl = opts.ttlMs ?? 100_000;
    const holdsLive = (n: number): boolean => {
      const cur = store.get(n);
      return !!cur && cur.holder === hostId && cur.expiresAt > Date.now();
    };
    deps.acquireIssueLease = async (n) => {
      const cur = store.get(n);
      if (cur && cur.expiresAt > Date.now()) return false; // live peer holds it
      store.set(n, { holder: hostId, expiresAt: Date.now() + ttl }); // fresh/reclaim
      return true;
    };
    deps.leaseState = async (n) => {
      const cur = store.get(n);
      if (!cur) return "absent";
      return cur.expiresAt > Date.now() ? "live" : "expired";
    };
    deps.releaseIssueLease = async (n) => {
      if (opts.neverRelease) return; // stand in for a still-concurrent peer
      const cur = store.get(n);
      if (cur && cur.holder === hostId) store.delete(n);
    };
    deps.fenceIssue = async (n) => holdsLive(n);
  }

  it("E2E (a): two loops over one store make DISJOINT claims", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const store = new Map<number, FakeLease>();

    // Host A works [71,72]; releases are no-ops so its leases persist for the
    // duration, standing in for a still-running concurrent peer.
    const a = buildDeps();
    wireSharedLease(a.deps, store, "A", { neverRelease: true });
    a.enqueue("planner", {
      stdout: plannerStdout([
        { id: "71", title: "a1", branch: "agent/issue-71" },
        { id: "72", title: "a2", branch: "agent/issue-72" },
      ]),
    });
    a.enqueue("implementer", { stdout: implementerStdout({ ghIssue: 71 }), commits: [{ sha: "c71" }] });
    a.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
    a.enqueue("implementer", { stdout: implementerStdout({ ghIssue: 72 }), commits: [{ sha: "c72" }] });
    a.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
    a.enqueue("merger", { stdout: "merged" });
    a.enqueue("planner", { stdout: plannerStdout([]) });
    const ra = await runMain(baseArgs({ iterations: 2, stagingEnabled: false }), a.deps);

    // Host B works [72,73]: 72 is held live by A (contended → skip), 73 is free.
    const b = buildDeps();
    wireSharedLease(b.deps, store, "B", { neverRelease: true });
    b.enqueue("planner", {
      stdout: plannerStdout([
        { id: "72", title: "b1", branch: "agent/issue-72" },
        { id: "73", title: "b2", branch: "agent/issue-73" },
      ]),
    });
    b.enqueue("implementer", { stdout: implementerStdout({ ghIssue: 73 }), commits: [{ sha: "c73" }] });
    b.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });
    const rb = await runMain(baseArgs({ iterations: 2, stagingEnabled: false }), b.deps);

    expect(ra.exitCode).toBe(0);
    expect(rb.exitCode).toBe(0);
    // No issue was claimed by BOTH hosts.
    const aClaims = new Set(a.state.claims);
    const bClaims = new Set(b.state.claims);
    const claimOverlap = [...aClaims].filter((n) => bClaims.has(n));
    expect(claimOverlap).toEqual([]);
    // No issue was shipped by BOTH hosts.
    const shipOverlap = ra.shippedIssues.filter((n) => rb.shippedIssues.includes(n));
    expect(shipOverlap).toEqual([]);
    // Concretely: A took 71+72, B took only 73.
    expect([...aClaims].sort()).toEqual([71, 72]);
    expect([...bClaims].sort()).toEqual([73]);
  });

  it("E2E (b): loop-1 dies holding a lease → it expires → loop-2 reclaims and ships", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    const store = new Map<number, FakeLease>();

    // Loop-1 (host A) acquires #88, then "dies" — stops renewing. Simulate the
    // lapse by expiring its lease in the shared store.
    const a = buildDeps();
    wireSharedLease(a.deps, store, "A", { ttlMs: 50 });
    expect(await a.deps.acquireIssueLease(88)).toBe(true);
    store.get(88)!.expiresAt = Date.now() - 1; // lease lapsed after A went silent

    // Loop-2 (host B) targets #88; its lease is expired → B reclaims and ships.
    const b = buildDeps();
    wireSharedLease(b.deps, store, "B");
    b.enqueue("planner", {
      stdout: plannerStdout([{ id: "88", title: "orphaned", branch: "agent/issue-88" }]),
    });
    b.enqueue("implementer", { stdout: implementerStdout({ ghIssue: 88 }), commits: [{ sha: "c88" }] });
    b.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
    b.enqueue("merger", { stdout: "merged" });
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const rb = await runMain(baseArgs({ iterations: 2, stagingEnabled: false }), b.deps);

    expect(rb.exitCode).toBe(0);
    // B reclaimed the expired lease and shipped the orphaned issue.
    expect(rb.shippedIssues).toEqual([88]);
    expect(b.state.claims).toEqual([88]);
    // Non-staging ok ships release the lease, so after B's clean ship the ref is
    // gone — the full reclaim → ship → release cycle completed under host B.
    expect(store.get(88)).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Fix 5 — bounded git timeout + retry for lease ref ops.
  // ---------------------------------------------------------------------------
  describe("runGitLeaseRetrying (Fix 5)", () => {
    const timeoutRes: GitRunResult = {
      ok: false,
      stdout: "",
      stderr: "git ls-remote SIGTERM (killed by timeout)",
    };
    const okRes: GitRunResult = { ok: true, stdout: "deadbeef", stderr: "" };
    const contentionRes: GitRunResult = {
      ok: false,
      stdout: "",
      stderr: "! [rejected] (fetch first)\nfailed to push some refs",
    };
    const authRes: GitRunResult = {
      ok: false,
      stdout: "",
      stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    };

    it("retries once on a timeout then succeeds", () => {
      let calls = 0;
      const once = (): GitRunResult => {
        calls += 1;
        return calls === 1 ? timeoutRes : okRes;
      };
      const res = runGitLeaseRetrying(once, "ls-remote", "origin");
      expect(res.ok).toBe(true);
      expect(calls).toBe(2);
    });

    it("does NOT retry a clean push rejection (contention)", () => {
      let calls = 0;
      const once = (): GitRunResult => {
        calls += 1;
        return contentionRes;
      };
      const res = runGitLeaseRetrying(once, "push");
      expect(res.ok).toBe(false);
      expect(calls).toBe(1);
    });

    it("does NOT retry an auth failure", () => {
      let calls = 0;
      const once = (): GitRunResult => {
        calls += 1;
        return authRes;
      };
      runGitLeaseRetrying(once, "push");
      expect(calls).toBe(1);
    });

    it("caps at 2 attempts even if the timeout persists", () => {
      let calls = 0;
      const once = (): GitRunResult => {
        calls += 1;
        return timeoutRes;
      };
      const res = runGitLeaseRetrying(once, "ls-remote");
      expect(res.ok).toBe(false);
      expect(calls).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Fix 3 (review) — an auth failure whose text ALSO matches a transient
  // signature ("unable to access") must NOT be retried: the auth signature
  // vetoes the transient classification.
  // ---------------------------------------------------------------------------
  describe("isTransientLeaseGitFailure — auth veto (review Fix 3)", () => {
    const http403: GitRunResult = {
      ok: false,
      stdout: "",
      // git's real 403 wording: contains the transient substring "unable to
      // access" AND the auth signal "403".
      stderr:
        "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403",
    };
    const http401: GitRunResult = {
      ok: false,
      stdout: "",
      stderr:
        "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 401 Unauthorized",
    };
    const permDenied: GitRunResult = {
      ok: false,
      stdout: "",
      stderr:
        "fatal: unable to access 'https://github.com/o/r/': Permission denied (publickey)",
    };
    const realTimeout: GitRunResult = {
      ok: false,
      stdout: "",
      stderr: "fatal: unable to access 'https://x/': Could not resolve host: x",
    };

    it("classifies a 403 'unable to access' as NON-transient", () => {
      expect(isTransientLeaseGitFailure(http403)).toBe(false);
    });

    it("classifies a 401 'unable to access' as NON-transient", () => {
      expect(isTransientLeaseGitFailure(http401)).toBe(false);
    });

    it("classifies a permission-denied 'unable to access' as NON-transient", () => {
      expect(isTransientLeaseGitFailure(permDenied)).toBe(false);
    });

    it("still classifies a genuine resolve-host failure as transient", () => {
      expect(isTransientLeaseGitFailure(realTimeout)).toBe(true);
    });

    it("a 403 is NOT retried (single attempt); a resolve-host failure IS retried once", () => {
      let authCalls = 0;
      runGitLeaseRetrying(() => {
        authCalls += 1;
        return http403;
      }, "push");
      expect(authCalls).toBe(1);

      let netCalls = 0;
      runGitLeaseRetrying(() => {
        netCalls += 1;
        return realTimeout;
      }, "push");
      expect(netCalls).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Fix 6 — leaseState uses classifyLease + fail-closes a LeaseReadError.
  // ---------------------------------------------------------------------------
  describe("resolveLeaseState (Fix 6)", () => {
    const now = "2026-07-14T00:00:00.000Z";
    const liveLease: LockLease = {
      issue: 1,
      holder: "h",
      acquiredAt: now,
      expiresAt: "2026-07-14T00:10:00.000Z",
      epoch: 1,
      refOid: "oid",
    };
    const expiredLease: LockLease = {
      ...liveLease,
      expiresAt: "2026-07-13T00:00:00.000Z",
    };

    it("returns 'absent' when the read yields null", async () => {
      expect(await resolveLeaseState(async () => null, now)).toBe("absent");
    });

    it("returns 'live' for an unexpired lease", async () => {
      expect(await resolveLeaseState(async () => liveLease, now)).toBe("live");
    });

    it("returns 'expired' for a past-deadline lease", async () => {
      expect(await resolveLeaseState(async () => expiredLease, now)).toBe(
        "expired",
      );
    });

    it("treats a LeaseReadError as 'live' (fail-closed = occupied)", async () => {
      const res = await resolveLeaseState(async () => {
        throw new LeaseReadError(1, "corrupt lock-commit");
      }, now);
      expect(res).toBe("live");
    });

    it("rethrows a non-LeaseReadError", async () => {
      await expect(
        resolveLeaseState(async () => {
          throw new Error("boom");
        }, now),
      ).rejects.toThrow("boom");
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-host LANE SYNC (ADR 0019, Task B) — the code-sharing substrate wired
  // into the loop. Sync REQUIRES the lease; every lane git op is behind the
  // opt-in flag so a single-host consumer is byte-for-byte unchanged.
  // ---------------------------------------------------------------------------
  describe("lane sync wiring (Task B)", () => {
    it("startup guard: sync ON but lease OFF → refuses to start, no pipeline", async () => {
      process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";
      // SANDCASTLE_CROSS_HOST_LEASE intentionally unset.
      const b = buildDeps();
      b.enqueue("planner", {
        stdout: plannerStdout([{ id: "1", title: "x", branch: "agent/issue-1" }]),
      });

      const result = await runMain(
        baseArgs({ iterations: 2, stagingEnabled: false }),
        b.deps,
      );

      expect(result.exitCode).not.toBe(0);
      // Never ran the pipeline — no claim, no lane calls.
      expect(b.state.claims).toEqual([]);
      expect(b.state.syncLanesCalls).toEqual([]);
      expect(b.state.publishLaneCalls).toEqual([]);
      // Loud, actionable message naming the missing lease flag.
      expect(b.state.errors.join("\n")).toMatch(/lease/i);
    });

    it("flag OFF invariant: sync/publish are complete no-ops (never reached)", async () => {
      // Neither flag set — today's single-host behavior.
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
      b.enqueue("planner", { stdout: plannerStdout([]) });

      const result = await runMain(
        baseArgs({ iterations: 2, stagingEnabled: false }),
        b.deps,
      );

      expect(result.exitCode).toBe(0);
      expect(result.shippedIssues).toEqual([71]);
      // The invariant: with the flag off, the loop NEVER reaches deps.syncLanes
      // / deps.publishLane, so no fetch/push/ls-remote is even attempted.
      expect(b.state.syncLanesCalls).toEqual([]);
      expect(b.state.publishLaneCalls).toEqual([]);
      // Same invariant for STATUS SYNC (Task S5): syncStatusOnce lives under the
      // same `if (syncEnabled)` gate, so publish/fetch are never reached and the
      // store never receives peers.
      expect(b.state.publishStatusCalls).toEqual([]);
      expect(b.state.fetchStatusPeersCalls).toEqual([]);
    });

    it("flag ON --no-staging: syncs at iteration start, publishes after ship", async () => {
      process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
      process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";
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
      b.enqueue("planner", { stdout: plannerStdout([]) });

      const result = await runMain(
        baseArgs({ iterations: 2, stagingEnabled: false }),
        b.deps,
      );

      expect(result.exitCode).toBe(0);
      expect(result.shippedIssues).toEqual([71]);
      // Synced at the start of at least one iteration, on the integration branch.
      expect(b.state.syncLanesCalls.length).toBeGreaterThan(0);
      expect(b.state.syncLanesCalls[0]!.branch).toBe("feature/work");
      // Published the integration branch after the successful markDone ship.
      expect(b.state.publishLaneCalls).toContain("feature/work");
      // STATUS SYNC (Task S5) fires once per iteration under the same gate:
      // publish the own snapshot + fetch same-run peers.
      expect(b.state.publishStatusCalls.length).toBeGreaterThan(0);
      expect(b.state.fetchStatusPeersCalls.length).toBeGreaterThan(0);
      // The published payload is a valid own-only snapshot (no peers key).
      const pub = JSON.parse(b.state.publishStatusCalls[0]!) as SandcastleStatus;
      expect(pub.hostId).toBeTruthy();
      expect(pub.runId).toBeTruthy();
      expect("peers" in pub).toBe(false);
      // ORDERING (the real bug): the lane publish must fire AFTER the Phase-3
      // batch merger lands this iteration's work on `args.branch`. Publishing
      // before the merger force-pushes a STALE launch-branch tip missing the
      // just-shipped commit, so a peer syncs code that is silently behind.
      const mergerIdx = b.state.eventOrder.indexOf("merger");
      const publishIdx = b.state.eventOrder.indexOf("publishLane");
      expect(mergerIdx).toBeGreaterThanOrEqual(0);
      expect(publishIdx).toBeGreaterThanOrEqual(0);
      expect(publishIdx).toBeGreaterThan(mergerIdx);
    });

    it("two-loop E2E over a shared lane store: B sees A's shipped work; A dying + a conflict never stall/crash B", async () => {
      process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
      process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";

      // The shared fake origin: hostId → issue numbers published to its lane.
      const sharedLanes = new Map<string, number[]>();

      // ---- Loop A ships #101 and publishes its lane ----
      const a = buildDeps();
      a.enqueue("planner", {
        stdout: plannerStdout([{ id: "101", title: "A", branch: "agent/issue-101" }]),
      });
      a.enqueue("implementer", {
        stdout: implementerStdout({ ghIssue: 101 }),
        commits: [{ sha: "a101" }],
      });
      a.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
      a.enqueue("merger", { stdout: "merged" });
      a.enqueue("planner", { stdout: plannerStdout([]) });
      a.deps.syncLanes = async (branch, launchWorktreePath) => {
        a.state.syncLanesCalls.push({ branch, launchWorktreePath });
        return { peers: [] }; // no peers yet
      };
      a.deps.publishLane = async (branch) => {
        a.state.publishLaneCalls.push(branch);
        sharedLanes.set("hostA", [101]); // A's shipped code is now on the shared origin
      };
      const ra = await runMain(
        baseArgs({ iterations: 2, stagingEnabled: false }),
        a.deps,
      );
      expect(ra.exitCode).toBe(0);
      expect(ra.shippedIssues).toEqual([101]);
      expect(sharedLanes.get("hostA")).toEqual([101]);

      // ---- Loop A "dies" here (its run ended). Its #101 remains on the shared
      //      origin. Loop B now syncs, must SEE #101, ship dependent #102, and
      //      survive a conflicting peer without stalling or crashing. ----
      const seenByB: number[] = [];
      const b = buildDeps();
      b.enqueue("planner", {
        stdout: plannerStdout([{ id: "102", title: "B on A", branch: "agent/issue-102" }]),
      });
      b.enqueue("implementer", {
        stdout: implementerStdout({ ghIssue: 102 }),
        commits: [{ sha: "b102" }],
      });
      b.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
      b.enqueue("merger", { stdout: "merged" });
      b.enqueue("planner", { stdout: plannerStdout([]) });
      b.deps.syncLanes = async (branch, launchWorktreePath) => {
        b.state.syncLanesCalls.push({ branch, launchWorktreePath });
        const peers: {
          peer: string;
          status: "merged" | "conflict" | "skipped";
          reason?: string;
          conflictedFiles?: readonly string[];
        }[] = [];
        for (const [host, shipped] of sharedLanes) {
          if (host === "hostB") continue;
          for (const n of shipped) seenByB.push(n);
          peers.push({ peer: host, status: "merged" });
        }
        // A second peer whose merge CONFLICTS — must not crash the loop.
        peers.push({
          peer: "hostC",
          status: "conflict",
          reason: "merge conflict",
          conflictedFiles: ["x.ts"],
        });
        return { peers };
      };
      b.deps.publishLane = async (branch) => {
        b.state.publishLaneCalls.push(branch);
        sharedLanes.set("hostB", [102]);
      };
      const rb = await runMain(
        baseArgs({ iterations: 2, stagingEnabled: false }),
        b.deps,
      );

      // Conflict did NOT crash; B shipped its dependent issue.
      expect(rb.exitCode).toBe(0);
      expect(rb.shippedIssues).toEqual([102]);
      // B genuinely saw A's shipped work via the lane sync.
      expect(seenByB).toContain(101);
      expect(b.state.syncLanesCalls.length).toBeGreaterThan(0);
      // B published its own lane after shipping.
      expect(sharedLanes.get("hostB")).toEqual([102]);
      // The conflict was surfaced LOUD (durable run-log signal), not silent.
      expect(b.state.errors.join("\n")).toMatch(/conflict/i);
    });

    // -----------------------------------------------------------------------
    // REAL-GIT two-loop E2E (ADR 0019/0020). Closes the one honest coverage
    // gap: every OTHER runMain-level two-loop test above substitutes an
    // in-memory Map (`sharedLanes`) / a fake lease store (`wireSharedLease`)
    // for the lease + lane halves. This one drives TWO `runMain` instances
    // over ONE real bare git remote with the lease + lane halves of `Deps`
    // wired to the REAL git-backed factories (createGitLockBackend +
    // createLeaseCoordinator, createLaneSync) exactly as buildDefaultDeps does
    // (main.mts ~2907-2932, ~3147-3167) — only the coding-agent half stays
    // canned (buildDeps). Assertions read REAL refs off the REAL bare remote
    // via `ls-remote`, and REAL propagated file content in the peer's real
    // worktree — never an in-memory structure — so breaking the lease/lane
    // wiring turns this RED.
    describe("real-git two-loop E2E — runMain against REAL lease + lane refs", () => {
      /** A real GitRunner over `execFileSync` (mirrors main.mts:1589 & the
       *  helpers in lane-sync.test.ts / issue-lease.test.ts). */
      const realRunGit = (cwd: string, ...args: string[]): GitRunResult => {
        try {
          const stdout = execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          return { ok: true, stdout: stdout.trim(), stderr: "" };
        } catch (err) {
          const e = err as Error & {
            stderr?: Buffer | string;
            stdout?: Buffer | string;
          };
          const stderr =
            typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
          const stdout =
            typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
          return {
            ok: false,
            stdout: stdout.trim(),
            stderr: stderr.trim() || e.message,
          };
        }
      };
      /** git with a committer identity baked in, for seed/host commits. */
      const gitID = (cwd: string, ...args: string[]): GitRunResult =>
        realRunGit(cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args);

      const BRANCH = "feature/work"; // must match baseArgs().branch

      let tmp: string;
      let remote: string;
      let hostAClone: string;
      let hostBClone: string;

      beforeEach(() => {
        tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-xhost-e2e-"));
        remote = path.join(tmp, "remote.git");
        hostAClone = path.join(tmp, "hostA");
        hostBClone = path.join(tmp, "hostB");
        realRunGit(tmp, "init", "--bare", remote);

        // Seed the shared integration branch. `.gitignore` masks `.sandcastle/`
        // so the runtime run-log/status/lock files runMain writes under each
        // clone never dirty the worktree — otherwise syncInto's dirty-tree guard
        // would skip every peer merge and real code propagation could not happen.
        const seed = path.join(tmp, "seed");
        realRunGit(tmp, "clone", remote, seed);
        writeFileSync(path.join(seed, ".gitignore"), ".sandcastle/\n");
        writeFileSync(path.join(seed, "base.txt"), "base\n");
        gitID(seed, "add", "-A");
        gitID(seed, "commit", "-m", "base");
        gitID(seed, "branch", "-M", BRANCH);
        gitID(seed, "push", "origin", BRANCH);

        // Both hosts clone the shared remote and check out the shared branch, so
        // each clone's `origin` IS the one bare remote the leases/lanes live on.
        realRunGit(tmp, "clone", remote, hostAClone);
        gitID(hostAClone, "checkout", BRANCH);
        realRunGit(tmp, "clone", remote, hostBClone);
        gitID(hostBClone, "checkout", BRANCH);
      });

      afterEach(() => {
        // Env is scrubbed by the parent describe's afterEach; also scrub here so
        // this block is self-contained if ever re-homed.
        delete process.env.SANDCASTLE_CROSS_HOST_LEASE;
        delete process.env.SANDCASTLE_CROSS_HOST_SYNC;
        delete process.env.SANDCASTLE_HOST_ID;
        rmSync(tmp, { recursive: true, force: true });
      });

      /**
       * Override ONLY the lease + lane methods on a canned `buildDeps()` result
       * to delegate to the REAL git-backed factories over `clonePath`, mirroring
       * buildDefaultDeps' wiring (main.mts ~2907-2932, ~3146-3167). The
       * coding-agent half (run/createSandbox/claim/markDone/gh) stays canned.
       * `leaseEnabled: true` here matches the crossHostLeaseEnabled() env flag
       * the tests set — buildDefaultDeps resolves it the same way.
       */
      const wireRealHost = (
        b: DepsBuilder,
        clonePath: string,
        hostId: string,
      ): {
        coord: ReturnType<typeof createLeaseCoordinator>;
      } => {
        const lockDeps = {
          backend: createGitLockBackend({ git: realRunGit, repoRoot: clonePath }),
          now: () => new Date().toISOString(),
          hostId,
          ttlSec: 3600, // long TTL: a held lease stays LIVE for the whole test
        };
        const coord = createLeaseCoordinator({
          lockDeps,
          leaseEnabled: true,
          dryRun: false,
          logError: (line) => b.state.errors.push(line),
          dryLog: () => {},
        });
        // The five lease methods, spread exactly as buildDefaultDeps does.
        Object.assign(b.deps, coord);

        const laneSync = createLaneSync({
          git: realRunGit,
          repoRoot: clonePath,
          hostId,
        });
        // syncLanes / publishLane wrappers — same shape as buildDefaultDeps
        // (flag ON, not --dry-run): syncInto fetch+merges peer lanes through the
        // launch worktree; publish force-pushes this host's branch tip to its
        // lane ref. We also record the calls for the existing state assertions.
        b.deps.syncLanes = async (branch, launchWorktreePath) => {
          b.state.syncLanesCalls.push({ branch, launchWorktreePath });
          return laneSync.syncInto(branch, launchWorktreePath);
        };
        b.deps.publishLane = async (branch) => {
          b.state.publishLaneCalls.push(branch);
          b.state.eventOrder.push("publishLane");
          await laneSync.publish(branch);
        };

        // Cross-host STATUS SYNC (Task S6). Wire publishStatus/fetchStatusPeers
        // to a REAL createStatusSync over this clone, mirroring lane's
        // publishLane/syncLanes → laneSync wiring exactly (buildDefaultDeps
        // main.mts ~3006, ~3246-3265). publish bakes this host's own snapshot
        // JSON into an empty-tree commit and force-pushes it to
        // refs/sandcastle/status/<hostId> on the bare remote; fetchPeers
        // discovers same-run peers off that remote. We record the calls, but the
        // real proof is the on-disk merged hostB/.sandcastle/status.json.
        const statusSync = createStatusSync({
          git: realRunGit,
          repoRoot: clonePath,
          hostId,
        });
        b.deps.publishStatus = async (snapshotJson) => {
          b.state.publishStatusCalls.push(snapshotJson);
          return statusSync.publish(snapshotJson);
        };
        b.deps.fetchStatusPeers = async (runId) => {
          b.state.fetchStatusPeersCalls.push(runId);
          return statusSync.fetchPeers(runId);
        };
        return { coord };
      };

      it("Test 1 — happy path: A's real committed code propagates to B via real lane refs", async () => {
        process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
        process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";

        // hostA has a REAL committed file on its integration branch — this is the
        // code that must reach hostB. publishLane force-pushes this tip to
        // refs/sandcastle/lanes/hostA, so there is genuine content to propagate.
        const A_FILE = "from-hostA.txt";
        writeFileSync(path.join(hostAClone, A_FILE), "code from host A\n");
        gitID(hostAClone, "add", A_FILE);
        gitID(hostAClone, "commit", "-m", "hostA real work");
        const aTip = realRunGit(hostAClone, "rev-parse", BRANCH).stdout;

        // ---- hostA ships #101, publishes its lane ----
        process.env.SANDCASTLE_HOST_ID = "hostA";
        const a = buildDeps();
        wireRealHost(a, hostAClone, "hostA");
        a.enqueue("planner", {
          stdout: plannerStdout([{ id: "101", title: "A", branch: "agent/issue-101" }]),
        });
        a.enqueue("implementer", {
          stdout: implementerStdout({ ghIssue: 101 }),
          commits: [{ sha: "a101" }],
        });
        a.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
        a.enqueue("merger", { stdout: "merged" });
        a.enqueue("planner", { stdout: plannerStdout([]) });

        const ra = await runMain(
          baseArgs({ iterations: 2, stagingEnabled: false, repoRoot: hostAClone }),
          a.deps,
        );
        expect(ra.exitCode).toBe(0);
        expect(ra.shippedIssues).toEqual([101]);

        // REAL ref assertion (NOT a Map): A's lane exists on the bare remote and
        // points at A's real committed tip.
        const laneAOnRemote = realRunGit(
          tmp,
          "ls-remote",
          remote,
          "refs/sandcastle/lanes/hostA",
        );
        expect(laneAOnRemote.stdout).toContain("refs/sandcastle/lanes/hostA");
        expect(laneAOnRemote.stdout).toContain(aTip);
        // The real publish fired (through the real wiring).
        expect(a.state.publishLaneCalls).toContain(BRANCH);

        // ---- hostB syncs A's lane, then ships #102 ----
        process.env.SANDCASTLE_HOST_ID = "hostB";
        const b = buildDeps();
        wireRealHost(b, hostBClone, "hostB");
        b.enqueue("planner", {
          stdout: plannerStdout([{ id: "102", title: "B on A", branch: "agent/issue-102" }]),
        });
        b.enqueue("implementer", {
          stdout: implementerStdout({ ghIssue: 102 }),
          commits: [{ sha: "b102" }],
        });
        b.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
        b.enqueue("merger", { stdout: "merged" });
        b.enqueue("planner", { stdout: plannerStdout([]) });

        // Before B runs, A's file is NOT in B's clone.
        expect(existsSync(path.join(hostBClone, A_FILE))).toBe(false);

        const rb = await runMain(
          baseArgs({ iterations: 2, stagingEnabled: false, repoRoot: hostBClone }),
          b.deps,
        );
        expect(rb.exitCode).toBe(0);
        expect(rb.shippedIssues).toEqual([102]);

        // STRONGEST propagation proof: B's REAL launch worktree now contains A's
        // real committed file — the lane sync genuinely fetched+merged A's tip.
        expect(existsSync(path.join(hostBClone, A_FILE))).toBe(true);
        expect(readFileSync(path.join(hostBClone, A_FILE), "utf8")).toBe(
          "code from host A\n",
        );
        // B's sync ran and saw a peer.
        expect(b.state.syncLanesCalls.length).toBeGreaterThan(0);

        // REAL ref assertion: B's own lane exists on the bare remote after B
        // ships, and includes A's commit (B published its post-merge tip).
        const laneBOnRemote = realRunGit(
          tmp,
          "ls-remote",
          remote,
          "refs/sandcastle/lanes/hostB",
        );
        expect(laneBOnRemote.stdout).toContain("refs/sandcastle/lanes/hostB");
        const bTip = realRunGit(hostBClone, "rev-parse", BRANCH).stdout;
        expect(laneBOnRemote.stdout).toContain(bTip);
      });

      it("Test 2 — mutual exclusion: A's live real lock ref makes B fail to acquire #101", async () => {
        process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
        process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";

        // hostA acquires the REAL lease for #101 and does NOT release it — stands
        // in for "A is still working #101". This pushes refs/locks/issue-101 to
        // the shared bare remote via the real coordinator/backend.
        process.env.SANDCASTLE_HOST_ID = "hostA";
        const a = buildDeps();
        const { coord: coordA } = wireRealHost(a, hostAClone, "hostA");
        const aWon = await coordA.acquireIssueLease(101);
        expect(aWon).toBe(true);

        // REAL ref assertion: the lock ref exists on the bare remote.
        const lockOnRemote = realRunGit(
          tmp,
          "ls-remote",
          remote,
          "refs/locks/issue-101",
        );
        expect(lockOnRemote.stdout).toContain("refs/locks/issue-101");
        const lockOid = lockOnRemote.stdout.split(/\s+/)[0];

        // ---- hostB's runMain tries the SAME issue #101 → real git ref-exists
        //      rejection must make the acquire gate throw LeaseContendedError, so
        //      B skips it and ships nothing. ----
        process.env.SANDCASTLE_HOST_ID = "hostB";
        const b = buildDeps();
        wireRealHost(b, hostBClone, "hostB");
        b.enqueue("planner", {
          stdout: plannerStdout([{ id: "101", title: "B wants A's issue", branch: "agent/issue-101" }]),
        });
        // No implementer/reviewer/merger enqueued: if B wrongly acquired #101 and
        // ran the pipeline it would throw "no queued outcome", failing the test
        // LOUD rather than silently passing.
        b.enqueue("planner", { stdout: plannerStdout([]) });

        const rb = await runMain(
          baseArgs({ iterations: 2, stagingEnabled: false, repoRoot: hostBClone }),
          b.deps,
        );

        // B did not double-work #101: no claim, nothing shipped, exit clean
        // (contention is a routine SKIP, not a failure).
        expect(rb.exitCode).toBe(0);
        expect(rb.shippedIssues).not.toContain(101);
        expect(b.state.claims).not.toContain(101);
        expect(b.state.marksDone).toEqual([]);

        // A's real lock ref SURVIVED B's run (B's registry-guarded release is a
        // no-op for a ref it never won) — still present, still the same oid.
        const lockAfter = realRunGit(
          tmp,
          "ls-remote",
          remote,
          "refs/locks/issue-101",
        );
        expect(lockAfter.stdout).toContain("refs/locks/issue-101");
        expect(lockAfter.stdout.split(/\s+/)[0]).toBe(lockOid);
      });

      it("Test 3 — status fusion: B's real merged status.json fuses A's published snapshot (peer + host-tagged history)", async () => {
        process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
        process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";

        // Both hosts pass the SAME explicit --branch (= BRANCH) via baseArgs, so
        // deriveRunBranchAndId returns runId === BRANCH for BOTH (explicit branch
        // is never host-suffixed). Same runId ⇒ each host's published status
        // snapshot is same-run ⇒ fetchPeers keeps it and foldPeers fuses it. We
        // assert this runId-sharing below off the REAL published snapshots.

        // ---- hostA ships #101, publishes its status ref ----
        // syncStatusOnce fires at the START of each iteration (main.mts ~5933,
        // before the planner). A's #101 is recorded by iteration 1's merger; A
        // then PUBLISHES that history at iteration-2 start — so A's published
        // status ref carries #101 in its history BEFORE B ever fetches.
        process.env.SANDCASTLE_HOST_ID = "hostA";
        const a = buildDeps();
        wireRealHost(a, hostAClone, "hostA");
        a.enqueue("planner", {
          stdout: plannerStdout([{ id: "101", title: "A", branch: "agent/issue-101" }]),
        });
        a.enqueue("implementer", {
          stdout: implementerStdout({ ghIssue: 101 }),
          commits: [{ sha: "a101" }],
        });
        a.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
        a.enqueue("merger", { stdout: "merged" });
        a.enqueue("planner", { stdout: plannerStdout([]) });

        const ra = await runMain(
          baseArgs({ iterations: 2, stagingEnabled: false, repoRoot: hostAClone }),
          a.deps,
        );
        expect(ra.exitCode).toBe(0);
        expect(ra.shippedIssues).toEqual([101]);

        // REAL ref assertion (NOT a Map): A's status ref exists on the bare
        // remote — the real publish force-pushed A's snapshot commit there.
        const statusAOnRemote = realRunGit(
          tmp,
          "ls-remote",
          remote,
          "refs/sandcastle/status/hostA",
        );
        expect(statusAOnRemote.stdout).toContain("refs/sandcastle/status/hostA");
        expect(a.state.publishStatusCalls.length).toBeGreaterThan(0);

        // runId-sharing proof: every snapshot A published carries runId === BRANCH.
        for (const json of a.state.publishStatusCalls) {
          const snap = JSON.parse(json) as SandcastleStatus;
          expect(snap.runId).toBe(BRANCH);
        }
        // A's LAST published snapshot (iteration-2 start) already carries #101 in
        // its history — the timing that lets B see A's shipped row.
        const aLastPublished = JSON.parse(
          a.state.publishStatusCalls[a.state.publishStatusCalls.length - 1]!,
        ) as SandcastleStatus;
        expect(aLastPublished.history.map((h) => h.number)).toContain(101);

        // ---- hostB ships #102, fetches + folds A's status ----
        process.env.SANDCASTLE_HOST_ID = "hostB";
        const b = buildDeps();
        wireRealHost(b, hostBClone, "hostB");
        b.enqueue("planner", {
          stdout: plannerStdout([{ id: "102", title: "B", branch: "agent/issue-102" }]),
        });
        b.enqueue("implementer", {
          stdout: implementerStdout({ ghIssue: 102 }),
          commits: [{ sha: "b102" }],
        });
        b.enqueue("reviewer", { stdout: "good\n\nALL_CLEAR" });
        b.enqueue("merger", { stdout: "merged" });
        b.enqueue("planner", { stdout: plannerStdout([]) });

        const rb = await runMain(
          baseArgs({ iterations: 2, stagingEnabled: false, repoRoot: hostBClone }),
          b.deps,
        );
        expect(rb.exitCode).toBe(0);
        expect(rb.shippedIssues).toEqual([102]);
        expect(b.state.fetchStatusPeersCalls).toContain(BRANCH);

        // STRONGEST fusion proof: read B's REAL on-disk merged status.json — the
        // file a cross-host viewer would render — and confirm it fuses A.
        const bStatus = JSON.parse(
          readFileSync(path.join(hostBClone, ".sandcastle", "status.json"), "utf8"),
        ) as SandcastleStatus;

        // B's own identity is present and correct. NOTE: the snapshot `hostId`
        // field is the resolveHostId()-SANITIZED id (lower-cased), so env
        // "hostB" → "hostb" here; the status REF suffix stays the raw "hostB"
        // (asserted above). Production uses resolveHostId() for both, so they
        // agree there — this describe block wires the raw id to match Tests 1/2.
        expect(bStatus.hostId).toBe("hostb");
        expect(bStatus.runId).toBe(BRANCH);

        // (1) peers[] includes hostA with A's totals — B genuinely folded A's
        //     fetched snapshot (setPeers → foldPeers), not a happy mock.
        expect(bStatus.peers).toBeDefined();
        const peerA = bStatus.peers!.find((p) => p.hostId === "hosta");
        expect(peerA).toBeDefined();
        expect(peerA!.totals.merged).toBe(1); // A shipped #101

        // (2) history is a genuinely MERGED, host-tagged Recent list: #101 tagged
        //     hosta (A's shipped issue, folded from A's published snapshot) AND
        //     #102 tagged hostb (B's own). This is the fused cross-host feed.
        const rowA = bStatus.history.find((h) => h.number === 101);
        const rowB = bStatus.history.find((h) => h.number === 102);
        expect(rowA).toBeDefined();
        expect(rowA!.hostId).toBe("hosta");
        expect(rowB).toBeDefined();
        expect(rowB!.hostId).toBe("hostb");

        // Host A's OWN file is deliberately NOT asserted to fuse both: A ran to
        // completion BEFORE B ever published its status ref, so A never fetched
        // B — A only ever saw itself. The third pass below closes that loop.

        // ---- OPTIONAL third pass: A runs ONE more iteration AFTER B, now sees B
        //      too — fully realizing "each host sees both". A's fresh run fetches
        //      B's published status ref (which now carries #102) at iteration
        //      start and folds it. ----
        process.env.SANDCASTLE_HOST_ID = "hostA";
        const a2 = buildDeps();
        wireRealHost(a2, hostAClone, "hostA");
        a2.enqueue("planner", { stdout: plannerStdout([]) }); // no new work; just sync

        const ra2 = await runMain(
          baseArgs({ iterations: 1, stagingEnabled: false, repoRoot: hostAClone }),
          a2.deps,
        );
        expect(ra2.exitCode).toBe(0);
        expect(a2.state.fetchStatusPeersCalls).toContain(BRANCH);

        const aStatus = JSON.parse(
          readFileSync(path.join(hostAClone, ".sandcastle", "status.json"), "utf8"),
        ) as SandcastleStatus;
        expect(aStatus.hostId).toBe("hosta");
        const aPeerB = aStatus.peers?.find((p) => p.hostId === "hostb");
        expect(aPeerB).toBeDefined();
        expect(aPeerB!.totals.merged).toBe(1); // B shipped #102
        // A's fused history now carries B's #102 (tagged hostb) alongside its own.
        const aRowB = aStatus.history.find((h) => h.number === 102);
        expect(aRowB).toBeDefined();
        expect(aRowB!.hostId).toBe("hostb");
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-host STATUS SYNC — syncStatusOnce (Task S5)
// ---------------------------------------------------------------------------

describe("syncStatusOnce (cross-host status fold)", () => {
  function makeSyncStore() {
    const writes: string[] = [];
    const store = createStatusStore(
      {
        branch: "sandcastle/run-s5",
        repo: "affinity-tracker",
        repoRoot: "/tmp/sandcastle-s5",
        startedAt: "2026-07-14T00:00:00.000Z",
        iterationsTotal: 10,
        maxConcurrent: 2,
        hostId: "host-a",
        runId: "run-s5",
      },
      { writeFn: (_p, c) => writes.push(c), now: () => "2026-07-14T00:00:00.000Z" },
    );
    return { store, writes };
  }

  function peerSnap(): SandcastleStatus {
    return {
      schemaVersion: 3,
      state: "running",
      hostId: "host-b",
      runId: "run-s5",
      run: {
        branch: "sandcastle/run-s5",
        repo: "affinity-tracker",
        startedAt: "2026-07-14T00:00:00.000Z",
        iterations: { current: 1, total: 10 },
        maxConcurrent: 2,
      },
      totals: { merged: 0, needsHuman: 0, requeued: 0, running: 1 },
      issues: [],
      history: [],
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
  }

  it("publishes the OWN snapshot JSON and folds the fetched peers via setPeers", async () => {
    const { store, writes } = makeSyncStore();
    const published: string[] = [];
    const peer = peerSnap();
    const deps = {
      async publishStatus(json: string) {
        published.push(json);
        return { ok: true };
      },
      async fetchStatusPeers(_runId: string) {
        return [peer];
      },
      logError: () => undefined,
    };

    await syncStatusOnce(store, deps);

    // Published the own-only snapshot (no peers key, host-a identity).
    expect(published).toHaveLength(1);
    const pubbed = JSON.parse(published[0]!) as SandcastleStatus;
    expect(pubbed.hostId).toBe("host-a");
    expect(pubbed.runId).toBe("run-s5");
    expect("peers" in pubbed).toBe(false);

    // setPeers ran → the LAST written file carries the peer.
    const written = JSON.parse(writes.at(-1)!) as SandcastleStatus;
    expect(written.peers).toHaveLength(1);
    expect(written.peers![0]!.hostId).toBe("host-b");
  });

  it("passes the own runId to fetchStatusPeers", async () => {
    const { store } = makeSyncStore();
    const runIds: string[] = [];
    await syncStatusOnce(store, {
      async publishStatus() {
        return { ok: true };
      },
      async fetchStatusPeers(runId: string) {
        runIds.push(runId);
        return [];
      },
      logError: () => undefined,
    });
    expect(runIds).toEqual(["run-s5"]);
  });

  it("a failed publish is logged, does NOT throw, and execution still reaches fetch + setPeers", async () => {
    const { store, writes } = makeSyncStore();
    const errors: string[] = [];
    let fetched = false;
    const peer = peerSnap();

    await expect(
      syncStatusOnce(store, {
        async publishStatus() {
          return { ok: false, error: "push rejected" };
        },
        async fetchStatusPeers() {
          fetched = true;
          return [peer];
        },
        logError: (line: string) => errors.push(line),
      }),
    ).resolves.toBeUndefined();

    // Logged the publish failure with the error detail.
    expect(errors.some((e) => e.includes("publish failed") && e.includes("push rejected"))).toBe(true);
    // Still fetched peers and folded them despite the publish failure.
    expect(fetched).toBe(true);
    const written = JSON.parse(writes.at(-1)!) as SandcastleStatus;
    expect(written.peers).toHaveLength(1);
  });

  it("no peers fetched ⇒ setPeers([]) ⇒ written file stays own-only (byte-clean)", async () => {
    const { store, writes } = makeSyncStore();
    const beforeLen = writes.length;
    await syncStatusOnce(store, {
      async publishStatus() {
        return { ok: true };
      },
      async fetchStatusPeers() {
        return [];
      },
      logError: () => undefined,
    });
    // setPeers([]) still commits once, but with NO peers key.
    expect(writes.length).toBeGreaterThan(beforeLen);
    const written = JSON.parse(writes.at(-1)!) as SandcastleStatus;
    expect("peers" in written).toBe(false);
  });
});
