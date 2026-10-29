import { describe, expect, it } from "vitest";

import type { GitRunResult } from "./issue-lease.js";
import type { CheckpointStopOpts, CheckpointStopResult } from "./checkpoint-stop.js";
import { checkpointStop, formatCheckpointStop } from "./checkpoint-stop.js";

// ---------------------------------------------------------------------------
// The `--now` reap's LABEL release (the second half of "stopping releases the
// board"). The reap already deleted each in-flight issue's lease lock, but the
// ops dashboard reads GITHUB LABELS, not lease refs — so a reaped issue kept
// wearing `in-progress` and the board kept showing dead work as "being built
// now" until the next launch. Flipping it was a documented HAND step in the
// sandcastle-stop skill; these tests pin that it is now automatic.
//
// The module is deliberately pure: git ONLY through the injected GitRunner and
// GitHub ONLY through the injected `releaseLabel` seam, so everything below
// runs against fakes — no real repo, no real `gh`.
// ---------------------------------------------------------------------------

const OK: GitRunResult = { ok: true, stdout: "", stderr: "" };
const fail = (stderr: string): GitRunResult => ({ ok: false, stdout: "", stderr });

/** `git worktree list --porcelain` output for one `agent/issue-<N>` worktree. */
function porcelain(entries: { path: string; branch: string }[]): string {
  return entries
    .map((e) => `worktree ${e.path}\nHEAD abc123\nbranch refs/heads/${e.branch}\n`)
    .join("\n");
}

/**
 * A scripted fake git runner. Answers the handful of commands the sweep issues,
 * with per-command overrides so a test can make exactly one of them fail.
 * Records every invocation so a test can prove a command did (or did not) run.
 */
function makeGit(opts: {
  worktrees: { path: string; branch: string }[];
  /** `git status --porcelain` inside the worktree — non-empty means dirty. */
  dirty?: boolean;
  /** Make the WIP push fail with this stderr. */
  pushFails?: string;
} = { worktrees: [] }) {
  const calls: string[][] = [];
  const git = async (cwd: string, ...args: string[]): Promise<GitRunResult> => {
    calls.push([cwd, ...args]);
    const cmd = args.join(" ");
    if (cmd === "worktree list --porcelain") {
      return { ok: true, stdout: porcelain(opts.worktrees), stderr: "" };
    }
    if (cmd === "status --porcelain") {
      return { ok: true, stdout: opts.dirty ? " M src/a.ts\n" : "", stderr: "" };
    }
    if (args[0] === "rev-list") return { ok: true, stdout: "0\n", stderr: "" };
    if (args[0] === "rev-parse") return { ok: true, stdout: "deadbee\n", stderr: "" };
    if (args.includes("push") && args.some((a) => a.startsWith("--force-with-lease="))) {
      return opts.pushFails ? fail(opts.pushFails) : OK;
    }
    return OK;
  };
  return { git, calls };
}

/** Baseline opts: the `--now` reap's own shape, minus the label seam. */
function baseOpts(over: Partial<CheckpointStopOpts> = {}): CheckpointStopOpts {
  return {
    repoRoot: "/repo",
    hostId: "test-host",
    integrationBranch: "sandcastle/run",
    stagingBranch: null,
    syncEnabled: false,
    canReleaseLease: async () => true,
    ...over,
  };
}

