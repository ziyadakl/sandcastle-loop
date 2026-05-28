# EVIDENCE QUOTE — STRICT verification of the certification's `e2eAssertionLine` field

The quoted line MUST satisfy ALL of:

- Non-empty AND not the literal placeholder `<paste line>` or
  `<the quoted line>`.
- Is one of:
  - an `agent-browser is visible @eN` / `is enabled @eN` / `is checked
    @eN` line whose script-context shows it returned 0,
  - an `agent-browser get text @eN` line whose stdout equals the value
    the story spec expects (the spec's expected text must appear on a
    nearby line in the log too),
  - an `agent-browser wait --url "<pattern>"` line where the pattern
    matches the URL the feature should navigate to, OR
  - a snapshot fragment (e.g. `button "Save changes" [ref=e7]`) showing
    the element the story spec describes is present in the rendered
    page.
- Actually appears in `/tmp/sandcastle-e2e-it{{ITERATION}}.log`.
- Is NOT any of these forbidden generic lines:
  - empty or whitespace-only line
  - the snapshot tree's preamble/header lines (e.g. `Page snapshot:`,
    `URL: ...`, `Title: ...`) without a referenced element
  - a bare URL line (e.g. `http://localhost:3000/foo` on its own)
  - the literal placeholder `<paste line>` or `<the quoted line>`
  - bare `ok` / `done` / `success` lines from the implementer's own
    `echo` statements without any agent-browser output context above
  - the `[ref=e1]` portion alone with no element name or role
  - a `snapshot` invocation line (the command itself, not its output)

If ANY of the above fails, emit:

> HARD: certification evidence is fabricated, generic, or doesn't prove
> the assertion targeted the feature. `<paste the offending line and
> the rule it violated>`.
