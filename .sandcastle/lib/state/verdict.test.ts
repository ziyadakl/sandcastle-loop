/**
 * Issue #1117 — the verdict slot becomes writable. The PURE half: render a
 * verdict into an issue-body block, read it back, refuse to trample a
 * human's correction, and tally a set of them.
 */
import { describe, expect, it } from "vitest";

import {
  VERDICT_VALUES,
  VERDICT_LABEL_DEFINITIONS,
  VERDICT_NEEDED_LABEL,
  buildVerdictSection,
  carryVerdictHistory,
  decideVerdictWrite,
  parseVerdictSection,
  tallyVerdicts,
  upsertVerdictSection,
  verdictGrounds,
  verdictLabelFor,
  VERDICT_GROUNDS_VALUES,
  type Verdict,
  type VerdictRecord,
} from "./verdict.js";
import { upsertStopSection } from "./stop-reasons.js";

const rec = (over: Partial<VerdictRecord> = {}): VerdictRecord => ({
  verdict: "checks-wrong",
  decidedBy: "judge",
  whenIso: "2026-08-19T09:00:00.000Z",
  runId: "run-1",
  why: "The ticket asked for the team total; the check asserted one agent's figure.",
  ...over,
});

const bodyWith = (r: VerdictRecord): string =>
  upsertVerdictSection("Ticket description.", buildVerdictSection(r));

