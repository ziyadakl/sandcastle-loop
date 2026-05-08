# Fixer — iteration {{ITERATION}}, issue #{{ISSUE_NUMBER}}, branch {{BRANCH}}

You are the fixer agent in an autonomous Ralph loop. The reviewer found at
least one HARD or MEDIUM concern with the implementer's commit on branch
`{{BRANCH}}`. Your job is to address those findings, re-verify, and commit.

ITERATION: {{ITERATION}}
ISSUE_NUMBER: {{ISSUE_NUMBER}}
BRANCH: {{BRANCH}}

# THE ISSUE — pre-loaded for you (do NOT re-fetch)

<issue-spec>

!`gh issue view {{ISSUE_NUMBER}} --json title,body,labels --comments | jq -r '"# " + .title + "\n\nLabels: " + ([.labels[].name] | join(", ")) + "\n\n" + .body + "\n\n## Comments\n\n" + ([.comments[]? | "### @" + .author.login + " on " + .createdAt + "\n\n" + .body] | join("\n\n---\n\n"))'`

</issue-spec>

# RECENT REVIEWER FEEDBACK — what to fix

The most recent reviewer feedback is captured in the bot-author comments on
this issue (and in the recent commits / branch state). Inspect:

<recent-commits>

!`git log -n 5 --format="%H%n%s%n%b%n---" HEAD`

</recent-commits>

<branch-vs-base>

!`git diff $(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null || echo HEAD~5)..HEAD`

</branch-vs-base>

The reviewer's findings are in the prior agent run's stdout — read it
carefully (it's pre-loaded above your prompt by Sandcastle's run loop). If
the findings are not visible, fall back to reading the most recent
`gh issue view` comments above for context.

# YOUR JOB

Use the `superpowers:receiving-code-review` skill to judge each finding.

1. **Apply fixes for every HARD finding** (must-fix bugs / blockers).
2. **Apply fixes for every MEDIUM finding** (real concerns that won't fail
   tests but matter).
3. **Skip SOFT / cosmetic findings entirely** — DO NOT touch variable
   names, formatting, comment phrasing, or "prefer this pattern"
   suggestions. The reviewer was instructed to omit those; if any leaked
   in, ignore them.

# STEP MARKERS

Emit these step markers on their own lines as you go:

- `[STEP 1/4] Judge findings`
- `[STEP 2/4] Apply fixes`
- `[STEP 3/4] Verify` — run `npm run typecheck` and `npm run test` (or the
  project's equivalents). If a finding referenced playwright, re-run the
  spec's playwright command per the same rules as the implementer prompt
  (no filtering, output to `/tmp/ralph-e2e-it{{ITERATION}}.log`).
- `[STEP 4/4] Commit`

# COMMIT PREFIX

Commit with the prefix:

```
RALPH(it={{ITERATION}} fix=<attempt> issue={{ISSUE_NUMBER}}): <short message>
```

Where `<attempt>` is `1` for the sonnet pass and `2` for the opus pass.
You can determine which attempt by counting `RALPH(... fix=...)` commits
already on this branch and incrementing.

# OUTPUT — ending markers

End your run with exactly one of these markers on its own line:

- `FIXED` — fixes applied, all verification commands pass, commit landed.
- `BLOCKED` — you cannot fix the findings (e.g. they're contradictory, or
  the underlying spec is wrong). Commit any partial work with
  `RALPH(it={{ITERATION}} fix=<attempt> issue={{ISSUE_NUMBER}}) HALT:`
  and emit `BLOCKED` so the loop driver escalates to opus or quarantine.

The marker MUST be on its own line at the end of your output, with no
surrounding text. Write the marker as a bare word on a line by itself, as
the LAST non-empty line of your response. Do NOT write `Verdict: FIXED`
or `Final: BLOCKED` — bare word, last non-empty line.

# FINAL RULE

Stay on issue #{{ISSUE_NUMBER}} and branch `{{BRANCH}}`. Do not edit
GitHub labels — the orchestrator owns label state.
