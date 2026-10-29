/**
 * The LINT-VERIFICATION gate inside `shipAfterMigrations`.
 *
 * WHAT WAS BROKEN. Issue #931 was correct, tested and finished, and the loop
 * killed it anyway:
 *
 *   [issue=931] pipeline halted (…): lint-cert-missing: issue #931 commit
 *   de6d9fb8 changed code but its body lacks the `SANDCASTLE-LINT: pass`
 *   certification, and the project defines a `lint` script. … Quarantining
 *   for human triage.
 *
 * The builder had stamped its own commit `SANDCASTLE-LINT: n/a` instead of
 * `pass`. Lint passed; only the paperwork was wrong. A later recovery pass
 * fixed the stamp and nothing else, proving the code was never the problem.
 *
 * THE DEFECT IS THE INSTRUMENT, NOT THE AGENT. The gate asked an agent to
 * self-report whether it had run the linter, then hard-quarantined finished
 * work when the self-report was wrong. The loop can just RUN the linter and
 * know. An agent's honesty about paperwork must never be able to kill correct,
 * passing work — but a genuinely failing lint must still stop the ticket, and
 * the honest `SANDCASTLE-LINT: pass` case must not get one inch weaker.
 *
 * These tests drive the REAL cert classifier (`classifyLintCert` +
 * `hasLintScript`, over a real temp git repo whose commit body really says
 * `n/a` and whose package.json really declares a `lint` script) and the REAL
 * lint runner (`verifyProjectLint`, over a fake sandbox `exec` replaying real
 * turbo/eslint output). Only the sandbox process is faked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commitInto, git } from "./__fixtures__/git-repo.js";
import type { SandboxExecResult } from "./lib/sandbox-exec.js";
import { verifyProjectLint } from "./lib/lint/lint-verification.js";
import {
  classifyLintCert,
  hasLintScript,
  shipAfterMigrations,
} from "./main.mts";
import { SHIP_INPUT_DEFAULTS } from "./__fixtures__/ship-input.mts";

/** A package.json that declares a `lint` script — what makes the gate live. */
const PKG_WITH_LINT = `${JSON.stringify(
  { name: "fixture-repo", scripts: { lint: "turbo run lint" } },
  null,
  2,
)}\n`;

/**
 * Real `pnpm lint` output from this repo, trimmed to the tail that carries the
 * evidence: turbo's task tally. Captured from a live run rather than invented,
 * because the whole point of the completion guard is that it matches what the
 * tool actually prints.
 */
const TURBO_LINT_PASS_OUTPUT = [
  "@acme/api:lint: cache hit, replaying logs",
  "",
  " Tasks:    12 successful, 12 total",
  "Cached:    12 cached, 12 total",
  "  Time:    1.2s >>> FULL TURBO",
  "",
].join("\n");

/** Real turbo output for a lint that RAN and reported eslint errors. */
const TURBO_LINT_FAIL_OUTPUT = [
  "@acme/api:lint: /repo/packages/api/src/router/deal.ts",
  "@acme/api:lint:   12:7  error  'x' is assigned a value but never used",
  "@acme/api:lint: ✖ 1 problem (1 error, 0 warnings)",
  "@acme/api:lint: ELIFECYCLE  Command failed with exit code 1.",
  "",
  " Tasks:    11 successful, 12 total",
  "Cached:    11 cached, 12 total",
  "  Time:    9.4s",
  "",
].join("\n");

/** A sandbox `exec` that replays one canned result and records the commands. */
function fakeExec(
  result: Partial<SandboxExecResult>,
  seen: string[],
): (cmd: string) => Promise<SandboxExecResult> {
  return async (cmd: string) => {
    seen.push(cmd);
    return {
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      ...result,
    };
  };
}

