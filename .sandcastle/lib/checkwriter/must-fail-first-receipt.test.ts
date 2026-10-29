import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkDirForIssue } from "./check-path.js";
import {
  browserCheckLocation,
  checkFileIsOnDisk,
  checkFileRelPath,
  MUST_FAIL_FIRST_RECEIPT_FILENAME,
  mustFailFirstAlreadyProven,
  mustFailFirstReceiptRelPath,
  readMustFailFirstReceipt,
  unitCheckLocation,
  writeMustFailFirstReceipt,
} from "./must-fail-first-receipt.js";
import { unitCheckDirFor, unitCheckDirGlobFor } from "./unit-check-path.js";

const CHECK = "team-cash-flow.spec.ts";
const BODY =
  `import { gradeScreenText, waitForGradableScreen } from "../../lib/graded-screen-check";\n` +
  `test("x", async ({ page }) => {\n` +
  `  await waitForGradableScreen(page, { screen: "x", expectedClaim: {}, screenshotPath: "x" });\n` +
  `  await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
  `});\n`;

/** The browser location every pre-#956 test in this file was implicitly about. */
function browserLoc(checkPath = CHECK) {
  const loc = browserCheckLocation(911, checkPath);
  if (loc === undefined) throw new Error("expected a valid browser location");
  return loc;
}

describe("must-fail-first receipt — the proof carried forward across a checkpoint", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sandcastle-mff-receipt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCheck(body = BODY): void {
    const checkDir = path.join(dir, checkDirForIssue(911));
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(path.join(checkDir, CHECK), body);
  }

  it("lives next to the check it proves, inside the per-issue check directory", () => {
    expect(mustFailFirstReceiptRelPath(browserLoc())).toBe(
      `apps/nextjs/e2e/checks/issue-911/${MUST_FAIL_FIRST_RECEIPT_FILENAME}`,
    );
    // Inside the directory the protected-path lock already covers, so the
    // builder cannot forge or delete it after the check-writer stage.
    expect(
      mustFailFirstReceiptRelPath(browserLoc()).startsWith(checkDirForIssue(911)),
    ).toBe(true);
  });

  it("PROVES THE INSTRUMENT: write then read round-trips, and the ticket reads as proven", () => {
    writeCheck();
    const written = writeMustFailFirstReceipt(dir, browserLoc());
    expect(written).toBeDefined();
    expect(written?.verdict).toBe("red");
    expect(written?.checkPath).toBe(CHECK);

    const read = readMustFailFirstReceipt(dir, browserLoc());
    expect(read).toEqual(written);
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(true);
  });

  it("is NOT proven when no receipt was ever written — the safe default", () => {
    writeCheck();
    expect(readMustFailFirstReceipt(dir, browserLoc())).toBeUndefined();
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(false);
  });

  it("a receipt for a DIFFERENT check file does not waive this one's proof", () => {
    writeCheck();
    writeMustFailFirstReceipt(dir, browserLoc());
    expect(
      mustFailFirstAlreadyProven(dir, browserLoc("some-other.spec.ts")),
    ).toBe(false);
  });

  it("EDITING the check after the proof invalidates the receipt — the content is pinned, not just the name", () => {
    writeCheck();
    writeMustFailFirstReceipt(dir, browserLoc());
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(true);
    // The check-writer rewrote its check on the resumed pass. Whatever was
    // proven red earlier was proven about a DIFFERENT file.
    writeCheck(BODY.replace("$1,234", "$9,999"));
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(false);
  });

  it("a DELETED check file is never proven, even with a receipt sitting next to it", () => {
    writeCheck();
    writeMustFailFirstReceipt(dir, browserLoc());
    rmSync(path.join(dir, checkDirForIssue(911), CHECK));
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(false);
  });

  it("a hand-forged / corrupt receipt is not proof — malformed JSON reads as absent", () => {
    writeCheck();
    const checkDir = path.join(dir, checkDirForIssue(911));
    writeFileSync(
      path.join(checkDir, MUST_FAIL_FIRST_RECEIPT_FILENAME),
      "{ not json",
    );
    expect(readMustFailFirstReceipt(dir, browserLoc())).toBeUndefined();
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(false);
  });

  it('a receipt claiming any verdict other than "red" is not proof', () => {
    writeCheck();
    const good = writeMustFailFirstReceipt(dir, browserLoc());
    const checkDir = path.join(dir, checkDirForIssue(911));
    writeFileSync(
      path.join(checkDir, MUST_FAIL_FIRST_RECEIPT_FILENAME),
      JSON.stringify({ ...good, verdict: "green" }),
    );
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(false);
  });

  it("a receipt minted for a DIFFERENT issue does not carry over", () => {
    writeCheck();
    const good = writeMustFailFirstReceipt(dir, browserLoc());
    const checkDir = path.join(dir, checkDirForIssue(911));
    writeFileSync(
      path.join(checkDir, MUST_FAIL_FIRST_RECEIPT_FILENAME),
      JSON.stringify({ ...good, issue: 912 }),
    );
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(false);
  });

  it("writing is total: an unreadable check file yields no receipt rather than throwing", () => {
    expect(() => writeMustFailFirstReceipt(dir, browserLoc())).not.toThrow();
    expect(writeMustFailFirstReceipt(dir, browserLoc())).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 2026-08-04 review, BLOCKER 4 + the resume-path honesty finding. A receipt
  // had exactly one meaning — "the loop ran this proof against untouched code
  // and it failed" — and two of the three ways one gets minted do not match
  // that sentence. `basis` makes the record say which it is.
  // -------------------------------------------------------------------------

  it("defaults to the pre-build basis — the ordinary, honest case", () => {
    writeCheck();
    expect(writeMustFailFirstReceipt(dir, browserLoc())?.basis).toBe(
      "proved-red-pre-build",
    );
  });

  it("records a POST-RESUME proof as such — it was not run against untouched code", () => {
    writeCheck();
    const written = writeMustFailFirstReceipt(
      dir,
      browserLoc(),
      "proved-red-post-resume",
    );
    expect(written?.basis).toBe("proved-red-post-resume");
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(true);
  });

  it("records a human-committed inheritance, so it survives a checkpoint", () => {
    writeCheck();
    const written = writeMustFailFirstReceipt(
      dir,
      browserLoc(),
      "inherited-human-committed",
    );
    expect(written?.basis).toBe("inherited-human-committed");
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(true);
  });

  it("a receipt naming an unknown basis is not proof", () => {
    writeCheck();
    const good = writeMustFailFirstReceipt(dir, browserLoc());
    writeFileSync(
      path.join(dir, mustFailFirstReceiptRelPath(browserLoc())),
      JSON.stringify({ ...good, basis: "because-i-said-so" }),
    );
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(false);
  });

  it("a PRE-basis receipt still reads as the pre-build case, not as absent", () => {
    writeCheck();
    const good = writeMustFailFirstReceipt(dir, browserLoc());
    const { basis: _dropped, ...withoutBasis } = good!;
    writeFileSync(
      path.join(dir, mustFailFirstReceiptRelPath(browserLoc())),
      JSON.stringify(withoutBasis),
    );
    expect(readMustFailFirstReceipt(dir, browserLoc())?.basis).toBe(
      "proved-red-pre-build",
    );
    expect(mustFailFirstAlreadyProven(dir, browserLoc())).toBe(true);
  });

  it("a receipt whose checkPath escapes the check directory reads nothing outside it", () => {
    // The one call site that skipped `isSafeCheckRelativePath`: a forged
    // receipt (or an envelope for a non-CHECKS_WRITTEN marker) could name
    // `../../../../etc/passwd` and reach readFileSync on it. It cannot leak
    // (only a discarded hash) and cannot write, but `check-path.ts:39-49`
    // states the whitelist as a rule and this was the one place breaking it.
    writeCheck();
    const outside = path.join(dir, "apps/nextjs/e2e/checks", "outside.spec.ts");
    writeFileSync(outside, BODY);
    const good = writeMustFailFirstReceipt(dir, browserLoc());
    writeFileSync(
      path.join(dir, mustFailFirstReceiptRelPath(browserLoc())),
      JSON.stringify({ ...good, checkPath: "../outside.spec.ts" }),
    );
    expect(readMustFailFirstReceipt(dir, browserLoc())).toBeUndefined();
    // …and there is no way to even ASK about that path any more: the
    // whitelist now runs at construction, so no location naming it exists.
    expect(browserCheckLocation(911, "../outside.spec.ts")).toBeUndefined();
  });

  it("writing refuses an unsafe checkPath outright — before a location exists at all", () => {
    writeCheck();
    expect(browserCheckLocation(911, "../../../../etc/passwd")).toBeUndefined();
  });

  it("is written as human-readable JSON — a person triaging a stopped ticket can read it", () => {
    writeCheck();
    writeMustFailFirstReceipt(dir, browserLoc());
    const raw = readFileSync(
      path.join(dir, mustFailFirstReceiptRelPath(browserLoc())),
      "utf8",
    );
    expect(raw).toContain('"verdict": "red"');
    expect(raw.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The UNIT runner's twin (issue #956). Every property above has to hold here
// too — same receipt, same sha256 byte-lock, same "missing/unreadable/
// malformed/forged/stale reads as NOT proven" contract — with the receipt
// living inside the UNIT check directory, next to the check it is about. A
// receipt in the browser directory would have nothing to lock: the file it
// names is not there.
// ---------------------------------------------------------------------------

const UNIT_PKG = "packages/api";
const UNIT_CHECK = "email-registry.test.ts";
const UNIT_BODY =
  `import { describe, expect, it } from "vitest";\n` +
  `import { renderTemplate } from "../../services/email/render-template.js";\n` +
  `it("renders the welcome template", () => {\n` +
  `  expect(renderTemplate("welcome")).toContain("Welcome");\n` +
  `});\n`;

describe("must-fail-first receipt — the unit runner's twin (issue #956)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sandcastle-mff-unit-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function unitLoc(checkPath = UNIT_CHECK, packageDir = UNIT_PKG) {
    const loc = unitCheckLocation(848, packageDir, checkPath);
    if (loc === undefined) throw new Error("expected a valid unit location");
    return loc;
  }

  function writeUnitCheck(body = UNIT_BODY): void {
    const checkDir = path.join(dir, unitCheckDirFor(UNIT_PKG, 848));
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(path.join(checkDir, UNIT_CHECK), body);
  }

  it("lives inside the UNIT check directory, not the browser one", () => {
    expect(mustFailFirstReceiptRelPath(unitLoc())).toBe(
      `packages/api/src/__checks__/issue-848/${MUST_FAIL_FIRST_RECEIPT_FILENAME}`,
    );
    // The lock that makes the receipt unforgeable is `unitCheckDirGlobFor`,
    // and it only covers paths under this directory.
    expect(
      mustFailFirstReceiptRelPath(unitLoc()).startsWith(
        unitCheckDirFor(UNIT_PKG, 848),
      ),
    ).toBe(true);
    // Never the browser directory — the file it would claim to prove is not
    // there, so the sha256 lock would have nothing to lock.
    expect(mustFailFirstReceiptRelPath(unitLoc())).not.toContain("e2e/checks");
  });

  it("PROVES THE INSTRUMENT: write then read round-trips, and the ticket reads as proven", () => {
    writeUnitCheck();
    const written = writeMustFailFirstReceipt(dir, unitLoc());
    expect(written).toBeDefined();
    expect(written?.verdict).toBe("red");
    expect(written?.checkPath).toBe(UNIT_CHECK);
    expect(readMustFailFirstReceipt(dir, unitLoc())).toEqual(written);
    expect(mustFailFirstAlreadyProven(dir, unitLoc())).toBe(true);
  });

  it("is NOT proven when no receipt was ever written", () => {
    writeUnitCheck();
    expect(mustFailFirstAlreadyProven(dir, unitLoc())).toBe(false);
  });

  it("EDITING the unit check invalidates the receipt — the same byte-lock", () => {
    writeUnitCheck();
    writeMustFailFirstReceipt(dir, unitLoc());
    expect(mustFailFirstAlreadyProven(dir, unitLoc())).toBe(true);
    writeUnitCheck(UNIT_BODY.replace("Welcome", "Hello"));
    expect(mustFailFirstAlreadyProven(dir, unitLoc())).toBe(false);
  });

  it("a DELETED unit check is never proven", () => {
    writeUnitCheck();
    writeMustFailFirstReceipt(dir, unitLoc());
    rmSync(path.join(dir, unitCheckDirFor(UNIT_PKG, 848), UNIT_CHECK));
    expect(mustFailFirstAlreadyProven(dir, unitLoc())).toBe(false);
  });

  it("a forged unit receipt reads as absent — malformed JSON, wrong issue, wrong verdict", () => {
    writeUnitCheck();
    const good = writeMustFailFirstReceipt(dir, unitLoc());
    const rel = path.join(dir, mustFailFirstReceiptRelPath(unitLoc()));
    writeFileSync(rel, "{ not json");
    expect(readMustFailFirstReceipt(dir, unitLoc())).toBeUndefined();
    writeFileSync(rel, JSON.stringify({ ...good, issue: 849 }));
    expect(mustFailFirstAlreadyProven(dir, unitLoc())).toBe(false);
    writeFileSync(rel, JSON.stringify({ ...good, verdict: "green" }));
    expect(mustFailFirstAlreadyProven(dir, unitLoc())).toBe(false);
  });

  it("records all three bases, exactly as the browser route does", () => {
    writeUnitCheck();
    expect(writeMustFailFirstReceipt(dir, unitLoc())?.basis).toBe(
      "proved-red-pre-build",
    );
    expect(
      writeMustFailFirstReceipt(dir, unitLoc(), "proved-red-post-resume")?.basis,
    ).toBe("proved-red-post-resume");
    expect(
      writeMustFailFirstReceipt(dir, unitLoc(), "inherited-human-committed")
        ?.basis,
    ).toBe("inherited-human-committed");
    expect(mustFailFirstAlreadyProven(dir, unitLoc())).toBe(true);
  });

  it("writing is total: an unreadable unit check yields no receipt rather than throwing", () => {
    expect(() => writeMustFailFirstReceipt(dir, unitLoc())).not.toThrow();
    expect(writeMustFailFirstReceipt(dir, unitLoc())).toBeUndefined();
  });

  it("a forged unit receipt whose checkPath escapes the directory reads as absent", () => {
    writeUnitCheck();
    const good = writeMustFailFirstReceipt(dir, unitLoc());
    writeFileSync(
      path.join(dir, mustFailFirstReceiptRelPath(unitLoc())),
      JSON.stringify({ ...good, checkPath: "../outside.test.ts" }),
    );
    expect(readMustFailFirstReceipt(dir, unitLoc())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The constructors. This is where "a caller cannot mix a browser directory
// with a unit path" is enforced, so it is where it has to be proven.
// ---------------------------------------------------------------------------

describe("check locations — a mixed browser/unit pair is unrepresentable", () => {
  it("a browser location only ever accepts a .spec.ts, and builds the browser directory", () => {
    const loc = browserCheckLocation(911, CHECK);
    expect(loc?.kind).toBe("browser");
    expect(loc?.checkDir).toBe(checkDirForIssue(911));
    expect(loc?.checkDirGlob).toBe(`${checkDirForIssue(911)}/**`);
    // The unit runner's extension cannot enter through this door.
    expect(browserCheckLocation(911, "x.test.ts")).toBeUndefined();
  });

  it("a unit location only ever accepts a .test.ts, and builds the package's directory", () => {
    const loc = unitCheckLocation(848, UNIT_PKG, UNIT_CHECK);
    expect(loc?.kind).toBe("unit");
    expect(loc?.checkDir).toBe(unitCheckDirFor(UNIT_PKG, 848));
    // The lock is the single most load-bearing consequence of getting the
    // location right: without it the builder can edit or delete the very check
    // it is about to be graded by, and the whole red-first proof is worthless.
    expect(loc?.checkDirGlob).toBe(unitCheckDirGlobFor(UNIT_PKG, 848));
    expect(loc?.checkDirGlob).not.toContain("e2e/checks");
    // The browser runner's extension cannot enter through this door either.
    expect(unitCheckLocation(848, UNIT_PKG, "x.spec.ts")).toBeUndefined();
  });

  it("refuses an app as the host package — the demand it would create is one it cannot meet", () => {
    expect(unitCheckLocation(848, "apps/nextjs", UNIT_CHECK)).toBeUndefined();
  });

  it("refuses a traversing or shell-metacharacter path on BOTH routes", () => {
    for (const bad of [
      "../../../etc/passwd.spec.ts",
      "/abs/x.spec.ts",
      "has space.spec.ts",
      "x.spec.ts; rm -rf /",
    ]) {
      expect(browserCheckLocation(911, bad)).toBeUndefined();
    }
    for (const bad of [
      "../../../etc/passwd.test.ts",
      "/abs/x.test.ts",
      "has space.test.ts",
      "$(whoami).test.ts",
    ]) {
      expect(unitCheckLocation(848, UNIT_PKG, bad)).toBeUndefined();
    }
  });

  it("refuses a traversing or malformed package directory", () => {
    for (const bad of [
      "../packages/api",
      "packages/api/src",
      "packages/API",
      "packages/api; echo hi",
      "tooling/vitest",
    ]) {
      expect(unitCheckLocation(848, bad, UNIT_CHECK)).toBeUndefined();
    }
  });

  it("refuses a non-positive or non-integer issue number on both routes", () => {
    // The number is interpolated into a directory name and, on the unit
    // route, into the shell path `buildUnitCheckCommand` builds.
    expect(browserCheckLocation(0, CHECK)).toBeUndefined();
    expect(browserCheckLocation(-1, CHECK)).toBeUndefined();
    expect(browserCheckLocation(1.5, CHECK)).toBeUndefined();
    expect(unitCheckLocation(0, UNIT_PKG, UNIT_CHECK)).toBeUndefined();
    expect(unitCheckLocation(-1, UNIT_PKG, UNIT_CHECK)).toBeUndefined();
    expect(unitCheckLocation(1.5, UNIT_PKG, UNIT_CHECK)).toBeUndefined();
  });

  it("is total on hostile input rather than throwing", () => {
    // @ts-expect-error deliberately hostile input
    expect(() => browserCheckLocation(911, undefined)).not.toThrow();
    // @ts-expect-error deliberately hostile input
    expect(browserCheckLocation(911, 42)).toBeUndefined();
    // @ts-expect-error deliberately hostile input
    expect(unitCheckLocation(848, null, UNIT_CHECK)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ISSUE #1235. The #1271 sibling-repair brief hands the check-writer a
// REPO-RELATIVE path, and on 2026-09-10 the agent answered with its last two
// segments — `issue-1058/cross-team-relist-guard.test.ts` — which the host
// joined under a `checkDir` already ending `.../issue-1058`. The resulting
// doubled path named a file that has never existed, the content scan read
// nothing, and a correct build was thrown away. Both doors now normalise.
// ---------------------------------------------------------------------------
describe("a checkPath that repeats its own issue directory (issue #1235)", () => {
  it("strips the doubled segment from the exact path the #1235 run died on", () => {
    const loc = unitCheckLocation(
      1058,
      "packages/api",
      "issue-1058/cross-team-relist-guard.test.ts",
    );
    expect(loc?.checkPath).toBe("cross-team-relist-guard.test.ts");
    // The joined path is the file that actually exists on `main`, not the
    // `.../issue-1058/issue-1058/...` one the run tried to read.
    expect(`${loc?.checkDir}/${loc?.checkPath}`).toBe(
      "packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts",
    );
  });

  it("strips it on the browser route too", () => {
    const loc = browserCheckLocation(911, "issue-911/team-cash-flow.spec.ts");
    expect(loc?.checkPath).toBe("team-cash-flow.spec.ts");
    expect(`${loc?.checkDir}/${loc?.checkPath}`).toBe(
      "apps/nextjs/e2e/checks/issue-911/team-cash-flow.spec.ts",
    );
  });

  it("leaves a legitimate nested checkPath exactly as written", () => {
    // The shallow-nesting permission in `checkRelativePathPattern` is
    // load-bearing (`hasPreexistingCheckFiles` walks sub-directories, and the
    // schema has a test pinning `reports/team-cash-flow.spec.ts`), so the fix
    // must not flatten it.
    expect(
      browserCheckLocation(911, "reports/team-cash-flow.spec.ts")?.checkPath,
    ).toBe("reports/team-cash-flow.spec.ts");
    expect(
      unitCheckLocation(848, "packages/api", "email/registry.test.ts")
        ?.checkPath,
    ).toBe("email/registry.test.ts");
  });

  it("leaves a DIFFERENT issue's directory alone, so the missing file is reported by name", () => {
    // `issue-999/` under #1058's directory is not a clerical doubling — it is
    // a path naming somewhere else. Repairing it would silently re-point the
    // amendment at a file the judge never ruled on.
    expect(
      unitCheckLocation(1058, "packages/api", "issue-999/guard.test.ts")
        ?.checkPath,
    ).toBe("issue-999/guard.test.ts");
  });

  it("still refuses a path that is nothing BUT the issue directory", () => {
    // Nothing is left after the segment, so there is no filename to keep and
    // the runner whitelist refuses it — never a location pointing at a
    // directory.
    expect(browserCheckLocation(911, "issue-911/")).toBeUndefined();
    expect(unitCheckLocation(848, "packages/api", "issue-848/")).toBeUndefined();
  });

  it("whitelists the STRIPPED path, never the raw one", () => {
    // A doubled prefix in front of an otherwise-illegal path must still be
    // refused: the normalisation runs before the whitelist, not instead of it.
    expect(
      unitCheckLocation(1058, "packages/api", "issue-1058/guard.spec.ts"),
    ).toBeUndefined();
    expect(
      unitCheckLocation(1058, "packages/api", "issue-1058/guard test.test.ts"),
    ).toBeUndefined();
  });
});

describe("checkFileIsOnDisk — a missing file is its own fault (issue #1235)", () => {
  let dir: string;

  /**
   * {@link browserLoc}'s unit twin for #1058, so this block holds a location
   * without a `!` — same shape as the unit twin the #956 block already keeps.
   */
  function unitLoc(checkPath: string) {
    const loc = unitCheckLocation(1058, UNIT_PKG, checkPath);
    if (loc === undefined) throw new Error("expected a valid unit location");
    return loc;
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sandcastle-mff-ondisk-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is false when nothing is there, true once the file lands", () => {
    const loc = unitLoc("cross-team-relist-guard.test.ts");
    expect(checkFileIsOnDisk(dir, loc)).toBe(false);
    const checkDir = path.join(dir, loc.checkDir);
    mkdirSync(checkDir, { recursive: true });
    writeFileSync(path.join(checkDir, loc.checkPath), "// a check\n");
    expect(checkFileIsOnDisk(dir, loc)).toBe(true);
    expect(checkFileRelPath(loc)).toBe(
      "packages/api/src/__checks__/issue-1058/cross-team-relist-guard.test.ts",
    );
  });

  it("is false for a DIRECTORY at that path, not true", () => {
    const loc = browserLoc();
    mkdirSync(path.join(dir, loc.checkDir, loc.checkPath), { recursive: true });
    expect(checkFileIsOnDisk(dir, loc)).toBe(false);
  });
});
