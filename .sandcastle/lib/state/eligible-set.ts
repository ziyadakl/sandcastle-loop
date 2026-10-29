/**
 * THE PLANNER, AS CODE (2026-09-03).
 *
 * Until this file existed, an LLM chose the loop's work. It was handed two raw
 * `gh issue list` dumps inside `.sandcastle/plan-prompt.md` and told, in prose,
 * to drop anything whose `Blocked by: #N` blocker was still open, drop anything
 * without a `type:` label, sort by priority then issue number, and cap the
 * list. On 2026-09-03 it got the blocker rule wrong in BOTH directions inside
 * one hour:
 *
 *   - It dealt #1065 while #1038 was open, though line 1 of #1065's body read
 *     `Blocked-by: #1038`. Both tickets edited the same file; only an unrelated
 *     guard stopped the collision.
 *   - After a code gate was added that can only SUBTRACT wrongly-picked
 *     tickets, the next call then dropped #1038 itself — whose blockers #1028
 *     and #1056 are both closed — writing "#1065, #1038 and #811 form a chain
 *     of dependencies on each other". Nothing could add it back: a gate that
 *     subtracts cannot repair a ticket the planner never offered.
 *
 * Every remaining rule that prompt asked for is arithmetic — a label test, a
 * body parse, a sort, a slice — so there was no judgement left for a model to
 * exercise and nothing but its mistakes to inherit. {@link planDeterministic}
 * is the whole planner now; the agent, its prompt file and its token cost are
 * gone.
 *
 * Two functions, split because they answer two different questions:
 *   - {@link eligibleForPlanning} — WHICH tickets may be worked at all. Pure
 *     rules, no ordering, and it explains every ticket it withholds.
 *   - {@link planDeterministic} — of those, WHICH ONES NOW and in what order.
 */

import { typeLabelExclusionReason } from "../skill-discipline.js";
import {
  BLOCKER_RESOLVING_LABELS,
  describeUnresolvedBlockers,
  parseBlockedBy,
  unresolvedBlockers,
} from "./blocked-by.js";
import { LABEL_IN_PROGRESS } from "./gh.js";
import { WAITING_FOR_SESSION_LABEL } from "./retry-budget.js";

/**
 * One row of `listOpenIssuesWithBodies()` — number, title, body, labels. Both
 * halves of every rule below come from this one listing, so the whole planner
 * costs exactly ONE `gh` round-trip (shared, in `main.mts`, through the
 * run-scoped memo in `./open-issue-memo.ts`).
 */
