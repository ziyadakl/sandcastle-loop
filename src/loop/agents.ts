/**
 * Agent wrappers — thin layer between the loop state machine (iteration.ts)
 * and the underlying `sandbox.run()` Sandcastle call. Each wrapper:
 *   1. Picks the right model (claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-7)
 *      based on `config.models.<role>`.
 *   2. Sets the right effort tier (`high` for reviewer/fixer; default for
 *      implementer because reasoning-heavy reviews benefit more than
 *      generative implementation).
 *   3. Wraps the run in an AbortSignal-based timeout (per-agent, from
 *      `config.agentTimeouts`).
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
 * Note re: recovery — Track E (`runRecoveryLadder`) owns the Sonnet→Opus
 * recovery ladder including its own sandbox.run plumbing. We don't expose
 * a runRecoveryAgent here because Track E already does it correctly with
 * its own log-isolation + marker-extract logic.
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
} from "../types.js";
import {
  extractMarker,
  parseVerdict,
  ImplementerOutputSchema,
  ReviewerVerdictSchema,
  FixerVerdictSchema,
  IMPLEMENTER_MARKERS,
  REVIEWER_MARKERS,
  FIXER_MARKERS,
} from "../verdicts/index.js";

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
  effort?: "low" | "medium" | "high" | "max";
  /** Single-shot agents (reviewer/fixer/final-reviewer) use 1; implementer can iterate. */
  maxIterations: number;
  completionSignal: string | string[];
  /** Per-agent timeout in ms — abort signal fires at this point. */
  timeoutMs: number;
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

  const opts: SandboxRunOptions = {
    agent: claudeCode(MODEL_IDS[args.model], {
      ...(args.effort ? { effort: args.effort } : {}),
    }),
    prompt: args.prompt,
    maxIterations: args.maxIterations,
    completionSignal: args.completionSignal,
    name: args.name,
    signal: ac.signal,
  };

  try {
    return await args.sandbox.run(opts);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Implementer -----------------------------------------------------------

export interface ImplementerCallArgs {
  sandbox: Sandbox;
  prompt: string;
  config: LoopConfig;
  iterationNum: number;
  story: { id: string; ghIssue: number };
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
  const result = await runAgent({
    sandbox: args.sandbox,
    prompt: args.prompt,
    model: args.config.models.implementer,
    // No `effort: high` — implementation is generative, not reasoning-heavy;
    // the reviewer is the gate that benefits from the reasoning budget.
    maxIterations: 5,
    completionSignal: [...COMPLETION_SIGNALS.implementer],
    timeoutMs: args.config.agentTimeouts.implementer,
    name: `Implementer (it=${args.iterationNum})`,
    role: "implementer",
    runner: args._agentRunner,
  });

  // Strict-mode marker extraction — refuses anything but a bare marker
  // (or `<promise>HALT</promise>`) on the last non-empty line.
  const marker = extractMarker(result.stdout, IMPLEMENTER_MARKERS, {
    mode: "strict",
  });

  // Try to parse a structured payload. This is best-effort: the implementer
  // prompt asks for one but the bash original tolerates its absence. If
  // parsing fails (no JSON body, schema mismatch), surface marker-only.
  let output: ImplementerOutput | undefined;
  try {
    output = parseVerdict(result.stdout, ImplementerOutputSchema);
  } catch {
    output = undefined;
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
 * `effort: "high"` because review is reasoning-heavy and the bash version
 * runs it with `MAX_THINKING_TOKENS=4096`.
 */
export async function runReviewer(
  args: ReviewerCallArgs,
): Promise<ReviewerResult> {
  const model: ModelTier = args.escalated ? "opus" : args.config.models.reviewer;
  const result = await runAgent({
    sandbox: args.sandbox,
    prompt: args.prompt,
    model,
    effort: "high",
    maxIterations: 1,
    completionSignal: [...COMPLETION_SIGNALS.reviewer],
    timeoutMs: args.config.agentTimeouts.reviewer,
    name: args.escalated
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
 */
export async function runFixer(args: FixerCallArgs): Promise<FixerResult> {
  // Attempt-2 escalation: bash hardcodes claude-opus-4-7 on attempt 2,
  // overriding config.models.fixer. We keep the same behavior: tier
  // escalation matters more than config consistency for retry-ladder soundness.
  const model: ModelTier = args.attempt === 2 ? "opus" : args.config.models.fixer;
  const result = await runAgent({
    sandbox: args.sandbox,
    prompt: args.prompt,
    model,
    effort: "high",
    maxIterations: 1,
    completionSignal: [...COMPLETION_SIGNALS.fixer],
    timeoutMs: args.config.agentTimeouts.fixer,
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
  /** True after a non-zero rc — escalate to opus. */
  escalated?: boolean;
  /** Smoke seam — bypasses sandbox.run when provided. @internal */
  _agentRunner?: AgentRunner;
}

/**
 * Final-pass reviewer — runs after attempt-2 fixer's FIXED claim to verify.
 * Same shape as runReviewer but distinguishable in logs (matches bash
 * "Reviewer-Final" naming at afk-ralph.sh:792).
 */
export async function runFinalReviewer(
  args: FinalReviewerCallArgs,
): Promise<ReviewerResult> {
  const model: ModelTier = args.escalated ? "opus" : args.config.models.reviewer;
  const result = await runAgent({
    sandbox: args.sandbox,
    prompt: args.prompt,
    model,
    effort: "high",
    maxIterations: 1,
    completionSignal: [...COMPLETION_SIGNALS.reviewer],
    timeoutMs: args.config.agentTimeouts.reviewer,
    name: args.escalated
      ? `Reviewer-Final-Opus (it=${args.iterationNum})`
      : `Reviewer-Final (it=${args.iterationNum})`,
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
