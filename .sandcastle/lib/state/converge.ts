/**
 * Cross-host CONVERGENCE — the "bring both machines to one point" operator path.
 *
 * The lane transport ({@link ./lane-sync.ts}) shares code opportunistically: a
 * host only pulls a peer's lane at the TOP of its next iteration, so a machine
 * that has drained its own queue never merges the peer's FINAL lane and the two
 * machines drift apart. There was no command to reconcile them — a human had to
 * hand-merge the hidden `refs/sandcastle/lanes/<host>` refs.
 *
 * {@link convergeLanes} is that missing command as an ISOLATED code path. Run on
 * ONE machine (the converger), it:
 *   1. Discovers every peer lane via {@link discoverRefPeers} (excluding self).
 *   2. Checks out the run `branch` and merges each peer lane onto it, mirroring
 *      lane-sync's fetch→merge→(conflict? abort) idiom so a conflict never
 *      leaves a half-merge behind.
 *   3. On a conflict, writes a DURABLE marker ref
 *      `refs/sandcastle/conflict/<hostId>-<peer>` — a real commit with BOTH tips
 *      as parents, pushed to the remote — so the divergence is never silent.
 *   4. Pushes the converged `refs/heads/<branch>` back to the remote.
 *   5. Returns a per-lane report plus the final branch tip.
 *
 * Pure and dependency-injected over the same {@link GitRunner} shape lane-sync
 * uses (imported from issue-lease.ts), so it is exercised end-to-end against a
 * real local bare repo with zero live SSH/containers.
 */

import { EMPTY_TREE_OID, type GitRunner } from "./issue-lease.js";
import { discoverRefPeers } from "./ref-peers.js";

/** Options for a single convergence, bound to one repo + one host identity. */
export interface ConvergeOpts {
  /** Repo root the converger operates in (its checkout of the run branch). */
  readonly repoRoot: string;
  /** The shared run branch every host's lane feeds into. */
  readonly branch: string;
  /** This machine's lane id — the ref-safe self fragment excluded from peers. */
  readonly hostId: string;
  /** Remote to fetch lanes from and push the converged branch to (default "origin"). */
  readonly remote?: string;
}

/** Outcome of reconciling ONE peer's lane onto the run branch. */
export interface LaneConvergeResult {
  /** Peer hostId this result is for (or the self hostId for the `noop` sentinel). */
  readonly host: string;
  /**
   * `merged` — the peer's lane is now in the run branch (clean merge or
   * already-up-to-date). `conflict` — the merge conflicted; it was aborted (the
   * branch is left clean) and a durable marker ref captures both tips. `skip` —
   * a non-fatal precondition failed (fetch error / dirty worktree) and this peer
   * was passed over. `noop` — the single sentinel entry returned when NO peer
   * lanes exist, so there was nothing to converge.
   */
  readonly result: "merged" | "conflict" | "skip" | "noop";
  /** The peer lane tip that was merged/attempted (absent for `noop`). */
  readonly tip?: string;
}

/** The aggregate result of one {@link convergeLanes} run. */
export interface ConvergeResult {
  /** Per-peer outcomes (or a single `noop` entry when there are no peers). */
  readonly perLane: LaneConvergeResult[];
  /** The run branch tip after convergence (== the tip pushed to the remote). */
  readonly branchTip: string;
  /** Marker ref names written for each conflicting peer (empty when none). */
  readonly conflicts: string[];
}

/** Remote ref a given host's published lane lives at. */
function laneRef(hostId: string): string {
  return `refs/sandcastle/lanes/${hostId}`;
}

/** Local mirror ref a fetched peer lane is written to (mirrors lane-sync). */
function peerRef(peer: string): string {
  return `refs/sandcastle/peers/${peer}`;
}

/** Durable ref recording a converge conflict between this host and a peer. */
function conflictRef(hostId: string, peer: string): string {
  return `refs/sandcastle/conflict/${hostId}-${peer}`;
}

