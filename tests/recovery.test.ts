/**
 * Recovery ladder + quarantine tests.
 *
 * The sandbox handle is mocked end-to-end: we don't spin up a container,
 * we hand `runRecoveryLadder` an object that satisfies the Sandbox interface
 * for the methods the ladder actually invokes (only `.run()`).
 *
 * Each test seeds canned `sandbox.run()` outputs and asserts the resulting
 * RecoveryDecision shape + which tier resolved.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Sandbox,
  SandboxRunOptions,
  SandboxRunResult,
} from "@ai-hero/sandcastle";
import {
  runRecoveryLadder,
  runRecoveryDiagnosisOrEscalate,
} from "../src/recovery/ladder.js";
import { diagnoseHaltCause } from "../src/recovery/diagnose.js";
import { quarantineStory } from "../src/recovery/quarantine.js";
import type { IterationContext, Story } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_PROMPT = `# Recovery agent — read this first

Verify with: __VERIFY_COMMANDS__

__INTEGRATION_CHECK_BLOCK__

End with RECOVERY_COMPLETE or <promise>HALT</promise>.
`;

async function writePromptFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-recovery-"));
  const p = path.join(dir, "recovery-prompt.md");
  await fs.writeFile(p, FAKE_PROMPT, "utf8");
  return p;
}

const STORY: Story = {
  id: "S-101",
  title: "Make the gizmo do the thing",
  status: "in_progress",
  ghIssue: 42,
  attempts: 1,
};

const CTX: IterationContext = {
  iterNum: 3,
  iterTotal: 50,
  story: STORY,
  branch: "agent/S-101",
  preSha: "deadbeef",
  startedAt: 1_700_000_000_000,
};

const HALT = {
  reason: "implementer timeout at 20m",
  priorRc: 124,
  priorWho: "implementer",
};

// ---------------------------------------------------------------------------
// Sandbox mock helpers
// ---------------------------------------------------------------------------

interface CannedRun {
  /** Either canned stdout or a function that throws to simulate run failure. */
  readonly stdout?: string;
  readonly throws?: Error;
  readonly commits?: { sha: string }[];
}

function makeMockSandbox(canned: CannedRun[]): {
  sandbox: Sandbox;
  calls: Array<{ model: string; logFilePath?: string; prompt: string }>;
} {
  const queue = [...canned];
  const calls: Array<{ model: string; logFilePath?: string; prompt: string }> = [];
  const sandbox = {
    branch: "agent/S-101",
    worktreePath: "/fake/worktree",
    async run(opts: SandboxRunOptions): Promise<SandboxRunResult> {
      // The agent provider's exact internal shape is opaque; ladder uses
      // claudeCode("model"). For test purposes we read from the
      // AgentProvider object reflectively if it carries the model in
      // __TEST_MODEL (set via the vi.mock below).
      const recorded = {
        model:
          (opts.agent as unknown as { __TEST_MODEL?: string }).__TEST_MODEL ??
          "",
        prompt: opts.prompt ?? "",
        logFilePath:
          opts.logging && opts.logging.type === "file"
            ? opts.logging.path
            : undefined,
      };
      calls.push(recorded);
      const next = queue.shift();
      if (!next) {
        throw new Error("mock sandbox.run: no canned response left");
      }
      if (next.throws) throw next.throws;
      return {
        iterations: [],
        completionSignal: undefined,
        stdout: next.stdout ?? "",
        commits: next.commits ?? [],
        logFilePath: recorded.logFilePath,
      } as SandboxRunResult;
    },
    async interactive() {
      throw new Error("not used in test");
    },
    async close() {
      return {};
    },
    [Symbol.asyncDispose]: async () => {},
  } satisfies Sandbox;
  return { sandbox, calls };
}

// Patch the claudeCode factory so tests can recover the model string. We
// monkey-patch on the imported module via vi.mock to keep the ladder pure.
vi.mock("@ai-hero/sandcastle", async (orig) => {
  const real = await orig<typeof import("@ai-hero/sandcastle")>();
  return {
    ...real,
    claudeCode: (model: string) => {
      // Tag the provider with the model so the test mock can read it.
      const provider = real.claudeCode(model);
      return Object.assign(provider, { __TEST_MODEL: model });
    },
  };
});

let promptPath = "";
beforeEach(async () => {
  promptPath = await writePromptFile();
});

