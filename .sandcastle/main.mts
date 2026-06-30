#!/usr/bin/env -S npx tsx
/**
 * Sandcastle "sandcastle" orchestrator (Wave 6.1, Agent B).
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
import {
  existsSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { defaultImageName } from "@ai-hero/sandcastle/sandboxes/docker";

import {
  configureGh,
  claimViaLabel,
  quarantineViaLabel,
  releaseViaLabel,
  markDoneViaLabel,
  markMergedToStagingViaLabel,
  promoteAllStagingToDone,
  postIssueComment,
  listIssuesByLabel,
  listOpenIssuesWithBodies,
  LABEL_READY,
  acquireSingleInstanceLock,
} from "./lib/state/index.js";
import { parseVerdict, extractMarker, IMPLEMENTER_MARKERS, MarkerNotFoundError, VerdictParseError } from "./lib/verdicts/index.js";
import { ImplementerOutputSchema } from "./lib/verdicts/index.js";
import { createStatusStore, type StatusStore } from "./lib/status/store.js";
import {
  applyMigrationsBetween,
  listMigrationsOnDisk,
  validateJournalRegistration,
} from "./lib/migrations/index.js";
import {
  snapshotImportedFiles,
  detectImportedFileChange,
} from "./lib/restart-detector.js";
import { models, codexModels } from "./models.js";
import { diagnoseHaltCause } from "./lib/diagnose.js";
import {
  CritiqueCriticalError,
  critiqueErrorReasonCode,
  resolveAndExtractSkillInvocations,
  filterPlanByTypeLabels,
  findLoadableRubrics,
  MissingRequiredSkillsError,
  parseRequiredSkillsByType,
  validateRequiredSkillsInvoked,
} from "./lib/skill-discipline.js";
import {
  envForModel,
  backendForModel,
  defaultCodingModelFor,
  isProviderName,
  type ProviderName,
  type AgentBackend,
} from "./providers.js";
import { worktreePathFor } from "./lib/worktree-path.js";
import {
  buildSandboxProvider,
  type SandboxProvider,
} from "./lib/sandbox-provider.js";

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
export interface SandcastleArgs {
  iterations: number;
  issue?: number;
  repoRoot: string;
  branch: string;
  label: string;
  maxConcurrent: number;
  plannerModel: string;
  implementerModel: string;
  reviewerModel: string;
  critiqueModel: string;
  mergerModel: string;
  postMergeReviewerModel: string;
  recoveryModel: string;
  implementerTimeoutSec: number;
  reviewerTimeoutSec: number;
  /**
   * Outer wall-clock ceiling around every SDK `run` / `handle.run` call.
   * Independent of the SDK's own idle timer, which resets on every
   * stdout line and so can be evaded by an agent that emits trickle
   * output while making no real progress (observed: tsc retry loops
   * after a host-level OOM kills the tsc child silently). When the
   * ceiling fires, an `AbortSignal` is raised; the SDK kills the
   * in-flight agent subprocess and rejects with the abort reason.
   * Set high enough that legitimate slow runs aren't false-killed
   * (default 3600s = 60 min, ~3x the implementer idle timeout).
   */
  hardCeilingSec: number;
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
   * immediately.
   *
   * On round-2 HAS_BLOCKERS, the loop optionally grants a third attempt:
   * if both rounds' CATEGORY SWEEP blocks parse AND every category that
   * was a "finding" in round 1 is now "ok" or "n/a" in round 2, the
   * implementer demonstrably resolved everything the reviewer asked
   * about — round 2's complaints are genuinely new and progress is
   * real, so we try once more rather than bouncing to needs-human. A
   * malformed or missing sweep in either round skips the grant
   * (conservative fallback; never produce a free retry on a parse
   * failure). Round 3 HAS_BLOCKERS → quarantine; there is no round 4.
   *
   * Set to false (via `--no-retry`) to fall back to one-shot behavior
   * (any HAS_BLOCKERS → quarantine immediately).
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
   * Agent backend for this run (ADR 0012). `"codex"` routes every role —
   * including retry-ladder escalations and the post-merge fixer — to Codex
   * models via {@link roleModelsFor}; `"claude"` (or undefined) uses
   * `models.ts`. Set by `--backend`. Undefined is treated as `"claude"`.
   */
  backend?: AgentBackend;
  /**
   * Docker image to run the sandbox in. Defaults to the same name
   * `sandcastle docker build-image` produces — `sandcastle:<basename>` of
   * `--repo-root` (e.g. `~/Dev/myproj` → `sandcastle:myproj`). That match
   * is critical: sandcastle's own `docker()` would otherwise derive the
   * name from the per-issue WORKTREE dir (`sandcastle:agent-issue-83`)
   * which is never the image we just built. Override with `--image-name`.
   */
  imageName: string;
  /**
   * When true, the preflight `git diff --quiet HEAD -- .sandcastle/main.mts`
   * check is skipped (a warning is logged instead). The check exists to
   * prevent the "patched locally but never committed" failure mode that
   * has bitten the loop twice in a row: a downstream fix gets shipped in a
   * consumer's vendored copy of main.mts but never propagated upstream, so
   * the next `/sandcastle-update` clobbers the patch. Default false —
   * strictness is the norm; the flag exists for legitimate
   * "tweak-then-test-then-commit" workflows in the template repo itself.
   */
  allowDirtySandcastle: boolean;
  /**
   * Sandbox provider. `"docker"` (default) runs each agent inside an
   * ephemeral Docker container. `"mac-host"` skips the container and
   * runs the agent natively on the macOS host — useful for development
   * on Apple Silicon where Docker-in-Docker or nested virtualisation is
   * unavailable. Wired via `--sandbox docker|mac-host`.
   */
  sandbox: "docker" | "mac-host";
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
  /**
   * Per-iteration session-capture metadata, threaded straight through from the
   * SDK's `SandboxRunResult.iterations` (see
   * `node_modules/@ai-hero/sandcastle/dist/Orchestrator.d.ts:32`). We expose
   * both `sessionFilePath` (the SDK's chosen path, set only when capture is
   * wired with `bindMountHandle`) and `sessionId` (always present for Claude
   * agents) so {@link resolveSessionFilePath} in skill-discipline can fall
   * back to the conventional `~/.claude/projects/<encoded>/<id>.jsonl`
   * layout when `sessionFilePath` is undefined. Audit Issue 1 (2026-05-30)
   * — without the `sessionId` fallback, every iteration on host-backed
   * orchestration was credited with zero skill invocations.
   * Optional because legacy test mocks return `{ stdout, commits }` without
   * iteration data.
   */
  readonly iterations?: readonly {
    readonly sessionFilePath?: string;
    readonly sessionId?: string;
  }[];
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
  /**
   * Override the working directory for this top-level run. Used by the merger
   * to run inside the dedicated staging worktree at
   * `<repoRoot>/.sandcastle/worktrees/staging` rather than the launch worktree
   * — prevents the merger from leaving the launch HEAD parked on
   * `integration-candidate` across iterations (see ensureStagingWorktree).
   */
  readonly cwd?: string;
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
  /**
   * List open issues carrying `label`, returning `{ number, title, labels }`
   * for each. Used host-side to re-fetch the planner's view of labels so the
   * orchestrator can enforce `type:`-label discipline without trusting the
   * planner's (LLM-generated) label claims. Tests inject a stub; production
   * wraps {@link listIssuesByLabel} from `./lib/state/gh.ts`.
   */
  listIssuesByLabel(
    label: string,
  ): Promise<readonly { number: number; title: string; labels: readonly string[] }[]>;
  /**
   * List ALL open issues with body + labels. Used only by the "no claimable
   * issues" exit (Issue E) to surface `Blocked by: #N` chains — the operator
   * otherwise can't distinguish "nothing ready" from "everything ready is
   * blocked". A blocker is usually `in-progress` (not `ready-for-agent`), so
   * the openness check needs the full open set, not a label-filtered view.
   * Tests inject a stub; production wraps {@link listOpenIssuesWithBodies}.
   * The clean-exit caller wraps this in try/catch so a gh failure degrades to
   * the plain message rather than crashing the exit.
   */
  listOpenIssuesWithBodies(): Promise<
    readonly { number: number; body: string; labels: readonly string[] }[]
  >;
  /** Migrations between two SHAs in `repoRoot`. Returns # applied + errors. */
  applyMigrations(
    repoRoot: string,
    preSha: string,
    postSha: string,
  ): Promise<{ applied: number; realErrors: readonly { msg: string }[] }>;
  /**
   * Validate that every new <NNNN>_*.sql migration added between two SHAs
   * has a matching tag in <same-dir>/meta/_journal.json. Returns the list
   * of unregistered files (empty = all good). Tests can stub this; in
   * production it delegates to validateJournalRegistration.
   */
  validateMigrationJournal(
    repoRoot: string,
    preSha: string,
    postSha: string,
  ): Promise<
    readonly {
      file: string;
      expectedTag: string;
      journalPath: string;
      journalMissing: boolean;
    }[]
  >;
  /** Capture the current HEAD SHA inside the sandbox worktree. */
  captureSha(worktreePath: string): Promise<string>;
  /**
   * Lint-gate backstop — deterministic, host-side, needs no `node_modules`.
   * Reads the post-commit message and the project's package.json to classify:
   *   - `"dormant"`: project has no `lint` script, or there's no code diff
   *     (`preSha === postSha`) — the gate is a graceful no-op.
   *   - `"pass"`: the commit body carries the `SANDCASTLE-LINT: pass` cert.
   *   - `"missing"`: a lint-enabled project changed code but the commit body
   *     lacks the cert — `shipAfterMigrations` quarantines for human triage.
   * The lint RUN and the truth of the cert are handled in-sandbox (implementer
   * runs+fixes lint; reviewer's CATEGORY SWEEP verifies). This host check only
   * confirms the cert is present, mirroring how the e2e gate pairs driver
   * ground-truth with reviewer verification. Required like its sibling gate
   * `validateMigrationJournal` — every code-bearing slice is classified; the
   * dormant cases are decided inside, not by an absent method.
   */
  checkLintCert(
    repoRoot: string,
    preSha: string,
    postSha: string,
  ): Promise<{ status: "pass" | "missing" | "dormant" }>;
  /** Logger (info-level). Tests inject a recorder; production logs to stderr. */
  log(line: string): void;
  /** Logger (error-level). */
  logError(line: string): void;
  /**
   * Optional iteration-start hook. Production wires this to `undefined`.
   * Tests use it to inject mid-run filesystem mutations so the restart-
   * detector path can be exercised without a real recovery agent.
   */
  iterationStartHook?: (it: number) => void | Promise<void>;
}

export interface RunMainResult {
  /** Process exit code: 0 / 1 / 2 per the spec, or 75 for hot-reload restart. */
  exitCode: 0 | 1 | 2 | 75;
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
  --critique-model M            Default: from .sandcastle/models.ts (critique.default).
  --merger-model M              Default: from .sandcastle/models.ts (merger.default).
  --post-merge-reviewer-model M Default: from .sandcastle/models.ts (postMergeReviewer.default).
  --recovery-model M            Default: from .sandcastle/models.ts (recovery.default). Used by the recovery pass.
  --implementer-timeout-sec N   Default: 1200.
  --reviewer-timeout-sec N      Default: 600.
  --hard-ceiling-sec N      Outer wall-clock ceiling per SDK call. Fires
                            independently of the SDK's idle timer (which
                            resets on every output line and can be
                            evaded by trickle output during an OOM hang).
                            When it fires, the in-flight agent is
                            aborted. Default: 3600 (60 min).
  --consecutive-failure-limit N Default: 3.
  --log-file PATH           Tee output to this file. Default:
                            <repo>/.sandcastle/run.log (gitignored), truncated
                            per run so a hard death stays diagnosable.
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
  --backend NAME            Agent backend for the run: claude (default) or
                            codex. codex routes every role to Codex models
                            (codexModels in models.ts → sandcastle.codex) and
                            authenticates via the mounted ~/.codex subscription
                            (ADR 0012). Cannot combine with --provider.
  --image-name NAME         Docker image to run sandboxes in.
                            Default: derived from --repo-root basename
                            (e.g. /Dev/myproj → sandcastle:myproj),
                            matching 'sandcastle docker build-image'.
  --sandbox PROVIDER        Sandbox provider: docker (default) or mac-host
                            (no container — runs agent natively on macOS host).
  --allow-dirty-sandcastle  Skip the preflight check that refuses launch
                            when .sandcastle/main.mts has uncommitted
                            modifications vs HEAD. The check exists to
                            prevent "patched locally but never propagated
                            upstream" incidents. When set, a stderr WARN
                            is emitted so the bypass is visible in logs.
                            Default: off (strict).
  --help                    Show this message and exit 0.

Exit codes:
  0  No claimable stories OR successful completion.
  1  Circuit breaker tripped or fatal error.
  2  Max iterations exhausted (still ran fine — just out of cycles).
