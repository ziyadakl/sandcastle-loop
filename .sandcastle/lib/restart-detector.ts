import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const TRACKED_TOP_LEVEL = [
  ".sandcastle/main.mts",
  ".sandcastle/models.ts",
  ".sandcastle/providers.ts",
];

const TRACKED_DIR = ".sandcastle/lib";

function walkTs(absDir: string, out: string[]): void {
  if (!existsSync(absDir)) return;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      walkTs(abs, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(abs);
    }
  }
}

function trackedAbsPaths(repoRoot: string): string[] {
  const out: string[] = [];
  for (const rel of TRACKED_TOP_LEVEL) {
    out.push(join(repoRoot, rel));
  }
  walkTs(join(repoRoot, TRACKED_DIR), out);
  return out;
}

function hashOrEmpty(abs: string): string {
  try {
    const buf = readFileSync(abs);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return ""; // file missing — record as empty so deletion shows up as change
  }
}

export function snapshotImportedFiles(repoRoot: string): Map<string, string> {
  const snap = new Map<string, string>();
  for (const abs of trackedAbsPaths(repoRoot)) {
    snap.set(relative(repoRoot, abs), hashOrEmpty(abs));
  }
  return snap;
}

export function detectImportedFileChange(
  repoRoot: string,
  snapshot: Map<string, string>,
): string | null {
  // Check every previously-snapshotted file for a hash change or deletion.
  for (const [rel, prevHash] of snapshot) {
    const nowHash = hashOrEmpty(join(repoRoot, rel));
    if (nowHash !== prevHash) return rel;
  }
  // Also catch newly-added tracked files (e.g. a new lib/ module).
  const currentRel = new Set(
    trackedAbsPaths(repoRoot).map((abs) => relative(repoRoot, abs)),
  );
  for (const rel of currentRel) {
    if (!snapshot.has(rel)) return rel;
  }
  return null;
}
