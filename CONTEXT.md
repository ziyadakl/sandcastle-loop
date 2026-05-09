# Sandcastle

The development repo for an autonomous coding loop. The runnable artifact is a `.sandcastle/` folder that gets copied into target projects (e.g. affinity-tracker); each project then runs the loop locally via `npm run sandcastle`. This repo is the workshop where that folder is built, tested, and version-controlled.

## Language

**Sandcastle** (capital S):
This repo and its tooling. Distinct from `@ai-hero/sandcastle`, the upstream npm package by Matt Pocock that ours builds on. Note: `package.json` still names the project `sandcastle-loop` (legacy from when this was thought of as a deployable runtime); "Sandcastle" is the canonical term in prose, but you'll see `sandcastle-loop` in the manifest and bin entry.

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
Off by default; enabled with `--recovery on`. When on, runs a single retry of the implementer with the same model before quarantining. (Earlier design had a fixer/recovery escalation ladder; that was cut — see "Keep-vs-cut criterion" below.)

**Merger stash window**:
While the merger phase runs (the step that integrates the iteration's per-issue branches into the integration branch), `.sandcastle/` is temporarily stashed to git stash to avoid conflicts with the in-progress merge. Host edits to `.sandcastle/` files during that window land in the stash and reappear when the merger completes — they're not lost, just temporarily invisible. Don't panic if a file in `.sandcastle/` looks empty or unexpectedly different mid-iteration.

**Verdict**:
The typed JSON envelope an agent emits at the end of a run. Parsed by `src/verdicts/`. If parsing fails the run is treated as failed.

**Issue / story**:
A unit of backlog work in GitHub Issues. Carries one of these status labels at a time: `ready-for-agent`, `in-progress`, `done`, `needs-human`.

**Old path / fallback loop**:
The earlier orchestrator design that lives in `src/loop/`, `src/planner/`, `src/recovery/`. Kept as a switchable alternative. New default is `.sandcastle/main.mts`.

**Matt's pattern**:
The setup convention this repo follows: one self-contained `.sandcastle/` folder per project, run via `npm run sandcastle` from the project root, no external orchestrator package. Named after Matt Pocock's stock templates [per published video content — see footnote].

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
- "Matt-strict" was used to mean both "use Matt's stock template code as-is" and "use Matt's setup convention but keep our hardening". Resolved: the second meaning. We follow **Matt's pattern** [per published video content], not his stock code.

## Keep-vs-cut criterion

When deciding what to keep from FIX-5 vs. cut on the move to `.sandcastle/main.mts`:

- **Kept** the FIX-5 helpers (typed verdict parsing, label-transition retry, migration applier) because they fix specific failure modes observed in this project's overnight runs.
- **Cut** the fixer/recovery escalation ladders because (1) Matt's published philosophy [per published video content] explicitly rejects cheap-then-strong escalation, (2) the user is non-technical and cannot debug downstream errors a cheaper model leaves behind, and (3) integration test #71 needed recovery only because the implementer was Sonnet — switching the default to Opus addresses the same need at the source.
- **However**, recovery is being restored as an opt-in flag (`--recovery on`) because we have not empirically verified Opus eliminates the failure mode.

## Footnote on evidence base

References to "Matt's pattern" and "Matt's published philosophy" in this document are sourced from a NotebookLM notebook of Matt Pocock's YouTube videos and blog posts. They are **not** verified against his production loop code, which lives in a private repo. Treat such citations as `[ASSUMED: source = NotebookLM transcripts of Matt's published video content; not verified against his production code]`. Verifiable factual references — `@ai-hero/sandcastle` (published npm package) and his public stock templates — are not assumed.
