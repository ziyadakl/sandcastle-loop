/**
 * Tests for the replay helper (issue #1118, ruling 4), run against REAL temp
 * git repos with REAL commits. Mocking git here would prove nothing: every
 * claim this module makes ("the old bytes really came back", "node_modules
 * really survived", "a file the builder committed really is absent") is a
 * claim about git's own behaviour, and a stub would only prove that the stub
 * behaves as written.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
  clearReplaySentinel,
  readReplaySentinel,
  restoreDirFromSnapshot,
  snapshotDir,
  withWorktreeAt,
  worktreeContentHash,
} from "./worktree-replay.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sandcastle-worktree-replay-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Read a worktree file as text, or `undefined` when it is not on disk. */
function readIfPresent(rel: string): string | undefined {
  const full = path.join(repo, rel);
  return existsSync(full) ? readFileSync(full, "utf8") : undefined;
}

/**
 * The shape every test starts from: a pre-builder commit, then a "builder"
 * commit that edits the existing file and adds a new one. `.gitignore` is
 * committed at BOTH shas so the ignore rules are in force on either side of
 * the replay — an ignore rule that only exists at one sha would make
 * `node_modules` tracked on the other, which is not the situation the loop is
 * ever in.
 */
function seedPreAndPostBuilder(): { preSha: string; postSha: string } {
  const preSha = commitInto(
    repo,
    {
      ".gitignore": "node_modules/\n.next/\n*.log\n",
      "src/total.ts": "export const total = () => 0;\n",
    },
    "chore: the state the builder was handed",
  );
  const postSha = commitInto(
    repo,
    {
      "src/total.ts": "export const total = () => 1000;\n",
      "src/new-helper.ts": "export const helper = () => true;\n",
    },
    "feat: the builder's answer",
  );
  return { preSha, postSha };
}

