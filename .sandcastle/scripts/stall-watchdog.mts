#!/usr/bin/env tsx
/**
 * stall-watchdog.mts — the run-level watchdog that makes the sandcastle loop
 * self-heal from a HANG no per-step timeout caught.
 *
 * WHY THIS EXISTS. On 2026-08-31 the loop froze for 6.5 hours and nothing
 * noticed, because the only periodic timestamp — `status.json.updatedAt` — is a
 * keep-alive re-stamped every `HEARTBEAT_MS` (2 min) REGARDLESS of progress
 * (`lib/status/store.ts` `startHeartbeat`). A wedged-but-alive process therefore
 * looks perfectly healthy to every existing check (`lib/status/liveness.ts`
 * `deriveLiveness` treats a fresh `updatedAt` as live). There was no
 * "work advancing" signal and no run-level watchdog. Stream 3 adds both:
 *   - a real progress clock, `status.json.lastProgressAt`, bumped ONLY on genuine
 *     transitions and NEVER by the keep-alive (see `store.ts` `commit`), and
 *   - this sidecar, which reads THAT clock and, when it goes stale while the run
 *     still says `running`, kills the wedged sandbox + loop and asks the wrapper
 *     to restart (`sandcastle-wrapper.sh`).
 *
 * FAIL-SAFE BY CONSTRUCTION. A missing/half-written `status.json`, an absent
 * `lastProgressAt` (an older run that predates this field), or an unparseable
 * timestamp must NEVER trigger a kill — every such case is treated as
 * not-stalled. A watchdog that kills a healthy loop is far worse than one that
 * misses a hang, so every ambiguous read fails toward "leave it alone".
 *
 * The pure decision — {@link deriveStall} — mirrors `deriveLiveness`'s shape (a
 * plain input record + injected `now`) so it is deterministic and unit-tested.
 * All IO, process control, and docker calls live in the imperative `main()` at
 * the bottom, behind an `isMain()` guard so importing this module for tests does
 * not start the loop.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { resolve } from "node:path";

/**
 * Default stall ceiling: 90 minutes. This MUST sit safely ABOVE the longest
 * single-step ceiling so a legitimately slow agent phase is never killed. The
 * loop's `hardCeilingSec` defaults to 3600s = 60 min (`main.mts`), and between
 * any two consecutive progress signals at most one such phase runs, so 90 min
 * leaves a 30-minute margin over the worst legitimate quiet window. Override
 * with `SANDCASTLE_STALL_LIMIT_MS` (e.g. to tighten it on a fast profile, or
 * loosen it if a project raises `hardCeilingSec`).
 */
export const DEFAULT_STALL_LIMIT_MS = 90 * 60 * 1000;

/** How often the watchdog re-reads `status.json`. Override with `SANDCASTLE_STALL_POLL_MS`. */
export const DEFAULT_POLL_MS = 60 * 1000;

/** The marker the watchdog writes to ask `sandcastle-wrapper.sh` to restart. */
export const STALL_RESTART_MARKER = ".sandcastle/.stall-restart";

/** Only the fields the stall decision depends on — keeps the function trivial. */
export interface StallInput {
  /**
   * DELIBERATELY `string`, not `RunState`: the watchdog may be older or newer
   * than the writer, so it must tolerate a state it has never heard of and
   * simply not fire (only the exact literal `"running"` arms the kill). Same
   * widen-don't-narrow rule as `deriveLiveness`'s `state`.
   */
  state: string;
  /** ISO-8601 progress clock. Absent on a pre-watchdog run ⇒ fail safe. */
  lastProgressAt?: string;
}

export type StallReason =
  | "stalled"
  | "not-running"
  | "fresh-progress"
  | "missing-progress"
  | "unparseable-progress";

export interface StallDecision {
  stalled: boolean;
  reason: StallReason;
}

export interface DeriveStallOpts {
  /** Wall clock as epoch milliseconds (e.g. `Date.now()`). */
  now: number;
  /** The stall ceiling in ms. */
  stallLimitMs: number;
}

