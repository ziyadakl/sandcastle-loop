/**
 * Cross-host issue lease — the real "I've got this one" signal the label flip
 * could never provide. See docs/adr/0019-cross-host-issue-lease.md.
 *
 * Two loop hosts (e.g. a VPS and a local Mac) pointed at the same GitHub repo
 * share one issue pool. Before a host works an issue it must hold that issue's
 * LEASE; a lease is a git ref `refs/locks/issue-<N>` on `origin` pointing at a
 * tiny lock-commit whose message carries holder/expiry/epoch. Creating a ref
 * that already exists is rejected atomically by GitHub — that rejection is the
 * mutual exclusion. A holder renews (heartbeat) while it works; if it dies or
 * goes silent, the lease expires and another host reclaims it. GitHub is the
 * only shared substrate; there is no coordination server.
 *
 * This module splits into:
 *   - the pure lease LOGIC (expiry decisions, epoch bumping) exercised against
 *     a fake {@link LockBackend} in tests — no child_process needed;
 *   - a concrete git-backed {@link LockBackend} whose argv is what actually
 *     touches the remote.
 *
 * STEP 0 CONTRACT: interfaces + stubs only. Wave-1 fills the impl via TDD.
 */

/** The lease record carried in the lock-commit message (one per held issue). */
export interface LockLease {
  /** Issue number this lease guards. */
  readonly issue: number;
  /** Host that owns the lease (SANDCASTLE_HOST_ID or os.hostname()). */
  readonly holder: string;
  /** ISO-8601 instant the lease was (re)acquired. */
  readonly acquiredAt: string;
  /** ISO-8601 instant after which any host may reclaim. holder_now + ttl. */
  readonly expiresAt: string;
  /** Monotonic renewal counter; doubles as a fencing token. */
  readonly epoch: number;
  /** OID of the lock-commit the ref currently points at (for CAS). */
  readonly refOid: string;
}

/**
 * The remote ref operations the lease logic needs, abstracted so the logic is
 * testable against an in-memory fake and so two `runMain` calls can share one
 * backend in the E2E. The concrete git-backed impl is {@link createGitLockBackend}.
 */
export interface LockBackend {
  /**
   * Atomically create `refs/locks/issue-<N>` pointing at a fresh lock-commit
   * carrying `lease`. Resolves `{ ok: true, oid }` on win, `{ ok: false }` if
   * the ref already exists (contended). MUST NOT overwrite an existing ref.
   */
  createRef(lease: Omit<LockLease, "refOid">): Promise<{ ok: boolean; oid?: string }>;
  /** Read the current lease, or null if the ref does not exist. */
  readRef(issue: number): Promise<LockLease | null>;
  /**
   * Compare-and-swap: move the ref to a new lock-commit carrying `lease`, only
   * if it still points at `expectedOid` (git push --force-with-lease). Resolves
   * `{ ok: false }` if the precondition failed (someone else moved/removed it).
   */
  casRef(
    expectedOid: string,
    lease: Omit<LockLease, "refOid">,
  ): Promise<{ ok: boolean; oid?: string }>;
  /** Delete `refs/locks/issue-<N>` (fast release so the next host needn't wait out the TTL). */
  deleteRef(issue: number): Promise<void>;
}

/** Ambient dependencies for the lease logic. */
export interface LockDeps {
  readonly backend: LockBackend;
  /** Injectable clock (mirror status/store.ts). Returns an ISO-8601 string. */
  readonly now: () => string;
  /** This host's identity, written into every lease it holds. */
  readonly hostId: string;
  /** Lease lifetime in seconds (default 900 = 15 min; renew at ~ttl/3). */
  readonly ttlSec: number;
}

/**
 * Clock-skew grace, in seconds, that a reclaimer waits PAST a lease's
 * `expiresAt` before it considers the lease dead and eligible to steal. Two
 * hosts never share a clock; without this margin a host whose clock runs a
 * couple seconds fast could yank a lease the holder still believes is live.
 * Small enough to keep reclaim latency low, large enough to swallow ordinary
 * NTP drift between the VPS and the Mac.
 */
export const LEASE_SKEW_GRACE_SEC = 5;

