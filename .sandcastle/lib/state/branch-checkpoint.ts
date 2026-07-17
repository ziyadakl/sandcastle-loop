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
 * Refspec a RESUMING host must fetch the issue's checkpoint with:
 * `+refs/sandcastle/wip/issue-<N>:refs/sandcastle/wip/issue-<N>`.
 *
 * Load-bearing, not a style preference. Fetching to `FETCH_HEAD` alone (what
 * both resume paths used to do) materializes the work but leaves the LOCAL
 * mirror ref unwritten — and that mirror is the lease {@link pushWipRef} pushes
 * against. A host that resumed a peer's checkpoint would then lease against ""
 * ("must not exist") while origin DID hold the peer's snapshot, so every
 * checkpoint it ever made was rejected `(stale info)` and its work never left
 * the machine. Fetching INTO the mirror makes the resume a real point-in-time
 * observation of origin, which is exactly what the lease wants — see
 * {@link pushWipRef}'s header for why this is safe and not a blind force.
 *
 * Forced (`+`) because the mirror must track origin even when the peer's tip is
 * not a descendant of a stale local value (e.g. a rebased or re-cut checkpoint);
 * the mirror is an observation of origin, never work of ours to protect.
 *
 * Single-sourced here so the mac-host and docker resume paths cannot diverge —
 * a fix to one only is a half-fix, and this bug was born of exactly that shape.
 */
export function wipMirrorFetchRefspec(issue: number): string {
  const ref = wipRef(issue);
  return `+${ref}:${ref}`;
}

/**
 * Extract the issue number from a per-issue sandbox branch of the form
 * `agent/issue-<N>` (the name minted at main.mts:5895). Returns the parsed
 * number, or `null` when the branch is not issue-shaped (e.g. a run/integration
 * branch) — the resume path must fall back to a fresh worktree in that case,
 * never guess a WIP ref for a branch that has none.
 */
export function issueFromBranch(branch: string): number | null {
  const m = /^agent\/issue-(\d+)$/.exec(branch);
  return m ? Number(m[1]) : null;
}

/**
 * Pure decision for sandbox creation (ADR 0021 §2 "branch reuse on pickup"):
 * should this issue's worktree be cut from a saved WIP checkpoint (`reuse`) or
 * force-reset from HEAD as today (`fresh`)?
 *
 * Returns `"reuse"` ONLY when cross-host sync is enabled, a WIP ref exists on
 * origin, AND the branch is issue-shaped. Every other combination — sync off, no
 * checkpoint, or a non-issue branch — yields `"fresh"`, so the flag-off path is
 * byte-for-byte today's unconditional `-B` behavior.
 */
export function reuseOrFresh(opts: {
  syncEnabled: boolean;
  branch: string;
  wipExists: boolean;
}): "reuse" | "fresh" {
  const issueShaped = issueFromBranch(opts.branch) !== null;
  return opts.syncEnabled && opts.wipExists && issueShaped ? "reuse" : "fresh";
}

/**
 * Cross-cutting sandbox-creation decision (ADR 0021 §2 "branch reuse on
 * pickup"), single-sourced for BOTH create paths (mac-host + docker) so the two
 * cannot silently diverge. Answers: does this issue's worktree pick up a saved
 * WIP checkpoint (`reuse`, carrying the resolved issue number) or start fresh?
 *
 * The flag-off short-circuit is load-bearing and comes FIRST: when
 * `syncEnabled` is false (or the branch is not issue-shaped) `wipRefExists` is
 * NEVER called, so no `ls-remote`/origin touch happens — the inert-when-off
 * contract lease/lane/status sync all honor (a prior bug shipped an ls-remote
 * on the off path). The discriminated return type-narrows `issue` for callers.
 *
 * Callers keep their OWN materialization (mac-host adds the worktree from the
 * WIP mirror ref; docker repoints the branch at it and lets the SDK add) — only
 * the decision, and the {@link wipMirrorFetchRefspec} they both fetch with, are
 * shared here.
 */
