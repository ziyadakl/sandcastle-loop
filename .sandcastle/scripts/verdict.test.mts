/**
 * Tests for the verdict CLI itself: argv rules and the rendered count.
 *
 * The verdict's own behaviour — the four values, the body block, the reader,
 * and the rule that a human's verdict is never overwritten — is tested in
 * `lib/state/verdict.test.ts`, and the GitHub calls in
 * `lib/state/gh.verdict.test.ts`. What is left here is what only the CLI can
 * be wrong about.
 */
import { describe, expect, it } from "vitest";

import { describeVerdict, parseArgs, renderCount } from "./verdict.mts";
import type { VerdictCount } from "../lib/state/gh.js";
import {
  VERDICT_GROUNDS_VALUES,
  VERDICT_VALUES,
  type Verdict,
  type VerdictGrounds,
  type VerdictRecord,
} from "../lib/state/verdict.js";

describe("parseArgs", () => {
  it("counts by default, because nobody types the word 'count'", () => {
    expect(parseArgs([])).toEqual({ command: "count", extraIssues: [] });
  });

  it("treats a leading flag as a flag, not as a command", () => {
    // The first real run of this tool typed `--issues 805,820` with no
    // command word and was told `unknown command '--issues'`.
    expect(parseArgs(["--issues", "805,820"])).toEqual({
      command: "count",
      extraIssues: [805, 820],
    });
  });

  it("accepts issue numbers with or without a hash, and drops nonsense", () => {
    expect(parseArgs(["--issues", "#805, 820 ,x,0,-4"])).toEqual({
      command: "count",
      extraIssues: [805, 820],
    });
  });

  it("reads show and set", () => {
    expect(parseArgs(["show", "#1056"])).toEqual({ command: "show", issue: 1056 });
    expect(parseArgs(["set", "1056", "checks-wrong", "--why", "the ticket asked for the team total"]))
      .toEqual({
        command: "set",
        issue: 1056,
        verdict: "checks-wrong",
        why: "the ticket asked for the team total",
      });
  });

  it("refuses a verdict outside the four, naming the four", () => {
    expect(() => parseArgs(["set", "1056", "the-check-was-silly"])).toThrow(
      /checks-wrong/,
    );
  });

  it("refuses a command it does not have, and a missing issue number", () => {
    expect(() => parseArgs(["delete", "1056"])).toThrow(/unknown command/);
    expect(() => parseArgs(["show"])).toThrow(/not an issue number/);
  });

  it("asks for help", () => {
    expect(parseArgs(["--help"])).toEqual({ command: "help" });
  });
});

describe("renderCount", () => {
  const tally = {
    counts: {
      "checks-wrong": 2,
      "builder-wrong": 1,
      "neither-side": 0,
      "ticket-silent": 0,
      unrecorded: 3,
      byGrounds: {
        "with-check": { "checks-wrong": 2, "builder-wrong": 1, "neither-side": 0, "ticket-silent": 0 },
        "no-check": { "checks-wrong": 0, "builder-wrong": 0, "neither-side": 0, "ticket-silent": 0 },
        "not-stated": { "checks-wrong": 0, "builder-wrong": 0, "neither-side": 0, "ticket-silent": 0 },
      },
    },
    unruledIssues: [805, 820, 1056],
    issuesRead: [805, 820, 845, 848, 1056, 1099],
  } as const;

  it("names every unruled ticket rather than only counting them", () => {
    const out = renderCount(tally);
    expect(out).toContain("#805, #820, #1056");
    expect(out).toContain("Tickets read: 6. Ruled: 3.");
  });

  it("says nothing about unruled tickets when there are none", () => {
    const out = renderCount({ ...tally, unruledIssues: [] });
    expect(out).not.toContain("Still unruled");
  });
});

