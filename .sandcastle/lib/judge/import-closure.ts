/**
 * WHAT A CHECK ACTUALLY PULLS IN — the derivation behind the first test's
 * frozen set (`check-freeze.ts`, issue #1118). Under `lib/judge/` for the
 * reason `check-freeze.ts`'s header gives; no judge reads it.
 *
 * ## Why this module exists rather than a hand-written list
 *
 * `checkFreezePathsFor` used to be a hand-maintained array of paths, and it was
 * wrong in the way a hand-maintained array is always eventually wrong: it froze
 * `apps/nextjs/e2e/lib/graded-screen-check.ts` and called it "where the grading
 * itself lives", when that file imports its verdict from
 * `apps/nextjs/src/lib/screen-check/graded-text.ts` — a nine-line string
 * comparison that was frozen nowhere and named nowhere. One line there
 * returning a match makes EVERY graded check in the repository pass with the
 * check's own bytes untouched, so layer 1's restore is satisfied and the drift
 * detector stays silent.
 *
 * A list that has to be kept in step with the imports by hand is how that
 * happened, and it is how the next one would happen. So the set is DERIVED: a
 * check's own module graph is walked, and every file it reaches is either
 * frozen or falls in a region this repository names as deliberately exposed.
 * Nothing is listed because somebody remembered it.
 *
 * ## What the walk can and cannot see, stated rather than assumed
 *
 * Static text, and only static text. It reads `import`/`export ... from`,
 * `require(...)`, `import(...)`, and any RELATIVE string literal (which is what
 * a runner config's `globalSetup`/`setupFiles` entry looks like). Three things
 * it therefore cannot see, each covered by keeping the runner's own entry
 * points as fixed SEEDS rather than deriving them:
 *
 *   - a path COMPUTED rather than written — `apps/nextjs/playwright.config.ts`
 *     writes `path.join(__dirname, "e2e", "global-setup.ts")`, which no text
 *     scan resolves;
 *   - a bare specifier that resolves through a workspace alias (`@acme/db`) or
 *     a tsconfig path mapping;
 *   - anything loaded at runtime by name.
 *
 * Bare specifiers are returned separately rather than dropped, so a caller (and
 * `check-freeze.test.ts`) can assert that every one of them is a package or a
 * workspace import that this repository has deliberately left outside the
 * freeze, instead of discovering later that a grading decision moved into one.
 *
 * Pure apart from reading files. Never throws: an unreadable file contributes
 * no edges, which narrows the derived set rather than corrupting it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Extensions a relative specifier may resolve to, in the order tried. */
const RESOLVE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.js",
] as const;

/** Files worth reading for edges. Anything else is a leaf. */
const READABLE_RE = /\.(?:[cm]?[jt]sx?)$/;

export interface ImportClosure {
  /**
   * Every repo-relative file reached that the caller's `inRegion` predicate
   * accepted, sorted. The seeds themselves are included when they exist.
   */
  readonly inside: readonly string[];
  /**
   * Every repo-relative file reached that `inRegion` REJECTED, sorted. These
   * are the honest exposures — product code the check reads, seed scripts,
   * fixtures outside the instrument — and they are reported rather than
   * silently discarded so a test can assert what they are.
   */
  readonly outside: readonly string[];
  /**
   * Every non-relative specifier reached, sorted and de-duplicated:
   * `@playwright/test`, `@acme/db`, `node:path`. Not resolved, never frozen.
   */
  readonly bare: readonly string[];
}

