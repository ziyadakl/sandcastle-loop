#!/usr/bin/env tsx

/**
 * Multi-host LAUNCH runner (workstream B4). Loads the host registry, then runs
 * the per-host safety gate ({@link runLaunch}) against every host (or one named
 * host via `--host`) and prints a per-host summary. Wire-up example:
 * `tsx .sandcastle/scripts/launch.mts --branch <b> --iterations 10`.
 *
 * This runner does only I/O — it owns the single un-unit-tested surface: the
 * real `exec` collaborator that spawns argv locally or over `ssh <alias> --
 * <argv>`. All gate LOGIC lives in ../lib/hosts/launch.ts and is tested there
 * with a fake exec, mirroring the check-upstream.ts / check-upstream.mts split.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isLocalHost, loadHostsConfig, type HostConfig } from "../lib/hosts/registry.js";
import { formatHostResults, type HostResult } from "../lib/hosts/result.js";
import {
  runLaunch,
  buildRemoteCommand,
  isLaunchMode,
  LAUNCH_MODES,
  type ExecResult,
  type LaunchDeps,
  type LaunchMode,
  type LaunchSpec,
} from "../lib/hosts/launch.js";
import { discoverInflightRun } from "../lib/state/inflight-discovery.js";
import { makeExecFileGitRunner } from "../lib/state/index.js";

const execFileAsync = promisify(execFile);

function fail(msg: string): never {
  console.error(`sandcastle:launch: ${msg}`);
  process.exit(1);
}

/** Parse the small flag set this runner understands. */
interface Args {
  host?: string;
  dryRun: boolean;
  action: "run" | "resume";
  branch?: string;
  mode: LaunchMode;
  iterations: number;
  base?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, action: "run", mode: "claude", iterations: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`flag ${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--host":
        args.host = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--action":
        {
          const v = next();
          if (v !== "run" && v !== "resume") fail(`--action must be run|resume, got ${v}`);
          args.action = v;
        }
        break;
      case "--branch":
        args.branch = next();
        break;
      case "--mode":
        {
          const v = next();
          if (!isLaunchMode(v)) fail(`--mode must be ${LAUNCH_MODES.join("|")}, got ${v}`);
          args.mode = v;
        }
        break;
      case "--iterations":
        args.iterations = Number(next());
        break;
      case "--base":
        args.base = next();
        break;
      default:
        fail(`unknown flag: ${a}`);
    }
  }
  return args;
}

/**
 * The real transport: run `argv` on `host`. Local hosts spawn the argv directly
 * in the repo root (the process cwd). Remote hosts go over
 * `ssh <transport> "<cmd>"` where `<cmd>` is a SINGLE shell-command string built
 * by {@link buildRemoteCommand}: `cd '<host.repoPath>' && <shell-quoted argv>`.
 * This is required because (a) a non-interactive ssh lands in the login dir, not
 * the checkout — so we `cd` into `host.repoPath` (from the registry) first — and
 * (b) `ssh <alias> -- a b c` space-joins the args and the remote shell re-parses
 * them, which mangles any multi-line argv element; shell-quoting each element
 * makes it reconstruct argv exactly. Never throws — a spawn/exec failure maps to
 * `{ ok: false }` so the gate can classify it.
 */
function makeRealExec(repoRoot: string): LaunchDeps["exec"] {
  return async (host: HostConfig, argv: string[]): Promise<ExecResult> => {
    const local = isLocalHost(host);
    let cmd: string;
    let rest: string[];
    let cwd: string | undefined;
    if (local) {
      cmd = argv[0];
      rest = argv.slice(1);
      cwd = repoRoot;
    } else {
      cmd = "ssh";
      rest = [host.transport, buildRemoteCommand(host.repoPath!, argv)];
      cwd = undefined;
    }
    try {
      const { stdout, stderr } = await execFileAsync(cmd, rest, {
        cwd,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { ok: true, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "exec failed" };
    }
  };
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv.slice(2));

  const hosts = loadHostsConfig(
    join(repoRoot, ".sandcastle", "hosts.json"),
    (p) => readFileSync(p, "utf8"),
  );

  const targets = args.host
    ? hosts.filter((h) => h.name === args.host)
    : hosts;
  if (targets.length === 0) {
    fail(`no host named "${args.host}" in the registry (have: ${hosts.map((h) => h.name).join(", ")})`);
  }

  // For resume, pre-fill the branch from the in-flight run discovered on origin.
  let branch = args.branch;
  if (args.action === "resume" && !branch) {
    const inflight = await discoverInflightRun(makeExecFileGitRunner(), repoRoot);
    if (!inflight) fail("resume: no in-flight run found across hosts (nothing to resume)");
    branch = inflight.branch;
  }
  if (!branch) fail("a --branch is required (or use --action resume to discover one)");

  const spec: LaunchSpec = {
    branch,
    mode: args.mode,
    iterations: args.iterations,
    base: args.base,
    action: args.action,
    dryRun: args.dryRun,
  };

  const exec = makeRealExec(repoRoot);
  const deps: LaunchDeps = { exec };

  const results: HostResult[] = [];
  for (const host of targets) {
    results.push(await runLaunch(host, spec, deps));
  }

  console.log(formatHostResults(results));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg);
});
