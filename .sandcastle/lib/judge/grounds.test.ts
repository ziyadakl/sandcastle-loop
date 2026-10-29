/**
 * Issue #1118, owner ruling 8 — the reviewer's GROUNDS declaration, and the
 * parser that reads it. The run splits the reviewer path by grounds, and the
 * only thing it has to split on is this one line.
 */
import { describe, expect, it } from "vitest";

import { isOneBalancedGroup, parseReviewerGrounds, wrongCheckReasonIn } from "./grounds.js";

/** Wraps a grounds line in the surrounding noise a real review carries. */
const inReview = (groundsLine: string): string =>
  [
    "[STEP 1/1] Review",
    "",
    "The tenant check is gone from the team totals query.",
    "",
    "SWEEP COMPLETE.",
    groundsLine,
    "",
    "HAS_BLOCKERS",
  ].join("\n");

describe("the two clean tokens", () => {
  it("reads RED-CHECK as a refusal over a check that ran and failed", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: RED-CHECK"))).toBe("reviewer-red-check");
  });

  it("reads NO-CHECK as a refusal with no check behind it", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: NO-CHECK"))).toBe("reviewer-no-check");
  });

  it("tolerates markdown emphasis around the whole line", () => {
    expect(parseReviewerGrounds(inReview("**GROUNDS: RED-CHECK**"))).toBe("reviewer-red-check");
    expect(parseReviewerGrounds(inReview("__GROUNDS: NO-CHECK__"))).toBe("reviewer-no-check");
  });

  it("tolerates backticks around the whole line", () => {
    expect(parseReviewerGrounds(inReview("`GROUNDS: NO-CHECK`"))).toBe("reviewer-no-check");
  });

  it("is case-insensitive on both the word and the token", () => {
    expect(parseReviewerGrounds(inReview("grounds: red-check"))).toBe("reviewer-red-check");
    expect(parseReviewerGrounds(inReview("Grounds: No-Check"))).toBe("reviewer-no-check");
  });

  it("tolerates a space before the colon", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS : RED-CHECK"))).toBe("reviewer-red-check");
  });

  it("accepts a balanced parenthetical of evidence after the token", () => {
    expect(
      parseReviewerGrounds(inReview("GROUNDS: RED-CHECK (team-total.spec.ts: 1 failed)")),
    ).toBe("reviewer-red-check");
    expect(parseReviewerGrounds(inReview("GROUNDS: NO-CHECK (no proof it was ever run)"))).toBe(
      "reviewer-no-check",
    );
  });

  it("accepts a parenthetical that nests brackets, as long as it closes the line", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: RED-CHECK (re-run by me: (2 failed))"))).toBe(
      "reviewer-red-check",
    );
  });
});

describe("nothing the run can read", () => {
  it("returns unreadable when no grounds line appears at all", () => {
    const stdout = ["[STEP 1/1] Review", "SWEEP COMPLETE.", "", "HAS_BLOCKERS"].join("\n");
    expect(parseReviewerGrounds(stdout)).toBe("unreadable");
  });

  it("returns unreadable for an empty value", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS:"))).toBe("unreadable");
  });

  it("returns unreadable for an unknown value", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: maybe"))).toBe("unreadable");
  });

  it("returns unreadable for a tick where a token was asked for", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: ✅"))).toBe("unreadable");
  });

  it("returns unreadable for a complaint hung off a token", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: RED-CHECK but actually no"))).toBe("unreadable");
    expect(parseReviewerGrounds(inReview("GROUNDS: NO-CHECK, mostly"))).toBe("unreadable");
  });

  it("returns unreadable for a parenthetical that never closes", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: RED-CHECK (the suite failed"))).toBe(
      "unreadable",
    );
  });

  it("returns unreadable when prose follows a closed parenthetical", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: NO-CHECK (a house rule) and also a leak"))).toBe(
      "unreadable",
    );
  });

  it("does not read a token that is only the prefix of a longer word", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: RED-CHECKING"))).toBe("unreadable");
  });

  it("ignores a prose mention that does not start its own line", () => {
    const stdout = ["I considered writing GROUNDS: RED-CHECK here.", "HAS_BLOCKERS"].join("\n");
    expect(parseReviewerGrounds(stdout)).toBe("unreadable");
  });
});

describe("duplicates — strictest wins, and NO-CHECK is the strictest", () => {
  it("takes NO-CHECK when both clean tokens appear", () => {
    const stdout = ["GROUNDS: RED-CHECK", "some prose", "GROUNDS: NO-CHECK"].join("\n");
    expect(parseReviewerGrounds(stdout)).toBe("reviewer-no-check");
    const reversed = ["GROUNDS: NO-CHECK", "some prose", "GROUNDS: RED-CHECK"].join("\n");
    expect(parseReviewerGrounds(reversed)).toBe("reviewer-no-check");
  });

  it("takes a clean NO-CHECK over an unreadable grounds line", () => {
    const stdout = ["GROUNDS: ✅", "GROUNDS: NO-CHECK"].join("\n");
    expect(parseReviewerGrounds(stdout)).toBe("reviewer-no-check");
  });

  it("takes unreadable over a clean RED-CHECK, because the unread line may have been stricter", () => {
    const stdout = ["GROUNDS: RED-CHECK", "GROUNDS: maybe"].join("\n");
    expect(parseReviewerGrounds(stdout)).toBe("unreadable");
  });
});

