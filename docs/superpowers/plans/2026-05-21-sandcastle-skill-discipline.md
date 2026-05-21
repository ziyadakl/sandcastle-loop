# Sandcastle Skill Discipline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add code-enforced design-skill discipline to the sandcastle autonomous loop, so projects with a `SANDCASTLE.md` file get their stated required-skill list invoked automatically and verified by host-extracted tool-call evidence.

**Architecture:** Capture every `Skill()` tool call from the SDK's agent stream into a per-implementer `SKILLS_INVOKED` list. Inject that list as a host-computed ground-truth field in the reviewer / post-merge-review / post-merge-fix prompts. Add a `type:` label filter to the planner output. Update five agent prompts to read `SANDCASTLE.md` and act on it.

**Tech Stack:** TypeScript (`.mts`), Vitest 4.x, `@ai-hero/sandcastle` SDK.

**Scope:** Template-side changes only (`.sandcastle/*` in this repo). The three sibling handoffs — modifying `~/.claude/skills/sandcastle-init/SKILL.md`, `~/.claude/skills/sandcastle-update/SKILL.md`, and creating `~/.claude/skills/triage-plus-skills/SKILL.md` — are out of scope for this plan and tracked separately in the spec.

---

## File Structure

**Modify:**
- `.sandcastle/main.mts` — add `collectSkillInvocations()` helper, wire `onAgentStreamEvent`, validate planner output for `type:` labels, inject `SKILLS_INVOKED` into 3 prompt call sites
- `.sandcastle/plan-prompt.md` — add rule excluding tickets without `type:` labels
- `.sandcastle/implement-prompt.md` — add STEP 0 (read SANDCASTLE.md, invoke required skills)
- `.sandcastle/review-prompt.md` — add `SKILLS_INVOKED` ground-truth section + skill-discipline check
- `.sandcastle/post-merge-review-prompt.md` — same `SKILLS_INVOKED` ground-truth + check
- `.sandcastle/post-merge-fix-prompt.md` — read SANDCASTLE.md before fixing, re-invoke required skills
- `.sandcastle/recovery-prompt.md` — read SANDCASTLE.md before recovery, re-invoke required skills

**Create:**
- `tests/skill-discipline.test.ts` — unit tests for `collectSkillInvocations()` and plan-label validation

---

## Task 1: Add `collectSkillInvocations` helper (TDD red)

**Files:**
- Modify: `.sandcastle/main.mts` (append helper near other helpers, before `runImplementer`)
- Create: `tests/skill-discipline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/skill-discipline.test.ts`:

```typescript
/**
 * Tests for skill-discipline enforcement: per-implementer collection of
 * `Skill()` tool-call invocations from the SDK agent stream, used as
 * host-computed ground truth for the reviewer.
 */
import { describe, it, expect } from "vitest";
import { collectSkillInvocations } from "../.sandcastle/main.mjs";

describe("collectSkillInvocations", () => {
  it("returns a collector with empty list before any events", () => {
    const c = collectSkillInvocations();
    expect(c.invoked).toEqual([]);
  });

  it("appends the skill name when a Skill toolCall fires", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: 'skill: "glass-morphism"',
      iteration: 1,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual(["glass-morphism"]);
  });

  it("ignores non-Skill tool calls", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "toolCall",
      name: "Bash",
      formattedArgs: 'command: "ls"',
      iteration: 1,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual([]);
  });

  it("ignores text events", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "text",
      message: "hello",
      iteration: 1,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual([]);
  });

  it("preserves invocation order", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: 'skill: "impeccable"',
      iteration: 1,
      timestamp: new Date(),
    });
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: 'skill: "layout"',
      iteration: 2,
      timestamp: new Date(),
    });
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: 'skill: "polish"',
      iteration: 3,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual(["impeccable", "layout", "polish"]);
  });

  it("parses skill names from different formattedArgs shapes", () => {
    const c = collectSkillInvocations();
    // Shape with single quotes
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: "skill: 'critique'",
      iteration: 1,
      timestamp: new Date(),
    });
    // Shape with backticks (some SDKs)
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: "skill: `audit`",
      iteration: 2,
      timestamp: new Date(),
    });
    expect(c.invoked).toEqual(["critique", "audit"]);
  });

  it("falls back to raw args when parsing fails", () => {
    const c = collectSkillInvocations();
    c.onEvent({
      type: "toolCall",
      name: "Skill",
      formattedArgs: "unrecognized-format",
      iteration: 1,
      timestamp: new Date(),
    });
    // Should record SOMETHING so the reviewer sees it, not silently drop
    expect(c.invoked).toEqual(["unrecognized-format"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- skill-discipline.test.ts`

Expected: FAIL with `collectSkillInvocations is not exported from main.mjs` (or similar import error).

- [ ] **Step 3: Implement `collectSkillInvocations` in main.mts**

Add to `.sandcastle/main.mts`, near other top-level helpers (search for `function withHardCeiling` and insert ABOVE it):

