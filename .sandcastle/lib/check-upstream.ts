/**
 * check-upstream helpers.
 *
 * Pure logic for the `pnpm sandcastle:check-upstream` script: work out exactly
 * which `@ai-hero/sandcastle` symbols this repo depends on, and compare the
 * pinned engine version against a fetched "latest". The script
 * (../scripts/check-upstream.mts) does the I/O (read package.json, walk source,
 * fetch the npm registry); everything testable lives here.
 *
 * Why this exists: this repo is a heavily-customized fork with no shared git
 * lineage with upstream, so the useful question on every release is "what
 * changed upstream that touches US?". This narrows the upstream changelog from
 * "read all of it" to "search it for these N symbols" — the surface this repo
 * actually calls. See docs/superpowers/plans for the engine-bump that motivated
 * it.
 */

export interface SdkUsage {
  /** Named/destructured imports, e.g. `run`, `createSandbox`, `SandboxHooks`. */
  readonly symbols: readonly string[];
  /** Subpath entrypoints imported, e.g. `sandboxes/docker`. */
  readonly subpaths: readonly string[];
  /** Files (as keyed by the caller) that import from the SDK. */
  readonly files: readonly string[];
}

/**
 * Extract every `@ai-hero/sandcastle` symbol/subpath the given files use.
 * Handles named imports (`import { a, type B } from "..."`), namespace imports
 * (`import * as s from "..."` followed by `s.x` member access), and subpath
 * imports (`from ".../sandboxes/docker"`). Best-effort regex parse — good
 * enough to produce a changelog-search checklist, not a type checker.
 */
export function extractSdkUsage(files: ReadonlyMap<string, string>): SdkUsage {
  const symbols = new Set<string>();
  const subpaths = new Set<string>();
  const usingFiles = new Set<string>();

  // group1 = optional leading `type `, group2 = namespace alias,
  // group3 = `{ ... }` named list, group4 = optional `/subpath`.
  const importRe =
    /import\s+(type\s+)?(?:\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+["']@ai-hero\/sandcastle(\/[^"']*)?["']/g;

  for (const [path, content] of files) {
    importRe.lastIndex = 0;
    const namespaceAliases: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      usingFiles.add(path);
      const nsAlias = m[2];
      const named = m[3];
      const subpath = m[4];
      if (subpath !== undefined && subpath !== "") {
        subpaths.add(subpath.replace(/^\//, ""));
      }
      if (nsAlias !== undefined) namespaceAliases.push(nsAlias);
      if (named !== undefined) {
        for (const raw of named.split(",")) {
          const name = raw.replace(/\btype\s+/, "").trim();
          if (name.length > 0) symbols.add(name);
        }
      }
    }
    // Namespace import: collect `<alias>.<member>` accesses as used symbols.
    for (const alias of namespaceAliases) {
      const memberRe = new RegExp(`\\b${alias}\\.([A-Za-z_]\\w*)`, "g");
      let mm: RegExpExecArray | null;
      while ((mm = memberRe.exec(content)) !== null) {
        symbols.add(mm[1]!);
      }
    }
  }

  return {
    symbols: [...symbols].sort(),
    subpaths: [...subpaths].sort(),
    files: [...usingFiles].sort(),
  };
}

/** Parse "x.y.z" into a numeric tuple, ignoring any range prefix (`^`, `~`, …). */
export function parseVersion(v: string): readonly [number, number, number] {
  const cleaned = v.trim().replace(/^[\^~>=<\s]+/, "");
  const parts = cleaned.split(".").map((n) => parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** True when `latest` is a strictly higher version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return false;
}
