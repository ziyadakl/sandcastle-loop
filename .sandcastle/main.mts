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
 *   - Fixer ladder (sonnet → re-review → opus → final review).
 *   - Recovery ladder (sonnet → opus) with quarantine fallback.
 *   - Bash-style circuit breaker (3 consecutive failures = trip).
 *
 * The driver is structured so it can be invoked as a CLI (parses argv and
 * runs to completion) OR imported and driven from a test (`runMain` accepts
 * an injected `Deps` bag that replaces sandcastle / gh calls with stubs).
 */

import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import {
  claimViaLabel,
  quarantineViaLabel,
  markDoneViaLabel,
  postIssueComment,
  LABEL_READY,
} from "../src/state/index.js";
import { parseVerdict, extractMarker } from "../src/verdicts/index.js";
import { ImplementerOutputSchema } from "../src/verdicts/index.js";
import { applyMigrationsBetween } from "../src/migrations/index.js";

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
  implementerModel: string;
  reviewerModel: string;
  fixerModel: string;
  recoveryModel: string;
  recoveryEscalatedModel: string;
  implementerTimeoutSec: number;
  reviewerTimeoutSec: number;
  fixerTimeoutSec: number;
  recoveryTimeoutSec: number;
  consecutiveFailureLimit: number;
  logFile?: string;
  dryRun: boolean;
  /**
   * Docker image to run the sandbox in. Defaults to `sandcastle:loop`.
   * sandcastle's `docker()` factory would otherwise auto-derive the image
   * name from the worktree directory name (e.g. `sandcastle:aft-sl-it1`),
   * which doesn't match the image we built via
   * `sandcastle docker build-image --image-name sandcastle:loop`.
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
  --implementer-model M     Default: claude-sonnet-4-6.
  --reviewer-model M        Default: claude-haiku-4-5.
  --fixer-model M           Default: claude-sonnet-4-6.
  --recovery-model M        Default: claude-sonnet-4-6.
  --recovery-escalated-model M
                            Default: claude-opus-4-7.
  --implementer-timeout-sec N   Default: 1200.
  --reviewer-timeout-sec N      Default: 600.
  --fixer-timeout-sec N         Default: 900.
  --recovery-timeout-sec N      Default: 1800.
  --consecutive-failure-limit N Default: 3.
  --log-file PATH           Tee output to this file.
  --dry-run                 Skip claim/quarantine/markDone side effects.
  --image-name NAME         Docker image to run sandboxes in.
                            Default: sandcastle:loop.
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
      "implementer-model": { type: "string" },
      "reviewer-model": { type: "string" },
      "fixer-model": { type: "string" },
      "recovery-model": { type: "string" },
      "recovery-escalated-model": { type: "string" },
      "implementer-timeout-sec": { type: "string" },
      "reviewer-timeout-sec": { type: "string" },
      "fixer-timeout-sec": { type: "string" },
      "recovery-timeout-sec": { type: "string" },
      "consecutive-failure-limit": { type: "string" },
      "log-file": { type: "string" },
      "dry-run": { type: "boolean" },
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
    implementerModel: values["implementer-model"] ?? "claude-sonnet-4-6",
    reviewerModel: values["reviewer-model"] ?? "claude-haiku-4-5",
    fixerModel: values["fixer-model"] ?? "claude-sonnet-4-6",
    recoveryModel: values["recovery-model"] ?? "claude-sonnet-4-6",
    recoveryEscalatedModel:
      values["recovery-escalated-model"] ?? "claude-opus-4-7",
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
    fixerTimeoutSec:
      parsePositiveInt(values["fixer-timeout-sec"], "--fixer-timeout-sec") ??
      900,
    recoveryTimeoutSec:
      parsePositiveInt(
        values["recovery-timeout-sec"],
        "--recovery-timeout-sec",
      ) ?? 1800,
    consecutiveFailureLimit:
      parsePositiveInt(
        values["consecutive-failure-limit"],
        "--consecutive-failure-limit",
      ) ?? 3,
    logFile: values["log-file"],
    dryRun: values["dry-run"] === true,
    imageName: values["image-name"] ?? "sandcastle:loop",
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
    implementerModel: "claude-sonnet-4-6",
    reviewerModel: "claude-haiku-4-5",
    fixerModel: "claude-sonnet-4-6",
    recoveryModel: "claude-sonnet-4-6",
    recoveryEscalatedModel: "claude-opus-4-7",
    implementerTimeoutSec: 1200,
    reviewerTimeoutSec: 600,
    fixerTimeoutSec: 900,
    recoveryTimeoutSec: 1800,
    consecutiveFailureLimit: 3,
    dryRun: false,
    imageName: "sandcastle:loop",
  };
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

const REQUIRED_PROMPT_FILES = [
  "plan-prompt.md",
  "implement-prompt.md",
  "review-prompt.md",
  "fix-prompt.md",
  "final-review-prompt.md",
  "recovery-prompt.md",
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
  const hooks = {
    sandbox: { onSandboxReady: [{ command: "pnpm install" }] },
  } as const;
  const copyToWorktree = ["node_modules"];

  // Auth mounts — sandcastle's docker provider does NOT auto-mount these.
  // Without them, `claude` and `gh` inside the container can't see the host's
  // session and fail with "Not logged in" / "no auth" errors. `git config`
  // user.name/user.email also live in ~/.gitconfig on the host; without it,
  // the agent's `git commit` would fail with "Please tell me who you are".
  const authMounts = [
    { hostPath: "~/.claude", sandboxPath: "/home/agent/.claude" },
    { hostPath: "~/.config/gh", sandboxPath: "/home/agent/.config/gh" },
    // Read-write — sandcastle runs `git config --global --add safe.directory`
    // early in container boot, which fails if the mount is readonly. The
    // agent's writes to ~/.gitconfig do reach the host, but in practice the
    // only writes are sandcastle's own safe.directory entries which are
    // harmless to accumulate on the host.
    { hostPath: "~/.gitconfig", sandboxPath: "/home/agent/.gitconfig" },
  ] as const;
  const buildMounts = (extra?: readonly { hostPath: string; sandboxPath: string; readonly?: boolean }[]) => {
    return extra && extra.length > 0
      ? { mounts: [...authMounts, ...extra] }
      : { mounts: [...authMounts] };
  };

  const dryLog = (action: string, ...rest: unknown[]): void => {
    process.stderr.write(
      `[dry-run] ${action} ${rest.map((r) => JSON.stringify(r)).join(" ")}\n`,
    );
  };

  return {
    async run(spec) {
      const result = await sandcastle.run({
        hooks,
        sandbox: docker({ imageName: args.imageName, ...buildMounts(spec.mounts) }),
        cwd: args.repoRoot,
        name: spec.name,
        maxIterations: spec.maxIterations ?? 1,
        agent: sandcastle.claudeCode(spec.model),
        promptFile: spec.promptFile,
        promptArgs: spec.promptArgs,
        idleTimeoutSeconds: spec.idleTimeoutSeconds,
      });
      return { stdout: result.stdout, commits: result.commits };
    },
    async createSandbox(spec) {
      const handle = await sandcastle.createSandbox({
        branch: spec.branch,
        sandbox: docker({ imageName: args.imageName, ...buildMounts(spec.mounts) }),
        cwd: args.repoRoot,
        hooks,
        copyToWorktree,
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
  // Wave 1 enforcement: STORY_COMPLETE requires a valid envelope.
  // parseVerdict throws on bad JSON, missing marker, or schema mismatch.
  parseVerdict(r.stdout, ImplementerOutputSchema);
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

async function runFixer(
  sb: SandboxHandle,
  ctx: PipelineCtx,
  model: string,
): Promise<{ stdout: string; commits: readonly { sha: string }[] }> {
  const r = await sb.run({
    name: "fixer",
    maxIterations: 50,
    model,
    promptFile: "./.sandcastle/fix-prompt.md",
    idleTimeoutSeconds: ctx.args.fixerTimeoutSec,
    promptArgs: {
      ITERATION: String(ctx.iteration),
      ISSUE_NUMBER: String(ctx.issueNumber),
      BRANCH: ctx.issue.branch,
    },
  });
  return r;
}

/**
 * Run the reviewer/fixer loop after a successful implementer run.
 *
 * Ladder (matches bash parity):
 *   review (haiku) → ALL_CLEAR ⇒ done
 *                  → HAS_BLOCKERS ⇒ fixer (sonnet) → re-review (haiku)
 *                                  → ALL_CLEAR ⇒ done
 *                                  → HAS_BLOCKERS ⇒ fixer (opus, via fix-prompt)
 *                                                  → final-review (haiku)
 *                                                    → ALL_CLEAR ⇒ done
 *                                                    → HAS_BLOCKERS ⇒ final-review (opus) → final
 */
