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
import { claudeCode, type Sandbox } from "@ai-hero/sandcastle";
import {
  extractMarker,
  MarkerNotFoundError,
} from "../verdicts/parse.js";
import { RECOVERY_MARKERS } from "../verdicts/markers.js";
import { RecoveryDecisionSchema } from "../verdicts/schemas.js";
import type {
  IterationContext,
  ModelTier,
  RecoveryDecision,
} from "../types.js";

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
  } = args;

  let stdout = "";
  let lastCommit: string | undefined;
  let runCompleted = false;
  try {
    const result = await sandbox.run({
      agent: claudeCode(model),
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
