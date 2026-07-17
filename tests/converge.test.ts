/**
 * Cross-host CONVERGENCE — real-git, two-host end-to-end (Workstream 3).
 *
 * `convergeLanes` is the operator command that brings every machine to one
 * point: it discovers every peer's hidden `refs/sandcastle/lanes/<host>` ref,
 * merges each onto the run branch inside the converger's checkout, writes a
 * durable conflict marker ref when a merge fails, then pushes the converged run
 * branch back to the remote.
 *
 * These tests drive the PRODUCTION function against a REAL local bare origin
 * with real clones acting as separate hosts (offline, real git semantics —
 * never the real network). Nothing re-implements the production git commands:
 * `convergeLanes(makeExecFileGitRunner(), …)` is called verbatim, so a green
 * assertion is evidence the shipped path works — not a tautology. Assertions
 * check the end STATE on origin (WHEN it converged), not merely IF the function
 * returned.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { convergeLanes, ConvergeError } from "../.sandcastle/lib/state/converge.js";
import { makeExecFileGitRunner } from "../.sandcastle/lib/state/index.js";
import type { GitRunner } from "../.sandcastle/lib/state/issue-lease.js";

const BRANCH = "main";

/** Run git synchronously for TEST SETUP/ASSERTIONS (not production code). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("convergeLanes (real bare origin + real host clones)", () => {
  let tmp: string;
  let remote: string;
  let converger: string; // neutral clone that runs the convergence

  /** Clone the bare origin into a fresh host directory with a git identity. */
  function makeHost(name: string): string {
    const repo = path.join(tmp, name);
    git(tmp, "clone", remote, repo);
    git(repo, "config", "user.email", `${name}@t.test`);
    git(repo, "config", "user.name", name);
    git(repo, "checkout", BRANCH);
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
    git(seed, "branch", "-M", BRANCH);
    git(seed, "push", "-u", "origin", BRANCH);
    rmSync(seed, { recursive: true, force: true });
  }

  /**
   * On `host`, add `file` with `content`, commit it, and publish the host's
   * lane ref (`refs/sandcastle/lanes/<hostId>`) at the new tip.
   */
  function commitAndPublishLane(
    host: string,
    hostId: string,
    file: string,
    content: string,
  ): void {
    writeFileSync(path.join(host, file), content);
    git(host, "add", "-A");
    git(host, "commit", "-m", `${hostId} work on ${file}`);
    git(host, "push", "--force", "origin", `${BRANCH}:refs/sandcastle/lanes/${hostId}`);
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-converge-"));
    remote = path.join(tmp, "remote.git");
    git(tmp, "init", "--bare", remote);
    seedOrigin();
    converger = makeHost("converger");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // (a) Two lanes with DIFFERENT issues on one base → both merged onto origin.
  // -------------------------------------------------------------------------
  it("merges every peer lane and the pushed run branch on origin contains BOTH issues' commits", async () => {
    const hostA = makeHost("host-A");
    const hostB = makeHost("host-B");
    commitAndPublishLane(hostA, "host-A", "issueA.txt", "issue A work\n");
    commitAndPublishLane(hostB, "host-B", "issueB.txt", "issue B work\n");

    const result = await convergeLanes(makeExecFileGitRunner(), {
      repoRoot: converger,
      branch: BRANCH,
      hostId: "converger",
      remote: "origin",
    });

    // Per-lane report = merged / merged for the two peers.
    expect(result.perLane).toHaveLength(2);
    expect([...result.perLane].sort((x, y) => x.host.localeCompare(y.host))).toEqual([
      { host: "host-A", result: "merged", tip: expect.any(String) },
      { host: "host-B", result: "merged", tip: expect.any(String) },
    ]);
    expect(result.conflicts).toEqual([]);

    // WHEN converged: a FRESH clone of origin's run branch carries BOTH files.
    const verify = path.join(tmp, "verify");
    git(tmp, "clone", "--branch", BRANCH, remote, verify);
    expect(existsSync(path.join(verify, "issueA.txt"))).toBe(true);
    expect(existsSync(path.join(verify, "issueB.txt"))).toBe(true);
    // branchTip matches origin's pushed tip.
    expect(result.branchTip).toBe(git(verify, "rev-parse", "HEAD"));
  });

  // -------------------------------------------------------------------------
  // (b) Two CONFLICTING lanes → durable conflict marker on origin, branch clean.
  // -------------------------------------------------------------------------
  it("writes a durable conflict marker ref on origin, reports it, and leaves the branch clean", async () => {
    const hostA = makeHost("host-A");
    const hostB = makeHost("host-B");
    // Both edit the SAME file differently from base → the second merge conflicts.
    commitAndPublishLane(hostA, "host-A", "base.txt", "A changed base\n");
    commitAndPublishLane(hostB, "host-B", "base.txt", "B changed base\n");

    const result = await convergeLanes(makeExecFileGitRunner(), {
      repoRoot: converger,
      branch: BRANCH,
      hostId: "converger",
      remote: "origin",
    });

    // One peer merged cleanly, one conflicted.
    const conflictLane = result.perLane.find((l) => l.result === "conflict");
    expect(conflictLane).toBeDefined();
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);

    // WHEN a conflict occurs: a durable marker ref is written on ORIGIN.
    const markerLs = git(converger, "ls-remote", "origin", "refs/sandcastle/conflict/*");
    expect(markerLs).toContain("refs/sandcastle/conflict/converger-");

    // The converger branch is left CLEAN — no half-merge, no MERGE_HEAD.
    expect(git(converger, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(converger, ".git", "MERGE_HEAD"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (d) The FINAL push is REJECTED (non-fast-forward) → LOUD failure, and the
  //     caller never receives a branchTip implying convergence landed.
  // -------------------------------------------------------------------------
  it("throws ConvergeError when the final push is rejected and does NOT report a converged tip", async () => {
    const hostA = makeHost("host-A");
    commitAndPublishLane(hostA, "host-A", "issueA.txt", "issue A work\n");

    // Advance origin's run branch from ANOTHER clone, so the converger's local
    // main no longer contains origin's tip → its final push is a real non-FF
    // REJECTION from real git (not a simulated return value).
    const intruder = makeHost("intruder");
    writeFileSync(path.join(intruder, "intruder.txt"), "landed first\n");
    git(intruder, "add", "-A");
    git(intruder, "commit", "-m", "intruder lands first");
    git(intruder, "push", "origin", BRANCH);
    const originTipBefore = git(intruder, "rev-parse", "HEAD");

    await expect(
      convergeLanes(makeExecFileGitRunner(), {
        repoRoot: converger,
        branch: BRANCH,
        hostId: "converger",
        remote: "origin",
      }),
    ).rejects.toThrow(ConvergeError);

    // WHEN the push is rejected: origin's run branch is UNCHANGED — the
    // convergence provably did not land, so nothing may claim it did.
    expect(git(converger, "ls-remote", "origin", `refs/heads/${BRANCH}`)).toContain(
      originTipBefore,
    );
    const verify = path.join(tmp, "verify-rejected");
    git(tmp, "clone", "--branch", BRANCH, remote, verify);
    expect(existsSync(path.join(verify, "issueA.txt"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (e) A conflict marker that could NOT be pushed must never be claimed in
  //     `conflicts` — that would be exactly the silent divergence the marker
  //     exists to prevent.
  // -------------------------------------------------------------------------
  it("does NOT claim a conflict ref when the marker push fails, and reports the failure", async () => {
    const hostA = makeHost("host-A");
    const hostB = makeHost("host-B");
    commitAndPublishLane(hostA, "host-A", "base.txt", "A changed base\n");
    commitAndPublishLane(hostB, "host-B", "base.txt", "B changed base\n");

    // Real git for EVERYTHING except the one marker push we fault-inject at the
    // production GitRunner seam — the rest of the path stays real.
    const real = makeExecFileGitRunner();
    const faultyMarkerPush: GitRunner = (cwd, ...args) => {
      if (args[0] === "push" && args.some((a) => a.includes("refs/sandcastle/conflict/"))) {
        return { ok: false, stdout: "", stderr: "simulated marker push failure" };
      }
      return real(cwd, ...args);
    };

    const result = await convergeLanes(faultyMarkerPush, {
      repoRoot: converger,
      branch: BRANCH,
      hostId: "converger",
      remote: "origin",
    });

    const conflictLane = result.perLane.find((l) => l.result === "conflict");
    expect(conflictLane).toBeDefined();
    // The lane is truthful: no markerRef, and a reason explaining the failure.
    expect(conflictLane?.markerRef).toBeUndefined();
    expect(conflictLane?.reason).toMatch(/marker/i);
    // It must NOT be claimed as a written marker.
    expect(result.conflicts).toEqual([]);
    // WHEN the marker push failed: origin genuinely carries NO conflict ref.
    expect(git(converger, "ls-remote", "origin", "refs/sandcastle/conflict/*")).toBe("");
  });

  // -------------------------------------------------------------------------
  // (f) A dirty tree is refused BEFORE any checkout, and the operator's branch
  //     is left exactly where they had it.
  // -------------------------------------------------------------------------
  it("refuses a dirty tree BEFORE checkout and leaves the operator's branch and changes untouched", async () => {
    const hostA = makeHost("host-A");
    commitAndPublishLane(hostA, "host-A", "issueA.txt", "issue A work\n");

    // Operator is sitting on their own branch with uncommitted work.
    git(converger, "checkout", "-b", "operator-branch");
    const dirtyFile = path.join(converger, "wip.txt");
    writeFileSync(dirtyFile, "precious uncommitted work\n");

    await expect(
      convergeLanes(makeExecFileGitRunner(), {
        repoRoot: converger,
        branch: BRANCH,
        hostId: "converger",
        remote: "origin",
      }),
    ).rejects.toThrow(ConvergeError);

    // Never checked out over the dirty tree: still on operator-branch, work intact.
    expect(git(converger, "symbolic-ref", "--short", "HEAD")).toBe("operator-branch");
    expect(existsSync(dirtyFile)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (g) On the SUCCESS path the operator's original branch is restored.
  // -------------------------------------------------------------------------
  it("restores the operator's original branch after a successful convergence", async () => {
    const hostA = makeHost("host-A");
    commitAndPublishLane(hostA, "host-A", "issueA.txt", "issue A work\n");
    git(converger, "checkout", "-b", "operator-branch");

    const result = await convergeLanes(makeExecFileGitRunner(), {
      repoRoot: converger,
      branch: BRANCH,
      hostId: "converger",
      remote: "origin",
    });

    expect(result.perLane).toEqual([
      { host: "host-A", result: "merged", tip: expect.any(String) },
    ]);
    // The operator is put back where they were, not stranded on the run branch.
    expect(git(converger, "symbolic-ref", "--short", "HEAD")).toBe("operator-branch");
    // And the convergence genuinely landed on origin.
    const verify = path.join(tmp, "verify-restored");
    git(tmp, "clone", "--branch", BRANCH, remote, verify);
    expect(existsSync(path.join(verify, "issueA.txt"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (h) A merge that fails for a NON-conflict reason (unrelated histories) is
  //     NOT a divergence between the machines. It must fail LOUD naming the real
  //     cause, and must NEVER push a conflict marker claiming the hosts diverged.
  // -------------------------------------------------------------------------
  it("throws naming the real cause on a NON-conflict merge failure and pushes NO conflict marker", async () => {
    // host-A's lane shares NO commit with the run branch (orphan history), so
    // real git refuses the merge with "unrelated histories" — a merge failure
    // that is emphatically not a content conflict.
    const hostA = makeHost("host-A");
    git(hostA, "checkout", "--orphan", "alien");
    git(hostA, "rm", "-rf", ".");
    writeFileSync(path.join(hostA, "alien.txt"), "unrelated history\n");
    git(hostA, "add", "-A");
    git(hostA, "commit", "-m", "alien root commit");
    git(hostA, "push", "--force", "origin", "alien:refs/sandcastle/lanes/host-A");

    const originTipBefore = git(converger, "ls-remote", "origin", `refs/heads/${BRANCH}`);

    // (c) The error names the REAL cause, not a fabricated divergence.
    await expect(
      convergeLanes(makeExecFileGitRunner(), {
        repoRoot: converger,
        branch: BRANCH,
        hostId: "converger",
        remote: "origin",
      }),
    ).rejects.toThrow(/unrelated histories/i);

    // (b) WHEN it is not a conflict: origin genuinely carries NO marker ref. A
    // pushed marker here would be a durable LIE about the two machines.
    expect(git(converger, "ls-remote", "origin", "refs/sandcastle/conflict/*")).toBe("");
    // Nothing was fabricated locally either.
    expect(git(converger, "for-each-ref", "--format=%(refname)", "refs/sandcastle/conflict/")).toBe(
      "",
    );
    // The run branch on origin is untouched — no half-convergence landed.
    expect(git(converger, "ls-remote", "origin", `refs/heads/${BRANCH}`)).toBe(originTipBefore);
    // The converger's tree is left clean — no half-merge stranded behind.
    expect(git(converger, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(converger, ".git", "MERGE_HEAD"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (i) A `git status` that FAILS is an UNKNOWN tree, not a clean one. Both the
  //     pre-checkout guard and the per-lane guard must refuse rather than treat
  //     the failed check as a pass (proceeding is how a false conflict is made).
  // -------------------------------------------------------------------------
  it("refuses when the pre-checkout dirty check itself FAILS, rather than assuming clean", async () => {
    const hostA = makeHost("host-A");
    commitAndPublishLane(hostA, "host-A", "issueA.txt", "issue A work\n");

    // Fault ONLY the FIRST status — the pre-checkout guard — at the production
    // GitRunner seam, leaving the per-lane guard real. Faulting every status
    // would let the PER-LANE guard throw and the test would pass even with this
    // guard broken; isolating the first call is what makes it real evidence.
    const real = makeExecFileGitRunner();
    let statusCalls = 0;
    const faultyStatus: GitRunner = (cwd, ...args) => {
      if (args[0] === "status" && ++statusCalls === 1) {
        return { ok: false, stdout: "", stderr: "fatal: unable to read index" };
      }
      return real(cwd, ...args);
    };

    await expect(
      convergeLanes(faultyStatus, {
        repoRoot: converger,
        branch: BRANCH,
        hostId: "converger",
        remote: "origin",
      }),
    ).rejects.toThrow(ConvergeError);

    // It refused BEFORE converging: origin's run branch never got host-A's work.
    const verify = path.join(tmp, "verify-unknown-tree");
    git(tmp, "clone", "--branch", BRANCH, remote, verify);
    expect(existsSync(path.join(verify, "issueA.txt"))).toBe(false);
    // And no marker was invented for a peer that never conflicted.
    expect(git(converger, "ls-remote", "origin", "refs/sandcastle/conflict/*")).toBe("");
  });

  it("refuses when the PER-LANE dirty check fails, and invents no conflict marker", async () => {
    const hostA = makeHost("host-A");
    commitAndPublishLane(hostA, "host-A", "issueA.txt", "issue A work\n");

    // Let the FIRST status (the pre-checkout guard) through as real, then fault
    // the per-lane guard — isolating the second skip-on-failure site.
    const real = makeExecFileGitRunner();
    let statusCalls = 0;
    const faultySecondStatus: GitRunner = (cwd, ...args) => {
      if (args[0] === "status" && ++statusCalls > 1) {
        return { ok: false, stdout: "", stderr: "fatal: unable to read index" };
      }
      return real(cwd, ...args);
    };

    await expect(
      convergeLanes(faultySecondStatus, {
        repoRoot: converger,
        branch: BRANCH,
        hostId: "converger",
        remote: "origin",
      }),
    ).rejects.toThrow(ConvergeError);

    expect(git(converger, "ls-remote", "origin", "refs/sandcastle/conflict/*")).toBe("");
  });

  // -------------------------------------------------------------------------
  // (c) No peers → noop.
  // -------------------------------------------------------------------------
  it("reports noop when no peer lanes exist", async () => {
    const result = await convergeLanes(makeExecFileGitRunner(), {
      repoRoot: converger,
      branch: BRANCH,
      hostId: "converger",
      remote: "origin",
    });
    expect(result.perLane).toEqual([{ host: "converger", result: "noop" }]);
    expect(result.conflicts).toEqual([]);
  });
});
