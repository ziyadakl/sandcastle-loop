import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { defaultProjectConfig, resetProjectConfig, setProjectConfig } from "../project-config.js";
import type { CheckLocation } from "../checkwriter/must-fail-first-receipt.js";
import {
  assertCheckFreezeLayout,
  CheckFreezeLayoutError,
  checkFreezeDerivation,
  checkFreezeInstrumentRoots,
  checkFreezeSeedsFor,
  checkFreezePathsFor,
  freezeCheck,
  freezeRepairedCheckDir,
  isCheckInstrumentPath,
  withRepairedCheckDir,
  frozenCheckDrift,
  frozenTsconfigSeedsFor,
  restoreFrozenCheck,
  restoreFrozenCheckPaths,
  unitPackageDirOf,
} from "./check-freeze.js";

const BROWSER: CheckLocation = {
  kind: "browser",
  issueNumber: 1118,
  checkDir: "apps/nextjs/e2e/checks/issue-1118",
  checkDirGlob: "apps/nextjs/e2e/checks/issue-1118/**",
  checkPath: "team-total.spec.ts",
};

const UNIT: CheckLocation = {
  kind: "unit",
  issueNumber: 1118,
  checkDir: "packages/api/src/__checks__/issue-1118",
  checkDirGlob: "packages/api/src/__checks__/issue-1118/**",
  checkPath: "email-registry.test.ts",
};

