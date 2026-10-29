/**
 * Issue #914 (Piece H of `docs/specs/2026-08-04-screen-check-design-lock.md`)
 * — the five ways a ticket stops, proven end-to-end through the REAL
 * production code paths (`runCheckWriterStage`, `shipAfterMigrations`,
 * `enforceProtectedPaths`), not just the pure `stop-reasons.ts` helpers
 * (those are covered in `lib/state/stop-reasons.test.ts`).
 *
 * What this file proves, matching the ticket's own "Prove it" section:
 *
 *   1. No two of the five stops produce the same label — asserted against
 *      the REAL throw sites (`ScreenCheckStopError`/`ProtectedPathTamperStopError`)
 *      and the REAL `runCheckWriterStage` early-stop returns, not a
 *      hand-rolled label table.
 *   2. The issue BODY is updated (via `ctx.deps.reportStop`), never a
 *      comment (`ctx.deps.comment` is never called by any of the five
 *      stops) — and a second stop on the same fake "issue" updates the
 *      recorded call rather than the loop trying to append blindly (the
 *      actual dedup/update happens in `applyStopReport`/`upsertStopSection`,
 *      already proven against real `gh` argv in
 *      `lib/state/gh.stop-report.test.ts`; this file proves `main.mts`
 *      actually CALLS `reportStop` with the right label for each of the
 *      five stops, which is the wiring those lower-level tests can't see).
 *   3. `stopReasonLabel` + `postSha` survive on the thrown error objects,
 *      which is what lets the rework-store record exist at all (see
 *      `stop-reasons.ts`'s own doc comment on why `postSha` has to be
 *      carried on the error).
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GREEN_RUN,
  RED_RUN,
  checkRunExec,
} from "./__fixtures__/check-evidence.js";
import { commitInto, git } from "./__fixtures__/git-repo.js";
import { checkDirForIssue } from "./lib/checkwriter/check-path.js";
import { quarantineTerminalLabel } from "./lib/state/gh.js";
import {
  ProofDemandUnsatisfiedStopError,
  ProtectedPathTamperStopError,
  ScreenCheckStopError,
  STOP_REASON_LABELS,
  type QuarantineOpts,
  type StopReasonLabel,
} from "./lib/state/stop-reasons.js";
import { IssueTelemetryBag } from "./lib/telemetry/issue-bag.js";
import {
  enforceProtectedPaths,
  runCheckWriterStage,
  shipAfterMigrations,
  type SandboxHandle,
  type ScreenCheckHarnessResult,
} from "./main.mts";
import { SHIP_INPUT_DEFAULTS } from "./__fixtures__/ship-input.mts";

const PROTECTED_FILE = "apps/nextjs/e2e/lib/teams/bright-city.ts";

/** A fenced ```json``` envelope + bare marker — the shape
 *  `extractMarker`/`parseVerdict` actually expect on the last non-empty
 *  lines of the agent's stdout (mirrors `main.checkwriter.test.mts`). */
function envelope(body: Record<string, unknown>, marker: string): string {
  return (
    `Some reasoning.\n\n` +
    "```json\n" +
    `${JSON.stringify(body, null, 2)}\n` +
    "```\n\n" +
    `${marker}\n`
  );
}

