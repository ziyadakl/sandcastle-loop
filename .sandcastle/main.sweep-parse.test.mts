// Regression tests for the reviewer's CATEGORY SWEEP parser (issue #1082).
//
// WHAT BROKE. `extractCategorySweep` split each bullet on its LAST `": "`. That
// rule exists so a category whose own name holds a colon still parses. But a
// reviewer that explains an `ok` inside a parenthetical containing a colon put
// the last `": "` INSIDE the parenthetical. The category came out as half a
// sentence, the status came out as the remains of the explanation, and — since
// that matched no status word — the line was recorded as a `finding` under a
// category that does not exist. That phantom appeared in round one, was absent
// from round two, and `priorFindingsResolved` therefore denied the ticket its
// third attempt for a blocker nobody had raised. Two of the six stops on the
// 2026-08-14 run were this.
//
// Both halves are pinned here because they pull in opposite directions: fixing
// the parenthetical case by splitting on the FIRST colon would break the
// colon-in-the-category case the old rule was written for.

import { describe, expect, it } from "vitest";

import {
  chooseSweepSplit,
  classifySweepStatus,
  extractCategorySweep,
  latestSweepEarnsRound3,
  priorFindingsResolved,
  thirdAttemptDenyReason,
  topLevelColonSpaces,
} from "./main.mts";

/** Wrap bullets in the header/terminator the parser anchors on. */
function sweep(...bullets: readonly string[]): string {
  return ["CATEGORY SWEEP:", ...bullets, "SWEEP COMPLETE."].join("\n");
}

/** The category the SHIPPED selection rule picks, for readability. */
function categoryOf(body: string): string {
  const split = chooseSweepSplit(body);
  return split === null ? "" : body.slice(0, split.splitAt);
}

describe("topLevelColonSpaces", () => {
  it("finds a plain separator", () => {
    expect(topLevelColonSpaces("Spec fit: ok")).toEqual([8]);
  });

  it("skips a colon inside parentheses, brackets, braces or quotes", () => {
    for (const body of [
      "Perf: ok (note: fine)",
      "Perf: ok [note: fine]",
      "Perf: ok {note: fine}",
      'Perf: ok "note: fine"',
    ]) {
      expect(topLevelColonSpaces(body)).toEqual([4]);
    }
  });

  it("clamps an unbalanced closer instead of going negative", () => {
    // A stray `)` must not lose the line.
    expect(categoryOf("Spec fit): ok")).toBe("Spec fit)");
  });

  it("returns nothing when the line carries no separator", () => {
    expect(topLevelColonSpaces("no separator here")).toEqual([]);
    // A bare trailing colon is not a separator: the parser needs `": "`.
    expect(topLevelColonSpaces("Spec fit:")).toEqual([]);
  });
});

describe("classifySweepStatus", () => {
  it("recognises the four status shapes", () => {
    expect(classifySweepStatus("ok")).toBe("ok");
    expect(classifySweepStatus("ok.")).toBe("ok");
    expect(classifySweepStatus("ok (re-run by me: 2 passed)")).toBe("ok");
    expect(classifySweepStatus("n/a")).toBe("n/a");
    expect(classifySweepStatus("n/a (no schema change)")).toBe("n/a");
  });

  it("returns null for anything else, so a hedged ok stays a finding", () => {
    expect(classifySweepStatus("ok \u2014 actually it throws")).toBeNull();
    expect(classifySweepStatus("leaks a 500")).toBeNull();
  });
});

describe("choosing the separator", () => {
  it("prefers the last unnested colon whose remainder IS a status", () => {
    const body = 'Execution evidence: ok (re-run by me: "2 passed")';
    expect(categoryOf(body)).toBe("Execution evidence");
  });

  it("still takes the OUTER colon when the category name holds one", () => {
    expect(categoryOf("Type safety (RFC: 1234): ok")).toBe(
      "Type safety (RFC: 1234)",
    );
  });

  it("falls back to the FIRST unnested colon when no remainder is a status", () => {
    // A finding's own prose may hold a colon; the earliest split is the
    // honest category name. Taking the last one minted a phantom category.
    const body = 'Error handling: unhandled reject at db.ts: no such table';
    expect(categoryOf(body)).toBe("Error handling");
  });
});

