import { describe, it, expect } from "vitest";
import type {
  GitRunner,
  GitRunResult,
} from "../.sandcastle/lib/state/issue-lease.js";
import {
  issueFromBranch,
  reuseOrFresh,
  resolveReuseDecision,
} from "../.sandcastle/lib/state/branch-checkpoint.js";

type Call = { cwd: string; args: string[] };

/** Fake GitRunner recording every call; canned ls-remote result via responder. */
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

describe("issueFromBranch", () => {
  it("extracts the issue number from an agent/issue-<N> branch", () => {
    expect(issueFromBranch("agent/issue-42")).toBe(42);
  });

  it("returns null for a non-issue-shaped branch", () => {
    expect(issueFromBranch("sandcastle/nightly-20260716")).toBeNull();
    expect(issueFromBranch("main")).toBeNull();
    expect(issueFromBranch("agent/issue-")).toBeNull();
    expect(issueFromBranch("agent/issue-abc")).toBeNull();
  });
});

describe("reuseOrFresh", () => {
  const branch = "agent/issue-7";

  it("reuses only when sync is enabled AND a wip ref exists", () => {
    expect(reuseOrFresh({ syncEnabled: true, branch, wipExists: true })).toBe(
      "reuse",
    );
  });

  it("is fresh when sync is enabled but no wip ref exists", () => {
    expect(reuseOrFresh({ syncEnabled: true, branch, wipExists: false })).toBe(
      "fresh",
    );
  });

  it("is fresh when a wip ref exists but sync is disabled", () => {
    expect(reuseOrFresh({ syncEnabled: false, branch, wipExists: true })).toBe(
      "fresh",
    );
  });

  it("is fresh when sync is disabled and no wip ref exists", () => {
    expect(reuseOrFresh({ syncEnabled: false, branch, wipExists: false })).toBe(
      "fresh",
    );
  });

  it("is fresh for a non-issue-shaped branch even when sync on and wip claims to exist", () => {
    expect(
      reuseOrFresh({
        syncEnabled: true,
        branch: "sandcastle/nightly-20260716",
        wipExists: true,
      }),
    ).toBe("fresh");
  });
});

describe("resolveReuseDecision", () => {
  const branch = "agent/issue-9";

  it("(a) sync off → {reuse:false} and NEVER touches ls-remote (inert-when-off)", async () => {
    const { git, calls } = makeFakeGit(() => ({
      stdout: "sha\trefs/sandcastle/wip/issue-9\n",
    }));
    const r = await resolveReuseDecision({
      syncEnabled: false,
      branch,
      repoRoot: "/repo",
      git,
    });
    expect(r).toEqual({ reuse: false });
    // Load-bearing: flag-off must issue NO git at all (no ls-remote/origin).
    expect(calls).toHaveLength(0);
  });

  it("(b) non-issue branch → {reuse:false} and no ls-remote", async () => {
    const { git, calls } = makeFakeGit(() => ({
      stdout: "sha\trefs/sandcastle/wip/issue-9\n",
    }));
    const r = await resolveReuseDecision({
      syncEnabled: true,
      branch: "sandcastle/nightly-20260716",
      repoRoot: "/repo",
      git,
    });
    expect(r).toEqual({ reuse: false });
    expect(calls).toHaveLength(0);
  });

  it("(c) issue branch + WIP ref exists → {reuse:true, issue:N}", async () => {
    const { git, calls } = makeFakeGit(() => ({
      stdout: "sha\trefs/sandcastle/wip/issue-9\n",
    }));
    const r = await resolveReuseDecision({
      syncEnabled: true,
      branch,
      repoRoot: "/repo",
      git,
    });
    expect(r).toEqual({ reuse: true, issue: 9 });
    expect(calls.some((c) => c.args.includes("ls-remote"))).toBe(true);
  });

  it("(d) issue branch + no WIP ref → {reuse:false}", async () => {
    const { git } = makeFakeGit(() => ({ stdout: "" }));
    const r = await resolveReuseDecision({
      syncEnabled: true,
      branch,
      repoRoot: "/repo",
      git,
    });
    expect(r).toEqual({ reuse: false });
  });
});
