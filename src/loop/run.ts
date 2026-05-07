/**
 * Top-level entry: runLoop. Mirrors the outer
 * `for ((i=1; i<=ITERATIONS; i++))` loop in afk-ralph.sh:428–832.
 *
 * Responsibilities:
 *   1. Acquire a single-instance lock (`withSingleInstance`) so two loops
 *      can't race on the same repo. Stale-after-60s so a previous-loop crash
 *      doesn't permanently wedge restarts.
 *   2. Startup recovery sweep: any issue still labelled `in-progress` from a
 *      previous (crashed) loop is released back to `ready-for-agent`. The
 *      next planner run will re-pick it.
 *   3. Run the planner ONCE per loop wake-up. The output (priorityOrder +
 *      dependencies) is threaded into runIteration, which walks the queue
 *      and skips issues whose blockers are still open.
 *   4. Create exactly ONE sandbox via createSandbox(). All iteration agents
 *      reuse this sandbox for cache-locality and to keep commits accumulating
 *      on the same branch.
 *   5. Drive runIteration() until any of:
 *        a. iterationNum reaches config.maxIterations
 *        b. runIteration returns no_story (planner queue drained)
 *        c. consecutive QUARANTINEs reach config.consecutiveFailureLimit, OR
 *           consecutive HALTs reach `consecutiveHaltLimit` (default 3).
 *   6. Always close() the sandbox on exit (success or failure path) via the
 *      `await using` disposable pattern.
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
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { createSandbox } from "@ai-hero/sandcastle";
import type { Sandbox } from "@ai-hero/sandcastle";
import type { IterationResult, LoopConfig } from "../types.js";
import { runIteration } from "./iteration.js";
import type { AgentRunner } from "./iteration.js";
import type { IssueRef } from "./briefing.js";
import {
  listReadyIssues,
  transitionLabel,
  withSingleInstance,
  LABEL_IN_PROGRESS,
  LABEL_READY,
} from "../state/index.js";
import { runPlanner } from "../planner/index.js";
import type { PlannerOutput } from "../planner/index.js";

const execFileP = promisify(execFile);

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
  /**
   * Test-only: override the GH issue-fetcher used at iteration start. When
   * omitted, runIteration shells out via `gh issue view --json title,body,labels,number`.
   * @internal
   */
  _fetchIssueBody?: (ghIssue: number) => Promise<IssueRef>;
  /**
   * Test-only: override the planner. When omitted, the production planner
   * runs once per loop wake-up against the live `listReadyIssues()` output.
   * @internal
   */
  _runPlanner?: typeof runPlanner;
  /**
   * Test-only: override the ready-issue lister (skips `gh issue list`). The
   * loop calls this once at wake-up to feed the planner.
   * @internal
   */
  _listReadyIssues?: typeof listReadyIssues;
  /**
   * Test-only: override the in-progress sweep. Used by startup recovery to
   * find stranded `in-progress` issues from a previous (crashed) loop and
   * release them back to `ready-for-agent`.
   * @internal
   */
  _listInProgressIssues?: () => Promise<number[]>;
  /**
   * Test-only: override the label transition (used by startup recovery). When
   * omitted, the live `transitionLabel` from state/index.js is used.
   * @internal
   */
  _transitionLabel?: typeof transitionLabel;
  /**
   * Test-only: override the per-issue blocker-state probe. Threaded to
   * runIteration's planner-priority walk.
   * @internal
   */
  _isIssueDone?: (issueNum: number) => Promise<boolean>;
  /**
   * Test-only: override `withSingleInstance`. Tests inject a no-op so they
   * don't touch the filesystem lock.
   * @internal
   */
  _withSingleInstance?: <T>(
    lockPath: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

/**
 * Default `gh issue list --label in-progress --state open --json number`
 * — used by the startup recovery sweep to find stranded `in-progress` issues
 * from a previous (crashed) loop. Returns the list of issue numbers; on `gh`
 * failure, returns an empty list and logs a warning (the loop can still
 * proceed; stranded issues will just sit until human intervention).
 */
async function defaultListInProgressIssues(): Promise<number[]> {
  try {
    const { stdout } = await execFileP(
      "gh",
      [
        "issue",
        "list",
        "--label",
        LABEL_IN_PROGRESS,
        "--state",
        "open",
        "--json",
        "number",
        "--limit",
        "100",
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout || "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: number[] = [];
    for (const row of parsed as Array<{ number?: unknown }>) {
      if (typeof row.number === "number" && Number.isInteger(row.number)) {
        out.push(row.number);
      }
    }
    return out;
  } catch (err) {
    process.stderr.write(
      `WARN: defaultListInProgressIssues failed: ${(err as Error).message}\n`,
    );
    return [];
  }
}

export async function runLoop(
  opts: RunLoopOptions,
): Promise<IterationResult[]> {
  const { config, branch, sandboxProvider } = opts;
  const create = opts._createSandbox ?? createSandbox;
  const haltLimit = opts.consecutiveHaltLimit ?? 3;
  const planner = opts._runPlanner ?? runPlanner;
  const listReady = opts._listReadyIssues ?? listReadyIssues;
  const listInProgress =
    opts._listInProgressIssues ?? defaultListInProgressIssues;
  const transition = opts._transitionLabel ?? transitionLabel;
  const wrapInSingleInstance = opts._withSingleInstance ?? withSingleInstance;

  const lockPath = path.join(config.repoRoot, ".sandcastle.lock");

  return wrapInSingleInstance(lockPath, async () => {
    const results: IterationResult[] = [];
    // Fix #10 — split counters, mirror the bash driver's CONSECUTIVE_FAILURES
    // + CONSECUTIVE_HALTS pair. Either one tripping its limit short-circuits
    // the loop.
    let consecutiveFailures = 0;
    let consecutiveHalts = 0;

    // === Startup recovery sweep (Fix #7) ===================================
    // Any issue still labelled `in-progress` is from a previous (crashed)
    // loop — release it to `ready-for-agent` so the planner picks it up.
    try {
      const stranded = await listInProgress();
      for (const num of stranded) {
        process.stderr.write(
          `WARN: startup-recovery releasing stranded in-progress issue #${num} → ready-for-agent\n`,
        );
        try {
          await transition(num, LABEL_IN_PROGRESS, LABEL_READY);
        } catch (err) {
          process.stderr.write(
            `WARN: startup-recovery transitionLabel(#${num}) failed (continuing): ${(err as Error).message}\n`,
          );
        }
      }
    } catch (err) {
      process.stderr.write(
        `WARN: startup-recovery sweep failed (continuing): ${(err as Error).message}\n`,
      );
    }

    // === Plan ONCE per loop wake-up (Fix #2) ===============================
    let plannerOutput: PlannerOutput;
    // We need the sandbox to run the planner (it's a sandboxed agent call).
    // The planner runs with an empty input list short-circuit, so on a fresh
    // queue we don't pay for a sandbox.run.
    const openIssues = await listReady();
    // `await using` ensures sandbox.close() runs even on thrown error inside
    // the loop. The disposer waits for any preserved-worktree cleanup before
    // the function returns.
    await using sandbox = await create({
      branch,
      sandbox: sandboxProvider,
    });

    if (openIssues.length === 0) {
      // Empty queue — return no results. The single-instance lock releases on
      // function exit; the sandbox.close runs via the disposer.
      plannerOutput = { priorityOrder: [], dependencies: [] };
    } else {
      try {
        plannerOutput = await planner(sandbox, {
          openIssues: openIssues.map((iss) => ({
            number: iss.number,
            title: iss.title,
            body: iss.body,
            labels: iss.labels,
            createdAt: iss.createdAt,
          })),
        });
      } catch (err) {
        // Planner failure: fall back to a flat priority order (the issue list
        // sorted by listReadyIssues, with no dependencies). Better to attempt
        // work than to wedge the loop on a planner blip.
        process.stderr.write(
          `WARN: planner failed; falling back to flat priority order: ${(err as Error).message}\n`,
        );
        plannerOutput = {
          priorityOrder: openIssues.map((iss) => iss.number),
          dependencies: [],
        };
      }
    }

    // Track which issues this loop wake-up has already attempted so we don't
    // re-pick the same issue on the next iteration. Each shipped/quarantined
    // /halted iteration consumes one entry; the next iteration walks the
    // remaining priorityOrder entries.
    const attemptedIssues = new Set<number>();

    for (let i = 1; i <= config.maxIterations; i++) {
      const outcome = await runIteration({
        sandbox,
        iterationNum: i,
        iterationTotal: config.maxIterations,
        config,
        recoveryPromptPath: opts.recoveryPromptPath,
        plannerOutput: {
          // Filter out already-attempted issues so each loop iteration picks
          // a fresh story.
          priorityOrder: plannerOutput.priorityOrder.filter(
            (n) => !attemptedIssues.has(n),
          ),
          dependencies: plannerOutput.dependencies,
        },
        _commentOnIssue: opts._commentOnIssue,
        _agentRunner: opts._agentRunner,
        _fetchIssueBody: opts._fetchIssueBody,
        _isIssueDone: opts._isIssueDone,
      });

      if ("type" in outcome && outcome.type === "no_story") {
        // Planner queue drained / all eligible issues claimed elsewhere —
        // bash exits 0 here. Stop early.
        return results;
      }

      // Narrowed: outcome is IterationResult.
      const iterResult = outcome as IterationResult;
      results.push(iterResult);

      // Record the issue we just attempted so subsequent iterations don't
      // re-pick it.
      if (typeof iterResult.story.ghIssue === "number" && iterResult.story.ghIssue > 0) {
        attemptedIssues.add(iterResult.story.ghIssue);
      }

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
  });
}
