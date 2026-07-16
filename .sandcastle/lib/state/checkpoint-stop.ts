/**
 * POST-KILL checkpoint (ADR 0021 — checkpoint/stop/resume, decisions #1 & #4).
 *
 * This is the AFTER-the-fact half of stop/resume: the loop process is already
 * DEAD (SIGKILL), so nothing in-process can commit-on-stop. What survives is the
 * set of per-issue worktrees still on disk (`agent/issue-<N>` branches). To let
 * another host RESUME each of them, we must persist their work and free their
 * leases so a peer is allowed to pick them up:
 *
 *   1. commit any dirty disk state as a WIP commit (reusing
 *      {@link commitWorktreeCheckpoint});
 *   2. decide whether there is anything worth saving — the worktree was dirty
 *      (a commit was just made) OR its HEAD is already ahead of the integration
 *      branch (committed-but-unpushed work);
 *   3. if so, push HEAD to the issue's WIP ref ({@link pushWipRef}) and RELEASE
 *      the lease by deleting `refs/locks/issue-<N>` on the remote — the exact
 *      release the dead loop never got to do;
 *   4. a clean, not-ahead worktree has nothing to save: leave its lease and WIP
 *      ref untouched.
 *
 * Every issue is independent: one bad worktree records an `error` and the sweep
 * CONTINUES to the rest, never abandoning healthy work. Like the rest of the
 * state layer this touches git ONLY through an injected {@link GitRunner} (the
 * seam issue-lease.ts defines), so the whole module is unit-testable against a
 * fake runner with no real git; the thin `../scripts/checkpoint-stop.mts` runner
 * supplies the real one, mirroring the launch.ts / launch.mts split.
 */
import type { GitRunner, GitRunResult } from "./issue-lease.js";
import {
  wipRef,
  commitWorktreeCheckpoint,
  pushWipRef,
  issueFromBranch,
} from "./branch-checkpoint.js";

/** One in-flight per-issue worktree still on disk after the loop was killed. */
export interface InflightWorktree {
  readonly issue: number;
  readonly branch: string;
  readonly path: string;
}

/** Ref name a given issue's lease lives at (mirrors issue-lease.ts lockRef). */
function lockRef(issue: number): string {
  return `refs/locks/issue-${issue}`;
}

/**
 * Parse `git worktree list --porcelain` and keep only the worktrees whose
 * checked-out branch is issue-shaped (`agent/issue-<N>`), dropping the main
 * worktree and any run/integration branch. The porcelain format is
 * newline-delimited attribute lines with blank lines between worktrees; the
 * `branch` line carries a full ref (`refs/heads/agent/issue-7`) which we reduce
 * to the short name before {@link issueFromBranch}.
 */
export async function listInflightIssueWorktrees(
  git: GitRunner,
  repoRoot: string,
): Promise<InflightWorktree[]> {
  const res = await git(repoRoot, "worktree", "list", "--porcelain");
  const out: InflightWorktree[] = [];
  let path: string | undefined;
  let branch: string | undefined;

  const flush = (): void => {
    if (path && branch) {
      const issue = issueFromBranch(branch);
      if (issue !== null) out.push({ issue, branch, path });
    }
    path = undefined;
    branch = undefined;
  };

  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return out;
}

/** Per-issue outcome of a post-kill checkpoint sweep. */
export interface CheckpointStopResult {
  readonly issue: number;
  readonly outcome: "checkpointed" | "nothing-to-save" | "error";
  /** The WIP ref the work was saved to (only on `checkpointed`). */
  readonly wipRef?: string;
  /** Human-readable failure reason (only on `error`). */
  readonly detail?: string;
}

/** Options for {@link checkpointStop}. */
export interface CheckpointStopOpts {
  readonly repoRoot: string;
  readonly hostId: string;
  /** Branch in-flight commits are measured "ahead" of (the run/integration ref). */
  readonly integrationBranch: string;
  readonly remote?: string;
}

/**
 * Count of commits in `<integrationBranch>..HEAD` inside the worktree — how many
 * commits the worktree HEAD has that the integration branch does not. `> 0`
 * means there is committed-but-unpushed work worth saving even when the tree is
 * clean. A failed rev-list (e.g. an unknown integration ref) reports 0 so the
 * caller falls back to the dirty signal alone rather than over-saving.
 */
