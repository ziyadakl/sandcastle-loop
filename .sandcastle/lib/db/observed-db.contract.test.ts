/**
 * Cross-boundary pin for the observed-database sentinel (issue #1025).
 *
 * `.sandcastle` never imports the project's module code, so
 * {@link OBSERVED_DB_SENTINEL} is duplicated as a literal in the project's
 * Playwright global setup (which emits it; the reference copy under
 * `__fixtures__/project-side/` is what this test reads) and here (which parses it).
 * Nothing but this test pins the two together — rename either copy and
 * `parseObservedDatabases` silently stops seeing the line, and the whole #1025
 * guard goes blind exactly where nobody would look. This reads global-setup's
 * SOURCE TEXT (it can't be imported across the boundary) and asserts the emitted
 * prefix still matches this side's constant, byte for byte.
 *
 * Modelled on `../harness/sentinel-contract.test.ts`, which does the same for
 * the screen-check sentinels.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { OBSERVED_DB_SENTINEL } from "./observed-db.js";

const SOURCE_URL = new URL(
  "../../__fixtures__/project-side/global-setup.ts",
  import.meta.url,
);
const source = readFileSync(SOURCE_URL, "utf8");

describe("observed-db contract with the project-side global setup (reference copy)", () => {
  it("the source file actually loaded and is the global setup — prove the instrument before trusting its silence", () => {
    expect(source.length).toBeGreaterThan(200);
    expect(source).toContain("export default async function globalSetup");
  });

  it("global-setup emits the exact same OBSERVED_DB_SENTINEL prefix this side parses", () => {
    // Emitted as a template literal: `SANDCASTLE_OBSERVED_DB:${observed}`.
    expect(source).toContain(`\`${OBSERVED_DB_SENTINEL}\${observed}\``);
  });

  it("global-setup reads the real resolved database, not a hardcoded name", () => {
    expect(source).toContain("select current_database()");
  });
});