async function runReviewerLadder(
  sb: SandboxHandle,
  ctx: PipelineCtx,
  initialCommitSha: string,
): Promise<{ marker: string; finalCommitSha: string }> {
  // Pass 1: review
  let commitSha = initialCommitSha;
  let r1 = await runReviewer(sb, ctx, commitSha);
  if (r1.marker === "ALL_CLEAR") return { marker: "ALL_CLEAR", finalCommitSha: commitSha };

  // Pass 2: fixer (sonnet) → re-review (haiku)
  ctx.deps.log(
    `[issue=${ctx.issueNumber}] reviewer HAS_BLOCKERS — invoking fixer (sonnet)`,
  );
  const f1 = await runFixer(sb, ctx, ctx.args.fixerModel);
  if (f1.commits.length > 0) commitSha = f1.commits[f1.commits.length - 1]!.sha;
  let r2 = await runReviewer(sb, ctx, commitSha);
  if (r2.marker === "ALL_CLEAR") return { marker: "ALL_CLEAR", finalCommitSha: commitSha };

  // Pass 3: fixer (opus) → final-review (haiku)
  ctx.deps.log(
    `[issue=${ctx.issueNumber}] reviewer still HAS_BLOCKERS — escalating to fixer (opus)`,
  );
  const f2 = await runFixer(sb, ctx, ctx.args.recoveryEscalatedModel);
  if (f2.commits.length > 0) commitSha = f2.commits[f2.commits.length - 1]!.sha;
  let r3 = await runReviewer(
    sb,
    ctx,
    commitSha,
    "./.sandcastle/final-review-prompt.md",
  );
  if (r3.marker === "ALL_CLEAR") return { marker: "ALL_CLEAR", finalCommitSha: commitSha };

  // Pass 4: final-review (opus)
  ctx.deps.log(
    `[issue=${ctx.issueNumber}] final-review still HAS_BLOCKERS — escalating final review to opus`,
  );
  const r4 = await runReviewer(
    sb,
    ctx,
    commitSha,
    "./.sandcastle/final-review-prompt.md",
    ctx.args.recoveryEscalatedModel,
  );
  return { marker: r4.marker, finalCommitSha: commitSha };
}