async function commitsAhead(
  wtPath: string,
  integrationBranch: string,
  git: GitRunner,
): Promise<number> {
  const res = await git(
    wtPath,
    "rev-list",
    `${integrationBranch}..HEAD`,
    "--count",
  );
  if (!res.ok) return 0;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Checkpoint every in-flight worktree left behind by a killed loop, then release
 * each saved issue's lease. See the module header for the per-issue contract.
 * Never throws for a single bad worktree — that issue is recorded as `error` and
 * the sweep continues. Returns one {@link CheckpointStopResult} per worktree, in
 * discovery order.
 */
export async function checkpointStop(
  git: GitRunner,
  opts: CheckpointStopOpts,
): Promise<CheckpointStopResult[]> {
  const remote = opts.remote ?? "origin";
  const worktrees = await listInflightIssueWorktrees(git, opts.repoRoot);
  const results: CheckpointStopResult[] = [];

  for (const wt of worktrees) {
    try {
      // 1. commit any dirty disk state (no-op + false when clean).
      const committed = await commitWorktreeCheckpoint(
        wt.path,
        wt.issue,
        opts.hostId,
        git,
      );

      // 2. is there anything worth saving? committed dirt OR HEAD ahead of the
      //    integration branch. Short-circuit the rev-list when we just committed.
      const hasWork =
        committed ||
        (await commitsAhead(wt.path, opts.integrationBranch, git)) > 0;

      if (!hasWork) {
        results.push({ issue: wt.issue, outcome: "nothing-to-save" });
        continue;
      }

      // 3a. push HEAD to the WIP ref. A push rejection is a per-issue error; we
      //     do NOT release the lease when the work failed to persist.
      const push = await pushWipRef(opts.repoRoot, wt.path, wt.issue, git, remote);
      if (!push.ok) {
        results.push({
          issue: wt.issue,
          outcome: "error",
          detail: push.stderr.trim() || "wip push failed",
        });
        continue;
      }

      // 3b. release the lease so a peer may reclaim the issue: delete
      //     refs/locks/issue-<N> on the remote (empty-source delete refspec).
      const release = await releaseLeaseRef(opts.repoRoot, wt.issue, git, remote);
      if (!release.ok) {
        results.push({
          issue: wt.issue,
          outcome: "error",
          detail: release.stderr.trim() || "lease release failed",
        });
        continue;
      }

      results.push({
        issue: wt.issue,
        outcome: "checkpointed",
        wipRef: wipRef(wt.issue),
      });
    } catch (err) {
      results.push({
        issue: wt.issue,
        outcome: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Delete the issue's lease ref on the remote (`git push <remote>
 * :refs/locks/issue-<N>`) — the fast release a live loop does on ship, done here
 * on behalf of the dead one. Returns the raw {@link GitRunResult}; the caller
 * decides how to treat a failure.
 */
async function releaseLeaseRef(
  repoRoot: string,
  issue: number,
  git: GitRunner,
  remote: string,
): Promise<GitRunResult> {
  return git(repoRoot, "push", remote, `:${lockRef(issue)}`);
}

/**
 * Render a checkpoint-stop sweep for the console: one line per issue plus a
 * one-line tally (`2 checkpointed, 1 nothing-to-save`). A stable, greppable
 * summary for the thin runner and for operators reading a stop log.
 */
export function formatCheckpointStop(results: CheckpointStopResult[]): string {
  const lines = results.map((r) => {
    switch (r.outcome) {
      case "checkpointed":
        return `  #${r.issue}  checkpointed → ${r.wipRef}`;
      case "nothing-to-save":
        return `  #${r.issue}  nothing-to-save`;
      case "error":
        return `  #${r.issue}  error: ${r.detail ?? "(no detail)"}`;
    }
  });

  const counts = { checkpointed: 0, "nothing-to-save": 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  const summary = [
    `${counts.checkpointed} checkpointed`,
    `${counts["nothing-to-save"]} nothing-to-save`,
    `${counts.error} error`,
  ].join(", ");

  return [...lines, summary].join("\n");
}
