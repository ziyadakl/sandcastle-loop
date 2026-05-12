# Smoke harness — what it proves, what it doesn't

> **Frozen reference (2026-05-11):** This document describes the v1 smoke
> harness, now at `archive/tests/smoke/run-smoke.ts` (moved by commit
> `76de6fa`). The harness is no longer wired into `npm run smoke` and the
> tests it covered were against the archived `archive/loop/run.ts`
> orchestrator. The live orchestrator (`.sandcastle/main.mts`) is exercised
> by the test suites under `tests/main.test.ts` and `tests/diagnose.test.ts`
> instead. Nothing below should be taken as current behavior.

The smoke harness lives at `tests/smoke/run-smoke.ts` and runs in under a
second. It exists to prove the wiring of the v1.1 loop is correct without
ever calling Claude or starting a container.

## How to run

```sh
npm run smoke
```

Exits 0 on PASS, 1 on assertion failure, 2 on uncaught error.

## Mode

The smoke runs in exactly one mode now: **runLoop**. It imports `runLoop`
from `src/loop/index.ts` and drives it directly. The legacy "standalone"
fallback (which drove `pickNextEligibleStory + markDone` against prd.json)
has been deleted as of FIX-4 — if `runLoop` cannot be imported or throws
during the run, the smoke FAILS. There is no fallback.

The startup banner reflects this:

```
[smoke] mode=runLoop (production loop)
```

## What the smoke proves

- **`runLoop` is the production entry point.** The Opus reviewer's MEDIUM
  #20 concern — that a green smoke could be consistent with the loop being
  completely broken — is closed: a green smoke now means v1.1's actual
  `runLoop` shipped smoke.1 from `ready-for-agent` to `done`.
- **Test seams resolve cleanly.** Every `_*` injection point on
  `RunLoopOptions` (`_agentRunner`, `_runPlanner`, `_listReadyIssues`,
  `_listInProgressIssues`, `_transitionLabel`, `_isIssueDone`,
  `_fetchIssueBody`, `_withSingleInstance`, `_createSandbox`,
  `_commentOnIssue`) is exercised end-to-end. Type drift on any seam fails
  the strict-TS compile.
- **Label state machine fires in order.** `claimViaLabel(999)` is invoked
  exactly once at iteration start; `markDoneViaLabel(999, ...)` is invoked
  exactly once with a non-empty summary at ship time;
  `quarantineViaLabel` is never invoked on the green path. All three are
  observed via a `gh` PATH stub that records argv to JSONL.
- **Planner runs ONCE per loop wake-up (Fix #2).** Counted explicitly via
  the `_runPlanner` seam — the loop must not re-call the planner per
  iteration.
- **Prompt-cache locality holds.** The implementer briefing and the
  reviewer briefing both embed the issue body verbatim at the SAME byte
  offset (`String.prototype.indexOf` is identical for both). Drift in
  `formatIssueBlock` or in either role's prefix would break this.
- **`progress.txt` accumulates.** The driver appends an `[it=N] ...` line
  after every implementer commit-landing event, and the assertion checks
  the file post-run. The reviewer's briefing also receives the
  progress-tail block (when one exists pre-iteration — the fixture seeds
  one bootstrap line so the contract is exercised).
- **Single-instance lock acquires + releases.** The smoke's
  `_withSingleInstance` seam is a no-op wrapper that still threads the lock
  callback through, and the post-run check confirms no `.sandcastle.lock`
  / `prd.json.lock` directory survives.
- **Iteration accounting.** `runLoop` returns exactly one
  `IterationResult` with `outcome === "shipped"` and `iterationsUsed: 1`.

## What the smoke does NOT prove

- **Real Claude inference.** Every per-role agent call goes through the
  `_agentRunner` seam, which returns canned assistant text. Bugs in prompt
  templates, model selection, or `claudeCode()` provider plumbing do not
  surface here.
- **Real Docker / Podman / Vercel sandboxing.** `_createSandbox` returns a
  stub `Sandbox` whose `run()` throws. Container startup, mount semantics,
  UID/GID alignment, worktree provisioning — all out of scope. (See
  `npm run smoke:integration` follow-up below.)
- **Real Postgres migrations.** `applyMigrationsBetween` short-circuits when
  `preSha === postSha`; the smoke fixture stays SQL-free so the call is a
  no-op. Real migration auto-apply (drizzle dispatch, psql classification)
  needs the integration smoke.
- **Track E recovery ladder.** Default smoke runs the green path. The mock
  supports a `failureMode: "implementer-halts"` flag to exercise the
  recovery branch; no smoke variant exercises it yet.
- **Real `gh` CLI behavior.** A `gh` PATH stub captures argv to a JSONL
  log; real `gh issue edit / close / comment` is never invoked. The stub
  exits 0 with empty stdout, so error paths in `gh.ts` aren't exercised.

## Concrete bugs the rewired smoke catches

The standalone smoke that shipped before FIX-4 would have been GREEN
against any of these regressions; the new runLoop-driven smoke catches all
of them:

1. Planner being called per-iteration instead of once per wake-up.
2. `claimViaLabel` being skipped (e.g. a refactor that bypasses the label
   transition and relies on prd.json status).
3. `markDoneViaLabel` calling `closeIssue` without a `--comment` summary.
4. The reviewer briefing dropping the issue body or shifting its byte
   offset relative to the implementer briefing (prompt-cache prefix break).
5. `runLoop` returning `[]` instead of one shipped result (queue-drain bug).
6. The startup recovery sweep failing to no-op on an empty in-progress list.

## Follow-up: integration smoke

A separate `npm run smoke:integration` (not yet wired) should:

1. Run against a real Docker sandbox using `docker()` with a tiny throwaway
   image.
2. Use a fresh GitHub repo with a single dummy issue.
3. Drive a real Claude call (Haiku) for the implementer to keep cost low.
4. Apply at least one drizzle migration end-to-end against a throwaway
   Postgres.

File a follow-up issue when the v1.1 surface is stable enough to support
it. Until then, the unit smoke + manual single-story rehearsal is the only
gate before overnight runs.