describe("the count never overstates its own denominator", () => {
  const result = {
    counts: {
      "checks-wrong": 1,
      "builder-wrong": 0,
      "neither-side": 0,
      "ticket-silent": 0,
      unrecorded: 0,
      byGrounds: {
        "with-check": { "checks-wrong": 1, "builder-wrong": 0, "neither-side": 0, "ticket-silent": 0 },
        "no-check": { "checks-wrong": 0, "builder-wrong": 0, "neither-side": 0, "ticket-silent": 0 },
        "not-stated": { "checks-wrong": 0, "builder-wrong": 0, "neither-side": 0, "ticket-silent": 0 },
      },
    },
    unruledIssues: [],
    issuesRead: [1056],
  } as const;

  it("warns that the pre-label era is missing when nobody asked for it", () => {
    // The `stopped:*` labels began in August 2026. Six of the eight
    // disagreements this tool exists to settle are older than them, so a
    // bare count is the labelled era only and must say so.
    const out = renderCount(result, false);
    expect(out).toContain("NOT COUNTED");
    expect(out).toContain("--issues 805,820,845,848,850,860");
    expect(out).not.toContain("every disagreement GitHub knows about");
  });

  it("drops the warning once the older tickets were asked for by number", () => {
    expect(renderCount(result, true)).not.toContain("NOT COUNTED");
  });
});

describe("a flag never swallows the flag after it", () => {
  it("records no reason when --why is followed by another flag", () => {
    expect(parseArgs(["set", "12", "checks-wrong", "--why", "--issues", "3"])).toEqual({
      command: "set",
      issue: 12,
      verdict: "checks-wrong",
      why: undefined,
    });
  });
});

/** A zero for every verdict — a fixture names only the cells it cares about. */
const zeroes = (): Record<Verdict, number> =>
  Object.fromEntries(VERDICT_VALUES.map((v) => [v, 0])) as Record<Verdict, number>;

const countWith = (
  byGrounds: Partial<Record<VerdictGrounds, Partial<Record<Verdict, number>>>>,
): VerdictCount => {
  const full = {
    "with-check": { ...zeroes(), ...byGrounds["with-check"] },
    "no-check": { ...zeroes(), ...byGrounds["no-check"] },
    "not-stated": { ...zeroes(), ...byGrounds["not-stated"] },
  };
  const flat = zeroes();
  for (const g of VERDICT_GROUNDS_VALUES) {
    for (const v of VERDICT_VALUES) flat[v] += full[g][v];
  }
  return {
    counts: { ...flat, unrecorded: 0, byGrounds: full },
    unruledIssues: [],
    issuesRead: [1, 2, 3],
  };
};

describe("the one number does not mix a wrong check with a refusal that had none", () => {
  it("keeps a no-check refusal out of the figure, and still shows it", () => {
    // THE BLOCKER. Three tickets say `checks-wrong`; only two of them had a
    // check that could have been wrong. The old heading counted all three.
    const out = renderCount(
      countWith({
        "with-check": { "checks-wrong": 2, "builder-wrong": 1 },
        "no-check": { "checks-wrong": 1, "ticket-silent": 1 },
      }),
      true,
    );
    // The figure is over the three arguments that had a check, not the five
    // rulings, and not the three tickets saying `checks-wrong`.
    expect(out).toContain("Of those, 2 were the check's fault");
    expect(out).not.toContain("Of those, 3 were the check's fault");
    // Nothing recorded is hidden: the excluded pair is printed, under a
    // heading saying plainly why it is not in the figure above.
    expect(out).toContain("no check behind");
    expect(out).toMatch(/1\s+checks-wrong/);
  });

  it("says there is no rate to read, rather than printing a rate of zero", () => {
    const out = renderCount(countWith({ "no-check": { "checks-wrong": 2 } }), true);
    expect(out).toContain("no rate to read off this");
    expect(out).not.toContain("— 0%");
  });

  it("shows a ruling whose source was never recorded, apart from both", () => {
    // Every verdict written before the source field existed, and every one
    // the owner types by hand. Folding these into the figure would be a
    // guess; dropping them would lose them.
    const out = renderCount(countWith({ "not-stated": { "builder-wrong": 4 } }), true);
    expect(out).toContain("never said where the argument came from");
    expect(out).toMatch(/4\s+builder-wrong/);
  });
});

