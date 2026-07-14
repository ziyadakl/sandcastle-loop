# ADR 0020 — Sandcastle: cross-host code sync via published lane refs

**Status:** Accepted
**Date:** 2026-07-14

## Context

ADR 0019 gave two Sandcastle hosts pointed at the **same GitHub repo** a
per-issue **lease** so they never work the same issue. That solves *who works
what* but not *how the code they produce reaches the other machine*. Today the
loop shares nothing across hosts:

- **Integration is local-only.** `fastForwardIntegration` (main.mts) advances the
  `--branch` integration line with local git — no `fetch`/`push`/`origin`. Issue
  close is `gh`-only (server-side labels). The **only** origin write anywhere in
  the loop is ADR 0019's lease ref (`refs/locks/*`).
- **Consequence 1 — dependents build broken.** A host that picks an issue whose
  blocker was shipped *on the other machine* never has that blocker's code. It
  builds against a tree missing the dependency.
- **Consequence 2 — a dead machine strands finished work.** Work shipped on a
  host that then goes offline lives only in that host's local integration branch
  until a manual end-of-run merge. The peer can never see it.

We need each host's shipped code to become visible to the other, over the one
shared surface both hosts already talk to: `origin`.

## Decision

Each host **publishes** its integration branch to an invisible per-host ref
namespace on `origin` after a successful ship, and **syncs** peers' published
branches into its own integration branch at the start of each iteration. No
dependency pinning, no `built-by` labels — sharing the actual code makes those
unnecessary.

