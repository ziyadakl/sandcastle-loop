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

import { CHECK_WRITER_OUTCOME_KEYS } from "../checkwriter/outcome-key.js";
import { STOP_REASON_LABELS } from "../state/stop-reasons.js";

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
 * Cap on how many entries {@link IssueTelemetryRowSchema.changedFilePaths} may
 * carry. The whole status snapshot is rewritten on every status update
 * (`store.ts`), so an unbounded path list would make one huge refactor ticket
 * cost every later write for the rest of the run. `changedFiles` (the count)
 * stays authoritative and UNCAPPED — see that field's doc comment.
 */
export const MAX_CHANGED_FILE_PATHS = 200;

/**
 * Cap on how many entries a screen check's `attemptVerdicts` trail may carry
 * (see {@link ScreenCheckVerdictSchema}). `runHarnessScreenCheck`
 * (`lib/harness/run-harness-check.ts`) executes the check AT MOST TWICE, so
 * any real trail is length 1 or 2 — the headroom here exists only so a future
 * re-run rule does not need a coordinated change, and the cap itself only so
 * an unusable input cannot bloat a durable line. An OVERSIZED trail is
 * DROPPED WHOLE at the write boundary, never sliced: a truncated trail is
 * indistinguishable from a shorter run, which is the one thing this field
 * exists to make visible.
 */
export const MAX_SCREEN_CHECK_ATTEMPT_VERDICTS = 8;

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
 *
 * `needs-rerun` is TRANSIENT, not terminal, and NOT a human-triage state: a
 * MECHANICAL strand (e.g. the promotion-race lease-loss) parked the issue and
 * released its label back to `ready-for-agent`, so the next run/peer re-claims
 * it automatically. It deliberately does NOT count toward `totals.needsHuman`
 * and does NOT set `issue.attention` — it renders as an informational row, not
 * a "needs you" warning. Contrast `needs-human`, which is reserved for REAL
 * review quarantines (`recordOutcome({status:"quarantined"|"error"})`) that
 * bump the pill and require a person. The viewers keep `needs-rerun` OUT of
 * their `TERMINAL_PHASES` set (it auto-requeues, so it belongs in "active", not
 * "recent").
 *
 * NO VERSION BUMP: adding an enum member is additive — same reasoning as
 * `stopping` on `RunStateSchema` above. A viewer new enough to know the member
 * renders it. An OLD viewer (compiled before `needs-rerun` existed) does NOT
 * hit the raw-`schemaVersion` "outdated" banner here — that fires only on a
 * version mismatch, and we deliberately did not bump — so its `safeParse`
 * simply fails on the unknown enum value and it degrades to the "stale" banner,
 * keeping its last-good frame rather than blank-screening. That degradation is
 * acceptable because `/sandcastle-update` ships writer + viewer atomically, so
 * the skew window is momentary. (The "outdated" route is reserved for changes
 * that DO bump the version.)
 */
export const IssuePhaseSchema = z.enum([
  "planned",
  "check-writer",
  // The judge reading the just-written check against the ticket, before the
  // builder starts (issue #1118). A distinct phase because it is where a
  // ticket can now sit for a whole agent round, and a board showing
  // "check-writer" there would say the wrong agent is running.
  "judge",
  "implementer",
  "reviewer",
  "implementer-retry",
  "recovery",
  "merge",
  "merged",
  "needs-human",
  "needs-rerun",
  "deferred",
]);
export type IssuePhase = z.infer<typeof IssuePhaseSchema>;

/**
 * Run lifecycle. `restarting` is the exit-75 hot-reload window. `unhealthy` is
 * a terminal FAILURE state: the run finished but left merged+reviewed work
 * stranded on `integration-candidate` because the final fast-forward promotion
 * refused — the loop must NOT report this as `done`/success (audit issue #4).
 * `stopping` is TRANSIENT telemetry (not terminal): a graceful stop
 * (SIGTERM/SIGINT) sets it the instant the signal lands so tooling can show
 * "stopping — waiting on <phase> for #N" while the loop drains its in-flight
 * work at the iteration boundary. `finish()` overwrites it with the real
 * terminal reason (`stopped`/`done`/…). Like `stopping` is non-terminal,
 * `deriveLiveness`/the viewer treat it as still-live-and-freshness-gated.
 *
 * NOTE ON NO VERSION BUMP: adding `stopping` here is deliberately NOT paired
 * with a `STATUS_SCHEMA_VERSION` bump. The project has moved OFF the strict
 * version gate for the lite viewer (which owns its own staleness and never
 * blank-screens on an unknown value); bumping would risk blanking older viewers
 * for a purely additive, non-terminal telemetry label. A new writer that emits
 * `stopping` will simply be rendered as live by any viewer new enough to know
 * the member, and the state is transient anyway.
 */
export const RunStateSchema = z.enum([
  "running",
  "done",
  "stopped",
  "restarting",
  "unhealthy",
  "stopping",
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

export const StopCauseSchema = z.enum([
  "out-of-memory",
  "server-restarted",
  "loop-exited",
]);
export type StopCause = z.infer<typeof StopCauseSchema>;

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
  /**
   * Why a ticket left in flight stopped (spec #1368): the server ran out of
   * memory, the server restarted, or the loop process itself exited. Stamped by
   * `lib/status/stop-cause.ts` at loop start or by a boot unit; the dashboard
   * reads exactly this name and these three values. OPTIONAL and additive.
   */
  stopCause: StopCauseSchema.optional(),
});
export type StatusIssue = z.infer<typeof StatusIssueSchema>;

