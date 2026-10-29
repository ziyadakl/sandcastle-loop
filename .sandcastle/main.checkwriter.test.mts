/**
 * Issue #911 (Piece D) — the check-writer pass, wired into `runIssuePipeline`
 * BEFORE the implementer, and everything downstream that had to change to
 * accommodate it.
 *
 * Four things proven here, matching the ticket's own "Prove it" section:
 *
 *   1. The four outcomes route distinctly (`runCheckWriterStage`), including
 *      the must-fail-first ladder's "one more go, then stop".
 *   2. The inherit path is recognised by the HOST's own filesystem
 *      observation, not the agent's self-report alone.
 *   3. The `apps/`+`packages/` "no screen applies" line is evaluated
 *      against the FINISHED diff (`shipAfterMigrations`'s new gate), not
 *      the claim at declaration time — real git repo, real commits.
 *   4. Every placeholder this ticket added to `check-writer-prompt.md` and
 *      `review-prompt.md` actually gets substituted by the REAL
 *      `applyPromptArgs` function, and the per-agent `checkWriter` cost
 *      split actually lands in `.sandcastle/telemetry/issues.jsonl` — read
 *      back OFF DISK, not asserted against the in-memory ledger object.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GREEN_RUN,
  RED_RUN,
  checkRunExec,
  checkRunResult,
} from "./__fixtures__/check-evidence.js";
import { commitInto, git } from "./__fixtures__/git-repo.js";
import { checkDirForIssue } from "./lib/checkwriter/check-path.js";
import { unitCheckDirFor } from "./lib/checkwriter/unit-check-path.js";
import type { CheckWriterMarker } from "./lib/checkwriter/schema.js";
import {
  browserCheckLocation,
  mustFailFirstAlreadyProven,
  readMustFailFirstReceipt,
  writeMustFailFirstReceipt,
} from "./lib/checkwriter/must-fail-first-receipt.js";
import {
  NO_SIBLING_TICKETS,
  renderSiblingTickets,
} from "./lib/checkwriter/sibling-briefs.js";
import type { SiblingTicketBrief } from "./lib/checkwriter/sibling-briefs.js";
import type { FrozenCheck } from "./lib/judge/check-freeze.js";
import { frozenCheckDrift } from "./lib/judge/check-freeze.js";
import { applyPromptArgs } from "./lib/prompt-args.js";
import { CostLedger } from "./lib/cost/ledger.js";
import { IssueLedger } from "./lib/telemetry/issue-ledger.js";
import { buildReworkRecordInput } from "./lib/telemetry/rework-record-input.js";
import {
  appendReworkRecord,
  readReworkRecords,
} from "./lib/telemetry/rework-store.js";
import type { GitRunResult } from "./lib/state/git-exec.js";
import {
  probeAlreadyBuiltLocation,
  runCheckWriter,
  runCheckWriterStage,
  shipAfterMigrations,
  type SandboxHandle,
} from "./main.mts";
import { SHIP_INPUT_DEFAULTS } from "./__fixtures__/ship-input.mts";

const CHECK_WRITER_PROMPT_PATH = path.join(
  import.meta.dirname,
  "check-writer-prompt.md",
);
const REVIEW_PROMPT_PATH = path.join(import.meta.dirname, "review-prompt.md");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Issue 911's BROWSER check location, which every receipt assertion in this
 * file is about. The four receipt functions take a validated `CheckLocation`
 * rather than a bare `(issueNumber, checkPath)` pair (issue #956), so that a
 * caller cannot pair one runner's directory with the other's filename — see
 * `must-fail-first-receipt.ts`'s module doc.
 */
function browserLoc(checkPath = "already-here.spec.ts") {
  const loc = browserCheckLocation(911, checkPath);
  if (loc === undefined) throw new Error(`unusable check path: ${checkPath}`);
  return loc;
}

/** A fenced ```json``` envelope + bare marker, exactly the shape the real
 *  parser (`extractMarker` + `parseVerdict`) expects on the last non-empty
 *  lines of the agent's stdout. */
function envelope(body: Record<string, unknown>, marker: string): string {
  return (
    `Some reasoning prose about the ticket.\n\n` +
    "```json\n" +
    `${JSON.stringify(body, null, 2)}\n` +
    "```\n\n" +
    `${marker}\n`
  );
}

/** A minimal, otherwise-valid check spec body — content-wise indistinguishable
 *  from what a real check-writer produces for the purposes of the finding #5
 *  content check (`missingGradedHelperCalls`): it IMPORTS both graded
 *  helpers from the graded-screen-check module and CALLS both of them in
 *  real code. Every fixture below that claims `CHECKS_WRITTEN` with a real
 *  (non-`undefined`) `checkPath` has to satisfy that guard, or
 *  `runCheckWriter` refuses to run it as evidence — see `main.mts`'s own doc
 *  comment on that check. */
const VALID_CHECK_BODY =
  `import { test } from "@playwright/test";\n` +
  `import { waitForGradableScreen, gradeScreenText } from "../../lib/graded-screen-check";\n` +
  `test("check", async ({ page }) => {\n` +
  `  const { claim } = await waitForGradableScreen(page, { screen: "x", expectedClaim: {}, screenshotPath: "x" });\n` +
  `  await gradeScreenText(page.locator(".figure"), "$1,234");\n` +
  `});\n`;

/** Write `relPath` under `worktree`'s per-issue check directory, with
 *  {@link VALID_CHECK_BODY} by default — simulates a real check-writer agent
 *  actually creating the file via its own tool calls (this file's mocked
 *  `sb.run()` never does that on its own; call this from a `run` mock's
 *  implementation, matching the moment a real agent's turn would have
 *  written it). */
function writeCheckFile(
  worktree: string,
  issueNumber: number,
  relPath: string,
  body: string = VALID_CHECK_BODY,
): void {
  const dir = path.join(worktree, checkDirForIssue(issueNumber));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, relPath), body);
}

/** Minimal `ctx.telemetry`-shaped bag that just RECORDS every call, so tests
 *  can assert exactly what `runCheckWriterStage` noted without depending on
 *  the real `IssueTelemetryBag`'s toRow() shape. */
function fakeTelemetry(): {
  calls: string[];
  bag: Record<string, (...a: unknown[]) => unknown>;
} {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
    };
  return {
    calls,
    bag: {
      noteCheckWriterOutcome: record("noteCheckWriterOutcome"),
      noteCheckWriterInherited: record("noteCheckWriterInherited"),
      noteCheckWriterMustFailFirst: record("noteCheckWriterMustFailFirst"),
      noteCheckWriterRetried: record("noteCheckWriterRetried"),
      // 2026-09-10: the written-versus-written marker reconcile.
      noteCheckWriterMarkerReconciled: record("noteCheckWriterMarkerReconciled"),
      noteCheckWriterProofCarriedForward: record(
        "noteCheckWriterProofCarriedForward",
      ),
      // #1198 A: the first-test fall-through counters.
      noteFirstTestFallThrough: record("noteFirstTestFallThrough"),
      noteShippedWithoutFirstTest: record("noteShippedWithoutFirstTest"),
      noteShipPath: record("noteShipPath"),
      noteDiff: record("noteDiff"),
      noteImplementerAttempt: record("noteImplementerAttempt"),
      noteImplementerCertification: record("noteImplementerCertification"),
      noteStopReason: record("noteStopReason"),
    },
  };
}

/** A ctx carrying only what `runCheckWriter`/`runCheckWriterStage` read. */
function makeCtx(over: {
  issueNumber?: number;
  telemetry?: Record<string, (...a: unknown[]) => unknown>;
  deps?: Record<string, unknown>;
  /** The other tickets in the same run (see `lib/checkwriter/sibling-briefs.ts`).
   *  Omitted on almost every ctx here on purpose: `undefined` is the shape a
   *  bare ctx has in production too, and the prompt must still render. */
  siblingTickets?: readonly SiblingTicketBrief[];
  /** LAYER 1's cell (issue #1118). `undefined` on almost every ctx here on
   *  purpose: that is the shape a bare ctx has, and the freeze must be purely
   *  additive to every path. */
  frozenCheck?: { current: unknown };
}): unknown {
  return {
    siblingTickets: over.siblingTickets,
    frozenCheck: over.frozenCheck,
    args: {
      repoRoot: "/repo",
      branch: "main",
      critiqueModel: "opus-critique",
      implementerTimeoutSec: 600,
      stagingEnabled: true,
    },
    deps: {
      log: () => {},
      logError: () => {},
      comment: async () => {},
      quarantine: async () => {},
      captureSha: async () => "postsha-after-checkwriter",
      ...over.deps,
    },
    ticketOrdinal: 1,
    issueNumber: over.issueNumber ?? 911,
    issue: { branch: "issue-911" },
    status: { setIssuePhase: () => {} },
    telemetry: over.telemetry,
  };
}

/** A stub `SandboxHandle` — `run` returns canned stdout, `exec` is a mock
 *  the must-fail-first proof drives. */
function makeSandbox(opts: {
  stdout: string;
  worktreePath?: string;
  exec?: SandboxHandle["exec"];
  /** Override the default static `run` stub — used when a test needs `run`
   *  to also write a check file to disk as a side effect (simulating a real
   *  check-writer agent's own tool calls), not just return canned stdout. */
  run?: SandboxHandle["run"];
}): SandboxHandle {
  return {
    branch: "issue-911",
    worktreePath: opts.worktreePath,
    // Only the check-writer runs inside `runCheckWriterStage` (the judge's
    // early pass that also read the check here was deleted by spec #1334).
    run:
      opts.run ?? vi.fn().mockResolvedValue({ stdout: opts.stdout, commits: [] }),
    exec: opts.exec,
    close: async () => {},
  } as unknown as SandboxHandle;
}

// ---------------------------------------------------------------------------
// 1. The four outcomes route distinctly
// ---------------------------------------------------------------------------

