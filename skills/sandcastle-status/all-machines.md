# All machines (fused)

The cross-host branch of [`SKILL.md`](SKILL.md): what every machine on a shared sandcastle run is doing, fused into one machine-tagged view. Reach this file when the user asks about all their machines, or when more than one host publishes a status ref for the same run.

**Precondition.** Fusing needs cross-host sync (`SANDCASTLE_CROSS_HOST_SYNC=1`). With sync off, hosts publish no status refs and there is nothing to fuse — run the single-machine sequence in `SKILL.md` instead. Same when `git ls-remote origin 'refs/sandcastle/status/*'` returns only one host: that is a single-machine run wearing a cross-host question, so answer it from `SKILL.md` and **say plainly that only one machine reported**, since the user asked about several and a silent collapse hides an offline peer.

## Steps

1. **Name the full set of machines** from `.sandcastle/hosts.json`, so the user sees hosts that are idle or offline as well as the busy ones.

2. **Read the published snapshots** — `git ls-remote origin 'refs/sandcastle/status/*'` lists the reporting hosts, and each ref's commit message carries that host's snapshot (`runId`, `branch`, `state`, iteration counts, `updatedAt`). This is the authoritative fused source. Summarise which hosts are running which run, their iteration counts, and the combined merged / needs-human / requeued totals.

3. **`pnpm sandcastle:watch` for a live view, with one caveat.** The terminal viewer reads a single local `status.json` and sums the peer snapshots already inside it (`watch/sandcastle-watch.tsx`); it makes no git call of its own. The peers get into that file only when a loop **on this machine** fetches them. So on the owner's Mac while the run is on the vps, the viewer shows stale or empty peer data — offer it when a loop is running locally, and rely on step 2 otherwise.

4. **Then run `SKILL.md` steps 3, 4, 5 and 6 once.** The fused ref counts say how many tickets landed in each bucket; they cannot say which ticket is waiting on the owner, whether the screen checks worked, or what fell out of the queue. Those come from GitHub and from the lead host's own files, and they are what the lead-in ladder is computed from. Fused totals alone rank nothing.

5. **Per-host memory and load** — `ssh <transport> -- 'uptime; free -h'`, taking the alias from that host's `hosts.json` entry. Run this when the user asks for it.

## Liveness across hosts

The liveness rules in `SKILL.md` step 2 apply per host, with one narrowing: the stamped `pid` is probeable only on the machine that owns it. A peer whose snapshot reads `running` with a stale `updatedAt` is **frozen** — a hard death inferred from the heartbeat, reported as a death rather than a live loop.

Check every host, not just the busiest. One machine finishing its share while another crashed mid-ticket is the normal shape of a bad night, and the crashed one is rank 1.

## The report

Lead with "N machines running <branch>" and the fused totals, then per-machine detail naming which host holds which ticket. The lead-in ladder and the clean-end guardrail in `SKILL.md` both govern here: a dead machine, a loud stop or a broken screen-check instrument on any single host outranks the fused counts, and no wording implying a clean end is available while any host has one of them.
