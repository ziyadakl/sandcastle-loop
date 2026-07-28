/**
 * Type declarations for the browser-ESM crash guard (`own-process-dead.js`).
 *
 * The runtime module is plain `.js` (no build step, runs in the browser). This
 * companion `.d.ts` gives the TypeScript consumers — `lib/status/liveness.ts`,
 * the terminal reducer, and the vitest suite — a real typed contract for the
 * same predicate documented in the JS JSDoc. Keep the two in sync.
 */

/** Injected same-host hard-kill probe (mirrors the pure `deriveLiveness` seam). */
export interface LivenessProbe {
  probeAlive?: (pid: number) => boolean;
  selfHostId?: string;
}

/** Only the identity fields the guard inspects. */
export interface OwnProcessSnapshot {
  hostId?: string;
  pid?: number;
}

/**
 * True iff `snapshot` is our OWN host's snapshot (`hostId === selfHostId`), carries
 * a pid, and that pid is proven dead by the injected probe. A peer's pid is never
 * probed (the `&&` chain short-circuits on the host-id comparison).
 */
export function isOwnProcessDead(
  probe: LivenessProbe,
  snapshot: OwnProcessSnapshot,
): boolean;
