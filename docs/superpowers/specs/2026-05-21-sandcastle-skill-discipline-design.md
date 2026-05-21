# Sandcastle Skill Discipline — Design

## Problem

For ~15 days (since May 6, 2026), every autonomous-loop run has worked without project-specific design guidance. The Ralph-loop refactor on May 5 left design rules as placeholders that were never wired up; the May 9 sandcastle adoption replaced them entirely with a stock template that has zero references to UI/design skills, CLAUDE.md, or `.claude/skills/`.

Result: finance pages in affinity-tracker shipped with solid backgrounds where glassmorphism was the project's documented standard. The agent had no way to know.

Verified with `git log -S "glass"` and `grep -rE "claude\.md|\.claude/skills|design|impeccable|glass|ui-ux" .sandcastle/`: zero hits across the full git history of the template.

## Constraints

The user is non-technical. The fix cannot rely on technical-user attention patterns (noticing stuck tickets, debugging logs, reading agent transcripts).

The fix must:
- Be project-agnostic in the template (no hardcoded glassmorphism)
- Survive `/sandcastle-update` (project's rules can't be overwritten)
- Not bloat CLAUDE.md (which loads on every interactive session)
- Be enforced by code, not by exhortation (lazy agents skip exhortation)
- Allow different skill sets for different categories of work

## Architecture

Five moving parts:

1. **`SANDCASTLE.md`** at the project root. User-authored. Lists work-type categories and the skills each category requires. Project owns this file. `/sandcastle-update` never touches it.

2. **`/triage+skills`** — user's own wrapper skill at `~/.claude/skills/triage-plus-skills/SKILL.md`. Invokes Matt Pocock's `/triage` skill underneath, then adds the right `type:` labels (and any opt-in `tool:` labels) to each ticket triaged. Auto-inherits Matt's updates because it delegates instead of forking.

3. **Sandcastle queue selector** — refuses to dispatch any ticket missing a `type:` label. Status output flags "waiting on label." Applies to all categories (backend tickets need `type:backend`, tests need `type:tests`, etc.) — keeps the selector simple by not requiring it to infer ticket type from body. Backstop in case `/triage+skills` was skipped.

4. **Sandcastle implementer** — STEP 0 of the building agent: read SANDCASTLE.md, find the section matching this ticket's `type:` label, invoke every required tool plus any tools matching `tool:X` labels. THEN do the actual code work.

5. **Sandcastle reviewer** — gets a host-computed list of `Skill()` tool calls the building agent actually invoked (extracted from the SDK transcript by the driver). Compares to SANDCASTLE.md's required list for this ticket's category. Missing required skills → HAS_BLOCKERS.

The two host-side enforcement points (queue selector refusing unlabeled tickets, driver extracting real skill invocations) are what makes this stick. Everything else is exhortation.

## SANDCASTLE.md format

```
# SANDCASTLE.md

## Category labels and required tools

### type:new-component
Building a brand-new component, page, or widget from scratch.
Required:
- impeccable (load design context — prerequisite for all design skills)
- layout (composition and spacing)
- clarify (microcopy)
- polish (final pass)
- glass-morphism (default card styling)
Opt in via `tool:` labels on the ticket:
- tool:bento → magic-bento (interactive cards with effects)
- tool:widget → new-widget (dashboard widget patterns)
- tool:audit → audit (technical quality report — invokes act-on-findings step)
- tool:critique → critique (design review with sub-agent personas — invokes act-on-findings step)

### type:visual-enhance
Improving look/feel of existing UI without changing behavior.
Required:
- impeccable
- polish
Opt in (pick whichever applies):
- bolder, quieter, colorize, typeset, delight
- tool:audit, tool:critique

### type:polish-pass
Dedicated quality push before ship. No new features.
Required:
- impeccable, polish, distill
Opt in:
- tool:audit, tool:critique

### type:bugfix-ui
Fixing broken UI behavior. Visual design stays the same.
Required:
- impeccable, harden
Opt in:
- tool:critique

### type:performance-ui
Making the UI faster. No visual change.
Required:
- impeccable, optimize
Opt in:
- tool:audit

### type:responsive-fix
Layout problems on specific screen sizes.
Required:
- impeccable, adapt
Opt in:
- tool:audit

### type:accessibility
Standalone a11y work.
Required:
- impeccable, harden
Opt in:
- tool:audit (recommended for this category — strong default)

### type:add-motion
Adding animations or transitions to existing UI.
Required:
- impeccable, animate
Opt in:
- overdrive (shader-level, max-ambition motion)
- tool:critique

### type:tests
Pure test additions. No production code.
Required: (none)

### type:backend
Server, database, services, migrations, notifications.
Required:
- simplify

### type:cleanup
Removing dead code or dev-only data.
Required: (none)
```

