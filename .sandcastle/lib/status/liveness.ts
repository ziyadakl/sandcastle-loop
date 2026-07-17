/**
 * The ONE source of truth for "is the loop that wrote this status actually
 * alive?". Before this module the rule was duplicated — inline in
 * `watch/reducer.ts` (the terminal viewer) and restated in prose in a skill —
 * so the two could (and did) drift. Everything that needs to judge liveness now
 * calls `deriveLiveness` so there is a single encoding.
 *
 * THE RULE:
 *  - Terminal run states (`done` / `stopped` / `unhealthy`) are AUTHORITATIVE and
 *    time-independent: the loop told us how it ended, so honor it. A done run
 *    stops writing by design and must NOT be relabelled "stale".
 *  - Any other state (`running` / `restarting` / `stopping`) is FRESHNESS-based:
 *    if `updatedAt` is older than `STALE_AFTER_MS` the loop was almost certainly
 *    hard-killed (`--now` / SIGKILL) and never reached a clean `finish()`, so it
 *    is NOT live even though the file still says `running`. This is the lie 2b
 *    exists to stop.
 *  - `lockHeld` is an OPTIONAL same-host death proxy: the single-instance lock is
 *    released by the OS the instant the owning process dies (and a caller may
 *    equivalently derive it from a `process.kill(pid, 0)` probe against the
 *    written `pid`). Passing `false` lets a same-host viewer call a loop dead
 *    IMMEDIATELY — before the `STALE_AFTER_MS` window elapses — instead of
 *    briefly trusting a fresh-looking `updatedAt` left behind by the kill. It is
 *    DOWNGRADE-ONLY: it can never rescue a stale feed back to live, and it is
 *    never consulted for a terminal state. Cross-host viewers cannot observe a
 *    peer's lock, so they simply omit it (undefined ⇒ pure freshness).
 *
 * PURE: no IO, no clock. `now` (epoch ms) is injected so staleness is
 * deterministic and testable, exactly like `reducer.ts`'s `nowMs`.
 */
import { STALE_AFTER_MS } from "./schema.js";

/** Why a snapshot is / isn't live. Maps 1:1 onto the viewer's terminal banners. */
export type LivenessReason = "running" | "stale" | "stopped" | "unhealthy" | "done";

export interface Liveness {
  live: boolean;
  reason: LivenessReason;
}

export interface DeriveLivenessOpts {
  /** Wall clock as epoch milliseconds (e.g. `Date.now()`). */
  now: number;
  /**
   * Same-host liveness proxy — see the module note. `false` = the loop is
   * provably gone (lock released / pid dead) ⇒ downgrade to non-live even if the
   * last write looks fresh. `true`/omitted = no death proof, fall to freshness.
   */
  lockHeld?: boolean;
}

/** Only the fields liveness depends on — keeps the function trivially callable. */
export type LivenessInput = {
  state: string;
  updatedAt: string;
  /** OPTIONAL written process id (2b). Carried for callers; the stale rule
   *  already makes a dead/absent-pid running non-live, so it needs no branch. */
  pid?: number;
};

export function deriveLiveness(
  status: LivenessInput,
  opts: DeriveLivenessOpts,
): Liveness {
  // Terminal states are authoritative and time-/lock-independent.
  switch (status.state) {
    case "done":
      return { live: false, reason: "done" };
    case "stopped":
      return { live: false, reason: "stopped" };
    case "unhealthy":
      return { live: false, reason: "unhealthy" };
    default:
      break;
  }

  // Non-terminal: freshness with an optional same-host death override.
  const updatedMs = Date.parse(status.updatedAt);
  const stale =
    Number.isFinite(updatedMs) && opts.now - updatedMs > STALE_AFTER_MS;

  // Provable same-host death short-circuits the stale window (downgrade-only).
  if (opts.lockHeld === false) return { live: false, reason: "stale" };
  if (stale) return { live: false, reason: "stale" };
  return { live: true, reason: "running" };
}