export async function resolveReuseDecision(opts: {
  syncEnabled: boolean;
  branch: string;
  repoRoot: string;
  git: GitRunner;
}): Promise<{ reuse: true; issue: number } | { reuse: false }> {
  const issue = issueFromBranch(opts.branch);
  const wipExists =
    opts.syncEnabled &&
    issue !== null &&
    (await wipRefExists(opts.repoRoot, issue, opts.git));
  const decision = reuseOrFresh({
    syncEnabled: opts.syncEnabled,
    branch: opts.branch,
    wipExists,
  });
  return decision === "reuse" && issue !== null
    ? { reuse: true, issue }
    : { reuse: false };
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
 * Resolve a rev to a concrete commit SHA, or "" when it does not resolve.
 *
 * Exported so the sibling strand-backup module (which already imports this one,
 * so the dependency direction is clean) can drop its private copy.
 */
export async function revParse(
  git: GitRunner,
  cwd: string,
  rev: string,
): Promise<string> {
  const res = await git(cwd, "rev-parse", "--verify", "--quiet", rev);
  return res.ok ? res.stdout.trim() : "";
}

/**
 * Push the worktree's HEAD to the issue's WIP ref, leasing against this host's
 * own last-pushed value — **never a blind force**.
 *
 * ADR 0021 §2. The checkpoint is re-pushed every time a host is stopped
 * mid-issue, so the push must OVERWRITE the prior WIP tip while still refusing
 * to destroy a PEER's. That means an explicit
 * `--force-with-lease=<ref>:<expected>`, where `expected` is a genuine
 * point-in-time observation by this host — the local mirror ref as it stood
 * before this push, or empty ("must not exist") the first time:
 *
 *   - first checkpoint, ref absent on origin → created;
 *   - re-checkpoint by this host             → advances cleanly;
 *   - a PEER wrote the ref meanwhile         → REFUSED, its work survives.
 *
 * Two details this depends on, both verified against real git (the same two
 * that shape `backupStrand`, whose approach this mirrors):
 *   - a *bare* `--force-with-lease` CANNOT be used: it leases against the
 *     remote-TRACKING ref, and `refs/sandcastle/wip/*` has none — so once the
 *     ref exists on origin every later push is rejected `(stale info)` and
 *     origin silently keeps the FIRST snapshot. That was a real data-loss bug:
 *     stop --now → resume → stop --now again lost the second stop's work.
 *   - re-reading origin at push time would be pointless — it would just adopt a
 *     peer's value as "expected" and clobber it, exactly what `--force` does.
 *
 * The mirror is therefore written at exactly two moments, and both are genuine
 * observations of origin rather than aspirations:
 *
 *   - AFTER a successful push here — "what origin holds because of us";
 *   - at RESUME time, by the fetch refspec `+<wipRef>:<wipRef>` (see
 *     {@link wipMirrorFetchRefspec}) — "what origin held when we picked this
 *     work up".
 *
 * The second is what makes a RESUMING host able to check its own work back in,
 * and it is NOT the push-time re-read ruled out above. The difference is
 * timing, and it is the whole safety argument: at resume we adopt the peer's
 * tip and then BUILD ON IT, so pushing over it destroys nothing; at push time we
 * would adopt a value we never saw, let alone built on, and overwrite whatever
 * arrived while we worked. A resumed mirror still goes stale exactly when it
 * should — if a THIRD host moves the ref after we resumed, our push is refused
 * and its work survives.
 *
 * Best-effort: returns the raw {@link GitRunResult} and does not throw on
 * `ok=false`.
 */
export async function pushWipRef(
  repoRoot: string,
  wtPath: string,
  issue: number,
  git: GitRunner,
  remote = "origin",
): Promise<GitRunResult> {
  const ref = wipRef(issue);

  // This host's PRIOR observation — read BEFORE the push, and "" ("must not
  // exist") when we have never pushed this ref. This is the lease, and the only
  // thing standing between a re-push and a peer's work.
  const expected = await revParse(git, repoRoot, ref);

  const push = await git(
    repoRoot,
    "-C",
    wtPath,
    "push",
    `--force-with-lease=${ref}:${expected}`,
    remote,
    `HEAD:${ref}`,
  );
  if (!push.ok) return push;

  // The push LANDED, so origin now holds this worktree's HEAD: record it as our
  // observation for the next lease. Best-effort — a mirror we fail to advance
  // only costs us a (safe) refusal next time, never a clobber.
  const sha = await revParse(git, wtPath, "HEAD");
  if (sha) await git(repoRoot, "update-ref", ref, sha);
  return push;
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
 * List the issue numbers of every WIP checkpoint ref currently on the remote —
 * parses `git ls-remote <remote> refs/sandcastle/wip/*` output, keeping only
 * lines whose ref is issue-shaped (`refs/sandcastle/wip/issue-<N>`) and dropping
 * malformed/foreign lines. Powers ADR 0021 §4's startup prune (delete WIP refs
 * for issues no longer open). A failed `ls-remote` (network/auth) returns `[]`
 * so the prune NEVER over-deletes on an incomplete view of the remote.
 */
export async function listWipRefIssues(
  repoRoot: string,
  git: GitRunner,
  remote = "origin",
): Promise<number[]> {
  const res = await git(repoRoot, "ls-remote", remote, "refs/sandcastle/wip/*");
  if (!res.ok) return [];
  const out: number[] = [];
  for (const line of res.stdout.split("\n")) {
    const m = /refs\/sandcastle\/wip\/issue-(\d+)\s*$/.exec(line.trim());
    if (m) out.push(Number(m[1]));
  }
  return out;
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
