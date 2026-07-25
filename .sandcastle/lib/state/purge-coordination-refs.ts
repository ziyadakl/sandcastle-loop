/**
 * Purge stale Sandcastle COORDINATION refs from a remote (template hardening A3).
 *
 * Over a run's life the loop writes coordination refs to `origin` — issue leases
 * at `refs/locks/issue-<N>` (see `issue-lease.ts`) and the whole
 * `refs/sandcastle/*` family (wip, lanes, status, peer-status, peers, strand,
 * conflict). When a run ends abnormally (a killed loop, an abandoned host) these
 * can linger and mislead the next run's liveness/lease logic. This tool sweeps
 * BOTH roots off the remote in one pass.
 *
 * It is deliberately narrow: it deletes ONLY refs under `refs/locks/` and
 * `refs/sandcastle/` — never `refs/heads/*` (real branches) or `refs/pull/*`.
 *
 * Like the rest of the state layer it touches git ONLY through an injected
 * {@link GitRunner} (the seam `issue-lease.ts` defines), so the whole module is
 * unit-testable against a real bare origin with a real runner; the thin
 * `../scripts/purge-coordination-refs.mts` supplies `makeExecFileGitRunner()`,
 * mirroring the checkpoint-stop.ts / checkpoint-stop.mts split.
 */
import type { GitRunner } from "./issue-lease.js";

/** The two coordination ref roots this tool sweeps. Nothing else is touched. */
export const COORDINATION_REF_PREFIXES = [
  "refs/locks/",
  "refs/sandcastle/",
] as const;

/** Options for {@link purgeCoordinationRefs}. */
export interface PurgeCoordinationRefsOpts {
  readonly repoRoot: string;
  /** Remote to purge refs from (default "origin"). */
  readonly remote?: string;
  /**
   * Preview only: report what WOULD be deleted and delete nothing. The thin
   * runner maps a bare invocation (no `--yes`) to this SAFE default.
   */
  readonly dryRun?: boolean;
}

/** Per-ref outcome of a purge sweep. */
export interface PurgeRefResult {
  readonly ref: string;
  readonly outcome: "deleted" | "would-delete" | "error";
  /** Human-readable failure reason (only on `error`). */
  readonly detail?: string;
}

/** True when `ref` lives under one of the two coordination roots. */
function isCoordinationRef(ref: string): boolean {
  return COORDINATION_REF_PREFIXES.some((p) => ref.startsWith(p));
}

/**
 * List the remote's coordination refs via `git ls-remote <remote>`, keeping only
 * those under `refs/locks/` or `refs/sandcastle/`. Each ls-remote line is
 * `<sha>\t<ref>`; we take the ref column. A failed ls-remote yields no refs (the
 * caller reports an empty sweep rather than throwing).
 */
export async function listCoordinationRefs(
  git: GitRunner,
  repoRoot: string,
  remote: string,
): Promise<string[]> {
  const res = await git(repoRoot, "ls-remote", remote);
  if (!res.ok) return [];
  const refs: string[] = [];
  for (const line of res.stdout.split("\n")) {
    const ref = line.trim().split(/\s+/)[1];
    if (ref && isCoordinationRef(ref)) refs.push(ref);
  }
  return refs;
}

/**
 * Sweep every coordination ref off the remote. With `dryRun` set, report each as
 * `would-delete` and touch nothing; otherwise delete each via `git push <remote>
 * :<ref>` (empty-source delete refspec) and report `deleted`, recording a
 * per-ref `error` on a push rejection without aborting the rest of the sweep.
 * Returns one {@link PurgeRefResult} per coordination ref, in discovery order.
 */
export async function purgeCoordinationRefs(
  git: GitRunner,
  opts: PurgeCoordinationRefsOpts,
): Promise<PurgeRefResult[]> {
  const remote = opts.remote ?? "origin";
  const refs = await listCoordinationRefs(git, opts.repoRoot, remote);
  const results: PurgeRefResult[] = [];

  for (const ref of refs) {
    if (opts.dryRun) {
      results.push({ ref, outcome: "would-delete" });
      continue;
    }
    const res = await git(opts.repoRoot, "push", remote, `:${ref}`);
    if (res.ok) {
      results.push({ ref, outcome: "deleted" });
    } else {
      results.push({
        ref,
        outcome: "error",
        detail: res.stderr.trim() || "delete push failed",
      });
    }
  }

  return results;
}

/**
 * Render a purge sweep for the console: one line per ref plus a one-line tally.
 * A stable, greppable summary for the thin runner and for operators reading a
 * purge log.
 */
export function formatPurge(results: PurgeRefResult[]): string {
  const lines = results.map((r) => {
    switch (r.outcome) {
      case "deleted":
        return `  deleted     ${r.ref}`;
      case "would-delete":
        return `  would-delete ${r.ref}`;
      case "error":
        return `  error       ${r.ref}: ${r.detail ?? "(no detail)"}`;
      default: {
        const _exhaustive: never = r.outcome;
        return _exhaustive;
      }
    }
  });

  const counts = { deleted: 0, "would-delete": 0, error: 0 };
  for (const r of results) counts[r.outcome]++;
  const summary =
    `${counts.deleted} deleted, ${counts["would-delete"]} would-delete, ` +
    `${counts.error} error`;

  return [...lines, summary].join("\n");
}
