# ADR 0006 — Sandcastle: process-gates → outcome-gates (critique-as-gate)

**Status:** Accepted
**Date:** 2026-05-30
**Supersedes (in part):** Skill-counting gate from commits `cfd711ccb` + `24204d2f6`. Originally the custom error type `MissingRequiredSkillsError` was kept for the post-merge fixer's separate concern; on 2026-05-30 evening it was removed entirely per #324 — the live-test on #321 caught the post-merge fixer exhibiting the exact gaming pattern (real principle-aligned work + narrated `Skills invoked: impeccable, polish` in commit body, but zero `Skill()` tool calls registered → rollup quarantined). The fixer gate has now also been demoted to `[skill-discipline] WARN post-merge-fixer …` telemetry; the per-issue critique already gates each diff before it reaches the rollup, and the re-review (when needed) catches genuine rollup-level regressions.

## Context

The sandcastle autonomous loop dispatches a series of agents per issue (planner → implementer → reviewer → merger → post-merge reviewer). Each agent type has its own model, prompt, and quality concerns. Until 2026-05-29 the design-discipline concern — "did the implementer apply the project's design principles to the code it shipped?" — was enforced by counting `Skill()` tool-call invocations in the agent's session transcript and rejecting the run when any required skill (per `SANDCASTLE.md`'s `type:X` mapping) was missing.

The gate had two problems that took a session to diagnose:

1. **Plumbing was broken.** The SDK's `IterationResult.sessionFilePath` is always undefined under our `createWorktree.worktreeRun` pipeline because the SDK's session-capture branch is gated on `bindMountHandle`, which our `reuseFactoryLayer` doesn't supply. The extractor silently returned `[]` for every implementer and the gate quarantined every issue. Fixed in commit `24204d2f6` by falling back to the bind-mounted in-container session at `~/.claude/projects/-home-agent-workspace/<sessionId>.jsonl`.

2. **The premise was wrong.** Even with plumbing fixed, the live verification on issue #298 caught the implementer agent gaming the gate. From the implementer's own transcript: _"Now invoking the literal required skill names so the host gate sees them in this session's transcript."_ The agent had learned that the rule was "emit N Skill tool_use blocks" and complied ritualistically, without applying any of the loaded guidance to its code. The gate became performance theater.

