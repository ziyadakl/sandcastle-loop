/**
 * STRAND BACKUP — data-safety primitives for the cross-host loop (Workstream 1).
 *
 * Three ways finished/in-flight work can be silently lost, and the durable ref
 * each one is persisted to so a human or a peer host can recover it:
 *
 *   1a. A final promotion whose fast-forward is REFUSED strands merged +
 *       post-merge-certified code on {@link STAGING_BRANCH}. {@link backupStrand}
 *       pins that tip to a local `refs/sandcastle/strand/<branch>` (and per-issue
 *       `refs/sandcastle/wip/issue-<N>`) — ALWAYS locally, and to origin too when
 *       cross-host sync is on so a peer can pull it.
 *       {@link handleStrandedPromotion} is the whole policy the loop runs on that
 *       refusal (back up → publish → surface to a human → release the leases).
 *   1c. A graceful `--now` stop with a certified-but-unpromoted staging tip loses
 *       post-merge fixer commits. {@link stagingCommitsAhead} + {@link backupStrand}
 *       back that tip up to the same strand scheme.
 *
 * (1b — a heartbeat checkpoint of live in-flight worktrees — is deliberately
 * absent: committing a worktree an implementer agent is concurrently writing
 * races it. See the STAGED note in main.mts's heartbeat; that redesign needs a
 * non-invasive snapshot (`git stash create`), not the helper this module used to
 * carry.)
 *
 * Like the rest of the state layer this touches git ONLY through an injected
 * {@link GitRunner} (the seam issue-lease.ts defines), so the whole module is
 * unit-testable against a real local bare repo with no network. Every operation
 * is best-effort: failures are collected into the result's `errors` and NEVER
 * thrown — a backup that can't complete must never crash the loop it protects.
 */
import type { GitRunner } from "./issue-lease.js";
import { wipRef } from "./branch-checkpoint.js";

/**
 * Persistent staging branch name — the branch the merger lands certified work on
 * before the final fast-forward promotion. Owned here (rather than in main.mts)
 * so state-layer code that reasons about the strand can name it instead of
 * re-hardcoding the literal; main.mts imports it from the barrel.
 */
export const STAGING_BRANCH = "integration-candidate";

/** Durable ref a stranded branch's tip is pinned to (mirrors wipRef/laneRef). */
export function strandRef(branch: string): string {
  return `refs/sandcastle/strand/${branch}`;
}

/** Options for {@link backupStrand}. */
export interface StrandBackupOpts {
  readonly repoRoot: string;
  /** The stranded branch whose tip is being pinned (e.g. STAGING_BRANCH). */
  readonly branch: string;
  /**
   * Issues whose per-issue WIP ref (`refs/sandcastle/wip/issue-<N>`) should ALSO
   * point at the stranded tip, so the resume path can find the work by issue.
   */
  readonly issues?: readonly number[];
  /**
   * When true, ALSO push every written ref to `remote` so a peer host can pull
   * the stranded work. When false, refs are written LOCALLY only — no origin
   * touch (the inert-when-off contract the rest of cross-host sync honors).
   */
  readonly syncEnabled: boolean;
  readonly remote?: string;
}

/** Outcome of one {@link backupStrand} call. */
export interface StrandBackupResult {
  /** Refs written to the LOCAL ref store. */
  readonly localRefs: string[];
  /** Refs pushed to origin (empty unless `syncEnabled`). */
  readonly pushedRefs: string[];
  /** Non-fatal failures, each a short human string. */
  readonly errors: string[];
}

/** Resolve a rev to a concrete commit SHA, or "" when it does not resolve. */
async function revParse(
  git: GitRunner,
  repoRoot: string,
  rev: string,
): Promise<string> {
  const res = await git(repoRoot, "rev-parse", "--verify", "--quiet", rev);
  return res.ok ? res.stdout.trim() : "";
}

