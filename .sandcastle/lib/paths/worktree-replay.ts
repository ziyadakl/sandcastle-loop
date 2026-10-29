/**
 * Put the worktree back to the code as it stood BEFORE the builder ran, run
 * something against it, then put the worktree back exactly as it was
 * (issue #1118, ruling 4).
 *
 * ## Why this exists
 *
 * A repaired check has to PROVE it is a correction and not a weakening: it
 * must fail against the broken state before it is allowed to pass against the
 * fixed one. A check that passes on everything, the pre-builder state
 * included, is the single failure the judge exists to stop, and the design
 * lock named it explicitly. Proving it needs the run to be able to stand the
 * worktree back up on old code and run a check there.
 *
 * ## WHAT RUNS INSIDE THE REPLAY, AND WHAT NO LONGER DOES
 *
 * **A check run. Not an agent dispatch.** This module's doc described the
 * opposite for a day, and that design is deleted.
 *
 * The very first build committed the rewritten check FIRST and replayed
 * afterwards. `read-tree -u --reset <preSha>` then overwrote the rewrite with
 * the ORIGINAL check, so the proof executed the original against code it had
 * already been proved red against — red essentially always, every rewrite
 * certified. The fix tried next was to dispatch the CHECK-WRITER inside the
 * replay, on the ground that the builder's code would then not be on disk for
 * it to copy.
 *
 * That ground was abandoned on measurement rather than on taste. Hiding the
 * finished code cannot be enforced inside a git repository — `git show
 * HEAD:<path>` reaches it from any worktree state, and the sandbox mounts the
 * whole object store. What is withheld now is the GRADING RULE, which METR
 * measured as the variable that matters, and the rewrite is authored on the
 * ordinary worktree in plain sight of the finished code. The replay's only job
 * is what it was built for: put the tree on the pre-builder commit, run the
 * ALREADY-WRITTEN check there, put the tree back, and prove by content hash
 * that it went back.
 *
 * ## The cost, stated plainly
 *
 * The window is one check run, not an agent dispatch — seconds to minutes,
 * bounded by the runner's own budget. A kill inside it still leaves a worktree
 * standing on old code; {@link readReplaySentinel} is what recognises that, and
 * `commitWorktreeCheckpoint` refuses to checkpoint while it is set, because
 * `git add -A` in that window commits the DELETION of the builder's whole night
 * and that commit is what a resume materialises.
 *
 * ## Why it lives HERE
 *
 * `protected-path-restore.ts`, its neighbour, already does the narrow version
 * of this: read a blob at an arbitrary sha, write it into the LIVE worktree,
 * verify the write rather than trust it. This module is the same act widened
 * from a handful of named paths to the whole tree, so it follows that file's
 * conventions exactly — plain `execFileSync` against a real, host-visible
 * worktree (see that file's note on why, not the sandbox's injected exec);
 * never throwing; verifying every claim it makes.
 *
 * ## Why `read-tree -u --reset`, not `checkout <sha> -- .`
 *
 * `git checkout <sha> -- .` only WRITES the paths present in that tree. A file
 * the builder ADDED and committed is in no such path, so it survives on disk
 * and the "pre-builder state" silently still contains builder work. A repaired
 * check importing that new module would then pass against the state it was
 * supposed to fail against — the guard inverted, quietly, which is worse than
 * no guard. `git read-tree -u --reset <sha>` makes the index and worktree
 * MATCH the tree, deleting what the tree does not have, without moving HEAD.
 *
 * ## What it deliberately does NOT touch
 *
 * Files git ignores — `node_modules`, `.next`, browser and build caches. They
 * are the machine's cache, never the builder's answer to the ticket, and
 * clearing them would cost the ticket a cold install and a cold compile
 * against a one-hour ceiling. A stale cache cannot make a broken check pass:
 * every input that decides the check's verdict (`package.json` included) is
 * tracked, so it reverts with everything else.
 *
 * ## Untracked, NOT ignored — the honesty question
 *
 * A source file the builder wrote and never committed is builder work sitting
 * on disk (the run has seen exactly that: `ensureDirCommitted` in
 * `protected-path-restore.ts` exists because a check file was left
 * uncommitted). Left in place it contaminates the proof in precisely the way
 * an added-and-committed file would. So those files are MOVED OUT for the
 * duration and moved back afterwards — hidden from the replay, and not
 * destroyed by it. Anything untracked the replay run itself creates
 * (screenshots, traces, scratch files) is swept away on the way out, because
 * debris that is not ignored would otherwise ride into the ship commit and
 * strand the run's final promotion.
 *
 * ## The one precondition
 *
 * Tracked files must be committed at `restoreToSha` when the call begins.
 * Tracked edits that live in no commit cannot be put back from anywhere, so
 * rather than destroy them the helper declines up front
 * (`kind: "dirty-at-entry"`). The index's staged/unstaged split is likewise
 * not preserved — restoring content is the promise, not restoring the index's
 * shape — which is safe precisely because that precondition holds.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * What a replay came to. A discriminated union on purpose: `value` exists on
 * exactly one branch, so a caller cannot reach the replay's answer without
 * first narrowing — and therefore cannot read the answer while ignoring a
 * restore that failed. A failed restore that ships is far worse than never
 * having tried, so it must be impossible to skip past.
 */
