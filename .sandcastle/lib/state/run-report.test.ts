/**
 * Issue #1179 — the pure end-of-run report builder. `main.mts` supplies the
 * input (rework-store reads, sweep bookkeeping); everything about the
 * RENDERING — the headline, the grouping, the vocabulary — is proven here
 * with no IO at all.
 */
import { describe, expect, it } from "vitest";

import {
  buildRunReport,
  formatTicketEventLine,
  runReportNumbers,
  runReportSectionEnd,
  runReportSectionStart,
  shippedTicketNote,
  TICKET_EVENT_LINE_RE,
  titleRunReport,
  type RunReportInput,
} from "./run-report.js";
import { OWNER_DECISION_STOP_REASONS } from "./stop-reasons.js";

const emptyInput: RunReportInput = {
  runId: "run-1",
  branch: "sandcastle/run-1",
  shipped: [],
  quarantined: [],
  errored: [],
  deferred: [],
  previouslyShipped: [],
  requeued: [],
  waiting: [],
  alreadyWaiting: [],
  runCost: { totalUsd: 0, partial: false },
  olderTestEdits: [],
};

describe("buildRunReport — the headline", () => {
  it("is the exact literal 'Nothing needs you.' when nothing requires the owner", () => {
    const report = buildRunReport({
      ...emptyInput,
      shipped: [{ number: 1, title: "Fix the widget" }],
      quarantined: [
        { number: 2, title: "Flaky check", label: "stopped:no-failing-check", needsYou: false },
      ],
      requeued: [{ number: 3, title: "Sandbox hiccup" }],
    });
    expect(report).toContain("## Nothing needs you.");
    // The literal sentence appears nowhere it shouldn't be negated/qualified.
    expect(report).not.toMatch(/Needs you:/);
  });

  it("a totally empty run also gets the clean headline", () => {
    const report = buildRunReport(emptyInput);
    expect(report).toContain("## Nothing needs you.");
  });

  it("a circuit-breaker trip becomes a 'Needs you' action, in plain English with the raw detail in parentheses", () => {
    // Issue #1179 review, deferable 5: the headline used to interpolate the
    // raw CLI-flag string straight into the sentence
    // ("stopped itself early — 3 consecutive quarantine(s) >= limit 3
    // (--quarantine-limit)"). The plain sentence now leads, and the exact
    // counter/flag detail is demoted to a parenthetical.
    const report = buildRunReport({
      ...emptyInput,
      breakerTrip: {
        plain: "3 quarantines in a row",
        detail: "3 consecutive quarantine(s) ≥ limit 3 (--quarantine-limit)",
      },
    });
    expect(report).toContain("## Needs you:");
    expect(report).toContain("3 quarantines in a row");
    expect(report).toContain("(3 consecutive quarantine(s) ≥ limit 3 (--quarantine-limit))");
  });

  it("a failed promotion becomes a 'Needs you' action", () => {
    const report = buildRunReport({ ...emptyInput, promotionFailed: true });
    expect(report).toContain("## Needs you:");
    expect(report).toContain("final promotion failed");
  });

  it("tickets waiting for a session are listed under their own section, one line each with the reason — never an owner action", () => {
    const report = buildRunReport({
      ...emptyInput,
      requeued: [{ number: 10, title: "Retried this run" }],
      waiting: [
        {
          number: 11,
          title: "Out of retries",
          note: "retry budget spent ($104.00 of $100) — hand it to a session",
        },
      ],
      alreadyWaiting: [{ number: 12, title: "Parked last week" }],
    });
    expect(report.split("\n").filter((l) => l.includes("#11"))).toEqual([
      "- #11 Out of retries — retry budget spent ($104.00 of $100) — hand it to a session",
    ]);
    expect(report).toContain("## Nothing needs you.");
    const waitingSection = report.slice(
      report.indexOf("## Waiting for a session"),
      report.indexOf("## Already handled automatically"),
    );
    expect(waitingSection).toContain("#11 Out of retries");
    expect(waitingSection).toContain("- #12 Parked last week — already waiting before this run");
    expect(waitingSection).not.toContain("#10 Retried this run");
    // The requeued ticket appears ONLY under the informational section.
    const infoSection = report.slice(report.indexOf("## Already handled automatically"));
    expect(infoSection).toContain("#10 Retried this run");
    expect(infoSection).not.toContain("#11 Out of retries");
  });

  it("omits the waiting section when no ticket is waiting", () => {
    expect(buildRunReport(emptyInput)).not.toContain("## Waiting for a session");
  });

  it("a run PR left waiting is an owner action naming why — here, a data-destroying migration", () => {
    const report = buildRunReport({
      ...emptyInput,
      heldRun: {
        reasons: [
          "deletes or rewrites existing data (packages/db/migrations/0142_drop_x.sql: drops a table)",
        ],
      },
    });
    const headlineSection = report.slice(0, report.indexOf("## Shipped"));
    expect(headlineSection).toContain("## Needs you:");
    expect(headlineSection).toContain("packages/db/migrations/0142_drop_x.sql");
    expect(headlineSection).toContain("waits for you");
  });

  it("a needs-human quarantine becomes an action; a routine quarantine does not", () => {
    const report = buildRunReport({
      ...emptyInput,
      quarantined: [
        {
          number: 20,
          title: "Vague ticket",
          label: "stopped:ticket-unclear",
          needsYou: true,
        },
        {
          number: 21,
          title: "Weak check",
          label: "stopped:weak-check",
          needsYou: false,
        },
      ],
    });
    const headlineSection = report.slice(0, report.indexOf("## Shipped"));
    expect(headlineSection).toContain("#20 Vague ticket");
    expect(headlineSection).not.toContain("#21 Weak check");
  });

  it("EVERY real owner-decision stop label renders as a 'Needs you' action when needsYou is set — not just one hardcoded example", () => {
    // Issue #1179 review, blocker 1: `buildRunReport` itself never inspects
    // `label` to decide `needsYou` (that's the caller's job — see the module
    // doc comment), but this guards that every member of the REAL
    // `OWNER_DECISION_STOP_REASONS` set still renders as an action when the
    // caller says so, so a future label added to that set is not silently
    // mis-rendered by some label-content branch added here later.
    expect(OWNER_DECISION_STOP_REASONS.size).toBeGreaterThan(0);
    for (const label of OWNER_DECISION_STOP_REASONS) {
      const report = buildRunReport({
        ...emptyInput,
        quarantined: [{ number: 99, title: `Owner call: ${label}`, label, needsYou: true }],
      });
      const headlineSection = report.slice(0, report.indexOf("## Shipped"));
      expect(headlineSection).toContain(`#99 Owner call: ${label}`);
    }
  });

  it("an errored ticket (the pipeline couldn't even quarantine it) is the LOUDEST action — first in the list", () => {
    const report = buildRunReport({
      ...emptyInput,
      errored: [{ number: 70, title: "Blew up before quarantine" }],
      quarantined: [
        { number: 20, title: "Vague ticket", label: "stopped:ticket-unclear", needsYou: true },
      ],
    });
    const headlineSection = report.slice(0, report.indexOf("## Shipped"));
    const erroredIdx = headlineSection.indexOf("#70 Blew up before quarantine");
    const quarantinedIdx = headlineSection.indexOf("#20 Vague ticket");
    expect(erroredIdx).toBeGreaterThan(-1);
    expect(erroredIdx).toBeLessThan(quarantinedIdx);
  });

  it("a previously-shipped (stranded) ticket is always a 'Needs you' action", () => {
    const report = buildRunReport({
      ...emptyInput,
      previouslyShipped: [{ number: 30, title: "Stranded by a crashed run" }],
    });
    expect(report).toContain("## Needs you:");
    expect(report).toContain("#30 Stranded by a crashed run");
    expect(report).toContain("verify");
  });
});

