/**
 * REAL-GIT END-TO-END for ADR 0021 checkpoint-stop → resume-from-WIP.
 *
 * Everything here drives the PRODUCTION functions against a REAL local bare
 * origin with real clones acting as separate hosts (offline, real git
 * semantics — never the real network). Nothing re-implements the production git
 * commands: the write side calls `checkpointStop(makeExecFileGitRunner(), …)`
 * and the resume side calls `macHostSandbox(…).createSandbox(…)` verbatim, so a
 * green assertion is evidence the shipped code path actually works — not a
 * tautology over a hand-rolled copy.
 *
 * The tests are deliberately paired with a flag-OFF / nothing-to-save CONTROL so
 * each "it resumed" assertion is provably non-vacuous: the same drive with the
 * feature disabled produces a FRESH worktree WITHOUT the partial work, which
 * would fail the resume assertion — the "red before green" the regression locks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  checkpointStop,
  type CheckpointStopResult,
} from "../.sandcastle/lib/state/checkpoint-stop.js";
import {
  resolveReuseDecision,
  makeExecFileGitRunner,
  makeSyncGitRunner,
} from "../.sandcastle/lib/state/index.js";
import { macHostSandbox } from "../.sandcastle/lib/mac-host-sandbox.js";
import { worktreePathFor } from "../.sandcastle/lib/worktree-path.js";
import { buildDefaultDeps } from "../.sandcastle/main.mjs";
import type { SandcastleArgs } from "../.sandcastle/main.mjs";

/** Run git synchronously for TEST SETUP/ASSERTIONS (not production code). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** ls-remote a single ref; returns the SHA it points at, or "" when absent. */
function lsRemote(cwd: string, ref: string, remote = "origin"): string {
  const out = git(cwd, "ls-remote", remote, ref);
  const first = out.split("\n").find((l) => l.trim().length > 0);
  return first ? first.split(/\s+/)[0] : "";
}

/** Push an in-flight issue lease at refs/locks/issue-<n> on the remote. */
function pushLock(repo: string, n: number): void {
  const commit = git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit-tree",
    "4b825dc642cb6eb9a060e54bf8d69288fbee4904", // empty-tree OID
    "-m",
    `lock ${n}`,
  );
  git(repo, "push", "origin", `${commit}:refs/locks/issue-${n}`);
}

