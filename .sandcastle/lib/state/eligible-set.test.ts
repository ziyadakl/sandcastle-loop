/**
 * The planner's rules, proven without a run — because they ARE the planner now.
 *
 * `main.mts` used to hand these rules to an LLM as prose in
 * `.sandcastle/plan-prompt.md`. On 2026-09-03 it got the blocker rule wrong in
 * both directions inside one hour, so the rules moved into
 * `eligible-set.ts` and the agent was deleted. The wiring — that `runMain`
 * calls this and never dispatches a planner agent — is pinned in
 * `main.test.mts`. This file pins the RULES.
 */
import { describe, expect, it } from "vitest";

import {
  buildEligibilityNote,
  eligibleForPlanning,
  planDeterministic,
  priorityRank,
  type OpenIssueRow,
} from "./eligible-set.js";

const READY = "ready-for-agent";

const issue = (
  number: number,
  opts: { body?: string; labels?: string[]; title?: string } = {},
): OpenIssueRow => ({
  number,
  title: opts.title ?? `issue ${number}`,
  body: opts.body ?? "",
  labels: opts.labels ?? [READY],
});

const numbers = (rows: readonly OpenIssueRow[]): number[] =>
  rows.map((r) => r.number);

const reasonFor = (
  result: ReturnType<typeof eligibleForPlanning>,
  n: number,
): string => {
  const hit = result.excluded.find((e) => e.number === n);
  if (hit === undefined) throw new Error(`#${n} was not excluded`);
  return hit.reason;
};

