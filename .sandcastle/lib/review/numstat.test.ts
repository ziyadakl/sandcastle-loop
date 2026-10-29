/**
 * The numstat record contract, and the guard that the two parsers reading it
 * can never disagree about what a record is (issue #959).
 *
 * WHY THIS FILE EXISTS. `parseNumstat` and `parseGuttedFiles` used to be two
 * verbatim copies of one record loop, in `./escalation.ts`, identical except
 * for the final predicate, with nothing keeping them in step. That is not a
 * tidiness complaint. The ship-time proof gate INTERSECTS the two answers
 * (`../checkwriter/proof-demand.ts`): the removal set from `parseGuttedFiles`,
 * the changed-file set from `parseNumstat`. Let one copy's idea of a record
 * drift and the intersection starts dropping real removals on the floor —
 * which is the exact failure the removal gate was built to prevent, arriving
 * silently and through the gate's own plumbing.
 *
 * The copies are now one generator, {@link numstatRecords}. `agreeOnPaths`
 * below is the standing proof of that: for every input, the paths
 * `parseGuttedFiles` returns are a SUBSET of the paths `parseNumstat` returns.
 * Re-fork the loop and this file goes red.
 *
 * These are string fixtures on purpose, unlike `./diff-measurement.test.ts`
 * next door, which drives real commits. That file tests what git PRINTS; this
 * one tests what the parser does with bytes, including bytes real git is
 * awkward to make produce on demand (a tab inside a filename, a truncated
 * record, a lone trailing newline).
 */
import { describe, expect, it } from "vitest";

import { numstatRecords, parseGuttedFiles, parseNumstat } from "./numstat.js";

/** One `--numstat -z` record, terminator included. */
function rec(added: string, deleted: string, path: string): string {
  return `${added}\t${deleted}\t${path}\0`;
}

/**
 * Every input both parsers are pointed at below. Each entry is a whole stdout
 * string, so a case can cover record separation as well as one record's shape.
 */
const CORPUS: readonly { readonly name: string; readonly stdout: string }[] = [
  { name: "empty stdout", stdout: "" },
  { name: "a lone trailing newline", stdout: "\n" },
  { name: "one ordinary edit", stdout: rec("4", "2", "packages/api/src/a.ts") },
  { name: "a pure deletion", stdout: rec("0", "9", "packages/api/src/b.test.ts") },
  { name: "an addition only", stdout: rec("9", "0", "packages/api/src/c.ts") },
  { name: "a binary file", stdout: rec("-", "-", "apps/nextjs/public/x.png") },
  { name: "a zero/zero row", stdout: rec("0", "0", "packages/db/empty.ts") },
  {
    name: "a path containing a literal tab",
    stdout: rec("0", "3", "packages/api/we\tird.test.ts"),
  },
  { name: "a path with leading and trailing spaces", stdout: rec("0", "5", "  spaced  ") },
  { name: "a non-ASCII raw path", stdout: rec("1", "1", "src/café.ts") },
  { name: "a record with only one tab", stdout: "3\tpackages/api/truncated.ts\0" },
  { name: "a record with no tab at all", stdout: "garbage\0" },
  { name: "non-numeric columns", stdout: rec("x", "y", "packages/api/odd.ts") },
  {
    name: "several records, mixed shapes",
    stdout:
      rec("4", "2", "packages/api/src/a.ts") +
      rec("0", "9", "packages/api/src/b.test.ts") +
      rec("-", "-", "apps/nextjs/public/x.png") +
      rec("0", "1", "apps/nextjs/e2e/c.spec.ts") +
      "\n",
  },
];

