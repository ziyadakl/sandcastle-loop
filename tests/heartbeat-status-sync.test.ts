/**
 * Heartbeat-driven cross-host STATUS SYNC (ADR 0020, follow-up to Task S5).
 *
 * The cross-host status sync must NOT fire only once per iteration: on a long
 * single iteration the fused multi-host viewer would freeze because peers never
 * refresh. The lease-heartbeat `setInterval` (which renews leases at ~ttl/3,
 * floored at 30s) must ALSO run `syncStatusOnce` when cross-host sync is
 * enabled — so peers keep refreshing even mid-iteration.
 *
 * This drives the real `runMain` with the same hand-built `Deps` harness used
 * by `tests/main.test.ts` (buildDeps / baseArgs / plannerStdout are ported
 * verbatim here — this file may edit ONLY main.mts + itself, so it cannot
 * import the un-exported harness). Only the `setInterval`/`clearInterval` pair
 * is faked (via `vi.useFakeTimers({ toFake: [...] })`) so the heartbeat can be
 * driven deterministically while the rest of runMain's real I/O (file lock,
 * git, Date) runs untouched.
 *
 * The distinction between heartbeat-driven and per-iteration sync is exact:
 *   - The heartbeat is set up BEFORE the iteration loop.
 *   - `iterationStartHook` fires at the TOP of the iteration, BEFORE the sole
 *     per-iteration `syncStatusOnce` (which runs later, after the planner).
 *   - So a publish observed inside the hook can ONLY have come from the timer.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  runMain,
  __resetTransientStateForTests,
  type Deps,
  type SandcastleArgs,
  type SandboxRunSpec,
  type TopLevelRunSpec,
  type CreateSandboxSpec,
  type RunHandle,
  type SandboxHandle,
} from "../.sandcastle/main.mjs";

// ---------------------------------------------------------------------------
// Harness — ported from tests/main.test.ts (only the pieces the empty-planner
// path needs). Kept structurally identical so behavior matches that suite.
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
  lintCertChecks: { repoRoot: string; preSha: string; postSha: string }[];
  testCertChecks: { repoRoot: string; preSha: string; postSha: string }[];
  logs: string[];
  errors: string[];
  leaseAcquires: number[];
  leaseReleases: number[];
  leaseStateCalls: number[];
  leaseRenews: number;
  leaseReleaseAllCalls: number;
  leaseFences: number[];
  syncLanesCalls: { branch: string; launchWorktreePath: string }[];
  publishLaneCalls: string[];
  publishStatusCalls: string[];
  fetchStatusPeersCalls: string[];
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

interface RunOutcome {
  readonly stdout: string;
  readonly commits?: readonly { sha: string }[];
  readonly throw?: Error;
}

interface DepsBuilder {
  readonly state: MockState;
  readonly deps: Deps;
  enqueue(name: string, outcome: RunOutcome): void;
}

function buildDeps(): DepsBuilder {
  const state = newState();
  const queues = new Map<string, RunOutcome[]>();

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
    async markMergedToStaging(_n) {},
    async promoteStagingToDone(_ns, _summary) {
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
    async listIssuesByLabel(_label) {
      return [];
    },
    async listOpenIssuesWithBodies() {
      return [];
    },
    async applyMigrations(repoRoot, preSha, postSha) {
      state.migrationsCalls.push({ repoRoot, preSha, postSha });
      return { applied: 0, realErrors: [] };
    },
    async validateMigrationJournal(_repoRoot, _preSha, _postSha) {
      return [];
    },
    async checkLintCert(repoRoot, preSha, postSha) {
      state.lintCertChecks.push({ repoRoot, preSha, postSha });
      return { status: "dormant" };
    },
    async checkTestCert(repoRoot, preSha, postSha) {
      state.testCertChecks.push({ repoRoot, preSha, postSha });
      return { status: "dormant" };
    },
    async captureSha(_w) {
      return "sha-x";
    },
    async acquireIssueLease(n) {
      state.leaseAcquires.push(n);
      return true;
    },
    async releaseIssueLease(n) {
      state.leaseReleases.push(n);
    },
    async leaseState(n) {
      state.leaseStateCalls.push(n);
      return "absent";
    },
    async renewLeases() {
      state.leaseRenews += 1;
    },
    async releaseAllLeases() {
      state.leaseReleaseAllCalls += 1;
    },
    async fenceIssue(n) {
      state.leaseFences.push(n);
      return true;
    },
    async syncLanes(branch, launchWorktreePath) {
      state.syncLanesCalls.push({ branch, launchWorktreePath });
      return { peers: [] };
    },
    async publishLane(branch) {
      state.publishLaneCalls.push(branch);
      state.eventOrder.push("publishLane");
    },
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
    iterationStartHook: undefined,
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

const TEST_REPO_ROOT = mkdtempSync(path.join(tmpdir(), "sandcastle-heartbeat-test-"));

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

function plannerStdout(issues: { id: string; title: string; branch: string }[]): string {
  return `<plan>${JSON.stringify({ issues })}</plan>`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cross-host status sync fires from the lease heartbeat (not only per-iteration)", () => {
  const ENV_KEYS = [
    "SANDCASTLE_CROSS_HOST_LEASE",
    "SANDCASTLE_CROSS_HOST_SYNC",
    "SANDCASTLE_LOCK_TTL_SEC",
  ];

  afterEach(() => {
    vi.useRealTimers();
    for (const k of ENV_KEYS) delete process.env[k];
    __resetTransientStateForTests();
  });

  // Drive ONE long iteration: block at the iteration-start hook (which fires
  // BEFORE the per-iteration sync), advance the faked heartbeat interval, and
  // snapshot the recorders AT THAT POINT. A publish seen here can only have
  // come from the timer, never the per-iteration call.
  //
  // renewMs = max(30000, ttl*1000/3). With ttl=90 → renewMs=30000, so advancing
  // 35s fires the heartbeat at least once.
  function setupLongIteration(b: DepsBuilder): {
    renewsAtHeartbeat: () => number;
    publishesAtHeartbeat: () => number;
  } {
    let renews = -1;
    let publishes = -1;
    b.deps.iterationStartHook = async (it: number) => {
      if (it !== 1) return;
      // Only setInterval/clearInterval are faked, so runMain's real awaits
      // (file lock, git, Date) up to this point ran normally. Now push the
      // clock past the renew floor so the unref'd heartbeat callback runs.
      await vi.advanceTimersByTimeAsync(35_000);
      renews = b.state.leaseRenews;
      publishes = b.state.publishStatusCalls.length;
    };
    return {
      renewsAtHeartbeat: () => renews,
      publishesAtHeartbeat: () => publishes,
    };
  }

  it("sync ENABLED → the heartbeat timer publishes a status snapshot mid-iteration, distinct from the per-iteration call", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";
    process.env.SANDCASTLE_LOCK_TTL_SEC = "90"; // renewMs = 30000
    __resetTransientStateForTests(); // clear memoized TTL so the env above is read

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const b = buildDeps();
    const probe = setupLongIteration(b);
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 1 }), b.deps);

    expect(result.exitCode).toBe(0);

    // The heartbeat timer FIRED at all (renewLeases ran from the interval).
    expect(probe.renewsAtHeartbeat()).toBeGreaterThanOrEqual(1);

    // ...and it ALSO drove a status sync — observed inside the hook, BEFORE the
    // per-iteration syncStatusOnce (which runs later, after the planner). This
    // is the whole fix: without folding sync into the heartbeat this is 0.
    expect(probe.publishesAtHeartbeat()).toBeGreaterThanOrEqual(1);

    // The per-iteration call still fires too (the double-fire is intentional and
    // idempotent): total publishes across the iteration ≥ heartbeat + per-iter.
    expect(b.state.publishStatusCalls.length).toBeGreaterThanOrEqual(2);
    expect(b.state.fetchStatusPeersCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("sync DISABLED (lease on, sync off) → the heartbeat renews leases but never publishes status", async () => {
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    // SANDCASTLE_CROSS_HOST_SYNC intentionally unset.
    process.env.SANDCASTLE_LOCK_TTL_SEC = "90";
    __resetTransientStateForTests();

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    const b = buildDeps();
    const probe = setupLongIteration(b);
    b.enqueue("planner", { stdout: plannerStdout([]) });

    const result = await runMain(baseArgs({ iterations: 1 }), b.deps);

    expect(result.exitCode).toBe(0);

    // Heartbeat still fired (leases renewed)...
    expect(probe.renewsAtHeartbeat()).toBeGreaterThanOrEqual(1);
    // ...but the sync is gated OFF, so nothing is ever published — not from the
    // heartbeat and not per-iteration (the whole sync block is flag-gated).
    expect(probe.publishesAtHeartbeat()).toBe(0);
    expect(b.state.publishStatusCalls).toEqual([]);
  });
});
