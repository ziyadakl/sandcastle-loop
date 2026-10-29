/**
 * POST-KILL checkpoint (checkpoint/stop/resume, decisions #1 & #4).
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
 *      release the dead loop never got to do. The release is UNCONDITIONAL by
 *      default (the graceful `--now` stop's leases are its own), but an optional
 *      `canReleaseLease` guard can veto the DELETE per issue so the launch-time
 *      reaper never yanks a lease a live peer re-claimed — the WIP push above
 *      still runs regardless, so the work is rescued either way;
 *   4. a clean, not-ahead worktree has nothing to save: leave its lease and WIP
 *      ref untouched;
 *   5. release the issue's `in-progress` GitHub label back to `ready-for-agent`
 *      — but only via the OPTIONAL injected {@link CheckpointStopOpts.releaseLabel}
 *      seam, and only for an issue whose work is safe (see that field). The
 *      lease is what the machines arbitrate on; the label is what the ops
 *      dashboard shows a human, and a stop that frees one but not the other
 *      leaves the board reporting dead work as "being built now".
 *
 * Every issue is independent: one bad worktree records an `error` and the sweep
 * CONTINUES to the rest, never abandoning healthy work. Like the rest of the
 * state layer this touches git ONLY through an injected {@link GitRunner} (the
 * seam issue-lease.ts defines) and GitHub ONLY through the `releaseLabel`
 * callback — never `gh` directly — so the whole module is unit-testable against
 * fakes with no real git and no real GitHub; the thin
 * `../scripts/checkpoint-stop.mts` runner supplies both real implementations,
 * mirroring the launch.ts / launch.mts split.
 */
import type { GitRunner, GitRunResult } from "./issue-lease.js";
import {
  wipRef,
  commitWorktreeCheckpoint,
  pushWipRef,
  captureWipRefLocal,
  issueFromBranch,
} from "./branch-checkpoint.js";
import { backupStrand, stagingCommitsAhead } from "./strand-backup.js";

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

/**
 * What happened to the issue's `in-progress` GitHub label during the sweep.
 * ABSENT (undefined) means the caller supplied no {@link CheckpointStopOpts.releaseLabel}
 * seam, so no label call was made at all — the module's behavior before the seam
 * existed, and what the launch-time reaper still gets.
 *
 *   - `released`        — flipped `in-progress` → `ready-for-agent`.
 *   - `not-in-progress` — the issue was not wearing `in-progress` at all, so
 *                         there was nothing to release. Usually a leftover
 *                         worktree from an issue that already shipped (see
 *                         `/sandcastle-clean`) — and the reason the seam reports
 *                         this rather than flipping blindly: `gh issue edit
 *                         --add-label ready-for-agent` on a SHIPPED ticket puts
 *                         it back in the queue and the next run rebuilds work
 *                         that is already on main.
 *   - `failed`          — the flip was attempted and threw; the label still lies.
 *   - `skipped`         — deliberately not attempted, because the work did NOT
 *                         persist (an `error` outcome). Re-opening such an issue
 *                         for re-claim would invite a peer to redo work whose WIP
 *                         push failed, so the label deliberately keeps saying
 *                         "someone owns this".
 */
export type CheckpointStopLabel =
  | "released"
  | "not-in-progress"
  | "failed"
  | "skipped";

/** Per-issue outcome of a post-kill checkpoint sweep. */
export interface CheckpointStopResult {
  readonly issue: number;
  readonly outcome: "checkpointed" | "nothing-to-save" | "error";
  /** The WIP ref the work was saved to (only on `checkpointed`). */
  readonly wipRef?: string;
  /** Human-readable failure reason (only on `error`). */
  readonly detail?: string;
  /** Fate of the `in-progress` label; `undefined` when no seam was supplied. */
  readonly label?: CheckpointStopLabel;
  /** Why the label flip failed (only on `label: "failed"`). */
  readonly labelDetail?: string;
}