describe("buildRunReport — shipped", () => {
  it("lists every shipped ticket with number and title", () => {
    const report = buildRunReport({
      ...emptyInput,
      shipped: [
        { number: 1, title: "Fix the widget" },
        { number: 2, title: "Add the gadget" },
      ],
    });
    expect(report).toContain("- #1 Fix the widget");
    expect(report).toContain("- #2 Add the gadget");
  });

  it("renders a bare number when no title is known", () => {
    const report = buildRunReport({ ...emptyInput, shipped: [{ number: 5 }] });
    expect(report).toContain("- #5");
  });

  it("says plainly that nothing shipped, on a run with no shipped tickets", () => {
    const report = buildRunReport(emptyInput);
    expect(report).toContain("Nothing shipped this run.");
  });

  it("#1198 A: a merge with no first test behind it says so ON ITS OWN LINE — the owner can see which merges had the weaker proof", () => {
    const report = buildRunReport({
      ...emptyInput,
      shipped: [
        { number: 1, title: "Fix the widget" },
        {
          number: 2,
          title: "Add the gadget",
          note: "(no first test — reviewer's pass alone)",
        },
      ],
    });
    // ONE dash on the line, not two: a self-bracketing note joins with a
    // space, so the only `—` a reader sees is the one inside the brackets.
    expect(report).toContain(
      "- #2 Add the gadget (no first test — reviewer's pass alone)",
    );
    expect(report).not.toContain("Add the gadget —");
    // And the ordinary merge beside it stays a bare line: a note on every
    // ticket is a note nobody reads.
    expect(report).toContain("- #1 Fix the widget\n");
    expect(report).not.toContain("- #1 Fix the widget —");
  });

  it("#1198 A: a note on the shipped list is NOT an owner action — the headline stays clean", () => {
    // The whole design of this ticket is that these merges are shipped work,
    // not held work. A note that pushed them into "Needs you" would recreate
    // the pile the change exists to empty.
    const report = buildRunReport({
      ...emptyInput,
      shipped: [
        {
          number: 2,
          title: "Add the gadget",
          note: "(no first test — reviewer's pass alone)",
        },
      ],
    });
    expect(report).toContain("## Nothing needs you.");
  });
});