// ---------------------------------------------------------------------------
describe("eligibleForPlanning — who may be worked at all", () => {
  it("passes a ready ticket with no blockers", () => {
    const result = eligibleForPlanning([issue(1154)], { readyLabel: READY });
    expect(numbers(result.eligible)).toEqual([1154]);
    expect(result.excluded).toEqual([]);
  });

  it("withholds a ticket that is waiting for a session even if it also carries the ready label (spec #1334 SC)", () => {
    const result = eligibleForPlanning(
      [issue(1154), issue(1083, { labels: [READY, "waiting-for-session"] })],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([1154]);
    expect(reasonFor(result, 1083)).toMatch(/waiting for a session/);
    expect(reasonFor(result, 1083)).toMatch(/Retry budget section/);
  });

  it("ignores an open issue that does not carry the ready label at all", () => {
    const result = eligibleForPlanning(
      [issue(1154), issue(900, { labels: ["needs-human"] })],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([1154]);
    // Not "excluded" — it was never a candidate. The note must not tell the
    // operator that a ticket nobody queued is being held back.
    expect(result.excluded).toEqual([]);
  });

  it("withholds a ticket whose blocker is still open, naming the blocker and its labels", () => {
    const result = eligibleForPlanning(
      [
        issue(1038, { labels: [READY, "in-progress"] }),
        issue(1065, { body: "Blocked-by: #1038\n" }),
      ],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([1038]);
    expect(reasonFor(result, 1065)).toBe(
      "blocked by #1038 (open, labels: ready-for-agent, in-progress)",
    );
  });

  it("treats a `shipped-local` blocker as resolved — the loop leaves finished work OPEN", () => {
    const result = eligibleForPlanning(
      [
        issue(1038, { labels: ["shipped-local"] }),
        issue(1065, { body: "Blocked-by: #1038\n" }),
      ],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([1065]);
  });

  it("treats a `done` blocker as resolved", () => {
    const result = eligibleForPlanning(
      [
        issue(1038, { labels: ["done"] }),
        issue(1065, { body: "Blocked-by: #1038\n" }),
      ],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([1065]);
  });

  it("treats an ABSENT blocker as resolved on a complete listing (closed or merged)", () => {
    const result = eligibleForPlanning([issue(1065, { body: "Blocked-by: #1038\n" })], {
      readyLabel: READY,
    });
    expect(numbers(result.eligible)).toEqual([1065]);
  });

  for (const label of ["in-progress", "needs-human", "quarantine"]) {
    it(`keeps a \`${label}\` blocker BLOCKING — a stalled blocker is not a finished one`, () => {
      const result = eligibleForPlanning(
        [issue(1038, { labels: [label] }), issue(1065, { body: "Blocked by: #1038" })],
        { readyLabel: READY },
      );
      expect(numbers(result.eligible)).toEqual([]);
      expect(reasonFor(result, 1065)).toContain(`#1038 (open, labels: ${label})`);
    });
  }

  it("reads the header form as well as the inline form", () => {
    const body = ["## Blocked by", "- #1038", ""].join("\n");
    const result = eligibleForPlanning(
      [issue(1038, { labels: ["quarantine"] }), issue(1065, { body })],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([]);
    expect(reasonFor(result, 1065)).toContain("#1038");
  });

  it("ignores a `Blocked by:` line quoted inside a fenced code block", () => {
    const body = [
      "This ticket is ABOUT the rule. Here is the syntax:",
      "```",
      "Blocked by: #1038",
      "```",
    ].join("\n");
    const result = eligibleForPlanning(
      [issue(1038, { labels: ["in-progress"] }), issue(1065, { body })],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([1065]);
  });

  it("ignores a `Blocked by:` line the loop itself wrote into a machine section", () => {
    const body = [
      "<!-- sandcastle:stop-report:start -->",
      "Blocked by: #1038",
      "<!-- sandcastle:stop-report:end -->",
    ].join("\n");
    const result = eligibleForPlanning(
      [issue(1038, { labels: ["in-progress"] }), issue(1065, { body })],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([1065]);
  });

  it("withholds a ticket that names ITSELF as its blocker, and says so", () => {
    const result = eligibleForPlanning([issue(77, { body: "Blocked-by: #77" })], {
      readyLabel: READY,
    });
    expect(numbers(result.eligible)).toEqual([]);
    expect(reasonFor(result, 77)).toBe(
      "it declares ITSELF as a blocker (#77 → #77), so it can never become " +
        "unblocked — a person must edit the body",
    );
  });

  it("withholds BOTH halves of a mutual block, and names the cycle", () => {
    const result = eligibleForPlanning(
      [
        issue(10, { body: "Blocked-by: #11" }),
        issue(11, { body: "Blocked-by: #10" }),
      ],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([]);
    expect(reasonFor(result, 10)).toBe(
      "it sits in a blocker cycle (#10 → #11 → #10), so no ticket in the " +
        "cycle can ever become unblocked — a person must edit one of the bodies",
    );
    expect(reasonFor(result, 11)).toContain("#11 → #10 → #11");
  });

  it("does NOT call a loop through an IN-PROGRESS ticket a cycle — it is a wait, not a deadlock", () => {
    // #10 (ready) waits on #11; #11 is BEING BUILT and its body still carries a
    // stale `Blocked-by: #10`. Nobody has to edit a body: #11 ships, flips to
    // `shipped-local`, and #10 frees. So #10 must read as ordinarily blocked,
    // naming the blocker and the label it is wearing.
    const result = eligibleForPlanning(
      [
        issue(10, { body: "Blocked-by: #11" }),
        issue(11, { body: "Blocked-by: #10", labels: ["in-progress"] }),
      ],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([]);
    expect(reasonFor(result, 10)).toBe(
      "blocked by #11 (open, labels: in-progress)",
    );
  });

  it("still calls a loop between two WAITING tickets a cycle, even with a third in flight", () => {
    // The other shape: #10 and #11 block each other and neither is being
    // built. Nothing will move without a person, so the cycle wording stands —
    // an unrelated in-progress ticket must not soften it.
    const result = eligibleForPlanning(
      [
        issue(10, { body: "Blocked-by: #11" }),
        issue(11, { body: "Blocked-by: #10" }),
        issue(12, { labels: ["in-progress"] }),
      ],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([]);
    expect(reasonFor(result, 10)).toContain("#10 → #11 → #10");
    expect(reasonFor(result, 11)).toContain("#11 → #10 → #11");
  });

  it("does NOT call a chain through a finished ticket a cycle", () => {
    // #10 → #11 → #10, but #11 is `shipped-local`. The chain is over: #10 is
    // dealable, and telling a person to go break a cycle would be wrong.
    const result = eligibleForPlanning(
      [
        issue(10, { body: "Blocked-by: #11" }),
        issue(11, { body: "Blocked-by: #10", labels: ["shipped-local"] }),
      ],
      { readyLabel: READY },
    );
    expect(numbers(result.eligible)).toEqual([10]);
    expect(result.excluded).toEqual([]);
  });

  it("under skill discipline, withholds a ticket with no `type:` label", () => {
    const result = eligibleForPlanning([issue(500)], {
      readyLabel: READY,
      skillDisciplineOn: true,
    });
    expect(numbers(result.eligible)).toEqual([]);
    expect(reasonFor(result, 500)).toBe("missing type: label");
  });

  it("under skill discipline, withholds a ticket with TWO `type:` labels", () => {
    const result = eligibleForPlanning(
      [issue(500, { labels: [READY, "type:backend", "type:bugfix-ui"] })],
      { readyLabel: READY, skillDisciplineOn: true },
    );
    expect(reasonFor(result, 500)).toBe("multiple type: labels");
  });

  it("under skill discipline, passes a ticket carrying exactly one `type:` label", () => {
    const result = eligibleForPlanning(
      [issue(500, { labels: [READY, "type:backend"] })],
      { readyLabel: READY, skillDisciplineOn: true },
    );
    expect(numbers(result.eligible)).toEqual([500]);
  });

  it("ignores the `type:` rule entirely when skill discipline is off", () => {
    const result = eligibleForPlanning([issue(500)], { readyLabel: READY });
    expect(numbers(result.eligible)).toEqual([500]);
  });

  it("on a TRUNCATED listing, an absent blocker counts as unresolved — absence stops meaning closed", () => {
    const result = eligibleForPlanning([issue(1065, { body: "Blocked-by: #1038" })], {
      readyLabel: READY,
      listingTruncated: true,
    });
    expect(numbers(result.eligible)).toEqual([]);
    expect(reasonFor(result, 1065)).toBe(
      "blocked by #1038 (not in the capped open-issue listing — cannot be " +
        "proven resolved)",
    );
  });

  it("names the BLOCKER, not the missing `type:` label, when a ticket fails both", () => {
    // Order matters for the person reading the log: the blocker is the thing
    // that will still be true after triage fixes the label.
    const result = eligibleForPlanning(
      [issue(1038, { labels: ["in-progress"] }), issue(1065, { body: "Blocked-by: #1038" })],
      { readyLabel: READY, skillDisciplineOn: true },
    );
    expect(reasonFor(result, 1065)).toContain("blocked by #1038");
  });
});

// ---------------------------------------------------------------------------
describe("eligibleForPlanning — the real 2026-09-03 queue", () => {
  /**
   * THE PIN. This is the exact queue the LLM planner faced on 2026-09-03, and
   * it got it wrong in BOTH directions: it dealt #1065 (blocked by the open
   * #1038), and on the next call it dropped #1038 itself (whose blockers are
   * both closed), writing "#1065, #1038 and #811 form a chain of dependencies
   * on each other".
   *
   *   #1154 — no blockers
   *   #1038 — Blocked-by: #1028, #1056   (both CLOSED, so absent from the list)
   *   #1065 — Blocked-by: #1038          (#1038 is open)
   *   #811  — Blocked-by: #1028, #1065   (#1065 is open)
   *   #1146 — Blocked-by: #1073          (#1073 open, no shipped label)
   *   #1091 — Blocked-by: #1073
   */
  const QUEUE: OpenIssueRow[] = [
    issue(811, { body: "Blocked-by: #1028, #1065" }),
    issue(1038, { body: "Blocked-by: #1028, #1056" }),
    issue(1065, { body: "Blocked-by: #1038\n\nSome ticket text.\n" }),
    issue(1091, { body: "Blocked-by: #1073" }),
    issue(1146, { body: "Blocked-by: #1073" }),
    issue(1154),
    // The blocker that is open and NOT finished. It is not queued itself, which
    // is exactly why a `ready-for-agent`-only view of the world cannot see it.
    issue(1073, { labels: ["needs-human"] }),
  ];

  it("gives exactly #1038 and #1154 — the two the loop should have built", () => {
    const result = eligibleForPlanning(QUEUE, { readyLabel: READY });
    expect(numbers(result.eligible)).toEqual([1038, 1154]);
  });

  it("keeps #1038 — its blockers #1028 and #1056 are both closed (the second miss)", () => {
    const result = eligibleForPlanning(QUEUE, { readyLabel: READY });
    expect(numbers(result.eligible)).toContain(1038);
    expect(result.excluded.map((e) => e.number)).not.toContain(1038);
  });

  it("withholds #1065 — its blocker #1038 is open (the first miss)", () => {
    const result = eligibleForPlanning(QUEUE, { readyLabel: READY });
    expect(reasonFor(result, 1065)).toBe(
      "blocked by #1038 (open, labels: ready-for-agent)",
    );
  });

  it("withholds #811, #1091 and #1146 for the blockers they actually name", () => {
    const result = eligibleForPlanning(QUEUE, { readyLabel: READY });
    expect(reasonFor(result, 811)).toBe(
      "blocked by #1065 (open, labels: ready-for-agent)",
    );
    expect(reasonFor(result, 1091)).toBe(
      "blocked by #1073 (open, labels: needs-human)",
    );
    expect(reasonFor(result, 1146)).toBe(
      "blocked by #1073 (open, labels: needs-human)",
    );
  });

  it("finds NO cycle here — the planner's 'chain of dependencies on each other' was invented", () => {
    const result = eligibleForPlanning(QUEUE, { readyLabel: READY });
    expect(result.excluded.every((e) => !e.reason.includes("cycle"))).toBe(true);
  });

  it("ranks them [#1038, #1154] and deals them in that order", () => {
    const plan = planDeterministic({
      openIssues: QUEUE,
      readyLabel: READY,
      stackSize: 8,
    });
    expect(plan.issues).toEqual([
      { id: "1038", title: "issue 1038", branch: "agent/issue-1038" },
      { id: "1154", title: "issue 1154", branch: "agent/issue-1154" },
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("priorityRank — the words mean what they say", () => {
  const tier = (...labels: string[]): number => priorityRank(labels).tier;

  it("ranks p0 above high above medium above low", () => {
    expect(tier("priority:p0")).toBeLessThan(tier("priority:high"));
    expect(tier("priority:high")).toBeLessThan(tier("priority:medium"));
    expect(tier("priority:medium")).toBeLessThan(tier("priority:low"));
  });

  it("sorts every labelled ticket ahead of every unlabelled one", () => {
    expect(tier("priority:low")).toBeLessThan(tier(READY));
  });

  it("reads a bare number and a p-number the same way", () => {
    expect(tier("priority:1")).toBe(tier("priority:p1"));
    expect(tier("priority:p2")).toBeGreaterThan(tier("priority:p1"));
  });

  it("takes the most urgent of two priority labels rather than refusing the ticket", () => {
    expect(tier("priority:low", "priority:p0")).toBe(tier("priority:p0"));
  });

  it("falls back to earlier-letters-win for a word it does not know", () => {
    const a = priorityRank(["priority:aardvark"]);
    const b = priorityRank(["priority:zebra"]);
    expect(a.tier).toBe(b.tier);
    expect(a.text < b.text).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("planDeterministic — rank, drop what is building, cap", () => {
  it("sorts by priority tier first and issue number second", () => {
    const plan = planDeterministic({
      openIssues: [
        issue(10),
        issue(20, { labels: [READY, "priority:low"] }),
        issue(30, { labels: [READY, "priority:p0"] }),
        issue(5, { labels: [READY, "priority:p0"] }),
        issue(1, { labels: [READY, "priority:high"] }),
      ],
      readyLabel: READY,
      stackSize: 8,
    });
    expect(plan.issues.map((i) => i.id)).toEqual(["5", "30", "1", "20", "10"]);
  });

  it("orders same-tier tickets by issue number even when the priority labels are spelled differently (#1202 review)", () => {
    // `priority:high` and `priority:p1` are both tier 1. Before the fix the
    // label spelling decided order ("high" > "p1"), so #100 jumped ahead of
    // the older #5. Two tickets at the same tier must fall through to issue
    // number, never to label spelling.
    const plan = planDeterministic({
      openIssues: [
        issue(100, { labels: [READY, "priority:high"] }),
        issue(5, { labels: [READY, "priority:p1"] }),
      ],
      readyLabel: READY,
      stackSize: 8,
    });
    expect(plan.issues.map((i) => i.id)).toEqual(["5", "100"]);
  });

  it("caps at stackSize, keeping the top of the ranking", () => {
    const plan = planDeterministic({
      openIssues: [issue(1), issue(2), issue(3), issue(4)],
      readyLabel: READY,
      stackSize: 2,
    });
    expect(plan.issues.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("returns nothing at all when stackSize is zero", () => {
    const plan = planDeterministic({
      openIssues: [issue(1)],
      readyLabel: READY,
      stackSize: 0,
    });
    expect(plan.issues).toEqual([]);
  });

  it("never re-offers a card that is already in flight", () => {
    const plan = planDeterministic({
      openIssues: [issue(1), issue(2)],
      readyLabel: READY,
      stackSize: 8,
      inFlight: [{ id: "1" }],
    });
    expect(plan.issues.map((i) => i.id)).toEqual(["2"]);
    // An in-flight card is not "withheld" — the operator does not need telling
    // that the ticket a worker is building right now was not dealt again.
    expect(plan.excluded).toEqual([]);
  });

  it("mints the branch name the loop expects", () => {
    const plan = planDeterministic({
      openIssues: [issue(71, { title: "a real title" })],
      readyLabel: READY,
      stackSize: 8,
    });
    expect(plan.issues[0]).toEqual({
      id: "71",
      title: "a real title",
      branch: "agent/issue-71",
    });
  });

  it("still reports every withheld ticket, even when nothing is dealable", () => {
    const plan = planDeterministic({
      openIssues: [
        issue(1038, { labels: ["in-progress"] }),
        issue(1065, { body: "Blocked-by: #1038" }),
      ],
      readyLabel: READY,
      stackSize: 8,
    });
    expect(plan.issues).toEqual([]);
    expect(plan.excluded).toEqual([
      { number: 1065, reason: "blocked by #1038 (open, labels: in-progress)" },
    ]);
  });

  it("honours a non-default queue label", () => {
    const plan = planDeterministic({
      openIssues: [issue(1, { labels: ["some-other-queue"] }), issue(2)],
      readyLabel: "some-other-queue",
      stackSize: 8,
    });
    expect(plan.issues.map((i) => i.id)).toEqual(["1"]);
  });
});

// ---------------------------------------------------------------------------
describe("buildEligibilityNote — what the operator reads at a clean exit", () => {
  it("is empty when nothing was withheld, so the plain exit line stands", () => {
    expect(buildEligibilityNote([])).toBe("");
  });

  it("names each withheld ticket and its reason, ascending", () => {
    expect(
      buildEligibilityNote([
        { number: 1065, reason: "blocked by #1038 (open, labels: in-progress)" },
        { number: 811, reason: "missing type: label" },
      ]),
    ).toBe(
      " (note: #811 is ready but missing type: label; #1065 is ready but " +
        "blocked by #1038 (open, labels: in-progress))",
    );
  });
});
