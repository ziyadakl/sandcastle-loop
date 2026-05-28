# Variant note

This is the **minimal** variant — no browser stack, no Playwright. The
sandbox image ships Node, gh, git, jq, psql, and Claude Code; the project
itself is responsible for installing its own test runner via its package
manager (the `onSandboxReady` hook handles this). End-of-iteration proof
of work is the project's own test runner (pytest, npm test, cargo test,
go test, etc.) — auto-detected from the project's files. Do NOT attempt
Playwright or any browser-driven check.
