/**
 * The retry budget (spec #1334, SC) — replaces the #1178 auto-requeue sweep.
 *
 * A ticket the loop failed on is retried on later runs until it has spent
 * {@link RETRY_BUDGET_USD} in total, or after {@link RETRY_MAX_ATTEMPTS}
 * attempts, whichever comes first. Then it is labelled
 * {@link WAITING_FOR_SESSION_LABEL} and listed in the run report, so one
 * stubborn ticket cannot drain money night after night.
 *
 * Count, never sort (ADR 0015, "Rules for changing the loop"): the limits are
 * money and attempts. Each ledger line carries a short note saying how the
 * attempt ended, for a person reading the ticket — nothing branches on it.
 *
 * ## Where the spend lives, and why there
 *
 * In the issue BODY, inside a marker section this module owns — one line per
 * failed attempt, written by the failing process at the moment the attempt
 * ends. Not the telemetry store: `issues.jsonl` is committed on the RUN branch
 * (it reaches `main` only when that run's pull request merges), a ship-nothing
 * run never pushes it, and each host appends to its own checkout. The body is
 * visible to every host at once and is already fetched at run start.
 *
 * A ticket with no section has never been through this budget. That is what
 * makes the six acceptance tickets start fresh, and it is the manual reset
 * too: delete the section and the ticket has a fresh $100.
 *
 * ## Known floors (accepted, not bugs)
 *
 *  - The spend is a FLOOR. A process killed with SIGKILL records nothing for
 *    its in-flight tickets; an unpriced model's cost is unknown and counts $0.
 *  - The cap is checked AFTER an attempt, so one attempt can overshoot $100 —
 *    by at most that one attempt's cost.
 *
 * ## Fail closed
 *
 * A section the reader cannot parse — a start marker with no end, or an
 * attempt line whose amount is not a number — reads as `corrupt`, and a
 * corrupt ledger means WAITING, never "start again at $0". A hand-mangled
 * ledger must never reset the spend.
 *
 * Pure: no IO. The fetch and the `gh issue edit` live in `lib/state/gh.ts`
 * (`recordRetryAttempt`, `applyRetryDecision`).
 */

import { readMarkedSection, upsertMarkedSection } from "./body-sections.js";
import { STRANDED_PROMOTION_NO_REQUEUE_MARKER } from "./stop-reasons.js";

/** Total dollars one ticket may spend across every run. */
export const RETRY_BUDGET_USD = 100;

/** Attempts one ticket gets across every run before it waits for a session. */
export const RETRY_MAX_ATTEMPTS = 3;

/** The label a ticket gets when the loop stops retrying it. Not dispatchable:
 *  the planner only deals `ready-for-agent`, which this replaces. */
export const WAITING_FOR_SESSION_LABEL = "waiting-for-session";

/** The terminal label a retryable failure lands on — the literal one, never
 *  the `needs-human` alias: `needs-human` is the owner road, which this
 *  budget never touches. */
const QUARANTINE_LABEL = "quarantine";

export const RETRY_BUDGET_SECTION_START = "<!-- sandcastle:retry-budget:start -->";
export const RETRY_BUDGET_SECTION_END = "<!-- sandcastle:retry-budget:end -->";

/**
 * Wording an OLDER build of the loop wrote into a body whose work must not be
 * thrown away by a plain re-queue, before {@link STRANDED_PROMOTION_NO_REQUEUE_MARKER}
 * existed. Add to this list, never remove — old bodies never change.
 */
const LEGACY_NO_REQUEUE_PHRASES: readonly string[] = ["NOT a plain re-queue"];

/** One failed attempt, as recorded on the ticket. */
export interface RetryAttempt {
  readonly whenIso: string;
  readonly runId: string;
  readonly host: string;
  /** Dollars this attempt cost; `null` when every model was unpriced. */
  readonly costUsd: number | null;
  /** How the attempt ended, for a person reading the ticket: the stop label,
   *  else `unlabelled:<marker or status>`. Free text, never compared: the
   *  budget counts money and attempts only (ADR 0015, "count, never sort").
   *  The parser accepts any text here because that costs nothing and a
   *  person may hand-edit the ledger; the only lines that ever carried a
   *  failure category were written by runs of this same branch before the
   *  category comparison was removed, never by a run of `main`. */
  readonly note: string;
}

export type RetryLedgerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt" }
  | { readonly kind: "ok"; readonly attempts: readonly RetryAttempt[] };

