/**
 * #1198 A — the deterministic section the loop writes onto a ticket it built
 * without a first test.
 */
import { describe, expect, it } from "vitest";

import {
  buildFirstTestFallThroughSection,
  FIRST_TEST_FALLTHROUGH_SECTION_END,
  FIRST_TEST_FALLTHROUGH_SECTION_START,
  type FirstTestFallThroughReason,
} from "./first-test-fallthrough.js";

const REASONS: readonly FirstTestFallThroughReason[] = [
  "no-failing-check",
  "run-fault",
  "test-disagreed",
];

describe("buildFirstTestFallThroughSection", () => {
  it("is pure — the same inputs always produce the same string", () => {
    const opts = {
      reason: "no-failing-check" as const,
      detail: "the check agrees with everything",
      issueNumber: 1154,
      date: "2026-09-02",
    };
    expect(buildFirstTestFallThroughSection(opts)).toBe(
      buildFirstTestFallThroughSection(opts),
    );
  });

  it("says a distinct thing for each reason", () => {
    // Different events for whoever reads the ticket tomorrow — "the test
    // could never have failed" and "we could not run it" send a person
    // looking in different places.
    const rendered = REASONS.map((reason) =>
      buildFirstTestFallThroughSection({
        reason,
        detail: "same detail every time",
        issueNumber: 1,
        date: "2026-09-02",
      }),
    );
    expect(new Set(rendered).size).toBe(REASONS.length);
  });

  it("says NOTHING IS HELD, and names the label the merge will carry", () => {
    const s = buildFirstTestFallThroughSection({
      reason: "run-fault",
      detail: "the database was unreachable",
      issueNumber: 1,
      date: "2026-09-02",
    });
    expect(s).toContain("Nothing is held");
    expect(s).toContain("shipped-without-first-test");
    // And it tells a person NOT to re-queue — the code shipped; re-queueing
    // would rebuild work that is already on the branch.
    expect(s).toContain("not to re-queue #1");
  });

  it("carries the loop's own diagnosis verbatim", () => {
    const s = buildFirstTestFallThroughSection({
      reason: "no-failing-check",
      detail: "no host-generated evidence line in the output",
      issueNumber: 1,
      date: "2026-09-02",
    });
    expect(s).toContain("no host-generated evidence line in the output");
  });

  it("states an absence rather than rendering a hole when there is no detail", () => {
    const s = buildFirstTestFallThroughSection({
      reason: "no-failing-check",
      detail: "   ",
      issueNumber: 1,
      date: "2026-09-02",
    });
    expect(s).toContain("(nothing recorded)");
  });

  // `detail` is assembled from agent-authored strings. A raw `-->` in one
  // would close the marked section early and spill the rest into the ticket's
  // own prose, where the next run's `readMarkedSection` would no longer find
  // it — and where `proof-demand.ts` would read it as owner-authored text.
  //
  // These assert on the RENDERED SECTION ONLY, never on the section wrapped in
  // its markers. The first version of this test built
  // `START + s + END` and asserted that the block's first `-->` was the one
  // ending `START` — which is true of ANY input, escaped or not, because that
  // marker's own `-->` always comes first. It passed on unsanitized text and
  // proved nothing (#1198 review, blocker 2).
  describe.each([
    "the agent printed --> and then gave up",
    // `--->` overlaps: a naive `replace("-->", …)` anchored at the first two
    // dashes leaves the trailing `->` of `--->` still forming a `-->` with the
    // third dash.
    "the agent printed ---> and gave up",
    "the agent printed --  > and gave up",
  ])("cannot break out of its own HTML-comment markers: %s", (raw) => {
    it("is the positive control — the RAW input really does close a comment", () => {
      // Without this, the assertion below would also hold on an input that
      // never contained `-->` in the first place, and the escaping could be
      // deleted entirely with the suite still green.
      expect(raw.replace(/--\s*>/g, "-->")).toContain("-->");
    });

    it("renders no comment terminator at all", () => {
      const s = buildFirstTestFallThroughSection({
        reason: "run-fault",
        detail: raw,
        issueNumber: 1,
        date: "2026-09-02",
      });
      expect(s).not.toContain("-->");
      // And the section still sits inside its markers as exactly one block:
      // the FIRST `-->` in the assembled body is the one that ends the start
      // marker, and the only other one is the end marker's.
      const block = `${FIRST_TEST_FALLTHROUGH_SECTION_START}\n${s}\n${FIRST_TEST_FALLTHROUGH_SECTION_END}`;
      expect(block.split("-->")).toHaveLength(3);
    });
  });

  it("cannot open an unterminated code fence", () => {
    const s = buildFirstTestFallThroughSection({
      reason: "run-fault",
      detail: "it said ``` and stopped",
      issueNumber: 1,
      date: "2026-09-02",
    });
    expect(s).not.toContain("```");
  });
});
