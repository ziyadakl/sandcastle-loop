**Required artifacts.** Save the full test output to
`/tmp/sandcastle-test-it{{ITERATION}}.log`.

If the issue spec pins a specific runner command (`pytest …`, `npm test
…`, `pnpm test …`, `cargo test …`, `go test …`, `mvn test …`,
`bundle exec rspec …`, `mix test …`, etc.), run that exact command. If
the spec does NOT pin a command, detect the project's runner from its
files (`pyproject.toml` / `pytest.ini` → `pytest`, `package.json` with a
`"test"` script → `npm test` / `pnpm test` / `yarn test`, `Cargo.toml` →
`cargo test`, `go.mod` → `go test ./...`, `Gemfile` with rspec →
`bundle exec rspec`, `mix.exs` → `mix test`, `build.gradle` / `pom.xml` →
`./gradlew test` / `mvn test`, otherwise `make test` if a Makefile target
exists) and run the full suite:

```
set -o pipefail
<your-detected-test-command> 2>&1 | tee /tmp/sandcastle-test-it{{ITERATION}}.log | node .sandcastle/lib/bound-output.mjs
TEST_STATUS=${PIPESTATUS[0]}   # the runner's real exit code — NOT tee's, NOT the filter's
```

For example: `pytest 2>&1 | tee /tmp/sandcastle-test-it{{ITERATION}}.log | node .sandcastle/lib/bound-output.mjs`.

The `| node .sandcastle/lib/bound-output.mjs` stage is AFTER the tee, so it does
NOT violate the no-filtering rule below: `tee` still writes the FULL log the
reviewer reads, while the filter only bounds what appears in YOUR conversation
(head + tail, always keeping failure/summary lines). `set -o pipefail` +
`${PIPESTATUS[0]}` preserve the runner's REAL pass/fail — read it from
`$TEST_STATUS`, never from the filter's exit code.

**Do NOT attempt Playwright or any browser-driven check — this variant
has no browser stack.** If the spec's Acceptance literally says
"run playwright", that spec was authored for a different variant; HALT
with that as the reason.

**No filtering allowed between the runner and tee.** Run the command
EXACTLY as written above. Do NOT insert `| grep`, `| sed`, `| awk`,
`--quiet`, `-q`, `> /dev/null`, or any other output suppression before
the tee. The reviewer reads the resulting log to detect bail signals
(skipped tests, xfail-ed tests, fixture errors before assertions).
Filtering those signals out is a prompt-following failure — the
reviewer's check 8 will catch and reject the commit.
