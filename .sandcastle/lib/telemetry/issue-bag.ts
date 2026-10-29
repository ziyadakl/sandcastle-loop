/**
 * The accumulators that turn the loop's prose into numbers.
 *
 * On the 2026-07-31 run, 6 of 18 issues (33%) needed a second implementer pass
 * — the single largest cost driver — and that fact existed ONLY as English in a
 * log file. {@link IssueTelemetryBag} counts it per issue; {@link RunCounters}
 * counts it (and quarantines, recoveries, deferrals, error classes and
 * skill-discipline misses) for the whole run.
 *
 * ## Why every setter is total
 *
 * These are called from deep inside `runIssuePipeline` (`main.mts:5737-6395`),
 * a function with many `return` statements. The bag is hung off the pipeline
 * context and MUTATED IN PLACE precisely so that instrumenting it changes no
 * `return`. Consequently every setter here is:
 *
 *   - total       — defined for every input, including garbage;
 *   - synchronous — no I/O, no awaits, no ordering hazards;
 *   - throw-free  — no parsing, no validation that can reject, no coercion of
 *                   caller values (`String(x)` on a hostile object throws).
 *
 * A telemetry exception can kill a $300 overnight run. Bad input is clamped or
 * dropped the way `lib/cost/timing.ts:42-43` clamps a bad clock read.
 *
 * ## Two semantic rules the tests pin
 *
 * ABSENT ≠ ZERO. An omitted field means "not instrumented / not captured"; a
 * written `0` means "measured, and it was zero". `toRow()` and
 * `toRunTelemetry()` therefore assign conditionally and never emit a key with
 * an `undefined` value.
 *
 * DROP, DON'T POISON. `shipPath` and `outcome` are CLOSED enums in
 * `lib/status/schema.ts`. An out-of-range value would fail `safeParse` and take
 * the WHOLE status snapshot down — every consumer, not just this field. Since
 * throwing is also forbidden, the only correct response to an unrecognised
 * value is to drop it silently and leave the field absent.
 */

import {
  CheckWriterOutcomeSchema,
  IssueOutcomeSchema,
  MAX_CHANGED_FILE_PATHS,
  MAX_SCREEN_CHECK_ATTEMPT_VERDICTS,
  ScreenCheckVerdictSchema,
  ShipPathSchema,
  type IssueTelemetryRow,
  type RunTelemetry,
} from "../status/schema.js";
import { STOP_REASON_LABELS } from "../state/stop-reasons.js";
import { safeCount } from "./issue-ledger.js";

/** One older ticket's test file a ship edited (spec #1334 SH's record). */
export interface OlderTestEdit {
  readonly issueNumber: number;
  readonly path: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** The shipping ticket's claim-time body contained this exact path — shown
   *  in the run report, never acted on. */
  readonly namedInTicket: boolean;
}

/**
 * The slice of an {@link IssueTelemetryRow} this bag produces. Typed as an
 * explicit `Pick` rather than `Partial<IssueTelemetryRow>` so ownership is
 * encoded: `costUsd` / `wallMs` / `tokens` / `perRole` come from the issue
 * ledger, and a merge site can see from the type alone that they are not this
 * module's to supply.
 */
export type IssueTelemetryBagRow = Partial<
  Pick<
    IssueTelemetryRow,
    | "implementerAttempts"
    | "reviewerBlockers"
    | "checksTamperCount"
    | "deferrals"
    | "reviewerEscalated"
    | "reviewerEscalationModel"
    | "changedLines"
    | "changedFiles"
    | "changedFilePaths"
    | "implementerCertification"
    | "shipPath"
    | "outcome"
    | "recovery"
    | "quarantined"
    | "checkWriterOutcome"
    | "checkWriterInherited"
    | "firstTestFallThrough"
    | "shippedWithoutFirstTest"
    | "structureFinding"
    | "weakFirstTest"
    | "siblingChecksAmended"
    | "checkWriterMustFailFirst"
    | "checkWriterRetried"
    | "checkWriterMarkerReconciled"
    | "checkWriterProofCarriedForward"
    | "firstTestRewrite"
    | "screenCheck"
    | "stopReason"
  >
>;

/**
 * The closed enums, DERIVED from the zod schemas rather than re-typed.
 *
 * `schema.ts` declares itself the single source of truth with "no twin to keep
 * in sync", and `ShipPathSchema` is itself documented as a mirror of
 * `PromptLegPath` — a hand-maintained set here would have been the THIRD copy.
 * `z.enum(...).options` is the declared tuple, so these sets cannot drift; a
 * new member is picked up for free.
 *
 * Every schema value this file imports at RUNTIME is read this way —
 * `.options` on a `z.enum`, or a plain numeric cap. Nothing here ever parses:
 * parsing can reject, and every setter in this module must stay total (see
 * the header).
 */
const SHIP_PATHS = new Set<string>(ShipPathSchema.options);
const OUTCOMES = new Set<string>(IssueOutcomeSchema.options);
/** What the check-writer is allowed to say (issue #911, Piece D) — DERIVED
 *  from the schema's declared tuple like `SHIP_PATHS` above, which in turn
 *  derives from `CHECK_WRITER_MARKERS` itself (issue #956). It was hand-kept
 *  here, and a hand-kept gate does not reject an unrecognised outcome, it
 *  DROPS it: the column comes back blank, which reads as "the check-writer
 *  never ran" rather than "we stopped recognising what it said". */