/** Prefix of the lane ref namespace, used to parse `ls-remote` output. */
const LANE_PREFIX = "refs/sandcastle/lanes/";

/**
 * Reconcile every peer lane onto the run branch and push the result. See the
 * module header for the full contract. Pure over the injected `git` runner.
 */
export async function convergeLanes(
  git: GitRunner,
  opts: ConvergeOpts,
): Promise<ConvergeResult> {
  const remote = opts.remote ?? "origin";
  const { branch, hostId, repoRoot } = opts;
  const run = (...args: string[]) => git(repoRoot, ...args);

  const peers = await discoverRefPeers(run, remote, LANE_PREFIX, hostId);

  // No peers: nothing to converge. Return a single `noop` sentinel and do NOT
  // touch the remote (the branch is unchanged).
  if (peers.length === 0) {
    const tipRes = await run("rev-parse", branch);
    return {
      perLane: [{ host: hostId, result: "noop" }],
      branchTip: tipRes.ok ? tipRes.stdout.trim() : "",
      conflicts: [],
    };
  }

  // Operate ON the run branch in the converger's checkout.
  await run("checkout", branch);

  const perLane: LaneConvergeResult[] = [];
  const conflicts: string[] = [];

  for (const peer of peers) {
    // 1. Fetch the peer's lane into a stable local mirror ref (force: it is only
    //    our copy of the peer tip). A fetch failure is NON-fatal → skip.
    const fetched = await run("fetch", remote, `+${laneRef(peer)}:${peerRef(peer)}`);
    if (!fetched.ok) {
      perLane.push({ host: peer, result: "skip" });
      continue;
    }
    const peerTipRes = await run("rev-parse", peerRef(peer));
    const peerTip = peerTipRes.ok ? peerTipRes.stdout.trim() : undefined;

    // 2. Dirty-tree guard (mirrors lane-sync): never merge into a checkout with
    //    uncommitted changes — the merge would be refused or clobber them.
    const dirty = await run("status", "--porcelain");
    if (dirty.ok && dirty.stdout.trim() !== "") {
      perLane.push({ host: peer, result: "skip", tip: peerTip });
      continue;
    }

    // 3. Merge the fetched peer tip onto the run branch.
    const merged = await run("merge", peerRef(peer));
    if (merged.ok) {
      perLane.push({ host: peer, result: "merged", tip: peerTip });
      continue;
    }

    // Conflict: capture both tips in a DURABLE marker BEFORE aborting so the
    // divergence is never silent. The marker is a real commit whose parents are
    // the branch tip and the peer tip (empty tree — it carries no content, only
    // the linkage), pushed to the remote and left locally.
    const branchTipRes = await run("rev-parse", "HEAD");
    const branchTip = branchTipRes.ok ? branchTipRes.stdout.trim() : "";
    // Best-effort abort FIRST so commit-tree/update-ref run against a clean tree.
    await run("merge", "--abort");

    const markerRef = conflictRef(hostId, peer);
    if (branchTip && peerTip) {
      const marker = await run(
        "commit-tree",
        EMPTY_TREE_OID,
        "-p",
        branchTip,
        "-p",
        peerTip,
        "-m",
        `converge conflict: ${hostId} <-> ${peer} (branch=${branchTip} peer=${peerTip})`,
      );
      if (marker.ok) {
        const markerSha = marker.stdout.trim();
        await run("update-ref", markerRef, markerSha);
        await run("push", remote, `${markerSha}:${markerRef}`);
      }
    }
    conflicts.push(markerRef);
    perLane.push({ host: peer, result: "conflict", tip: peerTip });
  }

  // Push the converged run branch back to the remote (idempotent when no clean
  // merge advanced it).
  await run("push", remote, `${branch}:refs/heads/${branch}`);

  const finalTipRes = await run("rev-parse", branch);
  const branchTip = finalTipRes.ok ? finalTipRes.stdout.trim() : "";
  return { perLane, branchTip, conflicts };
}
