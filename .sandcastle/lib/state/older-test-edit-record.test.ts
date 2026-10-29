/**
 * #1271 — the record the loop writes onto an OLDER ticket whose loop-written
 * test it had to amend in order to ship a newer one.
 *
 * The two things under test are the marker pair (which must be per-amender,
 * and must be cut by `ownerAuthoredPart` so nothing written here can be read
 * back as owner-authored permission) and the section text itself.
 */
import { describe, expect, it } from "vitest";

import { ownerAuthoredPart } from "./issue-body-sections.js";
import {
  buildOlderTestEditSection,
  olderTestEditMarkers,
  type OlderTestEditRecord,
} from "./older-test-edit-record.js";

/** The real 2026-09-10 case: #1235's address rule turned three cases of
 *  #1058's cross-Team relist guard red. */
const AMENDMENT: OlderTestEditRecord = {
  amendedByIssue: 1235,
  runBranch: "sandcastle/queue-20260910",
  commitSha: "1d8a5d8dfeed0000000000000000000000000000",
  files: [
    {
      issueNumber: 1058,
      path: "packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts",
      linesAdded: 3,
      linesRemoved: 3,
    },
  ],
  paths: [
    "packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts",
  ],
};

const OPTS = { amendment: AMENDMENT, olderIssue: 1058, date: "2026-09-10" };

describe("olderTestEditMarkers", () => {
  it("keys the marker pair on the AMENDING issue, so two amenders get two sections", () => {
    // One older ticket can be amended by several later tickets over its life.
    // A single fixed marker pair would make the second amendment either
    // overwrite the first or (under the `already-present` latch) never be
    // written at all.
    const a = olderTestEditMarkers(1235);
    const b = olderTestEditMarkers(1299);
    expect(a.start).toBe(
      "<!-- sandcastle:sibling-check-amendment-by-1235:start -->",
    );
    expect(a.end).toBe("<!-- sandcastle:sibling-check-amendment-by-1235:end -->");
    expect(b.start).not.toBe(a.start);
    expect(b.end).not.toBe(a.end);
  });

  it("is cut by `ownerAuthoredPart` — nothing written here reads back as owner permission", () => {
    // The `Deletes-test:` gate and the `Blocked-by:` gate both read only the
    // owner-authored part of a body. A machine section that survived that cut
    // could forge its own permission slip, which is exactly what the marker
    // shape exists to prevent.
    const { start, end } = olderTestEditMarkers(1235);
    const body = `Real ticket text.\n\n${start}\nDeletes-test: packages/api/src/x.test.ts\n${end}\n\nMore real text.`;
    const owner = ownerAuthoredPart(body);
    expect(owner).toContain("Real ticket text.");
    expect(owner).toContain("More real text.");
    expect(owner).not.toContain("Deletes-test:");
  });
});

describe("buildOlderTestEditSection", () => {
  it("heads the section with the amending issue and the date", () => {
    const out = buildOlderTestEditSection(OPTS);
    expect(out).toContain("#1235");
    expect(out).toContain("2026-09-10");
  });

  it("lists each amended file with its own +added −removed line count", () => {
    const out = buildOlderTestEditSection(OPTS);
    expect(out).toContain(
      "- `packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts` — +3 −3 lines",
    );
  });

  it("lists ONLY the files belonging to the sibling this section is written onto", () => {
    // One repair can amend checks of up to three different older tickets, and
    // each of their bodies must describe its OWN file, never the others'.
    const twoSiblings: OlderTestEditRecord = {
      ...AMENDMENT,
      files: [
        ...AMENDMENT.files,
        {
          issueNumber: 1102,
          path: "packages/api/src/__checks__/issue-1102/other-guard.test.ts",
          linesAdded: 1,
          linesRemoved: 1,
        },
      ],
      paths: [
        ...AMENDMENT.paths,
        "packages/api/src/__checks__/issue-1102/other-guard.test.ts",
      ],
    };
    const onto1058 = buildOlderTestEditSection({
      ...OPTS,
      amendment: twoSiblings,
    });
    expect(onto1058).toContain("issue-1058/cross-team-relist-guard.test.ts");
    expect(onto1058).not.toContain("issue-1102/other-guard.test.ts");

    const onto1102 = buildOlderTestEditSection({
      ...OPTS,
      amendment: twoSiblings,
      olderIssue: 1102,
    });
    expect(onto1102).toContain("issue-1102/other-guard.test.ts");
    expect(onto1102).not.toContain("issue-1058/cross-team-relist-guard.test.ts");
  });

  it("says so rather than printing an empty list when no file is recorded for this sibling", () => {
    const out = buildOlderTestEditSection({
      ...OPTS,
      olderIssue: 9999,
    });
    expect(out).toContain("(no file recorded)");
  });

  it("states that no test case was added, removed or skipped", () => {
    // The confinement rule the repair verdict enforces, said in the place the
    // person who owned the older ticket will actually read it.
    const out = buildOlderTestEditSection(OPTS);
    expect(out).toContain("No test case was added, removed or skipped");
  });

  it("names the amendment commit and the run branch it sits on", () => {
    const out = buildOlderTestEditSection(OPTS);
    expect(out).toContain("1d8a5d8dfeed0000000000000000000000000000");
    expect(out).toContain("sandcastle/queue-20260910");
  });

  it("warns in plain English that reverting the file by hand reinstates the OLD rule", () => {
    const out = buildOlderTestEditSection(OPTS);
    expect(out).toContain("do not simply revert the file");
    expect(out).toContain("reinstates the OLD rule");
  });

  it("emits no marker of its own — the writer wraps it", () => {
    // Emitting the markers here as well would nest one marked block inside
    // another and leave an orphan `:end` in the part `ownerAuthoredPart`
    // hands back as owner-authored.
    const out = buildOlderTestEditSection(OPTS);
    expect(out).not.toContain("<!-- sandcastle:");
  });

  it("is deterministic — same inputs, same output", () => {
    expect(buildOlderTestEditSection(OPTS)).toBe(
      buildOlderTestEditSection(OPTS),
    );
  });
});