describe("withWorktreeAt", () => {
  it("shows fn the pre-builder content and puts the builder's content back", async () => {
    const { preSha, postSha } = seedPreAndPostBuilder();

    let seenDuringReplay: string | undefined;
    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      seenDuringReplay = readIfPresent("src/total.ts");
      return "ran";
    });

    expect(seenDuringReplay).toBe("export const total = () => 0;\n");
    expect(result).toEqual({ kind: "ok", value: "ran" });
    expect(readIfPresent("src/total.ts")).toBe(
      "export const total = () => 1000;\n",
    );
  });

  it("hides a file the builder ADDED and COMMITTED, then brings it back", async () => {
    // The reason this module uses `read-tree -u --reset` rather than
    // `checkout <sha> -- .`: checkout only WRITES the paths present in the
    // named tree, so a file the builder added would still be sitting on disk
    // during the replay. A repaired check that imports the builder's new
    // module would then pass against the "pre-builder" state, and the guard
    // this whole helper exists to provide would be silently inverted.
    const { preSha, postSha } = seedPreAndPostBuilder();

    let helperPresentDuringReplay: boolean | undefined;
    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      helperPresentDuringReplay = existsSync(
        path.join(repo, "src/new-helper.ts"),
      );
    });

    expect(helperPresentDuringReplay).toBe(false);
    expect(result.kind).toBe("ok");
    expect(readIfPresent("src/new-helper.ts")).toBe(
      "export const helper = () => true;\n",
    );
  });

  it("leaves ignored build caches (node_modules, .next) untouched across the round trip", async () => {
    // Load-bearing for the one-hour per-ticket ceiling: removing these costs a
    // cold install and a cold compile.
    const { preSha, postSha } = seedPreAndPostBuilder();
    mkdirSync(path.join(repo, "node_modules/left-pad"), { recursive: true });
    writeFileSync(
      path.join(repo, "node_modules/left-pad/index.js"),
      "module.exports = 1;\n",
    );
    mkdirSync(path.join(repo, ".next"), { recursive: true });
    writeFileSync(path.join(repo, ".next/BUILD_ID"), "abc123\n");

    let cachePresentDuringReplay: boolean | undefined;
    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      cachePresentDuringReplay =
        existsSync(path.join(repo, "node_modules/left-pad/index.js")) &&
        existsSync(path.join(repo, ".next/BUILD_ID"));
    });

    expect(cachePresentDuringReplay).toBe(true);
    expect(result.kind).toBe("ok");
    expect(readIfPresent("node_modules/left-pad/index.js")).toBe(
      "module.exports = 1;\n",
    );
    expect(readIfPresent(".next/BUILD_ID")).toBe("abc123\n");
  });

  it("hides an UNTRACKED source file the builder left behind, and puts it back", async () => {
    // Untracked-but-not-ignored is builder work that simply never got
    // committed — the run has seen exactly that (`ensureDirCommitted` exists
    // because of it). It must be invisible during the replay, or the proof is
    // contaminated; and it must come back afterwards, or the helper destroys
    // work.
    const { preSha, postSha } = seedPreAndPostBuilder();
    writeFileSync(
      path.join(repo, "src/uncommitted.ts"),
      "export const forgotten = true;\n",
    );

    let presentDuringReplay: boolean | undefined;
    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      presentDuringReplay = existsSync(path.join(repo, "src/uncommitted.ts"));
    });

    expect(presentDuringReplay).toBe(false);
    expect(result.kind).toBe("ok");
    expect(readIfPresent("src/uncommitted.ts")).toBe(
      "export const forgotten = true;\n",
    );
  });

  it("sweeps away an untracked artefact the replay run itself created", async () => {
    // A check run leaves debris (screenshots, traces, a scratch file). Debris
    // that is not ignored would ride into the ship commit and strand the run's
    // final promotion, so the restore removes anything untracked that was not
    // there when the replay began.
    const { preSha, postSha } = seedPreAndPostBuilder();

    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      writeFileSync(path.join(repo, "replay-debris.txt"), "left over\n");
    });

    expect(result.kind).toBe("ok");
    expect(existsSync(path.join(repo, "replay-debris.txt"))).toBe(false);
  });

  it("restores the worktree even when fn throws, and reports the throw", async () => {
    const { preSha, postSha } = seedPreAndPostBuilder();

    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      throw new Error("the repaired check blew up");
    });

    expect(result.kind).toBe("fn-threw");
    if (result.kind === "fn-threw") {
      expect(result.error).toContain("the repaired check blew up");
    }
    // The whole point of the `finally`: a thrown proof must never leave the
    // worktree sitting on pre-builder code.
    expect(readIfPresent("src/total.ts")).toBe(
      "export const total = () => 1000;\n",
    );
    expect(readIfPresent("src/new-helper.ts")).toBe(
      "export const helper = () => true;\n",
    );
  });

  it("reports a FAILED restore as its own outcome, carrying no value", async () => {
    const { preSha, postSha } = seedPreAndPostBuilder();

    // Break the restore for real rather than by stubbing: while the replay is
    // running, destroy the objects `restoreToSha` is made of, so git genuinely
    // cannot put the builder's code back. The worktree is then left standing
    // on pre-builder code, which is the exact situation this outcome exists to
    // make unignorable — nothing measured afterwards means anything.
    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      git(repo, "reset", "-q", "--hard", preSha);
      git(repo, "reflog", "expire", "--expire=now", "--all");
      git(repo, "gc", "--prune=now", "-q");
      return "ran";
    });

    expect(result.kind).toBe("restore-failed");
    // The type must not offer a `value` on this branch — a caller cannot
    // reach the replay's answer without first proving it handled the failure.
    expect(Object.hasOwn(result, "value")).toBe(false);
    if (result.kind === "restore-failed") {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("refuses a worktree with uncommitted TRACKED changes rather than destroying them", async () => {
    // The helper puts tracked files back FROM `restoreToSha`. If the tree
    // carried tracked edits that are in no commit, there is nothing to put
    // them back from, so it declines before touching anything.
    const { preSha, postSha } = seedPreAndPostBuilder();
    writeFileSync(
      path.join(repo, "src/total.ts"),
      "export const total = () => 42; // hand edit\n",
    );

    const result = await withWorktreeAt(repo, preSha, postSha, () => "ran");

    expect(result.kind).toBe("dirty-at-entry");
    if (result.kind === "dirty-at-entry") {
      expect(result.dirtyPaths).toContain("src/total.ts");
    }
    expect(readIfPresent("src/total.ts")).toBe(
      "export const total = () => 42; // hand edit\n",
    );
  });
});

