---
name: sandcastle-status
description: Show what the sandcastle loop is currently doing — either this one machine, or the combined status across all my machines on a shared run. Use when the user wants to check on a running loop or invokes /sandcastle-status. Shows process state, current iteration, recent log activity, and the queue; on a multi-host run it fuses every machine's activity into one machine-tagged view.
---

# Sandcastle Status

Reports on a running or recently-finished loop. This works two ways:

- **Single machine** (default): this machine's process state, current iteration, recent log, and queue.
- **All machines** (fused): every machine on a shared cross-host run, machine-tagged into one view.

## Which branch to run

Use the **all-machines** branch when the user asks about *all their machines* / *every host* / a *shared* or *combined* run, or if a multi-host run is detectable (cross-host status refs are present — `git ls-remote origin 'refs/sandcastle/status/*'` returns more than the local host). Otherwise use the **single-machine** branch. Don't over-engineer the detection — the user's phrasing is the primary signal; the refs are a hint.

The all-machines branch requires cross-host sync (`SANDCASTLE_CROSS_HOST_SYNC=1`). If sync is off, hosts don't publish their status refs and there's nothing to fuse, so fall back to the single-machine branch.

---

## Single machine

1. **Liveness — read `.sandcastle/status.json` (canonical), NOT `pgrep`.** The loop runs detached / inside a sandbox, so a bare `pgrep -f main.mts` is unreliable in *both* directions: it false-negatives (can't see the sandboxed process) and false-positives (matches your own grep/watcher command text). Determine liveness from the loop's own heartbeat instead:

   - Read `<repoRoot>/.sandcastle/status.json`. The loop is **running** iff `state == "running"` **AND** `updatedAt` is fresh — within ~4 minutes (2× the 120s status heartbeat, plus margin for GC pauses). Compare `updatedAt` to now.
   - **A `running` state with a stale `updatedAt` is a hard death, not a live loop** — report it as "died unexpectedly (status frozen on `running` at <updatedAt>)", not "running".
   - `state` of `done` / `stopped` means a clean finish; `restarting` is a transient self-restart.
   - Cross-check `.sandcastle/.loop.lock`: it is held while a loop runs and auto-expires ~60s after the holder dies. A held lock with a stale status is also a hard death.
   - You MAY run `pgrep -af '\.sandcastle/main\.mts'` as a *secondary* hint only — never as the primary signal, and never to conclude "running" on its own.

2. **Recent log activity.** Tail the last ~40 lines of the loop's run log — prefer `<repoRoot>/.sandcastle/run.log` (the loop's default on-disk log), falling back to `/tmp/sandcastle.log` if the run was launched with an explicit stdout redirect there. Look for:
   - Latest `=== sandcastle-loop iteration N/M ===` line (current iteration)
   - Phase markers (`[planner]`, `[implementer]`, `[reviewer]`, `[merger]`, `[post-merge-reviewer]`)
   - Errors or `ALL_CLEAR` / `POST_MERGE_ALL_CLEAR` markers
   - Retry-ladder markers (most action-driving signal — surface these explicitly to the user, don't bury in "running normally"):
     - `reviewer attempt 1 HAS_BLOCKERS — escalating implementer to` (per-issue retry escalation)
     - `--recovery on — attempting one recovery pass` (recovery pass before quarantine)
     - `rate-limit on` … `falling back to` (provider rate-limit fallback)

3. **Queue check.** From the project's git remote, run `gh issue list --state open --label ready-for-agent` to count how many issues are waiting.

4. **In-progress check.** Same `gh issue list` but with `--label in-progress` to show what's currently being worked.

5. **Circuit-breaker recovery sweep.** Grep the run log (`.sandcastle/run.log`, or `/tmp/sandcastle.log`) for `circuit breaker tripped` (and the bash variant `RALPH circuit breaker`). If a recent trip is present (in the current log file — don't worry about rotated logs):

   - List open issues that have NEITHER `ready-for-agent` NOR `in-progress` NOR `done` NOR `needs-human` NOR `quarantine`:

     ```
     gh issue list --state open --json number,title,labels --limit 100
     ```

     Filter the JSON locally to issues whose `labels[].name` set is disjoint from the canonical 5. Those are issues that were mid-claim when the breaker tripped — the `--remove-label ready-for-agent` part of the atomic edit landed even though `--add-label in-progress` errored, leaving them orphaned.

   - If 1+ matches: tell the user "found N issue(s) that lost their `ready-for-agent` label during the recent circuit-breaker trip: #X, #Y, #Z" and offer to re-label them. On user OK, run `gh issue edit <N> --add-label ready-for-agent` for each. Don't auto-relabel without confirmation — the side-effect could occasionally hit issues the user actually wanted to take out of the queue.

   - If 0 matches: mention the breaker trip in the report (so the user knows the loop didn't finish cleanly) but don't prompt for recovery.

6. **Stranded-issue sweep — HARD GATE.** Before saying anything like "all done" / "finished cleanly" / "loop wrapped up", count issues in the failure-end states:

   ```
   gh issue list --state open --label needs-human --json number,title
   gh issue list --state open --label quarantine  --json number,title
   ```

   - **If either list is non-empty, the report MUST lead with those issues** (count + numbers + titles). Do NOT say the loop "finished cleanly" or "all slices shipped" — there are unshipped issues that need human attention. The user explicitly missed this once and called it out as a discipline bug; the gate is non-negotiable.
   - If both are empty, proceed to the regular summary.

7. **Worktree cleanup sweep — soft gate.** Run `tail -n 200 .sandcastle/run.log | grep "cleanup WARN:"` (fall back to `/tmp/sandcastle.log`). If matches:

   - Lead the report with the count and the stale paths quoted from the WARN lines.
   - Suggest `git worktree remove --force <path>` per stale path, and mention `/sandcastle-clean` as the bulk option.
   - This is *not* the same kind of gate as step 6 (stranded issues = unshipped work). Cleanup-WARN = dirty disk, no work lost. Don't say "loop wrapped up cleanly" while these are present, but don't escalate as if work is missing.

   If no matches: continue.

8. **Memory + load.** If the loop is on a remote VPS (e.g. user's hub), include `free -h | head -2` and `uptime` in the report.

### Output to user (single machine)

Plain English summary:
- "Loop is running, on iteration 3 of 50, currently in the implementer phase for issue #X"
- "Loop is not running. Last iteration was N hours ago. M issues in the ready-for-agent queue."
- If step 6 found stranded issues: lead with "**N issue(s) need human attention: #X, #Y, #Z**" before any "loop finished" wording.
- If step 2 found retry-ladder markers, name the affected issue number and stage explicitly in the report — do NOT summarise as "running normally" or "iteration N, N slices in flight." Retry-ladder activity is by definition not the normal path. (Stranded-issue lead-with rule above still outranks this if both fire — issues that have already failed take precedence over issues currently retrying.)

Don't dump raw log output unless the user asks. Don't quote PIDs unless it's relevant for `/sandcastle-stop`.

If `status.json` shows `state: running` but `updatedAt` is stale (step 1), report a **hard death**, not a live loop: the loop crashed without writing a clean `stopped`/`done` state. Point the user at the run log (`.sandcastle/run.log`) for the last lines before the crash.

---

## All machines (fused)

Show what every machine on the shared run is doing, fused into one view. The cross-host status transport already publishes each host's snapshot to `refs/sandcastle/status/<hostId>` and the viewer sums counts across hosts — so this is mostly "point at the fused view," not new machinery.

**Precondition:** the run must have cross-host sync on (`SANDCASTLE_CROSS_HOST_SYNC=1`), otherwise hosts don't publish their status refs and there's nothing to fuse — fall back to the single-machine branch above.

1. **List the machines** from `.sandcastle/hosts.json` so the user knows the full set (some may be idle/offline).
2. **Show the fused live view:** launch the terminal viewer, which already fuses cross-host counts:
   ```
   pnpm sandcastle:watch
   ```
   It reads the local `status.json` plus every peer's published status ref and shows machine-tagged totals and the combined recent-activity feed. No per-host ssh needed — the fusion happens through the shared git refs.
3. **For a point-in-time summary without the live UI**, read the shared status refs directly (the same source the viewer uses): `git ls-remote origin 'refs/sandcastle/status/*'` gives the reporting hosts; each ref's commit message carries that host's snapshot (runId, branch, state, iterations, updatedAt). Summarize which hosts are `running` on which run, their iteration counts, and the fused merged/needs-human/requeued totals.
4. **Optional per-host health** (CPU/mem/uptime): for a remote host, `ssh <transport> -- 'uptime; free -h'`. Only when the user asks — the fused view is the primary answer.

### Output to user (all machines)

Lead with "N machines running run <branch>" and the fused totals, then per-machine detail (which host is on which issue). If only one host is publishing, say so — that's a single-machine run, and the cross-host view collapses to it. If sync is off, fall back to the single-machine branch above.
