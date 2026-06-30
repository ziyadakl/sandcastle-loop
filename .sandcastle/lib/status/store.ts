/**
 * In-memory status object + synchronous, non-fatal, atomic writer behind the
 * `sandcastle-watch` viewer. The loop holds ONE store, constructed after the
 * single-instance lock (so a second loop never clobbers a live status.json),
 * and threads it through `PipelineCtx`.
 *
 * RACE-SAFETY: the per-issue pipelines dispatch through a semaphore +
 * `Promise.allSettled` (main.mts). Every mutator here is STRICTLY synchronous —
 * it mutates the object, sets `updatedAt`, and writes the whole file in one
 * tick with no `await`. Because JS is single-threaded a synchronous mutator
 * cannot interleave with another, which is what makes the shared-pid tmp file
 * and the atomic rename safe. Do NOT make `writeFn` async — that reintroduces
 * the torn-write race.
 *
 * NON-FATAL: a write failure is routed to `onError` (wire to `deps.logError`)
 * and never thrown — a disk hiccup on a glance surface must not kill an
 * overnight run.
 */

import { writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  type SandcastleStatus,
  type IssuePhase,
  type RunActivity,
  type StatusHistoryEntry,
  STATUS_SCHEMA_VERSION,
  HEARTBEAT_MS,
} from "./schema.js";

export interface StatusStoreMeta {
  branch: string;
  /** Display name for the run (e.g. "affinity-tracker"). */
  repo: string;
  /** Filesystem root; default path is `<repoRoot>/.sandcastle/status.json`. */
  repoRoot: string;
  /** ISO-8601 run start. */
  startedAt: string;
  iterationsTotal: number;
  maxConcurrent: number;
}

/** Minimal plan-issue input — decoupled from main.mts's `PlanIssue`. */
export interface StatusPlanInput {
  number: number;
  title: string;
  branch: string;
}

/** Minimal outcome input — structurally satisfied by main.mts's `IssueOutcome`. */
export interface StatusOutcomeInput {
  status: "ok" | "quarantined" | "error" | "deferred";
  finalMarker?: string;
}

type WriteFn = (path: string, content: string) => void;

export interface StatusStoreOpts {
  /** Override for tests. MUST stay synchronous — see the race-safety note. */
  writeFn?: WriteFn;
  /** Non-fatal write-error sink. Wire to `deps.logError` in production. */
  onError?: (err: unknown) => void;
  /** Override the status.json path. Default `<repoRoot>/.sandcastle/status.json`. */
  path?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  /** Injectable timers for deterministic heartbeat tests. Default globals. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface StatusStore {
  startIteration(current: number): void;
  setPlan(issues: ReadonlyArray<StatusPlanInput>): void;
  setIssuePhase(issueNumber: number, phase: IssuePhase, detail?: string): void;
  recordOutcome(issueNumber: number, outcome: StatusOutcomeInput): void;
  /**
   * Set (or clear, with `null`) the run-level activity label for CROSS-ISSUE
   * steps that no per-issue phase covers — planning, merging, post-merge
   * review, cleanup. Drives the viewer's "running" panel subtitle so it never
   * shows a false "idle" between issues. Synchronous mutate-then-commit like
   * every other mutator.
   */
  setActivity(activity: RunActivity | null): void;
  /**
   * Begin emitting periodic keep-alive writes (every `HEARTBEAT_MS`) that
   * re-stamp `updatedAt` so the viewer's staleness gate doesn't false-fire
   * during a long phase that produces no transition. Idempotent; `finish()`
   * stops it. Call once after construction (production only).
   */
  startHeartbeat(): void;
  finish(reason: "done" | "stopped" | "restarting" | "unhealthy"): void;
  /** Defensive copy of the current snapshot (tests / inspection). */
  snapshot(): SandcastleStatus;
}

/**
 * Atomic file write: tmp + rename. Replicated from
 * `.sandcastle/scripts/assemble-variant.mts` so this module is self-contained.
 * Safe with a shared-pid tmp name ONLY because every caller is synchronous.
 */
