#!/usr/bin/env -S npx tsx
/**
 * Sandcastle "ralph" orchestrator (Wave 6.1, Agent B).
 *
 * Adapts Matt Pocock's `parallel-planner-with-review` template (verified at
 * node_modules/@ai-hero/sandcastle/dist/templates/parallel-planner-with-review
 * /main.mts) and layers our shipped safety modules on top:
 *
 *   - GitHub label state machine (src/state/gh.ts):
 *       ready-for-agent → in-progress → done | needs-human
 *   - Typed verdict envelope parser (src/verdicts/parse.ts) — STORY_COMPLETE
 *     marker MUST come with a valid ImplementerOutput JSON payload.
 *   - Migration auto-applier (src/migrations/drizzle-applier.ts) — runs
 *     between implementer and reviewer when new SQL files appear.
 *   - Per-issue pipeline: implementer → migrations → reviewer → markDone, with
 *     quarantine on any error or HAS_BLOCKERS verdict.
 *   - Optional `--recovery on` flag: on pipeline error, retry once with the
 *     implementer model before quarantining (off by default).
 *   - Bash-style circuit breaker (3 consecutive failures = trip).
 *
 * The driver is structured so it can be invoked as a CLI (parses argv and
 * runs to completion) OR imported and driven from a test (`runMain` accepts
 * an injected `Deps` bag that replaces sandcastle / gh calls with stubs).
 */

import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker, defaultImageName } from "@ai-hero/sandcastle/sandboxes/docker";

import {
  claimViaLabel,
  quarantineViaLabel,
  markDoneViaLabel,
  postIssueComment,
  LABEL_READY,
} from "./lib/state/index.js";
import { parseVerdict, extractMarker } from "./lib/verdicts/index.js";
import { ImplementerOutputSchema } from "./lib/verdicts/index.js";
import { applyMigrationsBetween } from "./lib/migrations/index.js";
import { models } from "./models.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Issue selected by the planner (or the one-shot --issue path) and pushed
 * into the parallel execute pool. `id` is a string because the planner emits
 * GitHub issue numbers as strings in JSON; we coerce when calling gh.
 */
export interface PlanIssue {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
}

/**
 * Args parsed from argv (or supplied programmatically in tests). Every
 * default lives here so consumers don't have to remember them.
 */
export interface RalphArgs {
  iterations: number;
  issue?: number;
  repoRoot: string;
  branch: string;
  label: string;
  maxConcurrent: number;
  plannerModel: string;
  implementerModel: string;
  reviewerModel: string;
  mergerModel: string;
  postMergeReviewerModel: string;
  recoveryModel: string;
  implementerTimeoutSec: number;
  reviewerTimeoutSec: number;
  consecutiveFailureLimit: number;
  logFile?: string;
  dryRun: boolean;
  /**
   * Opt-in single-pass recovery. When true, the orchestrator re-runs the
   * implementer model against `./.sandcastle/recovery-prompt.md` once on a
   * pipeline error before quarantining. Defaults to false (current behavior:
   * any error → quarantine).
   */
  recoveryEnabled: boolean;
  /**
   * Docker image to run the sandbox in. Defaults to the same name
   * `sandcastle docker build-image` produces — `sandcastle:<basename>` of
   * `--repo-root` (e.g. `~/Dev/myproj` → `sandcastle:myproj`). That match
   * is critical: sandcastle's own `docker()` would otherwise derive the
   * name from the per-issue WORKTREE dir (`sandcastle:agent-issue-83`)
   * which is never the image we just built. Override with `--image-name`.
   */
  imageName: string;
}

/**
 * Test-injection seam. When `deps` is supplied, the orchestrator delegates
 * every external side effect through these functions. Production callers
 * leave it undefined and get the real `sandcastle.run`/`sandcastle.createSandbox`
 * / gh wrappers via {@link buildDefaultDeps}.
 *
 * The shapes intentionally use a structural subset of `RunResult` /
 * `SandboxRunResult` / `Sandbox` so tests can return plain literals.
 */
export interface RunHandle {
  readonly stdout: string;
  readonly commits: readonly { sha: string }[];
}

export interface SandboxHandle {
  readonly branch: string;
  readonly worktreePath?: string;
  run(opts: SandboxRunSpec): Promise<RunHandle>;
  close(): Promise<unknown>;
}

/** Distilled "what to run" descriptor — the seam consumes this verbatim. */
export interface SandboxRunSpec {
  readonly name: string;
  readonly maxIterations?: number;
  readonly model: string;
  readonly promptFile: string;
  readonly promptArgs?: Record<string, string>;
  readonly idleTimeoutSeconds?: number;
}

export interface TopLevelRunSpec extends SandboxRunSpec {
  readonly mounts?: readonly { hostPath: string; sandboxPath: string; readonly?: boolean }[];
}

export interface CreateSandboxSpec {
  readonly branch: string;
  readonly mounts?: readonly { hostPath: string; sandboxPath: string; readonly?: boolean }[];
}

export interface Deps {
  /** Top-level `sandcastle.run({...})` wrapper. */
  run(spec: TopLevelRunSpec): Promise<RunHandle>;
  /** `sandcastle.createSandbox({...})` wrapper. */
  createSandbox(spec: CreateSandboxSpec): Promise<SandboxHandle>;
  /** Label state machine. */
  claim(issueNum: number): Promise<void>;
  markDone(issueNum: number, summary: string): Promise<void>;
  quarantine(issueNum: number, reason: string): Promise<void>;
  comment(issueNum: number, body: string): Promise<void>;
  /** Migrations between two SHAs in `repoRoot`. Returns # applied + errors. */
  applyMigrations(
    repoRoot: string,
    preSha: string,
    postSha: string,
  ): Promise<{ applied: number; realErrors: readonly { msg: string }[] }>;
  /** Capture the current HEAD SHA inside the sandbox worktree. */
  captureSha(worktreePath: string): Promise<string>;
  /** Logger (info-level). Tests inject a recorder; production logs to stderr. */
  log(line: string): void;
  /** Logger (error-level). */
  logError(line: string): void;
}

