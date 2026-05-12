# Smoke target fixture

Self-contained fake repo used by `tests/smoke/run-smoke.ts`. The smoke harness
copies this directory into a temp dir, runs `git init`, then drives the loop
against it with a fully-mocked sandbox.

Contains exactly one pending story (`smoke.1`) so a green run finishes in a
single iteration.

Do not edit by hand during a smoke run — `run-smoke.ts` operates on a copy in
`os.tmpdir()`. Edits to this template are picked up on the next invocation.
