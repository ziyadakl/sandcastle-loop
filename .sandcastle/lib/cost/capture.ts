/**
 * Best-effort per-role cost capture (Phase-1 telemetry).
 *
 * Called once per role run from the loop: it resolves each of the run's
 * iterations to its session JSONL, extracts per-model token usage, and folds it
 * into the run-scoped {@link CostLedger} under `role`. Extracted from main.mts
 * so its ONE load-bearing contract — "never throw into a run" — is unit-testable
 * directly (inject a resolver/extractor that throws and assert the run survives)
 * instead of only through a full `runMain`.
 *
 * The `resolveSessionFilePath` / `extractUsageFromSession` collaborators default
 * to the real implementations and are injectable purely for tests.
 */

import type { CostLedger, CostRole } from "./ledger.js";
import {
  extractUsageFromSession as realExtractUsageFromSession,
  type ModelUsage,
} from "./session-usage.js";
import { resolveSessionFilePath as realResolveSessionFilePath } from "../skill-discipline.js";

/** The per-iteration session handle a role run hands back (structural subset). */
interface IterationRef {
  readonly sessionFilePath?: string;
  readonly sessionId?: string;
}

export interface CaptureDeps {
  readonly resolveSessionFilePath: (
    it: IterationRef,
    dirOverride?: string,
  ) => Promise<string | undefined>;
  readonly extractUsageFromSession: (path: string | undefined) => ModelUsage[];
}

const defaultDeps: CaptureDeps = {
  resolveSessionFilePath: realResolveSessionFilePath,
  extractUsageFromSession: realExtractUsageFromSession,
};

/**
 * Fold `handle`'s per-iteration token usage into `ledger` under `role`. A no-op
 * when `ledger` is undefined (test seams) or `handle` has no iterations. Any
 * error while resolving/parsing a session is swallowed (logged best-effort) —
 * telemetry must never fail a run, not even via the error log itself.
 */
export async function captureRoleCost(
  ledger: CostLedger | undefined,
  role: CostRole,
  handle: { readonly iterations?: readonly IterationRef[] } | undefined,
  logError: (line: string) => void,
  deps: CaptureDeps = defaultDeps,
): Promise<void> {
  if (ledger === undefined) return;
  try {
    for (const it of handle?.iterations ?? []) {
      const path = await deps.resolveSessionFilePath(it);
      if (path === undefined) continue;
      const entries = deps.extractUsageFromSession(path);
      if (entries.length > 0) ledger.add(role, entries);
    }
  } catch (err) {
    try {
      logError(`cost capture (${role}) skipped: ${(err as Error).message}`);
    } catch {
      // never fail a run over telemetry, not even the error log
    }
  }
}
