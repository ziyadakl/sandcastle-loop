/**
 * Smoke assertions (v1.1 — runLoop-driven).
 *
 * The legacy prd.json-based assertions are gone. v1.1 routes story state
 * through GH labels (claimViaLabel / markDoneViaLabel / quarantineViaLabel)
 * and the smoke captures those calls via a `gh` PATH stub.
 *
 * Each function returns either an error message (failure) or null (pass).
 * The runner drains every assertion before printing — failures aren't
 * short-circuited so a single regression doesn't mask others.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IterationResult } from "../../src/types.js";
import type {
  MockCallRecord,
  MockSandbox,
  AgentRole as MockAgentRole,
} from "./mocks/mock-sandbox.js";

const execFileP = promisify(execFile);

export class AssertionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

/**
 * Witness data the run-smoke harness collects from runLoop's test seams.
 * Threaded through to expectations so each check can assert against the
 * loop's actual behavior (not a side-channel reconstruction).
 */
export interface RunLoopArtifacts {
  readonly iterationResults: readonly IterationResult[];
  readonly plannerCallCount: number;
  readonly listReadyCalls: number;
  readonly listInProgressCalls: number;
  readonly transitionCalls: ReadonlyArray<{
    issueNum: number;
    from: string;
    to: string;
  }>;
  readonly fetchIssueBodyCalls: readonly number[];
  readonly isIssueDoneCalls: readonly number[];
  readonly commentOnIssueCalls: ReadonlyArray<{
    issueNum: number;
    body: string;
  }>;
  readonly withSingleInstanceCalls: number;
  /**
   * Every per-role agent prompt that flowed through `_agentRunner`. Used by
   * the byte-offset locality assertions.
   */
  readonly promptCaptures: ReadonlyArray<{
    role: MockAgentRole;
    prompt: string;
  }>;
  /** The canned issue body the smoke fed to the loop — assertions look for it verbatim. */
  readonly issueBody: string;
}

export interface ExpectationContext {
  readonly repoRoot: string;
  readonly sandbox: MockSandbox;
  readonly storyId: string;
  readonly ghIssue: number;
  /** Calls the smoke runner observed against the gh PATH stub. */
  readonly ghCalls: readonly { readonly args: readonly string[] }[];
  readonly artifacts: RunLoopArtifacts;
}

/**
 * Wave-1 N1 smoke variant context. Same shape as ExpectationContext for the
 * green-path smoke; the variant assertions (runInvalidJsonExpectations)
 * inspect the same `ghCalls` + `sandbox.sandboxRunCalls` + `artifacts` to
 * prove the loop quarantined instead of shipping when the implementer's
 * STORY_COMPLETE envelope was unparseable.
 */
export type InvalidJsonExpectationContext = ExpectationContext;

/**
 * Result of a full assertion pass — every failure message in order. Empty
 * `failures` means PASS; any entry means FAIL.
 */
export interface ExpectationReport {
  readonly failures: readonly string[];
  readonly checks: readonly string[];
}

// ---------------------------------------------------------------------------
// gh-stub introspection helpers
// ---------------------------------------------------------------------------

/**
 * The gh-stub records each invocation as `{ args: [...] }`. Track D's
 * label transitions issue this argv shape for claim:
 *   gh issue edit <num> --add-label in-progress --remove-label ready-for-agent
 * for markDone (label flip leg):
 *   gh issue edit <num> --add-label done --remove-label in-progress
 * for markDone (close leg):
 *   gh issue close <num> --comment <summary>
 * for quarantine (label flip leg):
 *   gh issue edit <num> --add-label needs-human --remove-label in-progress
 *
 * The helpers below count occurrences of each pattern. They're tolerant of
 * argv reordering (--add-label and --remove-label may appear in either
 * order) but strict about the issue number and the actual label values.
 */

