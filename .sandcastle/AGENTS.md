# Agent standing instructions (Sandcastle loop)

You are running as an agent backend inside the autonomous Sandcastle loop.
Each run hands you a per-phase prompt (implementer, reviewer, critique,
recovery, merge, planner, post-merge review/fix). That prompt is the
source of truth for what to do. The notes below are standing reminders
about how the loop reads your output — they supplement the per-run
prompt and never override it.

## Output contract

- **Terminal marker on the FINAL line.** Most phases end by emitting a
  bare terminal marker — e.g. `ALL_CLEAR`, `HAS_BLOCKERS`,
  `CRITIQUE_CLEAN` / `CRITIQUE_NEEDS_FIXES` / `CRITIQUE_CRITICAL`,
  `RECOVERY_COMPLETE`, `POST_MERGE_ALL_CLEAR` / `POST_MERGE_ISSUES_FOUND`,
  `POST_MERGE_FIX_COMPLETE`, `<promise>HALT</promise>`,
  `<promise>COMPLETE</promise>`, or `STORY_COMPLETE`. The orchestrator
  reads the marker off the **last non-empty line** of your output. Emit it
  as the literal final line and write **nothing after it** — no summary,
  no signoff, no follow-up question, no closing code fence.

- **Marker is bare, on its own line.** Don't wrap the marker in backticks,
  bold, quotes, or extra prose on the same line. A reasoning/findings
  section comes *before* the marker, never after.

- **JSON verdict envelope, when the prompt asks for one.** Some phases
  (e.g. the implementer) require a fenced ```json``` verdict envelope.
  When a prompt asks for it, emit the envelope **immediately before** the
  terminal marker, then the marker. Do not place narration or a trailing
  code fence between the envelope and the marker that would become the
  last line.

- **The per-run prompt's exact ordering always wins.** If a phase prompt
  specifies a precise end-of-output sequence (for example, a JSON envelope,
  then `STORY_COMPLETE`, then `<promise>COMPLETE</promise>`), follow that
  sequence verbatim. These reminders describe the general rule; the prompt's
  specific instructions are authoritative wherever they differ.

## A couple of phases are NOT marker-last

- The **planner** output is parsed by locating a `<plan>...</plan>` block
  (and an optional `<truncation-halt/>` sentinel), not by reading the last
  line. Follow the planner prompt's format exactly; text outside the tags
  is ignored.

Keep output clean and ordered as the prompt specifies, and the loop will
parse every phase correctly.

## Skill discipline — how to "invoke" a skill on this backend

Some phases (notably the implementer) run under **skill discipline**: the
prompt carries a per-issue list of required design principles, rendered as
`REQUIRED SKILLS for this issue: ...`, and tells you to "invoke
`Skill('<name>')`" for each one before writing code.

**You have no `Skill` tool.** That instruction is written for the Claude
backend. On this backend the equivalent — and the *only* thing the host's
skill-discipline gate actually counts — is to **shell-read the skill's rubric
file**:

- `.claude/skills/<name>/SKILL.md` in the repo (project-local principles), or
- `~/.claude/skills/<name>/SKILL.md` (cross-project principles).

Read it with a normal shell command — `cat`, `sed -n '1,200p'`, `head`, etc.
Prefer the repo-local path; fall back to the `~` path when the repo doesn't
ship that skill. **That file-read IS the invocation.** It loads the rubric into
your context so you can apply it, *and* it satisfies the gate, which detects the
`skills/<name>/SKILL.md` path in your shell command. There is no other way to
register a skill use here — invoking `Skill(...)` does nothing.

So whenever the required-skills list is non-empty, before you touch code, for
EVERY name in that list:

1. **Shell-read its `SKILL.md`** (repo-local path first, then the `~` path).
   This read is mandatory and counted. Skipping any required skill quarantines
   the slice with `skill-discipline-fail` — no critique, no merge, no recovery.
2. **Apply the rubric to the work.** A critique pass grades your diff against
   the same rubrics, so a ritual read that doesn't shape the code still fails
   review.

This gate is **per-attempt**: on every retry pass, re-read each required skill
before writing code — the host counts only the reads from the current attempt.
If the required-skills list is empty, skip this section entirely.
