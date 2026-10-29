/**
 * One end-of-run report, in the owner's plain English (issue #1179).
 *
 * Before this existed, the owner had to assemble "what happened last night"
 * himself, ticket by ticket, from `stopped:*` labels — mechanism names that
 * mean nothing without reading this file's own vocabulary first. This module
 * builds ONE report, in the order he reads it:
 *
 *   1. The headline — literally `Nothing needs you.` when nothing does,
 *      otherwise `Needs you:`; then three numbers (spec #1334, see
 *      {@link runReportNumbers}): dollars per shipped ticket, tickets waiting
 *      for a session, tickets that reached the owner; then the shortest list
 *      of actions only a person can take (run-health warnings included).
 *   2. What shipped — one line per ticket; then the ships that had no first
 *      test, and every edit to an older ticket's test.
 *   3. What stopped — grouped by cause CLASS in plain English, never a bare
 *      `stopped:*` label.
 *   4. Tickets waiting for a session — every open one, not only this run's.
 *   5. What the loop re-queued itself under its retry budget —
 *      informational only, never an action for the owner.
 *
 * Separately, {@link formatTicketEventLine} writes the one fixed-format run
 * log line per ship, stop or crash (`grep -E '^TICKET #'`).
 *
 * Pure and total: `buildRunReport` never throws and never touches the
 * network or the filesystem. Every side effect (reading the rework store,
 * writing the PR body) lives in `main.mts` / `lib/state/gh.ts`, which build
 * this input and then render/log the result best-effort.
 *
 * **Never call a ticket "needs you" from a label alone.** The SAME
 * `quarantine` label covers a routine, fully automatic disposal
 * (`stopped:run-fault`, `stopped:reviewer-refused`, …) that the retry budget
 * will try again, and `needs-human` is picked by `quarantineTerminalLabel`
 * from the stop label AND the call's own `{ handoff: true }` option, so the
 * stop label alone cannot answer it. The caller is therefore the one that decides
 * `needsYou` per stopped ticket. **It must NOT read this off the durable
 * rework record's `outcome` field** — `outcomeFor` in
 * `lib/telemetry/rework-record-input.ts` maps EVERY quarantined issue's
 * status to the literal outcome `"quarantined"`, never `"needs-human"`, so
 * that field can never actually distinguish them (issue #1179 review,
 * blocker 1: the whole "needs you" arm for quarantines was dead code as a
 * result). The caller instead derives it from the SAME rule
 * `quarantineTerminalLabel` (`lib/state/gh.ts`) used to pick the real
 * GitHub label — `opts.handoff === true`, or `opts.stopLabel` is in
 * `OWNER_DECISION_STOP_REASONS` — read at the one place every quarantine
 * call passes through, so it can never drift from what actually landed on
 * the ticket.
 */

import { STOP_LABEL_DEFINITIONS } from "./stop-reasons.js";

/**
 * Markers for the run-report block inside a run PR's body — the stable
 * home a relaunch UPDATES rather than duplicates (see `upsertRunPrReport`
 * in `lib/state/gh.ts`).
 *
 * **Per-HOST since the multi-host review fix (issue #1179 blocker 4).** A
 * single shared marker meant the last host to finish a shared run OVERWROTE
 * every other host's section — host B's clean "Nothing needs you." replaced
 * host A's "Needs you: #42 …" with no trace it ever existed. Each host now
 * upserts its OWN block, keyed by `hostId`, so a run PR carries one section
 * per host and nobody's warnings are silently clobbered by a peer.
 */
export function runReportSectionStart(hostId: string): string {
  return `<!-- sandcastle:run-report:${hostId}:start -->`;
}
export function runReportSectionEnd(hostId: string): string {
  return `<!-- sandcastle:run-report:${hostId}:end -->`;
}

/**
 * Prefix one host's report with a plain heading naming which host it came
 * from — the PR body can carry several of these (one per host on a shared
 * run), and each section has to say whose it is.
 */
export function titleRunReport(report: string, hostId: string): string {
  return `# Report from ${hostId}\n\n${report}`;
}

