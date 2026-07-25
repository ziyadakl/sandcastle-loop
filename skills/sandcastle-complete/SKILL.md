---
name: sandcastle-complete
description: Use when a sandcastle autonomous-loop run has finished or been stopped and its work must be landed on main — symptoms include commits piled on a local integration branch that was never pushed, issues closed on GitHub but not actually present on main, diverged cross-host lanes needing reconciliation, needs-human/quarantined issues, leftover agent branches/worktrees/refs, "the loop is done, now what", or the user invokes /sandcastle-complete. Not for starting a run (use sandcastle-run) or mid-run cleanup (sandcastle-clean).
---

# Sandcastle Complete

## Overview

The loop stops with certified work on a **local integration branch** (`--branch`, which refuses `main`) — never pushed, never on `main`. This skill owns the un-owned stage between "loop done" and "clean main". You are a **conductor**: you enforce the safe ordering and gates, and call existing scripts for the dangerous primitives. You do NOT reimplement kill/reap/reconcile logic, and you do NOT trace/fix product code in the main thread — you delegate that to subagents.

**Core principle: closed ≠ shipped, and green tests ≠ done.** An issue's GitHub state and the loop's "merged" status are optimistic. Prove every claim against `main`'s actual content and the running flow before you trust it.

## When to use

- A run finished or was stopped and work needs to reach `main`.
- Issues are closed on GitHub but you're unsure the code is on `main`.
- Cross-host lanes diverged (`converge` reported a conflict, or run.log says "a human should reconcile").
- Leftover `agent/*`, `wip/*`, `refs/scratch/*`, `refs/sandcastle/*`, stale `.loop.lock`, or agent worktrees remain.
- `needs-human`/quarantined issues need triage.

**When NOT to use:** starting a run (`sandcastle-run`), deleting already-merged worktrees (`sandcastle-clean`), rejoining a live run (`sandcastle-resume`).

## The Iron Rules (each maps to a repeat disaster — violating the letter is violating the spirit)

1. **Reconcile BEFORE you reap.** If the loop is running/stopping with in-flight issues AND lanes diverged, do NOT `sandcastle-stop --now` (it kills+reaps atomically → reaps WIP cut from the losing lane → resume reverts the winning lane). Instead: kill manually → `converge.mts` → THEN `checkpoint-stop.mts`. After any reconcile, verify every `refs/sandcastle/wip/issue-N` descends from the winning tip; purge+re-queue the ones that don't.
2. **Never wholesale-merge a stranded branch.** A branch cut before a sibling merged will DELETE/rename the sibling's shipped files. Before ANY merge, `git diff --name-status <branch> main` and refuse if it deletes/renames files `main` has. Extract the additive slice only.
3. **Kill the wrapper, not just main.** `sandcastle-wrapper.sh` can respawn `main.mts`. Kill both, confirm no respawn, before any git surgery.
4. **Prove shipped by content, not status.** Squash-merges make `git cherry`/ancestry lie. Verify each closed issue's feature files/symbols are actually on `main`. "Issue closed" and "branch deleted" are not proof.
5. **Run the review matrix — do not hand-roll it.** The gate is `/thermo-review` AND `superpowers:requesting-code-review`, both actually loaded. Verify they loaded. Never substitute ad-hoc review agents.
6. **You orchestrate; subagents execute.** Main thread decides, delegates, verifies. If you catch yourself Read/Edit/Bash-tracing product code to design a fix, STOP and dispatch a subagent.
7. **Verify, don't relay.** Every inherited "blocker", negative finding ("nothing wired"), and stale comment gets re-verified against current code/spec before it enters a decision. Tag subagent findings `[ASSUMED]` until you confirm.
8. **Comments over bodies.** Issue bodies are stale stubs; real state lives in comments. Read comments.
9. **Completion ends at "landed + clean." Never auto-launch the next run**, never assume launch params.

## Under time pressure (time-boxed mode)

"We're in a hurry / demo in an hour" NEVER licenses skipping the irreversible-protecting steps: reconcile-before-reap, the landmine check, prove-shipped-by-content, and a green reconcile gate. Those _prevent data loss_ — rushing past them loses work and breaks the demo, the opposite of fast. The ONLY sanctioned scope reduction: narrow the deep-review surface (stage 7) to the **new-to-main** change rather than the whole run, and **say so explicitly** — never silently. If time is too short even for that, land nothing new and offer the demo off the already-certified integration branch.

## The Pipeline (in order)

### 0 — Ingest & precondition

- Read prior handoffs + this run's `status.json`/`run.log`/logs FIRST; verify deltas only, don't re-derive. Don't trust a handoff's "clean tree" — run `git status`; if dirty, surface exactly what's uncommitted and force a commit/stash decision so reviewers and the diff-range agree.
- Confirm loop process state on **every** host: `pgrep -fl sandcastle-wrapper.sh; pgrep -fl main.mts`.
- **Discover the run/integration branch name** (every script needs it): read `runId` in `status.json`, or `git for-each-ref refs/sandcastle/lanes/`. Never assume `main`. Also enumerate hosts (`hosts.json`) — a multi-host run has a lane per host; do stop + reconcile + housekeep on all of them, not just the one you're on.

