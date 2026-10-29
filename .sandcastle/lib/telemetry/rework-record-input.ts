/**
 * The PURE half of "what does one rework-store line say about this issue?".
 *
 * This lived inside a `runMain` closure in `main.mts`, which made it
 * unreachable from any unit test — so the invariants it carries (retries are
 * `attempts − 1`; absent ≠ zero; a `sawTiming`-less row must NOT report a
 * measured `wallMs` of 0) were "tested" by grepping main.mts for the literal
 * source text of each expression. A grep for `retries: Math.max(0, attempts -
 * 1)` pins the LITERAL, not the invariant: it stays green if
 * `implementerAttempts` changes meaning upstream, which is the exact inversion
 * the grep's own comment claimed to prevent.
 *
 * Everything that needs the world — the dedup set, `--dry-run`, the store
 * write, the missing-sha log — stays at the call site. Everything here is a
 * function of its arguments, so the assertions in the colocated test are about
 * the RECORD, not about main.mts's source text.
 */
import type { IssueTelemetryRow } from "../status/schema.js";
import type { IssueTelemetryBagRow } from "./issue-bag.js";
import type { ReworkOutcome, ReworkRecordInput } from "./rework-store.js";

/**
 * The issue statuses that produce a record. `"deferred"` is deliberately
 * ABSENT rather than handled: a deferred issue goes back to `ready-for-agent`
 * and is re-planned by the next iteration, so recording it would both
 * double-count the issue and score work that never shipped. Encoding that in
 * the type means the caller's `if (status === "deferred") return;` is a
 * compile-time precondition of this function, not a convention.
 */
export type RecordableIssueStatus = "ok" | "quarantined" | "error";

/** Everything one record is built from. `shippedSha` is REQUIRED here for the
 *  same reason it is required in the store: it is the point in history a reader
 *  walks forward from, so a record without one cannot be scored at all. The
 *  caller drops (and logs) the sha-less outcomes before reaching this. */
export interface ReworkRecordInputSources {
  readonly issueNumber: number;
  readonly status: RecordableIssueStatus;
  readonly shippedSha: string;
  readonly runId: string;
  readonly hostId: string;
  readonly shippedAtIso: string;
  readonly bagRow?: IssueTelemetryBagRow;
  readonly ledgerRow?: IssueTelemetryRow;
  readonly models?: ReworkRecordInput["models"];
}

/** Substituted for an empty `runId`/`hostId`. Both are `z.string().min(1)` in
 *  the store, so an empty one does not blur a grouping key — it DROPS the whole
 *  record through `onError` into a log nobody reads. A mislabelled group loses
 *  one dimension; a dropped record loses everything, so the record wins. */
const UNKNOWN_RUN_ID = "unknown-run";
const UNKNOWN_HOST_ID = "unknown-host";

/** Terminal status → the store's outcome vocabulary. `"error"` means the
 *  pipeline could not even quarantine the issue, so it is parked for a person:
 *  same destination as a quarantine, different route. */
function outcomeFor(status: RecordableIssueStatus): ReworkOutcome {
  if (status === "ok") return "shipped";
  if (status === "quarantined") return "quarantined";
  return "needs-human";
}

/**
 * `IssueLedger.rows()` FOLDS its internal `sawTiming` away — `wallMs` is always
 * a number there, so a row that never saw a timing sample reports a measured
 * `0`. `costUsd` keeps its three-state null through the same fold; `wallMs`
 * does not, so the distinction has to be recovered here. `perRole` is where it
 * survives: `rows()` spreads `wallMs`/`runs` into a role's entry ONLY when that
 * role saw timing, so "no role has a wallMs" is exactly "timing never landed".
 * Checking `wallMs > 0` instead would be wrong in the other direction — a
 * genuinely 0ms measurement is a measurement.
 */
function sawTiming(row: IssueTelemetryRow | undefined): boolean {
  return (
    row !== undefined &&
    Object.values(row.perRole ?? {}).some((r) => r.wallMs !== undefined)
  );
}

/**
 * Build the one line this issue contributes to the rework store.
 *
 * Every measured field is spread CONDITIONALLY. That is not stylistic: the
 * store's whole premise is that "not instrumented" stays distinguishable from
 * "measured, and it was zero" (`rework-store.ts:120-121`), and a written `0` or
 * `false` is a claim that a measurement was taken.
 */
