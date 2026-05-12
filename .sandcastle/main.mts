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
import * as os from "node:os";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker, defaultImageName } from "@ai-hero/sandcastle/sandboxes/docker";

import {
  claimViaLabel,
  quarantineViaLabel,
  releaseViaLabel,
  markDoneViaLabel,
  markMergedToStagingViaLabel,
  promoteAllStagingToDone,
  postIssueComment,
  LABEL_READY,
} from "./lib/state/index.js";
import { parseVerdict, extractMarker } from "./lib/verdicts/index.js";
import { ImplementerOutputSchema } from "./lib/verdicts/index.js";
import {
  applyMigrationsBetween,
  listMigrationsOnDisk,
} from "./lib/migrations/index.js";
import { models } from "./models.js";
import {
  envForModel,
  defaultCodingModelFor,
  isProviderName,
  type ProviderName,
} from "./providers.js";

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
   * Bounded retry ladder for the per-issue pipeline. When true (default), a
   * HAS_BLOCKERS verdict on the first reviewer pass triggers a second
   * implementer pass on `models.implementer.escalations[0]` (with the
   * reviewer's feedback in-prompt) followed by a second reviewer pass on
   * `models.reviewer.escalations[0]`. ALL_CLEAR at any point ships
   * immediately. Set to false (via `--no-retry`) to fall back to the legacy
   * one-shot behavior (HAS_BLOCKERS → quarantine immediately).
   */
  retryEnabled: boolean;
  /**
   * Route every merge through a persistent `integration-candidate` staging
   * branch and gate the fast-forward of `--branch` on a post-merge reviewer
   * pass (with a fixer escalation in between). Default: true.
   *
   * When false (`--no-staging`), the loop falls back to today's behavior:
   * the merger merges directly into `--branch`, the post-merge reviewer
   * runs but only logs warnings, no fix-loop runs, and per-issue labels go
   * straight `in-progress` → `done` on a successful merger pass.
   */
  stagingEnabled: boolean;
  /**
   * Implementer-side provider override. When set (via `--provider kimi|glm`),
   * the implementer model is replaced with that provider's default coding
   * model (`kimi-for-coding` for kimi, `glm-4.6` for glm) for both the
   * initial pass and the escalation slot. All other roles (planner, reviewer,
   * merger, post-merge-reviewer, post-merge-fixer, recovery) stay on whatever
   * `.sandcastle/models.ts` defines — typically Anthropic on subscription.
   *
   * Undefined means "no override — use models.ts as-is" (Anthropic everywhere
   * by default).
   */
  provider?: ProviderName;
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
  /**
   * Implementer model that will run inside this sandbox. Used to compute the
   * provider env (kimi/glm/anthropic) and bake it into the container at
   * startup via sandcastle's `sandbox.env`. Required because the SDK
   * (@ai-hero/sandcastle) drops per-call agent env on persistent sandboxes
   * — `createSandbox.js` hardcodes `agentProviderEnv: {}`, so the env we
   * pass through `claudeCode(model, { env })` never reaches the container
   * for `handle.run`. Only `sandbox.env` survives, and that's set at
   * sandbox-creation time. Implication: every call inside this sandbox
   * routes to the implementer's provider — if a reviewer escalation flips
   * to a different provider, that call mis-routes. With current model
   * defaults (implementer + reviewer both kimi-for-coding, escalations
   * both Anthropic), the bounded impact is: failed-Kimi pipelines escalate
   * inside the same sandbox and re-fail. Acceptable for now; revisit when
   * the SDK is patched upstream.
   */
  readonly implementerModel: string;
}

export interface Deps {
  /** Top-level `sandcastle.run({...})` wrapper. */
  run(spec: TopLevelRunSpec): Promise<RunHandle>;
  /** `sandcastle.createSandbox({...})` wrapper. */
  createSandbox(spec: CreateSandboxSpec): Promise<SandboxHandle>;
  /** Label state machine. */
  claim(issueNum: number): Promise<void>;
  markDone(issueNum: number, summary: string): Promise<void>;
  /**
   * Flip an issue's label to `merged-to-staging` after its branch lands on
   * `integration-candidate`. The issue stays open until staging certifies
   * and `promoteStagingToDone` fast-forwards integration.
   */
  markMergedToStaging(issueNum: number): Promise<void>;
  /**
   * Promote every still-`merged-to-staging` issue in `issueNums` to `done`
   * with the shared `summary` comment, after staging fast-forwards into the
   * integration branch.
   */
  promoteStagingToDone(
    issueNums: readonly number[],
    summary: string,
  ): Promise<{ failed: readonly number[] }>;
  quarantine(issueNum: number, reason: string): Promise<void>;
  /**
   * Release an in-progress issue back to `ready-for-agent` so the next loop
   * iteration re-claims it. Used for transient rate-limit deferrals.
   */
  release(issueNum: number, reason: string): Promise<void>;
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
  --no-retry                Disable the per-issue retry ladder. Default: on
                            (a HAS_BLOCKERS verdict triggers one escalated
                            implementer + reviewer attempt before quarantine,
                            using the role's escalations[0] model).
  --no-staging              Disable the integration-candidate staging branch
                            and post-merge fix-loop. With this flag the merger
                            writes directly to --branch and the post-merge
                            reviewer is advisory-only (no fixer pass, no
                            fast-forward gating). Default: staging ON.
  --provider NAME           Override the implementer provider for this run.
                            One of: kimi | glm | anthropic. Maps to that
                            provider's default coding model (kimi-for-coding,
                            glm-4.6, claude-sonnet-4-6). Reads keys from .env
                            at the repo root (KIMI_API_KEY, GLM_API_KEY).
                            Anthropic uses the local Claude subscription.
                            Default: no override — implementer uses
                            models.implementer.default from models.ts.
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
      "no-retry": { type: "boolean" },
      "no-staging": { type: "boolean" },
      "provider": { type: "string" },
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

  // --provider overrides the implementer model with that provider's default
  // coding model. --implementer-model still wins if both are passed (more
  // specific flag).
  let provider: ProviderName | undefined;
  if (values.provider !== undefined) {
    if (!isProviderName(values.provider)) {
      throw new Error(
        `--provider: expected one of kimi|glm|anthropic, got ${JSON.stringify(values.provider)}`,
      );
    }
    provider = values.provider;
  }
  const implementerModel =
    values["implementer-model"] ??
    (provider !== undefined
      ? defaultCodingModelFor(provider)
      : models.implementer.default);