### 1 — Stop (only if running)

- If nothing in-flight and no divergence: graceful `sandcastle-stop` is fine.
- If in-flight AND diverged: **kill manually** (wrapper + main, both hosts), confirm no respawn. Do the reconcile (stage 2) BEFORE reaping (stage 3). Exact kill (cwd-filtered to this repo), per host: `pkill -f 'sandcastle-wrapper.sh'; sleep 1; pkill -f '\.sandcastle/main\.mts'; sleep 2; pgrep -fl 'main.mts' || echo NO-RESPAWN`. Full stop/reap mechanics live in the `sandcastle-stop` skill; re-queue mechanics (re-label + queue) live in `sandcastle-resume`/`sandcastle-run` — call those, don't reinvent them.

### 2 — Reconcile cross-host lanes (base first)

- `tsx .sandcastle/scripts/converge.mts --branch <run-branch>` on one host. It merges peer `refs/sandcastle/lanes/*`, aborts cleanly on true conflict and writes `refs/sandcastle/conflict/*`.
- On a real content conflict: dispatch a subagent to compute the **true minimal conflict surface** (per-issue file-overlap — usually one function in one file, not "redo N issues"), resolve in an isolated worktree, gate on typecheck+tests, make a merge commit descending from **both** lane tips, push branch head + both lane refs.
- **Choosing the winning lane is a real decision, not an implicit side-effect.** Decide per-conflict-file on merit (which implementation is more complete/correct, matches the newer superseding spec, has fewer downstream reverts), not by host. Record the winning tip + rationale in the ledger — the stage-3 ancestry gate and any re-queue depend on it. If the two sides embody different product intents, that's a decision-sheet item, not a silent pick.
- **If the reconcile typecheck/tests gate fails:** do NOT push the merge or advance. Stop, capture the failure, and surface it as a must-fix — a red reconcile is a blocker even under time pressure (an unreconciled or half-merged branch is worse than a late one).

### 3 — Reap in-flight (after reconcile)

- `tsx .sandcastle/scripts/checkpoint-stop.mts --integration-branch <run-branch>` (checkpoints each in-flight `agent/issue-N` to a WIP ref, releases leases). Then finish labels/status by hand if needed.
- **Winning-tip gate:** for each `refs/sandcastle/wip/issue-N`, `git merge-base --is-ancestor <winning-tip> refs/sandcastle/wip/issue-N`. If NOT an ancestor → poisoned; delete the wip ref + stale branch on both hosts, re-label the issue `ready-for-agent`.

### 4 — Manifest (what did the loop actually produce?)

Dispatch a subagent to generate: per-issue commit list, files touched, diffstat vs `origin/main`, ahead/behind, and each issue's closed/open state. This is the spine of the run ledger. Never skip — the user is otherwise blind to their own run.

### 5 — Adjudicate: shipped / superseded / salvage / unshipped

Per closed issue, verify by **content on main** (Rule 4). Classify each: already-shipped · **partially-shipped** (some feature files present, others missing — treat as needs-salvage for the missing slice, never as done) · superseded (verify by _intent_ — does main actually consume the purpose-built code? Rule 7) · needs-salvage (unshipped work on a stranded branch) · dead. Output an evidence-backed ledger, one line + verdict + proof per item.

### 6 — Safe extraction (stranded work → main)

For each needs-salvage branch: apply Rule 2 (name the landmine files, exclude them). Prefer additive-only cherry-pick; if the WIP→finalize chain degenerates into empty commits (common on divergent bases, esp. security code), fall back to per-file base-relative reconstruction with a required test gate. Each extraction = its own PR/branch, typecheck + targeted tests before push.

### 7 — Review gate (non-substitutable — Rule 5)

