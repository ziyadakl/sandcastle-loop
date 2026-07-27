/**
 * Post-kill checkpoint (ADR 0021 §1 commit-on-stop / §4 lease release) — unit
 * tests. Drives the pure, DI checkpoint-stop logic against a fake
 * {@link GitRunner} that records every invocation and returns canned
 * {@link GitRunResult}s — no child_process, no real git. Mirrors the seam
 * proven in issue-lease.ts / branch-checkpoint.ts.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  GitRunner,
  GitRunResult,
} from "../.sandcastle/lib/state/issue-lease.js";
import {
  listInflightIssueWorktrees,
  checkpointStop,
  formatCheckpointStop,
  type CheckpointStopResult,
} from "../.sandcastle/lib/state/checkpoint-stop.js";
import { STATUS_SCHEMA_VERSION } from "../.sandcastle/lib/status/schema.js";

type Call = { cwd: string; args: string[] };

/**
 * Build a fake {@link GitRunner} recording each call, returning a canned result
 * computed from the argv. Defaults to `{ ok: true, stdout: "" }`.
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

/** Every call whose argv contains a token including `needle`. */
function callsMatching(calls: Call[], needle: string): Call[] {
  return calls.filter((c) => c.args.some((a) => a.includes(needle)));
}

const PORCELAIN = [
  "worktree /repo",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /repo/.sandcastle/wt/issue-7",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/agent/issue-7",
  "",
  "worktree /repo/.sandcastle/wt/issue-8",
  "HEAD 3333333333333333333333333333333333333333",
  "branch refs/heads/agent/issue-8",
  "",
  "worktree /repo/.sandcastle/wt/feature",
  "HEAD 4444444444444444444444444444444444444444",
  "branch refs/heads/sandcastle/theme-20260716",
  "",
].join("\n");

describe("listInflightIssueWorktrees", () => {
  it("keeps only agent/issue-<N> worktrees, ignoring main + non-issue branches", async () => {
    const { git, calls } = makeFakeGit(() => ({ stdout: PORCELAIN }));
    const found = await listInflightIssueWorktrees(git, "/repo");
    expect(found).toEqual([
      { issue: 7, branch: "agent/issue-7", path: "/repo/.sandcastle/wt/issue-7" },
      { issue: 8, branch: "agent/issue-8", path: "/repo/.sandcastle/wt/issue-8" },
    ]);
    // it asks git for the porcelain worktree list at the repo root
    const wt = calls.find((c) => c.args.includes("worktree"));
    expect(wt?.args).toEqual(["worktree", "list", "--porcelain"]);
    expect(wt?.cwd).toBe("/repo");
  });

  it("returns [] when there are no issue worktrees", async () => {
    const { git } = makeFakeGit(() => ({
      stdout: [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
      ].join("\n"),
    }));
    expect(await listInflightIssueWorktrees(git, "/repo")).toEqual([]);
  });
});

/**
 * Responder for a checkpointStop run. `worktree list` returns the given
 * porcelain; per-worktree `status`/`rev-list` are keyed by the issue path so a
 * dirty/clean/ahead mix can be modeled; `push` outcomes are keyed by refspec.
 */
function stopResponder(opts: {
  porcelain: string;
  dirty?: number[]; // issues whose status --porcelain is non-empty
  ahead?: Record<number, number>; // issue -> rev-list count
  pushFail?: (args: string[]) => boolean;
}): (args: string[]) => Partial<GitRunResult> {
  const dirty = new Set(opts.dirty ?? []);
  return (args) => {
    if (args.includes("worktree") && args.includes("list")) {
      return { stdout: opts.porcelain };
    }
    if (args[0] === "status") {
      // find which issue path this ran against via the -C flag if present; but
      // status runs with cwd=path (no -C), so we cannot see the path in argv.
      // The test wires dirtiness through a per-issue git instead (see below).
      return {};
    }
    if (opts.pushFail && args.includes("push") && opts.pushFail(args)) {
      return { ok: false, stderr: "push rejected" };
    }
    return {};
  };
}

