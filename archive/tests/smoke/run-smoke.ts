/**
 * End-to-end smoke harness — drives the production `runLoop` against a mocked
 * sandbox + label state-machine.
 *
 *   npm run smoke
 *
 * What this proves (v1.1):
 *   - `src/loop/index.ts`'s `runLoop` accepts the test seams it advertises and
 *     produces a usable IterationResult[] when fed canned inputs.
 *   - The label state-machine surface (claimViaLabel, markDoneViaLabel,
 *     quarantineViaLabel) is invoked by the loop in the right order — captured
 *     via a `gh` PATH stub.
 *   - The implementer + reviewer briefings embed the issue body verbatim AT THE
 *     SAME byte offset (prompt-cache locality contract).
 *   - `progress.txt` records at least one `[it=N]` line per shipped iteration.
 *   - The single-instance lock acquires + releases cleanly with no leaked dirs.
 *   - The Planner runs exactly ONCE per loop wake-up (Fix #2), never per
 *     iteration.
 *
 * What this does NOT prove:
 *   - Real Claude inference (the agent runner returns canned strings).
 *   - Real Docker / Podman / Vercel sandboxing (the Sandbox handle is a stub
 *     whose `run()` throws — the loop must use `_agentRunner` instead).
 *   - Real Postgres migrations (the iteration calls applyMigrationsBetween
 *     which short-circuits when preSha === postSha; the smoke fixture stays
 *     SQL-free so this is a no-op).
 *   - Real `gh` API behavior (a PATH stub captures argv to JSONL).
 *
 * Reviewer #20 contract: a green smoke MUST mean v1.1's actual `runLoop`
 * shipped smoke.1. The standalone fallback path is gone — if the runLoop
 * import or invocation fails, the smoke fails.
 */

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { customAlphabet } from "nanoid";

import { runLoop } from "../../loop/index.js";
import type { RunLoopOptions } from "../../loop/index.js";
import type { IssueRef } from "../../loop/index.js";
import type { ReadyIssueSummary } from "../../../src/state/index.js";
import type {
  PlannerInput,
  PlannerOutput,
} from "../../planner/index.js";
import type { IterationResult, LoopConfig } from "../../../src/types.js";

import {
  createMockSandbox,
  type AgentRole as MockAgentRole,
  type FailureMode as MockFailureMode,
  type MockSandbox,
  type MockCallRecord,
} from "./mocks/mock-sandbox.js";
import {
  runAllExpectations,
  runInvalidJsonExpectations,
  type ExpectationContext,
  type RunLoopArtifacts,
} from "./expectations.js";

/**
 * Smoke variant selector.
 *
 *   - "green" (default) — Wave 1 baseline. Implementer ships clean, reviewer
 *     ALL_CLEARs, loop calls markDoneViaLabel + closeIssue. 13 assertions in
 *     `runAllExpectations`.
 *
 *   - "invalid-json" — Wave 1 N1 regression smoke. Implementer emits a valid
 *     STORY_COMPLETE marker on the last line BUT a broken JSON envelope.
 *     `runImplementer` throws; iteration.ts catches and routes to the
 *     recovery ladder; recovery's `sandbox.run()` calls hit the stub's
 *     throw → ladder synthesises HALT → iteration quarantines via label and
 *     returns outcome="halted". Assertions in `runInvalidJsonExpectations`
 *     (~10 checks) prove the issue is NOT shipped, NOT closed, and the
 *     `in-progress` -> `needs-human` label transition fired.
 *
 * Selected via the `SMOKE_MODE` env var; CLI argv `--mode=<x>` is also
 * accepted as a convenience wrapper.
 */
type SmokeMode = "green" | "invalid-json";

function resolveSmokeMode(): SmokeMode {
  const argv = process.argv.slice(2);
  for (const a of argv) {
    if (a.startsWith("--mode=")) {
      const v = a.slice("--mode=".length).trim();
      if (v === "green" || v === "invalid-json") return v;
      throw new Error(
        `Unknown --mode=${JSON.stringify(v)}. Expected 'green' or 'invalid-json'.`,
      );
    }
  }
  const env = (process.env.SMOKE_MODE ?? "").trim();
  if (env === "" || env === "green") return "green";
  if (env === "invalid-json") return "invalid-json";
  throw new Error(
    `Unknown SMOKE_MODE=${JSON.stringify(env)}. Expected 'green' or 'invalid-json'.`,
  );
}

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/repo",
);

const SMOKE_STORY_ID = "smoke.1";
const SMOKE_GH_ISSUE = 999;
const SMOKE_ISSUE_TITLE = "smoke.1: add hello fn";
const SMOKE_ISSUE_BODY =
  "Acceptance: a hello() function is exported.";
const SMOKE_BRANCH = "agent/smoke.1";

