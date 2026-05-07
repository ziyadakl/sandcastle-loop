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
import { runRecoveryLadder } from "../src/recovery/ladder.js";
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
