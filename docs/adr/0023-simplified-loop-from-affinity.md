# ADR 0023 — Take the simplified loop from its source project; delete rescue roads in place, never rewrite

**Status:** Accepted
**Date:** 2026-10-29
**Supersedes (in part):** [ADR 0006](0006-sandcastle-critique-as-gate.md) — the separate per-ticket design critique and its fix pass are removed; the reviewer grades the ticket against the same `SANDCASTLE.md` design rules the critique used.
**Related:** the older loop ADRs 0013–0021 describe machinery that this decision simplifies; where they disagree with this record, this record wins.

## Context

This template's loop grew a rescue road for every way a ticket could stop: a referee between a ticket's test and its code, repair ladders for weak tests, build-anyway roads, a separate design critique, an auto-requeue sweep, a watch-only switch. In the private project the loop was first hardened in, most stops were not about bad code. They happened inside the rescue machinery itself, and about four in ten of the loop's dollars went on tickets that stopped. That project replaced the loop with a simplified one by deleting the roads in place, leaving the plumbing (machine claims and leases, checkpoints, the merge lane, the run report) untouched.

## Decision

1. **`.sandcastle/` is now that simplified loop**, copied in verbatim, with the project-specific parts moved into one committed settings file, `.sandcastle/project.json` (example: `project.example.json`). With no file, the loop runs project-neutral defaults.
2. **The ticket path is:** first test (advisory, still locked) → build → review with up to three fix rounds → ship onto the run branch. A review refusal, a failed check or a time-out hands the ticket to one fixer pass with the same three rounds. A first-test problem never stops a ticket on its own: it ships on the reviewer's pass, labelled `shipped-without-first-test`.
3. **The pre-merge check runs once per run**, on the run branch tip, just before the loop lands its own run pull request — the command named by `landCheck`. Never per ticket. With no `landCheck` the loop never lands its run pull request; it waits for the owner.
4. **A ticket that still fails is retried on later runs** until it has spent $100 in total or been tried three times; then it waits for a session. Only two things reach the owner: a ticket whose wanted result is unclear, and a run holding a migration that deletes or rewrites existing data.
5. **Kept safety pieces are not touched:** the worktree lock, the `Blocked-by:` waiting rule, the agent commit identity, the serial merge lane, the pre-merge check, the production-database fence, and the locked first test.
6. **No regrowth.** A new way for a ticket to stop requires removing an existing one.
7. **This template is downstream of that loop, never the reverse.** Nothing here is pulled back into the source project. Because the settings layer (`lib/project-config.ts` and its readers) and the removal of the source project's own database tooling exist only here, a later update is never a wholesale re-copy: it ports the source loop's changes since the commit last ported (Affinity-OS `dd8cfe59a`, 2026-10-29) onto this tree, keeping every project-specific value behind `project.json`, then records the new source commit here.
8. **The loop assumes a monorepo layout** (`apps/*` and `packages/*`) for deciding which changed files need a first test and for where unit checks may live (`lib/checkwriter/proof-demand.ts`, `lib/checkwriter/unit-check-path.ts`). In a single-package project those gates check less; making them settings is open work.

## Rules for changing the loop

Required reading before any change to the loop. Each came out of the history above.

1. **Remove a choice instead of watching for its misuse.** If the loop can do something wrong, take the option away. Do not add a detector that tries to catch it afterwards — the detector becomes one more thing that can fail and stop a ticket.
2. **Count, never sort.** Limits are money or attempts, never kinds of failure. Sorting failures into kinds means writing a rule for each kind, and every rule can be wrong. The retry budget follows this: $100 or three attempts, whichever comes first.
3. **No new roads.** A case nobody planned for does not get its own rescue path. Either the ticket ships with a label saying what happened, or it reaches the owner as a question about what the ticket means.
4. **The owner's pull-request review is the last guard.** The loop does not have to be perfect. Its job is to show clearly, in the run's pull request, what it did — for example, every older ticket's test a ticket edited. Findings the reviewer reports without stopping a ticket (`shipped-with-structure-finding`, `shipped-with-weak-first-test`) stay labels; a finding that keeps recurring in the owner's end review becomes one line in `review-prompt.md` that replaces an older line, never one added beside it.

## Consequences

**Good**

- Fewer roads means fewer ways to stop.
- Most changes to the loop are deletions, reviewable as "this road is gone".
- The files and refs the `/sandcastle-*` skills read do not move, so no skill breaks.

**Bad / costs**

- `main.mts` stays one very large file; deleting roads shrinks it but does not change its shape.
- Some deleted roads did save tickets. Those now ship labelled on the reviewer's pass alone, or wait for a session after the retry budget. The reviewer becomes the only gate on them.
- Prompts the loop sends to AI agents point at project facts (check helpers, seeded test data, protected paths) that a project supplies in `SANDCASTLE.md` and `project.json`; a project that supplies none gets the generic behaviour only.

**Alternatives considered**

- _Rewrite the orchestrator around the short path._ Rejected: the plumbing is most of the file and works.
- _Extract the roads into modules first, then simplify._ Rejected: moving code relocates complexity (the source gains an import, the new file a header and an export); deletion removes it.
- _Keep patching each stop as it appears._ Rejected: that is the history that produced the cost above.

## Owner rulings

- **2026-10-29 — option A, "Full send A":** the template is a project-neutral copy of the simplified loop. Each Affinity-only part sits behind a setting in `.sandcastle/project.json` whose default turns it off; Affinity-only data (run history, the owner's name, the stack described in prompts) stays out of this public repository.
- **2026-10-29 — test database and migrations, in his words:** "For the practice database: don't port Affinity's database itself. Build the general ability — a project can opt in to its own Postgres test database, off by default. Affinity turns it on with its own settings. Also the Drizzle migrations and packages/db paths are Affinity's; keep them on the Affinity side."
