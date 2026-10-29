/**
 * Tests for `./sandbox-agent-settings.ts` — the loop-owned Claude Code
 * settings written into every sandboxed agent's worktree (2026-09-04 fix).
 *
 * Pure-value tests need no filesystem. The IO tests drive `writeSandboxAgentSettings`
 * against a REAL temp git repo (mirroring the discipline `mac-host-sandbox.ts`'s
 * `stageCodexAgentsMdIntoWorktree` is tested by proxy elsewhere) so the
 * `.gitignore` line and the `info/exclude` belt are both proven against real
 * `git check-ignore` / `git status` output, not simulated.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  renderSandboxAgentSettings,
  SANDBOX_AGENT_SETTINGS_RELPATH,
  SANDBOX_CLAUDE_HOME,
  sandboxAgentSettings,
  sandboxAgentSettingsArgs,
  writeSandboxAgentSettings,
} from "./sandbox-agent-settings.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

describe("sandboxAgentSettings (pure)", () => {
  it("carries both absolute CLAUDE.md paths when home differs from the docker agent home", () => {
    expect(sandboxAgentSettings("/home/you")).toEqual({
      disableAllHooks: true,
      outputStyle: "default",
      claudeMdExcludes: [
        "/home/you/.claude/CLAUDE.md",
        "/home/agent/.claude/CLAUDE.md",
      ],
    });
  });

  it("de-duplicates when home already equals the docker agent home", () => {
    expect(sandboxAgentSettings(SANDBOX_CLAUDE_HOME)).toEqual({
      disableAllHooks: true,
      outputStyle: "default",
      claudeMdExcludes: ["/home/agent/.claude/CLAUDE.md"],
    });
  });
});

describe("renderSandboxAgentSettings", () => {
  it("round-trips through JSON.parse and ends with a trailing newline", () => {
    const rendered = renderSandboxAgentSettings("/home/you");
    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toEqual(sandboxAgentSettings("/home/you"));
  });
});

describe("sandboxAgentSettingsArgs", () => {
  it("is [--settings, <compact JSON of the same object>]", () => {
    const args = sandboxAgentSettingsArgs("/home/you");
    expect(args[0]).toBe("--settings");
    expect(JSON.parse(args[1])).toEqual(sandboxAgentSettings("/home/you"));
  });
});

describe("writeSandboxAgentSettings (IO)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function freshRepo(): string {
    const repo = mkdtempSync(path.join(tmpdir(), "sc-agent-settings-repo-"));
    dirs.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    writeFileSync(path.join(repo, "README.md"), "seed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "seed");
    return repo;
  }

  it("writes the settings file with the rendered content and keeps git clean", () => {
    const repo = freshRepo();
    writeSandboxAgentSettings(repo, { home: "/home/you" });

    const filePath = path.join(repo, SANDBOX_AGENT_SETTINGS_RELPATH);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(
      renderSandboxAgentSettings("/home/you"),
    );

    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("git check-ignore exits 0 (throws nothing) after the write", () => {
    const repo = freshRepo();
    writeSandboxAgentSettings(repo, { home: "/home/you" });
    expect(() =>
      execFileSync("git", ["check-ignore", "-q", SANDBOX_AGENT_SETTINGS_RELPATH], {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).not.toThrow();
  });

  it("always overwrites and is idempotent on the exclude line across repeated calls", () => {
    const repo = freshRepo();
    writeSandboxAgentSettings(repo, { home: "/home/you" });
    writeSandboxAgentSettings(repo, { home: "/home/agent" }); // different content — must overwrite, not merge

    const filePath = path.join(repo, SANDBOX_AGENT_SETTINGS_RELPATH);
    expect(readFileSync(filePath, "utf8")).toBe(
      renderSandboxAgentSettings("/home/agent"),
    );

    const excludeRel = execFileSync(
      "git",
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: repo, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString("utf8")
      .trim();
    const excludePath = path.resolve(repo, excludeRel);
    const excludeContents = readFileSync(excludePath, "utf8");
    const occurrences = excludeContents
      .split("\n")
      .filter((line) => line.trim() === SANDBOX_AGENT_SETTINGS_RELPATH).length;
    expect(occurrences).toBe(1);

    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("still writes the settings file in a non-git directory, and warns exactly once about the exclude step", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sc-agent-settings-nongit-"));
    dirs.push(dir);
    const warn = vi.fn();

    writeSandboxAgentSettings(dir, { home: "/home/you", warn });

    const filePath = path.join(dir, SANDBOX_AGENT_SETTINGS_RELPATH);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(
      renderSandboxAgentSettings("/home/you"),
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never throws on an unwritable path — warns instead", () => {
    // A path whose parent segment is a plain FILE, not a directory: mkdirSync
    // recursive on `<file>/.claude` fails with ENOTDIR.
    const dir = mkdtempSync(path.join(tmpdir(), "sc-agent-settings-unwritable-"));
    dirs.push(dir);
    const blockerFile = path.join(dir, "not-a-dir");
    writeFileSync(blockerFile, "");
    const warn = vi.fn();

    expect(() =>
      writeSandboxAgentSettings(blockerFile, { home: "/home/you", warn }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(blockerFile, SANDBOX_AGENT_SETTINGS_RELPATH))).toBe(
      false,
    );
  });
});
