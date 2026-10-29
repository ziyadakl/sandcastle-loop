# Variant note

This is the **minimal** variant — no browser stack, no Playwright. The
sandbox image ships Node, gh, git, jq, psql, and Claude Code; the project
itself is responsible for installing its own test runner via its package
manager (the `onSandboxReady` hook handles this). End-of-iteration proof
of work is the project's own test runner (pytest, npm test, cargo test,
go test, etc.) — auto-detected from the project's files. Do NOT attempt
Playwright or any browser-driven check.

**The screen check does not exist under this variant.** Other prompts in
this loop describe a check-writer that authors a Playwright spec before you
start, and a harness that opens a real browser on your finished page and
decides from that run whether the work ships. **None of that can happen
here** — there is no browser to open and no Playwright to run one. Wherever
another prompt says "the harness will grade this after you exit", read it as
"nothing will": under this variant the project's own test runner is the only
evidence anyone gets, which is a deliberately weaker standard than the rest
of the prompts assume. Do not go looking for a check directory, and do not
treat its absence as a fault.