/** Options for {@link checkpointStop}. */
export interface CheckpointStopOpts {
  readonly repoRoot: string;
  readonly hostId: string;
  /** Branch in-flight commits are measured "ahead" of (the run/integration ref). */
  readonly integrationBranch: string;
  readonly remote?: string;
  /**
   * WORKSTREAM 1 (1c): the staging branch whose tip is backed up when it is ahead
   * of `integrationBranch` — post-merge fixer commits that landed on staging but
   * were never promoted, which a graceful `--now` stop would otherwise lose.
   * `null` SKIPS the staging backup. Required and explicit: the CALLER states the
   * intent, so this module never owns the default branch name (that literal is the
   * loop's STAGING_BRANCH, resolved at the entry point).
   */
  readonly stagingBranch: string | null;
  /**
   * Whether cross-host sync is enabled — mirrors main.mts's
   * `crossHostSyncEnabled()`, threaded in rather than imported (main.mts is the
   * consumer of this lib; importing it back would be a cycle).
   *
   * The inertness contract: the strand backup is a NEW origin write, so it
   * is gated behind the existing cross-host opt-in — with the flag off a
   * single-host consumer pushes nothing new. When false the staging tip is still
   * pinned by a LOCAL strand ref, so nothing is lost; it just never leaves the box.
   */
  readonly syncEnabled: boolean;
  /**
   * DEFECT 1: REQUIRED per-issue policy consulted right before
   * the lease DELETE. Returns `true` when it is safe to release issue `n`'s
   * lease, `false` to LEAVE it in place. This is a required, EXPLICIT decision:
   * every caller must state who it may delete a lease for — there is no
   * delete-by-default fall-through (an absent guard once defaulted to release,
   * a fail-open footgun for any future caller that forgot the param). The
   * graceful `--now` stop passes an always-permit policy (`async () => true`):
   * its leases are its own host's, so deleting them is always correct. The
   * LAUNCH-TIME reaper (main.mts `checkpointInflight`) passes a guard that
   * refuses to yank a lease a PEER host currently holds LIVE: a crashed host's
   * lease can expire and be re-claimed by a peer before the crashed host
   * restarts, and deleting it here would strand the peer's active work.
   * CRITICAL: WIP capture ({@link pushWipRef}) ALWAYS runs first, before this
   * guard — we ALWAYS rescue the work; only the lease DELETE is gated, so a
   * refused release never leaves work unsaved.
   */
  readonly canReleaseLease: (issue: number) => Promise<boolean>;
  /**
   * DEFECT (inertness): where the per-issue WIP checkpoint is written.
   *
   *   - `"always"` (DEFAULT) — push HEAD to `refs/sandcastle/wip/issue-<N>` on the
   *     REMOTE unconditionally, as the sweep always has. This is the graceful
   *     `--now` stop's path: the operator opted into the origin write by invoking
   *     it, so it stays BYTE-FOR-BYTE unchanged.
   *   - `"when-sync"` — write the WIP ref LOCALLY always, and push it to origin
   *     ONLY when {@link syncEnabled}. The LAUNCH-TIME reaper (main.mts
   *     `checkpointInflight`) passes this: it runs at EVERY start, so a flag-off
   *     single-host consumer that crashed must NOT push WIP refs to its app's
   *     origin (a flag-off consumer pushes nothing new).
   *     Single-host crash recovery still works — the local WIP ref plus the
   *     surviving worktree are enough for a same-host resume; the origin push
   *     only matters for cross-host peer recovery, which IS the sync-ON case.
   *
   * This mirrors {@link "./strand-backup".backupStrand}'s proven contract (local
   * `update-ref` always; origin push gated on `syncEnabled`). It does NOT touch
   * the lease DELETE, which the {@link canReleaseLease} guard already gates (that
   * guard returns false when lease-mode is off, so it stays inert).
   */
  readonly wipOriginPush?: "always" | "when-sync";
  /**
   * OPTIONAL INJECTED SEAM: where a line about this sweep goes.
   *
   * Only one thing writes here today, and it is a thing nobody must miss: a
   * checkpoint REFUSED because a check-repair replay was in flight (issue
   * #1118). This process runs after `main.mts` has been killed, so it learns
   * that from a sentinel on disk rather than in memory, and the ticket's
   * committed work still goes to its WIP ref — only the "commit whatever is on
   * disk" step is withheld, because on disk at that moment is the code the
   * builder was HANDED and committing it records the deletion of the night.
   * Absent on a caller that has nowhere to put a line, which changes nothing
   * about the refusal itself.
   */
  readonly log?: (line: string) => void;
  /**
   * OPTIONAL INJECTED SEAM: release issue `n`'s `in-progress` GitHub label back
   * to `ready-for-agent`. Supplied by the thin `../scripts/checkpoint-stop.mts`
   * runner (which owns the `gh` shell-out) exactly the way the real
   * {@link GitRunner} is — this module stays PURE: git only through the injected
   * runner, GitHub only through this callback, so the whole sweep remains
   * unit-testable against fakes with neither a real repo nor a real `gh`.
   *
   * ABSENT ⇒ no label call is made and every {@link CheckpointStopResult.label}
   * stays `undefined`: byte-for-byte the behavior every caller had before the
   * seam existed (the launch-time reaper in main.mts deliberately keeps it —
   * that path's labels are handled by the loop's own startup reconciliation).
   *
   * WHY IT EXISTS: a SIGKILL'd loop cannot flip its own labels, so before this
   * the `--now` reap left every in-flight issue wearing `in-progress` and the
   * ops dashboard kept showing stopped work as "being built now" until the next
   * launch. It used to be a documented HAND step in the sandcastle-stop skill.
   *
   * Called ONCE per worktree, AFTER the WIP push and the lease release, and only
   * for issues whose work is safe (`checkpointed`) or which had nothing to save
   * (`nothing-to-save`) — never for an `error`, whose work did not persist. A
   * throw is captured per issue (`label: "failed"`) and never aborts the sweep.
   *
   * MUST report `"not-in-progress"` — never flip — for an issue that is not
   * actually wearing `in-progress`. A `--now` reap enumerates the `agent/issue-N`
   * WORKTREES left on disk, and a leftover worktree from an issue that already
   * shipped looks exactly like a live one that had nothing to save. Adding
   * `ready-for-agent` to a shipped ticket re-queues work that is already on main.
   */
  readonly releaseLabel?: (
    issue: number,
  ) => Promise<"released" | "not-in-progress">;
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

