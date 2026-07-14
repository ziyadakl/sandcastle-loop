# Design spec — cross-host code sync (Step 2 of two-machine Sandcastle)

**Date:** 2026-07-14 · **Status:** BUILT — superseded by `docs/adr/0020-cross-host-code-sync.md` · **Branch:** `feat/cross-host-issue-lease`
**Feeds:** an implementation plan (writing-plans) and `ADR 0020` (now the authoritative as-built record).

> **Superseded on one point — conflict handling.** This design (lines ~52, 69, 77)
> proposed marking the *affected files' issues* `needs-human` on a peer-merge
> conflict. ADR 0020 (the later, authoritative decision) **reversed** that: a
> lane-merge conflict is between whole lanes, not attributable to one ticket
> (staging is one commingled branch), so the loop logs LOUD + continues on the
> un-synced tip and flags **no** specific issue `needs-human`. The code follows
> ADR 0020. Read the ADR, not this line, for the shipped behavior.

---

## Context

The user runs the Sandcastle loop on **one always-on VPS** today. The new goal (started 2026-07-14) is to let a **second, intermittent machine (a Mac)** join the same GitHub issue queue for more throughput and to keep progress going when the user travels — without double-working a ticket, without a gone machine stranding work, and without a machine building on code it doesn't actually have.

**Step 1 (already built, this branch)** added a per-issue cross-host **lease** — a git ref `refs/locks/issue-<N>` on origin, atomic via non-fast-forward push rejection, opt-in via `SANDCASTLE_CROSS_HOST_LEASE`. It prevents two machines building the *same* issue and, when enabled, gives each machine a **per-host integration branch** (`args.branch = ${derived}-${resolveHostId()}`, main.mts:803). Off by default = today's exact single-VPS behavior.

**The gap Step 2 fixes.** Step 1 stops same-issue collisions but does **nothing** for *dependent* issues, and the reason is a load-bearing fact about the current loop:

> **Shipping an issue never publishes its code across machines.** `[VERIFIED: `fastForwardIntegration` (main.mts:2387-2508) advances the integration branch with local git only — `merge-base --is-ancestor`, `merge --ff-only`/`--no-ff`, `update-ref` — no `fetch`, no `push`, no `origin`. Issue close is `gh`-only, server-side (`promoteAllStagingToDone` / `closeIssue`, gh.ts:569-587, 260). The only thing the loop pushes to origin in code is the `refs/locks/*` lease ref.]`

So when the VPS finishes issue `#A`, `#A`'s **code** lives only on the VPS's local branch; only the GitHub *"closed"* status is visible to the Mac. A dependent `#B` (`Blocked by: #A`) — which the planner dispatches once `#A` is *closed* (the blocker gate is the planner agent per ADR 0013, not code) — would build on the Mac against a snapshot that lacks `#A`'s code, producing broken work. The current single-machine loop never hits this because one machine's local branch always has its own prior work.

This design was chosen over two alternatives after an advisor review (see *Rejected alternatives*): **cluster-pinning** (pin each dependency chain to one machine) stalls when a machine leaves mid-chain and adds the most machinery; a **shared single integration branch** removes the per-host-branch property Step 1's ship-fence depends on and introduces concurrent unattended writes to one mutable branch. Both quietly assume the publishing substrate this spec actually builds.

## Goal

When enabled, make finished code cross machines so that: (1) a dependent issue always builds against its blockers' real code; (2) a machine that goes offline never strands its **finished** work — the peer picks up from it; (3) the loop **never crashes** on a sync/merge/network problem — it defers the affected issue and keeps going. Off by default; single-VPS behavior byte-for-byte unchanged.

## Non-goals

- Not eliminating merge conflicts. Two machines editing the same file with no declared dependency **will** conflict — inherent to concurrent development. This design makes conflicts **smaller, earlier, and survivable** (per-cycle, often auto-mergeable, else `needs-human`), not absent.
- Not pinning dependency chains, not a `built-by` label scheme, not a dependency-graph builder — this design makes them unnecessary.
- Not real-time streaming of in-flight (unshipped) work. Only **shipped/promoted** code is published. A machine's in-flight issue at death is lost and re-done via the existing lease reclaim — that's acceptable and already handled.

## The model — per-host published lanes + cycle-start sync

Keep Step 1's per-host integration branches. Add two things and one guard:

1. **Publish (push-on-ship).** After a machine successfully promotes an iteration (its integration branch advanced locally), it **pushes that branch to origin** under an invisible ref namespace, `refs/sandcastle/lanes/<hostId>` — mirroring how the lease chose `refs/locks/*` to stay out of branch/PR lists (ADR 0019). No two machines ever write the *same* ref, so there is **no push race** and Step 1's ship-fence assumption ("a stray land is a wasted merge, not corruption") is preserved.

2. **Sync (pull-at-cycle-start).** At the **top of each iteration** (main.mts:5697, before the planner at 5806 and before `resetStagingToIntegrationTip` at 6256), the machine fetches every *other* lane ref `refs/sandcastle/lanes/*` from origin and **merges them into its own integration branch** (`args.branch`) through the launch worktree — reusing the local-merge machinery that `fastForwardIntegration` already uses. Because worker worktrees are cut from the launch checkout's tip (main.mts:1237, 1263), every build in that cycle then sees the peer's shipped code automatically. Dependents "just work": a dependent is only dispatched after its blocker is closed, and by then a prior cycle's sync has pulled the blocker's code onto this machine's tip.

3. **Dependent-freshness guard.** There is a small race: a peer can close+publish blocker `#A` in the window between this machine's cycle-start sync and its planner run, so the planner dispatches `#B` before `#A`'s code is local. v1 handles this by **degrading, not corrupting**: the `#B` build fails its tests/review (missing symbol) → the existing pipeline defers or `needs-human`s it → next cycle's sync pulls `#A` → `#B` is re-attempted cleanly. (A precise per-issue "is the blocker commit present?" gate is a documented future enhancement, not v1.)

`lane` identity = `resolveHostId()` — already threaded through the lease (`holder`) and the branch suffix. No new identity concept.

## Data flow — one iteration (flag ON)

```
iteration start (main.mts:5697)
  └─ SYNC: git fetch origin refs/sandcastle/lanes/*        ← new
     for each peer lane ref (not mine):
        merge peer tip into args.branch via launch worktree
        clean merge  → integration tip advances, keep going
        conflict     → abort merge, log loud, mark affected files' issues
                       needs-human, DO NOT half-merge, continue on current tip
  └─ resetStagingToIntegrationTip (2042/6256) — now includes synced peer work
  └─ planner picks ready issues (5806)
  └─ per issue: acquireIssueLease (Step 1) → claim → build → review → ship
  └─ PROMOTE (6644): fastForwardIntegration advances args.branch locally
  └─ PUBLISH: git push origin args.branch:refs/sandcastle/lanes/<hostId>   ← new
              (only on a successful promote; bounded timeout + retry like the lease)
iteration end
```

Off (flag false): the SYNC and PUBLISH steps are complete no-ops; nothing fetches or pushes; the loop is byte-for-byte today's behavior.

## Components / seams

- **`publishLane(repoRoot, hostId)`** — push `args.branch` → `refs/sandcastle/lanes/<hostId>` on origin, using the lease's bounded-timeout git runner pattern (`runGitLease`, 30 s + transient-only retry) so a hung/slow push can't wedge the loop. Called after a successful promote.
- **`syncPeerLanes(repoRoot, args.branch, selfHostId, launchWorktree)`** — fetch `refs/sandcastle/lanes/*`, enumerate peers ≠ self, merge each into `args.branch` in the launch worktree. Returns a per-peer result (merged / conflicted / skipped). Reuses `fastForwardIntegration`'s local-merge and dirty-worktree guards.
- **Conflict handling** — on a peer-merge conflict: `git merge --abort` (leave no half-merged state, mirroring main.mts:2475-ish abort logic), log loudly, and record the conflict so the human is surfaced (a `needs-human` label on the issues whose files conflict where derivable, otherwise a run-level warning). The loop continues building independent work on the un-synced tip; the peer's conflicting commit lands after a human resolves it.
- **Flag** — a dedicated opt-in, e.g. `SANDCASTLE_CROSS_HOST_SYNC`, that **requires** the lease (cross-host code sharing without the per-issue lock makes no sense). Both default off. Add to `LOGGED_ENV_KEYS`. Document in `.env.example` alongside the lease vars.
- **Discovery** — `git ls-remote origin 'refs/sandcastle/lanes/*'` (or the fetch refspec) enumerates lanes; no coordination or registry needed; supports N machines.

## Failure handling / graceful degradation (hard requirement)

Every new failure path must degrade, never crash — the pattern Step 1 established (deferred outcomes, fail-loud auth, best-effort heartbeat):
- **Fetch fails** (network) → log, skip sync this cycle, build on current tip (may hit the dependent race → defer). Not fatal.
- **Peer-merge conflict** → abort + `needs-human` + continue. Not fatal.
- **Publish push fails** (auth) → this is the same class as the lease's auth failure; fail **loud** (mirror Fix 2's `gh auth setup-git` message) since it means the machine's work isn't reaching origin. (Transient network → bounded retry, then loud.)
- **Dependent built too early** → normal pipeline defer/`needs-human`, retried next cycle.

## Interaction with existing pieces

- **Lease (Step 1):** unchanged and still required — it serializes issue selection and underpins death-reclaim. The ship-fence keeps working because per-host branches are retained.
- **Staging model:** unchanged locally. `integration-candidate` stays local-only and reset each iteration; only the promoted **integration branch** is what gets published/synced. `resetStagingToIntegrationTip` now resets to a tip that already includes synced peer work — which is exactly what we want.
- **`--no-staging` mode:** same two hooks — publish after the terminal ship, sync at cycle start. (Staging is the default and the primary target; `--no-staging` handled analogously.)

## Explicitly deferred (not v1)

- Per-issue "is the blocker's commit present locally?" gate (v1 relies on cycle-start sync + degrade-on-race).
- Auto-resolving conflicts (v1 surfaces them to a human).
- Collapsing to a single shared integration branch (kept per-host for safety + Step 1 consistency).
- Publishing in-flight (unshipped) work for finer-grained death recovery.

## Rejected alternatives

- **Cluster-pinning (prior "locked" plan).** Pin each `Blocked by` component to one machine. Stalls when the owner leaves mid-chain (violates the user's "never stall"), under-uses both machines, and adds the most machinery (component graph, first-claim ownership, `built-by` labels, adoption rules). Its only virtue — keeping machines' code apart — is the very thing that causes the stall. **Assumed** no publishing substrate; this spec removes the need for it entirely.
- **Single shared integration branch.** Both machines push one branch with fetch-rebase-push retry. Removes the per-host-branch property Step 1's ship-fence rests on (a stray land becomes real corruption of a shared tip, not a wasted merge), and introduces concurrent unattended writes to one mutable content branch. Higher blast radius for marginal simplicity. Per-host lanes + local peer-merge gets the same "shared view" without a shared writable branch.

## Testing strategy

- **Unit (offline, real local bare repo — reuse `tests/lock.test.ts`'s fixture pattern):** `publishLane` pushes to the right ref; `syncPeerLanes` merges a peer lane cleanly; a conflicting peer lane aborts cleanly (no half-merge) and reports conflict; fetch failure is non-fatal.
- **Two-loop E2E (extend the `cross-host issue lease orchestration` describe block):** machine A ships `#A` and publishes; machine B syncs, then builds dependent `#B` and sees `#A`'s code; machine A "dies" mid-chain → its shipped `#A` is on origin → machine B continues. Assert no crash on a conflict path.
- **Flag-off invariant test:** with the flag off, no fetch/push occurs and behavior matches today (grep-style assertion + existing suite stays green).

## Open questions (resolve during writing-plans)

1. Sync cadence: every iteration (simple, proposed) vs every N / on-idle (less network). Default: every iteration.
2. Conflict → which issues get `needs-human`? Mapping conflicted files → issues may not be clean; fallback is a run-level warning + a single tracking label. Decide the minimal reliable signal.
3. How aggressively to reconcile a long in-flight build whose base moved under it — v1 leans on the pipeline's existing defer/needs-human rather than mid-build rebasing. Confirm that's acceptable.
4. Exact `refs/sandcastle/lanes/*` fetch refspec + pruning of dead lanes (a machine retired) so stale lanes don't accumulate.