Auto-shard the diff into coherent subsystems; run **one uncapped deep reviewer per shard** sized to file/commit count (a word-capped whole-diff pass surfaces 5 findings over 130 files — that's a skim, not an audit). THEN run `/thermo-review` and `superpowers:requesting-code-review` over the change. On any reviewer severity disagreement, dispatch an adversarial adjudicator with a fixed rubric. Enforce 1:1 traceability: every finding maps to a tracked item + an explicit out-of-scope list. **Exit criterion:** the gate is done when every shard has had one uncapped deep reviewer AND both named skills ran — not when a finding-count looks satisfying. A genuinely clean shard returning few/zero findings is fine _once it's been reviewed at depth_; a low count from a shallow pass is not.

### 8 — Verification gate (the false-"done" catcher)

Standing checks every completion, run by subagents returning file:line evidence:

- **Wired end-to-end:** grep callers of every new procedure (exclude `.next`/`dist`); a closed issue with zero callers is not done.
- **Security/tenancy:** RLS `ENABLE`+policy present on every new tenant table; route-guard (not just nav-hiding) on gated pages; no exported RLS-bypass procedure factories; IDOR on id-only lookups; secret/credential scan.
- **Money/parity (project-specific):** no hardcoded side/status/role derivations; per-type flows diffed against the system-of-record before cutover. Block go-live on unverified parity.

### 9 — Land on main + push

- FF local `main` to `origin/main` first (every host).
- The loop's `fastForwardIntegration` stops at the integration branch — **you** do the final hop: land integration-branch → `main` (PR or `git merge --ff-only`) + push. Enforce merge order for shared files/migration journals. Run the repo's real merge gate locally if CI is down (fingerprint the billing-red signature once); treat "0 items compared" from any quality gate as a failure.
- Sequence to state once, upfront: **pre-merge gates → merge → post-merge hardening → launch gates.** P0s gate _launch_, not merge.

### 10 — Housekeep to terminal state (Rule: leftovers are a cost)

Auto-classify + reap across ALL hosts without asking (content-verified): merged/ancestor branches, superseded-WIP, stale `refs/scratch/*`, `refs/sandcastle/peer*`, stale `.loop.lock`, `integration-candidate` pointers, agent worktrees. Repair dangling dashboard viewer symlinks. Union-merge/gitignore bookkeeping files (`progress.txt`). Surface only genuinely-unshipped work as a short list. Never dump the branch list on the user as a decision.

### 11 — needs-human / quarantine triage

For each: auto-checkpoint its work to a WIP ref (quarantine leaves it dangling/GC-bound). Then classify with a structured verdict — infra-timeout-work-intact (e.g. e2e cold-compile) vs deterministic-infra (no-output psql/OOM) vs real-code-bug — and recommend recover / cherry-pick / re-queue-with-sharpened-scope / discard. Don't send a human to re-diagnose from zero.

### 12 — Durable run ledger + deferred debt

Write everything (manifest, adjudication ledger, findings→spec traceability, decisions, deferred debt) to **`docs/sandcastle/runs/<run>.md` committed** AND a **GitHub tracking issue** for the run. Deferred items carry a "dismissed by user" state so nothing re-surfaces after a ruling. This is the single fix for "every session re-discovers everything."

## The decision sheet (how you involve the user — Rule 9, and business-first)

Batch ALL genuine decisions into ONE sheet, pre-ranked, each with a recommended default:

- **Must-fix (blocks merge/launch)** · **Should-fix** · **Cleanup** · **Genuine product decisions**.
  Lead each with business impact + urgency + your recommendation; technical detail is opt-in. Auto-`/engl` for a non-technical owner. Act on everything safe/reversible without asking; only destructive-irreversible ops and real product WHAT-decisions reach the sheet.

## Quick reference

| Need            | Do                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------- |
| Reconcile lanes | `tsx .sandcastle/scripts/converge.mts --branch <b>` (BEFORE reap)                        |
| Reap in-flight  | `tsx .sandcastle/scripts/checkpoint-stop.mts --integration-branch <b>` (AFTER reconcile) |
| Kill loop       | kill `sandcastle-wrapper.sh` AND `main.mts`, both hosts; confirm no respawn              |
| Landmine check  | `git diff --name-status <branch> main` → refuse deletes/renames of main's files          |
| Shipped?        | verify feature files/symbols on `main` by content, not ancestry/status                   |
| Poisoned WIP?   | `git merge-base --is-ancestor <winning-tip> refs/sandcastle/wip/issue-N`                 |
| Review          | `/thermo-review` + `superpowers:requesting-code-review`, both loaded                     |
| Land to main    | FF local main; then integration-branch → main + push (you do this hop)                   |

## Red flags — STOP

- About to `git merge` a branch without running `--name-status` vs main → **landmine**.
- About to `sandcastle-stop --now` with diverged lanes + in-flight work → **poisons WIP**.
- About to trust "issue closed" / "branch deleted" as proof it shipped → **verify content**.
- Reading/editing product code in the main thread to design a fix → **delegate**.
- Presenting 5 findings over 100+ files as an audit → **shard and go deep**.
- Relaying a handoff "blocker" or a subagent finding as fact → **re-verify first**.
- About to ask the user which branches to delete → **classify and reap the safe ones yourself**.
- Moving to launch the next run → **completion ends at landed+clean; stop**.

## Rationalization table

| Excuse                                       | Reality                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| "The loop said merged, so it's on main"      | The loop lands to a LOCAL branch and closes optimistically. Prove by content. |
| "Just merge the branch, it's faster"         | Stranded branches revert shipped siblings. `--name-status` first, always.     |
| "I'll stop-now then reconcile"               | `--now` reaps first → poisons WIP. Reconcile before reap.                     |
| "One review pass is enough"                  | Word-capped whole-diff = skim. Shard + deep + the two named skills.           |
| "I'll just trace this bug quickly myself"    | Main-thread tracing pollutes context and is the executor's job. Delegate.     |
| "The handoff says it's a blocker"            | Handoffs carry stale/wrong facts. Re-verify against source.                   |
| "I'll ask which branches are safe to delete" | Classify + content-verify + reap. Only surface truly-unshipped work.          |
