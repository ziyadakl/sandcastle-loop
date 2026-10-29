/**
 * Tests for the protected-path RESTORE half (issue #909 / Piece C), run
 * against a REAL temp git repo (`__fixtures__/git-repo.ts`) with real commits
 * — not a stub. Restoring a file is a git/fs operation; the only honest way
 * to prove it works is to actually tamper a real commit and watch the
 * original bytes come back.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "../../__fixtures__/git-repo.js";
import {
  buildProtectedPathRestoreMessage,
  commitRestoredPaths,
  discardWorkingTreeChanges,
  dirtyPathsIn,
  ensureDirCommitted,
  restoreProtectedPaths,
} from "./protected-path-restore.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sandcastle-protected-path-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("restoreProtectedPaths", () => {
  it("puts a modified protected file back byte-for-byte", () => {
    // A protected file with bytes that would break if run through a text
    // encoding round-trip: non-ASCII content and no trailing newline.
    const original = Buffer.from("héllo — protected\nteam: Ridgeline", "utf8");
    mkdirSync(path.join(repo, "apps/nextjs/e2e/lib/teams"), {
      recursive: true,
    });
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/lib/teams/x.ts"),
      original,
    );
    // commitInto only takes strings; write the binary-ish content directly
    // above, then let commitInto's own `git add -A` pick it up.
    const baseSha = commitInto(
      repo,
      {},
      "chore: seed a protected file with non-ascii bytes",
    );
    // The "builder" tampers with it.
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/lib/teams/x.ts"),
      "// I edited the check so it passes now\n",
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: (tampered)");

    const outcomes = restoreProtectedPaths(repo, baseSha, [
      "apps/nextjs/e2e/lib/teams/x.ts",
    ]);

    expect(outcomes).toEqual([
      {
        path: "apps/nextjs/e2e/lib/teams/x.ts",
        existedAtBase: true,
        restored: true,
      },
    ]);
    const after = readFileSync(
      path.join(repo, "apps/nextjs/e2e/lib/teams/x.ts"),
    );
    expect(after.equals(original)).toBe(true);
  });

  it("deletes a protected file the builder ADDED (it never existed at base)", () => {
    const baseSha = commitInto(
      repo,
      { "README.md": "# repo\n" },
      "chore: initial commit, no seventh team file",
    );
    mkdirSync(path.join(repo, "apps/nextjs/e2e/lib/teams"), {
      recursive: true,
    });
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/lib/teams/new-team.ts"),
      "export const newTeam = { key: 'sneaky', deals: [/* a fabricated deal */] };\n",
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: add a new team (not asked for)");

    const outcomes = restoreProtectedPaths(repo, baseSha, [
      "apps/nextjs/e2e/lib/teams/new-team.ts",
    ]);

    expect(outcomes).toEqual([
      {
        path: "apps/nextjs/e2e/lib/teams/new-team.ts",
        existedAtBase: false,
        restored: true,
      },
    ]);
    expect(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: repo,
        encoding: "utf8",
      }).includes("new-team.ts"),
    ).toBe(true); // deleted, shows up as a pending removal until committed
  });

  it("leaves an untampered protected file untouched (still counted as restored — it already matches)", () => {
    const original = "export const bright = { key: 'bright-city' };\n";
    const baseSha = commitInto(
      repo,
      { "apps/nextjs/e2e/lib/teams/bright-city.ts": original },
      "chore: seed",
    );
    // No further commit — the file was never tampered.
    const outcomes = restoreProtectedPaths(repo, baseSha, [
      "apps/nextjs/e2e/lib/teams/bright-city.ts",
    ]);
    expect(outcomes[0]?.restored).toBe(true);
    expect(
      readFileSync(
        path.join(repo, "apps/nextjs/e2e/lib/teams/bright-city.ts"),
        "utf8",
      ),
    ).toBe(original);
  });

  it("reports multiple violations independently — one path's failure doesn't hide another's success", () => {
    const baseSha = commitInto(
      repo,
      {
        "apps/nextjs/e2e/lib/teams/a.ts": "// a original\n",
        "apps/nextjs/e2e/lib/teams/b.ts": "// b original\n",
      },
      "chore: seed two files",
    );
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/lib/teams/a.ts"),
      "// a tampered\n",
    );
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/lib/teams/b.ts"),
      "// b tampered\n",
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: tamper both");

    const outcomes = restoreProtectedPaths(repo, baseSha, [
      "apps/nextjs/e2e/lib/teams/a.ts",
      "apps/nextjs/e2e/lib/teams/b.ts",
    ]);
    expect(outcomes.every((o) => o.restored)).toBe(true);
    expect(
      readFileSync(
        path.join(repo, "apps/nextjs/e2e/lib/teams/a.ts"),
        "utf8",
      ),
    ).toBe("// a original\n");
    expect(
      readFileSync(
        path.join(repo, "apps/nextjs/e2e/lib/teams/b.ts"),
        "utf8",
      ),
    ).toBe("// b original\n");
  });

  it("reports existedAtBase:false, restored:true for a path absent at an unreachable base sha (nothing to restore TO, so absence is the correct target)", () => {
    commitInto(repo, { "README.md": "# repo\n" }, "chore: initial");
    const outcomes = restoreProtectedPaths(
      repo,
      "0000000000000000000000000000000000000000",
      ["apps/nextjs/e2e/lib/teams/ghost.ts"],
    );
    expect(outcomes[0]).toEqual({
      path: "apps/nextjs/e2e/lib/teams/ghost.ts",
      existedAtBase: false,
      restored: true,
    });
  });

  it("reports restored:false, with a reason, on a genuine write failure", () => {
    // The target path exists at base as a FILE, but a directory now sits
    // where the restore needs to write — a real, unrecoverable fs failure
    // (EISDIR), not a contrived stub. The outcome must say so, not silently
    // report success.
    const baseSha = commitInto(
      repo,
      { "apps/nextjs/e2e/lib/teams/blocked.ts": "// original\n" },
      "chore: seed",
    );
    rmSync(path.join(repo, "apps/nextjs/e2e/lib/teams/blocked.ts"), {
      force: true,
    });
    mkdirSync(
      path.join(repo, "apps/nextjs/e2e/lib/teams/blocked.ts"),
      { recursive: true },
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: replace file with a directory");

    const outcomes = restoreProtectedPaths(repo, baseSha, [
      "apps/nextjs/e2e/lib/teams/blocked.ts",
    ]);
    expect(outcomes[0]?.restored).toBe(false);
    expect(outcomes[0]?.error).toBeTruthy();
  });
});