/**
 * PURE. Decide whether a snapshot represents a stalled run. Only a run that is
 * BOTH `state === "running"` AND whose `lastProgressAt` is older than
 * `stallLimitMs` is stalled; every other case — terminal/other state, missing
 * field, unparseable timestamp, or fresh progress — is deliberately NOT a
 * stall. No IO, no clock: `now` is injected exactly like `deriveLiveness`.
 */
export function deriveStall(
  input: StallInput,
  opts: DeriveStallOpts,
): StallDecision {
  // Only an actively-running loop can be "stalled". A done/stopped/stopping/
  // restarting/unknown state is never killed.
  if (input.state !== "running") {
    return { stalled: false, reason: "not-running" };
  }
  // Older run with no progress clock: cannot judge, so leave it alone.
  if (input.lastProgressAt === undefined) {
    return { stalled: false, reason: "missing-progress" };
  }
  const progressMs = Date.parse(input.lastProgressAt);
  // A torn/garbage timestamp parses to NaN — never treat that as a stall.
  if (!Number.isFinite(progressMs)) {
    return { stalled: false, reason: "unparseable-progress" };
  }
  if (opts.now - progressMs > opts.stallLimitMs) {
    return { stalled: true, reason: "stalled" };
  }
  return { stalled: false, reason: "fresh-progress" };
}

// ---------------------------------------------------------------------------
// Everything below is IMPERATIVE (IO + process control). Its side effects —
// killing the loop, sweeping containers, writing the marker, probing pid
// liveness, reading the clock — are funnelled through an injectable `deps`
// object ({@link WatchdogStepDeps}) whose real implementations are the module
// defaults. Production wires the defaults; the tests inject fakes that record
// call ORDER and simulate a FAILED kill without touching a real process. The
// pure decision helpers ({@link deriveStall}, {@link deriveRunFreshness}) and
// the per-poll orchestration ({@link watchdogStep}, {@link handleStall}) are
// therefore all unit-tested.
// ---------------------------------------------------------------------------

export interface RawStatus {
  state?: unknown;
  lastProgressAt?: unknown;
  pid?: unknown;
  /**
   * The run's own wall-clock start (`run.startedAt`), REQUIRED in the on-disk
   * schema (`lib/status/schema.ts`). The watchdog reads it to reject a STALE
   * file left behind by a previous run during the startup window — see
   * {@link deriveRunFreshness}. Typed as `unknown` here (like the other fields)
   * because this sidecar tolerates any shape a differently-versioned writer
   * might emit and validates each field itself.
   */
  run?: {
    startedAt?: unknown;
    iterations?: { current?: unknown; total?: unknown };
    /**
     * The rolling-pool per-ticket tally (#902) — see `TicketsSchema` in
     * `lib/status/schema.ts`. Preferred over `iterations` below when
     * present: nothing in `main.mts` calls `statusStore.startIteration`
     * any more (it was removed as dead code — #1191 finding B), so
     * `run.iterations.current` sits frozen at 0 for the pool's whole life
     * and `remainingIterations` computed off it would hand a restarted
     * loop its FULL original budget plus one, however many tickets it had
     * already burned.
     */
    tickets?: {
      done?: unknown;
      working?: unknown;
      cap?: unknown;
    };
  };
}

/** Read + parse `status.json`, returning `null` on ANY failure (fail safe). */
function readStatus(statusPath: string): RawStatus | null {
  let text: string;
  try {
    text = readFileSync(statusPath, "utf8");
  } catch {
    return null; // absent — nothing to watch yet
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as RawStatus;
  } catch {
    return null; // half-written / torn read — fail safe
  }
}

/**
 * Remaining tickets for the restart marker.
 *
 * #1191 finding B: `run.iterations.current` is bumped ONLY by
 * `statusStore.startIteration`, which `main.mts` never calls any more (the
 * rolling pool tracks per-ticket phases instead — see `TicketsSchema`). So it
 * sits frozen at 0 for the pool's whole life, and the OLD math below
 * (`total - current + 1`) would hand a restarted loop `total - 0 + 1` — its
 * full original ticket budget, plus one, no matter how many tickets it had
 * already burned before it stalled.
 *
 * Prefer `run.tickets` (present on any status file written by a build that
 * has it): `cap - done - working` is exactly what is left to attempt —
 * `waiting` (planned but not yet picked up) is deliberately NOT subtracted,
 * since those tickets have not been attempted yet either. Fall back to the
 * old `iterations` math only for a status file from a pre-#902 build that
 * has no `tickets` field at all.
 */
