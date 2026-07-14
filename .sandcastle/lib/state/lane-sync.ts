/**
 * Cross-host LANE SYNC — the code-sharing substrate for a two-machine setup.
 * See docs/adr/0019-cross-host-issue-lease.md (companion to the issue lease).
 *
 * Where the LEASE (lock.ts) answers "who may WORK issue N", lane-sync answers
 * "how do two hosts SHARE the code they produce". Each host PUBLISHES its local
 * integration branch to `origin` under an invisible ref namespace
 * `refs/sandcastle/lanes/<hostId>` — invisible because it lives outside
 * `refs/heads/*` and `refs/pull/*`, so it never shows up in branch or PR lists
 * (mirrors the lease's `refs/locks/*` choice). A peer host DISCOVERS those lane
 * refs via `ls-remote`, then SYNCS a peer's lane into its own integration
 * branch by fetching + merging inside the launch worktree.
 *
 * The module is pure and dependency-injected: it shells out only through the
 * injected {@link GitRunner} (imported from lock.ts, already the loop's runGit
 * shape), so it is tested entirely offline against a real local bare repo.
 */

import type { GitRunner } from "./lock.js";

/** Options for a lane-sync handle bound to one repo + one host identity. */
export interface LaneSyncOpts {
  /** How this module shells out to git. Imported shape from lock.ts. */
  readonly git: GitRunner;
  /** Repo root the git runner's cwd is bound to. */
  readonly repoRoot: string;
  /** This machine's lane id — a ref-safe fragment (its lane ref suffix). */
  readonly hostId: string;
  /** Remote to publish/discover lanes on (default "origin"). */
  readonly remote?: string;
}

/** Outcome of merging ONE peer's lane into the local integration branch. */
export interface PeerMergeResult {
  /** Peer hostId this result is for. */
  readonly peer: string;
  /**
   * `merged` — the peer's tip is now in the local branch (clean merge or
   * already-up-to-date). `conflict` — the merge conflicted and was aborted, so
   * the worktree is left CLEAN. `skipped` — a non-fatal precondition failed
   * (fetch error, dirty worktree) and this peer was passed over this cycle.
   */
  readonly status: "merged" | "conflict" | "skipped";
  /** For `skipped`/`conflict`: a short human reason. */
  readonly reason?: string;
  /** For `conflict`: the files that conflicted (captured before the abort). */
  readonly conflictedFiles?: readonly string[];
}

/** The aggregate result of one {@link createLaneSync.syncInto} cycle. */
export interface LaneSyncResult {
  readonly peers: readonly PeerMergeResult[];
}

/**
 * A lane-sync git operation the CALLER must surface loud failed for a real
 * fault (auth/network/backend), NOT an ordinary contention/conflict outcome.
 * Only {@link createLaneSync.publish} throws this: each host writes ONLY its
 * own lane ref, so a push there is never "contended" — any failure is a genuine
 * fault. Carries the raw git `stderr`. Mirrors {@link LeaseBackendError}.
 */
export class LaneSyncError extends Error {
  /** The raw git stderr (may be empty when git said nothing useful). */
  readonly stderr: string;
  constructor(stderr: string, message?: string) {
    super(message ?? `lane sync git failure: ${stderr || "(no stderr)"}`);
    this.name = "LaneSyncError";
    this.stderr = stderr;
  }
}

/** Remote ref a given host's published lane lives at. */
function laneRef(hostId: string): string {
  return `refs/sandcastle/lanes/${hostId}`;
}

/**
 * Local mirror ref a fetched peer lane is written to. Kept in `refs/sandcastle/
 * peers/*` (the COMMON git dir, shared across all linked worktrees) rather than
 * relying on FETCH_HEAD — FETCH_HEAD is per-worktree, so a fetch run in the
 * repo root would be invisible to a `merge` run inside a separate launch
 * worktree. Merging a stable local ref by name sidesteps that entirely.
 */
function peerRef(peer: string): string {
  return `refs/sandcastle/peers/${peer}`;
}

/** Prefix of the lane ref namespace, used to parse `ls-remote` output. */
const LANE_PREFIX = "refs/sandcastle/lanes/";

