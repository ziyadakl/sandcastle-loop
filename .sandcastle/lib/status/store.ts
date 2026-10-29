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

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ModelBreakdownRow, RoleBreakdown } from "../cost/ledger.js";
import type { StatusPusher } from "./push.js";
import type {
  IssuePhase,
  IssueTelemetryRow,
  RunActivity,
  RunIdentity,
  RunTelemetry,
  SandcastleStatus,
  StatusHistoryEntry,
} from "./schema.js";
import { foldPeers } from "./merge.js";
import { nullPusher } from "./push.js";
import { HEARTBEAT_MS, STATUS_SCHEMA_VERSION } from "./schema.js";

export interface StatusStoreMeta {
  branch: string;
  /** Display name for the run (e.g. "my-project"). */
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
  /**
   * Live outbound feed. Handed the SAME serialized view that is written to
   * disk, on every commit. Fire-and-forget by contract (see `push.ts`): it must
   * return synchronously and must never throw, because `commit()` is
   * synchronous and telemetry may not fail a run. Absent ⇒ no push.
   */
  pusher?: StatusPusher;
}

export interface StatusStore {
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
   * Bump ONLY the genuine-progress clock (`lastProgressAt`, via a
   * `commit({ progress: true })`) with NO other state change, recording that a
   * bounded cross-issue SUB-STEP has completed — one ceiling-bounded agent
   * dispatch inside a long run-level step (the merger's escalation ladder, the
   * post-merge review, or the post-merge fix ladder).
   *
   * WHY IT EXISTS. `setActivity(...)` bumps the progress clock exactly ONCE at
   * the boundary of a cross-issue step (planning / merging / reviewing /
   * cleanup). But the "reviewing" and "merging" steps each run SEVERAL agent
   * dispatches back-to-back under that single label — each bounded only by the
   * 60-min `hardCeilingSec`, with no per-issue `setIssuePhase` bump between them.
   * Two ceiling-length dispatches under one `setActivity` = 120 min with
   * `lastProgressAt` frozen, so the stall watchdog (`scripts/stall-watchdog.mts`,
   * 90-min limit) SIGKILLed a healthy, working loop. Calling this after each
   * bounded sub-step keeps the clock fresh across the whole long-but-healthy
   * step so it cannot be false-killed.
   *
   * WHY IT CANNOT MASK A REAL HANG. It is called ONLY after a dispatch wrapped
   * by `withHardCeiling` has RETURNED or been ceiling-killed — never on a bare
   * timer, and never at the START of (or around) an unbounded wait. So the gap
   * between two bumps can never exceed one hard ceiling. A wedge INSIDE a
   * dispatch never lets it complete, so it never bumps here, and a hang OUTSIDE
   * a dispatch (e.g. an unbounded install) is never bracketed by this call — in
   * both cases the watchdog still fires, exactly as the loop's doctrine requires.
   * Synchronous mutate-then-commit like every other mutator; do NOT make it async.
   */
  noteProgress(): void;
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
   * Await delivery of any queued live-feed push. Called once on the way out so
   * a run's TERMINAL state and final cost actually reach the dashboard — those
   * are committed last, and without this the process can exit while the final
   * request is still in flight. A no-op when push is unconfigured; never
   * throws, never waits longer than the request timeout.
   */
  flushPush(): Promise<void>;
  /**
   * Phase-1 cost telemetry sink: record the run's total ESTIMATED cost in USD
   * (from the cost ledger's `summary().totalCostUsd`) into `totals.totalCostUsd`
   * and commit. Called once near run end. The field is OPTIONAL in the schema —
   * callers that never invoke this leave it absent, so old files and flag-off
   * runs stay byte-compatible. Synchronous mutate-then-commit like every mutator;
   * a relative estimate, not a billed figure (see `lib/cost/pricing.ts`).
   */
  recordCost(totalCostUsd: number): void;
  /**
   * Phase-2 per-role telemetry sink: record the merged per-role breakdown
   * (estimated cost + total tokens from the cost ledger, cumulative wall-clock
   * ms + dispatch count from the timing ledger) into `totals.perRole` and
   * commit. Called once near run end, alongside {@link recordCost}. The field is
   * OPTIONAL in the schema — callers that never invoke this (or invoke it only
   * with a non-empty record) leave it absent, so old files and flag-off/no-
   * dispatch runs stay byte-compatible. Synchronous mutate-then-commit like every
   * mutator; relative estimates, not billed figures (see `lib/cost/pricing.ts`).
   */
  recordRoleBreakdown(perRole: Record<string, RoleBreakdown>): void;
  /**
   * Phase-3 per-model telemetry sink: record the ledger's per-(role, model)
   * breakdown into `totals.perModel` and commit. Called once near run end,
   * alongside {@link recordRoleBreakdown}. Splitting a role's cost by which
   * model actually ran it is what lets a viewer see a role that escalated
   * mid-run (its default model failed and a retry ran on a stronger one) as
   * more than one row, and price that escalation on its own — something
   * `perRole` alone collapses into a single blended number. OPTIONAL in the
   * schema, same "absent when never called" contract as `recordRoleBreakdown`.
   */
  recordModelBreakdown(perModel: ModelBreakdownRow[]): void;
  /**
   * Per-issue TELEMETRY sink: record one row per issue the run worked into the
   * TOP-LEVEL `issueTelemetry` and commit. This is what makes cost attributable
   * to a ticket rather than only to a role.
   *
   * TOP-LEVEL, deliberately not under `totals` (settled — see the placement
   * block at `schema.ts:283-316`): `sumTotalsAcrossHosts` (`merge.ts:33-45`)
   * hardcodes four integer adds, so a fifth key under `totals` would render
   * own-host-only beside four fused values. Top-level keys pass through
   * `foldPeers` and `trimForPush` untouched, and `setPlan`'s wholesale
   * replacement of `issues[]` can never wipe them.
   *
   * WHOLESALE REPLACEMENT, not append: callers hold the full row set and
   * re-state it, so a re-record of an issue (a defer-then-reclaim) updates in
   * place instead of double-counting. OPTIONAL in the schema — a caller that
   * never invokes this leaves the key ABSENT (not `[]`), so old files and
   * flag-off runs stay byte-compatible, and "never captured" stays
   * distinguishable from "captured zero rows". Synchronous mutate-then-commit
   * like every mutator; relative estimates, not billed figures.
   */
  recordIssueTelemetry(rows: IssueTelemetryRow[]): void;
  /**
   * Run-level TELEMETRY sink: merge `patch` into the TOP-LEVEL `runTelemetry`
   * and commit — counters, error classes, per-role cache economics, and the
   * batch-role `overheadCostUsd` that makes
   * `sum(issueTelemetry[].costUsd) + overheadCostUsd` reconcile to the run
   * total.
   *
   * MERGE, not replace, and SHALLOW. Merge because {@link recordRunIdentity}
   * writes `identity` — a sibling member of this same object — at a DIFFERENT
   * time (identity is known at startup, the counters only at run end), so a
   * replacing write in either order would silently drop the other's work.
   * Shallow means a second patch carrying `counters` replaces the whole
   * `counters` member rather than deep-merging its leaves: callers hold the
   * complete member and re-state it. Same "absent when never called" contract
   * and top-level placement rationale as {@link recordIssueTelemetry}.
   */
  recordRunTelemetry(patch: RunTelemetry): void;
  /**
   * Run IDENTITY sink: record what this run WAS — resolved model map, profile,
   * backend/provider, prompt hashes — into `runTelemetry.identity` and commit.
   * RESOLVED, not configured, which is what makes a mislabeled profile
   * self-detecting (a run tagged `budget` whose implementer default is an Opus
   * id is visibly wrong from this field alone), and what makes two runs
   * comparable — or proves they aren't.
   *
   * Called EARLY (identity is known once the model map resolves), whereas
   * {@link recordRunTelemetry} lands near run end; it merges into the same
   * object rather than replacing it for exactly that reason. Order-independent:
   * either may run first.
   */
  recordRunIdentity(identity: RunIdentity): void;
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
 * Read a status file as an untyped object, for out-of-band editors that must
 * preserve fields they do not know. Undefined when absent, torn or not an
 * object. Never throws.
 */
export function readStatusLoose(
  path: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
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
  /** Edit the parsed snapshot before it is flipped to `stopped` and written. */
  mutate?: (obj: Record<string, unknown>) => void;
  writeFn?: WriteFn;
  onError?: (err: unknown) => void;
}): boolean {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const writeFn = opts.writeFn ?? atomicWrite;
  const onError = opts.onError ?? ((): void => {});
  // Absent or torn/unparseable — nothing to reconcile. Best-effort no-op.
  const obj = readStatusLoose(opts.path);
  if (obj === undefined) return false;
  opts.mutate?.(obj);
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

/** States a live loop owns; any other state is final and is never rewritten. */
const NON_TERMINAL_STATES: ReadonlySet<unknown> = new Set([
  "running",
  "restarting",
  "stopping",
]);

/**
 * OUT-OF-BAND flip to `unhealthy` for a run whose wrapper died before a loop
 * could take over (failed pre-start install; #1370). Only a
 * non-terminal state is rewritten; `reason` goes in the free-form `activity`
 * label, which the viewer shows beside the banner. Absent/torn file or a final
 * state: no-op, returns `false`. Never throws.
 */
export function markStatusUnhealthy(opts: {
  path: string;
  reason: string;
  now?: () => string;
  onError?: (err: unknown) => void;
}): boolean {
  const now = opts.now ?? ((): string => new Date().toISOString());
  const obj = readStatusLoose(opts.path);
  if (obj === undefined || !NON_TERMINAL_STATES.has(obj.state)) return false;
  obj.state = "unhealthy";
  obj.activity = opts.reason;
  obj.updatedAt = now();
  delete obj.stoppingWaitingOn;
  try {
    atomicWrite(opts.path, `${JSON.stringify(obj, null, 2)}\n`);
    return true;
  } catch (err) {
    opts.onError?.(err);
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

/**
 * Phases that count as "working" for the owner-facing per-ticket tally
 * (`recomputeTickets` below) — a DIFFERENT set from `ACTIVE_PHASES`, which
 * exists only to drive `totals.running` and must stay exactly as it was.
 * #1191 finding F: `recomputeTickets` used to bucket everything not
 * `planned` or in `ACTIVE_PHASES` as `done`, which wrongly counted a ticket
 * sitting at `check-writer` or `judge` (still being worked, just before the
 * builder starts) or `needs-rerun` (still active — it auto-requeues, see
 * `IssuePhaseSchema`'s own doc comment) as finished. `WORKING_PHASES` is
 * `ACTIVE_PHASES` plus those three, so the tally's `working` count reflects
 * every phase that is not genuinely done and not merely queued.
 */
export const WORKING_PHASES: ReadonlySet<IssuePhase> = new Set<IssuePhase>([
  ...ACTIVE_PHASES,
  "check-writer",
  "judge",
  "needs-rerun",
]);

/**
 * Phases `setPlan` must never reset a re-dealt row out of (D3, Opus review) —
 * a ticket already SHIPPED (`merged`) or already flagged for a human
 * (`needs-human`) must not silently fall back to `planned` just because the
 * dealer's next refill happens to re-offer its number (a stale ranked stack,
 * a planner re-listing something it hasn't learned is done yet). `deferred`
 * is deliberately NOT in this set even though the web viewer's own
 * `TERMINAL_PHASES` treats it as terminal for DISPLAY purposes — for the
 * dealer's purposes a deferred ticket is exactly the kind of thing a later
 * plan call is supposed to pick back up.
 */
const SKIP_REPLAN_PHASES: ReadonlySet<IssuePhase> = new Set<IssuePhase>([
  "merged",
  "needs-human",
]);

export function createStatusStore(
  meta: StatusStoreMeta,
  opts: StatusStoreOpts = {},
): StatusStore {
  const writeFn = opts.writeFn ?? atomicWrite;
  const onError = opts.onError ?? ((): void => {});
  const now = opts.now ?? ((): string => new Date().toISOString());
  const path = opts.path ?? join(meta.repoRoot, ".sandcastle", "status.json");
  const setIntervalFn =
    opts.setIntervalFn ?? ((fn, ms): unknown => setInterval(fn, ms));
  const clearIntervalFn =
    opts.clearIntervalFn ??
    ((h): void => clearInterval(h as ReturnType<typeof setInterval>));
  const pid = opts.pid ?? process.pid;
  // Absent ⇒ a no-op, so an unconfigured host behaves exactly as before.
  const pusher = opts.pusher ?? nullPusher();

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
      tickets: { done: 0, working: 0, waiting: 0, cap: meta.iterationsTotal },
    },
    totals: { merged: 0, needsHuman: 0, requeued: 0, running: 0 },
    issues: [],
    history: [],
    updatedAt: now(),
    // Seed the progress clock at run start so a brand-new run is never seen as
    // stalled, and so a fresh timestamp lands even before the first mutator.
    lastProgressAt: now(),
    pid,
  };

  function recomputeRunning(): void {
    status.totals.running = status.issues.filter((i) =>
      ACTIVE_PHASES.has(i.phase),
    ).length;
  }

  /**
   * Derives the #902 per-ticket tally from `status.issues`' phases: `waiting`
   * is phase `planned` (dealt but not yet picked up), `working` uses
   * `WORKING_PHASES` above (NOT `ACTIVE_PHASES` — #1191 finding F; a ticket
   * at `check-writer`/`judge`/`needs-rerun` is still being worked, not done),
   * and `done` is everything else. `cap` is the run's
   * ticket ceiling — `meta.iterationsTotal` for now (renaming the field this
   * reads from is deferred; listed in PR #1191's deferred section). Written
   * to `run.tickets` (D2, Opus review) — the same
   * object `run.iterations` lives on and the field it replaces — not a
   * top-level key, so `PeerStatusSchema` can project it exactly the way it
   * already projects `iterations`. Called from inside `commit()` (D1, Opus
   * review) — the ONE place every write passes through — rather than from
   * each mutator, so a future mutator can never forget to keep it current.
   */
  function recomputeTickets(): void {
    let waiting = 0;
    let working = 0;
    let done = 0;
    for (const issue of status.issues) {
      if (issue.phase === "planned") waiting += 1;
      else if (WORKING_PHASES.has(issue.phase)) working += 1;
      else done += 1;
    }
    status.run.tickets = { done, working, waiting, cap: meta.iterationsTotal };
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
  function commit(opts?: { progress?: boolean }): void {
    // Derived HERE, not at each mutator's call site (D1, Opus review): a
    // single point every write passes through means no future mutator can
    // forget to keep the tally current, the way three separate call sites
    // could silently drift.
    recomputeTickets();
    const ts = now();
    status.updatedAt = ts;
    // GENUINE PROGRESS ONLY. `updatedAt` is bumped on every commit — including
    // the keep-alive heartbeat, which passes no `opts` — so it proves the
    // process is alive but says nothing about whether work advanced.
    // `lastProgressAt` is bumped ONLY when a real mutator asks for it, so it is
    // the one clock the stall watchdog can trust to spot a wedged loop. NEVER
    // set it from `startHeartbeat`'s `commit()`.
    if (opts?.progress === true) status.lastProgressAt = ts;
    const out =
      peerSnapshots.length > 0 ? foldPeers(status, peerSnapshots) : status;
    try {
      writeFn(path, `${JSON.stringify(out, null, 2)}\n`);
    } catch (err) {
      onError(err);
    }
    // Live feed, AFTER the durable write: disk is the source of truth and must
    // never be delayed or skipped by telemetry. `push` is fire-and-forget and
    // cannot throw (see push.ts), so this stays synchronous and inert.
    pusher.push(out);
  }

  function findIssue(
    n: number,
  ): SandcastleStatus["issues"][number] | undefined {
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

    setPlan(issues: ReadonlyArray<StatusPlanInput>): void {
      // Merge-by-number for the rolling refill pool (#902): the dealer calls
      // `setPlan` on every refill with just the newly-dealt cards, not the
      // whole board, so this can no longer wholesale-replace `status.issues`
      // — that would erase every in-flight row (`implementer`, `merge`, …)
      // the instant the pool refilled. An UNKNOWN number is appended as
      // `planned`; a KNOWN number (the dealer re-offering a card, e.g. after
      // its blocker closed) resets to a fresh `planned` row, dropping any
      // stale `detail`/`attention`/`startedAt` — UNLESS that row is already in
      // a `SKIP_REPLAN_PHASES` phase (D3, Opus review: a shipped or
      // needs-human ticket must never fall back to `planned`), in which case
      // it is left exactly as-is; every number NOT in this call is likewise
      // left untouched.
      for (const incoming of issues) {
        const existing = findIssue(incoming.number);
        if (existing) {
          if (SKIP_REPLAN_PHASES.has(existing.phase)) continue;
          existing.title = incoming.title;
          existing.branch = incoming.branch;
          existing.phase = "planned" as IssuePhase;
          existing.detail = undefined;
          existing.startedAt = undefined;
          existing.attention = undefined;
        } else {
          status.issues.push({
            number: incoming.number,
            title: incoming.title,
            branch: incoming.branch,
            phase: "planned" as IssuePhase,
          });
        }
      }
      recomputeRunning();
      commit({ progress: true });
    },

    setIssuePhase(
      issueNumber: number,
      phase: IssuePhase,
      detail?: string,
    ): void {
      const issue = findIssue(issueNumber);
      if (!issue) return;
      issue.phase = phase;
      if (detail !== undefined) issue.detail = detail;
      if (issue.startedAt === undefined && phase !== "planned") {
        issue.startedAt = now();
      }
      if (phase === "needs-human") issue.attention = true;
      recomputeRunning();
      commit({ progress: true });
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
      commit({ progress: true });
    },

    setActivity(activity: RunActivity | null): void {
      // `undefined` so JSON.stringify drops the key entirely when cleared —
      // the viewer then sees no activity and falls back to its idle copy.
      status.activity = activity ?? undefined;
      // A cross-issue step (planning / merging / cleanup) IS work advancing —
      // it is often the ONLY progress signal during a long between-issues gap.
      commit({ progress: true });
    },

    noteProgress(): void {
      // Genuine forward progress with no other state change: a bounded
      // cross-issue sub-step (a ceiling-bounded agent dispatch) has completed.
      // See the interface doc for why this can never mask an unbounded hang.
      commit({ progress: true });
    },

    setPeers(peers: SandcastleStatus[]): void {
      peerSnapshots = peers;
      commit();
    },

    recordCost(totalCostUsd: number): void {
      status.totals.totalCostUsd = totalCostUsd;
      commit();
    },

    recordRoleBreakdown(perRole: Record<string, RoleBreakdown>): void {
      status.totals.perRole = perRole;
      commit();
    },

    recordModelBreakdown(perModel: ModelBreakdownRow[]): void {
      status.totals.perModel = perModel;
      commit();
    },

    recordIssueTelemetry(rows: IssueTelemetryRow[]): void {
      status.issueTelemetry = rows;
      commit();
    },

    recordRunTelemetry(patch: RunTelemetry): void {
      // Spread-merge, NOT assign: `identity` is written separately (and at a
      // different time) by `recordRunIdentity`, so replacing would drop it.
      // `{...undefined}` is `{}`, so the first call creates the object.
      status.runTelemetry = { ...status.runTelemetry, ...patch };
      commit();
    },

    recordRunIdentity(identity: RunIdentity): void {
      status.runTelemetry = { ...status.runTelemetry, identity };
      commit();
    },

    markStopping(): void {
      // Describe what the graceful stop is draining, most-specific first:
      // active per-issue phases, else the run-level activity, else nothing.
      const active = status.issues.filter((i) => ACTIVE_PHASES.has(i.phase));
      let waitingOn: string | undefined;
      if (active.length > 0) {
        waitingOn = active.map((i) => `${i.phase} for #${i.number}`).join(", ");
      } else if (status.activity !== undefined) {
        waitingOn = status.activity;
      }
      status.state = "stopping";
      // `undefined` (not "") so JSON.stringify drops the key when nothing is in
      // flight, matching the schema's optional contract.
      status.stoppingWaitingOn = waitingOn;
      // Deliberately do NOT stopHeartbeat(): the loop is still alive and
      // draining, so the feed must keep re-stamping until finish().
      // A graceful stop landing IS a real transition (not a keep-alive), so it
      // counts as progress — the loop just responded to a signal.
      commit({ progress: true });
    },

    finish(reason: "done" | "stopped" | "restarting" | "unhealthy"): void {
      status.state = reason;
      status.activity = undefined; // run over — no stale activity on the feed
      status.stoppingWaitingOn = undefined; // transient telemetry cleared on exit
      stopHeartbeat(); // the run is over — stop the keep-alive
      recomputeRunning();
      // A terminal transition is genuine progress. Harmless to the watchdog
      // (which only acts on state === "running"), and keeps the invariant
      // "every real transition bumps lastProgressAt" honest.
      commit({ progress: true });
    },

    snapshot(): SandcastleStatus {
      return JSON.parse(JSON.stringify(status)) as SandcastleStatus;
    },

    async flushPush(): Promise<void> {
      await pusher.flush();
    },
  };
}