// ---------------------------------------------------------------------------
// Ladder tests
// ---------------------------------------------------------------------------

describe("runRecoveryLadder", () => {
  it("Sonnet success → resolves with RECOVERY_COMPLETE; Opus is never called", async () => {
    const { sandbox, calls } = makeMockSandbox([
      {
        stdout: "did the work\n\nRECOVERY_COMPLETE\n",
        commits: [{ sha: "cafef00d" }],
      },
    ]);

    const tmpLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-log-"));
    const result = await runRecoveryLadder(sandbox, CTX, HALT, {
      promptTemplatePath: promptPath,
      logDir: tmpLogDir,
      verifyCommands: "pnpm typecheck",
      idleTimeoutSeconds: 60,
    });

    expect(result.resolvedBy).toBe("sonnet");
    expect(result.decision.marker).toBe("RECOVERY_COMPLETE");
    expect(result.decision.fixApplied).toBe(true);
    expect(result.decision.commitSha).toBe("cafef00d");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("claude-sonnet-4-6");
    // Placeholder substitution actually happened
    expect(calls[0]!.prompt).toContain("Verify with: pnpm typecheck");
    expect(calls[0]!.prompt).not.toContain("__VERIFY_COMMANDS__");
    // Context block appended
    expect(calls[0]!.prompt).toContain("- story id: S-101");
    expect(calls[0]!.prompt).toContain("- iteration: 3 / 50");
  });

  it("Sonnet fails → escalates to Opus on a SEPARATE log file; Opus succeeds", async () => {
    const { sandbox, calls } = makeMockSandbox([
      // Sonnet — emits HALT. The marker discipline requires the bare
      // marker on the LAST non-empty line, so prose explaining the HALT
      // goes BEFORE the marker, not after.
      {
        stdout:
          "tried to fix and could not\nThe dev DB seems wedged; Sonnet bailed.\n\n<promise>HALT</promise>\n",
      },
      // Opus — emits RECOVERY_COMPLETE
      {
        stdout: "fixed the wedge\n\nRECOVERY_COMPLETE\n",
        commits: [{ sha: "abc12345" }],
      },
    ]);

    const tmpLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-log-"));
    const result = await runRecoveryLadder(sandbox, CTX, HALT, {
      promptTemplatePath: promptPath,
      logDir: tmpLogDir,
    });

    expect(result.resolvedBy).toBe("opus");
    expect(result.decision.marker).toBe("RECOVERY_COMPLETE");
    expect(result.decision.commitSha).toBe("abc12345");
    expect(result.sonnet.marker).toBe("HALT");
    expect(result.opus?.marker).toBe("RECOVERY_COMPLETE");

    // CRITICAL: Sonnet and Opus MUST have written to different log files,
    // otherwise Opus's context could be polluted by Sonnet's reasoning.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.logFilePath).toBeDefined();
    expect(calls[1]!.logFilePath).toBeDefined();
    expect(calls[0]!.logFilePath).not.toBe(calls[1]!.logFilePath);
    expect(calls[0]!.model).toBe("claude-sonnet-4-6");
    expect(calls[1]!.model).toBe("claude-opus-4-7");
  });

  it("Both Sonnet and Opus HALT → returns marker=HALT with the Opus reason preferred", async () => {
    const { sandbox, calls } = makeMockSandbox([
      {
        stdout:
          "sonnet says: stuck on auth\n\n<promise>HALT</promise>\n",
      },
      {
        stdout:
          "opus says: external API dead\n\n<promise>HALT</promise>\n",
      },
    ]);
    const tmpLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-log-"));

    const result = await runRecoveryLadder(sandbox, CTX, HALT, {
      promptTemplatePath: promptPath,
      logDir: tmpLogDir,
    });

    expect(result.decision.marker).toBe("HALT");
    expect(result.decision.fixApplied).toBe(false);
    expect(result.decision.haltReason).toContain("opus says: external API dead");
    expect(result.resolvedBy).toBe("opus");
    expect(calls).toHaveLength(2);
  });

  it("Sonnet throws (e.g. abort/timeout) → ladder still escalates to Opus", async () => {
    const { sandbox, calls } = makeMockSandbox([
      { throws: new Error("idle timeout exceeded") },
      {
        stdout: "took over and shipped\n\nRECOVERY_COMPLETE\n",
        commits: [{ sha: "ddccbbaa" }],
      },
    ]);
    const tmpLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-log-"));

    const result = await runRecoveryLadder(sandbox, CTX, HALT, {
      promptTemplatePath: promptPath,
      logDir: tmpLogDir,
    });

    expect(result.sonnet.runCompleted).toBe(false);
    expect(result.sonnet.haltReason).toContain("idle timeout exceeded");
    expect(result.resolvedBy).toBe("opus");
    expect(result.decision.marker).toBe("RECOVERY_COMPLETE");
    expect(calls).toHaveLength(2);
  });

  it("agent ends without a recognizable marker → ladder treats it as a HALT and escalates", async () => {
    const { sandbox } = makeMockSandbox([
      // Sonnet output ends with prose, no bare marker
      {
        stdout:
          "I did some things and now my answer is just running long without a marker line at all.",
      },
      // Opus rescues
      {
        stdout: "RECOVERY_COMPLETE\n",
        commits: [{ sha: "11223344" }],
      },
    ]);
    const tmpLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-log-"));

    const result = await runRecoveryLadder(sandbox, CTX, HALT, {
      promptTemplatePath: promptPath,
      logDir: tmpLogDir,
    });

    expect(result.sonnet.marker).toBeUndefined();
    expect(result.sonnet.haltReason).toContain("recognizable marker");
    expect(result.decision.marker).toBe("RECOVERY_COMPLETE");
  });
});