describe("extractCategorySweep — issue #1082 regression cases", () => {
  it("reads `ok` followed by a parenthetical containing a colon as ok", () => {
    // The exact line from the 2026-08-14 run, named in the ticket.
    const line =
      "- Execution evidence: ok (authoritative check re-run by me: " +
      '"2 passed (59.7s)"…)';
    const out = extractCategorySweep(sweep(line));
    expect(out).not.toBeNull();
    expect(out!.get("execution evidence")?.status).toBe("ok");
    // The phantom category must not exist at all.
    expect([...out!.keys()]).toEqual(["execution evidence"]);
  });

  it("still parses a category name that contains a colon", () => {
    const out = extractCategorySweep(sweep("- Type safety (RFC: 1234): ok"));
    expect(out!.get("type safety (rfc: 1234)")?.status).toBe("ok");
  });

  it("reads `n/a` followed by a parenthetical containing a colon", () => {
    const out = extractCategorySweep(
      sweep("- Migrations: n/a (no schema change: nothing to run)"),
    );
    expect(out!.get("migrations")?.status).toBe("n/a");
  });

  it("leaves the plain statuses alone", () => {
    const out = extractCategorySweep(
      sweep("- Spec fit: ok", "- Perf: n/a", "- Error handling: leaks a 500"),
    );
    expect(out!.get("spec fit")?.status).toBe("ok");
    expect(out!.get("perf")?.status).toBe("n/a");
    expect(out!.get("error handling")?.status).toBe("finding");
  });

  it("does not let a parenthetical launder a real finding", () => {
    // A hedged `ok` with a real complaint after it stays a finding — the
    // parenthetical rule must not become a way to wave work through.
    const out = extractCategorySweep(
      sweep("- Error handling: ok — actually it throws (see: line 42)"),
    );
    expect(out!.get("error handling")?.status).toBe("finding");
  });

  it("records a finding whose text contains a colon under the right category", () => {
    const out = extractCategorySweep(
      sweep("- Error handling: unhandled reject at db.ts: no such table"),
    );
    // The old last-colon rule keyed this under the phantom category
    // `error handling: unhandled reject at db.ts`.
    expect(out!.get("error handling")?.status).toBe("finding");
    expect([...out!.keys()]).toEqual(["error handling"]);
  });
});

describe("malformed nesting must never lose a bullet (review finding)", () => {
  // An unbalanced CLOSER was already clamped. An unbalanced OPENER or an odd
  // double quote left the scan nested to end-of-line, so every colon after it
  // was skipped and the bullet vanished from the sweep entirely. A category
  // present in round 1 and gone in round 2 is precisely the deny path this
  // ticket exists to close, so dropping is worse than mis-splitting.
  const malformed: readonly (readonly [string, string])[] = [
    // A one-character typo of a category the reviewer prompt really ships.
    ["Test fidelity (false-green: ok", "Test fidelity (false-green"],
    ['Docs ("spec): ok', 'Docs ("spec)'],
    ['Spec fit: ok "unclosed', "Spec fit"],
    ["Spec fit): ok", "Spec fit)"],
  ];

  it.each(malformed)("parses %j rather than dropping it", (body, category) => {
    expect(topLevelColonSpaces(body).length).toBeGreaterThan(0);
    expect(categoryOf(body)).toBe(category);
  });

  it("keeps the bullet in the sweep map", () => {
    const out = extractCategorySweep(sweep("- Test fidelity (false-green: ok"));
    expect(out).not.toBeNull();
    expect(out!.size).toBe(1);
  });
});

describe("the raw reviewer line is kept and quoted (issue #1105 rule)", () => {
  it("carries the reviewer's own sentence beside the label", () => {
    const out = extractCategorySweep(sweep("- Spec fit: leaks a 500"));
    expect(out!.get("spec fit")).toEqual({
      status: "finding",
      line: "Spec fit: leaks a 500",
    });
  });

  it("quotes that sentence when it names a recurring blocker", () => {
    const r1 = extractCategorySweep(sweep("- Spec fit: leaks a 500"))!;
    const r2 = extractCategorySweep(sweep("- Spec fit: still leaks a 500"))!;
    const reason = thirdAttemptDenyReason(r1, r2);
    expect(reason).toContain('"Spec fit: leaks a 500"');
    expect(reason).toContain('"Spec fit: still leaks a 500"');
  });

  it("quotes the round-1 sentence when the category vanishes in round 2", () => {
    const r1 = extractCategorySweep(sweep("- Spec fit: leaks a 500"))!;
    const r2 = extractCategorySweep(sweep("- Perf: ok"))!;
    expect(thirdAttemptDenyReason(r1, r2)).toContain('"Spec fit: leaks a 500"');
  });

  it("refuses to name a label it cannot show the source of", () => {
    const r1 = new Map([["spec fit", { status: "finding" as const, line: "" }]]);
    const r2 = new Map([["spec fit", { status: "finding" as const, line: "x" }]]);
    const reason = thirdAttemptDenyReason(r1, r2);
    expect(reason).not.toContain("spec fit");
    expect(reason).toContain("does not name one");
  });
});

