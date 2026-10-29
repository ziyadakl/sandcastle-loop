/**
 * ROT-GUARD (#1260) — the worktree LOCK's wiring, read as TEXT.
 *
 * `main.worktree-cleanup.test.mts` drives the guard for real, against real git
 * worktrees. `lib/paths/worktree-lock.test.ts` drives the module's own
 * decisions. What NEITHER can reach is the question this file exists for: is
 * the lock actually PLUGGED IN?
 *
 * That gap is not theoretical. `main.worktree-cleanup.test.mts` takes the lock
 * ITSELF, in its `beforeEach`, because it is testing `cleanupIssueBranch` in
 * isolation. So if a future edit deletes the `lockWorktree` call in
 * `createSandboxRaw`, NOTHING in the loop ever locks anything,
 * `mayRemoveWorktree` answers `go` every time, the original #1260 destruction
 * is back — and all 28 of those tests still pass.
 *
 * Any edit that keeps `cleanupIssueBranch` but drops the lock is that silent
 * half-fix — a refactor, a bad merge, a hand-resolved conflict in this 30k-line
 * file. This file is what turns that silence into a failure. It follows the
 * shape `main.older-test-edit-wiring.test.mts` established for the same reason.
 *
 * Read as TEXT on purpose: `createSandboxRaw` is a closure inside
 * `buildDefaultDeps` and `runIssuePipeline` is not exported, so neither can be
 * called from here. A source-text pin is the only reader that reaches them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MAIN = readFileSync(
  path.join(import.meta.dirname, "main.mts"),
  "utf8",
);
const MAC_HOST = readFileSync(
  path.join(import.meta.dirname, "lib", "mac-host-sandbox.ts"),
  "utf8",
);

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("#1260 rot-guard — the lock is taken when a worktree is created", () => {
  it("main.mts takes the lock at exactly one site", () => {
    // More than one is not automatically wrong, but it means a second creation
    // site appeared and this guard's reasoning must be re-checked against it.
    // Anchored on the assignment, because the bare string `lockWorktree(` is
    // also a substring of every `unlockWorktree(` call.
    expect(occurrences(MAIN, "= lockWorktree(")).toBe(1);
  });

  it("the lock sits in createSandboxRaw, on the provider's own path", () => {
    // Both providers (docker and mac-host) route through `createSandboxRaw`,
    // so this ONE call is what covers every ticket on every host. The path is
    // the provider's own answer, never one derived from the branch name.
    expect(MAIN).toContain(
      "const lockPath = handle.worktreePath ?? worktreePathFor(spec.branch);",
    );
    expect(MAIN).toContain(
      "const locked = lockWorktree(args.repoRoot, lockPath, spec.branch, runGit);",
    );
  });

  it("a lock taken and then thrown past is released, not leaked", () => {
    // If anything between the lock and the return throws, `createSandbox`
    // never hands back a handle, so `runIssuePipeline` never assigns
    // `sandbox` and its `finally` skips the unlock. Without this catch the
    // lock outlives the ticket for good on a branch that is never retried.
    //
    // Pinning the catch TEXT alone would be nearly vacuous — it would still
    // pass if the `try` enclosed nothing. So assert the ORDER instead: the
    // lock, then the `try`, then the region it protects, then the catch that
    // releases, then the return. A statement added outside that span is the
    // regression this exists to catch.
    const lockAt = MAIN.indexOf("const locked = lockWorktree(");
    const tryAt = MAIN.indexOf("try {", lockAt);
    const guardedAt = MAIN.indexOf("writeSandboxAgentSettings(handle", tryAt);
    const catchAt = MAIN.indexOf("} catch (afterLock) {", tryAt);
    const releaseAt = MAIN.indexOf(
      "unlockOwnWorktree(args.repoRoot, spec.branch, runGit);",
      catchAt,
    );
    const rethrowAt = MAIN.indexOf("throw afterLock;", releaseAt);

    for (const at of [lockAt, tryAt, guardedAt, catchAt, releaseAt, rethrowAt])
      expect(at).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(tryAt);
    expect(tryAt).toBeLessThan(guardedAt);
    expect(guardedAt).toBeLessThan(catchAt);
    // The original error is rethrown unchanged, never swallowed or rewrapped.
    expect(releaseAt).toBeLessThan(rethrowAt);
  });
});

describe("#1260 rot-guard — the lock is released, and only by its owner", () => {
  it("every unlock in main.mts is the branch-keyed, ownership-checked one", () => {
    // `unlockWorktree` takes a PATH and asks nothing about who owns the lock.
    // A path derived from a branch name can be the wrong one, which is the
    // hazard this whole fix closes, so no call site may use it directly —
    // only `cleanupIssueBranch`, which has already resolved the path FROM GIT
    // and checked ownership through `mayRemoveWorktree`.
    expect(occurrences(MAIN, "unlockOwnWorktree(")).toBe(3);
    // The ONLY path-based unlock left in the file is cleanup's own, and it
    // runs on a path git reported after `mayRemoveWorktree` cleared it.
    // (The import lists the name without a paren, so it is not counted here.)
    expect(occurrences(MAIN, "unlockWorktree(repoRoot, wtPath, git)")).toBe(1);
    // `unlockOwnWorktree` is a DIFFERENT string, so this count is the
    // path-based sites alone: exactly one, inside cleanup.
    expect(occurrences(MAIN, "unlockWorktree(")).toBe(1);
  });

  it("the restart pre-clean unlocks OUTSIDE the directory-exists gate", () => {
    // A killed run can leave the registration locked with its directory gone.
    // Gate the unlock on the directory and nothing can ever clear it: prune
    // refuses a locked worktree, so the next `git worktree add` dies on
    // "a missing but locked worktree" and the branch is wedged for good.
    // Measured on git 2.39.5. The unlock must therefore come BEFORE the
    // `if (existsSync(wtPath))` it used to sit inside.
    const unlockAt = MAIN.indexOf(
      "if (unlockOwnWorktree(args.repoRoot, spec.branch, runGit)",
    );
    const gateAt = MAIN.indexOf("if (existsSync(wtPath)) {");
    expect(unlockAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(unlockAt).toBeLessThan(gateAt);

    const macUnlockAt = MAC_HOST.indexOf("unlockOwnWorktree(repoRoot, branch");
    const macGateAt = MAC_HOST.indexOf("if (existsSync(wtPath)) {");
    expect(macUnlockAt).toBeGreaterThan(-1);
    expect(macUnlockAt).toBeLessThan(macGateAt);
  });

  it("a refused unlock is never silent on either provider", () => {
    // On a refusal the remove fails, `rmSync` cannot touch the registration
    // and prune cannot clear it, so the branch stops working. Saying nothing
    // leaves no trace of why.
    expect(MAIN).toContain("something this loop did not lock");
    expect(MAC_HOST).toContain("this loop did not lock");
  });

  it("the restart pre-clean releases the lock before removing", () => {
    // `git worktree remove --force` REFUSES a locked worktree. Without this,
    // every restart after a `kill -9` falls through to the blind `rmSync` and
    // orphans the registration.
    expect(MAIN).toContain(
      'if (unlockOwnWorktree(args.repoRoot, spec.branch, runGit) === "refused") {',
    );
  });

  it("the pipeline releases the lock before the SDK's own close", () => {
    // The SDK's `close()` ends in `git worktree remove --force` and SWALLOWS
    // the failure. Skip this unlock and every finished ticket leaves its
    // worktree and its lock on disk, where the later cleanup cannot remove
    // them either. The unlock must come BEFORE the close, not after.
    const finallyBlock = MAIN.slice(
      MAIN.indexOf("unlockOwnWorktree(ctx.args.repoRoot, ctx.issue.branch"),
    );
    expect(finallyBlock.slice(0, 400)).toContain("await sandbox.close();");
  });

  it("the mac-host pre-clean releases the lock too, keyed on the branch", () => {
    expect(MAC_HOST).toContain(
      'if (unlockOwnWorktree(repoRoot, branch, lockGit) === "refused") {',
    );
    // It must receive the branch — a path alone cannot be ownership-checked.
    expect(occurrences(MAC_HOST, "preCleanWorktree(repoRoot, wtPath, spec.branch)")).toBe(2);
  });

  it("mac-host reuses the repo's canonical git runner, not a fourth copy", () => {
    // `makeSyncGitRunner` (lib/state/git-runner-adapter.ts) is documented as
    // the extraction of this very file's inline runner. A hand-rolled
    // try/catch here would be that duplication coming back.
    expect(MAC_HOST).toContain("makeSyncGitRunner()(cwd, ...gitArgs)");
  });
});

describe("#1260 rot-guard — the cleanup cannot guess a path", () => {
  it("cleanupIssueBranch asks git which worktree holds the branch", () => {
    expect(MAIN).toContain("const permission = mayRemoveWorktree(");
    expect(MAIN).toContain("findRegisteredWorktree(repoRoot, branch, git),");
  });

  it("a refusal returns without touching the worktree OR the branch", () => {
    // A branch whose worktree is still standing may still be in use, so the
    // branch delete must not run either.
    expect(MAIN).toContain('return "skipped-worktree-locked";');
  });

  it("the derived path is never used as a fallback for the removal", () => {
    // `worktreePathFor(branch)` inside cleanup is exactly the guess that can
    // name another ticket's live folder. Step 1 is skipped whole instead.
    const body = MAIN.slice(
      MAIN.indexOf("export function cleanupIssueBranch("),
      MAIN.indexOf("// Step 2: SHA-pinned branch delete."),
    );
    // Comments stripped first: this section's own prose NAMES the forbidden
    // call to explain why it is forbidden, and a raw substring match would
    // read that explanation as the violation it warns against.
    const code = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toContain("worktreePathFor(");
    expect(code).toContain("if (wtPath !== undefined) {");
  });
});

describe("#1260 rot-guard — the prior-incident comment carries its correction", () => {
  it("the disproven prune claim is corrected at its own site", () => {
    // The sentence "NEVER removes a live/healthy worktree" was the documented
    // decision this fix disproved. Leaving it standing sends the next reader
    // of the pruning code the wrong answer, whatever CLAUDE.md says elsewhere.
    expect(MAIN).not.toContain("NEVER removes a live/healthy worktree");
    expect(MAIN).not.toContain("never touches a live/healthy worktree");
    expect(MAIN).toContain("CORRECTED 2026-09-11 (issue #1260)");
  });
});
