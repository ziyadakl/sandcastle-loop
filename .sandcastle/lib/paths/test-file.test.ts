import { describe, expect, it } from "vitest";

import { isTestFilePath } from "./test-file.js";

describe("isTestFilePath — deliberately tight, because the two errors are not symmetric", () => {
  it("matches .test. and .spec. filenames across the dialects this repo compiles", () => {
    for (const p of [
      "packages/api/src/router/deal.test.ts",
      "apps/nextjs/src/components/widget.test.tsx",
      ".sandcastle/main.checkwriter.test.mts",
      "packages/db/src/schema.test.cts",
      "tooling/eslint/rule.test.js",
      "apps/nextjs/src/hooks/use-thing.test.jsx",
      "apps/nextjs/e2e/os-shell-top-bar.spec.ts",
      "apps/nextjs/e2e/checks/issue-900/team-cash-flow.spec.ts",
      "packages/ui/src/button.spec.tsx",
    ]) {
      expect(isTestFilePath(p), p).toBe(true);
    }
  });

  it("matches anything under a __tests__/ or __snapshots__/ segment, at any depth", () => {
    for (const p of [
      "packages/api/src/__tests__/helpers.ts",
      "__tests__/top-level.ts",
      "apps/nextjs/src/a/b/__tests__/c/deep.ts",
      "packages/ui/src/__snapshots__/button.tsx.snap",
    ]) {
      expect(isTestFilePath(p), p).toBe(true);
    }
  });

  it("matches .snap files wherever they sit", () => {
    expect(isTestFilePath("packages/ui/src/button.tsx.snap")).toBe(true);
  });

  it("REFUSES the near-misses — this is the whole point of the module", () => {
    // Each of these could hold shipped behaviour, or could make a test pass
    // without the product changing. A false positive here ships product code
    // that no screen check ever looked at.
    for (const p of [
      "packages/api/vitest.setup.ts", // setup file
      "apps/nextjs/vitest.config.ts", // test CONFIG is not a test
      "packages/db/src/test-helpers.ts", // helper, not a test
      "packages/api/src/testing/factories.ts", // fixture builder
      "packages/db/scripts/practice-world/deals.ts", // the answer key itself
      "apps/nextjs/package.json", // where the e2e script lives
      "packages/api/src/router/deal.ts",
      "apps/nextjs/src/app/page.tsx",
      "packages/api/src/router/spec.ts", // "spec" as a NAME, not a suffix
      "apps/nextjs/src/lib/test.ts",
      "docs/testing.md",
      "packages/ui/src/tests/button.ts", // plain "tests/", not "__tests__/"
    ]) {
      expect(isTestFilePath(p), p).toBe(false);
    }
  });

  it("a `..` segment answers false — it makes every segment claim meaningless", () => {
    // Unreachable from a git diff (git cannot put `..` in a tree path), but
    // without this the string below reads as test material and is not.
    expect(
      isTestFilePath(
        "packages/api/src/__tests__/../../../apps/nextjs/src/app/page.tsx",
      ),
    ).toBe(false);
    expect(isTestFilePath("../packages/api/src/deal.test.ts")).toBe(false);
  });

  it("stays CASE-SENSITIVE — an `i` flag here would start matching source files", () => {
    // Pinned deliberately: a well-meaning "make it case-insensitive" edit
    // would otherwise pass the suite while widening what ships unchecked.
    expect(isTestFilePath("packages/api/src/Deal.Test.TS")).toBe(false);
    expect(isTestFilePath("packages/api/src/__TESTS__/helper.ts")).toBe(false);
  });

  it("a DIRECTORY named like a test file does not make its contents tests", () => {
    expect(isTestFilePath("packages/api/src/deal.test.ts/index.ts")).toBe(
      false,
    );
  });

  it("is total: hostile input answers false rather than throwing", () => {
    expect(isTestFilePath("")).toBe(false);
    // @ts-expect-error deliberately hostile input
    expect(isTestFilePath(undefined)).toBe(false);
    // @ts-expect-error deliberately hostile input
    expect(isTestFilePath(null)).toBe(false);
    // @ts-expect-error deliberately hostile input
    expect(isTestFilePath(42)).toBe(false);
  });
});