describe("WRONG-CHECK — the reviewer says this ticket's own first test is wrong (spec #1334)", () => {
  it("reads WRONG-CHECK as a refusal over a first test that contradicts the ticket", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: WRONG-CHECK"))).toBe("reviewer-wrong-check");
    expect(
      parseReviewerGrounds(
        inReview("GROUNDS: WRONG-CHECK (team-total.spec.ts: asserts $1,000 twice)"),
      ),
    ).toBe("reviewer-wrong-check");
  });

  it("is the loosest reading: any other declaration beside it wins", () => {
    for (const other of ["GROUNDS: RED-CHECK", "GROUNDS: NO-CHECK", "GROUNDS: maybe"]) {
      expect(parseReviewerGrounds(["GROUNDS: WRONG-CHECK (x)", other].join("\n"))).not.toBe(
        "reviewer-wrong-check",
      );
      expect(parseReviewerGrounds([other, "GROUNDS: WRONG-CHECK (x)"].join("\n"))).not.toBe(
        "reviewer-wrong-check",
      );
    }
  });

  it("does not read a complaint hung off the token", () => {
    expect(parseReviewerGrounds(inReview("GROUNDS: WRONG-CHECK the test is bad"))).toBe(
      "unreadable",
    );
  });

  it("hands back the reviewer's stated reason from the parenthetical", () => {
    expect(
      wrongCheckReasonIn(
        inReview("GROUNDS: WRONG-CHECK (team-total.spec.ts: the ticket says $2,000, the test asserts $1,000)"),
      ),
    ).toBe("team-total.spec.ts: the ticket says $2,000, the test asserts $1,000");
  });

  it("has no reason when the grounds are anything but WRONG-CHECK", () => {
    expect(wrongCheckReasonIn(inReview("GROUNDS: RED-CHECK (a.spec.ts: 1 failed)"))).toBeUndefined();
    expect(
      wrongCheckReasonIn(["GROUNDS: WRONG-CHECK (x)", "GROUNDS: NO-CHECK"].join("\n")),
    ).toBeUndefined();
  });

  it("has an empty reason when WRONG-CHECK carries no parenthetical", () => {
    expect(wrongCheckReasonIn(inReview("GROUNDS: WRONG-CHECK"))).toBe("");
  });
});

describe("input shapes that must not throw", () => {
  it("handles an empty output", () => {
    expect(parseReviewerGrounds("")).toBe("unreadable");
  });

  it("handles Windows line endings", () => {
    expect(parseReviewerGrounds("SWEEP COMPLETE.\r\nGROUNDS: NO-CHECK\r\nHAS_BLOCKERS")).toBe(
      "reviewer-no-check",
    );
  });

  it("tolerates leading indentation on the grounds line", () => {
    expect(parseReviewerGrounds("   GROUNDS: RED-CHECK   ")).toBe("reviewer-red-check");
  });
});

describe("isOneBalancedGroup — the shared scan behind both parsers", () => {
  // Exported and tested here because the category sweep in `main.mts` asks the
  // same question of its own bullets and used to carry a second copy of this
  // body (issue #1133, item 15). A fix to one copy never reached the other.
  it("accepts one group that closes the line", () => {
    expect(isOneBalancedGroup("(re-ran: 4 passed)")).toBe(true);
  });

  it("tolerates a trailing full stop", () => {
    expect(isOneBalancedGroup("(re-ran: 4 passed).")).toBe(true);
  });

  it("accepts a nested group, which no regex could", () => {
    expect(isOneBalancedGroup("(re-run by me: (2 failed))")).toBe(true);
  });

  it("rejects a second group, which is a complaint hung off the token", () => {
    expect(isOneBalancedGroup("(a) junk (b)")).toBe(false);
  });

  it("rejects prose after the group closes", () => {
    expect(isOneBalancedGroup("(mostly) but here: the 500 leak")).toBe(false);
  });

  it("rejects an opener that never closes", () => {
    expect(isOneBalancedGroup("(re-ran: 4 passed")).toBe(false);
  });

  it("rejects a stray closer before any opener", () => {
    expect(isOneBalancedGroup(")(")).toBe(false);
  });

  // The one behavioural difference between the two former copies. The
  // `main.mts` body had no leading guard, so it counted depth from wherever
  // the first bracket fell and answered `true` here. Its caller's regex made
  // that unreachable; this file's caller does not, so the guard stays.
  it("rejects text before the group", () => {
    expect(isOneBalancedGroup("abc (x)")).toBe(false);
    expect(isOneBalancedGroup("")).toBe(false);
  });
});