// ---------------------------------------------------------------------------
// Diagnose-first ladder tests (v1)
// ---------------------------------------------------------------------------

describe("diagnoseHaltCause", () => {
  it("matches ECONNREFUSED localhost:PORT → dev-server-down (no auto-fix)", () => {
    const d = diagnoseHaltCause(
      "fetch failed: ECONNREFUSED localhost:3000",
    );
    expect(d.cause).toBe("dev-server-down");
    expect(d.fixCommand).toBeNull();
    expect(d.confidence).toBe("high");
    expect(d.evidence).toContain("ECONNREFUSED localhost:3000");
  });

  it("matches relation \"X\" does not exist → migration-unapplied", () => {
    const d = diagnoseHaltCause(
      'pg error: relation "users" does not exist',
    );
    expect(d.cause).toBe("migration-unapplied");
    expect(d.fixCommand).toEqual(["pnpm", "db:migrate"]);
  });

  it("matches Cannot find module → deps-missing", () => {
    const d = diagnoseHaltCause(
      "Error: Cannot find module 'react'\n  at ...",
    );
    expect(d.cause).toBe("deps-missing");
    expect(d.fixCommand).toEqual(["pnpm", "install"]);
  });

  it("matches Playwright chromium missing → playwright-not-installed", () => {
    const d = diagnoseHaltCause(
      "Error: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome",
    );
    expect(d.cause).toBe("playwright-not-installed");
    expect(d.fixCommand).toEqual([
      "pnpm",
      "exec",
      "playwright",
      "install",
      "chromium",
    ]);
  });

  it("matches EBADENGINE → node-version-mismatch (no auto-fix)", () => {
    const d = diagnoseHaltCause(
      "ERR_PNPM_BAD_ENV_FOUND  EBADENGINE  Unsupported engine",
    );
    expect(d.cause).toBe("node-version-mismatch");
    expect(d.fixCommand).toBeNull();
  });

  it("falls back to unknown / low confidence on prose with no match", () => {
    const d = diagnoseHaltCause(
      "I tried my best but the code wouldn't compile and I'm tired now.",
    );
    expect(d.cause).toBe("unknown");
    expect(d.fixCommand).toBeNull();
    expect(d.confidence).toBe("low");
  });
});