function isLabelEdit(
  call: { readonly args: readonly string[] },
  issueNum: number,
  addLabel: string,
  removeLabel: string,
): boolean {
  const a = call.args;
  if (a[0] !== "issue" || a[1] !== "edit" || a[2] !== String(issueNum)) {
    return false;
  }
  // Flag-pair scan, order-independent.
  let foundAdd = false;
  let foundRemove = false;
  for (let i = 3; i < a.length - 1; i += 1) {
    if (a[i] === "--add-label" && a[i + 1] === addLabel) foundAdd = true;
    if (a[i] === "--remove-label" && a[i + 1] === removeLabel) foundRemove = true;
  }
  return foundAdd && foundRemove;
}

function isIssueClose(
  call: { readonly args: readonly string[] },
  issueNum: number,
): boolean {
  return (
    call.args[0] === "issue" &&
    call.args[1] === "close" &&
    call.args[2] === String(issueNum)
  );
}

// ---------------------------------------------------------------------------
// Individual assertions — each returns an error message or null.
// ---------------------------------------------------------------------------

function checkIterationResults(ctx: ExpectationContext): string | null {
  const results = ctx.artifacts.iterationResults;
  if (results.length !== 1) {
    return `Expected runLoop to return exactly 1 IterationResult, got ${results.length}.`;
  }
  const only = results[0]!;
  if (only.outcome !== "shipped") {
    return `Expected outcome="shipped", got "${only.outcome}".`;
  }
  return null;
}

function checkClaimViaLabelOnce(ctx: ExpectationContext): string | null {
  const matches = ctx.ghCalls.filter((c) =>
    isLabelEdit(c, ctx.ghIssue, "in-progress", "ready-for-agent"),
  );
  if (matches.length === 0) {
    return `claimViaLabel(${ctx.ghIssue}) was never invoked. Expected exactly one ` +
      `gh issue edit ${ctx.ghIssue} --add-label in-progress --remove-label ready-for-agent.`;
  }
  if (matches.length > 1) {
    return `claimViaLabel(${ctx.ghIssue}) was invoked ${matches.length} times; expected exactly 1.`;
  }
  return null;
}

function checkMarkDoneViaLabelOnce(ctx: ExpectationContext): string | null {
  const flipMatches = ctx.ghCalls.filter((c) =>
    isLabelEdit(c, ctx.ghIssue, "done", "in-progress"),
  );
  if (flipMatches.length === 0) {
    return `markDoneViaLabel(${ctx.ghIssue}) was never invoked. Expected one ` +
      `gh issue edit ${ctx.ghIssue} --add-label done --remove-label in-progress.`;
  }
  if (flipMatches.length > 1) {
    return `markDoneViaLabel(${ctx.ghIssue}) was invoked ${flipMatches.length} times; expected exactly 1.`;
  }
  // markDoneViaLabel pairs the label flip with a closeIssue (with --comment summary).
  const closeMatches = ctx.ghCalls.filter(
    (c) =>
      isIssueClose(c, ctx.ghIssue) &&
      c.args.includes("--comment") &&
      // A summary must be non-empty (the loop passes its own iteration narrative).
      c.args.some(
        (s, i) =>
          i > 0 && c.args[i - 1] === "--comment" && typeof s === "string" && s.length > 0,
      ),
  );
  if (closeMatches.length !== 1) {
    return `Expected exactly one 'gh issue close ${ctx.ghIssue} --comment <summary>' to follow the label flip; got ${closeMatches.length}.`;
  }
  return null;
}

function checkQuarantineNeverCalled(ctx: ExpectationContext): string | null {
  const quarantineFlips = ctx.ghCalls.filter((c) =>
    isLabelEdit(c, ctx.ghIssue, "needs-human", "in-progress"),
  );
  if (quarantineFlips.length > 0) {
    return `quarantineViaLabel(${ctx.ghIssue}) was invoked ${quarantineFlips.length} time(s); expected 0 on the green path.`;
  }
  return null;
}

function checkPlannerCalledOnce(ctx: ExpectationContext): string | null {
  if (ctx.artifacts.plannerCallCount !== 1) {
    return `Expected runPlanner to be called exactly 1 time per loop wake-up (Fix #2); got ${ctx.artifacts.plannerCallCount}.`;
  }
  return null;
}

