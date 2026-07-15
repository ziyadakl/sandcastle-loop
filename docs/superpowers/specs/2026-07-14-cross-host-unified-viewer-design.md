# Cross-host unified viewer — design (Step 3)

**Date:** 2026-07-14
**Status:** approved (brainstorm), pending implementation plan
**Branch:** built on top of `feat/cross-host-issue-lease` (merged as one with Step 1/2 per user decision)
**Related:** ADR 0019 (issue lease), ADR 0020 (code sync). This is "Step 3": show two cooperating hosts as ONE loop in the viewer.

## Problem

The loop can run on two machines against one shared queue (cross-host, ADR 0019/0020). But status is per-machine: each host writes its own local `.sandcastle/status.json`, which has no host identity and no shared-run marker. Worse, in cross-host mode each host's git branch is deliberately suffixed `-<hostId>` (main.mts:813-818) to avoid collisions, so the one field a viewer might correlate on is split apart. Result: two machines cooperating on one queue show as two independent, uncorrelated status streams. The terminal viewer reads one local file; the t3 viewer keys every card by `${environmentId}::${cwd}` and shows one card per environment. **There is no way to see both machines as one loop.** This feature adds it.

## Goal

One fused loop view — a single **machine-tagged stream**: combined totals, a per-machine iteration line, an "In progress" list unioning both machines' current issues (each badged `[Mac]`/`[VPS]`), and a merged "Recent" history sorted by time and tagged by machine. Reachable from a viewer pointed at just ONE machine. Works for both the t3 web viewer (primary target) and the terminal viewer (gets the data for free). Single-host behavior unchanged.

## Non-goals (v1)

- Fully interleaved, moment-to-moment live console merging both hosts' every action. `activity` is a single scalar string per snapshot; true live interleaving would need it to become a timestamped, host-tagged log — deferred. v1 shows each host's *current* activity line + a merged *history* timeline.
- More than two hosts is supported by the data model (peers is a list) but the UI is designed/tested for two.
- Full machine-tag styling in the *terminal* viewer is a fast-follow; v1 only guarantees the terminal viewer does not break on the new schema and shows fused counts.

## Architecture

Two repos:
- **Sandcastle** (`/Users/ziyadakl/Dev/Sandcastle`) — emit host-tagged, shared-run status; publish it cross-host; fold peers into the one local file viewers read.
- **t3-code** (`/Users/ziyadakl/Dev/Personal/t3-code`) — extend the status-shape mirror and rebuild the loop card to render the fused, tagged stream.

Key decision (delegated): **the merge happens in Sandcastle, not the viewer.** Each host composes a merged local `status.json` containing itself + same-run peers. Any viewer then reads a single local file and sees everything — no viewer needs to reach the other machine, and both viewers benefit from one merge. Transport is a shared git ref (same substrate as locks and lanes), so all cross-host state travels one way.

### Sandcastle side

**1. Status schema (`.sandcastle/lib/status/schema.ts`, bump `STATUS_SCHEMA_VERSION` per the documented drill at schema.ts:19-34).**
Add to the snapshot:
- `hostId: string` — which machine wrote this snapshot (`resolveHostId()`, `.sandcastle/lib/host-id.ts`). Written ALWAYS, even single-host (harmless, keeps the shape uniform).
- `runId: string` — shared logical-run id, identical across cooperating hosts (see correlation below). Written always.
- `peers?: PeerStatus[]` — same-run peer snapshots folded in at merge time. Absent/empty in single-host mode. `PeerStatus = { hostId, state, activity?, iterations: {current,total}, totals, issues: StatusIssue[], updatedAt }`.
- History entries (`StatusHistoryEntry`) gain optional `hostId` so the merged, tagged "Recent" list can attribute each row. Optional → old readers/files stay valid.

**2. Correlation — `runId`.**
`runId` = the pre-hostId-suffix derived branch name (`derived`, the value before `${derived}-${resolveHostId()}` at main.mts:813-818). Both hosts on one queue derive the same `derived`, so they share `runId` while their `run.branch` stays host-distinct for git safety. When the lease is off or `--branch` was explicit (no suffix), `runId` = the branch name as-is (single-host; no peers to fuse anyway; two hosts that deliberately share an explicit branch will correctly share a runId). `derived` must be threaded into `StatusStoreMeta` at the `createStatusStore` call site (main.mts:5610-5620; `resolveHostId()` is already in scope there).

**3. Transport — status published to a shared git ref (`.sandcastle/lib/state/status-sync.ts`, new; mirrors `lane-sync.ts`).**
- Pure/dependency-injected (injected `GitRunner`, like lane-sync), so it tests offline against a real bare repo.
- `publish(snapshotJson)` — publish this host's current snapshot to `refs/sandcastle/status/<hostId>` on origin (force). Because status.json is gitignored/uncommitted, publishing writes the snapshot into a tiny dedicated commit and force-pushes that commit to the status ref; peers read it back via `git show <fetched-ref>:status.json` (exact git plumbing is an implementation detail for the plan; the contract is "this host's latest snapshot is retrievable from its status ref").
- `fetchPeers(runId)` — discover `refs/sandcastle/status/*` (mirror `discoverPeers()`, lane-sync.ts:118-132, excluding own hostId), fetch + read each, parse defensively, and **keep only peers whose `runId` matches** (so two unrelated runs on two machines never fuse). Returns `PeerStatus[]`.