/** One ticket, as plainly as the report can name it. `title` is best-effort
 *  — omitted when the caller never had it (e.g. a ticket the loop never
 *  claimed a plan entry for this run). */
export interface RunReportTicket {
  readonly number: number;
  readonly title?: string;
  /**
   * Extra plain-English context appended after this ticket's line, rendered
   * by {@link ticketLine}. Two callers set it today: a ticket that shipped
   * and then failed to land (issue #1179 review, blocker 3b) and a ticket
   * that shipped without a first test (#1198 A) — both cases where the bare
   * `#N title` line would tell the owner something true but misleading.
   *
   * Declared HERE rather than only on {@link RunReportStop} because
   * `ticketLine` already reads it duck-typed off any ticket, so the SHIPPED
   * list could carry one and the type could not say so.
   */
  readonly note?: string;
  /**
   * Set on a SHIPPED ticket that reached the builder with no first test
   * behind it (#1198 A) — it rests on the reviewer's pass alone. Lists the
   * ticket under "Shipped without a first test" (spec #1334).
   */
  readonly noFirstTest?: boolean;
}

/**
 * One edit a shipped ticket made to an OLDER ticket's test (spec #1334 SH:
 * the `olderTestEditRecord` record). Listed so the owner can see every
 * place the loop moved the goalposts another ticket set.
 */
export interface RunReportOlderTestEdit {
  /** The ticket that shipped the edit. */
  readonly byIssue: number;
  readonly byTitle?: string;
  /** The ticket whose test was edited. */
  readonly olderIssue: number;
  readonly path: string;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** The shipping ticket's claim-time body contained this exact path. Display
   *  only — an unnamed edit is shown for the owner's review, never refused. */
  readonly namedInTicket: boolean;
}

/** One STOPPED ticket. `label` drives the plain-English cause class this
 *  ticket is grouped under (see {@link causeHeadingFor}); absent or
 *  unrecognised labels fall back to a safe generic class rather than
 *  leaking a raw `stopped:*` string. `needsYou` is the caller's own
 *  determination (see the module doc comment) — this module never derives
 *  it from `label` itself. */
export interface RunReportStop extends RunReportTicket {
  readonly label?: string;
  readonly needsYou?: boolean;
  /** See {@link RunReportTicket.note} — declared on the parent since #1198 A,
   *  because the SHIPPED list carries one too. Restated here only so a reader
   *  of this interface sees the field a stop entry most often sets. */
  readonly note?: string;
}

