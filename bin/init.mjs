#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  copyFileSync,
  openSync,
  rmSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const TARGET_ROOT = process.cwd();

const REPO = "ziyadakl/sandcastle-loop";
const REF = "main";

const EXCLUDE = new Set(["logs"]);

// The loop passes container memory/pids/cgroup limits to `docker run`, which
// the published @ai-hero/sandcastle@0.12.0 does not support. This repo carries
// a pnpm patch that adds them; init copies it into the consumer and registers it.
const PATCH_FILE = "@ai-hero__sandcastle@0.12.0.patch";
const PATCH_KEY = "@ai-hero/sandcastle@0.12.0";
const WANTED_DEPS = [
  "@ai-hero/sandcastle",
  "tsx",
  "proper-lockfile",
  "@types/proper-lockfile",
  "zod",
  // UI trio for the `.sandcastle/watch/` viewer (sandcastle:watch).
  "ink",
  "react",
  "@types/react",
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

function withFetchedTemplate(fn) {
  const tmp = mkdtempSync(join(tmpdir(), "sandcastle-init-"));
  try {
    const tarball = join(tmp, "src.tar.gz");

    try {
      const fd = openSync(tarball, "w");
      execFileSync("gh", ["api", `repos/${REPO}/tarball/${REF}`], {
        stdio: ["ignore", fd, "inherit"],
      });
    } catch {
      execFileSync(
        "curl",
        ["-fsSL", `https://github.com/${REPO}/archive/${REF}.tar.gz`, "-o", tarball],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
    }

    execFileSync("tar", ["-xzf", tarball, "-C", tmp], { stdio: "inherit" });

    const extracted = readdirSync(tmp).find((n) =>
      n.startsWith("ziyadakl-sandcastle-loop-"),
    );
    if (!extracted) fail("fetched tarball did not contain expected top-level dir");

    const sandcastleSrc = join(tmp, extracted, ".sandcastle");
    if (!existsSync(join(sandcastleSrc, ".gitignore"))) {
      fail(
        "fetched tarball is missing .sandcastle/.gitignore — refusing to copy " +
          "(would silently land a broken init). Report this.",
      );
    }

    return fn(sandcastleSrc, join(tmp, extracted));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** "pnpm" | "npm" | "yarn" — from the packageManager field, else the lockfile. */
export function detectPackageManager(targetDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8"));
    const pm = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
    if (pm === "pnpm" || pm === "yarn" || pm === "npm") return pm;
  } catch {
    // fall through to the lockfile
  }
  if (existsSync(join(targetDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(targetDir, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Register the Docker-limits patch in `pnpm-workspace.yaml` (where pnpm 12
 * reads `patchedDependencies`). Adds the entry to an existing
 * `patchedDependencies:` block, or appends one. Idempotent.
 */
export function registerPnpmPatch(targetDir) {
  const file = join(targetDir, "pnpm-workspace.yaml");
  const entry = `  "${PATCH_KEY}": patches/${PATCH_FILE}`;
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.includes(PATCH_KEY)) return;
  let next;
  if (/^patchedDependencies:\s*$/m.test(text)) {
    next = text.replace(/^patchedDependencies:\s*$/m, `patchedDependencies:\n${entry}`);
  } else {
    next = (text === "" || text.endsWith("\n") ? text : text + "\n") +
      `patchedDependencies:\n${entry}\n`;
  }
  writeFileSync(file, next);
}

/**
 * Copy the patch into the consumer and, for pnpm, register it. Returns the
 * line to print.
 */
function installDockerLimitsPatch(templateRoot) {
  const pm = detectPackageManager(TARGET_ROOT);
  if (pm !== "pnpm") {
    return `- Note: ${pm} cannot apply pnpm patches, so container memory limits will not apply (use pnpm to enforce them)`;
  }
  const src = join(templateRoot, "patches", PATCH_FILE);
  if (!existsSync(src)) {
    return "- Note: the Docker-limits patch was missing from the template; container memory limits will not apply";
  }
  mkdirSync(resolve(TARGET_ROOT, "patches"), { recursive: true });
  copyFileSync(src, resolve(TARGET_ROOT, "patches", PATCH_FILE));
  registerPnpmPatch(TARGET_ROOT);
  return `- Added patches/${PATCH_FILE} and registered it in pnpm-workspace.yaml (container memory limits)`;
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
  projPkg.scripts["sandcastle:watch"] =
    "tsx .sandcastle/watch/sandcastle-watch.tsx";
  projPkg.scripts["sandcastle:check-upstream"] =
    "tsx .sandcastle/scripts/check-upstream.mts";

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

export function detectActiveProfile(targetDir) {
  const entries = readdirSync(targetDir);
  if (
    entries.some(
      (e) => e.endsWith(".xcodeproj") || e.endsWith(".xcworkspace"),
    )
  ) {
    return "mac-host";
  }
  if (existsSync(join(targetDir, "Package.swift"))) {
    return "mac-host";
  }
  return "minimal";
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

  let patchLine = "";
  withFetchedTemplate((src, templateRoot) => {
    copyDir(src, resolve(TARGET_ROOT, ".sandcastle"));
    patchLine = installDockerLimitsPatch(templateRoot);
  });
  const addedDeps = injectIntoProjectPackageJson();

  const profile = detectActiveProfile(TARGET_ROOT);
  const sandboxFlag = profile === "mac-host" ? "mac-host" : "docker";
  writeFileSync(
    resolve(TARGET_ROOT, ".sandcastle/.sandbox-flag"),
    sandboxFlag + "\n",
  );

  console.log("- Copied template files to .sandcastle/");
  console.log("- Added 'sandcastle' script to package.json");
  if (addedDeps > 0) {
    console.log(`- Added ${addedDeps} devDependencies to package.json`);
  }
  console.log(patchLine);
  console.log(`- Detected profile: ${profile} (sandbox: ${sandboxFlag})`);
  console.log(
    "- Optional: copy .sandcastle/project.example.json to .sandcastle/project.json and edit it",
  );
  console.log("");
  console.log("Next steps:");
  console.log("  1. pnpm install");
  console.log("  2. pnpm sandcastle --iterations 50 --max-concurrent 2 --branch <feature>");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
