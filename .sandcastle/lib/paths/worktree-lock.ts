/**
 * Keeping one ticket's git worktree out of another ticket's reach.
 *
 * THE INCIDENT (issue #1260, run `sandcastle/queue-20260910b`, 2026-09-11).
 * Issue #1260's builder finished — two commits, complete. Its reviewer then
 * started on the same branch and died instantly:
 *
 *   fatal: not a git repository:
 *     /home/you/dev/my-project/.git/worktrees/agent-issue-1260
 *
 * The per-worktree ADMINISTRATIVE directory had been destroyed while the
 * ticket was still live. Interleaved just before it, three OTHER tickets
 * landed and each ran the per-ticket cleanup. A finished build and a paid
 * reviewer were thrown away; the ticket stopped `stopped:run-fault`.
 *
 * WHY IT HAPPENED. SIX repo-GLOBAL prunes can run at any moment, none of them
 * scoped to the ticket that asked for one. Five are ours:
 *
 *   1. `cleanupIssueBranch` (main.mts) runs a bare `git worktree prune` on its
 *      fallback path when a clean `git worktree remove` fails.
 *   2. `createSandboxRaw` (main.mts) runs the same bare prune on EVERY sandbox
 *      create.
 *   3. `preCleanWorktree` (lib/mac-host-sandbox.ts) runs one per mac-host
 *      create.
 *   4. `pruneCorruptWorktrees` (main.mts) runs one at boot.
 *   5. `createSandboxWithWorktreeRepair` (main.mts) runs one when the FIRST
 *      sandbox create fails.
 *
 * The sixth is the VENDORED SDK's `pruneStale`, on EVERY `createSandbox`
 * (`@ai-hero/sandcastle/dist/chunk-VOG34SRF.js`, `pruneAndCreate`): first a
 * global `git worktree prune`, then `rm -rf` of every directory under
 * `.sandcastle/worktrees/` absent from a `git worktree list` snapshot taken
 * AFTER that prune. We cannot patch the SDK.
 *
 * The SDK's is the compounding one. Its prune and its sweep read the same
 * state, so a registration lost to the prune makes the sweep delete the live
 * directory too — one operation that takes out both halves of another
 * ticket's worktree.
 *
 * The lock covers all six. An auditor re-grafting this after a template pull
 * should count SIX, not the three the first draft of this comment listed.
 *
 * A global prune is NOT the harmless operation main.mts records it as. The
 * worktree-health comment there says `git worktree prune` "NEVER removes a
 * live/healthy worktree". Measured on git 2.39.5, a LIVE worktree whose
 * directory has been moved, or whose `.git` file is momentarily unreadable, is
 * reaped on the spot:
 *
 *   $ mv .sandcastle/worktrees/live /tmp/elsewhere
 *   $ git worktree prune -v
 *   Removing worktrees/live: gitdir file points to non-existent location
 *
 * "Healthy" carries that whole sentence, and a live worktree is not
 * continuously healthy — the SDK's own sweep can empty one out between two
 * heartbeats. The prior decision is narrowed rather than overturned: prune is
 * safe against a HEALTHY worktree, and nothing in this loop guaranteed a live
 * worktree was healthy at the instant another ticket pruned.
 *
 * THE GUARD. `git worktree lock`. It is enforced by git itself, so it holds
 * against all three prunes above — including the SDK's, which we cannot reach —
 * and against any other process on the host. Measured, same git:
 *
 *   - a LOCKED worktree survives `git worktree prune` even with its directory
 *     gone entirely;
 *   - a LOCKED worktree is still listed by `git worktree list --porcelain`, so
 *     the SDK's sweep classifies it as active and leaves the directory alone;
 *   - `git worktree remove` AND `git worktree remove --force` both REFUSE a
 *     locked worktree ("cannot remove a locked working tree"). Only the double
 *     `-f -f` overrides, and this loop never uses it.
 *
 * So the rule is: a worktree is locked for as long as its ticket is in flight,
 * and the ONLY place that unlocks one is the cleanup of that same ticket, on
 * the path it is about to remove. A cleanup for a landed ticket therefore
 * cannot touch a live ticket's folder — not because the timing works out, but
 * because git refuses.
 *
 * WHAT THE LOCK ALSO CLOSES. The lock's REASON names the branch that owns the
 * worktree, and {@link worktreeLockOwner} reads it back. So a cleanup that
 * somehow computed a SIBLING's path — a path-derivation bug, a branch-name
 * collision — is refused on the content of the lock, before any unlock or
 * remove runs. That is a second, independent guard on the same hole, and it
 * needs no shared state and no ordering.
 *
 * THE UNLOCKED WINDOW, STATED HONESTLY. The lock is taken after
 * `provider.createSandbox` RETURNS, so the worktree is unlocked for the whole
 * of the SDK's create — `git worktree add`, then a `cp -cR` of `node_modules`,
 * then the `onWorktreeReady` and `onSandboxReady` host hooks, which is where
 * this repo's `pnpm install` runs. That is SECONDS TO MINUTES, not
 * milliseconds. An earlier draft of this comment said milliseconds; it was
 * wrong, and the correction matters because this paragraph is what a re-graft
 * reasons from.
 *
 * The window is nonetheless safe, and NOT for the reason "everything else is
 * locked" — that would be circular. It is safe because a prune and the SDK's
 * sweep both classify on HEALTH, never on lockedness. Through the whole
 * window the new worktree is registered AND its directory exists, so no prune
 * calls it stale. The SDK's sweep reads its directory listing BEFORE its
 * active-worktree listing, so a worktree born mid-sweep is absent from the
 * listing it deletes from. Neither can reach it.
 *
 * WHAT WAS CONSIDERED AND REJECTED — two existing mechanisms, both read first.
 *
 *   - The SERIAL MERGE LANE (`lib/pool/serial-queue.ts`) and an in-process
 *     lane of the `withTemplateLane` shape (`lib/db/template-reconcile.ts`)
 *     would close the window above. Rejected on cost: a create carries that
 *     `pnpm install` and `node_modules` copy, so a lane would serialise
 *     MINUTES per ticket to protect a window nothing can reach anyway.
 *   - The IN-FLIGHT SET (`inFlight` in `lib/pool/dealer.ts`, and the existing
 *     `listInflightIssueWorktrees` in `lib/state/checkpoint-stop.ts`) is the
 *     obvious "is this ticket still running" oracle. Rejected because it is
 *     PER-PROCESS. It cannot answer for the vendored SDK, which prunes inside
 *     a call we do not control, nor for a second loop sharing this workspace,
 *     nor for `/sandcastle-clean` running when no loop is up. A `git worktree
 *     lock` is a fact on disk that every one of those readers obeys.
 *
 * WHAT THIS GUARD DOES NOT COVER, and who does. The lock is scoped to
 * OWNERSHIP, not to liveness: {@link mayRemoveWorktree} refuses a lock naming
 * a DIFFERENT branch, but a cleanup aimed at a still-running ticket's OWN
 * branch would unlock and remove it. Nothing can reach that today — Phase 5
 * in `main.mts` only cleans tickets whose pipeline has already resolved — but
 * that safety comes from the CALLER, not from this module. Change the caller
 * and this guard will not save you.
 *
 * `git worktree lock` and `git worktree unlock` are NOT idempotent — a second
 * lock fails "is already locked", a second unlock fails "is not locked" — so
 * both helpers here fold that into a distinct, non-error outcome rather than
 * letting a benign repeat read as a fault.
 */

