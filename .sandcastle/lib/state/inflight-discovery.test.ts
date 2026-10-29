/**
 * Coverage for the two run-discovery entrypoints behind `--action resume`.
 *
 * `inflight-discovery.ts`'s own header claimed it was "tested entirely offline
 * against a real local bare repo". Until this file there was no test at all —
 * the module had zero coverage while its doc asserted the opposite, which is
 * how the resume path shipped unable to find a dead run.
 *
 * Everything here drives the injected {@link GitRunner} with a fake, matching
 * on argv shape exactly as the module calls it. No real git, no network.
 */
import { describe, expect, it } from "vitest";

import type { GitRunner, GitRunResult } from "./issue-lease.js";
import type { RunState, SandcastleStatus } from "../status/schema.js";
import { STATUS_SCHEMA_VERSION } from "../status/schema.js";
import {
  INFLIGHT_STALE_MS,
  discoverInflightRun,
  discoverResumableRun,
} from "./inflight-discovery.js";

const REPO = "/repo";
const REMOTE = "origin";
const NOW = Date.parse("2026-08-16T07:00:00.000Z");

const ok = (stdout = ""): GitRunResult => ({ ok: true, stdout, stderr: "" });
const nope = (): GitRunResult => ({ ok: false, stdout: "", stderr: "boom" });

/** A minimal snapshot that satisfies SandcastleStatusSchema. */
function snapshot(over: {
  hostId: string;
  state: RunState;
  updatedAt: string;
  runId?: string;
  branch?: string;
}): SandcastleStatus {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    state: over.state,
    run: {
      branch: over.branch ?? "sandcastle/queue-20260815",
      repo: "example/my-project",
      startedAt: "2026-08-16T00:00:00.000Z",
      iterations: { current: 5, total: 60 },
      maxConcurrent: 4,
    },
    totals: { merged: 18, needsHuman: 4, requeued: 1, running: 0 },
    issues: [],
    history: [],
    hostId: over.hostId,
    runId: over.runId ?? "run-a",
    updatedAt: over.updatedAt,
  } as SandcastleStatus;
}

interface FakeOpts {
  /** hostId → snapshot, or `"invalid"` to publish a ref whose body will not parse. */
  readonly peers: Record<string, SandcastleStatus | "invalid">;
  /** Issue numbers to report under refs/locks/issue-*. */
  readonly locks?: readonly number[];
  /** Make the status-ref ls-remote fail (total discovery failure). */
  readonly lsRemoteFails?: boolean;
  /** hostIds whose status-ref fetch fails (that peer must be skipped). */
  readonly fetchFails?: readonly string[];
}

function fakeGit(opts: FakeOpts): GitRunner {
  const STATUS = "refs/sandcastle/status/";
  const MIRROR = "refs/sandcastle/peer-status/";
  return (cwd: string, ...args: string[]): GitRunResult => {
    expect(cwd).toBe(REPO);
    const [verb, remote, arg] = args;

    if (verb === "ls-remote" && arg === `${STATUS}*`) {
      if (opts.lsRemoteFails) return nope();
      const lines = Object.keys(opts.peers).map(
        (h, i) => `${String(i).repeat(40)}\t${STATUS}${h}`,
      );
      return ok(lines.join("\n"));
    }

    if (verb === "ls-remote" && arg === "refs/locks/issue-*") {
      const lines = (opts.locks ?? []).map(
        (n, i) => `${String(i).repeat(40)}\trefs/locks/issue-${n}`,
      );
      return ok(lines.join("\n"));
    }

    if (verb === "fetch") {
      expect(remote).toBe(REMOTE);
      const peer = arg!.slice(arg!.indexOf(":") + 1 + MIRROR.length);
      return opts.fetchFails?.includes(peer) ? nope() : ok();
    }

    if (verb === "show") {
      const ref = args[args.length - 1];
      const peer = ref.slice(MIRROR.length);
      const snap = opts.peers[peer];
      return snap === "invalid" ? ok("not json at all") : ok(JSON.stringify(snap));
    }

    throw new Error(`fake git got an unexpected command: ${args.join(" ")}`);
  };
}

const fresh = new Date(NOW - 30_000).toISOString();
const stale = new Date(NOW - INFLIGHT_STALE_MS - 60_000).toISOString();

// ---------------------------------------------------------------------------
// discoverInflightRun — the LIVENESS question. Fresh AND running, nothing else.
// ---------------------------------------------------------------------------

