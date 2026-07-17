/**
 * Branch checkpoint git primitives (ADR 0021) — unit tests.
 *
 * Exercises the pure, DI checkpoint helpers against a fake {@link GitRunner}
 * that records every invocation and returns canned {@link GitRunResult}s — no
 * child_process, no real git. Mirrors the seam proven in issue-lease.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
  GitRunner,
  GitRunResult,
} from "../.sandcastle/lib/state/issue-lease.js";
import {
  wipRef,
  hasWorktreeChanges,
  commitWorktreeCheckpoint,
  pushWipRef,
  wipRefExists,
  deleteWipRef,
  listWipRefIssues,
} from "../.sandcastle/lib/state/branch-checkpoint.js";
import { makeExecFileGitRunner } from "../.sandcastle/lib/state/index.js";

type Call = { cwd: string; args: string[] };

/**
 * Build a fake {@link GitRunner} that records each call and returns a canned
 * result computed from the argv. Defaults to `{ ok: true, stdout: "" }`.
 */
function makeFakeGit(
  responder: (args: string[]) => Partial<GitRunResult> = () => ({}),
): { git: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const git: GitRunner = async (cwd, ...args) => {
    calls.push({ cwd, args });
    return { ok: true, stdout: "", stderr: "", ...responder(args) };
  };
  return { git, calls };
}

/** Was a git subcommand (first non-flag arg matching `name`) invoked? */
function callWith(calls: Call[], name: string): Call | undefined {
  return calls.find((c) => c.args.includes(name));
}

describe("wipRef", () => {
  it("names the ref refs/sandcastle/wip/issue-<N>", () => {
    expect(wipRef(7)).toBe("refs/sandcastle/wip/issue-7");
  });
});

describe("hasWorktreeChanges", () => {
  it("is true when git status --porcelain is non-empty", async () => {
    const { git } = makeFakeGit(() => ({ stdout: " M src/foo.ts\n" }));
    expect(await hasWorktreeChanges("/wt", git)).toBe(true);
  });

  it("is false when git status --porcelain is empty", async () => {
    const { git } = makeFakeGit(() => ({ stdout: "" }));
    expect(await hasWorktreeChanges("/wt", git)).toBe(false);
  });

  it("runs status --porcelain in the worktree path", async () => {
    const { git, calls } = makeFakeGit(() => ({ stdout: "" }));
    await hasWorktreeChanges("/wt", git);
    const status = callWith(calls, "status");
    expect(status?.args).toEqual(["status", "--porcelain"]);
    expect(status?.cwd).toBe("/wt");
  });
});

describe("commitWorktreeCheckpoint", () => {
  it("stages then commits with the exact wip message and returns true when dirty", async () => {
    const { git, calls } = makeFakeGit((args) =>
      args.includes("status") ? { stdout: " M src/foo.ts\n" } : {},
    );
    const committed = await commitWorktreeCheckpoint("/wt", 7, "host-a", git);
    expect(committed).toBe(true);

    const add = callWith(calls, "add");
    expect(add?.args).toEqual(["add", "-A"]);

    const commit = callWith(calls, "commit");
    expect(commit?.args).toEqual([
      "commit",
      "-m",
      "wip: checkpoint issue 7 (host-a)",
    ]);

    // ordering: status → add → commit
    const order = calls.map((c) => c.args[0]);
    expect(order.indexOf("add")).toBeLessThan(order.indexOf("commit"));
    expect(order.indexOf("status")).toBeLessThan(order.indexOf("add"));
  });

  it("makes NO commit and returns false when the worktree is clean", async () => {
    const { git, calls } = makeFakeGit(() => ({ stdout: "" }));
    const committed = await commitWorktreeCheckpoint("/wt", 7, "host-a", git);
    expect(committed).toBe(false);
    expect(callWith(calls, "add")).toBeUndefined();
    expect(callWith(calls, "commit")).toBeUndefined();
  });
});

