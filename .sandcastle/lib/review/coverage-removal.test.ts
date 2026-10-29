/**
 * The pure half of the coverage-removal detector: the two extra parsers and
 * the size decision. `diff-measurement.test.ts` proves the composition against
 * real git; this file pins the pieces and the edges git is inconvenient to
 * reproduce (a tree entry that is not a blob, a path with a tab in it, a
 * candidate absent from one side).
 */
import { describe, expect, it } from "vitest";

import {
  COVERAGE_COLLAPSE_RATIO,
  collapsedPaths,
  parseDeletedPaths,
  parseRenames,
  parseShrinkCandidates,
  parseTreeSizes,
  PURE_DELETION_COLLAPSE_RATIO,
  renamedNotRemoved,
} from "./coverage-removal.js";

const rec = (added: string, deleted: string, p: string) =>
  `${added}\t${deleted}\t${p}`;

describe("parseDeletedPaths", () => {
  it("reads the NUL-separated paths `--name-only -z` prints", () => {
    expect(parseDeletedPaths("a/x.spec.ts\0b/y.spec.ts\0")).toEqual([
      "a/x.spec.ts",
      "b/y.spec.ts",
    ]);
  });

  it("is total on empty and separator-only input", () => {
    expect(parseDeletedPaths("")).toEqual([]);
    expect(parseDeletedPaths("\0\0")).toEqual([]);
  });

  it("keeps a path with spaces or a tab in it intact", () => {
    // `-z` emits RAW paths, so a tab is content, not a delimiter. Nothing may
    // split on whitespace here.
    expect(parseDeletedPaths("e2e/a b\tc.spec.ts\0")).toEqual([
      "e2e/a b\tc.spec.ts",
    ]);
  });
});

describe("parseShrinkCandidates", () => {
  it("takes any path that LOST lines", () => {
    expect(parseShrinkCandidates(rec("1", "200", "a.test.ts"))).toEqual([
      "a.test.ts",
    ]);
    expect(parseShrinkCandidates(rec("0", "9", "b.test.ts"))).toEqual([
      "b.test.ts",
    ]);
  });

  it("takes a BINARY row too — `-`/`-` means the counts are UNKNOWN", () => {
    // The heart of hole 2's second half. `-`/`-` does not mean "nothing was
    // removed"; it means numstat could not say. Treating it as 0/0 is what let
    // a `.gitattributes binary` mark hide a gutting, so a binary row must be
    // sized rather than dismissed.
    expect(parseShrinkCandidates(rec("-", "-", "e2e/a.spec.ts"))).toEqual([
      "e2e/a.spec.ts",
    ]);
  });

  it("skips a pure addition and an untouched row — neither can have shrunk", () => {
    expect(parseShrinkCandidates(rec("12", "0", "new.test.ts"))).toEqual([]);
    expect(parseShrinkCandidates(rec("0", "0", "none.test.ts"))).toEqual([]);
  });

  it("is total on empty and malformed input", () => {
    expect(parseShrinkCandidates("")).toEqual([]);
    expect(parseShrinkCandidates("\0\0")).toEqual([]);
    expect(parseShrinkCandidates("no-tabs-here")).toEqual([]);
    expect(parseShrinkCandidates("0\tonly-one-tab")).toEqual([]);
  });

  it("keeps everything after the SECOND tab as the path", () => {
    expect(parseShrinkCandidates("1\t200\te2e/a\tb.spec.ts")).toEqual([
      "e2e/a\tb.spec.ts",
    ]);
  });
});

describe("parseTreeSizes", () => {
  // `git ls-tree -r -l -z` prints:
  //   <mode> SP <type> SP <sha> SP<right-aligned size> TAB <path> NUL
  const entry = (size: string, p: string, type = "blob") =>
    `100644 ${type} ${"a".repeat(40)} ${size.padStart(7)}\t${p}\0`;

  it("reads the size of each blob", () => {
    expect(
      parseTreeSizes(entry("4882", "CLAUDE.md") + entry("120", "a/b.test.ts")),
    ).toEqual(
      new Map([
        ["CLAUDE.md", 4882],
        ["a/b.test.ts", 120],
      ]),
    );
  });

  it("skips a non-blob entry, whose size column git prints as `-`", () => {
    // A submodule is a `commit` entry with no size. Recording it as 0 would
    // make every submodule look like an emptied file forever.
    expect(parseTreeSizes(entry("-", "vendor/thing", "commit"))).toEqual(
      new Map(),
    );
  });

  it("keeps a path containing a tab intact", () => {
    expect(parseTreeSizes(entry("10", "e2e/a\tb.spec.ts"))).toEqual(
      new Map([["e2e/a\tb.spec.ts", 10]]),
    );
  });

  it("is total on empty and malformed input", () => {
    expect(parseTreeSizes("")).toEqual(new Map());
    expect(parseTreeSizes("\0\0")).toEqual(new Map());
    expect(parseTreeSizes("garbage-with-no-tab\0")).toEqual(new Map());
  });
});

