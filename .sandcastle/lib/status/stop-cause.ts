/**
 * Spec #1368 decision 6 (loop side): record WHY tickets left in flight by a
 * dead run stopped, as `issues[].stopCause` in status.json. Run at loop start
 * (just after the launch-time reaper) and by `scripts/stamp-stop-cause.mts`
 * from a boot unit, so the cause is published even if no loop restarts.
 *
 * Rule: "server-restarted" when the current boot began after the status file's
 * last update; upgraded to "out-of-memory" when the previous boot's kernel log
 * shows an out-of-memory kill; otherwise "loop-exited". Idempotent: an issue
 * that already carries a stopCause is never overwritten, and a file with
 * nothing to stamp is left byte-identical.
 */
import { type StatusPusher } from "./push.js";
import {
  SandcastleStatusSchema,
  type StopCause,
  StatusIssueSchema,
} from "./schema.js";
import { markStatusStopped, readStatusLoose, WORKING_PHASES } from "./store.js";

export interface StampStopCauseDeps {
  readonly statusPath: string;
  /** When the current boot began; undefined when unknown. */
  bootStartedAt(): Date | undefined;
  /** Kernel log of the previous boot. May throw; the failure is tolerated. */
  previousBootKernelLog(): Promise<string>;
  /**
   * Where the stamped snapshot is published (the dashboard reads the pushed
   * copy, not the local file). Sent once, then flushed before returning.
   */
  readonly pusher?: StatusPusher;
  onError?: (err: unknown) => void;
}

const OOM_RE = /out of memory: kill|oom-kill:|invoked oom-killer/i;

export function kernelLogHasOomKill(log: string): boolean {
  return OOM_RE.test(log);
}

export async function stampStopCauses(
  deps: StampStopCauseDeps,
): Promise<{ stamped: number[] }> {
  const obj = readStatusLoose(deps.statusPath);
  if (obj === undefined) return { stamped: [] };
  const rawIssues: unknown[] = Array.isArray(obj.issues) ? obj.issues : [];
  const pending = new Set<number>();
  for (const raw of rawIssues) {
    const issue = StatusIssueSchema.safeParse(raw);
    if (
      issue.success &&
      issue.data.stopCause === undefined &&
      WORKING_PHASES.has(issue.data.phase)
    ) {
      pending.add(issue.data.number);
    }
  }
  if (pending.size === 0) return { stamped: [] };

  const cause = await decideCause(deps, obj.updatedAt);
  const wrote = markStatusStopped({
    path: deps.statusPath,
    mutate: (snapshot) => {
      const issues = snapshot.issues as { number?: unknown; stopCause?: unknown }[];
      for (const i of issues) {
        if (typeof i.number === "number" && pending.has(i.number)) {
          i.stopCause = cause;
        }
      }
    },
    ...(deps.onError ? { onError: deps.onError } : {}),
  });
  if (!wrote) return { stamped: [] };
  await publish(deps);
  return { stamped: [...pending] };
}

/** Push the file just written, so the dashboard sees the cause. Best-effort. */
async function publish(deps: StampStopCauseDeps): Promise<void> {
  if (deps.pusher === undefined) return;
  const written = SandcastleStatusSchema.safeParse(readStatusLoose(deps.statusPath));
  if (!written.success) {
    deps.onError?.(
      new Error("stamped status file does not match the status schema; not published"),
    );
    return;
  }
  deps.pusher.push(written.data);
  await deps.pusher.flush();
}

async function decideCause(
  deps: StampStopCauseDeps,
  updatedAt: unknown,
): Promise<StopCause> {
  const boot = deps.bootStartedAt();
  const last = typeof updatedAt === "string" ? Date.parse(updatedAt) : Number.NaN;
  if (boot === undefined || Number.isNaN(last) || boot.getTime() <= last) {
    return "loop-exited";
  }
  try {
    return kernelLogHasOomKill(await deps.previousBootKernelLog())
      ? "out-of-memory"
      : "server-restarted";
  } catch (err) {
    deps.onError?.(err);
    return "server-restarted";
  }
}
