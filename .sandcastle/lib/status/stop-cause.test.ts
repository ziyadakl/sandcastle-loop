/**
 * Spec #1368 decision 6 (loop side): a ticket left in flight by a dead run is
 * stamped with WHY it stopped. The dashboard reads `issues[].stopCause`, one of
 * "out-of-memory" | "server-restarted" | "loop-exited". Tests drive the real
 * status file in a temp dir; only the boot time and the kernel log are faked.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { kernelLogHasOomKill, stampStopCauses } from "./stop-cause.js";

const LAST_UPDATE = "2026-10-13T20:00:00.000Z";
const BEFORE = new Date("2026-10-13T19:00:00.000Z");
const AFTER = new Date("2026-10-13T21:00:00.000Z");
const OOM_LOG =
  "kernel: Out of memory: Killed process 4242 (node) total-vm:9000kB\n";

function statusFile(issues: object[], state = "running"): string {
  return JSON.stringify({
    schemaVersion: 2,
    state,
    updatedAt: LAST_UPDATE,
    activity: "building",
    issues,
  });
}
const issue = (number: number, phase: string, extra: object = {}) => ({
  number,
  title: `t${number}`,
  branch: `agent/issue-${number}`,
  phase,
  ...extra,
});

describe("stampStopCauses", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stop-cause-"));
    path = join(dir, "status.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const run = (boot: Date | undefined, log: string | Error = "") =>
    stampStopCauses({
      statusPath: path,
      bootStartedAt: () => boot,
      previousBootKernelLog: async () => {
        if (log instanceof Error) throw log;
        return log;
      },
    });

  it("server rebooted after the last update: in-flight tickets get server-restarted and the run is marked stopped", async () => {
    writeFileSync(
      path,
      statusFile([issue(1, "implementer"), issue(2, "merged"), issue(3, "planned")]),
    );
    const res = await run(AFTER);
    expect(res.stamped).toEqual([1]);
    const s = read();
    expect(s.state).toBe("stopped");
    expect(s.issues[0].stopCause).toBe("server-restarted");
    expect(s.issues[1].stopCause).toBeUndefined();
    expect(s.issues[2].stopCause).toBeUndefined();
    expect(s.activity).toBeUndefined();
  });

  it("upgrades to out-of-memory when the previous boot's kernel log shows an out-of-memory kill", async () => {
    writeFileSync(path, statusFile([issue(1, "reviewer")]));
    await run(AFTER, OOM_LOG);
    expect(read().issues[0].stopCause).toBe("out-of-memory");
  });

  it("a failing kernel-log read falls back to server-restarted", async () => {
    writeFileSync(path, statusFile([issue(1, "check-writer")]));
    await run(AFTER, new Error("journalctl: no persistent journal"));
    expect(read().issues[0].stopCause).toBe("server-restarted");
  });

  it("no reboot since the last update: loop-exited, and the kernel log is not consulted", async () => {
    writeFileSync(path, statusFile([issue(1, "implementer-retry")]));
    await run(BEFORE, OOM_LOG);
    expect(read().issues[0].stopCause).toBe("loop-exited");
  });

  it("unknown boot time: loop-exited", async () => {
    writeFileSync(path, statusFile([issue(1, "judge")]));
    await run(undefined, OOM_LOG);
    expect(read().issues[0].stopCause).toBe("loop-exited");
  });

  it("never overwrites an existing stopCause, and a second run changes nothing", async () => {
    writeFileSync(
      path,
      statusFile([issue(1, "implementer", { stopCause: "out-of-memory" }), issue(2, "reviewer")]),
    );
    await run(AFTER);
    expect(read().issues[0].stopCause).toBe("out-of-memory");
    expect(read().issues[1].stopCause).toBe("server-restarted");
    const first = readFileSync(path, "utf8");
    const again = await run(AFTER);
    expect(again.stamped).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("leaves a clean status file (nothing in flight) untouched", async () => {
    const body = statusFile([issue(1, "merged")], "done");
    writeFileSync(path, body);
    const res = await run(AFTER);
    expect(res.stamped).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(body);
  });

  it("a missing or torn status file is a quiet no-op", async () => {
    expect((await run(AFTER)).stamped).toEqual([]);
    writeFileSync(path, "{ not json");
    expect((await run(AFTER)).stamped).toEqual([]);
  });
});

describe("kernelLogHasOomKill", () => {
  it("matches the kernel's kill lines, plain and cgroup", () => {
    expect(kernelLogHasOomKill(OOM_LOG)).toBe(true);
    expect(
      kernelLogHasOomKill("Memory cgroup out of memory: Killed process 9 (claude)"),
    ).toBe(true);
    expect(kernelLogHasOomKill("oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null)")).toBe(true);
  });
  it("does not match ordinary log lines", () => {
    expect(kernelLogHasOomKill("eth0: link up\nusb 1-1: new device")).toBe(false);
    expect(kernelLogHasOomKill("")).toBe(false);
  });
});
