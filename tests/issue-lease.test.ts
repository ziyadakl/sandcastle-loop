/**
 * Cross-host issue lease (ADR 0019) — unit + integration tests.
 *
 * Part 1 exercises the pure lease LOGIC against an in-memory fake
 * {@link LockBackend} (no child_process, deterministic clock).
 *
 * Part 2 exercises the concrete git-backed {@link LockBackend} against a REAL
 * local bare repo (offline, real git semantics — NEVER the real origin).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  acquireLease,
  readLease,
  reclaimIfExpired,
  renewLease,
  releaseLease,
  createGitLockBackend,
  classifyLease,
  LeaseBackendError,
  LeaseReadError,
  LEASE_SKEW_GRACE_SEC,
  type LockBackend,
  type LockLease,
  type LockDeps,
  type GitRunner,
  type GitRunResult,
} from "../src/state/issue-lease.js";

// ---------------------------------------------------------------------------
// In-memory fake backend
// ---------------------------------------------------------------------------

/**
 * A minimal in-memory {@link LockBackend}: a Map of issue → {oid, lease}.
 * `createRef` fails if the key is already present (atomic create); `casRef`
 * checks the expected oid before moving the ref. Mirrors the git backend's
 * observable semantics without touching git.
 */
function makeFakeBackend(): LockBackend & { store: Map<number, { oid: string; lease: LockLease }> } {
  const store = new Map<number, { oid: string; lease: LockLease }>();
  let counter = 0;
  const mintOid = (issue: number) => `oid-${issue}-${++counter}`;
  return {
    store,
    async createRef(lease) {
      if (store.has(lease.issue)) return { ok: false };
      const oid = mintOid(lease.issue);
      store.set(lease.issue, { oid, lease: { ...lease, refOid: oid } });
      return { ok: true, oid };
    },
    async readRef(issue) {
      const entry = store.get(issue);
      return entry ? entry.lease : null;
    },
    async casRef(expectedOid, lease) {
      const entry = store.get(lease.issue);
      if (!entry || entry.oid !== expectedOid) return { ok: false };
      const oid = mintOid(lease.issue);
      store.set(lease.issue, { oid, lease: { ...lease, refOid: oid } });
      return { ok: true, oid };
    },
    async deleteRef(issue) {
      store.delete(issue);
    },
  };
}

const T0 = "2026-07-14T00:00:00.000Z";
const T0_PLUS_TTL = "2026-07-14T00:15:00.000Z"; // T0 + 900s

function depsWith(backend: LockBackend, now: string, hostId = "host-A"): LockDeps {
  return { backend, now: () => now, hostId, ttlSec: 900 };
}