describe("runRecoveryDiagnosisOrEscalate", () => {
  it("ECONNREFUSED → diagnoses dev-server-down, no fix, escalates straight to Opus", async () => {
    const { sandbox, calls } = makeMockSandbox([
      // Opus rescues
      {
        stdout: "restarted dev server\n\nRECOVERY_COMPLETE\n",
        commits: [{ sha: "feedface" }],
      },
    ]);
    const tmpLogDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ralph-log-"),
    );

    const result = await runRecoveryDiagnosisOrEscalate(
      sandbox,
      CTX,
      {
        ...HALT,
        lastAssistantText:
          "fetch failed: ECONNREFUSED localhost:3000",
      },
      { promptTemplatePath: promptPath, logDir: tmpLogDir },
    );

    // No fix command runs (dev-server-down has no auto-fix). Only Opus runs.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("claude-opus-4-7");
    expect(result.resolvedBy).toBe("opus");
    expect(result.decision.marker).toBe("RECOVERY_COMPLETE");
    expect(result.decision.commitSha).toBe("feedface");
  });

  it("missing migration → diagnoses + runs pnpm db:migrate + Sonnet retry succeeds", async () => {
    const { sandbox, calls } = makeMockSandbox([
      // Fix runner (Haiku) — emits FIX_DONE on its own line
      { stdout: "$ pnpm db:migrate\nDone in 0.5s\n\nFIX_DONE\n" },
      // Sonnet retry — emits RECOVERY_COMPLETE
      {
        stdout: "ran the failing test, all green\n\nRECOVERY_COMPLETE\n",
        commits: [{ sha: "5577cafe" }],
      },
    ]);
    const tmpLogDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ralph-log-"),
    );

    const result = await runRecoveryDiagnosisOrEscalate(
      sandbox,
      CTX,
      {
        ...HALT,
        lastAssistantText:
          'PostgresError: relation "users" does not exist at line 1',
      },
      { promptTemplatePath: promptPath, logDir: tmpLogDir },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.model).toBe("claude-haiku-4-5");
    expect(calls[0]!.prompt).toContain('"pnpm" "db:migrate"');
    expect(calls[1]!.model).toBe("claude-sonnet-4-6");
    expect(result.resolvedBy).toBe("sonnet");
    expect(result.decision.marker).toBe("RECOVERY_COMPLETE");
    expect(result.decision.fixApplied).toBe(true);
    expect(result.decision.commitSha).toBe("5577cafe");
  });

  it("missing module → diagnoses + runs pnpm install + Sonnet retry succeeds", async () => {
    const { sandbox, calls } = makeMockSandbox([
      // Fix runner: pnpm install
      { stdout: "Progress: resolved 100, downloaded 100\n\nFIX_DONE\n" },
      // Sonnet retry
      {
        stdout: "imports resolve now, tests pass\n\nRECOVERY_COMPLETE\n",
        commits: [{ sha: "deadc0de" }],
      },
    ]);
    const tmpLogDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ralph-log-"),
    );

    const result = await runRecoveryDiagnosisOrEscalate(
      sandbox,
      CTX,
      {
        ...HALT,
        lastAssistantText: "Error: Cannot find module 'react'\n  at ...",
      },
      { promptTemplatePath: promptPath, logDir: tmpLogDir },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]!.prompt).toContain('"pnpm" "install"');
    expect(result.resolvedBy).toBe("sonnet");
    expect(result.decision.marker).toBe("RECOVERY_COMPLETE");
    expect(result.decision.fixApplied).toBe(true);
  });

  it("unknown halt prose → skips fix entirely, escalates straight to Opus", async () => {
    const { sandbox, calls } = makeMockSandbox([
      // Only Opus runs
      {
        stdout: "puzzled it out\n\nRECOVERY_COMPLETE\n",
        commits: [{ sha: "11221122" }],
      },
    ]);
    const tmpLogDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ralph-log-"),
    );

    const result = await runRecoveryDiagnosisOrEscalate(
      sandbox,
      CTX,
      {
        ...HALT,
        lastAssistantText:
          "I tried things and now nothing works and I'm sad about it.",
      },
      { promptTemplatePath: promptPath, logDir: tmpLogDir },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("claude-opus-4-7");
    expect(result.resolvedBy).toBe("opus");
    expect(result.decision.marker).toBe("RECOVERY_COMPLETE");
  });

  it("diagnosis but fix command FAILS → escalates to Opus after the fix attempt", async () => {
    const { sandbox, calls } = makeMockSandbox([
      // Fix runner emits FIX_FAILED
      { stdout: "$ pnpm install\nERR_PNPM_FETCH_FAILED\n\nFIX_FAILED\n" },
      // Opus rescues
      {
        stdout: "fixed the registry config\n\nRECOVERY_COMPLETE\n",
        commits: [{ sha: "abad1dea" }],
      },
    ]);
    const tmpLogDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ralph-log-"),
    );

    const result = await runRecoveryDiagnosisOrEscalate(
      sandbox,
      CTX,
      {
        ...HALT,
        lastAssistantText:
          "boot error: Cannot find module 'react'",
      },
      { promptTemplatePath: promptPath, logDir: tmpLogDir },
    );

    // Fix runs (Haiku), then Opus directly — Sonnet retry is skipped because
    // the fix itself didn't succeed.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.model).toBe("claude-haiku-4-5");
    expect(calls[1]!.model).toBe("claude-opus-4-7");
    expect(result.resolvedBy).toBe("opus");
    expect(result.decision.marker).toBe("RECOVERY_COMPLETE");
    expect(result.sonnet.runCompleted).toBe(false);
    expect(result.sonnet.haltReason).toContain("skipped sonnet retry");
  });

  it("diagnosis + fix runs + Sonnet retry HALTs + Opus also HALTs → final HALT mentions both", async () => {
    const { sandbox, calls } = makeMockSandbox([
      // Fix runner — succeeds
      { stdout: "ok\n\nFIX_DONE\n" },
      // Sonnet retry — HALTs
      {
        stdout:
          "still broken\nthe migration applied but the schema is wrong\n\n<promise>HALT</promise>\n",
      },
      // Opus — also HALTs
      {
        stdout:
          "I have analysed and I cannot proceed: schema drift\n\n<promise>HALT</promise>\n",
      },
    ]);
    const tmpLogDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "ralph-log-"),
    );

    const result = await runRecoveryDiagnosisOrEscalate(
      sandbox,
      CTX,
      {
        ...HALT,
        lastAssistantText:
          'pg error: relation "users" does not exist',
      },
      { promptTemplatePath: promptPath, logDir: tmpLogDir },
    );

    expect(calls).toHaveLength(3);
    expect(result.decision.marker).toBe("HALT");
    expect(result.decision.fixApplied).toBe(true); // fix DID succeed even though final state is HALT
    expect(result.decision.haltReason).toContain("diagnosis: migration-unapplied");
    expect(result.decision.haltReason).toContain("fix tried: pnpm db:migrate");
    expect(result.decision.haltReason).toContain("opus also halted");
  });
});