describe("a stated objection must never be laundered into ok (review finding)", () => {
  // THE FAIL-OPEN CASE. `classifySweepStatus` used to test the parenthetical
  // with `/^ok\s*\(.*\)\.?$/`. That `.*` is greedy and balance-blind, so any
  // string starting `ok (` and ending `)` passed — including one carrying a
  // real complaint between two groups. The two-step separator rule made it far
  // more reachable, because that rule hunts backwards for a remainder this
  // function accepts. Every other fault here is fail-closed; this one shipped
  // work a reviewer had objected to, which the ticket names as a launch gate.
  const laundered: readonly string[] = [
    "ok (mostly) but here: the 500 leak (unfixed)",
    "ok (a) junk (b)",
    "ok (see [ref: 1]) but: slow (badly)",
    "n/a (a) nope (b)",
    "n/a (nothing) yet: missing (really)",
  ];

  it.each(laundered)("refuses to call %j a status", (value) => {
    expect(classifySweepStatus(value)).toBeNull();
  });

  it("records the whole bullet as a finding, not as ok", () => {
    const out = extractCategorySweep(
      sweep("- Perf: ok (see [ref]) but: slow (badly)"),
    );
    expect(out!.get("perf")?.status).toBe("finding");
  });

  it("still accepts a genuine nested parenthetical", () => {
    // The ticket's own line nests a group inside the explanation.
    expect(
      classifySweepStatus('ok (re-run by me: "2 passed (59.7s)")'),
    ).toBe("ok");
    expect(classifySweepStatus("ok (mostly).")).toBe("ok");
    expect(classifySweepStatus("n/a (no schema change: nothing to run)")).toBe(
      "n/a",
    );
  });

  it("refuses an unbalanced opener rather than guessing", () => {
    expect(classifySweepStatus("ok (unclosed")).toBeNull();
  });
});

describe("a bolded verdict is a verdict, not a complaint (issue #1128)", () => {
  // WHAT BROKE. The CATEGORY half of a bullet had its markdown emphasis
  // stripped before matching; the STATUS half did not. So `- Spec fit: **ok**`
  // was recorded as a finding under a category the reviewer had actually
  // cleared — a false round-1 finding that is absent from round 2, which is
  // exactly the path that denies a ticket its third attempt.
  const emphasised: readonly (readonly [string, string])[] = [
    ["**ok**", "ok"],
    ["__n/a__", "n/a"],
    ["`ok`", "ok"],
    ["*ok*", "ok"],
    ["**ok**.", "ok"],
    ["**ok** (re-ran: 4 passed)", "ok"],
    ["**n/a** (no schema change: nothing to run)", "n/a"],
    // Emphasis around the WHOLE value, not just the token.
    ["**ok (re-ran: 4 passed)**", "ok"],
  ];

  it.each(emphasised)("reads %j as %s", (value, status) => {
    expect(classifySweepStatus(value)).toBe(status);
  });

  it("records the bolded bullet as ok in the sweep map", () => {
    const out = extractCategorySweep(
      sweep("- Spec fit: **ok**", "- Migrations: __n/a__", "- Perf: `ok`"),
    );
    expect(out!.get("spec fit")?.status).toBe("ok");
    expect(out!.get("migrations")?.status).toBe("n/a");
    expect(out!.get("perf")?.status).toBe("ok");
  });

  it("splits a bolded status at the right colon, not inside its parenthetical", () => {
    // `chooseSweepSplit` asks `classifySweepStatus` which colon separates the
    // bullet, so a strip applied anywhere else would leave the split chosen
    // against un-stripped text and the status read off a different one.
    const body = "Execution evidence: **ok** (re-ran: 4 passed)";
    expect(categoryOf(body)).toBe("Execution evidence");
    const out = extractCategorySweep(sweep(`- ${body}`));
    expect([...out!.keys()]).toEqual(["execution evidence"]);
    expect(out!.get("execution evidence")?.status).toBe("ok");
  });

  it("does not let emphasis launder a stated objection", () => {
    // The fail-OPEN direction issue #1082 names as a launch gate stays closed:
    // tolerating emphasis must not tolerate a complaint after the token.
    expect(
      classifySweepStatus("**ok** (mostly) but here: a leak (bad)"),
    ).toBeNull();
    expect(classifySweepStatus("**ok** — actually it throws")).toBeNull();
    expect(classifySweepStatus("**ok** (unclosed")).toBeNull();
  });
});

