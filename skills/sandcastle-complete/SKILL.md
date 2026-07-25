---
name: sandcastle-complete
description: Use when a finished or stopped sandcastle run must be LANDED on main — symptoms include certified work sitting on a local integration branch that was never pushed, issues closed on GitHub but not actually present on main, diverged cross-host lanes needing reconciliation, or the user invokes /sandcastle-complete. This is the "land it" step only. Stopping the loop is sandcastle-stop; deleting leftovers is sandcastle-clean.
---

# Sandcastle Complete

The loop leaves certified work on a **local integration branch** (`--branch`, which refuses `main`) — never pushed, never on `main`. This skill owns only the missing middle: **landing that work on `main` cleanly.** It does NOT stop the loop and does NOT delete leftovers — it calls the sibling skills for those.

**Lifecycle order: `sandcastle-stop` → `sandcastle-complete` → `sandcastle-clean`.** If the loop finished on its own, skip stop: `sandcastle-complete` → `sandcastle-clean`. Clean is always LAST — you can only safely delete a branch/worktree after its work has landed. Starting the next run (`sandcastle-run`/`-resume`) is always a separate, deliberate step — never automatic.

**Core principle: closed ≠ shipped, and green tests ≠ done.** GitHub state and the loop's "merged" status are optimistic. Prove every claim against `main`'s actual content before you trust it.

## Boundaries (do NOT reimplement siblings)

- **Loop still running?** Invoke **`sandcastle-stop`** — do not write your own kill/reap. (If stop is missing something, fix stop, not here.)
- **Deleting leftover branches/worktrees/logs/refs?** That's **`sandcastle-clean`** — hand off to it at the end. **Narrow carve-out:** this skill DOES delete _poisoned_ wip refs + their stale branches in stage 2, because that must happen before any resume and clean runs last (too late). Clean owns deletion of _terminal, landed_ leftovers; complete only deletes the poisoned-checkpoint correctness case.
- This skill = reconcile → validate → land. Nothing else.

## Iron Rules (each maps to a repeat disaster — violating the letter is violating the spirit)