/** Add `seconds` to an ISO-8601 instant, returning a fresh ISO-8601 string. */
function isoPlusSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/**
 * Decide whether a lease whose `expiresAt` is `expiresAt` is reclaimable as of
 * `nowIso`. True only once `now` is at or past `expiresAt` PLUS the skew grace.
 * Uses a numeric instant compare (Date.parse → epoch ms), never a lexical
 * string compare — the grace margin makes lexical comparison wrong.
 */
function isExpired(expiresAt: string, nowIso: string): boolean {
  const nowMs = Date.parse(nowIso);
  const deadlineMs = Date.parse(expiresAt) + LEASE_SKEW_GRACE_SEC * 1000;
  return nowMs >= deadlineMs;
}

/**
 * The single source of truth for lease expiry classification, so callers (the
 * loop driver) never re-implement the skew-grace math. `null` ⇒ `"absent"`;
 * otherwise apply the SAME `now >= expiresAt + LEASE_SKEW_GRACE_SEC` rule as
 * {@link reclaimIfExpired}: past-deadline ⇒ `"expired"`, else `"live"`.
 *
 * A present-but-UNREADABLE ref is NOT representable here (a null lease means
 * "no ref"); the read path signals that fail-closed by throwing
 * {@link LeaseReadError}, which consumers treat as `"live"` (occupied).
 */
export function classifyLease(
  lease: LockLease | null,
  nowIso: string,
): "absent" | "live" | "expired" {
  if (lease === null) return "absent";
  return isExpired(lease.expiresAt, nowIso) ? "expired" : "live";
}

/**
 * Try to take the lease for `issue`. Resolves the new {@link LockLease} on
 * success, or null if another live host already holds it (contended).
 */
export async function acquireLease(
  issue: number,
  deps: LockDeps,
): Promise<LockLease | null> {
  const now = deps.now();
  const candidate: Omit<LockLease, "refOid"> = {
    issue,
    holder: deps.hostId,
    acquiredAt: now,
    expiresAt: isoPlusSeconds(now, deps.ttlSec),
    epoch: 1,
  };
  const res = await deps.backend.createRef(candidate);
  if (!res.ok || !res.oid) return null;
  return { ...candidate, refOid: res.oid };
}

/** Read the current lease for `issue` without mutating anything. */
export async function readLease(
  issue: number,
  deps: LockDeps,
): Promise<LockLease | null> {
  return deps.backend.readRef(issue);
}

/**
 * If the issue's lease has expired (now >= expiresAt + skew grace), attempt to
 * reclaim it via CAS. Resolves the new lease on a winning reclaim, or null if
 * the lease is still live, absent, or another reclaimer won the race.
 */
export async function reclaimIfExpired(
  issue: number,
  deps: LockDeps,
): Promise<LockLease | null> {
  const current = await deps.backend.readRef(issue);
  if (!current) return null; // no ref — nothing to reclaim
  const now = deps.now();
  if (!isExpired(current.expiresAt, now)) return null; // still live — no steal
  const candidate: Omit<LockLease, "refOid"> = {
    issue,
    holder: deps.hostId,
    acquiredAt: now,
    expiresAt: isoPlusSeconds(now, deps.ttlSec),
    epoch: current.epoch + 1,
  };
  // CAS from the oid we just read; if another reclaimer moved it first the
  // precondition fails and we back off.
  const res = await deps.backend.casRef(current.refOid, candidate);
  if (!res.ok || !res.oid) return null;
  return { ...candidate, refOid: res.oid };
}

/**
 * Heartbeat: push the lease forward (bump expiresAt + epoch) via CAS from the
 * lease we believe we hold. Resolves the renewed lease, or null if the CAS
 * failed — meaning we LOST the lease and must abort the issue immediately.
 */
export async function renewLease(
  lease: LockLease,
  deps: LockDeps,
): Promise<LockLease | null> {
  const now = deps.now();
  const candidate: Omit<LockLease, "refOid"> = {
    issue: lease.issue,
    holder: lease.holder,
    acquiredAt: lease.acquiredAt, // heartbeat, not a re-acquire — keep it
    expiresAt: isoPlusSeconds(now, deps.ttlSec),
    epoch: lease.epoch + 1,
  };
  const res = await deps.backend.casRef(lease.refOid, candidate);
  if (!res.ok || !res.oid) return null; // LEASE LOST — fencing signal
  return { ...candidate, refOid: res.oid };
}

/** Release the lease for `issue` by deleting its ref. Best-effort. */
export async function releaseLease(
  issue: number,
  deps: LockDeps,
): Promise<void> {
  await deps.backend.deleteRef(issue);
}