let root: string;
const write = (rel: string, body: string): void => {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sandcastle-check-freeze-"));
  // Seed the instrument-root DIRECTORIES that writing a check file does not
  // create incidentally, so `assertCheckFreezeLayout` sees an intact default
  // layout (issue #1135, LOW 6 made a partial-rename throw). `apps/nextjs/e2e`
  // and any unit check dir come from `write(...)`; these two do not. They are
  // empty markers — the freeze derives its files from imports and seeds, so an
  // empty root adds nothing to a freeze.
  mkdirSync(path.join(root, "apps/nextjs/src/lib/screen-check"), { recursive: true });
  mkdirSync(path.join(root, "tooling/vitest"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A small, self-contained repository with the same shape a real monorepo has
 * (a browser runner under `apps/nextjs/e2e`, a grading library, a shared vitest
 * config, one unit package), built fresh for the run. The tests derive against
 * THIS tree, so they depend on nothing outside the loop's own folder.
 */
let REPO_ROOT: string;
const MINI_REPO_FILES: Record<string, string> = {
  "apps/nextjs/playwright.config.ts": `export default {};\n`,
  "apps/nextjs/e2e/tsconfig.json": `{}\n`,
  "apps/nextjs/e2e/checks/tsconfig.json": `{}\n`,
  "apps/nextjs/e2e/global-setup.ts": `export default async () => {};\n`,
  "apps/nextjs/e2e/lib/graded-screen-check.ts":
    `import "../../src/lib/screen-check/graded-text";\n` +
    `import "../../src/lib/screen-check/claim-match";\n` +
    `export const graded = 1;\n`,
  "apps/nextjs/src/lib/screen-check/graded-text.ts": `export const gradeText = 1;\n`,
  "apps/nextjs/src/lib/screen-check/claim-match.ts": `export const claimMatch = 1;\n`,
  "apps/nextjs/src/lib/screen-check/counted-screen.ts": `export const counted = 1;\n`,
  "apps/nextjs/e2e/checks/issue-539/listing-address-duplicate-guard.spec.ts":
    `import "../../lib/graded-screen-check";\n` +
    `import "../../../src/lib/screen-check/counted-screen";\n`,
  "apps/nextjs/e2e/checks/issue-540/a.spec.ts": `import "../../lib/graded-screen-check";\n`,
  "apps/nextjs/e2e/checks/issue-541/b.spec.ts": `import "../../lib/graded-screen-check";\n`,
  "packages/api/vitest.config.ts": `export default {};\n`,
  "packages/api/vitest.globalSetup.ts": `export default async () => {};\n`,
  "packages/api/vitest.setup.ts": `export {};\n`,
  "packages/api/tsconfig.json": `{}\n`,
  "packages/api/package.json": `{"name":"@acme/api"}\n`,
  "tooling/vitest/base.ts": `export default {};\n`,
  "tooling/vitest/react.ts": `export default {};\n`,
  "tooling/vitest/package.json": `{}\n`,
  "tooling/vitest/tsconfig.json": `{}\n`,
  "pnpm-lock.yaml": `lockfileVersion: 9\n`,
};
beforeAll(() => {
  REPO_ROOT = mkdtempSync(path.join(tmpdir(), "sandcastle-check-freeze-repo-"));
  for (const [rel, body] of Object.entries(MINI_REPO_FILES)) {
    mkdirSync(path.dirname(path.join(REPO_ROOT, rel)), { recursive: true });
    writeFileSync(path.join(REPO_ROOT, rel), body);
  }
});
afterAll(() => {
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

/** A check that really reaches the shared browser helper, so the derivation
 *  puts it in the frozen set. */
const IMPORTS_HELPER = `import "../../lib/graded-screen-check";\n`;

/** A browser check in the mini repository. `issue-539` imports the shared
 *  helpers AND `counted-screen.ts` directly, so it exercises both hops. */
const REAL_539: CheckLocation = {
  kind: "browser",
  issueNumber: 539,
  checkDir: "apps/nextjs/e2e/checks/issue-539",
  checkDirGlob: "apps/nextjs/e2e/checks/issue-539/**",
  checkPath: "listing-address-duplicate-guard.spec.ts",
};

describe("what the freeze covers, DERIVED from what a check imports", () => {
  it("covers the RUNNER'S CONFIG, not only the check file", () => {
    // SWE-bench's reset reverts only the files its own test patch names, so an
    // agent that cannot edit the spec can still edit what RUNS the spec. That
    // is the same hole one step further out, and the seeds close it here —
    // nothing imports a runner config, so nothing can derive it.
    const paths = checkFreezePathsFor(REPO_ROOT, BROWSER);
    expect(paths).toContain("apps/nextjs/playwright.config.ts");
    expect(paths).toContain("apps/nextjs/e2e/global-setup.ts");
  });

  it("covers the GRADING LIBRARY the check's imports actually reach", () => {
    // THE FAULT THIS TEST EXISTS FOR. The hand-written list froze
    // `graded-screen-check.ts` and called it "where the grading itself lives".
    // It is a Playwright wrapper: it imports its verdict from `graded-text.ts`
    // and `claim-match.ts`, neither of which was frozen and neither of which
    // was named anywhere. One line in `gradeText` returning a match makes EVERY
    // graded check in the repository pass with the check's own bytes untouched.
    const paths = checkFreezePathsFor(REPO_ROOT, REAL_539);
    expect(paths).toContain("apps/nextjs/e2e/lib/graded-screen-check.ts");
    expect(paths).toContain("apps/nextjs/src/lib/screen-check/graded-text.ts");
    expect(paths).toContain("apps/nextjs/src/lib/screen-check/claim-match.ts");
    // Imported straight by this check rather than through the wrapper.
    expect(paths).toContain("apps/nextjs/src/lib/screen-check/counted-screen.ts");
  });

  it("freezes every grading-library file EVERY real check in the repo reaches", () => {
    // The durable half. A rename, a new helper, or a decision moved one file
    // further out changes what the walk reaches, and this re-derives it from
    // the real tree on every run rather than from anybody's memory.
    const checksDir = path.join(REPO_ROOT, "apps/nextjs/e2e/checks");
    const dirs = readdirSync(checksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("issue-"))
      .map((e) => e.name);
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const dir of dirs) {
      const location: CheckLocation = {
        kind: "browser",
        issueNumber: 0,
        checkDir: `apps/nextjs/e2e/checks/${dir}`,
        checkDirGlob: `apps/nextjs/e2e/checks/${dir}/**`,
        checkPath: "unused.spec.ts",
      };
      const derived = checkFreezeDerivation(REPO_ROOT, location);
      // Nothing the walk reached inside the instrument may be left unfrozen…
      for (const rel of derived.exposed) {
        expect(isCheckInstrumentPath(location, rel)).toBe(false);
      }
      // …and every graded check reaches the grading library, so if a check
      // reaches `apps/nextjs/src/lib/screen-check` at all it is frozen.
      const grading = derived.frozen.filter((f) =>
        f.startsWith("apps/nextjs/src/lib/screen-check/"),
      );
      expect(grading.length).toBeGreaterThan(0);
    }
  });

  it("names the product code it does NOT freeze rather than dropping it", () => {
    // The boundary is the point: freezing the SUBJECT would write the builder's
    // own work back before every graded run and leave the break test nothing
    // left to break. So it is reported, not silently discarded.
    //
    // THIS TEST USED TO ASSERT `exposed.length > 0` AGAINST THE REAL TREE, and
    // it passed on a DEFECT. Zero product files are exposed for any real check
    // in this repository — every one of them reaches the product through bare
    // workspace specifiers, which are never resolved. The single member of that
    // list was `apps/nextjs/playwright.config.ts`: a SEED, simultaneously in
    // the frozen set, reported as outside only because seeds were put through
    // the region test and so were never walked. Fixing that emptied the list
    // and this assertion went red — which is what it should have been saying
    // all along. It is a fixture now, and it measures the boundary rather than
    // the tree's current shape.
    write("apps/nextjs/playwright.config.ts", `export default {};\n`);
    write("apps/nextjs/e2e/global-setup.ts", `export default async () => {};\n`);
    write(
      "apps/nextjs/e2e/lib/graded-screen-check.ts",
      `import "../../src/lib/screen-check/graded-text";\n`,
    );
    write(
      "apps/nextjs/src/lib/screen-check/graded-text.ts",
      `export const gradeText = 1;\n`,
    );
    // The SUBJECT: real product code this check reads directly. Outside the
    // instrument region, so it must be reported and must NOT be frozen.
    write(
      "apps/nextjs/src/app/team-total.tsx",
      `export const TeamTotal = 1;\n`,
    );
    write(
      `${REAL_539.checkDir}/${REAL_539.checkPath}`,
      `import "../../lib/graded-screen-check";\n` +
        `import "../../../src/app/team-total";\n` +
        `import "@playwright/test";\n`,
    );
    const derived = checkFreezeDerivation(root, REAL_539);
    expect(derived.exposed).toContain("apps/nextjs/src/app/team-total.tsx");
    expect(derived.frozen).not.toContain("apps/nextjs/src/app/team-total.tsx");
    for (const rel of derived.exposed) {
      expect(isCheckInstrumentPath(REAL_539, rel)).toBe(false);
    }
    // …and the instrument it reached through is frozen, so the exposure is a
    // boundary rather than a hole.
    expect(derived.frozen).toContain(
      "apps/nextjs/src/lib/screen-check/graded-text.ts",
    );
    // Packages and workspace imports are reached and never frozen.
    expect(derived.bare).toContain("@playwright/test");
    for (const spec of derived.bare) expect(spec.startsWith(".")).toBe(false);
  });

  it("WALKS a seed's own imports — a seed is never merely listed", () => {
    // THE FAULT. `apps/nextjs/playwright.config.ts` matches neither browser
    // prefix in `isCheckInstrumentPath`, so the walk classified it OUTSIDE and
    // never queued it, while the derivation froze it regardless because it is a
    // seed. A file frozen but not followed is the stale hand-written list this
    // module exists to end, reintroduced at the seed boundary: today the config
    // names only `"./e2e"`, but a custom reporter added beside it would have
    // been silently unfrozen.
    write(
      "apps/nextjs/playwright.config.ts",
      `import "./e2e/lib/custom-reporter";\nexport default {};\n`,
    );
    write(
      "apps/nextjs/e2e/lib/custom-reporter.ts",
      `export const reporter = 1;\n`,
    );
    write("apps/nextjs/e2e/global-setup.ts", `export default async () => {};\n`);
    write(`${REAL_539.checkDir}/${REAL_539.checkPath}`, IMPORTS_HELPER);
    write(
      "apps/nextjs/e2e/lib/graded-screen-check.ts",
      `export const graded = 1;\n`,
    );
    const derived = checkFreezeDerivation(root, REAL_539);
    expect(derived.frozen).toContain("apps/nextjs/playwright.config.ts");
    expect(derived.frozen).toContain("apps/nextjs/e2e/lib/custom-reporter.ts");
    // …and it is not sitting in the exposed list at the same time.
    expect(derived.exposed).not.toContain("apps/nextjs/playwright.config.ts");
  });

  it("leaves NOTHING exposed-and-frozen at once for a real check", () => {
    // A path in both lists is a contradiction: `exposed` means "reported and
    // deliberately not restored", `frozen` means "restored before every graded
    // run". One file was in both, and that is how the seed fault stayed
    // invisible. Asserted over every real check directory in the repository.
    const checksDir = path.join(REPO_ROOT, "apps/nextjs/e2e/checks");
    const dirs = readdirSync(checksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("issue-"))
      .map((e) => e.name);
    expect(dirs.length).toBeGreaterThanOrEqual(3);
    for (const dir of dirs) {
      const location: CheckLocation = {
        kind: "browser",
        issueNumber: 0,
        checkDir: `apps/nextjs/e2e/checks/${dir}`,
        checkDirGlob: `apps/nextjs/e2e/checks/${dir}/**`,
        checkPath: "unused.spec.ts",
      };
      const derived = checkFreezeDerivation(REPO_ROOT, location);
      const frozen = new Set(derived.frozen);
      for (const rel of derived.exposed) expect(frozen.has(rel)).toBe(false);
    }
  });

  it("covers the vitest base config and the host package's setup pair", () => {
    const paths = checkFreezePathsFor(REPO_ROOT, UNIT);
    // `base.ts` sets the `include` glob a check has to match to run at all.
    expect(paths).toContain("tooling/vitest/base.ts");
    expect(paths).toContain("packages/api/vitest.config.ts");
    expect(paths).toContain("packages/api/vitest.globalSetup.ts");
    expect(paths).toContain("packages/api/vitest.setup.ts");
  });

  it("lists a seed that is ABSENT, so a restore deletes a setup file the builder ADDED", () => {
    // Derived paths have to exist to be reached. Seeds do not: recording the
    // absence is what makes the restore delete an added setup file.
    const paths = checkFreezePathsFor(root, BROWSER);
    expect(paths).toContain("apps/nextjs/e2e/global-setup.ts");
  });

  it("reads the host package back out of the unit check's directory", () => {
    expect(unitPackageDirOf(UNIT)).toBe("packages/api");
    expect(unitPackageDirOf(BROWSER)).toBeUndefined();
    // A shape that does not hold gives up rather than guessing — a narrower
    // freeze, never a freeze that writes somewhere else.
    expect(
      unitPackageDirOf({ ...UNIT, checkDir: "packages/api/checks/issue-1" }),
    ).toBeUndefined();
  });

  it("does NOT cover a package manifest — reverting one would break the run", () => {
    // The builder legitimately changes those. `lib/judge/replay-hazard.ts`
    // refuses the repair outright instead.
    expect(checkFreezePathsFor(REPO_ROOT, UNIT)).not.toContain(
      "packages/api/package.json",
    );
    expect(checkFreezePathsFor(REPO_ROOT, UNIT)).not.toContain("pnpm-lock.yaml");
  });
});

describe("frozenTsconfigSeedsFor — the value-guarded tsconfigs (issue #1135)", () => {
  it("names both browser e2e tsconfigs and nothing else for a browser check", () => {
    expect([...frozenTsconfigSeedsFor(BROWSER)].sort()).toEqual([
      "apps/nextjs/e2e/checks/tsconfig.json",
      "apps/nextjs/e2e/tsconfig.json",
    ]);
  });

  it("names the host package tsconfig (and shared vitest tsconfig) for a unit check", () => {
    const seeds = frozenTsconfigSeedsFor(UNIT);
    expect(seeds).toContain("packages/api/tsconfig.json");
    expect(seeds).toContain("tooling/vitest/tsconfig.json");
  });

  it("returns only `tsconfig.json` seeds — never a `.ts` config or a manifest", () => {
    for (const location of [BROWSER, UNIT]) {
      for (const seed of frozenTsconfigSeedsFor(location)) {
        expect(seed.endsWith("/tsconfig.json")).toBe(true);
      }
    }
    // playwright.config.ts / vitest.config.ts / package.json are seeds but not
    // tsconfigs, so they must not leak into the value-guarded set.
    expect(frozenTsconfigSeedsFor(BROWSER)).not.toContain(
      "apps/nextjs/playwright.config.ts",
    );
    expect(frozenTsconfigSeedsFor(UNIT)).not.toContain(
      "tooling/vitest/package.json",
    );
  });
});

describe("failing LOUD when the hard-coded instrument layout moves", () => {
  /** The same browser check, but living under a RENAMED app tree (`apps/web`)
   *  while the module still hard-codes `apps/nextjs`. This is the reviewer's
   *  scenario: the instrument dirs the freeze reverts by path no longer resolve,
   *  so the frozen set silently empties and the grade-tamper protection reopens
   *  with nobody warned. */
  const MOVED: CheckLocation = {
    kind: "browser",
    issueNumber: 1118,
    checkDir: "apps/web/e2e/checks/issue-1118",
    checkDirGlob: "apps/web/e2e/checks/issue-1118/**",
    checkPath: "team-total.spec.ts",
  };

  it("freezeCheck THROWS instead of returning a silently-empty freeze", () => {
    write(`${MOVED.checkDir}/${MOVED.checkPath}`, "the original\n");
    // Without the guard this returns a FrozenCheck whose environment is all
    // absent paths — a restore that reverts nothing. That is the dangerous
    // outcome, and a throw (which the loop quarantines) is the safe one.
    expect(() => freezeCheck(root, MOVED)).toThrow(CheckFreezeLayoutError);
  });

  it("the guard names the likely cause — a rename or restructure", () => {
    expect(() => assertCheckFreezeLayout(root, MOVED)).toThrow(
      /rename or restructure/i,
    );
  });

  it("does NOT throw for the real repo layout, browser or unit", () => {
    expect(() => assertCheckFreezeLayout(REPO_ROOT, BROWSER)).not.toThrow();
    expect(() => assertCheckFreezeLayout(REPO_ROOT, UNIT)).not.toThrow();
  });

  it("distinguishes ONE optional absent seed from a moved layout", () => {
    // The layout is intact (the check lives under `apps/nextjs/e2e`, and the
    // `screen-check` root is seeded), but the OPTIONAL `global-setup.ts` seed is
    // not written. That is legitimate — the freeze records the absence — so it
    // must NOT throw.
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    expect(() => freezeCheck(root, BROWSER)).not.toThrow();
    expect(() => assertCheckFreezeLayout(root, BROWSER)).not.toThrow();
  });

  it("THROWS on a PARTIAL rename — only screen-check moved, e2e left in place (issue #1135)", () => {
    // The blind spot the two-file edit boundary could not close. The check tree
    // (`apps/nextjs/e2e`) is intact, but the grading-DECISION tree
    // (`apps/nextjs/src/lib/screen-check`, where `graded-text.ts` / `claim-match.ts`
    // live — one line there makes every graded check pass) has been moved. The
    // old `.every` guard saw one root still resolving and stayed silent; the
    // freeze would then drop the grading library and reopen the tamper hole.
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    rmSync(path.join(root, "apps/nextjs/src/lib/screen-check"), {
      recursive: true,
      force: true,
    });
    expect(() => assertCheckFreezeLayout(root, BROWSER)).toThrow(
      CheckFreezeLayoutError,
    );
    // And the message names the specific root that moved, not a generic layout
    // complaint — so whoever quarantines the ticket knows where to look.
    expect(() => assertCheckFreezeLayout(root, BROWSER)).toThrow(
      /apps\/nextjs\/src\/lib\/screen-check/,
    );
    // freezeCheck inherits the throw rather than returning a narrowed freeze.
    expect(() => freezeCheck(root, BROWSER)).toThrow(CheckFreezeLayoutError);
  });

  it("exposes the instrument roots that back both the walk and the guard", () => {
    expect(checkFreezeInstrumentRoots(BROWSER)).toEqual([
      "apps/nextjs/e2e",
      "apps/nextjs/src/lib/screen-check",
    ]);
    expect(checkFreezeInstrumentRoots(UNIT)).toEqual(["tooling/vitest"]);
    // The roots are the same prefixes the region test classifies as instrument.
    for (const root of checkFreezeInstrumentRoots(BROWSER)) {
      expect(isCheckInstrumentPath(BROWSER, `${root}/x.ts`)).toBe(true);
    }
  });
});

describe("the freeze layout follows the project settings", () => {
  it("with no settings: derives the browser runner from the default checksRoot, and has no project-specific unit/grading roots", () => {
    resetProjectConfig();
    const browser: CheckLocation = {
      kind: "browser",
      issueNumber: 1,
      checkDir: "e2e/checks/issue-1",
      checkDirGlob: "e2e/checks/issue-1/**",
      checkPath: "a.spec.ts",
    };
    expect(checkFreezeSeedsFor(browser)).toEqual([
      "playwright.config.ts",
      "e2e/tsconfig.json",
      "e2e/checks/tsconfig.json",
      "e2e/global-setup.ts",
    ]);
    expect(checkFreezeInstrumentRoots(browser)).toEqual(["e2e"]);
    expect(checkFreezeInstrumentRoots(UNIT)).toEqual([]);
    expect(checkFreezeSeedsFor(UNIT).some((p) => p.startsWith("tooling/"))).toBe(false);
  });

  it("follows a nested checksRoot", () => {
    setProjectConfig({ ...defaultProjectConfig(), checksRoot: "apps/web/e2e/checks" });
    const seeds = checkFreezeSeedsFor({ ...BROWSER });
    expect(seeds).toContain("apps/web/playwright.config.ts");
    expect(seeds).toContain("apps/web/e2e/global-setup.ts");
  });
});

describe("taking the freeze", () => {
  it("returns undefined when there is no check directory to read", () => {
    // ADDITIVE: every caller reads this as "there is no freeze" and behaves
    // exactly as it did before freezing existed.
    expect(freezeCheck(root, BROWSER)).toBeUndefined();
  });

  it("captures the check's exact bytes and fingerprints them", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    write("apps/nextjs/playwright.config.ts", "config v1\n");
    const frozen = freezeCheck(root, BROWSER);
    expect(frozen).toBeDefined();
    expect(
      frozen?.checkDir.bytesByRelPath.get(BROWSER.checkPath)?.toString("utf8"),
    ).toBe("the original\n");
    expect(frozen?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives a DIFFERENT fingerprint when one byte of the config differs", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    write("apps/nextjs/playwright.config.ts", "config v1\n");
    const a = freezeCheck(root, BROWSER);
    write("apps/nextjs/playwright.config.ts", "config v2\n");
    const b = freezeCheck(root, BROWSER);
    expect(a?.fingerprint).not.toBe(b?.fingerprint);
  });
});

describe("the cheat detector", () => {
  it("sees nothing when the tree still holds the accepted check", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    const frozen = freezeCheck(root, BROWSER);
    expect(frozenCheckDrift(root, frozen!)).toEqual([]);
  });

  it("names the check file when its bytes changed", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    const frozen = freezeCheck(root, BROWSER);
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "weakened\n");
    expect(frozenCheckDrift(root, frozen!)).toEqual([
      `${BROWSER.checkDir}/${BROWSER.checkPath}`,
    ]);
  });

  it("names a SETUP file that changed — the seam nothing else watches", () => {
    // Frozen BECAUSE the check imports it. The derivation is what puts it in
    // the set, so the fixture has to write a check that really reaches it.
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, IMPORTS_HELPER);
    write("apps/nextjs/e2e/lib/graded-screen-check.ts", "export const g = 1;\n");
    const frozen = freezeCheck(root, BROWSER);
    write("apps/nextjs/e2e/lib/graded-screen-check.ts", "export const g = 2;\n");
    expect(frozenCheckDrift(root, frozen!)).toEqual([
      "apps/nextjs/e2e/lib/graded-screen-check.ts",
    ]);
  });

  it("names a setup file that was ADDED after the freeze", () => {
    // A setup file the builder ADDS is a setup file it can use.
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    const frozen = freezeCheck(root, BROWSER);
    write("apps/nextjs/playwright.config.ts", "config the builder wrote\n");
    expect(frozenCheckDrift(root, frozen!)).toContain(
      "apps/nextjs/playwright.config.ts",
    );
  });

  it("names an EXTRA file dropped into the check directory", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    const frozen = freezeCheck(root, BROWSER);
    write(`${BROWSER.checkDir}/extra.spec.ts`, "a second check\n");
    expect(frozenCheckDrift(root, frozen!)).toContain(
      `${BROWSER.checkDir}/extra.spec.ts`,
    );
  });

  it("names the check file when it was DELETED", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    const frozen = freezeCheck(root, BROWSER);
    rmSync(path.join(root, BROWSER.checkDir), { recursive: true, force: true });
    expect(frozenCheckDrift(root, frozen!).length).toBeGreaterThan(0);
  });
});