1. **Reconcile before anything resumes.** When cross-host lanes diverged, pick the winner and merge FIRST. Then validate every saved checkpoint (`refs/sandcastle/wip/issue-N`) against the winning tip and purge+re-queue the poisoned ones — BEFORE any of that work is ever resumed. (Stop's reap only _preserves_ work; the corruption is resuming a checkpoint anchored to the losing base.)
2. **Never wholesale-merge a stranded branch.** A branch cut before a sibling merged will DELETE/rename the sibling's shipped files. Before ANY merge, `git diff --name-status <branch> main`; refuse if it deletes/renames files `main` has. Extract the additive slice only.
3. **Prove shipped by content, not status.** Squash-merges make `git cherry`/ancestry lie. Verify each closed issue's feature files/symbols are actually on `main`. "Closed"/"branch deleted" are not proof.
4. **Run the review matrix — do not hand-roll it.** The gate is `/thermo-review` AND `superpowers:requesting-code-review`, both actually loaded. Verify they loaded. Never substitute ad-hoc review agents.
5. **You orchestrate; subagents execute.** Main thread decides, delegates, verifies. Catch yourself Read/Edit/Bash-tracing product code to design a fix → STOP, dispatch a subagent.
6. **Verify, don't relay.** Re-verify every inherited "blocker", negative finding, and stale comment against current code/spec. Tag subagent findings `[ASSUMED]` until confirmed.
7. **Comments over bodies.** Issue bodies are stale stubs; real state lives in comments.
8. **Ends at "landed", then hands to clean. Never auto-launch the next run**, never assume launch params.

## Under time pressure (time-boxed mode)

"Demo in an hour / move fast" NEVER licenses skipping the irreversible-protecting steps: reconcile-before-resume, the landmine check (Rule 2), and prove-shipped-by-content (Rule 3). Those _prevent data loss_ — rushing past them loses work, the opposite of fast. The ONLY sanctioned scope cut: narrow the deep-review surface (stage 6) to the **new-to-main** change rather than the whole run, and **say so explicitly**. If even that won't fit, land nothing new and offer the demo off the already-certified integration branch.

## The Pipeline (in order)

### 0 — Precondition

- Read prior handoffs + `status.json`/`run.log` FIRST; verify deltas only. Don't trust a handoff's "clean tree" — run `git status`; if dirty, surface what's uncommitted and force a commit/stash so reviewers and the diff-range agree.
- **Discover the run branch** (`runId` in `status.json`, or `git for-each-ref refs/sandcastle/lanes/`) and enumerate hosts (`hosts.json`).
- **Loop still running on any host?** Detect with the **cwd-filtered** pgrep the siblings mandate (a bare `pgrep -fl main.mts` is project-blind — it matches other repos' loops and will false-positive), per host. If yes → **invoke `sandcastle-stop`** (`--now` if in-flight work must be preserved), then continue. Do not proceed while a loop is live.

### 1 — Reconcile cross-host lanes (only if diverged)

- `tsx .sandcastle/scripts/converge.mts --branch <run-branch>` on one host. It merges peer `refs/sandcastle/lanes/*`, aborts cleanly on true conflict, writes `refs/sandcastle/conflict/*`.
- On a real conflict: subagent computes the **true minimal conflict surface** (per-issue file-overlap — usually one function in one file, not "redo N issues"), resolves in an isolated worktree, gates typecheck+tests, makes a merge commit descending from **both** lane tips, pushes branch head + both lane refs.
- **Choosing the winner is a real decision.** Decide per-conflict-file on merit (more complete/correct, matches the newer superseding spec, fewer downstream reverts), not by host. Record the winning tip + rationale in the ledger. If the two sides embody different product intents → decision-sheet item, not a silent pick.
- **If the reconcile gate fails:** do NOT push or advance. A red reconcile is a must-fix blocker even under time pressure — half-merged is worse than late.

### 2 — Validate saved checkpoints against the winner (the poison fix)

For each `refs/sandcastle/wip/issue-N`: `git merge-base --is-ancestor <winning-tip> refs/sandcastle/wip/issue-N`. NOT an ancestor → poisoned (anchored to the losing base). Delete the wip ref + stale branch on all hosts and re-label the issue `ready-for-agent` so the NEXT run redoes it fresh. Never let poisoned work resume. (Stop created these refs; here is where they get judged.)

**Enumerate wip refs per host, local ref first.** WIP refs are written to each host's _local_ refs unconditionally but pushed to origin only when `SANDCASTLE_CROSS_HOST_SYNC=1`. So a poisoned checkpoint living only on a remote host's local refs is invisible from the host you're driving completion on — check `refs/sandcastle/wip/*` on every host (local `rev-parse` per host, then `git ls-remote origin`), or it escapes the purge and can still resume.

### 3 — Manifest (what did the loop actually produce?)

Subagent generates: per-issue commits, files touched, diffstat vs `origin/main`, ahead/behind, closed/open state. The spine of the run ledger — never skip; the user is otherwise blind to their own run.

### 4 — Adjudicate: shipped / partially-shipped / superseded / salvage / dead

Per closed issue, verify by **content on main** (Rule 3). Classify: already-shipped · **partially-shipped** (some feature files present, others missing → salvage the missing slice, never "done") · superseded (verify by _intent_ — does main actually consume the purpose-built code? Rule 6) · needs-salvage (unshipped, stranded) · dead. Evidence-backed ledger, one line + verdict + proof each.

### 5 — Safe extraction (stranded work → main)

Per needs-salvage branch: Rule 2 (name landmine files, exclude them). Prefer additive-only cherry-pick; if the WIP→finalize chain degenerates into empty commits (common on divergent bases, esp. security code), fall back to per-file base-relative reconstruction with a required test gate. Each extraction = its own PR/branch, typecheck + targeted tests before push.

**Drive EVERY stranded branch to a terminal verdict here — this is the step that stops `clean` from parking work in limbo.** After stage 4's classification, no branch may be left "preserved, undecided": already-shipped → mark for deletion; superseded/dead → confirm by intent and mark for deletion (record why in the ledger); needs-salvage/partially-shipped → land the additive slice (above), then mark the source for deletion. The output is a per-branch disposition (landed / confirmed-dead / re-queued) that `clean` can act on mechanically. If you can't reach a verdict on a branch, that's a decision-sheet item — never a silent "save for later".

### 6 — Review gate (non-substitutable — Rule 4)

Auto-shard the diff into coherent subsystems; run **one uncapped deep reviewer per shard** sized to file/commit count (a word-capped whole-diff pass surfaces 5 findings over 130 files — a skim, not an audit). THEN run `/thermo-review` and `superpowers:requesting-code-review`. On any reviewer severity disagreement, dispatch an adversarial adjudicator with a fixed rubric. Enforce 1:1 traceability: every finding → a tracked item + an explicit out-of-scope list. **Exit criterion:** done when every shard had one uncapped deep reviewer AND both named skills ran — not when a finding-count looks satisfying.

### 7 — Verification gate (the false-"done" catcher)

Standing checks every completion, subagents returning file:line evidence:

- **Wired end-to-end:** grep callers of every new procedure (exclude `.next`/`dist`); a closed issue with zero callers is not done.
- **Security/tenancy:** RLS `ENABLE`+policy on every new tenant table; route-guard (not just nav-hiding) on gated pages; no exported RLS-bypass procedure factories; IDOR on id-only lookups; secret/credential scan.
- **Money/parity (project-specific):** no hardcoded side/status/role derivations; per-type flows diffed against the system-of-record before cutover. Block go-live on unverified parity.

### 8 — Land on main + push

- FF local `main` to `origin/main` first (every host).
- The loop's `fastForwardIntegration` stops at the integration branch — **you** do the final hop: integration-branch → `main` (PR or `git merge --ff-only`) + push. Enforce merge order for shared files/migration journals. Run the repo's real merge gate locally if CI is down; treat "0 items compared" from any gate as a failure.
- State the sequence once, upfront: **pre-merge gates → merge → post-merge hardening → launch gates.** P0s gate _launch_, not merge.

### 9 — needs-human / quarantine triage

Per issue: checkpoint its work to a WIP ref if stop didn't already (reuse stop's `checkpoint-stop.mts` mechanic — don't hand-roll a second version; quarantine otherwise leaves it dangling/GC-bound). Classify — infra-timeout-work-intact (e.g. e2e cold-compile) vs deterministic-infra (no-output psql/OOM) vs real-code-bug. Then resolve to a **terminal disposition** from the stage-5 set (landed / cherry-picked / re-queued / confirmed-dead), not a dangling "recommend" — a needs-human branch left at "recommend recover" is exactly the limbo clean can't act on.

### 10 — Durable run ledger + then hand to clean

Write everything (manifest, adjudication, findings→spec traceability, decisions, deferred debt) to **`docs/sandcastle/runs/<run>.md` committed** AND a **GitHub tracking issue**. Deferred items carry a "dismissed by user" state so nothing re-surfaces after a ruling. **Then hand off to `sandcastle-clean`** to reap the now-terminal leftovers — do not delete them yourself.

## The decision sheet (how you involve the user — business-first)

Batch ALL genuine decisions into ONE sheet, pre-ranked with a recommended default each: **Must-fix (blocks merge/launch) · Should-fix · Cleanup · Genuine product decisions.** Lead with business impact + urgency + your recommendation; technical detail opt-in; auto-`/engl` for a non-technical owner. Act on everything safe/reversible without asking; only destructive-irreversible ops and real product WHAT-decisions reach the sheet.

## Quick reference

| Need                 | Do                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Loop still running   | invoke `sandcastle-stop` first (don't reimplement)                                                         |
| Reconcile lanes      | `tsx .sandcastle/scripts/converge.mts --branch <b>`                                                        |
| Poisoned checkpoint? | `git merge-base --is-ancestor <winning-tip> refs/sandcastle/wip/issue-N` → not ancestor = purge + re-queue |
| Landmine check       | `git diff --name-status <branch> main` → refuse deletes/renames of main's files                            |
| Shipped?             | verify feature files/symbols on `main` by content, not ancestry/status                                     |
| Review               | `/thermo-review` + `superpowers:requesting-code-review`, both loaded                                       |
| Land to main         | FF local main; then integration-branch → main + push (you do this hop)                                     |
| Delete leftovers     | hand off to `sandcastle-clean` (last, never before landing)                                                |

## Red flags — STOP

- Writing your own kill/reap instead of invoking `sandcastle-stop` → **wrong skill**.
- Deleting branches/worktrees yourself instead of `sandcastle-clean` → **wrong skill; and never before landing**.
- `git merge` a branch without `--name-status` vs main → **landmine**.
- Resuming a checkpoint before validating it against the reconciled winner → **poisons main**.
- Trusting "issue closed"/"branch deleted" as proof it shipped → **verify content**.
- Reading/editing product code in the main thread to design a fix → **delegate**.
- 5 findings over 100+ files presented as an audit → **shard and go deep**.
- Relaying a handoff "blocker" or a subagent finding as fact → **re-verify first**.
- Moving to launch the next run → **completion ends at landed; hand to clean; stop**.

## Rationalization table

| Excuse                                    | Reality                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| "The loop said merged, so it's on main"   | The loop lands to a LOCAL branch and closes optimistically. Prove by content.      |
| "Just merge the branch, it's faster"      | Stranded branches revert shipped siblings. `--name-status` first, always.          |
| "I'll reconcile after I resume this WIP"  | Resuming losing-base WIP reverts the winner. Reconcile + validate BEFORE resume.   |
| "I'll just stop/clean it here myself"     | Stop and clean are their own skills. Call them; fix them if weak. Don't fork them. |
| "One review pass is enough"               | Word-capped whole-diff = skim. Shard + deep + the two named skills.                |
| "I'll just trace this bug quickly myself" | Main-thread tracing pollutes context and is the executor's job. Delegate.          |
| "The handoff says it's a blocker"         | Handoffs carry stale/wrong facts. Re-verify against source.                        |
