/**
 * Mock sandbox for the smoke harness (v1.1 wiring).
 *
 * The smoke now drives the production `runLoop` directly. To do that without
 * spinning up Docker we feed runLoop:
 *
 *   1. `_createSandbox` — returns a `Sandbox`-shaped stub (branch, worktreePath,
 *      no-op run/close/interactive/asyncDispose). The loop creates ONE of these
 *      and threads it into runIteration. Iteration code never reads from the
 *      sandbox itself when an `_agentRunner` is supplied; the stub's `run()`
 *      throws if anyone forgets to wire the runner.
 *
 *   2. `runAgent` — higher-level shim invoked through `_agentRunner` for every
 *      per-role agent step. Returns canned assistant text + commits keyed off
 *      the role. Each call is recorded so `expectations.ts` can assert order
 *      AND prompt content.
 *
 * Failure-mode flags are retained so future smoke variants can exercise the
 * recovery branch without rewriting fixtures.
 */

import type {
  BindMountSandboxProvider,
  BindMountCreateOptions,
  BindMountSandboxHandle,
  ExecResult,
  Sandbox,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxInteractiveOptions,
  SandboxInteractiveResult,
  CloseResult,
} from "@ai-hero/sandcastle";

// ---------------------------------------------------------------------------
// Types — mirror the load-bearing slice of @ai-hero/sandcastle SandboxRunResult
// without importing the heavy module surface. The runLoop's `_agentRunner`
// seam declares its own minimal output shape (`{ stdout, commits,
// completionSignal }`) which this mock satisfies 1:1.
// ---------------------------------------------------------------------------

export type AgentRole =
  | "implementer"
  | "reviewer"
  | "fixer"
  | "recovery"
  | "final-reviewer";

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
  /** Completion signal that fired (mirrors sandcastle SandboxRunResult). */
  readonly completionSignal: string | undefined;
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
  /** Worktree path the Sandbox stub reports — defaults to the repoRoot the loop already knows about. */
  readonly worktreePath?: string;
}

// ---------------------------------------------------------------------------
// Canned output assembly — per-role assistant text with a JSON envelope that
// validates against Track B's Zod schemas. The marker on the last non-empty
// line is what the loop's strict marker-extractor keys off.
// ---------------------------------------------------------------------------

const STORY_ID = "smoke.1";
const GH_ISSUE = 999;

interface CannedOutput {
  readonly stdout: string;
  readonly marker: string;
  readonly producesCommit: boolean;
}

function canned(role: AgentRole, mode: FailureMode): CannedOutput {
  switch (role) {
    case "implementer": {
      if (mode === "implementer-halts") {
        const payload = JSON.stringify({
          storyId: STORY_ID,
          ghIssue: GH_ISSUE,
          e2eActuallyRan: false,
          e2eVerdict: "halted",
          uiTouched: false,
          certificationPresent: false,
          marker: "HALT",
          haltReason: "smoke: simulated halt",
          storyType: "backend-only",
          e2eRequired: false,
          testCommandUsed: null,
          e2eAssertionLine: null,
          outputNotFiltered: true,
          testReachedFeature: false,
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
        e2eActuallyRan: false,
        e2eVerdict: "skipped",
        uiTouched: false,
        certificationPresent: true,
        marker: "STORY_COMPLETE",
        // V1-A 7-question rubric — backend-only smoke story, e2e not required.
        storyType: "backend-only",
        e2eRequired: false,
        testCommandUsed: null,
        e2eAssertionLine: null,
        outputNotFiltered: true,
        testReachedFeature: true,
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
    case "final-reviewer": {
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
  /** SandboxProvider the loop hands to sandcastle when it creates a sandbox handle. */
  readonly provider: BindMountSandboxProvider;
  /**
   * Sandcastle-shaped Sandbox stub. The smoke wires this into runLoop via
   * `_createSandbox` so the loop doesn't have to call the real createSandbox
   * (which would need Docker). The stub's `run()` throws — the loop should
   * always go through `_agentRunner` instead.
   */
  buildSandboxStub(branchOverride?: string, worktreePathOverride?: string): Sandbox;
  /** Higher-level shim invoked via runLoop's `_agentRunner` test seam. */
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
  // returning predictable empty results. This exists so a future test can
  // also drive the real createSandbox path without losing the no-op shape.

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
      completionSignal:
        out.marker === "STORY_COMPLETE" || out.marker === "RECOVERY_COMPLETE"
          ? "<promise>COMPLETE</promise>"
          : undefined,
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

  // ---- Sandbox stub for runLoop._createSandbox ---------------------------
  const buildSandboxStub = (
    branchOverride?: string,
    worktreePathOverride?: string,
  ): Sandbox => {
    const stubBranch = branchOverride ?? branch;
    const stubWorktreePath =
      worktreePathOverride ?? options.worktreePath ?? "/tmp/sandcastle-smoke-stub";
    const stub: Sandbox = {
      branch: stubBranch,
      worktreePath: stubWorktreePath,
      run: async (_o: SandboxRunOptions): Promise<SandboxRunResult> => {
        // The loop should always be using _agentRunner — reaching here means
        // someone forgot to wire the seam. Fail loudly so the smoke surfaces it.
        throw new Error(
          "MockSandbox stub.run() invoked: _agentRunner test seam missing or not threaded.",
        );
      },
      interactive: async (
        _o: SandboxInteractiveOptions,
      ): Promise<SandboxInteractiveResult> => {
        throw new Error("MockSandbox stub.interactive() not supported.");
      },
      close: async (): Promise<CloseResult> => ({}),
      [Symbol.asyncDispose]: async (): Promise<void> => undefined,
    };
    return stub;
  };

  return {
    provider,
    buildSandboxStub,
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