describe("pushWipRef", () => {
  /**
   * Fake git for the push path: `rev-parse` of HEAD (in the worktree) yields
   * `headSha`; `rev-parse` of the local mirror ref yields `mirrorSha` ("" =
   * absent, i.e. --verify --quiet exits non-zero).
   */
  function makePushGit(headSha = "aaaa", mirrorSha = "") {
    return makeFakeGit((args) => {
      if (args[0] === "rev-parse") {
        const rev = args[args.length - 1];
        const sha = rev === "HEAD" ? headSha : mirrorSha;
        return sha ? { stdout: `${sha}\n` } : { ok: false, stdout: "" };
      }
      return {};
    });
  }

  /**
   * REGRESSION (the bug this replaced): a BARE `--force-with-lease` leases
   * against the remote-TRACKING ref, which `refs/sandcastle/wip/*` does not
   * have — so the 2nd push of an issue is rejected "stale info" and origin
   * silently keeps the OLD tip. The lease MUST carry an explicit expected
   * value. This is the string-level guard; the real-git suite below proves the
   * behavior on origin (the old test asserted only `toContain("--force-with-lease")`,
   * which passed happily while work was being lost).
   */
  it("never pushes a BARE --force-with-lease (it has no remote-tracking ref)", async () => {
    const { git, calls } = makePushGit();
    await pushWipRef("/repo", "/wt", 7, git);
    const push = callWith(calls, "push");
    expect(push).toBeDefined();
    expect(push?.args).not.toContain("--force-with-lease");
    expect(
      push?.args.some((a) =>
        a.startsWith("--force-with-lease=refs/sandcastle/wip/issue-7:"),
      ),
    ).toBe(true);
  });

  it("leases against the EMPTY expected value when this host has no mirror ref", async () => {
    const { git, calls } = makePushGit("aaaa", "");
    await pushWipRef("/repo", "/wt", 7, git);
    expect(callWith(calls, "push")?.args).toContain(
      "--force-with-lease=refs/sandcastle/wip/issue-7:",
    );
  });

  it("leases against this host's PRIOR mirror value on a re-push", async () => {
    const { git, calls } = makePushGit("bbbb", "aaaa");
    await pushWipRef("/repo", "/wt", 7, git);
    expect(callWith(calls, "push")?.args).toContain(
      "--force-with-lease=refs/sandcastle/wip/issue-7:aaaa",
    );
  });

  it("pushes the worktree HEAD to the WIP ref", async () => {
    const { git, calls } = makePushGit("bbbb", "aaaa");
    await pushWipRef("/repo", "/wt", 7, git);
    const push = callWith(calls, "push");
    expect(push?.args).toContain("HEAD:refs/sandcastle/wip/issue-7");
    expect(push?.args).toContain("origin");
    expect(push?.args.slice(0, 2)).toEqual(["-C", "/wt"]);
  });

  it("honors a custom remote", async () => {
    const { git, calls } = makePushGit();
    await pushWipRef("/repo", "/wt", 7, git, "backup");
    expect(callWith(calls, "push")?.args).toContain("backup");
  });

  it("returns the GitRunResult without throwing on a REJECTED push", async () => {
    const { git } = makeFakeGit((args) => {
      if (args[0] === "rev-parse") return { stdout: "aaaa\n" };
      return { ok: false, stderr: "boom" };
    });
    const res = await pushWipRef("/repo", "/wt", 7, git);
    expect(res.ok).toBe(false);
    expect(res.stderr).toBe("boom");
  });

  it("does NOT advance the local mirror ref when the push is refused", async () => {
    const { git, calls } = makeFakeGit((args) => {
      if (args[0] === "rev-parse") return { stdout: "aaaa\n" };
      return { ok: false, stderr: "stale info" };
    });
    await pushWipRef("/repo", "/wt", 7, git);
    // Advancing it anyway would make the NEXT push lease against a value origin
    // never held — a lie about what this host observed.
    expect(callWith(calls, "update-ref")).toBeUndefined();
  });

  it("advances the local mirror ref to the pushed sha once the push lands", async () => {
    const { git, calls } = makeFakeGit((args) =>
      args[0] === "rev-parse" ? { stdout: "bbbb\n" } : {},
    );
    await pushWipRef("/repo", "/wt", 7, git);
    expect(callWith(calls, "update-ref")?.args).toEqual([
      "update-ref",
      "refs/sandcastle/wip/issue-7",
      "bbbb",
    ]);
  });

  it("still pushes (leasing against absent) when the mirror ref does not resolve", async () => {
    const { git, calls } = makeFakeGit(() => ({ ok: true, stdout: "" }));
    const res = await pushWipRef("/repo", "/wt", 7, git);
    expect(res.ok).toBe(true);
    expect(callWith(calls, "push")?.args).toContain(
      "--force-with-lease=refs/sandcastle/wip/issue-7:",
    );
  });
});