/**
 * Back up the tip of `opts.branch` to a durable strand ref (and per-issue WIP
 * refs). The tip is first resolved to a concrete SHA so the refs pin the exact
 * commit even if the branch later moves. Local `update-ref` always runs; the
 * origin push runs only when `syncEnabled`. Best-effort: any failure is recorded
 * in `errors`, never thrown.
 *
 * ADR 0021 §1 — **never a blind force**. Each push carries an explicit
 * `--force-with-lease=<ref>:<expected>` whose expected value is *this host's
 * LOCAL ref as it stood before this backup* — i.e. what we last pushed there, or
 * empty ("must not exist") the first time. That makes the lease a real
 * point-in-time observation:
 *
 *   - first strand, ref absent on origin  → created;
 *   - re-strand by this host              → advances cleanly;
 *   - a PEER stranded the branch meanwhile → REFUSED, so its work survives.
 *
 * Two details this depends on, both verified against real git:
 *   - a *bare* `--force-with-lease` cannot be used: `refs/sandcastle/*` has no
 *     remote-tracking ref, so the lease has nothing to compare against and the
 *     push fails outright once the ref exists on origin;
 *   - re-reading origin at push time would be pointless — it would just adopt a
 *     peer's value as "expected" and clobber it, exactly what `--force` did.
 */
export async function backupStrand(
  git: GitRunner,
  opts: StrandBackupOpts,
): Promise<StrandBackupResult> {
  const remote = opts.remote ?? "origin";
  const localRefs: string[] = [];
  const pushedRefs: string[] = [];
  const errors: string[] = [];

  const sha = await revParse(git, opts.repoRoot, opts.branch);
  if (!sha) {
    errors.push(`strand branch ${opts.branch} did not resolve to a commit`);
    return { localRefs, pushedRefs, errors };
  }

  const refs = [
    strandRef(opts.branch),
    ...(opts.issues ?? []).map((n) => wipRef(n)),
  ];

  // Snapshot each ref's PRIOR local value first — it becomes the push lease.
  // Must happen before the update-ref below overwrites it.
  const expected = new Map<string, string>();
  for (const ref of refs) {
    expected.set(ref, await revParse(git, opts.repoRoot, ref));
  }

  for (const ref of refs) {
    const up = await git(opts.repoRoot, "update-ref", ref, sha);
    if (up.ok) localRefs.push(ref);
    else errors.push(`update-ref ${ref} failed: ${up.stderr.trim() || "(no stderr)"}`);
  }

  if (opts.syncEnabled) {
    for (const ref of localRefs) {
      const push = await git(
        opts.repoRoot,
        "push",
        `--force-with-lease=${ref}:${expected.get(ref) ?? ""}`,
        remote,
        `${sha}:${ref}`,
      );
      if (push.ok) pushedRefs.push(ref);
      else {
        errors.push(
          `push ${ref} failed (refusing to clobber a peer's ref): ` +
            `${push.stderr.trim() || "(no stderr)"}`,
        );
      }
    }
  }

  return { localRefs, pushedRefs, errors };
}

/**
 * Count commits in `<integrationBranch>..<stagingBranch>` — how many the staging
 * branch has that the integration branch does not. `> 0` means there is
 * certified-but-unpromoted work worth backing up (the 1c gate). A failed
 * rev-list (unknown ref) reports 0 so the caller does not over-save.
 */
