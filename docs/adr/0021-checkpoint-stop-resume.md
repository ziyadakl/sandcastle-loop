# ADR 0021 — Sandcastle: zero-loss checkpoint stop + resume-from-partial

**Status:** Accepted
**Date:** 2026-07-16

## Context

The multi-host control feature (run/resume/stop/status across all-or-one host)
needs a **stop that is near-immediate AND loses no work**: an operator who has to
walk away with their laptop must be able to stop in seconds without discarding the
partial work of the issue(s) currently in flight, and another machine (or a later
re-run) must be able to **continue that issue** rather than start it over.

The loop cannot do this today. Verified in code:

- **Per-issue branch is force-reset every run.** `mac-host-sandbox.ts:490` runs
  `git worktree add -B <agent/issue-N> <wtPath>` — the `-B` moves the branch
  pointer to `repoRoot` HEAD (the integration tip) unconditionally. There is no
  branch-existence check, no `fetch`, no reuse path. The docker path
  (`main.mts:3006-3017`) removes any existing worktree + `git worktree prune`
  then a plain `git worktree add`. Either way prior commits on `agent/issue-N`
  are orphaned.
- **The per-issue branch never reaches `origin`.** The only origin writes in the
  loop are lease refs (`refs/locks/*`, ADR 0019), status refs
  (`refs/sandcastle/status/*`, ADR 0020), and — only under `SANDCASTLE_LANES` —
  the whole *integration* branch to `refs/sandcastle/lanes/<hostId>` (ADR 0020).
  `agent/issue-N` (the unmerged per-issue work) is pushed **nowhere**
  (`grep push.*agent/` → no hits).
- **Reclaim carries no code state.** `reclaimIfExpired` (`issue-lease.ts:190-211`)
  CAS-moves a permission ref only; startup reconciliation
  (`main.mts:5719-5734`) flips the label back to `ready-for-agent` and the
  planner re-picks the issue as brand-new.
- **An in-flight agent call cannot be interrupted mid-generation.** The SDK
  session is host-bound and not resumable across machines
  (`reference_sandcastle_session_jsonl_gotcha`).

So zero-loss stop/resume is a genuine mechanism, not a flag.

## Decision

Persist an in-flight issue's work as a **git ref on `origin`** at stop time, and
make issue pickup **reuse** that ref instead of force-resetting. Four decisions:

### 1. Commit-on-stop semantics — commit disk state, push a WIP ref

On a checkpoint stop, for each issue this host currently holds a lease for
(the set already tracked in the lease coordinator's `leaseRegistry`,
`issue-lease.ts:522`):

1. Stop/kill the in-flight agent. Files it has already written stay on disk in the
   per-issue worktree; only the current call's *un-written* reasoning is lost
   (irreducible — it was never persisted).
2. In that worktree, `git add -A` and commit **iff** there is something to commit
   (`git status --porcelain` non-empty) — message `wip: checkpoint issue <N>
   (<hostId>)`. A checkpoint is never an empty commit.
3. Push the worktree HEAD to an **invisible WIP namespace** on origin:
   `refs/sandcastle/wip/issue-<N>` (mirrors the lease/status/lane ref-namespace
   convention; never a visible branch). Force-with-lease so a re-checkpoint of the
   same issue advances cleanly and two hosts can't clobber (only the lease holder
   ever writes its own issue's WIP ref).

"Near-instant" = kill agent + one commit + one push (seconds), not "wait for the
issue to finish." If the push fails (e.g. the operator already lost network), the
commit still exists locally and the peer reclaims the issue via the 15-min lease
TTL and restarts it — i.e. we degrade to today's behavior, never worse.

### 2. Branch reuse on pickup — existence-aware, replaces unconditional `-B`

Sandbox creation gains a pure decision function
`reuseOrFresh(branch, git) → 'reuse' | 'fresh'`:

- **`reuse`** when `refs/sandcastle/wip/issue-<N>` exists on origin: `git fetch
  origin refs/sandcastle/wip/issue-<N>` then `git worktree add -B <branch>
  FETCH_HEAD` — the worktree is cut from the checkpoint tip, so the implementer
  sees the committed partial work and continues on top of it.
- **`fresh`** otherwise: today's `git worktree add -B <branch>` from HEAD.

Both the mac-host path (`mac-host-sandbox.ts:485-497`) and the docker path
(`main.mts:3006-3017`) route through this decision. The `git worktree add` call
stays thin; all branching logic lives in the TDD'd `reuseOrFresh`.

### 3. Resume granularity — continue on the branch, not literal step-restore

Because an SDK session can't be restored, "resume from step 5" is realised as
**"the worktree starts from the branch that already contains steps 1-4's
committed work."** The resuming implementer re-runs its phase on top of that
code rather than from a blank tree. This is the achievable, honest version of the
requirement and is explicitly what "resume" means throughout this feature. No
attempt is made to restore a phase pointer or agent transcript.

### 4. Reclaim/label + WIP-ref lifecycle

- Checkpoint stop leaves the issue **reclaimable**: it does NOT quarantine or
  mark the issue done. The lease is released (ADR: `releaseAllLeases` on
  shutdown) so a peer can acquire immediately; failing that, the 15-min TTL
  reclaims it. Startup reconciliation already flips a lease-less `in-progress`
  issue back to `ready-for-agent`.
- The WIP ref is the resume state, independent of who picks the issue up next.
- **Cleanup:** when an issue finally **ships** (merges to integration), its
  `refs/sandcastle/wip/issue-<N>` is deleted (`git push origin
  :refs/sandcastle/wip/issue-<N>`, best-effort) so stale WIP never resurrects a
  merged issue. Startup reconciliation also prunes WIP refs for issues already
  closed/merged.

## Consequences

- **New origin write surface.** WIP refs join locks/status/lanes under
  `refs/sandcastle/*`. Same push-auth requirement as ADR 0019/0020 — gated behind
  the existing cross-host opt-in; a single-host consumer with the flag off keeps
  force-reset behavior and pushes nothing new.
- **A half-written checkpoint may hold syntactically broken code.** Acceptable:
  the resuming implementer treats it as in-progress work to finish, exactly as if
  the same host had continued. Tests must cover "reuse a WIP ref whose tree
  doesn't build."
- **Force-reset behavior is preserved when there is no WIP ref**, so every
  existing test and the flag-off path are byte-for-byte unchanged.
- **Scope guard:** cross-host SDK-session restore remains out of scope
  (unsupported). This ADR only persists + reuses *code*, not agent state.
