/**
 * Single-iteration state machine — one full Pick→Impl→Review→Fix(≤2)→FinalPass
 * cycle. Mirrors the body of the bash `for it in $(seq 1 "$ITERATIONS")` loop
 * (afk-ralph.sh:428–832), one cycle per call.
 *
 * State transitions (one line each):
 *
 *   START      -> CLAIM     (Track D pickNextEligibleStory)
 *   CLAIM(none)-> NO_STORY  (caller stops the outer loop)
 *   CLAIM      -> CAPTURE_PRE_SHA (driver-side `git rev-parse HEAD`)
 *   CAPTURE    -> IMPLEMENT (runImplementer)
 *   IMPLEMENT(error)        -> RECOVERY      (Track E runRecoveryDiagnosisOrEscalate)
 *   IMPLEMENT(HALT,no_commit) -> QUARANTINE  (deliberate HALT — no recovery,
 *                                             attempts:1, recovery is for
 *                                             timeouts/crashes only)
 *   IMPLEMENT(HALT,commit)  -> QUARANTINE    (commit stays on branch but
 *                                             issue is left OPEN, no markDone,
 *                                             no closeIssue)
 *   IMPLEMENT(STORY_COMPLETE,no_commit) -> SKIPPED
 *   IMPLEMENT(STORY_COMPLETE,commit) -> APPLY_MIGRATIONS -> REVIEW
 *   RECOVERY(HALT)          -> QUARANTINE    (deliberate)
 *   RECOVERY(committed)     -> APPLY_MIGRATIONS -> REVIEW
 *   RECOVERY(no_commit)     -> SKIPPED
 *   APPLY_MIGRATIONS(realErrors > 0) -> QUARANTINE (migration failed)
 *   REVIEW(ALL_CLEAR)       -> SHIP          (markDone + closeIssue)
 *   REVIEW(HAS_BLOCKERS,a=1)-> FIX(1)
 *   REVIEW(HAS_BLOCKERS,a=2)-> FIX(2)        (Opus tier-escalated)
 *   FIX(2,!=FIXED)          -> SHIP_OPEN     (mark done, leave issue OPEN, comment concerns)
 *   FIX(2,FIXED)            -> APPLY_MIGRATIONS -> FINAL_PASS
 *   FINAL_PASS(ALL_CLEAR)   -> SHIP
 *   FINAL_PASS(HAS_BLOCKERS)-> SHIP_OPEN
 *
 * Outcomes returned to runLoop:
 *   shipped        — story marked done, issue closed (or shipped with issue
 *                    OPEN; the loop circuit-breaker treats both as success
 *                    because a commit landed)
 *   skipped        — no commit landed, no work to review. The circuit
 *                    breaker treats this as neither failure nor success
 *                    (verification-only iteration).
 *   quarantined    — story moved to status=quarantined (Track E)
 *   halted         — recovery ladder said HALT, deliberate halt
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Sandbox } from "@ai-hero/sandcastle";
import type {
  IterationContext,
  IterationResult,
  LoopConfig,
  ModelTier,
  Story,
} from "../types.js";
import { MarkerNotFoundError } from "../verdicts/index.js";
import {
  runImplementer,
  runReviewer,
  runFixer,
  runFinalReviewer,
} from "./agents.js";
import {
  buildImplementerBriefing,
  buildReviewerBriefing,
  buildFixerBriefing,
  type IssueRef,
} from "./briefing.js";

// Track D — backlog state. Routed through the barrel per Fix #8.
import {
  pickNextEligibleStory,
  markDone,
  closeIssue,
} from "../state/index.js";

// Track E — V1-D refactor: the multi-step recovery ladder is replaced by the
// new diagnosis-first ladder, exposed as runRecoveryDiagnosisOrEscalate. Same
// call signature as the legacy runRecoveryLadder; the semantics differ inside
// V1-D but the integration point here is unchanged.
import {
  runRecoveryDiagnosisOrEscalate,
  quarantineStory,
} from "../recovery/index.js";

// Track F — drizzle migration auto-applier via the barrel.
import { applyMigrationsBetween } from "../migrations/index.js";

const execFileP = promisify(execFile);

/**
 * Optional smoke-test injection seam (Bonus Fix). When provided, wraps every
 * underlying `sandbox.run()` call so a smoke harness can supply canned outputs
 * without spinning up Docker.
 *
 * The shape mirrors what agents.ts needs: the per-role marker plus the
 * `SandboxRunResult` slice the loop reads from (stdout + commits +
 * completionSignal).
 */