const CHECK_WRITER_OUTCOMES = new Set<string>(CheckWriterOutcomeSchema.options);
const CHECK_WRITER_MUST_FAIL_FIRST_STATUSES = new Set<string>([
  "red",
  "green",
  "inconclusive",
]);
/** What the judge's post-builder check repair can come to (issue #1118). */
const FIRST_TEST_REWRITE_STAGES = new Set<string>([
  "attempted",
  "repaired",
  "stopped",
  "not-attempted",
]);
/** The verdicts `.sandcastle/lib/harness/verdict.ts` can produce (issue #912,
 *  Piece F/K) — DERIVED from the schema's declared tuple, like `SHIP_PATHS`
 *  above, rather than hand-kept here (it was, and a hand-kept copy quietly
 *  stops recognising the next verdict someone adds). */
const SCREEN_CHECK_VERDICTS = new Set<string>(ScreenCheckVerdictSchema.options);
/** Every way a ticket stops — Piece H's original five (issue #914) plus
 *  issue #923's four. DERIVED from `lib/state/stop-reasons.ts`, like
 *  `SCREEN_CHECK_VERDICTS` above and for the same reason: a hand-kept copy
 *  quietly stops recognising the next label someone adds. */
const STOP_REASON_LABEL_SET = new Set<string>(STOP_REASON_LABELS);

/**
 * The screen check's attempt trail: every browser run's verdict, oldest
 * first. Length 1 when the check passed first time, 2 when it was re-run.
 *
 * ALL-OR-NOTHING, on purpose, and it mirrors `rework-store.ts`'s own
 * `safeAttemptVerdicts` (the durable end of the same field) exactly. A trail
 * is POSITIONAL — "attempt 1 said X, attempt 2 said Y" — so salvaging a
 * partial one (filtering a bad entry, slicing an oversized array) produces
 * something that reads as a run with FEWER attempts, which is the very fact
 * this field exists to make visible. Anything unusable therefore leaves the
 * trail absent. An EMPTY array is unusable for the same reason: it claims we
 * looked and found no attempts, and no check ever runs zero times.
 *
 * Returns a FRESH array — a caller that keeps mutating the array it passed in
 * must not be able to rewrite what the bag holds.
 */
function safeAttemptVerdicts(
  input: unknown,
): NonNullable<IssueTelemetryRow["screenCheck"]>["attemptVerdicts"] {
  if (!Array.isArray(input)) return undefined;
  if (input.length === 0) return undefined;
  if (input.length > MAX_SCREEN_CHECK_ATTEMPT_VERDICTS) return undefined;
  for (const v of input) {
    if (typeof v !== "string" || !SCREEN_CHECK_VERDICTS.has(v)) return undefined;
  }
  return [
    ...(input as NonNullable<
      NonNullable<IssueTelemetryRow["screenCheck"]>["attemptVerdicts"]
    >),
  ];
}

/**
 * Per-issue telemetry, created once per issue and mutated in place as the
 * pipeline progresses. Call sites are all optional-chained
 * (`ctx.telemetry?.noteX(...)`), so an absent bag is a no-op by construction.
 */
export class IssueTelemetryBag {
  #implementerAttempts: number | undefined;
  #reviewerBlockers = 0;
  #checksTamperCount = 0;
  #deferrals = 0;
  #reviewerEscalated = false;
  #reviewerEscalationModel: string | undefined;
  #changedLines: number | undefined;
  #changedFiles: number | undefined;
  #changedFilePaths: readonly string[] | undefined;
  #implementerCertification: IssueTelemetryRow["implementerCertification"];
  #shipPath: IssueTelemetryRow["shipPath"];
  #outcome: IssueTelemetryRow["outcome"];
  #recovery = false;
  #quarantined = false;
  #checkWriterOutcome: IssueTelemetryRow["checkWriterOutcome"];
  #checkWriterInherited = false;
  #firstTestFallThrough: IssueTelemetryRow["firstTestFallThrough"];
  #shippedWithoutFirstTest = false;
  #structureFinding: string | undefined;
  #weakFirstTest: string | undefined;
  #siblingChecksAmended: number | undefined;
  #olderTestEdits: readonly OlderTestEdit[] = [];
  #checkWriterMustFailFirst: IssueTelemetryRow["checkWriterMustFailFirst"];
  #checkWriterRetried = false;
  #checkWriterMarkerReconciled = false;
  #checkWriterProofCarriedForward = false;
  #firstTestRewrite: IssueTelemetryRow["firstTestRewrite"];
  #screenCheck: IssueTelemetryRow["screenCheck"];
  #stopReason: IssueTelemetryRow["stopReason"];