describe("checkpointStop", () => {
  it("dirty worktree → committed, WIP-pushed to the right ref, lease released, checkpointed", async () => {
    const porcelain = [
      "worktree /repo/.sandcastle/wt/issue-7",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/agent/issue-7",
      "",
    ].join("\n");
    const { git, calls } = makeFakeGit((args) => {
      if (args.includes("worktree") && args.includes("list")) {
        return { stdout: porcelain };
      }
      if (args[0] === "status") return { stdout: " M src/foo.ts\n" }; // dirty
      return {};
    });

    const results = await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      // These cases exercise the per-issue sweep only — no staging backup.
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    expect(results).toEqual<CheckpointStopResult[]>([
      {
        issue: 7,
        outcome: "checkpointed",
        wipRef: "refs/sandcastle/wip/issue-7",
      },
    ]);

    // committed the dirt
    expect(callsMatching(calls, "commit").length).toBe(1);
    // pushed HEAD to the WIP ref
    const wipPush = calls.find((c) =>
      c.args.includes("HEAD:refs/sandcastle/wip/issue-7"),
    );
    expect(wipPush).toBeDefined();
    // released the lease with the exact delete refspec
    const leaseDel = calls.find((c) =>
      c.args.includes(":refs/locks/issue-7"),
    );
    expect(leaseDel).toBeDefined();
    expect(leaseDel?.args).toContain("origin");
  });

  it("clean worktree ahead of integration → pushed + released, checkpointed, NO new commit", async () => {
    const porcelain = [
      "worktree /repo/.sandcastle/wt/issue-9",
      "HEAD 5555555555555555555555555555555555555555",
      "branch refs/heads/agent/issue-9",
      "",
    ].join("\n");
    const { git, calls } = makeFakeGit((args) => {
      if (args.includes("worktree") && args.includes("list")) {
        return { stdout: porcelain };
      }
      if (args[0] === "status") return { stdout: "" }; // clean
      if (args[0] === "rev-list") return { stdout: "2\n" }; // 2 commits ahead
      return {};
    });

    const results = await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      // These cases exercise the per-issue sweep only — no staging backup.
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    expect(results).toEqual<CheckpointStopResult[]>([
      {
        issue: 9,
        outcome: "checkpointed",
        wipRef: "refs/sandcastle/wip/issue-9",
      },
    ]);
    // clean → no commit
    expect(callsMatching(calls, "commit").length).toBe(0);
    // but it did push the WIP + release the lease
    expect(
      calls.some((c) => c.args.includes("HEAD:refs/sandcastle/wip/issue-9")),
    ).toBe(true);
    expect(
      calls.some((c) => c.args.includes(":refs/locks/issue-9")),
    ).toBe(true);
    // rev-list compared integration..HEAD
    const revList = calls.find((c) => c.args[0] === "rev-list");
    expect(revList?.args).toEqual([
      "rev-list",
      "sandcastle/theme..HEAD",
      "--count",
    ]);
  });

  it("clean worktree NOT ahead → nothing-to-save, NO push and NO lease delete", async () => {
    const porcelain = [
      "worktree /repo/.sandcastle/wt/issue-3",
      "HEAD 6666666666666666666666666666666666666666",
      "branch refs/heads/agent/issue-3",
      "",
    ].join("\n");
    const { git, calls } = makeFakeGit((args) => {
      if (args.includes("worktree") && args.includes("list")) {
        return { stdout: porcelain };
      }
      if (args[0] === "status") return { stdout: "" }; // clean
      if (args[0] === "rev-list") return { stdout: "0\n" }; // not ahead
      return {};
    });

    const results = await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      // These cases exercise the per-issue sweep only — no staging backup.
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    expect(results).toEqual<CheckpointStopResult[]>([
      { issue: 3, outcome: "nothing-to-save" },
    ]);
    expect(callsMatching(calls, "push")).toEqual([]);
    expect(callsMatching(calls, ":refs/locks/issue-3")).toEqual([]);
  });

  it("a WIP push failure on one issue → that issue errors, a healthy issue still checkpoints", async () => {
    const porcelain = [
      "worktree /repo/.sandcastle/wt/issue-7",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/agent/issue-7",
      "",
      "worktree /repo/.sandcastle/wt/issue-8",
      "HEAD 3333333333333333333333333333333333333333",
      "branch refs/heads/agent/issue-8",
      "",
    ].join("\n");
    const { git, calls } = makeFakeGit((args) => {
      if (args.includes("worktree") && args.includes("list")) {
        return { stdout: porcelain };
      }
      if (args[0] === "status") return { stdout: " M x\n" }; // both dirty
      // fail ONLY the WIP push for issue-7
      if (
        args.includes("push") &&
        args.includes("HEAD:refs/sandcastle/wip/issue-7")
      ) {
        return { ok: false, stderr: "push rejected" };
      }
      return {};
    });

    const results = await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      // These cases exercise the per-issue sweep only — no staging backup.
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    const byIssue = new Map(results.map((r) => [r.issue, r]));
    expect(byIssue.get(7)?.outcome).toBe("error");
    expect(byIssue.get(8)?.outcome).toBe("checkpointed");

    // issue-7's lease was NOT released (push failed before release)
    expect(
      calls.some((c) => c.args.includes(":refs/locks/issue-7")),
    ).toBe(false);
    // issue-8 fully checkpointed: pushed + released
    expect(
      calls.some((c) => c.args.includes("HEAD:refs/sandcastle/wip/issue-8")),
    ).toBe(true);
    expect(
      calls.some((c) => c.args.includes(":refs/locks/issue-8")),
    ).toBe(true);
  });

  it("lease-delete refspec is exactly :refs/locks/issue-<N> and wip push targets refs/sandcastle/wip/issue-<N>", async () => {
    const porcelain = [
      "worktree /repo/.sandcastle/wt/issue-42",
      "HEAD 7777777777777777777777777777777777777777",
      "branch refs/heads/agent/issue-42",
      "",
    ].join("\n");
    const { git, calls } = makeFakeGit((args) => {
      if (args.includes("worktree") && args.includes("list")) {
        return { stdout: porcelain };
      }
      if (args[0] === "status") return { stdout: " M x\n" };
      return {};
    });

    await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      remote: "origin",
      stagingBranch: null,
      syncEnabled: false,
      // `--now`'s own-host leases — explicit always-permit (the former default).
      canReleaseLease: async () => true,
    });

    const leaseDel = calls.find((c) =>
      c.args.some((a) => a.startsWith(":refs/locks/")),
    );
    expect(leaseDel?.args).toEqual([
      "push",
      "origin",
      ":refs/locks/issue-42",
    ]);
    const wipPush = calls.find((c) =>
      c.args.some((a) => a.startsWith("HEAD:refs/sandcastle/wip/")),
    );
    expect(wipPush?.args).toContain("HEAD:refs/sandcastle/wip/issue-42");
  });
});