describe("collapsedPaths", () => {
  const sizes = (entries: [string, number][]) => new Map(entries);

  it("reports a file that kept a small fraction of its bytes", () => {
    expect(
      collapsedPaths({
        candidates: ["a.test.ts"],
        sizesBefore: sizes([["a.test.ts", 8000]]),
        sizesAfter: sizes([["a.test.ts", 22]]),
      }),
    ).toEqual(["a.test.ts"]);
  });

  it("does NOT report a file that kept most of itself", () => {
    // The healthy-refactor shape measured across this repo's history: a spec
    // loses its boilerplate and stays a suite.
    expect(
      collapsedPaths({
        candidates: ["a.spec.ts"],
        sizesBefore: sizes([["a.spec.ts", 20805]]),
        sizesAfter: sizes([["a.spec.ts", 18399]]),
      }),
    ).toEqual([]);
  });

  it("is a STRICT threshold — exactly at the ratio is not a collapse", () => {
    expect(
      collapsedPaths({
        candidates: ["a.test.ts"],
        sizesBefore: sizes([["a.test.ts", 1000]]),
        sizesAfter: sizes([["a.test.ts", 1000 * COVERAGE_COLLAPSE_RATIO]]),
      }),
    ).toEqual([]);
  });

  it("reports a candidate that is GONE from the after tree", () => {
    // Belt and braces with the `--diff-filter=D` set: a candidate with no
    // after-size kept nothing at all.
    expect(
      collapsedPaths({
        candidates: ["a.test.ts"],
        sizesBefore: sizes([["a.test.ts", 8000]]),
        sizesAfter: sizes([]),
      }),
    ).toEqual(["a.test.ts"]);
  });

  it("does NOT report a candidate absent from the BEFORE tree", () => {
    // Nothing to shrink from. Answering "collapsed" would report every newly
    // added file the moment a later hunk deleted a line from it.
    expect(
      collapsedPaths({
        candidates: ["a.test.ts"],
        sizesBefore: sizes([]),
        sizesAfter: sizes([["a.test.ts", 10]]),
      }),
    ).toEqual([]);
  });

  it("does NOT report a file that was already empty before", () => {
    // preSize 0 makes the ratio meaningless (0 < 0 is false either way);
    // pinned so nobody later rewrites it into a divide.
    expect(
      collapsedPaths({
        candidates: ["a.test.ts"],
        sizesBefore: sizes([["a.test.ts", 0]]),
        sizesAfter: sizes([["a.test.ts", 0]]),
      }),
    ).toEqual([]);
  });

  it("preserves candidate order and reports only the collapsed ones", () => {
    expect(
      collapsedPaths({
        candidates: ["keep.ts", "gone.test.ts", "also-keep.ts", "stub.test.ts"],
        sizesBefore: sizes([
          ["keep.ts", 100],
          ["gone.test.ts", 9000],
          ["also-keep.ts", 500],
          ["stub.test.ts", 4000],
        ]),
        sizesAfter: sizes([
          ["keep.ts", 90],
          ["gone.test.ts", 20],
          ["also-keep.ts", 480],
          ["stub.test.ts", 30],
        ]),
      }),
    ).toEqual(["gone.test.ts", "stub.test.ts"]);
  });

  it("honours an explicit ratio, so the threshold is testable not baked in", () => {
    const input = {
      candidates: ["a.test.ts"],
      sizesBefore: sizes([["a.test.ts", 1000] as [string, number]]),
      sizesAfter: sizes([["a.test.ts", 400] as [string, number]]),
    };
    expect(collapsedPaths({ ...input, ratio: 0.25 })).toEqual([]);
    expect(collapsedPaths({ ...input, ratio: 0.5 })).toEqual(["a.test.ts"]);
  });
});

describe("COVERAGE_COLLAPSE_RATIO", () => {
  it("sits well below the tightest real edit measured in this repo", () => {
    // Evidence, not taste. Across 918 MODIFIED test-file rows under apps/**
    // and packages/** in this repo's first-parent history, the tightest
    // legitimate edit kept 54.3% of its bytes (2552B -> 1385B, f234253d).
    // The threshold is less than half of that, and the attack it must catch
    // (200-case suite -> `it("noop", () => {});`) keeps under 1%.
    expect(COVERAGE_COLLAPSE_RATIO).toBeLessThan(0.543 / 2);
    expect(COVERAGE_COLLAPSE_RATIO).toBeGreaterThan(0.01);
  });
});