describe("shippedTicketNote — the review notes on a Shipped line", () => {
  it("no facts, no note — an ordinary merge stays a bare line", () => {
    expect(shippedTicketNote({ noFirstTest: false })).toBeUndefined();
  });

  it("a structure finding and a weak first test each render as their own bracket, after no-first-test", () => {
    const note = shippedTicketNote({
      noFirstTest: true,
      structureFinding: "totals.ts grows a one-Team special case",
      weakFirstTest: "asserts the page renders, not the total",
    });
    const report = buildRunReport({
      ...emptyInput,
      shipped: [{ number: 3, title: "Team total", ...(note ? { note } : {}) }],
    });
    expect(report).toContain(
      "- #3 Team total (no first test — reviewer's pass alone) " +
        "(structure finding: totals.ts grows a one-Team special case) " +
        "(weak first test: asserts the page renders, not the total)",
    );
    expect(report).toContain("## Nothing needs you.");
  });
});

describe("buildRunReport — stopped, grouped by plain-English cause class", () => {
  it("groups tickets sharing the same label under one heading", () => {
    const report = buildRunReport({
      ...emptyInput,
      quarantined: [
        // `stopped:reviewer-refused`, not `stopped:weak-check`: #1198 A
        // retired that one, so it no longer has a label DEFINITION and
        // therefore no plain-English heading to group under. Any live label
        // exercises the grouping identically.
        { number: 1, title: "A", label: "stopped:reviewer-refused" },
        { number: 2, title: "B", label: "stopped:reviewer-refused" },
      ],
    });
    const stoppedSection = report.slice(report.indexOf("## Stopped"));
    // Both tickets sit under the SAME heading occurrence — the class text
    // appears exactly once even though two tickets share it.
    const headingOccurrences =
      stoppedSection.split("after every retry allowed").length - 1;
    expect(headingOccurrences).toBe(1);
    expect(stoppedSection).toContain("- #1 A");
    expect(stoppedSection).toContain("- #2 B");
  });

  it("never leaks a raw `stopped:*` label string anywhere in the rendered report", () => {
    const report = buildRunReport({
      ...emptyInput,
      shipped: [{ number: 1, title: "Shipped ticket" }],
      quarantined: [
        { number: 2, title: "Disagreement", label: "stopped:check-disagreement", needsYou: true },
        { number: 3, title: "Tampered", label: "stopped:checks-tampered" },
        { number: 4, title: "Already built", label: "stopped:already-built", needsYou: true },
        { number: 5, title: "No cause on file" },
        { number: 6, title: "Unrecognised", label: "stopped:some-future-label" },
      ],
      deferred: [{ number: 7, title: "Retrying" }],
      breakerTrip: { plain: "3 quarantines in a row", detail: "tripped" },
      promotionFailed: true,
    });
    expect(report).not.toContain("stopped:");
  });

  it("gives an unrecognised label a safe, generic fallback heading", () => {
    const report = buildRunReport({
      ...emptyInput,
      quarantined: [{ number: 9, title: "Mystery", label: "not-a-real-label" }],
    });
    expect(report).toContain("- #9 Mystery");
    expect(report).toContain("doesn't have plain words for yet");
  });

  it("a label-less quarantine (rework record absent) still renders, with a generic cause", () => {
    const report = buildRunReport({
      ...emptyInput,
      quarantined: [{ number: 8, title: "Unknown cause" }],
    });
    expect(report).toContain("- #8 Unknown cause");
    expect(report).toContain("no record of");
  });

  it("says plainly that nothing stopped, on a run with no stops and no deferrals", () => {
    const report = buildRunReport(emptyInput);
    expect(report).toContain("Nothing stopped this run.");
  });

  it("deferred tickets render under their own quiet, non-actionable heading", () => {
    const report = buildRunReport({
      ...emptyInput,
      deferred: [{ number: 40, title: "Rate limited" }],
    });
    const stoppedSection = report.slice(report.indexOf("## Stopped"));
    expect(stoppedSection).toContain("- #40 Rate limited");
    expect(stoppedSection).toContain("retried automatically");
    const headlineSection = report.slice(0, report.indexOf("## Shipped"));
    expect(headlineSection).not.toContain("#40");
  });

  it("a stopped ticket's note (issue #1179 review, blocker 3b: shipped-then-quarantined) renders alongside its cause", () => {
    const report = buildRunReport({
      ...emptyInput,
      quarantined: [
        {
          number: 80,
          title: "Landed, then staging rejected it",
          label: "stopped:run-fault",
          note: "built successfully but failed to land in the final merge — not actually shipped",
        },
      ],
    });
    const stoppedSection = report.slice(report.indexOf("## Stopped"));
    expect(stoppedSection).toContain(
      "#80 Landed, then staging rejected it — built successfully but failed to land in the final merge — not actually shipped",
    );
  });

  it("a run-fault stop no longer promises a health-gated re-queue (the retry budget decides now)", () => {
    const report = buildRunReport({
      ...emptyInput,
      quarantined: [{ number: 50, title: "Docker hiccup", label: "stopped:run-fault" }],
    });
    const stoppedSection = report.slice(report.indexOf("## Stopped"));
    expect(stoppedSection).not.toContain("next healthy start");
  });
});

