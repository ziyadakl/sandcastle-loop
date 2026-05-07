/**
 * Briefing builder — analogue of bash `build_briefing()` (afk-ralph.sh:274–313)
 * plus the implementer/reviewer/fixer prompt assembly inlined into bash
 * `run_implementer` / `run_reviewer` / `run_fixer`.
 *
 * Exposes pure string-builders. No I/O at module load time so unit tests can
 * call without mocking the filesystem. The implementer template is read from
 * disk lazily and cached, but tests pass an explicit `template` to bypass.
 *
 * Prompt-cache discipline (V1-B refactor):
 *   The pre-fetched issue spec block is embedded VERBATIM at the SAME position
 *   (the very top, before any role-specific content) in all three agent
 *   prompts (implementer, reviewer, fixer). This is load-bearing for prompt
 *   cache hits across the three calls in one iteration — same prefix → cache
 *   hit on the second and third agent invocation.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Story } from "../types.js";

/**
 * Driver-fetched GitHub issue snapshot. The driver pre-fetches this once at
 * iteration start (via the loop's `fetchIssueBody`) and threads it into all
 * three agent briefings.
 */
export interface IssueRef {
  title: string;
  body: string;
  labels: string[];
  number: number;
}

export interface BriefingArgs {
  story: Story;
  ghIssue: number;
  iterationNum: number;
  iterationTotal: number;
  /**
   * Pre-fetched issue snapshot (driver responsibility). Embedded verbatim at
   * the SAME position in implementer / reviewer / fixer prompts — this is the
   * shared cache prefix.
   */
  issue: IssueRef;
  /**
   * Optional: when this briefing is for a fixer, the prior reviewer's verdict
   * text gets attached so the fixer has the concerns inline (no re-fetch).
   */
  prevReviewerText?: string;
  /** Optional: e2e log contents from /tmp/ralph-e2e-it{N}.log if present. */
  e2eLog?: string;
  /** Optional override for the implementer template body — for tests. */
  implementerTemplate?: string;
}

export interface FixerBriefingArgs extends BriefingArgs {
  attempt: 1 | 2;
  lastSha: string;
}

export interface ReviewerBriefingArgs extends BriefingArgs {
  lastSha: string;
  branch: string;
  /** Driver-side pre-grep: did the spec contain `playwright test`? */
  specRequiresPlaywright: boolean;
  /** Driver-side post-commit git-diff: does the commit touch UI files? */
  commitTouchedUi: boolean;
}

export interface RecoveryBriefingArgs {
  story: Story;
  ghIssue: number;
  iterationNum: number;
  preSha: string;
  priorAgent: "implementer" | "implementer-then-sonnet-recovery";
  priorRc: number;
  /** Last `[STEP X/9]` marker captured from the prior agent's output. */
  lastStep: string;
  /** Lines from `git log --oneline preSha..HEAD` (or "(none)"). */
  commits: string;
  /** Lines from `git status -s` (or "(clean)"). */
  uncommitted: string;
}

let cachedImplementerTemplate: string | null = null;

/**
 * Reads the implementer prompt template from refs/prompt.md.local-fork once.
 * Cached so multi-iteration loops don't pay the I/O each time. Tests can
 * inject `implementerTemplate` directly to skip this.
 */
function loadImplementerTemplate(): string {
  if (cachedImplementerTemplate !== null) return cachedImplementerTemplate;
  // Resolve relative to project root. Node ESM has no __dirname; use process.cwd()
  // as the anchor. The integration entry point should run from repo root.
  const path = resolve(process.cwd(), "refs/prompt.md.local-fork");
  cachedImplementerTemplate = readFileSync(path, "utf8");
  return cachedImplementerTemplate;
}

/**
 * Substitute `{N}`, `{STORY_ID}`, `{GH_ISSUE}` placeholders. Bash uses literal
 * `$i` / `$STORY_ID` / `$GH_ISSUE` interpolation in the heredoc; the template
 * was authored with `{N}` / `{STORY_ID}` / `{GH_ISSUE}` markers so JS can do
 * the substitution without invoking a shell.
 */
