/**
 * THE FIRST TEST'S LOCK (issue #1118; since spec #1334 used by the first
 * test's one rewrite and by every graded run, no longer by a judge): **the
 * check is frozen the moment it is accepted, and every grading run runs the
 * frozen copy.**
 *
 * ## Why this lives under `lib/judge/` with no judge left
 *
 * The judge was deleted by spec #1334; this file outlived it because the first
 * test still needs it. It stays at this path on purpose: the launch graft
 * sentinel (`GRAFT_SENTINEL_PATH`, `lib/hosts/launch.ts`) names
 * `lib/judge/check-freeze.ts` and checks that path in `origin/main`'s tree, so
 * moving the folder would make every host's self-heal refuse until the move
 * reached `main`. Move the folder and repoint the sentinel in one commit, and
 * only once that commit is on `main`.
 *
 * ## What this replaces, and why
 *
 * Three attempts at this feature tried to keep a repaired check honest by
 * HIDING the finished code from the agent that wrote it, then believing that
 * agent's own report that its proof had passed. Both halves were wrong. The
 * code was always one `git show HEAD:<path>` away, and an agent's report of
 * its own grade is the one thing that must never be read as a grade.
 *
 * The measured answer is the opposite shape. SWE-bench lets the agent read and
 * edit everything and then **destroys its edits to the test files at grading
 * time**, re-applying a canonical copy. A controlled experiment against that
 * harness (PrimeIntellect `verifiers` PR #1212) tampered seventeen test bodies
 * to `pass`: with the restore active the reward was 0.0; with it switched off,
 * 1.0. The restore is what carries the guarantee, and nothing an agent says
 * about itself is involved.
 *
 * So: the exact bytes of an accepted check are kept where no later agent
 * writes, and every graded run puts them back first. An in-place edit to the
 * check on disk — by the builder, by the reviewer, by a repair that skipped
 * the gate — cannot reach a grading run.
 *
 * ## Where the frozen copy lives
 *
 * In this process's memory, on the pipeline context. That is deliberately
 * stronger than a file: a dispatched agent runs in a sandbox with a filesystem
 * and a shell, and every path it can reach is a path it can write. It cannot
 * reach this. The cost is that a freeze does not survive the run being killed,
 * which is why every caller treats a MISSING freeze as "behave exactly as you
 * did before this existed" rather than as a failure.
 *
 * ## The setup and config files are frozen too, and the set is DERIVED
 *
 * SWE-bench's reset reverts only the files its own test patch names. Everything
 * else survives — a shared helper, the runner's config, a global setup file.
 * An agent that cannot edit the spec can still edit what runs the spec, which
 * is the same hole reached one step further out.
 *
 * That set used to be a hand-written array, and a hand-written array is how the
 * hole reopens. It froze `apps/nextjs/e2e/lib/graded-screen-check.ts` and called
 * it "where the grading itself lives"; that file imports its verdict from
 * `apps/nextjs/src/lib/screen-check/graded-text.ts`, a nine-line string
 * comparison nothing froze and nothing named. One line there returning a match
 * makes every graded check in the repository pass with the check's own bytes
 * untouched — the restore satisfied, the drift detector silent.
 *
 * So {@link checkFreezeDerivation} WALKS the check's own module graph and
 * freezes every instrument file it reaches. The only hand-written paths left
 * are the runner's entry points ({@link checkFreezeSeedsFor}), which no text
 * scan can derive because nothing imports them.
 *
 * What remains outside it is named honestly rather than papered over, and
 * reported as `exposed` rather than dropped: the product code the check is
 * testing (freezing the subject would leave the break test nothing to break),
 * `package.json` and the lockfile (the builder legitimately changes those, and
 * reverting one would break the very run this is protecting), `node_modules`,
 * the `.env` files, and the database. Those are covered — where they are
 * covered at all — by `lib/judge/replay-hazard.ts` refusing a repair outright
 * and by the mutant gate, rather than by a restore.
 *
 * ## The free cheat detector
 *
 * OpenAI's honeypot definition of test-tampering is computable from exactly the
 * copy already being kept: the tree passes as it stands, AND something fails
 * once the agent's edits to the check files are reverted.
 * {@link frozenCheckDrift} is the first half of that — it names every frozen
 * path whose bytes on disk no longer match what was accepted — and it costs one
 * `readFileSync` per frozen path.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { CheckLocation } from "../checkwriter/must-fail-first-receipt.js";
import type { RestoredPathOutcome } from "../paths/protected-path-restore.js";
import type { DirSnapshot } from "../paths/worktree-replay.js";
import { restoreDirFromSnapshot, snapshotDir } from "../paths/worktree-replay.js";
import { checksRoot } from "../checkwriter/check-path.js";
import { getProjectConfig } from "../project-config.js";
import { importClosure } from "./import-closure.js";

/**
 * The runner's own entry points, per runner — the SEEDS the derivation starts
 * from, and the only hand-written paths left in this module.
 *
 * They are hand-written because they are the three things a text scan provably
 * cannot derive: a runner's config is loaded by the runner rather than imported
 * by anything, a tsconfig decides how the check's imports resolve without being
 * imported itself, and `playwright.config.ts` names its global setup as
 * `path.join(__dirname, "e2e", "global-setup.ts")` — computed, not written.
 * Everything they reach is derived from their imports by
 * {@link checkFreezeDerivation}.
 *
 * A seed is listed even when it is ABSENT from disk, and that is deliberate:
 * the freeze records the absence and a restore reproduces it by DELETING the
 * file. A setup file the builder ADDS is a setup file it can use.
 */