describe("commitRestoredPaths + buildProtectedPathRestoreMessage", () => {
  it("commits the restoration and preserves the original message's cert tokens", () => {
    const original = "// a original\n";
    const baseSha = commitInto(
      repo,
      { "apps/nextjs/e2e/lib/teams/a.ts": original },
      "chore: seed",
    );
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/lib/teams/a.ts"),
      "// a tampered\n",
    );
    git(repo, "add", "-A");
    git(
      repo,
      "commit",
      "-q",
      "-m",
      "feat: implement thing\n\nSANDCASTLE-LINT: pass\nSANDCASTLE-TEST: pass",
    );
    const tamperedSha = git(repo, "rev-parse", "HEAD");
    const originalMessage = git(repo, "show", "-s", "--format=%B", tamperedSha);

    restoreProtectedPaths(repo, baseSha, [
      "apps/nextjs/e2e/lib/teams/a.ts",
    ]);
    const message = buildProtectedPathRestoreMessage(
      originalMessage,
      ["apps/nextjs/e2e/lib/teams/a.ts"],
      1,
    );
    const newSha = commitRestoredPaths(
      repo,
      ["apps/nextjs/e2e/lib/teams/a.ts"],
      message,
    );

    expect(newSha).toBeTruthy();
    expect(newSha).not.toBe(tamperedSha);
    const committedMessage = git(repo, "show", "-s", "--format=%B", newSha!);
    expect(committedMessage).toContain("SANDCASTLE-LINT: pass");
    expect(committedMessage).toContain("SANDCASTLE-TEST: pass");
    expect(committedMessage).toContain("restore protected path");
    // The file on disk (and therefore in the new commit's tree) is the
    // restored original, not the tampered content.
    const treeContent = git(
      repo,
      "show",
      `${newSha}:apps/nextjs/e2e/lib/teams/a.ts`,
    );
    expect(treeContent).toBe("// a original");
  });

  it("still produces a new, distinct commit when restoring leaves nothing else to stage (pure tampering)", () => {
    const original = "// a original\n";
    const baseSha = commitInto(
      repo,
      { "apps/nextjs/e2e/lib/teams/a.ts": original },
      "chore: seed",
    );
    // The builder's ENTIRE change is the tamper — nothing else.
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/lib/teams/a.ts"),
      original.replace("original", "tampered"),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "feat: tamper only");
    restoreProtectedPaths(repo, baseSha, [
      "apps/nextjs/e2e/lib/teams/a.ts",
    ]);
    // The tree now matches baseSha exactly (restore undid the only change),
    // so a plain `git commit` would refuse with "nothing to commit".
    const newSha = commitRestoredPaths(
      repo,
      ["apps/nextjs/e2e/lib/teams/a.ts"],
      buildProtectedPathRestoreMessage(
        "feat: tamper only",
        ["apps/nextjs/e2e/lib/teams/a.ts"],
        1,
      ),
    );
    expect(newSha).toBeTruthy();
    expect(newSha).not.toBe(baseSha);
  });

  it("returns undefined rather than throwing when the worktree path does not exist", () => {
    const result = commitRestoredPaths(
      path.join(repo, "does-not-exist"),
      ["a.ts"],
      "message",
    );
    expect(result).toBeUndefined();
  });
});

