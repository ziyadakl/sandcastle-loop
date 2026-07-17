/**
 * STRAND BACKUP — data-safety primitives for the cross-host loop (Workstream 1).
 *
 * Three ways finished/in-flight work can be silently lost, and the durable ref
 * each one is persisted to so a human or a peer host can recover it:
 *
 *   1a. A final promotion whose fast-forward is REFUSED strands merged +
 *       post-merge-certified code on `integration-candidate`. {@link backupStrand}
 *       pins that tip to a local `refs/sandcastle/strand/<branch>` (and per-issue
 *       `refs/sandcastle/wip/issue-<N>`) — ALWAYS locally, and to origin too when
 *       cross-host sync is on so a peer can pull it.
 *   1b. A hard crash (SIGKILL/OOM) between iterations loses whatever an in-flight
 *       `agent/issue-<N>` worktree had produced. {@link checkpointInflightWork},
 *       run on the lease heartbeat, commits each dirty worktree and (sync on)
 *       pushes its WIP ref, so resume picks up the last heartbeat's state.
 *   1c. A graceful `--now` stop with a certified-but-unpromoted staging tip loses
 *       post-merge fixer commits. {@link stagingCommitsAhead} + {@link backupStrand}
 *       back that tip up to the same strand scheme.
 *
 * Like the rest of the state layer this touches git ONLY through an injected
 * {@link GitRunner} (the seam issue-lease.ts defines), so the whole module is
 * unit-testable against a real local bare repo with no network. Every operation
 * is best-effort: failures are collected into the result's `errors` and NEVER
 * thrown — a backup that can't complete must never crash the loop it protects.
 */
import type { GitRunner } from "./issue-lease.js";
import {
  wipRef,
  commitWorktreeCheckpoint,
  pushWipRef,
} from "./branch-checkpoint.js";
// Type-only import (erased at runtime) — keeps this module free of a runtime
// cycle with checkpoint-stop.ts, which imports the backup helpers below.
import type { InflightWorktree } from "./checkpoint-stop.js";

/** Durable ref a stranded branch's tip is pinned to (mirrors wipRef/laneRef). */
export function strandRef(branch: string): string {
  return `refs/sandcastle/strand/${branch}`;
}

/** Options for {@link backupStrand}. */
export interface StrandBackupOpts {
  readonly repoRoot: string;
  /** The stranded branch whose tip is being pinned (e.g. STAGING_BRANCH). */
  readonly branch: string;
  /**
   * Issues whose per-issue WIP ref (`refs/sandcastle/wip/issue-<N>`) should ALSO
   * point at the stranded tip, so the resume path can find the work by issue.
   */
  readonly issues?: readonly number[];
  /**
   * When true, ALSO push every written ref to `remote` so a peer host can pull
   * the stranded work. When false, refs are written LOCALLY only — no origin
   * touch (the inert-when-off contract the rest of cross-host sync honors).
   */
  readonly syncEnabled: boolean;
  readonly remote?: string;
}

/** Outcome of one {@link backupStrand} call. */
export interface StrandBackupResult {
  /** Refs written to the LOCAL ref store. */
  readonly localRefs: string[];
  /** Refs pushed to origin (empty unless `syncEnabled`). */
  readonly pushedRefs: string[];
  /** Non-fatal failures, each a short human string. */
  readonly errors: string[];
}

/** Resolve a rev to a concrete commit SHA, or "" when it does not resolve. */
async function revParse(
  git: GitRunner,
  repoRoot: string,
  rev: string,
): Promise<string> {
  const res = await git(repoRoot, "rev-parse", "--verify", "--quiet", rev);
  return res.ok ? res.stdout.trim() : "";
}

/**
 * Back up the tip of `opts.branch` to a durable strand ref (and per-issue WIP
 * refs). The tip is first resolved to a concrete SHA so the refs pin the exact
 * commit even if the branch later moves. Local `update-ref` always runs; the
 * origin push runs only when `syncEnabled`. Best-effort: any failure is recorded
 * in `errors`, never thrown.
 */
