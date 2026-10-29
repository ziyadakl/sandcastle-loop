/**
 * Resolves changed repo-relative file paths to the pnpm workspace packages
 * that own them, so a host-side test gate can run ONLY the affected
 * packages' tests instead of the whole repo suite.
 *
 * WHY IT LIVES HERE: it sits beside `../paths/glob.ts`, whose matcher it
 * reuses to confirm each candidate directory against the workspace's glob
 * patterns — this module owns the pnpm-workspace.yaml parsing and the
 * filesystem walk, not glob semantics. It stays dependency-free (node
 * builtins + the repo's own glob module only) because the whole point is to
 * run BEFORE the target packages' own `node_modules` (and any yaml package
 * inside them) can be trusted to exist.
 *
 * Every IO path here is fail-quiet, same philosophy as `hasTestScript` /
 * `reviewDiffStats` elsewhere in `.sandcastle/lib`: a missing workspace file,
 * a malformed manifest, or an unreadable directory must never throw out of
 * discovery. Fail-quiet is safe here ONLY because the caller can tell the two
 * empty cases apart — {@link TestScope.workspaceDiscovered} reports how many
 * packages discovery actually found, so "the workspace didn't parse" (0 found,
 * an INCONCLUSIVE gate) never gets mistaken for "this diff touched no package"
 * (packages found, none matched — a genuinely dormant gate). Collapsing those
 * two into one empty list is exactly how a gate silently switches itself off.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { pathMatchesGlob } from "../paths/glob.js";

/** One workspace package discovered on disk. `dir` is repo-relative, POSIX-separated, no trailing slash. */
export interface WorkspacePackage {
  readonly dir: string;
  /** The package.json `name`, e.g. "@acme/api". Empty string when the manifest has no name. */
  readonly name: string;
  /** Does this package define a non-empty `test` script? */
  readonly hasTestScript: boolean;
}

/**
 * Pure: extract the `packages:` glob list from a pnpm-workspace.yaml document.
 *
 * Hand-rolled instead of a yaml dependency, because this module has to stay
 * loadable before any package's `node_modules` is trustworthy (see module
 * comment). Only the shape pnpm-workspace.yaml actually uses is supported: a
 * top-level `packages:` key followed by a block sequence of `  - <glob>`
 * lines, terminated by the next non-indented, non-comment, non-`-` line (the
 * next top-level key, e.g. `catalog:`).
 *
 * Negated globs (`!foo`) are silently DROPPED rather than honoured as
 * exclusions. That is deliberately safe in this direction only: a package
 * list that is too BROAD can only make {@link discoverWorkspacePackages} find
 * an extra package (which at worst runs an extra test suite upstream); a list
 * that is too NARROW could make it miss a package's tests entirely. Dropping
 * `!` silently keeps the list on the broad side.
 */
