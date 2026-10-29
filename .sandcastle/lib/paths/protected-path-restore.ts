/**
 * The IO half of the protected-path lock (issue #909 / Piece C) — putting a
 * tampered protected path back exactly as it was handed to the builder, then
 * building the commit that ships that restoration.
 *
 * Kept out of `protected-paths.ts` on purpose: that module is pure (no IO, no
 * git, no fs) and stays trivially unit-testable; everything here needs a real
 * worktree and is exercised in its test file against a REAL temp git repo
 * (`__fixtures__/git-repo.ts`), matching how `main.ship.test.mts` proves the
 * diff-measurement machinery against real commits rather than stubs.
 *
 * ## What "restore" means, precisely
 *
 * Two cases, both handled here:
 *
 *   - The protected path existed at the base commit (`baseSha`) and the
 *     builder EDITED it → its content is overwritten, byte-for-byte, with
 *     the blob `git show <baseSha>:<path>` returns.
 *   - The protected path did NOT exist at `baseSha` (the builder ADDED a new
 *     file inside a protected directory, e.g. a seventh practice-world team
 *     file) → it is deleted. "Restore" here means "put the tree back to what
 *     the builder was handed", and the builder was handed no such file.
 *
 * Every restore is independently VERIFIED after the write (re-read the file,
 * or re-check its absence) rather than trusted — a silent write failure must
 * never be reported as a successful restore, because the caller's whole
 * decision (ship vs. quarantine) turns on `restored` being true.
 *
 * ## Why plain `execFileSync`/`fs`, not the sandbox's injected exec
 *
 * `main.mts`'s own `captureSha` reads `worktreePath` with a bare
 * `execFileSync("git", …, { cwd: worktreePath })` — no sandbox exec, no
 * Docker round-trip — because a per-issue worktree is a real, host-visible
 * directory (bind-mounted, for the Docker sandbox provider; literally the
 * same filesystem, for `mac-host`). This module follows that exact
 * precedent rather than inventing a second way to touch the worktree.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentIdentityArgs } from "../git/identity.js";

/** One protected path's restore outcome. */
export interface RestoredPathOutcome {
  readonly path: string;
  /** Did this path exist in the tree at `baseSha`? Distinguishes "content
   *  overwritten back to the original" from "file removed — it never
   *  existed at the point the builder was handed the work". */
  readonly existedAtBase: boolean;
  /** VERIFIED true — the worktree now matches `baseSha` for this path,
   *  confirmed by re-reading it (or re-checking its absence), not merely
   *  "the write call didn't throw". False on any git/fs failure. */
  readonly restored: boolean;
  readonly error?: string;
}

/** Does `filePath` exist in the tree at `sha`? Never throws: `git cat-file -e`
 *  exits non-zero for "absent", which is a normal, expected outcome here, not
 *  a failure — so it is caught and folded into the boolean return. */
