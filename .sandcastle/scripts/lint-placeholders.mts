#!/usr/bin/env tsx

/**
 * Pre-launch placeholder lint — walk every prompt file and refuse to
 * ship if any contains a `{{IDENT}}` that has no matching key in any
 * `promptArgs:` literal in main.mts. Wire-up: `pnpm sandcastle:lint`.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { findOrphanPlaceholders } from "../lib/lint-placeholders.js";

function fail(msg: string): never {
  console.error(`sandcastle:lint: ${msg}`);
  process.exit(1);
}

function collectPromptFiles(sandcastleDir: string): Map<string, string> {
  const files = new Map<string, string>();
  // Base prompts: .sandcastle/*-prompt.md (plus other top-level *.md prompts
  // — e.g. plan-prompt.md, merge-prompt.md, recovery-prompt.md, etc.).
  for (const entry of readdirSync(sandcastleDir)) {
    if (!entry.endsWith(".md")) continue;
    const abs = join(sandcastleDir, entry);
    if (!statSync(abs).isFile()) continue;
    files.set(abs, readFileSync(abs, "utf8"));
  }
  // Variant overrides: .sandcastle/variants/*/overrides/*.md. These can
  // introduce new placeholders that don't appear in the base, so the
  // lint must scan them too.
  const variantsDir = join(sandcastleDir, "variants");
  if (existsSync(variantsDir) && statSync(variantsDir).isDirectory()) {
    for (const variant of readdirSync(variantsDir)) {
      const overridesDir = join(variantsDir, variant, "overrides");
      if (!existsSync(overridesDir) || !statSync(overridesDir).isDirectory()) continue;
      for (const entry of readdirSync(overridesDir)) {
        if (!entry.endsWith(".md")) continue;
        const abs = join(overridesDir, entry);
        if (!statSync(abs).isFile()) continue;
        files.set(abs, readFileSync(abs, "utf8"));
      }
    }
  }
  return files;
}

function main(): void {
  const repoRoot = process.cwd();
  const sandcastleDir = join(repoRoot, ".sandcastle");
  if (!existsSync(sandcastleDir)) {
    fail(`no .sandcastle/ directory found in ${repoRoot} — run from repo root`);
  }
  const mainPath = join(sandcastleDir, "main.mts");
  if (!existsSync(mainPath)) {
    fail(`expected .sandcastle/main.mts not found at ${mainPath}`);
  }
  const mainSource = readFileSync(mainPath, "utf8");
  const promptFiles = collectPromptFiles(sandcastleDir);

  const orphans = findOrphanPlaceholders(promptFiles, mainSource);
  if (orphans.length === 0) {
    console.log(
      `sandcastle:lint: ${promptFiles.size} prompt files scanned, no orphan placeholders`,
    );
    return;
  }
  console.error(
    `sandcastle:lint: ${orphans.length} orphan placeholder(s) — these {{IDENT}} ` +
      `tokens appear in a prompt but have no matching key in any promptArgs literal:`,
  );
  for (const { file, placeholder } of orphans) {
    console.error(`  ${file}: {{${placeholder}}}`);
  }
  process.exit(1);
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg);
}