/**
 * Shape of a git shell-out result. Structurally identical to
 * `lib/state/git-exec.ts`'s `GitRunResult` (and to `issue-lease.ts`'s), so the
 * two are mutually assignable and a caller may pass either runner. Declared
 * locally on purpose: `git-exec.ts` names its only legitimate importers, and
 * this module is not one of them.
 */
export interface WorktreeGitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** An injected git runner: `(repoRoot, ...args) => result`, never throwing. */
export type WorktreeGit = (
  repoRoot: string,
  ...gitArgs: string[]
) => WorktreeGitResult;

/**
 * Every lock this loop takes carries a reason starting with this string.
 *
 * The reason is what `git worktree list --porcelain` and `git worktree prune -v`
 * print, so it is the operator's only clue when a lock outlives the run that
 * took it (a `kill -9` leaves one behind). Keeping the prefix stable lets a
 * human — or a future sweep — tell OUR locks apart from one a person took by
 * hand, which must never be broken automatically.
 */
export const WORKTREE_LOCK_REASON_PREFIX = "sandcastle: in flight";

/**
 * Separator between the prefix and the owning branch inside a lock reason.
 *
 * ASCII ONLY, deliberately. `git worktree list --porcelain` C-QUOTES a reason
 * that contains any non-ASCII byte — an em dash renders as
 * `locked "sandcastle: in flight \342\200\224 agent/issue-1260"` — and the
 * quoting would have to be undone before the owner could be read back. A
 * branch name cannot contain a space, so " for " splits back out unambiguously
 * with no unquoting step at all.
 *
 * If a branch name ever DOES carry a non-ASCII byte, the whole reason is
 * quoted, {@link worktreeLockOwner} stops recognising it, and the lock reads as
 * FOREIGN — so the cleanup leaves that worktree alone. Failing closed is the
 * right side of that trade.
 */
