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
import { LANE_PREFIX, laneRef, peerRef } from "./lane-sync.js";
import { discoverRefPeers } from "./ref-peers.js";

/**
 * A convergence git operation the CALLER must surface LOUD: a genuine fault
 * (auth/network/non-fast-forward/dirty tree), NOT an ordinary merge-conflict
 * outcome (conflicts are reported per-lane with a durable marker instead).
 * Mirrors {@link LaneSyncError} and ADR 0020's fail-loud-on-write posture:
 * convergence either LANDS on the remote or says so — never silently.
 */
export class ConvergeError extends Error {
  /** The raw git stderr (may be empty when git said nothing useful). */
  readonly stderr: string;
  constructor(stderr: string, message?: string) {
    super(message ?? `converge git failure: ${stderr || "(no stderr)"}`);
    this.name = "ConvergeError";
    this.stderr = stderr;
  }
}

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
   * already-up-to-date). `conflict` — the merge left REAL conflicted paths in
   * the index (a genuine divergence); it was aborted (the branch is left clean)
   * and a durable marker ref captures both tips. A merge that failed WITHOUT
   * conflicted paths is never this — it raises {@link ConvergeError}, because
   * reporting it here would tell the operator the machines diverged when they
   * have not. `skip` — a non-fatal precondition failed (fetch error / dirty
   * worktree) and this peer was passed over. `noop` — the single sentinel entry
   * returned when NO peer lanes exist, so there was nothing to converge.
   */
  readonly result: "merged" | "conflict" | "skip" | "noop";
  /** The peer lane tip that was merged/attempted (absent for `noop`). */
  readonly tip?: string;
  /**
   * For `conflict`: the marker ref, present ONLY when the marker was genuinely
   * created AND pushed to the remote. Its ABSENCE on a `conflict` lane means the
   * divergence could not be durably recorded — a LOUD problem the caller must
   * surface (see {@link ConvergeResult.conflicts}).
   */
  readonly markerRef?: string;
  /** For `skip`/`conflict`: a short human reason. */
  readonly reason?: string;
}

/** The aggregate result of one {@link convergeLanes} run. */
export interface ConvergeResult {
  /** Per-peer outcomes (or a single `noop` entry when there are no peers). */
  readonly perLane: LaneConvergeResult[];
  /**
   * The run branch tip after convergence. Only ever returned once the push to
   * the remote SUCCEEDED — a rejected push throws {@link ConvergeError} rather
   * than return a tip that would imply convergence landed when it did not.
   */
  readonly branchTip: string;
  /**
   * Marker ref names for conflicting peers whose marker was genuinely written
   * AND pushed. A conflict whose marker could NOT be recorded is deliberately
   * absent here (it appears as a `conflict` lane with no `markerRef`), so this
   * list never over-claims durable records that do not exist on the remote.
   */
  readonly conflicts: string[];
}

/**
 * Durable ref recording a converge conflict between this host and a peer.
 * (`laneRef` / `peerRef` / `LANE_PREFIX` are imported from lane-sync.ts — the
 * lane namespace has exactly ONE definition, which the two modules share.)
 */
