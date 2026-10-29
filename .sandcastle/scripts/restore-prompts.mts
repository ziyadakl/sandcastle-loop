#!/usr/bin/env tsx

/**
 * MUST-KEEP auto-restore. `/sandcastle-update` overwrites the prompt files
 * listed in {@link PROMPT_FILES} wholesale from the upstream template, silently
 * stripping this project's local hardening (the `MUST-KEEP (local)` blocks).
 * The committed copy (HEAD) always holds the correct local-customized versions,
 * so restore = whole-file `git checkout HEAD -- <files>`. Before reverting, any
 * working-tree-vs-HEAD diff (the upstream content restore will discard) is
 * captured to a gitignored `.sandcastle/logs/` file so real upstream
 * improvements are never lost silently. After reverting, each file is verified
 * to carry AT LEAST the number of `MUST-KEEP (local)` markers its row in
 * {@link PROMPT_FILES} declares — a per-file expected count, so losing one of
 * `review-prompt.md`'s eight is caught rather than hidden by the other seven.
 * Wire-up: `pnpm sandcastle:restore-prompts`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** One prompt file this script restores, and how much hardening it must carry. */
export type PromptFile = {
  /** Repo-root-relative path. */
  readonly path: string;
  /**
   * How many `MUST-KEEP (local)` markers the committed copy carries today.
   *
   * This is the whole point of the guard. A bare "at least one" passes a file
   * that lost four of its five local blocks, which is exactly the damage an
   * upstream pull does and exactly what nobody would notice. Raise a number
   * here in the SAME commit that adds a marker to the file.
   */
  readonly expectedMarkers: number;
};

/**
 * `check-writer-prompt.md` is a local-only file with no upstream template
 * counterpart, so `/sandcastle-update` has nothing to overwrite it WITH today.
 * It is listed anyway: the marker count is the cheap insurance that says its
 * local hardening (the `{{REPAIR_BRIEF}}` slot, the same-string marker
 * rules) is still there, and the day upstream ships a file of that name
 * the restore is already wired rather than discovered missing afterwards.
 * (`judge-prompt.md` used to sit beside it; spec #1334 deleted the judge.)
 */
export const PROMPT_FILES: readonly PromptFile[] = [
  // One: the TICKET_UNCLEAR paragraph. Spec #1334 SG rewrote the old block
  // (the runnable-tool requirement, which threatened a re-quarantine over a
  // missing tool run) as advice, outside any marker.
  { path: ".sandcastle/implement-prompt.md", expectedMarkers: 1 },
  // One of the seven is the older-test paragraph (spec #1334 SH, replacing
  // issue #1271's `<sibling-check-amended>` slot): it tells the reviewer what
  // its own share of checking an edit to an OLDER ticket's test is.
  { path: ".sandcastle/review-prompt.md", expectedMarkers: 8 },
  // Zero since spec #1334 SG: its one block (the required-tool carve-out)
  // reconciled the fixer with a reviewer gate that no longer exists.
  { path: ".sandcastle/post-merge-fix-prompt.md", expectedMarkers: 0 },
  // Five: the {{REPAIR_BRIEF}} slot, two same-string reminders, outcome 6
  // (TICKET_UNCLEAR) and the same-string rule. Spec #1334 SH deleted
  // issue #1271's third repair-brief kind (amending an OLDER ticket's check),
  // and spec #1334 SE deleted the coverage-declaration section (issue #1118),
  // whose only reader — the judge — is gone.
  { path: ".sandcastle/check-writer-prompt.md", expectedMarkers: 5 },
];

const PROMPT_PATHS: readonly string[] = PROMPT_FILES.map((f) => f.path);

export const MARKER = "MUST-KEEP (local)";

function fail(msg: string): never {
  console.error(`sandcastle:restore-prompts: ${msg}`);
  process.exit(1);
}

/** Run git with an argv array (no shell interpolation) from repoRoot. */
function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

/**
 * The subset of `paths` that differ from HEAD in the working tree.
 *
 * Exported (with an injectable `paths`) so the IO half — the half that once
 * silently reverted a worker's real prompt edits — has a regression test that
 * drives a real throwaway repo rather than only the pure marker audit (issue
 * #1135, LOW 3).
 */