describe("Part 1 — pure lease logic (fake backend)", () => {
  describe("acquireLease", () => {
    it("uncontended: returns a fresh lease with epoch 1 and a refOid", async () => {
      const backend = makeFakeBackend();
      const lease = await acquireLease(42, depsWith(backend, T0));
      expect(lease).not.toBeNull();
      expect(lease).toMatchObject({
        issue: 42,
        holder: "host-A",
        acquiredAt: T0,
        expiresAt: T0_PLUS_TTL,
        epoch: 1,
      });
      expect(lease!.refOid).toBeTruthy();
    });

    it("contended: a second acquire on the held issue returns null", async () => {
      const backend = makeFakeBackend();
      const first = await acquireLease(42, depsWith(backend, T0, "host-A"));
      expect(first).not.toBeNull();
      const second = await acquireLease(42, depsWith(backend, T0, "host-B"));
      expect(second).toBeNull();
    });
  });

  describe("readLease", () => {
    it("returns the current lease, or null when absent", async () => {
      const backend = makeFakeBackend();
      expect(await readLease(7, depsWith(backend, T0))).toBeNull();
      await acquireLease(7, depsWith(backend, T0));
      const lease = await readLease(7, depsWith(backend, T0));
      expect(lease).toMatchObject({ issue: 7, holder: "host-A", epoch: 1 });
    });
  });

  describe("reclaimIfExpired", () => {
    it("returns null when the ref is absent", async () => {
      const backend = makeFakeBackend();
      expect(await reclaimIfExpired(1, depsWith(backend, T0))).toBeNull();
    });

    it("returns null (no steal) while the lease is still live", async () => {
      const backend = makeFakeBackend();
      await acquireLease(1, depsWith(backend, T0, "host-A"));
      // now < expiresAt
      const beforeExpiry = "2026-07-14T00:10:00.000Z";
      expect(await reclaimIfExpired(1, depsWith(backend, beforeExpiry, "host-B"))).toBeNull();
    });

    it("reclaims via CAS once expired (past the skew grace), bumping the epoch", async () => {
      const backend = makeFakeBackend();
      await acquireLease(1, depsWith(backend, T0, "host-A"));
      // expiresAt = T0+900s; expired only at expiresAt + grace.
      const wellPast = "2026-07-14T00:20:00.000Z";
      const reclaimed = await reclaimIfExpired(1, depsWith(backend, wellPast, "host-B"));
      expect(reclaimed).not.toBeNull();
      expect(reclaimed).toMatchObject({
        issue: 1,
        holder: "host-B",
        acquiredAt: wellPast,
        expiresAt: "2026-07-14T00:35:00.000Z",
        epoch: 2,
      });
    });

    it("skew grace boundary: not expired one ms before expiresAt+grace, expired at it", async () => {
      // expiresAt = T0+900s = 00:15:00.000; grace pushes the steal-line out.
      const graceMs = LEASE_SKEW_GRACE_SEC * 1000;
      const expiresMs = Date.parse(T0_PLUS_TTL);
      const justBefore = new Date(expiresMs + graceMs - 1).toISOString();
      const exactly = new Date(expiresMs + graceMs).toISOString();

      const b1 = makeFakeBackend();
      await acquireLease(1, depsWith(b1, T0, "host-A"));
      expect(await reclaimIfExpired(1, depsWith(b1, justBefore, "host-B"))).toBeNull();

      const b2 = makeFakeBackend();
      await acquireLease(1, depsWith(b2, T0, "host-A"));
      expect(await reclaimIfExpired(1, depsWith(b2, exactly, "host-B"))).not.toBeNull();
    });

    it("returns null when the CAS fails (another reclaimer moved the ref first)", async () => {
      const backend = makeFakeBackend();
      await acquireLease(1, depsWith(backend, T0, "host-A"));
      const wellPast = "2026-07-14T00:20:00.000Z";
      // Simulate a racing reclaimer moving the ref out from under us: mutate the
      // stored oid so our CAS expectedOid is stale.
      const entry = backend.store.get(1)!;
      backend.store.set(1, { oid: "someone-else-moved-it", lease: entry.lease });
      expect(await reclaimIfExpired(1, depsWith(backend, wellPast, "host-B"))).toBeNull();
    });
  });

  describe("renewLease", () => {
    it("CAS from the held refOid: pushes expiresAt forward and bumps the epoch", async () => {
      const backend = makeFakeBackend();
      const held = (await acquireLease(1, depsWith(backend, T0, "host-A")))!;
      const later = "2026-07-14T00:05:00.000Z";
      const renewed = await renewLease(held, depsWith(backend, later, "host-A"));
      expect(renewed).not.toBeNull();
      expect(renewed).toMatchObject({
        issue: 1,
        holder: "host-A",
        expiresAt: "2026-07-14T00:20:00.000Z", // later + ttl
        epoch: 2,
      });
      expect(renewed!.refOid).not.toBe(held.refOid);
    });

    it("returns null when the CAS fails — the LEASE-LOST fencing signal", async () => {
      const backend = makeFakeBackend();
      const held = (await acquireLease(1, depsWith(backend, T0, "host-A")))!;
      // Someone stole/moved the ref: our refOid is now stale.
      const entry = backend.store.get(1)!;
      backend.store.set(1, { oid: "stolen", lease: entry.lease });
      const later = "2026-07-14T00:05:00.000Z";
      expect(await renewLease(held, depsWith(backend, later, "host-A"))).toBeNull();
    });
  });

  describe("releaseLease", () => {
    it("deletes the ref (subsequent read is null)", async () => {
      const backend = makeFakeBackend();
      await acquireLease(1, depsWith(backend, T0, "host-A"));
      await releaseLease(1, depsWith(backend, T0, "host-A"));
      expect(await readLease(1, depsWith(backend, T0))).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Part 2 — git-backed backend against a REAL bare repo
// ---------------------------------------------------------------------------

/** Tiny local git runner mirroring main.mts:1589's shape. */
function realRunGit(cwd: string, ...args: string[]): GitRunResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
    return { ok: false, stdout: stdout.trim(), stderr: stderr.trim() || e.message };
  }
}

describe("Part 2 — git-backed backend (real bare repo)", () => {
  let tmp: string;
  let remote: string;
  let clone: string;
  let backend: LockBackend;

  const lease = (issue: number, over: Partial<Omit<LockLease, "refOid">> = {}) => ({
    issue,
    holder: "host-A",
    acquiredAt: T0,
    expiresAt: T0_PLUS_TTL,
    epoch: 1,
    ...over,
  });

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sandcastle-lock-"));
    remote = path.join(tmp, "remote.git");
    clone = path.join(tmp, "clone");
    realRunGit(tmp, "init", "--bare", remote);
    realRunGit(tmp, "clone", remote, clone);
    // Seed one commit so the clone has a HEAD (not strictly required for locks,
    // but keeps the working repo realistic).
    realRunGit(clone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "seed");
    realRunGit(clone, "push", "origin", "HEAD");
    backend = createGitLockBackend({ git: realRunGit, repoRoot: clone, remote });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("createRef creates refs/locks/issue-N; a second create is rejected (atomic mutex)", async () => {
    const first = await backend.createRef(lease(5));
    expect(first.ok).toBe(true);
    expect(first.oid).toBeTruthy();

    // The ref exists on the bare remote.
    const ls = realRunGit(clone, "ls-remote", remote, "refs/locks/issue-5");
    expect(ls.stdout).toContain("refs/locks/issue-5");
    expect(ls.stdout).toContain(first.oid!);

    // A second create for the same issue must be rejected.
    const second = await backend.createRef(lease(5, { holder: "host-B" }));
    expect(second.ok).toBe(false);
  });

  it("readRef round-trips the lease carried in the lock-commit message", async () => {
    await backend.createRef(lease(9, { holder: "host-Z", epoch: 3, expiresAt: "2026-07-14T01:00:00.000Z" }));
    const read = await backend.readRef(9);
    expect(read).not.toBeNull();
    expect(read).toMatchObject({
      issue: 9,
      holder: "host-Z",
      acquiredAt: T0,
      expiresAt: "2026-07-14T01:00:00.000Z",
      epoch: 3,
    });
    expect(read!.refOid).toBeTruthy();
  });

  it("readRef returns null when the lock ref does not exist", async () => {
    expect(await backend.readRef(404)).toBeNull();
  });

  it("casRef with the correct expectedOid moves the ref; a stale expectedOid is rejected", async () => {
    const created = await backend.createRef(lease(11));
    expect(created.ok).toBe(true);
    const oldOid = created.oid!;

    // Correct CAS moves it.
    const moved = await backend.casRef(oldOid, lease(11, { epoch: 2, holder: "host-A" }));
    expect(moved.ok).toBe(true);
    expect(moved.oid).toBeTruthy();
    expect(moved.oid).not.toBe(oldOid);

    const afterMove = realRunGit(clone, "ls-remote", remote, "refs/locks/issue-11");
    expect(afterMove.stdout).toContain(moved.oid!);
    expect(afterMove.stdout).not.toContain(oldOid);

    // A STALE CAS (still expecting the old oid) is rejected and leaves it put.
    const stale = await backend.casRef(oldOid, lease(11, { epoch: 3 }));
    expect(stale.ok).toBe(false);
    const unmoved = realRunGit(clone, "ls-remote", remote, "refs/locks/issue-11");
    expect(unmoved.stdout).toContain(moved.oid!);
  });

  it("deleteRef removes the ref (subsequent readRef → null)", async () => {
    await backend.createRef(lease(13));
    expect(await backend.readRef(13)).not.toBeNull();
    await backend.deleteRef(13);
    expect(await backend.readRef(13)).toBeNull();
    const ls = realRunGit(clone, "ls-remote", remote, "refs/locks/issue-13");
    expect(ls.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Part 3 — Fix 2 (push-failure classification), Fix 6 (classifyLease),
//          Fix 7 (readRef fail-closed). Uses a STUB GitRunner to inject
//          deterministic git failures without touching a real remote.
// ---------------------------------------------------------------------------

const leaseOf = (
  issue: number,
  over: Partial<Omit<LockLease, "refOid">> = {},
): Omit<LockLease, "refOid"> => ({
  issue,
  holder: "host-A",
  acquiredAt: T0,
  expiresAt: T0_PLUS_TTL,
  epoch: 1,
  ...over,
});

/**
 * A configurable stub git runner. Answers the four argv shapes the git backend
 * emits (commit-tree, ls-remote, fetch, log, push) from canned results so a
 * test can force an auth/contention/read failure deterministically.
 */
function makeStubRunner(opts: {
  pushResult?: GitRunResult;
  logResult?: GitRunResult;
  lsRemoteOid?: string | null;
  calls?: string[][];
}): GitRunner {
  return (_cwd: string, ...args: string[]): GitRunResult => {
    opts.calls?.push(args);
    if (args.includes("commit-tree")) {
      return { ok: true, stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", stderr: "" };
    }
    if (args[0] === "ls-remote") {
      const oid = opts.lsRemoteOid ?? null;
      return oid
        ? { ok: true, stdout: `${oid}\trefs/locks/issue`, stderr: "" }
        : { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "fetch") return { ok: true, stdout: "", stderr: "" };
    if (args[0] === "log") return opts.logResult ?? { ok: true, stdout: "{}", stderr: "" };
    if (args[0] === "push") return opts.pushResult ?? { ok: true, stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
}

const stubBackend = (opts: Parameters<typeof makeStubRunner>[0]): LockBackend =>
  createGitLockBackend({ git: makeStubRunner(opts), repoRoot: "/nonexistent", remote: "origin" });

describe("Part 3a — Fix 2: push-failure classification (createRef / casRef)", () => {
  const CONTENTION = "! [rejected]        main -> main (non-fast-forward)\nUpdates were rejected because the remote contains work you do not have";
  const AUTH = "fatal: Authentication failed for 'https://github.com/acme/repo.git/'";

  it("createRef: a contention-shaped rejection returns { ok: false } (NOT a throw)", async () => {
    const backend = stubBackend({ pushResult: { ok: false, stdout: "", stderr: CONTENTION } });
    const res = await backend.createRef(leaseOf(5));
    expect(res.ok).toBe(false);
  });

  it("createRef: an auth/network-shaped failure throws LeaseBackendError carrying the stderr", async () => {
    const backend = stubBackend({ pushResult: { ok: false, stdout: "", stderr: AUTH } });
    await expect(backend.createRef(leaseOf(5))).rejects.toBeInstanceOf(LeaseBackendError);
    const err = await backend.createRef(leaseOf(5)).catch((e) => e);
    expect(err).toBeInstanceOf(LeaseBackendError);
    expect((err as LeaseBackendError).stderr).toContain("Authentication failed");
  });

  it("createRef: an EMPTY/unrecognized stderr on a failed push throws (fail-closed)", async () => {
    const backend = stubBackend({ pushResult: { ok: false, stdout: "", stderr: "" } });
    await expect(backend.createRef(leaseOf(5))).rejects.toBeInstanceOf(LeaseBackendError);
  });

  it("casRef: a contention-shaped rejection returns { ok: false } (NOT a throw)", async () => {
    const backend = stubBackend({ pushResult: { ok: false, stdout: "", stderr: CONTENTION } });
    const res = await backend.casRef("oldoid", leaseOf(5, { epoch: 2 }));
    expect(res.ok).toBe(false);
  });

  it("casRef: an auth/network-shaped failure throws LeaseBackendError carrying the stderr", async () => {
    const backend = stubBackend({ pushResult: { ok: false, stdout: "", stderr: AUTH } });
    const err = await backend.casRef("oldoid", leaseOf(5, { epoch: 2 })).catch((e) => e);
    expect(err).toBeInstanceOf(LeaseBackendError);
    expect((err as LeaseBackendError).stderr).toContain("Authentication failed");
  });

  it("casRef: an EMPTY stderr on a failed push throws (fail-closed)", async () => {
    const backend = stubBackend({ pushResult: { ok: false, stdout: "", stderr: "" } });
    await expect(backend.casRef("oldoid", leaseOf(5, { epoch: 2 }))).rejects.toBeInstanceOf(
      LeaseBackendError,
    );
  });
});

describe("Part 3b — Fix 6: classifyLease (single source of truth for expiry)", () => {
  const live: LockLease = {
    issue: 1,
    holder: "host-A",
    acquiredAt: T0,
    expiresAt: T0_PLUS_TTL,
    epoch: 1,
    refOid: "oid",
  };

  it("null lease classifies as absent", () => {
    expect(classifyLease(null, T0)).toBe("absent");
  });

  it("a lease whose deadline+grace is in the future classifies as live", () => {
    expect(classifyLease(live, T0)).toBe("live");
  });

  it("skew-grace boundary: live one ms before expiresAt+grace, expired exactly at it", () => {
    const graceMs = LEASE_SKEW_GRACE_SEC * 1000;
    const expiresMs = Date.parse(T0_PLUS_TTL);
    const justBefore = new Date(expiresMs + graceMs - 1).toISOString();
    const exactly = new Date(expiresMs + graceMs).toISOString();
    expect(classifyLease(live, justBefore)).toBe("live");
    expect(classifyLease(live, exactly)).toBe("expired");
  });
});

describe("Part 3c — Fix 7: readRef fail-closed (present-but-unreadable != absent)", () => {
  it("genuinely absent ref (ls-remote empty) resolves to null → absent", async () => {
    const backend = stubBackend({ lsRemoteOid: null });
    const read = await backend.readRef(9);
    expect(read).toBeNull();
    expect(classifyLease(read, T0)).toBe("absent");
  });

  it("present ref but unreadable body (log fails) throws LeaseReadError (occupied, not absent)", async () => {
    const backend = stubBackend({
      lsRemoteOid: "abc123abc123abc123abc123abc123abc123abcd",
      logResult: { ok: false, stdout: "", stderr: "fatal: bad object abc123" },
    });
    await expect(backend.readRef(9)).rejects.toBeInstanceOf(LeaseReadError);
  });

  it("present ref but unparseable body throws LeaseReadError (fail-closed, not absent)", async () => {
    const backend = stubBackend({
      lsRemoteOid: "abc123abc123abc123abc123abc123abc123abcd",
      logResult: { ok: true, stdout: "not a lock commit at all", stderr: "" },
    });
    await expect(backend.readRef(9)).rejects.toBeInstanceOf(LeaseReadError);
  });

  it("reclaimIfExpired NEVER steals a ref it could not read (no push attempted)", async () => {
    const calls: string[][] = [];
    const backend = stubBackend({
      lsRemoteOid: "abc123abc123abc123abc123abc123abc123abcd",
      logResult: { ok: false, stdout: "", stderr: "fatal: bad object abc123" },
      calls,
    });
    const deps: LockDeps = {
      backend,
      now: () => "2026-07-14T00:20:00.000Z",
      hostId: "host-B",
      ttlSec: 900,
    };
    await expect(reclaimIfExpired(1, deps)).rejects.toBeInstanceOf(LeaseReadError);
    expect(calls.some((a) => a[0] === "push")).toBe(false);
  });
});