function atomicWrite(target: string, content: string): void {
  const tmp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/** Phases that count an issue as actively in flight (drives totals.running). */
const ACTIVE_PHASES: ReadonlySet<IssuePhase> = new Set<IssuePhase>([
  "implementer",
  "reviewer",
  "implementer-retry",
  "recovery",
  "merge",
]);

export function createStatusStore(
  meta: StatusStoreMeta,
  opts: StatusStoreOpts = {},
): StatusStore {
  const writeFn = opts.writeFn ?? atomicWrite;
  const onError = opts.onError ?? ((): void => {});
  const now = opts.now ?? ((): string => new Date().toISOString());
  const path =
    opts.path ?? join(meta.repoRoot, ".sandcastle", "status.json");
  const setIntervalFn =
    opts.setIntervalFn ?? ((fn, ms): unknown => setInterval(fn, ms));
  const clearIntervalFn =
    opts.clearIntervalFn ??
    ((h): void => clearInterval(h as ReturnType<typeof setInterval>));

  let heartbeatHandle: unknown;

  const status: SandcastleStatus = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    state: "running",
    run: {
      branch: meta.branch,
      repo: meta.repo,
      startedAt: meta.startedAt,
      iterations: { current: 0, total: meta.iterationsTotal },
      maxConcurrent: meta.maxConcurrent,
    },
    totals: { merged: 0, needsHuman: 0, requeued: 0, running: 0 },
    issues: [],
    history: [],
    updatedAt: now(),
  };

  function recomputeRunning(): void {
    status.totals.running = status.issues.filter((i) =>
      ACTIVE_PHASES.has(i.phase),
    ).length;
  }

  /** Mutate-then-write. The only place `updatedAt` is stamped and IO happens. */
  function commit(): void {
    status.updatedAt = now();
    try {
      writeFn(path, `${JSON.stringify(status, null, 2)}\n`);
    } catch (err) {
      onError(err);
    }
  }

  function findIssue(n: number): SandcastleStatus["issues"][number] | undefined {
    return status.issues.find((i) => i.number === n);
  }

  function stopHeartbeat(): void {
    if (heartbeatHandle !== undefined) {
      clearIntervalFn(heartbeatHandle);
      heartbeatHandle = undefined;
    }
  }

  return {
    startHeartbeat(): void {
      if (heartbeatHandle !== undefined) return; // idempotent
      // A keep-alive write is just `commit()` — it re-stamps `updatedAt` and
      // re-serializes the (unchanged) object. Synchronous, like every mutator.
      heartbeatHandle = setIntervalFn(() => commit(), HEARTBEAT_MS);
      // The keep-alive must NEVER hold the event loop open past a clean exit.
      (heartbeatHandle as { unref?: () => void } | null)?.unref?.();
    },

    startIteration(current: number): void {
      status.run.iterations.current = current;
      commit();
    },

    setPlan(issues: ReadonlyArray<StatusPlanInput>): void {
      status.issues = issues.map((i) => ({
        number: i.number,
        title: i.title,
        branch: i.branch,
        phase: "planned" as IssuePhase,
      }));
      recomputeRunning();
      commit();
    },

    setIssuePhase(issueNumber: number, phase: IssuePhase, detail?: string): void {
      const issue = findIssue(issueNumber);
      if (!issue) return;
      issue.phase = phase;
      if (detail !== undefined) issue.detail = detail;
      if (issue.startedAt === undefined && phase !== "planned") {
        issue.startedAt = now();
      }
      if (phase === "needs-human") issue.attention = true;
      recomputeRunning();
      commit();
    },

    recordOutcome(issueNumber: number, outcome: StatusOutcomeInput): void {
      const issue = findIssue(issueNumber);
      if (outcome.status === "ok") {
        status.totals.merged += 1;
        if (issue) issue.phase = "merged";
      } else if (outcome.status === "deferred") {
        status.totals.requeued += 1;
        if (issue) issue.phase = "deferred";
      } else {
        // "quarantined" | "error"
        status.totals.needsHuman += 1;
        if (issue) {
          issue.phase = "needs-human";
          issue.attention = true;
        }
      }
      if (issue && outcome.finalMarker !== undefined) {
        issue.detail = outcome.finalMarker;
      }
      // Append-only history of terminal outcomes. INVARIANT: `issue` is always
      // found here in practice — `recordOutcome` is only ever called for numbers
      // drawn from the same plan that `setPlan` recorded. The totals above are
      // bumped unconditionally, so a `findIssue` miss would leave history short
      // of totals; the guard is defensive, not an expected branch.
      if (issue) {
        const entry: StatusHistoryEntry = {
          number: issue.number,
          title: issue.title,
          branch: issue.branch,
          phase: issue.phase,
          completedAt: now(),
        };
        status.history.push(entry);
      }
      recomputeRunning();
      commit();
    },

    setActivity(activity: RunActivity | null): void {
      // `undefined` so JSON.stringify drops the key entirely when cleared —
      // the viewer then sees no activity and falls back to its idle copy.
      status.activity = activity ?? undefined;
      commit();
    },

    finish(reason: "done" | "stopped" | "restarting" | "unhealthy"): void {
      status.state = reason;
      status.activity = undefined; // run over — no stale activity on the feed
      stopHeartbeat(); // the run is over — stop the keep-alive
      recomputeRunning();
      commit();
    },

    snapshot(): SandcastleStatus {
      return JSON.parse(JSON.stringify(status)) as SandcastleStatus;
    },
  };
}
