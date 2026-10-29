/**
 * The check-writer retry path's self-healing (2026-08-31):
 *
 *   1. FEED THE RETRY — every check-writer retry carries a REPAIR_BRIEF built
 *      from the host's own observation (the must-fail-first classifier's
 *      one-line reason, or the missing graded-helper call — never the app's
 *      own output, per ruling 6), never a blind re-dispatch.
 *   2. ONE RETRY, THEN BUILD — a check still green after the one briefed
 *      retry is built without a first test (`no-failing-check`). The
 *      budgeted third rewrite off the judge's weak-check pool was deleted
 *      with that pool (spec #1334).
 *   3. ENVIRONMENT SPLIT — an INCONCLUSIVE proof retries the RUN (same check,
 *      no rewrite) once. A second ENVIRONMENT-shaped inconclusive builds
 *      without a first test as `run-fault`, never as `no-failing-check`; a
 *      second SCREEN-UNREACHED inconclusive (a colour with no proof the
 *      screen was reached — a deterministic check fault) goes to a briefed
 *      writer retry instead (2026-09-01).
 *
 * Harness patterns copied from `main.checkwriter.test.mts` — a real temp
 * directory for the worktree, canned envelopes, and the nonce-honest exec
 * fakes from `__fixtures__/check-evidence.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GREEN_RUN,
  RED_RUN,
  checkRunExecSequence,
  type FakeCheckRun,
} from "./__fixtures__/check-evidence.js";
import { checkDirForIssue } from "./lib/checkwriter/check-path.js";
import { MUST_FAIL_FIRST_RECEIPT_FILENAME } from "./lib/checkwriter/must-fail-first-receipt.js";
import {
  missingHelperRetryBrief,
  mustFailFirstRetryBrief,
  runCheckWriterStage,
  type SandboxHandle,
} from "./main.mts";

/** A proof run the classifier can only read as INCONCLUSIVE: the runner's
 *  nonce-signed report line is missing, so nothing proves the run happened.
 *  The ENVIRONMENT shape of inconclusive — never flagged screen-unreached. */
const INCONCLUSIVE_RUN: FakeCheckRun = {
  exitCode: 1,
  passed: 0,
  failed: 1,
  reportPresent: false,
};

/** The SCREEN-UNREACHED shape (2026-09-01): the runner ran and reported a
 *  real red, but no grade mark, no refusal sentinel and no settled record
 *  says the check ever reached its screen — a bad import, a dead route. */
const UNREACHED_RED_RUN: FakeCheckRun = {
  exitCode: 1,
  passed: 0,
  failed: 1,
  graded: 0,
};

const ISSUE = 911;

/** Same shape the real parser expects — see `main.checkwriter.test.mts`. */
function envelope(body: Record<string, unknown>, marker: string): string {
  return (
    `Some reasoning prose about the ticket.\n\n` +
    "```json\n" +
    `${JSON.stringify(body, null, 2)}\n` +
    "```\n\n" +
    `${marker}\n`
  );
}

const CHECKS_WRITTEN_STDOUT = envelope(
  {
    marker: "CHECKS_WRITTEN",
    inherited: false,
    screen: "/finance/reports?view=team",
    checkPath: "team-cash-flow.spec.ts",
  },
  "CHECKS_WRITTEN",
);