describe("parseRenames", () => {
  // `--name-status -z` prints THREE NUL-terminated fields per rename, not two:
  // the status with its similarity score, the old path, then the new one.
  const r = (score: string, from: string, to: string) =>
    `R${score}\0${from}\0${to}\0`;

  it("reads the (from, to) pairs out of the three-field records", () => {
    expect(
      parseRenames(
        r("078", "a/old.test.ts", "a/new.test.ts") +
          r("100", "b/x.spec.ts", "b/y.spec.ts"),
      ),
    ).toEqual([
      { from: "a/old.test.ts", to: "a/new.test.ts" },
      { from: "b/x.spec.ts", to: "b/y.spec.ts" },
    ]);
  });

  it("keeps a path with spaces or a tab in it intact", () => {
    // `-z` emits RAW paths; nothing here may split on whitespace.
    expect(parseRenames(r("090", "a/o e\tld.test.ts", "a/n w.test.ts"))).toEqual([
      { from: "a/o e\tld.test.ts", to: "a/n w.test.ts" },
    ]);
  });

  it("stops rather than mis-pairing when a record is not a rename", () => {
    // The stream is only self-describing while every record is three fields
    // wide. A non-`R` status means the caller widened --diff-filter and the
    // triples no longer line up, so the safe answer is to stop reading.
    expect(parseRenames("M\0a/x.test.ts\0")).toEqual([]);
  });

  it("is total on empty, truncated and malformed input", () => {
    expect(parseRenames("")).toEqual([]);
    expect(parseRenames("\0\0")).toEqual([]);
    expect(parseRenames("R100\0a/only-one-path.test.ts\0")).toEqual([]);
  });
});

