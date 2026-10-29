/**
 * The pure half of the sibling-ticket briefs the check-writer reads before it
 * writes its acceptance check — truncation, fail-soft collection, the
 * ticket's-own-entry filter, and the rendered block's shape.
 *
 * Co-located with the module, matching the other nine in this directory. The
 * two tests that are NOT here — that `{{SIBLING_TICKETS}}` actually
 * substitutes into the real `check-writer-prompt.md`, and that the real
 * dispatch puts the list in its `promptArgs` — live in
 * `main.checkwriter.test.mts`, because their subject is the prompt and the
 * pipeline, not this module.
 */
import { describe, expect, it } from "vitest";

import { isUsableIssueNumber } from "./check-path.js";
import {
  NO_SIBLING_TICKETS,
  SIBLING_BODY_MAX_CHARS,
  collectSiblingBriefs,
  renderSiblingTickets,
  siblingBriefsExcluding,
  truncateSiblingBody,
} from "./sibling-briefs.js";
import type { SiblingTicketBrief } from "./sibling-briefs.js";

/** How many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// truncateSiblingBody — the one place "we could not read it" and "there is
// nothing to read" are told apart.
// ---------------------------------------------------------------------------

describe("truncateSiblingBody", () => {
  it("returns undefined ONLY for a body that was never read", () => {
    expect(truncateSiblingBody(undefined)).toBeUndefined();
    expect(truncateSiblingBody(null)).toBeUndefined();
  });

  it("returns an EMPTY STRING for a body that was read and is blank", () => {
    // Not `undefined`: an empty ticket and an unreadable one are different
    // facts, and the check-writer is told a different sentence for each.
    expect(truncateSiblingBody("")).toBe("");
    expect(truncateSiblingBody("   \n\t  ")).toBe("");
  });

  it("trims but does not touch a body under the cap", () => {
    expect(truncateSiblingBody("  the duplicate-address guard  ")).toBe(
      "the duplicate-address guard",
    );
  });

  it("cuts at the cap and says so, so a fragment cannot read as a whole ticket", () => {
    const long = `${"x".repeat(SIBLING_BODY_MAX_CHARS)}THIS-TAIL-MUST-NOT-SURVIVE`;
    const cut = truncateSiblingBody(long);
    expect(cut).not.toContain("THIS-TAIL-MUST-NOT-SURVIVE");
    expect(cut).toContain("(truncated)");
    expect(cut?.startsWith("x".repeat(SIBLING_BODY_MAX_CHARS))).toBe(true);
  });

  it("leaves a body of exactly the cap uncut and unmarked", () => {
    const exact = "x".repeat(SIBLING_BODY_MAX_CHARS);
    expect(truncateSiblingBody(exact)).toBe(exact);
  });
});

// ---------------------------------------------------------------------------
// collectSiblingBriefs — concurrent, fail-soft, and agreeing with the dispatch
// pool about what a usable issue number is.
// ---------------------------------------------------------------------------

describe("collectSiblingBriefs", () => {
  it("a gh failure on one ticket degrades that brief to title-only and never rejects", async () => {
    const errors: string[] = [];
    const briefs = await collectSiblingBriefs(
      [
        { id: "812", title: "the ticket gh can read" },
        { id: "815", title: "the ticket gh cannot reach" },
      ],
      {
        getIssueBody: async (n) => {
          if (n === 815) throw new Error("gh: could not resolve to an Issue");
          return "the duplicate-address guard, in full";
        },
        logError: (m) => errors.push(m),
      },
    );

    expect(briefs).toEqual([
      {
        number: 812,
        title: "the ticket gh can read",
        body: "the duplicate-address guard, in full",
      },
      { number: 815, title: "the ticket gh cannot reach" },
    ]);
    expect(errors.join("\n")).toContain("815");
    expect(errors.join("\n")).toContain("could not resolve to an Issue");
    // The one that failed still renders — a title is worth more than nothing.
    expect(renderSiblingTickets(briefs)).toContain("the ticket gh cannot reach");
  });

  it("names the cause even when what was thrown is not an Error", async () => {
    // `(err as Error).message` logs the word `undefined` here, which is the
    // one thing a fail-soft log must not do: its entire job is naming why the
    // check-writer is about to steer without this neighbour's body.
    const errors: string[] = [];
    await collectSiblingBriefs([{ id: "815", title: "t" }], {
      getIssueBody: async () => {
        // A bare string, which is what a rejected shell wrapper can produce.
        throw "gh exited 128, killed by the sandbox";
      },
      logError: (m) => errors.push(m),
    });

    expect(errors.join("\n")).toContain("gh exited 128");
    expect(errors.join("\n")).not.toContain("undefined");
  });

  it("a body read as blank is carried as empty, NOT as unread", async () => {
    const [brief] = await collectSiblingBriefs([{ id: "812", title: "t" }], {
      getIssueBody: async () => "   \n  ",
    });
    expect(brief?.body).toBe("");
  });

  it("cuts a long body at the cap", async () => {
    const [brief] = await collectSiblingBriefs([{ id: "812", title: "t" }], {
      getIssueBody: async () =>
        `${"x".repeat(SIBLING_BODY_MAX_CHARS)}THIS-TAIL-MUST-NOT-SURVIVE`,
    });
    expect(brief?.body).not.toContain("THIS-TAIL-MUST-NOT-SURVIVE");
    expect(brief?.body).toContain("(truncated)");
  });

  it("no getIssueBody at all (a dep-less caller) still yields title-only briefs rather than throwing", async () => {
    expect(
      await collectSiblingBriefs([{ id: "812", title: "title is all there is" }], {}),
    ).toEqual([{ number: 812, title: "title is all there is" }]);
  });

  it("keeps input order even when the fetches resolve out of order", async () => {
    const briefs = await collectSiblingBriefs(
      [
        { id: "812", title: "slow" },
        { id: "815", title: "fast" },
      ],
      {
        getIssueBody: async (n) =>
          n === 812
            ? await new Promise<string>((r) => setTimeout(() => r("slow body"), 10))
            : "fast body",
      },
    );
    expect(briefs.map((b) => b.number)).toEqual([812, 815]);
  });

  it("drops exactly the plan entries the DISPATCH POOL refuses — one predicate, two reactions", async () => {
    // The sharp edge this pins: a plan entry with an unusable id used to
    // vanish from every sibling list under one rule (`Number.isInteger`) while
    // crashing its own dispatch under another. Both sites now read
    // `isUsableIssueNumber`, so the run cannot hold two answers at once —
    // including for `1e21`, which `Number.isInteger` accepts and which would
    // have been rendered to a model as `#1e+21`.
    const ids = ["812", "not-an-issue", "0", "-3", "8.5", "1e21", ""];
    const briefs = await collectSiblingBriefs(
      ids.map((id) => ({ id, title: `ticket ${id}` })),
      {},
    );

    expect(briefs.map((b) => b.number)).toEqual([812]);
    // Stated as the predicate rather than as a hand-written list, so this test
    // fails if the collector ever grows its own second opinion again.
    expect(briefs.map((b) => String(b.number))).toEqual(
      ids.filter((id) => isUsableIssueNumber(Number(id))),
    );
  });
});

// ---------------------------------------------------------------------------
// siblingBriefsExcluding — a ticket is never handed itself.
// ---------------------------------------------------------------------------

describe("siblingBriefsExcluding", () => {
  const WHOLE_RUN: readonly SiblingTicketBrief[] = [
    {
      number: 812,
      title: "refuse a second deal at an address already on the board",
    },
    { number: 815, title: "a newly shipped dashboard card" },
    { number: 911, title: "the ticket under test" },
  ];

  it("removes the reading ticket's own entry and nothing else", () => {
    expect(siblingBriefsExcluding(WHOLE_RUN, 911).map((b) => b.number)).toEqual([
      812, 815,
    ]);
    expect(siblingBriefsExcluding(WHOLE_RUN, 812).map((b) => b.number)).toEqual([
      815, 911,
    ]);
  });

  it("is proven through the RENDERED text, not just the array", () => {
    // #812's own check-writer must not read #812's guard back as a
    // neighbour's rule to steer around.
    expect(
      renderSiblingTickets(siblingBriefsExcluding(WHOLE_RUN, 812)),
    ).not.toContain("refuse a second deal");
  });

  it("treats a ctx that never collected siblings as an empty run, not a crash", () => {
    expect(siblingBriefsExcluding(undefined, 911)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderSiblingTickets — the block the check-writer actually reads.
// ---------------------------------------------------------------------------

describe("renderSiblingTickets", () => {
  it("an empty run and a ctx that never collected render the same real sentence", () => {
    expect(renderSiblingTickets([])).toBe(NO_SIBLING_TICKETS);
    expect(renderSiblingTickets(undefined)).toBe(NO_SIBLING_TICKETS);
  });

  it("carries number, title and body, one delimited block per ticket", () => {
    const rendered = renderSiblingTickets([
      { number: 812, title: "refuse a duplicate address", body: "on every road in" },
      { number: 815, title: "a dashboard card", body: "for saved layouts" },
    ]);
    expect(rendered).toContain("#812");
    expect(rendered).toContain("refuse a duplicate address");
    expect(rendered).toContain("on every road in");
    expect(count(rendered, "<sibling-ticket>")).toBe(2);
    expect(count(rendered, "</sibling-ticket>")).toBe(2);
  });

  it("says a body could not be READ when it is absent", () => {
    const rendered = renderSiblingTickets([{ number: 815, title: "t" }]);
    expect(rendered).toContain("could not be read");
    expect(rendered).not.toContain("has no body");
  });

  it("says the ticket HAS NO BODY when it was read and is empty — a different fact, differently worded", () => {
    const rendered = renderSiblingTickets([
      { number: 815, title: "t", body: "" },
    ]);
    expect(rendered).toContain("has no body");
    expect(rendered).not.toContain("could not be read");
  });

  // -------------------------------------------------------------------------
  // Escaping. The block's whole value is its shape: the prompt tells the
  // check-writer that each <sibling-ticket> block is one neighbouring ticket.
  // A ticket whose own text contains that tag would close the block early and
  // the rest of its body would read as prompt instructions — and this is not a
  // contrived input, because the ticket that introduced this module discusses
  // these very tags.
  // -------------------------------------------------------------------------

  it("a body containing the closing tag cannot close the block", () => {
    const rendered = renderSiblingTickets([
      {
        number: 812,
        title: "t",
        body: "the renderer emits </sibling-ticket> at the end of each block",
      },
    ]);
    expect(count(rendered, "</sibling-ticket>")).toBe(1); // the real one only
    expect(rendered).toContain("&lt;/sibling-ticket&gt;");
    // Neutralised, not deleted: a neighbour that talks about these tags should
    // still visibly be talking about them.
    expect(rendered).toContain("at the end of each block");
  });

  it("a body containing the OPENING tag cannot start a phantom ticket", () => {
    const rendered = renderSiblingTickets([
      { number: 812, title: "t", body: "wrap it in <sibling-ticket> first" },
    ]);
    expect(count(rendered, "<sibling-ticket>")).toBe(1);
    expect(rendered).toContain("&lt;sibling-ticket&gt;");
  });

  it("a TITLE containing the tag is neutralised too", () => {
    const rendered = renderSiblingTickets([
      { number: 812, title: "render </sibling-ticket> safely", body: "b" },
    ]);
    expect(count(rendered, "</sibling-ticket>")).toBe(1);
    expect(rendered).toContain("&lt;/sibling-ticket&gt;");
  });

  it("the PLURAL wrapper the prompt puts around the block is neutralised as well", () => {
    // `check-writer-prompt.md` wraps this whole block in <sibling-tickets>;
    // closing that one early would drop the rest of the prompt's own
    // instructions out of their section.
    const rendered = renderSiblingTickets([
      { number: 812, title: "t", body: "closes with </sibling-tickets>" },
    ]);
    expect(rendered).not.toContain("</sibling-tickets>");
    expect(rendered).toContain("&lt;/sibling-tickets&gt;");
  });

  it("matches the tag however it is written — case and stray spacing included", () => {
    const rendered = renderSiblingTickets([
      { number: 812, title: "t", body: "< / SIBLING-TICKET > and </Sibling-Ticket>" },
    ]);
    expect(count(rendered, "</sibling-ticket>")).toBe(1);
    expect(rendered).toContain("&lt;/SIBLING-TICKET&gt;");
    expect(rendered).toContain("&lt;/Sibling-Ticket&gt;");
  });

  it("leaves every OTHER angle bracket alone — this escapes a delimiter, not markup", () => {
    const rendered = renderSiblingTickets([
      {
        number: 812,
        title: "t",
        body: "<div> stays, `a < b` stays, <ticket> stays",
      },
    ]);
    expect(rendered).toContain("<div> stays");
    expect(rendered).toContain("a < b");
    expect(rendered).toContain("<ticket> stays");
  });
});