export function createLaneSync(opts: LaneSyncOpts): {
  publish(branch: string): Promise<void>;
  discoverPeers(): Promise<string[]>;
  syncInto(branch: string, launchWorktreePath: string): Promise<LaneSyncResult>;
} {
  const remote = opts.remote ?? "origin";
  const run = (...args: string[]) => opts.git(opts.repoRoot, ...args);

  /**
   * Push the LOCAL `branch` to this host's lane ref on the remote. `--force` is
   * SAFE here because this ref has a SINGLE writer — only this host ever writes
   * `refs/sandcastle/lanes/<own hostId>` — so there is no peer to clobber; the
   * force just keeps the published lane == local integration even after a
   * rebase/reset makes the advance non-fast-forward. Any push failure is a real
   * auth/network/backend fault (never contention), surfaced as a LaneSyncError.
   */
  async function publish(branch: string): Promise<void> {
    const res = await run("push", "--force", remote, `${branch}:${laneRef(opts.hostId)}`);
    if (!res.ok) throw new LaneSyncError(res.stderr);
  }

  /**
   * List peer hostIds that have published a lane, EXCLUDING this host. Returns
   * `[]` on ANY ls-remote failure (discovery must never crash a cycle — a hard
   * auth fault surfaces loud on the next {@link publish}, which is the write
   * path). Empty list when no peers have published.
   */
  async function discoverPeers(): Promise<string[]> {
    const res = await run("ls-remote", remote, `${LANE_PREFIX}*`);
    if (!res.ok) return [];
    const peers: string[] = [];
    for (const line of res.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const ref = trimmed.split(/\s+/)[1];
      if (!ref || !ref.startsWith(LANE_PREFIX)) continue;
      const peer = ref.slice(LANE_PREFIX.length);
      if (peer === "" || peer === opts.hostId) continue;
      peers.push(peer);
    }
    return peers;
  }

  /**
   * For each discovered peer: fetch its lane into a local mirror ref, then merge
   * that ref into `branch` INSIDE `launchWorktreePath`. Never throws on ordinary
   * fetch/merge-conflict conditions — a failed fetch or a dirty worktree yields
   * `skipped`; a conflicting merge is aborted (worktree left clean) and yields
   * `conflict` with the conflicted files.
   */
  async function syncInto(
    branch: string,
    launchWorktreePath: string,
  ): Promise<LaneSyncResult> {
    const peers = await discoverPeers();
    const results: PeerMergeResult[] = [];
    for (const peer of peers) {
      // 1. Fetch the peer's lane into our local mirror ref (force: it is only
      //    our copy of the peer tip). A fetch failure is NON-fatal.
      const fetched = await run(
        "fetch",
        remote,
        `+${laneRef(peer)}:${peerRef(peer)}`,
      );
      if (!fetched.ok) {
        results.push({
          peer,
          status: "skipped",
          reason: `fetch failed: ${fetched.stderr || "(no stderr)"}`,
        });
        continue;
      }

      // 2. Dirty-tree guard (mirrors fastForwardIntegration): never merge into a
      //    worktree with uncommitted changes — the merge would be refused or
      //    would clobber them.
      const dirty = await run("-C", launchWorktreePath, "status", "--porcelain");
      if (dirty.ok && dirty.stdout.trim() !== "") {
        results.push({
          peer,
          status: "skipped",
          reason: `launch worktree ${launchWorktreePath} has uncommitted changes`,
        });
        continue;
      }

      // 3. Merge the fetched peer tip into `branch` inside the launch worktree.
      const merged = await run("-C", launchWorktreePath, "merge", peerRef(peer));
      if (merged.ok) {
        results.push({ peer, status: "merged" });
        continue;
      }

      // Conflict: capture the conflicted files BEFORE aborting, then abort so
      // the worktree is left CLEAN (no MERGE_HEAD, no half-applied files).
      const conflicts = await run(
        "-C",
        launchWorktreePath,
        "diff",
        "--name-only",
        "--diff-filter=U",
      );
      const conflictedFiles = conflicts.ok
        ? conflicts.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((f) => f !== "")
        : [];
      // Best-effort abort; ignore its result (nothing to abort ⇒ non-ok is fine).
      await run("-C", launchWorktreePath, "merge", "--abort");
      results.push({
        peer,
        status: "conflict",
        reason: merged.stderr || "merge conflict",
        conflictedFiles,
      });
    }
    return { peers: results };
  }

  return { publish, discoverPeers, syncInto };
}