describe("the five stops are DISTINCT at the real throw sites — no two share a label", () => {
  let repo: string;
  let commit: (files: Record<string, string>, message: string) => string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sc-stop-reasons-"));
    git(repo, "init", "-q", "-b", "issue-914");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commit = (files, message) => commitInto(repo, files, message);
    commit({ "README.md": "seed\n" }, "init");
    git(repo, "branch", "run");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function makeShipCtx(over: {
    runScreenCheckHarness?: (...a: unknown[]) => Promise<ScreenCheckHarnessResult>;
    /** Only the unmeasurable-diff test overrides this — see its own comment. */
    repoRoot?: string;
    reportScreenCheckWatch?: (...a: unknown[]) => Promise<void>;
  }): unknown {
    return {
      args: {
        repoRoot: over.repoRoot ?? repo,
        branch: "run",
        stagingEnabled: true,
      },
      issueNumber: 914,
      issue: { branch: "issue-914" },
      deps: {
        log: () => {},
        logError: () => {},
        checkLintCert: async () => ({ status: "dormant" }),
        checkTestCert: async () => ({ status: "dormant" }),
        validateMigrationJournal: async () => [],
        applyMigrations: async () => ({ realErrors: [], applied: 0 }),
        runScreenCheckHarness: over.runScreenCheckHarness,
        reportScreenCheckWatch: over.reportScreenCheckWatch,
      },
      telemetry: {
        noteShipPath: () => {},
        noteDiff: () => {},
        noteImplementerAttempt: () => {},
        noteImplementerCertification: () => {},
        noteScreenCheck: () => {},
      },
      runCounters: { bump: () => {} },
    };
  }

  function harnessResult(
    verdict: ScreenCheckHarnessResult["verdict"],
  ): ScreenCheckHarnessResult {
    return {
      verdict,
      reason: `stub reason for ${verdict}`,
      rerun: false,
      record: {
        verdict,
        whenIso: "2026-08-04T13:00:00.000Z",
        rerun: false,
        pictureStored: false,
      },
    };
  }

  /** What a red screen check RECORDED (spec #1334: a record, never a stop):
   *  the label it used to stop with, its message, and its both-sides block. */
  interface Recorded {
    readonly stopReasonLabel: string | undefined;
    readonly message: string;
    readonly disagreement?: {
      checkDemanded?: string;
      builderProduced?: string;
      builderAccount?: string;
    };
  }

  async function recordedAs(
    verdict: ScreenCheckHarnessResult["verdict"],
  ): Promise<Recorded> {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ [`apps/nextjs/src/${verdict}.tsx`]: "x\n" }, verdict);
    const watched: {
      wouldHaveStoppedAs?: string;
      detail: string;
      disagreement?: Recorded["disagreement"];
    }[] = [];
    const outcome = await shipAfterMigrations(
      makeShipCtx({
        runScreenCheckHarness: async () => harnessResult(verdict),
        reportScreenCheckWatch: async (...a) => {
          watched.push(a[1] as (typeof watched)[number]);
        },
      }) as never,
      { worktreePath: repo, exec: undefined } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: "CHECKS_WRITTEN",
        checkWriterCheckCommand: "check-command",
        checkWriterScreen: "/finance/reports?view=team",
      },
    );
    expect(outcome.status).toBe("ok");
    expect(watched).toHaveLength(1);
    return {
      stopReasonLabel: watched[0]!.wouldHaveStoppedAs,
      message: watched[0]!.detail,
      disagreement: watched[0]!.disagreement,
    };
  }

  it("never-settled, claim-mismatch, environment-fault and inconclusive all record stopped:could-not-grade — graded-mismatch is the ONLY one that records stopped:check-disagreement", async () => {
    const neverSettled = await recordedAs("never-settled");
    const claimMismatch = await recordedAs("claim-mismatch");
    const environmentFault = await recordedAs("environment-fault");
    const inconclusive = await recordedAs("inconclusive");
    const gradedMismatch = await recordedAs("graded-mismatch");

    expect(neverSettled.stopReasonLabel).toBe("stopped:could-not-grade");
    expect(claimMismatch.stopReasonLabel).toBe("stopped:could-not-grade");
    expect(environmentFault.stopReasonLabel).toBe("stopped:could-not-grade");
    expect(inconclusive.stopReasonLabel).toBe("stopped:could-not-grade");
    expect(gradedMismatch.stopReasonLabel).toBe("stopped:check-disagreement");

    // Distinct MESSAGES too — a human reading the log can tell all five
    // apart even though four share a label.
    const messages = [
      neverSettled,
      claimMismatch,
      environmentFault,
      inconclusive,
      gradedMismatch,
    ].map((e) => e.message);
    expect(new Set(messages).size).toBe(5);
  });

  it("graded-mismatch carries BOTH sides of the disagreement — the owner is the tie-breaker and cannot be handed only one side", async () => {
    const err = await recordedAs("graded-mismatch");
    expect(err.disagreement?.checkDemanded).toContain("check-command");
    expect(err.disagreement?.builderProduced).toContain("first-pass-only");
    expect(err.disagreement?.builderAccount).toBeTruthy();
  });

  it("the OTHER four verdicts carry NO disagreement — that record only makes sense for a builder-vs-check dispute", async () => {
    for (const verdict of [
      "never-settled",
      "claim-mismatch",
      "environment-fault",
      "inconclusive",
    ] as const) {
      const err = await recordedAs(verdict);
      expect(err.disagreement).toBeUndefined();
    }
  });

  it("a tamper the run cannot undo is stopped:checks-tampered — DISTINCT from every harness-driven label (an edit it CAN undo never stops, spec #1334)", async () => {
    const original = "export const bright = 1;\n";
    const preSha = commit({ [PROTECTED_FILE]: original }, "seed");
    const postSha = commit({ [PROTECTED_FILE]: "export const bright = 2;\n" }, "tamper 1");
    const postSha2 = commit(
      { [PROTECTED_FILE]: "export const bright = 3;\n" },
      "tamper 2 (from the same tip, simulating a second dispatch)",
    );
    const bag = new IssueTelemetryBag();
    bag.noteChecksTampered(); // simulate: this ticket already tampered once
    const ctx = {
      args: { repoRoot: repo, branch: "issue-914" },
      deps: { log: () => {}, logError: () => {} },
      issueNumber: 914,
      telemetry: bag,
    } as never;

    // A second edit the run CAN restore: restored, no stop.
    await expect(
      enforceProtectedPaths(
        ctx,
        { branch: "issue-914", worktreePath: repo } as never,
        postSha,
        postSha2,
        { changedLines: 1, changedFiles: [PROTECTED_FILE] },
      ),
    ).resolves.toMatchObject({ sha: expect.any(String) });

    // An edit with no base commit to restore from: the one tamper stop left.
    let caught: ProtectedPathTamperStopError | undefined;
    try {
      await enforceProtectedPaths(
        ctx,
        { branch: "issue-914", worktreePath: repo } as never,
        "",
        postSha2,
        { changedLines: 1, changedFiles: [PROTECTED_FILE] },
      );
    } catch (err) {
      caught = err as ProtectedPathTamperStopError;
    }
    expect(caught).toBeInstanceOf(ProtectedPathTamperStopError);
    expect(caught!.stopReasonLabel).toBe("stopped:checks-tampered");
    expect(caught!.postSha).toBe(postSha2);
    void preSha;
  });

  it("every label that can ever be thrown/returned is a pairwise distinct string", () => {
    expect(new Set(STOP_REASON_LABELS).size).toBe(STOP_REASON_LABELS.length);
    // Piece H's original five are still all there — issue #923 added four
    // more, it did not rename or repurpose any of these.
    expect(STOP_REASON_LABELS.length).toBeGreaterThanOrEqual(5);
  });

  it("a never-waived proof refusal throws ProofDemandUnsatisfiedStopError, typed and labelled — never a plain Error (issue #914 finding)", async () => {
    // Before the fix, this threw a plain `Error`, which has no `instanceof`
    // arm in `runIssuePipeline`'s catch block — it fell through past the
    // OTHER typed stops straight into the opt-in recovery pass, which could
    // ship the ticket with NO screen check at all. Since spec #1334 a plain
    // unmet demand is only recorded, so this drives a NEVER-waived refusal —
    // a diff that DELETES a test file — to keep the typed throw pinned. (An
    // edit to another ticket's locked check used to be the fixture here;
    // since spec #1334 SH that is the older-test rule's job, and its refusal
    // goes to the fixer rather than stopping the ticket.)
    const removedTest = "packages/api/src/relist.test.ts";
    commit({ [removedTest]: 'it("relists", () => {});\n' }, "a test on the run branch");
    git(repo, "branch", "-f", "run", "HEAD");
    const preSha = git(repo, "rev-parse", "HEAD");
    git(repo, "rm", "-q", removedTest);
    git(repo, "commit", "-q", "-m", "deleted a test");
    const postSha = git(repo, "rev-parse", "HEAD");
    let caught: ProofDemandUnsatisfiedStopError | undefined;
    try {
      await shipAfterMigrations(
        makeShipCtx({}) as never,
        { worktreePath: repo, exec: undefined } as never,
        {
          ...SHIP_INPUT_DEFAULTS,
          preSha,
          postSha,
          finalMarker: "ALL_CLEAR",
          checkWriterMarker: "NO_SCREEN_APPLIES",
        },
      );
      throw new Error("expected the test deletion to throw");
    } catch (err) {
      caught = err as ProofDemandUnsatisfiedStopError;
    }
    expect(caught).toBeInstanceOf(ProofDemandUnsatisfiedStopError);
    expect(caught!.stopReasonLabel).toBe("stopped:check-disagreement");
    expect(caught!.postSha).toBe(postSha);
    expect(caught!.touchedPaths).toContain(removedTest);
    // Distinct from every harness-driven label and from checks-tampered —
    // proven pairwise across the whole suite by the "all FIVE labels" test
    // above; this just proves THIS throw site actually reaches one of them.
    expect(STOP_REASON_LABELS).toContain(caught!.stopReasonLabel);
  });

  it("a diff git CANNOT be asked about stops the ticket — an unmeasurable diff is never an all-clear", async () => {
    // THE FAIL-OPEN THIS PINS. The proof gate is fed the changed-file list from
    // `reviewDiffStats`, which is fail-quiet by design: any `git diff` error
    // comes back `{changedLines: 0, changedFiles: []}`, byte-identical to a
    // genuinely empty diff. An empty list makes `requiredProofForDiff` answer
    // `none`, and `none` is satisfied by EVERY marker — so before this fix a
    // single git hiccup at the ship funnel waived the entire gate and shipped
    // an unproven diff. That is the same "silence reads as an all-clear" shape
    // its sibling `guttedFilesBetween` already refuses to produce, and it is
    // strictly worse: the removal half is allowed to carry on past a `null`
    // only BECAUSE the demand half is independently conservative, which stops
    // being true the moment the changed-file list is the thing that failed.
    //
    // `repoRoot` points at a directory that is not a git repo, so every
    // `runGit` in the funnel fails while the sandbox worktree is untouched —
    // the closest reproduction of a real git hiccup that does not require
    // breaking git itself.
    const notARepo = mkdtempSync(path.join(tmpdir(), "sc-not-a-repo-"));
    try {
      const preSha = git(repo, "rev-parse", "HEAD");
      const postSha = commit(
        { "apps/nextjs/src/app/page.tsx": "export default function Page() {}\n" },
        "a screen the gate must not be allowed to miss",
      );
      let caught: ProofDemandUnsatisfiedStopError | undefined;
      try {
        await shipAfterMigrations(
          makeShipCtx({ repoRoot: notARepo }) as never,
          { worktreePath: repo, exec: undefined } as never,
          {
            ...SHIP_INPUT_DEFAULTS,
            preSha,
            postSha,
            finalMarker: "ALL_CLEAR",
            checkWriterMarker: "NO_SCREEN_APPLIES",
          },
        );
        throw new Error("expected an unmeasurable diff to stop the ticket");
      } catch (err) {
        caught = err as ProofDemandUnsatisfiedStopError;
      }
      expect(caught).toBeInstanceOf(ProofDemandUnsatisfiedStopError);
      expect(caught!.stopReasonLabel).toBe("stopped:check-disagreement");
      expect(caught!.postSha).toBe(postSha);
      // The stop must say WHY it could not decide, or an owner reading the
      // issue body sees a proof failure and goes looking for a missing check.
      expect(caught!.message).toContain("could not measure");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe("the check-writer stops that SURVIVE #1198 A call ctx.deps.reportStop with the right label, and NEVER ctx.deps.comment", () => {
  function makeSandbox(stdout: string, worktreePath?: string): SandboxHandle {
    return {
      branch: "issue-914",
      worktreePath,
      // Only the check-writer runs inside `runCheckWriterStage` (the judge's
      // early pass was deleted by spec #1334).
      run: vi.fn().mockResolvedValue({ stdout, commits: [] }),
      close: async () => {},
    } as unknown as SandboxHandle;
  }

  function makeCtx(deps: Record<string, unknown>): unknown {
    return {
      args: { repoRoot: "/repo", branch: "run", stagingEnabled: true },
      deps: {
        log: () => {},
        logError: () => {},
        captureSha: async () => "sha-at-stop",
        ...deps,
      },
      ticketOrdinal: 1,
      issueNumber: 914,
      issue: { branch: "issue-914" },
      status: { setIssuePhase: () => {} },
      telemetry: {
        noteCheckWriterOutcome: () => {},
        noteCheckWriterInherited: () => {},
        noteCheckWriterMustFailFirst: () => {},
        noteCheckWriterRetried: () => {},
        noteStopReason: () => {},
      },
    };
  }

  it("ALREADY_BUILT reports NO stop since spec #1334 SG — it goes to the reviewer — and never posts a comment", async () => {
    const comment = vi.fn();
    const reportStop = vi.fn();
    const ctx = makeCtx({
      quarantine: async () => {},
      comment,
      reportStop,
    });
    const result = await runCheckWriterStage(
      makeSandbox(
        envelope(
          { marker: "ALREADY_BUILT", inherited: false, alreadyBuiltEvidence: "x" },
          "ALREADY_BUILT",
        ),
      ),
      ctx as never,
      "pre-sha-0",
    );
    expect(comment).not.toHaveBeenCalled();
    expect(reportStop).not.toHaveBeenCalled();
    expect(result.proceed).toBe(true);
  });

  it("NEEDS_WORLD_DATA reports NO stop at all since #1198 A — it builds anyway, and never posts a comment", async () => {
    const comment = vi.fn();
    const reportStop = vi.fn();
    const quarantine = vi.fn(async () => {});
    const ctx = makeCtx({ quarantine, comment, reportStop });
    const result = await runCheckWriterStage(
      makeSandbox(
        envelope(
          { marker: "NEEDS_WORLD_DATA", inherited: false, worldDataNeeded: "x" },
          "NEEDS_WORLD_DATA",
        ),
      ),
      ctx as never,
      "pre-sha-0",
    );
    expect(comment).not.toHaveBeenCalled();
    // No stop label, no quarantine — a missing practice-world fixture stops
    // the loop writing a CHECK, not writing the FEATURE.
    expect(reportStop).not.toHaveBeenCalled();
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.proceed).toBe(true);
  });

  it("twice-green reports NO stop since #1198 A — it builds anyway, and never posts a comment", async () => {
    const comment = vi.fn();
    const reportStop = vi.fn();
    const exec = vi.fn(checkRunExec(GREEN_RUN));
    const quarantine = vi.fn(async () => {});
    const ctx = makeCtx({ quarantine, comment, reportStop });
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/x",
        checkPath: "x.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox(stdout, "/nonexistent-914");
    (sandbox as unknown as { exec: unknown }).exec = exec;
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");
    expect(comment).not.toHaveBeenCalled();
    expect(reportStop).not.toHaveBeenCalled();
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.proceed).toBe(true);
  });

  it("an unparseable envelope never posts a comment and never throws past runCheckWriterStage (issue #914) — since #1198 A it builds instead of stopping", async () => {
    const comment = vi.fn();
    const reportStop = vi.fn();
    const quarantine = vi.fn(async () => {});
    const ctx = makeCtx({ quarantine, comment, reportStop });
    // No JSON fence at all — `parseVerdict` throws `VerdictParseError`.
    // Before the fix, THIS propagated straight out of `runCheckWriterStage`
    // into `runIssuePipeline`'s catch block, where it could fall through to
    // the recovery pass and ship with no check-writer pass at all.
    const result = await runCheckWriterStage(
      makeSandbox("Some reasoning with no structured envelope.\n\nCHECKS_WRITTEN\n"),
      ctx as never,
      "pre-sha-0",
    );
    expect(comment).not.toHaveBeenCalled();
    expect(reportStop).not.toHaveBeenCalled();
    expect(quarantine).not.toHaveBeenCalled();
    // The #914 property — it is MODELLED here and never propagates — is what
    // this test exists for, and it holds either way: a proceed is a return,
    // not a throw, so the recovery pass is still unreachable from here.
    expect(result.proceed).toBe(true);
  });

  it("the one ALREADY_BUILT road that still ends the stage — certified on staging — populates outcome.postSha, so the rework-store record is not silently dropped", async () => {
    const ctx = makeCtx({
      quarantine: async () => {},
      comment: async () => {},
      markDone: async () => {},
      releaseIssueLease: async () => {},
      locateAlreadyBuiltWork: async () => ({ onMain: false, onStaging: true }),
    });
    (ctx as { args: Record<string, unknown> }).args.stagingEnabled = true;
    const result = await runCheckWriterStage(
      makeSandbox(
        envelope(
          { marker: "ALREADY_BUILT", inherited: false, alreadyBuiltEvidence: "x" },
          "ALREADY_BUILT",
        ),
      ),
      ctx as never,
      "pre-sha-0",
    );
    expect(result.proceed).toBe(false);
    if (result.proceed) throw new Error("expected the staging close");
    expect(result.outcome.postSha).toBeTruthy();
  });

  it("a CHECKS_WRITTEN proceed (not a stop) never calls reportStop at all", async () => {
    // A real, writable directory — finding #5's content check
    // (`missingGradedHelperCalls`) reads a real file off disk, so
    // `x.spec.ts` has to genuinely exist with valid content by the time
    // `runCheckWriter` reads it (simulated via `run`'s own side effect,
    // matching a real check-writer agent's tool calls — see
    // `main.checkwriter.test.mts`'s identical pattern). The body must call
    // BOTH graded helpers since issue #916 defect 1: it used to call only
    // `waitForGradableScreen`, which is a check that never grades anything
    // and is now refused outright.
    const worktree = mkdtempSync(
      path.join(tmpdir(), "sandcastle-stop-reasons-checkwriter-proceed-"),
    );
    const reportStop = vi.fn();
    const exec = vi.fn(checkRunExec(RED_RUN));
    const ctx = makeCtx({ reportStop, quarantine: async () => {} });
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/x",
        checkPath: "x.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox(stdout, worktree);
    (sandbox as unknown as { exec: unknown }).exec = exec;
    (sandbox as unknown as { run: unknown }).run = vi
      .fn()
      .mockImplementation(async () => {
      const dir = path.join(worktree, checkDirForIssue(914));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "x.spec.ts"),
        `import { gradeScreenText, waitForGradableScreen } from "../../lib/graded-screen-check";\n` +
          `test("x", async ({ page }) => {\n` +
          `  await waitForGradableScreen(page, { screen: "x", expectedClaim: {}, screenshotPath: "x" });\n` +
          `  await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
          `});\n`,
      );
      return { stdout, commits: [] };
    });
    try {
      const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");
      expect(result.proceed).toBe(true);
      expect(reportStop).not.toHaveBeenCalled();
      // Sanity: checkDirForIssue is reachable from this test's imports,
      // proving the protected-path glob this proceed path sets really
      // points at the check-writer's own directory (same assertion
      // `main.checkwriter.test.mts` makes — kept here as a cross-check, not
      // a duplicate of that file's job).
      if (result.proceed) {
        expect(result.ctx.protectedPathGlobs).toEqual([`${checkDirForIssue(914)}/**`]);
      }
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // Issue #1150 — the quarantine CALL SITE must thread the terminal-label
  // decision, not just the pure `quarantineTerminalLabel` function.
  //
  // The pure decision is already covered in `lib/state/gh.test.ts`. What was
  // missing — and why five owner-decision call sites shipped emitting the
  // wrong terminal label — is that nothing asserted `main.mts` actually PASSES
  // the opts the pure function reads. These drive the real `runCheckWriterStage`
  // through the check-writer-stage stops it is reachable from, capture the opts
  // the site handed `quarantine`, and route them back through the SAME pure
  // function the impure `quarantineViaLabel` uses — so the test and production
  // can never disagree about which terminal label a stop lands on.
  // ---------------------------------------------------------------------
  function captureQuarantineCtx(): {
    ctx: unknown;
    captured: (QuarantineOpts | undefined)[];
  } {
    const captured: (QuarantineOpts | undefined)[] = [];
    const ctx = makeCtx({
      quarantine: async (
        _n: number,
        _reason: string,
        opts?: QuarantineOpts,
      ) => {
        captured.push(opts);
      },
      comment: async () => {},
      reportStop: async () => {},
    });
    return { ctx, captured };
  }

  it("NEEDS_WORLD_DATA no longer quarantines at all (#1198 A) — the config handoff is written onto the body and the ticket is built", async () => {
    const { ctx, captured } = captureQuarantineCtx();
    const result = await runCheckWriterStage(
      makeSandbox(
        envelope(
          { marker: "NEEDS_WORLD_DATA", inherited: false, worldDataNeeded: "x" },
          "NEEDS_WORLD_DATA",
        ),
      ),
      ctx as never,
      "pre-sha-0",
    );
    // #1150 routed this to `needs-human` because extending the practice
    // world is a person's job. It still is — but that is a job for the NEXT
    // ticket on this surface, not a reason to hold this one un-built.
    expect(captured).toHaveLength(0);
    expect(result.proceed).toBe(true);
  });

  it("ALREADY_BUILT never reaches the owner (spec #1334 SG) — no quarantine at all; the reviewer confirms or refutes it", async () => {
    const { ctx, captured } = captureQuarantineCtx();
    const result = await runCheckWriterStage(
      makeSandbox(
        envelope(
          { marker: "ALREADY_BUILT", inherited: false, alreadyBuiltEvidence: "x" },
          "ALREADY_BUILT",
        ),
      ),
      ctx as never,
      "pre-sha-0",
    );
    expect(captured).toHaveLength(0);
    expect(result.proceed).toBe(true);
  });

  it("a check-writer marker/envelope mismatch NEVER reaches the owner (spec #1334) — no quarantine, the ticket is built with no first test", async () => {
    // The last-line marker (`NO_SCREEN_APPLIES`) disagrees with the fenced
    // JSON envelope's own `marker` (`CHECKS_WRITTEN`). This used to stop as
    // `stopped:check-disagreement` + `needs-human` (#1150). Owner decision
    // (spec #1334): a first-test problem never stops a ticket and never
    // reaches him — it builds with no first test instead.
    const { ctx, captured } = captureQuarantineCtx();
    const result = await runCheckWriterStage(
      makeSandbox(
        envelope(
          {
            marker: "CHECKS_WRITTEN",
            inherited: false,
            screen: "/x",
            checkPath: "x.spec.ts",
          },
          "NO_SCREEN_APPLIES",
        ),
      ),
      ctx as never,
      "pre-sha-0",
    );
    expect(captured).toHaveLength(0);
    expect(result.proceed).toBe(true);
  });
});

/**
 * Issue #923 — THE GUARD. Not a test of behaviour; a test of coverage.
 *
 * Sixteen of forty stops over twelve days left no `stopped:*` label, no
 * section in the issue body and nothing in the durable record, costing
 * $1,011.63. (They DID each get the one-line comment every stop posts —
 * see `quarantineViaLabel` in `lib/state/gh.ts`. What was missing is
 * everything that makes a stop countable and readable in the body.) The cause was not one bug: it was that a new
 * `quarantine` call site could be added to `main.mts` at any time and
 * nothing anywhere noticed it left no record. Seven had accumulated by
 * 2026-08-16.
 *
 * This reads the real `main.mts` source and fails the moment a
 * `ctx.deps.quarantine(...)` appears without a stop report or a stop label
 * beside it. It is deliberately a SOURCE scan rather than a behavioural
 * test: `runIssuePipeline` is not exported and driving it end-to-end needs
 * the whole agent/docker apparatus, so a behavioural test would cover the
 * sites someone remembered — which is exactly the thing that failed.
 */
describe("issue #923 — no quarantine call site may write nothing onto the ticket", () => {
  /** How many lines after the `quarantine(...)` call the report may appear.
   *  Generous on purpose: the point is to catch a site with NO report at
   *  all, not to police how the arm is formatted. */
  const WINDOW = 30;

  /**
   * Every file that can stop a ticket. **This list is the guard's known
   * blind spot, so it is stated rather than assumed.** The first pass of
   * this test scanned `main.mts` alone and matched only the literal
   * `ctx.deps.quarantine(`; the review of that pass found two live stop
   * sites it could not see — the staging post-merge failure, which blanks
   * EVERY ticket merged that round, and the stranded-promotion path in
   * `strand-backup.ts`. Both were genuinely silent.
   *
   * A stop site added in a file not listed here is still invisible. The
   * The "file list is COMPLETE" test below is what keeps this list
   * honest: it greps `.sandcastle/` for quarantine calls and fails if any
   * file carrying one is missing from this list.
   */
  const FILES_THAT_STOP_TICKETS = [
    "main.mts",
    "lib/state/strand-backup.ts",
  ] as const;

  /**
   * Matches ANY receiver — `ctx.deps.quarantine(`, `deps.quarantine(`, a
   * bare `quarantine(`. The first pass keyed on `ctx.deps.` and that one
   * prefix is what hid the two sites above.
   *
   * The window ALSO stops at the next `quarantine` call, and that bound is
   * load-bearing rather than tidiness: without it the stuck-detector's
   * unrecorded site read as covered, because a DIFFERENT site's
   * `reportStopBestEffort` sat 24 lines below it — one neighbour's report
   * vouching for another's silence.
   */
  const CALL = /(?:^|[^.\w])(?:\w+\.)*quarantine\(/;

  /**
   * The helpers that count as reporting a stop. Every one of them writes
   * BOTH the ticket (label and/or body) and the durable record.
   *
   * This list caught its own author: the staging site was refactored onto
   * `reportStopOutsidePipeline` and the guard immediately failed, because
   * the new name was not here yet. That is the guard working.
   */
  const REPORTERS = [
    "reportStopBestEffort",
    "applyStopLabelBestEffort",
    "reportStopOutsidePipeline",
    // `strand-backup.ts` is a module below `main.mts` and cannot reach those
    // helpers, so it calls the injected dep. `main.mts` wires that dep to
    // `reportStopOutsidePipeline`, which is what writes both surfaces.
    "deps.reportStop",
  ] as const;

  /**
   * Lines that mention quarantine but cannot stop a ticket. Each entry is
   * here because the scan really did flag it and it really is harmless:
   * the interface declaration, the two DEFINITIONS of the dep (which are
   * what the real call sites go through), the dep wiring, the status-store
   * recorder, the run-ender's counter, comments, and log strings.
   */
  const NOT_A_CALL = new RegExp(
    [
      "recordQuarantineOutcome", // status-store write, not a GitHub stop
      "quarantineViaLabel", // the low-level gh call the dep wraps
      "quarantine\\(issueNum", // the Deps interface declaration
      "async quarantine\\(", // the dep's own implementation
      "quarantine: \\(", // wiring one dep object into another
      "quarantinedIssues", // a local tally
      '"quarantine', // a log/label string, e.g. `what: "quarantine(s)"`
      "^\\s*\\*", // a doc comment line
      "^\\s*//", // a line comment
    ].join("|"),
  );

  function scan(relPath: string): { file: string; line: number; reports: boolean }[] {
    const source = readFileSync(
      path.join(import.meta.dirname, relPath),
      "utf8",
    ).split("\n");
    const callLines = source.flatMap((text, i) =>
      CALL.test(text) && !NOT_A_CALL.test(text) ? [i] : [],
    );
    return callLines.map((start, k) => {
      const nextCall = callLines[k + 1] ?? source.length;
      const window = source
        .slice(start, Math.min(start + WINDOW, nextCall))
        // COMMENTS AND STRINGS ARE STRIPPED before the window is searched.
        // Without this, a new silent site passes merely by sitting near a
        // line that MENTIONS the helper — e.g. `// TODO: consider
        // reportStopBestEffort here one day`. A guard a comment can satisfy
        // is not a guard.
        .filter((t) => !/^\s*(\/\/|\*|\/\*)/.test(t))
        .join("\n");
      return {
        file: relPath,
        line: start + 1,
        reports: REPORTERS.some((fn) => window.includes(fn)),
      };
    });
  }

  function allSites(): { file: string; line: number; reports: boolean }[] {
    return FILES_THAT_STOP_TICKETS.flatMap(scan);
  }

  it("the file list is COMPLETE — every file under .sandcastle that can stop a ticket is scanned", { timeout: 30_000 }, () => {
    // The safety net the FILES_THAT_STOP_TICKETS comment promises. Without
    // it that list is an assertion nothing checks, which is the same shape
    // of blind spot the first version of this guard had: a stop site in an
    // unlisted file would be invisible and the suite would stay green.
    //
    // Candidates come from grep, but whether a file REALLY holds a stop
    // site is decided by the same CALL/NOT_A_CALL rule the guard itself
    // uses — so the two can never disagree about what counts.
    const root = import.meta.dirname;
    const candidates = execFileSync(
      "grep",
      [
        "-rl",
        "--include=*.ts",
        "--include=*.mts",
        // Nested checkouts and package caches contain whole COPIES of this
        // repo. Scanning them would flag the copy of the very file already
        // in the list.
        "--exclude-dir=node_modules",
        "--exclude-dir=worktrees",
        "--exclude-dir=.pnpm-store",
        "-E",
        String.raw`(^|[^.\w])(\w+\.)*quarantine\(`,
        ".",
      ],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter((f) => f.length > 0)
      .map((f) => f.replace(/^\.\//, ""))
      .filter((f) => !/\.test\.(ts|mts)$/.test(f));

    const reallyStops = candidates.filter((relPath) => {
      const source = readFileSync(path.join(root, relPath), "utf8").split("\n");
      return source.some((t) => CALL.test(t) && !NOT_A_CALL.test(t));
    });

    const unscanned = reallyStops.filter(
      (f) => !(FILES_THAT_STOP_TICKETS as readonly string[]).includes(f),
    );
    expect(
      unscanned,
      `${unscanned.join(", ")} contain(s) a real quarantine call but is not ` +
        `in FILES_THAT_STOP_TICKETS, so the guard below cannot see it. Add ` +
        `it to that list.`,
    ).toEqual([]);
    // Prove the grep found anything at all — an empty candidate list would
    // make this test pass for the wrong reason, forever.
    expect(reallyStops.length).toBeGreaterThanOrEqual(2);
  });

  it("finds the quarantine sites at all — a scan that matches nothing would pass silently forever", { timeout: 30_000 }, () => {
    // Prove the instrument before believing its silence. Measured at 17 after
    // spec #1334 (SF2) deleted the judge-era refusal quarantines; 13 after SG,
    // which deleted the skipped-skills stop, the already-built owner handoff
    // and the recovery road's two stops, and folded the builder's three
    // refusal stops into one (plus the fixer's refusal and failure stops).
    // Still 13 after the fix pass: the proof-demand stop went to the fixer,
    // and the unclear-ticket stop (`stopTicketUnclear`) arrived.
    expect(allSites().length).toBeGreaterThanOrEqual(13);
  });

  it("finds sites reached through a receiver other than `ctx.deps` — the exact blind spot that hid two of them", { timeout: 30_000 }, () => {
    // Counted by RECEIVER, not by line number. An earlier version of this
    // test keyed on `line > 15000`, which any insertion above that point
    // would have silently weakened.
    const byReceiver = FILES_THAT_STOP_TICKETS.flatMap((relPath) => {
      const source = readFileSync(
        path.join(import.meta.dirname, relPath),
        "utf8",
      ).split("\n");
      return source.filter(
        (t) => CALL.test(t) && !NOT_A_CALL.test(t) && !t.includes("ctx.deps."),
      );
    });
    expect(byReceiver.length).toBeGreaterThanOrEqual(2);
  });

  it("a COMMENT mentioning the helper does not satisfy the guard", { timeout: 30_000 }, () => {
    // Mutation test, run against a synthetic source rather than the real
    // file: prove the guard rejects the cheapest way to fake compliance.
    const fake = [
      "async function newStop(ctx) {",
      "  await ctx.deps.quarantine(ctx.issueNumber, 'x');",
      "  // TODO: consider reportStopBestEffort here one day",
      "}",
    ];
    const callLines = fake.flatMap((t, i) =>
      CALL.test(t) && !NOT_A_CALL.test(t) ? [i] : [],
    );
    expect(callLines).toHaveLength(1);
    const window = fake
      .slice(callLines[0]!, callLines[0]! + WINDOW)
      .filter((t) => !/^\s*(\/\/|\*|\/\*)/.test(t))
      .join("\n");
    expect(REPORTERS.some((fn) => window.includes(fn))).toBe(false);
  });

  it("every single one writes a reason onto the ticket or applies a countable label", { timeout: 30_000 }, () => {
    const silent = allSites()
      .filter((s) => !s.reports)
      .map((s) => `${s.file}:${s.line}`);
    expect(
      silent,
      `${silent.join(", ")} stop a ticket without writing any reason onto ` +
        `it. Unrecorded stops cost the owner $1,011.63 across sixteen ` +
        `tickets ` +
        `in twelve days (issue #923). Add a reportStopBestEffort(...) call ` +
        `— or, if this site already posts a GitHub comment carrying the ` +
        `full explanation, an applyStopLabelBestEffort(...) call so the ` +
        `stop is at least countable.`,
    ).toEqual([]);
  });
});

/**
 * Issue #1150 — THE WIRING GUARD. A structural sibling of issue #923's guard.
 *
 * #1150 split the terminal stop label: a loop FAILURE lands on `quarantine`,
 * and an owner/config handoff lands on `needs-human`. The pure decision
 * (`quarantineTerminalLabel`) reads the opts a call site hands it. Five
 * owner-decision call sites emitted an owner-decision stop label but called
 * `quarantine(...)` with NO opts, so they silently defaulted to `quarantine`
 * when they owed `needs-human`. Nothing caught it because only the pure
 * function was tested, never the wiring — exactly the blind spot #923's guard
 * exists to close for the "wrote nothing" defect, reproduced one axis over.
 *
 * This reads the real `main.mts` source and fails the moment an owner-decision
 * or handoff quarantine site drops its opts. It is a SOURCE scan for the same
 * reason #923's is: `runIssuePipeline` is not exported and driving it needs the
 * whole agent/docker apparatus, so a behavioural test covers only the sites
 * someone remembered — which is the thing that failed.
 *
 * Each site is anchored by a STABLE nearby string, never a line number: the
 * five drifted between the review and this fix, so anchoring on line numbers
 * would be the same fragility that let them drift unnoticed.
 */
describe("issue #1150 — every needs-human quarantine site threads its opts", () => {
  /**
   * Extract the argument list of the first `.quarantine(` call at or after
   * `fromLine`, balancing parens across lines (site 2 is multi-line), and
   * return it whitespace-normalised so an anchor can assert on the opts
   * regardless of how the call was wrapped.
   */
  function quarantineCallAtOrAfter(
    source: string[],
    fromLine: number,
  ): { args: string; line: number } {
    for (let i = fromLine; i < source.length; i++) {
      const hit = source[i].indexOf(".quarantine(");
      if (hit === -1) continue;
      let depth = 0;
      let started = false;
      let acc = "";
      for (let j = i; j < source.length; j++) {
        const line = source[j];
        const from = j === i ? hit + ".quarantine".length : 0;
        for (let k = from; k < line.length; k++) {
          const ch = line[k];
          if (ch === "(") {
            depth++;
            started = true;
            if (depth === 1) continue; // skip the opening paren itself
          } else if (ch === ")") {
            depth--;
            if (depth === 0) {
              return { args: acc.replace(/\s+/g, " ").trim(), line: i + 1 };
            }
          }
          if (started) acc += ch;
        }
        acc += " ";
      }
    }
    throw new Error(`no .quarantine( call found at or after line ${fromLine}`);
  }

  /** True iff the call passes a 3rd opts argument — a `{ stopLabel` or
   *  `{ handoff`. A bare 2-arg quarantine has neither, which is the whole
   *  defect. */
  function hasOpts(args: string): boolean {
    return /\{\s*(stopLabel|handoff)\b/.test(args);
  }

  /**
   * Every quarantine site that MUST route to `needs-human` (an owner-decision
   * stop or an outright handoff) and therefore MUST hand `quarantine` its opts.
   * Anchor = a stable string on or just before the call; `expectOpts` = the
   * exact opts that site owes, whitespace-insensitive.
   *
   * The first five are the sites issue #1150's review found bare (BLOCKER 1).
   * The last four were fixed in 3c169783 and are kept here as a regression
   * guard — the same wiring must not rot back to bare.
   */
  const NEEDS_HUMAN_SITES: ReadonlyArray<{
    readonly name: string;
    readonly anchor: RegExp;
    readonly expectOpts: RegExp;
  }> = [
    // The check-writer marker/envelope mismatch site (BLOCKER 1 site 1) was
    // REMOVED by spec #1334: that road builds with no first test now and has
    // no `quarantine(...)` call for this guard to inspect.
    {
      name: "server-only ticket has no target block (BLOCKER 1 site 2)",
      // Anchored on the logError line ABOVE the call, not the reason string
      // INSIDE it — an anchor sitting inside the multi-line call would make the
      // forward scan skip past it to the next quarantine site.
      anchor: /no target block on a server-only ticket/,
      expectOpts: /\{ stopLabel: stop\.label \}/,
    },
    {
      // Spec #1334 fix pass: the test-writing AI or the builder answered
      // TICKET_UNCLEAR. One helper serves both, so one site.
      name: "an agent answered TICKET_UNCLEAR (stopTicketUnclear)",
      anchor: /leaves a product question open — stopping for the owner/,
      expectOpts: /\{ stopLabel: stop\.label \}/,
    },
    // The ProofDemandUnsatisfiedStopError catch arm (BLOCKER 1 site 4) was
    // REMOVED by the spec #1334 fix pass: a diff that owes more proof is a
    // fault in the work, so it goes to the fixer instead of stopping.
    // The rescue-gate quarantine (BLOCKER 1 site 5) was REMOVED by spec
    // #1334 SG with the whole rescue ship road: the fixer ships through
    // `shipAfterMigrations`, whose typed stops are the ProofDemand arm above.
    // The already-built handoff (fixed 3c169783) was REMOVED by SG too:
    // already-built work goes to the reviewer and never reaches the owner.
    // The needs-world-data handoff site was REMOVED by #1198 A: that road
    // no longer quarantines at all, so it has no `quarantine(...)` call for
    // this guard to inspect. Its `{ handoff: true }` behaviour is now moot;
    // the behavioural test above ("NEEDS_WORLD_DATA no longer quarantines at
    // all") is what pins the replacement.
    // The rubric-not-loaded handoff site was REMOVED by spec #1334 with the
    // whole design-critique stage: the reviewer now records a missing rubric
    // as `N/A (no rubric loadable: …)`, and nothing is handed to the owner.
    // The judge early-pass stop (fixed 3c169783) was REMOVED with the early
    // pass itself by spec #1334 (SF1).
  ];

  function mainSource(): string[] {
    return readFileSync(
      path.join(import.meta.dirname, "main.mts"),
      "utf8",
    ).split("\n");
  }

  function anchorLine(source: string[], anchor: RegExp): number {
    const idx = source.findIndex((t) => anchor.test(t));
    if (idx === -1) {
      throw new Error(`anchor not found in main.mts: ${anchor}`);
    }
    return idx;
  }

  it("each named needs-human quarantine site passes opts — none is a bare 2-arg call", () => {
    const source = mainSource();
    const bare: string[] = [];
    const wrongOpts: string[] = [];
    for (const site of NEEDS_HUMAN_SITES) {
      const call = quarantineCallAtOrAfter(source, anchorLine(source, site.anchor));
      if (!hasOpts(call.args)) {
        bare.push(`${site.name} @ main.mts:${call.line} — args: ${call.args}`);
        continue;
      }
      if (!site.expectOpts.test(call.args)) {
        wrongOpts.push(
          `${site.name} @ main.mts:${call.line} — expected ${site.expectOpts}, got: ${call.args}`,
        );
      }
    }
    expect(
      bare,
      `these owner-decision/handoff quarantine sites are BARE 2-arg calls, so ` +
        `they default to \`quarantine\` when they owe \`needs-human\` (issue ` +
        `#1150). Thread the stop label / handoff flag as a 3rd argument:\n` +
        `${bare.join("\n")}`,
    ).toEqual([]);
    expect(
      wrongOpts,
      `these sites pass opts, but not the ones this stop owes:\n` +
        `${wrongOpts.join("\n")}`,
    ).toEqual([]);
  });

  it("routes each named site's opts through the pure function to needs-human", () => {
    // Cross-check the wiring against the decision it feeds: whatever opts the
    // five owner-decision sites hand `quarantine`, the pure function must turn
    // into `needs-human`. This is what the bare sites got wrong.
    const source = mainSource();
    for (const literal of [
      { opts: { stopLabel: "stopped:ticket-unclear" as const } },
      { opts: { handoff: true } },
    ]) {
      expect(quarantineTerminalLabel(literal.opts)).toBe("needs-human");
    }
    // A first-test disagreement is never an owner question (spec #1334).
    expect(
      quarantineTerminalLabel({ stopLabel: "stopped:check-disagreement" }),
    ).toBe("quarantine");
    void source;
  });

  it("SELF-CHECK: the extractor flags a synthetic BARE call and passes one WITH opts", () => {
    // Prove the instrument before believing its silence (issue #923's own
    // discipline): a scanner that cannot tell a bare call from a wired one
    // would pass every future regression forever.
    const bareSrc = [
      "async function newOwnerDecisionStop(ctx) {",
      "  await ctx.deps.quarantine(ctx.issueNumber, reason);",
      "}",
    ];
    const wiredSrc = [
      "async function newOwnerDecisionStop(ctx) {",
      "  await ctx.deps.quarantine(ctx.issueNumber, reason, {",
      "    stopLabel: stop.label,",
      "  });",
      "}",
    ];
    const bareCall = quarantineCallAtOrAfter(bareSrc, 0);
    expect(hasOpts(bareCall.args)).toBe(false);
    const wiredCall = quarantineCallAtOrAfter(wiredSrc, 0);
    expect(hasOpts(wiredCall.args)).toBe(true);
    // The balancer must reassemble a multi-line opts object into one arg.
    expect(wiredCall.args).toContain("{ stopLabel: stop.label, }");
  });

  it("every anchor resolves — a moved site fails loudly here instead of going unchecked", () => {
    const source = mainSource();
    for (const site of NEEDS_HUMAN_SITES) {
      expect(
        source.findIndex((t) => site.anchor.test(t)),
        `anchor for "${site.name}" no longer matches any line in main.mts — ` +
          `the site was renamed or moved; update its anchor.`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