describe("buildRunReport — re-queued by the retry budget, informational only", () => {
  it("omits the section entirely when nothing was re-queued", () => {
    const report = buildRunReport(emptyInput);
    expect(report).not.toContain("Already handled automatically");
  });

  it("lists re-queued tickets without asking the owner to do anything", () => {
    const report = buildRunReport({
      ...emptyInput,
      requeued: [{ number: 60, title: "Environment fault, retried" }],
    });
    expect(report).toContain("## Already handled automatically");
    expect(report).toContain("- #60 Environment fault, retried");
    expect(report).toContain("no action needed");
  });
});

describe("run-report marker functions — issue #1179 review, blocker 4 (multi-host)", () => {
  it("start and end markers are distinct HTML comments, keyed by hostId", () => {
    expect(runReportSectionStart("host-a")).toMatch(/^<!--/);
    expect(runReportSectionEnd("host-a")).toMatch(/^<!--/);
    expect(runReportSectionStart("host-a")).not.toBe(runReportSectionEnd("host-a"));
  });

  it("two different hosts get two different marker pairs", () => {
    expect(runReportSectionStart("host-a")).not.toBe(runReportSectionStart("host-b"));
    expect(runReportSectionEnd("host-a")).not.toBe(runReportSectionEnd("host-b"));
  });

  it("titleRunReport prefixes the report with a plain heading naming the host", () => {
    const titled = titleRunReport("## Nothing needs you.", "my-server");
    expect(titled).toContain("Report from my-server");
    expect(titled).toContain("## Nothing needs you.");
    expect(titled.indexOf("Report from my-server")).toBeLessThan(
      titled.indexOf("## Nothing needs you."),
    );
  });
});