describe("checkpointStop — canReleaseLease guard (DEFECT 1 / launch-time reaper)", () => {
  const dirtyPorcelain = [
    "worktree /repo/.sandcastle/wt/issue-5",
    "HEAD 8888888888888888888888888888888888888888",
    "branch refs/heads/agent/issue-5",
    "",
  ].join("\n");

  /** Fake git for a single DIRTY issue-5 worktree (always something to save). */
  function dirtyGit(): { git: GitRunner; calls: Call[] } {
    return makeFakeGit((args) => {
      if (args.includes("worktree") && args.includes("list")) {
        return { stdout: dirtyPorcelain };
      }
      if (args[0] === "status") return { stdout: " M src/x.ts\n" };
      return {};
    });
  }

  it("guard returning FALSE still pushes the WIP ref but does NOT delete the lease (peer holds it live)", async () => {
    const { git, calls } = dirtyGit();
    const seen: number[] = [];

    const results = await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      stagingBranch: null,
      syncEnabled: false,
      canReleaseLease: async (issue) => {
        seen.push(issue);
        return false; // a live peer lease — must NOT be yanked
      },
    });

    // The work was still RESCUED: committed + pushed to the WIP ref.
    expect(callsMatching(calls, "commit").length).toBe(1);
    expect(
      calls.some((c) => c.args.includes("HEAD:refs/sandcastle/wip/issue-5")),
    ).toBe(true);
    // But the lease delete was SKIPPED entirely.
    expect(calls.some((c) => c.args.includes(":refs/locks/issue-5"))).toBe(false);
    // The guard was consulted for exactly this issue.
    expect(seen).toEqual([5]);
    // Outcome is still checkpointed — the WIP is safe, only the lease stayed put.
    expect(results).toEqual<CheckpointStopResult[]>([
      { issue: 5, outcome: "checkpointed", wipRef: "refs/sandcastle/wip/issue-5" },
    ]);
  });

  it("guard returning TRUE releases the lease (safe-to-reclaim path)", async () => {
    const { git, calls } = dirtyGit();

    const results = await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      stagingBranch: null,
      syncEnabled: false,
      canReleaseLease: async () => true,
    });

    expect(
      calls.some((c) => c.args.includes("HEAD:refs/sandcastle/wip/issue-5")),
    ).toBe(true);
    expect(calls.some((c) => c.args.includes(":refs/locks/issue-5"))).toBe(true);
    expect(results[0]?.outcome).toBe("checkpointed");
  });

  it("explicit always-permit guard reproduces the former UNCONDITIONAL delete (graceful --now unchanged)", async () => {
    const { git, calls } = dirtyGit();

    await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      stagingBranch: null,
      syncEnabled: false,
      // `canReleaseLease` is now REQUIRED (no delete-by-default fall-through).
      // The graceful `--now` stop reaps its OWN host's leases, so it passes an
      // explicit always-permit policy — byte-for-byte the old absent-guard delete.
      canReleaseLease: async () => true,
    });

    expect(calls.some((c) => c.args.includes(":refs/locks/issue-5"))).toBe(true);
  });
});

