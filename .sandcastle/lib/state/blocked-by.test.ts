/**
 * The `Blocked-by:` gate's rule, proven without a run.
 *
 * Two readers wire this in: `eligibleForPlanning` (`./eligible-set.ts`), which
 * builds the plan, and `blockedByGate` (`main.mts`), which re-checks a card at
 * deal time. Their wiring is proven in `main.test.mts`'s "Blocked-by is a code
 * gate" describe. Here we pin the RULE, because a rule that only exists inside
 * a 25k-line orchestrator is a rule nobody can check.
 */
import { describe, expect, it } from "vitest";

import {
  describeUnresolvedBlockers,
  parseBlockedBy,
  unresolvedBlockers,
} from "./blocked-by.js";

const open = (
  ...rows: [number, ...string[]][]
): { number: number; labels: string[] }[] =>
  rows.map(([number, ...labels]) => ({ number, labels }));

describe("parseBlockedBy — both declared forms", () => {
  it("reads the inline form `Blocked by: #N`", () => {
    expect(parseBlockedBy("Blocked by: #1038\n\nSome ticket text.")).toEqual([
      1038,
    ]);
  });

  it("reads the hyphenated form `Blocked-by: #N` (the 2026-09-03 miss)", () => {
    expect(parseBlockedBy("Blocked-by: #1038\n")).toEqual([1038]);
  });

  it("is case-insensitive and tolerates loose whitespace", () => {
    expect(parseBlockedBy("   BLOCKED   BY :   #7  ")).toEqual([7]);
  });

  it("takes EVERY `#N` on one directive line", () => {
    expect(parseBlockedBy("Blocked by: #313, #314 and #315")).toEqual([
      313, 314, 315,
    ]);
  });

  it("reads the header form — refs on the lines under `## Blocked by`", () => {
    const body = ["## Blocked by", "- #11", "- #12", "", "## Notes", "- #99"].join(
      "\n",
    );
    expect(parseBlockedBy(body)).toEqual([11, 12]);
  });

  it("stops the header form at the next heading, not just at a blank line", () => {
    const body = ["### Blocked by", "#21", "## Acceptance", "#22"].join("\n");
    expect(parseBlockedBy(body)).toEqual([21]);
  });

  it("stacks both forms, de-duplicated and ascending", () => {
    const body = [
      "Blocked-by: #40",
      "",
      "## Blocked by",
      "#12 and #40 again",
      "",
    ].join("\n");
    expect(parseBlockedBy(body)).toEqual([12, 40]);
  });

  it("ignores a directive inside a fenced code block — a quotation is not a declaration", () => {
    const body = [
      "This ticket documents the syntax.",
      "",
      "```md",
      "Blocked by: #9",
      "```",
      "",
      "It declares no blockers of its own.",
    ].join("\n");
    expect(parseBlockedBy(body)).toEqual([]);
  });

  it("ignores a `~~~` fence too, and one left unterminated at the end", () => {
    expect(parseBlockedBy("~~~\nBlocked by: #9\n~~~\n")).toEqual([]);
    expect(parseBlockedBy("intro\n```\nBlocked by: #9\n")).toEqual([]);
  });

  it("still reads a REAL directive in a body that also quotes one in a fence", () => {
    const body = [
      "Blocked-by: #40",
      "",
      "```",
      "Blocked by: #9",
      "```",
    ].join("\n");
    expect(parseBlockedBy(body)).toEqual([40]);
  });

  it("ignores a directive the LOOP wrote back into the body", () => {
    // `applyStopReport` and friends quote a ticket's own text into a machine
    // section. Reading that back would re-declare a blocker forever after the
    // blocker had closed.
    const body = [
      "An ordinary ticket.",
      "",
      "<!-- sandcastle:stop-report:start -->",
      "The run stopped because Blocked by: #9 was unresolved.",
      "<!-- sandcastle:stop-report:end -->",
    ].join("\n");
    expect(parseBlockedBy(body)).toEqual([]);
  });

  it("ignores an UNTERMINATED machine section — an interrupted run's body", () => {
    const body = [
      "An ordinary ticket.",
      "",
      "<!-- sandcastle:stop-report:start -->",
      "Blocked by: #9",
    ].join("\n");
    expect(parseBlockedBy(body)).toEqual([]);
  });

  it("finds nothing in a body that declares nothing", () => {
    expect(parseBlockedBy("Just a ticket. Mentions #99 in passing.")).toEqual(
      [],
    );
    expect(parseBlockedBy("")).toEqual([]);
  });
});