describe("an unreadable sweep is its own outcome, never a stated objection", () => {
  // OWNER DECISION, issue #1082 on 2026-08-15: "an unparseable response is its
  // own outcome and must be visible as one. Silently turning 'I could not read
  // this' into 'objected' is the present bug. Turning it into 'approved' would
  // be worse." The gate behaviour is UNCHANGED — an unreadable sweep still
  // withholds the extra attempt — so only the wording is pinned here.
  const unreadable = extractCategorySweep("no sweep block here at all");

  it("returns null when there is no sweep block to read", () => {
    expect(unreadable).toBeNull();
  });

  it("says it could not read the answer, for a missing round-1 sweep", () => {
    const r2 = extractCategorySweep(sweep("- Spec fit: ok"))!;
    const reason = thirdAttemptDenyReason(null, r2);
    expect(reason).toContain("could not read the reviewer's answer");
    expect(reason).toContain("round-1");
    expect(reason).toContain("not an objection");
  });

  it("says the same for a missing round-2 sweep, naming the other round", () => {
    const r1 = extractCategorySweep(sweep("- Spec fit: leaks a 500"))!;
    const reason = thirdAttemptDenyReason(r1, null);
    expect(reason).toContain("could not read the reviewer's answer");
    expect(reason).toContain("round-2");
    expect(reason).toContain("not an objection");
  });

  it("never states an objection or names a category it could not read", () => {
    const r2 = extractCategorySweep(sweep("- Spec fit: ok"))!;
    for (const reason of [
      thirdAttemptDenyReason(null, r2),
      thirdAttemptDenyReason(r2, null),
    ]) {
      // The old wording was "sweep1 unparsable" / "sweep2 unparsable", which
      // read at three in the morning as though the reviewer had complained.
      expect(reason).not.toContain("unparsable");
      expect(reason).not.toContain("blocker");
      // No label is named, and none is quoted — there is no source line to
      // show one against (the show-your-source rule, issue #1105).
      expect(reason).not.toContain("spec fit");
      expect(reason).not.toContain('"');
    }
  });
});

describe("the fixed-token contract: an explicit FINDING (issue #1128)", () => {
  // OWNER DECISION, issue #1082 on 2026-08-15: "the checking step must emit one
  // of a fixed, small set of outcomes — approved or objected — in a form that
  // cannot be misread. Not free prose that something else then interprets."
  // `review-prompt.md` now demands `OK`, `N/A (<reason>)` or `FINDING: <text>`,
  // and `FINDING:` is the token that had no reader before this.
  const objections: readonly string[] = [
    "FINDING: the tenant check is gone",
    "finding: the tenant check is gone",
    "**FINDING:** the tenant check is gone",
    "`FINDING: the tenant check is gone`",
    "FINDING:the tenant check is gone",
  ];

  it.each(objections)("reads %j as a stated objection", (value) => {
    expect(classifySweepStatus(value)).toBe("finding");
  });

  it("does not weigh the finding's own wording", () => {
    // The text after the token is the reviewer's sentence and is never
    // inspected. A reviewer whose finding happens to read "ok" has still
    // objected.
    expect(classifySweepStatus("FINDING: ok")).toBe("finding");
  });

  it("keeps the objection when its text carries its own colon", () => {
    // THE FAIL-OPEN CASE THIS TOKEN CREATES IF THE ORDER IS WRONG. The
    // backwards hunt for an approval would otherwise split at the SECOND
    // colon, key the row under the phantom category `spec fit: finding`, and
    // record the reviewer's stated objection as `ok`.
    const out = extractCategorySweep(sweep("- Spec fit: FINDING: ok"));
    expect(out!.get("spec fit")?.status).toBe("finding");
    expect([...out!.keys()]).toEqual(["spec fit"]);
    expect(out!.get("spec fit")?.line).toBe("Spec fit: FINDING: ok");
  });

  it("takes the earliest FINDING so the whole sentence survives", () => {
    const out = extractCategorySweep(
      sweep("- Error handling: FINDING: db.ts throws: no such table"),
    );
    expect(out!.get("error handling")?.status).toBe("finding");
    expect(out!.get("error handling")?.line).toBe(
      "Error handling: FINDING: db.ts throws: no such table",
    );
  });

  it("skips the new fixed-token template when a reviewer leaves it unfilled", () => {
    const out = extractCategorySweep(
      sweep(
        "- Spec fit: <OK | N/A (<reason>) | FINDING: <one-line finding>>",
        "- Perf: OK",
      ),
    );
    expect([...out!.keys()]).toEqual(["perf"]);
  });
});

