/**
 * The builder no-progress guard (issue #1038, 2026-09-04).
 *
 * WHAT BROKE. `runImplementer` used to dispatch one `sb.run({ maxIterations:
 * 100, ... })` call. The sandbox SDK (`@ai-hero/sandcastle`'s `orchestrate`
 * loop) runs one fresh `claude --print` process per iteration on the SAME
 * worktree, ends only when the accumulated output contains a completion
 * signal, and inspects NOTHING between iterations — no commit count, no HEAD
 * movement, nothing. On 2026-09-04 the #1038 builder's sandbox had silently
 * adopted a different persona (a separate fix, tracked elsewhere) and spent
 * every iteration writing prose asking a human a question instead of emitting
 * a marker. The SDK re-ran it blind eleven times in one hour — a fresh
 * context every time, no memory of the ten prior refusals — until the 3600s
 * hard ceiling finally killed it. Cost: ~$17:00, zero commits, zero code.
 *
 * THE FIX. The SDK exposes no per-iteration hook (no `onIteration`, no
 * `shouldContinue` — confirmed against `dist/index.d.ts`), so there is
 * nothing to plug into from inside it. Instead `runImplementer` now batches
 * `maxIterations: 1` calls through {@link runBuilderIterations} here, which
 * inspects each pass's OWN result (its stdout, its commits, whether HEAD
 * moved) and decides, in pure code, whether to run another pass. Three
 * consecutive passes that end with no completion marker AND no new commit
 * AND an unchanged worktree HEAD throw {@link BuilderNoProgressError} instead
 * of burning the rest of the hour on a fourth identical blind restart.
 *
 * This module is the sibling of `lib/stuck-detector.ts` (a different bounding
 * mechanism for a different failure shape: that one detects a SINGLE
 * iteration spinning on one repeated tool call; this one detects MULTIPLE
 * iterations that each individually look like a normal turn but collectively
 * never move the ticket forward). Both are pure decision logic plus a thin
 * run-orchestration helper, unit-tested without any real sandbox.
 *
 * `BuilderNoProgressError` is deliberately a PLAIN run fault — no typed catch
 * arm anywhere reads `instanceof BuilderNoProgressError`, and its message is
 * written to trip none of the pipeline's existing classifiers
 * (`isTransientError`, `isOutputCapError`, `STALL_RE`). That is intentional:
 * the ticket should take the ordinary road for any failure — the fixer (a
 * fresh pass with a clean context, then its own review rounds) — not a
 * special one, and the retry budget (`lib/state/retry-budget.ts`) already retries a
 * failed ticket on later runs until $100 is spent or it has been tried three times.
 */

import {
  COMPLETION_PROMISE,
  extractMarker,
  HALT_PROMISE,
  SANDBOX_COMPLETION_SIGNALS,
  IMPLEMENTER_MARKERS,
} from "./verdicts/index.js";

/**
 * How many consecutive passes may end with no completion marker AND no new
 * commit AND an unchanged HEAD before the batch gives up. Three, not one: a
 * single quiet pass is unremarkable (a model can legitimately spend a whole
 * turn reading code before committing anything), but the same blank result
 * three times in a row is the exact shape #1038 burned an hour on.
 */
export const BUILDER_IDLE_ITERATION_LIMIT = 3;

/**
 * The implementer's overall pass budget — unchanged from the single `sb.run`
 * call's old `maxIterations: 100`. The batch loop in
 * {@link runBuilderIterations} now spends this budget one `maxIterations: 1`
 * pass at a time instead of handing it to the SDK in one call, so a genuinely
 * productive builder that needs many turns is not cut short.
 */
export const IMPLEMENTER_MAX_ITERATIONS = 100;

/** Structural mirror of `RunHandle` (`main.mts`) — one pass's raw result. */
export interface BuilderRunResult {
  readonly stdout: string;
  readonly commits: readonly { sha: string }[];
  readonly iterations?: readonly {
    readonly sessionFilePath?: string;
    readonly sessionId?: string;
  }[];
  readonly stuckAborted?: boolean;
}

/** {@link BuilderRunResult}, merged across every pass the batch ran. */
export interface BuilderBatchResult extends BuilderRunResult {
  readonly iterationsRun: number;
}

/**
 * True when `stdout` carries a real implementer verdict: one of
 * {@link SANDBOX_COMPLETION_SIGNALS} (the SDK's own end-of-turn tokens —
 * the same list every sandboxed role's docker run loop stops on, not just
 * the builder's; one of which, `HALT_PROMISE`, is itself a verdict) appears
 * anywhere in the text, OR {@link extractMarker} finds a clean last-line
 * STORY_COMPLETE/HALT/RECOVERY_COMPLETE marker. Both checks are deliberately
 * generous about WHERE the signal sits (a substring test, not a last-line
 * test) — this predicate exists to decide "did this pass finish", not to
 * grade the verdict's exact shape, which downstream `runImplementer` still
 * enforces via its own `extractMarker`/`parseVerdict` calls on the merged
 * stdout. The builder's own in-repo batch loop below reads this same list to
 * stop A BUILDER pass; see {@link SANDBOX_COMPLETION_SIGNALS}'s doc comment
 * for the other docker-sandboxed roles that share it.
 */
