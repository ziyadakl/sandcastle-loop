# ADR 0019 — Sandcastle: cross-host per-issue lease via a git ref

**Status:** Accepted
**Date:** 2026-07-14

## Context

Two Sandcastle loop hosts pointed at the **same GitHub repo** — a VPS and a local
Mac, say — corrupt each other today. Nothing in the loop is aware another host
exists, and every "claim" mechanism it has is racy across machines:

- **Deterministic issue selection with no sharding.** Both hosts sort the ready
  queue the same way and pick the same top issue (`gh.ts:489-499`). Two hosts,
  one issue, every iteration.
- **"Claiming" is an unconditional label flip.** `claimViaLabel` just removes
  `ready-for-agent` and adds `in-progress` — no compare-and-swap, no check that
  someone else already claimed it (`gh.ts:224,233`, call site `main.mts:5524`).
  Labels are last-write-wins: GitHub has **no label transaction** (cli/cli#4861),
  so labels/assignment/reactions cannot arbitrate a race. The second host's flip
  silently wins a label it does not own.
- **Startup reconciliation releases the OTHER host's live work.** On boot a host
  scans `in-progress` issues and releases them back to `ready-for-agent`,
  assuming they are its own crash-orphans (`main.mts:5180-5215`). It cannot tell a
  crashed local iteration from a healthy remote one, so it happily yanks an issue
  the peer host is actively working.
- **The only lock is local.** `proper-lockfile` guards a single machine's loop
  against itself (`main.mts:5138-5145`) and offers **zero** cross-host protection.

We need mutual exclusion whose arbiter is atomic across hosts. GitHub gives us
exactly one such primitive on the shared origin: **creating a git ref that already
exists is rejected atomically** (HTTP 422 / "Reference already exists").

## Decision

A **per-issue lease** implemented as a git ref `refs/locks/issue-<N>` on `origin`,
pointing at a **lock-commit** whose message carries the lease metadata:
`holder` / `acquiredAt` / `expiresAt` / `epoch`. The ref's create-if-absent
semantics provide the atomic arbiter that labels cannot. Operations:

1. **Acquire = create the ref.** `gh api` a ref-create against
   `refs/locks/issue-<N>`. Success means we hold the lease; a 422 ("Reference
   already exists") means a peer holds it — we skip the issue. This replaces the
   label flip as the real claim; labels stay as human-visible signage only.

2. **Read = ls-remote + read the lock-commit.** Resolve the ref and parse the
   lock-commit message for `holder`/`expiresAt`/`epoch`. Read is advisory only —
   used to decide *whether to try* a reclaim, never as proof of ownership.

3. **Reclaim = force-with-lease CAS, only once `now >= expiresAt`.** An expired
   lease (dead/silent holder) is stolen by CAS-advancing the ref from its known
   old OID to a fresh lock-commit that bumps `epoch`. The old-OID guard means two
   reclaimers racing on the same corpse cannot both win.

4. **Renew (heartbeat) = CAS forward every ~ttl/3.** The holder keeps the lease
   alive by CAS-advancing the ref (old OID → new lock-commit, fresh `expiresAt`)
   roughly every third of the TTL. A clean **failed self-renewal CAS means the lease
   was lost** — reclaimed out from under us — so the host drops the registry entry and
   shouts. The heartbeat is **best-effort**: a *thrown* renewal error (an auth/network
   blip, a post-retry timeout) is logged and skipped, never fenced-on and never fatal —
   a transient blip is not proof of a lost lease, and an unhandled rejection in the
   heartbeat interval could otherwise crash the loop.

   The authoritative fence is an **inline CAS immediately before the ship/promote
   push** (not a mid-await abort of a running sandbox, which is out of scope): right
   before it marks an issue done (`--no-staging`) or promotes it (staging), the host
   re-asserts the lease with a synchronous renew-CAS and **refuses to ship if that CAS
   fails**. This closes the sleep/wake race a cached "lease-lost" flag would leave open.
   An irreducible-but-tiny TOCTOU remains between that CAS and the push itself; because
   run branches are **per-host-suffixed**, a stray double-ship collides only at the
   end-of-run lane merge — wasted work, never corruption.

5. **Release = delete the ref.** Clean hand-back on normal completion.

### Why a git ref, not REST-only

Acquire / read / release go through `gh api` (reusing the existing `gh` auth, no
new credential surface). But **renew and reclaim need an old-OID compare-and-swap**,
and the REST `PATCH git/refs` cannot express one — it offers only fast-forward or a
blind `force`, neither of which is "advance *from this exact OID* or fail." So
renew/reclaim use `git push --force-with-lease`, whose expected-OID check is the
CAS we need. The source of truth for "did I win" is always the **CAS push result**,
never the `ls-remote` read.

### TTL and clock skew

Default TTL **900s (15 min)**, renewed roughly **every 5 min** (`ttl/3`). The lease
is a **check-in timer, not a task-length cap**: a 2.5h task stays safe because the
holder renews continuously; only a *silent or dead* host loses its lease. `expiresAt`
is written by the holder and judged by the reclaimer, so the TTL is deliberately
**>> expected clock skew**, and reclaimers add a small grace margin before treating a
lease as expired.

Config: `SANDCASTLE_HOST_ID` (default `os.hostname()`) identifies the holder;
`SANDCASTLE_LOCK_TTL_SEC` (default `900`) sets the TTL.

## Consequences

- **This is the loop's first-ever remote write.** Until now the loop only pushed
  branches at promotion time via `gh`; the lease writes `refs/locks/*` to origin
  directly. **Both hosts need `git push` auth to origin** — a one-time
  `gh auth setup-git` on each. This is a genuine new prerequisite, called out so it
  is not discovered at first 403. **A missing/failed push auth fails loud, not silent:**
  the backend distinguishes a contention rejection (a peer holds the ref) from an
  auth/network fault by inspecting git stderr — the latter throws and halts the run
  with `exitCode 2` and a "check `gh auth setup-git`" message, so a forgotten login
  can never masquerade as a phantom rival holding every lease.
- **All lease ops currently use `git` (not `gh api`).** Acquire / read / release /
  renew / reclaim all go through `git` against `origin`, so a single `git push` auth
  covers everything. (A `gh api` split for the read-only ops is a possible future
  optimization; it is not implemented.) Reads are **fail-closed**: a lock ref that
  exists but whose commit can't be read or parsed is treated as *occupied* (live),
  never as free, so a corrupt ref is never mistaken for an available issue. The
  operator escape hatch for a genuinely-stuck ref is `git push origin :refs/locks/issue-<N>`.
- The ref lives under `refs/locks/*`, so it is **invisible to branch and PR lists**
  and **untouched by branch protection** — no noise, no protected-branch friction.
- Two hosts can now run the same repo without stealing each other's issues; the
  atomic ref-create decides every contested claim, and the heartbeat + expiry-gated
  reclaim recover leases from a host that actually died.
- **Fencing is real work lost on a lost lease:** a host whose inline pre-ship CAS
  fails refuses to ship that issue (it goes back to the queue / `needs-human`). That is
  the intended trade — better a re-attempted issue than two hosts double-shipping one.
- **Contention is a routine skip, not a failure.** Because both hosts sort the ready
  queue identically and target the same top tickets, the loser contends on most of
  them; a contended acquire is therefore counted as a *skip* that never touches the
  consecutive-failure circuit breaker (only genuine work failures do), so normal peer
  coexistence cannot halt a host.

## Related

- **Per-host run-branch naming.** So two hosts don't push the *same* run branch and
  clobber each other, run branches are namespaced by host — a sibling change to this
  lease, tracked alongside it.
- **Startup reconciliation changed to reclaim only EXPIRED leases.** The
  `main.mts:5180-5215` "release every `in-progress` issue" scan is replaced by a
  lease-aware pass: a host reclaims only leases whose `expiresAt` has passed, leaving
  a peer's live work alone.
- **Staging needed no change.** `integration-candidate` is local-only and reset every
  iteration, so it never crosses hosts and carries no cross-host race.

## Alternatives considered

- **Labels / assignment / reactions as the lock.** Rejected: last-write-wins with no
  transaction (cli/cli#4861). The second writer silently "wins" a claim it never had —
  exactly the bug we are closing.
- **REST-only lease (no `git push`).** Rejected for renew/reclaim: `PATCH git/refs`
  can only fast-forward or blindly `force`, so it cannot do the old-OID CAS that makes
  reclaim safe against two racing reclaimers. `git push --force-with-lease` can.
- **A local lock only (status quo, `proper-lockfile`).** Rejected: it is per-machine
  by construction and provides no cross-host mutual exclusion at all.