describe("runReportNumbers — the three headline numbers", () => {
  const shipped = (n: number) => Array.from({ length: n }, (_, i) => ({ number: 100 + i }));
  it.each([
    { name: "empty run", input: {}, want: { dollarsPerShipped: null, waiting: 0, reachedOwner: 0 } },
    {
      name: "spend with nothing shipped",
      input: { runCost: { totalUsd: 12.5, partial: false } },
      want: { dollarsPerShipped: null, waiting: 0, reachedOwner: 0 },
    },
    {
      name: "three ships share the whole run's spend",
      input: { shipped: shipped(3), runCost: { totalUsd: 37.02, partial: false } },
      want: { dollarsPerShipped: 12.34, waiting: 0, reachedOwner: 0 },
    },
    {
      name: "waiting counts every distinct waiting ticket, this run's and earlier ones",
      input: {
        shipped: shipped(2),
        runCost: { totalUsd: 20, partial: false },
        waiting: [{ number: 5 }, { number: 5 }],
        alreadyWaiting: [{ number: 6 }, { number: 5 }],
      },
      want: { dollarsPerShipped: 10, waiting: 2, reachedOwner: 0 },
    },
    {
      name: "only a needs-you stop reaches the owner",
      input: {
        shipped: shipped(1),
        runCost: { totalUsd: 5, partial: false },
        quarantined: [
          { number: 7, label: "stopped:ticket-unclear", needsYou: true },
          { number: 8, label: "stopped:run-fault", needsYou: false },
        ],
      },
      want: { dollarsPerShipped: 5, waiting: 0, reachedOwner: 1 },
    },
    {
      name: "a held run counts once, however many reasons hold it",
      input: {
        shipped: shipped(1),
        runCost: { totalUsd: 5, partial: false },
        heldRun: { reasons: ["deletes rows (a.sql)", "too large: 14 files changed"] },
      },
      want: { dollarsPerShipped: 5, waiting: 0, reachedOwner: 1 },
    },
    {
      name: "errored tickets and run-health warnings are not counted as reaching the owner",
      input: {
        errored: [{ number: 9 }],
        promotionFailed: true,
        previouslyShipped: [{ number: 10 }],
        runCost: { totalUsd: 5, partial: false },
      },
      want: { dollarsPerShipped: null, waiting: 0, reachedOwner: 0 },
    },
  ])("$name", ({ input, want }) => {
    const n = runReportNumbers({ ...emptyInput, ...input } as RunReportInput);
    expect({
      dollarsPerShipped: n.dollarsPerShipped,
      waiting: n.waiting,
      reachedOwner: n.reachedOwner,
    }).toEqual(want);
  });

  it("the headline shows all three numbers above the action list", () => {
    const report = buildRunReport({
      ...emptyInput,
      shipped: [{ number: 1 }, { number: 2 }, { number: 3 }],
      runCost: { totalUsd: 37.02, partial: false },
      alreadyWaiting: [{ number: 4 }],
      quarantined: [{ number: 5, label: "stopped:ticket-unclear", needsYou: true }],
    });
    const headlineSection = report.slice(0, report.indexOf("## Shipped"));
    expect(headlineSection).toContain(
      "- Dollars per shipped ticket: $12.34 ($37.02 spent ÷ 3 shipped)",
    );
    expect(headlineSection).toContain("- Waiting for a session: 1");
    expect(headlineSection).toContain("- Reached you: 1");
    expect(headlineSection.indexOf("Dollars per shipped ticket")).toBeLessThan(
      headlineSection.indexOf("#5"),
    );
  });

  it("says n/a when nothing shipped, and flags a cost that left some models unpriced", () => {
    const none = buildRunReport({ ...emptyInput, runCost: { totalUsd: 8.1, partial: false } });
    expect(none).toContain("- Dollars per shipped ticket: n/a — nothing shipped ($8.10 spent)");
    const partial = buildRunReport({
      ...emptyInput,
      shipped: [{ number: 1 }],
      runCost: { totalUsd: 10, partial: true },
    });
    expect(partial).toContain("$10.00 ($10.00 spent ÷ 1 shipped)");
    expect(partial).toContain("some models have no price, so the real figure is higher");
  });
});

