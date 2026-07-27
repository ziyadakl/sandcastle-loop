// @ts-nocheck
/**
 * The ONE encoding of the "same-host hard-kill" guard.
 *
 * A snapshot that is OURS — its `hostId` equals the injected `selfHostId` — and
 * carries an OS `pid` can be PROVED dead by signalling that pid (`probeAlive(pid)
 * === false` ⇒ ESRCH ⇒ gone). A hard kill (SIGKILL / OOM / laptop sleep) leaves
 * `state` frozen on `running` with a still-recent `updatedAt`, so freshness alone
 * can't tell it from a live loop; this probe is authoritative and immediate.
 *
 * CRITICAL — SAME-HOST ONLY: `process.kill(pid, 0)` is meaningless for another
 * machine's pid, so a PEER snapshot (`hostId !== selfHostId`) must NEVER be
 * probed. The `&&` chain short-circuits on the host-id comparison BEFORE calling
 * `probeAlive`, so the probe is not even consulted for a peer — the load-bearing
 * safety property both viewers depend on.
 *
 * This lives here (browser ESM, no build step) so the web viewer's `view-model.js`
 * can import it as a same-dir module; the TS core (`lib/status/liveness.ts`) and
 * the terminal reducer reach it through the companion `.d.ts`. Before this module
 * the five clauses were hand-written twice and could drift; now there is a single
 * authority so the terminal and web viewers can never disagree on "crashed".
 *
 * PURE: no IO of its own. The only impure act is the INJECTED `probeAlive`; absent
 * it (the browser default — a page served over HTTP can't signal a pid) this is
 * always `false`, so crash detection simply doesn't fire.
 *
 * @param {{ probeAlive?: (pid: number) => boolean, selfHostId?: string }} probe
 *   Injected liveness probe + this host's own id. Absent members ⇒ no detection.
 * @param {{ hostId?: string, pid?: number }} snapshot
 *   The status snapshot's identity fields (whose host, which pid).
 * @returns {boolean} true iff this is our OWN snapshot and its pid is proven dead.
 */
export function isOwnProcessDead(probe, snapshot) {
  return (
    typeof probe.probeAlive === "function" &&
    probe.selfHostId !== undefined &&
    snapshot.hostId === probe.selfHostId &&
    typeof snapshot.pid === "number" &&
    !probe.probeAlive(snapshot.pid)
  );
}