  const args: RalphArgs = {
    iterations,
    issue,
    repoRoot: values["repo-root"] ?? process.cwd(),
    branch: values.branch ?? detectBranchOr("HEAD"),
    label: values.label ?? LABEL_READY,
    maxConcurrent:
      parsePositiveInt(values["max-concurrent"], "--max-concurrent") ?? 3,
    plannerModel: values["planner-model"] ?? models.planner.default,
    implementerModel,
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
    retryEnabled: values["no-retry"] !== true,
    stagingEnabled: values["no-staging"] !== true,
    provider,
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
    retryEnabled: true,
    stagingEnabled: true,
    imageName: defaultImageName(process.cwd()),
  };
}

// ---------------------------------------------------------------------------
// .env loader (minimal — no new deps)
// ---------------------------------------------------------------------------

/**
 * Keys we surface in the startup-log so the user can see which source each
 * one resolved from. PATH and friends would spam the log.
 */
const LOGGED_ENV_KEYS = new Set([
  "KIMI_API_KEY",
  "GLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
]);

/** Parse a single .env file into process.env. Earlier writers win — we never
 * overwrite an existing value. Silently no-ops if the file doesn't exist.
 * Returns the map of keys this file contributed (only counts the keys it
 * actually set, not ones that were already populated by an earlier source).
 */
function parseEnvFileInto(filePath: string): Record<string, true> {
  const contributed: Record<string, true> = {};
  if (!existsSync(filePath)) return contributed;
  const raw = readFileSync(filePath, "utf8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
    }
    // Double-quoted values get standard dotenv escape semantics: \n → newline,
    // \r → CR, \t → tab, \\ → literal backslash. Single-quoted stays literal.
    // Single-pass regex w/ callback so `\\n` resolves to `\n` literal, not LF.
    if (isDoubleQuoted) {
      value = value.replace(/\\([\\nrt])/g, (_match, ch: string) => {
        if (ch === "n") return "\n";
        if (ch === "r") return "\r";
        if (ch === "t") return "\t";
        return "\\";
      });
    }
    if (!(key in process.env)) {
      process.env[key] = value;
      contributed[key] = true;
    }
  }
  return contributed;
}

/**
 * Resolve sandcastle's env vars from a lookup chain into `process.env`.
 * Earlier sources win per-key; later sources only fill keys still missing.
 *
 * Order:
 *   1. process.env (shell exports — implicit; we never overwrite)
 *   2. $SANDCASTLE_ENV_FILE if set (escape hatch for secret-manager piping)
 *   3. <repoRoot>/.env (project-local override)
 *   4. $XDG_CONFIG_HOME/sandcastle/.env or ~/.config/sandcastle/.env
 *      (host-level default — write once per machine)
 *
 * The host-level path means a user can put `KIMI_API_KEY` once in
 * `~/.config/sandcastle/.env` and have every project + every worktree
 * inherit it. Per-project `.env` still wins for overrides.
 *
 * Logs which source each known key came from. Unknown keys load silently.
 * Parser is intentionally tiny — install `dotenv` and replace `parseEnvFileInto`
 * if you need multiline / variable expansion.
 */