export function dirtyFiles(
  repoRoot: string,
  paths: readonly string[] = PROMPT_PATHS,
): string[] {
  const out = git(repoRoot, ["diff", "--name-only", "HEAD", "--", ...paths]);
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Capture the working-tree-vs-HEAD diff of `dirty` to a gitignored
 * `.sandcastle/logs/` file BEFORE {@link restoreFromHead} discards it, so a real
 * upstream improvement is never lost silently. Returns the path written.
 *
 * `nowIso` is injectable purely so a test can assert the file it names; every
 * real caller takes the default.
 */
export function captureDiscardedDiff(
  repoRoot: string,
  dirty: readonly string[],
  nowIso: string = new Date().toISOString(),
): string {
  const diff = git(repoRoot, ["diff", "HEAD", "--", ...dirty]);
  const logsDir = join(repoRoot, ".sandcastle", "logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  const stamp = nowIso.replace(/[:.]/g, "-");
  const diffPath = join(logsDir, `upstream-prompt-changes-${stamp}.diff`);
  writeFileSync(diffPath, diff, "utf8");
  return diffPath;
}

/** Revert `dirty` wholesale to the committed (local-customized) copy at HEAD. */
export function restoreFromHead(repoRoot: string, dirty: readonly string[]): void {
  git(repoRoot, ["checkout", "HEAD", "--", ...dirty]);
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** One file whose marker count is not the number it was expected to carry. */
export type MarkerDiscrepancy = {
  readonly file: string;
  readonly expected: number;
  readonly found: number;
};

/**
 * The two ways a marker count can be off, kept apart because only ONE of them
 * is a failure.
 */
export type MarkerAudit = {
  /**
   * Fewer markers than declared — local hardening is GONE. Hard failure.
   */
  readonly missing: readonly MarkerDiscrepancy[];
  /**
   * More markers than declared — somebody added hardening and did not raise
   * the number in {@link PROMPT_FILES}. Worth saying out loud, but NOT a
   * failure: this script is what the owner runs to RECOVER after an update,
   * and exiting 1 because a file is better protected than the table records
   * lands a false failure at the worst possible moment. (The old
   * `count !== 1` rule did exactly that on a correct repository.)
   */
  readonly surplus: readonly MarkerDiscrepancy[];
};

/**
 * Pure marker audit: compare per-file observed counts against the expected
 * counts. A file absent from `found` reads as zero markers, which is the same
 * verdict as a file that exists and lost all of them — in both cases nothing
 * is left saying the local hardening ever existed.
 */
export function auditMarkerCounts(
  found: ReadonlyMap<string, number>,
  files: readonly PromptFile[] = PROMPT_FILES,
): MarkerAudit {
  const missing: MarkerDiscrepancy[] = [];
  const surplus: MarkerDiscrepancy[] = [];
  for (const file of files) {
    const count = found.get(file.path) ?? 0;
    if (count < file.expectedMarkers) {
      missing.push({ file: file.path, expected: file.expectedMarkers, found: count });
    } else if (count > file.expectedMarkers) {
      surplus.push({ file: file.path, expected: file.expectedMarkers, found: count });
    }
  }
  return { missing, surplus };
}

function main(): void {
  const repoRoot = process.cwd();
  const sandcastleDir = join(repoRoot, ".sandcastle");
  if (!existsSync(sandcastleDir)) {
    fail(`no .sandcastle/ directory found in ${repoRoot} — run from repo root`);
  }

  const dirty = dirtyFiles(repoRoot);

  if (dirty.length === 0) {
    console.log(
      `sandcastle:restore-prompts: all ${PROMPT_FILES.length} prompt files ` +
        `already at HEAD, nothing to restore`,
    );
    // Still verify the committed copy is sane before returning.
    verifyMarkers(repoRoot);
    return;
  }

  // Capture the upstream content that restore is about to discard, so real
  // upstream improvements are never lost silently.
  const diffPath = captureDiscardedDiff(repoRoot, dirty);
  console.log(
    `sandcastle:restore-prompts: captured discarded upstream diff → ${diffPath}`,
  );

  // Revert the dirty files wholesale from the committed (local-customized) copy.
  restoreFromHead(repoRoot, dirty);

  verifyMarkers(repoRoot);

  console.log(
    `sandcastle:restore-prompts: restored ${dirty.length} file(s) from HEAD:`,
  );
  for (const f of dirty) console.log(`  ${f}`);
}

/**
 * Verify each prompt file still carries AT LEAST the number of
 * `MUST-KEEP (local)` markers {@link PROMPT_FILES} declares for it.
 *
 * **It used to demand exactly one, everywhere, and that was wrong twice over.**
 * The marker's job is to tell the next `/sandcastle-update` which local
 * hardening must be grafted back on. A file needing several pieces of local
 * hardening carries that many markers, which is correct and healthy —
 * `review-prompt.md` does today — so "exactly one" made this script exit 1 on a
 * correct repository. But relaxing it to "at least one" gave up the guard
 * instead of fixing it: a `review-prompt.md` that came back from an upstream
 * pull with one marker out of seven would have passed silently, with six blocks
 * of local hardening gone. The per-file expected count above keeps the
 * relaxation and gets the guard back.
 *
 * Below the expected count is a loud failure. Above it is a message and
 * nothing more — see {@link MarkerAudit.surplus} for why that asymmetry is
 * deliberate.
 */
function verifyMarkers(repoRoot: string): void {
  const found = new Map<string, number>();
  for (const { path: rel } of PROMPT_FILES) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue; // absent reads as zero — see auditMarkerCounts
    found.set(rel, countOccurrences(readFileSync(abs, "utf8"), MARKER));
  }

  const { missing, surplus } = auditMarkerCounts(found);

  if (surplus.length > 0) {
    console.warn(
      `sandcastle:restore-prompts: ${surplus.length} file(s) carry MORE ` +
        `"${MARKER}" markers than expected — not a failure, but raise the ` +
        `expectedMarkers count in restore-prompts.mts so the guard keeps ` +
        `proving all of them survived:`,
    );
    for (const { file, expected, found: n } of surplus) {
      console.warn(`  ${file}: expected ${expected}, found ${n}`);
    }
  }

  if (missing.length === 0) return;

  console.error(
    `sandcastle:restore-prompts: MARKER CHECK FAILED — local hardening is ` +
      `missing. Every prompt file must carry at least its expected number of ` +
      `"${MARKER}" markers after restore, but:`,
  );
  for (const { file, expected, found: n } of missing) {
    console.error(`  ${file}: expected ${expected}, found ${n}`);
  }
  console.error(
    `sandcastle:restore-prompts: the committed (HEAD) copy is wrong — fix it ` +
      `before running the loop.`,
  );
  process.exit(1);
}

/** Is this file being run directly, rather than imported by the test? */
function isMain(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  try {
    return resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    main();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(msg);
  }
}
