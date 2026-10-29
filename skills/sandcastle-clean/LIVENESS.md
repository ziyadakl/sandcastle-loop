# Reading ambiguous liveness evidence

Reached from gate 1 of [`SKILL.md`](SKILL.md), when a host's three liveness signals disagree or cannot be read — and by anyone about to make that gate simpler.

## Why this gate is stricter than its two sibling skills

`/sandcastle-stop`, the skill that halts a running loop, gates on the process check alone and says why: "Signalling an already-dead PID is a harmless no-op." Clean deletes worktrees, so its two costs are wildly asymmetric — a false "nothing is running" destroys in-flight work no WIP ref has captured yet, while a false "something is running" costs a skipped clean the user re-runs in ten seconds.

`/sandcastle-status` records why the process check cannot carry a destructive gate alone, under its heading "Liveness and the run log": "The loop runs detached inside a sandbox, so process-table checks mislead in both directions — they miss the sandboxed process and match your own command text." That is why it makes `status.json` freshness canonical with `.loop.lock` as the cross-check.

Take the union of all three signals and accept the false refusals. This gate was process-check-only until commit `2d9c278`, which replaced it precisely because a check that can silently miss a live process must not authorize deletion.

## A `running` status that is frozen is a crash, not a live loop

Signal (b) requires _both_ `state: "running"` and a fresh `updatedAt`, because a frozen status file is exactly the wreckage clean exists to remove — letting it refuse forever means the mess is never cleanable. Tell the user what you see — "status says `running` but frozen at `<updatedAt>`, and no process, no lock — that's a crash, not a live loop" — and let them decide.

## A held lock beside a frozen status is genuinely ambiguous

`.sandcastle/.loop.lock` outlives its holder by ~60s, so a held lock alongside a stale status is also a hard death — but it is fresh enough that you cannot tell yet. Wait it out and re-check rather than guessing.
