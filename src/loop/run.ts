/**
 * Top-level entry: runLoop. Mirrors the outer
 * `for ((i=1; i<=ITERATIONS; i++))` loop in afk-ralph.sh:428–832.
 *
 * Responsibilities:
 *   1. Create exactly ONE sandbox via createSandbox(). All iteration agents
 *      reuse this sandbox for cache-locality and to keep commits accumulating
 *      on the same branch (matches the multi-`sandbox.run()` pattern in the
 *      sandcastle README ~lines 265-290).
 *   2. Drive runIteration() until any of:
 *        a. iterationNum reaches config.maxIterations
 *        b. pickNextEligibleStory returns null (PRD drained) — outcome no_story
 *        c. consecutive QUARANTINEs reach config.consecutiveFailureLimit, OR
 *           consecutive HALTs reach `consecutiveHaltLimit` (default 3). Each
 *           limit trips the breaker independently — bash has TWO counters
 *           (CONSECUTIVE_FAILURES + CONSECUTIVE_HALTS) and either one ≥ its
 *           limit halts the loop. (Fix #10)
 *   3. Always close() the sandbox on exit (success or failure path) via the
 *      `await using` disposable pattern.
 *   4. Return one IterationResult per attempted iteration (excluding the
 *      no_story sentinel that signals early termination).
 *
 * Circuit-breaker semantics (Fix #10):
 *   - "shipped"      — resets BOTH consecutive counters to 0.
 *   - "quarantined"  — bumps consecutiveFailures only.
 *   - "halted"       — bumps consecutiveHalts only.
 *   - "skipped"      — bumps NEITHER counter (verification-only iteration,
 *                      not a failure). Fix #13.
 *   - either counter ≥ its limit emits a final IterationResult with
 *     outcome="circuit_break" carrying the last story it tried, then returns.
 */
import { createSandbox } from "@ai-hero/sandcastle";
import type { Sandbox } from "@ai-hero/sandcastle";
import type { IterationResult, LoopConfig } from "../types.js";
import { runIteration } from "./iteration.js";
import type { AgentRunner } from "./iteration.js";

/**
 * Sandbox factory abstraction — production code uses `createSandbox()`,
 * unit tests inject a mock factory. Surfacing this as an explicit option
 * avoids module-level patching of @ai-hero/sandcastle in tests.
 */
export interface RunLoopOptions {
  config: LoopConfig;
  /**
   * Branch to point the sandbox at. Required because `createSandbox`
   * requires an explicit branch (the bash version uses the host's current
   * branch via `git branch --show-current`; the integration step in Track A
   * resolves this from the host repo).
   */
  branch: string;
  /**
   * Sandbox provider — e.g. `docker()`, `podman()`. Caller passes the
   * provider already constructed so this module stays decoupled from the
   * specific runtime choice.
   */
  sandboxProvider: Parameters<typeof createSandbox>[0]["sandbox"];
  /**
   * Path to the recovery prompt template (refs/recovery-prompt.md.local-fork
   * in the bundled scaffolding, but Track A may relocate it). Threaded to
   * runIteration which threads it to Track E's runRecoveryLadder.
   */
  recoveryPromptPath: string;
  /**
   * Fix #10 — independent HALT-rate circuit breaker. Defaults to 3 (matches
   * bash CONSECUTIVE_HALTS_LIMIT). Loop trips when EITHER consecutive
   * quarantines ≥ config.consecutiveFailureLimit OR consecutive halts ≥
   * this value.
   *
   * Lives on the call-site options rather than on `LoopConfig` so this
   * track doesn't need to wait on Fix-A to extend the shared type — the
   * field is optional and defaulted at this seam.
   */
  consecutiveHaltLimit?: number;
  /**
   * Test-only: override the sandbox-creation function. When omitted,
   * production `createSandbox()` is used.
   * @internal
   */
  _createSandbox?: (
    opts: Parameters<typeof createSandbox>[0],
  ) => Promise<Sandbox>;
  /**
   * Test-only: override the GH issue-comment poster used by ship-with-issue-OPEN
   * paths. Threaded to runIteration.
   * @internal
   */
  _commentOnIssue?: (issueNum: number, body: string) => Promise<void>;
  /**
   * Bonus Fix — smoke-test injection seam. When provided, every per-role
   * agent call in agents.ts uses this runner instead of `sandbox.run()`,
   * letting the smoke harness (tests/smoke/run-smoke.ts) supply canned
   * outputs without spinning up Docker.
   * @internal
   */
  _agentRunner?: AgentRunner;
}

export async function runLoop(
  opts: RunLoopOptions,
): Promise<IterationResult[]> {
  const { config, branch, sandboxProvider } = opts;
  const create = opts._createSandbox ?? createSandbox;
  const haltLimit = opts.consecutiveHaltLimit ?? 3;

  const results: IterationResult[] = [];
  // Fix #10 — split counters, mirror the bash driver's CONSECUTIVE_FAILURES
  // + CONSECUTIVE_HALTS pair. Either one tripping its limit short-circuits
  // the loop.
  let consecutiveFailures = 0;
  let consecutiveHalts = 0;

  // `await using` ensures sandbox.close() runs even on thrown error inside
  // the loop. The disposer waits for any preserved-worktree cleanup before
  // the function returns.
  await using sandbox = await create({
    branch,
    sandbox: sandboxProvider,
  });

  for (let i = 1; i <= config.maxIterations; i++) {
    const outcome = await runIteration({
      sandbox,
      iterationNum: i,
      iterationTotal: config.maxIterations,
      config,
      recoveryPromptPath: opts.recoveryPromptPath,
      _commentOnIssue: opts._commentOnIssue,
      _agentRunner: opts._agentRunner,
    });

    if ("type" in outcome && outcome.type === "no_story") {
      // PRD drained — bash exits 0 here (afk-ralph.sh:436). Stop early.
      return results;
    }

    // Narrowed: outcome is IterationResult.
    const iterResult = outcome as IterationResult;
    results.push(iterResult);

    switch (iterResult.outcome) {
      case "shipped":
        // Bash resets BOTH counters on success.
        consecutiveFailures = 0;
        consecutiveHalts = 0;
        break;
      case "quarantined":
        consecutiveFailures += 1;
        break;
      case "halted":
        consecutiveHalts += 1;
        break;
      case "skipped":
        // Fix #13 — neither counter increments. The iteration produced no
        // commit but also wasn't a quarantine/halt; the bash equivalent is
        // "Skipping review." which neither succeeds nor fails the breaker.
        break;
      case "circuit_break":
        // Synthetic — runIteration never returns this. Defensive only.
        break;
    }

    if (
      consecutiveFailures >= config.consecutiveFailureLimit ||
      consecutiveHalts >= haltLimit
    ) {
      const trippedBy =
        consecutiveFailures >= config.consecutiveFailureLimit
          ? `${consecutiveFailures} consecutive quarantines`
          : `${consecutiveHalts} consecutive halts`;
      results.push({
        story: iterResult.story,
        outcome: "circuit_break",
        iterationsUsed: i,
        haltReason: `circuit_breaker: ${trippedBy}`,
      });
      return results;
    }
  }

  return results;
}