/**
 * Recovery ladder: invoked from the catch-block when any sandbox.run() in the
 * pipeline throws. Tries sonnet first; if that emits HALT (or throws), tries
 * opus. Returns whichever marker the ladder ends on, or "HALT" if both fail.
 *
 * Recovery uses top-level `sandcastle.run` (NOT the issue's sandbox) because
 * the sandbox may already be torn down or mid-failure when we get here.
 */
async function runRecovery(
  ctx: PipelineCtx,
  reason: string,
): Promise<{ marker: string }> {
  const tryModel = async (model: string): Promise<string | null> => {
    try {
      const r = await ctx.deps.run({
        name: "recovery",
        maxIterations: 1,
        model,
        promptFile: "./.sandcastle/recovery-prompt.md",
        idleTimeoutSeconds: ctx.args.recoveryTimeoutSec,
        promptArgs: {
          REASON: reason,
          ITERATION: String(ctx.iteration),
          ISSUE_NUMBER: String(ctx.issueNumber),
          BRANCH: ctx.issue.branch,
        },
      });
      return extractMarker(r.stdout, ["RECOVERY_COMPLETE", "HALT"] as const);
    } catch (err) {
      ctx.deps.logError(
        `recovery (${model}) threw: ${(err as Error).message}`,
      );
      return null;
    }
  };

  const m1 = await tryModel(ctx.args.recoveryModel);
  if (m1 === "RECOVERY_COMPLETE") return { marker: "RECOVERY_COMPLETE" };

  ctx.deps.log(
    `[issue=${ctx.issueNumber}] recovery (sonnet) ${m1 ?? "threw"} — escalating to opus`,
  );
  const m2 = await tryModel(ctx.args.recoveryEscalatedModel);
  if (m2 === "RECOVERY_COMPLETE") return { marker: "RECOVERY_COMPLETE" };

  return { marker: "HALT" };
}

