/**
 * Cross-host STATUS SYNC — the transport that fuses two machines' live status
 * feeds into ONE viewer. See docs/adr/0020 (cross-host unified viewer).
 *
 * It mirrors {@link ./lane-sync.ts} (each host publishes to an invisible
 * `refs/sandcastle/status/<hostId>` ref outside `refs/heads/*`, peers discover
 * via `ls-remote`) but differs in two load-bearing ways:
 *
 *   1. `status.json` is GITIGNORED, so there is no branch tip to push. The
 *      snapshot rides in the COMMIT MESSAGE of a parentless empty-tree commit
 *      (the lease backend's `makeLockCommit` idiom, issue-lease.ts) and is read
 *      back with `git show -s --format=%B`.
 *   2. It FAILS SOFT. Where lane-sync's `publish` throws a loud `LaneSyncError`
 *      (a code-sharing fault must stop the loop), status sync is PURELY cosmetic
 *      telemetry: a viewer glitch must NEVER crash the loop. So every operation
 *      catches all faults — `publish` returns `{ ok: false, error }`, `fetchPeers`
 *      skips the bad peer and returns whatever it could read (worst case `[]`).
 *      The fail-soft lives INSIDE the module so no call site can forget it; there
 *      is deliberately NO error type that escapes.
 *
 * Pure and dependency-injected: it shells out only through the injected
 * {@link GitRunner} (imported from issue-lease.ts, the loop's runGit shape), so
 * it is tested entirely offline against a real local bare repo.
 */

import { EMPTY_TREE_OID, type GitRunner } from "./issue-lease.js";
import { discoverRefPeers } from "./ref-peers.js";
import { SandcastleStatusSchema, type SandcastleStatus } from "../status/schema.js";

/** Options for a status-sync handle bound to one repo + one host identity. */
export interface StatusSyncOpts {
  /** How this module shells out to git. Imported shape from issue-lease.ts. */
  readonly git: GitRunner;
  /** Repo root the git runner's cwd is bound to. */
  readonly repoRoot: string;
  /** This machine's status id — a ref-safe fragment (its status ref suffix). */
  readonly hostId: string;
  /** Remote to publish/discover status on (default "origin"). */
  readonly remote?: string;
}

/** Remote ref a given host's published status lives at. */
function statusRef(hostId: string): string {
  return `refs/sandcastle/status/${hostId}`;
}

/**
 * Local mirror ref a fetched peer status is written to. Kept in
 * `refs/sandcastle/peer-status/*` (distinct from lane-sync's `peers/*`) so the
 * two transports never collide, and readable by name (not FETCH_HEAD, which is
 * per-worktree).
 */
function peerStatusRef(peer: string): string {
  return `refs/sandcastle/peer-status/${peer}`;
}

/** Prefix of the status ref namespace, used to parse `ls-remote` output. */
const STATUS_PREFIX = "refs/sandcastle/status/";

/**
 * The fail-soft outcome of a status `publish`: `ok` on success, or `ok: false`
 * with a human-readable `error`. Distinct from issue-lease's `{ ok; oid? }` and
 * drizzle's `{ ok; msg }` — those carry different payloads and must not be
 * conflated with this cosmetic-telemetry result.
 */
export type PublishResult = { ok: boolean; error?: string };

export function createStatusSync(opts: StatusSyncOpts): {
  publish(snapshotJson: string): Promise<PublishResult>;
  fetchPeers(runId: string): Promise<SandcastleStatus[]>;
} {
  const remote = opts.remote ?? "origin";
  const run = (...args: string[]) => opts.git(opts.repoRoot, ...args);

  /**
   * Publish `snapshotJson` as this host's status: bake it into a parentless
   * empty-tree commit MESSAGE, then force-push that commit to this host's status
   * ref. `--force` is SAFE — this ref has a SINGLE writer (only this host ever
   * writes its own status), so there is no peer to clobber; the force just keeps
   * the published status == the latest snapshot. NEVER THROWS: any fault (a
   * throwing runner, a failed commit-tree, a rejected push) is caught and
   * returned as `{ ok: false, error }`.
   */
  async function publish(
    snapshotJson: string,
  ): Promise<PublishResult> {
    try {
      // -c user.* keeps commit-tree from failing on hosts without a git identity.
      const commit = await run(
        "-c",
        "user.name=sandcastle-status",
        "-c",
        "user.email=status@sandcastle.local",
        "commit-tree",
        EMPTY_TREE_OID,
        "-m",
        snapshotJson,
      );
      if (!commit.ok || !commit.stdout.trim()) {
        return {
          ok: false,
          error: commit.stderr || "status commit-tree returned no oid",
        };
      }
      const oid = commit.stdout.trim();
      const pushed = await run(
        "push",
        "--force",
        remote,
        `${oid}:${statusRef(opts.hostId)}`,
      );
      if (!pushed.ok) {
        return { ok: false, error: pushed.stderr || "status push failed" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Discover every PEER host's published status (excluding this host) and return
   * the ones whose snapshot belongs to the SAME `runId`. For each peer: fetch its
   * status ref into a local mirror, read the snapshot back out of the commit
   * message, `JSON.parse` + schema-validate it, and keep it only if
   * `.runId === runId`. NEVER THROWS: any failure at any step — an ls-remote
   * fault, an unreadable ref, corrupt/non-JSON or schema-invalid body, a
   * mismatched runId — SKIPS that peer; a total failure returns `[]`.
   */
  async function fetchPeers(runId: string): Promise<SandcastleStatus[]> {
    try {
      const peers = await discoverRefPeers(run, remote, STATUS_PREFIX, opts.hostId);
      const out: SandcastleStatus[] = [];
      for (const peer of peers) {
        const status = await readPeerStatus(peer, runId);
        if (status) out.push(status);
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Fetch + read + validate ONE peer's status. Returns the validated snapshot
   * only when it parses AND matches `runId`; returns `null` (skip) on any fault.
   */
  async function readPeerStatus(
    peer: string,
    runId: string,
  ): Promise<SandcastleStatus | null> {
    const mirror = peerStatusRef(peer);
    const fetched = await run(
      "fetch",
      remote,
      `+${statusRef(peer)}:${mirror}`,
    );
    if (!fetched.ok) return null;

    const body = await run("show", "-s", "--format=%B", mirror);
    if (!body.ok) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.stdout);
    } catch {
      return null;
    }
    const result = SandcastleStatusSchema.safeParse(parsed);
    if (!result.success) return null;
    if (result.data.runId !== runId) return null;
    return result.data;
  }

  return { publish, fetchPeers };
}
