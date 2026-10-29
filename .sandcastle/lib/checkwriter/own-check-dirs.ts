/**
 * Which `issue-<N>` check folders a list of files sits inside (#1361).
 *
 * Used once: a ticket RESUMED from its saved work (a `/sandcastle-stop --now`
 * checkpoint) whose check-writer answers ALREADY_BUILT creates no folder this
 * run, so the folders its saved work committed are found here and locked for
 * it (`savedWorkCheckDirs` in `main.mts`). A ticket owns exactly the check
 * folders locked for it, so this is also what keeps #1311's own first test
 * from reading as another ticket's (2026-10-13).
 */

import { checksRoot, isUsableIssueNumber } from "./check-path.js";
import { UNIT_CHECK_DIR_SEGMENT } from "./unit-check-path.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The check roots, built from the SAME constants the lock in `proof-demand.ts`
 * is built from (`lockedCheckGlobs`: `${checksRoot()}/**` and
 * `UNIT_CHECKS_ROOT_GLOB` = `**\/src/${UNIT_CHECK_DIR_SEGMENT}/**`), so a
 * folder can be owned only where the lock reaches. The browser root is the one
 * configured `checksRoot`, anchored at the repo root; the unit root is
 * `src/<segment>` under any directory, exactly as the glob's leading `**\/`
 * allows (including zero segments).
 */
const checkRootSource = (): string =>
  `(?:${escapeRegExp(checksRoot())}` +
  `|(?:.*/)?src/${escapeRegExp(UNIT_CHECK_DIR_SEGMENT)})`;

/**
 * Every `issue-<N>` folder directly under a locked check root (see
 * `checkRootSource`) that a file in `files` sits inside, each once, sorted.
 * The number is matched exactly: `issue-131` never matches `issue-1311`.
 */
export function issueCheckDirsIn(
  files: readonly string[] | null,
  issueNumber: number,
): string[] {
  if (!Array.isArray(files)) return [];
  if (!isUsableIssueNumber(issueNumber)) return [];
  // Anchored on `/` both sides, so `issue-131` never matches `issue-1311`.
  const re = new RegExp(`^(${checkRootSource()}/issue-${issueNumber})/`);
  const found = new Set<string>();
  for (const file of files) {
    if (typeof file !== "string" || file.split("/").includes("..")) continue;
    const dir = re.exec(file)?.[1];
    if (dir !== undefined) found.add(dir);
  }
  return [...found].sort();
}