describe("runCheckWriterStage — the four outcomes, distinctly wired", () => {
  // A REAL directory (not a git repo) — the finding #5 content check
  // (`missingGradedHelperCalls`) reads real files, and finding #7's
  // `ensureDirCommitted` needs a real, git-command-tolerant `cwd` (it fails
  // closed and falls back to the stubbed `captureSha` when `git` errors on a
  // non-repo directory, which is exactly what these tests want — they are
  // not testing finding #7's commit behavior).
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-outcomes-"));
    // The freeze's layout guard (issue #1135, LOW 6) now demands EVERY browser
    // instrument root resolve, including `apps/nextjs/src/lib/screen-check`.
    // Seed it as an empty directory so the intact-layout fixture is intact; the
    // freeze derives its files from imports, so an empty root adds nothing.
    mkdirSync(path.join(worktree, "apps/nextjs/src/lib/screen-check"), {
      recursive: true,
    });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("CHECKS_WRITTEN + a genuinely red proof -> PROCEEDS, sets protectedPathGlobs, advances preSha", async () => {
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        // Simulates the check-writer agent's own tool calls actually
        // creating the file, mid-turn, AFTER the pre-existing-files
        // snapshot `hasPreexistingCheckFiles` already took (matching real
        // production ordering — see `writeCheckFile`'s own doc comment).
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const { calls, bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected proceed");
    expect(result.marker).toBe("CHECKS_WRITTEN");
    expect(result.checkKind).toBe("browser");
    expect(result.preSha).toBe("postsha-after-checkwriter"); // advanced past the check-writer's own commit
    expect(result.ctx.protectedPathGlobs).toEqual([
      `${checkDirForIssue(911)}/**`,
    ]);
    expect(calls).toContain('noteCheckWriterOutcome("checks-written")');
    expect(calls).toContain('noteCheckWriterMustFailFirst("red")');
    expect(calls).not.toContain("noteCheckWriterRetried()");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("LAYER 1: FREEZES the accepted check, and the setup files that decide what it does", async () => {
    // Taken one statement after the commit that makes this check the builder's
    // hand-off baseline — the exact moment it becomes the thing the ticket
    // will be graded by. From here on every graded run in the repair restores
    // these bytes first, so an in-place edit cannot reach one.
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    // A config file the builder has no business editing, present when the
    // check is accepted.
    mkdirSync(path.join(worktree, "apps/nextjs"), { recursive: true });
    writeFileSync(
      path.join(worktree, "apps/nextjs/playwright.config.ts"),
      "export default { timeout: 240_000 };\n",
    );

    const frozenCheck: { current: FrozenCheck | undefined } = {
      current: undefined,
    };
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, frozenCheck });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
    const frozen = frozenCheck.current;
    expect(frozen).toBeDefined();
    if (frozen === undefined) throw new Error("unreachable");
    // The check's own bytes.
    expect(frozen.checkDir.relPaths).toContain("team-cash-flow.spec.ts");
    // AND the runner's config — the seam SWE-bench's own reset leaves open.
    expect(
      frozen.environment.find(
        (f) => f.relPath === "apps/nextjs/playwright.config.ts",
      )?.bytes?.toString("utf8"),
    ).toBe("export default { timeout: 240_000 };\n");
    // Nothing has moved yet, so the drift detector says nothing.
    expect(frozenCheckDrift(worktree, frozen)).toEqual([]);
    // Edit the config the way a builder that wanted a green run would, and it
    // is named.
    writeFileSync(
      path.join(worktree, "apps/nextjs/playwright.config.ts"),
      "export default { timeout: 1 };\n",
    );
    expect(frozenCheckDrift(worktree, frozen)).toContain(
      "apps/nextjs/playwright.config.ts",
    );
  });

  it("ADDITIVE: a ctx with no freeze cell proceeds exactly as it always did", async () => {
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const { bag } = fakeTelemetry();
    const result = await runCheckWriterStage(
      sandbox,
      makeCtx({ telemetry: bag }) as never,
      "pre-sha-0",
    );
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected proceed");
    expect(result.preSha).toBe("postsha-after-checkwriter");
  });

  it("ALREADY_BUILT -> goes to review with no build pass and no must-fail-first proof — never stops (spec #1334, SG)", async () => {
    const exec = vi.fn();
    const sandbox = makeSandbox({
      stdout: envelope(
        {
          marker: "ALREADY_BUILT",
          inherited: false,
          alreadyBuiltEvidence: "apps/nextjs/.../reports/page.tsx:40 already does this",
        },
        "ALREADY_BUILT",
      ),
      exec,
    });
    const quarantine = vi.fn();
    const { calls, bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected proceed");
    expect(result.skipBuild?.kind).toBe("already-built");
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
    expect(result.withoutFirstTest?.reason).toBe("already-built");
    expect(quarantine).not.toHaveBeenCalled();
    expect(calls).toContain('noteCheckWriterOutcome("already-built")');
    expect(exec).not.toHaveBeenCalled();
  });

  // #1110 — ALREADY_BUILT is settled by WHERE the code is (a mechanical branch
  // lookup), not by the check-writer's reading of a worktree. Since spec #1334
  // SG no path hands to the owner: certified on staging closes with the run's
  // pull request; every other case goes to the reviewer, which confirms (the
  // ticket closes as done) or refutes (the ticket is built).
  function alreadyBuiltSandbox(opts?: { resumed?: boolean }): SandboxHandle {
    const sb = makeSandbox({
      stdout: envelope(
        {
          marker: "ALREADY_BUILT",
          inherited: false,
          alreadyBuiltEvidence:
            "apps/nextjs/.../reports/page.tsx:40 already does this",
        },
        "ALREADY_BUILT",
      ),
      exec: vi.fn(),
    });
    if (opts?.resumed) {
      (sb as unknown as { resumedFromCheckpoint: boolean }).resumedFromCheckpoint =
        true;
    }
    return sb;
  }

  it("ALREADY_BUILT certified on integration-candidate -> shipped-local auto-close, not rebuilt, no human (#1110 case 2)", async () => {
    const quarantine = vi.fn();
    const markDone = vi.fn();
    const releaseIssueLease = vi.fn();
    const locate = vi.fn().mockResolvedValue({ onMain: false, onStaging: true });
    const ctx = makeCtx({
      deps: {
        quarantine,
        markDone,
        releaseIssueLease,
        locateAlreadyBuiltWork: locate,
      },
    });
    const result = await runCheckWriterStage(
      alreadyBuiltSandbox(),
      ctx as never,
      "pre-sha-0",
    );

    // #1110's ruling: case 2 is `shipped-local`. Its code is already on
    // `integration-candidate` (matched by content — that presence IS what made
    // this case 2), which the run branch carries, so it lands and CLOSES with
    // the run's final PR. No rebuild, no human. The `"ok"` outcome is what puts
    // it in runMain's `shippedIssues` (the `Closes #N` list); `markDone` flips
    // the label to shipped-local. The `ALREADY_BUILT_ON_STAGING` marker is what
    // keeps its empty branch OUT of the merge batch (see `selectMergeBatch`) —
    // this test asserts the marker; that exclusion is tested there.
    expect(result.proceed).toBe(false);
    if (result.proceed) throw new Error("expected stop");
    expect(result.outcome.status).toBe("ok");
    expect(result.outcome.finalMarker).toBe("ALREADY_BUILT_ON_STAGING");
    expect(locate).toHaveBeenCalledWith(911);
    // Label flipped to shipped-local, NOT quarantined to a human.
    expect(markDone).toHaveBeenCalledTimes(1);
    expect(markDone.mock.calls[0]![0]).toBe(911);
    expect(String(markDone.mock.calls[0]![1])).toContain("integration-candidate");
    expect(quarantine).not.toHaveBeenCalled();
    // The staging "ok" post-loop holds the lease for promotion, but this issue
    // is not in the merge set, so it hands its own lease back now.
    expect(releaseIssueLease).toHaveBeenCalledWith(911);
  });

  it("ALREADY_BUILT + a location lookup that THROWS -> goes to the reviewer to confirm, naming both branches it could not confirm, never the owner", async () => {
    const quarantine = vi.fn();
    const stops: unknown[] = [];
    const reports: { detail: string }[] = [];
    const locate = vi.fn().mockRejectedValue(new Error("git exploded"));
    const ctx = makeCtx({
      deps: {
        quarantine,
        locateAlreadyBuiltWork: locate,
        reportStop: async (_n: number, opts: unknown) => void stops.push(opts),
        applyFirstTestFallThroughReport: async (_n: number, r: { detail: string }) => {
          reports.push(r);
          return "applied" as const;
        },
      },
    });
    const result = await runCheckWriterStage(
      alreadyBuiltSandbox(),
      ctx as never,
      "pre-sha-0",
    );

    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected proceed");
    expect(result.skipBuild).toMatchObject({ kind: "already-built", onMain: false });
    expect(quarantine).not.toHaveBeenCalled();
    expect(stops).toEqual([]);
    expect(reports[0]!.detail).toContain("origin/main");
    expect(reports[0]!.detail).toContain("integration-candidate");
    expect(reports[0]!.detail).toContain("could not be resolved");
  });

  it("ALREADY_BUILT found on origin/main -> goes to the reviewer to confirm and close, never the owner (#1110 case 1, spec #1334 SG)", async () => {
    const quarantine = vi.fn();
    const stops: unknown[] = [];
    const ctx = makeCtx({
      deps: {
        quarantine,
        locateAlreadyBuiltWork: async () => ({ onMain: true, onStaging: false }),
        reportStop: async (_n: number, opts: unknown) => void stops.push(opts),
      },
    });
    const result = await runCheckWriterStage(
      alreadyBuiltSandbox(),
      ctx as never,
      "pre-sha-0",
    );

    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected proceed");
    expect(result.skipBuild).toMatchObject({ kind: "already-built", onMain: true });
    expect(quarantine).not.toHaveBeenCalled();
    expect(stops).toEqual([]);
  });

  it("ALREADY_BUILT on a RESUMED worktree -> straight to review, never parked for the owner, lookup not consulted (spec #1334 SG)", async () => {
    const quarantine = vi.fn();
    const stops: unknown[] = [];
    const locate = vi.fn();
    const ctx = makeCtx({
      deps: {
        quarantine,
        locateAlreadyBuiltWork: locate,
        reportStop: async (_n: number, opts: unknown) => void stops.push(opts),
      },
    });
    const result = await runCheckWriterStage(
      alreadyBuiltSandbox({ resumed: true }),
      ctx as never,
      "pre-sha-0",
    );

    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected proceed");
    expect(result.skipBuild?.kind).toBe("resumed-built");
    expect(quarantine).not.toHaveBeenCalled();
    expect(stops).toEqual([]);
    // Read off the ticket's own resumed work — the shippable locations say
    // nothing about it, so the probe is skipped entirely.
    expect(locate).not.toHaveBeenCalled();
  });

  it("NEEDS_WORLD_DATA -> BUILDS ANYWAY with no first test (#1198 A), never quarantines, and the gap is written onto the body", async () => {
    // Before #1198 A this quarantined `stopped:no-failing-check` (handoff:
    // someone extends the practice world, then re-queue). The gap is real and
    // still gets written onto the ticket — but a missing fixture stops the
    // loop writing a CHECK, not writing the FEATURE, so it no longer holds
    // the ticket for a night waiting on a person.
    const sandbox = makeSandbox({
      stdout: envelope(
        {
          marker: "NEEDS_WORLD_DATA",
          inherited: false,
          worldDataNeeded: "needs a deal in Conditional status with a co-listing agent",
        },
        "NEEDS_WORLD_DATA",
      ),
    });
    const quarantine = vi.fn();
    const applyFirstTestFallThroughReport = vi.fn(async () => "applied" as const);
    const { calls, bag } = fakeTelemetry();
    const ctx = makeCtx({
      telemetry: bag,
      deps: { quarantine, applyFirstTestFallThroughReport },
    });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
    // `NEEDS_WORLD_DATA` offers no proof the ship-time gate accepts, so the
    // stage proceeds under the one marker that honestly means "no check".
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
    expect(result.checkKind).toBeUndefined();
    // The diagnosis reaches the ticket BODY, with no stop label.
    expect(applyFirstTestFallThroughReport).toHaveBeenCalledTimes(1);
    const written = applyFirstTestFallThroughReport.mock
      .calls[0]! as unknown as [number, { reason: string; detail: string }];
    expect(written[1].detail).toContain("co-listing agent");
    expect(calls).toContain('noteCheckWriterOutcome("needs-world-data")');
    expect(calls).toContain('noteFirstTestFallThrough("no-failing-check")');
  });

  it("NO_SCREEN_APPLIES -> PROCEEDS, flag threaded for the ship-time gate, no check dir glob", async () => {
    const sandbox = makeSandbox({
      stdout: envelope(
        {
          marker: "NO_SCREEN_APPLIES",
          inherited: false,
          noScreenReason: "this ticket only edits .sandcastle/main.mts",
        },
        "NO_SCREEN_APPLIES",
      ),
    });
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected proceed");
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
    expect(result.checkKind).toBeUndefined();
    expect(result.ctx.protectedPathGlobs).toBeUndefined();
    expect(result.preSha).toBe("pre-sha-0"); // no check-writer commit, preSha unchanged
  });

  it("must-fail-first: green once -> retries; green twice -> stops, no builder dispatched", async () => {
    const exec = vi.fn(checkRunExec(GREEN_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const { calls, bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    // #1198 A: this was `stopped:no-failing-check` and it is the single
    // biggest source of the stops the owner's decision was measured from. The
    // reasoning still holds — a check that cannot fail proves nothing — but
    // that is a fact about the CHECK, so the ticket is built and the
    // reviewer decides.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
    // The check itself still travels — the reviewer runs it as a pre-flight.
    expect(result.checkKind).toBe("browser");
    // Exactly two dispatches (attempt 1 + the one allowed retry), never three.
    expect((sandbox.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(calls).toContain("noteCheckWriterRetried()");
    expect(calls.filter((c) => c.startsWith("noteCheckWriterMustFailFirst")).length).toBe(2);
  });

  it("must-fail-first: INCONCLUSIVE retries the RUN, not the writer; inconclusive twice -> environment-fault stop, no builder dispatched", async () => {
    // A timed-out proof is `classifyCheckRun`'s `inconclusive`. It is NOT
    // evidence the check can fail — it is the absence of evidence either way,
    // which is precisely what the ship-time harness gate already refuses to
    // ship on ("a ticket that cannot produce proof stops instead of
    // shipping"). The must-fail-first ladder has to hold the same line, or a
    // slow night silently waives the whole proof.
    //
    // SINCE 2026-08-31 the split is finer: an inconclusive is the ENVIRONMENT
    // failing to produce evidence, so no check-writer rewrite is dispatched
    // over it — the RUN is retried once on the same committed check, and a
    // second inconclusive stops as `stopped:run-fault` (an environment
    // fault a person re-queues), never as `stopped:no-failing-check`, which blames the
    // ticket's check.
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "", exitCode: null, timedOut: true });
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const { calls, bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    // #1198 A: an environment fault used to quarantine `stopped:run-fault`
    // and wait for a re-queue. A wedged sandbox says nothing about whether
    // the work is doable, so the ticket is built and the reviewer decides —
    // and the fall-through records WHICH fault it was, distinctly from the
    // twice-green road.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.withoutFirstTest?.reason).toBe("run-fault");
    expect(result.withoutFirstTest?.reason).not.toBe("no-failing-check");
    // Still worded as "we could not run it", never "it passed".
    expect(result.withoutFirstTest?.detail).toContain("could not RUN the check");
    expect(result.withoutFirstTest?.detail).not.toContain("passed against untouched");
    // Exactly ONE writer dispatch — the retry is of the RUN (exec), never a
    // rewrite the sandbox fault would just re-strand.
    expect(sandbox.run as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(calls).not.toContain("noteCheckWriterRetried()");
    expect(calls.filter((c) => c.startsWith("noteCheckWriterMustFailFirst")).length).toBe(1);
  });

  it("must-fail-first: inconclusive then red on retry -> proceeds", async () => {
    let call = 0;
    const exec = vi.fn(async (command: string) => {
      call += 1;
      return call === 1
        ? { stdout: "", stderr: "", exitCode: null, timedOut: true }
        : checkRunResult(command, RED_RUN);
    });
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");
    expect(result.proceed).toBe(true);
  });

  it("must-fail-first: green then red on retry -> proceeds", async () => {
    let call = 0;
    const exec = vi.fn(async (command: string) => {
      call += 1;
      return call === 1
        ? checkRunResult(command, GREEN_RUN)
        : checkRunResult(command, RED_RUN);
    });
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");
    expect(result.proceed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1a-bis. The written check must call BOTH graded helpers (issue #916,
// defect 1). `waitForGradableScreen` alone only covers the failures BEFORE
// the figure is read. Only `gradeScreenText` emits `GRADED_FIGURE_SENTINEL`,
// and `lib/harness/verdict.ts:177-196` requires that sentinel to be PRESENT
// before it will call a failure `graded-mismatch` — without it a genuinely
// wrong number on screen is filed as `environment-fault`, which never asks
// the owner to break the tie and (on the rescue path) forfeits the ticket's
// retry round. So a check that grades with a bare `expect()` must never
// reach the harness at all.
// ---------------------------------------------------------------------------

describe("runCheckWriterStage — a check that never GRADES is refused (issue #916, defect 1)", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-nograde-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  /** Waits with the sanctioned helper, then grades with the exact
   *  anti-pattern: a bare web-first `expect(...).toContainText(...)`, which
   *  emits no sentinel at all. This body passed every structural guard the
   *  loop had before issue #916. */
  const UNGRADED_CHECK_BODY =
    `import { expect, test } from "@playwright/test";\n` +
    `import { waitForGradableScreen } from "../../lib/graded-screen-check";\n` +
    `test("check", async ({ page }) => {\n` +
    `  await waitForGradableScreen(page, { screen: "x", expectedClaim: {}, screenshotPath: "x" });\n` +
    `  await expect(page.locator(".figure")).toContainText("$1,234");\n` +
    `});\n`;

  it("STOPS the ticket, names gradeScreenText, and never runs the must-fail-first proof", async () => {
    const exec = vi.fn();
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts", UNGRADED_CHECK_BODY);
        return { stdout, commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    // #1198 A: still REFUSED as a check — it never reaches the harness, and
    // no Playwright run is spent on it — but the ticket is now built without
    // one rather than killed. A check-writer that forgot a helper twice is
    // the loop's own clerical failure, not a finding about this ticket.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
    const reason = String(result.withoutFirstTest?.detail);
    expect(reason).toContain("gradeScreenText");
    // The note must still say what was missing, not just that something was.
    expect(reason).toContain("check-writer-missing-graded-helper");
    // No check reached the proceed result — the ungraded one is not evidence.
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
    expect(result.checkKind).toBeUndefined();
    // Refused BEFORE any Playwright run was spent on it.
    expect(exec).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // OWNER DECISION, issue #884: the check-writer retry is "the cheapest retry
  // in the design", and stopping a ticket on a first clerical miss spends the
  // owner's morning on the loop's own error. Forgetting the grading helper is
  // exactly that kind of miss, and the refusal message already names the
  // exact missing call — so the agent gets ONE more go with that message in
  // hand, then the ticket stops. Genuinely unusable envelopes keep the old
  // stop-at-attempt-1 behaviour.
  // -------------------------------------------------------------------------

  it("gets ONE retry and PROCEEDS when the second attempt adds the missing call", async () => {
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    let attempts = 0;
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        attempts += 1;
        writeCheckFile(
          worktree,
          911,
          "team-cash-flow.spec.ts",
          attempts === 1 ? UNGRADED_CHECK_BODY : VALID_CHECK_BODY,
        );
        return { stdout, commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const { calls, bag } = fakeTelemetry();
    const result = await runCheckWriterStage(
      sandbox,
      makeCtx({ telemetry: bag, deps: { quarantine } }) as never,
      "pre-sha-0",
    );

    expect(attempts).toBe(2);
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.proceed).toBe(true);
    expect(calls).toContain("noteCheckWriterRetried()");
  });

  it("forgetting it TWICE stops trying to write a check — one more go, then the ticket is built without one (#1198 A)", async () => {
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    let attempts = 0;
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec: vi.fn(),
      run: vi.fn().mockImplementation(async () => {
        attempts += 1;
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts", UNGRADED_CHECK_BODY);
        return { stdout, commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const result = await runCheckWriterStage(
      sandbox,
      makeCtx({ deps: { quarantine } }) as never,
      "pre-sha-0",
    );

    expect(attempts).toBe(2);
    // The retry budget is unchanged: exactly two dispatches, never three.
    // What changed is what happens when both are spent.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(String(result.withoutFirstTest?.detail)).toContain(
      "check-writer-missing-graded-helper",
    );
  });

  it("the retry buys one more go, it does NOT waive the must-fail-first rule", async () => {
    // Attempt 1 is refused for the missing helper; attempt 2 writes a proper
    // check that then PASSES against untouched code. Since 2026-09-01 the
    // refusal is clerical and does NOT consume the green-proof retry, so ONE
    // observed green buys the ordinary briefed rewrite (attempt 3) — and
    // when that one is green too, the
    // ticket stops: a check that cannot fail must never reach the builder
    // however the ladder was spent.
    const exec = vi.fn(checkRunExec(GREEN_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    let attempts = 0;
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        attempts += 1;
        writeCheckFile(
          worktree,
          911,
          "team-cash-flow.spec.ts",
          attempts === 1 ? UNGRADED_CHECK_BODY : VALID_CHECK_BODY,
        );
        return { stdout, commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const result = await runCheckWriterStage(
      sandbox,
      makeCtx({ deps: { quarantine } }) as never,
      "pre-sha-0",
    );

    expect(attempts).toBe(3);
    // #1198 A: the must-fail-first RULE is untouched — a check that cannot
    // fail is still refused as proof, the ladder still spends exactly three
    // dispatches, and nothing green is ever accepted as a check. What changed
    // is that the refusal no longer kills the ticket.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
  });

  it("PROVES THE INSTRUMENT: a genuinely unusable envelope survives ONE briefed re-ask (fault 2, 2026-09-01), then stops on the SECOND parse failure", async () => {
    // Since the fault-2 fix, a VerdictParseError buys ONE re-ask — same as
    // the implementer's own envelopeReask — before quarantining. An agent
    // whose output cannot be parsed AT ALL (not even a marker/JSON shape)
    // still gets that one shot; it stops only once the re-ask ALSO fails to
    // parse.
    let attempts = 0;
    const sandbox = makeSandbox({
      stdout: "no envelope here at all\n\nCHECKS_WRITTEN\n",
      worktreePath: worktree,
      exec: vi.fn(),
      run: vi.fn().mockImplementation(async () => {
        attempts += 1;
        return { stdout: "no envelope here at all\n\nCHECKS_WRITTEN\n", commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const result = await runCheckWriterStage(
      sandbox,
      makeCtx({ deps: { quarantine } }) as never,
      "pre-sha-0",
    );

    expect(attempts).toBe(2);
    // #1198 A: the re-ask budget is unchanged — exactly two dispatches — and
    // the second unreadable envelope now falls through to the builder with no
    // first test instead of quarantining. An envelope nobody can read is the
    // loop's own agent failing to format an answer.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
  });

  it("PROVES THE INSTRUMENT: the same pipeline PROCEEDS when the check calls both helpers", async () => {
    // Positive control for the test above — identical wiring, the only
    // difference being that the check body finishes with `gradeScreenText`.
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
    expect(quarantine).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 1b. Unusable envelopes stop the ticket loudly — never a silent ship,
// never a fall-through to the recovery pass (issue #914 findings 2 + 3).
// ---------------------------------------------------------------------------

describe("runCheckWriterStage — an unusable envelope stops the ticket loudly (issue #914)", () => {
  // Real directory — see the identical setup in the "four outcomes" describe
  // block above for why (finding #5's content check + finding #7's
  // `ensureDirCommitted` both need it, and both degrade safely for tests
  // that never touch that code path).
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-unusable-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("an unsafe checkPath fails to PARSE — the ticket stops instead of proceeding with a silently-skipped browser gate", async () => {
    // Before the fix: this checkPath (a space in it) passed the old
    // `z.string().min(1)` schema, `buildCheckCommand` returned `undefined`,
    // `mustFailFirst` resolved to `"inconclusive"` (never blocks), and
    // `runCheckWriterStage` PROCEEDED with `checkCommand: undefined` — which
    // skips the entire ship-time browser gate silently. It must now fail at
    // the schema boundary instead, before ever reaching that branch.
    const exec = vi.fn();
    const sandbox = makeSandbox({
      stdout: envelope(
        {
          marker: "CHECKS_WRITTEN",
          inherited: false,
          screen: "/finance/reports?view=team",
          checkPath: "team cash flow.spec.ts", // unsafe: contains a space
        },
        "CHECKS_WRITTEN",
      ),
      exec,
    });
    const quarantine = vi.fn();
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    // #1198 A: the unsafe path is still REFUSED — the property that mattered
    // is that no check with an unsafe path can ever be treated as one, and
    // `result.marker`/`checkKind` prove it here. The ticket is built without
    // a first test rather than killed.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
    expect(result.checkKind).toBeUndefined();
    expect(result.checkCommand).toBeUndefined();
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
    // Never reached the must-fail-first proof — parsing failed first.
    expect(exec).not.toHaveBeenCalled();
  });

  it("a marker line with no structured envelope at all builds without a first test (#1198 A) instead of falling through to the recovery pass", async () => {
    const sandbox = makeSandbox({
      stdout: "Some reasoning with no structured JSON envelope at all.\n\nCHECKS_WRITTEN\n",
    });
    const quarantine = vi.fn();
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    // The #914 property is unchanged and is the reason this path is modelled
    // at all: it never THROWS past `runCheckWriterStage`, so it can never
    // reach the recovery pass and ship as `RECOVERY_COMPLETE` with no
    // check-writer pass. It now returns a proceed carrying no check.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
  });

  it("a parse failure on the ONE allowed green-proof retry survives its own ONE envelope re-ask (fault 2), then stops loudly on the second parse failure", async () => {
    const exec = vi.fn(checkRunExec(GREEN_RUN));
    const run = vi
      .fn()
      .mockImplementationOnce(async () => {
        // Attempt 1: a genuinely valid CHECKS_WRITTEN, file actually written
        // (simulating the agent's own tool calls) so it goes green and
        // triggers the one allowed retry.
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return {
          stdout: envelope(
            {
              marker: "CHECKS_WRITTEN",
              inherited: false,
              screen: "/finance/reports?view=team",
              checkPath: "team-cash-flow.spec.ts",
            },
            "CHECKS_WRITTEN",
          ),
          commits: [],
        };
      })
      // Attempt 2 (the green-proof retry) fails to parse — this earns the
      // ONE envelope re-ask fault 2 added, since a plain VerdictParseError
      // is not the missing-graded-helper shape (which has its own,
      // different, already-existing retry).
      .mockResolvedValueOnce({
        stdout: "No structured output on the retry either.\n\nCHECKS_WRITTEN\n",
        commits: [],
      })
      // Attempt 3 (the envelope re-ask) ALSO fails to parse — the re-ask is
      // spent, so this is where it finally stops.
      .mockResolvedValueOnce({
        stdout: "Still no structured output.\n\nCHECKS_WRITTEN\n",
        commits: [],
      });
    const sandbox = {
      branch: "issue-911",
      worktreePath: worktree,
      run,
      exec,
      close: async () => {},
    } as unknown as SandboxHandle;
    const quarantine = vi.fn();
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    // Exactly three dispatches — attempt 1, the one allowed green-proof
    // retry, and that retry's own one envelope re-ask — never a fourth. The
    // budget is what this test guards; #1198 A only changed what happens
    // once it is spent.
    expect(run).toHaveBeenCalledTimes(3);
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
  });

  // 2026-08-04 review finding #2 (BLOCKER): the outcome marker (last line,
  // via extractMarker) and the envelope's own `marker` field (fenced JSON
  // block, via parseVerdict) are extracted independently — before this fix,
  // NOTHING compared them. `runCheckWriterStage` branches on the LINE
  // marker everywhere, while every payload field (checkPath, screen, …)
  // comes from the ENVELOPE — so a CHECKS_WRITTEN line paired with a
  // NO_SCREEN_APPLIES envelope block used to silently produce
  // `checkCommand: undefined` AND `noScreenApplies: false`, switching off
  // BOTH ship-time gates at once.
  it("PROVES THE INSTRUMENT: a CHECKS_WRITTEN line paired with a NO_SCREEN_APPLIES envelope uses NEITHER reading — it builds with no first test, never reaches the owner (spec #1334)", async () => {
    const exec = vi.fn();
    const sandbox = makeSandbox({
      // The trailing bare-line marker (what extractMarker reads) disagrees
      // with the fenced JSON block's own `marker` field (what parseVerdict
      // reads) — exactly the shape finding #2 named.
      stdout: envelope(
        {
          marker: "NO_SCREEN_APPLIES",
          inherited: false,
          noScreenReason: "this is only a loop config change",
        },
        "CHECKS_WRITTEN",
      ),
      exec,
    });
    const quarantine = vi.fn();
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    // Spec #1334: this used to stop `stopped:check-disagreement` +
    // `needs-human`. A first-test problem never stops a ticket now — but
    // neither contradictory reading is believed: the ticket proceeds with NO
    // check at all, so neither ship-time gate is armed by a half-believed
    // envelope.
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
    expect(result.checkCommand).toBeUndefined();
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
    expect(result.withoutFirstTest?.detail).toContain("CHECKS_WRITTEN");
    expect(result.withoutFirstTest?.detail).toContain("NO_SCREEN_APPLIES");
    // Never reached the must-fail-first proof — the mismatch is caught
    // before any marker-branching logic acts on either reading.
    expect(exec).not.toHaveBeenCalled();
  });

  // 2026-09-10: #1249 (team wall, commission-engine tables) and #1235 (naming
  // a live deal while filing an unrelated one) BOTH died
  // `stopped:check-disagreement` in run sandcastle/queue-20260910 with $0 of
  // builder spend, on attempt 4 and attempt 2, with the same pair of markers:
  // a self-consistent UNIT_CHECK_WRITTEN envelope (checkPackage + a .test.ts
  // checkPath) closed by a CHECKS_WRITTEN last line. Both markers say "I
  // wrote a check"; the envelope is the reading every ship-time gate consumes
  // and the one the schema already cross-validated against its own payload.
  // So that ONE disagreement now reconciles to the envelope, with a warning
  // and a telemetry note, and the builder is dispatched. Every other pair
  // (the finding #2 shape above included) still stops exactly as before.
  it("RECONCILES the #1249/#1235 shape: a CHECKS_WRITTEN last line over a UNIT_CHECK_WRITTEN envelope proceeds on the ENVELOPE's unit road, warns, and never quarantines", async () => {
    const worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-reconcile-"));
    try {
      // A package that can host a unit check: a name, a `test` script and a
      // vitest config (`resolveUnitCheckPackage` refuses anything less).
      mkdirSync(path.join(worktree, "packages/api"), { recursive: true });
      writeFileSync(
        path.join(worktree, "packages/api/package.json"),
        JSON.stringify({ name: "@acme/api", scripts: { test: "vitest run" } }),
      );
      writeFileSync(path.join(worktree, "packages/api/vitest.config.ts"), "export default {};\n");
      mkdirSync(path.join(worktree, "apps/nextjs/src/lib/screen-check"), { recursive: true });
      const stdout = envelope(
        {
          marker: "UNIT_CHECK_WRITTEN",
          inherited: false,
          checkPackage: "packages/api",
          checkPath: "relist-address-mismatch.test.ts",
        },
        // The contradiction, verbatim from both VPS logs.
        "CHECKS_WRITTEN",
      );
      const exec = vi.fn(checkRunExec(RED_RUN));
      const sandbox = makeSandbox({
        stdout,
        worktreePath: worktree,
        exec,
        run: vi.fn().mockImplementation(async () => {
          const dir = path.join(worktree, unitCheckDirFor("packages/api", 911));
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            path.join(dir, "relist-address-mismatch.test.ts"),
            `import { expect, it } from "vitest";\n` +
              `import { ListingIntakeError } from "../../services/deal-intake/relist.js";\n` +
              `it("refuses", async () => { await expect(attempt).rejects.toBeInstanceOf(ListingIntakeError); });\n`,
          );
          return { stdout, commits: [] };
        }),
      });
      const quarantine = vi.fn();
      const logged: string[] = [];
      const { calls, bag } = fakeTelemetry();
      const ctx = makeCtx({
        telemetry: bag,
        deps: { quarantine, log: (line: string) => logged.push(line) },
      });
      const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

      expect(quarantine).not.toHaveBeenCalled();
      expect(result.proceed).toBe(true);
      if (!result.proceed) throw new Error("expected the builder to be dispatched");
      // The ENVELOPE's reading is the one the stage acted on — the unit road,
      // with the unit runner's command, not the browser road the last line named.
      expect(result.marker).toBe("UNIT_CHECK_WRITTEN");
      expect(result.checkKind).toBe("unit");
      expect(result.checkCommand).toContain("relist-address-mismatch.test.ts");
      // The must-fail-first proof RAN on that road (it did not on the stop above).
      expect(exec).toHaveBeenCalled();
      // Loud in the log, and counted, so a prompt that keeps contradicting
      // itself can be measured rather than guessed at.
      expect(logged.some((l) => /marker.*disagree|disagree.*marker/i.test(l) && l.includes("CHECKS_WRITTEN") && l.includes("UNIT_CHECK_WRITTEN"))).toBe(true);
      expect(calls).toContain("noteCheckWriterMarkerReconciled()");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it("RECONCILES the reverse pair too: a UNIT_CHECK_WRITTEN last line over a CHECKS_WRITTEN envelope proceeds on the ENVELOPE's browser road", async () => {
    const worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-reconcile-rev-"));
    try {
      mkdirSync(path.join(worktree, "apps/nextjs/src/lib/screen-check"), { recursive: true });
      const stdout = envelope(
        {
          marker: "CHECKS_WRITTEN",
          inherited: false,
          screen: "/finance/reports?view=team",
          checkPath: "team-cash-flow.spec.ts",
        },
        "UNIT_CHECK_WRITTEN",
      );
      const exec = vi.fn(checkRunExec(RED_RUN));
      const sandbox = makeSandbox({
        stdout,
        worktreePath: worktree,
        exec,
        run: vi.fn().mockImplementation(async () => {
          writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
          return { stdout, commits: [] };
        }),
      });
      const quarantine = vi.fn();
      const { calls, bag } = fakeTelemetry();
      const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
      const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

      expect(quarantine).not.toHaveBeenCalled();
      expect(result.proceed).toBe(true);
      if (!result.proceed) throw new Error("expected proceed");
      expect(result.marker).toBe("CHECKS_WRITTEN");
      expect(result.checkKind).toBe("browser");
      // The browser road really ran its must-fail-first proof, and this is a
      // ticket WITH a first test — not the #1198 fall-through "proceeding somehow".
      expect(exec).toHaveBeenCalled();
      expect(result.withoutFirstTest).toBeUndefined();
      expect(calls).toContain("noteCheckWriterMarkerReconciled()");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  // parseVerdict walks fenced blocks last-to-first and returns the first that
  // passes the schema, so the envelope it hands back can be an EARLIER draft
  // the agent abandoned. That is the stale-block hazard the original stop
  // named, and the reconcile must not swallow it: here the agent's FINAL
  // block says CHECKS_WRITTEN but is unusable (no screen, no coverage), an
  // earlier UNIT_CHECK_WRITTEN draft parses fine, and the last line says
  // CHECKS_WRITTEN. The envelope did not come from the final block, so the
  // pair is NOT reconciled — the ticket proceeds with no check at all
  // (spec #1334: a first-test problem never stops it), never on the draft.
  it("STALE DRAFT is still not reconciled: a written pair whose envelope came from an EARLIER fenced block builds with no first test", async () => {
    const exec = vi.fn();
    const draft = {
      marker: "UNIT_CHECK_WRITTEN",
      inherited: false,
      checkPackage: "packages/api",
      checkPath: "abandoned-draft.test.ts",
    };
    const brokenFinal = { marker: "CHECKS_WRITTEN", inherited: false, checkPath: "x.spec.ts" };
    const stdout =
      "First attempt:\n\n```json\n" + JSON.stringify(draft, null, 2) + "\n```\n\n" +
      "Actually, redoing it as a browser check:\n\n```json\n" + JSON.stringify(brokenFinal, null, 2) + "\n```\n\n" +
      "CHECKS_WRITTEN\n";
    const sandbox = makeSandbox({ stdout, exec });
    const quarantine = vi.fn();
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(quarantine).not.toHaveBeenCalled();
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    // The draft is NOT proceeded on: no check, no proof run.
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
    expect(exec).not.toHaveBeenCalled();
  });

  it("does NOT fire when the line and envelope marker genuinely agree — the ordinary, correct case", async () => {
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
    expect(quarantine).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 1c. A browser check ordered under a profile with no browser stack is
// refused outright — issue #933. `check-writer-prompt.md` already tells the
// check-writer not to do this (`BROWSER_AVAILABLE`), but that is advisory;
// this is the CODE branch that makes it structural.
// ---------------------------------------------------------------------------

describe("runCheckWriterStage — a browser check under a browserless profile is refused (issue #933)", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(
      path.join(tmpdir(), "sandcastle-checkwriter-browserless-"),
    );
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  function setProfile(profile: string): void {
    mkdirSync(path.join(worktree, ".sandcastle"), { recursive: true });
    writeFileSync(path.join(worktree, ".sandcastle", "profile"), profile);
  }

  it("minimal profile: CHECKS_WRITTEN is refused before any browser command is built — the ticket stops cleanly, it does not crash", async () => {
    setProfile("minimal");
    const exec = vi.fn();
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const quarantine = vi.fn();
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag, deps: { quarantine } });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    // #1198 A: still refused as a CHECK — the ticket proceeds carrying none,
    // which is the property that matters under a browserless profile — and
    // the ticket is built rather than killed.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.marker).toBe("NO_SCREEN_APPLIES");
    expect(result.checkCommand).toBeUndefined();
    expect(result.withoutFirstTest?.reason).toBe("no-failing-check");
    // Never reached the must-fail-first proof — refused before a command was
    // ever built, so no unrunnable Playwright command was ever attempted.
    expect(exec).not.toHaveBeenCalled();
  });

  it("playwright profile: the identical envelope proceeds normally — current behaviour is unchanged", async () => {
    setProfile("playwright");
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected proceed");
    expect(result.checkKind).toBe("browser");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("no profile file at all (pre-profiles project): defaults to browser-available, current behaviour unchanged", async () => {
    // No setProfile() call — the worktree has no .sandcastle/profile file.
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const { bag } = fakeTelemetry();
    const ctx = makeCtx({ telemetry: bag });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");

    expect(result.proceed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Inherit path: the HOST's own observation decides, not the agent's claim
// ---------------------------------------------------------------------------

describe("runCheckWriter — inheritance is the host's own filesystem observation", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-inherit-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it("host observes pre-existing files -> must-fail-first is SKIPPED even if the agent forgets inherited:true", async () => {
    // Piece J: an inherited check is committed by a HUMAN during a
    // supervised diagnosis session — it still has to be real, usable
    // content, so it uses VALID_CHECK_BODY here too (finding #5's content
    // check applies to an inherited check exactly as much as a fresh one).
    writeCheckFile(worktree, 911, "already-here.spec.ts");

    const exec = vi.fn(); // must NOT be called — proves the proof is skipped
    const sandbox = makeSandbox({
      stdout: envelope(
        {
          marker: "CHECKS_WRITTEN",
          inherited: false, // the agent "forgot" — host observation must win anyway
          screen: "/finance/reports?view=team",
          checkPath: "already-here.spec.ts",
        },
        "CHECKS_WRITTEN",
      ),
      worktreePath: worktree,
      exec,
    });
    const ctx = makeCtx({});
    const result = await runCheckWriter(sandbox, ctx as never);

    expect(result.inherited).toBe(true);
    expect(result.mustFailFirst).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("no pre-existing files, agent falsely claims inherited:true -> host does NOT trust it, still requires proof", async () => {
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: true, // unverified claim, nothing on disk backs it
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree, // exists but EMPTY at dispatch time — hasPreexistingCheckFiles() -> false
      exec,
      run: vi.fn().mockImplementation(async () => {
        // The file is written HERE, simulating the agent's own tool calls —
        // strictly AFTER `hasPreexistingCheckFiles` already snapshotted the
        // (still-empty) directory, so `inherited` stays correctly false.
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const ctx = makeCtx({});
    const result = await runCheckWriter(sandbox, ctx as never);

    // The host's own observation wins over the agent's self-report (Piece
    // D): no pre-existing files on disk means NOT inherited, no matter
    // what the envelope claims — so the must-fail-first proof still runs,
    // and (transitively) so does the twice-green stop this proof feeds.
    expect(result.inherited).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.mustFailFirst).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// 2b. A RESUMED ticket must never ship on an unproven check (issue #916,
// defect 2). A checkpoint commits the whole worktree including the check
// file; on resume the branch is force-pointed at that ref, so the check file
// is on disk before the check-writer pass starts and `hasPreexistingCheckFiles`
// reports "inherited" — a correct observation of the FILE that was being read
// as a claim about the PROOF. The proof itself cannot simply be re-run on a
// resume (the builder has already changed the code, so a green there means
// "the fix works", not "the check is useless"), so it travels forward as a
// durable receipt committed alongside the check.
// ---------------------------------------------------------------------------

describe("runCheckWriter — a resumed checkpoint carries its red proof, or re-proves (issue #916)", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-resume-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  function resumedSandbox(exec: SandboxHandle["exec"]): SandboxHandle {
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: true,
        screen: "/finance/reports?view=team",
        checkPath: "already-here.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sb = makeSandbox({ stdout, worktreePath: worktree, exec });
    (sb as unknown as { resumedFromCheckpoint: boolean }).resumedFromCheckpoint =
      true;
    return sb;
  }

  it("NO receipt -> the proof is NOT skipped, and the pass reports nothing was carried", async () => {
    // Exactly the checkpoint/resume shape: the check file is already on disk
    // (it was committed by the checkpoint), so the host observes
    // pre-existing files — but nothing anywhere proves it was ever seen to
    // fail.
    writeCheckFile(worktree, 911, "already-here.spec.ts");
    const exec = vi.fn(checkRunExec(RED_RUN));
    const result = await runCheckWriter(
      resumedSandbox(exec),
      makeCtx({}) as never,
    );

    expect(result.inherited).toBe(false);
    expect(result.proofCarriedForward).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(result.mustFailFirst).toBe("red");
  });

  it("a VALID receipt -> the proof is carried forward, not re-run against already-built code", async () => {
    writeCheckFile(worktree, 911, "already-here.spec.ts");
    writeMustFailFirstReceipt(worktree, browserLoc("already-here.spec.ts"));
    const exec = vi.fn(); // must NOT run — there is no untouched code left
    const result = await runCheckWriter(
      resumedSandbox(exec),
      makeCtx({}) as never,
    );

    expect(result.inherited).toBe(true);
    expect(result.proofCarriedForward).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("carrying the proof forward reaches the DURABLE RECORD, not just the return value", async () => {
    // `proofCarriedForward` was computed, returned, and consumed by nothing —
    // so nothing could answer "was this ticket's check proven on this run, or
    // was somebody else's proof carried in?" (2026-08-04 review).
    writeCheckFile(worktree, 911, "already-here.spec.ts");
    writeMustFailFirstReceipt(worktree, browserLoc("already-here.spec.ts"));
    const { calls, bag } = fakeTelemetry();
    await runCheckWriterStage(
      resumedSandbox(vi.fn()),
      makeCtx({ telemetry: bag }) as never,
      "pre-sha-0",
    );
    expect(calls).toContain("noteCheckWriterProofCarriedForward()");
  });

  it("a receipt for a check whose CONTENT changed since is not carried forward", async () => {
    writeCheckFile(worktree, 911, "already-here.spec.ts");
    writeMustFailFirstReceipt(worktree, browserLoc("already-here.spec.ts"));
    // The resumed check-writer pass rewrote its own check.
    writeCheckFile(
      worktree,
      911,
      "already-here.spec.ts",
      VALID_CHECK_BODY.replace("$1,234", "$9,999"),
    );
    const exec = vi.fn(checkRunExec(RED_RUN));
    const result = await runCheckWriter(
      resumedSandbox(exec),
      makeCtx({}) as never,
    );

    expect(result.proofCarriedForward).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("PROVES THE INSTRUMENT: a NON-resumed inherited check still skips the proof, exactly as before", async () => {
    // Piece J's human-committed inheritance is untouched by this fix — the
    // receipt requirement applies ONLY to a worktree that was cut from a WIP
    // checkpoint.
    writeCheckFile(worktree, 911, "already-here.spec.ts");
    const exec = vi.fn();
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: true,
        screen: "/finance/reports?view=team",
        checkPath: "already-here.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sb = makeSandbox({ stdout, worktreePath: worktree, exec });
    const result = await runCheckWriter(sb, makeCtx({}) as never);

    expect(result.inherited).toBe(true);
    expect(result.proofCarriedForward).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2026-08-04 review, BLOCKER 4. A receipt was only ever minted inside
  // `if (!inherited)`, so a HUMAN-COMMITTED (Piece J) check skipped the proof
  // on run 1 and left nothing behind. Checkpoint that ticket once and resume
  // it and `inherited` flips to false: the proof runs against a worktree that
  // already contains the builder's work, comes back GREEN for the most honest
  // possible reason, gets one retry, comes back GREEN again, and the ticket
  // is quarantined `stopped:no-failing-check` with the builder never
  // dispatched and the checkpointed work abandoned. Three more routes reach
  // the same place: a receipt write that returned undefined, a reformatted
  // check (sha mismatch), or a ticket checkpointed before this branch landed.
  //
  // Two things close it. Inheritance now mints its own receipt so it survives
  // the round trip; and a proof that RUNS on a resumed worktree can no longer
  // stop the ticket when it comes back green, because on a resumed worktree
  // green is not evidence of anything.
  // -------------------------------------------------------------------------

  it("BLOCKER 4: a human-committed check mints a receipt, so a later resume still skips the proof", async () => {
    writeCheckFile(worktree, 911, "already-here.spec.ts");
    const first = await runCheckWriter(
      makeSandbox({
        stdout: envelope(
          {
            marker: "CHECKS_WRITTEN",
            inherited: true,
            screen: "/finance/reports?view=team",
            checkPath: "already-here.spec.ts",
          },
          "CHECKS_WRITTEN",
        ),
        worktreePath: worktree,
        exec: vi.fn(),
      }),
      makeCtx({}) as never,
    );
    expect(first.inherited).toBe(true);
    expect(readMustFailFirstReceipt(worktree, browserLoc())?.basis).toBe(
      "inherited-human-committed",
    );

    // …and now the same ticket is checkpoint-stopped and resumed.
    const exec = vi.fn();
    const resumed = await runCheckWriter(
      resumedSandbox(exec),
      makeCtx({}) as never,
    );
    expect(resumed.inherited).toBe(true);
    expect(resumed.proofCarriedForward).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("BLOCKER 4: a GREEN proof on a resumed worktree does NOT quarantine the ticket", async () => {
    // The realistic resume the existing tests never covered: they hard-code
    // exec to exit 1 (red), which is exactly why this was invisible. Here the
    // builder's work is already in the tree, so the check passes.
    writeCheckFile(worktree, 911, "already-here.spec.ts");
    const exec = vi.fn(checkRunExec(GREEN_RUN));
    const quarantined: string[] = [];
    const result = await runCheckWriterStage(
      resumedSandbox(exec),
      makeCtx({
        deps: { quarantine: async (_n: number, r: string) => void quarantined.push(r) },
      }) as never,
      "pre-sha-0",
    );

    expect(quarantined).toEqual([]);
    expect(result.proceed).toBe(true);
  });

  it("BLOCKER 4: a RED proof on a resumed worktree mints an honestly-labelled receipt", async () => {
    // It really did come back red, so it is worth carrying — but it was not
    // proven "against the code as it stood BEFORE the builder touched it",
    // which is what the receipt's contract says. The record says which.
    writeCheckFile(worktree, 911, "already-here.spec.ts");
    const exec = vi.fn(checkRunExec(RED_RUN));
    const result = await runCheckWriter(
      resumedSandbox(exec),
      makeCtx({}) as never,
    );

    expect(result.mustFailFirst).toBe("red");
    expect(readMustFailFirstReceipt(worktree, browserLoc())?.basis).toBe(
      "proved-red-post-resume",
    );
  });

  it("an unsafe checkPath on a NON-CHECKS_WRITTEN envelope cannot waive the proof", async () => {
    // `checkwriter/schema.ts` applies `isSafeCheckRelativePath` only inside
    // the CHECKS_WRITTEN branch, but `proofCarriedForward` is computed BEFORE
    // the marker branch — so an ALREADY_BUILT envelope's `checkPath` reached
    // `readFileSync` with no whitelist between them. Here the traversal
    // target really exists and the receipt really matches it, so before the
    // guard this resolved to "proven" on a file outside the check directory
    // entirely.
    writeCheckFile(worktree, 911, "already-here.spec.ts");
    const escapeTarget = path.join(
      worktree,
      "apps/nextjs/e2e/checks",
      "outside.spec.ts",
    );
    writeFileSync(escapeTarget, VALID_CHECK_BODY);
    const good = writeMustFailFirstReceipt(worktree, browserLoc("already-here.spec.ts"));
    writeFileSync(
      path.join(worktree, checkDirForIssue(911), "must-fail-first-proof.json"),
      JSON.stringify({ ...good, checkPath: "../outside.spec.ts" }),
    );

    const sb = makeSandbox({
      stdout: envelope(
        {
          marker: "ALREADY_BUILT",
          inherited: false,
          checkPath: "../outside.spec.ts",
          alreadyBuiltEvidence: "apps/nextjs/.../page.tsx:40 already does this",
        },
        "ALREADY_BUILT",
      ),
      worktreePath: worktree,
      exec: vi.fn(),
    });
    (sb as unknown as { resumedFromCheckpoint: boolean }).resumedFromCheckpoint =
      true;
    const result = await runCheckWriter(sb, makeCtx({}) as never);
    expect(result.proofCarriedForward).toBe(false);
  });

  it("a fresh RED proof WRITES the receipt, so the next resume has something to carry", async () => {
    const exec = vi.fn(checkRunExec(RED_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const result = await runCheckWriter(sandbox, makeCtx({}) as never);

    expect(result.mustFailFirst).toBe("red");
    expect(
      mustFailFirstAlreadyProven(worktree, browserLoc("team-cash-flow.spec.ts")),
    ).toBe(true);
  });

  it("a GREEN proof writes NO receipt — only a check seen to FAIL is carried", async () => {
    const exec = vi.fn(checkRunExec(GREEN_RUN));
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const result = await runCheckWriter(sandbox, makeCtx({}) as never);

    expect(result.mustFailFirst).toBe("green");
    expect(
      readMustFailFirstReceipt(worktree, browserLoc()),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. "No screen applies" checked against the FINISHED diff (real git repo)
// ---------------------------------------------------------------------------

describe("shipAfterMigrations — the ship-time proof gate (issue #911, routed by #956)", () => {
  let repo: string;
  let commit: (files: Record<string, string>, message: string) => string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "sandcastle-no-screen-"));
    git(repo, "init", "-q", "-b", "issue-911");
    git(repo, "config", "user.email", "test@test");
    git(repo, "config", "user.name", "test");
    commit = (files, message) => commitInto(repo, files, message);
    commit({ "README.md": "seed\n" }, "init");
    git(repo, "branch", "run");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /**
   * `watched` / `stopped` collect the two things a waived refusal must and must
   * not do — a watch record on the issue body, and NO stop label — so a test
   * can assert on both without a second fixture (issue #969).
   */
  const watched: unknown[] = [];
  const stopped: unknown[] = [];
  const screenChecksNoted: unknown[] = [];

  beforeEach(() => {
    watched.length = 0;
    stopped.length = 0;
    screenChecksNoted.length = 0;
  });

  /** #1198 A: what the ship funnel labelled, if anything. */
  const shippedWithoutFirstTest: number[] = [];
  beforeEach(() => {
    shippedWithoutFirstTest.length = 0;
  });

  function makeShipCtx(
    args: Record<string, unknown> = {},
    /** #1198 A: set to put this ctx on the fall-through path. */
    firstTestFellThrough?: { reason: string; detail: string },
  ): unknown {
    return {
      args: {
        repoRoot: repo,
        branch: "run",
        stagingEnabled: true,
        ...args,
      },
      firstTestFellThrough,
      deps: {
        log: () => {},
        logError: () => {},
        markShippedWithoutFirstTest: async (n: number) => {
          shippedWithoutFirstTest.push(n);
        },
        checkLintCert: async () => ({ status: "dormant" }),
        checkTestCert: async () => ({ status: "dormant" }),
        validateMigrationJournal: async () => [],
        applyMigrations: async () => ({ realErrors: [], applied: 0 }),
        reportScreenCheckWatch: async (n: number, opts: unknown) => {
          watched.push({ n, opts });
        },
        reportStop: async (n: number, opts: unknown) => {
          stopped.push({ n, opts });
        },
      },
      issueNumber: 911,
      issue: { branch: "issue-911" },
      telemetry: {
        noteShipPath: () => {},
        noteDiff: () => {},
        noteImplementerAttempt: () => {},
        noteImplementerCertification: () => {},
        noteScreenCheck: (r: unknown) => screenChecksNoted.push(r),
      },
      runCounters: { bump: () => {} },
    };
  }

  /**
   * `shipAfterMigrations` with only the arguments this suite varies. A
   * waivable refusal lands in `watched` and the ship succeeds; a never-waived
   * one throws (spec #1334 — there is no mode).
   */
  async function ship(
    preSha: string,
    postSha: string,
    marker: CheckWriterMarker,
    over: {
      builderAccount?: string;
      /** #1198 A: run this ship as a ticket built without a first test. */
      firstTestFellThrough?: { reason: string; detail: string };
    } = {},
  ): Promise<Awaited<ReturnType<typeof shipAfterMigrations>>> {
    const { builderAccount, firstTestFellThrough, ...ctxOver } = over;
    return await shipAfterMigrations(
      makeShipCtx(
        { ...ctxOver },
        firstTestFellThrough,
      ) as never,
      { worktreePath: repo, exec: undefined } as never,
      {
        ...SHIP_INPUT_DEFAULTS,
        preSha,
        postSha,
        finalMarker: "ALL_CLEAR",
        checkWriterMarker: marker,
        checkWriterCheckCommand: undefined,
        checkWriterScreen: undefined,
        // Issue #1128: the builder's own account of the pass, threaded to the
        // deleted-test stop. `undefined` on every other test, which is what the
        // "raised no rebuttal on this pass" fallback is proven against.
        builderAccount,
      },
    );
  }

  it("a claim confined to .sandcastle/ and docs/ ships normally", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit({ "docs/reference/database.md": "note\n" }, "docs-only change");
    expect((await ship(preSha, postSha, "NO_SCREEN_APPLIES")).status).toBe("ok");
  });

  it("a claim VIOLATED by the finished diff touching apps/** is RECORDED and ships (spec #1334)", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "apps/nextjs/src/app/page.tsx": "export default function Page() {}\n" },
      "actually touched a screen",
    );
    expect((await ship(preSha, postSha, "NO_SCREEN_APPLIES")).status).toBe("ok");
    expect(watched).toHaveLength(1);
    const opts = (watched[0] as { opts: Record<string, unknown> }).opts;
    expect(opts.detail).toMatch(/check-writer-proof-demand-unsatisfied/);
    expect(stopped).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // #1198 A — a ticket the loop built WITHOUT a first test. The reviewer's
  // pass is its only gate, so the demand-versus-offer half of this gate must
  // not refuse it here, three agents and one full build later. Everything
  // else this gate does still holds.
  // -------------------------------------------------------------------------

  it("#1198 A: the SAME violating diff SHIPS when the loop built it without a first test — and carries the label", async () => {
    // Byte-identical to the recorded test above except for the flag: there
    // the refusal is recorded, here it is waived outright (no record at all),
    // so a broken fixture cannot make this pass for the wrong reason.
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "apps/nextjs/src/app/page.tsx": "export default function Page() {}\n" },
      "actually touched a screen",
    );
    const outcome = await ship(preSha, postSha, "NO_SCREEN_APPLIES", {
      firstTestFellThrough: {
        reason: "no-failing-check",
        detail: "the check passed against the unchanged code",
      },
    });
    expect(outcome.status).toBe("ok");
    expect(watched).toEqual([]);
    // The one thing that makes the weaker proof VISIBLE on the merge.
    expect(shippedWithoutFirstTest).toEqual([911]);
  });

  it("#1198 A: an ordinary ticket never gets the label", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "docs/reference/database.md": "note\n" },
      "docs-only change",
    );
    expect((await ship(preSha, postSha, "NO_SCREEN_APPLIES")).status).toBe("ok");
    expect(shippedWithoutFirstTest).toEqual([]);
  });

  it("#1198 second review, F1: MODIFYING another ticket's locked check is still refused on a fall-through ticket", async () => {
    // The hole the first cut of the waiver opened. `removedTestFiles` above
    // catches DELETING somebody else's check; nothing catches EDITING one but
    // this refusal, and `DEFAULT_PROTECTED_PATH_GLOBS` does not cover the
    // check directories. A ticket that could not produce its own first test
    // has less licence to rewrite another ticket's, not more.
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      {
        "apps/nextjs/e2e/checks/issue-819/cross-team-rate-cell-delete.spec.ts":
          "// another ticket's red-first proof, edited\n",
      },
      "edited another issue's locked check while building without a first test",
    );
    await expect(
      ship(preSha, postSha, "NO_SCREEN_APPLIES", {
        firstTestFellThrough: {
          reason: "no-failing-check",
          detail: "the check passed against the unchanged code",
        },
      }),
      // #1271 moved this refusal ABOVE the demand comparison and gave it its
      // own name, so the same diff is refused for the same reason under a
      // message that finally says which reason: it is the locked check that
      // stops it, not an unmet proof demand. The behaviour pinned here — a
      // fall-through ticket may not edit another issue's check — is unchanged.
    ).rejects.toThrow(/check-writer-locked-check-touched.*issue-819/s);
    // And it never reached the label, because it never shipped.
    expect(shippedWithoutFirstTest).toEqual([]);
  });

  it("#1198 A: a DELETED test is still refused on a fall-through ticket — that refusal is never waived", async () => {
    // A different question entirely from "was this diff proven": not "is there
    // proof for this change" but "did this change delete somebody else's".
    // Nothing about a missing first test licenses removing coverage.
    const seeded = commit(
      { "apps/nextjs/e2e/team-isolation.spec.ts": "test('x', () => {});\n" },
      "seed a regression spec",
    );
    git(repo, "branch", "-f", "run", seeded);
    rmSync(path.join(repo, "apps/nextjs/e2e/team-isolation.spec.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "delete the regression spec");
    const postSha = git(repo, "rev-parse", "HEAD");
    await expect(
      ship(seeded, postSha, "NO_SCREEN_APPLIES", {
        firstTestFellThrough: { reason: "no-failing-check", detail: "x" },
      }),
    ).rejects.toThrow(
      /check-writer-test-coverage-removed[\s\S]*team-isolation/,
    );
    expect(shippedWithoutFirstTest).toEqual([]);
  });

  // The one carve-out, exercised THROUGH this ship path rather than against
  // the router in isolation. Without these, re-inlining the old rule here and
  // leaving the rescue path on the shared function would leave the suite green.
  it("a claim holds when the finished diff only repairs the browser instrument", async () => {
    // #927/#928/#929: you cannot be handed a red-first check for "this browser
    // check asserts a stale fact" — the thing under repair IS the instrument.
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      {
        "apps/nextjs/e2e/os-shell-top-bar.spec.ts": "// repaired spec\n",
        "apps/nextjs/e2e/finance-reports.spec.ts": "// repaired spec 2\n",
      },
      "repaired the Playwright suite",
    );
    expect((await ship(preSha, postSha, "NO_SCREEN_APPLIES")).status).toBe("ok");
  });

  it("a TEST-ONLY diff no longer ships unrecorded — the #820 hole, closed (issue #956)", async () => {
    // The blanket test-file carve-out waived proof for a diff made of nothing
    // but tests, with no record — exactly how #820 — literally "four
    // team-isolation tests pass even with the guard deleted" — shipped proven
    // by nothing, unseen. A test file outside the Playwright suite is still a
    // touch inside packages/**, so it owes a UNIT proof; since spec #1334 the
    // unmet demand is recorded and the ticket ships.
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      {
        "packages/api/src/router/deal.test.ts": "// new unit coverage\n",
        "packages/api/src/__tests__/isolation.ts": "// test helper\n",
      },
      "test-only change",
    );
    expect((await ship(preSha, postSha, "NO_SCREEN_APPLIES")).status).toBe("ok");
    expect(watched).toHaveLength(1);
    expect(
      (watched[0] as { opts: { detail: string } }).opts.detail,
    ).toMatch(/check-writer-proof-demand-unsatisfied[\s\S]*demands 'unit'/);
  });

  it("a UNIT_CHECK_WRITTEN outcome SATISFIES that same unit demand", async () => {
    // The other half of the reversal, and the whole point of the ticket: the
    // diff above is not un-shippable, it simply owes a proof it can now give.
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "packages/api/src/router/deal.test.ts": "// new unit coverage\n" },
      "test-only change, with a red-first unit check behind it",
    );
    expect((await ship(preSha, postSha, "UNIT_CHECK_WRITTEN")).status).toBe("ok");
  });

  it("a UNIT_CHECK_WRITTEN outcome does NOT satisfy a browser demand", async () => {
    // The dodge this closes. A unit test can never stand in for a photograph:
    // a correct answer drawn wrong on the page is the case only a screen
    // catches, and it is one of the two bugs that started this design.
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      {
        "apps/nextjs/src/app/(tracker)/tracker/_components/widgets/chart.tsx":
          "export const Chart = () => null;\n",
      },
      "a screen change offering only a unit proof",
    );
    expect((await ship(preSha, postSha, "UNIT_CHECK_WRITTEN")).status).toBe("ok");
    expect(watched).toHaveLength(1);
    expect(
      (watched[0] as { opts: { detail: string } }).opts.detail,
    ).toMatch(/check-writer-proof-demand-unsatisfied[\s\S]*demands 'browser'/);
  });

  it("a CHECKS_WRITTEN outcome satisfies a unit demand — over-proving is always legal", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "packages/api/src/services/email/queue.ts": "export const q = 1;\n" },
      "backend change photographed anyway",
    );
    expect((await ship(preSha, postSha, "CHECKS_WRITTEN")).status).toBe("ok");
  });

  it("a diff that DELETES a browser regression spec throws — removal is never exempt", async () => {
    // Deletes a spec for REAL rather than hand-feeding a path list: the gate
    // reads git between the two shas, so this exercises the whole chain.
    const seeded = commit(
      { "apps/nextjs/e2e/os-shell-top-bar.spec.ts": "test('x', () => {});\n" },
      "seed the regression spec",
    );
    // The spec must PRE-EXIST the measured range, as it does in reality —
    // it is already on the run branch. A spec both created and deleted
    // inside one ticket nets to nothing and is correctly not flagged.
    git(repo, "branch", "-f", "run", seeded);
    rmSync(path.join(repo, "apps/nextjs/e2e/os-shell-top-bar.spec.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "delete the regression spec");
    const postSha = git(repo, "rev-parse", "HEAD");
    await expect(ship(seeded, postSha, "NO_SCREEN_APPLIES")).rejects.toThrow(
      /check-writer-test-coverage-removed[\s\S]*os-shell-top-bar/,
    );
  });

  it("the SAME deletion throws under CHECKS_WRITTEN — no outcome waives it (issue #956)", async () => {
    // Under the guard this replaced, the removal stop lived INSIDE the
    // no-screen branch: a ticket that wrote a perfectly good browser check
    // could delete the 117-file Playwright suite and ship. Nothing downstream
    // notices — the lock covers only this issue's check directory, the
    // ship-time run executes only the ONE check file, and vitest's include is
    // src/**, so deleted specs "pass" by being absent.
    const seeded = commit(
      { "apps/nextjs/e2e/finance-reports.spec.ts": "test('x', () => {});\n" },
      "seed a regression spec",
    );
    git(repo, "branch", "-f", "run", seeded);
    rmSync(path.join(repo, "apps/nextjs/e2e/finance-reports.spec.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "delete the regression spec");
    const postSha = git(repo, "rev-parse", "HEAD");
    await expect(ship(seeded, postSha, "CHECKS_WRITTEN")).rejects.toThrow(
      /check-writer-test-coverage-removed[\s\S]*finance-reports/,
    );
    await expect(ship(seeded, postSha, "UNIT_CHECK_WRITTEN")).rejects.toThrow(
      /check-writer-test-coverage-removed/,
    );
  });

  // -------------------------------------------------------------------------
  // Issue #1082 fault 3a, built under issue #1128 — the deleted-test stop
  // report carries the BUILDER'S OWN REASON.
  //
  // This stop exists so a person can judge whether removing a test was right,
  // and it shipped carrying only what the gate demanded and what the builder
  // produced: `proofGateRefusal` had no `builderAccount` key at all, so the
  // rendered report said "(not recorded)" for the one field the judgement
  // actually turns on. Acceptance, verbatim from issue #1082: "The deleted-test
  // stop report carries the builder's stated reason whenever the builder gave
  // one. If none was given, the report says that explicitly."
  // -------------------------------------------------------------------------

  /** Delete a pre-existing spec for real, and return the two shas around it. */
  function deleteSeededSpec(): { seeded: string; postSha: string } {
    const seeded = commit(
      { "apps/nextjs/e2e/os-shell-top-bar.spec.ts": "test('x', () => {});\n" },
      "seed the regression spec",
    );
    git(repo, "branch", "-f", "run", seeded);
    rmSync(path.join(repo, "apps/nextjs/e2e/os-shell-top-bar.spec.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "delete the regression spec");
    return { seeded, postSha: git(repo, "rev-parse", "HEAD") };
  }

  async function deletionDisagreement(
    over: { builderAccount?: string } = {},
  ): Promise<Record<string, string | undefined>> {
    const { seeded, postSha } = deleteSeededSpec();
    try {
      await ship(seeded, postSha, "NO_SCREEN_APPLIES", over);
    } catch (err) {
      return (err as { disagreement?: Record<string, string | undefined> })
        .disagreement ?? {};
    }
    throw new Error("expected the deleted-test stop to throw");
  }

  it("carries the builder's stated reason when the builder gave one", async () => {
    const d = await deletionDisagreement({
      builderAccount:
        "The spec asserted a $1,000 cap that this ticket removes, so it can " +
        "only ever fail; the behaviour it covered is now covered by the unit " +
        "check this ticket adds.",
    });
    expect(d.builderAccount).toContain("$1,000 cap that this ticket removes");
    // Both other sides are still there — the account is an addition, not a
    // replacement for the evidence.
    expect(d.checkDemanded).toContain("must not be removed");
    expect(d.builderProduced).toContain("os-shell-top-bar");
  });

  it("says so EXPLICITLY when no rebuttal reached it — the field is never dropped", async () => {
    const d = await deletionDisagreement();
    // Not absent, and not the renderer's generic "(not recorded)", which reads
    // as "nobody looked". It also may not say the builder GAVE NO REASON: a
    // rebuttal exists only on a retry pass, so that would be asserted on every
    // first-pass ship, about words this record never captured.
    expect(d.builderAccount).toBe(
      "(the builder raised no rebuttal on this pass; its own words are not captured in this record)",
    );
  });

  it("treats an empty or whitespace-only account as no account at all", async () => {
    // A builder that emitted an empty <rebuttal> block said nothing; the
    // report must not render a blank line where the argument belongs.
    expect(
      (await deletionDisagreement({ builderAccount: "" })).builderAccount,
    ).toBe(
      "(the builder raised no rebuttal on this pass; its own words are not captured in this record)",
    );
    expect(
      (await deletionDisagreement({ builderAccount: "   \n  " })).builderAccount,
    ).toBe(
      "(the builder raised no rebuttal on this pass; its own words are not captured in this record)",
    );
  });

  it("a 'test-only' diff that touches ANOTHER ticket's locked check still throws", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      {
        "apps/nextjs/e2e/checks/issue-819/cross-team-rate-cell-delete.spec.ts":
          "// another ticket's red-first proof, edited\n",
      },
      "touched another issue's check under cover of a test-only diff",
    );
    // #1271: same refusal, its own name. The locked-check test now runs above
    // `proofDemandSatisfied`'s early return, so it answers before the demand
    // comparison rather than riding out on its `neverWaived` flag.
    await expect(ship(preSha, postSha, "NO_SCREEN_APPLIES")).rejects.toThrow(
      /check-writer-locked-check-touched.*issue-819/s,
    );
  });

  // -------------------------------------------------------------------------
  // Watch-only obeys the mode for PRODUCT CODE and never for removed coverage
  // (issue #969). The night of 2026-08-04 stopped #805/#820/#845/#848 — all
  // four `packages/api`-only — with the switch OFF, i.e. while the loop was
  // recording screen-check disagreements rather than acting on them.
  //
  // CARRIED ACROSS THE ROUTER REWRITE (issue #956). #969 drew this line inside
  // `no-screen-guard.ts`, which the router replaced; the split had to move with
  // it, not die with it. What the mode governs is the DEMAND-VERSUS-OFFER
  // judgement — "this diff owed a proof it did not offer" — because that is the
  // screen-check judgement nobody has measured yet. What it must never govern
  // is removed coverage, which nothing downstream would catch.
  // -------------------------------------------------------------------------

  it("a packages/**-only diff ships, is recorded, and gets no stop label", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      {
        "packages/api/src/services/email/queue.ts": "export const q = 1;\n",
        "packages/db/src/schema.ts": "export const s = 1;\n",
      },
      "the #848 diff: backend only, no screen to name",
    );
    const outcome = await ship(preSha, postSha, "NO_SCREEN_APPLIES", {
    });

    expect(outcome.status).toBe("ok");
    // Recorded, with both sides, and reported as what enforcement WOULD have
    // done — the whole point of the settling-in period is to count these.
    expect(watched).toHaveLength(1);
    const opts = (watched[0] as { opts: Record<string, unknown> }).opts;
    expect(opts.wouldHaveStoppedAs).toBe("stopped:check-disagreement");
    const disagreement = opts.disagreement as Record<string, string>;
    expect(disagreement.checkDemanded).toContain("'unit'");
    expect(disagreement.builderProduced).toContain(
      "packages/api/src/services/email/queue.ts",
    );
    // And NOT held: no stop label, no quarantine.
    expect(stopped).toEqual([]);
  });

  it("a DELETED regression spec still throws — removed coverage is never waived", async () => {
    const seeded = commit(
      { "apps/nextjs/e2e/os-shell-top-bar.spec.ts": "test('x', () => {});\n" },
      "seed the regression spec",
    );
    git(repo, "branch", "-f", "run", seeded);
    rmSync(path.join(repo, "apps/nextjs/e2e/os-shell-top-bar.spec.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "delete the regression spec");
    const postSha = git(repo, "rev-parse", "HEAD");

    await expect(
      ship(seeded, postSha, "NO_SCREEN_APPLIES"),
    ).rejects.toThrow(/os-shell-top-bar[\s\S]*never waived/);
    // Not "shipped and recorded" — genuinely stopped.
    expect(watched).toEqual([]);
  });

  it("a DELETED spec still throws under CHECKS_WRITTEN too — every route", async () => {
    // The two axes crossed. #969 only ever proved the never-waived rule under
    // NO_SCREEN_APPLIES, because that was the only branch its guard ran in.
    // The router applies the removal stop under every marker, so the mode and
    // the marker have to be varied together or "under EVERY route and in BOTH
    // modes" is an assertion nobody made.
    const seeded = commit(
      { "apps/nextjs/e2e/finance-reports.spec.ts": "test('x', () => {});\n" },
      "seed the regression spec",
    );
    git(repo, "branch", "-f", "run", seeded);
    rmSync(path.join(repo, "apps/nextjs/e2e/finance-reports.spec.ts"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "delete the regression spec");
    const postSha = git(repo, "rev-parse", "HEAD");

    await expect(
      ship(seeded, postSha, "CHECKS_WRITTEN"),
    ).rejects.toThrow(/check-writer-test-coverage-removed[\s\S]*never waived/);
    await expect(
      ship(seeded, postSha, "UNIT_CHECK_WRITTEN"),
    ).rejects.toThrow(/check-writer-test-coverage-removed/);
    expect(watched).toEqual([]);
  });

  it("the SAME apps/** diff ships fine under CHECKS_WRITTEN (a normal ticket)", async () => {
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "apps/nextjs/src/app/page.tsx": "export default function Page() {}\n" },
      "a normal screen-touching ticket",
    );
    expect((await ship(preSha, postSha, "CHECKS_WRITTEN")).status).toBe("ok");
  });

  it("a marker that can never reach ship stops loudly rather than waving the diff through", async () => {
    // ALREADY_BUILT and NEEDS_WORLD_DATA quarantine inside the check-writer
    // stage, so arriving here is a LOOP bug. Answering "nothing was owed"
    // would let exactly that bug ship an entirely unproven diff.
    const preSha = git(repo, "rev-parse", "HEAD");
    const postSha = commit(
      { "packages/api/src/router/internal.ts": "export const x = 1;\n" },
      "a diff that should never have been built",
    );
    await expect(ship(preSha, postSha, "ALREADY_BUILT")).rejects.toThrow(
      /check-writer-marker-cannot-ship/,
    );
    await expect(ship(preSha, postSha, "NEEDS_WORLD_DATA")).rejects.toThrow(
      /check-writer-marker-cannot-ship/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4a. Arrival proof — real prompt files, real substitution function
// ---------------------------------------------------------------------------

describe("check-writer-prompt.md — every placeholder actually arrives (Piece L discipline)", () => {
  it("applyPromptArgs substitutes every {{PLACEHOLDER}} runCheckWriter actually sends", () => {
    const raw = readFileSync(CHECK_WRITER_PROMPT_PATH, "utf8");
    const args = {
      ITERATION: "3",
      ISSUE_NUMBER: "911",
      ISSUE_SPEC: "# the ticket text, read on the host",
      BRANCH: "issue-911",
      CHECK_DIR: checkDirForIssue(911),
      CHECK_ATTEMPT: "1",
      REPAIR_BRIEF: "",
      BROWSER_AVAILABLE: "true",
      SIBLING_TICKETS: renderSiblingTickets([]),
    };
    const rendered = applyPromptArgs(raw, args);
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain("apps/nextjs/e2e/checks/issue-911");
    expect(rendered).toContain("ISSUE_NUMBER: 911");
    expect(rendered).toContain("CHECK_ATTEMPT: 1");
    expect(rendered).toContain("BROWSER_AVAILABLE: true");
  });

  it("throws (does not silently render blank) when a placeholder is missing a value — proves the check ISN'T vacuous", () => {
    const raw = readFileSync(CHECK_WRITER_PROMPT_PATH, "utf8");
    expect(() => applyPromptArgs(raw, { ITERATION: "1" })).toThrow(
      /has no matching value in promptArgs/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4a-bis. The check-writer is told what the REST of the run is building
//
// Every fault the 2026-08-11 batch of 17 tickets produced lived in the seam
// between two tickets running at once — most sharply, a ticket that added a
// duplicate-address guard on deal filing versus a sibling ticket's acceptance
// check that filed deals at a hard-coded address, which meant that check now
// blocks itself. The check-writer could not have seen that coming: it was
// handed its own ticket number and nothing else.
//
// These tests prove the one thing only this file can: that the list actually
// SURVIVES INTO THE RENDERED PROMPT TEXT, through the real prompt file and the
// real substituter — not merely into a promptArgs object nobody proved gets
// substituted. Truncation, fail-soft collection, the self-exclusion filter and
// the rendered block's shape are unit-tested beside the module they live in,
// `lib/checkwriter/sibling-briefs.test.ts`.
// ---------------------------------------------------------------------------

describe("sibling tickets — the check-writer can see what the rest of the run is building", () => {
  const baseArgs = {
    ITERATION: "3",
    ISSUE_NUMBER: "911",
    ISSUE_SPEC: "# the ticket text, read on the host",
    BRANCH: "issue-911",
    CHECK_DIR: checkDirForIssue(911),
    CHECK_ATTEMPT: "1",
      REPAIR_BRIEF: "",
    BROWSER_AVAILABLE: "true",
  };

  /** The 2026-08-11 collision, in miniature: a guard ticket and a dashboard
   *  ticket, running beside the ticket under test. */
  const SIBLINGS: readonly SiblingTicketBrief[] = [
    {
      number: 812,
      title: "refuse a second deal at an address already on the board",
      body: "Filing a deal at an address that already has a deal must be refused on every road in, not just the one form.",
    },
    {
      number: 815,
      title: "a newly shipped dashboard card reaches people who saved a layout",
    },
  ];

  it("populated case: both sibling NUMBERS and TITLES survive into the rendered prompt, and so does the body text a check-writer would collide with", () => {
    const raw = readFileSync(CHECK_WRITER_PROMPT_PATH, "utf8");
    const rendered = applyPromptArgs(raw, {
      ...baseArgs,
      SIBLING_TICKETS: renderSiblingTickets(SIBLINGS),
    });

    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain("812");
    expect(rendered).toContain(
      "refuse a second deal at an address already on the board",
    );
    expect(rendered).toContain("815");
    expect(rendered).toContain(
      "a newly shipped dashboard card reaches people who saved a layout",
    );
    // The BODY is the part that actually warns off a fixture address — a
    // title-only list would not have prevented the 2026-08-11 collision.
    expect(rendered).toContain("must be refused on every road in");
    // And the prompt has to say these tickets' code does not exist yet,
    // otherwise the check-writer goes looking for it.
    expect(rendered).toContain("INTENT");
  });

  it("empty case: the only ticket in the run gets a real sentence, never a hole or a raw placeholder", () => {
    const raw = readFileSync(CHECK_WRITER_PROMPT_PATH, "utf8");
    const rendered = applyPromptArgs(raw, {
      ...baseArgs,
      SIBLING_TICKETS: renderSiblingTickets([]),
    });

    expect(rendered).not.toMatch(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/);
    expect(rendered).toContain(NO_SIBLING_TICKETS);
    // The prompt's own "If the block reads …" instruction QUOTES this
    // sentence. Asserted against the raw file so that rewording the constant
    // without rewording the prompt fails here, rather than silently leaving
    // the model an instruction that matches nothing.
    expect(raw).toContain("no other tickets");
    expect(NO_SIBLING_TICKETS).toContain("no other tickets");
  });

  it("the sibling list reaches the real dispatch's promptArgs, and substitutes cleanly from there", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: envelope(
        {
          marker: "NO_SCREEN_APPLIES",
          inherited: false,
          noScreenReason: "this ticket only edits .sandcastle/main.mts",
        },
        "NO_SCREEN_APPLIES",
      ),
      commits: [],
    });
    const sandbox = makeSandbox({ stdout: "", run });

    await runCheckWriter(sandbox, makeCtx({ siblingTickets: SIBLINGS }) as never);

    expect(run).toHaveBeenCalledTimes(1);
    const spec = run.mock.calls[0]![0] as { promptArgs: Record<string, string> };
    expect(spec.promptArgs.SIBLING_TICKETS).toContain("812");
    expect(spec.promptArgs.SIBLING_TICKETS).toContain("815");

    // End-to-end: the value the DISPATCH built, pushed through the REAL prompt
    // file and the REAL substituter.
    const rendered = applyPromptArgs(
      readFileSync(CHECK_WRITER_PROMPT_PATH, "utf8"),
      spec.promptArgs,
    );
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain(
      "refuse a second deal at an address already on the board",
    );
  });
});

describe("review-prompt.md — the CHECK_WRITER_* placeholders this ticket added actually arrive", () => {
  const baseArgs = {
    ITERATION: "1",
    ISSUE_NUMBER: "911",
    ISSUE_SPEC: "# the ticket text, read on the host",
    COMMIT_SHA: "deadbeef",
    REVIEW_BASE: "main",
    BRANCH: "issue-911",
    IMPLEMENTER_REBUTTAL: "",
    SKILLS_INVOKED: "(none invoked)",
    IMPLEMENTER_CERTIFICATION: "(no certification)",
    // Spec #1334 SG: empty on every ordinary pass; filled only on the first
    // review of work no build pass produced.
    REVIEW_SITUATION: "",
    // Issue #1128: empty on every ordinary pass; only the no-verdict re-ask
    // fills it.
    VERDICT_FORMAT_REMINDER: "",
  };

  it("populated case: the reviewer is told the check is authoritative, verbatim, not paraphrased", () => {
    const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");
    const rendered = applyPromptArgs(raw, {
      ...baseArgs,
      CHECK_WRITER_CHECK_PATH: "team-cash-flow.spec.ts",
      CHECK_WRITER_CHECK_COMMAND:
        "env CI=1 NO_COLOR=1 FORCE_COLOR=0 pnpm --filter @acme/nextjs e2e checks/issue-911/team-cash-flow.spec.ts --reporter=line",
      CHECK_WRITER_SCREEN: "/finance/reports?view=team",
      // #1198 A: empty on an ordinary ticket — this one has a real check.
      CHECK_WRITER_FALL_THROUGH: "",
    });
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain("team-cash-flow.spec.ts");
    expect(rendered).toContain(
      "pnpm --filter @acme/nextjs e2e checks/issue-911/team-cash-flow.spec.ts",
    );
    expect(rendered).toContain("AUTHORITATIVE evidence");
    expect(rendered).toContain("SCAFFOLDING");
  });

  it("empty case: a NO_SCREEN_APPLIES ticket renders empty check-writer blocks, falls back to the old rules", () => {
    const raw = readFileSync(REVIEW_PROMPT_PATH, "utf8");
    const rendered = applyPromptArgs(raw, {
      ...baseArgs,
      CHECK_WRITER_CHECK_PATH: "",
      CHECK_WRITER_CHECK_COMMAND: "",
      CHECK_WRITER_SCREEN: "",
      CHECK_WRITER_FALL_THROUGH: "",
    });
    expect(rendered).toContain("<check-writer-check-path>\n\n</check-writer-check-path>");
    expect(rendered).toContain("Fall back to the existing rules below");
  });
});

// ---------------------------------------------------------------------------
// 4b. The per-agent cost split — read back OFF DISK
// ---------------------------------------------------------------------------

describe("the checkWriter cost split actually lands in .sandcastle/telemetry/issues.jsonl", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sandcastle-issues-jsonl-"));
    storePath = path.join(dir, "issues.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("checkWriter is registered as its own attributable role and its cost/tokens survive a disk round-trip, separate from implementer's", () => {
    // checkWriter is now one of CostLedger's roles.
    expect(CostLedger.ROLE_ORDER).toContain("checkWriter");

    const issueLedger = new IssueLedger();
    issueLedger.addCost(911, "checkWriter", [
      {
        model: "claude-opus-5",
        usage: {
          inputTokens: 4000,
          outputTokens: 500,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]);
    issueLedger.addTiming(911, "checkWriter", 12_000);
    issueLedger.addCost(911, "implementer", [
      {
        model: "claude-sonnet-5",
        usage: {
          inputTokens: 40_000,
          outputTokens: 6_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]);
    issueLedger.addTiming(911, "implementer", 300_000);

    const [row] = issueLedger.rows();
    expect(row).toBeDefined();
    expect(row!.perRole!.checkWriter).toBeDefined();
    expect(row!.perRole!.implementer).toBeDefined();
    // Distinct numbers — proves it's a SPLIT, not one merged total.
    expect(row!.perRole!.checkWriter!.wallMs).toBe(12_000);
    expect(row!.perRole!.implementer!.wallMs).toBe(300_000);

    // Now actually WRITE it to disk via the real production path
    // (buildReworkRecordInput -> appendReworkRecord), then READ IT BACK —
    // never trust the in-memory `row` object as proof of what shipped.
    const input = buildReworkRecordInput({
      issueNumber: 911,
      status: "ok",
      shippedSha: "abc123",
      runId: "run-1",
      hostId: "host-1",
      shippedAtIso: new Date().toISOString(),
      ledgerRow: row,
    });
    const wrote = appendReworkRecord(input, { path: storePath });
    expect(wrote).toBe(true);

    // Read back OFF DISK — a fresh read, not the `input`/`row` objects above.
    const raw = readFileSync(storePath, "utf8");
    expect(raw).toContain('"checkWriter"');
    const parsedLine = JSON.parse(raw.trim().split("\n")[0]!);
    expect(parsedLine.perRole.checkWriter.wallMs).toBe(12_000);
    expect(parsedLine.perRole.implementer.wallMs).toBe(300_000);
    expect(parsedLine.perRole.checkWriter.costUsd).not.toEqual(
      parsedLine.perRole.implementer.costUsd,
    );

    const { records } = readReworkRecords({ path: storePath });
    expect(records).toHaveLength(1);
    expect(records[0]!.perRole!.checkWriter!.wallMs).toBe(12_000);
    expect(records[0]!.perRole!.implementer!.wallMs).toBe(300_000);
  });

  it("an issue with NO check-writer cost (e.g. it inherited a check and made no dispatch) writes no checkWriter key at all — absent, never zero", () => {
    const issueLedger = new IssueLedger();
    issueLedger.addCost(912, "implementer", [
      {
        model: "claude-sonnet-5",
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
      },
    ]);
    const [row] = issueLedger.rows();
    const input = buildReworkRecordInput({
      issueNumber: 912,
      status: "ok",
      shippedSha: "def456",
      runId: "run-1",
      hostId: "host-1",
      shippedAtIso: new Date().toISOString(),
      ledgerRow: row,
    });
    appendReworkRecord(input, { path: storePath });

    const { records } = readReworkRecords({ path: storePath });
    expect(records[0]!.perRole).not.toHaveProperty("checkWriter");
    expect(records[0]!.perRole).toHaveProperty("implementer");
  });
});

// ---------------------------------------------------------------------------
// The 2026-08-05 production failure: a proof that could never succeed, and a
// run log that said nothing about why.
//
// The sandbox is handed POSTGRES_URL pointing at the docker bridge gateway
// (`172.17.0.1:55432`). That night the host firewall dropped it, so every
// must-fail-first proof died in Playwright's globalSetup in ~20s with `write
// CONNECT_TIMEOUT 172.17.0.1:55432`, printed no tally line, and classified
// `inconclusive`. Issues #803 and #813 burned ~19 minutes each and were
// quarantined `stopped:no-failing-check` — and `verdict.reason` was computed,
// discarded, and never logged anywhere, so the run log carried ZERO
// explanation and the real cause was invisible.
//
// These tests pin BOTH halves of the fix: the reason + a redacted, bounded
// tail reach the run log, and the reason reaches the stop the human reads.
// ---------------------------------------------------------------------------

describe("must-fail-first — an unproven proof says WHY (2026-08-05)", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(path.join(tmpdir(), "sandcastle-checkwriter-why-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  /** That night's real output, with a password in it (SANDCASTLE_TEST_DB_URL
   *  is an operator escape hatch that may carry a real one). */
  const CONNECT_TIMEOUT_OUTPUT =
    "Running 1 test using 1 worker\n" +
    "Error: connect to postgres://postgres:hunter2@172.17.0.1:55432/postgres\n" +
    "  write CONNECT_TIMEOUT 172.17.0.1:55432\n" +
    "    at globalSetup (apps/nextjs/e2e/global-setup.ts:14:11)\n";

  /** A stage run whose proof always dies the way it died on 2026-08-05. */
  async function runWithConnectTimeout() {
    const exec = vi.fn().mockResolvedValue({
      stdout: CONNECT_TIMEOUT_OUTPUT,
      stderr: "",
      exitCode: 1,
      timedOut: false,
    });
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const logged: string[] = [];
    const quarantine = vi.fn();
    const ctx = makeCtx({
      deps: {
        quarantine,
        log: (m: string) => logged.push(m),
        logError: (m: string) => logged.push(m),
      },
    });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");
    return { result, logged, quarantine };
  }

  it("PROVES THE INSTRUMENT: this fixture really does reproduce the environment-fault road", async () => {
    const { result, quarantine } = await runWithConnectTimeout();
    // Since #1198 A an inconclusive proof (an unreachable database is the
    // canonical case) is classed as an ENVIRONMENT fault and the ticket is
    // BUILT — the run's own machinery failing is never a finding about the
    // ticket, and it was the class of stop nothing about the ticket could fix.
    expect(result.proceed).toBe(true);
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    expect(quarantine).not.toHaveBeenCalled();
    expect(result.withoutFirstTest?.reason).toBe("run-fault");
  });

  it("logs the classifier's reason AND a tail of the check's own output", async () => {
    const { logged } = await runWithConnectTimeout();
    const diagnostic = logged.filter((m) =>
      m.includes("must-fail-first proof came back"),
    );
    // Once per attempt — the ladder runs the proof twice.
    expect(diagnostic.length).toBe(2);
    const first = diagnostic[0]!;
    expect(first).toContain("'inconclusive'");
    // The classifier's own words. It used to say "no Playwright tally line";
    // since 2026-08-06 nothing reads free text, so the reason names the
    // missing HOST-generated evidence line instead. Same assertion, current
    // wording — the point is that the specific reason reaches the log.
    expect(first).toContain("no host-generated evidence line in the output");
    // THE LINE THAT WAS MISSING ON 2026-08-05: the unreachable address.
    expect(first).toContain("write CONNECT_TIMEOUT 172.17.0.1:55432");
    // Reproducible by hand: the exact command that was run.
    expect(first).toContain("pnpm --filter @acme/nextjs e2e checks/issue-");
  });

  it("never writes the database password into the run log", async () => {
    const { logged } = await runWithConnectTimeout();
    expect(logged.join("\n")).not.toContain("hunter2");
    expect(logged.join("\n")).not.toContain("postgres:hunter2@");
    // ...while keeping the host:port, which is the entire diagnostic value.
    expect(logged.join("\n")).toContain("172.17.0.1:55432");
  });

  it("carries the reason into the note a human actually reads on the ticket", async () => {
    const { result } = await runWithConnectTimeout();
    if (!result.proceed) throw new Error("expected the builder to be dispatched");
    const note = String(result.withoutFirstTest?.detail);
    // The diagnosis the stop used to carry is still written, verbatim — a
    // ticket that got built without a first test is exactly as worth
    // explaining as one that was held for it.
    expect(note).toContain("no host-generated evidence line in the output");
    expect(note).not.toContain("(no reason recorded)");
  });

  it("stays quiet on a RED proof — the outcome that proves the check works", async () => {
    const exec = vi.fn(
      checkRunExec({ ...RED_RUN, stdout: "Running 1 test using 1 worker\n" }),
    );
    const stdout = envelope(
      {
        marker: "CHECKS_WRITTEN",
        inherited: false,
        screen: "/finance/reports?view=team",
        checkPath: "team-cash-flow.spec.ts",
      },
      "CHECKS_WRITTEN",
    );
    const sandbox = makeSandbox({
      stdout,
      worktreePath: worktree,
      exec,
      run: vi.fn().mockImplementation(async () => {
        writeCheckFile(worktree, 911, "team-cash-flow.spec.ts");
        return { stdout, commits: [] };
      }),
    });
    const logged: string[] = [];
    const ctx = makeCtx({
      deps: {
        log: (m: string) => logged.push(m),
        logError: (m: string) => logged.push(m),
      },
    });
    const result = await runCheckWriterStage(sandbox, ctx as never, "pre-sha-0");
    expect(result.proceed).toBe(true);
    expect(
      logged.filter((m) => m.includes("must-fail-first proof came back")),
    ).toEqual([]);
  });

  // NOT TESTED HERE, deliberately: the third path that assigns
  // `mustFailFirst` — `checkCommand === undefined`, the proof that cannot even
  // be attempted — is unreachable from a CHECKS_WRITTEN envelope. The schema's
  // own `superRefine` (`lib/checkwriter/schema.ts`) rejects both a missing and
  // an unsafe `checkPath` before `runCheckWriter` ever builds a command, so
  // that branch is defence-in-depth against a schema regression. It now
  // records and logs a reason like every other path; there is no fixture that
  // can drive it without disabling the guard that makes it unreachable.
});
describe("probeAlreadyBuiltLocation", () => {
  const ok = (stdout: string): GitRunResult => ({ ok: true, stdout, stderr: "" });
  const fail = (stderr: string): GitRunResult => ({
    ok: false,
    stdout: "",
    stderr,
  });

  /** A fake git whose `ls-tree` returns a canned listing per ref, and whose
   *  `rev-parse --verify` says a ref exists iff it has a listing (or is forced
   *  present/absent). Any ref with `undefined` listing is treated as
   *  non-existent unless `existsAnyway` names it. */
  function fakeGit(
    trees: Record<string, string | { error: string }>,
    existsAnyway: string[] = [],
  ): (repoRoot: string, ...a: string[]) => GitRunResult {
    return (_repoRoot: string, ...a: string[]): GitRunResult => {
      const [cmd] = a;
      if (cmd === "ls-tree") {
        const ref = a[a.length - 1]!;
        const t = trees[ref];
        if (t === undefined) return fail(`fatal: not a tree object: ${ref}`);
        if (typeof t === "object") return fail(t.error);
        return ok(t);
      }
      if (cmd === "rev-parse") {
        const spec = a[a.length - 1]!; // `${ref}^{commit}`
        const ref = spec.replace(/\^\{commit\}$/, "");
        const t = trees[ref];
        const exists =
          existsAnyway.includes(ref) ||
          typeof t === "string" ||
          (typeof t === "object" && t !== null);
        return exists ? ok(ref) : fail(`fatal: Needed a single revision`);
      }
      throw new Error(`unexpected git call: ${a.join(" ")}`);
    };
  }

  it("anchors on the issue number: issue-1 is NOT matched by issue-11", () => {
    const git = fakeGit({
      "origin/main": "apps/nextjs/e2e/checks/issue-11/a.spec.ts\nsrc/x.ts",
      "integration-candidate": "src/y.ts",
    });
    expect(probeAlreadyBuiltLocation("/repo", 1, git)).toEqual({
      onMain: false,
      onStaging: false,
    });
    expect(probeAlreadyBuiltLocation("/repo", 11, git)).toEqual({
      onMain: true,
      onStaging: false,
    });
  });

  it("matches the unit runner's __checks__ directory on the staging branch", () => {
    const git = fakeGit({
      "origin/main": "src/x.ts",
      "integration-candidate":
        "packages/api/src/__checks__/issue-42/whose-deal.test.ts",
    });
    expect(probeAlreadyBuiltLocation("/repo", 42, git)).toEqual({
      onMain: false,
      onStaging: true,
    });
  });

  it("a git FAULT on a ref that exists is 'uncertain', never a false 'absent'", () => {
    const git = fakeGit({
      "origin/main": { error: "fatal: unable to read tree" },
      "integration-candidate": "src/y.ts",
    });
    // origin/main resolves (rev-parse ok) but ls-tree failed → uncertain wins.
    expect(probeAlreadyBuiltLocation("/repo", 7, git)).toBe("uncertain");
  });

  it("a MISSING integration-candidate is a definite 'not on staging', not 'uncertain'", () => {
    // Staging branch absent (e.g. --no-staging host); main resolvable and clean.
    const git = fakeGit({ "origin/main": "src/only.ts" });
    expect(probeAlreadyBuiltLocation("/repo", 9, git)).toEqual({
      onMain: false,
      onStaging: false,
    });
  });

  it("a MISSING origin/main is 'uncertain' — that ref must always exist", () => {
    const git = fakeGit({ "integration-candidate": "src/y.ts" });
    expect(probeAlreadyBuiltLocation("/repo", 9, git)).toBe("uncertain");
  });

  it("rejects a nonsense issue number as 'uncertain' before touching git", () => {
    const git = vi.fn();
    expect(probeAlreadyBuiltLocation("/repo", 0, git as never)).toBe("uncertain");
    expect(probeAlreadyBuiltLocation("/repo", -3, git as never)).toBe(
      "uncertain",
    );
    expect(git).not.toHaveBeenCalled();
  });
});