describe("the four values", () => {
  it("carries exactly the four outcomes the owner ruled on, and no fifth", () => {
    expect([...VERDICT_VALUES]).toEqual([
      "checks-wrong",
      "builder-wrong",
      "neither-side",
      "ticket-silent",
    ]);
  });

  it("every value has a label definition, so every verdict is countable", () => {
    expect(VERDICT_LABEL_DEFINITIONS.map((d) => d.verdict).sort()).toEqual(
      [...VERDICT_VALUES].sort(),
    );
    for (const def of VERDICT_LABEL_DEFINITIONS) {
      expect(def.name).toBe(verdictLabelFor(def.verdict));
      // `gh label create` rejects a description over 100 characters with a
      // HTTP 422 — the same trap the stop labels hit while being built.
      expect(def.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("write it, then read it back", () => {
  it.each([...VERDICT_VALUES])("round-trips %s", (verdict) => {
    const body = upsertVerdictSection("", buildVerdictSection(rec({ verdict })));
    expect(parseVerdictSection(body)?.verdict).toBe(verdict);
  });

  it("keeps the ticket's own description untouched", () => {
    const original = "## What is wrong\n\nThe team total counts one agent twice.";
    const body = upsertVerdictSection(original, buildVerdictSection(rec()));
    expect(body.startsWith(original)).toBe(true);
    expect(parseVerdictSection(body)?.why).toContain("team total");
  });

  it("reads back who decided it, and when", () => {
    const body = upsertVerdictSection("", buildVerdictSection(rec()));
    const read = parseVerdictSection(body);
    expect(read?.decidedBy).toBe("judge");
    expect(read?.whenIso).toBe("2026-08-19T09:00:00.000Z");
    expect(read?.runId).toBe("run-1");
  });

  it("a second write replaces the block rather than appending a second one", () => {
    let body = upsertVerdictSection("Ticket text.", buildVerdictSection(rec()));
    body = upsertVerdictSection(
      body,
      buildVerdictSection(rec({ verdict: "builder-wrong" })),
    );
    expect(parseVerdictSection(body)?.verdict).toBe("builder-wrong");
    expect(body.match(/## Verdict/g)).toHaveLength(1);
  });

  it("says nothing is recorded when there is no verdict block", () => {
    expect(parseVerdictSection("")).toBeUndefined();
    expect(parseVerdictSection("Just the ticket description.")).toBeUndefined();
  });
});

describe("the owner overturns a verdict by hand", () => {
  it("reads a value a person typed over the top, and marks it human-set", () => {
    const body = upsertVerdictSection("", buildVerdictSection(rec()))
      .replace("`checks-wrong`", "`builder-wrong`")
      .replace("`judge`", "`human`");
    const read = parseVerdictSection(body);
    expect(read?.verdict).toBe("builder-wrong");
    expect(read?.decidedBy).toBe("human");
  });

  it("a human verdict is never overwritten by the run's judge", () => {
    const existing = rec({ verdict: "builder-wrong", decidedBy: "human" });
    expect(
      decideVerdictWrite(existing, rec({ verdict: "checks-wrong" })),
    ).toBe("keep-human");
  });

  it("a judge verdict IS replaced by a later judge verdict", () => {
    expect(
      decideVerdictWrite(rec(), rec({ verdict: "neither-side" })),
    ).toBe("write");
  });

  it("a human may overturn their own earlier verdict", () => {
    const existing = rec({ decidedBy: "human" });
    expect(
      decideVerdictWrite(
        existing,
        rec({ verdict: "ticket-silent", decidedBy: "human" }),
      ),
    ).toBe("write");
  });

  it("writes when nothing is there yet", () => {
    expect(decideVerdictWrite(undefined, rec())).toBe("write");
  });

  it("ignores a value that is not one of the four", () => {
    const body = upsertVerdictSection("", buildVerdictSection(rec())).replace(
      "`checks-wrong`",
      "`the check was being silly`",
    );
    expect(parseVerdictSection(body)).toBeUndefined();
  });

  it("ignores a half-deleted block rather than parsing the rest of the ticket", () => {
    const body = upsertVerdictSection("Ticket text.", buildVerdictSection(rec()));
    const halved = body.replace("<!-- sandcastle:verdict:end -->", "");
    expect(parseVerdictSection(halved)).toBeUndefined();
  });
});

describe("the verdict block lives beside the stop block, never inside it", () => {
  it("survives the run stopping the same ticket again the next night", () => {
    let body = upsertVerdictSection("Ticket text.", buildVerdictSection(rec({ decidedBy: "human" })));
    body = upsertStopSection(body, "## Stopped: check disagreement\n\nSecond night.");
    expect(parseVerdictSection(body)?.verdict).toBe("checks-wrong");
    expect(parseVerdictSection(body)?.decidedBy).toBe("human");
    expect(body).toContain("Second night.");
  });

  it("a watched ticket that was never stopped can still carry a verdict", () => {
    // Watch-only means no stop block and no `stopped:*` label at all. The
    // verdict must not depend on either (issue #1117 acceptance 4).
    const body = upsertVerdictSection(
      "Ticket text.",
      buildVerdictSection(rec({ verdict: "neither-side" })),
    );
    expect(body).not.toContain("sandcastle:stop-report");
    expect(parseVerdictSection(body)?.verdict).toBe("neither-side");
  });
});

/** A zero for every verdict, so a tally expectation can name only what it
 *  cares about without losing the exhaustive `toEqual`. */
const zeroes = (): Record<Verdict, number> =>
  Object.fromEntries(VERDICT_VALUES.map((v) => [v, 0])) as Record<Verdict, number>;

describe("counting how often the check was the wrong one", () => {
  it("tallies every value, including the ones nobody scored", () => {
    const bodies = (["checks-wrong", "checks-wrong", "builder-wrong"] as Verdict[]).map(
      (v) => upsertVerdictSection("", buildVerdictSection(rec({ verdict: v }))),
    );
    bodies.push("a ticket with no verdict at all");
    expect(tallyVerdicts(bodies)).toEqual({
      "checks-wrong": 2,
      "builder-wrong": 1,
      "neither-side": 0,
      "ticket-silent": 0,
      unrecorded: 1,
      byGrounds: {
        // No `source` on any of them, so none may be claimed for the
        // with-check figure.
        "with-check": zeroes(),
        "no-check": zeroes(),
        "not-stated": { ...zeroes(), "checks-wrong": 2, "builder-wrong": 1 },
      },
    });
  });
});

describe("the faults the 2026-08-19 review found", () => {
  it("counts a hand-typed name as a person, not as the run's judge", () => {
    // A verdict the owner overturned must never be read as the judge's own,
    // or the next night's run overwrites his answer.
    for (const written of ["`Alex`", "`me`", "human", "Alex", "`HUMAN`"]) {
      const body = upsertVerdictSection("", buildVerdictSection(rec())).replace(
        "**Decided by:** `judge`",
        `**Decided by:** ${written}`,
      );
      expect(parseVerdictSection(body)?.decidedBy).toBe("human");
    }
  });

  it("still reads the run's own verdict as the judge's", () => {
    const body = upsertVerdictSection("", buildVerdictSection(rec()));
    expect(parseVerdictSection(body)?.decidedBy).toBe("judge");
  });

  it("keeps a reason that quotes the ticket, instead of cutting it in half", () => {
    const why = 'The ticket says:\n> the team total, not one agent\nThe check asserted one agent.';
    const body = upsertVerdictSection("", buildVerdictSection(rec({ why })));
    expect(parseVerdictSection(body)?.why).toBe(why);
  });

  it("the label saying a ruling is owed is not one of the four outcomes", () => {
    expect(VERDICT_LABEL_DEFINITIONS.map((d) => d.name)).not.toContain(
      VERDICT_NEEDED_LABEL,
    );
    expect(VERDICT_NEEDED_LABEL.startsWith("stopped:")).toBe(false);
  });
});

describe("a refusal with no check behind it is not a wrong check", () => {
  const bodyFor = (verdict: Verdict, source?: string): string =>
    upsertVerdictSection("", buildVerdictSection(rec({ verdict, source })));

  it("carries the source through the block and back out again", () => {
    // The one field saying whether "the check was wrong" is even true of a
    // ticket. It had no test at all before this.
    const body = bodyFor("checks-wrong", "reviewer-no-check");
    expect(parseVerdictSection(body)?.source).toBe("reviewer-no-check");
    expect(parseVerdictSection(bodyFor("checks-wrong"))?.source).toBeUndefined();
  });

  it("sorts each source into whether a check stood behind the argument", () => {
    expect(verdictGrounds("screen-check")).toBe("with-check");
    expect(verdictGrounds("reviewer-red-check")).toBe("with-check");
    expect(verdictGrounds("reviewer-no-check")).toBe("no-check");
  });

  it("files an absent or unknown source apart, rather than guessing it had a check", () => {
    // Guessing "with-check" would inflate the very number this exists to
    // produce; guessing "no-check" would hide real wrong checks. Neither is
    // a reading, so it gets its own pile.
    expect(verdictGrounds(undefined)).toBe("not-stated");
    expect(verdictGrounds("")).toBe("not-stated");
    expect(verdictGrounds("some later path nobody has written yet")).toBe("not-stated");
  });

  it("keeps a no-check `checks-wrong` out of the with-check figure", () => {
    // THE BLOCKER, in one assertion. Three tickets say `checks-wrong`, but
    // only two of them had a check that could be wrong.
    const t = tallyVerdicts([
      bodyFor("checks-wrong", "screen-check"),
      bodyFor("checks-wrong", "reviewer-red-check"),
      bodyFor("checks-wrong", "reviewer-no-check"),
      bodyFor("builder-wrong", "reviewer-no-check"),
      bodyFor("neither-side"),
      "a ticket with no verdict at all",
    ]);
    expect(t["checks-wrong"]).toBe(3);
    expect(t.byGrounds["with-check"]["checks-wrong"]).toBe(2);
    expect(t.byGrounds["no-check"]["checks-wrong"]).toBe(1);
    expect(t.byGrounds["no-check"]["builder-wrong"]).toBe(1);
    expect(t.byGrounds["not-stated"]["neither-side"]).toBe(1);
    expect(t.unrecorded).toBe(1);
  });

  it("loses nothing: every ruling lands in exactly one of the three piles", () => {
    const bodies = [
      bodyFor("checks-wrong", "screen-check"),
      bodyFor("ticket-silent", "reviewer-no-check"),
      bodyFor("builder-wrong"),
    ];
    const t = tallyVerdicts(bodies);
    const perGroup = VERDICT_GROUNDS_VALUES.map((g) =>
      VERDICT_VALUES.reduce((sum, v) => sum + t.byGrounds[g][v], 0),
    );
    expect(perGroup.reduce((a, b) => a + b, 0)).toBe(bodies.length);
    expect(VERDICT_VALUES.reduce((sum, v) => sum + t[v], 0)).toBe(bodies.length);
  });
});

describe("a second ruling never silently erases the first (issue #1133, item 5)", () => {
  it("carries the ruling being replaced into the new record's history", () => {
    const first = rec({ verdict: "checks-wrong", source: "reviewer-red-check" });
    const second = rec({
      verdict: "builder-wrong",
      source: "screen-check",
      whenIso: "2026-08-19T11:00:00.000Z",
    });
    const merged = carryVerdictHistory(first, second);
    expect(merged.verdict).toBe("builder-wrong");
    expect(merged.superseded).toHaveLength(1);
    expect(merged.superseded?.[0]?.verdict).toBe("checks-wrong");
    expect(merged.superseded?.[0]?.source).toBe("reviewer-red-check");
  });

  it("keeps every earlier ruling, not just the one before last", () => {
    const a = rec({ verdict: "checks-wrong", source: "reviewer-red-check" });
    const b = rec({ verdict: "builder-wrong", source: "screen-check" });
    const c = rec({ verdict: "neither-side", source: "screen-check" });
    const merged = carryVerdictHistory(carryVerdictHistory(a, b), c);
    expect(merged.superseded?.map((s) => s.verdict)).toEqual([
      "checks-wrong",
      "builder-wrong",
    ]);
  });

  it("does not pile up copies of an identical re-ruling", () => {
    const first = rec({ verdict: "checks-wrong", source: "screen-check" });
    const again = rec({
      verdict: "checks-wrong",
      source: "screen-check",
      whenIso: "2026-08-20T09:00:00.000Z",
    });
    expect(carryVerdictHistory(first, again).superseded).toBeUndefined();
  });

  it("survives the round trip through the ticket body", () => {
    const merged = carryVerdictHistory(
      rec({ verdict: "checks-wrong", source: "reviewer-red-check" }),
      rec({ verdict: "builder-wrong", source: "screen-check" }),
    );
    const back = parseVerdictSection(bodyWith(merged));
    expect(back?.verdict).toBe("builder-wrong");
    expect(back?.source).toBe("screen-check");
    expect(back?.superseded).toHaveLength(1);
    expect(back?.superseded?.[0]).toMatchObject({
      verdict: "checks-wrong",
      decidedBy: "judge",
      source: "reviewer-red-check",
      whenIso: "2026-08-19T09:00:00.000Z",
    });
    expect(back?.superseded?.[0]?.why).toContain("team total");
  });

  it("reads the CURRENT ruling, never an earlier one, off a body carrying both", () => {
    const merged = carryVerdictHistory(
      rec({ verdict: "checks-wrong", source: "reviewer-red-check" }),
      rec({ verdict: "ticket-silent", source: "screen-check", why: "The ticket never said." }),
    );
    const back = parseVerdictSection(bodyWith(merged));
    expect(back?.verdict).toBe("ticket-silent");
    expect(back?.why).toBe("The ticket never said.");
  });

  it("counts a ticket with a history ONCE, under its current ruling", () => {
    const merged = carryVerdictHistory(
      rec({ verdict: "checks-wrong", source: "screen-check" }),
      rec({ verdict: "builder-wrong", source: "screen-check" }),
    );
    const t = tallyVerdicts([bodyWith(merged)]);
    expect(t["builder-wrong"]).toBe(1);
    expect(t["checks-wrong"]).toBe(0);
    expect(t.byGrounds["with-check"]["builder-wrong"]).toBe(1);
  });

  it("a hand-set verdict still outranks the run, history or not", () => {
    const human = rec({ decidedBy: "human" });
    expect(decideVerdictWrite(human, rec({ decidedBy: "judge" }))).toBe("keep-human");
  });
});
