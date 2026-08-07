---
name: sandcastle-complete
description: Use when a finished or stopped sandcastle run must be landed on main, or the user invokes /sandcastle-complete. Stopping the loop is sandcastle-stop; deleting leftovers is sandcastle-clean.
---

# Sandcastle Complete

Land a finished run on `main`. Target: minutes.

**Lifecycle: `sandcastle-stop` → `sandcastle-complete` → `sandcastle-clean`.** If the loop finished on its own, skip stop. Clean is always LAST, and it owns every deletion of leftovers. Starting the next run is always separate and deliberate.

A **terminal verdict** is one of exactly three states: **landed**, **re-queued**, or **confirmed dead**. This skill ends with every issue, branch and finding holding one. "Preserved, undecided" is not a verdict — it is next week's archaeology.

## Step 0 — Which path are you on?

Since **2026-07-30** the loop never closes issues itself: it labels them `shipped-local` and leaves them OPEN. It always pushes its branch and opens ONE **draft** run PR carrying `Closes #N` per issue, on every exit path including circuit-breaker trips, stalls, planner failures and uncaught exceptions. A crash can no longer strand work locally, and a closed issue means the code is on the default branch, by construction.

If the loop is still running, invoke `sandcastle-stop` FIRST. **Never hand-roll a kill** — a `kill -9` strands lease locks and is the one thing that forces the recovery path. Detect a live loop with a **cwd-filtered** pgrep; a bare `pgrep -fl main.mts` matches other repos' loops and false-positives.

Find the run branch (`run.branch` in `status.json` — not `runId`, which is the shared-run identity every host writes and is only incidentally the same string — or `git for-each-ref refs/sandcastle/lanes/`), then:

```
gh pr list --head <run-branch> --state all --json number,title,body,state,isDraft
```

`--state all`, never `--state open`: a PR someone already merged returns nothing from an open-only query, and routing that run into recovery wastes an hour on work that is already on `main`.

- **An open PR exists → step 1 below.** The normal case. Do NOT adjudicate "closed but did it really ship?", do NOT hunt stranded branches, do NOT reconcile lanes — on a post-2026-07-30 run those are re-derivations of a guarantee the loop already gives you.
- **The PR already merged before completion ever ran → step 1, retroactively.** Every run PR goes through this skill, merged or not: run every step over the range `<merge>^1..<merge>` in place of the PR diff. That the run landed unreviewed is itself a finding — say so.
- **No PR at all → [`RECOVERY.md`](RECOVERY.md).** Rare, and the cause is not always a bug: a hard `kill -9`, a run predating the 2026-07-30 change, a hot-reload restart (exit 75) that deliberately skips PR-opening, or a push that failed silently — the loop's own finish step is best-effort and never throws. Tell the user you are going there, and which of those it looks like, before spending their time on it.

### 1. Read the PR body — it is the manifest

The loop already wrote which issues shipped, which failed promotion, and which were carried from an interrupted earlier run. Rebuilding that by hand is the waste this step exists to prevent.

Done when you can name, for every issue in `Closes #N`, which of those three it is. Two of them change what you do next:

- **A "promotion failed" warning** means the branch may be incomplete relative to what was certified. Treat the PR as suspect and read what failed before merging.
- **A "previously shipped by an interrupted run" section** lists issues still wearing `shipped-local` whose code presence on this branch could NOT be verified. They are deliberately excluded from `Closes #N`. Check each one by content before assuming it landed; if it did not, it needs re-queueing.

### 2. Run the gate

```
pnpm verify:land        # or the project's equivalent
```

This is the pre-merge check written down as one command — a disposable database plus the suites that CI would run if CI ran. It exits 0 only if every stage passed. Treat "0 items compared" from any stage as a failure, not a pass.

A failure here is a real blocker: fix it or re-queue it, and merge only once it exits 0.

### 3. Review the run as one body of work