export type RetryDecision =
  | { readonly action: "skip" }
  | { readonly action: "retry"; readonly spentUsd: number }
  | { readonly action: "waiting"; readonly reason: "unreadable" }
  | { readonly action: "waiting"; readonly reason: "saved-work" }
  | { readonly action: "waiting"; readonly reason: "budget-spent"; readonly spentUsd: number }
  | { readonly action: "waiting"; readonly reason: "attempts-spent"; readonly attempts: number };

const SEP = " · ";
const ATTEMPT_LINE_RE =
  /^- (\S+) · run (.+?) · host (.+?) · \$(\d+(?:\.\d+)?|unknown) · (.+)$/;

const roundCents = (n: number): number => Math.round(n * 100) / 100;

function formatUsd(n: number | null): string {
  return n === null ? "$unknown" : `$${n.toFixed(2)}`;
}

function spentOf(attempts: readonly RetryAttempt[]): number {
  return roundCents(attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0));
}

/** Read the ledger back out of a body — three-way, see the module doc. */
export function readRetryLedger(body: string): RetryLedgerRead {
  const hasStart = body.includes(RETRY_BUDGET_SECTION_START);
  const section = readMarkedSection(body, RETRY_BUDGET_SECTION_START, RETRY_BUDGET_SECTION_END);
  if (section === undefined) return hasStart ? { kind: "corrupt" } : { kind: "absent" };
  const attempts: RetryAttempt[] = [];
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const m = ATTEMPT_LINE_RE.exec(line);
    if (m === null) return { kind: "corrupt" };
    attempts.push({
      whenIso: m[1]!,
      runId: m[2]!,
      host: m[3]!,
      costUsd: m[4] === "unknown" ? null : Number(m[4]),
      note: m[5]!,
    });
  }
  return { kind: "ok", attempts };
}

/** Why the attempts alone end retries, or `undefined` when they do not. */
function exhaustedBy(
  attempts: readonly RetryAttempt[],
):
  | { readonly reason: "budget-spent"; readonly spentUsd: number }
  | { readonly reason: "attempts-spent"; readonly attempts: number }
  | undefined {
  const spentUsd = spentOf(attempts);
  if (spentUsd >= RETRY_BUDGET_USD) return { reason: "budget-spent", spentUsd };
  if (attempts.length >= RETRY_MAX_ATTEMPTS)
    return { reason: "attempts-spent", attempts: attempts.length };
  return undefined;
}

function renderSection(attempts: readonly RetryAttempt[]): string {
  const spentUsd = spentOf(attempts);
  const lines = [
    "## Retry budget",
    "",
    ...attempts.map(
      (a) =>
        `- ${a.whenIso}${SEP}run ${a.runId}${SEP}host ${a.host}${SEP}` +
        `${formatUsd(a.costUsd)}${SEP}${a.note}`,
    ),
    "",
    `**Spent:** ${formatUsd(spentUsd)} of $${RETRY_BUDGET_USD}`,
  ];
  const done = exhaustedBy(attempts);
  if (done !== undefined) {
    lines.push(
      "",
      `The loop has stopped retrying this ticket (\`${WAITING_FOR_SESSION_LABEL}\`): ` +
        (done.reason === "budget-spent"
          ? `it has spent ${formatUsd(done.spentUsd)} of its $${RETRY_BUDGET_USD}.`
          : `it has been tried ${done.attempts} times.`) +
        " Hand it to a session. Deleting this section gives it a fresh budget.",
    );
  } else {
    lines.push(
      "",
      `The loop retries this ticket on its next run, until it has spent ` +
        `$${RETRY_BUDGET_USD} in total or has been tried ${RETRY_MAX_ATTEMPTS} times.`,
    );
  }
  return lines.join("\n");
}

/**
 * Append one attempt to the ledger, creating the section when absent and
 * leaving everything outside it untouched. A corrupt ledger is replaced by
 * one holding only the new line — the caller must already have decided not
 * to retry a corrupt ledger (see {@link decideRetry}); this keeps the write
 * from failing, never from resetting a decision.
 */
export function appendRetryAttempt(body: string, attempt: RetryAttempt): string {
  const read = readRetryLedger(body);
  const prior = read.kind === "ok" ? read.attempts : [];
  return upsertMarkedSection(
    body,
    RETRY_BUDGET_SECTION_START,
    RETRY_BUDGET_SECTION_END,
    renderSection([...prior, attempt]),
  );
}

