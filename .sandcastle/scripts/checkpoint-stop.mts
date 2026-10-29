#!/usr/bin/env tsx

/**
 * POST-KILL checkpoint runner. After a loop process is killed, its
 * per-issue worktrees survive on disk; this runner persists them as WIP refs and
 * releases their leases so another host can resume. Wire-up:
 * `tsx .sandcastle/scripts/checkpoint-stop.mts --integration-branch <b>`.
 *
 * Thin by design: it owns only I/O — argv parsing, host-id resolution, the real
 * git backend (shell-out), the real `gh` label flip, and printing. ALL logic
 * lives in ../lib/state/checkpoint-stop.ts and is tested there against fakes,
 * mirroring the launch.ts / launch.mts and check-upstream.ts / .mts split.
 */

import { join } from "node:path";
import { resolveHostId } from "../lib/host-id.js";
import {
  checkpointStop,
  formatCheckpointStop,
} from "../lib/state/checkpoint-stop.js";
import {
  configureGh,
  listIssuesByLabel,
  releaseViaLabel,
} from "../lib/state/gh.js";
import { makeExecFileGitRunner } from "../lib/state/index.js";
import { markStatusStopped } from "../lib/status/store.js";

function fail(msg: string): never {
  console.error(`sandcastle:checkpoint-stop: ${msg}`);
  process.exit(1);
}

/**
 * The loop's STAGING_BRANCH. This entry point is the right place to own the
 * default: `lib/state/checkpoint-stop.ts` takes the branch as an explicit,
 * required option so the library never hardcodes a branch name it doesn't own.
 */
const DEFAULT_STAGING_BRANCH = "integration-candidate";

/**
 * Whether cross-host sync is enabled, read straight from the environment with
 * the SAME semantics as main.mts's `crossHostSyncEnabled()` / `envFlagEnabled()`
 * (truthy iff the trimmed, lowercased value is "1" or "true"). Duplicated rather
 * than imported because main.mts is a consumer of this lib, not a dependency of
 * it — importing it here would be a cycle.
 *
 * Default OFF: a single-host stop with the flag unset must be inert
 * (no new origin writes).
 */
function crossHostSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SANDCASTLE_CROSS_HOST_SYNC ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

interface Args {
  repoRoot: string;
  integrationBranch: string;
  remote: string;
  stagingBranch: string;
  /** undefined = not overridden on the CLI; fall back to the env flag. */
  syncEnabled?: boolean;
}

function parseArgs(argv: string[]): Args {
  let repoRoot = process.cwd();
  let integrationBranch: string | undefined;
  let remote = "origin";
  let stagingBranch = DEFAULT_STAGING_BRANCH;
  let syncEnabled: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`flag ${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--repo-root":
        repoRoot = next();
        break;
      case "--integration-branch":
        integrationBranch = next();
        break;
      case "--remote":
        remote = next();
        break;
      case "--staging-branch":
        stagingBranch = next();
        break;
      case "--sync":
        // Explicit opt-in on the CLI, overriding the env flag.
        syncEnabled = true;
        break;
      default:
        fail(`unknown flag: ${a}`);
    }
  }
  if (!integrationBranch) fail("--integration-branch is required");
  return { repoRoot, integrationBranch, remote, stagingBranch, syncEnabled };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const hostId = resolveHostId();
  // Point `gh` at the repo being reaped, not the launch cwd — the same call
  // runMain makes before its first gh call, and the reason `--repo-root` works
  // at all when this runner is invoked from somewhere else.
  configureGh({ cwd: args.repoRoot });

  // ONE authoritative read of what is ACTUALLY still labelled `in-progress`,
  // taken before the sweep (the loop is already dead, so nothing is moving).
  //
  // WHY IT IS NEEDED: the sweep enumerates the `agent/issue-<N>` WORKTREES left
  // on disk, and a leftover worktree from an issue that already SHIPPED is
  // indistinguishable from a live one with nothing to save — same clean tree,
  // same not-ahead HEAD. `releaseViaLabel` is a blind `gh issue edit --add-label
  // ready-for-agent --remove-label in-progress`, so flipping one of those would
  // re-queue a ticket whose code is on main and the next run would rebuild it.
  // Intersecting against this set is what makes the flip safe — the same shape
  // the loop's own shutdown reconciliation uses.
  //
  // A FAILED read is not silently treated as "nothing to release": the error is
  // re-thrown per issue, so every line says `label release FAILED` with the
  // reason instead of a clean, wrong "released".
  let inProgress: Set<number> | undefined;
  let inProgressError: Error | undefined;
  try {
    inProgress = new Set(
      (await listIssuesByLabel("in-progress")).map((i) => i.number),
    );
  } catch (err) {
    inProgressError = err instanceof Error ? err : new Error(String(err));
  }

  const results = await checkpointStop(makeExecFileGitRunner(), {
    repoRoot: args.repoRoot,
    hostId,
    integrationBranch: args.integrationBranch,
    remote: args.remote,
    stagingBranch: args.stagingBranch,
    // `--sync` wins; otherwise the env flag decides, defaulting OFF (inert).
    syncEnabled: args.syncEnabled ?? crossHostSyncEnabled(),
    // `--now` reaps THIS host's own leases (the operator opted in by running
    // it), so releasing is always permitted — this explicit always-permit
    // policy replaces the former delete-by-default fall-through.
    canReleaseLease: async () => true,
    // The GitHub half of the reap, injected here so the library stays pure
    // (git via the runner, GitHub via this callback — no `gh` import there).
    // A SIGKILL'd loop cannot flip its own labels, so without this the board
    // keeps showing every in-flight issue as "being built now" long after the
    // stop. Used to be a hand step in the sandcastle-stop skill; now it is not.
    // The library decides WHICH issues are safe to release and swallows a
    // failure into that issue's result line, so a broken `gh` costs us a label,
    // never the WIP rescue.
    releaseLabel: async (issue) => {
      if (inProgressError) throw inProgressError;
      if (!inProgress?.has(issue)) return "not-in-progress";
      await releaseViaLabel(
        issue,
        `[sandcastle --now reap] the loop working this issue was killed; its ` +
          `work is checkpointed to a WIP ref and its lease released — the ` +
          `label is returned to ready-for-agent so nothing is left claiming ` +
          `to be in flight`,
      );
      return "released";
    },
  });
  console.log(formatCheckpointStop(results));

  // FINAL step: the killed loop can no longer call finish(), so status.json is
  // still lying `running`. Reconcile it to `stopped` now that the refs are safe.
  // Best-effort — a missing/torn file is a no-op and never fails the stop.
  markStatusStopped({ path: join(args.repoRoot, ".sandcastle", "status.json") });
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
