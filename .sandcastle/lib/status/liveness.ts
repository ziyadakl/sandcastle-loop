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
 *  - Any other state (`running` / `restarting` / `stopping`, or a state this
 *    build has never heard of) is FRESHNESS-based: if `updatedAt` is older than
 *    `STALE_AFTER_MS` the loop was almost certainly hard-killed (`--now` /
 *    SIGKILL) and never reached a clean `finish()`, so it is NOT live even though
 *    the file still says `running`. This is the lie 2b exists to stop.
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
}

/** Only the fields liveness depends on — keeps the function trivially callable. */
export type LivenessInput = {
  /**
   * DELIBERATELY `string`, not the `RunState` union. A viewer may be older than
   * the writer that produced the snapshot, so it must tolerate a state it has
   * never heard of and degrade to freshness (see the `default:` branch below) —
   * never blank out or hard-fail. Narrowing this to the union is a REGRESSION:
   * a strict gate that rejected an unrecognised/newer value is exactly what once
   * put the viewer behind an "out of date" blank screen. Widen, don't narrow.
   */
  state: string;
  updatedAt: string;
};

export function deriveLiveness(
  status: LivenessInput,
  opts: DeriveLivenessOpts,
): Liveness {
  // Terminal states are authoritative and time-independent.
  switch (status.state) {
    case "done":
      return { live: false, reason: "done" };
    case "stopped":
      return { live: false, reason: "stopped" };
    case "unhealthy":
      return { live: false, reason: "unhealthy" };
    default:
      // Every OTHER state — the known non-terminal ones (`running`/`restarting`/
      // `stopping`) AND any state from a future writer this build cannot name —
      // falls through to the freshness rule below. Treating an unknown state as
      // freshness-gated is the DEFENSIVE choice and is intentional: a newer
      // writer's snapshot still renders as a live-or-stale run instead of
      // blanking the viewer. Do not turn this into a strict/exhaustive gate.
      break;
  }

  // Non-terminal (or unknown): pure freshness.
  const updatedMs = Date.parse(status.updatedAt);
  const stale =
    Number.isFinite(updatedMs) && opts.now - updatedMs > STALE_AFTER_MS;

  if (stale) return { live: false, reason: "stale" };
  return { live: true, reason: "running" };
}