const OWNER_SEPARATOR = " for ";

/** The reason string stamped on a lock taken for `owner` (a branch name). */
export function worktreeLockReason(owner: string): string {
  return `${WORKTREE_LOCK_REASON_PREFIX}${OWNER_SEPARATOR}${owner}`;
}

/**
 * The branch a lock reason says owns the worktree, or `undefined` when the
 * reason is not one of ours.
 *
 * `undefined` is HONEST ABSENCE, never "nobody owns it": a hand-taken lock, a
 * lock from another tool, a C-quoted reason and an empty reason all land here,
 * and all four mean the same thing to a caller — this is not a lock this loop
 * may break.
 */
export function worktreeLockOwner(reason: string): string | undefined {
  const head = `${WORKTREE_LOCK_REASON_PREFIX}${OWNER_SEPARATOR}`;
  if (!reason.startsWith(head)) return undefined;
  const owner = reason.slice(head.length).trim();
  return owner.length > 0 ? owner : undefined;
}

/** Outcome of {@link lockWorktree}. `already-locked` is a SUCCESS: the guard
 * this call wanted is in place, which is all the caller cares about. */
export type LockOutcome = "locked" | "already-locked" | "failed";

/** Outcome of {@link unlockWorktree}. `was-not-locked` is a SUCCESS for the
 * same reason: the caller wanted the lock gone and it is gone. */
export type UnlockOutcome = "unlocked" | "was-not-locked" | "failed";

/**
 * Lock the worktree at `wtPath` so no prune — from this loop, from the
 * vendored SDK, or from any other process on the host — can reap its
 * registration while the ticket is in flight.
 *
 * Best-effort and NEVER throws. A failure to lock is reported, never fatal:
 * the loop ran (dangerously) without locks before this existed, so refusing to
 * start a ticket because its lock could not be taken would trade a rare
 * data-loss race for a common outright stop.
 *
 * `wtPath` may be repo-relative or absolute — git resolves it against
 * `repoRoot`, which is the runner's cwd.
 */
export function lockWorktree(
  repoRoot: string,
  wtPath: string,
  owner: string,
  git: WorktreeGit,
): LockOutcome {
  const res = git(
    repoRoot,
    "worktree",
    "lock",
    wtPath,
    "--reason",
    worktreeLockReason(owner),
  );
  if (res.ok) return "locked";
  // Already locked — by an earlier role on this same ticket (builder and
  // reviewer share one worktree), or by a previous run that was killed. Either
  // way the protection the caller asked for is present, so this is not a
  // failure.
  if (/is already locked/i.test(res.stderr)) return "already-locked";
  return "failed";
}

/**
 * Release the lock on `wtPath`.
 *
 * ONLY the cleanup of the ticket that owns this worktree may call this, and
 * only on the path it is about to remove — see {@link mayRemoveWorktree} for
 * the ownership check that enforces it. Unlocking anything else re-opens the
 * exact hole this module closes.
 *
 * Best-effort and NEVER throws. On `failed` the caller must NOT escalate: a
 * `git worktree remove` will refuse the still-locked worktree, and leaving a
 * finished ticket's folder on disk with a warning is the safe direction. The
 * double `-f -f` that would override the lock is never used in this loop.
 */