export interface RunReportInput {
  readonly runId: string;
  readonly branch: string;
  /** Tickets the loop certified and closes via this run's PR. A `note` here
   *  (#1198 A) says this one shipped on the reviewer's pass alone, with no
   *  first test behind it. */
  readonly shipped: readonly RunReportTicket[];
  /** Tickets this run quarantined (terminal — parked for later, whether or
   *  not a person is actually needed; see `needsYou` on each entry). */
  readonly quarantined: readonly RunReportStop[];
  /** Tickets the pipeline could not even QUARANTINE — the loudest failure a
   *  run can produce, because not even the routine "park it" path landed.
   *  Always a real owner action; rendered at the very top of "Needs you"
   *  (issue #1179 review, blocker 1). */
  readonly errored: readonly RunReportTicket[];
  /** Tickets released back to `ready-for-agent` for an automatic retry —
   *  not a stop, never an action, and grouped under its own quiet class. */
  readonly deferred: readonly RunReportTicket[];
  /** Issues carrying `shipped-local` from an INTERRUPTED prior run whose
   *  code presence on this branch could not be verified — always a real
   *  owner action (verify by hand), regardless of any label. */
  readonly previouslyShipped: readonly RunReportTicket[];
  /** Set when the run ended on the circuit breaker rather than finishing.
   *  `plain` is the sentence the headline reads ("3 quarantines in a row");
   *  `detail` is the exact counter/limit/CLI-flag text, rendered in
   *  parentheses rather than inline — the flag spelling is jargon nobody
   *  reading "what needs me" should have to parse first (issue #1179
   *  review, deferable 5). */
  readonly breakerTrip?: { readonly plain: string; readonly detail: string };
  /** Set when a final promotion failed during this run. */
  readonly promotionFailed?: boolean;
  /** Tickets the retry budget (spec #1334 SC) put back on
   *  `ready-for-agent` at this run's start — informational only. */
  readonly requeued: readonly RunReportTicket[];
  /** Tickets the retry budget moved to `waiting-for-session` THIS run, each
   *  with a `note` saying why in one sentence ($100 spent, three attempts,
   *  saved work, an unreadable ledger). A real hand-off: the loop has
   *  stopped retrying, so a session has to finish it. */
  readonly waiting: readonly RunReportTicket[];
  /** Every OTHER open ticket labelled `waiting-for-session` — ones parked by
   *  an earlier run (or a peer host). Together with `waiting` this is the
   *  STANDING count, so retries across runs can never hide a pile-up. */
  readonly alreadyWaiting: readonly RunReportTicket[];
  /** The whole run's priced spend, every role included. `partial` is true
   *  when some model had no price, so the real figure is higher. */
  readonly runCost: { readonly totalUsd: number; readonly partial: boolean };
  /** Every older-ticket test edit that shipped this run. */
  readonly olderTestEdits: readonly RunReportOlderTestEdit[];
  /** Set when the run's pull request was left waiting for the owner, for ANY
   *  reason — too large to merge itself, an edit to a migration already on
   *  main, a migration that deletes or rewrites existing data, a failed check
   *  or pre-merge check. `reasons` says why, in the merge rule's own words.
   *  Counts ONCE toward "reached you", however many reasons hold it. */
  readonly heldRun?: { readonly reasons: readonly string[] };
}

/** The three numbers the report's headline leads with (spec #1334). */
export interface RunReportNumbers {
  /** Whole-run spend ÷ tickets shipped, to the cent; `null` when none shipped. */
  readonly dollarsPerShipped: number | null;
  readonly totalUsd: number;
  readonly costPartial: boolean;
  /** Distinct open tickets waiting for a session (standing, not this run's). */
  readonly waiting: number;
  /**
   * Tickets that reached the owner: a stop that landed `needs-human` (after
   * spec #1334 only `stopped:ticket-unclear` does), plus ONE for the run when
   * its pull request was left waiting for him, whatever held it. Run-health warnings
   * (a breaker trip, a failed promotion, an unverified earlier ship, a ticket
   * the loop could not even quarantine) stay in the headline but are not
   * counted: they are the loop's faults, not tickets handed to the owner.
   */
  readonly reachedOwner: number;
}

const roundCents = (n: number): number => Math.round(n * 100) / 100;

export function runReportNumbers(input: RunReportInput): RunReportNumbers {
  const shipped = input.shipped.length;
  const waiting = new Set([
    ...input.waiting.map((t) => t.number),
    ...input.alreadyWaiting.map((t) => t.number),
  ]).size;
  const ownerStops = new Set(
    input.quarantined.filter((q) => q.needsYou === true).map((q) => q.number),
  ).size;
  return {
    dollarsPerShipped: shipped === 0 ? null : roundCents(input.runCost.totalUsd / shipped),
    totalUsd: input.runCost.totalUsd,
    costPartial: input.runCost.partial,
    waiting,
    reachedOwner: ownerStops + (input.heldRun !== undefined ? 1 : 0),
  };
}

/** The outcomes a ticket can end a run on, for the event line.
 *  `closed-already-built`: the reviewer confirmed the ticket's change was
 *  already in the code, so nothing was built and the ticket was closed. */
export type TicketEvent = "shipped" | "stopped" | "crashed" | "closed-already-built";

