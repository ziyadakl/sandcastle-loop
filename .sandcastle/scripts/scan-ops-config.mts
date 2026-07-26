#!/usr/bin/env tsx

/**
 * OPS-CONFIG blind-spot reporter. Computes a run's diff against the merge base
 * and prints an explicit "OPS-CONFIG TO-DO" block naming the deploy config the
 * sandbox CANNOT verify — cron scheduling and required secrets — so the human
 * owner provisions them. Wire-up:
 *   `tsx .sandcastle/scripts/scan-ops-config.mts [--repo-root <p>] [--base <ref>]`
 *
 * Thin by design: it owns only I/O — argv parsing, the two git diff shell-outs,
 * and printing. ALL detection logic lives in ../lib/ops-config/scan.ts and is
 * tested there, mirroring the converge.mts / lib/state/converge.ts split.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanOpsConfig } from "../lib/ops-config/scan.js";

const execFileAsync = promisify(execFile);

function fail(msg: string): never {
  console.error(`sandcastle:scan-ops-config: ${msg}`);
  process.exit(1);
}

interface Args {
  repoRoot: string;
  base: string;
}

function parseArgs(argv: string[]): Args {
  let repoRoot = process.cwd();
  let base = "origin/main";
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
      case "--base":
        base = next();
        break;
      default:
        fail(`unknown flag: ${a}`);
    }
  }
  return { repoRoot, base };
}

/** Shell out to git in `repoRoot`, returning stdout (empty string on failure). */
async function git(repoRoot: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    fail(`git ${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Render the operator-facing to-do block, or null when there is nothing to do. */
function formatToDo(result: ReturnType<typeof scanOpsConfig>): string | null {
  if (result.cronRoutes.length === 0 && result.newRequiredEnvVars.length === 0) {
    return null;
  }
  const lines: string[] = ["OPS-CONFIG TO-DO (out-of-repo, provision manually):"];
  for (const route of result.cronRoutes) {
    lines.push(
      `  - cron: route \`${route}\` exists but scheduling is out-of-repo — provision the scheduler`,
    );
  }
  for (const varName of result.newRequiredEnvVars) {
    lines.push(
      `  - secret: \`${varName}\` must be provisioned as a secret/env in the deploy target`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const range = `${args.base}...HEAD`;
  const patch = await git(args.repoRoot, "diff", range);
  const nameOnly = await git(args.repoRoot, "diff", "--name-only", range);
  const changedFiles = nameOnly.split("\n").map((l) => l.trim()).filter(Boolean);

  const result = scanOpsConfig({ changedFiles, patch });
  const block = formatToDo(result);
  console.log(block ?? "sandcastle:scan-ops-config: none");
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
