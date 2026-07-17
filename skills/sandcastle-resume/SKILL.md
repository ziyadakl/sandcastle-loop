---
name: sandcastle-resume
description: Rejoin a Sandcastle run that is ALREADY in progress — restart the loop on all healthy hosts (or one you pick) without planning new work, so a machine that was stopped picks up the shared queue where it left off. Use when the user wants to get a machine back into an ongoing run (e.g. after stopping to move locations, or bringing the VPS back online) or invokes /sandcastle-resume. Detects the in-flight run from the shared refs and pre-fills its branch; issues that were checkpoint-stopped resume from their saved WIP branch, not from scratch. To start NEW work use /sandcastle-run (its all-machines path).
---

# Sandcastle Resume

Rejoin a run that's already going, rather than planning a new one. Resume asks which run / which machines / what mode — but it does NOT invent a new branch or re-plan work. Because the queue lives on GitHub and stopped issues are checkpointed to WIP refs, a resumed machine continues the shared work; any issue that was mid-flight resumes from its saved branch instead of restarting.

## Preconditions (same as /sandcastle-run's all-machines path)

1. **Host registry** `.sandcastle/hosts.json` exists.
2. **Both cross-host flags on** on every host (`SANDCASTLE_CROSS_HOST_LEASE=1` + `SANDCASTLE_CROSS_HOST_SYNC=1`) — resume-from-WIP and lease handoff depend on them.

## Steps

1. **Discover the in-flight run.** The launch script reads the shared status refs (`refs/sandcastle/status/*`) to find the run currently reporting `state == running` across hosts, and pre-fills its branch. If nothing is in flight, it stops with "no in-flight run found" — there's nothing to resume (use `/sandcastle-run` to start fresh).
2. **Confirm with the user** the detected run (branch + which hosts are already running), which machine(s) to bring in, and the mode/concurrency. Pre-fill from the detected run so the user mostly confirms rather than types. Concurrency is per-host from the registry.
3. **Pick targets** — default all hosts NOT already running that run; or one via `--host <name>`.
4. **Resume on each target** via the shared script (it discovers the branch itself under `--action resume`):
   ```
   tsx .sandcastle/scripts/launch.mts --action resume --mode <mode> --iterations <n> [--host <name>]
   ```
   The same safety gate as a fresh launch applies (reachable → not-already-running → clean → fast-forward-only → own-auth); a host already running the run is skipped as `already-running` (correct — don't double-launch). **Dry-run first** with `--dry-run`.
5. **Report per-host outcome** (`launched` / `skipped (<reason>)`), same as a fresh launch. A resumed host joins the shared queue and, for any issue with a saved WIP ref, its worktree is cut from that checkpoint so the implementer continues the committed partial work.

## Talking to the user

Say which run was detected and on which hosts, then the per-host result. Make clear resume rejoins existing work — it does not create a new branch. If a checkpoint-stopped issue is resumed, note that it continues from its saved point, not from zero.