export function parseWorkspacePackageGlobs(yamlText: string): string[] {
  const lines = yamlText.split(/\r?\n/);
  const globs: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inPackages) {
      if (/^packages:\s*(#.*)?$/.test(trimmed)) inPackages = true;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // Any top-level (non-indented) line that isn't blank/comment ends the
    // `packages:` block-sequence — it's the next key in the document.
    if (!/^\s/.test(line)) break;
    const item = /^-\s*(.+?)\s*$/.exec(trimmed);
    if (!item) break;
    let glob = item[1];
    // Strip a trailing inline comment (` # ...`) before unquoting.
    const commentIdx = glob.search(/\s+#/);
    if (commentIdx !== -1) glob = glob.slice(0, commentIdx).trim();
    if (
      (glob.startsWith('"') && glob.endsWith('"')) ||
      (glob.startsWith("'") && glob.endsWith("'"))
    ) {
      glob = glob.slice(1, -1);
    }
    if (glob.startsWith("!")) continue; // see doc comment: dropped, not honoured
    if (glob.length > 0) globs.push(glob);
  }
  return globs;
}

/**
 * Pure: longest-prefix match of a repo-relative file path to one of
 * `packageDirs`. Longest wins so nested workspace packages (legal in pnpm)
 * resolve to the innermost owner. Matching is on a full path SEGMENT boundary
 * — `packages/ui` must not match `packages/ui-kit/x.ts` — otherwise a
 * same-prefix sibling package would steal another package's changed files and
 * either skip its tests or run the wrong ones.
 */
export function matchPathToPackageDir(
  filePath: string,
  packageDirs: readonly string[],
): string | null {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  let best: string | null = null;
  for (const dir of packageDirs) {
    const matches =
      dir === ""
        ? true
        : normalized === dir || normalized.startsWith(`${dir}/`);
    if (!matches) continue;
    if (best === null || dir.length > best.length) best = dir;
  }
  return best;
}

const WALK_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);
const MAX_WALK_DEPTH = 4;

/**
 * THE predicate for "this manifest defines a runnable test script" — a
 * non-empty string `scripts.test`.
 *
 * Takes a PARSED manifest rather than a path so both callers can share it
 * despite reading their manifests differently: `hasTestScript` in `main.mts`
 * (the cert gate's dormancy, repo-root only) and
 * {@link discoverWorkspacePackages} (per workspace package). Those were
 * byte-identical re-derivations, which meant two definitions of the same word
 * gating one ticket at two layers — the cert gate could go dormant while the
 * verification gate considered the package testable, or the reverse.
 */
export function manifestHasTestScript(manifest: {
  scripts?: Record<string, unknown>;
}): boolean {
  const test = manifest.scripts?.test;
  return typeof test === "string" && test.trim().length > 0;
}

/** Read and JSON-parse a package.json at `<root>/<dir>/package.json`; `null` on any failure (fail-quiet, see module comment). */
function readPackageManifest(
  root: string,
  dir: string,
): { name?: unknown; scripts?: Record<string, unknown> } | null {
  try {
    const raw = readFileSync(path.join(root, dir, "package.json"), "utf8");
    return JSON.parse(raw) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

/** Fail-quiet directory listing: unreadable/missing dirs read as "no entries" so a walk never throws. */
function listDirs(absDir: string): string[] {
  try {
    return readdirSync(absDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Candidate repo-relative directories for one workspace glob. Handles the two
 * shapes pnpm-workspace.yaml globs actually take in this repo (`apps/*`,
 * `packages/*`, literal dirs) plus a bounded `**` fallback for anything more
 * exotic, so a future glob addition degrades to "search a bit harder" instead
 * of "silently discover nothing".
 */
function candidateDirsForGlob(root: string, glob: string): string[] {
  if (glob.includes("**")) {
    // Bounded recursive walk — depth-capped and skipping build/vcs/hidden
    // dirs so an unexpected `**` glob can't turn discovery into a full
    // repo crawl.
    const out: string[] = [];
    const walk = (relDir: string, depth: number) => {
      if (depth > MAX_WALK_DEPTH) return;
      out.push(relDir);
      for (const name of listDirs(path.join(root, relDir))) {
        if (WALK_SKIP_DIRS.has(name)) continue;
        walk(relDir === "" ? name : `${relDir}/${name}`, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }

  const segments = glob.split("/");
  const starIdx = segments.indexOf("*");
  if (starIdx === -1) {
    // No wildcard: the literal path is the only candidate.
    return [glob];
  }
  const baseSegments = segments.slice(0, starIdx);
  const base = baseSegments.join("/");
  const trailingSegments = segments.slice(starIdx + 1);
  if (trailingSegments.length > 0) {
    // A `*` followed by more literal segments (e.g. `packages/*/src`). Probe
    // the one level under `base` and re-attach the trailing literals, rather
    // than falling back to the `**` walk — the walk is depth-capped and much
    // more expensive, and this shape needs exactly one level of expansion.
    return listDirs(path.join(root, base)).map((name) =>
      [base, name, ...trailingSegments].filter(Boolean).join("/"),
    );
  }
  return listDirs(path.join(root, base)).map((name) =>
    base === "" ? name : `${base}/${name}`,
  );
}

/**
 * IO: enumerate the workspace packages under `root`. Fail-quiet — returns `[]`
 * when the workspace file is missing/unreadable/has no globs, rather than
 * throwing out of the gate that calls it. An empty return is NOT "nothing to
 * test": it is "we could not tell", and {@link resolveTestScope} preserves that
 * distinction for the gate via `workspaceDiscovered`.
 */
export function discoverWorkspacePackages(root: string): WorkspacePackage[] {
  let yamlText: string;
  try {
    yamlText = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const globs = parseWorkspacePackageGlobs(yamlText);
  const byDir = new Map<string, WorkspacePackage>();
  for (const glob of globs) {
    for (const dir of candidateDirsForGlob(root, glob)) {
      if (byDir.has(dir)) continue;
      if (!pathMatchesGlob(dir, glob)) continue;
      const manifest = readPackageManifest(root, dir);
      if (manifest === null) continue;
      const name = typeof manifest.name === "string" ? manifest.name : "";
      byDir.set(dir, {
        dir,
        name,
        hasTestScript: manifestHasTestScript(manifest),
      });
    }
  }
  return [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

export interface TestScope {
  /** Packages that own a changed path AND define a `test` script — the ones to run. */
  readonly packages: readonly WorkspacePackage[];
  /** Packages that own a changed path but define NO `test` script — nothing to run there. Repo-relative dirs. */
  readonly skipped: readonly string[];
  /** Changed paths that belong to no workspace package (root configs, docs, .sandcastle/, …). */
  readonly unresolved: readonly string[];
  /**
   * How many packages {@link discoverWorkspacePackages} found AT ALL, before
   * any path matching. The gate needs this to separate `0` (discovery failed —
   * unreadable workspace file, unparseable globs; the gate must report
   * INCONCLUSIVE and NOT ship on the strength of an unverified claim) from a
   * non-zero count with an empty `packages` (a docs-only diff — genuinely
   * dormant). Both look like "nothing to run" from `packages` alone.
   */
  readonly workspaceDiscovered: number;
}

/**
 * IO: the whole resolution, `changedFiles` → {@link TestScope}. Order of
 * `packages` is deterministic (sorted by dir, inherited from
 * {@link discoverWorkspacePackages}) so a caller diffing two runs' scopes
 * never sees churn from iteration order alone.
 *
 * Renamed and binary paths need no special handling here: upstream
 * `reviewDiffStats` (`.sandcastle/lib/review/diff-measurement.ts`) already
 * calls `git diff` with `--no-renames -z`, so every entry this function
 * receives is always a single plain path — never a `{old => new}` rename
 * pair. Do not add rename handling on the strength of a future path that
 * looks like one; it cannot arrive from that caller.
 */
export function resolveTestScope(
  root: string,
  changedFiles: readonly string[],
): TestScope {
  const discovered = discoverWorkspacePackages(root);
  const packagesByDir = new Map(
    discovered.map((pkg) => [pkg.dir, pkg] as const),
  );
  const packageDirs = [...packagesByDir.keys()];

  const matchedDirs = new Set<string>();
  const unresolved: string[] = [];
  const seenChanged = new Set<string>();

  for (const file of changedFiles) {
    if (file === "" || seenChanged.has(file)) continue;
    seenChanged.add(file);
    const dir = matchPathToPackageDir(file, packageDirs);
    if (dir === null) {
      unresolved.push(file);
      continue;
    }
    matchedDirs.add(dir);
  }

  const packages: WorkspacePackage[] = [];
  const skipped: string[] = [];
  for (const dir of [...matchedDirs].sort((a, b) => a.localeCompare(b))) {
    const pkg = packagesByDir.get(dir);
    if (!pkg) continue; // unreachable: dir came from packageDirs itself
    if (pkg.hasTestScript) packages.push(pkg);
    else skipped.push(dir);
  }

  return {
    packages,
    skipped,
    unresolved,
    workspaceDiscovered: discovered.length,
  };
}