/**
 * One fixed-format line per ship, stop or crash, written to the run log so a
 * whole night's outcomes come back from ONE grep:
 *
 *     grep -E '^TICKET #' .sandcastle/run.log
 *
 * (or match {@link TICKET_EVENT_LINE_RE}). Format, every field always present,
 * fixed order, no free text:
 *
 *     TICKET #<n> <shipped|stopped|crashed|closed-already-built> label=<stop label or -> cost=<$x.xx or n/a>
 *
 * `cost` is this run's spend on the ticket. `shipped` is written when the run
 * actually LANDS the ticket on its branch, never when the reviewer certifies
 * it, so a ticket that passes review and then fails to land logs only
 * `stopped` — one ticket never logs both. A ticket deferred for an automatic
 * retry inside the run logs nothing.
 */
export function formatTicketEventLine(i: {
  readonly issueNumber: number;
  readonly event: TicketEvent;
  readonly label?: string;
  readonly costUsd?: number | null;
}): string {
  const label =
    i.label !== undefined && i.label.trim() !== "" ? i.label.trim().replace(/\s+/g, "_") : "-";
  const cost =
    typeof i.costUsd === "number" && Number.isFinite(i.costUsd)
      ? `$${roundCents(i.costUsd).toFixed(2)}`
      : "n/a";
  return `TICKET #${i.issueNumber} ${i.event} label=${label} cost=${cost}`;
}

/** Matches every line {@link formatTicketEventLine} writes, and nothing else. */
export const TICKET_EVENT_LINE_RE =
  /^TICKET #(\d+) (shipped|stopped|crashed|closed-already-built) label=(\S+) cost=(\$\d+\.\d{2}|n\/a)$/;

const usd = (n: number): string => `$${n.toFixed(2)}`;

function numberLines(n: RunReportNumbers, shipped: number): string[] {
  const caveat = n.costPartial ? " — some models have no price, so the real figure is higher" : "";
  const perShipped =
    n.dollarsPerShipped === null
      ? `n/a — nothing shipped (${usd(n.totalUsd)} spent)`
      : `${usd(n.dollarsPerShipped)} (${usd(n.totalUsd)} spent ÷ ${shipped} shipped)`;
  return [
    `- Dollars per shipped ticket: ${perShipped}${caveat}`,
    `- Waiting for a session: ${n.waiting}`,
    `- Reached you: ${n.reachedOwner}`,
  ];
}

/**
 * The note on a SHIPPED ticket's line: each fact the owner's end-of-run
 * review should read first, in its own bracket — no first test (#1198 A),
 * then the approving reviewer's structure finding and its reason the first
 * test is weak (`lib/review/review-notes.ts`). `undefined` when there is
 * nothing to say, so an ordinary merge stays a bare line.
 */