function checkImplementerPromptIncludesIssueBody(
  ctx: ExpectationContext,
): string | null {
  const implCalls = ctx.artifacts.promptCaptures.filter(
    (c) => c.role === "implementer",
  );
  if (implCalls.length === 0) {
    return `No implementer prompt was captured.`;
  }
  const prompt = implCalls[0]!.prompt;
  if (!prompt.includes(ctx.artifacts.issueBody)) {
    return `Implementer prompt does NOT include the issue body verbatim.`;
  }
  return null;
}

function checkReviewerPromptIncludesIssueBodyAtSameOffset(
  ctx: ExpectationContext,
): string | null {
  const implCalls = ctx.artifacts.promptCaptures.filter(
    (c) => c.role === "implementer",
  );
  const revCalls = ctx.artifacts.promptCaptures.filter(
    (c) => c.role === "reviewer",
  );
  if (implCalls.length === 0) {
    return `No implementer prompt captured to compare against.`;
  }
  if (revCalls.length === 0) {
    return `No reviewer prompt was captured.`;
  }
  const implPrompt = implCalls[0]!.prompt;
  const revPrompt = revCalls[0]!.prompt;
  const implOffset = implPrompt.indexOf(ctx.artifacts.issueBody);
  const revOffset = revPrompt.indexOf(ctx.artifacts.issueBody);
  if (implOffset === -1) {
    return `Implementer prompt missing issue body (cannot compute offset).`;
  }
  if (revOffset === -1) {
    return `Reviewer prompt does NOT include the issue body verbatim.`;
  }
  if (implOffset !== revOffset) {
    return `Issue body offset differs between implementer (${implOffset}) and reviewer (${revOffset}); the prompt-cache prefix contract requires identical offsets.`;
  }
  return null;
}

async function checkProgressTxtIterationLine(
  ctx: ExpectationContext,
): Promise<string | null> {
  const progressPath = path.join(ctx.repoRoot, "progress.txt");
  let raw: string;
  try {
    raw = await fs.readFile(progressPath, "utf8");
  } catch (err) {
    return `progress.txt missing or unreadable at ${progressPath}: ${(err as Error).message}`;
  }
  if (!/\[it=\d+\]/.test(raw)) {
    return `progress.txt does not contain a '[it=N]' iteration marker. Got:\n${raw}`;
  }
  return null;
}

function checkReviewerPromptIncludesProgressTail(
  ctx: ExpectationContext,
): string | null {
  // The driver writes one '[it=N] ... — implementer commit <sha>' line BEFORE
  // the reviewer briefing is built, so the reviewer's prompt MUST include the
  // sprint-progress block (formatProgressBlock — non-empty when progressTail
  // is non-empty).
  const revCalls = ctx.artifacts.promptCaptures.filter(
    (c) => c.role === "reviewer",
  );
  if (revCalls.length === 0) {
    return `No reviewer prompt was captured.`;
  }
  const revPrompt = revCalls[0]!.prompt;
  if (!revPrompt.includes("=== Sprint progress")) {
    return `Reviewer prompt does NOT include the progress.txt tail block ` +
      `('=== Sprint progress' header missing).`;
  }
  // And specifically: the iteration-marker line the driver wrote.
  if (!/\[it=\d+\]/.test(revPrompt)) {
    return `Reviewer prompt's sprint-progress block does NOT contain a '[it=N]' line.`;
  }
  return null;
}

async function checkNoLeakedLock(
  ctx: ExpectationContext,
): Promise<string | null> {
  // The runLoop's single-instance lock was no-opped via _withSingleInstance
  // in this smoke (so the .lock dir is never created), but the iteration also
  // touches no per-mutation prd.json lock. Just confirm no `.sandcastle.lock`
  // OR `prd.json.lock` directory exists at the temp repoRoot.
  const candidates = [
    path.join(ctx.repoRoot, ".sandcastle.lock"),
    path.join(ctx.repoRoot, ".sandcastle.lock.lock"),
    path.join(ctx.repoRoot, "prd.json.lock"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return `Leaked lockfile / lockdir at ${candidate} after runLoop exit.`;
    } catch {
      // expected
    }
  }
  return null;
}