function isFile(abs: string): boolean {
  try {
    return existsSync(abs) && statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve one relative specifier written in `fromRel` to a repo-relative path,
 * or `undefined` when nothing on disk answers to it.
 *
 * A `.js` specifier is also tried as its TypeScript source: this repository's
 * own ESM modules import each other that way, and resolving only the literal
 * text would walk off the graph at the first hop.
 */
export function resolveRelativeImport(
  worktreePath: string,
  fromRel: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.join(path.dirname(path.join(worktreePath, fromRel)), specifier);
  const candidates = [
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...(base.endsWith(".js")
      ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`]
      : []),
  ];
  for (const abs of candidates) {
    if (!isFile(abs)) continue;
    const rel = path.relative(worktreePath, abs);
    // Never leave the repository. A `../../..` specifier that climbs out is a
    // fact about the machine, not about the check.
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join("/");
  }
  return undefined;
}

/**
 * Every specifier written in one file's text: the import forms, plus every
 * relative string literal (a runner config names its setup files that way).
 */
export function specifiersIn(source: string): readonly string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"'\n]+)["']/g,
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\bimport\s+["']([^"'\n]+)["']/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      if (m[1] !== undefined) found.add(m[1]);
    }
  }
  // Config entries — `globalSetup: "./e2e/global-setup.ts"`, `setupFiles: [...]`
  // — are plain strings and no import pattern matches them. Every relative
  // literal is offered to the resolver; the ones that name nothing on disk
  // resolve to `undefined` and cost nothing.
  for (const m of source.matchAll(/["']((?:\.\.?\/)[^"'\n]*)["']/g)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found];
}

/**
 * Walk the module graph from `seeds` and split everything it reaches.
 *
 * Traversal continues only THROUGH files `inRegion` accepts. That boundary is
 * the whole point: a check imports the product code it is testing, and freezing
 * the subject would put the builder's own work back on disk before every graded
 * run and leave the break test with nothing left to break. So the instrument is
 * followed and the subject is recorded and left alone.
 *
 * ## A SEED IS ALWAYS INSIDE, AND IT IS THE CALLER THAT SAYS SO
 *
 * Seeds used to be put through the same region test as everything the walk
 * discovered, and that quietly reintroduced the stale-list fault this module
 * was written to end. `apps/nextjs/playwright.config.ts` matches neither
 * browser prefix in `isCheckInstrumentPath`, so it was classified OUTSIDE and
 * never queued — while `checkFreezeDerivation` froze it anyway, because it is a
 * seed. The frozen set therefore held a file whose own imports nothing had
 * walked. Nothing is missed today only because that config's single relative
 * literal is `"./e2e"`, a directory; a custom reporter, fixture or helper added
 * beside it would have been frozen-but-unfollowed, and its own imports silently
 * unfrozen.
 *
 * A seed is not a discovery. It is the caller naming an entry point it has
 * already decided is part of the instrument, so the region test has nothing to
 * say about it — it is followed, and what it reaches is split by `inRegion` as
 * usual.
 */
export function importClosure(
  worktreePath: string,
  seeds: readonly string[],
  inRegion: (relPath: string) => boolean,
): ImportClosure {
  const inside = new Set<string>();
  const outside = new Set<string>();
  const bare = new Set<string>();
  const queue: string[] = [];
  const seen = new Set<string>();

  const offer = (rel: string, isSeed = false): void => {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (!isSeed && !inRegion(rel)) {
      outside.add(rel);
      return;
    }
    inside.add(rel);
    queue.push(rel);
  };

  for (const seed of seeds) {
    if (isFile(path.join(worktreePath, seed))) offer(seed, true);
  }

  while (queue.length > 0) {
    const rel = queue.shift();
    if (rel === undefined) continue;
    if (!READABLE_RE.test(rel)) continue;
    let source: string;
    try {
      source = readFileSync(path.join(worktreePath, rel), "utf8");
    } catch {
      continue;
    }
    for (const specifier of specifiersIn(source)) {
      if (!specifier.startsWith(".")) {
        // A bare specifier written in an import position. A relative-looking
        // literal that is not one (a URL, a CSS class) never reaches here.
        if (/^(?:@|[a-z])/i.test(specifier)) bare.add(specifier);
        continue;
      }
      const target = resolveRelativeImport(worktreePath, rel, specifier);
      if (target !== undefined) offer(target);
    }
  }

  const sorted = (s: Set<string>): readonly string[] => [...s].sort();
  return { inside: sorted(inside), outside: sorted(outside), bare: sorted(bare) };
}