  /**
   * Record that implementer pass `n` ran. `n` is an ORDINAL (the first pass is
   * 1), not an increment, and the bag keeps the maximum seen — so double-noting
   * the same pass is safe and a stale lower ordinal never regresses the count.
   *
   * Because it is an ordinal, a bad value is DROPPED rather than clamped to 0:
   * `implementerAttempts: 0` would pass the schema's `.nonnegative()` while
   * asserting an issue no implementer ever touched.
   */
  noteImplementerAttempt(n: number): void {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return;
    const attempt = Math.round(n);
    if (this.#implementerAttempts === undefined || attempt > this.#implementerAttempts) {
      this.#implementerAttempts = attempt;
    }
  }

  /** One reviewer verdict came back HAS_BLOCKERS. */
  noteReviewerBlockers(): void {
    this.#reviewerBlockers += 1;
  }

  /**
   * The protected-path lock (issue #909 / Piece C) caught the builder editing
   * a path it must not touch — the practice world today, and the
   * acceptance-check file once #911's check-writer exists. This is the number
   * that says WHETHER THE LOCK IS HOLDING (docs/specs/2026-08-04-screen-check-
   * design-lock.md, Piece C: "Always recorded in words, never silent... This
   * is the number that says whether the lock is holding"), so — unlike
   * the plain counters above — it RETURNS the new cumulative count. The ship
   * funnel (`main.mts`'s `shipAfterMigrations`) needs that value inline, the
   * same call, to decide "twice on one ticket and the ticket stops regardless
   * of the result" without a second, separate getter that could read a stale
   * value between the increment and the decision.
   *
   * Reused across a redispatch of the SAME issue within one run — `main.mts`
   * keys `issueBags` by issue number and reuses the bag across iterations
   * (see its own comment at the `issueBags.get(issueNumber) ?? new
   * IssueTelemetryBag()` call site), which is exactly the mechanism that lets
   * "twice" mean "twice, ever, on this ticket" rather than "twice within one
   * function call".
   */
  noteChecksTampered(): number {
    this.#checksTamperCount += 1;
    return this.#checksTamperCount;
  }

  /**
   * The issue was released back to `ready-for-agent`. `marker` (e.g.
   * `TRANSIENT_ERROR`, `main.mts:6125`) is accepted and ignored, as above.
   */
  noteDeferral(_marker?: unknown): void {
    this.#deferrals += 1;
  }

  /** The optional `--recovery on` pass ran for this issue. */
  noteRecovery(): void {
    this.#recovery = true;
  }

  /**
   * Review quarantined the issue for a human. Deliberately does NOT set
   * `outcome` — the outcome is decided at the pipeline's exit boundary, and an
   * implicit write here would fight a later `noteOutcome("error")`.
   */
  noteQuarantine(_reason?: unknown): void {
    this.#quarantined = true;
  }

  /**
   * The reviewer escalated to a stronger model. The flag is set even when
   * `model` is unusable — the escalation is the expensive fact — but no model
   * id is invented.
   */
  noteReviewerEscalated(model?: unknown): void {
    this.#reviewerEscalated = true;
    if (typeof model === "string" && model.length > 0) {
      this.#reviewerEscalationModel = model;
    }
  }

  /**
   * The issue's shipped diff size. LAST WRITE WINS rather than summing: the
   * loop measures twice (first-pass review, then the ship funnel) and the
   * second measurement is computed so that it can never be narrower than the
   * first, which makes overwriting correct rather than double-counting. The
   * full argument, including how the ship-time base is derived, lives on
   * `shipDiffBase` in `lib/review/diff-measurement.ts` — the single canonical
   * statement of it.
   *
   * Each argument is validated independently, and an unusable one leaves its
   * field untouched (a false `0` would read as "measured, empty diff").
   *
   * `paths` is OPTIONAL and independent of the two counts: a caller that only
   * measured `changedLines`/`changedFiles` must not be made to claim it also
   * measured an (empty) file list — that is why a missing third argument
   * leaves `changedFilePaths` absent rather than defaulting it to `[]`.
   *
   * When given, `paths` is validated element-by-element (`typeof p ===
   * "string" && p.length > 0`, never coerced — `String(x)` on a hostile
   * `toString` throws) and truncated to {@link MAX_CHANGED_FILE_PATHS}
   * entries. Truncation never touches `changedFiles`: that count stays
   * whatever was passed, so it remains the authoritative total and
   * `changedFiles > changedFilePaths.length` is the truncation signal. The
   * array is copied on the way in, so a caller mutating its array afterward
   * cannot rewrite already-recorded telemetry.
   *
   * `Array.isArray` is true for a Proxy wrapping an array, so iterating could
   * in principle re-enter hostile traps and throw out of a setter this module's
   * header promises cannot throw. The walk is therefore wrapped: a throwing
   * iterator leaves `changedFilePaths` untouched, the same outcome as any other
   * unusable argument.
   */
  noteDiff(changedLines: number, changedFiles: number, paths?: readonly string[]): void {
    const lines = safeCount(changedLines);
    if (lines !== undefined) this.#changedLines = lines;
    const files = safeCount(changedFiles);
    if (files !== undefined) this.#changedFiles = files;
    if (Array.isArray(paths)) {
      try {
        const clean: string[] = [];
        for (const p of paths) {
          if (typeof p === "string" && p.length > 0) clean.push(p);
          if (clean.length >= MAX_CHANGED_FILE_PATHS) break;
        }
        this.#changedFilePaths = clean;
      } catch {
        // Hostile iterator: leave the field as it was, like any unusable input.
      }
    }
  }