export function remainingIterations(status: RawStatus): number {
  const tickets = status.run?.tickets;
  const cap = typeof tickets?.cap === "number" ? tickets.cap : undefined;
  const done = typeof tickets?.done === "number" ? tickets.done : undefined;
  const working =
    typeof tickets?.working === "number" ? tickets.working : undefined;
  if (cap !== undefined && done !== undefined && working !== undefined) {
    const remaining = cap - done - working;
    return remaining >= 1 ? remaining : 1;
  }

  const iters = status.run?.iterations;
  const total = typeof iters?.total === "number" ? iters.total : 1;
  const current = typeof iters?.current === "number" ? iters.current : 1;
  const remaining = total - current + 1;
  return remaining >= 1 ? remaining : 1;
}

/**
 * Best-effort sandbox cleanup: force-remove every `sandcastle-*` container so a
 * wedged agent inside one dies with it. This MIRRORS the intent of
 * `KILL_SANDBOX_PROCESSES_COMMAND` (`lib/sandbox-provider.ts`) but from a
 * standalone sidecar that holds no container handle, so it filters by the
 * SDK's container-name prefix (`"sandcastle-" + randomUUID()`) instead. NEVER
 * throws: no docker, no containers, or a docker error are all swallowed.
 */
function killSandboxContainers(log: (m: string) => void): void {
  try {
    const ps = spawnSync(
      "docker",
      ["ps", "--filter", "name=sandcastle-", "--format", "{{.ID}}"],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (ps.status !== 0 || typeof ps.stdout !== "string") {
      log(
        `[stall-watchdog] docker ps returned no container list (status=${String(ps.status)}); nothing to sweep`,
      );
      return;
    }
    const ids = ps.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (ids.length === 0) {
      log("[stall-watchdog] no sandcastle-* containers to sweep");
      return;
    }
    log(`[stall-watchdog] force-removing ${ids.length} sandbox container(s): ${ids.join(", ")}`);
    spawnSync("docker", ["rm", "-f", ...ids], {
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch (err) {
    log(`[stall-watchdog] sandbox sweep failed (non-fatal): ${(err as Error).message}`);
  }
}

/**
 * Outcome of an attempt to SIGKILL the loop. The caller MUST distinguish the
 * three because they drive the dedup latch differently (see {@link handleStall}):
 *   - `"signalled"`   — the kill was delivered; the loop is dying ⇒ latch.
 *   - `"already-gone"` — ESRCH: the pid no longer exists ⇒ from our POV the loop
 *                        is already dead, which is the outcome we wanted ⇒ latch.
 *   - `"failed"`      — a non-ESRCH error (e.g. EPERM): the loop is STILL wedged
 *                        and we could not kill it ⇒ do NOT latch, so the next
 *                        poll re-fires instead of giving up forever.
 */
export type KillOutcome = "signalled" | "already-gone" | "failed";

/**
 * SIGKILL the loop PID, distinguishing "already gone" (success from our POV)
 * from a genuine "could not kill" so the caller can decide whether to latch.
 */
export function killLoop(pid: number, log: (m: string) => void): KillOutcome {
  try {
    process.kill(pid, "SIGKILL");
    log(`[stall-watchdog] sent SIGKILL to loop pid ${pid}`);
    return "signalled";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      // Already dead — exactly the state we were trying to reach.
      log(`[stall-watchdog] loop pid ${pid} was already gone (ESRCH)`);
      return "already-gone";
    }
    // EPERM or anything else: the process is still there and we could NOT kill
    // it. Non-fatal, but the loop stays wedged, so this must NOT latch.
    log(`[stall-watchdog] could not signal loop pid ${pid} (${(err as Error).message}); will retry next poll`);
    return "failed";
  }
}

/**
 * Is `pid` a live process right now? Probes with the null signal
 * (`process.kill(pid, 0)`), which delivers nothing but throws ESRCH when the
 * pid is gone. EPERM means the process EXISTS but belongs to another user —
 * still "alive" for our purposes. Any other error is treated as "gone" (fail
 * toward NOT killing a pid we cannot confirm). Used to skip a SIGKILL against a
 * pid that is already dead — the startup-window guard's second line of defence.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Default marker writer: record the remaining-iterations count where
 * `sandcastle-wrapper.sh` reads it after a non-75 exit. Best-effort — a write
 * failure is logged but never thrown (the loop still gets killed; the wrapper
 * just cannot auto-continue).
 */
function writeMarkerFile(
  markerPath: string,
  contents: string,
  log: (m: string) => void,
): void {
  try {
    writeFileSync(markerPath, contents, "utf8");
    log(`[stall-watchdog] wrote restart marker ${markerPath} (remaining=${contents})`);
  } catch (err) {
    log(
      `[stall-watchdog] FAILED to write restart marker (${(err as Error).message}); ` +
        `the loop will still be killed but the wrapper cannot auto-continue`,
    );
  }
}

/**
 * The side effects the watchdog performs, injectable so a test can record call
 * ORDER and simulate a failed kill without touching a real process/container.
 * The module defaults ({@link defaultWatchdogDeps}) are the real implementations,
 * so production behaviour is identical to before this seam existed.
 */
export interface WatchdogStepDeps {
  /** Wall clock as epoch ms. Real default: `Date.now`. */
  now: () => number;
  /** SIGKILL the loop pid, reporting a three-way outcome. */
  killLoop: (pid: number, log: (m: string) => void) => KillOutcome;
  /** Force-remove every `sandcastle-*` container. */
  killSandboxContainers: (log: (m: string) => void) => void;
  /** Write the restart marker (best-effort). */
  writeMarker: (
    markerPath: string,
    contents: string,
    log: (m: string) => void,
  ) => void;
  /** True iff `pid` is a live process right now. */
  pidAlive: (pid: number) => boolean;
}

/** The real side effects. Production uses exactly these. */
export const defaultWatchdogDeps: WatchdogStepDeps = {
  now: () => Date.now(),
  killLoop,
  killSandboxContainers,
  writeMarker: writeMarkerFile,
  pidAlive,
};

/** Freshness of the run a status snapshot describes, relative to when THIS
 *  watchdog launched. See {@link deriveRunFreshness}. */
export type RunFreshness = "current" | "stale-residue" | "indeterminate";

/**
 * PURE. Startup-window guard against acting on a PREVIOUS run's leftover
 * status.json. A freshly-spawned watchdog polls before the new run has
 * overwritten `.sandcastle/status.json`; that stale file can still say
 * `state:"running"` with a >90-min-old `lastProgressAt` and a reused pid, which
 * would make the watchdog kill an innocent process and sweep a healthy run's
 * containers. Defence: every real run stamps `run.startedAt` at start, so a run
 * that started BEFORE this watchdog launched is stale residue, never ours.
 *
 * `"current"`       — `startedAt` >= launch ⇒ this is (or is newer than) our run;
 *                     act on it normally.
 * `"stale-residue"` — `startedAt` < launch ⇒ a prior run's file; IGNORE it.
 * `"indeterminate"` — `startedAt` missing or unparseable ⇒ cannot tell, so fail
 *                     safe and IGNORE it (never kill on an unreadable identity).
 *
 * Only `"current"` is actionable; the caller treats the other two as not-stalled.
 */
export function deriveRunFreshness(
  status: RawStatus,
  launchedAtMs: number,
): RunFreshness {
  const startedAt =
    typeof status.run?.startedAt === "string" ? status.run.startedAt : undefined;
  if (startedAt === undefined) return "indeterminate";
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return "indeterminate";
  // Depends on the launch-ordering invariant documented at the `launchedAtMs`
  // capture in `runWatchdog`: the watchdog records its launch time BEFORE
  // `main.mts` stamps `run.startedAt`, so the live run always lands `>=` launch.
  // Invert that ordering and the current run reads as `"stale-residue"` and its
  // hangs go silently unkilled.
  return startedMs >= launchedAtMs ? "current" : "stale-residue";
}

/** Result of handling a stall: whether the dedup latch should advance. */
export interface StallHandleResult {
  /**
   * True ⇒ record this `lastProgressAt` as handled so future polls short-circuit.
   * Set when the loop is dead or dying (killed / already gone / no pid), OR there
   * is nothing more we can do. False ⇒ the kill genuinely FAILED and the loop is
   * still wedged, so the NEXT poll must re-fire — do NOT latch.
   */
  latch: boolean;
}

/**
 * Handle a detected stall: log loudly, write the restart marker, sweep the
 * sandbox, then SIGKILL the loop.
 *
 * ORDER MATTERS (bug 1): the restart marker is written FIRST — before any
 * container sweep or signal. The sweep is exactly what can unblock the loop's
 * wedged `await` into an error; if the loop then races to a non-75 exit before
 * the marker exists on disk, the wrapper sees the exit with no marker and STOPS
 * instead of restarting. Writing the marker before touching anything guarantees
 * it is present in time.
 *
 * LATCH (bug 2/3): returns whether the caller should record this progress
 * timestamp as handled. It latches when the loop is dead/dying or unactionable,
 * but NOT when a real kill failed — so a single failed SIGKILL can never freeze
 * the self-heal forever.
 */
export function handleStall(
  status: RawStatus,
  repoRoot: string,
  log: (m: string) => void,
  deps: WatchdogStepDeps,
): StallHandleResult {
  const staleFor = status.lastProgressAt;
  log(
    "=".repeat(72) +
      `\n[stall-watchdog] STALL DETECTED: run says state=running but has made no ` +
      `progress since ${String(staleFor)}. Self-healing: killing the wedged ` +
      `sandbox + loop and asking the wrapper to restart.\n` +
      "=".repeat(72),
  );

  // (a) trigger a RESTART, not just a death: leave the marker the wrapper reads
  // after a non-75 exit. Written FIRST — before the sweep or the kill — so it is
  // already on disk if the sweep unblocks the loop into a fast non-75 exit.
  const remaining = remainingIterations(status);
  const markerPath = path.join(repoRoot, STALL_RESTART_MARKER);
  deps.writeMarker(markerPath, String(remaining), log);

  // (b) best-effort sweep of the wedged sandbox containers (may unblock the
  // loop's await). Non-fatal; the marker already exists before this runs.
  deps.killSandboxContainers(log);

  // (c) kill the loop PID from status.json.
  const pid = typeof status.pid === "number" ? status.pid : undefined;
  if (pid === undefined) {
    log("[stall-watchdog] status.json carries no pid; cannot kill the loop from here " +
      "(the marker is written, so a manual/next launch will still continue)");
    return { latch: true }; // nothing more we can do — avoid re-sweeping every poll
  }
  // Liveness check (bug 3): do not SIGKILL a pid that is already gone (it may
  // have been reused by an unrelated process).
  if (!deps.pidAlive(pid)) {
    log(`[stall-watchdog] loop pid ${pid} is no longer alive; skipping SIGKILL`);
    return { latch: true }; // already dead ⇒ the outcome we wanted
  }
  const outcome = deps.killLoop(pid, log);
  // Latch on success or already-gone; a genuine failure must re-fire next poll.
  return { latch: outcome !== "failed" };
}

/** Config for a single {@link watchdogStep}, fixed for the life of the run. */
export interface WatchdogStepConfig {
  repoRoot: string;
  stallLimitMs: number;
  /**
   * Epoch-ms wall time when THIS watchdog launched. A status whose
   * `run.startedAt` predates this is stale residue from a previous run — see
   * {@link deriveRunFreshness}.
   */
  launchedAtMs: number;
}

/** Carried-forward state between polls: the dedup latch. */
export interface WatchdogStepState {
  /**
   * The `lastProgressAt` we last ACTED on, or `undefined` if we have not acted.
   * A poll whose stalled timestamp equals this is skipped (already handled). It
   * only advances when {@link handleStall} latches — a FAILED kill leaves it
   * unchanged so the next poll re-fires.
   */
  actedProgressAt: string | undefined;
}

/**
 * One poll of the watchdog, as a pure-ish state transition: given the status
 * just read and the current latch state, decide whether to act and return the
 * next latch state. All side effects go through `deps`, so a test drives real
 * decision logic while recording call order and simulating a failed kill.
 *
 * The guards run in fail-safe order:
 *   1. `status === null`         → absent/torn read, skip.
 *   2. NOT `"current"` freshness → stale residue / unreadable identity (bug 3),
 *                                  skip WITHOUT killing.
 *   3. NOT stalled               → healthy or slow-but-fine, skip.
 *   4. already-acted timestamp   → dedup, skip.
 * Only past all four does it call {@link handleStall}, then latch iff the handler
 * says the loop is dead/dying (bug 2).
 */
export function watchdogStep(
  status: RawStatus | null,
  state: WatchdogStepState,
  config: WatchdogStepConfig,
  deps: WatchdogStepDeps,
  log: (m: string) => void,
): WatchdogStepState {
  if (status === null) return state; // absent/torn ⇒ fail safe

  // Startup-window guard (bug 3): ignore a previous run's leftover status.json.
  if (deriveRunFreshness(status, config.launchedAtMs) !== "current") return state;

  const decision = deriveStall(
    {
      state: typeof status.state === "string" ? status.state : "",
      lastProgressAt:
        typeof status.lastProgressAt === "string"
          ? status.lastProgressAt
          : undefined,
    },
    { now: deps.now(), stallLimitMs: config.stallLimitMs },
  );
  if (!decision.stalled) return state;

  const currentProgressAt =
    typeof status.lastProgressAt === "string" ? status.lastProgressAt : undefined;
  if (currentProgressAt === state.actedProgressAt) return state; // already handled

  const { latch } = handleStall(status, config.repoRoot, log, deps);
  // Advance the latch ONLY when the loop is dead/dying; a failed kill leaves the
  // latch untouched so the next poll re-fires (bug 2).
  return latch ? { actedProgressAt: currentProgressAt } : state;
}

/** Is this file being run directly, rather than imported by a test? */
function isMain(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

async function runWatchdog(deps: WatchdogStepDeps = defaultWatchdogDeps): Promise<void> {
  const repoRoot = process.cwd();
  const statusPath = path.join(repoRoot, ".sandcastle", "status.json");
  const stallLimitMs = (() => {
    const raw = process.env.SANDCASTLE_STALL_LIMIT_MS;
    const n = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_LIMIT_MS;
  })();
  const pollMs = (() => {
    const raw = process.env.SANDCASTLE_STALL_POLL_MS;
    const n = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_POLL_MS;
  })();
  const log = (m: string): void => {
    process.stderr.write(`${m}\n`);
  };

  // Record our own launch wall-time BEFORE the first poll: any status whose run
  // started before this is a prior run's residue and must be ignored (bug 3).
  //
  // LOAD-BEARING ORDERING INVARIANT (nothing enforces it — keep it true):
  // this `launchedAtMs` MUST be captured BEFORE `main.mts` reaches
  // `createStatusStore` and stamps the run's fresh `run.startedAt`. It holds
  // today because `sandcastle-wrapper.sh` spawns this tiny sidecar FIRST, then
  // exec's the 374 KB `main.mts`, so on every launch and restart
  // `run.startedAt >= launchedAtMs` and {@link deriveRunFreshness} reads the
  // live run as `"current"`. If a future change delayed this capture, or moved
  // `createStatusStore` earlier, the comparison would INVERT: the watchdog would
  // misjudge the real current run as `"stale-residue"`, silently skip it, and
  // NEVER kill a genuine hang — the exact failure this watchdog exists to catch.
  const launchedAtMs = deps.now();
  const config: WatchdogStepConfig = { repoRoot, stallLimitMs, launchedAtMs };

  log(
    `[stall-watchdog] armed: watching ${statusPath} every ${Math.round(pollMs / 1000)}s; ` +
      `stall limit ${Math.round(stallLimitMs / 60000)}m`,
  );

  // Dedup: never fire twice for the SAME stale progress timestamp. After a
  // restart the loop writes a fresh lastProgressAt, so a genuine new hang has a
  // different timestamp and re-arms; but in the brief window between the kill
  // and the relaunch the old status.json still shows the timestamp we just
  // acted on, and this guard stops a second (pointless) kill during it.
  let state: WatchdogStepState = { actedProgressAt: undefined };

  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    const status = readStatus(statusPath);
    state = watchdogStep(status, state, config, deps, log);
  }
}

if (isMain()) {
  void runWatchdog();
}
