/**
 * The DURABLE per-issue shipping record — the only telemetry the loop keeps
 * after a run ends.
 *
 * Everything else the loop measures dies quickly. `status.json` is gitignored
 * and rewritten from scratch every run; the per-issue git refs that carry the
 * rest are swept by `scripts/purge-coordination-refs.mts` at run end. So the
 * data survives until the next run and is then gone forever — and it cannot be
 * reconstructed afterwards, because once branches merge and the refs are
 * reaped there is nothing left to reconstruct it FROM.
 *
 * That matters for exactly one question: **did the work the loop shipped have
 * to be corrected afterwards?** It is the only honest external quality signal,
 * because the loop's own review passed work that two later independent reviews
 * found real defects in — so the loop grading itself proves nothing. Answering
 * it requires knowing, months later, which files issue #N touched and at which
 * commit, which is precisely the thing that currently evaporates.
 *
 * Hence an append-only JSONL at `.sandcastle/telemetry/issues.jsonl`, one line
 * per issue per run, COMMITTED TO GIT. Being tracked is the whole point:
 * durability across runs, hosts and clones. (Verified not excluded:
 * `git check-ignore` exits 1 on the path.)
 *
 * ## Why append-only, and what that buys
 *
 * Several hosts run one logical run, each with its own checkout, and any of
 * them can be hard-killed mid-write. {@link appendReworkRecord} therefore does
 * ONE `writeSync` of ONE complete `Buffer` — the trailing `\n` included in the
 * same buffer — to a descriptor opened `O_APPEND`. Never a read-modify-write,
 * never a rewrite, never a truncate. Two hosts appending concurrently interleave
 * whole lines rather than corrupting each other, and a crash can damage at most
 * the final line, never an earlier one.
 *
 * The residual failure — a torn final line from a partial write or a kill
 * between the two — is deliberately NOT repaired here. Repairing it would mean
 * rewriting the file, which is the one operation that can destroy good records.
 * Instead {@link readReworkRecords} skips any line it cannot use and REPORTS
 * how many it skipped. That is the causal link between these two functions:
 * the writer is allowed to be simple and unconditionally safe precisely because
 * the reader is total.
 *
 * ## Rules inherited from the rest of `lib/telemetry/`
 *
 * ABSENT ≠ ZERO. An omitted field means "never measured"; a written `0` means
 * "measured, and it was zero". A 0% rework rate computed from a `0` that really
 * meant "we never looked" is a false reassurance, which is worse than a gap.
 * `costUsd` is the one THREE-state field: absent (never measured), `null`
 * (measured — every model was unpriced, see `issue-ledger.ts:23`, never
 * coerce it to 0), or a figure.
 *
 * DROP, DON'T POISON. Caps are applied by SLICING before the write, never by a
 * schema `.max()`: a `.max()` turns an oversized record into a parse FAILURE,
 * and a failure is total — it blanks the whole record, not the offending field.
 * Same reason `shippedSha` is an open non-empty string: a hex/length regex
 * would reject an abbreviated sha and discard an otherwise perfect record.
 *
 * NEVER THROW. A telemetry exception can kill a $300 overnight run
 * (`issue-bag.ts:1-37`). Both functions route every failure to `opts.onError`
 * and return a value instead, mirroring `store.ts:379-392`.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  IssueRoleTelemetrySchema,
  MAX_CHANGED_FILE_PATHS,
  MAX_SCREEN_CHECK_ATTEMPT_VERDICTS,
  RoleModelEntrySchema,
  ScreenCheckVerdictSchema,
  type IssueRoleTelemetry,
  type RoleModelEntry,
} from "../status/schema.js";
import { STOP_REASON_LABELS } from "../state/stop-reasons.js";
import { safeCount } from "./issue-ledger.js";

/**
 * Bumped on any BREAKING change to the record shape. Every line carries it, so
 * a reader can tell a shape it predates from a shape that is merely damaged —
 * see {@link readReworkRecords}, which buckets the two separately.
 */
