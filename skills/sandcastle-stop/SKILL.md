---
name: sandcastle-stop
description: Stop a running sandcastle loop — this machine, or all running machines / a multi-host run. Use when the user wants to kill the loop or invokes /sandcastle-stop. On a bare invocation, ASKS which machines and how fast before acting. Graceful (default) finishes the current issue, exits, and releases leases so a peer reclaims. --now works on ANY path, single machine included: it kills within seconds, then reaps — checkpointing each in-flight issue's partial work to a WIP ref, releasing its lease and label, and correcting the status file so nothing is lost and nothing is left claiming to be in flight.
---

# Sandcastle Stop

Cleanly stops a running loop — on this one machine, or across every running machine in a multi-host run.

## 0. Ask what to stop (do this FIRST — skip only what flags already answer)

**Silence is not an answer.** A bare `/sandcastle-stop` tells you neither which machines nor how fast. Ask **once**, with `AskUserQuestion`, both questions **batched into a SINGLE call**:

- **Machines?** — `this machine (default) / all running hosts / pick one host`. Skip when `--all`/`--host` was passed, or `.sandcastle/hosts.json` lists a single host.
- **How fast?** — `graceful — finish the current issue, then exit (default) / now — save in-flight work and stop in seconds`. Skip when `--now` was passed.

**This picker is REQUIRED, and skipping it is not a FIDO win.** Stopping a loop mid-issue is destructive and irreversible — FIDO's own stated exception. "Which machines" and "how fast" are WHAT (which target, what happens to in-flight work), not HOW. A global "default to action / never ask" instruction does not authorize guessing here.

But **do not re-ask what the user already said**: phrasing like "stop now", "kill it", "stop everything", "I'm leaving" IS the answer — take it and go. The picker is for genuine silence, not for confirmation.

## Which path

- **Single machine:** stop the loop running for THIS repo on THIS machine.
- **All machines (`--all`) / one remote (`--host <name>`):** stop the loop across a multi-host run, reading the host registry. Default target for this path = **all running** hosts; `--host <name>` narrows to one. Use this when the user is stopping a run that spans more than one machine (e.g. this Mac + the VPS).

## How fast — BOTH paths support both modes

These are orthogonal to the path. A single-machine stop can be `--now` too; do not treat `--now` as an all-machines-only feature.

- **graceful (default):** each loop finishes the issue it's on, then exits. Nothing is lost; on exit it releases its held leases so a peer reclaims the remaining queue immediately (no 15-min wait). Use when you have time and a connection.
- **`--now` (immediate):** kill each loop right away, then **reap** — checkpoint each in-flight issue (commit its worktree, push the work to a WIP ref), release its lease, release its `in-progress` label, and correct its status file — so another machine continues that issue from the checkpoint instead of redoing it, and nothing is left claiming to be in flight. Use when you're leaving your desk / about to lose internet. The checkpoint push runs while you're still online; if it can't reach origin, the peer still reclaims via the lease TTL.