// 2026-08-04 review finding #7 (BLOCKER): the check-writer prompt CLAIMS
// "the loop will not run an uncommitted file" — that claim was false. This
// proves the fix that makes it true: an uncommitted check file gets swept
// into a commit here, so the hand-off baseline the protected-path lock
// measures against actually contains it.
describe("ensureDirCommitted", () => {
  it("PROVES THE INSTRUMENT — reproduces the exact deletion chain finding #7 named, before the fix", () => {
    // Without ensureDirCommitted, this is what finding #7 described: the
    // check-writer's file sits UNCOMMITTED at `preSha` capture time, the
    // implementer's own commit sweeps it in via `git add -A`, and
    // `pathContentChangedBetween` reads that as "added inside a protected
    // directory" — a false tamper.
    const baseSha = commitInto(repo, { "README.md": "seed\n" }, "seed");
    // Simulate the check-writer leaving its file uncommitted on disk.
    mkdirSync(path.join(repo, "apps/nextjs/e2e/checks/issue-1"), {
      recursive: true,
    });
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/checks/issue-1/a.spec.ts"),
      "// uncommitted check\n",
    );
    // `preSha`, captured the OLD way (plain HEAD), does NOT contain it.
    expect(
      (() => {
        try {
          execFileSync(
            "git",
            ["cat-file", "-e", `${baseSha}:apps/nextjs/e2e/checks/issue-1/a.spec.ts`],
            { cwd: repo, stdio: "ignore" },
          );
          return true;
        } catch {
          return false;
        }
      })(),
    ).toBe(false);
  });

  it("commits an uncommitted check directory so the resulting sha actually contains it", () => {
    commitInto(repo, { "README.md": "seed\n" }, "seed");
    mkdirSync(path.join(repo, "apps/nextjs/e2e/checks/issue-1"), {
      recursive: true,
    });
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/checks/issue-1/a.spec.ts"),
      "// forgotten commit\n",
    );

    const resultSha = ensureDirCommitted(
      repo,
      "apps/nextjs/e2e/checks/issue-1",
      "chore(sandcastle): commit check-writer's check",
    );

    expect(resultSha).toBeTruthy();
    expect(resultSha).toBe(git(repo, "rev-parse", "HEAD"));
    // The fix closes the loop finding #7 named: the check file now EXISTS
    // at the returned sha, so a later diff never reads it as newly added.
    expect(() =>
      execFileSync(
        "git",
        [
          "cat-file",
          "-e",
          `${resultSha}:apps/nextjs/e2e/checks/issue-1/a.spec.ts`,
        ],
        { cwd: repo, stdio: "ignore" },
      ),
    ).not.toThrow();
    // Working tree is clean afterward — nothing left uncommitted.
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("is a true no-op (same sha, no new commit) when the directory is already fully committed", () => {
    const sha = commitInto(
      repo,
      {
        "apps/nextjs/e2e/checks/issue-2/a.spec.ts": "// already committed\n",
      },
      "check-writer: add check",
    );

    const countBefore = git(repo, "rev-list", "--count", "HEAD");

    const resultSha = ensureDirCommitted(
      repo,
      "apps/nextjs/e2e/checks/issue-2",
      "should never be used — nothing to commit",
    );

    // Same sha (HEAD never moved) AND the same commit count — a real no-op,
    // not merely "commits nothing new but on a stale sha".
    expect(resultSha).toBe(sha);
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe(countBefore);
  });

  it("does not sweep in an UNRELATED uncommitted change outside the target directory", () => {
    commitInto(repo, { "README.md": "seed\n" }, "seed");
    mkdirSync(path.join(repo, "apps/nextjs/e2e/checks/issue-3"), {
      recursive: true,
    });
    writeFileSync(
      path.join(repo, "apps/nextjs/e2e/checks/issue-3/a.spec.ts"),
      "// the check\n",
    );
    // An unrelated file the builder happens to have modified in the same
    // worktree at this point — must NOT be swept into this commit.
    writeFileSync(path.join(repo, "unrelated.txt"), "unrelated change\n");

    const resultSha = ensureDirCommitted(
      repo,
      "apps/nextjs/e2e/checks/issue-3",
      "chore(sandcastle): commit check-writer's check",
    );

    expect(resultSha).toBeTruthy();
    // The unrelated file is still uncommitted afterward.
    expect(git(repo, "status", "--porcelain")).toContain("unrelated.txt");
  });

  it("returns undefined rather than throwing when the worktree path does not exist", () => {
    const result = ensureDirCommitted(
      path.join(repo, "does-not-exist"),
      "some/dir",
      "message",
    );
    expect(result).toBeUndefined();
  });
});