describe("checkpoint-stop → resume-from-WIP (real bare origin + real clones)", () => {
  let tmp: string;
  let remote: string;

  /** Clone the bare origin into a fresh host directory with a git identity. */
  function makeHost(name: string): string {
    const repo = path.join(tmp, name);
    git(tmp, "clone", remote, repo);
    git(repo, "config", "user.email", `${name}@t.test`);
    git(repo, "config", "user.name", name);
    return repo;
  }

  /** Seed origin with an `main` integration branch carrying a base file. */
  function seedOrigin(): void {
    const seed = path.join(tmp, "seed");
    git(tmp, "clone", remote, seed);
    git(seed, "config", "user.email", "seed@t.test");
    git(seed, "config", "user.name", "seed");
    writeFileSync(path.join(seed, "base.txt"), "base content\n");
    git(seed, "add", "base.txt");
    git(seed, "commit", "-m", "base");
    git(seed, "branch", "-M", "main");
    git(seed, "push", "-u", "origin", "main");
    rmSync(seed, { recursive: true, force: true });
  }

  /**
   * Add an `agent/issue-<n>` worktree cut from origin/main and write a
   * distinctive uncommitted marker file into it. Returns the worktree path and
   * the exact marker content so the caller can assert on it later.
   */
  function makeInflightWorktree(
    repo: string,
    n: number,
    marker: string,
  ): { wtPath: string; markerFile: string } {
    const branch = `agent/issue-${n}`;
    const wtPath = path.join(repo, worktreePathFor(branch));
    git(repo, "worktree", "add", "-b", branch, wtPath, "origin/main");
    const markerFile = "PARTIAL_WORK.txt";
    writeFileSync(path.join(wtPath, markerFile), marker);
    return { wtPath, markerFile };
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-ckpt-e2e-"));
    remote = path.join(tmp, "remote.git");
    git(tmp, "init", "--bare", remote);
    seedOrigin();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // TEST 1 — WRITE side: real checkpointStop persists WIP + releases lease.
  // -------------------------------------------------------------------------
  it("checkpointStop pushes the partial work to the WIP ref and deletes the lease", async () => {
    const host = makeHost("hostA");
    const marker = "PARTIAL-WORK-MARKER-issue7-abc123-write";
    makeInflightWorktree(host, 7, marker);
    pushLock(host, 7);

    // Precondition: the lease is really on origin before we start.
    expect(lsRemote(host, "refs/locks/issue-7")).not.toBe("");
    expect(lsRemote(host, "refs/sandcastle/wip/issue-7")).toBe("");

    const results = await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: host,
      hostId: "host-A",
      integrationBranch: "main",
      remote: "origin",
      // Per-issue sweep only — no staging strand in this fixture.
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    // Outcome for issue 7 is "checkpointed" at the canonical WIP ref.
    const r7 = results.find((r) => r.issue === 7) as CheckpointStopResult;
    expect(r7.outcome).toBe("checkpointed");
    expect(r7.wipRef).toBe("refs/sandcastle/wip/issue-7");

    // The WIP ref now EXISTS on origin ...
    const wipSha = lsRemote(host, "refs/sandcastle/wip/issue-7");
    expect(wipSha).not.toBe("");

    // ... and the commit it points at CONTAINS the distinctive partial work
    // (read straight from the bare origin — no local artifact could fake it).
    const savedContent = git(remote, "show", `${wipSha}:PARTIAL_WORK.txt`);
    expect(savedContent).toBe(marker);

    // ... and the lease is GONE (released so a peer may reclaim).
    expect(lsRemote(host, "refs/locks/issue-7")).toBe("");
  });

  // NON-VACUITY CONTROL for TEST 1: a CLEAN, not-ahead worktree has nothing to
  // save, so checkpointStop must NOT push a WIP ref nor touch the lease. This
  // proves the "checkpointed" assertions above distinguish real work from none.
  it("CONTROL: a clean worktree yields nothing-to-save, no WIP ref, lease untouched", async () => {
    const host = makeHost("hostA");
    // Worktree with NO uncommitted edit (branch tip === origin/main).
    const branch = "agent/issue-9";
    const wtPath = path.join(host, worktreePathFor(branch));
    git(host, "worktree", "add", "-b", branch, wtPath, "origin/main");
    pushLock(host, 9);

    const results = await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: host,
      hostId: "host-A",
      integrationBranch: "origin/main",
      remote: "origin",
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    const r9 = results.find((r) => r.issue === 9) as CheckpointStopResult;
    expect(r9.outcome).toBe("nothing-to-save");
    // No WIP ref was created ...
    expect(lsRemote(host, "refs/sandcastle/wip/issue-9")).toBe("");
    // ... and the lease is STILL held (clean worktree must not release it).
    expect(lsRemote(host, "refs/locks/issue-9")).not.toBe("");
  });

  // -------------------------------------------------------------------------
  // TEST 1c (ADR 0021 Fix 2) — LAUNCH-TIME REAPER via the PRODUCTION binding.
  // The startup reaper is `buildDefaultDeps(args).checkpointInflight()`; driving
  // THAT (not a hand-rolled checkpointStop call) proves the wiring decision the
  // launch path adds — integrationBranch = args.branch, stagingBranch = null,
  // remote = origin — actually persists WIP + releases the lease, and that a
  // fresh clone can then RESUME from the checkpoint rather than start from
  // scratch. Paired with a clean-launch control so the assertions are non-vacuous.
  // -------------------------------------------------------------------------

  /** A full SandcastleArgs pinned to `host` with `main` as the run branch (so
   *  the reaper measures in-flight commits against main). Only the fields
   *  buildDefaultDeps touches for the reaper matter; the rest are inert defaults. */
  function reaperArgs(host: string): SandcastleArgs {
    return {
      iterations: 1,
      repoRoot: host,
      branch: "main",
      runId: "main",
      label: "ready-for-agent",
      maxConcurrent: 1,
      imageName: "sandcastle:test",
      plannerModel: "claude-opus-4-8",
      implementerModel: "claude-sonnet-4-6",
      reviewerModel: "claude-haiku-4-5",
      critiqueModel: "claude-haiku-4-5",
      mergerModel: "claude-opus-4-8",
      postMergeReviewerModel: "claude-opus-4-8",
      recoveryModel: "claude-opus-4-8",
      implementerTimeoutSec: 1200,
      implementerTimeoutSecExplicit: false,
      reviewerTimeoutSec: 600,
      hardCeilingSec: 3600,
      consecutiveFailureLimit: 3,
      opusProfile: "4.8",
      budget: false,
      dryRun: false,
      recoveryEnabled: true,
      retryEnabled: true,
      stagingEnabled: true,
      allowDirtySandcastle: false,
      sandbox: "mac-host",
      stuckDetector: false,
    };
  }

  /** Run `fn` with SANDCASTLE_CROSS_HOST_SYNC forced to `val` (undefined = unset),
   *  restoring the prior value afterwards — the reaper reads it via
   *  `crossHostSyncEnabled()` straight off `process.env`. */
  async function withSyncEnv(
    val: string | undefined,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev = process.env.SANDCASTLE_CROSS_HOST_SYNC;
    if (val === undefined) delete process.env.SANDCASTLE_CROSS_HOST_SYNC;
    else process.env.SANDCASTLE_CROSS_HOST_SYNC = val;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.SANDCASTLE_CROSS_HOST_SYNC;
      else process.env.SANDCASTLE_CROSS_HOST_SYNC = prev;
    }
  }

  // ADR 0021 INERTNESS: the launch-time reaper runs at EVERY start, so a flag-OFF
  // single-host consumer that crashed must NOT push WIP refs to its app's origin.
  // With sync OFF the reaper captures the crashed WIP to a LOCAL ref (enough for a
  // same-host resume) and writes NOTHING to origin. Non-vacuous: the local ref IS
  // written (asserted via rev-parse) AND origin is proven empty (ls-remote).
  it("LAUNCH-TIME REAPER (sync OFF): WIP captured to a LOCAL ref, NOTHING pushed to origin (ADR 0021 inertness)", async () => {
    await withSyncEnv(undefined, async () => {
      const hostA = makeHost("hostReaperOff");
      const marker = "PARTIAL-WORK-MARKER-issue7-reaper-syncoff";
      makeInflightWorktree(hostA, 7, marker);
      // A lock ref only EXISTS here as a fixture — in real lease-OFF operation the
      // loop never creates one. DEFECT 5: with the lease disabled the reaper has
      // no business touching leases, so this ref must be LEFT ALONE.
      pushLock(hostA, 7);
      expect(lsRemote(hostA, "refs/locks/issue-7")).not.toBe("");
      expect(lsRemote(hostA, "refs/sandcastle/wip/issue-7")).toBe("");

      // Drive the REAL startup-reaper dep (production wiring under test).
      const results = await buildDefaultDeps(reaperArgs(hostA)).checkpointInflight();

      const r7 = results.find((r) => r.issue === 7) as CheckpointStopResult;
      expect(r7.outcome).toBe("checkpointed");
      expect(r7.wipRef).toBe("refs/sandcastle/wip/issue-7");

      // The WIP ref exists LOCALLY, carrying the exact partial work — a same-host
      // resume can find it (the surviving worktree carries it too).
      const localWip = git(hostA, "rev-parse", "refs/sandcastle/wip/issue-7");
      expect(localWip).not.toBe("");
      expect(git(hostA, "show", `${localWip}:PARTIAL_WORK.txt`)).toBe(marker);
      // ... but ORIGIN has NO such ref — the flag-off consumer pushed nothing new.
      expect(lsRemote(hostA, "refs/sandcastle/wip/issue-7")).toBe("");
      // ... and the (fixture) lock is UNTOUCHED — lease-off skips the delete.
      expect(lsRemote(hostA, "refs/locks/issue-7")).not.toBe("");
    });
  }, 30_000);

  // CONTROL / cross-host recovery: with sync ON the reaper DOES push the WIP ref
  // to origin, so a fresh clone (a peer) can resume the crashed work. This is the
  // case the origin push actually serves — and it proves the sync-OFF assertion
  // above is a real gate, not a reaper that simply never pushes.
  it("LAUNCH-TIME REAPER (sync ON): WIP pushed to origin, and a fresh clone resumes from it", async () => {
    await withSyncEnv("1", async () => {
      const hostA = makeHost("hostReaperOn");
      const marker = "PARTIAL-WORK-MARKER-issue7-reaper-syncon";
      makeInflightWorktree(hostA, 7, marker);
      expect(lsRemote(hostA, "refs/sandcastle/wip/issue-7")).toBe("");

      const results = await buildDefaultDeps(reaperArgs(hostA)).checkpointInflight();
      const r7 = results.find((r) => r.issue === 7) as CheckpointStopResult;
      expect(r7.outcome).toBe("checkpointed");

      // WIP is on ORIGIN carrying the exact partial work ...
      const wipSha = lsRemote(hostA, "refs/sandcastle/wip/issue-7");
      expect(wipSha).not.toBe("");
      expect(git(remote, "show", `${wipSha}:PARTIAL_WORK.txt`)).toBe(marker);

      // RESUME: a fresh clone materializes a worktree AT the checkpoint, not fresh.
      const hostB = makeHost("hostReaperOnB");
      const handle = await macHostSandbox({
        repoRoot: hostB,
        crossHostSync: true,
      }).createSandbox({ branch: "agent/issue-7" });
      const wtMarker = path.join(handle.worktreePath, "PARTIAL_WORK.txt");
      expect(existsSync(wtMarker)).toBe(true);
      expect(readFileSync(wtMarker, "utf8")).toBe(marker);
      expect(git(handle.worktreePath, "rev-parse", "HEAD")).toBe(wipSha);
      await handle.close();
    });
  }, 30_000);

  it("CONTROL: a clean launch (no agent worktree) → checkpointInflight is a no-op, nothing on origin", async () => {
    const host = makeHost("hostReaperClean");
    const results = await buildDefaultDeps(reaperArgs(host)).checkpointInflight();
    // Empty discovery ⇒ no per-issue results, no WIP ref, no lease touched.
    expect(results).toEqual<CheckpointStopResult[]>([]);
    expect(lsRemote(host, "refs/sandcastle/wip/issue-7")).toBe("");
  });

  // -------------------------------------------------------------------------
  // DEFECT 1 (HIGH) — the launch-time reaper must NOT delete a lease a PEER
  // holds LIVE. A crashed host's lease can expire and be re-claimed by a peer
  // before the crashed host restarts; the reaper deleting it here would strand
  // the peer's active work. Drives the PRODUCTION `checkpointInflight` wiring
  // (guard = leaseEnabled && leaseState !== "live") against a GENUINE peer-held
  // live lease on the shared origin. Non-vacuous: the reaper still runs and
  // pushes the WIP ref (work rescued) — only the lease delete is skipped.
  // -------------------------------------------------------------------------
  it("LAUNCH-TIME REAPER: with the lease ON and a peer holding it LIVE, WIP is pushed but the lease is NOT deleted", async () => {
    const prev = process.env.SANDCASTLE_CROSS_HOST_LEASE;
    const prevSync = process.env.SANDCASTLE_CROSS_HOST_SYNC;
    process.env.SANDCASTLE_CROSS_HOST_LEASE = "1";
    // A peer-held live lease is inherently a cross-host scenario, so sync is on —
    // the reaper therefore pushes the rescued WIP to origin (the sync-ON path).
    process.env.SANDCASTLE_CROSS_HOST_SYNC = "1";
    try {
      const peer = makeHost("hostPeerLease");
      // A real, LIVE lease on origin (proper lease blob, default TTL) — the
      // "another host is working issue 7" a crashed host would wake up into.
      const acquired = await buildDefaultDeps(reaperArgs(peer)).acquireIssueLease(7);
      expect(acquired).toBe(true);

      const hostA = makeHost("hostCrashedA");
      const marker = "PARTIAL-WORK-MARKER-issue7-peer-live-lease";
      makeInflightWorktree(hostA, 7, marker);
      // Precondition: the peer's lease is visible on origin, no WIP yet.
      expect(lsRemote(hostA, "refs/locks/issue-7")).not.toBe("");
      expect(lsRemote(hostA, "refs/sandcastle/wip/issue-7")).toBe("");

      const results = await buildDefaultDeps(reaperArgs(hostA)).checkpointInflight();

      // Work was RESCUED: the WIP ref now carries the exact partial work ...
      const r7 = results.find((r) => r.issue === 7) as CheckpointStopResult;
      expect(r7.outcome).toBe("checkpointed");
      const wipSha = lsRemote(hostA, "refs/sandcastle/wip/issue-7");
      expect(wipSha).not.toBe("");
      expect(git(remote, "show", `${wipSha}:PARTIAL_WORK.txt`)).toBe(marker);
      // ... but the peer's LIVE lease was LEFT INTACT — not yanked.
      expect(lsRemote(hostA, "refs/locks/issue-7")).not.toBe("");
    } finally {
      if (prev === undefined) delete process.env.SANDCASTLE_CROSS_HOST_LEASE;
      else process.env.SANDCASTLE_CROSS_HOST_LEASE = prev;
      if (prevSync === undefined) delete process.env.SANDCASTLE_CROSS_HOST_SYNC;
      else process.env.SANDCASTLE_CROSS_HOST_SYNC = prevSync;
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // DEFECT 2 (HIGH) — the launch-time reaper must be INERT under --dry-run:
  // no commit, no WIP push, no lease delete — mirroring every sibling dep
  // (release / publishStatus). Even with a dirty in-flight worktree AND a lease
  // present, a dry run touches ORIGIN not at all and returns [].
  // -------------------------------------------------------------------------
  it("DRY-RUN: checkpointInflight is a no-op — returns [] and writes nothing to origin", async () => {
    const host = makeHost("hostDry");
    makeInflightWorktree(host, 7, "PARTIAL-WORK-MARKER-issue7-dryrun");
    pushLock(host, 7);
    const lockBefore = lsRemote(host, "refs/locks/issue-7");
    expect(lockBefore).not.toBe("");

    const results = await buildDefaultDeps({
      ...reaperArgs(host),
      dryRun: true,
    }).checkpointInflight();

    // Returns [] — nothing reaped ...
    expect(results).toEqual<CheckpointStopResult[]>([]);
    // ... no WIP ref created ...
    expect(lsRemote(host, "refs/sandcastle/wip/issue-7")).toBe("");
    // ... and the lease is untouched (byte-for-byte the pre-run ref).
    expect(lsRemote(host, "refs/locks/issue-7")).toBe(lockBefore);
  });

  // -------------------------------------------------------------------------
  // TEST 2 — RESUME side (mac-host): createSandbox materializes the checkpoint.
  // -------------------------------------------------------------------------
  it("mac-host createSandbox with crossHostSync RESUMES from the WIP checkpoint", async () => {
    const host = makeHost("hostB");
    const marker = "PARTIAL-WORK-MARKER-issue7-def456-resume";

    // Build a real WIP checkpoint on origin: commit the distinctive marker on an
    // issue branch and push HEAD to refs/sandcastle/wip/issue-7.
    const seedWt = path.join(host, worktreePathFor("agent/issue-7"));
    git(host, "worktree", "add", "-b", "agent/issue-7", seedWt, "origin/main");
    writeFileSync(path.join(seedWt, "PARTIAL_WORK.txt"), marker);
    git(seedWt, "add", "-A");
    git(seedWt, "commit", "-m", "wip: checkpoint issue 7");
    const wipSha = git(seedWt, "rev-parse", "HEAD");
    git(seedWt, "push", "origin", "HEAD:refs/sandcastle/wip/issue-7");
    // Tear the seed worktree down so createSandbox starts from a clean slate.
    git(host, "worktree", "remove", "--force", seedWt);

    const handle = await macHostSandbox({
      repoRoot: host,
      crossHostSync: true,
    }).createSandbox({ branch: "agent/issue-7" });

    // The worktree working tree CONTAINS the distinctive partial work ...
    const wtMarker = path.join(handle.worktreePath, "PARTIAL_WORK.txt");
    expect(existsSync(wtMarker)).toBe(true);
    expect(readFileSync(wtMarker, "utf8")).toBe(marker);
    // ... and its HEAD IS the WIP commit — it resumed, it did not start fresh.
    expect(git(handle.worktreePath, "rev-parse", "HEAD")).toBe(wipSha);

    await handle.close();
  });

  // NON-VACUITY CONTROL for TEST 2: the SAME origin (WIP ref present) but sync
  // OFF must produce a FRESH worktree at origin/main WITHOUT the partial work,
  // proving the resume assertion above can't pass vacuously.
  it("CONTROL: crossHostSync off starts FRESH — no partial work, HEAD at integration tip", async () => {
    const host = makeHost("hostB");
    const marker = "PARTIAL-WORK-MARKER-issue7-ghi789-control";
    const mainSha = git(host, "rev-parse", "origin/main");

    // Put the WIP checkpoint on origin just like the resume test does.
    const seedWt = path.join(host, worktreePathFor("agent/issue-7"));
    git(host, "worktree", "add", "-b", "agent/issue-7", seedWt, "origin/main");
    writeFileSync(path.join(seedWt, "PARTIAL_WORK.txt"), marker);
    git(seedWt, "add", "-A");
    git(seedWt, "commit", "-m", "wip: checkpoint issue 7");
    git(seedWt, "push", "origin", "HEAD:refs/sandcastle/wip/issue-7");
    git(host, "worktree", "remove", "--force", seedWt);

    const handle = await macHostSandbox({
      repoRoot: host,
      crossHostSync: false, // <-- feature DISABLED
    }).createSandbox({ branch: "agent/issue-7" });

    // Fresh: the partial work is ABSENT ...
    expect(existsSync(path.join(handle.worktreePath, "PARTIAL_WORK.txt"))).toBe(
      false,
    );
    // ... and HEAD is the integration tip, NOT the WIP commit.
    expect(git(handle.worktreePath, "rev-parse", "HEAD")).toBe(mainSha);

    await handle.close();
  });

  // -------------------------------------------------------------------------
  // TEST 3 — FULL HANDOFF across two hosts: A checkpoints, B resumes A's work.
  // -------------------------------------------------------------------------
  it("host A checkpointStop → host B resolveReuseDecision + createSandbox picks up A's partial work", async () => {
    const hostA = makeHost("hostA");
    const hostB = makeHost("hostB");
    const marker = "PARTIAL-WORK-MARKER-issue7-jkl012-handoff";

    // --- Host A: in-flight dirty worktree + held lease, then checkpoint. ---
    makeInflightWorktree(hostA, 7, marker);
    pushLock(hostA, 7);

    const aResults = await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: hostA,
      hostId: "host-A",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });
    expect(aResults.find((r) => r.issue === 7)?.outcome).toBe("checkpointed");

    // A released the lease so B is ALLOWED to reclaim.
    expect(lsRemote(hostB, "refs/locks/issue-7")).toBe("");
    const wipSha = lsRemote(hostB, "refs/sandcastle/wip/issue-7");
    expect(wipSha).not.toBe("");

    // --- Host B: the shared reuse decision says "reuse issue 7". ---
    const decision = await resolveReuseDecision({
      syncEnabled: true,
      branch: "agent/issue-7",
      repoRoot: hostB,
      git: makeSyncGitRunner(),
    });
    expect(decision).toEqual({ reuse: true, issue: 7 });

    // --- Host B: mac-host materializes a worktree carrying A's partial work. ---
    const handle = await macHostSandbox({
      repoRoot: hostB,
      crossHostSync: true,
    }).createSandbox({ branch: "agent/issue-7" });

    const wtMarker = path.join(handle.worktreePath, "PARTIAL_WORK.txt");
    expect(existsSync(wtMarker)).toBe(true);
    expect(readFileSync(wtMarker, "utf8")).toBe(marker);
    // B's worktree HEAD is exactly the checkpoint A pushed — true continuity.
    expect(git(handle.worktreePath, "rev-parse", "HEAD")).toBe(wipSha);

    await handle.close();
  });

  // -------------------------------------------------------------------------
  // TEST 3b — the FULL cross-host CYCLE: A checkpoints → B resumes → B works →
  // B RE-checkpoints. TEST 3 stops one step short (B resumes but never pushes
  // its own checkpoint back), which is exactly where the data loss lived: B's
  // local WIP mirror was never written by the resume fetch, so `pushWipRef`
  // leased against "" ("must not exist") while origin DID hold A's snapshot —
  // `(stale info)` rejection, forever, and B's work never left the machine.
  //
  // Asserted on the REAL bare origin (`ls-remote` + `git show` INSIDE the bare
  // repo): WHEN the work landed, not IF a push was attempted.
  // -------------------------------------------------------------------------
  it("host B's RE-checkpoint of resumed work LANDS on origin (2nd stop is not lost)", async () => {
    const hostA = makeHost("hostA");
    const hostB = makeHost("hostB");
    const markerA = "PARTIAL-WORK-MARKER-issue7-aaa111-cycleA";
    const markerB = "PARTIAL-WORK-MARKER-issue7-bbb222-cycleB";

    // --- Host A: in-flight work → checkpoint → lease released. ---
    makeInflightWorktree(hostA, 7, markerA);
    pushLock(hostA, 7);
    const aResults = await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: hostA,
      hostId: "host-A",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });
    expect(aResults.find((r) => r.issue === 7)?.outcome).toBe("checkpointed");
    const wipAfterA = lsRemote(hostB, "refs/sandcastle/wip/issue-7");
    expect(wipAfterA).not.toBe("");

    // --- Host B: reclaim the lease and RESUME A's checkpoint (production path).
    pushLock(hostB, 7);
    const handle = await macHostSandbox({
      repoRoot: hostB,
      crossHostSync: true,
    }).createSandbox({ branch: "agent/issue-7" });
    expect(git(handle.worktreePath, "rev-parse", "HEAD")).toBe(wipAfterA);

    // --- Host B: build on A's work, leaving it uncommitted as a real stop would.
    writeFileSync(path.join(handle.worktreePath, "B_WORK.txt"), markerB);

    // --- Host B: the SECOND `--now` stop checkpoints the resumed work. ---
    const bResults = await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: hostB,
      hostId: "host-B",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });
    const r7 = bResults.find((r) => r.issue === 7) as CheckpointStopResult;
    expect(r7.outcome).toBe("checkpointed");

    // ORIGIN MOVED off A's snapshot onto B's ...
    const wipAfterB = lsRemote(hostB, "refs/sandcastle/wip/issue-7");
    expect(wipAfterB).not.toBe(wipAfterA);
    // ... and BOTH hosts' work is retrievable straight from the bare origin —
    // B built on A rather than replacing it.
    expect(git(remote, "show", `${wipAfterB}:B_WORK.txt`)).toBe(markerB);
    expect(git(remote, "show", `${wipAfterB}:PARTIAL_WORK.txt`)).toBe(markerA);

    // ... and B released the lease, so a third host may reclaim issue 7.
    expect(lsRemote(hostB, "refs/locks/issue-7")).toBe("");
    // Two real clones + a full checkpoint/resume/re-checkpoint cycle of real git
    // outruns the 5s default when the suite runs in parallel.
  }, 30_000);

  // SAFETY TWIN for TEST 3b — the resume-time mirror fetch must NOT degrade the
  // lease into a blind force. B resumes (mirror = A's snapshot), then a THIRD
  // host C checkpoints on top. B's now-STALE push must be REFUSED and C's work
  // must survive on origin untouched.
  it("SAFETY: after a peer moves the WIP ref, a stale host's checkpoint is REFUSED", async () => {
    const hostA = makeHost("hostA");
    const hostB = makeHost("hostB");
    const hostC = makeHost("hostC");

    // --- Host A: checkpoint issue 7. ---
    makeInflightWorktree(hostA, 7, "MARKER-A-safety");
    pushLock(hostA, 7);
    await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: hostA,
      hostId: "host-A",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    // --- Host B: resume A's checkpoint and commit on top (NOT yet pushed). ---
    const handleB = await macHostSandbox({
      repoRoot: hostB,
      crossHostSync: true,
    }).createSandbox({ branch: "agent/issue-7" });
    writeFileSync(path.join(handleB.worktreePath, "B_WORK.txt"), "B work\n");
    git(handleB.worktreePath, "add", "-A");
    git(handleB.worktreePath, "commit", "-m", "B work");

    // --- Host C: resumes the SAME checkpoint and lands its own first. ---
    const handleC = await macHostSandbox({
      repoRoot: hostC,
      crossHostSync: true,
    }).createSandbox({ branch: "agent/issue-7" });
    writeFileSync(path.join(handleC.worktreePath, "C_WORK.txt"), "C work\n");
    const cResults = await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: hostC,
      hostId: "host-C",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });
    expect(cResults.find((r) => r.issue === 7)?.outcome).toBe("checkpointed");
    const wipAfterC = lsRemote(hostC, "refs/sandcastle/wip/issue-7");

    // --- Host B now pushes against a mirror that origin has moved past. ---
    const bResults = await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: hostB,
      hostId: "host-B",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });
    // REFUSED — not silently accepted (the lease did its job) ...
    expect(bResults.find((r) => r.issue === 7)?.outcome).toBe("error");
    // ... and C's work is EXACTLY what origin still holds, byte-for-byte.
    expect(lsRemote(hostB, "refs/sandcastle/wip/issue-7")).toBe(wipAfterC);
    expect(git(remote, "show", `${wipAfterC}:C_WORK.txt`)).toBe("C work");
    // ... and B's rejected work is ABSENT from origin — the refusal was real.
    expect(() => git(remote, "show", `${wipAfterC}:B_WORK.txt`)).toThrow();
    // THREE real clones of real git — well past the 5s default under suite load.
  }, 30_000);

  // -------------------------------------------------------------------------
  // TEST 4 (Workstream 1, 1c) — a --now stop preserves a certified-but-
  // unpromoted staging tip: post-merge fixer commits on `integration-candidate`
  // that no worktree owns are backed up to the durable strand ref on origin.
  // -------------------------------------------------------------------------
  it("checkpointStop backs up an integration-candidate tip that is ahead of the integration branch", async () => {
    const host = makeHost("hostS");
    const SYNC_ON = true;

    // A certified fixer commit landed on integration-candidate but was never
    // promoted — the branch is 1 ahead of the integration branch (main).
    git(host, "checkout", "-B", "integration-candidate", "origin/main");
    writeFileSync(path.join(host, "fixer.txt"), "post-merge fixer commit\n");
    git(host, "add", "fixer.txt");
    git(host, "commit", "-m", "post-merge fixer");
    const stagingTip = git(host, "rev-parse", "integration-candidate");
    // leave the branch as a pure ref (mirrors the real staging worktree layout)
    git(host, "checkout", "main");

    // No in-flight issue worktrees — this is a pure staging strand.
    const results = await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: host,
      hostId: "host-S",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: "integration-candidate",
      syncEnabled: SYNC_ON,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });
    expect(results).toEqual<CheckpointStopResult[]>([]);

    // The stranded staging tip is preserved on origin at the strand ref, so a
    // peer/human can recover the post-merge fixer commit after the stop.
    expect(lsRemote(host, "refs/sandcastle/strand/integration-candidate")).toBe(
      stagingTip,
    );
    // …and it is NOT lost even though no worktree carried it.
    const peer = makeHost("hostT");
    git(peer, "fetch", "origin", "refs/sandcastle/strand/integration-candidate:refs/local/strand");
    expect(git(peer, "show", "refs/local/strand:fixer.txt")).toContain(
      "post-merge fixer commit",
    );
  });

  // Control: staging NOT ahead of integration → no strand ref written.
  it("checkpointStop writes NO strand ref when integration-candidate is level with the integration branch", async () => {
    const host = makeHost("hostU");
    git(host, "branch", "integration-candidate", "origin/main");

    await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: host,
      hostId: "host-U",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: "integration-candidate",
      syncEnabled: true,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    expect(lsRemote(host, "refs/sandcastle/strand/integration-candidate")).toBe("");
  });

  // -------------------------------------------------------------------------
  // TEST 6 (review fix #1) — ADR 0021's inertness contract: the staging/strand
  // backup is an ORIGIN WRITE, so it must be gated behind the cross-host opt-in.
  // A single-host `--now` stop with the flag OFF must push NOTHING new to origin
  // even when there IS a stranded staging tip worth saving locally.
  //
  // Asserted on the REAL bare origin (WHEN, not IF) and paired with the flag-ON
  // twin below, so neither assertion can pass vacuously.
  // -------------------------------------------------------------------------

  /**
   * Strand a certified-but-unpromoted fixer commit on `integration-candidate`
   * (1 ahead of main) exactly as TEST 4 does. Returns the staging tip SHA.
   */
  function strandStagingTip(host: string): string {
    git(host, "checkout", "-B", "integration-candidate", "origin/main");
    writeFileSync(path.join(host, "fixer.txt"), "post-merge fixer commit\n");
    git(host, "add", "fixer.txt");
    git(host, "commit", "-m", "post-merge fixer");
    const tip = git(host, "rev-parse", "integration-candidate");
    git(host, "checkout", "main");
    return tip;
  }

  it("checkpointStop with sync OFF writes NO strand ref to origin (ADR 0021 inertness)", async () => {
    const host = makeHost("hostV");
    const stagingTip = strandStagingTip(host);

    await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: host,
      hostId: "host-V",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: "integration-candidate",
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    // Nothing new on ORIGIN — the flag-off consumer's push surface is unchanged.
    expect(lsRemote(host, "refs/sandcastle/strand/integration-candidate")).toBe("");
    // …but the work is NOT lost: the LOCAL strand ref still pins the exact tip,
    // which is what makes this a gating assertion rather than a "did nothing" one.
    expect(git(host, "rev-parse", "refs/sandcastle/strand/integration-candidate")).toBe(
      stagingTip,
    );
  });

  it("checkpointStop with sync ON writes the strand ref to origin", async () => {
    const host = makeHost("hostW");
    const stagingTip = strandStagingTip(host);

    await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: host,
      hostId: "host-W",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: "integration-candidate",
      syncEnabled: true,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    expect(lsRemote(host, "refs/sandcastle/strand/integration-candidate")).toBe(
      stagingTip,
    );
  });

  // Control for fix #2: `stagingBranch: null` is the explicit "skip it" intent —
  // no staging backup at all, even with a stranded tip and sync ON.
  it("checkpointStop with stagingBranch null skips the staging backup entirely", async () => {
    const host = makeHost("hostX");
    strandStagingTip(host);

    await checkpointStop(makeExecFileGitRunner(), {
      repoRoot: host,
      hostId: "host-X",
      integrationBranch: "main",
      remote: "origin",
      stagingBranch: null,
      syncEnabled: true,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    expect(lsRemote(host, "refs/sandcastle/strand/integration-candidate")).toBe("");
  });
});
