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

import { resolveHostId } from "../lib/host-id.js";
import {
  checkpointStop,
  formatCheckpointStop,
} from "../lib/state/checkpoint-stop.js";
import { makeExecFileGitRunner } from "../lib/state/index.js";

function fail(msg: string): never {
  console.error(`sandcastle:checkpoint-stop: ${msg}`);
  process.exit(1);
}

interface Args {
  repoRoot: string;
  integrationBranch: string;
  remote: string;
}

function parseArgs(argv: string[]): Args {
  let repoRoot = process.cwd();
  let integrationBranch: string | undefined;
  let remote = "origin";
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
      default:
        fail(`unknown flag: ${a}`);
    }
  }
  if (!integrationBranch) fail("--integration-branch is required");
  return { repoRoot, integrationBranch, remote };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const hostId = resolveHostId();
  const results = await checkpointStop(makeExecFileGitRunner(), {
    repoRoot: args.repoRoot,
    hostId,
    integrationBranch: args.integrationBranch,
    remote: args.remote,
  });
  console.log(formatCheckpointStop(results));
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
