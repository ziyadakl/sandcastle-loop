/**
 * Cross-host RUN + STATUS SYNC helpers (ADR 0019 / 0020).
 *
 * Two self-contained pieces of cross-host telemetry logic, lifted out of
 * `main.mts` so they can be read and tested in isolation:
 *
 *   - {@link deriveRunBranchAndId} — the pure branch/runId derivation rule.
 *   - {@link syncStatusOnce} — the one-pass publish/fetch/fold status step.
 *
 * Both are fully dependency-injected (no git / env / os reads of their own), so
 * they are unit-tested directly.
 */

import type { StatusStore } from "./store.js";
import type { SandcastleStatus } from "./schema.js";

/**
 * The `Deps` subset {@link syncStatusOnce} needs. `main.mts`'s full `Deps`
 * interface is structurally a superset, so it passes here unchanged.
 */
export interface StatusSyncDeps {
  publishStatus(snapshotJson: string): Promise<{ ok: boolean; error?: string }>;
  fetchStatusPeers(runId: string): Promise<SandcastleStatus[]>;
  logError(line: string): void;
}

export type { StatusStore };

/**
 * Derive the run's git `branch` and its shared `runId` from the raw inputs.
 *
 * RULE (ADR 0019 / Task S2): hosts cooperating on ONE shared queue must derive
 * the SAME `runId` so a cross-host viewer folds their snapshots, while each
 * host's `branch` stays distinct so two hosts never push the same run branch
 * and clobber each other.
 *
 * - explicit `--branch` (`explicitBranch` set): the operator's word — `branch`
 *   and `runId` are both that value, never suffixed (even with the lease ON).
 * - auto-derived + lease OFF: `branch === runId === derived` (byte-for-byte
 *   legacy behavior).
 * - auto-derived + lease ON: `branch` is host-suffixed (`<derived>-<hostId>`)
 *   but `runId` is the bare `derived` name shared across hosts.
 *
 * Pure and fully injectable (no git / env / os reads) so the rule is unit
 * tested directly.
 */
export function deriveRunBranchAndId(
  explicitBranch: string | undefined,
  derived: string,
  leaseEnabled: boolean,
  hostId: string,
): { branch: string; runId: string } {
  if (explicitBranch !== undefined) {
    return { branch: explicitBranch, runId: explicitBranch };
  }
  return {
    branch: leaseEnabled ? `${derived}-${hostId}` : derived,
    runId: derived,
  };
}

/**
 * Cross-host STATUS SYNC — ONE deterministic pass (Task S5, ADR 0020). Called
 * once per iteration from the `syncEnabled` hook in `runMain` (the 30s
 * lease-heartbeat timer would never fire in a fast run/test, so the per-loop
 * call is the deterministic trigger). Publishes THIS host's own snapshot to its
 * status ref, fetches same-run peers, and folds them into the LOCAL status.json
 * (via `statusStore.setPeers`) so a viewer sees one fused, host-tagged loop.
 *
 * Observability ONLY: every step FAILS SOFT. `deps.publishStatus` /
 * `deps.fetchStatusPeers` never throw (fail-soft lives inside status-sync.ts),
 * and a `{ ok: false }` publish is logged then execution STILL reaches the fetch
 * + fold — a publish glitch must not stop this host from SHOWING its peers.
 * Never called on the flag-off path.
 */
export async function syncStatusOnce(
  statusStore: StatusStore,
  deps: StatusSyncDeps,
): Promise<void> {
  // `snapshot()` is own-only (no `peers` key) — that is what we PUBLISH, so
  // peers never re-fold each other's folds.
  const ownSnapshot = statusStore.snapshot();
  const pub = await deps.publishStatus(JSON.stringify(ownSnapshot));
  if (!pub.ok) {
    deps.logError(
      `[status] publish failed: ${pub.error ?? "(no detail)"} — continuing`,
    );
  }
  const peers = await deps.fetchStatusPeers(ownSnapshot.runId);
  statusStore.setPeers(peers);
}