/** How the git-backed backend shells out. Mirrors main.mts runGit's shape. */
export interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}
export type GitRunner = (
  cwd: string,
  ...args: string[]
) => GitRunResult | Promise<GitRunResult>;

/** Options for the concrete git-backed backend. */
export interface GitLockBackendOpts {
  readonly git: GitRunner;
  readonly repoRoot: string;
  /** Remote to push locks to (default "origin"). */
  readonly remote?: string;
}

/**
 * The well-known SHA-1 of git's empty tree. Every lock-commit points at it —
 * a lock carries no content, only its message. Avoids a `hash-object` round
 * trip and is stable across all git installs.
 */
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Ref name a given issue's lease lives at. */
function lockRef(issue: number): string {
  return `refs/locks/issue-${issue}`;
}

/**
 * Serialize a lease into a lock-commit message: a single compact-JSON line.
 * `refOid` is intentionally NOT stored — the ref itself IS the oid, so writing
 * it would be a lie the moment the ref moved.
 */
function serializeLease(lease: Omit<LockLease, "refOid">): string {
  return JSON.stringify({
    issue: lease.issue,
    holder: lease.holder,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    epoch: lease.epoch,
  });
}

/**
 * Parse a lock-commit message body back into a lease (minus `refOid`, which the
 * caller supplies from the ref). Tolerant of trailing whitespace/newlines that
 * `git log -1 --format=%B` appends; scans for the JSON object.
 */
function parseLease(body: string, refOid: string): LockLease | null {
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const raw = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    if (
      typeof raw.issue !== "number" ||
      typeof raw.holder !== "string" ||
      typeof raw.acquiredAt !== "string" ||
      typeof raw.expiresAt !== "string" ||
      typeof raw.epoch !== "number"
    ) {
      return null;
    }
    return {
      issue: raw.issue,
      holder: raw.holder,
      acquiredAt: raw.acquiredAt,
      expiresAt: raw.expiresAt,
      epoch: raw.epoch,
      refOid,
    };
  } catch {
    return null;
  }
}

/**
 * A git operation that touches the remote lock ref failed for a reason that is
 * NOT lease contention — an auth/network/config fault (e.g. a missing
 * `gh auth setup-git`, a DNS failure, a 403). Carries the offending git
 * `stderr` so the caller can surface the real problem instead of mistaking it
 * for a phantom rival holding the lease. Mirrors the plain `Error` that
 * `makeLockCommit` already throws on a commit-tree failure.
 */
export class LeaseBackendError extends Error {
  /** The raw git stderr (may be empty when git said nothing useful). */
  readonly stderr: string;
  constructor(stderr: string, message?: string) {
    super(message ?? `lease backend git failure: ${stderr || "(no stderr)"}`);
    this.name = "LeaseBackendError";
    this.stderr = stderr;
  }
}

/**
 * The lock ref EXISTS on the remote but its lock-commit could not be read or
 * parsed (a transient fetch/log fault, a moved ref, a malformed body). Thrown
 * fail-closed so a present-but-unreadable ref is NEVER mistaken for an absent
 * one: consumers treat this as an OCCUPIED (live) lease, never as free.
 */
export class LeaseReadError extends Error {
  /** Issue whose lock ref could not be read. */
  readonly issue: number;
  constructor(issue: number, reason: string) {
    super(`lease ref for issue ${issue} exists but is unreadable: ${reason}`);
    this.name = "LeaseReadError";
    this.issue = issue;
  }
}

/**
 * Contention signatures git emits when a push is rejected because a PEER holds
 * (or just moved) the ref — the normal mutual-exclusion outcome that upstream
 * reads as `{ ok: false }`. Matched case-insensitively as substrings.
 */
const CONTENTION_SIGNATURES: readonly string[] = [
  "[rejected]",
  "rejected",
  "non-fast-forward",
  "fetch first",
  "failed to push some refs",
  "cannot lock ref",
  "stale info",
  "updates were rejected",
  "[remote rejected]",
];

/**
 * Classify a FAILED push. `true` ⇒ ordinary lease contention (return
 * `{ ok: false }`). `false` ⇒ an auth/network/unknown fault the caller must
 * raise as a {@link LeaseBackendError}. An EMPTY/unrecognized stderr is NOT
 * contention (fail-closed: never silently treat an unknown failure as
 * contended).
 */
