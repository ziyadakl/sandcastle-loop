/**
 * Briefing builder — analogue of bash `build_briefing()` (afk-ralph.sh:274–313)
 * plus the implementer/reviewer/fixer prompt assembly inlined into bash
 * `run_implementer` / `run_reviewer` / `run_fixer`.
 *
 * Exposes pure string-builders. No I/O at module load time so unit tests can
 * call without mocking the filesystem. The implementer template is read from
 * disk lazily and cached, but tests pass an explicit `template` to bypass.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Story } from "../types.js";

export interface BriefingArgs {
  story: Story;
  ghIssue: number;
  iterationNum: number;
  iterationTotal: number;
  /** Pre-fetched issue body markdown (driver responsibility, like bash ISSUE_FILE). */
  issueBody: string;
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
 * Build the implementer prompt — analogue of bash `run_implementer()`.
 * Header references the issue body and progress log; the template body
 * follows. Step markers and certification block live in the template.
 */
export function buildImplementerBriefing(args: BriefingArgs): string {
  const template = args.implementerTemplate ?? loadImplementerTemplate();
  const body = substitute(template, {
    N: String(args.iterationNum),
    STORY_ID: args.story.id,
    GH_ISSUE: String(args.ghIssue),
  });

  const header = [
    `ITERATION: ${args.iterationNum}`,
    `STORY_ID: ${args.story.id}`,
    `GH_ISSUE: ${args.ghIssue}`,
    "",
    "=== Issue spec (pre-fetched by driver — do NOT call `gh issue view`) ===",
    args.issueBody,
    "=== End issue spec ===",
  ].join("\n");

  return `${body}\n\n${header}`;
}

/**
 * Build the reviewer prompt — analogue of bash `run_reviewer()`. Inlines
 * the driver's ground-truth flags (SPEC_REQUIRES_PLAYWRIGHT, COMMIT_TOUCHED_UI)
 * and attaches the e2e log when present. The full review rubric (4-tier
 * classification, certification structural check) is reproduced verbatim
 * to match the bash version's behavior — no shorthand, no abbreviation.
 */
export function buildReviewerBriefing(args: ReviewerBriefingArgs): string {
  const specReqPw = args.specRequiresPlaywright ? "yes" : "no";
  const uiTouched = args.commitTouchedUi ? "yes" : "no";
  const e2eAttachment = args.e2eLog
    ? `\n=== Playwright e2e log (/tmp/ralph-e2e-it${args.iterationNum}.log) ===\n${args.e2eLog}\n=== End e2e log ===\n`
    : "";

  return `=== Issue spec (pre-fetched) ===
${args.issueBody}
=== End issue spec ===
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
 */
export function buildFixerBriefing(args: FixerBriefingArgs): string {
  const reviewerSection = args.prevReviewerText
    ? `\n=== Prior reviewer findings ===\n${args.prevReviewerText}\n=== End prior reviewer findings ===\n`
    : "";

  return `${reviewerSection}
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