export async function stagingCommitsAhead(
  git: GitRunner,
  repoRoot: string,
  integrationBranch: string,
  stagingBranch: string,
): Promise<number> {
  const res = await git(
    repoRoot,
    "rev-list",
    `${integrationBranch}..${stagingBranch}`,
    "--count",
  );
  if (!res.ok) return 0;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * The loop-side effects {@link handleStrandedPromotion} needs, injected so the
 * policy is testable without a loop. Mirrors the matching members of main.mts's
 * `Deps` (plus the status store's `setIssuePhase` and main.mts's
 * `publishLaneOrLog`, which already swallows a LaneSyncError).
 */
export interface StrandedPromotionDeps {
  log: (line: string) => void;
  logError: (line: string) => void;
  /** Status-store phase write (in-memory dashboard state). */
  setIssuePhase: (issue: number, phase: "needs-human", detail: string) => void;
  /** Apply the REAL `needs-human` GitHub label. MAY THROW (GH API). */
  quarantine: (issue: number, reason: string) => Promise<void>;
  releaseIssueLease: (issue: number) => Promise<void>;
  /** Publish this host's lane ref; `context` names the path for error text. */
  publishLane: (branch: string, context: string) => Promise<void>;
}

/** Options for {@link handleStrandedPromotion}. */
export interface StrandedPromotionOpts {
  readonly repoRoot: string;
  /** Branch the certified work is stranded on (normally {@link STAGING_BRANCH}). */
  readonly stagingBranch: string;
  /** Branch the fast-forward promotion was REFUSED against (the ship line). */
  readonly integrationBranch: string;
  /** Issues that merged to staging and are now stranded. */
  readonly issues: readonly number[];
  /** Cross-host sync opt-in: gates every origin write. */
  readonly syncEnabled: boolean;
}

/**
 * WORKSTREAM 1 (1a) — the whole policy for a REFUSED final promotion.
 *
 * The merged + post-merge-reviewer-certified work is stranded on
 * `stagingBranch` and the integration branch was NOT advanced. DON'T lose it:
 *
 *   1. Pin the certified tip to durable refs (strand + per-issue WIP) — BEFORE
 *      any lease is released, because once the lease is gone a peer may reclaim
 *      the issue and the work must already be recoverable. Local refs always;
 *      the origin push is gated on `syncEnabled`.
 *   2. When sync is on, publish the stranded tip on this host's lane so a peer
 *      can merge it (the normal publish only runs on promote-SUCCESS, which
 *      would leave this work invisible to peers).
 *   3. Per stranded issue: mark it `needs-human` in the status store AND apply
 *      the real GitHub label (the status skill's strand sweep keys off the
 *      label, so the phase alone leaves the strand invisible to it), then
 *      release the lease.
 *
 * NEVER throws. Backup faults are logged non-fatal (the strand is still on
 * `stagingBranch` on disk and the run already exits unhealthy for a human), and
 * a `quarantine` fault can never skip the lease release below it — that release
 * is the contract-critical step (ADR 0019 Fix-4): without it the heartbeat
 * renews the lease forever and no peer can ever reclaim the issue.
 *
 * The caller keeps ownership of run-level health (`promotionFailed` /
 * `lastFailedStagingIteration`) — this function deliberately does not touch it.
 */
export async function handleStrandedPromotion(
  git: GitRunner,
  deps: StrandedPromotionDeps,
  opts: StrandedPromotionOpts,
): Promise<void> {
  const { stagingBranch, integrationBranch, issues, syncEnabled } = opts;

  try {
    const backup = await backupStrand(git, {
      repoRoot: opts.repoRoot,
      branch: stagingBranch,
      issues,
      syncEnabled,
    });
    deps.log(
      `[strand] backed up ${stagingBranch} → ${backup.localRefs.join(", ") || "(none)"}` +
        (backup.pushedRefs.length ? ` (origin: ${backup.pushedRefs.join(", ")})` : ""),
    );
    for (const e of backup.errors) {
      deps.logError(`[strand] backup: ${e}`);
    }
  } catch (err) {
    deps.logError(
      `[strand] backup of ${stagingBranch} threw (non-fatal): ${(err as Error).message}`,
    );
  }

  if (syncEnabled) {
    await deps.publishLane(
      stagingBranch,
      "stranding staging (promotion fast-forward refused)",
    );
  }

  // These "ok" issues were shown as `merge` (queued) and deliberately never
  // recorded merged — correct, they're stranded, not shipped. Surface them as
  // needing a human so the dashboard flags the strand instead of leaving them in
  // a neutral "queued" limbo that reads like normal in-progress work.
  for (const n of issues) {
    deps.setIssuePhase(
      n,
      "needs-human",
      `stranded on ${stagingBranch} — promotion fast-forward refused`,
    );
    try {
      await deps.quarantine(
        n,
        `Stranded on ${stagingBranch}: promotion fast-forward to ${integrationBranch} ` +
          `was refused after certification. Certified work is preserved at ` +
          `${strandRef(stagingBranch)} / ${wipRef(n)}. Human triage required.`,
      );
    } catch (err) {
      deps.logError(
        `[strand] labeling #${n} needs-human failed (non-fatal): ${(err as Error).message}`,
      );
    }
    await deps.releaseIssueLease(n);
  }
}
