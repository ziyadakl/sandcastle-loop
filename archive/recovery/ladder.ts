/**
 * Recovery ladder — Sonnet → Opus escalation when an agent halts.
 *
 * Mirrors the bash driver's two-tier ladder (afk-ralph.sh ~L483-588): when
 * the implementer (or any other primary agent) exits non-zero or emits
 * `<promise>HALT</promise>`, we spin up a recovery agent on the SAME sandbox
 * worktree (so the partial work — uncommitted edits, half-written tests —
 * stays exactly as the previous attempt left it), instruct it to run the
 * acceptance tests and either commit or escalate, and parse a typed
 * RecoveryDecision out of the marker line.
 *
 * Two design notes worth preserving from the bash version:
 *
 *   1. Sonnet first, Opus second. Same-tier retry is a documented
 *      anti-pattern (arxiv 2505.24726 + every production loop) — every
 *      retry changes tier. We never run two consecutive Sonnets.
 *
 *   2. Opus runs with its OWN log file, separate from Sonnet's. Otherwise
 *      Opus picks up Sonnet's reasoning in its context window and tends
 *      to repeat the same wrong path. The bash version writes
 *      `/tmp/ralph-rec-it{N}.{XXXX}.log` for Sonnet and a fresh briefing
 *      for Opus; we mirror that with distinct `logFilePath` values per
 *      `sandbox.run` call.
 *
 * Marker discipline: the recovery agent emits `RECOVERY_COMPLETE` or
 * `<promise>HALT</promise>` on its own line as the LAST non-empty line of
 * its output. Free-text mentions of those words elsewhere DO NOT count.
 * We delegate the strict marker extraction to Track B's
 * {@link extractMarker} (mode: "strict" matches the new prompt discipline).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeCode, type Sandbox } from "@ai-hero/sandcastle";
import {
  extractMarker,
  MarkerNotFoundError,
} from "../../src/verdicts/parse.js";
import { RECOVERY_MARKERS } from "../../src/verdicts/markers.js";
import { RecoveryDecisionSchema } from "../../src/verdicts/schemas.js";
import type {
  IterationContext,
  ModelTier,
  RecoveryDecision,
} from "../../src/types.js";
import {
  diagnoseHaltCause,
  type Diagnosis,
  type HaltCause,
} from "./diagnose.js";

/**
 * Promisified `execFile`. Used by {@link runFixCommand} to execute the
 * environment-fix argv DIRECTLY against the sandbox's worktree path,
 * bypassing the agent layer entirely. The earlier Haiku-based runner
 * depended on a Bash tool grant that the sandbox doesn't always provide;
 * when the grant was missing the agent would happily emit FIX_DONE based
 * on its own hallucination of having executed the command. execFile makes
 * the contract concrete: argv[0] is the binary, argv[1..] are args, exit
 * code is the source of truth.
 */
const execFileP = promisify(execFile);

// NOTE: Track B is expected to ship `src/verdicts/index.ts` as a barrel that
// re-exports `parseVerdict`, `extractMarker`, the schemas, and the marker
// constants. Until that lands we import from the leaf modules directly so
// this track compiles independently. The runtime contract is identical.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Why a recovery run was triggered. Used as the fallback `haltReason` if
 * BOTH Sonnet and Opus fail without emitting a parseable HALT promise.
 */
export interface HaltContext {
  /** Free-text reason from the prior agent (timeout, rc≠0, parse fail, etc). */
  readonly reason: string;
  /** Numeric exit code from the prior agent, if known. */
  readonly priorRc?: number;
  /** Identifier of the prior agent ("implementer", "reviewer", "fixer"). */
  readonly priorWho?: string;
  /** Path to the prior agent's stream-json log, surfaced in the briefing. */
  readonly priorLogPath?: string;
  /**
   * Optional `git log --oneline {preSha}..HEAD` output captured by the loop
   * driver immediately before recovery. Surfaced verbatim in the recovery
   * prompt so the agent can see what (if anything) the prior attempt landed.
   */
  readonly commits?: string;
  /**
   * Optional `git status -s` output (uncommitted changes) captured by the
   * loop driver immediately before recovery.
   */
  readonly uncommitted?: string;
  /** Last `[STEP X/N]` marker emitted by the prior agent, if known. */
  readonly lastStep?: string;
  /**
   * Tail of the prior agent's assistant text, if available. Preferred over
   * `reason` for diagnosis because it usually contains the actual stack
   * trace / error string that pinned the halt cause. The diagnose-or-
   * escalate ladder reads this first; the legacy ladder ignores it.
   */
  readonly lastAssistantText?: string;
}