describe("nothing the parser accepted before was narrowed (issue #1128)", () => {
  // MANDATORY BACKWARDS TOLERANCE. Reviewers already mid-run write today's
  // lowercase prose, and their approvals must keep counting — the new tokens
  // are ADDITIVE. Every shape below is one the parser accepted on 8bbccacc.
  const stillAccepted: readonly (readonly [string, string])[] = [
    ["ok", "ok"],
    ["ok.", "ok"],
    ["OK", "ok"],
    ["ok (re-run by me: 2 passed)", "ok"],
    ['ok (re-run by me: "2 passed (59.7s)")', "ok"],
    ["ok (mostly).", "ok"],
    ["n/a", "n/a"],
    ["N/A", "n/a"],
    ["n/a (no schema change)", "n/a"],
    ["n/a (no schema change: nothing to run)", "n/a"],
    // The emphasis-stripped forms added earlier on this branch.
    ["**ok**", "ok"],
    ["__n/a__", "n/a"],
    ["`ok`", "ok"],
    ["*ok*", "ok"],
    ["**ok**.", "ok"],
    ["**ok** (re-ran: 4 passed)", "ok"],
    ["**n/a** (no schema change: nothing to run)", "n/a"],
    ["**ok (re-ran: 4 passed)**", "ok"],
  ];

  it.each(stillAccepted)("still reads %j as %s", (value, status) => {
    expect(classifySweepStatus(value)).toBe(status);
  });

  it("still records a bare prose complaint as a finding, not as unreadable", () => {
    // The sweep template shipped a bare `<one-line finding>` for years, so
    // free prose IS how objections are written today. Calling one unreadable
    // would bury a real complaint.
    const out = extractCategorySweep(
      sweep("- Error handling: leaks a 500", "- Perf: unhandled reject"),
    );
    expect(out!.get("error handling")?.status).toBe("finding");
    expect(out!.get("perf")?.status).toBe("finding");
  });
});

describe("an unreadable ROW is its own outcome (issue #1128)", () => {
  // OWNER DECISION, issue #1082 on 2026-08-15: "an unparseable response is its
  // own outcome and must be visible as one. Silently converting 'I could not
  // read this' into 'objected' is the present bug; converting it into
  // 'approved' would be worse. Surface it." Before this, `chooseSweepSplit`
  // coerced every unrecognised remainder to `finding` — the run put an
  // objection on the record that no reviewer had stated.
  const unreadableValues: readonly string[] = [
    "✅", // ✅
    "❌", // ❌
    "**",
    "—", // an em-dash on its own
    "``",
    "...",
  ];

  it.each(unreadableValues)("records %j as unreadable, not as a finding", (v) => {
    const out = extractCategorySweep(sweep(`- Spec fit: ${v}`));
    expect(out!.get("spec fit")?.status).toBe("unreadable");
  });

  it("keeps the reviewer's raw line so the message can quote it", () => {
    const out = extractCategorySweep(sweep("- Spec fit: ✅"));
    expect(out!.get("spec fit")).toEqual({
      status: "unreadable",
      line: "Spec fit: ✅",
    });
  });

  it("says it could not read the row, quotes it, and calls it no objection", () => {
    const r1 = extractCategorySweep(sweep("- Spec fit: ✅"))!;
    const r2 = extractCategorySweep(sweep("- Spec fit: ok"))!;
    const reason = thirdAttemptDenyReason(r1, r2);
    expect(reason).toContain("could not read the reviewer's answer");
    expect(reason).toContain("not an objection");
    // Show your source (issue #1105): the reviewer's own line, verbatim.
    expect(reason).toContain('"Spec fit: ✅"');
    expect(reason).not.toContain("blocker");
  });

  it("refuses to name the category when no source line was recorded", () => {
    const r1 = new Map([
      ["spec fit", { status: "unreadable" as const, line: "" }],
    ]);
    const r2 = new Map([["spec fit", { status: "ok" as const, line: "x" }]]);
    const reason = thirdAttemptDenyReason(r1, r2);
    expect(reason).toContain("could not read the reviewer's answer");
    expect(reason).not.toContain("spec fit");
    expect(reason).toContain("does not name one");
  });

  it("names the round-2 row it could not read, and does not call it recurring", () => {
    const r1 = extractCategorySweep(sweep("- Spec fit: leaks a 500"))!;
    const r2 = extractCategorySweep(sweep("- Spec fit: ✅"))!;
    const reason = thirdAttemptDenyReason(r1, r2);
    expect(reason).toContain("could not read the reviewer's answer");
    expect(reason).toContain("round 2");
    expect(reason).toContain('"Spec fit: leaks a 500"');
    expect(reason).not.toContain("recurring blocker");
  });
});

