/**
 * IN-FLIGHT RUN DISCOVERY — the read path the `resume` command uses to find a
 * run already in progress across hosts, using ONLY origin refs.
 *
 * Exercised against a REAL local bare repo with multiple clones acting as
 * separate hosts (offline, real git semantics — NEVER the real origin). Each
 * host publishes its status snapshot to `refs/sandcastle/status/<hostId>` (a
 * parentless empty-tree commit whose MESSAGE carries the JSON), mirroring
 * status-sync's transport; in-flight issue leases live at `refs/locks/issue-<N>`.
 *
 * Time is injected (the optional `now` arg) so the staleness window is
 * deterministic — no wall-clock flake.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { discoverInflightRun } from "../.sandcastle/lib/state/inflight-discovery.js";
import { createStatusSync } from "../.sandcastle/lib/state/status-sync.js";
import { EMPTY_TREE_OID, type GitRunner, type GitRunResult } from "../.sandcastle/lib/state/issue-lease.js";
import type { SandcastleStatus, RunState } from "../.sandcastle/lib/status/schema.js";

/** Tiny local git runner mirroring status-sync.test.ts's realRunGit. */
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

/** A fixed "now" and offsets so freshness is deterministic. */
const FIXED_NOW = Date.parse("2026-07-14T12:00:00.000Z");
const now = () => FIXED_NOW;
const iso = (msAgo: number) => new Date(FIXED_NOW - msAgo).toISOString();
const MIN = 60_000;

/** Build a valid v3 SandcastleStatus snapshot. */
function makeSnapshot(
  hostId: string,
  runId: string,
  opts: { branch?: string; state?: RunState; updatedAt?: string } = {},
): SandcastleStatus {
  return {
    schemaVersion: 3,
    state: opts.state ?? "running",
    run: {
      branch: opts.branch ?? "integration",
      repo: "acme/widgets",
      startedAt: "2026-07-14T00:00:00.000Z",
      iterations: { current: 2, total: 10 },
      maxConcurrent: 3,
    },
    totals: { merged: 4, needsHuman: 1, requeued: 0, running: 2 },
    issues: [],
    hostId,
    runId,
    updatedAt: opts.updatedAt ?? iso(1 * MIN),
    history: [],
  };
}