describe("numstatRecords — the one record contract", () => {
  it("skips a record with fewer than two tabs, and empty records", () => {
    const stdout =
      "no-tabs\0" +
      "3\tone-tab-only.ts\0" +
      "\0" +
      rec("1", "1", "packages/api/kept.ts");
    expect([...numstatRecords(stdout)]).toEqual([
      { added: 1, deleted: 1, path: "packages/api/kept.ts" },
    ]);
  });

  it("reads everything after the SECOND tab as the path, tabs included", () => {
    const records = [...numstatRecords(rec("0", "3", "packages/api/we\tird.test.ts"))];
    expect(records).toEqual([
      { added: 0, deleted: 3, path: "packages/api/we\tird.test.ts" },
    ]);
  });

  it("keeps a path's own leading and trailing spaces", () => {
    // The emptiness test trims; the PATH must not be trimmed, or a legitimately
    // space-padded filename joins to nothing downstream.
    expect([...numstatRecords(rec("0", "5", "  spaced  "))]).toEqual([
      { added: 0, deleted: 5, path: "  spaced  " },
    ]);
  });

  it("counts a binary `-`/`-` row as 0/0 but still yields the file", () => {
    // 0/0 here means "git declined to count", NOT "nothing changed". The record
    // must survive so a later instrument (existence, byte size) can judge it.
    expect([...numstatRecords(rec("-", "-", "apps/nextjs/public/x.png"))]).toEqual([
      { added: 0, deleted: 0, path: "apps/nextjs/public/x.png" },
    ]);
  });

  it("coerces a non-numeric column to 0 rather than NaN", () => {
    expect([...numstatRecords(rec("x", "y", "packages/api/odd.ts"))]).toEqual([
      { added: 0, deleted: 0, path: "packages/api/odd.ts" },
    ]);
  });
});

describe("the two parsers cannot drift apart — issue #959", () => {
  it.each(CORPUS)(
    "agreeOnPaths: gutted ⊆ changed, for $name",
    ({ stdout }) => {
      const changed = new Set(parseNumstat(stdout).changedFiles);
      for (const gutted of parseGuttedFiles(stdout)) {
        // The ship-time proof gate intersects these two sets. A gutted path
        // absent from the changed set is a removal the gate silently drops.
        expect(changed.has(gutted)).toBe(true);
      }
    },
  );

  it.each(CORPUS)(
    "both parsers see the SAME record count, for $name",
    ({ stdout }) => {
      // The subset property alone would survive one parser skipping records the
      // other keeps, as long as the skipped ones were not gutted. Pinning the
      // record count is what makes a re-forked loop go red.
      const records = [...numstatRecords(stdout)];
      expect(parseNumstat(stdout).changedFiles).toHaveLength(records.length);
      expect(parseGuttedFiles(stdout)).toHaveLength(
        records.filter((r) => r.added === 0 && r.deleted > 0).length,
      );
    },
  );
});

describe("parseNumstat", () => {
  it("totals added + deleted across records and keeps git's order", () => {
    const stdout =
      rec("4", "2", "packages/api/src/a.ts") +
      rec("0", "9", "packages/api/src/b.test.ts") +
      rec("-", "-", "apps/nextjs/public/x.png");
    expect(parseNumstat(stdout)).toEqual({
      changedLines: 15,
      changedFiles: [
        "packages/api/src/a.ts",
        "packages/api/src/b.test.ts",
        "apps/nextjs/public/x.png",
      ],
    });
  });

  it("returns an empty measurement for empty stdout", () => {
    expect(parseNumstat("")).toEqual({ changedLines: 0, changedFiles: [] });
  });
});

describe("parseGuttedFiles", () => {
  it("keeps only rows that removed lines and added none", () => {
    const stdout =
      rec("4", "2", "packages/api/src/a.ts") +
      rec("0", "9", "packages/api/src/b.test.ts") +
      rec("0", "1", "apps/nextjs/e2e/c.spec.ts") +
      rec("9", "0", "packages/api/src/d.ts");
    expect(parseGuttedFiles(stdout)).toEqual([
      "packages/api/src/b.test.ts",
      "apps/nextjs/e2e/c.spec.ts",
    ]);
  });

  it("does NOT report a binary row, and that is a known blind spot", () => {
    // `-`/`-` parses as 0/0, so `deleted > 0` is false. This is the documented
    // limit of a numstat predicate, not a bug here: `./coverage-removal.ts`'s
    // existence question is the instrument that catches it, and
    // `guttedFilesBetween` unions the two.
    expect(parseGuttedFiles(rec("-", "-", "apps/nextjs/e2e/deleted.spec.ts"))).toEqual(
      [],
    );
  });

  it("does NOT report a 0/0 row", () => {
    expect(parseGuttedFiles(rec("0", "0", "packages/db/empty.ts"))).toEqual([]);
  });
});