describe("discoverInflightRun", () => {
  it("finds a fresh running peer and reports its branch, state and leases", async () => {
    const git = fakeGit({
      peers: { vps: snapshot({ hostId: "vps", state: "running", updatedAt: fresh }) },
      locks: [1077, 1048],
    });
    const run = await discoverInflightRun(git, REPO, REMOTE, () => NOW);
    expect(run).not.toBeNull();
    expect(run!.branch).toBe("sandcastle/queue-20260815");
    expect(run!.state).toBe("running");
    expect(run!.hosts).toEqual(["vps"]);
    expect(run!.inflightIssues).toEqual([1048, 1077]);
  });

  it("returns null for a running peer that has gone stale", async () => {
    const git = fakeGit({
      peers: { vps: snapshot({ hostId: "vps", state: "running", updatedAt: stale }) },
    });
    expect(await discoverInflightRun(git, REPO, REMOTE, () => NOW)).toBeNull();
  });

  it("returns null for a fresh peer that is not running", async () => {
    const git = fakeGit({
      peers: { vps: snapshot({ hostId: "vps", state: "restarting", updatedAt: fresh }) },
    });
    expect(await discoverInflightRun(git, REPO, REMOTE, () => NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverResumableRun — the RESUMABILITY question. This is the regression the
// module shipped without: the loop that died in the night is stale AND not
// running, so liveness discovery is blind to exactly the run worth resuming.
// ---------------------------------------------------------------------------

describe("discoverResumableRun", () => {
  it("finds the dead hot-reload run that discoverInflightRun cannot see", async () => {
    // The real 2026-08-16 shape: exit 75 wrote state "restarting", the relaunch
    // failed its pre-flight, and nothing has written since.
    const peers = {
      vps: snapshot({ hostId: "vps", state: "restarting", updatedAt: stale }),
    };
    expect(
      await discoverInflightRun(fakeGit({ peers }), REPO, REMOTE, () => NOW),
    ).toBeNull();

    const run = await discoverResumableRun(fakeGit({ peers }), REPO, REMOTE);
    expect(run).not.toBeNull();
    expect(run!.branch).toBe("sandcastle/queue-20260815");
    expect(run!.state).toBe("restarting");
    expect(run!.updatedAt).toBe(stale);
  });

  it.each<RunState>(["running", "restarting", "stopping", "stopped", "unhealthy"])(
    "treats a %s run as resumable however old it is",
    async (state) => {
      const git = fakeGit({
        peers: { vps: snapshot({ hostId: "vps", state, updatedAt: stale }) },
      });
      const run = await discoverResumableRun(git, REPO, REMOTE);
      expect(run?.state).toBe(state);
    },
  );

  it("refuses a run that finished — done is the one state never resumed", async () => {
    const git = fakeGit({
      peers: { vps: snapshot({ hostId: "vps", state: "done", updatedAt: fresh }) },
    });
    expect(await discoverResumableRun(git, REPO, REMOTE)).toBeNull();
  });

  it("picks the most recently written run when several are unfinished", async () => {
    const git = fakeGit({
      peers: {
        old: snapshot({
          hostId: "old",
          state: "stopped",
          updatedAt: "2026-08-14T00:00:00.000Z",
          runId: "run-old",
          branch: "sandcastle/queue-20260814",
        }),
        recent: snapshot({
          hostId: "recent",
          state: "restarting",
          updatedAt: "2026-08-16T06:59:00.000Z",
          runId: "run-new",
          branch: "sandcastle/queue-20260815",
        }),
      },
    });
    const run = await discoverResumableRun(git, REPO, REMOTE);
    expect(run!.runId).toBe("run-new");
    expect(run!.branch).toBe("sandcastle/queue-20260815");
  });

  it("folds two hosts on the same run into one result", async () => {
    const git = fakeGit({
      peers: {
        a: snapshot({ hostId: "a", state: "stopped", updatedAt: stale }),
        b: snapshot({
          hostId: "b",
          state: "restarting",
          updatedAt: "2026-08-16T06:59:00.000Z",
        }),
      },
    });
    const run = await discoverResumableRun(git, REPO, REMOTE);
    expect(run!.hosts.slice().sort()).toEqual(["a", "b"]);
    // state and updatedAt both come from the peer that wrote LAST.
    expect(run!.state).toBe("restarting");
    expect(run!.updatedAt).toBe("2026-08-16T06:59:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Fail-soft: a discovery glitch must never crash the resume entrypoint.
// ---------------------------------------------------------------------------

describe("fail-soft behaviour, shared by both entrypoints", () => {
  it("returns null when the status ls-remote fails outright", async () => {
    const git = fakeGit({ peers: {}, lsRemoteFails: true });
    expect(await discoverResumableRun(git, REPO, REMOTE)).toBeNull();
  });

  it("returns null when no host has ever published a status ref", async () => {
    expect(await discoverResumableRun(fakeGit({ peers: {} }), REPO, REMOTE)).toBeNull();
  });

  it("skips a peer whose ref will not fetch, and keeps the rest", async () => {
    const git = fakeGit({
      peers: {
        broken: snapshot({ hostId: "broken", state: "stopped", updatedAt: fresh }),
        good: snapshot({
          hostId: "good",
          state: "stopped",
          updatedAt: stale,
          runId: "run-good",
        }),
      },
      fetchFails: ["broken"],
    });
    const run = await discoverResumableRun(git, REPO, REMOTE);
    expect(run!.runId).toBe("run-good");
  });

  it("skips a peer whose snapshot body is not valid JSON", async () => {
    const git = fakeGit({
      peers: {
        junk: "invalid",
        good: snapshot({ hostId: "good", state: "stopped", updatedAt: stale }),
      },
    });
    const run = await discoverResumableRun(git, REPO, REMOTE);
    expect(run!.hosts).toEqual(["good"]);
  });

  it("reports no leases rather than failing when the lock listing is empty", async () => {
    const git = fakeGit({
      peers: { vps: snapshot({ hostId: "vps", state: "stopped", updatedAt: stale }) },
    });
    const run = await discoverResumableRun(git, REPO, REMOTE);
    expect(run!.inflightIssues).toEqual([]);
  });
});