export interface OpenIssueRow {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/** A ticket the host withheld, and the plain-English reason it withheld it. */
export interface PlanningExclusion {
  readonly number: number;
  readonly reason: string;
}

export interface PlanningEligibility {
  /** Ready, typed, unblocked — ascending by issue number. */
  readonly eligible: readonly OpenIssueRow[];
  /** Ready but withheld, ascending by issue number, each with its reason. */
  readonly excluded: readonly PlanningExclusion[];
}

export interface EligibleForPlanningOptions {
  /** The queue label — `ready-for-agent` unless `--label` says otherwise. */
  readonly readyLabel: string;
  /**
   * SANDCASTLE.md present at the repo root → the project runs skill
   * discipline, and a dispatchable ticket must carry exactly one `type:`
   * label. Off, the `type:` rule is inert.
   */
  readonly skillDisciplineOn?: boolean;
  /**
   * The listing came back AT its `gh --limit` cap, so "absent" stops meaning
   * "closed" and starts meaning "cannot see it". Every declared blocker that
   * is not present then counts as UNRESOLVED — the fail-CLOSED direction.
   *
   * `main.mts` refuses to plan at all on a truncated listing (it throws
   * `ELIGIBLE_SET_FAILURE` rather than rank a set it cannot trust), so in
   * production this flag is a second line rather than the first. It is kept
   * because this function is pure and someone will call it from somewhere
   * else, and because a silently fail-OPEN default here would be the exact
   * bug the caller's halt exists to prevent.
   */
  readonly listingTruncated?: boolean;
}

/**
 * THE ELIGIBLE SET — every ticket that may be worked right now, and the reason
 * for every ticket that may not.
 *
 * A `readyLabel` issue is WITHHELD when any of these is true, checked in this
 * order so the most specific reason is the one a person reads:
 *
 *   1. It sits in a blocker CYCLE (`#A` blocked by `#B` blocked by `#A`, or a
 *      ticket blocked by itself) in which NOTHING IS BEING BUILT. The ordinary
 *      blocker rule already withholds both, forever — but "blocked by #B
 *      (open)" invites someone to wait for #B, and nobody should wait: no
 *      ticket in such a cycle can ever be unblocked without a person editing a
 *      body. So it gets its own wording. A loop that runs through a ticket
 *      that IS being built is NOT this — see {@link blockerCycles}.
 *   2. It declares a blocker that is still unresolved
 *      ({@link unresolvedBlockers} — the same function `blockedByGate` calls,
 *      so the two can never disagree).
 *   3. Under skill discipline, it does not carry exactly one `type:` label
 *      ({@link typeLabelExclusionReason} — again the same function the
 *      pick-filter uses).
 *
 * Note what CANNOT happen here and does happen in `blockedByGate`: a ticket
 * whose own row is missing. The candidates ARE rows of `openIssues`, so a
 * ready ticket is present by construction. The missing-row road belongs to a
 * caller that starts from a NUMBER rather than a row — a hallucinated pick,
 * or a card that has sat on the dealer's stack for hours — and it lives in
 * `blockedByGate` (`main.mts`), which still runs at deal time.
 */
export function eligibleForPlanning(
  openIssues: readonly OpenIssueRow[],
  opts: EligibleForPlanningOptions,
): PlanningEligibility {
  const truncated = opts.listingTruncated === true;
  const ready = openIssues
    .filter((i) => i.labels.includes(opts.readyLabel))
    .slice()
    .sort((a, b) => a.number - b.number);
  const cycles = blockerCycles(openIssues);
  const eligible: OpenIssueRow[] = [];
  const excluded: PlanningExclusion[] = [];
  for (const issue of ready) {
    // Spec #1334 SC: the retry budget gave up on this ticket. Moving it to
    // waiting removes `quarantine` and never adds `ready-for-agent`, so this
    // only fires when a person put the ready label back without removing
    // the waiting one — the waiting label wins until it is removed.
    if (issue.labels.includes(WAITING_FOR_SESSION_LABEL)) {
      excluded.push({
        number: issue.number,
        reason:
          "waiting for a session (the loop stopped retrying it) — remove " +
          "`waiting-for-session` to re-queue it; delete its Retry budget " +
          "section for a fresh $100",
      });
      continue;
    }
    const cycle = cycles.get(issue.number);
    if (cycle !== undefined) {
      excluded.push({ number: issue.number, reason: describeCycle(cycle) });
      continue;
    }
    const blockers = unresolvedBlockers(issue.body, openIssues, {
      listingTruncated: truncated,
    });
    if (blockers.length > 0) {
      excluded.push({
        number: issue.number,
        reason: describeUnresolvedBlockers(blockers, openIssues),
      });
      continue;
    }
    const typeReason =
      opts.skillDisciplineOn === true
        ? typeLabelExclusionReason(issue.labels)
        : undefined;
    if (typeReason !== undefined) {
      excluded.push({ number: issue.number, reason: typeReason });
      continue;
    }
    eligible.push(issue);
  }
  return { eligible, excluded };
}

// ---------------------------------------------------------------------------
// Blocker cycles
// ---------------------------------------------------------------------------

/**
 * Labels that take an issue OUT of the cycle graph — not out of the blocker
 * rule, which is a different question with a different answer.
 *
 * `shipped-local` / `done` ({@link BLOCKER_RESOLVING_LABELS}): finished work. A
 * chain running through one of these is not a cycle, and calling it one would
 * tell a person to go edit a body that is perfectly correct.
 *
 * `in-progress`: a ticket a worker is BUILDING RIGHT NOW. It is still blocking
 * (`unresolvedBlockers` says so, and must — its code is not on the branch yet),
 * but it is not STUCK: it ships, its label flips to `shipped-local`, and every
 * ticket waiting on it frees. So a loop that only closes through an
 * in-progress ticket is a wait, not a deadlock. Counting it as a cycle told the
 * owner "no ticket in the cycle can ever become unblocked — a person must edit
 * one of the bodies" about a pair that would have cleared itself within the
 * hour, which is a false alarm AND hides the real reason the ticket is held.
 */
const CYCLE_INERT_LABELS: readonly string[] = [
  ...BLOCKER_RESOLVING_LABELS,
  LABEL_IN_PROGRESS,
];

/**
 * Every open issue that can reach ITSELF by following declared blockers, mapped
 * to the path proving it — counting only nodes that nothing can currently
 * unstick ({@link CYCLE_INERT_LABELS}).
 */
function blockerCycles(
  openIssues: readonly OpenIssueRow[],
): Map<number, readonly number[]> {
  // Nodes: open issues that are neither finished nor being built. Edges: their
  // declared blockers, kept only where the target is also a node. A blocker
  // absent from the listing terminates the walk — it is closed (or, on a capped
  // listing, unreadable), and either way it is not part of a live cycle.
  const nodes = new Map<number, OpenIssueRow>();
  for (const issue of openIssues) {
    if (issue.labels.some((l) => CYCLE_INERT_LABELS.includes(l))) continue;
    nodes.set(issue.number, issue);
  }
  const edges = new Map<number, readonly number[]>();
  for (const [number, issue] of nodes) {
    edges.set(
      number,
      parseBlockedBy(issue.body).filter((n) => nodes.has(n)),
    );
  }
  const found = new Map<number, readonly number[]>();
  for (const start of nodes.keys()) {
    const path = walkBackToStart(start, edges);
    if (path !== undefined) found.set(start, path);
  }
  return found;
}

/** Depth-first walk from `start`; returns `[start, …, start]` if it loops back. */
function walkBackToStart(
  start: number,
  edges: ReadonlyMap<number, readonly number[]>,
): readonly number[] | undefined {
  const seen = new Set<number>();
  const path: number[] = [start];
  const visit = (at: number): boolean => {
    for (const next of edges.get(at) ?? []) {
      path.push(next);
      if (next === start) return true;
      if (!seen.has(next)) {
        seen.add(next);
        if (visit(next)) return true;
      }
      path.pop();
    }
    return false;
  };
  seen.add(start);
  return visit(start) ? [...path] : undefined;
}

function describeCycle(path: readonly number[]): string {
  const arrow = path.map((n) => `#${n}`).join(" → ");
  return path.length === 2
    ? `it declares ITSELF as a blocker (${arrow}), so it can never become ` +
        `unblocked — a person must edit the body`
    : `it sits in a blocker cycle (${arrow}), so no ticket in the cycle can ` +
        `ever become unblocked — a person must edit one of the bodies`;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Exactly the card shape the dealer takes — and the old `<plan>` JSON's. */
export interface PlannedCard {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
}

export interface DeterministicPlan {
  readonly issues: readonly PlannedCard[];
  /** Every WITHHELD ready ticket and why — the run log prints one line each. */
  readonly excluded: readonly PlanningExclusion[];
}

export interface PlanDeterministicInput {
  readonly openIssues: readonly OpenIssueRow[];
  readonly readyLabel: string;
  readonly skillDisciplineOn?: boolean;
  readonly listingTruncated?: boolean;
  /** How many cards the dealer wants. Cards beyond this are simply not dealt. */
  readonly stackSize: number;
  /** Cards already being built. Never re-offered; not reported as excluded. */
  readonly inFlight?: readonly { readonly id: string }[];
}

/**
 * THE WHOLE PLANNER. Eligible set → drop what is already in flight → rank →
 * cap. No model, no prompt, no tokens, no round-trip of its own.
 *
 * Ranking, unchanged from what the prompt asked the agent for:
 *   1. Priority label first ({@link priorityRank}) — `priority:p0` beats
 *      `priority:high` beats `priority:medium` beats `priority:low`, and a
 *      ticket with NO priority label sorts after every ticket that has one.
 *   2. Then issue number ascending, so older work goes first inside a tier.
 */
export function planDeterministic(input: PlanDeterministicInput): DeterministicPlan {
  const { eligible, excluded } = eligibleForPlanning(input.openIssues, {
    readyLabel: input.readyLabel,
    skillDisciplineOn: input.skillDisciplineOn,
    listingTruncated: input.listingTruncated,
  });
  const inFlightIds = new Set((input.inFlight ?? []).map((c) => c.id));
  const ranked = eligible
    .filter((i) => !inFlightIds.has(String(i.number)))
    .slice()
    .sort(comparePlanOrder);
  const capped = input.stackSize > 0 ? ranked.slice(0, input.stackSize) : [];
  return {
    issues: capped.map((i) => ({
      id: String(i.number),
      title: i.title,
      branch: `agent/issue-${i.number}`,
    })),
    excluded,
  };
}

/**
 * A ticket's priority, as a sortable pair. Lower `tier` wins. A recognised
 * label carries no `text`, so two DIFFERENT tickets at the same tier fall
 * through to issue number rather than to label spelling. Only an unrecognised
 * word keeps its `text`, so it still sorts by earlier letters rather than
 * arbitrarily.
 *
 * The named tiers exist because the obvious implementation — sort the label
 * suffix alphabetically — puts `high` before `low` before `medium` before
 * `p0`, which is almost exactly backwards from what the words mean. A table is
 * the honest way to say that `high` outranks `medium`.
 */
export function priorityRank(labels: readonly string[]): {
  tier: number;
  text: string;
} {
  const NAMED: Readonly<Record<string, number>> = {
    p0: 0,
    critical: 0,
    urgent: 0,
    blocker: 0,
    p1: 1,
    high: 1,
    p2: 2,
    medium: 2,
    normal: 2,
    p3: 3,
    low: 3,
  };
  /** After every named/numbered tier, before "no priority label at all". */
  const UNKNOWN_TIER = 1_000;
  /** No `priority:` label — sorts after every ticket that carries one. */
  const NONE: { tier: number; text: string } = {
    tier: Number.MAX_SAFE_INTEGER,
    text: "",
  };
  let best: { tier: number; text: string } | undefined;
  for (const label of labels) {
    if (!label.startsWith("priority:")) continue;
    const suffix = label.slice("priority:".length).trim().toLowerCase();
    if (suffix === "") continue;
    const named = NAMED[suffix];
    const numeric = /^p?(\d+)$/.exec(suffix);
    const rank =
      named !== undefined
        ? { tier: named, text: "" }
        : numeric !== null
          ? { tier: Number(numeric[1]), text: "" }
          : { tier: UNKNOWN_TIER, text: suffix };
    // A ticket wearing two priority labels is a triage mistake, not a reason to
    // refuse it. Take the most urgent one and get on with it.
    if (best === undefined || comparePriority(rank, best) < 0) best = rank;
  }
  return best ?? NONE;
}

function comparePriority(
  a: { tier: number; text: string },
  b: { tier: number; text: string },
): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

function comparePlanOrder(a: OpenIssueRow, b: OpenIssueRow): number {
  const byPriority = comparePriority(
    priorityRank(a.labels),
    priorityRank(b.labels),
  );
  return byPriority !== 0 ? byPriority : a.number - b.number;
}

// ---------------------------------------------------------------------------
// The operator-facing note
// ---------------------------------------------------------------------------

/**
 * The `(note: …)` suffix on the "no claimable issues — exiting cleanly" exit.
 *
 * Fed from the SAME `excluded` list the planner acted on, so the message and
 * the behaviour cannot disagree. Its predecessor re-derived the reasons from a
 * second `gh` fetch under a slightly different reading of the rule, and told
 * the operator a ticket was blocked at the very moment the loop was happily
 * dealing it.
 *
 * Returns `""` when nothing was withheld; the caller then keeps the plain exit
 * line.
 */
export function buildEligibilityNote(
  excluded: readonly PlanningExclusion[],
): string {
  if (excluded.length === 0) return "";
  const parts = [...excluded]
    .sort((a, b) => a.number - b.number)
    .map((e) => `#${e.number} is ready but ${e.reason}`);
  return ` (note: ${parts.join("; ")})`;
}