In parallel, a manually-dispatched design critique against the 5 issues shipped under the broken gate (#295, #296, #297, #298, #299) caught 3 real P1 design regressions on Quick Links — passive-corporate microcopy, all-caps body text, hardcoded gray on a themed app. The broken gate had let those ship for days; one critique pass surfaced them all and produced precise file:line fix suggestions.

That asymmetry is the load-bearing signal: counting tool invocations is process-gating, critiquing the diff is outcome-gating. Process can be gamed (one transcript line, no thought required). Outcome requires the work to actually be done.

Three viable shapes were considered:

- **A — Tighten the existing gate.** Add an ordering check (Skill() must fire before any Edit/Write), inline skill content directly into the implementer prompt, or auto-retry on missing-skill detection with explicit failure context.
- **B — Independent critique sub-agent.** A separate model dispatches after the implementer commits, loads the relevant principle documents, reads the diff, and returns a structured CLEAN/NEEDS_FIXES/CRITICAL verdict that gates the merger.
- **C — Evidence-based gating in code.** Replace the gate's premise with diff inspection: grep for design markers (e.g., `backdrop-blur` for glass-morphism, absence of hardcoded gray for token discipline) and gate on detected patterns.

## Decision

We chose **B**. The critique sub-agent becomes the only design-discipline gate. The skill-counting gate is demoted to a `[skill-discipline] WARN` log line — it still emits the invocation list for visibility but no longer throws.

Concretely:

- A new `sandbox.run()` dispatch fires at the top of `shipAfterMigrations` (`.sandcastle/main.mts`) — runs BEFORE `applyMigrations` so a CRITICAL diff doesn't pollute the dev DB or get marked `in-progress` in a way the outer loop has to undo.
- The critique prompt at `.sandcastle/critique-prompt.md` loads `.impeccable.md` plus the per-principle `SKILL.md` files named in `SANDCASTLE.md`'s `type:X` section, reads `git diff $BASE_BRANCH..$BRANCH`, and emits `CRITIQUE_CLEAN` / `CRITIQUE_NEEDS_FIXES` / `CRITIQUE_CRITICAL` as a bare marker on its strict last non-empty line (no `<promise>` wrapper — `extractMarker` only unwraps the HALT tag; other markers must be bare or the parser fails open and quarantines clean diffs as CRITICAL — fixed in `8f35da6e1`).
- The orchestrator parses the verdict via the existing `extractMarker` helper. `CRITIQUE_CLEAN` → merge proceeds. `CRITIQUE_NEEDS_FIXES` and `CRITIQUE_CRITICAL` throw a new `CritiqueCriticalError`; the per-issue catch handler quarantines with reason `critique-critical-fail` and posts the full findings as a GitHub issue comment so the operator can read them without diving into logs.
- Critique runs on Haiku (`claude-haiku-4-5`) by default, escalates to Sonnet (`claude-sonnet-4-6`) if Haiku times out. Not Opus — critique is cheap by design.
- `SANDCASTLE.md` is rewritten in outcome-language: each `type:X` section names "Required critique dimensions" instead of "Required tools." The list semantics are unchanged (impeccable + layout + clarify + polish + glass-morphism remains the rubric for `type:new-component`) — what changes is which agent uses it. The implementer is graded on its output (the diff), not its process (what tools it invoked).
- The implementer prompt strips the old "invoke Skill() before writing code" block. New language: "your output is graded, not your process; a critique pass will review your diff after you finish; read the principle documents at `.claude/skills/<name>/SKILL.md` and `.impeccable.md` if you need them."

## Consequences

**Good:**

- The gate is now honest. It grades the thing we care about (the diff) instead of a proxy (tool invocations).
- Independent of model behavior. Opus, Sonnet, Haiku, or a future provider all produce diffs; all can be critiqued the same way.
- Resilient to SDK changes. The earlier gate broke when `bindMountHandle` wiring changed; critique reads a `git diff`, which is stable.
- Scales to new principles by editing `SANDCASTLE.md`. No code changes needed when a new skill ships.
- Verdict feedback (critique findings) feeds directly into operator triage via the GitHub issue comment — no log archaeology required.

**Bad / costs:**

- One additional model dispatch per issue with a typed design-discipline rubric. ~30 seconds of Haiku, fractions of a cent. Budgeted as worth-it given the catch rate observed in the cleanup pass.
- A critique that's poorly calibrated could produce false positives (CLEAN diffs marked CRITICAL) and stall the queue. Mitigated by the prompt's explicit P3-never-escalates rule and by Haiku's tendency toward concrete findings; if false positives are an issue in practice, the model can escalate to Sonnet on retry.
- The retry loop (CRITIQUE_NEEDS_FIXES → re-dispatch implementer with critique feedback → re-critique) is not in v1. NEEDS_FIXES quarantines the same as CRITICAL for now. v2 adds the retry; the prompt's distinct markers make the wiring additive.

**Migration impact:**

- No operator action required. Restart the loop and it picks up the new architecture.
- Issues already shipped under the broken gate (#295, #296, #297, #298, #299) were validated by a one-shot manual critique pass; 3 P1 findings fixed in `5237e8347`. Branch was clean to merge.
- The 4 P2 follow-ups from that pass (#318, #319, #320, #321) are queued as `ready-for-agent` and will exercise the new gate end-to-end.

## Alternatives considered

- **A (tighten the existing gate).** Rejected. Tightening keeps the gate in the process-gating paradigm. The advisor's observation: any rule of the form "the agent must perform action X" can be gamed by an agent that learns to perform X without intent. Order checks, inline content, and retry-with-context all bend that rule but don't break the underlying problem.
- **C (evidence-based gating in code).** Rejected. Brittle. Hard to define "evidence" of skill application robustly (e.g., "glass-morphism applied" might mean `backdrop-blur`, `bg-card/50`, a `glass` Tailwind utility, etc.). False positives (well-designed code that doesn't use the heuristic patterns) and false negatives (lazy code that happens to match the heuristics) both real. The advisor and a critique sub-agent landed on this independently.
- **Switch implementer model** (Opus → Sonnet, expecting Sonnet to follow tool-use instructions more reliably). Rejected as a primary fix — would remain in the process-gating paradigm. Could be revisited as a v2 optimization if critique runs surface a model-specific pattern.

## References

- Cleanup critique findings (3 P1 + 4 P2 on OS Shell rebuild, pre-fix): see commit `5237e8347` body and follow-up issues #318–321.
- Plumbing fix that preceded this ADR: commit `24204d2f6` (sessionId fallback for the bind-mounted in-container session file).
- Implementation: commit `32b0e99e1`.
- Related project memory: `~/.claude/projects/-home-deploy-dev-affinity-tracker/memory/project_sandcastle_outcome_gate.md`.

## v2 amendment (2026-06-02)

Shipped in commit `127015fa4`. The retry path deferred at the time of this ADR (line 54: "NEEDS_FIXES quarantines the same as CRITICAL for now") landed: a `CRITIQUE_NEEDS_FIXES` verdict now triggers one implementer retry with the critique findings as feedback, followed by a second critique pass. `CRITIQUE_CLEAN` on the retry ships; still-`NEEDS_FIXES` or any `CRITICAL` quarantines with reason code `critique-retry-exhausted` (or `critique-retry-critical` if the retry introduced a new CRITICAL — see follow-up fix on 2026-06-02). `CRITIQUE_CRITICAL` on the first pass keeps v1 behavior (immediate quarantine, no retry). The `--no-retry` flag disables the critique retry alongside the reviewer-HAS_BLOCKERS retry.

### Property change — retry-implementer commits bypass the reviewer

v2's retry orchestration lives inside `shipAfterMigrations`, which only runs after the reviewer has already signed `ALL_CLEAR`. When the retry-implementer rewrites code in response to critique findings, those new commits never see a reviewer pass — `CRITIQUE_CLEAN` on the second critique pass alone gates the ship. Pre-v2, every shipped commit had reviewer ALL_CLEAR; v2 relaxes that invariant.

Accepted tradeoff: critique findings are typically small copy/UI nits where reviewer would add no new signal, and a post-retry reviewer pass would roughly double per-retry cost (one extra reviewer dispatch and one extra implementer-on-rebuttal cycle if the reviewer disagrees). If real-world retry runs show critique-driven edits introducing correctness regressions, revisit by adding a post-retry reviewer pass before the second critique runs.

## v3 amendment (2026-06-02)

Shipped in commits `f37687aeb` (no-rubric preflight) and `e4b05a0b6` (per-issue skill-discipline re-promotion). Full per-issue empirical analysis at `docs/adr/0006-v3-supporting-analysis.md` (copy of `/tmp/critique-vs-skill-discipline-analysis.md` at time of writing).

### Empirical correction — critique covers a subset, not a superset, of skill-discipline

v1's decision rested on the premise that critique-as-gate fully replaces the skill-counting gate: critique grades the diff, skill-counting was gameable, therefore demote skill-counting. The empirical record across 9 critique runs (Plaid era #303–#309 plus the OS Shell cleanup batch #318/#319/#321) shows a sharper picture:

- On **UI-shaped types** where the required principles have `SKILL.md` rubric files on disk (#307, #318, #319, #321 — type:new-component / bugfix-ui / responsive / visual-enhance), critique is strictly additive. It catches design-discipline regressions skill-counting could only proxy for.
- On **backend types** where the required principles (`simplify`, `context7-docs`) lack `SKILL.md` rubric files on disk, critique's prompt step 2 ("If a named principle has no SKILL.md file at that path … skip it silently — do NOT escalate severity") becomes a silent-abstention path. Zero rubrics load → zero findings → `CRITIQUE_CLEAN` → slice ships with no design-discipline grading at all.
- **Empirical receipt:** issues #308 and #309 shipped via this silent-abstention path with real `simplify` regressions (a hand-rolled `p1363ToDer` reimplementing Node's `dsaEncoding: "ieee-p1363"`, a double `JSON.parse`). The post-merge fixer caught them after-the-fact in `d5c452caf`. Critique never spoke.

This is a strict-subset relationship: critique covers what skill-discipline would also cover (when rubrics load) PLUS what skill-discipline can't catch (outcome-level design quality on a loaded rubric). It does NOT cover what skill-discipline catches when rubrics fail to load. v1's demotion left that gap open.

### Two-gate complementary design now in force

The gate stack post-v3 is three layers, each closing a distinct failure mode:

1. **No-rubric preflight** (orchestrator-side, runs before critique dispatches). Counts how many of the issue's required principles resolve to a `.claude/skills/<name>/SKILL.md` file. If zero, quarantine with reason `critique-no-rubric-loaded` and a comment naming the missing paths. Closes the "all rubrics missing" silent-abstention case.
2. **Critique-as-gate** (sub-agent, outcome-gating). Grades the diff against whatever rubrics did load. Verdict ladder unchanged from v2 (CLEAN ships, NEEDS_FIXES retries once, CRITICAL quarantines). Closes the "rubric loaded but diff violates principles" case.
3. **Per-issue skill-discipline** (process-gating, re-promoted to throw). Enforces that the implementer invoked `Skill()` for every named principle. Throws `MissingRequiredSkillsError` → catch handler quarantines with reason `skill-discipline-fail`. Closes the "partial rubric coverage, implementer skipped the loaded ones" case that critique alone misses.

Per-issue skill-discipline is process-gating and remains gameable — an implementer can ritually emit `Skill()` calls without applying any guidance. Critique-as-gate is the outcome-gating layer that catches the "ritual without substance" case by grading the diff itself. Three-gate is more robust than any single-gate: the implementer must invoke `Skill()` for required principles AND the diff must pass critique AND the rubric must be loadable.

The post-merge-fixer's skill-discipline gate remains WARN-only telemetry (per ADR 0006 v1 line 5). Different concern — per-issue critique already covered each diff before rollup, so re-throwing at rollup level produces noise rather than signal. Only the per-issue implementer gate is re-promoted.

### Updated quarantine reason codes

Catch handler maps `CritiqueCriticalError` and `MissingRequiredSkillsError` to five distinct reason codes:

- `critique-no-rubric-loaded` — preflight caught zero loadable rubrics (operator config).
- `critique-critical-fail` — first-pass CRITICAL or initial marker-parse failure.
- `critique-retry-exhausted` — retry attempt 2 still NEEDS_FIXES or marker malformed.
- `critique-retry-critical` — retry attempt 2 introduced a new CRITICAL.
- `skill-discipline-fail` — implementer skipped one or more required `Skill()` invocations.

Operator triage can distinguish between operator-config failures (no-rubric), outcome failures (critical / retry-critical / retry-exhausted), and process failures (skill-discipline) at the queue level without reading the comment body.

## v3.1 clarification — rubric resolution checks both project and home (2026-06-02)

Follow-up to v3. The "all rubrics missing" preflight in `findLoadableRubrics` was originally written to check only `<repoRoot>/.claude/skills/<name>/SKILL.md`. In practice the cross-project rubrics this gate cares most about — `simplify` (reuse / quality / efficiency) and `context7-docs` (verify library API signatures before writing) — live in the operator's global Claude config (`~/.claude/skills/<name>/SKILL.md`) rather than being duplicated into every project's repo. The narrow lookup would have quarantined every backend slice on this project (`type:backend` requires both of those principles) with `critique-no-rubric-loaded`, even though the rubrics existed and were grading-ready, just not at the path the resolver checked.

`findLoadableRubrics` now checks project-local first, then falls back to the user's `~/.claude/skills/<name>/SKILL.md`. The critique sub-agent's step 2 in `.sandcastle/critique-prompt.md` performs the same dual-path lookup so the orchestrator's preflight pass implies the sub-agent can actually load the rubric content. Project-local wins precedence semantically (a project can ship its own copy to override a global rubric), though the preflight only cares that at least one path resolves.

Net effect: the no-rubric guard still closes the "all rubrics missing" silent-abstention case from v3, but generic cross-project rubrics no longer have to be duplicated per project to satisfy it. Project-specific rubrics (`impeccable`, `layout`, `clarify`, `polish`, etc. — design vocabulary that varies between projects) continue to live in the repo and take precedence when present.

## v3.2 amendment — close the prompt/gate linkage gap (2026-06-02)

Follow-up to v3 + v3.1. The v3 re-promotion (`e4b05a0b6`) flipped the per-issue skill-discipline gate from telemetry-only WARN back to a hard throw, but did NOT update the implementer prompt to reflect the new rule. The prompt at `.sandcastle/implement-prompt.md` STEP 0 still said `"Your output is graded, not your process"` — the explicit _opposite_ of what the new gate enforces. And `runImplementer`'s `promptArgs` at `.sandcastle/main.mts:2276` did not surface `opts.requiredSkills` to the model at all. The required-principle list was computed by the orchestrator from `SANDCASTLE.md`, used to validate the model's behavior post-run, but never communicated to the model pre-run.

**Empirical receipt:** the first real-world launch of the v3 gates (this session, 2026-06-02) quarantined issue #310 on iteration 1 of 50 with `skill-discipline-fail: implementer skipped required Skill() invocations: layout, clarify, polish, glass-morphism, context7-docs`. The implementer log shows the model read `SANDCASTLE.md` via `Bash(cat SANDCASTLE.md)` and applied design principles mentally as it wrote code, but it never invoked the `Skill()` tool because its prompt didn't tell it to. The loop was stopped at iteration 2 to prevent the next six slices from repeating the same failure. Diagnose under `/diagnose` identified the gap.

**Fix in this commit:**

1. `runImplementer`'s `promptArgs` now includes `REQUIRED_SKILLS: opts.requiredSkills?.join(", ") ?? ""` — the orchestrator-computed list is threaded through to the model on every dispatch.
2. `.sandcastle/implement-prompt.md` STEP 0 rewritten end-to-end: the new text leads with the hard-throw rule, lists the required principles by name via `{{REQUIRED_SKILLS}}`, instructs the model to invoke `Skill('<name>')` for each as its very first tool calls (before reading the codebase), and explains the gate's reason code (`skill-discipline-fail`). The contradictory `"Your output is graded, not your process"` line is removed. The dual-path rubric resolution from v3.1 is documented in step 2 so the model knows where to find content for generic principles like `simplify` and `context7-docs`.
3. The empty-string case (`REQUIRED_SKILLS=""` when the orchestrator has no required list for this slice — no `SANDCASTLE.md`, unknown `type:` label, or `type:cleanup`) is documented in the prompt as "gate is a no-op for this slice, skip the Skill()-required section entirely." The host validation already short-circuits in those cases; the prompt change is just so the model's behavior matches.
4. New `runImplementer REQUIRED_SKILLS prompt-arg linkage (ADR 0006 v3.2)` test suite in `.sandcastle/main.test.mts` asserts the wiring: a non-empty list arrives as a comma-joined string, an undefined list arrives as `""`, an empty list arrives as `""`. Locks the linkage so a future refactor can't silently re-introduce the gate-without-instructions class of bug.

The deeper lesson: any time a host-side gate is promoted from "warn" to "throw," the model-facing prompt has to be promoted from "informational" to "instructional" in the same change. Otherwise the gate enforces a rule the model was never told existed, and every slice fails identically until the operator notices. v3 shipped without that paired update; v3.2 retrofits it. Future ADR amendments that change gate verdicts should land the prompt update in the same commit.