export function buildReworkRecordInput(
  src: ReworkRecordInputSources,
): ReworkRecordInput {
  const { bagRow, ledgerRow } = src;
  // RETRIES, not attempts: `attempts - 1`. An issue that shipped on its first
  // implementer pass has 0 retries, and an issue whose attempts were never
  // recorded has UNKNOWN retries — which must stay absent, not 0. Recording
  // attempts here would turn 18 clean first passes into 18 phantom retries and
  // invert the headline number the whole store exists to produce.
  const attempts = bagRow?.implementerAttempts;
  return {
    issueNumber: src.issueNumber,
    runId: src.runId || UNKNOWN_RUN_ID,
    hostId: src.hostId || UNKNOWN_HOST_ID,
    shippedAtIso: src.shippedAtIso,
    shippedSha: src.shippedSha,
    // Copied, not aliased: the caller's bag row is live for the rest of the run
    // and the store serialises lazily, so sharing the array would let a later
    // mutation rewrite an already-"recorded" fact.
    ...(bagRow?.changedFilePaths !== undefined
      ? { changedFilePaths: [...bagRow.changedFilePaths] }
      : {}),
    ...(bagRow?.changedFiles !== undefined
      ? { changedFiles: bagRow.changedFiles }
      : {}),
    ...(bagRow?.changedLines !== undefined
      ? { changedLines: bagRow.changedLines }
      : {}),
    ...(ledgerRow !== undefined ? { costUsd: ledgerRow.costUsd } : {}),
    ...(sawTiming(ledgerRow) && ledgerRow !== undefined
      ? { wallMs: ledgerRow.wallMs }
      : {}),
    // Per-role cost/token/wall-time split (issue #911, "Instrument this
    // first"): the durable answer to "what did the check-writer pass alone
    // cost", which `costUsd`/`wallMs` above — a single total — cannot
    // answer on their own. Copied straight through from the ledger row;
    // `buildReworkRecordInput` never re-derives it.
    ...(ledgerRow?.perRole !== undefined ? { perRole: ledgerRow.perRole } : {}),
    ...(attempts !== undefined ? { retries: Math.max(0, attempts - 1) } : {}),
    // The protected-path lock's tamper count (issue #909 / Piece C) — copied
    // straight through, unlike `retries` above: it is already a COUNT of
    // incidents, not an ordinal that needs a `- 1`.
    ...(bagRow?.checksTamperCount !== undefined
      ? { checksTamperCount: bagRow.checksTamperCount }
      : {}),
    // Conditional on the BAG's existence, not on the value: with no bag there
    // is no measurement, and writing `quarantined: false` would assert one —
    // and could emit `outcome: "quarantined"` beside `quarantined: false`.
    // Keyed on the bag rather than on `=== true` so a bag that really says
    // `false` still records that fact.
    ...(bagRow !== undefined
      ? { quarantined: bagRow.quarantined === true }
      : {}),
    ...(src.models !== undefined ? { models: src.models } : {}),
    // The CLAIMED half of the screen-check record (issue #886) — the
    // implementer's own report card on whether a screen check was required
    // and whether it ran one. Copied straight through, by VALUE, exactly
    // like `screenCheck` below: a fresh object, never the bag row's own
    // reference, so a later mutation of the caller's bag row cannot rewrite
    // an already-built record.
    //
    // MUST stay a SEPARATE field from `screenCheck` — never merged, never
    // derived from it. That separation is the entire point of Piece K:
    // "a claim and an observation that merge into one field are
    // indistinguishable afterwards, which is the failure this whole design
    // exists to remove." Before this, only the OBSERVED half (`screenCheck`)
    // reached this durable, git-tracked file — the CLAIMED half reached
    // only the ephemeral, gitignored `status.json` (which does not even
    // exist on disk between runs), so the comparison Piece K exists to make
    // possible (does the robot's claim match what the harness actually
    // observed?) was impossible in practice. Fixed here, alongside
    // `screenCheck`, not instead of it.
    ...(bagRow?.implementerCertification !== undefined
      ? { implementerCertification: { ...bagRow.implementerCertification } }
      : {}),
    // The OBSERVED half of the screen-check record (issue #912, Piece K).
    // Copied straight through from the bag row, like `checksTamperCount`
    // above — this is the field the design doc's "the guarantee is carried
    // by this [file], not by the picture" sentence is actually about, so it
    // MUST reach this durable store, not only the ephemeral `status.json`.
    ...(bagRow?.screenCheck !== undefined
      ? { screenCheck: { ...bagRow.screenCheck } }
      : {}),
    // Which of the five ways this ticket stopped (issue #914, Piece H).
    // Copied by value, like `screenCheck` immediately above, one level
    // deeper for `disagreement` — a later mutation of the caller's bag row
    // must not be able to rewrite an already-built record.
    ...(bagRow?.stopReason !== undefined
      ? {
          stopReason: {
            ...bagRow.stopReason,
            ...(bagRow.stopReason.disagreement !== undefined
              ? { disagreement: { ...bagRow.stopReason.disagreement } }
              : {}),
          },
        }
      : {}),
    outcome: outcomeFor(src.status),
  };
}
