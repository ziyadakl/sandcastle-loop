#!/usr/bin/env tsx

/**
 * CONVERGENCE runner (Workstream 3). Brings every machine to one point: merges
 * every peer's hidden `refs/sandcastle/lanes/<host>` lane onto the run branch
 * and pushes the converged branch back. Run on ONE machine (usually after a
 * multi-host run drains) so no host is left holding a peer's final, unmerged
 * lane. Wire-up:
 *   `tsx .sandcastle/scripts/converge.mts --branch <b> [--repo-root <p>] [--remote <r>]`
 *
 * Thin by design: it owns only I/O — argv parsing, host-id resolution, the real
 * git backend (shell-out), and printing. ALL logic lives in
 * ../lib/state/converge.ts and is tested there against a real bare repo,
 * mirroring the checkpoint-stop.ts / checkpoint-stop.mts split.
 */

import { resolveHostId } from "../lib/host-id.js";
import { convergeLanes, makeExecFileGitRunner } from "../lib/state/index.js";
import type { ConvergeResult } from "../lib/state/index.js";

function fail(msg: string): never {
  console.error(`sandcastle:converge: ${msg}`);
  process.exit(1);
}

interface Args {
  repoRoot: string;
  branch: string;
  remote: string;
}

function parseArgs(argv: string[]): Args {
  let repoRoot = process.cwd();
  let branch: string | undefined;
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
      case "--branch":
        branch = next();
        break;
      case "--remote":
        remote = next();
        break;
      default:
        fail(`unknown flag: ${a}`);
    }
  }
  if (!branch) fail("--branch is required");
  return { repoRoot, branch, remote };
}

/** Render a readable per-lane summary of a convergence run. */
function formatConverge(result: ConvergeResult): string {
  const lines: string[] = [];
  lines.push(`sandcastle:converge: run branch tip -> ${result.branchTip || "(unknown)"}`);
  for (const lane of result.perLane) {
    const tip = lane.tip ? ` @ ${lane.tip.slice(0, 12)}` : "";
    lines.push(`  ${lane.result.padEnd(8)} ${lane.host}${tip}`);
  }
  if (result.conflicts.length > 0) {
    lines.push(`  ${result.conflicts.length} conflict marker(s) written:`);
    for (const ref of result.conflicts) lines.push(`    ${ref}`);
  }
  for (const lane of unrecordedConflicts(result)) {
    lines.push(`  !! ${lane.host}: ${lane.reason ?? "conflict marker NOT recorded"}`);
  }
  return lines.join("\n");
}

/**
 * Conflicting lanes whose durable marker could NOT be written/pushed. These are
 * LOUD: the divergence exists but nothing on the remote records it, so the run
 * must not exit 0 and let a human believe the machines are reconciled.
 */
function unrecordedConflicts(result: ConvergeResult) {
  return result.perLane.filter((l) => l.result === "conflict" && !l.markerRef);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const hostId = resolveHostId();
  const result = await convergeLanes(makeExecFileGitRunner(), {
    repoRoot: args.repoRoot,
    branch: args.branch,
    hostId,
    remote: args.remote,
  });
  console.log(formatConverge(result));
  // A push fault throws (caught below → exit 1). An UNRECORDED conflict marker
  // returns normally but is equally a failure to converge visibly → exit 1 too,
  // so no caller mistakes an unrecorded divergence for a clean run.
  const unrecorded = unrecordedConflicts(result);
  if (unrecorded.length > 0) {
    fail(
      `${unrecorded.length} conflict(s) could NOT be durably recorded — ` +
        `the divergence is NOT captured on the remote; reconcile by hand`,
    );
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