describe("the gate treats an unreadable row conservatively (issue #1128)", () => {
  // An unreadable row carries no verdict, so it is read as neither. It must
  // never be the evidence that GRANTS the extra attempt, and it must never be
  // read as a prior complaint being cleared. What it must ALSO not do is deny
  // on its own — the first four-status draft short-circuited on any round-1
  // unreadable row, which cost a ticket its retry after every genuine
  // complaint had been fixed. Both halves are pinned here.
  it("grants when the only round-1 row it could not read sits beside a cleared finding", () => {
    // A reviewer's stray ✅ on one row is not a complaint. `Perf` was the real
    // objection and round 2 cleared it, so the third attempt is earned. Base
    // `8bbccacc` granted this too (by coercing the ✅ to a finding round 2 then
    // "cleared"); the first version of this commit denied it.
    const r1 = extractCategorySweep(
      sweep("- Spec fit: ✅", "- Perf: leaks a 500"),
    )!;
    const r2 = extractCategorySweep(sweep("- Spec fit: ok", "- Perf: ok"))!;
    expect(priorFindingsResolved(r1, r2)).toBe(true);
  });

  it("still denies when a round-1 finding sits beside an unreadable row and is NOT cleared", () => {
    const r1 = extractCategorySweep(
      sweep("- Spec fit: ✅", "- Perf: leaks a 500"),
    )!;
    const r2 = extractCategorySweep(
      sweep("- Spec fit: ok", "- Perf: still leaks a 500"),
    )!;
    expect(priorFindingsResolved(r1, r2)).toBe(false);
  });

  it("denies when the round-2 answer to a round-1 finding could not be read", () => {
    const r1 = extractCategorySweep(sweep("- Spec fit: leaks a 500"))!;
    const r2 = extractCategorySweep(sweep("- Spec fit: ✅"))!;
    expect(priorFindingsResolved(r1, r2)).toBe(false);
  });

  it("never grants on an unreadable row alone", () => {
    // Round 1 stated no complaint the loop could read, so there is nothing it
    // can show was fixed. Granting here would be reading "I could not read
    // this" as "approved".
    const r1 = extractCategorySweep(sweep("- Spec fit: ✅"))!;
    const r2 = extractCategorySweep(sweep("- Spec fit: ok"))!;
    expect(priorFindingsResolved(r1, r2)).toBe(false);
  });

  it("still grants when every readable round-1 finding is cleared", () => {
    const r1 = extractCategorySweep(sweep("- Spec fit: leaks a 500"))!;
    const r2 = extractCategorySweep(sweep("- Spec fit: ok"))!;
    expect(priorFindingsResolved(r1, r2)).toBe(true);
  });
});

describe("strictest-wins ranks a duplicate row it could not read (issue #1128)", () => {
  it("keeps unreadable over an approval, whichever order they arrive in", () => {
    const first = extractCategorySweep(
      sweep("- Spec fit: ✅", "- Spec fit: ok"),
    );
    expect(first!.get("spec fit")?.status).toBe("unreadable");
    const second = extractCategorySweep(
      sweep("- Spec fit: ok", "- Spec fit: ✅"),
    );
    expect(second!.get("spec fit")?.status).toBe("unreadable");
  });

  it("keeps a stated objection over an unreadable row", () => {
    const first = extractCategorySweep(
      sweep("- Spec fit: ✅", "- Spec fit: FINDING: leaks a 500"),
    );
    expect(first!.get("spec fit")?.status).toBe("finding");
    expect(first!.get("spec fit")?.line).toBe("Spec fit: FINDING: leaks a 500");
    const second = extractCategorySweep(
      sweep("- Spec fit: FINDING: leaks a 500", "- Spec fit: ✅"),
    );
    expect(second!.get("spec fit")?.status).toBe("finding");
  });
});