export function unlockWorktree(
  repoRoot: string,
  wtPath: string,
  git: WorktreeGit,
): UnlockOutcome {
  const res = git(repoRoot, "worktree", "unlock", wtPath);
  if (res.ok) return "unlocked";
  // Never locked, or a path git no longer knows as a worktree. The caller
  // wanted no lock in the way and there is none, so this is a success.
  if (/is not locked|not a working tree/i.test(res.stderr))
    return "was-not-locked";
  return "failed";
}

/** Who holds the lock on a worktree git has registered. */
export type LockHolder =
  /** Not locked — free for this loop to remove. */
  | { readonly kind: "unlocked" }
  /** Locked by this loop, on behalf of `owner` (a branch name). */
  | { readonly kind: "ours"; readonly owner: string }
  /** Locked by something that is not this loop — NEVER break it. */
  | { readonly kind: "foreign"; readonly reason: string };

/** One worktree as git itself reports it. */
export interface RegisteredWorktree {
  /** The path git prints, already absolute and symlink-resolved. USE THIS —
   * never a path derived from the branch name — as the target of an unlock or
   * a remove. See {@link findRegisteredWorktree}. */
  readonly path: string;
  readonly lock: LockHolder;
}

/**
 * What {@link findRegisteredWorktree} could establish.
 *
 * `unreadable` and `none` are deliberately different. `none` is a fact — git
 * has no worktree for this branch, so there is nothing to remove. `unreadable`
 * is the absence of a fact, and a caller must treat it as "touch nothing":
 * guessing a path when git could not be asked is how a live worktree gets
 * destroyed.
 */
export type RegisteredWorktreeLookup =
  | { readonly kind: "found"; readonly worktree: RegisteredWorktree }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * The worktree git says has `branch` checked out, with its lock.
 *
 * Keyed on the BRANCH REF, and the path comes back FROM GIT. Both halves
 * matter:
 *
 *   - Keyed on the branch, because `git worktree list --porcelain` prints
 *     realpath'd absolute paths. A path comparison mis-classifies under macOS
 *     symlinks (`/var` → `/private/var` in temp directories) and would report
 *     every live worktree as absent. A branch ref is an exact string and the
 *     mapping to a worktree is 1:1 here. `cleanupIssueBranch`'s own prune
 *     retry already records that same reasoning.
 *   - The path comes from git, because a caller that DERIVES a path from a
 *     branch name can derive the wrong one, and the wrong one is some other
 *     ticket's live folder. Taking git's answer means a derivation bug can no
 *     longer reach a sibling: the unlock and the remove both aim at whatever
 *     git says holds this exact branch, or at nothing at all.
 *
 * A worktree whose directory has vanished is still REPORTED here (git marks it
 * `prunable`), so the dangling-registration case is `found`, not `none`.
 *
 * NEVER throws.
 */
export function findRegisteredWorktree(
  repoRoot: string,
  branch: string,
  git: WorktreeGit,
): RegisteredWorktreeLookup {
  const listed = git(repoRoot, "worktree", "list", "--porcelain");
  if (!listed.ok)
    return {
      kind: "unreadable",
      detail: listed.stderr || "git worktree list failed with no message",
    };

  // Porcelain blocks are separated by a blank line. Within the block, the
  // opening `worktree <path>` line carries the path, `branch refs/heads/<name>`
  // identifies it, and a bare `locked` or `locked <reason>` line records a
  // lock. The whole block is read before deciding, so line order cannot matter.
  // A worktree left on a DETACHED HEAD prints no `branch` line at all, so the
  // branch match below cannot see it. Our own lock reason still names the
  // owning branch, though, so a block whose reason says `branch` is this
  // branch's worktree even when git no longer records the branch on it.
  // Without this second key, a detached worktree's lock is unreachable: every
  // unlock site keys on the branch, so nothing ever releases it, nothing can
  // prune it, and the branch wedges (the same dead end the pre-clean's
  // placement closes). Ours-only by construction — a foreign reason never
  // parses to an owner.
  const claimsBranch = (lines: readonly string[]): boolean =>
    lines.some((l) => l.trim() === `branch refs/heads/${branch}`) ||
    lines.some((l) => {
      const t = l.trim();
      if (!t.startsWith("locked ")) return false;
      return worktreeLockOwner(t.slice("locked ".length).trim()) === branch;
    });

  for (const block of listed.stdout.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trimEnd());
    if (!claimsBranch(lines)) continue;

    const pathLine = lines.find((l) => l.startsWith("worktree "));
    if (pathLine === undefined) continue;
    const wtPath = pathLine.slice("worktree ".length).trim();
    if (wtPath === "") continue;

    const lockLine = lines.find(
      (l) => l.trim() === "locked" || l.startsWith("locked "),
    );
    let lock: LockHolder = { kind: "unlocked" };
    if (lockLine !== undefined) {
      const reason =
        lockLine.trim() === "locked"
          ? ""
          : lockLine.slice("locked ".length).trim();
      const owner = worktreeLockOwner(reason);
      lock =
        owner !== undefined
          ? { kind: "ours", owner }
          : { kind: "foreign", reason };
    }
    return { kind: "found", worktree: { path: wtPath, lock } };
  }
  return { kind: "none" };
}