export const REWORK_SCHEMA_VERSION = 1;

/** Path of the store relative to a repo root. */
export const REWORK_STORE_RELATIVE_PATH = join(
  ".sandcastle",
  "telemetry",
  "issues.jsonl",
);

/** The store's absolute path for a given repo root. */
export function reworkStorePath(repoRoot: string): string {
  return join(repoRoot, REWORK_STORE_RELATIVE_PATH);
}

/**
 * How the issue LEFT the loop. A closed enum: the whole point of the store is
 * grouping outcomes, and free text cannot be grouped without normalising it.
 * An unrecognised value is dropped at the write boundary rather than widening
 * the set silently.
 */
export const ReworkOutcomeSchema = z.enum([
  "shipped",
  "quarantined",
  "needs-human",
]);
export type ReworkOutcome = z.infer<typeof ReworkOutcomeSchema>;

/**
 * One issue, one run, one line.
 *
 * Note what is REQUIRED: the identity fields plus `shippedSha`. The sha is the
 * load-bearing one — it is the point in history a reader walks FORWARD from to
 * find later commits that touched the same files. Without it a record cannot be
 * scored at all, so a record missing it is not written.
 *
 * Everything measured is optional, because "not instrumented" is a real state
 * that must stay distinguishable from a measurement (see the header).
 */
