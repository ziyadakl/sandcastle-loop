# Why the refusals exist

The evidence behind every hard gate in [`SKILL.md`](SKILL.md). Reach this file when you are tempted to soften a refusal, when the user asks why a gate exists, or when a gate fires and the user wants the reasoning. Each rule in `SKILL.md` carries its own one-line teeth; this is the proof underneath.

Nothing here is a step. Do not run anything from this file.

## Dirty launch worktree → a hollow run (2026-08-01)

A dirty launch worktree does not fail at launch. It fails at the _end_, after the whole night's spend. The orchestrator's final promotion fast-forwards `integration-candidate` → the run branch from the launch worktree, and git refuses that with local modifications present. The run then opens a PR whose body says `Closes #N` while containing **none of that work**; the commits survive only on `refs/sandcastle/strand/*` and `refs/sandcastle/wip/*` and have to be salvaged by hand.

The file that causes it does **not** have to be related to the work — one stray untracked scratch file is enough. A whole overnight run came back `0 shipped / 3 stuck / 12 waiting for you` this way.

This is why the gate has no `--force`, no "harmless" exception, and why the check re-runs immediately before the launch line: planning and the picker take time, and a parallel session can dirty the tree in between.

## Multi-host collision → why the default is one host (2026-07-30)

Multi-host is not free concurrency; it is a distributed-merge problem the loop does not solve. There is **no cross-host coordination of migration numbers** — both hosts read the same max and both pick the next, so a run touching the schema collides by construction.

The 2026-07-30 run collided at iteration 5, logged `CONFLICT merging peer … A human should reconcile the two lanes`, and then **kept running for eight more iterations**, growing a one-file conflict into a criss-crossed history with two merge bases, 13 dual-edited files, and a cross-lane compile break git could not see (one host imported a module the other had deleted — neither lane conflicted). The VPS produced 7 of 26 issues for $167 of $505 and generated _all_ of the reconciliation cost: a full human-supervised landing session.

Multi-host also produces **one run PR per targeted host**, and all of them must be reconciled before any can merge — which defeats the point of the loop ending on one reviewable PR.

Restore an ask-first default once (a) `_journal.json` has a union merge driver and (b) migration numbers are allocated per-host. Until then multi-machine stays available to anyone who explicitly asks for it, and one host is the default.

## Simultaneous fan-out → the second host starves (2026-07-25)

Two hosts that plan at the same moment race on the same narrow claimable set: the second host's pick collides with the first's in-flight claim and it exits on an empty iteration. Both hosts planned together; host 2 died on iteration 1.

This is why hosts start one at a time, each one only after the previous has actually claimed work.

## Missing `psql` → every schema issue silently quarantined (2026-07-25)

The host-side migration applier shells out to `psql` on the machine running the loop. With `psql` absent, **every** schema-touching issue fails the migration step with the misleading `migrations failed: psql exited 1 with no parseable ERROR lines: (no output)` and quarantines to `needs-human`. The loop looks like it is working while it poisons every migration issue.

The Mac had no `psql` and silently quarantined every schema issue it worked; the Linux hub, which had `psql`, was fine. A per-host gap is invisible unless you check each host — which is why the check runs against the machine that will run the loop, not just the one you typed the command on.

## Blocker concentration → a run that drains after one wave (2026-08-02)

A prose warning about blocked issues already existed and did not stop this run. 6 of 9 ready issues hung off one ticket. It failed, the planner correctly found nothing claimable on iteration 2, and the run ended at 2 of 50 iterations having spent $88.72 to ship one issue.

Iteration count and budget were never the constraint. The shape of the dependency graph was, and it was knowable before launch. This is why the gate computes the number and makes the user choose, rather than mentioning it in passing.

## Stale `agent/issue-*` branch → a slice burned on a stale world (2026-08-02)

The orchestrator does not always cut a fresh per-issue branch. When a branch named `agent/issue-N` already exists on disk, `git worktree add` hands back **that branch at its own existing tip**, not a new one off current HEAD. Nothing in the loop compares that tip against the run branch.

