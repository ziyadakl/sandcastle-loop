import { describe, expect, it } from "vitest";

import { issueCheckDirsIn } from "./own-check-dirs.js";
import { lockedCheckTouches } from "./proof-demand.js";

const BROWSER = "apps/nextjs/e2e/checks/issue-1310";
const UNIT = "packages/api/src/__checks__/issue-1310";

describe("issueCheckDirsIn — every issue-<N> check folder a diff touches (#1361)", () => {
  it("finds both layouts, once each, in a stable order", () => {
    expect(
      issueCheckDirsIn(
        [
          `${UNIT}/must-fail-first-proof.json`,
          `${BROWSER}/team-access.spec.ts`,
          `${UNIT}/access-change.test.ts`,
          "packages/api/src/router/team.ts",
        ],
        1310,
      ),
    ).toEqual([BROWSER, UNIT]);
  });

  it("matches the number exactly — issue-131 is not issue-1311, and issue-1311 is not issue-131", () => {
    const files = [
      "packages/api/src/__checks__/issue-1311/x.test.ts",
      "apps/nextjs/e2e/checks/issue-13110/y.spec.ts",
    ];
    expect(issueCheckDirsIn(files, 131)).toEqual([]);
    expect(issueCheckDirsIn(files, 1311)).toEqual([
      "packages/api/src/__checks__/issue-1311",
    ]);
  });

  it("ignores a folder named issue-<N> that is not under a check root", () => {
    expect(
      issueCheckDirsIn(
        [
          "docs/issue-1310/notes.md",
          "packages/api/src/__tests__/issue-1310/x.test.ts",
          "packages/api/__checks__/issue-1310/x.test.ts",
        ],
        1310,
      ),
    ).toEqual([]);
  });

  it("owns only folders under the roots the lock covers, so ownership and the lock cannot drift apart", () => {
    // The browser lock root is the one literal `CHECKS_ROOT`
    // (`apps/nextjs/e2e/checks`); the unit lock root is `src/__checks__` under
    // any package. An `e2e/checks` folder anywhere else is not locked, so it
    // is not a check folder this function may name.
    const outsideLock = [
      "packages/foo/e2e/checks/issue-1310/x.spec.ts",
      "apps/other/e2e/checks/issue-1310/y.spec.ts",
      "e2e/checks/issue-1310/z.spec.ts",
    ];
    expect(issueCheckDirsIn(outsideLock, 1310)).toEqual([]);
    expect(lockedCheckTouches(outsideLock, null)).toEqual([]);

    const insideLock = [
      `${BROWSER}/a.spec.ts`,
      `${UNIT}/b.test.ts`,
      "packages/db/src/__checks__/issue-1310/c.test.ts",
    ];
    expect(lockedCheckTouches(insideLock, null)).toEqual(insideLock);
    expect(issueCheckDirsIn(insideLock, 1310)).toEqual([
      BROWSER,
      UNIT,
      "packages/db/src/__checks__/issue-1310",
    ]);
  });

  it("ignores a `..`-bearing path and junk input", () => {
    expect(
      issueCheckDirsIn(["packages/api/src/__checks__/issue-1310/../x.ts"], 1310),
    ).toEqual([]);
    expect(issueCheckDirsIn(null, 1310)).toEqual([]);
    expect(issueCheckDirsIn(["", 7] as never, 1310)).toEqual([]);
    expect(issueCheckDirsIn([`${UNIT}/x.test.ts`], 0)).toEqual([]);
    expect(issueCheckDirsIn([`${UNIT}/x.test.ts`], 1.5)).toEqual([]);
    // Not a safe integer: `Number.isInteger` would accept it and build `issue-1e+21`.
    expect(
      issueCheckDirsIn(["packages/api/src/__checks__/issue-1e+21/x.test.ts"], 1e21),
    ).toEqual([]);
  });
});
