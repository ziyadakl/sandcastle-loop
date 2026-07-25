#!/usr/bin/env tsx

/**
 * Purge stale Sandcastle COORDINATION refs from a remote (template hardening A3).
 * Sweeps BOTH `refs/locks/*` (issue leases) and `refs/sandcastle/*` (wip, lanes,
 * status, peer-status, peers, strand, conflict) off `origin`, never touching
 * `refs/heads/*` or `refs/pull/*`. Wire-up:
 * `tsx .sandcastle/scripts/purge-coordination-refs.mts --repo-root <path> --yes`.
 *
 * Thin by design: it owns only I/O — argv parsing, the real git backend
 * (shell-out), and printing. ALL logic lives in
 * ../lib/state/purge-coordination-refs.ts and is tested there against a real bare
 * origin, mirroring the checkpoint-stop.ts / checkpoint-stop.mts split.
 *
 * SAFE DEFAULT: with neither `--dry-run` nor `--yes`, a bare invocation is a
 * PREVIEW — it prints what WOULD be deleted and deletes nothing. `--dry-run` is
 * preview only; `--yes` actually deletes. A summary prints either way.
 */

import {
  purgeCoordinationRefs,
  formatPurge,
} from "../lib/state/purge-coordination-refs.js";
import { makeExecFileGitRunner } from "../lib/state/index.js";

function fail(msg: string): never {
  console.error(`sandcastle:purge-coordination-refs: ${msg}`);
  process.exit(1);
}

interface Args {
  repoRoot: string;
  remote: string;
  /** true = actually delete (only when --yes was passed). */
  yes: boolean;
  /** true = preview only (default, and forced by --dry-run). */
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let repoRoot = process.cwd();
  let remote = "origin";
  let yes = false;
  let dryRun = false;
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
      case "--remote":
        remote = next();
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--yes":
        yes = true;
        break;
      default:
        fail(`unknown flag: ${a}`);
    }
  }
  return { repoRoot, remote, yes, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // SAFE DEFAULT: only delete when --yes is passed AND --dry-run was not; a bare
  // invocation previews (deletes nothing).
  const preview = args.dryRun || !args.yes;
  const results = await purgeCoordinationRefs(makeExecFileGitRunner(), {
    repoRoot: args.repoRoot,
    remote: args.remote,
    dryRun: preview,
  });
  console.log(formatPurge(results));
  if (preview) {
    console.log("(preview — pass --yes to actually delete)");
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