function substitute(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, val] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(val);
  }
  return out;
}

/**
 * The shared issue-spec block. EXACT same string is emitted at the SAME
 * position (the top) of every agent prompt for prompt-cache locality. Do not
 * vary whitespace, header text, or field ordering between callers — the
 * prefix tokens are what hash to the cache key.
 */
export function formatIssueBlock(issue: IssueRef): string {
  const labels = issue.labels.length > 0 ? issue.labels.join(", ") : "(none)";
  return [
    "=== Issue spec (pre-fetched by driver — do NOT call `gh issue view`) ===",
    `Issue #${issue.number}: ${issue.title}`,
    `Labels: ${labels}`,
    "",
    issue.body,
    "=== End issue spec ===",
  ].join("\n");
}

/**
 * Build the implementer prompt — analogue of bash `run_implementer()`.
 *
 * Layout (top → bottom):
 *   1. Issue block (shared cache prefix — IDENTICAL across all three roles)
 *   2. Iteration metadata header
 *   3. Implementer template body (the 9-step flow + certification block)
 *   4. The 7-question structural certification check (V1-A schema fields)
 */
export function buildImplementerBriefing(args: BriefingArgs): string {
  const template = args.implementerTemplate ?? loadImplementerTemplate();
  const body = substitute(template, {
    N: String(args.iterationNum),
    STORY_ID: args.story.id,
    GH_ISSUE: String(args.ghIssue),
  });

  const issueBlock = formatIssueBlock(args.issue);
  const meta = [
    `ITERATION: ${args.iterationNum}`,
    `STORY_ID: ${args.story.id}`,
    `GH_ISSUE: ${args.ghIssue}`,
  ].join("\n");

  return `${issueBlock}\n\n${meta}\n\n${body}\n\n${buildSevenQuestionBlock()}`;
}

/**
 * V1-A wiring — the seven structured-output questions the implementer MUST
 * answer in its final JSON envelope before emitting STORY_COMPLETE. Each
 * question is phrased as an imperative and references driver-computed ground
 * truth so the agent can't fabricate an answer that contradicts the diff.
 *
 * Field names match V1-A's ImplementerOutput extension (storyType, e2eRequired,
 * e2eActuallyRan, testCommandUsed, e2eAssertionLine, outputNotFiltered,
 * testReachedFeature). Driver-side ground truth (SPEC_REQUIRES_PLAYWRIGHT)
 * flows in via the implementer-prompt placeholder substitution; the driver
 * recomputes commitTouchedUi from `git diff` post-commit.
 */
function buildSevenQuestionBlock(): string {
  return `=== STRUCTURAL CERTIFICATION CHECK — answer all 7 questions ===

Before emitting STORY_COMPLETE you MUST answer these 7 questions in your final
structured output (the JSON envelope). The driver pre-computed some of them
from the spec; if your answer contradicts the driver's ground truth, you are
wrong and the reviewer WILL reject the commit.

1) storyType: classify as "ui" | "backend" | "infra" | "docs" — based on the
   issue spec and what files your diff touched. UI stories require playwright
   per STEP 6/9.

2) e2eRequired: true|false — did the spec REQUIRE a playwright test? The
   driver pre-computed this by grepping the issue body for "playwright test";
   if you got it wrong, you're wrong.

3) e2eActuallyRan: true|false — did you actually invoke the playwright command
   in this iteration (regardless of pass/fail)? If e2eRequired is true and
   this is false, you have NOT completed the story.

4) testCommandUsed: the EXACT shell command you ran for the e2e (or the empty
   string if e2eActuallyRan=false). Verbatim — no paraphrasing.

5) e2eAssertionLine: a line from /tmp/ralph-e2e-it{N}.log that PROVES the
   test reached its assertion (must start with ✓ / ✔ / PASS, contain
   "expect(", or be the test description text). Empty string if no e2e ran.

6) outputNotFiltered: true|false — did you run playwright | tee WITHOUT
   inserting any grep/sed/awk/--quiet/--reporter=dot/redirection that would
   suppress bail signals? Filtering output is a prompt-following failure.

7) testReachedFeature: true|false — did the test exercise the user-facing
   behavior described in the story (NOT auth state, login redirect, or
   pre-condition setup)? "1 passed" with no specific test detail = false.

These 7 fields are REQUIRED by the V1-A ImplementerOutput schema; the parser
will reject the envelope if any are missing.
=== End structural certification check ===`;
}