/**
 * Where the browser runner lives, derived from `checksRoot`
 * (`<package>/e2e/checks`): the e2e folder is its parent, the package folder
 * the parent of that (`""` when the e2e folder sits at the repo root).
 */
function browserLayout(): { pkgDir: string; e2eDir: string; checks: string } {
  const checks = checksRoot();
  const e2eDir = path.posix.dirname(checks);
  const pkg = path.posix.dirname(e2eDir);
  return { pkgDir: pkg === "." ? "" : `${pkg}/`, e2eDir, checks };
}

export function checkFreezeSeedsFor(location: CheckLocation): readonly string[] {
  if (location.kind === "browser") {
    const { pkgDir, e2eDir, checks } = browserLayout();
    return [
      `${pkgDir}playwright.config.ts`,
      `${e2eDir}/tsconfig.json`,
      `${checks}/tsconfig.json`,
      `${e2eDir}/global-setup.ts`,
    ];
  }
  const pkg = unitPackageDirOf(location);
  return [
    // The project's shared runner config (`checkFreeze.unitSeeds`): e.g. a
    // base vitest config every package merges, which sets the `include` glob a
    // check has to match to run at all — widening it, or narrowing it past the
    // check, is a one-line way to change what a graded run does.
    ...getProjectConfig().checkFreeze.unitSeeds,
    ...(pkg === undefined
      ? []
      : [
          `${pkg}/vitest.config.ts`,
          `${pkg}/vitest.globalSetup.ts`,
          `${pkg}/vitest.setup.ts`,
          // `base.ts` runs `vite-tsconfig-paths`, so the host package's
          // tsconfig decides how the check's imports resolve.
          `${pkg}/tsconfig.json`,
        ]),
  ];
}

/**
 * The frozen tsconfig SEEDS for a check — the subset of {@link checkFreezeSeedsFor}
 * whose filename is `tsconfig.json`.
 *
 * These are the config files that decide how a check's imports RESOLVE and
 * which files are COLLECTED, and they are the ones `enforceProtectedPaths`
 * hands to `lib/paths/tsconfig-guard.ts`'s value-level guard at ship time
 * (issue #1135, MEDIUM 1). Derived from the seed list rather than hand-written
 * so it cannot drift from what is actually frozen: add a tsconfig seed above
 * and it is guarded here for free.
 *
 * `tooling/vitest/tsconfig.json` is in this set on the unit route AND is
 * already covered whole-file by the `tooling/vitest/**` protected glob; the
 * ship-time caller de-duplicates (`!violations.includes(...)`), so listing it
 * here costs nothing and keeps the derivation honest rather than special-casing
 * which tsconfigs a glob happens to also cover.
 */
export function frozenTsconfigSeedsFor(
  location: CheckLocation,
): readonly string[] {
  return checkFreezeSeedsFor(location).filter((p) =>
    p.endsWith("/tsconfig.json"),
  );
}