  /**
   * Run the injected label seam for one issue and describe what happened. No
   * seam ⇒ `{}`, so the result is byte-for-byte the pre-seam shape. A throw is
   * captured, never propagated: a dead `gh` must not cost us the WIP rescue we
   * already completed.
   */
  const releaseLabelFor = async (
    issue: number,
  ): Promise<Pick<CheckpointStopResult, "label" | "labelDetail">> => {
    if (!opts.releaseLabel) return {};
    try {
      return { label: await opts.releaseLabel(issue) };
    } catch (err) {
      return {
        label: "failed",
        labelDetail: err instanceof Error ? err.message : String(err),
      };
    }
  };
  /** The label field for a path that deliberately makes no label call. */
  const labelSkipped = (): Pick<CheckpointStopResult, "label"> =>
    opts.releaseLabel ? { label: "skipped" } : {};

  for (const wt of worktrees) {
    try {
      // 1. commit any dirty disk state (no-op + false when clean).
      const committed = await commitWorktreeCheckpoint(
        wt.path,
        wt.issue,
        opts.hostId,
        git,
        // THIS is the process the refusal exists for. `main.mts` has already
        // been killed by the time this runs, so it cannot be told in memory
        // that a check-repair replay was in flight — it reads the sentinel off
        // disk. The refusal must be VISIBLE, or a night that quietly kept its
        // committed work but skipped a checkpoint looks like a night nothing
        // happened on.
        (line) => opts.log?.(line),
      );

      // 2. is there anything worth saving? committed dirt OR HEAD ahead of the
      //    integration branch. Short-circuit the rev-list when we just committed.
      const hasWork =
        committed ||
        (await commitsAhead(wt.path, opts.integrationBranch, git)) > 0;

      if (!hasWork) {
        // Nothing to rescue — but the issue is still wearing `in-progress` from
        // the loop that claimed it, and the dashboard reads that label. Release
        // it: there is no work to protect, so a peer re-claiming is exactly what
        // we want. (Its LEASE is still deliberately left alone — decision #4.)
        results.push({
          issue: wt.issue,
          outcome: "nothing-to-save",
          ...(await releaseLabelFor(wt.issue)),
        });
        continue;
      }

      // 3a. persist HEAD to the WIP ref. `"always"` (the `--now` default) pushes
      //     to origin unconditionally; `"when-sync"` (the launch-time reaper)
      //     writes the ref LOCALLY and only pushes to origin when sync is on — so
      //     a flag-off single-host consumer captures its crashed WIP locally
      //     WITHOUT an origin write (inertness). Either way a failure is
      //     a per-issue error and we do NOT release the lease when the work
      //     failed to persist.
      const pushToOrigin =
        (opts.wipOriginPush ?? "always") === "always" || opts.syncEnabled;
      const push = pushToOrigin
        ? await pushWipRef(opts.repoRoot, wt.path, wt.issue, git, remote)
        : await captureWipRefLocal(opts.repoRoot, wt.path, wt.issue, git);
      if (!push.ok) {
        results.push({
          issue: wt.issue,
          outcome: "error",
          detail: push.stderr.trim() || "wip push failed",
          // The work did NOT persist. Same reasoning as the lease we also leave
          // standing below: keep the label claiming ownership rather than invite
          // a peer to redo work that is still only on this box's disk.
          ...labelSkipped(),
        });
        continue;
      }

      // 3b. release the lease so a peer may reclaim the issue: delete
      //     refs/locks/issue-<N> on the remote (empty-source delete refspec) —
      //     but ONLY when the caller's guard (if any) permits (DEFECT 1). The
      //     WIP push above already rescued the work, so a REFUSED release just
      //     leaves the lease standing (a live peer already re-claimed the issue,
      //     or lease-mode is off so there is no ref worth deleting). The policy
      //     is REQUIRED, so every caller states its intent explicitly — the
      //     graceful `--now` stop passes `() => true` for its own-host leases.
      const mayRelease = await opts.canReleaseLease(wt.issue);
      if (mayRelease) {
        const release = await releaseLeaseRef(opts.repoRoot, wt.issue, git, remote);
        if (!release.ok) {
          results.push({
            issue: wt.issue,
            outcome: "error",
            detail: release.stderr.trim() || "lease release failed",
            // The lease still stands, so the issue is still owned — leaving the
            // label saying so keeps the two signals telling the same story.
            ...labelSkipped(),
          });
          continue;
        }
      }

      // 3c. the work is safe and the lease is free — so the LABEL must stop
      //     claiming this issue is in flight. The lease is what machines
      //     arbitrate on; this label is what the ops dashboard shows a human.
      results.push({
        issue: wt.issue,
        outcome: "checkpointed",
        wipRef: wipRef(wt.issue),
        ...(await releaseLabelFor(wt.issue)),
      });
    } catch (err) {
      results.push({
        issue: wt.issue,
        outcome: "error",
        detail: err instanceof Error ? err.message : String(err),
        ...labelSkipped(),
      });
    }
  }