  /**
   * The implementer's certification envelope — its report card on whether a
   * screen check was required and whether it ran one (issue #886).
   *
   * LAST WRITE WINS across implementer attempts, which is the correct rule: the
   * envelope that matters is the one attached to the pass that shipped, and the
   * final attempt is the one whose commit survives.
   *
   * `undefined` is passed on every pass that produced no envelope (rebuttal,
   * HALT, stuck-abort) and must NOT erase an envelope an earlier attempt
   * recorded — an absent report card is absent evidence, never a correction to
   * a present one. So `undefined` is a no-op, matching how every other setter
   * here treats an unusable argument.
   *
   * Field-by-field extraction, never a wholesale copy: the argument is typed
   * `unknown` and each field is admitted only on a `typeof` match. That keeps
   * the setter total (this module's header promises no setter throws), keeps a
   * hostile or future-shaped object from smuggling extra keys into a
   * schema-validated snapshot, and — because the copy is built here from
   * primitives — makes a caller mutating its object afterwards unable to
   * rewrite already-recorded telemetry.
   */
  noteImplementerCertification(cert: unknown): void {
    if (cert === null || typeof cert !== "object") return;
    const src = cert as Record<string, unknown>;
    const row: NonNullable<IssueTelemetryRow["implementerCertification"]> = {};
    try {
      if (typeof src.storyType === "string") row.storyType = src.storyType;
      if (typeof src.e2eRequired === "boolean") row.e2eRequired = src.e2eRequired;
      if (typeof src.e2eActuallyRan === "boolean") {
        row.e2eActuallyRan = src.e2eActuallyRan;
      }
      // `null` is MEANINGFUL on these two — the envelope's declared sentinel for
      // "no e2e ran" — so it is recorded, while any other non-string is dropped.
      if (typeof src.testCommandUsed === "string" || src.testCommandUsed === null) {
        row.testCommandUsed = src.testCommandUsed;
      }
      if (typeof src.e2eAssertionLine === "string" || src.e2eAssertionLine === null) {
        row.e2eAssertionLine = src.e2eAssertionLine;
      }
      if (typeof src.outputNotFiltered === "boolean") {
        row.outputNotFiltered = src.outputNotFiltered;
      }
      if (typeof src.testReachedFeature === "boolean") {
        row.testReachedFeature = src.testReachedFeature;
      }
    } catch {
      // Hostile getter: keep whatever was already recorded, like any other
      // unusable input. Never let a telemetry write take down a run.
      return;
    }
    // An object that carried none of the seven fields is not a report card.
    // Recording `{}` would be indistinguishable from a real envelope whose
    // fields were all dropped, so leave the slot absent instead.
    if (Object.keys(row).length === 0) return;
    this.#implementerCertification = row;
  }

  /** Which prompt legs ran before the issue shipped. Out-of-enum ⇒ dropped. */
  noteShipPath(path: unknown): void {
    if (typeof path === "string" && SHIP_PATHS.has(path)) {
      this.#shipPath = path as IssueTelemetryRow["shipPath"];
    }
  }

  /** The issue's terminal outcome. Out-of-enum ⇒ dropped. */
  noteOutcome(outcome: unknown): void {
    if (typeof outcome === "string" && OUTCOMES.has(outcome)) {
      this.#outcome = outcome as IssueTelemetryRow["outcome"];
    }
  }

  /**
   * Which thing the check-writer said (issue #911, Piece D), in the wire
   * spelling `lib/checkwriter/outcome-key.ts` derives from the markers.
   * Out-of-enum ⇒ dropped, matching `noteOutcome`'s discipline — an
   * unrecognised value must never reach a schema-validated snapshot.
   */
  noteCheckWriterOutcome(outcome: unknown): void {
    if (typeof outcome === "string" && CHECK_WRITER_OUTCOMES.has(outcome)) {
      this.#checkWriterOutcome =
        outcome as IssueTelemetryRow["checkWriterOutcome"];
    }
  }

  /**
   * The check-writer recognised (or the host independently observed) an
   * inherited check. Only ever set `true` — like `noteRecovery`, there is no
   * legitimate "un-inherit" within one issue's pipeline run.
   */
  noteCheckWriterInherited(): void {
    this.#checkWriterInherited = true;
  }

  /**
   * The check-writer stage could not produce a first test it could stand
   * behind, and the ticket was built ANYWAY (#1198 A). Records WHICH of the
   * three ways it failed.
   *
   * LAST WRITE WINS rather than first, and it matters on exactly one path: a
   * ticket can fall through before the build and, after a reviewer's
   * `WRONG-CHECK`, again on `test-disagreed` (spec #1334). The reason a person
   * wants is the one that was true when the ticket shipped, which is the last
   * one written. An out-of-enum value is DROPPED, matching
   * `noteCheckWriterOutcome` — a bag that silently records a value the schema
   * would refuse is a row that fails validation at write time, killing the
   * whole telemetry line rather than one field.
   */
  noteFirstTestFallThrough(reason: unknown): void {
    if (
      reason === "no-failing-check" ||
      reason === "weak-check" ||
      reason === "run-fault" ||
      reason === "test-disagreed" ||
      reason === "already-built" ||
      reason === "red-at-ship"
    ) {
      this.#firstTestFallThrough = reason;
    }
  }

