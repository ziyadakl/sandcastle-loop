/**
 * Unit tests for the host-side TEST-CERT gate pure helpers — a 1:1 mirror of
 * the LINT-CERT gate. The host does NOT run tests; the implementer certifies
 * `SANDCASTLE-TEST: pass` in the commit body, the reviewer verifies by running
 * the suite (prompt-side), and this deterministic backstop only confirms the
 * cert is present on a code-bearing diff. See classifyLintCert / classifyTestCert.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  hasTestScript,
  commitMessageHasTestCert,
  classifyTestCert,
  TEST_CERT_TOKEN,
} from "../.sandcastle/main.mjs";

describe("test-gate helpers (hasTestScript, commitMessageHasTestCert)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "sc-test-cert-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writePkg = (scripts: Record<string, string>) =>
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ scripts }));

  it("TEST_CERT_TOKEN is the stable pass certification", () => {
    expect(TEST_CERT_TOKEN).toBe("SANDCASTLE-TEST: pass");
  });

  it("hasTestScript: true when package.json has a non-empty test script", () => {
    writePkg({ test: "vitest run" });
    expect(hasTestScript(tmp)).toBe(true);
  });

  it("hasTestScript: false when there is no test script", () => {
    writePkg({ lint: "eslint ." });
    expect(hasTestScript(tmp)).toBe(false);
  });

  it("hasTestScript: fail-quiet false on missing/malformed package.json or empty script", () => {
    expect(hasTestScript(tmp)).toBe(false); // no package.json
    writeFileSync(path.join(tmp, "package.json"), "{ not json");
    expect(hasTestScript(tmp)).toBe(false); // malformed
    writePkg({ test: "   " });
    expect(hasTestScript(tmp)).toBe(false); // whitespace-only script
  });

  it("commitMessageHasTestCert: matches the pass token, case/spacing-insensitive", () => {
    expect(commitMessageHasTestCert("body\n\nSANDCASTLE-TEST: pass\n")).toBe(true);
    expect(commitMessageHasTestCert("sandcastle-test:   PASS (742 tests)")).toBe(
      true,
    );
  });

  it("commitMessageHasTestCert: does NOT match n/a, a missing cert, or 'passed'", () => {
    expect(commitMessageHasTestCert("body\n\nSANDCASTLE-TEST: n/a")).toBe(false);
    expect(commitMessageHasTestCert("no cert in this body")).toBe(false);
    expect(commitMessageHasTestCert("SANDCASTLE-TEST: passed maybe")).toBe(false);
  });
});

describe("classifyTestCert (test-gate dormancy matrix)", () => {
  const CERT = "feat: thing\n\nSANDCASTLE-TEST: pass\n";

  it("dormant when the project has no test script", () => {
    // Even with a real diff and a missing cert, no test script ⇒ no-op.
    expect(classifyTestCert(false, "pre", "post", "no cert here")).toEqual({
      status: "dormant",
    });
  });

  it("dormant when there is no code diff (empty or equal SHAs)", () => {
    expect(classifyTestCert(true, "", "post", CERT)).toEqual({
      status: "dormant",
    });
    expect(classifyTestCert(true, "pre", "", CERT)).toEqual({
      status: "dormant",
    });
    expect(classifyTestCert(true, "sha", "sha", CERT)).toEqual({
      status: "dormant",
    });
  });

  it("dormant (fail-quiet) when the commit message is unreadable (null)", () => {
    // The safety-critical branch: a git/infra hiccup must NOT quarantine.
    expect(classifyTestCert(true, "pre", "post", null)).toEqual({
      status: "dormant",
    });
  });

  it("pass when a test-enabled diff carries the cert", () => {
    expect(classifyTestCert(true, "pre", "post", CERT)).toEqual({
      status: "pass",
    });
  });

  it("missing when a test-enabled diff lacks the cert", () => {
    expect(classifyTestCert(true, "pre", "post", "feat: thing\n")).toEqual({
      status: "missing",
    });
  });
});
