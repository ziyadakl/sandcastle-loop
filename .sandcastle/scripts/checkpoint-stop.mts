#!/usr/bin/env tsx

/**
 * POST-KILL checkpoint runner (ADR 0021). After a loop process is killed, its
 * per-issue worktrees survive on disk; this runner persists them as WIP refs and
 * releases their leases so another host can resume. Wire-up:
 * `tsx .sandcastle/scripts/checkpoint-stop.mts --integration-branch <b>`.
 *
 * Thin by design: it owns only I/O — argv parsing, host-id resolution, the real
 * git backend (shell-out), and printing. ALL logic lives in
 * ../lib/state/checkpoint-stop.ts and is tested there against a fake GitRunner,
 * mirroring the launch.ts / launch.mts and check-upstream.ts / .mts split.
 */

import { join } from "node:path";
import { resolveHostId } from "../lib/host-id.js";
import {
  checkpointStop,
  formatCheckpointStop,
} from "../lib/state/checkpoint-stop.js";
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
 * Default OFF: per ADR 0021 a single-host stop with the flag unset must be inert
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
  const results = await checkpointStop(makeExecFileGitRunner(), {
    repoRoot: args.repoRoot,
    hostId,
    integrationBranch: args.integrationBranch,
    remote: args.remote,
    stagingBranch: args.stagingBranch,
    // `--sync` wins; otherwise the env flag decides, defaulting OFF (inert).
    syncEnabled: args.syncEnabled ?? crossHostSyncEnabled(),
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