async function checkAtLeastOneCommit(
  ctx: ExpectationContext,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["rev-list", "--count", "HEAD"], {
      cwd: ctx.repoRoot,
    });
    const count = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(count) || count < 1) {
      return `Expected at least 1 commit on the branch, got '${stdout.trim()}'.`;
    }
    return null;
  } catch (err) {
    return `git rev-list failed in ${ctx.repoRoot}: ${(err as Error).message}`;
  }
}

function checkCallOrder(ctx: ExpectationContext): string | null {
  const expected = ["implementer", "reviewer"] as const;
  const observed = ctx.sandbox.calls.map((c: MockCallRecord) => c.role);
  for (let i = 0; i < expected.length; i += 1) {
    if (observed[i] !== expected[i]) {
      return `Expected agent call sequence to start with [${expected.join(", ")}], got [${observed.join(", ")}].`;
    }
  }
  return null;
}

function checkNoCommentOnIssue(ctx: ExpectationContext): string | null {
  // Green path never ships-with-issue-OPEN, so _commentOnIssue should never fire.
  const comments = ctx.artifacts.commentOnIssueCalls;
  if (comments.length > 0) {
    return `Expected 0 ship-with-issue-OPEN comments on the green path; got ${comments.length}: ${JSON.stringify(comments)}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public driver
// ---------------------------------------------------------------------------

export async function runAllExpectations(
  ctx: ExpectationContext,
): Promise<ExpectationReport> {
  const checks: string[] = [];
  const failures: string[] = [];

  const cases: Array<{
    name: string;
    fn: () => Promise<string | null> | string | null;
  }> = [
    { name: "runLoop returned IterationResult[] length=1, outcome=shipped", fn: () => checkIterationResults(ctx) },
    { name: "runPlanner called exactly once per loop wake-up", fn: () => checkPlannerCalledOnce(ctx) },
    { name: "claimViaLabel(999) called exactly once", fn: () => checkClaimViaLabelOnce(ctx) },
    { name: "markDoneViaLabel(999, ...) called exactly once with non-empty summary", fn: () => checkMarkDoneViaLabelOnce(ctx) },
    { name: "quarantineViaLabel never called on green path", fn: () => checkQuarantineNeverCalled(ctx) },
    { name: "implementer prompt includes issue body verbatim", fn: () => checkImplementerPromptIncludesIssueBody(ctx) },
    { name: "reviewer prompt includes issue body at same byte offset", fn: () => checkReviewerPromptIncludesIssueBodyAtSameOffset(ctx) },
    { name: "progress.txt has at least one [it=N] line", fn: () => checkProgressTxtIterationLine(ctx) },
    { name: "reviewer prompt includes progress.txt tail block", fn: () => checkReviewerPromptIncludesProgressTail(ctx) },
    { name: "no leaked lockfiles in repo root", fn: () => checkNoLeakedLock(ctx) },
    { name: "at least one commit on branch", fn: () => checkAtLeastOneCommit(ctx) },
    { name: "agent call order: implementer -> reviewer", fn: () => checkCallOrder(ctx) },
    { name: "no ship-with-issue-OPEN comments on green path", fn: () => checkNoCommentOnIssue(ctx) },
  ];

  for (const c of cases) {
    checks.push(c.name);
    const result = await c.fn();
    if (result !== null) {
      failures.push(`${c.name}: ${result}`);
    }
  }

  return { checks, failures };
}

// ---------------------------------------------------------------------------
// Wave-1 N1 smoke variant: implementer emits STORY_COMPLETE with an
// unparseable JSON envelope. The loop MUST NOT ship; it MUST route to
// recovery, recovery (with the stub sandbox.run() throwing) MUST end in HALT,
// and the iteration MUST quarantine via label `in-progress` -> `needs-human`.
//
// These assertions are the inverse of the green-path: shipped is now FAIL,
// markDoneViaLabel firing is FAIL, the issue being closed is FAIL, and the
// presence of a `needs-human` label transition is REQUIRED.
// ---------------------------------------------------------------------------

function checkInvalidJson_outcomeHalted(
  ctx: InvalidJsonExpectationContext,
): string | null {
  const results = ctx.artifacts.iterationResults;
  if (results.length !== 1) {
    return `Expected runLoop to return exactly 1 IterationResult, got ${results.length}.`;
  }
  const only = results[0]!;
  // iteration.ts:786 returns `halted(...)` when recovery decides HALT after
  // an implementer error path. (Compare: implementer-HALT marker without
  // recovery returns `quarantined`; the bad-JSON path takes the
  // implementerError branch first, so the outcome is `halted`.)
  if (only.outcome !== "halted") {
    return `Expected outcome="halted" (recovery HALT after implementer JSON parse fail), got "${only.outcome}".`;
  }
  return null;
}

function checkInvalidJson_notShipped(
  ctx: InvalidJsonExpectationContext,
): string | null {
  const shipped = ctx.artifacts.iterationResults.filter(
    (r) => r.outcome === "shipped",
  );
  if (shipped.length > 0) {
    return `Expected NO shipped IterationResults; got ${shipped.length}. The bad-JSON envelope must NOT ship the story.`;
  }
  return null;
}

function checkInvalidJson_markDoneNeverCalled(
  ctx: InvalidJsonExpectationContext,
): string | null {
  // markDoneViaLabel emits `gh issue edit <num> --add-label done --remove-label in-progress`.
  const flips = ctx.ghCalls.filter((c) =>
    isLabelEdit(c, ctx.ghIssue, "done", "in-progress"),
  );
  if (flips.length > 0) {
    return `markDoneViaLabel(${ctx.ghIssue}) was invoked ${flips.length} time(s); expected 0 — the bad-JSON path must NOT mark done.`;
  }
  return null;
}

function checkInvalidJson_quarantineCalled(
  ctx: InvalidJsonExpectationContext,
): string | null {
  // quarantineViaLabel emits `gh issue edit <num> --add-label needs-human --remove-label in-progress`
  // followed by `gh issue comment <num> --body <reason>`. Assert the label
  // transition fired at least once.
  const flips = ctx.ghCalls.filter((c) =>
    isLabelEdit(c, ctx.ghIssue, "needs-human", "in-progress"),
  );
  if (flips.length === 0) {
    return `quarantineViaLabel(${ctx.ghIssue}) was never invoked. Expected at least one ` +
      `gh issue edit ${ctx.ghIssue} --add-label needs-human --remove-label in-progress.`;
  }
  return null;
}

function checkInvalidJson_labelTransitionInProgressToNeedsHuman(
  ctx: InvalidJsonExpectationContext,
): string | null {
  // Strict re-check of the state-machine edge: there must exist a gh argv
  // that adds `needs-human` AND removes `in-progress` (in either order) for
  // the smoke issue. This is the load-bearing routing claim.
  const transitions = ctx.ghCalls.filter((c) =>
    isLabelEdit(c, ctx.ghIssue, "needs-human", "in-progress"),
  );
  if (transitions.length < 1) {
    return `Label state-machine transition 'in-progress' -> 'needs-human' did NOT happen for issue ${ctx.ghIssue}.`;
  }
  return null;
}

function checkInvalidJson_issueNotClosed(
  ctx: InvalidJsonExpectationContext,
): string | null {
  // quarantineViaLabel deliberately does NOT close the issue (gh.ts:505 NB
  // comment). Assert no `gh issue close <num>` was emitted.
  const closes = ctx.ghCalls.filter((c) => isIssueClose(c, ctx.ghIssue));
  if (closes.length > 0) {
    return `Expected 0 'gh issue close ${ctx.ghIssue}' calls; got ${closes.length}. Quarantine must leave the issue OPEN for human triage.`;
  }
  return null;
}

function checkInvalidJson_recoveryAgentInvoked(
  ctx: InvalidJsonExpectationContext,
): string | null {
  // The recovery ladder calls `sandbox.run()` directly (not through
  // _agentRunner — see recovery/ladder.ts:280, :943). On the bad-JSON path,
  // both the Sonnet and the Opus xhigh attempt should be invoked; each one
  // increments the stub's run-call counter before throwing. Assert >= 1.
  const runCount = ctx.sandbox.sandboxRunCalls;
  if (runCount < 1) {
    return `Recovery agent was NOT invoked: sandbox.run() was called 0 times. Expected at least 1 (Sonnet attempt) — the recovery ladder didn't fire.`;
  }
  return null;
}

