/**
 * Branch checkpoint git primitives (ADR 0021 — checkpoint/stop/resume).
 *
 * When a loop host is told to stop mid-issue, the in-flight worktree changes
 * must survive so another host (or the same host later) can RESUME them. We
 * persist that work as a WIP ref on the remote: `refs/sandcastle/wip/issue-<N>`
 * — mirroring the lease (`refs/locks/issue-<N>`), status, and lane ref
 * conventions. A checkpoint is a commit of the worktree's current state pushed
 * to the WIP ref with `--force-with-lease`; resume fetches that ref and picks
 * up where the work left off.
 *
 * Every function is pure/DI: it touches git ONLY through an injected
 * {@link GitRunner} (the exact seam issue-lease.ts uses), never
 * `node:child_process`, so the whole module is unit-testable against a fake
 * runner with no real git. Best-effort operations (push/delete) return the raw
 * {@link GitRunResult} and never throw on `ok=false` — the caller decides.
 */
import type { GitRunner, GitRunResult } from "./issue-lease.js";

/** Ref name a given issue's in-flight WIP checkpoint lives at on the remote. */
export function wipRef(issue: number): string {
  return `refs/sandcastle/wip/issue-${issue}`;
}

/**
 * True iff the worktree at `wtPath` has uncommitted changes — i.e. `git status
 * --porcelain` prints at least one non-blank line. The single gate that keeps
 * {@link commitWorktreeCheckpoint} from ever making an empty commit.
 */
export async function hasWorktreeChanges(
  wtPath: string,
  git: GitRunner,
): Promise<boolean> {
  const res = await git(wtPath, "status", "--porcelain");
  return res.stdout.trim().length > 0;
}

/**
 * Persist the worktree's current state as a single WIP commit. If (and only if)
 * {@link hasWorktreeChanges} reports dirt, stage everything (`git add -A`) then
 * `git commit` with a stable message carrying the issue and host. Returns
 * `true` when a commit was made, `false` when the worktree was clean (NEVER an
 * empty commit).
 */
export async function commitWorktreeCheckpoint(
  wtPath: string,
  issue: number,
  hostId: string,
  git: GitRunner,
): Promise<boolean> {
  if (!(await hasWorktreeChanges(wtPath, git))) return false;
  await git(wtPath, "add", "-A");
  await git(wtPath, "commit", "-m", `wip: checkpoint issue ${issue} (${hostId})`);
  return true;
}

/**
 * Push the worktree's HEAD to the issue's WIP ref with `--force-with-lease`.
 * The checkpoint may be re-pushed as work advances, so the push overwrites the
 * prior WIP tip — but only if the remote ref still points where we last saw it
 * (`--force-with-lease`), never a blind force. Modeled on issue-lease.ts's
 * backend push; returns the raw {@link GitRunResult} (does not throw on
 * `ok=false`).
 */
export async function pushWipRef(
  repoRoot: string,
  wtPath: string,
  issue: number,
  git: GitRunner,
  remote = "origin",
): Promise<GitRunResult> {
  return git(
    repoRoot,
    "-C",
    wtPath,
    "push",
    "--force-with-lease",
    remote,
    `HEAD:${wipRef(issue)}`,
  );
}

/**
 * True iff a WIP checkpoint ref exists on the remote for `issue` — i.e.
 * `git ls-remote <remote> <wipRef>` prints a non-blank line. Used by the resume
 * path to decide whether there is saved work to pick up.
 */
export async function wipRefExists(
  repoRoot: string,
  issue: number,
  git: GitRunner,
  remote = "origin",
): Promise<boolean> {
  const res = await git(repoRoot, "ls-remote", remote, wipRef(issue));
  if (!res.ok) return false;
  return res.stdout.split("\n").some((l) => l.trim().length > 0);
}

/**
 * Best-effort delete of the issue's WIP ref (after a successful resume+ship, so
 * the checkpoint is not later re-applied). Pushes the empty-source delete
 * refspec `:<wipRef>`; returns the raw {@link GitRunResult} and never throws —
 * a failed cleanup is not fatal.
 */
export async function deleteWipRef(
  repoRoot: string,
  issue: number,
  git: GitRunner,
  remote = "origin",
): Promise<GitRunResult> {
  return git(repoRoot, "push", remote, `:${wipRef(issue)}`);
}