export interface RecoveryLadderConfig {
  /**
   * Path to the recovery prompt template. Read at call time (not module
   * load) so test runs can swap it without re-importing this module.
   */
  readonly promptTemplatePath: string;
  /**
   * Optional verify-commands block used to substitute `__VERIFY_COMMANDS__`
   * placeholder in the template (if present). Loop-driver-supplied: usually
   * `"pnpm typecheck"` plus any per-story playwright command.
   */
  readonly verifyCommands?: string;
  /**
   * Optional integration-check block used to substitute
   * `__INTEGRATION_CHECK_BLOCK__` placeholder (if present). Used by stories
   * whose acceptance criteria require hitting a running dev server.
   */
  readonly integrationCheckBlock?: string;
  /** Idle timeout for each recovery agent run in seconds. Default 1800. */
  readonly idleTimeoutSeconds?: number;
  /** Sonnet tier label. Defaults to "claude-sonnet-4-6". */
  readonly sonnetModel?: string;
  /** Opus tier label. Defaults to "claude-opus-4-7". */
  readonly opusModel?: string;
  /** Override the host directory where per-attempt log files are written. */
  readonly logDir?: string;
  /**
   * Effort knob for the Sonnet retry attempt. Defaults to `"high"`. The
   * retry runs after a successful environment fix and benefits from the
   * extra reasoning headroom — the failure that triggered recovery wasn't
   * a model failure, but the post-fix retry still has to reason about
   * whatever-was-actually-broken.
   */
  readonly sonnetEffort?: "high" | "max";
  /**
   * Effort knob for the Opus escalation attempt. Defaults to `"xhigh"`.
   * Sandcastle's published `ClaudeCodeOptions.effort` type still lists
   * `"low" | "medium" | "high" | "max"` — we cast `"xhigh"` through
   * `as never` at the call site (see {@link runOpusXhighAttempt}). Bumping
   * sandcastle will let us drop the cast.
   */
  readonly opusEffort?: "xhigh" | "max";
}

/** Runs Sonnet first, escalates to Opus on failure or HALT. */
export interface RecoveryLadderResult {
  readonly decision: RecoveryDecision;
  /** Which tier produced the final decision ("sonnet" | "opus"). */
  readonly resolvedBy: ModelTier;
  /** Sonnet attempt summary (always present). */
  readonly sonnet: AttemptSummary;
  /** Opus attempt summary (present iff Sonnet didn't end with RECOVERY_COMPLETE). */
  readonly opus?: AttemptSummary;
}

