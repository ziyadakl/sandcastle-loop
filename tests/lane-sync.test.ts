/**
 * Cross-host LANE SYNC — unit + integration tests.
 *
 * publish/discoverPeers/syncInto are exercised against a REAL local bare repo
 * with TWO clones acting as two hosts (offline, real git semantics — NEVER the
 * real origin). Failure paths that a real remote can't easily reproduce
 * (auth-failed push, fetch fault) use a stub {@link GitRunner}.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  createLaneSync,
  LaneSyncError,
  type LaneSyncResult,
  type PeerMergeResult,
} from "../src/state/lane-sync.js";
import type { GitRunner, GitRunResult } from "../src/state/lock.js";

/** Tiny local git runner mirroring lock.test.ts's realRunGit. */
function realRunGit(cwd: string, ...args: string[]): GitRunResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
    return { ok: false, stdout: stdout.trim(), stderr: stderr.trim() || e.message };
  }
}

/** git with a committer identity baked in, for commits/merges in a clone. */
function gitID(cwd: string, ...args: string[]): GitRunResult {
  return realRunGit(cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args);
}

const BRANCH = "integration";

describe("lane-sync (real bare repo, two host clones)", () => {
  let tmp: string;
  let remote: string;
  let hostA: string; // clone acting as host-A (checked out on BRANCH)
  let hostB: string; // clone acting as host-B (checked out on BRANCH)

  const laneSyncA = () =>
    createLaneSync({ git: realRunGit, repoRoot: hostA, hostId: "host-A", remote });
  const laneSyncB = () =>
    createLaneSync({ git: realRunGit, repoRoot: hostB, hostId: "host-B", remote });

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-lane-"));
    remote = path.join(tmp, "remote.git");
    hostA = path.join(tmp, "hostA");
    hostB = path.join(tmp, "hostB");
    realRunGit(tmp, "init", "--bare", remote);

    // Seed the shared integration branch from a throwaway seed clone.
    const seed = path.join(tmp, "seed");
    realRunGit(tmp, "clone", remote, seed);
    writeFileSync(path.join(seed, "base.txt"), "base\n");
    gitID(seed, "add", "-A");
    gitID(seed, "commit", "-m", "base");
    gitID(seed, "branch", "-M", BRANCH);
    gitID(seed, "push", "origin", BRANCH);

    // Both hosts clone and check out the shared branch.
    realRunGit(tmp, "clone", remote, hostA);
    gitID(hostA, "checkout", BRANCH);
    realRunGit(tmp, "clone", remote, hostB);
    gitID(hostB, "checkout", BRANCH);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // publish
  // -------------------------------------------------------------------------

  it("publish creates refs/sandcastle/lanes/<hostId> pointing at the branch tip", async () => {
    await laneSyncA().publish(BRANCH);

    const tip = realRunGit(hostA, "rev-parse", BRANCH).stdout;
    const ls = realRunGit(hostA, "ls-remote", remote, "refs/sandcastle/lanes/host-A");
    expect(ls.stdout).toContain("refs/sandcastle/lanes/host-A");
    expect(ls.stdout).toContain(tip);
    // Lane refs are invisible to branch listings.
    const branches = realRunGit(hostA, "ls-remote", "--heads", remote);
    expect(branches.stdout).not.toContain("sandcastle/lanes");
  });

  it("publish updates the lane ref after the branch advances", async () => {
    await laneSyncA().publish(BRANCH);
    writeFileSync(path.join(hostA, "more.txt"), "more\n");
    gitID(hostA, "add", "-A");
    gitID(hostA, "commit", "-m", "advance");
    await laneSyncA().publish(BRANCH);

    const tip = realRunGit(hostA, "rev-parse", BRANCH).stdout;
    const ls = realRunGit(hostA, "ls-remote", remote, "refs/sandcastle/lanes/host-A");
    expect(ls.stdout).toContain(tip);
  });

  it("publish throws LaneSyncError on a push failure (auth fault)", async () => {
    const stub: GitRunner = (_cwd, ...args) => {
      if (args[0] === "push") {
        return { ok: false, stdout: "", stderr: "fatal: Authentication failed" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };
    const ls = createLaneSync({ git: stub, repoRoot: hostA, hostId: "host-A", remote });
    await expect(ls.publish(BRANCH)).rejects.toBeInstanceOf(LaneSyncError);
    await expect(ls.publish(BRANCH)).rejects.toMatchObject({
      stderr: "fatal: Authentication failed",
    });
  });

  // -------------------------------------------------------------------------
  // discoverPeers
  // -------------------------------------------------------------------------

  it("discoverPeers returns peers published by another host, excluding own hostId", async () => {
    await laneSyncB().publish(BRANCH); // host-B publishes
    await laneSyncA().publish(BRANCH); // host-A publishes too

    const peersOfA = await laneSyncA().discoverPeers();
    expect(peersOfA).toEqual(["host-B"]);

    const peersOfB = await laneSyncB().discoverPeers();
    expect(peersOfB).toEqual(["host-A"]);
  });

  it("discoverPeers returns [] when no peers have published", async () => {
    expect(await laneSyncA().discoverPeers()).toEqual([]);
  });

  it("discoverPeers returns [] (never throws) on an ls-remote failure", async () => {
    const stub: GitRunner = (_cwd, ...args) => {
      if (args[0] === "ls-remote") {
        return { ok: false, stdout: "", stderr: "fatal: could not read from remote" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };
    const ls = createLaneSync({ git: stub, repoRoot: hostA, hostId: "host-A", remote });
    expect(await ls.discoverPeers()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // syncInto
  // -------------------------------------------------------------------------

  it("syncInto cleanly merges a peer's new commit into the local worktree branch", async () => {
    // host-B adds a new file on its integration and publishes its lane.
    writeFileSync(path.join(hostB, "peer.txt"), "from B\n");
    gitID(hostB, "add", "-A");
    gitID(hostB, "commit", "-m", "peer work");
    await laneSyncB().publish(BRANCH);

    // host-A syncs host-B's lane into its own integration worktree.
    const result: LaneSyncResult = await laneSyncA().syncInto(BRANCH, hostA);
    expect(result.peers).toEqual<PeerMergeResult[]>([{ peer: "host-B", status: "merged" }]);
    // The peer's file is now present in host-A's launch worktree.
    expect(existsSync(path.join(hostA, "peer.txt"))).toBe(true);
    // Worktree left clean.
    expect(realRunGit(hostA, "status", "--porcelain").stdout).toBe("");
  });

  it("syncInto reports conflict and leaves the worktree CLEAN when the same file diverges", async () => {
    // Both hosts change base.txt differently on their integration branch.
    writeFileSync(path.join(hostA, "base.txt"), "A changed this\n");
    gitID(hostA, "add", "-A");
    gitID(hostA, "commit", "-m", "A edit");

    writeFileSync(path.join(hostB, "base.txt"), "B changed this\n");
    gitID(hostB, "add", "-A");
    gitID(hostB, "commit", "-m", "B edit");
    await laneSyncB().publish(BRANCH);

    const result = await laneSyncA().syncInto(BRANCH, hostA);
    expect(result.peers).toHaveLength(1);
    const r = result.peers[0];
    expect(r.peer).toBe("host-B");
    expect(r.status).toBe("conflict");
    expect(r.conflictedFiles).toContain("base.txt");

    // Worktree is left CLEAN: no porcelain output, no MERGE_HEAD.
    expect(realRunGit(hostA, "status", "--porcelain").stdout).toBe("");
    expect(existsSync(path.join(hostA, ".git", "MERGE_HEAD"))).toBe(false);
    // host-A's own edit is intact (abort restored it).
    expect(realRunGit(hostA, "rev-parse", BRANCH).ok).toBe(true);
  });

  it("syncInto skips a peer (no throw) when the fetch fails", async () => {
    await laneSyncB().publish(BRANCH); // real lane exists so discovery finds host-B

    // Stub routes ls-remote to the real remote for discovery, but fails fetch.
    const stub: GitRunner = (cwd, ...args) => {
      if (args[0] === "fetch") {
        return { ok: false, stdout: "", stderr: "fatal: couldn't find remote ref" };
      }
      return realRunGit(cwd, ...args);
    };
    const ls = createLaneSync({ git: stub, repoRoot: hostA, hostId: "host-A", remote });
    const result = await ls.syncInto(BRANCH, hostA);
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0]).toMatchObject({ peer: "host-B", status: "skipped" });
  });

  it("syncInto skips a peer (no throw) when the launch worktree is dirty", async () => {
    writeFileSync(path.join(hostB, "peer.txt"), "from B\n");
    gitID(hostB, "add", "-A");
    gitID(hostB, "commit", "-m", "peer work");
    await laneSyncB().publish(BRANCH);

    // Dirty the launch worktree.
    writeFileSync(path.join(hostA, "base.txt"), "uncommitted local edit\n");

    const result = await laneSyncA().syncInto(BRANCH, hostA);
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0]).toMatchObject({ peer: "host-B", status: "skipped" });
    // The merge never ran: peer.txt not pulled in, dirt preserved.
    expect(existsSync(path.join(hostA, "peer.txt"))).toBe(false);
  });
});