describe("shipAfterMigrations: lint self-verification", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-ship-lint-verify-"));
    git(repo, "init", "-q", "-b", "issue-931");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commitInto(repo, { "package.json": PKG_WITH_LINT }, "init");
    git(repo, "branch", "run");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * A ctx whose lint-cert gate is the REAL one: it reads this repo's real
   * package.json and the real commit body through the same pure classifier
   * production uses, so the fixture's `SANDCASTLE-LINT: n/a` stamp lands on
   * "missing" for the real reason rather than because a stub said so.
   */
  function makeCtx(over: {
    exec?: (cmd: string) => Promise<SandboxExecResult>;
    logs: string[];
    logErrors: string[];
  }): {
    ctx: Parameters<typeof shipAfterMigrations>[0];
    sandbox: Parameters<typeof shipAfterMigrations>[1];
    markDoneCalls: unknown[][];
  } {
    const markDoneCalls: unknown[][] = [];
    const ctx = {
      args: { repoRoot: repo, branch: "run", stagingEnabled: false },
      deps: {
        log: (line: string): void => {
          over.logs.push(line);
        },
        logError: (line: string): void => {
          over.logErrors.push(line);
        },
        checkLintCert: async (
          repoRoot: string,
          preSha: string,
          postSha: string,
        ) => {
          const message =
            postSha === ""
              ? null
              : git(repoRoot, "show", "-s", "--format=%B", postSha);
          return classifyLintCert(
            hasLintScript(repoRoot),
            preSha,
            postSha,
            message,
          );
        },
        verifyLintRun: verifyProjectLint,
        checkTestCert: async () => ({ status: "dormant" as const }),
        validateMigrationJournal: async () => [],
        applyMigrations: async () => ({ realErrors: [], applied: 0 }),
        markDone: async (...args: unknown[]) => {
          markDoneCalls.push(args);
        },
        fenceIssue: async () => true,
        release: async () => {},
      },
      issueNumber: 931,
      issue: { branch: "issue-931" },
      telemetry: {
        noteShipPath: () => {},
        noteDiff: () => {},
        noteImplementerAttempt: () => {},
      },
      runCounters: { bump: () => {} },
    } as unknown as Parameters<typeof shipAfterMigrations>[0];
    return {
      ctx,
      sandbox: { exec: over.exec } as unknown as Parameters<
        typeof shipAfterMigrations
      >[1],
      markDoneCalls,
    };
  }

  const ship = async (
    made: ReturnType<typeof makeCtx>,
    preSha: string,
    postSha: string,
  ): Promise<unknown> =>
    await shipAfterMigrations(
      made.ctx,
      made.sandbox,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
      },
    );

  // THE #931 CASE. The exact symptom, end to end.
  it("a commit stamped `n/a` whose lint actually PASSES ships instead of quarantining", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commitInto(
      repo,
      { "src/a.ts": "export const a = 1;\n" },
      "feat: the work\n\nSANDCASTLE-LINT: n/a\n",
    );
    const logs: string[] = [];
    const logErrors: string[] = [];
    const seen: string[] = [];
    const made = makeCtx({
      exec: fakeExec({ stdout: TURBO_LINT_PASS_OUTPUT }, seen),
      logs,
      logErrors,
    });

    await expect(ship(made, preSha, postSha)).resolves.toBeDefined();

    // The loop ran lint ITSELF rather than believing the stamp…
    expect(seen.join("\n")).toContain("pnpm lint");
    // …the ticket finished…
    expect(made.markDoneCalls.length).toBe(1);
    // …and the record says who certified it. Shipping silently, as though the
    // agent had done its paperwork, would hide a real prompt-compliance defect.
    expect([...logs, ...logErrors].join("\n")).toContain("lint-self-certified");
  });

  it("a commit stamped `n/a` whose lint actually FAILS still stops the ticket", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commitInto(
      repo,
      { "src/a.ts": "export const a = 1;\n" },
      "feat: the work\n\nSANDCASTLE-LINT: n/a\n",
    );
    const seen: string[] = [];
    const made = makeCtx({
      exec: fakeExec({ stdout: TURBO_LINT_FAIL_OUTPUT, exitCode: 1 }, seen),
      logs: [],
      logErrors: [],
    });

    // Distinctly worded: the owner triaging this at 8am must read "lint really
    // failed", not the paperwork complaint that killed #931 while lint was fine.
    await expect(ship(made, preSha, postSha)).rejects.toThrow(
      /lint-verify-failed/,
    );
    expect(seen.join("\n")).toContain("pnpm lint");
    expect(made.markDoneCalls).toEqual([]);
  });

  it("keeps quarantining when the loop CANNOT run lint (no exec) — an unverifiable cert is still no cert", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commitInto(
      repo,
      { "src/a.ts": "export const a = 1;\n" },
      "feat: the work\n\nSANDCASTLE-LINT: n/a\n",
    );
    const made = makeCtx({ exec: undefined, logs: [], logErrors: [] });

    await expect(ship(made, preSha, postSha)).rejects.toThrow(
      /lint-cert-missing/,
    );
    expect(made.markDoneCalls).toEqual([]);
  });

  // The honest case must not get one inch weaker: a commit that certifies
  // `pass` ships on the cert, and the loop spends nothing re-running lint.
  it("a commit that certifies `pass` ships WITHOUT the loop running lint at all", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commitInto(
      repo,
      { "src/a.ts": "export const a = 1;\n" },
      "feat: the work\n\nSANDCASTLE-LINT: pass\n",
    );
    const seen: string[] = [];
    const made = makeCtx({
      exec: fakeExec({ stdout: TURBO_LINT_PASS_OUTPUT }, seen),
      logs: [],
      logErrors: [],
    });

    await expect(ship(made, preSha, postSha)).resolves.toBeDefined();
    expect(seen).toEqual([]);
    expect(made.markDoneCalls.length).toBe(1);
  });
});
