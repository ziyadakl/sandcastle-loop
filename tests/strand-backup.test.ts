/**
 * REAL-GIT unit tests for the strand-backup data-safety helpers (Workstream 1).
 *
 * Everything here drives the PRODUCTION functions in
 * `.sandcastle/lib/state/strand-backup.ts` against a REAL local bare origin with
 * real clones acting as separate hosts (offline, real git semantics — never the
 * real network). Assertions read refs off the bare ORIGIN (and a peer clone),
 * never mock calls, so a green assertion is evidence the shipped code path
 * actually persists work.
 *
 * The sync-ON / sync-OFF pairs make each "it reached origin" assertion provably
 * non-vacuous: the same drive with the flag OFF leaves origin untouched (local
 * ref only) — the "red before green" the regression locks.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  backupStrand,
  checkpointInflightWork,
  stagingCommitsAhead,
  strandRef,
} from "../.sandcastle/lib/state/strand-backup.js";
import { wipRef } from "../.sandcastle/lib/state/branch-checkpoint.js";
import { listInflightIssueWorktrees } from "../.sandcastle/lib/state/checkpoint-stop.js";
import { makeExecFileGitRunner } from "../.sandcastle/lib/state/index.js";
import { worktreePathFor } from "../.sandcastle/lib/worktree-path.js";

const STAGING = "integration-candidate";

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

describe("strand-backup (real bare origin + real clones)", () => {
  let tmp: string;
  let remote: string;
  const gitRunner = makeExecFileGitRunner();

  function makeHost(name: string): string {
    const repo = path.join(tmp, name);
    git(tmp, "clone", remote, repo);
    git(repo, "config", "user.email", `${name}@t.test`);
    git(repo, "config", "user.name", name);
    return repo;
  }

  /** Seed origin with a `main` integration branch carrying a base file. */
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
   * In `repo`, create an `integration-candidate` branch that is `ahead` commits
   * ahead of `main` (the certified-but-stranded staging tip). Returns the tip SHA.
   */
  function seedStagingAhead(repo: string, ahead: number, marker: string): string {
    git(repo, "checkout", "-B", STAGING, "origin/main");
    for (let i = 0; i < ahead; i++) {
      writeFileSync(path.join(repo, `fixer-${i}.txt`), `${marker}-${i}\n`);
      git(repo, "add", `fixer-${i}.txt`);
      git(repo, "commit", "-m", `fixer ${i}`);
    }
    // leave HEAD on main so the branch is a pure ref (mirrors the staging worktree)
    git(repo, "checkout", "main");
    return git(repo, "rev-parse", STAGING);
  }

  /**
   * Add an `agent/issue-<n>` worktree cut from origin/main with a distinctive
   * uncommitted marker file. Returns the worktree path.
   */
  function makeInflightWorktree(repo: string, n: number, marker: string): string {
    const branch = `agent/issue-${n}`;
    const wtPath = path.join(repo, worktreePathFor(branch));
    git(repo, "worktree", "add", "-b", branch, wtPath, "origin/main");
    writeFileSync(path.join(wtPath, "PARTIAL_WORK.txt"), marker);
    return wtPath;
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-strand-"));
    remote = path.join(tmp, "remote.git");
    git(tmp, "init", "--bare", remote);
    seedOrigin();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1a — backupStrand: local always, origin only when sync ON.
  // -------------------------------------------------------------------------
  it("writes a local strand ref at the staging tip and (sync OFF) does NOT push to origin", async () => {
    const host = makeHost("hostA");
    const tip = seedStagingAhead(host, 1, "STRAND-MARK-off");

    const res = await backupStrand(gitRunner, {
      repoRoot: host,
      branch: STAGING,
      issues: [7],
      syncEnabled: false,
    });

    // Local strand ref exists and points at the stranded tip.
    expect(git(host, "rev-parse", strandRef(STAGING))).toBe(tip);
    // Per-issue local WIP ref exists too.
    expect(git(host, "rev-parse", wipRef(7))).toBe(tip);
    // FLAG OFF: nothing pushed to origin.
    expect(lsRemote(host, strandRef(STAGING))).toBe("");
    expect(lsRemote(host, wipRef(7))).toBe("");
    expect(res.pushedRefs).toEqual([]);
    expect(res.localRefs).toContain(strandRef(STAGING));
    expect(res.localRefs).toContain(wipRef(7));
  });

  it("pushes the strand + per-issue WIP refs to origin when sync is ON, and a peer can fetch them", async () => {
    const host = makeHost("hostA");
    const tip = seedStagingAhead(host, 2, "STRAND-MARK-on");

    const res = await backupStrand(gitRunner, {
      repoRoot: host,
      branch: STAGING,
      issues: [7, 8],
      syncEnabled: true,
    });

    // Origin now carries the strand + per-issue WIP refs at the stranded tip.
    expect(lsRemote(host, strandRef(STAGING))).toBe(tip);
    expect(lsRemote(host, wipRef(7))).toBe(tip);
    expect(lsRemote(host, wipRef(8))).toBe(tip);
    expect(res.pushedRefs).toContain(strandRef(STAGING));
    expect(res.pushedRefs).toContain(wipRef(7));

    // A PEER host can pull the stranded work off origin (lane-sync style).
    const peer = makeHost("hostB");
    git(peer, "fetch", "origin", `${strandRef(STAGING)}:refs/local/strand`);
    expect(git(peer, "rev-parse", "refs/local/strand")).toBe(tip);
    // The fixer commits are present on the peer's fetched tip.
    expect(git(peer, "cat-file", "-t", tip)).toBe("commit");
  });

  // -------------------------------------------------------------------------
  // 1b — heartbeat checkpoint of in-flight worktrees (kill -9 survival).
  // -------------------------------------------------------------------------
  it("commits an in-flight worktree and (sync ON) pushes its WIP ref holding the partial work", async () => {
    const host = makeHost("hostA");
    const marker = "PARTIAL-issue9-heartbeat-abc";
    makeInflightWorktree(host, 9, marker);

    const worktrees = await listInflightIssueWorktrees(gitRunner, host);
    const results = await checkpointInflightWork(gitRunner, worktrees, {
      repoRoot: host,
      hostId: "hostA",
      syncEnabled: true,
    });

    expect(results.find((r) => r.issue === 9)?.outcome).toBe("checkpointed");
    // WIP ref exists on origin — simulate a hard crash: the on-disk worktree is
    // gone but the ref survives on origin holding the partial file.
    const wipSha = lsRemote(host, wipRef(9));
    expect(wipSha).not.toBe("");
    const peer = makeHost("hostB");
    git(peer, "fetch", "origin", `${wipRef(9)}:refs/local/wip9`);
    const blob = git(peer, "show", "refs/local/wip9:PARTIAL_WORK.txt");
    expect(blob).toContain(marker);
  });

  it("commits the in-flight worktree locally but (sync OFF) pushes NOTHING to origin", async () => {
    const host = makeHost("hostA");
    makeInflightWorktree(host, 9, "PARTIAL-off");

    const worktrees = await listInflightIssueWorktrees(gitRunner, host);
    const results = await checkpointInflightWork(gitRunner, worktrees, {
      repoRoot: host,
      hostId: "hostA",
      syncEnabled: false,
    });

    // Committed locally (branch advanced past a clean tree)…
    expect(results.find((r) => r.issue === 9)?.outcome).toBe("checkpointed");
    expect(git(path.join(host, worktreePathFor("agent/issue-9")), "status", "--porcelain")).toBe("");
    // …but FLAG OFF means no origin push.
    expect(lsRemote(host, wipRef(9))).toBe("");
  });

  it("reports 'clean' for an in-flight worktree with no changes and touches no ref", async () => {
    const host = makeHost("hostA");
    const branch = "agent/issue-11";
    const wtPath = path.join(host, worktreePathFor(branch));
    git(host, "worktree", "add", "-b", branch, wtPath, "origin/main");
    // no marker file → clean worktree

    const worktrees = await listInflightIssueWorktrees(gitRunner, host);
    const results = await checkpointInflightWork(gitRunner, worktrees, {
      repoRoot: host,
      hostId: "hostA",
      syncEnabled: true,
    });

    expect(results.find((r) => r.issue === 11)?.outcome).toBe("clean");
    expect(lsRemote(host, wipRef(11))).toBe("");
  });

  // -------------------------------------------------------------------------
  // stagingCommitsAhead — the 1c ahead gate.
  // -------------------------------------------------------------------------
  it("counts how many commits the staging branch is ahead of the integration branch", async () => {
    const host = makeHost("hostA");
    seedStagingAhead(host, 3, "AHEAD");
    const ahead = await stagingCommitsAhead(gitRunner, host, "main", STAGING);
    expect(ahead).toBe(3);
  });

  it("reports 0 ahead when staging equals the integration branch", async () => {
    const host = makeHost("hostA");
    git(host, "branch", STAGING, "origin/main");
    const ahead = await stagingCommitsAhead(gitRunner, host, "main", STAGING);
    expect(ahead).toBe(0);
  });
});
