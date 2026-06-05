/**
 * The structured status feed the orchestrator writes to
 * `<repoRoot>/.sandcastle/status.json` on every state transition, and the
 * `sandcastle-watch` viewer reads to render its live dashboard.
 *
 * SINGLE SOURCE OF TRUTH — this is the one copy of the status-feed schema. The
 * loop's status store (`.sandcastle/lib/status/store.ts`) and the
 * `.sandcastle/watch/` viewer (`sandcastle-watch.tsx` + `reducer.ts`) both
 * import it directly, so there is no twin to keep in sync. The zod schema is
 * the single source of truth — `SandcastleStatus` is its inferred type, so a
 * schema edit can never drift from the type consumers use. Bump
 * `STATUS_SCHEMA_VERSION` (and the viewer's tolerance) on any breaking shape
 * change.
 */

import { z } from "zod";

/** Incremented on any breaking change to the snapshot shape. */
export const STATUS_SCHEMA_VERSION = 1;

/**
 * Liveness timing — shared by BOTH sides so they can never drift apart:
 *  - the loop (`store.ts`) re-stamps `updatedAt` every `HEARTBEAT_MS` while
 *    running, even mid-phase, so a long-but-healthy phase keeps the feed fresh;
 *  - the viewer (`reducer.ts`) treats a snapshot whose `updatedAt` is older than
 *    `STALE_AFTER_MS` as "stale — loop may have stopped".
 * STALE_AFTER_MS MUST exceed HEARTBEAT_MS with margin: at 1.5× one heartbeat can
 * land late (a GC pause, a slow disk) without false-firing the stale banner,
 * while a genuinely dead loop is still flagged within roughly one extra beat.
 */
export const HEARTBEAT_MS = 120_000; // 2 minutes
export const STALE_AFTER_MS = 180_000; // 3 minutes (1.5× heartbeat)

/**
 * Per-issue lifecycle phase. `merge` = "shipped, queued for the merger" (under
 * staging the ship site does NOT mark the issue done); `merged` is the terminal
 * run-level outcome set from the iteration tally. `recovery` is the optional
 * `--recovery on` pass.
 */
export const IssuePhaseSchema = z.enum([
  "planned",
  "implementer",
  "reviewer",
  "implementer-retry",
  "recovery",
  "merge",
  "merged",
  "needs-human",
  "deferred",
]);
export type IssuePhase = z.infer<typeof IssuePhaseSchema>;

/** Run lifecycle. `restarting` is the exit-75 hot-reload window. */
export const RunStateSchema = z.enum([
  "running",
  "done",
  "stopped",
  "restarting",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const StatusIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  branch: z.string(),
  phase: IssuePhaseSchema,
  /** Short context, e.g. "HAS_BLOCKERS · escalate→opus-4.7". */
  detail: z.string().optional(),
  /** ISO-8601; set when the issue first leaves `planned`. Drives elapsed. */
  startedAt: z.string().optional(),
  /** True when this issue needs a human's eyes (quarantine / blockers). */
  attention: z.boolean().optional(),
});
export type StatusIssue = z.infer<typeof StatusIssueSchema>;

export const StatusTotalsSchema = z.object({
  merged: z.number().int().nonnegative(),
  needsHuman: z.number().int().nonnegative(),
  /** Issues released back to `ready-for-agent` (transient defer). */
  requeued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
});
export type StatusTotals = z.infer<typeof StatusTotalsSchema>;

export const StatusRunSchema = z.object({
  branch: z.string(),
  repo: z.string(),
  startedAt: z.string(),
  iterations: z.object({
    current: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  maxConcurrent: z.number().int().positive(),
});

export const SandcastleStatusSchema = z.object({
  schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
  state: RunStateSchema,
  run: StatusRunSchema,
  totals: StatusTotalsSchema,
  issues: z.array(StatusIssueSchema),
  /** ISO-8601 of the last write. Its age is the loop's liveness signal. */
  updatedAt: z.string(),
});

export type SandcastleStatus = z.infer<typeof SandcastleStatusSchema>;