const VALID_CHECK_BODY =
  `import { test } from "@playwright/test";\n` +
  `import { waitForGradableScreen, gradeScreenText } from "../../lib/graded-screen-check";\n` +
  `test("check", async ({ page }) => {\n` +
  `  const { claim } = await waitForGradableScreen(page, { screen: "x", expectedClaim: {}, screenshotPath: "x" });\n` +
  `  await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
  `});\n`;

/** A check body that never calls the graded helpers — the static scan
 *  refuses it with `CheckWriterMissingGradedHelperError`. */
const HELPERLESS_CHECK_BODY =
  `import { test, expect } from "@playwright/test";\n` +
  `test("check", async ({ page }) => {\n` +
  `  await expect(page.locator(".figure")).toBeVisible();\n` +
  `});\n`;

function writeCheckFile(worktree: string, body: string): void {
  const dir = path.join(worktree, checkDirForIssue(ISSUE));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "team-cash-flow.spec.ts"), body);
}

/** Captures every CHECK-WRITER dispatch's promptArgs. */
function makeSandbox(opts: {
  worktree: string;
  exec: SandboxHandle["exec"];
  /** Body written per check-writer dispatch (index = dispatch - 1); the last
   *  entry repeats. Simulates the agent's own tool calls creating the file. */
  bodies?: readonly string[];
}): {
  sandbox: SandboxHandle;
  checkWriterCalls: Array<Record<string, string>>;
} {
  const checkWriterCalls: Array<Record<string, string>> = [];
  const bodies = opts.bodies ?? [VALID_CHECK_BODY];
  const sandbox = {
    branch: `issue-${ISSUE}`,
    worktreePath: opts.worktree,
    run: vi
      .fn()
      .mockImplementation(
        async (spec: { name?: string; promptArgs?: Record<string, string> }) => {
          checkWriterCalls.push(spec.promptArgs ?? {});
          const body =
            bodies[Math.min(checkWriterCalls.length - 1, bodies.length - 1)]!;
          writeCheckFile(opts.worktree, body);
          return { stdout: CHECKS_WRITTEN_STDOUT, commits: [] };
        },
      ),
    exec: opts.exec,
    close: async () => {},
  } as unknown as SandboxHandle;
  return { sandbox, checkWriterCalls };
}

function makeCtx(over: {
  deps?: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
}): {
  ctx: unknown;
  quarantines: string[];
  stops: Array<{ label: string; detail: string }>;
  /** #1198 A: what the first-test fall-through wrote onto the issue BODY.
   *  A stop it replaced would have pushed onto `stops` AND `quarantines`;
   *  these entries prove it did neither. */
  fallThroughs: Array<{ reason: string; detail: string }>;
  logs: string[];
} {
  const quarantines: string[] = [];
  const stops: Array<{ label: string; detail: string }> = [];
  const fallThroughs: Array<{ reason: string; detail: string }> = [];
  const logs: string[] = [];
  const ctx = {
    siblingTickets: undefined,
    args: {
      repoRoot: "/repo",
      branch: "main",
      critiqueModel: "opus-critique",
      implementerTimeoutSec: 600,
      stagingEnabled: true,
    },
    deps: {
      log: (m: string) => logs.push(m),
      logError: (m: string) => logs.push(m),
      comment: async () => {},
      quarantine: async (_n: number, reason: string) => {
        quarantines.push(reason);
      },
      reportStop: async (
        _n: number,
        stop: { label: string; detail: string },
      ) => {
        stops.push(stop);
      },
      captureSha: async () => "postsha-after-checkwriter",
      applyFirstTestFallThroughReport: async (
        _n: number,
        f: { reason: string; detail: string },
      ) => {
        fallThroughs.push(f);
        return "applied" as const;
      },
      ...over.deps,
    },
    ticketOrdinal: 1,
    issueNumber: ISSUE,
    issue: { branch: `issue-${ISSUE}` },
    status: { setIssuePhase: () => {} },
    telemetry: over.telemetry,
  };
  return { ctx, quarantines, stops, fallThroughs, logs };
}

describe("check-writer self-heal — briefed retries, budget spend, environment split", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-selfheal-"));
    // The freeze's layout guard demands every browser instrument root resolve.
    mkdirSync(path.join(worktree, "apps/nextjs/src/lib/screen-check"), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("a green proof retries the check-writer WITH a brief carrying the classifier reason — and NO app output", async () => {
    const { sandbox, checkWriterCalls } = makeSandbox({
      worktree,
      exec: checkRunExecSequence([GREEN_RUN, RED_RUN]),
    });
    const { ctx } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    expect(checkWriterCalls).toHaveLength(2);
    // Attempt 1 was an ordinary pass: empty brief.
    expect(checkWriterCalls[0]!.REPAIR_BRIEF).toBe("");
    expect(checkWriterCalls[0]!.CHECK_ATTEMPT).toBe("1");
    // Attempt 2 is briefed with the host's own observation — the classifier's
    // one-line reason — never dispatched blind.
    const brief = checkWriterCalls[1]!.REPAIR_BRIEF!;
    expect(checkWriterCalls[1]!.CHECK_ATTEMPT).toBe("2");
    expect(brief).toContain("REJECTED");
    expect(brief).toContain("observed green, expected red");
    // Ruling 6 (2026-09-01 review, finding F): the reason only, never the
    // application's output — an observed tail invites not-equal-to-observed
    // assertions.
    expect(brief).not.toContain("Redacted tail");
    expect(brief).toContain("output is deliberately withheld");
    // The brief names the WHY, never a target figure the check could assert.
    expect(brief).toContain("does not tell you the value");
  });

  it("a missing-graded-helper refusal retries WITH a brief naming the exact missing call", async () => {
    const { sandbox, checkWriterCalls } = makeSandbox({
      worktree,
      exec: checkRunExecSequence([RED_RUN]),
      bodies: [HELPERLESS_CHECK_BODY, VALID_CHECK_BODY],
    });
    const { ctx } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    expect(checkWriterCalls).toHaveLength(2);
    const brief = checkWriterCalls[1]!.REPAIR_BRIEF!;
    expect(brief).toContain("REFUSED");
    expect(brief).toContain("waitForGradableScreen");
    expect(brief).toContain("gradeScreenText");
  });

  // -------------------------------------------------------------------------
  // Fault 2 (2026-09-01): the ONE briefed re-ask for an envelope that could
  // not be parsed at all — ticket #1126's writer put a `.test.ts` filename
  // on a `CHECKS_WRITTEN` envelope on attempt 2 and the ticket died with no
  // retry, even though the schema error already names the exact fix.
  // -------------------------------------------------------------------------
  describe("the envelope re-ask", () => {
    /** A `CHECKS_WRITTEN` envelope with a `.test.ts` checkPath — rejected by
     *  the schema (`isSafeCheckRelativePath` requires `.spec.ts`). */
    const MISLABELLED_STDOUT = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "visibility.test.ts",
      },
      "CHECKS_WRITTEN",
    );

    function makeMislabelSandbox(opts: {
      worktree: string;
      exec: SandboxHandle["exec"];
    }): {
      sandbox: SandboxHandle;
      checkWriterCalls: Array<Record<string, string>>;
    } {
      const checkWriterCalls: Array<Record<string, string>> = [];
      const sandbox = {
        branch: `issue-${ISSUE}`,
        worktreePath: opts.worktree,
        run: vi
          .fn()
          .mockImplementation(
            async (spec: {
              name?: string;
              promptArgs?: Record<string, string>;
            }) => {
              checkWriterCalls.push(spec.promptArgs ?? {});
              // Every attempt after the first fixes the mislabelling and
              // writes a real, correctly-marked check.
              if (checkWriterCalls.length === 1) {
                return { stdout: MISLABELLED_STDOUT, commits: [] };
              }
              writeCheckFile(opts.worktree, VALID_CHECK_BODY);
              return { stdout: CHECKS_WRITTEN_STDOUT, commits: [] };
            },
          ),
        exec: opts.exec,
        close: async () => {},
      } as unknown as SandboxHandle;
      return { sandbox, checkWriterCalls };
    }

    /** Same shape, but EVERY attempt returns the mislabelled envelope —
     *  proves the re-ask is spent after exactly one retry. */
    function makeAlwaysMislabelSandbox(opts: {
      worktree: string;
      exec: SandboxHandle["exec"];
    }): {
      sandbox: SandboxHandle;
      checkWriterCalls: Array<Record<string, string>>;
    } {
      const checkWriterCalls: Array<Record<string, string>> = [];
      const sandbox = {
        branch: `issue-${ISSUE}`,
        worktreePath: opts.worktree,
        run: vi
          .fn()
          .mockImplementation(
            async (spec: {
              name?: string;
              promptArgs?: Record<string, string>;
            }) => {
              checkWriterCalls.push(spec.promptArgs ?? {});
              return { stdout: MISLABELLED_STDOUT, commits: [] };
            },
          ),
        exec: opts.exec,
        close: async () => {},
      } as unknown as SandboxHandle;
      return { sandbox, checkWriterCalls };
    }

    it("a mislabelled envelope (.test.ts under CHECKS_WRITTEN) retries WITH a brief quoting the schema error verbatim and naming the fix", async () => {
      const { sandbox, checkWriterCalls } = makeMislabelSandbox({
        worktree,
        exec: checkRunExecSequence([RED_RUN]),
      });
      const calls: string[] = [];
      const { ctx } = makeCtx({
        telemetry: {
          noteCheckWriterRetried: () => calls.push("noteCheckWriterRetried"),
          // No-ops for every other optional-chained `ctx.telemetry?.noteX`
          // call `runCheckWriterStage`/`dispatchCheckWriter` may reach —
          // this stub only needs to RECORD the one call under test.
          noteCheckWriterOutcome: () => {},
          noteCheckWriterInherited: () => {},
          noteCheckWriterMustFailFirst: () => {},
          noteCheckWriterProofCarriedForward: () => {},
          noteCheckWriterMarkerReconciled: () => {},
        },
      });
      const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

      expect(result.proceed).toBe(true);
      expect(checkWriterCalls).toHaveLength(2);
      const brief = checkWriterCalls[1]!.REPAIR_BRIEF!;
      // The zod message is quoted verbatim — it names the offending value.
      expect(brief).toContain("visibility.test.ts");
      expect(brief).toContain(".spec.ts");
      expect(brief).toContain(
        "a `.test.ts` filename belongs in `UNIT_CHECK_WRITTEN`",
      );
      expect(calls).toEqual(["noteCheckWriterRetried"]);
    });

    it("two parse failures in a row build the ticket without a first test (#1198 A), exactly two dispatches, no stop label", async () => {
      const { sandbox, checkWriterCalls } = makeAlwaysMislabelSandbox({
        worktree,
        exec: checkRunExecSequence([]),
      });
      const { ctx, quarantines, stops, fallThroughs } = makeCtx({});
      const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

      // The re-ask budget is what this test guards and it is unchanged:
      // exactly two dispatches. #1198 A changed only what happens after.
      expect(result.proceed).toBe(true);
      expect(checkWriterCalls).toHaveLength(2);
      expect(quarantines).toHaveLength(0);
      expect(stops).toHaveLength(0);
      expect(fallThroughs.map((f) => f.reason)).toEqual(["no-failing-check"]);
    });

    it("fault-2-review D1: the re-ask is TICKET-WIDE, not per dispatch site — spent on attempt 1, a LATER dispatch site's parse failure quarantines immediately with no second re-ask", async () => {
      // attempt 1: mislabelled (spends the ticket's ONE re-ask). attempt 2:
      // fixed and goes GREEN, which earns the ordinary green-proof retry —
      // a DIFFERENT dispatch site than attempt 1's. attempt 3 (that retry)
      // is ALSO mislabelled: if the re-ask were scoped per site rather than
      // per ticket, this would earn its OWN re-ask (a 4th dispatch); it must
      // not — exactly 3 dispatches, and the 3rd stops the ticket outright.
      const checkWriterCalls: Array<Record<string, string>> = [];
      const sandbox = {
        branch: `issue-${ISSUE}`,
        worktreePath: worktree,
        run: vi
          .fn()
          .mockImplementation(
            async (spec: {
              name?: string;
              promptArgs?: Record<string, string>;
            }) => {
              checkWriterCalls.push(spec.promptArgs ?? {});
              const n = checkWriterCalls.length;
              if (n === 1) return { stdout: MISLABELLED_STDOUT, commits: [] };
              if (n === 2) {
                writeCheckFile(worktree, VALID_CHECK_BODY);
                return { stdout: CHECKS_WRITTEN_STDOUT, commits: [] };
              }
              // attempt 3 (the green-proof retry's own dispatch): mislabelled
              // again.
              return { stdout: MISLABELLED_STDOUT, commits: [] };
            },
          ),
        exec: checkRunExecSequence([GREEN_RUN]),
        close: async () => {},
      } as unknown as SandboxHandle;
      const { ctx, quarantines, stops, fallThroughs } = makeCtx({});
      const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

      expect(result.proceed).toBe(true);
      expect(checkWriterCalls).toHaveLength(3);
      // #1198 A: no quarantine, no stop label — the ticket is built without
      // a first test and the fact is written onto its body instead.
      expect(quarantines).toHaveLength(0);
      expect(stops).toHaveLength(0);
      expect(fallThroughs.map((f) => f.reason)).toEqual(["no-failing-check"]);
    });

    it("#1191 finding E: a re-ask spent on attempt 1 must not inflate a LATER, unrelated dispatch's own attempt count", async () => {
      // attempt 1: mislabelled (spends the ticket's ONE re-ask). attempt 2
      // (the re-ask itself): fixed, GREEN against untouched code, earning
      // the ordinary Piece D green-proof retry. attempt 3 (that retry): ALSO
      // succeeds cleanly (no parse error of its own — it never touches the
      // re-ask branch at all, since the ticket's one re-ask is already
      // spent). A second green observation ends the ladder
      // immediately — so this is the LAST dispatch, and its own
      // `CHECK_ATTEMPT` plus the stop's "dispatched N times" prose are the
      // only two places the bug this test pins can show up: before the fix,
      // `dispatchCheckWriter` reported `attemptsUsed: 2` for attempt 3 just
      // because the ticket's re-ask flag was already `true` coming in — not
      // because attempt 3 itself made two real check-writer calls (it made
      // exactly one) — so the stop wrongly claimed a 4th dispatch that never
      // happened.
      const checkWriterCalls: Array<Record<string, string>> = [];
      const sandbox = {
        branch: `issue-${ISSUE}`,
        worktreePath: worktree,
        run: vi
          .fn()
          .mockImplementation(
            async (spec: {
              name?: string;
              promptArgs?: Record<string, string>;
            }) => {
              checkWriterCalls.push(spec.promptArgs ?? {});
              const n = checkWriterCalls.length;
              if (n === 1) return { stdout: MISLABELLED_STDOUT, commits: [] };
              // n===2 (the re-ask) and n===3 (the green-proof retry) both
              // write a valid check cleanly on their first and only try.
              writeCheckFile(worktree, VALID_CHECK_BODY);
              return { stdout: CHECKS_WRITTEN_STDOUT, commits: [] };
            },
          ),
        exec: checkRunExecSequence([GREEN_RUN, GREEN_RUN]),
        close: async () => {},
      } as unknown as SandboxHandle;
      const { ctx, quarantines, fallThroughs } = makeCtx({});
      const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

      expect(result.proceed).toBe(true);
      // Exactly 3 real check-writer invocations: the mislabelled attempt 1,
      // its transparent re-ask, and the ordinary green-proof retry.
      expect(checkWriterCalls).toHaveLength(3);
      expect(checkWriterCalls[2]!.CHECK_ATTEMPT).toBe("3");
      expect(quarantines).toHaveLength(0);
      // #1198 A: the honest-history prose moved from the stop message to the
      // fall-through note, and it is still exactly as honest.
      const note = fallThroughs[0]!.detail;
      expect(note).toContain("dispatched 3 times");
      expect(note).not.toContain("dispatched 4 times");
    });
  });

  it("green twice buys no third dispatch — the ticket builds without a first test instead (spec #1334: no budgeted rewrite)", async () => {
    const { sandbox, checkWriterCalls } = makeSandbox({
      worktree,
      exec: checkRunExecSequence([GREEN_RUN, GREEN_RUN]),
    });
    const { ctx, quarantines, fallThroughs } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    expect(checkWriterCalls).toHaveLength(2);
    expect(quarantines).toHaveLength(0);
    expect(fallThroughs.map((f) => f.reason)).toEqual(["no-failing-check"]);
  });

  it("an inconclusive proof retries the RUN, not the writer — a re-run red proceeds and mints the receipt", async () => {
    const exec = vi.fn(checkRunExecSequence([INCONCLUSIVE_RUN, RED_RUN]));
    const { sandbox, checkWriterCalls } = makeSandbox({ worktree, exec });
    const { ctx, quarantines } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    expect(quarantines).toHaveLength(0);
    // ONE writer dispatch: the writer's retry was not burned on the sandbox.
    expect(checkWriterCalls).toHaveLength(1);
    // TWO runs of the same command: the proof, then its one re-run.
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1]![0]).toBe(exec.mock.calls[0]![0]);
    // The re-run red is as real as a first-run red: it mints the durable
    // receipt a checkpoint/resume later depends on.
    expect(
      existsSync(
        path.join(
          worktree,
          checkDirForIssue(ISSUE),
          MUST_FAIL_FIRST_RECEIPT_FILENAME,
        ),
      ),
    ).toBe(true);
  });

  it("#1198 second review, F3: the re-run pings the stall watchdog BEFORE it starts, so the pair cannot fill the whole 90-minute window in silence", async () => {
    // The proof run and its re-run sit back to back in ONE phase. #1198 C
    // raised the per-check ceiling from 15 to 45 minutes, so the pair can
    // legitimately run 90 — the stall watchdog's entire window — and without
    // a ping between them a perfectly healthy re-run is SIGKILLed for making
    // no progress while doing exactly what it was told to.
    const exec = vi.fn(checkRunExecSequence([INCONCLUSIVE_RUN, RED_RUN]));
    const { sandbox } = makeSandbox({ worktree, exec });
    const { ctx } = makeCtx({});
    // How many check runs had happened at each ping. A ping recorded at 1 is
    // one that landed AFTER the first proof run and BEFORE the re-run.
    const pingsAtRunCount: number[] = [];
    (ctx as { status: Record<string, unknown> }).status.noteProgress = () => {
      pingsAtRunCount.push(exec.mock.calls.length);
    };

    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(pingsAtRunCount).toContain(1);
  });

  it("ENVIRONMENT-shaped inconclusive twice BUILDS the ticket (#1198 A) — no re-queue to wait a night for, and the fault is still named", async () => {
    const exec = vi.fn(
      checkRunExecSequence([INCONCLUSIVE_RUN, INCONCLUSIVE_RUN]),
    );
    const { sandbox, checkWriterCalls } = makeSandbox({ worktree, exec });
    const { ctx, quarantines, stops, fallThroughs } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    expect(checkWriterCalls).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(2);
    // #1198 A: this used to quarantine `stopped:run-fault` and wait for the
    // auto-requeue sweep at the next healthy start — a night lost to a
    // wedged sandbox that says nothing about whether the work is doable.
    expect(quarantines).toHaveLength(0);
    expect(stops).toHaveLength(0);
    expect(fallThroughs.map((f) => f.reason)).toEqual(["run-fault"]);
    // Still blames the environment, never the ticket, and still names the
    // fault so it gets fixed for the next night's run.
    expect(fallThroughs[0]!.detail).toContain("environment fault");
    expect(fallThroughs[0]!.detail).toContain("could not RUN the check");
  });

  // 2026-09-01 review, finding D: the deterministic screen-unreached shape
  // must not ping-pong as a run fault — it is the CHECK's fault, and the
  // remedy inside the run is a briefed rewrite.
  it("a red that never proved reaching its screen, twice, goes to a BRIEFED writer retry — not a run-fault stop", async () => {
    const exec = vi.fn(
      checkRunExecSequence([UNREACHED_RED_RUN, UNREACHED_RED_RUN, RED_RUN]),
    );
    const { sandbox, checkWriterCalls } = makeSandbox({ worktree, exec });
    const { ctx, quarantines } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    expect(quarantines).toHaveLength(0);
    // Two writer dispatches: the original, and the unreached-screen rewrite.
    expect(checkWriterCalls).toHaveLength(2);
    // Three runs: proof, its one re-run, the rewrite's own proof.
    expect(exec).toHaveBeenCalledTimes(3);
    const brief = checkWriterCalls[1]!.REPAIR_BRIEF!;
    expect(checkWriterCalls[1]!.CHECK_ATTEMPT).toBe("2");
    expect(brief).toContain("WITHOUT");
    expect(brief).toContain("reached the screen");
    expect(brief).toContain("waitForGradableScreen");
    // Ruling 6 here too: no app output rides the brief.
    expect(brief).toContain("output is deliberately withheld");
  });

  it("the unreached-screen shape persisting through the rewrite is recorded as no-failing-check — never run-fault", async () => {
    const exec = vi.fn(checkRunExecSequence([UNREACHED_RED_RUN]));
    const { sandbox, checkWriterCalls } = makeSandbox({ worktree, exec });
    const { ctx, quarantines, fallThroughs } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    // Two writers (original + the one unreached retry), four runs (each
    // proof re-run once).
    expect(checkWriterCalls).toHaveLength(2);
    expect(exec).toHaveBeenCalledTimes(4);
    // The RECORD blames the CHECK (which is where the fault is), never the
    // environment — the distinction survives #1198 A intact, because "the
    // check was broken" and "the sandbox was broken" still send a person
    // looking in different places.
    expect(quarantines).toHaveLength(0);
    expect(fallThroughs.map((f) => f.reason)).toEqual(["no-failing-check"]);
  });

  it("an inconclusive proof whose re-run comes back GREEN rejoins the ordinary briefed-retry ladder", async () => {
    const exec = vi.fn(
      checkRunExecSequence([INCONCLUSIVE_RUN, GREEN_RUN, RED_RUN]),
    );
    const { sandbox, checkWriterCalls } = makeSandbox({ worktree, exec });
    const { ctx } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    // Dispatch 2 happened BECAUSE of the re-run's green, with the brief.
    expect(checkWriterCalls).toHaveLength(2);
    expect(checkWriterCalls[1]!.REPAIR_BRIEF).toContain("REJECTED");
  });

  it("the brief builders carry the WHY and the withheld-answer rule (unit-level pin)", () => {
    const brief = mustFailFirstRetryBrief({
      reason: "observed green, expected red (exit 0) — mismatch",
    });
    expect(brief).toContain("observed green, expected red");
    expect(brief).toContain("YOUR OWN previous try");
    // The guarding sentences, pinned in full (2026-09-01 review, finding J:
    // `toContain("never")` was itself a weak pin).
    expect(brief).toContain(
      "choose what you assert by the ticket's own rules, never",
    );
    expect(brief).toContain("by what the application was observed to do");
    // Finding F: the brief carries NO application output — an observed tail
    // invites assertions that merely negate the observed value.
    expect(brief).toContain(
      "The run's application output is deliberately withheld",
    );
    expect(brief).not.toContain("Redacted tail");
    expect(brief).toContain('an assertion that merely negates an observed value');
    // Absent inputs render stated absences, not empty clauses.
    const bare = mustFailFirstRetryBrief({ reason: undefined });
    expect(bare).toContain("(no reason recorded)");
  });

  // 2026-09-01 review, finding G: the missing-helper (refusal) road. The
  // refusal is clerical — no proof ever ran — so ONE observed green after it
  // must buy the ordinary green retry, never be counted as a second green
  // with a "twice in a row" story.
  it("refusal-retry then ONE green goes through the ordinary green retry", async () => {
    const { sandbox, checkWriterCalls } = makeSandbox({
      worktree,
      exec: checkRunExecSequence([GREEN_RUN, RED_RUN]),
      bodies: [HELPERLESS_CHECK_BODY, VALID_CHECK_BODY],
    });
    const { ctx, quarantines } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    expect(quarantines).toHaveLength(0);
    // Three dispatches: refused attempt, its rewrite (green), the ordinary
    // green retry (red) — with true attempt numbers all the way.
    expect(checkWriterCalls).toHaveLength(3);
    expect(checkWriterCalls[2]!.CHECK_ATTEMPT).toBe("3");
    expect(checkWriterCalls[2]!.REPAIR_BRIEF).toContain("REJECTED");
  });

  it("the fall-through after the refusal road states the REAL counts — never a false history", async () => {
    const { sandbox, checkWriterCalls } = makeSandbox({
      worktree,
      exec: checkRunExecSequence([GREEN_RUN]),
      bodies: [HELPERLESS_CHECK_BODY, VALID_CHECK_BODY],
    });
    const { ctx, quarantines, fallThroughs } = makeCtx({});
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha");

    expect(result.proceed).toBe(true);
    // Refused attempt, rewrite (green), green retry (green) — three
    // dispatches, two OBSERVED greens. Never a fourth, budgeted rewrite.
    expect(checkWriterCalls).toHaveLength(3);
    expect(checkWriterCalls[2]!.CHECK_ATTEMPT).toBe("3");
    expect(quarantines).toHaveLength(0);
    // #1198 A: the honest-history prose moved onto the fall-through note.
    // It is exactly as honest there — a person reading a ticket that was
    // built without a first test needs the real counts just as much.
    const note = fallThroughs[0]!.detail;
    expect(note).toContain("dispatched 3 times");
    expect(note).toContain("PASSED against the untouched, pre-fix code twice");
    // The false histories the old wording invented:
    expect(note).not.toContain("twice in a row");
  });

  it("missingHelperRetryBrief quotes the refusal verbatim", () => {
    const err = Object.assign(new Error("x"), {
      message:
        "check-writer-missing-graded-helper: the Playwright check file never " +
        "calls gradeScreenText(...)",
    });
    const brief = missingHelperRetryBrief(err as never);
    expect(brief).toContain("never calls gradeScreenText(...)");
    expect(brief).toContain("YOUR OWN previous try");
  });
});
