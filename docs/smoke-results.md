# Smoke harness — what it proves, what it doesn't

The smoke harness lives at `tests/smoke/run-smoke.ts` and runs in under a
second. It exists to prove the wiring of the rebuilt loop is correct without
ever calling Claude or starting a container.

## How to run

```sh
npm run smoke
```

Exits 0 on PASS, 1 on assertion failure, 2 on uncaught error.

## What the smoke proves

- **Contracts compile.** Every production module the smoke imports
  (`src/types.ts`, `src/state/`, `src/verdicts/`) ships its declared exports
  and the smoke's strict-TS imports resolve.
- **Verdict parsing works end-to-end.** The mock sandbox emits assistant text
  containing a JSON payload terminated by a bare-word marker (`STORY_COMPLETE`,
  `ALL_CLEAR`). Track B's `parseVerdict` is run against the real Zod schemas;
  any drift between `src/types.ts` and `src/verdicts/schemas.ts` surfaces here.
- **State mutates atomically.** `pickNextEligibleStory` claims `smoke.1`,
  then `markDone` flips it to `done` and appends to `progress.txt`. The
  assertions reread `prd.json` from disk to catch any in-memory-only mutation.
- **Locks are released.** No `prd.json.lock` directory survives the run.
- **Single-instance gate works.** The harness wraps the run in
  `withSingleInstance`; if a second copy of the smoke ran concurrently it
  would hit `ELOCKED` rather than corrupt state.
- **Ship path converges.** A green-path run produces at least one commit on
  the fixture branch, fires `gh issue close 999`, and records the agent call
  order `implementer -> reviewer`.

## What the smoke does NOT prove

- **Real Claude inference.** The mock returns canned text. Bugs in the
  prompt templates, model selection, or sandcastle's `claudeCode()` agent
  provider will not be caught here.
- **Real Docker / Podman / Vercel sandboxing.** The mock `SandboxProvider`
  is a `bind-mount` shape with a no-op `exec()`. Container startup, mount
  semantics, UID/GID alignment — all out of scope.
- **Postgres migrations / Track E recovery ladder.** The default smoke runs
  the green path. The mock supports a `failureMode: "implementer-halts"` flag
  to exercise the recovery branch, but no smoke variant invokes it yet.
- **GitHub CLI behavior.** A `gh` PATH stub captures argv to a JSONL log;
  the real `gh issue close` is never invoked.

## Follow-up: integration smoke

A separate `npm run smoke:integration` (not yet wired) should:

1. Run against a real Docker sandbox using `noSandbox()` is not enough —
   needs `docker()` with a tiny throwaway image.
2. Use a fresh GitHub repo with a single dummy issue.
3. Drive a real Claude call (Haiku) for the implementer to keep cost low.

File a follow-up issue when the loop integration is stable enough to support
it. Until then, the unit smoke + manual single-story rehearsal is the only
gate before overnight runs.

## Modes

`run-smoke.ts` runs in one of two modes depending on what Track C has shipped:

- **standalone** (default fallback): when `src/loop/index.ts` is missing or
  doesn't export `runLoop`, the harness drives the mock directly through
  `pickNextEligibleStory -> mock.runAgent(implementer) -> mock.runAgent(reviewer)
  -> markDone -> closeIssue`. Validates everything except the loop's own
  iteration accounting and quarantine bookkeeping.
- **runLoop**: when Track C exports
  `runLoop({ config, runAgent }): Promise<unknown>` from
  `src/loop/index.ts`, the harness invokes that directly and the standalone
  driver is bypassed. The same assertions apply — they're decoupled from the
  driver path.

The mode is logged at the start of the run.

## Coordination requests

- **Track C (loop):** please expose a `runAgent` (or `sandboxFactory`)
  parameter on `runLoop` so the smoke can inject the mock without monkey-
  patching the module graph. See the `RunLoopShape` interface in
  `tests/smoke/run-smoke.ts`.
- **Track D (state):** `markDone` is currently imported from
  `src/state/prd.ts` directly because it isn't re-exported from
  `src/state/index.ts`. Consider adding it to the barrel for consistency
  with `claimStory` / `pickNextEligibleStory`.