/**
 * Decide what to do with one ticket, from its labels and body as they stand.
 *
 *  - `skip` — not on literal `quarantine`, already waiting, or no ledger (a
 *    stop from before this budget existed is never touched).
 *  - `waiting` — the ledger is unreadable, the body says its work is saved
 *    and must not be thrown away, $100 is spent, or it has had three attempts.
 *  - `retry` — otherwise.
 */
export function decideRetry(input: {
  readonly labels: readonly string[];
  readonly body: string;
}): RetryDecision {
  if (!input.labels.includes(QUARANTINE_LABEL)) return { action: "skip" };
  if (input.labels.includes(WAITING_FOR_SESSION_LABEL)) return { action: "skip" };
  const read = readRetryLedger(input.body);
  if (read.kind === "absent") return { action: "skip" };
  if (read.kind === "corrupt") return { action: "waiting", reason: "unreadable" };
  if (
    input.body.includes(STRANDED_PROMOTION_NO_REQUEUE_MARKER) ||
    LEGACY_NO_REQUEUE_PHRASES.some((p) => input.body.includes(p))
  ) {
    return { action: "waiting", reason: "saved-work" };
  }
  const done = exhaustedBy(read.attempts);
  if (done !== undefined) return { action: "waiting", ...done };
  return { action: "retry", spentUsd: spentOf(read.attempts) };
}

/** One plain sentence saying why a ticket is waiting — the run report's line. */
export function waitingNote(decision: Extract<RetryDecision, { action: "waiting" }>): string {
  switch (decision.reason) {
    case "budget-spent":
      return `retry budget spent (${formatUsd(decision.spentUsd)} of $${RETRY_BUDGET_USD}) — hand it to a session`;
    case "attempts-spent":
      return `tried ${decision.attempts} times without shipping — hand it to a session`;
    case "saved-work":
      return "its finished work is saved and a plain retry would throw it away — hand it to a session";
    case "unreadable":
      return "its retry record on the ticket could not be read — hand it to a session";
  }
}

/**
 * Spec #1334 SC — a recorder for one failed attempt on a ticket's retry
 * budget, holding only the "already recorded" set itself; every other piece
 * of run state comes in through `opts`.
 *
 * Skips on a dry run, on a stop that went to the owner (`needs-human`: the
 * owner road never spends from the budget), and on a second call for the same
 * ticket (one ledger line per ticket per recorder). The note is the stop
 * label the attempt applied, else `unlabelled:<marker or status>` — for a
 * person reading the ledger only; the budget counts attempts and dollars,
 * never notes. Best-effort: a failed write is logged and never throws.
 */
export function createFailedAttemptRecorder(opts: {
  readonly dryRun: boolean;
  /** True when this ticket's stop went to the owner this run. */
  readonly wentToOwner: (issueNumber: number) => boolean;
  /** This attempt's cost so far; `null` when nothing was priced. */
  readonly costUsd: (issueNumber: number) => number | null;
  /** The stop label this attempt applied, if any. */
  readonly stopLabel: (issueNumber: number) => string | undefined;
  readonly runId: string;
  readonly host: () => string;
  readonly now: () => Date;
  /** The ticket write; `undefined` when there is nothing to write to. */
  readonly record: (
    issueNumber: number,
    attempt: RetryAttempt,
  ) => Promise<{ readonly decision: RetryDecision }> | undefined;
  /** Called when the write moved the ticket to `waiting-for-session`. */
  readonly onWaiting: (issueNumber: number, why: string) => void;
  readonly logError: (line: string) => void;
}): (issueNumber: number, finalMarker: string | undefined, status: string) => Promise<void> {
  const recorded = new Set<number>();
  return async (issueNumber, finalMarker, status) => {
    if (opts.dryRun) return;
    if (opts.wentToOwner(issueNumber)) return;
    if (recorded.has(issueNumber)) return;
    recorded.add(issueNumber);
    const costUsd = opts.costUsd(issueNumber);
    const note =
      opts.stopLabel(issueNumber) ??
      `unlabelled:${finalMarker !== undefined && finalMarker !== "" ? finalMarker : status}`;
    try {
      const result = await opts.record(issueNumber, {
        whenIso: opts.now().toISOString(),
        runId: opts.runId,
        host: opts.host(),
        costUsd,
        note,
      });
      const decision = result?.decision;
      if (decision?.action === "waiting") opts.onWaiting(issueNumber, waitingNote(decision));
    } catch (err) {
      opts.logError(
        `[issue=${issueNumber}] retry budget: recording this attempt failed — ` +
          `${(err as Error).message}`,
      );
    }
  };
}