describe("buildRunReport — older tests edited, and ships without a first test", () => {
  it("lists each older-test edit on its own line, saying whether the ticket named that file in advance — never as an owner action", () => {
    const report = buildRunReport({
      ...emptyInput,
      shipped: [{ number: 1235, title: "Mark the live deal lost" }],
      olderTestEdits: [
        {
          byIssue: 1235,
          byTitle: "Mark the live deal lost",
          olderIssue: 1058,
          path: "packages/api/src/__checks__/issue-1058/relist.test.ts",
          linesAdded: 4,
          linesRemoved: 2,
          namedInTicket: true,
        },
        {
          byIssue: 1235,
          byTitle: "Mark the live deal lost",
          olderIssue: 1058,
          path: "packages/api/src/__checks__/issue-1058/other.test.ts",
          linesAdded: 1,
          linesRemoved: 1,
          namedInTicket: false,
        },
      ],
    });
    expect(report).toContain("## Nothing needs you.");
    const section = report.slice(report.indexOf("## Older tests edited"));
    expect(section).toContain(
      "- #1235 Mark the live deal lost edited an older test: packages/api/src/__checks__/issue-1058/relist.test.ts (named in the ticket) — #1058's test, +4/−2",
    );
    expect(section).toContain(
      "- #1235 Mark the live deal lost edited an older test: packages/api/src/__checks__/issue-1058/other.test.ts (NOT named in the ticket — check this one) — #1058's test, +1/−1",
    );
  });

  it("omits the older-tests section when nothing was edited", () => {
    expect(buildRunReport(emptyInput)).not.toContain("## Older tests edited");
  });

  it("lists every ship that had no first test in its own section", () => {
    const report = buildRunReport({
      ...emptyInput,
      shipped: [
        { number: 1, title: "Fix the widget" },
        { number: 2, title: "Add the gadget", noFirstTest: true },
      ],
    });
    const section = report.slice(report.indexOf("## Shipped without a first test"));
    expect(section).toContain("- #2 Add the gadget");
    expect(section).not.toContain("#1 Fix the widget");
    expect(buildRunReport(emptyInput)).not.toContain("## Shipped without a first test");
  });
});

describe("formatTicketEventLine — one fixed-format line per ship, stop or crash", () => {
  it.each([
    {
      in: { issueNumber: 7, event: "shipped" as const, costUsd: 12.346 },
      out: "TICKET #7 shipped label=- cost=$12.35",
    },
    {
      in: { issueNumber: 8, event: "stopped" as const, label: "stopped:ticket-unclear", costUsd: 3 },
      out: "TICKET #8 stopped label=stopped:ticket-unclear cost=$3.00",
    },
    {
      in: { issueNumber: 9, event: "crashed" as const, costUsd: null },
      out: "TICKET #9 crashed label=- cost=n/a",
    },
    {
      in: { issueNumber: 10, event: "stopped" as const, label: "odd label" },
      out: "TICKET #10 stopped label=odd_label cost=n/a",
    },
  ])("$out", ({ in: i, out }) => {
    const line = formatTicketEventLine(i);
    expect(line).toBe(out);
    expect(line).toMatch(TICKET_EVENT_LINE_RE);
  });
});