**Run BOTH `/thermo-review` and `/superpowers:requesting-code-review` over the run PR as a whole. This is mandatory, not sized to the diff** — the loop's own reviewers judge each ticket alone, so until this pass nobody has ever judged the tickets together.

Then apply the standing correctness checks that a sandbox structurally cannot verify. Done when every one has an answer for every new surface in the diff:

- **Unwired** — nothing calls it. Grep real callers of every new procedure, route and component (exclude build output and its own tests). Zero non-test callers means not done, however green the tests are.
- **Inert** — everything calls it and it still does nothing, because the inputs it reads are never populated. Trace each new input back to the code that writes it: a field no writer ever sets, a queue nothing enqueues to, a flag nothing flips. All three pass their tests and change nothing in the product.
- **Tests assert the right thing** — this repo has twice shipped suites that were green _because_ the bug was present. Check what each new assertion _should_ say, not just that it passes.
- **Tenancy** — row-level security enabled with a policy on any new tenant table; real route guards, not hidden nav.
- **Deploy config the sandbox cannot see** — scheduled jobs and newly-required secrets. A shipped handler does nothing until something calls it on a schedule. Emit each as an explicit to-do for the human owner.

### 4. Screen-check dissent — before merging, and invisible from the PR

Since **2026-08-04** the loop runs its own browser check per ticket, and the run PR body carries none of that. Reading the PR cannot surface a disagreement, so go look — at every issue in `Closes #N`, **plus** the "previously shipped by an interrupted run" issues and any quarantined ones, which carry the same sections while sitting outside `Closes` and are the least verified tickets in the run:

```
gh issue view <N> --json body -q .body | sed -n '/screen-check-watch:start/,/screen-check-watch:end/p'
```

Read marker to marker rather than a fixed `grep -A20`: the block runs past twenty lines, and the tail it drops holds the builder's own account and the resolution — the half that makes the disagreement legible.

**First, establish which mode ran, for the whole run, before reading any hit.** It is not in the telemetry file: `grep 'screen check:' <run.log>` prints `WATCH-ONLY` or `ENFORCING` once per host. Under enforcement a dissenting ticket never shipped at all — it stopped with a `stopped:*` label — so reporting its marker as live dissent is a false alarm.

**Then date each hit against this run before treating it as new.** Watch markers are permanent and sit on their own start/end pair, so a ticket watched one night and stopped another keeps both facts, and a marker can be months old. An old marker is history.

A hit that is current and watch-only is **dissent**: the loop's own browser check contradicted the work it is about to land, and that ticket ships and closes anyway.

**Dissent is a finding, not a formality.** Report every current hit to the user by ticket, one line each, before merging, and say plainly that watch-only means these shipped regardless. The user decides per ticket: merge it, or pull it back out. **Pulling one out means both reverting its commits on the run branch AND deleting its `Closes #N` line from the PR body** — the line fires on merge whatever the branch contains, and closing an issue whose code is not on `main` is the one thing the whole `shipped-local` design exists to prevent.

Also read the run-level tally in `.sandcastle/telemetry/issues.jsonl`, which can show a broken night with zero hits: verdicts that are all `inconclusive`, `environment-fault` or `never-settled` — the loop's three systemic verdicts, meaning the check never got a real look rather than a real answer — mean the checking machinery itself failed, which voids the run's claim to have looked at the screen at all.

Field names, the two modes in full, and how to read the disagreement block: [`SCREEN-CHECK.md`](SCREEN-CHECK.md).

### 5. Give every finding a terminal verdict and a durable home — BEFORE the merge

Everything steps 3 and 4 turned up gets settled here, while the work is still in your hands. Rank them with the decision sheet below.

**Every finding lands in an issue BODY**, so nothing rides on the owner's memory. Put each on an existing OPEN issue where one fits, and create a new one only when none does — **searching open issues first**, because the first time that check ran it caught a real duplicate.

Two homes look open right now and are not: **the issues in this PR's `Closes #N`, which step 6 is about to close**, and any ticket already queued for the next run. Nobody re-reads a closed body, so a finding filed there is a finding lost — check each candidate against the `Closes` list before writing to it.