### Opt-in mechanism

Strict-label opt-ins (`tool:X` on the ticket): `magic-bento`, `new-widget`, `audit`, `critique`. These are expensive, project-specific, or report-producing — the agent should never invoke them unilaterally. Loop only fires them if the matching `tool:` label is present.

Prose opt-ins (listed in SANDCASTLE.md, agent decides per ticket): `bolder`, `quieter`, `colorize`, `typeset`, `delight`, `overdrive`. Lower cost, more about aesthetic fit — agent reads the ticket and picks applicable ones.

### Act-on-findings rule

When the agent invokes `audit` or `critique` (because `tool:audit` or `tool:critique` is on the ticket), the implementer prompt requires a follow-up: the agent must read the findings/report and apply fixes for any P0/P1 issues before declaring done. Reviewer verifies by reading the audit/critique output in the transcript and confirming the diff resolves the flagged items.

### Skills explicitly excluded from autonomous use

- `shape` — runs an interactive discovery interview (Phase 1: "Ask these questions in conversation... STOP and call the AskUserQuestion tool"). Not invokable autonomously. The ticket spec from triage serves as the design brief.

### Graceful degradation

- No SANDCASTLE.md → loop works as today, queue selector does NOT require `type:` labels (no rules to enforce).
- SANDCASTLE.md exists, ticket has `type:` label, but no matching section in SANDCASTLE.md → loop treats as "no rules apply," dispatches normally.
- SANDCASTLE.md exists but ticket has NO `type:` label → queue selector holds ticket in "waiting on label" state until labeled.
- SANDCASTLE.md references a skill that isn't installed in `.claude/skills/` → ticket goes to `needs-human` for the user to fix the config.

The "no SANDCASTLE.md = no label requirement" rule means existing projects without this fix continue to work unchanged. Adding SANDCASTLE.md is the opt-in.

### Multiple `type:` labels on one ticket

Treated as a configuration error. The ticket goes to `needs-human` so the user can resolve which category applies.

## `/triage+skills` wrapper skill

Lives at `~/.claude/skills/triage-plus-skills/SKILL.md`. User-owned, Syncthing'd to VPS.

Contract:
1. Invoke `Skill(skill="triage")` to run Matt's existing flow.
2. After triage finishes, list the tickets touched in this session.
3. For each UI ticket missing a `type:` label: suggest one based on title + body. User approves or changes via interactive prompt.
4. For each `type:new-component` ticket: ask whether `tool:bento` or `tool:widget` should be added. User answers per ticket.
5. Apply labels via `gh issue edit` and report what was set.

Does NOT:
- Second-guess pre-existing labels.
- Touch tickets outside this session's triage scope.

When Matt updates `/triage`, the wrapper automatically picks up the new behavior because step 1 delegates by name.

## Sandcastle loop changes (this repo)

### Files to modify

| File | Change |
|------|--------|
| `.sandcastle/plan-prompt.md` | Queue selector: refuse to dispatch any ticket missing a `type:` label. Output "waiting on label" for each such ticket. (Requiring the label on all tickets — including backend/tests/cleanup — keeps the selector simple: it never has to infer "is this UI" from issue body.) |
| `.sandcastle/implement-prompt.md` | STEP 0 (before any code work): read SANDCASTLE.md, classify by `type:` label, output `<skill-plan>` block, invoke required tools, then proceed. |
| `.sandcastle/review-prompt.md` | New ground-truth field `SKILLS_INVOKED: [...]` parallel to existing `SPEC_REQUIRES_PLAYWRIGHT` / `COMMIT_TOUCHED_UI`. Reviewer must quote required tools from SANDCASTLE.md, compare to `SKILLS_INVOKED`, emit `HAS_BLOCKERS` on missing. |
| `.sandcastle/post-merge-review-prompt.md` | Same enforcement as `review-prompt.md` for multi-issue rollup. |
| `.sandcastle/post-merge-fix-prompt.md` | Read SANDCASTLE.md before fixing. Re-invoke required skills. |
| `.sandcastle/recovery-prompt.md` | Read SANDCASTLE.md before recovery. Re-invoke required skills. |
| `.sandcastle/main.mts` | Wire `onAgentStreamEvent` callback in the `logging` config of each `sandcastle.run()` / `handle.run()` call. Filter events where `type === "toolCall" && name === "Skill"`. Collect the skill names from `formattedArgs`. Inject as `SKILLS_INVOKED` field into reviewer + post-merge-review + post-merge-fix prompts. SDK type ref: `node_modules/@ai-hero/sandcastle/dist/AgentStreamEmitter.d.ts`. |