/**
 * THE INSTRUMENT REGION — which files a check reaches are part of the thing
 * that GRADES it, as opposed to the thing it is grading.
 *
 * The distinction is the whole of layer 1's boundary and it is not a
 * convenience. Freezing the SUBJECT would put the builder's own work back on
 * disk before every graded run and leave `lib/judge/mutants.ts` with nothing
 * left to revert — layer 3 would measure a tree it had just un-mutated. So the
 * walk follows the instrument and stops at the subject, and every file it
 * stopped at is reported (`exposed`) rather than dropped.
 *
 * For a BROWSER check the instrument is `apps/nextjs/e2e/**` — the runner's
 * config, its global setup, and the shared helpers checks import — together
 * with `apps/nextjs/src/lib/screen-check/**`, which is where the grading
 * DECISION actually lives. `graded-screen-check.ts` is a Playwright wrapper; it
 * imports its verdict from `graded-text.ts` and `claim-match.ts`, and a
 * one-line edit to either makes every graded check in the repository pass. That
 * directory holds nothing else: it is browser-free, product-free, pure
 * comparison, and no application route imports it.
 *
 * For a UNIT check the instrument is `tooling/vitest/**` plus the host
 * package's own runner config. A unit check is REQUIRED to import real product
 * code (`lib/checkwriter/unit-check-path.ts` refuses one that does not), so on
 * that route the subject begins one hop out and nothing beyond the config is
 * followed.
 */
export function isCheckInstrumentPath(
  location: CheckLocation,
  relPath: string,
): boolean {
  const underRoot = checkFreezeInstrumentRoots(location).some((root) =>
    relPath.startsWith(`${root}/`),
  );
  if (location.kind === "browser") return underRoot;
  const pkg = unitPackageDirOf(location);
  // The host package's own `vitest.*` files sit directly in the package dir
  // rather than under a dedicated instrument directory, so they are matched by
  // a file prefix here rather than a root in {@link checkFreezeInstrumentRoots}.
  return underRoot || (pkg !== undefined && relPath.startsWith(`${pkg}/vitest.`));
}

/**
 * The hard-coded instrument DIRECTORIES this module reverts by path — the
 * single source of truth behind both {@link isCheckInstrumentPath}'s directory
 * prefixes and the layout guard {@link assertCheckFreezeLayout}.
 *
 * For a BROWSER check that is the e2e tree (`apps/nextjs/e2e`) and the grading
 * library (`apps/nextjs/src/lib/screen-check`); for a UNIT check it is the
 * shared vitest config (`tooling/vitest`). These are paths, not derived from
 * imports, because nothing imports a runner's own tree — which is exactly why a
 * rename or restructure of them empties the freeze with nothing to notice. The
 * guard turns that silence into a thrown error.
 */
export function checkFreezeInstrumentRoots(
  location: CheckLocation,
): readonly string[] {
  const cfg = getProjectConfig().checkFreeze;
  if (location.kind === "browser") {
    return [browserLayout().e2eDir, ...cfg.browserRoots];
  }
  return [...cfg.unitRoots];
}

/**
 * Thrown when ANY of the hard-coded instrument directories
 * ({@link checkFreezeInstrumentRoots}) fails to resolve — the signal that the
 * repo layout this module freezes by path has moved out from under it.
 *
 * This is deliberately LOUD. A silently-empty (or silently-narrowed) freeze is
 * the dangerous outcome: the judge's grade-tamper protection (issue #1118)
 * reopens with grading files missing from the frozen set and nobody warned. A
 * throw is safe — the loop wraps each ticket in `Promise.allSettled` and rescues
 * a rejection, so this quarantines the one ticket instead of shipping an
 * ungraded repair.
 */
export class CheckFreezeLayoutError extends Error {
  constructor(location: CheckLocation, missing: readonly string[]) {
    super(
      `check-freeze could not resolve ${missing.length} of its instrument ` +
        `director${missing.length === 1 ? "y" : "ies"} for a ${location.kind} ` +
        `check (missing: ${missing.join(", ")}). This module freezes the judge's ` +
        `grading files by HARD-CODED path, so a rename or restructure of that ` +
        `layout would drop them from the freeze silently and reopen the ` +
        `grade-tamper protection with nobody warned. Update ` +
        `checkFreezeInstrumentRoots / checkFreezeSeedsFor in ` +
        `.sandcastle/lib/judge/check-freeze.ts to the new layout.`,
    );
    this.name = "CheckFreezeLayoutError";
  }
}