export type WorktreeReplayResult<T> =
  | {
      /** Reverted, ran, restored — and the restore was VERIFIED, not assumed. */
      readonly kind: "ok";
      readonly value: T;
    }
  | {
      /** Declined before touching anything: tracked edits that are in no
       *  commit would have been destroyed. Nothing was changed. */
      readonly kind: "dirty-at-entry";
      readonly dirtyPaths: readonly string[];
    }
  | {
      /** Could not stand the worktree up on `atSha`. `fn` never ran. The
       *  restore still ran and was verified, so the worktree is safe — the
       *  caller has simply learnt nothing and must not treat that as proof. */
      readonly kind: "revert-failed";
      readonly error: string;
    }
  | {
      /** `fn` threw. The restore ran and was verified, so the worktree is
       *  safe. A thrown proof is not a passed proof. */
      readonly kind: "fn-threw";
      readonly error: string;
    }
  | {
      /** THE DANGEROUS ONE. The worktree does not demonstrably match what the
       *  caller handed over, so it may still be sitting on pre-builder code.
       *  A caller seeing this must STOP THE TICKET; nothing measured after
       *  this point means anything. */
      readonly kind: "restore-failed";
      readonly error: string;
      /** Whatever the tree still disagrees with `restoreToSha` about, for the
       *  stop reason the owner reads. Empty when git could not be asked. */
      readonly dirtyPaths: readonly string[];
      /** A revert failure or an `fn` throw that happened first, if one did —
       *  kept so the real cause is not buried under its consequence. */
      readonly precedingError?: string;
    };

/** Run git in `worktreePath` and return trimmed stdout. Throws on non-zero. */
function git(
  worktreePath: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): string {
  return execFileSync("git", [...args], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  }).trim();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The worktree's real git directory — for a linked worktree that is NOT
 *  `<worktree>/.git`, which is a file there. `undefined` when git cannot be
 *  asked. */
function gitDirOf(worktreePath: string): string | undefined {
  try {
    return git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
  } catch {
    return undefined;
  }
}

/**
 * What a replay leaves behind while it is in flight, so a LATER process can
 * tell that the worktree may be standing on pre-builder code.
 *
 * ## Why anything is written down at all
 *
 * Between the revert and the verified restore the worktree holds the code the
 * builder was HANDED, not the code it wrote. `commitWorktreeCheckpoint` does
 * `git add -A` and commits, and it is reachable from `scripts/checkpoint-stop.
 * mts`, a SEPARATE process that runs after `main.mts` has been killed. Landing
 * in this window it writes a WIP commit DELETING the builder's whole night, and
 * that commit is what a resume materialises. Nothing detected it, because
 * nothing said the window existed.
 *
 * ## Why it lives in the COMMON git directory
 *
 * A linked worktree's own git directory (`.git/worktrees/<name>`) is destroyed
 * with the worktree, and the next run pre-cleans exactly that way, so a
 * sentinel written there would be gone by the time start-up could read it. The
 * common directory (`<repoRoot>/.git`) survives, so the record outlives both
 * the kill and the worktree. It is keyed by the worktree's absolute path, which
 * both the writer (inside the worktree) and the reader (start-up, before the
 * worktree exists) can compute.
 *
 * It is deliberately NOT tracked and NOT inside the worktree: a file the replay
 * itself created inside the tree would ride into the fingerprint, the restore
 * would read as failed, and the instrument would report drift on every call.
 */