### 6. Merge, then purge

**Mark the PR ready first — the loop opens it as a draft on purpose, and `gh pr merge` refuses a draft.** `gh pr ready <N>`, then merge. The `Closes #N` lines fire and the issues close — that is the whole landing step. Any Must-fix from step 5 is fixed or re-queued before this point; nothing blocking merges and gets filed as a consolation.

Then purge the retired run's coordination refs, on local, `origin`, and every host in `hosts.json`. Exactly these and nothing else:

`refs/sandcastle/{lanes,peers,peer-status,status,conflict}/*` and `refs/locks/issue-*`

**Never delete `refs/sandcastle/strand/*` or `refs/sandcastle/wip/*`, here or at any later step** — those hold real preserved work, and on a run with cross-host sync off the local ref is its only copy. They leave this skill untouched, and `sandcastle-clean` preserves them too.

**Delete these refs one glob at a time, not with the repo's `purge-coordination-refs` helper.** That helper matches the whole of `refs/sandcastle/` plus `refs/locks/`, so it takes `strand` and `wip` with it — it is the obvious tool for the job and it is the wrong one.

**A lease lock on `origin` is a live claim, and only its owning host can clear it.** Before deleting anything from `origin`, confirm no loop is alive on any host in `hosts.json` — a quiet machine here says nothing about a peer mid-run. Any host alive, unreachable or unclear leaves the `origin` half of the purge undone and reported; the local and per-host halves still run.

Leaving coordination refs behind poisons the next run: a stale lane tip once faked a merge conflict on iteration 1 and cost a whole session.

### 7. Quarantined work, then hand off

Enumerate the WIP refs themselves — `git for-each-ref refs/sandcastle/wip/` on every host — rather than working from labels. A checkpoint stop hands its issue back as `ready-for-agent`, so an issue holding real saved work often wears no `needs-human` or `quarantine` label at all, and a label-driven sweep walks straight past it. Every ref you find gets its issue a terminal verdict: landed, re-queued, or confirmed dead. **Never leave one at "recommend recovery"** — that is the limbo `clean` cannot act on.

Re-derive any queue count with the actual label query before stating it — never from memory or a session-start printout — and **if the queue grew, say it grew.**

Any fix you already identified that is one command long gets run now, not written into the hand-off; if you cannot run it, say so loudly enough to block. Then hand to **`sandcastle-clean`**, the skill that deletes leftovers — **and leave every deletion to it.**

**Completion ends at landed. Stop here, and do not launch the next run** — starting one is always a separate, deliberate act. A finding about the loop MACHINERY itself, as opposed to the product, is fixed before that next run launches; it is not queue work.

---

## The decision sheet

Batch every genuine decision into ONE list, ranked: **Must-fix (blocks merge) · Should-fix · Cleanup · Product decisions.** Lead with business impact and your recommendation; keep technical detail opt-in. Act on everything safe and reversible without asking. Only irreversible operations and real product questions reach the user. If the project ships its own findings-ranking skill, run that instead of ranking by hand — one ranking, not two.

Grade every finding against the eight quality axes: **correctness, security, performance, efficiency, scalability, maintainability, hygiene, future-proofing.** You may drop a finding for being **wrong** — never for being expensive, tedious, or "too much effort". Count the real call sites before proposing a multi-slice sequence: expand-migrate-contract is for a change that breaks many callers, not two, and seven tickets landing must not leave nine behind.

Size the alarm to the blast radius before reporting — that governs how loudly a finding is reported, not whether it counts. Two "critical" findings that had to be walked back cost more trust than they saved.

## Time-boxed mode

"Demo in an hour" narrows the reviewed surface to what is new on `main`, said out loud, and nothing else. Both reviews in step 3 still run. The landmine check and prove-by-content in `RECOVERY.md` still run — they prevent data loss, so rushing them costs work rather than saving time.
