---
name: sandcastle-complete
description: Use when a finished or stopped sandcastle run must be landed on main, or the user invokes /sandcastle-complete. Stopping the loop is sandcastle-stop; deleting leftovers is sandcastle-clean.
---

# Sandcastle Complete

Land a finished run's pull request (the **run PR**) on `main`, or review one that is already landed.

**Lifecycle: `sandcastle-stop` → `sandcastle-complete` → `sandcastle-clean`.** Skip stop when the loop finished on its own. Clean runs last and deletes the leftovers, coordination refs included; this skill invokes it in step 11. Starting the next run is a separate act that needs the owner's words.

Every issue, finding and saved branch ends this skill holding a **terminal verdict**: **landed**, **re-queued**, or **confirmed dead**.

## How the loop leaves a run

The loop labels each finished ticket `shipped-local` and leaves its issue open. On most exits it pushes the **run branch** (`sandcastle/queue-<date>`) and opens one draft run PR with a `Closes #N` line per issue. A `kill -9`, a hot-reload restart (exit 75), a run that shipped nothing, or a failed push leaves no run PR.

Then the loop applies the merge rule (`decideMerge` in `.sandcastle/lib/state/merge-rule.ts`): a two-way door with a small blast radius, every check green, and the project's `landCheck` (`.sandcastle/project.json`) passing on the tip means it lands the run PR itself. With no `landCheck` set, the loop never lands its run PR; it always waits for the owner. A failed promotion or a carried issue always counts as a large blast radius. Any refusal leaves the PR open with `waits for <ownerName> (<why>)` in its body.

So a closed issue means its code is on `main`, and an open run PR means the loop refused to land it.

## Steps

1. **Find the run and its state.** Read `hosts.json`. Confirm no loop is alive on any host, with a pgrep filtered to that host's checkout. A live host goes through `sandcastle-stop` first, and an unreachable one is reported and its refs counted as unchecked. Read the run branch from `run.branch` in `status.json` (`runId` is the shared-run identity and only sometimes the same string). Then `gh pr list --head <run-branch> --state all --json number,state,isDraft,baseRefOid,headRefOid,body`. Take the branch that matches:
   - **Open** → the loop refused to land it. Its `waits for <ownerName> (<why>)` line (`ownerName` in `.sandcastle/project.json`, default "the owner") is the first finding. The work happens on the run branch.
   - **Merged** → read the body to learn who landed it: the loop's own outcome line, or a session's review notes. A run nobody reviewed is itself a finding. Fixes go on a new branch off `main` with its own pull request, and steps 5–10 work on that branch.
   - **None** → follow [`RECOVERY.md`](RECOVERY.md). Tell the owner first which cause it looks like.

   The diff of the run is `git diff <baseRefOid>...<headRefOid>`. GitHub refuses `gh pr diff` past 20,000 lines, which a run usually exceeds.

   Done when: every host is confirmed quiet or reported unchecked, and you hold the run PR's number, state and diff range, or you are in `RECOVERY.md`.

2. **Read the manifest.** The run PR body lists the shipped issues, a run-level warning when a final promotion failed, and a section of issues carried from an interrupted earlier run.
   - **A promotion warning** names no issues. It means the branch may lack work the loop certified, so compare each shipped issue's code with its claim before going on.
   - **A carried issue** sits outside `Closes #N` until someone proves its code on the branch and adds the line. Prove each one by content. A proved one gets its `Closes #N` line on an open run PR; on a merged run, close it by hand with a comment naming the commit. A missing one is a re-queue question for the owner.

   Done when: every carried issue is proved present or listed as missing, and under a promotion warning so is every shipped issue.

3. **Run the run-only checks.** The loop's reviewers judge one ticket at a time inside a sandbox, so these surfaces stay unjudged until now. The five code checks below (Unwired to Deploy config) are not a separate pass: paste them into the Readiness reviewer's requirements when step 4 runs `thermo-review`, so one reader answers them alongside its own checklist. Dissent and Tally are two commands each; run them here yourself. Each finding joins step 4's list.
   - **Unwired**: grep real callers of every new procedure, route and component, excluding build output and its own tests. Zero callers means unfinished, however green its tests.
   - **Inert**: trace every new input back to the code that writes it. A field no writer sets, a queue nothing enqueues to, or a flag nothing flips means the feature does nothing.
   - **Assertions**: for each new test, check what it should assert. This repo has twice shipped tests that passed because the bug was present.
   - **Tenancy**: every new tenant table has row-level security with a policy, and every new route has a real guard.
   - **Deploy config**: every new scheduled job and required secret becomes a to-do for the owner.
   - **Dissent**: read every issue in the body, plus each carried and quarantined one, with `gh issue view <N> --json body -q .body | sed -n '/screen-check-watch:start/,/screen-check-watch:end/p'`. An issue carries a block only when its screen check came back red. A block whose `**Run:**` line names this run is **dissent**: the loop's own browser check disagreed, and the ticket shipped anyway.
   - **Tally**: read this run's rows in `.sandcastle/telemetry/issues.jsonl`. Verdicts that are all `inconclusive`, `environment-fault` or `never-settled` mean the checking machinery failed, so the run never looked at the screen, dissent or not. Field names and how to read a block: [`SCREEN-CHECK.md`](SCREEN-CHECK.md).

   Done when: the five code checks are in the Readiness brief you will send in step 4, every current dissent block is listed by ticket, and the tally has a one-line verdict.