/**
 * REAL-GIT tests for {@link pushWipRef} against a REAL local bare origin with
 * real clones acting as separate hosts (offline, real git semantics — never the
 * real network). Every assertion reads the ref's SHA off the bare ORIGIN via
 * `ls-remote`, NEVER a recorded mock call — the mock-level tests above could
 * (and historically did) stay green while origin silently kept stale work.
 *
 * Mirrors the harness in checkpoint-resume-e2e.test.ts (helpers copied locally
 * so the suites stay independent).
 */
describe("pushWipRef (real bare origin + real clones)", () => {
  const gitRunner = makeExecFileGitRunner();
  let tmp: string;
  let remote: string;

  /** Run git synchronously for TEST SETUP/ASSERTIONS (not production code). */
  function g(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  /** ls-remote a single ref; returns the SHA it points at, or "" when absent. */
  function lsRemote(cwd: string, ref: string, rem = "origin"): string {
    const out = g(cwd, "ls-remote", rem, ref);
    const first = out.split("\n").find((l) => l.trim().length > 0);
    return first ? first.split(/\s+/)[0] : "";
  }

  /** Clone the bare origin into a fresh host directory with a git identity. */
  function makeHost(name: string): string {
    const repo = path.join(tmp, name);
    g(tmp, "clone", remote, repo);
    g(repo, "config", "user.email", `${name}@t.test`);
    g(repo, "config", "user.name", name);
    return repo;
  }

  /** Commit a distinctive file in `repo`, returning the new HEAD sha. */
  function commitWork(repo: string, content: string): string {
    writeFileSync(path.join(repo, "PARTIAL_WORK.txt"), content);
    g(repo, "add", "-A");
    g(repo, "commit", "-m", `wip ${content}`);
    return g(repo, "rev-parse", "HEAD");
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-wip-push-"));
    remote = path.join(tmp, "remote.git");
    g(tmp, "init", "--bare", remote);
    const seed = path.join(tmp, "seed");
    g(tmp, "clone", remote, seed);
    g(seed, "config", "user.email", "seed@t.test");
    g(seed, "config", "user.name", "seed");
    writeFileSync(path.join(seed, "base.txt"), "base content\n");
    g(seed, "add", "base.txt");
    g(seed, "commit", "-m", "base");
    g(seed, "branch", "-M", "main");
    g(seed, "push", "-u", "origin", "main");
    rmSync(seed, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("first push CREATES the WIP ref on origin", async () => {
    const host = makeHost("host-a");
    const sha = commitWork(host, "first");

    const res = await pushWipRef(host, host, 7, gitRunner);

    expect(res.ok).toBe(true);
    expect(lsRemote(host, wipRef(7))).toBe(sha);
  });

  /**
   * THE DATA-LOSS REGRESSION (ADR 0021 zero-loss checkpoint/resume).
   *
   * stop --now → resume → stop --now again. Under the old bare
   * `--force-with-lease` the SECOND push was rejected ("stale info") because
   * the wip namespace has no remote-tracking ref, so origin kept the FIRST
   * snapshot and the newer work never left the host. This asserts origin holds
   * the NEW sha.
   */
  it("re-push by the SAME host ADVANCES the WIP ref on origin (no silent work loss)", async () => {
    const host = makeHost("host-a");
    const first = commitWork(host, "first");
    const push1 = await pushWipRef(host, host, 7, gitRunner);
    expect(push1.ok).toBe(true);
    expect(lsRemote(host, wipRef(7))).toBe(first);

    // Work advances, and the host is stopped again.
    const second = commitWork(host, "second");
    expect(second).not.toBe(first);
    const push2 = await pushWipRef(host, host, 7, gitRunner);

    expect(push2.ok).toBe(true);
    expect(lsRemote(host, wipRef(7))).toBe(second);
  });

  it("REFUSES to clobber a WIP ref value this host never observed (peer's work survives)", async () => {
    const peer = makeHost("peer");
    const peerSha = commitWork(peer, "peer work");
    g(peer, "push", "origin", `${peerSha}:${wipRef(7)}`);

    // host-a has never pushed/observed this ref: its lease expects "absent".
    const host = makeHost("host-a");
    const mySha = commitWork(host, "my work");
    const res = await pushWipRef(host, host, 7, gitRunner);

    expect(res.ok).toBe(false);
    expect(lsRemote(host, wipRef(7))).toBe(peerSha);
    expect(lsRemote(host, wipRef(7))).not.toBe(mySha);
  });

  it("REFUSES when a peer overwrote the ref after this host's own push", async () => {
    const host = makeHost("host-a");
    const mine = commitWork(host, "mine");
    expect((await pushWipRef(host, host, 7, gitRunner)).ok).toBe(true);

    // A peer reclaims the expired lease and overwrites the WIP ref.
    const peer = makeHost("peer");
    const peerSha = commitWork(peer, "peer reclaimed");
    g(peer, "push", "--force", "origin", `${peerSha}:${wipRef(7)}`);

    const advanced = commitWork(host, "mine advanced");
    const res = await pushWipRef(host, host, 7, gitRunner);

    expect(res.ok).toBe(false);
    expect(lsRemote(host, wipRef(7))).toBe(peerSha);
    expect(lsRemote(host, wipRef(7))).not.toBe(advanced);
  });
});

describe("wipRefExists", () => {
  it("is true when ls-remote returns a non-empty line", async () => {
    const { git } = makeFakeGit(() => ({
      stdout:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/sandcastle/wip/issue-7\n",
    }));
    expect(await wipRefExists("/repo", 7, git)).toBe(true);
  });

  it("is false when ls-remote is empty", async () => {
    const { git } = makeFakeGit(() => ({ stdout: "" }));
    expect(await wipRefExists("/repo", 7, git)).toBe(false);
  });

  it("queries the WIP ref via ls-remote", async () => {
    const { git, calls } = makeFakeGit(() => ({ stdout: "" }));
    await wipRefExists("/repo", 7, git);
    const ls = callWith(calls, "ls-remote");
    expect(ls?.args).toEqual([
      "ls-remote",
      "origin",
      "refs/sandcastle/wip/issue-7",
    ]);
  });
});

describe("deleteWipRef", () => {
  it("pushes the delete refspec :refs/sandcastle/wip/issue-<N>", async () => {
    const { git, calls } = makeFakeGit();
    const res = await deleteWipRef("/repo", 7, git);
    const push = callWith(calls, "push");
    expect(push?.args).toContain(":refs/sandcastle/wip/issue-7");
    expect(push?.args).toContain("origin");
    expect(res.ok).toBe(true);
  });

  it("is best-effort: returns the GitRunResult on ok=false, no throw", async () => {
    const { git } = makeFakeGit(() => ({ ok: false, stderr: "no such ref" }));
    const res = await deleteWipRef("/repo", 7, git);
    expect(res.ok).toBe(false);
  });
});

describe("listWipRefIssues", () => {
  it("parses issue numbers from ls-remote wip lines", async () => {
    const { git } = makeFakeGit(() => ({
      stdout:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/sandcastle/wip/issue-7\n" +
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/sandcastle/wip/issue-42\n",
    }));
    expect(await listWipRefIssues("/repo", git)).toEqual([7, 42]);
  });

  it("queries the wip namespace glob via ls-remote", async () => {
    const { git, calls } = makeFakeGit(() => ({ stdout: "" }));
    await listWipRefIssues("/repo", git);
    const ls = callWith(calls, "ls-remote");
    expect(ls?.args).toEqual([
      "ls-remote",
      "origin",
      "refs/sandcastle/wip/*",
    ]);
  });

  it("ignores non-issue-shaped and malformed lines", async () => {
    const { git } = makeFakeGit(() => ({
      stdout:
        "cccccccccccccccccccccccccccccccccccccccc\trefs/sandcastle/wip/issue-3\n" +
        "dddddddddddddddddddddddddddddddddddddddd\trefs/sandcastle/status/host-a\n" +
        "garbage line with no ref\n",
    }));
    expect(await listWipRefIssues("/repo", git)).toEqual([3]);
  });

  it("returns [] on a failed ls-remote (never over-prunes)", async () => {
    const { git } = makeFakeGit(() => ({ ok: false, stderr: "network down" }));
    expect(await listWipRefIssues("/repo", git)).toEqual([]);
  });
});