**4. Wiring + throttle (`.sandcastle/main.mts`).**
- Gated on the existing `SANDCASTLE_CROSS_HOST_SYNC` flag (if you share code you share status — no new flag). Flag off ⇒ no publish, no fetch; local file is just today's snapshot + `hostId` + `runId`.
- Throttled to the lease heartbeat beat (status is not per-micro-update; piggyback the existing heartbeat timer). On each beat, when enabled: `publish` own snapshot, then `fetchPeers(runId)` and write the merged `status.json` (own snapshot + `peers[]` + history merged & tagged, capped/deduped by number+hostId+completedAt).
- The status store's atomic tmp+rename write (store.ts:103-105) is unchanged; only the composed content grows.

**5. Failure semantics (distinct from lane publish).**
Status is observability, not correctness. A publish failure or an unreadable peer ref ⇒ log at warn and continue; NEVER crash the loop and NEVER throw a loud fault (contrast `LaneSyncError`, which is loud because code not reaching origin is a real defect). A silent peer just shows its last-known snapshot and goes stale; it never stalls or crashes the other host.

### t3-code side

- **Shape mirror** (`packages/contracts/src/sandcastle.ts`, `SandcastleStatusSnapshot`): add `hostId`, `runId`, optional `peers[]`, and optional `hostId` on history entries — version-gated so old single-host files still parse (t3 already parses defensively).
- **Loop card** (`apps/web/src/routes/sandcastle.$environmentId.$projectId.tsx` → `SandcastleProjectDetail.tsx`): rebuild to the machine-tagged single stream:
  - Header: combined totals (this host + peers, summed — writer stays authoritative per-host, viewer sums; ships are disjoint so no double-count) and a per-machine iteration line (`Mac 3/8 · VPS 5/8`).
  - "In progress": union of this host's `issues` + each peer's `issues`, each row badged with its `hostId`.
  - "Recent": the merged, tagged `history`, sorted by `completedAt`.
  - A small host-badge component; map raw `hostId` → friendly label.
- Fusion is now WITHIN one snapshot, so the existing per-`(environment,cwd)` keying and `useSandcastleStatuses` hook are unchanged — the user points t3 at ONE machine and sees both. No two-environment merge, no two cards.

### Terminal viewer (`.sandcastle/watch/sandcastle-watch.tsx`)
Reads the same merged local file, so it gets the data for free. v1: ensure it tolerates the new fields (it already has a raw-version guard) and shows fused counts. Full machine-tag rendering is a fast-follow.

## Backward compatibility

- Single-host: no behavioral change — same card, same file, plus two ignored fields (`hostId`, `runId`); `peers` absent. `SANDCASTLE_CROSS_HOST_SYNC` off ⇒ no new git.
- `STATUS_SCHEMA_VERSION` bumps; t3 version-gates; new fields optional so old files/readers stay valid both directions.

## Testing

**Sandcastle:**
- Unit: `runId` derivation (lease on → shared pre-suffix id; lease off / explicit branch → branch as-is).
- Unit: the merge — fold a same-run peer; ignore a different-run peer; tolerate an unreadable/corrupt peer ref; history merge dedup+cap+tag.
- Real bare repo (mirror `tests/lane-sync.test.ts`): `status-sync` publish → status ref exists on the remote and reads back; `fetchPeers` discovers + filters by runId.
- Extend the real-git two-loop E2E (`tests/main.test.ts` "real-git two-loop E2E"): after both hosts run with sync on, assert each host's local merged `status.json` contains BOTH hosts (tagged) and a merged history.

**t3-code:**
- Component: a multi-host snapshot renders the tagged "In progress" union, merged "Recent", combined totals, per-machine iteration line.
- Schema: both the new multi-host shape and an old single-host shape parse.

## Twin discipline reminder

Verified twin layout: `.sandcastle/lib/state/*` has byte-identical `src/state/*` twins; `.sandcastle/lib/status/*` is **single-copy (no `src/status` twin)**. Therefore:
- The new `status-sync.ts` lives under `.sandcastle/lib/state/` (mirroring `lane-sync.ts`, the cross-host git-ref transport it copies) and **needs its `src/state/status-sync.ts` twin** kept byte-identical (verify with `diff`). To avoid cross-layer coupling it deals in plain JSON / a small `PeerStatus` shape, not heavy status internals.
- The schema/store edits under `.sandcastle/lib/status/{schema,store}.ts` have **no twin** — single edit each.
- `runId` note: `derived` is currently scoped inside the branch-derivation IIFE (main.mts:~813); threading it into `StatusStoreMeta` means lifting/recomputing `derived` in `runMain`'s scope — a small refactor, called out for the plan.