describe("worktreeContentHash", () => {
  // Prove the instrument before believing its silence: a hash that never
  // changed would make every restore look successful.
  it("changes when a tracked file changes and matches again when it is put back", () => {
    seedPreAndPostBuilder();
    const before = worktreeContentHash(repo);
    expect(before).toBeDefined();

    const original = readFileSync(path.join(repo, "src/total.ts"));
    writeFileSync(path.join(repo, "src/total.ts"), "// different\n");
    expect(worktreeContentHash(repo)).not.toBe(before);

    writeFileSync(path.join(repo, "src/total.ts"), original);
    expect(worktreeContentHash(repo)).toBe(before);
  });

  it("ignores files git ignores, so a warm node_modules never reads as drift", () => {
    seedPreAndPostBuilder();
    const before = worktreeContentHash(repo);
    mkdirSync(path.join(repo, "node_modules/left-pad"), { recursive: true });
    writeFileSync(path.join(repo, "node_modules/left-pad/index.js"), "1\n");
    expect(worktreeContentHash(repo)).toBe(before);
  });

  it("does not disturb the real index it borrows git from", () => {
    seedPreAndPostBuilder();
    writeFileSync(path.join(repo, "scratch.txt"), "untracked\n");
    worktreeContentHash(repo);
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(staged.trim()).toBe("");
  });
});

describe("the kill-window sentinel", () => {
  it("is set while the replay runs and cleared once the restore is proved", async () => {
    // The worktree stands on pre-builder code for a whole agent dispatch now,
    // not one check run. A run killed inside that window leaves the tree on
    // old code, and `commitWorktreeCheckpoint` there would `git add -A` and
    // commit the DELETION of the builder's whole night. The sentinel is the
    // only thing that can say the window was open.
    const { preSha, postSha } = seedPreAndPostBuilder();
    let seenInside: ReturnType<typeof readReplaySentinel>;

    expect(readReplaySentinel(repo, repo)).toBeUndefined();
    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      seenInside = readReplaySentinel(repo, repo);
      return "done";
    });

    expect(result.kind).toBe("ok");
    expect(seenInside).toBeDefined();
    expect(seenInside?.atSha).toBe(preSha);
    expect(seenInside?.restoreToSha).toBe(postSha);
    // Cleared only after the restore was PROVED, so its absence is a real
    // all-clear rather than a hopeful one.
    expect(readReplaySentinel(repo, repo)).toBeUndefined();
  });

  it("SURVIVES a restore that could not be proved", async () => {
    // The one case where the worktree may still be holding pre-builder code.
    // Clearing the sentinel here would tell the next process the window is
    // shut while it is still open.
    const { preSha, postSha } = seedPreAndPostBuilder();
    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      // A nested repository `git clean -fd` will not remove (that needs
      // `-ff`), so the tree cannot fingerprint back to what it was.
      const nested = path.join(repo, "scratch-clone");
      mkdirSync(nested, { recursive: true });
      git(nested, "init", "-q");
      return "done";
    });

    expect(result.kind).toBe("restore-failed");
    expect(readReplaySentinel(repo, repo)).toBeDefined();
    clearReplaySentinel(repo, repo);
    expect(readReplaySentinel(repo, repo)).toBeUndefined();
  });

  it("is readable from the repository root after the worktree is gone", () => {
    // Start-up reads it BEFORE the worktree exists, so it cannot be asked from
    // inside one. That is why it lives in the COMMON git directory and is
    // keyed by the worktree's path rather than written into the worktree.
    const wt = path.join(repo, "worktrees", "issue-1118");
    expect(readReplaySentinel(repo, wt)).toBeUndefined();
    clearReplaySentinel(repo, wt);
  });
});

