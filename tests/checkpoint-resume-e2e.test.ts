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
    });

    const r9 = results.find((r) => r.issue === 9) as CheckpointStopResult;
    expect(r9.outcome).toBe("nothing-to-save");
    // No WIP ref was created ...
    expect(lsRemote(host, "refs/sandcastle/wip/issue-9")).toBe("");
    // ... and the lease is STILL held (clean worktree must not release it).
    expect(lsRemote(host, "refs/locks/issue-9")).not.toBe("");
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
    });

    expect(lsRemote(host, "refs/sandcastle/strand/integration-candidate")).toBe("");
  });
});
