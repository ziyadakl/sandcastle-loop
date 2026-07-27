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
 *  - CRASHED (Fix 1): before falling through to freshness, a snapshot that is
 *    OURS — its `hostId` equals the injected `selfHostId` — and carries a `pid`
 *    can be PROVED dead by probing that OS pid (`probeAlive(pid) === false` ⇒
 *    ESRCH ⇒ gone). A hard kill (SIGKILL / OOM / laptop sleep) leaves `state`
 *    frozen on `running` with a still-recent-looking `updatedAt`, so freshness
 *    alone can't tell it from a live loop until STALE_AFTER_MS elapses. The pid
 *    probe is authoritative and immediate, so it gets its own `crashed` reason.
 *    CRITICAL: this fires SAME-HOST ONLY. `process.kill(pid, 0)` is meaningless
 *    for another machine's pid, so a PEER snapshot never probes and stays purely
 *    freshness-gated — it can go `stale` but is NEVER labelled `crashed`.
 *  - Any other state (`running` / `restarting` / `stopping`, or a state this
 *    build has never heard of) is FRESHNESS-based: if `updatedAt` is older than
 *    `STALE_AFTER_MS` the loop was almost certainly hard-killed (`--now` /
 *    SIGKILL) and never reached a clean `finish()`, so it is NOT live even though
 *    the file still says `running`. This is the lie 2b exists to stop.
 *
 * PURE: no IO, no clock. `now` (epoch ms) AND the `probeAlive` liveness probe are
 * injected so the verdict is deterministic and testable — exactly like
 * `reducer.ts`'s `nowMs`. The real probe (a thin `process.kill(pid,0)` wrapper)
 * lives only at the impure call sites; absent it, behaviour is unchanged.
 */
import { STALE_AFTER_MS } from "./schema.js";

/** Why a snapshot is / isn't live. Maps 1:1 onto the viewer's terminal banners. */
export type LivenessReason =
  | "running"
  | "stale"
  | "crashed"
  | "stopped"
  | "unhealthy"
  | "done";

export interface Liveness {
  live: boolean;
  reason: LivenessReason;
}

export interface DeriveLivenessOpts {
  /** Wall clock as epoch milliseconds (e.g. `Date.now()`). */
  now: number;
  /**
   * Injected OS-liveness probe: `true` if a process with `pid` is alive on THIS
   * host, `false` (ESRCH) if it's gone. The real impl is a thin
   * `try { process.kill(pid, 0); return true } catch { return false }` wrapper,
   * wired only at impure call sites. Kept as an injected seam so `deriveLiveness`
   * stays pure/deterministic, exactly like `now`. Absent ⇒ no crash detection.
   */
  probeAlive?: (pid: number) => boolean;
  /**
   * This host's own id (see `resolveHostId`). The crash probe fires ONLY when the
   * snapshot's `hostId` equals this — a peer's pid can't be signalled from here.
   * Absent ⇒ no crash detection (back-compat).
   */
  selfHostId?: string;
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
  /**
   * OS pid the writer stamped at startup (`store.ts`). Consulted ONLY same-host
   * via `probeAlive` to detect a hard kill; optional, absent on pre-2b/peer files.
   */
  pid?: number;
  /**
   * Id of the host that produced this snapshot (matches `hostId` in the status
   * schema). Compared to `selfHostId` so the crash probe never runs cross-host.
   */
  hostId?: string;
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

  // Non-terminal (or unknown). CRASH CHECK FIRST — but ONLY for our OWN snapshot:
  // a same-host pid we can actually signal, proven gone by the injected probe, is
  // a hard kill regardless of write-age (crashed OUTRANKS stale). A peer's pid is
  // unsignalable from here, so we never probe it and let it fall to freshness.
  if (
    opts.probeAlive !== undefined &&
    opts.selfHostId !== undefined &&
    status.hostId === opts.selfHostId &&
    status.pid !== undefined &&
    !opts.probeAlive(status.pid)
  ) {
    return { live: false, reason: "crashed" };
  }

  // Otherwise: pure freshness.
  const updatedMs = Date.parse(status.updatedAt);
  const stale =
    Number.isFinite(updatedMs) && opts.now - updatedMs > STALE_AFTER_MS;

  if (stale) return { live: false, reason: "stale" };
  return { live: true, reason: "running" };
}
