Run the project's typecheck/lint and its test runner — auto-detect from
project files:

- `pyproject.toml` / `pytest.ini` → `pytest` (and `mypy` / `ruff check`
  if configured)
- `package.json` with `"test"` script → `npm test` / `pnpm test` /
  `yarn test` (and `tsc --noEmit` if configured)
- `Cargo.toml` → `cargo test` (and `cargo check`)
- `go.mod` → `go test ./...` (and `go vet ./...`)
- `Gemfile` with rspec → `bundle exec rspec`
- `mix.exs` → `mix test`
- `build.gradle` / `pom.xml` → `./gradlew test` / `mvn test`
- Otherwise: `make test` if a Makefile target exists, else the command
  the project's CI config (`.github/workflows/*.yml`, `.gitlab-ci.yml`)
  runs.

The minimal variant has no browser stack — do NOT attempt Playwright,
`npx playwright test`, or any browser-driven check. If the spec's
Acceptance literally says "run playwright", that spec was authored for a
different variant; HALT with that as the reason.
