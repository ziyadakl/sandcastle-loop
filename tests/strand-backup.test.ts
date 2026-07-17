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
 *
 * `handleStrandedPromotion` (the 1a policy the loop calls on an FF-refusal) is
 * covered twice over: unit tests against an injected GitRunner + fake deps pin
 * the ORDERING and error-containment contracts, and a real-git test proves the
 * strand ref actually EXISTS ON ORIGIN afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  backupStrand,
  handleStrandedPromotion,
  stagingCommitsAhead,
  strandRef,
  STAGING_BRANCH,
} from "../.sandcastle/lib/state/strand-backup.js";
import type { StrandedPromotionDeps } from "../.sandcastle/lib/state/strand-backup.js";
import { wipRef } from "../.sandcastle/lib/state/branch-checkpoint.js";
import { makeExecFileGitRunner } from "../.sandcastle/lib/state/index.js";
import type { GitRunner } from "../.sandcastle/lib/state/issue-lease.js";

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
  // The staging branch name is owned by lib/state so lib code stops hardcoding
  // the literal (main.mts imports it from here).
  // -------------------------------------------------------------------------
  it("exports the canonical staging branch name", () => {
    expect(STAGING_BRANCH).toBe("integration-candidate");
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
  // ADR 0021 §1 — "never a blind force". The strand push must be
  // force-with-lease, and it must still work for the re-strand case.
  // -------------------------------------------------------------------------
  it("re-strands the same branch: a later backup ADVANCES the origin strand ref", async () => {
    // Regression lock: a naive `--force` → bare `--force-with-lease` swap makes
    // THIS push fail. `refs/sandcastle/*` has no remote-tracking ref, so a bare
    // lease has nothing to compare against once the ref exists on origin. The
    // shipped code passes an explicit expected value instead.
    const host = makeHost("hostA");
    const tip1 = seedStagingAhead(host, 1, "RESTRAND-1");
    const first = await backupStrand(gitRunner, {
      repoRoot: host,
      branch: STAGING,
      issues: [7],
      syncEnabled: true,
    });
    expect(first.errors).toEqual([]);
    expect(lsRemote(host, strandRef(STAGING))).toBe(tip1);

    // Staging advances (another fixer commit lands), then we strand again.
    git(host, "checkout", STAGING);
    writeFileSync(path.join(host, "fixer-later.txt"), "RESTRAND-2\n");
    git(host, "add", "fixer-later.txt");
    git(host, "commit", "-m", "later fixer");
    git(host, "checkout", "main");
    const tip2 = git(host, "rev-parse", STAGING);
    expect(tip2).not.toBe(tip1);

    const second = await backupStrand(gitRunner, {
      repoRoot: host,
      branch: STAGING,
      issues: [7],
      syncEnabled: true,
    });

    expect(second.errors).toEqual([]);
    expect(second.pushedRefs).toContain(strandRef(STAGING));
    expect(lsRemote(host, strandRef(STAGING))).toBe(tip2);
    expect(lsRemote(host, wipRef(7))).toBe(tip2);
  });

  it("REFUSES to clobber a peer's strand ref rather than blindly forcing over it", async () => {
    // ADR 0021 §1: never a blind force. This path fires on FF-refusal, right as
    // the lease is released — so the single-writer premise does NOT hold and a
    // peer may already have stranded this branch. A blind `--force` silently
    // DESTROYS that peer's stranded work; the lease must refuse instead.
    const peer = makeHost("hostB");
    const peerTip = seedStagingAhead(peer, 2, "PEER-STRAND");
    git(peer, "push", "origin", `${peerTip}:${strandRef(STAGING)}`);
    expect(lsRemote(peer, strandRef(STAGING))).toBe(peerTip);

    // Host A has never seen that ref (no local strand ref) and strands its own
    // divergent tip.
    const host = makeHost("hostA");
    const ourTip = seedStagingAhead(host, 1, "OUR-STRAND");
    expect(ourTip).not.toBe(peerTip);

    const res = await backupStrand(gitRunner, {
      repoRoot: host,
      branch: STAGING,
      issues: [7],
      syncEnabled: true,
    });

    // The peer's stranded work is STILL on origin — not clobbered.
    expect(lsRemote(host, strandRef(STAGING))).toBe(peerTip);
    expect(res.pushedRefs).not.toContain(strandRef(STAGING));
    // The refusal is reported, never thrown…
    expect(res.errors.join(" ")).toMatch(/strand/);
    // …and our own work is still pinned LOCALLY, so nothing is lost here either.
    expect(git(host, "rev-parse", strandRef(STAGING))).toBe(ourTip);
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

  // -------------------------------------------------------------------------
  // 1a POLICY — handleStrandedPromotion, the orchestration the loop calls on an
  // FF-refusal. REAL git: proves the strand ref reaches ORIGIN (WHEN, not IF).
  // -------------------------------------------------------------------------
  it("puts the stranded tip ON ORIGIN and releases every lease (sync ON)", async () => {
    const host = makeHost("hostA");
    const tip = seedStagingAhead(host, 2, "E2E-STRAND");
    const { deps, calls } = makeFakeDeps();

    await handleStrandedPromotion(gitRunner, deps, {
      repoRoot: host,
      stagingBranch: STAGING,
      integrationBranch: "main",
      issues: [7, 8],
      syncEnabled: true,
    });

    // THE point of this PR: the certified work is recoverable from origin.
    expect(lsRemote(host, strandRef(STAGING))).toBe(tip);
    expect(lsRemote(host, wipRef(7))).toBe(tip);
    expect(lsRemote(host, wipRef(8))).toBe(tip);

    // A peer can actually recover the stranded commits.
    const peer = makeHost("hostB");
    git(peer, "fetch", "origin", `${strandRef(STAGING)}:refs/local/strand`);
    expect(git(peer, "show", "refs/local/strand:fixer-1.txt")).toContain("E2E-STRAND");

    // Every issue was surfaced to a human and its lease released.
    expect(calls.released).toEqual([7, 8]);
    expect(calls.quarantined).toEqual([7, 8]);
    expect(calls.phases).toEqual([
      [7, "needs-human"],
      [8, "needs-human"],
    ]);
    expect(calls.published).toEqual([STAGING]);
  });
});

/** Recorder for the injected {@link StrandedPromotionDeps}. */
interface DepCalls {
  released: number[];
  quarantined: number[];
  phases: [number, string][];
  published: string[];
  logs: string[];
  errors: string[];
  /** Every dep call in order, for ordering assertions. */
  order: string[];
}

function makeFakeDeps(
  overrides: Partial<StrandedPromotionDeps> = {},
): { deps: StrandedPromotionDeps; calls: DepCalls } {
  const calls: DepCalls = {
    released: [],
    quarantined: [],
    phases: [],
    published: [],
    logs: [],
    errors: [],
    order: [],
  };
  const deps: StrandedPromotionDeps = {
    log: (m) => {
      calls.logs.push(m);
    },
    logError: (m) => {
      calls.errors.push(m);
    },
    setIssuePhase: (n, phase, detail) => {
      calls.phases.push([n, phase]);
      calls.order.push(`phase:${n}:${detail ? "detailed" : "bare"}`);
    },
    quarantine: async (n) => {
      calls.quarantined.push(n);
      calls.order.push(`quarantine:${n}`);
    },
    releaseIssueLease: async (n) => {
      calls.released.push(n);
      calls.order.push(`release:${n}`);
    },
    publishLane: async (branch) => {
      calls.published.push(branch);
      calls.order.push(`publish:${branch}`);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("handleStrandedPromotion (injected GitRunner + fake deps)", () => {
  /**
   * A GitRunner that records every invocation and answers the two reads the
   * policy makes (`rev-parse` of the staging tip, `ls-remote` for the lease's
   * expected value). Everything else succeeds silently.
   */
  function makeRecordingGit(
    opts: { tip?: string; fail?: (args: string[]) => boolean } = {},
  ): { git: GitRunner; args: string[][] } {
    const tip = opts.tip ?? "a".repeat(40);
    const args: string[][] = [];
    const git: GitRunner = async (_cwd, ...rest) => {
      args.push([...rest]);
      if (opts.fail?.(rest)) {
        return { ok: false, stdout: "", stderr: "boom", code: 1 };
      }
      if (rest[0] === "rev-parse") return { ok: true, stdout: `${tip}\n`, stderr: "", code: 0 };
      // No ref on origin / no local ref yet.
      if (rest[0] === "ls-remote") return { ok: true, stdout: "", stderr: "", code: 0 };
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    return { git, args };
  }

  const baseOpts = {
    repoRoot: "/repo",
    stagingBranch: STAGING,
    integrationBranch: "main",
    issues: [7],
    syncEnabled: false,
  };

  it("backs the strand up BEFORE releasing any lease", async () => {
    // The whole point of 1a: once the lease is gone a peer may reclaim the
    // issue, so the work must already be pinned. Ordering is the contract.
    const order: string[] = [];
    const git: GitRunner = async (_cwd, ...rest) => {
      if (rest[0] === "update-ref") order.push("backup");
      if (rest[0] === "rev-parse") return { ok: true, stdout: `${"a".repeat(40)}\n`, stderr: "", code: 0 };
      return { ok: true, stdout: "", stderr: "", code: 0 };
    };
    const { deps } = makeFakeDeps({
      releaseIssueLease: async () => {
        order.push("release");
      },
    });

    await handleStrandedPromotion(git, deps, baseOpts);

    expect(order[0]).toBe("backup");
    expect(order).toContain("release");
    expect(order.indexOf("backup")).toBeLessThan(order.indexOf("release"));
  });

  it("still releases the lease when quarantine THROWS", async () => {
    // ADR 0019 Fix-4: a GitHub API fault must never strand the lease itself.
    const { git } = makeRecordingGit();
    const { deps, calls } = makeFakeDeps({
      quarantine: async () => {
        throw new Error("gh api 503");
      },
    });

    await expect(
      handleStrandedPromotion(git, deps, { ...baseOpts, issues: [7, 8] }),
    ).resolves.toBeUndefined();

    expect(calls.released).toEqual([7, 8]);
    expect(calls.errors.join(" ")).toContain("gh api 503");
  });

  it("never throws when the backup itself fails, and still releases the lease", async () => {
    // Backup failures are non-fatal: the strand is still on disk and the run
    // already exits unhealthy for a human.
    const { git } = makeRecordingGit({ fail: (a) => a[0] === "rev-parse" });
    const { deps, calls } = makeFakeDeps();

    await expect(handleStrandedPromotion(git, deps, baseOpts)).resolves.toBeUndefined();

    expect(calls.released).toEqual([7]);
  });

  it("sync OFF: writes local refs and pushes NOTHING to origin", async () => {
    const { git, args } = makeRecordingGit();
    const { deps, calls } = makeFakeDeps();

    await handleStrandedPromotion(git, deps, { ...baseOpts, syncEnabled: false });

    expect(args.some((a) => a[0] === "update-ref")).toBe(true);
    expect(args.some((a) => a[0] === "push")).toBe(false);
    // The lane publish is part of the sync lane too — inert with the flag off.
    expect(calls.published).toEqual([]);
  });

  it("sync ON: pushes the strand to origin and publishes the lane", async () => {
    const { git, args } = makeRecordingGit();
    const { deps, calls } = makeFakeDeps();

    await handleStrandedPromotion(git, deps, { ...baseOpts, syncEnabled: true });

    const pushes = args.filter((a) => a[0] === "push");
    expect(pushes.length).toBeGreaterThan(0);
    // ADR 0021 §1 — never a blind force.
    for (const p of pushes) {
      expect(p.some((x) => x.startsWith("--force-with-lease"))).toBe(true);
      expect(p).not.toContain("--force");
    }
    expect(calls.published).toEqual([STAGING]);
  });
});
