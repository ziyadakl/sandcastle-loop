/**
 * Agent wrappers — thin layer between the loop state machine (iteration.ts)
 * and the underlying `sandbox.run()` Sandcastle call. Each wrapper:
 *   1. Picks the right model (claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-7)
 *      based on `config.models.<role>`.
 *   2. Sets the right effort tier — reviewer effort scales with diff size
 *      (V1-B refactor: <100 lines=low, 100-499=medium, 500+=high), Opus retries
 *      use `xhigh` (which the underlying CLI accepts even though Sandcastle's
 *      stale `.d.ts` types don't list it — see the cast below).
 *   3. Wraps the run in an AbortSignal-based timeout (per-agent, from
 *      `config.agentTimeouts`) AND passes a per-role `idleTimeoutSeconds` so
 *      Sandcastle's native idle-watchdog also fires (defense in depth).
 *   4. Sets `completionSignal` to the markers Track B's `extractMarker`
 *      recognizes — so the agent exits early when it emits a verdict.
 *   5. Calls Track B's strict `extractMarker` + `parseVerdict` to produce a
 *      typed verdict object. Re-throws on parse failure (no silent fallthrough).
 *
 * Re: `Output.object` — the brief contemplates using Sandcastle's typed-output
 * helper for single-shot reviewer/fixer runs. Sandcastle 0.5.8 (this repo's
 * pinned version) does not export `Output` from its package entrypoint, so
 * we parse the stdout via Track B's `parseVerdict` instead. If a future
 * sandcastle version exposes `Output.object`, switching the reviewer/fixer
 * runs to it is a localized change to this file.
 *
 * Note re: recovery — Track E (`runRecoveryDiagnosisOrEscalate`) owns the
 * Sonnet→Opus recovery ladder including its own sandbox.run plumbing. We
 * don't expose a runRecoveryAgent here because Track E already does it
 * correctly with its own log-isolation + marker-extract logic.
 */
import { claudeCode } from "@ai-hero/sandcastle";
import type {
  Sandbox,
  SandboxRunOptions,
  SandboxRunResult,
} from "@ai-hero/sandcastle";

import type {
  ImplementerOutput,
  ReviewerVerdict,
  FixerVerdict,
  ModelTier,
  LoopConfig,
} from "../../src/types.js";
import {
  extractMarker,
  parseVerdict,
  ImplementerOutputSchema,
  ReviewerVerdictSchema,
  FixerVerdictSchema,
  IMPLEMENTER_MARKERS,
  REVIEWER_MARKERS,
  FIXER_MARKERS,
} from "../../src/verdicts/index.js";

const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-7",
};

const COMPLETION_SIGNALS = {
  implementer: ["STORY_COMPLETE", "<promise>HALT</promise>"],
  reviewer: ["ALL_CLEAR", "HAS_BLOCKERS"],
  fixer: ["FIXED", "BLOCKED"],
} as const;

/**
 * The full effort tier set we actually use, including `xhigh`. Sandcastle's
 * pinned `.d.ts` types only list `low|medium|high|max`, but the underlying
 * Claude Code CLI accepts `xhigh` for Opus 4.7 (per
 * https://platform.claude.com/docs/en/build-with-claude/effort). We cast
 * `as never` at the call site rather than widening the global type — the
 * cast is intentionally local and commented so a future Sandcastle bump
 * with refreshed types can drop it cleanly.
 */
type EffortTier = "low" | "medium" | "high" | "max" | "xhigh";

/**
 * Reviewer effort scaling rule. Pure function so callers (and tests) can
 * verify the bucket boundaries without invoking the agent.
 *
 * Rationale: a reviewer reasoning over a 30-line diff doesn't benefit from
 * the same token budget as one reviewing a 600-line diff. Scaling the
 * `effort` tier with the actual diff size saves tokens on small stories
 * (most of them) without starving the rare large refactor.
 *
 *   < 100 insertions+deletions  → "low"     (small story / single fix)
 *   100 – 499                   → "medium"  (typical feature)
 *   500+                        → "high"    (large refactor, full reasoning)
 */
export function reviewerEffortForDiffSize(
  diffLineCount: number,
): "low" | "medium" | "high" {
  if (diffLineCount < 100) return "low";
  if (diffLineCount < 500) return "medium";
  return "high";
}