/**
 * Drive a single issue through the full implement → migrate → review →
 * fix-as-needed → markDone pipeline. Caller wraps this in `claim` and is
 * responsible for converting our return value into ship/quarantine/error
 * counters.
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

    // Phase 2c: reviewer ladder
    const ladder = await runReviewerLadder(sandbox, ctx, postSha);

    if (ladder.marker === "ALL_CLEAR") {
      const summary = `[issue=${ctx.issueNumber}] shipped via sandcastle-loop (commit ${ladder.finalCommitSha}, branch ${ctx.issue.branch})`;
      await ctx.deps.markDone(ctx.issueNumber, summary);
      return {
        status: "ok",
        finalMarker: "ALL_CLEAR",
        postSha: ladder.finalCommitSha,
      };
    }

    // Reviewer ladder ended on HAS_BLOCKERS even after final opus pass —
    // quarantine.
    const reason =
      `[issue=${ctx.issueNumber}] reviewer ladder ended on ${ladder.marker} ` +
      `after the final opus pass — quarantining for human triage.`;
    await ctx.deps.quarantine(ctx.issueNumber, reason);
    return {
      status: "quarantined",
      finalMarker: ladder.marker,
      postSha: ladder.finalCommitSha,
    };
  } catch (err) {
    const errMsg = (err as Error).message;
    ctx.deps.logError(
      `[issue=${ctx.issueNumber}] pipeline error: ${errMsg}`,
    );
    // Recovery ladder.
    let recoveryMarker = "HALT";
    try {
      const rec = await runRecovery(ctx, errMsg);
      recoveryMarker = rec.marker;
    } catch (innerErr) {
      ctx.deps.logError(
        `[issue=${ctx.issueNumber}] recovery ladder itself threw: ${(innerErr as Error).message}`,
      );
    }
    if (recoveryMarker === "RECOVERY_COMPLETE") {
      // Recovery says it patched the issue. Treat as success — the actual
      // commit landed inside recovery's own run.
      const summary = `[issue=${ctx.issueNumber}] recovered and shipped via sandcastle-loop (branch ${ctx.issue.branch})`;
      try {
        await ctx.deps.markDone(ctx.issueNumber, summary);
        return { status: "ok", finalMarker: "RECOVERY_COMPLETE" };
      } catch (e) {
        ctx.deps.logError(
          `markDone after recovery failed: ${(e as Error).message}`,
        );
        return { status: "error", finalMarker: "RECOVERY_COMPLETE" };
      }
    }
    // HALT or unhandled — quarantine.
    const reason = `[issue=${ctx.issueNumber}] pipeline halted: ${errMsg.slice(0, 400)}`;
    try {
      await ctx.deps.quarantine(ctx.issueNumber, reason);
      return { status: "quarantined", finalMarker: recoveryMarker };
    } catch (e) {
      ctx.deps.logError(`quarantine failed: ${(e as Error).message}`);
      return { status: "error", finalMarker: recoveryMarker };
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
            model: "claude-opus-4-7",
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
          model: "claude-sonnet-4-6",
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