### Publish
After a fully-successful promote, force-push the local integration branch to
`refs/sandcastle/lanes/<hostId>` (a **lane**). `<hostId>` is `resolveHostId()`
— the same identity the lease uses. The namespace lives outside `refs/heads/*`
and `refs/pull/*`, so a lane never shows up in branch or PR lists (mirrors ADR
0019's `refs/locks/*` choice). `--force` is **safe**: each host is the *single
writer* of its own lane ref, so there is no peer to clobber; the force just keeps
the published lane equal to the local integration tip even after a
rebase/reset makes the advance non-fast-forward.

### Sync
At iteration start — **before** the planner and **before**
`resetStagingToIntegrationTip` — `ls-remote` the lane namespace to discover peer
lanes (excluding own), then for each peer: fetch its lane into a shared local
mirror ref `refs/sandcastle/peers/<peer>` and `git merge` that ref into the
integration branch **inside the launch worktree**.

The mirror ref is deliberate: `FETCH_HEAD` is **per-worktree**, so a fetch run in
the repo root would be invisible to a `merge` run inside a separate launch
worktree. Merging a stable local ref *by name* sidesteps that entirely.

### Fault posture (mirrors ADR 0019: fail-loud-on-write, fail-safe-on-read)
- **Discovery (`ls-remote`) never crashes a cycle** — any failure returns `[]`
  (a hard auth fault surfaces loud on the next publish, which is the write path).
- **Sync per-peer faults are non-fatal.** A fetch failure or a dirty launch
  worktree → that peer is `skipped` this cycle. A merge **conflict** → the merge
  is `--abort`ed (worktree left CLEAN — no `MERGE_HEAD`, no half-applied files),
  the conflicted files are captured, and the peer is recorded `conflict`.
  `syncInto` **never throws** on these; it returns a per-peer result the loop
  acts on.
- **Publish failure is a real fault.** A push to a single-writer lane ref is never
  contention — any failure is auth/network/backend. It throws a typed
  `LaneSyncError` the loop surfaces LOUD (with a `gh auth setup-git` remediation,
  like ADR 0019's Fix 2), then continues: the work is already shipped locally and
  on GitHub, only lane *visibility* to a peer is delayed until the next publish.

### Gating
New opt-in flag `SANDCASTLE_CROSS_HOST_SYNC`, default **off**. Flag off ⇒
byte-for-byte today's single-host behavior: no `fetch`/`push`/`ls-remote`/`merge`
of any lane ref is reachable (double-guarded — both the deps closures and the
hook call sites check the flag). Sync **requires the lease**: if sync is on but
`SANDCASTLE_CROSS_HOST_LEASE` is off, the loop refuses to start LOUD — sharing
code across hosts without the per-issue lock is unsafe (two hosts could ship
conflicting work for the *same* issue and then blindly merge each other's lanes).

### Conflict handling (a design decision, not a bug)
A lane-merge conflict is between *whole lanes*, not attributable to one ticket
(staging is one commingled branch). So on `conflict` the loop logs LOUD to the
durable run log and **continues building on its own un-synced tip** — it does
**not** flag any specific issue `needs-human`. A human reconciles the divergence.

## Where the hooks live (as built)

- **Sync hook** — iteration start, after the hot-reload guard, before the
  planner and before `resetStagingToIntegrationTip`. Resolves the launch worktree
  via a factored `findWorktreeForBranch(repoRoot, branch, git)` helper (extracted
  from the inline `parseWorktreeList(...).find(...)` pattern that was duplicated
  across the loop).
- **Publish hook (staging, default)** — inside the `if (ffSucceeded)` block,
  after `finalizeMergedAccounting` + the lease-release loop. **Only** on the
  promote-success path, never the FF-refused `else` (that work is stranded, not
  shipped).
- **Publish hook (`--no-staging`)** — in **Phase 3**, as the `else if (mergerOk)`
  leg of the staging-promotion block, i.e. **after the batch merger has landed
  the work on the integration branch**. See "The bug the review caught" — the
  first implementation put this per-issue in Phase 2 (before the merger) and
  published a stale tip.

## The bug the review caught (recorded so it isn't reintroduced)

The first cut of the `--no-staging` publish fired inside `shipAfterMigrations`
(Phase 2, per-issue) right after `markDone`. But under `--no-staging`,
`markDone` only flips the GitHub label — this iteration's code reaches the
integration branch **only** via the Phase-3 batch merger, which runs *after*
every per-issue pipeline. So the Phase-2 publish force-pushed a launch-branch tip
**missing the just-shipped commit**; on the final iteration it never published at
all. The suite was green because the test asserted only that `publishLane` was
*called*, not *when*. Fix: moved the `--no-staging` publish to Phase 3 (after the
merger, once per iteration, gated on `mergerOk` — matching the cleanup gate's
`!stagingActive ? mergerOk` logic), and strengthened the test to assert publish
happens **after** the merger (records an ordered event sequence, asserts
`publishIdx > mergerIdx`). This mirrors ADR 0019's lesson: a green suite hid a
critical bug; an adversarial pass caught it.

## Rejected alternatives

- **Dependency pinning / `built-by` labels.** Track which host built each issue
  and pin dependents to wait for the blocker's host. Rejected: sharing the actual
  code makes provenance tracking unnecessary, and pinning adds a second
  coordination protocol on top of the lease.
- **A single shared integration branch both hosts push.** Rejected: it collides
  with ADR 0019's per-host-suffixed integration branches (the lease fence depends
  on them) and reintroduces the cross-host push race the lease exists to avoid.
- **Per-issue commit-presence gate before building a dependent.** Rejected for
  v1 as premature: a too-early dependent build simply fails review → defers →
  retries next cycle after sync. Deferred as a future nicety.

## Consequences

- Dependents build against real peer code; a dead machine no longer strands
  *finished* work (its last published lane persists on origin for the peer to
  merge). Sync/merge/network faults defer-not-crash.
- This introduces the loop's **first branch-level `fetch`/`push`** (previously
  only the lease ref was pushed). Off by default; requires the lease when on.
- **v1 accepts a dependent-freshness race:** a dependent picked before its
  blocker's lane is synced builds stale, fails review, and retries next cycle.
- **Lane pruning is deferred:** retiring a machine leaves a stale
  `refs/sandcastle/lanes/<id>`; v1 merges whatever peers exist (a stale lane
  re-merges cleanly / no-ops). Pruning is a documented future nicety.

## References

- ADR 0019 — cross-host per-issue lease (companion; same `refs/sandcastle`-style
  invisible-ref choice, same fail-loud-on-write/fail-safe-on-read posture).
- Design spec: `docs/superpowers/specs/2026-07-14-cross-host-code-sync-design.md`.
- Module: `.sandcastle/lib/state/lane-sync.ts` (+ `src/state/lane-sync.ts` twin),
  tests `tests/lane-sync.test.ts`. Wiring: `.sandcastle/main.mts`, tests
  `tests/main.test.ts`.
