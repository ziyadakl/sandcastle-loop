/**
 * Tests for the upstream-watch pure helpers. Covers extractSdkUsage (named,
 * `type`, namespace + member access, subpath imports, and an ignored unrelated
 * import) and the version parsing/comparison. No network here — the runner
 * (.sandcastle/scripts/check-upstream.mts) owns all I/O.
 *
 * Sort note: the default JS sort puts capitalized names (e.g. `SandboxHooks`)
 * before lowercase ones, so the expected symbol arrays lead with capitals.
 */

import { describe, it, expect } from "vitest";
import {
  extractSdkUsage,
  parseVersion,
  isNewer,
} from "../.sandcastle/lib/check-upstream.js";

describe("extractSdkUsage", () => {
  it("collects named, type, namespace-member, and subpath symbols and ignores unrelated imports", () => {
    const files = new Map<string, string>([
      [
        ".sandcastle/main.mts",
        [
          // Named import from a subpath entrypoint.
          `import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/docker";`,
          // Unrelated import that must be ignored entirely.
          `import { readFileSync } from "node:fs";`,
          `void readFileSync;`,
          `void defaultImageName;`,
        ].join("\n"),
      ],
      [
        ".sandcastle/lib/sandbox-provider.ts",
        [
          // Namespace import + member access on the alias.
          `import * as sandcastle from "@ai-hero/sandcastle";`,
          // `type` import (the leading `type ` keyword must be stripped).
          `import type { SandboxHooks } from "@ai-hero/sandcastle";`,
          // Named import from a subpath (same subpath as main — dedup to one).
          `import { docker } from "@ai-hero/sandcastle/sandboxes/docker";`,
          `const r = await sandcastle.run({});`,
          `const a = sandcastle.claudeCode("m", {});`,
          `const h = await sandcastle.createSandbox({});`,
          `void r; void a; void h; void docker;`,
        ].join("\n"),
      ],
    ]);

    const usage = extractSdkUsage(files);

    // Capitalized SandboxHooks sorts before the lowercase names.
    expect(usage.symbols).toEqual([
      "SandboxHooks",
      "claudeCode",
      "createSandbox",
      "defaultImageName",
      "docker",
      "run",
    ]);
    expect(usage.subpaths).toEqual(["sandboxes/docker"]);
    expect(usage.files).toEqual([
      ".sandcastle/lib/sandbox-provider.ts",
      ".sandcastle/main.mts",
    ]);
  });

  it("handles a `type` qualifier inside an inline named list", () => {
    const files = new Map<string, string>([
      [
        "a.ts",
        `import { run, type SandboxHooks, createSandbox } from "@ai-hero/sandcastle";`,
      ],
    ]);
    const usage = extractSdkUsage(files);
    expect(usage.symbols).toEqual(["SandboxHooks", "createSandbox", "run"]);
    expect(usage.subpaths).toEqual([]);
    expect(usage.files).toEqual(["a.ts"]);
  });

  it("returns empty arrays when no file imports the SDK", () => {
    const files = new Map<string, string>([
      ["x.ts", `import { join } from "node:path";\nvoid join;`],
      ["y.ts", `export const z = 1;`],
    ]);
    const usage = extractSdkUsage(files);
    expect(usage.symbols).toEqual([]);
    expect(usage.subpaths).toEqual([]);
    expect(usage.files).toEqual([]);
  });

  it("returns empty arrays for an empty file map", () => {
    const usage = extractSdkUsage(new Map());
    expect(usage.symbols).toEqual([]);
    expect(usage.subpaths).toEqual([]);
    expect(usage.files).toEqual([]);
  });
});

describe("parseVersion", () => {
  it("strips a caret range prefix", () => {
    expect(parseVersion("^0.7.0")).toEqual([0, 7, 0]);
  });

  it("strips a tilde range prefix", () => {
    expect(parseVersion("~1.2.3")).toEqual([1, 2, 3]);
  });

  it("parses a bare version", () => {
    expect(parseVersion("2.10.4")).toEqual([2, 10, 4]);
  });

  it("defaults missing components to 0", () => {
    expect(parseVersion("3")).toEqual([3, 0, 0]);
    expect(parseVersion("3.1")).toEqual([3, 1, 0]);
  });
});

describe("isNewer", () => {
  it("is true when the major is higher", () => {
    expect(isNewer("1.0.0", "^0.7.0")).toBe(true);
  });

  it("is true when the minor is higher", () => {
    expect(isNewer("0.8.0", "^0.7.0")).toBe(true);
  });

  it("is true when the patch is higher", () => {
    expect(isNewer("0.7.1", "0.7.0")).toBe(true);
  });

  it("is false for equal versions (ignoring range prefixes)", () => {
    expect(isNewer("0.7.0", "^0.7.0")).toBe(false);
  });

  it("is false when latest is older", () => {
    expect(isNewer("0.6.9", "^0.7.0")).toBe(false);
    expect(isNewer("1.0.0", "2.0.0")).toBe(false);
  });
});