export interface RunMainResult {
  /** Process exit code: 0 / 1 / 2 per the spec. */
  exitCode: 0 | 1 | 2;
  /** Iterations completed (1-indexed; 0 means we exited before the first cycle). */
  iterationsRun: number;
  /** Counters useful for tests. */
  shippedIssues: number[];
  quarantinedIssues: number[];
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const HELP_TEXT = `\
sandcastle-loop — autonomous parallel-planner orchestrator

Usage:
  sandcastle-loop --iterations N [options]
  npx tsx .sandcastle/main.mts --iterations N [options]

Required:
  --iterations N            Outer plan→execute→merge cycles to run (≥ 1).

Optional:
  --issue N                 One-shot mode: skip planner, work this issue only.
  --repo-root PATH          Working directory (default: cwd).
  --branch NAME             Base branch (default: current; refuses main/master).
  --label NAME              Label to claim (default: ready-for-agent).
  --max-concurrent N        Parallel issues per cycle (default: 3).
  --planner-model M             Default: from .sandcastle/models.ts (planner.default).
  --implementer-model M         Default: from .sandcastle/models.ts (implementer.default).
  --reviewer-model M            Default: from .sandcastle/models.ts (reviewer.default).
  --merger-model M              Default: from .sandcastle/models.ts (merger.default).
  --post-merge-reviewer-model M Default: from .sandcastle/models.ts (postMergeReviewer.default).
  --recovery-model M            Default: from .sandcastle/models.ts (recovery.default). Used by the recovery pass.
  --implementer-timeout-sec N   Default: 1200.
  --reviewer-timeout-sec N      Default: 600.
  --consecutive-failure-limit N Default: 3.
  --log-file PATH           Tee output to this file.
  --dry-run                 Skip claim/quarantine/markDone side effects.
  --recovery off            Disable the single recovery pass that fires on
                            any pipeline error. Default: on (recovery uses
                            --recovery-model and runs once before quarantine).
  --image-name NAME         Docker image to run sandboxes in.
                            Default: derived from --repo-root basename
                            (e.g. /Dev/myproj → sandcastle:myproj),
                            matching 'sandcastle docker build-image'.
  --help                    Show this message and exit 0.

Exit codes:
  0  No claimable stories OR successful completion.
  1  Circuit breaker tripped or fatal error.
  2  Max iterations exhausted (still ran fine — just out of cycles).
`;

/**
 * Parse argv into a fully-defaulted {@link RalphArgs}. Throws on validation
 * errors with a precise message — the CLI entry catches and exits 2.
 *
 * Exported so tests can drive the orchestrator without re-implementing the
 * full default set.
 */
export function parseRalphArgs(argv: readonly string[]): {
  args: RalphArgs;
  showHelp: boolean;
} {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      "iterations": { type: "string" },
      "issue": { type: "string" },
      "repo-root": { type: "string" },
      "branch": { type: "string" },
      "label": { type: "string" },
      "max-concurrent": { type: "string" },
      "planner-model": { type: "string" },
      "implementer-model": { type: "string" },
      "reviewer-model": { type: "string" },
      "merger-model": { type: "string" },
      "post-merge-reviewer-model": { type: "string" },
      "recovery-model": { type: "string" },
      "implementer-timeout-sec": { type: "string" },
      "reviewer-timeout-sec": { type: "string" },
      "consecutive-failure-limit": { type: "string" },
      "log-file": { type: "string" },
      "dry-run": { type: "boolean" },
      "recovery": { type: "string" },
      "image-name": { type: "string" },
      "help": { type: "boolean" },
    },
  });

  if (values.help === true) {
    return {
      args: defaultArgs(),
      showHelp: true,
    };
  }

  const iterations = parsePositiveInt(values.iterations, "--iterations");
  if (iterations === null) {
    throw new Error("--iterations is required and must be an integer ≥ 1");
  }

  const issue =
    values.issue !== undefined
      ? parsePositiveInt(values.issue, "--issue") ?? undefined
      : undefined;

  const args: RalphArgs = {
    iterations,
    issue,
    repoRoot: values["repo-root"] ?? process.cwd(),
    branch: values.branch ?? detectBranchOr("HEAD"),
    label: values.label ?? LABEL_READY,
    maxConcurrent:
      parsePositiveInt(values["max-concurrent"], "--max-concurrent") ?? 3,
    plannerModel: values["planner-model"] ?? models.planner.default,
    implementerModel: values["implementer-model"] ?? models.implementer.default,
    reviewerModel: values["reviewer-model"] ?? models.reviewer.default,
    mergerModel: values["merger-model"] ?? models.merger.default,
    postMergeReviewerModel:
      values["post-merge-reviewer-model"] ?? models.postMergeReviewer.default,
    recoveryModel: values["recovery-model"] ?? models.recovery.default,
    implementerTimeoutSec:
      parsePositiveInt(
        values["implementer-timeout-sec"],
        "--implementer-timeout-sec",
      ) ?? 1200,
    reviewerTimeoutSec:
      parsePositiveInt(
        values["reviewer-timeout-sec"],
        "--reviewer-timeout-sec",
      ) ?? 600,
    consecutiveFailureLimit:
      parsePositiveInt(
        values["consecutive-failure-limit"],
        "--consecutive-failure-limit",
      ) ?? 3,
    logFile: values["log-file"],
    dryRun: values["dry-run"] === true,
    recoveryEnabled: values["recovery"] !== "off",
    imageName:
      values["image-name"] ??
      defaultImageName(path.resolve(values["repo-root"] ?? process.cwd())),
  };
  return { args, showHelp: false };
}

