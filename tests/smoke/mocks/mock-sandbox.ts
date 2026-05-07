/**
 * Mock sandbox for the smoke harness.
 *
 * Two layers:
 *
 *   1. A `BindMountSandboxProvider`-shaped object so it slots into anywhere
 *      `@ai-hero/sandcastle` expects a SandboxProvider. The `exec()` method is
 *      a no-op stub that returns exitCode 0 with empty stdout/stderr — no
 *      Docker, no real shell side-effects. File operations (`copyFileIn`,
 *      `copyFileOut`) are also no-ops.
 *
 *   2. A higher-level `runAgent(role, opts)` API that returns canned
 *      `SandboxRunResult`-shaped objects keyed off the agent role. This is what
 *      Track C's `runLoop` should call (via injected `sandbox` factory) instead
 *      of the real sandcastle `run()`. The loop never sees `claude` — every
 *      role-call returns a deterministic verdict.
 *
 * Each call is recorded so `expectations.ts` can assert order. The mock also
 * supports failure-mode flags ("implementer-halts" / "reviewer-blocks") so
 * future smoke variants can exercise recovery without rewriting fixtures.
 */

import type {
  BindMountSandboxProvider,
  BindMountCreateOptions,
  BindMountSandboxHandle,
  ExecResult,
} from "@ai-hero/sandcastle";

// ---------------------------------------------------------------------------
// Types — mirror the load-bearing slice of @ai-hero/sandcastle SandboxRunResult
// without importing the heavy module surface. Track C is free to consume the
// real type when wiring; this slice is what the smoke needs to assert against.
// ---------------------------------------------------------------------------

export type AgentRole =
  | "implementer"
  | "reviewer"
  | "fixer"
  | "recovery"
  | "reviewer-final";

export interface MockRunOptions {
  readonly role: AgentRole;
  readonly model: string;
  readonly prompt: string;
}

export interface MockRunResult {
  /** Combined assistant text — the loop's verdict extractor parses this. */
  readonly stdout: string;
  /** Commits produced by this run. Stubbed SHAs, deterministic per role. */
  readonly commits: readonly { sha: string }[];
  /** The branch name the loop's run was bound to. */
  readonly branch: string;
  /** Completion signal that fired (mirrors sandcastle SandboxRunResult). */
  readonly completionSignal: string | undefined;
  /** Iteration count — single canned iteration. */
  readonly iterations: readonly { sessionId?: string }[];
  /** Stub log path — never written to. */
  readonly logFilePath: undefined;
}

export interface MockCallRecord {
  readonly role: AgentRole;
  readonly model: string;
  readonly prompt: string;
  readonly resultMarker: string;
  readonly at: number;
}

export type FailureMode =
  | "none"
  | "implementer-halts"
  | "reviewer-blocks-then-fixer-fixes";

export interface MockSandboxOptions {
  readonly failureMode?: FailureMode;
  readonly branch?: string;
  /** Override the canned commit SHA prefix. */
  readonly commitShaPrefix?: string;
}

// ---------------------------------------------------------------------------
// Canned-output assembly
// ---------------------------------------------------------------------------

const STORY_ID = "smoke.1";
const GH_ISSUE = 999;

interface CannedOutput {
  readonly stdout: string;
  readonly marker: string;
  readonly producesCommit: boolean;
}

