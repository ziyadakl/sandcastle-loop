import path from "node:path";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { addToGitInfoExclude } from "./git/info-exclude.js";
import { applyPromptArgs } from "./prompt-args.js";

/**
 * A read-only copy of each role's FILLED prompt, written into the ticket's
 * workspace before the role runs (spec #1368, decision 4).
 *
 * Why: after Claude Code compacts a long run, the agent loses the step list
 * and checklist it was working from. With no file to reread, it searched its
 * own session record (a huge file) for them. Now the prompt opens with a short
 * pointer to this file, and the file leads with the step list and checklist.
 *
 * Files: `.sandcastle-instructions/<role>.md`, role = implement | review |
 * check-writer. The fixer reuses `implement-prompt.md`, so it shares
 * `implement.md`. Git-ignored (root `.gitignore` plus the worktree's
 * `info/exclude`). Shell blocks (!`cmd`) are NOT expanded here — the library
 * expands those inside the sandbox — so the copy shows them as written.
 *
 * Read-only is advisory: the container runs as the host user, so the agent
 * could chmod the file back. The prompt tells it not to, and the loop
 * re-writes the file before EVERY role run, so an edit cannot outlive the
 * role that made it.
 */
export const INSTRUCTIONS_DIR = ".sandcastle-instructions";

/** Region markers in a prompt: text between them is lifted to the top. */
const TOP_OPEN = "<!-- instructions:top -->";
const TOP_CLOSE = "<!-- /instructions:top -->";

/** The three roles that get an instructions file. */
export type InstructionsRole = "implement" | "review" | "check-writer";

const ROLE_BY_PROMPT: Readonly<Record<string, InstructionsRole>> = {
  "implement-prompt.md": "implement",
  "review-prompt.md": "review",
  "check-writer-prompt.md": "check-writer",
};

/** The role whose prompt gets an instructions file, or undefined. */
export function instructionsRoleFor(
  promptFile: string,
): InstructionsRole | undefined {
  return ROLE_BY_PROMPT[path.basename(promptFile)];
}

/** Repo-relative path of a role's instructions file. */
export function instructionsRelPath(role: InstructionsRole): string {
  return `${INSTRUCTIONS_DIR}/${role}.md`;
}

/**
 * Pure: the file text. Regions between the marker comments (the step list,
 * the checklists) come first, in prompt order; then the whole prompt. The
 * marker comments themselves are dropped.
 */
export function renderInstructionsFile(filledPrompt: string): string {
  const regions: string[] = [];
  let from = 0;
  for (;;) {
    const open = filledPrompt.indexOf(TOP_OPEN, from);
    if (open === -1) break;
    const close = filledPrompt.indexOf(TOP_CLOSE, open);
    if (close === -1) break;
    regions.push(filledPrompt.slice(open + TOP_OPEN.length, close).trim());
    from = close + TOP_CLOSE.length;
  }
  const full = filledPrompt
    .split("\n")
    .filter((l) => l.trim() !== TOP_OPEN && l.trim() !== TOP_CLOSE)
    .join("\n");
  const head =
    "<!-- Read-only copy of your instructions, written by the loop. Do not edit it. -->\n\n";
  if (regions.length === 0) return `${head}${full}\n`;
  return (
    `${head}# Step list and checklist (first)\n\n${regions.join("\n\n")}\n\n` +
    `---\n\n# Full instructions\n\n${full}\n`
  );
}

/**
 * The seam `createSandboxRaw`'s `run` wrapper calls before every role run:
 * if `run.promptFile` belongs to a role with an instructions file, fill it
 * the same way mac-host does (`applyPromptArgs`) and write the file. Silent
 * no-op for other prompts or a missing worktree; never throws.
 */
export function writeInstructionsForRun(
  repoRoot: string,
  worktreePath: string | undefined,
  run: { promptFile: string; promptArgs?: Record<string, string> },
  warn: (message: string) => void = () => {},
): string | undefined {
  const role = instructionsRoleFor(run.promptFile);
  if (role === undefined || worktreePath === undefined) return undefined;
  try {
    const template = readFileSync(path.resolve(repoRoot, run.promptFile), "utf8");
    const filled = applyPromptArgs(template, run.promptArgs ?? {});
    return writeInstructionsFile(worktreePath, role, filled, { warn });
  } catch (err) {
    warn(
      `failed to fill ${run.promptFile} for its instructions file: ` +
        `${(err as Error).message}`,
    );
    return undefined;
  }
}

/**
 * Write (always replacing) `<worktree>/.sandcastle-instructions/<role>.md`,
 * mode 0444, and keep it out of git. Returns the repo-relative path, or
 * undefined after one `warn` if the write failed. Never throws.
 */
export function writeInstructionsFile(
  worktreePath: string,
  role: InstructionsRole,
  filledPrompt: string,
  opts: { warn?: (message: string) => void } = {},
): string | undefined {
  const warn = opts.warn ?? ((): void => {});
  const rel = instructionsRelPath(role);
  const abs = path.join(worktreePath, rel);
  try {
    mkdirSync(path.dirname(abs), { recursive: true });
    // Remove first: an existing 0444 file refuses an overwrite.
    rmSync(abs, { force: true });
    writeFileSync(abs, renderInstructionsFile(filledPrompt));
    chmodSync(abs, 0o444);
  } catch (err) {
    warn(
      `failed to write ${rel} into ${worktreePath}: ${(err as Error).message}`,
    );
    return undefined;
  }
  addToGitInfoExclude(worktreePath, `${INSTRUCTIONS_DIR}/`, warn);
  return rel;
}
