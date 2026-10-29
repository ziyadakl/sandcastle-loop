/**
 * Issue #1118 — the kill window, and the one commit that must never be made
 * inside it.
 *
 * A check repair stands the worktree back up on the code the builder was
 * HANDED for the length of a whole agent dispatch. `commitWorktreeCheckpoint`
 * does `git add -A` and commits, and it is reachable from
 * `scripts/checkpoint-stop.mts` — a separate process that runs after
 * `main.mts` has been killed, so it cannot be told in memory. Landing in that
 * window it writes a WIP commit DELETING the builder's whole night, and that
 * commit is what a resume materialises.
 *
 * Run against a REAL temp git repo: the refusal turns on a sentinel written
 * into git's own common directory, and a stubbed git would only prove the stub
 * behaves as written.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "../../__fixtures__/git-repo.js";
import type { GitRunResult } from "./issue-lease.js";
import { commitWorktreeCheckpoint, saveWorkToWipRef, wipRef } from "./branch-checkpoint.js";
import { withWorktreeAt } from "../paths/worktree-replay.js";

let repo: string;

/** The real thing, in the real repo — this test is about git's own behaviour. */
const realGit = async (
  cwd: string,
  ...args: string[]
): Promise<GitRunResult> => {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sandcastle-branch-checkpoint-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("commitWorktreeCheckpoint", () => {
  it("commits ordinary dirt, which is what it is for", async () => {
    commitInto(repo, { "src/a.ts": "export const a = 1;\n" }, "seed");
    writeFileSync(path.join(repo, "src/a.ts"), "export const a = 2;\n");

    expect(await commitWorktreeCheckpoint(repo, 1118, "host-a", realGit)).toBe(
      true,
    );
    expect(git(repo, "log", "-1", "--pretty=%s")).toContain(
      "wip: checkpoint issue 1118",
    );
  });

  it("REFUSES while a check-repair replay is in flight", async () => {
    // THE ONE THIS FILE EXISTS FOR. Inside the replay the builder's file is
    // gone from disk, so `git add -A` would stage its deletion.
    const preSha = commitInto(
      repo,
      { "src/a.ts": "export const a = 1;\n" },
      "the state the builder was handed",
    );
    const builtSha = commitInto(
      repo,
      { "src/builder.ts": "export const built = true;\n" },
      "the builder's night",
    );

    const lines: string[] = [];
    let checkpointed: boolean | undefined;
    let headInside = "";
    await withWorktreeAt(repo, preSha, builtSha, async () => {
      checkpointed = await commitWorktreeCheckpoint(
        repo,
        1118,
        "host-a",
        realGit,
        (l) => lines.push(l),
      );
      headInside = git(repo, "rev-parse", "HEAD");
      return "done";
    });

    expect(checkpointed).toBe(false);
    expect(lines.join("\n")).toContain("checkpoint REFUSED");
    // Nothing was withheld that the ticket actually had: a replay moves the
    // TREE, never HEAD, so the builder's night is still committed and still
    // what `pushWipRef` would check in.
    expect(headInside).toBe(builtSha);
    expect(git(repo, "log", "-1", "--pretty=%s")).not.toContain("wip:");
  });

  it("commits again once the replay has finished and been proved", async () => {
    // Proves the instrument: the refusal is not simply permanent. Without this
    // the test above would pass on a function that never checkpoints at all.
    const preSha = commitInto(
      repo,
      { "src/a.ts": "export const a = 1;\n" },
      "the state the builder was handed",
    );
    const builtSha = commitInto(
      repo,
      { "src/builder.ts": "export const built = true;\n" },
      "the builder's night",
    );
    const replay = await withWorktreeAt(repo, preSha, builtSha, () => "done");
    expect(replay.kind).toBe("ok");

    writeFileSync(path.join(repo, "src/a.ts"), "export const a = 2;\n");
    expect(await commitWorktreeCheckpoint(repo, 1118, "host-a", realGit)).toBe(
      true,
    );
  });
});

/**
 * Spec #1334 fix pass, item 3: a failed fixer saves its work to the ticket's
 * WIP ref — pushed with cross-host sync on, so the next attempt resumes it;
 * local with sync off, kept for recovery by hand.
 */
describe("saveWorkToWipRef", () => {
  it("commits uncommitted work and pins HEAD to the ticket's WIP ref, locally, when sync is off", async () => {
    commitInto(repo, { "a.txt": "base\n" }, "base");
    writeFileSync(path.join(repo, "b.txt"), "the fixer's half-done work\n");

    const saved = await saveWorkToWipRef(
      { repoRoot: repo, wtPath: repo, issue: 42, hostId: "host-a", pushToOrigin: false },
      realGit,
    );

    expect(saved.saved).toBe(true);
    const head = git(repo, "rev-parse", "HEAD");
    expect(git(repo, "rev-parse", wipRef(42))).toBe(head);
    expect(git(repo, "show", "HEAD:b.txt")).toBe("the fixer's half-done work");
  });

  it("pins HEAD even when nothing is uncommitted — committed work is work too", async () => {
    commitInto(repo, { "a.txt": "base\n" }, "base");
    commitInto(repo, { "a.txt": "fixer commit\n" }, "fix: part one");

    const saved = await saveWorkToWipRef(
      { repoRoot: repo, wtPath: repo, issue: 43, hostId: "host-a", pushToOrigin: false },
      realGit,
    );

    expect(saved.saved).toBe(true);
    expect(git(repo, "rev-parse", wipRef(43))).toBe(git(repo, "rev-parse", "HEAD"));
  });
});