`;

/**
 * Parse argv into a fully-defaulted {@link SandcastleArgs}. Throws on validation
 * errors with a precise message — the CLI entry catches and exits 2.
 *
 * Exported so tests can drive the orchestrator without re-implementing the
 * full default set.
 */
export function parseSandcastleArgs(argv: readonly string[]): {
  args: SandcastleArgs;
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
      "critique-model": { type: "string" },
      "merger-model": { type: "string" },
      "post-merge-reviewer-model": { type: "string" },
      "recovery-model": { type: "string" },
      "implementer-timeout-sec": { type: "string" },
      "reviewer-timeout-sec": { type: "string" },
      "hard-ceiling-sec": { type: "string" },
      "consecutive-failure-limit": { type: "string" },
      "log-file": { type: "string" },
      "dry-run": { type: "boolean" },
      "recovery": { type: "string" },
      "no-retry": { type: "boolean" },
      "no-staging": { type: "boolean" },
      "provider": { type: "string" },
      "backend": { type: "string" },
      "sandbox": { type: "string" },
      "image-name": { type: "string" },
      "allow-dirty-sandcastle": { type: "boolean" },
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

  // Env var override: when the sandcastle-wrapper.sh re-launches us after a
  // hot-reload restart, it sets SANDCASTLE_REMAINING_ITERATIONS so the
  // --iterations cap is honored across the restart boundary.
  const envRemaining = process.env.SANDCASTLE_REMAINING_ITERATIONS;
  // parsePositiveInt throws on invalid strings — we want the loud failure.
  // It only returns null for undefined input, which the outer guard rules out.
  const effectiveIterations =
    envRemaining !== undefined && envRemaining !== ""
      ? parsePositiveInt(envRemaining, "SANDCASTLE_REMAINING_ITERATIONS")!
      : iterations;

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

  // --backend selects the agent backend (ADR 0012). "codex" routes every role
  // to Codex models (dispatched to sandcastle.codex by backendForModel);
  // "claude" (default) uses models.ts. --provider (kimi/glm/anthropic) is a
  // claude-backend-only endpoint switch and cannot combine with codex.
  // --backend may be given explicitly, or INFERRED from an explicit
  // --implementer-model (ADR 0012). The two must not disagree, or policy
  // (escalations/role defaults, which key off `args.backend`) would silently
  // split from dispatch (the agent factory + AGENTS.md staging, which key off
  // the model). So:
  //   - both given and they conflict  → hard-error (you said two opposite things)
  //   - only the model given          → infer the backend from it
  //   - neither                       → default claude
  // --implementer-model is the SOLE inference source; the other role-model
  // flags are validated against the resolved backend below (never inferred), so
  // after that check the invariant holds for EVERY role: backendForModel(roleModel)
  // === backend.
  const explicitBackend: AgentBackend | undefined = (() => {
    const v = values.backend;
    if (v === undefined) return undefined;
    if (v !== "claude" && v !== "codex") {
      throw new Error(
        `--backend: expected one of claude|codex, got ${JSON.stringify(v)}`,
      );
    }
    return v;
  })();
  const explicitImplModel = values["implementer-model"];
  const implModelBackend =
    explicitImplModel !== undefined ? backendForModel(explicitImplModel) : undefined;
  if (
    explicitBackend !== undefined &&
    implModelBackend !== undefined &&
    explicitBackend !== implModelBackend
  ) {
    throw new Error(
      `--backend ${explicitBackend} contradicts --implementer-model ` +
        `"${explicitImplModel}" (a ${implModelBackend} model). Pass a matching ` +
        `model, or drop --backend to infer it from the model.`,
    );
  }
  const backend: AgentBackend = explicitBackend ?? implModelBackend ?? "claude";
  if (backend === "codex" && provider !== undefined) {
    throw new Error(
      "--provider applies only to the claude backend; it cannot combine with --backend codex",
    );
  }

  // Reconcile the OTHER role-model flags against the resolved backend. A
  // sandcastle run is single-backend end-to-end: escalations, skill-discipline,
  // and AGENTS.md staging all key off `args.backend`, while per-role dispatch
  // keys off each role's model (agentForModel / backendForModel). A cross-backend
  // role model (e.g. `--backend codex --reviewer-model <claude-id>`) would
  // silently run that role on the other agent — the same split-brain the
  // implementer reconcile above closes. These flags are validated, NOT inferred
  // (only --implementer-model infers, per ADR 0012). Hard-error at parse so the
  // contradiction surfaces before any run.
  const roleModelFlags: ReadonlyArray<readonly [string, string | undefined]> = [
    ["--planner-model", values["planner-model"]],
    ["--reviewer-model", values["reviewer-model"]],
    ["--critique-model", values["critique-model"]],
    ["--merger-model", values["merger-model"]],
    ["--post-merge-reviewer-model", values["post-merge-reviewer-model"]],
    ["--recovery-model", values["recovery-model"]],
  ];
  const mismatchedRoleModels: Array<{ flag: string; model: string; modelBackend: AgentBackend }> =
    [];
  for (const [flag, value] of roleModelFlags) {
    if (value === undefined) continue;
    const modelBackend = backendForModel(value);
    if (modelBackend !== backend) {
      mismatchedRoleModels.push({ flag, model: value, modelBackend });
    }
  }
  if (mismatchedRoleModels.length > 0) {
    const details = mismatchedRoleModels
      .map((m) => `${m.flag} "${m.model}" (a ${m.modelBackend} model)`)
      .join("; ");
    throw new Error(
      `backend resolved to "${backend}", but ${details} ` +
        `${mismatchedRoleModels.length === 1 ? "is" : "are"} for a different backend. ` +
        `A sandcastle run uses one backend for every role: pass matching ${backend} ` +
        `model(s), or set --backend to match.`,
    );
  }

  const roleModels = roleModelsFor({ backend });

  const implementerModel =
    explicitImplModel ??
    (provider !== undefined
      ? defaultCodingModelFor(provider)
      : roleModels.implementer.default);

  const sandbox: "docker" | "mac-host" = (() => {
    const v = values.sandbox;
    if (v === undefined) return "docker";
    if (v !== "docker" && v !== "mac-host") {
      throw new Error(
        `--sandbox: expected one of docker|mac-host, got ${JSON.stringify(v)}`,
      );
    }
    return v;
  })();

  const args: SandcastleArgs = {
    iterations: effectiveIterations,
    issue,
    repoRoot: values["repo-root"] ?? process.cwd(),
    branch: values.branch ?? detectBranchOr("HEAD"),
    label: values.label ?? LABEL_READY,
    maxConcurrent:
      parsePositiveInt(values["max-concurrent"], "--max-concurrent") ?? 3,
    plannerModel: values["planner-model"] ?? roleModels.planner.default,
    implementerModel,
    backend,
    reviewerModel: values["reviewer-model"] ?? roleModels.reviewer.default,
    critiqueModel: values["critique-model"] ?? roleModels.critique.default,
    mergerModel: values["merger-model"] ?? roleModels.merger.default,
    postMergeReviewerModel:
      values["post-merge-reviewer-model"] ?? roleModels.postMergeReviewer.default,
    recoveryModel: values["recovery-model"] ?? roleModels.recovery.default,
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
    hardCeilingSec:
      parsePositiveInt(values["hard-ceiling-sec"], "--hard-ceiling-sec") ??
      3600,
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
    sandbox,
    imageName:
      values["image-name"] ??
      defaultImageName(path.resolve(values["repo-root"] ?? process.cwd())),
    allowDirtySandcastle: values["allow-dirty-sandcastle"] === true,
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

/**
 * Role-model map for a run's agent backend (ADR 0012). Codex runs draw every
 * role — defaults, retry-ladder escalations, and the post-merge fixer — from
 * `codexModels`; everything else uses the Claude `models` map. Reading
 * escalations through this (not `models.X` directly) is what keeps a
 * `--backend codex` run from silently escalating onto a Claude model.
 */
function roleModelsFor(a: { readonly backend?: AgentBackend }) {
  return a.backend === "codex" ? codexModels : models;
}

function defaultArgs(): SandcastleArgs {
  return {
    iterations: 1,
    repoRoot: process.cwd(),
    branch: "HEAD",
    label: LABEL_READY,
    maxConcurrent: 3,
    plannerModel: models.planner.default,
    implementerModel: models.implementer.default,
    reviewerModel: models.reviewer.default,
    critiqueModel: models.critique.default,
    mergerModel: models.merger.default,
    postMergeReviewerModel: models.postMergeReviewer.default,
    recoveryModel: models.recovery.default,
    implementerTimeoutSec: 1200,
    reviewerTimeoutSec: 600,
    hardCeilingSec: 3600,
    consecutiveFailureLimit: 3,
    dryRun: false,
    recoveryEnabled: true,
    retryEnabled: true,
    stagingEnabled: true,
    imageName: defaultImageName(process.cwd()),
    allowDirtySandcastle: false,
    sandbox: "docker",
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
 *   3. <repoRoot>/.sandcastle/.env (sandcastle-specific overrides)
 *   4. <repoRoot>/.env (project-local override)
 *   5. $XDG_CONFIG_HOME/sandcastle/.env or ~/.config/sandcastle/.env
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
  sources.push({
    label: "<repoRoot>/.sandcastle/.env",
    path: path.join(repoRoot, ".sandcastle", ".env"),
  });
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
  "critique-prompt.md",
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
export function preflight(args: SandcastleArgs, opts: {
  exec?: (
    bin: string,
    args: readonly string[],
  ) => { ok: boolean; stdout?: string; stderr?: string };
  fileExists?: (p: string) => boolean;
  listMigrations?: (repoRoot: string) => string[];
  getEnv?: (key: string) => string | undefined;
} = {}): PreflightResult {
  const errors: string[] = [];
  const exec =
    opts.exec ??
    ((bin, a) => {
      try {
        // Capture stdout (the branch-base check below compares rev-parse
        // output). Other checks ignore it. stderr piped for error messages.
        const stdout = execFileSync(bin, [...a], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { ok: true, stdout };
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

  // 5. docker daemon — only required when using the docker sandbox provider.
  // The mac-host path runs no Docker commands, so skip this to avoid blocking
  // startup if Docker isn't running on the host.
  if (args.sandbox === "docker") {
    const dk = exec("docker", ["info"]);
    if (!dk.ok) errors.push(`docker info failed: ${dk.stderr ?? "unknown"}`);

    // 6. project's sandbox image exists locally. Without this check, iteration
    // 1 immediately fails with "Image '<name>' not found locally" after the
    // planner has already booted — wasted setup + confusing first-run UX on
    // any fresh worktree or post-`docker prune` machine. Catch at boot
    // instead and point the user at the build command.
    if (dk.ok) {
      const img = exec("docker", ["image", "inspect", args.imageName]);
      if (!img.ok) {
        errors.push(
          `sandbox image '${args.imageName}' not found locally. Build it with: ` +
            `node_modules/.bin/sandcastle docker build-image --image-name ` +
            `${args.imageName} --dockerfile .sandcastle/Dockerfile`,
        );
      }
    }
  }

  // 7. DATABASE_URL (or POSTGRES_URL) required when drizzle migrations exist
  // on disk. Fail at boot, not mid-iteration after a model call has already
  // burned tokens. The t3-turbo starter template sets POSTGRES_URL by default,
  // so we accept either — DATABASE_URL wins when both are set.
  const listMigrations = opts.listMigrations ?? listMigrationsOnDisk;
  const getEnv = opts.getEnv ?? ((k) => process.env[k]);
  const migrations = listMigrations(args.repoRoot);
  if (migrations.length > 0) {
    const dbUrl = (
      getEnv("DATABASE_URL") ??
      getEnv("POSTGRES_URL") ??
      ""
    ).trim();
    if (dbUrl === "") {
      errors.push(
        `Neither DATABASE_URL nor POSTGRES_URL is set, but this project has ` +
          `${migrations.length} drizzle migration file(s) on disk (e.g. ` +
          `${migrations[0]}). The migration applier will fail mid-pipeline. ` +
          `Set DATABASE_URL=... (preferred) or POSTGRES_URL=... in ` +
          `<repoRoot>/.env (project-specific) before running the loop.`,
      );
    }
  }

  // 8. Sandcastle source code dirty-check. Refuse-launch when
  // `.sandcastle/main.mts` has uncommitted modifications vs HEAD. This
  // is the discipline guard against the "patched locally but never
  // propagated upstream" failure mode that has bitten the loop twice
  // (the `.pnpm-store/` gitignore slip and the worktree pre-clean slip
  // — both shipped to consumers via in-place edits and never made it
  // back into the template). Either commit before launching, or opt
  // out with `--allow-dirty-sandcastle` (the bypass-warn at the CLI
  // entry surfaces the opt-out so it doesn't silently become habit).
  if (!args.allowDirtySandcastle) {
    // `-C args.repoRoot` is load-bearing: the default `exec` inherits
    // process.cwd() (see line ~700), but `--repo-root` is allowed to
    // diverge from cwd. Without -C, a launch from a different working
    // directory would silently check the wrong repo and either
    // false-negative (report clean) or false-positive (report dirty
    // against an unrelated repo).
    const dirty = exec("git", [
      "-C",
      args.repoRoot,
      "diff",
      "--quiet",
      "HEAD",
      "--",
      ".sandcastle/main.mts",
    ]);
    if (!dirty.ok) {
      errors.push(
        "uncommitted changes in .sandcastle/main.mts — commit before " +
          "launching (prevents 'patched locally but never propagated' " +
          "incidents). Bypass with --allow-dirty-sandcastle if you really " +
          "mean it (and own propagating the patch upstream yourself).",
      );
    }
  }

  // 9. Launch-checkout HEAD must be on the --branch tip. Worker worktrees are
  // cut from the launch checkout's CURRENT HEAD (`git worktree add` branches
  // off HEAD), NOT from --branch. If the checkout drifted off the feature
  // branch (e.g. left on an old work/next snapshot or integration-candidate),
  // every worker builds on a stale base and dependent issues HALT/conflict —
  // the affinity-tracker branch-base trap (ADR 0014). Refuse to launch on a
  // confirmed divergence rather than warn. Skip safely when the branch ref
  // doesn't resolve (brand-new branch / detached HEAD) or when stdout wasn't
  // captured (mocked exec) — only a confirmed HEAD≠tip mismatch is fatal.
  const headRev = exec("git", ["-C", args.repoRoot, "rev-parse", "HEAD"]);
  const branchRev = exec("git", [
    "-C",
    args.repoRoot,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${args.branch}`,
  ]);
  if (
    headRev.ok &&
    branchRev.ok &&
    headRev.stdout !== undefined &&
    branchRev.stdout !== undefined &&
    headRev.stdout.trim() !== "" &&
    branchRev.stdout.trim() !== "" &&
    headRev.stdout.trim() !== branchRev.stdout.trim()
  ) {
    errors.push(
      `launch checkout HEAD (${headRev.stdout.trim().slice(0, 12)}) is not on ` +
        `the --branch tip '${args.branch}' (${branchRev.stdout.trim().slice(0, 12)}). ` +
        `Worker worktrees are cut from the launch checkout's HEAD, so they ` +
        `would build on a stale base and dependent issues would fail. Run ` +
        `\`git -C ${args.repoRoot} checkout ${args.branch}\` (or pass the ` +
        `--branch you actually intend) and re-run the loop.`,
    );
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
/**
 * Serialize a `KEY → value` record back into dotenv format suitable for
 * writing as a `.env` file in the agent sandbox. Uses **single-quoted**
 * values throughout — `KEY='value'`. Why single-quoted, not double:
 *
 * - The real `dotenv` npm package (used by `dotenv-cli` and dotenv-expand)
 *   only expands `\n` and `\r` inside double-quoted values. `\\`, `\"`,
 *   and `\t` are left LITERAL. That means a naive double-quoted
 *   `WINPATH="C:\\Users\\agent"` reads back as `C:\\Users\\agent`
 *   (doubled backslashes) — silent corruption.
 * - dotenv-expand expands `$VAR` / `${VAR}` against `process.env` in
 *   both quote styles. The escape is `\$`. Without escaping, a value
 *   containing `$PATH` becomes the host's literal PATH.
 *
 * Single-quoted values are taken LITERAL by dotenv (no escape
 *   processing), and `\$` still suppresses dotenv-expand. The single
 *   restriction: dotenv has no way to embed a single quote inside a
 *   single-quoted value, so we throw on `'` (vanishingly rare in real
 *   secrets, would silently corrupt otherwise).
 *
 * Mitigating context: the orchestrator already passes every projectEnv
 * key to the container via docker `env:` → `process.env`. `dotenv-cli`
 * defaults to `override: false`, so file values do NOT clobber the
 * already-populated process.env. The file's PRIMARY job is to exist
 * so `dotenv-cli -e ../../.env` doesn't error out. Correct content is
 * a defensive backstop in case the consumer toggles `override: true`.
 */
export function serializeDotenv(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const key of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(
        `serializeDotenv: invalid key ${JSON.stringify(key)} — must match ` +
          `/^[A-Za-z_][A-Za-z0-9_]*$/`,
      );
    }
    const val = env[key]!;
    if (val.includes("'")) {
      throw new Error(
        `serializeDotenv: value for ${key} contains a single quote — not ` +
          `representable in single-quoted dotenv form`,
      );
    }
    if (/[\r\n]/.test(val)) {
      throw new Error(
        `serializeDotenv: value for ${key} contains a newline — not ` +
          `representable on one line`,
      );
    }
    // Escape `$` → `\$` so dotenv-expand doesn't substitute against the
    // process env. Inside single quotes the backslash is preserved by
    // dotenv's parser, then stripped by dotenv-expand when it sees `\$`.
    const escaped = val.replace(/\$/g, "\\$");
    lines.push(`${key}='${escaped}'`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Container env fragment carrying the long-lived Claude subscription token.
 *
 * On macOS the `claude` CLI stores its subscription OAuth token in the login
 * Keychain rather than `~/.claude/.credentials.json`, so the bind-mounted
 * `~/.claude` dir carries no credential into the Linux container and every
 * agent reports "Not logged in". A token from `claude setup-token`, exported as
 * CLAUDE_CODE_OAUTH_TOKEN, is forwarded via `containerEnv` — the only channel
 * that reliably survives into `handle.run`. Empty when unset/blank so the
 * Linux/VPS file-mount path (and API-key setups) are untouched. See ADR 0011.
 */
export function oauthTokenEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  return token && token.trim() !== ""
    ? { CLAUDE_CODE_OAUTH_TOKEN: token }
    : {};
}

/**
 * Container env fragment carrying the GitHub CLI token.
 *
 * Same macOS-Keychain class of bug as `oauthTokenEnv` (ADR 0011): on macOS the
 * `gh` CLI stores its OAuth token in the login Keychain (the keyring), NOT in
 * `~/.config/gh/hosts.yml` (which carries only the account name, no
 * `oauth_token` field). The bind-mounted `~/.config/gh` therefore reaches the
 * Linux container with no usable credential, and the container has no Keychain
 * — so every in-container `gh` call (notably the planner prompt's `!`gh issue
 * list …`` shell-expansion blocks, run by the SDK's `preprocessPrompt` via
 * `sandbox.exec`) fails with `HTTP 401: Requires authentication`.
 *
 * Forwarding `GH_TOKEN` via `containerEnv` is the only channel that crosses
 * into the container (mirrors the subscription-token fix). Empty when unset/
 * blank so the Linux/VPS path (where `gh` reads a real on-disk token from the
 * mounted config) is untouched.
 *
 * NOTE: this forwards whatever `process.env.GH_TOKEN` resolved to via
 * `loadDotenv`. A good shell export shadows the stale `~/.config/sandcastle/.env`
 * value; if launched WITHOUT exporting a fresh token, the stale `.env` value
 * would be forwarded and 401 again. Keep the host `.env` token current.
 */
export function ghTokenEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const token = env.GH_TOKEN;
  return token && token.trim() !== "" ? { GH_TOKEN: token } : {};
}

/**
 * Shell command run inside the sandbox at boot to materialize `.env` from
 * `$SANDCASTLE_PROJECT_DOTENV`. Exported so tests can assert structural
 * properties (atomic 0o600, backup-on-existing, no shell redirection)
 * without spinning up a real container.
 *
 * Behavior:
 *   1. If `.env` already exists, rename it to
 *      `.env.sandcastle-bak.<ISO-timestamp-safe>` (colons + dots in the
 *      timestamp are replaced with `-` so the filename is valid on every
 *      target FS).
 *   2. Write `process.env.SANDCASTLE_PROJECT_DOTENV` (or empty string
 *      fallback) to `.env` with `mode: 0o600` — the kernel applies the
 *      mode at create time via open(2), so there is no permissive-mode
 *      window between create and chmod.
 *
 * Implemented as `node -e` rather than shell because:
 *   - `printf %s > .env` is a shell redirect to `.env`, which the user's
 *     global CLAUDE.md forbids (RTK destroyed a `.env` on a VPS once via
 *     a similar pattern).
 *   - `chmod 600` after-create has a brief race window.
 *   - Node's `fs.writeFileSync` with `mode: 0o600` is atomic w.r.t. mode.
 *
 * Uses `require('fs')` (not ESM imports) because `node -e` doesn't do
 * ESM cleanly.
 */
export const WRITE_PROJECT_DOTENV_COMMAND =
  `node -e "` +
  `const fs=require('fs');` +
  `const p='.env';` +
  `if(fs.existsSync(p)){` +
  `const ts=new Date().toISOString().replace(/[:.]/g,'-');` +
  `fs.renameSync(p,p+'.sandcastle-bak.'+ts);` +
  `}` +
  `fs.writeFileSync(p,process.env.SANDCASTLE_PROJECT_DOTENV||'',{mode:0o600});` +
  `"`;

/**
 * onSandboxReady hook command: register the context7 docs MCP inside the
 * sandbox container at boot, so the implementer can pull live, version-correct
 * library documentation while coding.
 *
 * Why this runs *inside* the container instead of mounting host MCP config:
 *   - The loop bind-mounts the `~/.claude` *directory* but NOT the sibling
 *     `~/.claude.json` *file*, which is where user-scope MCP config actually
 *     lives — so a host-registered context7 never reaches the container.
 *   - `claude mcp add --scope user` run in-container writes the container's
 *     own `/home/agent/.claude.json`; the host config is never touched.
 *   - The key is read from `$CONTEXT7_API_KEY`, which the loop already
 *     forwards in as a docker env var (every root-`.env` key flows through
 *     `readProjectEnv` → `containerEnv`). Resolving it in the boot shell
 *     avoids any dependency on `${ENV}` expansion inside `~/.claude.json`.
 *
 * FAILS CLOSED: the whole command is guarded on a non-empty key and ends in
 * `|| true`, so a project without `CONTEXT7_API_KEY` gets graceful absence —
 * no context7, no error, no behavior change. It cannot break existing slices.
 *
 * See docs/adr/0010-context7-boot-hook.md for the full rationale (in-container
 * registration vs host mount, the fail-closed silencing tradeoff, and the
 * deliberate decision not to generalize into a "register any MCP" mechanism).
 */
export const REGISTER_CONTEXT7_MCP_COMMAND =
  `if [ -n "$CONTEXT7_API_KEY" ]; then ` +
  `claude mcp add --scope user --transport http context7 ` +
  `https://mcp.context7.com/mcp ` +
  `--header "CONTEXT7_API_KEY: $CONTEXT7_API_KEY" >/dev/null 2>&1 || true; ` +
  `fi`;

/**
 * Docker `onSandboxReady` staging command for the Codex `AGENTS.md` file. Copies
 * `.sandcastle/AGENTS.md` up to the worktree root (where Codex reads it) only
 * when the project ships our source AND has no `AGENTS.md` of its own
 * (no-clobber), then git-excludes our copy so the agent can't commit it.
 * `info/exclude` is resolved via `git rev-parse --git-path` because `.git` is a
 * FILE in a worktree (a literal path fails). FAILS CLOSED (`|| true`, ADR 0010):
 * a best-effort cosmetic copy must never abort the onSandboxReady chain. The
 * mac-host mirror is `stageCodexAgentsMdIntoWorktree` in `mac-host-sandbox.ts` —
 * keep the two in lockstep.
 */
export const STAGE_CODEX_AGENTS_MD_COMMAND =
  "if [ -f .sandcastle/AGENTS.md ] && [ ! -f AGENTS.md ]; then " +
  "cp .sandcastle/AGENTS.md AGENTS.md; " +
  'ex="$(git rev-parse --git-path info/exclude)"; ' +
  'grep -qxF AGENTS.md "$ex" 2>/dev/null || echo AGENTS.md >> "$ex"; ' +
  "fi || true";

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

/** `git branch --merged` format flag — emit short refnames (no leading "* "). */
const GIT_BRANCH_FORMAT_ARG = "--format=%(refname:short)";

/**
 * Absolute path to the dedicated staging worktree. Set by
 * `ensureStagingWorktree` during the CLI boot sequence (after preflight,
 * before `runMain`). The merger phase runs with this as its cwd so the launch
 * worktree's HEAD is never written to. Empty string when staging hasn't been
 * wired (e.g. unit tests that drive `runMain` directly without booting).
 */
let stagingWorktreePath = "";