export interface ReplaySentinel {
  /** The commit the worktree was stood up on — pre-builder code. */
  readonly atSha: string;
  /** The commit the restore owes. This is where the builder's night lives. */
  readonly restoreToSha: string;
  /** Where untracked-but-not-ignored files were held. Named so a person can
   *  find them; they are inside a git directory that may since be gone. */
  readonly holdDir: string;
  readonly worktreePath: string;
  readonly pid: number;
  readonly startedAtIso: string;
}

/** The main repository's git directory, asked of any path inside it. */
function gitCommonDirOf(anyPathInRepo: string): string | undefined {
  try {
    return git(anyPathInRepo, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
  } catch {
    return undefined;
  }
}

/**
 * Where the sentinel for one worktree lives, given the common git directory.
 * Keyed by a hash of the worktree's absolute path rather than its basename:
 * git disambiguates duplicate worktree names, and two branches whose
 * directories share a basename must never share a sentinel.
 */
export function replaySentinelPathFor(
  gitCommonDir: string,
  worktreePath: string,
): string {
  const key = createHash("sha256")
    .update(path.resolve(worktreePath))
    .digest("hex")
    .slice(0, 16);
  return path.join(gitCommonDir, "sandcastle-replay-in-progress", `${key}.json`);
}

/**
 * Is a replay in flight (or abandoned mid-flight) for this worktree?
 *
 * Total: an unreadable, missing or malformed file reads as "no replay", which
 * is today's behaviour and never blocks a healthy ticket. Callers use a
 * PRESENT sentinel to withhold a destructive action, so the fail-quiet
 * direction is the one that changes nothing.
 *
 * `anyPathInRepo` may be the worktree itself or, once the worktree is gone,
 * the repository root — both resolve to the same common git directory.
 */
export function readReplaySentinel(
  anyPathInRepo: string,
  worktreePath: string,
): ReplaySentinel | undefined {
  const common = gitCommonDirOf(anyPathInRepo);
  if (common === undefined) return undefined;
  try {
    const raw = readFileSync(
      replaySentinelPathFor(common, worktreePath),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Partial<ReplaySentinel>;
    if (
      typeof parsed.atSha !== "string" ||
      typeof parsed.restoreToSha !== "string" ||
      typeof parsed.worktreePath !== "string"
    ) {
      return undefined;
    }
    return {
      atSha: parsed.atSha,
      restoreToSha: parsed.restoreToSha,
      holdDir: typeof parsed.holdDir === "string" ? parsed.holdDir : "",
      worktreePath: parsed.worktreePath,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      startedAtIso:
        typeof parsed.startedAtIso === "string" ? parsed.startedAtIso : "",
    };
  } catch {
    return undefined;
  }
}

/** Drop a worktree's sentinel. Total — a missing file is the wanted state. */
export function clearReplaySentinel(
  anyPathInRepo: string,
  worktreePath: string,
): void {
  const common = gitCommonDirOf(anyPathInRepo);
  if (common === undefined) return;
  rmSync(replaySentinelPathFor(common, worktreePath), { force: true });
}

/**
 * A content-exact fingerprint of everything in the worktree that git would
 * track — every tracked file at its ON-DISK bytes, plus every untracked file
 * git does not ignore, and nothing that is ignored.
 *
 * WHY A TREE HASH AND NOT `git status`. `git status --porcelain` names paths;
 * it does not compare bytes, so a file that was modified before and modified
 * DIFFERENTLY afterwards reads as identical. This helper's whole promise is
 * "exactly as it was", and only content can prove that. Building the hash
 * costs one `git add -A` into a THROWAWAY index (`GIT_INDEX_FILE`), so the
 * repository's real index is never disturbed; the blobs it writes are
 * unreferenced and cost nothing but a later gc.
 *
 * Ignored files are outside the fingerprint by design — a warm `node_modules`
 * changing between two calls must never read as the worktree having drifted.
 *
 * Returns `undefined` when git could not be asked, which every caller here
 * treats as "unproven", never as "unchanged".
 */
export function worktreeContentHash(worktreePath: string): string | undefined {
  // The throwaway index MUST live outside the worktree. Inside it, `git add
  // -A -- .` would sweep the index file into itself, and since its name
  // carries a timestamp the fingerprint would differ on every call — an
  // instrument that always reports drift, which reads as "the restore always
  // failed" and is indistinguishable from the instrument being broken.
  const gitDir = gitDirOf(worktreePath);
  if (gitDir === undefined) return undefined;
  const indexFile = path.join(
    gitDir,
    `sandcastle-replay-index-${process.pid}-${Date.now()}`,
  );
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    git(worktreePath, ["add", "-A", "--", "."], env);
    return git(worktreePath, ["write-tree"], env);
  } catch {
    return undefined;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

/**
 * One directory's bytes, lifted out of the worktree so they can survive a
 * restore that is about to overwrite them.
 *
 * ## Why a snapshot and not "leave the file behind"
 *
 * The replay's promise is that the tree comes back EXACTLY as it was, proved by
 * content hash. Anything left on disk to survive the restore would break that
 * hash, and a caller cannot tell a deliberate carry-out from a failed restore —
 * which is the one distinction the whole helper exists to make. So the repaired
 * check leaves in memory, the restore is allowed to be total and provable, and
 * the caller writes the bytes back onto the finished tree afterwards as a
 * separate, deliberate act.
 */
export interface DirSnapshot {
  /** Worktree-relative, POSIX-separated, sorted — a stable order so two
   *  snapshots of the same directory compare. */
  readonly relPaths: readonly string[];
  readonly bytesByRelPath: ReadonlyMap<string, Buffer>;
}

/** Every file under `relDir`, or `undefined` when the directory could not be
 *  read at all (which callers must treat as "nothing was carried out"). */
export function snapshotDir(
  worktreePath: string,
  relDir: string,
): DirSnapshot | undefined {
  const abs = path.join(worktreePath, relDir);
  try {
    const entries = readdirSync(abs, {
      recursive: true,
      withFileTypes: true,
    });
    const bytes = new Map<string, Buffer>();
    for (const e of entries) {
      if (!e.isFile()) continue;
      // `parentPath` is where node ≥20 reports the containing directory for a
      // recursive read; `path` is the ≤18 spelling of the same thing.
      const parent = (e as { parentPath?: string; path?: string }).parentPath ??
        (e as { path?: string }).path ??
        abs;
      const full = path.join(parent, e.name);
      const rel = path.relative(abs, full).split(path.sep).join("/");
      bytes.set(rel, readFileSync(full));
    }
    return {
      relPaths: [...bytes.keys()].sort(),
      bytesByRelPath: bytes,
    };
  } catch {
    return undefined;
  }
}

/**
 * Replace `relDir` in the worktree with a snapshot's contents, wholesale.
 *
 * WHOLESALE, not a merge: a repaired check may rename or drop a file, and
 * leaving the old one beside the new one would run BOTH at ship time. Returns
 * false when anything went wrong, which the caller must treat as the repair
 * having failed rather than half-landed.
 */
export function restoreDirFromSnapshot(
  worktreePath: string,
  relDir: string,
  snapshot: DirSnapshot,
): boolean {
  const abs = path.join(worktreePath, relDir);
  try {
    rmSync(abs, { recursive: true, force: true });
    for (const rel of snapshot.relPaths) {
      const bytes = snapshot.bytesByRelPath.get(rel);
      if (bytes === undefined) return false;
      const dest = path.join(abs, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
    }
    return true;
  } catch {
    return false;
  }
}

/** Untracked files git does not ignore, worktree-relative. */
function untrackedNotIgnored(worktreePath: string): readonly string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return out.split("\0").filter((p) => p.length > 0);
}

/** Move a file, falling back to copy-then-remove when the holding directory
 *  turns out to sit on a different filesystem (`EXDEV`). */
function moveFile(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

/** Tracked paths whose on-disk or staged content differs from `sha`. */
function trackedDrift(worktreePath: string, sha: string): readonly string[] {
  const worktreeSide = git(worktreePath, ["diff", "--name-only", sha, "--"]);
  const indexSide = git(worktreePath, [
    "diff",
    "--cached",
    "--name-only",
    sha,
    "--",
  ]);
  return [
    ...new Set(
      [worktreeSide, indexSide]
        .join("\n")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    ),
  ];
}

/**
 * Revert the worktree to `atSha`, run `fn` against it, then put the worktree
 * back to `restoreToSha` and PROVE the restore worked.
 *
 * `fn` may be sync or async. It runs with the worktree standing on old code,
 * so it must not commit, must not move HEAD, and must not assume anything it
 * wrote earlier is still on disk.
 *
 * Never throws. Every way this can go wrong is a branch of
 * {@link WorktreeReplayResult}, because the caller's decision — may this
 * ticket continue at all? — turns on which one happened.
 */
export async function withWorktreeAt<T>(
  worktreePath: string,
  atSha: string,
  restoreToSha: string,
  fn: () => Promise<T> | T,
): Promise<WorktreeReplayResult<T>> {
  // Refuse before touching anything if there is tracked work no commit holds.
  let dirtyAtEntry: readonly string[];
  try {
    dirtyAtEntry = trackedDrift(worktreePath, restoreToSha);
  } catch (err) {
    return {
      kind: "revert-failed",
      error: `could not read the worktree against ${restoreToSha}: ${messageOf(err)}`,
    };
  }
  if (dirtyAtEntry.length > 0) {
    return { kind: "dirty-at-entry", dirtyPaths: dirtyAtEntry };
  }

  const entryHash = worktreeContentHash(worktreePath);
  if (entryHash === undefined) {
    // With no fingerprint of the entry state there is no way to prove the
    // restore afterwards, and an unprovable restore is exactly what must not
    // be attempted. Refuse rather than run blind.
    return {
      kind: "revert-failed",
      error: "could not fingerprint the worktree before the replay",
    };
  }

  // Hold the builder's uncommitted-but-not-ignored files somewhere git will
  // never look: inside the git directory, which `git clean` skips and
  // `read-tree` never writes into. Same filesystem as the worktree in every
  // ordinary layout, so the move is a rename.
  const gitDir = gitDirOf(worktreePath);
  if (gitDir === undefined) {
    return {
      kind: "revert-failed",
      error: "could not locate the worktree's git directory",
    };
  }
  const holdDir = path.join(
    gitDir,
    `sandcastle-replay-${process.pid}-${Date.now()}`,
  );

  /** Files ACTUALLY moved into `holdDir`, appended as each move succeeds.
   *  Never the candidate list: a move that threw half way through would
   *  otherwise have the restore look for files that are still in the tree, and
   *  the sweep below destroy the ones that never left it. */
  const held: string[] = [];
  /**
   * Every untracked-not-ignored file that was in the tree at entry is now in
   * `holdDir`. ONLY THEN is `git clean -fd` safe: it is a sweep for debris the
   * replay run itself made, and while any of the builder's uncommitted files
   * are still on disk it is a sweep for the builder's work instead. Two real
   * paths reach the sweep with that untrue — `untrackedNotIgnored` throwing,
   * and a `moveFile` throwing part way down the list — and both used to
   * destroy uncommitted builder work outright.
   */
  let holdComplete = false;
  /** Set when the revert never completed — `fn` did not run, so nothing was
   *  measured and no proof exists either way. */
  let revertError: string | undefined;
  /** Set when `fn` itself threw. */
  let fnError: string | undefined;
  /** Set when a restore COMMAND misbehaved. Recorded, never thrown: the
   *  fingerprint comparison below is the verdict and is strictly more
   *  trustworthy than an exit code. */
  let restoreCommandError: string | undefined;
  let value: T | undefined;

  // WRITTEN BEFORE THE FIRST DESTRUCTIVE MOVE, cleared only after the restore
  // is PROVED. Anything that finds it set is looking at a worktree that may be
  // standing on pre-builder code.
  const sentinelDir = gitCommonDirOf(worktreePath);
  const sentinelPath =
    sentinelDir === undefined
      ? undefined
      : replaySentinelPathFor(sentinelDir, worktreePath);
  if (sentinelPath !== undefined) {
    try {
      mkdirSync(path.dirname(sentinelPath), { recursive: true });
      const sentinel: ReplaySentinel = {
        atSha,
        restoreToSha,
        holdDir,
        worktreePath: path.resolve(worktreePath),
        pid: process.pid,
        startedAtIso: new Date().toISOString(),
      };
      writeFileSync(sentinelPath, JSON.stringify(sentinel, null, 2));
    } catch {
      // Best-effort, and it must stay that way: an unwritable git directory is
      // not a reason to refuse a replay, it is a reason the kill-window guard
      // degrades to what it was before this existed.
    }
  }

  try {
    try {
      for (const rel of untrackedNotIgnored(worktreePath)) {
        moveFile(path.join(worktreePath, rel), path.join(holdDir, rel));
        held.push(rel);
      }
      holdComplete = true;
      git(worktreePath, ["read-tree", "-u", "--reset", atSha]);
    } catch (err) {
      revertError = messageOf(err);
      throw err;
    }
    value = await fn();
  } catch (err) {
    fnError ??= revertError === undefined ? messageOf(err) : undefined;
  } finally {
    // Restore ALWAYS — a thrown proof, or a revert that only half happened,
    // must not leave the worktree on old code.
    try {
      git(worktreePath, ["read-tree", "-u", "--reset", restoreToSha]);
      // Sweep debris the replay run itself made. `-x` is deliberately absent:
      // ignored caches are the reason this is affordable at all. SKIPPED
      // outright when the hold never completed — see `holdComplete`. The tree
      // is then left with whatever untracked files never moved, which is
      // exactly the entry state the fingerprint below expects.
      if (holdComplete) git(worktreePath, ["clean", "-fd"]);
    } catch (err) {
      restoreCommandError = messageOf(err);
    }
    for (const rel of held) {
      const from = path.join(holdDir, rel);
      if (existsSync(from)) {
        try {
          moveFile(from, path.join(worktreePath, rel));
        } catch (err) {
          restoreCommandError ??= messageOf(err);
        }
      }
    }
    rmSync(holdDir, { recursive: true, force: true });
  }

  // PROVE the restore rather than assume it: the tree must fingerprint
  // identically to how it did on the way in.
  const exitHash = worktreeContentHash(worktreePath);
  if (exitHash === undefined || exitHash !== entryHash) {
    let dirtyPaths: readonly string[] = [];
    try {
      dirtyPaths = trackedDrift(worktreePath, restoreToSha);
    } catch {
      dirtyPaths = [];
    }
    const detail =
      restoreCommandError === undefined ? "" : ` (${restoreCommandError})`;
    const preceding = revertError ?? fnError;
    return {
      kind: "restore-failed",
      error:
        (exitHash === undefined
          ? `the worktree could not be fingerprinted after the replay, so the restore to ${restoreToSha} is unproven`
          : `the worktree does not match what it was before the replay (expected tree ${entryHash}, found ${exitHash})`) +
        detail,
      dirtyPaths,
      ...(preceding === undefined ? {} : { precedingError: preceding }),
    };
  }

  // The restore is PROVED, so the window is genuinely shut. Cleared only here:
  // on `restore-failed` above the sentinel deliberately SURVIVES, because the
  // worktree may still be holding pre-builder code and a checkpoint of it would
  // commit the deletion of the builder's night.
  if (sentinelPath !== undefined) rmSync(sentinelPath, { force: true });

  if (revertError !== undefined) {
    return { kind: "revert-failed", error: revertError };
  }
  if (fnError !== undefined) {
    return { kind: "fn-threw", error: fnError };
  }
  return { kind: "ok", value: value as T };
}
