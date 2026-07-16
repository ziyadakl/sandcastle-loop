/**
 * Cross-host issue lease (ADR 0019) — `releaseAllLeases()` on the lease
 * coordinator (workstream A1). Exercises the coordinator against an in-memory
 * fake {@link LockBackend} (no child_process, deterministic clock), mirroring
 * tests/issue-lease.test.ts's Part 1 patterns.
 */
import { describe, it, expect } from "vitest";

import {
  createLeaseCoordinator,
  type LockBackend,
  type LockLease,
  type LockDeps,
  type LeaseCoordinatorOpts,
} from "../.sandcastle/lib/state/issue-lease.js";

// ---------------------------------------------------------------------------
// In-memory fake backend (mirrors tests/issue-lease.test.ts), instrumented to
// count deleteRef calls per issue and, optionally, to throw on a chosen issue.
// ---------------------------------------------------------------------------

function makeFakeBackend(throwOnDelete?: Set<number>): LockBackend & {
  store: Map<number, { oid: string; lease: LockLease }>;
  deletes: number[];
} {
  const store = new Map<number, { oid: string; lease: LockLease }>();
  const deletes: number[] = [];
  let counter = 0;
  const mintOid = (issue: number) => `oid-${issue}-${++counter}`;
  return {
    store,
    deletes,
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
      deletes.push(issue);
      if (throwOnDelete?.has(issue)) {
        throw new Error(`simulated deleteRef failure for issue ${issue}`);
      }
      store.delete(issue);
    },
  };
}

const T0 = "2026-07-14T00:00:00.000Z";

function lockDepsWith(backend: LockBackend, hostId = "host-A"): LockDeps {
  return { backend, now: () => T0, hostId, ttlSec: 900 };
}

function makeCoordinator(
  backend: LockBackend,
  over: Partial<LeaseCoordinatorOpts> = {},
) {
  const dryLogCalls: unknown[][] = [];
  const errorLines: string[] = [];
  const coord = createLeaseCoordinator({
    lockDeps: lockDepsWith(backend),
    leaseEnabled: true,
    dryRun: false,
    logError: (line) => errorLines.push(line),
    dryLog: (action, ...rest) => dryLogCalls.push([action, ...rest]),
    ...over,
  });
  return { coord, dryLogCalls, errorLines };
}

describe("releaseAllLeases", () => {
  it("releases every held lease and empties the registry (both refs deleted, no double-delete)", async () => {
    const backend = makeFakeBackend();
    const { coord } = makeCoordinator(backend);

    expect(await coord.acquireIssueLease(1)).toBe(true);
    expect(await coord.acquireIssueLease(2)).toBe(true);
    expect(backend.store.size).toBe(2);

    await coord.releaseAllLeases();

    // Both refs were deleted on the backend, registry emptied.
    expect(backend.deletes.sort()).toEqual([1, 2]);
    expect(backend.store.size).toBe(0);

    // Registry is empty: a subsequent per-issue release is a no-op (no double-delete).
    await coord.releaseIssueLease(1);
    await coord.releaseIssueLease(2);
    expect(backend.deletes.sort()).toEqual([1, 2]);
  });

  it("dry-run: clears the registry via dryLog WITHOUT any backend deleteRef", async () => {
    const backend = makeFakeBackend();
    const { coord, dryLogCalls } = makeCoordinator(backend, { dryRun: true });

    await coord.acquireIssueLease(1);
    await coord.acquireIssueLease(2);

    await coord.releaseAllLeases();

    // The backend was never touched.
    expect(backend.deletes).toEqual([]);
    // The dry-run action was logged.
    expect(dryLogCalls.some((c) => c[0] === "releaseAllLeases")).toBe(true);
  });

  it("leaseEnabled=false: a pure no-op (no backend calls)", async () => {
    const backend = makeFakeBackend();
    const { coord, dryLogCalls } = makeCoordinator(backend, { leaseEnabled: false });

    await coord.releaseAllLeases();

    expect(backend.deletes).toEqual([]);
    expect(dryLogCalls).toEqual([]);
  });

  it("resilience: one failing deleteRef does not abort the rest; registry still ends empty", async () => {
    const backend = makeFakeBackend(new Set([1]));
    const { coord } = makeCoordinator(backend);

    expect(await coord.acquireIssueLease(1)).toBe(true);
    expect(await coord.acquireIssueLease(2)).toBe(true);

    // Must not throw even though issue 1's deleteRef throws.
    await coord.releaseAllLeases();

    // Both were attempted; issue 2 actually released.
    expect(backend.deletes.sort()).toEqual([1, 2]);
    expect(backend.store.has(2)).toBe(false);

    // Registry is empty regardless: subsequent per-issue releases are no-ops.
    await coord.releaseIssueLease(1);
    await coord.releaseIssueLease(2);
    expect(backend.deletes.sort()).toEqual([1, 2]);
  });
});