/**
 * Smoke-test injection seam (Bonus Fix). When this is provided to one of the
 * agent wrappers, it replaces the underlying `sandbox.run()` call so a smoke
 * harness can supply canned outputs without spinning up Docker. Track F has
 * been waiting on this since dispatch.
 *
 * Inputs match what the loop already needs to know (role, model, prompt).
 * Output mirrors the load-bearing slice of `SandboxRunResult` — we only ever
 * read `stdout`, `commits`, and `completionSignal` from the run result, so
 * stubs don't need to fabricate `iterations` / `logFilePath`.
 */
export type AgentRole = "implementer" | "reviewer" | "fixer" | "final-reviewer";

export type AgentRunner = (
  role: AgentRole,
  model: ModelTier,
  prompt: string,
) => Promise<{
  stdout: string;
  commits: { sha: string }[];
  completionSignal?: string;
}>;

interface RunAgentArgs {
  sandbox: Sandbox;
  prompt: string;
  model: ModelTier;
  effort?: EffortTier;
  /** Single-shot agents (reviewer/fixer/final-reviewer) use 1; implementer can iterate. */
  maxIterations: number;
  completionSignal: string | string[];
  /** Per-agent timeout in ms — abort signal fires at this point. */
  timeoutMs: number;
  /** Per-agent idle timeout in seconds — Sandcastle's native idle watchdog. */
  idleTimeoutSeconds: number;
  /** Display name (logged). */
  name: string;
  /** Role tag for the optional smoke runner. */
  role: AgentRole;
  /** Optional smoke seam — bypasses sandbox.run when provided. */
  runner?: AgentRunner;
}

/**
 * Run a single sandbox.run() with a per-call AbortController-based timeout.
 * If the timer fires first, the abort propagates into sandcastle which kills
 * the agent subprocess. If the run finishes first, the timer is cleared.
 *
 * Note: `AbortSignal.timeout(ms)` is a single-shot API — we use AbortController
 * directly so we can clear the timer on success and surface a useful reason.
 *
 * When `args.runner` is provided we DELEGATE to it instead of calling
 * `sandbox.run()` (Bonus Fix smoke seam). The timer still fires — the runner
 * gets the abort signal indirectly via the rejecting Promise.race.
 */
async function runAgent(args: RunAgentArgs): Promise<SandboxRunResult> {
  if (args.runner) {
    // Smoke path: no sandcastle, no claudeCode, no AbortController. Plain
    // race against the agent timeout so callers still see a uniform failure
    // shape if the canned runner hangs.
    const stub = args.runner(args.role, args.model, args.prompt);
    const timeoutPromise = new Promise<SandboxRunResult>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(`agent ${args.name} timed out after ${args.timeoutMs}ms`),
        );
      }, args.timeoutMs).unref?.();
    });
    const settled = await Promise.race([stub, timeoutPromise]);
    // The race winner from `stub` is the runner's return shape; coerce it
    // into a SandboxRunResult-compatible value. We only synthesize the
    // fields the loop actually reads.
    if ("iterations" in settled) {
      // already SandboxRunResult-shaped (timeout path threw — shouldn't reach here).
      return settled;
    }
    const stubResult = settled as Awaited<ReturnType<AgentRunner>>;
    return {
      iterations: [],
      stdout: stubResult.stdout,
      commits: stubResult.commits,
      completionSignal: stubResult.completionSignal,
    };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(new Error(`agent ${args.name} timed out after ${args.timeoutMs}ms`));
  }, args.timeoutMs);

  // sandcastle types are stale; CLI accepts xhigh per
  // https://platform.claude.com/docs/en/build-with-claude/effort
  const effortOption = args.effort
    ? { effort: args.effort as never }
    : {};
  const opts: SandboxRunOptions = {
    agent: claudeCode(MODEL_IDS[args.model], effortOption),
    prompt: args.prompt,
    maxIterations: args.maxIterations,
    completionSignal: args.completionSignal,
    idleTimeoutSeconds: args.idleTimeoutSeconds,
    name: args.name,
    signal: ac.signal,
  };

  try {
    return await args.sandbox.run(opts);
  } finally {
    clearTimeout(timer);
  }
}

