#!/usr/bin/env tsx

/**
 * Upstream-watch report for `@ai-hero/sandcastle`. On a future release, run this
 * to learn (a) the pinned-vs-latest version, and (b) exactly which SDK symbols
 * this repo imports — so an upgrade starts from a targeted "search the changelog
 * for these names" checklist instead of a full read. Wire-up:
 * `pnpm sandcastle:check-upstream`.
 *
 * This runner does the I/O (read package.json, walk the source dirs, fetch the
 * npm registry); the testable parsing/version logic lives in
 * ../lib/check-upstream.ts. A network/parse failure degrades gracefully: the
 * local symbol inventory still prints and only the version check is skipped — it
 * never crashes.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  extractSdkUsage,
  isNewer,
  type SdkUsage,
} from "../lib/check-upstream.js";

const SDK_PACKAGE = "@ai-hero/sandcastle";
const REGISTRY = "https://registry.npmjs.org/@ai-hero/sandcastle";
const RELEASES_URL = "https://github.com/mattpocock/sandcastle/releases";
const SOURCE_DIRS = [".sandcastle", "src", "bin"];
const SOURCE_EXTS = [".ts", ".mts", ".mjs"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function fail(msg: string): never {
  console.error(`sandcastle:check-upstream: ${msg}`);
  process.exit(1);
}

/** Read the pinned SDK version from package.json at the given repo root. */
function readPinnedVersion(repoRoot: string): string {
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) {
    fail(`no package.json found at ${pkgPath} — run from repo root`);
  }
  let pkg: {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    fail(`could not parse ${pkgPath}: ${reason}`);
  }
  const pinned =
    pkg.devDependencies?.[SDK_PACKAGE] ?? pkg.dependencies?.[SDK_PACKAGE];
  if (pinned === undefined) {
    fail(
      `${SDK_PACKAGE} is not listed in dependencies or devDependencies of ${pkgPath}`,
    );
  }
  return pinned;
}

/** Recursively collect source files under `dir`, keyed by path relative to root. */
function collectSourceFiles(
  repoRoot: string,
  dir: string,
  files: Map<string, string>,
): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(repoRoot, join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTS.some((ext) => entry.name.endsWith(ext))) continue;
    const abs = join(dir, entry.name);
    files.set(relative(repoRoot, abs), readFileSync(abs, "utf8"));
  }
}

/** Fetch the latest dist-tag from the npm registry, or null on any failure. */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { "dist-tags"?: { latest?: string } };
    const latest = json["dist-tags"]?.latest;
    return typeof latest === "string" && latest.length > 0 ? latest : null;
  } catch {
    return null;
  }
}

function printReport(
  pinned: string,
  latest: string | null,
  usage: SdkUsage,
): void {
  console.log(`Package:  ${SDK_PACKAGE}`);
  console.log(`Pinned:   ${pinned}`);
  if (latest === null) {
    console.log(`Latest:   (version check failed — see above; offline?)`);
  } else if (isNewer(latest, pinned)) {
    console.log(`Latest:   ${latest}   ← newer available`);
  } else {
    console.log(`Latest:   ${latest}   (up to date)`);
  }
  console.log("");
  console.log(`SDK symbols used (${usage.symbols.length}):`);
  if (usage.symbols.length === 0) {
    console.log("  (none found)");
  } else {
    for (const sym of usage.symbols) console.log(`  ${sym}`);
  }
  console.log("");
  if (usage.subpaths.length > 0) {
    console.log(`Subpath entrypoints (${usage.subpaths.length}):`);
    for (const sub of usage.subpaths) console.log(`  ${SDK_PACKAGE}/${sub}`);
    console.log("");
  }
  console.log(`Files importing the SDK: ${usage.files.length}`);
  for (const f of usage.files) console.log(`  ${f}`);
  console.log("");
  console.log(`Scan the changelog for those names: ${RELEASES_URL}`);
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const pinned = readPinnedVersion(repoRoot);

  const files = new Map<string, string>();
  for (const dir of SOURCE_DIRS) {
    collectSourceFiles(repoRoot, join(repoRoot, dir), files);
  }
  const usage = extractSdkUsage(files);

  const latest = await fetchLatestVersion();
  if (latest === null) {
    console.error(
      `sandcastle:check-upstream: could not fetch latest version from ${REGISTRY} — ` +
        `reporting local inventory only`,
    );
  }

  printReport(pinned, latest, usage);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg);
});