describe("the untracked hold, and the sweep that used to destroy work", () => {
  it("does NOT sweep the builder's uncommitted files when the hold never completed", async () => {
    // `git clean -fd` ran UNCONDITIONALLY in the restore, and two paths reached
    // it with the builder's untracked files still on disk — a listing that
    // threw, and a move that threw part way down the list. Both destroyed
    // uncommitted builder work outright. The sweep is now skipped unless every
    // one of those files is safely held.
    //
    // Forced by making the FIRST file on the list impossible to move out of its
    // directory (a read-only parent defeats both the rename and the
    // remove-after-copy), so the hold throws before it ever reaches the second
    // file — which is real, uncommitted builder work sitting in the tree.
    const { preSha, postSha } = seedPreAndPostBuilder();
    mkdirSync(path.join(repo, "locked"), { recursive: true });
    writeFileSync(path.join(repo, "locked/first.ts"), "// listed first\n");
    writeFileSync(path.join(repo, "src/scratch.ts"), "// never committed\n");
    chmodSync(path.join(repo, "locked"), 0o555);

    let ran = false;
    try {
      const result = await withWorktreeAt(repo, preSha, postSha, () => {
        ran = true;
        return "must not run";
      });
      // THE BUILDER'S WORK IS STILL THERE. Asserted FIRST, because it is the
      // harm — a failing `kind` is a symptom, a deleted file is the loss.
      expect(readIfPresent("src/scratch.ts")).toBe("// never committed\n");
      // The revert never completed, so nothing was measured either way, and
      // the tree still fingerprints back to what it was.
      expect(ran).toBe(false);
      expect(result.kind).toBe("revert-failed");
    } finally {
      chmodSync(path.join(repo, "locked"), 0o755);
    }
  });
});

describe("carrying a directory out of the replay", () => {
  it("snapshots what was written inside, and writes it back afterwards", async () => {
    // The repaired check is authored INSIDE the replay and has to survive a
    // restore that is about to overwrite it. Leaving it on disk to survive
    // would break the content hash the restore is proved by — and a caller
    // could then not tell a deliberate carry-out from a failed restore, which
    // is the one distinction the helper exists to make. So it leaves in
    // memory.
    const { preSha, postSha } = seedPreAndPostBuilder();
    const result = await withWorktreeAt(repo, preSha, postSha, () => {
      mkdirSync(path.join(repo, "checks"), { recursive: true });
      writeFileSync(path.join(repo, "checks/one.ts"), "REPAIRED\n");
      return snapshotDir(repo, "checks");
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    const snapshot = result.value;
    expect(snapshot?.relPaths).toEqual(["one.ts"]);
    // The restore was total: the file it wrote is gone from the tree.
    expect(existsSync(path.join(repo, "checks/one.ts"))).toBe(false);

    expect(restoreDirFromSnapshot(repo, "checks", snapshot!)).toBe(true);
    expect(readIfPresent("checks/one.ts")).toBe("REPAIRED\n");
  });

  it("replaces the directory WHOLESALE rather than merging into it", () => {
    // A repaired check may rename or drop a file. Leaving the old one beside
    // the new one would run BOTH at ship time.
    mkdirSync(path.join(repo, "checks"), { recursive: true });
    writeFileSync(path.join(repo, "checks/old.ts"), "the ORIGINAL\n");
    const snapshot = snapshotDir(repo, "checks");
    expect(snapshot?.relPaths).toEqual(["old.ts"]);

    rmSync(path.join(repo, "checks/old.ts"));
    writeFileSync(path.join(repo, "checks/new.ts"), "REPAIRED\n");
    const rewritten = snapshotDir(repo, "checks");
    expect(restoreDirFromSnapshot(repo, "checks", rewritten!)).toBe(true);
    expect(existsSync(path.join(repo, "checks/old.ts"))).toBe(false);
    expect(readIfPresent("checks/new.ts")).toBe("REPAIRED\n");
  });
});