So a branch left behind by an earlier run resumes a copy of the world from whenever it was abandoned. The implementer reasons correctly against code that no longer reflects reality, fails to verify, and quarantines. There is no error, no warning, and no cheap way to notice from the outside.

The reaper deliberately preserves these branches because they hold commits — which is exactly why they need their own gate rather than being swept.

## Ghost cross-host refs → a faked conflict on iteration 1

Stale coordination refs from a retired or previous run poison the cross-host sync. Real incident: `refs/sandcastle/lanes/<hub>` still pointed at a retired queue's archive tip and faked a merge `CONFLICT` on iteration 1.

`refs/sandcastle/strand/*` and `refs/sandcastle/wip/*` are never swept — they hold real checkpointed work, and deleting them destroys it.

## Prompt files under docker → a false refusal on a healthy repo

The orchestrator reads each prompt file from the **host launch root** (`process.cwd()`), not from inside the worktree — the SDK resolves `promptFile` against `process.cwd()` (verified: `@ai-hero/sandcastle` `index.d.ts`, "`promptFile` is always resolved against `process.cwd()`"; `main.mts` preflight also checks them at `<repoRoot>/.sandcastle`). So a gitignored `.sandcastle/` runs perfectly under docker — which is the normal, template-default setup.

Requiring a commit there refuses a healthy repo. That is the career-ops regression: a long-working docker repo that gitignores `.sandcastle/` by design was refused.

Under `mac-host` the opposite holds. The host-native executor reads the prompt from **inside the per-issue worktree** (`lib/mac-host-sandbox.ts` `spawnAgent(wtPath, …)` → `path.join(wtPath, promptFile)`), and worktrees cut from HEAD carry only tracked files. There `.sandcastle/` genuinely must be committed, or the implementer dies mid-run with `prompt file not found`.

## Screen-check enforcement is never flipped automatically (issue #916)

The loop deliberately never sets `SANDCASTLE_SCREEN_CHECK_ENFORCE` itself. A threshold-based auto-flip would turn blocking on during an unrepresentative quiet night. It stays a per-run decision the user makes.

## `kill -9` on the loop → the next launch stalls

`/sandcastle-stop --now` releases leases, deletes lease locks (`refs/locks/issue-N`), and checkpoints in-flight work to a WIP ref. A hard `kill -9` skips all of that: it strands lease locks and orphaned `in-progress` labels, so the **next** launch reads those issues as "another host is working it" and stalls — and can surface a misleading "missing `type:` label".

## The layering bug — a launch worktree parked on a stale branch

The orchestrator cuts each per-issue worktree from the launch worktree's _current HEAD_ (the SDK runs `git worktree add -b <issue> <path> HEAD`, not off `--branch`), and `fastForwardIntegration` advances the run branch through whichever worktree has it checked out.

If the launch worktree is parked on a stale branch, every merged issue re-bases off that stale HEAD and silently re-does the foundation. Earlier versions of the branch step created the ref _without_ checking out, on the theory that the orchestrator bases worktrees on `--branch`. That theory is false — verified in the SDK's `WorktreeManager` and `main.mts` `fastForwardIntegration`.

## Launch-line traps that cost a whole run

- **`setsid` does not exist on macOS.** The launch line then fails or, worse, the shell parses it in a way that spawns the loop twice. `nohup … & disown` already detaches.
- **`--` after `pnpm sandcastle` or `yarn sandcastle`.** Only `npm run` needs the separator. pnpm rejects the stray `--` with an arg-parse error and the orchestrator never starts.
- **`--base` passed to the orchestrator.** `main.mts` has no `--base` flag and rejects it with `Unknown option '--base'`, killing the launch instantly.
- **A bare `pgrep` on `.sandcastle/main.mts`.** Every sandcastle loop on the machine has the identical command line, so it matches other repos' loops. It gives a false "already running" that blocks a legitimate launch, and a monitor keyed to it will latch onto the wrong project's PID.
- **A shared `/tmp/sandcastle.log`.** Two projects' loops interleave into one file and you cannot tell whose planner started.
