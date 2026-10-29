/**
 * Tests for `resolveTestScope` / `matchPathToPackageDir` /
 * `parseWorkspacePackageGlobs` / `manifestHasTestScript` (`./workspace-packages.ts`).
 * Co-located per this package's convention — see `../paths/glob.test.ts`,
 * `../cost/ledger.test.ts`, `../telemetry/run-identity.test.ts`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverWorkspacePackages,
  manifestHasTestScript,
  matchPathToPackageDir,
  parseWorkspacePackageGlobs,
  resolveTestScope,
} from "./workspace-packages.js";

// ---------------------------------------------------------------------------
// resolveTestScope / matchPathToPackageDir / parseWorkspacePackageGlobs —
// against a REAL temp repo (mkdtempSync), same style as
// `branchHasCommitsAheadOfBase` in `../../main.test.mts`. The rule under test
// is: two "nothing to run" cases that look identical from `packages` alone
// must be distinguishable via `workspaceDiscovered`, because one means "the
// gate couldn't verify anything" (inconclusive) and the other means "this
// diff genuinely touched nothing testable" (dormant) — collapsing them is
// exactly how a gate silently switches itself off.
// ---------------------------------------------------------------------------

describe("resolveTestScope / matchPathToPackageDir / parseWorkspacePackageGlobs", () => {
  let root: string;

  /** Write a minimal workspace package: package.json (+ optional test script). */
  function writePackage(
    dir: string,
    name: string,
    opts: { hasTest?: boolean } = {},
  ): void {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(
      path.join(root, dir, "package.json"),
      JSON.stringify({
        name,
        scripts: opts.hasTest === false ? {} : { test: "vitest run" },
      }),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "sc-test-scope-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("parseWorkspacePackageGlobs extracts the packages: block-sequence", () => {
    expect(
      parseWorkspacePackageGlobs(
        "packages:\n  - apps/*\n  - packages/*\ncatalog:\n  foo: 1\n",
      ),
    ).toEqual(["apps/*", "packages/*"]);
  });

  it("a path inside a package resolves to it", () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writePackage("packages/ui", "@acme/ui");
    const scope = resolveTestScope(root, ["packages/ui/src/Button.tsx"]);
    expect(scope.packages.map((p) => p.name)).toEqual(["@acme/ui"]);
    expect(scope.unresolved).toEqual([]);
  });

  it("a path outside every package lands in unresolved", () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writePackage("packages/ui", "@acme/ui");
    const scope = resolveTestScope(root, ["docs/README.md"]);
    expect(scope.unresolved).toEqual(["docs/README.md"]);
    expect(scope.packages).toEqual([]);
  });

  it("a package with no test script lands in skipped, not packages", () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writePackage("packages/notest", "@acme/notest", { hasTest: false });
    const scope = resolveTestScope(root, ["packages/notest/index.ts"]);
    expect(scope.packages).toEqual([]);
    expect(scope.skipped).toEqual(["packages/notest"]);
  });

  it("segment-boundary rule: packages/ui must NOT claim packages/ui-kit/x.ts", () => {
    const dirs = ["packages/ui", "packages/ui-kit"];
    expect(matchPathToPackageDir("packages/ui-kit/x.ts", dirs)).toBe(
      "packages/ui-kit",
    );
    expect(matchPathToPackageDir("packages/ui/x.ts", dirs)).toBe(
      "packages/ui",
    );
  });

  it("nested packages resolve to the innermost (longest prefix)", () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/**\n",
    );
    writePackage("packages/outer", "@acme/outer");
    writePackage("packages/outer/inner", "@acme/inner");
    const scope = resolveTestScope(root, [
      "packages/outer/inner/src/x.ts",
    ]);
    expect(scope.packages.map((p) => p.name)).toEqual(["@acme/inner"]);
  });

  it("a binary path and a path with no extension resolve exactly like any other path", () => {
    // Upstream `reviewDiffStats` calls `git diff` with `--no-renames -z`, so
    // every changed path this function receives is always a single plain
    // path — there is no `{old => new}` rename shape to special-case here,
    // and a binary file or an extensionless path (e.g. a Dockerfile) is
    // resolved by directory prefix alone, same as any text file.
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writePackage("packages/ui", "@acme/ui");
    const scope = resolveTestScope(root, [
      "packages/ui/assets/logo.png",
      "packages/ui/Dockerfile",
    ]);
    expect(scope.packages.map((p) => p.name)).toEqual(["@acme/ui"]);
  });

  // A path that merely LOOKS like a git rename arrow (`{old => new}`) is not
  // a shape this function needs to handle specially: as the module's own doc
  // comment on `resolveTestScope` says, upstream `reviewDiffStats` always
  // calls `git diff` with `--no-renames -z`, so a real rename pair can never
  // arrive here as one path with `=>` in it. This test pins that assumption —
  // if such a path DID arrive, it is resolved as one ordinary opaque
  // path-string (it fails to match any package dir prefix and lands in
  // `unresolved`), not treated as a rename with an old/new half to split.
  it("a path that merely looks like a git rename is treated as an ordinary opaque path", () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writePackage("packages/old", "@acme/old");
    writePackage("packages/new", "@acme/new");
    const scope = resolveTestScope(root, [
      "packages/{old => new}/x.ts",
    ]);
    expect(scope.packages).toEqual([]);
    expect(scope.unresolved).toEqual(["packages/{old => new}/x.ts"]);
  });

  it("duplicate changed paths collapse to one package entry", () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writePackage("packages/ui", "@acme/ui");
    const scope = resolveTestScope(root, [
      "packages/ui/a.ts",
      "packages/ui/b.ts",
      "packages/ui/a.ts",
    ]);
    expect(scope.packages.map((p) => p.name)).toEqual(["@acme/ui"]);
  });

  it("workspaceDiscovered is 0 when pnpm-workspace.yaml is missing (inconclusive case)", () => {
    // No pnpm-workspace.yaml written at all.
    const scope = resolveTestScope(root, ["packages/ui/a.ts"]);
    expect(scope.workspaceDiscovered).toBe(0);
    expect(scope.packages).toEqual([]);
  });

  it("workspaceDiscovered is non-zero when packages exist but none match the diff (dormant case)", () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writePackage("packages/ui", "@acme/ui");
    const scope = resolveTestScope(root, ["docs/README.md"]);
    expect(scope.workspaceDiscovered).toBeGreaterThan(0);
    expect(scope.packages).toEqual([]);
    // The two "nothing to run" cases are distinguishable ONLY via this field
    // — `packages` alone is empty in both, and the gate above (`verifyTestRun`
    // in main.mts) uses this exact distinction to choose "inconclusive" vs
    // "dormant".
    expect(scope.workspaceDiscovered).not.toBe(0);
  });

  it("discoverWorkspacePackages is what workspaceDiscovered counts", () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    writePackage("packages/ui", "@acme/ui");
    writePackage("packages/api", "@acme/api");
    expect(discoverWorkspacePackages(root)).toHaveLength(2);
    expect(resolveTestScope(root, []).workspaceDiscovered).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// manifestHasTestScript — the single predicate shared by `hasTestScript` in
// `../../main.mts` (the cert gate) and `discoverWorkspacePackages` above (the
// verification gate). One definition means the two gates can never disagree
// about what "this package is testable" means.
// ---------------------------------------------------------------------------

describe("manifestHasTestScript", () => {
  it("a non-empty string test script -> true", () => {
    expect(manifestHasTestScript({ scripts: { test: "vitest run" } })).toBe(
      true,
    );
  });

  it("a missing scripts object -> false", () => {
    expect(manifestHasTestScript({})).toBe(false);
  });

  it("an empty test script -> false", () => {
    expect(manifestHasTestScript({ scripts: { test: "" } })).toBe(false);
  });

  it("a whitespace-only test script -> false", () => {
    expect(manifestHasTestScript({ scripts: { test: "   " } })).toBe(false);
  });

  it("a non-string test script value -> false", () => {
    expect(manifestHasTestScript({ scripts: { test: 1 } })).toBe(false);
  });
});
