/**
 * End-to-end smoke harness.
 *
 *   npm run smoke
 *
 * What this proves:
 *   - The fixture repo can be initialised cleanly in a temp directory.
 *   - The mock sandbox exposes a SandboxProvider + per-role agent shim.
 *   - When the loop runs against canned ALL_CLEAR verdicts, prd.json reaches
 *     status="done", progress.txt records the story, the gh issue gets closed,
 *     and no locks are left behind.
 *
 * What this does NOT prove:
 *   - Real Claude inference, real Docker, real Postgres migrations. Those need
 *     `npm run smoke:integration` (filed as a follow-up — see docs/smoke-results.md).
 *
 * Coordination contract with Track C (loop):
 *   `runLoop` should accept an injectable `runAgent` parameter (or a
 *   `sandboxFactory`) so the harness can swap in the mock. Until that lands,
 *   the smoke runs in **STANDALONE** mode — it drives the mock directly via
 *   the modules Track B/D have already shipped (markers, schemas,
 *   pickNextEligibleStory, markDone, closeIssue). This is enough to validate
 *   the wiring: when Track C lands, swap the inline driver for `runLoop`
 *   without changing the assertions.
 */

import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as fssync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { customAlphabet } from "nanoid";

import {
  parseVerdict,
  ImplementerOutputSchema,
  ReviewerVerdictSchema,
} from "../../src/verdicts/index.js";
import {
  pickNextEligibleStory,
  withSingleInstance,
} from "../../src/state/index.js";
import type { LoopConfig, Story } from "../../src/types.js";

import {
  createMockSandbox,
  type MockSandbox,
  type MockCallRecord,
} from "./mocks/mock-sandbox.js";
import {
  runAllExpectations,
  type ExpectationContext,
} from "./expectations.js";

const execFileP = promisify(execFile);
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/repo",
);

