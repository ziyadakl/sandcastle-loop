---
name: sandcastle-status
description: Report what the sandcastle loop is doing now, or what a finished run left behind. Use when the user asks how the loop is going, what happened overnight, whether a run finished cleanly, why a ticket stopped, or invokes /sandcastle-status — on this machine, or fused across every machine on a shared run.
---

# Sandcastle status

The loop is the unattended sandcastle run that ships tickets with nobody watching. This skill reports what it is doing now, or what it left behind when it finished.

**Cross-host.** Follow [`all-machines.md`](all-machines.md) beside this file when EITHER is true: the user asks about _all their machines_ / _every host_ / a _shared_ or _combined_ run, **or** `git ls-remote origin 'refs/sandcastle/status/*'` returns more than one host for the same run. A multi-host run stays multi-host however the question was phrased — one machine's files describe one machine's share of the work and nothing else.

## The clean-end guardrail

**No wording implying a clean end may appear while anything below is unfinished.** That covers "finished cleanly", "all done", "all slices shipped", "wrapped up", and every paraphrase — the ban is on the meaning, not on a list of strings.

Unfinished means any of: the loop is dead (step 2); a ticket is stranded (step 4); tickets fell out of the queue (step 3); screen checks are missing, partial or unusable (step 5); step 1 could not resolve which machine ran the loop; stale worktrees remain (step 6).

When the only outstanding item is stale worktrees, say "finished, with leftovers on disk". When the loop reached `done` or `stopped` with none of the above, it finished cleanly and you may say so.

## What the report leads with

Gather every step, then open with the highest rank that fired. Lower ranks still appear further down. Exception: when step 1 cannot resolve a host, stop there and report that — the remaining steps would read the wrong machine's files.

1. **The loop is dead** (step 2). It crashed or froze while its own status still claimed `running`. Say when it died, what it was part-way through, and how much of the queue never ran.
2. **The instrument is broken** (step 5). The screen checks came back unusable run-wide, so the run's central claim — that a browser looked at the work — is worthless for every ticket it shipped.
3. **Loud stops** (step 4). A ticket carrying `stopped:check-disagreement`, `stopped:checks-tampered` or `stopped:could-not-grade`. The loop already raised an alarm on each, and a check-disagreement is parked waiting on the owner personally to break the tie.
4. **Quiet stops and other stranded tickets** (step 4). The rest of the stranded pile. Unshipped work, but routine disposal.
5. **Tickets that fell out of the queue** (step 3). The circuit breaker tripped and left tickets with no queue label. The planner cannot see them, so they will never be picked up again until someone restores the label.
6. **A ticket shipped over a disagreeing check** (step 5, watch-only mode only). It carries no label and appears in no `gh` list, so this is the only place it surfaces.
7. **Retry ladder** (step 2). The run is alive but off the normal path — escalation, a recovery pass, or rate-limit fallback. Name the ticket and the stage.
8. **Cleanup warnings** (step 6). Stale worktrees on disk. Dirty disk, no work lost.
9. Otherwise the plain summary.

Ranks 3 and 4 carry a count, the ticket numbers, and their titles. A bare "some tickets need you" leaves the owner nothing to judge the size of the problem by.

---

## 1. Which machine ran the loop

Every step below reads files, and those files live on the host that RAN the loop. Since 2026-08-04 the default launch target is the remote `vps` host, so the common case is that all of it is remote.

Read `.sandcastle/hosts.json`. One host with `transport: "local"` means every read below is local.

Otherwise list the published status refs — `git ls-remote origin 'refs/sandcastle/status/*'`. **The ref name is the machine's own hostname** (`os.hostname()`, sanitised — e.g. `ziyads-macbook-air.local`), while `hosts.json` entries carry `name` (`local` / `vps`), `transport` and `maxConcurrent`. There is no shared key between them, so match by judgment: the local machine's hostname identifies the `local` entry, and a ref that is not this machine belongs to a remote entry whose `transport` is its ssh alias. When two entries could match, ssh to each in turn and read its `.sandcastle/status.json` to see which one holds the run.

Then read every file below as `ssh <transport> -- 'cat <repoPath>/<file>'`.

When nothing is published and this machine's `.sandcastle/status.json` is stale or absent, say which hosts you checked and that you could not resolve one, and stop. **Never report a death you inferred from a local file on a machine that was not running the loop** — a stale local snapshot from an earlier run is the easiest way to tell the user a healthy loop has crashed.

## 2. Liveness and the run log

**Liveness comes from `.sandcastle/status.json`, the loop's own heartbeat**, on the host resolved in step 1. The loop runs detached inside a sandbox, so process-table checks mislead in both directions — they miss the sandboxed process and match your own command text. `pgrep` may serve as a corroborating hint after the heartbeat has already answered; it never answers on its own, and it never establishes "running".

`state` has six values. Classify into:

- **Running** — `state == "running"` AND `updatedAt` within 3 minutes of now. That is the project's own staleness bound (`STALE_AFTER_MS = 180_000`, 1.5× the 120s heartbeat, `.sandcastle/lib/status/schema.ts`); the terminal viewer flags stale at the same point, so a looser window here would disagree with what the user sees on screen.
- **Crashed** — the snapshot's `hostId` is THIS machine and `process.kill(<pid>, 0)` throws `ESRCH`. Proven dead now: report it as "crashed — the loop process (pid `<pid>`) is gone, work may be recoverable", at full strength rather than softened to "stale" or "quiet", and without waiting out the staleness window. Probe the pid only on a same-host snapshot; a peer's pid cannot be signalled from here and its frozen `running` is Frozen below.
- **Frozen** — `state == "running"` with a stale `updatedAt` and no same-host pid to probe. A hard death inferred from the stopped heartbeat: "died unexpectedly (status frozen on `running` at `<updatedAt>`)".
- **Unhealthy or stopping** — `unhealthy` is a terminal failure state, `stopping` a shutdown in progress. Neither is a clean finish and neither is alive; report each by name.
- **Finished** — `done` or `stopped` is a clean exit; `restarting` is a transient self-restart.

**Cross-check `.sandcastle/.loop.lock` in every case, not only on a Frozen verdict.** It is held while a loop runs and auto-expires ~60s after its holder dies, so a held lock beside a `stopped` status is a contradiction worth reporting — `/sandcastle-run`, the skill that starts a loop, will refuse to launch while it is held.

Crashed, Frozen and Unhealthy are all rank 1. Point the user at the run log for the last lines before the end.

**The run log**, resolved once here and referred to as "the run log" by every step below:

- `<repoRoot>/.sandcastle/run.log` — the loop's default on-disk log (`main.mts` writes it unless given another path);
- `/tmp/sandcastle-<host-name>.log` — where the multi-host launcher redirects the wrapper's stdout, taking `<host-name>` from the `name` field of that host's `hosts.json` entry (`local`, `vps`).

Check both and use whichever exists and is newer. A missing file is not an absence of the thing you were grepping for — say the log was unreadable rather than reporting a clean grep.

Tail ~40 lines and pull out:

- the latest `=== sandcastle-loop iteration N/M ===` line, for the current iteration;
- the phase in flight (`[planner]`, `[implementer]`, `[reviewer]`, `[merger]`, `[post-merge-reviewer]`);
- errors, and the `ALL_CLEAR` / `POST_MERGE_ALL_CLEAR` markers;
- **retry-ladder markers**, rank 7 — `reviewer attempt 1 HAS_BLOCKERS — escalating implementer to` (per-ticket escalation), `--recovery on — attempting one recovery pass` (a recovery pass before quarantine), and `rate-limit on` … `falling back to` (provider fallback).

## 3. The queue, and tickets that fell out of it

```
gh issue list --state open --label ready-for-agent    # waiting to be picked up
gh issue list --state open --label in-progress        # being worked right now
```

Then grep the run log for `Circuit breaker tripped` — **capital C**, the literal `main.mts` logs. A trip strands tickets mid-claim: the `--remove-label ready-for-agent` half of the atomic label swap lands while the `--add-label in-progress` half errors. Find them with

```
gh issue list --state open --json number,title,labels --limit 100
```

filtered locally to issues whose `labels[].name` set is disjoint from all five of `ready-for-agent`, `in-progress`, `done`, `needs-human` and `quarantine`. Matches are rank 5 — the planner cannot see them, so they are dropped for good until relabelled. Report them as "N ticket(s) lost their `ready-for-agent` queue label when the run's circuit breaker tripped: #X, #Y" and offer `gh issue edit <N> --add-label ready-for-agent`. Restore only on the user's OK — some may have been pulled from the queue on purpose. With a trip but no matches, report the trip alone; nothing needs restoring.

## 4. Stranded tickets, and why each one stopped

```
gh issue list --state open --label needs-human --json number,title,labels
gh issue list --state open --label quarantine  --json number,title,labels
```

`needs-human` rides on **every** stop unconditionally, so it alone is the complete stranded set. `quarantine` is a legacy synonym that readers are required to keep accepting (`.sandcastle/lib/state/gh.ts`), so query it too and expect it to be empty.

The reason lives in an additional `stopped:*` label on the same ticket, splitting the pile into ranks 3 and 4:

| Label                        | Rank      | What it means for the user                                                                                                                                                                   |
| ---------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stopped:check-disagreement` | 3 — loud  | The builder finished and the check disagrees. The owner breaks the tie; nobody inside the loop is allowed to. Also carries `needs-owner-decision`.                                           |
| `stopped:checks-tampered`    | 3 — loud  | The builder edited the locked check file twice. This is about the lock failing to hold, not about that ticket.                                                                               |
| `stopped:could-not-grade`    | 3 — loud  | The browser could not grade it — the page never finished, the wrong page came up, a sign-in or app error blocked it, or it produced no result at all. An app fault, not that ticket's fault. |
| `stopped:no-failing-check`   | 4 — quiet | The check passed on untouched code, or the practice world lacks the data. Re-queue it.                                                                                                       |
| `stopped:already-built`      | 4 — quiet | This looks already implemented. Verify by content, then close.                                                                                                                               |

The three loud ones already raised an alarm when they happened. A stranded ticket carrying no `stopped:*` label stopped some older way — rank 4.

When the user asks **why** a ticket stopped, read the issue body: the loop writes the full explanation, including what the check demanded versus what the builder produced, into a section between `<!-- sandcastle:stop-report:start -->` and `<!-- sandcastle:stop-report:end -->`. Fetch it with `gh issue view <N> --json body`.

**`needs-rerun` is transient and belongs in the plain summary, not the stranded pile.** A ticket the loop parked that way (run-log line `releasing label for re-claim (needs-rerun)`, rendered as "Needs re-run") had its queue label released so the loop — or a peer host — reclaims it automatically next cycle. Report it as "will retry automatically".

## 5. Screen checks — did the robot prove it looked?

This is the signal the run exists to produce, and it surfaces nowhere else mid-run.

Read the git-tracked telemetry at `.sandcastle/telemetry/issues.jsonl` on the host from step 1. Each entry carries `screenCheck { verdict, screen, whenIso, rerun, pictureStored, pictureLink, attemptVerdicts }`. Filter to this run's `runId`, then report three things:

- **The mode.** `grep 'screen check:' <run log>` yields `screen check: ENFORCING` (a red or ungradeable result stops the ticket) or `screen check: WATCH-ONLY` (the verdict is recorded but the ticket ships anyway). The mode is absent from the telemetry file on purpose — its only writer, `.sandcastle/lib/telemetry/rework-store.ts`, has no field for it. If the grep finds nothing, read `describeScreenCheckMode` in `.sandcastle/lib/harness/enforcement-mode.ts`, which builds that line, and match its current wording rather than guessing the mode.
- **The verdict tally**, naming any ticket whose check disagreed. In watch-only mode those tickets carry no label and appear in no `gh` list, so telemetry plus the issue body's `<!-- sandcastle:screen-check-watch:start -->` section is the only way to see them. That section states what enforcement would have done — the number the settling-in period exists to produce — and each such ticket is rank 6.
- **Whether screenshots are filing** (`pictureStored`). All-false has two causes the log separates: `r2-not-configured` versus a genuine upload error. The four `R2_*` keys are per-machine and the launcher forwards only `SANDCASTLE_SCREEN_CHECK_ENFORCE`, so read the running host's own `.sandcastle/.env` before calling this a failure.

**Rank 2 fires on either of these:**

- every verdict in the run is `inconclusive`, `environment-fault`, `never-settled` or `claim-mismatch` — the four the code classes as the night's fault rather than the ticket's — and there is at least one verdict to judge;
- no ticket in the run carries a `screenCheck` field, **and** at least one UI ticket got far enough to reach the screen-check stage. A UI ticket that stopped earlier (`stopped:no-failing-check`, `stopped:already-built`, `stopped:checks-tampered`) never reached the browser, and explains the absence rather than proving a fault.

A missing `screenCheck` on a backend-only or schema-only ticket is correct and expected — the telemetry schema documents the field as simply absent in that case. Zero entries for this run, or an unreadable telemetry file, is "no screen checks recorded yet": it does not fire rank 2, it gets its own line in the report, and it blocks any clean-end wording.

## 6. Leftovers on disk

Grep the run log for `cleanup WARN:` (the last ~200 lines are enough). Matches are rank 8: quote the stale paths, suggest `git worktree remove --force <path>` for each, and mention `/sandcastle-clean`, the bulk cleanup skill, as the alternative. This is dirty disk, not missing work — say so, and keep it below any stranded ticket.

## 7. Host health

When step 1 resolved a remote host, include `ssh <transport> -- 'free -h | head -2; uptime'`, taking the alias from that host's `hosts.json` entry rather than a remembered host name.

---

## The report

Write it for a reader who is not an engineer and will not recognise a bare ticket number, filename or branch — every one carries a clause saying what it is. Name what went wrong in the world, not the mechanism that produced it.

Open with the highest-ranked item that fired. Only when rank 9 is the highest — nothing else fired at all — does the report open on the shape of the run itself:

- "The loop is running, on iteration 3 of 50, currently building ticket #X — <title>."
- "The loop is not running. It last moved N hours ago, and M tickets are queued up waiting."

Any higher rank takes that opening instead, and the iteration line moves below it. An opening built from the iteration count while a ticket is stranded or retrying reads as "everything is normal", which is the one impression the ladder exists to prevent.

**Run cost and timing** live at `totals.totalCostUsd` and `totals.perRole` inside `status.json` — nested under `totals`, not at the top level. Each `perRole` entry carries `costUsd`, `tokens`, `wallMs` and `runs`, so the spend breaks down per step (planner, implementer, reviewer) when the user asks where the money or the time went. Both are optional and additive; older status files omit them, and a role that only ran unpriced models has `costUsd: null` rather than 0. Absent means say nothing about cost rather than reporting zero.

Raw log output and PIDs stay out unless the user asks, or unless a pid is needed for `/sandcastle-stop`, the skill that kills a running loop.
