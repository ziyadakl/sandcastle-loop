# Sandcastle

The development repo for an autonomous coding loop. The runnable artifact is a `.sandcastle/` folder that gets copied into target projects by `bin/init.mjs`; each project then runs the loop locally via its `sandcastle` package script. The loop itself is the simplified one described in ADR 0023 (first test, build, review with fixer rounds, ship onto a run branch); its behaviour is configured per project by `.sandcastle/project.json`. This repo is the workshop where that folder is tested and version-controlled, and it is downstream of the loop it was taken from (ADR 0023): it is updated by copying from that loop, never the reverse.

## Language

**Sandcastle** (capital S):
This repo and its tooling. Distinct from `@ai-hero/sandcastle`, the upstream npm package by Matt Pocock that ours builds on. Note: `package.json` still names the project `sandcastle-loop` (legacy from when this was thought of as a deployable runtime); "Sandcastle" is the canonical term in prose, but you'll see `sandcastle-loop` in the manifest and bin entry.

**`.sandcastle/`** (with the leading dot):
The per-project folder that is copied into each target project. Contains `main.mts` (orchestrator), prompt files, `Dockerfile`, and (in this repo's variant) a `lib/` subfolder with hardening helpers.

**`skills/`** (no leading dot):
The ten `/sandcastle-*` skills, version-controlled here and symlinked into
`~/.claude/skills/` by `skills/install.sh`. **User-level, not project-level** —
they are invoked from *target projects* (`/sandcastle-update` runs inside
your own project), so this repo's `.claude/skills/` would be the one scope where
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
This repository. The development workshop. Not a runtime. Hosts the canonical `.sandcastle/` folder that gets copied out plus the test suite that validates it.
_Avoid_: deployed repo, runtime repo

**Target project**:
Any project that has `.sandcastle/` copied into it.

**Loop**:
The orchestration `.sandcastle/main.mts` runs, per ticket: first test (advisory, locked) → implementer → reviewer, with up to three fix rounds → ship onto the run branch. A ticket that still fails is retried on later runs until it has spent $100 or been tried three times. Repeats until the backlog is empty or the iteration cap is hit.

**Implementer**:
The agent run that writes code to close one issue inside a sandboxed container.

**Reviewer / Post-merge reviewer**:
Agent runs that gate-check the implementer's commits before they ship (the reviewer, per ticket) and the combined integration tree after the merge (the post-merge reviewer). The reviewer also grades design rules from `SANDCASTLE.md`; there is no separate critique pass.

**First test** (called a "check" in the code and prompts):
The test a check-writer agent writes for a ticket before any code is built, proved to fail on the untouched code, then locked. Advisory: a ticket whose first test cannot be produced still ships on the reviewer's pass, labelled `shipped-without-first-test`.

**Fixer** (the "recovery" role in `.sandcastle/models.ts` and the `--recovery` flag):
On by default; `--recovery off` switches it off. When the reviewer refuses, a check fails, or a time-out ends the build, one fixer pass takes the ticket, with the same three review rounds the builder had. There is no other rescue road. Under `--budget` the merger, post-merge-fixer and fixer roles carry bounded escalation-retry loops (see "What the simplified loop removed" below).

**Retry budget**:
Counts, never sorts: a ticket that still fails is retried on later runs until it has spent $100 in total or been tried three times, then waits for a session (`waiting-for-session`). Lives in `.sandcastle/lib/state/retry-budget.ts`.

**Run branch**:
The branch a run lands each finished ticket on (`sandcastle/queue-<date>`). The run's own pull request reaches the base branch when `landCheck` (see `project.json`) passes on its tip and the loop lands it itself, or when the owner lands it.

**`project.json`** (`.sandcastle/project.json`, shipped as `project.example.json`):
The per-project settings file: `landCheck`, `testDatabase`, `migrations`, `checksRoot`, `protectedPaths`, `wideReachPaths`, `ownerName`, `commitIdentity`. Every key has a project-neutral default; a project with no file runs the generic loop. See the root `README.md` for the table.

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
The typed JSON envelope an agent emits at the end of a run. Parsed by `.sandcastle/lib/verdicts/`. If parsing fails the run is treated as failed.

**Orchestrator stream** (a.k.a. "the sandcastle log"):
The combined stdout of `.sandcastle/main.mts`: the SDK's per-agent startup
lines (`[implementer] Started…`, the dim `tail -f` hint, run-summary rows — emitted
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
The per-target-project file that activates the design-rules review and
skill-discipline gates by mapping each issue `type:<label>` to its required
design principles. **Absent by default** — the template ships only
`.sandcastle/SANDCASTLE.md.example`; until a consumer copies it to
`SANDCASTLE.md` at the repo root, `parseRequiredSkillsByType` returns an empty
map and both gates graceful-degrade to a no-op (nothing is graded). See
`.sandcastle/SANDCASTLE.md.example` for the format. (ADR 0006's separate
critique pass is superseded by ADR 0023; the reviewer grades the same
principles.) The same file is where a project tells the AI agents the facts the
prompts point at: its check helpers, seeded test data and known-failures doc.

**Lint gate**:
Host-side backstop that quarantines a slice whose commit lacks the `SANDCASTLE-LINT: pass` cert when the target project defines a `lint` script. Dormant by default — a project with no `lint` script (like this template) graceful-degrades to a no-op, same as the design-rules/skill-discipline gates. See `classifyLintCert` / `checkLintCert` in `.sandcastle/main.mts`.

**Issue / story**:
A unit of backlog work in GitHub Issues. Carries state labels such as `ready-for-agent`, `in-progress`, `shipped-local` (landed on the run branch, not yet on the base), `waiting-for-session`, `needs-human` (only a ticket too unclear to build) and `done`.

**Archived v1 orchestrator**:
The earlier orchestrator design now frozen under `archive/loop/`, `archive/planner/`, `archive/recovery/` (moved by commit `76de6fa`). Not switchable; not type-checked by the root tsconfig; not run by vitest. Kept for pattern reference — particularly `archive/recovery/diagnose.ts`, whose three actionable halt-cause patterns have been ported into `.sandcastle/lib/diagnose.ts` (hint-only, since the live sandbox surface is LLM-only). Live orchestrator: `.sandcastle/main.mts`.

**Matt's pattern**:
The setup convention this repo follows: one self-contained `.sandcastle/` folder per project, run via `npm run sandcastle` from the project root, no external orchestrator package. Named after Matt Pocock's stock templates [per published video content — see footnote].

**FIX-5 hardening**:
The typed-verdict parsing, label-transition retry and findings-fix work that landed on Sandcastle main during the FIX-5 wave (the recovery ladder it also added was later simplified into the single fixer pass). One reason `.sandcastle/main.mts` is larger than Matt's stock template.

**The bash loop**:
The predecessor shell script, kept as `refs/afk-ralph.sh.local-fork`. Retired but preserved for reference.

## Relationships

- A **Mother repo** produces exactly one **`.sandcastle/`** folder which is copied (not symlinked or installed) into each **Target project**.
- A **Target project**'s **Loop** picks one **Issue** at a time and runs a **First test** writer, an **Implementer**, then a **Reviewer**, with a **Fixer** when the reviewer refuses.
- Each agent run emits one **Verdict**. The Loop reads the Verdict to decide whether to ship, hand to the fixer, or retry under the **Retry budget**.
- The loop's code and its tests both live in `.sandcastle/` (the older root `src/` and `tests/` copies were dropped). The few root tests under `tests/` cover `bin/init.mjs`, `skills/install.sh` and the template-commit guard.

## Flagged ambiguities

- "sandcastle-loop" was used to mean both this repo (Mother repo) and a deployed runtime on a server. Resolved: the deployed runtime concept was abandoned; only the **Mother repo** meaning remains. The GitHub repo is still named `sandcastle-loop` for backup-mirror purposes only.
- "Matt-strict" was used to mean both "use Matt's stock template code as-is" and "use Matt's setup convention but keep our hardening". Resolved: the second meaning. We follow **Matt's pattern** [per published video content], not his stock code.

## What the simplified loop removed

ADR 0023 records the decision. Checked against the code in `.sandcastle/`, these older mechanisms are gone and must not be described as current:

- **The judge** (the referee between a ticket's test and its code, with its rulings, budgets and mutant gate). Only helper modules under `lib/judge/` (check freeze, grounds parsing, replay hazards) remain.
- **The separate design critique pass and its fix pass.** The reviewer grades the same design rules. (`models.ts` still has a `critique` tier; it now serves the check-writer.)
- **The planner agent.** Dispatch is deterministic (`planDeterministic`); there is no `planner` model role.
- **The auto-requeue sweep**, replaced by the per-ticket retry budget.
- **The old recovery pass as an opt-in ladder.** The fixer (the `recovery` role) is now the one rescue road, on by default, with three rounds.
- The watch-only/enforcing switch on the screen check, and every stop label the removed roads produced.

Escalation ladders still exist per role in `.sandcastle/models.ts` and under `--budget`; a role with empty `escalations` makes a single attempt.

## Review-quality gates (ported rubrics)

The loop grades work at its own gates (per-issue reviewer, post-merge reviewer) rather than by invoking the interactive review/build skills verbatim — invoking them breaks the codex backend (no `Skill` tool), fights the reviewer's `maxIterations:1` budget, and relies on an unverified nested-sub-agent capability in the headless `claude --print` path. Instead the skills' rigor, which lives in their rubric TEXT, is **ported** into the gate prompts:

- `implement-prompt.md` carries the false-green build discipline from `/tdd`'s `testing-anti-patterns.md` (tests must exercise the real runtime path, not hand-built fixtures).
- `review-prompt.md` and `post-merge-review-prompt.md` carry a **Test fidelity (false-green)** sweep category plus the **Fowler smell baseline** (from the `code-review` skill) and the **Quality rubric** (from the `thermo-review` skill). The post-merge reviewer additionally carries a **cross-issue interaction** check, since it is the only gate that sees the combined integration tree (where isolated-green issues can go inert once merged).
- The per-issue reviewer escalates its first pass off the cheap default model to the reviewer escalation tier when a diff is substantial or touches sensitive paths (`SANDCASTLE_REVIEW_ESCALATE_DIFF_LINES` / `SANDCASTLE_REVIEW_ESCALATE_PATHS`); ordinary small diffs stay on the default, so cost only rises where it matters.

**Drift caveat:** the ported rubric blocks are COPIES of the upstream skills and will drift when those skills change. Each ported block (the Fowler baseline, the Quality rubric, and the `/tdd`-derived false-green discipline in all three prompts) carries a `(ported from … — SYNC PERIODICALLY)` pointer. The post-merge **cross-issue interaction** check is loop-original (not ported from any skill), so it needs no sync pointer. When the upstream `code-review` / `thermo-review` / `test-driven-development` skills change materially, re-sync these blocks. A dedicated adversarial multi-shard pre-land gate is a deliberate deferred follow-up, gated on verifying nested-sub-agent support (or building it as orchestrator-dispatched review roles).

## Footnote on evidence base

References to "Matt's pattern" and "Matt's published philosophy" in this document are sourced from a NotebookLM notebook of Matt Pocock's YouTube videos and blog posts. They are **not** verified against his production loop code, which lives in a private repo. Treat such citations as `[ASSUMED: source = NotebookLM transcripts of Matt's published video content; not verified against his production code]`. Verifiable factual references — `@ai-hero/sandcastle` (published npm package) and his public stock templates — are not assumed.