async function copyFixtureToTempDir(): Promise<string> {
  const target = path.join(os.tmpdir(), `sandcastle-smoke-${nanoid()}`);
  await fs.mkdir(target, { recursive: true });
  // Node 20+: fs.cp recursive. Skip the .git dir if it ever sneaks into the
  // fixture (git won't track it but a stray local commit might).
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
  // Append-only JSONL log via a tiny inline node script. Using `node -e` would
  // hit shell-quoting hell with embedded quotes; instead the wrapper file is
  // a node script invoked directly via shebang.
  const nodeBin = process.execPath;
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
  // PATH override + CALLS env — gh executions inherit both via execFile's
  // default env-inheritance.
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
// Standalone driver — used until Track C exposes `runLoop` with sandbox injection.
// Mirrors the bash green-path: claim story -> implementer -> reviewer -> markDone -> closeIssue.
// ---------------------------------------------------------------------------

interface StandaloneDriverDeps {
  readonly config: LoopConfig;
  readonly sandbox: MockSandbox;
}

interface StandaloneResult {
  readonly storyShipped: Story | null;
  readonly commits: readonly string[];
}

async function runStandalone(
  deps: StandaloneDriverDeps,
): Promise<StandaloneResult> {
  const { config, sandbox } = deps;

  const story = await pickNextEligibleStory(config.repoRoot);
  if (!story) {
    throw new Error("smoke: fixture had no pending story to claim");
  }
  if (typeof story.ghIssue !== "number") {
    throw new Error("smoke: fixture story has no ghIssue");
  }

  // Implementer.
  const implRun = await sandbox.runAgent({
    role: "implementer",
    model: config.models.implementer,
    prompt: `[smoke] Implement story ${story.id}`,
  });
  // Validate the verdict shape using Track B's parser — even on the canned
  // path, we want to exercise the real schema so a contract drift surfaces
  // here. The mock emits plain assistant text (not stream-json envelopes), so
  // `alreadyAssistantText: true` skips the envelope-strip step.
  parseVerdict(implRun.stdout, ImplementerOutputSchema, {
    alreadyAssistantText: true,
  });
  const implCommits = implRun.commits.map((c) => c.sha);

  // Reviewer.
  const reviewRun = await sandbox.runAgent({
    role: "reviewer",
    model: config.models.reviewer,
    prompt: `[smoke] Review story ${story.id}`,
  });
  parseVerdict(reviewRun.stdout, ReviewerVerdictSchema, {
    alreadyAssistantText: true,
  });

  // Mark done — uses Track D's atomic markDone if exposed, else a local fallback.
  // markDone is intentionally NOT in src/state/index.ts barrel yet (only
  // claimStory/pickNextEligibleStory/releaseStory are re-exported), so we
  // import it from the leaf module directly.
  const { markDone } = await import("../../src/state/prd.js");
  const finalSha =
    implCommits[implCommits.length - 1] ?? "deadbeefdeadbeefdeadbeefdeadbeef";
  await markDone(config.repoRoot, story.id, finalSha, 1, story.title);

  // Close the GH issue (hits the gh stub installed earlier).
  const { closeIssue } = await import("../../src/state/gh.js");
  try {
    await closeIssue(story.ghIssue, `RALPH(smoke) closed by commit ${finalSha}`);
  } catch (err) {
    // Stub failure is fatal in smoke — the harness is what controls the gh CLI.
    throw new Error(`smoke: gh close stub failed: ${(err as Error).message}`);
  }

  return { storyShipped: story, commits: implCommits };
}

// ---------------------------------------------------------------------------
// runLoop integration path — exists only when Track C lands
// `src/loop/index.ts` exporting `runLoop({ config, runAgent })`. The smoke
// dynamic-imports that module so a missing export doesn't cascade into a
// type-time failure for everything else.
// ---------------------------------------------------------------------------

/**
 * Track C ships `runLoop({ config, branch, sandboxProvider })`. The smoke
 * module hands it the mock provider; the loop's internal `runIteration`
 * still expects a real `Sandbox` (returned by `createSandbox`), so for
 * end-to-end coverage Track C also needs to expose an injectable
 * `runAgent` (or per-role hook) — see docs/smoke-results.md for the request.
 *
 * Until that lands, this function probes for `runLoop` and either runs it
 * (if the loop module compiles + accepts the mock) OR falls back to standalone.
 */
async function tryRunLoopIntegration(
  config: LoopConfig,
  sandbox: MockSandbox,
): Promise<{ ran: boolean; reason?: string }> {
  const loopIndexPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/loop/index.ts",
  );
  if (!fssync.existsSync(loopIndexPath)) {
    return { ran: false, reason: "src/loop/index.ts not present yet (Track C pending)" };
  }
  let mod: unknown;
  try {
    mod = await import("../../src/loop/index.js");
  } catch (err) {
    return {
      ran: false,
      reason: `Track C loop module failed to import: ${(err as Error).message}`,
    };
  }
  if (typeof mod !== "object" || mod === null) {
    return { ran: false, reason: "src/loop/index.ts default export shape unexpected" };
  }
  const candidate = (mod as { runLoop?: unknown }).runLoop;
  if (typeof candidate !== "function") {
    return { ran: false, reason: "src/loop/index.ts does not export runLoop()" };
  }
  // The current Track C runLoop signature requires { config, branch,
  // sandboxProvider } and uses sandcastle's createSandbox internally.
  // Until Track C exposes a per-role `runAgent` injection point, calling
  // runLoop here would require a real sandbox runtime — out of scope for
  // unit smoke. Document and fall back.
  return {
    ran: false,
    reason:
      "Track C runLoop accepts {config, branch, sandboxProvider} but has no runAgent hook; smoke needs that injection point to exercise the loop without sandcastle.run(). Falling back to standalone.",
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
// Main
// ---------------------------------------------------------------------------

interface SmokeOutcome {
  readonly mode: "runLoop" | "standalone";
  readonly repoRoot: string;
  readonly failures: readonly string[];
  readonly checks: readonly string[];
  readonly callRecord: readonly MockCallRecord[];
  readonly warnings: readonly string[];
}

async function main(): Promise<SmokeOutcome> {
  console.log("[smoke] copying fixture to temp dir");
  const repoRoot = await copyFixtureToTempDir();
  console.log(`[smoke] fixture at ${repoRoot}`);

  console.log("[smoke] git init in fixture");
  gitInitFixture(repoRoot);

  console.log("[smoke] installing gh stub");
  const gh = await installGhStub();

  const sandbox = createMockSandbox();
  const config = defaultLoopConfig(repoRoot);

  // Drive under a single-instance lock so we exercise that surface, mirroring
  // what runLoop would do. The lock target lives outside the repoRoot so a
  // stale lock-dir doesn't trip the "no leaked lockfile" assertion.
  const lockPath = path.join(os.tmpdir(), `sandcastle-smoke-driver-${nanoid()}.lock`);
  let mode: SmokeOutcome["mode"] = "standalone";
  try {
    await withSingleInstance(lockPath, async () => {
      const integration = await tryRunLoopIntegration(config, sandbox);
      if (integration.ran) {
        mode = "runLoop";
        console.log("[smoke] mode=runLoop (Track C integrated)");
      } else {
        mode = "standalone";
        console.log(`[smoke] mode=standalone (${integration.reason})`);
        await runStandalone({ config, sandbox });
      }
    });
  } finally {
    // Lock target itself is a tmpfile — proper-lockfile creates <path>.lock
    // alongside; clean both.
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
    await fs.rm(`${lockPath}.lock`, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  console.log("[smoke] running expectations");
  const ghCalls = await gh.readCalls();
  const ctx: ExpectationContext = {
    repoRoot,
    sandbox,
    storyId: "smoke.1",
    ghIssue: 999,
    ghCalls,
  };
  const report = await runAllExpectations(ctx);

  const warnings = await cleanup(repoRoot, gh);

  return {
    mode,
    repoRoot,
    failures: report.failures,
    checks: report.checks,
    callRecord: sandbox.calls,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

void (async (): Promise<void> => {
  try {
    const outcome = await main();
    console.log("");
    console.log(`[smoke] mode=${outcome.mode}`);
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
    console.error(`[smoke] FAIL — uncaught error: ${(err as Error).stack ?? (err as Error).message}`);
    process.exit(2);
  }
})();
// keep execFileP referenced so unused-imports rules in stricter setups stay quiet
void execFileP;