function parsePositiveInt(raw: unknown, flag: string): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new Error(`${flag}: expected a string, got ${typeof raw}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag}: expected an integer ≥ 1, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Best-effort detection of the current git branch. Returns `fallback` if `git`
 * is unavailable or the repo is in a detached state.
 */
function detectBranchOr(fallback: string): string {
  try {
    const out = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.length > 0 ? out : fallback;
  } catch {
    return fallback;
  }
}

function defaultArgs(): RalphArgs {
  return {
    iterations: 1,
    repoRoot: process.cwd(),
    branch: "HEAD",
    label: LABEL_READY,
    maxConcurrent: 3,
    plannerModel: models.planner.default,
    implementerModel: models.implementer.default,
    reviewerModel: models.reviewer.default,
    mergerModel: models.merger.default,
    postMergeReviewerModel: models.postMergeReviewer.default,
    recoveryModel: models.recovery.default,
    implementerTimeoutSec: 1200,
    reviewerTimeoutSec: 600,
    consecutiveFailureLimit: 3,
    dryRun: false,
    recoveryEnabled: true,
    imageName: defaultImageName(process.cwd()),
  };
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

const REQUIRED_PROMPT_FILES = [
  "plan-prompt.md",
  "implement-prompt.md",
  "review-prompt.md",
  "merge-prompt.md",
] as const;

export interface PreflightResult {
  ok: boolean;
  errors: readonly string[];
}

/**
 * Pre-flight checks: gh auth, branch sanity, repo presence, prompt-file
 * presence, docker daemon. Pure — never mutates state. Tests call it
 * directly with their own runners.
 */
export function preflight(args: RalphArgs, opts: {
  exec?: (bin: string, args: readonly string[]) => { ok: boolean; stderr?: string };
  fileExists?: (p: string) => boolean;
} = {}): PreflightResult {
  const errors: string[] = [];
  const exec =
    opts.exec ??
    ((bin, a) => {
      try {
        execFileSync(bin, [...a], { stdio: ["ignore", "ignore", "pipe"] });
        return { ok: true };
      } catch (err) {
        return { ok: false, stderr: (err as Error).message };
      }
    });
  const fileExists = opts.fileExists ?? ((p) => existsSync(p));

  // 1. gh auth
  const gh = exec("gh", ["auth", "status"]);
  if (!gh.ok) errors.push(`gh auth status failed: ${gh.stderr ?? "unknown"}`);

  // 2. branch != main/master
  if (args.branch === "main" || args.branch === "master") {
    errors.push(
      `refuse to run on protected branch '${args.branch}' — pass --branch <feature>`,
    );
  }

  // 3. repo is git
  if (!fileExists(path.join(args.repoRoot, ".git"))) {
    errors.push(
      `--repo-root '${args.repoRoot}' is not a git repo (missing .git/)`,
    );
  }

  // 4. all 7 prompt files exist
  const sandcastleDir = path.join(args.repoRoot, ".sandcastle");
  for (const f of REQUIRED_PROMPT_FILES) {
    const full = path.join(sandcastleDir, f);
    if (!fileExists(full)) errors.push(`missing prompt file: ${full}`);
  }

  // 5. docker daemon
  const dk = exec("docker", ["info"]);
  if (!dk.ok) errors.push(`docker info failed: ${dk.stderr ?? "unknown"}`);

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Git identity helper — read user.name + user.email from host so the agent's
// `git commit` calls inside the container have a committer identity. We
// bypass mounting ~/.gitconfig (single-file Docker mounts are flaky on
// atomic-rename writes; cause "Device or resource busy" failures).
// ---------------------------------------------------------------------------

/**
 * Parse one dotenv-style file into a Record. Returns {} on read error.
 * Format: KEY=VALUE per line, `#` comments, blank lines skipped, single-
 * or double-quoted values stripped. Multi-line values are not supported.
 */
function parseDotenvFile(filePath: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) env[key] = val;
  }
  return env;
}

/**
 * Read the target project's dotenv files so the orchestrator can pass real
 * Supabase / Postgres / API-key values into the sandbox via docker `-e`.
 *
 * Why this is needed: target repos like affinity-tracker keep their real
 * POSTGRES_URL in `.env` at the main-repo root and only symlink `.env.local`
 * into worktrees (and even that symlink is broken inside the bind-mounted
 * sandbox). Without surfacing those vars as docker env, the Next.js dev-
 * server can't initialise, playwright can't run, and every UI story HALTs.
 *
 * Search order (later files override earlier ones, matching Next.js's
 * `.env*` loading order):
 *
 *   1. mainRepoRoot/.env
 *   2. mainRepoRoot/.env.local
 *   3. repoRoot/.env             (worktree overlay)
 *   4. repoRoot/.env.local       (worktree overlay)
 *
 * `mainRepoRoot` is discovered via `git rev-parse --git-common-dir`, which
 * returns the shared .git directory even when invoked from a worktree.
 *
 * Security note: every key in these files reaches the sandbox process
 * environment. Don't put credentials there that you don't want the agent
 * to see / log.
 */
function readProjectEnv(repoRoot: string): Record<string, string> {
  const resolvedRepo = path.resolve(repoRoot);
  let mainRoot = resolvedRepo;
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: resolvedRepo,
      encoding: "utf-8",
    });
    const commonDir = path.resolve(resolvedRepo, out.trim());
    mainRoot = path.dirname(commonDir);
  } catch {
    /* not a git repo; mainRoot stays = resolvedRepo */
  }

  const candidates = [
    path.join(mainRoot, ".env"),
    path.join(mainRoot, ".env.local"),
  ];
  if (resolvedRepo !== mainRoot) {
    candidates.push(
      path.join(resolvedRepo, ".env"),
      path.join(resolvedRepo, ".env.local"),
    );
  }

  const merged: Record<string, string> = {};
  for (const f of candidates) {
    Object.assign(merged, parseDotenvFile(f));
  }
  return merged;
}

function buildGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const tryGet = (key: string): string | undefined => {
    try {
      const out = execFileSync("git", ["config", "--get", key], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return out.length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  };
  const name = tryGet("user.name");
  const email = tryGet("user.email");
  if (name !== undefined) {
    env.GIT_AUTHOR_NAME = name;
    env.GIT_COMMITTER_NAME = name;
  }
  if (email !== undefined) {
    env.GIT_AUTHOR_EMAIL = email;
    env.GIT_COMMITTER_EMAIL = email;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Concurrency limiter (small inline semaphore — no extra dep)
// ---------------------------------------------------------------------------

function makeLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (max < 1) throw new Error("makeLimiter: max must be ≥ 1");
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    if (active >= max) return;
    const fn = queue.shift();
    if (fn) {
      active += 1;
      fn();
    }
  };
  function limited<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = (): void => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      };
      queue.push(task);
      next();
    });
  }
  return limited;
}

// ---------------------------------------------------------------------------
// Default deps (production wiring)
// ---------------------------------------------------------------------------

/**
 * Build the production {@link Deps} bag — wires sandcastle.run /
 * sandcastle.createSandbox / src/state/gh.ts wrappers / src/migrations/.
 *
 * `dryRun` short-circuits claim / quarantine / markDone / comment to log-only
 * operations so a misconfigured first run can't move labels.
 */
export function buildDefaultDeps(args: RalphArgs): Deps {
  // pnpm install (not npm) — affinity-tracker and similar monorepos use
  // pnpm's workspace:* protocol which npm refuses to parse. The Dockerfile
  // ships `corepack enable` so `pnpm` works without an extra global install.
  // CI=true is required: without it, pnpm refuses to repair the modules
  // dir on a fresh sandbox (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY)
  // because there's no TTY to confirm. The hook runs non-interactively
  // by definition, so the install hangs/exits without restoring the
  // per-package workspace symlinks (apps/nextjs/node_modules etc.).
  const hooks = {
    sandbox: { onSandboxReady: [{ command: "CI=true pnpm install" }] },
  } as const;
  const copyToWorktree = ["node_modules"];

  // Auth mounts — sandcastle's docker provider does NOT auto-mount these.
  // Without them, `claude` and `gh` inside the container can't see the host's
  // session and fail with "Not logged in" / "no auth" errors.
  //
  // Note: we deliberately do NOT mount ~/.gitconfig. Single-file bind mounts
  // in Docker fail with "Device or resource busy" when anyone (sandcastle's
  // own setup, or the agent) tries to update the file via the standard
  // write-temp-then-rename pattern that git config uses. Instead we read
  // user.name / user.email from the host's gitconfig at CLI startup and
  // pass them as GIT_* env vars (see buildGitEnv below).
  const authMounts = [
    { hostPath: "~/.claude", sandboxPath: "/home/agent/.claude" },
    { hostPath: "~/.config/gh", sandboxPath: "/home/agent/.config/gh" },
  ] as const;
  const buildMounts = (extra?: readonly { hostPath: string; sandboxPath: string; readonly?: boolean }[]) => {
    return extra && extra.length > 0
      ? { mounts: [...authMounts, ...extra] }
      : { mounts: [...authMounts] };
  };

  // Read git user identity from the host at CLI startup. The container's
  // safe.directory will be set up by sandcastle itself; user.name/user.email
  // come through as env vars instead of via a mount.
  //
  // Also read the target project's .env.local so the dev-server / playwright
  // can find POSTGRES_URL / SUPABASE creds / etc. inside the sandbox.
  // gitEnv keys win on collision (don't let a stray .env.local override
  // the orchestrator's git identity).
  const gitEnv = buildGitEnv();
  const projectEnv = readProjectEnv(args.repoRoot);
  const containerEnv = { ...projectEnv, ...gitEnv };

  const dryLog = (action: string, ...rest: unknown[]): void => {
    process.stderr.write(
      `[dry-run] ${action} ${rest.map((r) => JSON.stringify(r)).join(" ")}\n`,
    );
  };

  // Sandcastle's default completion signal is `<promise>COMPLETE</promise>`.
  // The implementer prompt also has `<promise>HALT</promise>` for blocked
  // stories, but sandcastle didn't recognise HALT as terminal — so on the
  // 2026-05-08 issue #83 smoke test, the implementer HALTed cleanly on
  // iteration 1 and sandcastle then re-ran it 5+ more times burning Sonnet
  // tokens. Treat HALT as a completion signal too. Other agents that don't
  // emit HALT are unaffected.
  const completionSignal = [
    "<promise>COMPLETE</promise>",
    "<promise>HALT</promise>",
  ];

  return {
    async run(spec) {
      // Top-level runs (planner, merger) don't need `pnpm install` — the
      // planner just calls `gh` + reads files, the merger just runs `git
      // merge`. Running the hook here previously failed the merger every
      // time on a fresh sandbox because it doesn't get copyToWorktree's
      // node_modules so the install starts from scratch on a 1.7 GB
      // monorepo and trips workspace catalog errors.
      const result = await sandcastle.run({
        sandbox: docker({ imageName: args.imageName, env: containerEnv, containerUid: 1001, containerGid: 1001, ...buildMounts(spec.mounts) }),
        cwd: args.repoRoot,
        name: spec.name,
        maxIterations: spec.maxIterations ?? 1,
        agent: sandcastle.claudeCode(spec.model),
        promptFile: spec.promptFile,
        promptArgs: spec.promptArgs,
        idleTimeoutSeconds: spec.idleTimeoutSeconds,
        completionSignal,
      });
      return { stdout: result.stdout, commits: result.commits };
    },
    async createSandbox(spec) {
      const handle = await sandcastle.createSandbox({
        branch: spec.branch,
        sandbox: docker({ imageName: args.imageName, env: containerEnv, containerUid: 1001, containerGid: 1001, ...buildMounts(spec.mounts) }),
        cwd: args.repoRoot,
        hooks,
        copyToWorktree,
        // Some target repos have multi-GB node_modules (1.7 GB observed on
        // affinity-tracker). Sandcastle's default copyToWorktree timeout is
        // 60s — enough to silently quarantine real issues. Bump to 10 min.
        timeouts: { copyToWorktreeMs: 600_000 },
      });
      return {
        branch: handle.branch,
        worktreePath: handle.worktreePath,
        run: async (opts) => {
          const r = await handle.run({
            name: opts.name,
            maxIterations: opts.maxIterations ?? 1,
            agent: sandcastle.claudeCode(opts.model),
            promptFile: opts.promptFile,
            promptArgs: opts.promptArgs,
            idleTimeoutSeconds: opts.idleTimeoutSeconds,
            completionSignal,
          });
          return { stdout: r.stdout, commits: r.commits };
        },
        close: () => handle.close(),
      };
    },
    async claim(n) {
      if (args.dryRun) return dryLog("claim", n);
      await claimViaLabel(n);
    },
    async markDone(n, summary) {
      if (args.dryRun) return dryLog("markDone", n, summary);
      await markDoneViaLabel(n, summary);
    },
    async quarantine(n, reason) {
      if (args.dryRun) return dryLog("quarantine", n, reason);
      await quarantineViaLabel(n, reason);
    },
    async comment(n, body) {
      if (args.dryRun) return dryLog("comment", n, body);
      await postIssueComment(n, body);
    },
    async applyMigrations(repoRoot, preSha, postSha) {
      const r = await applyMigrationsBetween(repoRoot, preSha, postSha);
      return {
        applied: r.applied,
        realErrors: r.realErrors.map((e) => ({ msg: e.msg })),
      };
    },
    async captureSha(worktreePath) {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: worktreePath,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return "";
      }
    },
    log(line) {
      process.stderr.write(`${line}\n`);
    },
    logError(line) {
      process.stderr.write(`ERROR: ${line}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Plan parsing
// ---------------------------------------------------------------------------

/**
 * Parse the planner's `<plan>...</plan>` JSON block. Throws with a clear
 * message if the marker is missing or the JSON shape is wrong — the caller
 * surfaces this as a fatal-loop error.
 *
 * Exported for tests and for one-shot mode (which bypasses the planner but
 * still uses the same Issue shape).
 */
export function parsePlan(stdout: string): PlanIssue[] {
  const m = stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!m) {
    throw new Error(
      "Planning agent did not produce a <plan>...</plan> block. " +
        `stdout preview: ${stdout.slice(0, 400)}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(m[1] ?? "");
  } catch (err) {
    throw new Error(
      `Plan JSON.parse failed: ${(err as Error).message}; ` +
        `body: ${(m[1] ?? "").slice(0, 400)}`,
    );
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as { issues?: unknown }).issues)
  ) {
    throw new Error(
      `Plan JSON missing 'issues' array; got: ${JSON.stringify(body).slice(
        0,
        400,
      )}`,
    );
  }
  const issues = (body as { issues: unknown[] }).issues;
  const out: PlanIssue[] = [];
  for (const raw of issues) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`Plan issue entry is not an object: ${JSON.stringify(raw)}`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id.length === 0)
      throw new Error(`Plan issue.id must be a non-empty string`);
    if (typeof r.title !== "string")
      throw new Error(`Plan issue.title must be a string`);
    if (typeof r.branch !== "string" || r.branch.length === 0)
      throw new Error(`Plan issue.branch must be a non-empty string`);
    out.push({ id: r.id, title: r.title, branch: r.branch });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-issue pipeline
