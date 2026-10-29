import { describe, expect, it } from "vitest";

import { browserCheckLocation } from "../checkwriter/must-fail-first-receipt.js";
import { currentFirstTest } from "./first-test.js";

describe("currentFirstTest", () => {
  const accepted = {
    checkPath: "apps/nextjs/e2e/checks/issue-7/a.spec.ts",
    checkCommand: "run-a",
    screen: "/team",
    checkKind: "browser" as const,
    checkLocation: undefined,
    checkPackage: undefined,
    checkTestCount: 3,
  };

  it("is the check stage's accepted test until a rewrite proves itself", () => {
    expect(currentFirstTest(accepted, undefined)).toEqual(accepted);
  });

  it("is the rewritten test once one proves itself, with no carried-over scenario count", () => {
    const loc = browserCheckLocation(7, "b.spec.ts");
    if (loc === undefined) throw new Error("fixture location refused");
    const now = currentFirstTest(accepted, {
      checkLocation: loc,
      checkCommand: "run-b",
      checkKind: "browser",
      screen: "/team/b",
      checkPackage: undefined,
    });
    expect(now).toEqual({
      checkPath: `${loc.checkDir}/${loc.checkPath}`,
      checkCommand: "run-b",
      screen: "/team/b",
      checkKind: "browser",
      checkLocation: loc,
      checkPackage: undefined,
      checkTestCount: undefined,
    });
  });
});