  /**
   * A ticket carrying {@link noteFirstTestFallThrough} reached the ship
   * funnel and shipped (#1198 A). Only ever set `true`, like
   * `noteCheckWriterInherited` — there is no un-shipping within one issue's
   * pipeline run.
   */
  noteShippedWithoutFirstTest(): void {
    this.#shippedWithoutFirstTest = true;
  }

  /**
   * The APPROVING review's report-only rows, set at the ship moment
   * (`lib/review/review-notes.ts`): its structure finding and/or its reason
   * the first test is weak. Read by the run report's Shipped lines.
   */
  noteReviewNotes(notes: {
    readonly structureFinding?: string;
    readonly weakFirstTest?: string;
  }): void {
    this.#structureFinding = notes.structureFinding;
    this.#weakFirstTest = notes.weakFirstTest;
  }

  /**
   * This ticket shipped only after the loop rewrote `fileCount` of ANOTHER
   * ticket's frozen test files, on the run's own judge ruling that those
   * tests pinned a rule this ticket changed (#1271).
   *
   * Called at the SHIP moment, never at repair time: a repair whose
   * re-review was then refused leaves its amendment on an unmerged branch
   * and must claim nothing.
   *
   * KEEPS THE MAXIMUM rather than summing, the same discipline
   * `noteImplementerAttempt` applies and for a sharper version of the same
   * reason. Four ship-moment call sites read the SAME single
   * `ctx.olderTestEditRecord` record, and `main.mts` reuses one bag across
   * a redispatch of the same issue within a run — so summing would turn one
   * amendment into two the first time any of that fires twice. One ship
   * carries one older-test-edit record, so the maximum and the total are the
   * same number.
   *
   * A zero is DROPPED rather than written, exactly as
   * `noteImplementerAttempt` drops `0`: `siblingChecksAmended: 0` would pass
   * the schema's `.nonnegative()` while asserting a ticket that took this
   * road and amended nothing, which is not a measurement anyone can act on —
   * and the only caller derives the number from a record the road refuses to
   * build empty.
   */
  /**
   * Spec #1334 SE: WHICH older tests this ticket's ship edited, for the run
   * report's "Older tests edited" list. In memory only — never written to
   * the telemetry row, so no schema change. REPLACES rather than appends:
   * the four ship-moment sites read the same one `ctx.olderTestEditRecord`.
   */
  noteOlderTestEdits(files: readonly OlderTestEdit[]): void {
    this.#olderTestEdits = files.map((f) => ({ ...f }));
  }

  olderTestEdits(): readonly OlderTestEdit[] {
    return this.#olderTestEdits;
  }

  noteOlderTestEditCount(fileCount: number): void {
    if (
      typeof fileCount !== "number" ||
      !Number.isFinite(fileCount) ||
      fileCount < 1
    ) {
      return;
    }
    const count = Math.round(fileCount);
    if (
      this.#siblingChecksAmended === undefined ||
      count > this.#siblingChecksAmended
    ) {
      this.#siblingChecksAmended = count;
    }
  }

  /**
   * The must-fail-first proof's result against untouched code. Out-of-enum
   * ⇒ dropped.
   */
  noteCheckWriterMustFailFirst(status: unknown): void {
    if (
      typeof status === "string" &&
      CHECK_WRITER_MUST_FAIL_FIRST_STATUSES.has(status)
    ) {
      this.#checkWriterMustFailFirst =
        status as IssueTelemetryRow["checkWriterMustFailFirst"];
    }
  }

  /** The check-writer's one allowed retry (green-on-day-one) actually ran. */
  noteCheckWriterRetried(): void {
    this.#checkWriterRetried = true;
  }

  /**
   * The check-writer closed a `UNIT_CHECK_WRITTEN` envelope with
   * `CHECKS_WRITTEN` on its last line, or the reverse, and the host took the
   * envelope's reading instead of stopping the ticket (2026-09-10; the pair
   * that killed #1249 and #1235 in one run). Only ever set `true`, like
   * `noteCheckWriterRetried`. Counted so the prompt rule that went in beside
   * the reconcile can be measured: a run where this keeps appearing has a
   * prompt or model regression, not a ticket problem.
   */
  noteCheckWriterMarkerReconciled(): void {
    this.#checkWriterMarkerReconciled = true;
  }

