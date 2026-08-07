# Recovery path — only when a run produced no PR

**These steps run only when `gh pr list --head <run-branch> --state all` came back empty** — no PR in any state, open, merged or closed. A run with a PR never comes here, merged ones included: the fast path in [`SKILL.md`](SKILL.md) handles those in minutes, and running these steps on a healthy run burns an hour for nothing.

You are here because a run was hard-killed, predates the 2026-07-30 run-PR change, restarted on hot-reload, or lost its push silently. Tell the user which, up front. The goal is to get the work into a PR and rejoin the fast path — not to re-litigate the whole run.

## Iron rules — each maps to a real disaster

1. **The landmine check — never wholesale-merge a stranded branch.** A branch cut before a sibling merged will delete or rename the sibling's shipped files, so a wholesale merge reverts shipped work. Run `git diff --name-status <branch> main` FIRST, and refuse the merge on any deletion of a file `main` has. A clean `--name-status` is not a licence to merge the branch whole: a rename lands as an add plus a delete of a path `main` never had, and slips the check. Extract the additive slice, every time.
2. **Prove shipped by content, not status — and search by symbol, not by the branch's filenames.** Rebase and squash make ancestry lie, and the loop routinely lands work under different names and renumbered migrations. Before calling anything lost: grep the _symbol_ on `origin/main`, glob the feature _noun_ across the whole tree to catch renames, and compare `git patch-id --stable` pairwise. Only when all three come back empty is it genuinely unlanded. Skipping this produces false "lost work" alarms.
3. **Reconcile before anything resumes.** If cross-host lanes diverged, merge the winner FIRST, then validate every `refs/sandcastle/wip/issue-N` against the winning tip (`git merge-base --is-ancestor`). Not an ancestor means poisoned — purge and re-queue rather than resume it onto the losing base. Enumerate wip refs on _every_ host; one living only on a remote host's local refs is invisible from here.
4. **You orchestrate; subagents execute.** If you catch yourself tracing product code in the main thread to design a fix, stop and delegate.
5. **Verify, don't relay.** Re-verify every inherited blocker and every subagent finding before repeating it as fact. Tag unconfirmed claims `[ASSUMED]`.
6. **Record state in the issue/PR BODY, never in comments.** Comments go stale and are not reliably re-read. Edit the body in place.

## Sequence

Stop the loop cleanly → reconcile lanes if diverged → validate checkpoints → establish by content what is genuinely not on `main` → extract additive slices into a branch → open a PR **whose body carries `Closes #N` for every issue whose code that branch actually contains** → **rejoin the fast path at step 2 of [`SKILL.md`](SKILL.md).**

Writing those `Closes` lines is what makes the rest work: step 6 merges expecting them to fire, and an issue left open still wearing `shipped-local` is re-reported as stranded by every run that follows.

Every stranded branch holds a terminal verdict before you finish: landed, re-queued, or confirmed dead.