/**
 * May this loop remove the worktree git reports for `branch`?
 *
 * The whole point of {@link lockWorktree} is that a ticket's folder is
 * untouchable while the ticket is in flight. This is the matching read: a
 * cleanup asks before it unlocks, and gets a plain-English refusal when the
 * answer is no.
 *
 * `"go"` only when git could be asked AND the worktree is either unlocked or
 * locked by this loop for THIS branch. Every other answer is a refusal
 * carrying the sentence to log.
 */
export function mayRemoveWorktree(
  branch: string,
  lookup: RegisteredWorktreeLookup,
):
  | { readonly decision: "go"; readonly path: string; readonly locked: boolean }
  | { readonly decision: "nothing-registered" }
  | { readonly decision: "refuse"; readonly why: string } {
  if (lookup.kind === "unreadable")
    return {
      decision: "refuse",
      why:
        `could not read 'git worktree list' (${lookup.detail}) — refusing to ` +
        `remove a worktree whose registration cannot be confirmed, because a ` +
        `guessed path is another ticket's live folder (issue #1260)`,
    };
  if (lookup.kind === "none") return { decision: "nothing-registered" };

  const { path, lock } = lookup.worktree;
  if (lock.kind === "foreign")
    return {
      decision: "refuse",
      why:
        `${path} is locked by something that is not this loop ` +
        `(reason: ${lock.reason || "none given"}) — never broken automatically`,
    };
  if (lock.kind === "ours" && lock.owner !== branch)
    return {
      decision: "refuse",
      why:
        `${path} is locked for ${lock.owner}, not ${branch} — this cleanup is ` +
        `pointed at another ticket's live worktree and will not touch it ` +
        `(issue #1260)`,
    };
  return { decision: "go", path, locked: lock.kind === "ours" };
}

/**
 * Release THIS loop's lock on the worktree git says holds `branch` — the only
 * unlock any call site outside a test should use.
 *
 * {@link unlockWorktree} takes a PATH, and a path derived from a branch name
 * can be the wrong one, which is the whole hazard this module exists to close.
 * This resolves the worktree through git instead, and unlocks only when the
 * lock is ours AND names this exact branch. So the invariant the header states
 * — a hand-taken lock is never broken automatically — is enforced here rather
 * than merely asked for.
 *
 * Best-effort and NEVER throws. Outcomes:
 *   "unlocked"        — our lock for this branch was released
 *   "was-not-locked"  — no lock stood in the way (including: git knows no
 *                       worktree for this branch, so there is nothing to hold)
 *   "refused"         — a lock we must not break (foreign, or naming another
 *                       branch), or a listing that could not be read. The
 *                       caller must NOT escalate: leaving a worktree standing
 *                       is always safer than removing the wrong one.
 *   "failed"          — git refused the unlock itself.
 */
export function unlockOwnWorktree(
  repoRoot: string,
  branch: string,
  git: WorktreeGit,
): UnlockOutcome | "refused" {
  const permission = mayRemoveWorktree(
    branch,
    findRegisteredWorktree(repoRoot, branch, git),
  );
  if (permission.decision === "refuse") return "refused";
  if (permission.decision === "nothing-registered") return "was-not-locked";
  if (!permission.locked) return "was-not-locked";
  return unlockWorktree(repoRoot, permission.path, git);
}