describe("checkpointStop — wipOriginPush mode (ADR 0021 launch-reaper inertness)", () => {
  const dirtyPorcelain = [
    "worktree /repo/.sandcastle/wt/issue-5",
    "HEAD 8888888888888888888888888888888888888888",
    "branch refs/heads/agent/issue-5",
    "",
  ].join("\n");

  /** Fake git for a single DIRTY issue-5 worktree (always something to save).
   *  `rev-parse ... HEAD` returns a concrete SHA so the LOCAL-capture path can
   *  resolve the worktree tip (a real worktree always has one). */
  function dirtyGit(): { git: GitRunner; calls: Call[] } {
    return makeFakeGit((args) => {
      if (args.includes("worktree") && args.includes("list")) {
        return { stdout: dirtyPorcelain };
      }
      if (args[0] === "status") return { stdout: " M src/x.ts\n" };
      if (args[0] === "rev-parse" && args.includes("HEAD")) {
        return { stdout: "cafebabecafebabecafebabecafebabecafebabe\n" };
      }
      return {};
    });
  }

  it("'when-sync' + sync OFF captures the WIP ref LOCALLY (update-ref) and pushes NOTHING to origin", async () => {
    const { git, calls } = dirtyGit();

    const results = await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      stagingBranch: null,
      syncEnabled: false,
      wipOriginPush: "when-sync",
      canReleaseLease: async () => true,
    });

    // Work is still rescued: outcome checkpointed at the canonical WIP ref.
    expect(results).toEqual<CheckpointStopResult[]>([
      { issue: 5, outcome: "checkpointed", wipRef: "refs/sandcastle/wip/issue-5" },
    ]);
    // The WIP ref was written LOCALLY via update-ref (no origin round-trip).
    expect(
      calls.some(
        (c) =>
          c.args[0] === "update-ref" &&
          c.args.includes("refs/sandcastle/wip/issue-5"),
      ),
    ).toBe(true);
    // NOTHING was pushed to origin on the WIP-push side (the point of this
    // assertion) — the WIP ref was captured locally via update-ref instead.
    expect(
      calls.some((c) => c.args.includes("HEAD:refs/sandcastle/wip/issue-5")),
    ).toBe(false);
  });

  it("'when-sync' + sync ON pushes the WIP ref to origin (peer recovery path)", async () => {
    const { git, calls } = dirtyGit();

    const results = await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      stagingBranch: null,
      syncEnabled: true,
      wipOriginPush: "when-sync",
      canReleaseLease: async () => true,
    });

    expect(results[0]?.outcome).toBe("checkpointed");
    // Sync ON ⇒ the WIP ref IS pushed to origin.
    expect(
      calls.some((c) => c.args.includes("HEAD:refs/sandcastle/wip/issue-5")),
    ).toBe(true);
  });

  it("DEFAULT (absent option) + sync OFF STILL pushes to origin — graceful --now unchanged", async () => {
    const { git, calls } = dirtyGit();

    await checkpointStop(git, {
      repoRoot: "/repo",
      hostId: "host-a",
      integrationBranch: "sandcastle/theme",
      stagingBranch: null,
      syncEnabled: false,
      // no wipOriginPush — the operator-invoked `--now` path.
      canReleaseLease: async () => true,
    });

    // Legacy behavior preserved: WIP pushed to origin even with sync off.
    expect(
      calls.some((c) => c.args.includes("HEAD:refs/sandcastle/wip/issue-5")),
    ).toBe(true);
  });
});