export function loadDotenv(repoRoot: string): void {
  const sources: { label: string; path: string }[] = [];
  const explicit = process.env.SANDCASTLE_ENV_FILE;
  if (explicit && explicit.trim() !== "") {
    sources.push({ label: "$SANDCASTLE_ENV_FILE", path: explicit });
  }
  sources.push({ label: "<repoRoot>/.env", path: path.join(repoRoot, ".env") });
  const xdg = process.env.XDG_CONFIG_HOME;
  const hostDir =
    xdg && xdg.trim() !== ""
      ? path.join(xdg, "sandcastle")
      : path.join(os.homedir(), ".config", "sandcastle");
  sources.push({
    label: "~/.config/sandcastle/.env",
    path: path.join(hostDir, ".env"),
  });

  const resolvedFrom = new Map<string, string>();
  for (const src of sources) {
    const got = parseEnvFileInto(src.path);
    for (const key of Object.keys(got)) {
      if (!resolvedFrom.has(key)) resolvedFrom.set(key, src.label);
    }
  }
  for (const key of LOGGED_ENV_KEYS) {
    if (process.env[key] && process.env[key]!.trim() !== "") {
      const from = resolvedFrom.get(key) ?? "process.env (shell)";
      console.log(`[env] ${key} ← ${from}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

const REQUIRED_PROMPT_FILES = [
  "plan-prompt.md",
  "implement-prompt.md",
  "review-prompt.md",
  "merge-prompt.md",
  "post-merge-review-prompt.md",
  "post-merge-fix-prompt.md",
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
  listMigrations?: (repoRoot: string) => string[];
  getEnv?: (key: string) => string | undefined;
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

  // 6. DATABASE_URL required when drizzle migrations exist on disk. Fail at
  // boot, not mid-iteration after a model call has already burned tokens.
  const listMigrations = opts.listMigrations ?? listMigrationsOnDisk;
  const getEnv = opts.getEnv ?? ((k) => process.env[k]);
  const migrations = listMigrations(args.repoRoot);
  if (migrations.length > 0) {
    const dbUrl = (getEnv("DATABASE_URL") ?? "").trim();
    if (dbUrl === "") {
      errors.push(
        `DATABASE_URL is not set, but this project has ${migrations.length} ` +
          `drizzle migration file(s) on disk (e.g. ${migrations[0]}). The ` +
          `migration applier will fail mid-pipeline. Set DATABASE_URL=... in ` +
          `<repoRoot>/.env (project-specific) before running the loop.`,
      );
    }
  }

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
// Staging branch — git helpers
// ---------------------------------------------------------------------------

/** Persistent staging branch name. Reused across iterations. */
const STAGING_BRANCH = "integration-candidate";

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(repoRoot: string, ...gitArgs: string[]): GitRunResult {
  try {
    const stdout = execFileSync("git", gitArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const e = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString() ?? "");
    const stdout = typeof e.stdout === "string" ? e.stdout : (e.stdout?.toString() ?? "");
    return { ok: false, stdout: stdout.trim(), stderr: stderr.trim() || e.message };
  }
}

/**
 * Resolve a ref to its commit SHA. Returns "" if the ref does not exist
 * (caller decides whether that's an error or just first-iteration setup).
 */
function resolveRefSha(repoRoot: string, ref: string): string {
  const r = runGit(repoRoot, "rev-parse", "--verify", "--quiet", ref);
  return r.ok ? r.stdout : "";
}

/**
 * Reset the staging branch to the integration tip and check it out.
 *
 * - If staging exists and its current tip was left by a failed iteration
 *   (caller passes `failureTagIteration > 0`), tag the tip first as
 *   `bad-merge-iter-<N>` so evidence is preserved without leaking branches.
 * - Force-update staging to point at the current integration tip (this is
 *   how we avoid the stale-local-ref problem if integration moved).
 * - Check out staging so subsequent merge ops land there.
 *
 * Returns the integration tip SHA on success, "" on any failure (caller
 * logs and decides whether to fall back).
 */
function resetStagingToIntegrationTip(
  repoRoot: string,
  integrationBranch: string,
  failureTagIteration: number | null,
  log: (s: string) => void,
  logError: (s: string) => void,
): string {
  const integrationTip = resolveRefSha(repoRoot, integrationBranch);
  if (integrationTip === "") {
    logError(
      `staging-reset: cannot resolve integration branch '${integrationBranch}' — staging not reset`,
    );
    return "";
  }
  const stagingTip = resolveRefSha(repoRoot, STAGING_BRANCH);
  if (stagingTip !== "" && failureTagIteration !== null && failureTagIteration > 0) {
    const tagName = `bad-merge-iter-${failureTagIteration}`;
    const tag = runGit(repoRoot, "tag", "-f", tagName, stagingTip);
    if (tag.ok) {
      log(`staging-reset: tagged failed staging tip ${stagingTip.slice(0, 8)} as ${tagName}`);
    } else {
      logError(`staging-reset: failed to tag bad-merge: ${tag.stderr}`);
      // Non-fatal — proceed with reset.
    }
  }
  // Force-update staging to integration tip. `git branch -f` works whether
  // staging exists or not (creates if absent).
  const reset = runGit(repoRoot, "branch", "-f", STAGING_BRANCH, integrationTip);
  if (!reset.ok) {
    logError(`staging-reset: 'git branch -f ${STAGING_BRANCH} ${integrationTip}' failed: ${reset.stderr}`);
    return "";
  }
  const checkout = runGit(repoRoot, "checkout", STAGING_BRANCH);
  if (!checkout.ok) {
    logError(`staging-reset: 'git checkout ${STAGING_BRANCH}' failed: ${checkout.stderr}`);
    return "";
  }
  log(`staging-reset: ${STAGING_BRANCH} → ${integrationTip.slice(0, 8)} (from ${integrationBranch})`);
  return integrationTip;
}

/**
 * Fast-forward `integrationBranch` to the staging tip. Uses
 * `git update-ref` so we don't have to switch branches first.
 * Returns true on success.
 */
function fastForwardIntegration(
  repoRoot: string,
  integrationBranch: string,
  log: (s: string) => void,
  logError: (s: string) => void,
): boolean {
  const stagingTip = resolveRefSha(repoRoot, STAGING_BRANCH);
  if (stagingTip === "") {
    logError(`fast-forward: cannot resolve ${STAGING_BRANCH}`);
    return false;
  }
  const integrationTip = resolveRefSha(repoRoot, integrationBranch);
  if (integrationTip === "") {
    logError(`fast-forward: cannot resolve integration branch '${integrationBranch}'`);
    return false;
  }
  // Verify it's actually a fast-forward — refuse to clobber unrelated history.
  const merge = runGit(repoRoot, "merge-base", "--is-ancestor", integrationTip, stagingTip);
  if (!merge.ok) {
    logError(
      `fast-forward refused: ${integrationBranch} (${integrationTip.slice(0, 8)}) ` +
        `is not an ancestor of ${STAGING_BRANCH} (${stagingTip.slice(0, 8)}); ` +
        `human triage required`,
    );
    return false;
  }
  const update = runGit(
    repoRoot,
    "update-ref",
    `refs/heads/${integrationBranch}`,
    stagingTip,
    integrationTip,
  );
  if (!update.ok) {
    logError(`fast-forward: update-ref failed: ${update.stderr}`);
    return false;
  }
  log(
    `fast-forward: ${integrationBranch} ${integrationTip.slice(0, 8)} → ${stagingTip.slice(0, 8)}`,
  );
  return true;
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
        agent: sandcastle.claudeCode(spec.model, { env: envForModel(spec.model) }),
        promptFile: spec.promptFile,
        promptArgs: spec.promptArgs,
        idleTimeoutSeconds: spec.idleTimeoutSeconds,
        completionSignal,
      });
      return { stdout: result.stdout, commits: result.commits };
    },
    async createSandbox(spec) {
      // Work around the SDK bug where createSandbox hardcodes
      // agentProviderEnv: {}, dropping per-call env injection. We bake the
      // implementer's provider env (kimi/glm creds + ANTHROPIC_BASE_URL)
      // into sandbox.env so it actually reaches the container. Anthropic
      // models return {} from envForModel (subscription path), so this is
      // a no-op for the default Anthropic case.
      const implEnv = envForModel(spec.implementerModel);
      const sandboxEnv = { ...containerEnv, ...implEnv };
      const handle = await sandcastle.createSandbox({
        branch: spec.branch,
        sandbox: docker({ imageName: args.imageName, env: sandboxEnv, containerUid: 1001, containerGid: 1001, ...buildMounts(spec.mounts) }),
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
            agent: sandcastle.claudeCode(opts.model, { env: envForModel(opts.model) }),
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
    async markMergedToStaging(n) {
      if (args.dryRun) return dryLog("markMergedToStaging", n);
      await markMergedToStagingViaLabel(n);
    },
    async promoteStagingToDone(nums, summary) {
      if (args.dryRun) {
        dryLog("promoteStagingToDone", nums, summary);
        return { failed: [] };
      }
      return promoteAllStagingToDone(nums, summary);
    },
    async quarantine(n, reason) {
      if (args.dryRun) return dryLog("quarantine", n, reason);
      await quarantineViaLabel(n, reason);
    },
    async release(n, reason) {
      if (args.dryRun) return dryLog("release", n, reason);
      await releaseViaLabel(n, reason);
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
   *  "error" => unhandled and not yet quarantined (caller decides);
   *  "deferred" => transient rate-limit, label flipped back to ready-for-agent
   *  for retry next iteration. */
  status: "ok" | "quarantined" | "error" | "deferred";
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
  opts: {
    attemptNumber?: 1 | 2;
    model?: string;
    reviewerFeedback?: string;
  } = {},
): Promise<{ commits: readonly { sha: string }[]; stdout: string }> {
  const attemptNumber = opts.attemptNumber ?? 1;
  // Attempt 2 may legitimately produce zero new commits if the implementer
  // emits a <rebuttal> block instead of writing code. Attempt 1 must commit.
  const requireCommits = attemptNumber === 1;
  const primaryModel = opts.model ?? ctx.args.implementerModel;
  // On attempt 1, allow a one-hop fallback to escalations[0] when the primary
  // throws a rate-limit error. Attempt 2 is already on the escalation, so no
  // further fallback — it just throws and the pipeline catch handles it.
  const fallbackModel =
    attemptNumber === 1 ? models.implementer.escalations[0] : undefined;
  const r = await runWithRateLimitFallback(
    (model) =>
      sb.run({
        name: attemptNumber === 1 ? "implementer" : "implementer-retry",
        maxIterations: 100,
        model,
        promptFile: "./.sandcastle/implement-prompt.md",
        idleTimeoutSeconds: ctx.args.implementerTimeoutSec,
        promptArgs: {
          ITERATION: String(ctx.iteration),
          ISSUE_NUMBER: String(ctx.issueNumber),
          STORY_TITLE: ctx.issue.title,
          BRANCH: ctx.issue.branch,
          ATTEMPT_NUMBER: String(attemptNumber),
          REVIEWER_FEEDBACK: opts.reviewerFeedback ?? "",
        },
      }),
    primaryModel,
    fallbackModel,
    ctx.deps.log,
    `implementer (issue=${ctx.issueNumber})`,
    "implementer",
  );
  if (requireCommits && r.commits.length === 0) {
    throw new Error("implementer made no commits");
  }
  // Sandcastle's r.stdout is the parsed `result.result` from claude's final
  // stream event — already-extracted assistant text, NOT raw stream-json
  // envelopes. The old src/loop/agents.ts and src/planner/planner.ts both
  // handle this with a dual-mode try (stream-json first, then fall back to
  // `alreadyAssistantText: true`). Without the fallback every implementer
  // run throws "no assistant text could be extracted" and triggers recovery,
  // doubling the per-issue Opus spend. Mirror the established pattern.
  //
  // Attempt 2 may emit a <rebuttal>...</rebuttal> block instead of a
  // STORY_COMPLETE envelope (the implementer disagrees with the reviewer).
  // In that case skip the envelope parse — the caller handles the rebuttal
  // path by extracting the rebuttal block from stdout.
  if (!(attemptNumber === 2 && extractRebuttal(r.stdout) !== "")) {
    try {
      parseVerdict(r.stdout, ImplementerOutputSchema);
    } catch {
      parseVerdict(r.stdout, ImplementerOutputSchema, {
        alreadyAssistantText: true,
      });
    }
  }
  return r;
}

/**
 * Extract a `<rebuttal>...</rebuttal>` block from implementer stdout.
 * Returns the inner text (trimmed) or "" if no rebuttal was emitted.
 * Used on attempt 2 — the implementer may disagree with the reviewer
 * instead of writing code; main.mts forwards the rebuttal text into the
 * next reviewer pass as IMPLEMENTER_REBUTTAL.
 */
function extractRebuttal(stdout: string): string {
  const m = stdout.match(/<rebuttal>([\s\S]*?)<\/rebuttal>/);
  return m ? (m[1] ?? "").trim() : "";
}

/** Negative guard shared by both transient-error predicates: permanent errors
 * that won't recover via retry. Matched as snake_case SDK slugs (won't hit
 * prose) or JSON-shaped numeric codes. */
function isPermanentError(msg: string): boolean {
  return /\b(invalid_api_key|invalid_request_error|authentication_error|permission_error|not_found_error|model_not_found|insufficient_quota|account_deactivated)\b|"code"\s*:\s*1113\b|"code"\s*:\s*1110\b/i.test(msg);
}

/** Match common shapes of rate-limit / quota errors across providers. */
function isRateLimitError(msg: string): boolean {
  if (isPermanentError(msg)) return false;
  return /rate[- ]?limit|\b429\b|rate_limit_error|\bquota\b|usage limit/i.test(msg);
}

/** Match transient HTTP 5xx / upstream-infra-unhealthy errors. Distinct from
 * rate-limit because these shouldn't trigger a model fallback — they're not
 * a problem with the chosen model, just bad luck on the provider's
 * infrastructure. Used at the pipeline catch level to defer instead of
 * quarantine.
 *
 * Patterns are intentionally context-anchored. A bare `\b5\d{2}\b` would
 * mis-classify "Postgres on port 5432" or "vite on 5173" as transient.
 * Each alternative requires HTTP-error context: Anthropic prose, JSON SDK
 * slugs in `"type":...` shape, the 529 numeric (Anthropic-specific, rare
 * elsewhere), or the full "500 Internal Server Error" / "503 Service
 * Unavailable" / "502 Bad Gateway" / "504 Gateway Timeout" phrases.
 */
export function isTransientServerError(msg: string): boolean {
  if (isPermanentError(msg)) return false;
  return /the server had an error|"type"\s*:\s*"(?:api_error|overloaded_error)"|\boverloaded_error\b|\b529\b|\bservice unavailable\b|\bbad gateway\b|\bgateway timeout\b|\b500 internal server error\b/i.test(msg);
}

/** Combined predicate for the pipeline-catch defer decision. Either kind of
 * transient error (rate-limit OR 5xx) → defer rather than quarantine. */
function isTransientError(msg: string): boolean {
  return isRateLimitError(msg) || isTransientServerError(msg);
}

// Circuit breaker: if a (role, primary) pair fallbacks BREAKER_THRESHOLD times
// within BREAKER_WINDOW_MS, skip the primary entirely for subsequent calls
// until the rolling window empties. Protects against a known-broken primary
// (e.g. Kimi UA-bug phantom 429s) burning the fallback budget on every call.
const BREAKER_THRESHOLD = 3;
const BREAKER_WINDOW_MS = 60_000;
const fallbackHistory = new Map<string, number[]>();
// Per-issue deferral counter for transient rate-limit storms. Reset on success
// and on process restart (acceptable — a fresh process means the storm is over
// or the operator intervened).
const deferralCounts = new Map<number, number>();
const MAX_DEFERRALS = 3;

/** Test-only: clear module-level transient-state maps. Production never calls
 * this; tests use it in `beforeEach` so prior tests' fallback-breaker or
 * defer-counter state can't bleed into ordering-sensitive cases. */
export function __resetTransientStateForTests(): void {
  fallbackHistory.clear();
  deferralCounts.clear();
}
function recentFallbacks(key: string): number[] {
  const now = Date.now();
  const fresh = (fallbackHistory.get(key) ?? []).filter((t) => now - t < BREAKER_WINDOW_MS);
  fallbackHistory.set(key, fresh);
  return fresh;
}

/**
 * Run a model-parameterized call with one rate-limit fallback. If the primary
 * call throws a rate-limit-shaped error AND a fallback model is provided, retry
 * once on the fallback. Any other error (or rate-limit on the fallback itself)
 * propagates to the caller.
 */
async function runWithRateLimitFallback<T>(
  doRun: (model: string) => Promise<T>,
  primary: string,
  fallback: string | undefined,
  log: (m: string) => void,
  roleLabel: string,
  roleKey: string,
): Promise<T> {
  const breakerKey = `${roleKey}::${primary}`;
  if (fallback !== undefined && recentFallbacks(breakerKey).length >= BREAKER_THRESHOLD) {
    // Refresh timestamp so the breaker stays open while primary remains broken.
    // Without this, timestamps age out after 60s and the breaker closes even if
    // every call has been hitting the fallback.
    recentFallbacks(breakerKey).push(Date.now());
    log(`${roleLabel}: circuit breaker open for ${primary} — using ${fallback} directly`);
    return await doRun(fallback);
  }
  try {
    return await doRun(primary);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    log(`${roleLabel}: [isRateLimitError-audit] verdict=${isRateLimitError(msg)} primary=${primary} msg=${JSON.stringify(msg)}`);
    if (!isRateLimitError(msg) || fallback === undefined) throw err;
    recentFallbacks(breakerKey).push(Date.now());
    // Jitter prevents concurrent workers (--max-concurrent N) from bursting
    // onto the fallback model at the same instant after a shared rate-limit.
    const jitterMs = 100 + Math.floor(Math.random() * 400);
    await new Promise((r) => setTimeout(r, jitterMs));
    log(`${roleLabel}: rate-limit on ${primary}; falling back to ${fallback} (jitter=${jitterMs}ms)`);
    return await doRun(fallback);
  }
}

async function runReviewer(
  sb: SandboxHandle,
  ctx: PipelineCtx,
  commitSha: string,
  promptFile = "./.sandcastle/review-prompt.md",
  model?: string,
  opts: { implementerRebuttal?: string; name?: string } = {},
): Promise<{ marker: string; stdout: string }> {
  const primaryModel = model ?? ctx.args.reviewerModel;
  // Only the default reviewer pass gets a rate-limit fallback. The escalated
  // reviewer-retry pass (already on escalations[0]) has no further fallback.
  const fallbackModel =
    primaryModel === ctx.args.reviewerModel
      ? models.reviewer.escalations[0]
      : undefined;
  const r = await runWithRateLimitFallback(
    (m) =>
      sb.run({
        name: opts.name ?? "reviewer",
        maxIterations: 1,
        model: m,
        promptFile,
        idleTimeoutSeconds: ctx.args.reviewerTimeoutSec,
        promptArgs: {
          ITERATION: String(ctx.iteration),
          ISSUE_NUMBER: String(ctx.issueNumber),
          COMMIT_SHA: commitSha,
          BRANCH: ctx.issue.branch,
          IMPLEMENTER_REBUTTAL: opts.implementerRebuttal ?? "",
        },
      }),
    primaryModel,
    fallbackModel,
    ctx.deps.log,
    `reviewer (issue=${ctx.issueNumber})`,
    "reviewer",
  );
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
): Promise<{
  marker: "RECOVERY_COMPLETE" | "HALT" | "ERRORED";
  errorMsg?: string;
}> {
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
    const errorMsg = (err as Error).message;
    ctx.deps.logError(
      `[issue=${ctx.issueNumber}] recovery threw: ${errorMsg}`,
    );
    return { marker: "ERRORED", errorMsg };
  }
}

/**
 * Apply migrations from the final accepted state and mark the issue done.
 * Migrations are deferred until after the final ALL_CLEAR so that only the
 * accepted SQL hits the dev DB — intermediate state from a failed first
 * attempt never leaks. Returns the IssueOutcome the caller should bubble up.
 */
async function shipAfterMigrations(
  ctx: PipelineCtx,
  sandbox: SandboxHandle,
  preSha: string,
  postSha: string,
  finalMarker: string,
): Promise<IssueOutcome> {
  if (preSha !== "" && postSha !== "" && preSha !== postSha) {
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
  }
  void sandbox; // sandbox lifecycle handled by the caller's finally block
  const summary = `[issue=${ctx.issueNumber}] shipped via sandcastle-loop (commit ${postSha}, branch ${ctx.issue.branch})`;
  // Under --no-staging (legacy), flip label → done immediately. Under staging
  // (default), keep the issue in `in-progress` until the merger lands it on
  // `integration-candidate`; the outer loop flips it to `merged-to-staging`
  // there, then to `done` after the post-merge fast-forward.
  if (!ctx.args.stagingEnabled) {
    await ctx.deps.markDone(ctx.issueNumber, summary);
  }
  deferralCounts.delete(ctx.issueNumber);
  return { status: "ok", finalMarker, postSha };
}

/**
 * Drive a single issue through the full implement → review → (retry?) →
 * migrate → markDone pipeline. Caller wraps this in `claim` and is
 * responsible for converting our return value into ship/quarantine/error
 * counters.
 *
 * Retry ladder (when retryEnabled and escalations are configured):
 *   implementer (default) → reviewer (default) → fail → implementer
 *   (escalated, sees reviewer feedback, may rebut) → reviewer (escalated,
 *   sees rebuttal if any) → fail → quarantine.
 *
 * Migrations only apply on the ALL_CLEAR ship path. On any pipeline error,
 * quarantine. Set `--recovery on` to retry once with the implementer model
 * before quarantining.
 */
async function runIssuePipeline(
  ctx: PipelineCtx,
): Promise<IssueOutcome> {
  let sandbox: SandboxHandle | undefined;
  let preSha = "";
  try {
    sandbox = await ctx.deps.createSandbox({
      branch: ctx.issue.branch,
      implementerModel: ctx.args.implementerModel,
    });
    preSha = sandbox.worktreePath
      ? await ctx.deps.captureSha(sandbox.worktreePath)
      : "";

    // Phase 2a: implementer attempt 1 (default model, no feedback)
    const impl1 = await runImplementer(sandbox, ctx, { attemptNumber: 1 });
    let postSha = sandbox.worktreePath
      ? await ctx.deps.captureSha(sandbox.worktreePath)
      : impl1.commits[impl1.commits.length - 1]?.sha ?? "";

    // Phase 2b: reviewer attempt 1 (default model). Note: migrations are
    // deferred until AFTER ALL_CLEAR — only the final accepted SQL hits the
    // dev DB, never the intermediate state of a failed first attempt.
    const review1 = await runReviewer(sandbox, ctx, postSha);

    if (review1.marker === "ALL_CLEAR") {
      return await shipAfterMigrations(ctx, sandbox, preSha, postSha, "ALL_CLEAR");
    }

    // Reviewer attempt 1 marked HAS_BLOCKERS. Decide retry vs quarantine.
    const implEscalations = models.implementer.escalations;
    const revEscalations = models.reviewer.escalations;
    const canRetry =
      ctx.args.retryEnabled &&
      implEscalations.length > 0 &&
      revEscalations.length > 0;

    if (!canRetry) {
      const why = !ctx.args.retryEnabled
        ? "retry disabled (--no-retry)"
        : "no escalation model available for implementer or reviewer";
      const reason =
        `[issue=${ctx.issueNumber}] reviewer marked ${review1.marker} — ` +
        `quarantining (${why}).`;
      deferralCounts.delete(ctx.issueNumber);
      await ctx.deps.quarantine(ctx.issueNumber, reason);
      return { status: "quarantined", finalMarker: review1.marker, postSha };
    }

    // Phase 2c: implementer attempt 2 (escalated, with reviewer feedback).
    // Worktree is NOT reset — the implementer sees its own commits and
    // either appends a fix on top OR emits a <rebuttal> instead of code.
    ctx.deps.log(
      `[issue=${ctx.issueNumber}] reviewer attempt 1 HAS_BLOCKERS — ` +
        `escalating implementer to ${implEscalations[0]}`,
    );
    const impl2 = await runImplementer(sandbox, ctx, {
      attemptNumber: 2,
      model: implEscalations[0],
      reviewerFeedback: review1.stdout,
    });
    const rebuttal = extractRebuttal(impl2.stdout);
    const postSha2 = sandbox.worktreePath
      ? await ctx.deps.captureSha(sandbox.worktreePath)
      : impl2.commits[impl2.commits.length - 1]?.sha ?? postSha;
    postSha = postSha2;

    // Phase 2d: reviewer attempt 2 (escalated). If implementer disagreed,
    // pass the rebuttal in. Reviewer always has the final word.
    ctx.deps.log(
      `[issue=${ctx.issueNumber}] running reviewer attempt 2 on ` +
        `${revEscalations[0]}${rebuttal ? " (with implementer rebuttal)" : ""}`,
    );
    const review2 = await runReviewer(sandbox, ctx, postSha, undefined, revEscalations[0], {
      implementerRebuttal: rebuttal,
      name: "reviewer-retry",
    });

    if (review2.marker === "ALL_CLEAR") {
      return await shipAfterMigrations(ctx, sandbox, preSha, postSha, "ALL_CLEAR");
    }

    const reason =
      `[issue=${ctx.issueNumber}] reviewer marked ${review2.marker} after ` +
      `escalated retry — quarantining for human triage.`;
    deferralCounts.delete(ctx.issueNumber);
    await ctx.deps.quarantine(ctx.issueNumber, reason);
    return { status: "quarantined", finalMarker: review2.marker, postSha };
  } catch (err) {
    const errMsg = (err as Error).message;
    const transientVerdict = isTransientError(errMsg);
    ctx.deps.log(
      `[isTransientError-audit] issue=${ctx.issueNumber} verdict=${transientVerdict} msg=${JSON.stringify(errMsg)}`,
    );
    ctx.deps.logError(
      `[issue=${ctx.issueNumber}] pipeline error: ${errMsg}`,
    );

    // Shared helper: try to defer the issue (release label, return "deferred"
    // status). Returns the outcome on success, null on budget exhaustion or
    // release failure (caller should fall through to quarantine). Bounded by
    // MAX_DEFERRALS — after that, real quarantine.
    //
    // `causeMsg` is the error that actually motivated the defer — pass it
    // explicitly so the release comment points the operator at the right
    // failure (the pipeline-level path passes errMsg; the recovery-throw path
    // passes the recovery's own thrown message).
    const tryDefer = async (
      kind: string,
      causeMsg: string,
    ): Promise<IssueOutcome | null> => {
      const c = (deferralCounts.get(ctx.issueNumber) ?? 0) + 1;
      if (c > MAX_DEFERRALS) {
        ctx.deps.logError(
          `[issue=${ctx.issueNumber}] exceeded MAX_DEFERRALS (${MAX_DEFERRALS}) — escalating to quarantine`,
        );
        deferralCounts.delete(ctx.issueNumber);
        return null;
      }
      deferralCounts.set(ctx.issueNumber, c);
      const deferReason =
        `[sandcastle-defer] [issue=${ctx.issueNumber}] ${kind} ` +
        `(attempt ${c}/${MAX_DEFERRALS}) — released for retry next iteration: ` +
        `${causeMsg.slice(0, 400)}`;
      ctx.deps.log(deferReason);
      try {
        await ctx.deps.release(ctx.issueNumber, deferReason);
        return { status: "deferred", finalMarker: "TRANSIENT_ERROR" };
      } catch (releaseErr) {
        ctx.deps.logError(
          `[issue=${ctx.issueNumber}] release failed: ${(releaseErr as Error).message} — falling through to quarantine`,
        );
        return null;
      }
    };

    // Defer transient failures (rate-limit OR upstream 5xx) back to
    // ready-for-agent so the next iteration retries. Without this, a brief
    // Anthropic outage could quarantine many issues that would succeed on
    // retry.
    if (transientVerdict) {
      const deferred = await tryDefer("transient error", errMsg);
      if (deferred) return deferred;
      // fall through to quarantine on budget exhaustion or release failure
    }

    // Opt-in single recovery pass with the implementer model. If recovery
    // succeeds, mark done; otherwise fall through to quarantine. Skip recovery
    // entirely on transient errors — they already deferred above (and recovery
    // uses Opus which would just burn quota on a problem the model can't fix).
    if (
      ctx.args.recoveryEnabled &&
      sandbox &&
      !transientVerdict
    ) {
      ctx.deps.log(
        `[issue=${ctx.issueNumber}] --recovery on — attempting one recovery pass`,
      );
      const rec = await runRecovery(sandbox, ctx, errMsg);
      if (rec.marker === "RECOVERY_COMPLETE") {
        const postSha = sandbox.worktreePath
          ? await ctx.deps.captureSha(sandbox.worktreePath)
          : "";

        // Review recovery's output before shipping. The implementer path is
        // always reviewed; until now, recovery output went straight to the
        // merger unreviewed. That let a recovery papering over a config
        // failure (or hallucinating an irrelevant "fix") merge garbage. Run
        // the same reviewer pass — same prompt, same marker set — and
        // quarantine on HAS_BLOCKERS rather than ship.
        //
        // Skipped when postSha is empty (no worktree available, e.g. in
        // dry-run / mocked paths); the legacy ship path runs as before.
        let recoveryApproved = postSha === "";
        if (postSha !== "") {
          try {
            const rrev = await runReviewer(
              sandbox,
              ctx,
              postSha,
              undefined,
              undefined,
              { name: "recovery-reviewer" },
            );
            if (rrev.marker === "ALL_CLEAR") {
              recoveryApproved = true;
            } else {
              ctx.deps.log(
                `[issue=${ctx.issueNumber}] recovery-reviewer marker=${rrev.marker} — quarantining instead of shipping`,
              );
            }
          } catch (e) {
            ctx.deps.logError(
              `[issue=${ctx.issueNumber}] recovery-reviewer threw: ${(e as Error).message} — quarantining`,
            );
          }
        }

        if (recoveryApproved) {
          const summary =
            `[issue=${ctx.issueNumber}] shipped via sandcastle-loop recovery ` +
            `(commit ${postSha}, branch ${ctx.issue.branch})`;
          try {
            // Under staging, keep `in-progress` until the merger / staging
            // flow takes over. Under --no-staging, flip immediately.
            if (!ctx.args.stagingEnabled) {
              await ctx.deps.markDone(ctx.issueNumber, summary);
            }
            deferralCounts.delete(ctx.issueNumber);
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
        // Recovery review rejected or threw — fall through to quarantine.
      } else if (
        rec.marker === "ERRORED" &&
        isTransientError(rec.errorMsg ?? "")
      ) {
        // Recovery never produced a verdict — it threw an upstream transient
        // error (e.g. Anthropic 5xx). Don't quarantine a perfectly recoverable
        // issue over Anthropic's bad luck; defer to the next iteration.
        ctx.deps.log(
          `[issue=${ctx.issueNumber}] recovery threw transient (${JSON.stringify(rec.errorMsg)}) — deferring instead of quarantining`,
        );
        const deferred = await tryDefer(
          "recovery threw transient",
          rec.errorMsg ?? "",
        );
        if (deferred) return deferred;
        // fall through to quarantine on budget exhaustion or release failure
      }
    }

    // Issue is heading to quarantine — clear any stale defer counter so a
    // future un-quarantine + re-claim starts fresh at attempt 1/MAX_DEFERRALS,
    // not partway through the budget.
    deferralCounts.delete(ctx.issueNumber);
    const reason = `[issue=${ctx.issueNumber}] pipeline halted (transientVerdict=${transientVerdict}): ${errMsg.slice(0, 400)}`;
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
  const deferredIssues: number[] = [];
  let iterationsRun = 0;
  // Cross-iteration staging state — the iteration number that left staging
  // in a known-bad state, or null if last iteration finished clean. Used to
  // tag the failed staging tip as `bad-merge-iter-<N>` before reset.
  let lastFailedStagingIteration: number | null = null;

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
          } else if (s.value.outcome.status === "deferred") {
            deferredIssues.push(s.value.issueNumber);
            // Intentionally do NOT touch consecutiveFailures — a transient
            // rate-limit storm must not trip the loop's overall circuit
            // breaker. The issue is already released back to ready-for-agent
            // and will be re-claimed on the next iteration.
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
      const mergedIssueNums = mergedBranches
        .map((b) => Number(b.id))
        .filter((n) => Number.isInteger(n) && n > 0);
      const branchesArg = mergedBranches.map((b) => `- ${b.branch}`).join("\n");
      const issuesArg = mergedBranches
        .map((i) => `- #${i.id}: ${i.title}`)
        .join("\n");

      // Staging prelude (default). Tag the previous iteration's bad staging
      // tip if the last iteration left one, then force-update staging to
      // the current integration tip and check it out so the merger lands
      // its work on `integration-candidate` rather than directly on the
      // integration branch.
      let stagingActive = false;
      if (args.stagingEnabled) {
        const tip = resetStagingToIntegrationTip(
          args.repoRoot,
          args.branch,
          lastFailedStagingIteration,
          (s) => deps.log(s),
          (s) => deps.logError(s),
        );
        if (tip === "") {
          deps.logError(
            `staging reset failed — falling back to direct merge into ${args.branch} for iteration ${it}`,
          );
        } else {
          stagingActive = true;
          // Reset succeeded, so any prior failure is now preserved as a tag;
          // clear the cross-iteration marker.
          lastFailedStagingIteration = null;
        }
      }

      let mergerOk = true;
      try {
        await deps.run({
          name: "merger",
          maxIterations: 1,
          model: args.mergerModel,
          promptFile: "./.sandcastle/merge-prompt.md",
          idleTimeoutSeconds: args.implementerTimeoutSec,
          promptArgs: {
            ITERATION: String(it),
            BRANCHES: branchesArg,
            ISSUES: issuesArg,
          },
        });
      } catch (err) {
        mergerOk = false;
        deps.logError(
          `merge phase threw: ${(err as Error).message} — continuing to next iteration`,
        );
      }

      // After a successful merger, flip every shipped issue's label from
      // `in-progress` → `merged-to-staging`. Skip when staging is off
      // (legacy flow already flipped them straight to `done` inside
      // runIssuePipeline).
      if (stagingActive && mergerOk) {
        for (const n of mergedIssueNums) {
          try {
            await deps.markMergedToStaging(n);
          } catch (err) {
            deps.logError(
              `[issue=${n}] markMergedToStaging failed: ${(err as Error).message}`,
            );
          }
        }
      }

      // Phase 4: post-merge review. Under staging, the verdict GATES the
      // fast-forward of the integration branch and triggers the fixer
      // ladder. Under --no-staging, it stays advisory (today's behavior).
      const runPostMergeReviewer = async (
        model: string,
      ): Promise<string> => {
        try {
          const r = await deps.run({
            name: "post-merge-reviewer",
            maxIterations: 1,
            model,
            promptFile: "./.sandcastle/post-merge-review-prompt.md",
            idleTimeoutSeconds: args.reviewerTimeoutSec,
            promptArgs: {
              ITERATION: String(it),
              MERGE_DEPTH: String(mergedBranches.length),
              INTEGRATION_BRANCH: args.branch,
              BRANCHES: branchesArg,
              ISSUES: issuesArg,
            },
          });
          const marker = extractMarker(r.stdout, [
            "POST_MERGE_ALL_CLEAR",
            "POST_MERGE_ISSUES_FOUND",
          ] as const);
          deps.log(
            `post-merge review: ${marker || "(no marker emitted)"}`,
          );
          // Capture the reviewer's stdout so the fixer can read its
          // concerns verbatim — the marker is just the verdict, the BODY
          // is what the fixer needs.
          return marker;
        } catch (err) {
          deps.logError(
            `post-merge review threw: ${(err as Error).message}`,
          );
          return "";
        }
      };

      // First pass uses the default model. We need access to stdout for the
      // fixer pass below, so re-implement the call inline rather than using
      // the helper above.
      let postMergeMarker = "";
      let postMergeFeedback = "";
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
            BRANCHES: branchesArg,
            ISSUES: issuesArg,
          },
        });
        postMergeMarker = extractMarker(r.stdout, [
          "POST_MERGE_ALL_CLEAR",
          "POST_MERGE_ISSUES_FOUND",
        ] as const);
        postMergeFeedback = r.stdout;
        deps.log(
          `post-merge review: ${postMergeMarker || "(no marker emitted)"}`,
        );
      } catch (err) {
        deps.logError(
          `post-merge review threw: ${(err as Error).message} — continuing to next iteration`,
        );
      }

      // Fix-ladder. Only runs under staging AND only when the first pass
      // flagged ISSUES_FOUND. Single fix attempt with the escalated fixer
      // model, then re-run the reviewer on the escalated model.
      if (
        stagingActive &&
        postMergeMarker === "POST_MERGE_ISSUES_FOUND"
      ) {
        const fixerModel =
          models.postMergeFixer.escalations[0] ?? models.postMergeFixer.default;
        deps.log(
          `post-merge fix-loop: spawning fixer (model=${fixerModel}) on ${STAGING_BRANCH}`,
        );
        let fixerOk = true;
        try {
          await deps.run({
            name: "post-merge-fixer",
            maxIterations: 1,
            model: fixerModel,
            promptFile: "./.sandcastle/post-merge-fix-prompt.md",
            idleTimeoutSeconds: args.implementerTimeoutSec,
            promptArgs: {
              ITERATION: String(it),
              INTEGRATION_BRANCH: args.branch,
              BRANCHES: branchesArg,
              ISSUES: issuesArg,
              POST_MERGE_FEEDBACK: postMergeFeedback.slice(0, 8000),
            },
          });
        } catch (err) {
          fixerOk = false;
          deps.logError(
            `post-merge fixer threw: ${(err as Error).message} — falling through to quarantine`,
          );
        }
        if (fixerOk) {
          const reviewerEscModel =
            models.postMergeReviewer.escalations[0] ??
            args.postMergeReviewerModel;
          deps.log(
            `post-merge fix-loop: re-running reviewer (model=${reviewerEscModel}) on fixed staging`,
          );
          postMergeMarker = await runPostMergeReviewer(reviewerEscModel);
        }
      }

      // Promotion / quarantine decision.
      if (stagingActive) {
        if (postMergeMarker === "POST_MERGE_ALL_CLEAR" && mergerOk) {
          // Fast-forward integration, then promote all merged-to-staging
          // issues to done.
          const ff = fastForwardIntegration(
            args.repoRoot,
            args.branch,
            (s) => deps.log(s),
            (s) => deps.logError(s),
          );
          if (ff) {
            const summary =
              `[ralph it=${it}] integration ${args.branch} fast-forwarded; ` +
              `staging certified by post-merge reviewer`;
            try {
              const promoteRes = await deps.promoteStagingToDone(
                mergedIssueNums,
                summary,
              );
              if (promoteRes.failed.length > 0) {
                deps.logError(
                  `promoteStagingToDone failed for issues: ${promoteRes.failed.join(", ")}`,
                );
              }
            } catch (err) {
              deps.logError(
                `promoteStagingToDone threw: ${(err as Error).message}`,
              );
            }
            lastFailedStagingIteration = null;
          } else {
            // Fast-forward refused — treat as a staging failure.
            lastFailedStagingIteration = it;
          }
        } else {
          // Staging failed certification (post-fixer too) OR merger failed
          // OR no marker — quarantine every merged-to-staging issue, leave
          // staging at its current tip (next iteration's reset will tag
          // it as `bad-merge-iter-<N>`).
          const reason =
            `[ralph it=${it}] staging post-merge reviewer marked ` +
            `${postMergeMarker || "(no marker)"} after fixer pass — ` +
            `quarantining all issues that landed on ${STAGING_BRANCH} ` +
            `this iteration. Integration ${args.branch} NOT advanced.`;
          deps.logError(reason);
          for (const n of mergedIssueNums) {
            try {
              await deps.quarantine(n, reason);
              quarantinedIssues.push(n);
            } catch (err) {
              deps.logError(
                `[issue=${n}] staging-failure quarantine threw: ${(err as Error).message}`,
              );
            }
          }
          lastFailedStagingIteration = it;
        }
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

    // Load .env BEFORE preflight so provider keys are visible to envForModel.
    // Real shell exports still win — loadDotenv only fills in missing keys.
    loadDotenv(args.repoRoot);

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
