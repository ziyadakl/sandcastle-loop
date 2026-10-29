/**
 * Tests for `./instructions-file.ts` — the read-only copy of each role's
 * filled prompt that the loop writes into the ticket's workspace (spec
 * #1368, decision 4), so an agent whose context was compacted can reread its
 * instructions from disk instead of searching its own session record.
 *
 * IO tests run against a REAL temp git repo, so the git-ignore line and the
 * read-only mode are proven against real `git check-ignore` / `fs.stat`
 * output (same discipline as `sandbox-agent-settings.test.ts`).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INSTRUCTIONS_DIR,
  instructionsRelPath,
  instructionsRoleFor,
  renderInstructionsFile,
  writeInstructionsFile,
  writeInstructionsForRun,
} from "./instructions-file.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const PROMPT = [
  "# Title",
  "intro text",
  "<!-- instructions:top -->",
  "[STEP 1/9] Pick the issue",
  "[STEP 9/9] Commit",
  "<!-- /instructions:top -->",
  "middle text",
  "<!-- instructions:top -->",
  "[ ] checklist box",
  "<!-- /instructions:top -->",
  "tail text",
].join("\n");

describe("instructionsRoleFor (pure)", () => {
  it("maps the three roles by prompt file, with or without the ./ prefix", () => {
    expect(instructionsRoleFor("./.sandcastle/implement-prompt.md")).toBe(
      "implement",
    );
    expect(instructionsRoleFor(".sandcastle/review-prompt.md")).toBe("review");
    expect(instructionsRoleFor("./.sandcastle/check-writer-prompt.md")).toBe(
      "check-writer",
    );
  });

  it("returns undefined for every other prompt", () => {
    expect(
      instructionsRoleFor("./.sandcastle/merge-prompt.md"),
    ).toBeUndefined();
    expect(
      instructionsRoleFor("./.sandcastle/post-merge-fix-prompt.md"),
    ).toBeUndefined();
  });
});

describe("renderInstructionsFile (pure)", () => {
  it("puts the marked step list and checklist BEFORE the full prompt, in order", () => {
    const out = renderInstructionsFile(PROMPT);
    const step = out.indexOf("[STEP 1/9] Pick the issue");
    const box = out.indexOf("[ ] checklist box");
    const fullTitle = out.indexOf("# Title");
    expect(step).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(step);
    expect(fullTitle).toBeGreaterThan(box);
  });

  it("keeps the whole prompt text and strips the marker comments", () => {
    const out = renderInstructionsFile(PROMPT);
    expect(out).toContain("middle text");
    expect(out).toContain("tail text");
    expect(out).not.toContain("instructions:top");
  });

  it("with no marked regions, is just the full prompt under a header", () => {
    const out = renderInstructionsFile("# Plain\nbody");
    expect(out).toContain("# Plain\nbody");
  });
});

describe("writeInstructionsFile (real filesystem + git)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "instr-"));
    dirs.push(dir);
    git(dir, "init", "-q");
    return dir;
  }

  it("writes the filled prompt to .sandcastle-instructions/<role>.md, read-only, step list first", () => {
    const wt = repo();
    const rel = writeInstructionsFile(wt, "implement", PROMPT);
    expect(rel).toBe(instructionsRelPath("implement"));
    const abs = path.join(wt, INSTRUCTIONS_DIR, "implement.md");
    expect(existsSync(abs)).toBe(true);
    expect(statSync(abs).mode & 0o777).toBe(0o444);
    const text = readFileSync(abs, "utf8");
    expect(text.indexOf("[STEP 1/9]")).toBeLessThan(text.indexOf("# Title"));
  });

  it("re-writes over a read-only file, so an edit cannot persist into the next run", () => {
    const wt = repo();
    writeInstructionsFile(wt, "review", "first");
    const abs = path.join(wt, INSTRUCTIONS_DIR, "review.md");
    // An agent that chmod-ed and tampered with the file:
    execFileSync("chmod", ["644", abs]);
    writeFileSync(abs, "TAMPERED");
    writeInstructionsFile(wt, "review", "second");
    const text = readFileSync(abs, "utf8");
    expect(text).toContain("second");
    expect(text).not.toContain("TAMPERED");
    expect(statSync(abs).mode & 0o777).toBe(0o444);
  });

  it("git never sees the file as untracked", () => {
    const wt = repo();
    writeInstructionsFile(wt, "implement", PROMPT);
    expect(git(wt, "status", "--porcelain")).toBe("");
  });

  it("the tracked .gitignore also ignores the directory", () => {
    const out = execFileSync(
      "git",
      ["check-ignore", `${INSTRUCTIONS_DIR}/implement.md`],
      { cwd: REPO_ROOT },
    )
      .toString("utf8")
      .trim();
    expect(out).toBe(`${INSTRUCTIONS_DIR}/implement.md`);
  });

  it("never throws: an unwritable worktree warns and returns undefined", () => {
    const warn = vi.fn();
    // A worktree path that is really a file: mkdir under it fails (ENOTDIR).
    const dir = mkdtempSync(path.join(tmpdir(), "instr-"));
    dirs.push(dir);
    const notADir = path.join(dir, "file");
    writeFileSync(notADir, "x");
    const rel = writeInstructionsFile(
      notADir,
      "implement",
      PROMPT,
      { warn },
    );
    expect(rel).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("writeInstructionsForRun (the seam main.mts calls)", () => {
  it("fills the real implement prompt and writes it, step list first, with no placeholder left", () => {
    const wt = mkdtempSync(path.join(tmpdir(), "instr-run-"));
    try {
      git(wt, "init", "-q");
      const rel = writeInstructionsForRun(
        REPO_ROOT,
        wt,
        {
          promptFile: "./.sandcastle/implement-prompt.md",
          promptArgs: new Proxy({} as Record<string, string>, {
            has: () => true,
            get: (_t, k) => `<<${String(k)}>>`,
          }),
        },
      );
      expect(rel).toBe(".sandcastle-instructions/implement.md");
      const text = readFileSync(path.join(wt, rel as string), "utf8");
      expect(text).toContain("<<ISSUE_NUMBER>>");
      expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(text.indexOf("[STEP 1/9]")).toBeLessThan(
        text.indexOf("# Sandcastle Implementer Prompt"),
      );
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("does nothing for a prompt with no instructions file", () => {
    expect(
      writeInstructionsForRun("/tmp", "/tmp", {
        promptFile: "./.sandcastle/merge-prompt.md",
      }),
    ).toBeUndefined();
  });
});

describe("the prompts point at the file", () => {
  for (const [role, file] of [
    ["implement", "implement-prompt.md"],
    ["review", "review-prompt.md"],
    ["check-writer", "check-writer-prompt.md"],
  ] as const) {
    it(`${file} names ${instructionsRelPath(role)} near the top and says not to edit it`, () => {
      const text = readFileSync(
        path.join(REPO_ROOT, ".sandcastle", file),
        "utf8",
      );
      const head = text.split("\n").slice(0, 40).join("\n");
      expect(head).toContain(instructionsRelPath(role));
      expect(head).toMatch(/do not edit/i);
      expect(head).toMatch(/compact/i);
      expect(head).toMatch(/session record/i);
    });
  }

  it("implement-prompt.md marks the step list and both checklists", () => {
    const text = readFileSync(
      path.join(REPO_ROOT, ".sandcastle", "implement-prompt.md"),
      "utf8",
    );
    const out = renderInstructionsFile(text);
    const top = out.slice(0, out.indexOf("# Sandcastle Implementer Prompt"));
    expect(top).toContain("[STEP 1/9]");
    expect(top).toContain("--- e2e verification certification ---");
    expect(top).toContain('"marker": "STORY_COMPLETE"');
  });
});