function checkInvalidJson_implementerCalledOnce(
  ctx: InvalidJsonExpectationContext,
): string | null {
  // The implementer mock should have been called exactly once (the bad
  // envelope makes runImplementer throw, so iteration.ts skips the reviewer
  // entirely and goes straight to the recovery ladder).
  const implCalls = ctx.sandbox.calls.filter((c) => c.role === "implementer");
  if (implCalls.length !== 1) {
    return `Expected exactly 1 implementer call; got ${implCalls.length}.`;
  }
  return null;
}

function checkInvalidJson_reviewerNeverCalled(
  ctx: InvalidJsonExpectationContext,
): string | null {
  // The bad-JSON path throws inside runImplementer BEFORE the reviewer ladder
  // is reached — so the reviewer mock must NEVER be invoked. If the reviewer
  // fires, that means the loop accepted the bad envelope and proceeded to
  // ship review (the very regression Wave 1 N1 prevents).
  const revCalls = ctx.sandbox.calls.filter(
    (c) => c.role === "reviewer" || c.role === "final-reviewer",
  );
  if (revCalls.length > 0) {
    return `Reviewer was invoked ${revCalls.length} time(s). The bad-JSON envelope must abort BEFORE the reviewer ladder runs.`;
  }
  return null;
}

function checkInvalidJson_claimViaLabel(
  ctx: InvalidJsonExpectationContext,
): string | null {
  // The loop still claims the issue (`ready-for-agent` -> `in-progress`)
  // before the implementer runs — so this transition MUST appear once in the
  // gh-stub log. Without it, the subsequent quarantine flip would have
  // nothing to remove.
  const matches = ctx.ghCalls.filter((c) =>
    isLabelEdit(c, ctx.ghIssue, "in-progress", "ready-for-agent"),
  );
  if (matches.length !== 1) {
    return `claimViaLabel(${ctx.ghIssue}) expected exactly 1 invocation, got ${matches.length}.`;
  }
  return null;
}

