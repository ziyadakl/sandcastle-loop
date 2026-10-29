/**
 * #1370: mark a dead run `unhealthy` and publish it. The self-restart path
 * writes `restarting`, then the wrapper installs packages before relaunching;
 * if that fails nothing rewrites the file and the viewer shows Live forever.
 * `scripts/mark-run-unhealthy.mts` calls this from the wrapper's failure path.
 * Best-effort: a push failure is logged, the local write stays.
 */
import path from "node:path";

import { createStatusPusher, pushConfigFromEnv, type StatusPusher } from "./push.js";
import { SandcastleStatusSchema } from "./schema.js";
import { markStatusUnhealthy, readStatusLoose } from "./store.js";

export interface MarkRunUnhealthyOpts {
  readonly statusPath: string;
  readonly reason: string;
  readonly pusher?: StatusPusher;
  readonly onError?: (err: unknown) => void;
}

/** "marked" when the file was rewritten; "unchanged" for a final/absent/torn file. */
export async function markRunUnhealthy(
  opts: MarkRunUnhealthyOpts,
): Promise<"marked" | "unchanged"> {
  const wrote = markStatusUnhealthy({
    path: opts.statusPath,
    reason: opts.reason,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  if (!wrote) return "unchanged";
  if (opts.pusher !== undefined) {
    try {
      const written = SandcastleStatusSchema.safeParse(readStatusLoose(opts.statusPath));
      if (written.success) {
        opts.pusher.push(written.data);
        await opts.pusher.flush();
      } else {
        opts.onError?.(new Error("marked status file does not match the schema; not published"));
      }
    } catch (err) {
      opts.onError?.(err);
    }
  }
  return "marked";
}

/** The production wiring: push settings come from the env bag, like the loop. */
export function makeRunUnhealthyMarker(opts: {
  readonly repoRoot: string;
  readonly reason: string;
  readonly logError: (line: string) => void;
  readonly getEnv?: (k: string) => string | undefined;
}): () => Promise<"marked" | "unchanged"> {
  return () => {
    const getEnv = opts.getEnv ?? ((k: string) => process.env[k]);
    return markRunUnhealthy({
      statusPath: path.join(opts.repoRoot, ".sandcastle", "status.json"),
      reason: opts.reason,
      pusher: createStatusPusher({
        ...pushConfigFromEnv(getEnv),
        getEnv,
        logError: opts.logError,
      }),
      onError: (e) => opts.logError(`mark unhealthy: ${(e as Error).message}`),
    });
  };
}