describe("restoring the freeze", () => {
  it("puts the accepted check back over an in-place edit, and PROVES it", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    const frozen = freezeCheck(root, BROWSER);
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "weakened\n");

    const restored = restoreFrozenCheck(root, frozen!);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("unreachable");
    // It REPORTS what it had to undo, which is the record a person needs.
    expect(restored.restored).toContain(
      `${BROWSER.checkDir}/${BROWSER.checkPath}`,
    );
    expect(
      readFileSync(
        path.join(root, BROWSER.checkDir, BROWSER.checkPath),
        "utf8",
      ),
    ).toBe("the original\n");
    expect(frozenCheckDrift(root, frozen!)).toEqual([]);
  });

  it("puts a changed SETUP file back", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, IMPORTS_HELPER);
    write("apps/nextjs/e2e/lib/graded-screen-check.ts", "export const g = 1;\n");
    const frozen = freezeCheck(root, BROWSER);
    write("apps/nextjs/e2e/lib/graded-screen-check.ts", "export const g = 2;\n");

    expect(restoreFrozenCheck(root, frozen!).ok).toBe(true);
    expect(
      readFileSync(
        path.join(root, "apps/nextjs/e2e/lib/graded-screen-check.ts"),
        "utf8",
      ),
    ).toBe("export const g = 1;\n");
  });

  it("DELETES a setup file that did not exist when the freeze was taken", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    const frozen = freezeCheck(root, BROWSER);
    write("apps/nextjs/playwright.config.ts", "config the builder wrote\n");

    expect(restoreFrozenCheck(root, frozen!).ok).toBe(true);
    expect(frozenCheckDrift(root, frozen!)).toEqual([]);
  });

  it("REMOVES an extra file dropped into the check directory", () => {
    // Wholesale, not a merge: leaving a second check beside the accepted one
    // would run BOTH at ship time.
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    const frozen = freezeCheck(root, BROWSER);
    write(`${BROWSER.checkDir}/extra.spec.ts`, "a second check\n");

    expect(restoreFrozenCheck(root, frozen!).ok).toBe(true);
    expect(frozenCheckDrift(root, frozen!)).toEqual([]);
  });
});