// ---------------------------------------------------------------------------
// Quarantine tests
// ---------------------------------------------------------------------------

describe("quarantineStory", () => {
  async function makePrdRepo(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-prd-"));
    await fs.writeFile(
      path.join(dir, "prd.json"),
      JSON.stringify(
        {
          stories: [
            {
              id: STORY.id,
              title: STORY.title,
              status: "in_progress",
              ghIssue: STORY.ghIssue,
              attempts: 1,
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    return dir;
  }

  it("orchestrates prd mutation + label transition + gh issue comment, swallowing comment failures", async () => {
    const repoRoot = await makePrdRepo();

    // Stub gh: transitionLabel runs inside quarantineStoryInPrd via the real
    // execFile + gh — patch the env so PATH points to a fake gh in a tmp dir.
    // To avoid reaching real gh, we override the gh comment poster via the
    // injection seam, AND we set GH to a no-op binary.
    const fakeGhDir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-fakegh-"));
    const fakeGh = path.join(fakeGhDir, "gh");
    await fs.writeFile(fakeGh, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${fakeGhDir}:${process.env.PATH}`;

    let commentSeen = "";
    await quarantineStory(repoRoot, STORY, "implementer rc=124 (timeout)", {
      _commentPoster: async (issueNum, body) => {
        if (issueNum !== 42) throw new Error(`unexpected issue: ${issueNum}`);
        commentSeen = body;
      },
    });

    // prd.json mutated to quarantined
    const newPrd = JSON.parse(
      await fs.readFile(path.join(repoRoot, "prd.json"), "utf8"),
    );
    expect(newPrd.stories[0].status).toBe("needs_human");
    expect(newPrd.stories[0].quarantineReason).toContain("timeout");

    // Comment body included reason + story id
    expect(commentSeen).toContain("S-101");
    expect(commentSeen).toContain("implementer rc=124 (timeout)");
  });

  it("re-throws when prd mutation itself fails (no prd.json present)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ralph-noprd-"));
    // No prd.json written; quarantineStoryInPrd should reject reading it
    await expect(
      quarantineStory(dir, STORY, "any reason", {
        _commentPoster: async () => {
          /* unreachable */
        },
      }),
    ).rejects.toThrow();
  });
});