export interface AttemptSummary {
  readonly model: string;
  /** Path to the per-attempt log file (separated to avoid context pollution). */
  readonly logFilePath?: string;
  /** Marker extracted from the agent's output, if any. */
  readonly marker?: "RECOVERY_COMPLETE" | "HALT";
  /** Free-text reason on HALT or parse failure. */
  readonly haltReason?: string;
  /** Did `sandbox.run()` return without throwing? */
  readonly runCompleted: boolean;
  /** Was a recognizable marker extracted from the output? */
  readonly markerFound: boolean;
  /** SHA of the new commit (if any) the agent landed on. */
  readonly commitSha?: string;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Substitute placeholders in the recovery prompt template and append a
 * context block describing the current iteration. Both placeholder
 * substitutions are no-ops when the template doesn't contain the marker
 * (the local-fork template doesn't, but future templates might).
 */
function buildRecoveryPrompt(
  template: string,
  ctx: IterationContext,
  halt: HaltContext,
  cfg: RecoveryLadderConfig,
): string {
  let body = template;

  // Optional placeholder substitutions. Done with `replaceAll` rather than
  // a regex so that placeholders containing regex metacharacters are
  // matched literally.
  const verify = cfg.verifyCommands ?? "pnpm typecheck";
  const integration = cfg.integrationCheckBlock ?? "";
  body = body.split("__VERIFY_COMMANDS__").join(verify);
  body = body.split("__INTEGRATION_CHECK_BLOCK__").join(integration);

  // Append a context block. The bash version supplies this via separate
  // `@/tmp/ralph-issue-N.md @briefing.md` file references; in TS we inline
  // a compact summary so the agent reads it as part of the prompt.
  const ctxBlock = [
    "",
    "# Recovery context (auto-generated, do not edit)",
    "",
    `- iteration: ${ctx.iterNum} / ${ctx.iterTotal}`,
    `- story id: ${ctx.story.id}`,
    `- story title: ${ctx.story.title}`,
    typeof ctx.story.ghIssue === "number"
      ? `- gh issue: #${ctx.story.ghIssue}`
      : "- gh issue: (none)",
    `- branch: ${ctx.branch}`,
    `- pre-iteration sha: ${ctx.preSha}`,
    "",
    "## Why recovery was triggered",
    "",
    `${halt.reason}`,
    halt.priorRc !== undefined ? `- prior agent rc: ${halt.priorRc}` : "",
    halt.priorWho !== undefined ? `- prior agent: ${halt.priorWho}` : "",
    halt.priorLogPath !== undefined
      ? `- prior log: ${halt.priorLogPath}`
      : "",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return `${body.trimEnd()}\n${ctxBlock}`;
}

// ---------------------------------------------------------------------------
// Single-attempt runner
// ---------------------------------------------------------------------------

interface RunRecoveryAttemptArgs {
  readonly sandbox: Sandbox;
  readonly model: string;
  readonly prompt: string;
  readonly logFilePath: string;
  readonly idleTimeoutSeconds: number;
  readonly attemptName: string;
  /**
   * Optional effort knob passed through to claudeCode. When omitted the
   * SDK's default applies (which is fine for the Sonnet-first ladder; the
   * diagnose-or-escalate path explicitly passes "high" for Sonnet retries).
   */
  readonly effort?: "high" | "max";
}

/**
 * Run one recovery attempt. Catches sandbox.run failures and converts them
 * to an `AttemptSummary` so the caller decides whether to escalate. Marker
 * extraction is strict — the new prompt requires a bare-marker line.
 */
async function runRecoveryAttempt(
  args: RunRecoveryAttemptArgs,
): Promise<AttemptSummary> {
  const {
    sandbox,
    model,
    prompt,
    logFilePath,
    idleTimeoutSeconds,
    attemptName,
    effort,
  } = args;

  let stdout = "";
  let lastCommit: string | undefined;
  let runCompleted = false;
  try {
    const result = await sandbox.run({
      agent:
        effort !== undefined
          ? claudeCode(model, { effort })
          : claudeCode(model),
      prompt,
      maxIterations: 1,
      idleTimeoutSeconds,
      name: attemptName,
      logging: { type: "file", path: logFilePath },
    });
    stdout = result.stdout;
    lastCommit = result.commits.at(-1)?.sha;
    runCompleted = true;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return {
      model,
      logFilePath,
      runCompleted: false,
      markerFound: false,
      marker: undefined,
      haltReason: `${attemptName} failed before producing a marker: ${msg}`,
      commitSha: undefined,
    };
  }

  // Extract the strict-mode marker from the LAST non-empty line. The recovery
  // prompt mandates the bare-marker discipline; any deviation is a parse fail
  // and the ladder treats it as if Sonnet halted.
  let marker: "RECOVERY_COMPLETE" | "HALT" | undefined;
  let haltReason: string | undefined;
  try {
    marker = extractMarker(stdout, RECOVERY_MARKERS, { mode: "strict" });
  } catch (err) {
    if (err instanceof MarkerNotFoundError) {
      haltReason =
        `${attemptName} ended without a recognizable marker on the last line. ` +
        `Last line: ${JSON.stringify(err.lastLine)}`;
    } else {
      haltReason = `${attemptName} marker extraction threw: ${(err as Error).message}`;
    }
  }

  if (marker === "HALT") {
    haltReason = extractHaltReason(stdout) ?? "(no reason given)";
  }

  return {
    model,
    logFilePath,
    runCompleted,
    markerFound: marker !== undefined,
    marker,
    haltReason,
    commitSha: lastCommit,
  };
}

/**
 * Pull the explanation paragraph associated with a `<promise>HALT</promise>`
 * line in the agent's output. The bash `extract_halt_reason` helper looked
 * AFTER the promise; the new strict-marker discipline puts the promise
 * LAST, so prose lives BEFORE it. We try both, preferring whichever side
 * has actual text:
 *
 *   1. Same-line trailing text (legacy bash form)
 *   2. Lines AFTER the promise (legacy bash form, multi-line)
 *   3. Lines BEFORE the promise, walking backward until a blank line or
 *      the start of the output. Limited to 8 lines so we don't capture
 *      the entire transcript when the agent forgets to leave a blank.
 *
 * Returns `undefined` if nothing reasonable can be salvaged. Capped at
 * 500 chars to keep quarantine reasons readable.
 */
function extractHaltReason(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/);
  const haltLineIdx = lines.findIndex((l) =>
    /^\s*<promise>HALT<\/promise>/.test(l),
  );
  if (haltLineIdx === -1) return undefined;

  // Strategy 1+2: text on the same line after the promise, plus subsequent
  // non-empty lines.
  const after: string[] = [];
  const sameLineTail = lines[haltLineIdx]!.replace(
    /^\s*<promise>HALT<\/promise>\s*/,
    "",
  );
  if (sameLineTail.trim().length > 0) after.push(sameLineTail);
  for (let i = haltLineIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) continue;
    after.push(line);
  }
  const afterJoined = after.join(" ").replace(/\s+/g, " ").trim();
  if (afterJoined.length > 0) {
    return afterJoined.slice(0, 500);
  }

  // Strategy 3: walk backward up to 8 lines, stopping at a blank.
  const before: string[] = [];
  for (let i = haltLineIdx - 1; i >= 0 && before.length < 8; i--) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      if (before.length > 0) break;
      continue;
    }
    before.unshift(line);
  }
  const beforeJoined = before.join(" ").replace(/\s+/g, " ").trim();
  return beforeJoined.length > 0 ? beforeJoined.slice(0, 500) : undefined;
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the Sonnet → Opus recovery ladder against `sandbox`. The sandbox
 * MUST be the same one the prior agent used, with the same worktree state
 * (uncommitted edits, half-written tests intact). Returns a typed
 * RecoveryDecision plus per-attempt summaries.
 *
 * The decision schema is validated via Zod (Track B's RecoveryDecisionSchema)
 * before return — guards against future field-shape drift.
 */
export async function runRecoveryLadder(
  sandbox: Sandbox,
  ctx: IterationContext,
  halt: HaltContext,
  config: RecoveryLadderConfig,
): Promise<RecoveryLadderResult> {
  const template = await fs.readFile(config.promptTemplatePath, "utf8");
  const prompt = buildRecoveryPrompt(template, ctx, halt, config);
  const idleTimeoutSeconds = config.idleTimeoutSeconds ?? 1800;
  const sonnetModel = config.sonnetModel ?? "claude-sonnet-4-6";
  const opusModel = config.opusModel ?? "claude-opus-4-7";
  const logDir = config.logDir ?? path.join(process.cwd(), ".sandcastle", "logs");

  // Ensure log dir exists; we write per-attempt logs into it. If creation
  // fails we surface the error — agent invocation without a log file would
  // mean no forensic record on failure.
  await fs.mkdir(logDir, { recursive: true });

  const stamp = `${Date.now()}-${ctx.story.id}-it${ctx.iterNum}`;
  const sonnetLog = path.join(logDir, `recovery-sonnet-${stamp}.log`);
  const opusLog = path.join(logDir, `recovery-opus-${stamp}.log`);

  // --- Sonnet attempt ----------------------------------------------------
  const sonnet = await runRecoveryAttempt({
    sandbox,
    model: sonnetModel,
    prompt,
    logFilePath: sonnetLog,
    idleTimeoutSeconds,
    attemptName: `recovery-sonnet-it${ctx.iterNum}`,
  });

  if (sonnet.runCompleted && sonnet.marker === "RECOVERY_COMPLETE") {
    const decision = RecoveryDecisionSchema.parse({
      marker: "RECOVERY_COMPLETE" as const,
      fixApplied: typeof sonnet.commitSha === "string",
      ...(sonnet.commitSha !== undefined ? { commitSha: sonnet.commitSha } : {}),
    });
    return { decision, resolvedBy: "sonnet", sonnet };
  }

  // Sonnet HALT'd or failed. Escalate to Opus with a SEPARATE log so context
  // doesn't pollute. We DO NOT pass Sonnet's transcript into Opus — the
  // shared sandbox carries the work-in-progress, which is what Opus actually
  // needs; reasoning context would only encourage repeating Sonnet's path.
  // --- Opus attempt ------------------------------------------------------
  const opus = await runRecoveryAttempt({
    sandbox,
    model: opusModel,
    prompt,
    logFilePath: opusLog,
    idleTimeoutSeconds,
    attemptName: `recovery-opus-it${ctx.iterNum}`,
  });

  if (opus.runCompleted && opus.marker === "RECOVERY_COMPLETE") {
    const decision = RecoveryDecisionSchema.parse({
      marker: "RECOVERY_COMPLETE" as const,
      fixApplied: typeof opus.commitSha === "string",
      ...(opus.commitSha !== undefined ? { commitSha: opus.commitSha } : {}),
    });
    return { decision, resolvedBy: "opus", sonnet, opus };
  }

  // Both failed. Compose a HALT decision with the most informative reason
  // we have: prefer Opus's HALT reason, fall back to Sonnet's, fall back to
  // the original halt context.
  const haltReason =
    opus.haltReason ??
    sonnet.haltReason ??
    `recovery ladder exhausted (sonnet runCompleted=${sonnet.runCompleted}, opus runCompleted=${opus.runCompleted}). ` +
      `Original halt: ${halt.reason}`;

  const decision = RecoveryDecisionSchema.parse({
    marker: "HALT" as const,
    fixApplied: false,
    haltReason,
  });
  return { decision, resolvedBy: "opus", sonnet, opus };
}

// ---------------------------------------------------------------------------
// Diagnose-first ladder (v1)
// ---------------------------------------------------------------------------

/**
 * Test-only options for {@link runRecoveryDiagnosisOrEscalate}. Production
 * callers pass `undefined` (or just omit). The fields are explicitly
 * underscore-prefixed so it's obvious at the call site that they exist
 * solely to inject test seams.
 */
export interface RunRecoveryDiagnosisTestSeams {
  /**
   * Override `execFile` for the fix-command runner. When supplied, the
   * recovery ladder will call this instead of `node:child_process.execFile`
   * to apply the diagnosed fix. Tests inject a stub so they never spawn
   * real binaries against the host's PATH.
   *
   * The contract mirrors `util.promisify(execFile)`: resolve with
   * `{ stdout, stderr }` on exit 0; reject with an Error carrying optional
   * `code` (numeric exit code or string spawn-error code), `signal`,
   * `stdout`, and `stderr`.
   */
  readonly _execFileP?: (
    file: string,
    argv: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Diagnose the halt cause, run a one-shot fix command directly against the
 * sandbox's worktree if we recognise it, retry with cheap Sonnet, and only
 * escalate to Opus when diagnosis fails or the fix didn't un-stick the run.
 *
 * Why this exists: retrying with Opus on a halt that's actually
 * "unapplied migration" or "dead dev server" wastes money — the
 * environment is broken, the model isn't. The new ladder spends a few
 * tokens classifying first, then runs the fix command via direct
 * `execFile` (no agent, no Bash-tool grant required), then a Sonnet retry.
 * Opus is the LAST resort, not the first.
 *
 * Algorithm:
 *
 *   1. Read `halt.lastAssistantText` (preferred — usually contains the
 *      actual error) or `halt.reason` and run it through
 *      {@link diagnoseHaltCause}.
 *   2. If the cause is recognised AND we have an auto-fix argv:
 *      a. Execute the fix via `execFile(argv[0], argv.slice(1), { cwd:
 *         sandbox.worktreePath })`. Exit 0 = success; non-zero / spawn
 *         failure / timeout = failure.
 *      b. If the fix succeeds, retry the recovery agent with Sonnet at
 *         `effort: "high"` (configurable via `config.sonnetEffort`).
 *         RECOVERY_COMPLETE wins; anything else falls through to step 3.
 *      c. If the fix itself fails, fall through to step 3.
 *   3. Escalate to Opus 4.7 with `effort: "xhigh"` by default (configurable
 *      via `config.opusEffort`; cast through `as never` because
 *      sandcastle's ClaudeCodeOptions type union still lists "max" instead
 *      of "xhigh"). One attempt only. RECOVERY_COMPLETE wins; otherwise
 *      return marker = HALT with both diagnosis and Opus reasons stitched
 *      into `haltReason`.
 */
export async function runRecoveryDiagnosisOrEscalate(
  sandbox: Sandbox,
  ctx: IterationContext,
  halt: HaltContext,
  config: RecoveryLadderConfig,
  seams?: RunRecoveryDiagnosisTestSeams,
): Promise<RecoveryLadderResult> {
  const template = await fs.readFile(config.promptTemplatePath, "utf8");
  const prompt = buildRecoveryPrompt(template, ctx, halt, config);
  const idleTimeoutSeconds = config.idleTimeoutSeconds ?? 1800;
  const sonnetModel = config.sonnetModel ?? "claude-sonnet-4-6";
  const opusModel = config.opusModel ?? "claude-opus-4-7";
  const sonnetEffort: "high" | "max" = config.sonnetEffort ?? "high";
  const opusEffort: "xhigh" | "max" = config.opusEffort ?? "xhigh";
  const logDir =
    config.logDir ?? path.join(process.cwd(), ".sandcastle", "logs");
  await fs.mkdir(logDir, { recursive: true });

  const stamp = `${Date.now()}-${ctx.story.id}-it${ctx.iterNum}`;

  // --- Step 1: diagnose ----------------------------------------------------
  const diagnosisInput = halt.lastAssistantText ?? halt.reason;
  const diagnosis = diagnoseHaltCause(diagnosisInput);

  // The Sonnet attempt summary slot is ALWAYS populated (caller invariant of
  // RecoveryLadderResult). When we skip the Sonnet retry path entirely (e.g.
  // diagnosis is "unknown", or fixCommand is null), we still synthesise a
  // diagnostic AttemptSummary so callers don't trip over `undefined`.
  let sonnetAttempt: AttemptSummary | undefined;

  // --- Step 2: direct fix exec + Sonnet retry ------------------------------
  let fixOutcome: FixCommandOutcome | undefined;
  if (diagnosis.cause !== "unknown" && diagnosis.fixCommand !== null) {
    fixOutcome = await runFixCommand({
      sandbox,
      argv: diagnosis.fixCommand,
      logFilePath: path.join(logDir, `recovery-fix-${stamp}.log`),
      timeoutMs: 300_000, // 5 min cap; pnpm install on a cold cache fits easily
      diagnosis,
      ...(seams?._execFileP !== undefined
        ? { _execFileP: seams._execFileP }
        : {}),
    });

    if (fixOutcome.success) {
      // Retry the recovery agent with Sonnet + effort high. We accept either
      // RECOVERY_COMPLETE (the recovery prompt's expected marker) or the
      // bare STORY_COMPLETE (if the agent decided to finish the story
      // directly). Both indicate the post-fix retry actually worked.
      sonnetAttempt = await runRecoveryAttempt({
        sandbox,
        model: sonnetModel,
        prompt,
        logFilePath: path.join(logDir, `recovery-sonnet-retry-${stamp}.log`),
        idleTimeoutSeconds,
        attemptName: `recovery-sonnet-retry-it${ctx.iterNum}`,
        // Sonnet retry runs at high effort (configurable via
        // RecoveryLadderConfig.sonnetEffort, default "high"). Threaded
        // through runRecoveryAttempt's new `effort` arg.
        effort: sonnetEffort,
      });

      if (
        sonnetAttempt.runCompleted &&
        (sonnetAttempt.marker === "RECOVERY_COMPLETE" ||
          // STORY_COMPLETE is technically not in RECOVERY_MARKERS, so the
          // current strict extractor would never set it. We still keep this
          // disjunction for forward-compat: if RECOVERY_MARKERS gains
          // STORY_COMPLETE in future, this code keeps working without edit.
          (sonnetAttempt.marker as string) === "STORY_COMPLETE")
      ) {
        const decision = RecoveryDecisionSchema.parse({
          marker: "RECOVERY_COMPLETE" as const,
          fixApplied: true,
          ...(sonnetAttempt.commitSha !== undefined
            ? { commitSha: sonnetAttempt.commitSha }
            : {}),
        });
        return { decision, resolvedBy: "sonnet", sonnet: sonnetAttempt };
      }
    }
  }

  // --- Step 3: escalate to Opus -------------------------------------------
  // Note: ClaudeCodeOptions.effort is "low" | "medium" | "high" | "max" in
  // the current sandcastle release; we default to "xhigh". The cast inside
  // runOpusXhighAttempt is the only `as never` in this file by design —
  // bumping sandcastle will remove the need for it.
  const opusLog = path.join(logDir, `recovery-opus-${stamp}.log`);
  const opusAttempt = await runOpusXhighAttempt({
    sandbox,
    model: opusModel,
    prompt,
    logFilePath: opusLog,
    idleTimeoutSeconds,
    attemptName: `recovery-opus-it${ctx.iterNum}`,
    effort: opusEffort,
  });

  // Synthesise a Sonnet placeholder summary if we never got to Sonnet (e.g.
  // diagnosis was "unknown" or fix failed before the retry). The result type
  // requires a non-undefined `sonnet` field; we use it as a structured carrier
  // for diagnosis/fix telemetry instead of leaving it falsey.
  const sonnetForResult: AttemptSummary =
    sonnetAttempt ??
    ({
      model: sonnetModel,
      logFilePath: undefined,
      runCompleted: false,
      markerFound: false,
      marker: undefined,
      haltReason:
        `skipped sonnet retry: ` +
        formatDiagnosisAndFix(diagnosis, fixOutcome),
      commitSha: undefined,
    } satisfies AttemptSummary);

  if (opusAttempt.runCompleted && opusAttempt.marker === "RECOVERY_COMPLETE") {
    const decision = RecoveryDecisionSchema.parse({
      marker: "RECOVERY_COMPLETE" as const,
      fixApplied: typeof opusAttempt.commitSha === "string",
      ...(opusAttempt.commitSha !== undefined
        ? { commitSha: opusAttempt.commitSha }
        : {}),
    });
    return {
      decision,
      resolvedBy: "opus",
      sonnet: sonnetForResult,
      opus: opusAttempt,
    };
  }

  // Final HALT. Stitch the diagnosis+fix story into the haltReason so the
  // quarantine message has actionable context, not just "opus also halted".
  const fixDescription =
    diagnosis.fixCommand === null
      ? "(no auto-fix available)"
      : diagnosis.fixCommand.join(" ");
  const haltReason =
    `diagnosis: ${diagnosis.cause}; ` +
    `fix tried: ${fixDescription}; ` +
    `opus also halted: ${opusAttempt.haltReason ?? "(no reason given)"}`;

  const decision = RecoveryDecisionSchema.parse({
    marker: "HALT" as const,
    fixApplied: fixOutcome?.success === true,
    haltReason,
  });
  return {
    decision,
    resolvedBy: "opus",
    sonnet: sonnetForResult,
    opus: opusAttempt,
  };
}

// ---------------------------------------------------------------------------
// Internal: fix-command runner
// ---------------------------------------------------------------------------

interface RunFixCommandArgs {
  readonly sandbox: Sandbox;
  readonly argv: readonly string[];
  readonly logFilePath: string;
  /**
   * Hard wall-clock cap. Default 5 minutes. `pnpm install` on a cold cache
   * fits comfortably; anything longer is suspicious and we'd rather
   * escalate than hang.
   */
  readonly timeoutMs: number;
  readonly diagnosis: Diagnosis;
  /**
   * Test seam: when supplied, called instead of the real `execFileP`. The
   * default uses `node:child_process.execFile`. Tests inject a stub so they
   * never spawn real binaries.
   */
  readonly _execFileP?: (
    file: string,
    argv: string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

interface FixCommandOutcome {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr?: string;
  /** Reason the fix did not succeed, if applicable. */
  readonly failureReason?: string;
}

/**
 * Run an environment-fix command DIRECTLY against the sandbox's worktree
 * via `execFile`. No agent involvement.
 *
 * Why no agent: the previous Haiku-based implementation depended on the
 * sandbox auto-granting a Bash tool the agent could call. When the grant
 * was missing, the agent emitted FIX_DONE based on its own hallucination
 * of having executed the command — silently corrupting the recovery
 * decision. Direct `execFile` makes the contract concrete: argv[0] is the
 * binary, argv[1..] are args, the exit code is ground truth.
 *
 * The output (stdout + stderr) is appended to the log file purely for
 * forensics; it is NOT parsed by the caller — exit code 0 is the sole
 * success signal. On non-zero exit we surface the tail of stdout/stderr
 * in `failureReason` so the eventual quarantine message is actionable.
 */
async function runFixCommand(
  args: RunFixCommandArgs,
): Promise<FixCommandOutcome> {
  const { sandbox, argv, logFilePath, timeoutMs, diagnosis } = args;
  if (argv.length === 0) {
    return {
      success: false,
      stdout: "",
      failureReason: "fix argv is empty (planner bug — refusing to run)",
    };
  }

  const exec = args._execFileP ?? execFileP;
  const file = argv[0]!;
  const rest = argv.slice(1);

  let stdout = "";
  let stderr = "";
  try {
    const result = await exec(file, [...rest], {
      cwd: sandbox.worktreePath,
      env: process.env,
      // Node's execFile timeout sends SIGTERM; we surface that as a fix
      // failure (failureReason includes "timeout").
      timeout: timeoutMs,
    });
    stdout = result.stdout;
    stderr = result.stderr;

    // Best-effort log file write — don't fail the fix because logging
    // failed. The forensic log records argv + exit + stdout/stderr so a
    // human inspecting a quarantine message later can see what happened.
    await appendFixLog(logFilePath, {
      argv,
      diagnosis: diagnosis.cause,
      cwd: sandbox.worktreePath,
      exitCode: 0,
      stdout,
      stderr,
    });

    return { success: true, stdout, stderr };
  } catch (err) {
    // execFile rejects with an error carrying `code` (numeric exit), `signal`,
    // `stdout`, `stderr`, and (for spawn failures) `code: "ENOENT"` etc.
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };
    stdout = typeof e.stdout === "string" ? e.stdout : "";
    stderr = typeof e.stderr === "string" ? e.stderr : "";

    let failureReason: string;
    if (e.signal === "SIGTERM") {
      failureReason =
        `fix command timed out after ${timeoutMs}ms ` +
        `(argv=${JSON.stringify(argv)})`;
    } else if (typeof e.code === "string") {
      // Spawn failure — file not found, permission, etc.
      failureReason =
        `fix command failed to spawn (${e.code}): ${e.message}`;
    } else if (typeof e.code === "number") {
      failureReason =
        `fix command exited ${e.code}; ` +
        `stderr tail: ${tailFor(stderr, 400)}; ` +
        `stdout tail: ${tailFor(stdout, 400)}`;
    } else {
      failureReason = `fix command failed: ${e.message}`;
    }

    await appendFixLog(logFilePath, {
      argv,
      diagnosis: diagnosis.cause,
      cwd: sandbox.worktreePath,
      exitCode:
        typeof e.code === "number"
          ? e.code
          : typeof e.code === "string"
            ? e.code
            : "unknown",
      stdout,
      stderr,
      failureReason,
    });

    return { success: false, stdout, stderr, failureReason };
  }
}

/**
 * Append a forensic record of one fix-command run to its per-attempt log.
 * Failures are swallowed — the log is a forensic nice-to-have, not a
 * load-bearing artefact (the caller never reads it back).
 */
async function appendFixLog(
  logFilePath: string,
  entry: {
    argv: readonly string[];
    diagnosis: HaltCause;
    cwd: string;
    exitCode: number | string;
    stdout: string;
    stderr: string;
    failureReason?: string;
  },
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(logFilePath), { recursive: true });
    const lines = [
      `# recovery fix-command run`,
      `argv: ${JSON.stringify(entry.argv)}`,
      `cwd: ${entry.cwd}`,
      `diagnosis: ${entry.diagnosis}`,
      `exit: ${entry.exitCode}`,
      ...(entry.failureReason !== undefined
        ? [`failureReason: ${entry.failureReason}`]
        : []),
      `--- stdout ---`,
      entry.stdout,
      `--- stderr ---`,
      entry.stderr,
      `--- end ---`,
      "",
    ].join("\n");
    await fs.appendFile(logFilePath, lines, "utf8");
  } catch {
    // Forensic log only — never fail the fix because logging failed.
  }
}

/** Tail-truncate output for inclusion in a one-line failureReason. */
function tailFor(s: string, max: number): string {
  if (s.length <= max) return s.trim();
  return `...${s.slice(s.length - max).trim()}`;
}

// ---------------------------------------------------------------------------
// Internal: Opus xhigh attempt
// ---------------------------------------------------------------------------

interface RunOpusXhighArgs {
  readonly sandbox: Sandbox;
  readonly model: string;
  readonly prompt: string;
  readonly logFilePath: string;
  readonly idleTimeoutSeconds: number;
  readonly attemptName: string;
  /**
   * Effort knob for this Opus attempt. Defaults to "xhigh"; "max" is
   * acceptable too (sandcastle's type allows it). When set to "xhigh" we
   * cast through `as never` because the published ClaudeCodeOptions type
   * still lists only "low" | "medium" | "high" | "max" — see jsdoc on the
   * function body for the rationale.
   */
  readonly effort?: "xhigh" | "max";
}

/**
 * Single Opus attempt with the configured effort (default "xhigh"). Mirrors
 * `runRecoveryAttempt` but threads the effort option through. The cast to
 * `never` is the only type escape in this file: sandcastle's published
 * ClaudeCodeOptions type still lists `effort: "low" | "medium" | "high" |
 * "max"` while the underlying CLI already accepts `"xhigh"`. Bumping
 * sandcastle will let us delete this cast.
 */
async function runOpusXhighAttempt(
  args: RunOpusXhighArgs,
): Promise<AttemptSummary> {
  const {
    sandbox,
    model,
    prompt,
    logFilePath,
    idleTimeoutSeconds,
    attemptName,
    effort,
  } = args;

  const effortValue: "xhigh" | "max" = effort ?? "xhigh";

  let stdout = "";
  let lastCommit: string | undefined;
  let runCompleted = false;
  try {
    const result = await sandbox.run({
      // "xhigh" cast through `as never` — see jsdoc above. "max" passes
      // through cleanly (the published type already allows it) but we
      // route both through the same cast for symmetry.
      agent: claudeCode(model, { effort: effortValue as never }),
      prompt,
      maxIterations: 1,
      idleTimeoutSeconds,
      name: attemptName,
      logging: { type: "file", path: logFilePath },
    });
    stdout = result.stdout;
    lastCommit = result.commits.at(-1)?.sha;
    runCompleted = true;
  } catch (err) {
    return {
      model,
      logFilePath,
      runCompleted: false,
      markerFound: false,
      marker: undefined,
      haltReason: `${attemptName} failed before producing a marker: ${(err as Error).message}`,
      commitSha: undefined,
    };
  }

  let marker: "RECOVERY_COMPLETE" | "HALT" | undefined;
  let haltReason: string | undefined;
  try {
    marker = extractMarker(stdout, RECOVERY_MARKERS, { mode: "strict" });
  } catch (err) {
    if (err instanceof MarkerNotFoundError) {
      haltReason =
        `${attemptName} ended without a recognizable marker on the last line. ` +
        `Last line: ${JSON.stringify(err.lastLine)}`;
    } else {
      haltReason = `${attemptName} marker extraction threw: ${(err as Error).message}`;
    }
  }

  if (marker === "HALT") {
    haltReason = extractHaltReason(stdout) ?? "(no reason given)";
  }

  return {
    model,
    logFilePath,
    runCompleted,
    markerFound: marker !== undefined,
    marker,
    haltReason,
    commitSha: lastCommit,
  };
}

/** Compose a one-line summary of the diagnosis + fix attempt for haltReason. */
function formatDiagnosisAndFix(
  diagnosis: Diagnosis,
  fixOutcome: FixCommandOutcome | undefined,
): string {
  const cause: HaltCause = diagnosis.cause;
  const fixPart =
    diagnosis.fixCommand === null
      ? "no auto-fix"
      : `fix=${diagnosis.fixCommand.join(" ")}`;
  if (fixOutcome === undefined) {
    return `cause=${cause}; ${fixPart}; (fix not attempted)`;
  }
  return (
    `cause=${cause}; ${fixPart}; ` +
    (fixOutcome.success
      ? "fix succeeded"
      : `fix failed: ${fixOutcome.failureReason ?? "(no reason)"}`)
  );
}
