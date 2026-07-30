---
name: sandcastle-complete
description: Use when a finished or stopped sandcastle run must be LANDED on main — or the user invokes /sandcastle-complete. Since 2026-07-30 the loop ends by opening ONE run PR, so the normal path is minutes: verify the PR, merge it, purge coordination refs. The long recovery pipeline is only for runs that produced no PR. Stopping the loop is sandcastle-stop; deleting leftovers is sandcastle-clean.
---

# Sandcastle Complete

Land a finished run on `main`.

**Lifecycle: `sandcastle-stop` → `sandcastle-complete` → `sandcastle-clean`.** If the loop finished on its own, skip stop. Clean is always LAST. Starting the next run is always separate and deliberate — never automatic.

## Read this first: what changed on 2026-07-30

This skill used to be an eleven-stage forensic pipeline that routinely burned **90 minutes**. Almost all of it existed to compensate for one defect: **the loop closed issues based on a label on a local branch, without ever checking the code reached `main`.** One run closed 26 issues with zero code on `main`. So every completion had to re-derive the truth from scratch — adjudicate closed-vs-shipped, hunt stranded branches, reconcile diverged lanes, prove everything by content.

Two changes removed that defect at the source:

1. **The loop no longer closes issues at all.** It labels them `shipped-local` and leaves them OPEN. The run ends by pushing its branch and opening ONE draft PR carrying `Closes #N` per issue. Merging that PR is the only thing that can close them — so "closed" now means "the code is on the default branch", by construction.
2. **That PR is opened on every exit path**, including circuit-breaker trips, stalls, planner failures and uncaught exceptions — and the branch is always pushed. A crash can no longer strand work locally.

**Therefore: do not run the old pipeline by default.** If the run produced a PR — which is now every case except a hard `kill -9` — completion is the fast path below and should take minutes. Running the forensic pipeline on a healthy run is the single biggest waste this skill can commit.

## Step 0 — Which path are you on?

Find the run branch (`runId` in `status.json`, or `git for-each-ref refs/sandcastle/lanes/`), then:

```
gh pr list --head <run-branch> --state open --json number,title,body,isDraft
```

- **A PR exists → FAST PATH.** This is the normal case. Go there. Do not adjudicate, do not hunt stranded branches, do not reconcile.
- **No PR exists → RECOVERY PATH.** Only reachable via `kill -9`, a pre-2026-07-30 run, or a bug. Say so explicitly to the user before spending their time on it — an unexpected recovery path is itself a finding worth reporting.