export async function backupStrand(
  git: GitRunner,
  opts: StrandBackupOpts,
): Promise<StrandBackupResult> {
  const remote = opts.remote ?? "origin";
  const localRefs: string[] = [];
  const pushedRefs: string[] = [];
  const errors: string[] = [];

  const sha = await revParse(git, opts.repoRoot, opts.branch);
  if (!sha) {
    errors.push(`strand branch ${opts.branch} did not resolve to a commit`);
    return { localRefs, pushedRefs, errors };
  }

  const refs = [
    strandRef(opts.branch),
    ...(opts.issues ?? []).map((n) => wipRef(n)),
  ];

  for (const ref of refs) {
    const up = await git(opts.repoRoot, "update-ref", ref, sha);
    if (up.ok) localRefs.push(ref);
    else errors.push(`update-ref ${ref} failed: ${up.stderr.trim() || "(no stderr)"}`);
  }

  if (opts.syncEnabled) {
    for (const ref of localRefs) {
      // `--force` is safe: a strand ref is a best-effort snapshot with a single
      // writing host, and a per-issue WIP ref is namespaced to its issue.
      const push = await git(opts.repoRoot, "push", "--force", remote, `${sha}:${ref}`);
      if (push.ok) pushedRefs.push(ref);
      else errors.push(`push ${ref} failed: ${push.stderr.trim() || "(no stderr)"}`);
    }
  }

  return { localRefs, pushedRefs, errors };
}

/**
 * Count commits in `<integrationBranch>..<stagingBranch>` — how many the staging
 * branch has that the integration branch does not. `> 0` means there is
 * certified-but-unpromoted work worth backing up (the 1c gate). A failed
 * rev-list (unknown ref) reports 0 so the caller does not over-save.
 */
export async function stagingCommitsAhead(
  git: GitRunner,
  repoRoot: string,
  integrationBranch: string,
  stagingBranch: string,
): Promise<number> {
  const res = await git(
    repoRoot,
    "rev-list",
    `${integrationBranch}..${stagingBranch}`,
    "--count",
  );
  if (!res.ok) return 0;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/** Options for {@link checkpointInflightWork}. */
export interface InflightCheckpointOpts {
  readonly repoRoot: string;
  readonly hostId: string;
  /** Push the WIP ref to origin only when true (the sync flag). */
  readonly syncEnabled: boolean;
  readonly remote?: string;
}

/** Per-issue outcome of a heartbeat in-flight checkpoint. */
export interface InflightCheckpointResult {
  readonly issue: number;
  /** `checkpointed` — dirt was committed (and pushed when sync on). `clean` —
   *  nothing changed, no ref touched. `error` — a non-fatal git failure. */
  readonly outcome: "checkpointed" | "clean" | "error";
  readonly detail?: string;
}

/**
 * Heartbeat checkpoint (1b): for each in-flight `agent/issue-<N>` worktree,
 * commit any dirty state and — when sync is on — push its WIP ref with
 * `--force-with-lease`, so a hard crash resumes from the last heartbeat rather
 * than restarting fresh. Clean worktrees are left untouched. Every worktree is
 * independent: one bad worktree records an `error` and the sweep continues.
 * NEVER throws — callers route failures to a non-fatal log.
 */
export async function checkpointInflightWork(
  git: GitRunner,
  worktrees: readonly InflightWorktree[],
  opts: InflightCheckpointOpts,
): Promise<InflightCheckpointResult[]> {
  const remote = opts.remote ?? "origin";
  const results: InflightCheckpointResult[] = [];

  for (const wt of worktrees) {
    try {
      const committed = await commitWorktreeCheckpoint(
        wt.path,
        wt.issue,
        opts.hostId,
        git,
      );
      if (!committed) {
        results.push({ issue: wt.issue, outcome: "clean" });
        continue;
      }
      if (opts.syncEnabled) {
        const push = await pushWipRef(opts.repoRoot, wt.path, wt.issue, git, remote);
        if (!push.ok) {
          results.push({
            issue: wt.issue,
            outcome: "error",
            detail: push.stderr.trim() || "wip push failed",
          });
          continue;
        }
      }
      results.push({ issue: wt.issue, outcome: "checkpointed" });
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
