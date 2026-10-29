/**
 * Tests for the protected-path DETECTION half (issue #909 / Piece C). Pure —
 * no git, no fs. The IO half (restore + commit) is proven against a real
 * temp git repo in `protected-path-restore.test.ts`, and the end-to-end
 * ship-time wiring against a real tampering commit lives in
 * `main.protected-paths.test.mts`.
 */
import { describe, expect, it } from "vitest";

import {
  defaultProtectedPathGlobs,
  detectProtectedPathViolations,
  resolveProtectedPathGlobs,
} from "./protected-paths.js";

// The always-on globs are the project's `protectedPaths` setting; these tests
// run with project.example.json installed.
import { resetProjectConfig } from "../project-config.js";
import { EXAMPLE_PROJECT_CONFIG } from "../../__fixtures__/example-project-config.js";
const DEFAULT_PROTECTED_PATH_GLOBS = EXAMPLE_PROJECT_CONFIG.protectedPaths;

describe("protectedPaths defaults", () => {
  it("is EMPTY when the project sets none: nothing is protected, nothing fails", () => {
    resetProjectConfig();
    expect(defaultProtectedPathGlobs()).toEqual([]);
    expect(resolveProtectedPathGlobs()).toEqual([]);
    // A per-job glob still works with no project paths.
    expect(resolveProtectedPathGlobs(["x/**"])).toEqual(["x/**"]);
  });
});