describe("unresolvedBlockers — HARD RULE 2's resolution rule", () => {
  it("RESOLVED by absence: a blocker that is no longer open blocks nothing", () => {
    expect(unresolvedBlockers("Blocked by: #1038", open([1065, "ready-for-agent"]))).toEqual(
      [],
    );
  });

  it("RESOLVED by `shipped-local` — open, but done and sitting on the run branch", () => {
    expect(
      unresolvedBlockers("Blocked-by: #1038", open([1038, "shipped-local"])),
    ).toEqual([]);
  });

  it("RESOLVED by `done`", () => {
    expect(unresolvedBlockers("Blocked by: #1038", open([1038, "done"]))).toEqual(
      [],
    );
  });

  it("UNRESOLVED while the blocker is `in-progress` — the 2026-09-03 case", () => {
    expect(
      unresolvedBlockers("Blocked-by: #1038", open([1038, "in-progress", "type:backend"])),
    ).toEqual([1038]);
  });

  it("UNRESOLVED on `needs-human` — a person must act, so it still blocks", () => {
    expect(
      unresolvedBlockers("Blocked by: #51", open([51, "needs-human"])),
    ).toEqual([51]);
  });

  it("UNRESOLVED on `quarantine` — the loop failed on it, so it still blocks", () => {
    expect(
      unresolvedBlockers("Blocked by: #51", open([51, "quarantine", "stopped:run-fault"])),
    ).toEqual([51]);
  });

  it("UNRESOLVED with no labels at all", () => {
    expect(unresolvedBlockers("Blocked by: #51", open([51]))).toEqual([51]);
  });

  it("blockers from BOTH forms stack — one resolved sibling does not clear the other", () => {
    const body = ["Blocked-by: #40", "", "## Blocked by", "#12", ""].join("\n");
    expect(
      unresolvedBlockers(body, open([12, "in-progress"], [40, "shipped-local"])),
    ).toEqual([12]);
  });

  it("TRUNCATED listing: a blocker that is not in it is UNRESOLVED, not resolved", () => {
    // The fail-open bug this closes: `listOpenIssuesWithBodies` caps at 500
    // rows, so a blocker cut off the end of a capped listing read as "closed"
    // and its dependent was dealt while the blocker was still building.
    expect(
      unresolvedBlockers("Blocked-by: #1038", open([1065, "ready-for-agent"]), {
        listingTruncated: true,
      }),
    ).toEqual([1038]);
  });

  it("TRUNCATED listing still resolves a blocker it CAN see as `shipped-local`", () => {
    expect(
      unresolvedBlockers("Blocked-by: #1038", open([1038, "shipped-local"]), {
        listingTruncated: true,
      }),
    ).toEqual([]);
  });

  it("a COMPLETE listing keeps resolving on absence — truncation is the only inversion", () => {
    expect(
      unresolvedBlockers("Blocked-by: #1038", open([1065, "ready-for-agent"]), {
        listingTruncated: false,
      }),
    ).toEqual([]);
  });

  it("a body declaring nothing is never blocked, whatever is open", () => {
    expect(
      unresolvedBlockers("no directive here", open([12, "in-progress"])),
    ).toEqual([]);
  });
});

describe("describeUnresolvedBlockers — the run-log line", () => {
  it("names each blocker with the labels it is actually wearing", () => {
    expect(
      describeUnresolvedBlockers([1038], open([1038, "in-progress", "type:backend"])),
    ).toBe("blocked by #1038 (open, labels: in-progress, type:backend)");
  });

  it("says `none` rather than an empty bracket when a blocker has no labels", () => {
    expect(describeUnresolvedBlockers([51], open([51]))).toBe(
      "blocked by #51 (open, labels: none)",
    );
  });

  it("says the listing was capped for a blocker it could not see at all", () => {
    expect(describeUnresolvedBlockers([1038], open([1065, "ready-for-agent"]))).toBe(
      "blocked by #1038 (not in the capped open-issue listing — cannot be proven resolved)",
    );
  });

  it("joins several blockers into one line", () => {
    expect(
      describeUnresolvedBlockers([12, 40], open([12, "in-progress"], [40, "quarantine"])),
    ).toBe(
      "blocked by #12 (open, labels: in-progress), #40 (open, labels: quarantine)",
    );
  });
});