### Files NOT in this repo (separate handoffs)

- `~/.claude/skills/sandcastle-init/SKILL.md` — scaffold an empty SANDCASTLE.md when initializing a new project.
- `~/.claude/skills/sandcastle-update/SKILL.md` — add explicit "never touch root SANDCASTLE.md" guard.
- `~/.claude/skills/triage-plus-skills/SKILL.md` — NEW.

## Failure handling

Skill-discipline rejections use the existing 3-attempt retry budget:

1. Reviewer rejects with explicit feedback: "Required: X, Y, Z. Invoked: X, Y. Missing: Z."
2. Implementer retries on the same branch, prior commits intact, with feedback in the prompt.
3. Up to 3 attempts. After 3, ticket goes to `needs-human`.

Rebuttal mechanism is narrowed for skill-discipline failures: the host-extracted invocation list is hard evidence, not opinion. The only legitimate rebuttal is "this skill doesn't exist in `.claude/skills/`" — which routes to `needs-human` so the user can fix SANDCASTLE.md or install the missing skill.

Over-invoking extra tools is fine. Only under-invoking gets rejected.

## Migration path for affinity-tracker

In order:

1. Land template-side changes in this repo. Push to origin.
2. On VPS, run `/sandcastle-update` in affinity-tracker. Pulls the new prompts + driver.
3. Write SANDCASTLE.md at `affinity-tracker/SANDCASTLE.md` using the format above.
4. Delete the "Before any UI/design work, read .impeccable.md" line from `affinity-tracker/CLAUDE.md`.
5. Add `~/.claude/skills/triage-plus-skills/SKILL.md` on the Mac. Syncthing carries to VPS.
6. Re-label any tickets currently in the ready-for-agent queue with new `type:` labels.

After step 6, the loop runs with discipline enforcement. First rejection shows the receipts.

## Decisions made during brainstorming

| Question | Decision |
|----------|----------|
| Granularity of skill prescriptions | Buckets by work type (not blanket checklist, not freeform menu) |
| Who labels tickets | `/triage+skills` wrapper + sandcastle queue backstop |
| Scope of rules file | Broader project discipline (not UI-only) — named `SANDCASTLE.md` |
| Categories | 11 buckets: new-component, visual-enhance, polish-pass, bugfix-ui, performance-ui, responsive-fix, accessibility, add-motion, tests, backend, cleanup |
| `shape` skill in autonomous use | EXCLUDED — interactive, requires human answers. Ticket spec serves as brief instead. |
| `audit` and `critique` defaults | Opt-in via `tool:audit` / `tool:critique` labels. Expensive (sub-agents) + report-producing — not default. |
| `impeccable` placement | Required in every UI-touching category — it's an implicit prerequisite for all design skills. |
| Strict-label opt-ins | `tool:bento`, `tool:widget`, `tool:audit`, `tool:critique` |
| Prose opt-ins | `bolder`, `quieter`, `colorize`, `typeset`, `delight`, `overdrive` |
| Act-on-findings rule | When `audit`/`critique` is invoked, implementer must fix P0/P1 findings before declaring done. Reviewer verifies. |
| Enforcement | Host-extracted Skill tool calls via SDK's `onAgentStreamEvent` (toolCall events), as reviewer ground-truth |
| Retry behavior | Same 3-attempt budget as today |

## Implementation risks flagged during grilling

- **impeccable's post-update-cleanup quirk:** the impeccable SKILL.md contains a `<post-update-cleanup>` block instructing the agent to run a cleanup script and then delete the block from the file. First autonomous invocation after an impeccable update will fire this side effect once. The implementer prompt should be aware of this and not fail/loop on it. (Once the block is gone after the first run, it stays gone until the next impeccable update.)

- **Token budget per ticket:** every UI ticket now loads impeccable + 2-5 other skills + SANDCASTLE.md + issue spec. Existing review-prompt comment notes 116k token crashes have happened. Risk that complex `type:new-component` tickets push past context limits. Mitigation already in the design: `audit`/`critique` are opt-in (the most context-heavy skills). Further mitigation if needed: bound SANDCASTLE.md content read at ~5KB.

## Open follow-ups (out of scope for this design)

- Optional GitHub Action to auto-suggest `type:` labels on issue creation (server-side, can't be skipped). Defer until backstop proves leaky.
- Broaden dirty-check in main.mts preflight to all `.sandcastle/*.ts` files (carry-over from prior session).
- Mirror dirty-check inside `/sandcastle-update` skill (carry-over).