// ---------------------------------------------------------------------------

interface IssueOutcome {
  /** "ok" => marked done; "quarantined" => label flipped to needs-human;
   *  "error" => unhandled and not yet quarantined (caller decides). */
  status: "ok" | "quarantined" | "error";
  /** Marker that ended the pipeline ("ALL_CLEAR" / "HALT" / etc), if any. */
  finalMarker?: string;
  /** Most recent commit SHA on the branch, if any. */
  postSha?: string;
}

interface PipelineCtx {
  readonly args: RalphArgs;
  readonly deps: Deps;
  readonly iteration: number;
  readonly issueNumber: number;
  readonly issue: PlanIssue;
}

async function runImplementer(
  sb: SandboxHandle,
  ctx: PipelineCtx,
): Promise<{ commits: readonly { sha: string }[]; stdout: string }> {
  const r = await sb.run({
    name: "implementer",
    maxIterations: 100,
    model: ctx.args.implementerModel,
    promptFile: "./.sandcastle/implement-prompt.md",
    idleTimeoutSeconds: ctx.args.implementerTimeoutSec,
    promptArgs: {
      ITERATION: String(ctx.iteration),
      ISSUE_NUMBER: String(ctx.issueNumber),
      STORY_TITLE: ctx.issue.title,
      BRANCH: ctx.issue.branch,
    },
  });
  if (r.commits.length === 0) {
    throw new Error("implementer made no commits");
  }
  // Sandcastle's r.stdout is the parsed `result.result` from claude's final
  // stream event — already-extracted assistant text, NOT raw stream-json
  // envelopes. The old src/loop/agents.ts and src/planner/planner.ts both
  // handle this with a dual-mode try (stream-json first, then fall back to
  // `alreadyAssistantText: true`). Without the fallback every implementer
  // run throws "no assistant text could be extracted" and triggers recovery,
  // doubling the per-issue Opus spend. Mirror the established pattern.
  try {
    parseVerdict(r.stdout, ImplementerOutputSchema);
  } catch {
    parseVerdict(r.stdout, ImplementerOutputSchema, {
      alreadyAssistantText: true,
    });
  }
  return r;
}

