/**
 * Tests for the ONE shared encoding of the "is this snapshot my own host's
 * hard-killed process?" guard (`.sandcastle/web/own-process-dead.js`).
 *
 * This five-clause predicate used to be hand-written TWICE — once in the pure
 * `deriveLiveness` (terminal viewer core) and once, restated in browser JS, in
 * `buildViewModel` (web viewer). The two could drift (an EPERM/state nuance added
 * to one and not the other → the terminal and web viewers disagreeing on whether a
 * run crashed). This module is now the single authority both call.
 *
 * The load-bearing safety property is the SAME one `liveness.test.ts` locks for
 * the peer case: for a snapshot that is NOT ours the probe must NEVER be consulted
 * (`process.kill(peerPid, 0)` is meaningless for another machine's pid). It is
 * re-asserted here at the helper seam so it can never be lost in either caller.
 */
import { describe, it, expect } from "vitest";
import { isOwnProcessDead } from "../.sandcastle/web/own-process-dead.js";

const SELF = "mac-abc";
const PEER = "vps-xyz";

/** A probe that reports the pid dead, recording that it was consulted. */
function deadProbe(): { fn: (pid: number) => boolean; calls: number[] } {
  const calls: number[] = [];
  return {
    fn: (pid: number) => {
      calls.push(pid);
      return false; // ESRCH ⇒ dead
    },
    calls,
  };
}

describe("isOwnProcessDead", () => {
  it("same-host snapshot with a proven-dead pid → true (a hard kill)", () => {
    const probe = deadProbe();
    expect(
      isOwnProcessDead({ probeAlive: probe.fn, selfHostId: SELF }, { hostId: SELF, pid: 4242 }),
    ).toBe(true);
    expect(probe.calls).toEqual([4242]);
  });

  it("same-host snapshot with a LIVE pid → false (a running process is not crashed)", () => {
    expect(
      isOwnProcessDead({ probeAlive: () => true, selfHostId: SELF }, { hostId: SELF, pid: 4242 }),
    ).toBe(false);
  });

  // THE load-bearing safety assertion: a PEER's pid is unsignalable from here, so
  // the probe must NOT even be consulted for it.
  it("PEER snapshot with a dead pid → false AND probe NEVER consulted", () => {
    const probe = deadProbe();
    expect(
      isOwnProcessDead({ probeAlive: probe.fn, selfHostId: SELF }, { hostId: PEER, pid: 99 }),
    ).toBe(false);
    expect(probe.calls).toEqual([]);
  });

  it("no probe injected (browser default) → false, never consulted", () => {
    expect(isOwnProcessDead({}, { hostId: SELF, pid: 4242 })).toBe(false);
  });

  it("no selfHostId → false (can't know if the snapshot is ours)", () => {
    const probe = deadProbe();
    expect(isOwnProcessDead({ probeAlive: probe.fn }, { hostId: SELF, pid: 4242 })).toBe(false);
    expect(probe.calls).toEqual([]);
  });

  it("absent pid → false, nothing to probe", () => {
    const probe = deadProbe();
    expect(isOwnProcessDead({ probeAlive: probe.fn, selfHostId: SELF }, { hostId: SELF })).toBe(
      false,
    );
    expect(probe.calls).toEqual([]);
  });
});
