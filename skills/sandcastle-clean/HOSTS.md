# Cleaning every machine

Reached from step 0 of [`SKILL.md`](SKILL.md), once the user picked all hosts (`--all`) or one remote (`--host <name>`). This file is the wrapper around the per-host work; the gates, proofs and refusals inside it are unchanged.

## Survey first, then confirm once, then delete

**Fan the ssh calls out concurrently.** The survey — the three pre-flight gates plus what each host reports as cleanable — is read-only, so it parallelizes safely, and a serial sweep across hosts is needlessly slow.

**Then show one combined proposal covering every host, and act only on that OK.** The single-machine path takes an OK before each destructive step; this path folds every host's findings into that one proposal instead. A per-step prompt multiplied by N hosts is the confirmation treadmill this path exists to avoid, and the user cannot see the whole cost while answering the first prompt. Nothing destructive happens without an OK on one path or the other.

## One host's failure never stops the others

Collect a per-host outcome from this list and report all of them:

- `cleaned`
- `skipped: loop running`
- `skipped: liveness unclear`
- `skipped: unreachable`
- `skipped: not a sandcastle project`

`liveness unclear` is a real, expected outcome of the fail-closed liveness gate. Report it as its own thing rather than folding it into `loop running`, so the user sees it is an evidence problem they can re-run past, not a busy machine.

Branch and worktree deletions are **local to each host** — cleaning the VPS never touches another host's disk. The coordination-ref sweep is the exception: it reaches origin by design, so it is the one place a per-host clean has a shared blast radius.

## The report

Report disk space recovered per host and as a total.

**Say plainly which hosts you did NOT clean and why.** A host skipped for a running loop is the single most likely outcome of a multi-host run, and reporting "cleaned!" while the VPS is still full of worktrees is the version of this that wastes the user's time. Done when every host you targeted holds exactly one outcome from the list above — every host in the registry on `--all`, the named one on `--host <name>`.