describe("checkpoint-stop.mts (post-kill runner) — status reconciliation", () => {
  it("writes state:'stopped' to status.json as its FINAL step, stopping the running lie", () => {
    // A hard kill leaves status.json saying `running` forever with no reconciler.
    // The --now runner must flip it to `stopped` after handling the git refs.
    const tmp = mkdtempSync(join(tmpdir(), "sc-checkpoint-"));
    execFileSync("git", ["init", "-q"], { cwd: tmp });
    execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "t"], { cwd: tmp });
    writeFileSync(join(tmp, "f.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: tmp });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: tmp });

    // Seed a status.json still claiming the loop is running (the lie).
    mkdirSync(join(tmp, ".sandcastle"), { recursive: true });
    const statusPath = join(tmp, ".sandcastle", "status.json");
    const runningStatus = {
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: "running",
      hostId: "host-a",
      runId: "run-x",
      run: {
        branch: "sandcastle/theme",
        repo: "r",
        startedAt: "2026-06-04T11:30:00.000Z",
        iterations: { current: 1, total: 5 },
        maxConcurrent: 1,
      },
      totals: { merged: 0, needsHuman: 0, requeued: 0, running: 0 },
      issues: [],
      history: [],
      updatedAt: "2026-06-04T11:31:00.000Z",
      pid: 999999,
    };
    writeFileSync(statusPath, `${JSON.stringify(runningStatus, null, 2)}\n`);

    const script = fileURLToPath(
      new URL("../.sandcastle/scripts/checkpoint-stop.mts", import.meta.url),
    );
    // Resolve the vendored tsx relative to this test file's own location
    // (not a hardcoded machine path) so this passes on any checkout — this
    // Mac, the VPS, or CI.
    const tsx = fileURLToPath(
      new URL("../node_modules/.bin/tsx", import.meta.url),
    );
    execFileSync(
      tsx,
      [script, "--repo-root", tmp, "--integration-branch", "master"],
      { cwd: tmp },
    );

    const after = JSON.parse(readFileSync(statusPath, "utf8"));
    expect(after.state).toBe("stopped");
  }, 30_000);
});

describe("formatCheckpointStop", () => {
  it("prints one line per issue plus a mix summary", () => {
    const out = formatCheckpointStop([
      { issue: 7, outcome: "checkpointed", wipRef: "refs/sandcastle/wip/issue-7" },
      { issue: 8, outcome: "checkpointed", wipRef: "refs/sandcastle/wip/issue-8" },
      { issue: 3, outcome: "nothing-to-save" },
    ]);
    expect(out).toContain("#7");
    expect(out).toContain("#8");
    expect(out).toContain("#3");
    expect(out).toContain("2 checkpointed");
    expect(out).toContain("1 nothing-to-save");
  });
});