```typescript
/**
 * Per-implementer-run collector for `Skill()` tool-call invocations from the
 * SDK agent stream. The SDK exposes a `toolCall` event with the tool name
 * and a `formattedArgs` string; we filter for `name === "Skill"` and extract
 * the skill name from the args.
 *
 * The collected `invoked` array becomes the `SKILLS_INVOKED` ground-truth
 * field passed to the reviewer prompt. It is host-computed, not
 * self-reported by the implementer, so the implementer cannot lie about
 * which skills it invoked.
 *
 * Parsing strategy: `formattedArgs` typically looks like `skill: "glass-morphism"`.
 * We try double-quoted, single-quoted, and backtick variants. If none match,
 * we record the raw args so the reviewer at least sees something is there
 * — silent drops would hide bugs in the parser as bugs in the implementer.
 *
 * Usage: pass `c.onEvent` as the `onAgentStreamEvent` callback in the SDK's
 * `logging` option. After the run, read `c.invoked` for the captured list.
 */
export function collectSkillInvocations(): {
  readonly invoked: string[];
  readonly onEvent: (event: {
    readonly type: "text" | "toolCall";
    readonly name?: string;
    readonly formattedArgs?: string;
  }) => void;
} {
  const invoked: string[] = [];
  const parseSkillName = (formattedArgs: string): string => {
    // Try double-quoted, single-quoted, backtick variants
    const patterns = [
      /skill\s*:\s*"([^"]+)"/,
      /skill\s*:\s*'([^']+)'/,
      /skill\s*:\s*`([^`]+)`/,
    ];
    for (const p of patterns) {
      const m = formattedArgs.match(p);
      if (m && m[1]) return m[1];
    }
    return formattedArgs;
  };
  return {
    invoked,
    onEvent: (event) => {
      if (event.type !== "toolCall") return;
      if (event.name !== "Skill") return;
      const name = parseSkillName(event.formattedArgs ?? "");
      invoked.push(name);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- skill-discipline.test.ts`

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/skill-discipline.test.ts .sandcastle/main.mts
git commit -m "$(cat <<'EOF'
feat: add collectSkillInvocations helper for SDK toolCall stream

Per-implementer collector that filters the SDK's agent stream for
`Skill()` tool calls and records the skill names. Becomes the
host-computed `SKILLS_INVOKED` ground-truth field passed to the
reviewer prompt. Implementer can't fake invocations because the
list is built from the SDK's tool-call stream, not from the
implementer's own claim.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire collector into `runImplementer`

**Files:**
- Modify: `.sandcastle/main.mts:2014-2099` (`runImplementer` function)

- [ ] **Step 1: Modify `runImplementer` to create a collector and pass to logging**

Edit `.sandcastle/main.mts` around line 2022. Change the return type of `runImplementer` to also expose the collected invocations:

```typescript
async function runImplementer(
  sb: SandcastleSandbox,
  ctx: PipelineContext,
  opts: {
    model?: string;
    attemptNumber?: number;
    reviewerFeedback?: string;
  } = {},
): Promise<{
  commits: readonly { sha: string }[];
  stdout: string;
  skillsInvoked: readonly string[];
}> {
```

- [ ] **Step 2: Inside `runImplementer`, create the collector and pass to `sb.run()` logging option**

Find the existing `sb.run({...})` call inside `runImplementer` (around line 2035). Modify it to add a `logging` option using a closure over the collector:

```typescript
  const collector = collectSkillInvocations();
  const r = await runWithRateLimitFallback(
    (model) =>
      sb.run({
        name:
          attemptNumber === 1
            ? "implementer"
            : attemptNumber === 3
              ? "implementer-retry-2"
              : "implementer-retry",
        maxIterations: 100,
        model,
        promptFile: "./.sandcastle/implement-prompt.md",
        idleTimeoutSeconds: ctx.args.implementerTimeoutSec,
        promptArgs: {
          ITERATION: String(ctx.iteration),
          ISSUE_NUMBER: String(ctx.issueNumber),
          STORY_TITLE: ctx.issue.title,
          BRANCH: ctx.issue.branch,
          ATTEMPT_NUMBER: String(attemptNumber),
          REVIEWER_FEEDBACK: opts.reviewerFeedback ?? "",
        },
        logging: {
          onAgentStreamEvent: collector.onEvent,
        },
      }),
    primaryModel,
    fallbackModel,
    ctx.deps.log,
    `implementer (issue=${ctx.issueNumber})`,
    "implementer",
  );
```

- [ ] **Step 3: Update the return statement to include `skillsInvoked`**

At the end of `runImplementer` (around line 2098), change:

```typescript
  return r;
}
```

to:

```typescript
  return { ...r, skillsInvoked: collector.invoked };
}
```

- [ ] **Step 4: Type-check the codebase**

Run: `pnpm tsc --noEmit`

Expected: PASS with no new errors. If the SDK's `RunOptions` type rejects the `logging` field, check `node_modules/@ai-hero/sandcastle/dist/run.d.ts` — the field may be named differently (e.g., `logging`, `observability`, or attached to the agent factory). Fix the field name to match the SDK shape.

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `pnpm test`

Expected: all existing tests still PASS. (The 7 new skill-discipline tests from Task 1 should still pass too.)

- [ ] **Step 6: Commit**

```bash
git add .sandcastle/main.mts
git commit -m "$(cat <<'EOF'
feat: wire skill-invocation collector into runImplementer

Each implementer run now creates a per-run collector and passes its
onEvent callback into the SDK's logging.onAgentStreamEvent hook. The
collected list is returned alongside the existing commits/stdout.
Downstream reviewer calls will read this to build SKILLS_INVOKED.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Inject `SKILLS_INVOKED` into reviewer prompt args

**Files:**
- Modify: `.sandcastle/main.mts:2407-2456` (`runReviewer` function)

- [ ] **Step 1: Add `skillsInvoked` parameter to `runReviewer` signature**

Edit `runReviewer`. Find its signature around line 2407 and add a new optional parameter:

```typescript
async function runReviewer(
  sb: SandcastleSandbox,
  ctx: PipelineContext,
  commitSha: string,
  reviewerFeedback?: string,
  model?: string,
  skillsInvoked: readonly string[] = [],
): Promise<...> {
```

- [ ] **Step 2: Add `SKILLS_INVOKED` to the reviewer's `promptArgs`**

Find the `sb.run({...})` call inside `runReviewer` (around line 2424). In its `promptArgs` block, add:

```typescript
        promptArgs: {
          ITERATION: String(ctx.iteration),
          ISSUE_NUMBER: String(ctx.issueNumber),
          COMMIT_SHA: commitSha,
          BRANCH: ctx.issue.branch,
          IMPLEMENTER_REBUTTAL: reviewerFeedback ?? "",
          SKILLS_INVOKED:
            skillsInvoked.length === 0
              ? "(none invoked)"
              : skillsInvoked.join(", "),
        },
```

(Adjust to match the exact existing keys — the snippet above shows the new field; preserve all current keys.)

- [ ] **Step 3: Update each `runReviewer` call site to forward the implementer's `skillsInvoked`**

Find every call to `runReviewer` (5 sites: around lines 2604, 2654, 2716, 2849, plus any others). Each must pass the matching implementer's `skillsInvoked`. Example for line 2604:

Before:
```typescript
const review1 = await runReviewer(sandbox, ctx, postSha);
```

After:
```typescript
const review1 = await runReviewer(sandbox, ctx, postSha, undefined, undefined, impl1.skillsInvoked);
```

Apply the same pattern to lines 2654, 2716, 2849. The exact extra args depend on what's already passed — preserve those, add `skillsInvoked` as the final arg.

- [ ] **Step 4: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add .sandcastle/main.mts
git commit -m "$(cat <<'EOF'
feat: inject SKILLS_INVOKED into reviewer prompt args

The reviewer now receives a host-computed list of skills the
implementer actually invoked during its run, captured via the
SDK's onAgentStreamEvent hook. Passed as a promptArg the
review-prompt template will reference in its skill-discipline
ground-truth check.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Plan-output validation — filter tickets missing `type:` labels

**Files:**
- Modify: `.sandcastle/main.mts` (add `filterPlanByTypeLabels` helper near other helpers, then call after planner returns)
- Modify: `tests/skill-discipline.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

Add to `tests/skill-discipline.test.ts`:

```typescript
import { filterPlanByTypeLabels } from "../.sandcastle/main.mjs";

describe("filterPlanByTypeLabels", () => {
  it("includes tickets that have a type: label", () => {
    const issues = [
      { id: "71", title: "new ui", branch: "agent/issue-71" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      ["71", ["ready-for-agent", "type:new-component"]],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, false);
    expect(r.kept).toEqual(issues);
    expect(r.excluded).toEqual([]);
  });

  it("excludes tickets missing a type: label", () => {
    const issues = [
      { id: "72", title: "broken backend", branch: "agent/issue-72" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      ["72", ["ready-for-agent"]],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, true);
    expect(r.kept).toEqual([]);
    expect(r.excluded).toEqual([
      { id: "72", reason: "missing type: label" },
    ]);
  });

  it("excludes tickets with multiple type: labels (config error)", () => {
    const issues = [
      { id: "73", title: "ambiguous", branch: "agent/issue-73" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      [
        "73",
        ["ready-for-agent", "type:new-component", "type:backend"],
      ],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, true);
    expect(r.kept).toEqual([]);
    expect(r.excluded).toEqual([
      { id: "73", reason: "multiple type: labels" },
    ]);
  });

  it("does NOT filter when sandcastleMdExists is false (backward compat)", () => {
    const issues = [
      { id: "74", title: "no sandcastle", branch: "agent/issue-74" },
    ];
    const labelLookup = new Map<string, readonly string[]>([
      ["74", ["ready-for-agent"]],
    ]);
    const r = filterPlanByTypeLabels(issues, labelLookup, false);
    expect(r.kept).toEqual(issues);
    expect(r.excluded).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- skill-discipline.test.ts`

Expected: FAIL with `filterPlanByTypeLabels is not exported`.

- [ ] **Step 3: Implement `filterPlanByTypeLabels` in main.mts**

Add to `.sandcastle/main.mts` near `collectSkillInvocations`:

```typescript
/**
 * Filter the planner's selected issues to enforce `type:` label discipline.
 * Only runs when SANDCASTLE.md exists at the repo root — that's the opt-in
 * signal that the project wants skill discipline enforced.
 *
 * Rules:
 * - Issue MUST carry exactly one label starting with `type:`.
 * - Zero `type:` labels → excluded with reason "missing type: label".
 * - Multiple `type:` labels → excluded with reason "multiple type: labels"
 *   (config error — the user should fix in triage).
 *
 * When `sandcastleMdExists` is false, the filter is a no-op (returns all
 * issues unchanged). This preserves backward compatibility for projects
 * that haven't adopted SANDCASTLE.md.
 *
 * Excluded issues are returned with a reason so the orchestrator can log
 * them (and the user can see them in `/sandcastle-status`).
 */
export function filterPlanByTypeLabels(
  issues: readonly { readonly id: string; readonly title: string; readonly branch: string }[],
  labelLookup: ReadonlyMap<string, readonly string[]>,
  sandcastleMdExists: boolean,
): {
  readonly kept: readonly { readonly id: string; readonly title: string; readonly branch: string }[];
  readonly excluded: readonly { readonly id: string; readonly reason: string }[];
} {
  if (!sandcastleMdExists) {
    return { kept: issues, excluded: [] };
  }
  const kept: typeof issues[number][] = [];
  const excluded: { id: string; reason: string }[] = [];
  for (const issue of issues) {
    const labels = labelLookup.get(issue.id) ?? [];
    const typeLabels = labels.filter((l) => l.startsWith("type:"));
    if (typeLabels.length === 0) {
      excluded.push({ id: issue.id, reason: "missing type: label" });
    } else if (typeLabels.length > 1) {
      excluded.push({ id: issue.id, reason: "multiple type: labels" });
    } else {
      kept.push(issue);
    }
  }
  return { kept, excluded };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- skill-discipline.test.ts`

Expected: all skill-discipline tests PASS (now 11 total).

- [ ] **Step 5: Commit**

```bash
git add .sandcastle/main.mts tests/skill-discipline.test.ts
git commit -m "$(cat <<'EOF'
feat: add filterPlanByTypeLabels for queue-selector enforcement

Filters the planner's selected issues, excluding any that lack
exactly one `type:` label. Only active when SANDCASTLE.md exists
at the repo root — projects without it work unchanged. Excluded
issues are returned with a reason so the orchestrator can log
and the user can see them in /sandcastle-status.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `filterPlanByTypeLabels` into the orchestrator after planner returns

**Files:**
- Modify: `.sandcastle/main.mts` (planner call site, around line 3019)

- [ ] **Step 1: Detect SANDCASTLE.md presence at orchestrator startup**

Find where the orchestrator initializes the run context. Near the top of the main entry function (search for `parsedArgs` or the initial argument-parsing block), add:

```typescript
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// near other args/context setup, AFTER repo root is known:
const sandcastleMdPath = resolve(args.repoRoot, "SANDCASTLE.md");
const sandcastleMdExists = existsSync(sandcastleMdPath);
if (sandcastleMdExists) {
  log.info(`SANDCASTLE.md found at ${sandcastleMdPath} — skill discipline enabled`);
} else {
  log.info(`No SANDCASTLE.md at repo root — skill discipline disabled (no enforcement)`);
}
```

(Adjust `args.repoRoot` and `log` to match the actual variable names used in this function — search for how other paths are computed.)

- [ ] **Step 2: After planner returns, build the label lookup and filter**

Find where `planResult` (around line 3019) is processed. The planner emits JSON with `{ issues: [{ id, title, branch }] }`. Right after parsing, fetch the labels for each picked issue and apply the filter:

```typescript
// Build label lookup for picked issues from the gh issue list that planner saw.
// The planner prompt already received the full `gh issue list --json labels`
// payload; re-fetch the labels here so the host has authoritative ground truth
// rather than trusting the planner agent's selection.
const pickedIds = parsedPlan.issues.map((i) => i.id);
const labelLookup = new Map<string, readonly string[]>();
if (pickedIds.length > 0) {
  const ghPayload = await deps.gh.issueListLabels({
    label: args.label,
    state: "open",
    limit: 100,
  });
  for (const item of ghPayload) {
    labelLookup.set(
      String(item.number),
      item.labels.map((l: { name: string }) => l.name),
    );
  }
}

const { kept, excluded } = filterPlanByTypeLabels(
  parsedPlan.issues,
  labelLookup,
  sandcastleMdExists,
);
for (const e of excluded) {
  log.warn(`skipping issue #${e.id} — ${e.reason}`);
}
const dispatchPlan = { issues: kept };
```

Use `dispatchPlan.issues` everywhere downstream in place of the previous `parsedPlan.issues`.

(If `deps.gh.issueListLabels` doesn't exist, add it in `src/state/gh.ts` as a thin wrapper around the same `gh issue list` call the planner makes. Match the existing wrapper style.)

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`

Expected: all tests PASS. (Existing tests should be unaffected since the filter is gated on `sandcastleMdExists` and fixtures don't include SANDCASTLE.md.)

- [ ] **Step 5: Commit**

```bash
git add .sandcastle/main.mts src/state/gh.ts
git commit -m "$(cat <<'EOF'
feat: wire SANDCASTLE.md presence check + plan filter into orchestrator

Orchestrator detects SANDCASTLE.md at the repo root on startup. When
present, the planner's selected issues are re-validated against the
host's own fetch of issue labels: any issue missing exactly one
`type:` label is excluded with a logged reason. Projects without
SANDCASTLE.md behave exactly as before.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update `plan-prompt.md` — add `type:` label filter rule

**Files:**
- Modify: `.sandcastle/plan-prompt.md`

- [ ] **Step 1: Add a new HARD RULE to plan-prompt.md**

Open `.sandcastle/plan-prompt.md`. Find the `# HARD RULES` block (currently 5 numbered rules ending at "Branch name"). Insert a new rule between rule 2 ("Exclude blocked issues") and rule 3 ("Sort eligible issues"), making it the new rule 3 and renumbering subsequent rules:

```
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
```

Renumber the original rules 3-5 as 4-6.

- [ ] **Step 2: Verify the file is well-formed Markdown**

Open the file and re-read it. Check that the rules are numbered 1-6 in sequence and that the JSON output block at the end is unchanged.

- [ ] **Step 3: Commit**

```bash
git add .sandcastle/plan-prompt.md
git commit -m "$(cat <<'EOF'
docs(plan-prompt): require type: label when SANDCASTLE.md exists

New HARD RULE 3 instructs the planner to exclude issues missing a
type: label when the project opts into skill discipline. Host-side
re-validation runs after the plan returns; the prompt-side rule
is an optimization to avoid dispatching slots that will be filtered.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update `implement-prompt.md` — add STEP 0 skill discipline

**Files:**
- Modify: `.sandcastle/implement-prompt.md`

- [ ] **Step 1: Open the file and locate where to insert STEP 0**

Open `.sandcastle/implement-prompt.md`. The file is 574 lines. Find the line where the existing first numbered step begins (search for `# THE ISSUE` or `STEP 1:` — the exact heading style depends on the current prompt). The new STEP 0 must come BEFORE any other code-related step but AFTER the issue spec and reviewer-feedback context blocks.

- [ ] **Step 2: Insert STEP 0**

Insert the following block immediately before the existing STEP 1:

```
# STEP 0 — Read project rules (BEFORE any code work)

If `SANDCASTLE.md` exists at the repo root, this project has opt-ed
into skill discipline. You MUST follow these steps before writing
any code:

1. Read `SANDCASTLE.md` at the repo root.

2. This ticket has exactly one `type:X` label (the orchestrator
   already verified this — if you got dispatched, the label is
   present). Find that label in your ticket's metadata.

3. In `SANDCASTLE.md`, locate the section matching your `type:X`
   label. List its "Required" tools. Also list any tools required
   by `tool:Y` labels on this ticket (search the ticket's labels
   for any starting with `tool:`).

4. Output a `<skill-plan>` block listing the exact skills you will
   invoke for this ticket, in the order you'll invoke them. Example:

   ```
   <skill-plan>
   - impeccable
   - layout
   - clarify
   - glass-morphism
   - polish
   </skill-plan>
   ```

5. For EACH skill in your plan, invoke it via the Skill tool BEFORE
   writing any code. Format: `Skill(skill="<name>")`. After
   invocation, apply the tool's guidance to your work. The
   orchestrator captures every `Skill()` call you make and forwards
   the list to the reviewer as authoritative ground truth — you
   cannot omit a required tool and claim you used it.

6. If `tool:audit` or `tool:critique` is present on this ticket:
   after invoking the tool, READ its report/findings carefully. Any
   P0 or P1 severity findings MUST be addressed in your diff before
   you declare done. The reviewer will verify.

7. If `SANDCASTLE.md` does not exist or has no section matching this
   ticket's `type:` label, skip this step entirely. Proceed to STEP
   1 — there is no skill discipline to enforce.
```

- [ ] **Step 3: Re-read the file end-to-end**

Scan the whole file for any reference to "STEP N" where N is now off-by-one. If STEP 0 was added and STEPs were already numbered 1-9 (or however many), the existing numbering is unchanged — STEP 0 is a new addition, not a renumber.

- [ ] **Step 4: Commit**

```bash
git add .sandcastle/implement-prompt.md
git commit -m "$(cat <<'EOF'
docs(implement-prompt): add STEP 0 for skill discipline enforcement

When SANDCASTLE.md exists, the implementer must read it, find the
section matching the ticket's type: label, output a <skill-plan>
listing required tools, and invoke each via Skill() BEFORE writing
code. tool:audit / tool:critique findings (P0/P1) must be addressed
in the diff. The orchestrator captures the invocations from the
SDK stream and forwards as authoritative SKILLS_INVOKED to the
reviewer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Update `review-prompt.md` — add `SKILLS_INVOKED` ground-truth + check

**Files:**
- Modify: `.sandcastle/review-prompt.md`

- [ ] **Step 1: Locate the existing DRIVER GROUND TRUTH block**

Open `.sandcastle/review-prompt.md`. Search for `DRIVER GROUND TRUTH` (around line 70 today). This is where `SPEC_REQUIRES_PLAYWRIGHT` and `COMMIT_TOUCHED_UI` are computed and the reviewer is told they're authoritative.

- [ ] **Step 2: Append `SKILLS_INVOKED` to the ground-truth block**

After the existing `COMMIT_TOUCHED_UI` bullet (search for that string), insert:

```
- **SKILLS_INVOKED**: the host extracted every `Skill()` tool call the
  implementer made during its run, via the SDK's `onAgentStreamEvent`
  hook. This is the authoritative list:

  <skills-invoked>
  {{SKILLS_INVOKED}}
  </skills-invoked>

  You cannot trust the implementer's own claim about what it invoked —
  trust only this block. If the value is `(none invoked)`, no skills
  were called.
```

- [ ] **Step 3: Add the skill-discipline check to the reviewer's job**

Find the reviewer's main checks (search for `CATEGORY SWEEP` or the section enumerating "Spec fit", etc.). Add a new category:

```
- **Skill discipline**: only if SANDCASTLE.md exists at the repo root.

  1. Read SANDCASTLE.md.
  2. Find the section matching this ticket's `type:` label (visible
     in the issue spec's labels).
  3. List the Required tools for that section. Add any tools required
     by `tool:Y` labels on this ticket.
  4. Compare to SKILLS_INVOKED above. If any Required tool is missing
     from SKILLS_INVOKED, emit a finding:
     `Required: [list]. Invoked: [list]. Missing: [list].`
  5. If `tool:audit` was present, scan the implementer's transcript
     for audit's P0/P1 findings and verify the diff resolves them.
     Same for `tool:critique`. If unfixed P0/P1 remain, emit a
     finding.
  6. If SANDCASTLE.md does not exist or has no section matching the
     ticket's type, mark this category `n/a`.

  A missing Required tool is a HARD finding (not soft) — emit
  HAS_BLOCKERS. Over-invocation (extra tools beyond required) is
  never a finding; only under-invocation is.
```

(Match the existing CATEGORY SWEEP format — likely `- Skill discipline: ok` / `- Skill discipline: n/a (...)` / `- Skill discipline: <finding>`.)

- [ ] **Step 4: Commit**

```bash
git add .sandcastle/review-prompt.md
git commit -m "$(cat <<'EOF'
docs(review-prompt): add SKILLS_INVOKED ground-truth + discipline check

Reviewer now receives a host-extracted list of every Skill() call the
implementer made (from the SDK stream — authoritative, not
self-reported). New CATEGORY SWEEP entry "Skill discipline" compares
this list against SANDCASTLE.md's required tools for the ticket's
type: label. Missing required tools = HAS_BLOCKERS. Also verifies
audit/critique P0/P1 findings got fixed when those tools are opted in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Inject `SKILLS_INVOKED` into post-merge-review

**Files:**
- Modify: `.sandcastle/main.mts:3248-3290` (`runPostMergeReviewer`)

- [ ] **Step 1: Add `skillsInvoked` param to `runPostMergeReviewer`**

Edit the function signature (around line 3248). Add a new optional param:

```typescript
const runPostMergeReviewer = async (
  model: string,
  skillsInvokedByIssue: ReadonlyMap<string, readonly string[]> = new Map(),
) => {
```

- [ ] **Step 2: Pass `SKILLS_INVOKED_BY_ISSUE` to the prompt**

Find the `deps.run({...})` call inside the function (around line 3252). Add to its `promptArgs`:

```typescript
        promptArgs: {
          // ... existing keys ...
          SKILLS_INVOKED_BY_ISSUE: Array.from(skillsInvokedByIssue.entries())
            .map(([id, skills]) => `#${id}: ${skills.length === 0 ? "(none)" : skills.join(", ")}`)
            .join("\n"),
        },
```

- [ ] **Step 3: Build the per-issue map at the call site**

Find where `runPostMergeReviewer` is called (line 3363). The caller has access to all the per-issue implementer results. Build a map and pass:

```typescript
const skillsInvokedByIssue = new Map<string, readonly string[]>();
for (const [issueId, result] of allImplementerResults) {
  skillsInvokedByIssue.set(issueId, result.skillsInvoked);
}
postMergeMarker = await runPostMergeReviewer(reviewerEscModel, skillsInvokedByIssue);
```

(Adapt variable names — `allImplementerResults` is illustrative; find the actual collection where implementer results are stored across issues. May be `pipelineResults`, `issueOutcomes`, etc.)

- [ ] **Step 4: Type-check**

Run: `pnpm tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Run tests**

Run: `pnpm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add .sandcastle/main.mts
git commit -m "$(cat <<'EOF'
feat: inject SKILLS_INVOKED_BY_ISSUE into post-merge reviewer

Post-merge reviewer (which audits the integrated branch across
multiple issues) now sees the per-issue skill invocations from
each implementer's SDK stream. Enables the same skill-discipline
verification at the rollup level as runs at the per-issue review.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update `post-merge-review-prompt.md` — add SKILLS_INVOKED_BY_ISSUE check

**Files:**
- Modify: `.sandcastle/post-merge-review-prompt.md`

- [ ] **Step 1: Add the SKILLS_INVOKED_BY_ISSUE block**

Open `.sandcastle/post-merge-review-prompt.md`. Find where issue context is presented (likely a `<issues>` or per-issue block). After that section, add:

```
# SKILLS INVOKED PER ISSUE (host-extracted, authoritative)

The orchestrator captured every `Skill()` tool call each implementer
made via the SDK's `onAgentStreamEvent` hook. This is authoritative —
the implementers cannot fake or omit entries:

<skills-invoked-by-issue>
{{SKILLS_INVOKED_BY_ISSUE}}
</skills-invoked-by-issue>

# Skill discipline check (only if SANDCASTLE.md exists at the repo root)

For each issue in this rollup:

1. Find its `type:` label.
2. Look up that section in SANDCASTLE.md.
3. List Required tools (plus any `tool:Y`-label requirements).
4. Compare to SKILLS_INVOKED for that issue.
5. If any Required tool is missing for ANY issue, emit a finding
   identifying the issue number and the missing tools.

A missing Required tool in ANY issue → HAS_BLOCKERS for the rollup.
```

- [ ] **Step 2: Commit**

```bash
git add .sandcastle/post-merge-review-prompt.md
git commit -m "$(cat <<'EOF'
docs(post-merge-review-prompt): add per-issue skill-discipline check

Multi-issue rollup reviewer now receives per-issue skill invocations
from the host and verifies each issue's invoked set against the
requirements in SANDCASTLE.md for that issue's type: label.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Update `post-merge-fix-prompt.md` — read SANDCASTLE.md before fixing

**Files:**
- Modify: `.sandcastle/post-merge-fix-prompt.md`

- [ ] **Step 1: Add a preamble step**

Open `.sandcastle/post-merge-fix-prompt.md`. At the very beginning of the agent's actionable instructions (after the context blocks), insert:

```
# STEP 0 — Read project rules (BEFORE any fix work)

If `SANDCASTLE.md` exists at the repo root:

1. Read `SANDCASTLE.md`.
2. Identify the `type:` label of EACH issue you are fixing (they are
   listed in the rollup context above).
3. For each issue, find its category section in SANDCASTLE.md and
   list Required tools.
4. Before making any code fix, invoke each Required tool via
   `Skill(skill="<name>")` — same as the original implementer was
   required to do. Your fixes must follow the same skill discipline
   as the original work, not bypass it.
5. If `tool:audit` or `tool:critique` is on any issue, apply the
   act-on-findings rule from the implementer prompt: invoke the
   tool, read findings, fix P0/P1 in your diff before declaring done.

If SANDCASTLE.md does not exist, skip this step and proceed.
```

- [ ] **Step 2: Commit**

```bash
git add .sandcastle/post-merge-fix-prompt.md
git commit -m "$(cat <<'EOF'
docs(post-merge-fix-prompt): require same skill discipline on fixes

The post-merge fixer now follows the same SANDCASTLE.md discipline as
the original implementer — reads the rules, identifies each issue's
type: section, invokes Required tools before any fix code. Prevents
the fixer from being a back-door around skill enforcement.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Update `recovery-prompt.md` — read SANDCASTLE.md before recovery

**Files:**
- Modify: `.sandcastle/recovery-prompt.md`

- [ ] **Step 1: Add a preamble step**

Open `.sandcastle/recovery-prompt.md`. At the start of actionable instructions, insert:

```
# STEP 0 — Read project rules (BEFORE any recovery work)

If `SANDCASTLE.md` exists at the repo root:

1. Read `SANDCASTLE.md`.
2. Find the section matching this ticket's `type:` label.
3. List Required tools.
4. Before making any code change, invoke each Required tool via
   `Skill(skill="<name>")`. Recovery is not exempt from skill
   discipline — the same standard applies as on the original pass.

If SANDCASTLE.md does not exist, skip this step.
```

- [ ] **Step 2: Commit**

```bash
git add .sandcastle/recovery-prompt.md
git commit -m "$(cat <<'EOF'
docs(recovery-prompt): require skill discipline on recovery pass

Recovery agent now reads SANDCASTLE.md and invokes the same Required
tools the implementer was bound to. Recovery is not a discipline-free
escape hatch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Smoke test the full chain locally

**Files:**
- No code changes; verification only

- [ ] **Step 1: Create a fixture SANDCASTLE.md in a test scratch dir**

Run:

```bash
mkdir -p /tmp/sandcastle-smoke
cd /tmp/sandcastle-smoke
git init
cat > SANDCASTLE.md <<'EOF'
# SANDCASTLE.md

### type:bugfix-ui
Required:
- impeccable
- harden

### type:backend
Required:
- simplify
EOF
git add SANDCASTLE.md
git commit -m "init"
```

- [ ] **Step 2: Verify `filterPlanByTypeLabels` behaves correctly with this fixture**

This is unit-tested already (Task 4 tests). Re-run them to confirm:

```bash
cd /Users/ziyadakl/Dev/Sandcastle
pnpm test -- skill-discipline.test.ts
```

Expected: all 11 tests PASS.

- [ ] **Step 3: Verify the prompts render with new template args**

Render each modified prompt with sample args to make sure no `{{VAR}}` placeholders are unmatched:

```bash
grep -E "\{\{[A-Z_]+\}\}" .sandcastle/review-prompt.md .sandcastle/post-merge-review-prompt.md
```

Expected: a list of `{{VAR}}` placeholders. Each one must appear as a key in the corresponding `promptArgs` block in main.mts. Cross-check manually for the new `SKILLS_INVOKED` and `SKILLS_INVOKED_BY_ISSUE` entries.

- [ ] **Step 4: Full test suite**

Run: `pnpm test`

Expected: all tests PASS (350+ existing + 11 new).

- [ ] **Step 5: Type-check the whole project**

Run: `pnpm tsc --noEmit`

Expected: PASS, no new errors.

- [ ] **Step 6: No commit needed**

This task is verification only. If any step fails, fix the related task and re-run.

---

## Self-Review Checklist

After completing all tasks, run this checklist before declaring the plan executed:

**Spec coverage:**
- [ ] SANDCASTLE.md at repo root is read by all five agent prompts? (Tasks 7, 8, 10, 11, 12)
- [ ] `/triage+skills` wrapper skill — OUT OF SCOPE for this plan (separate handoff). ✓
- [ ] Queue selector refuses unlabeled tickets? (Tasks 4, 5, 6)
- [ ] Implementer STEP 0 reads SANDCASTLE.md and invokes required tools? (Task 7)
- [ ] Reviewer gets host-extracted SKILLS_INVOKED and uses it? (Tasks 1-3, 8)
- [ ] Post-merge reviewer gets SKILLS_INVOKED_BY_ISSUE and checks all issues? (Tasks 9-10)
- [ ] Post-merge fixer reads SANDCASTLE.md too? (Task 11)
- [ ] Recovery agent reads SANDCASTLE.md? (Task 12)
- [ ] Strict-label opt-ins (`tool:bento`, `tool:widget`, `tool:audit`, `tool:critique`) honored? (Task 7 prompt content)
- [ ] Act-on-findings rule for audit/critique enforced by reviewer? (Task 8 prompt content)
- [ ] `shape` skill excluded from autonomous use? (Documented in spec; prompts never list it.)
- [ ] Graceful degradation when SANDCASTLE.md missing? (Task 5 — `sandcastleMdExists` flag; Tasks 7, 11, 12 — explicit "if exists" wording.)

**Placeholder scan:**
- [ ] No "TODO", "TBD", "implement later" anywhere in tasks above.
- [ ] Every code block has actual code, not pseudo-code.
- [ ] Every test step shows the exact test code.

**Type consistency:**
- [ ] `collectSkillInvocations` return shape is consistent across Tasks 1, 2 (the `{ invoked, onEvent }` object).
- [ ] `filterPlanByTypeLabels` parameter order consistent across Tasks 4, 5 (`issues, labelLookup, sandcastleMdExists`).
- [ ] `skillsInvoked` field name on `runImplementer` return is consistent across Tasks 2, 3 (always `skillsInvoked`).

If anything fails, fix inline and re-run.

---

## Out of scope (tracked in spec)

- `~/.claude/skills/sandcastle-init/SKILL.md` — scaffold an empty SANDCASTLE.md when initializing a new project. Separate handoff.
- `~/.claude/skills/sandcastle-update/SKILL.md` — explicit "never touch root SANDCASTLE.md" guard. Separate handoff.
- `~/.claude/skills/triage-plus-skills/SKILL.md` — NEW wrapper skill. Separate handoff.
- affinity-tracker migration steps (write SANDCASTLE.md, delete `.impeccable.md` line from CLAUDE.md, re-label tickets). User-side; not template code.