export type AgentRunner = (
  role: "implementer" | "reviewer" | "fixer" | "final-reviewer",
  model: ModelTier,
  prompt: string,
) => Promise<{
  stdout: string;
  commits: { sha: string }[];
  completionSignal?: string;
}>;

export interface RunIterationArgs {
  sandbox: Sandbox;
  iterationNum: number;
  iterationTotal: number;
  config: LoopConfig;
  /**
   * Path to the recovery prompt template (refs/recovery-prompt.md.local-fork
   * after Track A wires it up). Track E reads this file at call time.
   */
  recoveryPromptPath: string;
  /**
   * Test seam: post a comment on a GH issue. Default uses `gh issue comment`
   * via execFile. Tests inject a stub.
   */
  _commentOnIssue?: (issueNum: number, body: string) => Promise<void>;
  /**
   * Smoke test seam: replace `sandbox.run()` with a canned per-role runner.
   * @internal
   */
  _agentRunner?: AgentRunner;
  /**
   * Test seam: replace the default `gh issue view` issue-fetcher. Production
   * calls `fetchIssueBody` (defined below) which shells out to `gh`.
   * @internal
   */
  _fetchIssueBody?: (ghIssue: number) => Promise<IssueRef>;
}

/**
 * `null` outcome means no story was claimable — the outer loop should stop
 * early because the PRD is drained. All other outcomes return a populated
 * IterationResult.
 */
export type IterationOutcome = IterationResult | { type: "no_story" };

/**
 * Driver-side signal scan: did the SPEC contain a `playwright test` command?
 * Mirrors bash `grep -qE 'playwright test'` at afk-ralph.sh:467. Pure-string
 * predicate — no I/O.
 */
function specRequiresPlaywright(issueBody: string): boolean {
  return /playwright test/.test(issueBody);
}

/**
 * V1-B refactor — pre-fetch the GH issue title + body + labels + number in
 * ONE call at iteration start. The result is embedded VERBATIM at the same
 * position in all three agent prompts (implementer, reviewer, fixer) for
 * prompt-cache locality across the iteration.
 *
 * Defined locally in `loop/` rather than added to `state/` because this is a
 * driver-only concern: the state module's `getIssueBody` returns a single
 * string body (used elsewhere); the driver wants the full snapshot here.
 */
