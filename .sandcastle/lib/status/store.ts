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

import { writeFileSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import {
  type SandcastleStatus,
  type IssuePhase,
  type RunActivity,
  type StatusHistoryEntry,
  STATUS_SCHEMA_VERSION,
  HEARTBEAT_MS,
} from "./schema.js";
import { foldPeers } from "./merge.js";

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
  /**
   * Stable identity of THIS host — written into every snapshot (even
   * single-host) so cross-host viewers can attribute and fold. Derived at the
   * store's call site (main.mts, Task S2).
   */
  hostId: string;
  /**
   * Shared-run identity — the same value across every host collaborating on one
   * logical run, so a viewer groups their snapshots. Also derived at the call
   * site (Task S2).
   */
  runId: string;
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
  /**
   * OS process id to stamp into the snapshot (2b). Defaults to the live
   * `process.pid`; injectable so tests are deterministic. A same-host reconciler
   * reads it back to prove a hard-killed loop is gone.
   */
  pid?: number;
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
   * Graceful-stop TELEMETRY (2c). On SIGTERM/SIGINT the loop calls this the
   * instant the signal lands: it flips `state` to the transient `"stopping"` and
   * records `stoppingWaitingOn` — a human label of the in-flight work being
   * drained (active issue phases, else the run-level activity) — so status
   * tooling can show "stopping — waiting on implementer for #5". PURELY
   * ADDITIVE: it changes no control flow and does NOT stop the heartbeat (the
   * loop is still draining at the iteration boundary). `finish()` later
   * overwrites the transient state with the real terminal reason.
   */
  markStopping(): void;
  /**
   * Cross-host STATUS SYNC (Task S5): set the peer snapshots that `commit()`
   * folds into the WRITTEN file (via `foldPeers`) so a viewer sees one fused,
   * host-tagged loop. The in-memory `status` (esp. `status.history`) stays
   * OWN-ONLY truth — folding happens at write time, never mutates `status`, and
   * `snapshot()` still returns own-only (that is what gets PUBLISHED, so peers
   * never re-fold each other's folds).
   *
   * SYNCHRONOUS (mutate `peerSnapshots` then `commit()`), preserving the
   * race-safety invariant — do NOT make it async.
   *
   * Passing `[]` restores byte-identical own-only writes (single-host / flag-off).
   */
  setPeers(peers: SandcastleStatus[]): void;
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

/**
 * OUT-OF-BAND status reconciler for the post-kill `--now` path (2b). After a hard
 * kill the loop process is GONE — there is no live StatusStore to call `finish()`
 * — so `status.json` keeps lying `state:"running"` forever. The
 * `checkpoint-stop.mts` runner calls this as its FINAL step to flip the feed to
 * `stopped` once the git refs are handled.
 *
 * Surgical + best-effort: it reads the existing snapshot, overwrites ONLY the
 * liveness-bearing fields (`state`, `updatedAt`) and clears the now-meaningless
 * transient labels (`activity`, `stoppingWaitingOn`), preserving everything else
 * (history, totals, ids). If the file is absent or unparseable there is nothing
 * to un-lie about, so it no-ops and returns `false` — NEVER throws (a stop must
 * not fail because a glance surface hiccuped). Returns `true` iff it rewrote.
 */
export function markStatusStopped(opts: {
  path: string;
  now?: () => string;
  readFn?: (path: string) => string;
  writeFn?: WriteFn;
  onError?: (err: unknown) => void;
}): boolean {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const readFn = opts.readFn ?? ((p): string => readFileSync(p, "utf8"));
  const writeFn = opts.writeFn ?? atomicWrite;
  const onError = opts.onError ?? ((): void => {});
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFn(opts.path)) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    obj = parsed as Record<string, unknown>;
  } catch {
    // Absent or torn/unparseable — nothing to reconcile. Best-effort no-op.
    return false;
  }
  obj.state = "stopped";
  obj.updatedAt = now();
  delete obj.activity;
  delete obj.stoppingWaitingOn;
  try {
    writeFn(opts.path, `${JSON.stringify(obj, null, 2)}\n`);
    return true;
  } catch (err) {
    onError(err);
    return false;
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
  const pid = opts.pid ?? process.pid;

  let heartbeatHandle: unknown;

  // Peer snapshots folded into the WRITTEN file at commit time. Empty ⇒ the
  // written bytes are own-only and byte-identical to the pre-cross-host writer.
  let peerSnapshots: SandcastleStatus[] = [];

  const status: SandcastleStatus = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    state: "running",
    hostId: meta.hostId,
    runId: meta.runId,
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
    pid,
  };

  function recomputeRunning(): void {
    status.totals.running = status.issues.filter((i) =>
      ACTIVE_PHASES.has(i.phase),
    ).length;
  }

  /**
   * Mutate-then-write. The only place `updatedAt` is stamped and IO happens,
   * and the ONLY writer of the merged status.json.
   *
   * Folds `peerSnapshots` into the serialized view WITHOUT mutating `status`
   * (own-history stays own-only truth). CRITICAL: when there are no peers,
   * `out === status` so the written bytes are IDENTICAL to the pre-cross-host
   * writer — the flag-off / single-host byte-for-byte invariant. Only fold when
   * peers are present.
   */
  function commit(): void {
    status.updatedAt = now();
    const out =
      peerSnapshots.length > 0 ? foldPeers(status, peerSnapshots) : status;
    try {
      writeFn(path, `${JSON.stringify(out, null, 2)}\n`);
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

    setPeers(peers: SandcastleStatus[]): void {
      peerSnapshots = peers;
      commit();
    },

    markStopping(): void {
      // Describe what the graceful stop is draining, most-specific first:
      // active per-issue phases, else the run-level activity, else nothing.
      const active = status.issues.filter((i) => ACTIVE_PHASES.has(i.phase));
      let waitingOn: string | undefined;
      if (active.length > 0) {
        waitingOn = active
          .map((i) => `${i.phase} for #${i.number}`)
          .join(", ");
      } else if (status.activity !== undefined) {
        waitingOn = status.activity;
      }
      status.state = "stopping";
      // `undefined` (not "") so JSON.stringify drops the key when nothing is in
      // flight, matching the schema's optional contract.
      status.stoppingWaitingOn = waitingOn;
      // Deliberately do NOT stopHeartbeat(): the loop is still alive and
      // draining, so the feed must keep re-stamping until finish().
      commit();
    },

    finish(reason: "done" | "stopped" | "restarting" | "unhealthy"): void {
      status.state = reason;
      status.activity = undefined; // run over — no stale activity on the feed
      status.stoppingWaitingOn = undefined; // transient telemetry cleared on exit
      stopHeartbeat(); // the run is over — stop the keep-alive
      recomputeRunning();
      commit();
    },

    snapshot(): SandcastleStatus {
      return JSON.parse(JSON.stringify(status)) as SandcastleStatus;
    },
  };
}
