/**
 * Cross-host STATUS SYNC — unit + integration tests.
 *
 * publish/fetchPeers are exercised against a REAL local bare repo with TWO+
 * clones acting as separate hosts (offline, real git semantics — NEVER the real
 * origin). The status snapshot rides in a parentless commit MESSAGE under
 * `refs/sandcastle/status/<hostId>`. The push-failure path (which a real remote
 * can't easily reproduce) uses a stub {@link GitRunner}.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createStatusSync } from "../src/state/status-sync.js";
import type { GitRunner, GitRunResult } from "../src/state/issue-lease.js";
import type { SandcastleStatus } from "../.sandcastle/lib/status/schema.js";

/** Tiny local git runner mirroring lane-sync.test.ts's realRunGit. */
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

/** Build a valid v3 SandcastleStatus snapshot for `hostId` on `runId`. */
function makeSnapshot(hostId: string, runId: string): SandcastleStatus {
  return {
    schemaVersion: 3,
    state: "running",
    run: {
      branch: "integration",
      repo: "acme/widgets",
      startedAt: "2026-07-14T00:00:00.000Z",
      iterations: { current: 2, total: 10 },
      maxConcurrent: 3,
    },
    totals: { merged: 4, needsHuman: 1, requeued: 0, running: 2 },
    issues: [],
    hostId,
    runId,
    updatedAt: "2026-07-14T01:00:00.000Z",
    history: [],
  };
}

describe("status-sync (real bare repo, multiple host clones)", () => {
  let tmp: string;
  let remote: string;

  /** Make a fresh clone acting as one host; returns its repo path. */
  function makeClone(name: string): string {
    const repo = path.join(tmp, name);
    realRunGit(tmp, "clone", remote, repo);
    return repo;
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-status-"));
    remote = path.join(tmp, "remote.git");
    realRunGit(tmp, "init", "--bare", remote);
    // A status ref needs no seeded branch — the commit is parentless. But a
    // fresh bare repo works fine for ls-remote/fetch of arbitrary refs.
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips a published snapshot to a peer's fetchPeers", async () => {
    const hostA = makeClone("hostA");
    const hostB = makeClone("hostB");
    const runId = "run-2026-07-14";

    const syncA = createStatusSync({ git: realRunGit, repoRoot: hostA, hostId: "host-A", remote });
    const pub = await syncA.publish(JSON.stringify(makeSnapshot("host-A", runId)));
    expect(pub).toEqual({ ok: true });

    const syncB = createStatusSync({ git: realRunGit, repoRoot: hostB, hostId: "host-B", remote });
    const peers = await syncB.fetchPeers(runId);
    expect(peers).toHaveLength(1);
    expect(peers[0].hostId).toBe("host-A");
    expect(peers[0].runId).toBe(runId);
    expect(peers[0].totals).toEqual({ merged: 4, needsHuman: 1, requeued: 0, running: 2 });

    // Status refs are invisible to branch listings.
    const heads = realRunGit(hostB, "ls-remote", "--heads", remote);
    expect(heads.stdout).not.toContain("sandcastle/status");
  });

  it("excludes a peer whose snapshot has a DIFFERENT runId", async () => {
    const hostA = makeClone("hostA");
    const hostC = makeClone("hostC");
    const viewer = makeClone("viewer");

    await createStatusSync({ git: realRunGit, repoRoot: hostA, hostId: "host-A", remote })
      .publish(JSON.stringify(makeSnapshot("host-A", "run-KEEP")));
    await createStatusSync({ git: realRunGit, repoRoot: hostC, hostId: "host-C", remote })
      .publish(JSON.stringify(makeSnapshot("host-C", "run-OTHER")));

    const syncV = createStatusSync({ git: realRunGit, repoRoot: viewer, hostId: "viewer", remote });
    const peers = await syncV.fetchPeers("run-KEEP");
    expect(peers.map((p) => p.hostId)).toEqual(["host-A"]);
  });

  it("skips (never throws on) a corrupt/schema-invalid status ref, returning the good peers only", async () => {
    const good = makeClone("good");
    const bad = makeClone("bad");
    const invalid = makeClone("invalid");
    const viewer = makeClone("viewer");
    const runId = "run-mix";

    await createStatusSync({ git: realRunGit, repoRoot: good, hostId: "host-good", remote })
      .publish(JSON.stringify(makeSnapshot("host-good", runId)));
    // Non-JSON commit message published under a status ref.
    await createStatusSync({ git: realRunGit, repoRoot: bad, hostId: "host-bad", remote })
      .publish("this is not json at all");
    // Valid JSON but not a valid SandcastleStatus.
    await createStatusSync({ git: realRunGit, repoRoot: invalid, hostId: "host-invalid", remote })
      .publish(JSON.stringify({ hello: "world" }));

    const syncV = createStatusSync({ git: realRunGit, repoRoot: viewer, hostId: "viewer", remote });
    const peers = await syncV.fetchPeers(runId);
    expect(peers.map((p) => p.hostId)).toEqual(["host-good"]);
  });

  it("publish returns { ok: false } (does not throw) when the push fails", async () => {
    const hostA = makeClone("hostA");
    // Route commit-tree (and everything else) to the real runner, but fail push.
    const stub: GitRunner = (cwd, ...args) => {
      if (args[0] === "push") {
        return { ok: false, stdout: "", stderr: "fatal: Authentication failed" };
      }
      return realRunGit(cwd, ...args);
    };
    const sync = createStatusSync({ git: stub, repoRoot: hostA, hostId: "host-A", remote });
    const res = await sync.publish(JSON.stringify(makeSnapshot("host-A", "run-x")));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Authentication failed");
  });

  it("fetchPeers returns [] (never throws) on an ls-remote failure", async () => {
    const hostA = makeClone("hostA");
    const stub: GitRunner = (cwd, ...args) => {
      if (args[0] === "ls-remote") {
        return { ok: false, stdout: "", stderr: "fatal: could not read from remote" };
      }
      return realRunGit(cwd, ...args);
    };
    const sync = createStatusSync({ git: stub, repoRoot: hostA, hostId: "host-A", remote });
    expect(await sync.fetchPeers("run-x")).toEqual([]);
  });
});