async function copyFixtureToTempDir(): Promise<string> {
  const target = path.join(os.tmpdir(), `sandcastle-smoke-${nanoid()}`);
  await fs.mkdir(target, { recursive: true });
  // Skip any stray .git the fixture might have picked up locally.
  await fs.cp(FIXTURE_DIR, target, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.git${path.sep}`),
  });
  return target;
}

function gitInitFixture(repoRoot: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Smoke Harness",
    GIT_AUTHOR_EMAIL: "smoke@example.com",
    GIT_COMMITTER_NAME: "Smoke Harness",
    GIT_COMMITTER_EMAIL: "smoke@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot, env });
  execFileSync("git", ["add", "."], { cwd: repoRoot, env });
  execFileSync(
    "git",
    ["commit", "-q", "-m", "smoke: initial fixture commit"],
    { cwd: repoRoot, env },
  );
}

function defaultLoopConfig(repoRoot: string): LoopConfig {
  return {
    repoRoot,
    maxIterations: 1,
    consecutiveFailureLimit: 3,
    agentTimeouts: {
      implementer: 60_000,
      reviewer: 30_000,
      fixer: 30_000,
      recovery: 30_000,
    },
    models: {
      implementer: "sonnet",
      reviewer: "haiku",
      fixer: "sonnet",
      recovery: "sonnet",
      recoveryEscalated: "opus",
    },
  };
}

// ---------------------------------------------------------------------------
// gh stub — install a PATH override so `gh ...` invocations get captured
// instead of hitting the real CLI. Records every call for the assertions.
// The runLoop code-path that reaches gh: claimViaLabel / markDoneViaLabel /
// quarantineViaLabel / postIssueComment / closeIssue — all via execFile.
// ---------------------------------------------------------------------------

interface GhCall {
  readonly args: readonly string[];
}

interface GhStub {
  readonly binDir: string;
  readonly callsPath: string;
  readCalls(): Promise<readonly GhCall[]>;
  cleanup(): Promise<void>;
}

async function installGhStub(): Promise<GhStub> {
  const binDir = path.join(os.tmpdir(), `sandcastle-smoke-bin-${nanoid()}`);
  await fs.mkdir(binDir, { recursive: true });
  const callsPath = path.join(binDir, "gh-calls.jsonl");
  const ghPath = path.join(binDir, "gh");
  const nodeBin = process.execPath;
  // Tiny inline node shebang script: append-only argv log, exitCode 0.
  const script = `#!${nodeBin}
const fs = require('node:fs');
const callsPath = process.env.CALLS;
if (callsPath) {
  fs.appendFileSync(callsPath, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
}
process.exit(0);
`;
  await fs.writeFile(ghPath, script, { mode: 0o755 });
  await fs.chmod(ghPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.CALLS = callsPath;

  return {
    binDir,
    callsPath,
    readCalls: async (): Promise<readonly GhCall[]> => {
      try {
        const raw = await fs.readFile(callsPath, "utf8");
        return raw
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as GhCall);
      } catch {
        return [];
      }
    },
    cleanup: async (): Promise<void> => {
      // Restore PATH (best-effort — leak-tolerant for a one-shot smoke).
      const parts = (process.env.PATH ?? "").split(path.delimiter);
      process.env.PATH = parts.filter((p) => p !== binDir).join(path.delimiter);
      delete process.env.CALLS;
      await fs.rm(binDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// runLoop wiring — every test seam built explicitly. The `runLoop` import is
// the LOAD-BEARING contract: a missing export, a signature change, or a
// throw inside the loop FAILS the smoke. There is no fallback.
// ---------------------------------------------------------------------------

interface CountingPlanner {
  callCount: number;
  lastInput: PlannerInput | null;
  fn: NonNullable<RunLoopOptions["_runPlanner"]>;
}

function buildCountingPlanner(): CountingPlanner {
  // Use a mutable closure object so callers can read callCount AFTER runLoop
  // returns. The function returned satisfies runPlanner's signature.
  const state: { callCount: number; lastInput: PlannerInput | null } = {
    callCount: 0,
    lastInput: null,
  };
  const fn: NonNullable<RunLoopOptions["_runPlanner"]> = async (
    _sandbox,
    input,
  ): Promise<PlannerOutput> => {
    state.callCount += 1;
    state.lastInput = input;
    // Canned output: a single issue, no blockers. The loop walks priorityOrder,
    // claims the issue, runs the iteration, and ships.
    return {
      priorityOrder: [SMOKE_GH_ISSUE],
      dependencies: [],
    };
  };
  // Return an object whose getters reflect the closure state at call time.
  return {
    get callCount(): number {
      return state.callCount;
    },
    get lastInput(): PlannerInput | null {
      return state.lastInput;
    },
    fn,
  };
}

interface CapturedAgentCall {
  readonly role: MockAgentRole;
  readonly prompt: string;
}

interface SmokeOutcome {
  readonly mode: "runLoop";
  readonly variant: SmokeMode;
  readonly repoRoot: string;
  readonly failures: readonly string[];
  readonly checks: readonly string[];
  readonly callRecord: readonly MockCallRecord[];
  readonly warnings: readonly string[];
  readonly artifacts: RunLoopArtifacts;
}

async function main(variant: SmokeMode): Promise<SmokeOutcome> {
  console.log(`[smoke] variant=${variant}`);
  console.log("[smoke] copying fixture to temp dir");
  const repoRoot = await copyFixtureToTempDir();
  console.log(`[smoke] fixture at ${repoRoot}`);

  console.log("[smoke] git init in fixture");
  gitInitFixture(repoRoot);

  console.log("[smoke] installing gh stub");
  const gh = await installGhStub();

  // Wave 1 N1 variant — feed the mock sandbox a failure mode whose canned
  // implementer stdout has STORY_COMPLETE on the last line BUT a broken JSON
  // envelope. runImplementer must throw; iteration.ts must route to the
  // recovery ladder; the ladder must end in HALT (the stub's sandbox.run()
  // throws on every call); the iteration must quarantine.
  const failureMode: MockFailureMode =
    variant === "invalid-json" ? "implementer-invalid-json" : "none";
  const sandbox = createMockSandbox({ branch: SMOKE_BRANCH, failureMode });
  const config = defaultLoopConfig(repoRoot);

  // Per-role prompt capture — used by the "issue body verbatim at same offset"
  // assertion. The mock-sandbox's `runAgent` already records prompt strings,
  // but capturing them again here scopes the data to exactly what passed
  // through the runLoop seam (independent witness).
  const promptCaptures: CapturedAgentCall[] = [];

  const planner = buildCountingPlanner();

  // Test-seam stubs the loop calls instead of shelling out. Each one tracks
  // its own invocation count for the expectations.
  let listInProgressCalls = 0;
  let listReadyCalls = 0;
  const transitionCalls: Array<{ from: string; to: string; issueNum: number }> = [];
  const fetchIssueBodyCalls: number[] = [];
  const isIssueDoneCalls: number[] = [];
  const commentOnIssueCalls: Array<{ issueNum: number; body: string }> = [];
  let withSingleInstanceCalls = 0;

  const cannedIssue: IssueRef = {
    title: SMOKE_ISSUE_TITLE,
    body: SMOKE_ISSUE_BODY,
    labels: ["ready-for-agent"],
    number: SMOKE_GH_ISSUE,
  };

  const cannedReadySummary: ReadyIssueSummary = {
    number: SMOKE_GH_ISSUE,
    title: SMOKE_ISSUE_TITLE,
    body: SMOKE_ISSUE_BODY,
    labels: ["ready-for-agent"],
    createdAt: "2026-05-07T00:00:00Z",
  };

  const opts: RunLoopOptions = {
    config,
    branch: SMOKE_BRANCH,
    sandboxProvider: sandbox.provider,
    recoveryPromptPath: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../refs/recovery-prompt.md.local-fork",
    ),
    consecutiveHaltLimit: 3,

    // === Test seams ====================================================

    /** Replace createSandbox so the loop never tries to spawn Docker. */
    _createSandbox: async (): Promise<ReturnType<MockSandbox["buildSandboxStub"]>> => {
      // Worktree path = the real repoRoot so iteration's git rev-parse / diff
      // helpers operate on the smoke fixture (not a phantom path).
      return sandbox.buildSandboxStub(SMOKE_BRANCH, repoRoot);
    },

    /** Replace gh issue-list. The loop walks this once at wake-up. */
    _listReadyIssues: async (): Promise<ReadyIssueSummary[]> => {
      listReadyCalls += 1;
      return [cannedReadySummary];
    },

    /** Replace startup-recovery sweep — nothing stranded in the smoke. */
    _listInProgressIssues: async (): Promise<number[]> => {
      listInProgressCalls += 1;
      return [];
    },

    /**
     * Replace the label transition used by startup recovery. The loop only
     * calls this from the recovery sweep (when listInProgress returns
     * non-empty), so in this smoke it should never fire — but providing it
     * keeps any host's real `gh` behavior off the table.
     */
    _transitionLabel: async (
      issueNum: number,
      from: string,
      to: string,
    ): Promise<void> => {
      transitionCalls.push({ issueNum, from, to });
    },

    /** Pre-canned planner output, no real agent call. */
    _runPlanner: planner.fn,

    /** Replace gh issue-view fetch — feed the same body the planner saw. */
    _fetchIssueBody: async (ghIssue: number): Promise<IssueRef> => {
      fetchIssueBodyCalls.push(ghIssue);
      return cannedIssue;
    },

    /** Blocker-state probe — no blockers in the smoke priorityOrder. */
    _isIssueDone: async (issueNum: number): Promise<boolean> => {
      isIssueDoneCalls.push(issueNum);
      return false;
    },

    /** No-op the single-instance gate — the smoke wraps its own lock OUTSIDE the loop. */
    _withSingleInstance: async <T>(
      _lockPath: string,
      fn: () => Promise<T>,
    ): Promise<T> => {
      withSingleInstanceCalls += 1;
      return fn();
    },

    /** Capture ship-with-issue-OPEN comments. Should NOT fire on green path. */
    _commentOnIssue: async (issueNum: number, body: string): Promise<void> => {
      commentOnIssueCalls.push({ issueNum, body });
    },

    /**
     * The load-bearing seam. Every per-role agent call goes through this —
     * stdout / commits / completionSignal returned synthetically. Also
     * captures the prompt text so expectations can assert byte-for-byte
     * locality between implementer and reviewer briefings.
     */
    _agentRunner: async (role, _model, prompt): Promise<{
      stdout: string;
      commits: { sha: string }[];
      completionSignal?: string;
    }> => {
      promptCaptures.push({ role, prompt });
      const out = await sandbox.runAgent({
        role,
        model: _model,
        prompt,
      });
      return {
        stdout: out.stdout,
        commits: out.commits.map((c) => ({ sha: c.sha })),
        completionSignal: out.completionSignal,
      };
    },
  };

  console.log("[smoke] mode=runLoop (production loop)");
  const iterationResults: IterationResult[] = await runLoop(opts);

  console.log("[smoke] runLoop returned; running expectations");
  const ghCalls = await gh.readCalls();
  const artifacts: RunLoopArtifacts = {
    iterationResults,
    plannerCallCount: planner.callCount,
    listReadyCalls,
    listInProgressCalls,
    transitionCalls,
    fetchIssueBodyCalls,
    isIssueDoneCalls,
    commentOnIssueCalls,
    withSingleInstanceCalls,
    promptCaptures,
    issueBody: SMOKE_ISSUE_BODY,
  };
  const ctx: ExpectationContext = {
    repoRoot,
    sandbox,
    storyId: SMOKE_STORY_ID,
    ghIssue: SMOKE_GH_ISSUE,
    ghCalls,
    artifacts,
  };
  const report =
    variant === "invalid-json"
      ? await runInvalidJsonExpectations(ctx)
      : await runAllExpectations(ctx);

  const warnings = await cleanup(repoRoot, gh);

  return {
    mode: "runLoop",
    variant,
    repoRoot,
    failures: report.failures,
    checks: report.checks,
    callRecord: sandbox.calls,
    warnings,
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Cleanup — best-effort; we don't fail the smoke if cleanup itself fails,
// but we DO log so a leftover temp dir doesn't go silently.
// ---------------------------------------------------------------------------

async function cleanup(repoRoot: string, gh: GhStub): Promise<string[]> {
  const warnings: string[] = [];
  try {
    await fs.rm(repoRoot, { recursive: true, force: true });
  } catch (err) {
    warnings.push(
      `cleanup: failed to remove ${repoRoot}: ${(err as Error).message}`,
    );
  }
  try {
    await gh.cleanup();
  } catch (err) {
    warnings.push(`cleanup: gh stub teardown failed: ${(err as Error).message}`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

void (async (): Promise<void> => {
  try {
    const variant = resolveSmokeMode();
    const outcome = await main(variant);
    console.log("");
    console.log(`[smoke] mode=${outcome.mode} variant=${outcome.variant}`);
    console.log(`[smoke] iteration results:`);
    for (const r of outcome.artifacts.iterationResults) {
      console.log(
        `  - story=${r.story.id} outcome=${r.outcome} iterations=${r.iterationsUsed}`,
      );
    }
    console.log(`[smoke] checks run: ${outcome.checks.length}`);
    for (const c of outcome.checks) {
      console.log(`  - ${c}`);
    }
    console.log(`[smoke] agent calls in order:`);
    for (const call of outcome.callRecord) {
      console.log(
        `  - ${call.role} (model=${call.model}) -> ${call.resultMarker}`,
      );
    }
    if (outcome.warnings.length > 0) {
      console.log(`[smoke] warnings:`);
      for (const w of outcome.warnings) {
        console.log(`  - ${w}`);
      }
    }
    if (outcome.failures.length === 0) {
      console.log("");
      console.log("[smoke] PASS");
      process.exit(0);
    }
    console.log("");
    console.log(`[smoke] FAIL — ${outcome.failures.length} assertion(s)`);
    for (const f of outcome.failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  } catch (err) {
    console.error(
      `[smoke] FAIL — uncaught error: ${(err as Error).stack ?? (err as Error).message}`,
    );
    process.exit(2);
  }
})();
