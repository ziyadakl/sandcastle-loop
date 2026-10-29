import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCheckCommand } from "../checkwriter/verify-checks.js";
import type { SandboxCommandRunner } from "../sandbox-exec.js";
import {
  isCheckRunLogFilename,
  readAgentLogsForBranch,
} from "../testing/log-prefilter.js";
import type { CheckRunLogTarget } from "./check-run-log.js";
import { writeCheckRunLog } from "./check-run-log.js";
import { runHarnessScreenCheck } from "./run-harness-check.js";
import { formatGradeMarkLine } from "./grade-mark.js";
import { formatRunEvidence } from "./tally-signals.js";
import { GRADED_FIGURE_SENTINEL } from "./verdict.js";

/**
 * The evidence this whole file exists for is NEGATIVE evidence: a run that
 * times out, cannot be spawned, or prints nothing at all. Those are the three
 * causes #803's stop report had to list without being able to choose between
 * them, and they are the ones a transcript-shaped design gets wrong — there is
 * no transcript to write. So every case below asserts on the file's HEADER,
 * which is built from facts the caller always has, and the normal-run case is
 * the only one that asserts on output at all.
 */

const NONCE = "0123456789abcdef0123456789abcdef";
const BRANCH = "agent/issue-803";

function withEvidence(
  runnerOutput: string,
  // `graded` defaults to 1 — issue #925: a real browser run of a real check
  // always grades at least one screen, so a fixture defaulting to 0 would
  // quietly assert the broken case everywhere.
  ev: { exitCode: number; passed?: number; failed?: number; graded?: number },
): string {
  return (
    `${runnerOutput}\n${formatRunEvidence(NONCE, {
      reportPresent: true,
      exitCode: ev.exitCode,
      passed: ev.passed ?? 0,
      failed: ev.failed ?? 0,
      skipped: 0,
      flaky: 0,
    })}\n${formatGradeMarkLine(NONCE, ev.graded ?? 1, "")}\n`
  );
}

const PASS_OUTPUT = withEvidence("1 passed (1.2s)", { exitCode: 0, passed: 1 });
const FAIL_OUTPUT = withEvidence(
  `1 failed\n${GRADED_FIGURE_SENTINEL} graded figure mismatch\n1 passed (1.2s)`,
  { exitCode: 1, failed: 1 },
);

let repo: string;
let logDir: string;
let errors: string[];
let target: CheckRunLogTarget;

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "sandcastle-checkrun-log-"));
  logDir = path.join(repo, ".sandcastle", "logs");
  errors = [];
  target = {
    repoRoot: repo,
    branch: BRANCH,
    issueNumber: 803,
    phase: "ship",
    worktreePath: "/host/.sandcastle/worktrees/agent-issue-803",
    onError: (m) => errors.push(m),
  };
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Every file this run left, oldest name first. */
function logFiles(): string[] {
  try {
    return readdirSync(logDir).sort();
  } catch {
    return [];
  }
}

function readLog(name: string): string {
  return readFileSync(path.join(logDir, name), "utf8");
}

function fakeExec(
  results: readonly {
    exitCode: number | null;
    stdout?: string;
    timedOut?: boolean;
  }[],
): SandboxCommandRunner {
  let n = 0;
  return async () => {
    const r = results[n] ?? results[results.length - 1]!;
    n += 1;
    return {
      stdout: r.stdout ?? "",
      stderr: "",
      exitCode: r.exitCode,
      timedOut: r.timedOut ?? false,
    };
  };
}