describe("discoverInflightRun (real bare repo, multiple host clones)", () => {
  let tmp: string;
  let remote: string;

  function makeClone(name: string): string {
    const repo = path.join(tmp, name);
    realRunGit(tmp, "clone", remote, repo);
    return repo;
  }

  /** Publish `snap` under this host's status ref, via the real transport. */
  async function publishStatus(repo: string, snap: SandcastleStatus): Promise<void> {
    const res = await createStatusSync({
      git: realRunGit,
      repoRoot: repo,
      hostId: snap.hostId,
      remote,
    }).publish(JSON.stringify(snap));
    expect(res).toEqual({ ok: true });
  }

  /** Create an in-flight issue lease at `refs/locks/issue-<n>` on the remote. */
  function pushLock(repo: string, n: number): void {
    const commit = realRunGit(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit-tree",
      EMPTY_TREE_OID,
      "-m",
      `lock ${n}`,
    );
    expect(commit.ok).toBe(true);
    const pushed = realRunGit(
      repo,
      "push",
      remote,
      `${commit.stdout.trim()}:refs/locks/issue-${n}`,
    );
    expect(pushed.ok).toBe(true);
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-inflight-"));
    remote = path.join(tmp, "remote.git");
    realRunGit(tmp, "init", "--bare", remote);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("fuses two running peers on the same run into one InflightRun", async () => {
    const a = makeClone("a");
    const b = makeClone("b");
    const viewer = makeClone("viewer");
    const runId = "run-2026-07-14";

    await publishStatus(a, makeSnapshot("host-A", runId, { updatedAt: iso(2 * MIN) }));
    await publishStatus(b, makeSnapshot("host-B", runId, { updatedAt: iso(1 * MIN) }));
    pushLock(viewer, 3);
    pushLock(viewer, 7);

    const run = await discoverInflightRun(realRunGit, viewer, remote, now);
    expect(run).not.toBeNull();
    expect(run!.runId).toBe(runId);
    expect(run!.branch).toBe("integration");
    expect([...run!.hosts].sort()).toEqual(["host-A", "host-B"]);
    expect([...run!.inflightIssues].sort((x, y) => x - y)).toEqual([3, 7]);
    // The most-recent peer's updatedAt wins.
    expect(run!.updatedAt).toBe(iso(1 * MIN));
  });

  it("excludes a peer whose updatedAt is stale (outside the window)", async () => {
    const fresh = makeClone("fresh");
    const stale = makeClone("stale");
    const viewer = makeClone("viewer");

    await publishStatus(fresh, makeSnapshot("host-fresh", "run-fresh", { updatedAt: iso(1 * MIN) }));
    await publishStatus(stale, makeSnapshot("host-stale", "run-stale", { updatedAt: iso(30 * MIN) }));

    const run = await discoverInflightRun(realRunGit, viewer, remote, now);
    expect(run).not.toBeNull();
    expect(run!.runId).toBe("run-fresh");
    expect([...run!.hosts]).toEqual(["host-fresh"]);
  });

  it("excludes a peer whose state is not 'running'", async () => {
    const running = makeClone("running");
    const done = makeClone("done");
    const viewer = makeClone("viewer");

    await publishStatus(running, makeSnapshot("host-run", "run-live"));
    await publishStatus(done, makeSnapshot("host-done", "run-finished", { state: "done" }));

    const run = await discoverInflightRun(realRunGit, viewer, remote, now);
    expect(run).not.toBeNull();
    expect(run!.runId).toBe("run-live");
    expect([...run!.hosts]).toEqual(["host-run"]);
  });

  it("returns null when no fresh running peer exists", async () => {
    const done = makeClone("done");
    const stale = makeClone("stale");
    const viewer = makeClone("viewer");

    await publishStatus(done, makeSnapshot("host-done", "run-a", { state: "done" }));
    await publishStatus(stale, makeSnapshot("host-stale", "run-b", { updatedAt: iso(30 * MIN) }));

    expect(await discoverInflightRun(realRunGit, viewer, remote, now)).toBeNull();
  });

  it("skips a broken/unparseable peer ref and still returns the good peer", async () => {
    const good = makeClone("good");
    const bad = makeClone("bad");
    const viewer = makeClone("viewer");
    const runId = "run-mix";

    await publishStatus(good, makeSnapshot("host-good", runId));
    // Non-JSON message published under a status ref (bypass schema by publishing raw).
    await createStatusSync({ git: realRunGit, repoRoot: bad, hostId: "host-bad", remote })
      .publish("this is not json at all");

    const run = await discoverInflightRun(realRunGit, viewer, remote, now);
    expect(run).not.toBeNull();
    expect(run!.runId).toBe(runId);
    expect([...run!.hosts]).toEqual(["host-good"]);
  });

  it("parses inflightIssues from refs/locks/issue-3 and issue-7", async () => {
    const a = makeClone("a");
    const viewer = makeClone("viewer");
    await publishStatus(a, makeSnapshot("host-A", "run-locks"));
    pushLock(viewer, 7);
    pushLock(viewer, 3);

    const run = await discoverInflightRun(realRunGit, viewer, remote, now);
    expect(run!.inflightIssues).toEqual([3, 7]);
  });

  it("picks the run with the most-recent peer when two distinct runs are live", async () => {
    const older = makeClone("older");
    const newer = makeClone("newer");
    const viewer = makeClone("viewer");

    await publishStatus(older, makeSnapshot("host-old", "run-OLD", {
      branch: "b-old",
      updatedAt: iso(4 * MIN),
    }));
    await publishStatus(newer, makeSnapshot("host-new", "run-NEW", {
      branch: "b-new",
      updatedAt: iso(1 * MIN),
    }));

    const run = await discoverInflightRun(realRunGit, viewer, remote, now);
    expect(run!.runId).toBe("run-NEW");
    expect(run!.branch).toBe("b-new");
    expect([...run!.hosts]).toEqual(["host-new"]);
  });

  it("returns null (never throws) on an ls-remote failure", async () => {
    const viewer = makeClone("viewer");
    const stub: GitRunner = (cwd, ...args) => {
      if (args[0] === "ls-remote") {
        return { ok: false, stdout: "", stderr: "fatal: could not read from remote" };
      }
      return realRunGit(cwd, ...args);
    };
    expect(await discoverInflightRun(stub, viewer, remote, now)).toBeNull();
  });
});