function instrumentRootResolves(worktreePath: string, root: string): boolean {
  try {
    return statSync(path.join(worktreePath, root)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fail loud when the hard-coded instrument layout has moved.
 *
 * An ABSENT single SEED is legitimate — the freeze records the absence and a
 * restore reproduces it by deleting the added file — so this does NOT throw on
 * any one missing seed FILE. What it demands is that every instrument DIRECTORY
 * for this kind of check resolves: for a browser check both `apps/nextjs/e2e`
 * AND `apps/nextjs/src/lib/screen-check` (the grading-DECISION tree), for a unit
 * check `tooling/vitest`.
 *
 * FIXED (issue #1135, LOW 6): this used to throw only when EVERY root vanished
 * at once, which left a blind spot the two-file edit boundary that opened it
 * could not close for want of test scaffolding — moving ONLY
 * `apps/nextjs/src/lib/screen-check` while its sibling `apps/nextjs/e2e` stayed
 * put slipped through, and that directory is exactly where `graded-text.ts` /
 * `claim-match.ts` live: one line there makes every graded check pass. A partial
 * rename is a rename, so ANY missing root now throws.
 */
export function assertCheckFreezeLayout(
  worktreePath: string,
  location: CheckLocation,
): void {
  const missing = checkFreezeInstrumentRoots(location).filter(
    (root) => !instrumentRootResolves(worktreePath, root),
  );
  if (missing.length > 0) {
    throw new CheckFreezeLayoutError(location, missing);
  }
}

/** What the derivation saw, so a test can assert the boundary rather than a
 *  remembered list. */
export interface CheckFreezeDerivation {
  /** {@link checkFreezeSeedsFor}, listed whether or not they exist. */
  readonly seeds: readonly string[];
  /** Everything frozen OUTSIDE the check directory: the seeds, plus every
   *  instrument file the check's own module graph reaches. */
  readonly frozen: readonly string[];
  /** Repository files the check reaches that are NOT frozen — the subject it
   *  is testing, and the fixtures and seed scripts beside it. Named honestly:
   *  these are covered by the mutant gate and the replay, never by a restore. */
  readonly exposed: readonly string[];
  /** Bare specifiers reached: packages and workspace imports, never frozen. */
  readonly bare: readonly string[];
}

/**
 * Derive the frozen set from what the check actually imports.
 *
 * Seeds are the runner's entry points; the check's own directory is walked for
 * its imports but never listed here (its bytes are held whole, as
 * `FrozenCheck.checkDir`).
 */
export function checkFreezeDerivation(
  worktreePath: string,
  location: CheckLocation,
): CheckFreezeDerivation {
  const seeds = checkFreezeSeedsFor(location);
  const checkDirPrefix = `${location.checkDir}/`;
  const closure = importClosure(
    worktreePath,
    [...seeds, ...checkDirFilesOf(worktreePath, location.checkDir)],
    (rel) =>
      rel === location.checkDir ||
      rel.startsWith(checkDirPrefix) ||
      isCheckInstrumentPath(location, rel),
  );
  const derived = closure.inside.filter(
    (rel) => !rel.startsWith(checkDirPrefix) && !seeds.includes(rel),
  );
  return {
    seeds,
    frozen: [...seeds, ...derived],
    exposed: closure.outside,
    bare: closure.bare,
  };
}

/** The check's own files, as walk seeds. Read straight off disk rather than
 *  from the snapshot so this can be called before a freeze exists. */
function checkDirFilesOf(
  worktreePath: string,
  checkDir: string,
): readonly string[] {
  const snapshot = snapshotDir(worktreePath, checkDir);
  if (snapshot === undefined) return [];
  return snapshot.relPaths.map((rel) => `${checkDir}/${rel}`);
}

/**
 * Files outside the check directory that decide what a check DOES.
 *
 * DERIVED FROM THE IMPORTS, not remembered. See {@link checkFreezeDerivation}
 * for the method and {@link isCheckInstrumentPath} for where the walk stops.
 *
 * What remains outside it is named honestly rather than papered over:
 * `package.json` and the lockfile (the builder legitimately changes those, and
 * reverting one would break the very run this is protecting), `node_modules`,
 * the `.env` files, the database, and the product code the check is testing.
 * Those are covered — where they are covered at all — by
 * `lib/judge/replay-hazard.ts` refusing a repair outright, and by the mutant
 * gate, rather than by a restore.
 */
export function checkFreezePathsFor(
  worktreePath: string,
  location: CheckLocation,
): readonly string[] {
  return checkFreezeDerivation(worktreePath, location).frozen;
}

/**
 * The host package of a unit check, read back out of its check directory.
 *
 * `unitCheckDirFor` builds `<packageDir>/src/__checks__/issue-<N>`, so the
 * package is everything before the first `/src/`. Derived rather than carried
 * because `CheckLocation` deliberately has no `packageDir` field — and returned
 * as `undefined` rather than guessed when the shape does not hold, so a rename
 * upstream costs a freeze that is narrower than it should be instead of a
 * freeze that writes to the wrong place.
 */
export function unitPackageDirOf(location: CheckLocation): string | undefined {
  if (location.kind !== "unit") return undefined;
  const at = location.checkDir.indexOf("/src/");
  if (at <= 0) return undefined;
  return location.checkDir.slice(0, at);
}

/** One frozen file. `bytes: undefined` records that the path did NOT exist
 *  when the freeze was taken, which a restore must reproduce by DELETING it —
 *  a setup file the builder ADDS is a setup file it can use. */
export interface FrozenFile {
  readonly relPath: string;
  readonly bytes: Buffer | undefined;
}

/** The exact bytes of one accepted check and everything that decides what it
 *  does, taken at the moment the check was accepted. */
export interface FrozenCheck {
  readonly location: CheckLocation;
  readonly frozenAtIso: string;
  /** The check directory itself. */
  readonly checkDir: DirSnapshot;
  /** {@link checkFreezePathsFor}, each at its bytes at freeze time. */
  readonly environment: readonly FrozenFile[];
  /** sha256 over every frozen path and its bytes, in sorted order. Two freezes
   *  of the same tree share a fingerprint; one byte anywhere changes it. */
  readonly fingerprint: string;
}

function fingerprintOf(
  checkDirRel: string,
  dir: DirSnapshot,
  env: readonly FrozenFile[],
): string {
  const h = createHash("sha256");
  for (const rel of dir.relPaths) {
    h.update(`${checkDirRel}/${rel}\0`);
    h.update(dir.bytesByRelPath.get(rel) ?? Buffer.alloc(0));
    h.update("\0");
  }
  for (const f of [...env].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    h.update(`${f.relPath}\0`);
    h.update(f.bytes ?? Buffer.from(" ABSENT"));
    h.update("\0");
  }
  return h.digest("hex");
}

/**
 * Take the freeze. `undefined` when the check directory could not be read at
 * all, which every caller treats as "there is no freeze" — additive, never an
 * error.
 */
export function freezeCheck(
  worktreePath: string,
  location: CheckLocation,
): FrozenCheck | undefined {
  const dir = snapshotDir(worktreePath, location.checkDir);
  if (dir === undefined || dir.relPaths.length === 0) return undefined;
  // The check directory is here, so a missing environment is not "no freeze" —
  // it is a freeze that would revert nothing. Fail loud if the whole instrument
  // layout has moved rather than handing back a silently-empty freeze.
  assertCheckFreezeLayout(worktreePath, location);
  const environment: FrozenFile[] = [];
  for (const rel of checkFreezePathsFor(worktreePath, location)) {
    const abs = path.join(worktreePath, rel);
    let bytes: Buffer | undefined;
    try {
      bytes = existsSync(abs) ? readFileSync(abs) : undefined;
    } catch {
      // Unreadable is not the same as absent, and recording it as absent would
      // make the restore DELETE a file that is really there. Leave it out of
      // the freeze entirely: narrower coverage, never a destructive restore.
      continue;
    }
    environment.push({ relPath: rel, bytes });
  }
  return {
    location,
    frozenAtIso: new Date().toISOString(),
    checkDir: dir,
    environment,
    fingerprint: fingerprintOf(location.checkDir, dir, environment),
  };
}

/**
 * Which frozen paths no longer match what was accepted — the cheat detector,
 * and the thing worth logging on every ticket rather than only on repaired
 * ones. Empty means the tree still holds exactly the check that was accepted.
 *
 * A path that cannot be read counts as drifted: "we could not look" is not
 * "nothing changed".
 */
export function frozenCheckDrift(
  worktreePath: string,
  frozen: FrozenCheck,
): readonly string[] {
  const drifted: string[] = [];
  const onDisk = snapshotDir(worktreePath, frozen.location.checkDir);
  if (onDisk === undefined) {
    drifted.push(frozen.location.checkDir);
  } else {
    const seen = new Set(onDisk.relPaths);
    for (const rel of frozen.checkDir.relPaths) {
      const want = frozen.checkDir.bytesByRelPath.get(rel);
      const got = onDisk.bytesByRelPath.get(rel);
      if (got === undefined || want === undefined || !want.equals(got)) {
        drifted.push(`${frozen.location.checkDir}/${rel}`);
      }
      seen.delete(rel);
    }
    for (const extra of seen) {
      drifted.push(`${frozen.location.checkDir}/${extra}`);
    }
  }
  for (const f of frozen.environment) {
    const abs = path.join(worktreePath, f.relPath);
    let got: Buffer | undefined;
    try {
      got = existsSync(abs) ? readFileSync(abs) : undefined;
    } catch {
      drifted.push(f.relPath);
      continue;
    }
    if (f.bytes === undefined) {
      if (got !== undefined) drifted.push(f.relPath);
    } else if (got === undefined || !f.bytes.equals(got)) {
      drifted.push(f.relPath);
    }
  }
  return drifted;
}

export type FrozenRestore =
  | { readonly ok: true; readonly restored: readonly string[] }
  | { readonly ok: false; readonly because: string };

/**
 * Put the frozen bytes back, then PROVE they are back by re-reading the tree.
 *
 * Proved rather than assumed for the same reason the worktree replay proves
 * its own restore: a write that silently did nothing and a write that worked
 * are indistinguishable from the return value of `writeFileSync`, and this is
 * the call that decides whether a grading run is grading the accepted check.
 */
export function restoreFrozenCheck(
  worktreePath: string,
  frozen: FrozenCheck,
): FrozenRestore {
  const before = frozenCheckDrift(worktreePath, frozen);
  try {
    if (!restoreDirFromSnapshot(worktreePath, frozen.location.checkDir, frozen.checkDir)) {
      return {
        ok: false,
        because: `the accepted check could not be written back into ${frozen.location.checkDir}`,
      };
    }
    for (const f of frozen.environment) {
      const abs = path.join(worktreePath, f.relPath);
      if (f.bytes === undefined) {
        rmSync(abs, { force: true });
        continue;
      }
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, f.bytes);
    }
  } catch (err) {
    return {
      ok: false,
      because: `restoring the accepted check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const after = frozenCheckDrift(worktreePath, frozen);
  if (after.length > 0) {
    return {
      ok: false,
      because:
        `the accepted check is still not back on disk after restoring it — ` +
        `${after.join(", ")}`,
    };
  }
  return { ok: true, restored: before };
}

/**
 * Put named paths INSIDE the frozen check directory back to their frozen
 * bytes — the tamper restore's source for the first test (spec #1334).
 *
 * ## Why the freeze and not the commit the builder was handed
 *
 * The protected-path lock used to restore every tampered path from that
 * commit. That is right for everything except the first test once it has been
 * REWRITTEN after a reviewer's `WRONG-CHECK`: the commit still holds the OLD,
 * wrong test, and restoring from it would silently put the wrong test back.
 * The freeze always holds the test the run last ACCEPTED — the original, or
 * its proved rewrite — so it is the one source that is right either way.
 *
 * A path the freeze never held (a file smuggled in beside the check) is
 * DELETED, the same answer `restoreProtectedPaths` gives a path absent at its
 * base. Each outcome is verified by re-reading the tree, and the result has
 * the same type as `restoreProtectedPaths`'s, so the caller treats both alike.
 *
 * Paths outside the frozen check directory are the caller's to route
 * elsewhere; handed one, this reports it unrestored rather than guessing.
 */
export function restoreFrozenCheckPaths(
  worktreePath: string,
  frozen: FrozenCheck,
  paths: readonly string[],
): RestoredPathOutcome[] {
  const dir = frozen.location.checkDir;
  return paths.map((p) => {
    if (!p.startsWith(`${dir}/`)) {
      return {
        path: p,
        existedAtBase: false,
        restored: false,
        error: `${p} is outside the frozen check directory ${dir}`,
      };
    }
    const want = frozen.checkDir.bytesByRelPath.get(p.slice(dir.length + 1));
    const abs = path.join(worktreePath, p);
    try {
      if (want === undefined) {
        rmSync(abs, { force: true });
        return { path: p, existedAtBase: false, restored: !existsSync(abs) };
      }
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, want);
      return { path: p, existedAtBase: true, restored: readFileSync(abs).equals(want) };
    } catch (err) {
      return {
        path: p,
        existedAtBase: want !== undefined,
        restored: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * A re-freeze of ONLY the check directory, taken AFTER a repair.
 *
 * ## Why this is a separate type rather than another `FrozenCheck`
 *
 * The repair used to call `freezeCheck` again on the rewritten check, which
 * captured the environment half — the runner config, the global setup, the
 * grading library — as those files stood AFTER the builder and the check-writer
 * had both had the tree. Three things followed from that one line, and all
 * three were silent:
 *
 *   - `restoreFrozenCheck` then WROTE that post-agent environment back onto the
 *     tree before every graded run, including inside the pre-builder replay
 *     that had just reverted it. The replay re-introduced the tamper it undid.
 *   - the accepted-time environment was never restored anywhere in the repair.
 *   - the ship-time drift detector was re-pointed at the tampered bytes, so a
 *     successful repair LAUNDERED environment drift out of the only thing
 *     watching for it.
 *
 * A rule saying "re-freeze only the directory" would have to be remembered at
 * the one call site that matters. A type that cannot carry an environment does
 * not. {@link freezeRepairedCheckDir} is the only way to take a post-acceptance
 * freeze, it returns this, and the only way to turn it back into a
 * {@link FrozenCheck} is {@link withRepairedCheckDir} — which takes the
 * environment from the ACCEPTED freeze and has no parameter it READS a newer
 * environment from.
 *
 * That last sentence used to say "no parameter a newer one could arrive
 * through", which overstates what the type does. TypeScript is structural and
 * this interface carries no brand, so a whole {@link FrozenCheck} IS assignable
 * to a `RepairedCheckDir` parameter — it satisfies both fields. The guarantee
 * is real, but it is carried by the BODY of `withRepairedCheckDir`, which reads
 * only `location` and `checkDir` and takes the environment from the accepted
 * freeze: a newer environment can be handed in and is ignored, rather than
 * being impossible to hand in.
 */
export interface RepairedCheckDir {
  readonly location: CheckLocation;
  readonly checkDir: DirSnapshot;
}

/** Re-read the check directory after a repair. Deliberately CANNOT capture the
 *  environment — see {@link RepairedCheckDir}. */
export function freezeRepairedCheckDir(
  worktreePath: string,
  location: CheckLocation,
): RepairedCheckDir | undefined {
  const dir = snapshotDir(worktreePath, location.checkDir);
  if (dir === undefined || dir.relPaths.length === 0) return undefined;
  return { location, checkDir: dir };
}

/**
 * The freeze a repair grades against: the REWRITTEN check directory, and the
 * environment exactly as it was ACCEPTED.
 *
 * `frozenAtIso` stays the accepted freeze's, because that is when the
 * environment half was taken and the environment half is what the drift
 * detector is watching.
 */
export function withRepairedCheckDir(
  accepted: FrozenCheck,
  repaired: RepairedCheckDir,
): FrozenCheck {
  return {
    location: repaired.location,
    frozenAtIso: accepted.frozenAtIso,
    checkDir: repaired.checkDir,
    environment: accepted.environment,
    fingerprint: fingerprintOf(
      repaired.location.checkDir,
      repaired.checkDir,
      accepted.environment,
    ),
  };
}