describe("the ship-time harness persists every attempt", () => {
  it("a normal run leaves one file naming the command, the budget and the verdict", async () => {
    const result = await runHarnessScreenCheck(
      "browser",
      fakeExec([{ exitCode: 0, stdout: PASS_OUTPUT }]),
      "pnpm --filter @acme/nextjs e2e -- checks/issue-803.spec.ts",
      NONCE,
      420_000,
      target,
    );

    // The verdict is untouched by the persistence — this change is additive.
    expect(result.verdict.verdict).toBe("match");
    expect(logFiles()).toEqual(["agent-issue-803-checkrun-ship-1.log"]);

    const text = readLog("agent-issue-803-checkrun-ship-1.log");
    expect(text).toContain("phase=ship, attempt 1 of 2");
    expect(text).toContain("issue: #803");
    expect(text).toContain(
      "command: pnpm --filter @acme/nextjs e2e -- checks/issue-803.spec.ts",
    );
    expect(text).toContain("timeout budget: 420000 ms (7m 0s)");
    expect(text).toContain("exit code: 0");
    expect(text).toContain("timed out: no");
    expect(text).toContain("verdict: match");
    // The runner's own output really is in there, not just the header.
    expect(text).toContain("1 passed (1.2s)");
    expect(errors).toEqual([]);
  });

  it("A RUN THAT TIMES OUT still leaves a file that says so, with no output to show", async () => {
    await runHarnessScreenCheck(
      "browser",
      fakeExec([{ exitCode: null, stdout: "", timedOut: true }]),
      "pnpm --filter @acme/nextjs e2e -- checks/issue-803.spec.ts",
      NONCE,
      420_000,
      target,
    );

    const text = readLog("agent-issue-803-checkrun-ship-1.log");
    // The whole point: nothing was printed, and the file is still useful.
    expect(text).toContain("timed out: YES — the budget above fired");
    expect(text).toContain("exit code: (none — the process reported no exit status)");
    expect(text).toContain("timeout budget: 420000 ms (7m 0s)");
    expect(text).toMatch(/ran for: \d+ ms/);
    expect(text).toContain(
      "(the run produced NO output on either stream — not a truncated file)",
    );
    expect(text).toContain("verdict: inconclusive");
    // A zero-byte file is the bug being fixed. This one is not close to empty.
    expect(text.length).toBeGreaterThan(300);
  });

  it("A RUN THAT COULD NOT BE SPAWNED leaves a file naming the transport fault", async () => {
    const exec: SandboxCommandRunner = async () => {
      throw new Error("docker daemon unreachable");
    };

    await runHarnessScreenCheck(
      "browser",
      exec,
      "pnpm e2e -- checks/issue-803.spec.ts",
      NONCE,
      420_000,
      target,
    );

    const text = readLog("agent-issue-803-checkrun-ship-1.log");
    expect(text).toContain("spawn/transport fault: docker daemon unreachable");
    expect(text).toContain(
      "(the run produced NO output on either stream — not a truncated file)",
    );
    expect(text).toContain("output bytes: 0");
  });

  it("A RUN WITH NO EXEC AT ALL still leaves a file saying nothing was run", async () => {
    await runHarnessScreenCheck(
      "browser",
      undefined,
      "pnpm e2e -- checks/issue-803.spec.ts",
      NONCE,
      420_000,
      target,
    );

    // The absent-exec path applies the one re-run rule too, so BOTH attempts
    // are on disk, both saying the same thing.
    expect(logFiles()).toEqual([
      "agent-issue-803-checkrun-ship-1.log",
      "agent-issue-803-checkrun-ship-2.log",
    ]);
    const text = readLog("agent-issue-803-checkrun-ship-1.log");
    expect(text).toContain(
      "spawn/transport fault: the sandbox exposed no command execution — nothing was run",
    );
    expect(text).toContain("attempt 1 of 2");
  });

  it("ATTEMPT 2 NEVER OVERWRITES ATTEMPT 1 — a first-run failure and a second-run pass both survive", async () => {
    const result = await runHarnessScreenCheck(
      "browser",
      fakeExec([
        { exitCode: 1, stdout: FAIL_OUTPUT },
        { exitCode: 0, stdout: PASS_OUTPUT },
      ]),
      "pnpm e2e -- checks/issue-803.spec.ts",
      NONCE,
      420_000,
      target,
    );

    expect(result.rerun).toBe(true);
    expect(logFiles()).toEqual([
      "agent-issue-803-checkrun-ship-1.log",
      "agent-issue-803-checkrun-ship-2.log",
    ]);

    const first = readLog("agent-issue-803-checkrun-ship-1.log");
    const second = readLog("agent-issue-803-checkrun-ship-2.log");
    // THE DIAGNOSTIC SIGNAL THAT MATTERS: the two files disagree, and that
    // disagreement is exactly "this was a flake that resolved on re-run".
    expect(first).toContain("attempt 1 of 2");
    expect(first).toContain("verdict: graded-mismatch");
    expect(first).toContain("exit code: 1");
    expect(second).toContain("attempt 2 of 2");
    expect(second).toContain("verdict: match");
    expect(second).toContain("exit code: 0");
  });

  it("writes nothing, and changes nothing, when no target is supplied", async () => {
    const result = await runHarnessScreenCheck(
      "browser",
      fakeExec([{ exitCode: 0, stdout: PASS_OUTPUT }]),
      "pnpm e2e -- x.spec.ts",
      NONCE,
    );
    expect(result.verdict.verdict).toBe("match");
    expect(logFiles()).toEqual([]);
  });
});

