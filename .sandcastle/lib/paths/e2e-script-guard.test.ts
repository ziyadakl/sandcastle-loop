/**
 * Tests for the CONTENT-level `scripts.e2e` guard (issue #914 hardening),
 * run against a REAL temp git repo — the same discipline
 * `protected-path-restore.test.ts` uses, since this module reads real git
 * blobs at two shas.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "../../__fixtures__/git-repo.js";
import { EXAMPLE_PROJECT_CONFIG } from "../../__fixtures__/example-project-config.js";
import { resetProjectConfig } from "../project-config.js";
import { e2eScriptGuardedPackageJson, e2eScriptTampered } from "./e2e-script-guard.js";

// The guarded file is `e2eScriptPackageJson` in the project settings.
const E2E_SCRIPT_GUARDED_PACKAGE_JSON = EXAMPLE_PROJECT_CONFIG.e2eScriptPackageJson!;

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sandcastle-e2e-script-guard-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const pkgJson = (scripts: Record<string, string>): string =>
  JSON.stringify({ name: "@acme/nextjs", scripts }, null, 2) + "\n";

describe("e2eScriptGuardedPackageJson", () => {
  it("is OFF (null) by default and follows the project settings", () => {
    resetProjectConfig();
    expect(e2eScriptGuardedPackageJson()).toBeNull();
  });
  it("names the configured package.json", () => {
    expect(e2eScriptGuardedPackageJson()).toBe(E2E_SCRIPT_GUARDED_PACKAGE_JSON);
  });
});

describe("e2eScriptTampered", () => {
  it("PROVES THE INSTRUMENT: fires when the e2e script is retargeted to fake a pass", () => {
    const before = commitInto(
      repo,
      { [E2E_SCRIPT_GUARDED_PACKAGE_JSON]: pkgJson({ e2e: "playwright test" }) },
      "seed",
    );
    const after = commitInto(
      repo,
      {
        [E2E_SCRIPT_GUARDED_PACKAGE_JSON]: pkgJson({
          e2e: 'echo "1 passed"',
        }),
      },
      "fix: make the check pass\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    expect(e2eScriptTampered(repo, before, after, E2E_SCRIPT_GUARDED_PACKAGE_JSON)).toBe(true);
  });

  it("does NOT fire on an ordinary dependency addition that leaves the e2e script untouched", () => {
    const before = commitInto(
      repo,
      {
        [E2E_SCRIPT_GUARDED_PACKAGE_JSON]: pkgJson({
          e2e: "playwright test",
          dev: "next dev",
        }),
      },
      "seed",
    );
    const after = commitInto(
      repo,
      {
        [E2E_SCRIPT_GUARDED_PACKAGE_JSON]: JSON.stringify(
          {
            name: "@acme/nextjs",
            scripts: { e2e: "playwright test", dev: "next dev" },
            dependencies: { "@sentry/nextjs": "^8.0.0" },
          },
          null,
          2,
        ) + "\n",
      },
      "feat: add Sentry crash monitoring",
    );
    expect(e2eScriptTampered(repo, before, after, E2E_SCRIPT_GUARDED_PACKAGE_JSON)).toBe(false);
  });

  it("does not fire when the field is absent on either side", () => {
    const before = commitInto(
      repo,
      { [E2E_SCRIPT_GUARDED_PACKAGE_JSON]: pkgJson({ dev: "next dev" }) },
      "seed",
    );
    const after = commitInto(
      repo,
      { [E2E_SCRIPT_GUARDED_PACKAGE_JSON]: pkgJson({ dev: "next dev --turbo" }) },
      "chore: turbo dev",
    );
    expect(e2eScriptTampered(repo, before, after, E2E_SCRIPT_GUARDED_PACKAGE_JSON)).toBe(false);
  });

  it("fails safe (true — a violation) on an unreadable/missing blob, matching pathContentChangedBetween's identical ambiguity", () => {
    // Before this fix, an unreadable blob (no package.json AT ALL on either
    // side) folded to "nothing to compare" -> false, under a test literally
    // titled "fails safe". A broken/absent read is an AMBIGUITY, not proof
    // of no tampering — protected-path-restore.ts's `pathContentChangedBetween`
    // already resolves the same ambiguity to `true`, and this must agree.
    const seed = commitInto(repo, { "README.md": "x\n" }, "seed");
    expect(e2eScriptTampered(repo, seed, seed, E2E_SCRIPT_GUARDED_PACKAGE_JSON)).toBe(true);
    expect(e2eScriptTampered(repo, "not-a-real-sha", "also-not-real", E2E_SCRIPT_GUARDED_PACKAGE_JSON)).toBe(
      true,
    );
  });

  it("fails safe (true — a violation) on unparsable JSON rather than throwing or waving it through", () => {
    const before = commitInto(
      repo,
      { [E2E_SCRIPT_GUARDED_PACKAGE_JSON]: pkgJson({ e2e: "playwright test" }) },
      "seed",
    );
    const after = commitInto(
      repo,
      { [E2E_SCRIPT_GUARDED_PACKAGE_JSON]: "{ not valid json" },
      "oops",
    );
    expect(() => e2eScriptTampered(repo, before, after, E2E_SCRIPT_GUARDED_PACKAGE_JSON)).not.toThrow();
    expect(e2eScriptTampered(repo, before, after, E2E_SCRIPT_GUARDED_PACKAGE_JSON)).toBe(true);
  });
});