export const ReworkRecordSchema = z.object({
  schemaVersion: z.number().int().positive(),
  issueNumber: z.number().int().positive(),
  runId: z.string().min(1),
  hostId: z.string().min(1),
  /** ISO 8601, UTC. Open string — a `.datetime()` refinement would reject a
   *  slightly-off but perfectly readable stamp and lose the whole record. */
  shippedAtIso: z.string().min(1),
  /** The merge/ship commit. Open string on purpose — see the header. */
  shippedSha: z.string().min(1),
  /** Capped at {@link MAX_CHANGED_FILE_PATHS} by SLICING at write time; the
   *  cap is deliberately NOT expressed as `.max()` here (DROP, DON'T POISON).
   *  `changedFiles` stays authoritative, so `changedFiles > paths.length` is
   *  the truncation signal — never derive the count from this length. */
  changedFilePaths: z.array(z.string()).optional(),
  changedFiles: z.number().int().nonnegative().optional(),
  changedLines: z.number().int().nonnegative().optional(),
  /** THREE-state: absent / `null` (all models unpriced) / a figure. */
  costUsd: z.number().nullable().optional(),
  wallMs: z.number().nonnegative().optional(),
  /**
   * RETRIES, not attempts — it is `attempts − 1`, and it is 0 for an issue that
   * shipped on its first implementer pass. The distinction is not pedantry:
   * recording attempts here would turn 18 first passes into 18 phantom retries
   * and invert the very number this telemetry exists to produce
   * (`issue-bag.ts:319-329` makes the same warning at the other end).
   */
  retries: z.number().int().nonnegative().optional(),
  /**
   * How many times the protected-path lock (issue #909 / Piece C) caught this
   * ticket editing a path it must not touch. The durable half of that number
   * — the spec ("Piece C") is explicit that this must reach THIS file, not
   * only a log line, or "the lock tampers for free forever and nobody learns
   * it is not holding". Absent means the lock never fired; never written `0`.
   */
  checksTamperCount: z.number().int().nonnegative().optional(),
  quarantined: z.boolean().optional(),
  /**
   * Per-role cost/token/wall-time split for this issue (issue #911,
   * "Instrument this first"). Before this field, `costUsd`/`wallMs` above
   * were the ONLY numbers this durable, git-tracked file carried — a single
   * total per ticket, with no way to answer "what did the check-writer
   * pass alone cost" without re-deriving it from a machine-local
   * `status.json` that does not survive a cleanup and does not travel
   * between the Mac and the VPS. Reuses `IssueRoleTelemetrySchema`
   * verbatim (the same shape `status.json`'s `issueTelemetry[].perRole`
   * already carries) rather than inventing a second one. Absent means no
   * per-role data was captured for this issue — never a claim that no role
   * ran.
   */
  perRole: z.record(z.string(), IssueRoleTelemetrySchema).optional(),
  /**
   * The per-role model ladder the run resolved to, reusing
   * `RoleModelEntrySchema` so a consumer reads `.default` / `.escalations`
   * exactly as it does off `runTelemetry.identity`. This is the seed for later
   * auto-tuning: without it a future tuner can see outcomes but cannot
   * correlate them to the settings that produced them, which makes the whole
   * archive un-actionable.
   */
  models: z.record(z.string(), RoleModelEntrySchema).optional(),
  /**
   * The CLAIMED half of the screen-check record (issue #886) — the
   * implementer's own report card on whether a screen check was required
   * and whether it ran one. A CLAIM, NOT AN OBSERVATION: every field here
   * is the implementer grading itself, and nothing in this object was
   * measured by the host. Mirrors `IssueTelemetryRow.implementerCertification`
   * field-for-field, all optional for the same reason that copy is: a
   * telemetry row must stay parseable when a future envelope shape drops or
   * renames a field.
   *
   * Kept as a SEPARATE field from `screenCheck` below, on purpose, forever
   * — see that field's own doc comment. Before this was added, this claim
   * reached only the ephemeral, gitignored `status.json` (verified absent
   * from disk between runs), so it never actually persisted anywhere a
   * later observation could be checked against — the exact failure Piece K
   * exists to remove.
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
  /**
   * The OBSERVED half of the screen-check record (issue #912, Piece K) —
   * what the harness's OWN browser run actually saw, kept SEPARATE from
   * anything the robot itself claimed. This is the field the whole design
   * doc's "guarantee is carried by this, not by the picture" sentence
   * refers to: it must reach THIS durable, git-tracked file, not just a
   * machine-local `status.json` that a cleanup sweeps and that never
   * crosses from the Mac to the VPS. Absent means no harness-run check
   * happened for this issue (`NO_SCREEN_APPLIES`, or the gate was never
   * reached) — never a claim that one ran and passed cleanly.
   */
  screenCheck: z
    .object({
      screen: z.string().optional(),
      // The six names live in ONE place (`ScreenCheckVerdictSchema`) — this
      // used to restate them, which made a fourth hand-kept copy of a closed
      // enum that must match `HarnessVerdict`.
      verdict: ScreenCheckVerdictSchema,
      whenIso: z.string(),
      rerun: z.boolean(),
      pictureLink: z.string().optional(),
      pictureStored: z.boolean(),
      /**
       * Every attempt's verdict, oldest first — mirrors
       * `IssueTelemetryRowSchema.screenCheck.attemptVerdicts`, see there for
       * why it exists and why it is optional rather than defaulted to `[]`.
       * Load-bearing HERE specifically: the two runs can disagree and one is
       * now CHOSEN over the other, and this git-tracked file is the only
       * place a human can later audit that choice. Absent on every record
       * written before the field existed — those genuinely do not know their
       * trail, and they must keep loading.
       */
      attemptVerdicts: z.array(ScreenCheckVerdictSchema).optional(),
    })
    .optional(),
  /**
   * How this ticket stopped — Piece H's original five (issue #914) plus the
   * four issue #923 added for the reviewer, the merge gates, and the run's
   * own machinery breaking. Mirrors `IssueTelemetryRowSchema.stopReason`
   * field-for-field, the same pattern `screenCheck`/
   * `implementerCertification` already follow: this is the durable,
   * git-tracked twin of the GitHub `stopped:*` label the same event applied.
   * Absent means the issue did not stop for a labelled reason.
   */
  stopReason: z
    .object({
      // DERIVED, never hand-copied — see STOP_REASON_LABEL_SET below.
      label: z.enum(STOP_REASON_LABELS),
      detail: z.string().optional(),
      disagreement: z
        .object({
          checkDemanded: z.string().optional(),
          builderProduced: z.string().optional(),
          builderAccount: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  outcome: ReworkOutcomeSchema,
});
export type ReworkRecord = z.infer<typeof ReworkRecordSchema>;

/**
 * What a caller supplies. `schemaVersion` is absent by construction — the
 * writer stamps it, so a call site cannot forget it or state it wrongly.
 */
export type ReworkRecordInput = Omit<ReworkRecord, "schemaVersion">;

export interface ReworkStoreOpts {
  /**
   * Absolute store path — REQUIRED, and deliberately not defaulted to
   * `reworkStorePath(process.cwd())`.
   *
   * The loop works issues from `.sandcastle/worktrees/<lane>`, so a cwd-derived
   * default would write the record into a throwaway worktree that cleanup then
   * deletes — the record evaporates, which is exactly the failure this module
   * exists to prevent, and it would do so SILENTLY (the append succeeds and
   * returns `true`). Making the path explicit turns that silent data loss into
   * a decision the call site has to make. Production callers pass
   * `reworkStorePath(<main repo root>)`, never a worktree root.
   */
  path: string;
  /** Non-fatal failure sink. Wire to `deps.logError` in production. */
  onError?: (err: unknown) => void;
}

/** A non-empty string, or `undefined`. Never coerces — `String(x)` on a
 *  hostile `toString` throws, and this module may not throw. */
function safeText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The `models` map, entry-by-entry: each role is validated on its own and a bad
 * one is DROPPED, so one malformed ladder costs that role rather than the whole
 * record. `__proto__` is refused explicitly — it is the one key whose
 * assignment mutates a prototype instead of the object.
 *
 * Returns `undefined` (absent) when nothing usable survived, including for an
 * empty input: `{}` would assert "measured, no roles", which is a claim the
 * caller did not make.
 */
function safeModels(value: unknown): Record<string, RoleModelEntry> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, RoleModelEntry> = {};
  let any = false;
  for (const [role, entry] of Object.entries(value)) {
    if (role === "__proto__" || role.length === 0) continue;
    const parsed = RoleModelEntrySchema.safeParse(entry);
    if (!parsed.success) continue;
    out[role] = parsed.data;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * 1:1 mirror of {@link safeModels} for the per-role cost/token/wall-time split
 * (issue #911). Entry-by-entry validation with the same "one bad role costs
 * that role, not the whole record" discipline, and the same "empty survives
 * as absent, never as `{}`" rule.
 */
function safePerRole(
  value: unknown,
): Record<string, IssueRoleTelemetry> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, IssueRoleTelemetry> = {};
  let any = false;
  for (const [role, entry] of Object.entries(value)) {
    if (role === "__proto__" || role.length === 0) continue;
    const parsed = IssueRoleTelemetrySchema.safeParse(entry);
    if (!parsed.success) continue;
    out[role] = parsed.data;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * Build the exact object to serialise, assigning each optional field ONLY when
 * it was really measured. Returns `undefined` when a required field is
 * unusable — a record with no `shippedSha` or no issue number can never be
 * scored, so writing it would only add a line every future reader must skip.
 */
function normalize(input: ReworkRecordInput): ReworkRecord | undefined {
  const issueNumber =
    typeof input?.issueNumber === "number" &&
    Number.isInteger(input.issueNumber) &&
    input.issueNumber > 0
      ? input.issueNumber
      : undefined;
  const runId = safeText(input?.runId);
  const hostId = safeText(input?.hostId);
  const shippedAtIso = safeText(input?.shippedAtIso);
  const shippedSha = safeText(input?.shippedSha);
  const outcome = ReworkOutcomeSchema.safeParse(input?.outcome);
  if (
    issueNumber === undefined ||
    runId === undefined ||
    hostId === undefined ||
    shippedAtIso === undefined ||
    shippedSha === undefined ||
    !outcome.success
  ) {
    return undefined;
  }

  const record: ReworkRecord = {
    schemaVersion: REWORK_SCHEMA_VERSION,
    issueNumber,
    runId,
    hostId,
    shippedAtIso,
    shippedSha,
    outcome: outcome.data,
  };

  if (Array.isArray(input.changedFilePaths)) {
    // Element-by-element, never coerced, and SLICED at the cap rather than
    // rejected by it. A hostile iterator (an array Proxy) is contained here
    // so it cannot throw out of a function that promises not to.
    try {
      const clean: string[] = [];
      for (const p of input.changedFilePaths) {
        if (typeof p === "string" && p.length > 0) clean.push(p);
        if (clean.length >= MAX_CHANGED_FILE_PATHS) break;
      }
      record.changedFilePaths = clean;
    } catch {
      // Leave the field absent, like any other unusable input.
    }
  }
  const changedFiles = safeCount(input.changedFiles);
  if (changedFiles !== undefined) record.changedFiles = changedFiles;
  const changedLines = safeCount(input.changedLines);
  if (changedLines !== undefined) record.changedLines = changedLines;
  const wallMs = safeCount(input.wallMs);
  if (wallMs !== undefined) record.wallMs = wallMs;
  const retries = safeCount(input.retries);
  if (retries !== undefined) record.retries = retries;
  const checksTamperCount = safeCount(input.checksTamperCount);
  if (checksTamperCount !== undefined) {
    record.checksTamperCount = checksTamperCount;
  }

  // The three-state field: `null` is a MEASUREMENT ("every model unpriced")
  // and is written as such; only `undefined`/garbage leaves the key absent.
  if (input.costUsd === null) {
    record.costUsd = null;
  } else if (
    typeof input.costUsd === "number" &&
    Number.isFinite(input.costUsd)
  ) {
    record.costUsd = input.costUsd;
  }

  if (typeof input.quarantined === "boolean") {
    record.quarantined = input.quarantined;
  }
  const models = safeModels(input.models);
  if (models !== undefined) record.models = models;
  const perRole = safePerRole(input.perRole);
  if (perRole !== undefined) record.perRole = perRole;

  const implementerCertification = safeImplementerCertification(
    input.implementerCertification,
  );
  if (implementerCertification !== undefined) {
    record.implementerCertification = implementerCertification;
  }

  const screenCheck = safeScreenCheck(input.screenCheck);
  if (screenCheck !== undefined) record.screenCheck = screenCheck;

  const stopReason = safeStopReason(input.stopReason);
  if (stopReason !== undefined) record.stopReason = stopReason;

  return record;
}

/**
 * Field-by-field validation of the CLAIMED half of the screen-check record
 * (issue #886) — the implementer's own report card. Mirrors
 * `IssueTelemetryBag.noteImplementerCertification`'s exact discipline:
 * every field is admitted only on a `typeof` match (never a wholesale
 * copy — the input traces back to agent-produced text, one hop removed),
 * and an object that carried NONE of the seven fields is not a report
 * card, so it is left absent rather than written as `{}` — which would be
 * indistinguishable from a real envelope whose fields were all dropped.
 */
function safeImplementerCertification(
  input: unknown,
): ReworkRecord["implementerCertification"] | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const src = input as Record<string, unknown>;
  const out: NonNullable<ReworkRecord["implementerCertification"]> = {};
  if (typeof src.storyType === "string") out.storyType = src.storyType;
  if (typeof src.e2eRequired === "boolean") out.e2eRequired = src.e2eRequired;
  if (typeof src.e2eActuallyRan === "boolean") {
    out.e2eActuallyRan = src.e2eActuallyRan;
  }
  // `null` is MEANINGFUL on these two — the envelope's declared sentinel
  // for "no e2e ran" — so it is recorded, while any other non-string is
  // dropped, matching the bag setter's own rule.
  if (typeof src.testCommandUsed === "string" || src.testCommandUsed === null) {
    out.testCommandUsed = src.testCommandUsed;
  }
  if (typeof src.e2eAssertionLine === "string" || src.e2eAssertionLine === null) {
    out.e2eAssertionLine = src.e2eAssertionLine;
  }
  if (typeof src.outputNotFiltered === "boolean") {
    out.outputNotFiltered = src.outputNotFiltered;
  }
  if (typeof src.testReachedFeature === "boolean") {
    out.testReachedFeature = src.testReachedFeature;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The verdicts `.sandcastle/lib/harness/verdict.ts` can produce, DERIVED from
 *  the schema's own declared tuple rather than re-typed — a hand-kept copy
 *  here silently stops recognising the next verdict that gets added. */
const SCREEN_CHECK_VERDICTS = new Set<string>(ScreenCheckVerdictSchema.options);

/**
 * The attempt trail: every run's verdict, oldest first.
 *
 * ALL-OR-NOTHING, on purpose. A trail is POSITIONAL — "attempt 1 said X,
 * attempt 2 said Y" — so a partially-salvaged trail (one bad entry filtered
 * out, or an oversized one sliced) reads exactly like a run with fewer
 * attempts, which is precisely the fact this field exists to make visible.
 * Anything unusable therefore drops the WHOLE trail and leaves it absent,
 * WITHOUT dropping the screen-check record it arrived on: a real observation
 * with an unusable trail is still a real observation. An EMPTY array is
 * unusable for the same reason `{}` is not a report card — it would claim we
 * looked and found no attempts, when no check runs zero times.
 */
function safeAttemptVerdicts(
  input: unknown,
): NonNullable<ReworkRecord["screenCheck"]>["attemptVerdicts"] {
  if (!Array.isArray(input)) return undefined;
  if (input.length === 0) return undefined;
  if (input.length > MAX_SCREEN_CHECK_ATTEMPT_VERDICTS) return undefined;
  for (const v of input) {
    if (typeof v !== "string" || !SCREEN_CHECK_VERDICTS.has(v)) return undefined;
  }
  // A fresh array — never the caller's own reference, matching how every
  // other field here is copied by value into the record being built.
  return [
    ...(input as NonNullable<
      NonNullable<ReworkRecord["screenCheck"]>["attemptVerdicts"]
    >),
  ];
}

/**
 * Field-by-field validation of the OBSERVED screen-check record (issue
 * #912, Piece K), mirroring `safePerRole`/`safeModels` above: an object
 * missing a required field, or carrying an out-of-enum verdict, is dropped
 * WHOLESALE rather than partially recorded — a screen-check record with no
 * verdict is not a screen-check record.
 */
function safeScreenCheck(
  input: unknown,
): ReworkRecord["screenCheck"] | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const src = input as Record<string, unknown>;
  if (typeof src.verdict !== "string" || !SCREEN_CHECK_VERDICTS.has(src.verdict)) {
    return undefined;
  }
  const whenIso = safeText(src.whenIso);
  if (whenIso === undefined) return undefined;
  if (typeof src.pictureStored !== "boolean") return undefined;
  if (typeof src.rerun !== "boolean") return undefined;
  const out: NonNullable<ReworkRecord["screenCheck"]> = {
    verdict: src.verdict as NonNullable<ReworkRecord["screenCheck"]>["verdict"],
    whenIso,
    pictureStored: src.pictureStored,
    rerun: src.rerun,
  };
  const screen = safeText(src.screen);
  if (screen !== undefined) out.screen = screen;
  const pictureLink = safeText(src.pictureLink);
  if (pictureLink !== undefined) out.pictureLink = pictureLink;
  const attemptVerdicts = safeAttemptVerdicts(src.attemptVerdicts);
  if (attemptVerdicts !== undefined) out.attemptVerdicts = attemptVerdicts;
  return out;
}

/** Every `stopped:*` label, DERIVED from `lib/state/stop-reasons.ts` rather
 *  than hand-copied here. It was hand-copied, and issue #923's four new
 *  labels would have been dropped by this validator while the GitHub label
 *  said the stop happened — a record that silently disagrees with the
 *  ticket is worse than no record. */
const STOP_REASON_LABEL_SET = new Set<string>(STOP_REASON_LABELS);

/**
 * Field-by-field validation of the stop-reason record (issue #914, Piece H),
 * mirroring `safeScreenCheck` one level up: an object missing `label`, or
 * carrying an out-of-enum `label`, is dropped WHOLESALE — a stop-reason
 * record with no label is not a stop-reason record. `disagreement`
 * (meaningful only for `stopped:check-disagreement`) is validated one level
 * deeper and, if nothing on it survives, left absent rather than written as
 * `{}`.
 */
function safeStopReason(
  input: unknown,
): ReworkRecord["stopReason"] | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const src = input as Record<string, unknown>;
  if (typeof src.label !== "string" || !STOP_REASON_LABEL_SET.has(src.label)) {
    return undefined;
  }
  const out: NonNullable<ReworkRecord["stopReason"]> = {
    label: src.label as NonNullable<ReworkRecord["stopReason"]>["label"],
  };
  const detail = safeText(src.detail);
  if (detail !== undefined) out.detail = detail;
  if (src.disagreement !== null && typeof src.disagreement === "object") {
    const d = src.disagreement as Record<string, unknown>;
    const drow: NonNullable<NonNullable<ReworkRecord["stopReason"]>["disagreement"]> = {};
    const checkDemanded = safeText(d.checkDemanded);
    if (checkDemanded !== undefined) drow.checkDemanded = checkDemanded;
    const builderProduced = safeText(d.builderProduced);
    if (builderProduced !== undefined) drow.builderProduced = builderProduced;
    const builderAccount = safeText(d.builderAccount);
    if (builderAccount !== undefined) drow.builderAccount = builderAccount;
    if (Object.keys(drow).length > 0) out.disagreement = drow;
  }
  return out;
}

/**
 * Append ONE record. Returns `true` iff a complete line reached the file.
 *
 * The write is a single `writeSync` of a single buffer that already contains
 * its terminating newline, to an `O_APPEND` descriptor — see the header for why
 * that is the whole concurrency and crash story. `JSON.stringify` escapes any
 * newline inside a value, so a record can never span two lines however hostile
 * its strings are.
 *
 * Never throws: a missing directory, a read-only disk or an unusable record all
 * produce `false` plus one `onError` call. Losing one telemetry line is a
 * rounding error; killing the run that was producing it is not.
 */
export function appendReworkRecord(
  input: ReworkRecordInput,
  opts: ReworkStoreOpts,
): boolean {
  const onError = opts.onError ?? ((): void => {});
  const path = opts.path;

  const record = normalize(input);
  if (record === undefined) {
    onError(
      new Error(
        `rework-store: dropped a record for issue ${String(
          (input as { issueNumber?: unknown } | undefined)?.issueNumber,
        )} — a required field (issueNumber/runId/hostId/shippedAtIso/shippedSha/outcome) was missing or unusable`,
      ),
    );
    return false;
  }

  let fd: number | undefined;
  try {
    const buf = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, "a");
    const written = writeSync(fd, buf);
    if (written !== buf.length) {
      // A short write leaves a torn line. Do NOT try to patch it: any repair
      // is a rewrite, and a rewrite is the one operation that can destroy
      // records that are already good. The reader skips it.
      onError(
        new Error(
          `rework-store: short append (${written}/${buf.length} bytes) at ${path}`,
        ),
      );
      return false;
    }
    return true;
  } catch (err) {
    onError(err);
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure — the bytes are already in the kernel's hands
      }
    }
  }
}

export interface ReworkReadResult {
  /** Every line that parsed as a record of a version this reader understands. */
  records: ReworkRecord[];
  /**
   * Lines that were damaged or did not match the schema. Reported rather than
   * thrown so a caller can SAY "3 lines unreadable" instead of dying — and so
   * silent data loss is impossible to overlook.
   */
  skipped: number;
  /**
   * Lines stamped with a schemaVersion NEWER than this reader's. Counted
   * separately from `skipped` on purpose: a v2 writer may legitimately reshape
   * fields, and filing its records under "damaged" would silently discard newer
   * data as garbage — the one failure a durability store must not have.
   */
  futureVersion: number;
  /**
   * Whether the file was there at all. Distinguishes "the loop has not shipped
   * an issue since telemetry landed" (absent) from "the file exists and holds
   * nothing", which a CLI wants to word differently.
   */
  exists: boolean;
}

/**
 * Read every record. Total by construction: it never throws, and one bad line
 * costs that line only.
 *
 * A missing file is not an error — it is the normal state before the first
 * issue ships — so it yields an empty result with `exists: false` and no
 * `onError` call. Any OTHER read failure (a permission error, a directory in
 * the file's place) IS reported, because that one is a real problem wearing the
 * same empty-result clothes.
 *
 * Blank/whitespace-only lines are ignored rather than counted as damage: the
 * file always ends in a terminator, and a stray blank line loses nothing.
 */
export function readReworkRecords(opts: ReworkStoreOpts): ReworkReadResult {
  const onError = opts.onError ?? ((): void => {});
  const path = opts.path;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") onError(err);
    return { records: [], skipped: 0, futureVersion: 0, exists: false };
  }

  const records: ReworkRecord[] = [];
  let skipped = 0;
  let futureVersion = 0;

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1; // torn tail, or a genuinely corrupt line
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }
    // The version is read off the RAW object BEFORE the schema parse. Doing it
    // after would be useless: a future record whose shape changed fails the
    // parse, and would then be miscounted as damage.
    const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === "number" && version > REWORK_SCHEMA_VERSION) {
      futureVersion += 1;
      continue;
    }
    const result = ReworkRecordSchema.safeParse(parsed);
    if (!result.success) {
      skipped += 1;
      continue;
    }
    records.push(result.data);
  }

  return { records, skipped, futureVersion, exists: true };
}

