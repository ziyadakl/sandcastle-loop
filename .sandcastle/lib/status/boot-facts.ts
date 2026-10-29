/**
 * The two host facts the stop-cause stamp needs, read for real. Shared by the
 * loop's production Deps and `scripts/stamp-stop-cause.mts`.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Current boot start: now minus /proc/uptime (Linux). Undefined elsewhere. */
export function currentBootStartedAt(): Date | undefined {
  try {
    const up = Number.parseFloat(
      readFileSync("/proc/uptime", "utf8").split(" ")[0] ?? "",
    );
    return Number.isFinite(up) ? new Date(Date.now() - up * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** Previous boot's kernel log; throws when journald has none. */
export async function previousBootKernelLog(): Promise<string> {
  const { stdout } = await execFileAsync(
    "journalctl",
    ["-k", "-b", "-1", "--no-pager"],
    { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout;
}