function conflictRef(hostId: string, peer: string): string {
  return `refs/sandcastle/conflict/${hostId}-${peer}`;
}

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

  // Remember where the OPERATOR was so we can put them back — this is their
  // working checkout, not ours to leave parked on the run branch.
  const originalRef = await currentRef(run);

  // Dirty-tree guard BEFORE any checkout: checking out over uncommitted work
  // would refuse or clobber it. Refuse LOUD instead — the operator's tree is
  // theirs, and convergence is never worth risking it.
  // A status that FAILS is an UNKNOWN tree, never an assumed-clean one: skipping
  // the guard on a failed check is how converge ends up merging into a dirty tree
  // and then misreporting the resulting merge failure as a peer divergence.
  const dirtyBefore = await run("status", "--porcelain");
  if (!dirtyBefore.ok) {
    throw new ConvergeError(
      dirtyBefore.stderr,
      `converge could not determine whether ${repoRoot} is clean ` +
        `(git status failed: ${dirtyBefore.stderr || "(no stderr)"}) — refusing to ` +
        `check out over an unknown tree`,
    );
  }
  if (dirtyBefore.stdout.trim() !== "") {
    throw new ConvergeError(
      "",
      `converge refused: ${repoRoot} has uncommitted changes — ` +
        `commit or stash them before converging (never checkout over a dirty tree)`,
    );
  }

  // Operate ON the run branch in the converger's checkout. A FAILED checkout
  // would leave every merge below landing on the WRONG branch → fail LOUD.
  const checkedOut = await run("checkout", branch);
  if (!checkedOut.ok) {
    throw new ConvergeError(
      checkedOut.stderr,
      `converge could not check out run branch ${branch}: ` +
        `${checkedOut.stderr || "(no stderr)"}`,
    );
  }

  try {
    return await convergeOnBranch(run, { branch, hostId, remote }, peers);
  } finally {
    // Restore the operator's branch on EVERY exit path — success AND the push
    // fault thrown inside. (The guards ABOVE throw before we ever moved, so they
    // need no restore.) Best-effort: a restore failure must never mask the real
    // fault by replacing it with a checkout error.
    if (originalRef && originalRef !== branch) await run("checkout", originalRef);
  }
}

/** The current branch name, or the raw SHA when HEAD is detached. */
async function currentRef(
  run: (...args: string[]) => ReturnType<GitRunner>,
): Promise<string> {
  const symbolic = await run("symbolic-ref", "--short", "HEAD");
  if (symbolic.ok && symbolic.stdout.trim() !== "") return symbolic.stdout.trim();
  const detached = await run("rev-parse", "HEAD");
  return detached.ok ? detached.stdout.trim() : "";
}

/**
 * Did a FAILED merge leave real conflicted paths — i.e. is this an actual
 * divergence between the two machines, or some other fault wearing a merge
 * failure's clothes?
 *
 * The signal is `git ls-files -u` (unmerged index entries), chosen over the two
 * alternatives because it is the only one that is both authoritative and stable:
 *   - The EXIT CODE cannot discriminate at all. A dirty-tree merge refusal
 *     ("local changes would be overwritten") exits 1 — exactly like a genuine
 *     conflict. Unrelated histories exits 128, but that gap is not a contract.
 *   - `CONFLICT (...)` in STDERR is human-facing prose: locale-dependent and
 *     free to be reworded by any git version. Parsing it is a guess.
 *   - `git ls-files -u` is PLUMBING over the index — the authoritative record of
 *     conflict state that `git merge` itself writes. It is locale-independent,
 *     needs no worktree traversal, and reports conflicts that are not
 *     content-shaped (modify/delete, add/add) which a worktree diff can miss.
 *
 * A FAILING `ls-files` is itself unknown state, not a "no": it raises rather
 * than let an unanswered question decide whether to push a durable marker.
 */
async function hasConflictedPaths(
  run: (...args: string[]) => ReturnType<GitRunner>,
  peer: string,
  mergeStderr: string,
): Promise<boolean> {
  const unmerged = await run("ls-files", "-u");
  if (!unmerged.ok) {
    throw new ConvergeError(
      unmerged.stderr,
      `converge could not determine whether the failed merge of peer lane ${peer} ` +
        `conflicted (git ls-files -u failed: ${unmerged.stderr || "(no stderr)"}); ` +
        `refusing to guess. The merge failed with: ${mergeStderr || "(no stderr)"}`,
    );
  }
  return unmerged.stdout.trim() !== "";
}

/**
 * Merge every peer lane onto the ALREADY-checked-out run branch and push. Split
 * out so {@link convergeLanes} owns the checkout/restore lifecycle and this owns
 * the reconciliation, with no `finally` nesting between them.
 */