export async function fetchIssueBody(ghIssue: number): Promise<IssueRef> {
  if (!Number.isInteger(ghIssue) || ghIssue <= 0) {
    // Defensive — story.ghIssue can be 0/undefined for legacy prd.json
    // entries, in which case the caller substitutes an empty IssueRef.
    return { title: "", body: "", labels: [], number: ghIssue };
  }
  const { stdout } = await execFileP(
    "gh",
    ["issue", "view", String(ghIssue), "--json", "title,body,labels,number"],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  // gh returns either the requested fields as JSON or fails non-zero. Parse
  // defensively — labels are objects with .name, but we only need the names.
  type GhLabel = { name?: string };
  type GhView = {
    title?: string;
    body?: string;
    labels?: GhLabel[];
    number?: number;
  };
  let parsed: GhView;
  try {
    parsed = JSON.parse(stdout) as GhView;
  } catch (err) {
    throw new Error(
      `fetchIssueBody(${ghIssue}): gh returned non-JSON output: ${(err as Error).message}`,
    );
  }
  return {
    title: typeof parsed.title === "string" ? parsed.title : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
    labels: Array.isArray(parsed.labels)
      ? parsed.labels
          .map((l) => (typeof l?.name === "string" ? l.name : ""))
          .filter((n) => n.length > 0)
      : [],
    number: typeof parsed.number === "number" ? parsed.number : ghIssue,
  };
}

/**
 * Resolve the current commit SHA on the worktree. Matches bash:
 *   PRE_SHA=$(git log -1 --format=%H)   (afk-ralph.sh ~L450)
 *   POST_SHA=$(git log -1 --format=%H)  (afk-ralph.sh ~L660)
 *
 * `git rev-parse HEAD` is equivalent and one fewer fork. Throws on git failure
 * — the loop can't function without a real preSha (the migration applier and
 * UI-diff probe both depend on it).
 */
async function gitRevParseHead(repoRoot: string): Promise<string> {
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    timeout: 30_000,
    maxBuffer: 1 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Fix #5 — driver-side ground-truth probe: did the diff between two SHAs
 * touch any UI file (.tsx / .jsx / .vue)? This replaces the implementer's
 * self-attestation, which the bash version already mistrusted (the implementer
 * agent has a documented incentive to claim "non-UI story" so the certification
 * checkboxes can be skipped).
 *
 * Mirrors bash `git diff --name-only --diff-filter=AM PRE..HEAD -- '*.tsx' '*.jsx' '*.vue'`
 * around afk-ralph.sh:678–691.
 */
async function gitDiffTouchedUi(
  repoRoot: string,
  preSha: string,
  postSha: string,
): Promise<boolean> {
  if (preSha === postSha) return false;
  const { stdout } = await execFileP(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=AM",
      `${preSha}..${postSha}`,
      "--",
      "*.tsx",
      "*.jsx",
      "*.vue",
    ],
    {
      cwd: repoRoot,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return stdout.trim().length > 0;
}

/**
 * V1-B refactor — total insertions+deletions between two SHAs. Drives the
 * reviewer's effort scaling (small diff → low effort; large diff → high).
 * Parses `git diff --shortstat`'s "N insertions(+), M deletions(-)" trailer.
 *
 * Returns 0 when the two SHAs match (no diff) or when shortstat returns no
 * recognizable trailer (e.g. only a binary-file change).
 */
export async function getDiffLineCount(
  repoRoot: string,
  preSha: string,
  postSha: string,
): Promise<number> {
  if (preSha === postSha) return 0;
  const { stdout } = await execFileP(
    "git",
    ["diff", "--shortstat", `${preSha}..${postSha}`],
    {
      cwd: repoRoot,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  // Sample shortstat output: " 3 files changed, 47 insertions(+), 8 deletions(-)"
  const insMatch = /(\d+)\s+insertion/.exec(stdout);
  const delMatch = /(\d+)\s+deletion/.exec(stdout);
  const ins = insMatch ? Number(insMatch[1]) : 0;
  const del = delMatch ? Number(delMatch[1]) : 0;
  return ins + del;
}

export async function runIteration(
  args: RunIterationArgs,
): Promise<IterationOutcome> {
  const repoRoot = args.config.repoRoot;
  const commentPoster = args._commentOnIssue ?? defaultCommentPoster();
  const fetchIssue = args._fetchIssueBody ?? fetchIssueBody;

  // === Step 1: claim ==========================================================
  const story = await pickNextEligibleStory(repoRoot);
  if (!story) return { type: "no_story" };

  const ghIssue = story.ghIssue ?? 0;
  // V1-B refactor — pre-fetch the issue snapshot ONCE, embed verbatim at the
  // SAME position in all three agent prompts. If gh fails (network, auth) we
  // fall back to an empty snapshot rather than 3x the failure cost.
  let issue: IssueRef;
  try {
    issue = await fetchIssue(ghIssue);
  } catch (err) {
    process.stderr.write(
      `WARN: fetchIssueBody(${ghIssue}) failed; proceeding with empty spec: ${
        (err as Error).message
      }\n`,
    );
    issue = {
      title: story.title,
      body: "",
      labels: [],
      number: ghIssue,
    };
  }
  const specReqPw = specRequiresPlaywright(issue.body);

  // Fix #4 — capture preSha BEFORE the implementer runs so we can diff
  // commits-this-iteration for migrations + UI ground truth.
  let preSha: string;
  try {
    preSha = await gitRevParseHead(repoRoot);
  } catch (err) {
    // If we can't even read HEAD, the worktree is broken — quarantine the
    // story rather than entering a half-instrumented iteration.
    await quarantineStory(
      repoRoot,
      story,
      `pre-iteration git rev-parse HEAD failed: ${errorMessage(err)}`,
    );
    return quarantined(story, args.iterationNum);
  }

  // === Step 2: implement ======================================================
  const implPrompt = buildImplementerBriefing({
    story,
    ghIssue,
    iterationNum: args.iterationNum,
    iterationTotal: args.iterationTotal,
    issue,
  });

  const ctx: IterationContext = {
    iterNum: args.iterationNum,
    iterTotal: args.iterationTotal,
    story,
    branch: args.sandbox.branch,
    preSha,
    startedAt: Date.now(),
  };

  let lastCommitSha: string | undefined;
  // Fix #5 — driver-computed ground truth. Re-derived after every
  // commit-landing event from a real `git diff`; never sourced from the
  // implementer's self-attestation.
  let commitTouchedUi = false;

  let implementerHaltMarker = false;
  let implementerHaltReason: string | undefined;
  let implementerError: Error | undefined;

  try {
    const impl = await runImplementer({
      sandbox: args.sandbox,
      prompt: implPrompt,
      config: args.config,
      iterationNum: args.iterationNum,
      story: { id: story.id, ghIssue },
      _agentRunner: args._agentRunner,
    });
    lastCommitSha = impl.output?.commitSha ?? impl.raw.commits.at(-1)?.sha;
    if (impl.marker === "HALT") {
      implementerHaltMarker = true;
      implementerHaltReason =
        impl.output?.haltReason ?? "implementer emitted HALT";
    }
  } catch (err) {
    // Either the agent timed out (AbortError), no marker was found, or the
    // sandbox runner itself threw. All three are recoverable through the
    // Track E ladder — recovery exists for crash/timeout/parse-fail, NOT for
    // a deliberate `<promise>HALT</promise>` (Fix #14).
    implementerError = err instanceof Error ? err : new Error(String(err));
  }

  // === Fix #14: implementer HALT path skips recovery =========================
  // Bash treats deliberate HALT as "stop, don't retry, quarantine for human
  // review" — see afk-ralph.sh ~L575. Recovery is for crash/timeout/parse-fail.
  if (implementerHaltMarker) {
    if (lastCommitSha) {
      // Commit landed BUT implementer chose to stop. Quarantine — but the
      // commit stays on the branch and we deliberately do NOT closeIssue or
      // markDone. The story is left in `quarantined` state so a human can
      // decide what to do with the partial work.
      await quarantineStory(
        repoRoot,
        story,
        `implementer HALT (with partial commit ${lastCommitSha}): ${
          implementerHaltReason ?? "(no reason)"
        }`,
        // Bash:573 records this as 1 attempt — implementer ran once, no
        // recovery follow-up.
        // (quarantineStory falls back to story.attempts ?? 1 if attempts
        // is omitted; we set it explicitly so behavior is unambiguous.)
      );
      return quarantined(story, args.iterationNum);
    }
    await quarantineStory(
      repoRoot,
      story,
      `implementer HALT: ${implementerHaltReason ?? "(no reason)"}`,
    );
    return quarantined(story, args.iterationNum);
  }

  // === Implementer ERROR path: recovery ladder ===============================
  if (implementerError) {
    const recovery = await runRecoveryDiagnosisOrEscalate(
      args.sandbox,
      ctx,
      {
        reason: implementerError.message,
        priorWho: "implementer",
      },
      {
        promptTemplatePath: args.recoveryPromptPath,
        idleTimeoutSeconds: msToSec(args.config.agentTimeouts.recovery),
      },
    );

    if (recovery.decision.marker === "HALT") {
      // Deliberate HALT from recovery — quarantine.
      await quarantineStory(
        repoRoot,
        story,
        recovery.decision.haltReason ?? "recovery HALT",
      );
      return halted(story, args.iterationNum, recovery.decision.haltReason);
    }

    // RECOVERY_COMPLETE — pick up the new commit if any.
    if (recovery.decision.commitSha) {
      lastCommitSha = recovery.decision.commitSha;
    }
  }

  // === Fix #13: skipped outcome when no commit landed ========================
  // Bash:614 "Skipping review." — no commit means nothing to review. Encoded
  // as "skipped" (Fix-A's new outcome) so the circuit breaker doesn't count it
  // as a failure OR a success — it's a verification-only iteration.
  if (!lastCommitSha) {
    return {
      story,
      outcome: "skipped",
      iterationsUsed: args.iterationNum,
    };
  }

  // === Post-commit-1: refresh postSha + run migrations + UI-diff =============
  let postSha: string;
  try {
    postSha = await gitRevParseHead(repoRoot);
  } catch (err) {
    await quarantineStory(
      repoRoot,
      story,
      `post-implementer git rev-parse HEAD failed: ${errorMessage(err)}`,
    );
    return quarantined(story, args.iterationNum);
  }

  // Fix #5 — driver-computed UI ground truth. From here on we never trust
  // impl.output.uiTouched.
  try {
    commitTouchedUi = await gitDiffTouchedUi(repoRoot, preSha, postSha);
  } catch (err) {
    process.stderr.write(
      `WARN: gitDiffTouchedUi failed (treating as no-UI): ${errorMessage(err)}\n`,
    );
    commitTouchedUi = false;
  }

  // V1-B — total diff size feeds the reviewer effort scaling. Best-effort.
  let diffLineCount = 0;
  try {
    diffLineCount = await getDiffLineCount(repoRoot, preSha, postSha);
  } catch (err) {
    process.stderr.write(
      `WARN: getDiffLineCount failed (treating as 0 lines → low effort): ${errorMessage(err)}\n`,
    );
  }

  // Fix #3 — auto-apply drizzle migrations between preSha and postSha. Real
  // errors quarantine the story and skip the reviewer (mirrors bash:648).
  const migQuarantined = await runMigrationsOrQuarantine(
    repoRoot,
    story,
    preSha,
    postSha,
    args.iterationNum,
  );
  if (migQuarantined) return migQuarantined;

  // === Step 3: reviewer / fixer ladder (≤2 attempts) ========================
  let lastReviewerText: string | undefined;
  let iterationFinalized = false;

  for (const attempt of [1, 2] as const) {
    const reviewerPrompt = buildReviewerBriefing({
      story,
      ghIssue,
      iterationNum: args.iterationNum,
      iterationTotal: args.iterationTotal,
      issue,
      lastSha: lastCommitSha,
      branch: args.sandbox.branch,
      specRequiresPlaywright: specReqPw,
      commitTouchedUi,
    });

    let review;
    try {
      review = await runReviewer({
        sandbox: args.sandbox,
        prompt: reviewerPrompt,
        config: args.config,
        iterationNum: args.iterationNum,
        attempt,
        diffLineCount,
        _agentRunner: args._agentRunner,
      });
    } catch (firstErr) {
      // Bash-style escalation to Opus on reviewer rc != 0 (afk-ralph.sh:697).
      // Marker-not-found also triggers escalation: the bash version's awk
      // defaults to HAS_BLOCKERS on no-marker; we instead retry with a
      // higher-tier model since the strict-mode parser refuses to guess.
      try {
        review = await runReviewer({
          sandbox: args.sandbox,
          prompt: reviewerPrompt,
          config: args.config,
          iterationNum: args.iterationNum,
          attempt,
          escalated: true,
          diffLineCount,
          _agentRunner: args._agentRunner,
        });
      } catch (secondErr) {
        // Both reviewer attempts failed — quarantine.
        await quarantineStory(
          repoRoot,
          story,
          `reviewer-ladder-exhausted: ${errorMessage(secondErr)}; first error: ${errorMessage(firstErr)}`,
        );
        return quarantined(story, args.iterationNum);
      }
    }

    lastReviewerText = review.raw.stdout;

    if (review.marker === "ALL_CLEAR") {
      await markDone(
        repoRoot,
        story.id,
        lastCommitSha,
        args.iterationNum,
        story.title,
      );
      try {
        await closeIssue(
          ghIssue,
          `RALPH(it=${args.iterationNum}) closed by commit ${lastCommitSha}`,
        );
      } catch (err) {
        process.stderr.write(
          `WARN: closeIssue(${ghIssue}) failed (continuing — prd.json is source of truth): ${errorMessage(err)}\n`,
        );
      }
      iterationFinalized = true;
      return shipped(story, args.iterationNum, lastCommitSha);
    }

    // === Fixer attempt ======================================================
    const fixerPrompt = buildFixerBriefing({
      story,
      ghIssue,
      iterationNum: args.iterationNum,
      iterationTotal: args.iterationTotal,
      issue,
      attempt,
      lastSha: lastCommitSha,
      prevReviewerText: lastReviewerText,
    });

    let fixer;
    try {
      fixer = await runFixer({
        sandbox: args.sandbox,
        prompt: fixerPrompt,
        config: args.config,
        iterationNum: args.iterationNum,
        attempt,
        _agentRunner: args._agentRunner,
      });
    } catch (err) {
      // Bash treats fixer failure as fatal (afk-ralph.sh:746 `exit 1`). We
      // soften that: quarantine the story and let the outer loop continue.
      await quarantineStory(
        repoRoot,
        story,
        `fixer-failed-attempt-${attempt}: ${errorMessage(err)}`,
      );
      return quarantined(story, args.iterationNum);
    }

    if (fixer.verdict?.commitSha) lastCommitSha = fixer.verdict.commitSha;
    else if (fixer.raw.commits.at(-1)) {
      lastCommitSha = fixer.raw.commits.at(-1)!.sha;
    }

    // After a fixer commit lands, refresh postSha + UI ground truth + run
    // any new migrations. If the fixer happened to add a SQL migration,
    // applyMigrationsBetween(preSha, newPostSha) picks it up.
    if (fixer.marker === "FIXED" || fixer.raw.commits.length > 0) {
      try {
        postSha = await gitRevParseHead(repoRoot);
      } catch (err) {
        await quarantineStory(
          repoRoot,
          story,
          `post-fixer-${attempt} git rev-parse HEAD failed: ${errorMessage(err)}`,
        );
        return quarantined(story, args.iterationNum);
      }
      try {
        commitTouchedUi = await gitDiffTouchedUi(repoRoot, preSha, postSha);
      } catch (err) {
        process.stderr.write(
          `WARN: post-fixer gitDiffTouchedUi failed: ${errorMessage(err)}\n`,
        );
      }
      // V1-B — refresh diff size after fixer commits land too. Long fix
      // chains can grow the diff into a higher reviewer-effort bucket.
      try {
        diffLineCount = await getDiffLineCount(repoRoot, preSha, postSha);
      } catch (err) {
        process.stderr.write(
          `WARN: post-fixer getDiffLineCount failed: ${errorMessage(err)}\n`,
        );
      }
      const migQ = await runMigrationsOrQuarantine(
        repoRoot,
        story,
        preSha,
        postSha,
        args.iterationNum,
      );
      if (migQ) return migQ;
    }

    if (attempt === 2 && fixer.marker !== "FIXED") {
      // Ship-on-fail-with-issue-OPEN (afk-ralph.sh:762–782).
      await markDone(
        repoRoot,
        story.id,
        lastCommitSha,
        args.iterationNum,
        story.title,
      );
      await commentPoster(
        ghIssue,
        buildShipOpenComment({
          iterationNum: args.iterationNum,
          attempts: 2,
          reviewerText: lastReviewerText,
        }),
      ).catch((err) => {
        process.stderr.write(
          `WARN: ship-open comment on #${ghIssue} failed: ${errorMessage(err)}\n`,
        );
      });
      return shipped(story, args.iterationNum, lastCommitSha);
    }

    if (attempt === 2 && fixer.marker === "FIXED") {
      // Fall out of the for-of; the post-loop final-pass block runs below.
      break;
    }
    // attempt === 1: fall through to attempt 2's reviewer pass at the top
    // of the next iteration. (Bash does the same: it just re-enters the
    // reviewer loop regardless of the fixer's verdict — even if fixer
    // reported BLOCKED, the reviewer might decide the existing commit is
    // acceptable.)
  }

  if (iterationFinalized) {
    // Type-narrow exit — unreachable due to early returns above.
    return shipped(story, args.iterationNum, lastCommitSha);
  }

  // === Step 4: final-pass reviewer (post attempt-2 FIXED) ====================
  // Mirrors bash afk-ralph.sh:789–831 — verifies attempt-2 fixer's claim
  // before marking done.
  const finalPrompt = buildReviewerBriefing({
    story,
    ghIssue,
    iterationNum: args.iterationNum,
    iterationTotal: args.iterationTotal,
    issue,
    lastSha: lastCommitSha,
    branch: args.sandbox.branch,
    specRequiresPlaywright: specReqPw,
    commitTouchedUi,
  });

  let finalReview;
  try {
    finalReview = await runFinalReviewer({
      sandbox: args.sandbox,
      prompt: finalPrompt,
      config: args.config,
      iterationNum: args.iterationNum,
      diffLineCount,
      _agentRunner: args._agentRunner,
    });
  } catch {
    try {
      finalReview = await runFinalReviewer({
        sandbox: args.sandbox,
        prompt: finalPrompt,
        config: args.config,
        iterationNum: args.iterationNum,
        escalated: true,
        diffLineCount,
        _agentRunner: args._agentRunner,
      });
    } catch {
      // Final-pass ladder failed — ship with issue OPEN per bash's tolerant
      // behavior (it doesn't quarantine on final-pass failure either).
      await markDone(
        repoRoot,
        story.id,
        lastCommitSha,
        args.iterationNum,
        story.title,
      );
      await commentPoster(
        ghIssue,
        buildShipOpenComment({
          iterationNum: args.iterationNum,
          attempts: 2,
          reviewerText: lastReviewerText,
          finalPassFailed: true,
        }),
      ).catch((err) => {
        process.stderr.write(
          `WARN: final-pass ship-open comment on #${ghIssue} failed: ${errorMessage(err)}\n`,
        );
      });
      return shipped(story, args.iterationNum, lastCommitSha);
    }
  }

  if (finalReview.marker === "ALL_CLEAR") {
    await markDone(
      repoRoot,
      story.id,
      lastCommitSha,
      args.iterationNum,
      story.title,
    );
    try {
      await closeIssue(
        ghIssue,
        `RALPH(it=${args.iterationNum}) closed by commit ${lastCommitSha} after final-review pass`,
      );
    } catch (err) {
      process.stderr.write(
        `WARN: closeIssue(${ghIssue}) failed after final-review pass: ${errorMessage(err)}\n`,
      );
    }
    return shipped(story, args.iterationNum, lastCommitSha);
  }

  // Final review still HAS_BLOCKERS — ship-with-issue-OPEN.
  await markDone(
    repoRoot,
    story.id,
    lastCommitSha,
    args.iterationNum,
    story.title,
  );
  await commentPoster(
    ghIssue,
    buildShipOpenComment({
      iterationNum: args.iterationNum,
      attempts: 2,
      reviewerText: finalReview.raw.stdout,
      finalPassFailed: true,
    }),
  ).catch((err) => {
    process.stderr.write(
      `WARN: final HAS_BLOCKERS ship-open comment on #${ghIssue} failed: ${errorMessage(err)}\n`,
    );
  });
  return shipped(story, args.iterationNum, lastCommitSha);
}

// === helpers ==================================================================

/**
 * Run the drizzle migration auto-applier between two SHAs. On real errors,
 * quarantine the story (with attempts:2 — the implementer plus the migration
 * applier together count as two failed attempts on this story) and return an
 * IterationResult so the caller can early-exit the iteration.
 *
 * On success — or on a no-op (no SQL files added between the two SHAs) —
 * returns null.
 */
async function runMigrationsOrQuarantine(
  repoRoot: string,
  story: Story,
  preSha: string,
  postSha: string,
  iterationNum: number,
): Promise<IterationResult | null> {
  let migResult: Awaited<ReturnType<typeof applyMigrationsBetween>>;
  // Stamp attempts:2 on the story passed to quarantineStory — the implementer
  // shipped a commit (attempt 1) and the migration applier just hit a real
  // error (attempt 2). `quarantineStory` reads `story.attempts ?? 1` and
  // forwards into prd.json, so we shadow with a fresh object rather than
  // mutating the caller's reference.
  const storyForQuarantine: Story = { ...story, attempts: 2 };
  try {
    migResult = await applyMigrationsBetween(repoRoot, preSha, postSha);
  } catch (err) {
    // Throws are limited to misconfiguration (no DATABASE_URL) and git
    // failure. Either way the iteration can't proceed safely.
    await quarantineStory(
      repoRoot,
      storyForQuarantine,
      `migration auto-apply threw: ${errorMessage(err)}`,
    );
    return {
      story,
      outcome: "quarantined",
      iterationsUsed: iterationNum,
      haltReason: "migration failed",
    };
  }

  if (migResult.realErrors.length > 0) {
    const first = migResult.realErrors[0]!;
    await quarantineStory(
      repoRoot,
      storyForQuarantine,
      `migration auto-apply failed: ${first.msg}`,
    );
    return {
      story,
      outcome: "quarantined",
      iterationsUsed: iterationNum,
      haltReason: "migration failed",
    };
  }

  // Success path — log the applied/benignSkipped counts so the operator can
  // confirm the implementer's MIGRATION_BLOCK was idempotent vs. genuinely
  // applied here.
  if (migResult.applied > 0 || migResult.benignSkipped > 0) {
    process.stdout.write(
      `[migrations] applied=${migResult.applied} benignSkipped=${migResult.benignSkipped}\n`,
    );
  }
  return null;
}

function shipped(
  story: Story,
  iterationNum: number,
  finalCommitSha?: string,
): IterationResult {
  return {
    story,
    outcome: "shipped",
    iterationsUsed: iterationNum,
    finalCommitSha,
  };
}

function quarantined(story: Story, iterationNum: number): IterationResult {
  return {
    story,
    outcome: "quarantined",
    iterationsUsed: iterationNum,
  };
}

function halted(
  story: Story,
  iterationNum: number,
  haltReason?: string,
): IterationResult {
  return {
    story,
    outcome: "halted",
    iterationsUsed: iterationNum,
    haltReason,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof MarkerNotFoundError) {
    return `marker not found: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Convert ms (LoopConfig) → seconds (Sandcastle's idleTimeoutSeconds). */
function msToSec(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

interface ShipOpenCommentArgs {
  iterationNum: number;
  attempts: number;
  reviewerText?: string;
  finalPassFailed?: boolean;
}

/**
 * Build the comment posted on the GitHub issue when a story ships with
 * unresolved reviewer concerns (issue stays OPEN). Matches the bash heredoc
 * at afk-ralph.sh:769–777 (regular fix-cap exhaustion) and :820–826 (final
 * pass HAS_BLOCKERS).
 */
function buildShipOpenComment(args: ShipOpenCommentArgs): string {
  const header = args.finalPassFailed
    ? `RALPH(it=${args.iterationNum}) shipped this story but the final reviewer pass (after attempt-${args.attempts} fixer claimed FIXED) still flagged HAS_BLOCKERS. Issue left OPEN for human review.`
    : `RALPH(it=${args.iterationNum}) shipped this story but the reviewer's unresolved concerns weren't cleared after ${args.attempts} fixer attempts. Issue left OPEN for human review.`;

  const findings = args.reviewerText ?? "(no review output captured)";
  return `${header}

--- Reviewer findings ---

${findings}

--- End reviewer findings ---`;
}

/**
 * Default `gh issue comment` poster via execFile (so the body can never
 * shell-inject). Mirrors Track E's `quarantineStory` poster shape. We
 * deliberately call `gh` directly rather than importing a non-existent
 * helper from state/gh.js (per Fix #8 — closeIssue + getIssueBody come from
 * the barrel; one-off `gh issue comment` stays local).
 */
function defaultCommentPoster(): (issueNum: number, body: string) => Promise<void> {
  return async (issueNum, body) => {
    if (!Number.isInteger(issueNum) || issueNum <= 0) {
      throw new Error(`commentOnIssue: invalid issueNum '${issueNum}'`);
    }
    await execFileP(
      "gh",
      ["issue", "comment", String(issueNum), "--body", body],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
  };
}