function canned(role: AgentRole, mode: FailureMode): CannedOutput {
  // Each block ends with a bare-word marker on its own line — Track B's
  // strict extractor matches `^\s*MARKER\s*$`. We embed the load-bearing
  // structured payload as a JSON object inside the assistant text so
  // parseVerdict() (if Track C uses it) finds something Zod-valid.
  switch (role) {
    case "implementer": {
      if (mode === "implementer-halts") {
        const payload = JSON.stringify({
          storyId: STORY_ID,
          ghIssue: GH_ISSUE,
          e2eRan: false,
          e2eVerdict: "halted",
          uiTouched: false,
          certificationPresent: false,
          marker: "HALT",
          haltReason: "smoke: simulated halt",
        });
        return {
          stdout: [
            "[STEP 1/9] Read spec",
            "Smoke implementer halting on purpose to exercise recovery path.",
            payload,
            "",
            "<promise>HALT</promise>",
          ].join("\n"),
          marker: "HALT",
          producesCommit: false,
        };
      }
      const payload = JSON.stringify({
        storyId: STORY_ID,
        ghIssue: GH_ISSUE,
        commitSha: "deadbeefcafefeedfacefeedbabe000000000001",
        e2eRan: true,
        e2eVerdict: "passed",
        uiTouched: false,
        certificationPresent: true,
        marker: "STORY_COMPLETE",
      });
      return {
        stdout: [
          "[STEP 1/9] Read spec",
          "[STEP 9/9] Commit",
          "Implementer added hello() per smoke.1.",
          payload,
          "",
          "STORY_COMPLETE",
        ].join("\n"),
        marker: "STORY_COMPLETE",
        producesCommit: true,
      };
    }

    case "reviewer":
    case "reviewer-final": {
      if (mode === "reviewer-blocks-then-fixer-fixes" && role === "reviewer") {
        const payload = JSON.stringify({
          marker: "HAS_BLOCKERS",
          concerns: [
            {
              severity: "MEDIUM",
              summary: "smoke: simulated medium concern",
            },
          ],
        });
        return {
          stdout: [
            "[STEP 1/1] Review",
            "Smoke reviewer flagging a medium concern to exercise the fixer.",
            payload,
            "",
            "HAS_BLOCKERS",
          ].join("\n"),
          marker: "HAS_BLOCKERS",
          producesCommit: false,
        };
      }
      const payload = JSON.stringify({
        marker: "ALL_CLEAR",
        concerns: [],
      });
      return {
        stdout: [
          "[STEP 1/1] Review",
          "Smoke reviewer: nothing to fix.",
          payload,
          "",
          "ALL_CLEAR",
        ].join("\n"),
        marker: "ALL_CLEAR",
        producesCommit: false,
      };
    }

    case "fixer": {
      const payload = JSON.stringify({
        marker: "FIXED",
        commitSha: "deadbeefcafefeedfacefeedbabe000000000002",
        notes: "smoke: applied canned fix",
      });
      return {
        stdout: [
          "[STEP 1/4] Judge findings",
          "[STEP 4/4] Commit",
          payload,
          "",
          "FIXED",
        ].join("\n"),
        marker: "FIXED",
        producesCommit: true,
      };
    }

    case "recovery": {
      const payload = JSON.stringify({
        marker: "RECOVERY_COMPLETE",
        fixApplied: true,
        commitSha: "deadbeefcafefeedfacefeedbabe000000000003",
      });
      return {
        stdout: [
          "Recovery agent finishing the work.",
          payload,
          "",
          "RECOVERY_COMPLETE",
        ].join("\n"),
        marker: "RECOVERY_COMPLETE",
        producesCommit: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Mock sandbox factory
// ---------------------------------------------------------------------------

export interface MockSandbox {
  /** SandboxProvider the loop hands to sandcastle when it does want to run something. */
  readonly provider: BindMountSandboxProvider;
  /** Higher-level shim Track C calls instead of sandcastle's run() per agent step. */
  runAgent(opts: MockRunOptions): Promise<MockRunResult>;
  /** Ordered log of every runAgent invocation. */
  readonly calls: readonly MockCallRecord[];
  /** Wipe call history — useful when a single mock spans multiple smoke variants. */
  reset(): void;
}

export function createMockSandbox(options: MockSandboxOptions = {}): MockSandbox {
  const failureMode: FailureMode = options.failureMode ?? "none";
  const branch = options.branch ?? "agent/smoke.1";
  const callsMutable: MockCallRecord[] = [];
  let commitCounter = 0;

  const nextCommitSha = (): string => {
    commitCounter += 1;
    const prefix = options.commitShaPrefix ?? "deadbeefcafefeedfacefeedbabe";
    return `${prefix}${String(commitCounter).padStart(12, "0")}`;
  };

  // ---- BindMountSandboxProvider stub -------------------------------------
  // The smoke harness never spawns containers; every method is a tight no-op
  // returning predictable empty results. If the loop accidentally tries to
  // exec() anything, we'll still succeed with exitCode 0 — but the call won't
  // produce side-effects on the real filesystem.

  const noopHandle = (
    createOpts: BindMountCreateOptions,
  ): BindMountSandboxHandle => ({
    worktreePath: createOpts.worktreePath,
    exec: async (
      _command: string,
      _opts?: { onLine?: (line: string) => void; cwd?: string; sudo?: boolean; stdin?: string },
    ): Promise<ExecResult> => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }),
    copyFileIn: async (_h: string, _s: string): Promise<void> => undefined,
    copyFileOut: async (_s: string, _h: string): Promise<void> => undefined,
    close: async (): Promise<void> => undefined,
  });

  const provider: BindMountSandboxProvider = {
    tag: "bind-mount",
    name: "mock-sandbox",
    env: {},
    sandboxHomedir: undefined,
    create: async (
      createOpts: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => noopHandle(createOpts),
  };

  // ---- runAgent shim -----------------------------------------------------

  const runAgent = async (opts: MockRunOptions): Promise<MockRunResult> => {
    const out = canned(opts.role, failureMode);
    const sha = out.producesCommit ? nextCommitSha() : "";
    const result: MockRunResult = {
      stdout: out.stdout,
      commits: out.producesCommit ? [{ sha }] : [],
      branch,
      completionSignal:
        out.marker === "STORY_COMPLETE" || out.marker === "RECOVERY_COMPLETE"
          ? "<promise>COMPLETE</promise>"
          : undefined,
      iterations: [{ sessionId: `smoke-${opts.role}-${commitCounter}` }],
      logFilePath: undefined,
    };
    callsMutable.push({
      role: opts.role,
      model: opts.model,
      prompt: opts.prompt,
      resultMarker: out.marker,
      at: Date.now(),
    });
    return result;
  };

  return {
    provider,
    runAgent,
    get calls(): readonly MockCallRecord[] {
      return callsMutable;
    },
    reset(): void {
      callsMutable.length = 0;
      commitCounter = 0;
    },
  };
}