describe("FAIL-OPEN GATE: a stated objection is never ok, n/a or unreadable", () => {
  // The launch-gate direction from issue #1082: a check reporting green when
  // it should report red ships work a reviewer objected to. The fourth outcome
  // adds a second way to lose an objection — filing it as "I could not read
  // that" — so every adversarial shape is pinned against ALL THREE.
  const objections: readonly string[] = [
    "FINDING: ok",
    "FINDING: n/a",
    "OK but the tenant check is gone",
    "ok — actually it throws",
    "**ok** (mostly) but here: a leak (bad)",
    "ok (mostly) but here: the 500 leak (unfixed)",
    "ok (a) junk (b)",
    "ok (see [ref: 1]) but: slow (badly)",
    "n/a (a) nope (b)",
    "n/a (nothing) yet: missing (really)",
    "`leaks a 500 on every deal`",
    "`FINDING: leaks a 500`",
    "**leaks a 500",
    "*ok* but the tenant check is gone",
    "ok (unclosed",
    "**ok** (unclosed",
  ];

  it.each(objections)("records %j as a finding, never as approval or unreadable", (value) => {
    const out = extractCategorySweep(sweep(`- Spec fit: ${value}`));
    const status = out!.get("spec fit")?.status;
    expect(status).toBe("finding");
    expect(status).not.toBe("ok");
    expect(status).not.toBe("n/a");
    expect(status).not.toBe("unreadable");
  });

  // THE ONE HOLE ON `OK`, PINNED AS A DOCUMENTED LIMITATION, NOT AS AN
  // ACCEPTED ROUTE. `OK (…)` takes free prose as its evidence parenthetical,
  // exactly as `N/A (…)` takes free prose as its reason, so a complaint
  // written inside the brackets — even one spelling out the word FINDING — is
  // recorded as an approval. Telling that apart from honest evidence means
  // READING the prose inside the brackets and judging it, which is the "free
  // prose that something else then interprets" the owner's decision on issue
  // #1082 rules out. So the parser is left alone and `review-prompt.md` warns
  // the reviewer off the shape in as many words, on the `OK` bullet where the
  // `N/A` bullet already carried the same warning. This test exists to catch
  // anyone "fixing" it in the parser, and it is NOT a sanctioned way to
  // object: the token for a complaint is `FINDING:`, at the front of the line.
  it("records an objection buried in an OK parenthetical as ok (documented limitation)", () => {
    const out = extractCategorySweep(
      sweep("- Spec fit: ok (but see FINDING: the tenant check is gone)"),
    );
    expect(out!.get("spec fit")?.status).toBe("ok");
    // The way out is the token, at the front of the line.
    expect(classifySweepStatus("FINDING: the tenant check is gone")).toBe(
      "finding",
    );
  });

  it.each(objections)("never lets %j reach the gate as resolved", (value) => {
    // Same shapes at the gate: a round-2 answer that objects must never clear
    // a round-1 finding.
    const r1 = extractCategorySweep(sweep("- Spec fit: leaks a 500"))!;
    const r2 = extractCategorySweep(sweep(`- Spec fit: ${value}`))!;
    expect(priorFindingsResolved(r1, r2)).toBe(false);
  });
});

describe("the one shape the run cannot catch, and why it is left alone", () => {
  // `N/A (actually it throws)` is recorded as `n/a`, on 8bbccacc and after
  // this change, and that is DELIBERATE rather than missed.
  //
  // The `N/A (<reason>)` form takes free prose as its reason — that is what
  // the form is FOR, and `review-prompt.md` demands the reason be specific.
  // Telling "actually it throws" apart from "no schema changes in diff" means
  // reading that prose and judging whether it sounds like a complaint. That is
  // exactly the thing the owner's 2026-08-15 decision rules out: "not free
  // prose that something else then interprets." Any sniffer built for it also
  // misfires on honest reasons — `n/a (no throw path in this diff)` contains
  // the same word.
  //
  // The fixed-token contract is the answer instead: a reviewer with a
  // complaint writes `FINDING:`, and the prompt now says so in as many words.
  // A reviewer that files a complaint under `N/A` has answered the wrong
  // question, and no parser can recover that.
  it("records it as n/a, and the objection token is the way out", () => {
    expect(classifySweepStatus("N/A (actually it throws)")).toBe("n/a");
    expect(classifySweepStatus("FINDING: actually it throws")).toBe("finding");
  });
});

describe("a FINDING token never mints a phantom category (issue #1128)", () => {
  // THE REGRESSION THIS PINS. Step A used to split at the colon where it FOUND
  // the `FINDING:` token. When the finding's own prose carried an earlier
  // top-level colon, the category came out as half the reviewer's sentence —
  // exactly the phantom category of issue #1082 fault 1: present in round 1,
  // absent from round 2, so the third attempt is denied for a blocker nobody
  // raised. The category is always what precedes the FIRST top-level colon.
  // Nothing is lost by splitting early: `line` is the whole bullet regardless.
  it("keys a finding whose prose holds a colon under the honest category", () => {
    const body = "Error handling: unhandled reject at db.ts: FINDING: no table";
    expect(categoryOf(body)).toBe("Error handling");
    const out = extractCategorySweep(sweep(`- ${body}`));
    expect([...out!.keys()]).toEqual(["error handling"]);
    expect(out!.get("error handling")?.status).toBe("finding");
    expect(out!.get("error handling")?.line).toBe(body);
  });

  it("keys a finding announced after a prose clause under the honest category", () => {
    const body = "Spec fit: I have a concern: FINDING: real one";
    expect(categoryOf(body)).toBe("Spec fit");
    const out = extractCategorySweep(sweep(`- ${body}`));
    expect([...out!.keys()]).toEqual(["spec fit"]);
    expect(out!.get("spec fit")?.status).toBe("finding");
    expect(out!.get("spec fit")?.line).toBe(body);
  });
});