**Loop still running?** Invoke `sandcastle-stop` first. Detect with a **cwd-filtered** pgrep (a bare `pgrep -fl main.mts` matches other repos' loops and false-positives). Never hand-roll a kill — a `kill -9` strands lease locks and is the one thing that can force the recovery path.

---

# FAST PATH (default — target: minutes)

### 1. Read the PR

Its body is the manifest: which issues shipped, which failed promotion, and any issues carried from an interrupted earlier run. You do not need to rebuild this — the loop wrote it.

Two things in the body actually need your attention:

- **A "promotion failed" warning** means the branch may be incomplete relative to what was certified. Treat the PR as suspect and read what failed before merging.
- **A "previously shipped by an interrupted run" section** lists issues still wearing `shipped-local` whose code presence on this branch could NOT be verified. They are deliberately excluded from `Closes #N`. Check each one by content before assuming it landed; if it did not, it needs re-queueing, not closing.

### 2. Run the gate

```
pnpm verify:land        # or the project's equivalent
```

This is the pre-merge check written down as one command — a disposable database plus the suites that CI would run if CI ran. It exits 0 only if every stage passed. Treat "0 items compared" from any stage as a failure, not a pass.

If it fails, that is a real blocker: fix or re-queue, do not merge past it.

### 3. Review proportionally

The diff is one PR of loop-authored code, so review it — but size the review to the diff, and do not invoke the full adversarial matrix by reflex. A focused pass on the actual changed surface beats a ceremonial one.

Apply the standing correctness checks that a sandbox structurally cannot verify:

- **Wired end-to-end** — grep real callers of every new procedure/route/component (exclude build output and its own tests). Zero non-test callers means not done, however green the tests are.
- **Tests assert the right thing** — this repo has twice shipped suites that were green _because_ the bug was present. Check what each new assertion _should_ say, not just that it passes.
- **Tenancy** — row-level security enabled with a policy on any new tenant table; real route guards, not hidden nav.
- **Deploy config the sandbox can't see** — scheduled jobs and newly-required secrets. A shipped handler does nothing until something calls it on a schedule. Emit each as an explicit to-do for the human owner.

### 4. Merge, then purge

Merge the PR. The `Closes #N` lines fire and the issues close — that is the whole landing step.

Then purge the retired run's coordination refs, on local, `origin`, and every host in `hosts.json`:

`refs/sandcastle/{lanes,peers,peer-status,status,conflict}/*` and `refs/locks/issue-*`

**Never touch `refs/sandcastle/strand/*` or `refs/sandcastle/wip/*`** — those hold real preserved work. Leaving coordination refs behind poisons the next run: a stale lane tip once faked a merge conflict on iteration 1 and cost a whole session.

### 5. Quarantined work, then hand off

Any issue left `needs-human` or `quarantine` keeps its work on a WIP ref. Give each one a terminal verdict — landed, re-queued, or confirmed dead. Never leave one at "recommend recovery"; that is the limbo `clean` cannot act on.

Then hand to **`sandcastle-clean`**. Do not delete leftovers yourself.

**Stop here. Do not launch the next run.**

---

# RECOVERY PATH (only when there is no run PR)

You are here because a run was hard-killed or predates the 2026-07-30 change. Tell the user that up front. The goal is to get the work into a PR and then rejoin the fast path — not to re-litigate the whole run.

**Iron rules for this path** (each maps to a real disaster):

1. **Never wholesale-merge a stranded branch.** A branch cut before a sibling merged will delete or rename the sibling's shipped files. `git diff --name-status <branch> main` FIRST; refuse if it deletes files `main` has. Extract the additive slice only.
2. **Prove shipped by content, not status — and search by symbol, not by the branch's filenames.** Rebase and squash make ancestry lie, and the loop routinely lands work under different names and renumbered migrations. Before calling anything lost: grep the _symbol_ on `origin/main`, glob the feature _noun_ across the whole tree to catch renames, and compare `git patch-id --stable` pairwise. Only when all three come back empty is it genuinely unlanded. Skipping this produces false "lost work" alarms.
3. **Reconcile before anything resumes.** If cross-host lanes diverged, merge the winner FIRST, then validate every `refs/sandcastle/wip/issue-N` against the winning tip (`git merge-base --is-ancestor`). Not an ancestor means poisoned — purge and re-queue rather than resume it onto the losing base. Enumerate wip refs on _every_ host; one living only on a remote host's local refs is invisible from here.
4. **You orchestrate; subagents execute.** If you catch yourself tracing product code in the main thread to design a fix, stop and delegate.
5. **Verify, don't relay.** Re-verify every inherited blocker and every subagent finding before repeating it as fact. Tag unconfirmed claims `[ASSUMED]`.
6. **Record state in the issue/PR BODY, never in comments.** Comments go stale and are not reliably re-read. Edit the body in place.

**Sequence:** stop the loop cleanly → reconcile lanes if diverged → validate checkpoints → establish by content what is genuinely not on `main` → extract additive slices into a branch → open a PR → **rejoin the fast path at step 2.**

Give every stranded branch a terminal verdict before finishing: landed, confirmed dead, or re-queued. "Preserved, undecided" is what turns into next week's archaeology.

---

## Time-boxed mode

"Demo in an hour" never licenses skipping the landmine check (rule 1) or prove-by-content (rule 2) — those prevent data loss, so rushing them costs work rather than saving time. The only sanctioned cut is narrowing the review surface to what is new on `main`, and saying so explicitly.

## The decision sheet

Batch every genuine decision into ONE list, ranked: **Must-fix (blocks merge) · Should-fix · Cleanup · Product decisions.** Lead with business impact and your recommendation; keep technical detail opt-in. Act on everything safe and reversible without asking. Only irreversible operations and real product questions reach the user.

Size the alarm to the blast radius before reporting. Two "critical" findings that had to be walked back cost more trust than they saved.

## Red flags — STOP

- Running the recovery pipeline when a run PR exists → **you are burning an hour for nothing**.
- Adjudicating "closed but did it really ship?" on a post-2026-07-30 run → **structurally impossible now; you are re-deriving a guarantee**.
- Calling work lost because the branch's filenames aren't on `main` → **check symbols and patch-ids first; renames and renumbering are normal**.
- Writing your own kill/reap instead of `sandcastle-stop`, or deleting leftovers instead of `sandcastle-clean` → **wrong skill**.
- `git merge` of a stranded branch without `--name-status` vs main → **landmine**.
- Purging `refs/sandcastle/strand/*` or `wip/*` → **that is preserved work, not scheduling state**.
- Ending a session with a handoff when a one-command fix was already identified → **finish it or block visibly; a handoff is not a substitute for the action**.
- Moving on to launch the next run → **completion ends at landed. Hand to clean. Stop.**