4. **Review.** On an open run PR, merge `origin/main` into the run branch with plain git in this checkout, so the commit carries the agent identity. Run `thermo-review` over the diff range against `origin/main`. A step 3 finding is a blocker when it stops this branch merging and you opened its cited line yourself. A deadline narrows the review to what is new on `main`, said out loud; the review itself still runs.

   Done when: the Readiness reviewer has answered step 3's five code checks for every new surface, and you hold one blocker list and one deferred list covering both.

5. **Ask the owner, once.** One numbered round, each item with your pick: every current dissent (land it, or pull it out), a failed tally, every deploy to-do, every re-queue or reopen, every product decision a blocker raised, and whether to land once the gate and checks pass. Continue on the items his answer settles.

   Done when: he has answered, or the report holds the round because he has not.

6. **Fix.** Fix each blocker with `mattpocock-skills:tdd`. Count real call sites before planning a fix in several slices. Blockers in the same files share one subagent. Groups run in parallel, one worktree each, with tests in the foreground. A dissent the owner pulls out is reverted. On an open run PR, also delete its `Closes #N` line from the body, because that line closes the issue on land whatever the branch holds. On a merged run, reopen its issue. Either way, it returns to the queue only on his yes. Commit and push.

   Done when: every blocker has a committed test that went red, then green.

7. **Re-check.** Run `thermo-review`'s narrow re-check over each fix pass, including any fix from step 9. A blocker it names goes in the report, and the land waits for the owner.

   Done when: the re-check names no blocker, or its blocker is in the report.

8. **Gate.** Merge `origin/main`, push, then start the project's `landCheck` command in the background on the pushed commit and read its own log (with no `landCheck` set, run the project's own pre-merge checks as its `CLAUDE.md` / `SANDCASTLE.md` name them). A check that examined zero files counts as failed. A later commit runs the gate again.

   Done when: all four exit 0 on the commit you will land, having examined the run's files.

9. **Update the pull request body.** Add the deferred findings `thermo-review` marked **someone hits it** in plain English, each with its home; its **code shape** findings stay in its review file and get no home, and leave the loop's Merge Danger section as written. A home is the body of an existing open issue that sits outside this PR's `Closes #N` list and carries no `ready-for-agent` label: a closed body is never re-read, and a queued body becomes scope the loop builds overnight. A finding with no home gets a new ticket, named in the status message that files it, with a one-line undo. Before filing it, open its cited line yourself and confirm the screen or response it names really shows what the finding claims: a reviewer's finding is a lead, and its "could not see" lines mark claims nobody checked. A finding that fails that read is dropped. Wait for every GitHub check. Fix a red one test-first, then re-check and gate again.

   Done when: every **someone hits it** finding has a home, every new ticket rests on a line you opened yourself, and every check passed or the report says why it could not run.

10. **Land** on the owner's yes, when every check passed, no blocker is left, and the gate passed on the head: `gh pr ready <N>`, then land it the way the project's `CLAUDE.md` says (a fast-forward of the base branch to the run branch tip is the default). A conditional yes from step 5 ("land it if nothing needs me") holds only after you show him the open list (new tickets, deferred findings, re-check blockers) and that list asks nothing of him. Any other state leaves the pull request open for him.

    Done when: the pull request is merged, or it is open with its reason in the report.

11. **Settle saved work, then clean.** Run `git for-each-ref refs/sandcastle/wip/ refs/sandcastle/strand/` on every reachable host and on `origin`. A strand ref holds certified work that a failed promotion left behind. A `--now` checkpoint stop can hand its issue back as `ready-for-agent`, so labels miss saved work. Prove each ref landed, still needed, or worthless. Re-queueing spends money and deleting is destructive, so both are owner questions with your pick. On his yes to "confirmed dead", delete that ref yourself with `git update-ref -d` on its host and `git push origin :<ref>`, because clean preserves every wip and strand ref. Count the queue with the live label query, and say if it grew. Then invoke `sandcastle-clean`.

    Done when: every saved ref holds a verdict or an open owner question, and `sandcastle-clean` has run.

12. **Report** in plain English. Line 1 is the verdict. Line 2 is what the owner does next. Then any unanswered question round, each deploy to-do, each new ticket, the land outcome, and the link.

A finding about the loop's own machinery is fixed before the next run, as session work rather than queue work.
