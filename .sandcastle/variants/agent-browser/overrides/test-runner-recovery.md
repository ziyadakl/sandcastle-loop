- **If the issue spec's Acceptance section contains an `agent-browser`
  command sequence (or a legacy `playwright test` reference):** replay
  the sequence end-to-end (typically a script under `e2e/<feature>.sh`
  that runs `agent-browser open`, `snapshot`, `click @eN`, `fill`,
  `is visible`, `wait`, `get text`, etc., chained with `&&` so any
  non-zero exit aborts). Save the combined stdout+stderr to
  `/tmp/sandcastle-e2e-it{{ITERATION}}.log`. The verdict is the script's
  exit code plus a feature-relevant assertion line in the log
  (`is visible @eN` returning 0, a `get text` matching the expected
  value, or a `wait --url` confirming post-action navigation).
- **If no browser-check command in spec:** run `pnpm typecheck` (or
  `npm run typecheck`), plus any unit tests covering files added or
  modified in this iteration's diff (`pnpm vitest run <test-file>` for
  each new `*.test.ts`).
