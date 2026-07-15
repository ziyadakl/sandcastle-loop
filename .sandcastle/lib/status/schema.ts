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

/**
 * Incremented on any breaking change to the snapshot shape.
 *
 * Bumped 1 → 2 alongside adding `unhealthy` to `RunStateSchema` (audit issue
 * #4). `state` is a STRICT `z.enum` (unlike the permissive `activity`
 * string), so a snapshot containing `state: "unhealthy"` fails
 * `SandcastleStatusSchema.safeParse` on an old viewer's compiled schema that
 * doesn't know the new member. `watch/reducer.ts` checks the RAW
 * `schemaVersion` field before attempting `safeParse`; without this bump that
 * raw check would see a matching version, proceed to the strict parse, fail
 * it, and fall into the generic "torn read" branch — surfacing a misleading
 * "stale" banner that HIDES the very failure state #4 exists to report.
 * Bumping the version here routes a version-skewed old viewer to the
 * graceful "outdated" banner instead. Both `store.ts` (writer) and
 * `reducer.ts` (reader) import this same constant, so a single bump updates
 * both sides — keep doing that on any future breaking change.
 *
 * Bumped 2 → 3 alongside the cross-host unified viewer: `hostId` and `runId`
 * became always-written REQUIRED fields on `SandcastleStatusSchema`. A required
 * field is a breaking shape change for the same reason `unhealthy` was — an old
 * viewer's compiled schema demands nothing new, but a NEWER file that OMITS a
 * field the old schema requires is impossible (they're always written), while
 * an old file lacking `hostId`/`runId` fails the new schema's required check.
 * The raw-version guard in `reducer.ts` catches the skew first and shows
 * "outdated" instead of a misleading "stale". (`peers` is optional and would be
 * non-breaking on its own; the bump is driven by the required id fields.)
 */
export const STATUS_SCHEMA_VERSION = 3;

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

/**
 * Run lifecycle. `restarting` is the exit-75 hot-reload window. `unhealthy` is
 * a terminal FAILURE state: the run finished but left merged+reviewed work
 * stranded on `integration-candidate` because the final fast-forward promotion
 * refused — the loop must NOT report this as `done`/success (audit issue #4).
 */
export const RunStateSchema = z.enum([
  "running",
  "done",
  "stopped",
  "restarting",
  "unhealthy",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const StatusHistoryEntrySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  branch: z.string(),
  phase: IssuePhaseSchema,
  completedAt: z.string(), // ISO-8601
  /**
   * Cross-host attribution: which host produced this terminal outcome. OPTIONAL
   * so pre-cross-host files and single-host writers that don't stamp it stay
   * valid; a unified viewer folding multiple hosts uses it to badge each row.
   */
  hostId: z.string().optional(),
});
export type StatusHistoryEntry = z.infer<typeof StatusHistoryEntrySchema>;

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

/**
 * Run-level activity the loop writes around CROSS-ISSUE steps that belong to no
 * single issue — planning the batch, merging it, gating the merged result,
 * cleaning up. The viewer shows it as the "running" panel's subtitle when no
 * per-issue phase is active, so the panel never falsely reads "idle" while the
 * loop is busy between issues. `RunActivity` is the write-side contract (the
 * compiler constrains what the loop emits); the SCHEMA field below is a
 * permissive `z.string()` on purpose — see its note.
 */
export type RunActivity = "planning" | "merging" | "reviewing" | "cleanup";

/**
 * A single PEER host's live status, as folded into the unified cross-host
 * viewer. This is the shape one host publishes about ITSELF and the shape a
 * viewing host stores about each OTHER host it has learned of. It intentionally
 * REUSES `RunStateSchema`, `StatusTotalsSchema`, and `StatusIssueSchema` (no
 * duplicated shapes), and mirrors the `iterations` object of `StatusRunSchema`
 * — so a peer card renders with the same primitives as the local run. It is a
 * flattened projection of `SandcastleStatus` (host identity + the run's live
 * counters), NOT the whole snapshot: no nested `run`/`history`/`peers`, which
 * keeps peer-folding non-recursive.
 */
export const PeerStatusSchema = z.object({
  hostId: z.string(),
  state: RunStateSchema,
  /** Permissive run-level activity label — see `SandcastleStatusSchema.activity`. */
  activity: z.string().optional(),
  iterations: z.object({
    current: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  totals: StatusTotalsSchema,
  issues: z.array(StatusIssueSchema),
  /** ISO-8601 of the peer's last write, as seen when this projection was taken. */
  updatedAt: z.string(),
});
export type PeerStatus = z.infer<typeof PeerStatusSchema>;

export const SandcastleStatusSchema = z.object({
  schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
  state: RunStateSchema,
  run: StatusRunSchema,
  totals: StatusTotalsSchema,
  issues: z.array(StatusIssueSchema),
  /**
   * Stable identity of the host that produced this snapshot. ALWAYS written,
   * even single-host (where it's the lone participant). Cross-host viewers key
   * peer folding on it. Required ⇒ drove the v2→v3 bump.
   */
  hostId: z.string(),
  /**
   * Shared-run identity: all hosts collaborating on the same logical run write
   * the same `runId`, so a viewer knows which peers belong together. ALWAYS
   * written. Required ⇒ drove the v2→v3 bump.
   */
  runId: z.string(),
  /**
   * Other hosts' folded status, absent/empty in single-host mode. Optional so a
   * lone writer omits the key entirely and a single-host viewer never renders a
   * peers rail.
   */
  peers: z.array(PeerStatusSchema).optional(),
  /** ISO-8601 of the last write. Its age is the loop's liveness signal. */
  updatedAt: z.string(),
  /**
   * Optional run-level activity label (see `RunActivity`). PERMISSIVE on read:
   * a `z.string()`, NOT a `z.enum`. An enum would reject any value it doesn't
   * know, and `safeParse` failure is treated as a torn read → frozen "stale"
   * viewer. So the day a newer loop emits a 5th label, an OLDER viewer that
   * hasn't synced this schema would freeze. A bare string keeps future
   * additions non-breaking; the viewer falls back to rendering the raw word.
   * Additive + optional ⇒ no STATUS_SCHEMA_VERSION bump (zod strips unknowns;
   * absent ⇒ undefined).
   */
  activity: z.string().optional(),
  /** Append-only log of terminal issue outcomes; NEVER truncated. Unlike
   *  `issues` (overwritten each plan), this preserves every completed issue's
   *  identity so a viewer can list what's behind each total. Optional+defaulted
   *  for backward compat — old v1 files lacking it parse to []. */
  history: z.array(StatusHistoryEntrySchema).default([]),
});

export type SandcastleStatus = z.infer<typeof SandcastleStatusSchema>;