  /**
   * What came of the first test's one rewrite after a reviewer's
   * `GROUNDS: WRONG-CHECK` (spec #1334). Out-of-enum ⇒ dropped, like every
   * setter here.
   *
   * MONOTONIC, not last-write-wins, and that is the whole reason it exists:
   * the repair reports `"attempted"` on dispatch and then `"repaired"` or
   * `"stopped"` on its outcome, and a stale `"attempted"` arriving late must
   * never erase the outcome. `"attempted"` therefore only ever fills an EMPTY
   * slot; a terminal value, once set, stands. Sharing `checkWriterRetried` and
   * `checkWriterMustFailFirst` with this dispatch is what corrupted a
   * successfully repaired ticket's row into looking like the worst outcome
   * there is — see this field on `IssueTelemetryRow`.
   */
  noteFirstTestRewrite(stage: unknown): void {
    if (typeof stage !== "string") return;
    if (!FIRST_TEST_REWRITE_STAGES.has(stage)) return;
    if (stage === "attempted" && this.#firstTestRewrite !== undefined) return;
    this.#firstTestRewrite = stage as IssueTelemetryRow["firstTestRewrite"];
  }

  /**
   * This ticket resumed from a checkpoint carrying a valid must-fail-first
   * receipt, so the proof was carried forward rather than re-run (issue #916
   * defect 2). Only ever set `true`, like `noteCheckWriterInherited` — within
   * one issue's pipeline run there is no legitimate "un-carry".
   */
  noteCheckWriterProofCarriedForward(): void {
    this.#checkWriterProofCarriedForward = true;
  }

  /**
   * The OBSERVED half of the screen-check record (issue #912, Piece K) —
   * what the harness's OWN browser run actually saw, never the robot's
   * self-report. `record` is typed `unknown` and validated field-by-field,
   * the same discipline `noteImplementerCertification` applies to the
   * CLAIMED half, for the same reason: this module's header promises every
   * setter is total and throw-free.
   *
   * LAST WRITE WINS, matching `noteDiff`/`noteImplementerCertification`:
   * one harness gate produces ONE record for the ticket, and a later gate
   * (the rescue ladder re-running the same check) describes the ticket's
   * fate better than an earlier one.
   *
   * WITHIN a single gate there is nothing to overwrite: `run-harness-check.ts`
   * already resolved its (at most) two attempts into one verdict before this
   * is ever called, and it does NOT simply take the second — it keeps the
   * MORE-EVIDENCED of the two (`moreEvidencedVerdict`), because re-running
   * cannot change reality, only re-observe it, so a re-run that saw LESS than
   * the first attempt must not erase what the first proved. `attemptVerdicts`
   * below carries both runs' verdicts so that choice stays auditable.
   *
   * An object missing `verdict`, or carrying an out-of-enum verdict, is
   * dropped entirely rather than partially recorded — a screen-check
   * record with no verdict is not a screen-check record, the same
   * "vacuous object" guard `noteImplementerCertification` applies. An
   * unusable `attemptVerdicts` does NOT drop the outer record (a real
   * observation with an unusable trail is still a real observation), but a
   * PARTLY-usable trail is dropped whole — see {@link safeAttemptVerdicts}.
   */
  noteScreenCheck(record: unknown): void {
    if (record === null || typeof record !== "object") return;
    const src = record as Record<string, unknown>;
    if (typeof src.verdict !== "string" || !SCREEN_CHECK_VERDICTS.has(src.verdict)) {
      return;
    }
    if (typeof src.whenIso !== "string" || src.whenIso.length === 0) return;
    if (typeof src.pictureStored !== "boolean") return;
    if (typeof src.rerun !== "boolean") return;
    const row: NonNullable<IssueTelemetryRow["screenCheck"]> = {
      verdict: src.verdict as NonNullable<IssueTelemetryRow["screenCheck"]>["verdict"],
      whenIso: src.whenIso,
      pictureStored: src.pictureStored,
      rerun: src.rerun,
    };
    if (typeof src.screen === "string") row.screen = src.screen;
    if (typeof src.pictureLink === "string") row.pictureLink = src.pictureLink;
    const attemptVerdicts = safeAttemptVerdicts(src.attemptVerdicts);
    if (attemptVerdicts !== undefined) row.attemptVerdicts = attemptVerdicts;
    // Issue #916: which mode produced this verdict. Validated against the two
    // known values rather than passed through — an unrecognised string is
    // dropped, never recorded as if it meant something.
    if (src.enforcement === "watch-only" || src.enforcement === "enforcing") {
      row.enforcement = src.enforcement;
    }
    this.#screenCheck = row;
  }

  /**
   * How this ticket stopped — Piece H's five plus issue #923's four (issue #914, Piece H) — see
   * `lib/state/stop-reasons.ts` for the label set and the harness-verdict
   * mapping. `record` is typed `unknown` and validated field-by-field, the
   * same discipline `noteScreenCheck`/`noteImplementerCertification` apply,
   * for the same reason: every setter in this module must stay total.
   *
   * LAST WRITE WINS, matching `noteScreenCheck` — a ticket that stops twice
   * within one pipeline run (should that ever happen) is described by its
   * MOST RECENT stop, not its first.
   *
   * An object missing `label`, or carrying an out-of-enum `label`, is
   * dropped entirely — a stop-reason record with no label is not a
   * stop-reason record, the same "vacuous object" guard every other
   * schema-shaped setter here applies. `disagreement` (present only for
   * `stopped:check-disagreement`) is validated the same way, one level
   * deeper; an unusable `disagreement` does NOT drop the outer record — a
   * label with no disagreement evidence is still a real, recordable stop.
   */
  noteStopReason(record: unknown): void {
    if (record === null || typeof record !== "object") return;
    const src = record as Record<string, unknown>;
    if (typeof src.label !== "string" || !STOP_REASON_LABEL_SET.has(src.label)) return;
    const row: NonNullable<IssueTelemetryRow["stopReason"]> = {
      label: src.label as NonNullable<IssueTelemetryRow["stopReason"]>["label"],
    };
    if (typeof src.detail === "string") row.detail = src.detail;
    if (src.disagreement !== null && typeof src.disagreement === "object") {
      const d = src.disagreement as Record<string, unknown>;
      const drow: NonNullable<
        NonNullable<IssueTelemetryRow["stopReason"]>["disagreement"]
      > = {};
      if (typeof d.checkDemanded === "string") drow.checkDemanded = d.checkDemanded;
      if (typeof d.builderProduced === "string") drow.builderProduced = d.builderProduced;
      if (typeof d.builderAccount === "string") drow.builderAccount = d.builderAccount;
      if (Object.keys(drow).length > 0) row.disagreement = drow;
    }
    this.#stopReason = row;
  }

  /**
   * The fields this bag owns, freshly built each call, containing ONLY what was
   * actually noted. Merges cleanly over an issue-ledger row via spread.
   */
  toRow(): IssueTelemetryBagRow {
    const row: IssueTelemetryBagRow = {};
    if (this.#implementerAttempts !== undefined) {
      row.implementerAttempts = this.#implementerAttempts;
    }
    if (this.#reviewerBlockers > 0) row.reviewerBlockers = this.#reviewerBlockers;
    if (this.#checksTamperCount > 0) {
      row.checksTamperCount = this.#checksTamperCount;
    }
    if (this.#deferrals > 0) row.deferrals = this.#deferrals;
    if (this.#reviewerEscalated) row.reviewerEscalated = true;
    if (this.#reviewerEscalationModel !== undefined) {
      row.reviewerEscalationModel = this.#reviewerEscalationModel;
    }
    if (this.#changedLines !== undefined) row.changedLines = this.#changedLines;
    if (this.#changedFiles !== undefined) row.changedFiles = this.#changedFiles;
    if (this.#changedFilePaths !== undefined) {
      row.changedFilePaths = [...this.#changedFilePaths];
    }
    if (this.#implementerCertification !== undefined) {
      row.implementerCertification = { ...this.#implementerCertification };
    }
    if (this.#shipPath !== undefined) row.shipPath = this.#shipPath;
    if (this.#outcome !== undefined) row.outcome = this.#outcome;
    if (this.#recovery) row.recovery = true;
    if (this.#quarantined) row.quarantined = true;
    if (this.#checkWriterOutcome !== undefined) {
      row.checkWriterOutcome = this.#checkWriterOutcome;
    }
    if (this.#checkWriterInherited) row.checkWriterInherited = true;
    if (this.#firstTestFallThrough !== undefined) {
      row.firstTestFallThrough = this.#firstTestFallThrough;
    }
    if (this.#shippedWithoutFirstTest) {
      row.shippedWithoutFirstTest = true;
    }
    if (this.#structureFinding !== undefined) {
      row.structureFinding = this.#structureFinding;
    }
    if (this.#weakFirstTest !== undefined) {
      row.weakFirstTest = this.#weakFirstTest;
    }
    if (
      this.#siblingChecksAmended !== undefined &&
      this.#siblingChecksAmended > 0
    ) {
      row.siblingChecksAmended = this.#siblingChecksAmended;
    }
    if (this.#checkWriterMustFailFirst !== undefined) {
      row.checkWriterMustFailFirst = this.#checkWriterMustFailFirst;
    }
    if (this.#checkWriterRetried) row.checkWriterRetried = true;
    if (this.#checkWriterMarkerReconciled) {
      row.checkWriterMarkerReconciled = true;
    }
    if (this.#checkWriterProofCarriedForward) {
      row.checkWriterProofCarriedForward = true;
    }
    if (this.#firstTestRewrite !== undefined) {
      row.firstTestRewrite = this.#firstTestRewrite;
    }
    if (this.#screenCheck !== undefined) {
      row.screenCheck = {
        ...this.#screenCheck,
        // One level deeper, like `stopReason.disagreement` below: a shallow
        // spread would hand out the bag's OWN attempt-trail array, and a
        // caller pushing to it would rewrite this bag's record.
        ...(this.#screenCheck.attemptVerdicts !== undefined
          ? { attemptVerdicts: [...this.#screenCheck.attemptVerdicts] }
          : {}),
      };
    }
    if (this.#stopReason !== undefined) {
      row.stopReason = {
        ...this.#stopReason,
        ...(this.#stopReason.disagreement !== undefined
          ? { disagreement: { ...this.#stopReason.disagreement } }
          : {}),
      };
    }
    return row;
  }
}

/**
 * The five run-scoped event counters, as a runtime whitelist. `bump()` accepts
 * ONLY these — an unrecognised key is dropped, which also makes the counter map
 * immune to prototype keys (`__proto__`, `toString`) arriving from a call site.
 */
const RUN_COUNTER_KEYS = [
  "reviewerBlockers",
  "implementerRetries",
  "recoveries",
  "quarantines",
  "deferrals",
] as const;
export type RunCounterKey = (typeof RUN_COUNTER_KEYS)[number];
const RUN_COUNTER_KEY_SET = new Set<string>(RUN_COUNTER_KEYS);

/** The four failure buckets `RunErrorClassesSchema` distinguishes. */
const ERROR_CLASS_KEYS = [
  "transient",
  "stalled",
  "noVerdict",
  "outputCap",
] as const;
export type RunErrorClassKey = (typeof ERROR_CLASS_KEYS)[number];

/**
 * One dispatch's failure classification. Each member is `true` (one
 * occurrence), a positive count, or absent/`false` (no occurrence — which must
 * NOT materialise the key as `0`).
 */
export type ErrorClassInput = Partial<
  Record<RunErrorClassKey, boolean | number>
>;

/** The slice of {@link RunTelemetry} this class produces. */
export type RunCountersTelemetry = Pick<
  RunTelemetry,
  "counters" | "errorClasses"
>;

/** `true` ⇒ 1, a finite positive integer ⇒ itself, anything else ⇒ no bump. */
function occurrences(value: unknown): number | undefined {
  if (value === true) return 1;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return undefined;
}

/**
 * Run-scoped totals, created once per run and mutated in place.
 *
 * ⚠️ `implementerRetries` is RETRIES, not attempts — it is `attempts − 1`.
 * Bump it ONCE PER RETRY and NEVER for an issue's first implementer pass.
 * Bumping on every attempt would turn 18 first passes into 18 phantom retries
 * and invert the very headline number this module exists to produce ("6 of 18
 * issues needed a second implementer pass"). The per-issue
 * {@link IssueTelemetryBag.noteImplementerAttempt} takes the ORDINAL; this
 * takes the retry event. They are not the same call.
 */
export class RunCounters {
  readonly #counters = new Map<RunCounterKey, number>();
  readonly #skillMisses = new Map<string, number>();
  readonly #errorClasses = new Map<RunErrorClassKey, number>();

  /**
   * Add `by` (default 1) to one of the six known counters. An unknown key or an
   * unusable amount is dropped silently — a bad bump loses one data point,
   * where a throw would lose the whole run.
   */
  bump(key: RunCounterKey, by = 1): void {
    if (typeof key !== "string" || !RUN_COUNTER_KEY_SET.has(key)) return;
    const amount = occurrences(by);
    if (amount === undefined) return;
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + amount);
  }

  /**
   * Record that `role` skipped a mandated skill `count` times (default 1).
   *
   * `role` is the ONLY caller value in this module that becomes an object key,
   * so it is gated on `typeof role === "string"` and NEVER coerced: `String(x)`
   * on a symbol, or template interpolation of an object with a throwing
   * `toString`, both throw.
   *
   * `count: 0` is legitimate and materialises `role: 0` — that is a role
   * MEASURED at zero misses, which is deliberately distinguishable from a role
   * that was never checked (absent).
   */
  noteSkillMiss(role: string, count = 1): void {
    if (typeof role !== "string" || role.length === 0) return;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return;
    const prior = this.#skillMisses.get(role) ?? 0;
    this.#skillMisses.set(role, prior + Math.round(count));
  }

  /**
   * Fold one dispatch's failure classification in. Unknown properties and
   * unusable values are ignored, and a `false`/absent member leaves its bucket
   * ABSENT rather than writing a `0` that would claim "measured, never
   * happened".
   *
   * All four buckets have a producer: the pipeline's error handler classifies
   * one dispatch failure and passes all four verdicts here in a single call
   * (`main.mts:6220-6225`), including `outputCap`, which used to be computed
   * and then dropped.
   */
  noteErrorClass(input: ErrorClassInput): void {
    if (typeof input !== "object" || input === null) return;
    for (const key of ERROR_CLASS_KEYS) {
      const amount = occurrences((input as Record<string, unknown>)[key]);
      if (amount === undefined) continue;
      this.#errorClasses.set(key, (this.#errorClasses.get(key) ?? 0) + amount);
    }
  }

  /**
   * The `counters` / `errorClasses` fields of {@link RunTelemetry}, freshly
   * built each call. Each sub-object is emitted only when it has content:
   * `{counters: {}}` would assert "measured, all zero", which is a different
   * claim from "not instrumented".
   */
  toRunTelemetry(): RunCountersTelemetry {
    const out: RunCountersTelemetry = {};

    const counters: NonNullable<RunTelemetry["counters"]> = {};
    let hasCounters = false;
    for (const key of RUN_COUNTER_KEYS) {
      const value = this.#counters.get(key);
      if (value === undefined) continue;
      counters[key] = value;
      hasCounters = true;
    }
    if (this.#skillMisses.size > 0) {
      const misses: Record<string, number> = {};
      for (const [role, count] of this.#skillMisses) misses[role] = count;
      counters.skillDisciplineMisses = misses;
      hasCounters = true;
    }
    if (hasCounters) out.counters = counters;

    if (this.#errorClasses.size > 0) {
      const errorClasses: NonNullable<RunTelemetry["errorClasses"]> = {};
      for (const key of ERROR_CLASS_KEYS) {
        const value = this.#errorClasses.get(key);
        if (value !== undefined) errorClasses[key] = value;
      }
      out.errorClasses = errorClasses;
    }

    return out;
  }
}