**`--now` means seconds, not minutes.** Exactly ONE thing may precede the first signal: the cwd-filtered PID scope (it stops you killing another project's loop — a real bug that has shipped here, not a hypothetical). Everything else — liveness freshness, integration-branch discovery, host reporting, PID confirmation — happens AFTER the signal. Do not narrate the scoping. If you are typing a sentence before the first `kill`, you are already too slow.

---

## Single machine

**Order matters.** Step 1 is the ONLY safety-critical precondition — it is what stops you signalling another project's loop. Do not gate the signal on anything else. In particular, do NOT read `status.json` to decide whether to act: a matching process IS the liveness evidence, and `status.json` is merely a file the loop writes — strictly weaker (a stale `running` is a *prior hard death*, and a hard-dead loop leaves it saying `running` forever). Its freshness earns its place in the step-5 report, not as a gate. Signalling an already-dead PID is a harmless no-op; the cwd filter is what guarantees you never touch another project.

1. **Find the PID to signal — SCOPED TO THIS PROJECT.** A bare `pgrep` on `.sandcastle/main.mts` is **project-blind**: every sandcastle loop on the machine has the identical command line, so it will surface loops belonging to *other* repos — and killing the wrong project's loop is a real hazard here (this is the kill path, not just a warning). Filter candidates by the process's working directory so you only ever signal *this* repo's loop:
   ```
   for pid in $(pgrep -f '\.sandcastle/main\.mts (--iterations|--issue|--max-concurrent|--repo-root|--branch)'); do
     cwd=$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p')
     [ "$cwd" = "$PWD" ] && echo "$pid"
   done
   ```
   (If the loop was launched with `--repo-root <other>`, compare against that path instead of `$PWD`.) Do this silently — no narration, no "let me check". **Exactly one PID → proceed straight to step 2, don't announce it and don't ask.** If **more than one** PID survives the cwd filter, that is genuine ambiguity: list them and ask before signalling. If **zero** survive, say "nothing running for this repo" and stop (if `status.json` claims `running`, that's a prior hard death — offer step 4's reap to clean up the lie).

2. **Signal — immediately.**
   - **graceful:** `kill <PID>` (SIGTERM). The orchestrator's handler finishes in-flight ops then exits, writing `state: "stopped"` on the way out. Then step 3.
   - **`--now`:** `kill -9 <PID>` (SIGKILL). Stops in seconds; the per-issue worktrees survive on disk. Skip step 3 and go straight to step 4 — the reap is what makes this safe, and it is NOT optional.

3. **(graceful only) Wait up to 30 seconds.** Poll every 2 seconds. If it didn't exit:
   - Tell the user it's taking longer than expected — it's most likely mid-planning, and a **graceful stop cannot interrupt a planning agent**, which can run several minutes. That's the honest reason, not a hang.
   - Offer SIGKILL. Require explicit OK. If they accept, **you MUST run step 4's reap afterwards** — a force-quit without the reap is what leaves stuck `in-progress` labels, orphaned leases, and a status file frozen at `running`.

4. **Reap — MANDATORY after any SIGKILL / hard death, on this path too.**
   ```
   tsx .sandcastle/scripts/checkpoint-stop.mts --integration-branch <run-branch> [--repo-root <path>]
   ```
   Discover `<run-branch>` NOW, after the kill — from the shared status refs, or ask only if discovery genuinely fails. Never gate the kill on it: nothing about signalling needs it.

   A SIGKILL'd loop cannot clean up after itself — SIGKILL is uncatchable, so no handler runs. This external reap is the ONLY thing that can clean up on its behalf. Skipping it is what makes the viewer lie.

   **Today the script only does the git half** (WIP refs + lease release), and it *skips the lease release for a worktree with nothing to save* — which for a dead loop leaves an orphaned lease nobody can free. Until that's fixed in the script, finish the reap BY HAND:
   - **Labels:** for each issue the loop held, `gh issue edit <N> --remove-label in-progress --add-label ready-for-agent`. Nothing in the script touches labels; without this the queue thinks issues are being worked on by a dead machine. (Safe: resume finds saved work via the WIP ref, not the label.)
   - **Orphaned leases:** `git ls-remote origin 'refs/locks/*'` — an expired lease is inert (peers reclaim anyway), so leave it. Only mention it if the user asks.
   - **Status file:** if `status.json` still reads `state: "running"`, or carries in-flight `issues[]` / a stale `activity` / a non-zero `totals.running` while nothing runs, correct it — that file is what the viewer reads, and nothing else will fix it.

5. **Verify the stop actually landed — don't assume the signal worked.** After the process is gone, re-read `status.json`:
   - `state == "stopped"` (fresh `updatedAt`) → confirmed graceful stop. Report the final iteration and any sub-worktrees needing cleanup (suggest `/sandcastle-clean`).
   - `state` still `running` (frozen `updatedAt`) → the loop **died hard, it did not stop gracefully** — say exactly that. The graceful-stop contract was NOT honored (e.g. an OOM/crash mid-iteration, or a SIGKILL). Point the user at `.sandcastle/run.log` for the last lines, and warn there may be half-written state to clean up.

---

## All machines (`--all` / `--host`)

1. **Find running hosts — in PARALLEL.** Read `.sandcastle/hosts.json`. For each host, detect a live loop for THIS repo using the same cwd-filtered pgrep as the single-machine path above — locally for this machine, and over `ssh <transport> --` for each remote host (compare each surviving process's cwd against that host's repo path). **Fan the ssh calls out concurrently, not serially**, and do NOT report which hosts are running before signalling — fold that into the final report. Default target = all running; or one via `--host <name>`.

2. **Graceful path (default):** send `SIGTERM` to each target's loop PID (locally, or over ssh). Poll its `status.json` up to ~30s for `state: stopped`. The loop's own shutdown releases its leases (ADR 0021 §4). Escalate to `SIGKILL` only with explicit user OK — and if you do, the reap in 3b is then MANDATORY for that host.

3. **`--now` path:**
   a. **`SIGKILL` each host as soon as its own scope returns** — do not wait for the full sweep, and do not discover the integration branch first. Nothing about killing a process needs the branch; only the reap does. The per-issue worktrees survive on disk.
   b. **Then** reap ON each target host (over ssh for remote). Discover the run's integration branch now — from the shared status refs, or ask only if discovery genuinely fails:
      ```
      tsx .sandcastle/scripts/checkpoint-stop.mts --integration-branch <run-branch> [--repo-root <path>]
      ```
      It finds the abandoned `agent/issue-<N>` worktrees, commits+pushes each to `refs/sandcastle/wip/issue-<N>`, and releases each `refs/locks/issue-<N>` lease so a peer reclaims immediately. It reports one line per issue (`checkpointed` / `nothing-to-save` / `error`). **It does NOT touch labels or `status.json`** — finish those by hand per the single-machine path's step 4, on each host you killed.

4. **Report** per host: stopped (graceful) or the reap summary (`--now`). Confirm every target is down (re-read `status.json` / re-run the cwd-filtered pgrep).

## Talking to the user

The signal-handling lingo isn't useful. Just say "asking it to stop cleanly... (waiting for current work to finish)... stopped." Plain English.

For `--now` (either path), make the guarantee explicit: the in-flight work is saved to a WIP branch and the other machine will pick it up — nothing merged is ever at risk. If a checkpoint push failed (offline), say so and note the peer still reclaims via the lease TTL. Never SIGKILL without either `--now` or explicit consent.

**Report what you actually left behind.** The reap is the difference between "stopped" and "stopped and tidy", and its gaps are the user's problem, not an implementation detail. If any label, lease or status file is still claiming work is in flight when you finish, say so plainly and say what you did about it. A stop that reports "done" while the viewer still shows work in progress is the single loudest way this tool lies to its user — and the user WILL see it on their phone.