async function runReviewer(
  sb: SandboxHandle,
  ctx: PipelineCtx,
  commitSha: string,
  promptFile = "./.sandcastle/review-prompt.md",
  model?: string,
): Promise<{ marker: string; stdout: string }> {
  const r = await sb.run({
    name: "reviewer",
    maxIterations: 1,
    model: model ?? ctx.args.reviewerModel,
    promptFile,
    idleTimeoutSeconds: ctx.args.reviewerTimeoutSec,
    promptArgs: {
      ITERATION: String(ctx.iteration),
      ISSUE_NUMBER: String(ctx.issueNumber),
      COMMIT_SHA: commitSha,
      BRANCH: ctx.issue.branch,
    },
  });
  const marker = extractMarker(r.stdout, ["ALL_CLEAR", "HAS_BLOCKERS"] as const);
  return { marker, stdout: r.stdout };
}

/**
 * Run a single recovery pass against the existing sandbox using the
 * recovery model and `./.sandcastle/recovery-prompt.md`. Returns the
 * marker the agent emitted, or `"ERRORED"` if the run threw.
 *
 * Single pass — no Haiku→Sonnet→Opus escalation ladder. The recovery model
 * defaults to Opus (the strongest available) so this rescue step has the
 * best chance of finalizing the issue without escalating through cheaper
 * tiers first. The implementer stays on a cheaper model (Sonnet by default)
 * so the bulk of the loop's spend is bounded.
 */
async function runRecovery(
  sb: SandboxHandle,
  ctx: PipelineCtx,
  reason: string,
): Promise<{ marker: "RECOVERY_COMPLETE" | "HALT" | "ERRORED" }> {
  try {
    const r = await sb.run({
      name: "recovery",
      maxIterations: 1,
      model: ctx.args.recoveryModel,
      promptFile: "./.sandcastle/recovery-prompt.md",
      idleTimeoutSeconds: ctx.args.implementerTimeoutSec,
      promptArgs: {
        ITERATION: String(ctx.iteration),
        ISSUE_NUMBER: String(ctx.issueNumber),
        BRANCH: ctx.issue.branch,
        REASON: reason.slice(0, 500),
      },
    });
    const marker = extractMarker(r.stdout, ["RECOVERY_COMPLETE", "HALT"] as const);
    return { marker };
  } catch (err) {
    ctx.deps.logError(
      `[issue=${ctx.issueNumber}] recovery threw: ${(err as Error).message}`,
    );
    return { marker: "ERRORED" };
  }
}

/**
 * Drive a single issue through the full implement → migrate → review →
 * markDone pipeline. Caller wraps this in `claim` and is responsible for
 * converting our return value into ship/quarantine/error counters.
 *
 * On error, quarantine. Set `--recovery on` to retry once with the
 * implementer model before quarantining.
 */
