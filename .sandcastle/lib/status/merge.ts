/**
 * Cross-host unified viewer — pure fold of peer snapshots into the local one.
 *
 * Two machines run the loop on one shared queue and publish their full
 * `status.json` to each other. Each host reads its peers' published snapshots
 * and folds them into ONE local merged snapshot so a viewer sees a fused,
 * host-tagged loop. `foldPeers` is that pure merge: no git, no IO, no mutation
 * of its inputs.
 */

import type {
  SandcastleStatus,
  PeerStatus,
  StatusHistoryEntry,
  StatusTotals,
} from "./schema.js";

/**
 * Field-wise sum of the local host's `totals` plus every folded peer's
 * `totals`, for DISPLAY only.
 *
 * `foldPeers` deliberately keeps the top-level `totals` OWN-host-only (a
 * load-bearing publish invariant: a host must never re-fold a peer's already
 * folded counts, or two hosts publishing to each other would double-count).
 * So the fused, whole-run count is not stored anywhere — it is computed here,
 * at the moment a unified viewer renders. Peers each carry their own `totals`
 * (`PeerStatus.totals`), so the fused count is own + Σ peers.
 *
 * Pure and non-mutating. With no peers it returns `status.totals` UNCHANGED
 * (same reference), so single-host rendering is byte-identical to pre-fusion.
 * The summed keys match `StatusTotalsSchema` exactly.
 */
export function sumTotalsAcrossHosts(status: SandcastleStatus): StatusTotals {
  const peers = status.peers;
  if (!peers || peers.length === 0) return status.totals;

  const sum: StatusTotals = { ...status.totals };
  for (const peer of peers) {
    sum.merged += peer.totals.merged;
    sum.needsHuman += peer.totals.needsHuman;
    sum.requeued += peer.totals.requeued;
    sum.running += peer.totals.running;
  }
  return sum;
}

/**
 * Max length of the MERGED cross-host history list. Unlike the per-host
 * `history` in `store.ts` (append-only, NEVER truncated), the FUSED history a
 * viewer renders combines every host's rows, so it needs a display cap. No
 * existing store/schema constant caps history (the store deliberately never
 * truncates), so this is a fresh viewer-side bound.
 */
export const MAX_MERGED_HISTORY = 50;

/**
 * Fold peers' full snapshots into `own`, returning a NEW snapshot (inputs are
 * treated as immutable). Two things change; every other top-level field of
 * `own` is preserved as-is:
 *
 *  1. `peers` — each full peer snapshot PROJECTED to a flattened `PeerStatus`.
 *     Empty peers ⇒ `undefined` (single-host stays byte-clean; no empty array).
 *  2. `history` — own's rows plus every peer's rows, each ensured host-tagged,
 *     deduped by `number|hostId|completedAt`, sorted completedAt-DESC, capped.
 */
export function foldPeers(
  own: SandcastleStatus,
  peers: SandcastleStatus[],
): SandcastleStatus {
  const projectedPeers: PeerStatus[] = peers.map((p) => ({
    hostId: p.hostId,
    state: p.state,
    activity: p.activity,
    iterations: p.run.iterations,
    totals: p.totals,
    issues: p.issues,
    updatedAt: p.updatedAt,
  }));

  const tag = (
    entry: StatusHistoryEntry,
    hostId: string,
  ): StatusHistoryEntry => ({
    ...entry,
    hostId: entry.hostId ?? hostId,
  });

  const tagged: StatusHistoryEntry[] = [
    ...own.history.map((e) => tag(e, own.hostId)),
    ...peers.flatMap((p) => p.history.map((e) => tag(e, p.hostId))),
  ];

  const seen = new Set<string>();
  const deduped: StatusHistoryEntry[] = [];
  for (const e of tagged) {
    const key = `${e.number}|${e.hostId}|${e.completedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  deduped.sort((a, b) => {
    if (a.completedAt < b.completedAt) return 1;
    if (a.completedAt > b.completedAt) return -1;
    return 0;
  });

  const history = deduped.slice(0, MAX_MERGED_HISTORY);

  return {
    ...own,
    peers: projectedPeers.length > 0 ? projectedPeers : undefined,
    history,
  };
}