// Issue #1133, items 3 and 27. The denominator block used to be headed "Every
// check the judge opened before a builder started". Two separate ways that is
// untrue: the block is REPLACED every run, so a ticket read on ten nights
// contributes one, not ten; and on a night the judge could not be reached the
// run's own file comparison can produce a reading the judge never made.
describe("the denominator says what it actually counted", () => {
  const result = {
    counts: {
      "checks-wrong": 0,
      "builder-wrong": 0,
      "neither-side": 0,
      "ticket-silent": 0,
      unrecorded: 0,
      byGrounds: {
        "with-check": { "checks-wrong": 0, "builder-wrong": 0, "neither-side": 0, "ticket-silent": 0 },
        "no-check": { "checks-wrong": 0, "builder-wrong": 0, "neither-side": 0, "ticket-silent": 0 },
        "not-stated": { "checks-wrong": 0, "builder-wrong": 0, "neither-side": 0, "ticket-silent": 0 },
      },
    },
    unruledIssues: [],
    issuesRead: [],
  } as const;
  const readings = {
    counts: { sound: 3, "too-weak": 1, "ticket-unclear": 0, unrecorded: 0, total: 4 },
    unreadIssues: [],
    issuesRead: [11, 12, 13, 14],
  } as const;

  it("never claims to have counted every check the judge opened", () => {
    const out = renderCount(result, true, readings);
    expect(out).not.toContain("Every check the judge opened");
  });

  it("says one per ticket, latest reading — not one per reading", () => {
    const out = renderCount(result, true, readings);
    expect(out).toContain("Tickets carrying a recorded check reading");
    expect(out).toContain("One per ticket");
    expect(out).toContain("Tickets with a recorded reading: 4");
  });

  it("says a reading is not always the judge's", () => {
    expect(renderCount(result, true, readings)).toContain(
      "could not be reached",
    );
  });

  it("still prints the block when nothing has been read", () => {
    const empty = {
      counts: { sound: 0, "too-weak": 0, "ticket-unclear": 0, unrecorded: 0, total: 0 },
      unreadIssues: [],
      issuesRead: [],
    } as const;
    const out = renderCount(result, true, empty);
    expect(out).toContain("Tickets carrying a recorded check reading");
    expect(out).toContain("no rate to read off this");
  });
});

describe("reading one ticket back", () => {
  const rec = (over: Partial<VerdictRecord> = {}): VerdictRecord => ({
    verdict: "checks-wrong",
    decidedBy: "judge",
    whenIso: "2026-08-19T09:00:00.000Z",
    runId: "run-1",
    ...over,
  });

  it("prints where the argument came from", () => {
    expect(describeVerdict(rec({ source: "screen-check" }))).toContain("screen-check");
    expect(describeVerdict(rec())).toContain("(not stated)");
  });

  it("warns when 'the check was wrong' is not true of this ticket", () => {
    const out = describeVerdict(rec({ source: "reviewer-no-check" }));
    expect(out).toContain("no check behind");
    expect(describeVerdict(rec({ source: "screen-check" }))).not.toContain("no check behind");
  });

  // Issue #1133, item 5: a ruling that was paid for and then superseded is
  // kept on the ticket, so the one command that reads a ticket back prints it.
  it("prints the rulings this one replaced", () => {
    const out = describeVerdict(
      rec({
        verdict: "builder-wrong",
        source: "screen-check",
        superseded: [
          {
            verdict: "checks-wrong",
            decidedBy: "judge",
            whenIso: "2026-08-19T08:00:00.000Z",
            source: "reviewer-red-check",
            why: "The reviewer refused over a check that had gone red.",
          },
        ],
      }),
    );
    expect(out).toContain("Earlier rulings");
    expect(out).toContain("checks-wrong");
    expect(out).toContain("reviewer-red-check");
  });

  it("says nothing about earlier rulings when there are none", () => {
    expect(describeVerdict(rec())).not.toContain("Earlier rulings");
  });
});