/** Test seam: reset module-level staging path. Used by unit tests only. */
export function __setStagingWorktreePathForTests(p: string): void {
  stagingWorktreePath = p;
}

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
 * Decide the base ref the reviewer diffs against — pure (no IO) so the
 * empty-diff guard is unit-testable. The highest-stakes branch is `baseIsTip`:
 * when the merge-base equals the tip, the commit is already an ancestor of the
 * base, `git diff base..tip` is EMPTY, and the reviewer would see nothing and
 * rubber-stamp (issue #340's inverse failure). Falls back to the tip's parent
 * (`<sha>~1`, the prior single-commit behavior) for that case AND when the base
 * can't be resolved.
 */
export function resolveReviewBase(
  mergeBase: GitRunResult,
  tipSha: GitRunResult,
  commitSha: string,
): string {
  const baseOk = mergeBase.ok && mergeBase.stdout.length > 0;
  const baseIsTip = baseOk && tipSha.ok && tipSha.stdout === mergeBase.stdout;
  return baseOk && !baseIsTip ? mergeBase.stdout : `${commitSha}~1`;
}

/**
 * Stable certification token the implementer writes in the commit body when
 * the project's lint passes, and the lint-gate backstop greps for. Kept in
 * sync with implement-prompt.md by a prompt-contract rot-guard test.
 */
export const LINT_CERT_TOKEN = "SANDCASTLE-LINT: pass";
const LINT_CERT_RE = /SANDCASTLE-LINT:\s*pass\b/i;

/**
 * Does a commit-message body carry the lint pass-certification the implementer
 * is required to write (`SANDCASTLE-LINT: pass`)? Case- and spacing-insensitive;
 * `pass` must be a whole word so `SANDCASTLE-LINT: n/a` (a false "no lint
 * script" claim) does NOT satisfy it.
 */
export function commitMessageHasLintCert(message: string): boolean {
  return LINT_CERT_RE.test(message);
}

/**
 * Does the project at `repoRoot` define a non-empty `lint` script in its
 * package.json? Drives the lint-gate's dormancy — a project with no lint
 * script gets a graceful no-op, same philosophy as the critique gate. The
 * loop hardcodes pnpm, so the script (whatever it shells out to) is invoked
 * as `pnpm lint` in-sandbox by the implementer/reviewer. Fail-quiet: a
 * missing or malformed package.json reads as "no lint script" so a parse
 * error can never quarantine a slice.
 */
export function hasLintScript(repoRoot: string): boolean {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };
    const lint = pkg.scripts?.lint;
    return typeof lint === "string" && lint.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Is there a real code diff between two SHAs? True only when both refs resolve
 * (non-empty) and differ. The single source of truth for "this slice changed
 * code" — shared by the lint gate (`classifyLintCert`) and the migration/journal
 * gate in `shipAfterMigrations`, so their dormancy can never drift out of sync
 * (the two used to carry hand-written De Morgan opposites of this predicate).
 */
export function hasCodeDiff(preSha: string, postSha: string): boolean {
  return preSha !== "" && postSha !== "" && preSha !== postSha;
}

/**
 * Pure classifier for the lint-gate backstop. Given the project's lint-script
 * presence, the pre/post SHAs, and the shipped commit message (`null` when the
 * message could not be read), decide the gate status. Holding every branch in
 * one pure function — instead of the `Deps.checkLintCert` closure that does the
 * I/O — makes each dormancy case directly unit-testable, including the
 * safety-critical fail-quiet branch that must never quarantine on a git hiccup.
 *   - no `lint` script                → "dormant" (project doesn't lint)
 *   - no code diff (empty/equal SHAs) → "dormant"
 *   - message unreadable (`null`)     → "dormant" (fail-quiet: an infra/git
 *       hiccup must not quarantine a slice, cf. detectChangedLockfiles)
 *   - cert present                    → "pass"
 *   - cert absent                     → "missing" (quarantine for human triage)
 */
export function classifyLintCert(
  hasLint: boolean,
  preSha: string,
  postSha: string,
  message: string | null,
): { status: "pass" | "missing" | "dormant" } {
  if (!hasLint) return { status: "dormant" };
  if (!hasCodeDiff(preSha, postSha)) return { status: "dormant" };
  if (message === null) return { status: "dormant" };
  return commitMessageHasLintCert(message)
    ? { status: "pass" }
    : { status: "missing" };
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
 * Reset the staging worktree to the integration tip.
 *
 * The staging worktree (`<repoRoot>/.sandcastle/worktrees/staging`) is
 * permanently checked out on `integration-candidate` by design (see
 * `ensureStagingWorktree`), so we use `git reset --hard` inside that worktree
 * rather than `git branch -f` against the launch worktree. The latter failed
 * on iter 2+ when the launch worktree was still parked on
 * `integration-candidate` from the prior iteration's `git checkout` —
 * structurally impossible now that the launch worktree is never written to.
 *
 * - If staging's current tip was left by a failed iteration (caller passes
 *   `failureTagIteration > 0`), tag the tip first as `bad-merge-iter-<N>` so
 *   evidence is preserved without leaking branches.
 * - `git -C <stagingPath> reset --hard <integrationTip>` aligns the staging
 *   worktree (and its branch ref) with integration.
 *
 * Returns the integration tip SHA on success. Throws on any failure — the
 * caller is responsible for surfacing that to the outer pipeline catch.
 */
export function resetStagingToIntegrationTip(
  repoRoot: string,
  stagingPath: string,
  integrationBranch: string,
  failureTagIteration: number | null,
  log: (s: string) => void,
  logError: (s: string) => void,
): string {
  const integrationTip = resolveRefSha(repoRoot, integrationBranch);
  if (integrationTip === "") {
    throw new Error(
      `staging-reset: cannot resolve integration branch '${integrationBranch}'`,
    );
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
  // Hard-reset the staging worktree to the integration tip. Because the
  // staging worktree owns `integration-candidate`'s HEAD, no other worktree
  // can contend; this is structurally race-free.
  const reset = runGit(stagingPath, "reset", "--hard", integrationTip);
  if (!reset.ok) {
    throw new Error(
      `staging-reset: 'git -C ${stagingPath} reset --hard ${integrationTip}' failed: ${reset.stderr}`,
    );
  }
  log(`staging-reset: ${STAGING_BRANCH} → ${integrationTip.slice(0, 8)} (from ${integrationBranch})`);
  return integrationTip;
}

/**
 * Ensure a dedicated worktree exists at `<repoRoot>/.sandcastle/worktrees/staging`
 * checked out on `integration-candidate`. This is the merger's exclusive
 * workspace — the launch worktree is never written to by the loop.
 *
 * Idempotent: returns the staging path if it already exists and is valid.
 * Repairs broken state by force-removing the bad worktree and re-creating.
 *
 * Throws with a recovery instruction if the launch worktree itself is on
 * `integration-candidate` (from a previously-buggy run that left HEAD parked
 * there) — fixing that requires manual `git checkout` because git refuses to
 * create a second worktree on a branch already checked out elsewhere.
 */
export async function ensureStagingWorktree(
  repoRoot: string,
  baseBranch: string,
  log: (line: string) => void,
): Promise<string> {
  const stagingPath = path.join(repoRoot, ".sandcastle/worktrees/staging");

  // 1. If the staging path already exists, see if it's still a valid worktree
  //    on integration-candidate. If yes, fast-return. If broken, repair.
  if (existsSync(stagingPath)) {
    const head = runGit(stagingPath, "rev-parse", "--abbrev-ref", "HEAD");
    if (head.ok && head.stdout === STAGING_BRANCH) {
      log(`[staging] worktree ready at ${stagingPath}`);
      return stagingPath;
    }
    log(
      `[staging] worktree at ${stagingPath} is in unexpected state ` +
        `(HEAD=${head.ok ? head.stdout : "<unresolvable>"}); force-removing and re-creating`,
    );
    const remove = runGit(repoRoot, "worktree", "remove", "--force", ".sandcastle/worktrees/staging");
    if (!remove.ok) {
      throw new Error(
        `ensureStagingWorktree: failed to remove broken staging worktree: ${remove.stderr}`,
      );
    }
  }

  // 2. Before creating: check that integration-candidate isn't already
  //    checked out in another worktree (specifically: the launch worktree
  //    from a previously-buggy run). If it is, abort with a recovery hint.
  const list = runGit(repoRoot, "worktree", "list", "--porcelain");
  if (list.ok) {
    // Porcelain format: blocks separated by blank lines, each block has
    //   worktree <path>
    //   HEAD <sha>
    //   branch refs/heads/<name>
    const blocks = list.stdout.split("\n\n");
    for (const block of blocks) {
      const lines = block.split("\n");
      let wtPath = "";
      let branchRef = "";
      for (const ln of lines) {
        if (ln.startsWith("worktree ")) wtPath = ln.slice("worktree ".length).trim();
        else if (ln.startsWith("branch ")) branchRef = ln.slice("branch ".length).trim();
      }
      if (
        branchRef === `refs/heads/${STAGING_BRANCH}` &&
        wtPath !== "" &&
        path.resolve(wtPath) !== path.resolve(stagingPath)
      ) {
        throw new Error(
          `Launch worktree HEAD is on ${STAGING_BRANCH} (from a previously-buggy run). ` +
            `Run \`git checkout ${baseBranch}\` in the launch worktree and re-run the loop. ` +
            `See commit <this-fix-sha> for context.`,
        );
      }
    }
  }

  // 3. If integration-candidate branch doesn't exist locally, create it
  //    pointing at the base branch.
  const verify = runGit(repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${STAGING_BRANCH}`);
  if (!verify.ok) {
    const create = runGit(repoRoot, "branch", STAGING_BRANCH, baseBranch);
    if (!create.ok) {
      throw new Error(
        `ensureStagingWorktree: failed to create ${STAGING_BRANCH} branch from ${baseBranch}: ${create.stderr}`,
      );
    }
    log(`[staging] created ${STAGING_BRANCH} branch from ${baseBranch}`);
  }

  // 4. Create the worktree. `git worktree add` creates parent dirs as needed.
  //    Ensure the parent exists for completeness (older gits may not auto-mkdir).
  mkdirSync(path.dirname(stagingPath), { recursive: true });
  const add = runGit(
    repoRoot,
    "worktree",
    "add",
    ".sandcastle/worktrees/staging",
    STAGING_BRANCH,
  );
  if (!add.ok) {
    throw new Error(
      `ensureStagingWorktree: 'git worktree add' failed: ${add.stderr}`,
    );
  }
  log(`[staging] worktree ready at ${stagingPath}`);
  return stagingPath;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/**
 * Parse `git worktree list --porcelain` output. Blocks are separated by
 * blank lines; each block has `worktree <path>` and (for attached HEADs)
 * `branch refs/heads/<name>`. Detached HEADs omit the branch line.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of stdout.split(/\n\s*\n/)) {
    let wtPath = "";
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim();
    }
    if (wtPath !== "") entries.push({ path: wtPath, branch });
  }
  return entries;
}

/**
 * Fast-forward `integrationBranch` to the staging tip.
 *
 * If a worktree has `integrationBranch` checked out (typical case — the
 * launch worktree usually does), we `git merge --ff-only` inside that
 * worktree so HEAD + index + working tree all advance together. Using a
 * bare `git update-ref` here would silently strand the working tree on
 * the old snapshot — see commit history for the disk-drift incident.
 *
 * If the branch is not checked out anywhere, fall back to `update-ref`.
 *
 * Divergence fallback (audit 2026-05-30, Issue 7): when an operator
 * commits to `integrationBranch` mid-iteration, staging is no longer an
 * ancestor of integration and `--ff-only` refuses. Rather than dump the
 * recovery on a human, attempt `git merge --no-ff` on the live worktree
 * with a deterministic commit message. Real conflicts still refuse
 * (they're author work). No-worktree divergence still refuses (the
 * orchestrator's launch worktree always has integrationBranch checked
 * out in practice; auto-merging into a bare ref adds complexity for a
 * case that doesn't occur).
 *
 * Returns true on success.
 */
export function fastForwardIntegration(
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
  const listed = runGit(repoRoot, "worktree", "list", "--porcelain");
  if (!listed.ok) {
    logError(`fast-forward: worktree list failed: ${listed.stderr}`);
    return false;
  }
  const liveWorktree = parseWorktreeList(listed.stdout).find(
    (w) => w.branch === `refs/heads/${integrationBranch}`,
  );
  const ancestor = runGit(repoRoot, "merge-base", "--is-ancestor", integrationTip, stagingTip);
  if (!ancestor.ok) {
    // Divergence — try auto --no-ff merge on the live worktree.
    if (!liveWorktree) {
      logError(
        `fast-forward refused: ${integrationBranch} (${integrationTip.slice(0, 8)}) ` +
          `is not an ancestor of ${STAGING_BRANCH} (${stagingTip.slice(0, 8)}); ` +
          `no live worktree on ${integrationBranch} — auto --no-ff not possible; ` +
          `human triage required`,
      );
      return false;
    }
    const mergeMsg =
      `Sandcastle: merge ${STAGING_BRANCH} into ${integrationBranch} [auto-no-ff]`;
    const noFf = runGit(
      liveWorktree.path,
      "merge",
      "--no-ff",
      "-m",
      mergeMsg,
      stagingTip,
    );
    if (!noFf.ok) {
      // Leave no half-applied merge state — next iteration's repair logic
      // assumes the launch worktree is on a clean integrationBranch. If
      // the abort itself fails (lock contention, NFS, simultaneous git),
      // surface it loudly — the next iteration's --ff-only will refuse
      // with "you have unmerged paths" and a quiet abort failure here
      // hides the real cause.
      const abort = runGit(liveWorktree.path, "merge", "--abort");
      if (!abort.ok) {
        logError(
          `fast-forward: merge --abort in ${liveWorktree.path} failed: ` +
            `${abort.stderr.trim()}; worktree may be in a partial-merge state ` +
            `— next iteration's FF will refuse with "unmerged paths"`,
        );
      }
      logError(
        `fast-forward refused: ${integrationBranch} (${integrationTip.slice(0, 8)}) ` +
          `is not an ancestor of ${STAGING_BRANCH} (${stagingTip.slice(0, 8)}); ` +
          `auto --no-ff also failed: ${noFf.stderr.trim()}; human triage required`,
      );
      return false;
    }
    log(
      `auto --no-ff merge (via worktree in ${liveWorktree.path}): ` +
        `${STAGING_BRANCH} ${stagingTip.slice(0, 8)} → ${integrationBranch} ` +
        `(divergence resolved)`,
    );
    return true;
  }
  if (liveWorktree) {
    const ff = runGit(liveWorktree.path, "merge", "--ff-only", stagingTip);
    if (!ff.ok) {
      logError(`fast-forward: merge --ff-only in ${liveWorktree.path} failed: ${ff.stderr}`);
      return false;
    }
    log(
      `fast-forward (via worktree merge in ${liveWorktree.path}): ` +
        `${integrationBranch} ${integrationTip.slice(0, 8)} → ${stagingTip.slice(0, 8)}`,
    );
    return true;
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

/**
 * Dep-manifest files whose change leaves the host's `node_modules` stale
 * until someone runs the project's install command. Detection is on
 * basename so nested workspace lockfiles (`apps/web/package.json`) trigger
 * too. `pnpm-workspace.yaml` is included because it drives `allowBuilds`
 * / `ignoredBuiltDependencies` — changing it changes which install-scripts
 * pnpm runs, and a stale state there silently mis-builds native deps.
 * Order doesn't matter — the warning lists every match.
 */
const HOST_NODE_MODULES_LOCKFILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
] as const;

/**
 * Return the relative paths of dep-manifest files that changed between
 * `fromSha` and `toSha`. The host's `node_modules` doesn't auto-refresh
 * when a merge advances integration past such a commit, so the next
 * host-side `tsc` / `npm run x` will fail with "missing dependency"
 * errors. Audit Issue 8 (2026-05-30): lucide-react landed via the
 * sandbox's auto pnpm install, host typecheck blew up. Auto --no-ff
 * merges (Issue 7) make this strictly more frequent — operator pushes
 * that bring lockfile changes now land without a human in the loop to
 * remember the refresh.
 *
 * Fail-quiet: identical SHAs, empty SHAs, or a `git diff` error all
 * return `[]`. A missing warning beats a crashing loop.
 */
export function detectChangedLockfiles(
  repoRoot: string,
  fromSha: string,
  toSha: string,
): readonly string[] {
  if (fromSha === "" || toSha === "" || fromSha === toSha) return [];
  const res = runGit(repoRoot, "diff", "--name-only", fromSha, toSha);
  if (!res.ok) return [];
  const changed = res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return changed.filter((p) => {
    const basename = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
    return (HOST_NODE_MODULES_LOCKFILES as readonly string[]).includes(basename);
  });
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
 * Outer wall-clock watchdog around an SDK call. The SDK's own idle timer
 * resets on every output line, so an agent stuck in a trickle-output loop
 * (observed on affinity-tracker: tsc retries after a host-level OOM kills
 * the tsc child silently — the loop driver only sees the agent emit small
 * reasoning tokens forever) can hang for hours. This ceiling fires
 * regardless of output activity. The SDK accepts `signal: AbortSignal`;
 * on abort it kills the in-flight agent subprocess and rejects with the
 * signal's reason.
 *
 * Exported for unit testing. Production wiring is in {@link buildDefaultDeps}
 * which captures `args.hardCeilingSec` into a closure that calls this.
 */
export function withHardCeiling<T>(
  ceilingMs: number,
  label: string,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new Error(
        `hard ceiling: ${label} exceeded ${(ceilingMs / 1000).toFixed(0)}s wall-clock — SDK idle timer never fired (likely OOM-of-child or trickle-output hang)`,
      ),
    );
  }, ceilingMs);
  return invoke(controller.signal).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Sandbox provider construction lives in `./lib/sandbox-provider.ts` — both
// docker and mac-host implement the same uniform `SandboxProvider` shape,
// so `buildDefaultDeps` below picks one and calls `provider.topLevelRun` /
// `provider.createSandbox` without branching on the provider kind.
// ---------------------------------------------------------------------------

/**
 * Resolve the loop's run-log path and return a best-effort line appender.
 *
 * The loop's stdout/stderr is otherwise ephemeral, so after a hard death there
 * is no on-disk record of why it died — the post-mortem gap from the
 * affinity-tracker session audit. This writes every log line to a known path:
 * `<repoRoot>/.sandcastle/run.log` by default (already gitignored), or the
 * `--log-file` override, so the last run is always inspectable.
 *
 * The file is truncated once when the appender is created (one fresh log per
 * run; the post-mortem cares about the last run). Each line is flushed with
 * `appendFileSync` (no buffering) so a hard death loses nothing. All writes are
 * best-effort: a non-writable path silently disables file logging and never
 * throws, mirroring the status-store's non-fatal `onError` philosophy — a
 * log-write failure must never take the loop down.
 *
 * Exported for unit testing.
 */
export function createRunLogAppender(opts: {
  logFile?: string;
  repoRoot: string;
}): (line: string) => void {
  const target =
    opts.logFile ?? path.join(opts.repoRoot, ".sandcastle", "run.log");
  let ready = false;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, ""); // truncate once per run
    ready = true;
  } catch {
    ready = false; // non-writable path → file logging silently disabled
  }
  return (line: string): void => {
    if (!ready) return;
    try {
      appendFileSync(target, line);
    } catch {
      // best-effort; a log-write failure must never break the loop
    }
  };
}

/**
 * Build the production {@link Deps} bag — wires sandcastle.run /
 * sandcastle.createSandbox / src/state/gh.ts wrappers / src/migrations/.
 *
 * `dryRun` short-circuits claim / quarantine / markDone / comment to log-only
 * operations so a misconfigured first run can't move labels.
 */
