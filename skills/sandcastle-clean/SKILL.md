---
name: sandcastle-clean
description: Use when the leftovers of past sandcastle runs must be deleted — old sub-worktrees, logs, branches, refs, containers — or the user wants disk space back, on this machine or on every host, or invokes /sandcastle-clean.
---

# Sandcastle Clean

Removes safe-to-delete leftovers from past runs — on this one machine, or on every machine in the host registry.

Leftovers are **per-machine**: each host has its own `.sandcastle/worktrees/`, its own logs, and its own local branch refs. Cleaning this Mac does nothing for the VPS. That's why the all-machines path exists.

## Nothing is deleted without a proof

Every item under "What to clean" names the **proof** that the thing is worthless. Produce that proof, then delete. No proof, no deletion: leave it and say in one line which proof was missing.

Done when every leftover you found is either deleted with its proof, or named in the report with the proof it lacked. Nothing is swept unproven, and nothing proven-live goes unmentioned.

**Clean preserves; `sandcastle-complete` adjudicates.** Deciding what happens to unshipped work — land it, cherry-pick it, or call it dead — belongs to `sandcastle-complete`, the skill that lands a finished run on `main`. Clean surfaces such work and leaves it in place.

## 0. Ask which machines (do this FIRST — skip only what flags already answer)

Ask **once**, with `AskUserQuestion`:

- **Machines?** — `this machine (default) / all hosts / pick one host`. Skip when `--all` / `--host <name>` was passed, or `.sandcastle/hosts.json` is missing or lists a single host (then it's single-machine, no question needed).

Phrasing like "clean everything", "clean all my machines", "clean the VPS" IS the answer — take it and go. The picker is for genuine silence. One exception, and it applies only once the skip rule above has already left you asking: a phrase that names a COUNT rather than the hosts ("clean both machines") is an answer when the registry has exactly that many hosts, and ambiguous otherwise — then show the picker.

This is a WHAT question (which target), not a HOW question, and the operation is destructive — so it survives FIDO's default-to-action rule.

Then:

- **Single machine (default):** run everything below against this repo on this machine, confirming before each destructive step.
- **All machines (`--all`) / one remote (`--host <name>`):** read `.sandcastle/hosts.json` and run everything below against each target host over its transport — same gates, same proofs, same order, same refusals. The fan-out wrapper around them (surveying concurrently, confirming once, reporting per host) is [`HOSTS.md`](HOSTS.md); read it before starting.

## Pre-flight — three gates, PER TARGET HOST, never once globally

**These gates run on the target, and that is the whole reason the all-machines path is delicate.** A local process check — or a local `status.json` — cannot see the VPS's loop. Only that host's own quiet evidence authorizes deleting anything on that host.

### Gate 1 — is a loop alive on THIS host? Fail closed.

Gather all three signals **on the host being cleaned** — locally for this machine, over `ssh <transport> --` for a remote (`cd <repoPath>` first, from that host's registry entry, so `$PWD` is the checkout and `.sandcastle/status.json` and `.sandcastle/.loop.lock` resolve to that host's repo rather than the login dir). **Refuse for that host** if ANY signal says a loop may be alive, and tell the user to `/sandcastle-stop` that host first. Other hosts still proceed.

- **a. cwd-filtered pgrep returns a PID:**
  ```
  for pid in $(pgrep -f '\.sandcastle/main\.mts (--iterations|--issue|--max-concurrent|--repo-root|--branch)'); do
    cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p')
    [ "$cwd" = "$PWD" ] && echo "$pid"
  done
  ```
  The filter is project-scoped by cwd on purpose: every sandcastle loop on a machine shares an identical command line, so a bare `pgrep -fl main.mts` surfaces _other_ repos' loops and refuses for the wrong reason. If the loop was launched with `--repo-root <other>`, compare against that path instead of `$PWD` — otherwise no process ever matches the filter, the gate passes on silence, and you delete a live loop's worktrees.
- **b. `<repoRoot>/.sandcastle/status.json` has `state: "running"` AND a fresh `updatedAt`** — within ~4 minutes (2× the 120s status heartbeat, plus margin), per `/sandcastle-status` step 1's rule.
- **c. `<repoRoot>/.sandcastle/.loop.lock` is held** — it's held while a loop runs and auto-expires ~60s after the holder dies, so a held lock means a loop was alive within the last minute.

**Refuse on unreadable or ambiguous evidence too** — an unparseable `status.json`, an `lsof` you can't run, a lock whose state you can't determine. "I couldn't tell" is not "not running".

Two readings need care before you refuse or proceed: a `running` status whose `updatedAt` looks frozen, and a held `.loop.lock` with no live process beside it. Both are in [`LIVENESS.md`](LIVENESS.md), along with why this gate is stricter than its two sibling skills — read that before making it simpler.

**This refusal covers EVERY destructive step for that host — worktrees, coordination refs and lease locks, docker containers, and per-issue worktrees alike.** A live loop reads and writes coordination refs and runs inside its container; sweeping any of them mid-run corrupts the live run. A host that fails this gate is skipped whole.

### Gate 2 — is the target a sandcastle project?

`.sandcastle/` must exist at that host's repo root. If not, skip that host with a reason.

### Gate 3 — is the host reachable (remote only)?

If ssh fails, skip that host with `unreachable` — never treat an unreachable host as a clean one.

## What to clean — per host, in order

Each item states its proof. Run `git fetch origin` before the branch-merged proofs in items 1 and 4: they are only as good as this host's view of origin. On a multi-host run _another machine_ may have merged the work, and a host with a stale local view will call perfectly-shipped work "not merged yet" — noisy, but it errs safe (skip + warn), so read a stale ref as "leave it", never as "delete it".

### 1. Sub-worktrees at `.sandcastle/worktrees/agent-issue-*/`

**Proof:** the worktree's branch is merged into origin's integration branch — `git log origin/<integration>..agent/issue-N` returns empty. The integration branch is the run branch: `run.branch` in `.sandcastle/status.json`, which the loop sets from the launch branch argument (`integrationBranch: args.branch` in `.sandcastle/main.mts`).

Run `git worktree prune` first to clear any dangling registrations (`.git/worktrees/agent-issue-*/`) left by sub-worktree directories that were manually deleted in the past. Without this, later `git worktree remove` calls fail with confusing errors.

**Enumerate with `git worktree list --porcelain`, not a shell glob**, then keep exactly the paths under `.sandcastle/worktrees/` whose basename starts with `agent-issue-`. Git is the source of truth (a glob sees directories git no longer tracks, and misses registrations whose directory is gone), and it's shell-independent — hosts differ, and an unmatched glob under zsh _aborts the command_ rather than expanding to nothing, so `ls ... || echo none` fallbacks silently do the wrong thing on a zsh host. **`.sandcastle/worktrees/staging` and its `integration-candidate` branch stay, on every route into this skill — no proof deletes them, and no disk-space request overrides that.** Staging is the persistent tip the merger lands certified work on, and `integration-candidate` is a deliberate long-lived integration branch that routinely reports as fully-merged and 0-ahead, so every merged-status proof in this file says it is safe to delete. It is not. The `agent-issue-` filter is what enforces this at item 1; widen the filter and you must enforce it another way.

- **Proof holds → remove it.** `git worktree remove <path>`. If that refuses, check `git status --porcelain` inside; only use `--force` if the working tree is clean. Otherwise skip and warn — a dirty tree on a merged branch is uncommitted work nobody has seen.
- **Proof fails → the work isn't shipped. Keep it, and locate its checkpoint** on that host and on origin, in this order:

  ```
  git rev-parse --verify refs/sandcastle/wip/issue-N     # local to this host — ALWAYS written
  git ls-remote origin refs/sandcastle/wip/issue-N        # only present when cross-host sync is on
  ```

  If either resolves, the work IS captured on a WIP ref — say that instead of implying it's at risk. **Check the local ref first and never rely on origin alone:** WIP refs are written locally unconditionally but pushed to origin only when `SANDCASTLE_CROSS_HOST_SYNC=1`, so an origin-only probe reports "nothing saved" for every checkpoint on a sync-off run — the exact moment the user most needs to be told their work is fine.

  Then surface the branch as **`unadjudicated — run /sandcastle-complete to decide (land / cherry-pick / confirm-dead)`** and leave it in place. "Saved on a WIP ref" is preservation, not a verdict: the branch may be superseded, redundant, already shipped via a squash, or need surgical landing. In the normal `stop → complete → clean` flow, `sandcastle-complete` has already driven every branch to a terminal state, so a branch still showing up here unadjudicated means completion was skipped — say so.

### 2. Old log files at `.sandcastle/logs/*.log`

**Proof:** last modified more than 7 days ago. Then `rm` them. Done when every `.log` in that directory is either deleted or younger than 7 days.

### 3. Backup folders in the project root

**Proof:** the folder holds nothing the live `.sandcastle/` lacks — **and** the user approved that exact folder after seeing what is in it. The name (`.sandcastle.old-*`, `.sandcastle.broken-*`, `.sandcastle.bak-*`) selects the candidates; it never proves them empty. Look inside each and report two things before asking: any `worktrees/agent-issue-*/` directory whose branch has commits, and any prompt or config file that differs from the live one. `/sandcastle-update`, the skill that upgrades the loop, renames the old `.sandcastle/` out of the way, so one of these folders can hold the only copy of local customisations it replaced. Removal is limited to the folders you listed with their contents.

### 4. Stale coordination refs and lease locks

Sweep exactly these and nothing else: `refs/sandcastle/lanes/*`, `refs/sandcastle/peers/*`, `refs/sandcastle/peer-status/*`, `refs/sandcastle/status/*`, `refs/sandcastle/conflict/*`, and `refs/locks/issue-*` — on **local + origin + each host**, which are three separate locations, so enumerate each (sweeping this Mac never touches origin or the VPS's local refs). **`refs/sandcastle/strand/*` and `refs/sandcastle/wip/*` stay, in this item and in every other — they are preserved work rather than scheduling state, and on a run with cross-host sync off they are the only copy of it.** They go to `sandcastle-complete`, the skill that decides their fate. The sweep list above is exhaustive; widen it and you must keep those two out another way.

**Proof (any one of three):** the ref's tip is **merged into `main`** (`git merge-base --is-ancestor <tip> origin/main`); or it **matches an `archive/*` tag or branch** (`git for-each-ref refs/tags/archive/ refs/heads/archive/` contains the same SHA); or it **belongs to no run in `status.json` / `hosts.json`** and no loop is alive to own it. Prove none of those and the ref is treated as live — leave it and say why.

**The origin copy needs a wider liveness proof than the local one.** A lease lock on origin is a live claim made by whichever host is working that issue, and gate 1 only clears the host you are cleaning — so a quiet Mac says nothing about a VPS mid-run. Before deleting anything from origin, run gate 1 against **every host in `hosts.json`**, not just the target. Any host that comes back alive, unreachable or unclear leaves the whole origin sweep undone, reported as such; the local and per-host sweeps still proceed. Deleting a live lease strands the issue: the owning host keeps working it while the next launch hands the same issue to somebody else.

Delete a proven-worthless ref with `git update-ref -d <ref>` (local, and on each host over its transport) and `git push origin :<ref>` (origin). Leaving one behind poisons the next run — a lane ref still pointing at an archived tip fakes a merge conflict on the first iteration. In the normal flow `sandcastle-complete` purges these when it retires a run, so a survivor here comes from a run retired without a clean finalize.

### 5. Orphaned docker containers

**A container name carries no repo.** The loop names each one `sandcastle-<uuid>`, so `docker ps` tells you the machine a container belongs to and nothing more. Both rules below are therefore machine-wide, and this is the one item in the skill that reaches outside the repo you were pointed at — say so in the report.

- **EXITED `sandcastle-*` containers.** **Proof:** the exited state itself — dead state is worthless whichever project produced it. Enumerate with `docker ps -a --filter name=sandcastle- --filter status=exited -q` and `docker rm` them.
- **RUNNING `sandcastle-*` containers.** **Proof:** no sandcastle loop is alive anywhere on this machine — gate 1's pgrep with the cwd comparison dropped, so it matches every repo's loop rather than only this one. One live loop anywhere leaves **every** running container in place, because you cannot tell which container is its. Say that in the report rather than guessing: a container killed under its running loop destroys in-flight work no WIP ref has captured yet.

### 6. Leftover per-issue worktrees and their branches

**Proof:** the branch sits at base with nothing ever committed — `git log <base>..agent/issue-N` is empty AND `git rev-parse agent/issue-N` equals the base tip — **AND** `git status --porcelain` inside the worktree is empty. Then remove the worktree and delete the branch.

The working-tree half is what makes this safe. The commit-history half is blind to edits that were never committed, and a loop killed before its first commit leaves exactly that: a branch at base with real work sitting in the files and no `refs/sandcastle/wip/issue-N` checkpoint, because no reap ever ran. A dirty tree here keeps the worktree and goes in the report as uncommitted work nobody has seen — the same verdict item 1 gives it, and never a `--force`.

Skip any worktree on a `wip/issue-*` branch unconditionally: that is checkpointed work, and no empty-shell proof applies to it. This item is narrower than item 1 — item 1 handles worktrees whose branch HAS commits (merged → remove, unmerged → surface as unadjudicated); this one reaps the empty shells a crashed or never-started issue leaves behind.

### 7. Stale `agent/issue-*` branches

**Proof:** the branch is contained in origin's integration branch or in `origin/main` — `git merge-base --is-ancestor agent/issue-N origin/<integration>`, or the same against `origin/main`. Then delete it with `git branch -d <branch>`, which will also accept.

**Run that ancestry check yourself rather than reading `-d`'s acceptance as the proof.** Git's safe delete passes when a branch is "fully merged in its upstream branch, or in HEAD if no upstream was set" (`git branch --help`). A branch pushed with tracking is contained in its own upstream by definition, so `-d` accepts it while it has landed nowhere — and it would silently report unlanded work in the cleaned column. `-d` staying in the command is the second safety net, not the evidence.

When either the ancestry check or `-d` refuses, keep the branch and put it in the refused list with one reason:

- `squash-decoupled` — likely landed via a squash-merged human PR to `main`, so the original commits are no longer ancestors.
- `worktree-locked` — a worktree still has the branch checked out elsewhere.
- `unknown-refuse` — anything else.

Force-deletion with `git branch -D` waits for the user to name the branch, per branch, after they have read the report — including on the all-machines path, where it is a decision taken against a reviewed list rather than a prompt blocking the sweep. **Never escalate a refused `-d` to `-D` on your own initiative**, however obvious the reason code looks: a `squash-decoupled` branch's commits are ancestors of nothing, so `-D` on a wrong guess is unrecoverable. Give them the reason code and the branches you tested containment against, so `squash-decoupled` is a finding they can check rather than a label.

## Output to user

For each item, tell them what you found and what you propose, in plain English — the reader is not an engineer. Wait for an OK before every destructive step (on the all-machines path, that OK is the single combined one in [`HOSTS.md`](HOSTS.md)).

Take a `du -sh` baseline before item 1 deletes anything, and report the space recovered against it afterwards.

The report is done when every branch you kept is named: each `agent/issue-*` branch that safe `-d` refused, with its reason code, and each branch you surfaced as unadjudicated.