export function implementerIterationComplete(stdout: string): boolean {
  if (SANDBOX_COMPLETION_SIGNALS.some((signal) => stdout.includes(signal))) {
    return true;
  }
  try {
    extractMarker(stdout, IMPLEMENTER_MARKERS);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a single pass demonstrably moved the ticket forward: it made at
 * least one commit, or the worktree's HEAD changed between the start and end
 * of the pass. `headBefore`/`headAfter` are both optional — when either is
 * missing (a `captureSha` that could not read HEAD) HEAD movement can't be
 * proven, so only the commit count decides.
 */
export function iterationMadeProgress(input: {
  readonly commitsThisRun: number;
  readonly headBefore?: string;
  readonly headAfter?: string;
}): boolean {
  if (input.commitsThisRun > 0) return true;
  return (
    input.headBefore !== undefined &&
    input.headAfter !== undefined &&
    input.headBefore !== input.headAfter
  );
}

export type BuilderProgressDecision =
  | { readonly kind: "done"; readonly reason: "complete" | "max-iterations"; readonly idleStreak: number }
  | { readonly kind: "continue"; readonly idleStreak: number }
  | { readonly kind: "stop"; readonly reason: "no-progress"; readonly idleStreak: number };

/**
 * The pure decision at the end of every pass. Precedence, in order:
 *
 *   1. A complete pass always wins, regardless of iteration count — `done`
 *      with the streak reset to 0.
 *   2. Otherwise, progress (a commit or HEAD movement) resets the streak to
 *      0; no progress extends it by one.
 *   3. A streak that reaches `idleLimit` stops the batch — even on the very
 *      iteration that would otherwise have exhausted `maxIterations`. A
 *      builder that has made no progress for `idleLimit` passes gets no
 *      benefit from having also reached its iteration ceiling; the "no
 *      progress" reason takes precedence.
 *   4. Reaching `maxIterations` without tripping the streak limit ends the
 *      batch normally (`done`/`max-iterations`) — the batch never runs one
 *      pass more than the old single-call `maxIterations: 100` would have.
 *   5. Otherwise, continue.
 */
export function builderProgressDecision(input: {
  readonly iteration: number;
  readonly maxIterations: number;
  readonly idleLimit: number;
  readonly consecutiveIdle: number;
  readonly outcome: {
    readonly complete: boolean;
    readonly commitsThisRun: number;
    readonly headBefore?: string;
    readonly headAfter?: string;
  };
}): BuilderProgressDecision {
  if (input.outcome.complete) {
    return { kind: "done", reason: "complete", idleStreak: 0 };
  }
  const progressed = iterationMadeProgress({
    commitsThisRun: input.outcome.commitsThisRun,
    headBefore: input.outcome.headBefore,
    headAfter: input.outcome.headAfter,
  });
  const idleStreak = progressed ? 0 : input.consecutiveIdle + 1;
  if (idleStreak >= input.idleLimit) {
    return { kind: "stop", reason: "no-progress", idleStreak };
  }
  if (input.iteration >= input.maxIterations) {
    return { kind: "done", reason: "max-iterations", idleStreak };
  }
  return { kind: "continue", idleStreak };
}

/**
 * Thrown by {@link runBuilderIterations} when `idleLimit` consecutive passes
 * each ended with no completion marker, no new commit, and an unchanged HEAD.
 *
 * Deliberately a PLAIN `Error` subclass with no special handling anywhere:
 * no typed catch arm in `main.mts` reads `instanceof BuilderNoProgressError`,
 * so it takes the ordinary run-fault → recovery road, same as any other
 * unclassified throw. The message is written to avoid every substring the
 * pipeline's classifiers key on (`isTransientError`, `isOutputCapError`,
 * `STALL_RE`) — see the module doc comment for why that classification is
 * the point, not an oversight.
 */
export class BuilderNoProgressError extends Error {
  readonly iterationsRun: number;
  readonly idleStreak: number;
  readonly commits: readonly { sha: string }[];
  readonly headSha?: string;

  constructor(input: {
    readonly iterationsRun: number;
    readonly idleStreak: number;
    readonly commits: readonly { sha: string }[];
    readonly headSha?: string;
  }) {
    const headNote =
      input.headSha !== undefined
        ? ` HEAD has not moved (still ${input.headSha.slice(0, 7)}).`
        : " HEAD has not moved.";
    super(
      `The builder made no progress for ${input.idleStreak} consecutive pass(es): ` +
        `each one ended without a completion marker (neither "${COMPLETION_PROMISE}" ` +
        `nor "${HALT_PROMISE}" nor a clean STORY_COMPLETE/HALT verdict line) and ` +
        `without a new commit.${headNote} Stopped after ${input.iterationsRun} ` +
        `pass(es) instead of re-running the same blank-context pass again ` +
        `(issue #1038, 2026-09-04: eleven such passes in one hour, ~$17, zero code). ` +
        `${input.commits.length} commit(s) from earlier pass(es) remain on the branch.`,
    );
    this.name = "BuilderNoProgressError";
    this.iterationsRun = input.iterationsRun;
    this.idleStreak = input.idleStreak;
    this.commits = input.commits;
    this.headSha = input.headSha;
  }
}

/**
 * Run the implementer as a batch of single-iteration passes, deciding after
 * each one — via {@link builderProgressDecision} — whether to run another,
 * stop declaring completion, or give up on a builder that is spinning blind.
 *
 * - `runOnce(pass, ceilingMs)` must dispatch exactly one `maxIterations: 1`
 *   run and return its raw result. `ceilingMs` is this pass's share of the
 *   shared wall-clock budget (see `deadlineMs` below) — `undefined` when no
 *   deadline was given.
 * - `headSha`, when provided, is read once before the batch starts and again
 *   after every pass; a rejection is swallowed to `undefined` (an unreadable
 *   HEAD can't prove movement, so it degrades to "commits only", never to a
 *   thrown batch).
 * - `deadlineMs`, when finite, is a shared wall-clock deadline (an absolute
 *   `Date.now()`-style timestamp) the WHOLE batch must finish inside. Each
 *   pass's `ceilingMs` is computed fresh as `deadlineMs - now()`; once that
 *   drops to zero or below, the batch throws before starting another pass —
 *   deliberately prefixed `hard ceiling:` so `STALL_RE` classifies it exactly
 *   like today's kill. A non-finite `deadlineMs` (`undefined`, `NaN`) means
 *   "no deadline" and every pass's `ceilingMs` is `undefined`.
 * - `log`, when provided, is called once per pass with a one-line summary.
 */
export async function runBuilderIterations(opts: {
  readonly runOnce: (
    pass: number,
    ceilingMs: number | undefined,
  ) => Promise<BuilderRunResult>;
  readonly isComplete?: (stdout: string) => boolean;
  readonly headSha?: () => Promise<string>;
  readonly maxIterations: number;
  readonly idleLimit: number;
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): Promise<BuilderBatchResult> {
  const isComplete = opts.isComplete ?? implementerIterationComplete;
  const now = opts.now ?? Date.now;
  const readHead = async (): Promise<string | undefined> =>
    opts.headSha === undefined ? undefined : await opts.headSha().catch(() => undefined);

  const stdoutParts: string[] = [];
  const commits: { sha: string }[] = [];
  const iterations: NonNullable<BuilderRunResult["iterations"]>[number][] = [];
  let headBefore = await readHead();
  let consecutiveIdle = 0;

  for (let pass = 1; ; pass += 1) {
    let ceilingMs: number | undefined;
    if (opts.deadlineMs !== undefined && Number.isFinite(opts.deadlineMs)) {
      ceilingMs = opts.deadlineMs - now();
      if (ceilingMs <= 0) {
        throw new Error(
          `hard ceiling: implementer batch exceeded its wall-clock budget across ` +
            `${pass - 1} pass(es) — not starting pass ${pass}`,
        );
      }
    }

    const r = await opts.runOnce(pass, ceilingMs);
    stdoutParts.push(r.stdout);
    commits.push(...r.commits);
    if (r.iterations !== undefined) iterations.push(...r.iterations);

    if (r.stuckAborted === true) {
      return {
        stdout: stdoutParts.join("\n"),
        commits,
        iterations,
        stuckAborted: true,
        iterationsRun: pass,
      };
    }

    const headAfter = await readHead();
    const complete = isComplete(r.stdout);
    const decision = builderProgressDecision({
      iteration: pass,
      maxIterations: opts.maxIterations,
      idleLimit: opts.idleLimit,
      consecutiveIdle,
      outcome: {
        complete,
        commitsThisRun: r.commits.length,
        headBefore,
        headAfter,
      },
    });

    const streakNote =
      decision.kind === "done"
        ? ""
        : ` (no-progress streak ${decision.idleStreak}/${opts.idleLimit})`;
    opts.log?.(
      `implementer pass ${pass}/${opts.maxIterations}: commits=${r.commits.length} ` +
        `complete=${complete} -> ${decision.kind}${streakNote}`,
    );

    if (decision.kind === "done") {
      return {
        stdout: stdoutParts.join("\n"),
        commits,
        iterations,
        iterationsRun: pass,
      };
    }
    if (decision.kind === "stop") {
      throw new BuilderNoProgressError({
        iterationsRun: pass,
        idleStreak: decision.idleStreak,
        commits,
        headSha: headAfter,
      });
    }
    consecutiveIdle = decision.idleStreak;
    headBefore = headAfter;
  }
}