async function convergeOnBranch(
  run: (...args: string[]) => ReturnType<GitRunner>,
  opts: { branch: string; hostId: string; remote: string },
  peers: string[],
): Promise<ConvergeResult> {
  const { branch, hostId, remote } = opts;
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
    //    uncommitted changes — the merge would be refused or clobber them. A
    //    dirty tree is a non-fatal skip; a status that FAILS is NOT — it is an
    //    unknown tree, and merging into one manufactures the false conflict this
    //    guard exists to prevent, so it fails LOUD instead.
    const dirty = await run("status", "--porcelain");
    if (!dirty.ok) {
      throw new ConvergeError(
        dirty.stderr,
        `converge could not determine whether the checkout is clean before merging ` +
          `peer lane ${peer} (git status failed: ${dirty.stderr || "(no stderr)"}) — ` +
          `refusing to merge into an unknown tree`,
      );
    }
    if (dirty.stdout.trim() !== "") {
      perLane.push({ host: peer, result: "skip", tip: peerTip });
      continue;
    }

    // 3. Merge the fetched peer tip onto the run branch.
    const merged = await run("merge", peerRef(peer));
    if (merged.ok) {
      perLane.push({ host: peer, result: "merged", tip: peerTip });
      continue;
    }

    // 4. The merge FAILED — but a failure is not evidence of a divergence. Ask
    //    the INDEX whether real conflicted paths exist before calling it one.
    //    This MUST precede the `merge --abort` below, which clears the stages.
    if (!(await hasConflictedPaths(run, peer, merged.stderr))) {
      // Not a conflict: some other fault (unrelated histories, dirty tree, bad
      // config, missing ref). Leave no half-merge behind, then fail LOUD naming
      // the REAL cause — never a marker asserting the machines diverged.
      await run("merge", "--abort");
      throw new ConvergeError(
        merged.stderr,
        `converge could not merge peer lane ${peer} onto ${branch} — this is NOT ` +
          `a divergence between the machines, the merge itself failed: ` +
          `${merged.stderr || "(no stderr)"}`,
      );
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
    // Record the marker ref ONLY once it genuinely exists on the remote. Each
    // step below can fail; claiming an unwritten marker would be precisely the
    // silent divergence the marker exists to prevent.
    const failed = (reason: string): void => {
      perLane.push({ host: peer, result: "conflict", tip: peerTip, reason });
    };
    if (!branchTip || !peerTip) {
      failed(
        `conflict marker NOT recorded: could not resolve ` +
          `${!branchTip ? "the branch tip" : "the peer tip"}`,
      );
      continue;
    }
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
    if (!marker.ok) {
      failed(`conflict marker NOT recorded: commit-tree failed: ${marker.stderr || "(no stderr)"}`);
      continue;
    }
    const markerSha = marker.stdout.trim();
    const updated = await run("update-ref", markerRef, markerSha);
    if (!updated.ok) {
      failed(`conflict marker NOT recorded: update-ref failed: ${updated.stderr || "(no stderr)"}`);
      continue;
    }
    const pushedMarker = await run("push", remote, `${markerSha}:${markerRef}`);
    if (!pushedMarker.ok) {
      failed(
        `conflict marker NOT recorded on ${remote}: push failed: ` +
          `${pushedMarker.stderr || "(no stderr)"}`,
      );
      continue;
    }
    conflicts.push(markerRef);
    perLane.push({ host: peer, result: "conflict", tip: peerTip, markerRef });
  }

  // Push the converged run branch back to the remote (idempotent when no clean
  // merge advanced it). This is the whole POINT of the command: if it does not
  // land, the machines did NOT converge. A rejection here (non-fast-forward,
  // auth, network) is a real fault → fail LOUD rather than report a local tip
  // that would imply convergence landed (ADR 0020 fail-loud-on-write).
  const pushed = await run("push", remote, `${branch}:refs/heads/${branch}`);
  if (!pushed.ok) {
    throw new ConvergeError(
      pushed.stderr,
      `converge could NOT push run branch ${branch} to ${remote} — the machines ` +
        `did not converge: ${pushed.stderr || "(no stderr)"}`,
    );
  }

  const finalTipRes = await run("rev-parse", branch);
  const branchTip = finalTipRes.ok ? finalTipRes.stdout.trim() : "";
  return { perLane, branchTip, conflicts };
}