export function buildDefaultDeps(args: SandcastleArgs): Deps {
  // pnpm install (not npm) — affinity-tracker and similar monorepos use
  // pnpm's workspace:* protocol which npm refuses to parse. The Dockerfile
  // ships `corepack enable` so `pnpm` works without an extra global install.
  // CI=true is required: without it, pnpm refuses to repair the modules
  // dir on a fresh sandbox (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY)
  // because there's no TTY to confirm. The hook runs non-interactively
  // by definition, so the install hangs/exits without restoring the
  // per-package workspace symlinks (apps/nextjs/node_modules etc.).
  // The first hook writes a `.env` file from $SANDCASTLE_PROJECT_DOTENV
  // (populated below from the host's project .env files) BEFORE pnpm
  // install runs. Why: many target repos invoke `dotenv-cli -e ../../.env`
  // to launch their dev server (e.g. apps/nextjs/package.json's `with-env`
  // script). dotenv-cli errors out on a missing file and the dev server
  // never starts → playwright bounces the iteration even when the agent's
  // code is correct. Materializing the file from env vars keeps secrets
  // out of the shell command string itself (the JS reads from the env
  // var, which docker populates over a separate channel).
  //
  // We use `node -e` instead of `printf %s > .env && chmod 600 .env` for
  // two reasons:
  //   (a) atomic 0o600 at creation — `fs.writeFileSync` with `mode: 0o600`
  //       hands the kernel the mode in the open(2) call, so there's no
  //       window where the file exists with a permissive default mode
  //       between create and chmod. The old shell pattern had a race.
  //   (b) backup-on-existing — if a project ships its own `.env` (or a
  //       previous iteration left one behind), rename it to
  //       `.env.sandcastle-bak.<ISO-timestamp>` before writing fresh so
  //       we never silently clobber operator-authored content.
  const writeProjectDotenv = {
    command: WRITE_PROJECT_DOTENV_COMMAND,
  };
  // Best-effort context7 MCP registration (fails closed without the key —
  // see REGISTER_CONTEXT7_MCP_COMMAND). Ordered before `pnpm install` because
  // it depends only on the baked-in `claude` CLI and the forwarded env var,
  // not on the project's node_modules, so it can run as soon as the box is up.
  const registerContext7Mcp = {
    command: REGISTER_CONTEXT7_MCP_COMMAND,
  };
  // Docker `onSandboxReady` hooks. mac-host never reaches sandcastle.createSandbox
  // so it carries no analogous concept; if mac-host ever grows hook support
  // it'll live in MacHostProviderConfig, not as a shared variable.
  // Codex reads AGENTS.md from the agent's cwd (the worktree root), but ours
  // ships at .sandcastle/AGENTS.md. The staging command (no-clobber, git-excluded,
  // fail-closed) is STAGE_CODEX_AGENTS_MD_COMMAND; the mac-host mirror is
  // stageCodexAgentsMdIntoWorktree. Claude/Kimi/GLM runs skip this entirely.
  // `isCodexRun` gates on the spawn model (matching the agent factory / mac-host
  // router); escalations/role defaults gate on `args.backend`. The parse-time
  // reconcile guarantees the two agree. See ADR 0012 / WS-A2.
  const isCodexRun = backendForModel(args.implementerModel) === "codex";
  const stageCodexAgentsMd = { command: STAGE_CODEX_AGENTS_MD_COMMAND };
  const dockerHooks = {
    sandbox: {
      onSandboxReady: [
        writeProjectDotenv,
        registerContext7Mcp,
        { command: "CI=true pnpm install" },
        ...(isCodexRun ? [stageCodexAgentsMd] : []),
      ],
    },
  } as const;
  const copyToWorktree = ["node_modules"];

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
  // Serialize the project's .env contents so the onSandboxReady hook can
  // write a literal .env file inside the container at boot. Doing it via
  // an env var (instead of a shell heredoc inside the hook command) keeps
  // secrets out of the command string we log. See `writeProjectDotenv`
  // above for the full rationale.
  // Subscription auth into the container: forward CLAUDE_CODE_OAUTH_TOKEN when
  // set (no-op otherwise). Required on macOS where the token lives in the
  // Keychain, not a mountable file. See oauthTokenEnv / ADR 0011.
  const containerEnv: Record<string, string> = {
    ...projectEnv,
    ...gitEnv,
    SANDCASTLE_PROJECT_DOTENV: serializeDotenv(projectEnv),
    ...oauthTokenEnv(),
    // GH_TOKEN forwarded last so a shell/host-level token wins over any stale
    // GH_TOKEN that leaked in via the target project's .env (projectEnv). On
    // macOS the gh keyring token never reaches the container via the
    // ~/.config/gh mount (Keychain-stored, not in hosts.yml) — see ghTokenEnv.
    ...ghTokenEnv(),
  };

  // Pick sandbox provider once. Both docker and mac-host implement the same
  // `SandboxProvider` shape so the methods below call provider.topLevelRun /
  // provider.createSandbox uniformly. Docker-only construction config (hooks,
  // copyToWorktree, completionSignal, copyToWorktreeMs) is baked into the
  // adapter and ignored on the mac-host path.
  const provider: SandboxProvider = buildSandboxProvider(args, containerEnv, {
    hooks: dockerHooks,
    copyToWorktree,
    copyToWorktreeMs: 600_000,
    completionSignal: [
      "<promise>COMPLETE</promise>",
      "<promise>HALT</promise>",
    ],
  });

  const dryLog = (action: string, ...rest: unknown[]): void => {
    process.stderr.write(
      `[dry-run] ${action} ${rest.map((r) => JSON.stringify(r)).join(" ")}\n`,
    );
  };

  // Sandcastle's default completion signal is `<promise>COMPLETE</promise>`.
  // We also accept `<promise>HALT</promise>` so the implementer's blocked-
  // story signal terminates cleanly — see provider config above. (Without
  // this, a HALT on iteration 1 would loop until the model token budget
  // exhausted; bit issue #83 on the 2026-05-08 smoke.)

  const ceilingMs = args.hardCeilingSec * 1000;
  const withCeiling = <T,>(
    label: string,
    invoke: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => withHardCeiling(ceilingMs, label, invoke);

  // Tee every log line to a known on-disk run log (default
  // .sandcastle/run.log, gitignored) so a hard death is diagnosable
  // post-mortem — the loop's stderr is otherwise ephemeral.
  const appendRunLog = createRunLogAppender({
    logFile: args.logFile,
    repoRoot: args.repoRoot,
  });

  return {
    async run(spec) {
      // Top-level runs (planner, merger) don't need `pnpm install` — the
      // planner just calls `gh` + reads files, the merger just runs `git
      // merge`. Provider-specific knobs (hooks, completionSignal, mounts)
      // live inside the SandboxProvider adapter — see lib/sandbox-provider.ts.
      const result = await withCeiling(
        `top-level run "${spec.name}"`,
        (signal) => provider.topLevelRun({ ...spec, signal }),
      );
      return { stdout: result.stdout, commits: result.commits };
    },
    async createSandbox(spec) {
      // Pre-clean any stale worktree from a prior killed iteration. The
      // SDK's `cp -R src dest` (`CopyToWorktree.js:29,32`) has no
      // pre-clean: if `dest` already exists, `cp -R` recurses into it,
      // building `dest/node_modules/node_modules/...` until disk
      // exhaustion. Real bug — bit affinity-tracker iteration 1 of the
      // budgeting branch. The SDK's `WorktreeManager.create()` handles a
      // missing path correctly via plain `git worktree add`, so this
      // guard hands it a clean slate. Three-tier fallback covers:
      //   1. Registered worktree (normal post-killed-iteration state)
      //      → `git worktree remove --force` clears reg + dir.
      //   2. Orphan dir git doesn't know about → `rmSync` removes it.
      //   3. Dangling registration with no dir → `git worktree prune`
      //      clears the registration so a fresh `add` succeeds.
      // Note: the mac-host provider runs its own pre-clean inside
      // `createSandbox` (see lib/mac-host-sandbox.ts:preCleanWorktree).
      // The outer pre-clean here is redundant on the mac-host path but
      // idempotent — letting it run keeps the orchestrator-side cleanup
      // contract identical across providers.
      const wtPath = path.join(
        args.repoRoot,
        worktreePathFor(spec.branch),
      );
      if (existsSync(wtPath)) {
        try {
          execFileSync(
            "git",
            ["worktree", "remove", "--force", wtPath],
            { cwd: args.repoRoot, stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch {
          rmSync(wtPath, { recursive: true, force: true });
        }
      }
      try {
        execFileSync("git", ["worktree", "prune"], {
          cwd: args.repoRoot,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        // Best-effort. If a stale registration survives, the SDK's
        // collision-reuse path (WorktreeManager.js:~120) will hit it
        // first via `listWorktrees` and then fail loudly when
        // `hasUncommittedChanges` runs `git status` inside the now-
        // missing path. The error surfaces — just not through
        // `worktree add`.
      }

      // Work around the SDK bug where createSandbox hardcodes
      // agentProviderEnv: {}, dropping per-call env injection. We bake the
      // implementer's provider env (kimi/glm creds + ANTHROPIC_BASE_URL)
      // into sandbox.env so it actually reaches the container. Anthropic
      // models return {} from envForModel (subscription path), so this is
      // a no-op for the default Anthropic case.
      const implEnv = envForModel(spec.implementerModel);
      const sandboxEnv = { ...containerEnv, ...implEnv };

      const handle = await provider.createSandbox({
        branch: spec.branch,
        mounts: spec.mounts,
        sandboxEnv,
      });
      return {
        branch: handle.branch,
        worktreePath: handle.worktreePath,
        run: async (opts) => {
          const r = await withCeiling(
            `sandbox run "${opts.name}"`,
            (signal) => handle.run({ ...opts, signal }),
          );
          // Forward the SDK's per-iteration session-capture metadata —
          // both `sessionFilePath` (when capture is wired) and `sessionId`
          // (always present for Claude agents) so the downstream consumer
          // can fall back to the conventional path layout. See
          // resolveSessionFilePath / the seam definition on RunHandle.
          return {
            stdout: r.stdout,
            commits: r.commits,
            iterations: r.iterations?.map((it) => ({
              sessionFilePath: it.sessionFilePath,
              sessionId: it.sessionId,
            })),
          };
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
    async listIssuesByLabel(label) {
      // Read-only; safe under --dry-run. The orchestrator uses this to
      // re-validate the planner's label claims host-side (SANDCASTLE.md
      // skill-discipline gate). Returns []` if there are no matches.
      return await listIssuesByLabel(label);
    },
    async listOpenIssuesWithBodies() {
      // Read-only; safe under --dry-run. Used by the "no claimable issues"
      // exit to surface `Blocked by: #N` chains.
      return await listOpenIssuesWithBodies();
    },
    async applyMigrations(repoRoot, preSha, postSha) {
      const r = await applyMigrationsBetween(repoRoot, preSha, postSha);
      return {
        applied: r.applied,
        realErrors: r.realErrors.map((e) => ({ msg: e.msg })),
      };
    },
    async validateMigrationJournal(repoRoot, preSha, postSha) {
      return await validateJournalRegistration(repoRoot, preSha, postSha);
    },
    async checkLintCert(repoRoot, preSha, postSha) {
      // Pure I/O: gather the two inputs, then delegate every status decision
      // to the pure `classifyLintCert` (directly unit-tested, including the
      // fail-quiet git-hiccup branch). An empty postSha can't be `git show`n,
      // so the message reads as null there — classifyLintCert maps it to
      // dormant either way.
      const hasLint = hasLintScript(repoRoot);
      let message: string | null = null;
      if (postSha !== "") {
        const msg = runGit(repoRoot, "show", "-s", "--format=%B", postSha);
        message = msg.ok ? msg.stdout : null;
      }
      return classifyLintCert(hasLint, preSha, postSha, message);
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
      appendRunLog(`${line}\n`);
    },
    logError(line) {
      process.stderr.write(`ERROR: ${line}\n`);
      appendRunLog(`ERROR: ${line}\n`);
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

/**
 * Extract the issue numbers a body declares it is blocked by. Recognises the
 * directive `Blocked by: #N` and the hyphenated `Blocked-by: #N`, both
 * case-insensitively, with flexible whitespace. A single line may name several
 * blockers (`Blocked by: #313, #314`); each `#N` after the directive (up to
 * the end of that line) is captured. Returns a de-duplicated, ascending list.
 *
 * ⚠️ NOT THE BLOCKER GATE. This parser only feeds `buildBlockedByNote` (the
 * advisory "nothing claimable" exit message). It does NOT decide what gets
 * dispatched, and removing it would not let a blocked issue run. Blocked
 * issues are excluded by the PLANNER AGENT, which follows HARD RULE 2 in
 * `.sandcastle/plan-prompt.md`. The enforcement lives in a prompt, not in
 * this code — see docs/adr/0013-blocker-handling.md for why.
 *
 * Exported for unit testing.
 */
export function parseBlockedBy(body: string): number[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const found = new Set<number>();
  // Match the directive, then sweep the rest of that line for `#N` tokens.
  const directive = /blocked[\s-]*by\s*:\s*([^\n\r]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = directive.exec(body)) !== null) {
    const rest = m[1] ?? "";
    const refs = rest.matchAll(/#(\d+)/g);
    for (const ref of refs) {
      const n = Number(ref[1]);
      if (Number.isInteger(n) && n > 0) found.add(n);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Build the "(note: …)" suffix for the "no claimable issues" exit (Issue E).
 *
 * Given the full set of open issues, find those labelled `ready-for-agent`
 * whose body declares `Blocked by: #N` for an `N` that is still open. Those
 * issues are why the planner returned nothing: the planner silently drops
 * blocked issues, so without this the operator can't tell "nothing ready"
 * from "everything ready is blocked".
 *
 * Openness of a blocker = membership in `openIssues` (blockers are usually
 * `in-progress`, not `ready-for-agent`, so we must consult the whole open
 * set, not a label-filtered slice). Returns `""` when nothing ready is
 * blocked — the caller then keeps the plain exit message.
 *
 * Exported for unit testing.
 */
export function buildBlockedByNote(
  openIssues: readonly { number: number; body: string; labels: readonly string[] }[],
): string {
  const openNumbers = new Set(openIssues.map((i) => i.number));
  const notes: string[] = [];
  const ready = openIssues
    .filter((i) => i.labels.includes(LABEL_READY))
    .sort((a, b) => a.number - b.number);
  for (const issue of ready) {
    const blockers = parseBlockedBy(issue.body).filter((n) =>
      openNumbers.has(n),
    );
    if (blockers.length === 0) continue;
    const blockerStr = blockers.map((n) => `#${n} (open)`).join(", ");
    notes.push(`#${issue.number} is ready-for-agent but blocked by ${blockerStr}`);
  }
  return notes.length === 0 ? "" : ` (note: ${notes.join("; ")})`;
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
  /** Skills invoked by the implementer attempt whose code actually shipped
   *  (the one whose commits are now on the branch the merger picks up).
   *  Empty for non-"ok" outcomes and for the recovery ok-path (recovery
   *  does not capture skills). Surfaced to the post-merge reviewer so the
   *  rollup audit can enforce skill discipline across the integrated set. */
  skillsInvoked?: readonly string[];
  /** True when the pipeline failed because an SDK call exceeded its idle
   *  timeout or the host's wall-clock hard ceiling fired. Surfaces stall-
   *  shaped failures to runMain's sandbox-health detector — a streak of
   *  iterations where every outcome is `stalled` indicates the sandbox
   *  itself is sick (orbstack memory pressure, docker degraded, etc.)
   *  and the loop should pause for operator intervention rather than
   *  burning more tokens. */
  stalled?: boolean;
}

/**
 * Returns the subset of `candidateBranches` that are reachable from `launchBranch`
 * — i.e. branches whose tips git considers merged. Always prefer this over
 * trusting the merger's output text: a partial merger (some conflicts skipped)
 * can report success while leaving branches unmerged.
 *
 * Read-only — never mutates repo state.
 */
export function verifyLandedBranches(
  repoRoot: string,
  launchBranch: string,
  candidateBranches: readonly string[],
  warn: (msg: string) => void,
): readonly string[] {
  if (candidateBranches.length === 0) return [];
  let mergedOutput: string;
  try {
    mergedOutput = execFileSync(
      "git",
      ["branch", "--merged", launchBranch, GIT_BRANCH_FORMAT_ARG],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (err) {
    warn(
      `verifyLandedBranches: git branch --merged ${launchBranch} failed: ${(err as Error).message}`,
    );
    return [];
  }
  const mergedSet = new Set(
    mergedOutput
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  return candidateBranches.filter((b) => mergedSet.has(b));
}

// worktreePathFor lives in `./lib/worktree-path.ts` (imported at top of file
// so mac-host-sandbox.ts can import it without depending on this 4k-line
// orchestrator). Re-exported here so external consumers of main.mjs keep
// working.
export { worktreePathFor };

/**
 * Per-branch cleanup for the sandcastle loop.
 *
 * Side effects: removes the sub-worktree at
 * `.sandcastle/worktrees/<wtName>` AND deletes the local branch
 * `<branch>`. Both are mutations on the repo at `repoRoot`.
 *
 * Order is LOAD-BEARING — `git worktree remove` MUST run before
 * `git branch -d`. Reverse order silently no-ops: `git branch -d`
 * refuses to delete a branch that is currently checked out in ANY
 * worktree, and our setup always has the branch checked out in its
 * sub-worktree. Do NOT add a "branch only" fast path.
 *
 * `--force` is a FALLBACK ONLY. First try a clean `git worktree
 * remove <path>`. Escalate to `--force` only when (a) the clean
 * remove fails AND (b) `git status --porcelain` inside the worktree
 * is empty (i.e. the working tree is clean and git is just being
 * cautious about something benign like a dangling registration).
 *
 * The branch delete uses SHA-pinned `git update-ref -d` rather than
 * `git branch -d`. `branch -d` performs its own HEAD-based merge
 * check internally, which has the same false-negative as the old
 * pre-check whenever repoRoot's HEAD isn't on `launchBranch`. The
 * two-step safety net (pre-check merged-status against `launchBranch`,
 * then `update-ref -d <ref> <expected-sha>`) provides equivalent
 * guarantees: merge-safety from the pre-check, ref-race-safety from
 * the SHA pin. Never `branch -D` — that's an unguarded escalation.
 *
 * Best-effort: never throws. Returns one of:
 *   "ok"                       — both steps succeeded
 *   "skipped-unmerged"         — branch isn't reachable from launchBranch
 *   "skipped-worktree-error"   — worktree remove failed AND we
 *                                couldn't proceed to branch delete
 *   "skipped-branch-error"     — worktree removed but branch delete
 *                                had an unexpected error
 *
 * The caller emits the result to logs and proceeds to the next branch.
 */
export function cleanupIssueBranch(
  repoRoot: string,
  branch: string,
  launchBranch: string,
  warn: (msg: string) => void,
):
  | "ok"
  | "skipped-unmerged"
  | "skipped-worktree-error"
  | "skipped-branch-error" {
  const wtPath = worktreePathFor(branch);

  // Step 1: worktree remove (clean first, --force only on clean-but-busy).
  try {
    execFileSync("git", ["worktree", "remove", wtPath], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err1) {
    // Clean remove failed. Try --force only if the working tree is clean.
    let canForce = false;
    try {
      const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: path.join(repoRoot, wtPath),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      canForce = status.trim().length === 0;
    } catch {
      // Worktree dir or registration missing; let prune handle it below.
    }
    if (canForce) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", wtPath], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch (err2) {
        warn(
          `worktree remove --force ${wtPath} failed: ${(err2 as Error).message}`,
        );
        return "skipped-worktree-error";
      }
    } else {
      // Try a prune in case the registration is just dangling, then retry.
      try {
        execFileSync("git", ["worktree", "prune"], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        // ignore — prune is best-effort
      }
      // Issue D: after prune, decide whether the worktree is genuinely still
      // registered. If `prune` already cleared a dangling registration, the
      // worktree is effectively gone and the retry-remove below would fail
      // with "not a working tree" — a misleading warn. Only retry (and warn
      // on failure) when the registration actually survived the prune.
      //
      // We match by branch ref (not by path): `git worktree list --porcelain`
      // reports realpath'd absolute paths, so a path comparison would
      // mis-classify under macOS symlinks (/var → /private/var in tmpdirs)
      // and silently suppress every warn. Branch-ref is an exact string and
      // there's a 1:1 branch↔worktree mapping here. If the list itself fails,
      // default to "still registered" so we fail toward surfacing the warn,
      // not hiding it.
      let stillRegistered = true;
      try {
        const listed = execFileSync(
          "git",
          ["worktree", "list", "--porcelain"],
          { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        stillRegistered = parseWorktreeList(listed).some(
          (e) => e.branch === `refs/heads/${branch}`,
        );
      } catch {
        stillRegistered = true;
      }
      if (stillRegistered) {
        try {
          execFileSync("git", ["worktree", "remove", wtPath], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
          });
        } catch {
          warn(`worktree remove ${wtPath} failed: ${(err1 as Error).message}`);
          // Continue to branch delete anyway — registration may be gone already.
        }
      }
      // else: prune already cleaned it — fall through to branch delete with no warn.
    }
  }

  // Step 2: SHA-pinned branch delete.
  //
  // Pre-check merge status against `launchBranch` (NOT HEAD): the
  // pipeline calls us from `args.repoRoot`, where HEAD usually matches
  // the launch branch but doesn't have to. The FF step
  // (`fastForwardIntegration`) falls back to `git update-ref` when the
  // launch branch isn't checked out anywhere, which leaves repoRoot's
  // HEAD pointed at some other branch. Using HEAD here would falsely
  // report "not merged" and skip cleanup of branches that DID land.
  //
  // We then delete via SHA-pinned `update-ref -d` rather than
  // `branch -d`, because `branch -d` performs the same HEAD-based
  // merge check internally — i.e. it has the same bug we just fixed
  // in the pre-check. The SHA pin keeps the "don't clobber a
  // concurrently-moved ref" safety that `branch -d` would otherwise
  // provide. Together the pre-check (merge-safety) and the SHA pin
  // (ref-race-safety) match what plain `branch -d` gave us when HEAD
  // was guaranteed to be on launchBranch.
  // Verify the branch actually exists locally before trying merge-checks.
  // A missing branch != unmerged — distinguish so the warn is accurate.
  let branchSha = "";
  try {
    branchSha = execFileSync(
      "git",
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    warn(`branch ${branch} does not exist locally; nothing to delete`);
    return "skipped-branch-error";
  }
  let isMerged = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, launchBranch], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
    isMerged = true;
  } catch {
    isMerged = false;
  }
  if (!isMerged) {
    warn(
      `branch delete ${branch} refused: not fully merged into ${launchBranch}`,
    );
    return "skipped-unmerged";
  }
  try {
    execFileSync(
      "git",
      ["update-ref", "-d", `refs/heads/${branch}`, branchSha],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return "ok";
  } catch (err) {
    warn(`update-ref -d ${branch} failed: ${(err as Error).message}`);
    return "skipped-branch-error";
  }
}

interface PipelineCtx {
  readonly args: SandcastleArgs;
  readonly deps: Deps;
  readonly iteration: number;
  readonly issueNumber: number;
  readonly issue: PlanIssue;
  /**
   * Pre-computed required `Skill()` invocations for this issue's `type:X`
   * label, looked up by the orchestrator from the parsed `SANDCASTLE.md`
   * map. `undefined` when SANDCASTLE.md doesn't exist OR the issue's
   * `type:X` label has no matching section (graceful degradation rule).
   * `[]` when the type explicitly requires nothing (e.g. `type:cleanup`).
   * Threaded into {@link runImplementer} (and the post-merge fixer
   * union-set) so the skill-discipline gate can fail-fast on omissions.
   */
  readonly requiredSkills?: readonly string[];
  /**
   * The issue's `type:X` label (e.g. `type:new-component`). Threaded into the
   * critique sub-agent at ship time so it can look up the right rubric in
   * SANDCASTLE.md. `undefined` when the issue has no type label or when
   * SANDCASTLE.md doesn't list the type — critique is skipped in that case.
   */
  readonly typeLabel?: string;
  /**
   * Status-feed store for the `sandcastle-watch` viewer. Constructed once in
   * {@link runMain} (after the single-instance lock) and threaded per-issue so
   * the pipeline can publish phase transitions. Every method is synchronous and
   * non-fatal — a write failure routes to `deps.logError` and never throws.
   */
  readonly status: StatusStore;
}

export async function runImplementer(
  sb: SandboxHandle,
  ctx: PipelineCtx,
  opts: {
    // Attempt index: 1 = first pass, ≥2 = retry rounds. Dynamic now that the
    // critique retry cap is configurable (CRITIQUE_MAX_RETRIES), so a plain
    // number rather than a fixed 1|2|3 literal union. Used only in comparisons
    // / the ATTEMPT_NUMBER prompt arg — never as an index.
    attemptNumber?: number;
    model?: string;
    reviewerFeedback?: string;
    critiqueFeedback?: string;
    /**
     * Required principle names for the issue's `type:X` label, looked up by
     * the orchestrator from the parsed `SANDCASTLE.md` map and threaded in
     * per-issue. Two consumers:
     *
     *   1. Surfaced to the implementer prompt as `{{REQUIRED_SKILLS}}` (see
     *      `promptArgs` below) so STEP 0 of `.sandcastle/implement-prompt.md`
     *      can instruct the model to invoke `Skill(<name>)` for each
     *      principle BEFORE writing code.
     *
     *   2. Validated post-run against the host-extracted `skillsInvoked`
     *      list — if any required principle wasn't invoked, throws
     *      {@link MissingRequiredSkillsError} which the orchestrator's
     *      catch handler maps to `skill-discipline-fail` quarantine.
     *
     * Re-promoted from telemetry-only WARN (v1 demotion) back to hard throw
     * per ADR 0006 v3. The prompt-side linkage was added in v3.2 after the
     * v3 hard throw quarantined legitimate slices because the prompt never
     * told the model the rules changed.
     *
     * `undefined` (no SANDCASTLE.md or unknown `type:` label) → gate is a
     * no-op AND `REQUIRED_SKILLS` placeholder gets ""; `[]` (e.g.
     * `type:cleanup` requires none) → same no-op result.
     */
    requiredSkills?: readonly string[];
    /**
     * One-shot guard for the missing-envelope re-ask (audit #22). When the
     * implementer emits a real STORY_COMPLETE (not a `<rebuttal>`, not a
     * HALT) but drops the REQUIRED fenced ```json``` certification envelope,
     * `parseVerdict` throws {@link VerdictParseError} — a class neither
     * `isTransientError` nor `STALL_RE` covers, so the whole pass would be
     * wasted (recovery burn → quarantine, or immediate quarantine under
     * `--recovery off`). Instead we re-run the implementer ONCE with a terse
     * appended instruction surfaced via the `{{ENVELOPE_REASK}}` prompt
     * placeholder.
     *
     * `false`/`undefined` (default) on the FIRST pass → on a genuine
     * missing-envelope failure, recurse once with this flag set `true`.
     * `true` → this IS the re-ask: the `{{ENVELOPE_REASK}}` placeholder is
     * populated AND a second missing-envelope failure propagates as before
     * (the boolean can never recurse more than once). Mirrors the
     * single-retry discipline of `retryOnStall` in `runPostMergeReviewer`.
     */
    envelopeReask?: boolean;
  } = {},
): Promise<{
  commits: readonly { sha: string }[];
  stdout: string;
  skillsInvoked: readonly string[];
}> {
  const attemptNumber = opts.attemptNumber ?? 1;
  // Attempt 2 may legitimately produce zero new commits if the implementer
  // emits a <rebuttal> block instead of writing code. Attempt 1 must commit.
  const requireCommits = attemptNumber === 1;
  const primaryModel = opts.model ?? ctx.args.implementerModel;
  // On attempt 1, allow a one-hop fallback to escalations[0] when the primary
  // throws a rate-limit error. Attempt 2 is already on the escalation, so no
  // further fallback — it just throws and the pipeline catch handles it.
  const fallbackModel =
    attemptNumber === 1
      ? roleModelsFor(ctx.args).implementer.escalations[0]
      : undefined;
  const r = await runWithRateLimitFallback(
    (model) =>
      sb.run({
        name:
          attemptNumber === 1
            ? "implementer"
            : opts.critiqueFeedback !== undefined
              ? "implementer-critique-retry"
              : attemptNumber === 3
                ? "implementer-retry-2"
                : "implementer-retry",
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
          CRITIQUE_FEEDBACK: opts.critiqueFeedback ?? "",
          // Per ADR 0006 v3.2: the skill-discipline gate is a hard throw
          // (v3 re-promotion). The implementer prompt's STEP 0 reads this
          // placeholder and instructs the model to invoke Skill(<name>) for
          // each principle BEFORE writing code. Empty string when undefined
          // (no SANDCASTLE.md or unknown type:label) so the prompt's
          // conditional block can detect "gate disabled for this slice"
          // without templating errors.
          REQUIRED_SKILLS: opts.requiredSkills?.join(", ") ?? "",
          // Audit #22: populated ONLY on the one-shot re-ask after the
          // implementer dropped the fenced ```json``` certification envelope
          // before STORY_COMPLETE. Empty string on the normal first pass so
          // the prompt's conditional block stays inert. The placeholder lint
          // (tests/lint-placeholders.test.ts) requires {{ENVELOPE_REASK}} in
          // implement-prompt.md to have this matching key.
          ENVELOPE_REASK: opts.envelopeReask
            ? "Your previous final message ended without the REQUIRED fenced " +
              "```json``` certification envelope before STORY_COMPLETE. " +
              "Do NOT redo any work — your commits are already on the branch. " +
              "Re-emit ONLY your final message, ending with the json envelope " +
              "followed by the STORY_COMPLETE marker."
            : "",
        },
      }),
    primaryModel,
    fallbackModel,
    ctx.deps.log,
    `implementer (issue=${ctx.issueNumber})`,
    "implementer",
  );
  // Extract Skill() invocations from the SDK's captured session JSONL — see
  // extractSkillInvocationsFromSession for why we cannot use the SDK's
  // `onAgentStreamEvent` callback for this (the AgentProvider allowlist
  // silently drops every Skill tool_use block). We walk each iteration's
  // sessionFilePath so primary and fallback attempts (and any
  // multi-iteration runs) all contribute, in the order the implementer
  // invoked them. Missing iterations array (legacy test mocks) yields [].
  const skillsInvoked: string[] = [];
  for (const it of r.iterations ?? []) {
    // Backend-aware (ADR 0012): for Codex iterations this resolves the
    // ~/.codex rollout and parses skill-reads; for Claude it walks the
    // ~/.claude session JSONL as before. primaryModel reflects this run's
    // backend (all iterations share it).
    for (const name of await resolveAndExtractSkillInvocations(it, primaryModel)) {
      skillsInvoked.push(name);
    }
  }
  // Per-issue skill-discipline gate — RE-PROMOTED to a hard throw per
  // ADR 0006 v3. Original v1 demotion to telemetry assumed critique-as-gate
  // fully replaced this check, but empirical log analysis (see
  // docs/adr/0006-v3-supporting-analysis.md) showed critique silently
  // abstains on issues whose required principles lack SKILL.md rubric files
  // on disk — real regressions shipped via that path. Critique covers a
  // subset, not a superset, of what skill-discipline catches; the two layers
  // are complementary, not redundant. The post-merge-fixer gate (separate
  // call site) intentionally stays as WARN-only because the per-issue gate
  // already covered each diff before rollup.
  //
  // Known cost: this gate is process-gating and gameable — the implementer
  // can ritually emit Skill() calls without applying any guidance.
  // Critique-as-gate is the outcome-gating layer that grades the actual
  // diff. Two-gate is more robust than either alone: implementer must
  // invoke Skill() AND the diff must pass critique AND the rubric must
  // be loadable.
  if (opts.requiredSkills && opts.requiredSkills.length > 0) {
    const { missing } = validateRequiredSkillsInvoked(
      opts.requiredSkills,
      skillsInvoked,
    );
    if (missing.length > 0) {
      throw new MissingRequiredSkillsError(
        missing,
        skillsInvoked,
        opts.requiredSkills,
        ctx.issueNumber,
      );
    }
  }
  if (requireCommits && r.commits.length === 0) {
    throw new Error("implementer made no commits");
  }
  // Sandcastle's r.stdout is the parsed `result.result` from claude's final
  // stream event — already-extracted assistant text, NOT raw stream-json
  // envelopes. The frozen v1 references at archive/loop/agents.ts and archive/planner/planner.ts both
  // handle this with a dual-mode try (stream-json first, then fall back to
  // `alreadyAssistantText: true`). Without the fallback every implementer
  // run throws "no assistant text could be extracted" and triggers recovery,
  // doubling the per-issue Opus spend. Mirror the established pattern.
  //
  // The envelope is only required for STORY_COMPLETE (normal success).
  // Two paths legitimately skip it:
  //   - Attempt 2 with a <rebuttal>...</rebuttal> block (implementer
  //     disagrees with the reviewer; caller handles rebuttal extraction).
  //   - Any attempt that ends in HALT (per implement-prompt step 8 —
  //     HALT only requires `<promise>HALT</promise>`, no JSON envelope).
  //     Without this gate, parseVerdict throws on every HALT and the
  //     pipeline mis-classifies a clean HALT as an envelope-missing
  //     failure, burning a recovery pass.
  const rebuttalPresent = attemptNumber >= 2 && extractRebuttal(r.stdout) !== "";
  const halted = (() => {
    try {
      return extractMarker(r.stdout, IMPLEMENTER_MARKERS) === "HALT";
    } catch {
      return false;
    }
  })();
  if (!rebuttalPresent && !halted) {
    // Dual-mode parse (stream-json first, assistant-text fallback). On a
    // genuine missing-envelope failure — the implementer emitted a real
    // STORY_COMPLETE but dropped the fenced ```json``` certification
    // envelope — both attempts raise VerdictParseError. That class is NOT
    // covered by isTransientError / STALL_RE, so without intervention the
    // whole pass is wasted (recovery burn → quarantine, or immediate
    // quarantine under --recovery off). Re-ask the implementer ONCE for just
    // the envelope (audit #22), guarded by opts.envelopeReask so it can
    // never recurse more than once. We catch VerdictParseError ONLY
    // (instanceof) — any other thrown class (and the second re-ask failure)
    // propagates unchanged, exactly as before.
    let parseErr: unknown = null;
    try {
      parseVerdict(r.stdout, ImplementerOutputSchema);
    } catch {
      try {
        parseVerdict(r.stdout, ImplementerOutputSchema, {
          alreadyAssistantText: true,
        });
      } catch (err2) {
        parseErr = err2;
      }
    }
    if (parseErr !== null) {
      if (parseErr instanceof VerdictParseError && !opts.envelopeReask) {
        ctx.deps.logError(
          `implementer (issue=${ctx.issueNumber}) emitted STORY_COMPLETE ` +
            `without the required json envelope — re-asking once for the envelope`,
        );
        return runImplementer(sb, ctx, { ...opts, envelopeReask: true });
      }
      throw parseErr;
    }
  }
  return { ...r, skillsInvoked };
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

/** A single category's outcome in the reviewer's CATEGORY SWEEP block. */
export type SweepStatus = "ok" | "n/a" | "finding";

/**
 * Parse the reviewer's CATEGORY SWEEP block. The block appears between
 * a line that IS exactly `CATEGORY SWEEP:` and one that starts with
 * `SWEEP COMPLETE.`. One bullet per category:
 * `- Spec fit: ok` / `- Spec fit: n/a (...)` / `- Spec fit: <finding text>`.
 * Returns a Map keyed on the lowercased, trimmed category name. Returns
 * null when the block is missing, empty, or unparsable — callers fall
 * back to (non-sweep-aware) behavior on null. This conservative fallback
 * matters: a malformed sweep should never accidentally grant extra retries.
 *
 * Classification is INTENTIONALLY strict (not permissive):
 * - `ok` only matches when the value is exactly `ok`, `ok.`, or `ok
 *   (parenthetical)`. A value like `ok — actually there's a bug` is a
 *   finding, NOT ok. An LLM reviewer that hedges with a leading `ok`
 *   should not get its real complaint silently classified resolved.
 * - `n/a` only matches when followed by `.`, end-of-string, or `(...)`.
 *   Same rationale.
 * - The placeholder-skip only matches the literal template emitted by
 *   the reviewer prompt (`<ok | n/a (...) | <finding>>`). A reviewer
 *   using `<one-line finding>` notation is treated as a real finding,
 *   not as an unfilled template.
 */
export function extractCategorySweep(
  stdout: string,
  logError: (msg: string) => void = () => {},
): Map<string, SweepStatus> | null {
  // Anchor both markers to a line start so a prose mention like
  // "the CATEGORY SWEEP: block below" doesn't shift the parse window.
  // Header / terminator detection is case-insensitive and tolerates
  // surrounding markdown emphasis (`**`, `__`, backticks) and an
  // optional space before the colon — reviewers paste bolded headers
  // surprisingly often.
  const isHeader = (line: string) =>
    /^[*_`]*\s*category\s+sweep\s*:\s*[*_`]*\s*$/i.test(line.trim());
  const isTerminator = (line: string) =>
    /^[*_`]*\s*sweep\s+complete\s*\.\s*[*_`]*\s*$/i.test(line.trim());

  const lines = stdout.split(/\r?\n/);
  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (startIdx < 0 && isHeader(lines[i]!)) {
      startIdx = i;
    } else if (startIdx >= 0 && isTerminator(lines[i]!)) {
      endIdx = i;
      break;
    }
  }
  if (startIdx < 0 || endIdx < 0) return null;
  const out = new Map<string, SweepStatus>();
  // Severity ranking for the strictest-wins duplicate-category rule.
  const rank: Record<SweepStatus, number> = {
    finding: 2,
    "n/a": 1,
    ok: 0,
  };
  // Recognised template placeholders (left verbatim by a reviewer that
  // didn't fill the line in). Anything else inside `<...>` is treated as
  // a compact finding.
  const TEMPLATE_PLACEHOLDERS = new Set([
    "<ok | n/a (...) | <finding>>",
    "<ok | n/a (…) | <finding>>",
    "<ok|n/a(...)|<finding>>",
  ]);
  for (let i = startIdx + 1; i < endIdx; i += 1) {
    // Split the bullet on its LAST `: ` so category names containing a
    // colon (e.g. `Type safety (RFC: 1234): ok`) parse correctly. The
    // status token never contains `: ` because we strip the bullet body
    // first and only the trailing status remains.
    const bulletMatch = /^\s*-\s*(.+)$/.exec(lines[i]!);
    if (!bulletMatch) continue;
    const body = bulletMatch[1]!;
    const lastColon = body.lastIndexOf(": ");
    if (lastColon < 0) continue;
    const rawCategory = body.slice(0, lastColon);
    const valRaw = body.slice(lastColon + 2).trim();
    if (TEMPLATE_PLACEHOLDERS.has(valRaw.toLowerCase())) continue;
    // Strip surrounding markdown emphasis from the category name before
    // lowercasing. `**Spec fit**` → `spec fit`.
    const category = rawCategory
      .replace(/^[\s*_`]+|[\s*_`]+$/g, "")
      .toLowerCase();
    if (category.length === 0) continue;
    const valLower = valRaw.toLowerCase();
    let status: SweepStatus;
    if (valLower === "ok" || valLower === "ok.") {
      status = "ok";
    } else if (/^ok\s*\(.*\)\.?$/i.test(valRaw)) {
      // `ok (parenthetical explanation)` — still ok.
      status = "ok";
    } else if (valLower === "n/a" || valLower === "n/a.") {
      status = "n/a";
    } else if (/^n\/a\s*\(.*\)\.?$/i.test(valRaw)) {
      status = "n/a";
    } else {
      status = "finding";
    }
    // Duplicate-category resolution: strictest wins. If the existing
    // status outranks (or matches) the new one, keep existing; otherwise
    // replace. Either way, log the conflict — duplicate category lines
    // are a reviewer-prompt-violation that should surface to operators.
    if (out.has(category)) {
      const existing = out.get(category)!;
      if (rank[status] > rank[existing]) {
        logError(
          `category=${JSON.stringify(category)} ` +
            `existing=${existing} new=${status} — strictest-wins replaces existing`,
        );
        out.set(category, status);
      } else {
        logError(
          `category=${JSON.stringify(category)} ` +
            `existing=${existing} new=${status} — strictest-wins keeps existing`,
        );
      }
      continue;
    }
    out.set(category, status);
  }
  return out.size > 0 ? out : null;
}

/**
 * Decide whether the implementer demonstrably resolved every category
 * the reviewer flagged in round 1. Returns true iff round 1 had at
 * least one structured finding AND every such finding is now "ok" or
 * "n/a" in round 2. When true, round 2's HAS_BLOCKERS findings are
 * genuinely new -- round 1's complaints got fixed and the reviewer
 * surfaced a different bug. The loop grants a third attempt instead
 * of waking the user.
 *
 * An empty sweep1 (zero "finding" entries) is NOT evidence of progress:
 * the reviewer emitted HAS_BLOCKERS in round 1, so something was wrong,
 * but the sweep didn't classify it. Granting a third attempt on that
 * basis would be a vacuous freebie. Deny instead.
 *
 * Conservative on missing data: a category that was a finding in round 1
 * but is absent from round 2's sweep counts as unresolved.
 */
export function priorFindingsResolved(
  sweep1: ReadonlyMap<string, SweepStatus>,
  sweep2: ReadonlyMap<string, SweepStatus>,
): boolean {
  let sawRound1Finding = false;
  for (const [cat, status] of sweep1.entries()) {
    if (status !== "finding") continue;
    sawRound1Finding = true;
    const next = sweep2.get(cat);
    if (next === undefined) return false;
    if (next === "finding") return false;
  }
  // Vacuous case: round 1 had no structured findings to clear, so we
  // have no positive evidence of progress -- deny the grant.
  if (!sawRound1Finding) return false;
  return true;
}

/**
 * Diagnose why the third-attempt grant was denied. Returns a short
 * human-readable reason that operators auditing a quarantine can read
 * in the log to understand which of the four denial paths tripped.
 * Used purely for logging; the gate decision itself runs on the
 * returned boolean from `priorFindingsResolved`.
 */
export function thirdAttemptDenyReason(
  sweep1: ReadonlyMap<string, SweepStatus> | null,
  sweep2: ReadonlyMap<string, SweepStatus> | null,
): string {
  if (sweep1 === null) return "sweep1 unparsable";
  if (sweep2 === null) return "sweep2 unparsable";
  // Re-derive: any round-1 finding category that is still a finding
  // (or absent) in round 2 is the recurring blocker.
  for (const [cat, status] of sweep1.entries()) {
    if (status !== "finding") continue;
    const next = sweep2.get(cat);
    if (next === undefined) {
      return `category ${JSON.stringify(cat)} was a round-1 finding but is absent from round-2 sweep`;
    }
    if (next === "finding") {
      return `category ${JSON.stringify(cat)} was a finding in both rounds (recurring blocker)`;
    }
  }
  // No recurring blocker found -- the only remaining denial cause is
  // an empty sweep1 (no structured findings to clear).
  return "round-1 sweep had zero structured findings (vacuous)";
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

/**
 * Stall-shape error matcher. An error message matches when the underlying
 * failure was the sandbox going unresponsive (SDK idle timer firing, host
 * wall-clock watchdog firing, or a node-level ETIMEDOUT on supporting
 * calls) — distinct from a code-level failure like "reviewer marked
 * HAS_BLOCKERS" or "test assertion failed". Used in two places:
 *   1. The per-issue pipeline catch (around runIssuePipeline) sets
 *      IssueOutcome.stalled when this matches the thrown error.
 *   2. The outer runMain loop checks per-iteration rejection reasons
 *      against the same regex so pre-pipeline failures (claim hangs,
 *      etc.) also count toward the stall streak.
 * Kept as a single module constant so the two call sites can't drift.
 *
 * Patterns:
 *   - "hard ceiling"            — withHardCeiling watchdog (see line ~1449)
 *   - "agent idle for"          — SDK AgentIdleTimeoutError message stem
 *                                  (`Agent idle for N seconds — no output
 *                                  received`, see Orchestrator.js line ~34)
 *   - "AgentIdleTimeoutError"   — SDK error tag, in case the message text
 *                                  changes upstream but the class name stays
 *   - "no output received"      — secondary SDK phrase, defensive
 *   - "ETIMEDOUT"               — node net-level timeout (rare here)
 */
const STALL_RE =
  /hard ceiling|agent idle for|AgentIdleTimeoutError|no output received|ETIMEDOUT/i;

/** Test-only: clear module-level transient-state maps. Production never calls
 * this; tests use it in `beforeEach` so prior tests' fallback-breaker or
 * defer-counter state can't bleed into ordering-sensitive cases. */
export function __resetTransientStateForTests(): void {
  fallbackHistory.clear();
  deferralCounts.clear();
  stagingWorktreePath = "";
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
  opts: {
    implementerRebuttal?: string;
    name?: string;
    skillsInvoked?: readonly string[];
  } = {},
): Promise<{ marker: string; stdout: string }> {
  const primaryModel = model ?? ctx.args.reviewerModel;
  // Only the default reviewer pass gets a rate-limit fallback. The escalated
  // reviewer-retry pass (already on escalations[0]) has no further fallback.
  const fallbackModel =
    primaryModel === ctx.args.reviewerModel
      ? roleModelsFor(ctx.args).reviewer.escalations[0]
      : undefined;
  const skillsInvoked = opts.skillsInvoked ?? [];
  // Review the whole branch vs its fork point, not just the tip commit's
  // delta (issue #340 false-quarantined a WIP+final-commit branch). Computed
  // on the HOST where full history is reliable (the sandbox worktree shares
  // repoRoot's .git, so both refs resolve here), then passed as a concrete SHA
  // so the in-prompt `git diff` runs against two tip-reachable objects and can
  // never exit non-zero — a failing bang-command crashes the entire review.
  const mergeBase = runGit(
    ctx.args.repoRoot,
    "merge-base",
    ctx.args.branch,
    commitSha,
  );
  const tipSha = runGit(ctx.args.repoRoot, "rev-parse", commitSha);
  const reviewBase = resolveReviewBase(mergeBase, tipSha, commitSha);
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
          REVIEW_BASE: reviewBase,
          BRANCH: ctx.issue.branch,
          IMPLEMENTER_REBUTTAL: opts.implementerRebuttal ?? "",
          SKILLS_INVOKED:
            skillsInvoked.length === 0
              ? "(none invoked)"
              : skillsInvoked.join(", "),
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
  diagnoseHint = "",
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
        DIAGNOSE_HINT: diagnoseHint,
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
/**
 * Issue F: which prompt-leg path an issue traversed to its terminal outcome.
 * Partitioned by the reviewer-pass that decided the outcome (the three exit
 * boundaries the loop has):
 *   - `first-pass-only`  — shipped on reviewer attempt 1's ALL_CLEAR, no retry
 *   - `critique-retry`   — decided by reviewer attempt 2 (ship OR escalated-
 *                          retry quarantine), i.e. the HAS_BLOCKERS → implementer
 *                          attempt 2 → reviewer attempt 2 leg
 *   - `implementer-retry` — decided by the round-3 grant (implementer attempt 3
 *                          → reviewer attempt 3, ship OR quarantine)
 *
 * Note (intentional): every reviewer-attempt-2 exit also ran implementer
 * attempt 2, so "critique-retry" and "implementer-retry" overlap on the fact
 * that an implementer retry happened. We partition by the deciding reviewer
 * pass (the exit boundary) rather than by "did an implementer retry run", so
 * each terminal outcome carries exactly one path token.
 */
type PromptLegPath = "first-pass-only" | "critique-retry" | "implementer-retry";

const CRITIQUE_MARKERS = [
  "CRITIQUE_CLEAN",
  "CRITIQUE_NEEDS_FIXES",
  "CRITIQUE_CRITICAL",
] as const;
type CritiqueVerdict = (typeof CRITIQUE_MARKERS)[number];

// Max implementer↔critique retry rounds before a NEEDS_FIXES verdict
// quarantines (ADR 0014). Raised 1→2: a single retry parked too many
// salvageable visual/copy slices at needs-human (affinity-tracker #454/#470).
// The path is first-pass → retry → retry → quarantine.
const CRITIQUE_MAX_RETRIES = 2;

/**
 * Run the critique gate (ADR 0006) for one issue and return the
 * (possibly retry-refreshed) postSha. Steps: no-rubric preflight →
 * dispatch critique → parse verdict → on CRITIQUE_NEEDS_FIXES, one
 * implementer-retry pass + re-critique.
 *
 * Throws {@link CritiqueCriticalError} on every blocking outcome (no rubric
 * loaded, first-pass CRITICAL, malformed marker, retry disabled, or the
 * retry pass still not CLEAN) so the runIssuePipeline catch handler can
 * quarantine. Runs BEFORE migrations apply so a CRITICAL diff never
 * pollutes the dev DB or gets marked in-progress in a way the outer loop
 * has to undo.
 *
 * Applies its own graceful-degradation guard: issues with no type label or
 * no required principles skip the gate and return postSha unchanged. The
 * function is exported so the verdict/retry branching is unit-testable
 * against a sandbox stub without driving the full runIssuePipeline loop.
 */
export async function runCritique(
  sandbox: SandboxHandle,
  ctx: PipelineCtx,
  postSha: string,
): Promise<{ postSha: string }> {
  const typeLabel = ctx.typeLabel;
  const requiredSkills = ctx.requiredSkills;
  // Only gate issues whose type label maps to SANDCASTLE.md principles —
  // `ctx.typeLabel`/`requiredSkills` undefined or empty means
  // graceful-degradation skips the gate (e.g. issues with no type label,
  // or type labels not in SANDCASTLE.md).
  if (
    typeLabel === undefined ||
    requiredSkills === undefined ||
    requiredSkills.length === 0
  ) {
    return { postSha };
  }

  // No-rubric preflight (ADR 0006 v3). The critique prompt's step 2
  // silently skips principles without a `.claude/skills/<name>/SKILL.md`
  // file on disk. If ALL required principles are missing their rubric,
  // critique loads nothing and returns CRITIQUE_CLEAN regardless of the
  // diff — silent abstention. Real regressions shipped via this path
  // (caught later by the post-merge fixer). Quarantine here with a
  // distinct reason code so the operator knows to install the missing
  // SKILL.md files rather than hunting for a "real" critique blocker.
  const loadable = findLoadableRubrics(requiredSkills, ctx.args.repoRoot);
  if (loadable.length === 0) {
    const missingPaths = requiredSkills
      .map((n) => `- .claude/skills/${n}/SKILL.md`)
      .join("\n");
    ctx.deps.log(
      `[critique] issue=${ctx.issueNumber} NO RUBRIC LOADED — ` +
        `required principles ${requiredSkills.join(", ")} have zero ` +
        `SKILL.md files on disk; quarantining without dispatching critique`,
    );
    throw new CritiqueCriticalError(
      `Critique cannot grade this slice: zero rubric SKILL.md files ` +
        `loaded for the issue's required principles ` +
        `(${requiredSkills.join(", ")}).\n\n` +
        `Expected at least one of:\n${missingPaths}\n\n` +
        `Install the SKILL.md file(s) and re-queue the issue. Until then, ` +
        `critique would silently abstain (return CLEAN with no grading) ` +
        `for this slice and any other slice with the same required-` +
        `principles set.`,
      typeLabel,
      { noRubricLoaded: true },
    );
  }

  // One critique dispatch + verdict parse. marker=null means the sub-agent
  // emitted no recognizable marker (malformed) — the caller fails closed
  // per attempt. Collapses the two formerly-duplicated sandbox.run blocks.
  const dispatchCritique = async (
    name: string,
  ): Promise<{ marker: CritiqueVerdict | null; stdout: string }> => {
    const result = await sandbox.run({
      name,
      maxIterations: 1,
      model: ctx.args.critiqueModel,
      promptFile: "./.sandcastle/critique-prompt.md",
      idleTimeoutSeconds: ctx.args.reviewerTimeoutSec,
      promptArgs: {
        ITERATION: String(ctx.iteration),
        ISSUE_NUMBER: String(ctx.issueNumber),
        TYPE_LABEL: typeLabel,
        BRANCH: ctx.issue.branch,
        BASE_BRANCH: ctx.args.branch,
        REQUIRED_PRINCIPLES: requiredSkills.join(", "),
      },
    });
    try {
      return {
        marker: extractMarker(result.stdout, CRITIQUE_MARKERS),
        stdout: result.stdout,
      };
    } catch {
      return { marker: null, stdout: result.stdout };
    }
  };

  const a1 = await dispatchCritique(`critique (issue=${ctx.issueNumber})`);
  if (a1.marker === null) {
    // Malformed verdict (no marker at all) — fail closed by treating as
    // CRITICAL with the full stdout as findings so the operator can see
    // what happened.
    throw new CritiqueCriticalError(a1.stdout, typeLabel);
  }
  ctx.deps.log(
    `[critique] issue=${ctx.issueNumber} type=${typeLabel} verdict=${a1.marker}`,
  );
  if (a1.marker === "CRITIQUE_CRITICAL") {
    // P0 / ban-list violations are structural; retry won't fix them.
    throw new CritiqueCriticalError(a1.stdout, typeLabel);
  }
  if (a1.marker === "CRITIQUE_NEEDS_FIXES") {
    // Retry path (ADR 0006 / 0014): re-run the implementer with the critique
    // findings as feedback, then re-critique. Ship on CLEAN; quarantine on a
    // CRITICAL at any point, a malformed retry verdict, or CRITIQUE_MAX_RETRIES
    // exhausted still NEEDS_FIXES. The cap is 2 (raised from 1, ADR 0014):
    // first-pass → retry → retry → quarantine.
    if (!ctx.args.retryEnabled) {
      ctx.deps.log(
        `[critique] issue=${ctx.issueNumber} NEEDS_FIXES — retry disabled (--no-retry), quarantining`,
      );
      throw new CritiqueCriticalError(a1.stdout, typeLabel, {
        retryExhausted: true,
      });
    }
    // `attempt` is the implementer attemptNumber for this retry round (2, 3, …);
    // retry N = attempt N+1. `verdict` carries the latest NEEDS_FIXES findings
    // forward as the next implementer's feedback.
    let verdict = a1;
    for (let attempt = 2; attempt <= CRITIQUE_MAX_RETRIES + 1; attempt++) {
      ctx.deps.log(
        `[critique] issue=${ctx.issueNumber} attempt ${attempt - 1} NEEDS_FIXES — ` +
          `re-running implementer on ${ctx.args.implementerModel} with critique ` +
          `feedback (retry ${attempt - 1}/${CRITIQUE_MAX_RETRIES})`,
      );
      const implFix = await runImplementer(sandbox, ctx, {
        attemptNumber: attempt,
        critiqueFeedback: verdict.stdout,
        requiredSkills,
      });
      // Refresh postSha — mirrors the HAS_BLOCKERS retry pattern. Without this,
      // the caller's migration-journal validation runs on a stale SHA range and
      // silently skips any new migrations the retry-implementer added.
      postSha = sandbox.worktreePath
        ? await ctx.deps.captureSha(sandbox.worktreePath)
        : (implFix.commits[implFix.commits.length - 1]?.sha ?? postSha);
      verdict = await dispatchCritique(
        `critique-retry attempt ${attempt} (issue=${ctx.issueNumber})`,
      );
      if (verdict.marker === null) {
        // Malformed retry verdict — fail closed as retry-exhausted.
        throw new CritiqueCriticalError(verdict.stdout, typeLabel, {
          retryExhausted: true,
        });
      }
      ctx.deps.log(
        `[critique] issue=${ctx.issueNumber} attempt ${attempt} verdict=${verdict.marker}`,
      );
      if (verdict.marker === "CRITIQUE_CLEAN") {
        return { postSha }; // fixed — ship
      }
      if (verdict.marker === "CRITIQUE_CRITICAL") {
        // Structural; retry won't help — stop early.
        throw new CritiqueCriticalError(verdict.stdout, typeLabel, {
          retryExhausted: true,
          criticalAfterRetry: true,
        });
      }
      // else still CRITIQUE_NEEDS_FIXES → loop again if retries remain
    }
    // All retries exhausted, still NEEDS_FIXES.
    throw new CritiqueCriticalError(verdict.stdout, typeLabel, {
      retryExhausted: true,
    });
  }
  return { postSha };
}

export async function shipAfterMigrations(
  ctx: PipelineCtx,
  sandbox: SandboxHandle,
  preSha: string,
  postSha: string,
  finalMarker: string,
  skillsInvoked: readonly string[] = [],
  legPath: PromptLegPath = "first-pass-only",
): Promise<IssueOutcome> {
  // Critique gate (ADR 0006). Runs BEFORE migrations apply so a
  // CRITIQUE_CRITICAL diff never pollutes the dev DB or gets marked
  // in-progress in a way the outer loop has to undo. runCritique applies
  // its own type/required-skills graceful-degradation guard and returns the
  // (retry-refreshed) postSha; it throws CritiqueCriticalError to quarantine.
  postSha = (await runCritique(sandbox, ctx, postSha)).postSha;
  // Lint gate (deterministic host backstop). Runs after critique and before
  // the journal/migration gates, so a lint-uncertified diff never reaches the
  // dev DB or markDone. Dormant when the project has no `lint` script or there
  // is no code diff. The lint RUN happens in-sandbox (implementer runs+fixes,
  // reviewer's CATEGORY SWEEP verifies); this only confirms the implementer's
  // `SANDCASTLE-LINT: pass` cert is present on the shipped commit.
  const lint = await ctx.deps.checkLintCert(
    ctx.args.repoRoot,
    preSha,
    postSha,
  );
  if (lint.status === "missing") {
    throw new Error(
      `lint-cert-missing: issue #${ctx.issueNumber} commit ${postSha} changed ` +
        `code but its body lacks the \`${LINT_CERT_TOKEN}\` certification, and ` +
        `the project defines a \`lint\` script. The implementer must run lint ` +
        `and certify it passed (see implement-prompt.md), and the reviewer must ` +
        `reject an uncertified or failing lint. Quarantining for human triage.`,
    );
  }
  if (hasCodeDiff(preSha, postSha)) {
    // Drizzle journal-registration gate. If the implementer added a new
    // <NNNN>_*.sql migration on disk but forgot to register it in
    // packages/db/migrations/meta/_journal.json, drizzle-kit migrate will
    // silently skip the file in downstream consumers / production, even
    // though the host-side applier runs the SQL directly. Recovery agents
    // have been observed marking these "recovered" without fixing the
    // journal — the breakage recurs iteration after iteration. Fail loudly
    // here, before applyMigrations even runs.
    const unregistered = await ctx.deps.validateMigrationJournal(
      ctx.args.repoRoot,
      preSha,
      postSha,
    );
    if (unregistered.length > 0) {
      const lines = unregistered.map(
        (u) =>
          `  - ${u.file} (expected tag '${u.expectedTag}' in ${u.journalPath}` +
          `${u.journalMissing ? " — journal MISSING" : ""})`,
      );
      throw new Error(
        `migrations: ${unregistered.length} new SQL file(s) on disk are NOT ` +
          `registered in their Drizzle journal. drizzle-kit migrate will skip ` +
          `them in production. Regenerate the journal with \`pnpm drizzle-kit ` +
          `generate\` or restore the entries manually:\n${lines.join("\n")}`,
      );
    }
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
  // Issue F: annotate the terminal outcome with the prompt-leg path it took.
  // Emitted unconditionally (BEFORE the staging branch below) so it's visible
  // under both --staging and --no-staging.
  ctx.deps.log(
    `[issue=${ctx.issueNumber}] shipped (marker=${finalMarker}) path=${legPath}`,
  );
  const summary = `[issue=${ctx.issueNumber}] shipped via sandcastle-loop (commit ${postSha}, branch ${ctx.issue.branch})`;
  // Under --no-staging (legacy), flip label → done immediately. Under staging
  // (default), keep the issue in `in-progress` until the merger lands it on
  // `integration-candidate`; the outer loop flips it to `merged-to-staging`
  // there, then to `done` after the post-merge fast-forward.
  if (!ctx.args.stagingEnabled) {
    await ctx.deps.markDone(ctx.issueNumber, summary);
  }
  deferralCounts.delete(ctx.issueNumber);
  return { status: "ok", finalMarker, postSha, skillsInvoked };
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
    ctx.status.setIssuePhase(ctx.issueNumber, "implementer");
    const impl1 = await runImplementer(sandbox, ctx, {
      attemptNumber: 1,
      requiredSkills: ctx.requiredSkills,
    });
    let postSha = sandbox.worktreePath
      ? await ctx.deps.captureSha(sandbox.worktreePath)
      : impl1.commits[impl1.commits.length - 1]?.sha ?? "";

    // Phase 2b: reviewer attempt 1 (default model). Note: migrations are
    // deferred until AFTER ALL_CLEAR — only the final accepted SQL hits the
    // dev DB, never the intermediate state of a failed first attempt.
    ctx.status.setIssuePhase(ctx.issueNumber, "reviewer");
    const review1 = await runReviewer(sandbox, ctx, postSha, undefined, undefined, {
      skillsInvoked: impl1.skillsInvoked,
    });

    if (review1.marker === "ALL_CLEAR") {
      return await shipAfterMigrations(
        ctx,
        sandbox,
        preSha,
        postSha,
        "ALL_CLEAR",
        impl1.skillsInvoked,
        "first-pass-only",
      );
    }

    // Reviewer attempt 1 marked HAS_BLOCKERS. Decide retry vs quarantine.
    const implEscalations = roleModelsFor(ctx.args).implementer.escalations;
    const revEscalations = roleModelsFor(ctx.args).reviewer.escalations;
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
    ctx.status.setIssuePhase(ctx.issueNumber, "implementer-retry", "attempt 2");
    const impl2 = await runImplementer(sandbox, ctx, {
      attemptNumber: 2,
      model: implEscalations[0],
      reviewerFeedback: review1.stdout,
      requiredSkills: ctx.requiredSkills,
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
    ctx.status.setIssuePhase(ctx.issueNumber, "reviewer", "attempt 2");
    const review2 = await runReviewer(sandbox, ctx, postSha, undefined, revEscalations[0], {
      implementerRebuttal: rebuttal,
      name: "reviewer-retry",
      skillsInvoked: impl2.skillsInvoked,
    });

    if (review2.marker === "ALL_CLEAR") {
      return await shipAfterMigrations(
        ctx,
        sandbox,
        preSha,
        postSha,
        "ALL_CLEAR",
        impl2.skillsInvoked,
        "critique-retry",
      );
    }

    // Phase 2e: third-attempt grant. Round 2 still says HAS_BLOCKERS,
    // but if the implementer demonstrably resolved every category that
    // round 1 flagged, round 2's findings are genuinely new (different
    // categories) and the system is making progress — grant one more
    // implementer+reviewer pass instead of quarantining. Recurring
    // findings (same category flagged in both rounds) still bounce,
    // because that signals the implementer is stuck.
    //
    // Conservative fallback: if either sweep is missing or unparsable,
    // skip the grant and quarantine as before. A malformed sweep must
    // NEVER produce a free extra retry.
    const sweepLogError = (msg: string): void =>
      ctx.deps.logError(
        `[issue=${ctx.issueNumber}] CATEGORY SWEEP duplicate: ${msg}`,
      );
    const sweep1 = extractCategorySweep(review1.stdout, sweepLogError);
    const sweep2 = extractCategorySweep(review2.stdout, sweepLogError);
    const grantRound3 =
      sweep1 !== null &&
      sweep2 !== null &&
      priorFindingsResolved(sweep1, sweep2);

    if (!grantRound3) {
      // Surface the denial reason so an operator auditing a quarantine
      // can tell which of the four denial paths tripped: sweep1
      // unparsable, sweep2 unparsable, recurring blocker (same category
      // a finding in both rounds), or vacuous round-1 sweep.
      const reason = thirdAttemptDenyReason(sweep1, sweep2);
      ctx.deps.log(
        `[issue=${ctx.issueNumber}] round-3 grant denied: ${reason}`,
      );
    }

    if (grantRound3) {
      ctx.deps.log(
        `[issue=${ctx.issueNumber}] reviewer attempt 2 HAS_BLOCKERS but ` +
          `round-1 categories resolved — granting attempt 3 on ` +
          `${implEscalations[0]}`,
      );
      ctx.status.setIssuePhase(ctx.issueNumber, "implementer-retry", "attempt 3");
      const impl3 = await runImplementer(sandbox, ctx, {
        attemptNumber: 3,
        model: implEscalations[0],
        reviewerFeedback: review2.stdout,
        requiredSkills: ctx.requiredSkills,
      });
      const rebuttal3 = extractRebuttal(impl3.stdout);
      const postSha3 = sandbox.worktreePath
        ? await ctx.deps.captureSha(sandbox.worktreePath)
        : impl3.commits[impl3.commits.length - 1]?.sha ?? postSha;
      postSha = postSha3;
      ctx.deps.log(
        `[issue=${ctx.issueNumber}] running reviewer attempt 3 on ` +
          `${revEscalations[0]}${rebuttal3 ? " (with implementer rebuttal)" : ""}`,
      );
      ctx.status.setIssuePhase(ctx.issueNumber, "reviewer", "attempt 3");
      const review3 = await runReviewer(
        sandbox,
        ctx,
        postSha,
        undefined,
        revEscalations[0],
        {
          implementerRebuttal: rebuttal3,
          name: "reviewer-retry-2",
          skillsInvoked: impl3.skillsInvoked,
        },
      );
      if (review3.marker === "ALL_CLEAR") {
        return await shipAfterMigrations(
          ctx,
          sandbox,
          preSha,
          postSha,
          "ALL_CLEAR",
          impl3.skillsInvoked,
          "implementer-retry",
        );
      }
      const reason3 =
        `[issue=${ctx.issueNumber}] reviewer marked ${review3.marker} after ` +
        `third attempt — quarantining for human triage. path=implementer-retry`;
      deferralCounts.delete(ctx.issueNumber);
      await ctx.deps.quarantine(ctx.issueNumber, reason3);
      return { status: "quarantined", finalMarker: review3.marker, postSha };
    }

    const reason =
      `[issue=${ctx.issueNumber}] reviewer marked ${review2.marker} after ` +
      `escalated retry — quarantining for human triage. path=critique-retry`;
    deferralCounts.delete(ctx.issueNumber);
    await ctx.deps.quarantine(ctx.issueNumber, reason);
    return { status: "quarantined", finalMarker: review2.marker, postSha };
  } catch (err) {
    const errMsg = (err as Error).message;
    // Critique gate failures (CRITIQUE_CRITICAL or CRITIQUE_NEEDS_FIXES that
    // didn't pass on retry, or malformed verdict) take a dedicated quarantine
    // path with the critique findings posted as a GitHub issue comment.
    // Critique runs inside shipAfterMigrations — by the time we catch this,
    // the implementer has committed but migrations have NOT applied (gate
    // runs before applyMigrations), so quarantining is safe state-wise.
    // `critiqueErrorReasonCode(err)` resolves to one of: `critique-no-rubric-loaded`,
    // `critique-retry-critical`, `critique-retry-exhausted`, `critique-critical-fail`
    // (the flag→code mapping lives in lib/skill-discipline.ts).
    if (err instanceof CritiqueCriticalError) {
      deferralCounts.delete(ctx.issueNumber);
      const { reasonCode, verdictHeader } = critiqueErrorReasonCode(err);
      const reason = err.noRubricLoaded
        ? `[issue=${ctx.issueNumber}] ${reasonCode}: ` +
          `zero SKILL.md files loaded for required principles on ` +
          `${err.typeLabel}. Install missing rubrics and re-queue.`
        : `[issue=${ctx.issueNumber}] ${reasonCode}: ` +
          `critique sub-agent blocked merge for ${err.typeLabel}. ` +
          `Findings posted to the issue as a comment.`;
      ctx.deps.logError(reason);
      const commentBody = err.noRubricLoaded
        ? `**Critique-gate verdict: ${verdictHeader}** (issue type \`${err.typeLabel}\`)\n\n` +
          `Critique did not run because no rubric \`SKILL.md\` files were loadable for this issue's required principles. The critique sub-agent would have silently abstained (loaded zero rubrics → returned \`CRITIQUE_CLEAN\` with no grading), so the orchestrator quarantines instead. Install the missing rubric(s) listed below, then remove \`needs-human\` and add \`ready-for-agent\` to re-queue.\n\n` +
          `<details><summary>Missing rubric paths</summary>\n\n\`\`\`\n${err.findings.slice(0, 16000)}\n\`\`\`\n\n</details>`
        : `**Critique-gate verdict: ${verdictHeader}** (issue type \`${err.typeLabel}\`)\n\n` +
          `The autonomous critique sub-agent blocked merge of this issue's diff against the project's design principles. Full critique output:\n\n` +
          `<details><summary>Critique findings</summary>\n\n\`\`\`\n${err.findings.slice(0, 16000)}\n\`\`\`\n\n</details>`;
      try {
        await ctx.deps.comment(ctx.issueNumber, commentBody);
      } catch (e) {
        ctx.deps.logError(
          `${reasonCode} comment failed: ${(e as Error).message}`,
        );
      }
      try {
        await ctx.deps.quarantine(ctx.issueNumber, reason);
        return { status: "quarantined", finalMarker: "HALT" };
      } catch (e) {
        ctx.deps.logError(
          `${reasonCode} quarantine failed: ${(e as Error).message}`,
        );
        return { status: "error", finalMarker: "HALT" };
      }
    }
    // Skill-discipline gate failure (per ADR 0006 v3). The per-issue
    // implementer gate throws when the agent skipped required Skill()
    // invocations for its ticket's type:X label. Acts as a hard backstop
    // for critique-as-gate's silent-abstention failure mode (zero-rubric
    // case). Implementer's commits live on the agent branch but are not
    // merged; operator can re-queue after addressing.
    if (err instanceof MissingRequiredSkillsError) {
      deferralCounts.delete(ctx.issueNumber);
      const reasonCode = "skill-discipline-fail";
      const reason =
        `[issue=${ctx.issueNumber}] ${reasonCode}: ` +
        `implementer skipped required Skill() invocations: ` +
        `${err.missing.join(", ")}. Quarantining for triage.`;
      ctx.deps.logError(reason);
      try {
        await ctx.deps.comment(
          ctx.issueNumber,
          `**Skill-discipline gate: implementer missed required Skill() invocations**\n\n` +
            `- Required principles for this issue type: \`${err.required.join("`, `")}\`\n` +
            `- Invoked: ${err.invoked.length === 0 ? "_(none)_" : "`" + err.invoked.join("`, `") + "`"}\n` +
            `- Missing: \`${err.missing.join("`, `")}\`\n\n` +
            `The skill-discipline gate is the hard backstop for critique-as-gate's silent-abstention failure mode (see ADR 0006 v3). The implementer's commits are on the agent's branch but have not merged. Re-queue (\`ready-for-agent\`) after the implementer either invokes the missing skills explicitly or the required-principles set in \`SANDCASTLE.md\` is corrected for this \`type:\` label.`,
        );
      } catch (e) {
        ctx.deps.logError(
          `${reasonCode} comment failed: ${(e as Error).message}`,
        );
      }
      try {
        await ctx.deps.quarantine(ctx.issueNumber, reason);
        return { status: "quarantined", finalMarker: "HALT" };
      } catch (e) {
        ctx.deps.logError(
          `${reasonCode} quarantine failed: ${(e as Error).message}`,
        );
        return { status: "error", finalMarker: "HALT" };
      }
    }
    const transientVerdict = isTransientError(errMsg);
    // Stall detection: surface "the sandbox stopped responding" failures
    // distinctly from "the spec was bad" failures so runMain can pause
    // the loop after a streak (sandbox-level problem, not code-level).
    // Pattern lives in module-level STALL_RE — see definition for which
    // error messages count.
    const stalled = STALL_RE.test(errMsg);
    ctx.deps.log(
      `[isTransientError-audit] issue=${ctx.issueNumber} verdict=${transientVerdict} stalled=${stalled} msg=${JSON.stringify(errMsg)}`,
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
      ctx.status.setIssuePhase(ctx.issueNumber, "recovery");
      ctx.deps.log(
        `[issue=${ctx.issueNumber}] --recovery on — attempting one recovery pass`,
      );
      const diagnosis = diagnoseHaltCause(errMsg);
      if (diagnosis) {
        ctx.deps.log(
          `[issue=${ctx.issueNumber}] diagnose: ${diagnosis.cause} — hinting recovery`,
        );
      }
      const rec = await runRecovery(
        sandbox,
        ctx,
        errMsg,
        diagnosis?.hint ?? "",
      );
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
            const reviewErrMsg = (e as Error).message;
            // Mirror the implementer/normal-reviewer transient policy: a
            // brief Anthropic 5xx during the recovery-reviewer pass defers
            // the issue for next-iteration retry instead of burning a
            // quarantine slot. Without this guard, a vendor blip during a
            // recovery review reintroduces exactly the regression
            // commit 87c2c6f closed for the rest of the pipeline.
            if (isTransientError(reviewErrMsg)) {
              ctx.deps.log(
                `[issue=${ctx.issueNumber}] recovery-reviewer threw transient (${JSON.stringify(reviewErrMsg)}) — deferring instead of quarantining`,
              );
              const deferred = await tryDefer(
                "recovery-reviewer threw transient",
                reviewErrMsg,
              );
              if (deferred) return deferred;
              ctx.deps.logError(
                `[issue=${ctx.issueNumber}] recovery-reviewer threw transient ${reviewErrMsg} but defer budget exhausted — quarantining`,
              );
            } else {
              ctx.deps.logError(
                `[issue=${ctx.issueNumber}] recovery-reviewer threw: ${reviewErrMsg} — quarantining`,
              );
            }
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
      return { status: "quarantined", finalMarker: "HALT", stalled };
    } catch (e) {
      ctx.deps.logError(`quarantine failed: ${(e as Error).message}`);
      return { status: "error", finalMarker: "HALT", stalled };
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
  args: SandcastleArgs,
  deps: Deps,
): Promise<RunMainResult> {
  // Point every host-side `gh` call at the managed repo, not the launch cwd, so
  // a `--repo-root` other than cwd resolves correctly (see configureGh). Set
  // first, before the startup reconciliation issues its first `gh issue list`.
  configureGh({ cwd: args.repoRoot });

  let consecutiveFailures = 0;
  let lastFailingIssue: number | undefined;
  const shippedIssues: number[] = [];
  const quarantinedIssues: number[] = [];
  const deferredIssues: number[] = [];
  let iterationsRun = 0;
  const importedFilesSnapshot = snapshotImportedFiles(args.repoRoot);
  // Cross-iteration staging state — the iteration number that left staging
  // in a known-bad state, or null if last iteration finished clean. Used to
  // tag the failed staging tip as `bad-merge-iter-<N>` before reset.
  let lastFailedStagingIteration: number | null = null;
  // Run-level health flag (audit issue #4). Set true when a final fast-forward
  // promotion REFUSES — merged+reviewed work is then stranded on
  // `integration-candidate` and the integration branch was NOT advanced.
  // A run that ends with this flag set must NOT report `done`/exit 0: it exits
  // non-zero and finishes the status feed as `unhealthy` so the failure is
  // visible to both the operator's shell and the viewer.
  let promotionFailed = false;
  // Sandbox-health detector: count consecutive iterations where EVERY
  // outcome was a stall (hard-ceiling fire / SDK idle timeout). When the
  // sandbox itself is degraded (orbstack memory pressure, docker hung,
  // network NAT broken) no amount of retrying will help — the loop just
  // burns tokens producing more stalls. After STALL_STREAK_LIMIT
  // consecutive all-stall iterations, exit non-zero with a clear "restart
  // docker, then resume" message rather than continuing to grind.
  let stalledStreak = 0;
  const STALL_STREAK_LIMIT = 3;

  // Skill-discipline opt-in: when `SANDCASTLE.md` exists at the repo root,
  // the orchestrator re-validates the planner's picked issues against a
  // host-side label fetch, excluding any that don't carry exactly one
  // `type:` label. The check is done once at startup (SANDCASTLE.md is a
  // committed file; it doesn't appear mid-run); the filter itself runs
  // per-iteration so newly-added `type:` labels are picked up.
  const sandcastleMdPath = path.join(args.repoRoot, "SANDCASTLE.md");
  const sandcastleMdExists = existsSync(sandcastleMdPath);
  // Parse SANDCASTLE.md ONCE at startup into a `type:X → required-skills[]`
  // map. The orchestrator looks up each dispatched issue's `type:X` label
  // in this map to compute the per-issue `requiredSkills` threaded into
  // runImplementer's opts. Empty map when SANDCASTLE.md doesn't exist —
  // the per-issue lookup then yields `undefined` and the gate is a no-op
  // (backward compat for projects without the file).
  let requiredSkillsByType: ReadonlyMap<string, readonly string[]> = new Map();
  if (sandcastleMdExists) {
    deps.log(
      `SANDCASTLE.md found at ${sandcastleMdPath} — skill discipline enabled (planner picks re-validated against host-side label fetch)`,
    );
    try {
      const mdContent = readFileSync(sandcastleMdPath, "utf8");
      requiredSkillsByType = parseRequiredSkillsByType(mdContent);
      deps.log(
        `skill-discipline: parsed ${requiredSkillsByType.size} type:X section(s) from SANDCASTLE.md`,
      );
    } catch (err) {
      deps.logError(
        `skill-discipline: failed to read/parse SANDCASTLE.md — gate disabled this run: ${(err as Error).message}`,
      );
      requiredSkillsByType = new Map();
    }
  } else {
    deps.log(
      `No SANDCASTLE.md at repo root — skill discipline disabled (no type:-label enforcement)`,
    );
  }

  // Codex backend has an empty escalation ladder by design (ADR 0012:
  // codexModels.*.escalations === []), so a failing role quarantines on first
  // failure with no model-tier retry/recovery. Warn once at startup because
  // --recovery / --no-retry then have no escalation effect — silent under the
  // claude defaults but surprising for an operator who set them expecting a
  // retry tier.
  if (args.backend === "codex") {
    deps.log(
      `backend: codex — no escalation/recovery tier (empty ladder, ADR 0012): a failing role quarantines on first failure; --recovery / --no-retry have no model-escalation effect this run`,
    );
  }

  // Single-instance lock — refuse to start a second loop on the same
  // checkout. Without this guard, two parallel loops will race on the
  // `in-progress` label: loop B's startup reconciliation (below) would
  // release issues loop A is mid-pipeline on, causing double-claim of
  // partial work or silent quarantine. The sandcastle-run skill ALSO
  // checks via pgrep, but that's bypassable (direct `node main.mts`
  // invocation, or worktree-rooted re-launch outside the skill); the
  // in-process lock is the canonical guard. proper-lockfile reclaims
  // after 60s of staleness so a crashed prior run doesn't permanently
  // wedge restarts.
  const loopLockPath = path.join(
    args.repoRoot,
    ".sandcastle",
    ".loop.lock",
  );
  let releaseLoopLock: (() => Promise<void>) | undefined;
  try {
    releaseLoopLock = await acquireSingleInstanceLock(loopLockPath);
  } catch (err) {
    deps.logError(
      `[startup] ${(err as Error).message} A second loop on the same checkout would race with the in-progress label state — refusing to start.`,
    );
    return {
      exitCode: 1,
      iterationsRun: 0,
      shippedIssues: [],
      quarantinedIssues: [],
    };
  }

  // Status feed for the `sandcastle-watch` viewer. Constructed ONLY after the
  // single-instance lock above succeeds, so a second loop that fails the lock
  // and early-returns can never clobber a live status.json. Threaded into
  // PipelineCtx so per-issue pipelines can publish phase transitions; all its
  // methods are synchronous + non-fatal (write errors route to deps.logError).
  const statusStore = createStatusStore(
    {
      branch: args.branch,
      repo: path.basename(args.repoRoot),
      repoRoot: args.repoRoot,
      startedAt: new Date().toISOString(),
      iterationsTotal: args.iterations,
      maxConcurrent: args.maxConcurrent,
    },
    { onError: (err) => deps.logError(`status write failed: ${(err as Error).message}`) },
  );
  // Keep-alive: a phase can run for many minutes without a transition (the log
  // shows a 1200s idle phase), so without this the viewer would mislabel a
  // healthy loop "stale" within seconds. The timer is `unref`'d and cleared by
  // `finish()`, so it never delays a clean exit.
  statusStore.startHeartbeat();

  // Startup reconciliation: a previous loop that was killed (Ctrl-C, OOM,
  // host reboot) leaves issues stuck on `in-progress`. Without this step,
  // the new loop's planner sees those issues as unavailable (already
  // claimed) and silently skips them — or worse, the planner's blocker
  // resolution can read "issue absent from ready-for-agent → resolved"
  // and dispatch dependents prematurely. Now safe to release unconditionally
  // because the single-instance lock above guarantees no parallel loop holds
  // its own issues on `in-progress`. The deps.release stub short-circuits
  // under --dry-run with a log entry, so no extra guard needed here.
  try {
    const stale = await deps.listIssuesByLabel("in-progress");
    if (stale.length > 0) {
      deps.log(
        `startup reconciliation: ${stale.length} orphaned in-progress issue(s) — releasing back to ready-for-agent`,
      );
      for (const issue of stale) {
        try {
          await deps.release(
            issue.number,
            `[sandcastle startup-reconcile] orphaned in-progress label from a prior killed run — released for re-claim by the new loop`,
          );
          deps.log(`  released #${issue.number}: ${issue.title}`);
        } catch (err) {
          deps.logError(
            `  failed to release #${issue.number}: ${(err as Error).message} — leaving as-is, planner will skip`,
          );
        }
      }
    } else {
      deps.log(`startup reconciliation: no orphaned in-progress issues`);
    }
  } catch (err) {
    deps.log(
      `startup reconciliation skipped: listIssuesByLabel failed: ${(err as Error).message}`,
    );
  }

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
      statusStore.startIteration(it);
      iterationsRun = it;

      // Run the test-injected hook if present (production: undefined). This MUST
      // fire BEFORE the detector check so tests can simulate a recovery commit.
      if (deps.iterationStartHook !== undefined) {
        await deps.iterationStartHook(it);
      }

      // Hot-reload detector: if any statically-imported file changed on disk
      // since startup, exit cleanly with code 75 so the wrapper can relaunch.
      // In production the snapshot was just taken so iteration 1 will always
      // see no change; skipping it explicitly is not necessary. Tests inject
      // mutations via iterationStartHook (fired above) to exercise this path.
      const changed = detectImportedFileChange(args.repoRoot, importedFilesSnapshot);
      if (changed !== null) {
        deps.log(
          `[sandcastle] tracked file changed on disk: ${changed}. ` +
            `Exiting with code 75 so the wrapper can restart with fresh imports.`,
        );
        const remaining = args.iterations - (iterationsRun - 1);
        writeFileSync(
          path.join(args.repoRoot, ".sandcastle/.restart-remaining"),
          String(remaining),
          "utf8",
        );
        // Hot-reload: the wrapper will relaunch with fresh imports, so mark the
        // feed "restarting" (not "done") — the viewer keeps the run visible
        // rather than showing it as completed.
        statusStore.finish("restarting");
        return {
          exitCode: 75,
          iterationsRun: iterationsRun - 1,
          shippedIssues,
          quarantinedIssues,
        };
      }

      // Run-level activity for the viewer: the cross-issue planning window
      // (covers the planner run plus the brief post-setPlan, pre-implementer
      // gap where issues are `planned` and no per-issue phase is active yet).
      statusStore.setActivity("planning");

      // Phase 1: planner (or one-shot bypass)
      let plan: PlanIssue[];
      // Per-issue required-skills lookup, populated below if SANDCASTLE.md
      // exists AND the planner returned issues to dispatch. Empty map means
      // "skill discipline disabled for this iteration" — runImplementer
      // receives `undefined` for opts.requiredSkills and its gate is a no-op.
      // Lives in the iteration scope (not the planner-else scope) so the
      // parallel dispatch below can read it without var-hoisting tricks.
      let perIssueTypeLabel: ReadonlyMap<string, string> = new Map();
      let perIssueRequiredSkills: ReadonlyMap<string, readonly string[]> =
        new Map();
      if (args.issue !== undefined) {
        plan = [
          {
            id: String(args.issue),
            title: `issue #${args.issue}`,
            branch: `agent/issue-${args.issue}`,
          },
        ];
        // One-shot mode bypasses the planner but still needs the type:X
        // label + required-skills lookup for the critique gate. Fetch the
        // issue's labels directly via gh and populate the per-issue maps.
        if (sandcastleMdExists) {
          try {
            const ghOut = execFileSync(
              "gh",
              [
                "issue",
                "view",
                String(args.issue),
                "--json",
                "labels",
                "--jq",
                "[.labels[].name]",
              ],
              { encoding: "utf8", cwd: args.repoRoot },
            ).trim();
            const oneShotLabels = JSON.parse(ghOut) as string[];
            const typeLabel = oneShotLabels.find((l) => l.startsWith("type:"));
            if (typeLabel !== undefined) {
              const req = requiredSkillsByType.get(typeLabel);
              const builtTypeLabels = new Map<string, string>();
              const builtReq = new Map<string, readonly string[]>();
              builtTypeLabels.set(String(args.issue), typeLabel);
              if (req !== undefined) builtReq.set(String(args.issue), req);
              perIssueTypeLabel = builtTypeLabels;
              perIssueRequiredSkills = builtReq;
              deps.log(
                `one-shot: issue #${args.issue} type=${typeLabel}` +
                  ` requiredSkills=[${req?.join(", ") ?? "(unknown type)"}]`,
              );
            }
          } catch (err) {
            deps.log(
              `one-shot: failed to fetch labels for issue #${args.issue}: ` +
                `${(err as Error).message} — critique gate will skip`,
            );
          }
        }
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
        // Truncation halt: when the planner sees its all-open-issues list
        // hit the 200-entry cap, blocker resolution is unreliable. The
        // planner emits `<truncation-halt/>` on a line by itself in its
        // reasoning + an empty plan. The prompt mandates "on a line by
        // itself" specifically so we can detect it without false-
        // positiving on issue bodies that happen to mention the sentinel
        // in a different context (e.g. an issue ABOUT this very feature
        // — its body would appear in the planner's <issues-json> input
        // and could be echoed in reasoning).
        if (/^\s*<truncation-halt\/>\s*$/im.test(plannerStdout)) {
          deps.logError(
            `planner: all-open-issues snapshot hit the 200-entry cap. Blocker resolution is unreliable; halting to avoid out-of-order dispatch. Raise the --limit in .sandcastle/plan-prompt.md's <all-open-issues> block (or close some issues) before re-running.`,
          );
          return {
            exitCode: 2,
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

        // SANDCASTLE.md skill-discipline gate: re-fetch labels host-side
        // and exclude any picked issue that doesn't carry exactly one
        // `type:` label. We deliberately do NOT trust the planner's
        // (LLM-generated) view of labels — the host is authoritative.
        // Lazy gate: when SANDCASTLE.md is absent OR the plan is empty,
        // we skip the gh call entirely. This keeps existing tests
        // (which set repoRoot="/repo", no SANDCASTLE.md) on the no-op
        // path without needing new mock plumbing.
        if (sandcastleMdExists && plan.length > 0) {
          let labelLookup: ReadonlyMap<string, readonly string[]> = new Map();
          try {
            const ghPayload = await deps.listIssuesByLabel(args.label);
            const built = new Map<string, readonly string[]>();
            for (const item of ghPayload) {
              built.set(String(item.number), item.labels);
            }
            labelLookup = built;
          } catch (err) {
            // Fail loud. Previously we logged + fell through with an empty
            // labelLookup, which made every picked issue look like "missing
            // type: label", the plan became empty, and the iteration
            // exited 0 with "no claimable issues — exiting cleanly". For a
            // non-technical operator that's indistinguishable from a real
            // empty queue, so a flaky `gh auth` silently halted overnight
            // work. Re-throw with a distinctive prefix so logs grep cleanly
            // and the iteration body unwinds to the CLI's fatal handler
            // (process.exit(1) — loudly visible).
            const msg = `SKILL_DISCIPLINE_GATE_FAILURE: listIssuesByLabel("${args.label}") failed: ${(err as Error).message}`;
            deps.logError(msg);
            throw new Error(msg);
          }
          const { kept, excluded } = filterPlanByTypeLabels(
            plan,
            labelLookup,
            sandcastleMdExists,
          );
          for (const e of excluded) {
            deps.log(`skipping issue #${e.id} — ${e.reason}`);
          }
          plan = [...kept];
          // For every kept issue, pick its single `type:X` label and look
          // up the required skills in the startup-parsed map. Empty list
          // (type:cleanup) and "no matching section" both result in the
          // gate being a no-op for that issue — but they're distinct:
          // empty list → explicit "none required"; missing entry → the
          // type is unknown to SANDCASTLE.md (graceful-degradation rule).
          // We only emit a map entry for known types so unknown-type
          // issues stay on the `undefined` no-op path.
          const built = new Map<string, readonly string[]>();
          const builtTypeLabels = new Map<string, string>();
          for (const p of kept) {
            const labels = labelLookup.get(p.id) ?? [];
            const typeLabel = labels.find((l) => l.startsWith("type:"));
            if (typeLabel === undefined) continue;
            const req = requiredSkillsByType.get(typeLabel);
            if (req === undefined) continue;
            built.set(p.id, req);
            builtTypeLabels.set(p.id, typeLabel);
          }
          perIssueRequiredSkills = built;
          perIssueTypeLabel = builtTypeLabels;
        }
      }

      if (plan.length === 0) {
        // Issue E: the planner silently drops issues whose body declares
        // `Blocked by: #N`. Surface those at the clean exit so the operator
        // can tell "nothing ready" from "everything ready is blocked". A gh
        // failure here must NOT crash the clean exit — fall back to plain.
        let note = "";
        try {
          const open = await deps.listOpenIssuesWithBodies();
          note = buildBlockedByNote(open);
        } catch (err) {
          deps.log(
            `blocked-by scan skipped: listOpenIssuesWithBodies failed: ${
              (err as Error).message
            }`,
          );
        }
        deps.log(`no claimable issues — exiting cleanly${note}`);
        // Clean terminal exit (queue drained) — the common overnight-completion
        // path. Mark the feed done, same as out-of-iterations below. EXCEPT
        // when an earlier iteration's final promotion refused: that left
        // certified work stranded on `integration-candidate`, so this run is
        // NOT a clean success — finish `unhealthy` and exit non-zero (audit #4).
        if (promotionFailed) {
          statusStore.finish("unhealthy");
          return {
            exitCode: 1,
            iterationsRun,
            shippedIssues,
            quarantinedIssues,
          };
        }
        statusStore.finish("done");
        return {
          exitCode: 0,
          iterationsRun,
          shippedIssues,
          quarantinedIssues,
        };
      }
      deps.log(`plan: ${plan.length} issue(s) to work in parallel`);
      statusStore.setPlan(
        plan.map((p) => ({
          number: Number(p.id),
          title: p.title,
          branch: p.branch,
        })),
      );
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
              requiredSkills: perIssueRequiredSkills.get(p.id),
              typeLabel: perIssueTypeLabel.get(p.id),
              status: statusStore,
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
          // Authoritative terminal state + totals for the viewer. One call here
          // covers all four sub-branches (ok / quarantined / deferred / error);
          // rejected results have no issueNumber so they are skipped below.
          statusStore.recordOutcome(s.value.issueNumber, s.value.outcome);
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

      // Sandbox-health stall detector. Distinct from the
      // consecutive-failures circuit breaker below: that one fires on
      // "the work itself can't be completed" (spec ambiguity, recurring
      // review failures, etc.). This one fires on "the sandbox itself
      // isn't responding" (docker hung, orbstack memory pressure, SDK
      // idle timer firing repeatedly). The fix in the second case is
      // restarting docker, not closer human review of the spec — so we
      // separate the two signals and exit with a stall-specific message
      // rather than a generic "investigate before re-queuing."
      const iterationStalled =
        settled.length > 0 &&
        settled.every((s) => {
          if (s.status === "fulfilled") {
            return s.value.outcome.stalled === true;
          }
          // Pre-pipeline rejection — claim failure, etc. Count it as a
          // stall only if its own error message matches the stall pattern;
          // a gh-auth failure shouldn't count. Uses module-level STALL_RE
          // so this and the pipeline-catch site can't drift.
          const msg =
            s.reason instanceof Error ? s.reason.message : String(s.reason);
          return STALL_RE.test(msg);
        });
      if (iterationStalled) {
        stalledStreak += 1;
        deps.log(
          `sandbox-health: iteration ${it} all-stalled (streak ${stalledStreak}/${STALL_STREAK_LIMIT})`,
        );
      } else {
        if (stalledStreak > 0) {
          deps.log(
            `sandbox-health: stall streak reset at ${stalledStreak} (this iteration produced at least one non-stall outcome)`,
          );
        }
        stalledStreak = 0;
      }
      if (stalledStreak >= STALL_STREAK_LIMIT) {
        deps.logError(
          `sandbox-health: ${stalledStreak} consecutive iterations stalled — every outcome hit the wall-clock hard ceiling or SDK idle timeout. The sandbox itself is likely degraded (orbstack/docker memory pressure, network NAT broken, container daemon hung). Stop the loop, restart docker (on macOS: orbstack), then re-run. Continuing would burn tokens producing more stalls.`,
        );
        return {
          exitCode: 2,
          iterationsRun,
          shippedIssues,
          quarantinedIssues,
        };
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
      // Run-level activity: merging starts here (after the stall/circuit-breaker
      // gates, which `return` without finishing — labelling earlier would freeze
      // the feed on "merging"). Covers the staging prelude + the merger run.
      statusStore.setActivity("merging");
      const mergedIssueNums = mergedBranches
        .map((b) => Number(b.id))
        .filter((n) => Number.isInteger(n) && n > 0);
      const branchesArg = mergedBranches.map((b) => `- ${b.branch}`).join("\n");
      const issuesArg = mergedBranches
        .map((i) => `- #${i.id}: ${i.title}`)
        .join("\n");

      // Staging prelude (default). Tag the previous iteration's bad staging
      // tip if the last iteration left one, then hard-reset the dedicated
      // staging worktree to the current integration tip so the merger lands
      // its work on `integration-candidate` rather than directly on the
      // integration branch. The staging worktree (set up at boot by
      // `ensureStagingWorktree`) is permanently checked out on
      // `integration-candidate`, so this is structurally race-free across
      // iterations — unlike the prior `git branch -f` against the launch
      // worktree which collided with itself on iter 2+.
      if (args.stagingEnabled) {
        if (stagingWorktreePath === "") {
          throw new Error(
            `staging is enabled but stagingWorktreePath is unset — ensureStagingWorktree() must be called during boot before runMain. ` +
              `If you're invoking runMain from a test, call __setStagingWorktreePathForTests() first or set stagingEnabled: false.`,
          );
        }
        resetStagingToIntegrationTip(
          args.repoRoot,
          stagingWorktreePath,
          args.branch,
          lastFailedStagingIteration,
          (s) => deps.log(s),
          (s) => deps.logError(s),
        );
        lastFailedStagingIteration = null;
      }
      // Under the structural fix (ensureStagingWorktree + throw-on-failure
      // in the prelude above), `args.stagingEnabled` is the authoritative
      // signal — there's no longer a "staging requested but degraded"
      // intermediate state. Keep this alias for downstream readability.
      const stagingActive = args.stagingEnabled;

      let mergerOk = true;
      try {
        await deps.run({
          name: "merger",
          maxIterations: 1,
          model: args.mergerModel,
          promptFile: "./.sandcastle/merge-prompt.md",
          idleTimeoutSeconds: args.implementerTimeoutSec,
          cwd: stagingActive ? stagingWorktreePath : undefined,
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
      // Render the per-issue skill-invocation map for the post-merge reviewer
      // prompt. The post-merge audit sees, per issue, which skills the shipped
      // implementer actually invoked (or that none were captured) — enabling
      // the same skill-discipline checks at the rollup level that the per-issue
      // reviewer already does. Built once per iteration and reused by both the
      // first-pass and (if it runs) the escalated reviewer pass.
      statusStore.setActivity("reviewing"); // run-level: post-merge review + fixer ladder
      const skillsInvokedByIssue = new Map<string, readonly string[]>();
      for (const c of completed) {
        if (c.outcome.status === "ok") {
          skillsInvokedByIssue.set(
            String(c.issue.id),
            c.outcome.skillsInvoked ?? [],
          );
        }
      }
      // Render rule: numeric keys (issue IDs) keep the historical `#N:`
      // prefix so the reviewer prompt's `#N: (none)` language still
      // matches. Non-numeric keys — currently just `fixer` for the
      // post-merge-fixer's combined invocations across the rollup —
      // render as a bare label (`fixer: ...`) so the reviewer can tell
      // at a glance which row is per-issue vs. shared-across-issues.
      const renderSkillsInvokedByIssue = (
        m: ReadonlyMap<string, readonly string[]>,
      ): string =>
        m.size === 0
          ? "(no skill data captured)"
          : Array.from(m.entries())
              .map(([id, skills]) => {
                const label = /^\d+$/.test(id) ? `#${id}` : id;
                return `${label}: ${skills.length === 0 ? "(none)" : skills.join(", ")}`;
              })
              .join("\n");

      // Shared runner for both the default-model first pass and the
      // escalated re-run after the fixer. Returns BOTH marker and stdout
      // — the fixer pass needs stdout (verbatim reviewer concerns), so a
      // marker-only helper forced an inline duplicate. On a thrown call
      // we log loudly and return empty strings so the caller falls
      // through to the same "no marker emitted" path it would have taken
      // for a non-emitting reviewer; the iteration loop continues.
      const runPostMergeReviewer = async (
        model: string,
        skillsInvokedByIssueArg: ReadonlyMap<
          string,
          readonly string[]
        > = new Map(),
        retryOnStall: boolean = true,
      ): Promise<{ marker: string; stdout: string }> => {
        try {
          const r = await deps.run({
            name: "post-merge-reviewer",
            maxIterations: 1,
            model,
            promptFile: "./.sandcastle/post-merge-review-prompt.md",
            idleTimeoutSeconds: args.reviewerTimeoutSec,
            cwd: stagingActive ? stagingWorktreePath : undefined,
            promptArgs: {
              ITERATION: String(it),
              MERGE_DEPTH: String(mergedBranches.length),
              INTEGRATION_BRANCH: args.branch,
              BRANCHES: branchesArg,
              ISSUES: issuesArg,
              SKILLS_INVOKED_BY_ISSUE: renderSkillsInvokedByIssue(
                skillsInvokedByIssueArg,
              ),
            },
          });
          // "contains" mode: the reviewer sometimes writes its verdict marker
          // inside a closing sentence ("Review is done: POST_MERGE_ALL_CLEAR.")
          // rather than on a bare line — that wrongly quarantined whole merged
          // batches (#416/#417). Accept the marker embedded in the last line,
          // fail-closed if both markers appear. Other roles keep stricter modes.
          const marker = extractMarker(
            r.stdout,
            ["POST_MERGE_ALL_CLEAR", "POST_MERGE_ISSUES_FOUND"] as const,
            { mode: "contains" },
          );
          deps.log(
            `post-merge review: ${marker || "(no marker emitted)"}`,
          );
          return { marker, stdout: r.stdout };
        } catch (err) {
          const msg = (err as Error).message;
          // Stall-class errors (SDK idle timeout, hard ceiling, etc.) are
          // environmental — the reviewer never got a chance to verdict.
          // Quarantining merged issues here destroys good code (observed on
          // affinity-tracker #197). A MarkerNotFoundError is the sibling
          // failure: the reviewer ran but ended its single turn WITHOUT a
          // verdict — it deferred / "stood by" instead of emitting a marker
          // (affinity-tracker #475), which the prompt now forbids but we
          // survive once if it slips through. Both classes are non-verdicts
          // on clean code, so retry once on the same model before giving up.
          const isNoVerdict = err instanceof MarkerNotFoundError;
          if (retryOnStall && (STALL_RE.test(msg) || isNoVerdict)) {
            deps.logError(
              `post-merge review ${isNoVerdict ? "emitted no verdict" : "stalled"} (${msg}) — retrying once on same model`,
            );
            return runPostMergeReviewer(
              model,
              skillsInvokedByIssueArg,
              false,
            );
          }
          deps.logError(
            `post-merge review threw: ${msg} — falling through to quarantine of merged issues`,
          );
          return { marker: "", stdout: "" };
        }
      };

      // First pass uses the default model.
      let { marker: postMergeMarker, stdout: postMergeFeedback } =
        await runPostMergeReviewer(
          args.postMergeReviewerModel,
          skillsInvokedByIssue,
        );

      // Fix-ladder. Only runs under staging AND only when the first pass
      // flagged ISSUES_FOUND. Single fix attempt with the escalated fixer
      // model, then re-run the reviewer on the escalated model.
      if (
        stagingActive &&
        postMergeMarker === "POST_MERGE_ISSUES_FOUND"
      ) {
        // Route the fixer model through the run's backend (ADR 0012), via the
        // SAME `roleModelsFor(args)` source every other role uses — never a
        // second derivation off the model, which could split from args.backend.
        const fixerSrc = roleModelsFor(args);
        const fixerModel =
          fixerSrc.postMergeFixer.escalations[0] ??
          fixerSrc.postMergeFixer.default;
        deps.log(
          `post-merge fix-loop: spawning fixer (model=${fixerModel}) on ${STAGING_BRANCH}`,
        );
        let fixerOk = true;
        let fixerResult: RunHandle | undefined;
        try {
          fixerResult = await deps.run({
            name: "post-merge-fixer",
            maxIterations: 1,
            model: fixerModel,
            promptFile: "./.sandcastle/post-merge-fix-prompt.md",
            idleTimeoutSeconds: args.implementerTimeoutSec,
            cwd: stagingWorktreePath,
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
          // Capture the fixer's Skill() invocations from its session JSONL
          // — same pattern as runImplementer (see
          // extractSkillInvocationsFromSession). The fixer is required
          // by post-merge-fix-prompt to invoke the same Required tools
          // as the original implementer for each issue it touches; the
          // re-review (next call below) needs to see those invocations
          // to credit them. Without this extraction, the fixer can
          // comply OR skip with no observable difference at re-review.
          //
          // Attribution: the fixer's work spans multiple issues in the
          // rollup, and the host has no clean way to attribute an
          // individual tool_use to one of those issues. We stash the
          // combined list under a synthetic `"fixer"` key — the
          // reviewer prompt treats this row as shared across all
          // affected issues (see post-merge-review-prompt.md).
          const fixerSkillsInvoked: string[] = [];
          for (const fxIt of fixerResult?.iterations ?? []) {
            for (const name of await resolveAndExtractSkillInvocations(
              fxIt,
              fixerModel,
            )) {
              fixerSkillsInvoked.push(name);
            }
          }
          skillsInvokedByIssue.set("fixer", fixerSkillsInvoked);

          // Post-merge fixer skill-discipline telemetry (DEMOTED — was a hard
          // gate before, but the gate had the exact gaming pattern that
          // motivated ADR 0006's pivot for the per-issue implementer: the
          // fixer commit can apply real principle-aligned work AND narrate
          // "Skills invoked: impeccable, polish" in its commit message, yet
          // still register zero `Skill()` tool calls. Counting tool calls
          // graded the process, not the output. The per-issue critique
          // sub-agent already gates each diff before it reaches the rollup;
          // the rollup-level gate was catching ritual non-compliance, not
          // actual quality regressions, and forced manual `git merge --no-ff
          // integration-candidate` recovery on every iteration. Now: compute
          // the UNION across all rollup issues and log the missing-vs-invoked
          // list for triage, but always proceed to the re-review dispatch.
          const unionRequiredSet = new Set<string>();
          const unionRequired: string[] = [];
          for (const b of mergedBranches) {
            const req = perIssueRequiredSkills.get(b.id);
            if (req === undefined) continue;
            for (const s of req) {
              if (unionRequiredSet.has(s)) continue;
              unionRequiredSet.add(s);
              unionRequired.push(s);
            }
          }
          if (unionRequired.length > 0) {
            const { missing } = validateRequiredSkillsInvoked(
              unionRequired,
              fixerSkillsInvoked,
            );
            if (missing.length > 0) {
              deps.log(
                `[skill-discipline] WARN post-merge-fixer missed: ` +
                  `${missing.join(", ")}; invoked: ` +
                  `${fixerSkillsInvoked.length === 0 ? "(none)" : fixerSkillsInvoked.join(", ")} ` +
                  `(telemetry only — per-issue critique already gated each diff; ` +
                  `re-review will catch rollup-level regressions)`,
              );
            }
          }

          const reviewerEscModel =
            roleModelsFor(args).postMergeReviewer.escalations[0] ??
            args.postMergeReviewerModel;
          deps.log(
            `post-merge fix-loop: re-running reviewer (model=${reviewerEscModel}) on fixed staging`,
          );
          ({ marker: postMergeMarker } = await runPostMergeReviewer(
            reviewerEscModel,
            skillsInvokedByIssue,
          ));
        }
      }

      // Promotion / quarantine decision.
      let ffSucceeded = false;
      if (stagingActive) {
        if (postMergeMarker === "POST_MERGE_ALL_CLEAR" && mergerOk) {
          // Fast-forward integration, then promote all merged-to-staging
          // issues to done.
          const integrationTipBefore = resolveRefSha(args.repoRoot, args.branch);
          ffSucceeded = fastForwardIntegration(
            args.repoRoot,
            args.branch,
            (s) => deps.log(s),
            (s) => deps.logError(s),
          );
          if (ffSucceeded) {
            // Audit Issue 8 (2026-05-30): warn when this iteration's
            // integration moved a dep manifest — host `node_modules` is
            // now out of step with the lockfile until the operator runs
            // their install. See detectChangedLockfiles.
            const integrationTipAfter = resolveRefSha(args.repoRoot, args.branch);
            const changedLockfiles = detectChangedLockfiles(
              args.repoRoot,
              integrationTipBefore,
              integrationTipAfter,
            );
            if (changedLockfiles.length > 0) {
              deps.logError(
                `WARN: host node_modules may be stale — these dep manifests ` +
                  `changed in this iteration's integration: ${changedLockfiles.join(", ")}. ` +
                  `Run your package manager's install (e.g. \`pnpm install\`) on the host ` +
                  `to refresh before using it interactively.`,
              );
            }
            const summary =
              `[sandcastle it=${it}] integration ${args.branch} fast-forwarded; ` +
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
            // Fast-forward refused — treat as a staging failure. The merged +
            // post-merge-reviewer-certified work is now stranded on
            // `integration-candidate` and the integration branch was NOT
            // advanced. Flag the whole run unhealthy so it can't exit
            // `done`/0 and silently lie that the work shipped (audit #4).
            lastFailedStagingIteration = it;
            promotionFailed = true;
            deps.logError(
              `[sandcastle it=${it}] final promotion to ${args.branch} FAILED — ` +
                `certified work is stranded on ${STAGING_BRANCH}; run will exit ` +
                `unhealthy (non-zero). Human triage required.`,
            );
          }
        } else {
          // Staging failed certification (post-fixer too) OR merger failed
          // OR no marker — quarantine every merged-to-staging issue, leave
          // staging at its current tip (next iteration's reset will tag
          // it as `bad-merge-iter-<N>`).
          const reason =
            `[sandcastle it=${it}] staging post-merge reviewer marked ` +
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

      // Phase 5: cleanup of per-issue sub-worktrees AND agent/issue-N
      // branches for issues that successfully landed THIS iteration.
      //
      // Gate logic (both conditions required):
      //   1. The specific issue's outcome.status === "ok".
      //      Quarantined / errored / deferred issues keep their branch
      //      and sub-worktree as forensic evidence.
      //   2. Mode-dependent timing:
      //      - stagingActive: AFTER post-merge review passes AND the FF
      //        to the launch branch succeeded.
      //      - !stagingActive: immediately after merger commits. Post-
      //        merge review is advisory in --no-staging and does NOT
      //        gate cleanup.
      //
      // Truth source for "which branches landed": git's own --merged
      // check, NOT the merger's output text. Partial merges (some
      // conflicts skipped) can report success while leaving branches
      // unmerged.
      const cleanupGate = stagingActive
        ? postMergeMarker === "POST_MERGE_ALL_CLEAR" && mergerOk && ffSucceeded
        : mergerOk;
      if (cleanupGate) {
        statusStore.setActivity("cleanup"); // run-level: worktree/branch cleanup
        const okIssues = completed.filter((c) => c.outcome.status === "ok");
        const candidateBranches = okIssues.map((c) => c.issue.branch);
        const landedBranches = verifyLandedBranches(
          args.repoRoot,
          args.branch,
          candidateBranches,
          (w) => deps.logError(`cleanup WARN: ${w}`),
        );
        if (landedBranches.length === 0) {
          deps.log(
            `cleanup: no agent/issue-* branches verified as merged into ${args.branch}; skipping`,
          );
        } else {
          deps.log(
            `cleanup: removing ${landedBranches.length} worktree+branch pair(s) for landed issues`,
          );
          for (const branch of landedBranches) {
            const result = cleanupIssueBranch(
              args.repoRoot,
              branch,
              args.branch,
              (w) => deps.logError(`cleanup WARN: ${w}`),
            );
            // A `skipped-*` outcome means the worktree dir or its branch
            // could not be removed. The createSandbox pre-clean now
            // self-heals stale worktrees on the next iteration, so this
            // is not a correctness failure — but the user still needs to
            // know cleanup didn't run to completion. Promote to error
            // level so the line stands out in logs.
            if (result.startsWith("skipped-")) {
              deps.logError(`cleanup ${branch}: ${result}`);
            } else {
              deps.log(`cleanup ${branch}: ${result}`);
            }
          }
        }
      }
    }

    // Out of iterations.
    // A failed final promotion (audit #4) overrides the clean out-of-cycles
    // outcome — but NOT an explicit operator interrupt (SIGINT/SIGTERM), which
    // is its own deliberate `stopped`. When promotion failed and we weren't
    // interrupted, finish `unhealthy` and exit non-zero so the stranded work
    // can't masquerade as a clean "out of cycles" success.
    if (promotionFailed && !shuttingDown) {
      deps.logError(
        `out of iterations (${args.iterations}) — but a final promotion FAILED ` +
          `earlier; exiting unhealthy (code 1). Certified work is stranded on ` +
          `${STAGING_BRANCH}.`,
      );
      statusStore.finish("unhealthy");
      return {
        exitCode: 1,
        iterationsRun,
        shippedIssues,
        quarantinedIssues,
      };
    }
    deps.log(
      `out of iterations (${args.iterations}) — exiting with code 2 (clean — just out of cycles)`,
    );
    // Completion path. A clean out-of-iterations / drained-queue exit is "done".
    // A SIGINT/SIGTERM `shuttingDown` break also falls through here — label that
    // run "stopped" so the viewer shows its stopped banner instead of a false
    // "done — loop finished" for an interrupted run.
    statusStore.finish(shuttingDown ? "stopped" : "done");
    return {
      exitCode: 2,
      iterationsRun,
      shippedIssues,
      quarantinedIssues,
    };
  } finally {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
    if (releaseLoopLock) {
      try {
        await releaseLoopLock();
      } catch (err) {
        // Best-effort — the 60s stale TTL on proper-lockfile means a
        // failed release here won't permanently wedge the next restart.
        deps.logError(
          `release loop lock failed: ${(err as Error).message} (lock will auto-expire in 60s)`,
        );
      }
    }
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
    let parsed: { args: SandcastleArgs; showHelp: boolean };
    try {
      parsed = parseSandcastleArgs(process.argv.slice(2));
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

    if (args.allowDirtySandcastle) {
      // Make the bypass loud so it doesn't quietly become habit.
      process.stderr.write(
        "WARN: launched with --allow-dirty-sandcastle. The " +
          ".sandcastle/main.mts dirty-check was skipped. Verify your " +
          "local changes are committed before the next /sandcastle-update " +
          "or they will be clobbered.\n",
      );
    }

    const deps = buildDefaultDeps(args);

    // Set up the dedicated staging worktree before runMain so the merger
    // phase always has a valid cwd that ISN'T the launch worktree. This is
    // load-bearing: without it the merger writes to the launch HEAD and
    // strands every post-iter-1 commit on `integration-candidate`.
    if (args.stagingEnabled) {
      try {
        stagingWorktreePath = await ensureStagingWorktree(
          args.repoRoot,
          args.branch,
          deps.log,
        );
      } catch (err) {
        process.stderr.write(
          `staging worktree setup failed:\n  - ${(err as Error).message}\n`,
        );
        process.exit(2);
      }
    }

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
