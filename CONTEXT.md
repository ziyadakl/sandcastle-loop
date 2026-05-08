# Sandcastle

The development repo for an autonomous coding loop. The runnable artifact is a `.sandcastle/` folder that gets copied into target projects (e.g. affinity-tracker); each project then runs the loop locally via `npm run sandcastle`. This repo is the workshop where that folder is built, tested, and version-controlled.

## Language

**Sandcastle** (capital S):
This repo and its tooling. Distinct from `@ai-hero/sandcastle`, the upstream npm package by Matt Pocock that ours builds on.
_Avoid_: sandcastle-loop (legacy name from when this was thought of as a deployable runtime)

**`.sandcastle/`** (with the leading dot):
The per-project folder that is copied into each target project. Contains `main.mts` (orchestrator), prompt files, `Dockerfile`, and (in this repo's variant) a `lib/` subfolder with hardening helpers.

**Mother repo**:
This repository — `~/Dev/Sandcastle/`. The development workshop. Not a runtime. Hosts the canonical `.sandcastle/` folder that gets copied out plus the test suite that validates it.
_Avoid_: deployed repo, runtime repo

**Target project**:
Any project that has `.sandcastle/` copied into it. Affinity-tracker is the first.

**Loop**:
The orchestration `.sandcastle/main.mts` runs: pick an issue → implementer → reviewer → merge. Repeats until the backlog is empty or the iteration cap is hit.

**Implementer**:
The agent run that writes code to close one issue inside a sandboxed container.

**Reviewer / Final Reviewer**:
Agent runs that gate-check the implementer's commits before they ship.

**Recovery**:
Agent run that takes over when an implementer aborts before producing a complete verdict envelope. Cleans up state and either finalizes or hands the issue back to a human.

**Verdict**:
The typed JSON envelope an agent emits at the end of a run. Parsed by `src/verdicts/`. If parsing fails the run is treated as failed.

**Issue / story**:
A unit of backlog work in GitHub Issues. Carries one of these status labels at a time: `ready-for-agent`, `in-progress`, `done`, `needs-human`.

**Old path / fallback loop**:
The earlier orchestrator design that lives in `src/loop/`, `src/planner/`, `src/recovery/`. Kept as a switchable alternative. New default is `.sandcastle/main.mts`.

**Matt's pattern**:
The setup convention this repo follows: one self-contained `.sandcastle/` folder per project, run via `npm run sandcastle` from the project root, no external orchestrator package. Named after Matt Pocock's stock templates.

**FIX-5 hardening**:
The typed-verdict parsing, label-transition retry, recovery ladder, and findings-fix work that landed on Sandcastle main during the FIX-5 wave. The reason `.sandcastle/main.mts` is larger than Matt's stock template.

**The bash loop**:
The predecessor at `/home/deploy/dev/affinity-tracker/scripts/ralph/afk-ralph.sh`. Retired but preserved as rollback.

## Relationships

- A **Mother repo** produces exactly one **`.sandcastle/`** folder which is copied (not symlinked or installed) into each **Target project**.
- A **Target project**'s **Loop** picks one **Issue** at a time and runs an **Implementer**, then a **Reviewer**, optionally a **Recovery**.
- Each agent run emits one **Verdict**. The Loop reads the Verdict to decide whether to merge, retry, or escalate.
- The **Old path / fallback loop** in `src/loop/` shares its helpers (`src/state/`, `src/verdicts/`, `src/migrations/`) with the new `.sandcastle/main.mts` — the helpers exist in both `src/` and `.sandcastle/lib/` as duplicates so neither path depends on the other.

## Flagged ambiguities

- "sandcastle-loop" was used to mean both this repo (Mother repo) and a deployed runtime on a server. Resolved: the deployed runtime concept was abandoned; only the **Mother repo** meaning remains. The GitHub repo is still named `sandcastle-loop` for backup-mirror purposes only.
- "Matt-strict" was used to mean both "use Matt's stock template code as-is" and "use Matt's setup convention but keep our hardening". Resolved: the second meaning. We follow **Matt's pattern**, not his stock code.
