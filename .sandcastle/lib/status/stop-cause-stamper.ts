/**
 * Production adapter for spec #1368 decision 6: stamp WHY a dead run's tickets
 * stopped AND publish the stamped snapshot to the dashboard. The loop (at
 * start) and the boot unit (`scripts/stamp-stop-cause.mts`) both call this one
 * function, so the two paths cannot drift apart.
 *
 * Publishing matters as much as stamping: the dashboard reads the pushed copy,
 * and the loop's new status store replaces the local file on its first write.
 */
import path from "node:path";

import { currentBootStartedAt, previousBootKernelLog } from "./boot-facts.js";
import {
  createStatusPusher,
  pushConfigFromEnv,
  type StatusPusherOpts,
} from "./push.js";
import { stampStopCauses } from "./stop-cause.js";

export interface StopCauseStamperOpts {
  readonly repoRoot: string;
  readonly logError: (line: string) => void;
  /** Env bag the push settings are read from. Defaults to `process.env`. */
  readonly getEnv?: (k: string) => string | undefined;
  /** Test seam: the fetch the pusher uses. */
  readonly fetchFn?: StatusPusherOpts["fetchFn"];
  /** Test seams for the two host facts. Default to the real ones. */
  readonly bootStartedAt?: () => Date | undefined;
  readonly previousBootKernelLog?: () => Promise<string>;
}

/** Returns the issue numbers that received a stop cause. Never throws. */
export function makeStopCauseStamper(
  opts: StopCauseStamperOpts,
): () => Promise<readonly number[]> {
  return async () => {
    const getEnv = opts.getEnv ?? ((k: string) => process.env[k]);
    const { stamped } = await stampStopCauses({
      statusPath: path.join(opts.repoRoot, ".sandcastle", "status.json"),
      bootStartedAt: opts.bootStartedAt ?? currentBootStartedAt,
      previousBootKernelLog: opts.previousBootKernelLog ?? previousBootKernelLog,
      pusher: createStatusPusher({
        ...pushConfigFromEnv(getEnv),
        getEnv,
        ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
        logError: opts.logError,
      }),
      onError: (e) => opts.logError(`stop-cause stamp: ${(e as Error).message}`),
    });
    return stamped;
  };
}
