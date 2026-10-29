#!/usr/bin/env tsx

/**
 * Companion to `sandcastle:restore-prompts`: shows what `/sandcastle-update`
 * changed in the prompt files versus your committed (local-customized) copy —
 * i.e. exactly the upstream content that `restore-prompts` would discard. This
 * is READ-ONLY: it runs `git diff HEAD -- <files>` and never modifies anything.
 * Wire-up: `pnpm sandcastle:diff-prompts`.
 *
 * THE FILE LIST IS IMPORTED, NEVER RE-SPELLED. The promise above — "exactly
 * the content `restore-prompts` would discard" — is only true while both
 * scripts read the same list. A second hard-coded copy made that promise
 * quietly false the moment one side gained a file: this script would report
 * a clean tree while the other stood ready to revert work in a file it never
 * looked at. Issue #1133, item 15, is the same fault in a different file.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { PROMPT_FILES as RESTORED_PROMPT_FILES } from "./restore-prompts.mjs";

const PROMPT_FILES: readonly string[] = RESTORED_PROMPT_FILES.map(
  (f) => f.path,
);

function fail(msg: string): never {
  console.error(`sandcastle:diff-prompts: ${msg}`);
  process.exit(1);
}

/** Run git with an argv array (no shell interpolation) from repoRoot. */
function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function main(): void {
  const repoRoot = process.cwd();
  const sandcastleDir = join(repoRoot, ".sandcastle");
  if (!existsSync(sandcastleDir)) {
    fail(`no .sandcastle/ directory found in ${repoRoot} — run from repo root`);
  }

  const changed = git(repoRoot, [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    ...PROMPT_FILES,
  ])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (changed.length === 0) {
    console.log(
      `sandcastle:diff-prompts: all ${PROMPT_FILES.length} prompt files are at ` +
        `HEAD — no changes (nothing for restore-prompts to discard)`,
    );
    return;
  }

  console.log(
    `sandcastle:diff-prompts: ${changed.length} prompt file(s) differ from HEAD ` +
      `(these upstream changes would be discarded by restore-prompts):`,
  );
  for (const f of changed) console.log(`  ${f}`);
  console.log("");
  const diff = git(repoRoot, ["diff", "HEAD", "--", ...changed]);
  process.stdout.write(diff.endsWith("\n") ? diff : `${diff}\n`);
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg);
}
