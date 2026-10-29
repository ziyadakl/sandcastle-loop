/**
 * A narrow, CONTENT-level companion to the path-based protected-path lock
 * (issue #909/#911's Piece C, `protected-paths.ts`) for exactly one field:
 * `apps/nextjs/package.json`'s `scripts.e2e` — the command line
 * `buildCheckCommand` (`lib/checkwriter/check-path.ts`) actually invokes to
 * grade every check (issue #914 hardening).
 *
 * ## Why not a plain protected-path glob
 *
 * `apps/nextjs/package.json` is edited by ORDINARY feature tickets
 * constantly — adding an npm dependency is routine builder work (`git log`
 * shows Sentry, pdfjs-dist, Plaid, Lucide, Tiptap all landing as plain
 * `package.json` diffs with zero `e2e`-script involvement). Blanket-
 * protecting the whole file the way `DEFAULT_PROTECTED_PATH_GLOBS` protects
 * `playwright.config.ts` would silently REVERT every legitimate dependency
 * addition on the file's first byte-for-byte restore (`enforceProtectedPaths`
 * restores the WHOLE file from `preSha`) — a worse regression than the hole
 * it would close. So this checks ONE field's VALUE, pre vs. post, leaving
 * the rest of the file free to change.
 *
 * ## What it catches
 *
 * `apps/nextjs/e2e/lib/graded-screen-check.ts`, `apps/nextjs/
 * playwright.config.ts`, and this ONE field together own the entire truth
 * of a check's verdict — the exit code plus tally line
 * `runScreenCheckHarness` (`lib/harness/`) greps out of `pnpm --filter
 * @acme/nextjs e2e <file> --reporter=line,json`. (No `--` before the file —
 * see `checkwriter/check-path.ts`'s `buildCheckCommand`, where a stray one
 * swallowed every flag after it and quarantined issue #803 twice.)
 * Retargeting the `e2e` script
 * itself (`"e2e": "echo \"1 passed\""`) makes every check "pass" without a
 * browser ever opening — structurally identical to editing the check file
 * directly, just through a different door. Only fires when the field's
 * VALUE genuinely differs, so ordinary dependency-only edits never trip it.
 *
 * ## Where it's wired in
 *
 * `main.mts`'s `enforceProtectedPaths` calls {@link e2eScriptTampered}
 * alongside the ordinary glob-based `detectProtectedPathViolations`, and —
 * if it fires — adds {@link e2eScriptGuardedPackageJson} to the SAME
 * `violations` list. That reuses every downstream mechanism unchanged
 * (`noteChecksTampered`, the twice-and-stop rule, `restoreProtectedPaths`
 * restoring the whole file byte-for-byte) — one lock, two detection
 * strategies, never a second parallel enforcement path.
 */

import { execFileSync } from "node:child_process";

import { getProjectConfig } from "../project-config.js";

/**
 * The one file this module watches a single field of: `e2eScriptPackageJson`
 * in `.sandcastle/project.json`. `null` = the guard is off.
 */
export function e2eScriptGuardedPackageJson(): string | null {
  return getProjectConfig().e2eScriptPackageJson;
}

/**
 * One read attempt's outcome. `ok: true` covers BOTH "the field has a
 * string value" and "the blob parsed cleanly and the field is genuinely
 * absent" — both are legitimate, comparable readings. `ok: false` is
 * reserved for a read the guard could not make sense of at all (unreadable
 * blob, unparsable JSON, `scripts` present but not an object, `e2e` present
 * but not a string) — see {@link e2eScriptTampered} for why that case is
 * NOT folded into "absent".
 */
type E2eScriptRead =
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false };

/**
 * Read `pkgPath`'s `scripts.e2e` string at `sha`. Distinguishes a CLEAN
 * absence (the blob parsed fine; there is just no `scripts.e2e` field —
 * true of every `package.json` before this script existed) from an
 * AMBIGUOUS read (unreadable blob, unparsable JSON, or a `scripts`/`e2e`
 * shape that isn't what's expected) — {@link e2eScriptTampered} resolves
 * these two differently.
 */
function e2eScriptAt(
  worktreePath: string,
  sha: string,
  pkgPath: string,
): E2eScriptRead {
  let raw: string;
  try {
    raw = execFileSync("git", ["show", `${sha}:${pkgPath}`], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false };
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (scripts === undefined) return { ok: true, value: undefined };
  if (typeof scripts !== "object" || scripts === null) return { ok: false };
  const e2e = (scripts as { e2e?: unknown }).e2e;
  if (e2e === undefined) return { ok: true, value: undefined };
  return typeof e2e === "string" ? { ok: true, value: e2e } : { ok: false };
}

/**
 * Did `apps/nextjs/package.json`'s `scripts.e2e` field change between
 * `baseSha` and `headSha`?
 *
 * FIXED (2026-08-04 review finding, "also fix, cheap"): this used to fold
 * an unreadable/unparsable blob into the SAME "nothing to compare" bucket
 * as a clean, legitimate absence, and returned `false` (not tampered) for
 * both — under a test literally titled "fails safe". Its sibling
 * `pathContentChangedBetween` (`protected-path-restore.ts`) resolves the
 * identical ambiguity to `true` (a violation) — "a broken read must never
 * let a real tamper slip through silently." This function now matches
 * that: an unreadable/unparsable read on EITHER side is treated as a
 * violation, never a pass. Only a CLEAN read that agrees the field is
 * absent on both sides (or unchanged) reads as "nothing to compare".
 *
 * Callers are expected to only invoke this when `pkgPath` is already known
 * to be inside the diff being examined (mirrors `detectProtectedPathViolations`'s
 * contract of only being meaningful on paths a diff already reports as
 * changed) — this function does not check that itself, so it stays a pure
 * two-read comparison with no diff-measurement opinion of its own.
 */
export function e2eScriptTampered(
  worktreePath: string,
  baseSha: string,
  headSha: string,
  pkgPath: string,
): boolean {
  const before = e2eScriptAt(worktreePath, baseSha, pkgPath);
  const after = e2eScriptAt(worktreePath, headSha, pkgPath);
  if (!before.ok || !after.ok) return true;
  return before.value !== after.value;
}