function existedAtSha(
  worktreePath: string,
  sha: string,
  filePath: string,
): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}:${filePath}`], {
      cwd: worktreePath,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Read `filePath`'s raw bytes at `sha`, or `undefined` if the blob can't be
 *  read (missing, or a git failure of any kind). Deliberately unencoded — a
 *  protected path is not guaranteed to be UTF-8 text, and forcing a text
 *  encoding here is exactly the kind of "byte-for-byte" promise a caller
 *  cannot verify. */
export function readBlobAt(
  worktreePath: string,
  sha: string,
  filePath: string,
): Buffer | undefined {
  try {
    return execFileSync("git", ["show", `${sha}:${filePath}`], {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/**
 * Did `filePath` actually CHANGE (content or existence) between `fromSha`
 * and `toSha`? Used by `enforceProtectedPaths` (`main.mts`, issue #914
 * hardening) to filter a path-glob violation down to a REAL one.
 *
 * WHY THIS EXISTS. `shipDiffBase` (`lib/review/diff-measurement.ts`)
 * deliberately measures from the issue branch's FORK POINT, not from
 * `preSha` — that is load-bearing for its own telemetry-spanning purpose
 * (see its own extensive doc comment on the two "never narrower" regimes).
 * But the check-writer stage (issue #911) advances `preSha` PAST its own
 * commit before the builder ever runs, so the fork-point-based measurement
 * ALWAYS includes that commit's files — which live inside the now-
 * protected per-issue check directory. Without this filter, EVERY ticket
 * with a real `CHECKS_WRITTEN` check reads as tampered on its own
 * check-writer's hand-off commit, making `noteChecksTampered()`'s count —
 * "whether the lock is holding" — fire on every single ticket regardless
 * of whether the builder touched anything.
 *
 * The fix is scoped here, not in `shipDiffBase` itself: that function's
 * fork-point reach is CORRECT and still needed for genuine tamper
 * detection across a checkpoint RESUME (a previous, interrupted session's
 * commits between the true fork point and the current `preSha` have never
 * been checked by `enforceProtectedPaths`, because ship-time gates only
 * run once, at the end of a full pipeline pass — narrowing the base to
 * `preSha..postSha` would make that historical window permanently
 * unreachable). Filtering by ACTUAL content difference at the specific
 * path, instead, keeps that wider reach for genuine tampering while
 * excluding a file the check-writer added earlier in the SAME dispatch
 * that the builder never subsequently touched.
 *
 * Fails SAFE like every other function in this file: any ambiguity (a
 * git-read failure on a path `existedAtSha` says exists) resolves to
 * `true` — "changed", i.e. still a violation. A broken read must never
 * let a real tamper slip through silently.
 */
export function pathContentChangedBetween(
  worktreePath: string,
  fromSha: string,
  toSha: string,
  filePath: string,
): boolean {
  const existedBefore = existedAtSha(worktreePath, fromSha, filePath);
  const existedAfter = existedAtSha(worktreePath, toSha, filePath);
  if (existedBefore !== existedAfter) return true; // added or removed — real change
  if (!existedBefore && !existedAfter) return false; // never existed on either side
  const before = readBlobAt(worktreePath, fromSha, filePath);
  const after = readBlobAt(worktreePath, toSha, filePath);
  if (before === undefined || after === undefined) return true; // exists per existedAtSha but unreadable — fail safe
  return !before.equals(after);
}

/**
 * Restore every path in `paths` to exactly what it was at `baseSha`, inside
 * `worktreePath`. Total and never-throwing per path: one path's git/fs
 * failure is recorded on ITS OWN outcome (`restored: false`) and does not
 * abort the rest — a caller iterating several tampered files should see every
 * one's real result, not lose the whole batch to the first failure.
 *
 * Does NOT stage or commit anything — see {@link commitRestoredPaths} for
 * that, kept separate so a caller can inspect every outcome before deciding
 * whether it is safe to commit at all.
 */
export function restoreProtectedPaths(
  worktreePath: string,
  baseSha: string,
  paths: readonly string[],
): RestoredPathOutcome[] {
  const out: RestoredPathOutcome[] = [];
  for (const p of paths) {
    const full = path.join(worktreePath, p);
    const existedAtBase = existedAtSha(worktreePath, baseSha, p);
    if (existedAtBase) {
      const blob = readBlobAt(worktreePath, baseSha, p);
      if (blob === undefined) {
        out.push({
          path: p,
          existedAtBase: true,
          restored: false,
          error: `could not read the original blob for ${p} at ${baseSha}`,
        });
        continue;
      }
      try {
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, blob);
        const after = existsSync(full) ? readFileSync(full) : undefined;
        out.push({
          path: p,
          existedAtBase: true,
          restored: after !== undefined && after.equals(blob),
        });
      } catch (err) {
        out.push({
          path: p,
          existedAtBase: true,
          restored: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      try {
        if (existsSync(full)) rmSync(full, { force: true });
        out.push({
          path: p,
          existedAtBase: false,
          restored: !existsSync(full),
        });
      } catch (err) {
        out.push({
          path: p,
          existedAtBase: false,
          restored: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return out;
}

/**
 * Commit whatever is currently UNCOMMITTED inside `dirPath`, on top of
 * `worktreePath`'s current HEAD (2026-08-04 review finding #7, BLOCKER).
 *
 * ## The hole this closes
 *
 * `check-writer-prompt.md` tells the check-writer agent to commit its check
 * file, and `main.mts`'s `runCheckWriterStage` used to just trust that —
 * capturing whatever HEAD happened to be as the builder's hand-off
 * `preSha`. If the agent forgot: the check file sat on disk, uncommitted,
 * at that capture point, so `existedAtSha(preSha, checkPath)` reads FALSE
 * for it. The implementer's own commit later sweeps the still-uncommitted
 * file in (an ordinary `git add -A` picks up whatever is on disk), so at
 * `postSha` the file exists. `pathContentChangedBetween` then sees
 * `existedBefore !== existedAfter` — "added inside a protected directory" —
 * and `restoreProtectedPaths` DELETES it (the `existedAtBase: false`
 * branch), because "restore" for a path absent at base means "put the tree
 * back to having no such file". The harness then runs a check file that no
 * longer exists, the ticket dies as `stopped:could-not-grade` blaming the
 * app, and the tamper counter — "the one number that says whether the lock
 * is holding" — is poisoned by a false positive.
 *
 * ## The fix
 *
 * Never trust the prompt's claim. Make it true instead: commit the check
 * directory HERE, as part of establishing the hand-off baseline, whether or
 * not the check-writer agent remembered to. A directory that is already
 * fully committed is a genuine no-op (no `--allow-empty`, unlike
 * {@link commitRestoredPaths} — that function's empty-commit case is a
 * REAL restore of a REAL tamper that happened to leave nothing staged;
 * this one is "nothing to do", not an event worth a commit).
 *
 * Returns the resulting HEAD sha — the SAME sha as before when there was
 * nothing to commit — or `undefined` on any git failure, mirroring every
 * other function in this file's "never throws" contract; the caller decides
 * what an uncommittable hand-off means.
 */
export function ensureDirCommitted(
  worktreePath: string,
  dirPath: string,
  message: string,
): string | undefined {
  try {
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "--", dirPath],
      { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (status.trim().length > 0) {
      execFileSync("git", ["add", "-A", "--", dirPath], {
        cwd: worktreePath,
        stdio: "ignore",
      });
      // `-c` identity, not repo config: see `lib/git/identity.ts`. This runs
      // host-side, and code the agent wrote must never land under the owner's
      // name.
      execFileSync(
        "git",
        [...agentIdentityArgs(), "commit", "--no-gpg-sign", "-m", message],
        { cwd: worktreePath, stdio: "ignore" },
      );
    }
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Which paths are UNCOMMITTED in `worktreePath` right now — modified, staged,
 * or untracked (issue #1271).
 *
 * ## What it is for
 *
 * The sibling-check repair dispatches an agent into a live worktree and then
 * has to answer two questions no diff between two commits can answer. Before
 * it starts: is the worktree already dirty, in which case whatever the agent
 * leaves behind cannot be told apart from what was there first, and the repair
 * must not run at all. Afterwards: did the agent leave an edit UNCOMMITTED
 * somewhere it was not allowed to touch? A diff between the two commits sees
 * only what got committed, so an out-of-bounds edit left on disk would pass
 * the confinement rule and then be swept into a later commit by an ordinary
 * `git add -A`.
 *
 * BOTH HALVES OF A RENAME are named. `git status --porcelain -z` prints a
 * rename as the new path followed by the original as its own NUL-terminated
 * field; reporting only the new one would let a file MOVED out of the
 * authorised directory read as a single in-bounds change.
 *
 * `-uall` is load-bearing too. Git's default collapses an untracked DIRECTORY
 * into one `dir/` entry, so an agent that wrote four new files into a new
 * folder would be reported as having touched one path that is not a file at
 * all. The confinement rule compares these against an exact-path allowlist,
 * and it has to be comparing real files.
 *
 * `null` — not `[]` — when git could not be asked, exactly as
 * `removedTestFiles` distinguishes them: an empty list is a CLAIM that the
 * worktree is clean, and only a real git answer earns it. A caller must never
 * read an unaskable git as a safe worktree.
 */
export function dirtyPathsIn(worktreePath: string): string[] | null {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain", "-z", "-uall"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  const fields = out.split("\0");
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined): void => {
    if (typeof p !== "string" || p.length === 0) return;
    if (seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i];
    // The final field after the last NUL is empty; so is an empty listing.
    if (entry === undefined || entry.length === 0) continue;
    // Porcelain v1: two status characters, a space, then the path.
    const status = entry.slice(0, 2);
    add(entry.slice(3));
    if (status[0] === "R" || status[0] === "C") {
      // The ORIGINAL path follows as its own field.
      i += 1;
      add(fields[i]);
    }
  }
  return paths;
}

/**
 * Throw away every UNCOMMITTED change in `worktreePath` — the refused
 * sibling-check rewrite's undo (issue #1271).
 *
 * A hard reset to the CURRENT commit (no ref named, so `HEAD` does not move)
 * puts the index and every tracked file back; `git clean -fd` removes the
 * files and directories the agent added. Returns `true` only when both
 * succeeded.
 *
 * **Why a hard reset and not `git checkout -- .`**, which is the obvious pair
 * with `clean` and which this road's design note first named: `git checkout
 * -- .` restores the working tree FROM THE INDEX, so a change the agent
 * STAGED is written back rather than discarded, and a file it staged as new
 * survives `clean` too (it is no longer untracked). Those are precisely the
 * edits a later `git add -A` would sweep into a commit — the case this exists
 * to close. The reset moves no commit and loses no history; it only makes the
 * tree match the commit already checked out.
 *
 * **No `-x`, deliberately.** A real per-issue worktree carries `node_modules`,
 * build output and other ignored material that the next command in the run
 * needs and that costs minutes to rebuild. The only thing this has to undo is
 * what an agent just wrote, and that is never ignored.
 *
 * **What bounds the reach is the caller's precondition, not this function:**
 * the sibling repair refuses to start at all unless {@link dirtyPathsIn} says
 * the worktree is CLEAN, so everything thrown away here was written by the
 * dispatch being undone.
 *
 * It cannot un-commit anything, and that is the stated limit of the rule it
 * enforces: a rewrite the agent already COMMITTED out of bounds stays on the
 * ticket branch, which is never merged when the repair is refused — the same
 * position {@link ensureDirCommitted}'s caller is already in.
 */
export function discardWorkingTreeChanges(worktreePath: string): boolean {
  try {
    execFileSync("git", ["reset", "--hard"], {
      cwd: worktreePath,
      stdio: "ignore",
    });
    execFileSync("git", ["clean", "-fd"], {
      cwd: worktreePath,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compose the commit message for a restore commit. The ENTIRE original
 * message is preserved verbatim beneath the restore explanation — not
 * paraphrased, not trimmed to "the lint/test cert lines" — for two reasons:
 * it is simplest and cannot silently drop a token gate downstream (the
 * `SANDCASTLE-LINT: pass` / `SANDCASTLE-TEST: pass` cert regexes
 * (`main.mts` `commitMessageHasLintCert`/`commitMessageHasTestCert`) just
 * substring-match, so a token anywhere in this message still satisfies them,
 * and the restore never invalidates a certification the builder made
 * honestly before it tampered.
 */
export function buildProtectedPathRestoreMessage(
  originalMessage: string,
  restoredPaths: readonly string[],
  tamperCount: number,
): string {
  const list = restoredPaths.map((p) => `  - ${p}`).join("\n");
  return (
    `chore(sandcastle): restore protected path(s) the builder tampered with\n\n` +
    `The loop's protected-path lock (issue #909) found ${restoredPaths.length} ` +
    `changed file(s) inside a path this ticket is not allowed to edit — tamper ` +
    `#${tamperCount} recorded against this ticket. Their content has been put ` +
    `back byte-for-byte from the commit the builder was handed:\n${list}\n\n` +
    `SANDCASTLE-PROTECTED-PATH-RESTORE: ${restoredPaths.length}\n\n` +
    `--- original commit message follows, preserved for its certification tokens ---\n` +
    `${originalMessage}`
  );
}

/**
 * Stage exactly the restored paths (nothing else — an unrelated uncommitted
 * change in the worktree, if one ever existed, must not be swept in) and
 * commit them on top of the current `HEAD`. `--allow-empty` matters: if the
 * ONLY thing the builder touched was the protected path (a pure tampering
 * attempt, no real work), restoring it can leave nothing staged relative to
 * the index, and git's ordinary refusal ("nothing to commit") would silently
 * leave the tampered content shipping as the tip commit. Returns the new
 * commit's sha, or `undefined` on any git failure (never throws — the
 * caller decides what an unrestorable ticket means).
 */
export function commitRestoredPaths(
  worktreePath: string,
  restoredPaths: readonly string[],
  message: string,
): string | undefined {
  try {
    execFileSync("git", ["add", "-A", "--", ...restoredPaths], {
      cwd: worktreePath,
      stdio: "ignore",
    });
    // `-c` identity, not repo config: see `lib/git/identity.ts`.
    execFileSync(
      "git",
      [
        ...agentIdentityArgs(),
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        message,
      ],
      { cwd: worktreePath, stdio: "ignore" },
    );
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}