export async function runInvalidJsonExpectations(
  ctx: InvalidJsonExpectationContext,
): Promise<ExpectationReport> {
  const checks: string[] = [];
  const failures: string[] = [];

  const cases: Array<{
    name: string;
    fn: () => Promise<string | null> | string | null;
  }> = [
    {
      name: "iteration outcome is 'halted' (recovery HALT after implementer JSON parse fail)",
      fn: () => checkInvalidJson_outcomeHalted(ctx),
    },
    {
      name: "no IterationResult with outcome='shipped'",
      fn: () => checkInvalidJson_notShipped(ctx),
    },
    {
      name: "claimViaLabel(999) called exactly once (issue was claimed before failure)",
      fn: () => checkInvalidJson_claimViaLabel(ctx),
    },
    {
      name: "implementer called exactly once",
      fn: () => checkInvalidJson_implementerCalledOnce(ctx),
    },
    {
      name: "reviewer NEVER called (bad envelope aborts before review ladder)",
      fn: () => checkInvalidJson_reviewerNeverCalled(ctx),
    },
    {
      name: "recovery agent invoked (sandbox.run() called at least once)",
      fn: () => checkInvalidJson_recoveryAgentInvoked(ctx),
    },
    {
      name: "markDoneViaLabel NEVER called (bad-JSON must not mark done)",
      fn: () => checkInvalidJson_markDoneNeverCalled(ctx),
    },
    {
      name: "quarantineViaLabel called (label flipped to needs-human)",
      fn: () => checkInvalidJson_quarantineCalled(ctx),
    },
    {
      name: "label state machine: in-progress -> needs-human transition fired",
      fn: () => checkInvalidJson_labelTransitionInProgressToNeedsHuman(ctx),
    },
    {
      name: "issue NOT closed (gh issue close was never invoked)",
      fn: () => checkInvalidJson_issueNotClosed(ctx),
    },
  ];

  for (const c of cases) {
    checks.push(c.name);
    const result = await c.fn();
    if (result !== null) {
      failures.push(`${c.name}: ${result}`);
    }
  }

  return { checks, failures };
}