/** Convert the LoopConfig agentTimeouts (ms) to seconds for Sandcastle. */
function msToSec(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

// ---- Implementer -----------------------------------------------------------

export interface ImplementerCallArgs {
  sandbox: Sandbox;
  prompt: string;
  config: LoopConfig;
  iterationNum: number;
  story: { id: string; ghIssue: number };
  /**
   * If true, this is the Opus retry — escalate model to opus and effort to
   * `xhigh` (sandcastle types stale; CLI accepts it).
   */
  escalated?: boolean;
  /** Smoke seam — bypasses sandbox.run when provided. @internal */
  _agentRunner?: AgentRunner;
}

export interface ImplementerResult {
  /** Marker extracted from the LAST non-empty line of assistant text. */
  marker: ImplementerOutput["marker"];
  /** Optional structured payload — present when the agent emitted JSON. */
  output?: ImplementerOutput;
  raw: SandboxRunResult;
}

/**
 * Implementer — multi-iteration agent. Returns the marker (always) and the
 * structured ImplementerOutput (when the agent emitted a JSON envelope before
 * the marker line, per refs/prompt.md.local-fork's certification block).
 *
 * The bash version did NOT require a structured payload — it relied on
 * driver-side git-diff to detect commits/UI. Our types.ts contract requires
 * the structured fields, so when the agent doesn't emit one we fall back to
 * a marker-only result and let iteration.ts derive what it can from
 * sandbox.commits + git-diff equivalents.
 *
 * `maxIterations: 5` matches the bash `timeout 1200` budget.
 */
export async function runImplementer(
  args: ImplementerCallArgs,
): Promise<ImplementerResult> {
  const escalated = args.escalated === true;
  const model: ModelTier = escalated ? "opus" : args.config.models.implementer;
  const result = await runAgent({
    sandbox: args.sandbox,
    prompt: args.prompt,
    model,
    // No effort by default for implementer (generative, not reasoning-heavy).
    // On the Opus retry, push to `xhigh` — the V1-B ladder uses the
    // CLI-supported tier even though sandcastle's stale types don't list it.
    ...(escalated ? { effort: "xhigh" as EffortTier } : {}),
    maxIterations: 5,
    completionSignal: [...COMPLETION_SIGNALS.implementer],
    timeoutMs: args.config.agentTimeouts.implementer,
    idleTimeoutSeconds: msToSec(args.config.agentTimeouts.implementer),
    name: escalated
      ? `Implementer-Opus (it=${args.iterationNum})`
      : `Implementer (it=${args.iterationNum})`,
    role: "implementer",
    runner: args._agentRunner,
  });

  // Strict-mode marker extraction — refuses anything but a bare marker
  // (or `<promise>HALT</promise>`) on the last non-empty line.
  const marker = extractMarker(result.stdout, IMPLEMENTER_MARKERS, {
    mode: "strict",
  });

  // Parse the structured payload. Strictness depends on the marker:
  //
  //   - STORY_COMPLETE — the JSON envelope is LOAD-BEARING. The ship signal
  //     in the loop ladder is "raw stdout marker says STORY_COMPLETE AND the
  //     typed verdict round-trips". A schema parse failure here used to set
  //     `output: undefined` silently, which let the loop ship on the raw
  //     marker alone — re-introducing the very failure mode the typed-verdict
  //     layer (V1-A) was built to prevent. Now we re-throw so the iteration
  //     catch routes to the recovery ladder (Track E).
  //
  //   - HALT (and any non-STORY_COMPLETE terminal marker, e.g. a future
  //     NEEDS_HELP) — soft. An implementer admitting failure may not have a
  //     structured envelope, and the bash original tolerated that. We keep
  //     `output = undefined` so iteration.ts's HALT path (Fix #14) can still
  //     quarantine via label.
  //
  // Additionally: when parsing succeeds, `output.marker` MUST equal the raw
  // stdout marker. If the JSON envelope says "HALT" but the last stdout line
  // says "STORY_COMPLETE" (or vice versa), that's a contradiction — we
  // trusted raw before, which let an envelope-HALT ship on stdout-COMPLETE.
  // Throw on disagreement so the recovery ladder runs.
  let output: ImplementerOutput | undefined;
  try {
    // Match the planner's dual-mode pattern (planner.ts:382-400): stdout from
    // sandbox.run can be EITHER stream-json envelopes OR plain assistant text
    // depending on how Sandcastle was configured. Try stream-json first; on
    // failure retry with `alreadyAssistantText: true`.
    try {
      output = parseVerdict(result.stdout, ImplementerOutputSchema);
    } catch {
      output = parseVerdict(result.stdout, ImplementerOutputSchema, {
        alreadyAssistantText: true,
      });
    }
  } catch (err) {
    if (marker === "STORY_COMPLETE") {
      throw new Error(
        `implementer emitted STORY_COMPLETE but the structured JSON envelope failed to parse: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    output = undefined;
  }

  if (output && output.marker !== marker) {
    throw new Error(
      `implementer raw stdout marker (${marker}) disagrees with JSON envelope marker (${output.marker}); refusing to ship on raw marker alone`,
    );
  }

  return { marker, output, raw: result };
}

// ---- Reviewer --------------------------------------------------------------

export interface ReviewerCallArgs {
  sandbox: Sandbox;
  prompt: string;
  config: LoopConfig;
  iterationNum: number;
  attempt: number;
  /**
   * If true, escalate to opus for this single call regardless of
   * `config.models.reviewer`. Used by iteration.ts when a previous reviewer
   * exit was non-zero (matches bash's "Respawning with Opus" behavior at
   * afk-ralph.sh:697 and :796).
   */
  escalated?: boolean;
  /**
   * Diff line count (insertions + deletions between preSha and the current
   * head). Drives the reviewer effort scaling (low/medium/high). Default is
   * 0 (smallest bucket → "low") if the caller can't compute it.
   */
  diffLineCount?: number;
  /** Smoke seam — bypasses sandbox.run when provided. @internal */
  _agentRunner?: AgentRunner;
}

export interface ReviewerResult {
  marker: ReviewerVerdict["marker"];
  /** Full structured verdict when the agent emitted a JSON payload. */
  verdict?: ReviewerVerdict;
  raw: SandboxRunResult;
}

/**
 * Reviewer — single-shot agent, returns ALL_CLEAR / HAS_BLOCKERS.
 *
 * Effort scales with diff size (V1-B refactor): small diffs use `low`,
 * mid-sized use `medium`, large refactors use `high`. This trades a tiny bit
 * of nuance on small reviews for substantially fewer tokens on the typical
 * iteration. See reviewerEffortForDiffSize for the bucket boundaries.
 *
 * The Opus escalation path (rc≠0 first attempt) bumps effort to `xhigh`.
 */
export async function runReviewer(
  args: ReviewerCallArgs,
): Promise<ReviewerResult> {
  const escalated = args.escalated === true;
  const model: ModelTier = escalated ? "opus" : args.config.models.reviewer;
  const effort: EffortTier = escalated
    ? "xhigh"
    : reviewerEffortForDiffSize(args.diffLineCount ?? 0);
  const result = await runAgent({
    sandbox: args.sandbox,
    prompt: args.prompt,
    model,
    effort,
    maxIterations: 1,
    completionSignal: [...COMPLETION_SIGNALS.reviewer],
    timeoutMs: args.config.agentTimeouts.reviewer,
    idleTimeoutSeconds: msToSec(args.config.agentTimeouts.reviewer),
    name: escalated
      ? `Reviewer-Opus (it=${args.iterationNum} a=${args.attempt})`
      : `Reviewer (it=${args.iterationNum} a=${args.attempt})`,
    role: "reviewer",
    runner: args._agentRunner,
  });

  const marker = extractMarker(result.stdout, REVIEWER_MARKERS, {
    mode: "strict",
  });

  let verdict: ReviewerVerdict | undefined;
  try {
    verdict = parseVerdict(result.stdout, ReviewerVerdictSchema);
  } catch {
    verdict = undefined;
  }

  return { marker, verdict, raw: result };
}

// ---- Fixer -----------------------------------------------------------------

export interface FixerCallArgs {
  sandbox: Sandbox;
  prompt: string;
  config: LoopConfig;
  iterationNum: number;
  attempt: 1 | 2;
  /** Smoke seam — bypasses sandbox.run when provided. @internal */
  _agentRunner?: AgentRunner;
}

export interface FixerResult {
  marker: FixerVerdict["marker"];
  verdict?: FixerVerdict;
  raw: SandboxRunResult;
}

/**
 * Fixer — single-shot agent, returns FIXED / BLOCKED.
 * Per bash `run_fixer()`, attempt 2 escalates to Opus regardless of
 * config.models.fixer (the "always change tier on retry" anti-pattern fix).
 * Attempt-2 also bumps effort to `xhigh` (V1-B).
 */
export async function runFixer(args: FixerCallArgs): Promise<FixerResult> {
  // Attempt-2 escalation: bash hardcodes claude-opus-4-7 on attempt 2,
  // overriding config.models.fixer. We keep the same behavior: tier
  // escalation matters more than config consistency for retry-ladder soundness.
  const isOpusRetry = args.attempt === 2;
  const model: ModelTier = isOpusRetry ? "opus" : args.config.models.fixer;
  const effort: EffortTier = isOpusRetry ? "xhigh" : "high";
  const result = await runAgent({
    sandbox: args.sandbox,
    prompt: args.prompt,
    model,
    effort,
    maxIterations: 1,
    completionSignal: [...COMPLETION_SIGNALS.fixer],
    timeoutMs: args.config.agentTimeouts.fixer,
    idleTimeoutSeconds: msToSec(args.config.agentTimeouts.fixer),
    name: `Fixer (it=${args.iterationNum} a=${args.attempt})`,
    role: "fixer",
    runner: args._agentRunner,
  });

  const marker = extractMarker(result.stdout, FIXER_MARKERS, {
    mode: "strict",
  });

  let verdict: FixerVerdict | undefined;
  try {
    verdict = parseVerdict(result.stdout, FixerVerdictSchema);
  } catch {
    verdict = undefined;
  }

  return { marker, verdict, raw: result };
}

// ---- Final-pass reviewer ---------------------------------------------------

export interface FinalReviewerCallArgs {
  sandbox: Sandbox;
  prompt: string;
  config: LoopConfig;
  iterationNum: number;
  /**
   * True after a non-zero rc — bumps the per-iteration retry surface so the
   * caller can distinguish the first vs. fallback final-pass attempt in logs.
   * Both paths now use Opus 4.7 + xhigh — the user's spec requires the
   * final pass to ALWAYS be Opus xhigh (Fix #9).
   */
  escalated?: boolean;
  /** Smoke seam — bypasses sandbox.run when provided. @internal */
  _agentRunner?: AgentRunner;
}

/**
 * Final-pass reviewer — runs after attempt-2 fixer's FIXED claim to verify.
 * Same shape as runReviewer but distinguishable in logs (matches bash
 * "Reviewer-Final" naming at afk-ralph.sh:792).
 *
 * Fix #9: the final pass is ALWAYS Opus 4.7 + xhigh. The user's spec said:
 * regular review pass = Sonnet effort-scaled; final pass after fixer = Opus
 * 4.7 xhigh. Diff size is no longer a parameter (the previous diffLineCount
 * branch was dead code — final pass is unconditionally xhigh). The model is
 * hardcoded here rather than read from config.models.reviewer because the
 * final pass is a verifier-of-last-resort whose tier is non-negotiable.
 */
export async function runFinalReviewer(
  args: FinalReviewerCallArgs,
): Promise<ReviewerResult> {
  const escalated = args.escalated === true;
  const result = await runAgent({
    sandbox: args.sandbox,
    prompt: args.prompt,
    model: "opus",
    // Final pass: full reasoning budget (xhigh) regardless of diff size —
    // sandcastle types are stale; CLI accepts xhigh per
    // https://platform.claude.com/docs/en/build-with-claude/effort
    effort: "xhigh",
    maxIterations: 1,
    completionSignal: [...COMPLETION_SIGNALS.reviewer],
    timeoutMs: args.config.agentTimeouts.reviewer,
    idleTimeoutSeconds: msToSec(args.config.agentTimeouts.reviewer),
    name: escalated
      ? `Reviewer-Final-Opus-Retry (it=${args.iterationNum})`
      : `Reviewer-Final-Opus (it=${args.iterationNum})`,
    role: "final-reviewer",
    runner: args._agentRunner,
  });

  const marker = extractMarker(result.stdout, REVIEWER_MARKERS, {
    mode: "strict",
  });

  let verdict: ReviewerVerdict | undefined;
  try {
    verdict = parseVerdict(result.stdout, ReviewerVerdictSchema);
  } catch {
    verdict = undefined;
  }

  return { marker, verdict, raw: result };
}
