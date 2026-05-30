/**
 * Tests for the placeholder lint (audit Issue 4). Validates the pure
 * extractors and the cross-check, plus a smoke that the live repo's
 * prompts and main.mts pass the lint as shipped.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  extractPlaceholders,
  extractPromptArgKeys,
  findOrphanPlaceholders,
} from "../.sandcastle/lib/lint-placeholders.js";

describe("extractPlaceholders", () => {
  it("returns [] for content with no placeholders", () => {
    expect(extractPlaceholders("plain prose, no tokens")).toEqual([]);
  });

  it("extracts a single ALL_CAPS placeholder", () => {
    expect(extractPlaceholders("Hello {{NAME}}!")).toEqual(["NAME"]);
  });

  it("extracts multiple distinct placeholders sorted alphabetically", () => {
    expect(extractPlaceholders("{{ZULU}} {{ALPHA}} {{MIKE}}")).toEqual([
      "ALPHA",
      "MIKE",
      "ZULU",
    ]);
  });

  it("deduplicates repeated placeholders", () => {
    expect(extractPlaceholders("{{X}} {{X}} {{Y}} {{X}}")).toEqual(["X", "Y"]);
  });

  it("accepts identifiers with digits and underscores after the leading letter", () => {
    expect(extractPlaceholders("{{A1_B2_C3}}")).toEqual(["A1_B2_C3"]);
  });

  it("ignores lowercase or mixed-case tokens (SDK doesn't substitute those)", () => {
    expect(extractPlaceholders("{{lowercase}} {{MixedCase}} {{UPPER}}")).toEqual([
      "UPPER",
    ]);
  });

  it("ignores single-brace and unclosed tokens", () => {
    expect(extractPlaceholders("{NAME} {{NAME {{REAL}}")).toEqual(["REAL"]);
  });
});

describe("extractPromptArgKeys", () => {
  it("extracts keys from a single inline literal", () => {
    const src = `await sb.run({ promptArgs: { ITERATION: it, BRANCH: b } });`;
    expect(extractPromptArgKeys(src)).toEqual(["BRANCH", "ITERATION"]);
  });

  it("extracts keys from a multi-line literal", () => {
    const src = [
      "await sb.run({",
      "  promptArgs: {",
      "    ITERATION: it,",
      "    ISSUE_NUMBER: n,",
      "    LABEL: label,",
      "  },",
      "});",
    ].join("\n");
    expect(extractPromptArgKeys(src)).toEqual([
      "ISSUE_NUMBER",
      "ITERATION",
      "LABEL",
    ]);
  });

  it("merges keys across multiple promptArgs literals", () => {
    const src = [
      "x({ promptArgs: { A: 1 } });",
      "y({ promptArgs: { B: 2, C: 3 } });",
      "z({ promptArgs: { A: 1, D: 4 } });",
    ].join("\n");
    expect(extractPromptArgKeys(src)).toEqual(["A", "B", "C", "D"]);
  });

  it("tolerates pass-through call sites (no `{` after `promptArgs:`)", () => {
    const src = [
      "fn({ promptArgs: opts.promptArgs });",
      "fn({ promptArgs: spec.promptArgs });",
      "fn({ promptArgs: { REAL_KEY: 1 } });",
    ].join("\n");
    expect(extractPromptArgKeys(src)).toEqual(["REAL_KEY"]);
  });

  it("handles a value that itself contains a brace-balanced subexpression", () => {
    const src = `fn({ promptArgs: { KEY: (function(){return 1;})(), OTHER: 2 } });`;
    expect(extractPromptArgKeys(src)).toEqual(["KEY", "OTHER"]);
  });
});

describe("findOrphanPlaceholders", () => {
  it("returns [] when every placeholder has a matching key", () => {
    const prompts = new Map<string, string>([
      ["a-prompt.md", "Hi {{NAME}} from {{TEAM}}"],
    ]);
    const main = `fn({ promptArgs: { NAME: x, TEAM: y } });`;
    expect(findOrphanPlaceholders(prompts, main)).toEqual([]);
  });

  it("flags an orphan placeholder that has no matching key", () => {
    const prompts = new Map<string, string>([
      ["broken-prompt.md", "Hi {{NAME}} and {{MISSING_KEY}}"],
    ]);
    const main = `fn({ promptArgs: { NAME: x } });`;
    expect(findOrphanPlaceholders(prompts, main)).toEqual([
      { file: "broken-prompt.md", placeholder: "MISSING_KEY" },
    ]);
  });

  it("flags the same orphan independently from each file it appears in", () => {
    const prompts = new Map<string, string>([
      ["one.md", "{{MISSING}}"],
      ["two.md", "{{MISSING}} {{KNOWN}}"],
    ]);
    const main = `fn({ promptArgs: { KNOWN: k } });`;
    expect(findOrphanPlaceholders(prompts, main)).toEqual([
      { file: "one.md", placeholder: "MISSING" },
      { file: "two.md", placeholder: "MISSING" },
    ]);
  });

  it("sorts results by file then placeholder for stable output", () => {
    const prompts = new Map<string, string>([
      ["zebra.md", "{{ZULU}} {{ALPHA}}"],
      ["apple.md", "{{BRAVO}} {{ALPHA}}"],
    ]);
    const main = `fn({ promptArgs: {} });`;
    expect(findOrphanPlaceholders(prompts, main)).toEqual([
      { file: "apple.md", placeholder: "ALPHA" },
      { file: "apple.md", placeholder: "BRAVO" },
      { file: "zebra.md", placeholder: "ALPHA" },
      { file: "zebra.md", placeholder: "ZULU" },
    ]);
  });

  // Hard backstop: the live, shipped codebase must always pass this lint —
  // otherwise the next sandcastle launch crashes at iteration 1.
  it("passes against the live .sandcastle/ prompts and main.mts", () => {
    const sandcastleDir = join(process.cwd(), ".sandcastle");
    const mainSource = readFileSync(join(sandcastleDir, "main.mts"), "utf8");
    const prompts = new Map<string, string>();
    for (const entry of readdirSync(sandcastleDir)) {
      if (!entry.endsWith(".md")) continue;
      const abs = join(sandcastleDir, entry);
      if (!statSync(abs).isFile()) continue;
      prompts.set(abs, readFileSync(abs, "utf8"));
    }
    const variantsDir = join(sandcastleDir, "variants");
    if (existsSync(variantsDir) && statSync(variantsDir).isDirectory()) {
      for (const variant of readdirSync(variantsDir)) {
        const overridesDir = join(variantsDir, variant, "overrides");
        if (!existsSync(overridesDir) || !statSync(overridesDir).isDirectory()) continue;
        for (const entry of readdirSync(overridesDir)) {
          if (!entry.endsWith(".md")) continue;
          const abs = join(overridesDir, entry);
          if (!statSync(abs).isFile()) continue;
          prompts.set(abs, readFileSync(abs, "utf8"));
        }
      }
    }
    expect(findOrphanPlaceholders(prompts, mainSource)).toEqual([]);
  });
});
