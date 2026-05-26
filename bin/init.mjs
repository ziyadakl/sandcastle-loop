#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const TEMPLATE_ROOT = resolve(PACKAGE_ROOT, ".sandcastle");
const TARGET_ROOT = process.cwd();

const EXCLUDE = new Set(["logs"]);
const WANTED_DEPS = [
  "@ai-hero/sandcastle",
  "tsx",
  "proper-lockfile",
  "@types/proper-lockfile",
  "zod",
];

function fail(msg) {
  console.error(`sandcastle-loop init: ${msg}`);
  process.exit(1);
}

function isExcluded(name) {
  if (EXCLUDE.has(name)) return true;
  if (name.endsWith(".bak")) return true;
  if (name.includes(".bak-")) return true;
  return false;
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (isExcluded(entry)) continue;
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

function loadDevDepVersions() {
  const pkg = JSON.parse(
    readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  const out = {};
  for (const name of WANTED_DEPS) {
    const v = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name];
    if (v) out[name] = v;
  }
  return out;
}

function injectIntoProjectPackageJson() {
  const projPkgPath = resolve(TARGET_ROOT, "package.json");
  const projPkg = JSON.parse(readFileSync(projPkgPath, "utf8"));

  projPkg.scripts = projPkg.scripts ?? {};
  projPkg.scripts.sandcastle = "bash .sandcastle/sandcastle-wrapper.sh";

  projPkg.devDependencies = projPkg.devDependencies ?? {};
  const versions = loadDevDepVersions();
  let added = 0;
  for (const [name, version] of Object.entries(versions)) {
    if (!projPkg.devDependencies[name] && !projPkg.dependencies?.[name]) {
      projPkg.devDependencies[name] = version;
      added++;
    }
  }

  // Sort alphabetically — many project linters (sherif, etc.) require it.
  projPkg.devDependencies = Object.fromEntries(
    Object.entries(projPkg.devDependencies).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );

  writeFileSync(projPkgPath, JSON.stringify(projPkg, null, 2) + "\n");
  return added;
}

function main() {
  const sub = process.argv[2];
  if (sub && sub !== "init") {
    fail(`unknown subcommand "${sub}". Only \`init\` is supported.`);
  }

  if (!existsSync(resolve(TARGET_ROOT, "package.json"))) {
    fail("no package.json in current directory — is this a Node project?");
  }
  if (existsSync(resolve(TARGET_ROOT, ".sandcastle"))) {
    fail(".sandcastle/ already exists. Remove it to re-init.");
  }

  copyDir(TEMPLATE_ROOT, resolve(TARGET_ROOT, ".sandcastle"));
  const addedDeps = injectIntoProjectPackageJson();

  console.log("- Copied template files to .sandcastle/");
  console.log("- Added 'sandcastle' script to package.json");
  if (addedDeps > 0) {
    console.log(`- Added ${addedDeps} devDependencies to package.json`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  1. pnpm install");
  console.log("  2. pnpm sandcastle --iterations 50 --max-concurrent 2 --branch <feature>");
}

main();