/**
 * Build the reviewer prompt — analogue of bash `run_reviewer()`. Inlines
 * the driver's ground-truth flags (SPEC_REQUIRES_PLAYWRIGHT, COMMIT_TOUCHED_UI)
 * and attaches the e2e log when present. The full review rubric (4-tier
 * classification, certification structural check) is reproduced verbatim
 * to match the bash version's behavior — no shorthand, no abbreviation.
 *
 * The issue block is emitted FIRST (verbatim, identical to the implementer's
 * prefix) so the prompt-cache hits across calls.
 */
export function buildReviewerBriefing(args: ReviewerBriefingArgs): string {
  const issueBlock = formatIssueBlock(args.issue);
  const specReqPw = args.specRequiresPlaywright ? "yes" : "no";
  const uiTouched = args.commitTouchedUi ? "yes" : "no";
  const e2eAttachment = args.e2eLog
    ? `\n=== Playwright e2e log (/tmp/ralph-e2e-it${args.iterationNum}.log) ===\n${args.e2eLog}\n=== End e2e log ===\n`
    : "";

  return `${issueBlock}
${e2eAttachment}
Use the superpowers:requesting-code-review skill to review commit ${args.lastSha} on branch ${args.branch} (iteration ${args.iterationNum}, GitHub issue #${args.ghIssue}). The issue spec is pre-loaded above — do NOT call 'gh issue view' yourself, work from that text. Check both spec fit (does the diff implement the issue's acceptance criteria?) and code quality.

DRIVER GROUND TRUTH (authoritative, can't be overridden by implementer self-attestation):
- SPEC_REQUIRES_PLAYWRIGHT=${specReqPw} — driver pre-grepped issue spec for 'playwright test'
- COMMIT_TOUCHED_UI=${uiTouched} — driver post-commit git-diff'd for .tsx/.jsx/.vue under apps/

If COMMIT_TOUCHED_UI=yes, the commit modified UI surface files — the certification's first checkbox MUST be [x] regardless of what the implementer self-attests. If COMMIT_TOUCHED_UI=no AND SPEC_REQUIRES_PLAYWRIGHT=no, the story is genuinely backend-only and N/A on e2e.

Use this 4-tier classification per concern:
  HARD — must fix, story can't ship: real bug, broken test, missing required behavior, security issue, data-loss risk.
  MEDIUM — should fix: subtle logic bug that won't fail tests, missing error handling on a likely-failure path, real measurable perf concern, unsafe assumption that could break in production.
  SOFT / cosmetic — DO NOT flag, skip silently.
  CLEAR — no concerns.

CRITICAL — execution-evidence check (do this FIRST, before reviewing code quality): if the issue spec's Acceptance section contains a 'playwright test' command, the implementer was required to run it and save output to /tmp/ralph-e2e-it${args.iterationNum}.log. Verify:
  1. Does the e2e log exist and contain a playwright summary line?
  2. Does the commit body include the e2e summary?
  3. Does the test name match the story's behavior?
  4. Did the test reach its assertion (no auth-redirect, no 'skipped', no bail signals)?
  5. Does the certification block in the commit body have all checkboxes [x] when SPEC_REQUIRES_PLAYWRIGHT=yes or COMMIT_TOUCHED_UI=yes?

If the certification block is missing or the first checkbox conflicts with driver ground truth, emit HAS_BLOCKERS with a HARD finding.

First, output the line: [STEP 1/1] Review (this is required — the loop driver uses it to render status). Then do the review. End with one of:
  - ALL_CLEAR — no HARD or MEDIUM concerns. (cosmetic SOFT findings are fine; do not block on them.)
  - HAS_BLOCKERS — at least one HARD or MEDIUM concern that genuinely needs a fix.

The marker MUST be on its own line at the end of your output, with no surrounding text. Write the marker as a bare word on a line by itself, as the LAST non-empty line of your response.`;
}