describe("resolveProtectedPathGlobs", () => {
  it("always includes the project's protectedPaths with no per-job input", () => {
    expect(resolveProtectedPathGlobs()).toEqual(DEFAULT_PROTECTED_PATH_GLOBS);
    expect(resolveProtectedPathGlobs(undefined)).toEqual(
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
  });

  it("adds a per-job glob without dropping the defaults", () => {
    const resolved = resolveProtectedPathGlobs([".sandcastle/checks/909.md"]);
    for (const g of DEFAULT_PROTECTED_PATH_GLOBS) expect(resolved).toContain(g);
    expect(resolved).toContain(".sandcastle/checks/909.md");
  });

  it("cannot be used to SUBTRACT a default — an empty per-job list changes nothing", () => {
    expect(resolveProtectedPathGlobs([])).toEqual(DEFAULT_PROTECTED_PATH_GLOBS);
  });

  it("de-duplicates a per-job glob that repeats a default", () => {
    const resolved = resolveProtectedPathGlobs([
      "apps/nextjs/playwright.config.ts",
    ]);
    expect(resolved.length).toBe(DEFAULT_PROTECTED_PATH_GLOBS.length);
  });

  it("drops non-string/blank per-job entries rather than throwing", () => {
    const hostile = [42, null, "  ", "", "a/*.ts"] as unknown as string[];
    const resolved = resolveProtectedPathGlobs(hostile);
    expect(resolved).toContain("a/*.ts");
    expect(resolved.length).toBe(DEFAULT_PROTECTED_PATH_GLOBS.length + 1);
  });

  it("survives a non-array per-job value (never throws)", () => {
    expect(() =>
      resolveProtectedPathGlobs("not-an-array" as unknown as string[]),
    ).not.toThrow();
    expect(resolveProtectedPathGlobs("not-an-array" as unknown as string[])).toEqual(
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
  });
});

describe("detectProtectedPathViolations", () => {
  it("flags an edit inside a protected directory", () => {
    const hits = detectProtectedPathViolations(
      [
        "apps/nextjs/e2e/lib/teams/bright-city.ts",
        "apps/nextjs/src/app/page.tsx",
      ],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual([
      "apps/nextjs/e2e/lib/teams/bright-city.ts",
    ]);
  });

  it("flags a protected single file", () => {
    const hits = detectProtectedPathViolations(
      ["apps/nextjs/playwright.config.ts"],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual(["apps/nextjs/playwright.config.ts"]);
  });

  it("does not flag an unrelated file, including one with a similar name", () => {
    const hits = detectProtectedPathViolations(
      [
        "apps/nextjs/e2e/specs/finance.spec.ts",
        "apps/nextjs/e2e/notes.md",
      ],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual([]);
  });

  it("returns violations in the diff's own order, not the glob's", () => {
    const hits = detectProtectedPathViolations(
      [
        "apps/nextjs/e2e/lib/teams/ridgeline-solo.ts",
        "apps/nextjs/playwright.config.ts",
      ],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual([
      "apps/nextjs/e2e/lib/teams/ridgeline-solo.ts",
      "apps/nextjs/playwright.config.ts",
    ]);
  });

  it("clears on a wholly clean diff", () => {
    expect(
      detectProtectedPathViolations(
        ["apps/nextjs/src/app/page.tsx", "packages/api/src/router/deals.ts"],
        DEFAULT_PROTECTED_PATH_GLOBS,
      ),
    ).toEqual([]);
  });

  it("is total: a non-array changedFiles or empty glob set never throws", () => {
    expect(
      detectProtectedPathViolations(
        "not-an-array" as unknown as string[],
        DEFAULT_PROTECTED_PATH_GLOBS,
      ),
    ).toEqual([]);
    expect(
      detectProtectedPathViolations(["apps/nextjs/playwright.config.ts"], []),
    ).toEqual([]);
  });

  it("proves the instrument before trusting its silence — a case that MUST be caught, is", () => {
    // CLAUDE.md: "prove the instrument before believing its silence". A
    // detector that always returns [] would pass every negative test above
    // for the wrong reason. This positive case is the proof the detector
    // can fire at all.
    const hits = detectProtectedPathViolations(
      ["apps/nextjs/e2e/lib/engine.ts"],
      resolveProtectedPathGlobs(),
    );
    expect(hits.length).toBe(1);
  });

  // issue #914 hardening: the verdict machinery is not just the check
  // file — see DEFAULT_PROTECTED_PATH_GLOBS's own doc comment for why
  // these three, specifically, are safe to blanket-protect.
  it("flags a rewrite of playwright.config.ts", () => {
    const hits = detectProtectedPathViolations(
      ["apps/nextjs/playwright.config.ts"],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual(["apps/nextjs/playwright.config.ts"]);
  });

  // Issue #956: the unit runner has verdict machinery of its own, and it is
  // the exact analogue of playwright.config.ts above. The adversarial pass
  // found it unwatched.
  it("flags a rewrite of the shared vitest config the unit checks' include glob comes from", () => {
    const hits = detectProtectedPathViolations(
      ["tooling/vitest/base.ts", "tooling/vitest/react.ts"],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual(["tooling/vitest/base.ts", "tooling/vitest/react.ts"]);
  });

  it("flags a rewrite of a host package's own vitest config, setup or globalSetup", () => {
    const hits = detectProtectedPathViolations(
      [
        "packages/api/vitest.config.ts",
        "packages/api/vitest.setup.ts",
        "packages/api/vitest.globalSetup.ts",
      ],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual([
      "packages/api/vitest.config.ts",
      "packages/api/vitest.setup.ts",
      "packages/api/vitest.globalSetup.ts",
    ]);
  });

  it("leaves an ordinary package source file alone", () => {
    // The lock must be the runner's own configuration, not the package.
    expect(
      detectProtectedPathViolations(
        ["packages/api/src/services/email/queue.ts"],
        DEFAULT_PROTECTED_PATH_GLOBS,
      ),
    ).toEqual([]);
  });

  it("flags an edit anywhere inside apps/nextjs/e2e/lib/ — the sentinel strings and the sign-in helper", () => {
    const hits = detectProtectedPathViolations(
      [
        "apps/nextjs/e2e/lib/graded-screen-check.ts",
        "apps/nextjs/e2e/lib/sign-in.ts",
      ],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual([
      "apps/nextjs/e2e/lib/graded-screen-check.ts",
      "apps/nextjs/e2e/lib/sign-in.ts",
    ]);
  });

  it("flags an edit to the pure claim-match comparison logic", () => {
    const hits = detectProtectedPathViolations(
      ["apps/nextjs/src/lib/screen-check/claim-match.ts"],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual(["apps/nextjs/src/lib/screen-check/claim-match.ts"]);
  });

  // 2026-08-04 review finding #3 (BLOCKER): global-setup.ts is wired into
  // playwright.config.ts's `globalSetup` and runs on EVERY check-writer-run
  // check — it imports `db` and calls `db.delete(accounts)` directly. It sat
  // outside `apps/nextjs/e2e/lib/**`, unprotected, until this fix.
  it("flags an edit to global-setup.ts — the file wired into globalSetup that can write to the database on every check", () => {
    const hits = detectProtectedPathViolations(
      ["apps/nextjs/e2e/global-setup.ts"],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual(["apps/nextjs/e2e/global-setup.ts"]);
  });

  // 2026-08-04 review finding #4 (BLOCKER): the comparison side
  // (screen-check/**) was locked, but the APP-SIDE producer of the claim it
  // compares against was not — a component always reporting "settled,
  // matching" makes two of the harness's six verdicts unreachable, for
  // every ticket, forever.
  it("flags an edit to the app-readiness producer components — readiness-marker.tsx and section-claim-publisher.tsx", () => {
    const hits = detectProtectedPathViolations(
      [
        "apps/nextjs/src/components/app-readiness/readiness-marker.tsx",
        "apps/nextjs/src/components/app-readiness/section-claim-publisher.tsx",
      ],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual([
      "apps/nextjs/src/components/app-readiness/readiness-marker.tsx",
      "apps/nextjs/src/components/app-readiness/section-claim-publisher.tsx",
    ]);
  });

  it("does NOT flag apps/nextjs/package.json by path — see e2e-script-guard.ts for its field-level guard instead", () => {
    const hits = detectProtectedPathViolations(
      ["apps/nextjs/package.json"],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual([]);
  });

  it("does NOT flag an unrelated e2e check spec sitting outside apps/nextjs/e2e/lib/", () => {
    const hits = detectProtectedPathViolations(
      ["apps/nextjs/e2e/checks/issue-123/some-check.spec.ts"],
      DEFAULT_PROTECTED_PATH_GLOBS,
    );
    expect(hits).toEqual([]);
  });
});
