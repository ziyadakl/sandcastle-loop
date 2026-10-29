Reference project-side files for the loop's contract tests.

The loop reads a few facts out of the PROJECT's own browser-test helpers (the
sentinel lines its graded-screen helper prints, the env variable naming the
grade-mark file, the database name its global setup reports, the timeouts its
Playwright and vitest configs set). Those helpers live in the project, not in
this template, so the contract tests read these small reference copies
instead: they are what a project's helpers must carry for the loop to read
their output. If you change a sentinel in lib/harness/verdict.ts, change it
here and in your project's helper together.