async function runIssuePipeline(
  ctx: PipelineCtx,
): Promise<IssueOutcome> {
  let sandbox: SandboxHandle | undefined;
  let preSha = "";
  try {
    sandbox = await ctx.deps.createSandbox({ branch: ctx.issue.branch });
    preSha = sandbox.worktreePath
      ? await ctx.deps.captureSha(sandbox.worktreePath)
      : "";

    // Phase 2a: implementer
    const impl = await runImplementer(sandbox, ctx);
    const postSha = sandbox.worktreePath
      ? await ctx.deps.captureSha(sandbox.worktreePath)
      : impl.commits[impl.commits.length - 1]?.sha ?? "";

    // Phase 2b: migrations between preSha & postSha (no-op if no SQL files)
    if (preSha !== "" && postSha !== "" && preSha !== postSha) {
      try {
        const mres = await ctx.deps.applyMigrations(
          ctx.args.repoRoot,
          preSha,
          postSha,
        );
        if (mres.realErrors.length > 0) {
          throw new Error(
            `migrations failed: ${mres.realErrors
              .map((e) => e.msg)
              .join("; ")
              .slice(0, 500)}`,
          );
        }
        if (mres.applied > 0) {
          ctx.deps.log(
            `[issue=${ctx.issueNumber}] applied ${mres.applied} migration statement(s)`,
          );
        }
      } catch (err) {
        // Re-throw — recovery ladder + quarantine will handle.
        throw err;
      }
    }

    // Phase 2c: reviewer (single pass, no ladder)
    const review = await runReviewer(sandbox, ctx, postSha);

    if (review.marker === "ALL_CLEAR") {
      const summary = `[issue=${ctx.issueNumber}] shipped via sandcastle-loop (commit ${postSha}, branch ${ctx.issue.branch})`;
      await ctx.deps.markDone(ctx.issueNumber, summary);
      return {
        status: "ok",
        finalMarker: "ALL_CLEAR",
        postSha,
      };
    }

    // Reviewer marked HAS_BLOCKERS — quarantine for human triage.
    const reason =
      `[issue=${ctx.issueNumber}] reviewer marked ${review.marker} — ` +
      `quarantining for human triage.`;
    await ctx.deps.quarantine(ctx.issueNumber, reason);
    return {
      status: "quarantined",
      finalMarker: review.marker,
      postSha,
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    ctx.deps.logError(
      `[issue=${ctx.issueNumber}] pipeline error: ${errMsg}`,
    );

    // Opt-in single recovery pass with the implementer model. If recovery
    // succeeds, mark done; otherwise fall through to quarantine.
    if (ctx.args.recoveryEnabled && sandbox) {
      ctx.deps.log(
        `[issue=${ctx.issueNumber}] --recovery on — attempting one recovery pass`,
      );
      const rec = await runRecovery(sandbox, ctx, errMsg);
      if (rec.marker === "RECOVERY_COMPLETE") {
        const postSha = sandbox.worktreePath
          ? await ctx.deps.captureSha(sandbox.worktreePath)
          : "";
        const summary =
          `[issue=${ctx.issueNumber}] shipped via sandcastle-loop recovery ` +
          `(commit ${postSha}, branch ${ctx.issue.branch})`;
        try {
          await ctx.deps.markDone(ctx.issueNumber, summary);
          return {
            status: "ok",
            finalMarker: "RECOVERY_COMPLETE",
            postSha,
          };
        } catch (e) {
          ctx.deps.logError(
            `markDone after recovery failed: ${(e as Error).message}`,
          );
          // Fall through to quarantine.
        }
      }
    }

    const reason = `[issue=${ctx.issueNumber}] pipeline halted: ${errMsg.slice(0, 400)}`;
    try {
      await ctx.deps.quarantine(ctx.issueNumber, reason);
      return { status: "quarantined", finalMarker: "HALT" };
    } catch (e) {
      ctx.deps.logError(`quarantine failed: ${(e as Error).message}`);
      return { status: "error", finalMarker: "HALT" };
    }
  } finally {
    if (sandbox) {
      try {
        await sandbox.close();
      } catch (err) {
        ctx.deps.logError(
          `sandbox.close() threw: ${(err as Error).message}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Outer loop
// ---------------------------------------------------------------------------

/**
 * Drive the orchestrator. Returns a structured result instead of calling
 * `process.exit` so tests can assert.
 *
 * Production CLI entry calls this then exits with the result's `exitCode`.
 */
export async function runMain(
  args: RalphArgs,
  deps: Deps,
): Promise<RunMainResult> {
  let consecutiveFailures = 0;
  let lastFailingIssue: number | undefined;
  const shippedIssues: number[] = [];
  const quarantinedIssues: number[] = [];
  let iterationsRun = 0;

  // Graceful shutdown: register once. We don't abort in-flight gh calls;
  // we set a flag the outer loop checks at iteration boundaries.
  let shuttingDown = false;
  const onSignal = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log(
      `received ${sig} — finishing in-flight ops then exiting cleanly`,
    );
  };
  const sigintHandler = (): void => onSignal("SIGINT");
  const sigtermHandler = (): void => onSignal("SIGTERM");
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  try {
    for (let it = 1; it <= args.iterations; it++) {
      if (shuttingDown) break;
      deps.log(`\n=== sandcastle-loop iteration ${it}/${args.iterations} ===`);
      iterationsRun = it;

      // Phase 1: planner (or one-shot bypass)
      let plan: PlanIssue[];
      if (args.issue !== undefined) {
        plan = [
          {
            id: String(args.issue),
            title: `issue #${args.issue}`,
            branch: `agent/issue-${args.issue}`,
          },
        ];
      } else {
        let plannerStdout: string;
        try {
          const planResult = await deps.run({
            name: "planner",
            maxIterations: 1,
            model: args.plannerModel,
            promptFile: "./.sandcastle/plan-prompt.md",
            idleTimeoutSeconds: args.implementerTimeoutSec,
            promptArgs: {
              ITERATION: String(it),
              LABEL: args.label,
              MAX_CONCURRENT: String(args.maxConcurrent),
            },
          });
          plannerStdout = planResult.stdout;
        } catch (err) {
          deps.logError(`planner failed: ${(err as Error).message}`);
          return {
            exitCode: 1,
            iterationsRun,
            shippedIssues,
            quarantinedIssues,
          };
        }
        try {
          plan = parsePlan(plannerStdout);
        } catch (err) {
          deps.logError(`plan parse failed: ${(err as Error).message}`);
          return {
            exitCode: 1,
            iterationsRun,
            shippedIssues,
            quarantinedIssues,
          };
        }
      }

      if (plan.length === 0) {
        deps.log("no claimable issues — exiting cleanly");
        return {
          exitCode: 0,
          iterationsRun,
          shippedIssues,
          quarantinedIssues,
        };
      }
      deps.log(`plan: ${plan.length} issue(s) to work in parallel`);
      for (const p of plan) {
        deps.log(`  ${p.id}: ${p.title} → ${p.branch}`);
      }

      // Phase 2: parallel execute (semaphore)
      const limit = makeLimiter(args.maxConcurrent);
      const completed: { issue: PlanIssue; outcome: IssueOutcome }[] = [];
      const settled = await Promise.allSettled(
        plan.map((p) =>
          limit(async () => {
            const issueNumber = Number(p.id);
            if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
              throw new Error(
                `plan issue id is not a positive integer: ${JSON.stringify(p.id)}`,
              );
            }
            // Claim first — this is the only place ready-for-agent →
            // in-progress flips. If claim fails we abort the pipeline.
            await deps.claim(issueNumber);
            const ctx: PipelineCtx = {
              args,
              deps,
              iteration: it,
              issueNumber,
              issue: p,
            };
            const outcome = await runIssuePipeline(ctx);
            return { issue: p, issueNumber, outcome };
          }),
        ),
      );

      // Account each pipeline's outcome.
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i]!;
        const planIssue = plan[i]!;
        if (s.status === "fulfilled") {
          completed.push({ issue: s.value.issue, outcome: s.value.outcome });
          if (s.value.outcome.status === "ok") {
            shippedIssues.push(s.value.issueNumber);
            consecutiveFailures = 0;
          } else if (s.value.outcome.status === "quarantined") {
            quarantinedIssues.push(s.value.issueNumber);
            consecutiveFailures += 1;
            lastFailingIssue = s.value.issueNumber;
          } else {
            // "error" — couldn't even quarantine.
            consecutiveFailures += 1;
            lastFailingIssue = s.value.issueNumber;
          }
        } else {
          // claim or pre-pipeline error.
          const issueNumber = Number(planIssue.id);
          deps.logError(
            `[issue=${planIssue.id}] outer pipeline rejected: ${
              s.reason instanceof Error ? s.reason.message : String(s.reason)
            }`,
          );
          consecutiveFailures += 1;
          if (Number.isInteger(issueNumber)) lastFailingIssue = issueNumber;
        }
      }

      // Circuit breaker.
      if (consecutiveFailures >= args.consecutiveFailureLimit) {
        deps.logError(
          `Circuit breaker tripped: ${consecutiveFailures} consecutive failure(s) ≥ limit ${args.consecutiveFailureLimit}`,
        );
        if (lastFailingIssue !== undefined) {
          try {
            await deps.comment(
              lastFailingIssue,
              `sandcastle-loop circuit breaker tripped after ${consecutiveFailures} consecutive failures. ` +
                `Stopping the loop. Investigate before re-queuing this or other issues.`,
            );
          } catch (err) {
            deps.logError(
              `comment-on-breaker-trip failed: ${(err as Error).message}`,
            );
          }
        }
        return {
          exitCode: 1,
          iterationsRun,
          shippedIssues,
          quarantinedIssues,
        };
      }

      // Phase 3: merge — only if at least one branch shipped.
      const mergedBranches = completed
        .filter((c) => c.outcome.status === "ok")
        .map((c) => c.issue);
      if (mergedBranches.length === 0) {
        deps.log("no shipped branches this cycle — skipping merge phase");
        continue;
      }
      try {
        await deps.run({
          name: "merger",
          maxIterations: 1,
          model: args.mergerModel,
          promptFile: "./.sandcastle/merge-prompt.md",
          idleTimeoutSeconds: args.implementerTimeoutSec,
          promptArgs: {
            ITERATION: String(it),
            BRANCHES: mergedBranches.map((b) => `- ${b.branch}`).join("\n"),
            ISSUES: mergedBranches
              .map((i) => `- #${i.id}: ${i.title}`)
              .join("\n"),
          },
        });
      } catch (err) {
        deps.logError(
          `merge phase threw: ${(err as Error).message} — continuing to next iteration`,
        );
      }

      // Phase 4: post-merge review (Opus). Best-effort visibility check
      // over the merged result on the integration branch. Failures are
      // logged only — they do NOT break the iteration.
      let postMergeMarker = "";
      try {
        const r = await deps.run({
          name: "post-merge-reviewer",
          maxIterations: 1,
          model: args.postMergeReviewerModel,
          promptFile: "./.sandcastle/post-merge-review-prompt.md",
          idleTimeoutSeconds: args.reviewerTimeoutSec,
          promptArgs: {
            ITERATION: String(it),
            MERGE_DEPTH: String(mergedBranches.length),
            INTEGRATION_BRANCH: args.branch,
            BRANCHES: mergedBranches.map((b) => `- ${b.branch}`).join("\n"),
            ISSUES: mergedBranches
              .map((i) => `- #${i.id}: ${i.title}`)
              .join("\n"),
          },
        });
        postMergeMarker = extractMarker(r.stdout, [
          "POST_MERGE_ALL_CLEAR",
          "POST_MERGE_ISSUES_FOUND",
        ] as const);
        deps.log(
          `post-merge review: ${postMergeMarker || "(no marker emitted)"}`,
        );
      } catch (err) {
        deps.logError(
          `post-merge review threw: ${(err as Error).message} — continuing to next iteration`,
        );
      }

      // Phase 5: cleanup stale per-issue sub-worktrees, gated on the
      // post-merge reviewer's verdict. ALL_CLEAR means the merge is
      // certified — the per-issue scaffolding has done its job and can be
      // safely garbage-collected. ISSUES_FOUND, no marker, or any error
      // above → leave the worktrees in place for human inspection.
      if (postMergeMarker === "POST_MERGE_ALL_CLEAR") {
        for (const issue of mergedBranches) {
          const wtName = issue.branch.replace(/\//g, "-");
          const wtPath = `.sandcastle/worktrees/${wtName}`;
          try {
            execFileSync("git", ["worktree", "remove", "--force", wtPath], {
              cwd: args.repoRoot,
              stdio: ["ignore", "pipe", "pipe"],
            });
            deps.log(`cleaned up worktree ${wtPath}`);
          } catch (err) {
            deps.logError(
              `worktree cleanup failed for ${wtPath}: ${(err as Error).message}`,
            );
          }
        }
      }
    }

    // Out of iterations.
    deps.log(
      `out of iterations (${args.iterations}) — exiting with code 2 (clean — just out of cycles)`,
    );
    return {
      exitCode: 2,
      iterationsRun,
      shippedIssues,
      quarantinedIssues,
    };
  } finally {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/** Detect whether this file is being run directly as a script. */
function isMain(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  // Resolve via URL to handle symlinks / .mts paths consistently.
  try {
    const argv1 = path.resolve(process.argv[1]);
    const here = path.resolve(new URL(import.meta.url).pathname);
    return argv1 === here;
  } catch {
    return false;
  }
}

if (isMain()) {
  void (async (): Promise<void> => {
    let parsed: { args: RalphArgs; showHelp: boolean };
    try {
      parsed = parseRalphArgs(process.argv.slice(2));
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n\n${HELP_TEXT}`);
      process.exit(2);
    }
    if (parsed.showHelp) {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    const { args } = parsed;

    const pre = preflight(args);
    if (!pre.ok) {
      process.stderr.write(`pre-flight checks failed:\n`);
      for (const e of pre.errors) process.stderr.write(`  - ${e}\n`);
      process.exit(2);
    }

    const deps = buildDefaultDeps(args);
    try {
      const result = await runMain(args, deps);
      process.exit(result.exitCode);
    } catch (err) {
      process.stderr.write(
        `fatal: ${(err as Error).stack ?? (err as Error).message}\n`,
      );
      process.exit(1);
    }
  })();
}
