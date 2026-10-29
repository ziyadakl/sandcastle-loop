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
 * (../lib/hosts/launch.test.ts) with a fake exec, mirroring the
 * check-upstream.ts / check-upstream.mts split.
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
import {
  discoverInflightRun,
  discoverResumableRun,
} from "../lib/state/inflight-discovery.js";
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
  label?: string;
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
      case "--label":
        args.label = next();
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
      return { ok: true, stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: unknown;
        status?: unknown;
      };
      // execFileAsync rejects on ANY non-zero exit. Surface the numeric exit
      // code so the gate can tell `git diff --quiet` "differs" (exit 1) apart
      // from a git ERROR (exit >= 2). `.code` is the exit status for a normal
      // non-zero exit (Node populates it on the async execFile error), `.status`
      // is the execFileSync-style field. A spawn failure (ENOENT etc.) sets
      // `.code` to a STRING, not an exit status, so coerce anything non-numeric
      // to 2 — a hard error, never mistaken for "differs".
      const raw = typeof e.code === "number" ? e.code : e.status;
      const exitCode = typeof raw === "number" ? raw : 2;
      return {
        ok: false,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message ?? "exec failed",
        exitCode,
      };
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

  // For resume, pre-fill the branch from the run discovered on origin. TWO
  // reads, in order, because the common reason to resume is that the loop is
  // DEAD — and a liveness probe cannot see a dead loop:
  //
  //   1. `discoverInflightRun` — a fresh, still-`running` peer. This is the
  //      cross-host case: another machine is mid-run and this one is joining.
  //   2. `discoverResumableRun` — the most recent run that never reached
  //      `done`, at any age. This is the dead-loop case.
  //
  // Before 2026-08-16 only (1) existed, so resuming the run that died in the
  // night failed with "nothing to resume" — the exact moment resume is for.
  // The fallback ANNOUNCES what it found, because relaunching a run the
  // operator believes is alive must never be silent.
  let branch = args.branch;
  if (args.action === "resume" && !branch) {
    const git = makeExecFileGitRunner();
    const inflight = await discoverInflightRun(git, repoRoot);
    if (inflight) {
      branch = inflight.branch;
    } else {
      const last = await discoverResumableRun(git, repoRoot);
      if (!last) {
        fail(
          "resume: no unfinished run found on origin (nothing to resume). " +
            "Pass --branch <name> to relaunch a specific branch anyway.",
        );
      }
      branch = last.branch;
      console.log(
        `sandcastle:launch: no live host — resuming the last unfinished run ` +
          `${last.runId} on ${branch}, last seen "${last.state}" at ${last.updatedAt}` +
          (last.inflightIssues.length > 0
            ? ` (issue lease(s) still held: ${last.inflightIssues.join(", ")})`
            : ""),
      );
    }
  }
  if (!branch) fail("a --branch is required (or use --action resume to discover one)");

  const spec: LaunchSpec = {
    branch,
    mode: args.mode,
    iterations: args.iterations,
    base: args.base,
    label: args.label,
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
