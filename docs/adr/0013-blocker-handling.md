# ADR 0013 — Sandcastle: where the `Blocked by:` gate lives (planner prompt, not code)

**Status:** Accepted
**Date:** 2026-06-17

## Context

Sandcastle lets an issue declare a dependency with a `Blocked by: #N` (or
`Blocked-by: #N`) line in its body. The intended behaviour: while #N is still
open, the blocked issue is skipped; once #N closes/merges, the blocked issue is
picked up automatically on the next iteration — no manual re-labelling.

This behaviour is real and it works, but **where** it is enforced has repeatedly
misled agents (and humans) auditing the code. Three separate sessions
investigated "does the loop honour `Blocked by:`?", grepped the codebase, landed
on the deterministic helper `parseBlockedBy`, saw that its only call site is
`buildBlockedByNote` — the advisory "nothing claimable" exit message — and
concluded the loop does **not** enforce blockers. That conclusion is wrong, and
it is wrong in a way the code actively invites: the truth is documented, but
only in the docstring of the advisory-note builder (`buildBlockedByNote`), which
is the last function anyone reads.

The actual enforcement happens in an **LLM prompt**, not in TypeScript:

- **GitHub-issue mode (default).** Each iteration the loop dispatches a
  **planner agent** (`.sandcastle/plan-prompt.md`, run from `main.mts`). The
  planner is given the `ready-for-agent` candidate pool *and* the full open-issue
  list, and **HARD RULE 2** instructs it to exclude any issue whose body says
  `Blocked by: #N` while #N is still open — treating the block as resolved only
  when #N is absent from the open set (closed/merged). The prompt also carries a
  truncation guard (`<truncation-halt/>`) for the 200-issue list cap, added after
  a May 2026 incident where a blocker hidden past the cap shipped dependent work
  and downstream cleanup destroyed user files.
- **PRD mode.** Separately, PRD-driven runs use a *deterministic* gate:
  `pickNextEligibleStory` (`lib/state/prd.ts`) excludes any story whose
  `blockedBy` array names a story that is not yet `done`.

So the codebase has two blocker mechanisms — one LLM-driven (GitHub issues), one
code-driven (PRD) — and the deterministic-looking code an investigator naturally
greps (`parseBlockedBy`, `listReadyIssues`, `claimViaLabel`) is **not** the
GitHub-issue gate. It only powers an advisory message.

## Decision

Keep the GitHub-issue blocker gate in the planner prompt (HARD RULE 2), and fix
the **discoverability** problem rather than the behaviour:

1. **Loud pointer comments at the three misleading code sites** — the docstrings
   of `parseBlockedBy` (`main.mts`), `listReadyIssues`, and `claimViaLabel`
   (`lib/state/gh.ts`). Each carries the greppable banner `⚠️ NOT THE BLOCKER
   GATE` and points at `plan-prompt.md` HARD RULE 2 and this ADR. These sit
   exactly where prior investigations took the wrong turn, so they intercept the
   wrong conclusion at the moment it forms.
2. **This ADR** as the canonical description of the two-mechanism design and the
   rationale for keeping enforcement in a prompt.

Both ride the template to every consumer repo via `sandcastle-update`.

## Consequences

- An agent or human grepping the selection/claim path now hits an explicit
  redirect to the real gate instead of a misleading "advisory-only" impression.
- The behaviour is unchanged. No new gate, no new `gh` call, no change to the
  autonomous dispatch path.
- The pointer comments are passive: they only help at the sites where they are
  placed. If a future selection entry point is added, it must carry the same
  banner. The banner string `NOT THE BLOCKER GATE` is deliberately greppable so
  the full set is easy to audit.
- The GitHub-issue gate remains LLM-driven. It is a strong, explicit instruction
  with a documented incident behind it, but it is a prompt instruction, not a
  hard-coded filter — a weak planner model or a truncated open-issue list can
  still mis-schedule. Operators who need a deterministic guarantee should use PRD
  mode, whose gate is code-enforced.

## Alternatives considered

- **Make the deterministic code enforce blocking too** (have
  `listReadyIssues`/the claim path filter blocked issues via `parseBlockedBy`).
  Rejected for this change. It fixes a documentation problem by changing
  behaviour on the most safety-critical path in the system, and it creates a
  second source of truth that can disagree with the planner: `parseBlockedBy` is
  a literal regex with no judgment, so prose like "was blocked by #5, now
  resolved" parses as a live block. It would also force a perfect
  re-implementation of the planner's truncation guard (whose absence caused the
  May 2026 file-destroying incident), and it is additive — HARD RULE 2 cannot be
  cleanly removed from the planner (which also handles priority, parallelism, and
  max-concurrent selection), so both gates would have to be maintained forever.
  Defense-in-depth enforcement may still be worth doing later, but as a
  deliberate decision on its own, not bundled into a discoverability fix.
- **Document the model in `SANDCASTLE.md`.** Rejected: `SANDCASTLE.md` is an
  optional per-consumer file (every use is guarded by `sandcastleMdExists`) for
  required-skills-by-type; it does not exist in the template, would drift across
  consumers, and an investigating agent does not grep it.
- **Document it in a skill.** Rejected: skills are trigger-invoked (e.g. running
  `/sandcastle-run`), not consulted during a code investigation, which is when
  the confusion actually happens.
