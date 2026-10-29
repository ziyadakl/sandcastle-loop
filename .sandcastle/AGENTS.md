# Agent standing instructions (Sandcastle loop)

You are running as an agent backend inside the autonomous Sandcastle loop.
Each run hands you a per-phase prompt (implementer, reviewer,
recovery, merge, post-merge review/fix). That prompt is the
source of truth for what to do. The notes below are standing reminders
about how the loop reads your output — they supplement the per-run
prompt and never override it.

## Output contract

- **Terminal marker on the FINAL line.** Most phases end by emitting a
  bare terminal marker — e.g. `ALL_CLEAR`, `HAS_BLOCKERS`,
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

## There is no planner phase

Choosing which tickets to work is not an agent's job and has not been one
since 2026-09-03. The host computes the eligible set, ranks it and caps it
in code (`planDeterministic`, `lib/state/eligible-set.ts`). If you are ever
handed something that looks like a planning prompt, that is a bug — say so
rather than inventing a plan.

Keep output clean and ordered as the prompt specifies, and the loop will
parse every phase correctly.

## Skill discipline — how to "invoke" a skill on this backend

Some phases (notably the implementer) run under **skill discipline**: the
prompt carries a per-issue list of required design principles, rendered as
`REQUIRED SKILLS for this issue: ...`, and tells you to "invoke
`Skill('<name>')`" for each one before writing code.

**You have no `Skill` tool.** That instruction is written for the Claude
backend. On this backend the equivalent — and the *only* thing the host's
skill record captures — is to **shell-read the skill's rubric
file**:

- `.claude/skills/<name>/SKILL.md` in the repo (project-local principles), or
- `~/.claude/skills/<name>/SKILL.md` (cross-project principles).

Read it with a normal shell command — `cat`, `sed -n '1,200p'`, `head`, etc.
Prefer the repo-local path; fall back to the `~` path when the repo doesn't
ship that skill. **That file-read IS the invocation.** It loads the rubric into
your context so you can apply it, *and* the host records it, detecting the
`skills/<name>/SKILL.md` path in your shell command. There is no other way to
register a skill use here — invoking `Skill(...)` does nothing.

So whenever the required-skills list is non-empty, before you touch code, for
each skill:

1. **Shell-read its `SKILL.md`** (repo-local path first, then the `~` path).
2. Apply its guidance in the diff — the reviewer grades the diff against the
   same principles.

Nothing stops a ticket over a skipped read: the record is shown
to the reviewer as information, and the diff is what is graded.

If the required-skills list is empty, skip this section entirely.