describe("restoreFrozenCheckPaths — the tamper restore reads the FREEZE (spec #1334)", () => {
  // Once the first test has been rewritten, the commit the builder was handed
  // still holds the OLD test. A tamper restore that read that commit would
  // silently put the wrong test back; this one reads the accepted copy.
  it("writes the FROZEN bytes back over an edited file, not anything older", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the rewritten, accepted test\n");
    const frozen = freezeCheck(root, BROWSER)!;
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "a builder's edit\n");

    const out = restoreFrozenCheckPaths(root, frozen, [
      `${BROWSER.checkDir}/${BROWSER.checkPath}`,
    ]);
    expect(out).toEqual([
      { path: `${BROWSER.checkDir}/${BROWSER.checkPath}`, existedAtBase: true, restored: true },
    ]);
    expect(readFileSync(path.join(root, BROWSER.checkDir, BROWSER.checkPath), "utf8")).toBe(
      "the rewritten, accepted test\n",
    );
  });

  it("deletes a file the freeze never held", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "accepted\n");
    const frozen = freezeCheck(root, BROWSER)!;
    write(`${BROWSER.checkDir}/smuggled.spec.ts`, "a second check\n");

    const out = restoreFrozenCheckPaths(root, frozen, [`${BROWSER.checkDir}/smuggled.spec.ts`]);
    expect(out).toEqual([
      { path: `${BROWSER.checkDir}/smuggled.spec.ts`, existedAtBase: false, restored: true },
    ]);
    expect(readdirSync(path.join(root, BROWSER.checkDir))).toEqual([BROWSER.checkPath]);
  });

  it("touches only the paths it is handed", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "accepted\n");
    write(`${BROWSER.checkDir}/helper.ts`, "accepted helper\n");
    const frozen = freezeCheck(root, BROWSER)!;
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "edited\n");
    write(`${BROWSER.checkDir}/helper.ts`, "edited helper\n");

    restoreFrozenCheckPaths(root, frozen, [`${BROWSER.checkDir}/${BROWSER.checkPath}`]);
    expect(readFileSync(path.join(root, BROWSER.checkDir, "helper.ts"), "utf8")).toBe(
      "edited helper\n",
    );
  });
});

