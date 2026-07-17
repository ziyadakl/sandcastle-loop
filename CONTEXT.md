# Sandcastle

The development repo for an autonomous coding loop. The runnable artifact is a `.sandcastle/` folder that gets copied into target projects (e.g. affinity-tracker); each project then runs the loop locally via `npm run sandcastle`. This repo is the workshop where that folder is built, tested, and version-controlled.

## Language

**Sandcastle** (capital S):
This repo and its tooling. Distinct from `@ai-hero/sandcastle`, the upstream npm package by Matt Pocock that ours builds on. Note: `package.json` still names the project `sandcastle-loop` (legacy from when this was thought of as a deployable runtime); "Sandcastle" is the canonical term in prose, but you'll see `sandcastle-loop` in the manifest and bin entry.

**`.sandcastle/`** (with the leading dot):
The per-project folder that is copied into each target project. Contains `main.mts` (orchestrator), prompt files, `Dockerfile`, and (in this repo's variant) a `lib/` subfolder with hardening helpers.

**`skills/`** (no leading dot):
The nine `/sandcastle-*` skills, version-controlled here and symlinked into
`~/.claude/skills/` by `skills/install.sh`. **User-level, not project-level** —
they are invoked from *target projects* (`/sandcastle-update` runs inside
affinity-tracker), so this repo's `.claude/skills/` would be the one scope where
they're never needed. Distinct from `.sandcastle/`: that folder is *copied* into
targets; `skills/` is *linked* into the user's home and copied nowhere. A `git
pull` alone does not update a machine's skills — `install.sh` must run there.
See ADR 0022.

**Host registry** (`.sandcastle/hosts.json`) vs. **shipped example**
(`.sandcastle/hosts.example.json`):
The registry lists the hosts the loop may dispatch to (ADR 0019/0020). It is
**per-machine and untracked** — its `repoPath`s are right for one machine's
checkouts and wrong for every other, so tracking it shipped this repo's paths
into consumers. The *example* is what ships: same shape, `REPLACE-ME` values that
are non-functional on purpose. Absent registry ⇒ single local host, so multi-host
is opt-in. See ADR 0022.

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

**Agent backend**:
Which coding-agent binary/SDK factory drives a run — `claudeCode()` (Claude
Code) or `codex()` (OpenAI Codex). A new axis introduced by ADR 0012, and
deliberately distinct from two axes it is easy to conflate:
- **Sandbox** — *where* a run executes: `docker` vs `mac-host` (the `--sandbox`
  flag, the `SandboxHandle` interface).
- **Provider** — *which Anthropic-compatible endpoint/auth*: `anthropic` /
  `kimi` / `glm`. All three drive the **same** `claude` binary and differ only
  by injected env (`providers.ts`).
Codex is the first backend that is a genuinely *different binary*, so it is not
just another "provider" — `sandbox-provider.ts` routes both agent call sites
through an `agentForModel()` dispatch that picks the backend. Auth differs by
backend: Claude subscription via the macOS Keychain / a forwarded OAuth token
(ADR 0011); Codex subscription via `codex login` → a `~/.codex/auth.json` file
mounted **read-write** (ADR 0012).

**AGENTS.md**:
Codex's instruction layer — the file Codex reads before any work. On the Codex
backend it is the natural home for the per-issue required design-principle
skills: the Codex-side equivalent of the `{{REQUIRED_SKILLS}}` prompt
scaffolding the Claude path threads (ADR 0006 v3.2). Distinct from
`SANDCASTLE.md` (the consumer gate *config* mapping `type:<label>` → required
principles) and from the prompt files. See ADR 0012.

**Merger stash window**:
While the merger phase runs (the step that integrates the iteration's per-issue branches into the integration branch), `.sandcastle/` is temporarily stashed to git stash to avoid conflicts with the in-progress merge. Host edits to `.sandcastle/` files during that window land in the stash and reappear when the merger completes — they're not lost, just temporarily invisible. Don't panic if a file in `.sandcastle/` looks empty or unexpectedly different mid-iteration.

**Verdict**:
The typed JSON envelope an agent emits at the end of a run. Parsed by `src/verdicts/`. If parsing fails the run is treated as failed.

**Orchestrator stream** (a.k.a. "the sandcastle log"):
The combined stdout of `.sandcastle/main.mts`: the SDK's per-agent startup
lines (`[planner] Started…`, the dim `tail -f` hint, run-summary rows — emitted
by `printFileDisplayStartup` in `@ai-hero/sandcastle/dist/run.js` using Node's
built-in `styleText`) interleaved with the orchestrator's own ~85
`log()`/`logError()` lines (`[env]`, `[staging]`, `=== sandcastle-loop
iteration N/M ===`, `plan:`, `skill-discipline:`, …). In practice it is
redirected to a file (e.g. `/tmp/sandcastle.log`) and observed live via
`tail -f` in a tmux pane — **periodic triage glances, not a continuously-watched
render loop**. This is the surface a human scans to answer "does anything need
my attention / is there a reason to stop the loop." It is append-only and
pipe/file-safe by construction. The **loop itself stays headless** — it never
hosts a render loop, because it is launched detached/overnight and an in-loop
TUI would only exist while attached. A polished live dashboard is provided
instead by a **separate read-only viewer** (see below), not by restyling the
loop into a TUI.

**Agent transcript**:
The SDK's FileDisplay per-run log — one file per agent invocation at
`.sandcastle/logs/<branch>-<name>.log` (e.g. `agent-issue-337-implementer.log`).
The deep-dive surface a human opens when the orchestrator stream flags a
specific issue worth investigating. Distinct from the orchestrator stream.

**Sandcastle viewer** (`sandcastle-watch`):
A separate, **read-only** terminal UI run in the watch pane in place of
`tail -f`. It renders the polished live dashboard (header + iteration/counts,
a row per running issue, recent results) by reading the **status feed** — it
never writes, never touches the loop, and can be opened/closed/attached freely.
The worker (loop) never depends on a viewer being attached. Built with Ink
(React-for-terminals). See plan
`docs/superpowers/plans/2026-06-04-sandcastle-viewer-tui.md` and ADR 0008.

**Status feed** (`.sandcastle/status.json`):
The typed snapshot the loop rewrites **atomically** (write-tmp + `rename`) on
every state transition, so the viewer renders structured data rather than
parsing the human log's prose. zod-validated against a schema shared between
worker and viewer. The decoupling contract between the two: the loop is the only
writer, the viewer (and potentially the `/sandcastle-status` skill) are readers.
Token/dollar cost is **not** a guaranteed field — SDK `usage` is Claude-Code-only
and absent for kimi/glm runs, so cost is best-effort/optional, not load-bearing.

**`SANDCASTLE.md`** (consumer gate config):
The per-target-project file that activates the critique-as-gate and
skill-discipline gates by mapping each issue `type:<label>` to its required
design principles. **Absent by default** — the template ships only
`.sandcastle/SANDCASTLE.md.example`; until a consumer copies it to
`SANDCASTLE.md` at the repo root, `parseRequiredSkillsByType` returns an empty
map and both gates graceful-degrade to a no-op (nothing is graded). See
`.sandcastle/SANDCASTLE.md.example` for the format and ADR 0006 v3 for the
fail-loud preflight that quarantines a typed issue whose principles have no
loadable rubric.

**Lint gate**:
Host-side backstop that quarantines a slice whose commit lacks the `SANDCASTLE-LINT: pass` cert when the target project defines a `lint` script. Dormant by default — a project with no `lint` script (like this template) graceful-degrades to a no-op, same as the critique/skill-discipline gates. See `classifyLintCert` / `checkLintCert` in `.sandcastle/main.mts`.

**Issue / story**:
A unit of backlog work in GitHub Issues. Carries one of these status labels at a time: `ready-for-agent`, `in-progress`, `done`, `needs-human`.

**Archived v1 orchestrator**:
The earlier orchestrator design now frozen under `archive/loop/`, `archive/planner/`, `archive/recovery/` (moved by commit `76de6fa`). Not switchable; not type-checked by the root tsconfig; not run by vitest. Kept for pattern reference — particularly `archive/recovery/diagnose.ts`, whose three actionable halt-cause patterns have been ported into `.sandcastle/lib/diagnose.ts` (hint-only, since the live sandbox surface is LLM-only). Live orchestrator: `.sandcastle/main.mts`.

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
- The shared utility modules (`src/state/`, `src/verdicts/`, `src/migrations/`, `src/types.ts`) exist as duplicates of `.sandcastle/lib/{state,verdicts,migrations,types}.ts`. The duplication was created so the (now-archived) v1 orchestrator and the live `.sandcastle/main.mts` could evolve independently. Today only the live tests under `tests/` import from `src/`; production runtime imports from `.sandcastle/lib/`. Deduplicating the two trees is a follow-up cleanup item — both copies must move together when schemas change (see commits `db5358a`, `a9f2f14` for examples of dual-edit pairs).

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