describe("checkpointStop — in-progress label release (injected seam)", () => {
  it("makes NO label call at all when no seam is supplied (byte-for-byte the old behavior)", async () => {
    // The launch-time reaper in main.mts still calls it this way, and every
    // pre-seam caller must see the exact same results it always saw.
    const { git } = makeGit({
      worktrees: [{ path: "/wt/7", branch: "agent/issue-7" }],
      dirty: true,
    });
    const results = await checkpointStop(git, baseOpts());
    expect(results).toEqual<CheckpointStopResult[]>([
      { issue: 7, outcome: "checkpointed", wipRef: "refs/sandcastle/wip/issue-7" },
    ]);
    expect(results[0]!.label).toBeUndefined();
    // …and the rendered summary is unchanged too — no label column appears.
    expect(formatCheckpointStop(results)).toBe(
      "  #7  checkpointed → refs/sandcastle/wip/issue-7\n" +
        "1 checkpointed, 0 nothing-to-save, 0 error",
    );
  });

  it("releases the in-progress label for every checkpointed issue", async () => {
    // THE regression. Pre-fix this sweep saved the work, deleted the lease, and
    // left the label saying "being built now" — for hours, until a human ran
    // `gh issue edit` by hand.
    const released: number[] = [];
    const { git } = makeGit({
      worktrees: [
        { path: "/wt/7", branch: "agent/issue-7" },
        { path: "/wt/9", branch: "agent/issue-9" },
      ],
      dirty: true,
    });
    const results = await checkpointStop(
      git,
      baseOpts({
        releaseLabel: async (n) => {
          released.push(n);
          return "released";
        },
      }),
    );
    expect(released).toEqual([7, 9]);
    expect(results.map((r) => r.label)).toEqual(["released", "released"]);
    expect(formatCheckpointStop(results)).toContain(
      "label released → ready-for-agent",
    );
  });

  it("releases the label for a nothing-to-save worktree too — the label lies either way", async () => {
    // A clean, not-ahead worktree keeps its lease (module decision #4) but it is
    // still wearing `in-progress`, and there is no work to protect.
    const released: number[] = [];
    const { git } = makeGit({
      worktrees: [{ path: "/wt/4", branch: "agent/issue-4" }],
      dirty: false,
    });
    const results = await checkpointStop(
      git,
      baseOpts({
        releaseLabel: async (n) => {
          released.push(n);
          return "released";
        },
      }),
    );
    expect(results[0]!.outcome).toBe("nothing-to-save");
    expect(released).toEqual([4]);
    expect(results[0]!.label).toBe("released");
  });

  it("does NOT release the label when the work failed to persist", async () => {
    // Fail-closed, mirroring the lease: the WIP push failed, so the work exists
    // only on this box's disk. Handing the issue back for re-claim would invite
    // a peer to redo it. The label keeps saying "someone owns this".
    let called = false;
    const { git } = makeGit({
      worktrees: [{ path: "/wt/7", branch: "agent/issue-7" }],
      dirty: true,
      pushFails: "remote rejected",
    });
    const results = await checkpointStop(
      git,
      baseOpts({
        releaseLabel: async () => {
          called = true;
          return "released";
        },
      }),
    );
    expect(called).toBe(false);
    expect(results[0]!.outcome).toBe("error");
    expect(results[0]!.label).toBe("skipped");
    expect(formatCheckpointStop(results)).toContain("label LEFT in-progress");
  });

  it("reports a FAILED label flip per issue and in the tally instead of a clean checkpointed", async () => {
    // The whole point of surfacing it: an operator reading the stop log must be
    // able to see that the board is still lying, and go fix it.
    const { git } = makeGit({
      worktrees: [{ path: "/wt/7", branch: "agent/issue-7" }],
      dirty: true,
    });
    const results = await checkpointStop(
      git,
      baseOpts({
        releaseLabel: async () => {
          throw new Error("gh: HTTP 403");
        },
      }),
    );
    // The WIP rescue still succeeded — a dead `gh` must never cost us the work.
    expect(results[0]!.outcome).toBe("checkpointed");
    expect(results[0]!.label).toBe("failed");
    expect(results[0]!.labelDetail).toContain("HTTP 403");
    const rendered = formatCheckpointStop(results);
    expect(rendered).toContain("label release FAILED, still in-progress");
    expect(rendered).toContain("1 label-release FAILED");
  });

  it("a throwing label seam never aborts the sweep — later issues are still reaped", async () => {
    const seen: number[] = [];
    const { git } = makeGit({
      worktrees: [
        { path: "/wt/7", branch: "agent/issue-7" },
        { path: "/wt/9", branch: "agent/issue-9" },
      ],
      dirty: true,
    });
    const results = await checkpointStop(
      git,
      baseOpts({
        releaseLabel: async (n) => {
          seen.push(n);
          if (n === 7) throw new Error("boom");
          return "released";
        },
      }),
    );
    expect(seen).toEqual([7, 9]);
    expect(results.map((r) => r.label)).toEqual(["failed", "released"]);
    expect(results.every((r) => r.outcome === "checkpointed")).toBe(true);
  });

  it("releases the label only AFTER the work is saved and the lease is freed", async () => {
    // Ordering is the safety argument: if the label went first, a peer could
    // re-claim the issue while its WIP push was still in flight.
    const order: string[] = [];
    const git = async (cwd: string, ...args: string[]): Promise<GitRunResult> => {
      const cmd = args.join(" ");
      if (cmd === "worktree list --porcelain") {
        return {
          ok: true,
          stdout: porcelain([{ path: "/wt/7", branch: "agent/issue-7" }]),
          stderr: "",
        };
      }
      if (cmd === "status --porcelain") {
        return { ok: true, stdout: " M a.ts\n", stderr: "" };
      }
      if (args[0] === "rev-parse") return { ok: true, stdout: "deadbee\n", stderr: "" };
      if (args.some((a) => a.startsWith("--force-with-lease="))) {
        order.push("wip-push");
      }
      if (args[0] === "push" && args[2] === ":refs/locks/issue-7") {
        order.push("lease-delete");
      }
      return OK;
    };
    await checkpointStop(
      git,
      baseOpts({
        releaseLabel: async () => {
          order.push("label-release");
          return "released";
        },
      }),
    );
    expect(order).toEqual(["wip-push", "lease-delete", "label-release"]);
  });

  it("carries the seam's not-in-progress verdict through instead of claiming a release", async () => {
    // The safety valve for a LEFTOVER worktree: an issue that already shipped
    // leaves a clean, not-ahead `agent/issue-N` worktree behind, which is
    // indistinguishable here from a live one with nothing to save. The runner's
    // seam checks the real label set and says "not mine to flip"; this module
    // must report that honestly rather than logging a release that never
    // happened — and must never count it as a failure either.
    const { git } = makeGit({
      worktrees: [{ path: "/wt/4", branch: "agent/issue-4" }],
      dirty: false,
    });
    const results = await checkpointStop(
      git,
      baseOpts({ releaseLabel: async () => "not-in-progress" }),
    );
    expect(results[0]!.label).toBe("not-in-progress");
    const rendered = formatCheckpointStop(results);
    expect(rendered).toContain("label was not in-progress (nothing to release)");
    expect(rendered).not.toContain("label-release FAILED");
  });
});