describe("re-freezing after a repair", () => {
  it("takes the check directory from the REWRITE and the environment from ACCEPTANCE", () => {
    // THE FAULT THIS TEST EXISTS FOR. The repair used to call `freezeCheck`
    // again, which captured the runner config, the global setup and the grading
    // library as the builder and the check-writer had left them — then wrote
    // that back before every graded run, including inside the pre-builder
    // replay that had just reverted it, and finally re-pointed the ship-time
    // drift detector at the tampered bytes.
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, IMPORTS_HELPER);
    write("apps/nextjs/e2e/lib/graded-screen-check.ts", "export const g = 1;\n");
    const accepted = freezeCheck(root, BROWSER)!;

    // An agent has now had the tree: the check is rewritten AND the grading
    // library is tampered with.
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, `${IMPORTS_HELPER}// rewritten\n`);
    write("apps/nextjs/e2e/lib/graded-screen-check.ts", "export const g = 2;\n");

    const repaired = withRepairedCheckDir(
      accepted,
      freezeRepairedCheckDir(root, BROWSER)!,
    );
    // The rewrite is what ships…
    expect(
      repaired.checkDir.bytesByRelPath.get(BROWSER.checkPath)?.toString("utf8"),
    ).toContain("// rewritten");
    // …and the tampered environment is NOT what it grades against.
    expect(repaired.environment).toEqual(accepted.environment);
    expect(frozenCheckDrift(root, repaired)).toEqual([
      "apps/nextjs/e2e/lib/graded-screen-check.ts",
    ]);
    // Restoring it puts the ACCEPTED grading library back.
    expect(restoreFrozenCheck(root, repaired).ok).toBe(true);
    expect(
      readFileSync(
        path.join(root, "apps/nextjs/e2e/lib/graded-screen-check.ts"),
        "utf8",
      ),
    ).toBe("export const g = 1;\n");
  });

  it("fingerprints differently from the freeze it was built on", () => {
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the original\n");
    const accepted = freezeCheck(root, BROWSER)!;
    write(`${BROWSER.checkDir}/${BROWSER.checkPath}`, "the rewrite\n");
    const repaired = withRepairedCheckDir(
      accepted,
      freezeRepairedCheckDir(root, BROWSER)!,
    );
    expect(repaired.fingerprint).not.toBe(accepted.fingerprint);
  });

  it("returns undefined when the rewritten directory cannot be read", () => {
    expect(freezeRepairedCheckDir(root, BROWSER)).toBeUndefined();
  });
});
