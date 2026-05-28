#!/usr/bin/env tsx

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { assembleVariant, findMarkerNames } from "../lib/variant-assembly.js";

function usage(): never {
  console.error("usage: tsx .sandcastle/scripts/assemble-variant.mts <variant-name>");
  process.exit(1);
}

function fail(msg: string): never {
  console.error(`assemble-variant: ${msg}`);
  process.exit(1);
}

function loadOverrides(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dir)) return map;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const abs = join(dir, entry);
    if (!statSync(abs).isFile()) continue;
    const name = basename(entry, ".md");
    let content = readFileSync(abs, "utf8");
    if (content.endsWith("\n")) content = content.slice(0, -1);
    map.set(name, content);
  }
  return map;
}

function listBasePrompts(sandcastleDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(sandcastleDir)) {
    if (!entry.endsWith(".md")) continue;
    const abs = join(sandcastleDir, entry);
    if (!statSync(abs).isFile()) continue;
    out.push(abs);
  }
  return out;
}

function atomicWrite(target: string, content: string): void {
  const tmp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function main(): void {
  const variant = process.argv[2];
  if (!variant) usage();

  const repoRoot = process.cwd();
  const sandcastleDir = join(repoRoot, ".sandcastle");
  if (!existsSync(sandcastleDir)) {
    fail(`no .sandcastle/ directory found in ${repoRoot} — run from repo root`);
  }

  const variantDir = join(sandcastleDir, "variants", variant);
  if (!existsSync(variantDir) || !statSync(variantDir).isDirectory()) {
    fail(`variant directory not found: .sandcastle/variants/${variant}/`);
  }

  const overridesDir = join(variantDir, "overrides");
  const overrides = loadOverrides(overridesDir);

  const basePrompts = listBasePrompts(sandcastleDir);
  const seenMarkers = new Set<string>();
  let appliedCount = 0;

  for (const abs of basePrompts) {
    const original = readFileSync(abs, "utf8");
    const markers = findMarkerNames(original);
    for (const m of markers) seenMarkers.add(m);

    const overridesForThisFile = new Map<string, string>();
    for (const name of markers) {
      if (overrides.has(name)) {
        overridesForThisFile.set(name, overrides.get(name) as string);
        appliedCount++;
      }
    }

    if (overridesForThisFile.size === 0) continue;

    const assembled = assembleVariant(original, overridesForThisFile);
    if (assembled === original) continue;
    atomicWrite(abs, assembled);
  }

  let warnings = 0;
  for (const key of overrides.keys()) {
    if (!seenMarkers.has(key)) {
      console.error(
        `assemble-variant: override file overrides/${key}.md has no matching <!-- variant:${key} --> marker in any base prompt — ignoring`,
      );
      warnings++;
    }
  }

  console.log(
    `assembled prompts for variant ${variant}: ${basePrompts.length} base files processed, ${appliedCount} overrides applied, ${warnings} warnings`,
  );
}

main();
