/**
 * Branch checkpoint git primitives (ADR 0021) — unit tests.
 *
 * Exercises the pure, DI checkpoint helpers against a fake {@link GitRunner}
 * that records every invocation and returns canned {@link GitRunResult}s — no
 * child_process, no real git. Mirrors the seam proven in issue-lease.ts.
 */
import { describe, it, expect } from "vitest";
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
  it("force-with-lease pushes HEAD to the WIP ref", async () => {
    const { git, calls } = makeFakeGit();
    await pushWipRef("/repo", "/wt", 7, git);
    const push = callWith(calls, "push");
    expect(push).toBeDefined();
    expect(push?.args).toContain("--force-with-lease");
    expect(push?.args).toContain("HEAD:refs/sandcastle/wip/issue-7");
    expect(push?.args).toContain("origin");
  });

  it("honors a custom remote", async () => {
    const { git, calls } = makeFakeGit();
    await pushWipRef("/repo", "/wt", 7, git, "backup");
    expect(callWith(calls, "push")?.args).toContain("backup");
  });

  it("returns the GitRunResult without throwing on ok=false", async () => {
    const { git } = makeFakeGit(() => ({ ok: false, stderr: "boom" }));
    const res = await pushWipRef("/repo", "/wt", 7, git);
    expect(res.ok).toBe(false);
    expect(res.stderr).toBe("boom");
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
