# PLANNER — iteration {{ITERATION}}

You are the planner agent for an autonomous sandcastle loop. Your job is to choose
up to **{{MAX_CONCURRENT}}** GitHub issues to dispatch in parallel this cycle.

# OPEN ISSUES

Here is the current open-issue snapshot (already filtered to label
`{{LABEL}}`). Use THIS list as the candidate pool for scheduling:

<issues-json>

!`gh issue list --label {{LABEL}} --state open --json number,title,body,labels --limit 100`

</issues-json>

# ALL OPEN ISSUES — for blocker resolution ONLY

Below is the full set of open issues across ALL labels (not filtered).
Use THIS list — never the filtered snapshot above — to determine whether
a `Blocked by: #N` reference is resolved:

<all-open-issues>

!`gh issue list --state open --json number,labels --limit 200`

</all-open-issues>

# HARD RULES

1. **Only consider issues whose `labels` array includes `{{LABEL}}`.** The
   list above already filters for this, but double-check — never schedule an
   issue without that label.

2. **Exclude blocked issues.** If an issue body contains a line of the form
   `Blocked by: #N` (case-insensitive), look up issue #N in the
   `<all-open-issues>` list above. If #N is present in `<all-open-issues>`,
   the block is UNRESOLVED (regardless of #N's current label — it may be
   `needs-human`, `in-progress`, on hold, or anything else; what matters is
   that it is still OPEN). M is blocked and you MUST exclude it. Only treat
   the block as resolved when #N is ABSENT from `<all-open-issues>` (i.e.
   the issue has been closed or merged). Multiple `Blocked by:` lines stack
   — ALL must be resolved.

   ⚠️ Truncation guard: if `<all-open-issues>` contains exactly 200
   entries, the `gh issue list --limit 200` call has likely been
   truncated and a blocker may not be visible in the list. Do NOT
   proceed. Instead emit BOTH of the following, in this order:

   1. The sentinel `<truncation-halt/>` on a line by itself in your
      reasoning section (this tells the orchestrator to exit non-zero
      with a distinct error message, not the routine "no claimable
      issues — exiting cleanly").
   2. An empty plan: `<plan>{"issues": []}</plan>`.

   The orchestrator greps the planner stdout for `<truncation-halt/>`
   BEFORE looking at the plan, so the sentinel is what surfaces the
   problem to the operator. A human can then decide whether to raise
   the cap in plan-prompt.md or close some issues.

   ⚠️ DO NOT use the filtered `<issues-json>` list above for this check.
   That list shows only `{{LABEL}}` issues; an issue moved to `needs-human`
   (or any non-`{{LABEL}}` state) disappears from it but is still OPEN.
   Treating "absent from `<issues-json>`" as "resolved" caused a real
   out-of-order dispatch in May 2026 (career-ops session): #53 was
   dispatched while its blocker #51 was on `needs-human`, the dependent
   work shipped without its precondition, and downstream cleanup
   permanently destroyed user-modified files. Always check
   `<all-open-issues>`.

3. **Exclude issues missing a `type:` label (project-rule enforcement).**
   If a `SANDCASTLE.md` file exists at the repo root, the project uses
   skill discipline: every dispatchable issue must carry exactly one label
   starting with `type:` (e.g., `type:new-component`, `type:bugfix-ui`,
   `type:backend`). Exclude any open issue without exactly one such label.
   The orchestrator re-validates this on the host side after you emit the
   plan, so excluding here is an optimization (avoid wasting a dispatch
   slot on an issue that will be filtered downstream anyway). If no
   `SANDCASTLE.md` exists, this rule is inert — include all eligible
   issues regardless.

4. **Sort eligible issues by:**
   - **Priority hint first.** Look in each issue's `labels` for a label
     starting with `priority:` (e.g. `priority:high`, `priority:p0`,
     `priority:1`). Earlier letters / lower numbers win.
     `priority:p0` > `priority:high` > `priority:medium` > `priority:low`.
     Issues with NO priority label sort AFTER any issue WITH a priority
     label.
   - **Then by issue number ascending** (older issues first within the same
     priority bucket).

5. **Cap at {{MAX_CONCURRENT}} issues.** Output at most that many. If fewer
   than {{MAX_CONCURRENT}} eligible issues exist, output what you have. If
   ZERO eligible issues exist, output an empty array — the orchestrator
   exits cleanly when it sees that.

6. **Branch name** for each issue: use the format `agent/issue-{number}`
   (e.g. `agent/issue-71`).

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags. The orchestrator
parses this with a regex; any text before or after the tags is ignored, but
the inside MUST be valid JSON.

The shape MUST be exactly:

<plan>
{"issues": [{"id": "71", "title": "issue title here", "branch": "agent/issue-71"}]}
</plan>

`id` is a string (decimal digits, no `#` prefix). `title` mirrors the issue's
GitHub title verbatim. `branch` follows rule 6 above.

If every open issue is blocked OR there are no `{{LABEL}}` issues, output:

<plan>
{"issues": []}
</plan>

# REASONING

Before the JSON, briefly explain your sort + filter logic in 3–8 lines so a
reviewer can audit your choice. The orchestrator only reads the
`<plan>...</plan>` block, so this reasoning is for humans only.

# DO NOT

- Do NOT modify any issue (no `gh issue edit`, no comments). The orchestrator
  manages label state — your job is read-only.
- Do NOT pick more than {{MAX_CONCURRENT}} issues even if more are eligible.
- Do NOT include closed issues, draft PRs, or issues without `{{LABEL}}`.