export const StatusTotalsSchema = z.object({
  merged: z.number().int().nonnegative(),
  needsHuman: z.number().int().nonnegative(),
  /** Issues released back to `ready-for-agent` (transient defer). */
  requeued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  /**
   * Phase-1 cost telemetry: the run's total ESTIMATED cost in USD, summed
   * across every role from list-rate pricing (see `lib/cost/`). OPTIONAL and
   * additive on purpose — a required field or a schema-version bump would break
   * backward compat with existing status.json files and older viewers (which
   * guard on `schemaVersion`). Absent whenever cost capture produced nothing
   * (all roles unpriced, or telemetry was skipped). NOT integer/`.int()`: a
   * dollar figure is fractional. This is a relative estimate, not a billed
   * number — see `lib/cost/pricing.ts`.
   */
  totalCostUsd: z.number().nonnegative().optional(),
  /**
   * Phase-2 per-role breakdown: for each loop role a real budget run dispatched,
   * its ESTIMATED cost + total tokens (from `lib/cost/ledger.ts`) and cumulative
   * wall-clock time + dispatch count (from `lib/cost/timing.ts`), keyed by role
   * name. Same backward-compat contract as `totalCostUsd`: OPTIONAL and additive
   * on purpose — a required field or a schemaVersion bump would break old
   * status.json files and viewers that guard on `schemaVersion`. Absent whenever
   * nothing was captured (flag-off / no dispatch). Per-role keys are open
   * (`z.record`) so a future role never breaks an older viewer's parse; every
   * inner field is itself optional so a role with only timing (no priced model)
   * or only cost still validates. `costUsd` is `null` when the role saw only
   * unpriced models (matching the ledger's null-not-zero convention) and NOT
   * `.int()` (dollars are fractional); `tokens`/`wallMs`/`runs` are
   * non-negative integers. Relative estimates, not billed figures.
   */
  perRole: z
    .record(
      z.string(),
      z.object({
        costUsd: z.number().nullable().optional(),
        tokens: z.number().int().nonnegative().optional(),
        wallMs: z.number().int().nonnegative().optional(),
        runs: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
  /**
   * Phase-3 per-model breakdown: `perRole` above sums every model a role ever
   * ran into one blended number, which hides a role that escalated mid-run
   * (its default model failed and a retry ran on a stronger, pricier one). This
   * splits that same cost ledger data by which model actually ran, one row per
   * (role, model) pair actually dispatched. A LIST, not a record keyed by role,
   * because a role can appear more than once (one row per model it used).
   * Same backward-compat contract as `perRole`: OPTIONAL and additive, absent
   * whenever nothing was captured. `model` is an open string (new models ship
   * constantly); `costUsd` is `null` for an unpriced model, matching the
   * ledger's null-not-zero convention. Relative estimates, not billed figures.
   */
  perModel: z
    .array(
      z.object({
        role: z.string(),
        model: z.string(),
        costUsd: z.number().nullable().optional(),
        tokens: z.number().int().nonnegative().optional(),
        calls: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
});
export type StatusTotals = z.infer<typeof StatusTotalsSchema>;

/**
 * The run's iteration counter. Shared by `StatusRunSchema` (the local run) and
 * `PeerStatusSchema` (a folded peer) so both render the same `current/total`
 * primitive — one definition, no drift.
 */
export const IterationsSchema = z.object({
  current: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/**
 * Per-ticket tally for the rolling refill pool (#902) — replaces the
 * round-shaped `iterations` counter above, which cannot describe a pool where
 * tickets finish and get replaced in any order. `waiting` counts issues still
 * at phase `planned` (dealt but not yet picked up), `working` counts the
 * store's existing `ACTIVE_PHASES` set (implementer/reviewer/
 * implementer-retry/recovery/merge), and `done` is everything else (merged,
 * needs-human, needs-rerun, deferred, and the pre-implementer check-writer/
 * judge phases). `cap` is the run's ticket ceiling, read from the store's
 * existing `iterationsTotal` meta for now. `iterations` above is KEPT for now
 * (removing it is deferred; listed in PR #1191's deferred section) so this is
 * purely additive — no `STATUS_SCHEMA_VERSION` bump; see
 * `StatusRunSchema.tickets` and `PeerStatusSchema.tickets` for why both stay
 * optional.
 */
export const TicketsSchema = z.object({
  done: z.number().int().nonnegative(),
  working: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  cap: z.number().int().nonnegative(),
});
export type Tickets = z.infer<typeof TicketsSchema>;

export const StatusRunSchema = z.object({
  branch: z.string(),
  repo: z.string(),
  startedAt: z.string(),
  iterations: IterationsSchema,
  maxConcurrent: z.number().int().positive(),
  /**
   * Per-ticket tally for the rolling refill pool (#902) — see `TicketsSchema`
   * for the derivation. Lives on `run` (D2, Opus review), the same object
   * `iterations` lives on and the field it replaces, rather than at the
   * snapshot's top level — that keeps every run-level counter in one place and
   * lets `PeerStatusSchema` below project it exactly the way it already
   * projects `iterations`. OPTIONAL and additive ⇒ no `STATUS_SCHEMA_VERSION`
   * bump.
   */
  tickets: TicketsSchema.optional(),
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
 * REUSES `RunStateSchema`, `StatusTotalsSchema`, `StatusIssueSchema`, and
 * `IterationsSchema` (no duplicated shapes) — so a peer card renders with the
 * same primitives as the local run. It is a
 * flattened projection of `SandcastleStatus` (host identity + the run's live
 * counters), NOT the whole snapshot: no nested `run`/`history`/`peers`, which
 * keeps peer-folding non-recursive.
 */
export const PeerStatusSchema = z.object({
  hostId: z.string(),
  state: RunStateSchema,
  /** Permissive run-level activity label — see `SandcastleStatusSchema.activity`. */
  activity: z.string().optional(),
  iterations: IterationsSchema,
  /**
   * That peer's own per-ticket tally (#902), projected from `run.tickets`
   * exactly like `iterations` above — so a fused multi-host viewer can show
   * every host's own done/working/waiting/cap, not just the local host's.
   * Optional: an older peer's snapshot (pre-#902) simply omits it.
   */
  tickets: TicketsSchema.optional(),
  totals: StatusTotalsSchema,
  issues: z.array(StatusIssueSchema),
  /** ISO-8601 of the peer's last write, as seen when this projection was taken. */
  updatedAt: z.string(),
});
export type PeerStatus = z.infer<typeof PeerStatusSchema>;

// ---------------------------------------------------------------------------
// TELEMETRY (per-issue + per-run) — the data contract that makes runs
// comparable and cost attributable to individual tickets.
//
// PLACEMENT, and why it is two NEW TOP-LEVEL keys rather than an extension of
// something that already exists (this is settled — do not relocate):
//   - `issues[]` is wholesale-REPLACED every iteration by `setPlan`
//     (`store.ts:368`), so anything parked there is wiped each plan.
//   - `history[]` is CAPPED at 50 on disk under cross-host fusion
//     (`MAX_MERGED_HISTORY`, `merge.ts:54`; applied at `:108`) and 30 on the
//     wire (`push.ts:57`), and a
//     deferred-then-reclaimed issue produces two rows with overlapping cost.
//   - `totals` does NOT fuse across hosts — `sumTotalsAcrossHosts`
//     (`merge.ts:33-45`) hardcodes four integer adds, so a fifth key would
//     render own-host-only beside four fused values.
//   - Top-level keys survive `foldPeers` (`merge.ts:105-115`) and
//     `trimForPush` (`push.ts:101-105`) untouched, which is exactly the
//     behavior wanted.
//
// NO `STATUS_SCHEMA_VERSION` BUMP. Both keys are additive AND optional, which
// is the documented house rule (see the precedents at the `stopping` and
// `totalCostUsd` notes above). A bump would be actively harmful here:
// `lib/state/status-sync.ts:169` safeParses PEER snapshots against
// `z.literal(STATUS_SCHEMA_VERSION)`, so during any window where one machine is
// updated and another is not, the un-updated host SILENTLY rejects the updated
// host's snapshot (`return null`) and cross-host fusion dies mid-run with
// nothing surfaced. It would also trip the raw-version gate in
// `watch/reducer.ts:145-154`.
//
// WHY THIS SCHEMA IS THE GATE: `z.object` STRIPS unknown keys. A telemetry
// field a producer writes but this file does not declare still reaches the push
// wire and is then silently DELETED by every safeParse consumer — no error
// anywhere, just missing data. Nothing can be reported that is not declared
// here first.
// ---------------------------------------------------------------------------

/**
 * The four-way token split, kept UNFLATTENED (unlike `totals.perRole.tokens`,
 * which sums to one number for display). Telemetry needs the split intact:
 * cache-hit ratio, cache-write waste, and output-vs-input balance are the whole
 * point and are unrecoverable from a total.
 *
 * FIELD-NAME MAP from the ledger's `Usage` (`lib/cost/pricing.ts`), which every
 * producer reads from — the short names here are the wire names:
 *   `inputTokens`               → `input`
 *   `outputTokens`              → `output`
 *   `cacheCreationInputTokens`  → `cacheWrite`
 *   `cacheReadInputTokens`      → `cacheRead`
 *
 * All four are REQUIRED inside the object (a producer that has a token ledger
 * always has all four, and 0 is a true zero here — unlike a dollar figure,
 * where absence and zero differ). Non-negative integers.
 */
export const TokenSplitSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
});
export type TokenSplit = z.infer<typeof TokenSplitSchema>;

/**
 * Per-role slice of ONE issue's telemetry. Every field is optional, matching
 * `RoleBreakdown`'s contract in `lib/cost/ledger.ts:92-101` — a partial source
 * (cost-only, timing-only) must stay valid rather than force a producer to
 * fabricate zeros. `costUsd` is `null` when the role saw only UNPRICED models
 * (the ledger's null-not-zero convention); `null` never means free.
 */
export const IssueRoleTelemetrySchema = z.object({
  costUsd: z.number().nullable().optional(),
  wallMs: z.number().int().nonnegative().optional(),
  tokens: TokenSplitSchema.optional(),
  runs: z.number().int().nonnegative().optional(),
});
export type IssueRoleTelemetry = z.infer<typeof IssueRoleTelemetrySchema>;

/**
 * Which prompt legs actually ran before the issue shipped. Mirrors
 * `PromptLegPath` (`main.mts:5343`) exactly — keep the two in lock-step.
 */
export const ShipPathSchema = z.enum([
  "first-pass-only",
  "critique-retry",
  "implementer-retry",
  /** Shipped by the fixer, the one pass any failure hands a ticket to
   *  (spec #1334, SG). Additive: older rows never carry it. */
  "fixer",
]);
export type ShipPath = z.infer<typeof ShipPathSchema>;

/**
 * Terminal outcome of the issue, mirroring `StatusOutcomeInput["status"]`
 * (`store.ts:67-70`) — the vocabulary `recordOutcome` already speaks, reused
 * rather than reinvented.
 */
export const IssueOutcomeSchema = z.enum([
  "ok",
  "quarantined",
  "error",
  "deferred",
]);
export type IssueOutcome = z.infer<typeof IssueOutcomeSchema>;

/**
 * The harness's own verdict on one browser run of a screen check — mirrors
 * `HarnessVerdict` in `.sandcastle/lib/harness/verdict.ts` exactly; keep the
 * two in lock-step, the same way {@link ShipPathSchema} mirrors
 * `PromptLegPath`. `"match"` is the only verdict that lets a ticket ship; the
 * rest are Piece F/E's DISTINCT stop reasons and are never folded into one
 * shared "failed" bucket. `"environment-fault"` (2026-08-04 review finding
 * #6) joined the set alongside the original three.
 *
 * DECLARED ONCE, HERE. Every other place that needs this list reads it off
 * this schema (`.options` for a runtime guard, the schema itself for a zod
 * field) rather than re-typing the six names — `rework-store.ts`'s mirrored
 * record schema and its `safeScreenCheck` guard, and `issue-bag.ts`'s
 * `noteScreenCheck` guard, all of which used to carry a hand-maintained copy.
 * That is the same argument `issue-bag.ts` already makes for `SHIP_PATHS` /
 * `OUTCOMES`: a fourth hand-kept copy of a closed enum is a drift waiting for
 * the next verdict to be added.
 */
export const ScreenCheckVerdictSchema = z.enum([
  "match",
  "graded-mismatch",
  "never-settled",
  "claim-mismatch",
  "environment-fault",
  "inconclusive",
]);
export type ScreenCheckVerdict = z.infer<typeof ScreenCheckVerdictSchema>;

/**
 * The check-writer's allowed outcomes in their wire spelling (issue #911,
 * Piece D). The names are NOT written here: they are DERIVED from
 * `CHECK_WRITER_MARKERS`, the check-writer's own canonical list, by
 * `lib/checkwriter/outcome-key.ts` (issue #956). This field's four members
 * used to be typed out inline, one of three hand-copies of that vocabulary,
 * and a value the copy had not heard of fails `safeParse` — which loses the
 * WHOLE snapshot, not just this field. Same argument {@link
 * ScreenCheckVerdictSchema} makes above; the fix here just runs one link
 * further back, to the markers rather than to this schema.
 */
export const CheckWriterOutcomeSchema = z.enum(CHECK_WRITER_OUTCOME_KEYS);
export type CheckWriterOutcome = z.infer<typeof CheckWriterOutcomeSchema>;

/**
 * ONE issue's telemetry row — the unit that makes cost attributable to a
 * ticket.
 *
 * REQUIRED vs OPTIONAL: the whole `issueTelemetry` ARRAY is optional, so an old
 * status.json (which has no rows at all) parses regardless. That means a row
 * that DOES exist can demand its identifying spine — `issue`, `costUsd`,
 * `wallMs`, `tokens` — without any backward-compat cost, and doing so keeps the
 * type from degrading into an all-optional bag nobody can consume without
 * defensive checks. Everything beyond that spine is genuinely
 * situational and therefore optional.
 *
 * `costUsd` is REQUIRED but NULLABLE: a producer must state the cost, and
 * `null` is the explicit "every model this issue touched was unpriced" answer.
 * `null` is NOT zero and must never be rendered or summed as $0.
 */
export const IssueTelemetryRowSchema = z.object({
  /** GitHub issue number. The row's identity. */
  issue: z.number().int().positive(),
  /**
   * DECLARED, NOT PRODUCED TODAY. No writer populates `title` or `type` —
   * neither `IssueLedger.rows()` nor `IssueTelemetryBag.toRow()` nor
   * `buildIssueRows` sets them, so they are absent from every real snapshot
   * (the committed fixture populates them to document the intended shape).
   * They stay declared because adding a producer later is additive and needs
   * no `STATUS_SCHEMA_VERSION` bump, whereas removing them is a shape change
   * while the version is deliberately pinned. A consumer must not build a
   * column on them yet.
   */
  title: z.string().optional(),
  /**
   * The issue's `type:X` label (e.g. "type:feature"), as-labelled. DECLARED,
   * NOT PRODUCED TODAY — see `title` above.
   */
  type: z.string().optional(),
  /**
   * Estimated USD across every role attributed to this issue. `null` ⇒ all
   * models unpriced (NOT free). Fractional, so no `.int()`. A list-rate
   * estimate, not a billed figure — see `lib/cost/pricing.ts`.
   */
  costUsd: z.number().nullable(),
  /**
   * Summed wall-clock ms of the issue's ROLE DISPATCHES — exactly the sum of
   * the per-role `wallMs` below, since that is how `IssueLedger.rows()` builds
   * it. It is NOT planned→terminal elapsed time: queue waits, idle gaps
   * between roles, git/worktree work, migrations and PR handling are all
   * outside any dispatch and are excluded. Deriving `idleMs = wallMs − Σ
   * perRole.wallMs` therefore yields a constant 0; there is no idle signal in
   * the snapshot today.
   */
  wallMs: z.number().int().nonnegative(),
  /** Four-way token split summed across the issue's roles. */
  tokens: TokenSplitSchema,
  /**
   * Per-role split of the row above. An OPEN `z.record(z.string(), …)` key, not
   * a `z.enum`, for the same reason `totals.perRole` is (schema.ts:186-190): a
   * future role must never break an older consumer's parse, and in zod v4 an
   * enum-keyed record is EXHAUSTIVE (all keys required), which would defeat the
   * partial shape outright.
   *
   * Producers MUST write ONLY the six ATTRIBUTABLE roles — `checkWriter`,
   * `judge`, `implementer`, `reviewer`, `critique`, `recovery` (`critique` has
   * had no producer since spec #1334 folded the design critique into the
   * reviewer; older rows still carry it). The other four
   * `CostRole`s (`planner`, `merger`, `postMergeReviewer`, `postMergeFixer`)
   * are BATCH roles that serve the whole iteration and cannot be charged to
   * one ticket; their cost belongs in `runTelemetry.overheadCostUsd`.
   *
   * `judge` (issue #1118) is the newest key here, and it is the reason this
   * record stayed open: a status file written before the judge existed has no
   * `judge` key at all, and must still parse and still render. Because the key
   * space is open and every entry is optional, it does — no schema version
   * bump, no migration of older snapshots.
   */
  perRole: z.record(z.string(), IssueRoleTelemetrySchema).optional(),
  /** Implementer dispatches for this issue, including the first pass (≥1). */
  implementerAttempts: z.number().int().nonnegative().optional(),
  /** Count of reviewer verdicts that came back HAS_BLOCKERS. */
  reviewerBlockers: z.number().int().nonnegative().optional(),
  /** Count of critique-driven retry legs.
   *  @deprecated #1334 — no producer. Read-only, for old records. */
  critiqueRetries: z.number().int().nonnegative().optional(),
  /**
   * Count of retry-exhaustion fix passes dispatched (issue #1182 Gap 2) —
   * at most 1 per issue, since the (deleted) `runCritique` only reached this pass once,
   * after `critiqueRetries`' rounds are spent and the diff is still
   * NEEDS_FIXES. Absent means the pass never dispatched for this issue.
   *
   * @deprecated #1334 — no producer. Read-only, for old records.
   */
  critiqueFixPasses: z.number().int().nonnegative().optional(),
  /**
   * Subset of `critiqueFixPasses` where the fixer emitted
   * `CRITIQUE_FIX_APPLIED` rather than `CRITIQUE_FIX_REFUSED` or no marker.
   * Says nothing about whether the follow-up re-critique then shipped it —
   * only that the fixer itself made and committed a change.
   *
   * @deprecated #1334 — no producer. Read-only, for old records.
   */
  critiqueFixPassesApplied: z.number().int().nonnegative().optional(),
  /**
   * Count of criterion-amendment rounds dispatched (issue #1188) — at most 1
   * per issue, since `runCheckWriterStage` only buys this round once, after
   * the weak-check pool is spent and the judge is still ruling
   * `CHECK_TOO_WEAK`. Absent means the round never dispatched for this
   * issue. HISTORICAL: the round was deleted by spec #1334 (SF1); nothing
   * writes this any more, and it stays so rows already on disk still parse.
   */
  criterionAmendments: z.number().int().nonnegative().optional(),
  /**
   * Subset of `criterionAmendments` where the write actually landed a NEW
   * section (`applyCriterionAmendment` returned `"applied"`) rather than
   * finding one already on the body (`"already-present"`) — the latter never
   * dispatches a fresh check-writer attempt, so it is never counted here.
   */
  criterionAmendmentsApplied: z.number().int().nonnegative().optional(),
  /**
   * Count of times the protected-path lock (issue #909 / Piece C) caught the
   * builder editing a path it must not touch and restored it. This is the
   * number that says whether the lock is holding — see
   * `IssueTelemetryBag.noteChecksTampered`. Absent means the lock never
   * fired for this issue; it is never written as `0`.
   */
  checksTamperCount: z.number().int().nonnegative().optional(),
  /** Times this issue was released back to `ready-for-agent`. */
  deferrals: z.number().int().nonnegative().optional(),
  /** True when the reviewer escalated to a stronger model on this issue. */
  reviewerEscalated: z.boolean().optional(),
  /** The model escalated TO. Open string — new model ids ship constantly. */
  reviewerEscalationModel: z.string().optional(),
  /** Lines added + removed in the issue's shipped diff. */
  changedLines: z.number().int().nonnegative().optional(),
  /** Files touched in the issue's shipped diff. */
  changedFiles: z.number().int().nonnegative().optional(),
  /**
   * Which files were touched, in the order the producer measured them.
   * Capped at {@link MAX_CHANGED_FILE_PATHS} entries — see that constant's doc
   * comment for why. `changedFiles` (the count above) stays authoritative and
   * UNCAPPED, so `changedFiles > changedFilePaths.length` is the truncation
   * signal: a consumer must NEVER derive the count from this array's length.
   */
  changedFilePaths: z.array(z.string()).optional(),
  /**
   * The implementer's own certification envelope for the pass that shipped —
   * its REPORT CARD on whether a screen check was required and whether it ran
   * one (issue #886).
   *
   * A CLAIM, NOT AN OBSERVATION. Every field here is the implementer grading
   * itself; nothing in this object was measured by the host. It is recorded
   * because it is the only durable copy — until #886 the envelope was
   * schema-validated and then discarded, so no artifact outside a machine-local
   * log ever held what the robot said about its own screen check.
   *
   * ABSENT means the pass produced no envelope (rebuttal, HALT, stuck-abort),
   * NOT that the certification was clean.
   *
   * Every field is `.optional()` DELIBERATELY, even though the verdict schema
   * requires all seven: a telemetry row must stay parseable when a future
   * envelope shape drops or renames a field, and a snapshot that fails to parse
   * loses the whole run's numbers to record a formatting change.
   */
  implementerCertification: z
    .object({
      storyType: z.string().optional(),
      e2eRequired: z.boolean().optional(),
      e2eActuallyRan: z.boolean().optional(),
      testCommandUsed: z.string().nullable().optional(),
      e2eAssertionLine: z.string().nullable().optional(),
      outputNotFiltered: z.boolean().optional(),
      testReachedFeature: z.boolean().optional(),
    })
    .optional(),
  shipPath: ShipPathSchema.optional(),
  outcome: IssueOutcomeSchema.optional(),
  /** True when the optional `--recovery on` pass ran for this issue. */
  recovery: z.boolean().optional(),
  /** True when review quarantined the issue for a human. */
  quarantined: z.boolean().optional(),
  /**
   * Which of the check-writer's allowed outcomes this issue's pass settled on
   * (issue #911, Piece D). Absent means the check-writer pass never ran or
   * never produced a parseable marker for this issue — NOT that it produced
   * `checks-written` (ABSENT ≠ ZERO, same rule as every other field on this
   * row).
   */
  checkWriterOutcome: CheckWriterOutcomeSchema.optional(),
  /**
   * True when the check-writer recognised a check that arrived with the
   * ticket already proven red by a person (Piece J), rather than authoring
   * a new one — the HOST's own filesystem observation
   * (`hasPreexistingCheckFiles`), never the agent's self-report alone.
   */
  checkWriterInherited: z.boolean().optional(),
  /**
   * WHICH WAY the first test failed to come out good on a ticket the loop
   * built ANYWAY (#1198 A) — absent, which is the overwhelming majority,
   * when the check-writer stage produced a check the loop could stand
   * behind.
   *
   * The three values are the three stops this replaced:
   * `stopped:no-failing-check`, `stopped:weak-check`, `stopped:run-fault`.
   * Kept as its own enum rather than folded into `stopReason.label`, because
   * those two now mean opposite things: `stopReason` says the ticket was
   * HELD, and the whole point of this field is a ticket that was not.
   *
   * ABSENT ≠ ZERO, same rule as every other field on this row.
   */
  firstTestFallThrough: z
    .enum([
      "no-failing-check",
      "weak-check",
      "run-fault",
      "test-disagreed",
      "already-built",
      "red-at-ship",
    ])
    .optional(),
  /**
   * True when a ticket carrying {@link firstTestFallThrough} actually
   * SHIPPED (#1198 A) — set at the ship moment, beside the
   * `shipped-without-first-test` label going onto the issue.
   *
   * Deliberately separate from `firstTestFallThrough`: the fall-through is
   * set when the check-writer stage gives up, hours before anyone knows
   * whether the reviewer will pass the ticket. A run where every
   * fall-through ticket was then REFUSED by the reviewer is a very different
   * night from one where they all shipped, and one field cannot tell those
   * apart. The end-of-run report reads this one, never the other.
   */
  shippedWithoutFirstTest: z.boolean().optional(),
  /**
   * The approving reviewer's one line when its report-only Structure row
   * said `FINDING` — set at the ship moment, beside the
   * `shipped-with-structure-finding` label. Never a gate.
   */
  structureFinding: z.string().optional(),
  /**
   * The approving reviewer's one line when its report-only First-test
   * strength row said `WEAK` — set at the ship moment, beside the
   * `shipped-with-weak-first-test` label. Never a gate.
   */
  weakFirstTest: z.string().optional(),
  /**
   * How many of ANOTHER ticket's frozen test files this ticket's merge had to
   * rewrite before it could ship (#1271) — written at the ship moment,
   * beside the `shipped-with-sibling-check-amended` label going onto the
   * issue.
   *
   * A COUNT rather than a flag, because the size of the machine's reach into
   * other tickets is the thing worth watching: one fixture line in one file
   * on a night is ordinary; three files across three closed tickets is a rule
   * change nobody wrote a spec for, and only a number can tell those apart in
   * a tally.
   *
   * Set only on a merge, never at repair time: a repair whose re-review was
   * then refused leaves its amendment on an unmerged branch and must claim
   * nothing. ABSENT ≠ ZERO, same rule as every other field on this row —
   * absent is the overwhelming majority, and it means no sibling check was
   * touched at all.
   *
   * Optional, so no `STATUS_SCHEMA_VERSION` bump: rows written before it
   * simply lack it.
   */
  siblingChecksAmended: z.number().int().nonnegative().optional(),
  /**
   * The must-fail-first proof's result against untouched code, for a FRESH
   * (non-inherited) `checks-written` outcome: `"red"` the check failed as
   * required (proceeded to the builder), `"green"` it passed on day one
   * (retried once), `"inconclusive"` the sandbox could not execute it (never
   * blocks — see `runCheckCommand`). Absent on every other outcome,
   * including an inherited check, which skips this proof entirely.
   */
  checkWriterMustFailFirst: z
    .enum(["red", "green", "inconclusive"])
    .optional(),
  /**
   * True when the must-fail-first check came back green on the FIRST
   * attempt and the check-writer was given its one allowed retry (Piece D:
   * "the check-writer gets exactly one more go, then the ticket stops").
   */
  checkWriterRetried: z.boolean().optional(),
  /**
   * True when the check-writer's last-line outcome marker and its envelope's
   * own `marker` field were the two different "written" markers
   * (`CHECKS_WRITTEN` / `UNIT_CHECK_WRITTEN`) and the host took the ENVELOPE's
   * reading instead of stopping the ticket `stopped:check-disagreement`
   * (2026-09-10, after #1249 and #1235 both died on it in one run). Absent
   * (never `false`) on every ticket whose two markers agreed. Optional, so no
   * `STATUS_SCHEMA_VERSION` bump: rows written before it simply lack it.
   */
  checkWriterMarkerReconciled: z.boolean().optional(),
  /**
   * True when this ticket resumed from a WIP checkpoint carrying a valid
   * must-fail-first receipt, so the proof was CARRIED FORWARD rather than
   * re-run (issue #916 defect 2). Load-bearing for exactly the auditability
   * question `enforcement` answers for the screen check: reading
   * `checkWriterMustFailFirst: "red"` off a row says nothing about whether
   * THIS run observed the red or inherited somebody else's observation of it,
   * and the two are not the same evidence. Absent (never `false`) when the
   * proof was run, skipped, or not applicable — same shape as
   * `checkWriterInherited` beside it.
   */
  checkWriterProofCarriedForward: z.boolean().optional(),
  /**
   * What came of the judge's POST-BUILDER check repair on this ticket (issue
   * #1118, ruling 3): `"attempted"` a rewrite was dispatched, `"repaired"` it
   * proved itself red against the code the builder was handed and green
   * against the code it produced and the ticket carried on, `"stopped"` it was
   * dispatched and refused. Absent on every ticket that never reached a repair,
   * which is nearly all of them.
   *
   * ITS OWN FIELD, and that is the point. The repair dispatches the
   * check-writer a second time, and folding it into `checkWriterRetried` /
   * `checkWriterMustFailFirst` — both last-write-wins — made a SUCCESSFULLY
   * repaired ticket record `"green"` for the must-fail-first proof, which
   * everywhere else in this file means "could not be proved to fail against
   * untouched code". The best outcome was being written down as the worst one,
   * in the file this whole feature's cost case was measured from.
   */
  judgeCheckRepair: z
    .enum(["attempted", "repaired", "stopped", "not-attempted"])
    .optional(),
  /**
   * What came of the first test's one rewrite after a reviewer's
   * `GROUNDS: WRONG-CHECK` (spec #1334): `"attempted"` a rewrite was
   * dispatched, `"repaired"` it proved itself and became the first test,
   * `"stopped"` it could not be proved and the accepted test was put back.
   * Its own field for the reason {@link judgeCheckRepair} gives. Since spec
   * #1334 this is the field written; `judgeCheckRepair` is READ-ONLY, kept so
   * rows written before the rename still parse.
   */
  firstTestRewrite: z
    .enum(["attempted", "repaired", "stopped", "not-attempted"])
    .optional(),
  /**
   * The OBSERVED half of the screen-check record (issue #912, Piece K):
   * which screen, did the harness's own browser grade it as matching, when,
   * where the receipt picture went. This is a MEASUREMENT, not a claim —
   * the harness ran the check itself, in a browser it opened, on finished
   * code — and it is a SEPARATE field from `implementerCertification`
   * above (the CLAIMED half, already on `main` via #886/PR #897) on
   * purpose: "a claim and an observation that merge into one field are
   * indistinguishable afterwards, which is the failure this whole design
   * exists to remove." Absent means no harness-run check happened for this
   * issue (e.g. `NO_SCREEN_APPLIES`, or the harness gate never reached —
   * NOT that it ran and passed cleanly with nothing to report).
   */
  screenCheck: z
    .object({
      /** The route/page the check-writer's check targeted, when stated. */
      screen: z.string().optional(),
      /**
       * The harness's FINAL verdict — the one that decided the ticket's
       * fate. When the check was re-run this is the MORE-EVIDENCED of the
       * two attempts (`moreEvidencedVerdict`), not simply the second one,
       * so it can differ from the last entry in `attemptVerdicts` below.
       * See {@link ScreenCheckVerdictSchema} for the six names.
       */
      verdict: ScreenCheckVerdictSchema,
      /** ISO instant the harness's (final, possibly re-run) attempt concluded. */
      whenIso: z.string(),
      /**
       * True when the check-writer's check was re-run once before this
       * verdict was reached (Piece F: "the check itself may be re-run once
       * before the ticket stops").
       */
      rerun: z.boolean(),
      /**
       * Where the receipt picture went, when it was both taken AND
       * successfully filed (issue #913, not yet built — R2 is disabled on
       * the account). Absent whenever `pictureStored` is `false`, for
       * either of Piece G's two distinct reasons: never taken (genuine
       * absence — no browser ever rendered the page) or taken but
       * unfileable (not configured, or every retry failed).
       */
      pictureLink: z.string().optional(),
      /**
       * Whether the receipt picture is actually sitting in the picture
       * store. `false` does NOT mean the ticket was blocked — Piece G is
       * explicit that a picture that was taken but could not be filed must
       * not stop the ticket; only a picture that was never taken (bundled
       * into `verdict !== "match" && verdict !== "graded-mismatch"` when
       * the underlying run never rendered anything) does that, upstream of
       * this field even being written.
       */
      pictureStored: z.boolean(),
      /**
       * EVERY attempt's verdict, oldest first — the full story behind the
       * single `verdict` above. Length 1 when the check passed first time,
       * 2 when it was re-run (`runHarnessScreenCheck` allows exactly one
       * re-run, win or lose).
       *
       * WHY IT IS HERE. The two runs can genuinely DISAGREE, and since
       * `moreEvidencedVerdict` one of them is CHOSEN over the other rather
       * than the second one always winning. A human opening a ticket that
       * stopped on a screen check otherwise sees one sentence about one
       * verdict, with no way to tell that the other run said something
       * different — which is exactly the audit the choice now needs.
       *
       * OPTIONAL, and deliberately NOT defaulted to `[]`: every record
       * written before this field existed genuinely does not know its
       * attempt trail, and `[]` would claim we looked and found no
       * attempts. ABSENT ≠ ZERO, the same rule every other field on this
       * row follows. Capped at
       * {@link MAX_SCREEN_CHECK_ATTEMPT_VERDICTS} by DROPPING an oversized
       * trail whole at the write boundary — the cap is deliberately not a
       * `.max()` here (DROP, DON'T POISON, as `changedFilePaths` puts it),
       * so a reader never rejects a whole record over its trail.
       */
      attemptVerdicts: z.array(ScreenCheckVerdictSchema).optional(),
      /**
       * Which mode this verdict was produced under (issue #916):
       * `"watch-only"` (the check ran and was recorded, but did not hold the
       * ticket) or `"enforcing"` (a non-match stopped it).
       *
       * @deprecated Spec #1334 removed the switch; nothing writes this any
       * more and every red check is now recorded, never a stop. Kept only so
       * rows already on disk still parse (no `STATUS_SCHEMA_VERSION` bump).
       */
      enforcement: z.enum(["watch-only", "enforcing"]).optional(),
    })
    .optional(),
  /**
   * How this ticket stopped — Piece H's five (issue #914), issue #923's
   * four, and issue #1118's two (the judge: a check that proves too little,
   * a ticket that never said what was wanted) — the
   * durable, structured twin of the GitHub label the same event applied.
   * Absent means the issue shipped, or stopped for a cause that still
   * carries no `stopped:*` label at all.
   *
   * **Corrected by issue #923 (2026-08-19).** This comment used to say a
   * stuck abort and "a plain reviewer HAS_BLOCKERS after the ladder" were
   * deliberately excluded. They were not deliberate — they were the
   * unrecorded stops that cost $1,011.63 over twelve days. Both now carry a
   * label (`stopped:run-fault` and `stopped:reviewer-refused`) and both
   * are recorded here.
   */
  stopReason: z
    .object({
      // DERIVED from `lib/state/stop-reasons.ts`, never hand-copied. It WAS
      // hand-copied, and issue #923 then added four labels the run had no
      // way to record — a stop wearing one of them would have been dropped
      // silently by this schema while the GitHub label said otherwise.
      label: z.enum(STOP_REASON_LABELS),
      /** Human-readable explanation. For the six stops that write a body
       *  section, this is the SAME text, kept here so the durable record and
       *  the human-readable surface never drift apart. For the three that
       *  keep their GitHub comment instead (issue #923 — the skills gate,
       *  the stuck-detector, and until #1334 the critique gate), it is a one-line summary that
       *  reaches this record ONLY: their real explanation stays in the
       *  comment, by owner decision. */
      detail: z.string().optional(),
      /**
       * Present ONLY for `stopped:check-disagreement` — "when it stops, the
       * record must carry both sides."
       *
       * **Both sides, never the answer.** Which side turned out to be wrong
       * is NOT recorded here and must never be added back. Owner ruling 12
       * of the 2026-08-16 grilling: a verdict lives on the GitHub ticket
       * only, because this file is committed to git and a verdict here
       * would need a branch and a pull request every time. Its home is the
       * `## Verdict` block in the issue body — `lib/state/verdict.ts` —
       * with the `verdict:*` label as its index and `pnpm
       * sandcastle:verdict` as its reader. The two-value `resolution` field
       * that used to sit here was removed by issue #1117: nothing had ever
       * written it in twelve days across eight real disagreements, and it
       * only ever offered two of the four outcomes the owner ruled on.
       */
      disagreement: z
        .object({
          checkDemanded: z.string().optional(),
          builderProduced: z.string().optional(),
          builderAccount: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type IssueTelemetryRow = z.infer<typeof IssueTelemetryRowSchema>;

/**
 * The model map a role actually resolved to: its first-pass default plus every
 * model it may escalate to, in ladder order. RESOLVED, not configured — that is
 * what makes a mislabeled profile self-detecting (a run tagged `budget` whose
 * implementer default is an Opus id is visibly wrong from this field alone).
 */
export const RoleModelEntrySchema = z.object({
  default: z.string(),
  escalations: z.array(z.string()),
});
export type RoleModelEntry = z.infer<typeof RoleModelEntrySchema>;

/**
 * What this run WAS — the axes that make two runs comparable (or prove they
 * aren't). A CLOSED enum on `profile` on purpose: it names the model-map
 * selection in `roleModelsFor({ backend, opusProfile, budget })`
 * (`main.mts:1055`), whose branches are exhaustive today, and a closed set is
 * what lets a consumer group runs by profile without normalizing free text.
 * The `provider` endpoint override (kimi/glm) is a SEPARATE axis and is an open
 * string — it does not change the model map, so it is not a profile.
 */
export const RunIdentitySchema = z.object({
  /**
   * Model-map profile. Precedence, as actually implemented by `roleModelsFor`
   * (`main.mts:1197-1205`): `codex` → `budget` → `opus5` → `default`. Codex
   * wins because it is a backend swap, not a model-tier choice. (Unobservable
   * in practice — the flags hard-error in combination at parse time,
   * `main.mts:970-1011` — but the ladder is recorded here correctly so a
   * reader is not misled about which selector dominates.)
   */
  profile: z.enum(["default", "opus5", "budget", "codex"]),
  /** Agent backend, `claude` | `codex`. Open string to stay future-proof. */
  backend: z.string().optional(),
  /**
   * Claude-backend endpoint override (`kimi` | `glm`, see
   * `lib/hosts/launch.ts`). A run on kimi is otherwise indistinguishable from
   * default claude, since `provider` leaves the model map untouched.
   */
  provider: z.string().optional(),
  /**
   * Resolved role → model-ladder map. Open record key so a future role never
   * breaks an older consumer's parse.
   */
  roleModels: z.record(z.string(), RoleModelEntrySchema),
  /** Prompt filename → short sha256 of its contents, so a prompt edit between
   *  two runs is visible instead of silently confounding a comparison. */
  promptHashes: z.record(z.string(), z.string()).optional(),
});
export type RunIdentity = z.infer<typeof RunIdentitySchema>;

/**
 * Run-wide event counters. Every leaf is optional (a partial source stays
 * valid, per `RoleBreakdown`'s contract); absence means "not captured", which
 * is deliberately distinguishable from a captured 0.
 */
export const RunCountersSchema = z.object({
  reviewerBlockers: z.number().int().nonnegative().optional(),
  implementerRetries: z.number().int().nonnegative().optional(),
  /** @deprecated #1334 — no producer. Read-only, for old records. */
  critiqueFails: z.number().int().nonnegative().optional(),
  recoveries: z.number().int().nonnegative().optional(),
  quarantines: z.number().int().nonnegative().optional(),
  deferrals: z.number().int().nonnegative().optional(),
  /** Role → count of runs that skipped a mandated skill. Open record key. */
  skillDisciplineMisses: z
    .record(z.string(), z.number().int().nonnegative())
    .optional(),
});
export type RunCounters = z.infer<typeof RunCountersSchema>;

/**
 * How agent dispatches FAILED, bucketed. Separating these is what turns "the
 * run was bad" into "the run hit the output cap 9 times". All optional; absent
 * ⇒ not captured, which is not the same as a captured 0.
 */
export const RunErrorClassesSchema = z.object({
  /** Retried API/network/tooling errors that eventually cleared. */
  transient: z.number().int().nonnegative().optional(),
  /** Dispatches killed for making no progress within their watchdog window. */
  stalled: z.number().int().nonnegative().optional(),
  /** Reviewer runs that produced no parseable verdict marker. */
  noVerdict: z.number().int().nonnegative().optional(),
  /** Dispatches truncated by the model's max-output-tokens ceiling. */
  outputCap: z.number().int().nonnegative().optional(),
});
export type RunErrorClasses = z.infer<typeof RunErrorClassesSchema>;

/**
 * Per-role cache economics: the four-way split plus the derived hit ratio.
 *
 * `cacheHitRatio` is REQUIRED but NULLABLE, and the null case is the entire
 * reason this schema exists. The formula — see `cacheHitRatio` in
 * `lib/telemetry/issue-ledger.ts`, the one producer — is
 * `cacheRead / (input + cacheWrite + cacheRead)`: the share of PROMPT tokens
 * served from cache. `output` is excluded because generated tokens are never
 * cacheable. For a role that consumed nothing that is `0/0 = NaN`. `z.number()` REJECTS `NaN` (and `JSON.stringify` turns it
 * into `null` on the wire anyway), so a producer that emits NaN fails the whole
 * snapshot parse — killing every consumer, not just this field. Producers MUST
 * emit `null` for an all-zero role. `null` means "undefined ratio", NOT 0%.
 */
export const RoleTokenEfficiencySchema = TokenSplitSchema.extend({
  cacheHitRatio: z.number().nullable(),
});
export type RoleTokenEfficiency = z.infer<typeof RoleTokenEfficiencySchema>;

/**
 * Run-level telemetry: the things that describe the RUN rather than any one
 * issue. Every member is optional so a partially-instrumented run still
 * produces a valid (if sparse) object rather than nothing at all.
 */
export const RunTelemetrySchema = z.object({
  identity: RunIdentitySchema.optional(),
  counters: RunCountersSchema.optional(),
  errorClasses: RunErrorClassesSchema.optional(),
  /** Role → cache economics. Open record key, same rationale as elsewhere. */
  tokenEfficiency: z.record(z.string(), RoleTokenEfficiencySchema).optional(),
  /**
   * Summed estimated USD of the four NON-ATTRIBUTABLE batch roles — `planner`,
   * `merger`, `postMergeReviewer`, `postMergeFixer`. These serve a whole
   * iteration, so charging them to a ticket would be a lie; they live here so
   * `sum(issueTelemetry[].costUsd) + overheadCostUsd` reconciles to the run
   * total. `null` ⇒ all four saw only unpriced models (NOT free).
   */
  overheadCostUsd: z.number().nullable().optional(),
});
export type RunTelemetry = z.infer<typeof RunTelemetrySchema>;

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
   * ISO-8601 of the last GENUINE-PROGRESS write — a real state transition
   * (iteration start, plan, issue phase, cross-issue activity, terminal
   * outcome, stop/finish), NEVER the keep-alive heartbeat. This is the
   * "work advancing" signal, deliberately separate from `updatedAt` ("process
   * alive"): `updatedAt` is re-stamped every `HEARTBEAT_MS` regardless of
   * progress, so a wedged-but-alive loop keeps `updatedAt` fresh forever while
   * `lastProgressAt` goes stale. The stall watchdog
   * (`.sandcastle/scripts/stall-watchdog.mts`) reads THIS field, not
   * `updatedAt`, to tell a hang from a slow-but-healthy phase.
   *
   * OPTIONAL and additive ⇒ no `STATUS_SCHEMA_VERSION` bump (same house rule as
   * `pid`/`stopping`): a pre-watchdog status.json simply omits it, and the
   * watchdog fails SAFE (treats a missing field as not-stalled). Set at run
   * start alongside `updatedAt`; a peer projection may omit it.
   */
  lastProgressAt: z.string().optional(),
  /**
   * OPTIONAL OS process id of the loop that owns this feed (2b). Written once at
   * startup by `store.ts` (see `pid` at store.ts:255). NOTHING READS IT TODAY —
   * this is forward-looking telemetry, not a wired reconciler. A same-host
   * consumer could use it to prove the loop is gone (`process.kill(pid, 0)`
   * throws ESRCH) and stop trusting a fresh-looking `updatedAt` that a hard
   * kill (`--now` / SIGKILL) left behind, but no such consumer exists yet — it
   * would be meaningless cross-host (a remote pid can't be signaled). OPTIONAL
   * + additive ⇒ no `STATUS_SCHEMA_VERSION` bump; pre-2b and cross-host peer
   * projections simply omit it. `deriveLiveness` never reads it — a stale
   * `running` is already treated as non-live whether the pid is present,
   * absent, or dead.
   */
  pid: z.number().int().positive().optional(),
  /**
   * OPTIONAL human label of what a graceful stop is currently draining, e.g.
   * "implementer for #5, reviewer for #8" or "planning" (2c telemetry). Written
   * alongside `state:"stopping"` and cleared by `finish()`. Purely additive ⇒ no
   * version bump; absent whenever the run is not stopping.
   */
  stoppingWaitingOn: z.string().optional(),
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
  /**
   * Per-issue telemetry, one row per issue the run worked. OPTIONAL and
   * additive ⇒ no `STATUS_SCHEMA_VERSION` bump; a pre-telemetry status.json
   * simply omits the key. NOT `.default([])` — an absent key must stay
   * distinguishable from "a run that produced zero rows". Top-level so it
   * survives `foldPeers` and `trimForPush` (and so `setPlan`'s wholesale
   * replacement of `issues[]` can never wipe it). See the telemetry block above.
   */
  issueTelemetry: z.array(IssueTelemetryRowSchema).optional(),
  /**
   * Run-level telemetry: identity (profile / resolved model map / prompt
   * hashes), counters, error classes, cache economics, and batch-role overhead.
   * OPTIONAL and additive ⇒ no version bump. See the telemetry block above.
   */
  runTelemetry: RunTelemetrySchema.optional(),
});

export type SandcastleStatus = z.infer<typeof SandcastleStatusSchema>;
