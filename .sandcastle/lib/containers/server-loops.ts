/**
 * Server-wide "does another loop run here?" probe for the boot container sweep
 * (spec #1368). The per-checkout lock cannot see a loop in another checkout.
 * Matches any process whose command line carries the literal path
 * `.sandcastle/main.mts`, minus
 * our own pid and ancestors (the wrapper script and the `tsx` launcher carry
 * the same text). Fails SAFE: an unreadable process table counts as "another
 * loop runs", so nothing is removed.
 *
 * Known limit: the match is on that literal text, so a loop started from
 * inside `.sandcastle/` (as `node main.mts`) goes unseen. The wrapper script
 * never launches it that way; if that changes, match the resolved script path.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function parentPid(pid: number): number | undefined {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm may hold spaces.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number.parseInt(after[1] ?? "", 10);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

function selfAndAncestors(): Set<number> {
  const seen = new Set<number>();
  let pid: number | undefined = process.pid;
  while (pid !== undefined && !seen.has(pid)) {
    seen.add(pid);
    pid = parentPid(pid);
  }
  return seen;
}

export function anotherLoopRunsOnThisServer(): boolean {
  let out: string;
  try {
    out = execFileSync("pgrep", ["-f", "\\.sandcastle/main\\.mts"], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch (err) {
    // pgrep exits 1 with no output when nothing matches; anything else
    // (missing binary, timeout) is an unreadable table.
    return (err as { status?: number }).status !== 1;
  }
  return otherLoopPids(out, selfAndAncestors()).length > 0;
}

/**
 * The pids from `pgrep` output that belong to some OTHER loop: everything
 * except our own pid and our ancestors (the wrapper script and the `tsx`
 * launcher both carry `main.mts` on their command line).
 */
export function otherLoopPids(
  pgrepOutput: string,
  selfAndAncestors: ReadonlySet<number>,
): number[] {
  return pgrepOutput
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0 && !selfAndAncestors.has(p));
}