/**
 * Build the fixer prompt — analogue of bash `run_fixer()`. Includes the
 * prior reviewer's text inline so the fixer doesn't need to re-fetch.
 *
 * The issue block is emitted FIRST (verbatim, identical to the implementer's
 * and reviewer's prefix) so the prompt-cache hits across calls.
 */
export function buildFixerBriefing(args: FixerBriefingArgs): string {
  const issueBlock = formatIssueBlock(args.issue);
  const reviewerSection = args.prevReviewerText
    ? `\n=== Prior reviewer findings ===\n${args.prevReviewerText}\n=== End prior reviewer findings ===\n`
    : "";

  return `${issueBlock}
${reviewerSection}
Use the superpowers:receiving-code-review skill to judge the most recent code review on commit ${args.lastSha} (iteration ${args.iterationNum}, fix attempt ${args.attempt}, GitHub issue #${args.ghIssue}). Fix every HARD finding (must-fix bugs / blockers) and every MEDIUM finding (real concerns that won't fail tests but matter). Skip SOFT / cosmetic findings entirely — DO NOT touch variable names, formatting, comment phrasing, or 'prefer this pattern' suggestions.

Run typecheck and tests after fixes, then commit explicitly with prefix 'RALPH(it=${args.iterationNum} fix=${args.attempt} issue=${args.ghIssue}): '.

Emit these step markers on their own lines as you go: [STEP 1/4] Judge findings, [STEP 2/4] Apply fixes, [STEP 3/4] Verify, [STEP 4/4] Commit.

End with one of: FIXED or BLOCKED.

The marker MUST be on its own line at the end of your output, with no surrounding text. Write the marker as a bare word on a line by itself, as the LAST non-empty line of your response.`;
}

/**
 * Build the recovery briefing — analogue of bash `build_briefing()`
 * (afk-ralph.sh:274–313). Recovery prompt itself lives in
 * refs/recovery-prompt.md and is referenced by Track E's runRecoveryLadder.
 */
export function buildRecoveryBriefing(args: RecoveryBriefingArgs): string {
  const shortSha = args.preSha.slice(0, 8) || "(empty)";
  return `# Recovery briefing — iteration ${args.iterationNum}, story ${args.story.id} (gh issue #${args.ghIssue})

The previous **${args.priorAgent}** agent exited non-zero (rc=${args.priorRc}). That's most often a hit timeout but can also be a crash, OOM kill, or unrecoverable hook block.

## What's already there

- Commits made this iteration (from PRE_SHA \`${shortSha}\` to HEAD):

\`\`\`
${args.commits || "(none)"}
\`\`\`

- Uncommitted files:

\`\`\`
${args.uncommitted || "(clean)"}
\`\`\`

- Last \`[STEP X/9]\` marker the previous agent emitted: ${args.lastStep}

## What you do next

Read \`scripts/ralph/recovery-prompt.md\` (pre-loaded). tldr: run the spec's acceptance tests. If they pass, commit any pending work and exit cleanly with \`RECOVERY_COMPLETE\` — the loop driver will mark the story done and close the GH issue itself. If the tests fail, finish the work using what's already here as scaffolding, then commit and exit \`RECOVERY_COMPLETE\`. Only emit \`<promise>HALT</promise>\` for real external blockers. Do NOT call \`mark-done.sh\` or \`gh issue close\` yourself.
`;
}

/**
 * Test-only: clear the implementer-template cache so a unit test can swap
 * the underlying file between calls without leaking state.
 * @internal
 */
export function _resetImplementerTemplateCache(): void {
  cachedImplementerTemplate = null;
}