  // WORKSTREAM 1 (1c): after the per-issue sweep, preserve any certified-but-
  // unpromoted staging tip. A graceful `--now` stop can catch post-merge fixer
  // commits sitting on `integration-candidate` ahead of the integration branch
  // that no worktree owns — back them up to the durable strand ref so they
  // survive the stop. The LOCAL ref is always written (nothing is lost either
  // way); the ORIGIN push is gated on `syncEnabled` per the inertness
  // contract, so a flag-off single-host consumer pushes nothing new. Best-effort:
  // a resolve/push fault is silent here (the same fail-quiet posture the per-issue
  // sweep uses for a bad worktree). Pass `stagingBranch: null` to skip entirely.
  //
  // NOTE: the per-issue WIP origin write is gated by `wipOriginPush` (above):
  // `"always"` for the operator-invoked `--now` stop, `"when-sync"` for the
  // launch-time reaper so a flag-off single-host consumer captures its crashed
  // WIP LOCALLY and pushes nothing to origin. The staging/strand write below is
  // gated on `syncEnabled` too, so both origin writes now honor the flag — the
  // asymmetry the launch-time reaper once had (per-issue push always fired) is
  // closed.
  if (opts.stagingBranch !== null) {
    const ahead = await stagingCommitsAhead(
      git,
      opts.repoRoot,
      opts.integrationBranch,
      opts.stagingBranch,
    );
    if (ahead > 0) {
      await backupStrand(git, {
        repoRoot: opts.repoRoot,
        branch: opts.stagingBranch,
        syncEnabled: opts.syncEnabled,
        remote,
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
 * The label half of one issue's console line. Empty when no label seam ran, so
 * a caller without the seam gets byte-for-byte the old output. A FAILED flip is
 * spelled loudly: a reap that saved the work but left the board claiming the
 * issue is in flight has not finished the job, and must not read as clean.
 */
function labelSuffix(r: CheckpointStopResult): string {
  switch (r.label) {
    case undefined:
      return "";
    case "released":
      return "  ·  label released → ready-for-agent";
    case "not-in-progress":
      return "  ·  label was not in-progress (nothing to release)";
    case "skipped":
      return "  ·  label LEFT in-progress (work not saved — do not re-claim)";
    case "failed":
      return `  ·  label release FAILED, still in-progress: ${r.labelDetail ?? "(no detail)"}`;
    default: {
      const _exhaustive: never = r.label;
      return _exhaustive;
    }
  }
}

/**
 * Render a checkpoint-stop sweep for the console: one line per issue plus a
 * one-line tally (`2 checkpointed, 1 nothing-to-save`). A stable, greppable
 * summary for the thin runner and for operators reading a stop log.
 *
 * When the caller supplied a label seam, each line also carries that issue's
 * label fate and the tally gains a `N label-release failed` term — so a stop
 * whose labels did not flip can never be read as a clean stop.
 */
export function formatCheckpointStop(results: CheckpointStopResult[]): string {
  const lines = results.map((r) => {
    const label = labelSuffix(r);
    switch (r.outcome) {
      case "checkpointed":
        return `  #${r.issue}  checkpointed → ${r.wipRef}${label}`;
      case "nothing-to-save":
        return `  #${r.issue}  nothing-to-save${label}`;
      case "error":
        return `  #${r.issue}  error: ${r.detail ?? "(no detail)"}${label}`;
      default: {
        // Exhaustive over CheckpointStopResult["outcome"]; a future variant
        // fails to compile here (mirrors formatHostResult in hosts/result.ts).
        const _exhaustive: never = r.outcome;
        return _exhaustive;
      }
    }
  });

  const counts = { checkpointed: 0, "nothing-to-save": 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  const parts = [
    `${counts.checkpointed} checkpointed`,
    `${counts["nothing-to-save"]} nothing-to-save`,
    `${counts.error} error`,
  ];
  // Only ever appended, never replacing a term: existing greps on the tally
  // keep matching, and a seam-less caller's tally is unchanged.
  const labelFailed = results.filter((r) => r.label === "failed").length;
  if (labelFailed > 0) parts.push(`${labelFailed} label-release FAILED`);
  const summary = parts.join(", ");

  return [...lines, summary].join("\n");
}