export function shippedTicketNote(facts: {
  readonly noFirstTest: boolean;
  readonly structureFinding?: string;
  readonly weakFirstTest?: string;
}): string | undefined {
  const parts = [
    ...(facts.noFirstTest ? ["(no first test — reviewer's pass alone)"] : []),
    ...(facts.structureFinding !== undefined
      ? [`(structure finding: ${facts.structureFinding})`]
      : []),
    ...(facts.weakFirstTest !== undefined
      ? [`(weak first test: ${facts.weakFirstTest})`]
      : []),
  ];
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Render one ticket as `#N title` (or bare `#N` when no title is known),
 * with its `note` ({@link RunReportTicket.note}) appended when present. One
 * function covers the plain deferred/shipped lists and the richer stop
 * entries alike, so a note can never render on one list and vanish on
 * another.
 */
function ticketLine(t: RunReportTicket): string {
  const base = t.title && t.title.trim().length > 0 ? `#${t.number} ${t.title}` : `#${t.number}`;
  const note = t.note;
  if (!note) return base;
  // A note that BRACKETS ITSELF joins with a space, not a dash. A note
  // containing its own dash — `(no first test — reviewer's pass alone)` —
  // would otherwise render two dashes on one line, and a reader cannot tell
  // which of them separates the ticket from its note. The brackets already
  // do that job, so the dash is noise (#1198 review).
  return note.startsWith("(") ? `${base} ${note}` : `${base} — ${note}`;
}

/**
 * The plain-English cause class for one stop label — reused verbatim from
 * {@link STOP_LABEL_DEFINITIONS}, the SAME vocabulary the GitHub label
 * descriptions use, so this report can never say something different from
 * what a person reading the label on the ticket itself would see.
 *
 * Deliberately never echoes the raw `label` string back into the fallback
 * text below: an unrecognised value (a future label this module has not
 * been taught about yet) would otherwise leak a `stopped:*` string straight
 * into "plain English", exactly the jargon this report exists to remove.
 */
function causeHeadingFor(label: string | undefined): string {
  if (label === undefined) {
    return "stopped for a reason this report has no record of — check the ticket";
  }
  const def = STOP_LABEL_DEFINITIONS.find((d) => d.name === label);
  if (def === undefined) {
    return "stopped for a reason this report doesn't have plain words for yet — check the ticket";
  }
  return def.description;
}

const DEFERRED_HEADING =
  "hit a temporary hiccup (a rate limit, a brief outage) — retried automatically within this run";

/** Group tickets under their plain-English cause heading, preserving the
 *  order headings were first seen so the render is stable and readable. */
function groupByHeading<T extends RunReportTicket>(
  entries: readonly { readonly heading: string; readonly ticket: T }[],
): { readonly heading: string; readonly tickets: T[] }[] {
  const order: string[] = [];
  const byHeading = new Map<string, T[]>();
  for (const { heading, ticket } of entries) {
    if (!byHeading.has(heading)) {
      byHeading.set(heading, []);
      order.push(heading);
    }
    byHeading.get(heading)!.push(ticket);
  }
  return order.map((heading) => ({ heading, tickets: byHeading.get(heading)! }));
}

/**
 * Build the one end-of-run report. Pure, total, never throws.
 *
 * Every section renders even on a completely empty run — "a run that
 * shipped nothing and stopped nothing still writes the report" (issue
 * #1179's own acceptance criterion).
 */
export function buildRunReport(input: RunReportInput): string {
  const lines: string[] = [];

  // ---------------------------------------------------------------------
  // 1. The headline. Collected as a de-duplicated action list — the
  // shortest list of things only a PERSON can do. Everything the loop
  // already handled itself (a retry-budget re-queue, a routine quarantine
  // with no owner decision attached) never appears here.
  // ---------------------------------------------------------------------
  const seenNeedsYou = new Set<number>();
  const actions: string[] = [];
  const addAction = (issueNumber: number, text: string): void => {
    if (seenNeedsYou.has(issueNumber)) return;
    seenNeedsYou.add(issueNumber);
    actions.push(text);
  };

  if (input.breakerTrip) {
    actions.push(
      `The run stopped itself after ${input.breakerTrip.plain} ` +
        `(${input.breakerTrip.detail}).`,
    );
  }
  if (input.promotionFailed) {
    actions.push(
      "A final promotion failed during this run — verify the branch " +
        "before merging; it may be incomplete.",
    );
  }
  // The loudest failure a run can produce: the pipeline could not even
  // QUARANTINE the ticket, so it carries no label, no comment, nothing —
  // rendered first, ahead of every other action (issue #1179 review,
  // blocker 1).
  for (const t of input.errored) {
    addAction(
      t.number,
      `${ticketLine(t)} — the loop hit an error it could not even recover ` +
        "from cleanly enough to quarantine the ticket. Needs a look.",
    );
  }
  if (input.heldRun !== undefined) {
    actions.push(
      "This run's pull request waits for you to read and merge it — " +
        `${input.heldRun.reasons.join("; ")}.`,
    );
  }
  for (const t of input.previouslyShipped) {
    addAction(
      t.number,
      `${ticketLine(t)} — an earlier interrupted run says this shipped, ` +
        "but this run could not verify the code is really on the branch. " +
        "Check it by hand.",
    );
  }
  for (const t of input.quarantined) {
    if (!t.needsYou) continue;
    addAction(t.number, `${ticketLine(t)} — ${causeHeadingFor(t.label)}`);
  }

  const headline = actions.length === 0 ? "Nothing needs you." : "Needs you:";
  lines.push(`## ${headline}`);
  lines.push("", ...numberLines(runReportNumbers(input), input.shipped.length));
  if (actions.length > 0) {
    lines.push("", ...actions.map((a) => `- ${a}`));
  }

  // ---------------------------------------------------------------------
  // 2. Shipped.
  // ---------------------------------------------------------------------
  lines.push("", "## Shipped");
  if (input.shipped.length === 0) {
    lines.push("", "Nothing shipped this run.");
  } else {
    lines.push("", ...input.shipped.map((t) => `- ${ticketLine(t)}`));
  }

  const noFirstTest = input.shipped.filter((t) => t.noFirstTest === true);
  if (noFirstTest.length > 0) {
    lines.push(
      "",
      "## Shipped without a first test",
      "",
      "These rest on the reviewer's pass alone — no test written before the code proved them:",
      "",
      ...noFirstTest.map((t) => `- ${ticketLine({ number: t.number, title: t.title })}`),
    );
  }
  if (input.olderTestEdits.length > 0) {
    lines.push(
      "",
      "## Older tests edited",
      "",
      ...input.olderTestEdits.map((e) => {
        const by = ticketLine({ number: e.byIssue, title: e.byTitle });
        const named = e.namedInTicket
          ? "(named in the ticket)"
          : "(NOT named in the ticket — check this one)";
        return (
          `- ${by} edited an older test: ${e.path} ${named} — ` +
          `#${e.olderIssue}'s test, +${e.linesAdded}/−${e.linesRemoved}`
        );
      }),
    );
  }

  // ---------------------------------------------------------------------
  // 3. Stopped — grouped by cause class, quarantined tickets first (they
  // are terminal), then deferred tickets (still mid-retry) under their own
  // quiet heading.
  // ---------------------------------------------------------------------
  lines.push("", "## Stopped");
  const stopGroups = groupByHeading(
    input.quarantined.map((t) => ({ heading: causeHeadingFor(t.label), ticket: t })),
  );
  const deferredGroup =
    input.deferred.length > 0
      ? [{ heading: DEFERRED_HEADING, tickets: input.deferred }]
      : [];
  const allGroups = [...stopGroups, ...deferredGroup];
  if (allGroups.length === 0) {
    lines.push("", "Nothing stopped this run.");
  } else {
    for (const group of allGroups) {
      lines.push("", `**${group.heading}**`, "");
      lines.push(...group.tickets.map((t) => `- ${ticketLine(t)}`));
    }
  }

  // ---------------------------------------------------------------------
  // 4. Waiting for a session — the retry budget gave up on these, so a
  // session (not the owner) finishes them. One line each; this run's carry
  // the reason, earlier ones say they were already waiting.
  // ---------------------------------------------------------------------
  const thisRunWaiting = new Set(input.waiting.map((t) => t.number));
  const earlierWaiting = input.alreadyWaiting.filter((t) => !thisRunWaiting.has(t.number));
  if (input.waiting.length > 0 || earlierWaiting.length > 0) {
    lines.push(
      "",
      "## Waiting for a session",
      "",
      ...input.waiting.map((t) =>
        t.note ? `- ${ticketLine(t)}` : `- ${ticketLine(t)} — waiting for a session`,
      ),
      ...earlierWaiting.map(
        (t) => `- ${ticketLine({ number: t.number, title: t.title })} — already waiting before this run`,
      ),
    );
  }

  // ---------------------------------------------------------------------
  // 5. Re-queued by the retry budget — informational only, never an action.
  // ---------------------------------------------------------------------
  if (input.requeued.length > 0) {
    lines.push(
      "",
      "## Already handled automatically",
      "",
      "The loop re-queued these itself — they are still under their retry " +
        "budget — no action needed:",
      "",
      ...input.requeued.map((t) => `- ${ticketLine(t)}`),
    );
  }

  return lines.join("\n");
}