describe("a row with no separator is dropped LOUDLY (issue #1128)", () => {
  // A bullet with no top-level `": "` — `- Security:OK`, no space after the
  // colon — has no category name the run can cut out of the reviewer's own
  // sentence, so issue #1105's show-your-source rule keeps it out of the map.
  // But the owner's decision on issue #1082 is that "an unparseable response is
  // its own outcome and must be visible as one": dropped in silence, a round-1
  // objection written that way is neither finding nor unreadable, it is
  // nothing, and its absence flips a deny into a grant.
  it("logs the raw bullet an operator can read", () => {
    const errors: string[] = [];
    const out = extractCategorySweep(sweep("- Security:OK"), (m) =>
      errors.push(m),
    );
    expect(out).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("could not read this sweep line");
    expect(errors[0]).toContain("Security:OK");
  });

  it("does not invent a category for it", () => {
    const out = extractCategorySweep(sweep("- Security:OK", "- Spec fit: OK"));
    expect([...out!.keys()]).toEqual(["spec fit"]);
  });
});

describe("the third attempt reads the LATEST review, not the first (issue #1211)", () => {
  // On 2026-09-05, ticket #1038 (retire the hand-coded New Deal panel) stopped
  // one line from done: review 1's sweep was empty (`vacuous`), review 2 named
  // a HARD one-line finding, and the round-3 grant refused on the strength of
  // round 1. `latestSweepEarnsRound3` is the fix: an empty round 1 must not
  // veto a real objection round 2 raised. A $93.87 run died on that veto.

  it("grants when round 1 was vacuous but round 2 names a real finding", () => {
    // The exact #1038 shape: round 1 all-approved (no complaint), round 2
    // raises a fresh, stated finding. The builder gets its third pass to fix it.
    const r1 = extractCategorySweep(sweep("- Spec fit: ok", "- Perf: ok"))!;
    const r2 = extractCategorySweep(sweep("- Spec fit: FINDING: leaks a 500"))!;
    // The old gate denied this — round 1 had nothing to "clear".
    expect(priorFindingsResolved(r1, r2)).toBe(false);
    // The new arm grants it — round 2 named a real one.
    expect(latestSweepEarnsRound3(r1, r2)).toBe(true);
  });

  it("grants when round 1 was entirely unreadable (null) but round 2 has a finding", () => {
    // A round-1 block the run could not parse at all is the same "round 1 gave
    // the loop nothing" as a vacuous one, at a larger scale.
    const r2 = extractCategorySweep(sweep("- Spec fit: FINDING: leaks a 500"))!;
    expect(latestSweepEarnsRound3(null, r2)).toBe(true);
  });

  it("denies when BOTH rounds are vacuous — a content-free refusal earns no freebie", () => {
    const r1 = extractCategorySweep(sweep("- Spec fit: ok"))!;
    const r2 = extractCategorySweep(sweep("- Perf: ok"))!;
    expect(latestSweepEarnsRound3(r1, r2)).toBe(false);
  });

  it("denies when round 1 carried a finding — that path belongs to priorFindingsResolved", () => {
    // If round 1 DID raise a complaint, the recurring-blocker and progress
    // logic in priorFindingsResolved must rule, not this arm. This arm must
    // never grant past a builder stuck on the same complaint twice.
    const r1 = extractCategorySweep(sweep("- Spec fit: FINDING: leaks a 500"))!;
    const r2 = extractCategorySweep(sweep("- Perf: FINDING: n+1 query"))!;
    expect(latestSweepEarnsRound3(r1, r2)).toBe(false);
  });

  it("never counts an unreadable round-2 row as the finding that grants (issue #1082)", () => {
    // Round 2's only row is one the run could not read. That is never evidence
    // FOR a grant.
    const r1 = extractCategorySweep(sweep("- Spec fit: ok"))!;
    const r2 = extractCategorySweep(sweep("- Spec fit: ✅"))!;
    expect(r2.get("spec fit")?.status).toBe("unreadable");
    expect(latestSweepEarnsRound3(r1, r2)).toBe(false);
  });

  it("the recurring blocker still bounces — round 1 finding, same finding in round 2", () => {
    // Belt-and-braces: the combined gate (priorFindingsResolved OR the new arm)
    // must still deny a stuck builder. priorFindingsResolved denies (recurring),
    // and the new arm denies (round 1 had a finding), so the OR is false.
    const r1 = extractCategorySweep(sweep("- Perf: leaks a 500"))!;
    const r2 = extractCategorySweep(sweep("- Perf: still leaks a 500"))!;
    expect(priorFindingsResolved(r1, r2)).toBe(false);
    expect(latestSweepEarnsRound3(r1, r2)).toBe(false);
  });
});