function isContentionFailure(res: GitRunResult): boolean {
  const text = `${res.stderr}\n${res.stdout}`.toLowerCase();
  return CONTENTION_SIGNATURES.some((sig) => text.includes(sig));
}

/**
 * Build a {@link LockBackend} that stores leases as `refs/locks/issue-<N>` on
 * the remote, using local `git commit-tree` for the lock-commit and
 * `git push`/`git ls-remote`/`git push --force-with-lease` for the ref ops.
 *
 * The mutual exclusion is git's own: a lock-commit is PARENTLESS, so pushing it
 * to a ref that already exists is never a fast-forward and git rejects it —
 * that rejection IS the "someone else has this issue" signal. CAS uses
 * `--force-with-lease` so a renew/reclaim only lands if the ref still points
 * where we think it does.
 */
export function createGitLockBackend(opts: GitLockBackendOpts): LockBackend {
  const remote = opts.remote ?? "origin";
  const run = (...args: string[]): GitRunResult | Promise<GitRunResult> =>
    opts.git(opts.repoRoot, ...args);

  /** Create a fresh parentless lock-commit carrying `lease`; return its oid. */
  async function makeLockCommit(lease: Omit<LockLease, "refOid">): Promise<string> {
    // -c user.* keeps commit-tree from failing on hosts without a git identity.
    const res = await run(
      "-c",
      "user.name=sandcastle-lock",
      "-c",
      "user.email=lock@sandcastle.local",
      "commit-tree",
      EMPTY_TREE_OID,
      "-m",
      serializeLease(lease),
    );
    if (!res.ok || !res.stdout) {
      throw new Error(`lock commit-tree failed: ${res.stderr || "no oid returned"}`);
    }
    return res.stdout.trim();
  }

  /** Resolve the remote oid for an issue's lock ref, or null if absent. */
  async function remoteOid(issue: number): Promise<string | null> {
    const res = await run("ls-remote", remote, lockRef(issue));
    if (!res.ok) return null;
    const line = res.stdout.split("\n").find((l) => l.trim().length > 0);
    if (!line) return null;
    const oid = line.split(/\s+/)[0];
    return oid && oid.length > 0 ? oid : null;
  }

  return {
    async createRef(lease) {
      const oid = await makeLockCommit(lease);
      // Non-force push of a parentless commit: creates the ref if absent, is
      // rejected as non-fast-forward if the ref already exists (contended).
      const res = await run("push", remote, `${oid}:${lockRef(lease.issue)}`);
      if (!res.ok) {
        // Only a contention-shaped rejection means "a peer has this issue";
        // an auth/network fault must surface, not masquerade as a rival.
        if (isContentionFailure(res)) return { ok: false };
        throw new LeaseBackendError(res.stderr);
      }
      return { ok: true, oid };
    },

    async readRef(issue) {
      const oid = await remoteOid(issue);
      if (!oid) return null; // ref genuinely absent — nothing here
      // The ref EXISTS; from here a failure is fail-closed (occupied), never
      // treated as absent. The lock-commit may live only on the remote; fetch
      // the object in first.
      await run("fetch", "--quiet", remote, lockRef(issue));
      const body = await run("log", "-1", "--format=%B", oid);
      if (!body.ok) {
        throw new LeaseReadError(issue, body.stderr || "git log of lock-commit failed");
      }
      const lease = parseLease(body.stdout, oid);
      if (!lease) {
        throw new LeaseReadError(issue, "lock-commit body was not a parseable lease");
      }
      return lease;
    },

    async casRef(expectedOid, lease) {
      const oid = await makeLockCommit(lease);
      // --force-with-lease with an explicit expected value: the push only lands
      // if the remote ref still points at expectedOid; otherwise it's rejected.
      const res = await run(
        "push",
        `--force-with-lease=${lockRef(lease.issue)}:${expectedOid}`,
        remote,
        `${oid}:${lockRef(lease.issue)}`,
      );
      if (!res.ok) {
        // Same classification as createRef: a stale-lease/non-fast-forward
        // rejection is contention; anything else is a real backend fault.
        if (isContentionFailure(res)) return { ok: false };
        throw new LeaseBackendError(res.stderr);
      }
      return { ok: true, oid };
    },

    async deleteRef(issue) {
      await run("push", remote, `:${lockRef(issue)}`);
    },
  };
}