describe("the must-fail-first (red) run persists too", () => {
  const redTarget = (): CheckRunLogTarget => ({
    ...target,
    phase: "must-fail-first",
  });

  it("records the expectation, the runner and the verdict on a proven-red run", async () => {
    const verdict = await runCheckCommand(
      "browser",
      fakeExec([{ exitCode: 1, stdout: FAIL_OUTPUT }]),
      "pnpm e2e -- checks/issue-803.spec.ts",
      "red",
      NONCE,
      420_000,
      redTarget(),
    );

    expect(verdict.status).toBe("pass");
    expect(logFiles()).toEqual([
      "agent-issue-803-checkrun-must-fail-first-1.log",
    ]);
    const text = readLog("agent-issue-803-checkrun-must-fail-first-1.log");
    // One run, and the file says so — nobody should go looking for a second.
    expect(text).toContain("phase=must-fail-first, attempt 1 of 1");
    expect(text).toContain("expected to observe: red");
    expect(text).toContain("verdict: pass");
  });

  it("THE #803 SHAPE: a red run that produced no tally line leaves the cause on disk", async () => {
    // The real night: Playwright died in globalSetup because the sandbox could
    // not reach the test Postgres, so there was no tally line to read. The
    // classifier's own reason ("no evidence line") is true and useless; the
    // address is in the output, and until now the output was discarded.
    const verdict = await runCheckCommand(
      "browser",
      fakeExec([
        {
          exitCode: 1,
          stdout:
            "Error: connect CONNECT_TIMEOUT 172.17.0.1:55432\n" +
            "  at PostgresError (postgres://postgres:hunter2@172.17.0.1:55432/test)\n",
        },
      ]),
      "pnpm e2e -- checks/issue-803.spec.ts",
      "red",
      NONCE,
      420_000,
      redTarget(),
    );

    expect(verdict.status).toBe("inconclusive");
    const text = readLog("agent-issue-803-checkrun-must-fail-first-1.log");
    expect(text).toContain("CONNECT_TIMEOUT 172.17.0.1:55432");
    // Credentials are scrubbed on the way in — this file is written under
    // .sandcastle/logs/ but the password must not sit on disk regardless.
    expect(text).not.toContain("hunter2");
    expect(text).toContain("postgres://***@172.17.0.1:55432/test");
  });

  it("still writes when the red run timed out with nothing on either stream", async () => {
    await runCheckCommand(
      "unit",
      fakeExec([{ exitCode: null, stdout: "", timedOut: true }]),
      "pnpm --filter @acme/db test -- checks/issue-803.test.ts",
      "red",
      NONCE,
      240_000,
      redTarget(),
    );

    const text = readLog("agent-issue-803-checkrun-must-fail-first-1.log");
    expect(text).toContain("runner: unit");
    expect(text).toContain("timeout budget: 240000 ms (4m 0s)");
    expect(text).toContain("timed out: YES — the budget above fired");
    expect(text).toContain("verdict: inconclusive");
  });
});

describe("writing a transcript can never break a run", () => {
  it("an unwritable log directory reports once and returns undefined, never throws", () => {
    // `repoRoot` names a FILE, so `mkdir -p <that>/.sandcastle/logs` cannot
    // succeed — the cheapest way to make a real write fail for real.
    writeFileSync(path.join(repo, "not-a-dir"), "x");
    const bad: CheckRunLogTarget = {
      ...target,
      repoRoot: path.join(repo, "not-a-dir"),
    };

    const written = writeCheckRunLog(bad, {
      kind: "browser",
      attempt: 1,
      maxAttempts: 2,
      command: "pnpm e2e",
      timeoutMs: 1,
      durationMs: 1,
      startedAtIso: "2026-08-06T00:00:00.000Z",
      exitCode: null,
      timedOut: false,
      output: "",
      verdict: "inconclusive",
      reason: "x",
    });

    expect(written).toBeUndefined();
    // Reported, not swallowed. A write that vanishes without a word would
    // recreate the exact blindness this module removes.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("could not persist the ship check-run log");
  });
});

describe("check-run transcripts are not agent session logs", () => {
  it("readAgentLogsForBranch skips them", async () => {
    await runHarnessScreenCheck(
      "browser",
      fakeExec([{ exitCode: 0, stdout: PASS_OUTPUT }]),
      // Contains a test command — which is why folding it into the pre-filter
      // would make that filter's rejection sentence a claim about the LOOP's
      // invocation rather than the builder's.
      "pnpm --filter @acme/nextjs e2e -- checks/issue-803.spec.ts",
      NONCE,
      420_000,
      target,
    );

    expect(logFiles()).toHaveLength(1);
    expect(readAgentLogsForBranch(repo, BRANCH)).toEqual([]);
    expect(isCheckRunLogFilename("agent-issue-803-checkrun-ship-1.log")).toBe(
      true,
    );
    expect(isCheckRunLogFilename("agent-issue-803-check-writer.log")).toBe(
      false,
    );
  });
});
