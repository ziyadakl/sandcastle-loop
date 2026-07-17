---
name: sandcastle-clean
description: Clean up leftover sub-worktrees, old logs, and stale branches from past sandcastle runs — on this machine, or across all my machines / every host. Use when the user wants to free disk space or invokes /sandcastle-clean. Refuses per-host if a loop is running there. Verifies merged-status against origin before removing each worktree.
---

# Sandcastle Clean

Removes safe-to-delete leftovers from past runs — on this one machine, or on every machine in the host registry.

Leftovers are **per-machine**: each host has its own `.sandcastle/worktrees/`, its own logs, and its own local branch refs. Cleaning this Mac does nothing for the VPS. That's why the all-machines path exists.

## 0. Ask which machines (do this FIRST — skip only what flags already answer)

Ask **once**, with `AskUserQuestion`:

- **Machines?** — `this machine (default) / all hosts / pick one host`. Skip when `--all` / `--host <name>` was passed, or `.sandcastle/hosts.json` is missing or lists a single host (then it's single-machine, no question needed).

Phrasing like "clean everything", "clean both machines", "clean the VPS" IS the answer — take it and go. The picker is for genuine silence.

This is a WHAT question (which target), not a HOW question, and the operation is destructive — so it survives FIDO's default-to-action rule.

## Which path

- **Single machine (default):** clean this repo on this machine.
- **All machines (`--all`) / one remote (`--host <name>`):** read `.sandcastle/hosts.json` and clean each target host over its transport.

The per-host procedure is IDENTICAL on both paths. The only differences are where the commands run and that each host gets its own pre-flight.

---

## Pre-flight — PER TARGET HOST, never once globally

1. **Loop running ON THAT HOST?** Run the cwd-filtered pgrep **on the host being cleaned** — locally for this machine, over `ssh <transport> --` for a remote. If it returns a PID, **refuse for that host only** and tell the user to `/sandcastle-stop` (that host) first. Other hosts still proceed.

   ```
   for pid in $(pgrep -f '\.sandcastle/main\.mts (--iterations|--issue|--max-concurrent|--repo-root|--branch)'); do
     cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p')
     [ "$cwd" = "$PWD" ] && echo "$pid"
   done
   ```

   **This check MUST run on the target, and this is the whole reason the all-machines path is delicate.** A local pgrep cannot see the VPS's loop. Removing a worktree out from under a *running* loop destroys work in progress that no WIP ref has captured yet. Never let this machine's quiet pgrep authorize a remote deletion.

   The check is also **project-scoped by cwd on purpose**: every sandcastle loop on a machine shares an identical command line, so a bare `pgrep` surfaces *other* repos' loops and would refuse for the wrong reason. For a remote host, `ssh` lands in the login dir — `cd <repoPath>` first (from that host's registry entry) so `$PWD` is the checkout.

2. **Confirm the target is a sandcastle project.** `.sandcastle/` must exist at that host's repo root. If not, skip that host with a reason.

3. **Reachability (remote only).** If ssh fails, skip that host with `unreachable` — never treat an unreachable host as a clean one.

## What to clean — per host

In order, with user confirmation before each destructive step:

1. **Sub-worktrees** at `.sandcastle/worktrees/agent-issue-*/`.
   - Run `git worktree prune` first to clear any dangling registrations (`.git/worktrees/agent-issue-*/`) from sub-worktree directories that were manually deleted in the past. Without this, subsequent `git worktree remove` calls fail with confusing errors.
   - **Enumerate with `git worktree list --porcelain`, not a shell glob**, then keep only paths under `.sandcastle/worktrees/` whose basename starts with `agent-issue-`. Git is the source of truth (a glob sees directories git no longer tracks, and misses registrations whose directory is gone), and it's shell-independent — hosts differ, and an unmatched glob under zsh *aborts the command* rather than expanding to nothing, so `ls ... || echo none` fallbacks silently do the wrong thing on a zsh host.
   - **NEVER remove `.sandcastle/worktrees/staging`, and never delete `integration-candidate`.** That worktree is the persistent staging tip the merger lands certified work on, and the branch is a deliberate long-lived integration branch — it routinely reports as fully-merged/0-ahead, so every "is it merged?" heuristic here says it's safe to delete. It is not. The `agent-issue-` filter above is what keeps it out; if you ever widen the filter, restore this exclusion explicitly.
   - **Fetch first: `git fetch origin`.** The merged-check below is only as good as this host's view of origin. On a multi-host run *another machine* may have merged the work, and a host with a stale local integration branch will call perfectly-shipped work "not merged yet" — noisy, but it errs safe (skip + warn), so never invert this into auto-deleting on a stale ref.
   - For each remaining live sub-worktree:
     - Get the worktree's branch name (`agent/issue-N`)
     - **Check merged-status BEFORE removing**, against origin's integration branch: `git log origin/<integration>..agent/issue-N` returns empty → merged.
     - If **NOT merged**: skip and warn — the work isn't shipped yet. Also check for a checkpoint, **on that host and on origin**, in this order:
       ```
       git rev-parse --verify refs/sandcastle/wip/issue-N     # local to this host — ALWAYS written
       git ls-remote origin refs/sandcastle/wip/issue-N        # only present when cross-host sync is on
       ```
       If either resolves, the work IS captured on a WIP ref — say that instead of implying it's at risk. **Check the local ref first and never rely on origin alone:** WIP refs are written locally unconditionally but pushed to origin only when `SANDCASTLE_CROSS_HOST_SYNC=1`, so an origin-only probe reports "nothing saved" for every checkpoint on a sync-off run — the exact moment the user most needs to be told their work is fine.
     - If **merged**: `git worktree remove <path>`. If that refuses, check `git status --porcelain` inside; only use `--force` if the working tree is clean. Otherwise skip and warn — a dirty tree on a merged branch is uncommitted work nobody has seen.

2. **Old log files** at `.sandcastle/logs/*.log` older than 7 days. Just `rm` them.

3. **Backup folders** named `.sandcastle.old-*`, `.sandcastle.broken-*`, `.sandcastle.bak-*` in the project root. These are from past failed inits. Confirm with user before removing each.

4. **Stale `agent/issue-*` branches.** After removing worktrees, the branches may still exist as refs. For each:
   - Try `git branch -d <branch>` (the safe variant). Git refuses unless the branch is merged into the currently-checked-out branch — that's the safety net.
   - If `-d` refuses, surface the branch in the refused list with one of these reasons:
     - `squash-decoupled` — likely landed via a squash-merged human PR to `main`, so the original commits are no longer ancestors.
     - `worktree-locked` — a worktree still has the branch checked out elsewhere.
     - `unknown-refuse` — anything else.
   - Do NOT escalate to `git branch -D` automatically. Require explicit user confirmation per refused branch. Show them the reason and the candidate launch branches checked; let them decide.

## All-machines mechanics

- **Fan the ssh calls out concurrently, not serially** — the read-only survey (pre-flight + what's cleanable) is safe to parallelize, and a serial sweep across hosts is needlessly slow.
- **Survey first, then confirm, then delete.** Gather the full picture across all hosts, show the user one combined proposal, and only act on OK. Do NOT prompt per-host mid-sweep — that's a confirmation treadmill, and the user can't see the whole cost while answering the first one.
- **One host's failure never aborts the others.** Collect per-host outcomes (`cleaned` / `skipped: loop running` / `skipped: unreachable` / `skipped: not a sandcastle project`) and report them all.
- Branch and worktree deletions are **local to each host** — cleaning the VPS never deletes anything on origin, and never touches another host's disk.

## Output to user

For each item, tell them what you found and what you propose. Wait for OK on the destructive steps. Plain English.

After cleanup, report disk space recovered (`du -sh` before and after) so they see it was worth it. On the all-machines path, report it per host and as a total.

For `agent/issue-*` branches refused by safe `-d`, list each with the reason code (squash-decoupled / worktree-locked / unknown-refuse). The user picks which to force-delete with `-D` after reviewing — never auto-D.

**Say plainly which hosts you did NOT clean and why.** A host skipped for a running loop is the single most likely outcome on a multi-host run, and silently reporting "cleaned!" while the VPS is still full of worktrees is the version of this that wastes the user's time.