describe("renamedNotRemoved", () => {
  /**
   * A rename whose destination arrived INTACT — identical bytes on both sides,
   * so only the two PATH conditions can decide it. The size condition needs its
   * own cases and gets them below.
   */
  const move = (from: string, to: string) => ({
    renames: [{ from, to }],
    sizesBefore: new Map([[from, 20_000]]),
    sizesAfter: new Map([[to, 20_000]]),
  });

  it("exonerates #820's move: same directory, still a test", () => {
    const dir = "packages/api/src/services/widgets/__tests__";
    expect(
      renamedNotRemoved(
        move(
          `${dir}/staging-rls.integration.test.ts`,
          `${dir}/staging-rls-query-shape.test.ts`,
        ),
      ),
    ).toEqual([`${dir}/staging-rls.integration.test.ts`]);
  });

  it("exonerates a move across packages, which is still the watched root", () => {
    expect(
      renamedNotRemoved(
        move("packages/api/src/__tests__/a.test.ts", "packages/db/src/__tests__/a.test.ts"),
      ),
    ).toEqual(["packages/api/src/__tests__/a.test.ts"]);
  });

  it("refuses a move OUT of the top-level directory it started in", () => {
    // The property `--no-renames` was chosen for. `apps/** -> packages/**` is
    // refused on the same rule; it is a real move of coverage between
    // workspaces and stopping for a person is the cheap way to be wrong.
    expect(
      renamedNotRemoved(move("apps/nextjs/e2e/a.spec.ts", "scratch/a.spec.ts")),
    ).toEqual([]);
    expect(
      renamedNotRemoved(
        move("packages/api/src/__tests__/a.test.ts", "apps/nextjs/e2e/a.test.ts"),
      ),
    ).toEqual([]);
  });

  it("refuses a rename that stops the file BEING a test", () => {
    // 100% similar, same directory, and vitest never loads it again.
    expect(
      renamedNotRemoved(
        move(
          "packages/api/src/__tests__/a.test.ts",
          "packages/api/src/a.test.ts.bak",
        ),
      ),
    ).toEqual([]);
  });

  it("exonerates an ordinary source-file rename", () => {
    // There was no coverage to keep, so neither condition has anything to say.
    expect(
      renamedNotRemoved(move("packages/api/src/old.ts", "packages/api/src/new.ts")),
    ).toEqual(["packages/api/src/old.ts"]);
  });

  it("refuses a `..`-bearing path, which makes every segment claim meaningless", () => {
    expect(
      renamedNotRemoved(
        move("packages/api/src/__tests__/a.test.ts", "packages/api/../x/a.test.ts"),
      ),
    ).toEqual([]);
  });

  it("refuses a rename whose destination arrived GUTTED", () => {
    // The hole a path-shape-only exemption leaves: every condition above is
    // satisfied — same top-level directory, still a test path, no `..` — and
    // the suite that arrived is a stub. Location is not content.
    //
    // Read the function's doc before reading this as a live catch: at the
    // pinned `--find-renames=50%` git will not CALL this pair a rename (the
    // shape is proven against real git in `diff-measurement.test.ts`), so what
    // is pinned here is that the exemption defends itself rather than relying
    // on git's scorer to keep the input away from it.
    const dir = "apps/nextjs/e2e";
    expect(
      renamedNotRemoved({
        renames: [
          { from: `${dir}/checkout.spec.ts`, to: `${dir}/checkout-flow.spec.ts` },
        ],
        sizesBefore: new Map([[`${dir}/checkout.spec.ts`, 20_000]]),
        sizesAfter: new Map([[`${dir}/checkout-flow.spec.ts`, 900]]),
      }),
    ).toEqual([]);
  });

  it("refuses a rename whose destination is ABSENT from the after tree", () => {
    // Nothing arrived at all, so nothing was kept. Same rule `collapsedPaths`
    // applies to a candidate missing from the after side, reached through the
    // same call rather than a second opinion about what a missing size means.
    const dir = "packages/api/src/__tests__";
    expect(
      renamedNotRemoved({
        renames: [{ from: `${dir}/a.test.ts`, to: `${dir}/b.test.ts` }],
        sizesBefore: new Map([[`${dir}/a.test.ts`, 8_000]]),
        sizesAfter: new Map(),
      }),
    ).toEqual([]);
  });

  it("exonerates a rename that shrank but stayed above the ratio", () => {
    // The healthy half of the same instrument, and the reason the ratio may not
    // be raised to make condition 3 fire: splitting one suite into two is #820's
    // shape and leaves each half at about 50% of the original.
    const dir = "packages/api/src/__tests__";
    expect(
      renamedNotRemoved({
        renames: [{ from: `${dir}/a.test.ts`, to: `${dir}/a-part1.test.ts` }],
        sizesBefore: new Map([[`${dir}/a.test.ts`, 20_000]]),
        sizesAfter: new Map([[`${dir}/a-part1.test.ts`, 10_500]]),
      }),
    ).toEqual([`${dir}/a.test.ts`]);
  });

  it("honours an explicit ratio, so the threshold is testable not baked in", () => {
    const dir = "packages/api/src/__tests__";
    const input = {
      renames: [{ from: `${dir}/a.test.ts`, to: `${dir}/b.test.ts` }],
      sizesBefore: new Map([[`${dir}/a.test.ts`, 20_000]]),
      sizesAfter: new Map([[`${dir}/b.test.ts`, 8_000]]),
    };
    expect(renamedNotRemoved({ ...input, ratio: 0.25 })).toEqual([
      `${dir}/a.test.ts`,
    ]);
    expect(renamedNotRemoved({ ...input, ratio: 0.5 })).toEqual([]);
  });

  it("exonerates a rename it cannot SIZE, rather than inventing a verdict", () => {
    // A source with no before-size is unreachable through git (it was a rename
    // source, so it was in the tree) but the direction is pinned deliberately:
    // "no before size" means "nothing to have shrunk from" everywhere else in
    // this module, and a size pass that starts guessing would fire on tree
    // entries it merely failed to parse.
    const dir = "packages/api/src/__tests__";
    expect(
      renamedNotRemoved({
        renames: [{ from: `${dir}/a.test.ts`, to: `${dir}/b.test.ts` }],
        sizesBefore: new Map(),
        sizesAfter: new Map([[`${dir}/b.test.ts`, 10]]),
      }),
    ).toEqual([`${dir}/a.test.ts`]);
  });

  it("is total on an empty list", () => {
    expect(
      renamedNotRemoved({
        renames: [],
        sizesBefore: new Map(),
        sizesAfter: new Map(),
      }),
    ).toEqual([]);
  });
});

describe("PURE_DELETION_COLLAPSE_RATIO", () => {
  it("sits above the collapse ratio and below the tightest real edit", () => {
    // Evidence, not taste, and the same 918-row population as its sibling. The
    // size instrument fires on ZERO of them at every threshold up to 0.5, and
    // the tightest legitimate edit kept 54.3% of its bytes. Below 0.25 the
    // collapse pass already answers; the band between is what "removed lines,
    // added none" keeps for itself.
    expect(PURE_DELETION_COLLAPSE_RATIO).toBeGreaterThan(COVERAGE_COLLAPSE_RATIO);
    expect(PURE_DELETION_COLLAPSE_RATIO).toBeLessThan(0.543);
  });

  it("clears #860 — a 140-line suite that lost two lines", () => {
    // 138/140 of the bytes survive; nothing that healthy may be called gutted.
    expect(
      collapsedPaths({
        candidates: ["a.test.ts"],
        sizesBefore: new Map([["a.test.ts", 4200]]),
        sizesAfter: new Map([["a.test.ts", 4140]]),
        ratio: PURE_DELETION_COLLAPSE_RATIO,
      }),
    ).toEqual([]);
  });
});