/**
 * Collapse records that describe the SAME issue in the SAME run down to one.
 *
 * WHY THIS IS THE READER'S JOB, and not a bug in the writer: the store is a
 * JSONL that `.gitattributes` merges with the built-in `union` driver, which
 * resolves every collision by taking BOTH sides' lines. That is the correct
 * merge for an append-only log — it can never corrupt a self-contained record —
 * but it means the same line legitimately arrives twice when two branches that
 * both contain it are merged, or when a branch is merged and later
 * cherry-picked. The writer's own `reworkRecorded` Set already guarantees one
 * line per issue per run PER RUN; it cannot speak for what git does to the file
 * afterwards.
 *
 * WHY IT MATTERS: `aggregateRework` SUMS `totalFileCount`/`reworkedFileCount`
 * across scores, so a duplicated line does not merely inflate `issueCount` and
 * `scoredIssueCount` — it re-weights the file-weighted overall rate, counting
 * one issue's files twice in both the numerator and the denominator. The
 * headline number would then quietly depend on merge history.
 *
 * LAST OCCURRENCE WINS. The file is append-only, so a later line was written
 * later in wall-clock time and reflects the more complete picture: a record
 * re-appended by a subsequent host or a later phase carries fields (cost,
 * changed files, a resolved sha) that the earlier one may not have had. Taking
 * the first would prefer the less-instrumented copy.
 *
 * It lives HERE, beside {@link readReworkRecords} rather than in the one CLI
 * that happened to need it first, because it is the reader's other half: any
 * second consumer that read the store without it would silently double-weight
 * the rate, and a correctness rule that must be re-implemented per caller is a
 * rule that will eventually not be.
 */
export function dedupeRecords(records: readonly ReworkRecord[]): {
  records: ReworkRecord[];
  duplicates: number;
} {
  const byKey = new Map<string, ReworkRecord>();
  let duplicates = 0;
  for (const r of records) {
    // ` ` as the separator: neither a number nor a `runId` (which the
    // schema types as a plain string) can contain it, so `1|2` and `12|` — the
    // classic ambiguity of a printable joiner — cannot collide here.
    const key = `${r.issueNumber} ${r.runId}`;
    if (byKey.has(key)) duplicates += 1;
    byKey.set(key, r);
  }
  return { records: [...byKey.values()], duplicates };
}