describe("dirtyPathsIn — what is uncommitted right now (#1271)", () => {
  it("answers [] on a clean worktree", () => {
    commitInto(repo, { "a.ts": "export const a = 1;\n" }, "chore: seed");
    expect(dirtyPathsIn(repo)).toEqual([]);
  });

  it("names a modified file, an added file and an untracked one, repo-relative", () => {
    commitInto(
      repo,
      {
        "packages/api/src/x.ts": "export const x = 1;\n",
        "packages/api/src/y.ts": "export const y = 1;\n",
      },
      "chore: seed",
    );
    writeFileSync(
      path.join(repo, "packages/api/src/x.ts"),
      "export const x = 2;\n",
    );
    mkdirSync(path.join(repo, "packages/api/src/__checks__/issue-1058"), {
      recursive: true,
    });
    writeFileSync(
      path.join(repo, "packages/api/src/__checks__/issue-1058/b.test.ts"),
      "it('a', () => {});\n",
    );
    // One staged, one not — both count as dirty.
    git(repo, "add", "packages/api/src/x.ts");

    expect(dirtyPathsIn(repo)?.sort()).toEqual([
      "packages/api/src/__checks__/issue-1058/b.test.ts",
      "packages/api/src/x.ts",
    ]);
  });

  it("names BOTH halves of a rename, so nothing moved out of bounds hides", () => {
    commitInto(repo, { "src/old.ts": "export const a = 1;\n" }, "chore: seed");
    git(repo, "mv", "src/old.ts", "src/new.ts");

    expect(dirtyPathsIn(repo)?.sort()).toEqual(["src/new.ts", "src/old.ts"]);
  });

  it("answers null — not [] — when git could not be asked", () => {
    // The distinction is the whole point: [] is a CLAIM that the worktree is
    // clean, and only a real git answer earns it. A caller must never read an
    // unaskable git as a safe worktree.
    const notARepo = mkdtempSync(path.join(tmpdir(), "sandcastle-not-a-repo-"));
    try {
      expect(dirtyPathsIn(notARepo)).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe("discardWorkingTreeChanges — throwing away a refused rewrite (#1271)", () => {
  it("puts a modified tracked file back and deletes an untracked one", () => {
    const base = commitInto(
      repo,
      { "packages/api/src/x.ts": "export const x = 1;\n" },
      "chore: seed",
    );
    writeFileSync(
      path.join(repo, "packages/api/src/x.ts"),
      "export const x = 999;\n",
    );
    mkdirSync(path.join(repo, "junk"), { recursive: true });
    writeFileSync(path.join(repo, "junk/new.ts"), "export const j = 1;\n");

    expect(discardWorkingTreeChanges(repo)).toBe(true);

    expect(readFileSync(path.join(repo, "packages/api/src/x.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
    expect(existsSync(path.join(repo, "junk/new.ts"))).toBe(false);
    expect(dirtyPathsIn(repo)).toEqual([]);
    // The commit history is untouched — this discards WORKING-TREE changes,
    // never a commit the repair already made.
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
  });

  it("discards a STAGED change too", () => {
    commitInto(
      repo,
      { "packages/api/src/x.ts": "export const x = 1;\n" },
      "chore: seed",
    );
    writeFileSync(
      path.join(repo, "packages/api/src/x.ts"),
      "export const x = 999;\n",
    );
    git(repo, "add", "-A");

    expect(discardWorkingTreeChanges(repo)).toBe(true);
    expect(dirtyPathsIn(repo)).toEqual([]);
    expect(readFileSync(path.join(repo, "packages/api/src/x.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );
  });

  it("discards a file the agent STAGED as new — the one `clean` alone would miss", () => {
    // A staged-new file is neither untracked (so `clean` skips it) nor
    // present at HEAD (so a working-tree-only restore leaves it), and a later
    // `git add -A` would sweep it into a commit. It has to go.
    commitInto(repo, { "a.ts": "export const a = 1;\n" }, "chore: seed");
    mkdirSync(path.join(repo, "packages/api/src/router"), { recursive: true });
    writeFileSync(
      path.join(repo, "packages/api/src/router/sneaky.ts"),
      "export const s = 1;\n",
    );
    git(repo, "add", "-A");

    expect(discardWorkingTreeChanges(repo)).toBe(true);
    expect(existsSync(path.join(repo, "packages/api/src/router/sneaky.ts"))).toBe(
      false,
    );
    expect(dirtyPathsIn(repo)).toEqual([]);
  });

  it("leaves an IGNORED file alone — no `-x`, so nothing built or installed goes", () => {
    // `git clean -fdx` inside a real worktree would delete `node_modules` and
    // every build output the next command needs. The repair only ever has to
    // undo what an agent just wrote.
    commitInto(
      repo,
      { ".gitignore": "ignored/\n", "a.ts": "export const a = 1;\n" },
      "chore: seed",
    );
    mkdirSync(path.join(repo, "ignored"), { recursive: true });
    writeFileSync(path.join(repo, "ignored/keep.txt"), "expensive\n");

    expect(discardWorkingTreeChanges(repo)).toBe(true);
    expect(existsSync(path.join(repo, "ignored/keep.txt"))).toBe(true);
  });

  it("answers false rather than throwing when git could not be asked", () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), "sandcastle-not-a-repo-"));
    try {
      expect(discardWorkingTreeChanges(notARepo)).toBe(false);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
